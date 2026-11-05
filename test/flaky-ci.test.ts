import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Board } from '../src/board.js';
import { jobArea, readWorkflowsAt, type Workflows } from '../src/ci-jobs.js';
import { studioConfigSchema } from '../src/config.js';
import { listFlaky } from '../src/flaky.js';
import {
  type CiEvents,
  ciFailurePolicy,
  FLAKY_NOTE,
  RERUNS_FILE,
  unrelatedFailure,
  withFlakyItem,
} from '../src/flaky-ci.js';
import type { Gh, Git } from '../src/ports.js';
import { mergeOne, type QueueCurrent } from '../src/queue.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'studio-flaky-ci-')));
  roots.push(d);
  return d;
};

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

const WORKFLOW = `name: CI
on: pull_request
jobs:
  desktop-tests:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: desktop } }
    steps:
      - run: pnpm test
  api-tests:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: ./api/ } }
    strategy: { matrix: { os: [a, b] } }
    steps:
      - run: cargo test
  root-tests:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
  stepdir:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: web } }
    steps:
      - run: pnpm test
        working-directory: shared
`;

/** A git that holds one workflow file at every commit. */
const fakeGit = (text = WORKFLOW): Git => ({
  async run(_cwd, args) {
    const a = args.filter((x) => x !== '--no-replace-objects');
    if (a[0] === 'ls-tree') return '.github/workflows/ci.yml\0';
    if (a[0] === 'cat-file') return text;
    throw new Error(`unexpected git ${a.join(' ')}`);
  },
});
const workflows = () => readWorkflowsAt(fakeGit(), '/x', H1);

describe('jobArea', () => {
  it('is the working directory of a job of a pull_request workflow, legs included', async () => {
    const w = await workflows();
    expect(jobArea(w, { name: 'desktop-tests', workflow: 'CI' })).toBe('desktop');
    expect(jobArea(w, { name: 'api-tests (a)', workflow: 'CI' })).toBe('api');
  });

  it('is unknown without a working directory, with a step of its own, or another workflow', async () => {
    const w = await workflows();
    expect(jobArea(w, { name: 'root-tests', workflow: 'CI' })).toBeUndefined();
    expect(jobArea(w, { name: 'stepdir', workflow: 'CI' })).toBeUndefined();
    expect(jobArea(w, { name: 'desktop-tests', workflow: 'Other' })).toBeUndefined();
    expect(jobArea(w, { name: 'desktop-tests' })).toBeUndefined();
  });
});

describe('unrelatedFailure', () => {
  const base = { area: 'desktop', changed: ['api/src/lib.rs'], itemPaths: ['api/**'] };
  it('holds only when no changed file and no item path reaches the job area', () => {
    expect(unrelatedFailure(base)).toBe(true);
    expect(unrelatedFailure({ ...base, changed: ['desktop/src/a.ts'] })).toBe(false);
    expect(unrelatedFailure({ ...base, changed: ['package.json'] })).toBe(false);
    expect(unrelatedFailure({ ...base, changed: ['.github/workflows/ci.yml'] })).toBe(false);
    expect(unrelatedFailure({ ...base, itemPaths: ['desktop/**'] })).toBe(false);
    expect(unrelatedFailure({ ...base, itemPaths: ['**/*.ts'] })).toBe(false);
  });
  it('is unsure, so related, without an area or the changed files', () => {
    expect(unrelatedFailure({ ...base, area: undefined })).toBe(false);
    expect(unrelatedFailure({ ...base, changed: undefined })).toBe(false);
    expect(unrelatedFailure({ ...base, changed: [] })).toBe(false);
  });
});

type Check = { name: string; bucket: string; workflow?: string; link?: string };
const link = (run: number, job: number, repo = 'org/app') =>
  `https://github.com/${repo}/actions/runs/${run}/job/${job}`;
const failing = (run = 100, job = 1000, name = 'desktop-tests', repo = 'org/app'): Check => ({
  name,
  bucket: 'fail',
  workflow: 'CI',
  link: link(run, job, repo),
});

/** A gh whose checks and changed files the test sets per PR. */
function fakeGh() {
  const calls: string[] = [];
  const checks = new Map<number, Check[]>();
  const files = new Map<number, string[]>();
  const rerun = { code: 0, stderr: '' };
  const gh: Gh = {
    async api(path) {
      calls.push(`api ${path}`);
      const pr = Number(/pulls\/(\d+)\/files/.exec(path)?.[1]);
      return (files.get(pr) ?? []).join('\n');
    },
    async run(args) {
      const line = args.join(' ');
      calls.push(line);
      if (args[0] === 'pr' && args[1] === 'checks') {
        const rows = checks.get(Number(args[2])) ?? [];
        if (line.endsWith('--required')) {
          return { code: 1, stdout: '', stderr: 'no required checks reported' };
        }
        return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
      }
      if (args[0] === 'run' && args[1] === 'rerun')
        return { code: rerun.code, stdout: '', stderr: rerun.stderr };
      throw new Error(`unscripted gh ${line}`);
    },
  };
  return { gh, calls, checks, files, rerun };
}

function policy(o: { free?: { v: boolean }; paths?: string[]; area?: string } = {}) {
  const root = tmp();
  const g = fakeGh();
  let t = Date.parse('2026-11-05T10:00:00Z');
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const free = o.free ?? { v: true };
  let board: Board = { items: [] } as unknown as Board;
  const events: CiEvents = { reruns: [], flakyItems: [] };
  const log: string[] = [];
  let w: Workflows | undefined;
  const p = ciFailurePolicy({
    stateRoot: root,
    gh: g.gh,
    workflowsAt: async () => {
      w ??= await workflows();
      return w;
    },
    capacityFree: async () => free.v,
    now: clock.now,
    itemPaths: () => o.paths ?? ['api/**'],
    addFlakyItem: async (test, repo, runs) => {
      const r = withFlakyItem(board, test, repo, runs);
      board = r.board;
      return r.id;
    },
    events,
    log: (m) => log.push(m),
  });
  const reruns = () => g.calls.filter((c) => c.startsWith('run rerun'));
  return { p, g, root, clock, free, events, log, reruns, board: () => board };
}

const ref = (pr: number) => ({ repo: 'org/app', pr, item: `APP-${pr}` });

describe('ciFailurePolicy', () => {
  it('reruns the failed jobs of an unrelated failure once on the same commit, then counts it flaky', async () => {
    const s = policy();
    s.g.checks.set(5, [failing(100, 1000), { name: 'lint', bucket: 'pass', workflow: 'CI' }]);
    s.g.files.set(5, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(5), H1)).toBe('rerun');
    expect(s.reruns()).toEqual(['run rerun 100 --failed --repo org/app']);
    expect(s.events.reruns).toEqual([
      { item: 'APP-5', repo: 'org/app', pr: 5, sha: H1, jobs: ['CI / desktop-tests'], runs: [100] },
    ]);
    // The old attempt still shows right after: wait, no second rerun.
    expect(await s.p.failed(ref(5), H1)).toBe('wait');
    s.p.passed(ref(5), H1);
    expect(listFlaky(s.root)).toEqual([
      expect.objectContaining({ test: 'org/app: CI / desktop-tests', count: 1, lastSha: H1 }),
    ]);
    expect(s.reruns()).toHaveLength(1);
  });

  it('never reruns a commit twice: a failure of the rerun is a real failure', async () => {
    const s = policy();
    s.g.checks.set(5, [failing(100, 1000)]);
    s.g.files.set(5, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(5), H1)).toBe('rerun');
    // The rerun's own attempt (a new job id) failed too.
    s.g.checks.set(5, [failing(100, 1001)]);
    expect(await s.p.failed(ref(5), H1)).toBe('fail');
    expect(await s.p.failed(ref(5), H1)).toBe('fail');
    expect(s.reruns()).toHaveLength(1);
    expect(listFlaky(s.root)).toEqual([]);
    // Also a fresh process with the same ledger does not rerun it.
    const ledger = JSON.parse(readFileSync(join(s.root, RERUNS_FILE), 'utf8'));
    expect(ledger).toEqual([expect.objectContaining({ sha: H1, outcome: 'fail' })]);
  });

  it('old failed jobs that never clear count as a real failure after the settle time', async () => {
    const s = policy();
    s.g.checks.set(5, [failing(100, 1000)]);
    s.g.files.set(5, ['api/src/lib.rs']);
    await s.p.failed(ref(5), H1);
    s.clock.advance(11 * 60_000);
    expect(await s.p.failed(ref(5), H1)).toBe('fail');
  });

  it('a failure in the area the pull request changed is related: no rerun', async () => {
    const s = policy();
    s.g.checks.set(5, [failing()]);
    s.g.files.set(5, ['desktop/src/main.ts']);
    expect(await s.p.failed(ref(5), H1)).toBe('fail');
    expect(s.reruns()).toEqual([]);
  });

  it('a job Studio cannot place, or a cancelled check, is treated as related', async () => {
    const s = policy();
    s.g.checks.set(5, [failing(100, 1000, 'root-tests')]);
    s.g.files.set(5, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(5), H1)).toBe('fail');
    s.g.checks.set(6, [failing(), { name: 'x', bucket: 'cancel', workflow: 'CI' }]);
    s.g.files.set(6, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(6), H2)).toBe('fail');
    expect(s.reruns()).toEqual([]);
  });

  it('waits for free runners before the rerun', async () => {
    const free = { v: false };
    const s = policy({ free });
    s.g.checks.set(5, [failing()]);
    s.g.files.set(5, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(5), H1)).toBe('wait');
    expect(s.reruns()).toEqual([]);
    free.v = true;
    expect(await s.p.failed(ref(5), H1)).toBe('rerun');
    expect(s.reruns()).toHaveLength(1);
  });

  it('a second failure of the same job within 14 days adds exactly one item to find the cause', async () => {
    const s = policy();
    for (const [pr, head, run] of [
      [5, H1, 100],
      [6, H2, 200],
      [7, 'c'.repeat(40), 300],
    ] as const) {
      s.g.checks.set(pr, [failing(run, run * 10)]);
      s.g.files.set(pr, ['api/src/lib.rs']);
      expect(await s.p.failed(ref(pr), head)).toBe('rerun');
      s.p.passed(ref(pr), head);
      s.clock.advance(24 * 60 * 60_000);
    }
    const items = s.board().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'APP-1',
      title: 'Find the cause of flaky CI / desktop-tests',
      type: 'fix',
      role: 'builder',
      status: 'ready',
      notes: [`${FLAKY_NOTE}CI / desktop-tests`, 'flaky runs: 100, 200'],
    });
    expect(items[0]?.dod).toEqual([
      'The cause of the flaky failures of CI / desktop-tests is found and written down',
      'The test is deterministic under load (busy runners), shown by repeated runs',
      'No timeout is raised without a measured cause',
    ]);
    expect(s.events.flakyItems).toEqual([{ item: 'APP-1', test: 'CI / desktop-tests' }]);
  });

  it('failures more than 14 days apart add no item', async () => {
    const s = policy();
    s.g.checks.set(5, [failing(100, 1000)]);
    s.g.files.set(5, ['api/src/lib.rs']);
    await s.p.failed(ref(5), H1);
    s.p.passed(ref(5), H1);
    s.clock.advance(15 * 24 * 60 * 60_000);
    s.g.checks.set(6, [failing(200, 2000)]);
    s.g.files.set(6, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(6), H2)).toBe('rerun');
    expect(s.board().items).toEqual([]);
  });

  it('a fast failure next to a slow pending sibling waits, then reruns once after completion', async () => {
    const s = policy();
    const slow: Check = {
      name: 'api-tests (a)',
      bucket: 'pending',
      workflow: 'CI',
      link: link(100, 1001),
    };
    s.g.checks.set(5, [failing(100, 1000), slow]);
    s.g.files.set(5, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(5), H1)).toBe('wait');
    expect(await s.p.failed(ref(5), H1)).toBe('wait');
    expect(s.reruns()).toEqual([]);
    expect(() => readFileSync(join(s.root, RERUNS_FILE), 'utf8')).toThrow();
    s.g.checks.set(5, [failing(100, 1000), { ...slow, bucket: 'pass' }]);
    expect(await s.p.failed(ref(5), H1)).toBe('rerun');
    expect(s.reruns()).toEqual(['run rerun 100 --failed --repo org/app']);
  });

  it('a rerun GitHub refuses for now (still running, 403, 422) spends no allowance', async () => {
    const s = policy();
    s.g.checks.set(5, [failing()]);
    s.g.files.set(5, ['api/src/lib.rs']);
    for (const stderr of [
      'run 100 cannot be rerun; This workflow is already running',
      'HTTP 403: Forbidden',
      'HTTP 422: Unprocessable Entity',
    ]) {
      s.g.rerun.code = 1;
      s.g.rerun.stderr = stderr;
      expect(await s.p.failed(ref(5), H1)).toBe('wait');
    }
    expect(JSON.parse(readFileSync(join(s.root, RERUNS_FILE), 'utf8'))).toEqual([]);
    s.g.rerun.code = 0;
    expect(await s.p.failed(ref(5), H1)).toBe('rerun');
    expect(s.reruns()).toHaveLength(4);
    expect(s.events.reruns).toHaveLength(1);
  });

  it('an earlier job that was red again after its rerun does not count toward the item', async () => {
    const s = policy();
    s.g.checks.set(5, [failing(100, 1000)]);
    s.g.files.set(5, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(5), H1)).toBe('rerun');
    s.g.checks.set(5, [failing(100, 1001)]);
    expect(await s.p.failed(ref(5), H1)).toBe('fail');
    s.clock.advance(24 * 60 * 60_000);
    s.g.checks.set(6, [failing(200, 2000)]);
    s.g.files.set(6, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(6), H2)).toBe('rerun');
    expect(s.board().items).toEqual([]);
  });

  it('the same job name in two repositories is two jobs: ledger and item per repository', async () => {
    const s = policy();
    const web = (pr: number) => ({ repo: 'org/web', pr, item: `WEB-${pr}` });
    s.g.checks.set(5, [failing(100, 1000)]);
    s.g.files.set(5, ['api/src/lib.rs']);
    expect(await s.p.failed(ref(5), H1)).toBe('rerun');
    s.p.passed(ref(5), H1);
    s.clock.advance(60 * 60_000);
    s.g.checks.set(8, [failing(300, 3000, 'desktop-tests', 'org/web')]);
    s.g.files.set(8, ['api/src/lib.rs']);
    expect(await s.p.failed(web(8), H2)).toBe('rerun');
    s.p.passed(web(8), H2);
    expect(s.board().items).toEqual([]);
    expect(
      listFlaky(s.root)
        .map((e) => e.test)
        .sort(),
    ).toEqual(['org/app: CI / desktop-tests', 'org/web: CI / desktop-tests']);
  });

  it('a failed rerun call fails the entry and keeps the commit from another try', async () => {
    const s = policy();
    s.g.checks.set(5, [failing()]);
    s.g.files.set(5, ['api/src/lib.rs']);
    s.g.rerun.code = 1;
    expect(await s.p.failed(ref(5), H1)).toBe('fail');
    s.g.rerun.code = 0;
    expect(await s.p.failed(ref(5), H1)).toBe('fail');
    expect(s.reruns()).toHaveLength(1);
  });
});

describe('withFlakyItem', () => {
  it('adds no second item while one for the job is open, and a new one after it merged', () => {
    const empty = { items: [] } as unknown as Board;
    const a = withFlakyItem(empty, 'CI / x', 'org/app', [1]);
    expect(a.id).toBe('APP-1');
    expect(withFlakyItem(a.board, 'CI / x', 'org/app', [2]).id).toBeUndefined();
    const merged = {
      ...a.board,
      items: a.board.items.map((i) => ({ ...i, status: 'merged' as const })),
    };
    expect(withFlakyItem(merged, 'CI / x', 'org/app', [3]).id).toBe('APP-2');
  });
});

describe('mergeOne with the policy', () => {
  it('a rerun keeps the queue waiting; green checks then merge', async () => {
    const s = policy();
    s.g.files.set(5, ['api/src/lib.rs']);
    const config = studioConfigSchema.parse({
      studio: 1,
      primaryRepo: 'org/app',
      repos: ['org/app'],
      ci: {
        provider: 'github',
        runners: 'github-hosted',
        runnerLabels: [],
        capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 0 },
      },
      merge: { strategy: 'studio-queue', contractPaths: [], method: 'squash' },
      roles: { builder: { model: 'm', wip: 2 } },
      ownerOnly: [],
      deployCommands: [],
    });
    let polls = 0;
    const base = s.g.gh;
    const gh: Gh = {
      api: async (path, jq, o) => (path.includes('actions/runs') ? '0' : base.api(path, jq, o)),
      async run(args, o) {
        const line = args.join(' ');
        if (line.startsWith('pr view 5 --repo org/app --json headRefOid')) {
          return {
            code: 0,
            stdout: JSON.stringify({ headRefOid: H1, state: 'OPEN', mergeable: 'MERGEABLE' }),
            stderr: '',
          };
        }
        if (line.startsWith('pr view 5 --repo org/app --json mergeCommit')) {
          return { code: 0, stdout: '{"mergeCommit":null}', stderr: '' };
        }
        if (
          line.startsWith('pr checks') &&
          !line.includes('link') &&
          !line.endsWith('--required')
        ) {
          polls++;
          // Failed, then the rerun runs, then it passed.
          s.g.checks.set(
            5,
            polls === 1
              ? [failing()]
              : polls === 2
                ? [{ ...failing(100, 1001), bucket: 'pending' }]
                : [{ ...failing(100, 1001), bucket: 'pass' }],
          );
        }
        if (line.startsWith('pr merge')) return { code: 0, stdout: '', stderr: '' };
        return base.run(args, o);
      },
    };
    const entry: QueueCurrent = { pr: 5, repo: 'org/app', item: 'APP-5', step: 'checks' };
    let t = Date.parse('2026-11-05T10:00:00Z');
    const result = await mergeOne(
      entry,
      config,
      {
        gh,
        clock: {
          now: () => new Date(t),
          sleep: async (ms) => {
            t += ms;
          },
        },
        host: { loadAvg1: () => 0, cpuCount: () => 4 },
      },
      () => {},
      {
        onChecksFailed: (e, head) => s.p.failed(e, head),
        onChecksPassed: (e, head) => s.p.passed(e, head),
      },
    );
    expect(result.result).toBe('merged');
    expect(s.reruns()).toEqual(['run rerun 100 --failed --repo org/app']);
    expect(listFlaky(s.root)).toEqual([
      expect.objectContaining({ test: 'org/app: CI / desktop-tests', count: 1 }),
    ]);
  });

  it('without the policy a failed check fails the entry as before', async () => {
    const s = policy();
    s.g.checks.set(5, [failing()]);
    const gh: Gh = {
      api: s.g.gh.api,
      async run(args, o) {
        if (args.join(' ').startsWith('pr view 5')) {
          return {
            code: 0,
            stdout: JSON.stringify({ headRefOid: H1, state: 'OPEN', mergeable: 'MERGEABLE' }),
            stderr: '',
          };
        }
        return s.g.gh.run(args, o);
      },
    };
    const config = studioConfigSchema.parse({
      studio: 1,
      primaryRepo: 'org/app',
      repos: ['org/app'],
      ci: {
        provider: 'github',
        runners: 'github-hosted',
        runnerLabels: [],
        capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 0 },
      },
      merge: { strategy: 'studio-queue', contractPaths: [], method: 'squash' },
      roles: { builder: { model: 'm', wip: 2 } },
      ownerOnly: [],
      deployCommands: [],
    });
    const r = await mergeOne(
      { pr: 5, repo: 'org/app', step: 'checks' },
      config,
      {
        gh,
        clock: { now: () => new Date(), sleep: async () => {} },
        host: { loadAvg1: () => 0, cpuCount: () => 4 },
      },
      () => {},
    );
    expect(r).toEqual({ result: 'failed', reason: 'check desktop-tests failed' });
    expect(s.reruns()).toEqual([]);
  });
});
