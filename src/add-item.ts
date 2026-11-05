import {
  type Board,
  loadBoard,
  saveBoard,
  settleEpics,
  type WorkItem,
  workItemSchema,
} from './board.js';
import { globProblem, loadConfig } from './config.js';
import { prefixOf } from './init.js';
import { isReady } from './planner.js';

export const ADD_TYPES = ['fix', 'feature', 'chore', 'docs', 'research'] as const;
type AddType = (typeof ADD_TYPES)[number];

const ONE_LINE = /^[^\p{Cc}\p{Cf}]{1,300}$/u;

export type AddOptions = {
  project: string;
  title: string | undefined;
  type?: string;
  repo?: string;
  paths: string[];
  dod: string[];
  component?: string;
  plan?: string;
  /** The epic the item is a piece of; it must be open or accepting. */
  epic?: string;
  /** For the epic's history when the new item moves it back to open. */
  now?: Date;
  /** Runs `fn` under the board lock. */
  locked<T>(fn: () => T): Promise<T>;
};

/** The prefix most items on the board use (the first of a tie), else one from the repo name. */
function boardPrefix(board: Board, repo: string): string {
  const counts = new Map<string, number>();
  for (const i of board.items) {
    const p = i.id.slice(0, i.id.indexOf('-'));
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [p, c] of counts) if (best === undefined || c > (counts.get(best) ?? 0)) best = p;
  return best ?? prefixOf(repo);
}

/**
 * `studio add "<title>"`: appends a ready builder item with the next free id, checked against the
 * board schema and the config (repo, component, globs), under the board lock.
 */
export async function addItem(o: AddOptions): Promise<Record<string, unknown>> {
  const title = o.title?.trim();
  if (title === undefined || title === '')
    throw new Error('add needs a title: studio add "<title>"');
  if (!ONE_LINE.test(title))
    throw new Error('the title must be one line of at most 300 characters');
  const type = (o.type ?? 'fix') as AddType;
  if (!ADD_TYPES.includes(type)) throw new Error(`--type must be one of ${ADD_TYPES.join(', ')}`);
  if (type === 'feature' && o.plan === undefined) {
    throw new Error(
      'a feature needs a plan before it is planned: add --plan <file>, or use --type fix',
    );
  }
  if (o.dod.length === 0) {
    throw new Error('add needs at least one --dod "<line>": what done means for this item');
  }
  for (const line of o.dod) {
    if (!ONE_LINE.test(line.trim())) throw new Error('each --dod must be one line');
  }
  for (const g of o.paths) {
    const problem =
      globProblem(g) ??
      (g.startsWith('/') || /^[A-Za-z]:/.test(g)
        ? 'must be relative to the repository'
        : undefined) ??
      (g.split(/[\\/]/).includes('..') ? 'must not hold a .. segment' : undefined);
    if (problem !== undefined) throw new Error(`--path ${JSON.stringify(g)}: ${problem}`);
  }
  if (o.plan !== undefined && !ONE_LINE.test(o.plan)) throw new Error('--plan must be one line');

  return await o.locked(() => {
    const config = loadConfig(o.project);
    const board = loadBoard(o.project, config);
    const repo = o.repo ?? config.primaryRepo;
    if (repo !== config.primaryRepo && !config.repos.includes(repo)) {
      throw new Error(`--repo ${repo} is neither primary_repo nor one of repos in studio.yaml`);
    }
    if (o.component !== undefined) {
      const known = (config.components ?? []).map((c) => c.id);
      if (!known.includes(o.component)) {
        throw new Error(
          `unknown component ${o.component}${known.length > 0 ? ` (known: ${known.join(', ')})` : ': studio.yaml has no components'}`,
        );
      }
    }
    if (o.epic !== undefined) {
      const epic = (board.epics ?? []).find((e) => e.id === o.epic);
      if (epic === undefined) throw new Error(`unknown epic ${o.epic}`);
      if (epic.status === 'done' || epic.status === 'dropped') {
        throw new Error(`${epic.id} is ${epic.status}: add the item to an open epic`);
      }
    }
    const prefix = boardPrefix(board, repo);
    const numbers = board.items
      .filter((i) => i.id.startsWith(`${prefix}-`))
      .map((i) => Number(i.id.slice(prefix.length + 1)));
    const id = `${prefix}-${Math.max(0, ...numbers) + 1}`;
    const priority = Math.max(0, ...board.items.map((i) => i.priority)) + 1;
    const parsed = workItemSchema.safeParse({
      id,
      title,
      type,
      role: 'builder',
      repo,
      size: 'S',
      priority,
      status: 'ready',
      // The paths are its scope, and as touches they keep two items on the same files apart.
      paths: o.paths,
      touches: o.paths,
      ...(o.component === undefined ? {} : { component: o.component }),
      dependsOn: [],
      dod: o.dod.map((d) => d.trim()),
      ...(o.plan === undefined ? {} : { plan: o.plan }),
      ...(o.epic === undefined ? {} : { epic: o.epic }),
      history: [],
    });
    if (!parsed.success) {
      throw new Error(
        `the item would be invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const item: WorkItem = parsed.data;
    // New work in an accepting epic takes it back to open.
    saveBoard(
      o.project,
      settleEpics({ ...board, items: [...board.items, item] }, 'studio', o.now ?? new Date()).board,
    );
    const { missing } = isReady(item);
    const warnings: string[] = [];
    if (item.paths.length === 0) {
      warnings.push(
        'no --path: the item conflicts with no other item, so it may run beside work on the same files',
      );
      if (o.component === undefined) warnings.push('no --path: the item belongs to no component');
    }
    const notes = item.paths.some((g) => g === '.github' || g.startsWith('.github/'))
      ? ['a path below .github/: this is a CI item, its review may approve workflow changes']
      : [];
    return {
      item: id,
      type,
      status: item.status,
      repo,
      ...(o.epic === undefined ? {} : { epic: o.epic }),
      ...(missing.length > 0 ? { missing } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  });
}
