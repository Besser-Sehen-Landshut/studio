import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewRecord } from './crew.js';
import type { Parks } from './limits.js';
import { assertStatePath, ensureStateDir } from './paths.js';
import type { Capacity } from './planner.js';
import type { QueueState } from './queue.js';

export interface LeadTime {
  item: string | null;
  pr: number | null;
  at: string;
  leadTimeHours: number;
}

export interface DayCount {
  merged: number;
  deployed: number;
}

export interface Metrics {
  leadTimes: LeadTime[];
  medianLeadTimeHours: number | null;
  /** Merge and deploy events per UTC date (`YYYY-MM-DD`). */
  perDay: Record<string, DayCount>;
  mergedTotal: number;
  deployedTotal: number;
}

export interface CrewSnapshot {
  name: string;
  role: string;
  item: string;
  status: string;
  pr?: number;
  since: string;
  /** Label of the credential this crew runs on (never the credential). */
  label?: string;
}

export interface Notification {
  id: 'account-block';
  title: string;
  reason: string;
  at: string;
  /** Absent when the block file is unreadable, so no label is known. */
  label?: string;
}

export interface StateSnapshot {
  crew: CrewSnapshot[];
  queue: QueueState;
  capacity: Capacity;
  /** Owner-only items that are not merged or dropped, plus at most one `account-block` or `usage-limit` line. */
  forOwner: { id: string; title: string }[];
  /** Credential labels parked at a usage limit. */
  limits?: Parks;
  /** One entry per account block, for whatever shows the owner this state; absent without a block. */
  notifications?: Notification[];
  updatedAt: string;
  metrics: Metrics;
}

/** Test seam: how the temp file gets its content. */
export interface WriteStateDeps {
  writeFile?: (path: string, content: string) => void;
}

const defaultWriteFile = (path: string, content: string): void =>
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });

/**
 * Atomically replaces `<stateRoot>/state.json` (temp file + rename, mode 0600). When writing or
 * renaming fails, the temp file is removed and the previous state.json stays untouched.
 */
export function writeState(
  stateRoot: string,
  snapshot: StateSnapshot,
  deps: WriteStateDeps = {},
): void {
  const file = join(stateRoot, 'state.json');
  ensureStateDir(stateRoot, stateRoot);
  assertStatePath(stateRoot, file);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    (deps.writeFile ?? defaultWriteFile)(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** True when the file exists as a plain entry; false when missing; throws for a symlink. */
function existsNoLink(file: string): boolean {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`refusing to read ${file}: it is a symlink`);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Crew records of `<stateRoot>/crew.json`; empty when the file is missing. */
export function readCrewRecords(stateRoot: string): Record<string, CrewRecord> {
  const file = join(stateRoot, 'crew.json');
  assertStatePath(stateRoot, file);
  if (!existsNoLink(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`crew file ${file} is not valid JSON`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`crew file ${file} is not a JSON object`);
  }
  return raw as Record<string, CrewRecord>;
}

/** Events of `<stateRoot>/metrics.jsonl`; lines that are not JSON are skipped. */
export function readMetricEvents(stateRoot: string): unknown[] {
  const file = join(stateRoot, 'metrics.jsonl');
  assertStatePath(stateRoot, file);
  if (!existsSync(file) || !existsNoLink(file)) return [];
  const events: unknown[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // a torn line must not hide the rest
    }
  }
  return events;
}

const HOUR_MS = 3_600_000;

const asTime = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
};

/**
 * Pure. Lead time per merged event = `at` - `firstCommitAt` (events without a usable
 * `firstCommitAt` are skipped); deployment frequency = merged and deployed events per UTC day.
 */
export function computeMetrics(events: readonly unknown[]): Metrics {
  const leadTimes: LeadTime[] = [];
  const perDay: Record<string, DayCount> = {};
  let mergedTotal = 0;
  let deployedTotal = 0;
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue;
    const ev = raw as Record<string, unknown>;
    if (ev.type !== 'merged' && ev.type !== 'deployed') continue;
    const at = asTime(ev.at);
    if (at === undefined) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    const counts = perDay[day] ?? { merged: 0, deployed: 0 };
    perDay[day] = counts;
    if (ev.type === 'deployed') {
      counts.deployed++;
      deployedTotal++;
      continue;
    }
    counts.merged++;
    mergedTotal++;
    const first = asTime(ev.firstCommitAt);
    if (first === undefined) continue;
    leadTimes.push({
      item: typeof ev.item === 'string' ? ev.item : null,
      pr: typeof ev.pr === 'number' ? ev.pr : null,
      at: new Date(at).toISOString(),
      leadTimeHours: Math.max(0, (at - first) / HOUR_MS),
    });
  }
  const sorted = leadTimes.map((l) => l.leadTimeHours).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2
        ? (sorted[mid] as number)
        : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return { leadTimes, medianLeadTimeHours: median, perDay, mergedTotal, deployedTotal };
}
