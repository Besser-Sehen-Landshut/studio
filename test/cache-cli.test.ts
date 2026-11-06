import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard } from '../src/board.js';
import { type CowCopy, readCacheMeta } from '../src/cache.js';
import { runCli } from '../src/cli.js';
import { stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { reportName } from '../src/report.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-cache-cli-')));
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

const studioYaml = (cache: string) => `studio: 1
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
  cache: { model: haiku, wip: 1 }
owner_only: []
deploy_commands: []
${cache}`;

let n = 0;
function fx(cache = 'cache: { enabled: true }\n', files = { 'Cargo.toml': '', 'Cargo.lock': '' }) {
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
  mkdirSync(join(project, '.studio'));
  writeFileSync(join(project, '.studio', 'studio.yaml'), studioYaml(cache));
  writeFileSync(join(project, '.studio', 'board.yaml'), 'items: []\n');
  const env: Record<string, string | undefined> = { PATH: process.env.PATH };
  mkdirSync(join(home, '.config', 'studio'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'studio', 'config.yaml'),
    'crew_label_limits: { timezone: UTC }\n',
  );
  return {
    project,
    home,
    env,
    sha: git(project, 'rev-parse', 'HEAD'),
    state: stateRootFor(project, { env, homedir: home }),
  };
}

const cow: CowCopy = async (src, dst) => {
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  return true;
};
const ports = (): Ports => ({
  ...realPorts(),
  cow,
  gh: { api: async () => '0', run: async () => ({ code: 0, stdout: '', stderr: '' }) },
  claude: {
    start: async () => ({ pid: 1 }),
    alive: () => false,
    identity: async (p) => `start-${p}`,
    stop: async () => {},
  },
  // The real time: a report must be newer than its crew's start.
  clock: { now: () => new Date(), sleep: async () => {} },
  host: { loadAvg1: () => 0, cpuCount: () => 4 },
});

async function cli(f: ReturnType<typeof fx>, p: Ports, argv: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', f.project, ...argv], {
    ports: p,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: f.env,
    homedir: f.home,
    cwd: f.project,
  });
  return { code, out, err };
}

/** The cache crew's run: what its build left, and its report. */
function finish(f: ReturnType<typeof fx>, id: string, status = 'done', build = true) {
  const clone = join(f.state, 'clones', id);
  if (build) {
    mkdirSync(join(clone, 'target', 'debug'), { recursive: true });
    writeFileSync(join(clone, 'target', 'debug', 'x.rlib'), 'rlib');
  }
  const dir = join(clone, '.studio', 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, reportName(f.state, id) as string),
    `---\nstatus: ${status}\nitem: ${id}\nlessons: []\nquestions: []\n---\n\nran both\n`,
  );
}

describe('the cache role through tick and collect', () => {
  it('tick adds and launches a cache item; its collect publishes the cache from main', async () => {
    const f = fx();
    const p = ports();
    const tick = JSON.parse((await cli(f, p, ['tick'])).out);
    expect(tick.cache).toEqual({ added: 'APP-1' });
    expect(tick.launched.map((l: { item: string }) => l.item)).toEqual(['APP-1']);
    const item = loadBoard(f.project).items[0];
    expect(item).toMatchObject({ role: 'cache', type: 'research' });
    finish(f, 'APP-1');
    const r = await cli(f, p, ['collect', 'APP-1']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ status: 'merged', cache: { sha: f.sha } });
    expect(readCacheMeta(f.state)).toMatchObject({ sha: f.sha, seeds: ['cargo-target'] });
    // Fresh now: the next tick adds nothing.
    const again = JSON.parse((await cli(f, p, ['tick'])).out);
    expect(again.cache).toBeUndefined();
    const doctor = await cli(f, p, ['doctor']);
    expect(doctor.out).toContain(
      `build cache: on, built ${new Date().toISOString().slice(0, 10)} from ${f.sha.slice(0, 12)}`,
    );
  });

  it('a build that left nothing blocks the item with the reason, and no second item comes', async () => {
    const f = fx();
    const p = ports();
    await cli(f, p, ['tick']);
    finish(f, 'APP-1', 'done', false);
    const r = JSON.parse((await cli(f, p, ['collect', 'APP-1'])).out);
    expect(r.status).toBe('blocked');
    const item = loadBoard(f.project).items[0];
    expect(item?.notes?.join('\n')).toMatch(/build cache not published: the build left nothing/);
    expect(readCacheMeta(f.state)).toBeUndefined();
    const again = JSON.parse((await cli(f, p, ['tick'])).out);
    expect(again.cache).toBeUndefined();
  });

  it('off by default, and nothing on a main with nothing to cache', async () => {
    const off = fx('');
    expect(JSON.parse((await cli(off, ports(), ['tick'])).out).cache).toBeUndefined();
    expect((await cli(off, ports(), ['doctor'])).out).toMatch(/^build cache: off$/m);
    const empty = fx('cache: { enabled: true }\n', {} as never);
    expect(JSON.parse((await cli(empty, ports(), ['tick'])).out).cache).toBeUndefined();
    expect(loadBoard(empty.project).items).toEqual([]);
  });
});
