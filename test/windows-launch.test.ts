import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import { type LauncherEnv, launchCrew } from '../src/crew.js';
import { LOOPBACK } from '../src/egress-proxy.js';
import { stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import type { Grant } from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-win-launch-')));
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
function fixture() {
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
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  const launcher: LauncherEnv = {
    homedir: home,
    env: { PATH: process.env.PATH, SystemRoot: 'C:\\Windows' },
    platform: 'win32',
  };
  return {
    project,
    launcher,
    state: stateRootFor(project, launcher),
    sha: git(project, 'rev-parse', 'HEAD'),
  };
}

interface Started {
  env: Record<string, string>;
}
const ports = (started: Started[]): Ports => ({
  ...realPorts(),
  claude: {
    async start(_cwd, _args, _prompt, _log, env) {
      started.push({ env });
      return { pid: 4242 };
    },
    alive: () => false,
    identity: async () => 'host:abc',
    stop: async () => {},
  },
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
  id: 'APP-3',
  title: 'Fix it',
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
  runsOn: 'windows',
};

describe('a crew launch on native Windows', () => {
  it('refuses without the Windows crew sandbox, before anything starts', async () => {
    const f = fixture();
    const started: Started[] = [];
    await expect(
      launchCrew(
        f.project,
        { ...item, runsOn: undefined } as WorkItem,
        config,
        ports(started),
        f.launcher,
      ),
    ).rejects.toThrow(/native Windows has no Claude Code sandbox/);
    await expect(
      launchCrew(f.project, item, config, ports(started), f.launcher, {
        deny: { paths: [], ports: [] },
        sha: f.sha,
      }),
    ).rejects.toThrow(/native Windows has no Claude Code sandbox/);
    expect(started).toEqual([]);
  });

  it('as the crew user: its own places granted, Claude Code sandbox off, all traffic via the proxy', async () => {
    const f = fixture();
    const started: Started[] = [];
    const granted: Grant[] = [];
    await launchCrew(f.project, item, config, ports(started), f.launcher, {
      deny: { paths: [], ports: [] },
      sha: f.sha,
      windows: {
        user: 'studio-crew',
        proxyPort: 4567,
        grant: async (g) => {
          granted.push(...g);
        },
      },
    });
    const s = f.state;
    expect(granted).toEqual([
      { path: join(s, 'clones', 'APP-3'), rights: 'M' },
      { path: join(s, 'homes', 'APP-3'), rights: 'M' },
      { path: join(s, 'tmp', 'APP-3'), rights: 'M' },
      { path: join(s, 'tmp', 'APP-3.host'), rights: 'M' },
      { path: join(s, 'briefs', 'APP-3.md'), rights: 'R' },
      { path: join(s, 'briefs', 'APP-3.caps'), rights: 'R' },
      { path: join(s, 'settings', 'APP-3.json'), rights: 'R' },
      { path: join(s, 'settings', 'APP-3.mcp.json'), rights: 'R' },
      { path: join(s, 'guard', 'APP-3.json'), rights: 'R' },
      { path: join(s, 'logs', 'APP-3.jsonl'), rights: 'W' },
    ]);
    const settings = JSON.parse(readFileSync(join(s, 'settings', 'APP-3.json'), 'utf8'));
    expect(settings.sandbox).toEqual({ enabled: false });
    expect(settings.hooks.PreToolUse[0].hooks[0].command).not.toContain('\\');
    const env = (started[0] as Started).env;
    expect(env.HTTPS_PROXY).toBe(`http://${LOOPBACK}:4567`);
    expect(env.USERPROFILE).toBe(join(s, 'homes', 'APP-3'));
    expect(env.SystemRoot).toBe('C:\\Windows');
  });
});
