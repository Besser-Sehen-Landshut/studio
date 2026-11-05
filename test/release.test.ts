import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { parseConfig } from '../src/config.js';
import { classifyDecision } from '../src/pane-data.js';
import { checkStateMarker, projectRealpath, stateRootFor } from '../src/paths.js';
import type { Gh, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import { RELEASES_FILE, RELEASES_LOG, readReleases } from '../src/release.js';

// Each test builds real repositories with git; under a full parallel run that takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-release-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  // Fixed commit times: the note places items by their merge time against the commit's.
  GIT_AUTHOR_DATE: '2026-11-05T08:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-05T08:00:00Z',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const RELEASE_BLOCK = `    release:
      workflow: .github/workflows/deploy.yml
      post_checks:
        - { workflow: .github/workflows/deploy.yml, job: smoke }
      migrations: ["server/migrations/**"]
      config: ["server/.env.example"]
      rollback: { workflow: .github/workflows/rollback.yml }
      approvers:
        - id: partner
          who: the partner's maintainer
          for: the partner integration
          paths: ["server/partner/**"]
`;

const studioYaml = (release = RELEASE_BLOCK, extra = '') => `studio: 1
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
${extra}components:
  - id: api
    name: API server
    repo: org/app
    paths: ["server/**"]
${release}  - id: web
    name: Web app
    repo: org/app
    paths: ["web/**"]
`;

const DEPLOY = `name: deploy
on:
  workflow_dispatch:
    inputs:
      sha: { required: true }
jobs:
  deploy: { runs-on: ubuntu-latest, steps: [{ run: echo deploy }] }
  smoke: { runs-on: ubuntu-latest, steps: [{ run: echo smoke }] }
`;

interface Fx {
  project: string;
  home: string;
  env: Record<string, string | undefined>;
  state: string;
  c0: string;
  head: string;
}

let n = 0;
/** A repository whose first commit runs in production and whose second is to be released. */
function makeFx(
  o: {
    migration?: string;
    partner?: boolean;
    deploy?: string;
    release?: string;
    extra?: string;
  } = {},
): Fx {
  const base = join(root, `p${n++}`);
  mkdirSync(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = join(base, 'clone');
  git(base, 'clone', '-q', origin, project);
  git(project, 'checkout', '-q', '-b', 'main');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  };
  write('.studio/studio.yaml', studioYaml(o.release, o.extra));
  write('.github/workflows/deploy.yml', o.deploy ?? DEPLOY);
  write(
    '.github/workflows/rollback.yml',
    'name: rollback\non: { workflow_dispatch: { inputs: { sha: { required: true } } } }\njobs: { back: { runs-on: ubuntu-latest, steps: [{ run: echo back }] } }\n',
  );
  write('server/app.ts', 'export const v = 1;\n');
  write('server/.env.example', 'DATABASE_URL=postgres://example\n');
  write('server/migrations/0001_init.sql', 'CREATE TABLE a (id int);\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'production');
  const c0 = git(project, 'rev-parse', 'HEAD');
  write('server/app.ts', 'export const v = 2;\n');
  write(
    'server/.env.example',
    'DATABASE_URL=postgres://example\nPAYMENT_KEY=a-real-looking-value\n',
  );
  write('server/migrations/0002_orders.sql', o.migration ?? 'CREATE TABLE orders (id bigint);\n');
  if (o.partner === true) write('server/partner/feed.ts', 'export const feed = 1;\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'the release');
  const head = git(project, 'rev-parse', 'HEAD');
  git(project, 'push', '-q', 'origin', 'main');
  write(
    '.studio/board.yaml',
    `items:
  - id: APP-1
    title: Orders table
    type: feature
    role: builder
    repo: org/app
    size: S
    priority: 1
    status: merged
    paths: ["server/**"]
    touches: []
    depends_on: []
    dod: ["tests pass"]
    epic: E-1
    pr: 7
    history: [{ at: "2026-11-05T09:00:00.000Z", from: queued, to: merged, by: studio }]
  - id: APP-2
    title: Web page
    type: feature
    role: builder
    repo: org/app
    size: S
    priority: 1
    status: merged
    paths: ["web/**"]
    touches: []
    depends_on: []
    dod: ["tests pass"]
    pr: 8
    history: [{ at: "2026-11-05T09:00:00.000Z", from: queued, to: merged, by: studio }]
epics:
  - id: E-1
    title: Pay by invoice
    status: open
    goal: Customers pay by invoice
    acceptance: ["an invoice order reaches the backend"]
`,
  );
  const env = { PATH: process.env.PATH };
  const fx = { project, home, env, state: stateRootFor(project, { env, homedir: home }), c0, head };
  checkStateMarker(fx.state, {
    projectRealpath: projectRealpath(project),
    originUrl: git(project, 'remote', 'get-url', 'origin'),
  });
  return fx;
}

type Reply = { code?: number; stdout?: string; stderr?: string };

/** A GitHub that knows the repository, its workflows and the runs the test scripts. */
function fakeGh(
  fx: Fx,
  o: {
    busy?: number;
    runs?: Record<string | number, unknown>;
    dispatch?: Reply;
    /** The head of main on the n-th read, when it moves while Studio checks. */
    head?: (n: number) => string;
  } = {},
) {
  let heads = 0;
  const calls: string[] = [];
  const runs: Record<string | number, unknown> = o.runs ?? {};
  const dispatches: { line: string; recorded: string | undefined }[] = [];
  const gh: Gh = {
    async api(path) {
      calls.push(`api ${path}`);
      if (path === 'repos/org/app/commits/main') return `${o.head?.(++heads) ?? fx.head}\n`;
      if (path === `repos/org/app/commits/${fx.c0}`) return `${fx.c0}\n`;
      if (path === 'repos/org/app/commits/v1') return `${fx.c0}\n`;
      if (path.includes('/actions/runs?status=')) return `${o.busy ?? 0}\n`;
      throw new Error(`unscripted api ${path}`);
    },
    async run(args) {
      const line = args.join(' ');
      calls.push(line);
      if (line === 'repo view org/app --json defaultBranchRef') {
        return {
          code: 0,
          stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }),
          stderr: '',
        };
      }
      if (line === 'pr view 7 --repo org/app --json mergeCommit') {
        return { code: 0, stdout: JSON.stringify({ mergeCommit: { oid: fx.head } }), stderr: '' };
      }
      if (line.startsWith('workflow list --repo org/app')) {
        return {
          code: 0,
          stdout: JSON.stringify([
            { id: 11, path: '.github/workflows/deploy.yml', name: 'deploy' },
            { id: 12, path: '.github/workflows/smoke.yml', name: 'Smoke' },
            { id: 13, path: '.github/workflows/rollback.yml', name: 'Rollback API' },
            { id: 14, path: '.github/workflows/ci.yml', name: 'CI' },
          ]),
          stderr: '',
        };
      }
      if (line.startsWith('workflow run ')) {
        // What the record said at the moment GitHub was asked: it must be written first.
        const file = join(fx.state, RELEASES_FILE);
        dispatches.push({
          line,
          recorded: existsSync(file) ? readFileSync(file, 'utf8') : undefined,
        });
        const r = o.dispatch ?? {
          stdout: `https://github.com/org/app/actions/runs/${line.startsWith('workflow run 12') ? 901 : 900}\n`,
        };
        return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      const view = /^run view (\d+) --repo org\/app --json /.exec(line);
      if (view !== null) {
        const r = runs[Number(view[1])];
        return r === undefined
          ? { code: 1, stdout: '', stderr: 'not found' }
          : { code: 0, stdout: JSON.stringify({ headSha: fx.head, ...(r as object) }), stderr: '' };
      }
      if (line.startsWith('run list --repo org/app --workflow')) {
        return { code: 0, stdout: JSON.stringify(runs.list ?? []), stderr: '' };
      }
      throw new Error(`unscripted gh call: ${line}`);
    },
  };
  return { gh, calls, runs, dispatches };
}

function fakePorts(gh: Gh) {
  let t = Date.parse('2026-11-05T10:00:00Z');
  const ports: Ports = {
    gh,
    git: realPorts().git,
    credentials: realPorts().credentials,
    claude: {
      start: async () => ({ pid: 1 }),
      alive: () => false,
      identity: async () => undefined,
      stop: async () => {},
    },
    clock: {
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
    },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
  return { ports, advance: (ms: number) => (t += ms) };
}

async function cli(
  fx: Fx,
  ports: Ports,
  argv: string[],
  o: { terminal?: boolean; env?: Record<string, string> } = {},
) {
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
    env: { ...fx.env, ...(o.env ?? {}) },
    homedir: fx.home,
    cwd: fx.project,
    isTerminal: o.terminal === true,
  });
  let parsed: ReturnType<typeof JSON.parse>;
  try {
    parsed = out.trim() === '' ? undefined : JSON.parse(out);
  } catch {
    parsed = undefined;
  }
  return { code, out, err, json: parsed };
}

const run = (
  status: string,
  conclusion: string | null,
  jobs: [string, string, string | null][],
) => ({
  databaseId: 900,
  status,
  conclusion,
  event: 'workflow_dispatch',
  workflowDatabaseId: 11,
  headBranch: 'main',
  jobs: jobs.map(([name, s, c]) => ({ name, status: s, conclusion: c })),
});

describe('studio release: the note', () => {
  it('needs the commit production runs for the first release, and a dry run writes nothing', async () => {
    const fx = makeFx();
    const { gh } = fakeGh(fx);
    const p = fakePorts(gh);
    const first = await cli(fx, p.ports, ['release', 'api', '--dry-run']);
    expect(first.code).toBe(1);
    expect(first.err).toMatch(/the first release of api: name the commit production runs now/);
    const dry = await cli(fx, p.ports, ['release', 'api', '--dry-run', '--since', 'v1']);
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({
      dryRun: true,
      release: 'api-1',
      status: 'draft',
      sha: fx.head,
      since: fx.c0,
      needs: { owner: [], approvers: [] },
    });
    expect(existsSync(join(fx.state, RELEASES_FILE))).toBe(false);
    expect(existsSync(join(fx.state, RELEASES_LOG))).toBe(false);
    const note: string = dry.json.note;
    // Changes by epic: only the component's items, under their epic.
    expect(note).toContain('- E-1 Pay by invoice\n  - APP-1 Orders table (#7)');
    expect(note).not.toContain('APP-2');
    // Migrations in order with kind and risk.
    expect(note).toContain(
      '- server/migrations/0002_orders.sql (added): additive, low risk; every statement adds something new',
    );
    // Configuration by name only, never a value.
    expect(note).toContain('Added: PAYMENT_KEY');
    expect(note).not.toContain('a-real-looking-value');
    expect(note).not.toContain('postgres://');
    // The way back: shown with the commit production ran before, never run.
    expect(note).toContain(
      `run ${'.github/workflows/rollback.yml'} by hand with the commit production ran before this release`,
    );
    expect(note).toContain('- .github/workflows/deploy.yml / smoke');
    expect(dry.json.announce).toBe(
      `Release api-1 deploys API server at ${fx.head.slice(0, 7)} (1 commits) to production through .github/workflows/deploy.yml; once it runs, 1 migration run and stay applied, and the deploy cannot be taken back, only followed by another.`,
    );
  });

  it('refuses a component without changes, an unknown one and one without a release block', async () => {
    const fx = makeFx();
    const p = fakePorts(fakeGh(fx).gh);
    expect((await cli(fx, p.ports, ['release', 'web', '--since', 'v1'])).err).toMatch(
      /component web has no release: block in .studio\/studio.yaml at [0-9a-f]{7} on the default branch/,
    );
    expect((await cli(fx, p.ports, ['release', 'nope'])).err).toMatch(/unknown component nope/);
  });
});

describe('studio release: announce, trigger once, follow the checks', () => {
  it('announces first, triggers on the next call with the record written before GitHub hears, then ends done', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    const a = await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    expect(a.code).toBe(0);
    expect(a.json).toMatchObject({ release: 'api-1', status: 'announced', pending: [] });
    expect(a.json.next).toMatch(
      /tell the owner the announcement, then run studio release api again/,
    );
    // Nothing was started in the call that announced.
    expect(g.dispatches).toEqual([]);
    const logged = readFileSync(join(fx.state, RELEASES_LOG), 'utf8');
    expect(JSON.parse(logged.split('\n')[0] as string)).toMatchObject({
      event: 'announced',
      release: 'api-1',
      text: a.json.announce,
    });

    const t = await cli(fx, p.ports, ['release', 'api']);

    expect(t.code).toBe(0);
    expect(t.json).toMatchObject({ release: 'api-1', status: 'triggered', run: 900 });
    expect(g.dispatches.map((d) => d.line)).toEqual([
      `workflow run 11 --repo org/app --ref main -f sha=${fx.head}`,
    ]);
    // The trigger was recorded before the dispatch: a crash then never starts it twice.
    expect(JSON.parse(g.dispatches[0]?.recorded as string).releases[0]).toMatchObject({
      status: 'triggered',
      trigger: { by: 'lead', head: fx.head, workflowId: 11 },
    });

    g.runs[900] = run('in_progress', null, [['deploy', 'in_progress', null]]);
    const w = await cli(fx, p.ports, ['release', 'api']);
    expect(w.json).toMatchObject({
      status: 'triggered',
      waiting: 'api-1: the release run 900 is in_progress',
    });
    g.runs[900] = run('completed', 'success', [
      ['deploy', 'completed', 'success'],
      ['smoke', 'completed', 'success'],
    ]);
    const tick = await cli(fx, p.ports, ['tick']);
    expect(tick.json.releases).toEqual([
      expect.objectContaining({ id: 'api-1', component: 'api', status: 'done' }),
    ]);
    expect(g.dispatches).toHaveLength(1);
    // The deploy counts in the metrics, with its release.
    const metrics = readFileSync(join(fx.state, 'metrics.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(metrics.at(-1) as string)).toMatchObject({
      type: 'deployed',
      sha: fx.head,
      release: 'api-1',
    });
    // The next release starts where this one ended.
    expect((await cli(fx, p.ports, ['release', 'api', '--dry-run'])).err).toMatch(
      /nothing to release: api runs [0-9a-f]{7} already/,
    );
  });

  it('never starts twice: a trigger without a known run is looked up, not dispatched again', async () => {
    const fx = makeFx();
    const g = fakeGh(fx, { dispatch: { stdout: 'created\n' } });
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const t = await cli(fx, p.ports, ['release', 'api']);
    expect(t.json.status).toBe('triggered');
    expect(t.json.run).toBeUndefined();
    const again = await cli(fx, p.ports, ['release', 'api']);
    expect(again.json.waiting).toBe(
      'api-1: waiting for the run of .github/workflows/deploy.yml to appear',
    );
    p.advance(11 * 60_000);
    const lost = await cli(fx, p.ports, ['tick']);
    expect(lost.json.needsLead).toContainEqual({
      item: 'api-1',
      reason: expect.stringMatching(
        /^release unknown: api-1: no run of .* nothing is started again$/,
      ),
    });
    g.runs.list = [{ databaseId: 900, createdAt: '2026-11-05T10:00:31Z' }];
    g.runs[900] = run('completed', 'success', [['smoke', 'completed', 'success']]);
    const found = await cli(fx, p.ports, ['release', 'api']);
    expect(found.json).toMatchObject({ status: 'done', run: 900 });
    expect(g.dispatches).toHaveLength(1);
  });

  it('two dispatches since the trigger: Studio does not guess', async () => {
    const fx = makeFx();
    const g = fakeGh(fx, { dispatch: { stdout: '' } });
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    g.runs.list = [
      { databaseId: 900, createdAt: '2026-11-05T10:00:31Z' },
      { databaseId: 905, createdAt: '2026-11-05T10:00:40Z' },
    ];
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.json.needsLead[0].reason).toMatch(/several runs of .* Studio does not guess/);
    expect(r.json.status).toBe('triggered');
  });

  it('stops on red with the way back shown and run by no one; a missing job fails closed', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    // The run passed, but the smoke job is not in it: no result is no pass.
    g.runs[900] = run('completed', 'success', [['deploy', 'completed', 'success']]);
    const tick = await cli(fx, p.ports, ['tick']);
    const line = tick.json.needsLead.find((l: { item: string }) => l.item === 'api-1');
    expect(line.reason).toMatch(
      /^release failed: api-1: \.github\/workflows\/deploy\.yml \/ smoke gave no result after the deploy; [0-9a-f]{7} is deployed; Studio runs nothing back; the way back: run \.github\/workflows\/rollback\.yml by hand/,
    );
    expect(tick.json.releases[0]).toMatchObject({ id: 'api-1', status: 'failed' });
    // Studio never starts the way back.
    expect(g.calls.filter((c) => c.startsWith('workflow run 13'))).toEqual([]);
    // It stays the lead's decision for a day, then drops off.
    expect((await cli(fx, p.ports, ['tick'])).json.needsLead).toContainEqual(line);
    p.advance(25 * 3_600_000);
    expect(
      ((await cli(fx, p.ports, ['tick'])).json.needsLead ?? []).filter(
        (l: { item: string }) => l.item === 'api-1',
      ),
    ).toEqual([]);
  });

  it('a red release run stops before the checks, and its deploy is not counted', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    g.runs[900] = run('completed', 'failure', [['deploy', 'completed', 'failure']]);
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.json).toMatchObject({ status: 'failed', reason: 'the release run 900 ended failure' });
    expect(existsSync(join(fx.state, 'metrics.jsonl'))).toBe(false);
  });

  it('a run of another workflow or event fails closed, and no result before the timeout too', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    g.runs[900] = { ...run('completed', 'success', []), workflowDatabaseId: 99 };
    expect((await cli(fx, p.ports, ['release', 'api'])).json.reason).toBe(
      'run 900 is not a dispatch of .github/workflows/deploy.yml',
    );

    const fx2 = makeFx();
    const g2 = fakeGh(fx2);
    const p2 = fakePorts(g2.gh);
    await cli(fx2, p2.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx2, p2.ports, ['release', 'api']);
    p2.advance(61 * 60_000);
    expect((await cli(fx2, p2.ports, ['release', 'api'])).json.reason).toBe(
      'the release run 900 cannot be read: no known result',
    );
  });

  it('starts a post check in another workflow once, after the release run passed', async () => {
    const release = RELEASE_BLOCK.replace(
      '        - { workflow: .github/workflows/deploy.yml, job: smoke }',
      '        - { workflow: .github/workflows/smoke.yml, job: prod }',
    );
    const fx = makeFx({ release });
    writeFileSync(join(fx.project, '.github/workflows/smoke.yml'), DEPLOY);
    git(fx.project, 'add', '.github/workflows/smoke.yml');
    git(fx.project, 'commit', '-q', '-m', 'smoke');
    fx.head = git(fx.project, 'rev-parse', 'HEAD');
    git(fx.project, 'push', '-q', 'origin', 'main');
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    g.runs[900] = run('completed', 'success', [['deploy', 'completed', 'success']]);
    const c = await cli(fx, p.ports, ['release', 'api']);
    expect(c.json).toMatchObject({ status: 'checking' });
    expect(g.dispatches.map((d) => d.line)).toEqual([
      `workflow run 11 --repo org/app --ref main -f sha=${fx.head}`,
      `workflow run 12 --repo org/app --ref main -f sha=${fx.head}`,
    ]);
    g.runs[901] = {
      ...run('completed', 'success', [['prod', 'completed', 'success']]),
      workflowDatabaseId: 12,
    };
    expect((await cli(fx, p.ports, ['release', 'api'])).json.status).toBe('done');
    expect(g.dispatches).toHaveLength(2);
  });
});

describe('studio release: what holds the trigger back', () => {
  it('holds while CI is over the merge rule, and while paused', async () => {
    const fx = makeFx();
    const g = fakeGh(fx, { busy: 3 });
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const held = await cli(fx, p.ports, ['release', 'api']);
    expect(held.json).toMatchObject({ status: 'announced' });
    expect(held.json.held).toMatch(
      /^held: ci capacity \(busy 6 of 8, limit 5\); run studio release api again later$/,
    );
    expect(g.dispatches).toEqual([]);
    const paused = await cli(fx, p.ports, ['pause'], { terminal: true });
    expect(paused.code).toBe(0);
    expect((await cli(fx, p.ports, ['release', 'api'])).json.held).toMatch(/^paused/);
    expect(g.dispatches).toEqual([]);
  });

  it('refuses a release workflow that changed on main since the release commit', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    writeFileSync(join(fx.project, '.github/workflows/deploy.yml'), `${DEPLOY}# changed\n`);
    git(fx.project, 'add', '.github/workflows/deploy.yml');
    git(fx.project, 'commit', '-q', '-m', 'change the deploy');
    const moved = git(fx.project, 'rev-parse', 'HEAD');
    git(fx.project, 'push', '-q', 'origin', 'main');
    const oldHead = fx.head;
    fx.head = moved;
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /\.github\/workflows\/deploy\.yml changed since api-1 was announced: studio release cancel api-1/,
    );
    expect(g.dispatches).toEqual([]);
    expect(readReleases(fx.state)[0]).toMatchObject({ status: 'announced', sha: oldHead });
  });

  it('refuses a release workflow without the sha input', async () => {
    const fx = makeFx({
      deploy: DEPLOY.replace('    inputs:\n      sha: { required: true }\n', ''),
    });
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.err).toMatch(/needs on: workflow_dispatch with an input sha/);
    expect(g.dispatches).toEqual([]);
  });

  it('a dispatch GitHub refuses fails the release, and nothing starts again', async () => {
    const fx = makeFx();
    const g = fakeGh(fx, {
      dispatch: { code: 1, stderr: 'HTTP 422: Workflow does not have workflow_dispatch trigger' },
    });
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.json).toMatchObject({ status: 'failed' });
    expect(r.json.reason).toMatch(/could not be started \(HTTP 422.*\); nothing was deployed/);
    expect(g.dispatches).toHaveLength(1);
  });

  it('the release, an approval and a cancel are never for a crew', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    for (const argv of [
      ['release', 'api', '--since', 'v1'],
      ['release', 'approve', 'api-1', 'owner', '--said', 'yes'],
      ['release', 'cancel', 'api-1', '--reason', 'x'],
    ]) {
      const r = await cli(fx, p.ports, argv, { env: { STUDIO_ROLE: 'crew' } });
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).toMatch(/not for crew sessions/);
    }
    expect(g.dispatches).toEqual([]);
  });
});

describe('studio release: approvals', () => {
  it('a destructive migration waits for the owner, who approves only in a terminal', async () => {
    const fx = makeFx({ migration: 'ALTER TABLE a DROP COLUMN legacy;\n' });
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    const a = await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    expect(a.json).toMatchObject({ status: 'approvals', pending: ['owner'] });
    expect(a.json.announce).toMatch(
      /once it runs, the migration server\/migrations\/0002_orders.sql change or remove data that only a backup brings back\.$/,
    );
    expect(a.json.needsLead).toEqual([
      {
        item: 'api-1',
        reason:
          'release approval: api-1 ships migrations that are not clearly additive (server/migrations/0002_orders.sql); the owner approves in a terminal: studio release approve api-1 owner --said "<the owner\'s words>"',
      },
    ]);
    expect(a.json.note).toContain(
      '- server/migrations/0002_orders.sql (added): destructive, needs the owner; ALTER TABLE with DROP',
    );
    // The trigger waits; the lead cannot approve for the owner.
    expect((await cli(fx, p.ports, ['release', 'api'])).json.status).toBe('approvals');
    const lead = await cli(fx, p.ports, ['release', 'approve', 'api-1', 'owner', '--said', 'go']);
    expect(lead.code).toBe(1);
    expect(lead.err).toMatch(/the owner approves migrations himself, in a terminal/);
    const tick = await cli(fx, p.ports, ['tick']);
    expect(tick.json.needsLead).toContainEqual(a.json.needsLead[0]);
    const owner = await cli(
      fx,
      p.ports,
      ['release', 'approve', 'api-1', 'owner', '--said', 'Yes, the legacy column is unused.'],
      { terminal: true },
    );
    expect(owner.json).toMatchObject({ release: 'api-1', status: 'announced', pending: [] });
    const rec = readReleases(fx.state)[0];
    expect(rec?.approvals).toEqual([
      {
        approver: 'owner',
        who: 'owner',
        said: 'Yes, the legacy column is unused.',
        at: '2026-11-05T10:00:00.000Z',
        recordedAt: '2026-11-05T10:00:00.000Z',
        recordedBy: 'owner',
      },
    ]);
    expect((await cli(fx, p.ports, ['release', 'api'])).json.status).toBe('triggered');
  });

  it('a third party is asked through the lead, and the record says who, when and the words', async () => {
    const fx = makeFx({ partner: true });
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    const a = await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    expect(a.json).toMatchObject({ status: 'approvals', pending: ['partner'] });
    expect(a.json.needsLead[0].reason).toBe(
      'release approval: api-1 needs partner (the partner\'s maintainer, for the partner integration); Studio contacts no one: ask the owner to obtain it, then record it: studio release approve api-1 partner --by "<who said it>" --said "<their words, verbatim>" --at <when they said it>',
    );
    expect(
      (await cli(fx, p.ports, ['release', 'approve', 'api-1', 'partner', '--said', 'ok'])).err,
    ).toMatch(/needs --by "<who said it>"/);
    expect(
      (
        await cli(fx, p.ports, [
          'release',
          'approve',
          'api-1',
          'partner',
          '--by',
          'the maintainer',
          '--said',
          'ok',
          '--at',
          '2026-11-04T10:00:00Z',
        ])
      ).err,
    ).toMatch(/--at lies before api-1 was announced/);
    expect(
      (
        await cli(fx, p.ports, [
          'release',
          'approve',
          'api-1',
          'partner',
          '--by',
          'the maintainer',
          '--said',
          'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        ])
      ).err,
    ).toMatch(/looks like a credential; nothing recorded/);
    expect(
      (
        await cli(fx, p.ports, [
          'release',
          'approve',
          'api-1',
          'stranger',
          '--by',
          'x',
          '--said',
          'y',
        ])
      ).err,
    ).toMatch(/needs no approval from stranger/);
    p.advance(60_000);
    const ok = await cli(fx, p.ports, [
      'release',
      'approve',
      'api-1',
      'partner',
      '--by',
      'the maintainer, by mail',
      '--said',
      'Fine to ship the feed change.',
      '--at',
      '2026-11-05T10:00:30Z',
    ]);
    expect(ok.json).toMatchObject({ status: 'announced', pending: [] });
    expect(readReleases(fx.state)[0]?.approvals[0]).toEqual({
      approver: 'partner',
      who: 'the maintainer, by mail',
      said: 'Fine to ship the feed change.',
      at: '2026-11-05T10:00:30.000Z',
      recordedAt: '2026-11-05T10:01:00.000Z',
      recordedBy: 'lead',
    });
    // Studio itself sent nothing anywhere: the only GitHub calls are reads.
    expect(
      g.calls.filter(
        (c) => c.startsWith('workflow run') || c.startsWith('issue') || c.startsWith('pr comment'),
      ),
    ).toEqual([]);
  });

  it('cancels before the trigger only', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const c = await cli(fx, p.ports, ['release', 'cancel', 'api-1', '--reason', 'main moved on']);
    expect(c.json).toMatchObject({
      status: 'stopped',
      reason: 'stopped by the lead: main moved on',
    });
    // A new release drafts with the next id.
    const b = await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    expect(b.json.release).toBe('api-2');
    await cli(fx, p.ports, ['release', 'api']);
    const late = await cli(fx, p.ports, ['release', 'cancel', 'api-2', '--reason', 'oops']);
    expect(late.err).toMatch(/api-2 was triggered: Studio cannot stop a deploy; the way back:/);
  });

  it('lists and shows releases, and the state and board name them', async () => {
    const fx = makeFx({ migration: 'DROP TABLE a;\n' });
    const p = fakePorts(fakeGh(fx).gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const list = await cli(fx, p.ports, ['--json', 'release', 'list']);
    expect(list.json).toEqual([
      {
        id: 'api-1',
        component: 'api',
        status: 'approvals',
        sha: fx.head.slice(0, 7),
        at: '2026-11-05T10:00:00.000Z',
        pending: ['owner'],
      },
    ]);
    const show = await cli(fx, p.ports, ['release', 'show', 'api-1']);
    expect(show.out).toMatch(/^# Release api-1: API server \(api\)/);
    const board = await cli(fx, p.ports, ['board']);
    expect(board.out).toMatch(
      /RELEASE +STATUS +SHA +WAITS FOR\napi-1 +approvals +[0-9a-f]{7} +owner/,
    );
  });
});

describe('release: config', () => {
  const base = (release: string, extra = '') => studioYaml(release, extra);
  it('takes a named workflow only, never a command', () => {
    expect(() =>
      parseConfig(
        base(
          RELEASE_BLOCK.replace('      workflow:', '      command: ./deploy.sh\n      workflow:'),
        ),
        'x',
      ),
    ).toThrow(/a release runs only a named workflow file/);
    expect(() =>
      parseConfig(
        base(RELEASE_BLOCK.replace('.github/workflows/deploy.yml\n', 'deploy.yml\n')),
        'x',
      ),
    ).toThrow(/must be the workflow file/);
  });

  it('refuses a release workflow a crew may start', () => {
    expect(() =>
      parseConfig(base(RELEASE_BLOCK, 'crew_allowed_workflows: [deploy.yml]\n'), 'x'),
    ).toThrow(/deploy.yml is a release workflow of component api: a crew may never start it/);
    expect(() =>
      parseConfig(base(RELEASE_BLOCK, 'crew_allowed_workflows: [rollback.yml]\n'), 'x'),
    ).toThrow(/rollback.yml is a release workflow/);
  });

  it('needs post checks, unique approvers that are not the owner, and no subcommand as id', () => {
    expect(() =>
      parseConfig(
        base(RELEASE_BLOCK.replace(/ {6}post_checks:\n.*\n/, '      post_checks: []\n')),
        'x',
      ),
    ).toThrow(/post_checks/);
    expect(() => parseConfig(base(RELEASE_BLOCK.replace('id: partner', 'id: owner')), 'x')).toThrow(
      /owner is the owner approval itself/,
    );
    expect(() =>
      parseConfig(base(RELEASE_BLOCK).replace('  - id: api\n', '  - id: list\n'), 'x'),
    ).toThrow(/list is a word of studio release/);
  });
});

describe('release: the pane and the phone', () => {
  it('names release lines by their own codes, never as a plain decision', () => {
    expect(classifyDecision('release approval: api-1 needs partner (x)')).toBe('release_approval');
    expect(classifyDecision('release failed: api-1: smoke failed')).toBe('release_failed');
  });

  it('state.json lists the releases of the last days for the pane', async () => {
    const fx = makeFx({ migration: 'DROP TABLE a;\n' });
    const p = fakePorts(fakeGh(fx).gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const s = await cli(fx, p.ports, ['state']);
    expect(s.json.releases).toEqual([
      {
        id: 'api-1',
        component: 'api',
        status: 'approvals',
        sha: fx.head.slice(0, 7),
        at: '2026-11-05T10:00:00.000Z',
        pending: ['owner'],
      },
    ]);
  });
});

describe('release: a crew never starts a deploy', () => {
  it('refuses a release workflow whose display name crew_allowed_workflows lists', async () => {
    const fx = makeFx({ extra: 'crew_allowed_workflows: [deploy]\n' });
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.err).toMatch(
      /\.github\/workflows\/deploy\.yml is named deploy, which crew_allowed_workflows lists: a crew may never start a release workflow/,
    );
    expect(g.dispatches).toEqual([]);
  });
});

describe('release: the security review of 0.18.0', () => {
  it('refuses a crew_allowed_workflows entry that gh would resolve to a release workflow', async () => {
    // By id, by display name in another case, and the way back: each reaches a guarded workflow.
    for (const [entry, reached] of [
      ['11', '.github/workflows/deploy.yml'],
      ['DEPLOY', '.github/workflows/deploy.yml'],
      ['rollback api', '.github/workflows/rollback.yml'],
    ] as const) {
      const fx = makeFx({ extra: `crew_allowed_workflows: ["${entry}"]\n` });
      const g = fakeGh(fx);
      const p = fakePorts(g.gh);
      await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
      const r = await cli(fx, p.ports, ['release', 'api']);
      expect(r.err, entry).toContain(
        `crew_allowed_workflows entry ${entry} reaches ${reached}: a crew may never start a release workflow`,
      );
      expect(g.dispatches).toEqual([]);
    }
    // An entry that reaches only another workflow is fine.
    const fx = makeFx({ extra: 'crew_allowed_workflows: [ci]\n' });
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    expect((await cli(fx, p.ports, ['release', 'api'])).json.status).toBe('triggered');
  });

  it('checks the rollback workflow’s display name against crew_allowed_workflows too', async () => {
    const fx = makeFx({ extra: 'crew_allowed_workflows: [rollback]\n' });
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.err).toMatch(
      /\.github\/workflows\/rollback\.yml is named rollback, which crew_allowed_workflows lists/,
    );
  });

  it('pins the workflow blobs in the announced record and refuses another at the trigger', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const file = join(fx.state, RELEASES_FILE);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(data.releases[0].workflowBlobs).sort()).toEqual([
      '.github/workflows/deploy.yml',
      '.github/workflows/rollback.yml',
    ]);
    data.releases[0].workflowBlobs['.github/workflows/deploy.yml'] = 'f'.repeat(40);
    writeFileSync(file, JSON.stringify(data));
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.err).toMatch(/deploy\.yml changed since api-1 was announced/);
    expect(g.dispatches).toEqual([]);
  });

  it('reads capacity before anything else, so a busy CI holds without reading the workflows', async () => {
    const fx = makeFx();
    const g = fakeGh(fx, { busy: 3 });
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const before = g.calls.length;
    expect((await cli(fx, p.ports, ['release', 'api'])).json.held).toMatch(/^held: ci capacity/);
    expect(g.calls.slice(before).filter((c) => c.startsWith('workflow list'))).toEqual([]);
  });

  it('refuses when main moves between the checks and the dispatch', async () => {
    const fx = makeFx();
    // The draft reads main once; the trigger reads it twice: checked, then right before dispatch.
    const g = fakeGh(fx, { head: (n) => (n >= 3 ? 'c'.repeat(40) : fx.head) });
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.json).toMatchObject({ status: 'announced' });
    expect(r.json.held).toBe('main moved while api-1 was checked; run studio release api again');
    expect(g.dispatches).toEqual([]);
  });

  it('a run of another head than the checked one fails closed and is not counted as deployed', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    g.runs[900] = {
      ...run('completed', 'success', [['smoke', 'completed', 'success']]),
      headSha: 'd'.repeat(40),
    };
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.json.status).toBe('failed');
    expect(r.json.reason).toMatch(/ran at ddddddd, not at the checked head/);
    expect(existsSync(join(fx.state, 'metrics.jsonl'))).toBe(false);
  });

  it('an ambiguous dispatch exit (a timeout) stays triggered and is looked up, never repeated', async () => {
    const fx = makeFx();
    const g = fakeGh(fx, { dispatch: { code: 1, stderr: 'context deadline exceeded' } });
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const t = await cli(fx, p.ports, ['release', 'api']);
    expect(t.json.status).toBe('triggered');
    g.runs.list = [{ databaseId: 900, createdAt: '2026-11-05T10:00:31Z' }];
    g.runs[900] = run('completed', 'success', [['smoke', 'completed', 'success']]);
    expect((await cli(fx, p.ports, ['release', 'api'])).json.status).toBe('done');
    expect(g.dispatches).toHaveLength(1);
  });

  it('several candidate runs fail closed once the timeout passed, so the release can end', async () => {
    const fx = makeFx();
    const g = fakeGh(fx, { dispatch: { stdout: '' } });
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    g.runs.list = [
      { databaseId: 900, createdAt: '2026-11-05T10:00:31Z' },
      { databaseId: 905, createdAt: '2026-11-05T10:00:40Z' },
    ];
    p.advance(61 * 60_000);
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.json.status).toBe('failed');
    expect(r.json.reason).toMatch(/several runs of .* check them on GitHub/);
  });

  it('starts a post check in another workflow only under the capacity rule and with the pinned file', async () => {
    const release = RELEASE_BLOCK.replace(
      '        - { workflow: .github/workflows/deploy.yml, job: smoke }',
      '        - { workflow: .github/workflows/smoke.yml, job: prod }',
    );
    const fx = makeFx({ release });
    writeFileSync(join(fx.project, '.github/workflows/smoke.yml'), DEPLOY);
    git(fx.project, 'add', '.github/workflows/smoke.yml');
    git(fx.project, 'commit', '-q', '-m', 'smoke');
    fx.head = git(fx.project, 'rev-parse', 'HEAD');
    git(fx.project, 'push', '-q', 'origin', 'main');
    const opts = { busy: 0 };
    const g = fakeGh(fx, opts);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    g.runs[900] = run('completed', 'success', [['deploy', 'completed', 'success']]);
    // The release run is of the head the trigger checked, whatever main does afterwards.
    g.runs[900] = { ...(g.runs[900] as object), headSha: fx.head };
    opts.busy = 3;
    const busy = await cli(fx, p.ports, ['release', 'api']);
    expect(busy.json.status).toBe('checking');
    expect(busy.json.waiting).toMatch(/waiting for .*smoke\.yml \/ prod \(held: ci capacity/);
    expect(g.dispatches).toHaveLength(1);
    // The file changed on main meanwhile: the check is never started with it.
    opts.busy = 0;
    writeFileSync(join(fx.project, '.github/workflows/smoke.yml'), `${DEPLOY}# changed\n`);
    git(fx.project, 'add', '.github/workflows/smoke.yml');
    git(fx.project, 'commit', '-q', '-m', 'change smoke');
    fx.head = git(fx.project, 'rev-parse', 'HEAD');
    git(fx.project, 'push', '-q', 'origin', 'main');
    const changed = await cli(fx, p.ports, ['release', 'api']);
    expect(changed.json.status).toBe('failed');
    expect(changed.json.reason).toMatch(/smoke\.yml changed on main since api-1 was announced/);
    expect(g.dispatches).toHaveLength(1);
  });

  it('asks a third party whose paths lie outside the component', async () => {
    const release = RELEASE_BLOCK.replace(
      'paths: ["server/partner/**"]',
      'paths: ["shared/feed/**"]',
    );
    const fx = makeFx({ release });
    mkdirSync(join(fx.project, 'shared/feed'), { recursive: true });
    writeFileSync(join(fx.project, 'shared/feed/x.ts'), 'export const x = 1;\n');
    git(fx.project, 'add', 'shared/feed/x.ts');
    git(fx.project, 'commit', '-q', '-m', 'feed');
    fx.head = git(fx.project, 'rev-parse', 'HEAD');
    git(fx.project, 'push', '-q', 'origin', 'main');
    const p = fakePorts(fakeGh(fx).gh);
    const a = await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    expect(a.json).toMatchObject({ status: 'approvals', pending: ['partner'] });
  });

  it('counts every changed SQL file of the component as a migration, also outside migrations', async () => {
    const fx = makeFx();
    mkdirSync(join(fx.project, 'server/db'), { recursive: true });
    writeFileSync(join(fx.project, 'server/db/schema.sql'), 'DROP TABLE customers;\n');
    git(fx.project, 'add', 'server/db/schema.sql');
    git(fx.project, 'commit', '-q', '-m', 'schema');
    fx.head = git(fx.project, 'rev-parse', 'HEAD');
    git(fx.project, 'push', '-q', 'origin', 'main');
    const p = fakePorts(fakeGh(fx).gh);
    const a = await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    expect(a.json).toMatchObject({ status: 'approvals', pending: ['owner'] });
    expect(a.json.note).toContain('- server/db/schema.sql (added): destructive, needs the owner');
  });
});

describe('release: what the release workflows run is pinned too', () => {
  const commit = (fx: Fx, path: string, text: string) => {
    mkdirSync(dirname(join(fx.project, path)), { recursive: true });
    writeFileSync(join(fx.project, path), text);
    git(fx.project, 'add', path);
    git(fx.project, 'commit', '-q', '-m', `change ${path}`);
    fx.head = git(fx.project, 'rev-parse', 'HEAD');
    git(fx.project, 'push', '-q', 'origin', 'main');
  };

  it('refuses the trigger when .github changed since the announcement, any workflow or action', async () => {
    for (const path of ['.github/workflows/other.yml', '.github/actions/setup/action.yml']) {
      const fx = makeFx();
      const g = fakeGh(fx);
      const p = fakePorts(g.gh);
      await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
      expect(readReleases(fx.state)[0]?.guardPin).toMatch(/^github:[0-9a-f]{40} guarded:sha256:/);
      commit(fx, path, 'name: other\n');
      const r = await cli(fx, p.ports, ['release', 'api']);
      expect(r.err, path).toMatch(/\.github or a guarded path changed since api-1 was announced/);
      expect(g.dispatches).toEqual([]);
    }
  });

  it('pins the guarded paths a component names, and only those outside .github', async () => {
    const release = RELEASE_BLOCK.replace(
      '      approvers:',
      '      guarded_paths: ["scripts/deploy/**"]\n      approvers:',
    );
    const fx = makeFx({ release });
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    // A file no guard names changes nothing.
    commit(fx, 'docs/guide.md', '# Guide\n');
    // The deploy script the workflow calls does.
    commit(fx, 'scripts/deploy/run.sh', 'echo elsewhere\n');
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.err).toMatch(/\.github or a guarded path changed since api-1 was announced/);
    expect(g.dispatches).toEqual([]);
    // Without the script change it triggers.
    const fx2 = makeFx({ release });
    const g2 = fakeGh(fx2);
    const p2 = fakePorts(g2.gh);
    await cli(fx2, p2.ports, ['release', 'api', '--since', 'v1']);
    commit(fx2, 'docs/guide.md', '# Guide\n');
    expect((await cli(fx2, p2.ports, ['release', 'api'])).json.status).toBe('triggered');
  });

  it('refuses the trigger when the rollback workflow is no longer the pinned one', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    const file = join(fx.state, RELEASES_FILE);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.releases[0].workflowBlobs['.github/workflows/rollback.yml'] = 'e'.repeat(40);
    writeFileSync(file, JSON.stringify(data));
    const r = await cli(fx, p.ports, ['release', 'api']);
    expect(r.err).toMatch(/rollback\.yml changed since api-1 was announced/);
    expect(g.dispatches).toEqual([]);
  });

  it('checks the rollback pin again before it shows the way back', async () => {
    const fx = makeFx();
    const g = fakeGh(fx);
    const p = fakePorts(g.gh);
    await cli(fx, p.ports, ['release', 'api', '--since', 'v1']);
    await cli(fx, p.ports, ['release', 'api']);
    g.runs[900] = {
      ...run('completed', 'failure', [['deploy', 'completed', 'failure']]),
      headSha: fx.head,
    };
    const before = await cli(fx, p.ports, ['release', 'api']);
    expect(before.json.needsLead[0].reason).toMatch(
      /the way back: run \.github\/workflows\/rollback\.yml by hand/,
    );
    // Someone changes the rollback workflow on main after the release failed.
    commit(
      fx,
      '.github/workflows/rollback.yml',
      'name: rollback\non: workflow_dispatch\njobs: {}\n',
    );
    const tick = await cli(fx, p.ports, ['tick']);
    const line = tick.json.needsLead.find((l: { item: string }) => l.item === 'api-1');
    expect(line.reason).toMatch(
      /the way back: \.github\/workflows\/rollback\.yml changed on main since api-1 was announced: read it before running anything, Studio offers it no longer$/,
    );
    expect(line.reason).not.toMatch(/run \.github\/workflows\/rollback\.yml by hand/);
    const show = await cli(fx, p.ports, ['release', 'show', 'api-1']);
    expect(show.out).toMatch(
      /warning: \.github\/workflows\/rollback\.yml changed on main since api-1/,
    );
  });
});
