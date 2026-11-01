import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OwnerConfig, OwnerEnv } from './config.js';
import { runCredentialProvider } from './credentials.js';
import { activeParks, DEFAULT_LABEL, readLimits, validLabel } from './limits.js';
import { writeStateFile } from './paths.js';
import type { Ports } from './ports.js';
import { readCrewRecords } from './state.js';

/** Per-credential usage limits: parallel crews and runs per day, counted by label only. */

/** The lock that serialises "pick a label, then record the run" across processes. */
export const LAUNCH_LOCK = 'launch.lock';
export const LAUNCH_LOCK_STALE_MS = 10 * 60_000;
export const USAGE_DAYS_KEPT = 8;
/** Calls the planner makes to the credential provider to learn how many labels are free. */
export const MAX_PROBES = 16;

export const USAGE_UNREADABLE =
  'usage.json is unreadable: no crew starts until it is fixed or removed';
export const LABEL_FULL_LINE =
  'usage limit: every crew credential is at its configured limit; work resumes when a run ends or the day changes';
export const PROVIDER_HOLD_LINE =
  'credential provider failed or answered unexpectedly: no crew starts until it works again';
export const PROVIDER_EMPTY_LINE =
  'credential provider returned nothing while no label is at a limit: no crew starts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export type Usage = Record<string, Record<string, number>>;
export type UsageRead = { ok: true; days: Usage } | { ok: false };

/** `YYYY-MM-DD` of an instant in a zone (the system zone without one), so DST is Intl's business. */
export function dayKey(now: Date, timezone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const usageFile = (stateRoot: string): string => join(stateRoot, 'usage.json');

/** Strict. A missing file is empty; a link, a non-file or anything malformed is `{ ok: false }`. */
export function readUsage(stateRoot: string): UsageRead {
  const file = usageFile(stateRoot);
  try {
    if (!lstatSync(file).isFile()) return { ok: false };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, days: {} } : { ok: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false };
  }
  if (!isObject(raw)) return { ok: false };
  const days: Usage = Object.create(null);
  for (const [day, labels] of Object.entries(raw)) {
    if (!DAY_RE.test(day) || !isObject(labels)) return { ok: false };
    const counts: Record<string, number> = Object.create(null);
    for (const [label, runs] of Object.entries(labels)) {
      if (!validLabel(label)) return { ok: false };
      if (typeof runs !== 'number' || !Number.isSafeInteger(runs) || runs < 0) return { ok: false };
      counts[label] = runs;
    }
    days[day] = counts;
  }
  return { ok: true, days };
}

/** Counts one run of a label today and drops days older than the last eight. Throws when unreadable. */
export function recordRun(
  stateRoot: string,
  label: string,
  now: Date,
  timezone: string | undefined,
): void {
  const read = readUsage(stateRoot);
  if (!read.ok) throw new Error(USAGE_UNREADABLE);
  const today = dayKey(now, timezone);
  const cutoff = dayKey(new Date(now.getTime() - (USAGE_DAYS_KEPT - 1) * 86_400_000), timezone);
  const days: Usage = Object.create(null);
  for (const day of Object.keys(read.days).sort()) {
    if (day >= cutoff) days[day] = read.days[day] as Record<string, number>;
  }
  const todays: Record<string, number> = days[today] ?? Object.create(null);
  todays[label] = count(todays, label) + 1;
  days[today] = todays;
  writeStateFile(stateRoot, usageFile(stateRoot), `${JSON.stringify(days, null, 2)}\n`);
}

/** An own count of a label: a name such as `toString` must not reach an inherited value. */
const count = (map: Record<string, number>, label: string): number =>
  Object.hasOwn(map, label) ? (map[label] as number) : 0;

/**
 * Crews running per label: every record without `stoppedAt` whose process is alive, whatever the
 * board says about its item (a merged or dropped item with a live crew still uses the credential).
 * A record with an invalid pid counts (fail closed); a record without a label counts for the
 * default label. An unreadable crew.json throws, as readCrewRecords does.
 */
export function runningPerLabel(stateRoot: string, ports: Ports): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const rec of Object.values(readCrewRecords(stateRoot))) {
    if (rec.stoppedAt !== undefined) continue;
    const validPid = Number.isInteger(rec.pid) && rec.pid > 0;
    if (validPid && !ports.claude.alive(rec.pid)) continue;
    const label =
      typeof rec.label === 'string' && validLabel(rec.label) ? rec.label : DEFAULT_LABEL;
    out[label] = count(out, label) + 1;
  }
  return out;
}

export interface LabelUsage {
  /** False when usage.json is unreadable: every label counts as full. */
  ok: boolean;
  day: string;
  running: Record<string, number>;
  runsToday: Record<string, number>;
  /** Known labels at max_parallel or at the day limit. */
  full: string[];
  /** How many more crews the label may start now. */
  remaining(label: string): number;
}

export function labelUsage(o: {
  stateRoot: string;
  ownerConfig: OwnerConfig;
  ports: Ports;
}): LabelUsage {
  const { maxParallel, maxRunsPerDay, timezone } = o.ownerConfig.crewLabelLimits;
  const day = dayKey(o.ports.clock.now(), timezone);
  const running = runningPerLabel(o.stateRoot, o.ports);
  const read = readUsage(o.stateRoot);
  const runsToday: Record<string, number> = Object.assign(
    Object.create(null),
    read.ok ? read.days[day] : {},
  );
  const remaining = (label: string): number => {
    if (!read.ok) return 0;
    const parallel = maxParallel - count(running, label);
    const daily = maxRunsPerDay === undefined ? Infinity : maxRunsPerDay - count(runsToday, label);
    const room = Math.min(parallel, daily);
    // NaN (which no comparison catches) reads as no room.
    return Number.isNaN(room) ? 0 : Math.max(0, room);
  };
  const known = [...new Set([...Object.keys(running), ...Object.keys(runsToday)])].sort();
  return {
    ok: read.ok,
    day,
    running,
    runsToday,
    full: known.filter((l) => remaining(l) <= 0),
    remaining,
  };
}

/**
 * How many crews the credentials allow right now, or a hold line. Without a provider that is the
 * default label's room. With one it asks with a growing exclude list, up to MAX_PROBES times, and
 * adds the room of every label it hands out. Only the label of an answer is read: the token is
 * never stored, logged or returned.
 */
export async function credentialSlots(o: {
  stateRoot: string;
  ownerConfig: OwnerConfig;
  ports: Ports;
  owner: OwnerEnv;
}): Promise<{ slots: number; hold?: undefined } | { hold: string; slots?: undefined }> {
  const usage = labelUsage(o);
  if (!usage.ok) return { hold: USAGE_UNREADABLE };
  const limits = readLimits(o.stateRoot);
  if (!limits.ok) {
    return { hold: 'usage limit state is unreadable (limits.json): no crew starts until fixed' };
  }
  const parked = Object.keys(activeParks(limits.labels, o.ports.clock.now()));
  const exclude = [...new Set([...parked, ...usage.full])];
  const command = o.ownerConfig.crewCredentialCommand;
  if (command === undefined) {
    return { slots: exclude.includes(DEFAULT_LABEL) ? 0 : usage.remaining(DEFAULT_LABEL) };
  }
  let slots = 0;
  for (let call = 0; call < MAX_PROBES; call++) {
    let label: string | undefined;
    try {
      label = (
        await runCredentialProvider(command, { item: '', role: '', exclude }, o.ports, o.owner)
      )?.label;
    } catch {
      return { hold: PROVIDER_HOLD_LINE };
    }
    if (label === undefined) {
      if (call === 0 && exclude.length === 0) return { hold: PROVIDER_EMPTY_LINE };
      break;
    }
    if (exclude.includes(label)) return { hold: PROVIDER_HOLD_LINE };
    slots += usage.remaining(label);
    exclude.push(label);
  }
  return { slots };
}

export interface LabelUsageSnapshot {
  day: string;
  labels: Record<string, { running: number; runsToday: number }>;
}

/** Running crews and runs today per label, for state.json; undefined when there is nothing to show. */
export function labelUsageSnapshot(o: {
  stateRoot: string;
  ownerConfig: OwnerConfig;
  ports: Ports;
}): LabelUsageSnapshot | undefined {
  const usage = labelUsage(o);
  if (!usage.ok) return undefined;
  const labels: LabelUsageSnapshot['labels'] = {};
  for (const label of [
    ...new Set([...Object.keys(usage.running), ...Object.keys(usage.runsToday)]),
  ].sort()) {
    labels[label] = {
      running: count(usage.running, label),
      runsToday: count(usage.runsToday, label),
    };
  }
  return Object.keys(labels).length === 0 ? undefined : { day: usage.day, labels };
}
