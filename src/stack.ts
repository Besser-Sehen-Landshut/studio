import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { camelizeKeys, loadConfig, studioConfigSchema } from './config.js';
import { safe, writeAtomic } from './setup-ci-command.js';

export const STACK_IDS = [
  'nextjs',
  'shadcn',
  'postgres',
  'ios',
  'winui',
  'rust',
  'tauri',
  'android',
  'expo',
  'svelte',
  'web',
  'docker',
  'gha',
  'better-auth',
  'stripe',
  'fastify',
  'ai-sdk',
  'playwright',
  'wordpress',
  'tailwind',
] as const;

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 200;
const MONOREPO_DIRS = ['apps', 'packages', 'crates', 'services'];
const OTHER_WEB = ['nextjs', 'shadcn', 'svelte'];

const DEP_STACKS: Record<string, string> = {
  next: 'nextjs',
  pg: 'postgres',
  postgres: 'postgres',
  'react-native': 'expo',
  expo: 'expo',
  svelte: 'svelte',
  'better-auth': 'better-auth',
  stripe: 'stripe',
  fastify: 'fastify',
  ai: 'ai-sdk',
  '@playwright/test': 'playwright',
  playwright: 'playwright',
  tailwindcss: 'tailwind',
};

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A regular file, not followed through a link, of at most 1 MiB; else undefined. */
function readSmall(path: string, notes: string[], name: string): string | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return undefined;
    if (st.size > MAX_FILE_BYTES) {
      notes.push(`${name}: larger than 1 MiB, not read`);
      return undefined;
    }
    return readFileSync(path, 'utf8');
  } catch {
    notes.push(`${name}: cannot be read`);
    return undefined;
  }
}

const isFileEntry = (dir: string, name: string): boolean => {
  try {
    return lstatSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
};

function depStacks(text: string, notes: string[], name: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    notes.push(`${name}: not valid JSON`);
    return [];
  }
  if (raw === null || typeof raw !== 'object') return [];
  const out: string[] = [];
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = (raw as Record<string, unknown>)[key];
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const dep of Object.keys(deps)) {
      const stack = DEP_STACKS[dep];
      if (stack !== undefined) out.push(stack);
    }
  }
  return out;
}

function scanDir(dir: string, label: string, found: Set<string>, notes: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).slice(0, MAX_ENTRIES * 5);
  } catch {
    notes.push(`${label || '.'}: cannot be read`);
    return;
  }
  const file = (n: string) => isFileEntry(dir, n);
  const read = (n: string) => readSmall(join(dir, n), notes, label ? `${label}/${n}` : n);
  const some = (re: RegExp) => names.some((n) => re.test(n) && file(n));
  const pkg =
    names.includes('package.json') && file('package.json') ? read('package.json') : undefined;
  if (pkg !== undefined) {
    for (const s of depStacks(pkg, notes, label ? `${label}/package.json` : 'package.json')) {
      found.add(s);
    }
  }
  if (some(/^next\.config\./)) found.add('nextjs');
  if (some(/^components\.json$/)) found.add('shadcn');
  if (isRealDir(join(dir, 'migrations'))) found.add('postgres');
  if (some(/^(Podfile|Package\.swift)$/) || names.some((n) => n.endsWith('.xcodeproj'))) {
    found.add('ios');
  }
  for (const n of names.filter((x) => x.endsWith('.csproj') && file(x))) {
    if (/WinUI|WindowsAppSDK/i.test(read(n) ?? '')) found.add('winui');
  }
  if (some(/^Cargo\.toml$/)) found.add('rust');
  if (isRealDir(join(dir, 'src-tauri'))) {
    found.add('tauri');
    found.add('rust');
  }
  if (some(/^(build\.gradle.*|AndroidManifest\.xml)$/)) found.add('android');
  if (some(/^app\.json$/) && /"expo"\s*:/.test(read('app.json') ?? '')) found.add('expo');
  if (some(/^svelte\.config\./)) found.add('svelte');
  if (some(/^(astro\.config\..*|vite\.config\..*|index\.html)$/)) found.add('web');
  if (some(/^Dockerfile/) || some(/^(docker-)?compose.*\.ya?ml$/)) found.add('docker');
  if (some(/^wp-config\.php$/) || isRealDir(join(dir, 'wp-content'))) found.add('wordpress');
  if (some(/^style\.css$/) && /Theme Name:/.test(read('style.css') ?? '')) found.add('wordpress');
  for (const n of names.filter((x) => x.endsWith('.php') && file(x))) {
    if (/Plugin Name:/.test(read(n) ?? '')) found.add('wordpress');
  }
}

/**
 * The project's stacks from its manifest files: the root and one level of the usual monorepo
 * folders. Never opens `.env` and never follows a link. A file it cannot use is a note.
 */
export function detectStacks(dir: string): { stacks: string[]; notes: string[] } {
  const found = new Set<string>();
  const notes: string[] = [];
  scanDir(dir, '', found, notes);
  if (isRealDir(join(dir, '.github', 'workflows'))) found.add('gha');
  for (const group of MONOREPO_DIRS) {
    const base = join(dir, group);
    if (!isRealDir(base)) continue;
    for (const name of readdirSync(base).slice(0, MAX_ENTRIES)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      if (isRealDir(join(base, name))) scanDir(join(base, name), `${group}/${name}`, found, notes);
    }
  }
  if (OTHER_WEB.some((s) => found.has(s))) found.delete('web');
  return { stacks: [...found].sort(), notes };
}

/** `studio setup stack [--write]`: proposes the stacks and, with --write, stores them. */
export function runSetupStack(o: {
  project: string;
  json: boolean;
  write: boolean;
  stdout(s: string): void;
}): number {
  const file = join(o.project, '.studio', 'studio.yaml');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(
      `cannot read .studio/studio.yaml (${(e as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error('.studio/studio.yaml is not valid YAML');
  const { stacks, notes } = detectStacks(o.project);
  let stored: string[] = [];
  try {
    stored = loadConfig(o.project).stacks ?? [];
  } catch {
    stored = [];
  }
  const added = stacks.filter((s) => !stored.includes(s));
  const removed = stored.filter((s) => !stacks.includes(s));
  let written = false;
  if (o.write) {
    doc.set('stacks', stacks);
    const check = studioConfigSchema.safeParse(camelizeKeys(doc.toJS()));
    if (!check.success)
      throw new Error('the resulting studio.yaml would be invalid, nothing written');
    writeAtomic(file, doc.toString({ lineWidth: 0 }));
    written = true;
  }
  if (o.json) {
    o.stdout(`${JSON.stringify({ stacks, added, removed, notes, written }, null, 2)}\n`);
  } else {
    const lines = [
      `Stacks: ${stacks.join(', ') || '(none)'}`,
      ...(added.length > 0 ? [`Added: ${added.join(', ')}`] : []),
      ...(removed.length > 0 ? [`Removed: ${removed.join(', ')}`] : []),
      ...notes.map((n) => `Note: ${n}`),
      ...(written ? ['written: .studio/studio.yaml'] : []),
    ];
    o.stdout(`${lines.map(safe).join('\n')}\n`);
  }
  return 0;
}
