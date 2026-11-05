import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runAccount } from './account-command.js';
import { addItem } from './add-item.js';
import {
  type ApprovedJob,
  type Board,
  BoardError,
  componentsOf,
  ITEM_STATUSES,
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
import { addEpic, dropEpic, editEpic, epicRows, findEpic, settleAndSave } from './epics.js';
import { listFlaky, recordFlaky } from './flaky.js';
import { HeldError } from './held.js';
import { runInit } from './init.js';
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
  clockTime,
  leadDecisions,
  PR_HELD,
  paneItems,
  readTickRecord,
  writeTickRecord,
} from './pane-data.js';
import {
  acquireStateLock,
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
import { checkReportHead, ReportError, readReport, reportName } from './report.js';
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
import { parsePhases, planImport, readImportFile, renderRoadmap, writeRoadmap } from './roadmap.js';
import {
  acceptLesson,
  dropLesson,
  listLessons,
  proposeLessons,
  pruneLesson,
} from './role-memory.js';
import { runDoctor, runSecretSet } from './secret-command.js';
import { runSetup } from './setup.js';
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
  /** A visible line from the terminal (`studio setup`); undefined on abort or without one. */
  readLine?: (prompt: string) => Promise<string | undefined>;
  /** The absolute path of the plugin's `bin/studio`, for `setup --link` and init's next steps. */
  launcher?: string;
}

const USAGE = `Usage: studio [--project <dir>] [--json] <command>

Commands:
  init [--write]           Check the prerequisites and propose .studio/ for this project; --write writes it
  add "<title>" --dod <l>  Add a ready builder item [--type fix|feature|chore|docs|research]
                           [--repo <owner/name>] [--path <glob>]... [--dod <line>]... [--component <id>] [--plan <file>]
                           [--epic <id>]
  board [--component <id>] [--epic <id>]  Show the board, or the items of one component or epic
  epic add "<title>" --goal <text> --acceptance <line>... [--component <id>]...
                           Add an open epic with the next free id (E-<n>)
  epic list                Epics with their items by status and merged of total
  epic show <id>           One epic: goal, acceptance, items
  epic edit <id> [--title <t>] [--goal <text>] [--acceptance <line>...]
                           Replace an epic's title, goal or acceptance lines
  epic drop <id>           End an epic; refused while it has open items
  roadmap [--write] [--out <file>] [--force]
                           Render the roadmap from the board; --write writes ROADMAP.md
  roadmap import <file> [--write]  Turn "- [ ] Phase <n> — <title>" lines into epics (dry run without --write)
  plan                     Dry-run the planner (JSON)
  launch <id>              Start a crew session for a planned item
  status                   Crew sessions and their board status
  overview                 Owner only, in a terminal: every project of this owner, read only
  collect <id>             Read a crew report and move the item
  tick                     One lead heartbeat: collect, launch, queue and merge what is due (JSON)
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
  setup [--link]           Owner only, in a terminal: gh, crew token and Claude account, one guided
                           step each, skipped when done; --link puts studio on your terminal's PATH
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

/**
 * What `collect` came to: the item moved (with the output), or nothing moved because the pull
 * request is held for CI capacity, an approval waits for green checks, or the job gate refused an
 * approval (the review item is blocked).
 */
type Collected =
  | { kind: 'moved'; out: Record<string, unknown> & { status: WorkItem['status'] } }
  | { kind: 'held' | 'waiting' | 'refused'; line: string };

/** A review item naming `target` (`<repo>#<pr>`) that is neither merged nor dropped. */
function isOpenReviewOf(item: WorkItem, target: string): boolean {
  if (item.type !== 'review' || item.status === 'merged' || item.status === 'dropped') return false;
  const t = reviewTarget(item);
  return t !== undefined && `${t.repo}#${t.pr}` === target;
}

/** The finished review of `target` with a verdict that moved last, if any. */
function latestReview(board: Board, target: string): WorkItem | undefined {
  const at = (i: WorkItem) => Date.parse(i.history.at(-1)?.at ?? '') || 0;
  return board.items
    .filter(
      (i) =>
        i.type === 'review' &&
        i.status === 'merged' &&
        (i.notes ?? []).includes(`reviews: ${target}`) &&
        (i.notes ?? []).some((n) => n.startsWith('verdict: ')),
    )
    .reduce<WorkItem | undefined>(
      (last, i) => (last === undefined || at(i) >= at(last) ? i : last),
      undefined,
    );
}

/** What one `tick` did and what it leaves to the lead. */
interface Tick {
  collected: Record<string, unknown>[];
  /** Review items added for pull requests in review that had neither a review nor a verdict. */
  reviews: { item: string; review: string }[];
  launched: { item: string; name: string; pid: number }[];
  queued: { item: string; pr: number; repo: string }[];
  merged: { item?: string; pr: number; repo: string }[];
  held: { item: string; reason: string }[];
  needsLead: { item: string; reason: string }[];
  /** Per item (`item`), or a phase that failed or did not run (`phase`). */
  errors: { item?: string; phase?: string; error: string }[];
  /** Epics whose items are all merged (status `accepting`), waiting for their acceptance; absent without one. */
  epicsReady?: { epic: string; title: string }[];
}

/** One tick at a time; a tick whose holder died is taken over after this long. */
const TICK_LOCK = 'tick.lock';
const TICK_LOCK_STALE_MS = 15 * 60_000;

/**
 * Adds the review item for a builder's pull request, unless a review naming it is still open
 * (neither merged nor dropped). The id is the next free number of the builder's prefix; DoD, paths
 * and named components are the builder's. Returns the new id, if any.
 */
function withReviewItem(
  board: Board,
  builder: WorkItem,
  pr: number,
): { board: Board; id?: string } {
  const target = `${builder.repo}#${pr}`;
  if (board.items.some((i) => isOpenReviewOf(i, target))) return { board };
  const prefix = builder.id.slice(0, builder.id.indexOf('-') + 1);
  const taken = board.items
    .filter((i) => i.id.startsWith(prefix))
    .map((i) => Number(i.id.slice(prefix.length)));
  const id = `${prefix}${Math.max(0, ...taken) + 1}`;
  const review: WorkItem = {
    id,
    title: `Review of ${builder.id} (PR #${pr})`,
    type: 'review',
    role: 'reviewer',
    repo: builder.repo,
    size: builder.size,
    priority: builder.priority,
    status: 'ready',
    paths: [...builder.paths],
    touches: [],
    ...(builder.component === undefined ? {} : { component: builder.component }),
    ...(builder.components === undefined ? {} : { components: [...builder.components] }),
    dependsOn: [],
    dod: [...builder.dod],
    notes: [`review ${target}`],
    history: [],
  };
  return { board: { ...board, items: [...board.items, review] }, id };
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
    const epicAdd = cmd === 'epic' && rest[0] === 'add';
    if (values.component !== undefined && cmd !== 'board' && cmd !== 'add' && !epicAdd) {
      throw new UsageError('--component works with board, add and epic add only');
    }
    if (!epicAdd && (values.component?.length ?? 0) > 1) {
      throw new UsageError('--component takes one id here; only epic add takes several');
    }
    const component = epicAdd ? undefined : values.component?.[0];
    const addOnly = [values.type, values.repo, values.path, values.dod, values.plan];
    if (cmd !== 'add' && addOnly.some((v) => v !== undefined)) {
      throw new UsageError('--type, --repo, --path, --dod and --plan work with add only');
    }
    const epicEdit = cmd === 'epic' && rest[0] === 'edit';
    if (!epicEdit && values.title !== undefined) {
      throw new UsageError('--title works with epic edit only');
    }
    if (!epicAdd && !epicEdit && (values.goal !== undefined || values.acceptance !== undefined)) {
      throw new UsageError('--goal and --acceptance work with epic add and epic edit only');
    }
    if (values.epic !== undefined && cmd !== 'board' && cmd !== 'add') {
      throw new UsageError('--epic works with board and add only');
    }
    if ((values.out !== undefined || values.force !== undefined) && cmd !== 'roadmap') {
      throw new UsageError('--out and --force work with roadmap only');
    }
    if (values.link !== undefined && cmd !== 'setup') {
      throw new UsageError('--link works with setup only');
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

    /** Puts an approved pull request into the merge queue: the body of `queue add`. */
    const queueAdd = async (arg: string | undefined) => {
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
      return { queued: item.id, pr, repo, pending };
    };

    /** Merges the queued pull requests, one at a time: the body of `queue run`. */
    const queueRun = async () => {
      const { config } = loadAll();
      refuseNativeQueue(config);
      const root = await boundStateRoot();
      /** An account block, a pause, or old state files that were not merged into the owner root. */
      const queueHold = (): string | undefined =>
        blockHold(ownerRoot()) ??
        (readPause(root).paused ? PAUSED_LINE : undefined) ??
        (pendingLegacyState(dirname(ownerRoot())).length > 0 ? LEGACY_LINE : undefined);
      const blockedNow = queueHold();
      if (blockedNow !== undefined) throw new HeldError(blockedNow);
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
        return {
          ...(heldLine === undefined ? {} : { held: heldLine }),
          merged: finished.filter((d) => d.result === 'merged').length,
          failed: finished.filter((d) => d.result === 'failed').length,
          done: finished,
        };
      } finally {
        removeSignals();
        lock.release();
      }
    };

    /** Starts the crew of a planned item and moves it to `assigned`: the body of `launch`. */
    const launch = async (id: string | undefined) => {
      if (await reconcile()) {
        throw new HeldError(
          'another Studio process is reconciling account blocks; refusing to launch, try again',
        );
      }
      const { config, board } = loadAll();
      const item = findItem(board, id);
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
        throw new HeldError(`${item.id} is not in the current plan: ${why}`);
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
      return res;
    };

    /** Reads a finished crew report, verifies it and moves the item: the body of `collect`. */
    const collect = async (id: string | undefined): Promise<Collected> => {
      const { board } = loadAll();
      const item = findItem(board, id);
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
        throw new ReportError(
          `no report name was drawn for ${item.id}: relaunch it, nothing moved`,
        );
      }
      let report = readReport(clone, item.id, item, { notBefore, fileName });
      // A review report that does not hold to its brief is a rejected report, like one that
      // cannot be read: `tick` hands both to the lead.
      const reviewCaps = () => {
        try {
          return checkReviewCaps(readCrewCaps(stateRoot(), item.id), report);
        } catch (e) {
          throw new ReportError((e as Error).message);
        }
      };
      const reviewDone =
        item.type === 'review' && report.status === 'done'
          ? reviewCaps()
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
            return {
              kind: 'waiting',
              line: `the approval counts only with green checks (${why}); collect again once they pass, nothing moved`,
            };
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
              return {
                kind: 'refused',
                line: `${item.id}: ${note}; no approval, ${item.id} is blocked for the lead`,
              };
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
          return {
            kind: 'held',
            line: `${item.id}: ${note}; the pull request was not opened and branch studio/${item.id} stays as it is. Run studio collect ${item.id} again once CI has room.`,
          };
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
        throw new ReportError(`done report for ${item.id} names no pr`);
      }
      const now = ports.clock.now();
      // Under the lock from reading the board again to saving it: a launch clearing an approval
      // cannot slip in, and what moved while GitHub was asked stays.
      let review: string | undefined;
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
          if (item.status === 'assigned') next = transition(next, item.id, 'in_progress', BY, now);
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
            // Every pull request gets one fresh reviewer: the review item comes with it, and a
            // new one after a fix round, once the earlier review has finished.
            if (!PR_OPTIONAL.includes(item.type)) {
              const added = withReviewItem(next, findItem(next, item.id), pr);
              next = added.board;
              review = added.id;
            }
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
              if (!named && readCrewCaps(stateRoot(), older.id)?.reviewsTarget !== target) continue;
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
      const out = {
        item: item.id,
        report: report.status,
        status: findItem(next, item.id).status,
        ...(report.pr === undefined ? {} : { pr: report.pr }),
        ...(review === undefined ? {} : { review }),
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
        ...(covered.length === 0 || supersededBy !== undefined ? {} : { notRunHereJobs: covered }),
      };
      return { kind: 'moved', out };
    };

    /**
     * One lead heartbeat: collect what ended, try held pull requests again, give a pull request
     * without a review its review item, launch what the plan assigns, queue approved pull requests
     * and run the queue. Each item's failure, and each phase's, is recorded and the rest goes on;
     * what needs a decision is listed, never decided here.
     */
    const tick = async (): Promise<Tick> => {
      const out: Tick = {
        collected: [],
        reviews: [],
        launched: [],
        queued: [],
        merged: [],
        held: [],
        needsLead: [],
        errors: [],
      };
      const why = (e: unknown) => (e as Error).message.replace(/\p{Cc}/gu, ' ');
      const lead = (item: string, reason: string) => {
        if (!out.needsLead.some((n) => n.item === item && n.reason === reason)) {
          out.needsLead.push({ item, reason });
        }
      };
      let root: string;
      let lock: ReturnType<typeof acquireStateLock>;
      try {
        root = await boundStateRoot();
        lock = acquireStateLock(root, TICK_LOCK, {
          now: ports.clock.now(),
          heartbeatStaleMs: TICK_LOCK_STALE_MS,
        });
      } catch (e) {
        out.errors.push({ phase: 'start', error: why(e) });
        return out;
      }
      if (!lock) {
        out.held.push({ item: 'tick', reason: 'another tick is running' });
        return out;
      }
      const held = lock;
      const beat = () => held.heartbeat(ports.clock.now());
      /** Runs one phase while the tick still holds its lock; false once the lock is lost. */
      const phase = async (name: string, body: () => Promise<void>): Promise<boolean> => {
        if (!held.owned()) {
          out.errors.push({ phase: name, error: 'the tick lock was lost; the tick stopped here' });
          return false;
        }
        beat();
        try {
          await body();
        } catch (e) {
          out.errors.push({ phase: name, error: why(e) });
        }
        return true;
      };
      // Reviews of pull requests opened in this tick: their checks may not be reported yet.
      const fresh = new Set<string>();

      // (a) Crews that ended, and (b) pull requests held for CI capacity: collect again.
      const collectEnded = async () => {
        const records = readCrewRecords(root);
        for (const item of loadAll().board.items) {
          if (item.status !== 'assigned' && item.status !== 'in_progress') continue;
          const rec = records[item.id];
          const heldPr = (item.notes ?? []).some((n) => n.startsWith(PR_HELD));
          if (rec === undefined && !heldPr) continue;
          beat();
          try {
            if (rec !== undefined) {
              const hold = await crewHold(rec, ports);
              if (hold === 'running') continue;
              if (hold === 'unverified') {
                lead(item.id, unverifiedRefusal(rec));
                continue;
              }
            }
            // A fix limit or a refused approval leaves an item blocked: the sweep lists it.
            const r = await collect(item.id);
            if (r.kind === 'moved') {
              out.collected.push(r.out);
              if (typeof r.out.review === 'string') fresh.add(r.out.review);
            } else if (r.kind !== 'refused') {
              out.held.push({ item: item.id, reason: r.line });
              // A CI read that keeps failing would otherwise hold the item quietly for ever.
              if (r.line.includes(CI_READ_FAILED))
                out.errors.push({ item: item.id, error: r.line });
            }
          } catch (e) {
            if (e instanceof ReportError) {
              lead(item.id, `${why(e)}; studio stop ${item.id} --requeue for its one relaunch`);
            } else out.errors.push({ item: item.id, error: why(e) });
          }
        }
      };

      // A builder in review with neither a review nor a verdict (its review was dropped): a new one.
      const reviewMissing = async () => {
        const board = loadBoard(project);
        for (const b of board.items) {
          if (PR_OPTIONAL.includes(b.type) || b.status !== 'in_review' || b.pr === undefined) {
            continue;
          }
          const target = `${b.repo}#${b.pr}`;
          if (b.approvedHead !== undefined || board.items.some((i) => isOpenReviewOf(i, target))) {
            continue;
          }
          if (latestReview(board, target)?.notes?.includes('verdict: changes_requested')) continue;
          beat();
          try {
            const id = await withBoardLock(root, ports.clock.now(), () => {
              const now = loadBoard(project);
              const builder = findItem(now, b.id);
              if (builder.status !== 'in_review' || builder.pr !== b.pr) return undefined;
              if (builder.approvedHead !== undefined) return undefined;
              const added = withReviewItem(now, builder, b.pr as number);
              if (added.id !== undefined) saveBoard(project, added.board);
              return added.id;
            });
            if (id !== undefined) out.reviews.push({ item: b.id, review: id });
          } catch (e) {
            out.errors.push({ item: b.id, error: why(e) });
          }
        }
      };

      // (c) The plan, launched under every gate `launch` keeps.
      const launchPlanned = async () => {
        const { config, board } = loadAll();
        const { plan } = await planNow(config, board);
        for (const a of plan.assign) {
          if (fresh.has(a.id)) {
            out.held.push({ item: a.id, reason: 'pull request opened in this tick: next tick' });
            continue;
          }
          beat();
          try {
            const res = await launch(a.id);
            out.launched.push({ item: a.id, name: res.name, pid: res.pid });
          } catch (e) {
            if (e instanceof HeldError) out.held.push({ item: a.id, reason: why(e) });
            else out.errors.push({ item: a.id, error: why(e) });
          }
        }
        for (const d of plan.deferred) out.held.push({ item: d.id, reason: d.reason });
        for (const b of plan.blocked) {
          if (b.reason.startsWith('waiting on ')) out.held.push({ item: b.id, reason: b.reason });
          else lead(b.id, b.reason);
        }
      };

      // (d) Approved pull requests into the queue, unless a merge failed after the approval.
      const queueApproved = async () => {
        const board = loadBoard(project);
        for (const b of board.items) {
          if (b.type === 'review' || b.status !== 'in_review' || b.pr === undefined) continue;
          const target = `${b.repo}#${b.pr}`;
          const latest = latestReview(board, target);
          if (b.approvedHead === undefined) {
            if (
              latest?.notes?.includes('verdict: changes_requested') &&
              !board.items.some((i) => isOpenReviewOf(i, target))
            ) {
              lead(
                b.id,
                `changes requested by ${latest.id}: blocked → ready with the findings, then the fix round`,
              );
            }
            continue;
          }
          const failedAt = b.history.findLast(
            (h) => h.from === 'queued' && h.to === 'in_review',
          )?.at;
          const approvedAt = latest?.history.at(-1)?.at;
          if (
            failedAt !== undefined &&
            (approvedAt === undefined || Date.parse(failedAt) >= Date.parse(approvedAt))
          ) {
            const note = (b.notes ?? []).findLast((n) => n.startsWith('merge failed:'));
            lead(
              b.id,
              `${note ?? 'merge failed'}; fix it through a crew and a review, or re-run the same SHA`,
            );
            continue;
          }
          beat();
          try {
            const q = await queueAdd(target);
            out.queued.push({ item: q.queued, pr: q.pr, repo: q.repo });
          } catch (e) {
            lead(b.id, why(e));
          }
        }
      };

      const sweep = async () => {
        for (const i of loadBoard(project).items) {
          if (i.status === 'blocked') lead(i.id, `blocked: ${(i.notes ?? []).at(-1) ?? 'no note'}`);
        }
      };

      try {
        for (const [name, body] of [
          ['collect', collectEnded],
          ['review', reviewMissing],
          ['launch', launchPlanned],
          ['queue add', queueApproved],
          ['sweep', sweep],
        ] as const) {
          if (!(await phase(name, body))) return out;
        }
      } finally {
        held.release();
      }

      // (e) The queue, in this process; the tick lock is free meanwhile, the queue has its own. It
      // also runs to resume an entry a killed run left as `current`, and so that a queued item the
      // queue no longer holds gets its recorded result.
      try {
        const q = loadQueue(root);
        const inQueue = (i: WorkItem) =>
          [...q.pending, ...(q.current === undefined ? [] : [q.current])].some((e) =>
            e.item === undefined ? e.repo === i.repo && e.pr === i.pr : e.item === i.id,
          );
        const stray = loadBoard(project).items.some((i) => i.status === 'queued' && !inQueue(i));
        if (q.pending.length > 0 || q.current !== undefined || stray) {
          const r = await queueRun();
          for (const d of r.done) {
            if (d.result === 'merged') {
              out.merged.push({
                ...(d.item === undefined ? {} : { item: d.item }),
                pr: d.pr,
                repo: d.repo,
              });
            } else
              lead(d.item ?? `${d.repo}#${d.pr}`, `merge failed: ${d.reason ?? 'unknown reason'}`);
          }
          if (r.held !== undefined) out.held.push({ item: 'queue', reason: r.held });
        }
      } catch (e) {
        if (e instanceof HeldError) out.held.push({ item: 'queue', reason: why(e) });
        else out.errors.push({ phase: 'queue run', error: why(e) });
      }

      // (f) Epics whose items are all merged wait for their acceptance. Every move of an item
      // applies the status rule; this catches a board edited by hand.
      try {
        const board = loadBoard(project);
        let now = board;
        if (board.epics?.some((e) => e.status === 'open' || e.status === 'accepting')) {
          now = await withBoardLock(root, ports.clock.now(), () => {
            const fresh = loadBoard(project);
            settleAndSave(project, fresh, BY, ports.clock.now());
            return loadBoard(project);
          });
        }
        const ready = (now.epics ?? [])
          .filter((e) => e.status === 'accepting')
          .map((e) => ({ epic: e.id, title: e.title }));
        // Only when there is one: a tick without accepting epics prints what it printed before.
        if (ready.length > 0) out.epicsReady = ready;
      } catch (e) {
        // A board that cannot be read is reported by the phases before; no second line for it.
        if (!(e instanceof BoardError)) out.errors.push({ phase: 'epics', error: why(e) });
      }
      return out;
    };

    switch (cmd) {
      case 'init': {
        refuseCrew(deps.env);
        if (rest.length !== 0) throw new UsageError('init takes no arguments, only --write');
        return await runInit({
          project,
          ports,
          owner,
          env: deps.env,
          json,
          write: values.write === true,
          stdout,
          ...(deps.launcher === undefined ? {} : { launcher: deps.launcher }),
        });
      }

      case 'add': {
        refuseCrew(deps.env);
        if (rest.length > 1)
          throw new UsageError('add takes one title; quote it: studio add "<title>"');
        print(
          await addItem({
            project,
            title: rest[0],
            ...(values.type === undefined ? {} : { type: values.type }),
            ...(values.repo === undefined ? {} : { repo: values.repo }),
            paths: values.path ?? [],
            dod: values.dod ?? [],
            ...(component === undefined ? {} : { component }),
            ...(values.plan === undefined ? {} : { plan: values.plan }),
            ...(values.epic === undefined ? {} : { epic: values.epic }),
            now: ports.clock.now(),
            locked: (fn) => withBoardLock(stateRoot(), ports.clock.now(), fn),
          }),
        );
        return 0;
      }

      case 'board': {
        const { config, board } = loadAll();
        const only = component;
        if (only !== undefined && !(config.components ?? []).some((c) => c.id === only)) {
          throw new Error(`unknown component ${only}`);
        }
        const epic = values.epic === undefined ? undefined : findEpic(board, values.epic).id;
        const items = board.items
          .map((i) => ({ item: i, ...componentField(config, i) }))
          .filter((r) => only === undefined || r.components?.includes(only))
          .filter((r) => epic === undefined || r.item.epic === epic);
        if (json) print(items.map(({ item, ...rest }) => ({ ...item, ...rest })));
        else {
          const withComponents = config.components !== undefined;
          const withEpics = (board.epics ?? []).length > 0;
          stdout(
            table([
              [
                'ID',
                'STATUS',
                'ROLE',
                'TYPE',
                'PRIORITY',
                ...(withComponents ? ['COMPONENT'] : []),
                ...(withEpics ? ['EPIC'] : []),
                'TITLE',
              ],
              ...items.map(({ item: i, components }) => [
                i.id,
                i.status,
                i.role,
                i.type,
                String(i.priority),
                ...(withComponents ? [componentCell(components)] : []),
                ...(withEpics ? [i.epic ?? '-'] : []),
                i.title,
              ]),
            ]),
          );
        }
        return 0;
      }

      case 'epic': {
        const [sub, ...args] = rest;
        if (sub === 'add') {
          refuseCrew(deps.env);
          if (args.length !== 1) {
            throw new UsageError(
              'epic add takes one title; quote it: studio epic add "<title>" --goal "<text>" --acceptance "<line>"',
            );
          }
          print(
            await addEpic({
              project,
              title: args[0],
              goal: values.goal,
              acceptance: values.acceptance ?? [],
              components: values.component ?? [],
              now: ports.clock.now(),
              locked: (fn) => withBoardLock(stateRoot(), ports.clock.now(), fn),
            }),
          );
          return 0;
        }
        if (sub === 'list') {
          if (args.length !== 0) throw new UsageError('epic list takes no arguments');
          const rows = epicRows(loadAll().board);
          if (json) print(rows);
          else {
            const counts = (c: (typeof rows)[number]['counts']) => {
              const parts = ITEM_STATUSES.flatMap((s) =>
                c[s] === undefined ? [] : [`${s} ${c[s]}`],
              );
              return parts.length === 0 ? '-' : parts.join(', ');
            };
            stdout(
              table([
                ['ID', 'STATUS', 'PROGRESS', 'ITEMS', 'TITLE'],
                ...rows.map((r) => [
                  r.id,
                  r.status,
                  `${r.progress.merged}/${r.progress.total}`,
                  counts(r.counts),
                  r.title,
                ]),
              ]),
            );
          }
          return 0;
        }
        if (sub === 'show') {
          if (args.length !== 1) throw new UsageError('epic show needs one epic id');
          const { board } = loadAll();
          const epic = findEpic(board, args[0]);
          const row = epicRows(board).find((r) => r.id === epic.id) as ReturnType<
            typeof epicRows
          >[number];
          const items = board.items.filter((i) => i.epic === epic.id);
          if (json) {
            print({ ...epic, progress: row.progress, counts: row.counts, items });
            return 0;
          }
          const lines = [
            `${epic.id}  ${epic.status}  ${row.progress.merged}/${row.progress.total}  ${epic.title}`,
            `Goal: ${epic.goal}`,
            'Acceptance:',
            ...epic.acceptance.map((a) => `  - ${a}`),
            ...(epic.components === undefined ? [] : [`Components: ${epic.components.join(', ')}`]),
            ...(epic.importedFrom === undefined ? [] : [`Imported from: ${epic.importedFrom}`]),
          ];
          stdout(`${lines.join('\n')}\n`);
          stdout(
            items.length === 0
              ? 'No items yet.\n'
              : table([['ID', 'STATUS', 'TITLE'], ...items.map((i) => [i.id, i.status, i.title])]),
          );
          return 0;
        }
        if (sub === 'drop') {
          refuseCrew(deps.env);
          if (args.length !== 1) throw new UsageError('epic drop needs one epic id');
          const id = args[0] as string;
          await withBoardLock(stateRoot(), ports.clock.now(), () => {
            const fresh = loadBoard(project);
            saveBoard(project, dropEpic(fresh, id, BY, ports.clock.now()));
          });
          print({ epic: id, status: 'dropped' });
          return 0;
        }
        if (sub === 'edit') {
          refuseCrew(deps.env);
          if (args.length !== 1) throw new UsageError('epic edit needs one epic id');
          const id = args[0] as string;
          const changed = await withBoardLock(stateRoot(), ports.clock.now(), () => {
            const r = editEpic(loadBoard(project, loadConfig(project)), id, {
              ...(values.title === undefined ? {} : { title: values.title }),
              ...(values.goal === undefined ? {} : { goal: values.goal }),
              ...(values.acceptance === undefined ? {} : { acceptance: values.acceptance }),
            });
            saveBoard(project, r.board);
            return r.changed;
          });
          print({ epic: id, changed });
          return 0;
        }
        throw new UsageError('epic needs add, list, show, edit or drop');
      }

      case 'roadmap': {
        if (rest[0] === 'import') {
          if (rest.length !== 2) throw new UsageError('roadmap import needs one file');
          if (values.out !== undefined || values.force !== undefined) {
            throw new UsageError('roadmap import takes only --write');
          }
          if (values.write === true) refuseCrew(deps.env);
          const { source, text } = readImportFile(project, rest[1] as string);
          const parsed = parsePhases(text);
          // Lines the parser skipped come first, then what the plan skipped.
          const apply = (board: Board) => {
            const p = planImport(board, source, parsed.phases);
            return { ...p, skipped: [...parsed.skipped, ...p.skipped] };
          };
          if (values.write !== true) {
            print({ ...apply(loadAll().board), written: false });
            return 0;
          }
          loadAll();
          const plan = await withBoardLock(stateRoot(), ports.clock.now(), () => {
            const fresh = loadBoard(project, loadConfig(project));
            const p = apply(fresh);
            if (p.create.length > 0) {
              saveBoard(project, { ...fresh, epics: [...(fresh.epics ?? []), ...p.create] });
            }
            return p;
          });
          print({ ...plan, written: plan.create.length > 0 });
          return 0;
        }
        if (rest.length !== 0) throw new UsageError('roadmap takes no arguments, or import <file>');
        if (values.write !== true && (values.out !== undefined || values.force !== undefined)) {
          throw new UsageError('--out and --force work with roadmap --write only');
        }
        if (values.write === true) refuseCrew(deps.env);
        const text = renderRoadmap(loadAll().board);
        if (values.write !== true) {
          stdout(text);
          return 0;
        }
        print(writeRoadmap(project, values.out ?? 'ROADMAP.md', text, values.force === true));
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
        print(await launch(rest[0]));
        return 0;
      }

      case 'tick': {
        refuseCrew(deps.env);
        if (rest.length > 0) throw new UsageError('tick takes no arguments');
        const out = await tick();
        // The pane's lead list: kept unless the tick never ran (no root, or another tick held it).
        if (
          !out.held.some((h) => h.item === 'tick') &&
          !out.errors.some((e) => e.phase === 'start')
        ) {
          try {
            writeTickRecord(await boundStateRoot(), {
              at: ports.clock.now().toISOString(),
              needsLead: out.needsLead,
              held: out.held,
            });
          } catch (e) {
            stderr(`error: tick record: ${(e as Error).message.replace(/\p{Cc}/gu, ' ')}\n`);
          }
        }
        print(out);
        return out.errors.length === 0 ? 0 : 1;
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
        const r = await collect(rest[0]);
        if (r.kind === 'moved') {
          print(r.out);
          return 0;
        }
        stderr(r.kind === 'waiting' ? `studio: ${r.line}\n` : `${r.line}\n`);
        return 1;
      }

      case 'queue': {
        const [sub, arg] = rest;
        if (sub === 'add') {
          print(await queueAdd(arg));
          return 0;
        }
        if (sub === 'run') {
          const r = await queueRun();
          print(r);
          return r.held === undefined ? 0 : 1;
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
        if (values.link === true && rest.length > 0) {
          throw new UsageError('--link belongs to studio setup without a subcommand');
        }
        if (rest.length === 0) {
          return await runSetup({
            project,
            ports,
            owner,
            env: deps.env,
            isTerminal: deps.isTerminal === true,
            ...(deps.readSecret === undefined ? {} : { readSecret: deps.readSecret }),
            ...(deps.readLine === undefined ? {} : { readLine: deps.readLine }),
            link: values.link === true,
            ...(deps.launcher === undefined ? {} : { launcher: deps.launcher }),
            stdout,
            stderr,
          });
        }
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
            'setup takes: [--link] | ci [--write] | stack [--write] | sources [<id>...]',
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
        component: { type: 'string', multiple: true },
        epic: { type: 'string' },
        goal: { type: 'string' },
        title: { type: 'string' },
        acceptance: { type: 'string', multiple: true },
        out: { type: 'string' },
        force: { type: 'boolean' },
        type: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string', multiple: true },
        dod: { type: 'string', multiple: true },
        plan: { type: 'string' },
        help: { type: 'boolean' },
        link: { type: 'boolean' },
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

/** In a held note: the CI read itself failed, so the hold may never end by itself. */
const CI_READ_FAILED = 'CI read failed:';

/** The board note for a pull request `collect` did not open for lack of CI capacity. */
function prHeldNote(cap: Capacity, config: StudioConfig): string {
  const parts = [`busy ${cap.ciBusy} of ${cap.ciTotal}, limit ${config.ci.capacity.mergeMaxBusy}`];
  if (cap.githubHostedBusy !== undefined && cap.githubHostedLimit !== undefined) {
    parts.push(`github-hosted ${cap.githubHostedBusy}, limit ${cap.githubHostedLimit}`);
  }
  if (!cap.hostOk) parts.push(`host load ${cap.hostLoad.toFixed(2)}`);
  const why = cap.error === undefined ? '' : `; ${CI_READ_FAILED} ${cap.error}`;
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
  epicOf?: (item: string) => string | undefined,
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
      const item = typeof ev.item === 'string' && isItemId(ev.item) ? ev.item : undefined;
      const epic = item === undefined ? undefined : epicOf?.(item);
      merged.push({
        pr: ev.pr,
        repo: typeof ev.repo === 'string' ? ev.repo : '',
        at: ev.at,
        t,
        ...(item === undefined ? {} : { item }),
        ...(epic === undefined ? {} : { epic }),
      });
    }
  }
  merged.sort((a, b) => a.t - b.t);
  return {
    day,
    merged: merged.slice(-MAX_MERGED_TODAY).map(({ t: _t, ...m }) => m),
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
      ...(item?.epic === undefined ? {} : { epic: item.epic }),
    };
  });
  const epics = epicRows(board)
    .filter((e) => e.status === 'open' || e.status === 'accepting')
    .map((e) => ({ id: e.id, title: e.title, status: e.status, ...e.progress }));
  const events = readMetricEvents(root);
  const usageDays = usageDaysFrom(ownerRoot);
  const ci = {
    busy: capacity.ciBusy,
    total: capacity.ciTotal,
    mergeMaxBusy: extra.config.ci.capacity.mergeMaxBusy,
    ok: capacity.ok,
  };
  const timezone = extra.ownerConfig.crewLabelLimits.timezone;
  const tickRecord = readTickRecord(root);
  const items = paneItems(board, queue, ci, {
    ...(tickRecord === undefined ? {} : { tick: tickRecord }),
    ...(components === undefined
      ? {}
      : { componentsOf: (i: WorkItem) => componentsOf(i, extra.config) }),
  });
  const pause = readPause(root);
  const roleWip = (pick: (role: string) => boolean) =>
    Object.entries(extra.config.roles)
      .filter(([role]) => pick(role))
      .reduce((n, [, r]) => n + (r?.wip ?? 0), 0);
  return {
    crew,
    queue,
    capacity,
    ci,
    today: todayFrom(events, now, timezone, (id) => board.items.find((i) => i.id === id)?.epic),
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
    ...(epics.length === 0 ? {} : { epics }),
    project: extra.config.primaryRepo.split('/').at(-1) ?? extra.config.primaryRepo,
    items,
    ...(tickRecord === undefined ? {} : { needsLead: leadDecisions(tickRecord, board) }),
    wip: {
      building: roleWip((r) => r !== 'reviewer'),
      review: roleWip((r) => r === 'reviewer'),
    },
    ...(pause.paused
      ? {
          pause:
            pause.at === undefined ? {} : { at: pause.at, time: clockTime(pause.at, timezone) },
        }
      : {}),
    updatedAt: now.toISOString(),
    metrics: computeMetrics(events),
  };
}
