// A lead machine and worker machines that share nothing but (a fake of) GitHub: the lead offers an
// item, a worker claims it atomically, runs its crew with its deny list, opens the pull request
// with its own identity and hands the report back on the claim; the lead collects it as it would a
// local crew's. Takeover after a lease, withdrawal and the trust checks run against the same fake.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
import { loadBoard } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { stateRootFor } from '../src/paths.js';
import { pinnedPlugins } from '../src/plugins.js';
import type { Claude, Gh, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import { reportName } from '../src/report.js';
import { parseClaim } from '../src/worker-claim.js';
import type { WorkerPlatform } from '../src/worker-deny.js';
import { fakeGitHub } from './worker-fake.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-workers-')));
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

const LINUX: WorkerPlatform = { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' };
const OWN = {
  headRepository: { name: 'app' },
  headRepositoryOwner: { login: 'org' },
  isCrossRepository: false,
};

const studioYaml = (denied: string) => `studio: 1
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
roles:
  builder: { model: sonnet, wip: 1 }
  reviewer: { model: opus, wip: 1 }
owner_only: []
deploy_commands: []
workers:
  windows:
    deny: { paths: ["${denied}"], ports: [5432] }
`;

const ITEM = `  - id: APP-1
    title: Read the device log
    type: fix
    role: builder
    repo: org/app
    size: S
    priority: 1
    status: ready
    paths: []
    touches: [tools/**]
    runs_on: windows
    depends_on: []
    dod: [a test covers it]
    history: []`;

/** A local item that the plan would hold back by role wip if the worker item counted. */
const LOCAL = `  - id: APP-9
    title: Local work
    type: fix
    role: builder
    repo: org/app
    size: S
    priority: 2
    status: ready
    paths: []
    touches: [web/**]
    depends_on: []
    dod: [a test covers it]
    history: []`;

let n = 0;
const WORKER_TOKEN = ['wtok', 'en', '-for-the-worker-0001'].join('');
const ownerDir = (home: string) => join(home, '.config', 'studio');

function writeOwnerConfig(home: string, yaml: string): void {
  mkdirSync(ownerDir(home), { recursive: true });
  writeFileSync(join(ownerDir(home), 'config.yaml'), yaml);
}

interface Machine {
  project: string;
  home: string;
  env: Record<string, string | undefined>;
  state: string;
}

interface World {
  base: string;
  origin: string;
  lead: Machine;
  denied: string;
  now: { t: number };
  github: ReturnType<typeof fakeGitHub>;
}

function world(items: string[] = [ITEM]): World {
  const base = join(root, `w${n++}`);
  mkdirSync(base);
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = join(base, 'lead');
  git(base, 'clone', '-q', origin, project);
  git(project, 'checkout', '-q', '-b', 'main');
  const denied = join(base, 'backups');
  mkdirSync(denied);
  mkdirSync(join(project, '.studio'));
  writeFileSync(join(project, '.studio', 'studio.yaml'), studioYaml(denied));
  writeFileSync(join(project, '.studio', 'board.yaml'), `items:\n${items.join('\n')}\n`);
  writeFileSync(join(project, 'README.md'), 'x\n');
  git(project, 'add', 'README.md', '.studio/studio.yaml', '.studio/board.yaml');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  const home = join(base, 'lead-home');
  mkdirSync(home);
  writeOwnerConfig(home, 'workers:\n  accept:\n    windows: [win-bot, win-bot2]\n');
  const env = { PATH: process.env.PATH };
  const now = { t: Date.parse('2026-10-31T10:00:00Z') };
  return {
    base,
    origin,
    denied,
    now,
    lead: { project, home, env, state: stateRootFor(project, { env, homedir: home }) },
    github: fakeGitHub(() => new Date(now.t)),
  };
}

/** A worker machine: its own clone, home, owner config, crew token and pinned plugins. */
function workerMachine(w: World, name: string): Machine {
  const project = join(w.base, name);
  git(w.base, 'clone', '-q', w.origin, project);
  const home = join(w.base, `${name}-home`);
  mkdirSync(home);
  writeOwnerConfig(home, 'workers:\n  self:\n    lead: lead-user\n');
  const token = join(ownerDir(home), 'crew-token');
  writeFileSync(token, `${WORKER_TOKEN}-${name}\n`);
  chmodSync(token, 0o600);
  const claude = join(home, '.claude');
  for (const s of ['studio-crew', 'test-driven-development', 'systematic-debugging']) {
    mkdirSync(join(claude, 'skills', s), { recursive: true });
    writeFileSync(join(claude, 'skills', s, 'SKILL.md'), '---\nname: x\n---\n');
  }
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  writeFileSync(
    join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      plugins: Object.fromEntries(
        pinnedPlugins(undefined, []).map((p) => [p.name, [{ scope: 'user', version: p.version }]]),
      ),
    }),
  );
  const env = { PATH: process.env.PATH };
  return { project, home, env, state: stateRootFor(project, { env, homedir: home }) };
}

function fakeGh(handler: (line: string) => { code?: number; stdout?: string } | undefined) {
  const calls: string[] = [];
  const gh: Gh = {
    async api(path) {
      calls.push(`api ${path}`);
      return '0';
    },
    async run(args) {
      const line = args.join(' ');
      calls.push(line);
      const r =
        handler(line) ??
        (line.startsWith('pr checks')
          ? { stdout: JSON.stringify([{ name: 'ci', bucket: 'pass' }]) }
          : line.endsWith('--json baseRefName')
            ? { stdout: JSON.stringify({ baseRefName: 'main' }) }
            : undefined);
      if (!r) return { code: 1, stdout: '', stderr: `unscripted gh call: ${line}` };
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: '' };
    },
  };
  return { gh, calls };
}

interface Crew {
  started: { cwd: string; args: string[]; env: Record<string, string> }[];
  stopped: number[];
  running: boolean;
}

function machinePorts(w: World, login: string, gh: Gh, crew: Crew): Ports {
  const claude: Claude = {
    async start(cwd, args, _prompt, _log, env) {
      crew.started.push({ cwd, args, env });
      crew.running = true;
      return { pid: 4242 };
    },
    alive: () => crew.running,
    identity: async () => 'start-4242',
    async stop(pid) {
      crew.stopped.push(pid);
      crew.running = false;
    },
  };
  return {
    gh,
    git: realPorts().git,
    credentials: realPorts().credentials,
    claude,
    clock: {
      now: () => new Date(w.now.t),
      sleep: async (ms) => {
        w.now.t += ms;
      },
    },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
    hub: (token?: string) => w.github.hubAs(token === undefined ? 'lead-user' : login),
  };
}

const newCrew = (): Crew => ({ started: [], stopped: [], running: false });

async function run(m: Machine, ports: Ports, argv: string[], platform = LINUX) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', m.project, ...argv], {
    ports,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: m.env,
    homedir: m.home,
    cwd: m.project,
    workerPlatform: platform,
  });
  return { code, out, err };
}

const HEAD = 'c'.repeat(40);

/** The lead's gh: the pull request the worker opened, as `gh pr view` shows it. */
const leadGh = (head = HEAD) =>
  fakeGh((l) =>
    /^pr view 7 --repo org\/app --json headRefOid,headRefName/.test(l)
      ? { stdout: JSON.stringify({ headRefOid: head, headRefName: 'studio/APP-1', ...OWN }) }
      : undefined,
  );

/** A worker's gh: no open pull request of the branch yet; `pr create` opens #7 as `author`. */
const workerGh = (w: World, author: string) =>
  fakeGh((l) => {
    if (l.startsWith('pr list --repo org/app --head studio/APP-1')) return { stdout: '[]' };
    if (l.startsWith('pr create --repo org/app --head studio/APP-1')) {
      w.github.prs.set(7, {
        number: 7,
        author,
        branch: 'studio/APP-1',
        head: HEAD,
        base: 'main',
        crossRepository: false,
        state: 'OPEN',
      });
      return { stdout: 'https://github.com/org/app/pull/7\n' };
    }
    return undefined;
  });

/** What the crew leaves: a report under the name only its brief knows, a log, a pushed branch. */
function crewFinishes(w: World, m: Machine, crew: Crew, report = defaultReport()): void {
  const name = reportName(m.state, 'APP-1');
  if (name === undefined) throw new Error('no report name');
  const dir = join(m.state, 'clones', 'APP-1', '.studio', 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), report);
  writeFileSync(
    join(m.state, 'logs', 'APP-1.jsonl'),
    `${[
      { type: 'system', subtype: 'init', session_id: 's1' },
      {
        type: 'result',
        total_cost_usd: 0.42,
        modelUsage: { sonnet: { inputTokens: 100, outputTokens: 20, costUSD: 0.42 } },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n')}\n`,
  );
  w.github.branches.set('studio/APP-1', HEAD);
  crew.running = false;
}

const defaultReport = () =>
  `---\nstatus: done\nitem: APP-1\npr_title: "APP-1: parse the device log"\nhead_sha: ${HEAD}\ntests_run: 3\nnot_run_here: []\nlessons: ["keep the log reader small"]\nquestions: []\n---\n\nParsed the log; a test covers it.\n`;

const lastLine = (out: string) => JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
const claimOf = (w: World) => {
  const sha = w.github.refs.get('APP-1');
  const c = sha === undefined ? undefined : w.github.commits.get(sha);
  return c === undefined ? undefined : parseClaim(c.message);
};
const statusOf = (w: World, id = 'APP-1') =>
  loadBoard(w.lead.project).items.find((i) => i.id === id);

describe('workers on other machines', () => {
  it('offer, claim, crew, pull request, report: the lead collects it like a local crew', async () => {
    const w = world([ITEM, LOCAL]);
    const leadCrew = newCrew();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, leadCrew);

    // The lead offers the item; it takes no local wip, so the local item launches too.
    const t1 = await run(w.lead, lead, ['tick']);
    const tick1 = JSON.parse(t1.out);
    expect(tick1.offered).toEqual([{ item: 'APP-1', label: 'windows', offer: 30 }]);
    expect(tick1.launched.map((l: { item: string }) => l.item)).toEqual(['APP-9']);
    expect(statusOf(w)).toMatchObject({ status: 'assigned', crew: 'worker:windows' });
    const issue = w.github.issues.get(30);
    expect(issue).toMatchObject({ title: 'Studio offer APP-1 for windows', author: 'lead-user' });
    expect(issue?.body).not.toContain(w.lead.home);
    expect(leadCrew.started).toHaveLength(1);

    // A worker claims it and starts its crew with the deny list in sandbox and guard.
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    const s1 = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(s1.code).toBe(0);
    expect(lastLine(s1.out)).toMatchObject({ kind: 'claimed', item: 'APP-1' });
    expect(claimOf(w)).toMatchObject({
      state: 'claimed',
      worker: 'win-bot',
      offer: 30,
      attempt: 1,
    });
    expect(crew.started).toHaveLength(1);
    expect(crew.started[0]?.env.GH_TOKEN).toBe(`${WORKER_TOKEN}-win`);
    const settings = JSON.parse(readFileSync(join(wm.state, 'settings', 'APP-1.json'), 'utf8'));
    expect(settings.sandbox.filesystem.denyWrite).toEqual([w.denied]);
    expect(settings.sandbox.filesystem.denyRead).toContain(w.denied);
    const ctx = JSON.parse(readFileSync(join(wm.state, 'guard', 'APP-1.json'), 'utf8'));
    expect(ctx.deniedPorts).toEqual([5432]);
    expect(ctx.secretGlobs).toContain(`${w.denied}/**`);
    const brief = readFileSync(join(wm.state, 'briefs', 'APP-1.md'), 'utf8');
    expect(brief).toContain('pr_title:');
    expect(brief).toContain('Read the device log');

    // The lead sees the claim: building, on that worker.
    const tick2 = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(statusOf(w)?.status).toBe('in_progress');
    expect(tick2.held).toContainEqual({
      item: 'APP-1',
      reason: 'worker: on win-bot (windows), heartbeat 0 min ago',
    });
    const state = JSON.parse((await run(w.lead, lead, ['state'])).out);
    expect(state.items.find((i: { id: string }) => i.id === 'APP-1').wait).toEqual({
      code: 'worker',
      text: 'on win-bot (windows), heartbeat 0 min ago',
    });
    const status = JSON.parse((await run(w.lead, lead, ['--json', 'status'])).out);
    expect(status.find((r: { item: string }) => r.item === 'APP-1')).toMatchObject({
      name: 'worker:windows',
      pid: 0,
      alive: true,
      worker: { label: 'windows', login: 'win-bot', claim: 'claimed', attempt: 1 },
    });

    // While the crew works, the worker beats its claim.
    w.now.t += 11 * 60_000;
    expect(
      lastLine((await run(wm, wp, ['worker', '--label', 'windows', '--once'])).out),
    ).toMatchObject({ kind: 'working', line: 'APP-1: the crew is working; heartbeat sent' });
    expect(claimOf(w)?.state).toBe('alive');

    // The crew ends: the worker opens the pull request as itself and hands the report back.
    crewFinishes(w, wm, crew);
    const s3 = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s3.out)).toMatchObject({
      kind: 'done',
      line: 'APP-1: report done handed back with pull request #7',
    });
    const done = claimOf(w);
    expect(done).toMatchObject({ state: 'done', pr: 7, headSha: HEAD });
    expect(done?.usage).toMatchObject({ runs: 1, costUsd: 0.42 });
    expect(existsSync(join(wm.state, 'worker.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(wm.state, 'worker.json'), 'utf8')).current).toBeUndefined();

    // The lead collects: in review, a review item, cost on the item and in the day's ledger.
    const tick3 = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick3.collected).toEqual([
      expect.objectContaining({ item: 'APP-1', status: 'in_review', pr: 7, review: 'APP-10' }),
    ]);
    expect(statusOf(w)).toMatchObject({ status: 'in_review', pr: 7, branch: 'studio/APP-1' });
    expect(statusOf(w)?.usage).toMatchObject({ runs: 1, costUsd: 0.42 });
    expect(statusOf(w, 'APP-10')).toMatchObject({ status: 'ready', notes: ['review org/app#7'] });
    expect(statusOf(w, 'APP-10')?.runsOn).toBeUndefined();
    const ledger = JSON.parse(readFileSync(join(w.lead.state, 'costs.json'), 'utf8'));
    expect(Object.values(ledger.runs)).toContainEqual(
      expect.objectContaining({ item: 'APP-1', costUsd: 0.42 }),
    );
    const lessons = JSON.parse(readFileSync(join(w.lead.state, 'lessons.json'), 'utf8'));
    expect(lessons.lessons[0]).toMatchObject({
      text: 'keep the log reader small',
      evidence: {
        report: expect.stringMatching(/^refs\/studio\/claims\/APP-1@[0-9a-f]+$/),
        pr: 'org/app#7',
      },
    });
    // Its offer is closed and its claim is gone; a second tick counts nothing twice.
    expect(w.github.issues.get(30)?.open).toBe(false);
    expect(w.github.refs.has('APP-1')).toBe(false);
    await run(w.lead, lead, ['tick']);
    const again = JSON.parse(readFileSync(join(w.lead.state, 'costs.json'), 'utf8'));
    expect(Object.keys(again.runs)).toEqual(Object.keys(ledger.runs));
    expect(statusOf(w)?.usage?.costUsd).toBe(0.42);
  });

  it('two workers: one claim wins; after the lease the other takes it over from the pushed branch', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const a = workerMachine(w, 'win');
    const crewA = newCrew();
    const pa = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crewA);
    const b = workerMachine(w, 'win2');
    const crewB = newCrew();
    const pb = machinePorts(w, 'win-bot2', workerGh(w, 'win-bot2').gh, crewB);
    expect(lastLine((await run(a, pa, ['worker', '--label', 'windows', '--once'])).out).kind).toBe(
      'claimed',
    );
    expect(lastLine((await run(b, pb, ['worker', '--label', 'windows', '--once'])).out)).toEqual(
      expect.objectContaining({ kind: 'idle' }),
    );
    expect(crewB.started).toHaveLength(0);

    // Worker A pushed some work, then its machine went away: no heartbeat for longer than the lease.
    git(w.lead.project, 'checkout', '-q', '-b', 'studio/APP-1');
    writeFileSync(join(w.lead.project, 'part.txt'), 'part\n');
    git(w.lead.project, 'add', 'part.txt');
    git(w.lead.project, 'commit', '-q', '-m', 'part');
    git(w.lead.project, 'push', '-q', 'origin', 'studio/APP-1');
    const pushed = git(w.lead.project, 'rev-parse', 'HEAD');
    git(w.lead.project, 'checkout', '-q', 'main');
    w.github.branches.set('studio/APP-1', pushed);
    w.now.t += 33 * 60_000;
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.held).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/^worker: claim of win-bot expired .*may take it over$/),
    });
    const s = await run(b, pb, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({
      kind: 'claimed',
      line: 'APP-1: claimed (attempt 2) and its crew started from studio/APP-1',
    });
    expect(claimOf(w)).toMatchObject({ worker: 'win-bot2', attempt: 2, state: 'claimed' });
    expect(git(join(b.state, 'clones', 'APP-1'), 'rev-parse', 'HEAD')).toBe(pushed);

    // Worker A comes back: the claim is no longer its own, so it stops its crew and lets go.
    const back = await run(a, pa, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(back.out)).toMatchObject({ kind: 'lost', item: 'APP-1' });
    expect(crewA.stopped).toEqual([4242]);
    expect(claimOf(w)?.worker).toBe('win-bot2');

    // A second expiry is the lead's decision: no third attempt.
    w.now.t += 33 * 60_000;
    const tick2 = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick2.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/expired .*after 2 attempts/),
    });
  });

  it('the lead withdraws an offer: the worker stops its crew; the item is offered once more', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    const stop = await run(w.lead, lead, ['stop', 'APP-1']);
    expect(stop.code).toBe(1);
    expect(stop.err).toMatch(/runs on a worker: studio stop APP-1 --requeue withdraws the offer/);
    const r = await run(w.lead, lead, ['stop', 'APP-1', '--requeue']);
    expect(JSON.parse(r.out)).toEqual({ item: 'APP-1', withdrawn: true, status: 'ready' });
    expect(w.github.issues.get(30)?.open).toBe(false);
    expect(
      lastLine((await run(wm, wp, ['worker', '--label', 'windows', '--once'])).out),
    ).toMatchObject({
      kind: 'lost',
    });
    expect(crew.stopped).toEqual([4242]);
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.offered).toEqual([{ item: 'APP-1', label: 'windows', offer: 31 }]);
  });

  it('a pull request the claiming worker did not open counts for nothing', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    // The pull request shows another author than the claim names.
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'someone-else').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    crewFinishes(w, wm, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(
        /PR 7 was opened by someone-else, not by win-bot, who claimed APP-1/,
      ),
    });
    expect(statusOf(w)?.status).toBe('assigned');
    expect(statusOf(w)?.pr).toBeUndefined();
  });

  it('a claim of a worker the owner did not accept counts for nothing', async () => {
    const w = world();
    writeOwnerConfig(w.lead.home, 'workers:\n  accept:\n    windows: [win-bot2]\n');
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    await run(wm, machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew()), [
      'worker',
      '--label',
      'windows',
      '--once',
    ]);
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(
        /claimed by win-bot, who is not accepted for the label windows/,
      ),
    });
  });

  it('without an accepted worker for the label nothing is offered', async () => {
    const w = world();
    writeOwnerConfig(w.lead.home, '');
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.offered).toBeUndefined();
    expect(tick.held).toContainEqual({
      item: 'APP-1',
      reason:
        'worker: no worker is accepted for the label windows (workers.accept in the owner config)',
    });
    expect(statusOf(w)?.status).toBe('ready');
  });

  it('a worker skips offers someone else opened or edited, and never launches locally', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const issue = w.github.issues.get(30);
    if (issue === undefined) throw new Error('no offer');
    issue.edited = true;
    issue.editor = 'someone-else';
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({ kind: 'idle' });
    expect(s.err).toMatch(/skipped offer #30: edited by someone other than the lead/);
    issue.editor = 'lead-user';
    issue.author = 'someone-else';
    expect(lastLine((await run(wm, wp, ['worker', '--label', 'windows', '--once'])).out).kind).toBe(
      'idle',
    );
    expect(w.github.refs.has('APP-1')).toBe(false);
  });

  it('a worker fails closed where it cannot enforce its rules', async () => {
    const w = world();
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    const native = await run(wm, wp, ['worker', '--label', 'windows'], {
      platform: 'win32',
      wsl: 'none',
      automountRoot: '/mnt/',
    });
    expect(native.code).toBe(1);
    expect(lastLine(native.out)).toMatchObject({
      kind: 'refused',
      line: expect.stringMatching(/native Windows has no sandbox/),
    });
    const interop = await run(wm, wp, ['worker', '--label', 'windows'], {
      platform: 'linux',
      wsl: 'wsl2',
      interop: true,
      automountRoot: '/mnt/',
    });
    expect(lastLine(interop.out).line).toMatch(/WSL interop is on/);
    // The lead's own identity is no worker.
    const asLead = machinePorts(w, 'lead-user', workerGh(w, 'lead-user').gh, newCrew());
    expect(lastLine((await run(wm, asLead, ['worker', '--label', 'windows'])).out).line).toMatch(
      /the lead's own identity/,
    );
    // A pinned plugin at another version refuses before any claim.
    writeFileSync(
      join(wm.home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: { 'studio@studio-marketplace': [{ scope: 'user', version: '0.0.1' }] },
      }),
    );
    expect(lastLine((await run(wm, wp, ['worker', '--label', 'windows'])).out).line).toMatch(
      /plugin .* pinned/,
    );
    expect(w.github.refs.size).toBe(0);
  });

  it('a report that looks like it holds a credential stays on the worker', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    crewFinishes(
      w,
      wm,
      crew,
      defaultReport().replace('a test covers it', `token ${WORKER_TOKEN}-win`),
    );
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({ kind: 'released' });
    const c = claimOf(w);
    expect(c).toMatchObject({ state: 'released', reason: expect.stringMatching(/credential/) });
    const sha = w.github.refs.get('APP-1') as string;
    expect(w.github.commits.get(sha)?.files['report.md']).toBeUndefined();
    expect(w.github.prs.size).toBe(0);
    // The lead blocks the item with the worker's reason and counts the run's cost.
    await run(w.lead, lead, ['tick']);
    expect(statusOf(w)).toMatchObject({ status: 'blocked' });
    expect(statusOf(w)?.notes?.at(-1)).toMatch(/^worker win-bot released it: .*credential/);
    expect(statusOf(w)?.usage?.costUsd).toBe(0.42);
  });

  it('a local launch never takes an item that runs on a worker', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    const r = await run(w.lead, lead, ['launch', 'APP-1']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/runs on a worker with the label windows: tick offers it there/);
    const plan = JSON.parse((await run(w.lead, lead, ['plan'])).out);
    expect(plan.offer.map((i: { id: string }) => i.id)).toEqual(['APP-1']);
    expect(plan.assign).toEqual([]);
  });

  it('a crew that ends without a report: released with a fixed reason, blocked for the lead', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    crew.running = false;
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({ kind: 'released' });
    expect(claimOf(w)).toMatchObject({
      state: 'released',
      reason: 'report: report file is missing or not a safe regular file',
    });
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(statusOf(w)?.status).toBe('blocked');
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/^blocked: worker win-bot released it: report:/),
    });
    expect(w.github.issues.get(30)?.open).toBe(false);
  });

  it('a worker cut short between the crew start and its own record finds the crew again', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    // As if the process died before it saved `launched`.
    const file = join(wm.state, 'worker.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.current.launched = false;
    writeFileSync(file, JSON.stringify(saved));
    crewFinishes(w, wm, crew);
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({ kind: 'done' });
    expect(crew.started).toHaveLength(1);
  });

  it('a fix round by another accepted worker goes on in the pull request the first one opened', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const a = workerMachine(w, 'win');
    const crewA = newCrew();
    const pa = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crewA);
    await run(a, pa, ['worker', '--label', 'windows', '--once']);
    crewFinishes(w, a, crewA);
    await run(a, pa, ['worker', '--label', 'windows', '--once']);
    await run(w.lead, lead, ['tick']);
    expect(statusOf(w)).toMatchObject({ status: 'in_review', pr: 7 });
    // The review asked for changes: the lead sends the item back for its fix round.
    const board = readFileSync(join(w.lead.project, '.studio', 'board.yaml'), 'utf8');
    writeFileSync(
      join(w.lead.project, '.studio', 'board.yaml'),
      board.replace(/(id: APP-1\n(?:.*\n)*?\s+status: )in_review/, '$1ready'),
    );
    const t = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(t.offered).toEqual([{ item: 'APP-1', label: 'windows', offer: 31 }]);
    // Another worker takes it from the pushed branch; the open pull request of it is reused.
    git(w.lead.project, 'push', '-q', 'origin', 'main:refs/heads/studio/APP-1');
    const b = workerMachine(w, 'win2');
    const crewB = newCrew();
    const gb = fakeGh((l) => {
      if (l.startsWith('pr list --repo org/app --head studio/APP-1')) {
        return { stdout: JSON.stringify([{ number: 7 }]) };
      }
      if (l.startsWith('pr edit 7 --repo org/app')) return {};
      return undefined;
    });
    const pb = machinePorts(w, 'win-bot2', gb.gh, crewB);
    expect(
      lastLine((await run(b, pb, ['worker', '--label', 'windows', '--once'])).out),
    ).toMatchObject({
      kind: 'claimed',
      line: 'APP-1: claimed (attempt 1) and its crew started from studio/APP-1',
    });
    crewFinishes(w, b, crewB);
    expect(
      lastLine((await run(b, pb, ['worker', '--label', 'windows', '--once'])).out),
    ).toMatchObject({ kind: 'done', line: 'APP-1: report done handed back with pull request #7' });
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.collected).toEqual([
      expect.objectContaining({ item: 'APP-1', status: 'in_review', pr: 7 }),
    ]);
  });
});
