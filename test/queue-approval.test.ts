import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Gh } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import { approvalProblem } from '../src/queue.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

let root: string;
let project: string;
let approved: string;
let onBase: string;
let honest: string;
let evil: string;
let conflictSide: string;
let conflictOnBase: string;
let conflictResolved: string;

const commitFile = (dir: string, file: string, text: string): string => {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-approval-')));
  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const work = join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  const first = commitFile(work, 'base.txt', 'one\ntwo\n');
  git(work, 'checkout', '-q', '-b', 'pr');
  approved = commitFile(work, 'a.txt', 'reviewed\n');
  git(work, 'checkout', '-q', 'main');
  onBase = commitFile(work, 'm.txt', 'from main\n');
  git(work, 'push', '-q', 'origin', 'main');
  // What update-branch makes: the base merged into the approved head, nothing else.
  git(work, 'checkout', '-q', 'pr');
  git(work, 'merge', '-q', '--no-edit', 'main');
  honest = git(work, 'rev-parse', 'HEAD');
  // The same parents around a tree with one more file, as the commits API allows.
  writeFileSync(join(work, 'evil.txt'), 'never reviewed\n');
  git(work, 'add', 'evil.txt');
  const tree = git(work, 'write-tree');
  evil = git(work, 'commit-tree', tree, '-p', approved, '-p', onBase, '-m', 'merge');
  git(work, 'rm', '-q', '--cached', 'evil.txt');
  rmSync(join(work, 'evil.txt'));
  // A conflict someone resolved by hand.
  git(work, 'checkout', '-q', '-b', 'side', first);
  conflictSide = commitFile(work, 'base.txt', 'side\ntwo\n');
  git(work, 'checkout', '-q', 'main');
  conflictOnBase = commitFile(work, 'base.txt', 'main\ntwo\n');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', 'side');
  try {
    git(work, 'merge', '-q', '--no-edit', 'main');
  } catch {
    writeFileSync(join(work, 'base.txt'), 'resolved\ntwo\n');
    git(work, 'add', 'base.txt');
    git(work, 'commit', '-q', '--no-edit');
  }
  conflictResolved = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', `${honest}:refs/heads/pr`);
  git(work, 'push', '-q', 'origin', `${evil}:refs/heads/evil`);
  git(work, 'push', '-q', 'origin', `${conflictResolved}:refs/heads/side`);
  project = join(root, 'project');
  git(root, 'clone', '-q', '--no-checkout', '--single-branch', '--branch', 'main', origin, project);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const target = { repo: 'org/app', pr: 5 };
const checkout = () => ({ dir: project, remote: 'origin' });

type Reply = { code?: number; stdout?: string };
const signed = (parents: string[], over: Record<string, unknown> = {}): Reply => ({
  stdout: JSON.stringify({
    parents: parents.map((sha) => ({ sha })),
    committer: { login: 'web-flow' },
    commit: { verification: { verified: true } },
    ...over,
  }),
});

/** A gh that says what the scripted commit is, what the live base is and how far the parent is. */
const ghFor = (o: { head?: string; commit?: Reply; base?: Reply | string; status?: string }) => {
  const calls: string[] = [];
  const gh: Gh = {
    api: async () => '',
    run: async (args) => {
      const line = args.join(' ');
      calls.push(line);
      const reply = (r: Reply) => ({ code: r.code ?? 0, stdout: r.stdout ?? '', stderr: '' });
      if (line.endsWith('--json baseRefName')) {
        const b = o.base ?? 'main';
        return reply(typeof b === 'string' ? { stdout: JSON.stringify({ baseRefName: b }) } : b);
      }
      if (line.startsWith('api repos/org/app/commits/')) return reply(o.commit ?? { code: 1 });
      if (line.startsWith('api repos/org/app/compare/')) {
        return reply({ stdout: JSON.stringify({ status: o.status ?? 'behind' }) });
      }
      throw new Error(`unscripted: ${line}`);
    },
  };
  return { gh, calls };
};

const ask = (
  o: Parameters<typeof ghFor>[0],
  approval: { head?: string; base?: string },
  head: string,
) => approvalProblem({ gh: ghFor(o).gh, git: realPorts().git }, checkout(), target, approval, head);

const approval = () => ({ head: approved, base: 'main' });

describe('approvalProblem: what was approved', () => {
  it('no approval, or one with no base, is a problem', async () => {
    expect(await ask({}, {}, approved)).toMatch(/no approval/);
    expect(await ask({}, { head: approved }, approved)).toMatch(/no approval/);
    expect(await ask({}, { base: 'main' }, approved)).toMatch(/no approval/);
  });
  it('the approved head on the approved base is fine, in any case', async () => {
    expect(await ask({}, approval(), approved)).toBeUndefined();
    expect(await ask({}, { head: approved.toUpperCase(), base: 'main' }, approved)).toBeUndefined();
  });
});

describe('approvalProblem: the base', () => {
  it('a retargeted pull request needs a new review, also on the approved head', async () => {
    expect(await ask({ base: 'release' }, approval(), approved)).toMatch(/base.*review it again/);
  });
  it.each<[string, Reply]>([
    ['a gh failure', { code: 1 }],
    ['unreadable output', { stdout: 'nope' }],
    ['no base', { stdout: '{}' }],
  ])('%s when reading the base refuses', async (_n, base) => {
    expect(await ask({ base }, approval(), approved)).toMatch(/review it again/);
  });
  it('the second parent is compared with the approved base', async () => {
    const { gh, calls } = ghFor({ commit: signed([approved, onBase]) });
    await approvalProblem({ gh, git: realPorts().git }, checkout(), target, approval(), honest);
    expect(calls).toContain(`api repos/org/app/compare/main...${onBase}`);
  });
  it('a branch name with special characters stays one path', async () => {
    const { gh, calls } = ghFor({
      commit: signed([approved, onBase]),
      base: 'rel/a#b',
    });
    await approvalProblem(
      { gh, git: realPorts().git },
      checkout(),
      target,
      { head: approved, base: 'rel/a#b' },
      honest,
    );
    expect(calls).toContain(`api repos/org/app/compare/rel/a%23b...${onBase}`);
  });
  it.each(['diverged', 'ahead'])('a second parent that is %s refuses', async (status) => {
    const o = { commit: signed([approved, onBase]), status };
    expect(await ask(o, approval(), honest)).toMatch(/review it again/);
  });
});

describe('approvalProblem: a commit on top of the approved head, with real git', () => {
  it('the true merge of the base passes', async () => {
    expect(await ask({ commit: signed([approved, onBase]) }, approval(), honest)).toBeUndefined();
  });
  it('the same parents around another tree refuse, though GitHub signed it', async () => {
    expect(await ask({ commit: signed([approved, onBase]) }, approval(), evil)).toMatch(
      /review it again/,
    );
  });
  it('a conflict resolved by hand refuses', async () => {
    const a = { head: conflictSide, base: 'main' };
    expect(
      await ask({ commit: signed([conflictSide, conflictOnBase]) }, a, conflictResolved),
    ).toMatch(/review it again/);
  });
  it('a chain of two updates refuses: the first parent is not the approved head', async () => {
    expect(await ask({ commit: signed([honest, onBase]) }, approval(), honest)).toMatch(
      /review it again/,
    );
  });
  it('a head git cannot fetch refuses and says so, not that a review is due', async () => {
    const gone = 'f'.repeat(40);
    const why = await ask({ commit: signed([approved, onBase]) }, approval(), gone);
    expect(why).toMatch(/cannot fetch/);
    expect(why).not.toMatch(/review it again/);
  });
  const withGit = (run: (args: string[]) => string) =>
    approvalProblem(
      {
        gh: ghFor({ commit: signed([approved, onBase]) }).gh,
        git: { run: async (_c, a) => run(a) },
      },
      checkout(),
      target,
      approval(),
      honest,
    );
  const failing = (code: number, stderr: string) => {
    throw new Error(`git x failed (${code}): ${stderr}`);
  };
  it('a git too old for merge-tree --write-tree says so, and refuses', async () => {
    const why = await withGit((a) =>
      a.includes('merge-tree') ? failing(129, 'usage: git merge-tree') : '',
    );
    expect(why).toMatch(/git 2\.38/);
    expect(why).not.toMatch(/review it again/);
  });
  it('a conflict needs a new review', async () => {
    const why = await withGit((a) => (a.includes('merge-tree') ? failing(1, 'conflict') : ''));
    expect(why).toMatch(/review it again/);
  });
  it('a tree that cannot be read says so, and refuses', async () => {
    const why = await withGit((a) =>
      a.includes('--verify') ? failing(128, 'bad object') : a.includes('merge-tree') ? 't' : '',
    );
    expect(why).toMatch(/cannot read/);
  });
  it('the git steps pass a timeout', async () => {
    const seen: (number | undefined)[] = [];
    await approvalProblem(
      {
        gh: ghFor({ commit: signed([approved, onBase]) }).gh,
        git: {
          run: async (_c, _a, o) => {
            seen.push(o?.timeoutMs);
            return 't';
          },
        },
      },
      checkout(),
      target,
      approval(),
      honest,
    );
    expect(seen).toHaveLength(3);
    expect(seen.every((t) => typeof t === 'number' && t > 0)).toBe(true);
  });
  it.each<[string, Reply]>([
    ['one parent', signed([approved])],
    ['the approved head as second parent', signed([onBase, approved])],
    ['three parents', signed([approved, onBase, honest])],
    ['another committer', signed([approved, onBase], { committer: { login: 'crew' } })],
    ['no committer', signed([approved, onBase], { committer: null })],
    [
      'no valid signature',
      signed([approved, onBase], { commit: { verification: { verified: false } } }),
    ],
    ['a second parent that is no commit id', signed([approved, '--evil'])],
    ['a gh failure', { code: 1 }],
    ['unreadable output', { stdout: 'nope' }],
  ])('%s refuses', async (_n, commit) => {
    expect(await ask({ commit }, approval(), honest)).toMatch(/review it again/);
  });
});
