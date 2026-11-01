import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard } from '../src/board.js';
import { loadConfig } from '../src/config.js';
import { planAssignments } from '../src/planner.js';

// The README quick start must work as written: copy its files into a project and plan.
const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'studio-readme-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The first yaml code block after the line naming `file`. */
function block(file: string): string {
  const at = readme.indexOf(`\`${file}\`:`);
  expect(at, `${file} in README`).toBeGreaterThanOrEqual(0);
  const m = /```yaml\n([\s\S]*?)```/.exec(readme.slice(at));
  expect(m, `yaml block for ${file}`).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

mkdirSync(join(dir, '.studio'));
writeFileSync(join(dir, '.studio', 'studio.yaml'), block('.studio/studio.yaml'));
writeFileSync(join(dir, '.studio', 'board.yaml'), block('.studio/board.yaml'));

describe('README quick start', () => {
  it('uses real model names and lets the crew reach GitHub and the npm registry', () => {
    const config = loadConfig(dir);
    for (const role of Object.values(config.roles)) {
      expect(['opus', 'sonnet', 'haiku']).toContain(role?.model);
    }
    expect(config.sandbox.networkAllow).toEqual(
      expect.arrayContaining(['github.com', 'api.github.com', 'registry.npmjs.org']),
    );
  });

  it('plans the example item', () => {
    const config = loadConfig(dir);
    const board = loadBoard(dir);
    const plan = planAssignments(
      board,
      config,
      { ciBusy: 0, ciTotal: config.ci.capacity.total, hostLoad: 0, ok: true },
      {},
    );
    expect(plan.assign.map((i) => i.id)).toEqual(['APP-1']);
  });

  it('names the crew model authentication as a prerequisite', () => {
    const pre = readme.slice(readme.indexOf('## Prerequisites'), readme.indexOf('## Quick start'));
    expect(pre).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(pre).toContain('ANTHROPIC_API_KEY');
    expect(pre).toContain('CLAUDE_CONFIG_DIR');
  });

  const repoFile = (name: string) => readFileSync(join(import.meta.dirname, '..', name), 'utf8');

  it('does not overstate the config dir form of the provider', () => {
    for (const text of [readme, repoFile('CHANGELOG.md')]) {
      expect(text).not.toMatch(/CLAUDE_CONFIG_DIR`? \(preferred/);
      expect(text).toMatch(/verified fallback/);
      expect(text).toMatch(/not yet been verified with an isolated `?HOME`? on macOS/);
    }
  });

  it('says plainly what can reach the crew log', () => {
    const security = repoFile('SECURITY.md');
    expect(security).not.toMatch(/never writes a crew credential to [^.]*logs/);
    expect(security).toMatch(/output of crew commands is logged as is/i);
    expect(security).toMatch(/0700/);
  });

  it('states the limits of setup ci and the token check', () => {
    expect(readme).not.toContain('Block fork pull request workflows first');
    expect(readme).toMatch(/at your own risk/);
    expect(readme).toMatch(/comments inside a replaced list are lost/);
    expect(readme).toMatch(/does not prove the token's scope/);
    expect(readme).toMatch(/`githubHostedBusy` counts all runs of the repository/);
    expect(readme).toMatch(/restricted to other repositories by runner groups are counted/);
  });
});
