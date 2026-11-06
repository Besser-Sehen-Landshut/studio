// The CLI's side of relay workers (src/relay-lead.ts, src/relay-serve.ts): on the lead, starting a
// planned item on its relay worker and following it each tick; on the worker, `studio relay serve`,
// `relay run` and `relay setup`. Kept out of src/cli.ts, which only calls in here.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { crewClaudeDir } from './accounts.js';
import { type Board, loadBoard, saveBoard, transition, type WorkItem } from './board.js';
import {
  loadOwnerConfig,
  type OwnerConfig,
  type OwnerEnv,
  ownerConfigDir,
  RELAY_HOST_RE,
  type RelayTarget,
  relayTargetSchema,
  type StudioConfig,
  WORKER_LABEL_RE,
} from './config.js';
import { type RunUsage, recordLedgerRun, withItemUsage } from './costs.js';
import { pickCrewCredential } from './crew.js';
import { startEgressProxy } from './egress-proxy.js';
import { HeldError } from './held.js';
import { activeParks, blockHold, parkUntil, readLimits, writeLimits } from './limits.js';
import { ensureStateDir, ownerStateRootFor, removeStateEntry, withBoardLock } from './paths.js';
import { pinnedPlugins, STUDIO_VERSION } from './plugins.js';
import type { Ports } from './ports.js';
import {
  collectRelay,
  followRelay,
  type RelayRecord,
  readRelay,
  relayDoctor,
  relayLine,
  relayReportFile,
  relayTarget,
  sendStart,
  startBundle,
  stopRelay,
  updateRelay,
} from './relay-lead.js';
import {
  authorizedKeysPlan,
  dropPending,
  keyFingerprint,
  keyscanKey,
  leadKeyFile,
  newPairSecret,
  type PairLine,
  parsePairLine,
  proofHolds,
  readPairings,
  readPending,
  renderPairLine,
  writePairings,
  writePending,
  writeRelayTarget,
} from './relay-pair.js';
import { encodeMessage, RELAY_PROTOCOL } from './relay-protocol.js';
import {
  LEAD_RE,
  type RelayContext,
  readSpecFromPipe,
  relayRoot,
  runRelayJob,
  STUDIO_BIN,
  serveRelay,
  serveSettings,
  systemLoad,
  systemSpawnRunner,
} from './relay-serve.js';
import {
  type RelayTransport,
  RelayUnreachable,
  relayCall,
  sshTransport,
} from './relay-transport.js';
import {
  authorizedKeysFile,
  authorizedKeysScript,
  forcedCommand,
  leadFromAuthInfo,
  machineConfig,
  type RelayInstall,
  relayHomeDefault,
  relayMachineDefault,
  relaySetupScript,
  type SshdScope,
} from './relay-windows.js';
import { elevated, machineTreeProblem, relayWindows } from './relay-windows-check.js';
import { labelUsage, recordRun, USAGE_UNREADABLE } from './usage.js';
import { findClaude, runFile } from './windows-sandbox.js';
import { pinnedMain } from './worker.js';
import { detectPlatform, type WorkerPlatform } from './worker-deny.js';
import { updateWorkers, workerCrewName } from './worker-lead.js';

const BY = 'studio';
/** How long a worker's report of an account block parks the handed-over label. */
const RELAY_PARK_MS = 60 * 60_000;
/** The longest a worker's report of a usage limit parks the handed-over label. */
const RELAY_PARK_MAX_MS = 6 * 60 * 60_000;

const withItem = (board: Board, id: string, fn: (i: WorkItem) => WorkItem): Board => ({
  ...board,
  items: board.items.map((i) => (i.id === id ? fn(i) : i)),
});
const itemOf = (board: Board, id: string): WorkItem => {
  const i = board.items.find((x) => x.id === id);
  if (i === undefined) throw new Error(`unknown item ${id}`);
  return i;
};

/** What the lead's relay steps need of the CLI. */
export interface RelayLead {
  project: string;
  owner: OwnerEnv;
  ports: Ports;
  stateRoot: string;
  ownerRoot: string;
  transport(label: string): RelayTransport;
  /** The crew token of the lead's machine: it pushes the relay crews' branches. */
  crewToken(config: StudioConfig): string | undefined;
  /** Where `studio/<id>` is fetched and pushed; GitHub by default. */
  pushUrl?: (repo: string) => string;
}

/** The transport of a relay label as the CLI makes it: the seam of a test, or ssh. */
export function relayTransportFor(
  owner: OwnerEnv,
  label: string,
  seam?: (label: string, target: RelayTarget) => RelayTransport,
): RelayTransport {
  const target = relayTarget(loadOwnerConfig(owner), label);
  if (target === undefined)
    throw new Error(`no relay worker for the label ${label} (workers.relay)`);
  return seam?.(label, target) ?? sshTransport({ label, target, owner });
}

/** Whether an item runs on a relay worker: its label is under `workers.relay` of the owner config. */
export const isRelayItem = (ownerConfig: OwnerConfig, item: WorkItem): boolean =>
  relayTarget(ownerConfig, item.runsOn) !== undefined;

/**
 * Starts a planned item on its relay worker. A worker that is busy or loaded, an account that is
 * parked or full, or a worker out of reach holds the item (`HeldError`); nothing is sent then and no
 * run is counted. Otherwise the pinned `main` goes over with the job and the credential the owner's
 * rules pick, the run counts on that credential's label, and the item moves to `assigned`.
 */
export async function startRelayItem(
  d: RelayLead,
  config: StudioConfig,
  item: WorkItem,
): Promise<{ item: string; label: string }> {
  const label = item.runsOn as string;
  const ownerConfig = loadOwnerConfig(d.owner);
  const crewToken = d.crewToken(config);
  if (crewToken === undefined) {
    throw new Error(
      `${item.id} runs on the relay worker ${label}: the lead pushes its branch with the crew token; studio secret set crew-token`,
    );
  }
  const block = blockHold(d.ownerRoot);
  if (block !== undefined) throw new HeldError(block);
  const limits = readLimits(d.ownerRoot);
  if (!limits.ok) throw new Error('limits.json is unreadable; refusing to start');
  const usage = labelUsage({ ownerRoot: d.ownerRoot, ownerConfig, ports: d.ports });
  if (!usage.ok) throw new Error(USAGE_UNREADABLE);
  const now = d.ports.clock.now();
  const cred = await pickCrewCredential({
    item,
    owner: d.owner,
    ownerConfig,
    ports: d.ports,
    parks: activeParks(limits.labels, now),
    usage,
  });
  if (cred.token === undefined) {
    throw new Error(
      `${item.id}: no Claude token to hand to the relay worker ${label}; add an account (studio account add) or a credential provider`,
    );
  }
  const transport = d.transport(label);
  try {
    const { answer: hello } = await relayCall(transport, 'hello', {}, { timeoutMs: 60_000 });
    if (!hello.ok) throw new HeldError(relayLine(label, hello.line));
    if (hello.held !== null) throw new HeldError(relayLine(label, hello.held));
  } catch (e) {
    if (e instanceof RelayUnreachable) throw new HeldError(relayLine(label, 'unreachable'));
    throw e;
  }
  const { sha } = await pinnedMain(d.project, d.ports);
  const { bytes, fromSha } = await startBundle({
    stateRoot: d.stateRoot,
    project: d.project,
    item,
    sha,
    ports: d.ports,
    crewToken,
    ...(d.pushUrl === undefined ? {} : { url: d.pushUrl(item.repo) }),
  });
  let sent: Awaited<ReturnType<typeof sendStart>>;
  try {
    sent = await sendStart({
      transport,
      item,
      label,
      repo: config.primaryRepo,
      sha,
      ...(fromSha === undefined ? {} : { fromSha }),
      bundle: bytes,
      token: cred.token,
    });
  } catch (e) {
    if (e instanceof RelayUnreachable) throw new HeldError(relayLine(label, 'unreachable'));
    throw e;
  }
  if (!sent.ok) {
    if (sent.kind === 'held') throw new HeldError(relayLine(label, sent.line));
    throw new Error(`the relay worker ${label} refused ${item.id}: ${sent.line}`);
  }
  const at = d.ports.clock.now();
  recordRun(d.ownerRoot, cred.label, at, ownerConfig.crewLabelLimits.timezone);
  updateRelay(d.stateRoot, (s) => {
    s.items[item.id] = {
      label,
      sha,
      from: fromSha === undefined ? 'main' : `studio/${item.id}`,
      ...(fromSha === undefined ? {} : { fromSha }),
      credential: cred.label,
      startedAt: at.toISOString(),
      state: 'starting',
      seenAt: at.toISOString(),
    };
  });
  await withBoardLock(d.stateRoot, at, () => {
    const fresh = loadBoard(d.project);
    if (itemOf(fresh, item.id).status !== 'ready') {
      throw new Error(
        `${item.id} changed while it was started on ${label}; studio stop ${item.id} --requeue`,
      );
    }
    saveBoard(
      d.project,
      withItem(transition(fresh, item.id, 'assigned', BY, at), item.id, (i) => ({
        ...i,
        crew: workerCrewName(label),
      })),
    );
  });
  return { item: item.id, label };
}

/** What one relay item came to in this tick, for the CLI to report. */
export type RelayStep =
  | { kind: 'held'; reason: string }
  | { kind: 'lead'; reason: string }
  | { kind: 'collect'; note?: string };

const dropRecord = (stateRoot: string, id: string) =>
  updateRelay(stateRoot, (s) => {
    delete s.items[id];
  });

/** Moves the item to blocked with a note, under the board lock, when it is still on its worker. */
async function blockWith(d: RelayLead, id: string, note: string): Promise<void> {
  const now = d.ports.clock.now();
  await withBoardLock(d.stateRoot, now, () => {
    const fresh = loadBoard(d.project);
    const cur = itemOf(fresh, id);
    if (cur.status !== 'assigned' && cur.status !== 'in_progress') return;
    let next = transition(fresh, id, 'blocked', BY, now);
    next = withItem(next, id, (i) => ({ ...i, notes: [...(i.notes ?? []), note] }));
    next = withItemUsage(next, d.stateRoot, id);
    saveBoard(d.project, next);
  });
}

/**
 * One tick for one item on a relay worker: its state, then, once its crew ended, the result. The
 * CLI collects a result that came back (`collect`) exactly as a local crew's report.
 */
export async function followRelayItem(
  d: RelayLead,
  config: StudioConfig,
  item: WorkItem,
  o: { cap?: number; timezone?: string },
): Promise<RelayStep> {
  const label = item.runsOn as string;
  const record = readRelay(d.stateRoot).items[item.id];
  if (record === undefined) {
    return {
      kind: 'lead',
      reason: `${item.id} runs on the relay worker ${label} but has no job record: studio stop ${item.id} --requeue starts it again, or drop it`,
    };
  }
  const target = relayTarget(loadOwnerConfig(d.owner), label);
  if (target === undefined) {
    return {
      kind: 'lead',
      reason: `${item.id}: no relay worker for the label ${label} any more (workers.relay)`,
    };
  }
  const transport = d.transport(label);
  const now = d.ports.clock.now();
  if (existsSync(relayReportFile(d.stateRoot, item.id))) return { kind: 'collect' };
  const f = await followRelay({
    transport,
    stateRoot: d.stateRoot,
    id: item.id,
    record,
    target,
    now,
  });
  switch (f.kind) {
    case 'waiting':
      if (f.running && item.status === 'assigned') {
        await withBoardLock(d.stateRoot, now, () => {
          const fresh = loadBoard(d.project);
          if (itemOf(fresh, item.id).status !== 'assigned') return;
          saveBoard(d.project, transition(fresh, item.id, 'in_progress', BY, now));
        });
      }
      return { kind: 'held', reason: f.line };
    case 'lead':
      return { kind: 'lead', reason: f.line };
    case 'held': {
      // Nothing ran: back to ready without using up its relaunch, the next tick starts it again.
      await stopRelay({ transport, id: item.id });
      dropRecord(d.stateRoot, item.id);
      await withBoardLock(d.stateRoot, now, () => {
        const fresh = loadBoard(d.project);
        const cur = itemOf(fresh, item.id);
        if (cur.status !== 'assigned' && cur.status !== 'in_progress') return;
        saveBoard(
          d.project,
          transition(transition(fresh, item.id, 'blocked', BY, now), item.id, 'ready', BY, now),
        );
      });
      return { kind: 'held', reason: relayLine(label, `not now: ${f.line}`) };
    }
    case 'refused': {
      await stopRelay({ transport, id: item.id });
      dropRecord(d.stateRoot, item.id);
      const note = `relay worker ${label} refused it: ${f.line}`;
      await blockWith(d, item.id, note);
      return { kind: 'lead', reason: `${item.id}: ${note}` };
    }
    case 'ended':
      break;
  }
  const crewToken = d.crewToken(config);
  if (crewToken === undefined) {
    return {
      kind: 'lead',
      reason: `${item.id}: the lead has no crew token to push the relay result; studio secret set crew-token`,
    };
  }
  const got = await collectRelay({
    transport,
    stateRoot: d.stateRoot,
    project: d.project,
    item,
    record,
    ports: d.ports,
    crewToken,
    secrets: [crewToken],
    ...(d.pushUrl === undefined ? {} : { url: d.pushUrl(item.repo) }),
  });
  if (got.kind === 'held') return { kind: 'held', reason: got.line };
  // The run counts first: in the day's ledger, then on the item; a busy ledger waits a tick.
  if (got.usage !== null) {
    const counted: RunUsage = {
      ...got.usage,
      ...(o.cap !== undefined && got.usage.costUsd > o.cap ? { costUsd: o.cap } : {}),
    };
    const key = `${item.id}@${new Date(Date.parse(record.startedAt)).toISOString()}`;
    if (!(await recordLedgerRun(d.stateRoot, key, item.id, counted, now, o.timezone))) {
      removeStateEntry(d.stateRoot, relayReportFile(d.stateRoot, item.id));
      return {
        kind: 'held',
        reason: relayLine(label, 'the cost ledger did not take the run yet; next tick'),
      };
    }
    updateWorkers(d.stateRoot, (s) => {
      const runs = s.runs[item.id] ?? [];
      if (!runs.some((r) => r.key === key)) {
        s.runs[item.id] = [...runs, { key, worker: `relay:${label}`, usage: counted }];
      }
    });
  }
  // A limit or a block the worker reports is its word only: it parks the one credential label the
  // lead handed over, for a bounded time, and never blocks the owner's accounts as a whole.
  let parkNote: string | undefined;
  if (got.limit !== null || got.block) {
    const read = readLimits(d.ownerRoot);
    if (read.ok) {
      const until = got.block
        ? new Date(now.getTime() + RELAY_PARK_MS)
        : new Date(
            Math.min(
              parkUntil(got.limit?.resetsAt ?? undefined, now).getTime(),
              now.getTime() + RELAY_PARK_MAX_MS,
            ),
          );
      writeLimits(d.ownerRoot, {
        ...read.labels,
        [record.credential]: {
          parkedUntil: until.toISOString(),
          kind: got.limit?.kind ?? 'session',
        },
      });
    }
    if (got.block) {
      parkNote = `${item.id}: the relay worker ${label} reports an account block of ${record.credential}; that label is parked for an hour; check the account`;
    }
  }
  if (got.kind === 'failed') {
    await stopRelay({ transport, id: item.id });
    dropRecord(d.stateRoot, item.id);
    const note = `relay worker ${label}: ${got.reason ?? 'no usable result'}`;
    await blockWith(d, item.id, note);
    return {
      kind: 'lead',
      reason: `${item.id}: ${note}; studio stop ${item.id} --requeue starts it once more`,
    };
  }
  return parkNote === undefined ? { kind: 'collect' } : { kind: 'collect', note: parkNote };
}

/** After `collect` moved the item: the worker cleans up, the lead forgets the job. */
export async function finishRelayItem(d: RelayLead, item: WorkItem): Promise<string[]> {
  const errors = await stopRelay({ transport: d.transport(item.runsOn as string), id: item.id });
  dropRecord(d.stateRoot, item.id);
  removeStateEntry(d.stateRoot, relayReportFile(d.stateRoot, item.id));
  return errors;
}

/**
 * `stop` and `drop` of a relay item: the worker stops the crew and cleans up. A worker out of reach
 * is said, never waited for: it holds no credential, so a crew it still runs can push nothing.
 */
export async function withdrawRelayItem(
  d: RelayLead,
  item: WorkItem,
  warn: (line: string) => void,
): Promise<void> {
  const errors = await stopRelay({ transport: d.transport(item.runsOn as string), id: item.id });
  for (const e of errors)
    warn(
      `the relay worker ${item.runsOn}: ${e}; its crew may still run there, without any credential to push`,
    );
  dropRecord(d.stateRoot, item.id);
  removeStateEntry(d.stateRoot, relayReportFile(d.stateRoot, item.id));
}

/** The rows `studio status` shows for relay jobs. */
export function relayRows(stateRoot: string): [string, RelayRecord][] {
  try {
    return Object.entries(readRelay(stateRoot).items);
  } catch {
    return [];
  }
}

/** `studio doctor`: one block of lines per relay label of the owner config. */
export async function relayDoctorLines(
  owner: OwnerEnv,
  config: StudioConfig | undefined,
  seam?: (label: string, target: RelayTarget) => RelayTransport,
): Promise<{ ok: boolean; lines: string[] }> {
  let ownerConfig: OwnerConfig;
  try {
    ownerConfig = loadOwnerConfig(owner);
  } catch {
    // The rest of doctor names an owner config it cannot read.
    return { ok: true, lines: [] };
  }
  const labels = Object.keys(ownerConfig.workers?.relay ?? {});
  const lines: string[] = [];
  let ok = true;
  if (labels.length === 0) return { ok, lines };
  let pins: { name: string; version: string }[];
  try {
    pins = pinnedPlugins(config?.plugins, ownerConfig.allowedPlugins);
  } catch {
    pins = [];
  }
  for (const label of labels) {
    const r = await relayDoctor({
      transport: relayTransportFor(owner, label, seam),
      label,
      studioVersion: STUDIO_VERSION,
      pins,
    });
    ok &&= r.ok;
    lines.push(...r.lines);
  }
  return { ok, lines };
}

// ---- On the relay worker -----------------------------------------------------------------------

/** The relay worker's owner: config and state in the relay home, whatever the profile holds. */
export function relayOwner(
  owner: OwnerEnv,
  home: string | undefined,
  /** Native Windows: the admin-only tree, which holds the worker's config instead of the home. */
  machine?: string,
): OwnerEnv {
  if (home === undefined) return owner;
  return {
    ...owner,
    env: {
      ...(owner.env ?? {}),
      XDG_CONFIG_HOME: machine === undefined ? join(home, 'config') : machineConfig(machine),
      XDG_STATE_HOME: join(home, 'state'),
    },
  };
}

/** Everything `relay serve` and `relay run` need on this machine. */
export function relayContext(o: {
  owner: OwnerEnv;
  home: string | undefined;
  /** The lead this request is for. */
  lead: string;
  ports: Ports;
  env: Record<string, string | undefined>;
  homedir: string;
  platform?: WorkerPlatform;
  spawnRunner?: RelayContext['spawnRunner'];
  load?: RelayContext['load'];
  /** This machine's SSH host key; read from the OpenSSH server's key file by default. */
  hostKey?: () => string | undefined;
  /** The admin-only folder of the record of pairings; the admin-only tree on Windows. */
  pairings?: string;
  log: (line: string) => void;
}): RelayContext {
  if (!LEAD_RE.test(o.lead)) throw new Error('not a lead name');
  const native0 = (o.platform ?? detectPlatform()).platform === 'win32';
  const owner = relayOwner(o.owner, o.home, native0 ? machineOf() : undefined);
  const root = relayRoot(owner);
  ensureStateDir(root, root);
  const platform = () => o.platform ?? detectPlatform();
  const native = platform().platform === 'win32';
  const settings = serveSettings(owner);
  const home = o.home ?? relayHomeDefault(o.env);
  return {
    owner,
    lead: o.lead,
    ports: o.ports,
    platform,
    spawnRunner:
      o.spawnRunner ??
      systemSpawnRunner({ home: o.home, platform: platform().platform, lead: o.lead }),
    load: o.load ?? (() => systemLoad(root)),
    ...(o.pairings !== undefined
      ? { pairings: o.pairings }
      : native
        ? { pairings: machineOf() }
        : {}),
    hostKey: o.hostKey ?? (() => readHostKey(o.env, platform().platform)),
    log: o.log,
    ...(native
      ? {
          windows: relayWindows({
            prefix: settings.windows?.crewUser ?? 'studio-crew',
            home,
            machine: machineOf(),
            task: settings.windows?.broker ?? 'Studio relay broker',
            stateRoot: root,
            ownerRoot: ownerStateRootFor(owner),
            crewConfigDir: crewClaudeDir(owner),
            ownerHome: o.homedir,
            ownerConfigDir: ownerConfigDir(owner),
            unreachable: settings.probeUnreachable,
            env: o.env,
            ports: o.ports,
            startProxy: (allow) => startEgressProxy({ allow }),
          }),
        }
      : {}),
  };
}

/** The admin-only tree this process runs from: `<machine>\node\node.exe`. */
const machineOf = (): string => resolve(dirname(process.execPath), '..');

async function readAll(input: AsyncIterable<Uint8Array | string>): Promise<string> {
  let s = '';
  for await (const c of input) s += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
  return s;
}

/** The OpenSSH server's ed25519 host key of this machine, `<type> <base64>`; undefined if none. */
export function readHostKey(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | undefined {
  const file =
    platform === 'win32'
      ? join(
          env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData',
          'ssh',
          'ssh_host_ed25519_key.pub',
        )
      : '/etc/ssh/ssh_host_ed25519_key.pub';
  try {
    return keyscanKey(`host ${readFileSync(file, 'utf8')}`);
  } catch {
    return undefined;
  }
}

const readText = (file: string | undefined): string | undefined => {
  if (file === undefined) return undefined;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Which lead a session of `relay serve` is for. On native Windows the key that logged in decides
 * (sshd's `ExposeAuthInfo`, matched against the admin-only authorized keys), and a `--lead` the
 * key's command names must agree; without either, nothing is served. Elsewhere `--lead`, else the
 * key's lead when sshd names it, else `default`.
 */
export function sessionLead(o: {
  platform: NodeJS.Platform;
  flag: string | undefined;
  env: Record<string, string | undefined>;
  keysFile: string | undefined;
}): { lead: string } | { problem: string } {
  const fromKey = leadFromAuthInfo(readText(o.env.SSH_USER_AUTH), readText(o.keysFile));
  if (o.flag !== undefined && !LEAD_RE.test(o.flag)) return { problem: 'not a lead name' };
  if (o.flag !== undefined && fromKey !== undefined && o.flag !== fromKey) {
    return { problem: 'this key belongs to another lead' };
  }
  if (o.platform === 'win32') {
    return fromKey === undefined
      ? {
          problem:
            'cannot tell which lead this key is (sshd ExposeAuthInfo and a key paired by studio relay install)',
        }
      : { lead: fromKey };
  }
  if (o.flag === undefined && fromKey === undefined) {
    // Elsewhere the keys are the owner's own: with more than one key forced to relay serve, each
    // must name its lead, or one lead could act as another.
    const serving = (readText(o.keysFile) ?? '')
      .split(/\r?\n/)
      .filter((l) => /relay serve/.test(l) && !l.trimStart().startsWith('#')).length;
    if (serving > 1) {
      return {
        problem:
          'several keys run relay serve here: give each its own --lead <name> in its command',
      };
    }
  }
  return { lead: o.flag ?? fromKey ?? 'default' };
}

const refuse = (out: (s: string) => void, line: string) => {
  for (const l of encodeMessage({ studioRelay: RELAY_PROTOCOL, ok: false, kind: 'refused', line }))
    out(l);
};

/** `studio relay ...`; undefined for a call it does not know. Returns the exit code. */
export async function runRelayCommand(o: {
  rest: string[];
  values: RelayValues;
  owner: OwnerEnv;
  ports: Ports;
  env: Record<string, string | undefined>;
  homedir?: string;
  stdin: AsyncIterable<Uint8Array | string>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  platform?: WorkerPlatform;
  spawnRunner?: RelayContext['spawnRunner'];
  load?: RelayContext['load'];
  transport?: (label: string, target: RelayTarget) => RelayTransport;
  /** Runs a program and gives its exit code and output; a seam for tests. */
  exec?: Exec;
  /** Seams for tests of install and unpair: elevation, the host key, where keys are written. */
  elevated?: () => Promise<boolean | undefined>;
  hostKey?: () => string | undefined;
  /** Seam for tests: the check of the admin-only tree on native Windows. */
  treeCheck?: () => Promise<string | undefined>;
  /** Seam for tests: the admin-only tree install and unpair write. */
  machine?: string;
}): Promise<number | undefined> {
  const [sub, ...args] = o.rest;
  const platform = (o.platform ?? detectPlatform()).platform;
  const home = o.values.home ?? relayHomeDefault(o.env);
  const ctx = (lead: string) =>
    relayContext({
      owner: o.owner,
      home: o.values.home,
      lead,
      ports: o.ports,
      env: o.env,
      homedir: o.homedir ?? homedir(),
      ...(o.platform === undefined ? {} : { platform: o.platform }),
      ...(o.spawnRunner === undefined ? {} : { spawnRunner: o.spawnRunner }),
      ...(o.load === undefined ? {} : { load: o.load }),
      ...(o.hostKey === undefined ? {} : { hostKey: o.hostKey }),
      log: (l) => o.stderr(`${l.replace(/\p{Cc}/gu, ' ')}\n`),
    });
  /** Native Windows: never run from copies anyone but administrators could have changed. */
  const trusted = async (): Promise<string | undefined> => {
    if (platform !== 'win32') return undefined;
    return (
      o.treeCheck ??
      (() =>
        machineTreeProblem(runFile, {
          machine: machineOf(),
          home,
          node: process.execPath,
          studioBin: STUDIO_BIN,
        }))
    )();
  };
  if (sub === 'serve' && args.length === 0) {
    const tree = await trusted();
    if (tree !== undefined) {
      refuse(o.stdout, tree);
      return 1;
    }
    const lead = sessionLead({
      platform,
      flag: o.values.lead,
      env: o.env,
      keysFile:
        platform === 'win32'
          ? authorizedKeysFile(machineOf())
          : join(o.homedir ?? homedir(), '.ssh', 'authorized_keys'),
    });
    if ('problem' in lead) {
      refuse(o.stdout, lead.problem);
      return 1;
    }
    await serveRelay(ctx(lead.lead), o.stdin, o.stdout);
    return 0;
  }
  if (sub === 'run' && args.length === 1) {
    const id = args[0] as string;
    const lead = o.values.lead ?? 'default';
    if (!/^[A-Z]+-\d+$/.test(id) || !LEAD_RE.test(lead)) return undefined;
    const tree = await trusted();
    if (tree !== undefined) throw new Error(tree);
    const spec =
      o.values.pipe === undefined ? await readAll(o.stdin) : await readSpecFromPipe(o.values.pipe);
    const state = await runRelayJob(ctx(lead), id, spec);
    o.stdout(`${JSON.stringify({ item: id, state })}\n`);
    return state === 'refused' ? 1 : 0;
  }
  const machine = o.machine ?? relayMachineDefault(o.env);
  const relayUser = o.values.user ?? 'studio-relay';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(relayUser)) {
    throw new Error('--user: a local user name of at most 20 characters');
  }
  if (sub === 'setup' && args.length === 0) {
    if (o.values.pair !== undefined) throw new Error('--pair works with relay install only');
    o.stdout(
      setupScriptFor({ owner: o.owner, env: o.env, home, machine, relayUser, install: undefined }),
    );
    return 0;
  }
  if (sub === 'install' && args.length === 0) {
    const pair = o.values.pair === undefined ? undefined : parsePairLine(o.values.pair);
    return await install({
      ...o,
      home,
      relayUser,
      pair,
      machine,
      script: (i) =>
        setupScriptFor({ owner: o.owner, env: o.env, home, machine, relayUser, install: i }),
    });
  }
  if (sub === 'unpair' && args.length === 1) {
    return await unpair({ ...o, home, machine, relayUser, label: args[0] as string });
  }
  if (sub === 'pair' && o.values.connect !== true && args.length === 2) {
    return await pairStart({ ...o, label: args[0] as string, host: args[1] as string });
  }
  if (sub === 'pair' && o.values.connect === true && args.length === 1) {
    return await pairConnect({ ...o, label: args[0] as string });
  }
  return undefined;
}

/** The flags of `studio relay`. */
export interface RelayValues {
  home?: string;
  pipe?: string;
  lead?: string;
  'keep-passwords'?: boolean;
  'i-am-local'?: boolean;
  'force-stop'?: boolean;
  'disable-spooler'?: boolean;
  pair?: string;
  user?: string;
  port?: string;
  source?: string;
  interface?: string;
  connect?: boolean;
}

/** Runs a program; output goes to `onOutput` as it comes when given. */
export type Exec = (
  file: string,
  args: string[],
  o?: { onOutput?: (s: string) => void; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const systemExec: Exec = (file, args, o = {}) =>
  new Promise((res) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 30 * 60_000);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
      o.onOutput?.(String(d));
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      o.onOutput?.(String(d));
    });
    child.on('error', () => {
      clearTimeout(timer);
      res({ code: 127, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, stdout, stderr });
    });
  });

/** The setup script of a Windows relay worker, as `relay setup` prints and `relay install` runs it. */
function setupScriptFor(o: {
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  home: string;
  machine: string;
  relayUser: string;
  install: RelayInstall | undefined;
}): string {
  const owner = relayOwner(o.owner, o.home, o.machine);
  const settings = serveSettings(owner);
  const claude = findClaude(o.env.PATH ?? o.env.Path);
  return relaySetupScript({
    relayUser: o.relayUser,
    crewPrefix: settings.windows?.crewUser ?? 'studio-crew',
    home: o.home,
    machine: o.machine,
    task: settings.windows?.broker ?? 'Studio relay broker',
    // Node.js, Studio and the plugins are read from the admin-only tree; these are the rest.
    readPaths: [
      ...(claude === undefined ? [] : [dirname(claude)]),
      ...loadOwnerConfig(o.owner).crewToolchainPaths,
    ],
    source: { node: process.execPath, studio: resolve(dirname(STUDIO_BIN), '..') },
    ...(o.install === undefined ? {} : { install: o.install }),
  });
}

/** A Windows relay worker's own config, written once with the defaults of a new machine. */
const DEFAULT_SERVE_CONFIG = `# Studio relay worker (studio relay install). Optional; see the README, "Relay workers".
workers:
  serve:
    deny:
      hosts: [local-subnets, tailnet-peers]
`;

/** Whether this process runs in an SSH session by its environment. */
const sshSessionVar = (env: Record<string, string | undefined>): boolean =>
  [env.SSH_CONNECTION, env.SSH_CLIENT, env.SSH_TTY].some((v) => v !== undefined && v !== '');

/** Whether an sshd is among the parents of this process (Windows, through CIM). */
async function underSshd(exec: Exec): Promise<boolean> {
  const r = await exec('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$p = ${process.pid}; $hit = $false; for ($i = 0; $i -lt 16 -and $p; $i++) { $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if ($null -eq $x) { break }; if ($x.Name -like 'sshd*') { $hit = $true; break }; $p = $x.ParentProcessId }; [Console]::Out.Write($hit)`,
  ]);
  return r.code === 0 && r.stdout.trim() === 'True';
}

/** What install and unpair need on the worker: a Windows machine and an elevated session. */
async function windowsAdmin(o: {
  platform?: WorkerPlatform;
  elevated?: () => Promise<boolean | undefined>;
  what: string;
}): Promise<void> {
  if ((o.platform ?? detectPlatform()).platform !== 'win32') {
    throw new Error(
      `relay ${o.what} sets up a Windows relay worker; elsewhere run studio relay serve --home <dir> as the forced command of your sshd`,
    );
  }
  if ((await (o.elevated ?? (() => elevated(runFile)))()) !== true) {
    throw new Error(`relay ${o.what} needs an elevated PowerShell (run it as administrator)`);
  }
}

/**
 * Rewrites the relay account's authorized keys file from the pairings this worker records, and
 * from nothing else: one line per pairing, forced to `studio relay serve`. Lines it finds there
 * that no pairing names are removed and said. The file is written whole, with its ACL set before
 * it replaces the old one (SYSTEM and administrators write, the relay account reads).
 */
async function syncAuthorizedKeys(o: {
  home: string;
  machine: string;
  relayUser: string;
  exec: Exec;
  stdout: (s: string) => void;
}): Promise<boolean> {
  const file = authorizedKeysFile(o.machine);
  let existing: string | undefined;
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = undefined;
  }
  const plan = authorizedKeysPlan({
    pairings: readPairings(o.machine),
    command: forcedCommand(o.machine, o.home),
    existing,
  });
  const r = await o.exec('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    authorizedKeysScript({ file, lines: plan.keyLines, relayUser: o.relayUser }),
  ]);
  if (r.code !== 0) {
    o.stdout(`cannot write ${file}: ${r.stderr.replace(/\p{Cc}/gu, ' ').slice(0, 200)}\n`);
    return false;
  }
  for (const line of plan.removed) {
    const [, type, blob, ...rest] = /^(?:\S*\s+)?(ssh-\S+|ecdsa-\S+)\s+(\S+)(.*)$/.exec(line) ?? [];
    o.stdout(
      `removed an authorized key no pairing names: ${type === undefined ? 'a line that is no key' : `${keyFingerprint(`${type} ${blob}`)}${rest.join('').trim() === '' ? '' : ` (${rest.join('').trim().slice(0, 60)})`}`}\n`,
    );
  }
  o.stdout(
    plan.lines.length === 0
      ? 'authorized: no lead (studio relay install --pair "<line>" authorizes one)\n'
      : plan.lines.map((l) => `authorized: ${l.label}, lead key ${l.fingerprint}\n`).join(''),
  );
  return true;
}

/**
 * `studio relay install`: on a Windows machine, elevated. Checks and installs what a relay worker
 * needs, creates the relay account, the crew user and the broker, writes the sshd block and the
 * firewall rule for sshd, records a pairing and authorizes exactly the paired keys, and ends with a
 * summary. Run again, it repairs and updates.
 */
async function install(o: {
  home: string;
  machine: string;
  relayUser: string;
  script: (install: RelayInstall) => string;
  pair: PairLine | undefined;
  values: RelayValues;
  env: Record<string, string | undefined>;
  ports: Ports;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  platform?: WorkerPlatform;
  exec?: Exec;
  elevated?: () => Promise<boolean | undefined>;
  hostKey?: () => string | undefined;
}): Promise<number> {
  const exec = o.exec ?? systemExec;
  await windowsAdmin({ ...o, what: 'install' });
  // sshd is stopped while the install runs: over SSH it would cut its own session off.
  if (o.values['i-am-local'] !== true && (sshSessionVar(o.env) || (await underSshd(exec)))) {
    throw new Error(
      'relay install stops sshd while it runs: run it at the machine or over remote desktop, never over SSH (--i-am-local if this is not an SSH session)',
    );
  }
  const port = o.values.port === undefined ? 22 : Number(o.values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port: 1 to 65535');
  let scope: SshdScope;
  if (o.values.source !== undefined) {
    if (!/^[0-9A-Fa-f.:/,-]{2,200}$/.test(o.values.source)) {
      throw new Error('--source: addresses or ranges, comma separated');
    }
    scope = { source: o.values.source };
  } else if (o.values.interface !== undefined) {
    if (!/^[\w .()-]{1,64}$/.test(o.values.interface)) throw new Error('--interface: a name');
    scope = { interface: o.values.interface };
  } else {
    const ts = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "@(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like '*Tailscale*' -or $_.Name -like 'Tailscale*' }).Count",
    ]);
    if (ts.code !== 0 || !(Number(ts.stdout.trim()) > 0)) {
      throw new Error(
        'no Tailscale interface here: say which interface or which source range may reach sshd (studio relay install --interface <name> or --source <range>)',
      );
    }
    scope = { tailscale: true };
  }
  o.stdout(
    'Studio relay install: this stops and disables the WebClient service (WebDAV), which the crew sandbox does not hold.\n',
  );
  // Nothing of the home is made here: the script makes every folder with its own DACL.
  const dir = mkdtempSync(join(tmpdir(), 'studio-relay-install-'));
  const file = join(dir, 'install.ps1');
  writeFileSync(
    file,
    o.script({
      port,
      scope,
      ...(o.values['keep-passwords'] === true ? { keepPasswords: true } : {}),
      ...(o.values['disable-spooler'] === true ? { disableSpooler: true } : {}),
      ...(o.values['force-stop'] === true ? { forceStop: true } : {}),
    }),
  );
  let r: Awaited<ReturnType<Exec>>;
  try {
    r = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { onOutput: o.stdout },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (r.code !== 0) {
    o.stderr('studio: relay install stopped; fix what it says and run it again (it repairs)\n');
    return 1;
  }
  // A new machine gets the defaults of a Windows relay worker; an existing config stays. The
  // config lives in the admin-only tree, written whole and swapped in.
  const config = join(machineConfig(o.machine), 'studio', 'config.yaml');
  if (!existsSync(config)) {
    mkdirSync(dirname(config), { recursive: true });
    const tmp = `${config}.${process.pid}.tmp`;
    writeFileSync(tmp, DEFAULT_SERVE_CONFIG, { flag: 'wx' });
    renameSync(tmp, config);
  }
  if (o.pair !== undefined) {
    writePairings(o.machine, {
      ...readPairings(o.machine),
      [o.pair.label]: {
        key: o.pair.key,
        secret: o.pair.secret,
        pairedAt: o.ports.clock.now().toISOString(),
      },
    });
  }
  if (!(await syncAuthorizedKeys({ ...o, exec }))) return 1;
  const hostKey = (o.hostKey ?? (() => readHostKey(o.env, 'win32')))();
  o.stdout(
    hostKey === undefined
      ? 'host key: cannot read the OpenSSH server host key\n'
      : `host key fingerprint: ${keyFingerprint(hostKey)}${o.pair === undefined ? '' : `\nOn the lead, within the hour: studio relay pair ${o.pair.label} --connect`}\n`,
  );
  return 0;
}

/** `studio relay unpair <label>` on the worker: the pairing goes, and its key with it. */
async function unpair(o: {
  home: string;
  machine: string;
  relayUser: string;
  label: string;
  stdout: (s: string) => void;
  platform?: WorkerPlatform;
  exec?: Exec;
  elevated?: () => Promise<boolean | undefined>;
}): Promise<number> {
  if (!WORKER_LABEL_RE.test(o.label))
    throw new Error('relay unpair: a label is ^[a-z][a-z0-9-]{0,31}$');
  await windowsAdmin({ ...o, what: 'unpair' });
  const all = readPairings(o.machine);
  const known = o.label in all;
  delete all[o.label];
  writePairings(o.machine, all);
  o.stdout(known ? `unpaired: ${o.label}\n` : `no pairing of ${o.label} here\n`);
  return (await syncAuthorizedKeys({ ...o, exec: o.exec ?? systemExec })) ? 0 : 1;
}

/** `studio relay pair <label> <host>` on the lead: the key and the one pairing line. */
async function pairStart(o: {
  label: string;
  host: string;
  values: RelayValues;
  owner: OwnerEnv;
  stdout: (s: string) => void;
  exec?: Exec;
  ports: Ports;
}): Promise<number> {
  if (!WORKER_LABEL_RE.test(o.label)) {
    throw new Error('relay pair: a label is ^[a-z][a-z0-9-]{0,31}$');
  }
  if (!RELAY_HOST_RE.test(o.host)) throw new Error('relay pair: a host name or an IP address');
  const port = o.values.port === undefined ? 22 : Number(o.values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port: 1 to 65535');
  const user = o.values.user ?? 'studio-relay';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(user)) throw new Error('--user: a local user name');
  const exec = o.exec ?? systemExec;
  const key = leadKeyFile(o.owner, o.label);
  mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
  // A key paired before is replaced: the worker gets the new line, the old one goes with it.
  rmSync(key, { force: true });
  rmSync(`${key}.pub`, { force: true });
  const made = await exec('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    `studio-relay-${o.label}`,
    '-f',
    key,
  ]);
  if (made.code !== 0) throw new Error('ssh-keygen could not make the key');
  const pub = readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  const secret = newPairSecret();
  writePending(o.owner, {
    label: o.label,
    host: o.host,
    port,
    user,
    secret,
    identityFile: key,
    createdAt: o.ports.clock.now().toISOString(),
  });
  o.stdout(
    `On the worker, in an elevated PowerShell, within the hour:\n  studio relay install --pair "${renderPairLine({ label: o.label, secret, key: pub })}"\nThen here: studio relay pair ${o.label} --connect\nThe line holds a single-use secret: paste it on the worker only.\n`,
  );
  return 0;
}

/**
 * `studio relay pair <label> --connect` on the lead: connects with the worker's host key pinned
 * and keeps it only when the worker proves, with the pairing's secret, that this is its host key;
 * then the worker goes into the owner config and the secret is used up.
 */
async function pairConnect(o: {
  label: string;
  owner: OwnerEnv;
  ports: Ports;
  stdout: (s: string) => void;
  transport?: (label: string, target: RelayTarget) => RelayTransport;
  exec?: Exec;
}): Promise<number> {
  const p = readPending(o.owner, o.label, o.ports.clock.now());
  if (p === undefined) {
    throw new Error(
      `no pairing of ${o.label} is waiting (none started, or used already): studio relay pair ${o.label} <host>`,
    );
  }
  const scan = await (o.exec ?? systemExec)('ssh-keyscan', [
    '-T',
    '15',
    '-t',
    'ed25519',
    '-p',
    String(p.port),
    p.host,
  ]);
  const key = keyscanKey(scan.stdout);
  if (key === undefined) throw new Error(`cannot read the host key of ${p.host}:${p.port}`);
  o.stdout(`host key fingerprint of ${p.host}: ${keyFingerprint(key)}\n`);
  const target = relayTargetSchema.parse({
    host: p.host,
    port: p.port,
    user: p.user,
    hostKey: key,
    identityFile: p.identityFile,
  });
  const transport =
    o.transport?.(o.label, target) ?? sshTransport({ label: o.label, target, owner: o.owner });
  const { answer } = await relayCall(transport, 'hello', {}, { timeoutMs: 60_000 });
  if (!answer.ok) throw new Error(`the worker answered: ${answer.line}`);
  const proof = answer.pairProofs.find((x) => x.label === o.label);
  if (proof === undefined || !proofHolds(p.secret, key, proof.mac)) {
    throw new Error(
      `the worker did not prove this host key with the pairing's secret: nothing was pinned. Run studio relay install --pair with the line studio relay pair printed, within the hour, on the worker itself`,
    );
  }
  writeRelayTarget(o.owner, o.label, {
    host: p.host,
    port: p.port,
    user: p.user,
    hostKey: key,
    identityFile: p.identityFile,
  });
  dropPending(o.owner, o.label);
  o.stdout(
    `paired: ${o.label} is ${p.user}@${p.host}:${p.port}, Studio ${answer.studio} on ${answer.platform}, host key pinned (${keyFingerprint(key)}). studio doctor checks it end to end.\n`,
  );
  return 0;
}
