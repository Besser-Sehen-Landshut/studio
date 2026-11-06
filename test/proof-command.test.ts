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
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_COMMANDS, ownerConfigSchema, parseConfig } from '../src/config.js';
import {
  type EvidenceContext,
  judgeFailedChecks,
  type ProofCommands,
  proofCommandsFor,
  readExceptions,
} from '../src/evidence.js';
import { stateRootFor } from '../src/paths.js';
import type { Gh } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import {
  type ProofRunner,
  realProofRunner,
  type SandboxPlan,
  type SandboxRun,
  sandboxUnavailable,
} from '../src/proof-sandbox.js';
import type { Check } from '../src/queue.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-proof-cmd-')));
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
  migration-guard:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/migration-guard.mjs
`;
const RULE = `  - id: lint-migrations
    guard: { workflow: .github/workflows/ci.yml, job: migration-guard }
    proof: command
    command: [node, scripts/prove.mjs, --strict]
    timeout_seconds: 30
    paths: ["migrations/**"]
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

let n = 0;
interface Repo {
  project: string;
  home: string;
  state: string;
  base: string;
  head: string;
}

/** main with studio.yaml (`rules`), CI, a prove script and a migration; a head that applies `change`. */
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
  write('.github/workflows/ci.yml', CI);
  write('scripts/migration-guard.mjs', 'process.exit(1);\n');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the script's own template literal
  write('scripts/prove.mjs', 'console.log(`proven ${process.env.STUDIO_PROOF_NONCE}`);\n');
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
    state: stateRootFor(project, { env, homedir: home }),
    base: baseSha,
    head,
  };
}

const migrate = (dir: string) =>
  writeFileSync(join(dir, 'migrations/001.sql'), 'CREATE TABLE a (id int, b text);\n');

function fakeGh(repo: Pick<Repo, 'base' | 'head'>): Gh {
  return {
    async api() {
      return '';
    },
    async run(args) {
      const l = args.join(' ');
      const out = l.startsWith('pr view 9 --repo org/app --json files,')
        ? {
            headRefOid: repo.head,
            baseRefName: 'main',
            baseRefOid: repo.base,
            title: 't',
            body: '',
            isCrossRepository: false,
            changedFiles: 1,
            files: [{ path: 'migrations/001.sql', additions: 1, deletions: 1 }],
          }
        : l.startsWith('pr view 9 --repo org/app --json headRefOid,headRefName')
          ? {
              headRefOid: repo.head,
              headRefName: 'studio/APP-2',
              headRepository: { name: 'app' },
              headRepositoryOwner: { login: 'org' },
              isCrossRepository: false,
              baseRefOid: repo.base,
            }
          : l.startsWith('repo view org/app --json defaultBranchRef')
            ? { defaultBranchRef: { name: 'main' } }
            : undefined;
      if (out === undefined) throw new Error(`unscripted gh call: ${l}`);
      return { code: 0, stdout: JSON.stringify(out), stderr: '' };
    },
  };
}

/** A runner that records each call and answers with `answer`, given what the command would see. */
function fakeRunner(
  answer: (seen: {
    argv: readonly string[];
    env: Record<string, string>;
    plan: SandboxPlan;
  }) => SandboxRun,
  unavailable?: string,
) {
  const calls: {
    argv: readonly string[];
    env: Record<string, string>;
    plan: SandboxPlan;
    files: Record<string, string>;
  }[] = [];
  const runner: ProofRunner = {
    async unavailable() {
      return unavailable;
    },
    async run(argv, env, plan) {
      // what lies in the run dir while the command runs (it is removed afterwards)
      const files = {
        baseScript: readFileSync(join(plan.cwd, 'scripts/prove.mjs'), 'utf8'),
        headMigration: readFileSync(
          join(env.STUDIO_PROOF_HEAD_TREE as string, 'migrations/001.sql'),
          'utf8',
        ),
        diff: readFileSync(env.STUDIO_PROOF_DIFF as string, 'utf8'),
        files: readFileSync(env.STUDIO_PROOF_FILES as string, 'utf8'),
      };
      calls.push({ argv, env, plan, files });
      return answer({ argv, env, plan });
    },
  };
  return { runner, calls };
}

const commands = (runner: ProofRunner, allowed = true): ProofCommands => ({
  allowed,
  runner,
  read: [],
  deny: [],
});
const ctxFor = (r: Repo, c: ProofCommands | undefined): EvidenceContext => ({
  gh: fakeGh(r),
  git: realPorts().git,
  checkout: { dir: r.project, remote: 'origin' },
  stateRoot: r.state,
  now: () => new Date('2026-11-06T10:00:00Z'),
  ...(c === undefined ? {} : { commands: c }),
});
const ref = { repo: 'org/app', pr: 9, item: 'APP-2' };
const guardFail: Check = { name: 'migration-guard', bucket: 'fail', workflow: 'CI' };
const judge = (r: Repo, c: ProofCommands | undefined) =>
  judgeFailedChecks(ctxFor(r, c), ref, r.head, [guardFail]);
const proven = ({ env }: { env: Record<string, string> }): SandboxRun => ({
  kind: 'exited',
  code: 0,
  stdout: `checked\nproven ${env.STUDIO_PROOF_NONCE}\n`,
  tooLarge: false,
});

describe('proof: command in studio.yaml', () => {
  const load = (rules: string) => parseConfig(studioYaml(rules), 'studio.yaml');
  const rule = (lines: string) =>
    `  - id: x\n    guard: { workflow: .github/workflows/ci.yml, job: g }\n    paths: ["a/**"]\n${lines}`;
  it('takes a command and a timeout, 60 s by default', () => {
    expect(load(RULE).evidence?.[0]).toMatchObject({
      proof: 'command',
      command: ['node', 'scripts/prove.mjs', '--strict'],
      timeoutSeconds: 30,
    });
    expect(
      load(rule('    proof: command\n    command: [prove]\n')).evidence?.[0]?.timeoutSeconds,
    ).toBe(60);
  });
  it('refuses what does not fit', () => {
    expect(() => load(rule('    proof: command\n'))).toThrow(/needs the command to run/);
    expect(() => load(rule('    proof: paths_only\n    command: [x]\n'))).toThrow(
      /only proof: command takes a command/,
    );
    expect(() => load(rule('    proof: paths_only\n    timeout_seconds: 5\n'))).toThrow(
      /only proof: command takes timeout_seconds/,
    );
    expect(() => load(rule('    proof: command\n    command: [-rf]\n'))).toThrow(
      /must not start with -/,
    );
    expect(() => load(rule('    proof: command\n    command: [node, ../x.mjs]\n'))).toThrow(
      /no \.\. in a path/,
    );
    expect(() => load(rule('    proof: command\n    command: ["a\\nb"]\n'))).toThrow(
      /no control characters/,
    );
    expect(() =>
      load(rule('    proof: command\n    command: [x]\n    timeout_seconds: 601\n')),
    ).toThrow();
    expect(() => load(rule('    proof: command\n    command: [x]\n    run: ci\n'))).toThrow(
      NO_COMMANDS,
    );
    expect(() => load(rule('    proof: command\n    command: [x]\n    inputs: [a]\n'))).toThrow(
      NO_COMMANDS,
    );
  });
  it('the owner config allows proof commands only when it says so', () => {
    expect(ownerConfigSchema.parse({}).allowProofCommands).toBe(false);
    expect(ownerConfigSchema.parse({ allowProofCommands: true }).allowProofCommands).toBe(true);
  });
});

describe('a proof command, judged', { timeout: 60_000 }, () => {
  it('runs nothing unless the owner config allows it', async () => {
    const r = makeRepo({ change: migrate });
    const f = fakeRunner(proven);
    for (const c of [undefined, commands(f.runner, false)]) {
      const v = await judge(r, c);
      expect(v.kind).toBe('lead');
      expect(v.kind === 'lead' && v.reason).toMatch(/proof commands are off on this machine/);
    }
    expect(f.calls).toHaveLength(0);
  });
  it('never runs without a sandbox', async () => {
    const r = makeRepo({ change: migrate });
    const f = fakeRunner(proven, 'bubblewrap (bwrap) is not installed');
    const v = await judge(r, commands(f.runner));
    expect(v.kind === 'lead' && v.reason).toMatch(
      /no sandbox: bubblewrap \(bwrap\) is not installed/,
    );
    expect(f.calls).toHaveLength(0);
  });
  it('proves with the nonce line: runs from the base, reads the head as data, logs the command', async () => {
    const r = makeRepo({
      change: (dir) => {
        migrate(dir);
        // the pull request's own prove script never runs: the base's does
        writeFileSync(join(dir, 'scripts/prove.mjs'), 'console.log("hacked");\n');
      },
    });
    const f = fakeRunner(proven);
    // the rule covers migrations only; the changed script is outside it
    const v = await judge(r, commands(f.runner));
    expect(v.kind).toBe('lead');
    expect(f.calls).toHaveLength(0);
    const r2 = makeRepo({ change: migrate });
    const f2 = fakeRunner(proven);
    const v2 = await judge(r2, commands(f2.runner));
    expect(v2.kind).toBe('waived');
    const call = f2.calls[0];
    expect(call?.argv).toEqual(['node', 'scripts/prove.mjs', '--strict']);
    expect(call?.files.baseScript).toContain('STUDIO_PROOF_NONCE');
    expect(call?.files.headMigration).toBe('CREATE TABLE a (id int, b text);\n');
    expect(call?.files.diff).toContain('+CREATE TABLE a (id int, b text);');
    expect(call?.files.files).toBe('migrations/001.sql\0');
    expect(call?.plan.cwd).toBe(join(call?.plan.run as string, 'base'));
    expect(
      Object.keys(call?.env ?? {})
        .filter((k) => !k.startsWith('STUDIO_PROOF_'))
        .sort(),
    ).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']);
    expect(call?.env.STUDIO_PROOF_NONCE).toMatch(/^[0-9a-f]{32}$/);
    // the run dir is gone afterwards
    expect(existsSync(call?.plan.run as string)).toBe(false);
    const [entry] = readExceptions(r2.state);
    expect(entry).toMatchObject({
      outcome: 'applied',
      by: 'evidence',
      proof: 'command',
      command: ['node', 'scripts/prove.mjs', '--strict'],
    });
  });
  it('a rule that only the pull request adds runs nothing', async () => {
    const r = makeRepo({
      rules: '',
      change: (dir) => {
        migrate(dir);
        writeFileSync(join(dir, '.studio/studio.yaml'), studioYaml(RULE));
      },
    });
    const f = fakeRunner(proven);
    expect((await judge(r, commands(f.runner))).kind).toBe('none');
    expect(f.calls).toHaveLength(0);
  });
  it('without the nonce line, with an echoed line, a failed exit or a timeout: not proven, and never run again', async () => {
    type Answer = (s: { env: Record<string, string> }) => SandboxRun;
    const answers: Answer[] = [
      () => ({ kind: 'exited', code: 0, stdout: 'ok\n', tooLarge: false }),
      // a line from the diff cannot hold the nonce
      () => ({
        kind: 'exited',
        code: 0,
        stdout: 'proven 0123456789abcdef0123456789abcdef\n',
        tooLarge: false,
      }),
      (s) => ({
        kind: 'exited',
        code: 1,
        stdout: `proven ${s.env.STUDIO_PROOF_NONCE}\n`,
        tooLarge: false,
      }),
      (s) => ({
        kind: 'exited',
        code: 0,
        stdout: `proven ${s.env.STUDIO_PROOF_NONCE}\n`,
        tooLarge: true,
      }),
      () => ({ kind: 'timeout' }),
    ];
    const whys = [
      /lacks the proof line/,
      /lacks the proof line/,
      /exit code 1/,
      /over 1 MiB/,
      /timed out after 30 s/,
    ];
    for (const [i, answer] of answers.entries()) {
      const why = whys[i] as RegExp;
      const r = makeRepo({ change: migrate });
      const f = fakeRunner(answer);
      const v = await judge(r, commands(f.runner));
      expect(v.kind === 'lead' && v.reason, String(why)).toMatch(why);
      await judge(r, commands(f.runner));
      expect(f.calls).toHaveLength(1);
      expect(readExceptions(r.state).filter((e) => e.outcome === 'not_proven')).toHaveLength(1);
    }
  });
  it('a refusal before the run does not hide the answer of a later run', async () => {
    const r = makeRepo({ change: migrate });
    const off = fakeRunner(proven);
    await judge(r, commands(off.runner, false));
    const on = fakeRunner(() => ({ kind: 'exited', code: 2, stdout: '', tooLarge: false }));
    await judge(r, commands(on.runner));
    await judge(r, commands(on.runner));
    expect(on.calls).toHaveLength(1);
  });
  it('a start failure is tried again, unlogged', async () => {
    const r = makeRepo({ change: migrate });
    const f = fakeRunner(() => ({ kind: 'failed', why: 'cannot start: ENOENT' }));
    const v = await judge(r, commands(f.runner));
    expect(v.kind).toBe('wait');
    expect(readExceptions(r.state)).toHaveLength(0);
  });
});

describe('what a proof command may read', () => {
  it('nothing extra and no permission by default; a toolchain path that fails its check turns them off', () => {
    const home = join(root, 'owner-home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const base = {
      env: {},
      homedir: home,
      projectDir: join(root, 'p'),
      stateRoot: join(root, 's'),
    };
    const off = proofCommandsFor({
      ...base,
      ownerConfig: { allowProofCommands: false, crewToolchainPaths: [] },
    });
    expect(off.allowed).toBe(false);
    expect(off.deny).toEqual(expect.arrayContaining([home, join(home, '.claude')]));
    const bad = proofCommandsFor({
      ...base,
      ownerConfig: { allowProofCommands: true, crewToolchainPaths: [join(home, '.ssh')] },
    });
    expect(bad.off).toMatch(/crew_toolchain_paths/);
  });
});

const why = sandboxUnavailable();
describe.skipIf(why !== undefined)(
  `a proof command end to end in the real sandbox${why === undefined ? '' : ` (skipped: ${why})`}`,
  () => {
    it('the base script proves the head, sandboxed', async () => {
      const r = makeRepo({
        rules: RULE.replace(
          '[node, scripts/prove.mjs, --strict]',
          `[${JSON.stringify(process.execPath)}, scripts/prove.mjs]`,
        ),
        change: migrate,
      });
      const c = proofCommandsFor({
        ownerConfig: {
          allowProofCommands: true,
          crewToolchainPaths: [realpathSync(dirname(dirname(process.execPath)))],
        },
        env: {},
        homedir: r.home,
        projectDir: r.project,
        stateRoot: r.state,
        runner: realProofRunner,
      });
      expect(c.off).toBeUndefined();
      const v = await judge(r, c);
      expect(v.kind, JSON.stringify(v)).toBe('waived');
    });
  },
);
