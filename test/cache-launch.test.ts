import { execFileSync } from 'node:child_process';
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
  type CowCopy,
  cloneHead,
  publishCache,
  readCacheMeta,
  readCacheRun,
} from '../src/cache.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import { type LauncherEnv, launchCrew } from '../src/crew.js';
import { evaluateGuard } from '../src/guard.js';
import { ownerStateRootFor, stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { reportName } from '../src/report.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-cache-launch-')));
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
/** A project whose main holds `files`, with its own fake owner home. */
function fixture(files: Record<string, string>) {
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
  const launcher: LauncherEnv = { homedir: home, env: { PATH: process.env.PATH } };
  return {
    project,
    launcher,
    state: stateRootFor(project, launcher),
    owner: ownerStateRootFor(launcher),
    sha: git(project, 'rev-parse', 'HEAD'),
  };
}

const cow: CowCopy = async (src, dst) => {
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  return true;
};

interface Started {
  args: string[];
  env: Record<string, string>;
}
function ports(started: Started[]): Ports {
  return {
    ...realPorts(),
    cow,
    claude: {
      async start(_cwd, args, _prompt, _log, env) {
        started.push({ args, env });
        return { pid: 4242 };
      },
      alive: () => false,
      identity: async () => 'start-4242',
      stop: async () => {},
    },
  };
}

const config = (cache: boolean): StudioConfig =>
  studioConfigSchema.parse({
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
    roles: { builder: { model: 'sonnet', wip: 2 }, cache: { model: 'haiku', wip: 1 } },
    sandbox: { networkAllow: ['github.com', 'crates.io', 'static.crates.io', 'index.crates.io'] },
    allowAmbientCredentials: true,
    ...(cache ? { cache: { enabled: true, timeoutMin: 90 } } : {}),
  });

const base = {
  repo: 'org/app',
  size: 'S' as const,
  priority: 1,
  status: 'assigned' as const,
  paths: [],
  touches: [],
  dependsOn: [],
  dod: [],
  history: [],
};
const cacheItem: WorkItem = {
  ...base,
  id: 'APP-7',
  title: 'Build the shared build cache from main',
  type: 'research',
  role: 'cache',
};
const builder: WorkItem = {
  ...base,
  id: 'APP-8',
  title: 'Fix it',
  type: 'fix',
  role: 'builder',
};

const CARGO = { 'Cargo.toml': '[package]\nname = "x"\n', 'Cargo.lock': '' };

describe('launching a cache crew', () => {
  it('a fresh clone of main, its commands in the brief and the guard, no token, long Bash calls', async () => {
    const f = fixture(CARGO);
    const started: Started[] = [];
    await launchCrew(f.project, cacheItem, config(true), ports(started), f.launcher);
    const clone = join(f.state, 'clones', 'APP-7');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(f.sha);
    const commands = ['cargo fetch --locked', 'cargo build --workspace --all-targets --locked'];
    expect(readCacheRun(f.state, 'APP-7')).toMatchObject({ sha: f.sha, commands });
    const brief = readFileSync(join(f.state, 'briefs', 'APP-7.md'), 'utf8');
    expect(brief).toContain('## Build cache');
    expect(brief).toContain(`main at ${f.sha}`);
    expect(brief).toContain('1. `cargo fetch --locked`');
    expect(brief).toContain('timeout of 90 minutes');
    const ctx = JSON.parse(readFileSync(join(f.state, 'guard', 'APP-7.json'), 'utf8'));
    expect(ctx.onlyCommands).toEqual(commands);
    const report = join(clone, '.studio', 'reports', reportName(f.state, 'APP-7') as string);
    expect(ctx.onlyWrites).toEqual([report]);
    expect(ctx.noPush).toBe(true);
    const run = (toolName: string, toolInput: Record<string, unknown>) =>
      evaluateGuard({ toolName, toolInput, cwd: clone }, ctx).decision;
    expect(run('Bash', { command: 'cargo fetch --locked' })).toBe('allow');
    expect(run('Bash', { command: 'touch src/a.rs' })).toBe('deny');
    expect(run('Write', { file_path: report, content: 'x' })).toBe('allow');
    expect(run('Write', { file_path: join(clone, 'build.rs'), content: 'x' })).toBe('deny');
    const env = (started[0] as Started).env;
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(90 * 60_000));
    expect(env.BASH_MAX_TIMEOUT_MS).toBe(String(90 * 60_000));
    expect(env.PNPM_CONFIG_STORE_DIR).toBe(join(f.state, 'homes', 'APP-7', '.pnpm-store'));
    expect((started[0] as Started).args).toContain('haiku');
  });

  it('starts over in a fresh clone even when one is left, and is never seeded', async () => {
    const f = fixture(CARGO);
    const p = ports([]);
    await launchCrew(f.project, cacheItem, config(true), p, f.launcher);
    const clone = join(f.state, 'clones', 'APP-7');
    writeFileSync(join(clone, 'planted.rs'), 'x');
    mkdirSync(join(clone, 'target'));
    await launchCrew(f.project, cacheItem, config(true), p, f.launcher);
    expect(existsSync(join(clone, 'planted.rs'))).toBe(false);
    expect(existsSync(join(clone, 'target'))).toBe(false);
  });

  it('binds the run record to its crew record; any other launch of the id removes it', async () => {
    const f = fixture(CARGO);
    await launchCrew(f.project, cacheItem, config(true), ports([]), f.launcher);
    const run = readCacheRun(f.state, 'APP-7');
    const records = JSON.parse(readFileSync(join(f.state, 'crew.json'), 'utf8'));
    expect(run?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(records['APP-7'].cacheRun).toBe(run?.nonce);
    // The clone the run left reads as main's commit, from files.
    expect(cloneHead(join(f.state, 'clones', 'APP-7'))).toBe(f.sha);
    const other = { ...builder, id: 'APP-7' };
    await launchCrew(f.project, other, config(true), ports([]), f.launcher);
    expect(readCacheRun(f.state, 'APP-7')).toBeUndefined();
    const after = JSON.parse(readFileSync(join(f.state, 'crew.json'), 'utf8'));
    expect(after['APP-7'].cacheRun).toBeUndefined();
  });

  it('refuses while the cache is off, and on a main with nothing to cache', async () => {
    const f = fixture(CARGO);
    await expect(
      launchCrew(f.project, cacheItem, config(false), ports([]), f.launcher),
    ).rejects.toThrow(/build cache, which is off/);
    const g = fixture({});
    await expect(
      launchCrew(g.project, cacheItem, config(true), ports([]), g.launcher),
    ).rejects.toThrow(/nothing to cache/);
    await expect(
      launchCrew(f.project, { ...cacheItem, type: 'chore' }, config(true), ports([]), f.launcher),
    ).rejects.toThrow(/research item/);
  });
});

describe('other crews start from the cache', () => {
  async function published() {
    const f = fixture(CARGO);
    await launchCrew(f.project, cacheItem, config(true), ports([]), f.launcher);
    const clone = join(f.state, 'clones', 'APP-7');
    const homeDir = join(f.state, 'homes', 'APP-7');
    mkdirSync(join(clone, 'target', 'debug'), { recursive: true });
    writeFileSync(join(clone, 'target', 'debug', 'x.rlib'), 'rlib');
    mkdirSync(join(homeDir, '.cargo', 'registry'), { recursive: true });
    writeFileSync(join(homeDir, '.cargo', 'registry', 'x.crate'), 'crate');
    await publishCache({
      stateRoot: f.state,
      ownerRoot: f.owner,
      item: 'APP-7',
      clone,
      homeDir,
      ownerConfig: {},
      cow,
      now: new Date(),
      crewNonce: readCacheRun(f.state, 'APP-7')?.nonce,
    });
    expect(readCacheMeta(f.state)?.sha).toBe(f.sha);
    return f;
  }

  it('a builder gets copies in its fresh clone and HOME', async () => {
    const f = await published();
    const started: Started[] = [];
    await launchCrew(f.project, builder, config(true), ports(started), f.launcher);
    expect(
      readFileSync(join(f.state, 'clones', 'APP-8', 'target', 'debug', 'x.rlib'), 'utf8'),
    ).toBe('rlib');
    const home = join(f.state, 'homes', 'APP-8');
    expect(existsSync(join(home, '.cargo', 'registry', 'x.crate'))).toBe(true);
    expect((started[0] as Started).env.PNPM_CONFIG_STORE_DIR).toBe(join(home, '.pnpm-store'));
    // The cache itself stays out of the crew's reach: the state base is denied, nothing re-allowed.
    const settings = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-8.json'), 'utf8'));
    const fs = settings.sandbox.filesystem;
    expect(fs.denyRead).toContain(join(f.state, '..'));
    expect([...fs.allowRead, ...fs.allowWrite].some((p: string) => p.includes('/cache'))).toBe(
      false,
    );
  });

  it('with the cache off nothing is copied', async () => {
    const f = await published();
    const started: Started[] = [];
    await launchCrew(f.project, builder, config(false), ports(started), f.launcher);
    expect(existsSync(join(f.state, 'clones', 'APP-8', 'target'))).toBe(false);
    expect((started[0] as Started).env.PNPM_CONFIG_STORE_DIR).toBeUndefined();
  });
});
