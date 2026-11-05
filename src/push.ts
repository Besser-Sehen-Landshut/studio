// Push messages (ntfy) for what needs a decision: one line per push, Studio's own words only (never
// crew text), deduplicated across ticks, at most one push per project in ten minutes, held back
// during quiet hours unless urgent. The topic lives in the owner config dir, the record of what was
// sent in the owner state root; neither is readable by a crew.
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Board } from './board.js';
import { notifySecretFile, type OwnerConfig, type OwnerEnv } from './config.js';
import { readOwnerSecret, writeOwnerSecret } from './credentials.js';
import { readBlocksFile } from './limits.js';
import { classifyDecision, resolveZone } from './pane-data.js';
import { acquireStateLock, writeStateFile } from './paths.js';
import type { Http } from './ports.js';

export const PUSHED_FILE = 'pushed.json';
const PUSH_LOCK = 'push.lock';
const LOCK_STALE_MS = 2 * 60_000;
/** At most one push per project in this time, urgent ones aside. */
export const PUSH_INTERVAL_MS = 10 * 60_000;
/** A sent key that is no longer current is forgotten after this long. */
const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_KEYS = 2000;
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

/**
 * The stored transport and its secret. ntfy is the only transport so far: whoever knows the topic
 * can read the pushes, so the topic is the secret. Another transport is one more variant here and
 * one more branch in `sendPush`.
 */
export type NotifySecret = { transport: 'ntfy'; topic: string };

/** 24 url-safe characters after the prefix: 144 random bits. */
const TOPIC_RE = /^studio-[A-Za-z0-9_-]{24}$/;
export const newNtfyTopic = (): string => `studio-${randomBytes(18).toString('base64url')}`;

export type NotifySecretRead =
  | { kind: 'absent' }
  | { kind: 'ok'; secret: NotifySecret }
  | { kind: 'bad'; why: string };

/** The `notify-secret` file: plain, ours, mode 0600, a known transport. `why` holds no value. */
export function readNotifySecret(owner: OwnerEnv): NotifySecretRead {
  const file = notifySecretFile(owner);
  const read = readOwnerSecret(file, owner);
  if (read.kind !== 'ok') return read;
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return { kind: 'bad', why: `${file} is not valid JSON` };
  }
  const { transport, topic } = (raw ?? {}) as { transport?: unknown; topic?: unknown };
  if (transport !== 'ntfy') return { kind: 'bad', why: `${file} names no known transport` };
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) {
    return { kind: 'bad', why: `${file} holds no valid ntfy topic` };
  }
  return { kind: 'ok', secret: { transport, topic } };
}

export function installNotifySecret(secret: NotifySecret, owner: OwnerEnv): void {
  writeOwnerSecret(
    notifySecretFile(owner),
    `${JSON.stringify({ transport: secret.transport, topic: secret.topic })}\n`,
  );
}

/** The ntfy server of the owner config, else ntfy.sh. */
export const ntfyServer = (config: OwnerConfig): string =>
  config.notify?.ntfyServer ?? DEFAULT_NTFY_SERVER;

/** The link to subscribe to: shown once by the setup, the only place the topic is printed. */
export const subscribeLink = (config: OwnerConfig, secret: NotifySecret): string =>
  `${ntfyServer(config)}/${secret.topic}`;

/** One push through the stored transport. Never throws; only the status comes back. */
export function sendPush(
  http: Http,
  secret: NotifySecret,
  config: OwnerConfig,
  message: { text: string; urgent: boolean },
): Promise<{ ok: boolean; status?: number }> {
  return http.post(subscribeLink(config, secret), message.text, {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: 'Studio',
    Priority: message.urgent ? 'high' : 'default',
  });
}

/** Why a failed push failed, as fixed text. */
export const pushFailure = (reply: { status?: number }): string =>
  reply.status === undefined ? 'ntfy could not be reached' : `ntfy answered ${reply.status}`;

export type PushKind =
  | 'fix_limit'
  | 'changes_requested'
  | 'merge_failed'
  | 'question'
  | 'blocked'
  | 'account_block'
  | 'release_approval'
  | 'other';

export interface Decision {
  /** What makes it the same decision on the next tick: project, item, kind, when it arose. */
  key: string;
  /** An item id, `<repo>#<pr>` or, for an account block, the credential label. */
  item: string;
  kind: PushKind;
  urgent: boolean;
}

const ITEM_RE = /^(?:[A-Z]+-\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|[A-Za-z0-9._-]{1,64})$/;
/** Ids only: anything else would be text Studio did not write. */
const safeId = (s: string): string => (ITEM_RE.test(s) ? s : '?');

/**
 * What needs a decision, from a tick's lead list and the owner's account blocks. Each key holds
 * the time the item entered its current status (from the board), so the same decision is pushed
 * once, and a new one on the same item (it moved meanwhile) once more. A block is keyed owner-wide:
 * one push across projects.
 */
export function decisionsOf(o: {
  projectKey: string;
  needsLead: readonly { item: string; reason: string }[];
  board: Board | undefined;
  ownerRoot: string;
}): Decision[] {
  const out: Decision[] = [];
  for (const n of o.needsLead) {
    const item = safeId(n.item);
    const kind: PushKind = n.reason.startsWith('release approval')
      ? 'release_approval'
      : classifyDecision(n.reason);
    const since = o.board?.items.find((i) => i.id === n.item)?.history.at(-1)?.at ?? '';
    const key = `${o.projectKey}:${item}:${kind}:${since}`;
    if (out.some((d) => d.key === key)) continue;
    out.push({ key, item, kind, urgent: false });
  }
  const read = readBlocksFile(join(o.ownerRoot, 'blocks.json'));
  if (!read.ok) {
    out.push({ key: 'block::unreadable', item: '?', kind: 'account_block', urgent: true });
  } else {
    for (const b of read.blocks) {
      const key = `block:${b.label}:${b.reason}:${b.at}`;
      out.push({ key, item: safeId(b.label), kind: 'account_block', urgent: true });
    }
  }
  return out;
}

export type Lang = 'en' | 'de';

const PHRASES: Record<Lang, Record<PushKind, string>> = {
  en: {
    fix_limit: 'Fix limit reached',
    changes_requested: 'Changes requested',
    merge_failed: 'Merge failed',
    question: 'Crew has a question',
    blocked: 'Blocked',
    account_block: 'Account blocked',
    release_approval: 'Release approval needed',
    other: 'Decision needed',
  },
  de: {
    fix_limit: 'Fix-Limit erreicht',
    changes_requested: 'Änderungen angefordert',
    merge_failed: 'Merge fehlgeschlagen',
    question: 'Crew hat eine Frage',
    blocked: 'Blockiert',
    account_block: 'Konto gesperrt',
    release_approval: 'Release-Freigabe nötig',
    other: 'Entscheidung nötig',
  },
};

/** The one line of a push: a fixed phrase, the item and the project, or a count for several. */
export function pushText(decisions: readonly Decision[], project: string, lang: Lang): string {
  const one = decisions[0];
  if (decisions.length === 1 && one !== undefined) {
    return `${PHRASES[lang][one.kind]}: ${one.item} in ${project}`;
  }
  const n = decisions.length;
  const blocked = decisions.some((d) => d.kind === 'account_block');
  if (lang === 'de') {
    return `${n} Entscheidungen nötig in ${project}${blocked ? ': Konto gesperrt' : ''}`;
  }
  return `${n} decisions needed in ${project}${blocked ? ': account blocked' : ''}`;
}

/** German when the locale names it, else English; the owner config wins. */
export function pushLanguage(config: OwnerConfig, env: Record<string, string | undefined>): Lang {
  if (config.notify?.language !== undefined) return config.notify.language;
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const t = (v ?? '').trim().toLowerCase();
    if (t === '' || t === 'c' || t === 'posix') continue;
    return /^(de([-_.@]|$)|german|deutsch)/.test(t) ? 'de' : 'en';
  }
  return 'en';
}

/** The text of the setup's test push. */
export const testPushText = (lang: Lang): string =>
  lang === 'de' ? 'Test: Studio erreicht dich hier' : 'Test: Studio reaches you here';

/** Whether `now` lies in `HH:MM-HH:MM` on the clock of `zone`; a window may span midnight. */
export function inQuietHours(quiet: string | undefined, now: Date, zone: string): boolean {
  if (quiet === undefined) return false;
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const start = minutes(quiet.slice(0, 5));
  const end = minutes(quiet.slice(6, 11));
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const m = get('hour') * 60 + get('minute');
  return start < end ? m >= start && m < end : m >= start || m < end;
}

type Pushed = { sent: Record<string, string>; last: Record<string, string> };

function readPushed(file: string): Pushed | undefined {
  try {
    if (!lstatSync(file).isFile()) return undefined;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { sent: Object.create(null), last: Object.create(null) }
      : undefined;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Pushed> | null;
    const isMap = (v: unknown): v is Record<string, string> =>
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.values(v).every((x) => typeof x === 'string');
    if (!isMap(raw?.sent) || !isMap(raw?.last)) return undefined;
    return {
      sent: Object.assign(Object.create(null), raw.sent),
      last: Object.assign(Object.create(null), raw.last),
    };
  } catch {
    return undefined;
  }
}

export type PushResult = {
  /** Decisions in the push that went out. */
  sent: number;
  /** Why fresh decisions wait for a later tick. */
  deferred?: 'throttle' | 'quiet' | 'locked';
  /** `notify: ...` lines, fixed text: never a key, never a reply body. */
  errors: string[];
};

/**
 * Pushes the decisions not sent yet, bundled into one message. Without stored keys nothing
 * happens. Throttle and quiet hours hold back what is not urgent; the held decisions stay fresh
 * and go out with the next push. A failed send is retried on the next run. Never throws.
 */
export async function pushDecisions(o: {
  ownerRoot: string;
  projectKey: string;
  /** The project's name for the message: the repository name of `primary_repo`. */
  project: string;
  decisions: readonly Decision[];
  ownerConfig: OwnerConfig;
  owner: OwnerEnv;
  http: Http | undefined;
  now: Date;
}): Promise<PushResult> {
  try {
    return await pushLocked(o);
  } catch {
    return { sent: 0, errors: ['notify: the push could not be prepared; retried next tick'] };
  }
}

async function pushLocked(o: Parameters<typeof pushDecisions>[0]): Promise<PushResult> {
  const stored = readNotifySecret(o.owner);
  if (stored.kind === 'absent') return { sent: 0, errors: [] };
  if (stored.kind === 'bad') {
    return { sent: 0, errors: [`notify: ${stored.why}; run studio setup --notifications`] };
  }
  if (o.decisions.length === 0) return { sent: 0, errors: [] };
  const http = o.http;
  if (http === undefined) {
    return { sent: 0, errors: ['notify: no push transport in this process; nothing sent'] };
  }
  const lock = acquireStateLock(o.ownerRoot, PUSH_LOCK, {
    now: o.now,
    heartbeatStaleMs: LOCK_STALE_MS,
  });
  // Another project is pushing right now: what is fresh here stays fresh for the next tick.
  if (!lock) return { sent: 0, deferred: 'locked', errors: [] };
  try {
    const file = join(o.ownerRoot, PUSHED_FILE);
    const state = readPushed(file);
    if (state === undefined) {
      return { sent: 0, errors: [`notify: ${PUSHED_FILE} is unreadable; nothing sent`] };
    }
    const now = o.now.getTime();
    const current = new Set(o.decisions.map((d) => d.key));
    const before = JSON.stringify(state);
    for (const [k, at] of Object.entries(state.sent)) {
      if (!current.has(k) && !(now - Date.parse(at) < KEEP_MS)) delete state.sent[k];
    }
    const fresh = o.decisions.filter((d) => !Object.hasOwn(state.sent, d.key));
    const save = (): string[] => {
      const keep = Object.entries(state.sent)
        .sort((a, b) => b[1].localeCompare(a[1]))
        .slice(0, MAX_KEYS);
      state.sent = Object.assign(Object.create(null), Object.fromEntries(keep));
      if (JSON.stringify(state) === before) return [];
      try {
        writeStateFile(o.ownerRoot, file, `${JSON.stringify(state, null, 2)}\n`);
        return [];
      } catch {
        return [`notify: ${PUSHED_FILE} could not be written; a push may repeat`];
      }
    };
    if (fresh.length === 0) return { sent: 0, errors: save() };
    const urgent = fresh.some((d) => d.urgent);
    if (!urgent) {
      const zone = resolveZone(o.ownerConfig.crewLabelLimits.timezone);
      if (inQuietHours(o.ownerConfig.notify?.quiet, o.now, zone)) {
        return { sent: 0, deferred: 'quiet', errors: save() };
      }
      const last = Date.parse(state.last[o.projectKey] ?? '');
      if (!Number.isNaN(last) && now - last < PUSH_INTERVAL_MS) {
        return { sent: 0, deferred: 'throttle', errors: save() };
      }
    }
    const lang = pushLanguage(o.ownerConfig, o.owner.env ?? process.env);
    const reply = await sendPush(http, stored.secret, o.ownerConfig, {
      text: pushText(fresh, o.project, lang),
      urgent,
    });
    if (!reply.ok) {
      return { sent: 0, errors: [`notify: ${pushFailure(reply)}; retried next tick`, ...save()] };
    }
    const at = o.now.toISOString();
    for (const d of fresh) state.sent[d.key] = at;
    state.last[o.projectKey] = at;
    return { sent: fresh.length, errors: save() };
  } finally {
    lock.release();
  }
}
