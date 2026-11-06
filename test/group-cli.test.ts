import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard, saveBoard, type WorkItem } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { stateRootFor } from '../src/paths.js';
import { realPorts } from '../src/ports.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-group-cli-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const yaml = (repo: string) => `studio: 1
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
`;

const item = (id: string, repo: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: 'A thing',
  type: 'fix',
  role: 'builder',
  repo,
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

function world() {
  const home = join(root, 'home');
  const project = (name: string, repo: string, items: WorkItem[]) => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.studio'), { recursive: true });
    writeFileSync(join(dir, '.studio', 'studio.yaml'), yaml(repo));
    saveBoard(dir, { items });
    return dir;
  };
  const main = project('platform', 'org/platform', []);
  const web = project('web', 'org/web', [item('WEB-1', 'org/web', { status: 'in_review' })]);
  saveBoard(main, {
    items: [item('PLAT-1', 'org/platform', { status: 'merged', epic: 'E-1' })],
    epics: [
      { id: 'E-1', title: 'Checkout', status: 'open', goal: 'g', acceptance: ['a'], history: [] },
    ],
  });
  mkdirSync(join(home, '.config', 'studio'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'studio', 'config.yaml'),
    [
      'groups:',
      '  - name: shop',
      '    main: platform',
      '    projects:',
      `      - { id: platform, repo: org/platform, dir: ${main} }`,
      `      - { id: web, repo: org/web, dir: ${web} }`,
      '    reference: ["docs/**"]',
      '',
    ].join('\n'),
  );
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  // The member's state, as its `studio state` wrote it.
  const webRoot = stateRootFor(web, { homedir: home, env });
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(
    join(webRoot, 'state.json'),
    JSON.stringify({
      updatedAt: '2026-11-06T10:00:00Z',
      items: [{ id: 'WEB-1', stage: 'review' }],
      needsLead: [{ item: 'WEB-1', code: 'merge_failed', reason: 'merge failed: x' }],
    }),
  );
  const cli = async (dir: string, ...args: string[]) => {
    let out = '';
    let err = '';
    const code = await runCli(['--project', dir, ...args], {
      ports: realPorts(),
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      env,
      homedir: home,
      cwd: dir,
      isTerminal: false,
    });
    return { code, out, err };
  };
  return { main, web, cli };
}

describe('the group on the command line', () => {
  const w = world();

  it('studio status --group prints one line per project and the decisions', async () => {
    const r = await w.cli(w.main, 'status', '--group', 'shop');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Group shop\n/);
    expect(r.out).toContain('platform (main)');
    expect(r.out).toMatch(/web\s+org\/web\s+1\s+0\s+0\s+0\s+0/);
    expect(r.out).toContain('  web WEB-1 merge_failed');
    const j = await w.cli(w.main, '--json', 'status', '--group', 'shop');
    expect(JSON.parse(j.out)).toMatchObject({
      group: 'shop',
      main: 'platform',
      projects: [
        { id: 'platform', main: true, self: true, problem: 'no state yet' },
        { id: 'web', main: false, self: false, counts: { decisions: 1 } },
      ],
    });
    expect((await w.cli(w.main, 'status', '--group', 'nope')).code).toBe(1);
  });

  it('epic edit --member adds member items in the main project only, and epic show lists them', async () => {
    const r = await w.cli(w.main, 'epic', 'edit', 'E-1', '--member', 'web:WEB-1');
    expect(r.code).toBe(0);
    expect(loadBoard(w.main).epics?.[0]?.memberItems).toEqual(['web:WEB-1']);
    const show = await w.cli(w.main, 'epic', 'show', 'E-1');
    expect(show.out).toMatch(/E-1\s+open\s+1\/2/);
    expect(show.out).toMatch(/web:WEB-1\s+in_review/);
    // Not a project of the group, this project itself, or from a member: refused.
    expect((await w.cli(w.main, 'epic', 'edit', 'E-1', '--member', 'api:API-1')).code).toBe(1);
    expect((await w.cli(w.main, 'epic', 'edit', 'E-1', '--member', 'platform:PLAT-1')).code).toBe(
      1,
    );
    const fromMember = await w.cli(w.web, 'epic', 'edit', 'E-1', '--member', 'platform:PLAT-1');
    expect(fromMember.code).toBe(1);
  });
});
