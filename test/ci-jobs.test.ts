import { describe, expect, it } from 'vitest';
import { approvedJobsProblem, verifyNotRunHereJobs } from '../src/ci-jobs.js';
import type { Git } from '../src/ports.js';
import type { Check } from '../src/queue.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const CI = `name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          pnpm build
          pnpm test:e2e --reporter dot
`;

/** A git that serves workflow files per commit, as the owner checkout would. */
function fakeGit(trees: Record<string, Record<string, string>>, changed: string[] = []): Git {
  return {
    run: async (_dir, args) => {
      const a = args.filter((x) => x !== '--no-replace-objects');
      if (a[0] === 'fetch') return '';
      if (a[0] === 'ls-tree') {
        const tree = trees[a[a.length - 2] as string] ?? {};
        return Object.keys(tree)
          .filter((p) => p.startsWith('.github/workflows/'))
          .map((p) => `${p}\0`)
          .join('');
      }
      if (a[0] === 'diff') {
        const path = a[a.length - 1] as string;
        return changed.includes(path) ? `${path}\0` : '';
      }
      if (a[0] === 'cat-file') {
        const spec = a[a.length - 1] as string;
        const [oid, path] = [spec.slice(0, 40), spec.slice(41)];
        const text = trees[oid]?.[path];
        if (text === undefined) throw new Error('git cat-file failed (128): missing');
        return text;
      }
      throw new Error(`unscripted git ${a.join(' ')}`);
    },
  };
}

const gate = (o: {
  base?: Record<string, string>;
  head?: Record<string, string>;
  changed?: string[];
  command?: string;
  workflow?: string;
  job?: string;
  covers?: string | null;
  ciItem?: boolean;
  checks: Check[];
}) => {
  const base = o.base ?? { '.github/workflows/ci.yml': CI };
  const covers = o.covers === undefined ? 'the job runs the e2e suite' : o.covers;
  return verifyNotRunHereJobs({
    git: fakeGit({ [BASE]: base, [HEAD]: o.head ?? base }, o.changed ?? []),
    checkout: { dir: '/x', remote: 'origin' },
    baseOid: BASE,
    headOid: HEAD,
    ciItem: o.ciItem ?? false,
    commands: [o.command ?? 'pnpm test:e2e'],
    entries: [
      {
        command: o.command ?? 'pnpm test:e2e',
        workflow: o.workflow ?? '.github/workflows/ci.yml',
        job: o.job ?? 'e2e',
        ...(covers === null ? {} : { covers }),
      },
    ],
    checks: o.checks,
  });
};
const pass = (name: string, workflow = 'CI'): Check => ({ name, bucket: 'pass', workflow });

describe('the job gate', () => {
  it('a job of the base workflow that passed, with the reviewer covers text for the lead', async () => {
    expect(await gate({ checks: [pass('e2e')] })).toEqual({
      ok: true,
      jobs: [{ workflow: 'CI', job: 'e2e' }],
      covered: [{ entry: 1, workflow: 'CI', job: 'e2e', covers: 'the job runs the e2e suite' }],
    });
  });

  it('no longer holds the command to the run steps: task runners name other commands', async () => {
    const turbo = CI.replace('pnpm test:e2e --reporter dot', 'pnpm turbo run lint test');
    const r = await gate({
      base: { '.github/workflows/ci.yml': turbo },
      command: 'pnpm --filter web test',
      checks: [pass('e2e')],
    });
    expect(r.ok).toBe(true);
  });

  it('needs a covers text that says why the job covers the command', async () => {
    for (const covers of [null, '', '   ']) {
      const r = await gate({ covers, checks: [pass('e2e')] });
      expect(r, String(covers)).toMatchObject({
        ok: false,
        entry: 1,
        why: expect.stringMatching(/covers text/),
      });
    }
  });

  it('refuses a workflow name another workflow file at the base shares', async () => {
    const integration = CI.replace('pnpm test:e2e --reporter dot', 'echo none');
    const r = await gate({
      base: { '.github/workflows/ci.yml': CI, '.github/workflows/integration.yml': integration },
      checks: [pass('e2e')],
    });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/name is not unique/) });
  });

  it('refuses a job with continue-on-error or an if', async () => {
    for (const yml of [
      CI.replace('  e2e:\n', '  e2e:\n    continue-on-error: true\n'),
      CI.replace('  e2e:\n', "  e2e:\n    if: github.actor == 'x'\n"),
    ]) {
      const r = await gate({ base: { '.github/workflows/ci.yml': yml }, checks: [pass('e2e')] });
      expect(r, yml).toMatchObject({ ok: false, why: expect.stringMatching(/if or continue/) });
    }
  });

  it('a matrix job: every instance `<job> (<leg>)` must pass, at least one must exist', async () => {
    const matrix = CI.replace('  e2e:\n', '  e2e:\n    strategy: { matrix: { node: [20, 22] } }\n');
    const base = { '.github/workflows/ci.yml': matrix };
    expect((await gate({ base, checks: [pass('e2e (20)'), pass('e2e (22)')] })).ok).toBe(true);
    expect(
      (
        await gate({
          base,
          checks: [pass('e2e (20)'), { name: 'e2e (22)', bucket: 'skipping', workflow: 'CI' }],
        })
      ).ok,
    ).toBe(false);
    // a leg is not a job
    expect((await gate({ base, job: 'e2e (20)', checks: [pass('e2e (20)')] })).ok).toBe(false);
    expect((await gate({ base, checks: [pass('e2e-other (20)')] })).ok).toBe(false);
    // a reusable call from a caller job named like the job is not an instance of it
    expect((await gate({ base, checks: [pass('e2e (20) / x')] })).ok).toBe(false);
  });

  it('a lookalike check that does not parse as the job refuses, never drops out', async () => {
    const legs = [pass('e2e (20)'), pass('e2e (22)')];
    for (const name of ['e2e (20) / x', 'e2e / x', 'e2e (20', 'e2e extra', 'e2e ()']) {
      // the lookalike failed: dropping it would let the gate pass on the two green legs
      const failed: Check = { name, bucket: 'fail', workflow: 'CI' };
      expect(await gate({ checks: [...legs, failed] }), name).toMatchObject({
        ok: false,
        why: expect.stringMatching(/does not parse/),
      });
      expect(approvedJobsProblem([{ workflow: 'CI', job: 'e2e' }], [...legs, failed])).toMatch(
        /does not parse/,
      );
    }
    // another job whose name merely starts with the same letters is another job
    expect((await gate({ checks: [...legs, { ...pass('e2e-slow'), bucket: 'fail' }] })).ok).toBe(
      true,
    );
    // a lookalike in another workflow does not touch this one
    expect(
      (await gate({ checks: [...legs, { ...pass('e2e / x', 'Other'), bucket: 'fail' }] })).ok,
    ).toBe(true);
  });

  it('a leg holding ` / ` or parentheses is a leg: everything inside the outer parentheses', async () => {
    const legs = [pass('e2e (linux / x64)'), pass('e2e (node (22))')];
    expect((await gate({ checks: legs })).ok).toBe(true);
    const failing: Check = { name: 'e2e (linux / arm64)', bucket: 'fail', workflow: 'CI' };
    expect(await gate({ checks: [...legs, failing] })).toMatchObject({
      ok: false,
      why: expect.stringMatching(/no passing check/),
    });
  });

  it('refuses a job that calls a reusable workflow: the called file and its job are named', async () => {
    const reusable = `name: CI
on: pull_request
jobs:
  e2e:
    uses: ./.github/workflows/e2e.yml
`;
    const r = await gate({ base: { '.github/workflows/ci.yml': reusable }, checks: [pass('e2e')] });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/name the called workflow/) });
  });

  it('refuses a job definition that changed at the head, unless the item is a CI item', async () => {
    const head = { '.github/workflows/ci.yml': CI.replace('pnpm build', 'pnpm build --quiet') };
    const changed = ['.github/workflows/ci.yml'];
    expect(await gate({ head, changed, checks: [pass('e2e')] })).toMatchObject({
      ok: false,
      why: expect.stringMatching(/definition changed/),
    });
    expect((await gate({ head, changed, ciItem: true, checks: [pass('e2e')] })).ok).toBe(true);
    // another job of the file may change: only the named job's definition counts
    const other = CI.replace('      - run: pnpm test\n', '      - run: pnpm test --silent\n');
    expect(
      (await gate({ head: { '.github/workflows/ci.yml': other }, checks: [pass('e2e')] })).ok,
    ).toBe(true);
  });

  it('a CI item that changed the workflow: the head version must pass the same rules', async () => {
    const guarded = CI.replace('  e2e:\n', "  e2e:\n    if: github.actor == 'x'\n");
    const r = await gate({
      head: { '.github/workflows/ci.yml': guarded },
      changed: ['.github/workflows/ci.yml'],
      ciItem: true,
      checks: [pass('e2e')],
    });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/at the pull request head/) });
  });

  it('the workflow name must be unique at the pull request head too', async () => {
    const r = await gate({
      head: {
        '.github/workflows/ci.yml': CI,
        '.github/workflows/copy.yml': CI.replace('pnpm test:e2e --reporter dot', 'echo none'),
      },
      checks: [pass('e2e')],
    });
    expect(r).toMatchObject({
      ok: false,
      why: expect.stringMatching(/not unique at the pull request head/),
    });
  });

  it('the workflow must run on pull_request, at the base and at the head', async () => {
    const on = (trigger: string) => CI.replace('on: pull_request', trigger);
    for (const [trigger, ok] of [
      ['on: push', false],
      ['on: [push, pull_request_target]', false],
      ['on: workflow_dispatch', false],
      ['on: [push, pull_request]', true],
      ['on:\n  pull_request:\n    branches: [main]', true],
    ] as const) {
      const base = { '.github/workflows/ci.yml': on(trigger) };
      expect((await gate({ base, checks: [pass('e2e')] })).ok, trigger).toBe(ok);
    }
    const r = await gate({
      head: { '.github/workflows/ci.yml': on('on: push') },
      ciItem: true,
      checks: [pass('e2e')],
    });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/pull_request.*head/) });
  });

  it('the merge re-check counts matrix instances the same way', () => {
    const jobs = [{ workflow: 'CI', job: 'e2e' }];
    expect(approvedJobsProblem(jobs, [pass('e2e (20)'), pass('e2e (22)')])).toBeUndefined();
    expect(
      approvedJobsProblem(jobs, [
        pass('e2e (20)'),
        { name: 'e2e (22)', bucket: 'skipping', workflow: 'CI' },
      ]),
    ).toMatch(/approved CI job 1/);
    expect(approvedJobsProblem(jobs, [pass('e2e', 'Other')])).toMatch(/approved CI job 1/);
  });
});

describe('the job gate with a reusable workflow', () => {
  // The shape of a monorepo: ci.yml runs on pull_request and calls one workflow per part.
  const CALLER = `name: CI
on: [pull_request, push]
jobs:
  core-server:
    uses: ./.github/workflows/core-server.yml
  packages:
    name: Packages
    uses: ./.github/workflows/packages.yml
    secrets: inherit
`;
  const CORE = `name: Core server
on: workflow_call
jobs:
  core-server-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - run: cargo nextest run --workspace --partition count:\${{ matrix.shard }}/2
`;
  const PACKAGES = `on:
  workflow_call:
jobs:
  packages:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm turbo run lint test
`;
  const TREE = {
    '.github/workflows/ci.yml': CALLER,
    '.github/workflows/core-server.yml': CORE,
    '.github/workflows/packages.yml': PACKAGES,
  };
  const core = (o: Partial<Parameters<typeof gate>[0]> = {}) =>
    gate({
      base: TREE,
      command: 'cargo test --workspace --no-fail-fast',
      workflow: '.github/workflows/core-server.yml',
      job: 'core-server-tests',
      checks: [
        pass('core-server / core-server-tests (1)'),
        pass('core-server / core-server-tests (2)'),
      ],
      ...o,
    });

  it('a called job with matrix legs: checks `<caller> / <job> (<leg>)` of the caller workflow', async () => {
    expect(await core()).toEqual({
      ok: true,
      jobs: [{ workflow: 'CI', job: 'core-server / core-server-tests' }],
      covered: [
        {
          entry: 1,
          workflow: 'CI',
          job: 'core-server / core-server-tests',
          covers: 'the job runs the e2e suite',
        },
      ],
    });
    // the caller job's name, not its id, when it has one
    const r = await gate({
      base: TREE,
      command: 'pnpm --filter web test',
      workflow: '.github/workflows/packages.yml',
      job: 'packages',
      checks: [pass('Packages / packages')],
    });
    expect(r).toMatchObject({ ok: true, jobs: [{ workflow: 'CI', job: 'Packages / packages' }] });
  });

  it('a reusable job: a failing lookalike of `<caller> / <job>` refuses, a leg with ` / ` counts', async () => {
    const legs = [
      pass('core-server / core-server-tests (1)'),
      pass('core-server / core-server-tests (2)'),
    ];
    for (const name of [
      'core-server / core-server-tests / extra',
      'core-server / core-server-tests (3',
    ]) {
      const r = await core({ checks: [...legs, { name, bucket: 'fail', workflow: 'CI' }] });
      expect(r, name).toMatchObject({ ok: false, why: expect.stringMatching(/does not parse/) });
    }
    const slashLeg: Check = {
      name: 'core-server / core-server-tests (a / b)',
      bucket: 'fail',
      workflow: 'CI',
    };
    expect(await core({ checks: [...legs, slashLeg] })).toMatchObject({
      ok: false,
      why: expect.stringMatching(/no passing check/),
    });
  });

  it('a skipped, cancelled or missing leg is not a pass', async () => {
    for (const bucket of ['skipping', 'cancel', 'fail', 'pending']) {
      const r = await core({
        checks: [
          pass('core-server / core-server-tests (1)'),
          { name: 'core-server / core-server-tests (2)', bucket, workflow: 'CI' },
        ],
      });
      expect(r, bucket).toMatchObject({
        ok: false,
        why: expect.stringMatching(/no passing check/),
      });
    }
    expect((await core({ checks: [] })).ok).toBe(false);
    // the called job's name alone, or in another workflow, does not count
    expect((await core({ checks: [pass('core-server-tests (1)')] })).ok).toBe(false);
    expect(
      (await core({ checks: [pass('core-server / core-server-tests (1)', 'Other')] })).ok,
    ).toBe(false);
  });

  it('refuses a caller job with an if or continue-on-error', async () => {
    for (const rule of ["    if: github.event_name == 'push'\n", '    continue-on-error: true\n']) {
      const caller = CALLER.replace(
        '    uses: ./.github/workflows/core-server.yml\n',
        `    uses: ./.github/workflows/core-server.yml\n${rule}`,
      );
      const r = await core({ base: { ...TREE, '.github/workflows/ci.yml': caller } });
      expect(r, rule).toMatchObject({
        ok: false,
        why: expect.stringMatching(/calling job has an if or continue-on-error at the base/),
      });
    }
  });

  it('refuses a workflow only a remote uses calls, or a named job with a remote uses', async () => {
    const remote = CALLER.replace(
      './.github/workflows/core-server.yml',
      'some-org/some-repo/.github/workflows/core-server.yml@v1',
    );
    const r = await core({ base: { ...TREE, '.github/workflows/ci.yml': remote } });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/remote/) });
    const direct = await gate({
      base: { '.github/workflows/ci.yml': remote },
      job: 'core-server',
      checks: [pass('core-server / core-server-tests')],
    });
    expect(direct).toMatchObject({ ok: false, why: expect.stringMatching(/remote/) });
  });

  it('refuses nesting of two levels', async () => {
    const mid = `name: Mid
on: workflow_call
jobs:
  inner:
    uses: ./.github/workflows/core-server.yml
`;
    const caller = CALLER.replace('core-server.yml', 'mid.yml');
    const base = { ...TREE, '.github/workflows/ci.yml': caller, '.github/workflows/mid.yml': mid };
    // the leaf is called only through another reusable workflow
    const leaf = await core({
      base,
      checks: [pass('core-server / inner / core-server-tests (1)')],
    });
    expect(leaf).toMatchObject({ ok: false, why: expect.stringMatching(/one level/) });
    // the middle job itself calls a reusable workflow
    const middle = await core({
      base,
      workflow: '.github/workflows/mid.yml',
      job: 'inner',
      checks: [pass('core-server / inner')],
    });
    expect(middle).toMatchObject({ ok: false, why: expect.stringMatching(/one level/) });
  });

  it('refuses a called workflow no pull_request workflow calls', async () => {
    const r = await core({
      base: { '.github/workflows/core-server.yml': CORE },
    });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/no pull_request workflow/) });
  });

  it('refuses a called file changed at the head on an item that is no CI item', async () => {
    const changed = CORE.replace('cargo nextest run', 'echo skip; cargo nextest run');
    const head = { ...TREE, '.github/workflows/core-server.yml': changed };
    expect(await core({ head })).toMatchObject({
      ok: false,
      why: expect.stringMatching(/definition changed/),
    });
    expect((await core({ head, ciItem: true })).ok).toBe(true);
    // the caller job is part of the definition too
    const caller = CALLER.replace('  core-server:\n', '  core-server:\n    permissions: {}\n');
    expect(await core({ head: { ...TREE, '.github/workflows/ci.yml': caller } })).toMatchObject({
      ok: false,
      why: expect.stringMatching(/definition changed/),
    });
  });

  it('refuses when the head has other callers than the base', async () => {
    const renamed = CALLER.replace('name: CI', 'name: Checks');
    const r = await core({
      head: { ...TREE, '.github/workflows/ci.yml': renamed },
      ciItem: true,
      checks: [pass('core-server / core-server-tests (1)', 'Checks')],
    });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/callers differ/) });
  });

  it('the caller workflow name must be unique', async () => {
    const lint = `name: CI
on: pull_request
jobs:
  core-server:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
    const r = await core({ base: { ...TREE, '.github/workflows/lint.yml': lint } });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/name is not unique/) });
  });

  it('every caller counts: two pull_request jobs calling the file both have to pass', async () => {
    const twice = `${CALLER}  core-server-again:\n    uses: ./.github/workflows/core-server.yml\n`;
    const base = { ...TREE, '.github/workflows/ci.yml': twice };
    const legs = [
      pass('core-server / core-server-tests (1)'),
      pass('core-server / core-server-tests (2)'),
    ];
    expect((await core({ base, checks: legs })).ok).toBe(false);
    const r = await core({
      base,
      checks: [...legs, pass('core-server-again / core-server-tests (1)')],
    });
    expect(r).toMatchObject({
      ok: true,
      jobs: [
        { workflow: 'CI', job: 'core-server / core-server-tests' },
        { workflow: 'CI', job: 'core-server-again / core-server-tests' },
      ],
    });
  });
});
