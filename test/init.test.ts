import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { proposeComponents } from '../src/init.js';
import { type Gh, type Ports, realPorts } from '../src/ports.js';

const root = mkdtempSync(join(tmpdir(), 'studio-init-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Opts = {
  origin?: string | null;
  files?: Record<string, string>;
  ghAuth?: number;
  claude?: number;
  runners?: string;
};

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
  const gh: Gh = {
    async api(path) {
      if (path.endsWith('/actions/runners'))
        return path.startsWith('/orgs/') ? (o.runners ?? '') : '';
      if (path.startsWith('/repos/')) return 'private\n';
      throw new Error(`unscripted ${path}`);
    },
    async run(args) {
      if (args[0] === 'auth') return { code: o.ghAuth ?? 0, stdout: '', stderr: '' };
      return { code: 0, stdout: 'gh version 2.80.0\n', stderr: '' };
    },
  };
  const real = realPorts();
  const ports: Ports = {
    ...real,
    gh,
    clock: { now: () => new Date('2026-11-04T10:00:00Z'), sleep: async () => {} },
    plugins: {
      run: async () => ({ code: o.claude ?? 0, stdout: '2.5.0 (Claude Code)\n', stderr: '' }),
    },
  };
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CONFIG_HOME: join(home, 'config'),
  };
  return { dir, home, ports, env };
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
    const r = await cli(fx, 'add', 'Fix the login', '--type', 'fix', '--dod', 'test added');
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

  it('a feature without a plan is added and says what it still needs', async () => {
    const fx = await ready();
    const r = await cli(fx, 'add', 'Health endpoint', '--dod', 'GET /health returns 200');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ type: 'feature', missing: ['plan'] });
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
