import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type Board,
  epicProgress,
  loadBoard,
  parseBoard,
  saveBoard,
  settleEpics,
  type WorkItem,
} from '../src/board.js';
import { ownerConfigSchema, parseConfig, type StudioConfig } from '../src/config.js';
import { editEpic, epicRows } from '../src/epics.js';
import {
  CONTRACTS_FILE,
  caseCollisions,
  checkContracts,
  depKey,
  formatGroupRows,
  type GroupProject,
  groupRowFromState,
  type Membership,
  memberStatusLookup,
  membershipOf,
  readContractChange,
  readProjectBoard,
  readReference,
  referenceBrief,
  referenceCollisions,
  resolveExternalDeps,
  writeReference,
} from '../src/group.js';
import { planAssignments } from '../src/planner.js';
import { type Ports, realPorts } from '../src/ports.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-group-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const studioYaml = (repo: string, extra = '') => `studio: 1
primary_repo: ${repo}
repos: [${repo}]
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 4, merge_max_busy: 3, check_twice_seconds: 0 }
merge: { strategy: studio-queue, contract_paths: [] }
roles:
  builder: { model: sonnet, wip: 2 }
${extra}`;

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'APP-1',
  title: 'A thing',
  type: 'fix',
  role: 'builder',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'ready',
  paths: [],
  touches: [],
  dependsOn: [],
  dod: ['a test shows it'],
  history: [],
  ...over,
});

/** A project folder with studio.yaml and a board. */
function project(name: string, repo: string, items: WorkItem[] = [], extra = ''): string {
  const dir = join(root, `${name}-${n++}`);
  mkdirSync(join(dir, '.studio'), { recursive: true });
  writeFileSync(join(dir, '.studio', 'studio.yaml'), studioYaml(repo, extra));
  saveBoard(dir, { items });
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });

/** A main project checkout with an origin (a bare repository next to it) holding `files`. */
function mainWithOrigin(files: Record<string, string>): {
  dir: string;
  push(f: Record<string, string>): void;
} {
  const dir = project('platform', 'org/platform');
  git(dir, 'init', '-q', '-b', 'main');
  const push = (f: Record<string, string>) => {
    for (const [path, content] of Object.entries(f)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
      git(dir, 'add', '--', path);
    }
    git(dir, 'commit', '-q', '-m', 'change', '--allow-empty');
    if (existsSync(`${dir}.git`)) git(dir, 'push', '-q', 'origin', 'main');
  };
  push(files);
  git(root, 'clone', '-q', '--bare', dir, `${dir}.git`);
  git(dir, 'remote', 'add', 'origin', `${dir}.git`);
  return { dir, push };
}

const groupOf = (main: string, member: string, extra: Record<string, unknown> = {}) =>
  ownerConfigSchema.parse({
    groups: [
      {
        name: 'shop',
        main: 'platform',
        projects: [
          { id: 'platform', repo: 'org/platform', dir: main },
          { id: 'web', repo: 'org/web', dir: member },
        ],
        reference: ['docs/contracts/**', 'docs/adr/**', 'docs/glossary.md'],
        ...extra,
      },
    ],
  });

const config = (repo: string): StudioConfig => parseConfig(studioYaml(repo), 'studio.yaml');

describe('the owner config', () => {
  const p = (id: string, dir: string, repo = `org/${id}`) => ({ id, repo, dir });
  const base = {
    name: 'shop',
    main: 'platform',
    projects: [p('platform', '/w/platform'), p('web', '/w/web')],
    reference: ['docs/**'],
  };
  it('takes a group with a main project, members, reference paths and a size cap', () => {
    const g = ownerConfigSchema.parse({ groups: [base] }).groups?.[0];
    expect(g?.referenceMaxKib).toBe(256);
    expect(g?.contracts).toBeUndefined();
  });
  it('refuses a main project that is no project, duplicate ids and a folder in two places', () => {
    expect(() => ownerConfigSchema.parse({ groups: [{ ...base, main: 'api' }] })).toThrow(
      /one of projects/,
    );
    expect(() =>
      ownerConfigSchema.parse({
        groups: [
          { ...base, projects: [p('web', '/w/a'), p('web', '/w/b'), p('platform', '/w/c')] },
        ],
      }),
    ).toThrow(/duplicate project web/);
    expect(() =>
      ownerConfigSchema.parse({
        groups: [
          base,
          { ...base, name: 'other', projects: [p('platform', '/w/web'), p('x', '/w/x')] },
        ],
      }),
    ).toThrow(/at most one group/);
  });
  it('refuses contracts on the main project, a relative folder and a group of one', () => {
    expect(() =>
      ownerConfigSchema.parse({
        groups: [
          {
            ...base,
            projects: [{ ...p('platform', '/w/p'), contracts: ['x/**'] }, p('web', '/w/w')],
          },
        ],
      }),
    ).toThrow(/narrows a member only/);
    expect(() =>
      ownerConfigSchema.parse({
        groups: [{ ...base, projects: [p('platform', 'rel'), p('web', '/w')] }],
      }),
    ).toThrow(/absolute/);
    expect(() =>
      ownerConfigSchema.parse({ groups: [{ ...base, projects: [p('platform', '/w')] }] }),
    ).toThrow();
  });
  it('a repository cannot name a group: studio.yaml refuses the key', () => {
    expect(() =>
      parseConfig(studioYaml('org/web', 'groups: [{ name: shop }]\n'), 'studio.yaml'),
    ).toThrow(/groups: unknown key/);
  });
});

describe('membershipOf', () => {
  it('finds the project by its real path, and only by the owner config', () => {
    const main = project('platform', 'org/platform');
    const web = project('web', 'org/web');
    const owner = groupOf(main, web);
    const m = membershipOf(web, config('org/web'), owner) as Membership;
    expect(m.self.id).toBe('web');
    expect(m.main.id).toBe('platform');
    expect(m.isMain).toBe(false);
    expect(membershipOf(main, config('org/platform'), owner)?.isMain).toBe(true);
    const other = project('other', 'org/other');
    expect(membershipOf(other, config('org/other'), owner)).toBeUndefined();
  });
  it('refuses a folder whose studio.yaml names another repository than the owner config', () => {
    const main = project('platform', 'org/platform');
    const web = project('web', 'org/web');
    expect(() => membershipOf(web, config('org/evil'), groupOf(main, web))).toThrow(
      /names org\/web for this folder/,
    );
  });
});

describe('cross-project dependencies', () => {
  const setup = (webItems: WorkItem[]) => {
    const main = project('platform', 'org/platform');
    const web = project('web', 'org/web', webItems);
    const owner = groupOf(main, web);
    return { m: membershipOf(main, config('org/platform'), owner) as Membership, web };
  };
  const waiting = (deps: string[], id = 'PLAT-1') =>
    item({ id, repo: 'org/platform', dependsOn: deps });

  it('the board takes <project>:<id> and still refuses an unknown local id', () => {
    const text = (dep: string) =>
      `items:\n  - { id: APP-1, title: t, type: fix, role: builder, repo: org/app, size: S, priority: 1, status: ready, depends_on: ["${dep}"] }\n`;
    expect(parseBoard(text('web:WEB-3'), 'b').items[0]?.dependsOn).toEqual(['web:WEB-3']);
    expect(() => parseBoard(text('APP-9'), 'b')).toThrow(/depends_on unknown id APP-9/);
    expect(() => parseBoard(text('Web:WEB-3'), 'b')).toThrow(/unknown id/);
  });

  it('resolves merged, waiting, unknown and a cycle, reading each board once', () => {
    const { m } = setup([
      item({ id: 'WEB-1', repo: 'org/web', status: 'merged' }),
      item({ id: 'WEB-2', repo: 'org/web', status: 'in_review' }),
      item({ id: 'WEB-3', repo: 'org/web', dependsOn: ['platform:PLAT-4'] }),
    ]);
    let reads = 0;
    const board: Board = {
      items: [
        waiting(['web:WEB-1'], 'PLAT-1'),
        waiting(['web:WEB-2'], 'PLAT-2'),
        waiting(['web:WEB-9', 'api:API-1'], 'PLAT-3'),
        waiting(['web:WEB-3'], 'PLAT-4'),
        waiting(['platform:PLAT-1'], 'PLAT-5'),
      ],
    };
    const deps = resolveExternalDeps(board, m, (p) => {
      reads++;
      return readProjectBoard(p);
    });
    expect(reads).toBe(1);
    expect(deps.get(depKey('PLAT-1', 'web:WEB-1'))).toEqual({ state: 'merged' });
    expect(deps.get(depKey('PLAT-2', 'web:WEB-2'))).toEqual({
      state: 'waiting',
      status: 'in_review',
    });
    expect(deps.get(depKey('PLAT-3', 'web:WEB-9'))?.state).toBe('unknown');
    expect(deps.get(depKey('PLAT-3', 'api:API-1'))?.state).toBe('unknown');
    expect(deps.get(depKey('PLAT-4', 'web:WEB-3'))).toEqual({ state: 'cycle' });
    expect(deps.get(depKey('PLAT-5', 'platform:PLAT-1'))?.state).toBe('unknown');
  });

  it('the planner launches only after the other item merged, and holds on an unreadable board', () => {
    const { m, web } = setup([
      item({ id: 'WEB-1', repo: 'org/web', status: 'merged' }),
      item({ id: 'WEB-2', repo: 'org/web', status: 'in_progress' }),
    ]);
    const cfg = config('org/platform');
    const cap = { ciBusy: 0, ciTotal: 4, hostLoad: 0, ok: true, hostOk: true };
    const board: Board = {
      items: [
        waiting(['web:WEB-1'], 'PLAT-1'),
        { ...waiting(['web:WEB-2'], 'PLAT-2'), type: 'docs' },
      ],
    };
    const plan = (b: Board) =>
      planAssignments(
        b,
        cfg,
        cap,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        resolveExternalDeps(b, m),
      );
    let p = plan(board);
    expect(p.assign.map((i) => i.id)).toEqual(['PLAT-1']);
    expect(p.blocked).toEqual([{ id: 'PLAT-2', reason: 'waiting on web:WEB-2' }]);
    // The other board cannot be read: fail closed.
    rmSync(join(web, '.studio', 'board.yaml'));
    p = plan(board);
    expect(p.assign).toEqual([]);
    expect(p.blocked.map((b) => b.reason)).toEqual([
      expect.stringMatching(/^dependency web:WEB-1 unreadable: project web: board.yaml/),
      expect.stringMatching(/^dependency web:WEB-2 unreadable/),
    ]);
    // Not resolved at all (no group): held too.
    p = planAssignments(board, cfg, cap, {});
    expect(p.assign).toEqual([]);
    expect(p.blocked[0]?.reason).toMatch(/unreadable: not checked/);
  });

  it('finds a cycle through any number of projects, and only a real one', () => {
    const main = project('platform', 'org/platform');
    const web = project('web', 'org/web', [
      item({ id: 'WEB-1', repo: 'org/web', dependsOn: ['api:API-1'] }),
      item({ id: 'WEB-2', repo: 'org/web', dependsOn: ['WEB-3'] }),
      item({ id: 'WEB-3', repo: 'org/web', dependsOn: ['api:API-2'] }),
    ]);
    const api = project('api', 'org/api', [
      item({ id: 'API-1', repo: 'org/api', dependsOn: ['platform:PLAT-1'] }),
      item({ id: 'API-2', repo: 'org/api', dependsOn: ['platform:PLAT-9'] }),
    ]);
    const owner = ownerConfigSchema.parse({
      groups: [
        {
          name: 'shop',
          main: 'platform',
          projects: [
            { id: 'platform', repo: 'org/platform', dir: main },
            { id: 'web', repo: 'org/web', dir: web },
            { id: 'api', repo: 'org/api', dir: api },
          ],
          reference: ['docs/**'],
        },
      ],
    });
    const m = membershipOf(main, config('org/platform'), owner) as Membership;
    const board: Board = {
      items: [
        waiting(['web:WEB-1'], 'PLAT-1'),
        waiting(['web:WEB-2'], 'PLAT-2'),
        { ...waiting([], 'PLAT-9'), status: 'merged' },
      ],
    };
    const deps = resolveExternalDeps(board, m);
    // PLAT-1 -> web:WEB-1 -> api:API-1 -> platform:PLAT-1: three projects round.
    expect(deps.get(depKey('PLAT-1', 'web:WEB-1'))).toEqual({ state: 'cycle' });
    // PLAT-2 -> WEB-2 -> WEB-3 -> API-2 -> PLAT-9 (merged): no cycle, just waiting.
    expect(deps.get(depKey('PLAT-2', 'web:WEB-2'))).toEqual({ state: 'waiting', status: 'ready' });
    const cap = { ciBusy: 0, ciTotal: 4, hostLoad: 0, ok: true, hostOk: true };
    const p = planAssignments(
      board,
      config('org/platform'),
      cap,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );
    expect(p.blocked).toEqual([
      { id: 'PLAT-1', reason: 'dependency cycle' },
      { id: 'PLAT-2', reason: 'waiting on web:WEB-2' },
    ]);
  });

  it('a board whose studio.yaml names another repository is not read', () => {
    const { m, web } = setup([item({ id: 'WEB-1', repo: 'org/web', status: 'merged' })]);
    writeFileSync(join(web, '.studio', 'studio.yaml'), studioYaml('org/evil'));
    const deps = resolveExternalDeps({ items: [waiting(['web:WEB-1'])] }, m);
    expect(deps.get(depKey('PLAT-1', 'web:WEB-1'))).toEqual({
      state: 'unreadable',
      why: 'project web: its studio.yaml names another repository',
    });
  });
});

describe('epics with member items', () => {
  const epic = {
    id: 'E-1',
    title: 'Checkout',
    status: 'open' as const,
    goal: 'g',
    acceptance: ['a'],
    memberItems: ['web:WEB-1', 'web:WEB-2'],
    history: [],
  };
  const board: Board = {
    items: [item({ id: 'PLAT-1', repo: 'org/platform', status: 'merged', epic: 'E-1' })],
    epics: [epic],
  };
  it('counts member items in the progress; unreadable ones as unknown', () => {
    const lookup = (s: Record<string, WorkItem['status'] | undefined>) => (ref: string) => s[ref];
    expect(epicProgress(board, 'E-1')).toMatchObject({ merged: 1, total: 1 });
    expect(
      epicProgress(board, 'E-1', lookup({ 'web:WEB-1': 'merged', 'web:WEB-2': 'in_review' })),
    ).toMatchObject({ merged: 2, total: 3 });
    expect(epicProgress(board, 'E-1', lookup({ 'web:WEB-1': 'merged' }))).toMatchObject({
      merged: 2,
      total: 3,
      unknown: 1,
    });
    const rows = epicRows(board, lookup({ 'web:WEB-1': 'merged' }));
    expect(rows[0]?.members).toEqual([
      { ref: 'web:WEB-1', status: 'merged' },
      { ref: 'web:WEB-2', status: 'unknown' },
    ]);
  });
  it('moves to accepting only when member items are merged and readable', () => {
    const now = new Date('2026-11-06T10:00:00Z');
    const all = (ref: string) =>
      ref === 'web:WEB-1' || ref === 'web:WEB-2' ? 'merged' : undefined;
    expect(settleEpics(board, 't', now).moved).toEqual([]);
    expect(settleEpics(board, 't', now, () => undefined).moved).toEqual([]);
    expect(
      settleEpics(board, 't', now, (r) => (r === 'web:WEB-1' ? 'merged' : 'ready')).moved,
    ).toEqual([]);
    expect(settleEpics(board, 't', now, all).moved).toEqual([
      { epic: 'E-1', from: 'open', to: 'accepting' },
    ]);
  });
  it('epic edit --member replaces the list and refuses another form; the board keeps it', () => {
    const e = editEpic(board, 'E-1', { members: ['web:WEB-7'] });
    expect(e.board.epics?.[0]?.memberItems).toEqual(['web:WEB-7']);
    expect(e.changed).toEqual(['member_items']);
    expect(() => editEpic(board, 'E-1', { members: ['WEB-7'] })).toThrow(/<project>:<id>/);
    const dir = project('platform', 'org/platform');
    saveBoard(dir, e.board);
    expect(loadBoard(dir).epics?.[0]?.memberItems).toEqual(['web:WEB-7']);
    expect(editEpic(e.board, 'E-1', { members: [] }).board.epics?.[0]?.memberItems).toBeUndefined();
  });
  it('memberStatusLookup reads member boards from the main project only', () => {
    const main = project('platform', 'org/platform');
    const web = project('web', 'org/web', [
      item({ id: 'WEB-1', repo: 'org/web', status: 'queued' }),
    ]);
    const owner = groupOf(main, web);
    const asMain = memberStatusLookup(membershipOf(main, config('org/platform'), owner));
    expect(asMain('web:WEB-1')).toBe('queued');
    expect(asMain('web:WEB-2')).toBeUndefined();
    expect(asMain('platform:PLAT-1')).toBeUndefined();
    const asMember = memberStatusLookup(membershipOf(web, config('org/web'), owner));
    expect(asMember('web:WEB-1')).toBeUndefined();
  });
});

/** The real git port, counting its calls. */
function countingPorts(): { ports: Ports; calls: string[][] } {
  const real = realPorts();
  const calls: string[][] = [];
  const ports = {
    ...real,
    git: {
      run: (cwd: string, args: string[], opts?: { timeoutMs?: number }) => {
        calls.push(args);
        return real.git.run(cwd, args, opts);
      },
      ...(real.git.blob === undefined ? {} : { blob: real.git.blob.bind(real.git) }),
    },
  } as Ports;
  return { ports, calls };
}

describe('the reference excerpt', () => {
  const files = {
    'docs/contracts/api.md': '# API\nGET /orders\n',
    'docs/adr/0001-money.md': 'Money is integer cents.\n',
    'docs/glossary.md': 'Order: what a customer buys.\n',
    'docs/contracts/.env': 'SECRET=1\n',
    'docs/contracts/big.md': `${'x'.repeat(20 * 1024)}\n`,
    'src/server.ts': 'export {}\n',
  };
  const setup = (extra: Record<string, unknown> = {}) => {
    const main = mainWithOrigin(files);
    const web = project('web', 'org/web');
    const owner = groupOf(main.dir, web, extra);
    const m = membershipOf(web, config('org/web'), owner) as Membership;
    const state = join(root, `state-${n++}`);
    mkdirSync(state, { recursive: true });
    return { main, web, m, state };
  };

  it('copies only listed paths at origin/main, never a secret-like name, within the cap', async () => {
    const { m, state, main } = setup({ referenceMaxKib: 16 });
    const { ports } = countingPorts();
    const ref = await readReference(m, state, ports);
    expect(ref.sha).toBe(git(main.dir, 'rev-parse', 'origin/main').trim());
    expect(ref.files.map((f) => f.path)).toEqual([
      'docs/adr/0001-money.md',
      'docs/contracts/api.md',
      'docs/glossary.md',
    ]);
    expect(ref.omitted).toEqual([
      { path: 'docs/contracts/.env', why: 'secret-like name' },
      { path: 'docs/contracts/big.md', why: 'size cap' },
    ]);
    // Uncommitted work in the main checkout never counts: only origin/main does.
    writeFileSync(join(main.dir, 'docs', 'glossary.md'), 'local edit\n');
    const again = await readReference(m, state, ports);
    expect(again.files.find((f) => f.path === 'docs/glossary.md')?.content).toBe(
      'Order: what a customer buys.\n',
    );
  });

  it('is cached per commit and settings; a new commit reads again', async () => {
    const { m, state, main } = setup();
    const { ports, calls } = countingPorts();
    await readReference(m, state, ports);
    const first = calls.length;
    await readReference(m, state, ports);
    // Only fetch and rev-parse the second time.
    expect(calls.length - first).toBe(2);
    main.push({ 'docs/contracts/api.md': '# API\nGET /orders/v2\n' });
    const ref = await readReference(m, state, ports);
    expect(ref.files.find((f) => f.path === 'docs/contracts/api.md')?.content).toContain('v2');
  });

  it('never copies a path with a secret-like segment', async () => {
    const main = mainWithOrigin({
      'docs/contracts/api.md': 'a\n',
      'docs/contracts/secrets/token.md': 'x\n',
      'docs/credentials/notes.md': 'x\n',
      'docs/adr/.envrc': 'x\n',
      'docs/adr/deploy.tfvars': 'x\n',
      'docs/adr/app.keystore': 'x\n',
      'docs/adr/.pypirc': 'x\n',
    });
    const web = project('web', 'org/web');
    const owner = groupOf(main.dir, web);
    const g = owner.groups?.[0];
    if (g) g.reference = ['docs/**'];
    const m = membershipOf(web, config('org/web'), owner) as Membership;
    const state = join(root, `state-${n++}`);
    mkdirSync(state, { recursive: true });
    const ref = await readReference(m, state, countingPorts().ports);
    expect(ref.files.map((f) => f.path)).toEqual(['docs/contracts/api.md']);
    const why = Object.fromEntries(ref.omitted.map((o) => [o.path, o.why]));
    for (const p of [
      'docs/contracts/secrets/token.md',
      'docs/credentials/notes.md',
      'docs/adr/.envrc',
      'docs/adr/deploy.tfvars',
      'docs/adr/app.keystore',
      'docs/adr/.pypirc',
    ]) {
      expect(why[p]).toBe('secret-like name');
    }
    expect(referenceCollisions(ref)).toEqual([]);
  });

  it('copies neither of two paths that differ only in case, and names them for the lead', async () => {
    const main = mainWithOrigin({ 'docs/glossary.md': 'g\n' });
    // A second spelling, added to the index directly: a case-insensitive disk cannot hold both.
    const blob = git(main.dir, 'hash-object', '-w', '--stdin').trim();
    git(main.dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},docs/Glossary.md`);
    git(main.dir, 'commit', '-q', '-m', 'case');
    git(main.dir, 'push', '-q', 'origin', 'main');
    const web = project('web', 'org/web');
    const m = membershipOf(web, config('org/web'), groupOf(main.dir, web)) as Membership;
    const state = join(root, `state-${n++}`);
    mkdirSync(state, { recursive: true });
    const ref = await readReference(m, state, countingPorts().ports);
    expect(ref.files).toEqual([]);
    expect(ref.omitted).toEqual([
      { path: 'docs/Glossary.md', why: 'case collision with docs/glossary.md' },
      { path: 'docs/glossary.md', why: 'case collision with docs/Glossary.md' },
    ]);
    expect(referenceCollisions(ref)).toEqual(['docs/Glossary.md', 'docs/glossary.md']);
  });

  it('finds case collisions of files and folders', () => {
    expect(caseCollisions(['a/b.md', 'a/c.md'])).toEqual(new Map());
    expect(caseCollisions(['Docs/a.md', 'docs/b.md'])).toEqual(
      new Map([
        ['docs/b.md', 'Docs/a.md'],
        ['Docs/a.md', 'docs/b.md'],
      ]),
    );
    expect([...caseCollisions(['docs', 'Docs/x.md']).keys()].sort()).toEqual(['Docs/x.md', 'docs']);
  });

  it('refuses when the main project cannot be fetched', async () => {
    const { m, state, main } = setup();
    rmSync(`${main.dir}.git`, { recursive: true, force: true });
    await expect(readReference(m, state, countingPorts().ports)).rejects.toThrow(
      /cannot fetch origin main/,
    );
  });

  it('writes the copies beside the brief with an index marking them as reference', async () => {
    const { m, state } = setup();
    const ref = await readReference(m, state, countingPorts().ports);
    const b = writeReference(state, 'WEB-4', ref);
    expect(readFileSync(join(b.dir, 'docs', 'contracts', 'api.md'), 'utf8')).toContain(
      'GET /orders',
    );
    const index = readFileSync(b.index, 'utf8');
    expect(index).toContain(`at ${ref.sha}`);
    expect(index).toContain('Read only');
    expect(index).toContain('docs/contracts/.env: secret-like name');
    const brief = referenceBrief(b).join('\n');
    expect(brief).toContain('read only');
    expect(brief).toContain('never edit them here');
    expect(brief).toContain(b.dir);
  });
});

describe('contract changes', () => {
  const setup = (extra: Record<string, unknown> = {}, narrow?: string[]) => {
    const main = mainWithOrigin({
      'docs/contracts/api.md': 'v1\n',
      'docs/contracts/events.md': 'e1\n',
      'docs/adr/1.md': 'adr\n',
    });
    const web = project('web', 'org/web', [item({ id: 'WEB-1', repo: 'org/web' })]);
    const raw = groupOf(main.dir, web, { contracts: ['docs/contracts/**'], ...extra });
    if (narrow !== undefined) {
      const g = raw.groups?.[0];
      if (g)
        g.projects = g.projects.map((p: GroupProject) =>
          p.id === 'web' ? { ...p, contracts: narrow } : p,
        );
    }
    const m = membershipOf(web, config('org/web'), raw) as Membership;
    const state = join(root, `state-${n++}`);
    mkdirSync(state, { recursive: true });
    let saves = 0;
    const run = (crashAfterBoard = false) =>
      checkContracts({
        m,
        config: config('org/web'),
        stateRoot: state,
        ports: realPorts(),
        prefix: () => 'WEB',
        locked: async (fn) => fn(),
        loadBoard: () => loadBoard(web),
        saveBoard: (b) => {
          saves++;
          saveBoard(web, b);
          if (crashAfterBoard) throw new Error('crash');
        },
      });
    return { main, web, state, run, m, saves: () => saves };
  };
  const checks = (web: string) =>
    loadBoard(web).items.filter((i) =>
      (i.notes ?? []).some((x) => x.startsWith('contract-change: ')),
    );

  it('the first look records a baseline and adds nothing', async () => {
    const { web, run, state } = setup();
    expect(await run()).toMatchObject({ baseline: true });
    expect(checks(web)).toEqual([]);
    expect(existsSync(join(state, CONTRACTS_FILE))).toBe(true);
    expect(await run()).not.toHaveProperty('changed');
  });

  it('a change adds one research item, once; another change adds the next', async () => {
    const { main, web, run, state } = setup();
    await run();
    main.push({ 'docs/contracts/api.md': 'v2\n', 'docs/adr/1.md': 'adr 2\n' });
    const r = await run();
    expect(r?.changed).toEqual(['docs/contracts/api.md']);
    expect(r?.item).toBe('WEB-2');
    const [it1] = checks(web);
    expect(it1).toMatchObject({ id: 'WEB-2', type: 'research', role: 'builder', status: 'ready' });
    expect(it1?.title).toMatch(
      /^Check the contract change of platform at [0-9a-f]{12} \(1 file\)$/,
    );
    // Studio's own words in the item; the paths only in the change file, for the index as data.
    expect(JSON.stringify(it1)).not.toContain('docs/contracts/api.md');
    expect(it1?.dod[0]).toBe(
      'Each file the reference index beside the brief lists as changed by this contract change is read',
    );
    expect(it1?.notes?.[0]).toMatch(
      /^contract-change: shop@[0-9a-f]{16}\.\.[0-9a-f]{16}@[0-9a-f]{12}$/,
    );
    const change = readContractChange(state, 'WEB-2');
    expect(change?.changed).toEqual(['docs/contracts/api.md']);
    expect(await run()).not.toHaveProperty('item');
    expect(checks(web)).toHaveLength(1);
    main.push({ 'docs/contracts/events.md': 'e2\n' });
    expect((await run())?.item).toBe('WEB-3');
  });

  it('a change, its revert and the change again each get their item', async () => {
    const { main, web, run } = setup();
    await run();
    main.push({ 'docs/contracts/api.md': 'v2\n' });
    expect((await run())?.item).toBe('WEB-2');
    main.push({ 'docs/contracts/api.md': 'v1\n' });
    expect((await run())?.item).toBe('WEB-3');
    main.push({ 'docs/contracts/api.md': 'v2\n' });
    expect((await run())?.item).toBe('WEB-4');
    expect(checks(web)).toHaveLength(3);
  });

  it('the index of a check item lists the changed files as data', async () => {
    const { main, run, state, m } = setup();
    await run();
    main.push({ 'docs/contracts/api.md': 'v2\n' });
    await run();
    const ref = await readReference(m, state, realPorts());
    const b = writeReference(state, 'WEB-2', ref, readContractChange(state, 'WEB-2'));
    const index = readFileSync(b.index, 'utf8');
    expect(index).toMatch(
      /## Changed by the contract change of this item \([0-9a-f]{12}\.\.[0-9a-f]{12}\)/,
    );
    expect(index).toContain('```text\ndocs/contracts/api.md\n```');
    expect(referenceBrief(b).join('\n')).toContain('This item checks a contract change');
  });

  it('a crash between the board and the record never adds a second item', async () => {
    const { main, web, run } = setup();
    await run();
    main.push({ 'docs/contracts/api.md': 'v3\n' });
    await expect(run(true)).rejects.toThrow('crash');
    expect(checks(web)).toHaveLength(1);
    const r = await run();
    expect(r?.item).toBeUndefined();
    expect(r?.changed).toEqual(['docs/contracts/api.md']);
    expect(checks(web)).toHaveLength(1);
  });

  it('a member narrowed to some contracts is not affected by the others', async () => {
    const { main, web, run } = setup({}, ['docs/contracts/events.md']);
    await run();
    main.push({ 'docs/contracts/api.md': 'v2\n' });
    expect(await run()).not.toHaveProperty('changed');
    expect(checks(web)).toEqual([]);
  });

  it('new globs in the owner config set a new baseline, not a change', async () => {
    const a = setup();
    await a.run();
    const record = JSON.parse(readFileSync(join(a.state, CONTRACTS_FILE), 'utf8'));
    writeFileSync(join(a.state, CONTRACTS_FILE), JSON.stringify({ ...record, scope: 'old' }));
    a.main.push({ 'docs/contracts/api.md': 'v9\n' });
    expect(await a.run()).toMatchObject({ baseline: true });
    expect(checks(a.web)).toEqual([]);
  });

  it('the main project never checks itself, and an unreadable main changes nothing', async () => {
    const { main, web, run, state } = setup();
    await run();
    rmSync(`${main.dir}.git`, { recursive: true, force: true });
    await expect(run()).rejects.toThrow(/cannot fetch origin main/);
    expect(checks(web)).toEqual([]);
    const owner = groupOf(main.dir, web);
    const asMain = membershipOf(main.dir, config('org/platform'), owner) as Membership;
    expect(
      await checkContracts({
        m: asMain,
        config: config('org/platform'),
        stateRoot: state,
        ports: realPorts(),
        prefix: () => 'PLAT',
        locked: async (fn) => fn(),
        loadBoard: () => loadBoard(main.dir),
        saveBoard: () => {
          throw new Error('never');
        },
      }),
    ).toBeUndefined();
  });
});

describe('the group at a glance', () => {
  const p = { id: 'web', repo: 'org/web', dir: '/x' };
  it('counts a project from its state and keeps decisions to item and code', () => {
    const row = groupRowFromState(
      p,
      { main: 'platform', self: 'platform' },
      JSON.stringify({
        updatedAt: '2026-11-06T10:00:00Z',
        items: [
          { id: 'WEB-1', stage: 'building' },
          { id: 'WEB-2', stage: 'review', wait: { code: 'checks_pending' } },
          { id: 'WEB-3', stage: 'ready' },
          { id: 'WEB-4', stage: 'blocked' },
          { id: 'WEB-5', stage: 'blocked' },
        ],
        needsLead: [
          { item: 'WEB-5', code: 'merge_failed', reason: 'crew text here' },
          { item: '<b>', code: 'x' },
        ],
      }),
      'abc',
    );
    expect(row).toEqual({
      id: 'web',
      repo: 'org/web',
      main: false,
      self: false,
      stateDir: 'abc',
      updatedAt: '2026-11-06T10:00:00Z',
      counts: { decisions: 1, running: 1, waiting: 1, ready: 1, blocked: 1 },
      decisions: [{ item: 'WEB-5', code: 'merge_failed' }],
    });
    expect(JSON.stringify(row)).not.toContain('crew text');
  });
  it('names a missing or unreadable state instead of failing', () => {
    expect(groupRowFromState(p, { main: 'web', self: 'web' }, undefined, undefined)).toMatchObject({
      main: true,
      self: true,
      problem: 'no state yet',
    });
    expect(groupRowFromState(p, { main: 'x', self: 'y' }, '{', 'd').problem).toBe(
      'state unreadable',
    );
  });
  it('prints one line per project and the decisions under it', () => {
    const text = formatGroupRows('shop', [
      {
        id: 'platform',
        repo: 'org/platform',
        main: true,
        self: true,
        counts: { decisions: 1, running: 2, waiting: 0, ready: 3, blocked: 0 },
        decisions: [{ item: 'PLAT-7', code: 'changes_requested' }],
      },
      { id: 'web', repo: 'org/web', main: false, self: false, problem: 'no state yet' },
    ]);
    expect(text).toContain('platform (main)');
    expect(text).toMatch(/web\s+org\/web\s+\?\s+\?/);
    expect(text).toContain('Decision needed\n  platform PLAT-7 changes_requested');
  });
});
