// Run with `pnpm test:mod` (claude plugin test on a copy holding only the mod). Not run by vitest.
import type { On } from 'claude-code';
import { expect, mock, type TestBody, test } from 'claude-code/testing';

const PROJECT = '/work/app';
// sha256('/work/app') from outside the mod, so a drift from src/paths.ts shows up as a missing file.
const ROOT = '/home/u/.local/state/studio/70467eff2e0a2364-app';
const STATE = `${ROOT}/state.json`;
const PAUSE = `${ROOT}/pause.json`;
const YAML = `${PROJECT}/.studio/studio.yaml`;
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const;

const PANE = {
  plugin: 'studio',
  component: 'Pane',
  requestId: 'studio-board',
  props: {
    title: 'Studio board',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

const OK_STATE = {
  crew: [{ role: 'dev', item: 'APP-1', state: 'working', title: 'first item' }],
  queue: { pending: [] },
  ci: { busy: 1, total: 8, mergeMaxBusy: 5, ok: true },
  counts: { ready: 0, queued: 2 },
  forOwner: [],
};
const OK_LINE = '● 1 working · 0 waiting · 2 queued · CI 1/8 · for you: 0';

type WorldOptions = {
  env?: Record<string, string>;
  files?: Record<string, string>;
  /** Paths whose read rejects, as a file over the read limit does. */
  unreadable?: string[];
  store?: Record<string, unknown>;
  storeFails?: boolean;
  /** Names a listing shows without a file behind them, as a dangling link. */
  extraEntries?: Record<string, string[]>;
  openFails?: boolean;
  cwd?: string;
  /** What the session draws on; default one terminal. */
  surfaces?: ('terminal' | 'app')[];
  /** Claude Code settings as `$.settings.read` answers them; default none. */
  settings?: Record<string, unknown>;
};

/** Stands for the engine: a file system in memory, and a record of everything the mod asked for. */
function world(on: On, options: WorldOptions = {}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const seen = {
    commands: [] as string[],
    hints: [] as (string | undefined)[],
    opened: [] as string[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    forbidden: [] as string[],
    fsCalls: [] as string[],
  };
  const clock = mock.clock(on, { now: Date.parse('2026-11-01T12:00:00Z') });
  mock.env(on, options.env ?? { HOME: '/home/u' });
  if (options.storeFails) {
    on('store.get', () => {
      throw new Error('store down');
    });
    on('store.set', () => {
      throw new Error('store down');
    });
  } else {
    mock.store(on, options.store);
  }
  on('settings.read', () => ({ value: options.settings ?? {} }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }));
  on('session.cwd', () => ({ value: options.cwd ?? PROJECT }));
  on('command.register', (_, e) => {
    seen.commands.push(e.name);
    seen.hints.push(e.argumentHint);
    return { value: { command: e.name } };
  });
  on('ui.open', (_, e) => {
    if (options.openFails) throw new Error('refused');
    seen.opened.push(`${e.id}:${e.title}`);
    return { value: { isPlaced: true } };
  });
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on('fs.exists', (_, e) => {
    seen.fsCalls.push(e.path);
    return { value: files.has(e.path) };
  });
  on('fs.list', (_, e) => {
    const dir = `${e.path ?? ''}/`;
    const names = [...files.keys()]
      .filter((f) => f.startsWith(dir))
      .map((f) => f.slice(dir.length).split('/')[0] as string);
    const extra = options.extraEntries?.[e.path ?? ''] ?? [];
    if (names.length + extra.length === 0) throw new Error('ENOENT');
    return {
      value: [...new Set([...names, ...extra])].map((name) => ({
        name,
        kind: 'file' as const,
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    };
  });
  on('fs.stat', (_, e) => ({
    value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path },
  }));
  on('fs.read', (_, e) => {
    if (options.unreadable?.includes(e.path)) throw new Error('too large');
    const text = files.get(e.path);
    if (text === undefined) throw new Error('ENOENT');
    return { value: text };
  });
  on('fs.write', (_, e) => {
    seen.forbidden.push(`fs.write ${e.path}`);
    return { value: undefined };
  });
  on('process.run', (_, e) => {
    seen.forbidden.push(`process.run ${e.argv.join(' ')}`);
    return { deny: 'the mod runs no process' };
  });
  return { clock, files, seen };
}

const start = { cwd: PROJECT, surface: 'terminal', isInteractive: true } as const;
const withState = (state: unknown = OK_STATE) => ({
  [YAML]: 'project: app\n',
  [STATE]: JSON.stringify(state),
});

// ---------- when the mod stays out of the way ----------

// mock.clock owns clock.every, so a timer shows through what it does: it would read files.
function expectQuiet(seen: ReturnType<typeof world>['seen'], reads: number) {
  expect(seen.commands).toEqual([]);
  expect(seen.opened).toEqual([]);
  expect(seen.statuses).toEqual([]);
  expect(seen.toasts).toEqual([]);
  expect(seen.fsCalls.length).toBe(reads);
}

test('a non-interactive session registers nothing and starts no timer', async ($, on) => {
  const { clock, seen } = world(on, { files: withState() });
  await $.session.start({ ...start, surface: null, isInteractive: false });
  await clock.advance(60_000);
  expectQuiet(seen, 0);
});

test('a crew session registers nothing and starts no timer', async ($, on) => {
  const { clock, seen } = world(on, {
    env: { HOME: '/home/u', STUDIO_ROLE: 'crew' },
    files: withState(),
  });
  await $.session.start(start);
  await clock.advance(60_000);
  expectQuiet(seen, 0);
});

test('a command run by a crew session arms no timer and reads no file', async ($, on) => {
  const { clock, seen } = world(on, {
    env: { HOME: '/home/u', STUDIO_ROLE: 'crew' },
    files: withState(),
  });
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'status' });
  expect(text).toBe('Not in a Studio project.');
  await clock.advance(60_000);
  expectQuiet(seen, 0);
});

test('a command run with no surface arms no timer and reads no file', async ($, on) => {
  const { clock, seen } = world(on, { files: withState(), surfaces: [] });
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'status' });
  expect(text).toBe('Not in a Studio project.');
  await clock.advance(60_000);
  expectQuiet(seen, 0);
});

test('a session outside a Studio project registers nothing and starts no timer', async ($, on) => {
  const { clock, seen } = world(on, { files: { [STATE]: JSON.stringify(OK_STATE) } });
  await $.session.start(start);
  expect(seen.fsCalls).toEqual([
    '/work/app/.studio/studio.yaml',
    '/work/.studio/studio.yaml',
    '/.studio/studio.yaml',
  ]);
  await clock.advance(60_000);
  expectQuiet(seen, 3);
});

// ---------- starting ----------

test('a Studio session registers the command, a 10 s timer and opens the pane', async ($, on) => {
  const { clock, files, seen } = world(on, { files: { [YAML]: 'project: app\n' } });
  await $.session.start(start);
  expect(seen.commands).toEqual(['studio']);
  expect(seen.hints).toEqual(['list | pipeline | more | status | pause | resume | lang']);
  expect(seen.opened).toEqual(['studio-board:Studio board']);
  files.set(STATE, JSON.stringify(OK_STATE));
  await clock.advance(9_999);
  expect(seen.statuses).toEqual([]);
  await clock.advance(1);
  expect(seen.statuses).toEqual([OK_LINE]);
});

test('the project is found from a folder below it', async ($, on) => {
  const { seen } = world(on, { files: withState() });
  await $.session.start({ ...start, cwd: `${PROJECT}/src/deep/` });
  expect(seen.commands).toEqual(['studio']);
  expect(seen.statuses).toEqual([OK_LINE]);
});

test('the command is registered when no state exists yet', async ($, on) => {
  const { seen } = world(on, { files: { [YAML]: 'project: app\n' } });
  await $.session.start(start);
  expect(seen.commands).toEqual(['studio']);
  expect(seen.statuses).toEqual([]);
});

// ---------- where the state is read ----------

test('an absolute XDG_STATE_HOME decides the state root', async ($, on) => {
  const xdg = '/xdg/state/studio/70467eff2e0a2364-app/state.json';
  const { seen } = world(on, {
    env: { HOME: '/home/u', XDG_STATE_HOME: '/xdg/state/' },
    files: { [YAML]: 'project: app\n', [xdg]: JSON.stringify(OK_STATE) },
  });
  await $.session.start(start);
  expect(seen.statuses).toEqual([OK_LINE]);
});

test('a relative XDG_STATE_HOME is ignored', async ($, on) => {
  const { seen } = world(on, {
    env: { HOME: '/home/u', XDG_STATE_HOME: 'relative/state' },
    files: withState(),
  });
  await $.session.start(start);
  expect(seen.statuses).toEqual([OK_LINE]);
});

test('no HOME and no XDG_STATE_HOME draws the calm message', async ($, on) => {
  const { seen } = world(on, { env: {}, files: withState() });
  await $.session.start(start);
  expect(seen.commands).toEqual(['studio']);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/cannot be read/);
  await ui.unmount();
});

// ---------- drawing ----------

test('missing state draws the calm message, with no status entry', async ($, on) => {
  const { seen } = world(on, { files: { [YAML]: 'project: app\n' } });
  await $.session.start(start);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^No board yet/);
    await ui.unmount();
  }
  expect(seen.statuses).toEqual([]);
});

test('a state file that cannot be read draws the calm message', async ($, on) => {
  const { seen } = world(on, { files: withState(), unreadable: [STATE] });
  await $.session.start(start);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/cannot be read/);
  await ui.unmount();
  expect(seen.statuses).toEqual([]);
});

test('a half-written or wrong-shaped state file draws the calm message', async ($, on) => {
  const { files, clock } = world(on, {
    files: { [YAML]: 'project: app\n', [STATE]: '{"crew": [' },
  });
  await $.session.start(start);
  for (const bad of ['{"crew": [', '[1,2]', '"text"', 'null', '']) {
    files.set(STATE, bad);
    await clock.advance(10_000);
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/cannot be read/);
    await ui.unmount();
  }
});

test('wrong field types lose the row, not the board', async ($, on) => {
  world(on, {
    files: withState({
      crew: [{ role: 7 }, 'junk', { role: 'dev', item: 'APP-2', state: 'working' }],
      ci: 'busy',
      counts: [],
      forOwner: 3,
    }),
  });
  await $.session.start(start);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text', text: /APP-2/ }))?.text).toMatch(/working/);
  expect((await ui.findAll({ type: 'Text', text: /junk/ })).length).toBe(0);
  await ui.unmount();
});

test('ok state draws the crew row and the status line, on every surface', async ($, on) => {
  const { seen } = world(on, { files: withState() });
  await $.session.start(start);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect((await ui.find({ type: 'Text', text: /APP-1/ }))?.text).toMatch(/first item/);
    await ui.unmount();
  }
  expect(seen.statuses).toEqual([OK_LINE]);
});

test('tones map to the theme and to dim', async ($, on) => {
  world(on, {
    files: withState({
      ...OK_STATE,
      crew: [
        { role: 'dev', item: 'APP-1', state: 'working' },
        { role: 'dev', item: 'APP-2', state: 'crashed' },
        { role: 'dev', item: 'APP-3', state: 'done' },
      ],
    }),
  });
  await $.session.start(start);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text', text: /APP-1/ }))?.props).toMatchObject({
    color: 'success',
  });
  expect((await ui.find({ type: 'Text', text: /APP-2/ }))?.props).toMatchObject({ color: 'error' });
  expect((await ui.find({ type: 'Text', text: /APP-3/ }))?.props).toMatchObject({ dimColor: true });
  await ui.unmount();
});

test('crew rows stand under a bold heading per component, cross-cutting work under its own', async ($, on) => {
  world(on, {
    files: withState({
      ...OK_STATE,
      components: [
        { id: 'api', name: 'API server' },
        { id: 'desktop', name: 'Desktop app' },
      ],
      crew: [
        { role: 'dev', item: 'APP-1', state: 'working', components: ['desktop'] },
        { role: 'dev', item: 'APP-2', state: 'working', components: ['api', 'desktop'] },
        { role: 'dev', item: 'APP-3', state: 'working', components: ['api'] },
      ],
    }),
  });
  await $.session.start(start);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text ?? '');
  const at = (pattern: RegExp) => texts.findIndex((t) => pattern.test(t));
  expect(at(/^API server$/)).toBeLessThan(at(/APP-3/));
  expect(at(/APP-3/)).toBeLessThan(at(/^Desktop app$/));
  expect(at(/^Desktop app$/)).toBeLessThan(at(/APP-1/));
  expect(at(/APP-1/)).toBeLessThan(at(/^cross-cutting$/));
  expect(at(/^cross-cutting$/)).toBeLessThan(at(/APP-2/));
  expect((await ui.find({ type: 'Text', text: /^API server$/ }))?.props).toMatchObject({
    weight: 'bold',
  });
  await ui.unmount();
});

test('a narrow pane draws within its width', async ($, on) => {
  world(on, { files: withState() });
  await $.session.start(start);
  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, bodyColumns: 30 },
  });
  expect(await ui.find({ type: 'Text', text: /APP-1/ })).toBeDefined();
  for (const row of await ui.findAll({ type: 'Text' })) {
    expect([...(row.text ?? '')].length <= 30).toBe(true);
  }
  await ui.unmount();
});

test('a title holding terminal escapes reaches neither pane nor toast', async ($, on) => {
  const { seen } = world(on, {
    files: withState({
      ...OK_STATE,
      crew: [{ role: 'dev', item: 'APP-1', state: 'working', title: 'a\u001b[31mb' }],
      forOwner: [{ id: 'x', title: 'c\u001b]0;d\u0007e' }],
    }),
  });
  await $.session.start(start);
  expect(seen.toasts).toEqual(['For you: c]0;de']);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text', text: /APP-1/ }))?.text).toMatch(/a\[31mb/);
  await ui.unmount();
});

test('a pane drawn with no session start draws the calm message', async ($, on) => {
  world(on);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^No board yet/);
  await ui.unmount();
});

// ---------- ticks and toasts ----------

test('a tick picks up a change', async ($, on) => {
  const { clock, files, seen } = world(on, { files: { [YAML]: 'project: app\n' } });
  await $.session.start(start);
  expect(seen.statuses).toEqual([]);
  files.set(STATE, JSON.stringify(OK_STATE));
  await clock.advance(10_000);
  expect(seen.statuses).toEqual([OK_LINE]);
  files.delete(STATE);
  await clock.advance(10_000);
  expect(seen.statuses).toEqual([OK_LINE, undefined]);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^No board yet/);
  await ui.unmount();
});

test('a new forOwner line toasts once across two ticks', async ($, on) => {
  const { clock, files, seen } = world(on, { files: withState() });
  await $.session.start(start);
  expect(seen.toasts).toEqual([]);
  files.set(
    STATE,
    JSON.stringify({ ...OK_STATE, forOwner: [{ id: 'decide', title: 'Decide APP-1' }] }),
  );
  await clock.advance(10_000);
  expect(seen.toasts).toEqual(['For you: Decide APP-1']);
  await clock.advance(10_000);
  expect(seen.toasts).toEqual(['For you: Decide APP-1']);
});

test('what was toasted in an earlier session does not toast again', async ($, on) => {
  const { seen } = world(on, {
    files: withState({ ...OK_STATE, forOwner: [{ id: 'decide', title: 'Decide APP-1' }] }),
    store: { 'seen:70467eff2e0a2364-app': ['owner:decide:Decide APP-1'] },
  });
  await $.session.start(start);
  expect(seen.toasts).toEqual([]);
});

test('a malformed seen list counts as empty', async ($, on) => {
  const { seen } = world(on, {
    files: withState({ ...OK_STATE, forOwner: [{ id: 'decide', title: 'Decide APP-1' }] }),
    store: { 'seen:70467eff2e0a2364-app': 'junk' },
  });
  await $.session.start(start);
  expect(seen.toasts).toEqual(['For you: Decide APP-1']);
});

test('a store failure does not stop drawing and does not repeat toasts', async ($, on) => {
  const { clock, seen } = world(on, {
    files: withState({ ...OK_STATE, forOwner: [{ id: 'decide', title: 'Decide APP-1' }] }),
    storeFails: true,
  });
  await $.session.start(start);
  await clock.advance(10_000);
  expect(seen.toasts).toEqual([]);
  expect(seen.statuses.length > 0).toBe(true);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text', text: /APP-1/ }))?.text).toMatch(/first item/);
  await ui.unmount();
});

test('an existing pause.json shows as paused', async ($, on) => {
  const { seen } = world(on, { files: { ...withState(), [PAUSE]: '{}' } });
  await $.session.start(start);
  expect(seen.statuses).toEqual([`${OK_LINE} · paused`]);
});

// ---------- the command ----------

const run = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const;

test('/studio with no arguments opens the pane', async ($, on) => {
  const { seen } = world(on, { files: withState() });
  await $.session.start(start);
  seen.opened.length = 0;
  const { text } = await $.command.run({ ...run, command: 'studio', args: '' });
  expect(seen.opened).toEqual(['studio-board:Studio board']);
  expect(text).toBe('Studio board opened.');
});

test('/studio status answers the status text, read fresh', async ($, on) => {
  const { files } = world(on, { files: { [YAML]: 'project: app\n' } });
  await $.session.start(start);
  const before = await $.command.run({ ...run, command: 'studio', args: 'status' });
  expect(before.text).toMatch(/^No board yet/);
  files.set(STATE, JSON.stringify(OK_STATE));
  const after = await $.command.run({ ...run, command: 'studio', args: ' status ' });
  expect(after.text).toBe(OK_LINE);
});

test('/studio pause names the terminal command and runs nothing', async ($, on) => {
  const { seen, files } = world(on, { files: withState() });
  await $.session.start(start);
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'pause' });
  expect(text).toMatch(
    /^Pausing needs a terminal: run \/\S+\/bin\/studio --project \/work\/app pause$/,
  );
  expect(seen.forbidden).toEqual([]);
  expect(files.has(PAUSE)).toBe(false);
});

test('/studio resume names the terminal command and runs nothing', async ($, on) => {
  const { seen, files } = world(on, { files: { ...withState(), [PAUSE]: '{}' } });
  await $.session.start(start);
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'resume' });
  expect(text).toMatch(
    /^Resuming needs a terminal: run \/\S+\/bin\/studio --project \/work\/app resume$/,
  );
  expect(seen.forbidden).toEqual([]);
  expect(files.has(PAUSE)).toBe(true);
});

test('a project path with shell characters is quoted in the terminal command', async ($, on) => {
  const odd = "/work/my app; it's";
  world(on, { env: { XDG_STATE_HOME: '/xdg' }, files: { [`${odd}/.studio/studio.yaml`]: 'x' } });
  await $.session.start({ ...start, cwd: odd });
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'pause' });
  expect(text).toMatch(
    /^Pausing needs a terminal: run \/\S+\/bin\/studio --project '\/work\/my app; it'\\''s' pause$/,
  );
});

test('anything else answers the usage text', async ($, on) => {
  const { seen } = world(on, { files: withState() });
  await $.session.start(start);
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'stop everything' });
  expect(text).toBe(
    'Usage: /studio [list | pipeline | more | status | pause | resume | lang de|en|auto]',
  );
  expect(seen.forbidden).toEqual([]);
});

test('the mod never writes a file or runs a process', async ($, on) => {
  const { clock, seen } = world(on, {
    files: withState({ ...OK_STATE, forOwner: [{ id: 'decide', title: 'Decide APP-1' }] }),
  });
  await $.session.start(start);
  await clock.advance(30_000);
  for (const args of [
    '',
    'status',
    'pause',
    'resume',
    'junk',
    'list',
    'pipeline',
    'more',
    'lang de',
    'lang auto',
  ]) {
    await $.command.run({ ...run, command: 'studio', args });
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.unmount();
  expect(seen.forbidden).toEqual([]);
});

// ---------- fix round ----------

const ALERT = (n: number) => ({ id: `d${n}`, title: `Decide APP-${n}` });

test('two alerts in one tick raise one toast', async ($, on) => {
  const { clock, files, seen } = world(on, { files: withState() });
  await $.session.start(start);
  files.set(STATE, JSON.stringify({ ...OK_STATE, forOwner: [ALERT(1), ALERT(2)] }));
  await clock.advance(10_000);
  expect(seen.toasts).toEqual(['For you: Decide APP-1 · For you: Decide APP-2']);
});

test('more than five alerts raise one toast that says how many more', async ($, on) => {
  const { clock, files, seen } = world(on, { files: withState() });
  await $.session.start(start);
  const forOwner = [1, 2, 3, 4, 5, 6, 7].map(ALERT);
  files.set(STATE, JSON.stringify({ ...OK_STATE, forOwner }));
  await clock.advance(10_000);
  expect(seen.toasts.length).toBe(1);
  expect(seen.toasts[0]).toMatch(/Decide APP-5 · … 2 more$/);
});

test('a joined toast is capped at 1500 characters', async ($, on) => {
  const { seen } = world(on, {
    files: withState({
      ...OK_STATE,
      forOwner: [1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, title: `${'x'.repeat(600)}${n}` })),
    }),
  });
  await $.session.start(start);
  expect(seen.toasts.length).toBe(1);
  expect([...(seen.toasts[0] as string)].length).toBeLessThanOrEqual(1500);
});

test('a dangling pause.json entry counts as paused', async ($, on) => {
  const { seen } = world(on, { files: withState(), extraEntries: { [ROOT]: ['pause.json'] } });
  await $.session.start(start);
  expect(seen.statuses).toEqual([`${OK_LINE} · paused`]);
});

test('a missing state root is not paused', async ($, on) => {
  const { seen } = world(on, { files: { [YAML]: 'x' } });
  await $.session.start(start);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'Paused.' })).toBeUndefined();
  await ui.unmount();
  expect(seen.statuses).toEqual([]);
});

test('a pause with no state file shows Paused. in the pane and in status', async ($, on) => {
  world(on, { files: { [YAML]: 'x', [PAUSE]: '{}' } });
  await $.session.start(start);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text', text: 'Paused.' }))?.text).toBe('Paused.');
  await ui.unmount();
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'status' });
  expect(text).toMatch(/ Paused\.$/);
});

test('a command run after a reload, with no session start, answers and starts the refresh', async ($, on) => {
  const { clock, files, seen } = world(on, { files: withState() });
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'status' });
  expect(text).toBe(OK_LINE);
  files.set(STATE, JSON.stringify({ ...OK_STATE, counts: { ready: 0, queued: 3 } }));
  await clock.advance(10_000);
  expect(seen.statuses.at(-1)).toMatch(/3 queued/);
});

test('a command run after a reload outside a Studio project answers calmly', async ($, on) => {
  const { clock, seen } = world(on, { cwd: '/elsewhere' });
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'status' });
  expect(text).toBe('Not in a Studio project.');
  await clock.advance(30_000);
  expect(seen.statuses).toEqual([]);
});

test('a refused pane open answers a fixed line', async ($, on) => {
  world(on, { files: withState(), openFails: true });
  await $.session.start(start);
  const { text } = await $.command.run({ ...run, command: 'studio', args: '' });
  expect(text).toBe('The board could not be opened here.');
});

test('a folder name with a backslash is one name, as in src/paths.ts', async ($, on) => {
  // POSIX: `a\b` is a single folder. Its state suffix is a_b, and its parent is not the project.
  const odd = '/work/a\\b';
  const { seen } = world(on, {
    files: { '/work/a/.studio/studio.yaml': 'x', [`${odd}/.studio/studio.yaml`]: 'x' },
  });
  await $.session.start({ ...start, cwd: odd });
  expect(seen.commands).toEqual(['studio']);
  expect(seen.fsCalls.some((p) => p.includes('-a_b/'))).toBe(true);
});

test('a backslash folder with no project of its own does not find its look-alike parent', async ($, on) => {
  const { seen } = world(on, { files: { '/work/a/.studio/studio.yaml': 'x' } });
  await $.session.start({ ...start, cwd: '/work/a\\b' });
  expect(seen.commands).toEqual([]);
});

// ---------- the work list, the pipeline and the language ----------

/** A state as `studio state` writes it since the work list: items, a decision, an epic. */
const LIST_STATE = {
  ...OK_STATE,
  project: 'app',
  crew: [{ role: 'builder', item: 'APP-2', state: 'working', title: 'Second item' }],
  items: [
    {
      id: 'APP-1',
      title: 'First item',
      stage: 'blocked',
      epic: 'E-1',
      wait: { code: 'blocked', text: 'fix limit reached' },
    },
    { id: 'APP-2', title: 'Second item', stage: 'building', epic: 'E-1' },
    { id: 'APP-3', title: 'Third item', stage: 'ready' },
  ],
  needsLead: [
    { item: 'APP-1', code: 'fix_limit', reason: 'fix limit reached', next: { say: 'show APP-1' } },
  ],
  epics: [{ id: 'E-1', title: 'First epic', status: 'open', merged: 1, total: 3 }],
  wip: { building: 2, review: 1 },
  updatedAt: '2026-11-01T11:59:00Z',
};

async function paneTexts($: Parameters<TestBody>[0], columns = 120) {
  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, bodyColumns: columns },
  });
  // The decision heading is padded to the pane's width, as a highlighted bar.
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => (t.text ?? '').trimEnd());
  await ui.unmount();
  return texts;
}

test('the work list is the default view', async ($, on) => {
  world(on, { files: withState(LIST_STATE) });
  await $.session.start(start);
  const texts = await paneTexts($);
  expect(texts[0]).toMatch(/^Studio · app +updated 1 min ago$/);
  expect(texts).toContain('Decision needed');
  expect(texts).toContain('! APP-1 fix limit reached – decide');
  expect(texts).toContain('  → say "show APP-1"');
  expect(texts.some((t) => /^ {2}● APP-2 Second item +building/.test(t))).toBe(true);
  expect(texts).toContain('Without epic');
});

test('the decision heading is drawn highlighted, and running rows in their own colour', async ($, on) => {
  world(on, { files: withState(LIST_STATE) });
  await $.session.start(start);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Text', text: /^Decision needed/ }))?.props).toMatchObject({
    inverse: true,
    weight: 'bold',
  });
  expect((await ui.find({ type: 'Text', text: /● APP-2/ }))?.props).toMatchObject({
    color: 'suggestion',
  });
  await ui.unmount();
});

test('/studio pipeline draws the columns, and the work list when the pane is narrow', async ($, on) => {
  world(on, { files: withState(LIST_STATE) });
  await $.session.start(start);
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'pipeline' });
  expect(text).toBe('Studio board: pipeline (the work list when the pane is narrow).');
  expect((await paneTexts($)).some((t) => /^READY 1 +BUILDING 1\/2 +REVIEW 0\/1/.test(t))).toBe(
    true,
  );
  const narrow = await paneTexts($, 40);
  expect(narrow.some((t) => t.startsWith('READY'))).toBe(false);
  expect(narrow).toContain('Decision needed');
});

test('/studio more draws the detailed view and /studio list the work list again', async ($, on) => {
  world(on, { files: withState(LIST_STATE) });
  await $.session.start(start);
  const more = await $.command.run({ ...run, command: 'studio', args: 'more' });
  expect(more.text).toBe('Studio board: details. Back with /studio list.');
  const detailed = await paneTexts($);
  expect(detailed).toContain('Merge queue');
  expect(detailed).not.toContain('Decision needed');
  const list = await $.command.run({ ...run, command: 'studio', args: ' list ' });
  expect(list.text).toBe('Studio board: work list.');
  expect(await paneTexts($)).toContain('Decision needed');
});

test('a view chosen in an earlier session is drawn from the store', async ($, on) => {
  world(on, { files: withState(LIST_STATE), store: { view: 'more' } });
  await $.session.start(start);
  expect(await paneTexts($)).toContain('Merge queue');
});

test('a stored view that is no view is the work list', async ($, on) => {
  world(on, { files: withState(LIST_STATE), store: { view: 'kanban' } });
  await $.session.start(start);
  expect(await paneTexts($)).toContain('Decision needed');
});

test('a state written before the work list draws the detailed view', async ($, on) => {
  world(on, { files: withState() });
  await $.session.start(start);
  const texts = await paneTexts($);
  expect(texts).toContain('Crew');
  expect(texts.some((t) => t.includes('APP-1'))).toBe(true);
});

test('German from the Claude Code language setting', async ($, on) => {
  const { seen } = world(on, { files: withState(LIST_STATE), settings: { language: 'german' } });
  await $.session.start(start);
  const texts = await paneTexts($);
  expect(texts).toContain('Entscheidung nötig');
  expect(texts).toContain('Ohne Vorhaben');
  expect(texts).toContain('  → sagen: „show APP-1“');
  expect(seen.statuses.at(-1)).toMatch(/^● 1 aktiv · 0 warten/);
});

test('German from the locale when the setting says nothing', async ($, on) => {
  world(on, { files: withState(LIST_STATE), env: { HOME: '/home/u', LANG: 'de_DE.UTF-8' } });
  await $.session.start(start);
  expect(await paneTexts($)).toContain('Entscheidung nötig');
});

test('the setting outranks the locale, LC_ALL outranks LANG', async ($, on) => {
  world(on, {
    files: withState(LIST_STATE),
    settings: { language: 'english' },
    env: { HOME: '/home/u', LANG: 'de_DE.UTF-8' },
  });
  await $.session.start(start);
  expect(await paneTexts($)).toContain('Decision needed');
});

test('LC_ALL outranks LANG', async ($, on) => {
  world(on, {
    files: withState(LIST_STATE),
    env: { HOME: '/home/u', LC_ALL: 'en_US.UTF-8', LANG: 'de_DE.UTF-8' },
  });
  await $.session.start(start);
  expect(await paneTexts($)).toContain('Decision needed');
});

test('English without a setting or a locale', async ($, on) => {
  world(on, { files: withState(LIST_STATE) });
  await $.session.start(start);
  expect(await paneTexts($)).toContain('Decision needed');
});

test('/studio lang de and en override the setting; auto returns to it', async ($, on) => {
  world(on, { files: withState(LIST_STATE), settings: { language: 'german' } });
  await $.session.start(start);
  const en = await $.command.run({ ...run, command: 'studio', args: 'lang en' });
  expect(en.text).toBe('Studio board: English.');
  expect(await paneTexts($)).toContain('Decision needed');
  const de = await $.command.run({ ...run, command: 'studio', args: 'lang de' });
  expect(de.text).toBe('Studio-Board: Deutsch.');
  expect(await paneTexts($)).toContain('Entscheidung nötig');
  await $.command.run({ ...run, command: 'studio', args: 'lang en' });
  const auto = await $.command.run({ ...run, command: 'studio', args: 'lang auto' });
  expect(auto.text).toBe('Studio-Board: Deutsch.');
});

test('a stored language override is used from the start', async ($, on) => {
  world(on, { files: withState(LIST_STATE), store: { lang: 'de' } });
  await $.session.start(start);
  expect(await paneTexts($)).toContain('Entscheidung nötig');
});

test('an unknown language answers the usage text and changes nothing', async ($, on) => {
  world(on, { files: withState(LIST_STATE) });
  await $.session.start(start);
  const { text } = await $.command.run({ ...run, command: 'studio', args: 'lang fr' });
  expect(text).toMatch(/^Usage: \/studio/);
  expect(await paneTexts($)).toContain('Decision needed');
});

test('a failing store still switches the view for the session', async ($, on) => {
  world(on, { files: withState(LIST_STATE), storeFails: true });
  await $.session.start(start);
  await $.command.run({ ...run, command: 'studio', args: 'more' });
  expect(await paneTexts($)).toContain('Merge queue');
});

test('a paused state names the time and the resume command', async ($, on) => {
  world(on, {
    files: { ...withState({ ...LIST_STATE, pause: { at: 'x', time: '14:02' } }), [PAUSE]: '{}' },
  });
  await $.session.start(start);
  const texts = await paneTexts($);
  expect(texts[0]).toMatch(/◷ paused$/);
  expect(texts).toContain('Paused since 14:02. Nothing starts or merges; running crews finish.');
  expect(texts).toContain('→ /studio resume');
});
