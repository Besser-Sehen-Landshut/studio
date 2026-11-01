import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { capacityHoldsTwice } from './capacity.js';
import type { StudioConfig } from './config.js';
import {
  acquireStateLock,
  assertStatePath,
  ensureStateDir,
  type StateLock,
  writeStateFile,
} from './paths.js';
import type { Clock, Gh, Host } from './ports.js';

export type QueueStep = 'update' | 'checks' | 'capacity' | 'merge';
export type QueueEntry = { pr: number; repo: string; item?: string };
export type QueueCurrent = QueueEntry & { head?: string; step: QueueStep };
export type QueueDone = QueueEntry & {
  result: 'merged' | 'failed';
  reason?: string;
  at: string;
};
export type QueueState = { current?: QueueCurrent; pending: QueueEntry[]; done: QueueDone[] };
export type MergeOutcome = { result: 'merged' | 'failed'; reason?: string; mergeSha?: string };
export type QueuePorts = { gh: Gh; clock: Clock; host: Host };
export type QueueOptions = {
  /** Owner-level state root; when set, a `merged` event is appended to its metrics.jsonl. */
  stateRoot?: string;
  pollMs?: number;
  capacityWaitMs?: number;
  /** How long zero checks count as pending after a head change (default 5 min). */
  checksGraceMs?: number;
  timeoutMs?: number;
  /** Receives non-fatal problems (default: stderr). */
  log?: (message: string) => void;
  /**
   * Supplies the next entry (default: `state.pending.shift()`). The CLI reads it from queue.json
   * on disk, so entries added by `queue add` during a run are not lost.
   */
  takeNext?: () => QueueEntry | undefined;
  /** Called right after each entry finished and was persisted (board update); errors are logged. */
  onDone?: (done: QueueDone) => void;
  /**
   * Returns a line while the queue must not merge (an account block). Checked at the top of every
   * loop and right before `gh pr merge`; a stop keeps `current` and `pending` as they are.
   */
  hold?: () => string | undefined;
  /** Why this entry must not merge, read right before `gh pr merge`; a reason fails the entry. */
  mergeAllowed?: (entry: QueueEntry) => string | undefined;
};

/** Internal stop: the hold fired between capacity and merge. `current` stays persisted. */
export class QueueHeld extends Error {
  constructor(readonly line: string) {
    super(line);
    this.name = 'QueueHeld';
  }
}

export const CHECKS_POLL_MS = 30_000;
export const CAPACITY_WAIT_MS = 60_000;
export const QUEUE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
/** CI needs a moment to register its checks for a new head; until then zero checks are pending. */
export const CHECKS_GRACE_MS = 5 * 60 * 1000;

const entrySchema = z.strictObject({
  pr: z.number().int().positive(),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  item: z.string().min(1).optional(),
});
const stateSchema = z.strictObject({
  current: entrySchema
    .extend({
      head: z.string().optional(),
      step: z.enum(['update', 'checks', 'capacity', 'merge']),
    })
    .optional(),
  pending: z.array(entrySchema),
  done: z.array(
    entrySchema.extend({
      result: z.enum(['merged', 'failed']),
      reason: z.string().optional(),
      at: z.string(),
    }),
  ),
});

const queueFile = (stateRoot: string) => join(stateRoot, 'queue.json');

/** Reads queue.json from the state root; a missing file is an empty queue, a corrupt one throws. */
export function loadQueue(stateRoot: string): QueueState {
  const file = queueFile(stateRoot);
  assertStatePath(stateRoot, file);
  if (!existsSync(file)) return { pending: [], done: [] };
  if (lstatSync(file).isSymbolicLink())
    throw new Error(`refusing to read ${file}: it is a symlink`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`queue file ${file} is not valid JSON`);
  }
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`queue file ${file} is invalid: ${parsed.error.message}`);
  return parsed.data as QueueState;
}

export function saveQueue(stateRoot: string, q: QueueState): void {
  writeStateFile(stateRoot, queueFile(stateRoot), `${JSON.stringify(q, null, 2)}\n`);
}

const FILE_LOCK = 'queue.json.lock';
const RUN_LOCK = 'queue.run.lock';
/** A file lock without heartbeat: the critical section is a read and an atomic rename. */
const FILE_LOCK_STALE_MS = 30_000;
/**
 * A `queue run` lock is stale only when its holder is gone (pid not running) or silent: the run
 * refreshes the heartbeat on every persist and every poll, so 15 minutes without one means stuck.
 */
export const RUN_LOCK_HEARTBEAT_STALE_MS = 15 * 60 * 1000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read-modify-write of queue.json under a short exclusive file lock, so `queue add` and a running
 * `queue run` never overwrite each other's changes. Retries for `timeoutMs` (default 5 s).
 */
export function updateQueue<T>(
  stateRoot: string,
  mutate: (q: QueueState) => T,
  opts: { timeoutMs?: number } = {},
): T {
  const until = Date.now() + (opts.timeoutMs ?? 5000);
  let lock: StateLock | undefined;
  for (;;) {
    lock = acquireStateLock(stateRoot, FILE_LOCK, {
      now: new Date(),
      heartbeatStaleMs: FILE_LOCK_STALE_MS,
    });
    if (lock) break;
    if (Date.now() >= until) throw new Error(`queue file is locked (${FILE_LOCK}); try again`);
    sleepSync(25);
  }
  try {
    const q = loadQueue(stateRoot);
    const result = mutate(q);
    saveQueue(stateRoot, q);
    return result;
  } finally {
    lock.release();
  }
}

/** Adds an entry to the pending list on disk; returns the new pending length. */
export function enqueue(stateRoot: string, entry: QueueEntry): number {
  return updateQueue(stateRoot, (q) => {
    const dup = [...q.pending, ...(q.current ? [q.current] : [])].some(
      (e) => e.pr === entry.pr && e.repo === entry.repo,
    );
    if (dup) throw new Error(`${entry.repo}#${entry.pr} is already in the queue`);
    q.pending.push(entry);
    return q.pending.length;
  });
}

/** Moves the first pending entry on disk to `current`; undefined when nothing is pending. */
export function takeNextPending(stateRoot: string): QueueEntry | undefined {
  return updateQueue(stateRoot, (q) => {
    const next = q.pending.shift();
    if (next) q.current = { ...next, step: 'update' };
    return next;
  });
}

/**
 * Exclusive lock for `queue run`: a second run fails with "queue already running" while the
 * holder lives. A lock whose holder died or stopped heartbeating is taken over, with a note.
 */
export function acquireQueueRunLock(
  stateRoot: string,
  now: Date,
  log: (message: string) => void,
): StateLock {
  const lock = acquireStateLock(stateRoot, RUN_LOCK, {
    now,
    heartbeatStaleMs: RUN_LOCK_HEARTBEAT_STALE_MS,
  });
  if (!lock) throw new Error(`queue already running (lock ${RUN_LOCK} in the state root)`);
  if (lock.broke !== undefined) {
    log(`note: broke a stale queue lock (${lock.broke}); a previous run did not finish`);
  }
  return lock;
}

const RELEASE_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
type ReleaseSignal = (typeof RELEASE_SIGNALS)[number];

/** Signal handler body: release the lock, then exit with the conventional code 128 + signo. */
export function releaseOnSignal(
  lock: Pick<StateLock, 'release' | 'heartbeat'>,
  signal: ReleaseSignal,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  try {
    lock.release();
  } finally {
    exit(128 + osConstants.signals[signal]);
  }
}

/** Releases the lock on SIGTERM, SIGINT and SIGHUP; returns a function that removes the handlers. */
export function installSignalRelease(lock: Pick<StateLock, 'release' | 'heartbeat'>): () => void {
  const handlers = RELEASE_SIGNALS.map((signal) => {
    const handler = () => releaseOnSignal(lock, signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

/** Appends one line to a state-root file; a real append, so parallel writers lose nothing. */
export function appendStateLine(stateRoot: string, name: string, line: string): void {
  const file = join(stateRoot, name);
  assertStatePath(stateRoot, file);
  let torn = false;
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`refusing to use ${file}: it is a symlink`);
    }
    const prev = readFileSync(file, 'utf8');
    torn = prev !== '' && !prev.endsWith('\n');
  } else {
    ensureStateDir(stateRoot, dirname(file));
  }
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, `${torn ? '\n' : ''}${line}\n`);
  } finally {
    closeSync(fd);
  }
}

type Check = { name: string; bucket: string };
const BUCKETS = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);
const SHA = /^[0-9a-f]{40,64}$/;

/** Parses `gh pr checks --json name,bucket` stdout (it prints JSON even on exit 1 or 8). */
function parseChecks(stdout: string): Check[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const out: Check[] = [];
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) return undefined;
    const { name, bucket } = c as Record<string, unknown>;
    if (typeof name !== 'string' || typeof bucket !== 'string') return undefined;
    out.push({ name, bucket });
  }
  return out;
}

type ChecksVerdict =
  | { kind: 'pending' }
  | { kind: 'pass' }
  | { kind: 'failed'; reason: string }
  /** No check reported at all: pending during the grace after a head change, else failed. */
  | { kind: 'none'; reason: string };

async function readChecks(entry: QueueEntry, gh: Gh): Promise<ChecksVerdict> {
  const base = ['pr', 'checks', String(entry.pr), '--repo', entry.repo, '--json', 'name,bucket'];
  const all = await gh.run(base);
  const checks = parseChecks(all.stdout);
  if (checks === undefined) {
    if (all.stdout.trim() === '' && /no checks reported/i.test(all.stderr)) {
      return { kind: 'none', reason: 'no checks reported' };
    }
    return {
      kind: 'failed',
      reason: `no checks reported (gh exit ${all.code}: ${all.stderr.trim()})`,
    };
  }
  const req = await gh.run([...base, '--required']);
  let required = parseChecks(req.stdout);
  if (required === undefined) {
    // gh reports "no required checks" on stderr with empty stdout; anything else is unknown.
    if (req.stdout.trim() === '' && /no required checks/i.test(req.stderr)) required = [];
    else return { kind: 'failed', reason: `required checks unreadable (gh exit ${req.code})` };
  }
  const requiredNames = new Set(required.map((c) => c.name));
  // A required check missing from the full list still counts, with its own bucket.
  const known = new Set(checks.map((c) => c.name));
  const evaluated = [...checks, ...required.filter((c) => !known.has(c.name))];
  if (evaluated.length === 0) return { kind: 'none', reason: 'no checks reported' };
  for (const c of evaluated) {
    if (!BUCKETS.has(c.bucket)) {
      return { kind: 'failed', reason: `check ${c.name} has unknown state ${c.bucket}` };
    }
  }
  // Conclusive failures win over pending: no point in waiting for a run that cannot pass.
  for (const c of evaluated) {
    if (c.bucket === 'fail' || c.bucket === 'cancel') {
      const what = c.bucket === 'fail' ? 'failed' : 'was cancelled';
      return { kind: 'failed', reason: `check ${c.name} ${what}` };
    }
    if (c.bucket === 'skipping' && requiredNames.has(c.name)) {
      return { kind: 'failed', reason: `required check ${c.name} was skipped` };
    }
  }
  if (evaluated.some((c) => c.bucket === 'pending')) return { kind: 'pending' };
  // Skipped CI is never green: at least one check must have actually passed.
  if (!evaluated.some((c) => c.bucket === 'pass'))
    return { kind: 'failed', reason: 'no check passed' };
  return { kind: 'pass' };
}

type PrView = { head: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeable: string };

/** The PR's head, state and mergeability; a string is the failure reason. */
async function viewPr(entry: QueueEntry, gh: Gh): Promise<PrView | string> {
  const r = await gh.run([
    'pr',
    'view',
    String(entry.pr),
    '--repo',
    entry.repo,
    '--json',
    'headRefOid,state,mergeable',
  ]);
  if (r.code !== 0) return `gh pr view failed (exit ${r.code}): ${r.stderr.trim()}`;
  let raw: Record<string, unknown> | null;
  try {
    raw = JSON.parse(r.stdout) as Record<string, unknown> | null;
  } catch {
    return 'gh pr view returned unparsable output';
  }
  const { headRefOid, state, mergeable } = raw ?? {};
  if (typeof headRefOid !== 'string' || !SHA.test(headRefOid)) {
    return 'gh pr view returned no valid head SHA';
  }
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') {
    return `gh pr view returned unknown state ${String(state)}`;
  }
  return {
    head: headRefOid,
    state,
    mergeable: typeof mergeable === 'string' ? mergeable : 'UNKNOWN',
  };
}

async function mergeShaOf(entry: QueueEntry, gh: Gh): Promise<string | undefined> {
  const r = await gh.run([
    'pr',
    'view',
    String(entry.pr),
    '--repo',
    entry.repo,
    '--json',
    'mergeCommit',
  ]);
  if (r.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(r.stdout) as { mergeCommit?: { oid?: unknown } | null } | null;
    const oid = parsed?.mergeCommit?.oid;
    return typeof oid === 'string' && SHA.test(oid) ? oid : undefined;
  } catch {
    return undefined;
  }
}

const HEAD_MOVED = /head branch was modified|match-head-commit|head commit|expected head/i;
const NO_UPDATE_NEEDED = /no new commits|already up[ -]to[ -]date/i;

/**
 * Merges one PR following spec 7.1 (studio-queue fallback): update branch, wait for checks, read
 * the head, wait for CI capacity, merge with --match-head-commit. The step is persisted before it
 * runs, so a restart resumes there; the head is always re-read before the merge.
 *
 * CI counts only for the head that is merged: the head is read before the checks poll and again
 * after it, and a differing pair sends the PR back to the checks step. The merge then pins that
 * head with `--match-head-commit`, so GitHub itself refuses any other head. Head changes count as
 * attempts; the fourth is refused ("head moved 3 times").
 */
export async function mergeOne(
  entry: QueueCurrent,
  config: StudioConfig,
  ports: QueuePorts,
  persist: (current: QueueCurrent) => void,
  opts: QueueOptions = {},
): Promise<MergeOutcome> {
  const { gh, clock } = ports;
  const pollMs = opts.pollMs ?? CHECKS_POLL_MS;
  const capacityWaitMs = opts.capacityWaitMs ?? CAPACITY_WAIT_MS;
  const deadline = clock.now().getTime() + (opts.timeoutMs ?? QUEUE_TIMEOUT_MS);
  const failed = (reason: string): MergeOutcome => ({ result: 'failed', reason });
  const timedOut = () => clock.now().getTime() >= deadline;
  const graceMs = opts.checksGraceMs ?? CHECKS_GRACE_MS;
  // Zero checks right after a head change (update-branch, a moved head) are pending until then.
  let graceUntil = Number.NEGATIVE_INFINITY;
  const headChanged = () => {
    graceUntil = clock.now().getTime() + graceMs;
  };
  const enter = (step: QueueStep) => {
    entry.step = step;
    persist(entry);
  };

  if (!config.repos.includes(entry.repo)) {
    return failed(`repository ${entry.repo} is not configured`);
  }
  if (!Number.isInteger(entry.pr) || entry.pr <= 0) return failed('invalid pull request number');

  const merged = async (): Promise<MergeOutcome> => {
    const mergeSha = await mergeShaOf(entry, gh);
    return mergeSha === undefined ? { result: 'merged' } : { result: 'merged', mergeSha };
  };
  const moved = `head moved ${MAX_ATTEMPTS} times`;

  let attempts = 1;
  let rechecks = 0;
  let step: QueueStep = entry.step;
  for (;;) {
    if (step === 'update') {
      enter('update');
      const r = await gh.run(['pr', 'update-branch', String(entry.pr), '--repo', entry.repo]);
      if (r.code === 0) headChanged();
      if (r.code !== 0 && !NO_UPDATE_NEEDED.test(r.stderr)) {
        // A PR merged before a restart cannot be updated any more: only an open PR is an error.
        const v = await viewPr(entry, gh);
        if (typeof v === 'string' || v.state === 'OPEN') {
          return failed(`update-branch failed (exit ${r.code}): ${r.stderr.trim()}`);
        }
      }
      step = 'checks';
    } else if (step === 'checks') {
      enter('checks');
      const before = await viewPr(entry, gh);
      if (typeof before === 'string') return failed(before);
      if (before.state === 'MERGED') return merged();
      if (before.state === 'CLOSED') return failed('pull request is closed');
      for (;;) {
        const verdict = await readChecks(entry, gh);
        if (verdict.kind === 'failed') return failed(verdict.reason);
        if (verdict.kind === 'none' && clock.now().getTime() >= graceUntil) {
          return failed(verdict.reason);
        }
        if (verdict.kind === 'pass') break;
        if (timedOut()) return failed('checks timed out');
        await clock.sleep(pollMs);
        if (timedOut()) return failed('checks timed out');
      }
      const after = await viewPr(entry, gh);
      if (typeof after === 'string') return failed(after);
      if (after.state === 'MERGED') return merged();
      if (after.state === 'CLOSED') return failed('pull request is closed');
      if (after.head !== before.head) {
        if (++attempts > MAX_ATTEMPTS) return failed(moved);
        headChanged();
        continue; // the checks may belong to the old head: evaluate again
      }
      if (after.mergeable === 'CONFLICTING') return failed('pull request has merge conflicts');
      entry.head = after.head;
      step = 'capacity';
    } else if (step === 'capacity') {
      enter('capacity');
      for (;;) {
        let holds = false;
        try {
          holds = await capacityHoldsTwice(config, ports);
        } catch {
          holds = false; // unknown capacity counts as busy
        }
        if (holds) break;
        if (timedOut()) return failed('capacity did not hold in time');
        await clock.sleep(capacityWaitMs);
      }
      step = 'merge';
    } else {
      enter('merge');
      const head = entry.head;
      const now = await viewPr(entry, gh);
      if (typeof now === 'string') return failed(now);
      if (now.state === 'MERGED') return merged();
      if (now.state === 'CLOSED') return failed('pull request is closed');
      if (head === undefined || now.head !== head) {
        if (++attempts > MAX_ATTEMPTS) return failed(moved);
        headChanged();
        step = 'checks';
        continue;
      }
      // CI may have changed while we waited for capacity: verify once more right before merging.
      const again = await readChecks(entry, gh);
      if (again.kind !== 'pass') {
        if (++rechecks > MAX_ATTEMPTS) return failed(`checks changed ${MAX_ATTEMPTS} times`);
        step = 'checks';
        continue;
      }
      const held = opts.hold?.();
      if (held !== undefined) {
        // Resume at capacity: the head or the capacity may differ by then.
        enter('capacity');
        throw new QueueHeld(held);
      }
      const refused = opts.mergeAllowed?.(entry);
      if (refused !== undefined) return failed(refused);
      const r = await gh.run([
        'pr',
        'merge',
        String(entry.pr),
        '--repo',
        entry.repo,
        `--${config.merge.method}`,
        '--match-head-commit',
        head,
      ]);
      if (r.code === 0) return merged();
      if (HEAD_MOVED.test(r.stderr)) {
        if (++attempts > MAX_ATTEMPTS) return failed(moved);
        headChanged();
        step = 'checks';
        continue;
      }
      return failed(`merge failed (exit ${r.code}): ${r.stderr.trim()}`);
    }
  }
}

async function firstCommitAt(entry: QueueEntry, gh: Gh): Promise<string | undefined> {
  const r = await gh.run([
    'pr',
    'view',
    String(entry.pr),
    '--repo',
    entry.repo,
    '--json',
    'commits',
    '--jq',
    '.commits[0].committedDate',
  ]);
  const v = r.stdout.trim();
  return r.code === 0 && v !== '' && !Number.isNaN(Date.parse(v)) ? v : undefined;
}

/**
 * Processes the queue serially: resumes `state.current` first (never re-added), then the pending
 * entries in FIFO order (from `opts.takeNext` when given). Persists after every transition, calls
 * `opts.onDone` after each entry and returns the final state.
 */
export async function runQueue(
  state: QueueState,
  config: StudioConfig,
  ports: QueuePorts,
  persist: (q: QueueState) => void,
  opts: QueueOptions = {},
): Promise<QueueState> {
  const log = opts.log ?? ((m: string) => console.error(m));
  for (;;) {
    const held = opts.hold?.();
    if (held !== undefined) {
      log(`queue held: ${held}`);
      return state;
    }
    if (!state.current) {
      const next = opts.takeNext ? opts.takeNext() : state.pending.shift();
      if (!next) return state;
      state.current = { ...next, step: 'update' };
      persist(state);
    }
    const current = state.current;
    let outcome: MergeOutcome;
    try {
      outcome = await mergeOne(current, config, ports, () => persist(state), opts);
    } catch (err) {
      if (!(err instanceof QueueHeld)) throw err;
      log(`queue held: ${err.line}`);
      return state;
    }
    const { step: _step, head: _head, ...entry } = current;
    const done: QueueDone = {
      ...entry,
      result: outcome.result,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      at: ports.clock.now().toISOString(),
    };
    state.done.push(done);
    state.current = undefined;
    persist(state);
    if (opts.onDone) {
      try {
        opts.onDone(done);
      } catch (err) {
        // The result is in queue.json; the next run reconciles the board from it.
        log(`board update failed for PR ${current.pr}: ${(err as Error).message}`);
      }
    }
    if (outcome.result === 'merged' && opts.stateRoot !== undefined) {
      try {
        const first = await firstCommitAt(current, ports.gh);
        appendStateLine(
          opts.stateRoot,
          'metrics.jsonl',
          JSON.stringify({
            type: 'merged',
            ...(current.item === undefined ? {} : { item: current.item }),
            pr: current.pr,
            repo: current.repo,
            at: ports.clock.now().toISOString(),
            firstCommitAt: first ?? null,
          }),
        );
      } catch (err) {
        // The PR is merged and recorded in the queue; metrics must not stop the queue.
        log(`metrics append failed for PR ${current.pr}: ${(err as Error).message}`);
      }
    }
  }
}
