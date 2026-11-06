// The worker's side of a relay worker: `studio relay serve`, the command sshd forces for the lead's
// key. It reads one request (src/relay-protocol.ts) and answers it; it never runs a command it was
// sent. The machine holds no GitHub credential and no credential of the lead's machine: code comes
// in as a git bundle of the pinned `main`, the crew's Claude token comes in the start request and
// stays in memory, and results go back as a report and a bundle of `studio/<id>`, which the lead
// checks, pushes and turns into a pull request itself.
//
// A crew outlives the SSH session: a start hands the job to a runner (`studio relay run <id>`), a
// process of its own that the session does not end. The runner probes the sandbox, launches the
// crew exactly as a worker does (src/worker.ts: the brief from the pinned commit, the deny lists,
// the Windows crew sandbox on native Windows) and on Windows holds the egress proxy until the crew
// ends. One crew at a time on a relay worker.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { cpus, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crewClaudeDir, listAccounts } from './accounts.js';
import type { WorkItem } from './board.js';
import { loadOwnerConfig, parseConfig, type RelayServe, relayServeSchema } from './config.js';
import { runUsageSince } from './costs.js';
import { readCrewTokenFile, readWorkerTokenFile } from './credentials.js';
import { crewHold, type LauncherEnv, launchCrew, type WindowsLaunch } from './crew.js';
import { HeldError } from './held.js';
import { scanLogForBlock, scanLogForLimit } from './limits.js';
import {
  acquireStateLock,
  assertStatePath,
  checkStateMarker,
  ensureStateDir,
  projectRealpath,
  removeStateEntry,
  stateBaseFor,
  stateRootFor,
  writeStateFile,
} from './paths.js';
import { installedVersions, pinnedPlugins, STUDIO_VERSION } from './plugins.js';
import type { Ports } from './ports.js';
import { pairProofs, readPairings } from './relay-pair.js';
import {
  type CollectAnswer,
  encodeMessage,
  LineReader,
  MAX_HEADER_BYTES,
  MAX_RESULT_BUNDLE_BYTES,
  MAX_START_BUNDLE_BYTES,
  parseRequest,
  RELAY_PROTOCOL,
  type RelayJob,
  type RelayState,
  readMessage,
} from './relay-protocol.js';
import { parseReport, readReportText, reportName } from './report.js';
import { readCrewRecords } from './state.js';
import { pinnedContent, strictPinProblem } from './worker.js';
import { workerItemOf } from './worker-claim.js';
import {
  type EnforcedDeny,
  enforceDeny,
  mergeDeny,
  sandboxProblem,
  type WorkerPlatform,
} from './worker-deny.js';

/** Where a relay worker keeps its jobs, mirrors and project checkouts: below the state base. */
export const relayRoot = (owner: LauncherEnv): string => join(stateBaseFor(owner), 'relay');

const RELAY_LOCK = 'relay.lock';
const RELAY_LOCK_STALE_MS = 10 * 60_000;
/** How long `start` waits for the runner to take the job (its spec, with the token). */
const HANDOFF_MS = 60_000;

/** One job as the worker keeps it; never the token. */
export interface JobRecord {
  id: string;
  /** The lead that started it: no other lead can see, stop, collect or clean it up. */
  lead: string;
  label: string;
  repo: string;
  sha: string;
  from: string;
  fromSha?: string;
  item: Record<string, unknown>;
  state: RelayState;
  /** Studio's own line: why held, refused or stopped. */
  line?: string;
  /** The start's random number: the runner proves it took this job's spec by writing it back. */
  nonce: string;
  handoff?: string;
  runnerPid?: number;
  startedAt: string;
  /** When the crew started: a report from then on is this run's. */
  crewStartedAt?: string;
  warnings?: string[];
}

/** Load right now: CPU busy share over a short sample and free disk where state lies. */
export interface Load {
  cpuPercent: number;
  freeDiskGb: number;
}

/** Everything one relay worker needs; the Windows parts only on native Windows. */
export interface RelayContext {
  owner: LauncherEnv;
  /** The lead of this request, from its key (src/relay-command.ts). */
  lead: string;
  ports: Ports;
  platform: () => WorkerPlatform;
  /** Hands the spec (it holds the token) to a new runner process for job `id`. */
  spawnRunner: (o: { id: string; spec: string; log: string }) => Promise<{ pid: number }>;
  load: () => Promise<Load>;
  /** The admin-only folder whose record of pairings this worker answers proofs for. */
  pairings?: string;
  /** This machine's SSH host key (`<type> <base64>`), for the proofs of a pairing. */
  hostKey?: () => string | undefined;
  /** Native Windows: the crew sandbox in relay mode (src/relay-windows.ts, through the CLI). */
  windows?: RelayWindows;
  log?: (line: string) => void;
}

/** The Windows crew sandbox as a relay worker uses it. */
export interface RelayWindows {
  /**
   * Every check before a start, the probe as the crew user included. `held`: not now; `refused`:
   * not on this machine until the owner fixed it. Warnings go to doctor.
   */
  check(o: {
    deny: EnforcedDeny;
    hosts: readonly string[];
  }): Promise<{ problem?: { kind: 'held' | 'refused'; line: string }; warnings: string[] }>;
  /** What a launch needs, with the proxy up; `close` ends the proxy. */
  launch(networkAllow: readonly string[]): Promise<{
    claude: Ports['claude'];
    launch: WindowsLaunch;
    close(): Promise<void>;
  }>;
  /** Stopping a crew: the keeper ends, the grants go (through the broker). */
  claude(): Ports['claude'];
  /** Ends every process of the crew users, through the broker; refuses when any is left. */
  sweep(): Promise<void>;
  /**
   * After a job: its crew user's processes end, its places go back, and it is deleted with its
   * profile, through the broker.
   */
  retire(): Promise<void>;
}

const relayLock = (root: string, now: Date) =>
  acquireStateLock(root, RELAY_LOCK, { now, heartbeatStaleMs: RELAY_LOCK_STALE_MS });

async function withRelayLock<T>(c: RelayContext, fn: () => Promise<T> | T): Promise<T> {
  const root = ensureStateDir(relayRoot(c.owner), relayRoot(c.owner));
  for (let i = 0; i < 100; i++) {
    const lock = relayLock(root, c.ports.clock.now());
    if (lock) {
      try {
        return await fn();
      } finally {
        lock.release();
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new HeldError('another relay request is in progress on this machine; try again');
}

/** Which lead a request is for: its jobs, mirrors and projects are its own (`leads/<lead>`). */
export interface Where {
  owner: LauncherEnv;
  lead: string;
}

/** A lead's name: the label its key carries (`studio-relay-<lead>`), or `default`. */
export const LEAD_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Everything of one lead on this worker; another lead's requests never reach it. */
export function leadRoot(w: Where): string {
  if (!LEAD_RE.test(w.lead)) throw new Error('not a lead name');
  return join(relayRoot(w.owner), 'leads', w.lead);
}

const jobFile = (w: Where, id: string) => join(leadRoot(w), 'jobs', `${id}.json`);

export function readJob(w: Where, id: string): JobRecord | undefined {
  const root = relayRoot(w.owner);
  const f = jobFile(w, id);
  assertStatePath(root, f);
  if (!existsSync(f)) return undefined;
  if (!lstatSync(f).isFile()) throw new Error(`${f} is not a plain file`);
  const j = JSON.parse(readFileSync(f, 'utf8')) as JobRecord;
  // A job is only ever its own lead's.
  if (j.lead !== w.lead || j.id !== id) throw new Error(`${f} is not a job of this lead`);
  return j;
}

function writeJob(w: Where, job: JobRecord): void {
  if (job.lead !== w.lead) throw new Error('a job of another lead');
  const root = relayRoot(w.owner);
  ensureStateDir(root, join(leadRoot(w), 'jobs'));
  writeStateFile(root, jobFile(w, job.id), `${JSON.stringify(job, null, 2)}\n`);
}

/** The jobs of every lead: one crew at a time on this machine, whoever started it. */
function allJobs(owner: LauncherEnv): JobRecord[] {
  const leads = join(relayRoot(owner), 'leads');
  if (!existsSync(leads)) return [];
  return readdirSync(leads)
    .filter((l) => LEAD_RE.test(l))
    .flatMap((lead) => {
      const dir = join(leads, lead, 'jobs');
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => /^[A-Z]+-\d+\.json$/.test(f))
        .flatMap((f) => {
          try {
            const j = readJob({ owner, lead }, f.slice(0, -5));
            return j === undefined ? [] : [j];
          } catch {
            return [];
          }
        });
    });
}

const repoSlug = (repo: string): string => repo.replace('/', '--');
export const mirrorDir = (w: Where, repo: string): string =>
  join(leadRoot(w), 'mirrors', `${repoSlug(repo)}.git`);
export const projectDir = (w: Where, repo: string): string =>
  join(leadRoot(w), 'projects', repoSlug(repo));

/** The relay worker's own settings: `workers.serve`, or its defaults (nothing to write by hand). */
export function serveSettings(owner: LauncherEnv): RelayServe {
  return loadOwnerConfig(owner).workers?.serve ?? relayServeSchema.parse({});
}

/** The Claude config dir crews of this machine run with: plugins, never a login. */
function crewConfigDir(owner: LauncherEnv): string {
  const stored = crewClaudeDir(owner);
  if (existsSync(stored)) return stored;
  const env = owner.env ?? process.env;
  return env.CLAUDE_CONFIG_DIR || join(owner.homedir ?? homedir(), '.claude');
}

/**
 * A relay worker stores no credential at all: no GitHub token, no Claude account, no credential
 * provider. Each one found refuses, so a crew can never come near one.
 */
export function storedCredentialProblem(owner: LauncherEnv): string | undefined {
  const found: string[] = [];
  if (readCrewTokenFile(owner).kind !== 'absent')
    found.push('a crew token (studio secret set crew-token)');
  if (readWorkerTokenFile(owner).kind !== 'absent') found.push('a worker token');
  try {
    if (listAccounts(owner).length > 0) found.push('Claude accounts (studio account add)');
  } catch {
    found.push('an unreadable Claude accounts folder');
  }
  if (loadOwnerConfig(owner).crewCredentialCommand !== undefined) {
    found.push('crew_credential_command in the owner config');
  }
  return found.length === 0
    ? undefined
    : `a relay worker holds no credential, but this machine has ${found.join(', ')}: remove it; the lead sends each crew's credential`;
}

function loadProblem(load: Load | undefined, s: RelayServe): string | undefined {
  if (load === undefined) return 'the load of this machine cannot be read';
  if (load.cpuPercent > s.maxCpuPercent) {
    return `this machine is busy (CPU ${Math.round(load.cpuPercent)} %, limit ${s.maxCpuPercent} %)`;
  }
  if (load.freeDiskGb < s.minFreeDiskGb) {
    return `this machine is low on disk (${load.freeDiskGb.toFixed(1)} GB free, at least ${s.minFreeDiskGb} GB)`;
  }
  return undefined;
}

/** CPU busy share over `ms` of all cores, and free disk at `path`; a seam replaces it in tests. */
export async function systemLoad(path: string, ms = 1000): Promise<Load> {
  const sample = () =>
    cpus().reduce(
      (a, c) => {
        const t = c.times;
        const all = t.user + t.nice + t.sys + t.idle + t.irq;
        return { idle: a.idle + t.idle, all: a.all + all };
      },
      { idle: 0, all: 0 },
    );
  const a = sample();
  await new Promise((r) => setTimeout(r, ms));
  const b = sample();
  const all = b.all - a.all;
  const cpuPercent = all <= 0 ? 0 : (100 * (all - (b.idle - a.idle))) / all;
  const fs = statfsSync(path);
  return { cpuPercent, freeDiskGb: (fs.bavail * fs.bsize) / 1e9 };
}

type Problem = { kind: 'held' | 'refused'; line: string };

/**
 * What must hold before anything starts here, the same for `probe` and the runner: no stored
 * credential, a sandbox, a deny list the sandbox can hold, the load below its limits, and on native
 * Windows the crew sandbox's own checks and its probe as the crew user.
 */
async function readiness(
  c: RelayContext,
  o: {
    deny: { paths: string[]; ports: number[]; hosts?: string[] };
    networkAllow: readonly string[];
    keep: readonly string[];
  },
): Promise<{ problem?: Problem; deny?: EnforcedDeny; load?: Load; warnings: string[] }> {
  const warnings: string[] = [];
  const stored = storedCredentialProblem(c.owner);
  if (stored !== undefined) return { problem: { kind: 'refused', line: stored }, warnings };
  const settings = serveSettings(c.owner);
  const platform = c.platform();
  const native = platform.platform === 'win32';
  if (native && c.windows === undefined) {
    return {
      problem: {
        kind: 'refused',
        line: 'native Windows runs crews only in the Windows crew sandbox: run the script of studio relay setup, elevated',
      },
      warnings,
    };
  }
  if (!native) {
    const p = sandboxProblem(platform);
    if (p !== undefined) return { problem: { kind: 'refused', line: p }, warnings };
  }
  const deny = enforceDeny({
    deny: mergeDeny(o.deny, settings.deny),
    platform,
    networkAllow: o.networkAllow,
    keep: o.keep,
    allowRead: settings.allowRead,
  });
  if ('refused' in deny) return { problem: { kind: 'refused', line: deny.refused }, warnings };
  let load: Load | undefined;
  try {
    load = await c.load();
  } catch {
    load = undefined;
  }
  const busy = loadProblem(load, settings);
  if (busy !== undefined) {
    return { problem: { kind: 'held', line: busy }, deny, ...(load ? { load } : {}), warnings };
  }
  if (native && c.windows !== undefined) {
    const w = await c.windows.check({ deny, hosts: deny.hosts ?? [] });
    warnings.push(...w.warnings);
    if (w.problem !== undefined) {
      return { problem: w.problem, deny, ...(load ? { load } : {}), warnings };
    }
  }
  return { deny, ...(load ? { load } : {}), warnings };
}

/** The job that is starting or running, if any: one crew at a time on a relay worker. */
async function busyJob(c: RelayContext): Promise<JobRecord | undefined> {
  for (const j of allJobs(c.owner)) {
    const s = await liveState({ ...c, lead: j.lead }, j);
    if (s === 'starting' || s === 'running') return j;
  }
  return undefined;
}

/** A busy job as one lead may see it: its own by id, another lead's by nothing but that. */
const busyName = (c: Where, j: JobRecord): string =>
  j.lead === c.lead ? j.id : "another lead's job";

const pidAlive = (pid: number | undefined): boolean => {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Where a job stands now: a running job whose crew has ended is `ended`; a start whose runner died
 * before its crew started is refused.
 */
async function liveState(c: RelayContext, j: JobRecord): Promise<RelayState> {
  if (j.state === 'starting') {
    if (pidAlive(j.runnerPid)) return 'starting';
    // A start that has not recorded its runner yet is still starting, for a while.
    const age = c.ports.clock.now().getTime() - Date.parse(j.startedAt);
    if (j.runnerPid === undefined && age < HANDOFF_MS * 2) return 'starting';
    const after = readJob(c, j.id);
    if (after !== undefined && after.state !== 'starting') return liveState(c, after);
    writeJob(c, { ...j, state: 'refused', line: 'the runner ended before its crew started' });
    return 'refused';
  }
  if (j.state !== 'running') return j.state;
  const stateRoot = stateRootFor(projectDir(c, j.repo), c.owner);
  const rec = readCrewRecords(stateRoot)[j.id];
  const hold = rec === undefined ? undefined : await crewHold(rec, crewPorts(c));
  if (hold === 'running' || hold === 'unverified') return 'running';
  writeJob(c, { ...j, state: 'ended' });
  return 'ended';
}

/** The ports a crew record is judged with: on Windows the record is the keeper's. */
const crewPorts = (c: RelayContext): Ports =>
  c.windows === undefined ? c.ports : { ...c.ports, claude: c.windows.claude() };

const git = (c: RelayContext, cwd: string, args: string[], timeoutMs = 600_000) =>
  c.ports.git.run(cwd, args, { timeoutMs });

/**
 * Takes the lead's bundle into the mirror of the repository: exactly `main` at the pinned commit,
 * and `studio/<id>` at its head for a fix round; nothing else may be in it. Then the project
 * checkout fetches from the mirror. Objects are checked as they come in.
 */
async function takeBundle(c: RelayContext, job: RelayJob, bundle: Buffer): Promise<string> {
  const root = relayRoot(c.owner);
  const inbox = ensureStateDir(root, join(root, 'in'));
  const file = join(inbox, `${job.id}.bundle`);
  writeStateFile(root, file, '');
  writeFileSync(file, bundle);
  try {
    const mirror = mirrorDir(c, job.repo);
    if (!existsSync(join(mirror, 'HEAD'))) {
      ensureStateDir(root, dirname(mirror));
      removeStateEntry(root, mirror);
      await git(c, dirname(mirror), ['init', '-q', '--bare', '--template=', mirror]);
    }
    const heads = (await git(c, mirror, ['bundle', 'list-heads', file]))
      .split('\n')
      .filter((l) => l.trim() !== '');
    const want = new Map<string, string>([['refs/heads/main', job.sha]]);
    if (job.from !== 'main') {
      if (job.fromSha === undefined) throw new Error('a start from studio/<id> names no head');
      want.set(`refs/heads/studio/${job.id}`, job.fromSha);
    }
    if (heads.length !== want.size)
      throw new Error('the bundle holds other refs than the job names');
    for (const l of heads) {
      const [sha, ref] = l.trim().split(/\s+/);
      if (ref === undefined || want.get(ref) !== sha) {
        throw new Error('the bundle holds other refs than the job names');
      }
    }
    const refspecs = [...want.keys()].map((r) => `+${r}:${r}`);
    await git(c, mirror, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', file, ...refspecs]);
    if (job.from === 'main') {
      await git(c, mirror, ['update-ref', '-d', `refs/heads/studio/${job.id}`]).catch(() => '');
    }
    const project = projectDir(c, job.repo);
    const url = pathToFileURL(mirror).href;
    if (!existsSync(join(project, '.git'))) {
      ensureStateDir(root, dirname(project));
      removeStateEntry(root, project);
      await git(c, dirname(project), ['clone', '-q', '--no-checkout', url, project]);
    } else {
      await git(c, project, [
        'fetch',
        '-q',
        '--prune',
        'origin',
        '+refs/heads/*:refs/remotes/origin/*',
      ]);
    }
    const got = (
      await git(c, project, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])
    ).trim();
    if (got !== job.sha) throw new Error('the project checkout is not at the pinned commit');
    return project;
  } finally {
    removeStateEntry(root, file);
  }
}

/** The item and studio.yaml of a job, read from the pinned commit as a GitHub worker reads them. */
async function jobInputs(
  c: RelayContext,
  job: Pick<RelayJob, 'id' | 'label' | 'repo' | 'sha' | 'item'>,
) {
  const project = projectDir(c, job.repo);
  const text = await git(c, project, [
    '--no-replace-objects',
    'show',
    `${job.sha}:.studio/studio.yaml`,
  ]);
  const config = parseConfig(text, 'origin/main:.studio/studio.yaml');
  if (config.primaryRepo !== job.repo) {
    throw new Error(`the pinned studio.yaml names ${config.primaryRepo}, not ${job.repo}`);
  }
  const item = workerItemOf(job.item, job.label);
  if (item === undefined || item.id !== job.id)
    throw new Error('the job carries no item a worker may run');
  if (item.repo !== config.primaryRepo && !config.repos.includes(item.repo)) {
    throw new Error(`repo ${item.repo} is not configured in the pinned studio.yaml`);
  }
  return { project, config, item };
}

type Out = (line: string) => void;

const fail = (out: Out, kind: 'held' | 'refused' | 'error', line: string) => {
  for (const l of encodeMessage({
    studioRelay: RELAY_PROTOCOL,
    ok: false,
    kind,
    line: line.slice(0, 300) || 'failed',
  })) {
    out(l);
  }
};
const answer = (out: Out, header: object, payload?: Uint8Array) => {
  for (const l of encodeMessage({ studioRelay: RELAY_PROTOCOL, ok: true, ...header }, payload))
    out(l);
};

/**
 * `studio relay serve`: one request in, one answer out. The request is read with a cap per line and
 * on the payload; anything that does not parse is answered with an error and nothing else happens.
 * Errors carry Studio's own lines; the token of a start is never part of any of them.
 */
export async function serveRelay(
  c: RelayContext,
  input: AsyncIterable<Uint8Array | string>,
  out: Out,
): Promise<void> {
  let request: ReturnType<typeof parseRequest>;
  let payload: Buffer | undefined;
  try {
    const msg = await readMessage(
      new LineReader(input, MAX_HEADER_BYTES + 1024),
      MAX_START_BUNDLE_BYTES,
    );
    if (msg === undefined) return fail(out, 'error', 'no request');
    request = parseRequest(msg.header);
    payload = msg.payload;
  } catch (e) {
    return fail(out, 'error', (e as Error).message);
  }
  try {
    switch (request.op) {
      case 'hello': {
        const busy = await busyJob(c);
        const have = installedVersions(crewConfigDir(c.owner));
        const stored = storedCredentialProblem(c.owner);
        let load: Load | undefined;
        try {
          load = await c.load();
        } catch {
          load = undefined;
        }
        const held =
          busy !== undefined
            ? `this machine runs ${busyName(c, busy)}: one crew at a time on a relay worker`
            : loadProblem(load, serveSettings(c.owner));
        return answer(out, {
          studio: STUDIO_VERSION,
          platform: c.platform().platform,
          plugins: have === undefined ? null : Object.fromEntries(have),
          busy: busy !== undefined && busy.lead === c.lead ? busy.id : null,
          held: held ?? null,
          pairProofs:
            c.pairings === undefined
              ? []
              : pairProofs(readPairings(c.pairings), c.hostKey?.(), c.ports.clock.now())
                  // A lead learns only its own pairing's proof, never another's.
                  .filter((p) => p.label === c.lead || c.lead === 'default')
                  .slice(0, 20),
          warnings: stored === undefined ? [] : [stored],
        });
      }
      case 'probe': {
        const r = await readiness(c, {
          deny: { paths: [], ports: [] },
          networkAllow: [],
          keep: [relayRoot(c.owner), ...loadOwnerConfig(c.owner).crewToolchainPaths],
        });
        return answer(out, {
          problem: r.problem?.line ?? null,
          kind: r.problem?.kind ?? null,
          load: r.load ?? null,
          warnings: r.warnings,
        });
      }
      case 'start':
        return await start(c, request.job, payload as Buffer, out);
      case 'status': {
        const j = readJob(c, request.id);
        if (j === undefined) return answer(out, { state: 'unknown', line: null });
        const state = await liveState(c, j);
        const now = readJob(c, request.id) ?? j;
        return answer(out, { state, line: now.line ?? null });
      }
      case 'collect':
        return await collect(c, request.id, out);
      case 'stop':
        await stop(c, request.id);
        return answer(out, {});
      case 'cleanup':
        await cleanup(c, request.id);
        return answer(out, {});
    }
  } catch (e) {
    return fail(out, e instanceof HeldError ? 'held' : 'error', (e as Error).message);
  }
}

async function start(c: RelayContext, job: RelayJob, bundle: Buffer, out: Out): Promise<void> {
  const nonce = randomBytes(16).toString('hex');
  const prepared = await withRelayLock(c, async () => {
    const busy = await busyJob(c);
    if (busy !== undefined) {
      throw new HeldError(
        `this machine runs ${busyName(c, busy)}: one crew at a time on a relay worker`,
      );
    }
    const stored = storedCredentialProblem(c.owner);
    if (stored !== undefined) return { refused: stored };
    const project = await takeBundle(c, job, bundle);
    const { config } = await jobInputs(c, job);
    const ownerConfig = loadOwnerConfig(c.owner);
    const pins = strictPinProblem(
      crewConfigDir(c.owner),
      pinnedPlugins(config.plugins, ownerConfig.allowedPlugins),
    );
    if (pins !== undefined) return { refused: pins };
    const record: JobRecord = {
      lead: c.lead,
      id: job.id,
      label: job.label,
      repo: job.repo,
      sha: job.sha,
      from: job.from,
      ...(job.fromSha === undefined ? {} : { fromSha: job.fromSha }),
      item: job.item,
      state: 'starting',
      nonce,
      startedAt: c.ports.clock.now().toISOString(),
    };
    writeJob(c, record);
    return { project, record };
  });
  if ('refused' in prepared) return fail(out, 'refused', prepared.refused as string);
  const root = relayRoot(c.owner);
  const log = join(ensureStateDir(root, join(root, 'logs')), `${job.id}.runner.log`);
  // The spec goes to the runner over its stdin (or a pipe on Windows), never to a file.
  const spec = JSON.stringify({ nonce, job });
  const { pid } = await c.spawnRunner({ id: job.id, spec, log });
  writeJob(c, { ...(readJob(c, job.id) as JobRecord), runnerPid: pid });
  const until = c.ports.clock.now().getTime() + HANDOFF_MS;
  for (;;) {
    const j = readJob(c, job.id);
    if (j?.handoff === nonce || (j !== undefined && j.state !== 'starting')) {
      if (j.state === 'held' || j.state === 'refused') {
        return fail(out, j.state, j.line ?? 'not started');
      }
      return answer(out, { state: 'starting' });
    }
    if (c.ports.clock.now().getTime() >= until || !pidAlive(pid)) {
      if (j !== undefined)
        writeJob(c, { ...j, state: 'refused', line: 'the runner did not take the job' });
      return fail(out, 'refused', 'the runner did not take the job');
    }
    await c.ports.clock.sleep(250);
  }
}

/**
 * `studio relay run <id>`: the runner of one job. It takes its spec (with the token) from the
 * start, probes, launches the crew and, on Windows, holds the proxy until the crew ends. The token
 * lives in this process only and reaches the crew's environment through the launch.
 */
export async function runRelayJob(
  c: RelayContext,
  id: string,
  specText: string,
): Promise<RelayState> {
  let spec: { nonce: string; job: RelayJob };
  try {
    spec = JSON.parse(specText) as typeof spec;
  } catch {
    throw new Error('the runner got no spec');
  }
  const job = spec.job;
  const rec = readJob(c, id);
  if (rec === undefined || job?.id !== id || rec.nonce !== spec.nonce || rec.state !== 'starting') {
    throw new Error('the runner got a spec for no starting job');
  }
  writeJob(c, { ...rec, handoff: spec.nonce, runnerPid: process.pid });
  const settle = (state: RelayState, line?: string, extra: Partial<JobRecord> = {}) => {
    const now = readJob(c, id) ?? rec;
    writeJob(c, { ...now, ...extra, state, ...(line === undefined ? {} : { line }) });
    return state;
  };
  let windows: Awaited<ReturnType<RelayWindows['launch']>> | undefined;
  try {
    const { project, config, item } = await jobInputs(c, job);
    const stateRoot = stateRootFor(project, c.owner);
    // Binds the project's state root to its checkout and mirror before anything is written there.
    const url = (await git(c, project, ['remote', 'get-url', 'origin'])).trim();
    checkStateMarker(stateRoot, { projectRealpath: projectRealpath(project), originUrl: url });
    const ownerConfig = loadOwnerConfig(c.owner);
    const ready = await readiness(c, {
      deny: config.workers?.[job.label]?.deny ?? { paths: [], ports: [] },
      networkAllow: config.sandbox.networkAllow,
      keep: [
        project,
        stateRoot,
        relayRoot(c.owner),
        stateBaseFor(c.owner),
        ...ownerConfig.crewToolchainPaths,
      ],
    });
    if (ready.warnings.length > 0)
      writeJob(c, { ...(readJob(c, id) ?? rec), warnings: ready.warnings });
    if (ready.problem !== undefined) return settle(ready.problem.kind, ready.problem.line);
    const contentDir = await pinnedContent({ project, ports: c.ports }, stateRoot, job.sha);
    if (c.windows !== undefined && c.platform().platform === 'win32') {
      windows = await c.windows.launch(config.sandbox.networkAllow);
    }
    const env: Record<string, string | undefined> = {
      ...(c.owner.env ?? process.env),
      CLAUDE_CODE_OAUTH_TOKEN: job.token,
    };
    const configDir = crewClaudeDir(c.owner);
    if (existsSync(configDir)) env.CLAUDE_CONFIG_DIR = configDir;
    const ports = windows === undefined ? c.ports : { ...c.ports, claude: windows.claude };
    await launchCrew(
      project,
      item as WorkItem,
      config,
      ports,
      { ...c.owner, env },
      {
        deny: ready.deny as EnforcedDeny,
        ...(windows === undefined ? {} : { windows: windows.launch }),
        from: job.from,
        contentDir,
        sha: job.sha,
        noToken: true,
      },
    );
    settle('running', undefined, { crewStartedAt: c.ports.clock.now().toISOString() });
    if (windows === undefined) return 'running';
    // The proxy lives in this process: it stays until the crew has ended.
    const crewRec = () => readCrewRecords(stateRoot)[id];
    for (;;) {
      const r = crewRec();
      const hold = r === undefined ? undefined : await crewHold(r, ports);
      if (hold !== 'running' && hold !== 'unverified') break;
      if (readJob(c, id)?.state === 'stopped') break;
      await c.ports.clock.sleep(15_000);
    }
    const after = readJob(c, id);
    // The crew user of this job is done with: the next job gets a fresh one.
    try {
      await c.windows?.retire();
    } catch (e) {
      c.log?.(`${id}: the crew user is not deleted yet: ${(e as Error).message}`);
    }
    return after?.state === 'stopped' ? 'stopped' : settle('ended');
  } catch (e) {
    const line = (e as Error).message;
    c.log?.(`${id}: ${line}`);
    return settle(e instanceof HeldError ? 'held' : 'refused', line);
  } finally {
    await windows?.close();
  }
}

const opensPr = (item: WorkItem): boolean => item.type !== 'research' && item.type !== 'review';

async function collect(c: RelayContext, id: string, out: Out): Promise<void> {
  const j = readJob(c, id);
  if (j === undefined) return fail(out, 'refused', `no job ${id} on this machine`);
  const state = await liveState(c, j);
  if (state !== 'ended') return fail(out, 'held', `${id} is ${state}, nothing to collect yet`);
  const project = projectDir(c, j.repo);
  const stateRoot = stateRootFor(project, c.owner);
  const crew = readCrewRecords(stateRoot)[id];
  const from = typeof crew?.logStart === 'number' && crew.logStart >= 0 ? crew.logStart : 0;
  const usage = crew === undefined ? undefined : runUsageSince(stateRoot, id, from);
  const limit = crew === undefined ? undefined : scanLogForLimit(stateRoot, id, from);
  const block = crew === undefined ? undefined : scanLogForBlock(stateRoot, id, from);
  const base: Omit<CollectAnswer, 'studioRelay' | 'ok' | 'report' | 'headSha' | 'payload'> = {
    usage:
      usage === undefined || usage.runs === 0
        ? null
        : {
            runs: usage.runs,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            tokensCache: usage.tokensCache,
            costUsd: Math.round(usage.costUsd * 1e6) / 1e6,
            ...(usage.estimated ? { estimated: true as const } : {}),
          },
    limit: limit === undefined ? null : { kind: limit.kind, resetsAt: limit.resetsAt ?? null },
    block: block !== undefined,
    problem: null,
  };
  const item = workerItemOf(j.item, j.label) as WorkItem;
  let text: string;
  try {
    const fileName = reportName(stateRoot, id);
    if (fileName === undefined || crew === undefined)
      throw new Error('no report name was drawn for this run');
    text = readReportText(join(stateRoot, 'clones', id), id, {
      notBefore: new Date(crew.startedAt),
      fileName,
    });
  } catch {
    return answer(out, {
      ...base,
      report: '',
      headSha: null,
      payload: false,
      problem: 'the crew left no report',
    });
  }
  let report: ReturnType<typeof parseReport> | undefined;
  try {
    report = parseReport(text, item);
  } catch {
    report = undefined;
  }
  // The lead parses the report itself; the worker only finds what it must hand back with it.
  if (report?.status !== 'done' || !opensPr(item) || report.headSha === undefined) {
    return answer(out, { ...base, report: text, headSha: null, payload: false });
  }
  const head = report.headSha.toLowerCase();
  const root = relayRoot(c.owner);
  const dir = join(ensureStateDir(root, join(leadRoot(c), 'out')), id);
  removeStateEntry(root, dir);
  const branch = `refs/heads/studio/${id}`;
  try {
    await git(c, dirname(dir), ['init', '-q', '--bare', '--template=', dir]);
    // Objects of the pinned main come from the mirror; only the crew's new ones land here.
    const mirrorObjects = join(mirrorDir(c, j.repo), 'objects');
    writeStateFile(root, join(dir, 'objects', 'info', 'alternates'), `${mirrorObjects}\n`);
    // Git never runs inside the crew's clone (rule D4), not even as a remote: its objects and the
    // head of its branch are copied as plain files, checked one by one, and git runs here only.
    // Nothing of the crew may run while its clone is read: on Windows the broker proves it right
    // before; a sweep that cannot, or leaves anything, holds the collect for the next tick.
    if (c.windows !== undefined) {
      try {
        await c.windows.sweep();
      } catch (e) {
        return fail(
          out,
          'held',
          `the crew user's processes are not proven gone: ${(e as Error).message}`,
        );
      }
    }
    let crewHead: string;
    try {
      crewHead = copyCrewObjects(join(stateRoot, 'clones', id), dir, id, root);
    } catch (e) {
      return answer(out, {
        ...base,
        report: text,
        headSha: null,
        payload: false,
        problem: `the crew's clone cannot be read safely: ${(e as Error).message}`,
      });
    }
    const hooks = ['-c', `core.hooksPath=${join(dir, 'no-hooks')}`, '--no-replace-objects'];
    // Every pack gets its index built here from its own bytes (`index-pack --strict`), and the
    // whole repository is checked (`fsck --strict`) before anything is bundled from it.
    const problem = await indexAndCheck(c, dir, hooks);
    if (problem !== undefined) {
      return answer(out, {
        ...base,
        report: text,
        headSha: null,
        payload: false,
        problem: `the crew's objects do not check out: ${problem}`,
      });
    }
    await git(c, dir, [...hooks, 'update-ref', branch, crewHead]);
    const got = (
      await git(c, dir, [...hooks, 'rev-parse', '--verify', `${branch}^{commit}`])
    ).trim();
    if (got !== head) {
      return answer(out, {
        ...base,
        report: text,
        headSha: null,
        payload: false,
        problem: 'the branch in the clone differs from the report',
      });
    }
    const file = join(dir, 'result.bundle');
    const negative = [`^${j.sha}`, ...(j.fromSha === undefined ? [] : [`^${j.fromSha}`])];
    try {
      await git(c, dir, [...hooks, 'bundle', 'create', '-q', file, branch, ...negative]);
    } catch {
      return answer(out, {
        ...base,
        report: text,
        headSha: null,
        payload: false,
        problem: 'the crew committed nothing on top of the pinned commit',
      });
    }
    const bytes = readFileSync(file);
    if (bytes.length > MAX_RESULT_BUNDLE_BYTES) {
      return answer(out, {
        ...base,
        report: text,
        headSha: null,
        payload: false,
        problem: 'the branch is larger than a relay result may be',
      });
    }
    return answer(out, { ...base, report: text, headSha: head, payload: true }, bytes);
  } finally {
    removeStateEntry(root, dir);
  }
}

async function stop(c: RelayContext, id: string): Promise<void> {
  const j = readJob(c, id);
  if (j === undefined) return;
  const project = projectDir(c, j.repo);
  const stateRoot = stateRootFor(project, c.owner);
  writeJob(c, { ...j, state: 'stopped', line: 'stopped by the lead' });
  const rec = readCrewRecords(stateRoot)[id];
  const ports = crewPorts(c);
  if (rec !== undefined && (await crewHold(rec, ports)) === 'running') {
    await ports.claude.stop(rec.pid);
  }
}

async function cleanup(c: RelayContext, id: string): Promise<void> {
  const j = readJob(c, id);
  if (j === undefined) return;
  const s = await liveState(c, j);
  if (s === 'starting' || s === 'running') {
    throw new HeldError(`${id} is ${s}: stop it before it is cleaned up`);
  }
  const project = projectDir(c, j.repo);
  const stateRoot = stateRootFor(project, c.owner);
  for (const sub of ['clones', 'homes', 'tmp'])
    removeStateEntry(stateRoot, join(stateRoot, sub, id));
  const root = relayRoot(c.owner);
  removeStateEntry(root, jobFile(c, id));
}

/** The bin of this Studio: a runner is started from it. */
export const STUDIO_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'studio');

/**
 * The PowerShell that hands a spec to a new Windows runner, run as a child of `relay serve` with
 * the spec on its stdin (an anonymous pipe only that child holds). It creates a named pipe whose
 * DACL allows the relay account alone (nobody else, the crew user included, may even open it),
 * creates the runner through CIM (`Win32_Process.Create`, outside sshd's job object for the
 * session), waits for the pipe's client and writes the spec only when that client is the runner it
 * created (GetNamedPipeClientProcessId), as the keeper does for the crew host. It prints the
 * runner's pid; any other client, or none, fails and nothing is written.
 */
export function relayHandoffScript(o: {
  node: string;
  bin: string;
  id: string;
  home: string | undefined;
  lead: string;
}): string {
  if (!/^[A-Z]+-\d+$/.test(o.id)) throw new Error('not an item id');
  if (!LEAD_RE.test(o.lead)) throw new Error('not a lead name');
  const q = (s: string) => {
    if (/[\p{Cc}"]/u.test(s)) throw new Error(`refusing ${JSON.stringify(s)} in a command line`);
    return `'${s.replace(/'/g, "''")}'`;
  };
  const home = o.home === undefined ? "''" : `' --home "' + ${q(o.home)} + '"'`;
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StudioRelayPipe {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
  public static uint ClientPid(IntPtr pipe) {
    uint pid;
    if (!GetNamedPipeClientProcessId(pipe, out pid)) throw new Win32Exception();
    return pid;
  }
}
'@
$spec = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
# Only the relay account may open the pipe; the runner runs as that account.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = New-Object System.IO.Pipes.PipeSecurity
$security.SetAccessRuleProtection($true, $false)
$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, 'FullControl', 'Allow')))
$name = 'studio-relay-' + [Guid]::NewGuid().ToString('N')
$pipe = New-Object System.IO.Pipes.NamedPipeServerStream($name, 'Out', 1, 'Byte', 'Asynchronous', 0, 65536, $security)
try {
  $cmd = '"' + ${q(o.node)} + '" "' + ${q(o.bin)} + '" relay run ${o.id} --lead ${o.lead} --pipe ' + $name + ${home}
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
  if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
  $runner = [uint32]$r.ProcessId
  $wait = $pipe.BeginWaitForConnection($null, $null)
  if (-not $wait.AsyncWaitHandle.WaitOne(60000)) { throw 'the runner did not connect' }
  $pipe.EndWaitForConnection($wait)
  if ([StudioRelayPipe]::ClientPid($pipe.SafePipeHandle.DangerousGetHandle()) -ne $runner) {
    throw 'a process other than the runner connected'
  }
  $pipe.Write($spec, 0, $spec.Length)
  $pipe.Flush()
  $pipe.WaitForPipeDrain()
  [Console]::Out.Write($runner)
} finally {
  $spec = $null
  $pipe.Dispose()
}
`;
}

/** Starts a process with `stdin` on its standard input; a seam for tests. */
export type SpawnWithInput = (
  file: string,
  args: string[],
  stdin: string,
) => Promise<{ code: number; stdout: string }>;

const spawnWithInput: SpawnWithInput = (file, args, stdin) =>
  new Promise((res) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', () => res({ code: 1, stdout: '' }));
    child.on('close', (code) => res({ code: code ?? 1, stdout }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });

/**
 * Starts a runner that outlives the SSH session; the spec, with the token, reaches it only through
 * handles no other process can open. POSIX: a new session (detached) with the spec on its stdin.
 * Native Windows: sshd ends every process of a session's job object with the session, so the runner
 * is created through CIM, and a PowerShell child of this process (spec on its stdin) hands the spec
 * over a named pipe that only the relay account may open and only to that runner's pid
 * (`relayHandoffScript`). This process listens on nothing.
 */
export function systemSpawnRunner(o: {
  home: string | undefined;
  platform: NodeJS.Platform;
  spawn?: SpawnWithInput;
  /** The Studio to run; this one by default. */
  bin?: string;
  /** The lead the runner works for. */
  lead: string;
}): RelayContext['spawnRunner'] {
  const bin = o.bin ?? STUDIO_BIN;
  if (!LEAD_RE.test(o.lead)) throw new Error('not a lead name');
  const homeArgs = [...(o.home === undefined ? [] : ['--home', o.home]), '--lead', o.lead];
  if (o.platform !== 'win32') {
    return async ({ id, spec, log }) => {
      const fd = openSync(log, 'a');
      try {
        const child = spawn(process.execPath, [bin, 'relay', 'run', id, ...homeArgs], {
          detached: true,
          stdio: ['pipe', fd, fd],
          env: process.env,
        });
        const pid = await new Promise<number>((res, rej) => {
          child.once('error', rej);
          child.once('spawn', () => res(child.pid as number));
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(spec);
        child.unref();
        return { pid };
      } finally {
        closeSync(fd);
      }
    };
  }
  return async ({ id, spec }) => {
    const script = relayHandoffScript({
      node: process.execPath,
      bin,
      id,
      home: o.home,
      lead: o.lead,
    });
    const r = await (o.spawn ?? spawnWithInput)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      spec,
    );
    const pid = Number(r.stdout.trim());
    if (r.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
      throw new Error('cannot hand the job to a relay runner');
    }
    return { pid };
  };
}

/** The runner's side of the Windows hand-over: the spec from the named pipe `name`. */
export async function readSpecFromPipe(name: string): Promise<string> {
  if (!/^studio-relay-[0-9a-f]{32}$/.test(name)) throw new Error('not a relay pipe name');
  const { connect } = await import('node:net');
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    const s = connect(`\\\\.\\pipe\\${name}`);
    s.setTimeout(HANDOFF_MS, () => {
      s.destroy();
      rej(new Error('no spec came'));
    });
    s.on('data', (d) => chunks.push(Buffer.from(d)));
    s.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    s.on('error', rej);
  });
}

/** What a crew's objects may total: a clone that grew past this is not taken. */
const MAX_CREW_OBJECTS_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Copies the objects of a crew's clone into the fresh repository `dest` and returns the head of its
 * `studio/<id>`, read as files: `.git` must be a real folder (no link, no gitdir file), with no
 * alternates of its own; only plain files with the names git gives loose objects and packs are
 * copied, never a link; the head comes from the branch's ref file or packed-refs.
 */
export function copyCrewObjects(clone: string, dest: string, id: string, root: string): string {
  const gitDir = join(clone, '.git');
  const st = lstatSync(gitDir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('.git is not a plain folder');
  const objects = join(gitDir, 'objects');
  const ost = lstatSync(objects);
  if (ost.isSymbolicLink() || !ost.isDirectory())
    throw new Error('.git/objects is not a plain folder');
  for (const f of ['alternates', 'http-alternates']) {
    if (existsSync(join(objects, 'info', f))) throw new Error(`the clone has objects/info/${f}`);
  }
  let total = 0;
  // Each file is opened once, never through a link (O_NOFOLLOW where the system has it), checked
  // on what was opened, and copied from that very handle.
  const copy = (from: string, to: string) => {
    const before = lstatSync(from);
    if (before.isSymbolicLink()) throw new Error('a link among the objects');
    if (!before.isFile()) return;
    const fd = openSync(from, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) {
        throw new Error('an object changed while it was read');
      }
      total += st.size;
      if (total > MAX_CREW_OBJECTS_BYTES) throw new Error('the objects are larger than allowed');
      ensureStateDir(root, dirname(to));
      const out = openSync(to, 'wx', 0o600);
      try {
        const buf = Buffer.alloc(1 << 20);
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, null);
          if (n <= 0) break;
          writeSync(out, buf, 0, n);
        }
      } finally {
        closeSync(out);
      }
    } finally {
      closeSync(fd);
    }
  };
  for (const name of readdirSync(objects)) {
    const sub = join(objects, name);
    if (/^[0-9a-f]{2}$/.test(name)) {
      const sst = lstatSync(sub);
      if (sst.isSymbolicLink() || !sst.isDirectory()) throw new Error('a link among the objects');
      for (const o of readdirSync(sub)) {
        if (/^[0-9a-f]{38}$/.test(o)) copy(join(sub, o), join(dest, 'objects', name, o));
      }
    } else if (name === 'pack') {
      const pst = lstatSync(sub);
      if (pst.isSymbolicLink() || !pst.isDirectory()) throw new Error('a link among the objects');
      for (const o of readdirSync(sub)) {
        // Packs only: their index is built anew here, never taken from the crew.
        if (/^pack-[0-9a-f]{40,64}\.pack$/.test(o))
          copy(join(sub, o), join(dest, 'objects', 'pack', o));
      }
    }
  }
  const sha = /^[0-9a-f]{40}$/;
  const refFile = join(gitDir, 'refs', 'heads', 'studio', id);
  if (existsSync(refFile)) {
    const rst = lstatSync(refFile);
    if (rst.isSymbolicLink() || !rst.isFile())
      throw new Error('the branch ref is not a plain file');
    const v = readFileSync(refFile, 'utf8').trim();
    if (!sha.test(v)) throw new Error('the branch ref holds no commit');
    return v;
  }
  const packed = join(gitDir, 'packed-refs');
  if (existsSync(packed) && lstatSync(packed).isFile()) {
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [v, ref] = line.trim().split(' ');
      if (ref === `refs/heads/studio/${id}` && v !== undefined && sha.test(v)) return v;
    }
  }
  throw new Error(`the clone has no branch studio/${id}`);
}

/**
 * Builds the index of every pack copied from a crew's clone with `git index-pack --strict` (packs
 * that lean on each other are tried again until none more succeeds), then checks the repository's
 * own objects with `git fsck --strict`. Returns why it failed, or undefined.
 */
async function indexAndCheck(
  c: RelayContext,
  dir: string,
  hooks: readonly string[],
): Promise<string | undefined> {
  const packDir = join(dir, 'objects', 'pack');
  let todo = existsSync(packDir)
    ? readdirSync(packDir).filter((f) => /^pack-[0-9a-f]{40,64}\.pack$/.test(f))
    : [];
  while (todo.length > 0) {
    const failed: string[] = [];
    for (const f of todo) {
      try {
        await git(c, dir, [...hooks, 'index-pack', '--strict', join(packDir, f)]);
      } catch {
        failed.push(f);
      }
    }
    if (failed.length === todo.length) return `a pack does not index (${failed[0]})`;
    todo = failed;
  }
  try {
    await git(c, dir, [
      ...hooks,
      'fsck',
      '--strict',
      '--no-full',
      '--no-dangling',
      '--no-progress',
    ]);
  } catch {
    return 'git fsck --strict found a broken object';
  }
  return undefined;
}
