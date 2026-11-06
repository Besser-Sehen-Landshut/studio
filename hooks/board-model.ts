// Pure board model for the Studio pane. No Node, no engine code: its only imports are the shared
// texts (hooks/i18n, hooks/locales), which import nothing either.
// It reads the snapshot that `studio state` writes (StateSnapshot in src/state.ts) leniently.
import {
  isLang,
  LANGS,
  type Lang,
  langOf,
  type Params,
  type QueueStep,
  type Reason,
  type Strings,
  stringsFor,
} from './i18n/index.js';
import { pick, type RowState } from './i18n/messages.js';

export { isLang, LANGS, type Lang, langOf };

export type CrewState = 'working' | 'waiting' | 'blocked' | 'stopped' | 'crashed' | 'done';

export interface BoardCrew {
  role: string;
  item: string;
  state: CrewState;
  title?: string;
  pr?: number;
  since?: string;
  stoppedAt?: string;
  label?: string;
  /** Ids of the item's components; absent when the project configures none. */
  components?: string[];
  /** The epic of the item; absent when it has none. */
  epic?: string;
}

export interface BoardEpic {
  id: string;
  title: string;
  status: string;
  /** open, reopened, accepting or done; absent from an older Studio. */
  stage?: string;
  merged: number;
  total: number;
  /** The acceptance item that runs, or the last one. */
  acceptance?: string;
}

export interface BoardState {
  crew: BoardCrew[];
  queue: {
    current?: { pr: number; repo: string; step: string; item?: string };
    pending: { pr: number; repo: string; item?: string }[];
  };
  ci: { busy: number; total: number; mergeMaxBusy: number; ok: boolean };
  /** `costUsd`: what this project's ended crew runs cost today; absent when unknown. */
  today: { merged: number[]; deployed: number; costUsd?: number };
  /** Ascending by day. */
  usageDays: { day: string; labels: { label: string; runs: number }[] }[];
  mainBuild: { status: string; sha?: string };
  counts: { ready: number; queued: number };
  /** `title` is English; `code` and `params`, when set, are what the pane words itself. */
  forOwner: OwnerLine[];
  notifications: { label: string; reason: string; title: string }[];
  /** Ascending by day. */
  perDay: { day: string; merged: number; deployed: number }[];
  medianLeadTimeHours: number | null;
  updatedAt?: string;
  /** Configured components in config order; absent (or empty) without any. */
  components?: { id: string; name: string }[];
  /** Open and accepting epics in id order with merged of total; absent without any. */
  epics?: BoardEpic[];
  /** The repository name of the project, for the header. */
  project?: string;
  /** Every open item with its stage; absent from a state written before the work list. */
  items?: BoardItem[];
  /** The latest tick's lead decisions. */
  needsLead?: BoardDecision[];
  /** WIP limits of the pipeline columns; 0 is none. */
  wip?: { building: number; review: number };
  /** Present while paused; `time` is `HH:MM` on the owner's clock. */
  pause?: { time?: string };
  /** Merges of today with their items and epics, oldest first. */
  mergedToday?: { pr: number; item?: string; epic?: string }[];
  /** Exceptions by evidence of the last days, newest first. */
  exceptions?: { rule: string; pr: string; item?: string; head: string; by: string }[];
  /** Open releases and those that ended in the last days, newest first. */
  releases?: BoardRelease[];
  /** This project's group: one row per project (the group view). */
  group?: BoardGroup;
  /** A REA install waits for the owner's one confirmation: what the pane's button confirms. */
  reaInstall?: { version: string; mode: 'full' | 'static'; needsFolder: boolean };
}

export interface OwnerLine {
  id: string;
  title: string;
  code?: string;
  params?: Params;
}

export interface BoardGroupRow {
  id: string;
  repo: string;
  main: boolean;
  self: boolean;
  /** The project's state folder name: the pane opens its work list from there. */
  stateDir?: string;
  counts?: { decisions: number; running: number; waiting: number; ready: number; blocked: number };
  decisions: { item: string; code: string }[];
  problem?: string;
}

export interface BoardGroup {
  name: string;
  main: string;
  self: string;
  projects: BoardGroupRow[];
}

export interface BoardRelease {
  id: string;
  component: string;
  /** announced, approvals, triggered, checking, done, failed or stopped. */
  status: string;
  sha: string;
  /** Approvals it waits for: `owner` and approver ids. */
  pending?: string[];
}

export type Stage = 'ready' | 'building' | 'pr_held' | 'review' | 'queued' | 'blocked';

export interface BoardWait {
  code: string;
  text: string;
  busy?: number;
  total?: number;
  max?: number;
  position?: number;
  /** What holds it, as a code: the pane words it; `text` is the English fallback. */
  reason?: Reason;
}

export interface BoardItem {
  id: string;
  title: string;
  stage: Stage;
  epic?: string;
  since?: string;
  wait?: BoardWait;
}

export interface BoardDecision {
  /** An item id, or another key (`account-block`, `main-build`) that is not shown. */
  item: string;
  code: string;
  /** Not shown: the pane words each code itself, so crew text never reaches the block. */
  reason: string;
  /** The lead's full line, possibly crew text: the detailed view alone shows it. */
  detail?: string;
  next?: { say?: string; type?: string };
}

export type BoardRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; state: BoardState };

export type Line = {
  text: string;
  tone?: 'ok' | 'wait' | 'idle' | 'err' | 'dim' | 'head' | 'run' | 'you';
  /** A control the person presses: the mod draws a Button with this key and label. */
  button?: { key: string; label: string };
};

/** The key of the pane's one-time REA install confirmation (handled in register.tsx). */
export const REA_CONFIRM_KEY = 'rea-confirm';

export type View = 'list' | 'pipeline' | 'more' | 'group';
export const VIEWS: readonly View[] = ['list', 'pipeline', 'more', 'group'];

const MAX_STRING = 200;
const STATES: readonly CrewState[] = [
  'working',
  'waiting',
  'blocked',
  'stopped',
  'crashed',
  'done',
];

// ---------- parsing ----------

/** Strips control, format (bidi overrides, zero-width) and line/paragraph separators; caps at 200 code points. */
function clean(s: string): string {
  const stripped = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  const cps = [...stripped];
  return cps.length > MAX_STRING ? cps.slice(0, MAX_STRING).join('') : stripped;
}

const MAX_DEPTH = 8;

/** Cleans every string (and object key) of a parsed JSON value. Values nested deeper than 8 are dropped. */
function sanitize(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v))
    return depth >= MAX_DEPTH ? undefined : v.map((x) => sanitize(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    if (depth >= MAX_DEPTH) return undefined;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [clean(k), sanitize(x, depth + 1)]),
    );
  }
  return v;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const entries = (v: unknown): [string, unknown][] => {
  const o = obj(v);
  return o ? Object.entries(o) : [];
};

function parseCrew(raw: unknown): BoardCrew | undefined {
  const o = obj(raw);
  if (!o) return undefined;
  const role = str(o.role);
  const item = str(o.item);
  const state = STATES.find((s) => s === o.state);
  if (role === undefined || item === undefined || state === undefined) return undefined;
  const row: BoardCrew = { role, item, state };
  for (const k of ['title', 'since', 'stoppedAt', 'label'] as const) {
    const v = str(o[k]);
    if (v !== undefined) row[k] = v;
  }
  const pr = num(o.pr);
  if (pr !== undefined) row.pr = pr;
  if (Array.isArray(o.components)) row.components = o.components.flatMap((c) => str(c) ?? []);
  const epic = str(o.epic);
  if (epic !== undefined) row.epic = epic;
  return row;
}

function parseEntry(raw: unknown): { pr: number; repo: string; item?: string } | undefined {
  const o = obj(raw);
  const pr = num(o?.pr);
  const repo = str(o?.repo);
  if (!o || pr === undefined || repo === undefined) return undefined;
  const item = str(o.item);
  return item === undefined ? { pr, repo } : { pr, repo, item };
}

function toState(root: Obj): BoardState {
  const queue = obj(root.queue);
  const current = parseEntry(queue?.current);
  const cur = obj(queue?.current);
  const ci = obj(root.ci);
  const today = obj(root.today);
  const counts = obj(root.counts);
  const main = obj(root.mainBuild);
  const metrics = obj(root.metrics);
  const sha = str(main?.sha);
  const median = num(metrics?.medianLeadTimeHours);
  const updatedAt = str(root.updatedAt);
  const state: BoardState = {
    crew: list(root.crew).flatMap((r) => parseCrew(r) ?? []),
    queue: {
      pending: list(queue?.pending).flatMap((r) => parseEntry(r) ?? []),
      ...(current ? { current: { ...current, step: str(cur?.step) ?? '' } } : {}),
    },
    ci: {
      busy: num(ci?.busy) ?? 0,
      total: num(ci?.total) ?? 0,
      mergeMaxBusy: num(ci?.mergeMaxBusy) ?? 0,
      ok: ci?.ok === true,
    },
    today: {
      merged: list(today?.merged).flatMap((m) => num(obj(m)?.pr) ?? []),
      deployed: num(today?.deployed) ?? 0,
      ...(num(today?.costUsd) === undefined ? {} : { costUsd: num(today?.costUsd) as number }),
    },
    usageDays: entries(root.usageDays)
      .map(([day, labels]) => ({
        day,
        labels: entries(labels).flatMap(([label, runs]) =>
          num(runs) === undefined ? [] : [{ label, runs: runs as number }],
        ),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    mainBuild: { status: str(main?.status) ?? 'unknown', ...(sha === undefined ? {} : { sha }) },
    counts: { ready: num(counts?.ready) ?? 0, queued: num(counts?.queued) ?? 0 },
    forOwner: list(root.forOwner).flatMap((r) => {
      const o = obj(r);
      const id = str(o?.id);
      const title = str(o?.title);
      if (id === undefined || title === undefined) return [];
      const reason = parseReason(o);
      return [{ id, title, ...(reason === undefined ? {} : reason) }];
    }),
    notifications: list(root.notifications).flatMap((r) => {
      const o = obj(r);
      const reason = str(o?.reason);
      if (reason === undefined) return [];
      return [{ label: str(o?.label) ?? '', reason, title: str(o?.title) ?? '' }];
    }),
    perDay: entries(metrics?.perDay)
      .map(([day, c]) => ({
        day,
        merged: num(obj(c)?.merged) ?? 0,
        deployed: num(obj(c)?.deployed) ?? 0,
      }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    medianLeadTimeHours: median ?? null,
  };
  if (updatedAt !== undefined) state.updatedAt = updatedAt;
  const components = list(root.components).flatMap((r) => {
    const id = str(obj(r)?.id);
    const name = str(obj(r)?.name);
    return id === undefined || name === undefined ? [] : [{ id, name }];
  });
  if (components.length > 0) state.components = components;
  const epics = list(root.epics).flatMap((r) => {
    const o = obj(r);
    const id = str(o?.id);
    const title = str(o?.title);
    const status = str(o?.status);
    const merged = num(o?.merged);
    const total = num(o?.total);
    const stage = str(o?.stage);
    const acceptance = str(o?.acceptance);
    return id === undefined ||
      title === undefined ||
      status === undefined ||
      merged === undefined ||
      total === undefined
      ? []
      : [
          {
            id,
            title,
            status,
            ...(stage === undefined ? {} : { stage }),
            merged,
            total,
            ...(acceptance === undefined ? {} : { acceptance }),
          },
        ];
  });
  if (epics.length > 0) state.epics = epics;
  const project = str(root.project);
  if (project !== undefined) state.project = project;
  if (Array.isArray(root.items)) state.items = root.items.flatMap((r) => parseItem(r) ?? []);
  if (Array.isArray(root.needsLead)) {
    state.needsLead = root.needsLead.flatMap((r) => {
      const o = obj(r);
      const item = str(o?.item);
      const reason = str(o?.reason);
      if (item === undefined || reason === undefined) return [];
      const say = str(obj(o?.next)?.say);
      const detail = str(o?.detail);
      return [
        {
          item,
          code: str(o?.code) ?? 'other',
          reason,
          ...(detail === undefined ? {} : { detail }),
          // Only a plain phrase is offered to say; anything else falls back to `show <id>`.
          ...(say === undefined || !SAY.test(say) ? {} : { next: { say } }),
        },
      ];
    });
  }
  const wip = obj(root.wip);
  if (wip) state.wip = { building: num(wip.building) ?? 0, review: num(wip.review) ?? 0 };
  const pause = obj(root.pause);
  if (pause) {
    const time = str(pause.time);
    state.pause = time !== undefined && /^\d\d:\d\d$/.test(time) ? { time } : {};
  }
  const mergedToday = list(today?.merged).flatMap((m) => {
    const o = obj(m);
    const pr = num(o?.pr);
    if (pr === undefined) return [];
    const item = str(o?.item);
    const epic = str(o?.epic);
    return [
      { pr, ...(item === undefined ? {} : { item }), ...(epic === undefined ? {} : { epic }) },
    ];
  });
  if (mergedToday.some((m) => m.item !== undefined)) state.mergedToday = mergedToday;
  const exceptions = list(root.exceptions).flatMap((r) => {
    const o = obj(r);
    const rule = str(o?.rule);
    const pr = str(o?.pr);
    const head = str(o?.head);
    const by = str(o?.by);
    if (rule === undefined || pr === undefined || head === undefined || by === undefined) return [];
    const item = str(o?.item);
    return [{ rule, pr, head, by, ...(item === undefined ? {} : { item }) }];
  });
  if (exceptions.length > 0) state.exceptions = exceptions;
  const releases = list(root.releases).flatMap((r) => {
    const o = obj(r);
    const id = str(o?.id);
    const component = str(o?.component);
    const status = str(o?.status);
    const sha = str(o?.sha);
    if (id === undefined || component === undefined || status === undefined || sha === undefined) {
      return [];
    }
    const pending = list(o?.pending).flatMap((p) => {
      const v = str(p);
      return v === undefined ? [] : [v];
    });
    return [{ id, component, status, sha, ...(pending.length === 0 ? {} : { pending }) }];
  });
  if (releases.length > 0) state.releases = releases;
  const group = parseGroup(root.group);
  if (group !== undefined) state.group = group;
  const rea = obj(root.reaInstall);
  const reaVersion = str(rea?.version);
  if (
    rea !== undefined &&
    reaVersion !== undefined &&
    /^\d+\.\d+\.\d+$/.test(reaVersion) &&
    (rea.mode === 'full' || rea.mode === 'static')
  ) {
    state.reaInstall = {
      version: reaVersion,
      mode: rea.mode,
      needsFolder: rea.needsFolder === true,
    };
  }
  return state;
}

/** A project id, item id, decision code and state folder name: only these forms are kept. */
const GROUP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DECISION_CODE = /^[a-z_]{1,32}$/;
/** As stateDirName in src/paths.ts: 16 hex digits and a sanitised name. */
export const STATE_DIR = /^[0-9a-f]{16}(?:-[A-Za-z0-9._-]{1,32})?$/;

function parseGroup(raw: unknown): BoardGroup | undefined {
  const g = obj(raw);
  const name = str(g?.name);
  const main = str(g?.main);
  const self = str(g?.self);
  if (!g || name === undefined || main === undefined || self === undefined) return undefined;
  if (![name, main, self].every((x) => GROUP_ID.test(x))) return undefined;
  const projects = list(g.projects).flatMap((r): BoardGroupRow[] => {
    const o = obj(r);
    const id = str(o?.id);
    if (!o || id === undefined || !GROUP_ID.test(id)) return [];
    const c = obj(o.counts);
    const counts =
      c === undefined
        ? undefined
        : {
            decisions: num(c.decisions) ?? 0,
            running: num(c.running) ?? 0,
            waiting: num(c.waiting) ?? 0,
            ready: num(c.ready) ?? 0,
            blocked: num(c.blocked) ?? 0,
          };
    const stateDir = str(o.stateDir);
    const problem = str(o.problem);
    return [
      {
        id,
        repo: str(o.repo) ?? '',
        main: o.main === true,
        self: o.self === true,
        ...(stateDir !== undefined && STATE_DIR.test(stateDir) ? { stateDir } : {}),
        ...(counts === undefined ? {} : { counts }),
        decisions: list(o.decisions).flatMap((d) => {
          const item = str(obj(d)?.item);
          const code = str(obj(d)?.code);
          return item !== undefined &&
            ITEM_ID.test(item) &&
            code !== undefined &&
            DECISION_CODE.test(code)
            ? [{ item, code }]
            : [];
        }),
        ...(problem === undefined ? {} : { problem }),
      },
    ];
  });
  return projects.length === 0 ? undefined : { name, main, self, projects };
}

const REASON_CODE = /^[a-z_]{1,40}$/;
const PARAM_KEY = /^[a-z][A-Za-z]{0,31}$/;
const MAX_PARAMS = 8;

/** A reason code and its values (strings and numbers only), or undefined when it is none. */
function parseReason(o: Obj | undefined): Reason | undefined {
  const code = str(o?.code);
  if (code === undefined || !REASON_CODE.test(code)) return undefined;
  const params = entries(o?.params)
    .filter(([k, v]) => PARAM_KEY.test(k) && (str(v) !== undefined || num(v) !== undefined))
    .slice(0, MAX_PARAMS) as [string, string | number][];
  return params.length === 0 ? { code } : { code, params: Object.fromEntries(params) };
}

/** A next step the pane offers: lower-case words and item ids, nothing else. */
const SAY = /^[a-z]+(?: (?:[a-z]+|[A-Z]+-\d+))*$/;

const STAGES: readonly Stage[] = ['ready', 'building', 'pr_held', 'review', 'queued', 'blocked'];

function parseItem(raw: unknown): BoardItem | undefined {
  const o = obj(raw);
  const id = str(o?.id);
  const stage = STAGES.find((s) => s === o?.stage);
  if (!o || id === undefined || stage === undefined) return undefined;
  const row: BoardItem = { id, title: str(o.title) ?? '', stage };
  const epic = str(o.epic);
  if (epic !== undefined) row.epic = epic;
  const since = str(o.since);
  if (since !== undefined) row.since = since;
  const w = obj(o.wait);
  const code = str(w?.code);
  if (w && code !== undefined) {
    const wait: BoardWait = { code, text: str(w.text) ?? '' };
    for (const k of ['busy', 'total', 'max', 'position'] as const) {
      const v = num(w[k]);
      if (v !== undefined) wait[k] = v;
    }
    const reason = parseReason(obj(w.reason));
    if (reason !== undefined) wait.reason = reason;
    row.wait = wait;
  }
  return row;
}

export function parseState(text: string): BoardRead {
  try {
    const root = obj(sanitize(JSON.parse(text)));
    if (!root) return { kind: 'unreadable' };
    return { kind: 'ok', state: toState(root) };
  } catch {
    return { kind: 'unreadable' };
  }
}

// ---------- displayed text ----------

/** A forOwner line in words: its code in this language, else its English title. */
function ownerText(f: { title: string; code?: string; params?: Params }, t: Strings): string {
  return f.code === undefined
    ? f.title
    : (t.reason({ code: f.code, ...(f.params === undefined ? {} : { params: f.params }) }) ??
        f.title);
}

/** What a wait is held by, in words: its reason's code in this language, else the English text. */
function whyOf(w: BoardWait, t: Strings): string {
  return w.reason === undefined ? w.text : (t.reason(w.reason) ?? w.text);
}

// ---------- status line and alerts ----------

export function statusLine(state: BoardState, paused: boolean, lang?: Lang): string {
  const t = stringsFor(lang);
  const working = state.crew.filter((c) => c.state === 'working').length;
  const waiting = state.crew.filter((c) => c.state === 'waiting').length;
  const ci = `${state.ci.ok ? state.ci.busy : '?'}/${state.ci.total}`;
  const base = t.status(working, waiting, state.counts.queued, ci, state.forOwner.length);
  return paused ? `${base} · ${t.statusPaused}` : base;
}

export function alertsFor(state: BoardState, lang?: Lang): { key: string; text: string }[] {
  const t = stringsFor(lang);
  const out: { key: string; text: string }[] = [];
  for (const f of state.forOwner) {
    if (f.id === 'account-block') continue;
    // The usage-limit title carries a time that changes; key it by id so it toasts once while it stands.
    const key = f.id === 'usage-limit' ? 'owner:usage-limit' : `owner:${f.id}:${f.title}`;
    out.push({ key, text: t.forYou(ownerText(f, t)) });
  }
  for (const n of state.notifications) {
    out.push({
      key: `block:${n.label}:${n.reason}`,
      text: t.accountBlocked(n.label, t.blockReason(n.reason)),
    });
  }
  if (state.mainBuild.status === 'red') {
    const sha = state.mainBuild.sha ?? '';
    out.push({ key: `main-red:${sha}`, text: t.mainRed(sha.slice(0, 7)) });
  }
  for (const c of state.crew) {
    if (c.state === 'crashed') {
      out.push({ key: `crash:${c.item}:${c.since ?? ''}`, text: t.crashed(c.role, c.item) });
    }
  }
  return out;
}

const MAX_TOASTS = 5;

export function newAlerts(
  seen: readonly string[],
  state: BoardState,
  lang?: Lang,
): { toasts: string[]; seen: string[] } {
  const known = new Set(seen);
  const keys = new Set<string>();
  const toasts: string[] = [];
  for (const a of alertsFor(state, lang)) {
    if (keys.has(a.key)) continue;
    keys.add(a.key);
    if (!known.has(a.key)) toasts.push(a.text);
  }
  const shown = toasts.slice(0, MAX_TOASTS);
  if (toasts.length > MAX_TOASTS) shown.push(stringsFor(lang).more(toasts.length - MAX_TOASTS));
  return { toasts: shown, seen: [...keys] };
}

// ---------- helpers ----------

const LOOK: Record<CrewState, { glyph: string; tone: NonNullable<Line['tone']> }> = {
  working: { glyph: '●', tone: 'ok' },
  waiting: { glyph: '◐', tone: 'wait' },
  blocked: { glyph: '■', tone: 'err' },
  stopped: { glyph: '○', tone: 'idle' },
  crashed: { glyph: '✕', tone: 'err' },
  done: { glyph: '✓', tone: 'dim' },
};

const ZERO_WIDTH = /^(?:\p{Mn}|\p{Me}|[\u200b-\u200f]|[\ufe00-\ufe0f])$/u;
const EMOJI = /^\p{Emoji_Presentation}$/u;

/** Cells one code point takes in a terminal: East Asian wide and full-width ones and emoji take two. */
function cells(cp: number, ch: string): number {
  if (ZERO_WIDTH.test(ch)) return 0;
  if (EMOJI.test(ch)) return 2;
  return (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1;
}

/** The terminal cells `s` takes. */
export function cellWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += cells(ch.codePointAt(0) as number, ch);
  return n;
}

const width = cellWidth;

/** Cuts to `n` cells, marking the cut with an ellipsis. */
function cut(s: string, n: number): string {
  if (width(s) <= n) return s;
  if (n <= 1) return '…'.slice(0, Math.max(n, 0));
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = cells(ch.codePointAt(0) as number, ch);
    if (used + w > n - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function pad(s: string, n: number): string {
  const c = cut(s, n);
  return c + ' '.repeat(Math.max(0, n - width(c)));
}

/** Words of `text` in lines of at most `columns`; the first line starts with `first`, the rest with `indent`. */
function wrap(text: string, columns: number, indent = '', first = indent): string[] {
  return pack(
    text.split(/\s+/).filter((w) => w !== ''),
    ' ',
    columns,
    indent,
    first,
  );
}

/** `parts` joined by `sep` in lines of at most `columns`; a part is never split, only cut. */
function pack(
  parts: string[],
  sep: string,
  columns: number,
  indent = '',
  first = indent,
): string[] {
  const out: string[] = [];
  let line = '';
  for (const part of parts) {
    const next =
      line === '' ? `${out.length === 0 ? first : indent}${part}` : `${line}${sep}${part}`;
    if (line !== '' && width(next) > columns) {
      out.push(line);
      line = `${indent}${part}`;
    } else line = next;
  }
  if (line !== '') out.push(line);
  return out;
}

/** `left` and `right` on one line, `right` flush with the edge when both fit. */
function spread(left: string, right: string, columns: number): string {
  const room = columns - width(right) - 1;
  if (room < 4) return cut(left, columns);
  const l = cut(left, room);
  return `${l}${' '.repeat(columns - width(l) - width(right))}${right}`;
}

function bar(done: number, total: number, size: number): string {
  const filled = total > 0 ? Math.min(size, Math.max(0, Math.round((done / total) * size))) : 0;
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

/** A duration in the two largest units, in the language's units (English by default). */
export function formatRuntime(
  ms: number,
  units: Strings['units'] = stringsFor('en').units,
): string {
  if (!Number.isFinite(ms) || ms < 0) return units.s(0);
  const s = Math.floor(ms / 1000);
  if (s < 60) return units.s(s);
  const m = Math.floor(s / 60);
  if (m < 60) return units.m(m);
  const h = Math.floor(m / 60);
  if (h < 24) return `${units.h(h)} ${units.m(m % 60)}`;
  return `${units.d(Math.floor(h / 24))} ${units.h(h % 24)}`;
}

function runtimeOf(c: BoardCrew, nowMs: number, t: Strings): string {
  const start = c.since === undefined ? Number.NaN : Date.parse(c.since);
  if (Number.isNaN(start)) return '';
  const stop = c.stoppedAt === undefined ? Number.NaN : Date.parse(c.stoppedAt);
  return formatRuntime((Number.isNaN(stop) ? nowMs : stop) - start, t.units);
}

const clampColumns = (columns: number): number =>
  Number.isFinite(columns) ? Math.min(1000, Math.max(20, Math.floor(columns))) : 20;

const clip = (lines: Line[], columns: number): Line[] =>
  lines.map((l) => ({ ...l, text: cut(l.text, columns) }));

// ---------- the detailed view: /studio more ----------

const MAX_CREW_ROWS = 50;
const MAX_OWNER_LINES = 20;

type Group = { key: string; heading: string };

/**
 * Crew rows by component when the project has components: one group per component in config
 * order, then work on several components, then work on none. Keys of the last two are no ids.
 */
function grouped(
  rows: BoardCrew[],
  state: BoardState,
  t: Strings,
): { crew: BoardCrew; group?: Group }[] {
  const components = state.components ?? [];
  if (components.length === 0) return rows.map((crew) => ({ crew }));
  const names = new Map(components.map((c) => [c.id, c.name]));
  const order = [...components.map((c) => c.id), '#cross', '#none'];
  const groupOf = (c: BoardCrew): Group => {
    const ids = c.components ?? [];
    if (ids.length > 1) return { key: '#cross', heading: t.crossCutting };
    const name = names.get(ids[0] ?? '');
    return name === undefined
      ? { key: '#none', heading: t.noComponent }
      : { key: ids[0] as string, heading: name };
  };
  return rows
    .map((crew) => ({ crew, group: groupOf(crew) }))
    .sort((a, b) => order.indexOf(a.group.key) - order.indexOf(b.group.key));
}

const crewWord = (c: BoardCrew, t: Strings) => `${LOOK[c.state].glyph} ${t.crewState[c.state]}`;

function crewLines(state: BoardState, columns: number, nowMs: number, t: Strings): Line[] {
  const rows = state.crew.length > 10 ? state.crew.filter((c) => c.state !== 'done') : state.crew;
  if (rows.length === 0) return [{ text: t.noCrew, tone: 'dim' }];
  const out: Line[] = [];
  let shown: string | undefined;
  for (const { crew: c, group } of grouped(rows, state, t).slice(0, MAX_CREW_ROWS)) {
    if (group !== undefined && group.key !== shown) {
      out.push({ text: group.heading, tone: 'head' });
      shown = group.key;
    }
    const look = LOOK[c.state];
    const word = crewWord(c, t);
    const pr = c.pr === undefined ? '' : `#${c.pr}`;
    const runtime = runtimeOf(c, nowMs, t);
    const label = c.label ?? '';
    const itemTitle = c.title ? `${c.item} ${c.title}` : c.item;
    if (columns >= 72) {
      const w = columns - 50;
      const text = [
        pad(c.role, 10),
        pad(word, 10),
        pad(itemTitle, w),
        pad(pr, 7),
        pad(runtime, 8),
        pad(label, 10),
      ]
        .join(' ')
        .trimEnd();
      out.push({ text, tone: look.tone });
    } else {
      out.push({ text: `${word} ${c.role} ${c.item}`, tone: look.tone });
      const rest = [c.title ?? '', pr, runtime, label].filter((x) => x !== '').join(' · ');
      out.push({ text: `  ${rest}`.trimEnd(), tone: 'dim' });
    }
  }
  if (rows.length > MAX_CREW_ROWS) {
    out.push({ text: t.more(rows.length - MAX_CREW_ROWS), tone: 'dim' });
  }
  return out;
}

const MAX_EPICS = 10;

/** The stage of an epic in words, with its acceptance item; undefined while plainly open. */
function stageWord(e: BoardEpic, t: Strings): string | undefined {
  const stage = e.stage ?? e.status;
  const item = e.acceptance === undefined ? '' : ` ${e.acceptance}`;
  if (stage === 'accepting') return `${t.accepting}${item}`;
  if (stage === 'done') return t.epicDone;
  if (stage === 'reopened') return t.reopened;
  return undefined;
}

/** Each epic with merged of total, and under it the crew rows working on its items. */
function epicLines(state: BoardState, t: Strings): Line[] {
  const epics = state.epics ?? [];
  const out: Line[] = [];
  for (const e of epics.slice(0, MAX_EPICS)) {
    const word = stageWord(e, t);
    const ok = e.status === 'accepting' || e.status === 'done';
    out.push({
      text: `${e.id} ${e.title} ${e.merged}/${e.total}${word === undefined ? '' : ` · ${word}`}`,
      ...(ok ? { tone: 'ok' as const } : {}),
    });
    for (const c of state.crew.filter((c) => c.epic === e.id && c.state !== 'done')) {
      out.push({ text: `  ${crewWord(c, t)} ${c.role} ${c.item}`, tone: LOOK[c.state].tone });
    }
  }
  if (epics.length > MAX_EPICS) {
    out.push({ text: t.more(epics.length - MAX_EPICS), tone: 'dim' });
  }
  return out;
}

function queueLines(state: BoardState, t: Strings): Line[] {
  const { current, pending } = state.queue;
  const out: Line[] = [];
  if (current) {
    out.push({
      text: `${t.now}: ${current.repo}#${current.pr}${current.step ? ` · ${pick(t.queueStep, current.step as QueueStep) ?? current.step}` : ''}`,
    });
  }
  for (const p of pending.slice(0, 3)) out.push({ text: `${t.next}: ${p.repo}#${p.pr}` });
  if (pending.length > 3) out.push({ text: t.more(pending.length - 3), tone: 'dim' });
  if (!current && pending.length === 0) out.push({ text: t.queueEmpty, tone: 'dim' });
  if (state.today.merged.length > 0) {
    out.push({
      text: `${t.mergedTodayList}: ${state.today.merged.map((n) => `#${n}`).join(', ')}`,
    });
  }
  return out;
}

function ciBar(state: BoardState, size: number): string {
  const { busy, total, ok } = state.ci;
  const filled = !ok
    ? size
    : total > 0
      ? Math.min(size, Math.max(0, Math.round((busy / total) * size)))
      : 0;
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

function ciLines(state: BoardState, columns: number, t: Strings): Line[] {
  const { busy, total, mergeMaxBusy, ok } = state.ci;
  const size = Math.min(20, Math.max(4, Math.floor(columns / 6)));
  const text = `CI [${ciBar(state, size)}] ${ok ? busy : '?'}/${total}`;
  const lines: Line[] = [ok ? { text } : { text, tone: 'err' }];
  if (!ok) {
    lines.push({ text: t.ciUnreadable, tone: 'err' });
  } else {
    lines.push({
      text: t.mergeRule(mergeMaxBusy, total, busy > mergeMaxBusy),
      tone: busy > mergeMaxBusy ? 'err' : 'dim',
    });
  }
  return lines;
}

const STALE_MORE_MS = 15 * 60_000;

/** The detailed view (`/studio more`): crew, queue, CI, lines for you, the last days, usage. */
export function boardLines(
  read: BoardRead,
  o: { columns: number; nowMs: number; paused: boolean; lang?: Lang },
): Line[] {
  const t = stringsFor(o.lang);
  const columns = clampColumns(o.columns);
  if (read.kind !== 'ok') return clip(calmLines(read.kind, o.paused, t), columns);
  const s = read.state;
  const out: Line[] = [];
  const updated = s.updatedAt === undefined ? Number.NaN : Date.parse(s.updatedAt);
  if (!Number.isNaN(updated) && o.nowMs - updated > STALE_MORE_MS) {
    out.push({ text: t.lastUpdate(Math.floor((o.nowMs - updated) / 60_000)), tone: 'dim' });
  }
  out.push({ text: statusLine(s, o.paused, o.lang), tone: 'head' });
  if ((s.epics ?? []).length > 0) out.push({ text: t.headEpics, tone: 'head' }, ...epicLines(s, t));
  out.push({ text: t.headCrew, tone: 'head' }, ...crewLines(s, columns, o.nowMs, t));
  out.push({ text: t.headQueue, tone: 'head' }, ...queueLines(s, t));
  out.push(...ciLines(s, columns, t));
  if (s.mainBuild.status === 'red') {
    out.push({ text: t.mainRed(s.mainBuild.sha ? s.mainBuild.sha.slice(0, 7) : ''), tone: 'err' });
  }
  out.push({ text: t.headForYou(s.forOwner.length), tone: 'head' });
  for (const f of s.forOwner.slice(0, MAX_OWNER_LINES)) out.push({ text: `  ${ownerText(f, t)}` });
  if (s.forOwner.length > MAX_OWNER_LINES) {
    out.push({ text: `  ${t.more(s.forOwner.length - MAX_OWNER_LINES)}`, tone: 'dim' });
  }
  for (const n of s.notifications) {
    out.push({ text: `  ${t.accountBlocked(n.label, t.blockReason(n.reason))}`, tone: 'err' });
  }
  // The lead's full lines: they may hold crew text, so only this view shows them, as data.
  const lead = s.needsLead ?? [];
  if (lead.length > 0) {
    out.push({ text: t.headForLead(lead.length), tone: 'head' });
    for (const d of lead.slice(0, MAX_OWNER_LINES)) {
      out.push({ text: `  ${d.item} ${d.detail ?? d.reason}` });
    }
    if (lead.length > MAX_OWNER_LINES) {
      out.push({ text: `  ${t.more(lead.length - MAX_OWNER_LINES)}`, tone: 'dim' });
    }
  }
  // Exceptions by evidence: which guard hit was waived on which head, and who decided.
  const exceptions = s.exceptions ?? [];
  if (exceptions.length > 0) {
    out.push({ text: t.headExceptions(exceptions.length), tone: 'head' });
    for (const e of exceptions.slice(0, MAX_OWNER_LINES)) {
      out.push({
        text: `  ${e.item ?? e.pr} ${e.rule} · ${e.head.slice(0, 7)} · ${t.exceptionBy(e.by)}`,
      });
    }
  }
  // Releases: what is on its way out, what waits for an approval, and what a red check stopped.
  const releases = s.releases ?? [];
  if (releases.length > 0) {
    out.push({ text: t.headReleases(releases.length), tone: 'head' });
    for (const r of releases.slice(0, MAX_OWNER_LINES)) {
      out.push({
        text: `  ${r.id} ${r.sha.slice(0, 7)} · ${t.releaseStatus(r.status, r.pending ?? [])}`,
        ...(r.status === 'failed'
          ? { tone: 'err' as const }
          : r.status === 'approvals'
            ? { tone: 'you' as const }
            : {}),
      });
    }
  }
  const median = s.medianLeadTimeHours === null ? '–' : t.hours(s.medianLeadTimeHours);
  out.push({ text: t.leadTimeLine(median, s.today.deployed) });
  const days = s.perDay.slice(-7);
  if (days.length > 0) {
    out.push({ text: t.headDays, tone: 'head' });
    for (const d of days) out.push({ text: `  ${d.day} ${d.merged}/${d.deployed}` });
  }
  const usage = s.usageDays.slice(-7);
  if (usage.length > 0) {
    out.push({ text: t.headUsage, tone: 'head' });
    for (const d of usage) {
      out.push({
        text: `  ${d.day} ${d.labels.map((l) => `${l.label} ${l.runs}`).join(' · ')}`.trimEnd(),
      });
    }
  }
  return clip(out, columns);
}

function calmLines(kind: 'missing' | 'unreadable', paused: boolean, t: Strings): Line[] {
  const text = kind === 'missing' ? t.missing : t.unreadable;
  return [{ text, tone: 'dim' }, ...(paused ? [{ text: t.paused, tone: 'dim' as const }] : [])];
}

export function statusText(read: BoardRead, paused: boolean, lang?: Lang): string {
  const t = stringsFor(lang);
  if (read.kind !== 'ok') {
    const text = read.kind === 'missing' ? t.missing : t.unreadable;
    return paused ? `${text} ${t.paused}` : text;
  }
  return statusLine(read.state, paused, lang);
}

// ---------- the work list and the pipeline ----------

const STALE_MS = 10 * 60_000;
/** Five columns of at least this many cells, and the gaps between them. */
const MIN_CARD = 10;
const MAX_CARDS = 4;
const MAX_TODAY = 6;
const MAX_ROWS = 30;
const LIST_MAX = 72;

const GLYPH: Record<RowState, string> = {
  decision: '!',
  blocked: '■',
  running: '●',
  waiting: '◷',
  ready: '○',
};
const TONE_OF: Record<RowState, NonNullable<Line['tone']>> = {
  decision: 'err',
  blocked: 'err',
  running: 'run',
  waiting: 'wait',
  ready: 'idle',
};
const RANK: Record<RowState, number> = {
  decision: 0,
  blocked: 0,
  running: 1,
  waiting: 2,
  ready: 3,
};

const ITEM_ID = /^[A-Z]+-\d+$/;

/**
 * A hint starts with `→` two cells in, and only a hint does: wrapped decision text goes on four
 * cells in, a wrapped hint six, so no text can pass for a hint by its look.
 */
const HINT_INDENT = '  ';
const TEXT_INDENT = '    ';

/** A pressable line: the text is what a surface without buttons shows. */
const buttonLine = (b: { key: string; label: string }): Line => ({
  text: `${HINT_INDENT}[ ${b.label} ]`,
  tone: 'you',
  button: b,
});

function hintLines(next: string, columns: number): Line[] {
  return wrap(next.replace(/^→\s*/, ''), columns, '      ', `${HINT_INDENT}→ `).map((text) => ({
    text,
    tone: 'dim',
  }));
}

interface Decision {
  /** Shown before the reason when it is an item id. */
  id?: string;
  text: string;
  next?: string;
  /** A control in place of the hint: the REA install confirmation. */
  button?: { key: string; label: string };
}

/** The lead's decisions, then the lines for the owner and a red main build. One per key. */
function decisionsOf(s: BoardState, t: Strings): Decision[] {
  const out: Decision[] = [];
  const keys = new Set<string>();
  for (const d of s.needsLead ?? []) {
    if (keys.has(d.item)) continue;
    keys.add(d.item);
    const id = ITEM_ID.test(d.item) ? d.item : undefined;
    if (d.code === 'rea_install' && s.reaInstall !== undefined) {
      // The owner's one confirmation is a press in this pane, never a phrase the lead could say.
      out.push({
        ...(id === undefined ? {} : { id }),
        text: t.decision(d.code),
        button: {
          key: REA_CONFIRM_KEY,
          label: t.reaConfirm(s.reaInstall.version, s.reaInstall.needsFolder),
        },
      });
      continue;
    }
    out.push({
      ...(id === undefined ? {} : { id }),
      text: t.decision(d.code),
      ...(d.next?.say !== undefined
        ? { next: t.say(d.next.say) }
        : id === undefined
          ? {}
          : { next: t.say(`show ${id}`) }),
    });
  }
  for (const f of s.forOwner) {
    if (keys.has(f.id)) continue;
    keys.add(f.id);
    const id = ITEM_ID.test(f.id) ? f.id : undefined;
    out.push({
      ...(id === undefined ? {} : { id }),
      text: ownerText(f, t),
      next: id === undefined ? '→ /studio more' : t.say(`show ${id}`),
    });
  }
  if (s.mainBuild.status === 'red') {
    out.push({
      text: t.mainRed(s.mainBuild.sha ? s.mainBuild.sha.slice(0, 7) : ''),
      next: '→ /studio more',
    });
  }
  return out;
}

function rowStateOf(item: BoardItem, decided: Set<string>): RowState {
  if (decided.has(item.id)) return 'decision';
  if (item.stage === 'blocked') return 'blocked';
  if (item.stage === 'pr_held' || item.stage === 'queued') return 'waiting';
  if (item.stage === 'review' && item.wait !== undefined) return 'waiting';
  if (item.stage === 'building' || item.stage === 'review') return 'running';
  return 'ready';
}

function since(item: BoardItem, nowMs: number, t: Strings): string {
  const at = item.since === undefined ? Number.NaN : Date.parse(item.since);
  return Number.isNaN(at) ? '' : formatRuntime(nowMs - at, t.units);
}

interface Row {
  item: BoardItem;
  state: RowState;
  word: string;
  time: string;
}

/** The word a row shows: running rows name their stage, all others their state. */
function wordOf(item: BoardItem, state: RowState, t: Strings): string {
  return state === 'running' ? t.stage[item.stage] : t.word[state];
}

/**
 * One item line: glyph, id, title, word, time. The title gives way first, then the time, then
 * the indent; the glyph, the id and the word are never cut.
 */
function itemLine(r: Row, columns: number, wordW: number, timeW: number): string {
  const glyph = GLYPH[r.state];
  for (const [indent, withTime] of [
    ['  ', true],
    ['  ', false],
    ['', false],
  ] as const) {
    const head = `${indent}${glyph} ${r.item.id} `;
    const tail = ` ${r.word.padEnd(wordW)}${withTime && timeW > 0 ? ` ${r.time.padStart(timeW)}` : ''}`;
    const room = columns - width(head) - width(tail);
    if (room >= 4 || (room >= 0 && r.item.title === '')) {
      return `${head}${pad(r.item.title, Math.max(0, room))}${tail}`.trimEnd();
    }
    if (!withTime && indent === '') return `${glyph} ${r.item.id} ${r.word}`;
  }
  return `${glyph} ${r.item.id} ${r.word}`;
}

function headerLines(s: BoardState | undefined, right: string, columns: number): Line[] {
  const name = s?.project === undefined || s.project === '' ? 'Studio' : `Studio · ${s.project}`;
  return [{ text: right === '' ? name : spread(name, right, columns), tone: 'head' }];
}

function footerLines(s: BoardState, t: Strings, columns: number): Line[] {
  const ci = `CI ${ciBar(s, 8)} ${s.ci.ok ? s.ci.busy : '?'}/${s.ci.total}`;
  const parts = [ci];
  if (s.medianLeadTimeHours !== null) parts.push(t.leadTime(t.hours(s.medianLeadTimeHours)));
  const cost = s.today.costUsd;
  if (cost !== undefined && cost > 0) parts.push(t.costToday(t.money(cost)));
  parts.push('/studio more');
  return pack(parts, ' · ', columns).map((text) => ({ text, tone: 'dim' }));
}

const epicCode = (epic: string | undefined): string =>
  epic === undefined ? '' : epic.replace('-', '');

interface Frame {
  t: Strings;
  s: BoardState;
  columns: number;
  nowMs: number;
  paused: boolean;
  staleMin: number | undefined;
}

function banners(f: Frame): Line[] {
  const out: Line[] = [];
  if (f.paused) {
    for (const text of wrap(f.t.pausedSince(f.s.pause?.time), f.columns))
      out.push({ text, tone: 'wait' });
    out.push({ text: '→ /studio resume', tone: 'dim' });
  }
  if (f.staleMin !== undefined) {
    for (const text of wrap(`${f.t.staleBanner(f.staleMin)} ${f.t.staleQuestion}`, f.columns)) {
      out.push({ text, tone: 'err' });
    }
    out.push(
      ...wrap(f.t.say(f.t.staleSay), f.columns, '  ').map((text) => ({
        text: text.trimStart(),
        tone: 'dim' as const,
      })),
    );
  }
  return out;
}

function rightTag(f: Frame): string {
  if (f.staleMin !== undefined) return f.t.stale;
  if (f.paused) return f.t.pausedTag;
  const updated = f.s.updatedAt === undefined ? Number.NaN : Date.parse(f.s.updatedAt);
  return Number.isNaN(updated)
    ? ''
    : f.t.updated(Math.max(0, Math.floor((f.nowMs - updated) / 60_000)));
}

function emptyLines(f: Frame): Line[] {
  return [
    { text: f.t.emptyTitle, tone: 'dim' },
    { text: '' },
    ...wrap(f.t.emptyHint, f.columns).map((text) => ({ text })),
    ...wrap(f.t.emptyExample, f.columns).map((text) => ({ text, tone: 'dim' as const })),
  ];
}

function rowsOf(items: BoardItem[], decided: Set<string>, f: Frame): Row[] {
  return items
    .map((item) => {
      const state = rowStateOf(item, decided);
      return {
        item,
        state,
        word: wordOf(item, state, f.t),
        time: state === 'ready' ? '' : since(item, f.nowMs, f.t),
      };
    })
    .sort((a, b) => RANK[a.state] - RANK[b.state]);
}

function listBody(f: Frame, decisions: Decision[], items: BoardItem[]): Line[] {
  const { t, s, columns } = f;
  const out: Line[] = [];
  const decided = new Set(decisions.flatMap((d) => (d.id === undefined ? [] : [d.id])));
  const rows = rowsOf(items, decided, f);
  const count = (st: RowState) => rows.filter((r) => r.state === st).length;
  const merged = s.today.merged.length;
  const summary = [
    decisions.length > 0 ? t.decisions(decisions.length) : '',
    count('running') > 0 ? t.running(count('running')) : '',
    count('waiting') > 0 ? t.waiting(count('waiting')) : '',
    merged > 0 ? t.today(merged) : '',
  ].filter((x) => x !== '');
  for (const text of pack(summary, '  ', columns)) out.push({ text });
  if (decisions.length > 0) {
    out.push({ text: '' }, { text: pad(t.decisionHead, columns), tone: 'you' });
    for (const d of decisions.slice(0, MAX_OWNER_LINES)) {
      const head = d.id === undefined ? '! ' : `! ${d.id} `;
      for (const text of wrap(`${head}${d.text}`, columns, TEXT_INDENT, ''))
        out.push({ text, tone: 'err' });
      if (d.button !== undefined) out.push(buttonLine(d.button));
      else if (d.next !== undefined) out.push(...hintLines(d.next, columns));
    }
    if (decisions.length > MAX_OWNER_LINES) {
      out.push({ text: t.more(decisions.length - MAX_OWNER_LINES), tone: 'dim' });
    }
  }
  const wordW = Math.max(0, ...rows.map((r) => width(r.word)));
  const timeW = Math.max(0, ...rows.map((r) => width(r.time)));
  const section = (heading: Line, part: Row[], done: string | undefined) => {
    if (part.length === 0 && done === undefined) return;
    out.push({ text: '' }, heading);
    for (const r of part.slice(0, MAX_ROWS)) {
      out.push({ text: itemLine(r, columns, wordW, timeW), tone: TONE_OF[r.state] });
      if (r.state === 'waiting' && r.item.wait !== undefined) {
        const reason = `${t.stage[r.item.stage]}: ${t.wait(r.item.wait, whyOf(r.item.wait, t))}`;
        for (const text of wrap(reason, columns, '    ')) out.push({ text, tone: 'dim' });
      }
    }
    if (part.length > MAX_ROWS)
      out.push({ text: `  ${t.more(part.length - MAX_ROWS)}`, tone: 'dim' });
    if (done !== undefined) out.push({ text: `  ${done}`, tone: 'dim' });
  };
  const epics = (s.epics ?? []).filter((e) => e.total > 0);
  const known = new Set(epics.map((e) => e.id));
  for (const e of epics) {
    const word = stageWord(e, t);
    const right = `${word === undefined ? '' : `${word} `}${bar(e.merged, e.total, 5)} ${e.merged}/${e.total}`;
    section(
      { text: spread(`${e.id} ${e.title}`, right, columns), tone: 'head' },
      rows.filter((r) => r.item.epic === e.id),
      e.merged > 0 ? t.done(e.merged) : undefined,
    );
  }
  const loose = rows.filter((r) => r.item.epic === undefined || !known.has(r.item.epic));
  const looseDone = (s.mergedToday ?? []).filter(
    (m) => m.epic === undefined || !known.has(m.epic),
  ).length;
  section(
    { text: t.withoutEpic, tone: 'head' },
    loose,
    looseDone > 0 ? t.doneToday(looseDone) : undefined,
  );
  out.push({ text: '' }, ...footerLines(s, t, columns));
  return out;
}

type Column = { header: string; full: boolean; lines: string[] };

function card(r: Row, w: number, f: Frame): string[] {
  const extra = [epicCode(r.item.epic), r.time].filter((x) => x !== '').join(' ');
  const lines = [`${GLYPH[r.state]} ${r.item.id}`, `  ${cut(r.item.title, w - 2)}`];
  if (extra !== '') lines.push(`  ${extra}`);
  if (r.state === 'waiting' && r.item.wait !== undefined)
    lines.push(`  ${f.t.waitShort(r.item.wait)}`);
  return lines;
}

function pipelineBody(f: Frame, decisions: Decision[], items: BoardItem[]): Line[] | undefined {
  const { t, s, columns } = f;
  const decided = new Set(decisions.flatMap((d) => (d.id === undefined ? [] : [d.id])));
  const rows = rowsOf(items, decided, f);
  const of = (...stages: Stage[]) => rows.filter((r) => stages.includes(r.item.stage));
  const wip = s.wip ?? { building: 0, review: 0 };
  const limit = (name: string, n: number, max: number) =>
    max > 0 ? `${name} ${n}/${max}` : `${name} ${n}`;
  const building = of('building', 'pr_held');
  const review = of('review');
  const todayIds =
    s.mergedToday !== undefined
      ? s.mergedToday.map((m) => m.item ?? `#${m.pr}`)
      : s.today.merged.map((pr) => `#${pr}`);
  const cols: { header: string; full: boolean; rows?: Row[]; today?: string[] }[] = [
    { header: `${t.column.ready} ${of('ready').length}`, full: false, rows: of('ready') },
    {
      header: limit(t.column.building, building.length, wip.building),
      full: wip.building > 0 && building.length >= wip.building,
      rows: building,
    },
    {
      header: limit(t.column.review, review.length, wip.review),
      full: wip.review > 0 && review.length >= wip.review,
      rows: review,
    },
    { header: `${t.column.queue} ${of('queued').length}`, full: false, rows: of('queued') },
    { header: `${t.column.today} ✓${todayIds.length}`, full: false, today: todayIds },
  ];
  const w = Math.max(MIN_CARD, ...cols.map((c) => width(c.header)), width(t.full));
  const gap = 2;
  if (5 * w + 4 * gap > columns) return undefined;
  const colW = Math.floor((columns - 4 * gap) / 5);
  // A card's sign and id are never cut: an id too long for its column means the work list.
  const longest = Math.max(
    0,
    ...rows.map((r) => 2 + width(r.item.id)),
    ...todayIds.map((id) => 2 + width(id)),
  );
  if (longest > colW) return undefined;
  const built: Column[] = cols.map((c) => {
    const lines: string[] = [];
    if (c.rows !== undefined) {
      for (const r of c.rows.slice(0, MAX_CARDS)) lines.push(...card(r, colW, f));
      if (c.rows.length > MAX_CARDS) lines.push(`+${c.rows.length - MAX_CARDS}`);
    }
    if (c.today !== undefined) {
      for (const id of c.today.slice(-MAX_TODAY)) lines.push(`✓ ${id}`);
      if (c.today.length > MAX_TODAY) lines.push(`+${c.today.length - MAX_TODAY}`);
    }
    return { header: c.header, full: c.full, lines };
  });
  const join = (cells: string[]) =>
    cells
      .map((c) => pad(c, colW))
      .join(' '.repeat(gap))
      .trimEnd();
  const out: Line[] = [];
  if (decisions.length > 0) {
    const d = decisions[0] as Decision;
    const more = decisions.length > 1 ? ` (+${decisions.length - 1})` : '';
    const head = `! ${d.id === undefined ? '' : `${d.id} `}${d.text}${more}`;
    for (const text of wrap(head, columns, TEXT_INDENT, '')) out.push({ text, tone: 'you' });
    if (d.button !== undefined) out.push(buttonLine(d.button));
    else if (d.next !== undefined) out.push(...hintLines(d.next, columns));
  }
  out.push({ text: '' });
  out.push({ text: join(built.map((c) => c.header)), tone: 'head' });
  out.push({
    text: join(built.map((c) => (c.full ? t.full : '─'.repeat(colW)))),
    tone: 'dim',
  });
  const height = Math.max(0, ...built.map((c) => c.lines.length));
  for (let i = 0; i < height; i++) out.push({ text: join(built.map((c) => c.lines[i] ?? '')) });
  const blocked = of('blocked');
  if (blocked.length > 0) {
    out.push({ text: '' }, { text: `■ ${t.blocked} ${blocked.length}`, tone: 'err' });
    for (const r of blocked.slice(0, MAX_ROWS)) {
      const reason = decisions.find((d) => d.id === r.item.id)?.text ?? t.word.blocked;
      const code = epicCode(r.item.epic);
      const text = `${r.item.id} ${reason}${code === '' ? '' : ` (${code})`}`;
      for (const l of wrap(text, columns, '    ', '  ')) out.push({ text: l, tone: 'err' });
    }
  }
  out.push({ text: '' }, ...footerLines(s, t, columns));
  return out;
}

/**
 * The pane: the work list (default), the pipeline (the list again when five columns do not fit)
 * or the detailed view. A state from before the work list draws the detailed view.
 */
export function paneLines(
  read: BoardRead,
  o: {
    columns: number;
    nowMs: number;
    paused: boolean;
    view?: View;
    lang?: Lang;
    /** Another project of the group is shown: its group's name, for the way back. */
    focusOf?: string;
  },
): Line[] {
  const t = stringsFor(o.lang);
  const columns = clampColumns(o.columns);
  if (o.focusOf !== undefined) {
    const inner = paneLines(read, {
      ...o,
      focusOf: undefined,
      view: o.view === 'group' ? 'list' : o.view,
    });
    return clip([{ text: t.groupBack(o.focusOf), tone: 'dim' }, ...inner], columns);
  }
  if (o.view === 'group' && read.kind === 'ok') {
    return clip(groupLines(read.state, t, Math.min(columns, LIST_MAX), o.nowMs), columns);
  }
  if (read.kind !== 'ok') {
    return calmLines(read.kind, o.paused, t).flatMap((l) =>
      wrap(l.text, columns).map((text) => ({ ...l, text: cut(text, columns) })),
    );
  }
  const s = read.state;
  if (o.view === 'more' || s.items === undefined) return boardLines(read, { ...o, columns });
  const updated = s.updatedAt === undefined ? Number.NaN : Date.parse(s.updatedAt);
  const age = Number.isNaN(updated) ? 0 : o.nowMs - updated;
  const f: Frame = {
    t,
    s,
    columns,
    nowMs: o.nowMs,
    paused: o.paused || s.pause !== undefined,
    staleMin: age > STALE_MS ? Math.floor(age / 60_000) : undefined,
  };
  const decisions = decisionsOf(s, t);
  const items = s.items;
  const body = o.view === 'pipeline' ? pipelineBody(f, decisions, items) : undefined;
  // The work list reads best at most 72 cells wide; the pipeline takes the whole pane.
  const lf: Frame = body === undefined ? { ...f, columns: Math.min(columns, LIST_MAX) } : f;
  const notes = banners(lf);
  const out: Line[] = [
    ...headerLines(s, rightTag(lf), lf.columns),
    ...notes,
    ...(notes.length > 0 ? [{ text: '' }] : []),
  ];
  if (items.length === 0 && decisions.length === 0 && s.today.merged.length === 0) {
    out.push(...emptyLines(lf));
  } else out.push(...(body ?? listBody(lf, decisions, items)));
  return clip(out, columns);
}

/** The counts of a project's line: only signs that are not zero, each with its number. */
function groupCounts(r: BoardGroupRow, t: Strings): string {
  if (r.counts === undefined) return t.groupProblem(r.problem ?? '');
  const c = r.counts;
  const parts = [
    c.decisions > 0 ? `! ${c.decisions}` : '',
    c.running > 0 ? `● ${c.running}` : '',
    c.waiting > 0 ? `◷ ${c.waiting}` : '',
    c.blocked > 0 ? `■ ${c.blocked}` : '',
    c.ready > 0 ? `○ ${c.ready}` : '',
  ].filter((x) => x !== '');
  return parts.length === 0 ? `✓ ${t.groupIdle}` : parts.join('  ');
}

/**
 * The group view: one line per project (its id, `main` and `here` as words, its counts by sign),
 * then every lead decision of every project in one block, each with the command that opens that
 * project's work list. Narrow panes put the counts on a second line, never cutting an id.
 */
export function groupLines(s: BoardState, t: Strings, columns: number, nowMs: number): Line[] {
  const g = s.group;
  if (g === undefined) {
    return [
      { text: 'Studio', tone: 'head' },
      ...wrap(t.groupNone, columns).map((text) => ({ text, tone: 'dim' as const })),
    ];
  }
  const updated = s.updatedAt === undefined ? Number.NaN : Date.parse(s.updatedAt);
  const right = Number.isNaN(updated)
    ? ''
    : t.updated(Math.max(0, Math.floor((nowMs - updated) / 60_000)));
  const out: Line[] = [
    {
      text: right === '' ? t.groupTitle(g.name) : spread(t.groupTitle(g.name), right, columns),
      tone: 'head',
    },
  ];
  const decisions = g.projects.flatMap((p) => p.decisions.map((d) => ({ project: p.id, ...d })));
  if (decisions.length > 0) {
    out.push({ text: t.decisions(decisions.length) });
    out.push({ text: '' }, { text: pad(t.decisionHead, columns), tone: 'you' });
    for (const d of decisions.slice(0, MAX_OWNER_LINES)) {
      for (const text of wrap(
        `! ${d.project} · ${d.item} ${t.decision(d.code)}`,
        columns,
        TEXT_INDENT,
        '',
      )) {
        out.push({ text, tone: 'err' });
      }
      out.push(...hintLines(`/studio group ${d.project}`, columns));
    }
    if (decisions.length > MAX_OWNER_LINES) {
      out.push({ text: t.more(decisions.length - MAX_OWNER_LINES), tone: 'dim' });
    }
  }
  out.push({ text: '' });
  for (const p of g.projects) {
    const tags = [p.main ? t.groupMain : '', p.self ? t.groupHere : ''].filter((x) => x !== '');
    const left = `${p.id}${tags.length === 0 ? '' : ` (${tags.join(', ')})`}`;
    const right = groupCounts(p, t);
    const tone: Line['tone'] =
      p.counts === undefined
        ? 'dim'
        : p.counts.decisions > 0 || p.counts.blocked > 0
          ? 'err'
          : undefined;
    if (width(left) + 2 + width(right) <= columns) {
      out.push({ text: spread(left, right, columns), ...(tone === undefined ? {} : { tone }) });
    } else {
      out.push({ text: cut(left, columns), ...(tone === undefined ? {} : { tone }) });
      for (const text of wrap(right, columns, TEXT_INDENT, TEXT_INDENT))
        out.push({ text, tone: 'dim' });
    }
  }
  out.push({ text: '' }, ...hintLines(t.groupOpen, columns));
  return out;
}

// ---------- state directory name (same result as src/paths.ts) ----------

export function stateDirName(realPath: string, sha256Hex: string): string {
  const hash = sha256Hex.slice(0, 16);
  const parts = realPath.split('/').filter((p) => p !== '');
  const suffix = (parts[parts.length - 1] ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32);
  return suffix ? `${hash}-${suffix}` : hash;
}

// ---------- the owner config's pane switch (same meaning as src/config.ts) ----------

export type NestedWorktrees = 'show' | 'hide';

/**
 * `pane.nested_worktrees` of the owner config (`show`, the default, or `hide`), read without a
 * YAML library: the block form (`pane:` with an indented `nested_worktrees: hide`) and the flow
 * form (`pane: { nested_worktrees: hide }`), comments and quotes allowed. Anything else, a file
 * that cannot be read included, is `show`: the switch only ever hides.
 */
export function nestedWorktreesOf(text: string): NestedWorktrees {
  const value = (raw: string | undefined): NestedWorktrees =>
    raw?.replace(/^["']|["']$/g, '') === 'hide' ? 'hide' : 'show';
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, '').replace(/^#.*$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const flow = /^pane:\s*\{(.*)\}\s*$/.exec(line);
    if (flow) {
      const m = /(?:^|,)\s*["']?nested_worktrees["']?\s*:\s*([^,\s}]+)/.exec(flow[1] as string);
      return value(m?.[1]);
    }
    if (!/^pane:\s*$/.test(line)) continue;
    for (const inner of lines.slice(i + 1)) {
      if (inner.trim() === '') continue;
      if (!/^\s/.test(inner)) break;
      const m = /^\s+["']?nested_worktrees["']?\s*:\s*(\S+)\s*$/.exec(inner);
      if (m) return value(m[1]);
    }
    return 'show';
  }
  return 'show';
}
