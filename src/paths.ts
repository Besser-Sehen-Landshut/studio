import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CREDENTIAL_PATHS,
  type OwnerEnv,
  PROTECTED_HOME_PATHS,
  pathKey,
  toolchainPathProblem,
  within,
  xdgDir,
} from './config.js';

/** Entries of the state root that a crew session must never write (besides its own clone). */
export const STATE_PROTECTED_DIRS = ['guard', 'settings', 'briefs', 'logs', 'homes', 'tmp'];
export const STATE_FILES = [
  'crew.json',
  'queue.json',
  'state.json',
  'metrics.jsonl',
  'guard.jsonl',
  'marker.json',
  'queue.json.lock',
  'queue.run.lock',
];

/** `$XDG_STATE_HOME/studio`, else `<home>/.local/state/studio`: the parent of every state root. */
export function stateBaseFor(opts: OwnerEnv = {}): string {
  const env = opts.env ?? process.env;
  const base = xdgDir(env, 'XDG_STATE_HOME') ?? join(opts.homedir ?? homedir(), '.local', 'state');
  return join(base, 'studio');
}

/** Real path of the project directory; fails closed when it does not exist. */
export function projectRealpath(projectDir: string): string {
  try {
    return realpathSync(projectDir);
  } catch {
    throw new Error(`project directory ${projectDir} does not exist`);
  }
}

/**
 * Directory name of a project's state root: the first 16 hex digits of sha256(realpath(project))
 * plus a readable suffix (the sanitised base name, at most 32 characters). It does not depend on
 * repository content, so a repo cannot steer two projects into the same state root.
 */
export function stateDirName(projectReal: string): string {
  const hash = createHash('sha256').update(projectReal).digest('hex').slice(0, 16);
  const suffix = basename(projectReal)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 32);
  return suffix ? `${hash}-${suffix}` : hash;
}

/** `p` with its longest existing prefix replaced by that prefix's real path. */
function realish(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/**
 * Owner-level runtime state of a project, outside every repository tree:
 * `<stateBaseFor()>/<stateDirName(realpath(projectDir))>`. Holds clones, crew homes, tmp dirs,
 * settings, briefs, logs, guard contexts, crew.json and marker.json. Only committed files
 * (studio.yaml, board.yaml, roles/, reports/) stay in the project's `.studio/`. Refused (before
 * any side effect) when the state root equals, lies inside or contains the project directory,
 * comparing literal and real spellings (case-insensitively on darwin).
 */
export function stateRootFor(projectDir: string, opts: OwnerEnv = {}): string {
  const real = projectRealpath(projectDir);
  const root = join(stateBaseFor(opts), stateDirName(real));
  const platform = opts.platform ?? process.platform;
  const roots = [resolve(root), realish(root)].map((p) => pathKey(p, platform));
  const projects = [resolve(projectDir), real].map((p) => pathKey(p, platform));
  if (roots.some((r) => projects.some((pr) => within(r, pr) || within(pr, r)))) {
    throw new Error(
      `state root ${root} must not equal, lie inside or contain the project directory ${projectDir}`,
    );
  }
  return root;
}

export interface StateMarker {
  projectRealpath: string;
  originUrl: string;
}

/**
 * Binds a state root to one project: on first use writes `<root>/marker.json` (0600, exclusive);
 * later it must name the same project real path and origin URL, else the launch is refused. A
 * state root that already has entries but no marker, a symlinked root or marker, or an unreadable
 * marker are refused as well.
 */
export function checkStateMarker(root: string, expected: StateMarker): void {
  const file = join(root, 'marker.json');
  if (isLink(root)) throw new Error(`refusing to use state root ${root}: it is a symlink`);
  const kind = isLink(file);
  if (kind === undefined) {
    if (existsSync(root) && readdirSync(root).length > 0) {
      throw new Error(`state root ${root} has no marker.json; refusing to adopt it`);
    }
    ensureStateDir(root, root);
    try {
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } else if (kind) {
    throw new Error(`refusing to use ${file}: it is a symlink`);
  }
  let found: Partial<StateMarker> | null;
  try {
    found = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateMarker> | null;
  } catch {
    throw new Error(`state root marker ${file} is unreadable`);
  }
  if (
    found?.projectRealpath !== expected.projectRealpath ||
    found?.originUrl !== expected.originUrl
  ) {
    throw new Error(
      `state root marker ${file} belongs to another project or origin; refusing to launch`,
    );
  }
}

/**
 * URL of `[remote "origin"]` in a clone's `.git/config`, read as a plain file (nothing runs in a
 * crew clone). Undefined when `.git` or the config is a symlink or not a plain directory/file, or
 * when the entry is missing, repeated or not a simple unquoted value.
 */
export function cloneOriginUrl(clone: string): string | undefined {
  try {
    if (!lstatSync(join(clone, '.git')).isDirectory()) return undefined;
    const cfg = join(clone, '.git', 'config');
    if (!lstatSync(cfg).isFile()) return undefined;
    let inOrigin = false;
    const urls: string[] = [];
    for (const raw of readFileSync(cfg, 'utf8').split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
      if (line.startsWith('[')) {
        // Section names are case-insensitive, the subsection name is not.
        inOrigin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line) && line.includes('"origin"');
        continue;
      }
      if (!inOrigin) continue;
      const m = /^url\s*=\s*(.*)$/i.exec(line);
      if (!m) continue;
      const value = (m[1] as string).trim();
      if (value === '' || /["\\#;]/.test(value)) return undefined;
      urls.push(value);
    }
    return urls.length === 1 ? urls[0] : undefined;
  } catch {
    return undefined;
  }
}

const isLink = (p: string): boolean | undefined => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return undefined; // does not exist
  }
};

/** Path segments of `target` below `root`; throws when `target` is not below `root`. */
function segmentsBelow(root: string, target: string): string[] {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return [];
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to use ${target}: it is not inside the state root ${root}`);
  }
  return rel.split(sep);
}

/**
 * Before a write or removal at `target`: no path component between the state root and the parent
 * of `target` may be a symlink, and the real parent must lie under the real state root. `target`
 * itself is the caller's business (see `removeStateEntry`).
 */
export function assertStatePath(root: string, target: string): void {
  const segs = segmentsBelow(root, target);
  let cur = resolve(root);
  for (const seg of segs.slice(0, -1)) {
    cur = join(cur, seg);
    if (isLink(cur)) throw new Error(`refusing to use ${target}: ${cur} is a symlink`);
  }
  if (segs.length === 0) return;
  let realParent: string;
  try {
    realParent = realpathSync(dirname(resolve(target)));
  } catch {
    return; // parent does not exist yet: nothing behind it can be redirected
  }
  if (!within(realParent, realpathSync(root))) {
    throw new Error(`refusing to use ${target}: it resolves outside the state root`);
  }
}

/** Creates `dir` (inside the state root) and every missing directory on the way, mode 0700. */
export function ensureStateDir(root: string, dir: string): string {
  if (isLink(root)) throw new Error(`refusing to use state root ${root}: it is a symlink`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  let cur = resolve(root);
  for (const seg of segmentsBelow(root, dir)) {
    cur = join(cur, seg);
    assertStatePath(root, cur);
    const link = isLink(cur);
    if (link) throw new Error(`refusing to use ${cur}: it is a symlink`);
    if (link === undefined) mkdirSync(cur, { mode: 0o700 });
    chmodSync(cur, 0o700);
  }
  return cur;
}

/** Removes `target` inside the state root; a symlink is unlinked, never followed. */
export function removeStateEntry(root: string, target: string): void {
  assertStatePath(root, target);
  const link = isLink(target);
  if (link) unlinkSync(target);
  else if (link === false) rmSync(target, { recursive: true, force: true });
}

let tmpCounter = 0;

/** Atomic write (temp + rename, mode 0600) of a file inside the state root. */
export function writeStateFile(root: string, file: string, content: string): void {
  ensureStateDir(root, dirname(file));
  assertStatePath(root, file);
  const tmp = `${file}.${process.pid}.${tmpCounter++}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
}

export interface StateLock {
  /** Removes the lock file if it still is this holder's. */
  release(): void;
  /** Records that the holder is still working (no-op once the lock is no longer its own). */
  heartbeat(now: Date): void;
  /** Set when another holder's stale lock was broken: why it counted as stale. */
  broke?: string;
}

interface LockBody {
  token?: unknown;
  pid?: unknown;
  startedAt?: unknown;
  heartbeat?: unknown;
}

function readLockBody(file: string): LockBody | undefined {
  try {
    if (!lstatSync(file).isFile()) return undefined;
    const body = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return body !== null && typeof body === 'object' ? (body as LockBody) : undefined;
  } catch {
    return undefined;
  }
}

const tokenOf = (file: string): unknown => readLockBody(file)?.token;

/** Whether a process with this pid exists (EPERM: exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Why an existing lock is stale, or undefined while its holder counts as alive. */
function staleReason(
  body: LockBody | undefined,
  mtimeMs: number,
  now: Date,
  heartbeatStaleMs: number,
): string | undefined {
  const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
  if (body === undefined) {
    // Possibly being written right now: only an old unreadable lock is stale.
    const age = now.getTime() - mtimeMs;
    return age >= heartbeatStaleMs ? `unreadable lock, ${minutes(age)} old` : undefined;
  }
  if (typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0) {
    if (!pidAlive(body.pid)) return `holder pid ${body.pid} is not running`;
  }
  const beat = typeof body.heartbeat === 'string' ? Date.parse(body.heartbeat) : Number.NaN;
  const age = now.getTime() - (Number.isNaN(beat) ? mtimeMs : beat);
  return age >= heartbeatStaleMs ? `last heartbeat ${minutes(age)} ago` : undefined;
}

/**
 * Exclusive lock file `<root>/<name>` holding `{pid, startedAt, heartbeat, token}`, created with
 * O_CREAT|O_EXCL|O_NOFOLLOW (an existing entry, a symlink included, is never followed or
 * overwritten). An existing lock is stale only when its pid is not running or its heartbeat is
 * older than `heartbeatStaleMs`; then it is broken (moved aside, checked, removed) and the reason
 * reported through `broke`. Otherwise undefined is returned. Anything at the lock path that is not
 * a regular file is refused. A lock that vanishes between the create and the check is retried.
 */
export function acquireStateLock(
  root: string,
  name: string,
  opts: {
    now: Date;
    heartbeatStaleMs: number;
    lstat?: (p: string) => { isFile(): boolean; mtimeMs: number };
  },
): StateLock | undefined {
  const file = join(root, name);
  ensureStateDir(root, dirname(file));
  assertStatePath(root, file);
  const lstat = opts.lstat ?? lstatSync;
  const token = randomBytes(16).toString('hex');
  const startedAt = opts.now.toISOString();
  const body = (beat: Date) =>
    `${JSON.stringify({ pid: process.pid, startedAt, heartbeat: beat.toISOString(), token })}\n`;
  const create = (): boolean => {
    let fd: number;
    try {
      fd = openSync(
        file,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    try {
      writeSync(fd, body(opts.now));
    } finally {
      closeSync(fd);
    }
    return true;
  };
  const lock = (broke?: string): StateLock => ({
    release: () => {
      if (tokenOf(file) === token) unlinkSync(file);
    },
    heartbeat: (now: Date) => {
      if (tokenOf(file) === token) writeStateFile(root, file, body(now));
    },
    ...(broke === undefined ? {} : { broke }),
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (create()) return lock();
    let st: { isFile(): boolean; mtimeMs: number };
    try {
      st = lstat(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // released meanwhile
      throw err;
    }
    if (!st.isFile()) throw new Error(`refusing lock ${file}: it is not a regular file`);
    const existing = readLockBody(file);
    const reason = staleReason(existing, st.mtimeMs, opts.now, opts.heartbeatStaleMs);
    if (reason === undefined) return undefined;
    // Move the stale lock aside first; if what was moved is not the stale file any more (another
    // process broke it and took the lock in between), put it back and report the lock as held.
    const aside = `${file}.${randomBytes(4).toString('hex')}.stale`;
    try {
      renameSync(file, aside);
    } catch {
      continue;
    }
    if (tokenOf(aside) !== existing?.token) {
      renameSync(aside, file);
      return undefined;
    }
    unlinkSync(aside);
    return create() ? lock(reason) : undefined;
  }
  return undefined;
}

/** Literal and (when it exists) real variant of a path, case-folded for comparison. */
function keys(p: string, platform: NodeJS.Platform): string[] {
  const out = [pathKey(resolve(p), platform)];
  try {
    out.push(pathKey(realpathSync(p), platform));
  } catch {
    // does not exist: the literal path is all there is
  }
  return out;
}

export interface ToolchainContext {
  home: string;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  projectDir: string;
  stateRoot: string;
  /** Credential locations outside the home list (GH_CONFIG_DIR, XDG entries). */
  extraCredentialPaths?: string[];
}

/**
 * Checks crew toolchain read paths against the real filesystem and returns their real paths (what
 * goes into `sandbox.filesystem.allowRead`). Fails closed: the path must be absolute and exist;
 * every variant of it (literal, realpath) is compared, case-insensitively on darwin, with every
 * variant of the protected locations. Refused: the home or a parent of it; anything equal to,
 * inside or containing a credential store, `<home>/.claude` or CLAUDE_CONFIG_DIR; anything equal
 * to, inside or containing the project directory or the state root.
 */
export function canonicalToolchainPaths(paths: string[], ctx: ToolchainContext): string[] {
  const platform = ctx.platform ?? process.platform;
  const homes = keys(ctx.home, platform);
  const homeDirs = [ctx.home];
  try {
    homeDirs.push(realpathSync(ctx.home));
  } catch {
    // no real home on disk (tests): the literal one is checked
  }
  const sealed = [
    ...homeDirs.flatMap((h) => PROTECTED_HOME_PATHS.map((c) => join(h, c))),
    ...(ctx.env.CLAUDE_CONFIG_DIR ? [ctx.env.CLAUDE_CONFIG_DIR] : []),
    ...(ctx.extraCredentialPaths ?? []),
  ].flatMap((p) => keys(p, platform));
  const fenced = [ctx.projectDir, ctx.stateRoot].flatMap((p) => keys(p, platform));
  return paths.map((path) => {
    const fail = (why: string): never => {
      throw new Error(`crew_toolchain_paths: ${path}: ${why}`);
    };
    const lexical = toolchainPathProblem(path, ctx.home, ctx.extraCredentialPaths, platform);
    if (lexical) fail(lexical);
    let real = '';
    try {
      real = realpathSync(path);
    } catch {
      fail('does not exist');
    }
    const vs = [pathKey(resolve(path), platform), pathKey(real, platform)];
    for (const v of vs) {
      if (homes.some((h) => within(h, v))) fail('must not be the home directory or a parent of it');
      const cred = sealed.find((c) => within(v, c) || within(c, v));
      if (cred) fail(`must not equal, contain or lie inside the protected location ${cred}`);
      if (fenced.some((f) => within(v, f) || within(f, v))) {
        fail('must not equal, contain or lie inside the project directory or the state root');
      }
    }
    return real;
  });
}

/** Credential locations of the launcher (real home list plus env extras). */
export function credentialLocations(
  home: string,
  env: Record<string, string | undefined>,
): { all: string[]; extra: string[] } {
  const extra: string[] = [];
  if (env.GH_CONFIG_DIR) extra.push(env.GH_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) {
    extra.push(join(env.XDG_CONFIG_HOME, 'gh'), join(env.XDG_CONFIG_HOME, 'git', 'credentials'));
  }
  return { all: [...CREDENTIAL_PATHS.map((p) => join(home, p)), ...extra], extra };
}
