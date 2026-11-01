import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Detected, lintWorkflows, workflowRunnerUsage } from '../src/setup-ci.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: the GitHub Actions expression is literal text
const EXPECTED = 'ci-${{ github.head_ref || github.ref_name }}';
const fixture = (name: string) => ({
  path: `.github/workflows/${name}`,
  text: readFileSync(new URL(`./fixtures/workflows/${name}`, import.meta.url), 'utf8'),
});
const file = (text: string, path = '.github/workflows/w.yml') => ({ path, text });

const runner = (name: string, labels: string[], online = true) => ({
  name,
  labels,
  online,
  busy: false,
});
const detected = (runners = [runner('runner-1', ['self-hosted', 'Linux', 'pool'])]): Detected => ({
  source: 'org',
  runners,
});
const lint = (text: string, detect: Detected = detected()) =>
  lintWorkflows([file(text)], detect, EXPECTED);

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal expression
const GROUP = 'ci-${{ github.head_ref || github.ref_name }}';
const job = (runsOn: string) => `jobs:\n  build:\n    runs-on: ${runsOn}\n    steps: []\n`;
const both = (conc: string, extra = '') =>
  `on: [push, pull_request]\n${conc}${extra}${job('ubuntu-latest')}`;
const goodConc = `concurrency:\n  group: ${GROUP}\n  cancel-in-progress: true\n`;

describe('lintWorkflows: runs-on', () => {
  it('label set not on any online runner is an error', () => {
    const r = lintWorkflows([fixture('missing-label.yml')], detected(), EXPECTED);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('missing-label.yml');
    expect(r.errors[0]).toContain('build');
    expect(r.errors[0]).toContain('wait forever');
  });

  it('matrix/expression runs-on is a warning', () => {
    const r = lintWorkflows([fixture('matrix.yml')], detected(), EXPECTED);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('cannot verify');
  });

  it('github-hosted ubuntu-latest accepted', () => {
    const r = lintWorkflows([fixture('hosted.yml')], detected(), EXPECTED);
    expect(r).toEqual({ errors: [], warnings: [] });
  });

  it('a self-hosted set carried by an online runner is accepted (case-insensitive subset)', () => {
    const r = lintWorkflows([fixture('self-hosted-pool.yml')], detected(), EXPECTED);
    expect(r).toEqual({ errors: [], warnings: [] });
    expect(lint(job('[SELF-HOSTED, linux]')).errors).toEqual([]);
  });

  it('an offline runner carrying the labels does not count', () => {
    const d = detected([runner('runner-1', ['self-hosted', 'pool'], false)]);
    expect(lint(job('[self-hosted, pool]'), d).errors).toHaveLength(1);
  });

  it('labels spread over different runners do not count', () => {
    const d = detected([runner('runner-1', ['self-hosted']), runner('runner-2', ['pool'])]);
    expect(lint(job('[self-hosted, pool]'), d).errors).toHaveLength(1);
  });

  it('string, list and labels-map forms resolve alike', () => {
    expect(lint(job('pool')).errors).toEqual([]);
    expect(lint('jobs:\n  b:\n    runs-on:\n      labels: [self-hosted, pool]\n').errors).toEqual(
      [],
    );
    expect(lint('jobs:\n  b:\n    runs-on:\n      labels: other\n').errors).toHaveLength(1);
  });

  it('hosted means a single ubuntu/windows/macos label; a mixed list is a self-hosted set', () => {
    expect(lint(job('[ubuntu-latest, pool]')).errors).toHaveLength(1);
    expect(lint(job('[ubuntu-24.04]'), detected([])).errors).toEqual([]);
    expect(lint(job('Windows-2025'), detected([])).errors).toEqual([]);
    expect(lint(job('macos-latest'), detected([])).errors).toEqual([]);
  });

  it('source unknown warns for a self-hosted set, source none errors', () => {
    const unknown: Detected = { source: 'unknown', runners: [], error: 'x' };
    const none: Detected = { source: 'none', runners: [] };
    const u = lint(job('[self-hosted, pool]'), unknown);
    expect(u.errors).toEqual([]);
    expect(u.warnings[0]).toContain('cannot verify');
    expect(lint(job('[self-hosted, pool]'), none).errors).toHaveLength(1);
    expect(lint(job('ubuntu-latest'), unknown)).toEqual({ errors: [], warnings: [] });
  });

  it('a group without labels or an expression label is a warning', () => {
    const g = lint('jobs:\n  b:\n    runs-on:\n      group: pool-group\n');
    expect(g.errors).toEqual([]);
    expect(g.warnings[0]).toContain('cannot verify');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal expression
    const e = lint('jobs:\n  b:\n    runs-on: [self-hosted, "${{ vars.POOL }}"]\n');
    expect(e.errors).toEqual([]);
    expect(e.warnings).toHaveLength(1);
  });

  it('a group with labels checks the labels and warns about the membership', () => {
    const ok = lint(
      'jobs:\n  b:\n    runs-on:\n      group: g\n      labels: [self-hosted, pool]\n',
    );
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toHaveLength(1);
    expect(ok.warnings[0]).toMatch(/group membership/);
    const bad = lint(
      'jobs:\n  b:\n    runs-on:\n      group: g\n      labels: [self-hosted, gone]\n',
    );
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toContain('wait forever');
    expect(bad.warnings).toHaveLength(1);
  });

  it('a group with a hosted-looking label is still checked as a self-hosted set', () => {
    expect(
      lint('jobs:\n  b:\n    runs-on:\n      group: g\n      labels: ubuntu-latest\n').errors,
    ).toHaveLength(1);
  });

  it('a job without runs-on is an error unless it calls a reusable workflow', () => {
    expect(lint('jobs:\n  b:\n    steps: []\n').errors).toHaveLength(1);
    expect(lint('jobs:\n  b:\n    uses: org/app/.github/workflows/x.yml@main\n')).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('invalid runs-on values are errors', () => {
    expect(lint('jobs:\n  b:\n    runs-on: []\n').errors).toHaveLength(1);
    expect(lint('jobs:\n  b:\n    runs-on: [1, 2]\n').errors).toHaveLength(1);
    expect(lint('jobs:\n  b:\n    runs-on: 5\n').errors).toHaveLength(1);
  });
});

describe('lintWorkflows: concurrency', () => {
  it('push+pull_request without concurrency group is an error', () => {
    const r = lintWorkflows([fixture('no-concurrency.yml')], detected(), EXPECTED);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('no-concurrency.yml');
    expect(r.errors[0]).toContain('concurrency');
  });

  it('group with github.ref instead of ref_name is an error', () => {
    const r = lintWorkflows([fixture('wrong-ref.yml')], detected(), EXPECTED);
    expect(r.errors).toHaveLength(1);
  });

  it('the exact group with a trailing comment passes', () => {
    expect(lint(both(goodConc)).errors).toEqual([]);
    expect(
      lint(both(`concurrency:\n  group: ${GROUP}   # why\n  cancel-in-progress: true\n`)).errors,
    ).toEqual([]);
  });

  it('any prefix of the allowed form passes; other prefixes and refs do not', () => {
    const conc = (g: string) => `concurrency:\n  group: ${g}\n  cancel-in-progress: true\n`;
    const expr = GROUP.slice('ci-'.length);
    for (const p of ['lint', 'a.b_c-d', 'A9']) {
      expect(lint(both(conc(`${p}-${expr}`))).errors, p).toEqual([]);
    }
    for (const g of [
      expr,
      `-${expr}`,
      `a b-${expr}`,
      `a/b-${expr}`,
      `ci${expr}`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal expression
      'ci-${{ github.ref }}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal expression
      'ci-${{ github.head_ref || github.run_id }}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal expression
      '${{ github.workflow }}-${{ github.head_ref || github.ref_name }}',
      'ci-main',
    ]) {
      expect(lint(both(conc(`"${g}"`))).errors, g).toHaveLength(1);
    }
  });

  it('cancel-in-progress is still required with another prefix', () => {
    const g = `lint-${GROUP.slice('ci-'.length)}`;
    expect(lint(both(`concurrency:\n  group: ${g}\n`)).errors).toHaveLength(1);
  });

  it('two workflows sharing a group is an error naming both files', () => {
    const r = lintWorkflows(
      [
        file(both(goodConc), '.github/workflows/a.yml'),
        file(both(goodConc), '.github/workflows/b.yml'),
      ],
      detected(),
      EXPECTED,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('a.yml');
    expect(r.errors[0]).toContain('b.yml');
    expect(r.errors[0]).toMatch(/share/);
  });

  it('distinct prefixes in two workflows pass; group names compare case-insensitively', () => {
    const expr = GROUP.slice('ci-'.length);
    const conc = (p: string) => `concurrency:\n  group: ${p}-${expr}\n  cancel-in-progress: true\n`;
    const run = (a: string, b: string) =>
      lintWorkflows(
        [
          file(both(conc(a)), '.github/workflows/a.yml'),
          file(both(conc(b)), '.github/workflows/b.yml'),
        ],
        detected(),
        EXPECTED,
      ).errors;
    expect(run('lint', 'test')).toEqual([]);
    expect(run('lint', 'LINT')).toHaveLength(1);
  });

  it('a group naming the workflow or run differs at run time, so it is not shared', () => {
    for (const g of [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal expression
      '${{ github.workflow }}-${{ github.ref }}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal expression
      'deploy-${{ github.run_id }}',
    ]) {
      const t = `on: push\nconcurrency:\n  group: ${g}\n${job('ubuntu-latest')}`;
      const r = lintWorkflows(
        [file(t, '.github/workflows/a.yml'), file(t, '.github/workflows/b.yml')],
        detected(),
        EXPECTED,
      );
      expect(r.errors, g).toEqual([]);
    }
  });

  it('a push-only workflow sharing the group counts too', () => {
    const r = lintWorkflows(
      [
        file(both(goodConc), '.github/workflows/a.yml'),
        file(`on: push\n${goodConc}${job('ubuntu-latest')}`, '.github/workflows/b.yml'),
      ],
      detected(),
      EXPECTED,
    );
    expect(r.errors).toHaveLength(1);
  });

  it('a commented-out concurrency block does not count', () => {
    const c = `# concurrency:\n#   group: ${GROUP}\n#   cancel-in-progress: true\n`;
    expect(lint(both(c)).errors).toHaveLength(1);
  });

  it('cancel-in-progress must be boolean true', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal expression
    for (const v of ['false', '"true"', 'yes', '1', "${{ github.event_name == 'push' }}"]) {
      const c = `concurrency:\n  group: ${GROUP}\n  cancel-in-progress: ${v.startsWith('$') ? `"${v}"` : v}\n`;
      expect(lint(both(c)).errors, v).toHaveLength(1);
    }
    expect(lint(both(`concurrency:\n  group: ${GROUP}\n`)).errors).toHaveLength(1);
  });

  it('the string form of concurrency is an error', () => {
    expect(lint(both(`concurrency: "${GROUP}"\n`)).errors).toHaveLength(1);
  });

  it('job-level concurrency does not satisfy the workflow-level rule', () => {
    const t = `on: [push, pull_request]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    concurrency:\n      group: ${GROUP}\n      cancel-in-progress: true\n`;
    expect(lint(t).errors).toHaveLength(1);
  });

  it('applies only when both triggers are present, in string, list and map forms', () => {
    const j = job('ubuntu-latest');
    expect(lint(`on: push\n${j}`).errors).toEqual([]);
    expect(lint(`on: [pull_request]\n${j}`).errors).toEqual([]);
    expect(lint(`on:\n  push:\n  workflow_dispatch:\n${j}`).errors).toEqual([]);
    expect(lint(`on:\n  push:\n  pull_request:\n${j}`).errors).toHaveLength(1);
    expect(lint(`on: [push, pull_request]\n${j}`).errors).toHaveLength(1);
  });

  it('pull_request_target does not count as pull_request', () => {
    expect(lint(`on: [push, pull_request_target]\n${job('ubuntu-latest')}`).errors).toEqual([]);
  });
});

describe('lintWorkflows: fail closed on untrusted files', () => {
  it('unparsable YAML is an error naming the file, not skipped', () => {
    const r = lintWorkflows(
      [file('jobs: [unclosed', '.github/workflows/bad.yml')],
      detected(),
      EXPECTED,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('bad.yml');
  });

  it('duplicate keys, non-map documents and missing jobs are errors', () => {
    expect(lint('jobs:\n  a:\n    runs-on: x\n  a:\n    runs-on: y\n').errors).toHaveLength(1);
    expect(lint('just text').errors).toHaveLength(1);
    expect(lint('').errors).toHaveLength(1);
    expect(lint('on: push\n').errors).toHaveLength(1);
    expect(lint('jobs: {}\n').errors).toHaveLength(1);
    expect(lint('jobs: [a]\n').errors).toHaveLength(1);
    expect(lint('jobs:\n  a: nope\n').errors).toHaveLength(1);
  });

  it('error text from the file is stripped of control characters and capped', () => {
    const r = lint(`jobs:\n  "x\\x1b[31m${'y'.repeat(2000)}":\n    steps: []\n`);
    expect(r.errors).toHaveLength(1);
    const msg = r.errors[0] ?? '';
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence
    expect(msg).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(msg.length).toBeLessThan(600);
    const bad = lintWorkflows([file('a: [\x1b[31m', 'w\x1b.yml')], detected(), EXPECTED);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence
    expect(bad.errors.join('')).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(bad.errors.join('').length).toBeLessThan(900);
  });

  it('an alias expansion bomb fails closed as an error', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    let prev = 'a';
    for (let i = 0; i < 12; i++) {
      const next = String.fromCharCode(98 + i);
      lines.push(`${next}: &${next} [${Array(10).fill(`*${prev}`).join(', ')}]`);
      prev = next;
    }
    const r = lint(`${lines.join('\n')}\njobs:\n  j:\n    runs-on: ubuntu-latest\n`);
    expect(r.errors).toHaveLength(1);
  });

  it('lints every file and reports each problem', () => {
    const r = lintWorkflows(
      [fixture('missing-label.yml'), fixture('no-concurrency.yml'), fixture('hosted.yml')],
      detected(),
      EXPECTED,
    );
    expect(r.errors).toHaveLength(2);
  });
});

describe('workflowRunnerUsage', () => {
  it('classifies hosted and self-hosted jobs', () => {
    expect(workflowRunnerUsage([fixture('hosted.yml')])).toEqual({
      githubHosted: true,
      selfHosted: false,
    });
    expect(workflowRunnerUsage([fixture('self-hosted-pool.yml')])).toEqual({
      githubHosted: false,
      selfHosted: true,
    });
    expect(workflowRunnerUsage([fixture('hosted.yml'), fixture('self-hosted-pool.yml')])).toEqual({
      githubHosted: true,
      selfHosted: true,
    });
  });

  it('expressions, reusable calls, groups and unparsable files count toward neither', () => {
    expect(
      workflowRunnerUsage([
        fixture('matrix.yml'),
        file('jobs:\n  b:\n    uses: org/app/.github/workflows/x.yml@main\n'),
        file('jobs: [unclosed'),
        file('jobs:\n  b:\n    runs-on:\n      group: g\n'),
      ]),
    ).toEqual({ githubHosted: false, selfHosted: false });
  });

  it('a group with labels counts as self-hosted', () => {
    expect(
      workflowRunnerUsage([
        file('jobs:\n  b:\n    runs-on:\n      group: g\n      labels: pool\n'),
      ]),
    ).toEqual({ githubHosted: false, selfHosted: true });
  });

  it('a mixed list counts as self-hosted', () => {
    expect(workflowRunnerUsage([file(job('[ubuntu-latest, pool]'))])).toEqual({
      githubHosted: false,
      selfHosted: true,
    });
  });
});
