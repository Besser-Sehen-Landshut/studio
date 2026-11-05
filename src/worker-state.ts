// What the lead knows about items on workers (src/worker-lead.ts): one record per open offer and
// the usage of every worker run, in `workers.json` in the state root, changed under `workers.lock`.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireStateLock, assertStatePath, writeStateFile } from './paths.js';
import type { Claim } from './worker-claim.js';

/** Tokens and cost of worker runs, as `costs.ts` counts them. */
export interface WorkerRunUsage {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
  costUsd: number;
  estimated?: true;
}

export const WORKERS_FILE = 'workers.json';
export const WORKERS_LOCK = 'workers.lock';
const WORKERS_LOCK_STALE_MS = 30_000;

/** What the lead last saw of one item's claim. */
export interface SeenClaim {
  sha: string;
  worker: string;
  attempt: number;
  state: Claim['state'];
  /**
   * When the lead first saw this claim commit, on its own clock: the last heartbeat it knows of.
   * Leases run from here, never from the commit's dates, which the writer could set.
   */
  at: string;
  /** The commit that started this attempt, once proven: the next walk stops at this tip. */
  anchor?: string;
  pr?: number;
}

/** One ended worker run whose usage the worker reported, counted once. */
export interface WorkerRun {
  key: string;
  worker: string;
  usage: WorkerRunUsage;
}

export interface OfferRecord {
  label: string;
  offer: number;
  /** The random number in the offer that a claim comment must name. */
  nonce?: string;
  offeredAt: string;
  claim?: SeenClaim;
  /** When the lead last looked at the claim. */
  checkedAt?: string;
}

export interface WorkersState {
  items: Record<string, OfferRecord>;
  /** Usage per item over every worker run, kept after the offer closed. */
  runs: Record<string, WorkerRun[]>;
}

const empty = (): WorkersState => ({ items: {}, runs: {} });

const file = (stateRoot: string) => join(stateRoot, WORKERS_FILE);

/** Strict: a missing file is empty, anything malformed throws (fail closed). */
export function readWorkers(stateRoot: string): WorkersState {
  const f = file(stateRoot);
  assertStatePath(stateRoot, f);
  if (!existsSync(f)) return empty();
  if (!lstatSync(f).isFile()) throw new Error(`${f} is not a plain file`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    throw new Error(`${f} is not valid JSON`);
  }
  const r = raw as Partial<WorkersState> | null;
  if (
    r === null ||
    typeof r !== 'object' ||
    typeof r.items !== 'object' ||
    r.items === null ||
    typeof r.runs !== 'object' ||
    r.runs === null
  ) {
    throw new Error(`${f} has an unknown shape`);
  }
  return { items: r.items as WorkersState['items'], runs: r.runs as WorkersState['runs'] };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Reads, changes and writes `workers.json` under `workers.lock` (up to 5 s of waiting). */
export function updateWorkers<T>(stateRoot: string, mutate: (s: WorkersState) => T): T {
  const until = Date.now() + 5000;
  for (;;) {
    const lock = acquireStateLock(stateRoot, WORKERS_LOCK, {
      now: new Date(),
      heartbeatStaleMs: WORKERS_LOCK_STALE_MS,
    });
    if (lock) {
      try {
        const s = readWorkers(stateRoot);
        const out = mutate(s);
        writeStateFile(stateRoot, file(stateRoot), `${JSON.stringify(s, null, 2)}\n`);
        return out;
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= until) throw new Error(`${WORKERS_FILE} is locked; try again`);
    sleepSync(25);
  }
}
