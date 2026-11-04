import { lstatSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { boardPath, ITEM_STATUSES, type ItemStatus, loadBoard } from './board.js';
import { OWNER_DIR, projectStateRoots, stateDirName } from './paths.js';
import { loadQueue } from './queue.js';
import { readCrewRecords } from './state.js';

/** One project's line in `studio overview`; a part that cannot be read is left out and named in `problems`. */
export interface ProjectOverview {
  name: string;
  stateRoot: string;
  /** The project directory its marker names; absent without a readable marker. */
  project?: string;
  /** Items per status, only the statuses that occur, in board order. */
  items?: Partial<Record<ItemStatus, number>>;
  /** Crew processes that are alive and not stopped. */
  crews?: number;
  /** Pull requests in the merge queue, the one being merged included. */
  queued?: number;
  problems: string[];
}

/** One line without control or format characters, so no file or name can draw on the terminal. */
const line = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/[\p{Cc}\p{Cf}]/gu, ' ');

export const INCONSISTENT_ROOT =
  'inconsistent state root: its marker names a project whose state root is another one';

function markerProject(root: string): string | undefined {
  const file = join(root, 'marker.json');
  try {
    if (!lstatSync(file).isFile()) throw new Error(`${file} is not a plain file`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`state root marker ${file} is unreadable`);
  }
  const p = (raw as { projectRealpath?: unknown } | null)?.projectRealpath;
  if (typeof p !== 'string' || !isAbsolute(p)) {
    throw new Error(`state root marker ${file} names no project`);
  }
  return p;
}

/** Reads the project's board, refusing a board.yaml that is a link or no plain file. */
function itemCounts(project: string): Partial<Record<ItemStatus, number>> {
  const file = boardPath(project);
  let plain = true;
  try {
    plain = lstatSync(file).isFile();
  } catch {
    // Missing: loadBoard says so.
  }
  if (!plain) throw new Error(`${file}: board.yaml is not a plain file`);
  const counts: Partial<Record<ItemStatus, number>> = {};
  const board = loadBoard(project);
  for (const s of ITEM_STATUSES) {
    const n = board.items.filter((i) => i.status === s).length;
    if (n > 0) counts[s] = n;
  }
  return counts;
}

function readOne(root: string, alive: (pid: number) => boolean): ProjectOverview {
  const problems: string[] = [];
  const out: ProjectOverview = { name: line(basename(root)), stateRoot: root, problems };
  let project: string | undefined;
  try {
    project = markerProject(root);
    if (project === undefined) problems.push('no marker.json: the project is unknown');
  } catch (e) {
    problems.push(line(e));
  }
  // A marker copied into another root, or edited, names a project this root does not belong to.
  if (project !== undefined && stateDirName(project) !== basename(root)) {
    problems.push(INCONSISTENT_ROOT);
    return out;
  }
  if (project !== undefined) {
    out.project = project;
    out.name = line(basename(project)) || out.name;
    try {
      out.items = itemCounts(project);
    } catch (e) {
      problems.push(line(e));
    }
  }
  try {
    out.crews = Object.values(readCrewRecords(root)).filter(
      (r) =>
        r !== null &&
        typeof r === 'object' &&
        r.stoppedAt === undefined &&
        Number.isInteger(r.pid) &&
        r.pid > 0 &&
        alive(r.pid),
    ).length;
  } catch (e) {
    problems.push(line(e));
  }
  try {
    const q = loadQueue(root);
    out.queued = q.pending.length + (q.current === undefined ? 0 : 1);
  } catch (e) {
    problems.push(line(e));
  }
  return out;
}

/**
 * Every project state root below the state base, read only: nothing is written, created or
 * migrated, and a root that cannot be read in part is reported with what could be read. The owner
 * dir is not a project.
 */
export function readOverview(base: string, alive: (pid: number) => boolean): ProjectOverview[] {
  return projectStateRoots(base)
    .filter((r) => basename(r) !== OWNER_DIR)
    .map((r) => readOne(r, alive))
    .sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.stateRoot < b.stateRoot ? -1 : 1,
    );
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? [];
  return `${rows
    .map((r) =>
      r
        .map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')}\n`;
}

const counted = (n: number | undefined) => (n === undefined ? '?' : String(n));

export function formatOverview(list: readonly ProjectOverview[]): string {
  if (list.length === 0) return 'No Studio projects yet.\n';
  return table([
    ['PROJECT', 'ITEMS', 'CREWS', 'QUEUED', 'PROBLEMS'],
    ...list.map((p) => [
      p.name,
      p.items === undefined
        ? '?'
        : Object.entries(p.items)
            .map(([s, n]) => `${s} ${n}`)
            .join(', ') || '-',
      counted(p.crews),
      counted(p.queued),
      p.problems.join('; '),
    ]),
  ]);
}
