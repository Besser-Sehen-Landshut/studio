import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  checkStateMarker,
  ownerStateRootFor,
  projectRealpath,
  stateRootFor,
} from '../src/paths.js';
import type { Gh, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-gc-cli-')));
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

const STUDIO_YAML = `studio: 1
primary_repo: org/app
repos: [org/app]
allow_ambient_credentials: true
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 8, merge_max_busy: 5, check_twice_seconds: 30 }
merge:
  strategy: studio-queue
  contract_paths: []
  method: squash
roles:
  builder: { model: sonnet, wip: 3 }
  reviewer: { model: opus, wip: 1 }
owner_only: []
deploy_commands: []
`;

const itemYaml = (id: string, status: string) =>
  [
    `  - id: ${id}`,
    `    title: Item ${id}`,
    '    type: fix',
    '    role: builder',
    '    repo: org/app',
    '    size: S',
    '    priority: 1',
    `    status: ${status}`,
    '    paths: []',
    `    touches: [${id.toLowerCase()}/**]`,
    '    depends_on: []',
    '    dod: ["tests pass"]',
    '    history: []',
  ].join('\n');

let n = 0;
function makeFx(items: [string, string][]) {
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
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  mkdirSync(join(project, '.studio'));
  writeFileSync(join(project, '.studio', 'studio.yaml'), STUDIO_YAML);
  writeFileSync(
    join(project, '.studio', 'board.yaml'),
    `items:\n${items.map(([id, s]) => itemYaml(id, s)).join('\n')}\n`,
  );
  const env = { PATH: process.env.PATH };
  const state = stateRootFor(project, { env, homedir: home });
  checkStateMarker(state, {
    projectRealpath: projectRealpath(project),
    originUrl: git(project, 'remote', 'get-url', 'origin'),
  });
  return { project, home, env, state, owner: ownerStateRootFor({ env, homedir: home }) };
}
type Fx = ReturnType<typeof makeFx>;

/** A clone of the item with one commit and a build output folder; returns the tip. */
function makeClone(fx: Fx, id: string): string {
  const dir = join(fx.state, 'clones', id);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', `studio/${id}`);
  writeFileSync(join(dir, 'a.txt'), `${id}\n`);
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'work');
  mkdirSync(join(dir, 'target', 'debug'), { recursive: true });
  writeFileSync(join(dir, 'target', 'debug', 'bin'), Buffer.alloc(300_000));
  mkdirSync(join(fx.state, 'homes', id), { recursive: true });
  return git(dir, 'rev-parse', 'HEAD');
}

/** GitHub knows `pushed` as part of main; every other api call answers `0` like the other tests. */
function fakeGh(pushed: string[]) {
  const calls: string[] = [];
  const gh: Gh = {
    async api(path) {
      calls.push(path);
      const cmp = /^repos\/org\/app\/compare\/main\.\.\.([0-9a-f]+)$/.exec(path);
      if (cmp) {
        if (!pushed.includes(cmp[1] as string)) throw new Error('HTTP 404');
        return 'behind\n';
      }
      return '0';
    },
    async run(args) {
      calls.push(args.join(' '));
      return { code: 1, stdout: '', stderr: 'unscripted' };
    },
  };
  return { gh, calls };
}

function fakePorts(gh: Gh): Ports {
  return {
    gh,
    git: realPorts().git,
    credentials: realPorts().credentials,
    claude: {
      start: async () => ({ pid: 1 }),
      alive: () => false,
      identity: async () => undefined,
      stop: async () => {},
    },
    clock: { now: () => new Date('2026-11-06T10:00:00Z'), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
}

async function cli(fx: Fx, ports: Ports, ...argv: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', fx.project, ...argv], {
    ports,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: fx.env,
    homedir: fx.home,
    cwd: fx.project,
    isTerminal: false,
  });
  return { code, out, err };
}

describe('studio gc', () => {
  it('is a dry run by default that lists sizes and verdicts, and --apply removes', async () => {
    const fx = makeFx([
      ['APP-1', 'merged'],
      ['APP-2', 'merged'],
      ['APP-3', 'in_progress'],
    ]);
    const a = makeClone(fx, 'APP-1');
    makeClone(fx, 'APP-2');
    makeClone(fx, 'APP-3');
    const ports = fakePorts(fakeGh([a]).gh);
    const dry = await cli(fx, ports, 'gc');
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(
      /^APP-1 [\d.]+ [kMG]?B \(\.git [^,]+, target [^)]+\): remove, merged$/m,
    );
    expect(dry.out).toMatch(/^APP-2 .*: keep, commit [0-9a-f]{12} is not on GitHub/m);
    expect(dry.out).toMatch(/^APP-3 .*: keep, the item is in_progress$/m);
    expect(dry.out).toMatch(/^clones: 3, .*; removable: 1, /m);
    expect(dry.out).toContain('dry run: studio gc --apply removes them');
    expect(existsSync(join(fx.state, 'clones', 'APP-1'))).toBe(true);

    const json = JSON.parse((await cli(fx, ports, 'gc', '--json')).out);
    expect(json).toMatchObject({ dryRun: true, clones: 3, removable: 1 });
    expect(json.removableBytes).toBeGreaterThan(300_000);

    const applied = await cli(fx, ports, 'gc', '--apply');
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('removed: APP-1');
    expect(existsSync(join(fx.state, 'clones', 'APP-1'))).toBe(false);
    expect(existsSync(join(fx.state, 'homes', 'APP-1'))).toBe(false);
    expect(existsSync(join(fx.state, 'clones', 'APP-2'))).toBe(true);
    expect(existsSync(join(fx.state, 'clones', 'APP-3'))).toBe(true);
  });

  it('refuses crew sessions and arguments; --apply belongs to adopt and gc', async () => {
    const fx = makeFx([['APP-1', 'merged']]);
    makeClone(fx, 'APP-1');
    const ports = fakePorts(fakeGh([]).gh);
    const crew = await runCli(['--project', fx.project, 'gc', '--apply'], {
      ports,
      stdout: () => {},
      stderr: () => {},
      env: { ...fx.env, STUDIO_ROLE: 'crew' },
      homedir: fx.home,
      cwd: fx.project,
    });
    expect(crew).not.toBe(0);
    expect(existsSync(join(fx.state, 'clones', 'APP-1'))).toBe(true);
    expect((await cli(fx, ports, 'gc', 'APP-1')).err).toMatch(/gc takes no arguments/);
    expect((await cli(fx, ports, 'board', '--apply')).err).toMatch(
      /--apply works with adopt and gc only/,
    );
  });
});

describe('studio doctor', () => {
  it('shows the clones total and how many can go, without asking GitHub', async () => {
    const fx = makeFx([
      ['APP-1', 'merged'],
      ['APP-2', 'in_review'],
    ]);
    makeClone(fx, 'APP-1');
    makeClone(fx, 'APP-2');
    mkdirSync(join(fx.state, 'homes', 'APP-3'), { recursive: true });
    const { gh, calls } = fakeGh([]);
    const r = await cli(fx, fakePorts(gh), 'doctor');
    expect(r.out).toMatch(
      /^clones: 2, [\d.]+ [kMG]?B with crew homes and tmp dirs; removable now: 0 \(0 B\), 1 more once GitHub shows their commits are pushed \(studio gc\)$/m,
    );
    expect(calls.filter((c) => c.includes('compare') || c.includes('pulls'))).toEqual([]);
    const j = JSON.parse((await cli(fx, fakePorts(gh), 'doctor', '--json')).out);
    expect(j.clones).toMatchObject({ count: 2, removable: 0, unchecked: 1 });
  });
});

describe('the tick cleans up', () => {
  it('removes the clone of a merged item whose commits are on GitHub, and keeps the others', async () => {
    const fx = makeFx([
      ['APP-1', 'merged'],
      ['APP-2', 'dropped'],
    ]);
    const a = makeClone(fx, 'APP-1');
    makeClone(fx, 'APP-2');
    const ports = fakePorts(fakeGh([a]).gh);
    const preview = JSON.parse((await cli(fx, ports, 'tick', '--dry-run')).out);
    expect(preview.cleanup).toEqual([
      { item: 'APP-1', would: 'remove once GitHub shows its commits are pushed' },
    ]);
    expect(existsSync(join(fx.state, 'clones', 'APP-1'))).toBe(true);
    const t = await cli(fx, ports, 'tick');
    const out = JSON.parse(t.out);
    expect(out.cleaned).toEqual(['APP-1']);
    expect(out.errors).toEqual([]);
    expect(existsSync(join(fx.state, 'clones', 'APP-1'))).toBe(false);
    // Dropped without a drop time in its history: kept, and the tick says nothing about it.
    expect(existsSync(join(fx.state, 'clones', 'APP-2'))).toBe(true);
    const again = JSON.parse((await cli(fx, ports, 'tick')).out);
    expect(again.cleaned).toBeUndefined();
  });
});
