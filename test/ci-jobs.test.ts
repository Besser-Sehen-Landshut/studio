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
  checks: Check[];
}) => {
  const base = o.base ?? { '.github/workflows/ci.yml': CI };
  return verifyNotRunHereJobs({
    git: fakeGit({ [BASE]: base, [HEAD]: o.head ?? base }, o.changed ?? []),
    checkout: { dir: '/x', remote: 'origin' },
    baseOid: BASE,
    headOid: HEAD,
    commands: [o.command ?? 'pnpm test:e2e'],
    entries: [
      {
        command: o.command ?? 'pnpm test:e2e',
        workflow: o.workflow ?? '.github/workflows/ci.yml',
        job: o.job ?? 'e2e',
      },
    ],
    checks: o.checks,
  });
};
const pass = (name: string, workflow = 'CI'): Check => ({ name, bucket: 'pass', workflow });

describe('the job gate', () => {
  it('a job of the base workflow that runs the command and passed', async () => {
    expect(await gate({ checks: [pass('e2e')] })).toEqual({
      ok: true,
      jobs: [{ workflow: 'CI', job: 'e2e' }],
    });
  });

  it('refuses a workflow name another workflow file at the base shares', async () => {
    const integration = CI.replace('pnpm test:e2e --reporter dot', 'echo none');
    const r = await gate({
      base: { '.github/workflows/ci.yml': CI, '.github/workflows/integration.yml': integration },
      checks: [pass('e2e')],
    });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/name is not unique/) });
  });

  it('refuses a job with continue-on-error or an if, and ignores such steps', async () => {
    for (const yml of [
      CI.replace('  e2e:\n', '  e2e:\n    continue-on-error: true\n'),
      CI.replace('  e2e:\n', "  e2e:\n    if: github.actor == 'x'\n"),
      CI.replace('      - run: |\n', '      - if: false\n        run: |\n'),
      CI.replace('      - run: |\n', '      - continue-on-error: true\n        run: |\n'),
    ]) {
      const r = await gate({ base: { '.github/workflows/ci.yml': yml }, checks: [pass('e2e')] });
      expect(r.ok, yml).toBe(false);
    }
  });

  it('needs the whole command at the start of a line of a run step', async () => {
    const echo = CI.replace('pnpm test:e2e --reporter dot', 'echo "skipping pnpm test:e2e"');
    expect(
      (await gate({ base: { '.github/workflows/ci.yml': echo }, checks: [pass('e2e')] })).ok,
    ).toBe(false);
    // the first two words alone are not the command
    expect((await gate({ command: 'pnpm test:e2e --filter db', checks: [pass('e2e')] })).ok).toBe(
      false,
    );
    expect((await gate({ command: 'pnpm build', checks: [pass('e2e')] })).ok).toBe(true);
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
  });

  it('refuses a reusable workflow job with a clear reason', async () => {
    const reusable = `name: CI
on: pull_request
jobs:
  e2e:
    uses: ./.github/workflows/e2e.yml
`;
    const r = await gate({ base: { '.github/workflows/ci.yml': reusable }, checks: [pass('e2e')] });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/reusable workflow/) });
  });

  it('a workflow the pull request changed is checked at the head too', async () => {
    const dropped = CI.replace('pnpm test:e2e --reporter dot', 'echo ok');
    const r = await gate({
      head: { '.github/workflows/ci.yml': dropped },
      changed: ['.github/workflows/ci.yml'],
      checks: [pass('e2e')],
    });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/at the pull request head/) });
    expect(
      (
        await gate({
          head: { '.github/workflows/ci.yml': CI },
          changed: ['.github/workflows/ci.yml'],
          checks: [pass('e2e')],
        })
      ).ok,
    ).toBe(true);
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
