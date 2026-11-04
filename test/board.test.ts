import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPONENT_ID_RE as BOARD_COMPONENT_ID_RE,
  BOARD_ROLES,
  BoardError,
  componentsOf,
  isLegalMove,
  loadBoard,
  saveBoard,
  TransitionError,
  transition,
  type WorkItem,
} from '../src/board.js';
import {
  COMPONENT_ID_RE,
  ROLE_TEMPLATES,
  type StudioConfig,
  studioConfigSchema,
} from '../src/config.js';

const fixture = join(import.meta.dirname, 'fixtures', 'basic');
const dirs: string[] = [];

function project(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-board-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.studio'));
  writeFileSync(join(dir, '.studio', 'board.yaml'), yaml);
  return dir;
}

const item = (id: string, extra = '') => `  - id: ${id}
    title: Item ${id}
    type: fix
    role: builder
    repo: org/app
    size: S
    priority: 1
    status: ready
${extra}`;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('board', () => {
  it('round-trips fixture unchanged', () => {
    const board = loadBoard(fixture);
    expect(board.items.length).toBeGreaterThanOrEqual(3);
    const original = readFileSync(join(fixture, '.studio', 'board.yaml'), 'utf8');
    const dir = project(original);
    saveBoard(dir, board);
    expect(readFileSync(join(dir, '.studio', 'board.yaml'), 'utf8')).toBe(original);
    // also without a pre-existing file content to borrow comments from
    const fresh = project('items: []\n');
    saveBoard(fresh, board);
    expect(readFileSync(join(fresh, '.studio', 'board.yaml'), 'utf8')).toBe(original);
  });

  it('saveBoard is atomic: a failing write leaves no temp file', () => {
    const dir = project('items: []\n');
    const file = join(dir, '.studio', 'board.yaml');
    rmSync(file);
    mkdirSync(file); // renaming a file onto a directory fails
    expect(() => saveBoard(dir, loadBoard(join(fixture)))).toThrow();
    expect(readdirSync(join(dir, '.studio')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('applies defaults on load', () => {
    const board = loadBoard(project(`items:\n${item('APP-1')}`));
    const [first] = board.items;
    expect(first?.dependsOn).toEqual([]);
    expect(first?.touches).toEqual([]);
    expect(first?.paths).toEqual([]);
    expect(first?.dod).toEqual([]);
    expect(first?.history).toEqual([]);
    expect(first?.pr).toBeUndefined();
  });

  it('omits unset optional fields on save', () => {
    const dir = project(`items:\n${item('APP-1')}`);
    saveBoard(dir, loadBoard(dir));
    const text = readFileSync(join(dir, '.studio', 'board.yaml'), 'utf8');
    expect(text).not.toMatch(/null|pr:|plan:/);
  });

  it('keeps the role list in sync with config', () => {
    expect([...BOARD_ROLES]).toEqual([...ROLE_TEMPLATES]);
  });

  it('transition appends history', () => {
    const board = loadBoard(fixture);
    const id = board.items.find((i) => i.status === 'ready')?.id as string;
    const next = transition(board, id, 'assigned', 'lead', new Date('2026-10-31T10:00:00Z'));
    const moved = next.items.find((i) => i.id === id);
    expect(moved?.status).toBe('assigned');
    expect(moved?.history.at(-1)).toEqual({
      at: '2026-10-31T10:00:00.000Z',
      from: 'ready',
      to: 'assigned',
      by: 'lead',
    });
  });

  it('transition is pure', () => {
    const board = loadBoard(fixture);
    const snapshot = structuredClone(board);
    const id = board.items.find((i) => i.status === 'ready')?.id as string;
    const next = transition(board, id, 'blocked', 'lead', new Date());
    expect(board).toEqual(snapshot);
    expect(next).not.toBe(board);
  });

  it('rejects ready→merged', () => {
    const board = loadBoard(fixture);
    const id = board.items.find((i) => i.status === 'ready')?.id as string;
    expect(() => transition(board, id, 'merged', 'lead', new Date())).toThrow(TransitionError);
  });

  it('allows the documented legal moves and rejects leaving terminal states', () => {
    let board = loadBoard(project(`items:\n${item('APP-1')}`));
    const t = (to: Parameters<typeof transition>[2]) => {
      board = transition(board, 'APP-1', to, 'x', new Date());
    };
    for (const to of [
      'assigned',
      'in_progress',
      'in_review',
      'in_progress',
      'in_review',
      'queued',
      'in_review',
      'queued',
      'merged',
    ] as const)
      t(to);
    expect(() => transition(board, 'APP-1', 'dropped', 'x', new Date())).toThrow(TransitionError);
    expect(() => transition(board, 'APP-1', 'blocked', 'x', new Date())).toThrow(TransitionError);
    const b2 = loadBoard(project(`items:\n${item('APP-2')}`));
    const blocked = transition(b2, 'APP-2', 'blocked', 'x', new Date());
    const back = transition(blocked, 'APP-2', 'ready', 'x', new Date());
    expect(transition(back, 'APP-2', 'dropped', 'x', new Date()).items[0]?.status).toBe('dropped');
    expect(() => transition(b2, 'NOPE-1', 'assigned', 'x', new Date())).toThrow(TransitionError);
  });

  it('rejects duplicate ids on load', () => {
    const dir = project(`items:\n${item('APP-1')}${item('APP-1')}`);
    expect(() => loadBoard(dir)).toThrow(/duplicate.*APP-1/);
  });

  it('rejects dependsOn to unknown id', () => {
    const dir = project(`items:\n${item('APP-1', '    depends_on: [APP-9]\n')}`);
    expect(() => loadBoard(dir)).toThrow(/APP-9/);
    expect(() => loadBoard(dir)).toThrow(BoardError);
  });

  it('rejects conflictsWith to unknown id', () => {
    const dir = project(`items:\n${item('APP-1', '    conflicts_with: [APP-7]\n')}`);
    expect(() => loadBoard(dir)).toThrow(/APP-7/);
  });

  it('reports path and key on schema errors', () => {
    const dir = project(`items:\n${item('bad')}`);
    try {
      loadBoard(dir);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BoardError);
      expect((e as BoardError).path).toContain('board.yaml');
      expect((e as Error).message).toContain('items.0.id');
    }
  });

  it('preserves comments on save', () => {
    const dir = project(`# board header\nitems:\n  # first\n${item('APP-1')}`);
    const board = loadBoard(dir);
    saveBoard(dir, transition(board, 'APP-1', 'assigned', 'x', new Date()));
    const text = readFileSync(join(dir, '.studio', 'board.yaml'), 'utf8');
    expect(text).toContain('# board header');
    expect(text).toContain('# first');
    expect(text).toContain('status: assigned');
  });

  it('allows in_review -> merged only for an item without a pr', () => {
    const noPr = loadBoard(
      project(`items:\n${item('APP-1').replace('status: ready', 'status: in_review')}`),
    );
    expect(transition(noPr, 'APP-1', 'merged', 'x', new Date()).items[0]?.status).toBe('merged');
    const withPr = loadBoard(
      project(
        `items:\n${item('APP-1', '    pr: 5\n').replace('status: ready', 'status: in_review')}`,
      ),
    );
    expect(() => transition(withPr, 'APP-1', 'merged', 'x', new Date())).toThrow(TransitionError);
  });
});

describe('isLegalMove', () => {
  it('needs hasPr explicitly: no fail-open default', () => {
    // A default parameter would not count in Function.length.
    expect(isLegalMove.length).toBe(3);
    expect(isLegalMove('in_review', 'merged', true)).toBe(false);
    expect(isLegalMove('in_review', 'merged', false)).toBe(true);
  });
});

describe('capability fields on an item', () => {
  const text = (extra: string) =>
    `items:\n  - { id: APP-1, title: t, type: fix, role: builder, repo: org/app, size: S, priority: 1, status: ready${extra} }\n`;
  const write = (extra: string) => {
    const d = mkdtempSync(join(tmpdir(), 'studio-board-cap-'));
    mkdirSync(join(d, '.studio'));
    writeFileSync(join(d, '.studio', 'board.yaml'), text(extra));
    return d;
  };
  it('survives a save', () => {
    const d = write(', risk: [auth], triggers: [epic-end], model: opus');
    saveBoard(d, loadBoard(d));
    const it0 = loadBoard(d).items[0];
    expect(it0?.risk).toEqual(['auth']);
    expect(it0?.triggers).toEqual(['epic-end']);
    expect(it0?.model).toBe('opus');
    rmSync(d, { recursive: true, force: true });
  });
  it.each([', model: --evil', ', risk: [nope]', ', triggers: [rework]'])('refuses %s', (extra) => {
    const d = write(extra);
    expect(() => loadBoard(d)).toThrow();
    rmSync(d, { recursive: true, force: true });
  });
});

describe('not_run_here on the board', () => {
  it('refuses a format character (bidi, zero-width) in a command', () => {
    const p = project(
      `items:\n${item('APP-1', '    not_run_here:\n      - { command: "make\\u202e e2e", missing: docker, reason: x }\n')}`,
    );
    expect(() => loadBoard(p)).toThrow(BoardError);
  });
  it('takes a plain entry', () => {
    const p = project(
      `items:\n${item('APP-1', '    not_run_here:\n      - { command: make e2e, missing: docker, reason: x }\n')}`,
    );
    expect(loadBoard(p).items[0]?.notRunHere).toHaveLength(1);
  });
});

const baseConfig = {
  studio: 1,
  primaryRepo: 'org/app',
  repos: ['org/app', 'org/web'],
  ci: {
    provider: 'github',
    runners: 'github-hosted',
    runnerLabels: [],
    capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 30 },
  },
  merge: { strategy: 'studio-queue', contractPaths: [] },
  roles: { builder: { model: 'm', wip: 2 } },
};
const withComponents: StudioConfig = studioConfigSchema.parse({
  ...baseConfig,
  components: [
    { id: 'api', name: 'API server', repo: 'org/app', paths: ['server/**', 'shared/**'] },
    { id: 'desktop', name: 'Desktop app', repo: 'org/app', paths: ['desktop/**', 'shared/**'] },
    { id: 'web', name: 'Web app', repo: 'org/web', paths: ['**'] },
  ],
});
const noComponents: StudioConfig = studioConfigSchema.parse(baseConfig);

const work = (extra: Partial<WorkItem> = {}): WorkItem => ({
  id: 'APP-1',
  title: 't',
  type: 'fix',
  role: 'builder',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'ready',
  paths: [],
  touches: [],
  dependsOn: [],
  dod: [],
  history: [],
  ...extra,
});

describe('componentsOf', () => {
  it('keeps the id rule in sync with config', () => {
    expect(BOARD_COMPONENT_ID_RE.source).toBe(COMPONENT_ID_RE.source);
  });

  it('infers a single component from a path in its repo', () => {
    expect(componentsOf(work({ paths: ['server/main.rs'] }), withComponents)).toEqual(['api']);
  });

  it('infers from touches as well, and from globs in them', () => {
    expect(componentsOf(work({ touches: ['desktop/src/**'] }), withComponents)).toEqual([
      'desktop',
    ]);
  });

  it('infers several components for cross-cutting work, in config order', () => {
    expect(
      componentsOf(work({ paths: ['desktop/a.ts'], touches: ['server/b.rs'] }), withComponents),
    ).toEqual(['api', 'desktop']);
    expect(componentsOf(work({ paths: ['shared/types.ts'] }), withComponents)).toEqual([
      'api',
      'desktop',
    ]);
  });

  it('returns nothing when no path matches', () => {
    expect(componentsOf(work({ paths: ['docs/readme.md'] }), withComponents)).toEqual([]);
    expect(componentsOf(work(), withComponents)).toEqual([]);
  });

  it('matches only components of the item repo', () => {
    expect(componentsOf(work({ repo: 'org/web', paths: ['server/x'] }), withComponents)).toEqual([
      'web',
    ]);
    expect(componentsOf(work({ repo: 'org/other', paths: ['server/x'] }), withComponents)).toEqual(
      [],
    );
  });

  it('takes the components an item names over inference', () => {
    expect(componentsOf(work({ component: 'web', paths: ['server/x'] }), withComponents)).toEqual([
      'web',
    ]);
    expect(
      componentsOf(work({ components: ['desktop', 'api', 'desktop'] }), withComponents),
    ).toEqual(['desktop', 'api']);
  });

  it('is empty without components in the config', () => {
    expect(componentsOf(work({ paths: ['server/x'], component: 'api' }), noComponents)).toEqual([]);
  });
});

describe('components on the board', () => {
  it('loads and saves component and components', () => {
    const p = project(
      `items:\n${item('APP-1', '    component: api\n')}\n${item('APP-2', '    components: [api, web]\n')}`,
    );
    const board = loadBoard(p, withComponents);
    expect(board.items[0]?.component).toBe('api');
    expect(board.items[1]?.components).toEqual(['api', 'web']);
    saveBoard(p, board);
    expect(readFileSync(join(p, '.studio', 'board.yaml'), 'utf8')).toMatch(
      /component: api[\s\S]*components:\n\s+- api\n\s+- web/,
    );
  });

  it('refuses an unknown component id against the config', () => {
    const p = project(`items:\n${item('APP-1', '    component: mobile\n')}`);
    expect(() => loadBoard(p, withComponents)).toThrow(/APP-1: unknown component mobile/);
    expect(() => loadBoard(p, noComponents)).toThrow(/APP-1: unknown component mobile/);
    // Without a config the board alone cannot tell.
    expect(loadBoard(p).items[0]?.component).toBe('mobile');
  });

  it('refuses an unknown id in components', () => {
    const p = project(`items:\n${item('APP-1', '    components: [api, mobile]\n')}`);
    expect(() => loadBoard(p, withComponents)).toThrow(/APP-1: unknown component mobile/);
  });

  it('refuses component and components together, and a malformed id', () => {
    const both = project(`items:\n${item('APP-1', '    component: api\n    components: [web]\n')}`);
    expect(() => loadBoard(both)).toThrow(/APP-1: set component or components, not both/);
    const bad = project(`items:\n${item('APP-1', '    component: API\n')}`);
    expect(() => loadBoard(bad)).toThrow(BoardError);
    const empty = project(`items:\n${item('APP-1', '    components: []\n')}`);
    expect(() => loadBoard(empty)).toThrow(BoardError);
  });
});
