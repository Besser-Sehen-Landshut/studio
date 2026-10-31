import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import type { Clock, Gh, Host } from '../src/ports.js';
import {
  loadQueue,
  mergeOne,
  type QueueCurrent,
  type QueueState,
  runQueue,
  saveQueue,
} from '../src/queue.js';

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
        return Array.from({ length: busy.n }, (_, i) => `pool-${i}\tonline\ttrue`).join('\n');
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

const host: Host = { loadAvg1: () => 0 };
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
    expect(r.calls.filter((c) => c.startsWith(CHK) && !c.endsWith('--required'))).toHaveLength(3);
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
    expect(r.calls.filter((c) => c.startsWith(CHK) && !c.endsWith('--required'))).toHaveLength(2);
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
    const root = mkdtempSync(join(tmpdir(), 'studio-queue-'));
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
    const root = mkdtempSync(join(tmpdir(), 'studio-queue-'));
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
    const root = mkdtempSync(join(tmpdir(), 'studio-queue-'));
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
    const root = mkdtempSync(join(tmpdir(), 'studio-queue-'));
    saveQueue(root, { pending: [], done: [] });
    writeFileSync(join(root, 'queue.json'), '{"pending":"x"}');
    expect(() => loadQueue(root)).toThrow(/invalid/);
  });
});
