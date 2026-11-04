import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runAccount } from './account-command.js';
import {
  type ApprovedJob,
  type Board,
  componentsOf,
  loadBoard,
  type NotRunHere,
  saveBoard,
  transition,
  type WorkItem,
} from './board.js';
import { capabilitiesDir } from './capabilities.js';
import { readCapacity, readCapacityTwice } from './capacity.js';
import { approvedJobsProblem, type CoveredJob, verifyNotRunHereJobs } from './ci-jobs.js';
import {
  configWarnings,
  loadConfig,
  loadOwnerConfig,
  type OwnerConfig,
  type OwnerEnv,
  type RoleConfig,
  type StudioConfig,
} from './config.js';
import { limitHold, readCrewTokenFile } from './credentials.js';
import {
  type CrewRecord,
  crewHold,
  crewStateOf,
  githubHttpsUrl,
  isItemId,
  launchCrew,
  resolveModel,
  unverifiedHandgrip,
  unverifiedRefusal,
} from './crew.js';
import { listFlaky, recordFlaky } from './flaky.js';
import {
  activeParks,
  blockHold,
  blockLine,
  clearBlocks,
  crewProcess,
  type Parks,
  readBlocks,
  readLimits,
  reconcileBlocks,
  reconcileLimits,
  validLabel,
} from './limits.js';
import { readMainBuild } from './main-build.js';
import { sendNotifications } from './notify.js';
import { formatOverview, readOverview } from './overview.js';
import { migrateOwnerState, pendingLegacyState } from './owner-state.js';
import {
  checkStateMarker,
  ownerStateRootFor,
  projectRealpath,
  stateBaseFor,
  stateDirName,
  stateRootFor,
  withBoardLock,
  writeStateFile,
} from './paths.js';
import { clearPause, PAUSED_LINE, readPause, setPause } from './pause.js';
import { type Capacity, ONE_BUILD_PER_PLAN, planAssignments } from './planner.js';
import type { Ports } from './ports.js';
import {
  acquireQueueRunLock,
  appendStateLine,
  approvalProblem,
  enqueue,
  installSignalRelease,
  loadQueue,
  type QueueDone,
  type QueueEntry,
  type QueueState,
  readChecks,
  runQueue,
  takeNextPending,
  updateQueue,
  viewPr,
} from './queue.js';
import { checkReportHead, readReport, reportName } from './report.js';
import {
  checkReviewCaps,
  checksPending,
  MAX_FIX_ATTEMPTS,
  MAX_REVIEW_ROUNDS,
  newerReview,
  openReview,
  readCrewCaps,
  reviewRounds,
  reviewTarget,
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
import { searchSolutions } from './solutions.js';
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
  board [--component <id>] Show the board, or the items of one component
  plan                     Dry-run the planner (JSON)
  launch <id>              Start a crew session for a planned item
  status                   Crew sessions and their board status
  overview                 Owner only, in a terminal: every project of this owner, read only
  collect <id>             Read a crew report and move the item
  queue add <repo>#<pr>    Put a reviewed PR into the merge queue
  queue run                Merge the queued PRs, one at a time
  state                    Refresh state.json in the state root
  pause                    Owner only: nothing new starts or merges until resume
  resume                   Owner only: lift the pause
  stop <id> [--release] [--requeue]  Stop a crew session; --release closes the record of one it cannot verify, --requeue puts its item back to ready
  drop <id>                End an item; refuses while its crew runs
  link <id> <repo>#<pr>    Owner only, in a terminal: tie a pull request opened by hand to its item
  metrics                  Lead time, deploy frequency, change failure rate, time to restore
  deploy record [<sha>]    Record a production deploy
  incident open <id>       Record that a deploy broke something
  incident resolve <id>    Record that service is restored
  flaky record <t> <s> pass|fail  Record a test that failed once, with its rerun
  flaky [list]             The flaky-test ledger, worst first
  solutions search <words> Earlier solutions in .studio/solutions
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
  account add <label>      Owner only, in a terminal: store a token from claude setup-token
  account list             Stored Claude accounts and their state, never a token
  account use <label>      Owner only, in a terminal: make another account the active one
  account remove <label>   Owner only, in a terminal: remove a stored account
  account setup-plugins    Install the plugins crews need into the crew config dir
  accounts-clear <label>   Owner only, in a terminal: clear a label's account block
`;

class UsageError extends Error {}

const BY = 'studio';
/** The note `stop --requeue` leaves; a second requeue finds it and keeps the item blocked. */
const REQUEUE_NOTE = 'requeued: crew stopped without a usable report';
const SHORT_SHA = /^[0-9a-f]{7,64}$/i;
const INCIDENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

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
      return { config, board: loadBoard(project, config) };
    };
    if (values.component !== undefined && cmd !== 'board') {
      throw new UsageError('--component works with board only');
    }
    /** The item's components, as a field for JSON output; nothing when none are configured. */
    const componentField = (config: StudioConfig | undefined, item: WorkItem | undefined) =>
      config?.components === undefined
        ? {}
        : { components: item === undefined ? [] : componentsOf(item, config) };
    const componentCell = (ids: string[] | undefined) =>
      ids === undefined || ids.length === 0 ? '-' : ids.join(',');
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
      // A review waits until the checks of its pull request head have completed.
      const ciPending = new Set<string>();
      for (const i of board.items) {
        const target = i.status === 'ready' && i.type === 'review' ? reviewTarget(i) : undefined;
        if (target !== undefined && (await checksPending(ports, target))) ciPending.add(i.id);
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
          ciPending,
        ),
      };
    };

    switch (cmd) {
      case 'board': {
        const { config, board } = loadAll();
        const only = values.component;
        if (only !== undefined && !(config.components ?? []).some((c) => c.id === only)) {
          throw new Error(`unknown component ${only}`);
        }
        const items = board.items
          .map((i) => ({ item: i, ...componentField(config, i) }))
          .filter((r) => only === undefined || r.components?.includes(only));
        if (json) print(items.map(({ item, ...rest }) => ({ ...item, ...rest })));
        else {
          const withComponents = config.components !== undefined;
          stdout(
            table([
              [
                'ID',
                'STATUS',
                'ROLE',
                'TYPE',
                'PRIORITY',
                ...(withComponents ? ['COMPONENT'] : []),
                'TITLE',
              ],
              ...items.map(({ item: i, components }) => [
                i.id,
                i.status,
                i.role,
                i.type,
                String(i.priority),
                ...(withComponents ? [componentCell(components)] : []),
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
        let solutionsError: string | undefined;
        const solutionsFor = (i: WorkItem) => {
          try {
            return searchSolutions(project, [i.title, ...i.touches].join(' '));
          } catch {
            solutionsError = 'the solutions store cannot be read';
            return [];
          }
        };
        print({
          assign: plan.assign.map((i) => ({
            id: i.id,
            title: i.title,
            role: i.role,
            solutions: solutionsFor(i),
            ...componentField(config, i),
          })),
          ...(solutionsError === undefined ? {} : { solutionsError }),
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
        // One launch is one build start against this plan's host reading: a build the plan put
        // behind another one's start may be the one started now.
        const launchable =
          plan.assign.some((i) => i.id === item.id) ||
          plan.deferred.some((d) => d.id === item.id && d.reason === ONE_BUILD_PER_PLAN);
        if (!launchable) {
          const why =
            plan.blocked.find((b) => b.id === item.id)?.reason ??
            plan.deferred.find((d) => d.id === item.id)?.reason ??
            'not in the current plan';
          throw new Error(`${item.id} is not in the current plan: ${why}`);
        }
        const res = await launchCrew(project, item, config, ports, owner);
        // The launch took a while: re-read the board and move the item on the fresh copy.
        await withBoardLock(stateRoot(), ports.clock.now(), () => {
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
        });
        print(res);
        return 0;
      }

      case 'status': {
        await reconcile();
        // Status never needed the config: one that cannot be read costs the component column
        // only, silently, so the heartbeat's output stays as it was.
        let config: StudioConfig | undefined;
        try {
          config = loadConfig(project);
        } catch {
          config = undefined;
        }
        const board = loadBoard(project, config);
        const root = stateRoot();
        const rows = Object.values(readCrewRecords(root)).map((r) => {
          const item = board.items.find((i) => i.id === r.item);
          return {
            name: r.name,
            item: r.item,
            role: r.role,
            pid: r.pid,
            alive: ports.claude.alive(r.pid),
            status: item?.status ?? 'unknown',
            startedAt: r.startedAt,
            ...(r.label === undefined ? {} : { label: r.label }),
            ...(r.stoppedAt === undefined ? {} : { stoppedAt: r.stoppedAt }),
            ...componentField(config, item),
          };
        });
        if (json) print(rows);
        else {
          const withComponents = config?.components !== undefined;
          stdout(
            table([
              [
                'ITEM',
                'NAME',
                'ROLE',
                'PID',
                'ALIVE',
                'STATUS',
                ...(withComponents ? ['COMPONENT'] : []),
              ],
              ...rows.map((r) => [
                r.item,
                r.name,
                r.role,
                String(r.pid),
                r.alive ? 'yes' : 'no',
                r.status,
                ...(withComponents ? [componentCell(r.components)] : []),
              ]),
            ]),
          );
        }
        return 0;
      }

      case 'overview': {
        // Read only across projects: no reconcile, no migration of the owner state, no state root.
        // It shows every project of the owner, so, like pause, it needs the owner in a terminal.
        if (deps.env.STUDIO_ROLE === 'crew' || deps.isTerminal !== true) {
          stderr('studio: overview is for the owner and needs a terminal; nothing read\n');
          return 1;
        }
        if (rest.length > 0) throw new UsageError('overview takes no arguments');
        const list = readOverview(stateBaseFor(owner), (pid) => ports.claude.alive(pid));
        if (json) print(list);
        else stdout(formatOverview(list));
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
          const hold = await crewHold(record, ports);
          if (hold === 'unverified') throw new Error(unverifiedRefusal(record));
          if (hold === 'running') {
            throw new Error(
              `crew ${record.name} is still running (pid ${record.pid}); collect after it exited, or stop it first`,
            );
          }
          if ((await crewProcess(record, ports)) === 'unknown') {
            stderr(`warning: ${unverifiedHandgrip(record)}\n`);
          }
          notBefore = new Date(record.startedAt);
          if (Number.isNaN(notBefore.getTime())) {
            throw new Error(`crew record for ${item.id} has no valid startedAt`);
          }
        }
        // Reading files only: git never runs inside a crew clone.
        const clone = join(stateRoot(), 'clones', item.id);
        // The report is read exactly once; everything below verifies and stores that one result.
        const fileName = reportName(stateRoot(), item.id);
        if (fileName === undefined) {
          throw new Error(`no report name was drawn for ${item.id}: relaunch it, nothing moved`);
        }
        let report = readReport(clone, item.id, item, { notBefore, fileName });
        const reviewDone =
          item.type === 'review' && report.status === 'done'
            ? checkReviewCaps(readCrewCaps(stateRoot(), item.id), report)
            : { skipped: [] as string[], target: undefined, notRunHere: undefined };
        let approvedJobs: ApprovedJob[] = [];
        let covered: CoveredJob[] = [];
        // A verdict counts for the commit reviewed: the pull request's head right now.
        if (item.type === 'review' && report.status === 'done' && reviewDone.target !== undefined) {
          const m = /^(.+)#(\d+)$/.exec(reviewDone.target) as RegExpExecArray;
          const info = await prInfo(ports, m[1] as string, Number(m[2]));
          checkReportHead(report, info.head);
          // The reviewer could not see CI: an approval counts only while the checks are green.
          if (report.verdict === 'approve') {
            const checks = await readChecks({ repo: m[1] as string, pr: Number(m[2]) }, ports.gh);
            if (checks.kind !== 'pass') {
              const why =
                checks.kind === 'pending' ? 'still running' : (checks.reason ?? checks.kind);
              throw new Error(
                `the approval counts only with green checks (${why}); collect again once they pass, nothing moved`,
              );
            }
            // A skipped check counts as green above, so each command the builder could not run
            // needs a job of a base workflow that runs it and passed here. A refusal goes to the
            // lead: the review item is blocked with a note, the approval is not stored.
            if (reviewDone.notRunHere !== undefined) {
              const config = loadConfig(project);
              const gate = await verifyNotRunHereJobs({
                git: ports.git,
                checkout: approvalCheckout(project, config, m[1] as string),
                baseOid: info.baseOid,
                headOid: info.head,
                ciItem: reviewDone.ciItem === true,
                commands: reviewDone.notRunHere,
                entries: report.notRunHereJobs,
                checks: checks.checks,
              });
              if (!gate.ok) {
                const note = `approval refused: not_run_here entry ${gate.entry}: ${gate.why}`;
                await withBoardLock(stateRoot(), ports.clock.now(), () => {
                  const fresh = loadBoard(project);
                  if (findItem(fresh, item.id).status !== item.status) {
                    throw new Error(`${item.id} changed while it was collected; nothing moved`);
                  }
                  let next = transition(fresh, item.id, 'blocked', BY, ports.clock.now());
                  next = withItem(next, item.id, (i) => ({
                    ...i,
                    notes: [...(i.notes ?? []), note],
                  }));
                  saveBoard(project, next);
                });
                stderr(`${item.id}: ${note}; no approval, ${item.id} is blocked for the lead\n`);
                return 1;
              }
              approvedJobs = gate.jobs;
              covered = gate.covered;
            }
          }
        }
        let branch = `studio/${item.id}`;
        if (
          report.status === 'done' &&
          report.pr === undefined &&
          report.prTitle !== undefined &&
          !PR_OPTIONAL.includes(item.type)
        ) {
          const config = loadConfig(project);
          const token = crewTokenFor(config, owner);
          // Opening the pull request is what starts CI: it waits for capacity like a merge does.
          // The capacity wait runs without the board lock: right before `gh pr create`, the item
          // must still be as collect found it.
          const unchanged = () => {
            const now = findItem(loadBoard(project), item.id);
            if (now.status !== item.status || now.branch !== item.branch) {
              throw new Error(
                `${item.id} changed while waiting for CI capacity (now ${now.status}); no pull request was opened`,
              );
            }
          };
          const opened = await openCrewPr(
            ports,
            item,
            report.prTitle,
            report.body,
            report.notRunHere,
            token,
            () => readCapacityTwice(config, ports),
            unchanged,
          );
          if ('held' in opened) {
            const note = prHeldNote(opened.held, config);
            await withBoardLock(stateRoot(), ports.clock.now(), () => {
              const fresh = loadBoard(project);
              if (findItem(fresh, item.id).status !== item.status) {
                throw new Error(`${item.id} changed while it was collected; nothing moved`);
              }
              // Only the latest hold is kept, so repeated collects do not pile up notes.
              const held = withItem(fresh, item.id, (i) => ({
                ...i,
                notes: [...(i.notes ?? []).filter((n) => !n.startsWith(PR_HELD)), note],
              }));
              saveBoard(project, held);
            });
            stderr(
              `${item.id}: ${note}; the pull request was not opened and branch studio/${item.id} stays as it is. Run studio collect ${item.id} again once CI has room.\n`,
            );
            return 1;
          }
          report = { ...report, pr: opened.pr };
        }
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
        // Under the lock from reading the board again to saving it: a launch clearing an approval
        // cannot slip in, and what moved while GitHub was asked stays.
        const { next, fixLimit, supersededBy } = await withBoardLock(stateRoot(), now, () => {
          const fresh = loadBoard(project);
          if (findItem(fresh, item.id).status !== item.status) {
            throw new Error(`${item.id} changed while it was collected; nothing moved`);
          }
          const supersededBy =
            item.type === 'review' && report.status === 'done' && reviewDone.target !== undefined
              ? newerReview(stateRoot(), item.id, reviewDone.target, readCrewRecords(stateRoot()))
              : undefined;
          let next = fresh;
          if (report.status === 'done') {
            if (item.status === 'assigned')
              next = transition(next, item.id, 'in_progress', BY, now);
            next = transition(next, item.id, 'in_review', BY, now);
            if (report.pr !== undefined) {
              const pr = report.pr;
              // A pull request exists now: an earlier hold is over (history keeps the moves).
              // What CI must cover is the latest report's list; an earlier one is replaced.
              next = withItem(next, item.id, (i) => {
                const notes = (i.notes ?? []).filter((n) => !n.startsWith(PR_HELD));
                const { notes: _n, notRunHere: _r, ...rest } = i;
                return {
                  ...rest,
                  ...(notes.length > 0 ? { notes } : {}),
                  ...(report.notRunHere.length > 0 ? { notRunHere: report.notRunHere } : {}),
                  pr,
                  branch,
                };
              });
            } else {
              // Review and research items open no PR: the result is the report itself.
              next = transition(next, item.id, 'merged', BY, now);
              // A superseded verdict is no round: the verdict note is what `reviewRounds` counts.
              const result = [
                ...(supersededBy !== undefined
                  ? [`superseded by ${supersededBy}`]
                  : report.verdict
                    ? [`verdict: ${report.verdict}`]
                    : []),
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
          // The verdict goes on the item that holds the pull request; `queue add` and the merge read it.
          if (
            item.type === 'review' &&
            report.status === 'done' &&
            reviewDone.target !== undefined &&
            supersededBy === undefined
          ) {
            const reviewed = next.items.find(
              (i) => `${i.repo}#${i.pr}` === reviewDone.target && i.type !== 'review',
            );
            if (reviewed !== undefined) {
              const approvedBase = readCrewCaps(stateRoot(), item.id)?.baseRefName;
              next = withItem(
                next,
                reviewed.id,
                ({ approvedHead: _h, approvedBase: _b, approvedJobs: _j, ...i }) =>
                  report.verdict === 'approve'
                    ? {
                        ...i,
                        approvedHead: report.headSha,
                        approvedBase,
                        ...(approvedJobs.length === 0 ? {} : { approvedJobs }),
                      }
                    : i,
              );
            }
            // An approval answers every earlier review of the same pull request: one that ended
            // blocked or never ran would otherwise hold `queue add` until it is dropped by hand.
            // A review with a running crew stays; its own collect finds this one newer.
            if (report.verdict === 'approve') {
              const target = reviewDone.target;
              for (const older of next.items) {
                if (
                  older.id === item.id ||
                  older.type !== 'review' ||
                  ['assigned', 'in_progress', 'merged', 'dropped'].includes(older.status)
                ) {
                  continue;
                }
                const note = reviewTarget(older);
                const named = note !== undefined && `${note.repo}#${note.pr}` === target;
                if (!named && readCrewCaps(stateRoot(), older.id)?.reviewsTarget !== target)
                  continue;
                next = transition(next, older.id, 'dropped', BY, now);
                next = withItem(next, older.id, (i) => ({
                  ...i,
                  notes: [...(i.notes ?? []), `superseded by ${item.id}, which approved ${target}`],
                }));
              }
            }
          }
          const limitTarget =
            report.status === 'done' &&
            report.verdict === 'changes_requested' &&
            supersededBy === undefined
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
            if (
              fixLimit &&
              builder &&
              builder.status !== 'merged' &&
              builder.status !== 'dropped'
            ) {
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
          return { next, fixLimit, supersededBy };
        });
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
          ...(supersededBy === undefined ? {} : { supersededBy }),
          ...(fixLimit ? { fixLimit } : {}),
          ...(lessonsProposed > 0 ? { lessonsProposed } : {}),
          // What CI must run because the sandbox could not: only the count and the services, which
          // the schema fixes; the commands are crew text and stay on the item and in the PR body.
          ...(report.status === 'done' && report.notRunHere.length > 0
            ? {
                notRunHere: {
                  count: report.notRunHere.length,
                  missing: [...new Set(report.notRunHere.map((x) => x.missing))],
                },
              }
            : {}),
          // Each approved job with the reviewer's reason why it covers its command: reviewer text,
          // one plain line each, data for the lead. The gate proved only that the job ran and passed.
          ...(covered.length === 0 || supersededBy !== undefined
            ? {}
            : { notRunHereJobs: covered }),
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
          // Every pull request goes through a reviewer first (spec, section 5): no type is exempt.
          const view = await viewPr({ pr, repo }, ports.gh);
          if (typeof view === 'string') throw new Error(view);
          const problem = await approvalProblem(
            ports,
            approvalCheckout(project, config, repo),
            { repo, pr },
            { head: item.approvedHead, base: item.approvedBase },
            view.head,
          );
          if (problem !== undefined) throw new Error(problem);
          const root = await boundStateRoot();
          const pending = await withBoardLock(stateRoot(), ports.clock.now(), () => {
            // What the checks above read may have moved while they went to GitHub.
            const fresh = loadBoard(project);
            const now = findItem(fresh, item.id);
            if (now.status !== 'in_review' || now.approvedHead !== item.approvedHead) {
              throw new Error(`${item.id} changed while it was checked; try again`);
            }
            const open = openReview(stateRoot(), fresh, `${repo}#${pr}`);
            if (open !== undefined) throw new Error(openReviewLine(open, `${repo}#${pr}`));
            // Merged into queue.json on disk under the queue file lock: safe during a running queue.
            const added = enqueue(root, { pr, repo, item: item.id });
            saveBoard(project, transition(fresh, item.id, 'queued', BY, ports.clock.now()));
            return added;
          });
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
            await reconcileQueued(project, root, state, ports, stderr);
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
                mergeAllowed: (entry, head) =>
                  boardBlocksMerge(project, root, config, entry, head, ports),
                takeNext: () => takeNextPending(root),
                onDone: (d) => applyQueueResults(project, root, [d], ports, stderr),
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
            hasReport: (item) => {
              if (!isItemId(item)) return false;
              const name = reportName(root, item);
              return (
                name !== undefined &&
                existsSync(join(root, 'clones', item, '.studio', 'reports', name))
              );
            },
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
        // Only the process started for this crew gets a signal: the pid may be another's by now.
        const process = await crewProcess(rec, ports);
        if (process === 'invalid') throw new Error(`crew record for ${id} has no valid pid`);
        if (process === 'unknown') {
          // Never a signal without proof. `--release` only closes the record, for the owner.
          if (values.release !== true) throw new Error(unverifiedRefusal(rec));
          refuseCrew(deps.env);
          stderr(`warning: ${unverifiedHandgrip(rec)}\n`);
        }
        if (process === 'verified') await ports.claude.stop(rec.pid);
        const stoppedAt = ports.clock.now().toISOString();
        const latest = readCrewRecords(root);
        latest[id] = { ...(latest[id] ?? rec), stoppedAt };
        writeStateFile(root, join(root, 'crew.json'), `${JSON.stringify(latest, null, 2)}\n`);
        // A crew that ended without a usable report leaves its item assigned, and launch takes
        // only ready items. --requeue gives the item its one relaunch, through blocked as the lead
        // routine says; an item that was requeued before stays blocked: a second miss is a decision.
        let requeued: 'ready' | 'blocked' | undefined;
        if (values.requeue === true) {
          refuseCrew(deps.env);
          await withBoardLock(root, ports.clock.now(), () => {
            const fresh = loadBoard(project);
            const now = findItem(fresh, id);
            if (now.status !== 'assigned' && now.status !== 'in_progress') {
              throw new Error(
                `${id} is ${now.status}; only an assigned or in_progress item can be requeued`,
              );
            }
            const second = (now.notes ?? []).some((n) => n.startsWith(REQUEUE_NOTE));
            const at = ports.clock.now();
            let moved = transition(fresh, id, 'blocked', BY, at);
            if (!second) moved = transition(moved, id, 'ready', BY, at);
            const note = second
              ? `crew stopped at ${stoppedAt}; requeued before, so it stays blocked`
              : `${REQUEUE_NOTE} at ${stoppedAt}; back to ready for its one relaunch`;
            saveBoard(
              project,
              withItem(moved, id, (i) => ({ ...i, notes: [...(i.notes ?? []), note] })),
            );
            requeued = second ? 'blocked' : 'ready';
          });
        }
        print({
          item: id,
          name: rec.name,
          pid: rec.pid,
          stoppedAt,
          ...(process === 'verified' ? {} : { processGone: true }),
          ...(requeued === undefined ? {} : { status: requeued }),
        });
        return 0;
      }

      case 'link': {
        // Owner only: it decides which item a pull request opened by hand belongs to.
        if (deps.env.STUDIO_ROLE === 'crew' || deps.isTerminal !== true) {
          throw new Error('link is for the owner and needs a terminal; nothing changed');
        }
        const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d{0,9})$/.exec(rest[1] ?? '');
        if (rest.length !== 2 || !m) throw new UsageError('link needs <id> <repo>#<pr>');
        const repo = m[1] as string;
        const pr = Number(m[2]);
        const item = findItem(loadBoard(project), rest[0]);
        if (item.type === 'review')
          throw new Error(`${item.id} is a review; link its builder item`);
        if (item.repo !== repo) throw new Error(`${item.id} is in ${item.repo}, not ${repo}`);
        const info = await prInfo(ports, repo, pr);
        const branch = `studio/${item.id}`;
        if (info.branch !== branch) {
          throw new Error(`${repo}#${pr} is on branch ${info.branch}, expected ${branch}`);
        }
        await withBoardLock(stateRoot(), ports.clock.now(), () => {
          const fresh = loadBoard(project);
          const holder = fresh.items.find(
            (i) => i.id !== item.id && i.repo === repo && i.pr === pr,
          );
          if (holder) throw new Error(`${repo}#${pr} is already held by ${holder.id}`);
          saveBoard(
            project,
            withItem(fresh, item.id, (i) => ({ ...i, pr, branch })),
          );
        });
        print({ item: item.id, pr, branch });
        return 0;
      }

      case 'drop': {
        refuseCrew(deps.env);
        if (rest.length !== 1) throw new UsageError('drop needs one item id');
        const id = findItem(loadBoard(project), rest[0]).id;
        const rec = readCrewRecords(stateRoot())[id];
        const hold = rec === undefined ? undefined : await crewHold(rec, ports);
        if (hold === 'running') {
          throw new Error(`crew for ${id} is still running; run studio stop ${id} first`);
        }
        if (hold === 'unverified') throw new Error(unverifiedRefusal(rec as CrewRecord));
        await withBoardLock(stateRoot(), ports.clock.now(), () => {
          const fresh = loadBoard(project);
          saveBoard(project, transition(fresh, id, 'dropped', BY, ports.clock.now()));
        });
        print({ item: id, status: 'dropped' });
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
        return await runDoctor({ project, owner, env: deps.env, ports, json, stdout });
      }

      case 'account': {
        return await runAccount({
          args: rest,
          owner,
          ownerRoot: ownerRoot(),
          ports,
          env: deps.env,
          json,
          isTerminal: deps.isTerminal === true,
          ...(deps.readSecret === undefined ? {} : { readSecret: deps.readSecret }),
          stdout,
          stderr,
        });
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
        const out = await withBoardLock(stateRoot(), ports.clock.now(), () => {
          const { config, board } = loadAll();
          const item = findItem(board, rest[0]);
          const to = config.roles[item.role]?.escalateTo;
          if (to === undefined) {
            throw new Error(`role ${item.role} has no escalate_to in studio.yaml`);
          }
          if (item.status === 'merged' || item.status === 'dropped') {
            throw new Error(`${item.id} is ${item.status}, nothing to escalate`);
          }
          const role = config.roles[item.role] as RoleConfig;
          if (resolveModel(item, role) === to) throw new Error(`${item.id} already runs on ${to}`);
          saveBoard(
            project,
            withItem(board, item.id, (i) => ({
              ...i,
              model: to,
              notes: [...(i.notes ?? []), `model escalated to ${to}`],
            })),
          );
          return { item: item.id, model: to, status: item.status };
        });
        print(out);
        return 0;
      }

      case 'metrics': {
        let flaky: unknown;
        try {
          const entries = listFlaky(stateRoot());
          flaky = {
            tests: entries.length,
            runs: entries.reduce((sum, e) => sum + e.count, 0),
            worst: entries.slice(0, 5),
          };
        } catch (e) {
          print({
            ...computeMetrics(readMetricEvents(stateRoot())),
            flakyError: (e as Error).message.replace(/\p{Cc}/gu, ' '),
          });
          return 0;
        }
        print({ ...computeMetrics(readMetricEvents(stateRoot())), flaky });
        return 0;
      }

      case 'deploy': {
        refuseCrew(deps.env);
        const [sub, sha] = rest;
        if (sub !== 'record' || rest.length > 2 || (sha !== undefined && !SHORT_SHA.test(sha))) {
          throw new UsageError('deploy needs: record [<sha>]');
        }
        const event = {
          type: 'deployed',
          at: ports.clock.now().toISOString(),
          ...(sha === undefined ? {} : { sha }),
        };
        appendStateLine(await boundStateRoot(), 'metrics.jsonl', JSON.stringify(event));
        print(event);
        return 0;
      }

      case 'incident': {
        refuseCrew(deps.env);
        const [sub, id] = rest;
        if (
          (sub !== 'open' && sub !== 'resolve') ||
          rest.length !== 2 ||
          !INCIDENT_ID.test(id ?? '')
        ) {
          throw new UsageError('incident needs: open <id> | resolve <id>');
        }
        const event = {
          type: sub === 'open' ? 'incident_opened' : 'incident_resolved',
          at: ports.clock.now().toISOString(),
          incident: id,
        };
        appendStateLine(await boundStateRoot(), 'metrics.jsonl', JSON.stringify(event));
        print(event);
        return 0;
      }

      case 'flaky': {
        const [sub, test, sha, rerun] = rest;
        if ((sub === undefined || sub === 'list') && rest.length <= 1) {
          print(listFlaky(stateRoot()));
          return 0;
        }
        refuseCrew(deps.env);
        if (
          sub !== 'record' ||
          rest.length !== 4 ||
          test === undefined ||
          !SHORT_SHA.test(sha ?? '') ||
          (rerun !== 'pass' && rerun !== 'fail')
        ) {
          throw new UsageError('flaky needs: list | record <test> <sha> pass|fail');
        }
        print(recordFlaky(await boundStateRoot(), test, sha as string, rerun, ports.clock.now()));
        return 0;
      }

      case 'solutions': {
        const [sub, ...words] = rest;
        if (sub !== 'search' || words.length === 0) {
          throw new UsageError('solutions needs: search <words...>');
        }
        print(searchSolutions(project, words.join(' ')));
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
        release: { type: 'boolean' },
        requeue: { type: 'boolean' },
        component: { type: 'string' },
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
): Promise<{ head: string; branch: string; baseOid?: string }> {
  const r = await ports.gh.run([
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'headRefOid,headRefName,headRepository,headRepositoryOwner,isCrossRepository,baseRefOid',
  ]);
  if (r.code !== 0) throw new Error(`cannot read ${repo}#${pr} (gh exit ${r.code})`);
  let raw: {
    headRefOid?: unknown;
    headRefName?: unknown;
    headRepository?: { name?: unknown } | null;
    headRepositoryOwner?: { login?: unknown } | null;
    isCrossRepository?: unknown;
    baseRefOid?: unknown;
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
  const baseOid =
    typeof raw?.baseRefOid === 'string' && /^[0-9a-f]{40,64}$/i.test(raw.baseRefOid)
      ? raw.baseRefOid
      : undefined;
  return { head, branch, ...(baseOid === undefined ? {} : { baseOid }) };
}

const PR_OPTIONAL: readonly WorkItem['type'][] = ['review', 'research'];
const PR_BODY_MAX = 20_000;

/** The least-privilege crew token, as a launch reads it; Studio opens a crew's PR only with it. */
function crewTokenFor(config: StudioConfig, owner: OwnerEnv): string {
  const fromEnv = config.crewToken ? owner.env?.[config.crewToken.env] : undefined;
  if (fromEnv) return fromEnv;
  const file = readCrewTokenFile(owner);
  if (file.kind === 'ok') return file.token;
  throw new Error(
    'opening the pull request needs the crew token (studio secret set crew-token); nothing moved',
  );
}

const PR_HELD = 'pr held: ';

/** The board note for a pull request `collect` did not open for lack of CI capacity. */
function prHeldNote(cap: Capacity, config: StudioConfig): string {
  const parts = [`busy ${cap.ciBusy} of ${cap.ciTotal}, limit ${config.ci.capacity.mergeMaxBusy}`];
  if (cap.githubHostedBusy !== undefined && cap.githubHostedLimit !== undefined) {
    parts.push(`github-hosted ${cap.githubHostedBusy}, limit ${cap.githubHostedLimit}`);
  }
  if (!cap.hostOk) parts.push(`host load ${cap.hostLoad.toFixed(2)}`);
  const why = cap.error === undefined ? '' : `; CI read failed: ${cap.error}`;
  return capNotes([`${PR_HELD}ci capacity (${parts.join(', ')}${why})`])[0] as string;
}

/**
 * Opens the pull request of a crew that pushed `studio/<id>` but could not run gh, with the crew
 * token, outside the sandbox. Title and body are crew text: cleaned, cut and passed as data in a
 * file, never on a command line. An open pull request of that branch is taken instead and its
 * text renewed with `gh pr edit`; both wait for `capacity`. A new one is opened only when `capacity` holds;
 * otherwise nothing is opened and the read that decided comes back as `held`. `unchanged` runs
 * after the capacity wait, right before the create, and throws when the item moved meanwhile.
 */
async function openCrewPr(
  ports: Ports,
  item: WorkItem,
  title: string,
  body: string,
  notRunHere: readonly NotRunHere[],
  token: string,
  capacity: () => Promise<{ ok: boolean; capacity: Capacity }>,
  unchanged: () => void,
): Promise<{ pr: number } | { held: Capacity }> {
  const head = `studio/${item.id}`;
  const list = await ports.gh.run(
    ['pr', 'list', '--repo', item.repo, '--head', head, '--state', 'open', '--json', 'number'],
    { token },
  );
  if (list.code !== 0)
    throw new Error(`cannot list pull requests of ${head} (gh exit ${list.code})`);
  const open = JSON.parse(list.stdout || '[]') as { number?: unknown }[];
  const known = open.find((p) => Number.isInteger(p.number))?.number;
  // Crew text loses control and format characters (bidi overrides, zero-width).
  const plainTitle = title.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (plainTitle === '')
    throw new Error(`the pull request title for ${head} is empty; nothing moved`);
  // Studio's own lines come first, so crew text can neither push them out of view nor fake an end.
  const text = `Opened by Studio for ${item.id}; the text below the line was written by the crew.\n${notRunSection(notRunHere)}\n---\n\n${body.replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, '').slice(0, PR_BODY_MAX)}\n`;
  const withBody = async <T>(use: (file: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-pr-'));
    try {
      const file = join(dir, 'body.md');
      writeFileSync(file, text, { mode: 0o600 });
      return await use(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // Opening and editing both wait for CI capacity: an edit can start workflows too.
  const room = await capacity();
  if (!room.ok) return { held: room.capacity };
  unchanged();
  if (typeof known === 'number') {
    // The open pull request gets this report's text, so its not_run_here list is never stale.
    return withBody(async (file) => {
      const r = await ports.gh.run(
        ['pr', 'edit', String(known), '--repo', item.repo, '--body-file', file],
        { token },
      );
      if (r.code !== 0) {
        throw new Error(`gh pr edit failed for ${head} (exit ${r.code}); nothing moved`);
      }
      return { pr: known };
    });
  }
  return withBody(async (file) => {
    const r = await ports.gh.run(
      [
        'pr',
        'create',
        '--repo',
        item.repo,
        '--head',
        head,
        '--title',
        plainTitle,
        '--body-file',
        file,
      ],
      { token },
    );
    const m = /\/pull\/(\d+)\s*$/.exec(r.stdout);
    if (r.code !== 0 || !m)
      throw new Error(`gh pr create failed for ${head} (exit ${r.code}); nothing moved`);
    return { pr: Number(m[1]) };
  });
}
/**
 * The pull request section for commands the crew could not run in its sandbox. Each line is crew
 * text, already one plain line by the report schema; fences are cut so it stays in its block.
 */
function notRunSection(list: readonly NotRunHere[]): string {
  if (list.length === 0) return '';
  const lines = list.map((x) =>
    `${x.command} (missing ${x.missing}: ${x.reason})`.replace(/`{3,}/g, ''),
  );
  return `\n## Not run in the crew sandbox\n\nThe crew could not run these commands, because its sandbox lacks the service named (crew text). CI must run them; an approval counts only with green checks.\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`;
}

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

/** Why an open review blocks a pull request, and the two ways to end it. */
const openReviewLine = (id: string, target: string): string =>
  `review ${id} of ${target} is open: run studio collect ${id}, or studio drop ${id} if it ended without a report`;

/**
 * Why the board forbids this merge; only a readable board with the item `queued` and an approval
 * covering this head allows it.
 */
async function boardBlocksMerge(
  project: string,
  root: string,
  config: StudioConfig,
  entry: QueueEntry,
  head: string,
  ports: Ports,
): Promise<string | undefined> {
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
  if (item.status !== 'queued') return `board item ${item.id} is ${item.status}`;
  const target = `${entry.repo}#${entry.pr}`;
  const open = openReview(root, board, target);
  if (open !== undefined) return openReviewLine(open, target);
  const problem = await approvalProblem(
    ports,
    approvalCheckout(project, config, entry.repo),
    entry,
    { head: item.approvedHead, base: item.approvedBase },
    head,
  );
  if (problem !== undefined || (item.approvedJobs ?? []).length === 0) return problem;
  // The jobs the approval named for commands the builder could not run must still have passed.
  const checks = await readChecks(entry, ports.gh);
  if (checks.kind !== 'pass') return 'the checks are not green';
  return approvedJobsProblem(item.approvedJobs ?? [], checks.checks);
}

/** The owner's checkout tracks the primary repo; another repo is reached by its URL. */
function approvalCheckout(project: string, config: StudioConfig, repo: string) {
  return { dir: project, remote: repo === config.primaryRepo ? 'origin' : githubHttpsUrl(repo) };
}

const doneMatches = (d: QueueDone, item: WorkItem): boolean =>
  d.item === undefined ? d.repo === item.repo && d.pr === item.pr : d.item === item.id;

/**
 * A run that stopped after recording a result but before moving the board leaves the item
 * `queued`. For every queued item that is neither pending nor current, apply its last result.
 */
async function reconcileQueued(
  project: string,
  root: string,
  state: QueueState,
  ports: Ports,
  stderr: (s: string) => void,
): Promise<void> {
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
  await applyQueueResults(project, root, results, ports, stderr);
}

/** Moves board items for finished queue entries: merged, or back to review with a note. */
async function applyQueueResults(
  project: string,
  root: string,
  done: QueueDone[],
  ports: Ports,
  stderr: (s: string) => void,
): Promise<void> {
  if (done.length === 0) return;
  const now = ports.clock.now();
  await withBoardLock(root, now, () => {
    let board = loadBoard(project);
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
  });
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
  const components = extra.config.components?.map((c) => ({ id: c.id, name: c.name }));
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
      ...(components === undefined
        ? {}
        : { components: item === undefined ? [] : componentsOf(item, extra.config) }),
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
    ...(components === undefined ? {} : { components }),
    updatedAt: now.toISOString(),
    metrics: computeMetrics(events),
  };
}
