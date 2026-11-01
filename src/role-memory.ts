import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ROLE_TEMPLATES } from './config.js';
import { assertStatePath, writeStateFile } from './paths.js';

export const MAX_LESSON_LINES = 40;
export const MAX_LESSON_CHARS = 300;
export const MAX_PENDING = 200;
const MAX_PER_REPORT = 10;
const HEADING = '## Lessons';
const CUT_NOTE = '(older lessons cut)';

/** A crew's lesson reaches every later crew of its role: one plain line, no markup, bounded. */
export function sanitizeLesson(text: string): string | undefined {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const plain = flat.replace(/^(?:[#>*+-]+\s*)+/, '').trim();
  return plain === '' ? undefined : plain.slice(0, MAX_LESSON_CHARS);
}

const proposalSchema = z.object({
  n: z.number().int().positive(),
  role: z.string(),
  item: z.string(),
  text: z.string(),
  at: z.string(),
});
const fileSchema = z.object({
  next: z.number().int().positive(),
  lessons: z.array(proposalSchema),
});
export type Proposal = z.infer<typeof proposalSchema>;

const lessonsFile = (stateRoot: string) => join(stateRoot, 'lessons.json');

function readFile(stateRoot: string): z.infer<typeof fileSchema> {
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

const writeFile_ = (stateRoot: string, data: z.infer<typeof fileSchema>): void =>
  writeStateFile(stateRoot, lessonsFile(stateRoot), `${JSON.stringify(data, null, 2)}\n`);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Stores a crew's lessons as proposals; only `acceptLesson` puts one into a role file. */
export function proposeLessons(
  stateRoot: string,
  role: string,
  item: string,
  lessons: readonly string[],
  now: Date,
): number {
  const data = readFile(stateRoot);
  let added = 0;
  for (const raw of lessons.slice(0, 50)) {
    if (added >= MAX_PER_REPORT || data.lessons.length >= MAX_PENDING) break;
    const text = sanitizeLesson(raw);
    if (text === undefined) continue;
    if (data.lessons.some((l) => l.role === role && same(l.text, text))) continue;
    data.lessons.push({ n: data.next++, role, item, text, at: now.toISOString() });
    added++;
  }
  if (added > 0) writeFile_(stateRoot, data);
  return added;
}

export const listLessons = (stateRoot: string): Proposal[] => readFile(stateRoot).lessons;

export function dropLesson(stateRoot: string, n: number): void {
  const data = readFile(stateRoot);
  if (!data.lessons.some((l) => l.n === n)) throw new Error(`no proposed lesson ${n}`);
  writeFile_(stateRoot, { ...data, lessons: data.lessons.filter((l) => l.n !== n) });
}

function roleFile(projectDir: string, role: string): string {
  if (!(ROLE_TEMPLATES as readonly string[]).includes(role)) {
    throw new Error('not a role template');
  }
  return join(projectDir, '.studio', 'roles', `${role}.md`);
}

function readRole(file: string): string {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('the role file is a link or not a regular file; refusing');
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
  return readFileSync(file, 'utf8');
}

function writeRole(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
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
): { role: string; text: string; lines: number } {
  const data = readFile(stateRoot);
  const proposal = data.lessons.find((l) => l.n === n);
  if (!proposal) throw new Error(`no proposed lesson ${n}`);
  const file = roleFile(projectDir, proposal.role);
  const text = sanitizeLesson(proposal.text);
  if (text === undefined) throw new Error(`proposed lesson ${n} is empty`);
  const parts = split(readRole(file));
  const known = parts.lessons.some((l) => same(l.replace(/^- /, ''), text));
  if (!known) {
    if (parts.lessons.length >= MAX_LESSON_LINES) {
      throw new Error(
        `the Lessons of ${proposal.role} are full (${MAX_LESSON_LINES} lines): prune one first`,
      );
    }
    parts.lessons.push(`- ${text}`);
    writeRole(file, join_(parts));
  }
  writeFile_(stateRoot, { ...data, lessons: data.lessons.filter((l) => l.n !== n) });
  return { role: proposal.role, text, lines: parts.lessons.length };
}

/** Removes the line'th lesson (from 1) of a role. */
export function pruneLesson(projectDir: string, role: string, line: number): void {
  const file = roleFile(projectDir, role);
  const parts = split(readRole(file));
  if (!Number.isInteger(line) || line < 1 || line > parts.lessons.length) {
    throw new Error(`${role} has no lesson ${line}`);
  }
  parts.lessons.splice(line - 1, 1);
  writeRole(file, join_(parts));
}

/** The role file for a brief; a file edited past the cap shows only its newest lessons. */
export function readRoleBrief(projectDir: string, role: string): string {
  const file = join(projectDir, '.studio', 'roles', `${role}.md`);
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  const parts = split(text);
  if (parts.lessons.length <= MAX_LESSON_LINES) return text.trim();
  return join_({
    ...parts,
    lessons: [CUT_NOTE, ...parts.lessons.slice(-MAX_LESSON_LINES)],
  }).trim();
}
