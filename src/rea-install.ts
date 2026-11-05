/**
 * Where the REA server comes from and where it runs, all of it in places Studio owns and crews can
 * neither read nor write:
 *
 * - The package is installed once per pinned version below the owner state root
 *   (`<owner>/rea/<version>/`), by `studio research install`, never with `npx` and never in a crew's
 *   clone. The install records the registry's `dist.integrity` of the tarball and refuses when the
 *   lockfile npm wrote names another; every launch checks the record, the lockfile and the files'
 *   owner and mode again.
 * - Each run gets its own folder below the project state root (`<state>/rea/<item>/`) for the
 *   server's HOME, TMPDIR and XDG directories and a neutral working directory. REA copies artifacts
 *   there (an APK to `$TMPDIR`, for example), so the folder is denied to the crew's shell (sandbox)
 *   and file tools (guard) and removed when the run ends.
 * - The classes the owner opens for an item (`studio research allow`) are kept in the project state
 *   root too, never on the board or in the repository.
 */

import { lstatSync, readFileSync, renameSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { assertStatePath, ensureStateDir, removeStateEntry, writeStateFile } from './paths.js';
import type { Ports } from './ports.js';
import { REA_CLASS_NAMES, REA_PACKAGE, REA_VERSION_RE, type ReaClass, reaEnvKeyOk } from './rea.js';

/** The record an install leaves beside the package; a launch trusts nothing else. */
export const REA_RECORD = 'studio-rea.json';
const REGISTRY_TARBALL = (v: string) =>
  `https://registry.npmjs.org/${REA_PACKAGE}/-/${REA_PACKAGE}-${v}.tgz`;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
const NPM_TIMEOUT_MS = 600_000;

export const reaInstallDir = (ownerRoot: string, version: string): string => {
  if (!REA_VERSION_RE.test(version)) throw new Error(`rea_version ${version} is not exact`);
  return join(ownerRoot, 'rea', version);
};

/** The environment npm runs with for an install: no user or global npmrc, no token, no project. */
function npmEnv(ownerRoot: string, home: string, path: string): Record<string, string> {
  return {
    PATH: path,
    HOME: home,
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: '/dev/null',
    npm_config_cache: join(ownerRoot, 'rea', 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

/**
 * Installs the pinned version into the owner state root and records the registry's integrity hash.
 * A staging directory is filled first and used only when npm's lockfile names the same tarball and
 * integrity the registry reported. Then the earlier install is moved aside, the new one into place
 * and verified as a launch would; only then is the earlier one deleted. If that verification fails,
 * the earlier install comes back. Anything that fails before leaves the earlier install untouched.
 *
 * No install script runs (`--ignore-scripts`) and no optional dependency is installed
 * (`--omit=optional`): of rea-agents 6.7.0 only `frida` (optional, debug class) has an install
 * script, which downloads a native binary nothing pins, and the prebuilt `@lydell/node-pty`
 * binaries (optional, used only by process capture, observe class) come the same way. The static
 * tools load neither: both are imported lazily by the tools that need them. The debug and observe
 * tools that need them fail until a later, separate opt-in installs them with a pinned binary hash.
 */
export async function installRea(o: {
  ownerRoot: string;
  version: string;
  npm: NonNullable<Ports['npm']>;
  path: string;
  now: Date;
}): Promise<{ dir: string; integrity: string }> {
  const dir = reaInstallDir(o.ownerRoot, o.version);
  const staging = `${dir}.staging`;
  removeStateEntry(o.ownerRoot, staging);
  ensureStateDir(o.ownerRoot, join(staging, '.home'));
  const env = npmEnv(o.ownerRoot, join(staging, '.home'), o.path);
  try {
    const view = await o.npm.run(
      ['view', `${REA_PACKAGE}@${o.version}`, 'dist.integrity', '--json'],
      env,
      staging,
      { timeoutMs: NPM_TIMEOUT_MS },
    );
    if (view.code !== 0) throw new Error(`npm view failed (exit ${view.code})`);
    let integrity: unknown;
    try {
      integrity = JSON.parse(view.stdout);
    } catch {
      integrity = undefined;
    }
    if (typeof integrity !== 'string' || !INTEGRITY_RE.test(integrity)) {
      throw new Error('the registry gave no sha512 integrity for the pinned version');
    }
    writeStateFile(
      o.ownerRoot,
      join(staging, 'package.json'),
      `${JSON.stringify({ private: true, dependencies: { [REA_PACKAGE]: o.version } }, null, 2)}\n`,
    );
    const install = await o.npm.run(
      [
        'install',
        '--save-exact',
        '--package-lock=true',
        '--ignore-scripts',
        '--omit=optional',
        '--no-audit',
        '--no-fund',
      ],
      env,
      staging,
      { timeoutMs: NPM_TIMEOUT_MS },
    );
    if (install.code !== 0) throw new Error(`npm install failed (exit ${install.code})`);
    const locked = lockedPackage(staging);
    if (locked.version !== o.version) throw new Error('npm installed another version');
    if (locked.resolved !== REGISTRY_TARBALL(o.version)) {
      throw new Error('npm resolved the package from somewhere other than the npm registry');
    }
    if (locked.integrity !== integrity) {
      throw new Error("the installed tarball's integrity is not the one the registry reported");
    }
    writeStateFile(
      o.ownerRoot,
      join(staging, REA_RECORD),
      `${JSON.stringify({ package: REA_PACKAGE, version: o.version, integrity, installedAt: o.now.toISOString() }, null, 2)}\n`,
    );
    removeStateEntry(o.ownerRoot, join(staging, '.home'));
    // Swap: the earlier install aside, the new one in, verified as a launch would; back on failure.
    const previous = `${dir}.previous`;
    removeStateEntry(o.ownerRoot, previous);
    assertStatePath(o.ownerRoot, dir);
    const hadPrevious = existsNoFollow(dir);
    if (hadPrevious) renameSync(dir, previous);
    renameSync(staging, dir);
    try {
      verifyReaInstall(o.ownerRoot, o.version);
    } catch (e) {
      removeStateEntry(o.ownerRoot, dir);
      if (hadPrevious) renameSync(previous, dir);
      throw e;
    }
    removeStateEntry(o.ownerRoot, previous);
    return { dir, integrity };
  } finally {
    removeStateEntry(o.ownerRoot, staging);
  }
}

function lockedPackage(dir: string): {
  version?: unknown;
  resolved?: unknown;
  integrity?: unknown;
} {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: unknown; resolved?: unknown; integrity?: unknown }>;
  };
  return lock.packages?.[`node_modules/${REA_PACKAGE}`] ?? {};
}

const existsNoFollow = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** A file or directory of the install: no link, owned by this user, writable by nobody else. */
function ownedPlain(path: string, kind: 'file' | 'dir', uid: number | undefined): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile())
    throw new Error(`${path} is not a ${kind}`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} belongs to another user`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${path} is writable by group or others`);
}

export interface ReaInstall {
  dir: string;
  /** Absolute path of the package's own CLI (its `bin`), which the wrapper starts with `mcp`. */
  entry: string;
  integrity: string;
}

/**
 * The install a launch may use, or an Error that says what to do. Checks the record against the pin,
 * the lockfile against the record and the registry URL, the installed version, and that no part on
 * the way to the entry is a link or writable by anyone but the owner.
 */
export function verifyReaInstall(
  ownerRoot: string,
  version: string,
  uid: number | undefined = process.getuid?.(),
): ReaInstall {
  const dir = reaInstallDir(ownerRoot, version);
  const hint = `run studio research install in a terminal to install ${REA_PACKAGE}@${version}`;
  try {
    ownedPlain(dir, 'dir', uid);
    ownedPlain(join(dir, REA_RECORD), 'file', uid);
    ownedPlain(join(dir, 'package-lock.json'), 'file', uid);
    const record = JSON.parse(readFileSync(join(dir, REA_RECORD), 'utf8')) as {
      package?: unknown;
      version?: unknown;
      integrity?: unknown;
    };
    if (record.package !== REA_PACKAGE || record.version !== version) {
      throw new Error('the install record names another package or version');
    }
    if (typeof record.integrity !== 'string' || !INTEGRITY_RE.test(record.integrity)) {
      throw new Error('the install record has no integrity');
    }
    const locked = lockedPackage(dir);
    if (
      locked.version !== version ||
      locked.integrity !== record.integrity ||
      locked.resolved !== REGISTRY_TARBALL(version)
    ) {
      throw new Error('the lockfile does not match the install record');
    }
    // Installed without optional dependencies: a native part there was not pinned by Studio.
    if (existsNoFollow(join(dir, 'node_modules', 'frida'))) {
      throw new Error('the install holds the optional native dependency frida');
    }
    const pkgDir = join(dir, 'node_modules', REA_PACKAGE);
    ownedPlain(join(dir, 'node_modules'), 'dir', uid);
    ownedPlain(pkgDir, 'dir', uid);
    ownedPlain(join(pkgDir, 'package.json'), 'file', uid);
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
      bin?: unknown;
    };
    if (pkg.name !== REA_PACKAGE || pkg.version !== version) {
      throw new Error('the installed package is another one');
    }
    const bin =
      typeof pkg.bin === 'string'
        ? pkg.bin
        : (pkg.bin as Record<string, unknown> | null)?.[REA_PACKAGE];
    if (
      typeof bin !== 'string' ||
      isAbsolute(bin) ||
      normalize(bin).split(/[\\/]/).includes('..')
    ) {
      throw new Error('the package names no usable command');
    }
    const parts = normalize(bin)
      .split(/[\\/]/)
      .filter((p) => p !== '' && p !== '.');
    let at = pkgDir;
    for (const [i, part] of parts.entries()) {
      at = join(at, part);
      ownedPlain(at, i === parts.length - 1 ? 'file' : 'dir', uid);
    }
    return { dir, entry: at, integrity: record.integrity };
  } catch (e) {
    const why =
      (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not installed' : (e as Error).message;
    throw new Error(`REA ${REA_PACKAGE}@${version}: ${why}; ${hint}`);
  }
}

/** The per-run folder of a researcher's REA server and what lies in it. */
export interface ReaRun {
  root: string;
  home: string;
  tmp: string;
  cache: string;
  config: string;
  data: string;
  state: string;
  /** The server's working directory: empty, so a relative path resolves to nothing of the crew's. */
  cwd: string;
}

export function reaRunDirs(stateRoot: string, id: string): ReaRun {
  const root = join(stateRoot, 'rea', id);
  return {
    root,
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    cache: join(root, 'cache'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    cwd: join(root, 'cwd'),
  };
}

/** A fresh, empty per-run folder (mode 0700); what an earlier run left is removed first. */
export function prepareReaRun(stateRoot: string, id: string): ReaRun {
  const run = reaRunDirs(stateRoot, id);
  removeStateEntry(stateRoot, run.root);
  for (const d of [run.home, run.tmp, run.cache, run.config, run.data, run.state, run.cwd]) {
    ensureStateDir(stateRoot, d);
  }
  return run;
}

/** Removes the per-run folder of an item's server, with any artifact copies REA left in it. */
export function removeReaRun(stateRoot: string, id: string): void {
  removeStateEntry(stateRoot, reaRunDirs(stateRoot, id).root);
}

/** What bin/studio-rea-server.mjs reads: nothing of the crew's environment reaches the server. */
export interface ReaSpec {
  entry: string;
  run: Omit<ReaRun, 'root'>;
  path: string;
  lang?: string;
  env: Record<string, string>;
}

/** Writes the wrapper's spec file into the state root's settings and returns its path. */
export function writeReaSpec(
  stateRoot: string,
  id: string,
  o: { entry: string; run: ReaRun; path: string; lang?: string; env: Record<string, string> },
): string {
  for (const k of Object.keys(o.env)) {
    if (!reaEnvKeyOk(k)) throw new Error(`rea_env: ${k} is not a name REA reads`);
  }
  const { root: _root, ...run } = o.run;
  const spec: ReaSpec = {
    entry: o.entry,
    run,
    path: o.path,
    ...(o.lang === undefined ? {} : { lang: o.lang }),
    env: { ...o.env },
  };
  const file = join(stateRoot, 'settings', `${id}.rea.json`);
  writeStateFile(stateRoot, file, `${JSON.stringify(spec, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------- classes the owner opened

export const REA_ALLOW_FILE = 'rea-allow.json';

/** The classes the owner opened, per item id; a file that cannot be read opens nothing. */
export function readReaAllow(stateRoot: string): Record<string, ReaClass[]> {
  let raw: unknown;
  try {
    const file = join(stateRoot, REA_ALLOW_FILE);
    if (lstatSync(file).isSymbolicLink()) return {};
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const out: Record<string, ReaClass[]> = Object.create(null);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, classes] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Z]+-\d+$/.test(id) || !Array.isArray(classes)) continue;
    out[id] = classes.filter((c): c is ReaClass => (REA_CLASS_NAMES as unknown[]).includes(c));
  }
  return out;
}

export const itemReaClasses = (stateRoot: string, id: string): ReaClass[] =>
  readReaAllow(stateRoot)[id] ?? [];

/** Opens (`add`) or closes classes for an item; returns what the item has open afterwards. */
export function updateReaAllow(
  stateRoot: string,
  id: string,
  change: { add?: readonly ReaClass[]; remove?: readonly ReaClass[] | 'all' },
): ReaClass[] {
  const all = readReaAllow(stateRoot);
  const now = new Set(all[id] ?? []);
  for (const c of change.add ?? []) now.add(c);
  if (change.remove === 'all') now.clear();
  else for (const c of change.remove ?? []) now.delete(c);
  const next = REA_CLASS_NAMES.filter((c) => now.has(c));
  if (next.length === 0) delete all[id];
  else all[id] = next;
  writeStateFile(stateRoot, join(stateRoot, REA_ALLOW_FILE), `${JSON.stringify(all, null, 2)}\n`);
  return next;
}
