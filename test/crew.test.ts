import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import {
  crewName,
  crewSessionId,
  launchCrew,
  prepareWorktree,
  writeBrief,
  writeCrewSettings,
} from '../src/crew.js';
import { DEFAULT_SECRET_GLOBS, evaluateGuard } from '../src/guard.js';
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
  const base = join(root, `p${n++}`);
  mkdirSync(base);
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

const CRED_PATHS = [
  '.config/gh',
  '.git-credentials',
  '.ssh',
  '.netrc',
  '.gnupg',
  '.aws',
  '.docker/config.json',
  'Library/Keychains',
].map((p) => join(homedir(), p));

describe('crewName', () => {
  it('lowercases id', () => {
    expect(crewName(item)).toBe('studio-builder-app-12');
  });
});

describe('prepareWorktree', () => {
  it('is idempotent and branches from origin/main', async () => {
    const project = makeProject();
    const ports = realPorts();
    const a = await prepareWorktree(project, item, ports);
    expect(a.path).toBe(join(project, '.studio', 'worktrees', 'APP-12'));
    expect(a.branch).toBe('studio/APP-12');
    expect(git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('studio/APP-12');
    expect(git(a.path, 'rev-parse', 'HEAD')).toBe(git(project, 'rev-parse', 'origin/main'));
    writeFileSync(join(a.path, 'work.txt'), 'wip');
    const b = await prepareWorktree(project, item, ports);
    expect(b).toEqual(a);
    expect(existsSync(join(a.path, 'work.txt'))).toBe(true);
  });

  it('prunes stale worktree registrations and rejects unsafe ids', async () => {
    const project = makeProject();
    const ports = realPorts();
    const a = await prepareWorktree(project, item, ports);
    rmSync(a.path, { recursive: true, force: true });
    const b = await prepareWorktree(project, item, ports);
    expect(existsSync(join(b.path, 'README.md'))).toBe(true);
    await expect(prepareWorktree(project, { ...item, id: 'bad id;' }, ports)).rejects.toThrow(
      /item id/,
    );
  });

  it('reuses an existing branch whose worktree was removed', async () => {
    const project = makeProject();
    const ports = realPorts();
    const a = await prepareWorktree(project, item, ports);
    git(project, 'worktree', 'remove', '--force', a.path);
    const b = await prepareWorktree(project, item, ports);
    expect(git(b.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('studio/APP-12');
  });
});

describe('writeBrief', () => {
  it('lists required skills of role, the item and the rules', () => {
    const project = makeProject();
    const state = join(project, '.studio', 'state');
    mkdirSync(join(project, '.studio', 'roles'), { recursive: true });
    writeFileSync(join(project, '.studio', 'roles', 'builder.md'), 'ROLE-BRIEF-MARKER');
    const file = writeBrief(state, item, config);
    expect(file).toBe(join(state, 'briefs', 'APP-12.md'));
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('ROLE-BRIEF-MARKER');
    expect(text).toContain('Invoke these skills first: superpowers:test-driven-development');
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

  it('works without a role brief file', () => {
    const state = join(makeProject(), '.studio', 'state');
    expect(readFileSync(writeBrief(state, item, config), 'utf8')).toContain('APP-12');
  });
});

describe('writeCrewSettings', () => {
  const setup = () => {
    const project = makeProject();
    const state = join(project, '.studio', 'state');
    const wt = join(project, '.studio', 'worktrees', 'APP-12');
    const gitDir = join(project, '.git', 'worktrees', 'APP-12');
    const commonDir = join(project, '.git');
    const homeDir = join(state, 'homes', 'APP-12');
    const file = writeCrewSettings(state, item, wt, config, { gitDir, commonDir, homeDir });
    return {
      project,
      state,
      wt,
      gitDir,
      commonDir,
      homeDir,
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
    const { wt, commonDir, homeDir, s } = setup();
    expect(s.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [wt, tmpdir(), commonDir, homeDir], denyRead: CRED_PATHS },
      network: { allowedDomains: ['github.com', 'api.github.com'], strictAllowlist: true },
    });
  });

  it('guard ctx secret paths deny reading real-home credentials', () => {
    const { state, wt } = setup();
    const ctx = JSON.parse(readFileSync(join(state, 'guard', 'APP-12.json'), 'utf8'));
    const r = evaluateGuard(
      { toolName: 'Read', toolInput: { file_path: join(homedir(), '.ssh', 'id_x') } },
      ctx,
    );
    expect(r.decision).toBe('deny');
    expect(ctx.worktree).toBe(wt);
  });

  it('rejects item ids that are unsafe in paths', () => {
    const state = join(makeProject(), '.studio', 'state');
    const bad = { ...item, id: '../x' };
    expect(() => writeBrief(state, bad, config)).toThrow(/item id/);
    expect(() =>
      writeCrewSettings(state, bad, '/w', config, { gitDir: '/g', commonDir: '/c', homeDir: '/h' }),
    ).toThrow(/item id/);
  });

  it('writes the guard context with protected paths', () => {
    const { state, wt, gitDir, commonDir } = setup();
    const ctxFile = join(state, 'guard', 'APP-12.json');
    const ctx = JSON.parse(readFileSync(ctxFile, 'utf8'));
    expect(ctx).toEqual({
      worktree: wt,
      ownerOnly: ['gh release *'],
      deployCommands: ['make deploy'],
      secretGlobs: [...DEFAULT_SECRET_GLOBS, ...CRED_PATHS.flatMap((p) => [p, `${p}/**`])],
      crewAllowedWorkflows: ['ci.yml'],
      crewAllowedWorkflowRefs: ['main'],
      protectedPaths: [ctxFile, state, gitDir, commonDir],
    });
  });
});

describe('launchCrew', () => {
  const TOKEN_VAR = 'STUDIO_TEST_CREW_TOKEN';
  const SECRET = 'tok-secret-value-123';
  const strict: StudioConfig = { ...config, allowAmbientCredentials: false };
  const withToken: StudioConfig = { ...strict, crewToken: { env: TOKEN_VAR } };
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      [TOKEN_VAR]: process.env[TOKEN_VAR],
      CDPATH: process.env.CDPATH,
      GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    };
    process.env.CDPATH = '/tmp';
    process.env.GIT_COMMITTER_DATE = '2020-01-01T00:00:00Z';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('starts claude -p with --settings, --model and a stream-json log', async () => {
    const project = makeProject();
    const started: Started[] = [];
    const r = await launchCrew(project, item, config, fakePorts(started));
    const state = join(project, '.studio', 'state');
    const wt = join(project, '.studio', 'worktrees', 'APP-12');
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

  it('launch env maps crew token to GH_TOKEN and the settings file does not contain the token', async () => {
    process.env[TOKEN_VAR] = SECRET;
    const project = makeProject();
    const started: Started[] = [];
    await launchCrew(project, item, withToken, fakePorts(started));
    expect((started[0] as Started).env.GH_TOKEN).toBe(SECRET);
    const state = join(project, '.studio', 'state');
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
    delete process.env[TOKEN_VAR];
    const project = makeProject();
    const started: Started[] = [];
    await expect(launchCrew(project, item, withToken, fakePorts(started))).rejects.toThrow(
      TOKEN_VAR,
    );
    expect(started).toHaveLength(0);
    expect(existsSync(join(project, '.studio', 'worktrees'))).toBe(false);
  });

  it('refuses without crewToken unless allow_ambient_credentials is set', async () => {
    const project = makeProject();
    const started: Started[] = [];
    await expect(launchCrew(project, item, strict, fakePorts(started))).rejects.toThrow(
      /crew_token|allow_ambient_credentials/,
    );
    expect(started).toHaveLength(0);
    expect(existsSync(join(project, '.studio'))).toBe(false);
    await launchCrew(project, item, config, fakePorts(started));
    expect(started).toHaveLength(1);
  });

  it('uses an isolated HOME with only a git identity and credential helper', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    process.env.GH_CONFIG_DIR = '/tmp/ghcfg';
    process.env.ANTHROPIC_API_KEY = 'k-1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'o-1';
    const project = makeProject();
    const started: Started[] = [];
    await launchCrew(project, item, config, fakePorts(started));
    const env = (started[0] as Started).env;
    const home = join(project, '.studio', 'state', 'homes', 'APP-12');
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

  it('resolves CLAUDE_CONFIG_DIR from the parent env or the real home', async () => {
    const project = makeProject();
    const started: Started[] = [];
    delete process.env.CLAUDE_CONFIG_DIR;
    await launchCrew(project, item, config, fakePorts(started));
    expect((started[0] as Started).env.CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude'));
    process.env.CLAUDE_CONFIG_DIR = '/tmp/custom-claude';
    await launchCrew(project, item, config, fakePorts(started));
    expect((started[1] as Started).env.CLAUDE_CONFIG_DIR).toBe('/tmp/custom-claude');
  });

  it('crew can commit through the sandboxed git dirs: common dir is writable and protected', async () => {
    const project = makeProject();
    await launchCrew(project, item, config, fakePorts([]));
    const state = join(project, '.studio', 'state');
    const s = JSON.parse(readFileSync(join(state, 'settings', 'APP-12.json'), 'utf8'));
    const ctx = JSON.parse(readFileSync(join(state, 'guard', 'APP-12.json'), 'utf8'));
    const common = join(project, '.git');
    expect(s.sandbox.filesystem.allowWrite).toContain(common);
    expect(ctx.protectedPaths).toContain(common);
    expect(ctx.protectedPaths).toContain(join(common, 'worktrees', 'APP-12'));
  });

  it('serialises concurrent launches: both crew records survive', async () => {
    const project = makeProject();
    const ports = fakePorts([]);
    await Promise.all([
      launchCrew(project, item, config, ports),
      launchCrew(project, { ...item, id: 'APP-13' }, config, ports),
    ]);
    const rec = JSON.parse(readFileSync(join(project, '.studio', 'state', 'crew.json'), 'utf8'));
    expect(Object.keys(rec).sort()).toEqual(['APP-12', 'APP-13']);
  });

  it('throws when the role is not configured', async () => {
    const project = makeProject();
    const started: Started[] = [];
    await expect(
      launchCrew(project, { ...item, role: 'reviewer' }, config, fakePorts(started)),
    ).rejects.toThrow(/role/);
    expect(started).toHaveLength(0);
  });

  it('keeps earlier crew records when launching a second item', async () => {
    const project = makeProject();
    const ports = fakePorts([]);
    await launchCrew(project, item, config, ports);
    await launchCrew(project, { ...item, id: 'APP-13' }, config, ports);
    const rec = JSON.parse(readFileSync(join(project, '.studio', 'state', 'crew.json'), 'utf8'));
    expect(Object.keys(rec).sort()).toEqual(['APP-12', 'APP-13']);
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
