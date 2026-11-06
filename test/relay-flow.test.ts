// A lead and a relay worker that share nothing but the SSH session the lead opens (here a fake that
// hands each request to the worker's `relay serve` in-process). The worker holds no credential:
// code comes in as a bundle, the crew's Claude token in the start, and the result goes back as a
// report and a bundle, which the lead checks, pushes with its crew token and opens the pull request
// for, as for a local crew.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard, type WorkItem } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { stateRootFor } from '../src/paths.js';
import { pinnedPlugins } from '../src/plugins.js';
import type { Claude, Gh, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import { relayContext } from '../src/relay-command.js';
import { readRelay } from '../src/relay-lead.js';
import { encodeMessage, LineReader, MAX_HEADER_BYTES, readMessage } from '../src/relay-protocol.js';
import {
  projectDir,
  type RelayContext,
  readJob,
  runRelayJob,
  serveRelay,
} from '../src/relay-serve.js';
import { type RelayTransport, RelayUnreachable } from '../src/relay-transport.js';
import { reportName } from '../src/report.js';
import { workerItemFields } from '../src/worker-claim.js';
import type { WorkerPlatform } from '../src/worker-deny.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-')));
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
const HOST_KEY = `ssh-ed25519 ${'A'.repeat(68)}`;
// Built from parts: the repository's own secret scan must not see a token shape here.
const CLAUDE_TOKEN = ['sk-ant-', 'oat01-', 'x'.repeat(40)].join('');
const CREW_TOKEN = ['ctok', 'en', '-for-the-lead-crew-0001'].join('');

const studioYaml = `studio: 1
primary_repo: org/app
repos: [org/app]
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
    runs_on: lab
    depends_on: []
    dod: [a test covers it]
    history: []`;

let n = 0;

interface Machine {
  home: string;
  env: Record<string, string | undefined>;
}

interface World {
  base: string;
  origin: string;
  project: string;
  lead: Machine;
  worker: Machine;
  now: { t: number };
  crew: {
    started: { cwd: string; env: Record<string, string> }[];
    running: boolean;
    stopped: number[];
  };
  reachable: { ok: boolean };
  ctx: RelayContext;
  requests: string[];
}

function claudePort(w: Pick<World, 'crew'>): Claude {
  return {
    async start(cwd, _args, _prompt, _log, env) {
      w.crew.started.push({ cwd, env });
      w.crew.running = true;
      return { pid: 4242 };
    },
    alive: () => w.crew.running,
    identity: async () => 'start-4242',
    async stop(pid) {
      w.crew.stopped.push(pid);
      w.crew.running = false;
    },
  };
}

function portsFor(w: Pick<World, 'now' | 'crew'>, gh: Gh): Ports {
  return {
    gh,
    git: realPorts().git,
    credentials: realPorts().credentials,
    claude: claudePort(w),
    clock: {
      now: () => new Date(w.now.t),
      sleep: async (ms) => {
        w.now.t += ms;
      },
    },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
}

const HEADS: Record<string, string> = {};

/** The lead's gh: the pull request it opens from the pushed branch, and green checks. */
function leadGh(w: { origin: string }): { gh: Gh; calls: string[] } {
  const calls: string[] = [];
  const gh: Gh = {
    async api(path) {
      calls.push(`api ${path}`);
      return '0';
    },
    async run(args) {
      const line = args.join(' ');
      calls.push(line);
      if (line.startsWith('pr list --repo org/app --head studio/APP-1')) {
        return { code: 0, stdout: '[]', stderr: '' };
      }
      if (line.startsWith('pr create --repo org/app --head studio/APP-1')) {
        return { code: 0, stdout: 'https://github.com/org/app/pull/7\n', stderr: '' };
      }
      if (/^pr view 7 --repo org\/app --json headRefOid,headRefName/.test(line)) {
        const head = git(w.origin, 'rev-parse', 'refs/heads/studio/APP-1');
        HEADS.pr = head;
        return {
          code: 0,
          stdout: JSON.stringify({
            headRefOid: head,
            headRefName: 'studio/APP-1',
            headRepository: { name: 'app' },
            headRepositoryOwner: { login: 'org' },
            isCrossRepository: false,
          }),
          stderr: '',
        };
      }
      if (line.startsWith('pr checks')) {
        return { code: 0, stdout: JSON.stringify([{ name: 'ci', bucket: 'pass' }]), stderr: '' };
      }
      if (line.endsWith('--json baseRefName')) {
        return { code: 0, stdout: JSON.stringify({ baseRefName: 'main' }), stderr: '' };
      }
      return { code: 1, stdout: '', stderr: `unscripted gh call: ${line}` };
    },
  };
  return { gh, calls };
}

function world(): World {
  const base = join(root, `w${n++}`);
  mkdirSync(base);
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = join(base, 'lead');
  git(base, 'clone', '-q', origin, project);
  git(project, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(project, '.studio', 'roles'), { recursive: true });
  writeFileSync(join(project, '.studio', 'studio.yaml'), studioYaml);
  writeFileSync(join(project, '.studio', 'board.yaml'), `items:\n${ITEM}\n`);
  writeFileSync(join(project, '.studio', 'roles', 'builder.md'), 'Role text from main.\n');
  writeFileSync(join(project, 'AGENTS.md'), 'Project rules from main.\n');
  git(
    project,
    'add',
    '.studio/studio.yaml',
    '.studio/board.yaml',
    '.studio/roles/builder.md',
    'AGENTS.md',
  );
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  // The lead: its relay worker, its crew token, a Claude token for crews.
  const leadHome = join(base, 'lead-home');
  const leadCfg = join(leadHome, '.config', 'studio');
  mkdirSync(leadCfg, { recursive: true });
  writeFileSync(
    join(leadCfg, 'config.yaml'),
    `workers:\n  relay:\n    lab: { host: worker.example, host_key: "${HOST_KEY}", identity_file: /nonexistent/key }\n`,
  );
  writeFileSync(join(leadCfg, 'crew-token'), `${CREW_TOKEN}\n`);
  chmodSync(join(leadCfg, 'crew-token'), 0o600);
  // The worker: no owner config at all, the pinned plugins in its crew config dir, no credential.
  const workerHome = join(base, 'worker-home');
  const claude = join(workerHome, '.config', 'studio', 'claude');
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
  const w = {
    base,
    origin,
    project,
    lead: {
      home: leadHome,
      env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN },
    },
    worker: { home: workerHome, env: { PATH: process.env.PATH } },
    now: { t: Date.parse('2026-11-06T10:00:00Z') },
    crew: { started: [], running: false, stopped: [] },
    reachable: { ok: true },
    requests: [],
  } as unknown as World;
  const ports = portsFor(w, leadGh(w).gh);
  w.ctx = relayContext({
    owner: { env: w.worker.env, homedir: workerHome },
    home: undefined,
    lead: 'default',
    ports,
    env: w.worker.env,
    homedir: workerHome,
    platform: LINUX,
    load: async () => ({ cpuPercent: 10, freeDiskGb: 100 }),
    // The runner, in-process: it takes the spec and starts the crew before the start answers.
    spawnRunner: async ({ id, spec }) => {
      await runRelayJob(w.ctx, id, spec);
      return { pid: process.pid };
    },
    log: () => {},
  });
  return w;
}

async function* chunks(lines: Iterable<string>): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

/** SSH, faked: the request goes to the worker's `relay serve` as bytes and comes back as bytes. */
function transport(w: World): RelayTransport {
  return {
    async call(header, payload, opts) {
      if (!w.reachable.ok)
        throw new RelayUnreachable('cannot reach the relay worker lab (ssh exit 255)');
      const request = [...encodeMessage(header, payload)];
      w.requests.push(request[0] as string);
      let out = '';
      await serveRelay(w.ctx, chunks(request), (s) => {
        out += s;
      });
      const msg = await readMessage(
        new LineReader(chunks([out]), MAX_HEADER_BYTES),
        opts.maxPayload,
      );
      if (msg === undefined) throw new RelayUnreachable('no answer');
      return msg;
    },
  };
}

async function lead(w: World, argv: string[], gh = leadGh(w)) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', w.project, ...argv], {
    ports: portsFor(w, gh.gh),
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: w.lead.env,
    homedir: w.lead.home,
    cwd: w.project,
    relayTransport: () => transport(w),
    workerPushUrl: () => w.origin,
  });
  return { code, out, err, calls: gh.calls };
}

const workerState = (w: World) =>
  stateRootFor(
    projectDir(
      { owner: { env: w.worker.env, homedir: w.worker.home }, lead: 'default' },
      'org/app',
    ),
    {
      env: w.worker.env,
      homedir: w.worker.home,
    },
  );

/** What the crew leaves on the worker: a commit on studio/APP-1 and its report. */
function crewFinishes(w: World, o: { report?: (head: string) => string } = {}): string {
  const st = workerState(w);
  const clone = join(st, 'clones', 'APP-1');
  writeFileSync(join(clone, 'log.txt'), 'parsed\n');
  git(clone, 'add', 'log.txt');
  git(clone, 'commit', '-q', '-m', 'parse the device log');
  const head = git(clone, 'rev-parse', 'HEAD');
  const name = reportName(st, 'APP-1');
  if (name === undefined) throw new Error('no report name');
  mkdirSync(join(clone, '.studio', 'reports'), { recursive: true });
  writeFileSync(join(clone, '.studio', 'reports', name), (o.report ?? defaultReport)(head));
  writeFileSync(
    join(st, 'logs', 'APP-1.jsonl'),
    `${JSON.stringify({ type: 'result', total_cost_usd: 0.42, modelUsage: { sonnet: { inputTokens: 100, outputTokens: 20, costUSD: 0.42 } } })}\n`,
  );
  w.crew.running = false;
  return head;
}

const defaultReport = (head: string) =>
  `---\nstatus: done\nitem: APP-1\npr_title: "APP-1: parse the device log"\nhead_sha: ${head}\ntests_run: 3\nnot_run_here: []\nlessons: []\nquestions: []\n---\n\nParsed the log; a test covers it.\n`;

const statusOf = (w: World) => loadBoard(w.project).items.find((i) => i.id === 'APP-1');
const leadState = (w: World) => stateRootFor(w.project, { env: w.lead.env, homedir: w.lead.home });

describe('relay workers', () => {
  it('start, run, result, push, pull request: the lead does everything on GitHub', async () => {
    const w = world();
    const t1 = await lead(w, ['tick']);
    const tick1 = JSON.parse(t1.out);
    expect(tick1.relayed).toEqual([{ item: 'APP-1', label: 'lab' }]);
    expect(tick1.offered).toBeUndefined();
    expect(statusOf(w)).toMatchObject({ status: 'assigned', crew: 'worker:lab' });
    // The worker's crew got the lead's Claude token, and no GitHub token at all.
    expect(w.crew.started).toHaveLength(1);
    const env = w.crew.started[0]?.env ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_TOKEN);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(CREW_TOKEN);
    // The worker's brief comes from the pinned commit; it commits only, Studio opens the PR.
    const st = workerState(w);
    const brief = readFileSync(join(st, 'briefs', 'APP-1.md'), 'utf8');
    expect(brief).toContain('Read the device log');
    expect(brief).toContain('pr_title:');
    // The token is in no file of the worker or the lead.
    for (const dir of [w.worker.home, w.lead.home]) {
      expect(grep(dir, CLAUDE_TOKEN), dir).toEqual([]);
    }
    // Every request names the protocol; the start carried the job, nothing else asked for a token.
    expect(w.requests.filter((r) => r.includes('"token"'))).toHaveLength(1);

    // The lead follows the job: the crew runs.
    const tick2 = JSON.parse((await lead(w, ['tick'])).out);
    expect(statusOf(w)?.status).toBe('in_progress');
    expect(tick2.held).toContainEqual({ item: 'APP-1', reason: 'worker: relay lab, crew running' });
    const state = JSON.parse((await lead(w, ['state'])).out);
    expect(state.items.find((i: { id: string }) => i.id === 'APP-1').wait).toMatchObject({
      code: 'worker',
      reason: { code: 'relay_on', params: { label: 'lab' } },
    });

    // The crew ends; the lead takes the result, pushes the branch and opens the pull request.
    const head = crewFinishes(w);
    const t3 = await lead(w, ['tick']);
    const tick3 = JSON.parse(t3.out);
    expect(tick3.errors ?? []).toEqual([]);
    expect(tick3.collected.map((c: { item: string }) => c.item)).toContain('APP-1');
    expect(git(w.origin, 'rev-parse', 'refs/heads/studio/APP-1')).toBe(head);
    expect(t3.calls.some((c) => c.startsWith('pr create --repo org/app --head studio/APP-1'))).toBe(
      true,
    );
    expect(statusOf(w)).toMatchObject({ status: 'in_review', pr: 7 });
    // The worker cleaned up; the lead forgot the job.
    expect(
      readJob({ owner: { env: w.worker.env, homedir: w.worker.home }, lead: 'default' }, 'APP-1'),
    ).toBeUndefined();
    expect(existsSync(join(st, 'clones', 'APP-1'))).toBe(false);
    expect(readRelay(leadState(w)).items).toEqual({});
    // The run counts in the day's ledger.
    const costs = JSON.parse(readFileSync(join(leadState(w), 'costs.json'), 'utf8'));
    expect(JSON.stringify(costs)).toContain('APP-1@');
  });

  it('a worker out of reach holds the item, and past its grace goes to the lead, never elsewhere', async () => {
    const w = world();
    await lead(w, ['tick']);
    w.reachable.ok = false;
    const t = JSON.parse((await lead(w, ['tick'])).out);
    expect(t.held).toContainEqual({
      item: 'APP-1',
      reason: 'worker: relay lab, unreachable for 0 min',
    });
    w.now.t += 31 * 60_000;
    const late = JSON.parse((await lead(w, ['tick'])).out);
    expect(late.needsLead.find((x: { item: string }) => x.item === 'APP-1')?.reason).toMatch(
      /has not answered for 3\d min/,
    );
    expect(w.crew.started).toHaveLength(1);
  });

  it('a busy or loaded worker holds the start: nothing is sent, nothing is counted', async () => {
    const w = world();
    w.ctx = { ...w.ctx, load: async () => ({ cpuPercent: 99, freeDiskGb: 100 }) };
    const t = JSON.parse((await lead(w, ['tick'])).out);
    expect(t.held).toContainEqual({
      item: 'APP-1',
      reason: 'worker: relay lab, this machine is busy (CPU 99 %, limit 75 %)',
    });
    expect(w.requests.some((r) => r.includes('"start"'))).toBe(false);
    expect(statusOf(w)?.status).toBe('ready');
  });

  it('refuses a result that is not studio/<id> on top of the pinned commit, and pushes nothing', async () => {
    const w = world();
    await lead(w, ['tick']);
    await lead(w, ['tick']);
    // The crew reports a head that is not what its branch holds.
    crewFinishes(w, { report: () => defaultReport('d'.repeat(40)) });
    const t = JSON.parse((await lead(w, ['tick'])).out);
    expect(t.needsLead.find((x: { item: string }) => x.item === 'APP-1')?.reason).toMatch(
      /the branch in the clone differs from the report/,
    );
    expect(statusOf(w)?.status).toBe('blocked');
    expect(() => git(w.origin, 'rev-parse', '--verify', 'refs/heads/studio/APP-1')).toThrow();
  });

  it('a report that looks like it holds a credential is not used', async () => {
    const w = world();
    await lead(w, ['tick']);
    crewFinishes(w, {
      report: (head) => defaultReport(head).replace('Parsed the log', `Parsed ${CLAUDE_TOKEN}`),
    });
    const t = JSON.parse((await lead(w, ['tick'])).out);
    expect(t.needsLead.find((x: { item: string }) => x.item === 'APP-1')?.reason).toMatch(
      /looks like it holds a credential/,
    );
    expect(() => git(w.origin, 'rev-parse', '--verify', 'refs/heads/studio/APP-1')).toThrow();
  });

  it('stop sends stop and cleanup; --requeue gives the item its relaunch', async () => {
    const w = world();
    await lead(w, ['tick']);
    const r = await lead(w, ['stop', 'APP-1', '--requeue']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ item: 'APP-1', status: 'ready' });
    expect(w.crew.stopped).toEqual([4242]);
    expect(w.requests.map((q) => JSON.parse(q).op)).toEqual(
      expect.arrayContaining(['stop', 'cleanup']),
    );
    expect(readRelay(leadState(w)).items).toEqual({});
  });

  it('a worker that holds a credential refuses to start anything', async () => {
    const w = world();
    const cfg = join(w.worker.home, '.config', 'studio');
    writeFileSync(join(cfg, 'crew-token'), `${CREW_TOKEN}\n`);
    chmodSync(join(cfg, 'crew-token'), 0o600);
    const t = JSON.parse((await lead(w, ['tick'])).out);
    expect(JSON.stringify(t)).toMatch(/a relay worker holds no credential/);
    expect(w.crew.started).toHaveLength(0);
  });

  it('the worker takes only main and the job branch from a bundle, and one crew at a time', async () => {
    const w = world();
    const sha = git(w.project, 'rev-parse', 'HEAD');
    const item = workerItemFields(statusOf(w) as WorkItem);
    const start = async (id: string, refs: string[]) => {
      const f = join(w.base, `${id}.bundle`);
      git(w.project, 'bundle', 'create', '-q', f, ...refs);
      const got = await transport(w).call(
        {
          studioRelay: 1,
          op: 'start',
          job: {
            id,
            label: 'lab',
            repo: 'org/app',
            sha,
            from: 'main',
            item: { ...item, id },
            token: CLAUDE_TOKEN,
          },
        },
        readFileSync(f),
        { maxPayload: 0, timeoutMs: 60_000 },
      );
      return got.header;
    };
    git(w.project, 'branch', 'extra');
    expect(await start('APP-1', ['main', 'extra'])).toMatchObject({
      ok: false,
      line: expect.stringMatching(/other refs than the job names/),
    });
    expect(w.crew.started).toHaveLength(0);
    expect(await start('APP-1', ['main'])).toMatchObject({ ok: true, state: 'starting' });
    expect(await start('APP-2', ['main'])).toMatchObject({
      ok: false,
      kind: 'held',
      line: expect.stringMatching(/runs APP-1: one crew at a time/),
    });
    expect(w.crew.started).toHaveLength(1);
  });

  it('another lead sees nothing of a job: no state, no collect, no stop, and busy without a name', async () => {
    const w = world();
    await lead(w, ['tick']);
    const other = { ...w.ctx, lead: 'other' };
    const ask = async (header: Record<string, unknown>) => {
      let out = '';
      await serveRelay(other, chunks([...encodeMessage({ studioRelay: 1, ...header })]), (s) => {
        out += s;
      });
      return (await readMessage(new LineReader(chunks([out]), MAX_HEADER_BYTES), 0))?.header;
    };
    expect(await ask({ op: 'status', id: 'APP-1' })).toMatchObject({ ok: true, state: 'unknown' });
    expect(await ask({ op: 'collect', id: 'APP-1' })).toMatchObject({ ok: false, kind: 'refused' });
    expect(await ask({ op: 'stop', id: 'APP-1' })).toMatchObject({ ok: true });
    expect(w.crew.stopped).toEqual([]);
    expect(await ask({ op: 'hello' })).toMatchObject({
      ok: true,
      busy: null,
      held: "this machine runs another lead's job: one crew at a time on a relay worker",
    });
  });

  it('a block the worker reports parks the handed-over label for a while, never a global block', async () => {
    const w = world();
    await lead(w, ['tick']);
    crewFinishes(w);
    const st = workerState(w);
    writeFileSync(
      join(st, 'logs', 'APP-1.jsonl'),
      `${JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'account_on_hold' })}\n`,
    );
    const t = JSON.parse((await lead(w, ['tick'])).out);
    expect(t.needsLead.find((x: { item: string }) => x.item === 'APP-1')?.reason).toMatch(
      /reports an account block of default; that label is parked for an hour/,
    );
    const owner = join(w.lead.home, '.local', 'state', 'studio', 'owner');
    expect(existsSync(join(owner, 'blocks.json'))).toBe(false);
    const limits = JSON.parse(readFileSync(join(owner, 'limits.json'), 'utf8'));
    expect(Date.parse(limits.default.parkedUntil) - w.now.t).toBeLessThanOrEqual(
      60 * 60_000 + 1000,
    );
  });

  it("a broken object in the crew's clone stops the result before any bundle", async () => {
    const w = world();
    await lead(w, ['tick']);
    const head = crewFinishes(w);
    const clone = join(workerState(w), 'clones', 'APP-1');
    const loose = join(clone, '.git', 'objects', head.slice(0, 2), head.slice(2));
    rmSync(loose);
    writeFileSync(loose, Buffer.from('not an object at all'));
    const t = JSON.parse((await lead(w, ['tick'])).out);
    expect(t.needsLead.find((x: { item: string }) => x.item === 'APP-1')?.reason).toMatch(
      /do not check out/,
    );
    expect(() => git(w.origin, 'rev-parse', '--verify', 'refs/heads/studio/APP-1')).toThrow();
  });

  it('collect waits until the broker proves no process of the crew user is left', async () => {
    const w = world();
    await lead(w, ['tick']);
    crewFinishes(w);
    let swept = 0;
    w.ctx = {
      ...w.ctx,
      windows: {
        check: async () => ({ warnings: [] }),
        launch: async () => {
          throw new Error('unused');
        },
        claude: () => portsFor(w, leadGh(w).gh).claude,
        sweep: async () => {
          swept += 1;
          throw new Error('processes of the crew user are still running (77)');
        },
      },
    };
    const t = JSON.parse((await lead(w, ['tick'])).out);
    expect(swept).toBe(1);
    expect(t.held).toContainEqual({
      item: 'APP-1',
      reason: expect.stringContaining("the crew user's processes are not proven gone"),
    });
    expect(statusOf(w)?.status).not.toBe('in_review');
    expect(() => git(w.origin, 'rev-parse', '--verify', 'refs/heads/studio/APP-1')).toThrow();
  });

  it('doctor names the relay worker, its versions and its load', async () => {
    const w = world();
    const r = await lead(w, ['doctor']);
    expect(r.out).toMatch(/relay lab: reachable, Studio \S+ on linux/);
    expect(r.out).toMatch(/relay lab: CPU 10 %, 100\.0 GB free/);
  });
});

/** Files below `dir` that hold `text`. */
function grep(dir: string, text: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'objects') walk(p);
      } else if (e.isFile()) {
        try {
          if (readFileSync(p, 'utf8').includes(text)) hits.push(p);
        } catch {}
      }
    }
  };
  walk(dir);
  return hits;
}
