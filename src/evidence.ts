import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { findJob, jobInstances, readWorkflowsAt, type Workflows } from './ci-jobs.js';
import { EVIDENCE_ID_RE, type EvidenceRule, parseConfig } from './config.js';
import { matchGlob } from './glob.js';
import { acquireStateLock, ensureStateDir, removeStateEntry, type StateLock } from './paths.js';
import type { EvidenceRunner, Gh, Git } from './ports.js';
import { appendStateLine, type Check, checkKey } from './queue.js';
import { readDefaultBranch, readPrFacts } from './review.js';

/**
 * Exceptions by evidence. A project binds a guard job (a CI job such as a migration guard) to an
 * evidence command in studio.yaml (`evidence:`). When the guard fails on a pull request and the
 * command, run on exactly that diff, proves the hit a false alarm, the failed checks count as
 * waived for that head, and the exception is logged with its evidence. Without evidence the lead
 * decides; a rule marked `owner_only` sends that decision to the owner.
 *
 * What keeps a pull request from approving itself: the rules, and for `run: local` the command
 * and its scripts, come only from the commit the pull request is based on, on the default branch,
 * never from the working tree or the pull request; the command runs outside every crew sandbox,
 * in a checkout of that base, and reads the diff as a file. The log lives in the state root,
 * which crews cannot write, and only Studio and `studio exceptions grant` (refused to crews)
 * append to it. A pull request that changes the rules or a file they name as `inputs` gets no
 * exception from those rules and no approval from Studio.
 */

export const EXCEPTIONS_FILE = 'exceptions.jsonl';
export const EXCEPTIONS_LOCK = 'exceptions.lock';
export const EXCEPTIONS_LOCK_STALE_MS = 30_000;
/** Where a local evidence run gets its checkout of the base and the diff files. */
export const EVIDENCE_DIR = 'evidence';
/** A lead line about evidence: the lead decides, it is not pushed to the owner's phone. */
export const LEAD_PREFIX = 'evidence: ';
/** A lead line about evidence of an `owner_only` rule: the owner decides. */
export const OWNER_PREFIX = 'evidence (owner): ';

const STUDIO_CONFIG = '.studio/studio.yaml';
const SHA = /^[0-9a-f]{40,64}$/i;
const GIT_FETCH_MS = 120_000;
const GIT_LOCAL_MS = 60_000;
const GIT_CHECKOUT_MS = 300_000;
const MAX_STDOUT = 1024 * 1024;
const LOCK_WAIT_MS = 5000;

const entrySchema = z.object({
  v: z.literal(1),
  at: z.string(),
  /** `applied`: the exception holds for this head; `not_proven`: the command ran and proved nothing. */
  outcome: z.enum(['applied', 'not_proven']),
  /** Who decided: the evidence itself, the lead, or the owner in a terminal. */
  by: z.enum(['evidence', 'lead', 'owner']),
  rule: z.string().regex(EVIDENCE_ID_RE),
  /** The guard job as `<workflow file> / <job>`. */
  guard: z.string(),
  repo: z.string(),
  pr: z.number().int().positive(),
  item: z.string().optional(),
  base: z.string().regex(SHA),
  head: z.string().regex(SHA),
  /** sha256 of `git diff base...head`: what the evidence judged. */
  diff: z.string(),
  run: z.enum(['local', 'ci']).optional(),
  command: z.array(z.string()).optional(),
  /** sha256 of the command's stdout, or of the evidence job's checks. */
  output: z.string().optional(),
  proof: z.string().optional(),
  /** Why the evidence proved nothing: Studio's own text. */
  why: z.string().optional(),
  /** A grant: the lead's or the owner's one line. */
  reason: z.string().optional(),
});
export type ExceptionEntry = z.infer<typeof entrySchema>;

export type PrRef = { repo: string; pr: number; item?: string };

/** What the evidence code needs from outside. */
export interface EvidenceContext {
  gh: Gh;
  git: Git;
  runner?: EvidenceRunner;
  /** The owner's checkout and how it reaches the pull request's repository. */
  checkout: { dir: string; remote: string };
  stateRoot: string;
  now: () => Date;
  /** PATH for the evidence command; the rest of the owner's environment never reaches it. */
  path?: string;
}

const digest = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const short = (sha: string): string => sha.slice(0, 12);
const guardName = (r: EvidenceRule): string => `${r.guard.workflow} / ${r.guard.job}`;
const sameKey = (
  e: Pick<ExceptionEntry, 'rule' | 'repo' | 'pr' | 'base' | 'head'>,
  k: Pick<ExceptionEntry, 'rule' | 'repo' | 'pr' | 'base' | 'head'>,
): boolean =>
  e.rule === k.rule &&
  e.repo === k.repo &&
  e.pr === k.pr &&
  e.base.toLowerCase() === k.base.toLowerCase() &&
  e.head.toLowerCase() === k.head.toLowerCase();

/** Every valid line of the log; a line that does not parse never counts as an exception. */
export function readExceptions(stateRoot: string): ExceptionEntry[] {
  const file = join(stateRoot, EXCEPTIONS_FILE);
  if (!existsSync(file)) return [];
  if (lstatSync(file).isSymbolicLink()) {
    throw new Error(`refusing to read ${file}: it is a symlink`);
  }
  const out: ExceptionEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = entrySchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // a torn or foreign line: skipped
    }
  }
  return out;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Appends `entry` under the log's lock, unless the log already holds the answer for its key (rule,
 * pull request, base and head): an applied exception, or for a `not_proven` entry any entry. So a
 * second process, or a run after a crash, never logs the same result twice. Returns what counts.
 */
export function recordException(stateRoot: string, entry: ExceptionEntry): ExceptionEntry {
  const until = Date.now() + LOCK_WAIT_MS;
  let lock: StateLock | undefined;
  for (;;) {
    lock = acquireStateLock(stateRoot, EXCEPTIONS_LOCK, {
      now: new Date(),
      heartbeatStaleMs: EXCEPTIONS_LOCK_STALE_MS,
    });
    if (lock) break;
    if (Date.now() >= until) throw new Error('the exceptions log is locked by another process');
    sleepSync(50);
  }
  try {
    const known = readExceptions(stateRoot).filter((e) => sameKey(e, entry));
    const applied = known.find((e) => e.outcome === 'applied');
    if (applied !== undefined) return applied;
    if (entry.outcome === 'not_proven' && known.length > 0) return known[0] as ExceptionEntry;
    appendStateLine(stateRoot, EXCEPTIONS_FILE, JSON.stringify(entry));
    return entry;
  } finally {
    lock.release();
  }
}

/** What Studio read about a pull request to judge evidence on it. */
interface Prepared {
  base: string;
  head: string;
  rules: EvidenceRule[];
  /** Every changed path of `base...head`, both sides of a rename. */
  files: string[];
  diff: string;
  baseWorkflows: Workflows;
  headWorkflows: Workflows;
}

type Prepare =
  | { kind: 'ok'; p: Prepared }
  /** No rule can apply: no rules on main, or the pull request is not against the default branch. */
  | { kind: 'none' }
  /** The head moved since the checks were read. */
  | { kind: 'moved' }
  | { kind: 'unreadable'; why: string };

const g = (ctx: EvidenceContext, args: string[], timeoutMs = GIT_LOCAL_MS) =>
  ctx.git.run(ctx.checkout.dir, ['--no-replace-objects', ...args], { timeoutMs });

/** The rules in studio.yaml at `oid`; none when it has no studio.yaml or one that does not load. */
async function rulesAt(ctx: EvidenceContext, oid: string): Promise<EvidenceRule[]> {
  let text: string;
  try {
    text = await g(ctx, ['cat-file', 'blob', `${oid}:${STUDIO_CONFIG}`]);
  } catch {
    return [];
  }
  try {
    return parseConfig(text, `${short(oid)}:${STUDIO_CONFIG}`).evidence ?? [];
  } catch {
    return [];
  }
}

/** The raw `evidence:` block of studio.yaml at `oid`, as JSON; null without one. */
async function rawEvidenceAt(ctx: EvidenceContext, oid: string): Promise<string> {
  let text: string;
  try {
    text = await g(ctx, ['cat-file', 'blob', `${oid}:${STUDIO_CONFIG}`]);
  } catch {
    return 'null';
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    // A file that does not parse loads no rules; as a change it counts like any other.
    return `unparsable:${digest(text)}`;
  }
  const v =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).evidence : null;
  return JSON.stringify(v ?? null);
}

async function fetchBoth(ctx: EvidenceContext, base: string, head: string): Promise<boolean> {
  try {
    await g(
      ctx,
      ['fetch', '--no-tags', '--no-write-fetch-head', ctx.checkout.remote, base, head],
      GIT_FETCH_MS,
    );
    return true;
  } catch {
    return false;
  }
}

async function changedFiles(
  ctx: EvidenceContext,
  base: string,
  head: string,
): Promise<string[] | undefined> {
  try {
    const out = await g(ctx, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`]);
    return out.split('\0').filter((p) => p !== '');
  } catch {
    return undefined;
  }
}

async function prepare(ctx: EvidenceContext, ref: PrRef, head: string): Promise<Prepare> {
  const facts = await readPrFacts({ gh: ctx.gh }, ref);
  if (facts === undefined) return { kind: 'unreadable', why: 'the pull request cannot be read' };
  if (facts.head.toLowerCase() !== head.toLowerCase()) return { kind: 'moved' };
  // Rules come from main only: another base branch has no say over exceptions.
  const main = await readDefaultBranch({ gh: ctx.gh }, ref.repo);
  if (main === undefined) return { kind: 'unreadable', why: 'the default branch cannot be read' };
  if (facts.base !== main) return { kind: 'none' };
  const base = facts.baseOid;
  if (base === undefined || !SHA.test(base) || !SHA.test(head)) {
    return { kind: 'unreadable', why: 'the base commit is unknown' };
  }
  if (!(await fetchBoth(ctx, base, head))) {
    return { kind: 'unreadable', why: 'the base and head cannot be fetched' };
  }
  const rules = await rulesAt(ctx, base);
  if (rules.length === 0) return { kind: 'none' };
  const files = await changedFiles(ctx, base, head);
  let diff: string | undefined;
  try {
    diff = await g(ctx, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--binary',
      `${base}...${head}`,
    ]);
  } catch {
    diff = undefined;
  }
  if (files === undefined || diff === undefined) {
    return { kind: 'unreadable', why: 'the diff cannot be read' };
  }
  let baseWorkflows: Workflows;
  let headWorkflows: Workflows;
  try {
    baseWorkflows = await readWorkflowsAt(ctx.git, ctx.checkout.dir, base);
    headWorkflows = await readWorkflowsAt(ctx.git, ctx.checkout.dir, head);
  } catch {
    return { kind: 'unreadable', why: 'the workflows cannot be listed' };
  }
  return {
    kind: 'ok',
    p: { base, head, rules, files, diff, baseWorkflows, headWorkflows },
  };
}

/** The checks of `job` that `check` is one of (itself, or a matrix leg of it). */
const isCheckOf = (check: Check, target: { workflow: string; job: string }): boolean => {
  const mine = jobInstances([check], target.workflow, target.job);
  return mine !== 'ambiguous' && mine.length === 1;
};

/** Why the guard of `r` at the head is not the base's; undefined when it is the same job. */
function guardChanged(p: Prepared, r: EvidenceRule): string | undefined {
  const atBase = findJob(p.baseWorkflows, r.guard.workflow, r.guard.job, 'the base');
  const atHead = findJob(p.headWorkflows, r.guard.workflow, r.guard.job, 'the head');
  if (typeof atBase === 'string') return atBase;
  if (typeof atHead === 'string') return 'the guard job changed in this pull request';
  if (JSON.stringify(atBase) !== JSON.stringify(atHead)) {
    return 'the guard job changed in this pull request';
  }
  return undefined;
}

const touchesInputs = (p: Prepared, r: EvidenceRule): boolean =>
  p.files.some((f) => r.inputs.some((glob) => matchGlob(glob, f)));

const isGithubPath = (f: string): boolean => {
  const lower = f.toLowerCase();
  return lower === '.github' || lower.startsWith('.github/');
};

type Attempt =
  | { kind: 'proven'; entry: ExceptionEntry }
  | { kind: 'wait'; why: string }
  | { kind: 'no'; why: string };

/** Runs the command of a local rule in a checkout of the base, with the diff as a file. */
async function runLocal(
  ctx: EvidenceContext,
  p: Prepared,
  r: EvidenceRule,
  ref: PrRef,
  base: Omit<ExceptionEntry, 'outcome' | 'by'>,
): Promise<Attempt> {
  const known = readExceptions(ctx.stateRoot).find(
    (e) => e.outcome === 'not_proven' && sameKey(e, base),
  );
  // The same command on the same diff gives the same answer: it never runs twice.
  if (known !== undefined) return { kind: 'no', why: known.why ?? 'it proved nothing' };
  if (ctx.runner === undefined) return { kind: 'no', why: 'no command runner' };
  const command = r.command ?? [];
  const name = createHash('sha256')
    .update(`${r.id}\0${ref.repo}#${ref.pr}\0${p.base}\0${p.head}`)
    .digest('hex')
    .slice(0, 16);
  const dir = join(ctx.stateRoot, EVIDENCE_DIR, name);
  const tree = join(dir, 'tree');
  const home = join(dir, 'home');
  // What a crash left of an earlier run of the same key goes first.
  removeStateEntry(ctx.stateRoot, dir);
  await g(ctx, ['worktree', 'prune']).catch(() => '');
  ensureStateDir(ctx.stateRoot, home);
  let added = false;
  try {
    try {
      // Hooks off: nothing of the repository runs but the command itself.
      await g(
        ctx,
        ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--force', tree, p.base],
        GIT_CHECKOUT_MS,
      );
      added = true;
    } catch {
      return { kind: 'no', why: 'the base cannot be checked out' };
    }
    const diffFile = join(dir, 'diff.patch');
    const filesFile = join(dir, 'files.txt');
    writeFileSync(diffFile, p.diff === '' || p.diff.endsWith('\n') ? p.diff : `${p.diff}\n`, {
      mode: 0o600,
    });
    writeFileSync(filesFile, p.files.map((f) => `${f}\n`).join(''), { mode: 0o600 });
    const env: Record<string, string> = {
      PATH: ctx.path ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      TMPDIR: home,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      STUDIO_EVIDENCE_RULE: r.id,
      STUDIO_EVIDENCE_REPO: ref.repo,
      STUDIO_EVIDENCE_PR: String(ref.pr),
      STUDIO_EVIDENCE_BASE: p.base,
      STUDIO_EVIDENCE_HEAD: p.head,
      STUDIO_EVIDENCE_DIFF: diffFile,
      STUDIO_EVIDENCE_FILES: filesFile,
    };
    const result = await ctx.runner.run(command, {
      cwd: tree,
      env,
      timeoutMs: r.timeoutSeconds * 1000,
      maxBytes: MAX_STDOUT,
    });
    const proven =
      !result.timedOut &&
      result.code === 0 &&
      result.stdout.split(/\r?\n/).some((line) => line === r.proof);
    const why = proven
      ? undefined
      : result.timedOut
        ? `timed out after ${r.timeoutSeconds} s`
        : result.code !== 0
          ? `exit code ${result.code}`
          : 'its output lacks the proof line';
    const entry = recordException(ctx.stateRoot, {
      ...base,
      outcome: proven ? 'applied' : 'not_proven',
      by: 'evidence',
      run: 'local',
      command,
      output: digest(result.stdout),
      ...(r.proof === undefined ? {} : { proof: r.proof }),
      ...(why === undefined ? {} : { why }),
    });
    return entry.outcome === 'applied'
      ? { kind: 'proven', entry }
      : { kind: 'no', why: entry.why ?? 'it proved nothing' };
  } finally {
    if (added) await g(ctx, ['worktree', 'remove', '--force', tree]).catch(() => '');
    removeStateEntry(ctx.stateRoot, dir);
  }
}

/** A CI rule: its evidence job on this head, unchanged from the base, must have passed. */
function judgeCi(
  ctx: EvidenceContext,
  p: Prepared,
  r: EvidenceRule,
  checks: readonly Check[],
  base: Omit<ExceptionEntry, 'outcome' | 'by'>,
): Attempt {
  const job = r.job as NonNullable<EvidenceRule['job']>;
  // The job runs the pull request head: no part of CI may differ from the base.
  if (p.files.some(isGithubPath)) return { kind: 'no', why: 'the pull request changes .github/' };
  const atBase = findJob(p.baseWorkflows, job.workflow, job.job, 'the base');
  const atHead = findJob(p.headWorkflows, job.workflow, job.job, 'the head');
  if (typeof atBase === 'string') return { kind: 'no', why: `the evidence job: ${atBase}` };
  if (typeof atHead === 'string' || JSON.stringify(atBase) !== JSON.stringify(atHead)) {
    return { kind: 'no', why: 'the evidence job changed in this pull request' };
  }
  const mine: Check[] = [];
  for (const t of atBase.targets) {
    const found = jobInstances(checks, t.workflow, t.job);
    if (found === 'ambiguous') {
      return { kind: 'no', why: 'a check has a name like the evidence job that does not parse' };
    }
    mine.push(...found);
  }
  if (mine.length === 0) return { kind: 'no', why: 'the evidence job reported no check' };
  if (mine.some((c) => c.bucket === 'pending')) {
    return { kind: 'wait', why: `waiting for the evidence job ${job.job}` };
  }
  if (!mine.every((c) => c.bucket === 'pass')) {
    return { kind: 'no', why: 'the evidence job did not pass' };
  }
  const seen = mine.map((c) => `${c.workflow ?? ''} / ${c.name}: ${c.bucket}`).sort();
  const entry = recordException(ctx.stateRoot, {
    ...base,
    outcome: 'applied',
    by: 'evidence',
    run: 'ci',
    output: digest(seen.join('\n')),
  });
  return { kind: 'proven', entry };
}

export type EvidenceVerdict =
  | { kind: 'none' }
  | { kind: 'waived'; waived: ReadonlySet<string>; applied: ExceptionEntry[] }
  | { kind: 'wait'; reason: string }
  | { kind: 'lead'; reason: string; owner: boolean };

/** The lead's line for a guard hit no evidence explained: fixed text and ids only. */
function leadLine(ref: PrRef, head: string, rules: EvidenceRule[], whys: string[]): string {
  const owner = rules.some((r) => r.ownerOnly);
  const first = rules[0] as EvidenceRule;
  const more = rules.length > 1 ? ` (and ${rules.length - 1} more rules)` : '';
  const target = `${ref.repo}#${ref.pr}`;
  const grant = `studio exceptions grant ${target} ${first.id} --reason "<one line>"`;
  return `${owner ? OWNER_PREFIX : LEAD_PREFIX}${first.guard.job} failed on ${target} at ${short(head)} and no evidence proved a false alarm (${first.id}: ${whys[0] ?? 'it proved nothing'}${more}); ${
    owner
      ? `the owner decides, in a terminal: ${grant}, or a fix through a crew`
      : `decide: ${grant}, or a fix through a crew`
  }`;
}

/**
 * Whether exceptions by evidence cover every plain failed check of `head`. `none` as soon as one
 * failed check belongs to no rule's guard, so a failure nothing explains fails as before. Each
 * guard is covered by a logged exception for this exact base and head, or by one of its rules
 * proving it now (logged before it counts). The first guard no rule covers goes to the lead.
 */
export async function judgeFailedChecks(
  ctx: EvidenceContext,
  ref: PrRef,
  head: string,
  failed: readonly Check[],
  checks: readonly Check[],
): Promise<EvidenceVerdict> {
  if (failed.length === 0) return { kind: 'none' };
  const prep = await prepare(ctx, ref, head);
  if (prep.kind === 'none') return { kind: 'none' };
  if (prep.kind === 'moved') return { kind: 'wait', reason: 'the head moved; judged again' };
  if (prep.kind === 'unreadable') {
    // Whether a rule applies is unknown: the failure stands, and the lead hears why.
    return {
      kind: 'lead',
      reason: `${LEAD_PREFIX}cannot judge the failed checks of ${ref.repo}#${ref.pr}: ${prep.why}`,
      owner: false,
    };
  }
  const p = prep.p;
  const groups = new Map<string, { rules: EvidenceRule[]; checks: Check[] }>();
  for (const c of failed) {
    const rules = p.rules.filter((r) => {
      const at = findJob(p.baseWorkflows, r.guard.workflow, r.guard.job, 'the base');
      return typeof at !== 'string' && at.targets.some((t) => isCheckOf(c, t));
    });
    if (rules.length === 0) return { kind: 'none' };
    const key = guardName(rules[0] as EvidenceRule);
    const group = groups.get(key) ?? { rules, checks: [] };
    group.checks.push(c);
    groups.set(key, group);
  }
  const log = readExceptions(ctx.stateRoot);
  const waived = new Set<string>();
  const applied: ExceptionEntry[] = [];
  let wait: string | undefined;
  for (const group of groups.values()) {
    const keyOf = (r: EvidenceRule) => ({
      rule: r.id,
      repo: ref.repo,
      pr: ref.pr,
      base: p.base,
      head: p.head,
    });
    const logged = log.find(
      (e) => e.outcome === 'applied' && group.rules.some((r) => sameKey(e, keyOf(r))),
    );
    let proof: ExceptionEntry | undefined = logged;
    const whys: string[] = [];
    let waiting: string | undefined;
    for (const r of proof === undefined ? group.rules : []) {
      const changed = guardChanged(p, r);
      if (changed !== undefined) {
        whys.push(changed);
        continue;
      }
      if (touchesInputs(p, r)) {
        whys.push('the pull request changes an input of the evidence');
        continue;
      }
      const base = {
        v: 1 as const,
        at: ctx.now().toISOString(),
        ...keyOf(r),
        ...(ref.item === undefined ? {} : { item: ref.item }),
        guard: guardName(r),
        diff: digest(p.diff),
      };
      const attempt =
        r.run === 'ci' ? judgeCi(ctx, p, r, checks, base) : await runLocal(ctx, p, r, ref, base);
      if (attempt.kind === 'proven') {
        proof = attempt.entry;
        break;
      }
      if (attempt.kind === 'wait') waiting ??= attempt.why;
      else whys.push(attempt.why);
    }
    if (proof !== undefined) {
      applied.push(proof);
      for (const c of group.checks) waived.add(checkKey(c));
      continue;
    }
    if (waiting !== undefined) {
      wait ??= waiting;
      continue;
    }
    return {
      kind: 'lead',
      reason: leadLine(ref, p.head, group.rules, whys),
      owner: group.rules.some((r) => r.ownerOnly),
    };
  }
  if (wait !== undefined) return { kind: 'wait', reason: wait };
  return { kind: 'waived', waived, applied };
}

/**
 * Why Studio gives a pull request no approval for touching the evidence: it changes the
 * `evidence:` block of studio.yaml, or a file a rule at the base names as `inputs`. Evidence is the
 * owner's: a crew's pull request never changes what proves a later one. `unreadable` when the
 * comparison could not be made; collect waits then.
 */
export async function evidenceChange(
  ctx: EvidenceContext,
  baseOid: string | undefined,
  head: string,
): Promise<{ problem?: string; unreadable?: true }> {
  if (baseOid === undefined || !SHA.test(baseOid) || !SHA.test(head)) return { unreadable: true };
  if (!(await fetchBoth(ctx, baseOid, head))) return { unreadable: true };
  const files = await changedFiles(ctx, baseOid, head);
  if (files === undefined) return { unreadable: true };
  if (files.some((f) => f.toLowerCase() === STUDIO_CONFIG)) {
    const [atBase, atHead] = [await rawEvidenceAt(ctx, baseOid), await rawEvidenceAt(ctx, head)];
    if (atBase !== atHead) return { problem: 'the pull request changes evidence: in studio.yaml' };
  }
  const rules = await rulesAt(ctx, baseOid);
  const touched = rules.filter((r) => files.some((f) => r.inputs.some((x) => matchGlob(x, f))));
  if (touched.length > 0) {
    return {
      problem: `the pull request changes an input of evidence rule ${touched.map((r) => r.id).join(', ')}`,
    };
  }
  return {};
}

/**
 * A lead's or the owner's decision for a guard hit no evidence explained, logged like an exception
 * the evidence proved: bound to the pull request's current base and head, so a later push needs a
 * new one. The rule must be in studio.yaml at the base on the default branch; an `owner_only` rule
 * takes the owner's grant only.
 */
export async function grantException(
  ctx: EvidenceContext,
  ref: PrRef,
  ruleId: string,
  by: 'lead' | 'owner',
  reason: string,
): Promise<{ entry: ExceptionEntry; existing: boolean }> {
  const facts = await readPrFacts({ gh: ctx.gh }, ref);
  if (facts === undefined) throw new Error(`cannot read ${ref.repo}#${ref.pr}`);
  const prep = await prepare(ctx, ref, facts.head);
  if (prep.kind === 'unreadable') throw new Error(`${ref.repo}#${ref.pr}: ${prep.why}`);
  if (prep.kind === 'moved') throw new Error(`${ref.repo}#${ref.pr} moved meanwhile; try again`);
  if (prep.kind === 'none') {
    throw new Error(
      `${ref.repo}#${ref.pr}: no evidence rules in studio.yaml at its base on the default branch`,
    );
  }
  const rule = prep.p.rules.find((r) => r.id === ruleId);
  if (rule === undefined) {
    throw new Error(
      `no evidence rule ${ruleId} in studio.yaml at the base of ${ref.repo}#${ref.pr}`,
    );
  }
  if (rule.ownerOnly && by !== 'owner') {
    throw new Error(`evidence rule ${ruleId} is owner_only: the owner grants it, in a terminal`);
  }
  const line = reason
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, 200);
  if (line === '') throw new Error('a grant needs --reason "<one line>"');
  const want: ExceptionEntry = {
    v: 1,
    at: ctx.now().toISOString(),
    outcome: 'applied',
    by,
    rule: rule.id,
    guard: guardName(rule),
    repo: ref.repo,
    pr: ref.pr,
    ...(ref.item === undefined ? {} : { item: ref.item }),
    base: prep.p.base,
    head: prep.p.head,
    diff: digest(prep.p.diff),
    reason: line,
  };
  const entry = recordException(ctx.stateRoot, want);
  return { entry, existing: entry !== want };
}

/** Whether a lead line is about evidence the lead decides on alone: never pushed to the owner. */
export const leadOnly = (reason: string): boolean =>
  /^(?:blocked: |merge failed: )?evidence: /.test(reason);
