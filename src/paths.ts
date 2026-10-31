import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CREDENTIAL_PATHS,
  type OwnerEnv,
  PROTECTED_HOME_PATHS,
  pathKey,
  type StudioConfig,
  toolchainPathProblem,
  within,
  xdgDir,
} from './config.js';

const SLUG_RE = /^[A-Za-z0-9._-]+(__[A-Za-z0-9._-]+)?$/;

/** `primary_repo` as one path segment: `org/app` becomes `org__app`. */
export function repoSlug(primaryRepo: string): string {
  const slug = primaryRepo.replaceAll('/', '__');
  if (!SLUG_RE.test(slug) || /^\.+$/.test(slug)) {
    throw new Error(`primary_repo ${JSON.stringify(primaryRepo)} cannot name a state directory`);
  }
  return slug;
}

/**
 * Owner-level runtime state of a project, outside every repository tree:
 * `$XDG_STATE_HOME/studio/<slug>`, else `<home>/.local/state/studio/<slug>`. Holds clones, crew
 * homes, tmp dirs, settings, briefs, logs, guard contexts and crew.json. Only committed files
 * (studio.yaml, board.yaml, roles/, reports/) stay in the project's `.studio/`.
 */
export function stateRootFor(
  config: Pick<StudioConfig, 'primaryRepo'>,
  opts: OwnerEnv = {},
): string {
  const env = opts.env ?? process.env;
  const base = xdgDir(env, 'XDG_STATE_HOME') ?? join(opts.homedir ?? homedir(), '.local', 'state');
  return join(base, 'studio', repoSlug(config.primaryRepo));
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
