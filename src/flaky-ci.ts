// Failed checks that lie outside a pull request's area: their failed jobs run once more on the same
// commit, the flaky ledger learns the outcome, and a job that fails like that a second time within
// 14 days becomes a board item to find the cause. Anything Studio cannot place counts as related:
// the pull request fails as before.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { boardPrefix } from './add-item.js';
import { type Board, type WorkItem, workItemSchema } from './board.js';
import { jobArea, type Workflows } from './ci-jobs.js';
import { recordFlaky } from './flaky.js';
import { touchesOverlap } from './glob.js';
import { acquireStateLock, assertStatePath, writeStateFile } from './paths.js';
import type { Gh } from './ports.js';

export const RERUNS_FILE = 'ci-reruns.json';
export const RERUNS_LOCK = 'ci-reruns.lock';
export const RERUNS_LOCK_STALE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** A second failure of the same job within this time asks for its cause. */
export const FLAKY_WINDOW_MS = 14 * DAY_MS;
const KEEP_MS = 30 * DAY_MS;
const MAX_ENTRIES = 500;
/** How long failed checks of the old attempt may still show after a rerun was started. */
export const RERUN_SETTLE_MS = 10 * 60_000;
const GH_MS = 60_000;
const MAX_FILES = 3000;
const MAX_TEST = 150;
export const FLAKY_NOTE = 'flaky: ';

const entrySchema = z.strictObject({
  repo: z.string(),
  pr: z.number().int().positive(),
  sha: z.string(),
  item: z.string().optional(),
  tests: z.array(z.string()).min(1),
  runs: z.array(z.number().int().positive()),
  jobs: z.array(z.number().int().positive()),
  at: z.string(),
  outcome: z.enum(['pass', 'fail']).optional(),
});
export type RerunEntry = z.infer<typeof entrySchema>;

export type RerunEvent = {
  item?: string;
  repo: string;
  pr: number;
  sha: string;
  jobs: string[];
  runs: number[];
};
/** What the policy did in one process: `tick` prints it. */
export type CiEvents = {
  reruns: RerunEvent[];
  flakyItems: { item: string; test: string }[];
};

export type PrRef = { repo: string; pr: number; item?: string };

function readLedger(stateRoot: string): RerunEntry[] {
  const file = join(stateRoot, RERUNS_FILE);
  assertStatePath(stateRoot, file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`${RERUNS_FILE} cannot be read`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${RERUNS_FILE} is not valid JSON`);
  }
  const parsed = z.array(entrySchema).safeParse(raw);
  if (!parsed.success) throw new Error(`${RERUNS_FILE} has the wrong shape`);
  return parsed.data;
}

function writeLedger(stateRoot: string, entries: RerunEntry[], now: Date): void {
  const kept = entries
    .filter((e) => now.getTime() - Date.parse(e.at) < KEEP_MS)
    .slice(-MAX_ENTRIES);
  writeStateFile(stateRoot, join(stateRoot, RERUNS_FILE), `${JSON.stringify(kept, null, 2)}\n`);
}

/** Runs `fn` on the ledger under its lock; undefined when another process holds it. */
function withLedger<T>(
  stateRoot: string,
  now: Date,
  fn: (entries: RerunEntry[]) => { entries?: RerunEntry[]; result: T },
): T | undefined {
  const lock = acquireStateLock(stateRoot, RERUNS_LOCK, {
    now,
    heartbeatStaleMs: RERUNS_LOCK_STALE_MS,
  });
  if (!lock) return undefined;
  try {
    const r = fn(readLedger(stateRoot));
    if (r.entries !== undefined) writeLedger(stateRoot, r.entries, now);
    return r.result;
  } finally {
    lock.release();
  }
}

/** A failed check with the run and job its link names. */
export type FailedCheck = { name: string; workflow?: string; run: number; job: number };

/**
 * The failed checks of the pull request with their run and job ids, from
 * `gh pr checks --json name,bucket,workflow,link`, and whether any check still runs. Undefined
 * when a failed one is not clearly a failed Actions job of this repository (a commit status, a link
 * of another form), a check was cancelled, or none failed.
 */
export async function failedChecks(
  gh: Gh,
  ref: PrRef,
): Promise<{ failed: FailedCheck[]; pending: boolean } | undefined> {
  const r = await gh.run(
    ['pr', 'checks', String(ref.pr), '--repo', ref.repo, '--json', 'name,bucket,workflow,link'],
    { timeoutMs: GH_MS },
  );
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const link = new RegExp(
    `^https://github\\.com/${ref.repo.replace(/[.]/g, '\\.')}/actions/runs/(\\d+)/job/(\\d+)$`,
  );
  const out: FailedCheck[] = [];
  let pending = false;
  for (const c of raw) {
    if (c === null || typeof c !== 'object') return undefined;
    const { name, bucket, workflow, link: url } = c as Record<string, unknown>;
    if (bucket === 'cancel') return undefined;
    if (bucket === 'pending') pending = true;
    if (bucket !== 'fail') continue;
    if (typeof name !== 'string' || typeof url !== 'string') return undefined;
    const m = link.exec(url);
    if (!m) return undefined;
    out.push({
      name,
      ...(typeof workflow === 'string' && workflow !== '' ? { workflow } : {}),
      run: Number(m[1]),
      job: Number(m[2]),
    });
  }
  return out.length === 0 ? undefined : { failed: out, pending };
}

/** A rerun refused for now (the run still runs, or GitHub says not yet): no allowance spent. */
const NOT_YET = /already running|in progress|still running|\b(403|422)\b/i;

/** The pull request's changed files; undefined when unknown or too many to be sure. */
async function changedFiles(gh: Gh, ref: PrRef): Promise<string[] | undefined> {
  try {
    const out = await gh.api(
      `repos/${ref.repo}/pulls/${ref.pr}/files?per_page=100`,
      '.[].filename',
      {
        timeoutMs: GH_MS,
      },
    );
    const files = out.split('\n').filter((f) => f !== '');
    return files.length === 0 || files.length >= MAX_FILES ? undefined : files;
  } catch {
    return undefined;
  }
}

/**
 * Whether a failed job lies outside the pull request: its job runs in a directory of its own
 * (`area`), no changed file lies there, at the repository root or in `.github/`, and none of the
 * item's paths reaches into it. Unknown area or files: related. A wrong "unrelated" costs one
 * rerun, which then fails again and counts as a real failure.
 */
export function unrelatedFailure(o: {
  area: string | undefined;
  changed: readonly string[] | undefined;
  itemPaths: readonly string[];
}): boolean {
  const { area, changed } = o;
  if (area === undefined || changed === undefined || changed.length === 0) return false;
  const lower = area.toLowerCase();
  for (const f of changed) {
    const p = f.toLowerCase();
    if (!p.includes('/') || p.startsWith('.github/') || p === lower || p.startsWith(`${lower}/`)) {
      return false;
    }
  }
  return !o.itemPaths.some((g) => touchesOverlap(g, area));
}

/** The ledger's name for a job: `<workflow> / <check>`, one plain line. */
export const testName = (c: { name: string; workflow?: string }): string =>
  [...`${c.workflow ?? '?'} / ${c.name}`.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ')]
    .slice(0, MAX_TEST)
    .join('')
    .trim();

/**
 * The item that asks for the cause of a flaky job, unless one for it is open (by its note). The
 * id is the next free one of the board's prefix.
 */
export function withFlakyItem(
  board: Board,
  test: string,
  repo: string,
  runs: readonly number[],
): { board: Board; id?: string } {
  const note = `${FLAKY_NOTE}${test}`;
  const open = (i: WorkItem) => i.status !== 'merged' && i.status !== 'dropped';
  if (board.items.some((i) => open(i) && i.repo === repo && (i.notes ?? []).includes(note))) {
    return { board };
  }
  const prefix = boardPrefix(board, repo);
  const numbers = board.items
    .filter((i) => i.id.startsWith(`${prefix}-`))
    .map((i) => Number(i.id.slice(prefix.length + 1)));
  const id = `${prefix}-${Math.max(0, ...numbers) + 1}`;
  const parsed = workItemSchema.safeParse({
    id,
    title: `Find the cause of flaky ${test}`,
    type: 'fix',
    role: 'builder',
    repo,
    size: 'S',
    priority: Math.max(0, ...board.items.map((i) => i.priority)) + 1,
    status: 'ready',
    paths: [],
    touches: [],
    dependsOn: [],
    dod: [
      `The cause of the flaky failures of ${test} is found and written down`,
      'The test is deterministic under load (busy runners), shown by repeated runs',
      'No timeout is raised without a measured cause',
    ],
    notes: [note, `flaky runs: ${[...new Set(runs)].join(', ')}`],
    history: [],
  });
  if (!parsed.success) throw new Error(`the flaky item for ${test} would be invalid`);
  return { board: { ...board, items: [...board.items, parsed.data] }, id };
}

export type FailedAction = 'rerun' | 'wait' | 'fail';

export interface CiPolicy {
  /** A check on `head` failed: rerun its failed jobs once, wait for that, or fail as before. */
  failed(ref: PrRef, head: string): Promise<FailedAction>;
  /** Every check on `head` passed: a pending rerun counts the jobs as flaky. */
  passed(ref: PrRef, head: string): void;
}

export function ciFailurePolicy(o: {
  stateRoot: string;
  gh: Gh;
  /** Every workflow at the commit, parsed; undefined when they cannot be read. */
  workflowsAt(repo: string, sha: string): Promise<Workflows | undefined>;
  /** Whether CI is under the merge capacity right now. */
  capacityFree(): Promise<boolean>;
  now(): Date;
  /** The paths of the item that holds the pull request. */
  itemPaths(ref: PrRef): readonly string[];
  /** Adds the flaky item under the board lock; its id, or undefined when one is open. */
  addFlakyItem(test: string, repo: string, runs: readonly number[]): Promise<string | undefined>;
  events: CiEvents;
  log(message: string): void;
}): CiPolicy {
  /** Whether the failure of a head is unrelated, read once per head and process. */
  const placed = new Map<string, FailedCheck[] | undefined>();
  const say = (e: unknown) => (e as Error).message.replace(/\p{Cc}/gu, ' ');

  /** `checks`: the failed ones, read while nothing of the head runs any more. */
  const unrelated = async (
    ref: PrRef,
    head: string,
    checks: FailedCheck[],
  ): Promise<FailedCheck[] | undefined> => {
    const key = `${ref.repo}@${head}`;
    if (placed.has(key)) return placed.get(key);
    const files = await o.workflowsAt(ref.repo, head);
    const changed = await changedFiles(o.gh, ref);
    const paths = o.itemPaths(ref);
    const all =
      files !== undefined &&
      checks.every((c) => unrelatedFailure({ area: jobArea(files, c), changed, itemPaths: paths }));
    const result = all ? checks : undefined;
    placed.set(key, result);
    return result;
  };

  const settle = (ref: PrRef, head: string, outcome: 'pass' | 'fail') => {
    const now = o.now();
    const settled = withLedger(o.stateRoot, now, (entries) => {
      const mine = entries.find((e) => e.repo === ref.repo && e.sha === head);
      if (mine === undefined || mine.outcome !== undefined) return { result: undefined };
      mine.outcome = outcome;
      return { entries, result: mine };
    });
    // A rerun that passed proves the job flaky; one that failed again is a real failure.
    if (settled !== undefined && outcome === 'pass') {
      for (const t of settled.tests) {
        recordFlaky(o.stateRoot, `${ref.repo}: ${t}`, head, 'pass', now);
      }
    }
  };

  return {
    async failed(ref, head) {
      try {
        const known = readLedger(o.stateRoot).find((e) => e.repo === ref.repo && e.sha === head);
        if (known?.outcome !== undefined) return 'fail';
        const current = await failedChecks(o.gh, ref);
        // A sibling job still runs: nothing is judged, recorded or rerun until the runs completed.
        if (current?.pending === true) return 'wait';
        if (known !== undefined) {
          // Right after the rerun the old attempt's failed jobs may still show: wait for them.
          const stale = current?.failed.every((c) => known.jobs.includes(c.job)) === true;
          if (stale && o.now().getTime() - Date.parse(known.at) < RERUN_SETTLE_MS) return 'wait';
          settle(ref, head, 'fail');
          return 'fail';
        }
        if (current === undefined) return 'fail';
        const checks = await unrelated(ref, head, current.failed);
        if (checks === undefined) return 'fail';
        if (!(await o.capacityFree())) return 'wait';
        const tests = [...new Set(checks.map(testName))];
        const runs = [...new Set(checks.map((c) => c.run))];
        const at = o.now();
        // Recorded before the rerun starts: whatever happens next, this commit never gets another.
        const entry: RerunEntry = {
          repo: ref.repo,
          pr: ref.pr,
          sha: head,
          ...(ref.item === undefined ? {} : { item: ref.item }),
          tests,
          runs,
          jobs: checks.map((c) => c.job),
          at: at.toISOString(),
        };
        const earlier = withLedger(o.stateRoot, at, (entries) => {
          if (entries.some((e) => e.repo === ref.repo && e.sha === head)) {
            return { result: undefined };
          }
          return { entries: [...entries, entry], result: entries };
        });
        if (earlier === undefined) return 'wait'; // another process got there first
        let started = 0;
        for (const run of runs) {
          const r = await o.gh.run(['run', 'rerun', String(run), '--failed', '--repo', ref.repo], {
            timeoutMs: GH_MS,
          });
          if (r.code === 0) {
            started++;
            continue;
          }
          if (started === 0 && NOT_YET.test(r.stderr)) {
            // Not now: give the allowance back, the next poll tries again.
            withLedger(o.stateRoot, o.now(), (entries) => ({
              entries: entries.filter((e) => !(e.repo === ref.repo && e.sha === head)),
              result: true,
            }));
            return 'wait';
          }
          if (started > 0) break; // what started counts; the rest fails on its own
          o.log(`error: rerun of run ${run} failed (gh exit ${r.code}); a real failure now`);
          settle(ref, head, 'fail');
          return 'fail';
        }
        o.events.reruns.push({
          ...(ref.item === undefined ? {} : { item: ref.item }),
          repo: ref.repo,
          pr: ref.pr,
          sha: head,
          jobs: tests,
          runs,
        });
        for (const test of tests) {
          // Only reruns that passed prove the job flaky; red again was a real failure.
          const before = earlier.filter(
            (e) =>
              e.repo === ref.repo &&
              e.outcome === 'pass' &&
              e.tests.includes(test) &&
              at.getTime() - Date.parse(e.at) <= FLAKY_WINDOW_MS,
          );
          if (before.length === 0) continue;
          try {
            const id = await o.addFlakyItem(test, ref.repo, [
              ...before.flatMap((e) => e.runs),
              ...runs,
            ]);
            if (id !== undefined) o.events.flakyItems.push({ item: id, test });
          } catch (e) {
            o.log(`error: flaky item for ${test}: ${say(e)}`);
          }
        }
        return 'rerun';
      } catch (e) {
        o.log(`error: flaky check: ${say(e)}`);
        return 'fail';
      }
    },
    passed(ref, head) {
      try {
        settle(ref, head, 'pass');
      } catch (e) {
        o.log(`error: flaky ledger: ${say(e)}`);
      }
    },
  };
}
