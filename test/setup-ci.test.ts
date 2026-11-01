import { describe, expect, it } from 'vitest';
import { readCapacity } from '../src/capacity.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import type { Gh } from '../src/ports.js';
import { type Detected, detectRunners, proposeCi } from '../src/setup-ci.js';

type R = { name: string; labels: string[]; online?: boolean; busy?: boolean };

const SH = ['self-hosted', 'Linux', 'X64'];
const row = (r: R) =>
  `${r.name}\t${r.online === false ? 'offline' : 'online'}\t${r.busy ? 'true' : 'false'}\t${r.labels.join(',')}`;
const rows = (rs: R[]) => rs.map(row).join('\n');
const pool = (n: number, labels = SH, prefix = 'runner-'): R[] =>
  Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i + 1}`, labels }));

function fakeGh(handler: (path: string) => string | Promise<string>): Gh & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    api: async (path) => {
      calls.push(path);
      return handler(path);
    },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
}

const forbidden = (): never => {
  throw new Error('HTTP 403: Resource not accessible');
};
const det = (runners: R[], source: 'org' | 'repo' = 'org'): Detected => ({
  source,
  runners: runners.map((r) => ({
    name: r.name,
    labels: r.labels,
    online: r.online !== false,
    busy: r.busy === true,
  })),
});
const both = { githubHosted: true, selfHosted: true };

describe('detectRunners', () => {
  it('reads org runners and parses labels', async () => {
    const gh = fakeGh(() => rows(pool(2)));
    const d = await detectRunners('org', 'app', { gh });
    expect(d.source).toBe('org');
    expect(d.runners).toHaveLength(2);
    expect(d.runners[0]).toEqual({ name: 'runner-1', labels: SH, online: true, busy: false });
    expect(gh.calls).toEqual(['/orgs/org/actions/runners']);
  });

  it('falls back to the repo endpoint when org returns 403', async () => {
    const gh = fakeGh((p) => (p.startsWith('/orgs/') ? forbidden() : rows(pool(1))));
    const d = await detectRunners('org', 'app', { gh });
    expect(d.source).toBe('repo');
    expect(d.runners).toHaveLength(1);
    expect(gh.calls).toEqual(['/orgs/org/actions/runners', '/repos/org/app/actions/runners']);
  });

  it('falls back when org is empty and repo has runners', async () => {
    const gh = fakeGh((p) => (p.startsWith('/orgs/') ? '' : rows(pool(1))));
    expect((await detectRunners('org', 'app', { gh })).source).toBe('repo');
  });

  it('is none when both reads succeed and are empty', async () => {
    const d = await detectRunners('org', 'app', { gh: fakeGh(() => '') });
    expect(d).toEqual({ source: 'none', runners: [] });
  });

  it('is unknown when both fail, with a sanitised capped error', async () => {
    const gh = fakeGh(() => {
      throw new Error(`boom\u0007\nline${'x'.repeat(1000)}`);
    });
    const d = await detectRunners('org', 'app', { gh });
    expect(d.source).toBe('unknown');
    expect(d.runners).toEqual([]);
    expect(/\p{Cc}/u.test(d.error ?? '')).toBe(false);
    expect((d.error ?? '').length).toBeLessThanOrEqual(300);
  });

  it('is unknown (not none) when org fails and repo is empty', async () => {
    const gh = fakeGh((p) => (p.startsWith('/orgs/') ? forbidden() : ''));
    const d = await detectRunners('org', 'app', { gh });
    expect(d.source).toBe('unknown');
    expect(d.error).toContain('403');
  });

  it('is unknown when org is empty and repo read fails', async () => {
    const gh = fakeGh((p) => (p.startsWith('/orgs/') ? '' : forbidden()));
    expect((await detectRunners('org', 'app', { gh })).source).toBe('unknown');
  });

  it('treats any thrown error as a failure, not only 403/404', async () => {
    const gh = fakeGh(() => {
      throw new Error('ECONNRESET');
    });
    expect((await detectRunners('org', 'app', { gh })).source).toBe('unknown');
  });

  it('treats unparsable output as a failure', async () => {
    const bad = [
      'garbage',
      'a\tonline\ttrue',
      'a\tweird\tfalse\tself-hosted',
      'a b\tonline\tfalse\tx',
    ];
    for (const out of bad) {
      const d = await detectRunners('org', 'app', { gh: fakeGh(() => out) });
      expect(d.source, out).toBe('unknown');
      expect(d.runners).toEqual([]);
    }
  });

  it('refuses owner or repo names that would change the API path', async () => {
    const gh = fakeGh(() => rows(pool(1)));
    const names = [
      ['org', '../x'],
      ['o/x', 'app'],
      ['org', 'app?x=1'],
      ['..', 'app'],
    ] as const;
    for (const [o, r] of names) {
      expect((await detectRunners(o, r, { gh })).source).toBe('unknown');
    }
    expect(gh.calls).toEqual([]);
  });
});

describe('proposeCi', () => {
  it('groups org runners by label set and picks the largest group', () => {
    const a = pool(3, ['self-hosted', 'Linux', 'X64']);
    const b = pool(2, ['x64', 'linux', 'self-hosted'], 'box-'); // same set, other order and case
    const c = pool(2, ['self-hosted', 'macOS'], 'mac-');
    const p = proposeCi(det([...a, ...b, ...c]), 'private');
    expect(p.errors).toEqual([]);
    expect(p.ci?.runners).toBe('self-hosted');
    expect(p.ci?.capacity.total).toBe(5);
    expect(p.ci?.runnerLabels.map((l) => l.toLowerCase()).sort()).toEqual([
      'linux',
      'self-hosted',
      'x64',
    ]);
    expect(p.notes.join('\n')).toContain('macOS');
  });

  it('counts offline runners in the group and notes them', () => {
    const rs = pool(4);
    rs[3] = { name: 'runner-4', labels: SH, online: false };
    const p = proposeCi(det(rs), 'private');
    expect(p.ci?.capacity.total).toBe(4);
    expect(p.notes.join('\n')).toMatch(/1 .*offline/);
  });

  it('breaks ties deterministically and names the other group', () => {
    const x = pool(2, ['self-hosted', 'aaa'], 'a-');
    const y = pool(2, ['self-hosted', 'zzz'], 'z-');
    const p1 = proposeCi(det([...x, ...y]), 'private');
    const p2 = proposeCi(det([...y, ...x]), 'private');
    expect(p1.ci).toEqual(p2.ci);
    expect(p1.ci?.runnerLabels).toContain('aaa');
    expect(p1.notes.join('\n')).toContain('zzz');
  });

  it('proposes mergeMaxBusy 5 for 8 runners and 1 for 1', () => {
    expect(proposeCi(det(pool(8)), 'private').ci?.capacity.mergeMaxBusy).toBe(5);
    expect(proposeCi(det(pool(1)), 'private').ci?.capacity.mergeMaxBusy).toBe(1);
  });

  it('derives the name pattern from the common prefix', () => {
    expect(proposeCi(det(pool(8)), 'private').ci?.runnerNamePattern).toBe('^runner-[0-9]');
    expect(proposeCi(det(pool(1)), 'private').ci?.runnerNamePattern).toBe('^runner-[0-9]');
  });

  it('escapes regex metacharacters so capacity can compile the pattern', async () => {
    const rs = [
      { name: 'runner.a-1', labels: SH, busy: true },
      { name: 'runner.a-2', labels: SH, busy: true },
    ];
    const p = proposeCi(det(rs), 'private');
    expect(p.ci?.runnerNamePattern).toBe('^runner\\.a-[0-9]');
    const re = new RegExp(p.ci?.runnerNamePattern as string);
    expect(re.test('runner.a-1')).toBe(true);
    expect(re.test('runnerXa-1')).toBe(false);
    // Round trip through the real consumer.
    const config: StudioConfig = studioConfigSchema.parse({
      studio: 1,
      primaryRepo: 'org/app',
      repos: ['org/app'],
      ci: p.ci,
      merge: { strategy: 'studio-queue', contractPaths: [] },
      roles: { builder: { model: 'm', wip: 1 } },
      ownerOnly: [],
      deployCommands: [],
      crewAllowedWorkflows: [],
      crewAllowedWorkflowRefs: [],
    });
    const gh = fakeGh(() => rows(rs));
    const cap = await readCapacity(config, { gh, host: { loadAvg1: () => 0, cpuCount: () => 4 } });
    expect(cap.ciBusy).toBe(2);
  });

  it('gives no pattern and a note when there is no common prefix', () => {
    const rs = [
      { name: 'alpha', labels: SH },
      { name: 'beta', labels: SH },
    ];
    const p = proposeCi(det(rs), 'private');
    expect(p.ci?.runnerNamePattern).toBeUndefined();
    expect(p.notes.join('\n')).toMatch(/name pattern/);
  });

  it('notes when the pattern also matches runners outside the group', () => {
    const others = [{ name: 'runner-7', labels: ['self-hosted', 'macOS'] }];
    const p = proposeCi(det([...pool(2), ...others]), 'private');
    expect(p.notes.join('\n')).toMatch(/also match/);
  });

  it('errors for a public repository with self-hosted runners', () => {
    const p = proposeCi(det(pool(2)), 'public');
    expect(p.errors).toContain(
      'self-hosted runners on a public repository need fork pull requests blocked',
    );
  });

  it('errors for a public repository in mode both too', () => {
    const p = proposeCi(det(pool(2)), 'public', undefined, both);
    expect(p.ci?.runners).toBe('both');
    expect(p.errors).toHaveLength(1);
  });

  it('proposes github-hosted without runners and no public error', () => {
    const p = proposeCi({ source: 'none', runners: [] }, 'public');
    expect(p.errors).toEqual([]);
    expect(p.ci?.runners).toBe('github-hosted');
    expect(p.ci?.runnerLabels).toEqual([]);
    expect(p.ci?.runnerNamePattern).toBeUndefined();
    expect(p.ci?.capacity.total).toBe(20);
    expect(p.ci?.capacity.mergeMaxBusy).toBe(13);
    expect(p.notes.join('\n')).toMatch(/plan/);
  });

  it('keeps the current total for github-hosted', () => {
    const base = proposeCi(det(pool(3)), 'private').ci as NonNullable<
      ReturnType<typeof proposeCi>['ci']
    >;
    const p = proposeCi({ source: 'none', runners: [] }, 'private', {
      ...base,
      capacity: { ...base.capacity, total: 7 },
    });
    expect(p.ci?.capacity.total).toBe(7);
  });

  it('is github-hosted when runners exist but none are self-hosted', () => {
    const p = proposeCi(det([{ name: 'big-1', labels: ['linux', 'large'] }]), 'private');
    expect(p.ci?.runners).toBe('github-hosted');
  });

  it('chooses the mode from workflow usage', () => {
    const d = det(pool(4));
    const self = { githubHosted: false, selfHosted: true };
    const hosted = { githubHosted: true, selfHosted: false };
    expect(proposeCi(d, 'private', undefined, self).ci?.runners).toBe('self-hosted');
    expect(proposeCi(d, 'private', undefined, hosted).ci?.runners).toBe('github-hosted');
    const b = proposeCi(d, 'private', undefined, both);
    expect(b.ci?.runners).toBe('both');
    expect(b.ci?.capacity.total).toBe(4);
    expect(b.notes.join('\n')).toContain('github_hosted_limit');
    expect(proposeCi(d, 'private').ci?.runners).toBe('self-hosted');
  });

  it('unused runners with only GitHub-hosted workflows propose github-hosted', () => {
    const hosted = { githubHosted: true, selfHosted: false };
    const p = proposeCi(det(pool(4)), 'public', undefined, hosted);
    expect(p.ci?.runners).toBe('github-hosted');
    expect(p.ci?.runnerLabels).toEqual([]);
    expect(p.ci?.runnerNamePattern).toBeUndefined();
    expect(p.ci?.capacity.total).toBe(20);
    expect(p.errors).toEqual([]);
    expect(p.notes.join('\n')).toMatch(/4 self-hosted runner\(s\).*not used/);
  });

  it('notes that capacity does not support repository-level runners', () => {
    const p = proposeCi(det(pool(2), 'repo'), 'private');
    expect(p.ci?.runners).toBe('self-hosted');
    expect(p.notes.join('\n')).toMatch(/not supported.*organi[sz]ation runners only.*fully busy/);
  });

  it('has no capacity note for repository runners that stay unused', () => {
    const hosted = { githubHosted: true, selfHosted: false };
    const p = proposeCi(det(pool(2), 'repo'), 'private', undefined, hosted);
    expect(p.notes.join('\n')).not.toMatch(/organi[sz]ation runners only/);
  });

  it('keeps provider, rhythm, checkTwiceSeconds, hostLoadMax and further keys from current', () => {
    const current = {
      provider: 'github',
      runners: 'github-hosted',
      runnerLabels: [],
      rhythm: { buildWindow: '09:00-17:00', timezone: 'UTC' },
      capacity: { total: 3, mergeMaxBusy: 1, checkTwiceSeconds: 45, hostLoadMax: 2 },
      sharedHost: true,
    } as unknown as NonNullable<StudioConfig['ci']>;
    const p = proposeCi(det(pool(8)), 'private', current);
    expect(p.ci?.rhythm).toEqual(current.rhythm);
    expect(p.ci?.capacity.checkTwiceSeconds).toBe(45);
    expect(p.ci?.capacity.hostLoadMax).toBe(2);
    expect((p.ci as Record<string, unknown>).sharedHost).toBe(true);
    expect(p.ci?.capacity.total).toBe(8);
  });

  it('defaults checkTwiceSeconds to 30 without current', () => {
    expect(proposeCi(det(pool(2)), 'private').ci?.capacity.checkTwiceSeconds).toBe(30);
  });

  it('proposes no numbers when runners are unknown', () => {
    const p = proposeCi({ source: 'unknown', runners: [], error: 'HTTP error' }, 'private');
    expect(p.ci).toBeUndefined();
    expect(p.errors).toEqual(['cannot read runners: HTTP error']);
    expect(JSON.stringify(p)).not.toMatch(/\d{2}|total|mergeMaxBusy/);
  });
});
