import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type OwnerEnv, ownerConfigDir } from './config.js';
import { validLabel } from './limits.js';

/**
 * Claude accounts for crews, kept by Studio: one long-lived token per label from
 * `claude setup-token`, and one active label. The layout is a stable contract for credential
 * providers (README, "Credential provider"):
 *   <owner config>/tokens/            mode 0700, owned by the user
 *   <owner config>/tokens/<label>.json  mode 0600: {"label","token","addedAt"}
 *   <owner config>/tokens/active      mode 0600: the active label and a newline
 * Crews of the built-in way use `<owner config>/claude` as their Claude config dir, never ~/.claude.
 */
export const accountsDir = (o: OwnerEnv): string => join(ownerConfigDir(o), 'tokens');
export const accountFile = (o: OwnerEnv, label: string): string =>
  join(accountsDir(o), `${label}.json`);
const activeFile = (o: OwnerEnv): string => join(accountsDir(o), 'active');
export const crewClaudeDir = (o: OwnerEnv): string => join(ownerConfigDir(o), 'claude');

/** `claude setup-token` documents a one-year token; warn this long before. */
export const TOKEN_LIFETIME_DAYS = 365;
export const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

/** What `studio account setup-plugins` runs with CLAUDE_CONFIG_DIR set to the crew config dir. */
export const PLUGIN_COMMANDS: readonly (readonly string[])[] = [
  ['plugin', 'marketplace', 'add', 'https://github.com/obra/superpowers-marketplace.git'],
  ['plugin', 'marketplace', 'add', 'https://github.com/Besser-Sehen-Landshut/studio.git'],
  ['plugin', 'install', 'superpowers@superpowers-marketplace'],
  ['plugin', 'install', 'studio@studio-marketplace'],
];

/**
 * The format is not documented, and there is no documented way to check a token without a model
 * call: so only what fits an environment variable and a plausible length.
 */
export const looksLikeToken = (t: string): boolean =>
  t.length >= 20 && t.length <= 4096 && /^[^\s\p{Cc}]+$/u.test(t);

const uidOf = (o: OwnerEnv): number | undefined => o.uid ?? process.getuid?.();

function checkDir(o: OwnerEnv): void {
  const dir = accountsDir(o);
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== uidOf(o)) throw new Error(`${dir} has another owner`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} has a mode wider than 0700`);
}

/** A regular file of ours, mode 0600 or narrower, no link; its text. */
function readPrivate(o: OwnerEnv, file: string): string {
  // Opened without following a link and without blocking on a FIFO; checked on what was opened.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.uid !== uidOf(o)) throw new Error(`${file} has another owner`);
    if ((st.mode & 0o777 & ~0o600) !== 0) throw new Error(`${file} has a mode wider than 0600`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * `readPrivate`, with errors reduced to fixed text: a missing file gives `missing()`, a failed stat
 * or read only its error code. Nothing read from the file ever reaches a message.
 */
function readOrCode(o: OwnerEnv, file: string, missing: () => Error): string {
  try {
    return readPrivate(o, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw missing();
    if (typeof code === 'string') throw new Error(`${file} cannot be read (${code})`);
    throw e;
  }
}

function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    throw e;
  }
}

function ensureDir(o: OwnerEnv): void {
  mkdirSync(ownerConfigDir(o), { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(accountsDir(o)).isSymbolicLink()) {
      throw new Error(`refusing to use ${accountsDir(o)}: it is a symlink`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    mkdirSync(accountsDir(o), { mode: 0o700 });
  }
  chmodSync(accountsDir(o), 0o700);
  checkDir(o);
}

function checkLabel(label: string): void {
  if (!validLabel(label) || label.startsWith('.')) {
    throw new Error('the label must match ^[A-Za-z0-9._-]{1,64}$ and not start with a dot');
  }
}

export interface Account {
  label: string;
  token: string;
  addedAt: string;
}

function readAccount(o: OwnerEnv, label: string): Account {
  checkLabel(label);
  checkDir(o);
  const file = accountFile(o, label);
  const text = readOrCode(o, file, () => new Error(`no account ${label}`));
  // A parse error quotes the text it failed on, which may be the token: never pass it on.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const a = raw as Partial<Account> | null;
  if (
    a === null ||
    typeof a !== 'object' ||
    a.label !== label ||
    typeof a.token !== 'string' ||
    !looksLikeToken(a.token) ||
    typeof a.addedAt !== 'string' ||
    Number.isNaN(Date.parse(a.addedAt))
  ) {
    throw new Error(`${file} is not a valid account file`);
  }
  return { label, token: a.token, addedAt: a.addedAt };
}

/** Stores the token; the first account becomes the active one. Nothing is stored on a bad value. */
export function addAccount(o: OwnerEnv, label: string, token: string, now: Date): void {
  checkLabel(label);
  if (!looksLikeToken(token)) {
    throw new Error('that does not look like a token from claude setup-token; nothing stored');
  }
  ensureDir(o);
  writePrivate(
    accountFile(o, label),
    `${JSON.stringify({ label, token, addedAt: now.toISOString() })}\n`,
  );
  if (activeLabel(o) === undefined) setActiveLabel(o, label);
}

function listAccountNames(o: OwnerEnv): string[] {
  let names: string[];
  try {
    names = readdirSync(accountsDir(o));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw new Error(`${accountsDir(o)} cannot be read (${String(code)})`);
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

/** Labels and dates, never a token. */
export function listAccounts(o: OwnerEnv): { label: string; addedAt: string }[] {
  return listAccountNames(o).map((label) => {
    const { addedAt } = readAccount(o, label);
    return { label, addedAt };
  });
}

export function activeLabel(o: OwnerEnv): string | undefined {
  const absent = new Error('absent');
  let text: string;
  try {
    text = readOrCode(o, activeFile(o), () => absent);
  } catch (e) {
    if (e === absent) return undefined;
    throw e;
  }
  const label = text.trim();
  // The file's text is named nowhere: an odd value only says that it is odd.
  const known = listAccountNames(o);
  if (!validLabel(label) || label.startsWith('.') || !known.includes(label)) {
    throw new Error(`${activeFile(o)} names no stored account; run studio account use <label>`);
  }
  return label;
}

export function setActiveLabel(o: OwnerEnv, label: string): void {
  readAccount(o, label);
  writePrivate(activeFile(o), `${label}\n`);
}

export function removeAccount(o: OwnerEnv, label: string): void {
  readAccount(o, label);
  if (activeLabel(o) === label) unlinkSync(activeFile(o));
  unlinkSync(accountFile(o, label));
}

export function expiryState(
  addedAt: string,
  now: Date,
): { state: 'ok' | 'soon' | 'expired'; expiresAt: string } {
  const end = Date.parse(addedAt) + TOKEN_LIFETIME_DAYS * DAY_MS;
  const expiresAt = new Date(end).toISOString();
  if (now.getTime() >= end) return { state: 'expired', expiresAt };
  if (now.getTime() >= end - EXPIRY_WARNING_DAYS * DAY_MS) return { state: 'soon', expiresAt };
  return { state: 'ok', expiresAt };
}

/**
 * The account a launch uses when no credential provider is configured: undefined when there are no
 * accounts, else the active one. Anything odd refuses rather than falling back to another way.
 */
export function builtInAccount(o: OwnerEnv, now: Date): Account | undefined {
  if (listAccounts(o).length === 0) return undefined;
  const label = activeLabel(o);
  if (label === undefined) {
    throw new Error(
      'Claude accounts are set up but none is active; run studio account use <label>',
    );
  }
  const account = readAccount(o, label);
  if (expiryState(account.addedAt, now).state === 'expired') {
    throw new Error(
      `the token of account ${label} has expired; run claude setup-token, then studio account add ${label}`,
    );
  }
  return account;
}
