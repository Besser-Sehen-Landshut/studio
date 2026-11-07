// The table of every text Studio shows a person: the pane, the status line, the toasts, the /studio
// command's replies, the pushes and the notify command's messages. One locale file per language
// (hooks/locales/<code>.ts) fills it; English is complete and every other locale is merged over it,
// so a missing text shows in English. Commands, codes and data stay English in every language.
// No imports but types: the board mod loads this, and it has no Node.
import type { BoardWait, CrewState, Stage, View } from '../board-model.js';

/** Values a coded text carries: ids, labels, counts, times. Never crew text. */
export type Params = Readonly<Record<string, string | number>>;

/** A line of Studio's own as a code and its values; the English line stays beside it as the fallback. */
export interface Reason {
  code: string;
  params?: Params;
}

/** The kinds of a push (src/push.ts). */
export type PushKind =
  | 'fix_limit'
  | 'changes_requested'
  | 'merge_failed'
  /** An external pull request (`studio merge`) was merged. */
  | 'merged'
  | 'question'
  | 'evidence'
  | 'blocked'
  | 'account_block'
  | 'release_approval'
  | 'release_failed'
  | 'release_announced'
  | 'analyzer_timeout'
  | 'rea_install'
  | 'other';

/** The steps of the merge queue's current entry (src/queue.ts). */
export type QueueStep = 'update' | 'checks' | 'capacity' | 'merge';

/** A row of the work list: what it shows by its sign. */
export type RowState = 'decision' | 'blocked' | 'running' | 'waiting' | 'ready';

/** Duration units: each gets a whole number and returns it with its unit, e.g. `5s`. */
export type Units = Record<'s' | 'm' | 'h' | 'd', (n: number) => string>;

/** The texts of the setup flows: `studio setup`, `relay pair`, `relay install`, `account add`. */
export interface SetupStrings {
  /** `<n>. <step>: <status>` */
  step: (n: number, name: string, status: string) => string;
  /** `<n>. <step>:` with what follows on the next lines. */
  stepOpen: (n: number, name: string) => string;
  done: (detail: string) => string;
  /** One line with the fix, the exact command in it. */
  fix: (what: string) => string;
  /** `--dry-run`: the first line, and one line per thing it would do. */
  dryRun: string;
  would: (what: string) => string;
  /** The last line of a flow: what comes next. */
  next: (what: string) => string;

  machine: string;
  windowsWhy: string;
  windowsFix: string;
  wsl1Why: string;
  wsl1Fix: (distro: string) => string;
  otherWhy: string;
  otherFix: string;
  missing: (label: string, list: string) => string;
  nodeOld: (min: number, have: string) => string;
  sandboxTools: string;
  tool: (name: string, command: string) => string;
  newTerminal: string;
  onWindowsDrive: (label: string, folder: 'config' | 'state', dir: string) => string;
  onWindowsDriveFix: string;
  machineDone: (label: string, node: string) => string;
  projectOnWindows: (path: string) => string;
  sshLater: (command: string) => string;

  gh: string;
  ghFix: (fix: string) => string;
  ghInstall: (command: string) => string;

  token: string;
  unusable: string;
  missingWord: string;
  tokenText: readonly string[];
  noRepo: string;
  repoPrompt: string;
  repoLooksLikeToken: string;
  repoNotOwnerName: string;
  tokenNothing: string;

  account: string;
  accountWrong: string;
  noneStored: string;
  accountText: (defaultLabel: string) => readonly string[];
  labelPrompt: (defaultLabel: string) => string;
  labelLooksLikeToken: string;
  labelBad: string;

  terminal: string;
  noPlugin: string;
  localBinOff: string;
  localBinHelp: readonly string[];
  untilThen: (command: string) => string;
  shimNote: string;
  notAShim: (target: string) => string;
  notAShimHelp: string;
  writePrompt: (target: string) => string;
  updatePrompt: (target: string) => string;
  nothingWritten: (command: string) => string;
  wrote: (target: string) => string;
  notOnPath: string;
  linkHint: string;
  untilParen: (command: string) => string;

  notifications: string;
  notifyConfigBad: readonly string[];
  notifyState: (state: 'bad' | 'ok' | 'none', transport: string) => string;
  notifyText: readonly string[];
  notifyPrompt: string;
  notifyNone: (unchanged: boolean) => string;
  notifyAnswer: string;
  noHttps: string;
  notifyOpen: string;
  notifySecret: string;
  notifyReady: string;
  notifyLater: string;
  notifyFailed: (why: string) => string;
  notifySent: string;

  research: string;
  researchOptional: string;
  researchConfigBad: string;
  researchDone: (version: string, mode: string, roots: string) => string;
  trustMode: string;
  strictMode: string;
  researchSkipped: string;
  notSetUp: string;
  researchText: readonly string[];
  researchPrompt: string;
  researchLater: string;
  researchInstalled: (version: string, mode: string, now: boolean) => string;

  finalNext: string;

  pairPc: string;
  pairWhat: (version: string) => string;
  pairHasStudio: (command: string) => string;
  pairThen: (command: string) => string;
  pairSecret: string;
  pairDeny: (set: string) => string;
  pairDenyProblem: (problem: string) => string;
  updateDenyPc: string;
  updateDenyWhat: (set: string) => string;
  denyUpdated: (added: string, rules: boolean) => string;
  installDenyAdded: (added: string) => string;
  paired: (
    label: string,
    where: string,
    studio: string,
    platform: string,
    fingerprint: string,
  ) => string;
  installWebClient: string;
  installStopped: string;
  hostKey: (fingerprint: string) => string;
  hostKeyUnknown: string;
  installNext: (label: string) => string;
  uninstallNoRecord: string;
  uninstallStopped: string;
  uninstallNext: (leads: readonly string[]) => string;
  accountStored: (label: string, active: boolean) => string;
  accountNext: string;
}

export interface Strings {
  // ---------- formatting ----------
  units: Units;
  /** A cost in US dollars. */
  money: (usd: number) => string;
  /** Hours with one decimal and their unit. */
  hours: (h: number) => string;

  // ---------- the pane, the status line and the toasts ----------
  missing: string;
  unreadable: string;
  paused: string;
  status: (working: number, waiting: number, queued: number, ci: string, forYou: number) => string;
  statusPaused: string;
  forYou: (title: string) => string;
  accountBlocked: (label: string, reason: string) => string;
  /** An account block reason code (src/limits.ts) in words; the code itself when unknown. */
  blockReason: (code: string) => string;
  mainRed: (sha: string) => string;
  crashed: (role: string, item: string) => string;
  more: (n: number) => string;
  crewState: Record<CrewState, string>;
  crossCutting: string;
  noComponent: string;
  noCrew: string;
  accepting: string;
  reopened: string;
  epicDone: string;
  now: string;
  next: string;
  queueEmpty: string;
  queueStep: Record<QueueStep, string>;
  mergedTodayList: string;
  ciUnreadable: string;
  mergeRule: (max: number, total: number, over: boolean) => string;
  headEpics: string;
  headCrew: string;
  headQueue: string;
  headForYou: (n: number) => string;
  headForLead: (n: number) => string;
  headExceptions: (n: number) => string;
  headReleases: (n: number) => string;
  /** A release's status in words. */
  releaseStatus: (status: string, pending: string[]) => string;
  /** Who decided an exception: the evidence, the lead or the owner. */
  exceptionBy: (by: string) => string;
  leadTimeLine: (median: string, deploys: number) => string;
  headDays: string;
  headUsage: string;
  lastUpdate: (min: number) => string;
  updated: (min: number) => string;
  stale: string;
  pausedTag: string;
  decisions: (n: number) => string;
  running: (n: number) => string;
  waiting: (n: number) => string;
  today: (n: number) => string;
  decisionHead: string;
  say: (phrase: string) => string;
  word: Record<RowState, string>;
  stage: Record<Stage, string>;
  done: (n: number) => string;
  doneToday: (n: number) => string;
  withoutEpic: string;
  leadTime: (h: string) => string;
  /** The cost of today's crew runs, one formatted value. */
  costToday: (cost: string) => string;
  /** A fixed phrase per decision code: the reason itself may be crew text and is never shown. */
  decision: (code: string) => string;
  /** A coded line of Studio's own (owner lines, holds); undefined for a code it has no words for. */
  reason: (r: Reason) => string | undefined;
  /** What an item waits for; `why` is the hold in words (or its English fallback). */
  wait: (w: BoardWait, why: string) => string;
  waitShort: (w: BoardWait) => string;
  column: { ready: string; building: string; review: string; queue: string; today: string };
  full: string;
  blocked: string;
  emptyTitle: string;
  emptyHint: string;
  emptyExample: string;
  pausedSince: (time: string | undefined) => string;
  staleBanner: (min: number) => string;
  staleQuestion: string;
  /** A phrase to say to the lead: a command, so English in every language. */
  staleSay: string;
  groupTitle: (name: string) => string;
  groupMain: string;
  groupHere: string;
  groupNone: string;
  groupIdle: string;
  groupProblem: (problem: string) => string;
  groupBack: (name: string) => string;
  groupOpen: string;
  /** The label of the REA install button. */
  reaConfirm: (version: string, withFolder: boolean) => string;

  // ---------- the /studio command (hooks/register.tsx) ----------
  paneTitle: string;
  commandDescription: string;
  /** `commands` is the English argument list, the language codes included. */
  usage: (commands: string) => string;
  notInProject: string;
  openFailed: string;
  opened: string;
  pauseNeedsTerminal: (command: string) => string;
  resumeNeedsTerminal: (command: string) => string;
  viewReply: Record<View, string>;
  focusReply: (project: string) => string;
  noProjectReply: (project: string) => string;
  /** The reply to `/studio lang`: this language, named in itself. */
  languageSet: string;
  /** `/studio off`: this session shows no board until `/studio on`. */
  offReply: string;
  onReply: string;
  /** The pane while the board is off in this session. */
  offPane: string;
  reaConfirmed: string;
  reaNotConfirmed: string;

  // ---------- the setup flows in the owner's terminal (src/setup.ts, src/relay-command.ts) ----------
  // Commands, flags, paths and values stay as they are in every language.
  setup: SetupStrings;

  // ---------- pushes (src/push.ts) ----------
  push: Record<PushKind, string>;
  pushOne: (phrase: string, item: string, project: string) => string;
  pushMany: (n: number, project: string, accountBlocked: boolean) => string;
  pushTest: string;
}

/** A locale's texts: any key may be left out (then English shows), records too, key by key. */
export type LocaleStrings = {
  [K in keyof Strings]?: Strings[K] extends (...args: never[]) => unknown
    ? Strings[K]
    : Strings[K] extends object
      ? Partial<Strings[K]>
      : Strings[K];
};

export interface Locale {
  /** The language code: the file name, lower case, two or three letters (ISO 639). */
  code: string;
  /** Lower-case names a language setting may use for it, e.g. `german`, `deutsch`. */
  names: readonly string[];
  strings: LocaleStrings;
  /** Keys this locale leaves to English on purpose; the parity test accepts only these as missing. */
  english?: readonly (keyof Strings)[];
}

/** `table[key]` for the table's own keys only: a code read from a file is never `constructor`. */
export const pick = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** Types a locale file's default export. */
export const defineLocale = (locale: Locale): Locale => locale;
