import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Board, loadBoard, saveBoard, transition, type WorkItem } from './board.js';
import { capabilitiesDir } from './capabilities.js';
import { readCapacity } from './capacity.js';
import {
  configWarnings,
  loadConfig,
  loadOwnerConfig,
  type OwnerConfig,
  type StudioConfig,
} from './config.js';
import { limitHold } from './credentials.js';
import { crewStateOf, isItemId, launchCrew } from './crew.js';
import {
  activeParks,
  blockHold,
  blockLine,
  clearBlocks,
  type Parks,
  readBlocks,
  readLimits,
  reconcileBlocks,
  reconcileLimits,
  validLabel,
} from './limits.js';
import { readMainBuild } from './main-build.js';
import { sendNotifications } from './notify.js';
import { migrateOwnerState, pendingLegacyState } from './owner-state.js';
import {
  checkStateMarker,
  ownerStateRootFor,
  projectRealpath,
  stateDirName,
  stateRootFor,
  writeStateFile,
} from './paths.js';
import { clearPause, PAUSED_LINE, readPause, setPause } from './pause.js';
import { type Capacity, planAssignments } from './planner.js';
import type { Ports } from './ports.js';
import {
  acquireQueueRunLock,
  enqueue,
  installSignalRelease,
  loadQueue,
  type QueueDone,
  type QueueEntry,
  type QueueState,
  runQueue,
  takeNextPending,
  updateQueue,
} from './queue.js';
import { checkReportHead, readReport } from './report.js';
import {
  checkReviewCaps,
  MAX_FIX_ATTEMPTS,
  MAX_REVIEW_ROUNDS,
  readCrewCaps,
  reviewRounds,
} from './review.js';
import {
  acceptLesson,
  dropLesson,
  listLessons,
  proposeLessons,
  pruneLesson,
} from './role-memory.js';
import { runDoctor, runSecretSet } from './secret-command.js';
import { runSetupCi } from './setup-ci-command.js';
import { applySource, checkSources, loadSources, setupSources } from './sources.js';
import { runSetupStack } from './stack.js';
import {
  type CrewSnapshot,
  computeMetrics,
  type Notification,
  readCrewRecords,
  readMetricEvents,
  type StateSnapshot,
  writeState,
} from './state.js';
import {
  credentialSlots,
  dayKey,
  LABEL_FULL_LINE,
  labelUsageSnapshot,
  readUsage,
  runningPerLabel,
} from './usage.js';

export interface CliDeps {
  ports: Ports;
  stdout(s: string): void;
  stderr(s: string): void;
  env: Record<string, string | undefined>;
  homedir: string;
  cwd: string;
  /** Hidden terminal input; missing or undefined means there is no terminal. */
  readSecret?: (prompt: string) => Promise<string | undefined>;
  /** Stdin and stdout are a terminal; missing means there is none. */
  isTerminal?: boolean;
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
  pause                    Owner only: nothing new starts or merges until resume
  resume                   Owner only: lift the pause
  stop <id>                Stop a crew session
  metrics                  Lead time and deployment frequency
  setup sources [<id>...]  Fetch the referenced third-party sources (nothing runs)
  lessons [list]           Lessons crews proposed for the role memory
  lessons accept <n>       Move a proposed lesson into its role file
  lessons drop <n>         Discard a proposed lesson
  lessons prune <role> <l> Remove a lesson line from a role file
  escalate <id>            Run a stuck item on the role's stronger model
  sources list             Third-party sources and their licences
  sources check            Judge upstream updates: fits, unclear or conflict; adopts nothing
  sources apply <id>       Adopt a candidate that fits
  setup ci [--write]       Detect CI runners, propose the ci: block, lint workflows
  setup stack [--write]    Detect the project's stacks from its manifest files
  secret set crew-token    Store the crew's GitHub token (hidden input, checked first)
  doctor                   What is set and what is missing, never values
  accounts-clear <label>   Owner only, in a terminal: clear a label's account block
`;

class UsageError extends Error {}

const BY = 'studio';

const LEGACY_LINE =
  'old project state files are not migrated yet: no merge until they are (run any studio command again)';

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
    let migrated = false;
    /** The owner-wide state; the first use in a process merges what old versions left behind. */
    const ownerRoot = () => {
      const root = ownerStateRootFor(owner);
      if (!migrated) {
        migrated = true;
        for (const line of migrateOwnerState(root, ports.clock.now())) stderr(`error: ${line}\n`);
      }
      return root;
    };
    /** Binds the state root to this project before the first write (launch does the same). */
    const boundStateRoot = async () => {
      const root = stateRoot();
      const url = (await ports.git.run(project, ['remote', 'get-url', 'origin'])).trim();
      checkStateMarker(root, { projectRealpath: projectRealpath(project), originUrl: url });
      return root;
    };
    /**
     * Applies account blocks, then usage limits, found in the crew logs; runs before anything looks
     * at the board. Returns whether the block reconcile could not run.
     */
    const reconcile = async (): Promise<boolean> => {
      const b = await reconcileBlocks({
        project,
        stateRoot: stateRoot(),
        ownerRoot: ownerRoot(),
        ports,
      });
      for (const s of b.stopped) {
        const where = s.root === undefined ? '' : ` in ${s.root}`;
        stderr(`note: ${s.item}${where} on ${s.label} stopped: account block (${s.reason})\n`);
      }
      for (const e of b.errors) stderr(`error: ${e}\n`);
      const r = await reconcileLimits({
        project,
        stateRoot: stateRoot(),
        ownerRoot: ownerRoot(),
        ports,
      });
      for (const s of r.stopped) {
        stderr(
          `note: ${s.item} stopped at a ${s.kind} limit, ${s.label} parked until ${s.parkedUntil}\n`,
        );
      }
      for (const e of r.errors) stderr(`error: ${e}\n`);
      return b.lockFailed;
    };
    /**
     * Why crew records of some project cannot be read, as a single line; undefined when they can.
     * They are needed to count running crews per credential label.
     */
    const crewRecordsProblem = (): string | undefined => {
      try {
        runningPerLabel(ownerRoot(), ports);
        return undefined;
      } catch (e) {
        return (e as Error).message.replace(/\p{Cc}/gu, ' ');
      }
    };
    /** `skipLabelCount`: `state` goes on without the per-label room when crew records are unreadable. */
    const planNow = async (config: StudioConfig, board: Board, skipLabelCount = false) => {
      const capacity = await readCapacity(config, ports);
      const ownerConfig = loadOwnerConfig(owner);
      let hold = await limitHold(ownerRoot(), ownerConfig, ports, owner);
      // Room under the per-label limits; asked only while nothing else holds (no provider call
      // during a block).
      let slots: number | undefined;
      let line = hold;
      if (hold === undefined && !skipLabelCount) {
        const got = await credentialSlots({
          ownerRoot: ownerRoot(),
          ownerConfig,
          ports,
          owner,
        });
        if (got.hold !== undefined) {
          hold = got.hold;
          line = got.hold;
        } else {
          slots = got.slots;
          if (slots <= 0) line = LABEL_FULL_LINE;
        }
      }
      return {
        capacity,
        hold: line,
        // A pause holds the plan but is no usage limit: `hold` (the line for the owner) stays as is.
        plan: planAssignments(
          board,
          config,
          capacity,
          runningPerRole(board),
          readPause(stateRoot()).paused ? 'paused' : hold,
          slots,
        ),
      };
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
        await reconcile();
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
        if (await reconcile()) {
          throw new Error(
            'another Studio process is reconciling account blocks; refusing to launch, try again',
          );
        }
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
        await reconcile();
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
          ...(r.label === undefined ? {} : { label: r.label }),
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
        const reviewDone =
          item.type === 'review' && report.status === 'done'
            ? checkReviewCaps(readCrewCaps(stateRoot(), item.id), report)
            : { skipped: [] as string[], target: undefined };
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
        const limitTarget =
          report.status === 'done' && report.verdict === 'changes_requested'
            ? reviewDone.target
            : undefined;
        let fixLimit = false;
        if (limitTarget !== undefined) {
          const rounds = reviewRounds(next, limitTarget);
          fixLimit =
            rounds >= MAX_REVIEW_ROUNDS || (report.findingAttempts ?? 0) >= MAX_FIX_ATTEMPTS;
          const builder = next.items.find(
            (i) => `${i.repo}#${i.pr}` === limitTarget && i.type !== 'review',
          );
          if (fixLimit && builder && builder.status !== 'merged' && builder.status !== 'dropped') {
            if (builder.status !== 'blocked') {
              next = transition(next, builder.id, 'blocked', BY, now);
            }
            next = withItem(next, builder.id, (i) => ({
              ...i,
              notes: [
                ...(i.notes ?? []),
                `fix limit reached: ${rounds} review rounds, attempts on one finding ${report.findingAttempts ?? 'unknown'}`,
              ],
            }));
          }
        }
        saveBoard(project, next);
        // Proposals only: a lesson reaches a role file through `lessons accept`. The item has moved
        // already, so a problem here must not read as a failed collect.
        let lessonsProposed = 0;
        try {
          lessonsProposed = proposeLessons(stateRoot(), item.role, item.id, report.lessons, now);
        } catch (e) {
          stderr(`error: lessons: ${(e as Error).message.replace(/\p{Cc}/gu, ' ')}\n`);
        }
        print({
          item: item.id,
          report: report.status,
          status: findItem(next, item.id).status,
          ...(report.pr === undefined ? {} : { pr: report.pr }),
          ...(report.verdict === undefined ? {} : { verdict: report.verdict }),
          ...(report.reviews === undefined ? {} : { reviews: report.reviews }),
          ...(reviewDone.skipped.length === 0 ? {} : { skipped: reviewDone.skipped }),
          ...(fixLimit ? { fixLimit } : {}),
          ...(lessonsProposed > 0 ? { lessonsProposed } : {}),
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
          /** An account block, a pause, or old state files that were not merged into the owner root. */
          const queueHold = (): string | undefined =>
            blockHold(ownerRoot()) ??
            (readPause(root).paused ? PAUSED_LINE : undefined) ??
            (pendingLegacyState(dirname(ownerRoot())).length > 0 ? LEGACY_LINE : undefined);
          const blockedNow = queueHold();
          if (blockedNow !== undefined) throw new Error(blockedNow);
          let heldLine: string | undefined;
          const hold = () => {
            const line = queueHold();
            if (line !== undefined) heldLine = line;
            return line;
          };
          const log = (m: string) => stderr(`${m}\n`);
          const lock = acquireQueueRunLock(root, ports.clock.now(), log);
          const removeSignals = installSignalRelease(lock);
          const beat = () => lock.heartbeat(ports.clock.now());
          // Every poll and every wait of the queue goes through this clock: each one is a heartbeat.
          const runPorts: Ports = {
            ...ports,
            clock: {
              now: () => ports.clock.now(),
              sleep: async (ms) => {
                beat();
                await ports.clock.sleep(ms);
                beat();
              },
            },
          };
          try {
            const state = loadQueue(root);
            reconcileQueued(project, state, ports, stderr);
            const before = state.done.length;
            await runQueue(
              state,
              config,
              runPorts,
              // The runner owns `current` and `done`; `pending` stays whatever is on disk.
              (q) => {
                beat();
                updateQueue(root, (disk) => {
                  disk.current = q.current;
                  disk.done = q.done;
                });
              },
              {
                stateRoot: root,
                log,
                hold,
                mergeAllowed: (entry) => boardBlocksMerge(project, entry),
                takeNext: () => takeNextPending(root),
                onDone: (d) => applyQueueResults(project, [d], ports, stderr),
              },
            );
            const finished = state.done.slice(before);
            print({
              ...(heldLine === undefined ? {} : { held: heldLine }),
              merged: finished.filter((d) => d.result === 'merged').length,
              failed: finished.filter((d) => d.result === 'failed').length,
              done: finished,
            });
            if (heldLine !== undefined) return 1;
          } finally {
            removeSignals();
            lock.release();
          }
          return 0;
        }
        throw new UsageError('queue needs a subcommand: add <repo>#<pr> | run');
      }

      case 'state': {
        await reconcile();
        const { config, board } = loadAll();
        const root = await boundStateRoot();
        // Crew records of any project that cannot be read: plan and launch refuse, but the pane
        // still gets its state, without the per-label figures, and a line for the owner.
        const crewProblem = crewRecordsProblem();
        if (crewProblem !== undefined) stderr(`error: ${crewProblem}\n`);
        const { capacity, hold } = await planNow(config, board, crewProblem !== undefined);
        const read = readLimits(ownerRoot());
        const ownerConfig = loadOwnerConfig(owner);
        const snapshot = buildSnapshot(
          root,
          ownerRoot(),
          board,
          capacity,
          loadQueue(root),
          ports.clock.now(),
          hold,
          read.ok ? activeParks(read.labels, ports.clock.now()) : {},
          crewProblem === undefined
            ? labelUsageSnapshot({ ownerRoot: ownerRoot(), ownerConfig, ports })
            : undefined,
          {
            config,
            ownerConfig,
            mainBuild: await readMainBuild(config, ports),
            crewRecordsUnreadable: crewProblem !== undefined,
            alive: (pid) => Number.isInteger(pid) && pid > 0 && ports.claude.alive(pid),
            hasReport: (item) =>
              isItemId(item) &&
              existsSync(join(root, 'clones', item, '.studio', 'reports', `${item}.md`)),
          },
        );
        writeState(root, snapshot);
        try {
          for (const line of await sendNotifications({
            ownerRoot: ownerRoot(),
            projectKey: stateDirName(projectRealpath(project)),
            primaryRepo: config.primaryRepo,
            snapshot,
            ownerConfig,
            ports,
            owner,
          })) {
            stderr(`error: ${line}\n`);
          }
        } catch {
          // A notification problem never fails the command.
          stderr('error: notify: could not send notifications\n');
        }
        print(snapshot);
        return 0;
      }

      case 'pause':
      case 'resume': {
        // Owner only: a crew runs without a terminal and with this role in its environment.
        if (deps.env.STUDIO_ROLE === 'crew' || deps.isTerminal !== true) {
          stderr(`studio: ${cmd} is for the owner and needs a terminal; nothing written\n`);
          return 1;
        }
        if (rest.length > 0) throw new UsageError(`${cmd} takes no arguments`);
        const root = await boundStateRoot();
        if (cmd === 'pause') {
          const now = ports.clock.now();
          setPause(root, now);
          print({ paused: true, at: now.toISOString() });
        } else {
          clearPause(root);
          print({ paused: false });
        }
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

      case 'setup': {
        if (rest[0] === 'sources') {
          refuseCrew(deps.env);
          const results = await setupSources({
            ownerRoot: ownerRoot(),
            index: loadSources(),
            ports,
            ...(rest.length > 1 ? { only: rest.slice(1) } : {}),
          });
          print(results);
          return results.some((r) => r.result === 'failed') ? 1 : 0;
        }
        if (rest[0] === 'stack' && rest.length === 1) {
          return runSetupStack({ project, json, write: values.write === true, stdout });
        }
        if (rest[0] !== 'ci' || rest.length !== 1) {
          throw new UsageError(
            'setup needs a subcommand: ci [--write] | stack [--write] | sources [<id>...]',
          );
        }
        return await runSetupCi({
          project,
          ports,
          json,
          write: values.write === true,
          stdout,
        });
      }

      case 'secret': {
        // Never echo these arguments: a value typed here by mistake must not reach the output.
        if (rest.length !== 2 || rest[0] !== 'set' || rest[1] !== 'crew-token') {
          stderr('studio: secret takes exactly: set crew-token (the value is asked for, hidden)\n');
          return 1;
        }
        return await runSecretSet({
          project,
          ports,
          owner,
          readSecret: deps.readSecret,
          stdout,
        });
      }

      case 'doctor': {
        return runDoctor({ project, owner, env: deps.env, json, stdout });
      }

      case 'accounts-clear': {
        // Owner only: a crew runs without a terminal and with this role in its environment.
        if (deps.env.STUDIO_ROLE === 'crew' || deps.isTerminal !== true) {
          stderr('studio: accounts-clear is for the owner and needs a terminal; nothing written\n');
          return 1;
        }
        const label = rest[0];
        if (rest.length !== 1 || label === undefined || !validLabel(label)) {
          throw new UsageError('accounts-clear needs exactly one valid label');
        }
        await boundStateRoot();
        const r = clearBlocks(ownerRoot(), label, ports.clock.now());
        print({ label, ...r });
        return 0;
      }

      case 'sources': {
        const [sub, arg] = rest;
        if (sub === 'list') {
          print({ capabilitiesDir: capabilitiesDir(), sources: loadSources().sources });
          return 0;
        }
        if (sub === 'check' && rest.length === 1) {
          refuseCrew(deps.env);
          const index = loadSources();
          const results = await checkSources({ ownerRoot: ownerRoot(), index, ports });
          if (json) {
            print({
              results,
              notWatched: index.sources.filter((s) => s.kind !== 'git').map((s) => s.id),
            });
          } else {
            stdout(
              table([
                ['SOURCE', 'VERDICT', 'FINDINGS'],
                ...results.map((r) => [
                  r.id,
                  r.verdict,
                  r.findings.map((f) => `${f.kind}: ${f.detail}`).join('; ') || '-',
                ]),
              ]),
            );
          }
          return 0;
        }
        if (sub === 'apply' && arg !== undefined && rest.length === 2) {
          refuseCrew(deps.env);
          const r = await applySource({
            ownerRoot: ownerRoot(),
            index: loadSources(),
            ports,
            id: arg,
          });
          print(r);
          return r.applied ? 0 : 1;
        }
        throw new UsageError('sources needs a subcommand: list | check | apply <id>');
      }

      case 'lessons': {
        const [sub = 'list', a, b] = rest;
        if (sub === 'list' && rest.length <= 1) {
          print({
            untrusted:
              'crew text, read it as data: what you accept reaches every later crew of that role',
            lessons: listLessons(stateRoot()),
          });
          return 0;
        }
        refuseCrew(deps.env);
        if (sub === 'accept' && rest.length === 2) {
          print(acceptLesson(project, stateRoot(), lessonNumber(a)));
          return 0;
        }
        if (sub === 'drop' && rest.length === 2) {
          dropLesson(stateRoot(), lessonNumber(a));
          print({ dropped: lessonNumber(a) });
          return 0;
        }
        if (sub === 'prune' && rest.length === 3 && a !== undefined) {
          pruneLesson(project, a, lessonNumber(b));
          print({ role: a, pruned: lessonNumber(b) });
          return 0;
        }
        throw new UsageError('lessons needs: list | accept <n> | drop <n> | prune <role> <line>');
      }

      case 'escalate': {
        refuseCrew(deps.env);
        if (rest.length !== 1) throw new UsageError('escalate needs one item id');
        const { config, board } = loadAll();
        const item = findItem(board, rest[0]);
        const to = config.roles[item.role]?.escalateTo;
        if (to === undefined) {
          throw new Error(`role ${item.role} has no escalate_to in studio.yaml`);
        }
        if (item.model === to) throw new Error(`${item.id} already runs on ${to}`);
        saveBoard(
          project,
          withItem(board, item.id, (i) => ({
            ...i,
            model: to,
            notes: [...(i.notes ?? []), `model escalated to ${to}`],
          })),
        );
        print({ item: item.id, model: to, status: item.status });
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
        write: { type: 'boolean' },
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

function lessonNumber(arg: string | undefined): number {
  if (!/^[1-9]\d{0,6}$/.test(arg ?? '')) throw new UsageError('a lesson number is needed');
  return Number(arg);
}

/** Crew sessions run with this role: what changes owner state is not theirs. */
function refuseCrew(env: Record<string, string | undefined>): void {
  if (env.STUDIO_ROLE === 'crew') throw new Error('this command is not for crew sessions');
}

function refuseNativeQueue(config: StudioConfig): void {
  if (config.merge.strategy === 'native-queue') {
    throw new Error(
      'merge.strategy native-queue is not supported yet (planned for stage d); use studio-queue',
    );
  }
}

/** Why the board forbids this merge; only a readable board with the item `queued` allows it. */
function boardBlocksMerge(project: string, entry: QueueEntry): string | undefined {
  let board: Board;
  try {
    board = loadBoard(project);
  } catch {
    return 'the board cannot be read';
  }
  const item = board.items.find((i) =>
    entry.item === undefined ? i.repo === entry.repo && i.pr === entry.pr : i.id === entry.item,
  );
  if (item === undefined) return 'the pull request has no board item';
  return item.status === 'queued' ? undefined : `board item ${item.id} is ${item.status}`;
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

interface SnapshotExtra {
  config: StudioConfig;
  ownerConfig: OwnerConfig;
  mainBuild: StateSnapshot['mainBuild'];
  crewRecordsUnreadable: boolean;
  alive(pid: number): boolean;
  hasReport(item: string): boolean;
}

const MAX_MERGED_TODAY = 200;

/** Merges and deploys of one local day, from metric events (anything malformed is skipped). */
function todayFrom(
  events: readonly unknown[],
  now: Date,
  timezone: string | undefined,
): StateSnapshot['today'] {
  const day = dayKey(now, timezone);
  const merged: (StateSnapshot['today']['merged'][number] & { t: number })[] = [];
  let deployed = 0;
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue;
    const ev = raw as Record<string, unknown>;
    if ((ev.type !== 'merged' && ev.type !== 'deployed') || typeof ev.at !== 'string') continue;
    const t = Date.parse(ev.at);
    if (Number.isNaN(t) || dayKey(new Date(t), timezone) !== day) continue;
    if (ev.type === 'deployed') deployed++;
    else if (typeof ev.pr === 'number' && Number.isInteger(ev.pr)) {
      merged.push({ pr: ev.pr, repo: typeof ev.repo === 'string' ? ev.repo : '', at: ev.at, t });
    }
  }
  merged.sort((a, b) => a.t - b.t);
  return {
    day,
    merged: merged.slice(-MAX_MERGED_TODAY).map(({ pr, repo, at }) => ({ pr, repo, at })),
    deployed,
  };
}

function usageDaysFrom(ownerRoot: string): StateSnapshot['usageDays'] {
  const read = readUsage(ownerRoot);
  if (!read.ok) return undefined;
  const days: Record<string, Record<string, number>> = {};
  for (const day of Object.keys(read.days).sort()) {
    const labels = Object.entries(read.days[day] ?? {}).filter(([, n]) => typeof n === 'number');
    if (labels.length > 0) days[day] = Object.fromEntries(labels);
  }
  return Object.keys(days).length === 0 ? undefined : days;
}

function buildSnapshot(
  root: string,
  ownerRoot: string,
  board: Board,
  capacity: Capacity,
  queue: QueueState,
  now: Date,
  hold: string | undefined,
  limits: Parks,
  labelUsage: StateSnapshot['labelUsage'],
  extra: SnapshotExtra,
): StateSnapshot {
  const blocks = readBlocks(ownerRoot);
  const blocked = blockLine(blocks);
  const notifications: Notification[] = blocks.ok
    ? blocks.blocks.map((b) => ({
        id: 'account-block',
        title: `account block on ${b.label}: ${b.reason}`,
        reason: b.reason,
        at: b.at,
        label: b.label,
      }))
    : [
        {
          id: 'account-block',
          title: blocked ?? 'account block',
          reason: 'state_unreadable',
          at: now.toISOString(),
        },
      ];
  const crew: CrewSnapshot[] = Object.values(readCrewRecords(root)).map((r) => {
    const item = board.items.find((i) => i.id === r.item);
    const status = item?.status ?? 'unknown';
    return {
      name: r.name,
      role: r.role,
      item: r.item,
      status,
      ...(item?.pr === undefined ? {} : { pr: item.pr }),
      since: r.startedAt,
      ...(r.label === undefined ? {} : { label: r.label }),
      ...(item === undefined ? {} : { title: item.title, repo: item.repo }),
      state: crewStateOf(r, status, extra.alive(r.pid), extra.hasReport(r.item)),
      ...(r.stoppedAt === undefined ? {} : { stoppedAt: r.stoppedAt }),
    };
  });
  const events = readMetricEvents(root);
  const usageDays = usageDaysFrom(ownerRoot);
  return {
    crew,
    queue,
    capacity,
    ci: {
      busy: capacity.ciBusy,
      total: capacity.ciTotal,
      mergeMaxBusy: extra.config.ci.capacity.mergeMaxBusy,
      ok: capacity.ok,
    },
    today: todayFrom(events, now, extra.ownerConfig.crewLabelLimits.timezone),
    ...(usageDays === undefined ? {} : { usageDays }),
    mainBuild: extra.mainBuild,
    counts: {
      ready: board.items.filter((i) => i.status === 'ready').length,
      queued: queue.pending.length + (queue.current === undefined ? 0 : 1),
    },
    forOwner: [
      ...board.items
        .filter((i) => i.ownerOnly && i.status !== 'merged' && i.status !== 'dropped')
        .map((i) => ({ id: i.id, title: i.title })),
      // Exactly one line however many items wait or labels are blocked; a block outranks a limit.
      ...(blocked !== undefined
        ? [{ id: 'account-block', title: blocked }]
        : hold === undefined
          ? []
          : [{ id: 'usage-limit', title: hold }]),
      ...(extra.crewRecordsUnreadable
        ? [
            {
              id: 'crew-records',
              title:
                'crew records of a project are unreadable: no crew starts and per-label usage is not shown until the owner inspects or removes the file',
            },
          ]
        : []),
    ],
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(labelUsage === undefined ? {} : { labelUsage }),
    ...(notifications.length > 0 ? { notifications } : {}),
    updatedAt: now.toISOString(),
    metrics: computeMetrics(events),
  };
}
