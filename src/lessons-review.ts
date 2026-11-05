import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardPrefix } from './add-item.js';
import {
  type Board,
  loadBoard,
  saveBoard,
  transition,
  type WorkItem,
  workItemSchema,
} from './board.js';
import { assertStatePath, writeStateFile } from './paths.js';
import {
  judgedLessons,
  listLessons,
  MAX_LESSON_LINES,
  mergeDuplicateLessons,
} from './role-memory.js';

/** `tick` bundles the proposals at most this often per project; `lessons review --now` any time. */
export const LESSONS_REVIEW_DAYS = 7;
const DAY_MS = 86_400_000;
/** The note that marks a lessons review item, with its role. */
export const LESSONS_NOTE = 'lessons-review: ';
/** The note with the numbers of the proposals the item covers. */
const NUMBERS_NOTE = 'lessons: ';
/** Why the planner never gives a lessons review to a crew: `lessons accept` is the lead's. */
export const LEAD_WORK = 'lead work: studio lessons, then accept or drop each proposal';
const BY = 'studio';

const recordFile = (stateRoot: string) => join(stateRoot, 'lessons-review.json');

/** The last review run; undefined when never, or unreadable. */
function lastRun(stateRoot: string): string | undefined {
  const file = recordFile(stateRoot);
  try {
    assertStatePath(stateRoot, file);
    if (!lstatSync(file).isFile()) return undefined;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { lastRun?: unknown };
    return typeof raw.lastRun === 'string' && !Number.isNaN(Date.parse(raw.lastRun))
      ? raw.lastRun
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the weekly review is due: it never ran, or ran 7 days ago or more. */
export function lessonsReviewDue(stateRoot: string, now: Date): boolean {
  const at = lastRun(stateRoot);
  return at === undefined || now.getTime() - Date.parse(at) >= LESSONS_REVIEW_DAYS * DAY_MS;
}

export const isLessonsReview = (item: WorkItem): boolean =>
  (item.notes ?? []).some((n) => n.startsWith(LESSONS_NOTE));

const roleOf = (item: WorkItem): string | undefined =>
  (item.notes ?? []).find((n) => n.startsWith(LESSONS_NOTE))?.slice(LESSONS_NOTE.length);

/** The proposal numbers a review item covers. */
export function reviewNumbers(item: WorkItem): number[] {
  const note = (item.notes ?? []).find((n) => n.startsWith(NUMBERS_NOTE));
  if (note === undefined) return [];
  return note
    .slice(NUMBERS_NOTE.length)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
}

const open = (i: WorkItem) => i.status !== 'merged' && i.status !== 'dropped';

/**
 * The review item for `role`, unless one is open. It names the proposals by number only: their
 * text is crew text and stays in the state root, shown by `studio lessons` as data.
 */
export function withLessonsReviewItem(
  board: Board,
  role: string,
  numbers: readonly number[],
  repo: string,
): { board: Board; id?: string } {
  if (board.items.some((i) => open(i) && roleOf(i) === role)) return { board };
  const prefix = boardPrefix(board, repo);
  const taken = board.items
    .filter((i) => i.id.startsWith(`${prefix}-`))
    .map((i) => Number(i.id.slice(prefix.length + 1)));
  const id = `${prefix}-${Math.max(0, ...taken) + 1}`;
  const parsed = workItemSchema.safeParse({
    id,
    title: `Review crew lessons for ${role} (${numbers.length})`,
    type: 'chore',
    role: 'researcher',
    repo,
    size: 'S',
    priority: Math.max(0, ...board.items.map((i) => i.priority)) + 1,
    status: 'ready',
    paths: [`.studio/roles/${role}.md`],
    touches: [],
    dependsOn: [],
    dod: [
      `Each proposal listed by studio lessons for ${role} is judged against .studio/roles/${role}.md and its evidence (report, pull request)`,
      'A proposal that generalizes beyond its one run is accepted with studio lessons accept <n>',
      'Every other one is dropped with studio lessons drop <n> --reason "<one line>"',
      `The Lessons of ${role} stay within ${MAX_LESSON_LINES} lines (studio lessons prune ${role} <line> first when full), and the role file is committed`,
    ],
    notes: [`${LESSONS_NOTE}${role}`, `${NUMBERS_NOTE}${numbers.join(', ')}`],
    history: [],
  });
  if (!parsed.success) throw new Error(`the lessons review item for ${role} would be invalid`);
  return { board: { ...board, items: [...board.items, parsed.data] }, id };
}

export interface LessonsReviewOptions {
  project: string;
  stateRoot: string;
  /** The repository the item is filed under (the primary repo). */
  repo: string;
  now: Date;
  /** Run although the week is not over (`lessons review --now`). */
  force?: boolean;
  /** Runs `fn` under the board lock. */
  locked<T>(fn: () => T | Promise<T>): Promise<T>;
}

/**
 * The weekly batch: folds near-identical proposals, then adds one review item per role that has
 * pending proposals and no open review item. Records the run, also when nothing was pending.
 */
export async function runLessonsReview(o: LessonsReviewOptions): Promise<{
  ran: boolean;
  duplicates: { kept: number; merged: number[] }[];
  added: { item: string; role: string; count: number }[];
}> {
  if (o.force !== true && !lessonsReviewDue(o.stateRoot, o.now)) {
    return { ran: false, duplicates: [], added: [] };
  }
  const duplicates = mergeDuplicateLessons(o.stateRoot, o.now);
  const byRole = new Map<string, number[]>();
  for (const l of listLessons(o.stateRoot)) {
    byRole.set(l.role, [...(byRole.get(l.role) ?? []), l.n]);
  }
  const added = await o.locked(() => {
    let board = loadBoard(o.project);
    const out: { item: string; role: string; count: number }[] = [];
    for (const [role, numbers] of [...byRole].sort(([a], [b]) => a.localeCompare(b))) {
      const r = withLessonsReviewItem(board, role, numbers, o.repo);
      if (r.id === undefined) continue;
      board = r.board;
      out.push({ item: r.id, role, count: numbers.length });
    }
    if (out.length > 0) saveBoard(o.project, board);
    return out;
  });
  writeStateFile(
    o.stateRoot,
    recordFile(o.stateRoot),
    `${JSON.stringify({ lastRun: o.now.toISOString() })}\n`,
  );
  return { ran: true, duplicates, added };
}

/**
 * Closes each open review item whose proposals are all judged (accepted, dropped or folded into
 * another), as merged with a note of the count; lists the others with how many still wait. Only a
 * `ready` item moves: one the lead moved or dropped by hand is left as it is.
 */
export async function settleLessonsReviews(o: LessonsReviewOptions): Promise<{
  open: { item: string; role: string; pending: number }[];
  closed: { item: string; role: string; accepted: number; dropped: number }[];
}> {
  const board = loadBoard(o.project);
  const reviews = board.items.filter((i) => i.status === 'ready' && isLessonsReview(i));
  if (reviews.length === 0) return { open: [], closed: [] };
  const pending = new Set(listLessons(o.stateRoot).map((l) => l.n));
  const judged = judgedLessons(o.stateRoot);
  const openList: { item: string; role: string; pending: number }[] = [];
  const done: { item: string; role: string; accepted: number; dropped: number }[] = [];
  for (const item of reviews) {
    const numbers = reviewNumbers(item);
    const role = roleOf(item) ?? '?';
    const waiting = numbers.filter((n) => pending.has(n)).length;
    if (waiting > 0) {
      openList.push({ item: item.id, role, pending: waiting });
      continue;
    }
    const verdicts = judged.filter((j) => numbers.includes(j.n));
    done.push({
      item: item.id,
      role,
      accepted: verdicts.filter((j) => j.verdict === 'accepted').length,
      dropped: verdicts.filter((j) => j.verdict === 'dropped').length,
    });
  }
  const closed =
    done.length === 0
      ? []
      : await o.locked(() => {
          let next = loadBoard(o.project);
          const out: typeof done = [];
          for (const d of done) {
            if (next.items.find((i) => i.id === d.item)?.status !== 'ready') continue;
            // No crew ran and no pull request exists: the item walks the board to merged.
            for (const to of ['assigned', 'in_progress', 'in_review', 'merged'] as const) {
              next = transition(next, d.item, to, BY, o.now);
            }
            next = {
              ...next,
              items: next.items.map((i) =>
                i.id === d.item
                  ? {
                      ...i,
                      notes: [
                        ...(i.notes ?? []),
                        `judged: ${d.accepted} accepted, ${d.dropped} dropped`,
                      ],
                    }
                  : i,
              ),
            };
            out.push(d);
          }
          if (out.length > 0) saveBoard(o.project, next);
          return out;
        });
  return { open: openList, closed };
}
