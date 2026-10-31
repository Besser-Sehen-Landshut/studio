import { describe, expect, it } from 'vitest';
import { capacityHoldsTwice, readCapacity } from '../src/capacity.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import type { Clock, Gh, Host } from '../src/ports.js';

function mkConfig(ci: Record<string, unknown> = {}): StudioConfig {
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
      ...ci,
    },
    merge: { strategy: 'studio-queue', contractPaths: [] },
    roles: { builder: { model: 'm', wip: 2 } },
    ownerOnly: [],
    deployCommands: [],
  });
}

type Row = [name: string, status: string, busy: boolean];

const tsv = (rows: Row[]) => rows.map(([n, s, b]) => `${n}\t${s}\t${b}`).join('\n');
const busyRows = (n: number) =>
  tsv(Array.from({ length: n }, (_, i): Row => [`pool-${i}`, 'online', true]));

function fakeGh(
  handler: (path: string, jq?: string) => Promise<string> | string,
): Gh & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    api: async (path, jq) => {
      calls.push(path);
      return handler(path, jq);
    },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
}

const host = (load: number): Host => ({ loadAvg1: () => load });
const opts = { timeoutMs: 50 };

describe('readCapacity', () => {
  it('counts only matching busy runners', async () => {
    const gh = fakeGh(() =>
      tsv([
        ['pool-1', 'online', true],
        ['pool-2', 'online', false],
        ['pool-3', 'offline', true],
        ['other-1', 'online', true],
        ['pool-4', 'online', true],
      ]),
    );
    const cap = await readCapacity(mkConfig(), { gh, host: host(0.5) }, opts);
    expect(gh.calls).toEqual(['/orgs/org/actions/runners']);
    expect(cap).toEqual({ ciBusy: 2, ciTotal: 8, hostLoad: 0.5, ok: true });
  });

  it('matches all runners when no name pattern is set', async () => {
    const gh = fakeGh(() =>
      tsv([
        ['a', 'online', true],
        ['b', 'online', true],
      ]),
    );
    const cfg = mkConfig({ runnerNamePattern: undefined });
    const cap = await readCapacity(cfg, { gh, host: host(0) }, opts);
    expect(cap.ciBusy).toBe(2);
  });

  it('api error counts as busy (ok=false, ciBusy=total)', async () => {
    const gh = fakeGh(() => {
      throw new Error('boom');
    });
    const cap = await readCapacity(mkConfig(), { gh, host: host(0) }, opts);
    expect(cap).toMatchObject({ ok: false, ciBusy: 8, ciTotal: 8 });
  });

  it('unparsable output counts as busy', async () => {
    const gh = fakeGh(() => 'not a table\n');
    const cap = await readCapacity(mkConfig(), { gh, host: host(0) }, opts);
    expect(cap).toMatchObject({ ok: false, ciBusy: 8 });
  });

  it('timeout counts as busy', async () => {
    const gh = fakeGh(() => new Promise<string>(() => {}));
    const cap = await readCapacity(mkConfig(), { gh, host: host(0) }, { timeoutMs: 20 });
    expect(cap).toMatchObject({ ok: false, ciBusy: 8 });
  });

  it('host load above max → not ok', async () => {
    const gh = fakeGh(() => '');
    const cfg = mkConfig({
      capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 30, hostLoadMax: 4 },
    });
    expect((await readCapacity(cfg, { gh, host: host(4) }, opts)).ok).toBe(true);
    expect((await readCapacity(cfg, { gh, host: host(4.1) }, opts)).ok).toBe(false);
  });

  it('busy above mergeMaxBusy → not ok, equal is ok', async () => {
    const at = fakeGh(() => busyRows(5));
    const over = fakeGh(() => busyRows(6));
    expect((await readCapacity(mkConfig(), { gh: at, host: host(0) }, opts)).ok).toBe(true);
    expect((await readCapacity(mkConfig(), { gh: over, host: host(0) }, opts)).ok).toBe(false);
  });

  it('github-hosted counts queued+in_progress runs', async () => {
    const gh = fakeGh((path) => (path.includes('status=queued') ? '2\n' : '3\n'));
    const cfg = mkConfig({ runners: 'github-hosted' });
    const cap = await readCapacity(cfg, { gh, host: host(0) }, opts);
    expect(gh.calls).toEqual([
      '/repos/org/app/actions/runs?status=in_progress',
      '/repos/org/app/actions/runs?status=queued',
    ]);
    expect(cap.ciBusy).toBe(5);
  });

  it('github-hosted busy is capped at total', async () => {
    const gh = fakeGh(() => '20');
    const cfg = mkConfig({ runners: 'github-hosted' });
    const cap = await readCapacity(cfg, { gh, host: host(0) }, opts);
    expect(cap).toMatchObject({ ciBusy: 8, ok: false });
  });

  it('both = self-hosted busy + hosted runs, capped at total', async () => {
    const cfg = mkConfig({ runners: 'both' });
    const runners = tsv([['pool-1', 'online', true]]);
    const small = fakeGh((path) => (path.startsWith('/orgs/') ? runners : '2'));
    expect((await readCapacity(cfg, { gh: small, host: host(0) }, opts)).ciBusy).toBe(5);
    const big = fakeGh((path) => (path.startsWith('/orgs/') ? runners : '9'));
    expect((await readCapacity(cfg, { gh: big, host: host(0) }, opts)).ciBusy).toBe(8);
  });
});

describe('capacityHoldsTwice', () => {
  function fakeClock() {
    const sleeps: number[] = [];
    const clock: Clock = {
      now: () => new Date(0),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    return { clock, sleeps };
  }

  it('true when both reads are ok, sleeping checkTwiceSeconds between', async () => {
    const { clock, sleeps } = fakeClock();
    const gh = fakeGh(() => busyRows(1));
    expect(await capacityHoldsTwice(mkConfig(), { gh, host: host(0), clock }, opts)).toBe(true);
    expect(sleeps).toEqual([30_000]);
    expect(gh.calls).toHaveLength(2);
  });

  it('false if second read busy', async () => {
    const { clock } = fakeClock();
    let n = 0;
    const gh = fakeGh(() => busyRows(++n === 1 ? 1 : 7));
    expect(await capacityHoldsTwice(mkConfig(), { gh, host: host(0), clock }, opts)).toBe(false);
  });

  it('false without sleeping if first read busy', async () => {
    const { clock, sleeps } = fakeClock();
    const gh = fakeGh(() => busyRows(7));
    expect(await capacityHoldsTwice(mkConfig(), { gh, host: host(0), clock }, opts)).toBe(false);
    expect(sleeps).toEqual([]);
    expect(gh.calls).toHaveLength(1);
  });
});
