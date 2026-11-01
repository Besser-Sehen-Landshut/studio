import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewRecord, CrewState } from './crew.js';
import type { Parks } from './limits.js';
import type { MainBuild } from './main-build.js';
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
  /** Deploys followed by an incident, over all deploys; null without a deploy. */
  changeFailureRate: number | null;
  failedDeploys: number;
  medianTimeToRestoreHours: number | null;
  openIncidents: number;
  restores: { incident: string; hours: number }[];
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
  /** Title of the board item; absent when the item is not on the board. */
  title?: string;
  /** What the crew is doing, for the pane; `status` stays the board status. */
  state: CrewState;
  stoppedAt?: string;
  repo?: string;
}

export interface MergedToday {
  pr: number;
  repo: string;
  at: string;
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
  ci: { busy: number; total: number; mergeMaxBusy: number; ok: boolean };
  /** Merges and deploys of this project on the owner's local day (`crew_label_limits.timezone`). */
  today: { day: string; merged: MergedToday[]; deployed: number };
  /** Runs per day and credential label (labels only); absent when nothing ran or the file is unreadable. */
  usageDays?: Record<string, Record<string, number>>;
  mainBuild: MainBuild;
  counts: { ready: number; queued: number };
  /** Owner-only items that are not merged or dropped, plus at most one `account-block` or `usage-limit` line. */
  forOwner: { id: string; title: string }[];
  /** Credential labels parked at a usage limit. */
  limits?: Parks;
  /** Crews running and runs today per credential label (labels only); absent when empty. */
  labelUsage?: { day: string; labels: Record<string, { running: number; runsToday: number }> };
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
  const incidents = incidentMetrics(events);
  return {
    leadTimes,
    medianLeadTimeHours: medianOf(leadTimes.map((l) => l.leadTimeHours)),
    perDay,
    mergedTotal,
    deployedTotal,
    changeFailureRate: deployedTotal === 0 ? null : incidents.failedDeploys / deployedTotal,
    ...incidents,
  };
}

function medianOf(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** An incident counts against the latest deploy before it; events are taken in order of time. */
function incidentMetrics(events: readonly unknown[]) {
  const timed: { type: string; at: number; incident?: string; n: number }[] = [];
  events.forEach((raw, n) => {
    if (raw === null || typeof raw !== 'object') return;
    const ev = raw as Record<string, unknown>;
    const at = asTime(ev.at);
    if (at === undefined || typeof ev.type !== 'string') return;
    if (ev.type === 'deployed') timed.push({ type: ev.type, at, n });
    else if (
      (ev.type === 'incident_opened' || ev.type === 'incident_resolved') &&
      typeof ev.incident === 'string'
    ) {
      timed.push({ type: ev.type, at, incident: ev.incident, n });
    }
  });
  timed.sort((a, b) => a.at - b.at || a.n - b.n);
  // The file order decides between a resolve and its open when the clock says otherwise.
  const opened = new Map<string, number>();
  const restores: { incident: string; hours: number }[] = [];
  const failed = new Set<number>();
  let lastDeploy: number | undefined;
  for (const e of timed) {
    if (e.type === 'deployed') lastDeploy = e.n;
    else if (e.type === 'incident_opened' && !opened.has(e.incident as string)) {
      opened.set(e.incident as string, e.at);
      if (lastDeploy !== undefined) failed.add(lastDeploy);
    }
  }
  const stillOpen = new Map(opened);
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue;
    const ev = raw as Record<string, unknown>;
    const at = asTime(ev.at);
    if (ev.type !== 'incident_resolved' || at === undefined || typeof ev.incident !== 'string') {
      continue;
    }
    const start = stillOpen.get(ev.incident);
    if (start === undefined) continue;
    stillOpen.delete(ev.incident);
    restores.push({ incident: ev.incident, hours: Math.max(0, (at - start) / HOUR_MS) });
  }
  return {
    failedDeploys: failed.size,
    medianTimeToRestoreHours: medianOf(restores.map((r) => r.hours)),
    openIncidents: stillOpen.size,
    restores,
  };
}
