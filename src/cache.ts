import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { boardPrefix } from './add-item.js';
import { type Board, type WorkItem, workItemSchema } from './board.js';
import { cacheMaxGb, type OwnerConfig, type StudioConfig } from './config.js';
import { HeldError } from './held.js';
import {
  acquireStateLock,
  assertStatePath,
  ensureStateDir,
  projectStateRoots,
  removeStateEntry,
  writeStateFile,
} from './paths.js';
import { LAUNCH_LOCK, LAUNCH_LOCK_STALE_MS } from './usage.js';

/**
 * The shared build cache of a project. Crews start from a fresh clone and a fresh HOME, so each
 * one downloads its crates and packages and builds everything from scratch. The cache keeps a warm
 * copy per project, built from `main` only:
 *
 *   <state root>/cache/seeds/<seed>/   what crews start from
 *   <state root>/cache/cache.json      when, from which commit and by which item it was built
 *   <state root>/cache/runs/<id>.json  a cache crew's run: the commit and the commands of its brief
 *
 * A crew of the role `cache` builds it (`withCacheItem`, put on the board by tick when the cache is
 * older than `cache.every_days`): a fresh clone at the `origin/main` commit Studio read the rules
 * at, a fresh HOME, Claude Code's sandbox, no GitHub token, and a guard that lets it run only the
 * commands Studio listed (`cacheSteps`) and write only its report. Its clone and HOME are never
 * seeded, so nothing an earlier cache held reaches the next one. When its report says done, collect
 * copies what the build left (`publishCache`) into the cache in one swap. Crews of a pull request
 * never write the cache: it lies in the state base their sandbox denies, and Studio is the only
 * writer.
 *
 * At launch every other local crew gets copy-on-write copies of the seeds (`seedCrew`): the Rust
 * target dir into a fresh clone, the cargo registry, the pnpm store and the npm cache into its
 * fresh HOME. It reads the cache only through its own copy, and what it writes stays in that copy.
 * Copy-on-write (`cp -c` on APFS, `cp --reflink=always` on btrfs or XFS) costs no disk until a file
 * changes; without it a seed would be a full copy per crew, so a file system without it gets no
 * cache. Hard links are never used: a crew could change the shared file through one.
 */

export const CACHE_ROLE = 'cache';
export const CACHE_DIR = 'cache';
/** In the owner root: when the size cleanup last ran. */
export const CACHE_GC_FILE = 'cache-gc.json';

export const SEEDS = [
  'cargo-target',
  'cargo-registry',
  'cargo-git',
  'pnpm-store',
  'npm-cache',
] as const;
export type Seed = (typeof SEEDS)[number];

const META = 'cache.json';
const DAY_MS = 86_400_000;
const SEED_TIMEOUT_MS = 10 * 60_000;
const ID_RE = /^[A-Z]+-\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface CacheMeta {
  refreshedAt: string;
  sha: string;
  item: string;
  seeds: Seed[];
  sizeBytes: number;
  lastUsedAt?: string;
}

export const cacheDir = (stateRoot: string): string => join(stateRoot, CACHE_DIR);
const seedsDir = (stateRoot: string): string => join(cacheDir(stateRoot), 'seeds');
const runFile = (stateRoot: string, id: string): string => {
  if (!ID_RE.test(id)) throw new Error(`invalid item id ${JSON.stringify(id)}`);
  return join(cacheDir(stateRoot), 'runs', `${id}.json`);
};

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
const validDate = (v: unknown): v is string =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** `base/<segs>` when every step below `base` is a real directory, no link on the way. */
function realDirBelow(base: string, ...segs: string[]): string | undefined {
  let cur = base;
  for (const seg of segs) {
    cur = join(cur, seg);
    if (!isRealDir(cur)) return undefined;
  }
  return cur;
}

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
  if (!isObject(raw) || !validDate(raw.refreshedAt) || typeof raw.sha !== 'string') {
    return undefined;
  }
  if (!SHA_RE.test(raw.sha) || typeof raw.item !== 'string' || !Array.isArray(raw.seeds)) {
    return undefined;
  }
  const seeds = raw.seeds.filter((s): s is Seed => (SEEDS as readonly unknown[]).includes(s));
  return {
    refreshedAt: raw.refreshedAt,
    sha: raw.sha,
    item: raw.item,
    seeds,
    sizeBytes: typeof raw.sizeBytes === 'number' && raw.sizeBytes >= 0 ? raw.sizeBytes : 0,
    ...(validDate(raw.lastUsedAt) ? { lastUsedAt: raw.lastUsedAt } : {}),
  };
}

function writeMeta(stateRoot: string, meta: CacheMeta): void {
  writeStateFile(stateRoot, join(cacheDir(stateRoot), META), `${JSON.stringify(meta, null, 2)}\n`);
}

// ---- Copy-on-write -----------------------------------------------------------------------------

/**
 * A copy-on-write copy of the directory `src` to `dst`, which must not exist; links inside are
 * copied as links, never followed. False when it failed (no copy-on-write here, a timeout).
 */
export type CowCopy = (src: string, dst: string, timeoutMs: number) => Promise<boolean>;

/** The arguments of a copy-on-write `cp`, or undefined where Studio knows none. */
export function cowCopyArgs(
  platform: NodeJS.Platform,
  src: string,
  dst: string,
): string[] | undefined {
  // `-R` copies links as links on both; `-p` keeps the times cargo's fingerprints compare.
  if (platform === 'darwin') return ['-c', '-R', '-p', src, dst];
  if (platform === 'linux') return ['-R', '-p', '--reflink=always', src, dst];
  return undefined;
}

/** `cp` from `/bin` with a fixed PATH; undefined where the platform has no copy-on-write `cp`. */
export function systemCowCopy(platform: NodeJS.Platform = process.platform): CowCopy | undefined {
  if (cowCopyArgs(platform, 'a', 'b') === undefined) return undefined;
  return (src, dst, timeoutMs) =>
    new Promise((resolve) => {
      const args = cowCopyArgs(platform, src, dst) as string[];
      execFile(
        '/bin/cp',
        args,
        { env: { PATH: '/bin:/usr/bin' }, timeout: timeoutMs, killSignal: 'SIGKILL' },
        (err) => resolve(err === null),
      );
    });
}

/** A copy of `src` to `dst`; nothing is left at `dst` when it failed. */
async function copyInto(
  root: string,
  cow: CowCopy,
  src: string,
  dst: string,
  timeoutMs: number,
): Promise<boolean> {
  assertStatePath(root, dst);
  if (lstatOrUndefined(dst) !== undefined) return false;
  if (await cow(src, dst, timeoutMs)) return true;
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

// ---- What a cache crew runs --------------------------------------------------------------------

export interface CacheStep {
  /** Exactly what the crew types, and the only commands the guard lets it run. */
  command: string;
  /** Where the step leaves what the cache keeps. */
  seeds: Seed[];
}

/**
 * The commands that fill the cache, from the manifests at the root of a fresh checkout of main:
 * the downloads and the build of a Cargo workspace, a pnpm install, else an npm one. No install
 * script runs (`--ignore-scripts`); cargo runs build scripts and proc macros, as a build does.
 * Empty when main has none of them: there is nothing to cache.
 */
export function cacheSteps(dir: string): CacheStep[] {
  const steps: CacheStep[] = [];
  if (isRealFile(join(dir, 'Cargo.toml'))) {
    const locked = isRealFile(join(dir, 'Cargo.lock')) ? ' --locked' : '';
    steps.push(
      { command: `cargo fetch${locked}`, seeds: ['cargo-registry', 'cargo-git'] },
      {
        command: `cargo build --workspace --all-targets${locked}`,
        seeds: ['cargo-target', 'cargo-registry', 'cargo-git'],
      },
    );
  }
  if (isRealFile(join(dir, 'pnpm-lock.yaml'))) {
    steps.push({
      command: 'pnpm install --frozen-lockfile --ignore-scripts',
      seeds: ['pnpm-store'],
    });
  } else if (isRealFile(join(dir, 'package-lock.json'))) {
    steps.push({ command: 'npm ci --ignore-scripts', seeds: ['npm-cache'] });
  }
  return steps;
}

/** The names at the root of main that `cacheSteps` looks for. */
export const CACHE_MANIFESTS = ['Cargo.toml', 'pnpm-lock.yaml', 'package-lock.json'];

/** Where a crew's run leaves each seed, in its clone and its HOME. */
function seedPlaces(clone: string, homeDir: string): Record<Seed, [string, ...string[]]> {
  return {
    'cargo-target': [clone, 'target'],
    'cargo-registry': [homeDir, '.cargo', 'registry'],
    'cargo-git': [homeDir, '.cargo', 'git'],
    'pnpm-store': [homeDir, '.pnpm-store'],
    'npm-cache': [homeDir, '.npm'],
  };
}

/** Environment of a crew for the seeds: pnpm's store in its HOME, where the cache seeds it. */
export const cacheEnv = (homeDir: string): Record<string, string> => ({
  // pnpm reads PNPM_CONFIG_* over pnpm-workspace.yaml and .npmrc.
  PNPM_CONFIG_STORE_DIR: join(homeDir, '.pnpm-store'),
});

export interface CacheRun {
  item: string;
  sha: string;
  commands: string[];
  startedAt: string;
}

/** Written at a cache crew's launch, out of its reach: what collect publishes from. */
export function writeCacheRun(stateRoot: string, run: CacheRun): void {
  if (!SHA_RE.test(run.sha)) throw new Error('a cache run needs the full commit of main');
  writeStateFile(stateRoot, runFile(stateRoot, run.item), `${JSON.stringify(run, null, 2)}\n`);
}

export function readCacheRun(stateRoot: string, id: string): CacheRun | undefined {
  const file = runFile(stateRoot, id);
  if (!isRealFile(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (
      !isObject(raw) ||
      raw.item !== id ||
      typeof raw.sha !== 'string' ||
      !SHA_RE.test(raw.sha) ||
      !Array.isArray(raw.commands) ||
      !raw.commands.every((c) => typeof c === 'string') ||
      !validDate(raw.startedAt)
    ) {
      return undefined;
    }
    return { item: id, sha: raw.sha, commands: raw.commands as string[], startedAt: raw.startedAt };
  } catch {
    return undefined;
  }
}

// ---- At launch ---------------------------------------------------------------------------------

/**
 * Copies the cache's seeds into a crew's own places before it runs: the Rust target dir only into
 * a fresh clone (never into one a crew has run in), the rest into the HOME the launch has just
 * recreated. A seed that cannot be copied is skipped: the crew builds without it. Runs under the
 * launch lock, which a publish's swap and the cleanup take too, so no seed is read while it moves.
 */
export async function seedCrew(o: {
  stateRoot: string;
  clone: string;
  homeDir: string;
  freshClone: boolean;
  cow: CowCopy | undefined;
  now: Date;
}): Promise<Seed[]> {
  const meta = readCacheMeta(o.stateRoot);
  if (meta === undefined || o.cow === undefined) return [];
  const places = seedPlaces(o.clone, o.homeDir);
  const seeded: Seed[] = [];
  for (const seed of meta.seeds) {
    const src = join(seedsDir(o.stateRoot), seed);
    if (!isRealDir(src)) continue;
    if (seed === 'cargo-target' && !(o.freshClone && isRealFile(join(o.clone, 'Cargo.toml')))) {
      continue;
    }
    const [base, ...segs] = places[seed];
    const parent = ensureStateDir(o.stateRoot, join(base, ...segs.slice(0, -1)));
    const dst = join(parent, segs.at(-1) as string);
    if (await copyInto(o.stateRoot, o.cow, src, dst, SEED_TIMEOUT_MS)) seeded.push(seed);
  }
  try {
    writeMeta(o.stateRoot, { ...meta, lastUsedAt: o.now.toISOString() });
  } catch {
    // The last use only orders the cleanup; a failed write must not fail the launch.
  }
  return seeded;
}

// ---- After a cache crew ------------------------------------------------------------------------

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * Puts what a cache crew's build left into the cache, after its run ended with a done report:
 * copy-on-write copies of its target dir, cargo registry, pnpm store or npm cache into a staging
 * dir, then one swap under the launch lock. Every place is taken only as a real directory reached
 * without a link. Over `cache.max_gb` of the owner config, or when a copy fails, nothing is
 * published and the old cache stays. The commit is the one the launch recorded, never the clone's.
 */
export async function publishCache(o: {
  stateRoot: string;
  ownerRoot: string;
  item: string;
  clone: string;
  homeDir: string;
  ownerConfig: Pick<OwnerConfig, 'cache'>;
  cow: CowCopy | undefined;
  now: Date;
}): Promise<CacheMeta> {
  const run = readCacheRun(o.stateRoot, o.item);
  if (run === undefined) throw new Error(`no cache run of ${o.item} is recorded`);
  if (o.cow === undefined) throw new Error('this platform has no copy-on-write copy');
  const cache = ensureStateDir(o.stateRoot, cacheDir(o.stateRoot));
  const staging = join(cache, `.staging-${randomBytes(4).toString('hex')}`);
  try {
    ensureStateDir(o.stateRoot, staging);
    const places = seedPlaces(o.clone, o.homeDir);
    const seeds: Seed[] = [];
    for (const seed of SEEDS) {
      const [base, ...segs] = places[seed];
      const from = realDirBelow(base, ...segs);
      if (from === undefined || readdirSync(from).length === 0) continue;
      if (!(await copyInto(o.stateRoot, o.cow, from, join(staging, seed), SEED_TIMEOUT_MS))) {
        throw new Error(
          `copying ${seed} failed: the state root needs a file system with copy-on-write copies (APFS, btrfs, XFS)`,
        );
      }
      seeds.push(seed);
    }
    if (seeds.length === 0) throw new Error('the build left nothing to cache');
    const sizeBytes = diskBytes(staging);
    const capBytes = cacheMaxGb(o.ownerConfig) * 1e9;
    if (sizeBytes > capBytes) {
      throw new Error(
        `the cache would take ${gb(sizeBytes)} of the ${gb(capBytes)} allowed (cache.max_gb in the owner config)`,
      );
    }
    const meta: CacheMeta = {
      refreshedAt: o.now.toISOString(),
      sha: run.sha,
      item: o.item,
      seeds,
      sizeBytes,
    };
    const trash = join(cache, `.trash-${randomBytes(4).toString('hex')}`);
    await withLaunchLock(o.ownerRoot, o.now, () => {
      const old = seedsDir(o.stateRoot);
      if (lstatOrUndefined(old) !== undefined) renameSync(old, trash);
      renameSync(staging, old);
      writeMeta(o.stateRoot, meta);
    });
    removeLeftovers(o.stateRoot);
    removeStateEntry(o.stateRoot, runFile(o.stateRoot, o.item));
    return meta;
  } finally {
    removeStateEntry(o.stateRoot, staging);
  }
}

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

/** Staging and trash dirs a swap or an interrupted publish left in the cache dir. */
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

// ---- Scheduling, status and upkeep -------------------------------------------------------------

/** Whether the project's cache is due: none yet, or built `every_days` ago or longer. */
export function cacheDue(stateRoot: string, config: StudioConfig, now: Date): boolean {
  if (config.cache?.enabled !== true) return false;
  const meta = readCacheMeta(stateRoot);
  return (
    meta === undefined ||
    now.getTime() - Date.parse(meta.refreshedAt) >= config.cache.everyDays * DAY_MS
  );
}

const OPEN = (i: WorkItem) => i.status !== 'merged' && i.status !== 'dropped';

/** The open cache item of the board, if any: a failed one stays open until the lead drops it. */
export const openCacheItem = (board: Board): WorkItem | undefined =>
  board.items.find((i) => i.role === CACHE_ROLE && OPEN(i));

/** A ready cache item for the primary repository, unless one is open. Pure. */
export function withCacheItem(board: Board, config: StudioConfig): { board: Board; id?: string } {
  if (openCacheItem(board) !== undefined) return { board };
  const prefix = boardPrefix(board, config.primaryRepo);
  const taken = board.items
    .filter((i) => i.id.startsWith(`${prefix}-`))
    .map((i) => Number(i.id.slice(prefix.length + 1)));
  const id = `${prefix}-${Math.max(0, ...taken.filter(Number.isFinite)) + 1}`;
  const item = workItemSchema.parse({
    id,
    title: 'Build the shared build cache from main',
    type: 'research',
    role: CACHE_ROLE,
    repo: config.primaryRepo,
    size: 'S',
    priority: Math.max(0, ...board.items.map((i) => i.priority)) + 1,
    status: 'ready',
    paths: [],
    touches: [],
    dependsOn: [],
    dod: ['every command of the brief ran and passed'],
    history: [],
  });
  return { board: { ...board, items: [...board.items, item] }, id };
}

export interface CacheStatus {
  enabled: boolean;
  exists: boolean;
  refreshedAt?: string;
  sha?: string;
  seeds?: Seed[];
  /** On disk: the seeds and anything a publish left. */
  sizeBytes: number;
  maxGb: number;
}

export function cacheStatus(
  stateRoot: string,
  config: StudioConfig | undefined,
  ownerConfig: Pick<OwnerConfig, 'cache'> | undefined,
): CacheStatus {
  const meta = readCacheMeta(stateRoot);
  return {
    enabled: config?.cache?.enabled === true,
    exists: meta !== undefined,
    ...(meta === undefined
      ? {}
      : { refreshedAt: meta.refreshedAt, sha: meta.sha, seeds: meta.seeds }),
    sizeBytes: diskBytes(cacheDir(stateRoot)),
    maxGb: cacheMaxGb(ownerConfig ?? {}),
  };
}

/** The doctor's line about the cache. */
export function cacheDoctorLine(s: CacheStatus): string {
  if (!s.enabled && !s.exists) return 'build cache: off';
  const state = s.exists
    ? `built ${s.refreshedAt?.slice(0, 10)} from ${s.sha?.slice(0, 12)} (${(s.seeds ?? []).join(', ')})`
    : 'not built yet';
  return `build cache: ${s.enabled ? 'on' : 'off, a copy is kept'}, ${state}, ${gb(s.sizeBytes)} of ${gb(s.maxGb * 1e9)} for all projects`;
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
 * At most once a day: while the caches of all projects together take more than `cache.max_gb`,
 * the one used longest ago goes, under the launch lock. Returns the state roots whose cache was
 * removed, or undefined when it was not due.
 */
export async function cacheCleanup(o: {
  stateBase: string;
  ownerRoot: string;
  ownerConfig: Pick<OwnerConfig, 'cache'>;
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
        bytes: diskBytes(cacheDir(root)),
        used: used === undefined ? 0 : Date.parse(used),
      };
    })
    .filter((e) => e.bytes > 0)
    .sort((a, b) => a.used - b.used);
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const cap = cacheMaxGb(o.ownerConfig) * 1e9;
  const removed: string[] = [];
  for (const e of entries) {
    if (total <= cap) break;
    // The seeds and their record go; a cache crew's run record stays for its publish.
    const trash = join(cacheDir(e.root), `.trash-${randomBytes(4).toString('hex')}`);
    await withLaunchLock(o.ownerRoot, o.now, () => {
      assertStatePath(e.root, trash);
      if (isRealDir(seedsDir(e.root))) renameSync(seedsDir(e.root), trash);
      removeStateEntry(e.root, join(cacheDir(e.root), META));
    });
    rmSync(trash, { recursive: true, force: true });
    total -= e.bytes;
    removed.push(e.root);
  }
  return removed;
}
