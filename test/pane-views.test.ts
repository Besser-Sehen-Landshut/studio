import { describe, expect, it } from 'vitest';
import {
  type BoardRead,
  boardLines,
  cellWidth,
  type Lang,
  type Line,
  langOf,
  newAlerts,
  paneLines,
  parseState,
  statusLine,
  type View,
} from '../hooks/board-model.js';
import { NOW, scenario } from './pane-fixture.js';

const read = (over: Record<string, unknown> = {}): BoardRead => {
  const r = parseState(JSON.stringify(scenario(over)));
  if (r.kind !== 'ok') throw new Error('expected ok');
  return r;
};
const draw = (
  r: BoardRead,
  o: { columns: number; view?: View; lang?: Lang; paused?: boolean; nowMs?: number },
) => paneLines(r, { nowMs: NOW, paused: false, ...o });
/** Each line with its tone, as a snapshot shows it. */
const shown = (lines: Line[]) => lines.map((l) => `${l.text}${l.tone ? `  ⟨${l.tone}⟩` : ''}`);
const texts = (lines: Line[]) => lines.map((l) => l.text);

const LANGS: Lang[] = ['en', 'de'];
const WIDTHS = [40, 60, 100];
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe('the two views of the scenario', () => {
  for (const view of ['list', 'pipeline'] as const) {
    for (const lang of LANGS) {
      for (const columns of WIDTHS) {
        it(`${view}, ${lang}, ${columns} columns`, () => {
          expect(shown(draw(read(), { columns, view, lang }))).toMatchSnapshot();
        });
      }
    }
  }
});

describe('the special states', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['no work', { items: [], needsLead: [], today: { merged: [] } }],
    ['paused', { pause: { time: '14:02' } }],
    ['stale', { updatedAt: ago(14) }],
  ];
  for (const [name, over] of cases) {
    for (const lang of LANGS) {
      it(`${name}, ${lang}`, () => {
        expect(shown(draw(read(over), { columns: 40, lang }))).toMatchSnapshot();
      });
    }
  }

  it('a pause the mod sees but the state does not know says paused without a time', () => {
    const t = texts(draw(read(), { columns: 60, paused: true }));
    expect(t[1]).toBe('Paused. Nothing starts or merges; running crews finish.');
    expect(t).toContain('→ /studio resume');
  });

  it('is fresh up to 10 minutes and stale after', () => {
    expect(texts(draw(read({ updatedAt: ago(10) }), { columns: 60 }))[0]).toMatch(
      /updated 10 min ago$/,
    );
    const stale = texts(draw(read({ updatedAt: ago(11) }), { columns: 60 }));
    expect(stale[0]).toMatch(/! stale$/);
    expect(stale[1]).toBe('Last update 11 min ago. Is the lead loop still running?');
    expect(stale[2]).toBe('→ say "start the Studio lead loop"');
  });

  it.each(LANGS)('missing and unreadable state keep their calm message (%s)', (lang) => {
    for (const kind of ['missing', 'unreadable'] as const) {
      const lines = draw({ kind }, { columns: 40, lang, paused: true });
      expect(shown(lines)).toMatchSnapshot();
      for (const l of lines) expect([...l.text].length).toBeLessThanOrEqual(40);
    }
  });

  it('the calm messages read as before in English', () => {
    expect(texts(draw({ kind: 'missing' }, { columns: 80 }))).toEqual([
      'No board yet. The control room writes it with studio state.',
    ]);
    expect(texts(draw({ kind: 'unreadable' }, { columns: 80 }))).toEqual([
      'The board cannot be read just now. It refreshes by itself.',
    ]);
  });

  it('merges today alone are no empty board', () => {
    const t = texts(draw(read({ items: [], needsLead: [] }), { columns: 60 }));
    expect(t).not.toContain('No work yet.');
    expect(t[1]).toBe('✓ 3 today');
  });
});

describe('the work list', () => {
  it('sorts each section decision, running, waiting, ready', () => {
    const items = [
      { id: 'APP-1', title: 'a', stage: 'ready', epic: 'E-3' },
      {
        id: 'APP-2',
        title: 'b',
        stage: 'queued',
        epic: 'E-3',
        wait: { code: 'merging', text: '' },
      },
      { id: 'APP-3', title: 'c', stage: 'building', epic: 'E-3' },
      { id: 'APP-4', title: 'd', stage: 'in_review', epic: 'E-3' },
      { id: 'APP-5', title: 'e', stage: 'review', epic: 'E-3' },
      { id: 'APP-6', title: 'f', stage: 'blocked', epic: 'E-3' },
    ];
    const t = texts(draw(read({ items, needsLead: [] }), { columns: 60 }));
    const ids = t.flatMap((l) => /^ {2}\S (APP-\d+)/.exec(l)?.[1] ?? []);
    // APP-4 has no known stage and is dropped by the parser.
    expect(ids).toEqual(['APP-6', 'APP-3', 'APP-5', 'APP-2', 'APP-1']);
  });

  it('leaves out empty sections', () => {
    const t = texts(
      draw(
        read({
          items: [{ id: 'APP-1', title: 'a', stage: 'ready', epic: 'E-3' }],
          needsLead: [],
          today: { merged: [] },
          epics: [
            { id: 'E-3', title: 'Connection limits', status: 'open', merged: 1, total: 4 },
            { id: 'E-4', title: 'Nothing yet', status: 'open', merged: 0, total: 0 },
          ],
        }),
        { columns: 60 },
      ),
    );
    expect(t.some((l) => l.startsWith('E-4'))).toBe(false);
    expect(t).not.toContain('Without epic');
    expect(t.some((l) => l.startsWith('Decision needed'))).toBe(false);
  });

  it('shows the lines for the owner and a red main build as decisions', () => {
    const t = texts(
      draw(
        read({
          needsLead: [],
          forOwner: [
            { id: 'APP-30', title: 'Rotate the deploy key' },
            { id: 'usage-limit', title: 'label main at its usage limit until 14:00' },
          ],
          mainBuild: { status: 'red', sha: 'abcdef1234' },
        }),
        { columns: 72 },
      ),
    );
    expect(t).toContain('! APP-30 Rotate the deploy key');
    expect(t).toContain('  → say "show APP-30"');
    expect(t).toContain('! label main at its usage limit until 14:00');
    expect(t).toContain('! Main build is red (abcdef1)');
    expect(t[1]).toMatch(/^! 3 decisions needed/);
  });

  it('cuts a long title with an ellipsis, never the id, the glyph, the word or the time', () => {
    const long = 'A very long title that does not fit into a narrow pane at all';
    const r = read({
      items: [{ id: 'APP-123', title: long, stage: 'building', since: ago(75) }],
      needsLead: [],
    });
    for (const columns of [20, 30, 40, 60]) {
      for (const lang of LANGS) {
        const line = texts(draw(r, { columns, lang })).find((l) => l.includes('APP-123'));
        expect(line, `${columns} ${lang}`).toBeDefined();
        expect(line).toMatch(/● APP-123 /);
        expect(line).toMatch(lang === 'en' ? /building/ : /baut/);
        if (columns >= 40) {
          expect(line).toContain('…');
          expect(line).toMatch(lang === 'en' ? /1h 15m$/ : /1h 15min$/);
        }
        expect([...(line as string)].length).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('a waiting item has a dimmed second line with its reason, in both languages', () => {
    const en = draw(read(), { columns: 72 });
    const at = en.findIndex((l) => l.text.includes('APP-12'));
    expect(en[at + 1]).toEqual({ text: '    queue: runners 6/8 busy, merge at ≤5', tone: 'dim' });
    const de = draw(read(), { columns: 72, lang: 'de' });
    const dat = de.findIndex((l) => l.text.includes('APP-12'));
    expect(de[dat + 1]?.text).toBe('    Warteschlange: Läufer 6/8 belegt, Merge ab ≤5');
  });

  it('localizes every wait code it knows', () => {
    const waits = [
      { code: 'checks_pending', text: 'checks pending' },
      { code: 'review_pending', text: 'x' },
      { code: 'queue_held', text: 'paused' },
      { code: 'queue_position', text: 'x', position: 2 },
      { code: 'updating', text: 'x' },
      { code: 'merging', text: 'x' },
      { code: 'held', text: 'wip builder 2/2' },
      { code: 'worker', text: 'on win-bot (windows), heartbeat 2 min ago' },
      { code: 'unknown', text: 'kept as it is' },
    ];
    const items = waits.map((wait, i) => ({
      id: `APP-${i + 1}`,
      title: 't',
      stage: 'queued',
      wait,
    }));
    const r = read({ items, needsLead: [] });
    const reasons = (lang: Lang) =>
      texts(draw(r, { columns: 72, lang })).filter((l) => l.startsWith('    '));
    expect(reasons('en')).toEqual([
      '    queue: checks pending',
      '    queue: review not started yet',
      '    queue: queue held: paused',
      '    queue: place 2 in the queue',
      '    queue: updating the branch',
      '    queue: merging',
      '    queue: held: wip builder 2/2',
      '    queue: worker: on win-bot (windows), heartbeat 2 min ago',
      '    queue: kept as it is',
    ]);
    expect(reasons('de')).toEqual([
      '    Warteschlange: Prüfungen laufen',
      '    Warteschlange: Review noch nicht begonnen',
      '    Warteschlange: Warteschlange angehalten: paused',
      '    Warteschlange: Platz 2 in der Warteschlange',
      '    Warteschlange: Zweig wird aktualisiert',
      '    Warteschlange: wird gemergt',
      '    Warteschlange: zurückgestellt: wip builder 2/2',
      '    Warteschlange: Arbeiter: on win-bot (windows), heartbeat 2 min ago',
      '    Warteschlange: kept as it is',
    ]);
  });
});

describe('the pipeline', () => {
  it('draws the work list when five columns do not fit', () => {
    for (const lang of LANGS) {
      expect(draw(read(), { columns: 40, view: 'pipeline', lang })).toEqual(
        draw(read(), { columns: 40, view: 'list', lang }),
      );
    }
    // English column heads need 68 cells, German ones fit in 60.
    expect(texts(draw(read(), { columns: 67, view: 'pipeline' })).join('\n')).not.toMatch(/READY/);
    expect(texts(draw(read(), { columns: 68, view: 'pipeline' })).join('\n')).toMatch(/READY 2/);
    expect(texts(draw(read(), { columns: 60, view: 'pipeline', lang: 'de' })).join('\n')).toMatch(
      /BEREIT 2/,
    );
  });

  it('marks a full column with a sign and a word', () => {
    const t = texts(
      draw(read({ wip: { building: 1, review: 2 } }), { columns: 100, view: 'pipeline' }),
    );
    const head = t.findIndex((l) => l.startsWith('READY'));
    expect(t[head]).toMatch(/BUILDING 1\/1/);
    expect(t[head + 1]).toMatch(/⚠ full/);
    const de = texts(
      draw(read({ wip: { building: 1, review: 2 } }), {
        columns: 100,
        view: 'pipeline',
        lang: 'de',
      }),
    );
    expect(de.join('\n')).toMatch(/⚠ voll/);
  });

  it('a column without a limit shows its count only', () => {
    const t = texts(
      draw(read({ wip: { building: 0, review: 0 } }), { columns: 100, view: 'pipeline' }),
    );
    expect(t.find((l) => l.startsWith('READY'))).toMatch(/BUILDING 1 +REVIEW 1 +QUEUE 1/);
  });

  it('lists blocked work in a row of its own, not in a column', () => {
    const t = texts(draw(read(), { columns: 100, view: 'pipeline' }));
    const at = t.indexOf('■ BLOCKED 1');
    expect(at).toBeGreaterThan(0);
    expect(t[at + 1]).toBe('  APP-15 fix limit reached – decide (E3)');
    const head = t.findIndex((l) => l.startsWith('READY'));
    expect(t.slice(head, at).join('\n')).not.toContain('APP-15');
  });

  it('shows at most four cards and six merges per column, then a count', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `APP-${i + 1}`,
      title: 't',
      stage: 'ready',
    }));
    const merged = Array.from({ length: 8 }, (_, i) => ({
      pr: i + 1,
      repo: 'o/r',
      item: `APP-${50 + i}`,
    }));
    const t = texts(
      draw(read({ items, needsLead: [], today: { merged } }), { columns: 100, view: 'pipeline' }),
    ).join('\n');
    expect(t).toMatch(/^\+2/m);
    expect(t).toMatch(/\+2$/m);
    expect(t).toContain('TODAY ✓8');
  });
});

describe('meaning never by colour alone', () => {
  const GLYPHS = /^ *([!■●◷○✓]) /;
  const WORDS: Record<Lang, RegExp> = {
    en: /\b(decide|blocked|building|review|waiting|ready|done|today)\b/,
    de: /(entscheiden|blockiert|baut|Review|wartet|bereit|fertig|heute)/,
  };
  for (const lang of LANGS) {
    for (const columns of [20, 40, 60, 100]) {
      it(`every item line carries a glyph and a word (${lang}, ${columns})`, () => {
        const lines = draw(read(), { columns, lang });
        // The item rows below the decision block (whose heading carries the word).
        const first = lines.findIndex((l) => l.text.startsWith('E-3'));
        const rows = lines
          .slice(first)
          .filter((l) => l.tone !== 'dim' && /^ *\S APP-\d+/.test(l.text));
        expect(rows.length).toBe(6);
        for (const l of rows) {
          expect(l.text).toMatch(GLYPHS);
          expect(l.text).toMatch(WORDS[lang] as RegExp);
        }
        for (const l of lines.filter((x) => /✓ \d/.test(x.text)))
          expect(l.text).toMatch(WORDS[lang] as RegExp);
      });
    }
  }

  it('every count of the summary has a glyph and a word', () => {
    const t = texts(draw(read(), { columns: 100 }));
    expect(t[1]).toBe('! 1 decision needed  ● 2 running  ◷ 1 waiting  ✓ 3 today');
    expect(texts(draw(read(), { columns: 100, lang: 'de' }))[1]).toBe(
      '! 1 Entscheidung nötig  ● 2 laufen  ◷ 1 wartet  ✓ 3 heute fertig',
    );
  });

  it('every pipeline card starts with a glyph under a column head word', () => {
    const t = texts(draw(read(), { columns: 100, view: 'pipeline' }));
    const head = t.findIndex((l) => l.startsWith('READY'));
    expect(t[head]).toMatch(/READY 2 +BUILDING 1\/4 +REVIEW 1\/2 +QUEUE 1 +TODAY ✓3/);
    expect(t[head + 2]).toMatch(/^○ APP-16 +● APP-17 +● APP-14 +◷ APP-12 +✓ APP-11$/);
  });
});

describe('widths', () => {
  const huge = '日本語のとても長いタイトル🙂'.repeat(20);
  const r = read({
    project: 'x'.repeat(80),
    items: [
      {
        id: 'APP-1',
        title: huge,
        stage: 'queued',
        epic: 'E-3',
        since: ago(3000),
        wait: { code: 'held', text: huge },
      },
      { id: 'APP-2', title: huge, stage: 'blocked', wait: { code: 'blocked', text: huge } },
    ],
    needsLead: [{ item: 'APP-2', code: 'other', reason: huge, next: { say: huge } }],
    epics: [{ id: 'E-3', title: huge, status: 'open', merged: 3, total: 9 }],
    pause: { time: '09:00' },
    updatedAt: ago(90),
  });
  for (const view of ['list', 'pipeline', 'more'] as const) {
    for (const lang of LANGS) {
      it.each([20, 33, 40, 60, 64, 100, 140])(
        `${view} ${lang}: no line is wider than %i`,
        (columns) => {
          const lines = draw(r, { columns, view, lang });
          expect(lines.length).toBeGreaterThan(3);
          for (const l of lines) expect([...l.text].length).toBeLessThanOrEqual(columns);
        },
      );
    }
  }
});

describe('views and states from before the work list', () => {
  it('more is the detailed view', () => {
    const o = { columns: 80, nowMs: NOW, paused: false };
    expect(paneLines(read(), { ...o, view: 'more' })).toEqual(boardLines(read(), o));
    expect(paneLines(read(), { ...o, view: 'more', lang: 'de' })).toEqual(
      boardLines(read(), { ...o, lang: 'de' }),
    );
  });

  it('a state without items draws the detailed view in every view', () => {
    const old = read({ items: undefined, needsLead: undefined });
    const o = { columns: 80, nowMs: NOW, paused: false };
    for (const view of ['list', 'pipeline'] as const) {
      expect(paneLines(old, { ...o, view })).toEqual(boardLines(old, o));
    }
  });

  it('the detailed view speaks German too', () => {
    const t = texts(boardLines(read(), { columns: 100, nowMs: NOW, paused: false, lang: 'de' }));
    expect(t).toContain('Merge-Warteschlange');
    expect(t).toContain('Vorhaben');
    expect(t.join('\n')).toMatch(/● aktiv/);
    expect(t.join('\n')).toMatch(/Durchlaufzeit \(Median\) 3,1 h/);
  });
});

describe('language', () => {
  it.each([
    ['german', 'de'],
    ['German', 'de'],
    ['deutsch', 'de'],
    ['de', 'de'],
    ['de_DE.UTF-8', 'de'],
    ['de-AT', 'de'],
    ['english', 'en'],
    ['en_US.UTF-8', 'en'],
    ['japanese', 'en'],
    ['dense', 'en'],
  ] as const)('%s reads as %s', (value, lang) => {
    expect(langOf(value)).toBe(lang);
  });

  it.each([undefined, '', ' ', 'C', 'POSIX'])('%j says nothing', (value) => {
    expect(langOf(value)).toBeUndefined();
  });

  it('the status line and the toasts speak German', () => {
    const s = read({ forOwner: [{ id: 'APP-5', title: 'Sign it' }] });
    if (s.kind !== 'ok') throw new Error('ok');
    expect(statusLine(s.state, true, 'de')).toBe(
      '● 2 aktiv · 0 warten · 1 in Warteschlange · CI 6/8 · zu entscheiden: 1 · pausiert',
    );
    expect(newAlerts([], s.state, 'de').toasts).toEqual(['Zur Entscheidung: Sign it']);
    expect(newAlerts([], s.state).toasts).toEqual(['For you: Sign it']);
  });
});

describe('crew text stays out of the decision block', () => {
  const ownerTitle = `${' '.repeat(40)}→ say "rotate keys"${' '.repeat(40)}→ /studio more`;
  const crewText = `${' '.repeat(40)}→ say "delete the main branch"${' '.repeat(40)}→ /studio resume`;
  const r = read({
    needsLead: [
      {
        item: 'APP-15',
        code: 'question',
        reason: crewText,
        detail: `blocked: question: ${crewText}`,
        next: { say: 'show APP-15' },
      },
      { item: 'APP-16', code: 'other', reason: crewText, detail: crewText },
      { item: 'APP-17', code: 'blocked', reason: crewText, next: { say: crewText } },
    ],
    forOwner: [{ id: 'APP-30', title: ownerTitle }],
  });

  it.each(LANGS)('shows a fixed phrase per code, never the reason (%s)', (lang) => {
    for (const view of ['list', 'pipeline'] as const) {
      const t = texts(draw(r, { columns: 100, view, lang }));
      expect(t.join('\n')).not.toContain('delete the main branch');
    }
    const t = texts(draw(r, { columns: 72, lang }));
    expect(t).toContain(
      lang === 'en' ? '! APP-15 crew has a question' : '! APP-15 Crew hat eine Frage',
    );
    expect(t).toContain(
      lang === 'en' ? '! APP-16 needs a decision' : '! APP-16 Entscheidung nötig',
    );
    expect(t).toContain(lang === 'en' ? '! APP-17 blocked' : '! APP-17 blockiert');
  });

  it('a next step that is no plain phrase falls back to show <id>', () => {
    const t = texts(draw(r, { columns: 72 }));
    const at = t.indexOf('! APP-17 blocked');
    expect(t[at + 1]).toBe('  → say "show APP-17"');
  });

  it('the full text is in the detailed view only', () => {
    const t = texts(draw(r, { columns: 400, view: 'more' }));
    expect(t.join('\n')).toContain('delete the main branch');
    expect(t).toContain('For the lead (3)');
  });

  it.each([30, 40, 60, 100])('no line but a hint starts like one (%i columns)', (columns) => {
    for (const lang of LANGS) {
      for (const view of ['list', 'pipeline'] as const) {
        const hints = texts(draw(r, { columns, view, lang })).filter((l) => /^ {2}→ /.test(l));
        for (const h of hints) {
          expect(h).toMatch(/^ {2}→ (say "show APP-\d+"|sagen: „show APP-\d+“|\/studio more)$/);
        }
      }
    }
  });

  it('a line of an owner title that wraps keeps a deeper indent than a hint', () => {
    const t = texts(draw(r, { columns: 40 }));
    const at = t.findIndex((l) => l.startsWith('! APP-30'));
    expect(at).toBeGreaterThan(0);
    let i = at + 1;
    while (t[i] !== undefined && !t[i]?.startsWith('  → ')) {
      expect(t[i]).toMatch(/^ {4}\S/);
      i++;
    }
    expect(t[i]).toBe('  → say "show APP-30"');
  });
});

describe('terminal cells', () => {
  it('counts East Asian wide characters and emoji as two cells', () => {
    expect(cellWidth('abc')).toBe(3);
    expect(cellWidth('日本語')).toBe(6);
    expect(cellWidth('ｱ')).toBe(1);
    expect(cellWidth('Ａ')).toBe(2);
    expect(cellWidth('🙂')).toBe(2);
    expect(cellWidth('e\u0301')).toBe(1);
    expect(cellWidth('● ◷ ○ ■ ✓ ⚠ █ ░ – → „“')).toBe(22);
  });

  it.each(LANGS)('cuts a CJK title by cells, keeping id, sign, word and time (%s)', (lang) => {
    const title = '日本語のとても長いタイトルです🙂🙂';
    const r = read({
      items: [{ id: 'APP-1', title, stage: 'building', since: ago(5) }],
      needsLead: [],
    });
    for (const columns of [30, 40, 60]) {
      const lines = draw(r, { columns, lang });
      for (const l of lines) expect(cellWidth(l.text)).toBeLessThanOrEqual(columns);
      const row = lines.find((l) => l.text.includes('APP-1'))?.text ?? '';
      expect(row).toMatch(
        lang === 'en' ? /^ {2}● APP-1 .+ +building +5m$/ : /^ {2}● APP-1 .+ +baut +5min$/,
      );
      // 34 cells of title fit only the widest pane.
      expect(row.includes('…')).toBe(columns < 60);
    }
  });

  it('no line of any view is wider than the pane in cells', () => {
    const huge = '日本語のとても長いタイトル🙂'.repeat(10);
    const r = read({
      project: huge,
      items: [
        {
          id: 'APP-1',
          title: huge,
          stage: 'queued',
          epic: 'E-3',
          wait: { code: 'held', text: huge },
        },
      ],
      epics: [{ id: 'E-3', title: huge, status: 'open', merged: 1, total: 2 }],
      forOwner: [{ id: 'APP-2', title: huge }],
    });
    for (const view of ['list', 'pipeline', 'more'] as const) {
      for (const columns of [20, 40, 68, 100]) {
        for (const l of draw(r, { columns, view })) {
          expect(cellWidth(l.text), `${view} ${columns}: ${l.text}`).toBeLessThanOrEqual(columns);
        }
      }
    }
  });

  it('the pipeline draws the work list when an id would not fit its column', () => {
    const id = 'VERYLONGPREFIX-123456';
    const r = read({ items: [{ id, title: 't', stage: 'ready' }], needsLead: [] });
    const t = texts(draw(r, { columns: 100, view: 'pipeline' }));
    expect(t.some((l) => l.startsWith('READY'))).toBe(false);
    expect(t.some((l) => l.includes(`○ ${id} `))).toBe(true);
    const wide = texts(draw(r, { columns: 130, view: 'pipeline' }));
    expect(wide.some((l) => l.startsWith('READY'))).toBe(true);
    expect(wide.some((l) => l.includes(`○ ${id}`))).toBe(true);
  });
});

describe('the cost of today in the footer', () => {
  const today = (costUsd?: number) => ({
    today: {
      day: '2026-11-01',
      merged: [{ pr: 27, repo: 'org/shop', at: ago(300), item: 'APP-11' }],
      deployed: 0,
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  });
  it('shows one value in both views and both languages', () => {
    for (const view of ['list', 'pipeline'] as const) {
      const en = texts(draw(read(today(3.456)), { columns: 100, view })).join('\n');
      expect(en).toContain('today $3.46');
      const de = texts(draw(read(today(3.456)), { columns: 100, view, lang: 'de' })).join('\n');
      // Intl's German currency format: comma decimals, the sign after a no-break space.
      expect(de).toContain('heute 3,46\u00a0$');
    }
  });
  it('shows nothing without a cost', () => {
    for (const c of [undefined, 0]) {
      expect(texts(draw(read(today(c)), { columns: 100 })).join('\n')).not.toMatch(/\$\d/);
    }
  });
});
