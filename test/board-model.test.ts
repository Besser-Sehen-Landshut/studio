import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  alertsFor,
  type BoardRead,
  type BoardState,
  boardLines,
  formatRuntime,
  newAlerts,
  parseState,
  stateDirName,
  statusLine,
  statusText,
} from '../hooks/board-model.js';
import { stateDirName as srcStateDirName } from '../src/paths.js';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  const crew = [
    ...Array.from({ length: 5 }, (_, i) => ({
      name: `c${i}`,
      role: 'builder',
      item: `APP-${i + 1}`,
      status: 'doing',
      state: 'working',
      title: `Task ${i + 1}`,
      pr: 10 + i,
      since: '2026-11-01T10:00:00.000Z',
      label: 'label-a',
    })),
    {
      name: 'w',
      role: 'reviewer',
      item: 'APP-9',
      status: 'review',
      state: 'waiting',
      since: '2026-11-01T11:00:00.000Z',
    },
  ];
  return {
    crew,
    queue: {
      current: { pr: 7, repo: 'org/app', step: 'checks' },
      pending: [1, 2, 3, 4, 5].map((pr) => ({ pr, repo: 'org/app' })),
      done: [],
    },
    capacity: {},
    ci: { busy: 5, total: 8, mergeMaxBusy: 5, ok: true },
    today: {
      day: '2026-11-01',
      merged: [
        { pr: 3, repo: 'org/app', at: 'x' },
        { pr: 4, repo: 'org/app', at: 'y' },
      ],
      deployed: 2,
    },
    usageDays: { '2026-11-01': { 'label-a': 4, 'label-b': 2 } },
    mainBuild: { status: 'green', sha: 'abc1234' },
    counts: { ready: 3, queued: 19 },
    forOwner: [
      { id: 'APP-5', title: 'Sign the thing' },
      { id: 'APP-6', title: 'Pay the thing' },
    ],
    notifications: [],
    updatedAt: '2026-11-01T11:59:00.000Z',
    metrics: {
      medianLeadTimeHours: 3.25,
      perDay: {
        '2026-10-31': { merged: 3, deployed: 1 },
        '2026-11-01': { merged: 2, deployed: 2 },
      },
    },
    ...over,
  };
}

function ok(over: Record<string, unknown> = {}): BoardState {
  const r = parseState(JSON.stringify(snapshot(over)));
  if (r.kind !== 'ok') throw new Error('expected ok');
  return r.state;
}

describe('statusLine', () => {
  it('prints the exact line', () => {
    expect(statusLine(ok(), false)).toBe(
      '● 5 working · 1 waiting · 19 queued · CI 5/8 · for you: 2',
    );
  });
  it('appends paused', () => {
    expect(statusLine(ok(), true)).toBe(
      '● 5 working · 1 waiting · 19 queued · CI 5/8 · for you: 2 · paused',
    );
  });
  it('shows ?/y when CI is not ok', () => {
    expect(
      statusLine(ok({ ci: { busy: 0, total: 8, mergeMaxBusy: 5, ok: false } }), false),
    ).toContain('CI ?/8');
  });
  it('strips control characters from text', () => {
    const s = ok({ forOwner: [{ id: 'APP-1', title: 'a\u001b[31mred\u0007' }] });
    expect(s.forOwner[0]?.title).toBe('a[31mred');
  });
});

describe('parseState', () => {
  it.each(['', '{', '[]', 'null', '"x"', '5'])('%j is unreadable', (text) => {
    expect(parseState(text)).toEqual({ kind: 'unreadable' });
  });
  it('accepts an empty object with defaults', () => {
    const r = parseState('{}');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.state.crew).toEqual([]);
      expect(statusLine(r.state, false)).toBe(
        '● 0 working · 0 waiting · 0 queued · CI ?/0 · for you: 0',
      );
    }
  });
  it('survives wrong types per field', () => {
    const r = parseState(
      JSON.stringify({
        crew: 'x',
        queue: 5,
        ci: [],
        today: null,
        usageDays: 3,
        mainBuild: 'red',
        counts: { ready: 'a', queued: {} },
        forOwner: { a: 1 },
        notifications: 'n',
        updatedAt: 5,
        metrics: [],
      }),
    );
    expect(r.kind).toBe('ok');
    expect(boardLines(r, { columns: 80, nowMs: NOW, paused: false }).length).toBeGreaterThan(0);
  });
  it('drops rows with missing or wrong fields, keeps the good ones', () => {
    const r = parseState(
      JSON.stringify(
        snapshot({
          crew: [
            { role: 'builder', item: 'APP-1', state: 'working' },
            { item: 'APP-2', state: 'working' },
            { role: 'builder', state: 'working' },
            { role: 'builder', item: 'APP-3', state: 'dancing' },
            null,
            'x',
            { role: 5, item: 'APP-4', state: 'working' },
          ],
          forOwner: [{ id: 'a', title: 'ok' }, { id: 'b' }, 7, { title: 'x' }],
          queue: { pending: [{ pr: 1, repo: 'org/app' }, { pr: 'x', repo: 'org/app' }, {}] },
        }),
      ),
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.state.crew.map((c) => c.item)).toEqual(['APP-1']);
      expect(r.state.forOwner).toHaveLength(1);
      expect(r.state.queue.pending).toHaveLength(1);
    }
  });
  it('caps strings at 200 code points', () => {
    const s = ok({ forOwner: [{ id: 'a', title: 'x'.repeat(500) }] });
    expect([...(s.forOwner[0]?.title ?? '')]).toHaveLength(200);
  });
  it('does not let a __proto__ key pollute', () => {
    const r = parseState(
      '{"usageDays":{"__proto__":{"label-a":1}},"metrics":{"perDay":{"__proto__":{"merged":1,"deployed":1}}}}',
    );
    expect(r.kind).toBe('ok');
    expect(({} as Record<string, unknown>)['label-a']).toBeUndefined();
    expect(({} as Record<string, unknown>).merged).toBeUndefined();
  });
});

describe('alerts', () => {
  it('toasts only the four classes', () => {
    const s = ok({
      forOwner: [
        { id: 'APP-5', title: 'Sign' },
        { id: 'account-block', title: 'Account blocked' },
      ],
      notifications: [
        {
          id: 'account-block',
          title: 'Account blocked',
          reason: 'usage',
          at: 'x',
          label: 'label-a',
        },
      ],
      mainBuild: { status: 'red', sha: 'abc1234' },
      crew: [
        { role: 'builder', item: 'APP-1', state: 'crashed', since: 's1' },
        { role: 'builder', item: 'APP-2', state: 'stopped', since: 's2' },
        { role: 'builder', item: 'APP-3', state: 'blocked', since: 's3' },
      ],
    });
    expect(alertsFor(s).map((a) => a.key)).toEqual([
      'owner:APP-5:Sign',
      'block:label-a:usage',
      'main-red:abc1234',
      'crash:APP-1:s1',
    ]);
  });
  it('nothing for a quiet board', () => {
    expect(alertsFor(ok({ forOwner: [], crew: [] }))).toEqual([]);
  });
  it('suppresses repeats, and toasts again after the key cleared', () => {
    const s = ok({ forOwner: [{ id: 'APP-5', title: 'Sign' }] });
    const first = newAlerts([], s);
    expect(first.toasts).toHaveLength(1);
    expect(first.seen).toEqual(['owner:APP-5:Sign']);
    const second = newAlerts(first.seen, s);
    expect(second.toasts).toEqual([]);
    expect(second.seen).toEqual(['owner:APP-5:Sign']);
    const cleared = newAlerts(second.seen, ok({ forOwner: [] }));
    expect(cleared).toEqual({ toasts: [], seen: [] });
    expect(newAlerts(cleared.seen, s).toasts).toHaveLength(1);
  });
  it('toast text has no escape', () => {
    const s = ok({ forOwner: [{ id: 'APP-5', title: 'Sign\u001b]0;x\u0007' }] });
    const toasts = newAlerts([], s).toasts;
    expect(toasts.length).toBe(1);
    for (const t of toasts) expect(t).not.toMatch(/\p{Cc}/u);
  });
});

describe('boardLines', () => {
  const read = (over: Record<string, unknown> = {}): BoardRead => ({
    kind: 'ok',
    state: ok(over),
  });
  const wide = '日本語のとても長いタイトル🙂🙂🙂'.repeat(10);
  const o = (columns: number) => ({ columns, nowMs: NOW, paused: false });

  it.each([20, 40, 72, 120])('no line is wider than %i columns', (columns) => {
    const r = read({
      crew: [
        {
          role: 'builder',
          item: 'APP-1',
          state: 'working',
          title: wide,
          label: wide,
          pr: 123456,
          since: '2026-11-01T10:00:00.000Z',
        },
        { role: 'x'.repeat(100), item: 'APP-2', state: 'crashed', title: 'ok', since: 's' },
      ],
    });
    const lines = boardLines(r, o(columns));
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect([...l.text].length).toBeLessThanOrEqual(columns);
  });
  it('treats columns under 20 as 20', () => {
    const lines = boardLines(read(), o(3));
    expect(lines.some((l) => [...l.text].length > 3)).toBe(true);
    for (const l of lines) expect([...l.text].length).toBeLessThanOrEqual(20);
  });
  it('uses one line per crew row when wide and two when narrow', () => {
    const one = {
      crew: [{ role: 'builder', item: 'APP-1', state: 'working', title: 'T', label: 'label-a' }],
    };
    const w = boardLines(read(one), o(100)).filter((l) => l.text.includes('APP-1'));
    expect(w).toHaveLength(1);
    expect(w[0]?.text).toContain('● working');
    expect(w[0]?.tone).toBe('ok');
    const n = boardLines(read(one), o(50));
    const i = n.findIndex((l) => l.text.includes('APP-1'));
    expect(n[i + 1]?.text.startsWith('  ')).toBe(true);
    expect(n[i + 1]?.text).toContain('label-a');
  });
  it('has word, symbol and tone per state', () => {
    const states = ['working', 'waiting', 'blocked', 'stopped', 'crashed', 'done'];
    const r = read({ crew: states.map((s, i) => ({ role: 'r', item: `APP-${i}`, state: s })) });
    const lines = boardLines(r, o(120));
    const expected: Record<string, [string, string]> = {
      working: ['● working', 'ok'],
      waiting: ['◐ waiting', 'wait'],
      blocked: ['■ blocked', 'err'],
      stopped: ['○ stopped', 'idle'],
      crashed: ['✕ crashed', 'err'],
      done: ['✓ done', 'dim'],
    };
    for (const [s, [text, tone]] of Object.entries(expected)) {
      const l = lines.find((x) => x.text.includes(text));
      expect(l, s).toBeDefined();
      expect(l?.tone).toBe(tone);
    }
  });
  it('leaves done rows out when more than 10 rows exist', () => {
    const crew = Array.from({ length: 11 }, (_, i) => ({
      role: 'r',
      item: `APP-${i}`,
      state: i === 0 ? 'done' : 'working',
    }));
    const text = boardLines(read({ crew }), o(120))
      .map((l) => l.text)
      .join('\n');
    expect(text).not.toContain('✓ done');
    const few = boardLines(read({ crew: crew.slice(0, 10) }), o(120));
    expect(few.map((l) => l.text).join('\n')).toContain('✓ done');
  });
  it('draws the CI bar and the merge rule', () => {
    const lines = boardLines(read(), o(48)).map((l) => l.text);
    expect(lines).toContain('CI [█████░░░] 5/8');
    expect(lines).toContain('merge rule: at most 5/8 busy');
    const over = boardLines(read({ ci: { busy: 7, total: 8, mergeMaxBusy: 5, ok: true } }), o(48));
    expect(over.map((l) => l.text)).toContain('merge rule: at most 5/8 busy, now over');
    const bad = boardLines(read({ ci: { busy: 0, total: 8, mergeMaxBusy: 5, ok: false } }), o(48));
    expect(bad.map((l) => l.text)).toContain('CI unreadable, counted as busy');
    expect(bad.map((l) => l.text).join('\n')).not.toContain('merge rule');
  });
  it('shows queue, merged today, for you, lead time, days and usage', () => {
    const text = boardLines(read(), o(120))
      .map((l) => l.text)
      .join('\n');
    expect(text).toContain('org/app#7');
    expect(text).toContain('checks');
    expect(text).toContain('… 2 more');
    expect(text).toContain('Merged today: #3, #4');
    expect(text).toContain('For you (2)');
    expect(text).toContain('Sign the thing');
    expect(text).toContain('Lead time (median) 3.3 h · deploys today 2');
    expect(text).toContain('2026-10-31 3/1');
    expect(text).toContain('2026-11-01 2/2');
    expect(text).toContain('label-a 4');
    expect(text).toContain('label-b 2');
  });
  it('adds a dim stale line at the top after 15 minutes', () => {
    const lines = boardLines(read({ updatedAt: '2026-11-01T11:30:00.000Z' }), o(80));
    expect(lines[0]).toEqual({ text: 'Last update 30 min ago.', tone: 'dim' });
    const fresh = boardLines(read({ updatedAt: '2026-11-01T11:50:00.000Z' }), o(80));
    expect(fresh[0]?.text).not.toContain('Last update');
  });
  it('shows the exact calm messages', () => {
    expect(boardLines({ kind: 'missing' }, o(80)).map((l) => l.text)).toEqual([
      'No board yet. The control room writes it with studio state.',
    ]);
    expect(boardLines({ kind: 'unreadable' }, o(80)).map((l) => l.text)).toEqual([
      'The board cannot be read just now. It refreshes by itself.',
    ]);
    expect(statusText({ kind: 'missing' }, false)).toBe(
      'No board yet. The control room writes it with studio state.',
    );
    expect(statusText({ kind: 'unreadable' }, true)).toBe(
      'The board cannot be read just now. It refreshes by itself.',
    );
    expect(statusText(read(), true)).toBe(statusLine(ok(), true));
  });
});

describe('formatRuntime', () => {
  it.each([
    [-5, '0s'],
    [Number.NaN, '0s'],
    [42_000, '42s'],
    [5 * 60_000, '5m'],
    [3_600_000 + 7 * 60_000, '1h 7m'],
    [26 * 3_600_000, '1d 2h'],
  ])('%s -> %s', (ms, out) => {
    expect(formatRuntime(ms)).toBe(out);
  });
});

describe('stateDirName parity with src/paths.ts', () => {
  const sha = (p: string): string => createHash('sha256').update(p).digest('hex');
  it.each([
    '/srv/a/Projekte/app',
    '/srv/a/with space/my app',
    '/srv/a/ünïcode/日本語-プロジェクト',
    `/srv/a/${'long-name-'.repeat(20)}`,
    '/srv/a/app/',
    '/',
    '/srv/a/we!rd$name',
  ])('%s', (p) => {
    expect(stateDirName(p, sha(p))).toBe(srcStateDirName(p));
  });
});
