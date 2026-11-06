import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Board, WorkItem } from '../src/board.js';
import {
  applyCloneGc,
  DROPPED_KEEP_DAYS,
  diskBytes,
  formatBytes,
  type GcPlan,
  localTips,
  planCloneGc,
  planTotals,
} from '../src/clone-gc.js';
import { acquireStateLock, writeStateFile } from '../src/paths.js';
import type { Ports } from '../src/ports.js';
import { LAUNCH_LOCK, LAUNCH_LOCK_STALE_MS } from '../src/usage.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'studio-gc-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const NOW = Date.parse('2026-11-06T10:00:00Z');
const DAY = 86_400_000;

let n = 0;
function fixture() {
  const base = join(tmp, `f${n++}`);
  const state = join(base, 'state');
  const owner = join(base, 'owner');
  mkdirSync(join(state, 'clones'), { recursive: true });
  mkdirSync(owner, { recursive: true });
  return { state, owner };
}

/** A clone on `studio/<id>` with one commit; returns its tip. */
function makeClone(state: string, id: string): string {
  const dir = join(state, 'clones', id);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', `studio/${id}`);
  writeFileSync(join(dir, 'a.txt'), `${id}\n`);
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'work');
  return git(dir, 'rev-parse', 'HEAD');
}

function addHome(state: string, id: string) {
  for (const sub of ['homes', 'tmp']) {
    mkdirSync(join(state, sub, id, '.cargo'), { recursive: true });
    writeFileSync(join(state, sub, id, '.cargo', 'x'), 'cache');
  }
}

const item = (id: string, status: string, extra: Partial<WorkItem> = {}): WorkItem =>
  ({
    id,
    title: id,
    type: 'fix',
    role: 'builder',
    repo: 'org/app',
    size: 'S',
    priority: 1,
    status,
    paths: [],
    touches: [],
    dependsOn: [],
    dod: ['x'],
    history: [],
    ...extra,
  }) as WorkItem;
const board = (...items: WorkItem[]): Board => ({ items }) as Board;

/**
 * Ports whose git refuses every call (nothing may run git in a crew clone) and whose GitHub knows
 * the commits in `pushed` as part of main.
 */
function ports(o: { pushed?: string[]; heads?: Record<number, string>; live?: number[] } = {}) {
  const calls: string[] = [];
  const live = new Set(o.live ?? []);
  const p: Ports = {
    gh: {
      async api(path) {
        calls.push(path);
        const pr = /^repos\/org\/app\/pulls\/(\d+)$/.exec(path);
        if (pr) {
          const head = o.heads?.[Number(pr[1])];
          if (head === undefined) throw new Error('HTTP 404');
          return `${head}\n`;
        }
        const cmp = /^repos\/org\/app\/compare\/([^.]+)\.\.\.([0-9a-f]+)$/.exec(path);
        if (cmp) {
          const [, base, tip] = cmp;
          if (!(o.pushed ?? []).includes(tip as string))
            throw new Error('HTTP 404: No commit found');
          return base === 'main' ? 'behind\n' : 'diverged\n';
        }
        throw new Error(`unscripted gh api ${path}`);
      },
      async run(args) {
        throw new Error(`unscripted gh ${args.join(' ')}`);
      },
    },
    git: {
      async run(_cwd, args) {
        throw new Error(`git must not run: ${args.join(' ')}`);
      },
    },
    credentials: {} as Ports['credentials'],
    claude: {
      start: async () => ({ pid: 1 }),
      alive: (pid) => live.has(pid),
      identity: async (pid) => (live.has(pid) ? `start-${pid}` : undefined),
      stop: async () => {},
    },
    clock: { now: () => new Date(NOW), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
  return { ports: p, calls };
}

const plan = (
  state: string,
  b: Board | undefined,
  p: Ports,
  extra: { remote?: boolean; sizes?: boolean; maxRemote?: number } = {},
) =>
  planCloneGc({
    stateRoot: state,
    board: b,
    ports: p,
    now: new Date(NOW),
    remote: extra.remote ?? true,
    sizes: extra.sizes ?? false,
    ...(extra.maxRemote === undefined ? {} : { maxRemote: extra.maxRemote }),
  });
const verdictOf = (pl: GcPlan, id: string) => pl.entries.find((e) => e.item === id);
const crewRecord = (id: string, pid: number, identity?: string) => ({
  name: `studio-builder-${id.toLowerCase()}`,
  item: id,
  role: 'builder',
  pid,
  log: '/x',
  startedAt: '2026-11-06T09:00:00.000Z',
  ...(identity === undefined ? {} : { identity }),
});
const writeLessons = (state: string, lessons: unknown[]) =>
  writeStateFile(state, join(state, 'lessons.json'), JSON.stringify({ next: 9, lessons }));

describe('clone clean-up: what can go', () => {
  it('removes a merged item whose commits are on GitHub, with its crew home and tmp dir', async () => {
    const { state, owner } = fixture();
    const tip = makeClone(state, 'APP-1');
    addHome(state, 'APP-1');
    const { ports: p } = ports({ pushed: [tip] });
    const pl = await plan(state, board(item('APP-1', 'merged')), p);
    expect(verdictOf(pl, 'APP-1')).toMatchObject({ verdict: 'remove', clone: true });
    const r = await applyCloneGc({ stateRoot: state, ownerRoot: owner, plan: pl, ports: p });
    expect(r).toEqual({ removed: ['APP-1'], trimmed: [], skipped: [] });
    for (const sub of ['clones', 'homes', 'tmp']) {
      expect(existsSync(join(state, sub, 'APP-1'))).toBe(false);
    }
  });

  it('takes a squash-merged branch as pushed when its tip is the pull request head', async () => {
    const { state } = fixture();
    const tip = makeClone(state, 'APP-1');
    const { ports: p, calls } = ports({ heads: { 7: tip } });
    const pl = await plan(state, board(item('APP-1', 'merged', { pr: 7 })), p);
    expect(verdictOf(pl, 'APP-1')?.verdict).toBe('remove');
    expect(calls).toEqual(['repos/org/app/pulls/7']);
  });

  it('removes an old dropped item, and the home of a finished item that has no clone', async () => {
    const { state } = fixture();
    const tip = makeClone(state, 'APP-1');
    addHome(state, 'APP-2');
    const dropped = item('APP-1', 'dropped', {
      history: [
        {
          at: new Date(NOW - (DROPPED_KEEP_DAYS + 1) * DAY).toISOString(),
          from: 'ready',
          to: 'dropped',
          by: 'lead',
        },
      ],
    });
    const { ports: p } = ports({ pushed: [tip] });
    const pl = await plan(state, board(dropped, item('APP-2', 'merged')), p);
    expect(verdictOf(pl, 'APP-1')?.verdict).toBe('remove');
    expect(verdictOf(pl, 'APP-2')).toMatchObject({ verdict: 'remove', clone: false });
  });

  it('removes a merged piece of an accepting epic: the acceptance checks main in its own clone', async () => {
    const { state } = fixture();
    const tip = makeClone(state, 'APP-1');
    const b = {
      items: [item('APP-1', 'merged', { epic: 'E-1' })],
      epics: [{ id: 'E-1', title: 'e', status: 'accepting', history: [] }],
    } as unknown as Board;
    const { ports: p } = ports({ pushed: [tip] });
    expect(verdictOf(await plan(state, b, p), 'APP-1')?.verdict).toBe('remove');
  });

  it('a clone without .git holds no commits: it goes without asking GitHub', async () => {
    const { state } = fixture();
    mkdirSync(join(state, 'clones', 'APP-1', 'target'), { recursive: true });
    const { ports: p, calls } = ports();
    expect(verdictOf(await plan(state, board(item('APP-1', 'merged')), p), 'APP-1')?.verdict).toBe(
      'remove',
    );
    expect(calls).toEqual([]);
  });

  it('trims a clone whose report a pending lesson cites, then removes it once the lesson is judged', async () => {
    const { state, owner } = fixture();
    const tip = makeClone(state, 'APP-1');
    mkdirSync(join(state, 'clones', 'APP-1', '.studio', 'reports'), { recursive: true });
    mkdirSync(join(state, 'clones', 'APP-1', '.studio', 'roles'), { recursive: true });
    writeFileSync(join(state, 'clones', 'APP-1', '.studio', 'reports', 'r.md'), 'report');
    mkdirSync(join(state, 'clones', 'APP-1', 'target', 'debug'), { recursive: true });
    writeLessons(state, [
      {
        n: 3,
        role: 'builder',
        item: 'APP-1',
        text: 't',
        at: '2026-11-06T09:00:00Z',
        evidence: { report: 'clones/APP-1/.studio/reports/r.md' },
      },
    ]);
    const { ports: p } = ports({ pushed: [tip] });
    const b = board(item('APP-1', 'merged'));
    const pl = await plan(state, b, p);
    expect(verdictOf(pl, 'APP-1')).toMatchObject({
      verdict: 'trim',
      reason: expect.stringContaining('lesson 3'),
    });
    const r = await applyCloneGc({ stateRoot: state, ownerRoot: owner, plan: pl, ports: p });
    expect(r.trimmed).toEqual(['APP-1']);
    expect(readdirSync(join(state, 'clones', 'APP-1'))).toEqual(['.studio']);
    expect(readdirSync(join(state, 'clones', 'APP-1', '.studio'))).toEqual(['reports']);
    expect(existsSync(join(state, 'clones', 'APP-1', '.studio', 'reports', 'r.md'))).toBe(true);
    // A trimmed clone stays as it is while the lesson waits.
    expect(verdictOf(await plan(state, b, p), 'APP-1')).toMatchObject({
      verdict: 'keep',
      reason: 'only its report is left, cited by lesson 3',
    });
    writeLessons(state, []);
    expect(verdictOf(await plan(state, b, p), 'APP-1')?.verdict).toBe('remove');
  });

  it('a lesson folded in from another run (alsoFrom) keeps the report too', async () => {
    const { state } = fixture();
    mkdirSync(join(state, 'clones', 'APP-1', '.studio', 'reports'), { recursive: true });
    writeLessons(state, [
      {
        n: 4,
        role: 'builder',
        item: 'APP-9',
        text: 't',
        at: '2026-11-06T09:00:00Z',
        alsoFrom: [{ item: 'APP-1', report: 'clones/APP-1/.studio/reports/r.md' }],
      },
    ]);
    const { ports: p } = ports();
    expect(verdictOf(await plan(state, board(item('APP-1', 'merged')), p), 'APP-1')?.verdict).toBe(
      'keep',
    );
  });
});

describe('clone clean-up: what stays (fail closed)', () => {
  it('keeps a clone with a commit that is not on GitHub', async () => {
    const { state } = fixture();
    makeClone(state, 'APP-1');
    const { ports: p } = ports({ pushed: [] });
    expect(verdictOf(await plan(state, board(item('APP-1', 'merged')), p), 'APP-1')).toMatchObject({
      verdict: 'keep',
      reason: expect.stringMatching(/^commit [0-9a-f]{12} is not on GitHub/),
    });
  });

  it('keeps a clone whose pull request head differs and whose tip GitHub does not contain', async () => {
    const { state } = fixture();
    makeClone(state, 'APP-1');
    const { ports: p } = ports({ heads: { 7: 'b'.repeat(40) } });
    expect(
      verdictOf(await plan(state, board(item('APP-1', 'merged', { pr: 7 })), p), 'APP-1')?.verdict,
    ).toBe('keep');
  });

  it('keeps a clone when GitHub cannot be asked', async () => {
    const { state } = fixture();
    makeClone(state, 'APP-1');
    const p = ports().ports;
    p.gh.api = async () => {
      throw new Error('network down');
    };
    expect(verdictOf(await plan(state, board(item('APP-1', 'merged')), p), 'APP-1')?.verdict).toBe(
      'keep',
    );
  });

  it('checks every local branch, also a packed one and a detached HEAD', async () => {
    const { state } = fixture();
    const tip = makeClone(state, 'APP-1');
    const dir = join(state, 'clones', 'APP-1');
    git(dir, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-q', '-m', 'side');
    const side = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'pack-refs', '--all');
    git(dir, 'checkout', '-q', '--detach', `studio/APP-1`);
    const tips = localTips(dir);
    expect(tips.ok && [...tips.tips].sort()).toEqual([tip, side].sort());
    const { ports: p } = ports({ pushed: [tip] });
    expect(verdictOf(await plan(state, board(item('APP-1', 'merged')), p), 'APP-1')).toMatchObject({
      verdict: 'keep',
      reason: expect.stringContaining(side.slice(0, 12)),
    });
  });

  it('keeps a clone with a stash, a linked ref or an odd HEAD', async () => {
    const { state } = fixture();
    for (const id of ['APP-1', 'APP-2', 'APP-3']) makeClone(state, id);
    writeFileSync(join(state, 'clones', 'APP-1', '.git', 'refs', 'stash'), `${'c'.repeat(40)}\n`);
    const ref = join(state, 'clones', 'APP-2', '.git', 'refs', 'heads', 'other');
    symlinkSync(join(state, 'clones', 'APP-2', '.git', 'HEAD'), ref);
    writeFileSync(join(state, 'clones', 'APP-3', '.git', 'HEAD'), 'ref: ../../outside\n');
    const { ports: p, calls } = ports();
    const b = board(item('APP-1', 'merged'), item('APP-2', 'merged'), item('APP-3', 'merged'));
    const pl = await plan(state, b, p);
    expect(verdictOf(pl, 'APP-1')).toMatchObject({ verdict: 'keep', reason: 'it has a stash' });
    expect(verdictOf(pl, 'APP-2')).toMatchObject({
      verdict: 'keep',
      reason: 'a branch ref is no plain commit id',
    });
    expect(verdictOf(pl, 'APP-3')).toMatchObject({
      verdict: 'keep',
      reason: '.git/HEAD is unusual',
    });
    expect(calls).toEqual([]);
  });

  it('keeps a clone that is a link, or whose .git is a file', async () => {
    const { state } = fixture();
    mkdirSync(join(tmp, 'elsewhere'), { recursive: true });
    symlinkSync(join(tmp, 'elsewhere'), join(state, 'clones', 'APP-1'));
    mkdirSync(join(state, 'clones', 'APP-2'));
    writeFileSync(join(state, 'clones', 'APP-2', '.git'), 'gitdir: /somewhere\n');
    const { ports: p } = ports();
    const pl = await plan(state, board(item('APP-1', 'merged'), item('APP-2', 'merged')), p);
    expect(verdictOf(pl, 'APP-1')).toMatchObject({
      verdict: 'keep',
      reason: 'the clone is no plain folder',
    });
    expect(verdictOf(pl, 'APP-2')).toMatchObject({
      verdict: 'keep',
      reason: '.git is no plain folder',
    });
  });

  it('keeps items that are not finished, not on the board, or not items at all', async () => {
    const { state } = fixture();
    makeClone(state, 'APP-1');
    makeClone(state, 'APP-2');
    mkdirSync(join(state, 'clones', 'notes'));
    const { ports: p, calls } = ports();
    const pl = await plan(state, board(item('APP-1', 'in_review')), p);
    expect(verdictOf(pl, 'APP-1')).toMatchObject({
      verdict: 'keep',
      reason: 'the item is in_review',
    });
    expect(verdictOf(pl, 'APP-2')).toMatchObject({ verdict: 'keep', reason: 'not on the board' });
    expect(verdictOf(pl, 'notes')).toMatchObject({ verdict: 'keep', reason: 'not an item' });
    expect(calls).toEqual([]);
  });

  it('keeps a clone whose crew runs, or may run, even when the item is finished', async () => {
    const { state } = fixture();
    makeClone(state, 'APP-1');
    makeClone(state, 'APP-2');
    writeStateFile(
      state,
      join(state, 'crew.json'),
      JSON.stringify({
        'APP-1': crewRecord('APP-1', 41, 'start-41'),
        'APP-2': crewRecord('APP-2', 42),
      }),
    );
    const { ports: p } = ports({ live: [41, 42] });
    const pl = await plan(state, board(item('APP-1', 'merged'), item('APP-2', 'merged')), p);
    expect(verdictOf(pl, 'APP-1')).toMatchObject({
      verdict: 'keep',
      reason: 'its crew is running',
    });
    expect(verdictOf(pl, 'APP-2')?.reason).toMatch(/may still run/);
  });

  it('keeps a recently dropped item, and one whose drop time is unknown', async () => {
    const { state } = fixture();
    addHome(state, 'APP-1');
    addHome(state, 'APP-2');
    const recent = item('APP-1', 'dropped', {
      history: [
        { at: new Date(NOW - DAY).toISOString(), from: 'ready', to: 'dropped', by: 'lead' },
      ],
    });
    const { ports: p } = ports();
    const pl = await plan(state, board(recent, item('APP-2', 'dropped')), p);
    expect(verdictOf(pl, 'APP-1')).toMatchObject({
      verdict: 'keep',
      reason: `dropped less than ${DROPPED_KEEP_DAYS} days ago`,
    });
    expect(verdictOf(pl, 'APP-2')).toMatchObject({
      verdict: 'keep',
      reason: 'dropped, but its history has no drop time',
    });
  });

  it('keeps everything when the board or crew.json cannot be read', async () => {
    const { state } = fixture();
    addHome(state, 'APP-1');
    const { ports: p } = ports();
    expect((await plan(state, undefined, p)).entries).toEqual([
      { item: 'APP-1', clone: false, verdict: 'keep', reason: 'the board cannot be read' },
    ]);
    writeFileSync(join(state, 'crew.json'), '{ not json');
    const pl = await plan(state, board(item('APP-1', 'merged')), p);
    expect(pl.problem).toBe('crew.json cannot be read');
    expect(verdictOf(pl, 'APP-1')?.verdict).toBe('keep');
  });

  it('keeps a clone when lessons.json cannot be read', async () => {
    const { state } = fixture();
    makeClone(state, 'APP-1');
    writeFileSync(join(state, 'lessons.json'), 'nope');
    const { ports: p } = ports();
    expect(verdictOf(await plan(state, board(item('APP-1', 'merged')), p), 'APP-1')).toMatchObject({
      verdict: 'keep',
      reason: 'lessons.json cannot be read',
    });
  });

  it('without GitHub (doctor) or past the bound a clone with commits is unchecked, never removable', async () => {
    const { state } = fixture();
    const a = makeClone(state, 'APP-1');
    const b = makeClone(state, 'APP-2');
    const { ports: p, calls } = ports({ pushed: [a, b] });
    const bd = board(item('APP-1', 'merged'), item('APP-2', 'merged'));
    const offline = await plan(state, bd, p, { remote: false });
    expect(offline.entries.map((e) => e.verdict)).toEqual(['unchecked', 'unchecked']);
    expect(calls).toEqual([]);
    const bounded = await plan(state, bd, p, { maxRemote: 1 });
    expect(bounded.entries.map((e) => e.verdict)).toEqual(['remove', 'unchecked']);
    const r = await applyCloneGc({
      stateRoot: state,
      ownerRoot: fixture().owner,
      plan: offline,
      ports: p,
    });
    expect(r).toEqual({ removed: [], trimmed: [], skipped: [] });
    expect(existsSync(join(state, 'clones', 'APP-1'))).toBe(true);
  });

  it('removes nothing while a launch holds the lock, nor a clone whose crew started since the plan', async () => {
    const { state, owner } = fixture();
    const tip = makeClone(state, 'APP-1');
    const { ports: p } = ports({ pushed: [tip], live: [77] });
    const pl = await plan(state, board(item('APP-1', 'merged')), p);
    expect(verdictOf(pl, 'APP-1')?.verdict).toBe('remove');
    const lock = acquireStateLock(owner, LAUNCH_LOCK, {
      now: new Date(),
      heartbeatStaleMs: LAUNCH_LOCK_STALE_MS,
    });
    const r1 = await applyCloneGc({ stateRoot: state, ownerRoot: owner, plan: pl, ports: p });
    expect(r1.skipped).toEqual([{ item: 'APP-1', reason: 'a launch is in progress' }]);
    lock?.release();
    writeStateFile(
      state,
      join(state, 'crew.json'),
      JSON.stringify({ 'APP-1': crewRecord('APP-1', 77, 'start-77') }),
    );
    const r2 = await applyCloneGc({ stateRoot: state, ownerRoot: owner, plan: pl, ports: p });
    expect(r2.skipped).toEqual([{ item: 'APP-1', reason: 'its crew is running' }]);
    expect(existsSync(join(state, 'clones', 'APP-1'))).toBe(true);
  });

  it('never runs git, in a clone or anywhere', async () => {
    const { state, owner } = fixture();
    const tip = makeClone(state, 'APP-1');
    const { ports: p } = ports({ pushed: [tip] });
    // The ports' git throws on any call: a plan and its apply that succeed ran none.
    const pl = await plan(state, board(item('APP-1', 'merged')), p, { sizes: true });
    expect(
      (await applyCloneGc({ stateRoot: state, ownerRoot: owner, plan: pl, ports: p })).removed,
    ).toEqual(['APP-1']);
  });
});

describe('clone sizes', () => {
  it('counts the clone, home and tmp, names .git, target and node_modules, and counts a hard link once', async () => {
    const { state } = fixture();
    makeClone(state, 'APP-1');
    const clone = join(state, 'clones', 'APP-1');
    mkdirSync(join(clone, 'target', 'debug'), { recursive: true });
    writeFileSync(join(clone, 'target', 'debug', 'big'), Buffer.alloc(200_000));
    mkdirSync(join(clone, 'node_modules'));
    writeFileSync(join(clone, 'node_modules', 'm.js'), 'x'.repeat(5000));
    addHome(state, 'APP-1');
    const { ports: p } = ports();
    const e = verdictOf(
      await plan(state, board(item('APP-1', 'in_progress')), p, { sizes: true }),
      'APP-1',
    );
    expect(e?.parts?.target).toBeGreaterThanOrEqual(200_000);
    expect(e?.parts?.['.git']).toBeGreaterThan(0);
    expect(e?.parts?.node_modules).toBeGreaterThan(0);
    expect(e?.bytes).toBeGreaterThan((e?.parts?.target ?? 0) + (e?.parts?.['.git'] ?? 0));
    execFileSync('ln', [join(clone, 'target', 'debug', 'big'), join(clone, 'target', 'twin')]);
    const once = diskBytes(join(clone, 'target'));
    expect(once).toBeLessThan(400_000);
  });

  it('formats sizes and sums a plan', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5_500_000_000)).toBe('5.5 GB');
    expect(formatBytes(340_000_000)).toBe('340 MB');
    expect(
      planTotals({
        entries: [
          { item: 'A-1', clone: true, verdict: 'remove', reason: 'merged', bytes: 10 },
          { item: 'A-2', clone: true, verdict: 'keep', reason: 'x', bytes: 5 },
          { item: 'A-3', clone: false, verdict: 'unchecked', reason: 'x', bytes: 1 },
        ],
      }),
    ).toEqual({ clones: 2, bytes: 16, removable: 1, removableBytes: 10, unchecked: 1 });
  });
});
