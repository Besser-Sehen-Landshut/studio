import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Board,
  BoardError,
  epicProgress,
  loadBoard,
  parseBoard,
  saveBoard,
  settleEpics,
  transition,
} from '../src/board.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-epics-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.studio'));
  writeFileSync(join(dir, '.studio', 'board.yaml'), yaml);
  return dir;
}

const item = (id: string, extra: string[] = []) =>
  [
    `  - id: ${id}`,
    `    title: Item ${id}`,
    '    type: fix',
    '    role: builder',
    '    repo: org/app',
    '    size: S',
    '    priority: 1',
    `    status: ${extra.find((l) => l.startsWith('status:'))?.slice(8) ?? 'ready'}`,
    '    paths: []',
    '    touches: []',
    '    depends_on: []',
    '    dod: []',
    ...extra.filter((l) => !l.startsWith('status:')).map((l) => `    ${l}`),
  ].join('\n');

const epic = (id: string, extra: string[] = []) =>
  [
    `  - id: ${id}`,
    `    title: Epic ${id}`,
    `    status: ${extra.find((l) => l.startsWith('status:'))?.slice(8) ?? 'open'}`,
    '    goal: Customers can pay by invoice',
    '    acceptance:',
    '      - an invoice order reaches the shop backend',
    ...extra.filter((l) => !l.startsWith('status:')).map((l) => `    ${l}`),
  ].join('\n');

const config = (components: string[] = ['api']): StudioConfig =>
  studioConfigSchema.parse({
    studio: 1,
    primaryRepo: 'org/app',
    repos: ['org/app'],
    ci: {
      provider: 'github',
      runners: 'github-hosted',
      runnerLabels: [],
      capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 30 },
    },
    merge: { strategy: 'studio-queue', contractPaths: [], method: 'squash' },
    roles: { builder: { model: 'sonnet', wip: 1 } },
    ownerOnly: [],
    deployCommands: [],
    components: components.map((id) => ({ id, name: id, repo: 'org/app', paths: [`${id}/**`] })),
  });

const NOW = new Date('2026-11-05T10:00:00Z');

describe('epics on the board', () => {
  it('loads a board without epics as before and saves it byte-identical', () => {
    const text = `# the board\nitems:\n${item('APP-1')}\n    history: []\n`;
    const dir = project(text);
    const board = loadBoard(dir);
    expect(board.epics).toBeUndefined();
    saveBoard(dir, board);
    expect(readFileSync(join(dir, '.studio', 'board.yaml'), 'utf8')).toBe(text);
  });

  it('round-trips a board with epics, comments on epics included', () => {
    const text = [
      'items:',
      item('APP-1', ['epic: E-1', 'history: []']),
      'epics:',
      '  # invoices first',
      epic('E-1', ['components:', '  - api', 'history: []']),
      '',
    ].join('\n');
    const dir = project(text);
    const board = loadBoard(dir, config());
    expect(board.epics?.[0]).toMatchObject({ id: 'E-1', status: 'open', components: ['api'] });
    expect(board.items[0]?.epic).toBe('E-1');
    saveBoard(dir, board);
    expect(readFileSync(join(dir, '.studio', 'board.yaml'), 'utf8')).toBe(text);
  });

  it('refuses an item naming an unknown epic, also without config', () => {
    const text = `items:\n${item('APP-1', ['epic: E-2'])}\nepics:\n${epic('E-1')}\n`;
    expect(() => parseBoard(text, 'board.yaml')).toThrow(/APP-1: epic unknown id E-2/);
    expect(() => parseBoard(`items:\n${item('APP-1', ['epic: E-1'])}\n`, 'b')).toThrow(
      /APP-1: epic unknown id E-1/,
    );
  });

  it('refuses an open item on a dropped epic; a merged or dropped one keeps it', () => {
    const on = (status: string) =>
      `items:\n${item('APP-1', ['epic: E-1', `status: ${status}`])}\nepics:\n${epic('E-1', ['status: dropped'])}\n`;
    expect(() => parseBoard(on('ready'), 'b')).toThrow(/APP-1: epic E-1 is dropped/);
    expect(parseBoard(on('merged'), 'b').items[0]?.epic).toBe('E-1');
    expect(parseBoard(on('dropped'), 'b').items[0]?.epic).toBe('E-1');
  });

  it('checks the form of an epic: id, acceptance, status, duplicates', () => {
    const bad = (lines: string) => () => parseBoard(`items: []\nepics:\n${lines}\n`, 'b');
    expect(bad(epic('EPIC-1'))).toThrow(BoardError);
    expect(bad(epic('E-1').replace(/ {4}acceptance:\n.*$/m, '    acceptance: []'))).toThrow(
      /acceptance/,
    );
    expect(bad(epic('E-1', ['status: started']))).toThrow(/status/);
    expect(bad(`${epic('E-1')}\n${epic('E-1')}`)).toThrow(/duplicate epic id E-1/);
    expect(bad(epic('E-1', ['owner: x']))).toThrow(/epics\.0\.owner: unknown key/);
  });

  it('checks the components of an open epic against the config; a dropped one keeps its ids', () => {
    const text = (status: string) =>
      `items: []\nepics:\n${epic('E-1', [`status: ${status}`, 'components: [gone]'])}\n`;
    expect(() => parseBoard(text('open'), 'b', config())).toThrow(/E-1: unknown component gone/);
    expect(parseBoard(text('open'), 'b').epics?.[0]?.components).toEqual(['gone']);
    expect(parseBoard(text('dropped'), 'b', config()).epics?.[0]?.status).toBe('dropped');
  });
});

const boardOf = (statuses: string[], epicStatus = 'open'): Board =>
  parseBoard(
    [
      'items:',
      ...statuses.map((s, i) => item(`APP-${i + 1}`, ['epic: E-1', `status: ${s}`])),
      item('APP-99'),
      'epics:',
      epic('E-1', [`status: ${epicStatus}`]),
      '',
    ].join('\n'),
    'b',
  );

describe('epic progress and status', () => {
  it('counts the items of an epic by status; dropped ones are not in the total', () => {
    const p = epicProgress(boardOf(['merged', 'ready', 'in_review', 'dropped', 'merged']), 'E-1');
    expect(p).toEqual({
      merged: 2,
      total: 4,
      counts: { merged: 2, ready: 1, in_review: 1, dropped: 1 },
    });
  });

  it('moves an open epic to accepting once all its items are merged, with history', () => {
    const { board, moved } = settleEpics(boardOf(['merged', 'dropped', 'merged']), 'studio', NOW);
    expect(moved).toEqual([{ epic: 'E-1', from: 'open', to: 'accepting' }]);
    expect(board.epics?.[0]?.status).toBe('accepting');
    expect(board.epics?.[0]?.history).toEqual([
      { at: NOW.toISOString(), from: 'open', to: 'accepting', by: 'studio' },
    ]);
  });

  it('leaves an epic without a merged item open, and one with open work', () => {
    expect(settleEpics(boardOf([]), 'studio', NOW).moved).toEqual([]);
    expect(settleEpics(boardOf(['dropped']), 'studio', NOW).moved).toEqual([]);
    expect(settleEpics(boardOf(['merged', 'queued']), 'studio', NOW).moved).toEqual([]);
  });

  it('moves an accepting epic back to open when new work joins it', () => {
    const { moved } = settleEpics(boardOf(['merged', 'ready'], 'accepting'), 'studio', NOW);
    expect(moved).toEqual([{ epic: 'E-1', from: 'accepting', to: 'open' }]);
  });

  it('never moves a done or dropped epic', () => {
    expect(settleEpics(boardOf(['merged'], 'done'), 'studio', NOW).moved).toEqual([]);
    expect(settleEpics(boardOf(['merged'], 'dropped'), 'studio', NOW).moved).toEqual([]);
  });

  it('a transition to merged settles the epic of the item', () => {
    const board = boardOf(['merged', 'queued']);
    const next = transition(board, 'APP-2', 'merged', 'studio', NOW);
    expect(next.epics?.[0]?.status).toBe('accepting');
    // pure: the input stays as it was
    expect(board.epics?.[0]?.status).toBe('open');
  });
});
