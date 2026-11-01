import { lstatSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { capabilitiesDir } from './capabilities.js';
import { ensureStateDir, removeStateEntry, writeStateFile } from './paths.js';
import type { Ports } from './ports.js';

const VENDORABLE = ['MIT', 'Apache-2.0'];

const safeRelative = (p: string): boolean =>
  p.length > 0 &&
  !p.startsWith('/') &&
  !p.includes('\\') &&
  !p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.') &&
  !/\p{Cc}/u.test(p);

export const sourceSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    kind: z.enum(['git', 'plugin', 'skill']),
    url: z
      .string()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
        'must be a GitHub https URL',
      )
      .optional(),
    license: z.string().min(1),
    vendored: z.boolean(),
    notice: z.string().optional(),
    reads: z.array(z.string().refine(safeRelative, 'must stay inside the source')),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'git' && s.url === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a git source needs a url', path: ['url'] });
    }
    if (s.vendored && !VENDORABLE.includes(s.license)) {
      ctx.addIssue({ code: 'custom', message: 'only MIT or Apache-2.0 may be vendored' });
    }
    if (s.vendored && s.notice === undefined) {
      ctx.addIssue({ code: 'custom', message: 'vendored content needs its notice' });
    }
  });

export const sourcesSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(z.string()).default([]),
  sources: z.array(sourceSchema),
});

export type Source = z.infer<typeof sourceSchema>;
export type SourcesFile = z.infer<typeof sourcesSchema>;

export class SourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcesError';
  }
}

/** Reads `SOURCES.yaml`; anything missing or malformed throws. */
export function loadSources(dir: string = capabilitiesDir()): SourcesFile {
  const file = join(dir, 'SOURCES.yaml');
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new SourcesError(`${file}: cannot read (${(e as Error).message.split('\n')[0]})`);
  }
  const parsed = sourcesSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new SourcesError(`${file}: invalid at ${where}`);
  }
  const ids = new Set<string>();
  for (const s of parsed.data.sources) {
    if (ids.has(s.id)) throw new SourcesError(`${file}: duplicate source id ${s.id}`);
    ids.add(s.id);
  }
  return parsed.data;
}

// The update contract. Nothing from a source ever runs: it is cloned without hooks and links, then
// read as text. `fits` still changes nothing until `sources apply`; `unclear` and `conflict` hold.

export type Verdict = 'fits' | 'unclear' | 'conflict';
export interface Finding {
  kind: string;
  detail: string;
}

const MAX_TREE_FILES = 50_000;
const MAX_SCAN_BYTES = 1024 * 1024;
const LICENSE_NAME = /^(licen[cs]e|copying)(\.[a-z]+)?$/i;
const COPYLEFT =
  /GNU (AFFERO |LESSER )?GENERAL PUBLIC|GNU LESSER|\bA?L?GPL-|Mozilla Public License|Server Side Public License|Business Source License/i;
const HOOK_PATH = /(^|\/)hooks\.json$|(^|\/)hooks\/|(^|\/)\.claude\/settings[^/]*\.json$/;
const MAX_LINE_CHARS = 4096;
const MAX_FRONT_LINES = 200;
// Anything that may install or fetch and run. Wide on purpose: a false alarm costs one look, a miss
// runs code. Plain alternations on lines of bounded length, so upstream text cannot slow them down.
const INSTALL_TOKEN =
  /\b(?:npm|npx|pnpm|yarn|bun|bunx|pip3?|pipx|uvx?|brew|cargo|apt|apt-get|gem|curl|wget|iwr|invoke-webrequest)\b|chmod \+x|\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i;
const SCRIPT = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/;
const NETWORK = /\b(?:curl|wget|fetch\(|urllib|requests\.|http\.get|https?:\/\/)/;

const clean = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 300);

interface Entry {
  size: number;
  link: boolean;
}

/** Every entry below `dir` without following links; `.git` is not part of a tree. */
function walk(dir: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const open = [''];
  while (open.length > 0) {
    const rel = open.pop() as string;
    for (const name of readdirSync(join(dir, rel))) {
      if (rel === '' && name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) out.set(path, { size: 0, link: true });
      else if (st.isDirectory()) open.push(path);
      else if (st.isFile()) out.set(path, { size: st.size, link: false });
      if (out.size > MAX_TREE_FILES) throw new Error('tree too large');
    }
  }
  return out;
}

const readBounded = (dir: string, path: string, e: Entry | undefined): string | undefined =>
  e && !e.link && e.size <= MAX_SCAN_BYTES ? readFileSync(join(dir, path), 'utf8') : undefined;

const normalizeLine = (line: string): string => line.trim().replace(/\s+/g, ' ');

/** Normalized lines; undefined when one is too long to run a pattern over. */
function linesOf(text: string | undefined): string[] | undefined {
  const lines: string[] = [];
  for (const raw of (text ?? '').split('\n')) {
    if (raw.length > MAX_LINE_CHARS) return undefined;
    lines.push(normalizeLine(raw));
  }
  return lines;
}

/** Front matter from the very start of the file, closed within a bounded number of lines. */
function frontMatter(lines: readonly string[]): 'none' | 'open' | 'plain' | 'hooks' {
  if (lines[0] !== '---') return 'none';
  const end = lines.indexOf('---', 1);
  if (end === -1 || end > MAX_FRONT_LINES) return 'open';
  return lines.slice(1, end).some((l) => l === 'hooks:' || l.startsWith('hooks: '))
    ? 'hooks'
    : 'plain';
}

/** The verdict for a candidate against the active tree. A read error is `unclear`, never `fits`. */
export function compareTrees(
  oldDir: string,
  newDir: string,
  source: Source,
  opts: { newLinks?: readonly string[] } = {},
): { verdict: Verdict; findings: Finding[] } {
  const conflict: Finding[] = [];
  const unclear: Finding[] = [];
  try {
    const before = walk(oldDir);
    const after = walk(newDir);
    for (const read of source.reads) {
      const e = after.get(read);
      if (e === undefined || e.link) conflict.push({ kind: 'read-missing', detail: clean(read) });
      else {
        const was = before.get(read);
        if (was && e.size > was.size * 2) unclear.push({ kind: 'read-grew', detail: clean(read) });
      }
    }
    for (const [path, e] of before) {
      if (!path.includes('/') && LICENSE_NAME.test(path) && !e.link && !after.has(path)) {
        conflict.push({ kind: 'license-removed', detail: clean(path) });
      }
    }
    for (const [path, e] of after) {
      const was = before.get(path);
      if (e.link) {
        if (!was?.link) unclear.push({ kind: 'symlink', detail: clean(path) });
        continue;
      }
      const text = readBounded(newDir, path, e);
      const old = readBounded(oldDir, path, was);
      const changed = was === undefined || was.link || text !== old || text === undefined;
      if (!changed) continue;
      if (!path.includes('/') && LICENSE_NAME.test(path)) {
        if (text !== undefined && COPYLEFT.test(text) && !COPYLEFT.test(old ?? '')) {
          conflict.push({ kind: 'license-copyleft', detail: clean(path) });
        } else unclear.push({ kind: 'license-changed', detail: clean(path) });
      }
      if (HOOK_PATH.test(path)) unclear.push({ kind: 'hook', detail: clean(path) });
      const lines = linesOf(text);
      if (lines === undefined) {
        unclear.push({ kind: 'long-line', detail: clean(path) });
      } else if (text !== undefined) {
        const knownLines = linesOf(old) ?? [];
        const front = frontMatter(lines);
        if (front === 'open') unclear.push({ kind: 'front-matter', detail: clean(path) });
        if (front === 'hooks' && frontMatter(knownLines) !== 'hooks') {
          unclear.push({ kind: 'hook', detail: clean(path) });
        }
        const known = new Set(knownLines);
        for (const line of lines) {
          if (!known.has(line) && INSTALL_TOKEN.test(line)) {
            unclear.push({ kind: 'install-step', detail: clean(`${path}: ${line}`) });
          }
        }
        if (was === undefined && SCRIPT.test(path) && lines.some((l) => NETWORK.test(l))) {
          unclear.push({ kind: 'network-script', detail: clean(path) });
        }
      }
      if (text === undefined) unclear.push({ kind: 'too-large', detail: clean(path) });
    }
    for (const link of opts.newLinks ?? []) unclear.push({ kind: 'symlink', detail: clean(link) });
  } catch (e) {
    unclear.push({ kind: 'unreadable', detail: clean((e as Error).message) });
  }
  const findings = [...conflict, ...unclear];
  const verdict = conflict.length > 0 ? 'conflict' : unclear.length > 0 ? 'unclear' : 'fits';
  return { verdict, findings };
}

const sourcesDir = (ownerRoot: string) => join(ownerRoot, 'sources');
const lockPath = (ownerRoot: string) => join(sourcesDir(ownerRoot), 'lock.json');

const lockSchema = z.record(
  z.string(),
  z.object({ commit: z.string(), license: z.string(), fetchedAt: z.string() }),
);
type Lock = z.infer<typeof lockSchema>;

function readLock(ownerRoot: string): Lock | undefined {
  try {
    const parsed = lockSchema.safeParse(JSON.parse(readFileSync(lockPath(ownerRoot), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const writeLock = (ownerRoot: string, lock: Lock): void =>
  writeStateFile(ownerRoot, lockPath(ownerRoot), `${JSON.stringify(lock, null, 2)}\n`);

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const FULL_SHA = /^[0-9a-f]{40,64}$/;

/** No hooks and no links: nothing in the clone can run or point elsewhere. */
async function fetchTo(
  ports: Pick<Ports, 'git'>,
  ownerRoot: string,
  source: Source,
  name: string,
): Promise<{ commit: string; links: string[] }> {
  const base = sourcesDir(ownerRoot);
  const dest = join(base, name);
  removeStateEntry(ownerRoot, dest);
  try {
    await ports.git.run(base, [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.symlinks=false',
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--',
      source.url as string,
      name,
    ]);
    const commit = (await ports.git.run(dest, ['rev-parse', 'HEAD'])).trim();
    if (!FULL_SHA.test(commit)) throw new Error('no commit');
    const staged = await ports.git.run(dest, ['ls-files', '--stage']);
    const links = staged
      .split('\n')
      .filter((l) => l.startsWith('120000 '))
      .map((l) => l.slice(l.indexOf('\t') + 1));
    return { commit, links };
  } catch (e) {
    removeStateEntry(ownerRoot, dest);
    throw e;
  }
}

function pick(index: SourcesFile, only: readonly string[] | undefined): Source[] {
  for (const id of only ?? []) {
    if (!index.sources.some((s) => s.id === id && s.kind === 'git')) {
      throw new SourcesError(`unknown source ${clean(id)}`);
    }
  }
  return index.sources.filter(
    (s) => s.kind === 'git' && !s.vendored && (only === undefined || only.includes(s.id)),
  );
}

/** Fetches what is missing. An explicit act of `studio setup sources`; a present source stays. */
export async function setupSources(o: {
  ownerRoot: string;
  index: SourcesFile;
  ports: Pick<Ports, 'git' | 'clock'>;
  only?: readonly string[];
}): Promise<{ id: string; result: 'fetched' | 'present' | 'failed'; commit?: string }[]> {
  const out: { id: string; result: 'fetched' | 'present' | 'failed'; commit?: string }[] = [];
  const list = pick(o.index, o.only);
  ensureStateDir(o.ownerRoot, sourcesDir(o.ownerRoot));
  for (const source of list) {
    if (exists(join(sourcesDir(o.ownerRoot), source.id))) {
      out.push({ id: source.id, result: 'present' });
      continue;
    }
    try {
      const { commit } = await fetchTo(o.ports, o.ownerRoot, source, source.id);
      const lock = readLock(o.ownerRoot) ?? {};
      lock[source.id] = {
        commit,
        license: source.license,
        fetchedAt: o.ports.clock.now().toISOString(),
      };
      writeLock(o.ownerRoot, lock);
      out.push({ id: source.id, result: 'fetched', commit });
    } catch {
      out.push({ id: source.id, result: 'failed' });
    }
  }
  return out;
}

export interface CheckResult {
  id: string;
  verdict: Verdict;
  findings: Finding[];
  pinned?: string;
  candidate?: string;
}

const held = (id: string, kind: string, detail: string, pinned?: string): CheckResult => ({
  id,
  verdict: 'unclear',
  findings: [{ kind, detail }],
  ...(pinned === undefined ? {} : { pinned }),
});

/** Judges upstream against the pin. Writes only `<id>.candidate`; never adopts anything. */
export async function checkSources(o: {
  ownerRoot: string;
  index: SourcesFile;
  ports: Pick<Ports, 'git'>;
}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const list = pick(o.index, undefined);
  const lock = readLock(o.ownerRoot);
  for (const source of list) {
    const active = join(sourcesDir(o.ownerRoot), source.id);
    if (!exists(active)) {
      out.push(held(source.id, 'not-fetched', 'run studio setup sources'));
      continue;
    }
    const pinned = lock?.[source.id]?.commit;
    if (pinned === undefined) {
      out.push(held(source.id, 'no-pin', 'the pinned commit cannot be read'));
      continue;
    }
    let head: string | undefined;
    try {
      head = (
        await o.ports.git.run(sourcesDir(o.ownerRoot), [
          'ls-remote',
          '--',
          source.url as string,
          'HEAD',
        ])
      )
        .split('\t')[0]
        ?.trim();
    } catch {
      head = undefined;
    }
    if (head === undefined || !FULL_SHA.test(head)) {
      out.push(held(source.id, 'upstream-unreadable', 'upstream cannot be read', pinned));
      continue;
    }
    if (head === pinned) {
      out.push({ id: source.id, verdict: 'fits', findings: [], pinned });
      continue;
    }
    try {
      const got = await fetchTo(o.ports, o.ownerRoot, source, `${source.id}.candidate`);
      const candidateDir = join(sourcesDir(o.ownerRoot), `${source.id}.candidate`);
      const r = compareTrees(active, candidateDir, source, { newLinks: got.links });
      out.push({ id: source.id, ...r, pinned, candidate: got.commit });
    } catch {
      out.push(held(source.id, 'fetch-failed', 'the candidate could not be fetched', pinned));
    }
  }
  return out;
}

/** Adopts a candidate only if it is judged `fits` right now. Held ones stay held. */
export async function applySource(o: {
  ownerRoot: string;
  index: SourcesFile;
  ports: Pick<Ports, 'git' | 'clock'>;
  id: string;
}): Promise<{ id: string; applied: boolean; reason?: string }> {
  const source = pick(o.index, [o.id])[0];
  if (source === undefined) throw new SourcesError(`unknown source ${clean(o.id)}`);
  const base = sourcesDir(o.ownerRoot);
  const active = join(base, source.id);
  const candidate = join(base, `${source.id}.candidate`);
  if (!exists(active) || !exists(candidate)) {
    return { id: source.id, applied: false, reason: 'no candidate: run studio sources check' };
  }
  const links = (await o.ports.git.run(candidate, ['ls-files', '--stage']))
    .split('\n')
    .filter((l) => l.startsWith('120000 '))
    .map((l) => l.slice(l.indexOf('\t') + 1));
  const r = compareTrees(active, candidate, source, { newLinks: links });
  if (r.verdict !== 'fits') {
    return { id: source.id, applied: false, reason: `held: ${r.verdict}` };
  }
  const commit = (await o.ports.git.run(candidate, ['rev-parse', 'HEAD'])).trim();
  if (!FULL_SHA.test(commit)) return { id: source.id, applied: false, reason: 'no commit' };
  const lock = readLock(o.ownerRoot);
  if (lock === undefined)
    return { id: source.id, applied: false, reason: 'the lock cannot be read' };
  const old = join(base, `${source.id}.old`);
  removeStateEntry(o.ownerRoot, old);
  renameSync(active, old);
  renameSync(candidate, active);
  removeStateEntry(o.ownerRoot, old);
  lock[source.id] = {
    commit,
    license: source.license,
    fetchedAt: o.ports.clock.now().toISOString(),
  };
  writeLock(o.ownerRoot, lock);
  return { id: source.id, applied: true };
}
