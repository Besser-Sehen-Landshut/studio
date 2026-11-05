import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import {
  CACHE_GC_FILE,
  cacheCleanup,
  cacheDir,
  cowCopyArgs,
  readCacheMeta,
  refreshCache,
  refreshDue,
  seedCrew,
} from '../src/cache.js';
import { type CliDeps, runCli } from '../src/cli.js';
import { ownerConfigSchema, type StudioConfig, studioConfigSchema } from '../src/config.js';
import { launchCrew } from '../src/crew.js';
import { evaluateGuard } from '../src/guard.js';
import {
  checkStateMarker,
  ownerStateRootFor,
  projectRealpath,
  stateRootFor,
} from '../src/paths.js';
import { type Exec, type Ports, realPorts } from '../src/ports.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-cache-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

let n = 0;
/** A project with a bare origin; `files` are committed on main. */
function makeProject(files: Record<string, string> = {}) {
  const base = join(root, `p${n++}`);
  mkdirSync(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = join(base, 'clone');
  git(base, 'clone', '-q', origin, project);
  git(project, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'x\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  const env: Record<string, string | undefined> = { PATH: process.env.PATH };
  return {
    base,
    project,
    home,
    origin,
    env,
    state: stateRootFor(project, { env, homedir: home }),
    owner: ownerStateRootFor({ env, homedir: home }),
  };
}

interface Call {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  /** The sandbox the command ran in: the Seatbelt profile or the bubblewrap arguments. */
  profile?: string;
  bwrap?: string[];
}

/** The command inside a sandbox wrapper, and the wrapper. */
function unwrap(cmd: string, args: string[]): Omit<Call, 'env'> {
  if (cmd === '/usr/bin/sandbox-exec' && args[0] === '-p') {
    return { cmd: args[2] as string, args: args.slice(3), profile: args[1] as string };
  }
  if (cmd === 'bwrap') {
    const at = args.indexOf('--');
    return { cmd: args[at + 1] as string, args: args.slice(at + 2), bwrap: args.slice(0, at) };
  }
  return { cmd, args };
}

/**
 * An exec port that copies like `cp` (a plain recursive copy stands in for copy-on-write), and
 * "builds" by creating what cargo and pnpm would leave. `fail` names commands that fail.
 */
function fakeExec(o: { fail?: string[]; code?: number } = {}) {
  const calls: Call[] = [];
  const detached: Call[] = [];
  const exec: Exec = {
    async run(outer, outerArgs, opts) {
      const call = { ...unwrap(outer, outerArgs), env: opts.env };
      calls.push(call);
      const { cmd, args } = call;
      if (o.fail?.includes(cmd)) return { code: o.code ?? 1, stdout: '', stderr: 'no' };
      if (cmd === 'cp') {
        const [src, dst] = args.slice(-2) as [string, string];
        cpSync(src, dst, { recursive: true });
      } else if (cmd === 'cargo') {
        mkdirSync(join(opts.env.CARGO_TARGET_DIR as string, 'debug', 'deps'), { recursive: true });
        writeFileSync(join(opts.env.CARGO_TARGET_DIR as string, 'debug', 'deps', 'lib.rlib'), 'x');
        mkdirSync(join(opts.env.CARGO_HOME as string, 'registry', 'cache'), { recursive: true });
      } else if (cmd === 'pnpm') {
        mkdirSync(join(opts.env.PNPM_CONFIG_STORE_DIR as string, 'v10'), { recursive: true });
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async detach(cmd, args, opts) {
      detached.push({ cmd, args, env: opts.env });
      return { pid: 9001 };
    },
  };
  return { exec, calls, detached };
}

function ports(exec?: Exec, start = '2026-11-05T10:00:00Z'): Ports & { set(iso: string): void } {
  let t = Date.parse(start);
  const p: Ports = {
    ...realPorts(),
    gh: { api: async () => '0', run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    claude: {
      start: async () => ({ pid: 4242 }),
      alive: () => false,
      identity: async () => 'start-4242',
      stop: async () => {},
    },
    clock: { now: () => new Date(t), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
    ...(exec === undefined ? {} : { exec }),
  };
  return Object.assign(p, { set: (iso: string) => (t = Date.parse(iso)) });
}

const owner = ownerConfigSchema.parse({});

describe('copy-on-write copies', () => {
  it('uses clonefile on macOS and reflink on Linux, nothing elsewhere', () => {
    expect(cowCopyArgs('darwin', 'a', 'b')).toEqual(['-c', '-R', '-p', 'a', 'b']);
    expect(cowCopyArgs('linux', 'a', 'b')).toEqual(['-R', '-p', '--reflink=always', 'a', 'b']);
    expect(cowCopyArgs('win32', 'a', 'b')).toBeUndefined();
  });
});

const refresh = (
  fx: ReturnType<typeof makeProject>,
  p: Ports,
  platform: NodeJS.Platform = 'darwin',
) =>
  refreshCache({
    stateRoot: fx.state,
    ownerRoot: fx.owner,
    originUrl: fx.origin,
    ownerConfig: owner,
    ports: p,
    platform,
    env: fx.env,
    home: fx.home,
  });

describe('studio cache refresh', () => {
  it('builds main in its own clone and publishes the seeds in one swap', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n', 'Cargo.lock': '', 'pnpm-lock.yaml': '' });
    const x = fakeExec();
    const r = await refresh(fx, ports(x.exec));
    expect(r.steps).toEqual(['cargo fetch', 'cargo build', 'pnpm fetch', 'pnpm install']);
    expect(r.seeds).toEqual(['cargo-target', 'cargo-registry', 'pnpm-store']);
    expect(r.sha).toBe(git(fx.project, 'rev-parse', 'HEAD'));
    const cargoCalls = x.calls.filter((c) => c.cmd === 'cargo');
    expect(cargoCalls.map((c) => c.args)).toEqual([
      ['fetch', '--locked'],
      ['build', '--workspace', '--all-targets', '--offline', '--locked'],
    ]);
    const cargo = cargoCalls[1] as Call;
    expect(cargo.env.CARGO_TARGET_DIR).toBe(join(fx.state, 'cache-build', 'target'));
    expect(cargo.env.CARGO_HOME).toBe(join(fx.state, 'cache-build', 'cargo-home'));
    expect(cargo.env.HOME).toBe(join(fx.state, 'cache-build', 'home'));
    // No token and nothing else of the owner's environment reaches a build.
    expect(Object.keys(cargo.env).sort()).toEqual(
      ['CARGO_HOME', 'CARGO_TARGET_DIR', 'HOME', 'PATH', 'PNPM_CONFIG_STORE_DIR', 'TMPDIR'].sort(),
    );
    expect(x.calls.filter((c) => c.cmd === 'pnpm').map((c) => c.args)).toEqual([
      ['fetch', '--frozen-lockfile'],
      ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'],
    ]);
    expect(existsSync(join(cacheDir(fx.state), 'seeds', 'cargo-target', 'debug', 'deps'))).toBe(
      true,
    );
    expect(readCacheMeta(fx.state)).toMatchObject({
      sha: r.sha,
      seeds: r.seeds,
      refreshedAt: '2026-11-05T10:00:00.000Z',
    });
    // Never a crew clone.
    expect(existsSync(join(fx.state, 'clones'))).toBe(false);
  });

  it('a failed or timed-out step publishes nothing and keeps the old seeds', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    await refresh(fx, ports(fakeExec().exec));
    const before = readCacheMeta(fx.state);
    for (const code of [1, 124]) {
      const p = ports(fakeExec({ fail: ['cargo'], code }).exec, '2026-11-20T10:00:00Z');
      await expect(refresh(fx, p)).rejects.toThrow(code === 124 ? /timed out/ : /failed \(1\)/);
      expect(readCacheMeta(fx.state)).toEqual(before);
    }
  });

  it('refuses a file system without copy-on-write, and a main with nothing to build', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    await expect(refresh(fx, ports(fakeExec({ fail: ['cp'] }).exec))).rejects.toThrow(
      /without copy-on-write/,
    );
    await expect(refresh(fx, ports(fakeExec().exec), 'win32')).rejects.toThrow(/not supported/);
    const empty = makeProject();
    await expect(refresh(empty, ports(fakeExec().exec))).rejects.toThrow(/nothing to cache/);
    expect(readCacheMeta(fx.state)).toBeUndefined();
  });

  it('refuses to publish a cache over the size cap', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    const tiny = { ...owner, cache: { maxGb: 1e-9 } };
    await expect(
      refreshCache({
        stateRoot: fx.state,
        ownerRoot: fx.owner,
        originUrl: fx.origin,
        ownerConfig: tiny,
        ports: ports(fakeExec().exec),
        platform: 'darwin',
        env: fx.env,
        home: fx.home,
      }),
    ).rejects.toThrow(/cache\.max_gb/);
    expect(readCacheMeta(fx.state)).toBeUndefined();
  });

  it('is due weekly, and only once a cache exists', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    expect(refreshDue(fx.state, new Date('2026-12-01T00:00:00Z'))).toBe(false);
    await refresh(fx, ports(fakeExec().exec));
    expect(refreshDue(fx.state, new Date('2026-11-11T10:00:00Z'))).toBe(false);
    expect(refreshDue(fx.state, new Date('2026-11-12T10:00:00Z'))).toBe(true);
  });
});

/** The paths of `(subpath "…")` in the rules of a profile whose lines start with `head`. */
const ruleSubpaths = (profile: string, head: string): string[] =>
  profile
    .split('\n')
    .filter((l) => l.startsWith(head))
    .flatMap((l) => [...l.matchAll(/\(subpath "([^"]+)"\)/g)].map((m) => m[1] as string));

describe('every refresh step runs in the OS sandbox', () => {
  const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

  it('on macOS: Seatbelt, writes only below the build dir, owner paths unreadable', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n', 'pnpm-lock.yaml': '' });
    const x = fakeExec();
    await refresh(fx, ports(x.exec));
    const steps = x.calls.filter((c) => c.cmd === 'cargo' || c.cmd === 'pnpm');
    expect(steps).toHaveLength(4);
    const build = join(fx.state, 'cache-build');
    const realBuild = realpathSync(build);
    for (const step of steps) {
      const profile = step.profile as string;
      expect(profile, `${step.cmd} ${step.args[0]}`).toBeDefined();
      const writable = ruleSubpaths(profile, '(allow file-write*');
      expect(writable.length).toBeGreaterThan(0);
      for (const w of writable) {
        expect(inside(w, build) || inside(w, realBuild), w).toBe(true);
      }
      for (const ownerPath of [fx.home, fx.project, fx.owner, join(fx.state, 'clones')]) {
        expect(writable.some((w) => inside(ownerPath, w))).toBe(false);
      }
      const denied = ruleSubpaths(profile, '(deny file-read*');
      expect(denied).toContain(fx.home);
      expect(denied).toContain(join(fx.home, '.local', 'state', 'studio'));
      expect(denied).toContain(join(fx.home, '.ssh'));
      // The build clone's git dir is read by owner-side git on the next refresh: never written.
      expect(ruleSubpaths(profile, '(deny file-write*')).toContain(join(build, 'src', '.git'));
      expect(step.env.GH_TOKEN).toBeUndefined();
    }
    // Network only for the fetch steps, which run no project code.
    for (const step of steps) {
      const fetch = step.args[0] === 'fetch';
      expect(step.profile?.includes('(deny network*)'), `${step.cmd} ${step.args[0]}`).toBe(!fetch);
    }
  });

  it('on Linux: bubblewrap, binding only the build dir writable, no network to build', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    const x = fakeExec();
    await refresh(fx, ports(x.exec), 'linux');
    const build = join(fx.state, 'cache-build');
    const realBuild = realpathSync(build);
    const steps = x.calls.filter((c) => c.cmd === 'cargo');
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      const args = step.bwrap as string[];
      const binds = args.flatMap((a, i) => (a === '--bind' ? [args[i + 1] as string] : []));
      expect(binds.length).toBeGreaterThan(0);
      for (const b of binds) expect(inside(b, build) || inside(b, realBuild), b).toBe(true);
      expect(args[args.indexOf(fx.home) - 1]).toBe('--tmpfs');
      expect(args.includes('--unshare-net')).toBe(step.args[0] !== 'fetch');
    }
  });

  it('refuses a platform without a sandbox', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    await expect(refresh(fx, ports(fakeExec().exec), 'freebsd')).rejects.toThrow(/not supported/);
  });

  it.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))(
    'the Seatbelt profile holds for real: no read of the home, no write outside it',
    async () => {
      const { seatbeltProfile } = await import('../src/build-sandbox.js');
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-sbx-')));
      try {
        const home = join(base, 'home');
        const build = join(home, 'state', 'cache-build');
        mkdirSync(build, { recursive: true });
        writeFileSync(join(home, 'secret'), 'top');
        const profile = seatbeltProfile({
          denyRead: [home],
          allowRead: [],
          allowWrite: [build],
          denyWrite: [],
          network: false,
        });
        const sh = (script: string) =>
          spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], {
            encoding: 'utf8',
          });
        expect(sh(`cat ${home}/secret`).status).not.toBe(0);
        expect(sh(`echo x > ${home}/planted`).status).not.toBe(0);
        expect(existsSync(join(home, 'planted'))).toBe(false);
        expect(sh(`echo x > ${build}/out && cat ${build}/out`).stdout).toBe('x\n');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});

describe('the repository cannot configure the refresh build', () => {
  it('starts every refresh with a fresh CARGO_HOME', async () => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    await refresh(fx, ports(fakeExec().exec));
    const planted = join(fx.state, 'cache-build', 'cargo-home', 'config.toml');
    writeFileSync(planted, '[build]\nrustc-wrapper = "/tmp/x"\n');
    await refresh(fx, ports(fakeExec().exec, '2026-11-20T10:00:00Z'));
    expect(existsSync(planted)).toBe(false);
  });

  it.each([
    ['.cargo/config.toml', '[build]\nrustc-wrapper = "/tmp/evil"\n'],
    ['.cargo/config', '[build]\ntarget-dir = "/tmp/elsewhere"\n'],
    ['rust-toolchain.toml', '[toolchain]\npath = "/opt/evil-toolchain"\n'],
    ['rust-toolchain', '/opt/evil-toolchain\n'],
  ])('refuses a checkout with %s unless the owner trusts it', async (file, text) => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    mkdirSync(join(fx.project, '.cargo'), { recursive: true });
    writeFileSync(join(fx.project, file), text);
    git(fx.project, 'add', '-f', file);
    git(fx.project, 'commit', '-q', '-m', 'config');
    git(fx.project, 'push', '-q', 'origin', 'main');
    const x = fakeExec();
    await expect(refresh(fx, ports(x.exec))).rejects.toThrow(/--trust-repo-config/);
    expect(x.calls.some((c) => c.cmd === 'cargo')).toBe(false);
    expect(readCacheMeta(fx.state)).toBeUndefined();
    const trusted = fakeExec();
    await refreshCache({
      stateRoot: fx.state,
      ownerRoot: fx.owner,
      originUrl: fx.origin,
      ownerConfig: owner,
      ports: ports(trusted.exec),
      platform: 'darwin',
      env: fx.env,
      home: fx.home,
      trustRepoConfig: true,
    });
    expect(trusted.calls.some((c) => c.cmd === 'cargo')).toBe(true);
  });

  it('a plain toolchain channel is fine', async () => {
    const fx = makeProject({
      'Cargo.toml': '[package]\n',
      'rust-toolchain.toml': '[toolchain]\nchannel = "1.90"\n',
    });
    await expect(refresh(fx, ports(fakeExec().exec))).resolves.toMatchObject({
      seeds: expect.any(Array),
    });
  });
});

describe('seeding a crew', () => {
  const seeded = async (freshClone: boolean, withCargo = true) => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n', 'pnpm-lock.yaml': '' });
    await refresh(fx, ports(fakeExec().exec));
    const clone = join(fx.state, 'clones', 'APP-1');
    const homeDir = join(fx.state, 'homes', 'APP-1');
    mkdirSync(clone, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    if (withCargo) writeFileSync(join(clone, 'Cargo.toml'), '');
    const x = fakeExec();
    const r = await seedCrew({
      stateRoot: fx.state,
      clone,
      homeDir,
      freshClone,
      ports: ports(x.exec),
      platform: 'darwin',
    });
    return { fx, r, x, clone, homeDir };
  };

  it('copies each seed into the crew’s own places and points pnpm at its store', async () => {
    const { fx, r, x, clone, homeDir } = await seeded(true);
    expect(r.seeded).toEqual(['cargo-target', 'cargo-registry', 'pnpm-store']);
    expect(r.cacheDir).toBe(cacheDir(fx.state));
    expect(r.env).toEqual({ PNPM_CONFIG_STORE_DIR: join(homeDir, '.pnpm-store') });
    expect(x.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      [
        'cp',
        '-c',
        '-R',
        '-p',
        join(cacheDir(fx.state), 'seeds', 'cargo-target'),
        join(clone, 'target'),
      ],
      [
        'cp',
        '-c',
        '-R',
        '-p',
        join(cacheDir(fx.state), 'seeds', 'cargo-registry'),
        join(homeDir, '.cargo', 'registry'),
      ],
      [
        'cp',
        '-c',
        '-R',
        '-p',
        join(cacheDir(fx.state), 'seeds', 'pnpm-store'),
        join(homeDir, '.pnpm-store'),
      ],
    ]);
    expect(readCacheMeta(fx.state)?.lastUsedAt).toBe('2026-11-05T10:00:00.000Z');
  });

  it('never copies into a clone a crew has run in, nor into a target that exists', async () => {
    const reused = await seeded(false);
    expect(reused.r.seeded).not.toContain('cargo-target');
    const noCargo = await seeded(true, false);
    expect(noCargo.r.seeded).not.toContain('cargo-target');
  });

  it('skips everything without a cache', async () => {
    const fx = makeProject();
    const x = fakeExec();
    const r = await seedCrew({
      stateRoot: fx.state,
      clone: join(fx.state, 'clones', 'APP-1'),
      homeDir: join(fx.state, 'homes', 'APP-1'),
      freshClone: true,
      ports: ports(x.exec),
      platform: 'darwin',
    });
    expect(r).toEqual({ seeded: [], env: {} });
    expect(x.calls).toEqual([]);
  });
});

const config: StudioConfig = studioConfigSchema.parse({
  studio: 1,
  primaryRepo: 'org/app',
  repos: ['org/app'],
  ci: {
    provider: 'github',
    runners: 'github-hosted',
    runnerLabels: [],
    capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 30 },
  },
  merge: { strategy: 'studio-queue', contractPaths: [] },
  roles: { builder: { model: 'sonnet', wip: 2 } },
  sandbox: { networkAllow: ['github.com'] },
  allowAmbientCredentials: true,
});

const item: WorkItem = {
  id: 'APP-12',
  title: 'Fix the thing',
  type: 'fix',
  role: 'builder',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'assigned',
  paths: [],
  touches: [],
  dependsOn: [],
  dod: [],
  history: [],
};

describe('a crew launch and the cache', () => {
  const launch = async (withCache: boolean) => {
    const fx = makeProject({ 'Cargo.toml': '[package]\n' });
    // Bound to the project, as `studio cache refresh` leaves it.
    checkStateMarker(fx.state, {
      projectRealpath: projectRealpath(fx.project),
      originUrl: git(fx.project, 'remote', 'get-url', 'origin'),
    });
    if (withCache) await refresh(fx, ports(fakeExec().exec));
    const x = fakeExec();
    const started: Record<string, string>[] = [];
    const p = ports(x.exec);
    p.claude.start = async (_cwd, _args, _prompt, _log, env) => {
      started.push(env);
      return { pid: 4242 };
    };
    await launchCrew(fx.project, item, config, p, {
      homedir: fx.home,
      env: fx.env,
      platform: 'darwin',
    });
    const settings = JSON.parse(readFileSync(join(fx.state, 'settings', 'APP-12.json'), 'utf8'));
    const ctx = JSON.parse(readFileSync(join(fx.state, 'guard', 'APP-12.json'), 'utf8'));
    return { fx, x, settings, ctx, env: started[0] as Record<string, string> };
  };

  it('includes the seed step when the cache exists: read-only in the sandbox', async () => {
    const { fx, x, settings, ctx } = await launch(true);
    const cache = cacheDir(fx.state);
    expect(
      x.calls.some(
        (c) => c.cmd === 'cp' && c.args.at(-1) === join(fx.state, 'clones', 'APP-12', 'target'),
      ),
    ).toBe(true);
    expect(settings.sandbox.filesystem.allowRead).toContain(cache);
    const writable: string[] = settings.sandbox.filesystem.allowWrite;
    expect(
      writable.some((w) => w === cache || cache.startsWith(`${w}/`) || w.startsWith(`${cache}/`)),
    ).toBe(false);
    expect(ctx.protectedPaths).toContain(cache);
    expect(ctx.protectedPaths).toContain(join(fx.state, 'cache-build'));
    // The guard refuses a crew write into the cache.
    const decision = evaluateGuard(
      { toolName: 'Write', toolInput: { file_path: join(cache, 'seeds', 'x'), content: 'x' } },
      ctx,
    );
    expect(decision.decision).toBe('deny');
  });

  it('skips the seed step without a cache', async () => {
    const { fx, x, settings, env } = await launch(false);
    expect(x.calls).toEqual([]);
    expect(settings.sandbox.filesystem.allowRead).not.toContain(cacheDir(fx.state));
    expect(env.PNPM_CONFIG_STORE_DIR).toBeUndefined();
  });
});

describe('the size cleanup', () => {
  it('removes the cache used longest ago until all fit, at most once a day', async () => {
    const base = join(root, `base${n++}`);
    const projects = ['0000000000000001-a', '0000000000000002-b'].map((name, i) => {
      const r = join(base, name);
      mkdirSync(join(r, 'cache', 'seeds', 'cargo-target'), { recursive: true });
      writeFileSync(join(r, 'cache', 'seeds', 'cargo-target', 'big'), 'x'.repeat(200_000));
      writeFileSync(
        join(r, 'cache', 'cache.json'),
        JSON.stringify({
          refreshedAt: '2026-11-01T00:00:00.000Z',
          sha: 'a'.repeat(40),
          seeds: ['cargo-target'],
          sizeBytes: 1,
          lastUsedAt: `2026-11-0${i + 2}T00:00:00.000Z`,
        }),
      );
      mkdirSync(join(r, 'cache-build'), { recursive: true });
      return r;
    });
    const ownerRoot = join(base, 'owner');
    mkdirSync(ownerRoot);
    const cfg = { ...owner, cache: { maxGb: 0.0003 } };
    const now = new Date('2026-11-05T10:00:00Z');
    const removed = await cacheCleanup({ stateBase: base, ownerRoot, ownerConfig: cfg, now });
    expect(removed).toEqual([projects[0]]);
    expect(existsSync(join(projects[0] as string, 'cache'))).toBe(false);
    expect(existsSync(join(projects[0] as string, 'cache-build'))).toBe(false);
    expect(readCacheMeta(projects[1] as string)).toBeDefined();
    expect(existsSync(join(ownerRoot, CACHE_GC_FILE))).toBe(true);
    // Not again the same day.
    const again = { ...cfg, cache: { maxGb: 1e-9 } };
    expect(
      await cacheCleanup({ stateBase: base, ownerRoot, ownerConfig: again, now }),
    ).toBeUndefined();
    const tomorrow = new Date('2026-11-06T10:00:01Z');
    expect(
      await cacheCleanup({ stateBase: base, ownerRoot, ownerConfig: again, now: tomorrow }),
    ).toEqual([projects[1]]);
  });
});

// ---- Through the CLI -------------------------------------------------------------------------

const STUDIO_YAML = `studio: 1
primary_repo: org/app
repos: [org/app]
allow_ambient_credentials: true
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 8, merge_max_busy: 5, check_twice_seconds: 30 }
merge: { strategy: studio-queue, contract_paths: [], method: squash }
roles:
  builder: { model: sonnet, wip: 3 }
owner_only: []
deploy_commands: []
`;

/** `autoRefresh`: `cache: { auto_refresh: true }` in studio.yaml. */
function cliProject(autoRefresh = false) {
  const fx = makeProject({ 'Cargo.toml': '[package]\n' });
  mkdirSync(join(fx.project, '.studio'));
  writeFileSync(
    join(fx.project, '.studio', 'studio.yaml'),
    `${STUDIO_YAML}${autoRefresh ? 'cache: { auto_refresh: true }\n' : ''}`,
  );
  writeFileSync(join(fx.project, '.studio', 'board.yaml'), 'items: []\n');
  checkStateMarker(fx.state, {
    projectRealpath: projectRealpath(fx.project),
    originUrl: git(fx.project, 'remote', 'get-url', 'origin'),
  });
  return fx;
}

/** The owner's half of the opt-in to the weekly refresh. */
function optInOwner(fx: ReturnType<typeof makeProject>) {
  const dir = join(fx.home, '.config', 'studio');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), 'cache: { auto_refresh: true }\n');
}

async function cli(
  fx: ReturnType<typeof makeProject>,
  p: Ports,
  argv: string[],
  extra: Partial<CliDeps> = {},
) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', fx.project, ...argv], {
    ports: p,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: fx.env,
    homedir: fx.home,
    cwd: fx.project,
    ...extra,
  });
  return { code, out, err };
}

describe('studio cache in the CLI', () => {
  it('refresh builds the cache, status shows its size and age', async () => {
    const fx = cliProject();
    const p = ports(fakeExec().exec);
    const before = JSON.parse((await cli(fx, p, ['cache', 'status'])).out);
    expect(before).toMatchObject({ exists: false, maxGb: 20 });
    const r = await cli(fx, p, ['cache', 'refresh']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ seeds: ['cargo-target', 'cargo-registry'] });
    p.set('2026-11-08T10:00:00Z');
    const status = JSON.parse((await cli(fx, p, ['cache', 'status'])).out);
    expect(status).toMatchObject({ exists: true, ageDays: 3, maxGb: 20 });
    expect(status.sizeBytes).toBeGreaterThan(0);
  });

  it('refresh refuses main’s cargo config until the owner passes --trust-repo-config', async () => {
    const fx = cliProject();
    mkdirSync(join(fx.project, '.cargo'));
    writeFileSync(join(fx.project, '.cargo', 'config.toml'), '[build]\nrustc-wrapper = "/x"\n');
    git(fx.project, 'add', '-f', '.cargo/config.toml');
    git(fx.project, 'commit', '-q', '-m', 'cargo config');
    git(fx.project, 'push', '-q', 'origin', 'main');
    const p = ports(fakeExec().exec);
    const r = await cli(fx, p, ['cache', 'refresh']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/\.cargo\/config\.toml .*--trust-repo-config/);
    expect((await cli(fx, p, ['cache', 'refresh', '--trust-repo-config'])).code).toBe(0);
    expect((await cli(fx, p, ['cache', 'status', '--trust-repo-config'])).code).not.toBe(0);
  });

  it('refresh is not for crews', async () => {
    const fx = cliProject();
    fx.env.STUDIO_ROLE = 'crew';
    const r = await cli(fx, ports(fakeExec().exec), ['cache', 'refresh']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/not for crew sessions/);
  });

  it('tick never refreshes without the opt-in in both studio.yaml and the owner config', async () => {
    for (const [inProject, inOwner] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const fx = cliProject(inProject);
      if (inOwner) optInOwner(fx);
      const x = fakeExec();
      const p = ports(x.exec);
      await cli(fx, p, ['cache', 'refresh']);
      p.set('2026-11-13T10:00:00Z');
      const t = JSON.parse(
        (await cli(fx, p, ['tick'], { launcher: '/opt/studio/bin/studio' })).out,
      );
      expect(x.detached).toEqual([]);
      expect(t.cache).toBeUndefined();
    }
  });

  it('tick starts a refresh in the background once a week, and only for a cache that exists', async () => {
    const fx = cliProject(true);
    optInOwner(fx);
    const x = fakeExec();
    const p = ports(x.exec);
    const deps = { launcher: '/opt/studio/bin/studio' };
    await cli(fx, p, ['tick'], deps);
    expect(x.detached).toEqual([]);
    await cli(fx, p, ['cache', 'refresh']);
    p.set('2026-11-13T10:00:00Z');
    const t = JSON.parse((await cli(fx, p, ['tick'], deps)).out);
    expect(x.detached).toHaveLength(1);
    expect(x.detached[0]?.args).toEqual([
      '/opt/studio/bin/studio',
      '--project',
      fx.project,
      'cache',
      'refresh',
    ]);
    expect(x.detached[0]?.env.STUDIO_ROLE).toBeUndefined();
    expect(t.cache).toMatchObject({ refresh: 'started' });
    // The next tick does not start a second one while the first may still run.
    await cli(fx, p, ['tick'], deps);
    expect(x.detached).toHaveLength(1);
  });
});
