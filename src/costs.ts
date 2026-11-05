import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Board, WorkItem } from './board.js';
import type { OwnerConfig, StudioConfig } from './config.js';
import { crewProcess } from './limits.js';
import {
  acquireStateLock,
  assertStatePath,
  projectStateRoots,
  type StateLock,
  writeStateFile,
} from './paths.js';
import type { Ports } from './ports.js';
import { readCrewCaps, reviewTarget } from './review.js';
import { readCrewRecords } from './state.js';
import { dayKey, USAGE_DAYS_KEPT } from './usage.js';

/**
 * What crews cost, read from their stream-json logs. Claude Code ends each `-p` run with one
 * `result` event that carries `total_cost_usd`, `usage` (the main model's tokens) and `modelUsage`
 * (per model, with `costUSD`). Fields are taken as present and summed; anything else is skipped.
 * A run that ended without a result (killed, crashed) is estimated from its `assistant` events.
 */
export interface RunUsage {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  /** Cache reads and cache writes together. */
  tokensCache: number;
  costUsd: number;
  /** Set when a run had no result and its cost is an estimate from its assistant usage. */
  estimated?: true;
}

export const COSTS_FILE = 'costs.json';
export const COSTS_LOCK = 'costs.lock';
/** Longest log Studio reads for costs; a larger one is read from its end. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

export const emptyUsage = (): RunUsage => ({
  runs: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensCache: 0,
  costUsd: 0,
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A count or an amount: finite and not negative, else 0. */
const amount = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

/** Tokens and cost of one `result` event. */
function resultUsage(ev: Record<string, unknown>): Omit<RunUsage, 'runs'> {
  const out = { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0 };
  const models = isObject(ev.modelUsage) ? Object.values(ev.modelUsage).filter(isObject) : [];
  // modelUsage covers every model of the run (subagents included); usage only the main one.
  if (models.length > 0) {
    for (const m of models) {
      out.tokensIn += amount(m.inputTokens);
      out.tokensOut += amount(m.outputTokens);
      out.tokensCache += amount(m.cacheReadInputTokens) + amount(m.cacheCreationInputTokens);
    }
  } else if (isObject(ev.usage)) {
    out.tokensIn = amount(ev.usage.input_tokens);
    out.tokensOut = amount(ev.usage.output_tokens);
    out.tokensCache =
      amount(ev.usage.cache_read_input_tokens) + amount(ev.usage.cache_creation_input_tokens);
  }
  out.costUsd =
    typeof ev.total_cost_usd === 'number'
      ? amount(ev.total_cost_usd)
      : models.reduce((sum, m) => sum + amount(m.costUSD), 0);
  return out;
}

/**
 * Dollars per million tokens for an estimate only, by model family (input, output, cache read,
 * cache write at 1.25 times input), at the first-party API prices of November 2026. A run with a
 * result always uses the cost Claude Code reported. An unknown model gets the highest rates, so an
 * estimate errs high under a cap.
 */
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/haiku/i, [0.1, 0.5, 0.01, 0.125]],
  [/sonnet/i, [2, 10, 0.2, 2.5]],
  [/opus/i, [4, 20, 0.2, 5]],
];
const HIGHEST: [number, number, number, number] = [10, 50, 1, 12.5];

/** The estimated cost of one assistant message's usage. */
function estimate(model: string, u: Record<string, unknown>): number {
  const [inp, out, read, write] = PRICES.find(([re]) => re.test(model))?.[1] ?? HIGHEST;
  return (
    (amount(u.input_tokens) * inp +
      amount(u.output_tokens) * out +
      amount(u.cache_read_input_tokens) * read +
      amount(u.cache_creation_input_tokens) * write) /
    1e6
  );
}

interface Segment {
  init: boolean;
  results: Omit<RunUsage, 'runs'>[];
  /** The last usage per assistant message id: a message streams as several events. */
  assistants: Map<string, { model: string; usage: Record<string, unknown> }>;
}

/**
 * Pure. Sums a stream-json text run by run; a run starts at a `system`/`init` event (without any,
 * each result counts as one run). A run's `result` events give its tokens and cost. A run without
 * one is estimated from the last usage of each of its assistant messages and marked `estimated`.
 */
export function usageFromLog(text: string): RunUsage {
  const segments: Segment[] = [];
  let cur: Segment = { init: false, results: [], assistants: new Map() };
  for (const line of text.split('\n')) {
    // Most lines are tool output: only these kinds are parsed.
    if (!line.includes('"result"') && !line.includes('"init"') && !line.includes('"usage"')) {
      continue;
    }
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(ev)) continue;
    if (ev.type === 'system' && ev.subtype === 'init') {
      segments.push(cur);
      cur = { init: true, results: [], assistants: new Map() };
    } else if (ev.type === 'result') {
      cur.results.push(resultUsage(ev));
    } else if (ev.type === 'assistant' && isObject(ev.message) && isObject(ev.message.usage)) {
      const id = typeof ev.message.id === 'string' ? ev.message.id : `#${cur.assistants.size}`;
      const model = typeof ev.message.model === 'string' ? ev.message.model : '';
      cur.assistants.set(id, { model, usage: ev.message.usage });
    }
  }
  segments.push(cur);
  const out = emptyUsage();
  for (const seg of segments) {
    if (seg.results.length > 0) {
      out.runs += seg.init ? Math.max(1, seg.results.length) : seg.results.length;
      for (const r of seg.results) {
        out.tokensIn += r.tokensIn;
        out.tokensOut += r.tokensOut;
        out.tokensCache += r.tokensCache;
        out.costUsd += r.costUsd;
      }
      continue;
    }
    if (seg.init || seg.assistants.size > 0) out.runs++;
    if (seg.assistants.size === 0) continue;
    for (const { model, usage } of seg.assistants.values()) {
      out.tokensIn += amount(usage.input_tokens);
      out.tokensOut += amount(usage.output_tokens);
      out.tokensCache +=
        amount(usage.cache_read_input_tokens) + amount(usage.cache_creation_input_tokens);
      out.costUsd += estimate(model, usage);
    }
    out.estimated = true;
  }
  return out;
}

export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    runs: a.runs + b.runs,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    tokensCache: a.tokensCache + b.tokensCache,
    costUsd: a.costUsd + b.costUsd,
    ...(a.estimated || b.estimated ? { estimated: true as const } : {}),
  };
}

const logFile = (stateRoot: string, id: string): string => join(stateRoot, 'logs', `${id}.jsonl`);

/** The text of a crew log from byte `from`; empty when there is no plain file. */
function readLog(stateRoot: string, id: string, from = 0): string {
  const file = logFile(stateRoot, id);
  assertStatePath(stateRoot, file);
  try {
    if (!lstatSync(file).isFile()) return '';
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(from, size - MAX_LOG_BYTES, 0);
      if (start >= size) return '';
      const buf = Buffer.alloc(size - start);
      const got = readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8', 0, got);
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Usage of every run in an item's log. */
export const logUsage = (stateRoot: string, id: string): RunUsage =>
  usageFromLog(readLog(stateRoot, id));

/** The `<repo>#<pr>` a review item reviews: its note, else its launch record. */
function reviewedTarget(stateRoot: string, item: WorkItem): string | undefined {
  if (item.type !== 'review') return undefined;
  const note = reviewTarget(item);
  return note === undefined
    ? readCrewCaps(stateRoot, item.id)?.reviewsTarget
    : `${note.repo}#${note.pr}`;
}

/** The item a run's cost belongs to: a review counts for the builder item it reviews. */
export function attributedItem(stateRoot: string, board: Board, item: WorkItem): WorkItem {
  const target = reviewedTarget(stateRoot, item);
  if (target === undefined) return item;
  return board.items.find((i) => i.type !== 'review' && `${i.repo}#${i.pr}` === target) ?? item;
}

/** Usage of an item: its own log and the logs of every review of its pull request. */
export function itemUsage(stateRoot: string, board: Board, item: WorkItem): RunUsage {
  let total = logUsage(stateRoot, item.id);
  if (item.type === 'review' || item.pr === undefined) return total;
  const target = `${item.repo}#${item.pr}`;
  for (const r of board.items) {
    if (r.type === 'review' && reviewedTarget(stateRoot, r) === target) {
      total = addUsage(total, logUsage(stateRoot, r.id));
    }
  }
  return total;
}

/** Sums of floats drift: amounts are kept to a millionth of a dollar. */
const roundUsd = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Sets `usage` on the item `id` counts for (itself, or the builder a review reviews), computed from
 * the logs from scratch, so collecting twice never counts twice. Pure apart from reading logs.
 */
export function withItemUsage(board: Board, stateRoot: string, id: string): Board {
  const item = board.items.find((i) => i.id === id);
  if (item === undefined) return board;
  const owner = attributedItem(stateRoot, board, item);
  const u = itemUsage(stateRoot, board, owner);
  if (u.runs === 0 && u.costUsd === 0) return board;
  const usage = {
    runs: u.runs,
    tokensIn: u.tokensIn,
    tokensOut: u.tokensOut,
    tokensCache: u.tokensCache,
    costUsd: roundUsd(u.costUsd),
    ...(u.estimated ? { estimated: true } : {}),
  };
  return {
    ...board,
    items: board.items.map((i) => (i.id === owner.id ? { ...i, usage } : i)),
  };
}

/** `$1.23`. */
export const usd = (n: number): string => `$${n.toFixed(2)}`;

// ---- The daily ledger --------------------------------------------------------------------------

/** One ended run: the local day its cost became known, and the cost. */
interface LedgerRun {
  day: string;
  item: string;
  costUsd: number;
  /** The run had no result: the cost is estimated from its assistant usage. */
  estimated?: true;
}
/** `<stateRoot>/costs.json`: runs keyed `<item>@<startedAt>`, kept for eight days. */
export type Ledger = Record<string, LedgerRun>;
export type LedgerRead = { ok: true; runs: Ledger } | { ok: false };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Z]+-\d+@[0-9T:.Z+-]{10,40}$/;

const ledgerFile = (stateRoot: string): string => join(stateRoot, COSTS_FILE);

/** Strict. A missing file is empty; a link or anything malformed is `{ ok: false }`. */
export function readLedger(stateRoot: string): LedgerRead {
  const file = ledgerFile(stateRoot);
  try {
    if (!lstatSync(file).isFile()) return { ok: false };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, runs: {} } : { ok: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false };
  }
  if (!isObject(raw) || !isObject(raw.runs)) return { ok: false };
  const runs: Ledger = Object.create(null);
  for (const [key, r] of Object.entries(raw.runs)) {
    if (!KEY_RE.test(key) || !isObject(r)) return { ok: false };
    if (typeof r.day !== 'string' || !DAY_RE.test(r.day) || typeof r.item !== 'string') {
      return { ok: false };
    }
    if (typeof r.costUsd !== 'number' || !Number.isFinite(r.costUsd) || r.costUsd < 0) {
      return { ok: false };
    }
    if (r.estimated !== undefined && r.estimated !== true) return { ok: false };
    runs[key] = {
      day: r.day,
      item: r.item,
      costUsd: r.costUsd,
      ...(r.estimated === true ? { estimated: true as const } : {}),
    };
  }
  return { ok: true, runs };
}

const DAY_MS = 86_400_000;

/** `costs.lock`, waited for up to five seconds; undefined when another writer keeps it. */
async function costsLock(stateRoot: string, now: Date): Promise<StateLock | undefined> {
  const until = Date.now() + 5000;
  for (;;) {
    const lock = acquireStateLock(stateRoot, COSTS_LOCK, { now, heartbeatStaleMs: 30_000 });
    if (lock) return lock;
    if (Date.now() >= until) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Enters every crew run of this project that has ended and is not in the ledger yet, with the cost
 * of its part of the log (`logStart` on), on today's local day. A run has ended when its process is
 * gone or its pid now belongs to another process (the identity stored at launch, as crewHold uses);
 * a live process Studio cannot verify counts as running. Runs started more than eight days ago are
 * left out, so a pruned entry never comes back. The read, merge and write run under `costs.lock`,
 * on the file as it is then. Returns false when the ledger is unreadable or the lock stays held.
 */
export async function recordEndedRuns(
  stateRoot: string,
  ports: Ports,
  timezone?: string,
): Promise<boolean> {
  const first = readLedger(stateRoot);
  if (!first.ok) return false;
  const now = ports.clock.now();
  const today = dayKey(now, timezone);
  const cutoff = dayKey(new Date(now.getTime() - (USAGE_DAYS_KEPT - 1) * DAY_MS), timezone);
  const fresh: Ledger = Object.create(null);
  for (const rec of Object.values(readCrewRecords(stateRoot))) {
    const started = Date.parse(rec.startedAt);
    if (Number.isNaN(started) || now.getTime() - started > USAGE_DAYS_KEPT * DAY_MS) continue;
    const key = `${rec.item}@${rec.startedAt}`;
    if (!KEY_RE.test(key) || Object.hasOwn(first.runs, key)) continue;
    // A live run has no result yet; an invalid pid or an unverifiable process counts as live.
    const process = await crewProcess(rec, ports);
    if (process !== 'dead' && process !== 'gone') continue;
    const from = typeof rec.logStart === 'number' && rec.logStart >= 0 ? rec.logStart : 0;
    const u = usageFromLog(readLog(stateRoot, rec.item, from));
    fresh[key] = {
      day: today,
      item: rec.item,
      costUsd: roundUsd(u.costUsd),
      ...(u.estimated ? { estimated: true as const } : {}),
    };
  }
  const stale = Object.values(first.runs).some((r) => r.day < cutoff);
  if (Object.keys(fresh).length === 0 && !stale) return true;
  const lock = await costsLock(stateRoot, now);
  if (lock === undefined) return false;
  try {
    // Another writer may have written since the first read: merge with the file as it is now.
    const again = readLedger(stateRoot);
    if (!again.ok) return false;
    const runs: Ledger = Object.create(null);
    for (const [key, r] of Object.entries(again.runs)) if (r.day >= cutoff) runs[key] = r;
    for (const [key, r] of Object.entries(fresh)) if (!Object.hasOwn(runs, key)) runs[key] = r;
    writeStateFile(stateRoot, ledgerFile(stateRoot), `${JSON.stringify({ runs }, null, 2)}\n`);
    return true;
  } finally {
    lock.release();
  }
}

/** Cost of this project's ended runs on the local day of `now`; undefined when unreadable. */
export function costToday(stateRoot: string, now: Date, timezone?: string): number | undefined {
  const read = readLedger(stateRoot);
  if (!read.ok) return undefined;
  const today = dayKey(now, timezone);
  return roundUsd(
    Object.values(read.runs)
      .filter((r) => r.day === today)
      .reduce((sum, r) => sum + r.costUsd, 0),
  );
}

export const LEDGER_UNREADABLE =
  'costs.json is unreadable while a daily cost cap is set: no crew starts until it is fixed or removed';

/**
 * Why nothing new may start under the daily cost caps, or undefined. The project cap is
 * `limits.daily_cost_usd` in studio.yaml, the owner cap the same key in the owner config, summed
 * over every project of the owner. Ledgers fail closed only while a cap is set.
 */
export function costHold(o: {
  stateRoot: string;
  stateBase: string;
  config: StudioConfig;
  ownerConfig: OwnerConfig;
  now: Date;
}): string | undefined {
  const timezone = o.ownerConfig.crewLabelLimits.timezone;
  const projectCap = o.config.limits?.dailyCostUsd;
  const ownerCap = o.ownerConfig.limits?.dailyCostUsd;
  if (projectCap !== undefined) {
    const spent = costToday(o.stateRoot, o.now, timezone);
    if (spent === undefined) return LEDGER_UNREADABLE;
    if (spent >= projectCap) {
      return `daily cost cap reached (${usd(spent)} of ${usd(projectCap)})`;
    }
  }
  if (ownerCap !== undefined) {
    let spent = 0;
    for (const root of projectStateRoots(o.stateBase)) {
      const one = costToday(root, o.now, timezone);
      if (one === undefined) return LEDGER_UNREADABLE;
      spent += one;
    }
    if (spent >= ownerCap) {
      return `owner daily cost cap reached (${usd(spent)} of ${usd(ownerCap)})`;
    }
  }
  return undefined;
}

/** Cost per item and per epic from the board's `usage` fields, for `metrics` and `epic list`. */
export function costReport(board: Board): {
  totalUsd: number;
  items: ({ item: string; epic?: string } & RunUsage)[];
  epics: { epic: string; runs: number; costUsd: number }[];
} {
  const items = board.items.flatMap((i) =>
    i.usage === undefined
      ? []
      : [
          {
            item: i.id,
            ...(i.epic === undefined ? {} : { epic: i.epic }),
            runs: i.usage.runs,
            tokensIn: i.usage.tokensIn,
            tokensOut: i.usage.tokensOut,
            tokensCache: i.usage.tokensCache ?? 0,
            costUsd: i.usage.costUsd,
            ...(i.usage.estimated === true ? { estimated: true as const } : {}),
          },
        ],
  );
  const epics = new Map<string, { epic: string; runs: number; costUsd: number }>();
  for (const i of items) {
    if (i.epic === undefined) continue;
    const e = epics.get(i.epic) ?? { epic: i.epic, runs: 0, costUsd: 0 };
    e.runs += i.runs;
    e.costUsd = roundUsd(e.costUsd + i.costUsd);
    epics.set(i.epic, e);
  }
  return {
    totalUsd: roundUsd(items.reduce((sum, i) => sum + i.costUsd, 0)),
    items,
    epics: [...epics.values()].sort((a, b) => a.epic.localeCompare(b.epic)),
  };
}
