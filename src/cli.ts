import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Board, loadBoard, saveBoard, transition, type WorkItem } from './board.js';
import { readCapacity } from './capacity.js';
import { configWarnings, loadConfig, type StudioConfig } from './config.js';
import { launchCrew } from './crew.js';
import { checkStateMarker, projectRealpath, stateRootFor, writeStateFile } from './paths.js';
import { type Capacity, planAssignments } from './planner.js';
import type { Ports } from './ports.js';
import {
  acquireQueueRunLock,
  enqueue,
  loadQueue,
  type QueueDone,
  type QueueState,
  runQueue,
  takeNextPending,
  updateQueue,
} from './queue.js';
import { checkReportHead, readReport } from './report.js';
import {
  type CrewSnapshot,
  computeMetrics,
  readCrewRecords,
  readMetricEvents,
  type StateSnapshot,
  writeState,
} from './state.js';

export interface CliDeps {
  ports: Ports;
  stdout(s: string): void;
  stderr(s: string): void;
  env: Record<string, string | undefined>;
  homedir: string;
  cwd: string;
}

const USAGE = `Usage: studio [--project <dir>] [--json] <command>

Commands:
  board                    Show the board
  plan                     Dry-run the planner (JSON)
  launch <id>              Start a crew session for a planned item
  status                   Crew sessions and their board status
  collect <id>             Read a crew report and move the item
  queue add <repo>#<pr>    Put a reviewed PR into the merge queue
  queue run                Merge the queued PRs, one at a time
  state                    Refresh state.json in the state root
  stop <id>                Stop a crew session
  metrics                  Lead time and deployment frequency
`;

class UsageError extends Error {}

const BY = 'studio';

const ACTIVE_FOR_WIP: readonly WorkItem['status'][] = ['assigned', 'in_progress'];

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? [];
  return `${rows
    .map((r) =>
      r
        .map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')}\n`;
}

function findItem(board: Board, id: string | undefined): WorkItem {
  if (!id) throw new UsageError('missing item id');
  const item = board.items.find((i) => i.id === id);
  if (!item) throw new Error(`unknown item ${id}`);
  return item;
}

function withItem(board: Board, id: string, fn: (item: WorkItem) => WorkItem): Board {
  return { ...board, items: board.items.map((i) => (i.id === id ? fn(i) : i)) };
}

function runningPerRole(board: Board): Record<string, number> {
  const running: Record<string, number> = {};
  for (const i of board.items) {
    if (ACTIVE_FOR_WIP.includes(i.status)) running[i.role] = (running[i.role] ?? 0) + 1;
  }
  return running;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { ports, stdout, stderr } = deps;
  const debug = Boolean(deps.env.STUDIO_DEBUG);
  try {
    const { values, positionals } = parseCli(argv);
    if (values.help) {
      stdout(USAGE);
      return 0;
    }
    const [cmd, ...rest] = positionals;
    const project = resolve(deps.cwd, values.project ?? '.');
    const json = values.json === true;
    const print = (v: unknown) => stdout(`${JSON.stringify(v, null, 2)}\n`);
    const owner = { env: deps.env, homedir: deps.homedir };

    const loadAll = () => {
      const config = loadConfig(project);
      for (const w of configWarnings(config)) stderr(`warning: ${w}\n`);
      return { config, board: loadBoard(project) };
    };
    const stateRoot = () => stateRootFor(project, owner);
    /** Binds the state root to this project before the first write (launch does the same). */
    const boundStateRoot = async () => {
      const root = stateRoot();
      const url = (await ports.git.run(project, ['remote', 'get-url', 'origin'])).trim();
      checkStateMarker(root, { projectRealpath: projectRealpath(project), originUrl: url });
      return root;
    };
    const planNow = async (config: StudioConfig, board: Board) => {
      const capacity = await readCapacity(config, ports);
      return { capacity, plan: planAssignments(board, config, capacity, runningPerRole(board)) };
    };

    switch (cmd) {
      case 'board': {
        const { board } = loadAll();
        if (json) print(board.items);
        else {
          stdout(
            table([
              ['ID', 'STATUS', 'ROLE', 'TYPE', 'PRIORITY', 'TITLE'],
              ...board.items.map((i) => [
                i.id,
                i.status,
                i.role,
                i.type,
                String(i.priority),
                i.title,
              ]),
            ]),
          );
        }
        return 0;
      }

      case 'plan': {
        const { config, board } = loadAll();
        const { plan, capacity } = await planNow(config, board);
        print({
          assign: plan.assign.map((i) => ({ id: i.id, title: i.title, role: i.role })),
          blocked: plan.blocked,
          deferred: plan.deferred,
          capacity,
        });
        return 0;
      }

      case 'launch': {
        const { config, board } = loadAll();
        const item = findItem(board, rest[0]);
        if (item.status !== 'ready') {
          throw new Error(`${item.id} is ${item.status}, only ready items can be launched`);
        }
        const { plan } = await planNow(config, board);
        if (!plan.assign.some((i) => i.id === item.id)) {
          const why =
            plan.blocked.find((b) => b.id === item.id)?.reason ??
            plan.deferred.find((d) => d.id === item.id)?.reason ??
            'not in the current plan';
          throw new Error(`${item.id} is not in the current plan: ${why}`);
        }
        const res = await launchCrew(project, item, config, ports, owner);
        // The launch took a while: re-read the board and move the item on the fresh copy.
        const fresh = loadBoard(project);
        if (findItem(fresh, item.id).status !== 'ready') {
          throw new Error(`${item.id} changed while launching; crew ${res.name} is running`);
        }
        const moved = withItem(
          transition(fresh, item.id, 'assigned', BY, ports.clock.now()),
          item.id,
          (i) => ({ ...i, crew: res.name }),
        );
        saveBoard(project, moved);
        print(res);
        return 0;
      }

      case 'status': {
        const board = loadBoard(project);
        const root = stateRoot();
        const rows = Object.values(readCrewRecords(root)).map((r) => ({
          name: r.name,
          item: r.item,
          role: r.role,
          pid: r.pid,
          alive: ports.claude.alive(r.pid),
          status: board.items.find((i) => i.id === r.item)?.status ?? 'unknown',
          startedAt: r.startedAt,
          ...(r.stoppedAt === undefined ? {} : { stoppedAt: r.stoppedAt }),
        }));
        if (json) print(rows);
        else {
          stdout(
            table([
              ['ITEM', 'NAME', 'ROLE', 'PID', 'ALIVE', 'STATUS'],
              ...rows.map((r) => [
                r.item,
                r.name,
                r.role,
                String(r.pid),
                r.alive ? 'yes' : 'no',
                r.status,
              ]),
            ]),
          );
        }
        return 0;
      }

      case 'collect': {
        const { board } = loadAll();
        const item = findItem(board, rest[0]);
        if (item.status !== 'assigned' && item.status !== 'in_progress') {
          throw new Error(
            `${item.id} is ${item.status}, only assigned or in_progress items can be collected`,
          );
        }
        // A running crew may still rewrite its report; an earlier run's report is not this one.
        const record = readCrewRecords(stateRoot())[item.id];
        let notBefore: Date | undefined;
        if (record !== undefined) {
          if (!Number.isInteger(record.pid) || record.pid <= 0) {
            throw new Error(`crew record for ${item.id} has no valid pid`);
          }
          if (ports.claude.alive(record.pid)) {
            throw new Error(
              `crew ${record.name} is still running (pid ${record.pid}); collect after it exited, or stop it first`,
            );
          }
          notBefore = new Date(record.startedAt);
          if (Number.isNaN(notBefore.getTime())) {
            throw new Error(`crew record for ${item.id} has no valid startedAt`);
          }
        }
        // Reading files only: git never runs inside a crew clone.
        const clone = join(stateRoot(), 'clones', item.id);
        // The report is read exactly once; everything below verifies and stores that one result.
        const report = readReport(clone, item.id, item, { notBefore });
        let branch = `studio/${item.id}`;
        if (report.pr !== undefined) {
          const holder = board.items.find(
            (i) => i.id !== item.id && i.repo === item.repo && i.pr === report.pr,
          );
          if (holder) throw new Error(`PR ${report.pr} is already held by ${holder.id}`);
          const info = await prInfo(ports, item.repo, report.pr);
          if (info.branch !== `studio/${item.id}`) {
            throw new Error(
              `PR ${report.pr} is on branch ${info.branch}, expected studio/${item.id}`,
            );
          }
          branch = info.branch;
          checkReportHead(report, info.head);
        } else if (report.status === 'done' && !PR_OPTIONAL.includes(item.type)) {
          throw new Error(`done report for ${item.id} names no pr`);
        }
        const now = ports.clock.now();
        let next = board;
        if (report.status === 'done') {
          if (item.status === 'assigned') next = transition(next, item.id, 'in_progress', BY, now);
          next = transition(next, item.id, 'in_review', BY, now);
          if (report.pr !== undefined) {
            const pr = report.pr;
            next = withItem(next, item.id, (i) => ({ ...i, pr, branch }));
          } else {
            // Review and research items open no PR: the result is the report itself.
            next = transition(next, item.id, 'merged', BY, now);
            const result = [
              ...(report.verdict ? [`verdict: ${report.verdict}`] : []),
              ...(report.reviews ? [`reviews: ${report.reviews}`] : []),
            ];
            if (result.length > 0) {
              next = withItem(next, item.id, (i) => ({
                ...i,
                notes: [...(i.notes ?? []), ...capNotes(result)],
              }));
            }
          }
        } else {
          next = transition(next, item.id, 'blocked', BY, now);
          const notes =
            report.status === 'failed'
              ? ['crew run failed', ...report.questions.map((q) => `question: ${q}`)]
              : report.questions.map((q) => `question: ${q}`);
          next = withItem(next, item.id, (i) => ({
            ...i,
            notes: [
              ...(i.notes ?? []),
              ...capNotes(notes.length ? notes : ['crew reported blocked']),
            ],
          }));
        }
        saveBoard(project, next);
        print({
          item: item.id,
          report: report.status,
          status: findItem(next, item.id).status,
          ...(report.pr === undefined ? {} : { pr: report.pr }),
          ...(report.verdict === undefined ? {} : { verdict: report.verdict }),
          ...(report.reviews === undefined ? {} : { reviews: report.reviews }),
        });
        return 0;
      }

      case 'queue': {
        const [sub, arg] = rest;
        if (sub === 'add') {
          const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(arg ?? '');
          if (!m) throw new UsageError('queue add needs <repo>#<pr>, e.g. org/app#12');
          const repo = m[1] as string;
          const pr = Number(m[2]);
          const { config, board } = loadAll();
          refuseNativeQueue(config);
          if (!config.repos.includes(repo)) throw new Error(`repository ${repo} is not configured`);
          const item = board.items.find((i) => i.pr === pr && i.repo === repo);
          if (!item) throw new Error(`no board item has PR ${repo}#${pr}`);
          if (item.status !== 'in_review') {
            throw new Error(`${item.id} is ${item.status}, only in_review items can be queued`);
          }
          const root = await boundStateRoot();
          // Merged into queue.json on disk under the queue file lock: safe during a running queue.
          const pending = enqueue(root, { pr, repo, item: item.id });
          saveBoard(project, transition(board, item.id, 'queued', BY, ports.clock.now()));
          print({ queued: item.id, pr, repo, pending });
          return 0;
        }
        if (sub === 'run') {
          const { config } = loadAll();
          refuseNativeQueue(config);
          const root = await boundStateRoot();
          const log = (m: string) => stderr(`${m}\n`);
          const lock = acquireQueueRunLock(root, ports.clock.now(), log);
          try {
            const state = loadQueue(root);
            reconcileQueued(project, state, ports, stderr);
            const before = state.done.length;
            await runQueue(
              state,
              config,
              ports,
              // The runner owns `current` and `done`; `pending` stays whatever is on disk.
              (q) =>
                updateQueue(root, (disk) => {
                  disk.current = q.current;
                  disk.done = q.done;
                }),
              {
                stateRoot: root,
                log,
                takeNext: () => takeNextPending(root),
                onDone: (d) => applyQueueResults(project, [d], ports, stderr),
              },
            );
            const finished = state.done.slice(before);
            print({
              merged: finished.filter((d) => d.result === 'merged').length,
              failed: finished.filter((d) => d.result === 'failed').length,
              done: finished,
            });
          } finally {
            lock.release();
          }
          return 0;
        }
        throw new UsageError('queue needs a subcommand: add <repo>#<pr> | run');
      }

      case 'state': {
        const { config, board } = loadAll();
        const root = await boundStateRoot();
        const { capacity } = await planNow(config, board);
        const snapshot = buildSnapshot(root, board, capacity, loadQueue(root), ports.clock.now());
        writeState(root, snapshot);
        print(snapshot);
        return 0;
      }

      case 'stop': {
        const board = loadBoard(project);
        const id = findItem(board, rest[0]).id;
        const root = stateRoot();
        const records = readCrewRecords(root);
        const rec = records[id];
        if (!rec) throw new Error(`no crew record for ${id}`);
        await ports.claude.stop(rec.pid);
        const stoppedAt = ports.clock.now().toISOString();
        const latest = readCrewRecords(root);
        latest[id] = { ...(latest[id] ?? rec), stoppedAt };
        writeStateFile(root, join(root, 'crew.json'), `${JSON.stringify(latest, null, 2)}\n`);
        print({ item: id, name: rec.name, pid: rec.pid, stoppedAt });
        return 0;
      }

      case 'metrics': {
        print(computeMetrics(readMetricEvents(stateRoot())));
        return 0;
      }

      default:
        throw new UsageError(cmd ? `unknown command ${cmd}` : 'missing command');
    }
  } catch (e) {
    if (e instanceof UsageError) {
      stderr(`studio: ${e.message}\n${USAGE}`);
    } else {
      const err = e as Error;
      stderr(`studio: ${err.message}\n`);
      if (debug && err.stack) stderr(`${err.stack}\n`);
    }
    return 1;
  }
}

function parseCli(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        project: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

async function prInfo(
  ports: Ports,
  repo: string,
  pr: number,
): Promise<{ head: string; branch: string }> {
  const r = await ports.gh.run([
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'headRefOid,headRefName,headRepository,headRepositoryOwner,isCrossRepository',
  ]);
  if (r.code !== 0) throw new Error(`cannot read ${repo}#${pr} (gh exit ${r.code})`);
  let raw: {
    headRefOid?: unknown;
    headRefName?: unknown;
    headRepository?: { name?: unknown } | null;
    headRepositoryOwner?: { login?: unknown } | null;
    isCrossRepository?: unknown;
  } | null;
  try {
    raw = JSON.parse(r.stdout) as typeof raw;
  } catch {
    raw = null;
  }
  const head = raw?.headRefOid;
  const branch = raw?.headRefName;
  if (typeof head !== 'string' || !/^[0-9a-f]{40,64}$/i.test(head) || typeof branch !== 'string') {
    throw new Error(`gh returned no valid head for ${repo}#${pr}`);
  }
  // Only a branch of the item's own repository counts: no forks.
  const headRepo = `${String(raw?.headRepositoryOwner?.login)}/${String(raw?.headRepository?.name)}`;
  if (raw?.isCrossRepository !== false || headRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`PR ${repo}#${pr} does not come from a branch of ${repo}`);
  }
  return { head, branch };
}

const PR_OPTIONAL: readonly WorkItem['type'][] = ['review', 'research'];
const MAX_NOTES = 10;
const MAX_NOTE_CHARS = 500;

/** Crew-provided text is untrusted: at most 10 entries of 500 characters, no control characters. */
function capNotes(notes: string[]): string[] {
  return notes.slice(0, MAX_NOTES).map((n) => n.replace(/\p{Cc}/gu, ' ').slice(0, MAX_NOTE_CHARS));
}

function refuseNativeQueue(config: StudioConfig): void {
  if (config.merge.strategy === 'native-queue') {
    throw new Error(
      'merge.strategy native-queue is not supported yet (planned for stage d); use studio-queue',
    );
  }
}

const doneMatches = (d: QueueDone, item: WorkItem): boolean =>
  d.item === undefined ? d.repo === item.repo && d.pr === item.pr : d.item === item.id;

/**
 * A run that stopped after recording a result but before moving the board leaves the item
 * `queued`. For every queued item that is neither pending nor current, apply its last result.
 */
function reconcileQueued(
  project: string,
  state: QueueState,
  ports: Ports,
  stderr: (s: string) => void,
): void {
  const board = loadBoard(project);
  const waiting = [...state.pending, ...(state.current ? [state.current] : [])];
  const results: QueueDone[] = [];
  for (const item of board.items) {
    if (item.status !== 'queued') continue;
    if (
      waiting.some((e) =>
        e.item === undefined ? e.pr === item.pr && e.repo === item.repo : e.item === item.id,
      )
    ) {
      continue;
    }
    const last = state.done.filter((d) => doneMatches(d, item)).at(-1);
    if (last) results.push(last);
  }
  applyQueueResults(project, results, ports, stderr);
}

/** Moves board items for finished queue entries: merged, or back to review with a note. */
function applyQueueResults(
  project: string,
  done: QueueDone[],
  ports: Ports,
  stderr: (s: string) => void,
): void {
  if (done.length === 0) return;
  let board = loadBoard(project);
  const now = ports.clock.now();
  for (const d of done) {
    const item = board.items.find((i) => doneMatches(d, i));
    if (!item) continue;
    if (item.status !== 'queued') {
      stderr(`warning: ${item.id} is ${item.status}, not queued; board left as is\n`);
      continue;
    }
    if (d.result === 'merged') {
      board = transition(board, item.id, 'merged', BY, now);
    } else {
      board = withItem(transition(board, item.id, 'in_review', BY, now), item.id, (i) => ({
        ...i,
        notes: [...(i.notes ?? []), `merge failed: ${d.reason ?? 'unknown reason'}`],
      }));
    }
  }
  saveBoard(project, board);
}

function buildSnapshot(
  root: string,
  board: Board,
  capacity: Capacity,
  queue: QueueState,
  now: Date,
): StateSnapshot {
  const crew: CrewSnapshot[] = Object.values(readCrewRecords(root)).map((r) => {
    const item = board.items.find((i) => i.id === r.item);
    return {
      name: r.name,
      role: r.role,
      item: r.item,
      status: item?.status ?? 'unknown',
      ...(item?.pr === undefined ? {} : { pr: item.pr }),
      since: r.startedAt,
    };
  });
  return {
    crew,
    queue,
    capacity,
    forOwner: board.items
      .filter((i) => i.ownerOnly && i.status !== 'merged' && i.status !== 'dropped')
      .map((i) => ({ id: i.id, title: i.title })),
    updatedAt: now.toISOString(),
    metrics: computeMetrics(readMetricEvents(root)),
  };
}
