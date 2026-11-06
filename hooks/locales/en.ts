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
  reaConfirmed: 'REA install confirmed. It installs on the next launch that needs it.',
  reaNotConfirmed:
    'The REA confirmation could not be saved; run studio research install in your own terminal.',

  push: {
    fix_limit: 'Fix limit reached',
    changes_requested: 'Changes requested',
    merge_failed: 'Merge failed',
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
