import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
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
  effectiveInputs,
  evidenceChange,
  grantException,
  judgeFailedChecks,
  leadOnly,
  MAX_RETRIES,
  readExceptions,
  recordException,
} from '../src/evidence.js';
import { classifyDecision } from '../src/pane-data.js';
import { checkStateMarker, projectRealpath, stateRootFor, writeStateFile } from '../src/paths.js';
import type { Claude, EvidenceRun, EvidenceRunner, Gh, Ports } from '../src/ports.js';
import { realEvidence, realPorts } from '../src/ports.js';
import { decisionsOf } from '../src/push.js';
import { type Check, checkKey, mergeOne, readChecks } from '../src/queue.js';
import { newReportName } from '../src/report.js';
import { renderReviewRoutine } from '../src/review.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-evidence-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Whether this machine can run evidence commands sandboxed (Seatbelt, or bubblewrap in CI). */
const sandboxed = (await realEvidence.unavailable()) === undefined;

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
`;

/** The evidence: every changed line of a .sql file is a SQL comment; the proof carries the nonce. */
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
console.log('evidence: only SQL comments changed ' + process.env.STUDIO_EVIDENCE_NONCE);
`;

const RULE = `  - id: sql-comments
    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }
    command: [node, scripts/evidence/sql-comments-only.mjs]
    proof: "evidence: only SQL comments changed"
    inputs: ["scripts/evidence/**"]
`;
/** A rule whose command is inline code: argv words with spaces name no file. */
const inline = (id: string, code: string, extra = '') =>
  `  - id: ${id}\n    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }\n    command: [node, -e, ${JSON.stringify(code)}]\n    proof: ok\n    inputs: ["scripts/evidence/**"]\n${extra}`;

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
function makeRepo(o: { rules?: string; change: (dir: string) => void }): Repo {
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
  write('.studio/studio.yaml', studioYaml(o.rules ?? RULE));
  write('.studio/board.yaml', BOARD);
  write('.github/workflows/ci.yml', CI);
  write('scripts/evidence/sql-comments-only.mjs', SCRIPT);
  write('scripts/migration-guard.mjs', 'process.exit(1);\n');
  write('migrations/001.sql', 'CREATE TABLE a (id int);\n');
  write('package.json', '{"name":"app"}\n');
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

/**
 * A runner without a sandbox, for the logic: the command runs as it would inside, with the same
 * environment and run dir. The sandbox itself is tested on its own below.
 */
const plainRunner: EvidenceRunner = {
  unavailable: async () => undefined,
  extract: realEvidence.extract,
  run: (argv, opts) =>
    new Promise<EvidenceRun>((done) => {
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString('utf8');
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done({ kind: 'failed', why: `timed out after ${opts.timeoutMs / 1000} s` });
      }, opts.timeoutMs);
      child.on('error', (e) => done({ kind: 'failed', why: e.message }));
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ kind: 'exited', code: code ?? 1, stdout: out, tooLarge: false });
      });
    }),
};

/** A runner, counted; the sandboxed one where this machine has a sandbox. */
function countingRunner(inner: EvidenceRunner = plainRunner) {
  const runs: { argv: string[]; hidden: readonly string[]; writable: string }[] = [];
  const runner: EvidenceRunner = {
    unavailable: inner.unavailable,
    extract: inner.extract,
    run: async (argv, opts) => {
      runs.push({ argv: [...argv], hidden: opts.hidden, writable: opts.writable });
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
  hidden: [join(r.home, '.ssh')],
});

const ref = { repo: 'org/app', pr: 9, item: 'APP-2' };
const guardFail: Check = { name: 'migration-guard', bucket: 'fail', workflow: 'CI' };
const testPass: Check = { name: 'test', bucket: 'pass', workflow: 'CI' };
const judge = (r: Repo, runner: EvidenceRunner | undefined = plainRunner, gh = fakeGh(r).gh) =>
  judgeFailedChecks(ctxFor(r, gh, runner), ref, r.head, [guardFail]);

describe('evidence rules in studio.yaml', () => {
  const load = (rules: string) => parseConfig(studioYaml(rules), 'studio.yaml');
  const rule = (lines: string) =>
    `  - id: x\n    guard: { workflow: .github/workflows/ci.yml, job: g }\n${lines}`;
  it('a rule needs a command, the proof line and inputs that cover what the command names', () => {
    expect(load(RULE).evidence?.[0]).toMatchObject({
      id: 'sql-comments',
      run: 'local',
      timeoutSeconds: 60,
      ownerOnly: false,
    });
    expect(() => load(rule('    command: [node, a.mjs]\n    inputs: ["a.mjs"]\n'))).toThrow(
      /proof/,
    );
    expect(() => load(rule('    command: [node, a.mjs]\n    proof: p\n'))).toThrow(/inputs/);
    expect(() =>
      load(
        rule(
          '    command: [node, scripts/x.mjs, data/cfg.json]\n    proof: p\n    inputs: ["scripts/**"]\n',
        ),
      ),
    ).toThrow(/inputs: data\/cfg\.json in command is not covered by inputs/);
    expect(() =>
      load(rule('    command: [node, /etc/x.mjs]\n    proof: p\n    inputs: ["scripts/**"]\n')),
    ).toThrow(/an absolute path is no repository file/);
    expect(() =>
      load(rule('    command: [node, ../x.mjs]\n    proof: p\n    inputs: ["**"]\n')),
    ).toThrow(/no \.\. in a path/);
    expect(() => load(rule('    command: [--x]\n    proof: p\n    inputs: ["a"]\n'))).toThrow(
      /must not start with -/,
    );
    // an absolute program is fine: it is no repository file
    expect(
      load(rule('    command: [/usr/bin/env, node, s/a.mjs]\n    proof: p\n    inputs: ["s/**"]\n'))
        .evidence,
    ).toHaveLength(1);
    expect(() => load(`${RULE}${RULE}`)).toThrow(/duplicate evidence id sql-comments/);
  });
  it('run: ci is refused in this version, with why', () => {
    expect(() =>
      load(rule('    run: ci\n    command: [node, s/a.mjs]\n    proof: p\n    inputs: ["s/**"]\n')),
    ).toThrow(/run: ci is not supported: an evidence job runs the pull request head/);
    expect(() =>
      load(rule('    run: ci\n    job: { workflow: .github/workflows/ci.yml, job: e }\n')),
    ).toThrow(/job: unknown key/);
  });
  it('the effective inputs add the script directory and the root manifests and lockfiles', () => {
    const r = load(RULE).evidence?.[0];
    if (r === undefined) throw new Error('no rule');
    const inputs = effectiveInputs(r);
    expect(inputs).toEqual(
      expect.arrayContaining([
        'scripts/evidence/**',
        'package.json',
        'pnpm-lock.yaml',
        'package-lock.json',
        'yarn.lock',
        '.npmrc',
        'Cargo.toml',
        'Cargo.lock',
        'pyproject.toml',
        'requirements*.txt',
      ]),
    );
    const atRoot = load(
      rule('    command: [node, check.mjs]\n    proof: p\n    inputs: ["check.mjs"]\n'),
    ).evidence?.[0];
    expect(atRoot === undefined ? [] : effectiveInputs(atRoot)).toContain('check.mjs');
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
    const v = await judge(r, runner);
    expect(v.kind).toBe('waived');
    if (v.kind !== 'waived') return;
    expect([...v.waived]).toEqual([checkKey(guardFail)]);
    expect(v.base).toBe(r.base);
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
    // the run had a dir of its own, hid the state root, and is gone; no worktree was made
    expect(runs[0]?.hidden).toEqual([join(r.home, '.ssh'), r.state]);
    expect(runs[0]?.writable.startsWith(join(r.state, 'evidence'))).toBe(true);
    expect(readdirSync(join(r.state, 'evidence'))).toEqual([]);
    expect(git(r.project, 'worktree', 'list').split('\n')).toHaveLength(1);
    // the same head again: the log answers, the command does not run twice
    expect((await judge(r, runner)).kind).toBe('waived');
    expect(runs).toHaveLength(1);
    expect(readExceptions(r.state)).toHaveLength(1);
  });

  it('a real change: not proven, logged once, the lead decides; no push to the owner', async () => {
    const r = makeRepo({ change: codeChange });
    const { runner, runs } = countingRunner();
    const v = await judge(r, runner);
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
    expect(await judge(r, runner)).toEqual(v);
    expect(runs).toHaveLength(1);
  });

  it('the proof needs the nonce of the run: the proof text from the diff proves nothing', async () => {
    // the head adds the proof text to the migration, and the command prints the diff
    const r = makeRepo({
      rules: `  - id: echo\n    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }\n    command: [cat, scripts/evidence/diff-link]\n    proof: ok\n    inputs: ["scripts/evidence/**"]\n`,
      change: (dir) => writeFileSync(join(dir, 'migrations/001.sql'), 'ok\nok 0123\n'),
    });
    const { runner } = countingRunner({
      ...plainRunner,
      run: (_argv, opts) =>
        plainRunner.run(['sh', '-c', 'cat "$STUDIO_EVIDENCE_DIFF" | sed "s/^+//"'], opts),
    });
    expect(await judge(r, runner)).toMatchObject({ kind: 'lead' });
    expect(readExceptions(r.state)).toMatchObject([
      { outcome: 'not_proven', why: 'its output lacks the proof line with the nonce' },
    ]);
  });

  it('the changed paths come NUL-separated; a path with a control character proves nothing', async () => {
    const r = makeRepo({
      rules: inline(
        'paths',
        "const f=require('fs').readFileSync(process.env.STUDIO_EVIDENCE_FILES,'utf8');console.log(JSON.stringify(f.split('\\u0000')));console.log('ok '+process.env.STUDIO_EVIDENCE_NONCE)",
      ),
      change: (dir) => writeFileSync(join(dir, 'migrations/two words.sql'), '-- x\n'),
    });
    let out = '';
    const { runner } = countingRunner({
      ...plainRunner,
      run: async (argv, opts) => {
        const res = await plainRunner.run(argv, opts);
        if (res.kind === 'exited') out = res.stdout;
        return res;
      },
    });
    expect((await judge(r, runner)).kind).toBe('waived');
    expect(JSON.parse(out.split('\n')[0] as string)).toEqual(['migrations/two words.sql', '']);
    const hostile = makeRepo({
      change: (dir) => writeFileSync(join(dir, 'migrations/a\u0001b.sql'), '-- x\n'),
    });
    const counted = countingRunner();
    expect(await judge(hostile, counted.runner)).toMatchObject({ kind: 'lead' });
    expect(counted.runs).toEqual([]);
    expect(readExceptions(hostile.state)).toMatchObject([
      { outcome: 'not_proven', why: 'a changed path has a control character' },
    ]);
  });

  it('an owner_only rule sends the decision to the owner, and that one is pushed', async () => {
    const r = makeRepo({ rules: `${RULE}    owner_only: true\n`, change: codeChange });
    const v = await judge(r);
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
      await judgeFailedChecks(ctxFor(r, fakeGh(r).gh, runner), ref, r.head, [guardFail, lint]),
    ).toEqual({ kind: 'none' });
    expect(runs).toEqual([]);
  });

  it('rules come only from studio.yaml at the base: one the pull request adds counts for nothing', async () => {
    const r = makeRepo({
      rules: '',
      change: (dir) => {
        writeFileSync(
          join(dir, '.studio/studio.yaml'),
          studioYaml(inline('anything', "console.log('ok '+process.env.STUDIO_EVIDENCE_NONCE)")),
        );
        commentOnly(dir);
      },
    });
    const { runner, runs } = countingRunner();
    expect(await judge(r, runner)).toEqual({ kind: 'none' });
    expect(runs).toEqual([]);
    expect(await evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head)).toEqual({
      problem: 'the pull request changes evidence: in studio.yaml',
    });
  });

  it.each([
    ['its script', 'scripts/evidence/sql-comments-only.mjs'],
    ['a file beside its script', 'scripts/evidence/helper.mjs'],
    ['a root manifest', 'package.json'],
    ['a lockfile', 'pnpm-lock.yaml'],
    ['.npmrc', '.npmrc'],
  ])('a pull request that changes %s gets no exception and no approval', async (_what, path) => {
    const r = makeRepo({
      change: (dir) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), "console.log('changed')\n");
        commentOnly(dir);
      },
    });
    const { runner, runs } = countingRunner();
    const v = await judge(r, runner);
    expect(v).toMatchObject({ kind: 'lead' });
    if (v.kind === 'lead') {
      expect(v.reason).toMatch(/the pull request changes an input of the evidence/);
    }
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
    const v = await judge(r);
    expect(v).toMatchObject({ kind: 'lead' });
    if (v.kind === 'lead') {
      expect(v.reason).toMatch(/sql-comments: the guard job changed in this pull request/);
    }
  });

  it('a later push is another head: the exception does not carry over', async () => {
    const r = makeRepo({ change: commentOnly });
    const { runner, runs } = countingRunner();
    await judge(r, runner);
    git(r.project, 'checkout', '-q', 'studio/APP-2');
    codeChange(r.project);
    git(r.project, 'commit', '-q', '-am', 'more');
    git(r.project, 'push', '-q', 'origin', 'studio/APP-2');
    const later = { ...r, head: git(r.project, 'rev-parse', 'HEAD') };
    git(r.project, 'checkout', '-q', 'main');
    expect((await judge(later, runner)).kind).toBe('lead');
    expect(runs).toHaveLength(2);
  });

  it('a timeout or a start failure is retried, not logged; the lead hears after the limit', async () => {
    const r = makeRepo({ change: commentOnly });
    const failing: EvidenceRunner = {
      ...plainRunner,
      run: async () => ({ kind: 'failed', why: 'timed out after 60 s' }),
    };
    for (let i = 1; i < MAX_RETRIES; i++) {
      expect(await judge(r, failing)).toEqual({
        kind: 'wait',
        reason: 'evidence: timed out after 60 s; tried again',
      });
    }
    const last = await judge(r, failing);
    expect(last).toMatchObject({ kind: 'lead', owner: false });
    if (last.kind === 'lead') expect(last.reason).toMatch(/after 5 tries: timed out after 60 s/);
    expect(readExceptions(r.state)).toEqual([]);
    expect(readdirSync(join(r.state, 'evidence'))).toEqual([]);
  });

  it('an unreadable pull request is retried too, then goes to the lead', async () => {
    const r = makeRepo({ change: commentOnly });
    const { gh } = fakeGh(r, (l) =>
      l.startsWith('pr view 9 --repo org/app --json files,') ? { code: 1 } : undefined,
    );
    for (let i = 1; i < MAX_RETRIES; i++)
      expect((await judge(r, plainRunner, gh)).kind).toBe('wait');
    expect(await judge(r, plainRunner, gh)).toMatchObject({ kind: 'lead' });
  });

  it('exit 0 without the proof line proves nothing; the environment holds no owner variable', async () => {
    const r = makeRepo({
      rules: inline('env', "console.log(Object.keys(process.env).sort().join(','))"),
      change: commentOnly,
    });
    let seen = '';
    const runner: EvidenceRunner = {
      ...plainRunner,
      run: async (argv, opts) => {
        const out = await plainRunner.run(argv, opts);
        if (out.kind === 'exited') seen = out.stdout;
        return out;
      },
    };
    process.env.STUDIO_TEST_SECRET = 'x';
    try {
      expect(await judge(r, runner)).toMatchObject({ kind: 'lead' });
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
      'STUDIO_EVIDENCE_NONCE',
      'STUDIO_EVIDENCE_PR',
      'STUDIO_EVIDENCE_REPO',
      'STUDIO_EVIDENCE_RULE',
      'TMPDIR',
    ]);
  });

  it('a pull request against another branch than the default gets no exception', async () => {
    const r = makeRepo({ change: commentOnly });
    const { gh } = fakeGh(r, (l) =>
      l.startsWith('repo view')
        ? { stdout: JSON.stringify({ defaultBranchRef: { name: 'trunk' } }) }
        : undefined,
    );
    expect(await judge(r, plainRunner, gh)).toEqual({ kind: 'none' });
  });

  it('without a runner, or without a sandbox, nothing is proven and nothing is logged', async () => {
    const r = makeRepo({ change: commentOnly });
    const none = await judgeFailedChecks(ctxFor(r, fakeGh(r).gh), ref, r.head, [guardFail]);
    expect(none).toMatchObject({ kind: 'lead' });
    if (none.kind === 'lead') expect(none.reason).toMatch(/sql-comments: no command runner/);
    const noSandbox = await judge(r, {
      ...plainRunner,
      unavailable: async () => 'no sandbox for evidence commands on plan9',
    });
    expect(noSandbox).toMatchObject({ kind: 'lead' });
    if (noSandbox.kind === 'lead') {
      expect(noSandbox.reason).toMatch(/no sandbox: no sandbox for evidence commands on plan9/);
    }
    expect(readExceptions(r.state)).toEqual([]);
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
      const again = await grantException(ctxFor(r, fakeGh(r).gh), ref, 'sql-comments', 'lead', 'x');
      expect(again.existing).toBe(true);
      expect(readExceptions(r.state)).toHaveLength(1);
      expect((await judge(r)).kind).toBe('waived');
    });
    it('an owner_only rule takes the owner only; an unknown rule nothing', async () => {
      const r = makeRepo({ rules: `${RULE}    owner_only: true\n`, change: codeChange });
      await expect(
        grantException(ctxFor(r, fakeGh(r).gh), ref, 'sql-comments', 'lead', 'x'),
      ).rejects.toThrow(/owner_only: the owner grants it, in a terminal/);
      await expect(
        grantException(ctxFor(r, fakeGh(r).gh), ref, 'nope', 'owner', 'x'),
      ).rejects.toThrow(/no evidence rule nope/);
      expect(
        (await grantException(ctxFor(r, fakeGh(r).gh), ref, 'sql-comments', 'owner', 'x')).entry.by,
      ).toBe('owner');
      expect((await judge(r)).kind).toBe('waived');
    });
    it('a lead grant through a sibling rule cannot waive a guard with an owner_only rule', async () => {
      const sibling = inline('plain', 'process.exit(1)');
      const r = makeRepo({ rules: `${RULE}    owner_only: true\n${sibling}`, change: codeChange });
      await expect(
        grantException(ctxFor(r, fakeGh(r).gh), ref, 'plain', 'lead', 'x'),
      ).rejects.toThrow(/evidence rule sql-comments on the same guard is owner_only/);
      // a lead entry in the log (an older Studio, or one written by hand) does not hold either
      recordException(r.state, {
        v: 1,
        at: '2026-11-05T09:00:00.000Z',
        outcome: 'applied',
        by: 'lead',
        rule: 'plain',
        guard: '.github/workflows/ci.yml / migration-guard',
        repo: 'org/app',
        pr: 9,
        base: r.base,
        head: r.head,
        diff: 'sha256:0',
        reason: 'x',
      });
      const v = await judge(r);
      expect(v).toMatchObject({ kind: 'lead', owner: true });
      if (v.kind === 'lead') {
        expect(v.reason).toMatch(/^evidence \(owner\): /);
      }
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
    expect((await judge(r)).kind).toBe('lead');
  });
});

describe.runIf(sandboxed)('the sandbox of an evidence command', () => {
  const run = async (code: string, extra: { hidden?: string[] } = {}) => {
    const dir = mkdtempSync(join(root, 'run-'));
    const out = await realEvidence.run(['node', '-e', code], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
      timeoutMs: 10_000,
      maxBytes: 1024 * 1024,
      writable: dir,
      hidden: extra.hidden ?? [],
    });
    return { dir, out };
  };
  it('writes only in its run dir, reads no hidden path, reaches no network', async () => {
    const secret = mkdtempSync(join(root, 'secret-'));
    writeFileSync(join(secret, 'token'), 'x');
    const outside = join(root, `outside-${process.pid}`);
    const { dir, out } = await run(
      `const fs=require('fs');const t=(n,f)=>{try{f();console.log(n,'yes')}catch{console.log(n,'no')}};
       t('write-run',()=>fs.writeFileSync(process.env.HOME+'/a','x'));
       t('write-outside',()=>fs.writeFileSync(${JSON.stringify(outside)},'x'));
       t('read-hidden',()=>fs.readFileSync(${JSON.stringify(join(secret, 'token'))}));
       require('net').connect(443,'example.com').on('error',()=>console.log('net no')).on('connect',()=>{console.log('net yes');process.exit()});`,
      { hidden: [secret] },
    );
    expect(out.kind).toBe('exited');
    const text = out.kind === 'exited' ? out.stdout : '';
    expect(text).toContain('write-run yes');
    expect(text).toContain('write-outside no');
    expect(text).toContain('read-hidden no');
    expect(text).toContain('net no');
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(dir, 'a'))).toBe(true);
  });
  it('a timeout kills the whole process group', async () => {
    const dir = mkdtempSync(join(root, 'run-'));
    const out = await realEvidence.run(['sh', '-c', 'sleep 30 & echo $! > "$HOME/pid"; sleep 30'], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
      timeoutMs: 1000,
      maxBytes: 1024,
      writable: dir,
      hidden: [],
    });
    expect(out).toEqual({ kind: 'failed', why: 'timed out after 1 s' });
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('the real script proves comments only, sandboxed, in an extract of the base', async () => {
    const r = makeRepo({ change: commentOnly });
    expect((await judge(r, realEvidence)).kind).toBe('waived');
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
  const waived = { kind: 'waived' as const, waived: new Set([checkKey(guardFail)]) };
  it('a waived guard merges; it is judged again right before the merge, never from the cache', async () => {
    const g = gh();
    const allowed: (ReadonlySet<string> | undefined)[] = [];
    let judged = 0;
    const out = await mergeOne(
      { repo: 'org/app', pr: 9, step: 'checks' },
      config,
      ports(g.gh),
      () => {},
      {
        evidence: async () => {
          judged++;
          return waived;
        },
        mergeAllowed: (_e, _h, w) => {
          allowed.push(w);
          return undefined;
        },
      },
    );
    expect(out.result).toBe('merged');
    expect(g.merged).toHaveLength(1);
    expect(judged).toBe(2);
    expect([...(allowed[0] ?? [])]).toEqual([checkKey(guardFail)]);
  });
  it('a base that moved before the merge: judged again, and no evidence there stops the merge', async () => {
    const g = gh();
    let judged = 0;
    const out = await mergeOne(
      { repo: 'org/app', pr: 9, step: 'checks' },
      config,
      ports(g.gh),
      () => {},
      {
        // the second judgement reads another base, where no exception is logged
        evidence: async () =>
          ++judged === 1 ? waived : { kind: 'lead', reason: 'evidence: on the new base' },
      },
    );
    expect(out).toEqual({ result: 'failed', reason: 'evidence: on the new base' });
    expect(g.merged).toEqual([]);
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
  const checksGh = (r: Repo, checks: Check[] = [guardFail, testPass]) =>
    fakeGh(r, (l) =>
      l.startsWith('pr checks 9') && l.includes('--required')
        ? { code: 1, stderr: 'no required checks reported' }
        : l.startsWith('pr checks 9')
          ? { code: 1, stdout: JSON.stringify(checks) }
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
    const { runner, runs } = countingRunner();
    const res = await cli(r, portsFor(checksGh(r).gh, runner), false, 'collect', 'APP-1');
    expect(res.err).toBe('');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out).exceptions).toEqual([
      { rule: 'sql-comments', by: 'evidence', head: r.head },
    ]);
    // the run may not read credentials, the owner config or any state root
    expect(runs[0]?.hidden).toEqual(
      expect.arrayContaining([
        join(r.home, '.ssh'),
        join(r.home, '.config/gh'),
        join(r.home, '.claude'),
        join(r.home, '.config', 'studio'),
        join(r.home, '.local', 'state', 'studio'),
        r.state,
      ]),
    );
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
    const ports = portsFor(checksGh(r).gh, plainRunner);
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
    const res = await cli(r, portsFor(checksGh(r, [testPass]).gh), false, 'collect', 'APP-1');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(
      /changes an input of evidence rule sql-comments; evidence is the owner's/,
    );
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-1')?.status).toBe('blocked');
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-2')?.approvedHead).toBeUndefined();
  });

  it('the check reads the rules at the base, also when the owner checkout has none', async () => {
    const r = setup((dir) => {
      writeFileSync(join(dir, 'scripts/evidence/sql-comments-only.mjs'), 'process.exit(0);\n');
    });
    // a stale or empty local checkout: no evidence rules in the working tree
    writeFileSync(join(r.project, '.studio/studio.yaml'), studioYaml(''));
    const res = await cli(r, portsFor(checksGh(r, [testPass]).gh), false, 'collect', 'APP-1');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/changes an input of evidence rule sql-comments/);
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-2')?.approvedHead).toBeUndefined();
  });

  it('when the comparison cannot be made, the approval waits (fails closed)', async () => {
    const r = setup(commentOnly);
    const { gh } = fakeGh(r, (l) =>
      l.startsWith('pr view 9 --repo org/app --json headRefOid,headRefName')
        ? {
            stdout: JSON.stringify({
              headRefOid: r.head,
              headRefName: 'studio/APP-2',
              headRepository: { name: 'app' },
              headRepositoryOwner: { login: 'org' },
              isCrossRepository: false,
            }),
          }
        : l.startsWith('pr checks 9') && l.includes('--required')
          ? { code: 1, stderr: 'no required checks reported' }
          : l.startsWith('pr checks 9')
            ? { stdout: JSON.stringify([testPass]) }
            : undefined,
    );
    const res = await cli(r, portsFor(gh), false, 'collect', 'APP-1');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/whether org\/app#9 changes the evidence rules cannot be read now/);
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-2')?.approvedHead).toBeUndefined();
  });
});
