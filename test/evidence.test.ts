import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { parseConfig, type StudioConfig, studioConfigSchema } from '../src/config.js';
import {
  type EvidenceContext,
  EXCEPTIONS_FILE,
  evidenceChange,
  grantException,
  judgeFailedChecks,
  leadOnly,
  readExceptions,
} from '../src/evidence.js';
import { classifyDecision } from '../src/pane-data.js';
import { checkStateMarker, projectRealpath, stateRootFor, writeStateFile } from '../src/paths.js';
import type { Claude, EvidenceRunner, Gh, Ports } from '../src/ports.js';
import { realEvidence, realPorts } from '../src/ports.js';
import { decisionsOf } from '../src/push.js';
import { type Check, checkKey, mergeOne, readChecks } from '../src/queue.js';
import { newReportName } from '../src/report.js';
import { renderReviewRoutine } from '../src/review.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-evidence-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const CI = `name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  migration-guard:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/migration-guard.mjs
  evidence-sql:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/evidence/sql-comments-only.mjs
`;

/** The evidence: every changed line of a .sql file is a SQL comment. */
const SCRIPT = `import { readFileSync } from 'node:fs';
const diff = readFileSync(process.env.STUDIO_EVIDENCE_DIFF, 'utf8');
let file = '';
for (const line of diff.split('\\n')) {
  if (line.startsWith('+++ ')) { file = line.slice(4); continue; }
  if (line.startsWith('--- ')) continue;
  if (!/^[+-]/.test(line)) continue;
  const body = line.slice(1).trim();
  if (!file.endsWith('.sql') || (body !== '' && !body.startsWith('--'))) process.exit(1);
}
console.log('evidence: only SQL comments changed');
`;

const RULE_LOCAL = `  - id: sql-comments
    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }
    command: [node, scripts/evidence/sql-comments-only.mjs]
    proof: "evidence: only SQL comments changed"
    inputs: ["scripts/evidence/**"]
`;
const RULE_CI = `  - id: sql-comments-ci
    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }
    run: ci
    job: { workflow: .github/workflows/ci.yml, job: evidence-sql }
    inputs: ["scripts/evidence/**"]
`;

const studioYaml = (rules: string) => `studio: 1
primary_repo: org/app
repos: [org/app]
allow_ambient_credentials: true
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 8, merge_max_busy: 5, check_twice_seconds: 30 }
merge:
  strategy: studio-queue
  contract_paths: []
roles:
  builder: { model: sonnet, wip: 2 }
  reviewer: { model: opus, wip: 1 }
owner_only: []
deploy_commands: []
${rules === '' ? '' : `evidence:\n${rules}`}`;

const BOARD = `items:
  - id: APP-1
    title: Review of APP-2 (PR #9)
    type: review
    role: reviewer
    repo: org/app
    size: S
    priority: 1
    status: assigned
    paths: []
    touches: []
    depends_on: []
    dod: [tests pass]
    notes: ["review org/app#9"]
    history: []
  - id: APP-2
    title: Comment the migration
    type: fix
    role: builder
    repo: org/app
    size: S
    priority: 1
    status: in_review
    paths: []
    touches: [migrations/**]
    depends_on: []
    dod: [tests pass]
    pr: 9
    history: []
`;

let n = 0;
interface Repo {
  project: string;
  home: string;
  env: Record<string, string | undefined>;
  state: string;
  base: string;
  head: string;
}

/**
 * An owner checkout with main (studio.yaml with `rules`, CI, the evidence script, a migration) and
 * a pull request head on studio/APP-2 that applies `change` to the tree.
 */
function makeRepo(o: { rules?: string; change: (dir: string) => void; board?: string }): Repo {
  const base = join(root, `r${n++}`);
  mkdirSync(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = join(base, 'clone');
  git(base, 'clone', '-q', origin, project);
  git(project, 'checkout', '-q', '-b', 'main');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  };
  write('.studio/studio.yaml', studioYaml(o.rules ?? RULE_LOCAL));
  write('.studio/board.yaml', o.board ?? BOARD);
  write('.github/workflows/ci.yml', CI);
  write('scripts/evidence/sql-comments-only.mjs', SCRIPT);
  write('scripts/migration-guard.mjs', 'process.exit(1);\n');
  write('migrations/001.sql', 'CREATE TABLE a (id int);\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'base');
  git(project, 'push', '-q', 'origin', 'main');
  const baseSha = git(project, 'rev-parse', 'HEAD');
  git(project, 'checkout', '-q', '-b', 'studio/APP-2');
  o.change(project);
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'change');
  git(project, 'push', '-q', 'origin', 'studio/APP-2');
  const head = git(project, 'rev-parse', 'HEAD');
  git(project, 'checkout', '-q', 'main');
  const env = { PATH: process.env.PATH };
  return {
    project,
    home,
    env,
    state: stateRootFor(project, { env, homedir: home }),
    base: baseSha,
    head,
  };
}

const commentOnly = (dir: string) =>
  writeFileSync(join(dir, 'migrations/001.sql'), '-- the first table\nCREATE TABLE a (id int);\n');
const codeChange = (dir: string) =>
  writeFileSync(join(dir, 'migrations/001.sql'), 'DROP TABLE a;\n');

type Reply = { code?: number; stdout?: string; stderr?: string };

/** A gh that knows pull request 9 at `head` on `base`, and answers `extra` first. */
function fakeGh(
  repo: Pick<Repo, 'base' | 'head'>,
  extra: (l: string) => Reply | undefined = () => undefined,
) {
  const calls: string[] = [];
  const gh: Gh = {
    async api() {
      return '';
    },
    async run(args) {
      const l = args.join(' ');
      calls.push(l);
      const r =
        extra(l) ??
        (l.startsWith('pr view 9 --repo org/app --json files,')
          ? {
              stdout: JSON.stringify({
                headRefOid: repo.head,
                baseRefName: 'main',
                baseRefOid: repo.base,
                title: 't',
                body: '',
                isCrossRepository: false,
                changedFiles: 1,
                files: [{ path: 'migrations/001.sql', additions: 1, deletions: 0 }],
              }),
            }
          : l.startsWith('pr view 9 --repo org/app --json headRefOid,headRefName')
            ? {
                stdout: JSON.stringify({
                  headRefOid: repo.head,
                  headRefName: 'studio/APP-2',
                  headRepository: { name: 'app' },
                  headRepositoryOwner: { login: 'org' },
                  isCrossRepository: false,
                  baseRefOid: repo.base,
                }),
              }
            : l.startsWith('repo view org/app --json defaultBranchRef')
              ? { stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }) }
              : undefined);
      if (r === undefined) throw new Error(`unscripted gh call: ${l}`);
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
  return { gh, calls };
}

/** The real runner, counted. */
function countingRunner(inner: EvidenceRunner = realEvidence) {
  const runs: string[][] = [];
  const runner: EvidenceRunner = {
    run: async (argv, opts) => {
      runs.push([...argv]);
      return inner.run(argv, opts);
    },
  };
  return { runner, runs };
}

const ctxFor = (r: Repo, gh: Gh, runner?: EvidenceRunner): EvidenceContext => ({
  gh,
  git: realPorts().git,
  ...(runner === undefined ? {} : { runner }),
  checkout: { dir: r.project, remote: 'origin' },
  stateRoot: r.state,
  now: () => new Date('2026-11-05T10:00:00Z'),
  ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
});

const ref = { repo: 'org/app', pr: 9, item: 'APP-2' };
const guardFail: Check = { name: 'migration-guard', bucket: 'fail', workflow: 'CI' };
const testPass: Check = { name: 'test', bucket: 'pass', workflow: 'CI' };

describe('evidence rules in studio.yaml', () => {
  const load = (rules: string) => parseConfig(studioYaml(rules), 'studio.yaml');
  it('a local rule needs a command and the proof line; a ci rule a job and inputs', () => {
    expect(load(RULE_LOCAL).evidence?.[0]).toMatchObject({
      id: 'sql-comments',
      run: 'local',
      timeoutSeconds: 60,
      ownerOnly: false,
    });
    expect(load(RULE_CI).evidence?.[0]?.run).toBe('ci');
    expect(() =>
      load(
        `  - id: x\n    guard: { workflow: .github/workflows/ci.yml, job: g }\n    command: [node, a.mjs]\n`,
      ),
    ).toThrow(/proof: run local needs the proof line/);
    expect(() =>
      load(
        `  - id: x\n    guard: { workflow: .github/workflows/ci.yml, job: g }\n    run: ci\n    job: { workflow: .github/workflows/ci.yml, job: e }\n`,
      ),
    ).toThrow(/inputs: run ci needs inputs/);
    expect(() =>
      load(
        `  - id: x\n    guard: { workflow: .github/workflows/ci.yml, job: g }\n    command: [--x]\n    proof: p\n`,
      ),
    ).toThrow(/must not start with -/);
    expect(() => load(`${RULE_LOCAL}${RULE_LOCAL}`)).toThrow(/duplicate evidence id sql-comments/);
    expect(() =>
      load(
        `  - id: Bad\n    guard: { workflow: ci.yml, job: g }\n    command: [a]\n    proof: p\n`,
      ),
    ).toThrow(/evidence\.0\.id/);
  });
});

describe('the review routine names the guards Studio judges by evidence', () => {
  const routine = (guards?: string[]) =>
    renderReviewRoutine({
      tier: 'small',
      reasons: [],
      analyzers: [],
      skipped: [],
      contract: '/c',
      round: 0,
      ...(guards === undefined ? {} : { evidenceGuards: guards }),
    }).join('\n');
  it('a failure of such a guard alone is no finding; without rules nothing is said', () => {
    expect(routine(['migration-guard'])).toContain(
      'Studio judges a failed check of these guard jobs itself, by the evidence studio.yaml on the base binds to them: `migration-guard`. Such a failure alone is no finding and no reason for `changes_requested`',
    );
    expect(routine()).not.toContain('guard jobs');
  });
});

describe('readChecks with waived checks', () => {
  const gh = (rows: Check[]): Gh => ({
    api: async () => '',
    run: async (args) =>
      args.includes('--required')
        ? { code: 1, stdout: '', stderr: 'no required checks reported' }
        : { code: 0, stdout: JSON.stringify(rows), stderr: '' },
  });
  const entry = { repo: 'org/app', pr: 9 };
  it('lists plain failed jobs for the evidence; a waived one counts neither way', async () => {
    const v = await readChecks(entry, gh([guardFail, testPass]));
    expect(v).toMatchObject({ kind: 'failed', failed: [guardFail] });
    expect(
      await readChecks(entry, gh([guardFail, testPass]), new Set([checkKey(guardFail)])),
    ).toEqual({
      kind: 'pass',
      checks: [guardFail, testPass],
    });
    // a waived failure is no pass: something else must have passed
    expect(await readChecks(entry, gh([guardFail]), new Set([checkKey(guardFail)]))).toMatchObject({
      kind: 'failed',
      reason: 'no check passed',
    });
  });
  it('a cancelled check or a commit status is nothing an evidence rule can explain', async () => {
    const cancel = await readChecks(
      entry,
      gh([guardFail, { name: 'x', bucket: 'cancel', workflow: 'CI' }]),
    );
    expect(cancel).toMatchObject({ kind: 'failed' });
    expect(cancel.kind === 'failed' ? cancel.failed : 'other').toBeUndefined();
    const status = await readChecks(entry, gh([{ name: 'legacy', bucket: 'fail' }, testPass]));
    expect(status.kind === 'failed' ? status.failed : 'other').toBeUndefined();
  });
});

describe('judging a failed guard by its evidence', () => {
  it('only SQL comments changed: the exception applies and is logged with its evidence', async () => {
    const r = makeRepo({ change: commentOnly });
    const { runner, runs } = countingRunner();
    const v = await judgeFailedChecks(
      ctxFor(r, fakeGh(r).gh, runner),
      ref,
      r.head,
      [guardFail],
      [guardFail, testPass],
    );
    expect(v.kind).toBe('waived');
    if (v.kind !== 'waived') return;
    expect([...v.waived]).toEqual([checkKey(guardFail)]);
    const log = readExceptions(r.state);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      outcome: 'applied',
      by: 'evidence',
      rule: 'sql-comments',
      guard: '.github/workflows/ci.yml / migration-guard',
      repo: 'org/app',
      pr: 9,
      item: 'APP-2',
      base: r.base,
      head: r.head,
      run: 'local',
      command: ['node', 'scripts/evidence/sql-comments-only.mjs'],
      proof: 'evidence: only SQL comments changed',
    });
    expect(log[0]?.diff).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(log[0]?.output).toMatch(/^sha256:[0-9a-f]{64}$/);
    // the checkout of the base is gone, and so is its worktree entry
    expect(readdirSync(join(r.state, 'evidence'))).toEqual([]);
    expect(git(r.project, 'worktree', 'list').split('\n')).toHaveLength(1);
    // the same head again: the log answers, the command does not run twice
    const again = await judgeFailedChecks(
      ctxFor(r, fakeGh(r).gh, runner),
      ref,
      r.head,
      [guardFail],
      [],
    );
    expect(again.kind).toBe('waived');
    expect(runs).toHaveLength(1);
    expect(readExceptions(r.state)).toHaveLength(1);
  });

  it('a real change: not proven, logged once, the lead decides; no push to the owner', async () => {
    const r = makeRepo({ change: codeChange });
    const { runner, runs } = countingRunner();
    const v = await judgeFailedChecks(
      ctxFor(r, fakeGh(r).gh, runner),
      ref,
      r.head,
      [guardFail],
      [],
    );
    expect(v.kind).toBe('lead');
    if (v.kind !== 'lead') return;
    expect(v.owner).toBe(false);
    expect(v.reason).toBe(
      `evidence: migration-guard failed on org/app#9 at ${r.head.slice(0, 12)} and no evidence proved a false alarm (sql-comments: exit code 1); decide: studio exceptions grant org/app#9 sql-comments --reason "<one line>", or a fix through a crew`,
    );
    expect(leadOnly(v.reason)).toBe(true);
    expect(leadOnly(`merge failed: ${v.reason}`)).toBe(true);
    expect(classifyDecision(v.reason)).toBe('evidence');
    expect(
      decisionsOf({
        projectKey: 'p',
        needsLead: [{ item: 'APP-2', reason: v.reason }],
        board: undefined,
        ownerRoot: join(r.home, 'none'),
      }),
    ).toEqual([]);
    expect(readExceptions(r.state)).toMatchObject([{ outcome: 'not_proven', why: 'exit code 1' }]);
    const again = await judgeFailedChecks(
      ctxFor(r, fakeGh(r).gh, runner),
      ref,
      r.head,
      [guardFail],
      [],
    );
    expect(again).toEqual(v);
    expect(runs).toHaveLength(1);
  });

  it('an owner_only rule sends the decision to the owner, and that one is pushed', async () => {
    const r = makeRepo({ rules: `${RULE_LOCAL}    owner_only: true\n`, change: codeChange });
    const v = await judgeFailedChecks(
      ctxFor(r, fakeGh(r).gh, realEvidence),
      ref,
      r.head,
      [guardFail],
      [],
    );
    expect(v).toMatchObject({ kind: 'lead', owner: true });
    if (v.kind !== 'lead') return;
    expect(v.reason).toMatch(
      /^evidence \(owner\): migration-guard failed .* the owner decides, in a terminal/,
    );
    expect(leadOnly(v.reason)).toBe(false);
    expect(
      decisionsOf({
        projectKey: 'p',
        needsLead: [{ item: 'APP-2', reason: v.reason }],
        board: undefined,
        ownerRoot: join(r.home, 'none'),
      }).map((d) => d.kind),
    ).toEqual(['evidence']);
  });

  it('a failed check no rule is bound to fails as before', async () => {
    const r = makeRepo({ change: commentOnly });
    const lint: Check = { name: 'test', bucket: 'fail', workflow: 'CI' };
    const { runner, runs } = countingRunner();
    expect(
      await judgeFailedChecks(ctxFor(r, fakeGh(r).gh, runner), ref, r.head, [guardFail, lint], []),
    ).toEqual({ kind: 'none' });
    expect(runs).toEqual([]);
  });

  it('rules come only from studio.yaml at the base: one the pull request adds counts for nothing', async () => {
    // the head brings a rule that proves anything for the test job
    const r = makeRepo({
      rules: '',
      change: (dir) => {
        writeFileSync(
          join(dir, '.studio/studio.yaml'),
          studioYaml(
            `  - id: anything\n    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }\n    command: [node, -e, "console.log('ok')"]\n    proof: ok\n`,
          ),
        );
        commentOnly(dir);
      },
    });
    const { runner, runs } = countingRunner();
    expect(
      await judgeFailedChecks(ctxFor(r, fakeGh(r).gh, runner), ref, r.head, [guardFail], []),
    ).toEqual({ kind: 'none' });
    expect(runs).toEqual([]);
    // and the pull request gets no approval for it
    expect(await evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head)).toEqual({
      problem: 'the pull request changes evidence: in studio.yaml',
    });
  });

  it('the command and its script run from the base: a changed script is never run, and blocks', async () => {
    const r = makeRepo({
      change: (dir) => {
        writeFileSync(
          join(dir, 'scripts/evidence/sql-comments-only.mjs'),
          "console.log('evidence: only SQL comments changed');\n",
        );
        codeChange(dir);
      },
    });
    const { runner, runs } = countingRunner();
    const v = await judgeFailedChecks(
      ctxFor(r, fakeGh(r).gh, runner),
      ref,
      r.head,
      [guardFail],
      [],
    );
    expect(v).toMatchObject({ kind: 'lead' });
    if (v.kind === 'lead')
      expect(v.reason).toMatch(/the pull request changes an input of the evidence/);
    expect(runs).toEqual([]);
    expect(await evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head)).toEqual({
      problem: 'the pull request changes an input of evidence rule sql-comments',
    });
  });

  it('a pull request that changes the guard job gets no exception', async () => {
    const r = makeRepo({
      change: (dir) => {
        writeFileSync(
          join(dir, '.github/workflows/ci.yml'),
          CI.replace('scripts/migration-guard.mjs', 'x.mjs'),
        );
        commentOnly(dir);
      },
    });
    const v = await judgeFailedChecks(
      ctxFor(r, fakeGh(r).gh, realEvidence),
      ref,
      r.head,
      [guardFail],
      [],
    );
    expect(v).toMatchObject({ kind: 'lead' });
    if (v.kind === 'lead')
      expect(v.reason).toMatch(/sql-comments: the guard job changed in this pull request/);
  });

  it('a later push is another head: the exception does not carry over', async () => {
    const r = makeRepo({ change: commentOnly });
    const { runner, runs } = countingRunner();
    await judgeFailedChecks(ctxFor(r, fakeGh(r).gh, runner), ref, r.head, [guardFail], []);
    git(r.project, 'checkout', '-q', 'studio/APP-2');
    codeChange(r.project);
    git(r.project, 'commit', '-q', '-am', 'more');
    git(r.project, 'push', '-q', 'origin', 'studio/APP-2');
    const later = { ...r, head: git(r.project, 'rev-parse', 'HEAD') };
    git(r.project, 'checkout', '-q', 'main');
    const v = await judgeFailedChecks(
      ctxFor(later, fakeGh(later).gh, runner),
      ref,
      later.head,
      [guardFail],
      [],
    );
    expect(v.kind).toBe('lead');
    expect(runs).toHaveLength(2);
  });

  it('a command that runs too long proves nothing', async () => {
    const r = makeRepo({
      rules: `  - id: slow\n    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }\n    command: [node, -e, "setTimeout(() => {}, 10000)"]\n    proof: never\n    timeout_seconds: 1\n`,
      change: commentOnly,
    });
    const v = await judgeFailedChecks(
      ctxFor(r, fakeGh(r).gh, realEvidence),
      ref,
      r.head,
      [guardFail],
      [],
    );
    expect(v).toMatchObject({ kind: 'lead' });
    expect(readExceptions(r.state)).toMatchObject([
      { outcome: 'not_proven', why: 'timed out after 1 s' },
    ]);
  }, 20_000);

  it('exit 0 without the proof line proves nothing; the environment holds no owner variable', async () => {
    const r = makeRepo({
      rules: `  - id: env\n    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }\n    command: [node, -e, "console.log(Object.keys(process.env).sort().join(','))"]\n    proof: never\n`,
      change: commentOnly,
    });
    let seen = '';
    const runner: EvidenceRunner = {
      run: async (argv, opts) => {
        const out = await realEvidence.run(argv, opts);
        seen = out.stdout;
        return out;
      },
    };
    process.env.STUDIO_TEST_SECRET = 'x';
    try {
      const v = await judgeFailedChecks(
        ctxFor(r, fakeGh(r).gh, runner),
        ref,
        r.head,
        [guardFail],
        [],
      );
      expect(v).toMatchObject({ kind: 'lead' });
    } finally {
      delete process.env.STUDIO_TEST_SECRET;
    }
    expect(
      seen
        .trim()
        .split(',')
        .filter((k) => !k.startsWith('__CF_')),
    ).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'STUDIO_EVIDENCE_BASE',
      'STUDIO_EVIDENCE_DIFF',
      'STUDIO_EVIDENCE_FILES',
      'STUDIO_EVIDENCE_HEAD',
      'STUDIO_EVIDENCE_PR',
      'STUDIO_EVIDENCE_REPO',
      'STUDIO_EVIDENCE_RULE',
      'TMPDIR',
    ]);
    expect(readExceptions(r.state)).toMatchObject([{ why: 'its output lacks the proof line' }]);
  });

  it('a pull request against another branch than the default gets no exception', async () => {
    const r = makeRepo({ change: commentOnly });
    const { gh } = fakeGh(r, (l) =>
      l.startsWith('repo view')
        ? { stdout: JSON.stringify({ defaultBranchRef: { name: 'trunk' } }) }
        : undefined,
    );
    expect(
      await judgeFailedChecks(ctxFor(r, gh, realEvidence), ref, r.head, [guardFail], []),
    ).toEqual({
      kind: 'none',
    });
  });

  it('without a command runner nothing is proven, and nothing is logged', async () => {
    const r = makeRepo({ change: commentOnly });
    const v = await judgeFailedChecks(ctxFor(r, fakeGh(r).gh), ref, r.head, [guardFail], []);
    expect(v).toMatchObject({ kind: 'lead' });
    if (v.kind === 'lead') expect(v.reason).toMatch(/sql-comments: no command runner/);
    expect(readExceptions(r.state)).toEqual([]);
  });

  describe('run: ci', () => {
    const evidenceJob = (bucket: string): Check => ({
      name: 'evidence-sql',
      bucket,
      workflow: 'CI',
    });
    it('the evidence job passed on this head: the exception applies', async () => {
      const r = makeRepo({ rules: RULE_CI, change: commentOnly });
      const v = await judgeFailedChecks(
        ctxFor(r, fakeGh(r).gh),
        ref,
        r.head,
        [guardFail],
        [guardFail, evidenceJob('pass')],
      );
      expect(v.kind).toBe('waived');
      expect(readExceptions(r.state)).toMatchObject([
        { outcome: 'applied', run: 'ci', by: 'evidence' },
      ]);
    });
    it('still running: wait; failed: the lead decides', async () => {
      const r = makeRepo({ rules: RULE_CI, change: commentOnly });
      expect(
        await judgeFailedChecks(
          ctxFor(r, fakeGh(r).gh),
          ref,
          r.head,
          [guardFail],
          [evidenceJob('pending')],
        ),
      ).toEqual({ kind: 'wait', reason: 'waiting for the evidence job evidence-sql' });
      const v = await judgeFailedChecks(
        ctxFor(r, fakeGh(r).gh),
        ref,
        r.head,
        [guardFail],
        [evidenceJob('fail')],
      );
      expect(v).toMatchObject({ kind: 'lead' });
      if (v.kind === 'lead')
        expect(v.reason).toMatch(/sql-comments-ci: the evidence job did not pass/);
    });
    it('a pull request that changes .github/ gets no exception from a CI rule', async () => {
      const r = makeRepo({
        rules: RULE_CI,
        change: (dir) => {
          writeFileSync(join(dir, '.github/workflows/other.yml'), 'name: O\non: push\njobs: {}\n');
          commentOnly(dir);
        },
      });
      const v = await judgeFailedChecks(
        ctxFor(r, fakeGh(r).gh),
        ref,
        r.head,
        [guardFail],
        [evidenceJob('pass')],
      );
      expect(v).toMatchObject({ kind: 'lead' });
      if (v.kind === 'lead') expect(v.reason).toMatch(/the pull request changes \.github\//);
    });
  });

  describe('a grant by the lead or the owner', () => {
    it('is bound to the current head and base, logged once', async () => {
      const r = makeRepo({ change: codeChange });
      const first = await grantException(
        ctxFor(r, fakeGh(r).gh),
        ref,
        'sql-comments',
        'lead',
        'the drop is planned, backup taken\n',
      );
      expect(first.existing).toBe(false);
      expect(first.entry).toMatchObject({
        outcome: 'applied',
        by: 'lead',
        head: r.head,
        base: r.base,
        reason: 'the drop is planned, backup taken',
      });
      const again = await grantException(
        ctxFor(r, fakeGh(r).gh),
        ref,
        'sql-comments',
        'lead',
        'again',
      );
      expect(again.existing).toBe(true);
      expect(readExceptions(r.state)).toHaveLength(1);
      // the guard's failure now counts as waived for this head
      const v = await judgeFailedChecks(ctxFor(r, fakeGh(r).gh), ref, r.head, [guardFail], []);
      expect(v.kind).toBe('waived');
    });
    it('an owner_only rule takes the owner only; an unknown rule nothing', async () => {
      const r = makeRepo({ rules: `${RULE_LOCAL}    owner_only: true\n`, change: codeChange });
      await expect(
        grantException(ctxFor(r, fakeGh(r).gh), ref, 'sql-comments', 'lead', 'x'),
      ).rejects.toThrow(/owner_only: the owner grants it, in a terminal/);
      await expect(
        grantException(ctxFor(r, fakeGh(r).gh), ref, 'nope', 'owner', 'x'),
      ).rejects.toThrow(/no evidence rule nope/);
      expect(
        (await grantException(ctxFor(r, fakeGh(r).gh), ref, 'sql-comments', 'owner', 'x')).entry.by,
      ).toBe('owner');
    });
  });

  it('the log keeps only valid lines: a forged or torn line is no exception', async () => {
    const r = makeRepo({ change: codeChange });
    writeStateFile(
      r.state,
      join(r.state, EXCEPTIONS_FILE),
      `${JSON.stringify({ outcome: 'applied', rule: 'sql-comments', repo: 'org/app', pr: 9 })}\n{"torn`,
    );
    expect(readExceptions(r.state)).toEqual([]);
    const v = await judgeFailedChecks(ctxFor(r, fakeGh(r).gh), ref, r.head, [guardFail], []);
    expect(v.kind).toBe('lead');
  });
});

describe('the merge queue with evidence', () => {
  const config: StudioConfig = studioConfigSchema.parse({
    studio: 1,
    primaryRepo: 'org/app',
    repos: ['org/app'],
    ci: {
      provider: 'github',
      runners: 'self-hosted',
      runnerLabels: [],
      runnerNamePattern: '^pool-[0-9]',
      capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 0 },
    },
    merge: { strategy: 'studio-queue', contractPaths: [], method: 'squash' },
    roles: { builder: { model: 'm', wip: 2 } },
    ownerOnly: [],
    deployCommands: [],
  });
  const H = 'a'.repeat(40);
  const gh = (): { gh: Gh; merged: string[] } => {
    const merged: string[] = [];
    return {
      merged,
      gh: {
        // An offline runner keeps the list non-empty: an empty list fails capacity closed.
        api: async () => 'pool-99\toffline\tfalse',
        run: async (args) => {
          const l = args.join(' ');
          if (l.startsWith('pr update-branch')) return { code: 0, stdout: '', stderr: '' };
          if (l.includes('--json headRefOid,state,mergeable')) {
            return {
              code: 0,
              stdout: JSON.stringify({ headRefOid: H, state: 'OPEN', mergeable: 'MERGEABLE' }),
              stderr: '',
            };
          }
          if (l.startsWith('pr checks') && l.includes('--required')) {
            return { code: 1, stdout: '', stderr: 'no required checks reported' };
          }
          if (l.startsWith('pr checks')) {
            return { code: 1, stdout: JSON.stringify([guardFail, testPass]), stderr: '' };
          }
          if (l.startsWith('pr merge')) {
            merged.push(l);
            return { code: 0, stdout: '', stderr: '' };
          }
          if (l.includes('--json mergeCommit')) return { code: 0, stdout: '{}', stderr: '' };
          throw new Error(`unscripted ${l}`);
        },
      },
    };
  };
  const ports = (g: Gh) => {
    let t = 0;
    return {
      gh: g,
      clock: {
        now: () => new Date(t),
        sleep: async (ms: number) => {
          t += ms;
        },
      },
      host: { loadAvg1: () => 0, cpuCount: () => 4 },
    };
  };
  it('a waived guard merges; the merge gate sees the same waiver', async () => {
    const g = gh();
    const allowed: (ReadonlySet<string> | undefined)[] = [];
    const out = await mergeOne(
      { repo: 'org/app', pr: 9, step: 'checks' },
      config,
      ports(g.gh),
      () => {},
      {
        evidence: async () => ({ kind: 'waived', waived: new Set([checkKey(guardFail)]) }),
        mergeAllowed: (_e, _h, waived) => {
          allowed.push(waived);
          return undefined;
        },
      },
    );
    expect(out.result).toBe('merged');
    expect(g.merged).toHaveLength(1);
    expect([...(allowed[0] ?? [])]).toEqual([checkKey(guardFail)]);
  });
  it('evidence that proved nothing fails the entry with the lead line, without a rerun', async () => {
    const g = gh();
    let reruns = 0;
    const out = await mergeOne(
      { repo: 'org/app', pr: 9, step: 'checks' },
      config,
      ports(g.gh),
      () => {},
      {
        evidence: async () => ({ kind: 'lead', reason: 'evidence: x' }),
        onChecksFailed: async () => {
          reruns++;
          return 'fail';
        },
      },
    );
    expect(out).toEqual({ result: 'failed', reason: 'evidence: x' });
    expect(reruns).toBe(0);
    expect(g.merged).toEqual([]);
  });
});

describe('studio collect and studio exceptions', () => {
  const APPROVE = (head: string) =>
    `status: done\nitem: APP-1\nverdict: approve\nreviews: org/app#9\nhead_sha: ${head}`;
  const setup = (change: (dir: string) => void) => {
    const r = makeRepo({ change });
    // Bound to the project, as the first launch does.
    checkStateMarker(r.state, {
      projectRealpath: projectRealpath(r.project),
      originUrl: git(r.project, 'remote', 'get-url', 'origin'),
    });
    const caps = {
      analyzers: [],
      mandatory: [],
      reviewsTarget: 'org/app#9',
      headRefOid: r.head,
      baseRefName: 'main',
    };
    writeStateFile(r.state, join(r.state, 'briefs', 'APP-1.caps.json'), JSON.stringify(caps));
    const dir = join(r.state, 'clones', 'APP-1', '.studio', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, newReportName(r.state, 'APP-1')),
      `---\n${APPROVE(r.head)}\n---\n\nbody\n`,
    );
    return r;
  };
  const checksGh = (r: Repo) =>
    fakeGh(r, (l) =>
      l.startsWith('pr checks 9') && l.includes('--required')
        ? { code: 1, stderr: 'no required checks reported' }
        : l.startsWith('pr checks 9')
          ? { code: 1, stdout: JSON.stringify([guardFail, testPass]) }
          : undefined,
    );
  const portsFor = (gh: Gh, runner?: EvidenceRunner): Ports => {
    const claude: Claude = {
      start: async () => ({ pid: 1 }),
      alive: () => false,
      identity: async () => undefined,
      stop: async () => {},
    };
    return {
      gh,
      git: realPorts().git,
      credentials: realPorts().credentials,
      claude,
      clock: { now: () => new Date('2026-11-05T10:00:00Z'), sleep: async () => {} },
      host: { loadAvg1: () => 0, cpuCount: () => 4 },
      ...(runner === undefined ? {} : { evidence: runner }),
    };
  };
  const cli = async (r: Repo, ports: Ports, isTerminal: boolean, ...argv: string[]) => {
    let out = '';
    let err = '';
    const code = await runCli(['--project', r.project, ...argv], {
      ports,
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      env: r.env,
      homedir: r.home,
      cwd: r.project,
      isTerminal,
    });
    return { code, out, err };
  };

  it('an approval with a guard the evidence explains is stored, with the exception', async () => {
    const r = setup(commentOnly);
    const res = await cli(r, portsFor(checksGh(r).gh, realEvidence), false, 'collect', 'APP-1');
    expect(res.err).toBe('');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out).exceptions).toEqual([
      { rule: 'sql-comments', by: 'evidence', head: r.head },
    ]);
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-2')?.approvedHead).toBe(r.head);
    const list = await cli(r, portsFor(checksGh(r).gh), false, 'exceptions');
    expect(list.out).toMatch(/applied\s+evidence\s+sql-comments\s+org\/app#9\s+APP-2/);
    const board = await cli(r, portsFor(checksGh(r).gh), false, 'board');
    expect(board.out).toMatch(
      /EXCEPTION\s+ITEM\s+PR\s+HEAD\s+BY\s+AT\n\s*sql-comments\s+APP-2\s+org\/app#9/,
    );
  });

  it('a guard the evidence does not explain: nothing moves, the lead decides and can grant', async () => {
    const r = setup(codeChange);
    const ports = portsFor(checksGh(r).gh, realEvidence);
    const res = await cli(r, ports, false, 'collect', 'APP-1');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/no evidence proved a false alarm \(sql-comments: exit code 1\)/);
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-2')?.approvedHead).toBeUndefined();
    // a crew may not grant
    const crew = await runCli(
      ['--project', r.project, 'exceptions', 'grant', 'org/app#9', 'sql-comments', '--reason', 'x'],
      {
        ports,
        stdout: () => {},
        stderr: () => {},
        env: { ...r.env, STUDIO_ROLE: 'crew' },
        homedir: r.home,
        cwd: r.project,
      },
    );
    expect(crew).toBe(1);
    expect(readExceptions(r.state).filter((e) => e.outcome === 'applied')).toEqual([]);
    const grant = await cli(
      r,
      ports,
      false,
      'exceptions',
      'grant',
      'org/app#9',
      'sql-comments',
      '--reason',
      'planned drop, backup taken',
    );
    expect(grant.err).toBe('');
    expect(grant.code).toBe(0);
    expect(JSON.parse(grant.out)).toMatchObject({
      granted: 'sql-comments',
      by: 'lead',
      head: r.head,
    });
    const after = await cli(r, ports, false, 'collect', 'APP-1');
    expect(after.code).toBe(0);
    expect(JSON.parse(after.out).exceptions).toEqual([
      { rule: 'sql-comments', by: 'lead', head: r.head },
    ]);
  });

  it('a pull request that changes an evidence input gets no approval: blocked for the owner', async () => {
    const r = setup((dir) => {
      writeFileSync(join(dir, 'scripts/evidence/sql-comments-only.mjs'), 'process.exit(0);\n');
    });
    const gh = fakeGh(r, (l) =>
      l.startsWith('pr checks 9') && l.includes('--required')
        ? { code: 1, stderr: 'no required checks reported' }
        : l.startsWith('pr checks 9')
          ? { stdout: JSON.stringify([testPass]) }
          : undefined,
    ).gh;
    const res = await cli(r, portsFor(gh), false, 'collect', 'APP-1');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(
      /changes an input of evidence rule sql-comments; evidence is the owner's/,
    );
    const review = loadBoard(r.project).items.find((i) => i.id === 'APP-1');
    expect(review?.status).toBe('blocked');
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-2')?.approvedHead).toBeUndefined();
    expect(readFileSync(join(r.project, '.studio/studio.yaml'), 'utf8')).toMatch(/sql-comments/);
  });
});
