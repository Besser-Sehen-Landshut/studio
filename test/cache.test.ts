import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Board, WorkItem } from '../src/board.js';
import {
  CACHE_GC_FILE,
  type CowCopy,
  cacheCleanup,
  cacheDir,
  cacheDoctorLine,
  cacheDue,
  cacheStatus,
  cacheSteps,
  cowCopyArgs,
  publishCache,
  readCacheMeta,
  readCacheRun,
  seedCrew,
  systemCowCopy,
  withCacheItem,
  writeCacheRun,
} from '../src/cache.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-cache-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A plain recursive copy stands in for copy-on-write; links stay links. */
const copies: [string, string][] = [];
const fakeCow: CowCopy = async (src, dst) => {
  copies.push([src, dst]);
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  return true;
};
const failingCow: CowCopy = async () => false;

let n = 0;
/** A state base with one project state root, its owner root, a crew clone and HOME. */
function layout() {
  const base = join(root, `b${n++}`);
  const stateRoot = join(base, '0123456789abcdef-app');
  const ownerRoot = join(base, '_owner');
  const clone = join(stateRoot, 'clones', 'APP-9');
  const homeDir = join(stateRoot, 'homes', 'APP-9');
  mkdirSync(clone, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(ownerRoot, { recursive: true, mode: 0o700 });
  return { base, stateRoot, ownerRoot, clone, homeDir };
}

const SHA = 'a'.repeat(40);
const NOW = new Date('2026-11-06T10:00:00Z');

/** What a cargo and pnpm build would leave in the clone and HOME. */
function built(clone: string, homeDir: string) {
  mkdirSync(join(clone, 'target', 'debug', 'deps'), { recursive: true });
  writeFileSync(join(clone, 'target', 'debug', 'deps', 'libx.rlib'), 'rlib');
  mkdirSync(join(homeDir, '.cargo', 'registry', 'cache'), { recursive: true });
  writeFileSync(join(homeDir, '.cargo', 'registry', 'cache', 'x.crate'), 'crate');
  mkdirSync(join(homeDir, '.pnpm-store', 'v10'), { recursive: true });
  writeFileSync(join(homeDir, '.pnpm-store', 'v10', 'index'), 'i');
}

const config = (cache?: Record<string, unknown>): StudioConfig =>
  studioConfigSchema.parse({
    studio: 1,
    primaryRepo: 'org/app',
    repos: ['org/app'],
    ci: {
      provider: 'github',
      runners: 'github-hosted',
      runnerLabels: [],
      capacity: { total: 2, mergeMaxBusy: 1, checkTwiceSeconds: 30 },
    },
    merge: { strategy: 'studio-queue', contractPaths: [] },
    roles: { builder: { model: 'sonnet', wip: 1 }, cache: { model: 'haiku', wip: 1 } },
    ...(cache === undefined ? {} : { cache }),
  });

describe('cacheSteps', () => {
  const dir = (files: string[]) => {
    const d = join(root, `steps${n++}`);
    mkdirSync(d);
    for (const f of files) writeFileSync(join(d, f), '');
    return d;
  };

  it('fetches, then builds a Cargo workspace, locked when main has a lock file', () => {
    expect(cacheSteps(dir(['Cargo.toml', 'Cargo.lock'])).map((s) => s.command)).toEqual([
      'cargo fetch --locked',
      'cargo build --workspace --all-targets --locked',
    ]);
    expect(cacheSteps(dir(['Cargo.toml'])).map((s) => s.command)).toEqual([
      'cargo fetch',
      'cargo build --workspace --all-targets',
    ]);
  });

  it('installs with pnpm, else npm, never running install scripts', () => {
    expect(cacheSteps(dir(['pnpm-lock.yaml', 'package-lock.json'])).map((s) => s.command)).toEqual([
      'pnpm install --frozen-lockfile --ignore-scripts',
    ]);
    expect(cacheSteps(dir(['package-lock.json'])).map((s) => s.command)).toEqual([
      'npm ci --ignore-scripts',
    ]);
  });

  it('a Rust and Node project gets both; one without manifests nothing', () => {
    expect(cacheSteps(dir(['Cargo.toml', 'pnpm-lock.yaml']))).toHaveLength(3);
    expect(cacheSteps(dir(['README.md']))).toEqual([]);
  });

  it('a manifest that is a link does not count', () => {
    const d = dir([]);
    symlinkSync('/etc/hosts', join(d, 'Cargo.toml'));
    expect(cacheSteps(d)).toEqual([]);
  });
});

describe('cowCopyArgs', () => {
  it('clones on macOS and Linux, keeping links and times; nothing elsewhere', () => {
    expect(cowCopyArgs('darwin', 'a', 'b')).toEqual(['-c', '-R', '-p', 'a', 'b']);
    expect(cowCopyArgs('linux', 'a', 'b')).toEqual(['-R', '-p', '--reflink=always', 'a', 'b']);
    expect(cowCopyArgs('win32', 'a', 'b')).toBeUndefined();
    expect(systemCowCopy('win32')).toBeUndefined();
  });

  it('the system copy keeps a link a link where this file system clones, else says false', async () => {
    const cow = systemCowCopy();
    if (cow === undefined) return;
    const src = join(root, `cow${n++}`);
    mkdirSync(src);
    writeFileSync(join(src, 'f'), 'x');
    symlinkSync('/etc/hosts', join(src, 'l'));
    const dst = `${src}-copy`;
    if (await cow(src, dst, 30_000)) {
      expect(readFileSync(join(dst, 'f'), 'utf8')).toBe('x');
      expect(lstatSync(join(dst, 'l')).isSymbolicLink()).toBe(true);
    }
  });
});

describe('publishCache', () => {
  const ownerConfig = { cache: { maxGb: 1 } };

  it('publishes what the build left, with the commit the launch recorded', async () => {
    const l = layout();
    built(l.clone, l.homeDir);
    writeCacheRun(l.stateRoot, {
      item: 'APP-9',
      sha: SHA,
      commands: ['cargo build'],
      startedAt: NOW.toISOString(),
    });
    const meta = await publishCache({ ...l, item: 'APP-9', ownerConfig, cow: fakeCow, now: NOW });
    expect(meta).toMatchObject({ sha: SHA, item: 'APP-9' });
    expect(meta.seeds).toEqual(['cargo-target', 'cargo-registry', 'pnpm-store']);
    expect(readCacheMeta(l.stateRoot)).toMatchObject({ sha: SHA, seeds: meta.seeds });
    const seeds = join(cacheDir(l.stateRoot), 'seeds');
    expect(readFileSync(join(seeds, 'cargo-target', 'debug', 'deps', 'libx.rlib'), 'utf8')).toBe(
      'rlib',
    );
    // The run record is used once.
    expect(readCacheRun(l.stateRoot, 'APP-9')).toBeUndefined();
  });

  it('takes no place reached through a link', async () => {
    const l = layout();
    const elsewhere = join(l.base, 'elsewhere');
    mkdirSync(join(elsewhere, 'registry'), { recursive: true });
    writeFileSync(join(elsewhere, 'registry', 'secret'), 'x');
    symlinkSync(elsewhere, join(l.homeDir, '.cargo'));
    mkdirSync(join(l.homeDir, '.pnpm-store'));
    writeFileSync(join(l.homeDir, '.pnpm-store', 'i'), 'i');
    writeCacheRun(l.stateRoot, {
      item: 'APP-9',
      sha: SHA,
      commands: [],
      startedAt: NOW.toISOString(),
    });
    const meta = await publishCache({ ...l, item: 'APP-9', ownerConfig, cow: fakeCow, now: NOW });
    expect(meta.seeds).toEqual(['pnpm-store']);
  });

  it('without a recorded run, without copy-on-write or over the cap nothing is published', async () => {
    const l = layout();
    built(l.clone, l.homeDir);
    const o = { ...l, item: 'APP-9', ownerConfig, cow: fakeCow, now: NOW };
    await expect(publishCache(o)).rejects.toThrow(/no cache run of APP-9/);
    writeCacheRun(l.stateRoot, {
      item: 'APP-9',
      sha: SHA,
      commands: [],
      startedAt: NOW.toISOString(),
    });
    await expect(publishCache({ ...o, cow: failingCow })).rejects.toThrow(/copy-on-write/);
    await expect(publishCache({ ...o, ownerConfig: { cache: { maxGb: 1e-9 } } })).rejects.toThrow(
      /cache\.max_gb/,
    );
    expect(readCacheMeta(l.stateRoot)).toBeUndefined();
    // No staging dir is left behind.
    expect(existsSync(cacheDir(l.stateRoot))).toBe(true);
    const left = (await import('node:fs')).readdirSync(cacheDir(l.stateRoot));
    expect(left.filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('a new build replaces the old seeds in one swap', async () => {
    const l = layout();
    built(l.clone, l.homeDir);
    const run = { item: 'APP-9', sha: SHA, commands: [], startedAt: NOW.toISOString() };
    writeCacheRun(l.stateRoot, run);
    await publishCache({ ...l, item: 'APP-9', ownerConfig, cow: fakeCow, now: NOW });
    rmSync(join(l.clone, 'target'), { recursive: true });
    writeCacheRun(l.stateRoot, { ...run, sha: 'b'.repeat(40) });
    const meta = await publishCache({ ...l, item: 'APP-9', ownerConfig, cow: fakeCow, now: NOW });
    expect(meta.sha).toBe('b'.repeat(40));
    expect(existsSync(join(cacheDir(l.stateRoot), 'seeds', 'cargo-target'))).toBe(false);
  });
});

describe('seedCrew', () => {
  async function withCache() {
    const l = layout();
    built(l.clone, l.homeDir);
    writeCacheRun(l.stateRoot, {
      item: 'APP-9',
      sha: SHA,
      commands: [],
      startedAt: NOW.toISOString(),
    });
    await publishCache({ ...l, item: 'APP-9', ownerConfig: {}, cow: fakeCow, now: NOW });
    const clone = join(l.stateRoot, 'clones', 'APP-10');
    const homeDir = join(l.stateRoot, 'homes', 'APP-10');
    mkdirSync(clone, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(clone, 'Cargo.toml'), '');
    return { ...l, clone, homeDir };
  }

  it('copies the seeds into a fresh clone and HOME, and records the use', async () => {
    const l = await withCache();
    const later = new Date('2026-11-07T10:00:00Z');
    const seeded = await seedCrew({ ...l, freshClone: true, cow: fakeCow, now: later });
    expect(seeded).toEqual(['cargo-target', 'cargo-registry', 'pnpm-store']);
    expect(existsSync(join(l.clone, 'target', 'debug', 'deps', 'libx.rlib'))).toBe(true);
    expect(existsSync(join(l.homeDir, '.cargo', 'registry', 'cache', 'x.crate'))).toBe(true);
    expect(existsSync(join(l.homeDir, '.pnpm-store', 'v10', 'index'))).toBe(true);
    expect(readCacheMeta(l.stateRoot)?.lastUsedAt).toBe(later.toISOString());
  });

  it('never seeds the target dir of a clone a crew has run in', async () => {
    const l = await withCache();
    const seeded = await seedCrew({ ...l, freshClone: false, cow: fakeCow, now: NOW });
    expect(seeded).not.toContain('cargo-target');
    expect(existsSync(join(l.clone, 'target'))).toBe(false);
  });

  it('without a cache or copy-on-write, nothing', async () => {
    const l = layout();
    expect(await seedCrew({ ...l, freshClone: true, cow: fakeCow, now: NOW })).toEqual([]);
    const c = await withCache();
    expect(await seedCrew({ ...c, freshClone: true, cow: undefined, now: NOW })).toEqual([]);
    expect(await seedCrew({ ...c, freshClone: true, cow: failingCow, now: NOW })).toEqual([]);
  });
});

describe('scheduling', () => {
  const board = (items: Partial<WorkItem>[] = []): Board =>
    ({
      version: 1,
      items: items.map((i, k) => ({
        id: `APP-${k + 1}`,
        title: 't',
        type: 'fix',
        role: 'builder',
        repo: 'org/app',
        size: 'S',
        priority: 3,
        status: 'ready',
        paths: [],
        touches: [],
        dependsOn: [],
        dod: [],
        history: [],
        ...i,
      })),
    }) as unknown as Board;

  it('is due when on and the cache is missing or older than every_days', async () => {
    const l = layout();
    expect(cacheDue(l.stateRoot, config(), NOW)).toBe(false);
    expect(cacheDue(l.stateRoot, config({ enabled: true }), NOW)).toBe(true);
    built(l.clone, l.homeDir);
    writeCacheRun(l.stateRoot, {
      item: 'APP-9',
      sha: SHA,
      commands: [],
      startedAt: NOW.toISOString(),
    });
    await publishCache({ ...l, item: 'APP-9', ownerConfig: {}, cow: fakeCow, now: NOW });
    const on = config({ enabled: true, everyDays: 2 });
    expect(cacheDue(l.stateRoot, on, new Date('2026-11-07T10:00:00Z'))).toBe(false);
    expect(cacheDue(l.stateRoot, on, new Date('2026-11-08T10:00:00Z'))).toBe(true);
  });

  it('adds one ready cache item, research-shaped, until it is merged or dropped', () => {
    const b = board([{}, { priority: 7 }]);
    const r = withCacheItem(b, config({ enabled: true }));
    expect(r.id).toBe('APP-3');
    const item = r.board.items.at(-1) as WorkItem;
    expect(item).toMatchObject({
      role: 'cache',
      type: 'research',
      status: 'ready',
      repo: 'org/app',
      priority: 8,
    });
    expect(withCacheItem(r.board, config({ enabled: true })).id).toBeUndefined();
    const blocked = board([{ role: 'cache', status: 'blocked' }]);
    expect(withCacheItem(blocked, config({ enabled: true })).id).toBeUndefined();
    const merged = board([{ role: 'cache', status: 'merged' }]);
    expect(withCacheItem(merged, config({ enabled: true })).id).toBe('APP-2');
  });
});

describe('status and cleanup', () => {
  it('the doctor line says off, not built yet, or what was built and its size', async () => {
    const l = layout();
    expect(cacheDoctorLine(cacheStatus(l.stateRoot, config(), {}))).toBe('build cache: off');
    expect(cacheDoctorLine(cacheStatus(l.stateRoot, config({ enabled: true }), {}))).toBe(
      'build cache: on, not built yet, 0.0 GB of 20.0 GB for all projects',
    );
    built(l.clone, l.homeDir);
    writeCacheRun(l.stateRoot, {
      item: 'APP-9',
      sha: SHA,
      commands: [],
      startedAt: NOW.toISOString(),
    });
    await publishCache({ ...l, item: 'APP-9', ownerConfig: {}, cow: fakeCow, now: NOW });
    expect(cacheDoctorLine(cacheStatus(l.stateRoot, config({ enabled: true }), {}))).toMatch(
      /^build cache: on, built 2026-11-06 from aaaaaaaaaaaa \(cargo-target, cargo-registry, pnpm-store\), \d+\.\d GB of 20\.0 GB for all projects$/,
    );
  });

  it('once a day, removes the caches used longest ago while all together exceed the cap', async () => {
    const base = join(root, `gc${n++}`);
    const ownerRoot = join(base, '_owner');
    mkdirSync(ownerRoot, { recursive: true });
    const roots = ['0000000000000001-a', '0000000000000002-b'].map((name, k) => {
      const stateRoot = join(base, name);
      const clone = join(stateRoot, 'clones', 'APP-1');
      const homeDir = join(stateRoot, 'homes', 'APP-1');
      mkdirSync(clone, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      built(clone, homeDir);
      writeCacheRun(stateRoot, {
        item: 'APP-1',
        sha: SHA,
        commands: [],
        startedAt: NOW.toISOString(),
      });
      return { stateRoot, clone, homeDir, at: new Date(NOW.getTime() + k * 1000) };
    });
    for (const r of roots) {
      await publishCache({
        ...r,
        ownerRoot,
        item: 'APP-1',
        ownerConfig: {},
        cow: fakeCow,
        now: r.at,
      });
    }
    const one = readCacheMeta(roots[1]?.stateRoot as string)?.sizeBytes as number;
    const cap = { cache: { maxGb: (one * 1.5) / 1e9 } };
    const removed = await cacheCleanup({ stateBase: base, ownerRoot, ownerConfig: cap, now: NOW });
    expect(removed).toEqual([roots[0]?.stateRoot]);
    expect(readCacheMeta(roots[0]?.stateRoot as string)).toBeUndefined();
    expect(readCacheMeta(roots[1]?.stateRoot as string)).toBeDefined();
    expect(existsSync(join(ownerRoot, CACHE_GC_FILE))).toBe(true);
    // Not again within a day.
    const again = await cacheCleanup({
      stateBase: base,
      ownerRoot,
      ownerConfig: { cache: { maxGb: 1e-9 } },
      now: new Date(NOW.getTime() + 3_600_000),
    });
    expect(again).toBeUndefined();
  });
});
