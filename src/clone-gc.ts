// Clean-up of finished items: their clone `<stateRoot>/clones/<id>`, crew home `homes/<id>` and
// tmp dir `tmp/<id>`. Most of a clone's size is build output (a Rust `target/` reaches gigabytes,
// `node_modules` hundreds of megabytes); the blob-less git objects are tens of megabytes. Nothing
// removes those once an item is merged or dropped, so this module decides what can go.
//
// Rule (D4, src/crew.ts): git never runs inside a crew clone. Everything here reads files with
// lstat (no link is followed) and asks GitHub; a clone is removed only when every local branch tip
// is shown to be on GitHub. In doubt a clone stays, with the reason.
//
// The seam for a shared build cache: only these three per-item entries are ever removed. A cache
// kept elsewhere (outside `clones/`, `homes/` and `tmp/`) is never touched by this module.

import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { type Board, loadBoard, type WorkItem } from './board.js';
import { crewHold, githubHttpsUrl, isItemId } from './crew.js';
import { acquireStateLock, removeStateEntry } from './paths.js';
import type { Ports } from './ports.js';
import { listLessons } from './role-memory.js';
import { readCrewRecords } from './state.js';
import { LAUNCH_LOCK, LAUNCH_LOCK_STALE_MS } from './usage.js';

/** The per-item entries of the state root a clean-up removes, and nothing else. */
export const ITEM_DIRS = ['clones', 'homes', 'tmp'] as const;
/** Top-level folders of a clone whose size `studio gc` names: git objects and build output. */
export const SIZE_PARTS = ['.git', 'target', 'node_modules'] as const;
/** A dropped item's clone stays this long after the drop: uncommitted work cannot be seen. */
export const DROPPED_KEEP_DAYS = 7;
/** Clones one tick asks GitHub about at most; the others wait for the next tick. */
export const TICK_REMOTE_MAX = 10;
const GH_MS = 30_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** More local branches than this are not checked one by one: the clone stays. */
const MAX_TIPS = 20;
const MAX_REF_BYTES = 200;
const MAX_PACKED_BYTES = 1024 * 1024;

/**
 * `remove`: clone, home and tmp go. `trim`: a pending lesson cites the clone's report, so only
 * `.studio/reports` stays and home and tmp go. `keep`: nothing is touched. `unchecked`: nothing
 * local keeps it, but GitHub was not asked (doctor, or the tick's bound was reached).
 */
export type GcVerdict = 'remove' | 'trim' | 'keep' | 'unchecked';

export interface GcEntry {
  item: string;
  /** Whether the item has a clone (an entry may hold only a crew home or a tmp dir). */
  clone: boolean;
  verdict: GcVerdict;
  /** Why it stays, or what goes. */
  reason: string;
  /** Disk use of clone, home and tmp together, when sizes were asked for. */
  bytes?: number;
  /** Disk use of the clone's `.git`, `target` and `node_modules`, when present. */
  parts?: Partial<Record<(typeof SIZE_PARTS)[number], number>>;
}

export interface GcPlan {
  entries: GcEntry[];
  /** Set when nothing could be judged (an unreadable crew.json, no board): every entry is kept. */
  problem?: string;
}

const TERMINAL = new Set(['merged', 'dropped']);

function lstatOr(p: string): Stats | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

function listDir(dir: string): string[] {
  const st = lstatOr(dir);
  if (st === undefined || !st.isDirectory()) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Disk use of `path` in bytes (allocated blocks), walking with lstat: a link counts as itself and
 * is never followed, a hard-linked file counts once. Unreadable parts count as nothing.
 */
export function diskBytes(path: string, seen: Set<string> = new Set()): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const p = stack.pop() as string;
    const st = lstatOr(p);
    if (st === undefined) continue;
    const key = `${st.dev}:${st.ino}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += st.blocks !== undefined ? st.blocks * 512 : st.size;
    if (st.isDirectory()) for (const name of listDir(p)) stack.push(join(p, name));
  }
  return total;
}

/** A small regular file's text, read without following a link; undefined otherwise. */
function smallFile(p: string, max: number): string | undefined {
  const st = lstatOr(p);
  if (st === undefined || !st.isFile() || st.size > max) return undefined;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

type Tips = { ok: true; tips: string[] } | { ok: false; why: string };

/**
 * Every commit a clone holds at a local branch tip or a detached HEAD, read from `.git` as files.
 * Anything unexpected (a link, a ref that is no SHA, a stash, too many branches) is a reason to keep.
 */
export function localTips(clone: string): Tips {
  const git = join(clone, '.git');
  const tips = new Set<string>();
  const head = smallFile(join(git, 'HEAD'), MAX_REF_BYTES);
  if (head === undefined) return { ok: false, why: '.git/HEAD cannot be read as a plain file' };
  const h = head.trim();
  if (SHA.test(h)) tips.add(h);
  else if (!/^ref: refs\/heads\/\S+$/.test(h)) return { ok: false, why: '.git/HEAD is unusual' };
  if (lstatOr(join(git, 'refs', 'stash')) !== undefined)
    return { ok: false, why: 'it has a stash' };
  const refsSt = lstatOr(join(git, 'refs'));
  if (refsSt !== undefined && !refsSt.isDirectory())
    return { ok: false, why: '.git/refs is no folder' };
  const stack = [join(git, 'refs', 'heads')];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const st = lstatOr(dir);
    if (st === undefined) continue;
    if (!st.isDirectory()) return { ok: false, why: 'a branch ref is no plain file' };
    for (const name of listDir(dir)) {
      const p = join(dir, name);
      const s = lstatOr(p);
      if (s?.isDirectory()) {
        stack.push(p);
        continue;
      }
      const text = smallFile(p, MAX_REF_BYTES)?.trim();
      if (text === undefined || !SHA.test(text)) {
        return { ok: false, why: 'a branch ref is no plain commit id' };
      }
      tips.add(text);
    }
  }
  const packedPath = join(git, 'packed-refs');
  if (lstatOr(packedPath) !== undefined) {
    const packed = smallFile(packedPath, MAX_PACKED_BYTES);
    if (packed === undefined) return { ok: false, why: '.git/packed-refs cannot be read' };
    for (const raw of packed.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, ref] = line.split(/\s+/);
      if (ref === 'refs/stash') return { ok: false, why: 'it has a stash' };
      if (ref === undefined || !ref.startsWith('refs/heads/')) continue;
      if (sha === undefined || !SHA.test(sha))
        return { ok: false, why: '.git/packed-refs is unusual' };
      tips.add(sha);
    }
  }
  if (tips.size > MAX_TIPS) return { ok: false, why: `more than ${MAX_TIPS} local branches` };
  return { ok: true, tips: [...tips] };
}

/** Whether only `.studio/reports` is left of a clone (what a trim leaves). */
function onlyReports(clone: string): boolean {
  const top = listDir(clone);
  if (top.length !== 1 || top[0] !== '.studio') return false;
  const inner = listDir(join(clone, '.studio'));
  return inner.length === 1 && inner[0] === 'reports';
}

/** When the item was dropped, from its history; undefined without such an entry. */
function droppedAt(item: WorkItem): number | undefined {
  const entry = [...item.history].reverse().find((h) => h.to === 'dropped');
  const t = entry === undefined ? Number.NaN : Date.parse(entry.at);
  return Number.isNaN(t) ? undefined : t;
}

/** Numbers of pending lesson proposals that cite a report in this item's clone. */
function citingLessons(lessons: ReturnType<typeof listLessons>, id: string): number[] {
  const prefix = `clones/${id}/`;
  return lessons
    .filter(
      (l) =>
        l.evidence?.report?.startsWith(prefix) === true ||
        (l.alsoFrom ?? []).some((a) => a.report?.startsWith(prefix) === true),
    )
    .map((l) => l.n);
}

/**
 * Whether GitHub has `tip` inside the item's pull request head or `main`: the compare API says
 * `identical` or `behind` (the tip is an ancestor). Throws when GitHub cannot be asked.
 */
async function onGitHub(
  ports: Ports,
  repo: string,
  bases: string[],
  tip: string,
): Promise<boolean> {
  for (const base of bases) {
    if (base === tip) return true;
    let status: string;
    try {
      status = (
        await ports.gh.api(`repos/${repo}/compare/${base}...${tip}`, '.status', {
          paginate: false,
          timeoutMs: GH_MS,
        })
      ).trim();
    } catch {
      // An unknown commit is a 404: it is not on GitHub under this base.
      continue;
    }
    if (status === 'identical' || status === 'behind') return true;
  }
  return false;
}

/** The head commit of the item's pull request, or undefined. */
async function prHead(
  ports: Ports,
  repo: string,
  pr: number | undefined,
): Promise<string | undefined> {
  if (pr === undefined) return undefined;
  try {
    const sha = (
      await ports.gh.api(`repos/${repo}/pulls/${pr}`, '.head.sha', {
        paginate: false,
        timeoutMs: GH_MS,
      })
    )
      .trim()
      .toLowerCase();
    return SHA.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export interface PlanOptions {
  stateRoot: string;
  /** The board; undefined when it cannot be read, and then every entry is kept. */
  board: Board | undefined;
  ports: Ports;
  now: Date;
  /** Ask GitHub whether the clones' commits are pushed; without it such clones are `unchecked`. */
  remote: boolean;
  /** Measure disk use. */
  sizes: boolean;
  /** Clones asked about on GitHub at most; the rest are `unchecked`. */
  maxRemote?: number;
}

/** What a clean-up would do for each item that has a clone, a crew home or a tmp dir. Writes nothing. */
export async function planCloneGc(o: PlanOptions): Promise<GcPlan> {
  const ids = new Set<string>();
  for (const sub of ITEM_DIRS) for (const name of listDir(join(o.stateRoot, sub))) ids.add(name);
  const sorted = [...ids].sort();
  const sized = (id: string, e: Omit<GcEntry, 'item' | 'clone'>): GcEntry => {
    const clone = join(o.stateRoot, 'clones', id);
    const entry: GcEntry = { item: id, clone: lstatOr(clone) !== undefined, ...e };
    if (!o.sizes) return entry;
    const seen = new Set<string>();
    const parts: GcEntry['parts'] = {};
    for (const part of SIZE_PARTS) {
      if (lstatOr(join(clone, part))?.isDirectory())
        parts[part] = diskBytes(join(clone, part), new Set(seen));
    }
    entry.bytes = ITEM_DIRS.reduce((n, sub) => n + diskBytes(join(o.stateRoot, sub, id), seen), 0);
    if (Object.keys(parts).length > 0) entry.parts = parts;
    return entry;
  };
  const keepAll = (problem: string): GcPlan => ({
    problem,
    entries: sorted.map((id) => sized(id, { verdict: 'keep', reason: problem })),
  });
  if (o.board === undefined) return keepAll('the board cannot be read');
  let crews: ReturnType<typeof readCrewRecords>;
  try {
    crews = readCrewRecords(o.stateRoot);
  } catch {
    return keepAll('crew.json cannot be read');
  }
  let lessons: ReturnType<typeof listLessons> | undefined;
  try {
    lessons = listLessons(o.stateRoot);
  } catch {
    lessons = undefined;
  }
  let asked = 0;
  const entries: GcEntry[] = [];
  for (const id of sorted) {
    entries.push(sized(id, await judge(id)));
  }
  return { entries };

  async function judge(id: string): Promise<Omit<GcEntry, 'item' | 'clone'>> {
    const keep = (reason: string) => ({ verdict: 'keep' as const, reason });
    if (!isItemId(id)) return keep('not an item');
    const item = o.board?.items.find((i) => i.id === id);
    if (item === undefined) return keep('not on the board');
    if (!TERMINAL.has(item.status)) return keep(`the item is ${item.status}`);
    const rec = crews[id];
    if (rec !== undefined) {
      const hold = await crewHold(rec, o.ports);
      if (hold === 'running') return keep('its crew is running');
      if (hold === 'unverified') return keep('its crew may still run (cannot be verified)');
    }
    if (item.status === 'dropped') {
      const at = droppedAt(item);
      if (at === undefined) return keep('dropped, but its history has no drop time');
      const days = (o.now.getTime() - at) / 86_400_000;
      if (days < DROPPED_KEEP_DAYS) {
        return keep(`dropped less than ${DROPPED_KEEP_DAYS} days ago`);
      }
    }
    let repo: string;
    try {
      githubHttpsUrl(item.repo);
      repo = item.repo;
    } catch {
      return keep('the item names no valid repository');
    }
    const clone = join(o.stateRoot, 'clones', id);
    const cloneSt = lstatOr(clone);
    let tips: string[] = [];
    if (cloneSt !== undefined) {
      if (!cloneSt.isDirectory()) return keep('the clone is no plain folder');
      const gitSt = lstatOr(join(clone, '.git'));
      if (gitSt !== undefined) {
        if (!gitSt.isDirectory()) return keep('.git is no plain folder');
        const t = localTips(clone);
        if (!t.ok) return keep(t.why);
        tips = t.tips;
      }
    }
    if (lessons === undefined && cloneSt !== undefined) return keep('lessons.json cannot be read');
    // A lesson can only be shown its report while the report folder is there.
    const hasReports = lstatOr(join(clone, '.studio', 'reports'))?.isDirectory() === true;
    const cited = hasReports ? citingLessons(lessons ?? [], id) : [];
    if (cited.length > 0 && onlyReports(clone)) {
      return keep(`only its report is left, cited by lesson ${cited.join(', ')}`);
    }
    const verdict: GcVerdict = cited.length > 0 ? 'trim' : 'remove';
    const what =
      verdict === 'trim'
        ? `${item.status}; lesson ${cited.join(', ')} cites its report, which stays`
        : item.status;
    if (tips.length > 0) {
      if (!o.remote || asked >= (o.maxRemote ?? Number.POSITIVE_INFINITY)) {
        return {
          verdict: 'unchecked',
          reason: `${what}; GitHub not asked yet whether its commits are pushed`,
        };
      }
      asked++;
      const bases = [await prHead(o.ports, repo, item.pr), 'main'].filter(
        (b): b is string => b !== undefined,
      );
      for (const tip of tips) {
        if (!(await onGitHub(o.ports, repo, bases, tip))) {
          return keep(`commit ${tip.slice(0, 12)} is not on GitHub in its pull request or main`);
        }
      }
    }
    return { verdict, reason: what };
  }
}

export interface GcResult {
  removed: string[];
  trimmed: string[];
  /** Entries that were to go but stayed, with why. */
  skipped: { item: string; reason: string }[];
}

/**
 * Carries out `remove` and `trim` of a plan, under the owner's launch lock so no launch starts on
 * one of these items meanwhile; each crew is checked once more right before. No lock: nothing goes.
 */
export async function applyCloneGc(o: {
  stateRoot: string;
  ownerRoot: string;
  plan: GcPlan;
  ports: Ports;
}): Promise<GcResult> {
  const out: GcResult = { removed: [], trimmed: [], skipped: [] };
  const todo = o.plan.entries.filter((e) => e.verdict === 'remove' || e.verdict === 'trim');
  if (todo.length === 0) return out;
  const lock = acquireStateLock(o.ownerRoot, LAUNCH_LOCK, {
    now: o.ports.clock.now(),
    heartbeatStaleMs: LAUNCH_LOCK_STALE_MS,
  });
  if (!lock) {
    for (const e of todo) out.skipped.push({ item: e.item, reason: 'a launch is in progress' });
    return out;
  }
  try {
    let crews: ReturnType<typeof readCrewRecords>;
    try {
      crews = readCrewRecords(o.stateRoot);
    } catch {
      for (const e of todo) out.skipped.push({ item: e.item, reason: 'crew.json cannot be read' });
      return out;
    }
    for (const e of todo) {
      if (!isItemId(e.item)) continue;
      const rec = crews[e.item];
      if (rec !== undefined && (await crewHold(rec, o.ports)) !== undefined) {
        out.skipped.push({ item: e.item, reason: 'its crew is running' });
        continue;
      }
      try {
        const clone = join(o.stateRoot, 'clones', e.item);
        if (e.verdict === 'trim') trimToReports(o.stateRoot, clone);
        else removeStateEntry(o.stateRoot, clone);
        removeStateEntry(o.stateRoot, join(o.stateRoot, 'homes', e.item));
        removeStateEntry(o.stateRoot, join(o.stateRoot, 'tmp', e.item));
        (e.verdict === 'trim' ? out.trimmed : out.removed).push(e.item);
      } catch (err) {
        out.skipped.push({
          item: e.item,
          reason: (err as Error).message.replace(/\p{Cc}/gu, ' '),
        });
      }
    }
  } finally {
    lock.release();
  }
  return out;
}

/** Removes everything of a clone but `.studio/reports`; a link on the way is unlinked, not followed. */
function trimToReports(stateRoot: string, clone: string): void {
  for (const name of listDir(clone)) {
    if (name !== '.studio') removeStateEntry(stateRoot, join(clone, name));
  }
  const studio = join(clone, '.studio');
  if (lstatOr(studio)?.isDirectory() !== true) {
    removeStateEntry(stateRoot, studio);
    return;
  }
  for (const name of listDir(studio)) {
    if (name !== 'reports') removeStateEntry(stateRoot, join(studio, name));
  }
}

/** `1.2 GB`, `340 MB`, `12 kB`: decimal units, as `du -h --si` prints them. */
export function formatBytes(n: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return u === 0 ? `${v} B` : `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

/** Totals of a plan for `studio doctor` and `studio gc`. */
export function planTotals(plan: GcPlan): {
  clones: number;
  /** Disk use of every entry: clones, crew homes and tmp dirs. */
  bytes: number;
  removable: number;
  removableBytes: number;
  unchecked: number;
} {
  let bytes = 0;
  let removable = 0;
  let removableBytes = 0;
  let unchecked = 0;
  for (const e of plan.entries) {
    bytes += e.bytes ?? 0;
    if (e.verdict === 'remove' || e.verdict === 'trim') {
      removable++;
      removableBytes += e.bytes ?? 0;
    }
    if (e.verdict === 'unchecked') unchecked++;
  }
  const clones = plan.entries.filter((e) => e.clone).length;
  return { clones, bytes, removable, removableBytes, unchecked };
}

export interface GcRun extends ReturnType<typeof planTotals> {
  dryRun: boolean;
  entries: GcEntry[];
  problem?: string;
  /** What `--apply` (or the tick) did; absent in a dry run. */
  result?: GcResult;
}

/** Plans the clean-up for a project from its board and, with `apply`, carries it out. */
export async function runCloneGc(o: {
  stateRoot: string;
  ownerRoot: string;
  project: string;
  ports: Ports;
  apply: boolean;
  sizes: boolean;
  remote?: boolean;
  maxRemote?: number;
}): Promise<GcRun> {
  let board: Board | undefined;
  try {
    board = loadBoard(o.project);
  } catch {
    board = undefined;
  }
  const plan = await planCloneGc({
    stateRoot: o.stateRoot,
    board,
    ports: o.ports,
    now: o.ports.clock.now(),
    remote: o.remote ?? true,
    sizes: o.sizes,
    ...(o.maxRemote === undefined ? {} : { maxRemote: o.maxRemote }),
  });
  const run: GcRun = {
    dryRun: !o.apply,
    ...planTotals(plan),
    entries: plan.entries,
    ...(plan.problem === undefined ? {} : { problem: plan.problem }),
  };
  if (o.apply) {
    run.result = await applyCloneGc({
      stateRoot: o.stateRoot,
      ownerRoot: o.ownerRoot,
      plan,
      ports: o.ports,
    });
  }
  return run;
}

const clean = (t: string) => t.replace(/\p{Cc}/gu, ' ');

/** The text `studio gc` prints: one line per item, then the totals and what was done. */
export function gcLines(r: GcRun): string[] {
  const size = (e: GcEntry) => {
    if (e.bytes === undefined) return '';
    const parts = SIZE_PARTS.flatMap((p) =>
      e.parts?.[p] === undefined ? [] : [`${p} ${formatBytes(e.parts[p] as number)}`],
    );
    return ` ${formatBytes(e.bytes)}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}`;
  };
  const lines = r.entries.map(
    (e) => `${clean(e.item)}${size(e)}: ${e.verdict}, ${clean(e.reason)}`,
  );
  if (lines.length === 0) lines.push('no clones, crew homes or tmp dirs');
  lines.push(
    `clones: ${r.clones}, ${formatBytes(r.bytes)} with crew homes and tmp dirs; removable: ${r.removable}, ${formatBytes(r.removableBytes)}${r.unchecked > 0 ? `; ${r.unchecked} not checked on GitHub` : ''}`,
  );
  if (r.result === undefined) {
    if (r.removable > 0) lines.push('dry run: studio gc --apply removes them');
  } else {
    if (r.result.removed.length > 0) lines.push(`removed: ${r.result.removed.join(', ')}`);
    if (r.result.trimmed.length > 0) {
      lines.push(`trimmed to the report: ${r.result.trimmed.join(', ')}`);
    }
    for (const s of r.result.skipped) lines.push(`skipped ${s.item}: ${clean(s.reason)}`);
  }
  return lines;
}
