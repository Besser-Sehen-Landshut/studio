import { describe, expect, it } from 'vitest';
import type { Board, WorkItem } from '../src/board.js';
import { DEFAULT_PLUGINS } from '../src/plugins.js';
import {
  addUpdateItems,
  pluginUpdates,
  SKILLS_CHECK_DAYS,
  sourceUpdates,
} from '../src/skills-check.js';

const SP = 'superpowers@superpowers-marketplace';
const offered = (version: string, security = false) => new Map([[SP, { version, security }]]);
const board = (items: Partial<WorkItem>[] = []): Board =>
  ({
    items: items.map((i, n) => ({
      id: `APP-${n + 1}`,
      title: 't',
      type: 'fix',
      role: 'builder',
      repo: 'org/app',
      size: 'S',
      priority: 3,
      status: 'ready',
      paths: [],
      touches: [],
      dependsOn: [],
      dod: ['d'],
      history: [],
      ...i,
    })),
  }) as Board;

describe('plugin updates', () => {
  it('a newer offered version is one update; the same or an older one is none', () => {
    expect(pluginUpdates(DEFAULT_PLUGINS, offered('7.1.0'))).toEqual([
      expect.objectContaining({
        key: `plugin ${SP} 7.1.0`,
        title: `Update ${SP} to 7.1.0`,
        security: false,
      }),
    ]);
    expect(pluginUpdates(DEFAULT_PLUGINS, offered('7.0.2'))).toEqual([]);
    expect(pluginUpdates(DEFAULT_PLUGINS, offered('6.9.0'))).toEqual([]);
  });
  it('its Definition of Done compares, runs the stored scenarios and adopts only after review', () => {
    const [u] = pluginUpdates(DEFAULT_PLUGINS, offered('7.1.0'));
    expect(u?.dod.join('\n')).toMatch(/Compare/);
    expect(u?.dod.join('\n')).toMatch(/test\/skills/);
    expect(u?.dod.join('\n')).toMatch(/adaptation of Studio's own rules/);
    expect(u?.dod.join('\n')).toMatch(/only after a green review/);
  });
});

describe('source updates', () => {
  it('a changed watched file is one update; fits is none; an unjudged source is a problem', () => {
    const r = sourceUpdates([
      {
        id: 'ehmo',
        verdict: 'unclear',
        findings: [{ kind: 'changed', detail: 'skills/web/SKILL.md' }],
        pinned: 'a'.repeat(40),
        candidate: 'b'.repeat(40),
      },
      { id: 'emil', verdict: 'fits', findings: [], pinned: 'c'.repeat(40) },
      {
        id: 'taste',
        verdict: 'unclear',
        findings: [{ kind: 'not-fetched', detail: 'run studio setup sources' }],
      },
    ]);
    expect(r.updates).toEqual([
      expect.objectContaining({
        key: `source ehmo ${'b'.repeat(40)}`,
        title: 'Review upstream change in ehmo',
      }),
    ]);
    expect(r.problems).toEqual(['source taste: not-fetched: run studio setup sources']);
  });
});

describe('update items on the board', () => {
  const updates = pluginUpdates(DEFAULT_PLUGINS, offered('7.1.0'));
  it('adds one ready chore for a builder, at the end of the queue', () => {
    const r = addUpdateItems({ board: board([{}]), updates, repo: 'org/app', security: [] });
    expect(r.added).toEqual([{ item: 'APP-2', key: `plugin ${SP} 7.1.0`, priority: 4 }]);
    const item = r.board.items.find((i) => i.id === 'APP-2');
    expect(item).toMatchObject({
      type: 'chore',
      role: 'builder',
      status: 'ready',
      title: `Update ${SP} to 7.1.0`,
      touches: ['.studio/studio.yaml'],
    });
    expect(item?.notes?.[0]).toBe(`skills-update: plugin ${SP} 7.1.0`);
  });
  it('is idempotent: the same update gets no second item, in any status', () => {
    const once = addUpdateItems({ board: board(), updates, repo: 'org/app', security: [] });
    const twice = addUpdateItems({ board: once.board, updates, repo: 'org/app', security: [] });
    expect(twice.added).toEqual([]);
    expect(twice.present).toEqual([{ item: 'APP-1', key: `plugin ${SP} 7.1.0` }]);
    expect(twice.board.items).toHaveLength(1);
    const dropped = {
      ...once.board,
      items: once.board.items.map((i) => ({ ...i, status: 'dropped' as const })),
    };
    expect(
      addUpdateItems({ board: dropped, updates, repo: 'org/app', security: [] }).added,
    ).toEqual([]);
    // A newer version is another update.
    const next = pluginUpdates(DEFAULT_PLUGINS, offered('7.2.0'));
    expect(
      addUpdateItems({ board: once.board, updates: next, repo: 'org/app', security: [] }).added,
    ).toHaveLength(1);
  });
  it('a security update gets priority 0, from an advisory or from the lead', () => {
    const advisory = pluginUpdates(DEFAULT_PLUGINS, offered('7.1.0', true));
    const r = addUpdateItems({
      board: board([{}]),
      updates: advisory,
      repo: 'org/app',
      security: [],
    });
    expect(r.added[0]?.priority).toBe(0);
    expect(r.board.items.at(-1)?.notes).toContain('security-relevant update: priority 0');
    const plain = addUpdateItems({ board: board(), updates, repo: 'org/app', security: [] });
    expect(plain.added[0]?.priority).toBe(1);
    const marked = addUpdateItems({ board: plain.board, updates, repo: 'org/app', security: [SP] });
    expect(marked.raised).toEqual(['APP-1']);
    expect(marked.board.items[0]?.priority).toBe(0);
  });
  it('the cadence is a month', () => {
    expect(SKILLS_CHECK_DAYS).toBe(30);
  });
});
