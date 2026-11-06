import { describe, expect, it } from 'vitest';
import { type BoardRead, cellWidth, paneLines, parseState } from '../hooks/board-model.js';
import { NOW, scenario } from './pane-fixture.js';

const GROUP = {
  name: 'shop',
  main: 'platform',
  self: 'platform',
  projects: [
    {
      id: 'platform',
      repo: 'org/platform',
      main: true,
      self: true,
      stateDir: '0123456789abcdef-platform',
      counts: { decisions: 1, running: 2, waiting: 1, ready: 3, blocked: 0 },
      decisions: [{ item: 'APP-15', code: 'fix_limit' }],
    },
    {
      id: 'web',
      repo: 'org/web',
      main: false,
      self: false,
      stateDir: 'fedcba9876543210-web',
      counts: { decisions: 1, running: 0, waiting: 0, ready: 0, blocked: 1 },
      decisions: [{ item: 'WEB-3', code: 'merge_failed', reason: 'crew text must not show' }],
    },
    {
      id: 'mobile-companion-app',
      repo: 'org/mobile',
      main: false,
      self: false,
      decisions: [],
      problem: 'no state yet',
    },
  ],
};
const read = (group: unknown = GROUP): BoardRead => {
  const r = parseState(JSON.stringify(scenario({ group })));
  if (r.kind !== 'ok') throw new Error('expected ok');
  return r;
};
const draw = (r: BoardRead, columns: number, lang: 'en' | 'de' = 'en') =>
  paneLines(r, { nowMs: NOW, paused: false, columns, view: 'group', lang }).map((l) => l.text);

describe('the REA install confirmation in the pane', () => {
  const rea = (reaInstall: unknown) =>
    parseState(
      JSON.stringify(
        scenario({
          needsLead: [
            { item: 'APP-5', code: 'rea_install', reason: 'x', next: { say: 'show APP-5' } },
          ],
          reaInstall,
        }),
      ),
    );
  it('is a button under the decision, never a phrase to say', () => {
    for (const lang of ['en', 'de'] as const) {
      const lines = paneLines(rea({ version: '6.7.0', mode: 'full', needsFolder: true }), {
        nowMs: NOW,
        paused: false,
        columns: 72,
        lang,
      });
      const b = lines.find((l) => l.button !== undefined);
      expect(b?.button?.key).toBe('rea-confirm');
      expect(b?.button?.label).toBe(
        lang === 'en'
          ? 'Confirm REA install (rea-agents 6.7.0, folder ~/analysis)'
          : 'REA-Installation bestätigen (rea-agents 6.7.0, Ordner ~/analysis)',
      );
      expect(lines.some((l) => l.text.includes('say "show APP-5"'))).toBe(false);
    }
  });
  it('a state without the pending install, or with an odd version, gets no button', () => {
    for (const r of [
      undefined,
      { version: 'latest', mode: 'full' },
      { version: '1.2.3', mode: 'x' },
    ]) {
      const lines = paneLines(rea(r), { nowMs: NOW, paused: false, columns: 72 });
      expect(lines.some((l) => l.button !== undefined)).toBe(false);
    }
  });
});

describe('the group view', () => {
  it('one line per project, decisions collected across projects with the command to open each', () => {
    const lines = draw(read(), 72);
    expect(lines[0]).toMatch(/^Group shop\s+updated/);
    expect(lines).toContain('! 2 decisions needed');
    expect(lines).toContain('! platform · APP-15 fix limit reached – decide');
    expect(lines).toContain('! web · WEB-3 merge failed');
    expect(lines).toContain('  → /studio group web');
    expect(lines.some((l) => /^platform \(main, here\)\s+! 1 {2}● 2 {2}◷ 1 {2}○ 3$/.test(l))).toBe(
      true,
    );
    expect(lines.some((l) => /^web\s+! 1 {2}■ 1$/.test(l))).toBe(true);
    expect(lines.some((l) => /^mobile-companion-app\s+no state yet$/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain('crew text');
  });

  it('German text, English commands', () => {
    const lines = draw(read(), 72, 'de');
    expect(lines[0]).toMatch(/^Verbund shop/);
    expect(lines.some((l) => l.startsWith('platform (Haupt, hier)'))).toBe(true);
    expect(lines).toContain('  → /studio group web');
  });

  for (const columns of [24, 30, 44]) {
    it(`at ${columns} columns no line is wider and no project id is cut`, () => {
      const lines = draw(read(), columns);
      for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
      expect(lines.some((l) => l.startsWith('mobile-companion-app'))).toBe(true);
      // The counts go to a line of their own, indented, when they do not fit beside the id.
      const at = lines.indexOf('platform (main, here)');
      if (columns < 40) {
        expect(at).toBeGreaterThan(0);
        expect(lines[at + 1]).toMatch(/^ {4}! 1/);
      } else expect(at).toBe(-1);
    });
  }

  it('a project in no group says so', () => {
    const r = parseState(JSON.stringify(scenario({})));
    const lines = paneLines(r, { nowMs: NOW, paused: false, columns: 60, view: 'group' }).map(
      (l) => l.text,
    );
    expect(lines.join(' ')).toContain('This project is in no group');
  });

  it('drops rows, state folders and decisions of an unexpected form', () => {
    const r = read({
      ...GROUP,
      projects: [
        { id: 'Bad Id', repo: 'x', main: false, self: false, decisions: [] },
        {
          id: 'web',
          repo: 'org/web',
          main: false,
          self: false,
          stateDir: '../../etc',
          counts: { decisions: 0, running: 0, waiting: 0, ready: 0, blocked: 0 },
          decisions: [{ item: '<x>', code: 'merge_failed' }],
        },
      ],
    });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.state.group?.projects).toEqual([
      {
        id: 'web',
        repo: 'org/web',
        main: false,
        self: false,
        counts: { decisions: 0, running: 0, waiting: 0, ready: 0, blocked: 0 },
        decisions: [],
      },
    ]);
    expect(draw(r, 60).some((l) => /^web\s+✓ nothing open$/.test(l))).toBe(true);
  });

  it('another project shown from the group gets the way back on top', () => {
    const r = parseState(JSON.stringify(scenario({})));
    const lines = paneLines(r, {
      nowMs: NOW,
      paused: false,
      columns: 60,
      view: 'list',
      focusOf: 'shop',
    }).map((l) => l.text);
    expect(lines[0]).toBe('Group shop · back: /studio group');
    expect(lines[1]).toMatch(/^Studio · /);
  });
});
