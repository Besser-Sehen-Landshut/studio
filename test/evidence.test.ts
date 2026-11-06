import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { parseConfig, type StudioConfig, studioConfigSchema } from '../src/config.js';
import {
  addedInPullRequest,
  type EvidenceContext,
  EXCEPTIONS_FILE,
  evidenceChange,
  grantException,
  judgeFailedChecks,
  leadOnly,
  MAX_RETRIES,
  readExceptions,
  recordException,
} from '../src/evidence.js';
import { matchGlobExact } from '../src/glob.js';
import { classifyDecision } from '../src/pane-data.js';
import { checkStateMarker, projectRealpath, stateRootFor, writeStateFile } from '../src/paths.js';
import type { Claude, Gh, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
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
`;

const RULE = `  - id: sql-comments
    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }
    proof: comments_only
    languages: [sql]
    paths: ["migrations/**"]
`;
const DOCS_RULE = `  - id: docs-only
    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }
    proof: paths_only
    paths: ["docs/**", "**/*.md"]
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
 * An owner checkout with main (studio.yaml with `rules`, CI, a migration, docs) and a pull request
 * head on studio/APP-2 that applies `change` to the tree.
 */
function makeRepo(o: { rules?: string; change: (dir: string) => void; sql?: string }): Repo {
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
  write('scripts/migration-guard.mjs', 'process.exit(1);\n');
  write('migrations/001.sql', o.sql ?? 'CREATE TABLE a (id int);\n');
  write('docs/guide.md', '# Guide\n');
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

const migration = (dir: string, text: string) =>
  writeFileSync(join(dir, 'migrations/001.sql'), text);
const commentOnly = (dir: string) =>
  migration(dir, '-- the first table\nCREATE TABLE a (id int);\n');
const codeChange = (dir: string) => migration(dir, 'DROP TABLE a;\n');

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

const ctxFor = (r: Repo, gh: Gh): EvidenceContext => ({
  gh,
  git: realPorts().git,
  checkout: { dir: r.project, remote: 'origin' },
  stateRoot: r.state,
  now: () => new Date('2026-11-05T10:00:00Z'),
});

const ref = { repo: 'org/app', pr: 9, item: 'APP-2' };
const guardFail: Check = { name: 'migration-guard', bucket: 'fail', workflow: 'CI' };
const testPass: Check = { name: 'test', bucket: 'pass', workflow: 'CI' };
const judge = (r: Repo, gh = fakeGh(r).gh) =>
  judgeFailedChecks(ctxFor(r, gh), ref, r.head, [guardFail]);
const whyOf = async (r: Repo): Promise<string> => {
  const v = await judge(r);
  if (v.kind !== 'lead') throw new Error(`expected lead, got ${v.kind}`);
  return v.reason;
};

describe('evidence rules in studio.yaml', () => {
  const load = (rules: string) => parseConfig(studioYaml(rules), 'studio.yaml');
  const rule = (lines: string) =>
    `  - id: x\n    guard: { workflow: .github/workflows/ci.yml, job: g }\n${lines}`;
  it('a rule takes a built-in proof with its paths, and languages for comments_only', () => {
    expect(load(RULE).evidence?.[0]).toEqual({
      id: 'sql-comments',
      guard: { workflow: '.github/workflows/ci.yml', job: 'migration-guard' },
      proof: 'comments_only',
      languages: ['sql'],
      paths: ['migrations/**'],
      ownerOnly: false,
    });
    expect(load(DOCS_RULE).evidence?.[0]?.proof).toBe('paths_only');
    expect(() => load(rule('    proof: whitespace_only\n    paths: ["a/**"]\n'))).toThrow(
      /proof: whitespace_only is not in this version: it comes later/,
    );
    expect(() => load(rule('    proof: comments_only\n    paths: ["a/**"]\n'))).toThrow(
      /languages: comments_only needs the languages it reads/,
    );
    expect(() =>
      load(rule('    proof: paths_only\n    paths: ["a/**"]\n    languages: [sql]\n')),
    ).toThrow(/only comments_only reads languages/);
    expect(() => load(rule('    proof: paths_only\n'))).toThrow(/paths/);
    expect(() => load(rule('    proof: anything\n    paths: ["a"]\n'))).toThrow(/proof/);
    for (const lang of ['cobol', 'ts', 'rust', 'python']) {
      expect(() =>
        load(rule(`    proof: comments_only\n    languages: [sql, ${lang}]\n    paths: ["a"]\n`)),
      ).toThrow(
        /languages\.1: comments_only reads sql only so far; more languages come later, each with its own adversarial review/,
      );
    }
    expect(() => load(`${RULE}${RULE}`)).toThrow(/duplicate evidence id sql-comments/);
    expect(() => load(rule('    proof: paths_only\n    paths: ["a"]\n    extra: 1\n'))).toThrow(
      /extra: unknown key/,
    );
  });
  it('a command belongs to proof: command only; the keys of the earlier draft are refused', () => {
    expect(() =>
      load(rule('    proof: paths_only\n    paths: ["a"]\n    command: [node, a.mjs]\n')),
    ).toThrow(/only proof: command takes a command/);
    for (const lines of [
      '    proof: paths_only\n    paths: ["a"]\n    run: ci\n',
      '    proof: paths_only\n    paths: ["a"]\n    inputs: ["a"]\n',
    ]) {
      expect(() => load(rule(lines))).toThrow(
        /a proof command takes command and timeout_seconds only: it runs locally, sandboxed/,
      );
    }
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
    ).toEqual({ kind: 'pass', checks: [guardFail, testPass] });
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

describe('judging a failed guard by a built-in proof', () => {
  it('comments_only: only SQL comments changed, the exception applies and is logged', async () => {
    const r = makeRepo({ change: commentOnly });
    const v = await judge(r);
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
      proof: 'comments_only',
    });
    expect(log[0]?.diff).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await judge(r)).kind).toBe('waived');
    expect(readExceptions(r.state)).toHaveLength(1);
  });

  it('a real change: not proven, logged once, the lead decides; no push to the owner', async () => {
    const r = makeRepo({ change: codeChange });
    const v = await judge(r);
    expect(v.kind).toBe('lead');
    if (v.kind !== 'lead') return;
    expect(v.owner).toBe(false);
    expect(v.reason).toBe(
      `evidence: migration-guard failed on org/app#9 at ${r.head.slice(0, 12)} and no evidence proved a false alarm (sql-comments: "migrations/001.sql": it changes more than plain comments); decide: studio exceptions grant org/app#9 sql-comments --reason "<one line>", or a fix through a crew`,
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
    expect(readExceptions(r.state)).toMatchObject([
      { outcome: 'not_proven', proof: 'comments_only' },
    ]);
    expect(await judge(r)).toEqual(v);
    expect(readExceptions(r.state)).toHaveLength(1);
  });

  it('comments_only: a comment marker in a string, and dollar-quoted SQL, are code', async () => {
    const sql = "SELECT '-- a';\nCREATE FUNCTION f() AS $$ SELECT 1 -- x\n$$;\n";
    for (const head of [sql.replace("'-- a'", "'-- b'"), sql.replace('-- x', '-- y')]) {
      const r = makeRepo({ sql, change: (dir) => migration(dir, head) });
      expect(await whyOf(r)).toMatch(/changes more than plain comments/);
    }
    const comment = makeRepo({ sql, change: (dir) => migration(dir, `-- why\n${sql}`) });
    expect((await judge(comment)).kind).toBe('waived');
  });

  it.each([
    [
      'an added file',
      (d: string) => writeFileSync(join(d, 'migrations/002.sql'), '-- new\n'),
      /is added/,
    ],
    ['a deleted file', (d: string) => unlinkSync(join(d, 'migrations/001.sql')), /is deleted/],
    [
      'a rename with a change',
      (d: string) => {
        renameSync(join(d, 'migrations/001.sql'), join(d, 'migrations/001-a.sql'));
        commentOnly(d);
      },
      /is (added|deleted)/,
    ],
    [
      'a mode change',
      (d: string) => chmodSync(join(d, 'migrations/001.sql'), 0o755),
      /changes its mode/,
    ],
    [
      'a symlink',
      (d: string) => {
        unlinkSync(join(d, 'migrations/001.sql'));
        symlinkSync('../docs/guide.md', join(d, 'migrations/001.sql'));
      },
      /not a plain change|changes its mode|no regular file/,
    ],
    [
      'a binary file',
      (d: string) => writeFileSync(join(d, 'migrations/001.sql'), Buffer.from([0x43, 0, 0x41])),
      /binary/,
    ],
    [
      'a file in no listed language',
      (d: string) => writeFileSync(join(d, 'migrations/x.rs'), 'fn a() {}\n'),
      /is added|in none of the languages/,
    ],
  ])('comments_only: %s proves nothing', async (_what, change, why) => {
    const r = makeRepo({ change });
    expect(await whyOf(r)).toMatch(why);
  });

  it('every proof covers every changed file: one outside the paths proves nothing', async () => {
    const elsewhere = makeRepo({
      change: (d) => {
        commentOnly(d);
        writeFileSync(join(d, 'scripts/migration-guard.mjs'), 'process.exit(0);\n');
      },
    });
    expect(await whyOf(elsewhere)).toMatch(/"scripts\/migration-guard.mjs" is outside the paths/);
    const docsOnly = makeRepo({
      change: (d) => writeFileSync(join(d, 'docs/guide.md'), '# Guide 2\n'),
    });
    expect(await whyOf(docsOnly)).toMatch(/"docs\/guide.md" is outside the paths/);
  });

  it('comments_only reads the exact bytes: invalid UTF-8, a lone CR or a backslash proves nothing', async () => {
    const cases: [string, Buffer, RegExp][] = [
      [
        'invalid UTF-8',
        Buffer.from([0x2d, 0x2d, 0x20, 0xff, 0x0a, ...Buffer.from('CREATE TABLE a (id int);\n')]),
        /not valid UTF-8/,
      ],
      [
        'a lone CR',
        Buffer.from('-- a\rDROP TABLE a;\nCREATE TABLE a (id int);\n'),
        /carriage return without a line feed/,
      ],
      ['a backslash', Buffer.from('-- a \\\nCREATE TABLE a (id int);\n'), /a backslash/],
    ];
    for (const [, bytes, why] of cases) {
      const r = makeRepo({ change: (d) => writeFileSync(join(d, 'migrations/001.sql'), bytes) });
      expect(await whyOf(r)).toMatch(why);
    }
  });

  it('paths_only: a docs-only change is waived; a file outside, or a rename out, is not', async () => {
    const docs = makeRepo({
      rules: DOCS_RULE,
      change: (d) => writeFileSync(join(d, 'docs/guide.md'), '# Guide, longer\n'),
    });
    expect((await judge(docs)).kind).toBe('waived');
    const code = makeRepo({ rules: DOCS_RULE, change: codeChange });
    expect(await whyOf(code)).toMatch(/"migrations\/001.sql" is outside the paths/);
    const renamed = makeRepo({
      rules: DOCS_RULE,
      change: (d) => renameSync(join(d, 'docs/guide.md'), join(d, 'guide.txt')),
    });
    // both sides of a rename count: the new path lies outside
    expect(await whyOf(renamed)).toMatch(/"guide.txt" is outside the paths/);
  });

  it('paths_only: a path with a control character proves nothing', async () => {
    const r = makeRepo({
      rules: DOCS_RULE,
      change: (d) => writeFileSync(join(d, 'docs/a\u0001b.md'), 'x\n'),
    });
    expect(await whyOf(r)).toMatch(/a changed path has a control character/);
  });

  it('paths_only matches case-sensitively: docs/** never covers DOCS/run.sh', async () => {
    expect(matchGlobExact('docs/**', 'DOCS/run.sh')).toBe(false);
    expect(matchGlobExact('docs/**', 'docs/run.sh')).toBe(true);
    // a glob over the limits matches nothing here
    expect(matchGlobExact('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}', 'acegikm')).toBe(false);
    // a directory that does not exist yet, so a case-insensitive file system cannot fold it
    const rule = DOCS_RULE.replace('["docs/**", "**/*.md"]', '["notes/**"]');
    const r = makeRepo({
      rules: rule,
      change: (d) => {
        mkdirSync(join(d, 'NOTES'));
        writeFileSync(join(d, 'NOTES/run.sh'), 'rm -rf /\n');
      },
    });
    expect(await whyOf(r)).toMatch(/"NOTES\/run.sh" is outside the paths/);
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
    expect(
      await judgeFailedChecks(ctxFor(r, fakeGh(r).gh), ref, r.head, [guardFail, lint]),
    ).toEqual({ kind: 'none' });
    expect(readExceptions(r.state)).toEqual([]);
  });

  it('rules come only from studio.yaml at the base: one the pull request adds counts for nothing', async () => {
    const r = makeRepo({
      rules: '',
      change: (dir) => {
        writeFileSync(
          join(dir, '.studio/studio.yaml'),
          studioYaml(DOCS_RULE.replace('"docs/**", ', '"**", ')),
        );
        codeChange(dir);
      },
    });
    expect(await judge(r)).toEqual({ kind: 'none' });
    expect(await evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head)).toEqual({
      problem: 'the pull request changes evidence: in studio.yaml',
      area: 'evidence',
    });
  });

  it("a pull request that changes a component's release block gets no approval either", async () => {
    const release = `components:
  - id: api
    name: API
    repo: org/app
    paths: ["migrations/**"]
    release:
      workflow: .github/workflows/ci.yml
      post_checks: [{ workflow: .github/workflows/ci.yml, job: test }]
      rollback: { text: redeploy the previous commit }
      approvers: [{ id: partner, who: the partner }]
`;
    const r = makeRepo({
      rules: `${RULE}${release}`,
      change: (dir) => {
        writeFileSync(
          join(dir, '.studio/studio.yaml'),
          studioYaml(
            `${RULE}${release.replace('      approvers: [{ id: partner, who: the partner }]\n', '')}`,
          ),
        );
      },
    });
    expect(await evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head)).toEqual({
      problem: "the pull request changes a component's release: in studio.yaml",
      area: 'release',
    });
    // Moving the same block elsewhere in the file changes nothing.
    const same = makeRepo({
      rules: `${RULE}${release}`,
      change: (dir) => {
        writeFileSync(
          join(dir, '.studio/studio.yaml'),
          studioYaml(`${RULE}${release}`).replace(
            'deploy_commands: []\n',
            'deploy_commands: []\n# a comment\n',
          ),
        );
      },
    });
    expect(await evidenceChange(ctxFor(same, fakeGh(same).gh), same.base, same.head)).toEqual({});
  });

  it('a pull request that changes .studio/board.yaml gets no approval: the board is the owner’s', async () => {
    const r = makeRepo({
      change: (dir) => {
        writeFileSync(join(dir, '.studio/board.yaml'), 'items: []\n');
        codeChange(dir);
      },
    });
    expect(await evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head)).toEqual({
      problem: 'the pull request changes .studio/board.yaml',
      area: 'board',
    });
  });

  it('the research block is the owner’s: adding, changing or removing it gets no approval', async () => {
    const research = 'research:\n  artifacts: /analysis/target\n';
    const added = makeRepo({
      change: (dir) => writeFileSync(join(dir, '.studio/studio.yaml'), studioYaml(RULE) + research),
    });
    expect(await evidenceChange(ctxFor(added, fakeGh(added).gh), added.base, added.head)).toEqual({
      problem: 'the pull request changes research: in studio.yaml',
      area: 'research',
    });
    const moved = makeRepo({
      rules: RULE + research,
      change: (dir) =>
        writeFileSync(
          join(dir, '.studio/studio.yaml'),
          studioYaml(RULE + research.replace('/analysis/target', '/analysis/other')),
        ),
    });
    expect(
      (await evidenceChange(ctxFor(moved, fakeGh(moved).gh), moved.base, moved.head)).area,
    ).toBe('research');
    const removed = makeRepo({
      rules: RULE + research,
      change: (dir) => writeFileSync(join(dir, '.studio/studio.yaml'), studioYaml(RULE)),
    });
    expect(
      (await evidenceChange(ctxFor(removed, fakeGh(removed).gh), removed.base, removed.head)).area,
    ).toBe('research');
  });

  it('reads what a pull request adds in the owner checkout, line by line, and flags odd files', async () => {
    const r = makeRepo({
      change: (dir) => {
        mkdirSync(join(dir, 'docs/research'), { recursive: true });
        writeFileSync(join(dir, 'docs/guide.md'), '# Guide\nnew line\n');
        writeFileSync(join(dir, 'docs/research/APP-2-x.md'), 'a\nb\nc\n');
        writeFileSync(join(dir, 'docs/research/blob.bin'), Buffer.from([0, 1, 2, 0]));
        symlinkSync('../guide.md', join(dir, 'docs/research/ln'));
        writeFileSync(join(dir, 'odd "name".md'), 'q\n');
      },
    });
    const files = await addedInPullRequest(ctxFor(r, fakeGh(r).gh), r.base, r.head);
    const by = Object.fromEntries((files ?? []).map((f) => [f.path, f]));
    expect(by['docs/guide.md']).toEqual({
      path: 'docs/guide.md',
      lines: [{ line: 2, text: 'new line' }],
    });
    expect(by['docs/research/APP-2-x.md']?.lines.map((l) => l.line)).toEqual([1, 2, 3]);
    expect(by['docs/research/blob.bin']?.odd).toBe('binary');
    expect(by['docs/research/ln']?.odd).toBe('link');
    // A path git quotes in the patch is not read line by line: it fails closed.
    expect(by['odd "name".md']?.odd).toBe('unreadable');
    expect(await addedInPullRequest(ctxFor(r, fakeGh(r).gh), undefined, r.head)).toBeUndefined();
  });

  it('a release keeps its whole component, its workflows and the crew workflow list the owner’s', async () => {
    const release = `components:
  - id: api
    name: API
    repo: org/app
    paths: ["migrations/**"]
    release:
      workflow: .github/workflows/ci.yml
      post_checks: [{ workflow: .github/workflows/ci.yml, job: test }]
      rollback: { text: redeploy the previous commit }
`;
    const yaml = (r: string) => studioYaml(`${RULE}${r}`);
    const changeOf = async (change: (dir: string) => void) => {
      const r = makeRepo({ rules: `${RULE}${release}`, change });
      return evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head);
    };
    // The component's paths decide what the note lists and which approvals it needs.
    expect(
      await changeOf((dir) =>
        writeFileSync(
          join(dir, '.studio/studio.yaml'),
          yaml(release.replace('paths: ["migrations/**"]', 'paths: ["docs/**"]')),
        ),
      ),
    ).toEqual({
      problem: "the pull request changes a component's release: in studio.yaml",
      area: 'release',
    });
    // A crew workflow list could reach the deploy by name.
    expect(
      await changeOf((dir) =>
        writeFileSync(
          join(dir, '.studio/studio.yaml'),
          yaml(release).replace(
            'deploy_commands: []\n',
            'deploy_commands: []\ncrew_allowed_workflows: [ci]\n',
          ),
        ),
      ),
    ).toMatchObject({ area: 'release' });
    // The release workflow's content.
    expect(
      await changeOf((dir) =>
        writeFileSync(join(dir, '.github/workflows/ci.yml'), `${CI}# deploy elsewhere\n`),
      ),
    ).toEqual({
      problem:
        'the pull request changes ".github/workflows/ci.yml", a workflow a component\'s release starts',
      area: 'release',
    });
    // Anything else stays the crew's.
    expect(
      await changeOf((dir) => writeFileSync(join(dir, 'docs/guide.md'), '# Guide, longer\n')),
    ).toEqual({});
  });

  it('with a release, all workflows, actions and guarded paths are the owner’s', async () => {
    const release = `components:
  - id: api
    name: API
    repo: org/app
    paths: ["migrations/**"]
    release:
      workflow: .github/workflows/ci.yml
      post_checks: [{ workflow: .github/workflows/ci.yml, job: test }]
      rollback: { text: redeploy the previous commit }
      guarded_paths: ["scripts/deploy/**"]
`;
    const changeOf = async (rules: string, path: string) => {
      const r = makeRepo({
        rules,
        change: (dir) => {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), 'x: 1\n');
        },
      });
      return evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head);
    };
    expect(await changeOf(`${RULE}${release}`, '.github/workflows/other.yml')).toEqual({
      problem:
        'the pull request changes ".github/workflows/other.yml"; with a release, .github is the owner\'s',
      area: 'release',
    });
    expect(await changeOf(`${RULE}${release}`, '.github/actions/setup/action.yml')).toMatchObject({
      area: 'release',
    });
    expect(await changeOf(`${RULE}${release}`, 'scripts/deploy/run.sh')).toEqual({
      problem: 'the pull request changes "scripts/deploy/run.sh", a guarded path of a release',
      area: 'release',
    });
    // All of .github, the scope of the pin, not only workflows and actions.
    expect(await changeOf(`${RULE}${release}`, '.github/CODEOWNERS')).toMatchObject({
      area: 'release',
    });
    // A link on the way to a guarded path redirects it.
    const linked = makeRepo({
      rules: `${RULE}${release}`,
      change: (dir) => symlinkSync('/tmp', join(dir, 'scripts/deploy')),
    });
    expect(
      await evidenceChange(ctxFor(linked, fakeGh(linked).gh), linked.base, linked.head),
    ).toEqual({
      problem:
        'the pull request adds a link or submodule at "scripts/deploy"; with a release the repository holds none',
      area: 'release',
    });
    // A link anywhere, also where only a wildcard glob could reach: the repository holds none.
    const anywhere = makeRepo({
      rules: `${RULE}${release.replace('"scripts/deploy/**"', '"scripts/*/deploy/**"')}`,
      change: (dir) => symlinkSync('/tmp', join(dir, 'docs/x')),
    });
    expect(
      await evidenceChange(ctxFor(anywhere, fakeGh(anywhere).gh), anywhere.base, anywhere.head),
    ).toMatchObject({ area: 'release' });
    // Without any release, a workflow change is no owner matter here.
    expect(await changeOf(RULE, '.github/workflows/other.yml')).toEqual({});
    expect(await changeOf(`${RULE}${release}`, 'scripts/other.sh')).toEqual({});
    // Seven repositories with git: seconds under a full parallel run.
  }, 30_000);

  it('with a release, all of studio.yaml is the owner’s, in any spelling, but stacks', async () => {
    const release = `components:
  - id: api
    name: API
    repo: org/app
    paths: ["migrations/**"]
    release:
      workflow: .github/workflows/ci.yml
      post_checks: [{ workflow: .github/workflows/ci.yml, job: test }]
      rollback: { text: redeploy the previous commit }
`;
    const base = studioYaml(`${RULE}${release}`);
    const changeOf = async (to: string) => {
      const r = makeRepo({
        rules: `${RULE}${release}`,
        change: (dir) => writeFileSync(join(dir, '.studio/studio.yaml'), to),
      });
      return evidenceChange(ctxFor(r, fakeGh(r).gh), r.base, r.head);
    };
    // The camelCase spelling of a key beside the snake_case one.
    expect(
      await changeOf(
        base.replace(
          'deploy_commands: []\n',
          'deploy_commands: []\ncrewAllowedWorkflows: ["Deploy API"]\n',
        ),
      ),
    ).toMatchObject({ area: 'release' });
    expect(
      await changeOf(
        base.replace(
          'deploy_commands: []\n',
          'deploy_commands: []\ncrew_allowed_workflows: []\ncrewAllowedWorkflows: ["Deploy API"]\n',
        ),
      ),
    ).toEqual({
      problem: 'the pull request writes "crewAllowedWorkflows" in two spellings in studio.yaml',
      area: 'release',
    });
    // Any other key: the owner's while a release exists.
    expect(await changeOf(base.replace('owner_only: []', 'owner_only: ["x"]'))).toEqual({
      problem:
        "the pull request changes studio.yaml beyond stacks; with a release it is the owner's",
      area: 'release',
    });
    // stacks is the crew's.
    expect(await changeOf(`${base}stacks: [node]\n`)).toEqual({});
  }, 30_000);

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
    expect(await whyOf(r)).toMatch(/sql-comments: the guard job changed in this pull request/);
  });

  it('a later push is another head: the exception does not carry over', async () => {
    const r = makeRepo({ change: commentOnly });
    expect((await judge(r)).kind).toBe('waived');
    git(r.project, 'checkout', '-q', 'studio/APP-2');
    codeChange(r.project);
    git(r.project, 'commit', '-q', '-am', 'more');
    git(r.project, 'push', '-q', 'origin', 'studio/APP-2');
    const later = { ...r, head: git(r.project, 'rev-parse', 'HEAD') };
    git(r.project, 'checkout', '-q', 'main');
    expect((await judge(later)).kind).toBe('lead');
  });

  it('an unreadable pull request is retried, unlogged, then goes to the lead', async () => {
    const r = makeRepo({ change: commentOnly });
    const { gh } = fakeGh(r, (l) =>
      l.startsWith('pr view 9 --repo org/app --json files,') ? { code: 1 } : undefined,
    );
    for (let i = 1; i < MAX_RETRIES; i++) {
      expect(await judge(r, gh)).toEqual({
        kind: 'wait',
        reason: 'evidence: the pull request cannot be read; tried again',
      });
    }
    const last = await judge(r, gh);
    expect(last).toMatchObject({ kind: 'lead', owner: false });
    if (last.kind === 'lead')
      expect(last.reason).toMatch(/after 5 tries: the pull request cannot be read/);
    expect(readExceptions(r.state)).toEqual([]);
  });

  it('a pull request against another branch than the default gets no exception', async () => {
    const r = makeRepo({ change: commentOnly });
    const { gh } = fakeGh(r, (l) =>
      l.startsWith('repo view')
        ? { stdout: JSON.stringify({ defaultBranchRef: { name: 'trunk' } }) }
        : undefined,
    );
    expect(await judge(r, gh)).toEqual({ kind: 'none' });
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
      const r = makeRepo({
        rules: `${RULE}    owner_only: true\n${DOCS_RULE}`,
        change: codeChange,
      });
      await expect(
        grantException(ctxFor(r, fakeGh(r).gh), ref, 'docs-only', 'lead', 'x'),
      ).rejects.toThrow(/evidence rule sql-comments on the same guard is owner_only/);
      // a lead entry in the log (written by hand, or by an older Studio) does not hold either
      recordException(r.state, {
        v: 1,
        at: '2026-11-05T09:00:00.000Z',
        outcome: 'applied',
        by: 'lead',
        rule: 'docs-only',
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
      if (v.kind === 'lead') expect(v.reason).toMatch(/^evidence \(owner\): /);
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
  const B1 = 'b'.repeat(40);
  const B2 = 'c'.repeat(40);
  const gh = (bases: string[] = [B1]): { gh: Gh; merged: string[] } => {
    const merged: string[] = [];
    let k = 0;
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
          if (l.includes('--json baseRefOid')) {
            const base = bases[Math.min(k++, bases.length - 1)];
            return { code: 0, stdout: JSON.stringify({ baseRefOid: base }), stderr: '' };
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
  const waived = (base: string) => ({
    kind: 'waived' as const,
    waived: new Set([checkKey(guardFail)]),
    base,
  });
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
          return waived(B1);
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
  it('a base that moved right before the merge: judged again on the new base, then merged', async () => {
    // the waiver was judged on B1; GitHub then reports B2 right before the merge
    const g = gh([B2]);
    let judged = 0;
    const out = await mergeOne(
      { repo: 'org/app', pr: 9, step: 'checks' },
      config,
      ports(g.gh),
      () => {},
      {
        evidence: async () => (++judged <= 2 ? waived(B1) : waived(B2)),
      },
    );
    expect(out.result).toBe('merged');
    expect(judged).toBeGreaterThanOrEqual(3);
    expect(g.merged).toHaveLength(1);
  });
  it('a base that moved where no evidence holds stops the merge', async () => {
    const g = gh([B2]);
    let judged = 0;
    const out = await mergeOne(
      { repo: 'org/app', pr: 9, step: 'checks' },
      config,
      ports(g.gh),
      () => {},
      {
        evidence: async () =>
          ++judged <= 2 ? waived(B1) : { kind: 'lead', reason: 'evidence: on the new base' },
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
  const setup = (change: (dir: string) => void, rules?: string) => {
    const r = makeRepo({ change, ...(rules === undefined ? {} : { rules }) });
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
  const portsFor = (gh: Gh): Ports => {
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

  it('an approval with a guard the proof explains is stored, with the exception', async () => {
    const r = setup(commentOnly);
    const res = await cli(r, portsFor(checksGh(r).gh), false, 'collect', 'APP-1');
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

  it('a guard the proof does not explain: nothing moves, the lead decides and can grant', async () => {
    const r = setup(codeChange);
    const ports = portsFor(checksGh(r).gh);
    const res = await cli(r, ports, false, 'collect', 'APP-1');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/no evidence proved a false alarm \(sql-comments: /);
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

  it('a pull request that changes the evidence rules gets no approval: blocked for the owner', async () => {
    const r = setup((dir) => {
      writeFileSync(
        join(dir, '.studio/studio.yaml'),
        studioYaml(RULE.replace('[sql]', '[sql, sh]')),
      );
    });
    const res = await cli(r, portsFor(checksGh(r, [testPass]).gh), false, 'collect', 'APP-1');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/changes evidence: in studio.yaml; evidence is the owner's/);
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-1')?.status).toBe('blocked');
    expect(loadBoard(r.project).items.find((i) => i.id === 'APP-2')?.approvedHead).toBeUndefined();
  });

  it('that check runs from the base, also when the owner checkout has no rules', async () => {
    const r = setup(
      (dir) => writeFileSync(join(dir, '.studio/studio.yaml'), studioYaml(DOCS_RULE)),
      '',
    );
    writeFileSync(join(r.project, '.studio/studio.yaml'), studioYaml(''));
    const res = await cli(r, portsFor(checksGh(r, [testPass]).gh), false, 'collect', 'APP-1');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/changes evidence: in studio.yaml/);
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
