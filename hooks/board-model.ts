// Pure board model for the Studio pane. No imports on purpose: no Node, no engine code.
// It reads the snapshot that `studio state` writes (StateSnapshot in src/state.ts) leniently.

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
}

export interface BoardState {
  crew: BoardCrew[];
  queue: {
    current?: { pr: number; repo: string; step: string; item?: string };
    pending: { pr: number; repo: string; item?: string }[];
  };
  ci: { busy: number; total: number; mergeMaxBusy: number; ok: boolean };
  today: { merged: number[]; deployed: number };
  /** Ascending by day. */
  usageDays: { day: string; labels: { label: string; runs: number }[] }[];
  mainBuild: { status: string; sha?: string };
  counts: { ready: number; queued: number };
  forOwner: { id: string; title: string }[];
  notifications: { label: string; reason: string; title: string }[];
  /** Ascending by day. */
  perDay: { day: string; merged: number; deployed: number }[];
  medianLeadTimeHours: number | null;
  updatedAt?: string;
}

export type BoardRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; state: BoardState };

export type Line = { text: string; tone?: 'ok' | 'wait' | 'idle' | 'err' | 'dim' | 'head' };

const MAX_STRING = 200;
const STALE_MS = 15 * 60_000;
const MISSING_TEXT = 'No board yet. The control room writes it with studio state.';
const UNREADABLE_TEXT = 'The board cannot be read just now. It refreshes by itself.';
const STATES: readonly CrewState[] = [
  'working',
  'waiting',
  'blocked',
  'stopped',
  'crashed',
  'done',
];

// ---------- parsing ----------

/** Strips control characters and caps at 200 code points. */
function clean(s: string): string {
  const stripped = s.replace(/\p{Cc}/gu, '');
  const cps = [...stripped];
  return cps.length > MAX_STRING ? cps.slice(0, MAX_STRING).join('') : stripped;
}

/** Cleans every string (and object key) of a parsed JSON value. */
function sanitize(v: unknown): unknown {
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return v.map(sanitize);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), sanitize(x)]));
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
      return id === undefined || title === undefined ? [] : [{ id, title }];
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
  return state;
}

export function parseState(text: string): BoardRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'unreadable' };
  }
  const root = obj(sanitize(raw));
  if (!root) return { kind: 'unreadable' };
  return { kind: 'ok', state: toState(root) };
}

// ---------- status line and alerts ----------

export function statusLine(state: BoardState, paused: boolean): string {
  const working = state.crew.filter((c) => c.state === 'working').length;
  const waiting = state.crew.filter((c) => c.state === 'waiting').length;
  const ci = `${state.ci.ok ? state.ci.busy : '?'}/${state.ci.total}`;
  const base = `● ${working} working · ${waiting} waiting · ${state.counts.queued} queued · CI ${ci} · for you: ${state.forOwner.length}`;
  return paused ? `${base} · paused` : base;
}

export function alertsFor(state: BoardState): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const f of state.forOwner) {
    if (f.id === 'account-block') continue;
    out.push({ key: `owner:${f.id}:${f.title}`, text: `For you: ${f.title}` });
  }
  for (const n of state.notifications) {
    out.push({
      key: `block:${n.label}:${n.reason}`,
      text: `Account blocked${n.label ? ` (${n.label})` : ''}: ${n.reason}`,
    });
  }
  if (state.mainBuild.status === 'red') {
    const sha = state.mainBuild.sha ?? '';
    out.push({
      key: `main-red:${sha}`,
      text: `Main build is red${sha ? ` (${sha.slice(0, 7)})` : ''}`,
    });
  }
  for (const c of state.crew) {
    if (c.state === 'crashed') {
      out.push({
        key: `crash:${c.item}:${c.since ?? ''}`,
        text: `Crashed: ${c.role} on ${c.item}`,
      });
    }
  }
  return out;
}

export function newAlerts(
  seen: readonly string[],
  state: BoardState,
): { toasts: string[]; seen: string[] } {
  const known = new Set(seen);
  const keys = new Set<string>();
  const toasts: string[] = [];
  for (const a of alertsFor(state)) {
    if (keys.has(a.key)) continue;
    keys.add(a.key);
    if (!known.has(a.key)) toasts.push(a.text);
  }
  return { toasts, seen: [...keys] };
}

// ---------- layout ----------

const LOOK: Record<CrewState, { word: string; tone: NonNullable<Line['tone']> }> = {
  working: { word: '● working', tone: 'ok' },
  waiting: { word: '◐ waiting', tone: 'wait' },
  blocked: { word: '■ blocked', tone: 'err' },
  stopped: { word: '○ stopped', tone: 'idle' },
  crashed: { word: '✕ crashed', tone: 'err' },
  done: { word: '✓ done', tone: 'dim' },
};

/** Cuts to `n` code points, marking the cut with an ellipsis. */
function cut(s: string, n: number): string {
  const cps = [...s];
  if (cps.length <= n) return s;
  return n <= 1 ? '…'.slice(0, Math.max(n, 0)) : `${cps.slice(0, n - 1).join('')}…`;
}

function pad(s: string, n: number): string {
  const c = cut(s, n);
  return c + ' '.repeat(Math.max(0, n - [...c].length));
}

export function formatRuntime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function runtimeOf(c: BoardCrew, nowMs: number): string {
  const start = c.since === undefined ? Number.NaN : Date.parse(c.since);
  if (Number.isNaN(start)) return '';
  const stop = c.stoppedAt === undefined ? Number.NaN : Date.parse(c.stoppedAt);
  return formatRuntime((Number.isNaN(stop) ? nowMs : stop) - start);
}

function crewLines(state: BoardState, columns: number, nowMs: number): Line[] {
  const rows = state.crew.length > 10 ? state.crew.filter((c) => c.state !== 'done') : state.crew;
  if (rows.length === 0) return [{ text: 'No crew running.', tone: 'dim' }];
  const out: Line[] = [];
  for (const c of rows) {
    const look = LOOK[c.state];
    const pr = c.pr === undefined ? '' : `#${c.pr}`;
    const runtime = runtimeOf(c, nowMs);
    const label = c.label ?? '';
    const itemTitle = c.title ? `${c.item} ${c.title}` : c.item;
    if (columns >= 72) {
      const w = columns - 50;
      const text = [
        pad(c.role, 10),
        pad(look.word, 10),
        pad(itemTitle, w),
        pad(pr, 7),
        pad(runtime, 8),
        pad(label, 10),
      ]
        .join(' ')
        .trimEnd();
      out.push({ text, tone: look.tone });
    } else {
      out.push({ text: `${look.word} ${c.role} ${c.item}`, tone: look.tone });
      const rest = [c.title ?? '', pr, runtime, label].filter((x) => x !== '').join(' · ');
      out.push({ text: `  ${rest}`.trimEnd(), tone: 'dim' });
    }
  }
  return out;
}

function queueLines(state: BoardState): Line[] {
  const { current, pending } = state.queue;
  const out: Line[] = [];
  if (current) {
    out.push({
      text: `now: ${current.repo}#${current.pr}${current.step ? ` · ${current.step}` : ''}`,
    });
  }
  for (const p of pending.slice(0, 3)) out.push({ text: `next: ${p.repo}#${p.pr}` });
  if (pending.length > 3) out.push({ text: `… ${pending.length - 3} more`, tone: 'dim' });
  if (!current && pending.length === 0) out.push({ text: 'Queue is empty.', tone: 'dim' });
  if (state.today.merged.length > 0) {
    out.push({ text: `Merged today: ${state.today.merged.map((n) => `#${n}`).join(', ')}` });
  }
  return out;
}

function ciLines(state: BoardState, columns: number): Line[] {
  const { busy, total, mergeMaxBusy, ok } = state.ci;
  const width = Math.min(20, Math.max(4, Math.floor(columns / 6)));
  const filled = !ok
    ? width
    : total > 0
      ? Math.min(width, Math.max(0, Math.round((busy / total) * width)))
      : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const text = `CI [${bar}] ${ok ? busy : '?'}/${total}`;
  const lines: Line[] = [ok ? { text } : { text, tone: 'err' }];
  if (!ok) {
    lines.push({ text: 'CI unreadable, counted as busy', tone: 'err' });
  } else {
    lines.push({
      text: `merge rule: at most ${mergeMaxBusy}/${total} busy${busy > mergeMaxBusy ? ', now over' : ''}`,
      tone: busy > mergeMaxBusy ? 'err' : 'dim',
    });
  }
  return lines;
}

export function boardLines(
  read: BoardRead,
  o: { columns: number; nowMs: number; paused: boolean },
): Line[] {
  const columns = Math.max(20, Math.floor(o.columns) || 20);
  const clip = (lines: Line[]): Line[] => lines.map((l) => ({ ...l, text: cut(l.text, columns) }));
  if (read.kind === 'missing') return clip([{ text: MISSING_TEXT, tone: 'dim' }]);
  if (read.kind === 'unreadable') return clip([{ text: UNREADABLE_TEXT, tone: 'dim' }]);
  const s = read.state;
  const out: Line[] = [];
  const updated = s.updatedAt === undefined ? Number.NaN : Date.parse(s.updatedAt);
  if (!Number.isNaN(updated) && o.nowMs - updated > STALE_MS) {
    out.push({
      text: `Last update ${Math.floor((o.nowMs - updated) / 60_000)} min ago.`,
      tone: 'dim',
    });
  }
  out.push({ text: statusLine(s, o.paused), tone: 'head' });
  out.push({ text: 'Crew', tone: 'head' }, ...crewLines(s, columns, o.nowMs));
  out.push({ text: 'Merge queue', tone: 'head' }, ...queueLines(s));
  out.push(...ciLines(s, columns));
  if (s.mainBuild.status === 'red') {
    out.push({
      text: `Main build is red${s.mainBuild.sha ? ` (${s.mainBuild.sha.slice(0, 7)})` : ''}`,
      tone: 'err',
    });
  }
  out.push({ text: `For you (${s.forOwner.length})`, tone: 'head' });
  for (const f of s.forOwner) out.push({ text: `  ${f.title}` });
  for (const n of s.notifications) {
    out.push({
      text: `  Account blocked${n.label ? ` (${n.label})` : ''}: ${n.reason}`,
      tone: 'err',
    });
  }
  const median = s.medianLeadTimeHours === null ? '–' : `${s.medianLeadTimeHours.toFixed(1)} h`;
  out.push({ text: `Lead time (median) ${median} · deploys today ${s.today.deployed}` });
  const days = s.perDay.slice(-7);
  if (days.length > 0) {
    out.push({ text: 'Last 7 days (merged/deployed)', tone: 'head' });
    for (const d of days) out.push({ text: `  ${d.day} ${d.merged}/${d.deployed}` });
  }
  const usage = s.usageDays.slice(-7);
  if (usage.length > 0) {
    out.push({ text: 'Usage (runs)', tone: 'head' });
    for (const d of usage) {
      out.push({
        text: `  ${d.day} ${d.labels.map((l) => `${l.label} ${l.runs}`).join(' · ')}`.trimEnd(),
      });
    }
  }
  return clip(out);
}

export function statusText(read: BoardRead, paused: boolean): string {
  if (read.kind === 'missing') return MISSING_TEXT;
  if (read.kind === 'unreadable') return UNREADABLE_TEXT;
  return statusLine(read.state, paused);
}

// ---------- state directory name (same result as src/paths.ts) ----------

export function stateDirName(realPath: string, sha256Hex: string): string {
  const hash = sha256Hex.slice(0, 16);
  const parts = realPath.split(/[\\/]/).filter((p) => p !== '');
  const suffix = (parts[parts.length - 1] ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32);
  return suffix ? `${hash}-${suffix}` : hash;
}
