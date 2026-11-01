import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import type { Clock, Gh, Host } from '../src/ports.js';
import {
  acquireQueueRunLock,
  enqueue,
  installSignalRelease,
  loadQueue,
  mergeOne,
  type QueueCurrent,
  type QueueState,
  releaseOnSignal,
  runQueue,
  saveQueue,
  takeNextPending,
  updateQueue,
} from '../src/queue.js';

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
const tmpRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'studio-queue-'));
  tmpRoots.push(d);
  return d;
};

function mkConfig(method: 'merge' | 'squash' | 'rebase' = 'squash'): StudioConfig {
  return studioConfigSchema.parse({
    studio: 1,
    primaryRepo: 'org/app',
    repos: ['org/app'],
    ci: {
      provider: 'github',
      runners: 'self-hosted',
      runnerLabels: [],
      runnerNamePattern: '^pool-[0-9]',
      capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 30 },
    },
    merge: { strategy: 'studio-queue', contractPaths: [], method },
    roles: { builder: { model: 'm', wip: 2 } },
    ownerOnly: [],
    deployCommands: [],
  });
}

type Res = { code?: number; stdout?: string; stderr?: string };
type Rule = { prefix: string; responses: Res[] };

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);
const H4 = 'd'.repeat(40);
const MERGE_SHA = 'e'.repeat(40);

const view = (head: string, state = 'OPEN', mergeable = 'MERGEABLE'): Res => ({
  stdout: JSON.stringify({ headRefOid: head, state, mergeable }),
});
const checks = (...rows: [string, string][]): Res => ({
  code: rows.some(([, b]) => b === 'pending') ? 8 : 0,
  stdout: JSON.stringify(rows.map(([name, bucket]) => ({ name, bucket }))),
});
const noRequired: Res = {
  code: 1,
  stdout: '',
  stderr: 'no required checks reported on the branch',
};

function fakeGh(rules: Rule[], busy = { n: 0 }) {
  const calls: string[] = [];
  const idx = new Map<string, number>();
  const gh: Gh = {
    async api(path) {
      calls.push(`api ${path}`);
      if (path.includes('/actions/runners')) {
        const rows = Array.from({ length: busy.n }, (_, i) => `pool-${i}\tonline\ttrue`);
        // An offline runner keeps the list non-empty: an empty list fails capacity closed.
        return [...rows, 'pool-99\toffline\tfalse'].join('\n');
      }
      throw new Error(`unexpected api ${path}`);
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

function fakeClock(onSleep?: (ms: number, total: number) => void) {
  let t = Date.parse('2026-10-31T10:00:00Z');
  let total = 0;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => new Date(t),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
      total += ms;
      onSleep?.(ms, total);
    },
  };
  return { clock, sleeps };
}

const host: Host = { loadAvg1: () => 0, cpuCount: () => 4 };
const CHK = 'pr checks 5 --repo org/app --json name,bucket';
const REQ = `${CHK} --required`;
const VIEW = 'pr view 5 --repo org/app --json headRefOid,state,mergeable';
const MERGE = 'pr merge 5 --repo org/app';
const MC = 'pr view 5 --repo org/app --json mergeCommit';
const UPD = 'pr update-branch 5 --repo org/app';
const COMMITS = 'pr view 5 --repo org/app --json commits';

/** Rules for a PR whose update, merge and merge-commit lookups succeed. */
const base = (extra: Rule[]): Rule[] => [
  ...extra,
  { prefix: UPD, responses: [{}] },
  { prefix: MERGE, responses: [{}] },
  { prefix: MC, responses: [{ stdout: JSON.stringify({ mergeCommit: { oid: MERGE_SHA } }) }] },
  { prefix: COMMITS, responses: [{ stdout: '2026-10-30T08:00:00Z\n' }] },
];

const entry = (): QueueCurrent => ({ pr: 5, repo: 'org/app', step: 'update' });
const mergeCalls = (calls: string[]) => calls.filter((c) => c.startsWith(MERGE));

async function run(
  rules: Rule[],
  opts: {
    busy?: { n: number };
    onSleep?: (ms: number, t: number) => void;
    entry?: QueueCurrent;
    method?: 'merge' | 'squash' | 'rebase';
  } = {},
) {
  const g = fakeGh(rules, opts.busy);
  const c = fakeClock(opts.onSleep);
  const persisted: QueueCurrent[] = [];
  const result = await mergeOne(
    opts.entry ?? entry(),
    mkConfig(opts.method),
    { gh: g.gh, clock: c.clock, host },
    (cur) => persisted.push({ ...cur }),
  );
  return { result, calls: g.calls, sleeps: c.sleeps, persisted };
}

describe('mergeOne', () => {
  it('waits while any check pending even after watch returns', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        {
          prefix: CHK,
          responses: [
            checks(['a', 'pass'], ['b', 'pending']),
            checks(['a', 'pass'], ['b', 'pending']),
            checks(['a', 'pass'], ['b', 'pass']),
          ],
        },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('merged');
    // two polling sleeps plus the 30 s gap of the capacity double read
    expect(r.sleeps.filter((s) => s === 30_000)).toHaveLength(3);
    expect(r.calls.filter((c) => c.startsWith(CHK) && !c.endsWith('--required'))).toHaveLength(4);
  });

  it('fails when a check is fail', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'], ['b', 'fail'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result).toMatchObject({ result: 'failed' });
    expect(r.result.reason).toContain('b');
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('fails when a check is cancel', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'cancel'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('failed');
  });

  it('fails when a required check is skipping, but tolerates optional skipping', async () => {
    const rules = (required: Res) =>
      base([
        { prefix: REQ, responses: [required] },
        { prefix: CHK, responses: [checks(['build', 'pass'], ['deploy', 'skipping'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]);
    const bad = await run(rules(checks(['deploy', 'skipping'])));
    expect(bad.result.result).toBe('failed');
    expect(bad.result.reason).toContain('deploy');
    const ok = await run(rules(checks(['build', 'pass'])));
    expect(ok.result.result).toBe('merged');
  });

  it('fails closed on zero checks', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [{ stdout: '[]' }] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result).toMatchObject({ result: 'failed' });
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('R78: zero checks right after update-branch are pending during the grace window', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [{ stdout: '[]' }, { stdout: '[]' }, checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('merged');
    expect(mergeCalls(r.calls)).toHaveLength(1);
  });

  it('R78: zero checks still after the 5 min grace: failed "no checks reported", no merge', async () => {
    let waited = 0;
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [{ stdout: '[]' }] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
      { onSleep: (_ms, total) => (waited = total) },
    );
    expect(r.result).toEqual({ result: 'failed', reason: 'no checks reported' });
    expect(mergeCalls(r.calls)).toHaveLength(0);
    expect(waited).toBeGreaterThanOrEqual(5 * 60_000);
    expect(waited).toBeLessThan(6 * 60_000);
  });

  it('R78: gh "no checks reported" on stderr counts as zero checks during the grace', async () => {
    const none: Res = { code: 1, stdout: '', stderr: "no checks reported on the 'x' branch" };
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [none, checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('merged');
  });

  it('R78: no grace without a head change (update-branch had nothing to do)', async () => {
    const r = await run([
      { prefix: UPD, responses: [{ code: 1, stderr: 'no new commits to update' }] },
      { prefix: REQ, responses: [noRequired] },
      { prefix: CHK, responses: [{ stdout: '[]' }] },
      { prefix: VIEW, responses: [view(H1)] },
      { prefix: MERGE, responses: [{}] },
    ]);
    expect(r.result).toEqual({ result: 'failed', reason: 'no checks reported' });
    expect(r.sleeps).toHaveLength(0);
  });

  it('R78: a head that moved during the checks poll gets a fresh grace window', async () => {
    // Resumed at checks (no grace yet); the head moves, then the new head reports no checks for
    // a while before its CI shows up.
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        {
          prefix: CHK,
          responses: [
            checks(['a', 'pass']),
            { stdout: '[]' },
            { stdout: '[]' },
            checks(['a', 'pass']),
          ],
        },
        { prefix: VIEW, responses: [view(H1), view(H2), view(H2), view(H2)] },
      ]),
      { entry: { pr: 5, repo: 'org/app', step: 'checks' } },
    );
    expect(r.result.result).toBe('merged');
    expect(mergeCalls(r.calls)).toEqual([`${MERGE} --squash --match-head-commit ${H2}`]);
  });

  it('fails closed on empty or unparsable checks output', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [{ code: 1, stdout: '', stderr: 'no checks reported' }] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('failed');
    expect(r.result.reason).toContain('no checks reported');
  });

  it('fails closed on an unknown bucket', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'weird'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('failed');
  });

  it('parses the checks json despite a non-zero exit code', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        {
          prefix: CHK,
          responses: [
            { code: 8, stdout: JSON.stringify([{ name: 'a', bucket: 'pending' }]) },
            { code: 8, stdout: JSON.stringify([{ name: 'a', bucket: 'pass' }]) },
          ],
        },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('merged');
  });

  it('merges with match-head-commit of the head seen after checks, using the configured method', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [checks(['a', 'pass'])] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
      { method: 'rebase' },
    );
    expect(r.result).toEqual({ result: 'merged', mergeSha: MERGE_SHA });
    expect(mergeCalls(r.calls)).toEqual([`${MERGE} --rebase --match-head-commit ${H1}`]);
    // persisted before each step, in order
    expect(r.persisted.map((p) => p.step)).toEqual(['update', 'checks', 'capacity', 'merge']);
    expect(r.persisted[3]?.head).toBe(H1);
  });

  it('tolerates "no new commits" from update-branch, fails on other update errors', async () => {
    const mk = (u: Res) =>
      base([
        { prefix: UPD, responses: [u] },
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]);
    const ok = await run(
      mk({ code: 1, stderr: 'HTTP 422: There are no new commits on the base branch' }),
    );
    expect(ok.result.result).toBe('merged');
    const bad = await run(mk({ code: 1, stderr: 'HTTP 403: forbidden' }));
    expect(bad.result.result).toBe('failed');
    expect(bad.result.reason).toContain('forbidden');
  });

  it('retries when the head moved before merge, merges the new head after fresh checks', async () => {
    // views: before-checks H1, after-checks H1, merge re-read H2 (moved), before H2, after H2, merge re-read H2
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1), view(H1), view(H2)] },
      ]),
    );
    expect(r.result.result).toBe('merged');
    expect(mergeCalls(r.calls)).toEqual([`${MERGE} --squash --match-head-commit ${H2}`]);
    expect(r.calls.filter((c) => c.startsWith(CHK) && !c.endsWith('--required'))).toHaveLength(3);
  });

  it('gives up after 3 attempts when the head keeps moving', async () => {
    const heads = [H1, H1, H2, H2, H2, H3, H3, H3, H4];
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: heads.map((h) => view(h)) },
      ]),
    );
    expect(r.result).toEqual({ result: 'failed', reason: 'head moved 3 times' });
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('treats a head-mismatch merge refusal as head moved', async () => {
    const r = await run([
      {
        prefix: MERGE,
        responses: [
          { code: 1, stderr: 'Head branch was modified. Review and try the merge again.' },
          {},
        ],
      },
      ...base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    ]);
    expect(r.result.result).toBe('merged');
    expect(mergeCalls(r.calls)).toHaveLength(2);
  });

  it('fails on any other merge error', async () => {
    const r = await run([
      { prefix: MERGE, responses: [{ code: 1, stderr: 'not allowed' }] },
      ...base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    ]);
    expect(r.result.result).toBe('failed');
    expect(r.result.reason).toContain('not allowed');
  });

  it('capacity not holding: waits, does not merge until it holds', async () => {
    const busy = { n: 6 };
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
      {
        busy,
        onSleep: (ms, total) => {
          if (ms === 60_000 && total >= 120_000) busy.n = 0;
        },
      },
    );
    expect(r.result.result).toBe('merged');
    expect(r.sleeps.filter((s) => s === 60_000).length).toBeGreaterThanOrEqual(2);
    const firstMerge = r.calls.findIndex((c) => c.startsWith(MERGE));
    expect(firstMerge).toBeGreaterThan(-1);
    expect(r.calls.slice(0, firstMerge).filter((c) => c.startsWith('api')).length).toBeGreaterThan(
      2,
    );
  });

  it('capacity never holding: fails at the 4 h cap without merging', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
      { busy: { n: 8 } },
    );
    expect(r.result.result).toBe('failed');
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('checks pending forever: fails with timeout after 4 h', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pending'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result).toEqual({ result: 'failed', reason: 'checks timed out' });
  });

  it('PR already MERGED (restart after merge): merged without a second merge call', async () => {
    const r = await run(
      base([
        { prefix: UPD, responses: [{ code: 1, stderr: 'pull request is closed' }] },
        { prefix: VIEW, responses: [view(H1, 'MERGED')] },
      ]),
    );
    expect(r.result).toEqual({ result: 'merged', mergeSha: MERGE_SHA });
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('PR CLOSED: failed', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1, 'CLOSED')] },
      ]),
    );
    expect(r.result.result).toBe('failed');
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('fails closed on garbage from gh pr view', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [{ stdout: '{"headRefOid":"zz","state":"OPEN"}' }] },
      ]),
    );
    expect(r.result.result).toBe('failed');
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('refuses a repository that is not configured', async () => {
    const r = await run(base([]), { entry: { pr: 5, repo: 'evil/app', step: 'update' } });
    expect(r.result.result).toBe('failed');
    expect(r.calls).toHaveLength(0);
  });

  it('resumes at the recorded step but re-verifies the head before merging', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H2)] },
      ]),
      { entry: { pr: 5, repo: 'org/app', step: 'merge', head: H1 } },
    );
    expect(r.calls.some((c) => c.startsWith(UPD))).toBe(false);
    expect(r.result.result).toBe('merged');
    expect(mergeCalls(r.calls)).toEqual([`${MERGE} --squash --match-head-commit ${H2}`]);
  });

  it('fails when every check is skipping and none is required', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'skipping'], ['b', 'skipping'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result).toEqual({ result: 'failed', reason: 'no check passed' });
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('head moving during the checks poll: polls again and merges only the new head', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1), view(H2), view(H2)] },
      ]),
    );
    expect(r.result.result).toBe('merged');
    expect(mergeCalls(r.calls)).toEqual([`${MERGE} --squash --match-head-commit ${H2}`]);
    // checks step ran twice (H1 -> H2 move), plus the pre-merge re-check
    expect(r.calls.filter((c) => c.startsWith(CHK) && !c.endsWith('--required'))).toHaveLength(3);
  });

  it('head moving inside every checks poll: head moved 3 times, no merge', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        {
          prefix: VIEW,
          responses: [view(H1), view(H2), view(H2), view(H3), view(H3), view(H4)],
        },
      ]),
    );
    expect(r.result).toEqual({ result: 'failed', reason: 'head moved 3 times' });
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('re-checks right before merging: a check turning pending sends the PR back to checks', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        {
          prefix: CHK,
          responses: [
            checks(['a', 'pass']),
            checks(['a', 'pending']),
            checks(['a', 'pass']),
            checks(['a', 'pass']),
          ],
        },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('merged');
    expect(mergeCalls(r.calls)).toHaveLength(1);
    expect(r.persisted.map((p) => p.step)).toEqual([
      'update',
      'checks',
      'capacity',
      'merge',
      'checks',
      'capacity',
      'merge',
    ]);
  });

  it('re-check right before merging that finds a failure: failed, no merge', async () => {
    const r = await run(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'pass']), checks(['a', 'fail'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('failed');
    expect(mergeCalls(r.calls)).toHaveLength(0);
  });

  it('waits for a pending check that appears only in the --required list', async () => {
    const r = await run(
      base([
        {
          prefix: REQ,
          responses: [
            checks(['a', 'pass'], ['req', 'pending']),
            checks(['a', 'pass'], ['req', 'pass']),
          ],
        },
        { prefix: CHK, responses: [checks(['a', 'pass'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    expect(r.result.result).toBe('merged');
    expect(r.sleeps).toContain(30_000);
    expect(r.calls.filter((c) => c.startsWith(REQ)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('runQueue', () => {
  const rules = (): Rule[] =>
    base([
      { prefix: REQ, responses: [noRequired] },
      { prefix: CHK, responses: [checks(['a', 'pass'])] },
      { prefix: VIEW, responses: [view(H1)] },
    ]);

  it('resumes the current entry after restart without re-adding it', async () => {
    const g = fakeGh(rules());
    const c = fakeClock();
    const snapshots: QueueState[] = [];
    const state: QueueState = {
      current: { pr: 5, repo: 'org/app', step: 'capacity', head: H1 },
      pending: [],
      done: [],
    };
    const out = await runQueue(state, mkConfig(), { gh: g.gh, clock: c.clock, host }, (q) =>
      snapshots.push(structuredClone(q)),
    );
    expect(g.calls.some((x) => x.startsWith(UPD))).toBe(false);
    expect(out.current).toBeUndefined();
    expect(out.pending).toHaveLength(0);
    expect(out.done).toEqual([
      { pr: 5, repo: 'org/app', result: 'merged', at: '2026-10-31T10:00:30.000Z' },
    ]);
    expect(snapshots.length).toBeGreaterThan(1);
  });

  it('processes pending FIFO, one at a time, and records failures', async () => {
    const g = fakeGh([
      { prefix: 'pr update-branch', responses: [{}] },
      { prefix: 'pr checks 5', responses: [checks(['a', 'pass'])] },
      { prefix: 'pr checks 6', responses: [checks(['a', 'fail'])] },
      { prefix: 'pr view', responses: [view(H1)] },
      { prefix: 'pr merge', responses: [{}] },
    ]);
    const c = fakeClock();
    const state: QueueState = {
      pending: [
        { pr: 5, repo: 'org/app' },
        { pr: 6, repo: 'org/app' },
      ],
      done: [],
    };
    const out = await runQueue(state, mkConfig(), { gh: g.gh, clock: c.clock, host }, () => {});
    expect(out.done.map((d) => [d.pr, d.result])).toEqual([
      [5, 'merged'],
      [6, 'failed'],
    ]);
    expect(out.done[1]?.reason).toContain('a');
    const merges = g.calls.filter((x) => x.startsWith('pr merge'));
    expect(merges).toHaveLength(1);
  });

  it('appends a merged metrics event to metrics.jsonl', async () => {
    const root = tmpRoot();
    const g = fakeGh(rules());
    const c = fakeClock();
    const state: QueueState = { pending: [{ pr: 5, repo: 'org/app', item: 'T-9' }], done: [] };
    await runQueue(state, mkConfig(), { gh: g.gh, clock: c.clock, host }, () => {}, {
      stateRoot: root,
    });
    const lines = readFileSync(join(root, 'metrics.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      type: 'merged',
      item: 'T-9',
      pr: 5,
      repo: 'org/app',
      at: '2026-10-31T10:00:30.000Z',
      firstCommitAt: '2026-10-30T08:00:00Z',
    });
  });

  it('does not write a metrics event for a failed PR', async () => {
    const root = tmpRoot();
    const g = fakeGh(
      base([
        { prefix: REQ, responses: [noRequired] },
        { prefix: CHK, responses: [checks(['a', 'fail'])] },
        { prefix: VIEW, responses: [view(H1)] },
      ]),
    );
    const state: QueueState = { pending: [{ pr: 5, repo: 'org/app' }], done: [] };
    await runQueue(state, mkConfig(), { gh: g.gh, clock: fakeClock().clock, host }, () => {}, {
      stateRoot: root,
    });
    expect(() => readFileSync(join(root, 'metrics.jsonl'))).toThrow();
  });
});

describe('loadQueue / saveQueue', () => {
  it('round-trips with mode 0600 and treats a missing file as empty', () => {
    const root = tmpRoot();
    expect(loadQueue(root)).toEqual({ pending: [], done: [] });
    const q: QueueState = {
      current: { pr: 1, repo: 'org/app', step: 'checks' },
      pending: [{ pr: 2, repo: 'org/app' }],
      done: [],
    };
    saveQueue(root, q);
    expect(statSync(join(root, 'queue.json')).mode & 0o777).toBe(0o600);
    expect(loadQueue(root)).toEqual(q);
  });

  it('refuses a corrupt queue file', () => {
    const root = tmpRoot();
    saveQueue(root, { pending: [], done: [] });
    writeFileSync(join(root, 'queue.json'), '{"pending":"x"}');
    expect(() => loadQueue(root)).toThrow(/invalid/);
  });
});

describe('runQueue metrics robustness', () => {
  const rules = (commits: Res): Rule[] => [
    { prefix: COMMITS, responses: [commits] },
    ...base([
      { prefix: REQ, responses: [noRequired] },
      { prefix: CHK, responses: [checks(['a', 'pass'])] },
      { prefix: VIEW, responses: [view(H1)] },
    ]),
  ];

  it('writes firstCommitAt: null when the first commit date is unreadable', async () => {
    const root = tmpRoot();
    const g = fakeGh(rules({ code: 1, stderr: 'boom' }));
    const state: QueueState = { pending: [{ pr: 5, repo: 'org/app' }], done: [] };
    await runQueue(state, mkConfig(), { gh: g.gh, clock: fakeClock().clock, host }, () => {}, {
      stateRoot: root,
    });
    const line = readFileSync(join(root, 'metrics.jsonl'), 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ type: 'merged', pr: 5, firstCommitAt: null });
  });

  it('a failing metrics append is logged and does not stop the queue', async () => {
    const dir = tmpRoot();
    const notADir = join(dir, 'file');
    writeFileSync(notADir, 'x');
    const g = fakeGh(rules({ stdout: '2026-10-30T08:00:00Z' }));
    const logs: string[] = [];
    const state: QueueState = { pending: [{ pr: 5, repo: 'org/app' }], done: [] };
    const out = await runQueue(
      state,
      mkConfig(),
      { gh: g.gh, clock: fakeClock().clock, host },
      () => {},
      { stateRoot: notADir, log: (m) => logs.push(m) },
    );
    expect(out.done.map((d) => d.result)).toEqual(['merged']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('metrics append failed');
  });
});

describe('R79: queue file updates and the run lock', () => {
  /** Any PR: update, checks and merge succeed. */
  const passRules = (): Rule[] => [
    { prefix: 'pr update-branch', responses: [{}] },
    { prefix: 'pr checks', responses: [checks(['a', 'pass'])] },
    { prefix: 'pr view', responses: [view(H1)] },
    { prefix: 'pr merge', responses: [{}] },
  ];

  it('enqueue merges into the file on disk and refuses duplicates', () => {
    const root = tmpRoot();
    saveQueue(root, { current: { pr: 1, repo: 'org/app', step: 'checks' }, pending: [], done: [] });
    expect(enqueue(root, { pr: 2, repo: 'org/app', item: 'APP-2' })).toBe(1);
    expect(() => enqueue(root, { pr: 2, repo: 'org/app' })).toThrow(/already in the queue/);
    expect(() => enqueue(root, { pr: 1, repo: 'org/app' })).toThrow(/already in the queue/);
    const q = loadQueue(root);
    expect(q.current?.pr).toBe(1);
    expect(q.pending).toEqual([{ pr: 2, repo: 'org/app', item: 'APP-2' }]);
  });

  it('updateQueue waits for the file lock and gives up after its timeout', () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'queue.json.lock'), '{"token":"other"}\n');
    expect(() => updateQueue(root, () => undefined, { timeoutMs: 120 })).toThrow(
      /queue file is locked/,
    );
    rmSync(join(root, 'queue.json.lock'));
    expect(updateQueue(root, (q) => q.pending.length)).toBe(0);
    expect(existsSync(join(root, 'queue.json.lock'))).toBe(false);
  });

  it('runQueue takes each next entry from disk: an entry added during the run is merged too', async () => {
    const root = tmpRoot();
    saveQueue(root, { pending: [{ pr: 5, repo: 'org/app' }], done: [] });
    let added = false;
    const g = fakeGh(passRules());
    const gh: Gh = {
      ...g.gh,
      async run(args) {
        if (!added && args.join(' ').startsWith('pr merge 5')) {
          added = true;
          enqueue(root, { pr: 6, repo: 'org/app' });
        }
        return g.gh.run(args);
      },
    };
    const order: string[] = [];
    const state = loadQueue(root);
    const out = await runQueue(
      state,
      mkConfig(),
      { gh, clock: fakeClock().clock, host },
      (q) =>
        updateQueue(root, (disk) => {
          disk.current = q.current;
          disk.done = q.done;
        }),
      {
        takeNext: () => takeNextPending(root),
        onDone: (d) => order.push(`done ${d.pr}`),
      },
    );
    expect(out.done.map((d) => [d.pr, d.result])).toEqual([
      [5, 'merged'],
      [6, 'merged'],
    ]);
    expect(order).toEqual(['done 5', 'done 6']);
    const disk = loadQueue(root);
    expect(disk.pending).toEqual([]);
    expect(disk.current).toBeUndefined();
    expect(disk.done.map((d) => d.pr)).toEqual([5, 6]);
  });

  it('onDone runs right after each entry, before the next one starts', async () => {
    const g = fakeGh(passRules());
    const events: string[] = [];
    const gh: Gh = {
      ...g.gh,
      async run(args) {
        const line = args.join(' ');
        if (line.startsWith('pr update-branch')) events.push(`update ${args[2]}`);
        return g.gh.run(args);
      },
    };
    const state: QueueState = {
      pending: [
        { pr: 5, repo: 'org/app' },
        { pr: 6, repo: 'org/app' },
      ],
      done: [],
    };
    await runQueue(state, mkConfig(), { gh, clock: fakeClock().clock, host }, () => {}, {
      onDone: (d) => events.push(`done ${d.pr}`),
    });
    expect(events).toEqual(['update 5', 'done 5', 'update 6', 'done 6']);
  });

  it('a failing onDone is logged and does not stop the queue', async () => {
    const logs: string[] = [];
    const state: QueueState = { pending: [{ pr: 5, repo: 'org/app' }], done: [] };
    const out = await runQueue(
      state,
      mkConfig(),
      { gh: fakeGh(passRules()).gh, clock: fakeClock().clock, host },
      () => {},
      {
        onDone: () => {
          throw new Error('board busy');
        },
        log: (m) => logs.push(m),
      },
    );
    expect(out.done.map((d) => d.result)).toEqual(['merged']);
    expect(logs.join('\n')).toContain('board busy');
  });

  it('R83: the run lock is held while its holder lives, broken with a note when it died', () => {
    const root = tmpRoot();
    const notes: string[] = [];
    const a = acquireQueueRunLock(root, new Date(), (m) => notes.push(m));
    // A live holder (this process) with a fresh heartbeat: held, however old the file is.
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(join(root, 'queue.run.lock'), old, old);
    expect(() => acquireQueueRunLock(root, new Date(), (m) => notes.push(m))).toThrow(
      /queue already running/,
    );
    a.release();
    const t = new Date().toISOString();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(
      join(root, 'queue.run.lock'),
      JSON.stringify({ pid: dead, startedAt: t, heartbeat: t, token: 'x' }),
    );
    const c = acquireQueueRunLock(root, new Date(), (m) => notes.push(m));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/stale queue lock/);
    expect(notes[0]).toMatch(/not running/);
    c.release();
    expect(existsSync(join(root, 'queue.run.lock'))).toBe(false);
  });

  it('R83: a signal releases the run lock, then exits with the conventional code', () => {
    const calls: string[] = [];
    const lock = { release: () => calls.push('release'), heartbeat: () => {} };
    releaseOnSignal(lock, 'SIGTERM', (code) => calls.push(`exit ${code}`));
    releaseOnSignal(lock, 'SIGINT', (code) => calls.push(`exit ${code}`));
    releaseOnSignal(lock, 'SIGHUP', (code) => calls.push(`exit ${code}`));
    expect(calls).toEqual(['release', 'exit 143', 'release', 'exit 130', 'release', 'exit 129']);
  });

  it('R83: installed signal handlers are removed again', () => {
    const before = ['SIGTERM', 'SIGINT', 'SIGHUP'].map((s) => process.listenerCount(s));
    const remove = installSignalRelease({ release: () => {}, heartbeat: () => {} });
    expect(['SIGTERM', 'SIGINT', 'SIGHUP'].map((s) => process.listenerCount(s))).toEqual(
      before.map((n) => n + 1),
    );
    remove();
    expect(['SIGTERM', 'SIGINT', 'SIGHUP'].map((s) => process.listenerCount(s))).toEqual(before);
  });
});
