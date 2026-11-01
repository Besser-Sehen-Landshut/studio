import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OwnerConfig, OwnerEnv } from './config.js';
import { checkCredentialCommand, PROVIDER_MAX_BYTES, PROVIDER_TIMEOUT_MS } from './credentials.js';
import { acquireStateLock, type StateLock, writeStateFile } from './paths.js';
import type { Ports } from './ports.js';
import type { StateSnapshot } from './state.js';

/** Most messages one run sends; the rest follows on the next run. */
export const MAX_SENDS_PER_RUN = 20;
const MAX_TEXT = 500;
const LOCK_STALE_MS = 2 * 60_000;

type Kind = 'owner-item' | 'usage-limit' | 'account-block';

interface Message {
  key: string;
  kind: Kind;
  id: string;
  text: string;
}

/** Control characters become spaces and the text is cut to 500 characters. */
const cleanText = (s: string): string =>
  Array.from(s.replace(/\p{Cc}/gu, ' '))
    .slice(0, MAX_TEXT)
    .join('');

function messagesOf(projectKey: string, snapshot: StateSnapshot): Message[] {
  const notes = snapshot.notifications ?? [];
  const out: Message[] = [];
  for (const line of snapshot.forOwner) {
    // The block is announced through `notifications`, once across projects.
    if (line.id === 'account-block' && notes.length > 0) continue;
    const kind: Kind =
      line.id === 'account-block'
        ? 'account-block'
        : line.id === 'usage-limit'
          ? 'usage-limit'
          : 'owner-item';
    out.push({
      key: `${projectKey}:${line.id}:${line.title}`,
      kind,
      id: line.id,
      text: line.title,
    });
  }
  for (const note of notes) {
    // Without a label the block file is unreadable and `at` is just "now": keep the key stable.
    const key =
      note.label === undefined
        ? `block::${note.reason}`
        : `block:${note.label}:${note.reason}:${note.at}`;
    out.push({ key, kind: 'account-block', id: note.id, text: note.title });
  }
  return out;
}

type Notified = { ok: true; keys: string[] } | { ok: false };

function readNotified(file: string): Notified {
  try {
    if (!lstatSync(file).isFile()) return { ok: false };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, keys: [] } : { ok: false };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw) || !raw.every((k) => typeof k === 'string')) return { ok: false };
    return { ok: true, keys: raw as string[] };
  } catch {
    return { ok: false };
  }
}

/**
 * Hands each owner line and account-block notification that was not sent yet to the owner's notify
 * command. Returns error lines (fixed text, never command output or message text).
 */
export async function sendNotifications(o: {
  ownerRoot: string;
  projectKey: string;
  primaryRepo: string;
  snapshot: StateSnapshot;
  ownerConfig: OwnerConfig;
  ports: Ports;
  owner: OwnerEnv;
}): Promise<string[]> {
  const notify = o.ownerConfig.notify;
  if (notify === undefined) return [];
  const lock = acquireStateLock(o.ownerRoot, 'notify.lock', {
    now: new Date(),
    heartbeatStaleMs: LOCK_STALE_MS,
  });
  if (!lock) return []; // another run is sending right now; it records what it sent
  try {
    return await sendLocked(o, notify, lock);
  } finally {
    if (lock.owned()) lock.release();
  }
}

async function sendLocked(
  o: Parameters<typeof sendNotifications>[0],
  notify: NonNullable<OwnerConfig['notify']>,
  lock: StateLock,
): Promise<string[]> {
  const file = join(o.ownerRoot, 'notified.json');
  const read = readNotified(file);
  if (!read.ok) return ['notify: notified.json is unreadable; nothing sent'];
  try {
    checkCredentialCommand(notify.command, o.owner);
  } catch {
    return [
      'notify: the notify command is not trusted (absolute, own regular file, not writable by others); nothing sent',
    ];
  }
  const messages = messagesOf(o.projectKey, o.snapshot);
  const current = new Set(messages.map((m) => m.key));
  const prefix = `${o.projectKey}:`;
  // Keys of this project (and of owner-wide blocks) that are no longer current are forgotten.
  const sent = new Set(
    read.keys.filter((k) => current.has(k) || !(k.startsWith(prefix) || k.startsWith('block:'))),
  );
  const penv = o.owner.env ?? process.env;
  const errors: string[] = [];
  let sends = 0;
  for (const m of messages) {
    if (sent.has(m.key)) continue;
    if (sends >= MAX_SENDS_PER_RUN) break;
    sends++;
    const env: Record<string, string> = {
      HOME: o.owner.homedir ?? homedir(),
      STUDIO_NOTIFY_CHANNEL: notify.channel,
      STUDIO_NOTIFY_KIND: m.kind,
      STUDIO_NOTIFY_ID: cleanText(m.id),
      STUDIO_NOTIFY_PROJECT: cleanText(o.primaryRepo),
      STUDIO_NOTIFY_TEXT: cleanText(m.text),
    };
    if (penv.PATH !== undefined) env.PATH = penv.PATH;
    lock.heartbeat(new Date());
    try {
      const reply = await o.ports.credentials.runProvider(notify.command, env, {
        timeoutMs: PROVIDER_TIMEOUT_MS,
        maxBytes: PROVIDER_MAX_BYTES,
      });
      if (reply.code === 0) sent.add(m.key);
      else {
        errors.push(
          `notify: the notify command failed (${m.kind}); it and the rest are retried next time`,
        );
        break;
      }
    } catch {
      errors.push(
        `notify: the notify command could not be run (${m.kind}); it and the rest are retried next time`,
      );
      break;
    }
  }
  const keys = [...sent];
  if (keys.length !== read.keys.length || keys.some((k, i) => k !== read.keys[i])) {
    try {
      writeStateFile(o.ownerRoot, file, `${JSON.stringify(keys, null, 2)}\n`);
    } catch {
      errors.push('notify: notified.json could not be written; messages may repeat');
    }
  }
  return errors;
}
