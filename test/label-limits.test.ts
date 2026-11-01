import { execFileSync } from 'node:child_process';
import {
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
import { type CliDeps, runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { launchCrew } from '../src/crew.js';
import { stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-label-limits-')));
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
merge: { strategy: studio-queue, contract_paths: [], method: squash }
roles:
  builder: { model: sonnet, wip: 8 }
owner_only: []
deploy_commands: []
`;
const itemYaml = (id: string) =>
  `  - { id: ${id}, title: Item ${id}, type: fix, role: builder, repo: org/app, size: S, priority: 1, status: ready, paths: [], touches: [${id.toLowerCase()}/**], depends_on: [], dod: [tests pass], history: [] }`;

let n = 0;
function makeFx(ids: string[]) {
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
    `items:\n${ids.map(itemYaml).join('\n')}\n`,
  );
  const env: Record<string, string | undefined> = { PATH: process.env.PATH };
  const ownerDir = join(home, '.config', 'studio');
  return { project, home, env, ownerDir, state: stateRootFor(project, { env, homedir: home }) };
}
type Fx = ReturnType<typeof makeFx>;

function makePorts() {
  const real = realPorts();
  const alive = new Set<number>();
  const started: { args: string[]; env: Record<string, string> }[] = [];
  let pid = 5000;
  let t = Date.parse('2026-11-01T10:00:00Z');
  const claude: Ports['claude'] = {
    async start(_cwd, args, _prompt, logPath, env) {
      started.push({ args, env });
      pid += 1;
      alive.add(pid);
      writeFileSync(logPath, '', { flag: 'a' });
      return { pid };
    },
    alive: (p) => alive.has(p),
    identity: async (p) => `start-${p}`,
    async stop(p) {
      alive.delete(p);
    },
  };
  const ports: Ports = {
    ...real,
    gh: { api: async () => '0', run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    claude,
    clock: { now: () => new Date(t), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
  return {
    ports,
    alive,
    started,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function cli(fx: Fx, ports: Ports, argv: string[], extra: Partial<CliDeps> = {}) {
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
    ...extra,
  });
  return { code, out, err };
}

const HOUR = 3_600_000;
const MIN = 60_000;
const ITEMS = ['APP-1', 'APP-2', 'APP-3'];
const SECRET = 'fake-value-oauth-ll-77';

const ownerConfig = (fx: Fx, yaml: string) => {
  mkdirSync(fx.ownerDir, { recursive: true });
  writeFileSync(join(fx.ownerDir, 'config.yaml'), yaml);
};

/** A provider that logs STUDIO_EXCLUDE per call and hands out the first label not excluded. */
const rotatingProvider = (fx: Fx, labels: string[], limits: string) => {
  mkdirSync(fx.ownerDir, { recursive: true });
  const f = join(fx.ownerDir, 'provider.sh');
  const calls = join(fx.ownerDir, 'calls.log');
  const picks = labels
    .map(
      (l) =>
        `case ",$STUDIO_EXCLUDE," in *,${l},*) ;; *) printf '{"label":"${l}","env":{"CLAUDE_CODE_OAUTH_TOKEN":"${SECRET}"}}\\n'; exit 0;; esac`,
    )
    .join('\n');
  writeFileSync(f, `#!/bin/sh\necho "$STUDIO_EXCLUDE" >> ${calls}\n${picks}\nexit 0\n`, {
    mode: 0o700,
  });
  ownerConfig(fx, `crew_credential_command: ${f}\n${limits}`);
  return () => readFileSync(calls, 'utf8').trimEnd().split('\n');
};
/** A provider that always hands out one label, whatever is excluded. */
const stubbornProvider = (fx: Fx, label: string, limits: string) => {
  mkdirSync(fx.ownerDir, { recursive: true });
  const f = join(fx.ownerDir, 'provider.sh');
  writeFileSync(
    f,
    `#!/bin/sh\nprintf '{"label":"${label}","env":{"CLAUDE_CODE_OAUTH_TOKEN":"${SECRET}"}}\\n'\n`,
    { mode: 0o700 },
  );
  ownerConfig(fx, `crew_credential_command: ${f}\n${limits}`);
};
const stateOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.state, 'state.json'), 'utf8'));
const crewOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.state, 'crew.json'), 'utf8'));
const usageOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.state, 'usage.json'), 'utf8'));

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '.git') hits.push(...filesContaining(p, needle));
    } else if (e.isFile() && readFileSync(p).includes(needle)) hits.push(p);
  }
  return hits;
}

describe('per-credential limits', () => {
  it('label at max_parallel is excluded', async () => {
    const fx = makeFx(ITEMS);
    const calls = rotatingProvider(
      fx,
      ['label-a', 'label-b'],
      'crew_label_limits:\n  max_parallel: 1\n',
    );
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
    expect(calls().some((l) => l.split(',').includes('label-a'))).toBe(true);
    expect(['APP-1', 'APP-2'].map((id) => crewOf(fx)[id].label)).toEqual(['label-a', 'label-b']);
    // Both labels are full now: nothing starts.
    expect((await cli(fx, p.ports, ['launch', 'APP-3'])).code).toBe(1);
    expect(p.started).toHaveLength(2);
  });

  it('without a provider the default label allows two at once', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
    expect((await cli(fx, p.ports, ['launch', 'APP-3'])).code).toBe(1);
    expect(p.started).toHaveLength(2);
  });

  it('refuses a provider that returns an excluded label', async () => {
    const fx = makeFx(ITEMS);
    rotatingProvider(fx, ['label-a'], 'crew_label_limits:\n  max_parallel: 1\n');
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    // Now a provider that ignores the exclude list; the planner would already hold, so the
    // launch itself is called directly.
    stubbornProvider(fx, 'label-a', 'crew_label_limits:\n  max_parallel: 1\n');
    const item = loadBoard(fx.project).items.find((i) => i.id === 'APP-2') as WorkItem;
    await expect(
      launchCrew(fx.project, item, loadConfig(fx.project), p.ports, {
        env: fx.env,
        homedir: fx.home,
      }),
    ).rejects.toThrow(/credential limit/);
    expect(p.started).toHaveLength(1);
  });

  it('a stopped or finished crew no longer counts as running', async () => {
    const fx = makeFx(ITEMS);
    ownerConfig(fx, 'crew_label_limits:\n  max_parallel: 1\n');
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    p.alive.clear();
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
  });

  it('day limit excludes until midnight in the configured timezone', async () => {
    const fx = makeFx(ITEMS);
    ownerConfig(
      fx,
      'crew_label_limits:\n  max_parallel: 5\n  max_runs_per_day: 1\n  timezone: America/New_York\n',
    );
    const p = makePorts();
    // 2026-11-01T10:00Z is 05:00 in New York; local midnight is 2026-11-02T05:00Z.
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    p.alive.clear();
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    // Past midnight UTC, still the same day in New York.
    p.advance(15 * HOUR);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    p.advance(3 * HOUR + 59 * MIN);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    p.advance(2 * MIN);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
    expect(usageOf(fx)).toEqual({
      '2026-11-01': { default: 1 },
      '2026-11-02': { default: 1 },
    });
  });

  it('a failed start still counts as a run', async () => {
    const fx = makeFx(ITEMS);
    ownerConfig(fx, 'crew_label_limits:\n  max_runs_per_day: 1\n  timezone: UTC\n');
    const p = makePorts();
    const start = p.ports.claude.start;
    p.ports.claude.start = async () => {
      throw new Error('spawn failed');
    };
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(1);
    p.ports.claude.start = start;
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    expect(usageOf(fx)).toEqual({ '2026-11-01': { default: 1 } });
  });

  it('prunes usage older than eight days', async () => {
    const fx = makeFx(ITEMS);
    ownerConfig(fx, 'crew_label_limits:\n  timezone: UTC\n');
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    writeFileSync(
      join(fx.state, 'usage.json'),
      JSON.stringify({
        '2026-10-01': { default: 3 },
        '2026-10-30': { default: 1 },
        '2026-11-01': { default: 1 },
      }),
    );
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
    expect(usageOf(fx)).toEqual({ '2026-10-30': { default: 1 }, '2026-11-01': { default: 2 } });
  });

  it('an unreadable usage file counts as all labels full', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    writeFileSync(join(fx.state, 'usage.json'), '{not json');
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    expect(p.started).toHaveLength(1);
    const plan = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(plan.assign).toEqual([]);
  });

  it('refuses when the launch lock is held', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    const body = {
      pid: process.pid,
      startedAt: 'x',
      heartbeat: '2026-11-01T10:00:00.000Z',
      token: 't',
    };
    writeFileSync(join(fx.state, 'launch.lock'), `${JSON.stringify(body)}\n`);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    expect(p.started).toHaveLength(1);
  });

  it('rejects an invalid timezone, a zero limit and unknown keys in the owner config', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    ownerConfig(fx, 'crew_label_limits:\n  timezone: Not/AZone\n');
    expect((await cli(fx, p.ports, ['plan'])).code).toBe(1);
    ownerConfig(fx, 'crew_label_limits:\n  max_parallel: 0\n');
    expect((await cli(fx, p.ports, ['plan'])).code).toBe(1);
    ownerConfig(fx, 'crew_label_limits:\n  surprise: 1\n');
    expect((await cli(fx, p.ports, ['plan'])).code).toBe(1);
  });

  it('plan assigns fewer items when labels are full', async () => {
    const fx = makeFx(ITEMS);
    ownerConfig(fx, 'crew_label_limits:\n  max_parallel: 1\n');
    const p = makePorts();
    const plan = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(plan.assign.map((i: { id: string }) => i.id)).toEqual(['APP-1']);
    expect(plan.deferred).toEqual([
      { id: 'APP-2', reason: 'credential limit' },
      { id: 'APP-3', reason: 'credential limit' },
    ]);
  });

  it('plan adds the slots of every label the provider hands out', async () => {
    const fx = makeFx(['APP-1', 'APP-2', 'APP-3', 'APP-4', 'APP-5']);
    const calls = rotatingProvider(
      fx,
      ['label-a', 'label-b'],
      'crew_label_limits:\n  max_parallel: 2\n',
    );
    const p = makePorts();
    const plan = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(plan.assign).toHaveLength(4);
    expect(plan.deferred).toEqual([{ id: 'APP-5', reason: 'credential limit' }]);
    expect(calls()).toEqual(['', 'label-a', 'label-a,label-b']);
  });

  it('plan holds when the provider returns an excluded label', async () => {
    const fx = makeFx(ITEMS);
    stubbornProvider(fx, 'label-a', 'crew_label_limits:\n  max_parallel: 1\n');
    const p = makePorts();
    const plan = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(plan.assign).toEqual([]);
  });

  it('plan with zero slots shows one usage-limit line and keeps no token', async () => {
    const fx = makeFx(ITEMS);
    rotatingProvider(fx, ['label-a'], 'crew_label_limits:\n  max_parallel: 1\n');
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    const r = await cli(fx, p.ports, ['state']);
    expect(r.code).toBe(0);
    const lines = stateOf(fx).forOwner.filter((o: { id: string }) => o.id === 'usage-limit');
    expect(lines).toHaveLength(1);
    expect(filesContaining(fx.state, SECRET)).toEqual([]);
    expect(r.out).not.toContain(SECRET);
  });

  it('usage per label appears in state', async () => {
    const fx = makeFx(ITEMS);
    rotatingProvider(
      fx,
      ['label-a', 'label-b'],
      'crew_label_limits:\n  max_parallel: 1\n  timezone: UTC\n',
    );
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    await cli(fx, p.ports, ['launch', 'APP-2']);
    p.alive.delete(5002);
    await cli(fx, p.ports, ['state']);
    expect(stateOf(fx).labelUsage).toEqual({
      day: '2026-11-01',
      labels: {
        'label-a': { running: 1, runsToday: 1 },
        'label-b': { running: 0, runsToday: 1 },
      },
    });
  });

  it('state has no labelUsage when nothing ran', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await cli(fx, p.ports, ['state']);
    expect(stateOf(fx).labelUsage).toBeUndefined();
  });
});
