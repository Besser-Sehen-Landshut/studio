// `studio worker --label <label>`: a machine other than the lead's takes offered items of its
// label, one at a time. It claims an item atomically on GitHub, runs a crew for it exactly like the
// lead would (same brief, sandbox, guard, skill allowlist, pinned plugins, report schema) plus its
// own deny list, opens the pull request with its own GitHub identity and hands the report back on
// the claim. The lead collects, reviews, queues and merges as for any crew. Nothing is shared
// between the machines but GitHub.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crewClaudeDir } from './accounts.js';
import type { WorkItem } from './board.js';
import { loadOwnerConfig, parseConfig, type StudioConfig } from './config.js';
import { type RunUsage, runUsageSince } from './costs.js';
import { crewHold, githubHttpsUrl, ITEM_BASE, type LauncherEnv, launchCrew } from './crew.js';
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
  ownerStateRootFor,
  projectRealpath,
  removeStateEntry,
  stateRootFor,
  writeStateFile,
} from './paths.js';
import { readPause } from './pause.js';
import { installedVersions, type PluginPin, pinnedPlugins } from './plugins.js';
import type { Ports } from './ports.js';
import { openCrewPr } from './pull-request.js';
import { parseReport, ReportError, readReportText, reportName } from './report.js';
import { readCrewRecords } from './state.js';
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
import type { WorkerHub } from './worker-hub.js';

export const WORKER_FILE = 'worker.json';
export const WORKER_LOCK = 'worker.lock';
/** A step can launch a crew, which clones: the lock stays valid well past that. */
const WORKER_LOCK_STALE_MS = 30 * 60_000;

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
  /** Whether crews here get a crew token to push `studio/<id>`; without, the worker pushes. */
  crewPushes: boolean;
  /** Where the worker pushes a crew's branch; GitHub's HTTPS URL of the repository by default. */
  pushUrl?: (repo: string) => string;
  owner: LauncherEnv;
  platform: WorkerPlatform;
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

/** studio.yaml as `origin/main` has it: the worker never trusts a stale or edited working tree. */
async function mainConfig(c: WorkerContext): Promise<StudioConfig> {
  try {
    await c.ports.git.run(c.project, [
      'fetch',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
  } catch {
    throw new Error('cannot fetch origin main in the worker checkout');
  }
  const text = await c.ports.git.run(c.project, [
    '--no-replace-objects',
    'show',
    'refs/remotes/origin/main:.studio/studio.yaml',
  ]);
  return parseConfig(text, 'origin/main:.studio/studio.yaml');
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

const NO_CAPACITY = { ciBusy: 0, ciTotal: 0, hostLoad: 0, ok: true, hostOk: true };

const opensPr = (item: WorkItem): boolean => item.type !== 'research' && item.type !== 'review';

/**
 * Everything that must hold before this machine may claim anything: a sandbox, the owner's
 * worker settings, an identity that is not the lead's, a deny list the sandbox can enforce, the
 * pinned plugins, no account block and no pause.
 */
async function readiness(
  c: WorkerContext,
  stateRoot: string,
): Promise<
  | { ok: true; config: StudioConfig; deny: EnforcedDeny; login: string; leaseMinutes: number }
  | { ok: false; kind: 'refused' | 'held'; line: string }
> {
  const problem = sandboxProblem(c.platform);
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
  const config = await mainConfig(c);
  const login = await c.hub.login();
  if (login.toLowerCase() === self.lead.toLowerCase()) {
    return {
      ok: false,
      kind: 'refused',
      line: "this machine's GitHub token is the lead's own identity; a worker needs a token of its own, so its claims and pull requests can be told apart",
    };
  }
  const deny = enforceDeny({
    deny: mergeDeny(config.workers?.[c.label]?.deny, self.deny),
    platform: c.platform,
    networkAllow: config.sandbox.networkAllow,
    keep: [c.project, stateRoot, ...ownerConfig.crewToolchainPaths],
  });
  if ('refused' in deny) return { ok: false, kind: 'refused', line: deny.refused };
  const pins = strictPinProblem(
    crewConfigDir(c.owner),
    pinnedPlugins(config.plugins, ownerConfig.allowedPlugins),
  );
  if (pins !== undefined) return { ok: false, kind: 'refused', line: pins };
  const block = blockHold(ownerStateRootFor(c.owner));
  if (block !== undefined) return { ok: false, kind: 'held', line: block };
  if (readPause(stateRoot).paused) {
    return { ok: false, kind: 'held', line: 'paused on this machine: nothing is claimed' };
  }
  return { ok: true, config, deny, login, leaseMinutes: self.leaseMinutes };
}

/**
 * One pass of the worker: go on with the item it holds, or claim one. Safe to run again after a
 * crash or a restart: the item it holds is in `worker.json`, and the claim on GitHub decides.
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
    const ready = await readiness(c, stateRoot);
    if (state.current !== undefined) {
      // A held item goes on even when new claims are refused: its claim and crew need an end.
      const repo = ready.ok ? ready.config.primaryRepo : await primaryRepoOf(c);
      return await followCurrent(c, stateRoot, state, state.current, repo);
    }
    if (!ready.ok) return { kind: ready.kind, line: ready.line };
    const notes = ready.deny.notes;
    const r = await claimNext(c, stateRoot, state, ready);
    return notes.length > 0 ? { ...r, notes } : r;
  } finally {
    lock.release();
  }
}

async function primaryRepoOf(c: WorkerContext): Promise<string> {
  return (await mainConfig(c)).primaryRepo;
}

async function claimNext(
  c: WorkerContext,
  stateRoot: string,
  state: WorkerState,
  ready: { config: StudioConfig; deny: EnforcedDeny; login: string; leaseMinutes: number },
): Promise<StepResult> {
  const { config, login } = ready;
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
  const keepSeen = () =>
    saveWorkerState(stateRoot, {
      label: c.label,
      ...(state.current === undefined ? {} : { current: state.current }),
      seen,
    });
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
      worker: login,
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
      worker: login,
      lastBeat: c.ports.clock.now().toISOString(),
      claimedAt: c.ports.clock.now().toISOString(),
      launched: false,
    };
    saveWorkerState(stateRoot, { ...state, current });
    // The ref is only the lock. Who claimed is proven by this comment: GitHub sets its author from
    // the worker token. Without it the lead never counts the claim, so give the claim up.
    try {
      await c.hub.commentOffer(repo, issue.number, claimComment(wrote.sha, offer.nonce));
    } catch (e) {
      c.log(`${item.id}: the claim comment failed: ${(e as Error).message}`);
      await release(
        c,
        stateRoot,
        { label: c.label },
        current,
        repo,
        'the worker could not post its claim comment',
      );
      return {
        kind: 'released',
        item: item.id,
        line: `${item.id}: the claim comment failed; released`,
      };
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
        ...(c.crewPushes ? {} : { noToken: true }),
      });
    } catch (e) {
      c.log(`launch of ${item.id} refused: ${(e as Error).message}`);
      await release(
        c,
        stateRoot,
        { label: c.label },
        current,
        repo,
        'the worker could not start a crew; the reason is in the worker output',
      );
      return {
        kind: 'released',
        item: item.id,
        line: `${item.id}: the crew did not start; released`,
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

/** Gives the item up: a `released` claim with a reason in Studio's words; clears `current`. */
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

async function followCurrent(
  c: WorkerContext,
  stateRoot: string,
  state: WorkerState,
  cur: Current,
  repo: string,
): Promise<StepResult> {
  const id = cur.item.id;
  const read = await c.hub.readClaim(repo, id);
  if (read === undefined || read.sha !== cur.claimSha) {
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
    await release(c, stateRoot, state, cur, repo, 'the worker stopped before a crew ran');
    return { kind: 'released', item: id, line: `${id}: no crew ran for the claim; released` };
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
    ...(c.owner.env?.CLAUDE_CODE_OAUTH_TOKEN ? [c.owner.env.CLAUDE_CODE_OAUTH_TOKEN] : []),
  ];
  if (looksSecret(text, known)) {
    return releaseWith('the report looks like it holds a credential; it stays on the worker');
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
      const opened = await openCrewPr(
        c.ports,
        cur.item,
        report.prTitle ?? `${id}: ${cur.item.title}`,
        report.body,
        report.notRunHere,
        c.token,
        async () => ({ ok: true, capacity: NO_CAPACITY }),
        () => {},
      );
      if (!('pr' in opened)) return releaseWith('the pull request was not opened');
      pr = opened.pr;
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
 * Pushes `studio/<id>` of a crew that had no token. The crew's clone is never a place where git
 * runs (rule D4): its branch is fetched into a fresh bare repository of the worker, read there as
 * a remote only (git ignores the hook settings of a repository it fetches from), checked against
 * the report's head, and pushed from there with the worker token, never forced.
 */
async function pushForCrew(
  c: WorkerContext,
  stateRoot: string,
  item: WorkItem,
  head: string,
): Promise<string | undefined> {
  const id = item.id;
  const branch = `refs/heads/studio/${id}`;
  const dir = join(stateRoot, 'push', id);
  removeStateEntry(stateRoot, dir);
  ensureStateDir(stateRoot, dir);
  const timeoutMs = 300_000;
  const git = (args: string[], env?: Record<string, string>) =>
    c.ports.git.run(dir, args, { timeoutMs, ...(env === undefined ? {} : { env }) });
  try {
    await git(['init', '--bare', '-q']);
    await git([
      '-c',
      'protocol.file.allow=always',
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      join(stateRoot, 'clones', id),
      `+${branch}:${branch}`,
    ]);
    const got = (
      await git(['--no-replace-objects', 'rev-parse', '--verify', `${branch}^{commit}`])
    ).trim();
    if (got.toLowerCase() !== head.toLowerCase())
      return 'the branch in the clone differs from the report';
    // The token goes through the environment of this one call, never argv or a file.
    const auth = [
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!f() { echo username=x-access-token; echo "password=$STUDIO_PUSH_TOKEN"; }; f',
    ];
    const env = { STUDIO_PUSH_TOKEN: c.token };
    const url = c.pushUrl?.(item.repo) ?? githubHttpsUrl(item.repo);
    await git([...auth, 'push', url, `${branch}:${branch}`], env);
    const remote = (await git([...auth, 'ls-remote', url, branch], env)).split(/\s/)[0] ?? '';
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
