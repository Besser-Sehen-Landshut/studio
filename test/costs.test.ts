import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type Board, loadBoard, parseBoard, saveBoard, type WorkItem } from '../src/board.js';
import { type CliDeps, runCli } from '../src/cli.js';
import { camelizeKeys, ownerConfigSchema, studioConfigSchema } from '../src/config.js';
import {
  costHold,
  costReport,
  costToday,
  readLedger,
  recordEndedRuns,
  usageFromLog,
  withItemUsage,
} from '../src/costs.js';
import { launchCrew } from '../src/crew.js';
import {
  acquireStateLock,
  checkStateMarker,
  ownerStateRootFor,
  projectRealpath,
  stateRootFor,
  writeStateFile,
} from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { newReportName } from '../src/report.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-costs-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const result = (cost: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    total_cost_usd: cost,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 40,
    },
    ...extra,
  });
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });
const tool = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text' }] } });

describe('usageFromLog', () => {
  it('sums total_cost_usd and usage over the result lines and counts runs by init', () => {
    const u = usageFromLog([init, tool, result(1.5), init, result(0.25), ''].join('\n'));
    expect(u).toEqual({ runs: 2, tokensIn: 20, tokensOut: 40, tokensCache: 680, costUsd: 1.75 });
  });

  it('prefers modelUsage, which covers every model, and takes costUSD without total_cost_usd', () => {
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        'model-a': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 7, costUSD: 0.5 },
        'model-b': { inputTokens: 5, outputTokens: 5, cacheCreationInputTokens: 3, costUSD: 0.1 },
      },
    });
    expect(usageFromLog(line)).toEqual({
      runs: 1,
      tokensIn: 105,
      tokensOut: 55,
      tokensCache: 10,
      costUsd: 0.6,
    });
  });

  it('is lenient: torn lines, odd values and a run without a result', () => {
    const odd = JSON.stringify({
      type: 'result',
      total_cost_usd: -3,
      usage: { input_tokens: 'x' },
    });
    const u = usageFromLog([init, '{"type":"result",', odd, init, 'not json'].join('\n'));
    expect(u).toEqual({ runs: 2, tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0 });
    expect(usageFromLog('')).toEqual({
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCache: 0,
      costUsd: 0,
    });
  });
});

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `Item ${id}`,
  type: 'fix',
  role: 'builder',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'in_review',
  paths: [],
  touches: [],
  dependsOn: [],
  dod: [],
  history: [],
  ...over,
});

let n = 0;
const stateDir = () => {
  const dir = join(root, `s${n++}`);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
};
const log = (state: string, id: string, ...lines: string[]) =>
  writeFileSync(join(state, 'logs', `${id}.jsonl`), `${lines.join('\n')}\n`, { flag: 'a' });

/**
 * A run killed before its result: two assistant messages, the first streamed as two events with
 * the same id and usage (counted once), on a sonnet model ($2 in, $10 out, $0.20 cache read and
 * $2.50 cache write per million tokens).
 */
const assistant = (id: string, model: string, usage: Record<string, number>) =>
  JSON.stringify({ type: 'assistant', message: { id, model, usage, content: [] } });
const partialRun = [
  assistant('m1', 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 100 }),
  assistant('m1', 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 200 }),
  assistant('m2', 'claude-sonnet-5-5', {
    input_tokens: 10,
    output_tokens: 300,
    cache_read_input_tokens: 50_000,
    cache_creation_input_tokens: 2000,
  }),
];
const PARTIAL_USD = (1010 * 2 + 500 * 10 + 50_000 * 0.2 + 2000 * 2.5) / 1e6;

describe('estimates for a run that has no result', () => {
  it('counts the last usage per assistant message, priced by model family', () => {
    const u = usageFromLog([init, ...partialRun].join('\n'));
    expect(u).toMatchObject({
      runs: 1,
      tokensIn: 1010,
      tokensOut: 500,
      tokensCache: 52_000,
      estimated: true,
    });
    expect(u.costUsd).toBeCloseTo(PARTIAL_USD, 9);
  });

  it('takes the result where there is one, and estimates only the run without', () => {
    const u = usageFromLog([init, result(1.5), init, ...partialRun].join('\n'));
    expect(u.runs).toBe(2);
    expect(u.estimated).toBe(true);
    expect(u.costUsd).toBeCloseTo(1.5 + PARTIAL_USD, 9);
    expect(usageFromLog([init, result(1.5)].join('\n')).estimated).toBeUndefined();
  });

  it('prices a model it does not know at the highest rates, so the cap errs high', () => {
    const line = assistant('m1', 'some-future-model', { input_tokens: 1e6, output_tokens: 0 });
    expect(usageFromLog([init, line].join('\n')).costUsd).toBe(10);
  });
});

describe('withItemUsage', () => {
  it('puts a review run on the builder item it reviews, and recomputes instead of adding', () => {
    const state = stateDir();
    log(state, 'APP-1', init, result(2));
    log(state, 'APP-2', init, result(0.5));
    const board: Board = {
      items: [
        item('APP-1', { pr: 7, epic: 'E-1' }),
        item('APP-2', { type: 'review', role: 'reviewer', notes: ['review org/app#7'] }),
        item('APP-3', { pr: 8 }),
      ],
    };
    const once = withItemUsage(board, state, 'APP-2');
    const twice = withItemUsage(once, state, 'APP-1');
    const builder = twice.items.find((i) => i.id === 'APP-1');
    expect(builder?.usage).toEqual({
      runs: 2,
      tokensIn: 20,
      tokensOut: 40,
      tokensCache: 680,
      costUsd: 2.5,
    });
    expect(twice.items.find((i) => i.id === 'APP-2')?.usage).toBeUndefined();
    expect(twice.items.find((i) => i.id === 'APP-3')?.usage).toBeUndefined();
    expect(costReport(twice)).toMatchObject({
      totalUsd: 2.5,
      epics: [{ epic: 'E-1', runs: 2, costUsd: 2.5 }],
    });
  });

  it('round-trips through board.yaml with snake_case keys', () => {
    const dir = join(root, `b${n++}`);
    mkdirSync(join(dir, '.studio'), { recursive: true });
    const usage = { runs: 1, tokensIn: 2, tokensOut: 3, tokensCache: 4, costUsd: 0.5 };
    saveBoard(dir, { items: [item('APP-1', { usage })] });
    const text = readFileSync(join(dir, '.studio', 'board.yaml'), 'utf8');
    expect(text).toContain('tokens_in: 2');
    expect(text).toContain('cost_usd: 0.5');
    expect(parseBoard(text, 'board.yaml').items[0]?.usage).toEqual(usage);
  });
});

/** Ports with a clock the test moves, and crews that are alive while `live` holds their pid. */
function clockPorts(start: string) {
  let t = Date.parse(start);
  const live = new Set<number>();
  const ports: Ports = {
    ...realPorts(),
    gh: { api: async () => '0', run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    claude: {
      start: async () => ({ pid: 1 }),
      alive: (p) => live.has(p),
      identity: async (p) => `start-${p}`,
      stop: async () => {},
    },
    clock: { now: () => new Date(t), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
  return { ports, live, set: (iso: string) => (t = Date.parse(iso)) };
}

/** A crew record; its stored identity matches what `clockPorts` reports for the pid. */
const crewRecord = (
  item: string,
  pid: number,
  startedAt: string,
  logStart = 0,
  identity = `start-${pid}`,
) => ({
  name: `crew-${item}`,
  item,
  role: 'builder',
  label: 'default',
  pid,
  identity,
  log: '/x',
  startedAt,
  logStart,
});
const writeRecords = (state: string, recs: ReturnType<typeof crewRecord>[]) =>
  writeStateFile(
    state,
    join(state, 'crew.json'),
    JSON.stringify(Object.fromEntries(recs.map((r) => [r.item, r]))),
  );

describe('the daily ledger', () => {
  it('enters an ended run once, from its log start, on the local day it is seen', async () => {
    const state = stateDir();
    const clock = clockPorts('2026-11-05T10:00:00Z');
    log(state, 'APP-1', init, result(9));
    const start = readFileSync(join(state, 'logs', 'APP-1.jsonl')).length;
    log(state, 'APP-1', init, result(1.25));
    writeRecords(state, [crewRecord('APP-1', 7, '2026-11-05T09:00:00.000Z', start)]);
    clock.live.add(7);
    expect(await recordEndedRuns(state, clock.ports, 'UTC')).toBe(true);
    // Still running: not entered.
    expect(costToday(state, clock.ports.clock.now(), 'UTC')).toBe(0);
    clock.live.delete(7);
    await recordEndedRuns(state, clock.ports, 'UTC');
    await recordEndedRuns(state, clock.ports, 'UTC');
    expect(costToday(state, clock.ports.clock.now(), 'UTC')).toBe(1.25);
    const read = readLedger(state);
    expect(read.ok && Object.keys(read.runs)).toEqual(['APP-1@2026-11-05T09:00:00.000Z']);
    // The next day counts from zero; the entry stays for the week.
    clock.set('2026-11-06T00:30:00Z');
    expect(costToday(state, clock.ports.clock.now(), 'UTC')).toBe(0);
  });

  it('counts the day in the owner zone', async () => {
    const state = stateDir();
    const clock = clockPorts('2026-11-05T23:30:00Z');
    log(state, 'APP-1', init, result(2));
    writeRecords(state, [crewRecord('APP-1', 7, '2026-11-05T23:00:00.000Z')]);
    await recordEndedRuns(state, clock.ports, 'Europe/Berlin');
    const read = readLedger(state);
    expect(read.ok && Object.values(read.runs)[0]?.day).toBe('2026-11-06');
  });

  it('a run has ended once its pid belongs to another process, not only when the pid is free', async () => {
    const state = stateDir();
    const clock = clockPorts('2026-11-05T10:00:00Z');
    log(state, 'APP-1', init, result(1));
    log(state, 'APP-2', init, result(2));
    // APP-1: pid 7 lives with the identity stored at launch. APP-2: pid 8 lives, but another
    // process holds it now (the crew ended and the pid was reused).
    writeRecords(state, [
      crewRecord('APP-1', 7, '2026-11-05T09:00:00.000Z'),
      crewRecord('APP-2', 8, '2026-11-05T09:00:00.000Z', 0, 'start-8-earlier'),
    ]);
    clock.live.add(7);
    clock.live.add(8);
    await recordEndedRuns(state, clock.ports, 'UTC');
    const read = readLedger(state);
    expect(read.ok && Object.keys(read.runs)).toEqual(['APP-2@2026-11-05T09:00:00.000Z']);
  });

  it('a second writer waits for costs.lock and merges with what is on disk', async () => {
    const state = stateDir();
    const clock = clockPorts('2026-11-05T10:00:00Z');
    log(state, 'APP-1', init, result(1));
    writeRecords(state, [crewRecord('APP-1', 7, '2026-11-05T09:00:00.000Z')]);
    const other = acquireStateLock(state, 'costs.lock', {
      now: new Date(),
      heartbeatStaleMs: 60_000,
    });
    expect(other).toBeDefined();
    const pending = recordEndedRuns(state, clock.ports, 'UTC');
    // The holder writes its own entry while the second writer waits.
    await new Promise((r) => setTimeout(r, 50));
    writeStateFile(
      state,
      join(state, 'costs.json'),
      JSON.stringify({
        runs: {
          'WEB-3@2026-11-05T08:00:00.000Z': { day: '2026-11-05', item: 'WEB-3', costUsd: 4 },
        },
      }),
    );
    other?.release();
    expect(await pending).toBe(true);
    const read = readLedger(state);
    expect(read.ok && Object.keys(read.runs).sort()).toEqual([
      'APP-1@2026-11-05T09:00:00.000Z',
      'WEB-3@2026-11-05T08:00:00.000Z',
    ]);
    expect(costToday(state, clock.ports.clock.now(), 'UTC')).toBe(5);
  });

  it('a run without a result is estimated from its assistant usage and marked so', async () => {
    const state = stateDir();
    const clock = clockPorts('2026-11-05T10:00:00Z');
    log(state, 'APP-1', init, ...partialRun);
    writeRecords(state, [crewRecord('APP-1', 7, '2026-11-05T09:00:00.000Z')]);
    await recordEndedRuns(state, clock.ports, 'UTC');
    const read = readLedger(state);
    const entry = read.ok ? Object.values(read.runs)[0] : undefined;
    expect(entry?.estimated).toBe(true);
    expect(entry?.costUsd).toBeCloseTo(PARTIAL_USD, 6);
  });

  it('fails closed only while a cap is set', () => {
    const base = join(root, `base${n++}`);
    const state = join(base, '0123456789abcdef-app');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'costs.json'), 'nope');
    const now = new Date('2026-11-05T10:00:00Z');
    const config = (cap?: number) =>
      studioConfigSchema.parse({
        studio: 1,
        primaryRepo: 'org/app',
        repos: ['org/app'],
        ci: {
          provider: 'github',
          runners: 'github-hosted',
          runnerLabels: [],
          capacity: { total: 1, mergeMaxBusy: 1, checkTwiceSeconds: 0 },
        },
        merge: { strategy: 'studio-queue', contractPaths: [] },
        roles: { builder: { model: 'sonnet', wip: 1 } },
        ...(cap === undefined ? {} : { limits: { dailyCostUsd: cap } }),
      });
    const owner = ownerConfigSchema.parse({});
    const hold = (cap?: number, ownerCap?: number) =>
      costHold({
        stateRoot: state,
        stateBase: base,
        config: config(cap),
        ownerConfig:
          ownerCap === undefined ? owner : { ...owner, limits: { dailyCostUsd: ownerCap } },
        now,
      });
    expect(hold()).toBeUndefined();
    expect(hold(5)).toMatch(/costs\.json is unreadable/);
    expect(hold(undefined, 5)).toMatch(/costs\.json is unreadable/);
  });

  it('holds at the project cap and at the owner cap summed over projects', () => {
    const base = join(root, `base${n++}`);
    const a = join(base, '0123456789abcdef-a');
    const b = join(base, 'fedcba9876543210-b');
    const ledger = (dir: string, cost: number) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'costs.json'),
        JSON.stringify({
          runs: {
            'APP-1@2026-11-05T08:00:00.000Z': { day: '2026-11-05', item: 'APP-1', costUsd: cost },
          },
        }),
      );
    };
    ledger(a, 3);
    ledger(b, 4);
    const config = studioConfigSchema.parse({
      studio: 1,
      primaryRepo: 'org/app',
      repos: ['org/app'],
      ci: {
        provider: 'github',
        runners: 'github-hosted',
        runnerLabels: [],
        capacity: { total: 1, mergeMaxBusy: 1, checkTwiceSeconds: 0 },
      },
      merge: { strategy: 'studio-queue', contractPaths: [] },
      roles: { builder: { model: 'sonnet', wip: 1 } },
      limits: { dailyCostUsd: 3 },
    });
    const owner = { ...ownerConfigSchema.parse({}), limits: { dailyCostUsd: 6.5 } };
    const now = new Date('2026-11-05T10:00:00Z');
    expect(costHold({ stateRoot: a, stateBase: base, config, ownerConfig: owner, now })).toBe(
      'daily cost cap reached ($3.00 of $3.00)',
    );
    const loose = { ...config, limits: { dailyCostUsd: 10 } };
    expect(
      costHold({ stateRoot: a, stateBase: base, config: loose, ownerConfig: owner, now }),
    ).toBe('owner daily cost cap reached ($7.00 of $6.50)');
    const tomorrow = new Date('2026-11-06T10:00:00Z');
    expect(
      costHold({ stateRoot: a, stateBase: base, config, ownerConfig: owner, now: tomorrow }),
    ).toBeUndefined();
  });
});

// ---- Through the CLI -------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const studioYaml = (extra = '') => `studio: 1
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
  reviewer: { model: opus, wip: 1 }
owner_only: []
deploy_commands: []
${extra}`;

const itemYaml = (id: string, status = 'ready', extra = '') =>
  `  - { id: ${id}, title: Item ${id}, type: fix, role: builder, repo: org/app, size: S, priority: 1, status: ${status}, paths: [], touches: [${id.toLowerCase()}/**], depends_on: [], dod: [tests pass]${extra}, history: [] }`;

function makeFx(items: string[], yaml = studioYaml(), epics = '') {
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
  writeFileSync(join(project, '.studio', 'studio.yaml'), yaml);
  writeFileSync(join(project, '.studio', 'board.yaml'), `items:\n${items.join('\n')}\n${epics}`);
  const env: Record<string, string | undefined> = { PATH: process.env.PATH };
  const ownerDir = join(home, '.config', 'studio');
  mkdirSync(ownerDir, { recursive: true });
  writeFileSync(join(ownerDir, 'config.yaml'), 'crew_label_limits: { timezone: UTC }\n');
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

/** A run of APP-9 that ended today and cost `usd`, in the project's crew records and log. */
function spent(fx: Fx, usd: number, startedAt = '2026-11-05T08:00:00.000Z') {
  // Bound to the project, as its first launch leaves it.
  checkStateMarker(fx.state, {
    projectRealpath: projectRealpath(fx.project),
    originUrl: git(fx.project, 'remote', 'get-url', 'origin'),
  });
  mkdirSync(join(fx.state, 'logs'), { recursive: true });
  log(fx.state, 'APP-9', init, result(usd));
  writeRecords(fx.state, [crewRecord('APP-9', 77, startedAt)]);
}

describe('the daily cost cap in the planner', () => {
  it('defers everything once today reaches the cap, and lets it go the next day', async () => {
    const fx = makeFx([itemYaml('APP-1')], studioYaml('limits: { daily_cost_usd: 5 }\n'));
    const clock = clockPorts('2026-11-05T12:00:00Z');
    spent(fx, 5.5);
    const r = await cli(fx, clock.ports, ['plan']);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.out);
    expect(plan.assign).toEqual([]);
    expect(plan.deferred).toEqual([
      { id: 'APP-1', reason: 'daily cost cap reached ($5.50 of $5.00)' },
    ]);
    clock.set('2026-11-06T00:10:00Z');
    const next = JSON.parse((await cli(fx, clock.ports, ['plan'])).out);
    expect(next.assign.map((i: { id: string }) => i.id)).toEqual(['APP-1']);
  });

  it('lets a running crew finish: its cost counts only once it ended', async () => {
    const fx = makeFx([itemYaml('APP-1')], studioYaml('limits: { daily_cost_usd: 5 }\n'));
    const clock = clockPorts('2026-11-05T12:00:00Z');
    spent(fx, 6);
    clock.live.add(77);
    const plan = JSON.parse((await cli(fx, clock.ports, ['plan'])).out);
    expect(plan.assign.map((i: { id: string }) => i.id)).toEqual(['APP-1']);
  });

  it('the owner cap counts every project of the owner', async () => {
    const fx = makeFx([itemYaml('APP-1')]);
    writeFileSync(
      join(fx.ownerDir, 'config.yaml'),
      'crew_label_limits: { timezone: UTC }\nlimits: { daily_cost_usd: 2 }\n',
    );
    const other = join(fx.home, '.local', 'state', 'studio', 'fedcba9876543210-other');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, 'costs.json'),
      JSON.stringify({
        runs: {
          'WEB-1@2026-11-05T01:00:00.000Z': { day: '2026-11-05', item: 'WEB-1', costUsd: 2 },
        },
      }),
    );
    const clock = clockPorts('2026-11-05T12:00:00Z');
    const plan = JSON.parse((await cli(fx, clock.ports, ['plan'])).out);
    expect(plan.deferred).toEqual([
      { id: 'APP-1', reason: 'owner daily cost cap reached ($2.00 of $2.00)' },
    ]);
  });

  it('the owner cap counts a project that had no plan or tick since its run ended', async () => {
    const fx = makeFx([itemYaml('APP-1')]);
    writeFileSync(
      join(fx.ownerDir, 'config.yaml'),
      'crew_label_limits: { timezone: UTC }\nlimits: { daily_cost_usd: 2 }\n',
    );
    // The idle project: an ended run in its log and crew records, nothing in its ledger.
    const idle = join(fx.home, '.local', 'state', 'studio', 'fedcba9876543210-idle');
    mkdirSync(join(idle, 'logs'), { recursive: true });
    log(idle, 'WEB-1', init, result(2.5));
    writeRecords(idle, [crewRecord('WEB-1', 99, '2026-11-05T07:00:00.000Z')]);
    const clock = clockPorts('2026-11-05T12:00:00Z');
    const plan = JSON.parse((await cli(fx, clock.ports, ['plan'])).out);
    expect(plan.deferred).toEqual([
      { id: 'APP-1', reason: 'owner daily cost cap reached ($2.50 of $2.00)' },
    ]);
  });

  it('accounts-clear records a run before it moves the log start past it', async () => {
    const fx = makeFx([itemYaml('APP-1')]);
    const clock = clockPorts('2026-11-05T12:00:00Z');
    spent(fx, 3);
    writeStateFile(
      fx.owner,
      join(fx.owner, 'blocks.json'),
      JSON.stringify([{ label: 'default', reason: 'auth_failed', at: '2026-11-05T11:00:00.000Z' }]),
    );
    const r = await cli(fx, clock.ports, ['accounts-clear', 'default'], { isTerminal: true });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const records = JSON.parse(readFileSync(join(fx.state, 'crew.json'), 'utf8'));
    expect(records['APP-9'].logStart).toBeGreaterThan(0);
    await cli(fx, clock.ports, ['plan']);
    expect(costToday(fx.state, clock.ports.clock.now(), 'UTC')).toBe(3);
  });

  it('tick lists the cap under held', async () => {
    const fx = makeFx([itemYaml('APP-1')], studioYaml('limits: { daily_cost_usd: 1 }\n'));
    const clock = clockPorts('2026-11-05T12:00:00Z');
    spent(fx, 1);
    const r = await cli(fx, clock.ports, ['tick']);
    const out = JSON.parse(r.out);
    expect(out.launched).toEqual([]);
    expect(out.held).toContainEqual({
      item: 'APP-1',
      reason: 'daily cost cap reached ($1.00 of $1.00)',
    });
  });
});

describe('costs on the board and in the reports', () => {
  const HEAD = 'a'.repeat(40);
  const viewGh = (): Ports['gh'] => ({
    api: async () => '0',
    run: async (args) => {
      const line = args.join(' ');
      if (line.startsWith('pr view 7 --repo org/app')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            headRefOid: HEAD,
            headRefName: 'studio/APP-1',
            headRepository: { name: 'app' },
            headRepositoryOwner: { login: 'org' },
            isCrossRepository: false,
          }),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: `unscripted: ${line}` };
    },
  });

  it('collect stores runs, tokens and cost on the item', async () => {
    const fx = makeFx([itemYaml('APP-1', 'assigned', ', epic: E-1')], studioYaml(), EPIC);
    mkdirSync(join(fx.state, 'logs'), { recursive: true });
    log(fx.state, 'APP-1', init, result(0.75), init, result(0.5));
    const dir = join(fx.state, 'clones', 'APP-1', '.studio', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, newReportName(fx.state, 'APP-1')),
      `---\nstatus: done\nitem: APP-1\npr: 7\nhead_sha: ${HEAD}\ntests_run: 3\n---\n\nbody\n`,
    );
    const clock = clockPorts('2026-11-05T12:00:00Z');
    clock.ports.gh = viewGh();
    const r = await cli(fx, clock.ports, ['collect', 'APP-1']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const builder = loadBoard(fx.project).items.find((i) => i.id === 'APP-1');
    expect(builder?.usage).toEqual({
      runs: 2,
      tokensIn: 20,
      tokensOut: 40,
      tokensCache: 680,
      costUsd: 1.25,
    });
    const metrics = JSON.parse((await cli(fx, clock.ports, ['metrics'])).out);
    expect(metrics.costs).toMatchObject({
      totalUsd: 1.25,
      items: [{ item: 'APP-1', epic: 'E-1', runs: 2, costUsd: 1.25 }],
      epics: [{ epic: 'E-1', runs: 2, costUsd: 1.25 }],
    });
    const list = await cli(fx, clock.ports, ['epic', 'list']);
    expect(list.out).toMatch(/COST/);
    expect(list.out).toMatch(/E-1 .*\$1\.25/);
    const rows = JSON.parse((await cli(fx, clock.ports, ['--json', 'epic', 'list'])).out);
    expect(rows[0].costUsd).toBe(1.25);
  });

  it('the state snapshot carries today’s cost for the pane', async () => {
    const fx = makeFx([itemYaml('APP-1')]);
    const clock = clockPorts('2026-11-05T12:00:00Z');
    spent(fx, 0.4);
    await cli(fx, clock.ports, ['plan']);
    expect(await cli(fx, clock.ports, ['state'])).toMatchObject({ code: 0 });
    const state = JSON.parse(readFileSync(join(fx.state, 'state.json'), 'utf8'));
    expect(state.today.costUsd).toBe(0.4);
  });
});

describe('a relaunch', () => {
  it('records the previous run of the item before its crew record is replaced', async () => {
    const fx = makeFx([itemYaml('APP-1')]);
    const clock = clockPorts('2026-11-05T12:00:00Z');
    checkStateMarker(fx.state, {
      projectRealpath: projectRealpath(fx.project),
      originUrl: git(fx.project, 'remote', 'get-url', 'origin'),
    });
    mkdirSync(join(fx.state, 'logs'), { recursive: true });
    log(fx.state, 'APP-1', init, result(0.8));
    writeRecords(fx.state, [crewRecord('APP-1', 77, '2026-11-05T08:00:00.000Z')]);
    const board = loadBoard(fx.project);
    const item = board.items[0] as WorkItem;
    await launchCrew(fx.project, item, studioConfigSchema.parse(parseYamlConfig(fx)), clock.ports, {
      homedir: fx.home,
      env: fx.env,
    });
    const records = JSON.parse(readFileSync(join(fx.state, 'crew.json'), 'utf8'));
    expect(records['APP-1'].startedAt).not.toBe('2026-11-05T08:00:00.000Z');
    const read = readLedger(fx.state);
    expect(read.ok && read.runs['APP-1@2026-11-05T08:00:00.000Z']?.costUsd).toBe(0.8);
  });
});

const parseYamlConfig = (fx: Fx) =>
  camelizeKeys(parseYaml(readFileSync(join(fx.project, '.studio', 'studio.yaml'), 'utf8')));

const EPIC = `epics:
  - { id: E-1, title: First epic, status: open, goal: A goal, acceptance: [it works], history: [] }
`;
