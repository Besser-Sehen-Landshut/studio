// The deny set of a relay worker, carried from the lead (src/relay-command.ts):
//
// - `studio relay pair <label>` takes the union of `workers.<label>.deny` (hosts, ports, prefixes)
//   of every project this lead knows into the pairing line, under the pairing secret's HMAC;
//   `relay install --pair` adds it to the worker's own `workers.serve.deny` and builds the
//   firewall rules from that. The worker's proof at `--connect` covers the set it recorded, so a
//   line that lost entries on the way fails there.
// - A deny entry a project adds later holds every start (src/relay-lockdown.ts) until
//   `studio relay pair <label> --update-deny` prints a line that only adds the current set: signed
//   with the lead's key for that worker (SSHSIG, `ssh-keygen -Y sign`) and checked on the worker
//   against the key its pairing recorded, the one its authorized keys file holds.
//
// The worker only ever adds entries: no line, old or new, removes one. Removing an entry is a hand
// edit of `workers.serve.deny` on the worker, then `relay install` again.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { loadConfig, RELAY_HOST_KEY_RE, WORKER_LABEL_RE, workerDenySchema } from './config.js';
import { markerProject } from './overview.js';
import { OWNER_DIR, projectStateRoots } from './paths.js';

/** The part of a deny list the firewall of a relay worker holds. */
export interface DenySet {
  hosts: string[];
  ports: number[];
  prefixes: string[];
}

export const EMPTY_DENY: DenySet = { hosts: [], ports: [], prefixes: [] };

/** One spelling of a set: hosts lower case, everything unique and sorted. */
export function canonicalDeny(d: Partial<DenySet>): DenySet {
  const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
  return {
    hosts: sorted((d.hosts ?? []).map((h) => h.toLowerCase())),
    ports: [...new Set(d.ports ?? [])].sort((a, b) => a - b),
    prefixes: sorted(d.prefixes ?? []),
  };
}

export const unionDeny = (...sets: readonly Partial<DenySet>[]): DenySet =>
  canonicalDeny({
    hosts: sets.flatMap((s) => s.hosts ?? []),
    ports: sets.flatMap((s) => s.ports ?? []),
    prefixes: sets.flatMap((s) => s.prefixes ?? []),
  });

/** The bytes both sides authenticate: the canonical set as JSON. */
export const denyJson = (d: Partial<DenySet>): string => JSON.stringify(canonicalDeny(d));

export const denyDigest = (d: Partial<DenySet>): string =>
  createHash('sha256').update(denyJson(d)).digest('hex');

export const encodeDeny = (d: Partial<DenySet>): string =>
  Buffer.from(denyJson(d), 'utf8').toString('base64url');

/** A set from a line: base64url of the canonical JSON, each entry as the config schema takes it. */
export function decodeDeny(text: string): DenySet {
  if (!/^[A-Za-z0-9_-]{1,8000}$/.test(text)) throw new Error('the deny set is not base64url');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new Error('the deny set is not JSON');
  }
  const r = raw as Partial<DenySet> | null;
  if (r === null || typeof r !== 'object' || Array.isArray(r)) {
    throw new Error('the deny set is not an object');
  }
  const parsed = workerDenySchema.safeParse({
    hosts: r.hosts,
    ports: r.ports,
    prefixes: r.prefixes,
  });
  if (!parsed.success) {
    throw new Error(`the deny set is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const d = canonicalDeny({
    hosts: parsed.data.hosts,
    ports: parsed.data.ports,
    prefixes: parsed.data.prefixes ?? [],
  });
  // Exactly the canonical spelling: nothing else rides along under the MAC or the signature.
  if (denyJson(d) !== JSON.stringify(raw))
    throw new Error('the deny set is not in its one spelling');
  return d;
}

/**
 * The union of `workers.<label>.deny` of every project of this lead (its state roots name them).
 * A project whose config cannot be read is named in `problems`; its entries, if any, then hold
 * starts on the worker until a later `--update-deny`.
 */
export function leadDenyFor(
  stateBase: string,
  label: string,
): { deny: DenySet; projects: string[]; problems: string[] } {
  const sets: Partial<DenySet>[] = [];
  const projects: string[] = [];
  const problems: string[] = [];
  for (const root of projectStateRoots(stateBase)) {
    if (root.endsWith(`/${OWNER_DIR}`) || root.endsWith(`\\${OWNER_DIR}`)) continue;
    let project: string | undefined;
    try {
      project = markerProject(root);
    } catch (e) {
      problems.push((e as Error).message);
      continue;
    }
    if (project === undefined || !existsSync(project)) continue;
    try {
      const d = loadConfig(project).workers?.[label]?.deny;
      if (d === undefined) continue;
      projects.push(project);
      sets.push({ hosts: d.hosts, ports: d.ports, prefixes: d.prefixes ?? [] });
    } catch (e) {
      problems.push(`${project}: ${(e as Error).message}`);
    }
  }
  const deny = unionDeny(...sets);
  // The worker's own config takes at most 50 of each.
  for (const k of ['hosts', 'ports', 'prefixes'] as const) {
    if (deny[k].length > 50) {
      throw new Error(
        `the projects of ${label} deny ${deny[k].length} ${k}, more than 50 a worker takes`,
      );
    }
  }
  return { deny, projects, problems };
}

/** What the worker's config holds under `workers.serve.deny` (hosts, ports, prefixes). */
function serveDenyOf(text: string): DenySet {
  const doc = parseDocument(text === '' ? '{}' : text);
  const get = (k: string): unknown[] => {
    const v = doc.getIn(['workers', 'serve', 'deny', k]);
    return isSeq(v) ? (v.toJSON() as unknown[]) : [];
  };
  return canonicalDeny({
    hosts: get('hosts').map(String),
    ports: get('ports').map(Number),
    prefixes: get('prefixes').map(String),
  });
}

/**
 * Adds `add` to `workers.serve.deny` of the worker's config, written whole and swapped in;
 * nothing is removed, comments and other keys stay. A missing file starts from `fallback`.
 * Returns what was added (empty: the file is unchanged).
 */
export function addToServeDeny(file: string, add: Partial<DenySet>, fallback: string): DenySet {
  let text = fallback;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const doc = parseDocument(text === '' ? '{}' : text);
  if (doc.errors.length > 0) throw new Error(`${file}: invalid YAML; nothing changed`);
  if (!isMap(doc.contents)) throw new Error(`${file}: not a map; nothing changed`);
  const before = serveDenyOf(text);
  const want = canonicalDeny(add);
  const added: DenySet = {
    hosts: want.hosts.filter((h) => !before.hosts.includes(h)),
    ports: want.ports.filter((p) => !before.ports.includes(p)),
    prefixes: want.prefixes.filter((p) => !before.prefixes.includes(p)),
  };
  const fresh = !existsSync(file);
  if (!fresh && added.hosts.length + added.ports.length + added.prefixes.length === 0) {
    return added;
  }
  // Appended in the order of the file, so an entry written by hand keeps its place.
  const list = (k: keyof DenySet): unknown[] => {
    const v = doc.getIn(['workers', 'serve', 'deny', k]);
    return isSeq(v) ? (v.toJSON() as unknown[]) : [];
  };
  for (const k of ['hosts', 'ports', 'prefixes'] as const) {
    if (added[k].length > 0) doc.setIn(['workers', 'serve', 'deny', k], [...list(k), ...added[k]]);
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, doc.toString(), { flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return added;
}

/** The deny set as one plain line for the output. */
export const denyText = (d: DenySet): string => {
  const parts = [
    d.hosts.length > 0 ? `hosts ${d.hosts.join(', ')}` : '',
    d.ports.length > 0 ? `ports ${d.ports.join(', ')}` : '',
    d.prefixes.length > 0 ? `prefixes ${d.prefixes.join(', ')}` : '',
  ].filter((x) => x !== '');
  return parts.length === 0 ? 'nothing' : parts.join('; ');
};

// ---- The update line: signed with the lead's key for that worker ------------------------------

const UPDATE_PREFIX = 'studio-deny-1';
/** The SSHSIG namespace: a signature for anything else never counts here. */
export const DENY_NAMESPACE = 'studio-relay-deny@studio';
/** How long an update line holds after the lead printed it. */
export const DENY_UPDATE_TTL_MS = 24 * 60 * 60_000;

/** What the lead signs: the label, the set and when, one per line. */
export const denyUpdateMessage = (
  label: string,
  deny: Partial<DenySet>,
  issuedAt: number,
): string => `${UPDATE_PREFIX}\n${label}\n${denyJson(deny)}\n${issuedAt}\n`;

export interface DenyUpdate {
  label: string;
  deny: DenySet;
  /** Seconds since 1970. */
  issuedAt: number;
  /** The SSHSIG blob. */
  signature: Buffer;
}

export const renderDenyUpdate = (u: DenyUpdate): string =>
  `${UPDATE_PREFIX} ${u.label} ${encodeDeny(u.deny)} ${u.issuedAt} ${u.signature.toString('base64url')}`;

export function parseDenyUpdate(line: string): DenyUpdate {
  const parts = line.trim().split(/\s+/);
  const [prefix, label, deny, at, sig] = parts;
  if (
    parts.length !== 5 ||
    prefix !== UPDATE_PREFIX ||
    label === undefined ||
    !WORKER_LABEL_RE.test(label) ||
    at === undefined ||
    !/^\d{1,12}$/.test(at) ||
    sig === undefined ||
    !/^[A-Za-z0-9_-]{100,2000}$/.test(sig)
  ) {
    throw new Error(
      'not a deny update line: studio relay pair <label> --update-deny on the lead prints it (studio-deny-1 <label> <set> <time> <signature>)',
    );
  }
  return {
    label,
    deny: decodeDeny(deny as string),
    issuedAt: Number(at),
    signature: Buffer.from(sig, 'base64url'),
  };
}

/** The armored signature `ssh-keygen -Y sign` prints, as its blob. */
export function sshsigBlob(armored: string): Buffer {
  const m = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(armored);
  if (m === null) throw new Error('ssh-keygen gave no signature');
  return Buffer.from((m[1] as string).replace(/\s+/g, ''), 'base64');
}

/** A reader of SSH wire strings (uint32 length, bytes). */
function wire(buf: Buffer) {
  let at = 0;
  return {
    bytes(n: number): Buffer {
      if (at + n > buf.length) throw new Error('the signature is cut short');
      const b = buf.subarray(at, at + n);
      at += n;
      return b;
    },
    u32(): number {
      return this.bytes(4).readUInt32BE(0);
    },
    str(): Buffer {
      const n = this.u32();
      if (n > 1 << 16) throw new Error('the signature holds an oversized field');
      return this.bytes(n);
    },
    done: () => at === buf.length,
  };
}

const sshString = (b: Buffer | string): Buffer => {
  const x = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  const n = Buffer.alloc(4);
  n.writeUInt32BE(x.length, 0);
  return Buffer.concat([n, x]);
};

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Whether `blob` is an SSHSIG over `message` in `namespace` by the ed25519 key `publicKey`
 * (`ssh-ed25519 <base64>`): the key in the signature must be exactly that key, the signature
 * Ed25519 over the SSHSIG preamble (PROTOCOL.sshsig). Anything malformed is false.
 */
export function sshsigHolds(
  publicKey: string,
  namespace: string,
  message: string,
  blob: Buffer,
): boolean {
  try {
    if (!RELAY_HOST_KEY_RE.test(publicKey) || !publicKey.startsWith('ssh-ed25519 ')) return false;
    const keyBlob = Buffer.from(publicKey.split(' ')[1] as string, 'base64');
    const r = wire(blob);
    if (r.bytes(6).toString('latin1') !== 'SSHSIG' || r.u32() !== 1) return false;
    const pk = r.str();
    const ns = r.str().toString('utf8');
    const reserved = r.str();
    const hashAlg = r.str().toString('utf8');
    const sig = r.str();
    if (!r.done() || !pk.equals(keyBlob) || ns !== namespace) return false;
    if (hashAlg !== 'sha512' && hashAlg !== 'sha256') return false;
    const k = wire(pk);
    if (k.str().toString('latin1') !== 'ssh-ed25519') return false;
    const raw = k.str();
    if (!k.done() || raw.length !== 32) return false;
    const s = wire(sig);
    if (s.str().toString('latin1') !== 'ssh-ed25519') return false;
    const ed = s.str();
    if (!s.done() || ed.length !== 64) return false;
    const signed = Buffer.concat([
      Buffer.from('SSHSIG', 'latin1'),
      sshString(namespace),
      sshString(reserved),
      sshString(hashAlg),
      sshString(createHash(hashAlg).update(message, 'utf8').digest()),
    ]);
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI, raw]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, signed, key, ed);
  } catch {
    return false;
  }
}

/**
 * Checks an update line on the worker against the key its pairing of that label recorded: the
 * signature, the label, and its age (at most a day, at most five minutes ahead). Returns the
 * refusal, or undefined when it holds.
 */
export function denyUpdateProblem(
  u: DenyUpdate,
  pairingKey: string | undefined,
  now: Date,
  /** The time of the newest line this worker took for that label: a line must be newer. */
  lastTaken?: number,
): string | undefined {
  if (pairingKey === undefined) {
    return `no lead ${u.label} is paired here: studio relay install --pair with its line first`;
  }
  if (lastTaken !== undefined && u.issuedAt <= lastTaken) {
    return `the line is not newer than the last one this worker took for ${u.label} (${new Date(lastTaken * 1000).toISOString()}): run studio relay pair ${u.label} --update-deny on the lead again`;
  }
  const at = u.issuedAt * 1000;
  if (at > now.getTime() + 5 * 60_000 || now.getTime() - at > DENY_UPDATE_TTL_MS) {
    return `the line is older than a day (or from the future): run studio relay pair ${u.label} --update-deny on the lead again`;
  }
  if (
    !sshsigHolds(
      pairingKey,
      DENY_NAMESPACE,
      denyUpdateMessage(u.label, u.deny, u.issuedAt),
      u.signature,
    )
  ) {
    return `the line is not signed with the key of lead ${u.label} that this worker authorized: nothing changed`;
  }
  return undefined;
}

/**
 * Where a relay worker records, per lead, the time of the newest deny update it took: in the
 * admin-only pairing folder (administrators write, the relay account reads). An older or equal
 * line is refused, so a line seen once cannot be played again.
 */
export const denyUpdatesFile = (machine: string): string =>
  join(machine, 'pairing', 'deny-updates.json');

export function readDenyUpdates(machine: string): Record<string, number> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(denyUpdatesFile(machine), 'utf8'));
  } catch {
    return {};
  }
  const out: Record<string, number> = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (WORKER_LABEL_RE.test(k) && Number.isInteger(v)) out[k] = v as number;
    }
  }
  return out;
}

/** Records `issuedAt` for `label`, written whole and swapped in (run elevated). */
export function recordDenyUpdate(machine: string, label: string, issuedAt: number): void {
  const file = denyUpdatesFile(machine);
  const all = { ...readDenyUpdates(machine), [label]: issuedAt };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(tmp, file);
}
