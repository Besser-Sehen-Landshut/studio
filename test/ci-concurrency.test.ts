import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
const workspaceUrl = new URL('../pnpm-workspace.yaml', import.meta.url);

// Strip full-line and trailing comments before parsing, so a commented-out
// concurrency block can never satisfy the guard.
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}

interface GithubContext {
  event: string;
  ref_name: string;
  head_ref: string;
}

// Minimal evaluator for `${{ a.b || a.c }}` expressions over the github context.
function evaluate(template: string, github: GithubContext): string {
  return template.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_match, expression: string) => {
    for (const operand of expression.split('||')) {
      const key = operand.trim().replace(/^github\./, '') as keyof GithubContext;
      const value = github[key];
      if (value) return value;
    }
    return '';
  });
}

const workflow = parse(stripComments(readFileSync(workflowUrl, 'utf8'))) as {
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { 'runs-on': unknown; steps?: { name?: string; run?: string }[] }>;
};

describe('ci workflow guard', () => {
  it('uses one concurrency group per branch for push and pull_request', () => {
    const { group } = workflow.concurrency;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the GitHub Actions expression is literal text
    expect(group).toBe('ci-${{ github.head_ref || github.ref_name }}');
    expect(evaluate(group, { event: 'push', ref_name: 'feature-x', head_ref: '' })).toBe(
      'ci-feature-x',
    );
    expect(
      evaluate(group, { event: 'pull_request', head_ref: 'feature-x', ref_name: '7/merge' }),
    ).toBe('ci-feature-x');
  });

  it('cancels superseded runs', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
  });

  it('runs every job on GitHub-hosted ubuntu-latest', () => {
    const jobs = Object.entries(workflow.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const [, job] of jobs) {
      expect(job['runs-on']).toBe('ubuntu-latest');
    }
  });

  it('fails the bundle drift check on modified and on new untracked files', () => {
    const steps = workflow.jobs.check?.steps ?? [];
    const drift = steps.find((step) => step.run?.includes('pnpm bundle'));
    expect(drift?.run).toContain('git status --porcelain -- dist-bundle');
    expect(drift?.run).not.toContain('git diff --exit-code');
  });
});

describe('pnpm workspace settings', () => {
  const workspace = parse(stripComments(readFileSync(workspaceUrl, 'utf8'))) as Record<
    string,
    unknown
  >;

  it('keeps pmOnFail ignore and never trusts the lockfile past the release-age gate', () => {
    expect(workspace.pmOnFail).toBe('ignore');
    expect(workspace).not.toHaveProperty('trustLockfile');
    expect(workspace).not.toHaveProperty('minimumReleaseAgeExclude');
  });

  it('rules on every dependency build script so a frozen install does not fail', () => {
    // pnpm 11+: unreviewed build scripts fail the install (ERR_PNPM_IGNORED_BUILDS).
    expect(workspace.allowBuilds).toEqual({ esbuild: false });
  });
});
