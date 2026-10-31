import { execFileSync } from 'node:child_process';
import {
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
import { loadBoard } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { stateRootFor, writeStateFile } from '../src/paths.js';
import type { Claude, Gh, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import { acquireQueueRunLock, enqueue, loadQueue, saveQueue } from '../src/queue.js';
import { computeMetrics, type StateSnapshot, writeState } from '../src/state.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-cli-')));
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
const OTHER = 'b'.repeat(40);
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
  builder: { model: sonnet, wip: 2 }
owner_only: []
deploy_commands: []
`;

interface ItemSpec {
  id: string;
  status?: string;
  type?: string;
  dod?: string[];
  pr?: number;
  ownerOnly?: boolean;
  title?: string;
}

const itemYaml = (s: ItemSpec): string =>
  [
    `  - id: ${s.id}`,
    `    title: ${s.title ?? `Item ${s.id}`}`,
    `    type: ${s.type ?? 'fix'}`,
    '    role: builder',
    '    repo: org/app',
    '    size: S',
    '    priority: 1',
    `    status: ${s.status ?? 'ready'}`,
    '    paths: []',
    `    touches: [${s.id.toLowerCase()}/**]`,
    '    depends_on: []',
    `    dod: [${(s.dod ?? ['tests pass']).map((d) => JSON.stringify(d)).join(', ')}]`,
    ...(s.pr ? [`    pr: ${s.pr}`] : []),
    ...(s.ownerOnly ? ['    owner_only: true'] : []),
    '    history: []',
  ].join('\n');

let n = 0;
interface Fx {
  project: string;
  home: string;
  env: Record<string, string | undefined>;
  state: string;
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
    `items:\n${items.map(itemYaml).join('\n')}\n`,
  );
  const env = { PATH: process.env.PATH };
  return { project, home, env, state: stateRootFor(project, { env, homedir: home }) };
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
      const r = handler(line);
      if (!r) throw new Error(`unscripted gh call: ${line}`);
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
  return { gh, calls };
}

function fakePorts(gh: Gh) {
  const started: { cwd: string; args: string[] }[] = [];
  const stopped: number[] = [];
  const claude: Claude = {
    async start(cwd, args) {
      started.push({ cwd, args });
      return { pid: 4242 };
    },
    alive: (pid) => pid === 4242,
    async stop(pid) {
      stopped.push(pid);
    },
  };
  let t = Date.parse('2026-10-31T10:00:00Z');
  const ports: Ports = {
    gh,
    git: realPorts().git,
    claude,
    clock: {
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
    },
    host: { loadAvg1: () => 0 },
  };
  return { ports, started, stopped };
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
  });
  return { code, out, err };
}

const writeReport = (fx: Fx, id: string, front: string) => {
  const dir = join(fx.state, 'clones', id, '.studio', 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\n${front}\n---\n\nbody\n`);
};

const statusOf = (fx: Fx, id: string) => loadBoard(fx.project).items.find((i) => i.id === id);

describe('studio CLI', () => {
  it('plan prints assignments json', async () => {
    const fx = makeFx([{ id: 'APP-1' }, { id: 'APP-2', dod: [] }]);
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'plan');
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.out);
    expect(plan.assign.map((i: { id: string }) => i.id)).toEqual(['APP-1']);
    expect(plan.blocked).toEqual([{ id: 'APP-2', reason: 'not ready: missing dod' }]);
    expect(plan.deferred).toEqual([]);
  });

  it('launch transitions item to assigned and records crew', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const { gh } = fakeGh();
    const { ports, started } = fakePorts(gh);
    const r = await cli(fx, ports, 'launch', 'APP-1', '--json');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ name: 'studio-builder-app-1', pid: 4242 });
    const item = statusOf(fx, 'APP-1');
    expect(item?.status).toBe('assigned');
    expect(item?.history.at(-1)).toMatchObject({ from: 'ready', to: 'assigned', by: 'studio' });
    const crew = JSON.parse(readFileSync(join(fx.state, 'crew.json'), 'utf8'));
    expect(crew['APP-1']).toMatchObject({ pid: 4242, item: 'APP-1' });
    expect(started).toHaveLength(1);
    // runtime state stays out of the repo
    expect(existsSync(join(fx.project, '.studio', 'crew.json'))).toBe(false);
  });

  it('launch refuses an item not in the plan', async () => {
    const fx = makeFx([
      { id: 'APP-1' },
      { id: 'APP-2', dod: [] },
      { id: 'APP-3', status: 'blocked' },
    ]);
    const { gh } = fakeGh();
    const { ports, started } = fakePorts(gh);
    const blocked = await cli(fx, ports, 'launch', 'APP-2');
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain('not ready: missing dod');
    const notReady = await cli(fx, ports, 'launch', 'APP-3');
    expect(notReady.code).toBe(1);
    expect(notReady.err).toContain('ready');
    const unknown = await cli(fx, ports, 'launch', 'APP-99');
    expect(unknown.code).toBe(1);
    expect(started).toHaveLength(0);
    expect(statusOf(fx, 'APP-2')?.status).toBe('ready');
  });

  it('collect done → in_review with pr', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 12`);
    const { gh, calls } = fakeGh((l) =>
      l.startsWith('pr view 7 --repo org/app')
        ? { stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'studio/APP-1', ...OWN }) }
        : undefined,
    );
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'collect', 'APP-1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const item = statusOf(fx, 'APP-1');
    expect(item?.status).toBe('in_review');
    expect(item?.pr).toBe(7);
    expect(item?.branch).toBe('studio/APP-1');
    expect(item?.history.map((h) => `${h.from}>${h.to}`)).toEqual([
      'assigned>in_progress',
      'in_progress>in_review',
    ]);
    expect(calls.some((c) => c.includes('headRefOid'))).toBe(true);
  });

  it('R80: collect refuses while the crew process is still alive', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    expect((await cli(fx, ports, 'launch', 'APP-1')).code).toBe(0);
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 3`);
    const r = await cli(fx, ports, 'collect', 'APP-1');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/crew .* is still running/);
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');
  });

  it('R80: collect refuses a report older than the crew start', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    writeStateFile(
      fx.state,
      join(fx.state, 'crew.json'),
      JSON.stringify({
        'APP-1': {
          name: 'studio-builder-app-1',
          item: 'APP-1',
          role: 'builder',
          pid: 999999,
          log: join(fx.state, 'logs', 'APP-1.jsonl'),
          startedAt: '2026-10-31T10:00:00.000Z',
        },
      }),
    );
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 3`);
    const file = join(fx.state, 'clones', 'APP-1', '.studio', 'reports', 'APP-1.md');
    const old = new Date('2026-10-31T09:00:00Z');
    utimesSync(file, old, old);
    const { gh } = fakeGh((l) =>
      l.startsWith('pr view 7 --repo org/app')
        ? { stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'studio/APP-1', ...OWN }) }
        : undefined,
    );
    const { ports } = fakePorts(gh);
    const stale = await cli(fx, ports, 'collect', 'APP-1');
    expect(stale.code).toBe(1);
    expect(stale.err).toMatch(/older than the crew run/);
    const fresh = new Date('2026-10-31T10:05:00Z');
    utimesSync(file, fresh, fresh);
    const ok = await cli(fx, ports, 'collect', 'APP-1');
    expect(ok.err).toBe('');
    expect(ok.code).toBe(0);
    expect(statusOf(fx, 'APP-1')?.status).toBe('in_review');
  });

  it('collect review item without pr → merged, verdict in output and notes', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned', type: 'review' }]);
    writeReport(
      fx,
      'APP-1',
      'status: done\nitem: APP-1\nverdict: changes_requested\nreviews: org/app#9',
    );
    const { gh, calls } = fakeGh();
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'collect', 'APP-1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      status: 'merged',
      verdict: 'changes_requested',
      reviews: 'org/app#9',
    });
    const item = statusOf(fx, 'APP-1');
    expect(item?.status).toBe('merged');
    expect(item?.pr).toBeUndefined();
    expect(item?.history.map((h) => `${h.from}>${h.to}`)).toEqual([
      'assigned>in_progress',
      'in_progress>in_review',
      'in_review>merged',
    ]);
    expect(item?.notes?.join(' ')).toContain('changes_requested');
    expect(calls.some((c) => c.startsWith('pr view'))).toBe(false);
  });

  it('collect refuses a done build item without pr', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\nhead_sha: ${HEAD}\ntests_run: 2`);
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    expect((await cli(fx, ports, 'collect', 'APP-1')).code).toBe(1);
  });

  it('collect refuses a report whose head differs from the PR head', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 3`);
    const { gh } = fakeGh(() => ({
      stdout: JSON.stringify({ headRefOid: OTHER, headRefName: 'studio/APP-1', ...OWN }),
    }));
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'collect', 'APP-1');
    expect(r.code).toBe(1);
    expect(r.err).toContain('differs');
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');
  });

  it('collect refuses a PR on another branch or already held by another item', async () => {
    const fx = makeFx([
      { id: 'APP-1', status: 'assigned' },
      { id: 'APP-2', status: 'in_review', pr: 7 },
    ]);
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 3`);
    const { gh } = fakeGh(() => ({
      stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'studio/APP-2', ...OWN }),
    }));
    const { ports } = fakePorts(gh);
    const held = await cli(fx, ports, 'collect', 'APP-1');
    expect(held.code).toBe(1);
    expect(held.err).toContain('already held by APP-2');
    const fx2 = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    writeReport(fx2, 'APP-1', `status: done\nitem: APP-1\npr: 8\nhead_sha: ${HEAD}\ntests_run: 3`);
    const other = await cli(fx2, ports, 'collect', 'APP-1');
    expect(other.code).toBe(1);
    expect(other.err).toContain('expected studio/APP-1');
    expect(statusOf(fx2, 'APP-1')?.status).toBe('assigned');
  });

  it('collect refuses a PR from a fork even with the right branch name', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 3`);
    const { gh } = fakeGh(() => ({
      stdout: JSON.stringify({
        headRefOid: HEAD,
        headRefName: 'studio/APP-1',
        headRepository: { name: 'app' },
        headRepositoryOwner: { login: 'evil' },
        isCrossRepository: true,
      }),
    }));
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'collect', 'APP-1');
    expect(r.code).toBe(1);
    expect(r.err).toContain('does not come from a branch of org/app');
    expect(statusOf(fx, 'APP-1')?.status).toBe('assigned');
  });

  it('collect reads the report once: a swap during the gh call does not change the stored pr', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 3`);
    const { gh } = fakeGh((l) => {
      if (!l.startsWith('pr view 7')) return undefined;
      // the crew rewrites its report while the control room talks to gh
      writeReport(
        fx,
        'APP-1',
        `status: done\nitem: APP-1\npr: 99\nhead_sha: ${HEAD}\ntests_run: 3`,
      );
      return { stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'studio/APP-1', ...OWN }) };
    });
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'collect', 'APP-1');
    expect(r.code).toBe(0);
    expect(statusOf(fx, 'APP-1')?.pr).toBe(7);
  });

  it('a PR number held in another repo does not block collect', async () => {
    const fx = makeFx([
      { id: 'APP-1', status: 'assigned' },
      { id: 'APP-2', status: 'in_review', pr: 7 },
    ]);
    const text = readFileSync(join(fx.project, '.studio', 'board.yaml'), 'utf8');
    writeFileSync(
      join(fx.project, '.studio', 'board.yaml'),
      text.replace(/(id: APP-2[\s\S]*?repo: )org\/app/, '$1org/other'),
    );
    writeReport(fx, 'APP-1', `status: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 3`);
    const { gh } = fakeGh(() => ({
      stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'studio/APP-1', ...OWN }),
    }));
    const { ports } = fakePorts(gh);
    expect((await cli(fx, ports, 'collect', 'APP-1')).code).toBe(0);
  });

  it('collect caps crew-provided notes', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    const qs = Array.from({ length: 15 }, () => `  - ${'x'.repeat(900)}`).join('\n');
    writeReport(fx, 'APP-1', `status: blocked\nitem: APP-1\nquestions:\n${qs}`);
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    expect((await cli(fx, ports, 'collect', 'APP-1')).code).toBe(0);
    const notes = statusOf(fx, 'APP-1')?.notes ?? [];
    expect(notes).toHaveLength(10);
    expect(notes.every((x) => x.length <= 500)).toBe(true);
  });

  it('collect blocked → blocked with question in notes', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'in_progress' }]);
    writeReport(fx, 'APP-1', 'status: blocked\nitem: APP-1\nquestions:\n  - Which API version?');
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'collect', 'APP-1');
    expect(r.code).toBe(0);
    const item = statusOf(fx, 'APP-1');
    expect(item?.status).toBe('blocked');
    expect(item?.notes?.join('\n')).toContain('Which API version?');
  });

  it('collect failed → blocked with a reason note', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'assigned' }]);
    writeReport(fx, 'APP-1', 'status: failed\nitem: APP-1');
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'collect', 'APP-1');
    expect(r.code).toBe(0);
    expect(statusOf(fx, 'APP-1')?.status).toBe('blocked');
    expect(statusOf(fx, 'APP-1')?.notes?.join('\n')).toContain('failed');
  });

  it('state writes atomically', () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const snapshot: StateSnapshot = {
      crew: [],
      queue: { pending: [], done: [] },
      capacity: { ciBusy: 0, ciTotal: 8, hostLoad: 0, ok: true },
      forOwner: [],
      updatedAt: '2026-10-31T10:00:00.000Z',
      metrics: computeMetrics([]),
    };
    writeState(fx.state, snapshot);
    const before = readFileSync(join(fx.state, 'state.json'), 'utf8');
    expect(JSON.parse(before).updatedAt).toBe(snapshot.updatedAt);
    expect(() =>
      writeState(
        fx.state,
        { ...snapshot, updatedAt: 'NEW' },
        {
          writeFile: (path, content) => {
            writeFileSync(path, content.slice(0, 20));
            throw new Error('disk full');
          },
        },
      ),
    ).toThrow('disk full');
    expect(readFileSync(join(fx.state, 'state.json'), 'utf8')).toBe(before);
    expect(readdirSync(fx.state).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('state command writes state.json in the state root with forOwner and metrics', async () => {
    const fx = makeFx([
      { id: 'APP-1', ownerOnly: true, title: 'Rotate keys' },
      { id: 'APP-2', ownerOnly: true, status: 'merged' },
    ]);
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'state');
    expect(r.code).toBe(0);
    const s = JSON.parse(readFileSync(join(fx.state, 'state.json'), 'utf8'));
    expect(s.forOwner).toEqual([{ id: 'APP-1', title: 'Rotate keys' }]);
    expect(s.capacity.ok).toBe(true);
    expect(s.metrics.mergedTotal).toBe(0);
    expect(existsSync(join(fx.project, '.studio', 'state.json'))).toBe(false);
  });

  it('metrics computes lead time and deploys per day from fixture events', () => {
    const m = computeMetrics([
      {
        type: 'merged',
        item: 'APP-1',
        pr: 5,
        at: '2026-10-30T12:00:00Z',
        firstCommitAt: '2026-10-30T08:00:00Z',
      },
      { type: 'merged', item: 'APP-2', pr: 6, at: '2026-10-31T09:00:00Z', firstCommitAt: null },
      {
        type: 'merged',
        item: 'APP-3',
        pr: 7,
        at: '2026-10-31T10:00:00Z',
        firstCommitAt: '2026-10-30T10:00:00Z',
      },
      { type: 'deployed', at: '2026-10-31T11:00:00Z' },
      { type: 'deployed', at: '2026-10-31T23:59:00Z' },
      { type: 'other', at: '2026-10-31T11:00:00Z' },
      'junk',
    ]);
    expect(m.leadTimes.map((l) => [l.item, l.leadTimeHours])).toEqual([
      ['APP-1', 4],
      ['APP-3', 24],
    ]);
    expect(m.medianLeadTimeHours).toBe(14);
    expect(m.perDay).toEqual({
      '2026-10-30': { merged: 1, deployed: 0 },
      '2026-10-31': { merged: 2, deployed: 2 },
    });
    expect(m.mergedTotal).toBe(3);
    expect(m.deployedTotal).toBe(2);
  });

  it('metrics command reads metrics.jsonl from the state root', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    mkdirSync(fx.state, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(fx.state, 'metrics.jsonl'),
      `${JSON.stringify({ type: 'merged', item: 'APP-1', pr: 1, at: '2026-10-30T12:00:00Z', firstCommitAt: '2026-10-30T10:00:00Z' })}\nnot json\n`,
    );
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'metrics');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).leadTimes[0]).toMatchObject({ item: 'APP-1', leadTimeHours: 2 });
  });

  it('queue add then run → item merged', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'in_review', pr: 5 }]);
    const { gh } = fakeGh((l) => {
      if (l.startsWith('pr update-branch')) return {};
      if (l.startsWith('pr view 5 --repo org/app --json headRefOid,state,mergeable')) {
        return {
          stdout: JSON.stringify({ headRefOid: HEAD, state: 'OPEN', mergeable: 'MERGEABLE' }),
        };
      }
      if (l.startsWith('pr checks 5') && l.endsWith('--required')) {
        return { stdout: JSON.stringify([{ name: 'ci', bucket: 'pass' }]) };
      }
      if (l.startsWith('pr checks 5'))
        return { stdout: JSON.stringify([{ name: 'ci', bucket: 'pass' }]) };
      if (l.startsWith('pr merge 5')) return {};
      if (l.startsWith('pr view 5 --repo org/app --json mergeCommit')) {
        return { stdout: JSON.stringify({ mergeCommit: { oid: 'c'.repeat(40) } }) };
      }
      if (l.startsWith('pr view 5 --repo org/app --json commits'))
        return { stdout: '2026-10-30T08:00:00Z\n' };
      return undefined;
    });
    const { ports } = fakePorts(gh);
    const add = await cli(fx, ports, 'queue', 'add', 'org/app#5');
    expect(add.code).toBe(0);
    expect(statusOf(fx, 'APP-1')?.status).toBe('queued');
    const again = await cli(fx, ports, 'queue', 'add', 'org/app#5');
    expect(again.code).toBe(1);
    const run = await cli(fx, ports, 'queue', 'run');
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(statusOf(fx, 'APP-1')?.status).toBe('merged');
    const q = JSON.parse(readFileSync(join(fx.state, 'queue.json'), 'utf8'));
    expect(q.done[0]).toMatchObject({ pr: 5, result: 'merged' });
    expect(readFileSync(join(fx.state, 'metrics.jsonl'), 'utf8')).toContain('"type":"merged"');
  });

  it('queue run: a failed merge sends the item back to in_review with a note', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'in_review', pr: 5 }]);
    const { gh } = fakeGh((l) => {
      if (l.startsWith('pr update-branch')) return {};
      if (l.startsWith('pr view 5')) {
        return {
          stdout: JSON.stringify({ headRefOid: HEAD, state: 'OPEN', mergeable: 'MERGEABLE' }),
        };
      }
      if (l.startsWith('pr checks 5'))
        return { stdout: JSON.stringify([{ name: 'ci', bucket: 'fail' }]) };
      return undefined;
    });
    const { ports } = fakePorts(gh);
    expect((await cli(fx, ports, 'queue', 'add', 'org/app#5')).code).toBe(0);
    const run = await cli(fx, ports, 'queue', 'run');
    expect(run.code).toBe(0);
    const item = statusOf(fx, 'APP-1');
    expect(item?.status).toBe('in_review');
    expect(item?.notes?.join('\n')).toContain('merge failed: check ci failed');
  });

  /** gh for any PR: update, checks, views and merges succeed. */
  const passingGh = (onLine: (line: string) => void = () => {}) =>
    fakeGh((l) => {
      onLine(l);
      if (l.startsWith('pr update-branch')) return {};
      if (/^pr view \d+ --repo org\/app --json headRefOid,state,mergeable/.test(l)) {
        return {
          stdout: JSON.stringify({ headRefOid: HEAD, state: 'OPEN', mergeable: 'MERGEABLE' }),
        };
      }
      if (l.startsWith('pr checks')) {
        return { stdout: JSON.stringify([{ name: 'ci', bucket: 'pass' }]) };
      }
      if (l.startsWith('pr merge')) return {};
      if (l.includes('--json mergeCommit')) {
        return { stdout: JSON.stringify({ mergeCommit: { oid: 'c'.repeat(40) } }) };
      }
      if (l.includes('--json commits')) return { stdout: '2026-10-30T08:00:00Z\n' };
      return undefined;
    });

  it('R79: a second queue run exits 1 while the run lock is held', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'in_review', pr: 5 }]);
    const { ports } = fakePorts(passingGh().gh);
    expect((await cli(fx, ports, 'queue', 'add', 'org/app#5')).code).toBe(0);
    const lock = acquireQueueRunLock(fx.state, new Date(), () => {});
    const run = await cli(fx, ports, 'queue', 'run');
    expect(run.code).toBe(1);
    expect(run.err).toContain('queue already running');
    expect(statusOf(fx, 'APP-1')?.status).toBe('queued');
    lock.release();
    expect((await cli(fx, ports, 'queue', 'run')).code).toBe(0);
    expect(statusOf(fx, 'APP-1')?.status).toBe('merged');
    expect(existsSync(join(fx.state, 'queue.run.lock'))).toBe(false);
  });

  it('R79: the board moves right after each entry, and an entry added mid-run is merged', async () => {
    const fx = makeFx([
      { id: 'APP-1', status: 'in_review', pr: 5 },
      { id: 'APP-2', status: 'queued', pr: 6 },
    ]);
    let firstAtSecondMerge: string | undefined;
    let added = false;
    const { gh } = passingGh((l) => {
      if (l.startsWith('pr merge 5') && !added) {
        added = true;
        enqueue(fx.state, { pr: 6, repo: 'org/app', item: 'APP-2' });
      }
      if (l.startsWith('pr merge 6')) firstAtSecondMerge = statusOf(fx, 'APP-1')?.status;
    });
    const { ports } = fakePorts(gh);
    expect((await cli(fx, ports, 'queue', 'add', 'org/app#5')).code).toBe(0);
    const run = await cli(fx, ports, 'queue', 'run');
    expect(run.code).toBe(0);
    expect(firstAtSecondMerge).toBe('merged');
    expect(statusOf(fx, 'APP-1')?.status).toBe('merged');
    expect(statusOf(fx, 'APP-2')?.status).toBe('merged');
    expect(JSON.parse(run.out).merged).toBe(2);
  });

  it('R79: queue run first reconciles queued items with finished queue entries', async () => {
    const fx = makeFx([
      { id: 'APP-1', status: 'in_review', pr: 5 },
      { id: 'APP-2', status: 'in_review', pr: 6 },
    ]);
    const { ports } = fakePorts(fakeGh().gh);
    expect((await cli(fx, ports, 'queue', 'add', 'org/app#5')).code).toBe(0);
    expect((await cli(fx, ports, 'queue', 'add', 'org/app#6')).code).toBe(0);
    // A run that died after recording both results but before moving the board.
    saveQueue(fx.state, {
      pending: [],
      done: [
        { pr: 5, repo: 'org/app', item: 'APP-1', result: 'merged', at: '2026-10-31T09:00:00Z' },
        {
          pr: 6,
          repo: 'org/app',
          item: 'APP-2',
          result: 'failed',
          reason: 'check ci failed',
          at: '2026-10-31T09:01:00Z',
        },
      ],
    });
    const run = await cli(fx, ports, 'queue', 'run');
    expect(run.code).toBe(0);
    expect(statusOf(fx, 'APP-1')?.status).toBe('merged');
    expect(statusOf(fx, 'APP-2')?.status).toBe('in_review');
    expect(statusOf(fx, 'APP-2')?.notes?.join('\n')).toContain('merge failed: check ci failed');
  });

  it('R79: reconcile leaves a re-queued item alone while it is pending again', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'in_review', pr: 5 }]);
    const { ports } = fakePorts(passingGh().gh);
    expect((await cli(fx, ports, 'queue', 'add', 'org/app#5')).code).toBe(0);
    const q = loadQueue(fx.state);
    q.done.push({
      pr: 5,
      repo: 'org/app',
      item: 'APP-1',
      result: 'failed',
      reason: 'old failure',
      at: '2026-10-30T09:00:00Z',
    });
    saveQueue(fx.state, q);
    const run = await cli(fx, ports, 'queue', 'run');
    expect(run.code).toBe(0);
    expect(statusOf(fx, 'APP-1')?.status).toBe('merged');
    expect(statusOf(fx, 'APP-1')?.notes ?? []).not.toContain('merge failed: old failure');
  });

  it('merge.strategy native-queue: queue add and run refuse until stage (d), with a warning', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'in_review', pr: 5 }]);
    writeFileSync(
      join(fx.project, '.studio', 'studio.yaml'),
      STUDIO_YAML.replace('strategy: studio-queue', 'strategy: native-queue'),
    );
    const { gh, calls } = fakeGh();
    const { ports } = fakePorts(gh);
    const add = await cli(fx, ports, 'queue', 'add', 'org/app#5');
    expect(add.code).toBe(1);
    expect(add.err).toMatch(/native-queue/);
    const run = await cli(fx, ports, 'queue', 'run');
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/native-queue is not supported yet/);
    expect(run.err).toMatch(/warning: .*native-queue/);
    expect(calls).toEqual([]);
    expect(statusOf(fx, 'APP-1')?.status).toBe('in_review');
  });

  it('queue add refuses a PR that is not on the board in review', async () => {
    const fx = makeFx([{ id: 'APP-1', status: 'in_progress', pr: 5 }]);
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    expect((await cli(fx, ports, 'queue', 'add', 'org/app#5')).code).toBe(1);
    expect((await cli(fx, ports, 'queue', 'add', 'org/app#9')).code).toBe(1);
    expect((await cli(fx, ports, 'queue', 'add', 'nonsense')).code).toBe(1);
  });

  it('status lists crew with liveness; stop signals the pid and records stoppedAt', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const { gh } = fakeGh();
    const { ports, stopped } = fakePorts(gh);
    expect((await cli(fx, ports, 'launch', 'APP-1')).code).toBe(0);
    const st = await cli(fx, ports, 'status', '--json');
    expect(JSON.parse(st.out)).toEqual([
      expect.objectContaining({ item: 'APP-1', pid: 4242, alive: true, status: 'assigned' }),
    ]);
    const stop = await cli(fx, ports, 'stop', 'APP-1');
    expect(stop.code).toBe(0);
    expect(stopped).toEqual([4242]);
    const crew = JSON.parse(readFileSync(join(fx.state, 'crew.json'), 'utf8'));
    expect(typeof crew['APP-1'].stoppedAt).toBe('string');
    expect((await cli(fx, ports, 'stop', 'APP-7')).code).toBe(1);
  });

  it('board prints a table or json', async () => {
    const fx = makeFx([{ id: 'APP-1', title: 'Hello' }]);
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    const t = await cli(fx, ports, 'board');
    expect(t.out).toMatch(/APP-1\s+ready\s+builder\s+fix\s+1\s+Hello/);
    const j = await cli(fx, ports, 'board', '--json');
    expect(JSON.parse(j.out)[0]).toMatchObject({ id: 'APP-1', status: 'ready' });
  });

  it('unknown command exits 1', async () => {
    const fx = makeFx([{ id: 'APP-1' }]);
    const { gh } = fakeGh();
    const { ports } = fakePorts(gh);
    const r = await cli(fx, ports, 'frobnicate');
    expect(r.code).toBe(1);
    expect(r.err).toContain('Usage');
    expect((await cli(fx, ports)).code).toBe(1);
    const bad = await cli(fx, ports, 'board', '--nope');
    expect(bad.code).toBe(1);
  });
});
