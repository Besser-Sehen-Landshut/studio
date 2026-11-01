import { execFileSync } from 'node:child_process';
import {
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
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard, type WorkItem } from '../src/board.js';
import { type CliDeps, runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { launchCrew } from '../src/crew.js';
import { ownerStateRootFor, stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { enqueue, loadQueue, saveQueue } from '../src/queue.js';

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
  return {
    project,
    home,
    env,
    ownerDir,
    state: stateRootFor(project, { env, homedir: home }),
    owner: ownerStateRootFor({ env, homedir: home }),
  };
}
type Fx = ReturnType<typeof makeFx>;

function makePorts(startIso = '2026-11-01T10:00:00Z') {
  const real = realPorts();
  const alive = new Set<number>();
  const started: { args: string[]; env: Record<string, string> }[] = [];
  let pid = 5000;
  let t = Date.parse(startIso);
  const hooks: { afterGit?: (args: string[]) => void | Promise<void> } = {};
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
    git: {
      async run(cwd, args) {
        const out = await real.git.run(cwd, args);
        await hooks.afterGit?.(args);
        return out;
      },
    },
    clock: { now: () => new Date(t), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
  return {
    ports,
    hooks,
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
const usageOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.owner, 'usage.json'), 'utf8'));

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
      join(fx.owner, 'usage.json'),
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
    writeFileSync(join(fx.owner, 'usage.json'), '{not json');
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
    writeFileSync(join(fx.owner, 'launch.lock'), `${JSON.stringify(body)}\n`);
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

describe('limit races and counting', () => {
  const launchDirect = (fx: Fx, p: ReturnType<typeof makePorts>, id: string) => {
    const item = loadBoard(fx.project).items.find((i) => i.id === id) as WorkItem;
    return launchCrew(fx.project, item, loadConfig(fx.project), p.ports, {
      env: fx.env,
      homedir: fx.home,
    });
  };
  /** Another launch lands: a live record appears in crew.json. */
  const inject = (fx: Fx, p: ReturnType<typeof makePorts>, id: string, pid: number) => {
    const records = crewOf(fx);
    records[id] = {
      name: `studio-builder-${id.toLowerCase()}`,
      item: id,
      role: 'builder',
      pid,
      log: 'x',
      startedAt: '2026-11-01T10:00:00.000Z',
      label: 'default',
    };
    writeFileSync(join(fx.state, 'crew.json'), JSON.stringify(records));
    p.alive.add(pid);
  };
  /** Runs `fn` once, after the first `git remote get-url` of the next launch (between pick and lock). */
  const betweenPickAndLock = (p: ReturnType<typeof makePorts>, fn: () => void) => {
    p.hooks.afterGit = (args) => {
      if (args[0] !== 'remote' || args[1] !== 'get-url') return;
      p.hooks.afterGit = undefined;
      fn();
    };
  };

  it('a live crew on a merged item still counts as running', async () => {
    const fx = makeFx(ITEMS);
    ownerConfig(fx, 'crew_label_limits:\n  max_parallel: 1\n');
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    const board = join(fx.project, '.studio', 'board.yaml');
    writeFileSync(board, readFileSync(board, 'utf8').replace('status: assigned', 'status: merged'));
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    expect(p.started).toHaveLength(1);
  });

  it('a launch landing between pick and lock is refused, and the lock is released', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await launchDirect(fx, p, 'APP-1');
    betweenPickAndLock(p, () => inject(fx, p, 'APP-9', 7777));
    await expect(launchDirect(fx, p, 'APP-2')).rejects.toThrow(/credential limit/);
    expect(p.started).toHaveLength(1);
    // The refusal came under the lock; a later launch gets the lock again and starts.
    p.alive.delete(7777);
    await launchDirect(fx, p, 'APP-2');
    expect(p.started).toHaveLength(2);
  });

  it('a launch of the same item landing between pick and lock is refused', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await launchDirect(fx, p, 'APP-2');
    betweenPickAndLock(p, () => inject(fx, p, 'APP-1', 7778));
    await expect(launchDirect(fx, p, 'APP-1')).rejects.toThrow(/still running/);
    expect(p.started).toHaveLength(1);
  });

  it('two concurrent launches of one item start one crew', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await launchDirect(fx, p, 'APP-3');
    const results = await Promise.allSettled([
      launchDirect(fx, p, 'APP-1'),
      launchDirect(fx, p, 'APP-1'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(p.started).toHaveLength(2);
    expect(Object.keys(crewOf(fx)).sort()).toEqual(['APP-1', 'APP-3']);
  });

  it('a lost launch lock refuses before the run is counted', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await launchDirect(fx, p, 'APP-2');
    p.hooks.afterGit = (args) => {
      if (args[0] !== 'clone') return;
      p.hooks.afterGit = undefined;
      // Another process broke the stale lock and took it.
      writeFileSync(
        join(fx.owner, 'launch.lock'),
        `${JSON.stringify({ pid: process.pid, startedAt: 'x', heartbeat: '2026-11-01T10:00:00.000Z', token: 'other' })}\n`,
      );
    };
    await expect(launchDirect(fx, p, 'APP-1')).rejects.toThrow(/lock was lost/);
    expect(p.started).toHaveLength(1);
    expect(usageOf(fx)).toEqual({ '2026-11-01': { default: 1 } });
  });

  it('a label named like an inherited property is counted and limited', async () => {
    const fx = makeFx(ITEMS);
    stubbornProvider(fx, 'toString', 'crew_label_limits:\n  max_parallel: 1\n  timezone: UTC\n');
    const p = makePorts();
    await launchDirect(fx, p, 'APP-1');
    expect(usageOf(fx)).toEqual({ '2026-11-01': { toString: 1 } });
    await expect(launchDirect(fx, p, 'APP-2')).rejects.toThrow(/credential limit/);
    expect(p.started).toHaveLength(1);
  });

  it('the day limit follows local midnight across a DST change', async () => {
    const fx = makeFx(ITEMS);
    ownerConfig(
      fx,
      'crew_label_limits:\n  max_parallel: 5\n  max_runs_per_day: 1\n  timezone: America/New_York\n',
    );
    // 00:30 EDT on 2026-11-01; clocks go back at 06:00Z, so local midnight is 05:00Z on the 2nd.
    const p = makePorts('2026-11-01T04:30:00Z');
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    p.alive.clear();
    // 24 hours later is only 23:30 on the same local day.
    p.advance(24 * HOUR);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    p.advance(29 * MIN);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    p.advance(2 * MIN);
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
  });
});

const GREEN_RUNS = JSON.stringify([
  { workflowName: 'ci', status: 'completed', conclusion: 'success', headSha: 'a'.repeat(40) },
]);
const withMainBuild = (p: ReturnType<typeof makePorts>, stdout = GREEN_RUNS) => {
  p.ports.gh = {
    api: async () => '0',
    run: async (args) =>
      args[0] === 'run' ? { code: 0, stdout, stderr: '' } : { code: 0, stdout: '', stderr: '' },
  };
};

describe('pane fields in state.json', () => {
  it('ci, today, usageDays, mainBuild, counts and crew rows; no credential value anywhere', async () => {
    const fx = makeFx(ITEMS);
    rotatingProvider(fx, ['label-a'], 'crew_label_limits:\n  timezone: UTC\n');
    const p = makePorts();
    withMainBuild(p);
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    const ev = (o: object) => `${JSON.stringify(o)}\n`;
    writeFileSync(
      join(fx.state, 'metrics.jsonl'),
      ev({ type: 'merged', item: 'APP-9', pr: 7, repo: 'org/app', at: '2026-11-01T08:00:00Z' }) +
        ev({ type: 'merged', item: 'APP-8', pr: 6, repo: 'org/app', at: '2026-10-31T23:00:00Z' }) +
        ev({ type: 'deployed', at: '2026-11-01T09:00:00Z' }) +
        ev({ type: 'deployed', at: '2026-10-31T09:00:00Z' }),
    );
    enqueue(fx.state, { pr: 11, repo: 'org/app', item: 'APP-5' });
    enqueue(fx.state, { pr: 12, repo: 'org/app', item: 'APP-6' });
    const r = await cli(fx, p.ports, ['state']);
    expect(r.code).toBe(0);
    const s = stateOf(fx);
    expect(s.ci).toEqual({ busy: 0, total: 8, mergeMaxBusy: 5, ok: true });
    expect(s.today).toEqual({
      day: '2026-11-01',
      merged: [{ pr: 7, repo: 'org/app', at: '2026-11-01T08:00:00Z' }],
      deployed: 1,
    });
    expect(s.usageDays).toEqual({ '2026-11-01': { 'label-a': 1 } });
    expect(s.mainBuild).toEqual({ status: 'green', sha: 'a'.repeat(40), workflow: 'ci' });
    expect(s.counts).toEqual({ ready: 2, queued: 2 });
    expect(s.crew).toHaveLength(1);
    expect(s.crew[0]).toMatchObject({
      item: 'APP-1',
      title: 'Item APP-1',
      state: 'working',
      repo: 'org/app',
      status: 'assigned',
    });
    expect(s.crew[0].stoppedAt).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(r.out).not.toContain(SECRET);
    expect(filesContaining(fx.state, SECRET)).toEqual([]);
  });

  it('crew state follows the process and the report', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    p.alive.clear();
    await cli(fx, p.ports, ['state']);
    expect(stateOf(fx).crew[0].state).toBe('crashed');
    const dir = join(fx.state, 'clones', 'APP-1', '.studio', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'APP-1.md'), '---\nstatus: done\n---\n');
    await cli(fx, p.ports, ['state']);
    expect(stateOf(fx).crew[0].state).toBe('waiting');
  });

  it('counts.queued includes the entry being merged', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await cli(fx, p.ports, ['state']);
    saveQueue(fx.state, {
      ...loadQueue(fx.state),
      current: { pr: 11, repo: 'org/app', item: 'APP-5', step: 'checks' },
    });
    enqueue(fx.state, { pr: 12, repo: 'org/app', item: 'APP-6' });
    await cli(fx, p.ports, ['state']);
    expect(stateOf(fx).counts.queued).toBe(2);
  });

  it('mainBuild is unknown when gh cannot say; usageDays is absent without usage', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await cli(fx, p.ports, ['state']);
    const s = stateOf(fx);
    expect(s.mainBuild).toEqual({ status: 'unknown' });
    expect(s.usageDays).toBeUndefined();
    expect(s.today.merged).toEqual([]);
    expect(s.counts).toEqual({ ready: 3, queued: 0 });
  });

  describe('crew records of another project are unreadable', () => {
    const otherRoot = (fx: Fx) => join(dirname(fx.owner), '0123456789abcdef');
    const breakOther = (fx: Fx) => {
      mkdirSync(otherRoot(fx), { recursive: true, mode: 0o700 });
      writeFileSync(join(otherRoot(fx), 'crew.json'), '{not json');
    };

    it('state still writes state.json: no labelUsage, one crew-records line, no path', async () => {
      const fx = makeFx(ITEMS);
      const p = makePorts();
      expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
      breakOther(fx);
      const r = await cli(fx, p.ports, ['state']);
      expect(r.code).toBe(0);
      const s = stateOf(fx);
      expect(s.labelUsage).toBeUndefined();
      const lines = s.forOwner.filter((o: { id: string }) => o.id === 'crew-records');
      expect(lines).toHaveLength(1);
      expect(lines[0].title).toContain('unreadable');
      expect(lines[0].title).not.toContain(otherRoot(fx));
      expect(lines[0].title).not.toContain(fx.home);
      expect(lines[0].title).not.toMatch(/\p{Cc}/u);
      expect(r.err).toContain('error:');
    });

    it('plan and launch stay refused', async () => {
      const fx = makeFx(ITEMS);
      const p = makePorts();
      breakOther(fx);
      expect((await cli(fx, p.ports, ['plan'])).code).toBe(1);
      expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(1);
      expect(p.started).toEqual([]);
    });

    it('an unreadable crew.json of this project still fails state, as before', async () => {
      const fx = makeFx(ITEMS);
      const p = makePorts();
      await cli(fx, p.ports, ['state']);
      writeFileSync(join(fx.state, 'crew.json'), '{not json');
      const r = await cli(fx, p.ports, ['state']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('crew file');
    });
  });
});

describe('pause and resume', () => {
  const pauseFile = (fx: Fx) => join(fx.state, 'pause.json');

  it('pause blocks plan, launch and launchCrew; running crews continue; no forOwner line', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    const r = await cli(fx, p.ports, ['pause']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ paused: true });
    expect(existsSync(pauseFile(fx))).toBe(true);

    const plan = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(plan.assign).toEqual([]);
    expect(plan.deferred.map((d: { reason: string }) => d.reason)).toEqual(['paused', 'paused']);

    const launch = await cli(fx, p.ports, ['launch', 'APP-2']);
    expect(launch.code).toBe(1);
    expect(launch.err).toContain('paused');
    const item = loadBoard(fx.project).items.find((i) => i.id === 'APP-3') as WorkItem;
    await expect(
      launchCrew(fx.project, item, loadConfig(fx.project), p.ports, {
        env: fx.env,
        homedir: fx.home,
      }),
    ).rejects.toThrow(/paused/);
    expect(p.started).toHaveLength(1);

    expect(crewOf(fx)['APP-1'].stoppedAt).toBeUndefined();
    expect(p.alive.size).toBe(1);
    await cli(fx, p.ports, ['state']);
    expect(stateOf(fx).forOwner).toEqual([]);
    expect(stateOf(fx).crew[0].state).toBe('working');
  });

  it('resume lifts the pause', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await cli(fx, p.ports, ['pause']);
    const r = await cli(fx, p.ports, ['resume']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ paused: false });
    expect(existsSync(pauseFile(fx))).toBe(false);
    expect(JSON.parse((await cli(fx, p.ports, ['plan'])).out).assign).toHaveLength(2);
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
  });

  it('a crew role may neither pause nor resume', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    const crewEnv = { env: { ...fx.env, STUDIO_ROLE: 'crew' } };
    expect((await cli(fx, p.ports, ['pause'], crewEnv)).code).toBe(1);
    expect(existsSync(pauseFile(fx))).toBe(false);
    await cli(fx, p.ports, ['pause']);
    expect((await cli(fx, p.ports, ['resume'], crewEnv)).code).toBe(1);
    expect(existsSync(pauseFile(fx))).toBe(true);
  });

  it('a corrupt pause.json is paused; resume clears it', async () => {
    const fx = makeFx(ITEMS);
    const p = makePorts();
    await cli(fx, p.ports, ['state']);
    writeFileSync(pauseFile(fx), 'garbage');
    expect(JSON.parse((await cli(fx, p.ports, ['plan'])).out).assign).toEqual([]);
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(1);
    expect((await cli(fx, p.ports, ['resume'])).code).toBe(0);
    expect(existsSync(pauseFile(fx))).toBe(false);
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
  });
});
