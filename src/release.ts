import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Board, WorkItem } from './board.js';
import { componentsOf } from './board.js';
import {
  APPROVER_ID_RE,
  type ComponentConfig,
  parseConfig,
  type ReleaseRule,
  type StudioConfig,
} from './config.js';
import { matchGlob } from './glob.js';
import { classifySql, type MigrationKind, naturalCompare, needsOwner } from './migrations.js';
import { acquireStateLock, assertStatePath, writeStateFile } from './paths.js';
import type { Gh, Git } from './ports.js';
import { appendStateLine } from './queue.js';

/**
 * The release gate per component (`studio release <component>`). A release is one commit of the
 * default branch shipped by one named workflow file of the component's `release:` block in
 * studio.yaml at that commit. Studio:
 *
 * 1. drafts the release note (changes by epic, migrations in order with kind and risk, new
 *    configuration by name, the way back, the checks after the deploy) and logs the one-sentence
 *    announcement to the owner (`announced`);
 * 2. collects approvals: the owner's for every migration that is not clearly additive (terminal
 *    only), and each third party's the component names (`release.approvers`), recorded by the lead
 *    with who said it, when and the words; Studio contacts no one (`approvals`);
 * 3. on the lead's next `studio release <component>`, under the merge capacity rule, records the
 *    trigger and only then runs `gh workflow run <file> --ref <default branch> -f sha=<commit>`
 *    once (`triggered`), so a crash never starts it twice;
 * 4. waits for the release run and the named post-deploy jobs (`checking`), every unknown or
 *    missing result failing closed, and stops on red with the way back shown, never run (`failed`),
 *    or ends `done`. A release not yet triggered can be `stopped` by the lead.
 *
 * Records live in `releases.json` in the state root (crews cannot write it), changed under
 * `releases.lock`; `releases.jsonl` keeps the announcement, approvals and outcome as a log.
 */

export const RELEASES_FILE = 'releases.json';
export const RELEASES_LOG = 'releases.jsonl';
export const RELEASES_LOCK = 'releases.lock';
export const RELEASES_LOCK_STALE_MS = 10 * 60_000;
/** The workflow input that carries the release commit: GitHub runs a dispatch on a branch only. */
export const SHA_INPUT = 'sha';
/** How long a trigger may show no run before the lead hears of it. */
export const RUN_FIND_MS = 10 * 60_000;

const GH_MS = 60_000;
const GIT_FETCH_MS = 120_000;
const GIT_LOCAL_MS = 60_000;
const SHA = /^[0-9a-f]{40}$/i;
const STUDIO_CONFIG = '.studio/studio.yaml';
const MAX_BLOB = 2 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_MIGRATIONS = 200;
const MAX_ITEMS = 200;
const DIFF = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=none',
  '--no-renames',
];

export const RELEASE_STATUSES = [
  'announced',
  'approvals',
  'triggered',
  'checking',
  'done',
  'failed',
  'stopped',
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
/** Before the trigger: the lead may still stop it, approvals may still come in. */
export const BEFORE_TRIGGER: readonly ReleaseStatus[] = ['announced', 'approvals'];
const OPEN: readonly ReleaseStatus[] = ['announced', 'approvals', 'triggered', 'checking'];
export const isOpen = (r: Release): boolean => OPEN.includes(r.status);

/** A release id: `<component>-<n>`. */
export const RELEASE_ID_RE = /^[a-z][a-z0-9-]{0,31}-[1-9]\d{0,5}$/;

const line = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u);

const migrationSchema = z.strictObject({
  path: line(500),
  change: z.enum(['added', 'changed', 'deleted']),
  kind: z.enum(['additive', 'backfill', 'unclear', 'destructive']),
  why: line(300),
  owner: z.boolean(),
});
export type NoteMigration = z.infer<typeof migrationSchema>;

const noteSchema = z.strictObject({
  component: z.strictObject({ id: z.string(), name: line(100) }),
  repo: z.string(),
  branch: z.string(),
  since: z.string().regex(SHA),
  sha: z.string().regex(SHA),
  commits: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  epics: z.array(
    z.strictObject({
      epic: z.string().nullable(),
      title: line(200),
      items: z.array(z.strictObject({ id: z.string(), title: line(200), pr: z.number().int() })),
    }),
  ),
  /** Merged items of the component whose merge commit Studio could not read. */
  unplaced: z.array(z.strictObject({ id: z.string(), why: line(200) })),
  migrations: z.array(migrationSchema),
  config: z.strictObject({
    files: z.array(line(500)),
    added: z.array(line(100)),
    removed: z.array(line(100)),
  }),
  wayBack: z.array(line(600)),
  postChecks: z.array(line(400)),
  approvers: z.array(z.strictObject({ id: z.string(), who: line(100), for: line(200).optional() })),
});
export type ReleaseNote = z.infer<typeof noteSchema>;

const approvalSchema = z.strictObject({
  approver: z.string(),
  who: line(100),
  said: line(500),
  at: z.string(),
  recordedAt: z.string(),
  recordedBy: z.enum(['lead', 'owner']),
});
export type Approval = z.infer<typeof approvalSchema>;

const checkSchema = z.strictObject({
  name: z.string(),
  workflow: z.string(),
  job: z.string(),
  state: z.enum(['pass', 'fail', 'pending', 'missing']),
  run: z.number().int().optional(),
});
export type ReleaseCheck = z.infer<typeof checkSchema>;

const releaseSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(RELEASE_ID_RE),
  component: z.string(),
  repo: z.string(),
  branch: z.string(),
  sha: z.string().regex(SHA),
  since: z.string().regex(SHA),
  createdAt: z.string(),
  status: z.enum(RELEASE_STATUSES),
  workflow: z.string(),
  /** From the rule at the release commit: how long the run and its checks may take. */
  timeoutMinutes: z.number().int().positive(),
  note: noteSchema,
  /** sha256 of the note's migrations: what an owner approval binds to. */
  migrationsDigest: z.string(),
  /** The blob of each workflow the release starts or names (release, post checks, rollback) at
   * the release commit, pinned when it was announced: the trigger refuses another. */
  workflowBlobs: z.record(z.string(), z.string().regex(/^[0-9a-f]{40,64}$/)),
  /** The rollback workflow, when the way back is one: its pin is checked before it is shown. */
  rollbackWorkflow: z.string().optional(),
  /** `.github`'s tree and the component's `guarded_paths` at the release commit: what the release
   * workflows run, pinned when it was announced. */
  guardPin: z.string(),
  needs: z.strictObject({ owner: z.array(z.string()), approvers: z.array(z.string()) }),
  announcement: z.strictObject({ at: z.string(), text: line(1000) }),
  approvals: z.array(approvalSchema).default([]),
  trigger: z
    .strictObject({
      at: z.string(),
      by: z.enum(['lead', 'owner']),
      head: z.string().regex(SHA),
      workflowId: z.number().int(),
      run: z.number().int().optional(),
      refused: line(300).optional(),
    })
    .optional(),
  /** Post-check workflows other than the release workflow, as Studio started them. */
  started: z
    .record(
      z.string(),
      z.strictObject({
        at: z.string(),
        workflowId: z.number().int(),
        /** The branch head checked right before the start: its run must be of this head. */
        head: z.string().regex(SHA).optional(),
        run: z.number().int().optional(),
        refused: line(300).optional(),
      }),
    )
    .default({}),
  checks: z.array(checkSchema).default([]),
  /** Set once the release run passed: the commit runs in production. */
  deployedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  reason: line(600).optional(),
});
export type Release = z.infer<typeof releaseSchema>;

const fileSchema = z.strictObject({ v: z.literal(1), releases: z.array(releaseSchema) });

/** What the release code needs from outside. */
export interface ReleaseContext {
  project: string;
  stateRoot: string;
  /** The working tree's config: which components exist. The rules come from the release commit. */
  config: StudioConfig;
  board: Board;
  gh: Gh;
  git: Git;
  /** The owner's checkout and how it reaches a repository. */
  checkout(repo: string): { dir: string; remote: string };
  now(): Date;
}

const digest = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const short = (sha: string): string => sha.slice(0, 7);
const clean = (s: string, max: number): string =>
  s
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const quote = (p: string): string => JSON.stringify(clean(p, 300));

// --- The records -------------------------------------------------------------------------------

/** Every release; throws when the file exists but cannot be read: nothing may start then. */
export function readReleases(stateRoot: string): Release[] {
  const file = join(stateRoot, RELEASES_FILE);
  assertStatePath(stateRoot, file);
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (st === undefined) return [];
  if (!st.isFile()) throw new Error(`${RELEASES_FILE} in the state root is no regular file`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${RELEASES_FILE} in the state root is unreadable; check it by hand`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${RELEASES_FILE} in the state root is unreadable; check it by hand`);
  }
  return parsed.data.releases;
}

function writeReleases(stateRoot: string, releases: Release[]): void {
  writeStateFile(
    stateRoot,
    join(stateRoot, RELEASES_FILE),
    `${JSON.stringify({ v: 1, releases }, null, 2)}\n`,
  );
}

/** One line of the release log: what happened, never a secret (Studio's own text and ids). */
function log(stateRoot: string, at: Date, event: Record<string, unknown>): void {
  appendStateLine(stateRoot, RELEASES_LOG, JSON.stringify({ at: at.toISOString(), ...event }));
}

/**
 * Runs `fn` under the releases lock with the current records; what it returns as `releases` is
 * written. A lock another command holds refuses: two release commands never run at once.
 */
export async function withReleases<T>(
  ctx: Pick<ReleaseContext, 'stateRoot' | 'now'>,
  fn: (releases: Release[], save: (next: Release[]) => void, beat: () => void) => Promise<T> | T,
): Promise<T> {
  const lock = acquireStateLock(ctx.stateRoot, RELEASES_LOCK, {
    now: ctx.now(),
    heartbeatStaleMs: RELEASES_LOCK_STALE_MS,
  });
  if (!lock) throw new Error(`another release command is running (${RELEASES_LOCK}); try again`);
  try {
    const releases = readReleases(ctx.stateRoot);
    return await fn(
      releases,
      (next) => {
        if (!lock.owned()) throw new Error(`the ${RELEASES_LOCK} was lost; nothing written`);
        writeReleases(ctx.stateRoot, next);
      },
      () => lock.heartbeat(ctx.now()),
    );
  } finally {
    lock.release();
  }
}

export const replaceRelease = (all: Release[], rec: Release): Release[] =>
  all.map((r) => (r.id === rec.id ? rec : r));

// --- Git in the owner's checkout ---------------------------------------------------------------

type Checkout = { dir: string; remote: string };

const g = (git: Git, co: Checkout, args: string[], timeoutMs = GIT_LOCAL_MS) =>
  git.run(co.dir, ['--no-replace-objects', ...args], { timeoutMs });

async function fetchCommits(git: Git, co: Checkout, shas: string[]): Promise<void> {
  try {
    await g(
      git,
      co,
      ['fetch', '--no-tags', '--no-write-fetch-head', co.remote, ...new Set(shas)],
      GIT_FETCH_MS,
    );
  } catch {
    throw new Error(`cannot fetch ${shas.map(short).join(', ')} into the owner's checkout`);
  }
}

async function isAncestor(git: Git, co: Checkout, a: string, b: string): Promise<boolean> {
  try {
    await g(git, co, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

/** The blob id of `path` at `sha`; undefined when there is none. */
async function blobAt(
  git: Git,
  co: Checkout,
  sha: string,
  path: string,
): Promise<string | undefined> {
  try {
    const oid = (await g(git, co, ['rev-parse', '--verify', '--quiet', `${sha}:${path}`])).trim();
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : undefined;
  } catch {
    return undefined;
  }
}

/** The text of `path` at `sha`, at most 2 MiB; undefined when it is missing or too large. */
async function readAt(
  git: Git,
  co: Checkout,
  sha: string,
  path: string,
): Promise<string | undefined> {
  const oid = await blobAt(git, co, sha, path);
  if (oid === undefined) return undefined;
  const size = Number((await g(git, co, ['cat-file', '-s', oid])).trim());
  if (!Number.isFinite(size) || size > MAX_BLOB) return undefined;
  return g(git, co, ['cat-file', 'blob', oid]);
}

async function bytesAt(
  git: Git,
  co: Checkout,
  sha: string,
  path: string,
): Promise<Uint8Array | 'missing' | 'large'> {
  const oid = await blobAt(git, co, sha, path);
  if (oid === undefined) return 'missing';
  const size = Number((await g(git, co, ['cat-file', '-s', oid])).trim());
  if (!Number.isFinite(size) || size > MAX_BLOB) return 'large';
  if (git.blob === undefined) throw new Error('no blob reader');
  return git.blob(co.dir, oid, { timeoutMs: GIT_LOCAL_MS });
}

/** The component's release rule in studio.yaml at `sha`: the default branch's word, never the tree's. */
async function ruleAt(
  git: Git,
  co: Checkout,
  sha: string,
  componentId: string,
): Promise<{ component: ComponentConfig; rule: ReleaseRule; config: StudioConfig }> {
  const text = await readAt(git, co, sha, STUDIO_CONFIG);
  if (text === undefined) throw new Error(`no ${STUDIO_CONFIG} at ${short(sha)}`);
  const config = parseConfig(text, `${short(sha)}:${STUDIO_CONFIG}`);
  const component = config.components?.find((c) => c.id === componentId);
  if (component === undefined) {
    throw new Error(`component ${componentId} is not in ${STUDIO_CONFIG} at ${short(sha)}`);
  }
  if (component.release === undefined) {
    throw new Error(
      `component ${componentId} has no release: block in ${STUDIO_CONFIG} at ${short(sha)} on the default branch`,
    );
  }
  return { component, rule: component.release, config };
}

type Change = { status: 'A' | 'M' | 'D' | 'T'; path: string };

async function changesBetween(git: Git, co: Checkout, a: string, b: string): Promise<Change[]> {
  const out = await g(git, co, [...DIFF, '--name-status', '-z', a, b]);
  const parts = out.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] as string;
    if (!/^[AMDT]$/.test(status)) throw new Error(`unexpected git status ${clean(status, 10)}`);
    changes.push({ status: status as Change['status'], path: parts[i + 1] as string });
    if (changes.length > MAX_FILES) {
      throw new Error(
        `more than ${MAX_FILES} files changed since ${short(a)}: release smaller steps`,
      );
    }
  }
  return changes;
}

// --- GitHub ------------------------------------------------------------------------------------

async function readDefault(gh: Gh, repo: string): Promise<string | undefined> {
  try {
    const r = await gh.run(['repo', 'view', repo, '--json', 'defaultBranchRef'], {
      timeoutMs: GH_MS,
    });
    if (r.code !== 0) return undefined;
    const name = (JSON.parse(r.stdout) as { defaultBranchRef?: { name?: unknown } | null })
      .defaultBranchRef?.name;
    return typeof name === 'string' &&
      /^[A-Za-z0-9_.][A-Za-z0-9._/-]{0,100}$/.test(name) &&
      !name.includes('..')
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}

/** The commit a ref names (a branch, a tag or a commit); undefined on any failure. */
async function resolveRef(gh: Gh, repo: string, ref: string): Promise<string | undefined> {
  try {
    const sha = (
      await gh.api(`repos/${repo}/commits/${encodeURIComponent(ref)}`, '.sha', {
        paginate: false,
        timeoutMs: GH_MS,
      })
    ).trim();
    return SHA.test(sha) ? sha.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

type Listed = { id: number; path: string; name: string };

/** The repository's workflows as GitHub lists them: id, file and display name. */
async function listWorkflows(gh: Gh, repo: string): Promise<Listed[]> {
  const r = await gh.run(
    ['workflow', 'list', '--repo', repo, '--all', '--limit', '500', '--json', 'id,path,name'],
    { timeoutMs: GH_MS },
  );
  if (r.code !== 0) throw new Error(`cannot list the workflows of ${repo}`);
  const parsed = z
    .array(z.object({ id: z.number().int(), path: z.string(), name: z.string().default('') }))
    .safeParse(JSON.parse(r.stdout));
  if (!parsed.success) throw new Error(`cannot read the workflows of ${repo}`);
  return parsed.data;
}

/** GitHub's id of each workflow file; one file listed twice fails closed. */
function idsOf(list: Listed[]): Map<string, number> {
  const ids = new Map<string, number>();
  const twice = new Set<string>();
  for (const w of list) {
    if (ids.has(w.path)) twice.add(w.path);
    ids.set(w.path, w.id);
  }
  for (const p of twice) ids.delete(p);
  return ids;
}

const workflowIds = async (gh: Gh, repo: string): Promise<Map<string, number>> =>
  idsOf(await listWorkflows(gh, repo));

/**
 * The workflows a `crew_allowed_workflows` entry can start, resolved the way `gh workflow run`
 * resolves its argument: by id, by file (name or path) or by display name, ignoring case. Erring
 * wide: an entry that could mean a workflow counts as meaning it.
 */
export function crewReach(entry: string, list: readonly Listed[]): Listed[] {
  const e = entry.trim().toLowerCase();
  return list.filter((w) => {
    const file = w.path.split('/').at(-1)?.toLowerCase() ?? '';
    return (
      e === String(w.id) || e === file || e === w.path.toLowerCase() || e === w.name.toLowerCase()
    );
  });
}

const runSchema = z.object({
  databaseId: z.number().int().optional(),
  status: z.string(),
  conclusion: z.string().nullish(),
  event: z.string().optional(),
  workflowDatabaseId: z.number().int().optional(),
  headBranch: z.string().optional(),
  headSha: z.string().optional(),
  jobs: z
    .array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullish() }))
    .default([]),
});
type Run = z.infer<typeof runSchema>;

async function viewRun(gh: Gh, repo: string, run: number): Promise<Run | undefined> {
  try {
    const r = await gh.run(
      [
        'run',
        'view',
        String(run),
        '--repo',
        repo,
        '--json',
        'databaseId,status,conclusion,event,workflowDatabaseId,headBranch,headSha,jobs',
      ],
      { timeoutMs: GH_MS },
    );
    if (r.code !== 0) return undefined;
    const parsed = runSchema.safeParse(JSON.parse(r.stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The run `gh workflow run` names in its output (gh prints its URL when GitHub returns it). */
function runFromOutput(repo: string, text: string): number | undefined {
  const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`https://github\\.com/${esc}/actions/runs/(\\d{1,15})\\b`, 'i').exec(text);
  return m === null ? undefined : Number(m[1]);
}

/**
 * The run a dispatch started when gh did not name it: the one `workflow_dispatch` run of that
 * workflow on the branch created since the dispatch. None or several: undefined (never a guess).
 */
async function findDispatchedRun(
  gh: Gh,
  repo: string,
  workflowId: number,
  branch: string,
  since: string,
): Promise<{ run?: number; several?: true }> {
  try {
    const r = await gh.run(
      [
        'run',
        'list',
        '--repo',
        repo,
        '--workflow',
        String(workflowId),
        '--event',
        'workflow_dispatch',
        '--branch',
        branch,
        '--limit',
        '20',
        '--json',
        'databaseId,createdAt',
      ],
      { timeoutMs: GH_MS },
    );
    if (r.code !== 0) return {};
    const parsed = z
      .array(z.object({ databaseId: z.number().int(), createdAt: z.string() }))
      .safeParse(JSON.parse(r.stdout));
    if (!parsed.success) return {};
    // A minute of clock difference between this machine and GitHub.
    const from = Date.parse(since) - 60_000;
    const hits = parsed.data.filter((x) => Date.parse(x.createdAt) >= from);
    if (hits.length > 1) return { several: true };
    return hits.length === 1 ? { run: (hits[0] as { databaseId: number }).databaseId } : {};
  } catch {
    return {};
  }
}

/** Whether the workflow at `sha` can be started with the release commit: dispatch with input `sha`. */
async function dispatchProblem(
  git: Git,
  co: Checkout,
  sha: string,
  file: string,
  o: { crewAllowed: readonly string[]; input: boolean },
): Promise<string | undefined> {
  const crewAllowed = o.crewAllowed;
  const text = await readAt(git, co, sha, file);
  if (text === undefined) return `${file} is not in ${short(sha)}`;
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return `${file} at ${short(sha)} is no valid YAML`;
  }
  // crew_allowed_workflows may name a workflow by its display name: a deploy is never a crew's.
  const name = (raw as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && crewAllowed.includes(name)) {
    return `${file} is named ${clean(name, 100)}, which crew_allowed_workflows lists: a crew may never start a release workflow`;
  }
  const on = (raw as { on?: unknown } | null)?.on;
  const dispatch =
    on !== null && typeof on === 'object' && !Array.isArray(on)
      ? (on as Record<string, unknown>).workflow_dispatch
      : undefined;
  const inputs =
    dispatch !== null && typeof dispatch === 'object'
      ? (dispatch as { inputs?: unknown }).inputs
      : undefined;
  if (
    o.input &&
    (inputs === null || typeof inputs !== 'object' || !Object.hasOwn(inputs as object, SHA_INPUT))
  ) {
    return `${file} needs on: workflow_dispatch with an input ${SHA_INPUT} (the commit to deploy)`;
  }
  return undefined;
}

// --- The note ----------------------------------------------------------------------------------

const prSchema = z.object({ mergeCommit: z.object({ oid: z.string() }).nullish() });

/** Names a configuration file declares: `NAME=`, `export NAME=`, `name:` at a line start. */
function configNames(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const l of (text ?? '').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]{0,99})\s*[=:]/.exec(l);
    if (m !== null && !l.trimStart().startsWith('#')) out.add(m[1] as string);
  }
  return out;
}

const mergedAt = (i: WorkItem): number =>
  Date.parse([...i.history].reverse().find((h) => h.to === 'merged')?.at ?? '') || 0;

function wayBackOf(
  rule: ReleaseRule,
  repo: string,
  branch: string,
  previous: string | undefined,
  migrations: NoteMigration[],
): string[] {
  const out: string[] = [];
  if ('text' in rule.rollback) out.push(rule.rollback.text);
  else {
    out.push(
      previous === undefined
        ? `run ${rule.rollback.workflow} by hand with the commit production ran before this release (Studio has no earlier release of this component)`
        : `run by hand: gh workflow run ${rule.rollback.workflow} --repo ${repo} --ref ${branch} -f ${SHA_INPUT}=${previous}`,
    );
  }
  const lossy = migrations.filter((m) => m.kind === 'destructive' || m.kind === 'backfill');
  if (lossy.length > 0) {
    out.push(
      `the code goes back, the data does not: ${lossy.map((m) => quote(m.path)).join(', ')} change or remove data that only a backup restores`,
    );
  } else if (migrations.length > 0) {
    out.push(
      'the migrations stay applied when the code goes back: the old code must run on the new schema',
    );
  }
  return out;
}

/**
 * The note for `since..sha` of one component. Pure reads: git in the owner's checkout, the board
 * and `gh pr view` for merge commits. Studio's own words plus board titles and paths, never file
 * contents: migrations by kind and statement shape, configuration by name only.
 */
export async function buildNote(
  ctx: ReleaseContext,
  o: {
    component: ComponentConfig;
    rule: ReleaseRule;
    config: StudioConfig;
    branch: string;
    since: string;
    sha: string;
    previous?: string;
  },
): Promise<ReleaseNote> {
  const co = ctx.checkout(o.component.repo);
  const range = (await g(ctx.git, co, ['rev-list', '--max-count=10001', `${o.since}..${o.sha}`]))
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SHA.test(s));
  if (range.length > 10_000)
    throw new Error('more than 10000 commits in the release: release smaller steps');
  const inRange = new Set(range);
  const changes = await changesBetween(ctx.git, co, o.since, o.sha);
  const mine = changes.filter((c) => o.component.paths.some((p) => matchGlob(p, c.path)));
  // Changes by epic: merged items of the component whose merge commit lies in the range.
  const sinceAt =
    Date.parse((await g(ctx.git, co, ['show', '-s', '--format=%cI', o.since])).trim()) || 0;
  const candidates = ctx.board.items
    .filter(
      (i) =>
        i.status === 'merged' &&
        i.type !== 'review' &&
        i.pr !== undefined &&
        i.repo === o.component.repo &&
        componentsOf(i, o.config).includes(o.component.id) &&
        // Merged around or after the commit production ran; one with no merge time is checked too.
        (mergedAt(i) === 0 || mergedAt(i) >= sinceAt - 86_400_000),
    )
    .slice(0, MAX_ITEMS);
  const placed: WorkItem[] = [];
  const unplaced: ReleaseNote['unplaced'] = [];
  for (const item of candidates) {
    let merge: string | undefined;
    try {
      const r = await ctx.gh.run(
        ['pr', 'view', String(item.pr), '--repo', item.repo, '--json', 'mergeCommit'],
        { timeoutMs: GH_MS },
      );
      const parsed = r.code === 0 ? prSchema.safeParse(JSON.parse(r.stdout)) : undefined;
      merge = parsed?.success ? parsed.data.mergeCommit?.oid?.toLowerCase() : undefined;
    } catch {
      merge = undefined;
    }
    if (merge === undefined || !SHA.test(merge)) {
      unplaced.push({ id: item.id, why: 'its merge commit cannot be read' });
    } else if (inRange.has(merge)) placed.push(item);
  }
  const groups = new Map<string | null, WorkItem[]>();
  for (const i of placed) groups.set(i.epic ?? null, [...(groups.get(i.epic ?? null) ?? []), i]);
  const epics = [...groups]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : naturalCompare(a, b)))
    .map(([epic, items]) => ({
      epic,
      title: clean(
        epic === null
          ? 'Without epic'
          : ((ctx.board.epics ?? []).find((e) => e.id === epic)?.title ?? epic),
        200,
      ),
      items: items
        .sort((a, b) => naturalCompare(a.id, b.id))
        .map((i) => ({ id: i.id, title: clean(i.title, 200), pr: i.pr as number })),
    }));
  // Migrations in order: configured ones, and anything below the component that looks like one.
  // A path segment with `migrat`, or any SQL file of the component: no SQL change ships unread.
  const looksLike = (p: string) =>
    p.toLowerCase().endsWith('.sql') || p.split('/').some((seg) => /migrat/i.test(seg));
  const isMigration = (c: Change) =>
    o.rule.migrations.some((m) => matchGlob(m, c.path)) ||
    (looksLike(c.path) && o.component.paths.some((p) => matchGlob(p, c.path)));
  const migrationChanges = changes
    .filter(isMigration)
    .sort((a, b) => naturalCompare(a.path, b.path));
  const migrations: NoteMigration[] = [];
  for (const [n, c] of migrationChanges.entries()) {
    const configured = o.rule.migrations.some((m) => matchGlob(m, c.path));
    const base = { path: clean(c.path, 500) };
    let kind: MigrationKind;
    let why: string;
    if (n >= MAX_MIGRATIONS) {
      kind = 'unclear';
      why = `more than ${MAX_MIGRATIONS} migrations: not read`;
    } else if (c.status === 'D') {
      kind = 'unclear';
      why = 'a migration file was deleted';
    } else if (c.status !== 'A') {
      kind = 'unclear';
      why = 'an existing migration changed: it may have run already';
    } else if (!c.path.toLowerCase().endsWith('.sql')) {
      kind = 'unclear';
      why = 'not SQL: Studio reads .sql migrations only';
    } else {
      const bytes = await bytesAt(ctx.git, co, o.sha, c.path);
      if (bytes === 'missing' || bytes === 'large') {
        kind = 'unclear';
        why = bytes === 'large' ? 'too large to read' : 'cannot be read';
      } else {
        const r = classifySql(bytes);
        kind = r.kind;
        why = clean(r.why, 300);
      }
    }
    if (!configured) why = clean(`not under release.migrations; ${why}`, 300);
    migrations.push({
      ...base,
      change: c.status === 'A' ? 'added' : c.status === 'D' ? 'deleted' : 'changed',
      kind,
      why,
      owner: needsOwner(kind),
    });
  }
  // New configuration by name: what the configured files declare at the release, not before.
  const configFiles = changes.filter((c) => o.rule.config.some((p) => matchGlob(p, c.path)));
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const c of configFiles) {
    const before =
      c.status === 'A'
        ? new Set<string>()
        : configNames(await readAt(ctx.git, co, o.since, c.path));
    const after =
      c.status === 'D' ? new Set<string>() : configNames(await readAt(ctx.git, co, o.sha, c.path));
    for (const n of after) if (!before.has(n)) added.add(n);
    for (const n of before) if (!after.has(n)) removed.add(n);
  }
  // Over every change of the release, not only the component's: a part a third party owns may lie
  // outside the component's paths.
  const touched = (globs: string[]) => changes.some((c) => globs.some((p) => matchGlob(p, c.path)));
  const approvers = o.rule.approvers
    .filter((a) => a.paths === undefined || touched(a.paths))
    .map((a) => ({
      id: a.id,
      who: clean(a.who, 100),
      ...(a.for === undefined ? {} : { for: clean(a.for, 200) }),
    }));
  return {
    component: { id: o.component.id, name: clean(o.component.name, 100) },
    repo: o.component.repo,
    branch: o.branch,
    since: o.since,
    sha: o.sha,
    commits: range.length,
    files: mine.length,
    epics,
    unplaced,
    migrations,
    config: {
      files: configFiles.map((c) => clean(c.path, 500)).sort(naturalCompare),
      added: [...added].sort(),
      removed: [...removed].sort(),
    },
    wayBack: wayBackOf(o.rule, o.component.repo, o.branch, o.previous, migrations).map((l) =>
      clean(l, 600),
    ),
    postChecks: o.rule.postChecks.map((p) => `${p.workflow} / ${p.job}`),
    approvers,
  };
}

/** The note as Markdown: for the lead, the pull request of a release, the owner. */
export function renderNote(n: ReleaseNote, id?: string): string {
  const out: string[] = [
    `# Release${id === undefined ? '' : ` ${id}`}: ${n.component.name} (${n.component.id})`,
    '',
    `${n.repo} ${n.branch} at ${n.sha}, since ${n.since}: ${n.commits} commits, ${n.files} files of the component.`,
    '',
    '## Changes by epic',
    '',
  ];
  if (n.epics.length === 0) out.push('No board item of this component was merged in this range.');
  for (const e of n.epics) {
    out.push(`- ${e.epic === null ? e.title : `${e.epic} ${e.title}`}`);
    for (const i of e.items) out.push(`  - ${i.id} ${i.title} (#${i.pr})`);
  }
  for (const u of n.unplaced) out.push(`- not placed: ${u.id}, ${u.why}`);
  out.push('', '## Migrations, in order', '');
  if (n.migrations.length === 0) out.push('None.');
  for (const m of n.migrations) {
    out.push(
      `- ${m.path} (${m.change}): ${m.kind}, ${m.owner ? 'needs the owner' : 'low risk'}; ${m.why}`,
    );
  }
  out.push('', '## New configuration (names only)', '');
  if (n.config.files.length === 0) out.push('No configuration file changed.');
  else {
    out.push(`Files: ${n.config.files.join(', ')}`);
    out.push(`Added: ${n.config.added.length === 0 ? 'none' : n.config.added.join(', ')}`);
    if (n.config.removed.length > 0) out.push(`Removed: ${n.config.removed.join(', ')}`);
  }
  out.push('', '## The way back', '', ...n.wayBack.map((w) => `- ${w}`));
  out.push('', '## Checks after the deploy', '', ...n.postChecks.map((c) => `- ${c}`));
  out.push('', '## Approvals', '');
  const owner = n.migrations.filter((m) => m.owner);
  out.push(
    owner.length === 0
      ? '- owner: not needed (no migration that is not clearly additive)'
      : `- owner: needed for ${owner.map((m) => m.path).join(', ')}`,
  );
  for (const a of n.approvers) {
    out.push(`- ${a.id}: ${a.who}${a.for === undefined ? '' : `, for ${a.for}`}`);
  }
  return `${out.join('\n')}\n`;
}

/** The one sentence to the owner before the trigger: what happens and what cannot be undone. */
export function announcementOf(n: ReleaseNote, id: string, workflow: string): string {
  const lossy = n.migrations.filter((m) => m.kind === 'destructive' || m.kind === 'backfill');
  const undone =
    lossy.length > 0
      ? `the migration${lossy.length === 1 ? '' : 's'} ${lossy.map((m) => m.path).join(', ')} change or remove data that only a backup brings back`
      : n.migrations.length > 0
        ? `${n.migrations.length} migration${n.migrations.length === 1 ? '' : 's'} run and stay applied, and the deploy cannot be taken back, only followed by another`
        : 'the deploy cannot be taken back, only followed by another';
  return clean(
    `Release ${id} deploys ${n.component.name} at ${short(n.sha)} (${n.commits} commits) to production through ${workflow}; once it runs, ${undone}.`,
    1000,
  );
}

// --- Drafting and announcing -------------------------------------------------------------------

export interface Draft {
  id: string;
  workflowBlobs: Record<string, string>;
  guardPin: string;
  rollbackWorkflow?: string;
  component: ComponentConfig;
  rule: ReleaseRule;
  note: ReleaseNote;
  announcement: string;
  needs: Release['needs'];
}

/** The commit production runs: the newest release of the component that deployed. */
export const lastDeployed = (releases: Release[], component: string): Release | undefined =>
  releases
    .filter((r) => r.component === component && r.deployedAt !== undefined)
    .sort((a, b) => Date.parse(b.deployedAt ?? '') - Date.parse(a.deployedAt ?? ''))[0];

const nextId = (releases: Release[], component: string): string => {
  const prefix = `${component}-`;
  const taken = releases
    .filter((r) => r.id.startsWith(prefix) && /^\d+$/.test(r.id.slice(prefix.length)))
    .map((r) => Number(r.id.slice(prefix.length)));
  return `${prefix}${Math.max(0, ...taken) + 1}`;
};

/** A draft of the component's next release at the head of the default branch. Reads only. */
export async function draftRelease(
  ctx: ReleaseContext,
  releases: Release[],
  componentId: string,
  sinceRef: string | undefined,
): Promise<Draft> {
  const known = ctx.config.components?.find((c) => c.id === componentId);
  if (known === undefined) throw new Error(`unknown component ${componentId}`);
  const repo = known.repo;
  const branch = await readDefault(ctx.gh, repo);
  if (branch === undefined) throw new Error(`cannot read the default branch of ${repo}`);
  const sha = await resolveRef(ctx.gh, repo, branch);
  if (sha === undefined) throw new Error(`cannot read the head of ${branch} in ${repo}`);
  const previous = lastDeployed(releases, componentId);
  let since: string;
  if (sinceRef !== undefined) {
    if (previous !== undefined) {
      throw new Error(
        `--since is for the first release only: ${componentId} runs ${short(previous.sha)} since ${previous.id}`,
      );
    }
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(sinceRef) || sinceRef.includes('..')) {
      throw new Error('--since takes a commit, tag or branch name');
    }
    const resolved = await resolveRef(ctx.gh, repo, sinceRef);
    if (resolved === undefined) throw new Error(`cannot resolve ${sinceRef} in ${repo}`);
    since = resolved;
  } else if (previous !== undefined) since = previous.sha;
  else {
    throw new Error(
      `the first release of ${componentId}: name the commit production runs now, studio release ${componentId} --since <commit or tag>`,
    );
  }
  const co = ctx.checkout(repo);
  await fetchCommits(ctx.git, co, [since, sha]);
  if (since === sha)
    throw new Error(`nothing to release: ${componentId} runs ${short(sha)} already`);
  if (!(await isAncestor(ctx.git, co, since, sha))) {
    throw new Error(`${short(since)} is not an ancestor of ${branch} at ${short(sha)}`);
  }
  const { component, rule, config } = await ruleAt(ctx.git, co, sha, componentId);
  if (component.repo !== repo) {
    throw new Error(
      `component ${componentId} is in ${component.repo} at ${short(sha)}, not ${repo}`,
    );
  }
  const note = await buildNote(ctx, {
    component,
    rule,
    config,
    branch,
    since,
    sha,
    ...(previous === undefined ? {} : { previous: previous.sha }),
  });
  if (note.files === 0) {
    throw new Error(`nothing to release: no file of ${componentId} changed since ${short(since)}`);
  }
  const workflowBlobs: Record<string, string> = {};
  const named = [
    rule.workflow,
    ...rule.postChecks.map((p) => p.workflow),
    ...('workflow' in rule.rollback ? [rule.rollback.workflow] : []),
  ];
  for (const file of new Set(named)) {
    const oid = await blobAt(ctx.git, co, sha, file);
    // A way back that does not exist is none: refused like a release workflow that is missing.
    if (oid === undefined) throw new Error(`${file} is not in ${short(sha)}`);
    workflowBlobs[file] = oid;
  }
  const guard = await guardPinAt(ctx.git, co, sha, rule.guardedPaths);
  const id = nextId(releases, componentId);
  return {
    id,
    workflowBlobs,
    guardPin: guard,
    ...('workflow' in rule.rollback ? { rollbackWorkflow: rule.rollback.workflow } : {}),
    component,
    rule,
    note,
    announcement: announcementOf(note, id, rule.workflow),
    needs: {
      owner: note.migrations.filter((m) => m.owner).map((m) => m.path),
      approvers: note.approvers.map((a) => a.id),
    },
  };
}

const migrationsDigest = (n: ReleaseNote): string => digest(JSON.stringify(n.migrations));

/** The record of an announced draft: the announcement is logged before anything can trigger. */
export function announce(ctx: Pick<ReleaseContext, 'stateRoot' | 'now'>, d: Draft): Release {
  const at = ctx.now().toISOString();
  const rec: Release = {
    v: 1,
    id: d.id,
    component: d.component.id,
    repo: d.note.repo,
    branch: d.note.branch,
    sha: d.note.sha,
    since: d.note.since,
    createdAt: at,
    status: 'announced',
    workflow: d.rule.workflow,
    timeoutMinutes: d.rule.timeoutMinutes,
    note: d.note,
    migrationsDigest: migrationsDigest(d.note),
    workflowBlobs: d.workflowBlobs,
    guardPin: d.guardPin,
    ...(d.rollbackWorkflow === undefined ? {} : { rollbackWorkflow: d.rollbackWorkflow }),
    needs: d.needs,
    announcement: { at, text: d.announcement },
    approvals: [],
    started: {},
    checks: [],
  };
  rec.status = pendingApprovals(rec).length > 0 ? 'approvals' : 'announced';
  log(ctx.stateRoot, ctx.now(), {
    event: 'announced',
    release: rec.id,
    component: rec.component,
    sha: rec.sha,
    text: d.announcement,
  });
  return rec;
}

// --- Approvals ---------------------------------------------------------------------------------

/** The approvals a release still waits for: `owner` and approver ids. */
export function pendingApprovals(rec: Release): string[] {
  const have = new Set(rec.approvals.map((a) => a.approver));
  return [
    ...(rec.needs.owner.length > 0 && !have.has('owner') ? ['owner'] : []),
    ...rec.needs.approvers.filter((a) => !have.has(a)),
  ];
}

/** Shapes of credentials: an approval's words must never carry one into the log. */
const SECRET_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];
export const looksSecret = (s: string): boolean => SECRET_SHAPES.some((re) => re.test(s));

/**
 * Records one approval. The owner's (`owner`) only from the owner in a terminal; a third party's
 * from the lead or the owner, with who said it, when and their words. Bound to the release: it
 * does not carry over to another one.
 */
export function recordApproval(
  ctx: Pick<ReleaseContext, 'stateRoot' | 'now'>,
  rec: Release,
  o: { approver: string; by: 'lead' | 'owner'; who?: string; said: string; at?: string },
): { rec: Release; existing: boolean } {
  if (!BEFORE_TRIGGER.includes(rec.status)) {
    throw new Error(`${rec.id} is ${rec.status}: approvals count only before the trigger`);
  }
  const said = clean(o.said, 500);
  if (said === '') throw new Error('an approval needs --said "<their words, verbatim>"');
  if (looksSecret(o.said) || (o.who !== undefined && looksSecret(o.who))) {
    throw new Error('the approval text looks like a credential; nothing recorded');
  }
  const now = ctx.now();
  let who: string;
  if (o.approver === 'owner') {
    if (o.by !== 'owner') {
      throw new Error(
        `${rec.id}: the owner approves migrations himself, in a terminal: studio release approve ${rec.id} owner --said "<words>"; nothing recorded`,
      );
    }
    if (rec.needs.owner.length === 0) throw new Error(`${rec.id} needs no owner approval`);
    if (o.who !== undefined && clean(o.who, 100) !== 'owner') {
      throw new Error('--by is for a third party; the owner approves as the owner');
    }
    who = 'owner';
  } else {
    if (!APPROVER_ID_RE.test(o.approver) || !rec.needs.approvers.includes(o.approver)) {
      throw new Error(
        `${rec.id} needs no approval from ${clean(o.approver, 40)} (it needs: ${pendingApprovals(rec).join(', ') || 'nothing'})`,
      );
    }
    who = clean(o.who ?? '', 100);
    if (who === '') throw new Error('a third-party approval needs --by "<who said it>"');
  }
  let at = now.toISOString();
  if (o.at !== undefined) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) throw new Error('--at takes a time, e.g. 2026-11-05T14:30:00+01:00');
    if (t > now.getTime() + 60_000) throw new Error('--at lies in the future');
    if (t < Date.parse(rec.createdAt)) {
      throw new Error(
        `--at lies before ${rec.id} was announced: an approval counts only for this release`,
      );
    }
    at = new Date(t).toISOString();
  }
  const prior = rec.approvals.find((a) => a.approver === o.approver);
  if (prior !== undefined) return { rec, existing: true };
  const approval: Approval = {
    approver: o.approver,
    who,
    said,
    at,
    recordedAt: now.toISOString(),
    recordedBy: o.by,
  };
  const next: Release = { ...rec, approvals: [...rec.approvals, approval] };
  next.status = pendingApprovals(next).length > 0 ? 'approvals' : 'announced';
  log(ctx.stateRoot, now, { event: 'approved', release: rec.id, ...approval });
  return { rec: next, existing: false };
}

/** Stops a release before its trigger; after it Studio cannot undo anything. */
export function stopRelease(
  ctx: Pick<ReleaseContext, 'stateRoot' | 'now'>,
  rec: Release,
  by: 'lead' | 'owner',
  reason: string,
): Release {
  if (!BEFORE_TRIGGER.includes(rec.status)) {
    throw new Error(
      rec.status === 'triggered' || rec.status === 'checking'
        ? `${rec.id} was triggered: Studio cannot stop a deploy; the way back: ${rec.note.wayBack.join('; ')}`
        : `${rec.id} is ${rec.status} already`,
    );
  }
  const why = clean(reason, 300);
  if (why === '') throw new Error('cancel needs --reason "<one line>"');
  if (looksSecret(reason)) throw new Error('the reason looks like a credential; nothing recorded');
  const now = ctx.now().toISOString();
  log(ctx.stateRoot, ctx.now(), { event: 'stopped', release: rec.id, by, reason: why });
  return { ...rec, status: 'stopped', finishedAt: now, reason: `stopped by the ${by}: ${why}` };
}

// --- The trigger -------------------------------------------------------------------------------

export type TriggerResult =
  | { kind: 'triggered'; rec: Release }
  | { kind: 'held'; line: string }
  | { kind: 'refused'; line: string };

/**
 * Starts the release workflow once. The capacity rule first, then every check of what would run,
 * then the branch head read once more (it must still be the head the checks saw), then the record
 * (status `triggered`) written, then `gh workflow run`. A crash after the write leaves a trigger
 * without a run, which `advance` looks for and never starts again; `advance` also holds the run
 * to the checked head.
 */
export async function triggerRelease(
  ctx: ReleaseContext,
  rec: Release,
  o: {
    by: 'lead' | 'owner';
    paused: boolean;
    capacity: () => Promise<{ ok: boolean; line: string }>;
    save: (rec: Release) => void;
    beat: () => void;
  },
): Promise<TriggerResult> {
  if (rec.status !== 'announced') {
    return { kind: 'refused', line: `${rec.id} is ${rec.status}, not ready to trigger` };
  }
  const pending = pendingApprovals(rec);
  if (pending.length > 0) {
    return { kind: 'held', line: `${rec.id} waits for approvals: ${pending.join(', ')}` };
  }
  if (o.paused) {
    return { kind: 'held', line: 'paused: no release starts until the owner runs studio resume' };
  }
  // Capacity first: its two reads take a while, and every check below must still hold after it.
  o.beat();
  const cap = await o.capacity();
  if (!cap.ok) return { kind: 'held', line: cap.line };
  o.beat();
  const redraft = `studio release cancel ${rec.id} --reason "<line>", then draft again`;
  const branch = await readDefault(ctx.gh, rec.repo);
  if (branch === undefined)
    return { kind: 'held', line: `cannot read the default branch of ${rec.repo}` };
  if (branch !== rec.branch) {
    return {
      kind: 'refused',
      line: `the default branch of ${rec.repo} is ${branch} now, not ${rec.branch}: ${redraft}`,
    };
  }
  const head = await resolveRef(ctx.gh, rec.repo, branch);
  if (head === undefined) return { kind: 'held', line: `cannot read the head of ${branch}` };
  const co = ctx.checkout(rec.repo);
  await fetchCommits(ctx.git, co, [rec.sha, head]);
  if (!(await isAncestor(ctx.git, co, rec.sha, head))) {
    return { kind: 'refused', line: `${short(rec.sha)} is no longer on ${branch}: ${redraft}` };
  }
  // The rules and the note come from the release commit; they cannot have changed, but the
  // migrations an owner approved must be the ones that ship.
  const { component, rule, config } = await ruleAt(ctx.git, co, rec.sha, rec.component);
  if (rule.workflow !== rec.workflow) {
    return { kind: 'refused', line: `${rec.id}: the release workflow differs from its record` };
  }
  // Read again, not taken from the record: what an owner approved is what ships, also after a
  // Studio update that reads migrations differently or a record changed by hand.
  const fresh = await buildNote(ctx, {
    component,
    rule,
    config,
    branch,
    since: rec.since,
    sha: rec.sha,
  });
  if (
    migrationsDigest(fresh) !== rec.migrationsDigest ||
    migrationsDigest(rec.note) !== rec.migrationsDigest
  ) {
    return {
      kind: 'refused',
      line: `${rec.id}: its migrations read differently now than when it was announced: ${redraft}`,
    };
  }
  const approvers = new Set(rec.needs.approvers);
  const missing = fresh.approvers.filter((a) => !approvers.has(a.id));
  if (missing.length > 0) {
    return {
      kind: 'refused',
      line: `${rec.id} needs ${missing.map((a) => a.id).join(', ')} now: ${redraft}`,
    };
  }
  // GitHub runs the workflow file at the branch head: it must be the one pinned in the record
  // when the release was announced (and approved), and the one at the release commit.
  const started = [rule.workflow, ...rule.postChecks.map((p) => p.workflow)];
  const rollback = 'workflow' in rule.rollback ? [rule.rollback.workflow] : [];
  for (const file of new Set(started)) {
    const [a, b] = [
      await blobAt(ctx.git, co, rec.sha, file),
      await blobAt(ctx.git, co, head, file),
    ];
    if (a === undefined || a !== b || rec.workflowBlobs[file] !== a) {
      return { kind: 'refused', line: `${file} changed since ${rec.id} was announced: ${redraft}` };
    }
    const problem = await dispatchProblem(ctx.git, co, rec.sha, file, {
      crewAllowed: config.crewAllowedWorkflows,
      input: true,
    });
    if (problem !== undefined) return { kind: 'refused', line: `${rec.id}: ${problem}` };
  }
  for (const file of rollback) {
    const [a, b] = [
      await blobAt(ctx.git, co, rec.sha, file),
      await blobAt(ctx.git, co, head, file),
    ];
    if (a === undefined || a !== b || rec.workflowBlobs[file] !== a) {
      return { kind: 'refused', line: `${file} changed since ${rec.id} was announced: ${redraft}` };
    }
    const problem = await dispatchProblem(ctx.git, co, rec.sha, file, {
      crewAllowed: config.crewAllowedWorkflows,
      input: false,
    });
    if (problem !== undefined) return { kind: 'refused', line: `${rec.id}: ${problem}` };
  }
  // Everything the workflows run: `.github` (workflows, actions) and the guarded paths.
  const [pinAtSha, pinAtHead] = [
    await guardPinAt(ctx.git, co, rec.sha, rule.guardedPaths),
    await guardPinAt(ctx.git, co, head, rule.guardedPaths),
  ];
  if (pinAtSha !== rec.guardPin || pinAtHead !== rec.guardPin) {
    return {
      kind: 'refused',
      line: `.github or a guarded path changed since ${rec.id} was announced: ${redraft}`,
    };
  }
  let list: Listed[];
  try {
    list = await listWorkflows(ctx.gh, rec.repo);
  } catch (e) {
    return { kind: 'held', line: (e as Error).message };
  }
  // An entry of crew_allowed_workflows reaches a workflow the way gh resolves it: a deploy, its
  // checks and its way back are never a crew's.
  const guarded = new Set([...started, ...rollback]);
  for (const entry of config.crewAllowedWorkflows) {
    const hit = crewReach(entry, list).find((w) => guarded.has(w.path));
    if (hit !== undefined) {
      return {
        kind: 'refused',
        line: `${rec.id}: crew_allowed_workflows entry ${clean(entry, 100)} reaches ${hit.path}: a crew may never start a release workflow`,
      };
    }
  }
  const ids = idsOf(list);
  const workflowId = ids.get(rule.workflow);
  if (workflowId === undefined) {
    return {
      kind: 'refused',
      line: `${rule.workflow} is no workflow of ${rec.repo} GitHub can tell apart (missing or listed twice)`,
    };
  }
  for (const p of rule.postChecks) {
    if (!ids.has(p.workflow)) {
      return {
        kind: 'refused',
        line: `${p.workflow} is no workflow of ${rec.repo} GitHub can tell apart`,
      };
    }
  }
  // The head once more, right before the dispatch: GitHub runs the file of the head it sees then.
  o.beat();
  const again = await resolveRef(ctx.gh, rec.repo, branch);
  if (again !== head) {
    return {
      kind: 'held',
      line: `${branch} moved while ${rec.id} was checked; run studio release ${rec.component} again`,
    };
  }
  // Recorded first: a crash right after this never starts the workflow a second time.
  const at = ctx.now().toISOString();
  let next: Release = {
    ...rec,
    status: 'triggered',
    trigger: { at, by: o.by, head, workflowId },
    checks: rule.postChecks.map((p) => ({
      name: `${p.workflow} / ${p.job}`,
      workflow: p.workflow,
      job: p.job,
      state: 'pending' as const,
    })),
  };
  o.save(next);
  log(ctx.stateRoot, ctx.now(), {
    event: 'triggered',
    release: rec.id,
    by: o.by,
    sha: rec.sha,
    head,
  });
  const r = await ctx.gh.run(
    [
      'workflow',
      'run',
      String(workflowId),
      '--repo',
      rec.repo,
      '--ref',
      branch,
      '-f',
      `${SHA_INPUT}=${rec.sha}`,
    ],
    { timeoutMs: GH_MS },
  );
  if (r.code !== 0) {
    const why = clean(r.stderr.split('\n')[0] ?? '', 300) || `gh exit ${r.code}`;
    if (refusedByGitHub(r.stderr)) {
      // GitHub said no: nothing started, and nothing starts again for this release.
      next = {
        ...next,
        status: 'failed',
        trigger: { ...(next.trigger as NonNullable<Release['trigger']>), refused: why },
        finishedAt: ctx.now().toISOString(),
        reason: clean(
          `the release workflow could not be started (${why}); nothing was deployed`,
          600,
        ),
      };
      o.save(next);
      log(ctx.stateRoot, ctx.now(), { event: 'failed', release: rec.id, reason: next.reason });
    }
    // Anything else (a timeout, a lost connection) may have started it: it stays triggered and
    // `advance` looks for the run, never dispatching again.
    return { kind: 'triggered', rec: next };
  }
  const run = runFromOutput(rec.repo, `${r.stdout}\n${r.stderr}`);
  if (run !== undefined) {
    next = { ...next, trigger: { ...(next.trigger as NonNullable<Release['trigger']>), run } };
    o.save(next);
  }
  return { kind: 'triggered', rec: next };
}

/** A dispatch GitHub answered with a client error: it did not start anything. */
const refusedByGitHub = (stderr: string): boolean => /\bHTTP 4\d\d\b/.test(stderr);

// --- After the trigger: the run and the checks -------------------------------------------------

type JobState = ReleaseCheck['state'];

const jobState = (run: Run, job: string): JobState => {
  const legs = run.jobs.filter((j) => j.name === job || j.name.startsWith(`${job} (`));
  if (legs.length === 0) return run.status === 'completed' ? 'missing' : 'pending';
  const states = legs.map(
    (j): JobState =>
      j.status !== 'completed' ? 'pending' : j.conclusion === 'success' ? 'pass' : 'fail',
  );
  for (const s of ['fail', 'pending', 'pass'] as const) if (states.includes(s)) return s;
  return 'missing';
};

export interface Advance {
  rec: Release;
  /** A line for the lead: the run cannot be found, several match, or the result is unknown. */
  lead?: string;
  /** A line about what waits, for the output. */
  waiting?: string;
}

/**
 * Moves a triggered release on from what GitHub shows: the release run (found by the URL gh
 * printed, else as the one dispatch since the trigger), then each post-deploy job. Any run Studio
 * cannot read, any job missing from a completed run, a run of another workflow or event or of
 * another head than the checked one, several candidate runs, and no result before the timeout
 * fail closed. Red stops the release with the way back shown; Studio runs nothing back. A
 * post-check in another workflow is started once, recorded first, and only under the same rules as
 * the trigger: `gate` (pause and capacity) holds, and the workflow file at the head is the pinned one.
 */
export async function advanceRelease(
  ctx: Pick<ReleaseContext, 'gh' | 'git' | 'checkout' | 'stateRoot' | 'now'>,
  rec: Release,
  o: {
    save: (rec: Release) => void;
    /** Why a post-check may not start now (paused, CI busy); undefined when it may. */
    gate: () => Promise<string | undefined>;
    beat?: () => void;
  },
): Promise<Advance> {
  if (rec.status !== 'triggered' && rec.status !== 'checking') return { rec };
  const trigger = rec.trigger;
  if (trigger === undefined) return fail(ctx, rec, o, 'the trigger was not recorded');
  const now = ctx.now();
  const age = now.getTime() - Date.parse(trigger.at);
  const late = age > rec.timeoutMinutes * 60_000;
  let next = rec;
  let run = trigger.run;
  if (run === undefined) {
    const found = await findDispatchedRun(
      ctx.gh,
      rec.repo,
      trigger.workflowId,
      rec.branch,
      trigger.at,
    );
    if (found.several === true) {
      if (late) {
        return fail(
          ctx,
          rec,
          o,
          `several runs of ${rec.workflow} started since the trigger and none can be told to be this release's; check them on GitHub`,
        );
      }
      return {
        rec,
        lead: `release unknown: ${rec.id}: several runs of ${rec.workflow} started since the trigger; Studio does not guess which one deploys ${short(rec.sha)}; check them on GitHub, nothing is started again`,
      };
    }
    if (found.run === undefined) {
      if (late) return fail(ctx, rec, o, `no run of ${rec.workflow} appeared after the trigger`);
      return age >= RUN_FIND_MS
        ? {
            rec,
            lead: `release unknown: ${rec.id}: no run of ${rec.workflow} since the trigger at ${trigger.at}; check GitHub Actions, nothing is started again`,
          }
        : { rec, waiting: `${rec.id}: waiting for the run of ${rec.workflow} to appear` };
    }
    run = found.run;
    next = { ...next, trigger: { ...trigger, run } };
    o.save(next);
  }
  const view = await viewRun(ctx.gh, rec.repo, run);
  if (view === undefined) {
    if (late) return fail(ctx, next, o, `the release run ${run} cannot be read: no known result`);
    return { rec: next, waiting: `${rec.id}: cannot read the release run ${run} now` };
  }
  if (
    (view.workflowDatabaseId !== undefined && view.workflowDatabaseId !== trigger.workflowId) ||
    (view.event !== undefined && view.event !== 'workflow_dispatch')
  ) {
    return fail(ctx, next, o, `run ${run} is not a dispatch of ${rec.workflow}`);
  }
  // The run must be of the head the trigger checked: another head ran another workflow file.
  if (view.headSha?.toLowerCase() !== trigger.head.toLowerCase()) {
    return fail(
      ctx,
      next,
      o,
      `the release run ${run} ran at ${view.headSha === undefined ? 'an unknown commit' : short(view.headSha)}, not at the checked head ${short(trigger.head)}`,
    );
  }
  if (view.status !== 'completed') {
    if (late)
      return fail(
        ctx,
        next,
        o,
        `the release run ${run} did not finish in ${rec.timeoutMinutes} minutes`,
      );
    return { rec: next, waiting: `${rec.id}: the release run ${run} is ${clean(view.status, 30)}` };
  }
  if (view.conclusion !== 'success') {
    return fail(
      ctx,
      next,
      o,
      `the release run ${run} ended ${clean(view.conclusion ?? 'without a conclusion', 30)}`,
    );
  }
  if (next.deployedAt === undefined) {
    next = { ...next, status: 'checking', deployedAt: now.toISOString() };
    o.save(next);
    // The deploy happened: it counts in the metrics like `studio deploy record`.
    appendStateLine(
      ctx.stateRoot,
      'metrics.jsonl',
      JSON.stringify({ type: 'deployed', at: now.toISOString(), sha: rec.sha, release: rec.id }),
    );
    log(ctx.stateRoot, now, { event: 'deployed', release: rec.id, run });
  }
  const checks: ReleaseCheck[] = [];
  const whys: string[] = [];
  let lead: string | undefined;
  let hold: string | undefined;
  for (const c of next.checks) {
    o.beat?.();
    if (c.workflow === rec.workflow) {
      checks.push({ ...c, state: jobState(view, c.job), run });
      continue;
    }
    let started = next.started[c.workflow];
    if (started === undefined) {
      // Under the trigger's rules: not while paused or CI is busy, and only the pinned file.
      hold = hold ?? (await o.gate());
      if (hold !== undefined) {
        checks.push({ ...c, state: 'pending' });
        continue;
      }
      const head = await resolveRef(ctx.gh, rec.repo, rec.branch);
      if (head === undefined) {
        checks.push({ ...c, state: 'pending' });
        continue;
      }
      const co = ctx.checkout(rec.repo);
      let blob: string | undefined;
      try {
        await fetchCommits(ctx.git, co, [head]);
        blob = await blobAt(ctx.git, co, head, c.workflow);
      } catch {
        blob = undefined;
      }
      if (blob === undefined || blob !== rec.workflowBlobs[c.workflow]) {
        whys.push(`${c.workflow} changed on ${rec.branch} since ${rec.id} was announced`);
        checks.push({ ...c, state: 'missing' });
        continue;
      }
      const workflowId = await workflowIdOf(ctx.gh, rec.repo, c.workflow);
      if (workflowId === undefined) {
        checks.push({ ...c, state: 'missing' });
        continue;
      }
      // Recorded first, as the trigger: started once, whatever happens next.
      started = { at: ctx.now().toISOString(), workflowId, head };
      next = { ...next, started: { ...next.started, [c.workflow]: started } };
      o.save(next);
      const r = await ctx.gh.run(
        [
          'workflow',
          'run',
          String(workflowId),
          '--repo',
          rec.repo,
          '--ref',
          rec.branch,
          '-f',
          `${SHA_INPUT}=${rec.sha}`,
        ],
        { timeoutMs: GH_MS },
      );
      if (r.code !== 0) {
        // Only a refusal GitHub states is one; anything else is looked up like the trigger.
        if (refusedByGitHub(r.stderr)) {
          started = {
            ...started,
            refused: clean(r.stderr.split('\n')[0] ?? '', 300) || `gh exit ${r.code}`,
          };
        }
      } else {
        const id = runFromOutput(rec.repo, `${r.stdout}\n${r.stderr}`);
        if (id !== undefined) started = { ...started, run: id };
      }
      next = { ...next, started: { ...next.started, [c.workflow]: started } };
      o.save(next);
    }
    if (started.refused !== undefined) {
      checks.push({ ...c, state: 'fail' });
      continue;
    }
    let checkRun = started.run;
    if (checkRun === undefined) {
      const found = await findDispatchedRun(
        ctx.gh,
        rec.repo,
        started.workflowId,
        rec.branch,
        started.at,
      );
      if (found.several === true) {
        lead = `release unknown: ${rec.id}: several runs of ${c.workflow} since Studio started it; check them on GitHub`;
      }
      checkRun = found.run;
      if (checkRun !== undefined) {
        started = { ...started, run: checkRun };
        next = { ...next, started: { ...next.started, [c.workflow]: started } };
        o.save(next);
      }
    }
    if (checkRun === undefined) {
      checks.push({ ...c, state: 'pending' });
      continue;
    }
    const v = await viewRun(ctx.gh, rec.repo, checkRun);
    const wrong =
      v !== undefined &&
      ((v.workflowDatabaseId !== undefined && v.workflowDatabaseId !== started.workflowId) ||
        started.head === undefined ||
        v.headSha?.toLowerCase() !== started.head.toLowerCase());
    if (wrong) whys.push(`run ${checkRun} of ${c.workflow} is not the one Studio started`);
    checks.push({
      ...c,
      run: checkRun,
      state: v === undefined ? 'pending' : wrong ? 'missing' : jobState(v, c.job),
    });
  }
  next = { ...next, checks };
  const red = checks.filter((c) => c.state === 'fail' || c.state === 'missing');
  if (red.length > 0) {
    return fail(
      ctx,
      next,
      o,
      [
        `${red.map((c) => `${c.name} ${c.state === 'fail' ? 'failed' : 'gave no result'}`).join(', ')} after the deploy`,
        ...whys,
      ].join('; '),
    );
  }
  const pending = checks.filter((c) => c.state === 'pending');
  if (pending.length > 0) {
    if (late) {
      return fail(
        ctx,
        next,
        o,
        `${pending.map((c) => c.name).join(', ')} gave no result in ${rec.timeoutMinutes} minutes`,
      );
    }
    o.save(next);
    return {
      rec: next,
      waiting: `${rec.id}: deployed, waiting for ${pending.map((c) => c.name).join(', ')}${hold === undefined ? '' : ` (${hold})`}`,
      ...(lead === undefined ? {} : { lead }),
    };
  }
  next = { ...next, status: 'done', finishedAt: now.toISOString() };
  o.save(next);
  log(ctx.stateRoot, now, { event: 'done', release: rec.id });
  return { rec: next };
}

async function workflowIdOf(gh: Gh, repo: string, file: string): Promise<number | undefined> {
  try {
    return (await workflowIds(gh, repo)).get(file);
  } catch {
    return undefined;
  }
}

function fail(
  ctx: Pick<ReleaseContext, 'stateRoot' | 'now'>,
  rec: Release,
  o: { save: (rec: Release) => void },
  why: string,
): Advance {
  const reason = clean(why, 600);
  const next: Release = {
    ...rec,
    status: 'failed',
    finishedAt: ctx.now().toISOString(),
    reason,
  };
  o.save(next);
  log(ctx.stateRoot, ctx.now(), { event: 'failed', release: rec.id, reason });
  return { rec: next, lead: failedLine(next) };
}

/**
 * The lead's line for a stopped deploy: what is red and the way back, which Studio never runs. A
 * rollback workflow whose pin no longer holds (`rollbackOk: false`) is not offered as the way back.
 */
export const failedLine = (r: Release, rollbackOk = true): string =>
  clean(
    `release failed: ${r.id}: ${r.reason ?? 'red'}; ${r.deployedAt === undefined ? 'the deploy did not finish' : `${short(r.sha)} is deployed`}; Studio runs nothing back; the way back: ${rollbackOk ? r.note.wayBack.join('; ') : rollbackChangedLine(r)}`,
    1500,
  );

export const rollbackChangedLine = (r: Release): string =>
  `${r.rollbackWorkflow ?? 'the rollback workflow'} changed on ${r.branch} since ${r.id} was announced: read it before running anything, Studio offers it no longer`;

/**
 * Whether the rollback workflow is still the one pinned at the announcement, at the release
 * commit and at the branch head; true when the way back is a text. Unreadable is false.
 */
export async function rollbackPinHolds(
  ctx: Pick<ReleaseContext, 'gh' | 'git' | 'checkout'>,
  r: Release,
): Promise<boolean> {
  const file = r.rollbackWorkflow;
  if (file === undefined) return true;
  try {
    const head = await resolveRef(ctx.gh, r.repo, r.branch);
    if (head === undefined) return false;
    const co = ctx.checkout(r.repo);
    await fetchCommits(ctx.git, co, [r.sha, head]);
    const [a, b] = [await blobAt(ctx.git, co, r.sha, file), await blobAt(ctx.git, co, head, file)];
    return a !== undefined && a === b && r.workflowBlobs[file] === a;
  } catch {
    return false;
  }
}

/** `failedLine` with the rollback pin checked right now. */
export const failedLead = async (
  ctx: Pick<ReleaseContext, 'gh' | 'git' | 'checkout'>,
  r: Release,
): Promise<string> => failedLine(r, await rollbackPinHolds(ctx, r));

/**
 * The pin of what a release's workflows run at `sha`: the tree of `.github` (workflows, actions)
 * and every file the component's `guarded_paths` match, by blob.
 */
export async function guardPinAt(
  git: Git,
  co: Checkout,
  sha: string,
  guarded: readonly string[],
): Promise<string> {
  let tree = 'none';
  try {
    const oid = (await g(git, co, ['rev-parse', '--verify', '--quiet', `${sha}:.github`])).trim();
    if (/^[0-9a-f]{40,64}$/.test(oid)) tree = oid;
  } catch {
    tree = 'none';
  }
  let files = '';
  if (guarded.length > 0) {
    const out = await g(git, co, ['ls-tree', '-r', '--full-tree', '-z', sha]);
    files = out
      .split('\0')
      .filter((e) => e !== '')
      .map((e) => {
        const tab = e.indexOf('\t');
        return { meta: e.slice(0, tab), path: e.slice(tab + 1) };
      })
      .filter((e) => guarded.some((p) => matchGlob(p, e.path)))
      .map((e) => `${e.meta} ${e.path}`)
      .sort()
      .join('\n');
  }
  return `github:${tree} guarded:${digest(files)}`;
}

/** What a release waits for from the lead or the owner, as needsLead lines. */
export function approvalLines(r: Release): { item: string; reason: string }[] {
  if (!BEFORE_TRIGGER.includes(r.status)) return [];
  return pendingApprovals(r).map((who) => {
    if (who === 'owner') {
      return {
        item: r.id,
        reason: `release approval: ${r.id} ships migrations that are not clearly additive (${r.needs.owner.join(', ')}); the owner approves in a terminal: studio release approve ${r.id} owner --said "<the owner's words>"`,
      };
    }
    const a = r.note.approvers.find((x) => x.id === who);
    return {
      item: r.id,
      reason: `release approval: ${r.id} needs ${who} (${a?.who ?? who}${a?.for === undefined ? '' : `, for ${a.for}`}); Studio contacts no one: ask the owner to obtain it, then record it: studio release approve ${r.id} ${who} --by "<who said it>" --said "<their words, verbatim>" --at <when they said it>`,
    };
  });
}

/** One row per release for `release list`, the tick and the pane. */
export function releaseRow(r: Release): {
  id: string;
  component: string;
  status: ReleaseStatus;
  sha: string;
  at: string;
  pending?: string[];
  reason?: string;
} {
  const pending = pendingApprovals(r);
  return {
    id: r.id,
    component: r.component,
    status: r.status,
    sha: short(r.sha),
    at: r.finishedAt ?? r.trigger?.at ?? r.createdAt,
    ...(BEFORE_TRIGGER.includes(r.status) && pending.length > 0 ? { pending } : {}),
    ...(r.reason === undefined ? {} : { reason: r.reason }),
  };
}
