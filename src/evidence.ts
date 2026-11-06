import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { findJob, jobInstances, readWorkflowsAt, type Workflows } from './ci-jobs.js';
import {
  bothSpellings,
  camelizeKeys,
  EVIDENCE_ID_RE,
  type EvidenceRule,
  type OwnerConfig,
  ownerConfigDir,
  parseConfig,
} from './config.js';
import { hostilePath, matchGlob, matchGlobExact } from './glob.js';
import {
  acquireStateLock,
  canonicalToolchainPaths,
  credentialLocations,
  type StateLock,
  stateBaseFor,
  writeStateFile,
} from './paths.js';
import type { Gh, Git } from './ports.js';
import {
  LIMITS_REFUSED,
  makeRunDir,
  type ProofRunner,
  proofEnv,
  realProofRunner,
  removeRunDir,
} from './proof-sandbox.js';
import { commentsOnlyWhy, languageOf } from './proofs.js';
import { appendStateLine, type Check, checkKey } from './queue.js';
import { readDefaultBranch, readPrFacts } from './review.js';

/**
 * Exceptions by evidence. A project binds a guard job (a CI job such as a migration guard) to a
 * built-in proof in studio.yaml (`evidence:`): `comments_only` (SQL) or `paths_only`, each over
 * every changed file of the pull request. When the guard fails and the proof holds on exactly that diff,
 * the failed checks count as waived for that head, and the exception is logged with its evidence.
 * Without a proof the lead decides; a rule marked `owner_only` sends that decision to the owner.
 *
 * A built-in proof runs nothing: Studio computes it itself, in TypeScript, over the files of the
 * base and the head that git gives it with pinned options (src/proofs.ts). `proof: command` runs a
 * command of the project, only when the owner config allows it and only in the proof sandbox
 * (src/proof-sandbox.ts); without a sandbox it proves nothing. The rules come only from
 * studio.yaml at the commit the pull request is based on, on the default branch, never from the
 * working tree or the pull request, and a pull request that changes them gets no approval. The log
 * lives in the state root, which crews cannot write; only Studio and `studio exceptions grant`
 * (refused to crews) append to it.
 */

export const EXCEPTIONS_FILE = 'exceptions.jsonl';
export const EXCEPTIONS_LOCK = 'exceptions.lock';
export const EXCEPTIONS_LOCK_STALE_MS = 30_000;
/** Retryable failures per pull request head, so a lasting one reaches the lead. */
export const RETRIES_FILE = 'evidence-retries.json';
/** How many retryable failures (an unreadable pull request or blob) before the lead hears. */
export const MAX_RETRIES = 5;
/** A lead line about evidence: the lead decides, it is not pushed to the owner's phone. */
export const LEAD_PREFIX = 'evidence: ';
/** A lead line about evidence of an `owner_only` rule: the owner decides. */
export const OWNER_PREFIX = 'evidence (owner): ';

const STUDIO_CONFIG = '.studio/studio.yaml';
const STUDIO_BOARD = '.studio/board.yaml';
const SHA = /^[0-9a-f]{40,64}$/i;
const GIT_FETCH_MS = 120_000;
const GIT_LOCAL_MS = 60_000;
const LOCK_WAIT_MS = 5000;
const RETRIES_KEEP_MS = 24 * 60 * 60_000;
/** Files above this size are not read for a proof: they prove nothing. */
const MAX_BLOB = 2 * 1024 * 1024;
/** Pinned diff options: no colour, no external diff or text conversion, submodules shown. */
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

const entrySchema = z.object({
  v: z.literal(1),
  at: z.string(),
  /** `applied`: the exception holds for this head; `not_proven`: the proof did not hold. */
  outcome: z.enum(['applied', 'not_proven']),
  /** Who decided: the proof itself (`evidence`), the lead, or the owner in a terminal. */
  by: z.enum(['evidence', 'lead', 'owner']),
  rule: z.string().regex(EVIDENCE_ID_RE),
  /** The guard job as `<workflow file> / <job>`. */
  guard: z.string(),
  repo: z.string(),
  pr: z.number().int().positive(),
  item: z.string().optional(),
  base: z.string().regex(SHA),
  head: z.string().regex(SHA),
  /** sha256 of `git diff base...head`: what the proof judged. */
  diff: z.string(),
  /** The built-in proof that was computed. */
  proof: z.string().optional(),
  /** Why the proof did not hold: Studio's own text, a path at most quoted. */
  why: z.string().optional(),
  /** A grant: the lead's or the owner's one line. */
  reason: z.string().optional(),
  /** proof: command: the command that ran (from the base's studio.yaml). */
  command: z.array(z.string()).optional(),
});
export type ExceptionEntry = z.infer<typeof entrySchema>;

export type PrRef = { repo: string; pr: number; item?: string };

/** What the evidence code needs from outside. */
export interface EvidenceContext {
  gh: Gh;
  git: Git;
  /** The owner's checkout and how it reaches the pull request's repository. */
  checkout: { dir: string; remote: string };
  stateRoot: string;
  now: () => Date;
  /** proof: command; without it, or not allowed, such rules prove nothing. */
  commands?: ProofCommands;
}

/** What `proof: command` needs: the owner's yes, a sandbox and what the command may read. */
export interface ProofCommands {
  /** `allow_proof_commands` in the owner config. */
  allowed: boolean;
  /** Why they are off although allowed (a toolchain path that fails its check). */
  off?: string;
  runner: ProofRunner;
  /** Read-only dirs for the command: the owner's toolchain paths, checked, real paths. */
  read: string[];
  /** Kept unreadable on macOS besides the fixed places: the home, state, configs. */
  deny: string[];
}

/**
 * What `proof: command` gets on this machine, from the owner config: allowed or not, and the
 * toolchain paths (`crew_toolchain_paths`, checked against the real file system as for crews) as
 * read-only dirs. The home, the state base, the owner config and the Claude config stay denied.
 */
export function proofCommandsFor(o: {
  ownerConfig: Pick<OwnerConfig, 'allowProofCommands' | 'crewToolchainPaths'>;
  env: Record<string, string | undefined>;
  homedir: string;
  projectDir: string;
  stateRoot: string;
  runner?: ProofRunner;
}): ProofCommands {
  const owner = { env: o.env, homedir: o.homedir };
  const deny = [
    o.homedir,
    stateBaseFor(owner),
    ownerConfigDir(owner),
    o.env.CLAUDE_CONFIG_DIR || join(o.homedir, '.claude'),
    ...credentialLocations(o.homedir, o.env).all,
  ];
  const runner = o.runner ?? realProofRunner;
  if (!o.ownerConfig.allowProofCommands) return { allowed: false, runner, read: [], deny };
  try {
    const read = canonicalToolchainPaths(o.ownerConfig.crewToolchainPaths, {
      home: o.homedir,
      env: o.env,
      projectDir: o.projectDir,
      stateRoot: o.stateRoot,
      extraCredentialPaths: credentialLocations(o.homedir, o.env).extra,
    });
    return { allowed: true, runner, read, deny };
  } catch (e) {
    return { allowed: true, off: (e as Error).message.slice(0, 200), runner, read: [], deny };
  }
}

/** What a proof command prints, on a line of its own, to prove: this word and the run's nonce. */
export const PROOF_LINE_WORD = 'proven';
const GIT_ARCHIVE_MS = 300_000;
/** Stdout a proof command may print. */
const MAX_PROOF_OUTPUT = 1024 * 1024;
/** The largest file a proof command may write in its tmp dir. */
const MAX_PROOF_FILE = 256 * 1024 * 1024;

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
 * pull request, base and head): an applied exception (a lead's grant only for another lead's), or
 * for a `not_proven` entry an earlier `not_proven` one. So a second process, or a run after a
 * crash, never logs the same result twice. Returns what counts.
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
    // A lead's grant answers only another lead's: the proof's own result and an owner's grant
    // are logged beside it, so a guard that needs them can find them.
    const answers = (e: ExceptionEntry) => e.by !== 'lead' || entry.by === 'lead';
    const applied = known.find((e) => e.outcome === 'applied' && answers(e));
    if (applied !== undefined) return applied;
    // A command's answer is logged beside a refusal before it ran (commands off, no sandbox), so
    // runCommand finds it and never runs the command on that diff again.
    const tried = known.find(
      (e) =>
        e.outcome === 'not_proven' &&
        (entry.command === undefined ||
          JSON.stringify(e.command) === JSON.stringify(entry.command)),
    );
    if (entry.outcome === 'not_proven' && tried !== undefined) return tried;
    appendStateLine(stateRoot, EXCEPTIONS_FILE, JSON.stringify(entry));
    return entry;
  } finally {
    lock.release();
  }
}

/**
 * Counts a retryable failure for one pull request head; true while it may still be retried.
 * Best effort: a file that cannot be read starts the count again.
 */
function retryAllowed(stateRoot: string, key: string, now: Date): boolean {
  const file = join(stateRoot, RETRIES_FILE);
  let counts: Record<string, { n: number; at: string }> = {};
  try {
    if (existsSync(file) && !lstatSync(file).isSymbolicLink()) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (raw !== null && typeof raw === 'object') {
        counts = raw as Record<string, { n: number; at: string }>;
      }
    }
  } catch {
    counts = {};
  }
  const kept = Object.fromEntries(
    Object.entries(counts).filter(
      ([, v]) => typeof v?.n === 'number' && now.getTime() - Date.parse(v.at) < RETRIES_KEEP_MS,
    ),
  );
  const n = (kept[key]?.n ?? 0) + 1;
  kept[key] = { n, at: now.toISOString() };
  try {
    writeStateFile(stateRoot, file, `${JSON.stringify(kept)}\n`);
  } catch {
    // a count that cannot be stored holds nothing back
  }
  return n < MAX_RETRIES;
}

/** One changed file as `git diff --raw` names it. */
interface RawChange {
  srcMode: string;
  dstMode: string;
  src: string;
  dst: string;
  status: string;
  path: string;
}

/** What Studio read about a pull request to judge evidence on it. */
interface Prepared {
  base: string;
  head: string;
  rules: EvidenceRule[];
  /** Every changed path of `base...head`, both sides of a rename. */
  files: string[];
  changes: RawChange[];
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

/**
 * The raw `evidence:` block of studio.yaml at `oid`, and every component's `release:` block, as
 * JSON; null without one.
 */
/** Keys of studio.yaml a crew's pull request may change while a release exists; all else is the owner's. */
export const CREW_CONFIG_KEYS = ['stacks'];

/** JSON with object keys sorted at every level: two equal configs give the same text. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

async function rawOwnerBlocksAt(
  ctx: EvidenceContext,
  oid: string,
): Promise<{
  evidence: string;
  release: string;
  /** The `research:` block: which directory a researcher's REA reaches. Always the owner's. */
  research: string;
  /** The whole config minus CREW_CONFIG_KEYS, camelized: owner-owned while a release exists. */
  whole: string;
  workflows: string[];
  guarded: string[];
  released: boolean;
  /** A key written in two spellings, which camelizing would merge. */
  twice?: string;
}> {
  let text: string;
  try {
    text = await g(ctx, ['cat-file', 'blob', `${oid}:${STUDIO_CONFIG}`]);
  } catch {
    return {
      evidence: 'null',
      release: 'null',
      research: 'null',
      whole: 'null',
      workflows: [],
      guarded: [],
      released: false,
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    // A file that does not parse loads no rules; as a change it counts like any other.
    const u = `unparsable:${digest(text)}`;
    // Unparsable counts as having a release: the guard errs towards the owner.
    return {
      evidence: u,
      release: u,
      research: u,
      whole: u,
      workflows: [],
      guarded: [],
      released: true,
    };
  }
  const twice = bothSpellings(raw);
  const obj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  // Camelized as Studio reads it: `crewAllowedWorkflows` beside `crew_allowed_workflows` is the same key.
  const o = obj(camelizeKeys(raw));
  // A component with a release is the owner's whole: its id, repo and paths decide what ships and
  // who must approve it. By id, in id order: moving a component in the list changes nothing.
  const released = (Array.isArray(o.components) ? o.components : [])
    .map(obj)
    .filter((c) => c.release !== undefined && c.release !== null);
  const entries = released
    .map((c) => [JSON.stringify(c.id ?? null), canonical(c)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // The workflows a release starts or names: their content is the owner's like the block.
  const workflows = new Set<string>();
  const guarded = new Set<string>();
  for (const c of released) {
    const r = obj(c.release);
    const add = (v: unknown) => {
      if (typeof v === 'string') workflows.add(v);
    };
    add(r.workflow);
    for (const pc of Array.isArray(r.postChecks) ? r.postChecks : []) add(obj(pc).workflow);
    add(obj(r.rollback).workflow);
    for (const p of Array.isArray(r.guardedPaths) ? r.guardedPaths : []) {
      if (typeof p === 'string') guarded.add(p);
    }
  }
  const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !CREW_CONFIG_KEYS.includes(k)));
  return {
    evidence: canonical(o.evidence ?? null),
    release: canonical(entries),
    research: canonical(o.research ?? null),
    whole: canonical(rest),
    workflows: [...workflows],
    guarded: [...guarded],
    released: released.length > 0,
    ...(twice === undefined ? {} : { twice }),
  };
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
    const out = await g(ctx, [...DIFF, '--name-only', '-z', `${base}...${head}`]);
    return out.split('\0').filter((p) => p !== '');
  } catch {
    return undefined;
  }
}

/** `git diff --raw -z`: `:<mode> <mode> <sha> <sha> <status>\0<path>\0` per file. */
function parseRaw(out: string): RawChange[] | undefined {
  const parts = out.split('\0');
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/.exec(
      parts[i] as string,
    );
    if (m === null) return undefined;
    changes.push({
      srcMode: m[1] as string,
      dstMode: m[2] as string,
      src: m[3] as string,
      dst: m[4] as string,
      status: m[5] as string,
      path: parts[i + 1] as string,
    });
  }
  return changes;
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
  let changes: RawChange[] | undefined;
  try {
    diff = await g(ctx, [...DIFF, '--binary', `${base}...${head}`]);
    changes = parseRaw(await g(ctx, [...DIFF, '--raw', '--no-abbrev', '-z', `${base}...${head}`]));
  } catch {
    diff = undefined;
  }
  if (files === undefined || diff === undefined || changes === undefined) {
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
    p: { base, head, rules, files, changes, diff, baseWorkflows, headWorkflows },
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

/** A path as a lead line may quote it: plain characters only, cut short. */
const quotePath = (p: string): string => JSON.stringify(p.slice(0, 120));

/** The mode of a regular file: 644 or 755, no link, no submodule. */
const REGULAR = /^100(644|755)$/;

type Proven =
  /** `command`: the proof command that ran, for the log. */
  | { kind: 'proven'; command?: string[] }
  | { kind: 'no'; why: string; command?: string[] }
  | { kind: 'retry'; why: string };

/**
 * Computes the proof of `r` on the prepared diff. A built-in proof runs nothing; `command` runs
 * the rule's command in the proof sandbox (runCommand).
 */
async function prove(
  ctx: EvidenceContext,
  p: Prepared,
  r: EvidenceRule,
  ref: PrRef,
): Promise<Proven> {
  // A path no reviewer can read at a glance proves nothing, whatever its content.
  const hostile = p.files.find(hostilePath);
  if (hostile !== undefined) return { kind: 'no', why: 'a changed path has a control character' };
  // Every proof covers the whole pull request: a change elsewhere could be what the guard saw.
  // Paths match case-sensitively: `docs/**` never covers `DOCS/run.sh`.
  const outside = p.files.find((f) => !r.paths.some((glob) => matchGlobExact(glob, f)));
  if (outside !== undefined)
    return { kind: 'no', why: `${quotePath(outside)} is outside the paths` };
  if (r.proof === 'paths_only') return { kind: 'proven' };
  if (r.proof === 'command') return runCommand(ctx, p, r, ref);
  if (r.proof !== 'comments_only') return { kind: 'no', why: `${r.proof} is not in this version` };
  if (p.changes.length === 0) return { kind: 'no', why: 'no file changed' };
  for (const c of p.changes) {
    const name = quotePath(c.path);
    if (c.status === 'A' || c.status === 'D') {
      return { kind: 'no', why: `${name} is ${c.status === 'A' ? 'added' : 'deleted'}` };
    }
    if (c.status !== 'M') return { kind: 'no', why: `${name} is not a plain change` };
    if (c.srcMode !== c.dstMode) return { kind: 'no', why: `${name} changes its mode` };
    if (!REGULAR.test(c.srcMode)) return { kind: 'no', why: `${name} is no regular file` };
    if (languageOf(c.path, r.languages ?? []) === undefined) {
      return { kind: 'no', why: `${name} is in none of the languages` };
    }
    let before: Uint8Array;
    let after: Uint8Array;
    try {
      const size = async (sha: string) => Number(await g(ctx, ['cat-file', '-s', sha]));
      if ((await size(c.src)) > MAX_BLOB || (await size(c.dst)) > MAX_BLOB) {
        return { kind: 'no', why: `${name} is too large to read` };
      }
      if (ctx.git.blob === undefined) throw new Error('no blob reader');
      // The exact bytes: nothing decoded with loss, no final line break stripped.
      before = await ctx.git.blob(ctx.checkout.dir, c.src, { timeoutMs: GIT_LOCAL_MS });
      after = await ctx.git.blob(ctx.checkout.dir, c.dst, { timeoutMs: GIT_LOCAL_MS });
    } catch {
      return { kind: 'retry', why: `${name} cannot be read` };
    }
    const why = commentsOnlyWhy(before, after);
    if (why !== undefined) return { kind: 'no', why: `${name}: ${why}` };
  }
  return { kind: 'proven' };
}

/**
 * Runs the command of a `proof: command` rule: only when the owner config allows it, only in the
 * proof sandbox (never without one), and from studio.yaml at the base (the rules come from there),
 * so a pull request never runs or changes its own proof. The command starts in an extract of the
 * base (`git archive`, no link to the owner's repository) and reads the head's extract, the diff
 * and the changed paths as data. It proves only by exiting 0 with a line `proven <nonce>`, the
 * nonce drawn for this run: no text of the pull request can hold it. A command that ran on a
 * diff never runs on it again: its answer is in the log. Extraction or start failures are retried.
 */
async function runCommand(
  ctx: EvidenceContext,
  p: Prepared,
  r: EvidenceRule,
  ref: PrRef,
): Promise<Proven> {
  const argv = r.command ?? [];
  const c = ctx.commands;
  if (c === undefined || !c.allowed) {
    return { kind: 'no', why: 'proof commands are off on this machine (allow_proof_commands)' };
  }
  if (c.off !== undefined) return { kind: 'no', why: `proof commands are off: ${c.off}` };
  const key = { rule: r.id, repo: ref.repo, pr: ref.pr, base: p.base, head: p.head };
  const ran = readExceptions(ctx.stateRoot).find(
    (e) =>
      e.outcome === 'not_proven' &&
      sameKey(e, key) &&
      JSON.stringify(e.command) === JSON.stringify(argv),
  );
  if (ran !== undefined) return { kind: 'no', why: ran.why ?? 'it proved nothing', command: argv };
  const unavailable = await c.runner.unavailable();
  if (unavailable !== undefined) return { kind: 'no', why: `no sandbox: ${unavailable}` };
  let dirs: { run: string; tmp: string };
  try {
    dirs = makeRunDir();
  } catch {
    return { kind: 'retry', why: 'the proof run dir cannot be made' };
  }
  try {
    const base = join(dirs.run, 'base');
    const head = join(dirs.run, 'head');
    try {
      for (const [oid, dir] of [
        [p.base, base],
        [p.head, head],
      ] as const) {
        const tar = join(dirs.run, 'tree.tar');
        mkdirSync(dir);
        await g(ctx, ['archive', '--format=tar', '-o', tar, oid], GIT_ARCHIVE_MS);
        await execa('tar', ['-xf', tar, '-C', dir], { stdin: 'ignore', timeout: GIT_ARCHIVE_MS });
        rmSync(tar);
      }
    } catch {
      return { kind: 'retry', why: 'the base and head cannot be extracted' };
    }
    const diff = join(dirs.run, 'diff.patch');
    const files = join(dirs.run, 'files');
    writeFileSync(diff, p.diff, { mode: 0o400 });
    // NUL-separated: a path may hold anything but NUL.
    writeFileSync(files, p.files.map((f) => `${f}\0`).join(''), { mode: 0o400 });
    const nonce = randomBytes(16).toString('hex');
    const env = proofEnv(c.read, dirs.tmp, {
      STUDIO_PROOF_RULE: r.id,
      STUDIO_PROOF_REPO: ref.repo,
      STUDIO_PROOF_PR: String(ref.pr),
      STUDIO_PROOF_BASE: p.base,
      STUDIO_PROOF_HEAD: p.head,
      STUDIO_PROOF_HEAD_TREE: head,
      STUDIO_PROOF_DIFF: diff,
      STUDIO_PROOF_FILES: files,
      STUDIO_PROOF_NONCE: nonce,
    });
    const seconds = r.timeoutSeconds ?? 60;
    const result = await c.runner.run(
      argv,
      env,
      { run: dirs.run, tmp: dirs.tmp, cwd: base, read: c.read, deny: c.deny },
      {
        timeoutMs: seconds * 1000,
        cpuSeconds: seconds,
        maxOutput: MAX_PROOF_OUTPUT,
        maxFileBytes: MAX_PROOF_FILE,
      },
    );
    if (result.kind === 'failed') return { kind: 'retry', why: result.why };
    const no = (why: string): Proven => ({ kind: 'no', why, command: argv });
    if (result.kind === 'timeout') return no(`timed out after ${seconds} s`);
    if (result.tooLarge) return no('its output is over 1 MiB');
    if (result.code === LIMITS_REFUSED) return no('its limits could not be set, or it exited 125');
    if (result.code !== 0) return no(`exit code ${result.code}`);
    const line = `${PROOF_LINE_WORD} ${nonce}`;
    if (!result.stdout.split(/\r?\n/).includes(line)) return no('its output lacks the proof line');
    return { kind: 'proven', command: argv };
  } finally {
    removeRunDir(dirs.run);
  }
}

export type EvidenceVerdict =
  | { kind: 'none' }
  | { kind: 'waived'; waived: ReadonlySet<string>; applied: ExceptionEntry[]; base: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'lead'; reason: string; owner: boolean };

/** The lead's line for a guard hit no proof explained: fixed text, ids and quoted paths only. */
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
 * guard is covered by a logged exception for this exact base and head, or by one of its rules'
 * proofs holding now (logged before it counts). A guard with an `owner_only` rule takes the
 * proof or the owner's grant only. The first guard nothing covers goes to the lead. A failure to
 * read is retried (`wait`) up to MAX_RETRIES times per head, unlogged, then goes to the lead.
 */
export async function judgeFailedChecks(
  ctx: EvidenceContext,
  ref: PrRef,
  head: string,
  failed: readonly Check[],
): Promise<EvidenceVerdict> {
  if (failed.length === 0) return { kind: 'none' };
  const retryKey = `${ref.repo}#${ref.pr}@${head.toLowerCase()}`;
  const retry = (why: string): EvidenceVerdict =>
    retryAllowed(ctx.stateRoot, retryKey, ctx.now())
      ? { kind: 'wait', reason: `evidence: ${why}; tried again` }
      : {
          kind: 'lead',
          reason: `${LEAD_PREFIX}cannot judge the failed checks of ${ref.repo}#${ref.pr} after ${MAX_RETRIES} tries: ${why}`,
          owner: false,
        };
  const prep = await prepare(ctx, ref, head);
  if (prep.kind === 'none') return { kind: 'none' };
  if (prep.kind === 'moved') return { kind: 'wait', reason: 'the head moved; judged again' };
  if (prep.kind === 'unreadable') return retry(prep.why);
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
  let retryWhy: string | undefined;
  for (const group of groups.values()) {
    const keyOf = (r: EvidenceRule) => ({
      rule: r.id,
      repo: ref.repo,
      pr: ref.pr,
      base: p.base,
      head: p.head,
    });
    // A guard with an owner_only rule is waived only by a proof or by the owner, never by the
    // lead's grant through any of its rules.
    const ownerGuard = group.rules.some((r) => r.ownerOnly);
    const holds = (e: ExceptionEntry) => !ownerGuard || e.by !== 'lead';
    let proof: ExceptionEntry | undefined = log.find(
      (e) => e.outcome === 'applied' && holds(e) && group.rules.some((r) => sameKey(e, keyOf(r))),
    );
    const whys: string[] = [];
    let again: string | undefined;
    for (const r of proof === undefined ? group.rules : []) {
      const changed = guardChanged(p, r);
      if (changed !== undefined) {
        whys.push(changed);
        continue;
      }
      const base = {
        v: 1 as const,
        at: ctx.now().toISOString(),
        ...keyOf(r),
        ...(ref.item === undefined ? {} : { item: ref.item }),
        guard: guardName(r),
        diff: digest(p.diff),
        proof: r.proof,
      };
      const result = await prove(ctx, p, r, ref);
      if (result.kind === 'retry') {
        again ??= result.why;
        continue;
      }
      const entry = recordException(ctx.stateRoot, {
        ...base,
        outcome: result.kind === 'proven' ? 'applied' : 'not_proven',
        by: 'evidence',
        ...(result.kind === 'no' ? { why: result.why } : {}),
        ...(result.command === undefined ? {} : { command: result.command }),
      });
      if (entry.outcome === 'applied' && holds(entry)) {
        proof = entry;
        break;
      }
      whys.push(
        entry.outcome === 'applied'
          ? 'a lead grant does not hold for a guard with an owner_only rule'
          : (entry.why ?? 'it proved nothing'),
      );
    }
    if (proof !== undefined) {
      applied.push(proof);
      for (const c of group.checks) waived.add(checkKey(c));
      continue;
    }
    if (again !== undefined) {
      retryWhy ??= again;
      continue;
    }
    return {
      kind: 'lead',
      reason: leadLine(ref, p.head, group.rules, whys),
      owner: ownerGuard,
    };
  }
  if (retryWhy !== undefined) return retry(retryWhy);
  return { kind: 'waived', waived, applied, base: p.base };
}

/**
 * Why Studio gives a pull request no approval for touching what is the owner's in studio.yaml:
 * the `evidence:` block (a crew's pull request never changes what proves a later one), the
 * `research:` block (which directory a researcher's REA tools reach) or a component's `release:`
 * block (its workflow, checks and third-party approvers). `unreadable` when the comparison could
 * not be made; collect waits then.
 */
export async function evidenceChange(
  ctx: EvidenceContext,
  baseOid: string | undefined,
  head: string,
): Promise<{
  problem?: string;
  area?: 'evidence' | 'release' | 'research' | 'board';
  unreadable?: true;
}> {
  if (baseOid === undefined || !SHA.test(baseOid) || !SHA.test(head)) return { unreadable: true };
  if (!(await fetchBoth(ctx, baseOid, head))) return { unreadable: true };
  const files = await changedFiles(ctx, baseOid, head);
  if (files === undefined) return { unreadable: true };
  // The board is Studio's and the owner's: its dependencies, epics and member items reach into the
  // other projects of a group. A crew's pull request that changes it gets no approval.
  if (files.some((f) => f.toLowerCase() === STUDIO_BOARD)) {
    return { problem: 'the pull request changes .studio/board.yaml', area: 'board' };
  }
  const [atBase, atHead] = [
    await rawOwnerBlocksAt(ctx, baseOid),
    await rawOwnerBlocksAt(ctx, head),
  ];
  if (files.some((f) => f.toLowerCase() === STUDIO_CONFIG)) {
    if (atHead.twice !== undefined) {
      return {
        problem: `the pull request writes ${quotePath(atHead.twice)} in two spellings in studio.yaml`,
        area: atBase.released || atHead.released ? 'release' : 'evidence',
      };
    }
    if (atBase.evidence !== atHead.evidence) {
      return { problem: 'the pull request changes evidence: in studio.yaml', area: 'evidence' };
    }
    if (atBase.research !== atHead.research) {
      return { problem: 'the pull request changes research: in studio.yaml', area: 'research' };
    }
    if (atBase.release !== atHead.release) {
      return {
        problem: "the pull request changes a component's release: in studio.yaml",
        area: 'release',
      };
    }
    // While a release exists, all of studio.yaml is the owner's but the few keys a crew may set.
    if ((atBase.released || atHead.released) && atBase.whole !== atHead.whole) {
      return {
        problem: `the pull request changes studio.yaml beyond ${CREW_CONFIG_KEYS.join(', ')}; with a release it is the owner's`,
        area: 'release',
      };
    }
  }
  // A workflow a release starts or names, at the base or the head: its content is the owner's.
  const guarded = new Set([...atBase.workflows, ...atHead.workflows].map((w) => w.toLowerCase()));
  const hit = files.find((f) => guarded.has(f.toLowerCase()));
  if (hit !== undefined) {
    return {
      problem: `the pull request changes ${quotePath(hit)}, a workflow a component's release starts`,
      area: 'release',
    };
  }
  // Once anything is released, all of .github is the owner's, the scope the release pins (a
  // release workflow may call any workflow, action or file there), and so are the scripts a
  // component lists as guarded_paths, with every directory on the way to them.
  if (atBase.released || atHead.released) {
    const ci = files.find((f) => /^\.github(?:\/|$)/i.test(f));
    if (ci !== undefined) {
      return {
        problem: `the pull request changes ${quotePath(ci)}; with a release, .github is the owner's`,
        area: 'release',
      };
    }
    const globs = [...atBase.guarded, ...atHead.guarded];
    const script = files.find((f) => globs.some((p) => matchGlob(p, f)));
    if (script !== undefined) {
      return {
        problem: `the pull request changes ${quotePath(script)}, a guarded path of a release`,
        area: 'release',
      };
    }
    // A link or submodule anywhere can redirect what a release runs: never added by a crew.
    let changes: RawChange[] | undefined;
    try {
      changes = parseRaw(
        await g(ctx, [...DIFF, '--raw', '--no-abbrev', '-z', `${baseOid}...${head}`]),
      );
    } catch {
      changes = undefined;
    }
    if (changes === undefined) return { unreadable: true };
    const link = changes.find((c) => c.dstMode === '120000' || c.dstMode === '160000');
    if (link !== undefined) {
      return {
        problem: `the pull request adds a link or submodule at ${quotePath(link.path)}; with a release the repository holds none`,
        area: 'release',
      };
    }
  }
  return {};
}

/**
 * A lead's or the owner's decision for a guard hit no proof explained, logged like an exception
 * a proof showed: bound to the pull request's current base and head, so a later push needs a new
 * one. The rule must be in studio.yaml at the base on the default branch. A guard with an
 * `owner_only` rule, through whichever of its rules, takes the owner's grant only.
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
  // A grant waives the guard, not only the rule: any owner_only rule on the same guard makes it
  // the owner's, or a lead grant through a sibling rule would bypass it.
  const ownerRule = prep.p.rules.find(
    (r) =>
      r.ownerOnly && r.guard.workflow === rule.guard.workflow && r.guard.job === rule.guard.job,
  );
  if (ownerRule !== undefined && by !== 'owner') {
    throw new Error(
      ownerRule.id === ruleId
        ? `evidence rule ${ruleId} is owner_only: the owner grants it, in a terminal`
        : `evidence rule ${ownerRule.id} on the same guard is owner_only: the owner grants it, in a terminal`,
    );
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

/** One file's lines a pull request adds, with their line numbers at the head. */
export interface AddedFile {
  path: string;
  /** Not plain text: a link, a submodule, a binary or a file too large to read. */
  odd?: 'link' | 'submodule' | 'binary' | 'large' | 'unreadable';
  lines: { line: number; text: string }[];
}

/**
 * What a pull request adds, read in the owner's checkout over `base...head` (never in a crew clone):
 * the added lines of each file, and the files that are no plain text. Undefined when the commits
 * cannot be fetched or the diff cannot be read; the caller waits then.
 */
export async function addedInPullRequest(
  ctx: EvidenceContext,
  base: string | undefined,
  head: string,
): Promise<AddedFile[] | undefined> {
  if (base === undefined || !SHA.test(base) || !SHA.test(head)) return undefined;
  if (!(await fetchBoth(ctx, base, head))) return undefined;
  let raw: RawChange[] | undefined;
  let numstat: string;
  let patch: string;
  try {
    raw = parseRaw(await g(ctx, [...DIFF, '--raw', '--no-abbrev', '-z', `${base}...${head}`]));
    numstat = await g(ctx, [...DIFF, '--numstat', '-z', `${base}...${head}`]);
    patch = await g(ctx, [...DIFF, '--unified=0', `${base}...${head}`]);
  } catch {
    return undefined;
  }
  if (raw === undefined) return undefined;
  const files = new Map<string, AddedFile>();
  const counted = new Map<string, number>();
  for (const c of raw) {
    if (c.status === 'D') continue;
    const f: AddedFile = { path: c.path, lines: [] };
    if (c.dstMode === '120000') f.odd = 'link';
    else if (c.dstMode === '160000') f.odd = 'submodule';
    files.set(c.path, f);
  }
  // `--numstat -z`: `<added>\t<deleted>\t<path>\0`; a binary file shows `-` for both counts.
  for (const entry of numstat.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
    if (m === null) continue;
    const f = files.get(m[3] as string);
    if (f === undefined || f.odd !== undefined) continue;
    if (m[1] === '-') f.odd = 'binary';
    else if (Number(m[1]) > MAX_ADDED_LINES) f.odd = 'large';
    else counted.set(f.path, Number(m[1]));
  }
  let current: AddedFile | undefined;
  let at = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      current = p.startsWith('b/') ? files.get(p.slice(2)) : undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      at = Number(hunk[1]);
      continue;
    }
    if (current === undefined || current.odd !== undefined) continue;
    if (line.startsWith('+')) {
      current.lines.push({ line: at, text: line.slice(1) });
      at++;
    }
  }
  // A file whose added lines were not all read (a path git quoted, a header it shaped otherwise)
  // fails closed rather than pass unread.
  for (const f of files.values()) {
    if (f.odd === undefined && f.lines.length !== (counted.get(f.path) ?? -1)) f.odd = 'unreadable';
  }
  return [...files.values()];
}

/** A file adding more lines than this is not read line by line: it fails the privacy check. */
const MAX_ADDED_LINES = 20_000;

/**
 * The commit a branch of the pull request's repository points to now, read with `ls-remote` in the
 * owner's checkout (never a crew clone); undefined when it cannot be read or does not exist.
 */
export async function remoteTip(ctx: EvidenceContext, branch: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..')) return undefined;
  try {
    const out = await g(
      ctx,
      ['ls-remote', '--', ctx.checkout.remote, `refs/heads/${branch}`],
      GIT_FETCH_MS,
    );
    const line = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
    const sha = line?.split('\t')[0];
    return sha !== undefined && SHA.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}
