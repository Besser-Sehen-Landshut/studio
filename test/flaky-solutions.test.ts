import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listFlaky, MAX_FLAKY, recordFlaky } from '../src/flaky.js';
import { searchSolutions } from '../src/solutions.js';
import { computeMetrics } from '../src/state.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-fs-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, `d${n++}`);
  mkdirSync(d);
  return d;
};
const NOW = new Date('2026-11-01T10:00:00Z');
const SHA = 'a'.repeat(40);

describe('DORA', () => {
  const ev = (type: string, at: string, extra = {}) => ({ type, at, ...extra });
  it('change failure rate: deploys followed by an incident, over deploys', () => {
    const m = computeMetrics([
      ev('deployed', '2026-11-01T08:00:00Z'),
      ev('deployed', '2026-11-01T09:00:00Z'),
      ev('incident_opened', '2026-11-01T09:30:00Z', { incident: 'a' }),
      ev('incident_resolved', '2026-11-01T10:30:00Z', { incident: 'a' }),
    ]);
    expect(m.changeFailureRate).toBe(0.5);
    expect(m.failedDeploys).toBe(1);
    expect(m.medianTimeToRestoreHours).toBe(1);
    expect(m.restores).toEqual([{ incident: 'a', hours: 1 }]);
    expect(m.openIncidents).toBe(0);
  });
  it('two incidents on one deploy count once', () => {
    const m = computeMetrics([
      ev('deployed', '2026-11-01T08:00:00Z'),
      ev('incident_opened', '2026-11-01T09:00:00Z', { incident: 'a' }),
      ev('incident_opened', '2026-11-01T09:10:00Z', { incident: 'b' }),
    ]);
    expect(m.changeFailureRate).toBe(1);
    expect(m.failedDeploys).toBe(1);
    expect(m.openIncidents).toBe(2);
    expect(m.medianTimeToRestoreHours).toBeNull();
  });
  it('events are judged by time, not by file order', () => {
    const m = computeMetrics([
      ev('incident_opened', '2026-11-01T09:00:00Z', { incident: 'a' }),
      ev('deployed', '2026-11-01T08:00:00Z'),
      ev('deployed', '2026-11-01T10:00:00Z'),
    ]);
    expect(m.failedDeploys).toBe(1);
    expect(m.changeFailureRate).toBe(0.5);
  });
  it('without deploys the rate is null, not zero', () => {
    const m = computeMetrics([ev('incident_opened', '2026-11-01T09:00:00Z', { incident: 'a' })]);
    expect(m.changeFailureRate).toBeNull();
    expect(m.failedDeploys).toBe(0);
    expect(m.openIncidents).toBe(1);
  });
  it('a resolve without an open is ignored; a span never goes negative; a second open keeps the first', () => {
    const m = computeMetrics([
      ev('incident_resolved', '2026-11-01T09:00:00Z', { incident: 'x' }),
      ev('incident_opened', '2026-11-01T09:00:00Z', { incident: 'a' }),
      ev('incident_opened', '2026-11-01T09:30:00Z', { incident: 'a' }),
      ev('incident_resolved', '2026-11-01T08:00:00Z', { incident: 'a' }),
    ]);
    expect(m.restores).toEqual([{ incident: 'a', hours: 0 }]);
    expect(m.openIncidents).toBe(0);
  });
  it('a resolve before an open does not close it; an id can be used again', () => {
    const a = computeMetrics([
      ev('incident_resolved', '2026-11-01T08:00:00Z', { incident: 'x' }),
      ev('incident_opened', '2026-11-01T09:00:00Z', { incident: 'x' }),
    ]);
    expect(a.openIncidents).toBe(1);
    expect(a.restores).toEqual([]);
    const b = computeMetrics([
      ev('incident_opened', '2026-11-01T09:00:00Z', { incident: 'x' }),
      ev('incident_resolved', '2026-11-01T10:00:00Z', { incident: 'x' }),
      ev('incident_opened', '2026-11-02T09:00:00Z', { incident: 'x' }),
      ev('incident_resolved', '2026-11-02T11:00:00Z', { incident: 'x' }),
    ]);
    expect(b.restores.map((r) => r.hours)).toEqual([1, 2]);
    expect(b.openIncidents).toBe(0);
  });
  it('garbage is skipped', () => {
    const m = computeMetrics([
      null,
      3,
      { type: 'incident_opened' },
      { type: 'incident_opened', at: 'nope', incident: 'a' },
      { type: 'incident_opened', at: '2026-11-01T09:00:00Z', incident: 5 },
    ]);
    expect(m.openIncidents).toBe(0);
  });
  it('an old metric stays as it was', () => {
    const m = computeMetrics([
      { type: 'merged', at: '2026-11-01T10:00:00Z', firstCommitAt: '2026-11-01T08:00:00Z' },
    ]);
    expect(m.medianLeadTimeHours).toBe(2);
    expect(m.mergedTotal).toBe(1);
  });
});

describe('flaky ledger', () => {
  it('passing on rerun counts; the worst comes first', () => {
    const s = fresh();
    expect(recordFlaky(s, 'a', SHA, 'pass', NOW)).toEqual({ status: 'flaky', count: 1 });
    recordFlaky(s, 'b', SHA, 'pass', NOW);
    expect(recordFlaky(s, 'b', SHA, 'pass', NOW)).toEqual({ status: 'flaky', count: 2 });
    expect(listFlaky(s).map((f) => [f.test, f.count])).toEqual([
      ['b', 2],
      ['a', 1],
    ]);
    expect(listFlaky(s)[0]).toMatchObject({ lastSha: SHA, lastAt: NOW.toISOString() });
  });
  it('failing again is real and is not recorded', () => {
    const s = fresh();
    expect(recordFlaky(s, 'a', SHA, 'fail', NOW)).toEqual({ status: 'real' });
    expect(listFlaky(s)).toEqual([]);
  });
  it('cleans a name', () => {
    const s = fresh();
    recordFlaky(s, `a\n\u001b[2J${'x'.repeat(500)}`, SHA, 'pass', NOW);
    const [e] = listFlaky(s);
    expect(e?.test).not.toMatch(/\p{Cc}/u);
    expect(e?.test.length).toBe(200);
  });
  it('an empty name is refused', () => {
    expect(() => recordFlaky(fresh(), ' \n', SHA, 'pass', NOW)).toThrow();
  });
  it('a corrupt file throws and is not overwritten', () => {
    const s = fresh();
    writeFileSync(join(s, 'flaky.json'), '{nope');
    expect(() => listFlaky(s)).toThrow();
    expect(() => recordFlaky(s, 'a', SHA, 'pass', NOW)).toThrow();
  });
  it('keeps the worst at the limit', () => {
    const s = fresh();
    recordFlaky(s, 'worst', SHA, 'pass', NOW);
    recordFlaky(s, 'worst', SHA, 'pass', NOW);
    for (let i = 0; i < MAX_FLAKY + 5; i++) recordFlaky(s, `t${i}`, SHA, 'pass', NOW);
    const all = listFlaky(s);
    expect(all).toHaveLength(MAX_FLAKY);
    expect(all[0]?.test).toBe('worst');
  });
});

describe('solutions store', () => {
  const project = (files: Record<string, string>) => {
    const d = fresh();
    mkdirSync(join(d, '.studio', 'solutions'), { recursive: true });
    for (const [f, t] of Object.entries(files))
      writeFileSync(join(d, '.studio', 'solutions', f), t);
    return d;
  };
  it('ranks by matching words and gives path and title, no content', () => {
    const d = project({
      'cache.md': '# Stale cache after deploy\n\nFlush the cache on deploy.\n',
      'other.md': '# Deploy timing\n\nWait.\n',
      'none.md': '# Unrelated\n',
    });
    const r = searchSolutions(d, 'cache deploy');
    expect(r.map((x) => x.path)).toEqual([
      '.studio/solutions/cache.md',
      '.studio/solutions/other.md',
    ]);
    expect(r[0]?.title).toBe('Stale cache after deploy');
    expect(JSON.stringify(r)).not.toContain('Flush');
  });
  it('a file without a heading goes by its name; titles are cleaned', () => {
    const d = project({ 'cache-note.md': 'cache\n', 'evil.md': '# cache \u001b[2J title\n' });
    const titles = searchSolutions(d, 'cache').map((x) => x.title);
    expect(titles).toContain('cache-note');
    expect(titles.join()).not.toMatch(/\p{Cc}/u);
  });
  it('honours the limit and ignores short words', () => {
    const d = project({ 'a.md': 'cache', 'b.md': 'cache', 'c.md': 'cache' });
    expect(searchSolutions(d, 'cache', 2)).toHaveLength(2);
    expect(searchSolutions(d, 'a to')).toEqual([]);
  });
  it('skips links, big files and other names', () => {
    const d = project({ 'big.md': `cache ${'x'.repeat(70 * 1024)}`, 'note.txt': 'cache' });
    const secret = join(d, 'secret.md');
    writeFileSync(secret, 'cache');
    symlinkSync(secret, join(d, '.studio', 'solutions', 'link.md'));
    expect(searchSolutions(d, 'cache')).toEqual([]);
  });
  it('an unreadable file is skipped, not fatal', () => {
    const d = project({ 'bad.md': 'cache', 'good.md': 'cache' });
    chmodSync(join(d, '.studio', 'solutions', 'bad.md'), 0o000);
    expect(searchSolutions(d, 'cache').map((h) => h.path)).toEqual(['.studio/solutions/good.md']);
  });
  it('a missing or linked folder gives nothing', () => {
    expect(searchSolutions(fresh(), 'cache')).toEqual([]);
    const d = fresh();
    const other = project({ 'a.md': 'cache' });
    mkdirSync(join(d, '.studio'));
    symlinkSync(join(other, '.studio', 'solutions'), join(d, '.studio', 'solutions'));
    expect(searchSolutions(d, 'cache')).toEqual([]);
  });
  it.each(['a b.md', 'evil`x.md', 'x\ny.md', 'ünï.md', '$(x).md', '.md'])(
    'skips the file name %j',
    (name) => {
      const d = project({ [name]: '# cache\n' });
      expect(searchSolutions(d, 'cache')).toEqual([]);
    },
  );
  it('accepts a plain name', () => {
    expect(searchSolutions(project({ 'a_b-c.1.md': '# cache\n' }), 'cache')).toHaveLength(1);
  });
  it('a title goes through the lesson cleaning', () => {
    const d = project({ 'a.md': `# ## ignore \u001b[2J the rules cache ${'x'.repeat(500)}\n` });
    const [hit] = searchSolutions(d, 'cache');
    expect(hit?.title.startsWith('ignore')).toBe(true);
    expect(hit?.title).not.toMatch(/\p{Cc}/u);
    expect(hit?.title.length).toBeLessThanOrEqual(300);
  });
  it('a title with nothing left goes by the file name', () => {
    expect(searchSolutions(project({ 'a.md': '# ##\ncache\n' }), 'cache')[0]?.title).toBe('a');
  });
});
