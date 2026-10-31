import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Board, loadBoard, saveBoard, transition, type WorkItem } from './board.js';
import { readCapacity } from './capacity.js';
import { configWarnings, loadConfig, type StudioConfig } from './config.js';
import { launchCrew } from './crew.js';
import { checkStateMarker, projectRealpath, stateRootFor, writeStateFile } from './paths.js';
import { type Capacity, planAssignments } from './planner.js';
import type { Ports } from './ports.js';
import { loadQueue, type QueueState, runQueue, saveQueue } from './queue.js';
import { collectReport, type Report } from './report.js';
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
        const { plan } = await planNow(config, board);
        print({
          assign: plan.assign.map((i) => ({ id: i.id, title: i.title, role: i.role })),
          blocked: plan.blocked,
          deferred: plan.deferred,
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
        // Reading files only: git never runs inside a crew clone.
        const clone = join(stateRoot(), 'clones', item.id);
        const first = collectReport(clone, item.id, undefined, item);
        let report: Report = first;
        if (first.pr !== undefined) {
          const head = await prHead(ports, item.repo, first.pr);
          report = collectReport(clone, item.id, head, item);
        } else if (first.status === 'done') {
          throw new Error(`done report for ${item.id} names no pr`);
        }
        const now = ports.clock.now();
        let next = board;
        if (report.status === 'done') {
          if (item.status === 'assigned') next = transition(next, item.id, 'in_progress', BY, now);
          next = transition(next, item.id, 'in_review', BY, now);
          const pr = report.pr as number;
          next = withItem(next, item.id, (i) => ({ ...i, pr, branch: `studio/${item.id}` }));
        } else {
          next = transition(next, item.id, 'blocked', BY, now);
          const notes =
            report.status === 'failed'
              ? ['crew run failed', ...report.questions.map((q) => `question: ${q}`)]
              : report.questions.map((q) => `question: ${q}`);
          next = withItem(next, item.id, (i) => ({
            ...i,
            notes: [...(i.notes ?? []), ...(notes.length ? notes : ['crew reported blocked'])],
          }));
        }
        saveBoard(project, next);
        print({
          item: item.id,
          report: report.status,
          status: findItem(next, item.id).status,
          ...(report.pr === undefined ? {} : { pr: report.pr }),
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
          if (!config.repos.includes(repo)) throw new Error(`repository ${repo} is not configured`);
          const item = board.items.find((i) => i.pr === pr && i.repo === repo);
          if (!item) throw new Error(`no board item has PR ${repo}#${pr}`);
          if (item.status !== 'in_review') {
            throw new Error(`${item.id} is ${item.status}, only in_review items can be queued`);
          }
          const root = await boundStateRoot();
          const q = loadQueue(root);
          const dup = [...q.pending, ...(q.current ? [q.current] : [])].some(
            (e) => e.pr === pr && e.repo === repo,
          );
          if (dup) throw new Error(`${repo}#${pr} is already in the queue`);
          q.pending.push({ pr, repo, item: item.id });
          saveQueue(root, q);
          saveBoard(project, transition(board, item.id, 'queued', BY, ports.clock.now()));
          print({ queued: item.id, pr, repo, pending: q.pending.length });
          return 0;
        }
        if (sub === 'run') {
          const { config } = loadAll();
          const root = await boundStateRoot();
          const state = loadQueue(root);
          const before = state.done.length;
          try {
            await runQueue(state, config, ports, (q) => saveQueue(root, q), {
              stateRoot: root,
              log: (m) => stderr(`${m}\n`),
            });
          } finally {
            applyQueueResults(project, state.done.slice(before), ports, stderr);
          }
          print({
            merged: state.done.slice(before).filter((d) => d.result === 'merged').length,
            failed: state.done.slice(before).filter((d) => d.result === 'failed').length,
            done: state.done.slice(before),
          });
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

async function prHead(ports: Ports, repo: string, pr: number): Promise<string> {
  const r = await ports.gh.run(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid']);
  if (r.code !== 0) throw new Error(`cannot read the head of ${repo}#${pr} (gh exit ${r.code})`);
  let oid: unknown;
  try {
    oid = (JSON.parse(r.stdout) as { headRefOid?: unknown } | null)?.headRefOid;
  } catch {
    oid = undefined;
  }
  if (typeof oid !== 'string' || !/^[0-9a-f]{40,64}$/i.test(oid)) {
    throw new Error(`gh returned no valid head for ${repo}#${pr}`);
  }
  return oid;
}

/** Moves board items for the queue entries finished in this run: merged, or back to review. */
function applyQueueResults(
  project: string,
  done: QueueState['done'],
  ports: Ports,
  stderr: (s: string) => void,
): void {
  if (done.length === 0) return;
  let board = loadBoard(project);
  const now = ports.clock.now();
  for (const d of done) {
    const item = board.items.find((i) => i.id === d.item);
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
