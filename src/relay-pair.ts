// Pairing a lead with a relay worker without copying files around (src/relay-command.ts):
//
// 1. On the lead, `studio relay pair <label> <host>` makes the lead's key for that worker and
//    prints one pairing line: the label, a single-use pairing secret and the lead's public key.
// 2. On the worker, `studio relay install --pair "<line>"` records the pairing and authorizes that
//    key with the forced command. Its authorized keys file holds exactly the keys of the pairings
//    it records, nothing else.
// 3. On the lead, `studio relay pair <label> --connect` reads the worker's host key, connects with
//    it pinned, and pins it for good only when the worker proves it is the machine the line was
//    pasted on: within the hour after the install it answers HMAC-SHA256(secret, its host key),
//    which only a holder of the secret can compute, checked in constant time. The secret travels
//    only in the pasted line, is used once, and expires after an hour. Both sides also show the
//    host key's full SHA256 fingerprint for a comparison by eye, which no longer carries the check.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import {
  loadOwnerConfig,
  type OwnerEnv,
  ownerConfigDir,
  ownerConfigFile,
  RELAY_HOST_KEY_RE,
  RELAY_HOST_RE,
  WORKER_LABEL_RE,
} from './config.js';
import { ensureStateDir, ownerStateRootFor, writeStateFile } from './paths.js';
import { authorizedKeyLine } from './relay-windows.js';

/** How long a pairing secret holds, on the lead and on the worker. */
export const PAIR_TTL_MS = 60 * 60_000;
/** 32 random bytes, base64url without padding. */
export const PAIR_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const PAIR_PREFIX = 'studio-pair-1';

export const newPairSecret = (): string => randomBytes(32).toString('base64url');

/** A public key as `<type> <base64>`, without a comment. */
const keyOnly = (key: string): string => key.trim().split(/\s+/).slice(0, 2).join(' ');

/** The SHA256 fingerprint of an SSH public key as ssh-keygen -l prints it. */
export function keyFingerprint(key: string): string {
  const blob = Buffer.from(key.trim().split(/\s+/)[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** The worker's proof for one pairing: HMAC-SHA256 of its host key under the pairing secret. */
export const pairProof = (secret: string, hostKey: string): string =>
  createHmac('sha256', secret).update(keyOnly(hostKey)).digest('hex');

/** Whether `mac` proves `hostKey` for `secret`; compared in constant time. */
export function proofHolds(secret: string, hostKey: string, mac: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(mac)) return false;
  return timingSafeEqual(Buffer.from(pairProof(secret, hostKey), 'hex'), Buffer.from(mac, 'hex'));
}

export interface PairLine {
  label: string;
  secret: string;
  /** The lead's public key, `<type> <base64>`. */
  key: string;
}

/** The one line the owner carries from the lead to the worker. */
export const renderPairLine = (p: PairLine): string =>
  `${PAIR_PREFIX} ${p.label} ${p.secret} ${p.key}`;

export function parsePairLine(line: string): PairLine {
  const parts = line.trim().split(/\s+/);
  const [prefix, label, secret, type, blob] = parts;
  if (
    parts.length !== 5 ||
    prefix !== PAIR_PREFIX ||
    label === undefined ||
    !WORKER_LABEL_RE.test(label) ||
    secret === undefined ||
    !PAIR_SECRET_RE.test(secret) ||
    !RELAY_HOST_KEY_RE.test(`${type} ${blob}`)
  ) {
    throw new Error(
      'not a pairing line: studio relay pair <label> <host> on the lead prints it (studio-pair-1 <label> <secret> <key>)',
    );
  }
  return { label, secret, key: `${type} ${blob}` };
}

/** The lead's private key for a relay label, in the owner config dir. */
export const leadKeyFile = (owner: OwnerEnv, label: string): string =>
  join(ownerConfigDir(owner), 'relay', `${label}_ed25519`);

/** A pairing the lead started and has not connected yet. */
export interface PendingPair {
  label: string;
  host: string;
  port: number;
  user: string;
  secret: string;
  identityFile: string;
  createdAt: string;
}

const pendingFile = (owner: OwnerEnv, label: string) =>
  join(ownerStateRootFor(owner), 'relay', `pair-${label}.json`);

export function writePending(owner: OwnerEnv, p: PendingPair): void {
  const root = ownerStateRootFor(owner);
  ensureStateDir(root, join(root, 'relay'));
  writeStateFile(root, pendingFile(owner, p.label), `${JSON.stringify(p, null, 2)}\n`);
}

/**
 * The pairing of `label` the lead waits for; an expired one is refused (and removed, unless `keep`:
 * a dry run changes nothing), a missing one (never started, or used already) is undefined.
 */
export function readPending(
  owner: OwnerEnv,
  label: string,
  now: Date,
  o: { keep?: boolean } = {},
): PendingPair | undefined {
  const f = pendingFile(owner, label);
  if (!existsSync(f)) return undefined;
  const p = JSON.parse(readFileSync(f, 'utf8')) as PendingPair;
  if (
    p.label !== label ||
    !RELAY_HOST_RE.test(p.host) ||
    !PAIR_SECRET_RE.test(p.secret) ||
    !Number.isInteger(p.port) ||
    Number.isNaN(Date.parse(p.createdAt))
  ) {
    throw new Error(
      `${f} has an unknown shape; start again with studio relay pair ${label} <host>`,
    );
  }
  if (now.getTime() - Date.parse(p.createdAt) > PAIR_TTL_MS) {
    if (o.keep !== true) rmSync(f, { force: true });
    throw new Error(
      `the pairing of ${label} expired (an hour): start again with studio relay pair ${label} <host>`,
    );
  }
  return p;
}

export const dropPending = (owner: OwnerEnv, label: string): void =>
  rmSync(pendingFile(owner, label), { force: true });

/**
 * The host key to pin from `ssh-keyscan` output: the worker's ed25519 key, `<type> <base64>`;
 * undefined when it has none.
 */
export function keyscanKey(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('#')) continue;
    const [, type, blob] = line.trim().split(/\s+/);
    const key = `${type} ${blob}`;
    if (type === 'ssh-ed25519' && RELAY_HOST_KEY_RE.test(key)) return key;
  }
  return undefined;
}

/**
 * Writes `workers.relay.<label>` into the owner config, keeping everything else as it is (comments
 * included), and reads it back: a file Studio cannot load afterwards is put back as it was.
 */
export function writeRelayTarget(
  owner: OwnerEnv,
  label: string,
  t: { host: string; port: number; user: string; hostKey: string; identityFile: string },
): void {
  const file = ownerConfigFile(owner);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const doc = parseDocument(text === '' ? '{}' : text);
  if (doc.errors.length > 0) throw new Error(`${file}: invalid YAML; nothing changed`);
  if (!isMap(doc.contents)) throw new Error(`${file}: not a map; nothing changed`);
  doc.setIn(['workers', 'relay', label], {
    host: t.host,
    user: t.user,
    port: t.port,
    host_key: t.hostKey,
    identity_file: t.identityFile,
  });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, doc.toString(), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    loadOwnerConfig(owner);
  } catch (e) {
    if (text === '') rmSync(file, { force: true });
    else writeFileSync(file, text, { mode: 0o600 });
    throw e;
  }
}

// ---- On the worker ------------------------------------------------------------------------------

/** One pairing the worker took: the lead's key, its secret and when it was taken. */
export interface Pairing {
  key: string;
  secret: string;
  pairedAt: string;
}

/**
 * Where a relay worker records its pairings: a folder of the admin-only tree that only SYSTEM and
 * administrators may write and the relay account may read (the setup script makes it). Each
 * pairing's label is a lead on this worker: its jobs are its own.
 */
export const pairingsFile = (machine: string): string => join(machine, 'pairing', 'pairings.json');

export function readPairings(machine: string): Record<string, Pairing> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pairingsFile(machine), 'utf8'));
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, Pairing> = {};
  for (const [label, v] of Object.entries(raw as Record<string, Partial<Pairing>>)) {
    if (
      WORKER_LABEL_RE.test(label) &&
      typeof v?.key === 'string' &&
      RELAY_HOST_KEY_RE.test(v.key) &&
      typeof v.secret === 'string' &&
      PAIR_SECRET_RE.test(v.secret) &&
      typeof v.pairedAt === 'string' &&
      !Number.isNaN(Date.parse(v.pairedAt))
    ) {
      out[label] = { key: v.key, secret: v.secret, pairedAt: v.pairedAt };
    }
  }
  return out;
}

/** Writes the record whole: a temporary file renamed over the old one (run elevated). */
export function writePairings(machine: string, all: Record<string, Pairing>): void {
  const file = pairingsFile(machine);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The proofs a worker answers in `hello`: for each pairing younger than an hour. */
export function pairProofs(
  pairings: Record<string, Pairing>,
  hostKey: string | undefined,
  now: Date,
): { label: string; mac: string }[] {
  if (hostKey === undefined) return [];
  return Object.entries(pairings)
    .filter(([, p]) => now.getTime() - Date.parse(p.pairedAt) <= PAIR_TTL_MS)
    .map(([label, p]) => ({ label, mac: pairProof(p.secret, hostKey) }));
}

/**
 * The authorized keys file a worker's pairings give: one line per pairing, forced to the relay
 * command, in label order, and nothing else. Lines of the old file that are not in it are named so
 * the install can say what it removed.
 */
export function authorizedKeysPlan(o: {
  pairings: Record<string, Pairing>;
  command: string;
  existing: string | undefined;
}): {
  text: string;
  keyLines: string[];
  lines: { label: string; fingerprint: string }[];
  removed: string[];
} {
  const labels = Object.keys(o.pairings).sort();
  // Each key's forced command names its lead, and so does its comment.
  const want = labels.map((l) =>
    authorizedKeyLine({ key: (o.pairings[l] as Pairing).key, command: o.command, lead: l }),
  );
  const removed = (o.existing ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !want.includes(l));
  return {
    text: want.length === 0 ? '' : `${want.join('\r\n')}\r\n`,
    keyLines: want,
    lines: labels.map((l) => ({
      label: l,
      fingerprint: keyFingerprint((o.pairings[l] as Pairing).key),
    })),
    removed,
  };
}
