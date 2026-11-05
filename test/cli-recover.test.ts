import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard, saveBoard, transition } from '../src/board.js';
import { runCli } from '../src/cli.js';
import {
  acquireStateLock,
  checkStateMarker,
  ownerStateRootFor,
  processIdentity,
  projectRealpath,
  stateRootFor,
  writeStateFile,
} from '../src/paths.js';
import type { Gh, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import { loadQueue, saveQueue } from '../src/queue.js';
import { newReportName } from '../src/report.js';
import { listLessons } from '../src/role-memory.js';
import { updateCrewRecords } from '../src/state.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-recover-')));
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

const HEAD = 'a'.repeat(40);
const OWN = {
  headRepository: { name: 'app' },
  headRepositoryOwner: { login: 'org' },
  isCrossRepository: false,
};
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
  researcher: { model: opus, wip: 1 }
owner_only: []
deploy_commands: []
`;

interface ItemSpec {
  id: string;
  status?: string;
  type?: string;
  role?: string;
  pr?: number;
  approvedHead?: string;
  history?: string;
}
const itemYaml = (s: ItemSpec): string =>
  [
    `  - id: ${s.id}`,
    `    title: Item ${s.id}`,
    `    type: ${s.type ?? 'fix'}`,
    `    role: ${s.role ?? 'builder'}`,
    '    repo: org/app',
    '    size: S',
    '    priority: 1',
    `    status: ${s.status ?? 'ready'}`,
    '    paths: []',
    `    touches: [${s.id.toLowerCase()}/**]`,
    '    depends_on: []',
    '    dod: ["tests pass"]',
    ...(s.pr ? [`    pr: ${s.pr}`] : []),
    ...(s.approvedHead ? [`    approved_head: ${s.approvedHead}`, '    approved_base: main'] : []),
    `    history: ${s.history ?? '[]'}`,
  ].join('\n');

let n = 0;
interface Fx {
  project: string;
  home: string;
  env: Record<string, string | undefined>;
  state: string;
  owner: string;
}
function makeFx(items: ItemSpec[]): Fx {
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
    items.length === 0 ? 'items: []\n' : `items:\n${items.map(itemYaml).join('\n')}\n`,
  );
  const env = { PATH: process.env.PATH };
  const fx = {
    project,
    home,
    env,
    state: stateRootFor(project, { env, homedir: home }),
    owner: ownerStateRootFor({ env, homedir: home }),
  };
  checkStateMarker(fx.state, {
    projectRealpath: projectRealpath(project),
    originUrl: git(project, 'remote', 'get-url', 'origin'),
  });
  const dir = join(home, '.config', 'studio');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'crew-token'), 'fake-value-crew-gh-token-55aa\n', { mode: 0o600 });
  return fx;
}

type GhReply = { code?: number; stdout?: string; stderr?: string };
function fakeGh(handler: (line: string) => GhReply | undefined = () => undefined) {
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
        (line.endsWith('--json baseRefName')
          ? { stdout: JSON.stringify({ baseRefName: 'main' }) }
          : line.startsWith('pr checks')
            ? { stdout: JSON.stringify([{ name: 'ci', bucket: 'pass' }]) }
            : undefined);
      if (!r) throw new Error(`unscripted gh call: ${line}`);
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
  return { gh, calls };
}

/** Ports whose crews live until the test ends them; each start gets its own pid. */
function fakePorts(gh: Gh) {
  const live = new Set<number>();
  const started: number[] = [];
  let next = 5000;
  let failNextStart = false;
  let t = Date.parse('2026-11-05T10:00:00Z');
  const ports: Ports = {
    gh,
    git: realPorts().git,
    credentials: realPorts().credentials,
    claude: {
      start: async () => {
        if (failNextStart) {
          failNextStart = false;
          throw new Error('killed: the lead went down before the crew started');
        }
        live.add(next);
        started.push(next);
        return { pid: next++ };
      },
      alive: (pid) => live.has(pid),
      identity: async (pid) => (live.has(pid) ? `start-${pid}` : undefined),
      stop: async (pid) => {
        live.delete(pid);
      },
    },
    clock: {
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
    },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
  return {
    ports,
    started,
    live,
    crashBeforeStart: () => {
      failNextStart = true;
    },
    advance: (ms: number) => {
      t += ms;
    },
    setNow: (ms: number) => {
      t = ms;
    },
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
  return { code, out, err, json: out.trim() === '' ? undefined : JSON.parse(out) };
}
const tick = (fx: Fx, ports: Ports) => cli(fx, ports, 'tick');

const statusOf = (fx: Fx, id: string) => loadBoard(fx.project).items.find((i) => i.id === id);
const records = (fx: Fx) =>
  existsSync(join(fx.state, 'crew.json'))
    ? JSON.parse(readFileSync(join(fx.state, 'crew.json'), 'utf8'))
    : {};
const writeRecords = (fx: Fx, recs: Record<string, unknown>) =>
  writeStateFile(fx.state, join(fx.state, 'crew.json'), JSON.stringify(recs));
const record = (item: string, pid: number, startedAt = '2026-11-05T09:00:00.000Z') => ({
  name: `studio-builder-${item.toLowerCase()}`,
  item,
  role: 'builder',
  pid,
  identity: `start-${pid}`,
  log: '/x',
  startedAt,
});
const writeReport = (fx: Fx, id: string, front: string) => {
  const dir = join(fx.state, 'clones', id, '.studio', 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, newReportName(fx.state, id)), `---\n${front}\n---\n\nbody\n`);
};
/** pid of a process that has already exited */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid as number;
const deadLock = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  writeFileSync(
    join(dir, name),
    `${JSON.stringify({ pid: deadPid(), startedAt: t, heartbeat: t, token: 'old' })}\n`,
  );
};
/** What a tick printed, without the parts that only say what waits. */
const changes = (j: Record<string, unknown>) => {
  const { held: _h, needsLead: _n, ...rest } = j;
  return rest;
};
const QUIET = {
  collected: [],
  reviews: [],
  launched: [],
  queued: [],
  merged: [],
  reruns: [],
  flakyItems: [],
  errors: [],
};

describe('after a crash or a reboot, the next tick picks up the thread', () => {
  it('a launch killed after the clone but before the start runs exactly once on the next tick', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const p = fakePorts(fakeGh().gh);
    p.crashBeforeStart();
    const t1 = await tick(fx, p.ports);
    expect(t1.json.errors).toEqual([{ item: 'APP-1', error: expect.stringMatching(/killed/) }]);
    expect(existsSync(join(fx.state, 'clones', 'APP-1'))).toBe(true);
    expect(records(fx)).toEqual({});
    expect(statusOf(fx, 'APP-1')?.status).toBe('ready');

    const t2 = await tick(fx, p.ports);
    expect(t2.json.errors).toEqual([]);
    expect(t2.json.launched.map((l: { item: string }) => l.item)).toEqual(['APP-1']);
    expect(p.started).toHaveLength(1);
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');

    const t3 = await tick(fx, p.ports);
    expect(changes(t3.json)).toEqual(QUIET);
    expect(p.started).toHaveLength(1);
  });

  it('a launch killed after the crew record but before the board move is completed, never started twice', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const p = fakePorts(fakeGh().gh);
    // The crew runs; its record is on disk; the board still says ready.
    p.live.add(4711);
    writeRecords(fx, { 'APP-1': record('APP-1', 4711) });
    const t1 = await tick(fx, p.ports);
    expect(t1.json.errors).toEqual([]);
    expect(t1.json.recovered).toEqual([
      {
        check: 'launch',
        subject: 'APP-1',
        found: expect.stringMatching(/ready, but crew studio-builder-app-1 \(pid 4711\)/),
        did: expect.stringMatching(/assigned/),
      },
    ]);
    expect(t1.json.launched).toEqual([]);
    expect(p.started).toEqual([]);
    expect(statusOf(fx, 'APP-1')).toMatchObject({
      status: 'assigned',
      crew: 'studio-builder-app-1',
    });
    // Twice after the crash: nothing changes the second time.
    const t2 = await tick(fx, p.ports);
    expect(changes(t2.json)).toEqual(QUIET);
    expect(p.started).toEqual([]);
  });

  it('a record whose identity was not written yet is never signalled and goes to the lead', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const p = fakePorts(fakeGh().gh);
    p.live.add(4711);
    const { identity: _i, ...bare } = record('APP-1', 4711);
    writeRecords(fx, { 'APP-1': bare });
    const t1 = await tick(fx, p.ports);
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');
    expect(t1.json.needsLead).toEqual([
      { item: 'APP-1', reason: expect.stringMatching(/cannot be verified/) },
    ]);
    expect(p.started).toEqual([]);
    expect(p.live.has(4711)).toBe(true);
  });

  it('crews that ended over a reboot: one with a report is collected, one without goes to the lead, neither relaunches', async () => {
    const fx = makeFx([
      { id: 'APP-1', status: 'assigned' },
      { id: 'APP-2', status: 'in_progress' },
    ]);
    const { gh } = fakeGh((l) =>
      l.startsWith('pr view 7')
        ? { stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'studio/APP-1', ...OWN }) }
        : undefined,
    );
    const p = fakePorts(gh);
    // Both pids are gone: the machine restarted.
    writeRecords(fx, { 'APP-1': record('APP-1', deadPid()), 'APP-2': record('APP-2', deadPid()) });
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 2`);
    // The tick lock of the killed lead is still there.
    deadLock(fx.state, 'tick.lock');

    const t1 = await tick(fx, p.ports);
    expect(t1.json.held).not.toContainEqual({ item: 'tick', reason: 'another tick is running' });
    expect(t1.json.collected).toEqual([
      expect.objectContaining({ item: 'APP-1', status: 'in_review', pr: 7, review: 'APP-3' }),
    ]);
    expect(t1.json.needsLead).toEqual([
      { item: 'APP-2', reason: expect.stringMatching(/requeue/) },
    ]);
    expect(t1.json.launched).toEqual([]);
    expect(statusOf(fx, 'APP-2')?.status).toBe('in_progress');

    const t2 = await tick(fx, p.ports);
    expect(t2.json.collected).toEqual([]);
    expect(t2.json.needsLead).toEqual(t1.json.needsLead);
    // Only the new review item may start (its pull request is not scripted here, so it does not).
    expect(t2.json.launched).toEqual([]);
    expect(statusOf(fx, 'APP-1')?.status).toBe('in_review');
    expect(statusOf(fx, 'APP-2')?.status).toBe('in_progress');
    expect(p.started).toEqual([]);
  });

  it('an assigned item without any crew record goes to the lead, every tick, and nothing starts', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    const p = fakePorts(fakeGh().gh);
    for (let i = 0; i < 2; i++) {
      const t = await tick(fx, p.ports);
      expect(t.json.needsLead).toEqual([
        { item: 'APP-1', reason: expect.stringMatching(/no crew record/) },
      ]);
    }
    expect(p.started).toEqual([]);
  });

  it('a queue run killed between a successful merge and the board update books it, never merges twice', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'queued', pr: 5, approvedHead: HEAD }]);
    const s = { merged: false, merges: 0, killed: false };
    const { gh } = fakeGh((l) => {
      if (l.startsWith('pr update-branch')) return {};
      if (l.startsWith('pr view 5 --repo org/app --json headRefOid,state,mergeable')) {
        return {
          stdout: JSON.stringify({
            headRefOid: HEAD,
            state: s.merged ? 'MERGED' : 'OPEN',
            mergeable: 'MERGEABLE',
          }),
        };
      }
      if (l.startsWith('pr merge')) {
        s.merges++;
        s.merged = true;
        return {};
      }
      if (l.includes('--json mergeCommit')) {
        // The lead dies right after GitHub merged: nothing after this reaches the disk.
        if (!s.killed) {
          s.killed = true;
          throw new Error('killed');
        }
        return { stdout: JSON.stringify({ mergeCommit: { oid: 'c'.repeat(40) } }) };
      }
      if (l.includes('--json commits')) return { stdout: '2026-11-05T08:00:00Z\n' };
      return undefined;
    });
    const p = fakePorts(gh);
    saveQueue(fx.state, {
      pending: [],
      current: { pr: 5, repo: 'org/app', item: 'APP-1', step: 'update' },
      done: [],
    });
    const t1 = await tick(fx, p.ports);
    expect(t1.json.errors).toEqual([{ phase: 'queue run', error: 'killed' }]);
    expect(s.merges).toBe(1);
    expect(loadQueue(fx.state).current).toMatchObject({ item: 'APP-1', step: 'merge' });
    expect(statusOf(fx, 'APP-1')?.status).toBe('queued');
    // A real kill leaves the run lock behind as well.
    deadLock(fx.state, 'queue.run.lock');

    const dry = await cli(fx, p.ports, 'recover', '--dry-run');
    expect(dry.json.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'lock',
          subject: 'queue.run.lock',
          found: expect.stringMatching(/stale/),
        }),
        expect.objectContaining({
          check: 'queue',
          subject: 'APP-1',
          found: expect.stringMatching(/step merge/),
        }),
      ]),
    );

    const t2 = await tick(fx, p.ports);
    expect(t2.json.errors).toEqual([]);
    expect(t2.json.merged).toEqual([{ item: 'APP-1', pr: 5, repo: 'org/app' }]);
    expect(s.merges).toBe(1);
    expect(statusOf(fx, 'APP-1')?.status).toBe('merged');
    expect(loadQueue(fx.state).current).toBeUndefined();

    const t3 = await tick(fx, p.ports);
    expect(changes(t3.json)).toEqual(QUIET);
    expect(s.merges).toBe(1);
  });

  it('a queue run killed after its result was recorded but before the board moved finishes the bookkeeping', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'queued', pr: 5, approvedHead: HEAD }]);
    const { gh, calls } = fakeGh();
    const p = fakePorts(gh);
    saveQueue(fx.state, {
      pending: [],
      done: [
        { pr: 5, repo: 'org/app', item: 'APP-1', result: 'merged', at: '2026-11-05T09:00:00.000Z' },
      ],
    });
    const t1 = await tick(fx, p.ports);
    expect(t1.json.errors).toEqual([]);
    expect(statusOf(fx, 'APP-1')?.status).toBe('merged');
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    const t2 = await tick(fx, p.ports);
    expect(changes(t2.json)).toEqual(QUIET);
  });
});

describe('studio recover', () => {
  it('finds and breaks stale locks of every kind, keeps live ones, and a dry run changes nothing', async () => {
    const fx = makeFx([]);
    const p = fakePorts(fakeGh().gh);
    for (const name of [
      'ci-reruns.lock',
      'queue.run.lock',
      'queue.json.lock',
      'board.lock',
      'costs.lock',
    ]) {
      deadLock(fx.state, name);
    }
    for (const name of ['launch.lock', 'push.lock']) deadLock(fx.owner, name);
    // A pid a reboot gave to another process: alive, but not the holder.
    const t = new Date().toISOString();
    writeFileSync(
      join(fx.owner, 'limits.lock'),
      JSON.stringify({
        pid: process.pid,
        identity: 'before the reboot',
        startedAt: t,
        heartbeat: t,
      }),
    );
    // A live holder, silent for 20 minutes: reported, never broken.
    const live = acquireStateLock(fx.state, 'tick.lock', {
      now: new Date(Date.now() - 20 * 60_000),
      heartbeatStaleMs: 60_000,
    });
    // Leftovers of a cut-short lock break and of a cut-short write.
    writeFileSync(join(fx.state, 'board.lock.0badc0de.stale'), '{}');
    writeFileSync(join(fx.state, `queue.json.${deadPid()}.0.0badc0de.tmp`), '{}');
    // An aside is left alone for a minute (a breaker may be between its rename and its check).
    const soon = fakePorts(fakeGh().gh);
    soon.setNow(Date.now());
    const young = await cli(fx, soon.ports, 'recover', '--dry-run');
    expect(young.json.findings.map((f: { subject: string }) => f.subject)).not.toContain(
      'board.lock.0badc0de.stale',
    );
    p.setNow(Date.now() + 2 * 60_000);

    const before = readdirSync(fx.state).sort();
    const ownerBefore = readdirSync(fx.owner).sort();
    const dry = await cli(fx, p.ports, 'recover', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.json.dryRun).toBe(true);
    const stale = dry.json.findings.filter((f: { found: string }) => f.found.startsWith('stale'));
    expect(stale.map((f: { subject: string }) => f.subject).sort()).toEqual([
      'board.lock',
      'ci-reruns.lock',
      'costs.lock',
      'launch.lock',
      'limits.lock',
      'push.lock',
      'queue.json.lock',
      'queue.run.lock',
    ]);
    expect(dry.json.findings).toContainEqual({
      check: 'lock',
      subject: 'tick.lock',
      found: `held by pid ${process.pid}, silent 22 min, holder alive`,
    });
    expect(dry.json.findings.some((f: { did?: string }) => f.did !== undefined)).toBe(false);
    expect(readdirSync(fx.state).sort()).toEqual(before);
    expect(readdirSync(fx.owner).sort()).toEqual(ownerBefore);

    const real = await cli(fx, p.ports, 'recover');
    expect(real.code).toBe(0);
    const did = real.json.findings.filter((f: { did?: string }) => f.did !== undefined);
    const subjects = did.map((f: { subject: string }) => f.subject).sort();
    expect(subjects.filter((x: string) => !x.endsWith('.tmp'))).toEqual([
      'board.lock',
      'board.lock.0badc0de.stale',
      'ci-reruns.lock',
      'costs.lock',
      'launch.lock',
      'limits.lock',
      'push.lock',
      'queue.json.lock',
      'queue.run.lock',
    ]);
    expect(subjects.filter((x: string) => x.endsWith('.tmp'))).toEqual([
      expect.stringMatching(/^queue\.json\.\d+\.0\.0badc0de\.tmp$/),
    ]);
    expect(readdirSync(fx.state).filter((f) => /\.(lock|stale|tmp)$/.test(f))).toEqual([
      'tick.lock',
    ]);

    const again = await cli(fx, p.ports, 'recover');
    expect(again.json.findings.filter((f: { did?: string }) => f.did !== undefined)).toEqual([]);
    live?.release();
  });

  it('reports interrupted launches and ended crews; the dry run moves nothing, the real run once', async () => {
    const fx = makeFx([
      { id: 'APP-1' },
      { id: 'APP-2', status: 'assigned' },
      { id: 'APP-3', status: 'assigned' },
    ]);
    const p = fakePorts(fakeGh().gh);
    p.live.add(4711);
    writeRecords(fx, {
      'APP-1': record('APP-1', 4711),
      'APP-2': record('APP-2', deadPid()),
      'APP-3': record('APP-3', deadPid()),
    });
    writeReport(fx, 'APP-2', `status: done\nitem: APP-2\npr: 7\nhead_sha: ${HEAD}\ntests_run: 2`);
    const dry = await cli(fx, p.ports, 'recover', '--dry-run');
    expect(dry.json.findings).toEqual(
      expect.arrayContaining([
        { check: 'launch', subject: 'APP-1', found: expect.stringMatching(/ready, but crew/) },
        {
          check: 'crew',
          subject: 'APP-2',
          found: expect.stringMatching(/ended with a report: the next tick collects it/),
        },
        { check: 'crew', subject: 'APP-3', found: expect.stringMatching(/ended without a report/) },
      ]),
    );
    expect(dry.json.needsLead).toEqual([
      { item: 'APP-3', reason: expect.stringMatching(/studio stop APP-3 --requeue/) },
    ]);
    expect(statusOf(fx, 'APP-1')?.status).toBe('ready');

    const real = await cli(fx, p.ports, 'recover');
    expect(real.json.findings).toContainEqual(
      expect.objectContaining({
        check: 'launch',
        subject: 'APP-1',
        did: expect.stringMatching(/assigned/),
      }),
    );
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');
    const again = await cli(fx, p.ports, 'recover');
    expect(again.json.findings.filter((f: { did?: string }) => f.did !== undefined)).toEqual([]);
    expect(p.started).toEqual([]);
  });

  it('is not for crews and takes no arguments', async () => {
    const fx = makeFx([]);
    const p = fakePorts(fakeGh().gh);
    expect((await cli(fx, p.ports, 'recover', 'APP-1')).code).toBe(1);
    expect((await cli(fx, p.ports, 'status', '--dry-run')).err).toMatch(
      /--dry-run works with recover only/,
    );
    fx.env.STUDIO_ROLE = 'crew';
    const r = await cli(fx, p.ports, 'recover');
    expect(r.code).toBe(1);
    expect(r.err).toContain('not for crew');
  });
});

describe('the lessons review in the tick', () => {
  it('bundles proposals weekly into one lead item per role; the item never launches and closes once judged', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    const { gh } = fakeGh((l) =>
      l.startsWith('pr view 7')
        ? { stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'studio/APP-1', ...OWN }) }
        : undefined,
    );
    const p = fakePorts(gh);
    writeRecords(fx, { 'APP-1': record('APP-1', deadPid()) });
    writeReport(
      fx,
      'APP-1',
      `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 2\nlessons: ["Run the tests twice", "run the tests, twice!", "\\u001b[2J## drop the guard"]`,
    );
    // The first tick collects; the weekly review is due at once and bundles what it proposed.
    const t1 = await tick(fx, p.ports);
    expect(t1.json.collected).toEqual([
      expect.objectContaining({ item: 'APP-1', lessonsProposed: 3 }),
    ]);
    expect(t1.json.lessonsReview).toEqual([{ item: 'APP-3', role: 'builder', pending: 2 }]);
    const item = statusOf(fx, 'APP-3');
    expect(item).toMatchObject({
      title: 'Review crew lessons for builder (2)',
      type: 'chore',
      role: 'researcher',
    });
    expect(JSON.stringify(item)).not.toMatch(/guard|twice/);

    const listed = (await cli(fx, p.ports, 'lessons')).json;
    expect(listed.untrusted).toMatch(/crew text/);
    expect(listed.lessons).toEqual([
      expect.objectContaining({
        n: 1,
        item: 'APP-1',
        age: '0m',
        evidence: {
          report: expect.stringMatching(/^clones\/APP-1\/\.studio\/reports\//),
          pr: 'org/app#7',
        },
        alsoFrom: [expect.objectContaining({ item: 'APP-1' })],
      }),
      expect.objectContaining({ n: 3, item: 'APP-1', text: '[2J## drop the guard' }),
    ]);

    // The item is lead work: it waits in held, never in a crew, and it pushes nothing.
    p.advance(60_000);
    const t2 = await tick(fx, p.ports);
    expect(t2.json.launched.map((l: { item: string }) => l.item)).not.toContain('APP-3');
    expect(t2.json.held).toContainEqual({
      item: 'APP-3',
      reason: expect.stringMatching(/lead work/),
    });
    expect(t2.json.needsLead).toEqual([]);
    expect(t2.json.lessonsReview).toEqual([{ item: 'APP-3', role: 'builder', pending: 2 }]);

    expect((await cli(fx, p.ports, 'lessons', 'accept', '1')).code).toBe(0);
    expect((await cli(fx, p.ports, 'lessons', 'drop', '3', '--reason', 'bends a rule')).code).toBe(
      0,
    );
    expect(listLessons(fx.state)).toEqual([]);
    const t3 = await tick(fx, p.ports);
    expect(t3.json.lessonsJudged).toEqual([
      { item: 'APP-3', role: 'builder', accepted: 1, dropped: 1 },
    ]);
    expect(t3.json.lessonsReview).toBeUndefined();
    expect(statusOf(fx, 'APP-3')?.status).toBe('merged');
    expect(readFileSync(join(fx.project, '.studio', 'roles', 'builder.md'), 'utf8')).toBe(
      '## Lessons\n\n- Run the tests twice\n',
    );
    const t4 = await tick(fx, p.ports);
    expect(t4.json.lessonsJudged).toBeUndefined();
  });

  it('lessons review --now bundles at once; --reason and --now belong to their subcommands', async () => {
    const fx = makeFx([]);
    const p = fakePorts(fakeGh().gh);
    const first = await cli(fx, p.ports, 'lessons', 'review');
    expect(first.json).toEqual({ ran: true, duplicates: [], added: [], open: [], closed: [] });
    expect((await cli(fx, p.ports, 'lessons', 'review')).json.ran).toBe(false);
    expect((await cli(fx, p.ports, 'lessons', 'review', '--now')).json.ran).toBe(true);
    expect((await cli(fx, p.ports, 'lessons', 'accept', '1', '--reason', 'x')).err).toMatch(
      /--reason works with lessons drop only/,
    );
    expect((await cli(fx, p.ports, 'lessons', 'list', '--now')).err).toMatch(/--now works with/);
    expect((await cli(fx, p.ports, 'board', '--reason', 'x')).code).toBe(1);
  });
});

describe('races and gaps found in review', () => {
  const queueGh = (s: { merges: number }, onChecks: () => void = () => {}) =>
    fakeGh((l) => {
      if (l.startsWith('pr update-branch')) return {};
      if (l.startsWith('pr view 5 --repo org/app --json headRefOid,state,mergeable')) {
        return {
          stdout: JSON.stringify({
            headRefOid: HEAD,
            state: s.merges > 0 ? 'MERGED' : 'OPEN',
            mergeable: 'MERGEABLE',
          }),
        };
      }
      if (l.startsWith('pr checks')) {
        onChecks();
        return { stdout: JSON.stringify([{ name: 'ci', bucket: 'pass' }]) };
      }
      if (l.startsWith('pr merge')) {
        s.merges++;
        return {};
      }
      if (l.includes('--json mergeCommit')) {
        return { stdout: JSON.stringify({ mergeCommit: { oid: 'c'.repeat(40) } }) };
      }
      if (l.includes('--json commits')) return { stdout: '2026-11-05T08:00:00Z\n' };
      return undefined;
    });

  it('a queue run whose lock another run took over stops before it merges', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'queued', pr: 5, approvedHead: HEAD }]);
    const s = { merges: 0 };
    const { gh } = queueGh(s, () => {
      const t = new Date().toISOString();
      writeFileSync(
        join(fx.state, 'queue.run.lock'),
        JSON.stringify({
          pid: process.pid,
          identity: processIdentity(process.pid),
          startedAt: t,
          heartbeat: t,
          token: 'another run',
        }),
      );
    });
    saveQueue(fx.state, {
      pending: [],
      current: { pr: 5, repo: 'org/app', item: 'APP-1', step: 'checks' },
      done: [],
    });
    const t = await tick(fx, fakePorts(gh).ports);
    expect(t.json.errors).toEqual([
      { phase: 'queue run', error: expect.stringMatching(/taken over by another run/) },
    ]);
    expect(s.merges).toBe(0);
    expect(statusOf(fx, 'APP-1')?.status).toBe('queued');
  });

  it('launch beats its lock before and after the clone', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const p = fakePorts(fakeGh().gh);
    // Each reading of the clock is a second later, so a heartbeat shows as a new time.
    let t = Date.parse('2026-11-05T10:00:00Z');
    p.ports.clock.now = () => {
      t += 1000;
      return new Date(t);
    };
    const seen: { startedAt: string; heartbeat: string }[] = [];
    const real = p.ports.git.run.bind(p.ports.git);
    p.ports.git = {
      run: async (cwd, args, opts) => {
        if (args[0] === 'clone') {
          seen.push(JSON.parse(readFileSync(join(fx.owner, 'launch.lock'), 'utf8')));
        }
        return real(cwd, args, opts);
      },
    };
    expect((await cli(fx, p.ports, 'launch', 'APP-1')).code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(Date.parse(seen[0]?.heartbeat ?? '')).toBeGreaterThan(
      Date.parse(seen[0]?.startedAt ?? ''),
    );
  });

  it('the restart check leaves a launch alone while any launch holds the launch lock', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const p = fakePorts(fakeGh().gh);
    p.live.add(4711);
    writeRecords(fx, { 'APP-1': record('APP-1', 4711) });
    mkdirSync(fx.owner, { recursive: true });
    const launching = acquireStateLock(fx.owner, 'launch.lock', {
      now: new Date(),
      heartbeatStaleMs: 60_000,
    });
    const dry = await cli(fx, p.ports, 'recover', '--dry-run');
    expect(dry.json.findings).toContainEqual({
      check: 'launch',
      subject: 'APP-1',
      found: 'a launch holds the launch lock: left to it',
    });
    const t1 = await tick(fx, p.ports);
    expect(t1.json.recovered).toBeUndefined();
    expect(statusOf(fx, 'APP-1')?.status).toBe('ready');
    expect(p.started).toEqual([]);
    launching?.release();
    const t2 = await tick(fx, p.ports);
    expect(t2.json.recovered).toEqual([
      expect.objectContaining({ check: 'launch', subject: 'APP-1', did: expect.any(String) }),
    ]);
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');
  });

  it('a young record without its start time is a launch still writing it: left alone for 2 minutes', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const p = fakePorts(fakeGh().gh);
    p.live.add(4711);
    const { identity: _i, ...bare } = record('APP-1', 4711, '2026-11-05T09:59:30.000Z');
    writeRecords(fx, { 'APP-1': bare });
    const young = await cli(fx, p.ports, 'recover');
    expect(young.json.findings.filter((f: { check: string }) => f.check === 'launch')).toEqual([]);
    expect(statusOf(fx, 'APP-1')?.status).toBe('ready');
    p.advance(3 * 60_000);
    const later = await cli(fx, p.ports, 'recover');
    expect(later.json.findings).toContainEqual(
      expect.objectContaining({ check: 'launch', subject: 'APP-1', did: expect.any(String) }),
    );
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');
  });

  it('a launch whose item another process already moved to its crew counts as done', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const p = fakePorts(fakeGh().gh);
    const identity = p.ports.claude.identity;
    // Between the record and the board move a restart check elsewhere did the move.
    p.ports.claude.identity = async (pid) => {
      const board = loadBoard(fx.project);
      const moved = transition(board, 'APP-1', 'assigned', 'studio', new Date());
      saveBoard(fx.project, {
        ...moved,
        items: moved.items.map((i) =>
          i.id === 'APP-1' ? { ...i, crew: 'studio-builder-app-1' } : i,
        ),
      });
      return identity(pid);
    };
    const r = await cli(fx, p.ports, 'launch', 'APP-1');
    expect(r.err).not.toMatch(/changed while launching/);
    expect(r.code).toBe(0);
    expect(statusOf(fx, 'APP-1')).toMatchObject({
      status: 'assigned',
      crew: 'studio-builder-app-1',
    });
  });

  it('crew.json changes only under its lock, and an unreadable file is never replaced', () => {
    const fx = makeFx([]);
    writeRecords(fx, { 'APP-1': record('APP-1', 1) });
    const held = acquireStateLock(fx.state, 'crew.lock', {
      now: new Date(),
      heartbeatStaleMs: 60_000,
    });
    expect(() =>
      updateCrewRecords(
        fx.state,
        (all) => {
          delete all['APP-1'];
        },
        { timeoutMs: 50 },
      ),
    ).toThrow(/crew.json is locked/);
    held?.release();
    expect(Object.keys(records(fx))).toEqual(['APP-1']);
    updateCrewRecords(fx.state, (all) => {
      all['APP-2'] = record('APP-2', 2);
    });
    expect(Object.keys(records(fx))).toEqual(['APP-1', 'APP-2']);
    writeFileSync(join(fx.state, 'crew.json'), '{ torn');
    expect(() => updateCrewRecords(fx.state, () => {})).toThrow(/not valid JSON/);
    expect(readFileSync(join(fx.state, 'crew.json'), 'utf8')).toBe('{ torn');
  });

  it('no crew record: a log written lately means look first, an old one means drop it', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    const p = fakePorts(fakeGh().gh);
    p.setNow(Date.now());
    mkdirSync(join(fx.state, 'logs'), { recursive: true });
    const log = join(fx.state, 'logs', 'APP-1.jsonl');
    writeFileSync(log, '{}\n');
    const fresh = await cli(fx, p.ports, 'recover');
    expect(fresh.json.needsLead).toEqual([
      {
        item: 'APP-1',
        reason: expect.stringMatching(/a crew may still run for it; check by hand/),
      },
    ]);
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(log, old, old);
    const stale = await cli(fx, p.ports, 'recover');
    expect(stale.json.needsLead).toEqual([
      { item: 'APP-1', reason: expect.stringMatching(/nothing runs for it; drop it/) },
    ]);
  });

  it('queue add that died between the queue entry and the board move: the item is queued and merged', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'in_review', pr: 5, approvedHead: HEAD }]);
    const s = { merges: 0 };
    const { gh } = queueGh(s);
    saveQueue(fx.state, { pending: [{ pr: 5, repo: 'org/app', item: 'APP-1' }], done: [] });
    const t1 = await tick(fx, fakePorts(gh).ports);
    expect(t1.json.recovered).toEqual([
      {
        check: 'queue',
        subject: 'APP-1',
        found: 'in the merge queue, but the board still says in_review',
        did: 'moved it to queued',
      },
    ]);
    expect(t1.json.errors).toEqual([]);
    expect(t1.json.merged).toEqual([{ item: 'APP-1', pr: 5, repo: 'org/app' }]);
    expect(s.merges).toBe(1);
    expect(statusOf(fx, 'APP-1')?.status).toBe('merged');
    const t2 = await tick(fx, fakePorts(gh).ports);
    expect(changes(t2.json)).toEqual(QUIET);
  });

  it('lessons are stored before the board moves, so a failed move loses none', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    const { gh } = fakeGh((l) =>
      l.startsWith('pr view 7')
        ? { stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'studio/APP-1', ...OWN }) }
        : undefined,
    );
    writeRecords(fx, { 'APP-1': record('APP-1', deadPid()) });
    writeReport(
      fx,
      'APP-1',
      `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 2\nlessons: ["build before test"]`,
    );
    // The board cannot be written: the move fails after the report was read.
    const studio = join(fx.project, '.studio');
    chmodSync(studio, 0o555);
    let r: Awaited<ReturnType<typeof cli>>;
    try {
      r = await cli(fx, fakePorts(gh).ports, 'collect', 'APP-1');
    } finally {
      chmodSync(studio, 0o755);
    }
    expect(r.code).toBe(1);
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');
    expect(listLessons(fx.state).map((l) => l.text)).toEqual(['build before test']);
    // The collect that runs again moves the item and proposes nothing twice.
    const again = await cli(fx, fakePorts(gh).ports, 'collect', 'APP-1');
    expect(again.code).toBe(0);
    expect(listLessons(fx.state)).toHaveLength(1);
  });
});
