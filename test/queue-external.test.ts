import { describe, expect, it } from 'vitest';
import { readRunnerLoad } from '../src/capacity.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import { branchBuildRunning } from '../src/main-build.js';
import type { Clock, Gh, Host } from '../src/ports.js';
import {
  doneStatus,
  firstStep,
  mergeOne,
  type QueueCurrent,
  type QueueState,
  runQueue,
} from '../src/queue.js';

// External pull requests (`studio merge`) through the same queue, and the runner-load gate.

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

type Res = { code?: number; stdout?: string; stderr?: string };
type Rule = { prefix: string; responses: Res[] };

function mkConfig(runnerLoad?: Record<string, unknown>): StudioConfig {
  return studioConfigSchema.parse({
    studio: 1,
    primaryRepo: 'org/app',
    repos: ['org/app'],
    ci: {
      provider: 'github',
      runners: 'github-hosted',
      runnerLabels: [],
      capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 30 },
    },
    merge: {
      strategy: 'studio-queue',
      contractPaths: [],
      method: 'squash',
      ...(runnerLoad === undefined ? {} : { runnerLoad }),
    },
    roles: { builder: { model: 'm', wip: 2 } },
    ownerOnly: [],
    deployCommands: [],
  });
}

const RUNNER_LOAD = { org: 'pool-org', namePattern: '^pool-[0-9]', maxBusy: 5 };

/** Runner rows as `gh api --jq` prints them: `busy` busy ones and one idle. */
const runners = (busy: number) =>
  [
    ...Array.from({ length: busy }, (_, i) => `pool-${i}\tonline\ttrue`),
    'pool-90\tonline\tfalse',
    'other-1\tonline\ttrue',
  ].join('\n');

function fakeGh(rules: Rule[], api: (path: string) => string = () => '0') {
  const calls: string[] = [];
  const idx = new Map<string, number>();
  const gh: Gh = {
    async api(path) {
      calls.push(`api ${path}`);
      // GitHub-hosted capacity reads run counts; only the runner list goes to `api`.
      return path.includes('/actions/runners') ? api(path) : '0';
    },
    async run(args) {
      const line = args.join(' ');
      calls.push(line);
      const rule = rules.find((r) => line.startsWith(r.prefix));
      if (!rule) throw new Error(`unscripted gh call: ${line}`);
      const i = idx.get(rule.prefix) ?? 0;
      idx.set(rule.prefix, i + 1);
      const r = rule.responses[Math.min(i, rule.responses.length - 1)] as Res;
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
  return { gh, calls };
}

function fakeClock() {
  let t = Date.parse('2026-10-31T10:00:00Z');
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => new Date(t),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { clock, sleeps };
}

const host: Host = { loadAvg1: () => 0, cpuCount: () => 4 };
const CHK = 'pr checks 5 --repo org/app --json name,bucket,workflow';
const VIEW = 'pr view 5 --repo org/app --json headRefOid,state,mergeable';
const BASE = 'pr view 5 --repo org/app --json baseRefName';
const RUNS = 'run list --repo org/app --branch main --event push';
const MERGE = 'pr merge 5 --repo org/app';
const MC = 'pr view 5 --repo org/app --json mergeCommit';

const view = (head: string, state = 'OPEN'): Res => ({
  stdout: JSON.stringify({ headRefOid: head, state, mergeable: 'MERGEABLE' }),
});
const checks = (bucket: string): Res => ({
  code: bucket === 'pending' ? 8 : 0,
  stdout: JSON.stringify([{ name: 'ci', bucket }]),
});
const noRequired: Res = { code: 1, stderr: 'no required checks reported on the branch' };
const runsDone: Res = {
  stdout: JSON.stringify([
    { status: 'completed', conclusion: 'success', headSha: H1, workflowName: 'CI' },
  ]),
};
const runsBusy: Res = {
  stdout: JSON.stringify([
    { status: 'in_progress', conclusion: null, headSha: H1, workflowName: 'CI' },
  ]),
};

/** A green, mergeable external pull request; `extra` rules go first and win. */
const rulesWith = (extra: Rule[]): Rule[] => [
  ...extra,
  { prefix: VIEW, responses: [view(H1)] },
  { prefix: `${CHK} --required`, responses: [noRequired] },
  { prefix: CHK, responses: [checks('pass')] },
  { prefix: BASE, responses: [{ stdout: JSON.stringify({ baseRefName: 'main' }) }] },
  { prefix: RUNS, responses: [runsDone] },
  { prefix: MERGE, responses: [{}] },
  { prefix: MC, responses: [{ stdout: JSON.stringify({ mergeCommit: { oid: 'e'.repeat(40) } }) }] },
];

const MARK = { by: 'lead', at: '2026-10-31T09:00:00Z', head: H1 };
const external = (followHead = false): QueueCurrent => ({
  pr: 5,
  repo: 'org/app',
  external: followHead ? { ...MARK, followHead: true as const } : MARK,
  step: 'checks',
});

async function run(
  rules: Rule[],
  o: {
    runnerLoad?: Record<string, unknown>;
    api?: (path: string) => string;
    timeoutMs?: number;
    followHead?: boolean;
  } = {},
) {
  const g = fakeGh(rules, o.api);
  const c = fakeClock();
  const result = await mergeOne(
    external(o.followHead),
    mkConfig(o.runnerLoad),
    { gh: g.gh, clock: c.clock, host },
    () => {},
    o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs },
  );
  return { result, calls: g.calls, sleeps: c.sleeps };
}

const merges = (calls: string[]) => calls.filter((c) => c.startsWith(MERGE));

describe('external entries', () => {
  it('start at the checks step: Studio never updates a branch that is not its own', () => {
    expect(firstStep({ pr: 5, repo: 'org/app' })).toBe('update');
    expect(firstStep({ pr: 5, repo: 'org/app', external: MARK })).toBe('checks');
  });

  it('pending then green: waits, then squash-merges the head with --match-head-commit', async () => {
    const r = await run(
      rulesWith([
        { prefix: CHK, responses: [checks('pending'), checks('pending'), checks('pass')] },
      ]),
    );
    expect(r.result.result).toBe('merged');
    expect(r.calls.some((c) => c.startsWith('pr update-branch'))).toBe(false);
    expect(merges(r.calls)).toEqual([`${MERGE} --squash --match-head-commit ${H1}`]);
  });

  it('a failed check stops the entry: failed with the check, no merge', async () => {
    const r = await run(rulesWith([{ prefix: CHK, responses: [checks('fail')] }]));
    expect(r.result).toMatchObject({ result: 'failed', reason: 'check ci failed' });
    expect(r.result.timeout).toBeUndefined();
    expect(merges(r.calls)).toEqual([]);
  });

  it('default: a head that moved since enqueue fails the entry before the merge', async () => {
    // Checks see H1 before and after the poll; the merge step reads H2.
    const r = await run(rulesWith([{ prefix: VIEW, responses: [view(H1), view(H1), view(H2)] }]));
    expect(r.result).toEqual({
      result: 'failed',
      reason: `head moved since enqueue: ${H1} -> ${H2}; re-run studio merge`,
    });
    expect(merges(r.calls)).toEqual([]);
  });

  it('default: a head that moved before the checks were read fails at once', async () => {
    const r = await run(rulesWith([{ prefix: VIEW, responses: [view(H2)] }]));
    expect(r.result.reason).toBe(`head moved since enqueue: ${H1} -> ${H2}; re-run studio merge`);
    expect(r.calls.some((c) => c.startsWith(CHK))).toBe(false);
    expect(merges(r.calls)).toEqual([]);
  });

  it('default: GitHub refusing the pinned head fails with the new head named', async () => {
    const r = await run(
      rulesWith([
        { prefix: VIEW, responses: [view(H1), view(H1), view(H1), view(H2)] },
        { prefix: MERGE, responses: [{ code: 1, stderr: 'Head branch was modified' }] },
      ]),
    );
    expect(r.result.reason).toBe(`head moved since enqueue: ${H1} -> ${H2}; re-run studio merge`);
    expect(merges(r.calls)).toHaveLength(1);
  });

  it('--follow-head: a moved head is read again, its checks awaited, and pinned', async () => {
    const r = await run(
      rulesWith([
        { prefix: VIEW, responses: [view(H1), view(H1), view(H2)] },
        {
          prefix: CHK,
          responses: [checks('pass'), checks('pass'), checks('pending'), checks('pass')],
        },
      ]),
      { followHead: true },
    );
    expect(r.result.result).toBe('merged');
    expect(merges(r.calls)).toEqual([`${MERGE} --squash --match-head-commit ${H2}`]);
  });

  it('waits while a push build runs on the base branch, then merges', async () => {
    const r = await run(rulesWith([{ prefix: RUNS, responses: [runsBusy, runsBusy, runsDone] }]));
    expect(r.result.result).toBe('merged');
    expect(r.calls.filter((c) => c.startsWith(RUNS))).toHaveLength(3);
    expect(r.sleeps.filter((ms) => ms === 60_000)).toHaveLength(2);
  });

  it('an unreadable base build counts as running: waits until the time limit', async () => {
    const r = await run(rulesWith([{ prefix: RUNS, responses: [{ code: 1 }] }]), {
      timeoutMs: 10 * 60_000,
    });
    expect(r.result).toMatchObject({ result: 'failed', timeout: true });
    expect(r.result.reason).toMatch(/push build/);
    expect(merges(r.calls)).toEqual([]);
  });

  it('times out while the checks stay pending: TIMEOUT, no merge', async () => {
    const r = await run(rulesWith([{ prefix: CHK, responses: [checks('pending')] }]), {
      timeoutMs: 30 * 60_000,
    });
    expect(r.result).toEqual({ result: 'failed', reason: 'checks timed out', timeout: true });
    expect(doneStatus(r.result)).toBe('TIMEOUT');
    expect(merges(r.calls)).toEqual([]);
  });

  it('runQueue records the external mark and the timeout flag on the done entry', async () => {
    const g = fakeGh(rulesWith([{ prefix: CHK, responses: [checks('pending')] }]));
    const c = fakeClock();
    const mark = MARK;
    const state: QueueState = { pending: [{ pr: 5, repo: 'org/app', external: mark }], done: [] };
    await runQueue(state, mkConfig(), { gh: g.gh, clock: c.clock, host }, () => {}, {
      timeoutMs: 30 * 60_000,
      stateRoot: undefined,
    });
    expect(state.done[0]).toMatchObject({ pr: 5, external: mark, timeout: true });
    expect(g.calls.some((x) => x.startsWith('pr update-branch'))).toBe(false);
  });
});

describe('merge.runner_load', () => {
  it('is optional, defaults samples 2 and interval 30 s, and refuses a bad pattern', () => {
    expect(mkConfig().merge.runnerLoad).toBeUndefined();
    expect(mkConfig(RUNNER_LOAD).merge.runnerLoad).toEqual({
      ...RUNNER_LOAD,
      samples: 2,
      intervalS: 30,
    });
    expect(() => mkConfig({ ...RUNNER_LOAD, namePattern: '(' })).toThrow(/regular expression/);
    expect(() => mkConfig({ ...RUNNER_LOAD, org: 'a/b' })).toThrow();
    expect(() => mkConfig({ ...RUNNER_LOAD, maxBusy: -1 })).toThrow();
    expect(() => mkConfig({ ...RUNNER_LOAD, extra: 1 })).toThrow();
  });

  it('reads the named organisation twice, interval apart, counting matching busy runners', async () => {
    const g = fakeGh([], () => runners(5));
    const c = fakeClock();
    const rule = mkConfig(RUNNER_LOAD).merge.runnerLoad;
    if (rule === undefined) throw new Error('no rule');
    const r = await readRunnerLoad(rule, { gh: g.gh, clock: c.clock });
    expect(r).toEqual({ ok: true, busy: 5 });
    expect(g.calls).toEqual([
      'api /orgs/pool-org/actions/runners',
      'api /orgs/pool-org/actions/runners',
    ]);
    expect(c.sleeps).toEqual([30_000]);
  });

  it('an API error counts as busy and says why', async () => {
    const g = fakeGh([], () => {
      throw new Error('HTTP 502');
    });
    const rule = mkConfig(RUNNER_LOAD).merge.runnerLoad;
    if (rule === undefined) throw new Error('no rule');
    const r = await readRunnerLoad(rule, { gh: g.gh, clock: fakeClock().clock });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/502/);
  });

  it('too busy: the queue waits instead of merging, and merges once the load fell', async () => {
    let reads = 0;
    const r = await run(rulesWith([]), {
      runnerLoad: RUNNER_LOAD,
      api: () => runners(++reads <= 2 ? 6 : 3),
    });
    expect(r.result.result).toBe('merged');
    // Two busy first reads (no second sample), then two good ones 30 s apart.
    expect(reads).toBe(4);
    expect(r.sleeps).toContain(30_000);
    expect(merges(r.calls)).toHaveLength(1);
  });

  it('a runner API error holds the merge until the time limit: TIMEOUT', async () => {
    const r = await run(rulesWith([]), {
      runnerLoad: RUNNER_LOAD,
      api: () => {
        throw new Error('HTTP 403');
      },
      timeoutMs: 10 * 60_000,
    });
    expect(r.result).toMatchObject({ result: 'failed', timeout: true });
    expect(r.result.reason).toMatch(/runner load/);
    expect(r.result.reason).toMatch(/403/);
    expect(merges(r.calls)).toEqual([]);
  });

  it('applies to board item merges too', async () => {
    const g = fakeGh(
      [
        { prefix: 'pr update-branch 5', responses: [{}] },
        ...rulesWith([]),
        { prefix: 'pr view 5 --repo org/app --json commits', responses: [{ stdout: '' }] },
      ],
      () => runners(8),
    );
    const c = fakeClock();
    const result = await mergeOne(
      { pr: 5, repo: 'org/app', item: 'APP-1', step: 'update' },
      mkConfig(RUNNER_LOAD),
      { gh: g.gh, clock: c.clock, host },
      () => {},
      { timeoutMs: 10 * 60_000 },
    );
    expect(result).toMatchObject({ result: 'failed', timeout: true });
    expect(merges(g.calls)).toEqual([]);
    // An item merge does not read the base build: only external entries wait for it.
    expect(g.calls.some((x) => x.startsWith(RUNS))).toBe(false);
  });
});

describe('branchBuildRunning', () => {
  it('idle without any push build, running while one runs, unknown when unreadable', async () => {
    const at = (r: Res) => fakeGh([{ prefix: RUNS, responses: [r] }]).gh;
    expect(await branchBuildRunning(at({ stdout: '[]' }), 'org/app', 'main')).toBe('idle');
    expect(await branchBuildRunning(at(runsDone), 'org/app', 'main')).toBe('idle');
    expect(await branchBuildRunning(at(runsBusy), 'org/app', 'main')).toBe('running');
    expect(await branchBuildRunning(at({ code: 1 }), 'org/app', 'main')).toBe('unknown');
    expect(await branchBuildRunning(at({ stdout: 'x' }), 'org/app', 'main')).toBe('unknown');
  });
});
