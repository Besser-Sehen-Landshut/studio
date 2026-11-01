import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, isMap, isSeq, parseDocument, parse as parseYaml } from 'yaml';
import { z } from 'zod';

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

// Same list as ROLE_TEMPLATES in config.ts (a test keeps them equal). Duplicated because
// scripts/gen-schema.ts loads this file through node's type stripping, which cannot resolve '.js' imports.
export const BOARD_ROLES = ['builder', 'reviewer', 'designer', 'researcher', 'release'] as const;

const statusSchema = z.enum(ITEM_STATUSES);
const strList = z.array(z.string()).default([]);

const historySchema = z.strictObject({
  at: z.string(),
  from: statusSchema,
  to: statusSchema,
  by: z.string(),
});

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
  dependsOn: strList,
  dod: strList,
  flag: z.string().optional(),
  ownerOnly: z.boolean().optional(),
  plan: z.string().optional(),
  pr: z.number().int().positive().optional(),
  branch: z.string().optional(),
  crew: z.string().optional(),
  notes: z.array(z.string()).optional(),
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

const boardFile = (dir: string): string => join(dir, '.studio', 'board.yaml');

export function loadBoard(dir: string): Board {
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
  }
  return board;
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
  'dependsOn',
  'dod',
  'flag',
  'ownerOnly',
  'plan',
  'pr',
  'branch',
  'crew',
  'notes',
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
