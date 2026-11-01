import { randomBytes } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type Document, isMap, isScalar, parseDocument, stringify } from 'yaml';
import { camelizeKeys, ciSchema, studioConfigSchema } from './config.js';
import type { Gh } from './ports.js';
import {
  type CiConfig,
  type Detected,
  detectRunners,
  lintWorkflows,
  proposeCi,
  type WorkflowFile,
  workflowRunnerUsage,
} from './setup-ci.js';

/** The lint requires this expression after a prefix of the workflow's own; `ci` is only the default. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
const EXPECTED_GROUP = 'ci-${{ github.head_ref || github.ref_name }}';
const WORKFLOW_DIR = ['.github', 'workflows'];
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type SetupCiOptions = {
  project: string;
  ports: { gh: Gh };
  json: boolean;
  write: boolean;
  stdout(s: string): void;
};

/** Untrusted text on its way to a terminal: no control or format characters (escapes, bidi). */
export const safe = (text: unknown): string => String(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ');

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** snake_case keys, undefined values dropped: the shape of the yaml file. */
function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [snake(k), snakeKeys(v)]),
    );
  }
  return value;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Updates `map` in place key by key so comments on keys and scalars survive. */
function syncMap(doc: Document, map: ReturnType<typeof asMap>, want: Record<string, unknown>) {
  if (!map) return;
  for (const [key, value] of Object.entries(want)) {
    const existing = map.get(key, true);
    if (isPlainObject(value) && isMap(existing)) syncMap(doc, existing, value);
    else if (isScalar(existing) && (value === null || typeof value !== 'object')) {
      existing.value = value;
    } else map.set(key, doc.createNode(value));
  }
  for (const pair of [...map.items]) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    if (typeof key !== 'string' || !(key in want)) map.delete(key);
  }
}

const asMap = (node: unknown) => (isMap(node) ? node : undefined);

/** `primary_repo` of studio.yaml as `owner/name`; throws for anything else. */
export function assertPrimaryRepo(primary: unknown): string {
  if (
    typeof primary !== 'string' ||
    !REPO_NAME.test(primary) ||
    primary.split('/').some((p) => p === '.' || p === '..')
  ) {
    throw new Error('.studio/studio.yaml: primary_repo must be owner/name');
  }
  return primary;
}

function readWorkflows(project: string): {
  files: WorkflowFile[];
  errors: string[];
  notes: string[];
} {
  const dir = join(project, ...WORKFLOW_DIR);
  const rel = WORKFLOW_DIR.join('/');
  const files: WorkflowFile[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      notes.push(`no workflows found: ${rel} does not exist`);
    } else errors.push(`cannot read ${rel}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    return { files, errors, notes };
  }
  const yaml = names.filter((n) => n.endsWith('.yml') || n.endsWith('.yaml')).sort();
  if (yaml.length === 0) notes.push(`no workflows found in ${rel}`);
  for (const name of yaml) {
    const path = `${rel}/${name}`;
    try {
      files.push({ path, text: readFileSync(join(dir, name), 'utf8') });
    } catch (e) {
      errors.push(`${path}: cannot read file (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  return { files, errors, notes };
}

async function readVisibility(
  gh: Gh,
  repo: string,
): Promise<{ visibility: 'public' | 'private'; note?: string }> {
  try {
    const out = (await gh.api(`/repos/${repo}`, '.visibility', { paginate: false })).trim();
    return { visibility: out === 'private' || out === 'internal' ? 'private' : 'public' };
  } catch {
    return {
      visibility: 'public',
      note: 'cannot read the repository visibility: treated as public',
    };
  }
}

/** Replaces the `ci:` block in the document; throws when the result is not a valid config. */
function applyCi(doc: Document, ci: CiConfig): void {
  const want = snakeKeys(ci) as Record<string, unknown>;
  const node = doc.get('ci', true);
  if (isMap(node)) syncMap(doc, node, want);
  else doc.set('ci', doc.createNode(want));
  const raw = doc.toJS() as unknown;
  if (isPlainObject(raw) && 'crew_toolchain_paths' in raw) {
    throw new Error('crew_toolchain_paths is not read from studio.yaml any more');
  }
  const result = studioConfigSchema.safeParse(camelizeKeys(raw));
  if (!result.success) {
    const why = result.error.issues
      .map((i) => `${i.path.map((p) => snake(String(p))).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`the resulting studio.yaml would be invalid, nothing written (${safe(why)})`);
  }
}

/** Temp file next to the target, then rename: a reader never sees half a file. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode: statSync(file).mode & 0o777 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    throw e;
  }
}

function describeDetection(d: Detected): string[] {
  const lines = [`Detection: source ${d.source}, ${d.runners.length} runner(s)`];
  for (const r of d.runners) {
    lines.push(
      `  ${r.name}  ${r.online ? 'online' : 'offline'}  ${r.busy ? 'busy' : 'idle'}  ${r.labels.join(',')}`,
    );
  }
  if (d.error) lines.push(`  error: ${d.error}`);
  return lines;
}

export async function runSetupCi(o: SetupCiOptions): Promise<number> {
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
  const primary = assertPrimaryRepo(doc.get('primary_repo'));
  const [owner = '', name = ''] = primary.split('/');

  const notes: string[] = [];
  let current: CiConfig | undefined;
  if (doc.has('ci')) {
    const parsed = ciSchema.safeParse(camelizeKeys((doc.toJS() as { ci?: unknown }).ci));
    if (parsed.success) current = parsed.data;
    else notes.push('the existing ci block is invalid and was ignored for the proposal');
  }
  const vis = await readVisibility(o.ports.gh, primary);
  if (vis.note) notes.push(vis.note);
  const wf = readWorkflows(o.project);
  notes.push(...wf.notes);

  const detection = await detectRunners(owner, name, o.ports);
  const proposal = proposeCi(detection, vis.visibility, current, workflowRunnerUsage(wf.files));
  const lint = lintWorkflows(wf.files, detection, EXPECTED_GROUP);
  const allNotes = [...notes, ...proposal.notes];
  const errors = [...proposal.errors, ...wf.errors, ...lint.errors];
  const warnings = lint.warnings;

  let written = false;
  let refused: string | undefined;
  if (o.write) {
    if (errors.length > 0 || proposal.ci === undefined) {
      refused = 'not written: fix the errors above first';
    } else {
      applyCi(doc, proposal.ci);
      writeAtomic(file, doc.toString({ lineWidth: 0 }));
      written = true;
    }
  }

  const ciOut = proposal.ci === undefined ? undefined : snakeKeys(proposal.ci);
  if (o.json) {
    o.stdout(
      `${JSON.stringify(
        { detection, proposal: { ci: ciOut, notes: allNotes }, errors, warnings, written },
        null,
        2,
      )}\n`,
    );
  } else {
    const lines = [...describeDetection(detection), 'Proposal:'];
    if (ciOut === undefined) lines.push('  none');
    else
      lines.push(
        ...stringify(ciOut)
          .trimEnd()
          .split('\n')
          .map((l) => `  ${l}`),
      );
    const section = (title: string, items: string[]) => {
      if (items.length > 0) lines.push(`${title}:`, ...items.map((i) => `  - ${i}`));
    };
    section('Notes', allNotes);
    section('Errors', errors);
    section('Warnings', warnings);
    if (refused) lines.push(refused);
    if (written) lines.push('written: .studio/studio.yaml');
    o.stdout(`${lines.map(safe).join('\n')}\n`);
  }
  return errors.length > 0 ? 1 : 0;
}
