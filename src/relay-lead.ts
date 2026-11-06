// The lead's side of relay workers. An item whose `runs_on` label is under `workers.relay` in the
// owner config never meets GitHub on the worker: the lead sends the pinned `main` as a git bundle
// with the job over SSH, follows the job by polling its state each tick, and collects the report
// and a bundle of `studio/<id>`, which it checks as untrusted crew output, pushes with its own crew
// token (never forced) and opens or renews the pull request for, as for a local crew. No offers,
// claims or leases: the lead knows each job in `relay.json` in the state root.
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { WorkItem } from './board.js';
import type { OwnerConfig, RelayTarget } from './config.js';
import { githubHttpsUrl, ITEM_BASE } from './crew.js';
import {
  acquireStateLock,
  assertStatePath,
  ensureStateDir,
  removeStateEntry,
  writeStateFile,
} from './paths.js';
import type { Ports } from './ports.js';
import {
  type CollectAnswer,
  MAX_RESULT_BUNDLE_BYTES,
  MAX_START_BUNDLE_BYTES,
  type RelayState,
} from './relay-protocol.js';
import { type RelayTransport, RelayUnreachable, relayCall } from './relay-transport.js';
import { looksSecret, workerItemFields } from './worker-claim.js';

export const RELAY_FILE = 'relay.json';
const RELAY_LOCK = 'relay.lock';

/** What the lead knows of one job on a relay worker. */
export interface RelayRecord {
  label: string;
  /** The pinned `origin/main` the job got. */
  sha: string;
  from: string;
  fromSha?: string;
  /** The Claude credential label the lead handed over: a limit the crew hit parks this one. */
  credential: string;
  startedAt: string;
  /** The worker's last answer about the job, on the lead's clock. */
  state: RelayState;
  seenAt: string;
  /** When the lead last tried to reach the worker. */
  triedAt?: string;
}

interface RelayFileShape {
  items: Record<string, RelayRecord>;
}

/** A relay label's target in the owner config, or undefined. */
export const relayTarget = (
  ownerConfig: OwnerConfig,
  label: string | undefined,
): RelayTarget | undefined => (label === undefined ? undefined : ownerConfig.workers?.relay[label]);

/** The board's hold prefix and the line `tick` holds a relay item with. */
export const relayLine = (label: string, what: string): string => `worker: relay ${label}, ${what}`;

const file = (stateRoot: string) => join(stateRoot, RELAY_FILE);

export function readRelay(stateRoot: string): RelayFileShape {
  const f = file(stateRoot);
  assertStatePath(stateRoot, f);
  if (!existsSync(f)) return { items: {} };
  if (!lstatSync(f).isFile()) throw new Error(`${f} is not a plain file`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    throw new Error(`${f} is not valid JSON`);
  }
  const r = raw as Partial<RelayFileShape> | null;
  if (r === null || typeof r !== 'object' || typeof r.items !== 'object' || r.items === null) {
    throw new Error(`${f} has an unknown shape`);
  }
  return { items: r.items };
}

export function updateRelay<T>(stateRoot: string, mutate: (s: RelayFileShape) => T): T {
  const until = Date.now() + 5000;
  for (;;) {
    const lock = acquireStateLock(stateRoot, RELAY_LOCK, {
      now: new Date(),
      heartbeatStaleMs: 30_000,
    });
    if (lock) {
      try {
        const s = readRelay(stateRoot);
        const out = mutate(s);
        writeStateFile(stateRoot, file(stateRoot), `${JSON.stringify(s, null, 2)}\n`);
        return out;
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= until) throw new Error(`${RELAY_FILE} is locked; try again`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

/** The report a relay worker handed back, once checked: collect reads it from here. */
export const relayReportFile = (stateRoot: string, id: string): string =>
  join(stateRoot, 'relay', `${id}.report.md`);

/** git with the crew token for GitHub, in this call's environment only. */
function tokenGit(ports: Ports, token: string) {
  const auth = [
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!f() { echo username=x-access-token; echo "password=$STUDIO_PUSH_TOKEN"; }; f',
  ];
  return (cwd: string, args: string[]) =>
    ports.git.run(cwd, [...auth, ...args], {
      timeoutMs: 600_000,
      env: { STUDIO_PUSH_TOKEN: token },
    });
}

/** The object store of the owner's checkout, for alternates: it holds every pinned commit. */
async function projectObjects(project: string, ports: Ports): Promise<string> {
  const common = (await ports.git.run(project, ['rev-parse', '--git-common-dir'])).trim();
  return join(isAbsolute(common) ? common : resolve(project, common), 'objects');
}

/**
 * The lead's own bare repository for relay work (`relay/git` in the state root): it borrows the
 * owner's objects (alternates) and holds what came from GitHub for a fix round.
 */
async function relayGit(stateRoot: string, project: string, ports: Ports): Promise<string> {
  const dir = join(stateRoot, 'relay', 'git');
  if (!existsSync(join(dir, 'HEAD'))) {
    ensureStateDir(stateRoot, join(stateRoot, 'relay'));
    removeStateEntry(stateRoot, dir);
    await ports.git.run(join(stateRoot, 'relay'), ['init', '-q', '--bare', '--template=', dir]);
  }
  writeStateFile(
    stateRoot,
    join(dir, 'objects', 'info', 'alternates'),
    `${await projectObjects(project, ports)}\n`,
  );
  return dir;
}

/**
 * The bundle a start sends: `main` at the pinned commit and, for a fix round, `studio/<id>` as
 * GitHub has it. Returns the bytes and that head.
 */
export async function startBundle(o: {
  stateRoot: string;
  project: string;
  item: WorkItem;
  sha: string;
  ports: Ports;
  crewToken: string;
  /** Where `studio/<id>` lives; GitHub's HTTPS URL of the item's repository by default. */
  url?: string;
}): Promise<{ bytes: Buffer; fromSha?: string }> {
  const dir = await relayGit(o.stateRoot, o.project, o.ports);
  const g = (args: string[]) => o.ports.git.run(dir, args, { timeoutMs: 600_000 });
  const tg = tokenGit(o.ports, o.crewToken);
  const url = o.url ?? githubHttpsUrl(o.item.repo);
  const branch = `refs/heads/studio/${o.item.id}`;
  await g(['update-ref', 'refs/heads/main', o.sha]);
  const remote = (await tg(dir, ['ls-remote', url, branch])).split(/\s/)[0]?.toLowerCase() ?? '';
  let fromSha: string | undefined;
  if (/^[0-9a-f]{40}$/.test(remote)) {
    await tg(dir, [
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      url,
      `+${branch}:${branch}`,
    ]);
    fromSha = (await g(['rev-parse', '--verify', `${branch}^{commit}`])).trim();
  } else {
    await g(['update-ref', '-d', branch]).catch(() => '');
  }
  const out = join(dir, `start-${o.item.id}.bundle`);
  try {
    await g([
      'bundle',
      'create',
      '-q',
      out,
      'refs/heads/main',
      ...(fromSha === undefined ? [] : [branch]),
    ]);
    const bytes = readFileSync(out);
    if (bytes.length > MAX_START_BUNDLE_BYTES) {
      throw new Error('the repository is larger than a relay start may carry');
    }
    return { bytes, ...(fromSha === undefined ? {} : { fromSha }) };
  } finally {
    removeStateEntry(o.stateRoot, out);
  }
}

/** Sends the job; a held answer throws `HeldError`-like with `held`, a refusal throws. */
export async function sendStart(o: {
  transport: RelayTransport;
  item: WorkItem;
  label: string;
  repo: string;
  sha: string;
  fromSha?: string;
  bundle: Buffer;
  token: string;
}): Promise<{ ok: true } | { ok: false; kind: 'held' | 'refused' | 'error'; line: string }> {
  const { answer } = await relayCall(
    o.transport,
    'start',
    {
      job: {
        id: o.item.id,
        label: o.label,
        repo: o.repo,
        sha: o.sha,
        from: o.fromSha === undefined ? ITEM_BASE : `studio/${o.item.id}`,
        ...(o.fromSha === undefined ? {} : { fromSha: o.fromSha }),
        item: workerItemFields(o.item),
        token: o.token,
      },
    },
    { payload: o.bundle, timeoutMs: 30 * 60_000 },
  );
  return answer.ok ? { ok: true } : { ok: false, kind: answer.kind, line: answer.line };
}

/** What following a relay job found this tick. */
export type RelayFollow =
  | { kind: 'waiting'; line: string; running: boolean }
  | { kind: 'ended' }
  /** Nothing ran: the item goes back to ready (`held`) or to the lead (`refused`). */
  | { kind: 'held' | 'refused'; line: string }
  | { kind: 'lead'; line: string };

/**
 * Polls the job's state. A worker that cannot be reached for longer than the label's grace goes to
 * the lead, never to a second attempt elsewhere.
 */
export async function followRelay(o: {
  transport: RelayTransport;
  stateRoot: string;
  id: string;
  record: RelayRecord;
  target: RelayTarget;
  now: Date;
}): Promise<RelayFollow> {
  const { record, now } = o;
  const label = record.label;
  let state: RelayState;
  let line: string | null = null;
  try {
    const { answer } = await relayCall(o.transport, 'status', { id: o.id }, { timeoutMs: 60_000 });
    if (!answer.ok) throw new RelayUnreachable(answer.line);
    state = answer.state;
    line = answer.line;
  } catch (e) {
    if (!(e instanceof RelayUnreachable)) throw e;
    const since = Date.parse(record.seenAt);
    const mins = Math.max(0, Math.floor((now.getTime() - since) / 60_000));
    updateRelay(o.stateRoot, (s) => {
      const r = s.items[o.id];
      if (r !== undefined) r.triedAt = now.toISOString();
    });
    if (now.getTime() - since > o.target.graceMinutes * 60_000) {
      return {
        kind: 'lead',
        line: `${o.id}: the relay worker ${label} has not answered for ${mins} min (${e.message}); look at the machine, then studio stop ${o.id} --requeue or drop it`,
      };
    }
    return {
      kind: 'waiting',
      running: record.state === 'running',
      line: relayLine(label, `unreachable for ${mins} min`),
    };
  }
  updateRelay(o.stateRoot, (s) => {
    const r = s.items[o.id];
    if (r !== undefined) {
      r.state = state;
      r.seenAt = now.toISOString();
      r.triedAt = now.toISOString();
    }
  });
  switch (state) {
    case 'starting':
      return { kind: 'waiting', running: false, line: relayLine(label, 'starting the crew') };
    case 'running':
      return { kind: 'waiting', running: true, line: relayLine(label, 'crew running') };
    case 'ended':
      return { kind: 'ended' };
    case 'held':
    case 'refused':
      return { kind: state, line: line ?? `the relay worker ${label} did not start it` };
    case 'stopped':
      return {
        kind: 'lead',
        line: `${o.id}: stopped on the relay worker ${label}; studio stop ${o.id} --requeue or drop it`,
      };
    case 'unknown':
      return {
        kind: 'lead',
        line: `${o.id}: the relay worker ${label} knows no such job; studio stop ${o.id} --requeue starts it again`,
      };
  }
}

/** What a collect from a relay worker came to. */
export type RelayCollected =
  | { kind: 'held'; line: string }
  | {
      kind: 'ok' | 'failed';
      /** `failed`: Studio's reason, the item goes to the lead. */
      reason?: string;
      usage: CollectAnswer['usage'];
      limit: CollectAnswer['limit'];
      block: boolean;
    };

/**
 * Takes the result of an ended job. The report and the bundle are crew output: size caps, a
 * credential scan of the report, and the bundle unpacked into a fresh bare directory with no hooks,
 * holding exactly `studio/<id>`, at the report's head, on top of the pinned commit (and of the
 * branch a fix round started from). Then `studio/<id>` is pushed with the crew token, never forced,
 * and the report is stored for `collect`.
 */
export async function collectRelay(o: {
  transport: RelayTransport;
  stateRoot: string;
  project: string;
  item: WorkItem;
  record: RelayRecord;
  ports: Ports;
  crewToken: string;
  /** Exact values a report must not hold, besides the token patterns. */
  secrets: readonly string[];
  /** Where `studio/<id>` is pushed; GitHub's HTTPS URL of the item's repository by default. */
  url?: string;
}): Promise<RelayCollected> {
  const { answer, payload } = await relayCall(
    o.transport,
    'collect',
    { id: o.item.id },
    { maxPayload: MAX_RESULT_BUNDLE_BYTES, timeoutMs: 30 * 60_000 },
  );
  if (!answer.ok) {
    if (answer.kind === 'held')
      return { kind: 'held', line: relayLine(o.record.label, answer.line) };
    return { kind: 'failed', reason: answer.line, usage: null, limit: null, block: false };
  }
  const base = { usage: answer.usage, limit: answer.limit, block: answer.block };
  if (answer.problem !== null) return { kind: 'failed', reason: answer.problem, ...base };
  if (looksSecret(answer.report, o.secrets)) {
    return {
      kind: 'failed',
      reason: 'the report looks like it holds a credential; it was not used',
      ...base,
    };
  }
  if (answer.payload) {
    if (payload === undefined || answer.headSha === null) {
      return { kind: 'failed', reason: 'the result names a branch but carries none', ...base };
    }
    const problem = await acceptResult({ ...o, head: answer.headSha, bundle: payload });
    if (problem !== undefined) return { kind: 'failed', reason: problem, ...base };
  }
  ensureStateDir(o.stateRoot, join(o.stateRoot, 'relay'));
  writeStateFile(o.stateRoot, relayReportFile(o.stateRoot, o.item.id), answer.report);
  return { kind: 'ok', ...base };
}

/**
 * Checks a result bundle and pushes its branch; returns Studio's reason when anything fails. Git
 * runs only in a directory made for this result: `--template=` gives it no hooks, a hooks path that
 * does not exist keeps the owner's hooks away too, and a bundle carries no config.
 */
export async function acceptResult(o: {
  stateRoot: string;
  project: string;
  item: WorkItem;
  record: RelayRecord;
  ports: Ports;
  crewToken: string;
  head: string;
  bundle: Buffer;
  url?: string;
}): Promise<string | undefined> {
  const id = o.item.id;
  const branch = `refs/heads/studio/${id}`;
  if (o.bundle.length > MAX_RESULT_BUNDLE_BYTES) return 'the result is larger than allowed';
  const parent = ensureStateDir(o.stateRoot, join(o.stateRoot, 'relay'));
  const dir = join(parent, `in-${id}`);
  removeStateEntry(o.stateRoot, dir);
  const noHooks = ['-c', `core.hooksPath=${join(dir, 'no-hooks')}`];
  const g = (args: string[]) =>
    o.ports.git.run(dir, [...noHooks, '--no-replace-objects', ...args], { timeoutMs: 600_000 });
  try {
    await o.ports.git.run(parent, ['init', '-q', '--bare', '--template=', dir]);
    const relayObjects = join(await relayGit(o.stateRoot, o.project, o.ports), 'objects');
    writeStateFile(
      o.stateRoot,
      join(dir, 'objects', 'info', 'alternates'),
      `${await projectObjects(o.project, o.ports)}\n${relayObjects}\n`,
    );
    const file = join(dir, 'result.bundle');
    writeStateFile(o.stateRoot, file, '');
    writeFileSync(file, o.bundle);
    let heads: string[];
    try {
      heads = (await g(['bundle', 'list-heads', file])).split('\n').filter((l) => l.trim() !== '');
    } catch {
      return 'the result is not a git bundle';
    }
    const [only] = heads;
    if (heads.length !== 1 || only === undefined)
      return 'the result bundle holds more or other refs than studio/<id>';
    const [sha, ref] = only.trim().split(/\s+/);
    if (ref !== branch) return 'the result bundle holds another ref than studio/<id>';
    if (sha?.toLowerCase() !== o.head.toLowerCase())
      return 'the result bundle head differs from the report';
    try {
      await g(['bundle', 'verify', '-q', file]);
      await g([
        '-c',
        'fetch.fsckObjects=true',
        'fetch',
        '-q',
        '--no-tags',
        '--no-write-fetch-head',
        file,
        `${branch}:${branch}`,
      ]);
    } catch {
      return 'the result bundle does not apply on top of the pinned commit';
    }
    const got = (await g(['rev-parse', '--verify', `${branch}^{commit}`])).trim();
    if (got !== o.head.toLowerCase()) return 'the result bundle head differs from the report';
    for (const base of [
      o.record.sha,
      ...(o.record.fromSha === undefined ? [] : [o.record.fromSha]),
    ]) {
      try {
        await g(['merge-base', '--is-ancestor', base, got]);
      } catch {
        return `studio/${id} does not descend from ${base.slice(0, 12)}`;
      }
    }
    const tg = tokenGit(o.ports, o.crewToken);
    const url = o.url ?? githubHttpsUrl(o.item.repo);
    try {
      await tg(dir, [...noHooks, 'push', '-q', url, `${branch}:${branch}`]);
    } catch {
      return `studio/${id} could not be pushed (never forced): the branch on GitHub moved meanwhile`;
    }
    const remote = (await tg(dir, ['ls-remote', url, branch])).split(/\s/)[0] ?? '';
    if (remote.toLowerCase() !== got) return 'the pushed branch head differs from the report';
    return undefined;
  } finally {
    removeStateEntry(o.stateRoot, dir);
  }
}

/** Stops the job on the worker and cleans up after it; best effort, the errors come back. */
export async function stopRelay(o: { transport: RelayTransport; id: string }): Promise<string[]> {
  const errors: string[] = [];
  for (const op of ['stop', 'cleanup'] as const) {
    try {
      const { answer } = await relayCall(o.transport, op, { id: o.id }, { timeoutMs: 120_000 });
      if (!answer.ok) errors.push(answer.line);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return errors;
}

/** The checks of `studio doctor` for one relay label: reachable, versions, pins, load. */
export async function relayDoctor(o: {
  transport: RelayTransport;
  label: string;
  studioVersion: string;
  pins: readonly { name: string; version: string }[];
}): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  try {
    const { answer: hello } = await relayCall(o.transport, 'hello', {}, { timeoutMs: 60_000 });
    if (!hello.ok) return { ok: false, lines: [`${o.label}: ${hello.line}`] };
    lines.push(
      `${o.label}: reachable, Studio ${hello.studio} on ${hello.platform}${hello.busy === null ? '' : `, running ${hello.busy}`}`,
    );
    if (hello.studio !== o.studioVersion) {
      ok = false;
      lines.push(
        `${o.label}: Studio ${hello.studio} there, ${o.studioVersion} here; fix: update Studio on the worker, then run studio relay install there again`,
      );
    }
    for (const p of o.pins) {
      const v = hello.plugins?.[p.name];
      if (v !== p.version) {
        ok = false;
        lines.push(
          `${o.label}: plugin ${p.name} is ${v ?? 'missing'} there, pinned ${p.version}; fix: run studio relay install on the worker again`,
        );
      }
    }
    for (const w of hello.warnings) {
      ok = false;
      lines.push(`${o.label}: ${w}`);
    }
    const { answer: probe } = await relayCall(o.transport, 'probe', {}, { timeoutMs: 10 * 60_000 });
    if (!probe.ok) {
      ok = false;
      lines.push(`${o.label}: probe: ${probe.line}`);
    } else {
      if (probe.load !== null) {
        lines.push(
          `${o.label}: CPU ${Math.round(probe.load.cpuPercent)} %, ${probe.load.freeDiskGb.toFixed(1)} GB free`,
        );
      }
      if (probe.problem !== null) {
        ok = false;
        lines.push(
          `${o.label}: ${probe.kind === 'held' ? 'not now' : 'refused'}: ${probe.problem}`,
        );
      }
      for (const w of probe.warnings) lines.push(`${o.label}: note: ${w}`);
    }
  } catch (e) {
    return {
      ok: false,
      lines: [
        `${o.label}: ${(e as Error).message}; fix: check that the worker is on and sshd runs there; if it was set up anew, studio relay pair ${o.label} <host> again`,
      ],
    };
  }
  return { ok, lines };
}
