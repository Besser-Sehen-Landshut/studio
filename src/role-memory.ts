import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ROLE_TEMPLATES } from './config.js';
import { acquireStateLock, assertStatePath, writeStateFile } from './paths.js';

export const MAX_LESSON_LINES = 40;
export const MAX_LESSON_CHARS = 300;
export const MAX_PENDING = 200;
const MAX_PER_REPORT = 10;
const HEADING = '## Lessons';

/** A crew's lesson reaches every later crew of its role: one plain line, no markup, bounded. */
export function sanitizeLesson(text: string): string | undefined {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const plain = flat.replace(/^(?:[#>*+-]+\s*)+/, '').trim();
  return plain === '' ? undefined : plain.slice(0, MAX_LESSON_CHARS);
}

/** Where a proposal came from, as Studio recorded it: never crew text. */
const evidenceSchema = z.object({
  /** The report file, relative to the state root. */
  report: z.string().optional(),
  /** The pull request the run opened or reviewed, `<owner>/<repo>#<n>`. */
  pr: z.string().optional(),
});
const proposalSchema = z.object({
  n: z.number().int().positive(),
  role: z.string(),
  item: z.string(),
  text: z.string(),
  at: z.string(),
  evidence: evidenceSchema.optional(),
  /** Near-identical proposals of other runs that were folded into this one. */
  alsoFrom: z.array(evidenceSchema.extend({ item: z.string() })).optional(),
});
const judgedSchema = z.object({
  n: z.number().int().positive(),
  role: z.string(),
  verdict: z.enum(['accepted', 'dropped', 'duplicate']),
  reason: z.string().optional(),
  at: z.string(),
});
const fileSchema = z.object({
  next: z.number().int().positive(),
  lessons: z.array(proposalSchema),
  /** What became of proposals: the lessons review reads it to close its item. */
  judged: z.array(judgedSchema).optional(),
});
export type Proposal = z.infer<typeof proposalSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Judged = z.infer<typeof judgedSchema>;
type LessonsFile = z.infer<typeof fileSchema>;

/** How many verdicts the file keeps; the oldest go first. */
const MAX_JUDGED = 500;
const PR_REF = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[1-9]\d{0,9}$/;
// A report in a crew clone, or one a worker handed back on its claim (src/worker.ts).
const REPORT_REF =
  /^(?:clones\/[A-Z]+-\d+\/\.studio\/reports\/[A-Za-z0-9._-]{1,100}|refs\/studio\/claims\/[A-Z]+-\d+@[0-9a-f]{12,40})$/;

/** Only references of the shapes Studio writes; anything else is left out. */
function cleanEvidence(e: Evidence | undefined): Evidence | undefined {
  if (e === undefined) return undefined;
  const out: Evidence = {
    ...(e.report !== undefined && REPORT_REF.test(e.report) ? { report: e.report } : {}),
    ...(e.pr !== undefined && PR_REF.test(e.pr) ? { pr: e.pr } : {}),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

const lessonsFile = (stateRoot: string) => join(stateRoot, 'lessons.json');
export const LESSONS_LOCK = 'lessons.lock';
export const LESSONS_LOCK_STALE_MS = 30_000;

function readFile(stateRoot: string): LessonsFile {
  const file = lessonsFile(stateRoot);
  assertStatePath(stateRoot, file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { next: 1, lessons: [] };
    throw new Error('lessons.json cannot be read');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('lessons.json is not valid JSON');
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error('lessons.json has the wrong shape');
  return parsed.data;
}

const writeFile_ = (stateRoot: string, data: LessonsFile): void =>
  writeStateFile(stateRoot, lessonsFile(stateRoot), `${JSON.stringify(data, null, 2)}\n`);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reads, changes and writes lessons.json under a short lock, so a collect in the tick and a
 * `lessons accept` of the lead never overwrite each other. Waits up to 5 s.
 */
function updateFile<T>(stateRoot: string, fn: (data: LessonsFile) => T): T {
  const until = Date.now() + 5000;
  for (;;) {
    const lock = acquireStateLock(stateRoot, LESSONS_LOCK, {
      now: new Date(),
      heartbeatStaleMs: LESSONS_LOCK_STALE_MS,
    });
    if (lock) {
      try {
        return fn(readFile(stateRoot));
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= until) throw new Error(`lessons.json is locked (${LESSONS_LOCK}); try again`);
    sleepSync(25);
  }
}

function judge(data: LessonsFile, entry: Judged): void {
  data.judged = [...(data.judged ?? []), entry].slice(-MAX_JUDGED);
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Stores a crew's lessons as proposals; only `acceptLesson` puts one into a role file. */
export function proposeLessons(
  stateRoot: string,
  role: string,
  item: string,
  lessons: readonly string[],
  now: Date,
  evidence?: Evidence,
): number {
  const ev = cleanEvidence(evidence);
  return updateFile(stateRoot, (data) => {
    let added = 0;
    for (const raw of lessons.slice(0, 50)) {
      if (added >= MAX_PER_REPORT || data.lessons.length >= MAX_PENDING) break;
      const text = sanitizeLesson(raw);
      if (text === undefined) continue;
      if (data.lessons.some((l) => l.role === role && same(l.text, text))) continue;
      data.lessons.push({
        n: data.next++,
        role,
        item,
        text,
        at: now.toISOString(),
        ...(ev === undefined ? {} : { evidence: ev }),
      });
      added++;
    }
    if (added > 0) writeFile_(stateRoot, data);
    return added;
  });
}

export const listLessons = (stateRoot: string): Proposal[] => readFile(stateRoot).lessons;

/** What became of proposals, oldest first. */
export const judgedLessons = (stateRoot: string): Judged[] => readFile(stateRoot).judged ?? [];

/** How long ago `at` was, in whole minutes, hours or days (`45m`, `5h`, `3d`); `?` when unknown. */
export function lessonAge(at: string, now: Date): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return '?';
  const minutes = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

export type LessonRow = Pick<
  Proposal,
  'n' | 'role' | 'item' | 'at' | 'text' | 'evidence' | 'alsoFrom'
> & { age: string };

/** The proposals for `studio lessons`: each with its age, source item and evidence. */
export function describeLessons(stateRoot: string, now: Date): LessonRow[] {
  return listLessons(stateRoot).map((l) => ({
    n: l.n,
    role: l.role,
    item: l.item,
    age: lessonAge(l.at, now),
    at: l.at,
    ...(l.evidence === undefined ? {} : { evidence: l.evidence }),
    ...(l.alsoFrom === undefined ? {} : { alsoFrom: l.alsoFrom }),
    text: l.text,
  }));
}

/** The text a lesson is compared by: lower case, letters and digits, single spaces. */
export function normalizeLesson(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Folds near-identical proposals of one role (same `normalizeLesson`) into the oldest one, which
 * keeps the others' items and evidence; the others are judged `duplicate`. Returns what was folded.
 */
export function mergeDuplicateLessons(
  stateRoot: string,
  now: Date,
): { kept: number; merged: number[] }[] {
  return updateFile(stateRoot, (data) => {
    const out: { kept: number; merged: number[] }[] = [];
    const first = new Map<string, Proposal>();
    const keep: Proposal[] = [];
    for (const l of [...data.lessons].sort((a, b) => a.n - b.n)) {
      const key = `${l.role}\u0000${normalizeLesson(l.text)}`;
      const kept = first.get(key);
      if (kept === undefined) {
        first.set(key, l);
        keep.push(l);
        continue;
      }
      kept.alsoFrom = [...(kept.alsoFrom ?? []), { item: l.item, ...(l.evidence ?? {}) }].slice(
        0,
        20,
      );
      judge(data, {
        n: l.n,
        role: l.role,
        verdict: 'duplicate',
        reason: `same as ${kept.n}`,
        at: now.toISOString(),
      });
      const row = out.find((o) => o.kept === kept.n);
      if (row) row.merged.push(l.n);
      else out.push({ kept: kept.n, merged: [l.n] });
    }
    if (out.length > 0) writeFile_(stateRoot, { ...data, lessons: keep });
    return out;
  });
}

/** Discards a proposal; the reason (one plain line) is kept with the verdict. */
export function dropLesson(stateRoot: string, n: number, reason?: string, now = new Date()): void {
  updateFile(stateRoot, (data) => {
    const proposal = data.lessons.find((l) => l.n === n);
    if (!proposal) throw new Error(`no proposed lesson ${n}`);
    const why = reason === undefined ? undefined : sanitizeLesson(reason);
    judge(data, {
      n,
      role: proposal.role,
      verdict: 'dropped',
      ...(why === undefined ? {} : { reason: why }),
      at: now.toISOString(),
    });
    writeFile_(stateRoot, { ...data, lessons: data.lessons.filter((l) => l.n !== n) });
  });
}

/**
 * The one way to the role file: the role must be a template, and no segment below the project may
 * be a link. A missing segment is fine: the reader sees an empty file, the writer creates it.
 */
function roleFile(projectDir: string, role: string): string {
  if (!(ROLE_TEMPLATES as readonly string[]).includes(role)) {
    throw new Error('not a role template');
  }
  let at = projectDir;
  const segments = ['.studio', 'roles', `${role}.md`];
  for (const [i, seg] of segments.entries()) {
    at = join(at, seg);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(at);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return join(projectDir, ...segments);
      throw new Error(`the role file cannot be reached (${(e as NodeJS.ErrnoException).code})`);
    }
    if (st.isSymbolicLink()) throw new Error(`${at} is a link; refusing`);
    if (i < segments.length - 1 ? !st.isDirectory() : !st.isFile()) {
      throw new Error(`${at} is not what a role file needs; refusing`);
    }
  }
  return at;
}

function readRole(projectDir: string, role: string): string {
  const file = roleFile(projectDir, role);
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

function writeRole(projectDir: string, role: string, text: string): void {
  const file = roleFile(projectDir, role);
  mkdirSync(dirname(file), { recursive: true });
  // The folders may have just been made: look again before writing through them.
  roleFile(projectDir, role);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

interface Parts {
  before: string[];
  lessons: string[];
  after: string[];
  found: boolean;
}

/** Splits a role file at the Lessons section; a section ends at the next `## ` heading. */
function split(text: string): Parts {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === HEADING);
  if (start === -1) return { before: lines, lessons: [], after: [], found: false };
  let end = lines.findIndex((l, i) => i > start && /^##? /.test(l));
  if (end === -1) end = lines.length;
  return {
    before: lines.slice(0, start),
    lessons: lines.slice(start + 1, end).filter((l) => l.trim() !== ''),
    after: lines.slice(end),
    found: true,
  };
}

function join_(p: Parts): string {
  const head = p.before.join('\n').trimEnd();
  const tail = p.after.join('\n').trim();
  return [
    ...(head === '' ? [] : [head, '']),
    HEADING,
    '',
    ...p.lessons,
    ...(tail === '' ? [] : ['', tail]),
    '',
  ].join('\n');
}

/** Moves a proposal into its role file. The lead commits the file. */
export function acceptLesson(
  projectDir: string,
  stateRoot: string,
  n: number,
  now = new Date(),
): { role: string; text: string; lines: number } {
  return updateFile(stateRoot, (data) => {
    const proposal = data.lessons.find((l) => l.n === n);
    if (!proposal) throw new Error(`no proposed lesson ${n}`);
    // Only the cleaned text line goes into the file: never the evidence, never markup.
    const text = sanitizeLesson(proposal.text);
    if (text === undefined) throw new Error(`proposed lesson ${n} is empty`);
    const parts = split(readRole(projectDir, proposal.role));
    const known = parts.lessons.some((l) => same(l.replace(/^- /, ''), text));
    if (!known) {
      if (parts.lessons.length >= MAX_LESSON_LINES) {
        throw new Error(
          `the Lessons of ${proposal.role} are full (${MAX_LESSON_LINES} lines): prune one first`,
        );
      }
      parts.lessons.push(`- ${text}`);
      writeRole(projectDir, proposal.role, join_(parts));
    }
    judge(data, { n, role: proposal.role, verdict: 'accepted', at: now.toISOString() });
    writeFile_(stateRoot, { ...data, lessons: data.lessons.filter((l) => l.n !== n) });
    return { role: proposal.role, text, lines: parts.lessons.length };
  });
}

/** Removes the line'th lesson (from 1) of a role. */
export function pruneLesson(projectDir: string, role: string, line: number): void {
  const parts = split(readRole(projectDir, role));
  if (!Number.isInteger(line) || line < 1 || line > parts.lessons.length) {
    throw new Error(`${role} has no lesson ${line}`);
  }
  parts.lessons.splice(line - 1, 1);
  writeRole(projectDir, role, join_(parts));
}

/**
 * The role file for a brief: its instructions, and apart from them the lessons, which are crew
 * output. Each lesson is cleaned again, and a file edited past the cap shows only the newest.
 */
export function readRoleMemory(
  projectDir: string,
  role: string,
): { brief: string; lessons: string[]; cut: boolean } {
  const parts = split(readRole(projectDir, role));
  const instructions = parts.found
    ? [...parts.before, ...parts.after]
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : parts.before.join('\n').trim();
  const lessons = parts.lessons.flatMap((l) => sanitizeLesson(l) ?? []);
  return {
    brief: instructions,
    lessons: lessons.slice(-MAX_LESSON_LINES),
    cut: lessons.length > MAX_LESSON_LINES,
  };
}
