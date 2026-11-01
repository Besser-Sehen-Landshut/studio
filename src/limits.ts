import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { type Board, loadBoard, saveBoard, transition } from './board.js';
import type { CrewRecord } from './crew.js';
import {
  acquireStateLock,
  ownerFileHeld,
  projectStateRoots,
  type StateLock,
  stateDirName,
  writeStateFile,
} from './paths.js';
import type { Ports } from './ports.js';
import { readCrewRecords } from './state.js';

export type LimitKind = 'session' | 'weekly';
export interface DetectedLimit {
  kind: LimitKind;
  /** Raw text or value of the reset; `parkUntil` decides whether it can be used. */
  resetsAt?: string;
}

/** Per label; the file is `<ownerRoot>/limits.json`, shared by all projects of the owner. */
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
  const kind: LimitKind = /\bweekly\b/i.test(m[1] ?? '') ? 'weekly' : 'session';
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

const limitsFile = (ownerRoot: string): string => join(ownerRoot, 'limits.json');

/** Fails closed: anything but a well-formed plain file reads as `{ ok: false }` (all parked). */
export function readLimits(ownerRoot: string): LimitsRead {
  if (ownerFileHeld(ownerRoot, 'limits.json')) return { ok: false };
  return readLimitsFile(limitsFile(ownerRoot));
}

/** One limits file by its path, strictly; the migration reads old project files with this. */
export function readLimitsFile(file: string): LimitsRead {
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

export function writeLimits(ownerRoot: string, labels: Parks): void {
  writeStateFile(ownerRoot, limitsFile(ownerRoot), `${JSON.stringify(labels, null, 2)}\n`);
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
 * the run finished after all and `collect` takes it. Writes nothing without crew records or limits,
 * so a plan never creates a root. Parks are per label and owner-wide; a park here stops only this
 * project's crew, a crew of another project on that label hits the limit itself.
 */
export async function reconcileLimits(o: {
  project: string;
  stateRoot: string;
  ownerRoot: string;
  ports: Ports;
}): Promise<ReconcileResult> {
  const { project, stateRoot, ownerRoot, ports } = o;
  const result: ReconcileResult = { stopped: [], errors: [] };
  const crewFile = join(stateRoot, 'crew.json');
  if (!exists(crewFile) && !exists(limitsFile(ownerRoot))) return result;
  const now = ports.clock.now();
  const unreadable = () =>
    result.errors.push(
      `${limitsFile(ownerRoot)} is unreadable: all crew credentials count as parked until it is fixed or removed`,
    );
  if (!readLimits(ownerRoot).ok) {
    unreadable();
    return result;
  }
  const lock = acquireStateLock(ownerRoot, 'limits.lock', { now, heartbeatStaleMs: LOCK_STALE_MS });
  if (!lock) return result; // another process is reconciling right now
  try {
    // Read under the lock: another project may have parked a label a moment ago.
    const limits = readLimits(ownerRoot);
    if (!limits.ok) {
      unreadable();
      return result;
    }
    let labels = limits.labels;
    const kept = activeParks(labels, now);
    if (Object.keys(kept).length !== Object.keys(labels).length) {
      writeLimits(ownerRoot, kept);
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
      // Another process on this pid means the crew is gone, so it counts as exited.
      const process = alive ? await crewProcess(rec, ports) : 'dead';
      if (process === 'gone' && hasReport(stateRoot, id)) continue;
      const until = parkUntil(hit.resetsAt, now).toISOString();
      const earlier = labels[label]?.parkedUntil;
      const parkedUntil =
        earlier && (process === 'unknown' || Date.parse(earlier) > Date.parse(until))
          ? earlier
          : until;
      labels = { ...labels, [label]: { parkedUntil, kind: hit.kind } };
      writeLimits(ownerRoot, labels);
      if (process === 'unknown') {
        // The label stays parked; record and board wait until the crew can be told apart or exits.
        result.errors.push(
          `crew ${id} (pid ${rec.pid}) hit a usage limit but its identity cannot be verified; not stopping it, check it by hand`,
        );
        continue;
      }
      if (process === 'verified') await ports.claude.stop(rec.pid);
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

/** One account block; the file is `<ownerRoot>/blocks.json`. `reason` is a code of ours, see below. */
export interface AccountBlock {
  label: string;
  reason: string;
  at: string;
}
export type BlocksRead = { ok: true; blocks: AccountBlock[] } | { ok: false };
export interface DetectedBlock {
  reason: string;
}

/** `error` categories of `api_retry` and assistant events; `billing_error` and `rate_limit` are not blocks. */
const BLOCK_CATEGORIES = new Map([
  ['authentication_failed', 'authentication_failed'],
  ['oauth_org_not_allowed', 'organization_not_allowed'],
  ['account_on_hold', 'account_on_hold'],
]);

const MAX_BLOCK_TEXT = 500;
const API_ERROR_PREFIX = /^API Error: \d{3} /;
/** Each anchored at the start of the text. The reason is always our code, never text from the log. */
const BLOCK_TEXTS: readonly [RegExp, string][] = [
  [/^Failed to authenticate\b/, 'authentication_failed'],
  [/^Login expired · Please run \/login\b/, 'authentication_failed'],
  [/^OAuth token (?:revoked|has expired)\b/, 'authentication_failed'],
  [/^Your account does not have access to Claude\b/, 'authentication_failed'],
  [/^Your account is on hold and can['’]t\b/, 'account_on_hold'],
  [/^This organization has been disabled\b/, 'organization_disabled'],
  [/^Your ANTHROPIC_API_KEY belongs to a disabled organization\b/, 'organization_disabled'],
  [/^Your organization has disabled Claude subscription access\b/, 'organization_disabled'],
  [
    /^Claude Code is unable to respond to this request, which appears to violate our Usage Policy\b/,
    'policy_violation',
  ],
  [
    /^(?:Your|This) account (?:has been|is|was) (?:disabled|suspended|banned)\b/,
    'account_disabled',
  ],
];
/** The same organization message when the API error body is printed as JSON. */
const ORG_DISABLED_BODY = /^\{[^\n]*"message":\s*"This organization has been disabled\b/;

function matchBlockText(text: unknown): DetectedBlock | undefined {
  if (typeof text !== 'string' || text.length > MAX_BLOCK_TEXT) return undefined;
  const bare = text.replace(API_ERROR_PREFIX, '');
  if (bare !== text && ORG_DISABLED_BODY.test(bare)) return { reason: 'organization_disabled' };
  for (const [re, reason] of BLOCK_TEXTS) {
    if (re.test(bare)) return { reason };
  }
  return undefined;
}

function matchBlockCategory(error: unknown): DetectedBlock | undefined {
  const reason = typeof error === 'string' ? BLOCK_CATEGORIES.get(error) : undefined;
  return reason === undefined ? undefined : { reason };
}

/**
 * Finds an account block in one line of a crew log, in the positions `detectLimit` trusts: crew tool
 * output also lands in this log, so a `tool_result`, an unflagged assistant text or a `result`
 * without an error never count.
 */
export function detectBlock(logLine: string): DetectedBlock | undefined {
  const line = logLine.trimEnd();
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return line.startsWith('{') ? undefined : matchBlockText(line);
  }
  if (!isObject(ev)) return undefined;
  if (ev.type === 'system') {
    return ev.subtype === 'api_retry' ? matchBlockCategory(ev.error) : undefined;
  }
  if (ev.type === 'result') {
    return (
      matchBlockCategory(ev.error) ??
      matchBlockText(ev.error) ??
      (ev.is_error === true ? matchBlockText(ev.result) : undefined)
    );
  }
  if (ev.type === 'assistant') {
    const category = matchBlockCategory(ev.error);
    if (category) return category;
    if (ev.isApiErrorMessage !== true && typeof ev.error !== 'string') return undefined;
    const content = isObject(ev.message) ? ev.message.content : undefined;
    if (!Array.isArray(content)) return undefined;
    for (const block of content) {
      if (isObject(block) && block.type === 'text') {
        const hit = matchBlockText(block.text);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

/**
 * Walks the bounded tail of an item's log from the end, from byte `from` on, as `scanLogForLimit`
 * does. A terminal event counts at once; a retry with a block category counts unless a later
 * successful event shows the run recovered.
 */
export function scanLogForBlock(
  stateRoot: string,
  id: string,
  from: number,
): DetectedBlock | undefined {
  const range = readRange(logFile(stateRoot, id), (size) => {
    const start = Math.max(from, size - TAIL_BYTES, 0);
    return { start, length: size - start };
  });
  if (!range) return undefined;
  const lines = range.text.split('\n');
  if (range.start > from) lines.shift();
  let recovered = false;
  let retry: DetectedBlock | undefined;
  for (const line of lines.reverse()) {
    const hit = detectBlock(line);
    const ev = parsedEvent(line);
    if (hit) {
      if (ev?.type !== 'system') return hit;
      if (!recovered) retry ??= hit;
    } else if (showsRecovery(ev)) recovered = true;
  }
  return retry;
}

const blocksFile = (ownerRoot: string): string => join(ownerRoot, 'blocks.json');
const BLOCK_REASON = /^[a-z_]{1,64}$/;

function parseBlock(raw: unknown): AccountBlock | undefined {
  if (!isObject(raw) || Object.keys(raw).length !== 3) return undefined;
  const { label, reason, at } = raw;
  if (typeof label !== 'string' || !validLabel(label)) return undefined;
  if (typeof reason !== 'string' || !BLOCK_REASON.test(reason)) return undefined;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  return { label, reason, at };
}

/** Fails closed: only a missing file means no block; anything else malformed reads as `{ ok: false }`. */
export function readBlocks(ownerRoot: string): BlocksRead {
  if (ownerFileHeld(ownerRoot, 'blocks.json')) return { ok: false };
  return readBlocksFile(blocksFile(ownerRoot));
}

/** One blocks file by its path, strictly; the migration reads old project files with this. */
export function readBlocksFile(file: string): BlocksRead {
  try {
    if (!lstatSync(file).isFile()) return { ok: false };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: true, blocks: [] }
      : { ok: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(raw)) return { ok: false };
  const blocks: AccountBlock[] = [];
  for (const entry of raw) {
    const block = parseBlock(entry);
    if (!block) return { ok: false };
    blocks.push(block);
  }
  return { ok: true, blocks };
}

export function writeBlocks(ownerRoot: string, blocks: AccountBlock[]): void {
  writeStateFile(ownerRoot, blocksFile(ownerRoot), `${JSON.stringify(blocks, null, 2)}\n`);
}

/** The one line for the owner; undefined when nothing is blocked. */
export function blockLine(read: BlocksRead): string | undefined {
  if (!read.ok) {
    return 'account block state is unreadable (blocks.json): all crew stopped, no crew starts until the owner inspects or removes the file';
  }
  if (read.blocks.length === 0) return undefined;
  const labels = [...new Set(read.blocks.map((b) => b.label))].join(', ');
  return `account block on ${labels}: all crew stopped, no crew starts until the owner runs studio accounts-clear <label>`;
}

export const blockHold = (ownerRoot: string): string | undefined =>
  blockLine(readBlocks(ownerRoot));

export interface BlockReconcileResult {
  /** `root` is set for a crew stopped in another project. */
  stopped: { item: string; label: string; reason: string; root?: string }[];
  errors: string[];
  /** Another process holds the reconcile lock: nothing was checked, so a launch must refuse. */
  lockFailed: boolean;
}

/**
 * Active items of records marked `block` go back to `ready`; also finishes after a crash. An item
 * with a report stays active: `collect` takes it, and a later launch would delete the report.
 */
function moveBlockedToReady(
  project: string,
  stateRoot: string,
  now: Date,
  result: BlockReconcileResult,
): void {
  try {
    for (const [id, rec] of Object.entries(readCrewRecords(stateRoot))) {
      if (rec.block === undefined) continue;
      const status = loadBoard(project).items.find((i) => i.id === id)?.status;
      if (status === undefined || !ACTIVE.has(status) || hasReport(stateRoot, id)) continue;
      const label = rec.label ?? DEFAULT_LABEL;
      const note = `account block (${rec.block.reason}): run on ${label} stopped, clone and branch kept`;
      backToReady(project, id, note, now, 'studio');
    }
  } catch (e) {
    result.errors.push(`board not updated after an account block: ${(e as Error).message}`);
  }
}

const FINISHED = new Set(['merged', 'dropped']);

/** Size of a plain log file; undefined for a missing one or anything else. */
function logEnd(stateRoot: string, id: string): number | undefined {
  try {
    const st = lstatSync(logFile(stateRoot, id));
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

type CrewProcess = 'invalid' | 'dead' | 'verified' | 'unknown' | 'gone';

/**
 * What lies behind a record's pid. Only `verified` may be signalled: the pid is alive and has the
 * start time stored at launch. `gone`: another process holds the pid now. `unknown`: alive, but
 * there is no stored identity or it cannot be read.
 */
async function crewProcess(rec: CrewRecord, ports: Ports): Promise<CrewProcess> {
  // A negative pid would signal a whole process group, -1 everything the owner runs.
  if (!Number.isInteger(rec.pid) || rec.pid <= 0) return 'invalid';
  if (!ports.claude.alive(rec.pid)) return 'dead';
  if (rec.identity === undefined) return 'unknown';
  const current = await ports.claude.identity(rec.pid);
  if (current === undefined) return 'unknown';
  return current === rec.identity ? 'verified' : 'gone';
}

/**
 * The board of another project, read only: from the project path in its `marker.json`, which must
 * lead back to this state root. Undefined when anything is off: every record is then in scope.
 */
function boardOfRoot(root: string): Board | undefined {
  try {
    const file = join(root, 'marker.json');
    if (!lstatSync(file).isFile()) return undefined;
    const marker: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const project = isObject(marker) ? marker.projectRealpath : undefined;
    if (typeof project !== 'string' || !isAbsolute(project)) return undefined;
    if (stateDirName(project) !== basename(root)) return undefined;
    return loadBoard(project);
  } catch {
    return undefined;
  }
}

/**
 * Applies account blocks; runs before `reconcileLimits` and depends on neither `limits.json` nor the
 * board. Every event of a current run is recorded in `blocks.json` first, then the crews stop, so a
 * crash leaves the state blocked. While any block exists or the file is unreadable, every reconcile
 * stops every live crew of all labels, except on `merged` and `dropped` items, and only after its
 * process identity matches: safe to repeat, and a crash mid-stop heals. A live crew it cannot verify
 * is reported, not signalled. A new entry comes from a live crew in any unfinished status, verified
 * or not, an invalid pid included, or from an exited crew on an active item (any item when the board
 * is unreadable). A clear moves `logStart`, so an unmarked record does not raise an old event again. Records get `stoppedAt` and `block`,
 * no `limit`, so nothing resumes by itself and a cleared event does not trigger again. A report does
 * not excuse a block event: an account problem outranks a finished run, but the work stays
 * collectable. A hit found while the file is unreadable stays unmarked, so it is recorded once the
 * owner fixed the file.
 *
 * Blocks are owner-wide. This function does one project root under the blocks lock: it scans the
 * crews, records new hits in the owner file, stops verified live crews and marks their records. It
 * moves nothing on a board; see `reconcileBlocks` for the sweep over other projects.
 */
async function stopCrewsOf(o: {
  root: string;
  board: Board | undefined;
  other: boolean;
  ownerRoot: string;
  ports: Ports;
  lock: StateLock;
  at: string;
  result: BlockReconcileResult;
}): Promise<void> {
  const { root, board, other, ownerRoot, ports, lock, at, result } = o;
  const crewFile = join(root, 'crew.json');
  const where = other ? ` in ${root}` : '';
  const statusOf = (id: string) => board?.items.find((i) => i.id === id)?.status;
  const records = Object.fromEntries(
    Object.entries(readCrewRecords(root)).filter(([id]) => {
      const status = statusOf(id);
      return status === undefined || !FINISHED.has(status);
    }),
  );
  const hits = new Map<string, DetectedBlock>();
  for (const [id, rec] of Object.entries(records)) {
    if (rec.stoppedAt !== undefined) continue;
    // The old log of a long-finished crew raises no block.
    const status = statusOf(id);
    const process = await crewProcess(rec, ports);
    const exitedActive =
      (process === 'dead' || process === 'gone') &&
      (board === undefined || (status !== undefined && ACTIVE.has(status)));
    const unproven = process === 'invalid' || process === 'unknown';
    if (process !== 'verified' && !exitedActive && !unproven) continue;
    const hit = scanLogForBlock(root, id, rec.logStart ?? 0);
    if (!hit) continue;
    // Fails closed also for a crew that cannot be verified; the stop below reports it unsignalled.
    hits.set(id, hit);
  }
  const read = readBlocks(ownerRoot);
  if (read.ok) {
    const known = [...read.blocks];
    for (const [id, hit] of hits) {
      const raw = records[id]?.label ?? DEFAULT_LABEL;
      const label = validLabel(raw) ? raw : DEFAULT_LABEL;
      if (!known.some((b) => b.label === label && b.reason === hit.reason)) {
        known.push({ label, reason: hit.reason, at });
      }
    }
    if (known.length !== read.blocks.length) writeBlocks(ownerRoot, known);
    read.blocks = known;
  } else {
    const line = `${blocksFile(ownerRoot)} is unreadable: all crew stopped and no crew starts until the owner inspects or removes the file`;
    if (!result.errors.includes(line)) result.errors.push(line);
  }
  const firstReason = read.ok ? read.blocks[0]?.reason : 'state_unreadable';
  if (firstReason !== undefined) {
    for (const [id, rec] of Object.entries(records)) {
      if (rec.stoppedAt !== undefined) continue;
      const hit = hits.get(id);
      // Read right before the signal, every time.
      const process = await crewProcess(rec, ports);
      if (process === 'invalid') {
        result.errors.push(`crew record for ${id}${where} has no valid pid; not stopping it`);
        continue;
      }
      if (process === 'unknown') {
        result.errors.push(
          `crew ${id}${where} (pid ${rec.pid}) is alive but its identity cannot be verified; not stopping it, check it by hand`,
        );
        continue;
      }
      if (hit === undefined && process === 'dead') continue;
      if (hit === undefined && process === 'gone') {
        const latest = readCrewRecords(root);
        latest[id] = { ...(latest[id] ?? rec), stoppedAt: at, processGone: at };
        writeStateFile(root, crewFile, `${JSON.stringify(latest, null, 2)}\n`);
        continue;
      }
      if (process === 'verified') {
        try {
          await ports.claude.stop(rec.pid);
        } catch {
          // Not marked: the next reconcile tries again, and launches stay refused meanwhile.
          result.errors.push(`could not stop crew ${id}${where} (pid ${rec.pid})`);
          continue;
        }
        lock.heartbeat(ports.clock.now());
        result.stopped.push({
          item: id,
          label: rec.label ?? DEFAULT_LABEL,
          reason: hit?.reason ?? firstReason,
          ...(other ? { root } : {}),
        });
      }
      if (!read.ok && hit !== undefined) continue;
      const latest = readCrewRecords(root);
      latest[id] = {
        ...(latest[id] ?? rec),
        stoppedAt: at,
        block: { at, reason: hit?.reason ?? firstReason },
      };
      writeStateFile(root, crewFile, `${JSON.stringify(latest, null, 2)}\n`);
    }
  }
}

/**
 * Applies account blocks to this project (see `stopCrewsOf`), then, while a block exists or the file
 * is unreadable, runs the same stop phase for every other project root under the same lock. It reads
 * another project's board from its marker, read only, and never saves it; that project's next own
 * reconcile moves its items back to `ready` from the `block` mark. Without a block each project scans
 * only itself. A root that cannot be read is reported and the others still get stopped; an unreadable
 * record file of this project still throws, after the sweep.
 */
export async function reconcileBlocks(o: {
  project: string;
  stateRoot: string;
  ownerRoot: string;
  ports: Ports;
}): Promise<BlockReconcileResult> {
  const { project, stateRoot, ownerRoot, ports } = o;
  const result: BlockReconcileResult = { stopped: [], errors: [], lockFailed: false };
  const first = readBlocks(ownerRoot);
  if (first.ok && first.blocks.length === 0 && !exists(join(stateRoot, 'crew.json'))) return result;
  const now = ports.clock.now();
  const lock = acquireStateLock(ownerRoot, 'blocks.lock', { now, heartbeatStaleMs: LOCK_STALE_MS });
  if (!lock) {
    result.lockFailed = true;
    return result;
  }
  try {
    // The stop does not depend on the board: without one every record is in scope, and the board
    // moves wait until it reads again.
    let board: Board | undefined;
    try {
      board = loadBoard(project);
    } catch (e) {
      result.errors.push(
        `board is unreadable, so every crew record is in scope: ${(e as Error).message}`,
      );
    }
    const phase = { ownerRoot, ports, lock, at: now.toISOString(), result };
    let ownFailure: { error: unknown } | undefined;
    try {
      await stopCrewsOf({ ...phase, root: stateRoot, board, other: false });
    } catch (error) {
      ownFailure = { error };
    }
    const after = readBlocks(ownerRoot);
    if (!after.ok || after.blocks.length > 0) {
      for (const root of projectStateRoots(dirname(ownerRoot))) {
        if (resolve(root) === resolve(stateRoot) || !exists(join(root, 'crew.json'))) continue;
        try {
          await stopCrewsOf({ ...phase, root, board: boardOfRoot(root), other: true });
        } catch (e) {
          result.errors.push(`crews in ${root} were not checked: ${(e as Error).message}`);
        }
        lock.heartbeat(ports.clock.now());
      }
    }
    if (ownFailure) throw ownFailure.error;
    if (board !== undefined) moveBlockedToReady(project, stateRoot, now, result);
  } finally {
    lock.release();
  }
  return result;
}

/**
 * Removes the entries of one label and moves `logStart` of that label's records, in every project
 * root, to the end of their logs, so an old event cannot raise the block again and a new one can;
 * restarts nothing. Throws, writing nothing, when a state file is unreadable or another process
 * holds the lock.
 */
export function clearBlocks(
  ownerRoot: string,
  label: string,
  now: Date,
): { removed: number; remaining: number } {
  const unreadable = `${blocksFile(ownerRoot)} is unreadable; nothing cleared: inspect or remove the file`;
  if (!readBlocks(ownerRoot).ok) throw new Error(unreadable);
  const lock = acquireStateLock(ownerRoot, 'blocks.lock', { now, heartbeatStaleMs: LOCK_STALE_MS });
  if (!lock) throw new Error('another Studio process is reconciling; nothing cleared, try again');
  try {
    const read = readBlocks(ownerRoot);
    if (!read.ok) throw new Error(unreadable);
    const kept = read.blocks.filter((b) => b.label !== label);
    const removed = read.blocks.length - kept.length;
    // Every record file is read first: one unreadable file refuses before anything is written.
    const roots = projectStateRoots(dirname(ownerRoot)).map((root) => ({
      root,
      records: readCrewRecords(root),
    }));
    // Logs first: a crash in between leaves the block in place, never an old event ready to return.
    for (const { root, records } of roots) {
      let moved = false;
      for (const [id, rec] of Object.entries(records)) {
        if ((rec.label ?? DEFAULT_LABEL) !== label) continue;
        const end = logEnd(root, id);
        if (end !== undefined && end !== rec.logStart) {
          records[id] = { ...rec, logStart: end };
          moved = true;
        }
      }
      if (moved) {
        const crewFile = join(root, 'crew.json');
        writeStateFile(root, crewFile, `${JSON.stringify(records, null, 2)}\n`);
      }
    }
    if (removed > 0) writeBlocks(ownerRoot, kept);
    return { removed, remaining: kept.length };
  } finally {
    lock.release();
  }
}
