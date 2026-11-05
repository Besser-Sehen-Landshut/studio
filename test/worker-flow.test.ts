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
import { acquireStateLock, ownerStateRootFor, stateRootFor } from '../src/paths.js';
import { clearPause, setPause } from '../src/pause.js';
import { pinnedPlugins } from '../src/plugins.js';
import type { Claude, Gh, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import { reportName } from '../src/report.js';
import { LAUNCH_LOCK } from '../src/usage.js';
import { parseClaim, parseOffer } from '../src/worker-claim.js';
import type { WorkerPlatform } from '../src/worker-deny.js';
import type { WorkerHub } from '../src/worker-hub.js';
import { openOffer } from '../src/worker-lead.js';
import { fakeGitHub, idOf } from './worker-fake.js';

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
const CREW_TOKEN = ['ctok', 'en', '-for-the-crew-0001'].join('');
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

function world(items: string[] = [ITEM], extraYaml = ''): World {
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
  writeFileSync(join(project, '.studio', 'studio.yaml'), studioYaml(denied) + extraYaml);
  writeFileSync(join(project, '.studio', 'board.yaml'), `items:\n${items.join('\n')}\n`);
  mkdirSync(join(project, '.studio', 'roles'));
  writeFileSync(join(project, '.studio', 'roles', 'builder.md'), 'Role text from main.\n');
  writeFileSync(join(project, 'README.md'), 'x\n');
  git(
    project,
    'add',
    'README.md',
    '.studio/studio.yaml',
    '.studio/board.yaml',
    '.studio/roles/builder.md',
  );
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  const home = join(base, 'lead-home');
  mkdirSync(home);
  writeOwnerConfig(home, acceptYaml('win-bot', 'win-bot2'));
  const env = { PATH: process.env.PATH };
  const now = { t: Date.parse('2026-10-31T10:00:00Z') };
  currentOrigin = origin;
  return {
    base,
    origin,
    denied,
    now,
    lead: { project, home, env, state: stateRootFor(project, { env, homedir: home }) },
    github: fakeGitHub(() => new Date(now.t)),
  };
}

/**
 * A worker machine: its own clone, home, owner config, worker token, pinned plugins and, unless
 * `crewToken: false`, a crew token of its own for the crews.
 */
function workerMachine(w: World, name: string, o: { crewToken?: boolean } = {}): Machine {
  const project = join(w.base, name);
  git(w.base, 'clone', '-q', w.origin, project);
  const home = join(w.base, `${name}-home`);
  mkdirSync(home);
  writeOwnerConfig(
    home,
    `workers:\n  self:\n    lead: lead-user\n    lead_id: ${idOf('lead-user')}\n`,
  );
  const secret = (file: string, value: string) => {
    writeFileSync(join(ownerDir(home), file), `${value}\n`);
    chmodSync(join(ownerDir(home), file), 0o600);
  };
  secret('worker-token', `${WORKER_TOKEN}-${name}`);
  if (o.crewToken !== false) secret('crew-token', `${CREW_TOKEN}-${name}`);
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
    // The worker token acts as the worker's account, a crew token as an account of its own.
    hub: (token?: string) =>
      w.github.hubAs(
        token === undefined ? 'lead-user' : token.startsWith(CREW_TOKEN) ? `${login}-crew` : login,
      ),
  };
}

const newCrew = (): Crew => ({ started: [], stopped: [], running: false });

let currentOrigin = '';
async function run(
  m: Machine,
  ports: Ports,
  argv: string[],
  platform = LINUX,
  extra: { beatMs?: number } = {},
) {
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
    ...(extra.beatMs === undefined ? {} : { workerBeatMs: extra.beatMs }),
    // Pushes a worker makes for a crew without a token go to the fixture's origin.
    workerPushUrl: () => currentOrigin,
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
const workerGh = (_w: World, _author: string) => fakeGh(() => undefined);

/** The `workers.accept` lines of an owner config: each login with the id the fake gives it. */
const acceptYaml = (...logins: string[]) =>
  `workers:\n  accept:\n    windows: [${logins.map((l) => `{ login: ${l}, id: ${idOf(l)} }`).join(', ')}]\n`;

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
    // The crew gets the crew token; the worker's own token never reaches it.
    expect(crew.started[0]?.env.GH_TOKEN).toBe(`${CREW_TOKEN}-win`);
    expect(JSON.stringify(crew.started[0]?.env)).not.toContain(WORKER_TOKEN);
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
    // The lead sees the claim now: its lease runs from here, on the lead's clock.
    await run(w.lead, lead, ['tick']);

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
    await run(w.lead, lead, ['tick']);
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
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    crewFinishes(w, wm, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    // GitHub shows another account as the pull request's author than the claim names.
    const pr = w.github.prs.get(7);
    if (pr === undefined) throw new Error('no pull request');
    w.github.prs.set(7, { ...pr, author: 'someone-else', authorId: idOf('someone-else') });
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

  it('a worker never renews a pull request of another account for its branch', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    await w.github.hubAs('someone-else').createPullRequest('org/app', {
      head: 'studio/APP-1',
      base: 'main',
      title: 't',
      body: 'b',
    });
    crewFinishes(w, wm, crew);
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({
      kind: 'released',
      line: 'APP-1: a pull request of another account is open for the branch; released',
    });
  });

  it('a claim of a worker the owner did not accept counts for nothing', async () => {
    const w = world();
    writeOwnerConfig(w.lead.home, acceptYaml('win-bot2'));
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
    issue.editorId = idOf('someone-else');
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({ kind: 'idle' });
    expect(s.err).toMatch(/skipped offer #30: edited by someone other than the lead/);
    issue.editor = 'lead-user';
    issue.editorId = idOf('lead-user');
    issue.author = 'someone-else';
    issue.authorId = idOf('someone-else');
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

  it('a fix round counts only when the claiming worker opened the pull request', async () => {
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
    // The open pull request is win-bot's: win-bot2 never takes it over, it gives the round back.
    expect(
      lastLine((await run(b, pb, ['worker', '--label', 'windows', '--once'])).out),
    ).toMatchObject({
      kind: 'released',
      line: 'APP-1: a pull request of another account is open for the branch; released',
    });
  });

  const claimMsg = (state: string, worker = 'win-bot', attempt = 1) =>
    `Studio claim APP-1: ${state}\n\n${JSON.stringify({ studio_claim: 1, item: 'APP-1', label: 'windows', worker, offer: 30, attempt, state, lease_minutes: 30 })}\n`;
  const nonceOf = (w: World): string =>
    JSON.parse(readFileSync(join(w.lead.state, 'workers.json'), 'utf8')).items['APP-1'].nonce;

  it('a claim commit with a forged author and no claim comment goes to the lead', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    // Anyone with contents write can write the ref, naming an accepted worker and that worker's
    // e-mail as author: nothing in the commit counts.
    w.github.plant('APP-1', claimMsg('claimed'));
    // A comment may just be late: the lead waits a short grace before it asks for help.
    const early = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(early.needsLead).toEqual([]);
    expect(early.held).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/awaits its comment/),
    });
    w.now.t += 3 * 60_000;
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(
        /^APP-1: no claim comment on #30 proves who claimed it \([0-9a-f]{12}\); nothing of it counts$/,
      ),
    });
    expect(statusOf(w)?.status).toBe('assigned');
  });

  it('a claim comment by a login that is not accepted does not count; the lead hears of it', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const sha = w.github.plant('APP-1', claimMsg('claimed'));
    w.github.plant('APP-1', claimMsg('alive'));
    await w.github
      .hubAs('intruder')
      .commentOffer('org/app', 30, `studio-claim ${sha} ${nonceOf(w)}`);
    await w.github
      .hubAs('win-bot')
      .commentOffer('org/app', 30, `studio-claim ${sha} ${nonceOf(w)}`);
    // Only accepted accounts decide: the intruder's comment neither proves nor blocks the claim.
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(
        /claim comment \d+ by intruder, who is not accepted for windows/,
      ),
    });
    expect(tick.held).toContainEqual({
      item: 'APP-1',
      reason: 'worker: on win-bot (windows), heartbeat 0 min ago',
    });
    expect(statusOf(w)?.status).toBe('in_progress');
  });

  it('a done commit appended after a proven claim counts only when the claimant announced it', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    // A crew (or anyone with contents write) fast-forwards a forged done onto the proven claim.
    const forged = w.github.plant(
      'APP-1',
      `Studio claim APP-1: done\n\n${JSON.stringify({ studio_claim: 1, item: 'APP-1', label: 'windows', worker: 'win-bot', offer: 30, attempt: 1, state: 'done', lease_minutes: 30, pr: 7 })}\n`,
    );
    let tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.collected).toEqual([]);
    expect(tick.needsLead).toEqual([]);
    w.now.t += 3 * 60_000;
    tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: `APP-1: its done commit ${forged.slice(0, 12)} was not announced by win-bot; nothing of it counts`,
    });
    expect(tick.collected).toEqual([]);
    // Announced by someone else does not count either.
    await w.github
      .hubAs('intruder')
      .commentOffer('org/app', 30, `studio-claim ${forged} ${nonceOf(w)}`);
    tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.collected).toEqual([]);
    // A state change below the tip is refused too.
    w.github.plant(
      'APP-1',
      `Studio claim APP-1: alive\n\n${JSON.stringify({ studio_claim: 1, item: 'APP-1', label: 'windows', worker: 'win-bot', offer: 30, attempt: 1, state: 'alive', lease_minutes: 30 })}\n`,
    );
    tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/its chain holds a done commit below its tip/),
    });
  });

  it('an edited claim comment is ignored', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    await run(wm, machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew()), [
      'worker',
      '--label',
      'windows',
      '--once',
    ]);
    const [comment] = w.github.comments.get(30) ?? [];
    expect(comment?.login).toBe('win-bot');
    expect(comment?.body).toMatch(/^studio-claim [0-9a-f]{40} [0-9a-f]{32}$/);
    if (comment === undefined) throw new Error('no claim comment');
    comment.updatedAt = new Date(w.now.t + 1000).toISOString();
    // A comment may just be late: the lead waits a short grace before it asks for help.
    const early = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(early.needsLead).not.toContainEqual(
      expect.objectContaining({ reason: expect.stringMatching(/no claim comment/) }),
    );
    expect(early.held).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/awaits its comment/),
    });
    w.now.t += 3 * 60_000;
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/claim comment \d+ by win-bot was edited and does not count/),
    });
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/no claim comment on #30 proves who claimed it/),
    });
  });

  it('a lease runs from when the lead saw the claim, never from the commit date', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    // A claim dated a day back, as a writer could set it, with its proper comment.
    const sha = w.github.plant('APP-1', claimMsg('claimed'), {
      at: new Date(w.now.t - 86_400_000).toISOString(),
    });
    await w.github
      .hubAs('win-bot')
      .commentOffer('org/app', 30, `studio-claim ${sha} ${nonceOf(w)}`);
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.held).toContainEqual({
      item: 'APP-1',
      reason: 'worker: on win-bot (windows), heartbeat 0 min ago',
    });
    // Another worker does not take it over at first sight either.
    const b = workerMachine(w, 'win2');
    const pb = machinePorts(w, 'win-bot2', workerGh(w, 'win-bot2').gh, newCrew());
    expect(lastLine((await run(b, pb, ['worker', '--label', 'windows', '--once'])).out).kind).toBe(
      'idle',
    );
    expect(claimOf(w)?.worker).toBe('win-bot');
  });

  it('a worker without a crew token: the crew gets no token, the worker pushes its branch', async () => {
    const w = world();
    // A real partial clone, as from GitHub: the origin serves blob filters over file://.
    git(w.base, '--git-dir', w.origin, 'config', 'uploadpack.allowFilter', 'true');
    currentOrigin = `file://${w.origin}`;
    // History holds a blob that no checkout has: a blob-less clone never fetches it.
    writeFileSync(join(w.lead.project, 'old.txt'), 'only in history\n');
    git(w.lead.project, 'add', 'old.txt');
    git(w.lead.project, 'commit', '-q', '-m', 'old');
    git(w.lead.project, 'rm', '-q', 'old.txt');
    git(w.lead.project, 'commit', '-q', '-m', 'gone');
    git(w.lead.project, 'push', '-q', 'origin', 'main');
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win', { crewToken: false });
    git(wm.project, 'remote', 'set-url', 'origin', currentOrigin);
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(crew.started[0]?.env.GH_TOKEN).toBeUndefined();
    expect(JSON.stringify(crew.started[0]?.env)).not.toContain(WORKER_TOKEN);
    const brief = readFileSync(join(wm.state, 'briefs', 'APP-1.md'), 'utf8');
    expect(brief).toContain('Do not push: you have no GitHub token');
    expect(brief).not.toContain('git push origin');
    // The crew commits in its clone; the worker pushes that commit with its own token.
    const clone = join(wm.state, 'clones', 'APP-1');
    // The crew's clone is blob-less: it lacks the blobs of history it did not check out.
    expect(git(clone, 'config', '--get', 'remote.origin.promisor')).toBe('true');
    expect(git(clone, 'rev-list', '--objects', '--missing=print', 'HEAD')).toMatch(
      /^\?[0-9a-f]{40}$/m,
    );
    writeFileSync(join(clone, 'log.txt'), 'parsed\n');
    git(clone, 'add', 'log.txt');
    git(clone, 'commit', '-q', '-m', 'parse the log');
    const head = git(clone, 'rev-parse', 'HEAD');
    crewFinishes(w, wm, crew, defaultReport().replace(HEAD, head));
    w.github.branches.delete('studio/APP-1');
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({ kind: 'done' });
    expect(git(w.base, '--git-dir', w.origin, 'rev-parse', 'refs/heads/studio/APP-1')).toBe(head);
    expect(existsSync(join(wm.state, 'push', 'APP-1'))).toBe(false);
  });

  it('a worker token that equals the crew token is refused', async () => {
    const w = world();
    const wm = workerMachine(w, 'win');
    writeFileSync(join(ownerDir(wm.home), 'crew-token'), `${WORKER_TOKEN}-win\n`);
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    const r = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the worker token equals the crew token/);
    expect(w.github.refs.size).toBe(0);
  });

  // ---- The independent review of 29b3b19 ------------------------------------------------------

  /** A worker that has claimed APP-1 and runs its crew. */
  const claimedWorld = async (o: { extraYaml?: string } = {}) => {
    const w = world([ITEM], o.extraYaml ?? '');
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    expect(lastLine((await run(wm, wp, ['worker', '--label', 'windows', '--once'])).out).kind).toBe(
      'claimed',
    );
    return { w, lead, wm, crew, wp };
  };

  it('crew and worker tokens of one account: the worker refuses to start', async () => {
    const w = world();
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    // Both tokens act as the same GitHub account.
    wp.hub = (token?: string) => w.github.hubAs(token === undefined ? 'lead-user' : 'win-bot');
    const r = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the worker token and the crew token belong to the same account/);
    expect(w.github.refs.size).toBe(0);
  });

  it('the lead refuses to offer to an accepted account that is its own crew token account', async () => {
    const w = world();
    writeOwnerConfig(
      w.lead.home,
      `workers:\n  accept:\n    windows: [{ login: lead-user-crew, id: ${idOf('lead-user-crew')} }]\n`,
    );
    writeFileSync(join(ownerDir(w.lead.home), 'crew-token'), `${CREW_TOKEN}-lead\n`);
    chmodSync(join(ownerDir(w.lead.home), 'crew-token'), 0o600);
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.errors).toContainEqual({
      item: 'APP-1',
      error: expect.stringMatching(/the account of the lead's crew token/),
    });
    expect(w.github.issues.size).toBe(0);
  });

  it('a worker whose credential is parked or whose launch lock is held claims nothing', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    const ownerRoot = ownerStateRootFor({ env: wm.env, homedir: wm.home });
    mkdirSync(ownerRoot, { recursive: true });
    const lock = acquireStateLock(ownerRoot, LAUNCH_LOCK, {
      now: new Date(w.now.t),
      heartbeatStaleMs: 600_000,
    });
    expect(
      lastLine((await run(wm, wp, ['worker', '--label', 'windows', '--once'])).out),
    ).toMatchObject({ kind: 'held', line: 'another launch is in progress on this machine' });
    lock?.release();
    writeFileSync(
      join(ownerRoot, 'limits.json'),
      JSON.stringify({
        default: { parkedUntil: new Date(w.now.t + 3_600_000).toISOString(), kind: 'session' },
      }),
    );
    expect(lastLine((await run(wm, wp, ['worker', '--label', 'windows', '--once'])).out).kind).toBe(
      'held',
    );
    expect(w.github.refs.size).toBe(0);
  });

  it('a launch that is held after the claim was won takes the claim back, the offer stays', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    const ownerRoot = ownerStateRootFor({ env: wm.env, homedir: wm.home });
    let lock: ReturnType<typeof acquireStateLock>;
    const base = wp.hub as (t?: string) => WorkerHub;
    wp.hub = (t?: string) => {
      const h = base(t);
      return {
        ...h,
        // Another launch starts right between the claim and this worker's launch.
        async commentOffer(repo, n, body) {
          await h.commentOffer(repo, n, body);
          mkdirSync(ownerRoot, { recursive: true });
          lock = acquireStateLock(ownerRoot, LAUNCH_LOCK, {
            now: new Date(w.now.t),
            heartbeatStaleMs: 600_000,
          });
        },
      };
    };
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    lock?.release();
    expect(lastLine(s.out)).toMatchObject({ kind: 'held', item: 'APP-1' });
    expect(w.github.refs.has('APP-1')).toBe(false);
    expect(w.github.issues.get(30)?.open).toBe(true);
    expect(crew.started).toHaveLength(0);
  });

  it('a claim comment that fails takes the claim back', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    // A worker without write access cannot comment on the locked offer.
    w.github.outsiders.add('win-bot');
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({
      kind: 'held',
      line: 'APP-1: the claim comment failed; let go',
    });
    expect(w.github.refs.has('APP-1')).toBe(false);
  });

  it('the brief takes role text from origin/main, never from the worker working tree', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    writeFileSync(
      join(wm.project, '.studio', 'roles', 'builder.md'),
      'Role text of the working tree.\n',
    );
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    const brief = readFileSync(join(wm.state, 'briefs', 'APP-1.md'), 'utf8');
    expect(brief).toContain('Role text from main.');
    expect(brief).not.toContain('working tree.');
  });

  it('claim comments by accounts without write access neither prove nor block', async () => {
    const { w, lead } = await claimedWorld();
    const sha = w.github.refs.get('APP-1') as string;
    // A comment from before the lock, by an account without write access, naming the claim first.
    const at = new Date(w.now.t - 60_000).toISOString();
    w.github.comments.get(30)?.unshift({
      id: 1,
      login: 'win-bot',
      userId: idOf('win-bot'),
      association: 'NONE',
      body: `studio-claim ${sha} ${nonceOf(w)}`,
      createdAt: at,
      updatedAt: at,
    });
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: 'APP-1: claim comment 1 by win-bot, who has no write access, does not count',
    });
    expect(tick.held).toContainEqual({
      item: 'APP-1',
      reason: 'worker: on win-bot (windows), heartbeat 0 min ago',
    });
  });

  it('an offer with more comments than Studio reads decides nothing', async () => {
    const { w, lead } = await claimedWorld();
    w.github.cut.add(30);
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/#30 has more comments than Studio reads/),
    });
  });

  it('a login reused by another account is not the accepted worker', async () => {
    const { w, lead } = await claimedWorld();
    // The owner pinned win-bot's account id; the account now named win-bot is another one.
    writeOwnerConfig(
      w.lead.home,
      'workers:\n  accept:\n    windows: [{ login: win-bot, id: 1 }]\n',
    );
    // A comment may just be late: the lead waits a short grace before it asks for help.
    const early = JSON.parse((await run(w.lead, lead, ['tick'])).out);

    expect(early.held).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/awaits its comment/),
    });
    w.now.t += 3 * 60_000;
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/no claim comment on #30 proves who claimed it/),
    });
  });

  it('a ledger that does not take the run keeps the item for the next tick, nothing lost', async () => {
    const { w, lead, wm, crew, wp } = await claimedWorld();
    crewFinishes(w, wm, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    writeFileSync(join(w.lead.state, 'costs.json'), 'not json');
    const t1 = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(t1.held).toContainEqual({
      item: 'APP-1',
      reason: 'worker: the cost ledger did not take the run yet; collected next tick',
    });
    expect(statusOf(w)?.status).not.toBe('in_review');
    rmSync(join(w.lead.state, 'costs.json'));
    const t2 = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(t2.collected).toEqual([expect.objectContaining({ item: 'APP-1', status: 'in_review' })]);
    expect(statusOf(w)?.usage?.costUsd).toBe(0.42);
  });

  it('a single run counts for at most the daily cap', async () => {
    const { w, lead, wm, crew, wp } = await claimedWorld({
      extraYaml: 'limits: { daily_cost_usd: 0.1 }\n',
    });
    crewFinishes(w, wm, crew);
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: 'APP-1: win-bot reported $0.42 for one run; counted as $0.10, the daily cap',
    });
    const ledger = JSON.parse(readFileSync(join(w.lead.state, 'costs.json'), 'utf8'));
    expect(Object.values(ledger.runs)).toContainEqual(expect.objectContaining({ costUsd: 0.1 }));
  });

  it('a failing check for new claims never costs the held item its heartbeat', async () => {
    const { w, wm, wp } = await claimedWorld();
    // Pause on the worker: no new claim, but the crew it holds goes on and is beaten.
    writeFileSync(join(wm.state, 'pause.json'), '{}');
    w.now.t += 11 * 60_000;
    expect(
      lastLine((await run(wm, wp, ['worker', '--label', 'windows', '--once'])).out),
    ).toMatchObject({ kind: 'working', line: 'APP-1: the crew is working; heartbeat sent' });
  });

  it('after a restart, heartbeats of its own on top of the saved claim keep the crew', async () => {
    const { w, wm, crew, wp } = await claimedWorld();
    const file = join(wm.state, 'worker.json');
    const before = JSON.parse(readFileSync(file, 'utf8')).current.claimSha;
    w.now.t += 11 * 60_000;
    await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    // As if the worker died after the heartbeat but before saving it.
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.current.claimSha = before;
    writeFileSync(file, JSON.stringify(saved));
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({ kind: 'working' });
    expect(crew.stopped).toEqual([]);
  });

  it('the lead walks a claim chain only down to the tip it proved before', async () => {
    const { w, lead, wm, wp } = await claimedWorld();
    let walked = 0;
    const base = lead.hub as (t?: string) => WorkerHub;
    lead.hub = (t?: string) => {
      const h = base(t);
      return {
        ...h,
        async claimCommit(repo, sha) {
          walked++;
          return h.claimCommit(repo, sha);
        },
      };
    };
    for (let i = 0; i < 3; i++) {
      await run(w.lead, lead, ['tick']);
      w.now.t += 11 * 60_000;
      await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    }
    walked = 0;
    await run(w.lead, lead, ['tick']);
    expect(walked).toBe(1);
  });

  it('an offer closed right as it was claimed: the worker takes its claim back', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const crew = newCrew();
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, crew);
    const base = wp.hub as (t?: string) => WorkerHub;
    wp.hub = (t?: string) => {
      const h = base(t);
      return {
        ...h,
        async writeClaim(repo, item, o) {
          const r = await h.writeClaim(repo, item, o);
          const issue = w.github.issues.get(30);
          if (issue) issue.open = false;
          return r;
        },
      };
    };
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({ kind: 'idle' });
    expect(w.github.refs.has('APP-1')).toBe(false);
    expect(crew.started).toHaveLength(0);
  });

  it('a claim moved just before the report goes out: nothing is pushed or opened', async () => {
    const { w, wm, crew, wp } = await claimedWorld();
    crewFinishes(w, wm, crew);
    let reads = 0;
    const base = wp.hub as (t?: string) => WorkerHub;
    wp.hub = (t?: string) => {
      const h = base(t);
      return {
        ...h,
        async readClaim(repo, item) {
          // The second read in this pass, right before the pull request, finds the claim gone.
          return ++reads >= 2 ? undefined : h.readClaim(repo, item);
        },
      };
    };
    const s = await run(wm, wp, ['worker', '--label', 'windows', '--once']);
    expect(lastLine(s.out)).toMatchObject({
      kind: 'lost',
      line: 'APP-1: the claim moved before the report went out',
    });
    expect(w.github.prs.size).toBe(0);
  });

  it('a report holding the crew token stays on the worker', async () => {
    const { w, wm, crew, wp } = await claimedWorld();
    crewFinishes(w, wm, crew, defaultReport().replace('a test covers it', `${CREW_TOKEN}-win`));
    expect(
      lastLine((await run(wm, wp, ['worker', '--label', 'windows', '--once'])).out),
    ).toMatchObject({
      kind: 'released',
      line: expect.stringMatching(/looks like it holds a credential/),
    });
  });

  // ---- The verification review of 2fd04ab ------------------------------------------------------

  /** A hub that runs `after` once the claim comment (the first comment of the worker) is posted. */
  const afterClaimComment = (wp: Ports, after: () => void | Promise<void>) => {
    const base = wp.hub as (t?: string) => WorkerHub;
    let done = false;
    wp.hub = (t?: string) => {
      const h = base(t);
      return {
        ...h,
        async commentOffer(repo, n, body) {
          await h.commentOffer(repo, n, body);
          if (!done) {
            done = true;
            await after();
          }
        },
      };
    };
  };
  const claimComments = (w: World) =>
    (w.github.comments.get(30) ?? []).filter((c) => c.login === 'win-bot').length;
  const once = ['worker', '--label', 'windows', '--once'];

  it('N1: an offer an earlier tick opened but did not lock is locked when it is reused', async () => {
    const w = world();
    const hub = w.github.hubAs('lead-user');
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const issue = w.github.issues.get(30);
    if (issue === undefined) throw new Error('no offer');
    issue.locked = false;
    const offer = parseOffer(issue.title, issue.body);
    if (offer === undefined) throw new Error('no offer item');
    const again = await openOffer({
      hub,
      repo: 'org/app',
      item: offer.item,
      lead: 'lead-user',
      now: new Date(w.now.t),
    });
    expect(again).toEqual({ offer: 30, nonce: offer.nonce });
    expect(issue.locked).toBe(true);
    expect(w.github.issues.size).toBe(1);
  });

  it('N2: a transient refusal at launch is held; the offer is not claimed again at once', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    // A pause arrives right between the claim and the launch.
    afterClaimComment(wp, () => setPause(wm.state, new Date(w.now.t)));
    const s = await run(wm, wp, once);
    expect(s.code).toBe(0);
    expect(lastLine(s.out)).toMatchObject({ kind: 'held', item: 'APP-1' });
    expect(w.github.refs.has('APP-1')).toBe(false);
    expect(claimComments(w)).toBe(1);
    clearPause(wm.state);
    // Soon after, the same offer is left alone: no second claim, no second comment.
    w.now.t += 60_000;
    expect(lastLine((await run(wm, wp, once)).out).kind).toBe('idle');
    expect(claimComments(w)).toBe(1);
    // Later it is tried again.
    w.now.t += 6 * 60_000;
    expect(lastLine((await run(wm, wp, once)).out).kind).toBe('claimed');
    expect(claimComments(w)).toBe(2);
  });

  it('N2: an item-specific refusal gives the claim up and is not claimed or commented again', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    wp.claude = {
      ...wp.claude,
      async start() {
        throw new Error('cannot start the crew');
      },
    };
    const first = await run(wm, wp, once);
    expect(lastLine(first.out)).toMatchObject({ kind: 'refused', item: 'APP-1' });
    expect(w.github.refs.has('APP-1')).toBe(false);
    expect(claimComments(w)).toBe(1);
    w.now.t += 10 * 60_000;
    const second = await run(wm, wp, once);
    expect(lastLine(second.out).kind).toBe('idle');
    expect(claimComments(w)).toBe(1);
    expect(w.github.issues.get(30)?.open).toBe(true);
  });

  it('N3: a done commit whose comment failed is announced on a later pass, with backoff', async () => {
    const { w, lead, wm, crew, wp } = await claimedWorld();
    crewFinishes(w, wm, crew);
    const base = wp.hub as (t?: string) => WorkerHub;
    let failing = true;
    wp.hub = (t?: string) => {
      const h = base(t);
      return {
        ...h,
        async commentOffer(repo, n, body) {
          if (failing) throw new Error('network down');
          await h.commentOffer(repo, n, body);
        },
      };
    };
    const done = await run(wm, wp, once);
    expect(lastLine(done.out)).toMatchObject({ kind: 'done' });
    const stateFile = join(wm.state, 'worker.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state.current).toBeUndefined();
    expect(state.pending).toMatchObject({ item: 'APP-1', tries: 1 });
    // The lead waits a short grace for the comment instead of asking for help.
    const early = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(early.needsLead).toEqual([]);
    expect(early.collected).toEqual([]);
    // Not due yet: a pass right away does not try again.
    failing = false;
    await run(wm, wp, once);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).pending.tries).toBe(1);
    // Due: the comment is posted once and the record goes.
    w.now.t += 60_000;
    await run(wm, wp, once);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).pending).toBeUndefined();
    const late = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(late.collected).toEqual([expect.objectContaining({ item: 'APP-1' })]);
  });

  it('N3: a lead that never gets the comment asks for help after the grace', async () => {
    const { w, lead, wm, crew, wp } = await claimedWorld();
    crewFinishes(w, wm, crew);
    const base = wp.hub as (t?: string) => WorkerHub;
    wp.hub = (t?: string) => ({
      ...base(t),
      async commentOffer() {
        throw new Error('network down');
      },
    });
    await run(wm, wp, once);
    await run(w.lead, lead, ['tick']);
    w.now.t += 3 * 60_000;
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/was not announced by win-bot/),
    });
  });

  it('N4: a takeover that cannot start puts the ref back to the first attempt', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const a = workerMachine(w, 'win');
    const pa = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    await run(a, pa, once);
    const first = w.github.refs.get('APP-1');
    await run(w.lead, lead, ['tick']);
    const b = workerMachine(w, 'win2');
    const pb = machinePorts(w, 'win-bot2', workerGh(w, 'win-bot2').gh, newCrew());
    // The second worker sees the claim now: its lease runs from here, on its own clock.
    expect(lastLine((await run(b, pb, once)).out).kind).toBe('idle');
    const c = workerMachine(w, 'win3');
    const pc = machinePorts(w, 'win-bot3', workerGh(w, 'win-bot3').gh, newCrew());
    expect(lastLine((await run(c, pc, once)).out).kind).toBe('idle');
    w.now.t += 33 * 60_000;
    pb.claude = {
      ...pb.claude,
      async start() {
        throw new Error('cannot start the crew');
      },
    };
    const s = await run(b, pb, once);
    expect(lastLine(s.out)).toMatchObject({ kind: 'refused' });
    // The ref is back at attempt 1; the attempt count was not used up.
    expect(w.github.refs.get('APP-1')).toBe(first);
    expect(claimOf(w)).toMatchObject({ worker: 'win-bot', attempt: 1 });
    expect(w.github.calls).toContain('win-bot2 reset claim APP-1');
    expect(w.github.calls).not.toContain('win-bot2 delete claim APP-1');
    // Another worker can still make the one takeover.
    expect(lastLine((await run(c, pc, once)).out)).toMatchObject({
      kind: 'claimed',
      line: expect.stringMatching(/attempt 2/),
    });
  });

  it('N5: the crew starts from the pinned origin/main commit even when main moves on', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    const pinned = git(w.lead.project, 'rev-parse', 'origin/main');
    // Main moves on between the worker's fetch and its launch.
    afterClaimComment(wp, () => {
      writeFileSync(join(w.lead.project, 'later.txt'), 'later\n');
      git(w.lead.project, 'add', 'later.txt');
      git(w.lead.project, 'commit', '-q', '-m', 'later');
      git(w.lead.project, 'push', '-q', 'origin', 'main');
    });
    const s = await run(wm, wp, once);
    expect(lastLine(s.out).kind).toBe('claimed');
    const clone = join(wm.state, 'clones', 'APP-1');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(pinned);
    expect(existsSync(join(clone, 'later.txt'))).toBe(false);
  });

  it('N6: the lead is told by its numeric id, not by its login', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    const issue = w.github.issues.get(30);
    if (issue === undefined) throw new Error('no offer');
    const wm = workerMachine(w, 'win');
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    // The login was renamed and reused: same login, another account.
    issue.authorId = idOf('someone-else');
    expect(lastLine((await run(wm, wp, once)).out).kind).toBe('idle');
    expect(w.github.refs.size).toBe(0);
    // The same account under a login of other case is still the lead.
    issue.authorId = idOf('lead-user');
    issue.author = 'Lead-User';
    expect(lastLine((await run(wm, wp, once)).out).kind).toBe('claimed');
  });

  it("N6: a worker token of the lead's account is refused by id", async () => {
    const w = world();
    const wm = workerMachine(w, 'win');
    writeOwnerConfig(
      wm.home,
      `workers:\n  self:\n    lead: renamed-lead\n    lead_id: ${idOf('win-bot')}\n`,
    );
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    const s = await run(wm, wp, once);
    expect(lastLine(s.out)).toMatchObject({
      kind: 'refused',
      line: expect.stringMatching(/the lead's own identity/),
    });
  });

  it('N6: the crew token check reads the pinned config, not the working tree', async () => {
    const w = world();
    const wm = workerMachine(w, 'win');
    // The working tree names an environment variable for the crew token; origin/main does not.
    const f = join(wm.project, '.studio', 'studio.yaml');
    writeFileSync(f, `${readFileSync(f, 'utf8')}crew_token: { env: OTHER_CREW_TOKEN }\n`);
    wm.env.OTHER_CREW_TOKEN = `${CREW_TOKEN}-env`;
    const wp = machinePorts(w, 'win-bot', workerGh(w, 'win-bot').gh, newCrew());
    // Both the file token (read through the pinned config) and the worker token act as win-bot.
    wp.hub = () => w.github.hubAs('win-bot');
    const r = await run(wm, wp, once);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/belong to the same account/);
  });

  it('N6: a long call keeps the claim beating, and the done commit builds on the beats', async () => {
    const { w, wm, crew, wp } = await claimedWorld();
    crewFinishes(w, wm, crew);
    const before = w.github.refs.get('APP-1');
    // The pull request takes a while: beats run meanwhile, and the done commit builds on them.
    const base = wp.hub as (t?: string) => WorkerHub;
    wp.hub = (t?: string) => {
      const h = base(t);
      return {
        ...h,
        async createPullRequest(repo, o) {
          await new Promise((r) => setTimeout(r, 150));
          return h.createPullRequest(repo, o);
        },
      };
    };
    const s = await run(wm, wp, once, LINUX, { beatMs: 20 });
    expect(lastLine(s.out)).toMatchObject({ kind: 'done' });
    const beats = [...w.github.commits.values()].filter((c) => /: alive/.test(c.message));
    expect(beats.length).toBeGreaterThan(0);
    expect(w.github.refs.get('APP-1')).not.toBe(before);
    expect(claimOf(w)).toMatchObject({ state: 'done' });
  });

  it('a stream of new unannounced tips reaches the lead after a single grace window', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    w.github.plant('APP-1', claimMsg('claimed'));
    expect(JSON.parse((await run(w.lead, lead, ['tick'])).out).needsLead).toEqual([]);
    // A new tip every minute must not restart the window.
    for (let i = 0; i < 2; i++) {
      w.now.t += 60_000;
      w.github.plant('APP-1', claimMsg('alive'));
      const t = JSON.parse((await run(w.lead, lead, ['tick'])).out);
      expect(t.needsLead).toEqual([]);
    }
    w.now.t += 60_000;
    w.github.plant('APP-1', claimMsg('alive'));
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/no claim comment on #30 proves who claimed it/),
    });
  });

  it('changing the attempt number of new tips does not restart the grace window', async () => {
    const w = world();
    const lead = machinePorts(w, 'lead-user', leadGh().gh, newCrew());
    await run(w.lead, lead, ['tick']);
    w.github.plant('APP-1', claimMsg('claimed', 'win-bot', 1));
    expect(JSON.parse((await run(w.lead, lead, ['tick'])).out).needsLead).toEqual([]);
    // Attempt numbers that alternate or rise are the writer's choice: the window runs on.
    for (const attempt of [2, 1]) {
      w.now.t += 60_000;
      w.github.plant('APP-1', claimMsg('claimed', 'win-bot', attempt));
      expect(JSON.parse((await run(w.lead, lead, ['tick'])).out).needsLead).toEqual([]);
    }
    w.now.t += 60_000;
    w.github.plant('APP-1', claimMsg('claimed', 'win-bot', 2));
    const tick = JSON.parse((await run(w.lead, lead, ['tick'])).out);
    expect(tick.needsLead).toContainEqual({
      item: 'APP-1',
      reason: expect.stringMatching(/no claim comment on #30 proves who claimed it/),
    });
  });
});
