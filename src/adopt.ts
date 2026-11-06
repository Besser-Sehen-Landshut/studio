// `studio adopt --from <old state root>`: brings the history of an earlier state root of the same
// repository into the project's current one, after the project folder moved (the state root is
// named after the folder's real path) or the state base changed. History only: never clones,
// homes, logs, crew records, locks or per-run folders. A dry run unless `apply`; idempotent; the
// old root is never deleted.
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crewHold } from './crew.js';
import {
  acquireStateLock,
  checkStateMarker,
  inspectStateLock,
  normalizeOrigin,
  projectRealpath,
  sameOrigin,
  writeStateFile,
} from './paths.js';
import type { Ports } from './ports.js';
import { FILE_LOCK_STALE_MS, RUN_LOCK, RUN_LOCK_HEARTBEAT_STALE_MS, updateQueue } from './queue.js';
import { TICK_LOCK, TICK_LOCK_STALE_MS } from './recover.js';
import { readCrewRecords } from './state.js';

/** Small history files taken over whole (when the current root has none) or merged line by line. */
export const ADOPT_FILES: readonly { name: string; kind: 'json' | 'jsonl' }[] = [
  { name: 'metrics.jsonl', kind: 'jsonl' },
  { name: 'costs.json', kind: 'json' },
  { name: 'lessons.json', kind: 'json' },
  { name: 'lessons-review.json', kind: 'json' },
  { name: 'skills-check.json', kind: 'json' },
  { name: 'exceptions.jsonl', kind: 'jsonl' },
  { name: 'releases.json', kind: 'json' },
  { name: 'releases.jsonl', kind: 'jsonl' },
  { name: 'rea-allow.json', kind: 'json' },
  { name: 'flaky.json', kind: 'json' },
  { name: 'ci-reruns.json', kind: 'json' },
  { name: 'acceptance-runs.json', kind: 'json' },
  { name: 'group-contracts.json', kind: 'json' },
];

/** The queue's history: `done` of queue.json, merged entry by entry; pending work is not taken. */
const QUEUE = 'queue.json';

export type AdoptAction = 'copy' | 'merge' | 'same' | 'conflict';

export interface AdoptFile {
  name: string;
  action: AdoptAction;
  /** Lines or queue entries added by a merge. */
  added?: number;
  /** Why a file stays as it is in the current root. */
  note?: string;
}

export interface AdoptResult {
  from: string;
  to: string;
  applied: boolean;
  files: AdoptFile[];
  /** Entries of the old root left behind on purpose (clones, crew records, locks, run folders, ...). */
  left: string[];
  /** Queue entries of the old root that were pending: not taken over. */
  pendingLeft?: number;
  /** What to run next: the apply, or deleting the old root by hand. */
  next: string;
  deleteOld: string;
}

export interface AdoptOptions {
  project: string;
  /** The current project's state root (stateRootFor). */
  to: string;
  from: string;
  apply: boolean;
  ports: Ports;
  now: Date;
}

const shellWord = (p: string): string =>
  /^[\w./:@%+=,-]+$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`;

function plainFile(file: string): string | undefined {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`refusing ${file}: it is a symlink`);
    if (!st.isFile()) throw new Error(`refusing ${file}: it is not a plain file`);
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function isDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function markerOrigin(root: string): string {
  const text = plainFile(join(root, 'marker.json'));
  if (text === undefined) throw new Error(`${root} has no marker.json: it is not a state root`);
  let m: { originUrl?: unknown } | null;
  try {
    m = JSON.parse(text) as typeof m;
  } catch {
    throw new Error(`${join(root, 'marker.json')} is unreadable`);
  }
  if (typeof m?.originUrl !== 'string') throw new Error(`${root}/marker.json names no origin`);
  return m.originUrl;
}

/** Why nothing may move between the roots now: a live crew, a queue run, a tick. */
async function busy(root: string, label: string, ports: Ports, now: Date): Promise<string[]> {
  if (!isDir(root)) return [];
  const why: string[] = [];
  const records = readCrewRecords(root);
  for (const rec of Object.values(records)) {
    if (rec.stoppedAt !== undefined) continue;
    const hold = await crewHold(rec, ports);
    if (hold === 'running') why.push(`${label}: crew ${rec.name} of ${rec.item} is alive`);
    else if (hold === 'unverified') {
      why.push(`${label}: crew ${rec.name} of ${rec.item} may be alive (pid ${rec.pid})`);
    }
  }
  for (const [name, staleMs, what] of [
    [RUN_LOCK, RUN_LOCK_HEARTBEAT_STALE_MS, 'a queue run is active'],
    [TICK_LOCK, TICK_LOCK_STALE_MS, 'a tick is running'],
  ] as const) {
    if (inspectStateLock(root, name, { now, heartbeatStaleMs: staleMs }).state === 'held') {
      why.push(`${label}: ${what}`);
    }
  }
  const q = plainFile(join(root, QUEUE));
  if (q !== undefined) {
    try {
      const cur = (JSON.parse(q) as { current?: unknown }).current;
      if (cur !== undefined && cur !== null)
        why.push(`${label}: the queue has a merge in progress`);
    } catch {
      why.push(`${label}: queue.json is unreadable`);
    }
  }
  return why;
}

const lines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

type QueueDoneEntry = { pr: number; repo: string; result: string; at: string };
const doneKey = (d: QueueDoneEntry) => `${d.repo}#${d.pr}|${d.result}|${d.at}`;

/** Plans (and with `apply` makes) the adoption. Throws with the reason when it must not run. */
export async function adoptStateRoot(o: AdoptOptions): Promise<AdoptResult> {
  const from = resolve(o.from);
  if (!isDir(from))
    throw new Error(`${from} is not a state root folder (missing, a link or a file)`);
  const realFrom = realpathSync(from);
  if (isDir(o.to) && realpathSync(o.to) === realFrom) {
    throw new Error(`${from} is this project's own state root; nothing to adopt`);
  }
  // The same repository, however its origin is spelled (ssh, https, .git, a trailing slash).
  const oldOrigin = markerOrigin(from);
  const origin = (await o.ports.git.run(o.project, ['remote', 'get-url', 'origin'])).trim();
  if (!sameOrigin(oldOrigin, origin)) {
    throw new Error(
      `${from} belongs to ${normalizeOrigin(oldOrigin)}, this project is ${normalizeOrigin(origin)}: only a state root of the same repository can be adopted`,
    );
  }
  const busyNow = [
    ...(await busy(from, 'old root', o.ports, o.now)),
    ...(await busy(o.to, 'this root', o.ports, o.now)),
  ];
  if (busyNow.length > 0) {
    throw new Error(`not now: ${busyNow.join('; ')}; nothing changed`);
  }

  const files: AdoptFile[] = [];
  const writes: { name: string; content: string }[] = [];
  for (const f of ADOPT_FILES) {
    const old = plainFile(join(from, f.name));
    if (old === undefined) continue;
    const cur = isDir(o.to) ? plainFile(join(o.to, f.name)) : undefined;
    if (cur === undefined) {
      files.push({ name: f.name, action: 'copy' });
      writes.push({ name: f.name, content: old });
    } else if (cur === old) {
      files.push({ name: f.name, action: 'same' });
    } else if (f.kind === 'jsonl') {
      // Append-only logs: the old root's lines first (they are older), each line once.
      const have = new Set(lines(cur));
      const missing = lines(old).filter((l) => !have.has(l));
      if (missing.length === 0) files.push({ name: f.name, action: 'same' });
      else {
        files.push({ name: f.name, action: 'merge', added: missing.length });
        writes.push({ name: f.name, content: `${[...missing, ...lines(cur)].join('\n')}\n` });
      }
    } else {
      files.push({
        name: f.name,
        action: 'conflict',
        note: 'both roots hold one and they differ: the current one is kept; compare them by hand',
      });
    }
  }

  // The queue's merge history; pending entries and a current merge are work, not history.
  let queueDone: QueueDoneEntry[] = [];
  let pendingLeft = 0;
  const oldQueue = plainFile(join(from, QUEUE));
  if (oldQueue !== undefined) {
    const q = JSON.parse(oldQueue) as { pending?: unknown[]; done?: QueueDoneEntry[] };
    pendingLeft = q.pending?.length ?? 0;
    queueDone = q.done ?? [];
    if (queueDone.length > 0) {
      const curText = isDir(o.to) ? plainFile(join(o.to, QUEUE)) : undefined;
      const have = new Set(
        (
          (curText === undefined ? {} : JSON.parse(curText)) as { done?: QueueDoneEntry[] }
        ).done?.map(doneKey) ?? [],
      );
      const added = queueDone.filter((d) => !have.has(doneKey(d))).length;
      files.push(
        added === 0
          ? { name: `${QUEUE} (done)`, action: 'same' }
          : { name: `${QUEUE} (done)`, action: 'merge', added },
      );
    }
  }

  // Everything else stays where it is: clones, homes, logs, crew records, locks, run folders.
  const known = new Set([...ADOPT_FILES.map((f) => f.name), QUEUE]);
  const left = readdirSync(from)
    .filter((e) => !known.has(e))
    .sort();

  const deleteOld = `rm -rf -- ${shellWord(from)}`;
  const changes = files.some((f) => f.action === 'copy' || f.action === 'merge');
  if (o.apply && changes) {
    // This root is bound to this project first, as every writing command does.
    checkStateMarker(o.to, { projectRealpath: projectRealpath(o.project), originUrl: origin });
    const lock = acquireStateLock(o.to, TICK_LOCK, {
      now: o.now,
      heartbeatStaleMs: TICK_LOCK_STALE_MS,
    });
    if (lock === undefined)
      throw new Error('not now: a tick is running in this root; nothing changed');
    try {
      for (const w of writes) writeStateFile(o.to, join(o.to, w.name), w.content);
      if (queueDone.length > 0) {
        updateQueue(
          o.to,
          (q) => {
            const have = new Set(q.done.map(doneKey));
            const missing = queueDone.filter((d) => !have.has(doneKey(d)));
            q.done = [...(missing as typeof q.done), ...q.done];
          },
          { timeoutMs: FILE_LOCK_STALE_MS },
        );
      }
    } finally {
      lock.release();
    }
  }
  return {
    from,
    to: o.to,
    applied: o.apply && changes,
    files,
    left,
    ...(pendingLeft > 0 ? { pendingLeft } : {}),
    next: o.apply
      ? `check this project (studio metrics, studio lessons, studio release list), then delete the old root yourself: ${deleteOld}`
      : `studio adopt --from ${shellWord(from)} --apply`,
    deleteOld,
  };
}
