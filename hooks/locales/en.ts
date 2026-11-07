// English: complete. Every other locale is merged over this one.
import { formatter } from '../i18n/format.js';
import { defineLocale, pick, type Strings } from '../i18n/messages.js';

const f = formatter('en');
const n = f.number;

const strings: Strings = {
  units: {
    s: (v) => `${n(v)}s`,
    m: (v) => `${n(v)}m`,
    h: (v) => `${n(v)}h`,
    d: (v) => `${n(v)}d`,
  },
  money: (usd) => f.usd(usd),
  hours: (h) => `${f.decimal(h, 1)} h`,

  missing: 'No board yet. The control room writes it with studio state.',
  unreadable: 'The board cannot be read just now. It refreshes by itself.',
  paused: 'Paused.',
  status: (w, a, q, ci, y) =>
    `● ${n(w)} working · ${n(a)} waiting · ${n(q)} queued · CI ${ci} · for you: ${n(y)}`,
  statusPaused: 'paused',
  forYou: (t) => `For you: ${t}`,
  accountBlocked: (l, r) => `Account blocked${l ? ` (${l})` : ''}: ${r}`,
  blockReason: (code) =>
    pick(
      {
        authentication_failed: 'sign-in failed',
        organization_not_allowed: 'organization not allowed',
        organization_disabled: 'organization disabled',
        account_on_hold: 'account on hold',
        account_disabled: 'account disabled',
        policy_violation: 'usage policy',
        state_unreadable: 'block state unreadable',
      },
      code,
    ) ?? code,
  mainRed: (sha) => `Main build is red${sha ? ` (${sha})` : ''}`,
  crashed: (role, item) => `Crashed: ${role} on ${item}`,
  more: (v) => `… ${n(v)} more`,
  crewState: {
    working: 'working',
    waiting: 'waiting',
    blocked: 'blocked',
    stopped: 'stopped',
    crashed: 'crashed',
    done: 'done',
  },
  crossCutting: 'cross-cutting',
  noComponent: 'no component',
  noCrew: 'No crew running.',
  accepting: 'in acceptance',
  reopened: 'reopened',
  epicDone: 'done',
  now: 'now',
  next: 'next',
  queueEmpty: 'Queue is empty.',
  queueStep: {
    update: 'updating the branch',
    checks: 'checks pending',
    capacity: 'waiting for CI capacity',
    merge: 'merging',
  },
  mergedTodayList: 'Merged today',
  ciUnreadable: 'CI unreadable, counted as busy',
  mergeRule: (m, t, over) => `merge rule: at most ${n(m)}/${n(t)} busy${over ? ', now over' : ''}`,
  headEpics: 'Epics',
  headCrew: 'Crew',
  headQueue: 'Merge queue',
  headForYou: (v) => `For you (${n(v)})`,
  headForLead: (v) => `For the lead (${n(v)})`,
  headExceptions: (v) => `Exceptions by evidence (${n(v)})`,
  headReleases: (v) => `Releases (${n(v)})`,
  releaseStatus: (s, p) =>
    pick(
      {
        announced: 'announced, ready to trigger',
        approvals: `waits for approval: ${p.join(', ')}`,
        triggered: 'deploying',
        checking: 'deployed, checks running',
        done: 'done',
        failed: 'stopped: a check is red',
        stopped: 'cancelled',
      },
      s,
    ) ?? s,
  exceptionBy: (by) => (by === 'evidence' ? 'evidence' : by === 'owner' ? 'owner' : 'lead'),
  leadTimeLine: (m, d) => `Lead time (median) ${m} · deploys today ${n(d)}`,
  headDays: 'Last 7 days (merged/deployed)',
  headUsage: 'Usage (runs)',
  lastUpdate: (m) => `Last update ${n(m)} min ago.`,
  updated: (m) => (m < 1 ? 'updated just now' : `updated ${n(m)} min ago`),
  stale: '! stale',
  pausedTag: '◷ paused',
  decisions: (v) => `! ${n(v)} ${f.plural(v, { one: 'decision', other: 'decisions' })} needed`,
  running: (v) => `● ${n(v)} running`,
  waiting: (v) => `◷ ${n(v)} waiting`,
  today: (v) => `✓ ${n(v)} today`,
  decisionHead: 'Decision needed',
  say: (p) => `→ say "${p}"`,
  word: {
    decision: 'decide',
    blocked: 'blocked',
    running: 'running',
    waiting: 'waiting',
    ready: 'ready',
  },
  stage: {
    ready: 'ready',
    building: 'building',
    pr_held: 'PR held',
    review: 'review',
    queued: 'queue',
    blocked: 'blocked',
  },
  done: (v) => `✓ ${n(v)} done`,
  doneToday: (v) => `✓ ${n(v)} done today`,
  withoutEpic: 'Without epic',
  leadTime: (h) => `lead time ${h}`,
  costToday: (cost) => `today ${cost}`,
  decision: (code) =>
    pick(
      {
        fix_limit: 'fix limit reached – decide',
        changes_requested: 'changes requested',
        merge_failed: 'merge failed',
        question: 'crew has a question',
        evidence: 'guard hit without evidence – decide',
        blocked: 'blocked',
        release_approval: 'release approval needed',
        release_failed: 'release stopped: a check is red',
        analyzer_timeout: 'analyzer timed out – decide',
        rea_install: 'REA install – confirm once, here',
      },
      code,
    ) ?? 'needs a decision',
  reason: ({ code, params: p = {} }) => {
    switch (code) {
      case 'paused':
        return 'paused: nothing starts or merges until studio resume';
      case 'usage_full':
        return 'usage limit: every crew credential is at its limit';
      case 'usage_parked':
        return `usage limit: no crew credential free; earliest reset ${p.reset ?? 'unknown'}`;
      case 'usage_label':
        return `usage limit on ${p.label} until ${p.reset}; nothing launches on it`;
      case 'limits_unreadable':
        return 'limits.json is unreadable: no crew starts';
      case 'usage_unreadable':
        return 'usage.json is unreadable: no crew starts';
      case 'provider_failed':
        return 'the credential provider failed: no crew starts';
      case 'provider_empty':
        return 'the credential provider returned nothing: no crew starts';
      case 'credential_limit':
        return 'credential limit reached';
      case 'account_block':
        return `account block on ${p.labels}: no crew starts until studio accounts-clear`;
      case 'account_block_unreadable':
        return 'account block state unreadable (blocks.json): no crew starts';
      case 'crew_records_unreadable':
        return 'crew records are unreadable: no crew starts';
      case 'legacy_state':
        return 'old state files are not migrated yet: no merge';
      case 'busy':
        return 'another Studio process is busy: next tick';
      case 'ci_pending':
        return 'CI still running';
      case 'next_tick':
        return 'pull request opened just now: next tick';
      case 'waiting_on':
        return `waiting on ${p.items}`;
      case 'role_wip':
        return 'role WIP limit full';
      case 'component_wip':
        return `component ${p.component} WIP limit full`;
      case 'overlaps':
        return `overlaps ${p.item}`;
      case 'host_load':
        return 'host load: one build start at a time';
      case 'lead_work':
        return 'lead work: the lessons review';
      case 'ci_capacity':
        return 'CI capacity';
      case 'worker_offered':
        return `offered to ${p.label} (#${p.offer}), not claimed yet`;
      case 'worker_awaits':
        return `${p.worker}'s commit awaits its comment`;
      case 'worker_expired':
        return `claim of ${p.worker} expired (no heartbeat for ${p.minutes} min)`;
      case 'worker_on':
        return `on ${p.worker} (${p.label}), heartbeat ${p.minutes} min ago`;
      case 'worker_none':
        return `no worker accepted for ${p.label}`;
      case 'relay_on':
        return `on relay ${p.label}, crew running`;
      case 'relay_starting':
        return `on relay ${p.label}, starting the crew`;
      case 'relay_unreachable':
        return `relay ${p.label} unreachable for ${p.minutes} min`;
      case 'relay_held':
        return `relay ${p.label}: not now`;
      default:
        return undefined;
    }
  },
  wait: (w, why) => {
    switch (w.code) {
      case 'ci_capacity':
        return w.busy !== undefined && w.total !== undefined && w.max !== undefined
          ? `runners ${n(w.busy)}/${n(w.total)} busy, merge at ≤${n(w.max)}`
          : `CI capacity: ${why}`;
      case 'checks_pending':
        return 'checks pending';
      case 'review_pending':
        return 'review not started yet';
      case 'queue_held':
        return `queue held: ${why}`;
      case 'queue_position':
        return w.position === undefined ? why : `place ${n(w.position)} in the queue`;
      case 'updating':
        return 'updating the branch';
      case 'merging':
        return 'merging';
      case 'held':
        return `held: ${why}`;
      case 'worker':
        return `worker: ${why}`;
      default:
        return why;
    }
  },
  waitShort: (w) => {
    switch (w.code) {
      case 'ci_capacity':
        return w.busy !== undefined && w.total !== undefined
          ? `CI ${n(w.busy)}/${n(w.total)}`
          : 'CI';
      case 'worker':
        return 'worker';
      case 'checks_pending':
        return 'checks';
      case 'review_pending':
        return 'not started';
      case 'queue_position':
        return w.position === undefined ? 'queued' : `place ${n(w.position)}`;
      case 'updating':
        return 'update';
      case 'merging':
        return 'merging';
      default:
        return 'held';
    }
  },
  column: {
    ready: 'READY',
    building: 'BUILDING',
    review: 'REVIEW',
    queue: 'QUEUE',
    today: 'TODAY',
  },
  full: '⚠ full',
  blocked: 'BLOCKED',
  emptyTitle: 'No work yet.',
  emptyHint: 'Describe in plain words what should be built, e.g.:',
  emptyExample: '"New item for the API: … Done when a test shows …"',
  pausedSince: (t) =>
    `${t === undefined ? 'Paused.' : `Paused since ${t}.`} Nothing starts or merges; running crews finish.`,
  staleBanner: (m) => `Last update ${n(m)} min ago.`,
  staleQuestion: 'Is the lead loop still running?',
  staleSay: 'start the Studio lead loop',
  groupTitle: (name) => `Group ${name}`,
  groupMain: 'main',
  groupHere: 'here',
  groupNone: 'This project is in no group. Groups are set in the owner config.',
  groupIdle: 'nothing open',
  groupProblem: (p) =>
    pick(
      {
        'no state yet': 'no state yet',
        'state unreadable': 'state unreadable',
        'folder cannot be read': 'folder cannot be read',
      },
      p,
    ) ?? 'cannot be read',
  groupBack: (name) => `Group ${name} · back: /studio group`,
  groupOpen: 'open a project: /studio group <project>',
  reaConfirm: (v, withFolder) =>
    `Confirm REA install (rea-agents ${v}${withFolder ? ', folder ~/analysis' : ''})`,

  paneTitle: 'Studio board',
  commandDescription: 'Show the Studio board: work list, pipeline or details',
  usage: (commands) => `Usage: /studio [${commands}]`,
  notInProject: 'Not in a Studio project.',
  openFailed: 'The board could not be opened here.',
  opened: 'Studio board opened.',
  pauseNeedsTerminal: (command) => `Pausing needs a terminal: run ${command}`,
  resumeNeedsTerminal: (command) => `Resuming needs a terminal: run ${command}`,
  viewReply: {
    list: 'Studio board: work list.',
    pipeline: 'Studio board: pipeline (the work list when the pane is narrow).',
    more: 'Studio board: details. Back with /studio list.',
    group: 'Studio board: the group, one line per project.',
  },
  focusReply: (id) => `Studio board: the work list of ${id}. Back with /studio group.`,
  noProjectReply: (id) => `No project ${id} in this group. See /studio group.`,
  languageSet: 'Studio board: English.',
  offReply:
    'Studio board off in this session: no pane, status line or toasts. Back with /studio on.',
  onReply: 'Studio board on again in this session.',
  offPane: 'Studio board is off in this session. → /studio on',
  reaConfirmed: 'REA install confirmed. It installs on the next launch that needs it.',
  reaNotConfirmed:
    'The REA confirmation could not be saved; run studio research install in your own terminal.',

  setup: {
    step: (k, name, status) => `${k}. ${name}: ${status}`,
    stepOpen: (k, name) => `${k}. ${name}:`,
    done: (d) => `done (${d})`,
    fix: (what) => `   Fix: ${what}`,
    dryRun: 'Dry run: nothing is written, stored or changed.',
    would: (what) => `   would ${what}`,
    next: (what) => `Done. Next: ${what}`,

    machine: 'This machine',
    windowsWhy: 'the lead does not run on native Windows (Claude Code has no sandbox there)',
    windowsFix:
      'in PowerShell as administrator: wsl --install -d Ubuntu-24.04, restart the PC, open Ubuntu and run studio setup there (README, "Lead on a Windows PC (WSL2)")',
    wsl1Why: 'this is WSL1 (or a WSL whose version cannot be told); the lead needs WSL2',
    wsl1Fix: (d) =>
      `in PowerShell: wsl --set-version ${d} 2, then open it again and run studio setup`,
    otherWhy: 'this platform is not supported',
    otherFix: 'run the lead on macOS, Linux or WSL2',
    missing: (label, list) => `${label}; missing: ${list}`,
    nodeOld: (min, have) => `Node.js ${min} (this is ${have})`,
    sandboxTools: "bubblewrap and socat (Claude Code's sandbox)",
    tool: (name, command) => `   ${name}: ${command}`,
    newTerminal: '   Then open a new terminal and run studio setup again.',
    onWindowsDrive: (label, folder, dir) =>
      `${label}; Studio's ${folder} folder ${dir} is on a Windows drive, which keeps no file modes (tokens and keys there would be open)`,
    onWindowsDriveFix:
      '   Fix: unset XDG_CONFIG_HOME and XDG_STATE_HOME, or point them below ~ in the Linux file system, then run studio setup again.',
    machineDone: (label, node) => `done (${label}, git, Node.js ${node}, claude)`,
    projectOnWindows: (p) =>
      `   Note: the project ${p} is on a Windows drive; clone it into the Linux file system (under ~) for speed and exact file modes.`,
    sshLater: (command) => `   For relay workers later: ssh and ssh-keygen (${command}).`,

    gh: 'GitHub CLI',
    ghFix: (fix) => `   Fix: ${fix}, then run studio setup again.`,
    ghInstall: (command) => `${command}, then gh auth login`,

    token: 'Crew token',
    unusable: 'the stored file is not usable',
    missingWord: 'missing',
    tokenText: [
      '   Crews push their branches and open pull requests with a GitHub token of their own, never',
      '   with your gh login. Create a fine-grained token on GitHub (Settings, Developer settings,',
      "   Personal access tokens), limited to this project's repositories, with",
      '   contents and pull requests read/write and nothing else (no administration, no workflows).',
      '   Studio checks it once against the repository and stores it with mode 0600; it is never shown.',
      '   The token goes only into the hidden prompt.',
    ],
    noRepo:
      '   No GitHub repository found here. The next prompt is visible; the token comes after.',
    repoPrompt: '   Repository the crews work on, as owner/name (visible): ',
    repoLooksLikeToken: '   that looks like a token — it was not stored; enter owner/name',
    repoNotOwnerName: '   that is not owner/name; nothing stored',
    tokenNothing: '   Nothing stored. Fix the token on GitHub, then run studio setup again.',

    account: 'Claude account for crews',
    accountWrong: '   Run studio account list and studio doctor to see what is wrong.',
    noneStored: 'none stored',
    accountText: (def) => [
      '   Crews run Claude Code with a token of their own, so your own login stays yours. In another',
      '   terminal tab run: claude setup-token',
      '   It prints a token valid for one year (it needs a Pro, Max, Ultra, Team or Enterprise plan).',
      `   First you type a short label for this account (visible; Enter keeps ${def}).`,
      '   Then you paste the token at the second prompt (hidden).',
    ],
    labelPrompt: (def) =>
      `   Short label for this account, visible (Enter keeps ${def}) [${def}]: `,
    labelLooksLikeToken: '   that looks like a token — it was not stored; enter a short label',
    labelBad:
      '   a label has letters, digits, dot, dash or underscore and does not start with a dot; nothing stored',

    terminal: 'studio in your terminal',
    noPlugin: 'cannot tell where the plugin is; nothing written',
    localBinOff: '~/.local/bin is not on your PATH.',
    localBinHelp: [
      "   Studio does not edit shell files. Add ~/.local/bin to PATH in your shell's startup",
      '   file, open a new terminal and run studio setup --link again.',
    ],
    untilThen: (command) => `   Until then: ${command}`,
    shimNote: '   The shim finds the plugin again after an update; no need to run --link again.',
    notAShim: (target) => `${target} is not a Studio shim; nothing changed.`,
    notAShimHelp: '   Move it away and run studio setup --link again, or keep it.',
    writePrompt: (target) => `   Write the Studio shim ${target}? [Y/n] `,
    updatePrompt: (target) => `   Update the Studio shim ${target}? [Y/n] `,
    nothingWritten: (command) => `   nothing written; until you do: ${command}`,
    wrote: (target) => `   wrote ${target}`,
    notOnPath: 'not on your PATH (Claude Code finds it on its own).',
    linkHint: '   To use studio in any terminal: studio setup --link',
    untilParen: (command) => `   (until then: ${command})`,

    notifications: 'Notifications',
    notifyConfigBad: [
      'the owner config cannot be read; fix it with studio doctor, then run',
      '   studio setup --notifications. Nothing stored.',
    ],
    notifyState: (state, transport) =>
      state === 'bad'
        ? 'the stored file is not usable'
        : state === 'ok'
          ? `set up (${transport}), set up again`
          : 'none',
    notifyText: [
      '   Studio can push one line to your phone when it needs a decision: a fixed phrase, the item',
      '   id and the project name, nothing else. It uses ntfy, which needs no account: Studio makes a',
      '   secret topic, you subscribe to it in the ntfy app.',
    ],
    notifyPrompt: '   ntfy or none? [ntfy/none] (Enter: ntfy): ',
    notifyNone: (unchanged) =>
      `   ${unchanged ? 'unchanged' : 'no notifications'}; later: studio setup --notifications`,
    notifyAnswer: '   answer ntfy or none; nothing stored',
    noHttps: '   no HTTPS client in this process; nothing stored',
    notifyOpen: '   Install the ntfy app and open this link:',
    notifySecret:
      '   The link is the secret: whoever has it reads your pushes. Studio shows it only here.',
    notifyReady: '   Press Enter once you subscribed (type skip to stop): ',
    notifyLater: '   nothing stored; later: studio setup --notifications',
    notifyFailed: (why) => `   test push failed: ${why}; nothing stored`,
    notifySent: '   test push sent; check your phone. Topic stored.',

    research: 'Reverse engineering',
    researchOptional: 'Reverse engineering (optional)',
    researchConfigBad:
      'the owner config cannot be read; fix it with studio doctor. Nothing changed.',
    researchDone: (version, mode, roots) => `done (rea-agents ${version}, ${mode}, ${roots})`,
    trustMode: 'trust mode',
    strictMode: 'strict mode',
    researchSkipped: 'skipped; studio setup research sets it up',
    notSetUp: 'not set up',
    researchText: [
      '   A researcher crew can reverse engineer shipped programs with REA (rea-agents). Studio installs',
      '   it once into its own state, checked against the npm registry, and grants it one analysis',
      '   folder. REA tools run with your user rights outside the sandbox. Skip it if you never need it:',
      '   Studio asks again the first time a researcher item needs it.',
    ],
    researchPrompt: '   Set it up now? [y/N] ',
    researchLater: '   skipped; later: studio setup research',
    researchInstalled: (version, mode, now) =>
      `   done (rea-agents ${version}, ${mode}${now ? ', installed now' : ''})`,

    finalNext: 'Done. Now open your project in Claude Code and run /studio:init.',

    pairPc:
      'On the Windows PC, in an elevated PowerShell (at the PC or over remote desktop, never over SSH), within the hour:',
    pairWhat: (version) =>
      `It installs Node.js and Git if missing (it asks first), Studio ${version} and the relay worker.`,
    pairHasStudio: (command) => `With Studio there already: ${command}`,
    pairThen: (command) => `Then here: ${command}`,
    pairSecret: 'The line holds a single-use secret: paste it on the worker only.',
    pairDeny: (set) =>
      `It carries the deny list of your projects for this worker (${set}); the worker blocks it in its firewall.`,
    pairDenyProblem: (problem) => `note: ${problem} (its deny list is not in the line)`,
    updateDenyPc:
      'On the Windows PC, in an elevated PowerShell (at the PC or over remote desktop, never over SSH), within a day:',
    updateDenyWhat: (set) =>
      `It adds the deny list of your projects (${set}) to workers.serve.deny of the worker and writes its firewall rules anew; it removes nothing and pairs nothing.`,
    denyUpdated: (added, rules) =>
      `Done. workers.serve.deny: ${added === 'nothing' ? 'nothing new' : `added ${added}`}${rules ? '; the firewall rules hold it' : ' (no lockdown here: --no-firewall)'}. Relay starts go on.`,
    installDenyAdded: (added) => `workers.serve.deny: added ${added} from the pairing line`,
    systemFolders: (w, pf, pd) =>
      `system folders (from Windows, not the environment): Windows ${w}, Program Files ${pf}, ProgramData ${pd}`,
    paired: (label, where, studio, platform, fp) =>
      `paired: ${label} is ${where}, Studio ${studio} on ${platform}, host key pinned (${fp}).`,
    installWebClient:
      'Studio relay install: this stops and disables the WebClient service (WebDAV), which the crew sandbox does not hold.',
    installStopped: 'studio: relay install stopped; fix what it says and run it again (it repairs)',
    hostKey: (fp) => `host key fingerprint: ${fp}`,
    hostKeyUnknown: 'host key: cannot read the OpenSSH server host key',
    installNext: (label) =>
      `Done. Next, on the lead within the hour: studio relay pair ${label} --connect`,
    uninstallNoRecord:
      'No install record here (an install of an earlier version): services Studio stopped stay as they are.',
    uninstallStopped:
      'studio: relay uninstall stopped; fix what it says and run studio relay uninstall again (it goes on where it stopped)',
    uninstallNext: (leads) =>
      leads.length === 0
        ? 'Done. Next: on the lead, remove this worker from workers.relay in the owner config.'
        : `Done. Next: on each lead, remove ${leads.map((l) => `workers.relay.${l}`).join(', ')} from the owner config.`,
    accountStored: (label, active) => `account ${label} stored${active ? ' and active' : ''}`,
    accountNext: 'Done. Next: studio doctor shows the account; studio setup runs the other steps.',
  },

  push: {
    fix_limit: 'Fix limit reached',
    changes_requested: 'Changes requested',
    merge_failed: 'Merge failed',
    merged: 'Merged',
    question: 'Crew has a question',
    evidence: 'Guard hit, the owner decides',
    blocked: 'Blocked',
    account_block: 'Account blocked',
    release_approval: 'Release approval needed',
    release_failed: 'Release stopped, a check is red',
    release_announced: 'Release announced, it cannot be undone once triggered',
    analyzer_timeout: 'Analyzer timed out',
    rea_install: 'REA install needs your yes',
    other: 'Decision needed',
  },
  pushOne: (phrase, item, project) => `${phrase}: ${item} in ${project}`,
  pushMany: (v, project, blocked) =>
    `${n(v)} ${f.plural(v, { one: 'decision', other: 'decisions' })} needed in ${project}${blocked ? ': account blocked' : ''}`,
  pushTest: 'Test: Studio reaches you here',
};

export default defineLocale({ code: 'en', names: ['english'], strings });
