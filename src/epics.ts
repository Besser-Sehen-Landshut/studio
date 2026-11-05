import {
  type Board,
  type Epic,
  type EpicProgress,
  epicProgress,
  epicSchema,
  loadBoard,
  saveBoard,
  settleEpics,
} from './board.js';
import { loadConfig } from './config.js';

const ONE_LINE = /^[^\p{Cc}\p{Cf}]{1,300}$/u;
const GOAL = /^[^\p{Cc}\p{Cf}]{1,2000}$/u;

/** The next free epic number: one above the highest, so a dropped epic's id is never reused. */
export function nextEpicId(board: Board): string {
  const numbers = (board.epics ?? []).map((e) => Number(e.id.slice(2)));
  return `E-${Math.max(0, ...numbers) + 1}`;
}

/** Natural order of epic ids: E-2 before E-10. */
export const byEpicId = (a: { id: string }, b: { id: string }): number =>
  Number(a.id.slice(2)) - Number(b.id.slice(2));

export function findEpic(board: Board, id: string | undefined): Epic {
  if (id === undefined || id === '') throw new Error('missing epic id');
  const epic = (board.epics ?? []).find((e) => e.id === id);
  if (epic === undefined) throw new Error(`unknown epic ${id}`);
  return epic;
}

export type EpicAddOptions = {
  project: string;
  title: string | undefined;
  goal: string | undefined;
  acceptance: string[];
  components: string[];
  now: Date;
  /** Runs `fn` under the board lock. */
  locked<T>(fn: () => T): Promise<T>;
};

/** `studio epic add`: appends an open epic with the next free id, under the board lock. */
export async function addEpic(o: EpicAddOptions): Promise<Record<string, unknown>> {
  const title = o.title?.trim();
  if (title === undefined || title === '') {
    throw new Error('epic add needs a title: studio epic add "<title>" --goal "<text>"');
  }
  if (!ONE_LINE.test(title))
    throw new Error('the title must be one line of at most 300 characters');
  const goal = o.goal?.trim();
  if (goal === undefined || goal === '') {
    throw new Error('epic add needs --goal "<text>": what the epic is for');
  }
  if (!GOAL.test(goal)) throw new Error('--goal must be one line of at most 2000 characters');
  const acceptance = o.acceptance.map((a) => a.trim());
  if (acceptance.length === 0) {
    throw new Error('epic add needs at least one --acceptance "<line>": how it is accepted');
  }
  if (acceptance.some((a) => !ONE_LINE.test(a))) {
    throw new Error('each --acceptance must be one line of at most 300 characters');
  }
  return await o.locked(() => {
    const config = loadConfig(o.project);
    const board = loadBoard(o.project, config);
    const known = (config.components ?? []).map((c) => c.id);
    for (const c of o.components) {
      if (!known.includes(c)) {
        throw new Error(
          `unknown component ${c}${known.length > 0 ? ` (known: ${known.join(', ')})` : ': studio.yaml has no components'}`,
        );
      }
    }
    const id = nextEpicId(board);
    const parsed = epicSchema.safeParse({
      id,
      title,
      status: 'open',
      goal,
      acceptance,
      ...(o.components.length === 0 ? {} : { components: [...new Set(o.components)] }),
      history: [],
    });
    if (!parsed.success) {
      throw new Error(
        `the epic would be invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    saveBoard(o.project, { ...board, epics: [...(board.epics ?? []), parsed.data] });
    return { epic: id, title, status: 'open' };
  });
}

export type EpicRow = {
  id: string;
  title: string;
  status: Epic['status'];
  progress: { merged: number; total: number };
  counts: EpicProgress['counts'];
};

/** Every epic in id order, with its items by status and merged of total. */
export function epicRows(board: Board): EpicRow[] {
  return [...(board.epics ?? [])].sort(byEpicId).map((e) => {
    const p = epicProgress(board, e.id);
    return {
      id: e.id,
      title: e.title,
      status: e.status,
      progress: { merged: p.merged, total: p.total },
      counts: p.counts,
    };
  });
}

/** `epic drop`: refused while the epic has an item that is neither merged nor dropped. Pure. */
export function dropEpic(board: Board, id: string, by: string, now: Date): Board {
  const epic = findEpic(board, id);
  if (epic.status === 'dropped' || epic.status === 'done') {
    throw new Error(`${id} is ${epic.status} already`);
  }
  const open = board.items.filter(
    (i) => i.epic === id && i.status !== 'merged' && i.status !== 'dropped',
  );
  if (open.length > 0) {
    throw new Error(
      `${id} still has open items (${open.map((i) => i.id).join(', ')}): drop or finish them first`,
    );
  }
  const entry = { at: now.toISOString(), from: epic.status, to: 'dropped' as const, by };
  return {
    ...board,
    epics: (board.epics ?? []).map((e) =>
      e.id === id
        ? { ...structuredClone(e), status: 'dropped', history: [...e.history, entry] }
        : e,
    ),
  };
}

/** Moves epics by the status rule and saves when one moved; returns what moved. */
export function settleAndSave(
  project: string,
  board: Board,
  by: string,
  now: Date,
): ReturnType<typeof settleEpics>['moved'] {
  const settled = settleEpics(board, by, now);
  if (settled.moved.length > 0) saveBoard(project, settled.board);
  return settled.moved;
}
