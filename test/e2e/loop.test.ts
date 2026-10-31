import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CliDeps, runCli } from '../../src/cli.js';
import { crewSessionId } from '../../src/crew.js';
import { stateRootFor } from '../../src/paths.js';
import { type Gh, type Ports, realPorts } from '../../src/ports.js';

// Simplifications of this test, on purpose:
// - The fake claude ignores the sandbox settings (they are only written, never enforced here).
// - The fake claude leaves its report untracked in the clone (see fake-claude.mjs).
// - The fake gh answers from the clone's real HEAD; the harness is not the control room.

const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const IDENT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', [...IDENT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const STUDIO_YAML = `studio: 1
primary_repo: org/app
repos: [org/app]
allow_ambient_credentials: true
ci:
  provider: github
  runners: github-hosted
  capacity: { total: 8, merge_max_busy: 8, check_twice_seconds: 0 }
merge:
  strategy: studio-queue
roles:
  builder: { model: sonnet, wip: 2 }
  researcher: { model: sonnet, wip: 2 }
`;

const item = (id: string, role: string, type: string, extra: string[] = [], priority = 1): string =>
  [
    `  - id: ${id}`,
    `    title: Work on ${id}`,
    `    type: ${type}`,
    `    role: ${role}`,
    '    repo: org/app',
    '    size: S',
    `    priority: ${priority}`,
    '    status: ready',
    '    dod: [It works]',
    ...extra,
  ].join('\n');

const BOARD_YAML = `items:\n${[
  item('APP-1', 'builder', 'feature', ['    plan: docs/plan.md']),
  item('APP-2', 'researcher', 'research', [], 2),
  item('APP-3', 'builder', 'fix', ['    depends_on: [APP-1]'], 3),
].join('\n')}\n`;

type Json = Record<string, unknown>;

describe('crew loop with a fake claude', () => {
  let root: string;
  let project: string;
  let stateRoot: string;
  let merged = false;
  const out: string[] = [];
  const err: string[] = [];
  let deps: CliDeps;
  let ports: Ports;

  const cloneOf = (id: string) => join(stateRoot, 'clones', id);

  // Fake GitHub: answers what the control room asks, taking the PR head from the real clone.
  const fakeGh: Gh = {
    async api() {
      return '0';
    },
    async run(args) {
      const reply = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      if (args[0] === 'pr' && args[1] === 'checks') {
        return reply(JSON.stringify([{ name: 'ci', bucket: 'pass' }]));
      }
      if (args[0] === 'pr' && args[1] === 'update-branch') return reply('');
      if (args[0] === 'pr' && args[1] === 'merge') {
        merged = true;
        return reply('');
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const pr = Number(args[2]);
        const id = `APP-${pr}`;
        if (args.includes('--jq')) return reply('2026-10-31T08:00:00Z');
        return reply(
          JSON.stringify({
            headRefOid: git(cloneOf(id), 'rev-parse', 'HEAD'),
            headRefName: `studio/${id}`,
            isCrossRepository: false,
            headRepository: { name: 'app' },
            headRepositoryOwner: { login: 'org' },
            state: merged && pr === 1 ? 'MERGED' : 'OPEN',
            mergeable: 'MERGEABLE',
            mergeCommit: { oid: 'a'.repeat(40) },
          }),
        );
      }
      return { code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    },
  };

  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await runCli(['--project', project, ...argv], deps);
    if (code !== 0) throw new Error(`studio ${argv.join(' ')} exited ${code}: ${err.join('')}`);
    return out.join('');
  };
  const json = async (...argv: string[]) => JSON.parse(await run(...argv)) as Json;
  const ids = (list: unknown) => (list as { id: string }[]).map((i) => i.id).sort();
  const statusOf = async (id: string) =>
    (JSON.parse(await run('--json', 'board')) as { id: string; status: string }[]).find(
      (i) => i.id === id,
    )?.status;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-e2e-')));
    const origin = join(root, 'origin.git');
    project = join(root, 'project');
    const home = join(root, 'home');
    mkdirSync(home);
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(root, 'clone', origin, project);
    git(project, 'checkout', '-b', 'main');
    mkdirSync(join(project, '.studio'));
    writeFileSync(join(project, '.studio', 'studio.yaml'), STUDIO_YAML);
    writeFileSync(join(project, '.studio', 'board.yaml'), BOARD_YAML);
    writeFileSync(join(project, 'README.md'), 'fixture\n');
    git(project, 'add', 'README.md', '.studio/studio.yaml', '.studio/board.yaml');
    git(project, 'commit', '-m', 'fixture');
    git(project, 'push', 'origin', 'main');
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'),
    };
    ports = { ...realPorts(FAKE_CLAUDE), gh: fakeGh };
    deps = {
      ports,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env,
      homedir: home,
      cwd: root,
    };
    stateRoot = stateRootFor(project, { env, homedir: home });
  });

  it('plans, launches, collects, merges and unblocks the dependent item', async () => {
    const first = await json('plan');
    expect(ids(first.assign)).toEqual(['APP-1', 'APP-2']);
    expect(JSON.stringify([first.blocked, first.deferred])).toContain('APP-3');

    const pids: number[] = [];
    for (const id of ['APP-1', 'APP-2']) pids.push((await json('launch', id)).pid as number);

    const deadline = Date.now() + 15_000;
    while (pids.some((p) => ports.claude.alive(p))) {
      if (Date.now() > deadline) throw new Error('fake claude sessions did not exit in time');
      await new Promise((r) => setTimeout(r, 50));
    }

    for (const id of ['APP-1', 'APP-2']) {
      expect((await json('collect', id)).status).toBe('in_review');
    }
    expect(await statusOf('APP-3')).toBe('ready');

    expect(readFileSync(join(stateRoot, 'logs', 'APP-1.jsonl'), 'utf8')).toContain(
      '"subtype":"init"',
    );
    expect(crewSessionId(stateRoot, 'APP-1')).toBe('fake-APP-1');

    expect((await json('plan')).assign).toEqual([]);

    await run('queue', 'add', 'org/app#1');
    expect((await json('queue', 'run')).merged).toBe(1);
    expect(await statusOf('APP-1')).toBe('merged');

    expect(ids((await json('plan')).assign)).toEqual(['APP-3']);
  }, 30_000);
});
