// What the board pane needs beyond the crew rows: every open item with its stage and what it waits
// for, and the latest tick's lead decisions with a next step. Derived from the board, the queue,
// the CI figures and the tick record; English data, the pane localizes its frame.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Board, WorkItem } from './board.js';
import { assertStatePath, writeStateFile } from './paths.js';
import type { QueueState } from './queue.js';
import { reviewTarget } from './review.js';

/** The board note of a pull request `collect` held for CI capacity. */
export const PR_HELD = 'pr held: ';

/** The latest tick's lead list and holds, in the state root. */
export const TICK_FILE = 'tick.json';

export type PaneStage = 'ready' | 'building' | 'pr_held' | 'review' | 'queued' | 'blocked';

export type WaitCode =
  | 'ci_capacity'
  | 'checks_pending'
  | 'review_pending'
  | 'queue_held'
  | 'queue_position'
  | 'updating'
  | 'merging'
  | 'held'
  | 'blocked';

export interface PaneWait {
  code: WaitCode;
  /** One English line; the pane shows it where it has no words of its own for the code. */
  text: string;
  /** `ci_capacity`: CI busy of total and the merge limit. */
  busy?: number;
  total?: number;
  max?: number;
  /** `queue_position`: 1 is next. */
  position?: number;
}

export interface PaneItem {
  id: string;
  title: string;
  type: WorkItem['type'];
  status: WorkItem['status'];
  stage: PaneStage;
  components?: string[];
  epic?: string;
  /** When the item entered its current stage; absent when its history does not say. */
  since?: string;
  wait?: PaneWait;
}

export type DecisionCode = 'fix_limit' | 'changes_requested' | 'merge_failed' | 'blocked' | 'other';

export interface LeadDecision {
  item: string;
  code: DecisionCode;
  /** One short English line. */
  reason: string;
  /** What the owner can say to the lead next, in English. */
  next: { say: string };
}

export interface TickRecord {
  at: string;
  needsLead: { item: string; reason: string }[];
  held: { item: string; reason: string }[];
}

const MAX_LINE = 200;

/** One plain line: no control or format characters, at most 200 code points. */
function line(s: string): string {
  const cps = [...s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')];
  return cps.length > MAX_LINE ? `${cps.slice(0, MAX_LINE - 1).join('')}…` : cps.join('');
}

const STAGE_OF: Record<WorkItem['status'], PaneStage | undefined> = {
  ready: 'ready',
  assigned: 'building',
  in_progress: 'building',
  in_review: 'review',
  queued: 'queued',
  blocked: 'blocked',
  merged: undefined,
  dropped: undefined,
};

/** The earliest move into the current stage that no move into another stage followed. */
function stageSince(item: WorkItem): string | undefined {
  const stage = STAGE_OF[item.status];
  let since: string | undefined;
  for (let i = item.history.length - 1; i >= 0; i--) {
    const h = item.history[i];
    if (h === undefined || STAGE_OF[h.to] !== stage) break;
    since = h.at;
    if (STAGE_OF[h.from] !== stage) break;
  }
  return since;
}

type Ci = { busy: number; total: number; mergeMaxBusy: number; ok: boolean };

const ciWait = (text: string, ci: Ci): PaneWait => ({
  code: 'ci_capacity',
  text,
  busy: ci.busy,
  total: ci.total,
  max: ci.mergeMaxBusy,
});

function waitOf(
  item: WorkItem,
  stage: PaneStage,
  board: Board,
  queue: QueueState,
  ci: Ci,
  tick: TickRecord | undefined,
): PaneWait | undefined {
  const notes = item.notes ?? [];
  if (stage === 'blocked') {
    const last = notes.at(-1);
    return { code: 'blocked', text: line(last ?? 'no note') };
  }
  if (stage === 'pr_held') {
    const note = notes.findLast((n) => n.startsWith(PR_HELD)) ?? PR_HELD;
    const text = line(note.slice(PR_HELD.length));
    return text.startsWith('ci capacity') ? ciWait(text, ci) : { code: 'held', text };
  }
  if (stage === 'review') {
    if (item.pr === undefined) return undefined;
    const target = `${item.repo}#${item.pr}`;
    const open = board.items.find((i) => {
      if (i.type !== 'review' || i.status === 'merged' || i.status === 'dropped') return false;
      const t = reviewTarget(i);
      return t !== undefined && `${t.repo}#${t.pr}` === target;
    });
    if (open !== undefined && (open.status === 'ready' || open.status === 'blocked')) {
      return { code: 'review_pending', text: `review ${open.id} not started` };
    }
    return undefined;
  }
  if (stage === 'queued') {
    const mine = (e: { pr: number; repo: string; item?: string }) =>
      e.item === undefined ? e.repo === item.repo && e.pr === item.pr : e.item === item.id;
    const current = queue.current;
    if (current !== undefined && mine(current)) {
      if (current.step === 'checks') return { code: 'checks_pending', text: 'checks pending' };
      if (current.step === 'capacity') return ciWait('waiting for CI capacity', ci);
      if (current.step === 'update') return { code: 'updating', text: 'updating the branch' };
      return { code: 'merging', text: 'merging' };
    }
    const held = tick?.held.find((h) => h.item === 'queue');
    if (held !== undefined) return { code: 'queue_held', text: line(held.reason) };
    const at = queue.pending.findIndex(mine);
    if (at >= 0) {
      // The place among the waiting entries; the one in progress is not counted.
      return { code: 'queue_position', text: `place ${at + 1} in the queue`, position: at + 1 };
    }
    return undefined;
  }
  const held = tick?.held.find((h) => h.item === item.id);
  return held === undefined ? undefined : { code: 'held', text: line(held.reason) };
}

/** Every item that is not merged or dropped, reviews aside (their builder shows the stage). */
export function paneItems(
  board: Board,
  queue: QueueState,
  ci: Ci,
  extra: { tick?: TickRecord; componentsOf?: (item: WorkItem) => string[] } = {},
): PaneItem[] {
  const out: PaneItem[] = [];
  for (const item of board.items) {
    const base = STAGE_OF[item.status];
    if (base === undefined || item.type === 'review') continue;
    const stage: PaneStage =
      base === 'building' && (item.notes ?? []).some((n) => n.startsWith(PR_HELD))
        ? 'pr_held'
        : base;
    const since = stageSince(item);
    const wait = waitOf(item, stage, board, queue, ci, extra.tick);
    out.push({
      id: item.id,
      title: line(item.title),
      type: item.type,
      status: item.status,
      stage,
      ...(extra.componentsOf === undefined ? {} : { components: extra.componentsOf(item) }),
      ...(item.epic === undefined ? {} : { epic: item.epic }),
      ...(since === undefined ? {} : { since }),
      ...(wait === undefined ? {} : { wait }),
    });
  }
  return out;
}

/** The first clause of a lead reason: up to the first `;`. */
const clause = (s: string): string => line(s.split(';')[0]?.trim() ?? s);

function classify(item: string, reason: string): LeadDecision {
  const r = reason.trim();
  if (r.startsWith('blocked: fix limit reached')) {
    return {
      item,
      code: 'fix_limit',
      reason: clause(r.slice('blocked: '.length)),
      next: { say: `show ${item}` },
    };
  }
  if (r.startsWith('changes requested')) {
    return {
      item,
      code: 'changes_requested',
      reason: line(r.split(':')[0] ?? r),
      next: { say: `start the fix round for ${item}` },
    };
  }
  if (r.startsWith('merge failed')) {
    return {
      item,
      code: 'merge_failed',
      reason: clause(r),
      next: { say: `show why ${item} did not merge` },
    };
  }
  if (r.startsWith('blocked: ')) {
    return {
      item,
      code: 'blocked',
      reason: clause(r.slice('blocked: '.length)),
      next: { say: `show ${item}` },
    };
  }
  return { item, code: 'other', reason: clause(r), next: { say: `show ${item}` } };
}

/** The latest tick's lead list, one entry per item, without items that are done by now. */
export function leadDecisions(tick: TickRecord | undefined, board: Board): LeadDecision[] {
  if (tick === undefined) return [];
  const done = new Set(
    board.items.filter((i) => i.status === 'merged' || i.status === 'dropped').map((i) => i.id),
  );
  const out: LeadDecision[] = [];
  for (const n of tick.needsLead) {
    if (done.has(n.item) || out.some((d) => d.item === n.item)) continue;
    out.push(classify(line(n.item), n.reason));
  }
  return out;
}

const rows = (v: unknown): { item: string; reason: string }[] =>
  Array.isArray(v)
    ? v.flatMap((r) =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as { item?: unknown }).item === 'string' &&
        typeof (r as { reason?: unknown }).reason === 'string'
          ? [{ item: (r as { item: string }).item, reason: (r as { reason: string }).reason }]
          : [],
      )
    : [];

/** The tick record; undefined when missing, a symlink, or not a JSON object with a time. */
export function readTickRecord(root: string): TickRecord | undefined {
  const file = join(root, TICK_FILE);
  try {
    assertStatePath(root, file);
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) return undefined;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    if (typeof o.at !== 'string') return undefined;
    return { at: o.at, needsLead: rows(o.needsLead), held: rows(o.held) };
  } catch {
    return undefined;
  }
}

export function writeTickRecord(root: string, rec: TickRecord): void {
  writeStateFile(root, join(root, TICK_FILE), `${JSON.stringify(rec, null, 2)}\n`);
}

/** `HH:MM` of `iso` in `timezone` (UTC when it is unset or unknown). */
export function clockTime(iso: string, timezone: string | undefined): string {
  const at = new Date(iso);
  const format = (timeZone: string | undefined) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
  try {
    return format(timezone ?? 'UTC');
  } catch {
    return format('UTC');
  }
}
