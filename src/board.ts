import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, isMap, isSeq, parseDocument, parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { StudioConfig } from './config.js';
import { matchGlob } from './glob.js';

export const ITEM_STATUSES = [
  'ready',
  'assigned',
  'in_progress',
  'in_review',
  'queued',
  'merged',
  'blocked',
  'dropped',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

// Same list as ROLE_TEMPLATES in config.ts (a test keeps them equal). Duplicated so that this file
// takes only types from config.ts.
export const BOARD_ROLES = ['builder', 'reviewer', 'designer', 'researcher', 'release'] as const;

const statusSchema = z.enum(ITEM_STATUSES);
const strList = z.array(z.string()).default([]);

const historySchema = z.strictObject({
  at: z.string(),
  from: statusSchema,
  to: statusSchema,
  by: z.string(),
});

/** A value for `--model`: it never starts with a dash. Same rule as in config.ts (a test keeps them equal). */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

/** A component id. Same rule as in config.ts (a test keeps them equal). */
export const COMPONENT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const componentId = z.string().regex(COMPONENT_ID_RE, 'must match ^[a-z][a-z0-9-]{0,31}$');

/** What a crew sandbox lacks: a test that needs one of these is not run there, CI runs it. */
export const NOT_RUN_SERVICES = ['database', 'docker', 'network', 'service'] as const;
// No control characters, and no format characters (bidi overrides, zero-width): those make a line
// read differently from what it holds.
const plainLineOf = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, `one line of at most ${max} characters`);
const plainLine = plainLineOf(300);
export const notRunHereSchema = z.strictObject({
  command: plainLine,
  missing: z.enum(NOT_RUN_SERVICES),
  reason: plainLine,
});
export type NotRunHere = z.infer<typeof notRunHereSchema>;

/** Crew text as a plain line: format characters are stripped first, then the line must hold. */
export const crewLine = z
  .string()
  .transform((s) => s.replace(/\p{Cf}/gu, ''))
  .pipe(plainLine);
/** A reviewer's `covers` text: a crew line with room for the job, its callers and its legs. */
export const crewCovers = z
  .string()
  .transform((s) => s.replace(/\p{Cf}/gu, ''))
  .pipe(plainLineOf(600));
/** A report's entry: like `notRunHereSchema`, with format characters stripped from the crew text. */
export const notRunHereReportSchema = z.strictObject({
  command: crewLine,
  missing: z.enum(NOT_RUN_SERVICES),
  reason: crewLine,
});

/** A CI job by its workflow name and its check name, as `gh pr checks` reports them. */
export const approvedJobSchema = z.strictObject({ workflow: plainLine, job: plainLine });
export type ApprovedJob = z.infer<typeof approvedJobSchema>;

export const workItemSchema = z.strictObject({
  id: z.string().regex(/^[A-Z]+-\d+$/, 'must match ^[A-Z]+-\\d+$'),
  title: z.string().min(1),
  type: z.enum(['feature', 'fix', 'chore', 'docs', 'research', 'review', 'release']),
  role: z.enum(BOARD_ROLES),
  repo: z.string().min(1),
  size: z.enum(['S', 'M', 'L']),
  priority: z.number(),
  status: statusSchema,
  paths: strList,
  touches: strList,
  conflictsWith: z.array(z.string()).optional(),
  // The component this item belongs to, or several for cross-cutting work; when neither is set,
  // `componentsOf` infers them from the repo and the paths.
  component: componentId.optional(),
  components: z.array(componentId).min(1).optional(),
  dependsOn: strList,
  dod: strList,
  flag: z.string().optional(),
  ownerOnly: z.boolean().optional(),
  plan: z.string().optional(),
  pr: z.number().int().positive().optional(),
  branch: z.string().optional(),
  // Set by `collect` from an approving review; a request for changes clears it.
  approvedHead: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i, 'not a commit')
    .optional(),
  // The base branch that approval was given for.
  approvedBase: z.string().min(1).optional(),
  // The CI jobs the approval named for commands the builder could not run; the merge checks them
  // again.
  approvedJobs: z.array(approvedJobSchema).max(20).optional(),
  // Set by `collect` from a done report: commands the crew could not run in its sandbox, which CI
  // must cover. Crew text; a reviewer gets it as data.
  notRunHere: z.array(notRunHereSchema).max(20).optional(),
  crew: z.string().optional(),
  notes: z.array(z.string()).optional(),
  // Drives the review tier, the analyzers and the skills (capabilities/INDEX.yaml).
  risk: z.array(z.enum(['ui', 'landing', 'auth', 'security', 'data', 'migration'])).optional(),
  triggers: z.array(z.enum(['epic-end', 'release'])).optional(),
  // Set by `studio escalate`; wins over the role's model.
  model: z.string().regex(MODEL_NAME_RE, 'not a model name').optional(),
  history: z.array(historySchema).default([]),
});

export const boardSchema = z.strictObject({ items: z.array(workItemSchema) });

export type WorkItem = z.infer<typeof workItemSchema>;
export type Board = z.infer<typeof boardSchema>;

export class BoardError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'BoardError';
    this.path = path;
  }
}

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

const camel = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function mapKeys(value: unknown, fn: (k: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => mapKeys(v, fn));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [fn(k), mapKeys(v, fn)]));
  }
  return value;
}

function dotted(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'symbol' ? String(p) : snake(String(p)))).join('.');
}

function describeIssue(issue: z.core.$ZodIssue): string[] {
  const base = dotted(issue.path);
  const join2 = (leaf: string) => (base ? `${base}.${leaf}` : leaf);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((k) => `${join2(snake(k))}: unknown key`);
  }
  return [`${base || '(root)'}: ${issue.message}`];
}

export const boardPath = (dir: string): string => join(dir, '.studio', 'board.yaml');
const boardFile = boardPath;

/**
 * Reads the board. With `config`, the component ids items name must be components of it; without,
 * only their form is checked.
 */
export function loadBoard(dir: string, config?: StudioConfig): Board {
  const file = boardFile(dir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new BoardError(file, `cannot read file (${(e as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new BoardError(file, `invalid YAML (${(e as Error).message})`);
  }
  const result = boardSchema.safeParse(mapKeys(raw, camel));
  if (!result.success) {
    throw new BoardError(file, result.error.issues.flatMap(describeIssue).join('; '));
  }
  const board = result.data;
  const ids = new Set<string>();
  for (const it of board.items) {
    if (ids.has(it.id)) throw new BoardError(file, `duplicate id ${it.id}`);
    ids.add(it.id);
  }
  for (const it of board.items) {
    for (const dep of it.dependsOn) {
      if (!ids.has(dep)) throw new BoardError(file, `${it.id}: depends_on unknown id ${dep}`);
    }
    for (const c of it.conflictsWith ?? []) {
      if (!ids.has(c)) throw new BoardError(file, `${it.id}: conflicts_with unknown id ${c}`);
    }
    if (it.component !== undefined && it.components !== undefined) {
      throw new BoardError(file, `${it.id}: set component or components, not both`);
    }
    if (config !== undefined) {
      const known = new Set((config.components ?? []).map((c) => c.id));
      const unknown = namedComponents(it).find((c) => !known.has(c));
      if (unknown !== undefined) {
        throw new BoardError(file, `${it.id}: unknown component ${unknown}`);
      }
    }
  }
  return board;
}

const namedComponents = (item: WorkItem): string[] =>
  item.components ?? (item.component === undefined ? [] : [item.component]);

/**
 * The components an item belongs to, in config order for inferred ones. Named ones win; otherwise
 * every component of the item's repo one of whose globs matches one of its paths or touches. More
 * than one means cross-cutting work; none, or a config without components, gives [].
 */
export function componentsOf(item: WorkItem, config: StudioConfig): string[] {
  const components = config.components ?? [];
  if (components.length === 0) return [];
  const named = namedComponents(item);
  if (named.length > 0) return [...new Set(named)];
  const paths = [...item.paths, ...item.touches];
  return components
    .filter((c) => c.repo === item.repo && paths.some((p) => c.paths.some((g) => matchGlob(g, p))))
    .map((c) => c.id);
}

// Stable key order for saved items.
const KEY_ORDER: readonly (keyof WorkItem)[] = [
  'id',
  'title',
  'type',
  'role',
  'repo',
  'size',
  'priority',
  'status',
  'paths',
  'touches',
  'conflictsWith',
  'component',
  'components',
  'dependsOn',
  'dod',
  'flag',
  'ownerOnly',
  'plan',
  'pr',
  'branch',
  'approvedHead',
  'approvedBase',
  'approvedJobs',
  'notRunHere',
  'crew',
  'notes',
  'risk',
  'triggers',
  'model',
  'history',
];

function orderedItem(item: WorkItem): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const v = item[key];
    if (v === undefined) continue;
    out[snake(key)] = key === 'history' ? mapKeys(v, snake) : v;
  }
  return out;
}

type Commented = { commentBefore?: string | null; comment?: string | null };

/** Save the board. Comments of an existing file (header, per item, per key) are carried over. */
export function saveBoard(dir: string, board: Board): void {
  const file = boardFile(dir);
  const doc = new Document({ items: board.items.map(orderedItem) });
  let old: Document.Parsed | undefined;
  try {
    old = parseDocument(readFileSync(file, 'utf8'));
  } catch {
    old = undefined;
  }
  if (old && old.errors.length === 0) {
    doc.commentBefore = old.commentBefore;
    doc.comment = old.comment;
    const oldRoot = old.contents as Commented | null;
    const newRoot = doc.contents as Commented | null;
    if (oldRoot && newRoot) {
      newRoot.commentBefore = oldRoot.commentBefore;
      newRoot.comment = oldRoot.comment;
    }
    if (isMap(old.contents) && isMap(doc.contents)) {
      // A header comment directly above `items:` is attached to the key, not the document.
      const k = old.contents.items.find((p) => (p.key as { value?: unknown }).value === 'items');
      const nk = doc.contents.items.find((p) => (p.key as { value?: unknown }).value === 'items');
      const before = (k?.key as Commented | undefined)?.commentBefore;
      if (nk && before) (nk.key as Commented).commentBefore = before;
    }
    const oldItems = old.get('items', true);
    const newItems = doc.get('items', true);
    if (isSeq(oldItems) && isSeq(newItems)) {
      newItems.commentBefore = oldItems.commentBefore;
      newItems.comment = oldItems.comment;
      for (const oldNode of oldItems.items) {
        if (!isMap(oldNode)) continue;
        const target = newItems.items.find((n) => isMap(n) && n.get('id') === oldNode.get('id'));
        if (!isMap(target)) continue;
        target.commentBefore = oldNode.commentBefore;
        target.comment = oldNode.comment;
        for (const pair of oldNode.items) {
          const k = (pair.key as { value?: unknown }).value;
          const np = target.items.find((p) => (p.key as { value?: unknown }).value === k);
          if (!np) continue;
          const oldKey = pair.key as Commented;
          const oldVal = pair.value as Commented | null;
          const newVal = np.value as Commented | null;
          if (oldKey.commentBefore) (np.key as Commented).commentBefore = oldKey.commentBefore;
          if (oldVal?.comment && newVal && typeof newVal === 'object')
            newVal.comment = oldVal.comment;
        }
      }
    }
  }
  // Atomic: temp file in the same directory, then rename; the temp file is removed on failure.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, doc.toString({ lineWidth: 0 }), { flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ready→assigned→in_progress→in_review→queued→merged, plus rework and merge-failure loops. A run
// stopped at a usage limit returns from assigned or in_progress to ready.
const FORWARD: Readonly<Record<ItemStatus, readonly ItemStatus[]>> = {
  ready: ['assigned'],
  assigned: ['in_progress', 'ready'],
  in_progress: ['in_review', 'ready'],
  in_review: ['queued', 'in_progress', 'merged'],
  queued: ['merged', 'in_review'],
  merged: [],
  blocked: ['ready'],
  dropped: [],
};

const TERMINAL: readonly ItemStatus[] = ['merged', 'dropped'];

export function isLegalMove(from: ItemStatus, to: ItemStatus, hasPr: boolean): boolean {
  if (TERMINAL.includes(from)) return false;
  // in_review -> merged is for items that never had a PR (review, research); a PR goes through the queue.
  if (from === 'in_review' && to === 'merged') return !hasPr;
  if (to === 'blocked') return from !== 'blocked';
  if (to === 'dropped') return true;
  return FORWARD[from].includes(to);
}

/** Pure: returns a new board and leaves the input untouched. */
export function transition(board: Board, id: string, to: ItemStatus, by: string, now: Date): Board {
  const current = board.items.find((i) => i.id === id);
  if (!current) throw new TransitionError(`unknown item ${id}`);
  if (!isLegalMove(current.status, to, current.pr !== undefined)) {
    throw new TransitionError(`illegal move for ${id}: ${current.status} -> ${to}`);
  }
  const entry = { at: now.toISOString(), from: current.status, to, by };
  return {
    ...board,
    items: board.items.map((i) => {
      const copy = structuredClone(i);
      return i.id === id ? { ...copy, status: to, history: [...copy.history, entry] } : copy;
    }),
  };
}
