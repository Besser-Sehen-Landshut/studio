import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { cacheLimits, type OwnerConfig } from './config.js';
import { HeldError } from './held.js';
import {
  acquireStateLock,
  assertStatePath,
  ensureStateDir,
  projectStateRoots,
  removeStateEntry,
  writeStateFile,
} from './paths.js';
import type { Exec, Ports } from './ports.js';
import { LAUNCH_LOCK, LAUNCH_LOCK_STALE_MS } from './usage.js';

/**
 * The shared build cache of a project. Crews start from a fresh clone and a fresh HOME, so every
 * crew downloads its crates and packages and builds everything from scratch. The cache keeps a warm
 * seed per project, built by the owner side from the default branch:
 *
 *   <state root>/cache/seeds/      what crews start from: read-only for them (sandbox allowRead,
 *                                  never allowWrite; a guard-protected path)
 *   <state root>/cache/cache.json  when it was built, from which commit, how large, last use
 *   <state root>/cache-build/      the owner's own clone and build dirs; crews cannot read it
 *
 * At launch Studio copies each seed into the crew's own writable place with a copy-on-write copy
 * (`cp -c`, APFS clonefile, on macOS; `cp --reflink=always` on Linux): the crew writes only its copy,
 * never the cache. Without copy-on-write a seed would be a full copy per crew, so the cache is off
 * on such a file system. Hard links are never used: a crew could change the shared file through one.
 */

export const CACHE_DIR = 'cache';
export const CACHE_BUILD_DIR = 'cache-build';
/** In the state root: one refresh of a project at a time. */
export const CACHE_LOCK = 'cache.lock';
/** In the owner root: when the size cleanup last ran. */
export const CACHE_GC_FILE = 'cache-gc.json';

export const SEEDS = ['cargo-target', 'cargo-registry', 'cargo-git', 'pnpm-store'] as const;
export type Seed = (typeof SEEDS)[number];

const META = 'cache.json';
const DAY_MS = 86_400_000;
const REFRESH_EVERY_MS = 7 * DAY_MS;
const SEED_TIMEOUT_MS = 5 * 60_000;
const COPY_PROBE = 'cow-probe';

export interface CacheMeta {
  refreshedAt: string;
  sha: string;
  seeds: Seed[];
  sizeBytes: number;
  lastUsedAt?: string;
}

export const cacheDir = (stateRoot: string): string => join(stateRoot, CACHE_DIR);
export const cacheBuildDir = (stateRoot: string): string => join(stateRoot, CACHE_BUILD_DIR);
const seedsDir = (stateRoot: string): string => join(cacheDir(stateRoot), 'seeds');

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function lstatOrUndefined(p: string): Stats | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

const isRealDir = (p: string): boolean => lstatOrUndefined(p)?.isDirectory() === true;
const isRealFile = (p: string): boolean => lstatOrUndefined(p)?.isFile() === true;

/** The cache's record; undefined when there is no cache or the record is not one. */
export function readCacheMeta(stateRoot: string): CacheMeta | undefined {
  const file = join(cacheDir(stateRoot), META);
  if (!isRealDir(seedsDir(stateRoot)) || !isRealFile(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(raw) || typeof raw.refreshedAt !== 'string' || typeof raw.sha !== 'string') {
    return undefined;
  }
  if (Number.isNaN(Date.parse(raw.refreshedAt)) || !Array.isArray(raw.seeds)) return undefined;
  const seeds = raw.seeds.filter((s): s is Seed => (SEEDS as readonly unknown[]).includes(s));
  const lastUsedAt =
    typeof raw.lastUsedAt === 'string' && !Number.isNaN(Date.parse(raw.lastUsedAt))
      ? raw.lastUsedAt
      : undefined;
  return {
    refreshedAt: raw.refreshedAt,
    sha: raw.sha,
    seeds,
    sizeBytes: typeof raw.sizeBytes === 'number' && raw.sizeBytes >= 0 ? raw.sizeBytes : 0,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  };
}

function writeMeta(stateRoot: string, meta: CacheMeta): void {
  writeStateFile(stateRoot, join(cacheDir(stateRoot), META), `${JSON.stringify(meta, null, 2)}\n`);
}

/** The arguments of a copy-on-write `cp`, or undefined where Studio knows none. */
export function cowCopyArgs(
  platform: NodeJS.Platform,
  src: string,
  dst: string,
): string[] | undefined {
  if (platform === 'darwin') return ['-c', '-R', '-p', src, dst];
  if (platform === 'linux') return ['-R', '-p', '--reflink=always', src, dst];
  return undefined;
}

/** A copy-on-write copy of `src` to `dst` (which must not exist); false, and nothing left, on failure. */
async function cowCopy(
  exec: Exec,
  root: string,
  platform: NodeJS.Platform,
  src: string,
  dst: string,
  timeoutMs: number,
): Promise<boolean> {
  const args = cowCopyArgs(platform, src, dst);
  if (args === undefined || lstatOrUndefined(dst) !== undefined) return false;
  const r = await exec.run('cp', args, { cwd: root, env: { PATH: '/bin:/usr/bin' }, timeoutMs });
  if (r.code === 0) return true;
  removeStateEntry(root, dst);
  return false;
}

/** Bytes on disk below `path`, links not followed. A copy-on-write copy counts in full. */
export function diskBytes(path: string): number {
  const st = lstatOrUndefined(path);
  if (st === undefined) return 0;
  const own = typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
  if (!st.isDirectory()) return own;
  let total = own;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return total;
  }
  for (const name of names) total += diskBytes(join(path, name));
  return total;
}

// ---- At launch ---------------------------------------------------------------------------------

export interface SeedResult {
  /** The cache dir to open read-only in the crew's sandbox; absent without a cache. */
  cacheDir?: string;
  seeded: Seed[];
  /** Environment for the crew's own copies. */
  env: Record<string, string>;
}

/**
 * Copies the cache's seeds into a crew's own places, before the crew runs: the Rust target dir into
 * a fresh clone (never into a clone a crew has run in, which it controls), the cargo registry and
 * the pnpm store into the crew HOME, which the launch has just recreated. A seed that cannot be
 * copied is skipped: the crew builds without it. Runs under the launch lock, which the cleanup and a
 * refresh's swap take too, so a seed is never read while it is replaced.
 */
export async function seedCrew(o: {
  stateRoot: string;
  clone: string;
  homeDir: string;
  freshClone: boolean;
  ports: Ports;
  platform: NodeJS.Platform;
}): Promise<SeedResult> {
  const meta = readCacheMeta(o.stateRoot);
  const exec = o.ports.exec;
  if (meta === undefined || exec === undefined) return { seeded: [], env: {} };
  const seeds = seedsDir(o.stateRoot);
  const seeded: Seed[] = [];
  const env: Record<string, string> = {};
  const targets: Record<Seed, string | undefined> = {
    'cargo-target':
      o.freshClone && isRealFile(join(o.clone, 'Cargo.toml')) ? join(o.clone, 'target') : undefined,
    'cargo-registry': join(o.homeDir, '.cargo', 'registry'),
    'cargo-git': join(o.homeDir, '.cargo', 'git'),
    'pnpm-store': join(o.homeDir, '.pnpm-store'),
  };
  for (const seed of meta.seeds) {
    const dst = targets[seed];
    const src = join(seeds, seed);
    if (dst === undefined || !isRealDir(src)) continue;
    assertStatePath(o.stateRoot, dst);
    if (seed === 'cargo-registry' || seed === 'cargo-git') {
      ensureStateDir(o.stateRoot, join(o.homeDir, '.cargo'));
    }
    if (await cowCopy(exec, o.stateRoot, o.platform, src, dst, SEED_TIMEOUT_MS)) {
      seeded.push(seed);
      // pnpm reads PNPM_CONFIG_* over pnpm-workspace.yaml: the crew's own store, seeded.
      if (seed === 'pnpm-store') env.PNPM_CONFIG_STORE_DIR = dst;
    }
  }
  try {
    writeMeta(o.stateRoot, { ...meta, lastUsedAt: o.ports.clock.now().toISOString() });
  } catch {
    // The last use only orders the cleanup; a failed write must not fail the launch.
  }
  return { cacheDir: cacheDir(o.stateRoot), seeded, env };
}

// ---- Refresh (owner side) ----------------------------------------------------------------------

export interface RefreshResult {
  sha: string;
  seeds: Seed[];
  sizeBytes: number;
  steps: string[];
}

/** What the build of a seed runs, in the owner's build clone. */
export function refreshSteps(src: string): { name: string; cmd: string; args: string[] }[] {
  const steps: { name: string; cmd: string; args: string[] }[] = [];
  if (isRealFile(join(src, 'Cargo.toml'))) {
    const locked = isRealFile(join(src, 'Cargo.lock')) ? ['--locked'] : [];
    steps.push({
      name: 'cargo build',
      cmd: 'cargo',
      args: ['build', '--workspace', '--all-targets', ...locked],
    });
  }
  if (isRealFile(join(src, 'pnpm-lock.yaml'))) {
    // No install scripts: the store needs none, and they would run as the owner.
    steps.push({
      name: 'pnpm install',
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile', '--ignore-scripts'],
    });
  }
  return steps;
}

/**
 * Builds the seeds from the project's `origin/main` in the owner's build clone (never a crew clone),
 * within `cache.refresh_timeout_min`, then puts them in place in one swap under the launch lock.
 * A failed step publishes nothing; the old seeds stay. Build scripts (`build.rs`) run as the owner,
 * with a HOME and CARGO_HOME of the build dir and no token; pnpm runs without install scripts.
 */
export async function refreshCache(o: {
  stateRoot: string;
  ownerRoot: string;
  originUrl: string;
  ownerConfig: OwnerConfig;
  ports: Ports;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}): Promise<RefreshResult> {
  const exec = o.ports.exec;
  if (exec === undefined) throw new Error('the build cache needs the exec port');
  if (cowCopyArgs(o.platform, 'a', 'b') === undefined) {
    throw new Error(`the build cache is not supported on ${o.platform}`);
  }
  const now = () => o.ports.clock.now();
  const lock = acquireStateLock(o.stateRoot, CACHE_LOCK, {
    now: now(),
    heartbeatStaleMs: cacheLimits(o.ownerConfig).refreshTimeoutMin * 60_000 + 10 * 60_000,
  });
  if (!lock) throw new HeldError('a cache refresh of this project is running (cache.lock)');
  const build = ensureStateDir(o.stateRoot, cacheBuildDir(o.stateRoot));
  const cache = ensureStateDir(o.stateRoot, cacheDir(o.stateRoot));
  const staging = join(cache, `.staging-${randomBytes(4).toString('hex')}`);
  try {
    const deadline = now().getTime() + cacheLimits(o.ownerConfig).refreshTimeoutMin * 60_000;
    const left = () => Math.max(1000, deadline - now().getTime());
    // Copy-on-write must work here, or each crew would get a full copy.
    const probe = join(build, COPY_PROBE);
    writeStateFile(o.stateRoot, probe, 'probe\n');
    removeStateEntry(o.stateRoot, `${probe}.copy`);
    const cow = await cowCopy(exec, o.stateRoot, o.platform, probe, `${probe}.copy`, 60_000);
    removeStateEntry(o.stateRoot, `${probe}.copy`);
    if (!cow) {
      throw new Error(
        'the state root lies on a file system without copy-on-write copies (APFS on macOS, btrfs or XFS with reflink on Linux): the build cache stays off',
      );
    }
    const src = join(build, 'src');
    const g = (args: string[]) => o.ports.git.run(src, args, { timeoutMs: left() });
    if (isRealDir(join(src, '.git'))) {
      await g(['remote', 'set-url', 'origin', o.originUrl]);
      await g(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    } else {
      removeStateEntry(o.stateRoot, src);
      await o.ports.git.run(
        build,
        ['clone', '--filter=blob:none', '--no-checkout', o.originUrl, src],
        {
          timeoutMs: left(),
        },
      );
    }
    await g(['checkout', '--force', '--detach', 'refs/remotes/origin/main']);
    const sha = (await g(['rev-parse', 'HEAD'])).trim();
    const steps = refreshSteps(src);
    if (steps.length === 0) {
      throw new Error('nothing to cache: main has no Cargo.toml or pnpm-lock.yaml at its root');
    }
    const home = ensureStateDir(o.stateRoot, join(build, 'home'));
    const rustup = o.env.RUSTUP_HOME || join(o.home, '.rustup');
    const env: Record<string, string> = {
      ...Object.fromEntries(
        (['PATH', 'LANG', 'TERM', 'USER'] as const).flatMap((k) =>
          o.env[k] === undefined ? [] : [[k, o.env[k] as string]],
        ),
      ),
      HOME: home,
      CARGO_HOME: join(build, 'cargo-home'),
      CARGO_TARGET_DIR: join(build, 'target'),
      PNPM_CONFIG_STORE_DIR: join(build, 'pnpm-store'),
      ...(existsSync(rustup) ? { RUSTUP_HOME: rustup } : {}),
    };
    const log = join(build, 'refresh.log');
    for (const step of steps) {
      lock.heartbeat(now());
      const r = await exec.run(step.cmd, step.args, { cwd: src, env, timeoutMs: left(), log });
      if (r.code === 124) throw new Error(`cache refresh: ${step.name} timed out; see ${log}`);
      if (r.code !== 0) {
        throw new Error(`cache refresh: ${step.name} failed (${r.code}); see ${log}`);
      }
    }
    lock.heartbeat(now());
    const produced: [Seed, string][] = [
      ['cargo-target', join(build, 'target')],
      ['cargo-registry', join(build, 'cargo-home', 'registry')],
      ['cargo-git', join(build, 'cargo-home', 'git')],
      ['pnpm-store', join(build, 'pnpm-store')],
    ];
    ensureStateDir(o.stateRoot, staging);
    const seeds: Seed[] = [];
    for (const [seed, from] of produced) {
      if (!isRealDir(from)) continue;
      if (!(await cowCopy(exec, o.stateRoot, o.platform, from, join(staging, seed), left()))) {
        throw new Error(`cache refresh: copying ${seed} failed`);
      }
      seeds.push(seed);
    }
    const sizeBytes = diskBytes(staging);
    const capBytes = cacheLimits(o.ownerConfig).maxGb * 1e9;
    if (sizeBytes + diskBytes(build) > capBytes) {
      throw new Error(
        `cache refresh: the cache would take ${gb(sizeBytes + diskBytes(build))} of the ${gb(capBytes)} allowed (cache.max_gb in the owner config); nothing was published`,
      );
    }
    await withLaunchLock(o.ownerRoot, now(), () => {
      const old = seedsDir(o.stateRoot);
      const trash = join(cache, `.trash-${randomBytes(4).toString('hex')}`);
      if (lstatOrUndefined(old) !== undefined) renameSync(old, trash);
      renameSync(staging, old);
      writeMeta(o.stateRoot, { refreshedAt: now().toISOString(), sha, seeds, sizeBytes });
    });
    removeLeftovers(o.stateRoot);
    return { sha, seeds, sizeBytes, steps: steps.map((s) => s.name) };
  } finally {
    try {
      removeStateEntry(o.stateRoot, staging);
    } finally {
      lock.release();
    }
  }
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** Runs `fn` under the owner's launch lock, waiting up to a minute for it. */
async function withLaunchLock(ownerRoot: string, now: Date, fn: () => void): Promise<void> {
  const until = Date.now() + 60_000;
  for (;;) {
    const lock = acquireStateLock(ownerRoot, LAUNCH_LOCK, {
      now,
      heartbeatStaleMs: LAUNCH_LOCK_STALE_MS,
    });
    if (lock) {
      try {
        fn();
        return;
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= until) throw new HeldError('a launch holds launch.lock; try again');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Staging and trash dirs a swap or an interrupted refresh left in the cache dir. */
function removeLeftovers(stateRoot: string): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir(stateRoot));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.trash-') || name.startsWith('.staging-')) {
      removeStateEntry(stateRoot, join(cacheDir(stateRoot), name));
    }
  }
}

// ---- Status and upkeep -------------------------------------------------------------------------

export interface CacheStatus {
  exists: boolean;
  refreshedAt?: string;
  ageDays?: number;
  sha?: string;
  seeds?: Seed[];
  lastUsedAt?: string;
  /** Seeds and the owner's build dir together, on disk. */
  sizeBytes: number;
  maxGb: number;
}

export function cacheStatus(stateRoot: string, ownerConfig: OwnerConfig, now: Date): CacheStatus {
  const meta = readCacheMeta(stateRoot);
  const sizeBytes = diskBytes(cacheDir(stateRoot)) + diskBytes(cacheBuildDir(stateRoot));
  if (meta === undefined)
    return { exists: false, sizeBytes, maxGb: cacheLimits(ownerConfig).maxGb };
  return {
    exists: true,
    refreshedAt: meta.refreshedAt,
    ageDays: Math.floor((now.getTime() - Date.parse(meta.refreshedAt)) / DAY_MS),
    sha: meta.sha,
    seeds: meta.seeds,
    ...(meta.lastUsedAt === undefined ? {} : { lastUsedAt: meta.lastUsedAt }),
    sizeBytes,
    maxGb: cacheLimits(ownerConfig).maxGb,
  };
}

/** Whether a weekly refresh is due: only for a cache that exists, so the owner opts in once. */
export function refreshDue(stateRoot: string, now: Date): boolean {
  const meta = readCacheMeta(stateRoot);
  return meta !== undefined && now.getTime() - Date.parse(meta.refreshedAt) >= REFRESH_EVERY_MS;
}

function gcRanAt(ownerRoot: string): number | undefined {
  const file = join(ownerRoot, CACHE_GC_FILE);
  if (!isRealFile(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const t = isObject(raw) && typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

/**
 * At most once a day: while all projects' caches together take more than `cache.max_gb`, the one
 * used longest ago goes (its seeds under the launch lock, then its build dir). A project whose
 * refresh is running is left alone. Returns the state roots whose cache was removed, or undefined
 * when it was not due.
 */
export async function cacheCleanup(o: {
  stateBase: string;
  ownerRoot: string;
  ownerConfig: OwnerConfig;
  now: Date;
}): Promise<string[] | undefined> {
  const last = gcRanAt(o.ownerRoot);
  if (last !== undefined && o.now.getTime() - last < DAY_MS) return undefined;
  writeStateFile(
    o.ownerRoot,
    join(o.ownerRoot, CACHE_GC_FILE),
    `${JSON.stringify({ at: o.now.toISOString() })}\n`,
  );
  const entries = projectStateRoots(o.stateBase)
    .map((root) => {
      const meta = readCacheMeta(root);
      const used = meta?.lastUsedAt ?? meta?.refreshedAt;
      return {
        root,
        bytes: diskBytes(cacheDir(root)) + diskBytes(cacheBuildDir(root)),
        used: used === undefined ? 0 : Date.parse(used),
      };
    })
    .filter((e) => e.bytes > 0)
    .sort((a, b) => a.used - b.used);
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const cap = cacheLimits(o.ownerConfig).maxGb * 1e9;
  const removed: string[] = [];
  for (const e of entries) {
    if (total <= cap) break;
    const refresh = acquireStateLock(e.root, CACHE_LOCK, {
      now: o.now,
      heartbeatStaleMs: cacheLimits(o.ownerConfig).refreshTimeoutMin * 60_000 + 10 * 60_000,
    });
    if (!refresh) continue;
    try {
      const trash = join(e.root, `${CACHE_DIR}.trash-${randomBytes(4).toString('hex')}`);
      await withLaunchLock(o.ownerRoot, o.now, () => {
        if (lstatOrUndefined(cacheDir(e.root)) !== undefined) renameSync(cacheDir(e.root), trash);
      });
      rmSync(trash, { recursive: true, force: true });
      removeStateEntry(e.root, cacheBuildDir(e.root));
      total -= e.bytes;
      removed.push(e.root);
    } finally {
      refresh.release();
    }
  }
  return removed;
}

const STARTED_FILE = 'refresh-started.json';

/** When tick last started a background refresh of this project. */
function startedAt(stateRoot: string): number | undefined {
  const file = join(cacheBuildDir(stateRoot), STARTED_FILE);
  if (!isRealFile(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const t = isObject(raw) && typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

export interface CacheTick {
  /** State roots whose cache the size cleanup removed. */
  removed?: string[];
  /** `started` in the background, or what the lead runs instead. */
  refresh?: string;
  pid?: number;
}

/**
 * The cache's part of a tick: the size cleanup (daily) and, for a cache that exists, a refresh in
 * the background once a week (`start` spawns `studio cache refresh`; a tick never waits for a
 * build). A refresh started earlier is given its whole timeout before the next one. Undefined when
 * nothing was due.
 */
export async function cacheTick(o: {
  stateRoot: string;
  stateBase: string;
  ownerRoot: string;
  ownerConfig: OwnerConfig;
  now: Date;
  start?: (log: string) => Promise<number>;
}): Promise<CacheTick | undefined> {
  const out: CacheTick = {};
  const removed = await cacheCleanup(o);
  if (removed !== undefined && removed.length > 0) out.removed = removed;
  const last = startedAt(o.stateRoot);
  const grace = cacheLimits(o.ownerConfig).refreshTimeoutMin * 60_000 + 10 * 60_000;
  if (refreshDue(o.stateRoot, o.now) && (last === undefined || o.now.getTime() - last > grace)) {
    if (o.start === undefined) out.refresh = 'due: run studio cache refresh';
    else {
      const build = ensureStateDir(o.stateRoot, cacheBuildDir(o.stateRoot));
      out.pid = await o.start(join(build, 'refresh.log'));
      writeStateFile(
        o.stateRoot,
        join(build, STARTED_FILE),
        `${JSON.stringify({ at: o.now.toISOString(), pid: out.pid })}\n`,
      );
      out.refresh = 'started';
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
