// The CLI's side of relay workers (src/relay-lead.ts, src/relay-serve.ts): on the lead, starting a
// planned item on its relay worker and following it each tick; on the worker, `studio relay serve`,
// `relay run` and `relay setup`. Kept out of src/cli.ts, which only calls in here.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { crewClaudeDir } from './accounts.js';
import { type Board, loadBoard, saveBoard, transition, type WorkItem } from './board.js';
import {
  loadOwnerConfig,
  type OwnerConfig,
  type OwnerEnv,
  ownerConfigDir,
  type RelayTarget,
  type StudioConfig,
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
  leadFromAuthInfo,
  machineConfig,
  relayHomeDefault,
  relayMachineDefault,
  relaySetupScript,
} from './relay-windows.js';
import { machineTreeProblem, relayWindows } from './relay-windows-check.js';
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
    log: o.log,
    ...(native
      ? {
          windows: relayWindows({
            user: settings.windows?.crewUser ?? 'studio-crew',
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

/** `studio relay serve | run <id> | setup`. Returns the exit code. */
export async function runRelayCommand(o: {
  rest: string[];
  values: { home?: string; pipe?: string; 'lead-key'?: string; lead?: string };
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
  /** Seam for tests: the check of the admin-only tree on native Windows. */
  treeCheck?: () => Promise<string | undefined>;
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
  if (sub === 'setup' && args.length === 0) {
    const machine = relayMachineDefault(o.env);
    const settings = serveSettings(relayOwner(o.owner, home, machine));
    const claude = findClaude(o.env.PATH ?? o.env.Path);
    o.stdout(
      relaySetupScript({
        relayUser: 'studio-relay',
        crewUser: settings.windows?.crewUser ?? 'studio-crew',
        home,
        machine,
        task: settings.windows?.broker ?? 'Studio relay broker',
        // Node.js, Studio and the plugins are read from the admin-only tree; these are the rest.
        readPaths: [
          ...(claude === undefined ? [] : [dirname(claude)]),
          ...loadOwnerConfig(o.owner).crewToolchainPaths,
        ],
        source: { node: process.execPath, studio: resolve(dirname(STUDIO_BIN), '..') },
        ...(o.values['lead-key'] === undefined ? {} : { leadKey: o.values['lead-key'] }),
      }),
    );
    return 0;
  }
  return undefined;
}
