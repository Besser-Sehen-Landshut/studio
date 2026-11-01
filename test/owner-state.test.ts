import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard, saveBoard } from '../src/board.js';
import { type CliDeps, runCli } from '../src/cli.js';
import { blockHold, readBlocks, readLimits, writeLimits } from '../src/limits.js';
import { migrateOwnerState } from '../src/owner-state.js';
import { ownerStateRootFor, projectStateRoots, stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { readUsage } from '../src/usage.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-owner-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = new Date('2026-11-01T10:00:00Z');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const STUDIO_YAML = `studio: 1
primary_repo: org/app
repos: [org/app]
allow_ambient_credentials: true
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 8, merge_max_busy: 5, check_twice_seconds: 30 }
merge: { strategy: studio-queue, contract_paths: [], method: squash }
roles:
  builder: { model: sonnet, wip: 3 }
owner_only: []
deploy_commands: []
`;
const itemYaml = (id: string) =>
  `  - { id: ${id}, title: Item ${id}, type: fix, role: builder, repo: org/app, size: S, priority: 1, status: ready, paths: [], touches: [${id.toLowerCase()}/**], depends_on: [], dod: [tests pass], history: [] }`;

let n = 0;
function makeOwner() {
  const base = join(root, `o${n++}`);
  mkdirSync(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const env: Record<string, string | undefined> = { PATH: process.env.PATH };
  const owner = ownerStateRootFor({ env, homedir: home });
  return { base, home, env, owner, stateBase: dirname(owner) };
}
type Owner = ReturnType<typeof makeOwner>;

function makeProject(o: Owner, name: string, ids: string[] = ['APP-1', 'APP-2']) {
  const dir = join(o.base, name);
  mkdirSync(dir);
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = join(dir, 'clone');
  git(dir, 'clone', '-q', origin, project);
  git(project, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'x\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  mkdirSync(join(project, '.studio'));
  writeFileSync(join(project, '.studio', 'studio.yaml'), STUDIO_YAML);
  writeFileSync(
    join(project, '.studio', 'board.yaml'),
    `items:\n${ids.map(itemYaml).join('\n')}\n`,
  );
  return {
    ...o,
    project,
    state: stateRootFor(project, { env: o.env, homedir: o.home }),
  };
}
type Fx = ReturnType<typeof makeProject>;

/** One fake machine: pids stay unique over all projects of an owner. */
function makePorts() {
  const real = realPorts();
  const alive = new Set<number>();
  const stopped: number[] = [];
  const started: string[][] = [];
  const identities = new Map<number, string | undefined>();
  let pid = 5000;
  const ports: Ports = {
    ...real,
    gh: { api: async () => '0', run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    claude: {
      async start(_cwd, args, _prompt, logPath) {
        started.push(args);
        pid += 1;
        alive.add(pid);
        writeFileSync(logPath, '', { flag: 'a' });
        return { pid };
      },
      alive: (p) => alive.has(p),
      identity: async (p) => (identities.has(p) ? identities.get(p) : `start-${p}`),
      async stop(p) {
        stopped.push(p);
        alive.delete(p);
      },
    },
    clock: { now: () => NOW, sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
  return { ports, alive, stopped, started, identities };
}

async function cli(fx: Fx, ports: Ports, argv: string[], extra: Partial<CliDeps> = {}) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', fx.project, ...argv], {
    ports,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: fx.env,
    homedir: fx.home,
    cwd: fx.project,
    ...extra,
  });
  return { code, out, err };
}

const seed = (dir: string, name: string, body: unknown) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
};
const jsonOf = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const log = (fx: Fx, id: string, ev: unknown) =>
  writeFileSync(join(fx.state, 'logs', `${id}.jsonl`), `${JSON.stringify(ev)}\n`, { flag: 'a' });
const ON_HOLD = { type: 'system', subtype: 'api_retry', error: 'account_on_hold' };
const A_BLOCK = {
  label: 'default',
  reason: 'account_on_hold',
  at: '2026-11-01T09:00:00.000Z',
};
const HELD_LOCK = {
  pid: process.pid,
  startedAt: NOW.toISOString(),
  heartbeat: NOW.toISOString(),
  token: 'other',
};
const boardBytes = (fx: Fx) => readFileSync(join(fx.project, '.studio', 'board.yaml'));
const itemOf = (fx: Fx, id: string) => loadBoard(fx.project).items.find((i) => i.id === id);
const recordOf = (fx: Fx, id: string) => jsonOf(fx.state, 'crew.json')[id];
const projectDirA = (o: Owner) => join(o.stateBase, 'aaaaaaaaaaaaaaaa-a');
const projectDirB = (o: Owner) => join(o.stateBase, 'bbbbbbbbbbbbbbbb-b');

/** Every file below `dir` with its bytes and mtime, for "wrote nothing". */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${lstatSync(p).mtimeMs}:${readFileSync(p, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

describe('owner paths', () => {
  it('the owner root lies below the state base', () => {
    expect(ownerStateRootFor({ homedir: '/h', env: {} })).toBe(
      join('/h', '.local', 'state', 'studio', 'owner'),
    );
    expect(ownerStateRootFor({ homedir: '/h', env: { XDG_STATE_HOME: '/s' } })).toBe(
      join('/s', 'studio', 'owner'),
    );
  });

  it('projectStateRoots takes real directories with a project name only', () => {
    const o = makeOwner();
    expect(projectStateRoots(o.stateBase)).toEqual([]);
    mkdirSync(projectDirA(o), { recursive: true });
    const plain = join(o.stateBase, '0123456789abcdef');
    mkdirSync(plain);
    mkdirSync(o.owner);
    mkdirSync(join(o.stateBase, 'foreign'));
    mkdirSync(join(o.stateBase, '0123456789ABCDEF-upper'));
    mkdirSync(join(o.stateBase, '0123456789abcde-short'));
    mkdirSync(join(o.stateBase, '0123456789abcdefx'));
    writeFileSync(join(o.stateBase, 'cccccccccccccccc-file'), '');
    const elsewhere = join(o.base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(o.stateBase, 'dddddddddddddddd-link'));
    expect(projectStateRoots(o.stateBase).sort()).toEqual([plain, projectDirA(o)].sort());
  });
});

describe('migrateOwnerState', () => {
  it('merges legacy files, removes them, and the second run writes nothing', () => {
    const o = makeOwner();
    const a = projectDirA(o);
    const b = projectDirB(o);
    const other = { label: 'label-b', reason: 'account_on_hold', at: '2026-10-31T09:00:00.000Z' };
    seed(a, 'blocks.json', [A_BLOCK]);
    seed(b, 'blocks.json', [{ ...A_BLOCK, at: '2026-11-01T08:00:00.000Z' }, other]);
    const early = { parkedUntil: '2026-11-01T11:00:00.000Z', kind: 'session' };
    const late = { parkedUntil: '2026-11-03T11:00:00.000Z', kind: 'weekly' };
    seed(a, 'limits.json', { 'label-a': early, 'label-b': late });
    seed(b, 'limits.json', { 'label-a': late, 'label-b': early });
    seed(a, 'usage.json', { '2026-11-01': { 'label-a': 2, 'label-b': 1 } });
    seed(b, 'usage.json', { '2026-11-01': { 'label-a': 3 }, '2026-10-31': { 'label-a': 7 } });

    expect(migrateOwnerState(o.owner, NOW)).toEqual([]);

    const blocks = readBlocks(o.owner);
    expect(blocks.ok).toBe(true);
    if (blocks.ok) {
      expect(blocks.blocks).toHaveLength(2);
      expect(blocks.blocks).toEqual(
        expect.arrayContaining([{ ...A_BLOCK, at: '2026-11-01T08:00:00.000Z' }, other]),
      );
    }
    expect(readLimits(o.owner)).toEqual({
      ok: true,
      labels: { 'label-a': late, 'label-b': late },
    });
    const usage = readUsage(o.owner);
    expect(usage.ok).toBe(true);
    if (usage.ok) {
      expect(usage.days['2026-11-01']?.['label-a']).toBe(5);
      expect(usage.days['2026-11-01']?.['label-b']).toBe(1);
      expect(usage.days['2026-10-31']?.['label-a']).toBe(7);
    }
    for (const dir of [a, b]) {
      for (const name of ['blocks.json', 'limits.json', 'usage.json']) {
        expect(existsSync(join(dir, name))).toBe(false);
      }
    }
    expect(lstatSync(o.owner).mode & 0o777).toBe(0o700);

    const before = snapshot(o.owner);
    expect(migrateOwnerState(o.owner, NOW)).toEqual([]);
    expect(snapshot(o.owner)).toEqual(before);
  });

  it('without legacy files no owner directory appears', () => {
    const o = makeOwner();
    mkdirSync(projectDirA(o), { recursive: true });
    expect(migrateOwnerState(o.owner, NOW)).toEqual([]);
    expect(existsSync(o.owner)).toBe(false);
  });

  it.each([
    ['blocks.json', readBlocks],
    ['limits.json', readLimits],
    ['usage.json', readUsage],
  ] as const)('a malformed legacy %s holds until its copy is removed', (name, read) => {
    const o = makeOwner();
    const a = projectDirA(o);
    seed(a, name, 'not json');
    const problems = migrateOwnerState(o.owner, NOW);
    expect(problems.join('\n')).toContain(`${name}.legacy-`);
    expect(existsSync(join(a, name))).toBe(false);
    const kept = join(o.owner, `${name}.legacy-aaaaaaaaaaaaaaaa-a`);
    expect(readFileSync(kept, 'utf8')).toBe('not json');
    expect(read(o.owner).ok).toBe(false);
    if (name === 'blocks.json') expect(blockHold(o.owner)).toBeDefined();
    // Later runs keep saying so.
    expect(migrateOwnerState(o.owner, NOW).join('\n')).toContain(`${name}.legacy-`);
    rmSync(kept);
    expect(read(o.owner).ok).toBe(true);
    if (name === 'blocks.json') expect(blockHold(o.owner)).toBeUndefined();
    expect(migrateOwnerState(o.owner, NOW)).toEqual([]);
  });

  it('a symlinked legacy file is not followed', () => {
    const o = makeOwner();
    const a = projectDirA(o);
    mkdirSync(a, { recursive: true });
    const target = join(o.base, 'target.json');
    const body = JSON.stringify([{ ...A_BLOCK, label: 'label-z' }]);
    writeFileSync(target, body);
    symlinkSync(target, join(a, 'blocks.json'));
    expect(migrateOwnerState(o.owner, NOW).join('\n')).toContain('blocks.json.legacy-');
    expect(readFileSync(target, 'utf8')).toBe(body);
    expect(existsSync(join(o.owner, 'blocks.json'))).toBe(false);
    expect(lstatSync(join(a, 'blocks.json'), { throwIfNoEntry: false })).toBeUndefined();
    const note = join(o.owner, 'blocks.json.legacy-aaaaaaaaaaaaaaaa-a');
    expect(lstatSync(note).isFile()).toBe(true);
    expect(readFileSync(note, 'utf8')).not.toContain('label-z');
    expect(readBlocks(o.owner)).toEqual({ ok: false });
  });

  it('an unreadable owner file keeps the legacy file in place', () => {
    const o = makeOwner();
    const a = projectDirA(o);
    seed(o.owner, 'blocks.json', 'not json');
    seed(a, 'blocks.json', [A_BLOCK]);
    expect(migrateOwnerState(o.owner, NOW).join('\n')).toContain('blocks.json');
    expect(jsonOf(a, 'blocks.json')).toEqual([A_BLOCK]);
    expect(readFileSync(join(o.owner, 'blocks.json'), 'utf8')).toBe('not json');
    expect(readBlocks(o.owner)).toEqual({ ok: false });
  });

  it('a lost migrate lock skips the migration', () => {
    const o = makeOwner();
    const a = projectDirA(o);
    seed(a, 'blocks.json', [A_BLOCK]);
    seed(o.owner, 'migrate.lock', HELD_LOCK);
    migrateOwnerState(o.owner, NOW);
    expect(jsonOf(a, 'blocks.json')).toEqual([A_BLOCK]);
    expect(existsSync(join(o.owner, 'blocks.json'))).toBe(false);
  });

  it('readers refuse a symlinked owner root', () => {
    const o = makeOwner();
    const elsewhere = join(o.base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'blocks.json'), '[]');
    mkdirSync(o.stateBase, { recursive: true });
    symlinkSync(elsewhere, o.owner);
    expect(readBlocks(o.owner)).toEqual({ ok: false });
    expect(readLimits(o.owner)).toEqual({ ok: false });
    expect(readUsage(o.owner)).toEqual({ ok: false });
  });
});

describe('an old install', () => {
  it('an unreadable blocks.json in one project root stops everything', async () => {
    const o = makeOwner();
    const a = makeProject(o, 'a');
    const b = makeProject(o, 'b');
    const p = makePorts();
    expect((await cli(b, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    seed(a.state, 'blocks.json', 'not json');

    const plan = await cli(a, p.ports, ['plan']);
    expect(plan.code).toBe(0);
    expect(plan.err).toContain('blocks.json.legacy-');
    expect(JSON.parse(plan.out).assign).toEqual([]);
    expect(p.stopped).toEqual([5001]);

    for (const fx of [a, b]) {
      expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    }
    expect(p.started).toHaveLength(1);
  });

  it('a launch refuses while a legacy file could not be migrated', async () => {
    const o = makeOwner();
    const a = makeProject(o, 'a');
    const p = makePorts();
    // Bound first, so the refusal below cannot come from the state marker.
    expect((await cli(a, p.ports, ['state'])).code).toBe(0);
    seed(a.state, 'blocks.json', [A_BLOCK]);
    seed(o.owner, 'migrate.lock', HELD_LOCK);
    const r = await cli(a, p.ports, ['launch', 'APP-1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not migrated');
    expect(p.started).toHaveLength(0);
  });
});

describe('two projects, one account', () => {
  async function twoCrews() {
    const o = makeOwner();
    const a = makeProject(o, 'a');
    const b = makeProject(o, 'b');
    const p = makePorts();
    expect((await cli(a, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    expect((await cli(b, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    return { o, a, b, p };
  }

  it('a block in A stops B, B moves its own item, B refuses launches', async () => {
    const { o, a, b, p } = await twoCrews();
    log(a, 'APP-1', ON_HOLD);
    const boardB = boardBytes(b);

    const r = await cli(a, p.ports, ['status', '--json']);
    expect(r.code).toBe(0);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
    expect(jsonOf(o.owner, 'blocks.json')).toEqual([
      { label: 'default', reason: 'account_on_hold', at: NOW.toISOString() },
    ]);
    expect(existsSync(join(a.state, 'blocks.json'))).toBe(false);
    expect(recordOf(b, 'APP-1').block.reason).toBe('account_on_hold');
    expect(recordOf(b, 'APP-1').stoppedAt).toBeDefined();
    expect(boardBytes(b)).toEqual(boardB);
    expect(itemOf(b, 'APP-1')?.status).toBe('assigned');
    expect(itemOf(a, 'APP-1')?.status).toBe('ready');

    // No lead ran in B until now; its next own reconcile moves the item.
    const launch = await cli(b, p.ports, ['launch', 'APP-2']);
    expect(launch.code).toBe(1);
    expect(launch.err).toContain('account block');
    expect(p.started).toHaveLength(2);
    expect(itemOf(b, 'APP-1')?.status).toBe('ready');
  });

  it('a block found in the log of B during a sweep is recorded too', async () => {
    const { o, a, b, p } = await twoCrews();
    seed(o.owner, 'blocks.json', [{ ...A_BLOCK, label: 'label-a' }]);
    log(b, 'APP-1', ON_HOLD);
    await cli(a, p.ports, ['status']);
    expect(jsonOf(o.owner, 'blocks.json')).toHaveLength(2);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
  });

  it('accounts-clear from A moves the scan start of B', async () => {
    const { o, a, b, p } = await twoCrews();
    log(a, 'APP-1', ON_HOLD);
    log(b, 'APP-1', ON_HOLD);
    await cli(a, p.ports, ['status']);
    const size = lstatSync(join(b.state, 'logs', 'APP-1.jsonl')).size;
    expect(recordOf(b, 'APP-1').logStart).not.toBe(size);
    const r = await cli(a, p.ports, ['accounts-clear', 'default'], { isTerminal: true });
    expect(r.code).toBe(0);
    expect(recordOf(b, 'APP-1').logStart).toBe(size);
    expect((await cli(b, p.ports, ['status'])).code).toBe(0);
    expect(readBlocks(o.owner)).toEqual({ ok: true, blocks: [] });
  });

  it('a crew of B with an unverifiable identity is reported, not signalled', async () => {
    const { a, b, p } = await twoCrews();
    const pidB = recordOf(b, 'APP-1').pid as number;
    p.identities.set(pidB, undefined);
    log(a, 'APP-1', ON_HOLD);
    const r = await cli(a, p.ports, ['status']);
    expect(p.stopped).toEqual([recordOf(a, 'APP-1').pid]);
    expect(r.err).toContain(`pid ${pidB}`);
    expect(recordOf(b, 'APP-1').stoppedAt).toBeUndefined();
  });

  it('an unreadable block file stops other projects too', async () => {
    const { o, a, p } = await twoCrews();
    seed(o.owner, 'blocks.json', 'not json');
    await cli(a, p.ports, ['status']);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
  });

  it('an unreadable crew.json of this project still lets the sweep stop the others', async () => {
    const { o, a, p } = await twoCrews();
    seed(o.owner, 'blocks.json', [A_BLOCK]);
    writeFileSync(join(a.state, 'crew.json'), 'not json');
    const r = await cli(a, p.ports, ['status']);
    expect(r.code).toBe(1);
    expect(p.stopped).toEqual([5002]);
  });

  it('an unreadable crew.json of another project does not stop the sweep, but refuses a clear', async () => {
    const { o, a, b, p } = await twoCrews();
    seed(o.owner, 'blocks.json', [A_BLOCK]);
    writeFileSync(join(b.state, 'crew.json'), 'not json');
    const r = await cli(a, p.ports, ['status']);
    expect(r.err).toContain('were not checked');
    expect(p.stopped).toEqual([5001]);
    const clear = await cli(a, p.ports, ['accounts-clear', 'default'], { isTerminal: true });
    expect(clear.code).toBe(1);
    expect(jsonOf(o.owner, 'blocks.json')).toEqual([A_BLOCK]);
  });

  const markMerged = (fx: Fx) => {
    const board = loadBoard(fx.project);
    saveBoard(fx.project, {
      ...board,
      items: board.items.map((i) => (i.id === 'APP-1' ? { ...i, status: 'merged' as const } : i)),
    });
  };

  it('a broken marker in another project puts every record in scope', async () => {
    const { o, a, b, p } = await twoCrews();
    markMerged(b);
    writeFileSync(join(b.state, 'marker.json'), 'not json');
    seed(o.owner, 'blocks.json', [A_BLOCK]);
    await cli(a, p.ports, ['status']);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
  });

  it('a merged item of another project is left alone when its board reads', async () => {
    const { o, a, b, p } = await twoCrews();
    markMerged(b);
    seed(o.owner, 'blocks.json', [A_BLOCK]);
    await cli(a, p.ports, ['status']);
    expect(p.stopped).toEqual([recordOf(a, 'APP-1').pid]);
    expect(recordOf(b, 'APP-1').stoppedAt).toBeUndefined();
  });

  it('without a block a project scans only itself', async () => {
    const { o, a, b, p } = await twoCrews();
    log(b, 'APP-1', ON_HOLD);
    await cli(a, p.ports, ['status']);
    expect(p.stopped).toEqual([]);
    expect(recordOf(b, 'APP-1').stoppedAt).toBeUndefined();
    expect(readBlocks(o.owner)).toEqual({ ok: true, blocks: [] });
  });

  it('max_parallel counts crews of every project', async () => {
    const o = makeOwner();
    const a = makeProject(o, 'a');
    const b = makeProject(o, 'b');
    const dir = join(o.home, '.config', 'studio');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.yaml'), 'crew_label_limits:\n  max_parallel: 1\n');
    const p = makePorts();
    expect((await cli(a, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    const plan = JSON.parse((await cli(b, p.ports, ['plan'])).out);
    expect(plan.assign).toEqual([]);
    expect(plan.deferred.map((d: { id: string }) => d.id)).toContain('APP-1');
    expect((await cli(b, p.ports, ['launch', 'APP-1'])).code).toBe(1);
    expect(p.started).toHaveLength(1);
  });

  it('a park in A does not stop B but holds its launches on that label', async () => {
    const { o, a, b, p } = await twoCrews();
    log(a, 'APP-1', {
      type: 'result',
      is_error: true,
      result: "You've hit your limit · resets 3pm",
    });
    await cli(a, p.ports, ['status']);
    expect(p.stopped).toEqual([recordOf(a, 'APP-1').pid]);
    expect(Object.keys(jsonOf(o.owner, 'limits.json'))).toEqual(['default']);
    expect(existsSync(join(a.state, 'limits.json'))).toBe(false);
    expect(recordOf(b, 'APP-1').stoppedAt).toBeUndefined();
    expect((await cli(b, p.ports, ['launch', 'APP-2'])).code).toBe(1);
    expect(p.started).toHaveLength(2);
  });

  it('runs count in the owner usage, and limits are written to the owner root', async () => {
    const { o, a } = await twoCrews();
    const usage = readUsage(o.owner);
    expect(usage.ok && usage.days['2026-11-01']?.default).toBe(2);
    expect(existsSync(join(a.state, 'usage.json'))).toBe(false);
    writeLimits(o.owner, {});
    expect(readLimits(o.owner)).toEqual({ ok: true, labels: {} });
  });

  it('a project without crew records writes nothing, the owner root included', async () => {
    const o = makeOwner();
    const a = makeProject(o, 'a');
    expect((await cli(a, makePorts().ports, ['plan'])).code).toBe(0);
    expect(existsSync(o.owner)).toBe(false);
    expect(existsSync(a.state)).toBe(false);
  });

  it('the guard context of a crew protects the owner root', async () => {
    const { o, a } = await twoCrews();
    const ctx = jsonOf(join(a.state, 'guard'), 'APP-1.json');
    expect(ctx.protectedPaths).toContain(o.owner);
  });
});
