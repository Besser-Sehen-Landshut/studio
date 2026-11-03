import { createHash } from 'node:crypto';
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

// The update contract is one rule. `fits`: every file the contract reads is byte-identical to the
// recorded hash. Any change, or a new or missing file: `unclear`, and a person or the lead reads the
// diff. `conflict`: a licence file is missing or changed. Upstream text is never interpreted, and
// nothing from a source runs: it is cloned without hooks and links, and only `reads` reach a crew.

export type Verdict = 'fits' | 'unclear' | 'conflict';
export interface Finding {
  kind: string;
  detail: string;
}
export type Hashes = Record<string, string>;

const LICENSE_NAME = /^(?:(?:un)?licen[cs]e|copying|notice)(?:[-_.][a-z0-9._-]*)?$/i;
const SCRIPT_NAME = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;
const isLicenseName = (name: string): boolean => LICENSE_NAME.test(name) && !SCRIPT_NAME.test(name);

const clean = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 300);

/** The file's sha256, with no link anywhere below `dir`; undefined when it is not such a file. */
function hashOf(dir: string, rel: string): string | undefined {
  try {
    let at = dir;
    const segments = rel.split('/');
    for (const [i, seg] of segments.entries()) {
      at = join(at, seg);
      const st = lstatSync(at);
      if (st.isSymbolicLink()) return undefined;
      if (i < segments.length - 1 ? !st.isDirectory() : !st.isFile()) return undefined;
    }
    return createHash('sha256').update(readFileSync(at)).digest('hex');
  } catch {
    return undefined;
  }
}

function licenseFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => isLicenseName(n));
  } catch {
    return [];
  }
}

/** The hashes to record: the files the contract reads, and the licence files at the root. */
export function hashTree(dir: string, source: Source): Hashes {
  const hashes: Hashes = {};
  for (const rel of [...source.reads, ...licenseFiles(dir)]) {
    const hash = hashOf(dir, rel);
    if (hash !== undefined) hashes[rel] = hash;
  }
  return hashes;
}

/** A tree against the recorded hashes. Files outside the contract are never read, so never judged. */
export function compareToPin(
  pin: Hashes,
  dir: string,
  source: Source,
): { verdict: Verdict; findings: Finding[] } {
  const conflict: Finding[] = [];
  const unclear: Finding[] = [];
  const licenses = new Set(licenseFiles(dir));
  for (const name of Object.keys(pin)) if (isLicenseName(name)) licenses.add(name);
  for (const rel of source.reads) if (isLicenseName(rel)) licenses.add(rel);
  for (const name of licenses) {
    const now = hashOf(dir, name);
    if (now === undefined) {
      if (pin[name] !== undefined) conflict.push({ kind: 'license-missing', detail: clean(name) });
      else if (source.reads.includes(name)) unclear.push({ kind: 'missing', detail: clean(name) });
    } else if (now !== pin[name]) conflict.push({ kind: 'license-changed', detail: clean(name) });
  }
  for (const rel of source.reads) {
    if (licenses.has(rel)) continue;
    const now = hashOf(dir, rel);
    const was = pin[rel];
    if (now === undefined) unclear.push({ kind: 'missing', detail: clean(rel) });
    else if (was === undefined) unclear.push({ kind: 'new', detail: clean(rel) });
    else if (now !== was) unclear.push({ kind: 'changed', detail: clean(rel) });
  }
  const findings = [...conflict, ...unclear];
  const verdict = conflict.length > 0 ? 'conflict' : unclear.length > 0 ? 'unclear' : 'fits';
  return { verdict, findings };
}

const sourcesDir = (ownerRoot: string) => join(ownerRoot, 'sources');
const lockPath = (ownerRoot: string) => join(sourcesDir(ownerRoot), 'lock.json');

const lockSchema = z.record(
  z.string(),
  z.object({
    commit: z.string(),
    license: z.string(),
    fetchedAt: z.string(),
    hashes: z.record(z.string(), z.string()).optional(),
  }),
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

/** Why a fetched file must not reach a crew: it differs from what was recorded at the fetch. */
export function pinProblem(ownerRoot: string, id: string, rel: string): string | undefined {
  const want = readLock(ownerRoot)?.[id]?.hashes?.[rel];
  if (want === undefined) return 'it has no recorded hash';
  return hashOf(join(sourcesDir(ownerRoot), id), rel) === want ? undefined : 'differs from its pin';
}

const FULL_SHA = /^[0-9a-f]{40,64}$/;

/** No hooks and no links: nothing in the clone can run or point elsewhere. */
async function fetchTo(
  ports: Pick<Ports, 'git'>,
  ownerRoot: string,
  source: Source,
  name: string,
): Promise<string> {
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
    return commit;
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

/** Fetches what is missing and records its hashes; an explicit act. A present source stays. */
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
    const dir = join(sourcesDir(o.ownerRoot), source.id);
    if (exists(dir)) {
      out.push({ id: source.id, result: 'present' });
      continue;
    }
    try {
      // An unreadable lock holds pins nobody can see: never write over it.
      const lock = exists(lockPath(o.ownerRoot)) ? readLock(o.ownerRoot) : {};
      if (lock === undefined) throw new Error('the lock cannot be read');
      const fetching = `${source.id}.fetching`;
      const commit = await fetchTo(o.ports, o.ownerRoot, source, fetching);
      renameSync(join(sourcesDir(o.ownerRoot), fetching), dir);
      lock[source.id] = {
        commit,
        license: source.license,
        fetchedAt: o.ports.clock.now().toISOString(),
        hashes: hashTree(dir, source),
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

/** Judges upstream against the recorded hashes. Writes only `<id>.candidate`; adopts nothing. */
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
    const hashes = lock?.[source.id]?.hashes;
    if (pinned === undefined || hashes === undefined) {
      out.push(held(source.id, 'no-pin', 'the recorded hashes cannot be read'));
      continue;
    }
    let head: string | undefined;
    try {
      const remote = await o.ports.git.run(sourcesDir(o.ownerRoot), [
        'ls-remote',
        '--',
        source.url as string,
        'HEAD',
      ]);
      head = remote.split('\t')[0]?.trim();
    } catch {
      head = undefined;
    }
    if (head === undefined || !FULL_SHA.test(head)) {
      out.push(held(source.id, 'upstream-unreadable', 'upstream cannot be read', pinned));
      continue;
    }
    if (head === pinned) {
      out.push({ id: source.id, ...compareToPin(hashes, active, source), pinned });
      continue;
    }
    try {
      const candidate = await fetchTo(o.ports, o.ownerRoot, source, `${source.id}.candidate`);
      const candidateDir = join(sourcesDir(o.ownerRoot), `${source.id}.candidate`);
      out.push({ id: source.id, ...compareToPin(hashes, candidateDir, source), pinned, candidate });
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
  const lock = readLock(o.ownerRoot);
  const hashes = lock?.[source.id]?.hashes;
  if (lock === undefined || hashes === undefined) {
    return { id: source.id, applied: false, reason: 'the recorded hashes cannot be read' };
  }
  const r = compareToPin(hashes, candidate, source);
  if (r.verdict !== 'fits') return { id: source.id, applied: false, reason: `held: ${r.verdict}` };
  const commit = (await o.ports.git.run(candidate, ['rev-parse', 'HEAD'])).trim();
  if (!FULL_SHA.test(commit)) return { id: source.id, applied: false, reason: 'no commit' };
  const old = join(base, `${source.id}.old`);
  removeStateEntry(o.ownerRoot, old);
  renameSync(active, old);
  try {
    renameSync(candidate, active);
  } catch (e) {
    renameSync(old, active);
    throw e;
  }
  removeStateEntry(o.ownerRoot, old);
  lock[source.id] = {
    commit,
    license: source.license,
    fetchedAt: o.ports.clock.now().toISOString(),
    hashes,
  };
  writeLock(o.ownerRoot, lock);
  return { id: source.id, applied: true };
}
