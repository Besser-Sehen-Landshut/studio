import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addAccount } from '../src/accounts.js';
import { loadBoard } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { installCrewToken } from '../src/credentials.js';
import { type Check, type InitOptions, proposeComponents, runInit } from '../src/init.js';
import { type Gh, type Ports, realPorts } from '../src/ports.js';

const root = mkdtempSync(join(tmpdir(), 'studio-init-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Opts = {
  origin?: string | null;
  files?: Record<string, string>;
  ghAuth?: number;
  claude?: number;
  runners?: string;
  /** Calls that never answer. */
  hang?: ('gh-version' | 'gh-auth' | 'api' | 'claude')[];
  /** Runner reads fail (the detection is unknown). */
  runnersFail?: boolean;
};

const never = <T>() => new Promise<T>(() => {});

let n = 0;
function fixture(o: Opts = {}) {
  const dir = join(root, `p${n}`);
  const home = join(root, `h${n++}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  if (o.origin !== null) git('remote', 'add', 'origin', o.origin ?? 'git@github.com:org/app.git');
  for (const [file, text] of Object.entries(o.files ?? {})) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const hang = new Set(o.hang ?? []);
  const ghRuns: { args: string[]; timeoutMs?: number }[] = [];
  const apiTimeouts: (number | undefined)[] = [];
  const claudeTimeouts: (number | undefined)[] = [];
  const gh: Gh = {
    async api(path, _jq, opts) {
      apiTimeouts.push(opts?.timeoutMs);
      if (hang.has('api')) return never();
      if (path.includes('/actions/runs?')) return '0\n';
      if (path.endsWith('/actions/runners')) {
        if (o.runnersFail) throw new Error('HTTP 403');
        return path.startsWith('/orgs/') ? (o.runners ?? '') : '';
      }
      if (path.startsWith('/repos/')) return 'private\n';
      throw new Error(`unscripted ${path}`);
    },
    async run(args, opts) {
      ghRuns.push({
        args,
        ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      });
      if (args[0] === 'auth') {
        if (hang.has('gh-auth')) return never();
        return { code: o.ghAuth ?? 0, stdout: '', stderr: '' };
      }
      if (hang.has('gh-version')) return never();
      return { code: 0, stdout: 'gh version 2.80.0\n', stderr: '' };
    },
  };
  const real = realPorts();
  const ports: Ports = {
    ...real,
    gh,
    clock: { now: () => new Date('2026-11-04T10:00:00Z'), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
    plugins: {
      run: async (_args, _env, _cwd, opts) => {
        claudeTimeouts.push(opts?.timeoutMs);
        if (hang.has('claude')) return never();
        return { code: o.claude ?? 0, stdout: '2.5.0 (Claude Code)\n', stderr: '' };
      },
    },
  };
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CONFIG_HOME: join(home, 'config'),
  };
  const owner = { env, homedir: home };
  return { dir, home, ports, env, owner, ghRuns, apiTimeouts, claudeTimeouts };
}

async function cli(fx: ReturnType<typeof fixture>, ...argv: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', fx.dir, ...argv], {
    ports: fx.ports,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: fx.env,
    homedir: fx.home,
    cwd: fx.dir,
  });
  return { code, out, err };
}

/** Every file below `dir` (outside `.git`) with its content. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const MONOREPO = {
  'package.json': '{"name":"root","private":true}',
  'apps/a/package.json': '{"name":"a"}',
  'crates/b/Cargo.toml': '[package]\nname = "b"\n',
  'packages/c/README.md': 'no manifest here',
  '.github/workflows/ci.yml': 'name: ci\non: [pull_request]\njobs: {}\n',
};

describe('studio init', () => {
  it('a dry run writes nothing and prints every check and the next steps', async () => {
    const fx = fixture({ files: MONOREPO });
    const before = tree(fx.dir);
    const r = await cli(fx, 'init');
    expect(r.code).toBe(0);
    expect(tree(fx.dir)).toEqual(before);
    expect(existsSync(join(fx.dir, '.studio'))).toBe(false);
    for (const check of [
      'git',
      'gh',
      'claude',
      'node',
      'sandbox',
      'crew token',
      'claude account',
    ]) {
      expect(r.out).toMatch(new RegExp(`(pass|FAIL|warn) +${check}`));
    }
    expect(r.out).toContain('studio secret set crew-token');
    expect(r.out).toContain('studio account add <label>');
    expect(r.out).toContain('primary_repo: org/app');
    expect(r.out).toContain('Next steps');
    expect(r.out).toContain('/studio');
    expect(r.out).toContain('studio add');
    expect(r.out).toMatch(/dry run: nothing written; run studio init --write/);
  });

  it('--json carries the same data', async () => {
    const fx = fixture({ files: MONOREPO });
    const r = await cli(fx, 'init', '--json');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.written).toEqual([]);
    expect(out.config.primary_repo).toBe('org/app');
    expect(out.config.repos).toEqual(['org/app']);
    expect(out.config.ci.runners).toBe('github-hosted');
    expect(out.config.stacks).toEqual(expect.arrayContaining(['gha', 'rust']));
    expect(out.checks.find((c: { name: string }) => c.name === 'crew token')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('studio secret set crew-token'),
    });
    expect(out.nextSteps.length).toBeGreaterThan(3);
  });

  it('--write writes files the real loaders accept, and refuses to overwrite them', async () => {
    const fx = fixture({ files: MONOREPO });
    const r = await cli(fx, 'init', '--write');
    expect(r.code).toBe(0);
    const config = loadConfig(fx.dir);
    expect(config.primaryRepo).toBe('org/app');
    expect(config.components?.map((c) => [c.id, c.paths])).toEqual([
      ['a', ['apps/a/**']],
      ['b', ['crates/b/**']],
      ['tooling', ['.github/**']],
    ]);
    expect(config.sandbox.networkAllow).toEqual(
      expect.arrayContaining(['github.com', 'api.github.com', 'registry.npmjs.org', 'crates.io']),
    );
    const board = loadBoard(fx.dir, config);
    expect(board.items).toEqual([]);
    const boardText = readFileSync(join(fx.dir, '.studio', 'board.yaml'), 'utf8');
    expect(boardText).toMatch(/^# /);
    expect(boardText).toContain('#   - id: APP-1');

    const files = tree(fx.dir);
    const again = await cli(fx, 'init', '--write');
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
    expect(again.err).toMatch(/edit/);
    expect(tree(fx.dir)).toEqual(files);
  });

  it('a failing prerequisite with --write writes nothing and exits 1', async () => {
    const fx = fixture({ files: MONOREPO, ghAuth: 1 });
    const before = tree(fx.dir);
    const r = await cli(fx, 'init', '--write');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL +gh/);
    expect(r.out).toContain('gh auth login');
    expect(r.out).toMatch(/nothing written/);
    expect(tree(fx.dir)).toEqual(before);
    // The same failure in a dry run is reported, and the dry run still exits 0.
    expect((await cli(fx, 'init')).code).toBe(0);
  });

  it('an origin that is not on GitHub fails the repository check', async () => {
    const fx = fixture({ origin: 'https://example.com/org/app.git' });
    const r = await cli(fx, 'init', '--write', '--json');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.out);
    expect(out.checks.find((c: { name: string }) => c.name === 'repository')).toMatchObject({
      status: 'fail',
    });
    expect(existsSync(join(fx.dir, '.studio'))).toBe(false);
  });

  it('a single-package repo gets no components', async () => {
    const fx = fixture({
      origin: 'https://github.com/org/tool.git',
      files: { 'package.json': '{"name":"tool"}', 'scripts/x.sh': 'true\n' },
    });
    expect((await cli(fx, 'init', '--write')).code).toBe(0);
    const config = loadConfig(fx.dir);
    expect(config.primaryRepo).toBe('org/tool');
    expect(config.components).toBeUndefined();
  });

  it('warns when .studio/ is ignored by git', async () => {
    const fx = fixture({ files: { '.gitignore': '.studio/\n' } });
    const out = JSON.parse((await cli(fx, 'init', '--json')).out);
    expect(out.checks.find((c: { name: string }) => c.name === 'gitignore')).toMatchObject({
      status: 'warn',
    });
  });

  it('is refused in a crew session', async () => {
    const fx = fixture();
    fx.env.STUDIO_ROLE = 'crew';
    const r = await cli(fx, 'init', '--write');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not for crew sessions/);
    expect(existsSync(join(fx.dir, '.studio'))).toBe(false);
  });
});

describe('proposeComponents', () => {
  it('one component per manifest folder below the usual roots, ids unique and valid', () => {
    const dir = join(root, 'components');
    const files: Record<string, string> = {
      'apps/Web App/package.json': '{}',
      'apps/web/package.json': '{}',
      'apps/2d/go.mod': 'module x\n',
      'services/web/pyproject.toml': '',
      'libs/node_modules/package.json': '{}',
      'libs/.hidden/package.json': '{}',
      'packages/c/README.md': '',
      'scripts/a.sh': '',
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const { components } = proposeComponents(dir, 'org/app');
    expect(components.map((c) => [c.id, c.name, c.paths[0]])).toEqual([
      ['app-2d', '2d', 'apps/2d/**'],
      ['web', 'web', 'apps/web/**'],
      ['web-2', 'web', 'services/web/**'],
      ['tooling', 'Tooling', 'scripts/**'],
    ]);
    for (const c of components) {
      expect(c.id).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
      expect(c.repo).toBe('org/app');
    }
  });
});

describe('studio add', () => {
  async function ready(files: Record<string, string> = {}) {
    const fx = fixture({ files });
    expect((await cli(fx, 'init', '--write')).code).toBe(0);
    return fx;
  }

  it('appends a ready builder item with the next id from the repo name', async () => {
    const fx = await ready();
    const r = await cli(fx, 'add', 'Fix the login', '--dod', 'test added');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ item: 'APP-1', status: 'ready' });
    const board = loadBoard(fx.dir, loadConfig(fx.dir));
    expect(board.items).toEqual([
      expect.objectContaining({
        id: 'APP-1',
        title: 'Fix the login',
        type: 'fix',
        role: 'builder',
        repo: 'org/app',
        status: 'ready',
        dod: ['test added'],
      }),
    ]);
    const text = readFileSync(join(fx.dir, '.studio', 'board.yaml'), 'utf8');
    expect(text).toMatch(/^# /);
    const second = await cli(
      fx,
      'add',
      'Second',
      '--type',
      'docs',
      '--dod',
      'x',
      '--path',
      'docs/**',
    );
    expect(JSON.parse(second.out).item).toBe('APP-2');
    const item = loadBoard(fx.dir).items[1];
    expect(item).toMatchObject({ paths: ['docs/**'], touches: ['docs/**'], priority: 2 });
  });

  it('takes the prefix of the existing items', async () => {
    const fx = await ready();
    await cli(fx, 'add', 'One', '--type', 'fix', '--dod', 'x');
    const file = join(fx.dir, '.studio', 'board.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^(\s+- id: )APP-1$/m, '$1WEB-7'));
    const r = await cli(fx, 'add', 'Two', '--type', 'fix', '--dod', 'x');
    expect(JSON.parse(r.out).item).toBe('WEB-8');
  });

  it('defaults to fix, and refuses a feature without a plan', async () => {
    const fx = await ready();
    const plain = await cli(fx, 'add', 'Health endpoint', '--dod', 'GET /health returns 200');
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.out)).toMatchObject({ item: 'APP-1', type: 'fix' });
    const feature = await cli(fx, 'add', 'Big thing', '--type', 'feature', '--dod', 'x');
    expect(feature.code).toBe(1);
    expect(feature.err).toMatch(/--plan/);
    expect(feature.err).toMatch(/--type fix/);
    const planned = await cli(
      fx,
      'add',
      'Big',
      '--type',
      'feature',
      '--plan',
      'docs/p.md',
      '--dod',
      'x',
    );
    expect(JSON.parse(planned.out)).toMatchObject({ item: 'APP-2', type: 'feature' });
    expect(JSON.parse(planned.out).missing).toBeUndefined();
  });

  it('fresh project: init --write, add, and plan assigns the item', async () => {
    const fx = await ready();
    expect((await cli(fx, 'add', 'First', '--dod', 'it works', '--path', 'src/**')).code).toBe(0);
    const plan = await cli(fx, 'plan');
    expect(plan.code, plan.err).toBe(0);
    expect(JSON.parse(plan.out).assign.map((i: { id: string }) => i.id)).toEqual(['APP-1']);
  });

  it('without --path: added, with a warning; .github paths get a note', async () => {
    const fx = await ready();
    const bare = JSON.parse((await cli(fx, 'add', 'Anything', '--dod', 'x')).out);
    expect(bare.warnings.join(' ')).toMatch(/conflicts with no other item/);
    expect(bare.warnings.join(' ')).toMatch(/no component/);
    const ci = JSON.parse(
      (await cli(fx, 'add', 'CI', '--dod', 'x', '--path', '.github/workflows/ci.yml')).out,
    );
    expect(ci.notes.join(' ')).toMatch(/CI item/);
    expect(ci.warnings).toBeUndefined();
  });

  it('refuses paths with .. or an absolute start', async () => {
    const fx = await ready();
    for (const p of ['../x/**', 'src/../../x', '/etc/**']) {
      const r = await cli(fx, 'add', 'Bad', '--dod', 'x', '--path', p);
      expect(r.code, p).toBe(1);
    }
    expect(loadBoard(fx.dir).items).toEqual([]);
  });

  it('refuses what the board or the config would not accept, and writes nothing', async () => {
    const fx = await ready(MONOREPO);
    const file = join(fx.dir, '.studio', 'board.yaml');
    const before = readFileSync(file, 'utf8');
    const cases: string[][] = [
      ['add', 'No dod'],
      ['add', 'Bad type', '--type', 'review', '--dod', 'x'],
      ['add', 'Other repo', '--repo', 'org/other', '--dod', 'x'],
      ['add', 'Bad component', '--component', 'nope', '--dod', 'x'],
      ['add', 'Two\nlines', '--dod', 'x'],
      ['add', 'Bad glob', '--path', '', '--dod', 'x'],
      ['add'],
    ];
    for (const argv of cases) {
      const r = await cli(fx, ...argv);
      expect(r.code, argv.join(' ')).toBe(1);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    const ok = await cli(fx, 'add', 'In a', '--component', 'a', '--type', 'chore', '--dod', 'x');
    expect(ok.code).toBe(0);
    expect(loadBoard(fx.dir).items[0]?.component).toBe('a');
  });

  it('is refused in a crew session', async () => {
    const fx = await ready();
    fx.env.STUDIO_ROLE = 'crew';
    const r = await cli(fx, 'add', 'Sneaky', '--dod', 'x');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not for crew sessions/);
    expect(loadBoard(fx.dir).items).toEqual([]);
  });
});

describe('studio init, robustness', () => {
  const run = async (fx: ReturnType<typeof fixture>, extra: Partial<InitOptions> = {}) => {
    let out = '';
    const code = await runInit({
      project: fx.dir,
      ports: fx.ports,
      owner: fx.owner,
      env: fx.env,
      json: true,
      write: false,
      stdout: (s) => {
        out += s;
      },
      timeouts: { ghMs: 50, claudeMs: 50 },
      ...extra,
    });
    return { code, out: JSON.parse(out) };
  };
  const check = (out: { checks: Check[] }, name: string) => out.checks.find((c) => c.name === name);

  it('passes timeouts and asks gh about github.com only', async () => {
    const fx = fixture();
    await runInit({
      project: fx.dir,
      ports: fx.ports,
      owner: fx.owner,
      env: fx.env,
      json: true,
      write: false,
      stdout: () => {},
    });
    expect(fx.ghRuns).toContainEqual({
      args: ['auth', 'status', '--hostname', 'github.com'],
      timeoutMs: 15_000,
    });
    expect(fx.ghRuns).toContainEqual({ args: ['--version'], timeoutMs: 15_000 });
    expect(fx.apiTimeouts.length).toBeGreaterThan(0);
    expect(fx.apiTimeouts.every((t) => t === 15_000)).toBe(true);
    expect(fx.claudeTimeouts).toEqual([10_000]);
  });

  it('a gh or claude that hangs is a failed check, not a hang', async () => {
    for (const [hang, name] of [
      ['gh-version', 'gh'],
      ['gh-auth', 'gh'],
      ['claude', 'claude'],
    ] as const) {
      const fx = fixture({ hang: [hang] });
      const r = await run(fx);
      expect(r.code).toBe(0);
      expect(check(r.out, name), hang).toMatchObject({ status: 'fail' });
      expect(check(r.out, name)?.detail).toMatch(/timed out/);
    }
  });

  it('a GitHub API that hangs leaves CI as a warning with the fallback', async () => {
    const fx = fixture({ hang: ['api'] });
    const r = await run(fx);
    expect(r.code).toBe(0);
    expect(check(r.out, 'ci')).toMatchObject({ status: 'warn', fix: 'studio setup ci' });
    expect(r.out.config.ci.runners).toBe('github-hosted');
  });

  it('unreadable runners: a ci warning, a comment in studio.yaml and a first next step', async () => {
    const fx = fixture({ runnersFail: true });
    const r = await run(fx, { write: true });
    expect(r.code).toBe(0);
    expect(check(r.out, 'ci')).toMatchObject({ status: 'warn', fix: 'studio setup ci' });
    expect(r.out.nextSteps[0]).toMatch(/studio setup ci/);
    const text = readFileSync(join(fx.dir, '.studio', 'studio.yaml'), 'utf8');
    expect(text).toMatch(/# runners could not be read; run studio setup ci\nci:/);
    expect(loadConfig(fx.dir).ci.runners).toBe('github-hosted');
  });

  it('a second write that fails removes the first file', async () => {
    const fx = fixture();
    let calls = 0;
    await expect(
      run(fx, {
        write: true,
        writeFile: (path, text) => {
          calls += 1;
          if (calls === 2) throw new Error('disk full');
          writeFileSync(path, text, { flag: 'wx' });
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(existsSync(join(fx.dir, '.studio', 'studio.yaml'))).toBe(false);
    expect(existsSync(join(fx.dir, '.studio', 'board.yaml'))).toBe(false);
  });

  it('refuses a .studio that is a link or a file', async () => {
    const fx = fixture();
    const elsewhere = join(fx.home, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(fx.dir, '.studio'));
    await expect(run(fx, { write: true })).rejects.toThrow(/\.studio is not a directory/);
    expect(readdirSync(elsewhere)).toEqual([]);
    const fy = fixture({ files: { '.studio': 'a file' } });
    await expect(run(fy, { write: true })).rejects.toThrow(/\.studio is not a directory/);
  });

  it('a dry run writes nothing anywhere, and an invalid proposal is a FAIL line', async () => {
    const fx = fixture({ files: MONOREPO });
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('studio-init-')).length;
    const r = await run(fx);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('studio-init-')).length).toBe(before);
    expect(check(r.out, 'proposal')).toMatchObject({ status: 'pass' });
    const bad = await run(fx, { roles: { builder: { model: '-bad', wip: 2 } } });
    expect(bad.code).toBe(0);
    expect(check(bad.out, 'proposal')).toMatchObject({ status: 'fail' });
    const write = await run(fx, { write: true, roles: { builder: { model: '-bad', wip: 2 } } });
    expect(write.code).toBe(1);
    expect(existsSync(join(fx.dir, '.studio'))).toBe(false);
  });

  it('next steps leave out what is already done', async () => {
    const fx = fixture();
    installCrewToken('ghp_faketokenvalue0123456789', fx.owner);
    addAccount(fx.owner, 'work', 'fake-claude-token-0123456789abcdef', new Date('2026-11-01'));
    const r = await run(fx);
    expect(check(r.out, 'crew token')).toMatchObject({ status: 'pass' });
    expect(check(r.out, 'claude account')).toMatchObject({ status: 'pass' });
    const steps = r.out.nextSteps.join('\n');
    expect(steps).not.toContain('studio secret set crew-token');
    expect(steps).not.toContain('studio account add');
    expect(steps).toContain('/studio');
  });

  it('adds the hosts docker needs to network_allow', async () => {
    const fx = fixture({ files: { Dockerfile: 'FROM scratch\n' } });
    const r = await run(fx);
    expect(r.out.config.sandbox.network_allow).toEqual(
      expect.arrayContaining(['registry-1.docker.io', 'auth.docker.io']),
    );
  });
});
