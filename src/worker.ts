// `studio worker --label <label>`: a machine other than the lead's takes offered items of its
// label, one at a time. It claims an item atomically on GitHub, runs a crew for it exactly like the
// lead would (same brief, sandbox, guard, skill allowlist, pinned plugins, report schema) plus its
// own deny list, opens the pull request with its own GitHub identity and hands the report back on
// the claim. The lead collects, reviews, queues and merges as for any crew. Nothing is shared
// between the machines but GitHub.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { crewClaudeDir } from './accounts.js';
import type { WorkItem } from './board.js';
import { loadOwnerConfig, parseConfig, type StudioConfig } from './config.js';
import { type RunUsage, runUsageSince } from './costs.js';
import { limitHold } from './credentials.js';
import { crewHold, githubHttpsUrl, ITEM_BASE, type LauncherEnv, launchCrew } from './crew.js';
import { HeldError } from './held.js';
import {
  blockHold,
  parkUntil,
  readBlocks,
  readLimits,
  scanLogForBlock,
  scanLogForLimit,
  writeBlocks,
  writeLimits,
} from './limits.js';
import {
  acquireStateLock,
  assertStatePath,
  checkStateMarker,
  ensureStateDir,
  inspectStateLock,
  ownerStateRootFor,
  projectRealpath,
  removeStateEntry,
  stateRootFor,
  writeStateFile,
} from './paths.js';
import { readPause } from './pause.js';
import { installedVersions, type PluginPin, pinnedPlugins } from './plugins.js';
import type { Ports } from './ports.js';
import { crewPrText, crewPrTitle } from './pull-request.js';
import { parseReport, ReportError, readReportText, reportName } from './report.js';
import { readCrewRecords } from './state.js';
import { credentialSlots, LAUNCH_LOCK, LAUNCH_LOCK_STALE_MS } from './usage.js';
import {
  type Claim,
  claimComment,
  claimExpired,
  looksSecret,
  MAX_CLAIM_ATTEMPTS,
  parseClaim,
  parseOffer,
  renderClaim,
} from './worker-claim.js';
import {
  type EnforcedDeny,
  enforceDeny,
  mergeDeny,
  sandboxProblem,
  type WorkerPlatform,
} from './worker-deny.js';
import type { ClaimCommit, GitHubUser, WorkerHub } from './worker-hub.js';

export const WORKER_FILE = 'worker.json';
export const WORKER_LOCK = 'worker.lock';
/** A step can launch a crew, which clones: the lock stays valid well past that. */
const WORKER_LOCK_STALE_MS = 30 * 60_000;
/** How far a restart looks back for heartbeats of its own it wrote but did not save. */
const MAX_OWN_BEATS = 20;

/** The item this worker holds, as `worker.json` keeps it across restarts. */
export interface Current {
  item: WorkItem;
  offer: number;
  /** The claim commit this worker wrote last: every move of the claim builds on it. */
  claimSha: string;
  attempt: number;
  leaseMinutes: number;
  worker: string;
  /** This machine's clock at the last claim write, for the heartbeat cadence only. */
  lastBeat: string;
  /** This machine's clock when it won the claim: a crew record from then on is this claim's. */
  claimedAt: string;
  /** Whether a crew was started for this claim. */
  launched: boolean;
  /** The offer's nonce: every claim comment names it. */
  nonce?: string;
  /** Where the offer and the claim live, so following needs no fresh config. */
  primaryRepo?: string;
}

export interface WorkerState {
  label: string;
  current?: Current;
  /**
   * When this worker first saw each claim commit of another worker, on its own clock: a lease
   * runs from there, never from a commit date the writer could set.
   */
  seen?: Record<string, { sha: string; at: string }>;
}

export interface WorkerContext {
  project: string;
  label: string;
  ports: Ports;
  hub: WorkerHub;
  /**
   * The worker's own GitHub token (`worker-token`): its claims, pull requests and pushes for a
   * crew. Never handed into a crew session.
   */
  token: string;
  /** Other tokens of this machine (the crew token): a report holding one is never published. */
  secrets?: string[];
  /** Whether crews here get a crew token to push `studio/<id>`; without, the worker pushes. */
  crewPushes: boolean;
  /** The repository URL the worker clones and pushes for a crew; GitHub's HTTPS URL by default. */
  pushUrl?: (repo: string) => string;
  owner: LauncherEnv;
  /** Read again before every claim: interop or mounts can change while the worker runs. */
  platform: () => WorkerPlatform;
  log: (line: string) => void;
}

export type StepKind =
  | 'idle'
  | 'claimed'
  | 'working'
  | 'done'
  | 'released'
  | 'lost'
  | 'held'
  | 'refused';

export interface StepResult {
  kind: StepKind;
  item?: string;
  /** One line in Studio's words: what happened, or why nothing could. */
  line: string;
  /** Lines about deny entries enforced more widely than written. */
  notes?: string[];
}

function readWorkerState(stateRoot: string, label: string): WorkerState {
  const file = join(stateRoot, WORKER_FILE);
  assertStatePath(stateRoot, file);
  if (!existsSync(file)) return { label };
  if (!lstatSync(file).isFile()) throw new Error(`${file} is not a plain file`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; inspect it before the worker goes on`);
  }
  const s = raw as Partial<WorkerState> | null;
  if (s === null || typeof s !== 'object' || typeof s.label !== 'string') {
    throw new Error(`${file} has an unknown shape; inspect it before the worker goes on`);
  }
  if (s.label !== label && s.current !== undefined) {
    throw new Error(
      `this worker holds ${s.current.item.id} for the label ${s.label}; run it with --label ${s.label} until that is done`,
    );
  }
  const seen = s.seen !== null && typeof s.seen === 'object' ? s.seen : undefined;
  return {
    label,
    ...(s.current === undefined ? {} : { current: s.current }),
    ...(seen === undefined ? {} : { seen }),
  };
}

/** Writes the state; what was seen of other claims stays unless `s` brings its own. */
function saveWorkerState(stateRoot: string, s: WorkerState): void {
  let seen = s.seen;
  if (seen === undefined) {
    try {
      seen = readWorkerState(stateRoot, s.label).seen;
    } catch {
      seen = undefined;
    }
  }
  const out = { ...s, ...(seen === undefined ? {} : { seen }) };
  writeStateFile(stateRoot, join(stateRoot, WORKER_FILE), `${JSON.stringify(out, null, 2)}\n`);
}

/**
 * studio.yaml as a freshly fetched `origin/main` has it, with that commit: the worker never trusts
 * a stale or edited working tree.
 */
async function mainConfig(c: WorkerContext): Promise<{ config: StudioConfig; sha: string }> {
  try {
    await c.ports.git.run(c.project, [
      'fetch',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
  } catch {
    throw new Error('cannot fetch origin main in the worker checkout');
  }
  const g = (args: string[]) => c.ports.git.run(c.project, ['--no-replace-objects', ...args]);
  const sha = (await g(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('origin/main is not a commit SHA');
  const text = await g(['show', `${sha}:.studio/studio.yaml`]);
  return { config: parseConfig(text, `origin/main:.studio/studio.yaml`), sha };
}

const CONTENT_PATH = /^\.studio\/(roles|solutions)\/[A-Za-z0-9._-]{1,100}\.md$/;

/**
 * `.studio/roles` and `.studio/solutions` exactly as the pinned commit has them, in a directory of
 * the state root: the role text and the lessons of a brief come from `origin/main`, never from the
 * working tree. Only plain files with plain names; anything else is left out.
 */
async function pinnedContent(c: WorkerContext, stateRoot: string, sha: string): Promise<string> {
  const base = join(stateRoot, 'pinned');
  const dir = join(base, sha);
  if (existsSync(join(dir, '.complete'))) return dir;
  ensureStateDir(stateRoot, base);
  for (const old of readdirSync(base)) removeStateEntry(stateRoot, join(base, old));
  const g = (args: string[]) => c.ports.git.run(c.project, ['--no-replace-objects', ...args]);
  const tree = await g(['ls-tree', '-r', sha, '--', '.studio/roles', '.studio/solutions']);
  ensureStateDir(stateRoot, dir);
  let n = 0;
  for (const line of tree.split('\n')) {
    const m = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!m || !CONTENT_PATH.test(m[2] as string) || n++ >= 500) continue;
    const text = await g(['cat-file', 'blob', m[1] as string]);
    const file = join(dir, m[2] as string);
    ensureStateDir(stateRoot, dirname(file));
    writeStateFile(stateRoot, file, `${text}\n`);
  }
  writeStateFile(stateRoot, join(dir, '.complete'), `${sha}\n`);
  return dir;
}

/** The Claude config dir crews of this machine run with, for the pin check before a claim. */
function crewConfigDir(owner: LauncherEnv): string {
  const env = owner.env ?? process.env;
  const stored = crewClaudeDir(owner);
  if (existsSync(stored)) return stored;
  return env.CLAUDE_CONFIG_DIR || join(owner.homedir ?? homedir(), '.claude');
}

/**
 * Stricter than a local launch: the lead cannot see what this machine has installed, so every
 * pinned plugin must be installed here at exactly its pin, and the install list must be readable.
 */
export function strictPinProblem(
  configDir: string,
  pins: readonly PluginPin[],
): string | undefined {
  const have = installedVersions(configDir);
  if (have === undefined) {
    return `cannot read the installed plugins in ${configDir}; run studio account setup-plugins on this machine`;
  }
  for (const p of pins) {
    const v = have.get(p.name);
    if (v === undefined) {
      return `plugin ${p.name} is not installed in ${configDir}, pinned ${p.version}; run studio account setup-plugins on this machine`;
    }
    if (v !== p.version) {
      return `plugin ${p.name} is ${v} in ${configDir}, pinned ${p.version}; run studio account setup-plugins on this machine`;
    }
  }
  return undefined;
}

const opensPr = (item: WorkItem): boolean => item.type !== 'research' && item.type !== 'review';

interface Ready {
  config: StudioConfig;
  contentDir: string;
  deny: EnforcedDeny;
  me: GitHubUser;
  leaseMinutes: number;
}

/**
 * Everything that must hold before this machine may claim anything, so it never wins a claim it
 * cannot start: a sandbox (the platform read again now: interop or mounts may have changed), the
 * owner's worker settings, an identity that is not the lead's, a deny list the sandbox can enforce,
 * the pinned plugins, no account block, a credential that is not parked or at its limit, no other
 * launch in progress, no pause.
 */
async function readiness(
  c: WorkerContext,
  stateRoot: string,
): Promise<({ ok: true } & Ready) | { ok: false; kind: 'refused' | 'held'; line: string }> {
  const platform = c.platform();
  const problem = sandboxProblem(platform);
  if (problem !== undefined) return { ok: false, kind: 'refused', line: problem };
  const ownerConfig = loadOwnerConfig(c.owner);
  const self = ownerConfig.workers?.self;
  if (self === undefined) {
    return {
      ok: false,
      kind: 'refused',
      line: 'no workers.self in the owner config: name the lead whose offers this machine takes (workers: { self: { lead: <login> } })',
    };
  }
  const { config, sha } = await mainConfig(c);
  const me = await c.hub.user();
  if (me.login.toLowerCase() === self.lead.toLowerCase()) {
    return {
      ok: false,
      kind: 'refused',
      line: "this machine's GitHub token is the lead's own identity; a worker needs a token of its own, so its claims and pull requests can be told apart",
    };
  }
  const stateBase = dirname(stateRoot);
  const deny = enforceDeny({
    deny: mergeDeny(config.workers?.[c.label]?.deny, self.deny),
    platform,
    networkAllow: config.sandbox.networkAllow,
    keep: [c.project, stateRoot, stateBase, ...ownerConfig.crewToolchainPaths],
    allowRead: self.allowRead,
  });
  if ('refused' in deny) return { ok: false, kind: 'refused', line: deny.refused };
  const pins = strictPinProblem(
    crewConfigDir(c.owner),
    pinnedPlugins(config.plugins, ownerConfig.allowedPlugins),
  );
  if (pins !== undefined) return { ok: false, kind: 'refused', line: pins };
  const ownerRoot = ownerStateRootFor(c.owner);
  const block = blockHold(ownerRoot);
  if (block !== undefined) return { ok: false, kind: 'held', line: block };
  const limited = await limitHold(ownerRoot, ownerConfig, c.ports, c.owner);
  if (limited !== undefined) return { ok: false, kind: 'held', line: limited };
  const slots = await credentialSlots({ ownerRoot, ownerConfig, ports: c.ports, owner: c.owner });
  if (slots.hold !== undefined) return { ok: false, kind: 'held', line: slots.hold };
  if (slots.slots <= 0) {
    return { ok: false, kind: 'held', line: 'credential limit: no label of this machine has room' };
  }
  if (
    existsSync(ownerRoot) &&
    inspectStateLock(ownerRoot, LAUNCH_LOCK, {
      now: c.ports.clock.now(),
      heartbeatStaleMs: LAUNCH_LOCK_STALE_MS,
    }).state === 'held'
  ) {
    return { ok: false, kind: 'held', line: 'another launch is in progress on this machine' };
  }
  if (readPause(stateRoot).paused) {
    return { ok: false, kind: 'held', line: 'paused on this machine: nothing is claimed' };
  }
  const contentDir = await pinnedContent(c, stateRoot, sha);
  return { ok: true, config, contentDir, deny, me, leaseMinutes: self.leaseMinutes };
}

/**
 * One pass of the worker: go on with the item it holds, or claim one. Safe to run again after a
 * crash or a restart: the item it holds is in `worker.json`, and the claim on GitHub decides. An
 * item it holds is followed first, before any check for new claims, so a check that fails now
 * never costs its heartbeat.
 */
export async function workerStep(c: WorkerContext): Promise<StepResult> {
  const stateRoot = stateRootFor(c.project, c.owner);
  const url = (await c.ports.git.run(c.project, ['remote', 'get-url', 'origin'])).trim();
  checkStateMarker(stateRoot, { projectRealpath: projectRealpath(c.project), originUrl: url });
  const lock = acquireStateLock(stateRoot, WORKER_LOCK, {
    now: c.ports.clock.now(),
    heartbeatStaleMs: WORKER_LOCK_STALE_MS,
  });
  if (!lock) return { kind: 'held', line: 'another worker process runs for this checkout' };
  try {
    const state = readWorkerState(stateRoot, c.label);
    if (state.current !== undefined) {
      const repo = state.current.primaryRepo ?? (await mainConfig(c)).config.primaryRepo;
      return await followCurrent(c, stateRoot, state, state.current, repo);
    }
    const ready = await readiness(c, stateRoot);
    if (!ready.ok) return { kind: ready.kind, line: ready.line };
    const notes = ready.deny.notes;
    const r = await claimNext(c, stateRoot, state, ready);
    return notes.length > 0 ? { ...r, notes } : r;
  } finally {
    lock.release();
  }
}

/** Takes a claim this worker won back: the ref goes, no `released` is written, the item stays offered. */
async function giveUp(
  c: WorkerContext,
  stateRoot: string,
  repo: string,
  cur: Current,
): Promise<void> {
  try {
    const tip = await c.hub.readClaim(repo, cur.item.id);
    if (tip?.sha === cur.claimSha) await c.hub.deleteClaim(repo, cur.item.id);
  } catch (e) {
    c.log(`${cur.item.id}: could not remove its own claim: ${(e as Error).message}`);
  }
  saveWorkerState(stateRoot, { label: c.label });
}

async function claimNext(
  c: WorkerContext,
  stateRoot: string,
  state: WorkerState,
  ready: Ready,
): Promise<StepResult> {
  const { config, me } = ready;
  const repo = config.primaryRepo;
  const lead = loadOwnerConfig(c.owner).workers?.self?.lead as string;
  const now = c.ports.clock.now();
  // First sight of each claim commit, kept only for claims that still exist.
  const seen: Record<string, { sha: string; at: string }> = {};
  const firstSeen = (id: string, sha: string): string => {
    const before = state.seen?.[id];
    const at = before?.sha === sha ? before.at : now.toISOString();
    seen[id] = { sha, at };
    return at;
  };
  const keepSeen = () => saveWorkerState(stateRoot, { label: c.label, seen });
  for (const issue of await c.hub.listOffers(repo)) {
    // Only the lead's own offers count, and only as the lead wrote them.
    if (issue.author !== lead) continue;
    if (issue.edited && issue.editor !== lead) {
      c.log(`skipped offer #${issue.number}: edited by someone other than the lead`);
      continue;
    }
    const offer = parseOffer(issue.title, issue.body);
    if (offer === undefined || offer.label !== c.label || offer.lead !== lead) continue;
    const item = offer.item;
    if (item.repo !== config.primaryRepo && !config.repos.includes(item.repo)) continue;
    const existing = await c.hub.readClaim(repo, item.id);
    let parent: string | undefined;
    let attempt = 1;
    if (existing !== undefined) {
      const held = parseClaim(existing.message);
      // Taken: a live claim, a finished one the lead has not collected, or one of an older offer.
      const since = firstSeen(item.id, existing.sha);
      if (held === undefined || held.offer !== issue.number) continue;
      if (!claimExpired(held, since, now)) continue;
      if (held.attempt >= MAX_CLAIM_ATTEMPTS) continue;
      parent = existing.sha;
      attempt = held.attempt + 1;
    }
    const claim: Claim = {
      studioClaim: 1,
      item: item.id,
      label: c.label,
      worker: me.login,
      offer: issue.number,
      attempt,
      state: 'claimed',
      leaseMinutes: ready.leaseMinutes,
    };
    const wrote = await writeClaim(c, repo, claim, parent);
    if (!wrote.ok) continue; // another worker was faster
    delete seen[item.id];
    keepSeen();
    const current: Current = {
      item,
      offer: issue.number,
      claimSha: wrote.sha,
      attempt,
      leaseMinutes: ready.leaseMinutes,
      worker: me.login,
      lastBeat: now.toISOString(),
      claimedAt: now.toISOString(),
      launched: false,
      nonce: offer.nonce,
      primaryRepo: repo,
    };
    saveWorkerState(stateRoot, { label: c.label, current });
    // Withdrawn while this worker claimed it: the claim goes again.
    const fresh = await c.hub.offer(repo, issue.number);
    if (fresh === undefined || !fresh.open) {
      await giveUp(c, stateRoot, repo, current);
      return { kind: 'idle', line: `${item.id}: the offer was closed as it was claimed; let go` };
    }
    // The ref is only the lock. Who claimed is proven by this comment: GitHub sets its author from
    // the worker token. Without it the lead never counts the claim, so the claim goes again.
    try {
      await c.hub.commentOffer(repo, issue.number, claimComment(wrote.sha, offer.nonce));
    } catch (e) {
      c.log(`${item.id}: the claim comment failed: ${(e as Error).message}`);
      await giveUp(c, stateRoot, repo, current);
      return { kind: 'held', item: item.id, line: `${item.id}: the claim comment failed; let go` };
    }
    // A fix round or a takeover goes on with what an earlier run pushed.
    const from =
      (await c.hub.branchHead(item.repo, `studio/${item.id}`)) === undefined
        ? ITEM_BASE
        : `studio/${item.id}`;
    try {
      await launchCrew(c.project, item, config, c.ports, c.owner, {
        deny: ready.deny,
        from,
        contentDir: ready.contentDir,
        ...(c.crewPushes ? {} : { noToken: true }),
      });
    } catch (e) {
      // Nothing ran: the claim goes, the offer stays for this or another worker.
      await giveUp(c, stateRoot, repo, current);
      const why = (e as Error).message;
      if (e instanceof HeldError) {
        return { kind: 'held', item: item.id, line: `${item.id}: not now (${why}); let go` };
      }
      c.log(`launch of ${item.id} refused: ${why}`);
      return {
        kind: 'refused',
        item: item.id,
        line: `${item.id}: the crew could not start on this machine; let go, fix it and start the worker again`,
      };
    }
    saveWorkerState(stateRoot, { label: c.label, current: { ...current, launched: true } });
    return {
      kind: 'claimed',
      item: item.id,
      line: `${item.id}: claimed (attempt ${attempt}) and its crew started${from === ITEM_BASE ? '' : ` from ${from}`}`,
    };
  }
  keepSeen();
  return { kind: 'idle', line: `no open offer for ${c.label}` };
}

const claimFile = (claim: Claim): string => `${renderClaim(claim).split('\n\n')[1]?.trim()}\n`;

async function writeClaim(
  c: WorkerContext,
  repo: string,
  claim: Claim,
  parent: string | undefined,
  files: Record<string, string> = {},
): Promise<{ ok: true; sha: string } | { ok: false }> {
  return c.hub.writeClaim(repo, claim.item, {
    message: renderClaim(claim),
    files: { 'claim.json': claimFile(claim), ...files },
    ...(parent === undefined ? {} : { parent }),
  });
}

const claimOf = (label: string, cur: Current, state: Claim['state']): Claim => ({
  studioClaim: 1,
  item: cur.item.id,
  label,
  worker: cur.worker,
  offer: cur.offer,
  attempt: cur.attempt,
  state,
  leaseMinutes: cur.leaseMinutes,
});

/**
 * Names a state-changing claim commit (`done`, `released`) in a comment, as the claim itself was:
 * the lead counts such a tip only when the proven claimant announced it. Tried twice.
 */
async function announce(c: WorkerContext, repo: string, cur: Current, sha: string): Promise<void> {
  if (cur.nonce === undefined) {
    c.log(`${cur.item.id}: no nonce on record; the lead will not count ${sha.slice(0, 12)}`);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await c.hub.commentOffer(repo, cur.offer, claimComment(sha, cur.nonce));
      return;
    } catch (e) {
      c.log(`${cur.item.id}: announcing ${sha.slice(0, 12)} failed: ${(e as Error).message}`);
    }
  }
}

/** Gives the item up after its crew ran: a `released` claim with a fixed reason; clears `current`. */
async function release(
  c: WorkerContext,
  stateRoot: string,
  state: { label: string },
  cur: Current,
  repo: string,
  reason: string,
  usage?: RunUsage,
): Promise<void> {
  const claim: Claim = {
    ...claimOf(state.label, cur, 'released'),
    reason,
    ...(usage === undefined || usage.runs === 0 ? {} : { usage: usageField(usage) }),
  };
  const wrote = await writeClaim(c, repo, claim, cur.claimSha);
  if (!wrote.ok) c.log(`${cur.item.id}: the claim moved meanwhile; not released`);
  else await announce(c, repo, cur, wrote.sha);
  saveWorkerState(stateRoot, { label: state.label });
}

const usageField = (u: RunUsage): NonNullable<Claim['usage']> => ({
  runs: u.runs,
  tokensIn: u.tokensIn,
  tokensOut: u.tokensOut,
  tokensCache: u.tokensCache,
  costUsd: Math.round(u.costUsd * 1e6) / 1e6,
  ...(u.estimated ? { estimated: true as const } : {}),
});

async function stopCrew(c: WorkerContext, stateRoot: string, id: string): Promise<void> {
  const rec = readCrewRecords(stateRoot)[id];
  if (rec === undefined) return;
  if ((await crewHold(rec, c.ports)) === 'running') await c.ports.claude.stop(rec.pid);
}

/**
 * Whether `tip` lies on top of this worker's last saved claim commit through heartbeats of its own
 * (a worker cut short after a heartbeat but before saving it): then the claim is still its own.
 */
async function ownBeats(
  c: WorkerContext,
  repo: string,
  cur: Current,
  tip: ClaimCommit,
): Promise<boolean> {
  let at: ClaimCommit | undefined = tip;
  for (let i = 0; i < MAX_OWN_BEATS && at !== undefined; i++) {
    if (at.sha === cur.claimSha) return true;
    const cl = parseClaim(at.message);
    if (
      cl === undefined ||
      cl.state !== 'alive' ||
      cl.worker !== cur.worker ||
      cl.attempt !== cur.attempt ||
      cl.offer !== cur.offer
    ) {
      return false;
    }
    const parent: string | undefined = at.parents[0];
    at = parent === undefined ? undefined : await c.hub.claimCommit(repo, parent);
  }
  return false;
}

/** The claim is still this worker's (its last commit, or its own heartbeats on top). */
async function stillMine(
  c: WorkerContext,
  stateRoot: string,
  state: WorkerState,
  cur: Current,
  repo: string,
): Promise<Current | undefined> {
  const read = await c.hub.readClaim(repo, cur.item.id);
  if (read === undefined) return undefined;
  if (read.sha === cur.claimSha) return cur;
  if (!(await ownBeats(c, repo, cur, read))) return undefined;
  const adopted = { ...cur, claimSha: read.sha };
  saveWorkerState(stateRoot, { label: state.label, current: adopted });
  return adopted;
}

async function followCurrent(
  c: WorkerContext,
  stateRoot: string,
  state: WorkerState,
  held: Current,
  repo: string,
): Promise<StepResult> {
  const id = held.item.id;
  const cur = await stillMine(c, stateRoot, state, held, repo);
  if (cur === undefined) {
    // Someone else moved or removed the claim: this machine no longer holds the item.
    await stopCrew(c, stateRoot, id);
    saveWorkerState(stateRoot, { label: state.label });
    return {
      kind: 'lost',
      item: id,
      line: `${id}: the claim is no longer this worker's; its crew was stopped`,
    };
  }
  const offer = await c.hub.offer(repo, cur.offer);
  if (offer === undefined || !offer.open) {
    await stopCrew(c, stateRoot, id);
    await release(c, stateRoot, state, cur, repo, 'the offer was withdrawn');
    return {
      kind: 'released',
      item: id,
      line: `${id}: the offer was withdrawn; its crew was stopped`,
    };
  }
  const rec = readCrewRecords(stateRoot)[id];
  const hold = rec === undefined ? undefined : await crewHold(rec, c.ports);
  if (hold === 'running' || hold === 'unverified') {
    const now = c.ports.clock.now();
    const due = now.getTime() - Date.parse(cur.lastBeat) >= (cur.leaseMinutes * 60_000) / 3;
    if (!due) {
      return { kind: 'working', item: id, line: `${id}: the crew is working` };
    }
    const wrote = await writeClaim(c, repo, claimOf(state.label, cur, 'alive'), cur.claimSha);
    if (!wrote.ok) {
      await stopCrew(c, stateRoot, id);
      saveWorkerState(stateRoot, { label: state.label });
      return {
        kind: 'lost',
        item: id,
        line: `${id}: the heartbeat lost the claim; its crew was stopped`,
      };
    }
    saveWorkerState(stateRoot, {
      label: state.label,
      current: { ...cur, claimSha: wrote.sha, lastBeat: now.toISOString() },
    });
    return {
      kind: 'working',
      item: id,
      line: `${id}: the crew is working${hold === 'unverified' ? ' (its process cannot be verified)' : ''}; heartbeat sent`,
    };
  }
  // A worker cut short between the start and saving it still finds the crew by its record.
  const launched =
    cur.launched ||
    (rec !== undefined && Date.parse(rec.startedAt) >= Date.parse(cur.claimedAt ?? cur.lastBeat));
  if (!launched || rec === undefined) {
    // Nothing ran for this claim: it goes, the item stays offered.
    await giveUp(c, stateRoot, repo, cur);
    return { kind: 'held', item: id, line: `${id}: no crew ran for the claim; let go` };
  }
  return finish(c, stateRoot, state, cur, repo, rec);
}

/** The crew ended: read its report, open its pull request, hand both back on the claim. */
async function finish(
  c: WorkerContext,
  stateRoot: string,
  state: WorkerState,
  cur: Current,
  repo: string,
  rec: { startedAt: string; logStart?: number; label?: string },
): Promise<StepResult> {
  const id = cur.item.id;
  const from = typeof rec.logStart === 'number' && rec.logStart >= 0 ? rec.logStart : 0;
  const usage = runUsageSince(stateRoot, id, from);
  const releaseWith = async (reason: string): Promise<StepResult> => {
    await release(c, stateRoot, state, cur, repo, reason, usage);
    return { kind: 'released', item: id, line: `${id}: ${reason}; released` };
  };
  let text: string;
  let report: ReturnType<typeof parseReport>;
  try {
    const fileName = reportName(stateRoot, id);
    if (fileName === undefined) throw new ReportError('no report name was drawn for this run');
    text = readReportText(join(stateRoot, 'clones', id), id, {
      notBefore: new Date(rec.startedAt),
      fileName,
    });
    report = parseReport(text, cur.item);
  } catch (e) {
    noteLimitOrBlock(c, stateRoot, id, from, rec.label);
    // ReportError texts are Studio's own fixed lines; anything else is not passed on.
    return releaseWith(
      e instanceof ReportError ? `report: ${e.message}` : 'the report could not be read',
    );
  }
  const known = [
    c.token,
    ...(c.secrets ?? []),
    ...(c.owner.env?.CLAUDE_CODE_OAUTH_TOKEN ? [c.owner.env.CLAUDE_CODE_OAUTH_TOKEN] : []),
  ];
  if (looksSecret(text, known)) {
    return releaseWith('the report looks like it holds a credential; it stays on the worker');
  }
  // Before anything leaves this machine: the claim and its offer must still be this worker's.
  if ((await c.hub.readClaim(repo, id))?.sha !== cur.claimSha) {
    saveWorkerState(stateRoot, { label: state.label });
    return { kind: 'lost', item: id, line: `${id}: the claim moved before the report went out` };
  }
  if (!(await c.hub.offer(repo, cur.offer))?.open) {
    return releaseWith('the offer was withdrawn');
  }
  let pr: number | undefined;
  if (report.status === 'done' && opensPr(cur.item)) {
    if (!c.crewPushes) {
      // The crew had no token: the worker pushes its branch, with its own identity.
      let problem: string | undefined;
      try {
        problem = await pushForCrew(c, stateRoot, cur.item, report.headSha ?? '');
      } catch (e) {
        c.log(`${id}: ${(e as Error).message}`);
        problem = 'the worker could not push the branch';
      }
      if (problem !== undefined) return releaseWith(problem);
    } else {
      const head = await c.hub.branchHead(cur.item.repo, `studio/${id}`);
      if (head === undefined || head.toLowerCase() !== report.headSha?.toLowerCase()) {
        return releaseWith('the pushed branch head differs from the report');
      }
    }
    try {
      const opened = await openPullRequest(c, cur.item, report);
      if (typeof opened === 'string') return releaseWith(opened);
      pr = opened;
    } catch (e) {
      c.log(`${id}: ${(e as Error).message}`);
      return releaseWith('the pull request could not be opened');
    }
  }
  const claim: Claim = {
    ...claimOf(state.label, cur, 'done'),
    ...(pr === undefined ? {} : { pr }),
    ...(report.headSha === undefined ? {} : { headSha: report.headSha.toLowerCase() }),
    ...(usage.runs === 0 ? {} : { usage: usageField(usage) }),
  };
  const wrote = await writeClaim(c, repo, claim, cur.claimSha, {
    'report.md': text,
    ...(usage.runs === 0
      ? {}
      : { 'usage.json': `${JSON.stringify(usageField(usage), null, 2)}\n` }),
  });
  if (wrote.ok) await announce(c, repo, cur, wrote.sha);
  saveWorkerState(stateRoot, { label: state.label });
  if (!wrote.ok) {
    return {
      kind: 'lost',
      item: id,
      line: `${id}: the claim moved before the report was handed back`,
    };
  }
  return {
    kind: 'done',
    item: id,
    line: `${id}: report ${report.status} handed back${pr === undefined ? '' : ` with pull request #${pr}`}`,
  };
}

/**
 * Opens the crew's pull request in-process, as the worker: an open one of the branch is renewed
 * only when it is the worker's own and comes from the repository itself; one by another account
 * refuses. Returns the number, or a fixed reason.
 */
async function openPullRequest(
  c: WorkerContext,
  item: WorkItem,
  report: ReturnType<typeof parseReport>,
): Promise<number | string> {
  const me = await c.hub.user();
  const branch = `studio/${item.id}`;
  const open = (await c.hub.openPullRequests(item.repo, branch)).filter(
    (p) => p.headRepo?.toLowerCase() === item.repo.toLowerCase() && p.branch === branch,
  );
  if (open.some((p) => p.authorId !== me.id)) {
    return 'a pull request of another account is open for the branch';
  }
  const body = crewPrText(item, report.body, report.notRunHere);
  const mine = open[0];
  if (mine !== undefined) {
    await c.hub.editPullRequestBody(item.repo, mine.number, body);
    return mine.number;
  }
  const title = crewPrTitle(report.prTitle ?? `${item.id}: ${item.title}`);
  if (title === '') return 'the pull request title is empty';
  return c.hub.createPullRequest(item.repo, { head: branch, base: ITEM_BASE, title, body });
}

/**
 * Pushes `studio/<id>` of a crew that had no token. The crew's clone is never a place where git
 * runs (rule D4). A fresh bare, blob-less clone of the repository gets the crew's branch fetched
 * from the clone, which is read as a remote only (git ignores the hook settings of a repository it
 * fetches from); everything the branch shares with the repository is already there, so the clone's
 * missing blobs are never asked for. The head is checked against the report and pushed, never
 * forced. The worker token reaches git through the environment of these calls only.
 */
async function pushForCrew(
  c: WorkerContext,
  stateRoot: string,
  item: WorkItem,
  head: string,
): Promise<string | undefined> {
  const id = item.id;
  const branch = `refs/heads/studio/${id}`;
  const parent = join(stateRoot, 'push');
  const dir = join(parent, id);
  ensureStateDir(stateRoot, parent);
  removeStateEntry(stateRoot, dir);
  const timeoutMs = 600_000;
  const auth = [
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!f() { echo username=x-access-token; echo "password=$STUDIO_PUSH_TOKEN"; }; f',
  ];
  const env = { STUDIO_PUSH_TOKEN: c.token };
  const url = c.pushUrl?.(item.repo) ?? githubHttpsUrl(item.repo);
  const git = (cwd: string, args: string[], withToken = false) =>
    c.ports.git.run(cwd, args, { timeoutMs, ...(withToken ? { env } : {}) });
  try {
    await git(parent, [...auth, 'clone', '-q', '--bare', '--filter=blob:none', url, dir], true);
    await git(dir, [
      '-c',
      'protocol.file.allow=always',
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      join(stateRoot, 'clones', id),
      `+${branch}:${branch}`,
    ]);
    const got = (
      await git(dir, ['--no-replace-objects', 'rev-parse', '--verify', `${branch}^{commit}`])
    ).trim();
    if (got.toLowerCase() !== head.toLowerCase()) {
      return 'the branch in the clone differs from the report';
    }
    await git(dir, [...auth, 'push', '-q', url, `${branch}:${branch}`], true);
    const remote = (await git(dir, [...auth, 'ls-remote', url, branch], true)).split(/\s/)[0] ?? '';
    if (remote.toLowerCase() !== head.toLowerCase()) {
      return 'the pushed branch head differs from the report';
    }
    return undefined;
  } finally {
    removeStateEntry(stateRoot, dir);
  }
}

/**
 * A crew that ended without a usable report may have hit a usage limit or an account block: the
 * same owner-wide files as on the lead's machine park the label or stop every launch here.
 */
function noteLimitOrBlock(
  c: WorkerContext,
  stateRoot: string,
  id: string,
  from: number,
  label = 'default',
): void {
  const ownerRoot = ownerStateRootFor(c.owner);
  const now = c.ports.clock.now();
  try {
    const block = scanLogForBlock(stateRoot, id, from);
    if (block !== undefined) {
      const read = readBlocks(ownerRoot);
      if (read.ok && !read.blocks.some((b) => b.label === label && b.reason === block.reason)) {
        writeBlocks(ownerRoot, [
          ...read.blocks,
          { label, reason: block.reason, at: now.toISOString() },
        ]);
      }
      return;
    }
    const limit = scanLogForLimit(stateRoot, id, from);
    if (limit !== undefined) {
      const read = readLimits(ownerRoot);
      if (read.ok) {
        writeLimits(ownerRoot, {
          ...read.labels,
          [label]: { parkedUntil: parkUntil(limit.resetsAt, now).toISOString(), kind: limit.kind },
        });
      }
    }
  } catch (e) {
    c.log(`${id}: could not record a limit or block: ${(e as Error).message}`);
  }
}

/** Where the worker keeps its state: beside the crews of this checkout. */
export const workerStateFile = (project: string, owner: LauncherEnv): string =>
  join(stateRootFor(project, owner), WORKER_FILE);
