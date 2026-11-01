import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { type Board, loadBoard, saveBoard, transition } from './board.js';
import { acquireStateLock, writeStateFile } from './paths.js';
import type { Ports } from './ports.js';
import { readCrewRecords } from './state.js';

export type LimitKind = 'session' | 'weekly';
export interface DetectedLimit {
  kind: LimitKind;
  /** Raw text or value of the reset; `parkUntil` decides whether it can be used. */
  resetsAt?: string;
}

/** Per label; the file is `<stateRoot>/limits.json` (`.studio/` is committed, the state root is not). */
export interface LabelPark {
  parkedUntil?: string;
  kind?: string;
}
export type Parks = Record<string, LabelPark>;
export type LimitsRead = { ok: true; labels: Parks } | { ok: false };

export const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Labels become object keys: these would reach the prototype instead. */
const RESERVED_LABELS = new Set(['__proto__', 'constructor', 'prototype']);
export const validLabel = (label: string): boolean =>
  LABEL_RE.test(label) && !RESERVED_LABELS.has(label);

export const DEFAULT_LABEL = 'default';

const HOUR_MS = 3_600_000;
/** A weekly limit is the longest there is: a later "reset" is not believed. */
const MAX_PARK_MS = 8 * 24 * HOUR_MS;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 1024 * 1024;
const LOCK_STALE_MS = 5 * 60_000;
const MAX_RESET_CHARS = 100;

/** `You've hit your <words> limit`: "limit" alone, or up to five words before it. */
const LIMIT_HEAD = /^You['’]ve hit your (?:([\p{L}\p{N}.-]+(?: [\p{L}\p{N}.-]+){0,4}) )?limit$/u;
const RESET_SEGMENT = /^resets\s+(\S.*)$/u;
/** One line of text; `.` stops at every line terminator. */
const SEGMENT = /^.+$/u;

/** The whole string must be the head plus optional ` · ` segments; the first `resets …` counts. */
function matchLimitText(text: unknown): DetectedLimit | undefined {
  if (typeof text !== 'string') return undefined;
  const [head = '', ...segments] = text.split('·');
  const m = LIMIT_HEAD.exec(head.trimEnd());
  if (!m) return undefined;
  let reset: string | undefined;
  for (const raw of segments) {
    const segment = raw.trim();
    if (!SEGMENT.test(segment)) return undefined;
    reset ??= RESET_SEGMENT.exec(segment)?.[1];
  }
  const kind: LimitKind = m[1] === 'weekly' ? 'weekly' : 'session';
  const resetsAt = reset?.replace(/\p{Cc}/gu, ' ').slice(0, MAX_RESET_CHARS);
  return { kind, ...(resetsAt ? { resetsAt } : {}) };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Finds a usage limit in one line of a crew log. Crew tool output is untrusted and also lands in
 * this log, so only events Claude Code itself emits count: a top-level `system`/`api_retry` event
 * with `error:"rate_limit"`, or the limit text as the whole error text of a failed `result` event
 * or of an assistant message flagged as an API error. A `result` with `is_error` unset is the
 * model's final answer, so its text does not count. A non-JSON line matches only when the line is
 * the limit text from its first character on.
 */
export function detectLimit(logLine: string): DetectedLimit | undefined {
  const line = logLine.trimEnd();
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return line.startsWith('{') ? undefined : matchLimitText(line);
  }
  if (!isObject(ev)) return undefined;
  if (ev.type === 'system') {
    if (ev.subtype !== 'api_retry' || ev.error !== 'rate_limit') return undefined;
    const reset = ev.resets_at ?? ev.resetsAt;
    const raw = typeof reset === 'string' || typeof reset === 'number' ? String(reset) : undefined;
    return {
      kind: 'session',
      ...(raw ? { resetsAt: raw.slice(0, MAX_RESET_CHARS) } : {}),
    };
  }
  if (ev.type === 'result') {
    return (
      matchLimitText(ev.error) ?? (ev.is_error === true ? matchLimitText(ev.result) : undefined)
    );
  }
  if (ev.type === 'assistant' && (ev.isApiErrorMessage === true || typeof ev.error === 'string')) {
    const content = isObject(ev.message) ? ev.message.content : undefined;
    if (!Array.isArray(content)) return undefined;
    for (const block of content) {
      if (isObject(block) && block.type === 'text') {
        const hit = matchLimitText(block.text);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Until when a label stays parked. Only an absolute time counts (ISO with an offset, or an epoch in
 * seconds or milliseconds); local-time phrases such as "3pm" are not guessed, and a time in the past
 * or more than 8 days ahead is not believed. Everything else: one hour from now, then retry.
 */
export function parkUntil(resetsAt: string | undefined, now: Date): Date {
  const fallback = new Date(now.getTime() + HOUR_MS);
  if (resetsAt === undefined) return fallback;
  let t = Number.NaN;
  if (ISO_TIME.test(resetsAt)) t = Date.parse(resetsAt);
  else if (/^\d{10}$/.test(resetsAt)) t = Number(resetsAt) * 1000;
  else if (/^\d{13}$/.test(resetsAt)) t = Number(resetsAt);
  if (Number.isNaN(t) || t <= now.getTime() || t > now.getTime() + MAX_PARK_MS) return fallback;
  return new Date(t);
}

const limitsFile = (stateRoot: string): string => join(stateRoot, 'limits.json');

/** Fails closed: anything but a well-formed plain file reads as `{ ok: false }` (all parked). */
export function readLimits(stateRoot: string): LimitsRead {
  const file = limitsFile(stateRoot);
  try {
    if (!lstatSync(file).isFile()) return { ok: false };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: true, labels: {} }
      : { ok: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false };
  }
  if (!isObject(raw)) return { ok: false };
  const labels: Parks = {};
  for (const [label, park] of Object.entries(raw)) {
    if (!validLabel(label) || !isObject(park)) return { ok: false };
    const { parkedUntil, kind, ...rest } = park;
    if (Object.keys(rest).length > 0) return { ok: false };
    if (parkedUntil !== undefined) {
      if (typeof parkedUntil !== 'string' || Number.isNaN(Date.parse(parkedUntil))) {
        return { ok: false };
      }
    }
    if (kind !== undefined && typeof kind !== 'string') return { ok: false };
    labels[label] = {
      ...(parkedUntil === undefined ? {} : { parkedUntil }),
      ...(kind === undefined ? {} : { kind }),
    };
  }
  return { ok: true, labels };
}

export function writeLimits(stateRoot: string, labels: Parks): void {
  writeStateFile(stateRoot, limitsFile(stateRoot), `${JSON.stringify(labels, null, 2)}\n`);
}

/** The labels still parked at `now`. */
export function activeParks(labels: Parks, now: Date): Parks {
  return Object.fromEntries(
    Object.entries(labels).filter(
      ([, p]) => p.parkedUntil !== undefined && Date.parse(p.parkedUntil) > now.getTime(),
    ),
  );
}

/** Earliest `parkedUntil` as written in the file; undefined when nothing is parked. */
export function earliestReset(parks: Parks): string | undefined {
  let best: string | undefined;
  for (const p of Object.values(parks)) {
    if (p.parkedUntil === undefined) continue;
    if (best === undefined || Date.parse(p.parkedUntil) < Date.parse(best)) best = p.parkedUntil;
  }
  return best;
}

/** Reads `[from, from + max)` of a plain log file; a symlink or a missing file reads as undefined. */
function readRange(
  file: string,
  pick: (size: number) => { start: number; length: number },
): { text: string; start: number } | undefined {
  try {
    if (!lstatSync(file).isFile()) return undefined;
    const fd = openSync(file, 'r');
    try {
      const { start, length } = pick(fstatSync(fd).size);
      if (length <= 0) return undefined;
      const buf = Buffer.alloc(length);
      const got = readSync(fd, buf, 0, length, start);
      return { text: buf.toString('utf8', 0, got), start };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const logFile = (stateRoot: string, id: string): string => join(stateRoot, 'logs', `${id}.jsonl`);

/** A scan result; `retryOnly` means an unrecovered `rate_limit` retry, no terminal limit text. */
export interface ScannedLimit extends DetectedLimit {
  retryOnly?: true;
}

function parsedEvent(line: string): Record<string, unknown> | undefined {
  try {
    const ev: unknown = JSON.parse(line);
    return isObject(ev) ? ev : undefined;
  } catch {
    return undefined;
  }
}

/** A later event like this shows the API call behind an earlier retry succeeded. */
function showsRecovery(ev: Record<string, unknown> | undefined): boolean {
  if (ev?.type === 'assistant') return ev.isApiErrorMessage !== true && ev.error === undefined;
  if (ev?.type === 'result') return ev.is_error !== true;
  return false;
}

/**
 * Walks the bounded tail of an item's log from the end, from byte `from` on (the log is appended
 * across runs; `from` is where this run began). Terminal limit text counts at once. A `rate_limit`
 * retry is transient unless proven otherwise: it counts only with no later successful `assistant`
 * or `result` event, and then as `retryOnly`. When the tail starts inside the file, its first line
 * is torn and dropped: it could begin in the middle of crew output.
 */
export function scanLogForLimit(
  stateRoot: string,
  id: string,
  from: number,
): ScannedLimit | undefined {
  const range = readRange(logFile(stateRoot, id), (size) => {
    const start = Math.max(from, size - TAIL_BYTES, 0);
    return { start, length: size - start };
  });
  if (!range) return undefined;
  const lines = range.text.split('\n');
  if (range.start > from) lines.shift();
  let recovered = false;
  let retry: ScannedLimit | undefined;
  for (const line of lines.reverse()) {
    const hit = detectLimit(line);
    const ev = parsedEvent(line);
    if (hit) {
      // Keep walking after a retry: terminal text further back still wins.
      if (ev?.type !== 'system') return hit;
      if (!recovered) retry ??= { ...hit, retryOnly: true };
    } else if (showsRecovery(ev)) recovered = true;
  }
  return retry;
}

/** A session id goes into argv: nothing that could read as an option or carry odd characters. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Session id of a run: first top-level `system` event from byte `from` on, read bounded. */
export function sessionIdSince(stateRoot: string, id: string, from: number): string | undefined {
  const range = readRange(logFile(stateRoot, id), (size) => ({
    start: Math.min(from, size),
    length: Math.min(HEAD_BYTES, size - Math.min(from, size)),
  }));
  if (!range) return undefined;
  for (const line of range.text.split('\n')) {
    try {
      const ev = JSON.parse(line) as { type?: unknown; session_id?: unknown } | null;
      if (ev?.type === 'system' && typeof ev.session_id === 'string') {
        return SESSION_ID.test(ev.session_id) ? ev.session_id : undefined;
      }
    } catch {
      // not a JSON line (stderr noise)
    }
  }
  return undefined;
}

/** A report in the clone: launch removed older ones, so this run wrote it. Read by lstat only. */
function hasReport(stateRoot: string, id: string): boolean {
  try {
    return lstatSync(join(stateRoot, 'clones', id, '.studio', 'reports', `${id}.md`)).isFile();
  } catch {
    return false;
  }
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export interface ReconcileResult {
  stopped: { item: string; label: string; kind: LimitKind; parkedUntil: string }[];
  errors: string[];
}

const ACTIVE = new Set(['assigned', 'in_progress']);

function backToReady(project: string, id: string, note: string, now: Date, by: string): void {
  const fresh = loadBoard(project);
  const moved: Board = transition(fresh, id, 'ready', by, now);
  saveBoard(project, {
    ...moved,
    items: moved.items.map((i) => (i.id === id ? { ...i, notes: [...(i.notes ?? []), note] } : i)),
  });
}

/**
 * Applies what the crew logs say; runs at the start of `status`, `plan`, `launch` and `state`.
 * Parked labels past `parkedUntil` clear themselves. For every crew on an active item: a limit event
 * of its current run stops the run, parks the label and returns the item to `ready` with a note;
 * clone and branch stay. Each step is safe to repeat, and the record's `limit` makes the whole thing
 * idempotent: it survives a crash between the steps, and an old log line never parks a later run.
 * A retry stops nothing while the crew lives; an exited crew counts an unrecovered one as a limit.
 * A crew that already exited counts too (`claude -p` ends on a limit), unless it left a report; then
 * the run finished after all and `collect` takes it. Writes nothing in a state root without crew
 * records or limits, so a plan never creates one.
 */
export async function reconcileLimits(o: {
  project: string;
  stateRoot: string;
  ports: Ports;
}): Promise<ReconcileResult> {
  const { project, stateRoot, ports } = o;
  const result: ReconcileResult = { stopped: [], errors: [] };
  const crewFile = join(stateRoot, 'crew.json');
  if (!exists(crewFile) && !exists(limitsFile(stateRoot))) return result;
  const now = ports.clock.now();
  const limits = readLimits(stateRoot);
  if (!limits.ok) {
    result.errors.push(
      `${limitsFile(stateRoot)} is unreadable: all crew credentials count as parked until it is fixed or removed`,
    );
    return result;
  }
  const lock = acquireStateLock(stateRoot, 'limits.lock', { now, heartbeatStaleMs: LOCK_STALE_MS });
  if (!lock) return result; // another process is reconciling right now
  try {
    let labels = limits.labels;
    const kept = activeParks(labels, now);
    if (Object.keys(kept).length !== Object.keys(labels).length) {
      writeLimits(stateRoot, kept);
      labels = kept;
    }
    const records = readCrewRecords(stateRoot);
    const board = loadBoard(project);
    for (const [id, rec] of Object.entries(records)) {
      const status = board.items.find((i) => i.id === id)?.status;
      if (status === undefined || !ACTIVE.has(status)) continue;
      const label = rec.label ?? DEFAULT_LABEL;
      if (rec.limit) {
        // A crash left the board behind; finish the move.
        const note = `usage limit (${rec.limit.kind}) on ${label}: run stopped, clone and branch kept`;
        backToReady(project, id, note, now, 'studio');
        continue;
      }
      if (rec.stoppedAt !== undefined) continue;
      const hit = scanLogForLimit(stateRoot, id, rec.logStart ?? 0);
      if (!hit) continue;
      // A negative pid would signal a whole process group, -1 everything the owner runs.
      if (!Number.isInteger(rec.pid) || rec.pid <= 0) {
        result.errors.push(`crew record for ${id} has no valid pid; not stopping it`);
        continue;
      }
      const alive = ports.claude.alive(rec.pid);
      // A live crew may still recover from a retry: only terminal limit text stops it.
      if (alive && hit.retryOnly) continue;
      if (!alive && hasReport(stateRoot, id)) continue;
      const until = parkUntil(hit.resetsAt, now).toISOString();
      const earlier = labels[label]?.parkedUntil;
      const parkedUntil = earlier && Date.parse(earlier) > Date.parse(until) ? earlier : until;
      labels = { ...labels, [label]: { parkedUntil, kind: hit.kind } };
      writeLimits(stateRoot, labels);
      if (alive) await ports.claude.stop(rec.pid);
      const sessionId = sessionIdSince(stateRoot, id, rec.logStart ?? 0);
      const latest = readCrewRecords(stateRoot);
      latest[id] = {
        ...(latest[id] ?? rec),
        stoppedAt: now.toISOString(),
        limit: {
          at: now.toISOString(),
          kind: hit.kind,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
      };
      writeStateFile(stateRoot, crewFile, `${JSON.stringify(latest, null, 2)}\n`);
      backToReady(
        project,
        id,
        `usage limit (${hit.kind}) on ${label}: run stopped until ${parkedUntil}, clone and branch kept`,
        now,
        'studio',
      );
      result.stopped.push({ item: id, label, kind: hit.kind, parkedUntil });
    }
  } finally {
    lock.release();
  }
  return result;
}
