// Pairing a lead with a relay worker without copying files around (src/relay-command.ts):
//
// 1. On the lead, `studio relay pair <label> <host>` makes the lead's key for that worker and
//    prints one pairing line: the label, a short one-time code and the public key.
// 2. On the worker, `studio relay install --pair "<line>"` authorizes that key with the forced
//    command, keeps the code, and prints the short code of its SSH host key.
// 3. On the lead, `studio relay pair <label> --connect` reads the worker's host key, shows its short
//    code, and pins it only once the owner confirms it matches; then a first request over the
//    pinned connection must name the pairing's code. Only then is the worker written into the owner
//    config (`workers.relay.<label>`).
import { createHash, randomInt } from 'node:crypto';
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

/** Letters and digits nobody misreads: no 0/O, 1/I/L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIR_CODE_RE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const PAIR_PREFIX = 'studio-pair-1';

/** A fresh one-time code: `XXXX-XXXX`, about 40 bits. */
export function newPairCode(): string {
  const c = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/**
 * The short code of an SSH public key (`<type> <base64>`): the first 40 bits of the SHA-256 of
 * the key blob, in the code alphabet. Both machines compute it from the key itself.
 */
export function hostKeyCode(key: string): string {
  const blob = Buffer.from(key.trim().split(/\s+/)[1] ?? '', 'base64');
  const digest = createHash('sha256').update(blob).digest();
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[(digest[i] as number) % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export interface PairLine {
  label: string;
  code: string;
  /** The lead's public key, `<type> <base64>`. */
  key: string;
}

/** The one line the owner carries from the lead to the worker. */
export function renderPairLine(p: PairLine): string {
  return `${PAIR_PREFIX} ${p.label} ${p.code} ${p.key}`;
}

export function parsePairLine(line: string): PairLine {
  const parts = line.trim().split(/\s+/);
  const [prefix, label, code, type, blob] = parts;
  if (
    parts.length !== 5 ||
    prefix !== PAIR_PREFIX ||
    label === undefined ||
    !WORKER_LABEL_RE.test(label) ||
    code === undefined ||
    !PAIR_CODE_RE.test(code) ||
    !RELAY_HOST_KEY_RE.test(`${type} ${blob}`)
  ) {
    throw new Error(
      'not a pairing line: studio relay pair <label> <host> on the lead prints it (studio-pair-1 <label> <code> <key>)',
    );
  }
  return { label, code, key: `${type} ${blob}` };
}

/** The lead's private key for a relay label, in the owner config dir. */
export const leadKeyFile = (owner: OwnerEnv, label: string): string =>
  join(ownerConfigDir(owner), 'relay', `${label}_ed25519`);

/** A pairing the lead started and the owner has not confirmed yet. */
export interface PendingPair {
  label: string;
  host: string;
  port: number;
  user: string;
  code: string;
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

export function readPending(owner: OwnerEnv, label: string): PendingPair | undefined {
  const f = pendingFile(owner, label);
  if (!existsSync(f)) return undefined;
  const p = JSON.parse(readFileSync(f, 'utf8')) as PendingPair;
  if (
    p.label !== label ||
    !RELAY_HOST_RE.test(p.host) ||
    !PAIR_CODE_RE.test(p.code) ||
    !Number.isInteger(p.port)
  ) {
    throw new Error(
      `${f} has an unknown shape; start again with studio relay pair ${label} <host>`,
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

/** Where a relay worker keeps the codes of the pairings it took (`relay install --pair`). */
export const pairingsFile = (home: string): string => join(home, 'pairings.json');

/** The codes a relay worker took, by label. */
export function readPairings(home: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(pairingsFile(home), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(raw).filter(
        (e): e is [string, string] =>
          WORKER_LABEL_RE.test(e[0]) && typeof e[1] === 'string' && PAIR_CODE_RE.test(e[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function writePairing(home: string, label: string, code: string): void {
  const all = { ...readPairings(home), [label]: code };
  writeFileSync(pairingsFile(home), `${JSON.stringify(all, null, 2)}\n`);
}
