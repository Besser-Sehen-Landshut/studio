import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname as dirnameOf, isAbsolute, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import {
  crewName,
  crewSessionId,
  type LauncherEnv,
  launchCrew,
  prepareCheckout,
  writeBrief,
  writeCrewSettings,
  writeHomeFile,
} from '../src/crew.js';
import { DEFAULT_SECRET_GLOBS, evaluateGuard } from '../src/guard.js';
import { stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-crew-')));
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
/** Bare origin plus a clone with one commit on main. Returns the clone (the "project dir"). */
function makeProject(): string {
  return makeFixture().project;
}

interface Fixture {
  project: string;
  home: string;
  launcher: LauncherEnv;
  state: string;
}

/** A project plus its own fake owner home (so state roots never collide or touch the real home). */
function makeFixture(env: Record<string, string | undefined> = {}): Fixture {
  const base = join(root, `p${n++}`);
  mkdirSync(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const launcher: LauncherEnv = { homedir: home, env: { PATH: process.env.PATH, ...env } };
  const project = makeRepo(base);
  return { project, home, launcher, state: stateRootFor(project, launcher) };
}

function makeRepo(base: string): string {
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = join(base, 'clone');
  git(base, 'clone', '-q', origin, clone);
  git(clone, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(clone, 'README.md'), 'x\n');
  git(clone, 'add', 'README.md');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'main');
  return clone;
}

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
  roles: {
    builder: {
      model: 'sonnet',
      wip: 2,
      skills: {
        required: ['superpowers:test-driven-development'],
        allowed: ['x:ok'],
        denied: ['x:no'],
      },
    },
  },
  sandbox: { networkAllow: ['github.com', 'api.github.com'] },
  ownerOnly: ['gh release *'],
  deployCommands: ['make deploy'],
  crewAllowedWorkflows: ['ci.yml'],
  crewAllowedWorkflowRefs: ['main'],
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
  paths: ['src/a.ts'],
  touches: ['src/**'],
  dependsOn: [],
  dod: ['tests pass', 'docs updated'],
  history: [],
};

interface Started {
  cwd: string;
  args: string[];
  prompt: string;
  logPath: string;
  env: Record<string, string>;
}
function fakePorts(started: Started[]): Ports {
  const real = realPorts();
  return {
    ...real,
    claude: {
      async start(cwd, args, prompt, logPath, env) {
        started.push({ cwd, args, prompt, logPath, env });
        return { pid: 4242 };
      },
      alive: () => false,
      stop: async () => {},
    },
  };
}

const FAKE_HOME = join(root, 'fakehome');
const CRED_PATHS = [
  '.config/gh',
  '.git-credentials',
  '.ssh',
  '.netrc',
  '.gnupg',
  '.aws',
  '.docker/config.json',
  'Library/Keychains',
].map((p) => join(FAKE_HOME, p));

describe('crewName', () => {
  it('lowercases id', () => {
    expect(crewName(item)).toBe('studio-builder-app-12');
  });
});

describe('prepareCheckout', () => {
  it('clones the origin blob-less into the state root and branches from origin/main', async () => {
    const { project, state } = makeFixture();
    const a = await prepareCheckout(state, project, item, realPorts());
    expect(a.path).toBe(join(state, 'clones', 'APP-12'));
    expect(statSync(a.path).mode & 0o777).toBe(0o700);
    expect(statSync(join(state, 'clones')).mode & 0o777).toBe(0o700);
    expect(a.branch).toBe('studio/APP-12');
    expect(git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('studio/APP-12');
    expect(git(a.path, 'rev-parse', 'HEAD')).toBe(git(project, 'rev-parse', 'origin/main'));
    expect(git(a.path, 'remote', 'get-url', 'origin')).toBe(
      git(project, 'remote', 'get-url', 'origin'),
    );
  });

  it('is idempotent: a second call does not clone again', async () => {
    const { project, state } = makeFixture();
    const ports = realPorts();
    const a = await prepareCheckout(state, project, item, ports);
    writeFileSync(join(a.path, 'work.txt'), 'wip');
    const inode = statSync(join(a.path, '.git')).ino;
    const b = await prepareCheckout(state, project, item, ports);
    expect(b).toEqual(a);
    expect(existsSync(join(a.path, 'work.txt'))).toBe(true);
    expect(statSync(join(a.path, '.git')).ino).toBe(inode);
  });

  it('R61: re-clones a clone whose .git/config names another origin', async () => {
    const { project, state } = makeFixture();
    const a = await prepareCheckout(state, project, item, realPorts());
    writeFileSync(join(a.path, 'planted.txt'), 'x');
    const cfg = join(a.path, '.git', 'config');
    const url = git(project, 'remote', 'get-url', 'origin');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(url, 'https://example.com/org/evil.git'));
    const b = await prepareCheckout(state, project, item, realPorts());
    expect(b).toEqual(a);
    expect(existsSync(join(b.path, 'planted.txt'))).toBe(false);
    expect(git(b.path, 'remote', 'get-url', 'origin')).toBe(url);
  });

  it('removes and re-clones a directory that is not a valid clone', async () => {
    const { project, state } = makeFixture();
    const dir = join(state, 'clones', 'APP-12');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'junk.txt'), 'x');
    const a = await prepareCheckout(state, project, item, realPorts());
    expect(existsSync(join(a.path, 'junk.txt'))).toBe(false);
    expect(existsSync(join(a.path, 'README.md'))).toBe(true);
  });

  it('leaves the owner repo without a new worktree and rejects unsafe ids', async () => {
    const { project, state } = makeFixture();
    await prepareCheckout(state, project, item, realPorts());
    expect(existsSync(join(project, '.studio'))).toBe(false);
    const listed = git(project, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '));
    expect(listed).toHaveLength(1);
    await expect(
      prepareCheckout(state, project, { ...item, id: 'bad id;' }, realPorts()),
    ).rejects.toThrow(/item id/);
  });

  it('unlinks a symlink at clones/<id> without following it and clones again', async () => {
    const { project, state } = makeFixture();
    // A valid clone elsewhere: following the link would reuse it.
    const elsewhere = join(root, `elsewhere-${n++}`);
    git(root, 'clone', '-q', project, elsewhere);
    git(elsewhere, 'checkout', '-q', '-b', 'studio/APP-12');
    writeFileSync(join(elsewhere, 'keep'), 'x');
    mkdirSync(join(state, 'clones'), { recursive: true });
    symlinkSync(elsewhere, join(state, 'clones', 'APP-12'));
    const a = await prepareCheckout(state, project, item, realPorts());
    expect(lstatSync(a.path).isSymbolicLink()).toBe(false);
    expect(existsSync(join(a.path, 'keep'))).toBe(false);
    expect(existsSync(join(elsewhere, 'keep'))).toBe(true);
    expect(existsSync(join(elsewhere, '.git', 'HEAD'))).toBe(true);
  });
});

describe('writeBrief', () => {
  it('lists required skills of role, the item and the rules', () => {
    const { project, state } = makeFixture();
    mkdirSync(join(project, '.studio', 'roles'), { recursive: true });
    writeFileSync(join(project, '.studio', 'roles', 'builder.md'), 'ROLE-BRIEF-MARKER');
    const file = writeBrief(state, item, config, project);
    expect(file).toBe(join(state, 'briefs', 'APP-12.md'));
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('ROLE-BRIEF-MARKER');
    expect(text).toContain(
      'Invoke these skills first: studio:studio-crew, superpowers:test-driven-development',
    );
    expect(text).toContain('x:ok');
    expect(text).toContain('x:no');
    expect(text).toContain('APP-12');
    expect(text).toContain('Fix the thing');
    expect(text).toContain('docs updated');
    expect(text).toContain('git push -u origin HEAD:refs/heads/studio/APP-12');
    expect(text).toContain('gh pr create --title "APP-12: ');
    expect(text).toContain('--body-file');
    expect(text).toContain('git commit -F');
    expect(text).toContain('.studio/reports/APP-12.md');
    expect(text).toMatch(/status: done\|blocked\|failed/);
    expect(text).toMatch(/never merge/i);
  });

  it('review brief asks for a verdict and no pr', () => {
    const { project, state } = makeFixture();
    const text = readFileSync(
      writeBrief(state, { ...item, type: 'review' }, config, project),
      'utf8',
    );
    expect(text).toContain('verdict: approve|changes_requested');
    expect(text).toContain('reviews: <repo>#<pr>');
    expect(text).toMatch(/opens? no pull request/i);
    const build = readFileSync(writeBrief(state, item, config, project), 'utf8');
    expect(build).not.toContain('verdict:');
  });

  it('research brief asks for no pr and no verdict', () => {
    const { project, state } = makeFixture();
    const text = readFileSync(
      writeBrief(state, { ...item, type: 'research' }, config, project),
      'utf8',
    );
    expect(text).toMatch(/opens? no pull request/i);
    expect(text).not.toContain('pr: <number>');
    expect(text).not.toContain('head_sha: <');
    expect(text).not.toContain('verdict:');
    expect(text).not.toContain('reviews:');
    expect(text).toMatch(/result .*in the report body/i);
  });

  it('writes the report last and does not commit it', () => {
    const { project, state } = makeFixture();
    const text = readFileSync(writeBrief(state, item, config, project), 'utf8');
    expect(text).toContain('as the last step, after pushing; do not commit it');
    expect(text).toContain('`git rev-parse HEAD`');
    expect(text).not.toContain('commit it with the pull request');
  });

  it('lists studio:studio-crew once, first, even if the role lists it', () => {
    const { project, state } = makeFixture();
    const dup = {
      ...config,
      roles: {
        ...config.roles,
        builder: {
          ...config.roles.builder,
          skills: { required: ['a:one', 'studio:studio-crew'], allowed: [], denied: [] },
        },
      },
    } as typeof config;
    const text = readFileSync(writeBrief(state, item, dup, project), 'utf8');
    expect(text).toContain('Invoke these skills first: studio:studio-crew, a:one\n');
  });

  it('tells the crew to run the full test command and never report a partial count', () => {
    const { project, state } = makeFixture();
    const text = readFileSync(writeBrief(state, item, config, project), 'utf8');
    expect(text).toContain(
      "Run the project's full test command; tests_run is the count from that run.",
    );
    expect(text).toContain('never report a partial count');
  });

  it('works without a role brief file', () => {
    const { project, state } = makeFixture();
    expect(readFileSync(writeBrief(state, item, config, project), 'utf8')).toContain('APP-12');
  });
});

describe('writeCrewSettings', () => {
  const setup = (
    launcher: { env?: Record<string, string | undefined>; toolchain?: string[] } = {},
  ) => {
    const project = makeProject();
    const state = join(root, `state-${n++}`);
    const wt = join(state, 'clones', 'APP-12');
    const homeDir = join(state, 'homes', 'APP-12');
    const tmpDir = join(state, 'tmp', 'APP-12');
    const file = writeCrewSettings(
      state,
      item,
      wt,
      config,
      { homeDir, tmpDir, projectDir: project, toolchainPaths: launcher.toolchain ?? [] },
      { homedir: FAKE_HOME, env: launcher.env ?? {} },
    );
    return {
      project,
      state,
      wt,
      homeDir,
      tmpDir,
      file,
      s: JSON.parse(readFileSync(file, 'utf8')),
    };
  };

  it('env carries STUDIO_ROLE=crew and guard hook path is absolute', () => {
    const { state, file, s } = setup();
    expect(file).toBe(join(state, 'settings', 'APP-12.json'));
    expect(s.env).toEqual({
      STUDIO_ROLE: 'crew',
      STUDIO_ITEM: 'APP-12',
      STUDIO_PROJECT: 'org/app',
      STUDIO_GUARD_CTX: join(state, 'guard', 'APP-12.json'),
      STUDIO_STATE_DIR: state,
    });
    const pre = s.hooks.PreToolUse;
    expect(pre).toHaveLength(1);
    expect(pre[0].matcher).toBe('*');
    expect(pre[0].hooks[0].type).toBe('command');
    const m = /^node "(.+studio-guard\.mjs)"$/.exec(pre[0].hooks[0].command);
    expect(m).not.toBeNull();
    const hookPath = (m as RegExpExecArray)[1] as string;
    expect(isAbsolute(hookPath)).toBe(true);
    expect(existsSync(hookPath)).toBe(true);
    expect(s.disableAllHooks).toBe(false);
  });

  it('enables the sandbox limited to worktree and allowlist', () => {
    const { wt, tmpDir, homeDir, s } = setup();
    expect(s.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [wt, tmpDir, homeDir],
        // root is already a real path, so the state base appears once
        denyRead: [FAKE_HOME, ...CRED_PATHS, root],
        allowRead: [wt, tmpDir, homeDir],
      },
      network: { allowedDomains: ['github.com', 'api.github.com'], strictAllowlist: true },
    });
  });

  it('guard ctx secret paths deny reading real-home credentials', () => {
    const { state, wt } = setup();
    const ctx = JSON.parse(readFileSync(join(state, 'guard', 'APP-12.json'), 'utf8'));
    const r = evaluateGuard(
      { toolName: 'Read', toolInput: { file_path: join(FAKE_HOME, '.ssh', 'id_x') } },
      ctx,
    );
    expect(r.decision).toBe('deny');
    expect(ctx.worktree).toBe(wt);
  });

  it('allowRead is exactly clone, tmp, HOME and crew_toolchain_paths; PATH never appears', () => {
    const tool = join(FAKE_HOME, '.local', 'bin');
    mkdirSync(tool, { recursive: true });
    const onPath = join(FAKE_HOME, '.tools', 'bin');
    mkdirSync(onPath, { recursive: true });
    const { wt, tmpDir, homeDir, state, s } = setup({
      toolchain: [tool],
      env: {
        PATH: [onPath, tool].join(':'),
        GH_CONFIG_DIR: '/cfg/gh-alt',
        XDG_CONFIG_HOME: '/xdg',
      },
    });
    expect(s.sandbox.filesystem.allowRead).toEqual([wt, tmpDir, homeDir, realpathSync(tool)]);
    const deny = s.sandbox.filesystem.denyRead;
    expect(deny).toContain(FAKE_HOME);
    expect(deny).toEqual(
      expect.arrayContaining(['/cfg/gh-alt', '/xdg/gh', '/xdg/git/credentials']),
    );
    const ctx = JSON.parse(readFileSync(join(state, 'guard', 'APP-12.json'), 'utf8'));
    expect(ctx.secretGlobs).toEqual(
      expect.arrayContaining(['/cfg/gh-alt', '/cfg/gh-alt/**', '/xdg/gh/**']),
    );
  });

  it('refuses toolchain paths that open credentials (launcher home and env extras)', () => {
    for (const bad of [FAKE_HOME, join(FAKE_HOME, '.config'), join(FAKE_HOME, 'Library'), '/']) {
      expect(() => setup({ toolchain: [bad] })).toThrow(/crew_toolchain_paths/);
    }
    expect(() =>
      setup({ toolchain: ['/cfg/gh-alt/sub'], env: { GH_CONFIG_DIR: '/cfg/gh-alt' } }),
    ).toThrow(/credential/);
  });

  it('rejects item ids that are unsafe in paths', () => {
    const { project, state } = makeFixture();
    const bad = { ...item, id: '../x' };
    expect(() => writeBrief(state, bad, config, project)).toThrow(/item id/);
    expect(() =>
      writeCrewSettings(state, bad, '/w', config, {
        homeDir: '/h',
        tmpDir: '/t',
        projectDir: project,
        toolchainPaths: [],
      }),
    ).toThrow(/item id/);
  });

  it('writes the guard context with protected paths', () => {
    const { state, wt } = setup();
    const ctxFile = join(state, 'guard', 'APP-12.json');
    const ctx = JSON.parse(readFileSync(ctxFile, 'utf8'));
    expect(ctx).toEqual({
      worktree: wt,
      ownerOnly: ['gh release *'],
      deployCommands: ['make deploy'],
      secretGlobs: [...DEFAULT_SECRET_GLOBS, ...CRED_PATHS.flatMap((p) => [p, `${p}/**`])],
      crewAllowedWorkflows: ['ci.yml'],
      crewAllowedWorkflowRefs: ['main'],
      protectedPaths: [
        ctxFile,
        ...['guard', 'settings', 'briefs', 'logs', 'homes', 'tmp'].map((d) => join(state, d)),
        ...[
          'crew.json',
          'queue.json',
          'state.json',
          'metrics.jsonl',
          'guard.jsonl',
          'marker.json',
        ].map((f) => join(state, f)),
      ],
    });
  });
});

describe('launchCrew', () => {
  const TOKEN_VAR = 'STUDIO_TEST_CREW_TOKEN';
  const SECRET = 'tok-secret-value-123';
  const strict: StudioConfig = { ...config, allowAmbientCredentials: false };
  const withToken: StudioConfig = { ...strict, crewToken: { env: TOKEN_VAR } };

  it('starts claude -p with --settings, --model and a stream-json log', async () => {
    const { project, state, launcher } = makeFixture({
      CDPATH: '/tmp',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    });
    const started: Started[] = [];
    const r = await launchCrew(project, item, config, fakePorts(started), launcher);
    const wt = join(state, 'clones', 'APP-12');
    expect(started).toHaveLength(1);
    const s = started[0] as Started;
    expect(s.cwd).toBe(wt);
    expect(s.args).toEqual([
      '-p',
      '--settings',
      join(state, 'settings', 'APP-12.json'),
      '--model',
      'sonnet',
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(s.prompt).toBe(`Read ${join(state, 'briefs', 'APP-12.md')} and follow it.`);
    expect(s.logPath).toBe(join(state, 'logs', 'APP-12.jsonl'));
    expect(r).toEqual({ name: 'studio-builder-app-12', pid: 4242, log: s.logPath });
    expect(existsSync(join(state, 'logs'))).toBe(true);
    // Env is an allowlist: no CDPATH, no GIT_*, no token without crewToken.
    expect(Object.keys(s.env).some((k) => k.startsWith('GIT_'))).toBe(false);
    expect(s.env.CDPATH).toBeUndefined();
    expect(s.env.GH_TOKEN).toBeUndefined();
    expect(s.env.STUDIO_ROLE).toBe('crew');
    expect(s.env.STUDIO_GUARD_CTX).toBe(join(state, 'guard', 'APP-12.json'));
    expect(s.env.STUDIO_STATE_DIR).toBe(state);
    expect(s.env.PATH).toBe(process.env.PATH);
    const rec = JSON.parse(readFileSync(join(state, 'crew.json'), 'utf8'));
    expect(rec['APP-12']).toMatchObject({
      name: 'studio-builder-app-12',
      item: 'APP-12',
      role: 'builder',
      pid: 4242,
      log: s.logPath,
    });
    expect(typeof rec['APP-12'].startedAt).toBe('string');
  });

  it('keeps all runtime state out of the repository, in 0700 directories', async () => {
    const { project, state, home, launcher } = makeFixture();
    await launchCrew(project, item, config, fakePorts([]), launcher);
    expect(dirnameOf(state)).toBe(join(home, '.local', 'state', 'studio'));
    expect(state).toMatch(/\/[0-9a-f]{16}-clone$/);
    expect(existsSync(join(project, '.studio'))).toBe(false);
    for (const d of ['', 'clones', 'homes', 'homes/APP-12', 'tmp', 'tmp/APP-12', 'settings']) {
      expect(statSync(join(state, d)).mode & 0o777).toBe(0o700);
    }
    for (const d of ['briefs', 'logs', 'guard']) {
      expect(statSync(join(state, d)).mode & 0o777).toBe(0o700);
    }
    expect(statSync(join(state, 'crew.json')).mode & 0o777).toBe(0o600);
  });

  it('uses XDG_STATE_HOME for the state root when set', async () => {
    const xdg = join(root, `xdg-state-${n++}`);
    const { project, state, launcher } = makeFixture({ XDG_STATE_HOME: xdg });
    const started: Started[] = [];
    await launchCrew(project, item, config, fakePorts(started), launcher);
    expect(dirnameOf(state)).toBe(join(xdg, 'studio'));
    expect((started[0] as Started).cwd).toBe(join(state, 'clones', 'APP-12'));
  });

  it('K2: refuses a state root inside the project before any side effect', async () => {
    const f = makeFixture();
    const started: Started[] = [];
    const launcher = { ...f.launcher, env: { ...f.launcher.env, XDG_STATE_HOME: f.project } };
    await expect(launchCrew(f.project, item, config, fakePorts(started), launcher)).rejects.toThrow(
      /must not equal, lie inside or contain the project/,
    );
    expect(started).toHaveLength(0);
    expect(existsSync(join(f.project, 'studio'))).toBe(false);
  });

  it('R61: refuses a state root whose marker names another origin', async () => {
    const f = makeFixture();
    const started: Started[] = [];
    await launchCrew(f.project, item, config, fakePorts(started), f.launcher);
    const marker = JSON.parse(readFileSync(join(f.state, 'marker.json'), 'utf8'));
    expect(marker).toEqual({
      projectRealpath: realpathSync(f.project),
      originUrl: git(f.project, 'remote', 'get-url', 'origin'),
    });
    expect(statSync(join(f.state, 'marker.json')).mode & 0o777).toBe(0o600);
    git(f.project, 'remote', 'set-url', 'origin', 'https://example.com/org/other.git');
    await expect(
      launchCrew(f.project, item, config, fakePorts(started), f.launcher),
    ).rejects.toThrow(/marker/);
    expect(started).toHaveLength(1);
  });

  it('K1: the guard lets the crew write its clone but not the state files', async () => {
    const { project, state, launcher } = makeFixture();
    await launchCrew(project, item, config, fakePorts([]), launcher);
    const ctx = JSON.parse(readFileSync(join(state, 'guard', 'APP-12.json'), 'utf8'));
    const clone = join(state, 'clones', 'APP-12');
    const run = (toolName: string, toolInput: Record<string, unknown>) =>
      evaluateGuard({ toolName, toolInput, cwd: clone }, ctx).decision;
    expect(run('Write', { file_path: join(clone, 'src', 'a.ts'), content: 'x' })).toBe('allow');
    expect(
      run('Edit', {
        file_path: join(clone, '.studio', 'reports', 'APP-12.md'),
        old_string: 'a',
        new_string: 'b',
      }),
    ).toBe('allow');
    expect(run('Bash', { command: 'touch src/a.ts' })).toBe('allow');
    expect(run('Write', { file_path: join(state, 'crew.json'), content: '{}' })).toBe('deny');
    expect(run('Write', { file_path: join(state, 'guard', 'x.json'), content: '{}' })).toBe('deny');
    expect(
      run('Write', { file_path: join(clone, '.git', 'hooks', 'pre-commit'), content: 'x' }),
    ).toBe('deny');
  });

  it('launch env maps crew token to GH_TOKEN and the settings file does not contain the token', async () => {
    const { project, state, launcher } = makeFixture({ [TOKEN_VAR]: SECRET });
    const started: Started[] = [];
    await launchCrew(project, item, withToken, fakePorts(started), launcher);
    expect((started[0] as Started).env.GH_TOKEN).toBe(SECRET);
    for (const f of [
      join(state, 'settings', 'APP-12.json'),
      join(state, 'guard', 'APP-12.json'),
      join(state, 'briefs', 'APP-12.md'),
      join(state, 'crew.json'),
    ]) {
      expect(readFileSync(f, 'utf8')).not.toContain(SECRET);
    }
  });

  it('fails closed when the token variable is unset, before touching anything', async () => {
    const { project, state, launcher } = makeFixture();
    const started: Started[] = [];
    await expect(
      launchCrew(project, item, withToken, fakePorts(started), launcher),
    ).rejects.toThrow(TOKEN_VAR);
    expect(started).toHaveLength(0);
    expect(existsSync(state)).toBe(false);
  });

  it('refuses without crewToken unless allow_ambient_credentials is set', async () => {
    const { project, state, launcher } = makeFixture();
    const started: Started[] = [];
    await expect(launchCrew(project, item, strict, fakePorts(started), launcher)).rejects.toThrow(
      /crew_token|allow_ambient_credentials/,
    );
    expect(started).toHaveLength(0);
    expect(existsSync(state)).toBe(false);
    await launchCrew(project, item, config, fakePorts(started), launcher);
    expect(started).toHaveLength(1);
  });

  it('uses an isolated HOME with only a git identity and credential helper', async () => {
    const { project, state, launcher } = makeFixture({
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      XDG_CONFIG_HOME: '/tmp/xdg',
      GH_CONFIG_DIR: '/tmp/ghcfg',
      ANTHROPIC_API_KEY: 'k-1',
      CLAUDE_CODE_OAUTH_TOKEN: 'o-1',
    });
    const started: Started[] = [];
    await launchCrew(project, item, config, fakePorts(started), launcher);
    const env = (started[0] as Started).env;
    const home = join(state, 'homes', 'APP-12');
    expect(env.HOME).toBe(home);
    expect(readdirSync(home)).toEqual(['.gitconfig']);
    const gc = readFileSync(join(home, '.gitconfig'), 'utf8');
    expect(gc).toContain('name = Studio Crew');
    expect(gc).toContain('email = crew@studio.invalid');
    expect(gc).toMatch(
      /\[credential "https:\/\/github.com"\]\n\thelper =\n\thelper = !gh auth git-credential/,
    );
    for (const k of ['SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR']) {
      expect(env[k]).toBeUndefined();
    }
    expect(env.ANTHROPIC_API_KEY).toBe('k-1');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('o-1');
  });

  it('resolves CLAUDE_CONFIG_DIR from the launcher env or the owner home', async () => {
    const { project, home, launcher } = makeFixture();
    const started: Started[] = [];
    await launchCrew(project, item, config, fakePorts(started), launcher);
    expect((started[0] as Started).env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude'));
    await launchCrew(project, item, config, fakePorts(started), {
      ...launcher,
      env: { ...launcher.env, CLAUDE_CONFIG_DIR: '/tmp/custom-claude' },
    });
    expect((started[1] as Started).env.CLAUDE_CONFIG_DIR).toBe('/tmp/custom-claude');
  });

  it('sandbox writes are exactly clone, crew tmp and crew home; TMPDIR is the crew tmp', async () => {
    const { project, state, home, launcher } = makeFixture();
    const started: Started[] = [];
    await launchCrew(project, item, config, fakePorts(started), launcher);
    const s = JSON.parse(readFileSync(join(state, 'settings', 'APP-12.json'), 'utf8'));
    expect(s.sandbox.filesystem.allowWrite).toEqual([
      join(state, 'clones', 'APP-12'),
      join(state, 'tmp', 'APP-12'),
      join(state, 'homes', 'APP-12'),
    ]);
    expect((started[0] as Started).env.TMPDIR).toBe(join(state, 'tmp', 'APP-12'));
    expect(s.sandbox.filesystem.denyRead).toContain(home);
  });

  it('R62: denies reading the state base (literal and real), re-allows only own dirs', async () => {
    const realXdg = join(root, `xdg-real-${n++}`);
    mkdirSync(join(realXdg, 'studio'), { recursive: true });
    const xdgLink = join(root, `xdg-link-${n++}`);
    symlinkSync(realXdg, xdgLink);
    const { project, state, launcher } = makeFixture({ XDG_STATE_HOME: xdgLink });
    await launchCrew(project, item, config, fakePorts([]), launcher);
    const fs = JSON.parse(readFileSync(join(state, 'settings', 'APP-12.json'), 'utf8')).sandbox
      .filesystem;
    expect(fs.denyRead).toEqual(
      expect.arrayContaining([join(xdgLink, 'studio'), join(realXdg, 'studio')]),
    );
    const own = ['clones', 'tmp', 'homes'].map((d) => join(state, d, 'APP-12'));
    expect(fs.allowRead).toEqual([own[0], own[1], own[2]]);
    expect(fs.allowWrite).toEqual([own[0], own[1], own[2]]);
  });

  it('recreates HOME and tmp on every launch', async () => {
    const { project, state, launcher } = makeFixture();
    const ports = fakePorts([]);
    await launchCrew(project, item, config, ports, launcher);
    writeFileSync(join(state, 'homes', 'APP-12', 'stale.txt'), 'x');
    writeFileSync(join(state, 'tmp', 'APP-12', 'stale.txt'), 'x');
    await launchCrew(project, item, config, ports, launcher);
    expect(readdirSync(join(state, 'homes', 'APP-12'))).toEqual(['.gitconfig']);
    expect(readdirSync(join(state, 'tmp', 'APP-12'))).toEqual([]);
  });

  it('serialises concurrent launches: both crew records survive', async () => {
    const { project, state, launcher } = makeFixture();
    const ports = fakePorts([]);
    await Promise.all([
      launchCrew(project, item, config, ports, launcher),
      launchCrew(project, { ...item, id: 'APP-13' }, config, ports, launcher),
    ]);
    const rec = JSON.parse(readFileSync(join(state, 'crew.json'), 'utf8'));
    expect(Object.keys(rec).sort()).toEqual(['APP-12', 'APP-13']);
  });

  it('throws when the role is not configured', async () => {
    const { project, launcher } = makeFixture();
    const started: Started[] = [];
    await expect(
      launchCrew(project, { ...item, role: 'reviewer' }, config, fakePorts(started), launcher),
    ).rejects.toThrow(/role/);
    expect(started).toHaveLength(0);
  });

  it('keeps earlier crew records when launching a second item', async () => {
    const { project, state, launcher } = makeFixture();
    const ports = fakePorts([]);
    await launchCrew(project, item, config, ports, launcher);
    await launchCrew(project, { ...item, id: 'APP-13' }, config, ports, launcher);
    const rec = JSON.parse(readFileSync(join(state, 'crew.json'), 'utf8'));
    expect(Object.keys(rec).sort()).toEqual(['APP-12', 'APP-13']);
  });
});

/** Writes the owner config of a fixture home. */
function ownerConfig(home: string, paths: string[]): void {
  mkdirSync(join(home, '.config', 'studio'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'studio', 'config.yaml'),
    `crew_toolchain_paths: ${JSON.stringify(paths)}\n`,
  );
}

describe('toolchain paths at launch (owner config)', () => {
  /** Launch must refuse `bad` before any side effect. */
  async function refuses(f: Fixture, bad: string, why: RegExp, launcher = f.launcher) {
    ownerConfig(f.home, [bad]);
    const started: Started[] = [];
    await expect(launchCrew(f.project, item, config, fakePorts(started), launcher)).rejects.toThrow(
      why,
    );
    expect(started).toHaveLength(0);
    expect(existsSync(f.state)).toBe(false);
  }

  it('accepts an existing directory and puts its real path into allowRead', async () => {
    const f = makeFixture();
    const real = join(f.home, '.toolchains', 'node');
    mkdirSync(real, { recursive: true });
    const viaLink = join(f.home, '.tools-link');
    symlinkSync(real, viaLink);
    ownerConfig(f.home, [viaLink]);
    await launchCrew(f.project, item, config, fakePorts([]), f.launcher);
    const s = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-12.json'), 'utf8'));
    expect(s.sandbox.filesystem.allowRead.slice(3)).toEqual([realpathSync(real)]);
    expect(s.sandbox.filesystem.allowRead).not.toContain(viaLink);
  });

  it('rejects a symlink to the credential store ~/.ssh', async () => {
    const f = makeFixture();
    mkdirSync(join(f.home, '.ssh'));
    const link = join(root, `ssh-link-${n++}`);
    symlinkSync(join(f.home, '.ssh'), link);
    await refuses(f, link, /protected location/);
  });

  it('rejects a symlink to the home directory', async () => {
    const f = makeFixture();
    const link = join(root, `home-link-${n++}`);
    symlinkSync(f.home, link);
    await refuses(f, link, /home directory/);
  });

  it('rejects the home reached through a symlinked home spelling', async () => {
    const f = makeFixture();
    const homeLink = join(root, `home-alias-${n++}`);
    symlinkSync(f.home, homeLink);
    mkdirSync(join(f.home, '.aws'));
    // The launcher knows the home under its link name; the path names the real directory.
    await refuses(f, join(f.home, '.aws'), /protected location/, {
      ...f.launcher,
      homedir: homeLink,
    });
  });

  it('rejects .SSH on darwin (case-insensitive comparison)', async () => {
    const f = makeFixture();
    mkdirSync(join(f.home, '.SSH'), { recursive: true });
    await refuses(f, join(f.home, '.SSH'), /credential location|protected location/, {
      ...f.launcher,
      platform: 'darwin',
    });
  });

  it('rejects a path that does not exist', async () => {
    const f = makeFixture();
    await refuses(f, join(f.home, '.toolchains', 'missing'), /does not exist/);
  });

  it('rejects the project dir, a parent of it and a path inside it', async () => {
    const f = makeFixture();
    mkdirSync(join(f.project, 'node_modules'), { recursive: true });
    await refuses(f, f.project, /project directory/);
    await refuses(f, join(f.project, 'node_modules'), /project directory/);
    // The fixture's parent of the project also holds the fake home: refused either way.
    await refuses(f, dirnameOf(f.project), /project directory|home directory/);
  });

  it('rejects the state root, a path inside it and a parent of it', async () => {
    for (const pick of [(s: string) => s, (s: string) => join(s, 'clones'), dirnameOf]) {
      const f = makeFixture();
      const target = pick(f.state);
      mkdirSync(target, { recursive: true });
      ownerConfig(f.home, [target]);
      const started: Started[] = [];
      await expect(
        launchCrew(f.project, item, config, fakePorts(started), f.launcher),
      ).rejects.toThrow(/state root/);
      expect(started).toHaveLength(0);
    }
  });

  it('rejects <home>/.claude and CLAUDE_CONFIG_DIR (also through a symlink)', async () => {
    const f = makeFixture();
    mkdirSync(join(f.home, '.claude'));
    await refuses(f, join(f.home, '.claude'), /credential location|protected location/);
    const g = makeFixture();
    const cfg = join(root, `claude-cfg-${n++}`);
    mkdirSync(cfg);
    const link = join(root, `claude-link-${n++}`);
    symlinkSync(cfg, link);
    await refuses(g, link, /protected location/, {
      ...g.launcher,
      env: { ...g.launcher.env, CLAUDE_CONFIG_DIR: cfg },
    });
  });
});

describe('state root safety', () => {
  it('refuses a symlinked component below the state root and deletes nothing', async () => {
    const f = makeFixture();
    const elsewhere = join(root, `elsewhere-${n++}`);
    mkdirSync(join(elsewhere, 'APP-12'), { recursive: true });
    writeFileSync(join(elsewhere, 'APP-12', 'keep'), 'x');
    mkdirSync(f.state, { recursive: true });
    symlinkSync(elsewhere, join(f.state, 'homes'));
    const started: Started[] = [];
    await expect(
      launchCrew(f.project, item, config, fakePorts(started), f.launcher),
    ).rejects.toThrow(/symlink/);
    expect(started).toHaveLength(0);
    expect(existsSync(join(elsewhere, 'APP-12', 'keep'))).toBe(true);
  });

  it('refuses a symlinked clones directory', async () => {
    const f = makeFixture();
    const elsewhere = join(root, `elsewhere-${n++}`);
    mkdirSync(elsewhere);
    mkdirSync(f.state, { recursive: true });
    symlinkSync(elsewhere, join(f.state, 'clones'));
    await expect(prepareCheckout(f.state, f.project, item, realPorts())).rejects.toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe('writeHomeFile', () => {
  it('does not follow a planted symlink to a file or directory', () => {
    const base = join(root, `home-${n++}`);
    const home = join(base, 'home');
    const outside = join(base, 'outside');
    mkdirSync(home, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'victim'), 'keep');
    symlinkSync(join(outside, 'victim'), join(home, '.gitconfig'));
    expect(() => writeHomeFile(home, '.gitconfig', 'evil')).toThrow();
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('keep');
    symlinkSync(outside, join(home, 'linked'));
    expect(() => writeHomeFile(home, 'linked/x', 'evil')).toThrow(/outside the crew home/);
    expect(existsSync(join(outside, 'x'))).toBe(false);
    writeHomeFile(home, 'ok', 'fine');
    expect(readFileSync(join(home, 'ok'), 'utf8')).toBe('fine');
  });
});

describe('crewSessionId', () => {
  it('reads the session id of the first system event', () => {
    const state = join(root, 'sess');
    mkdirSync(join(state, 'logs'), { recursive: true });
    writeFileSync(
      join(state, 'logs', 'APP-1.jsonl'),
      [
        'not json',
        JSON.stringify({ type: 'user', session_id: 'wrong' }),
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' }),
        JSON.stringify({ type: 'system', session_id: 'sess-456' }),
      ].join('\n'),
    );
    expect(crewSessionId(state, 'APP-1')).toBe('sess-123');
    expect(crewSessionId(state, 'APP-2')).toBeUndefined();
  });
});
