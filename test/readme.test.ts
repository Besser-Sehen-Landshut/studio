import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { componentsOf, epicProgress, loadBoard, parseBoard } from '../src/board.js';
import { loadConfig } from '../src/config.js';
import { planAssignments } from '../src/planner.js';
import { ROADMAP_HEADER } from '../src/roadmap.js';

describe('README epics', () => {
  it('has a board example that loads, and names the generated header exactly', () => {
    const at = readme.indexOf('## Epics and the roadmap');
    expect(at).toBeGreaterThan(0);
    const m = /```yaml\n([\s\S]*?)```/.exec(readme.slice(at));
    const board = parseBoard((m as RegExpExecArray)[1] as string, 'README.md');
    expect(board.items[0]?.epic).toBe('E-1');
    expect(epicProgress(board, 'E-1')).toMatchObject({ merged: 0, total: 1 });
    expect(readme.slice(at)).toContain(ROADMAP_HEADER);
  });
});

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
      { ciBusy: 0, ciTotal: config.ci.capacity.total, hostLoad: 0, ok: true, hostOk: true },
      {},
    );
    expect(plan.assign.map((i) => i.id)).toEqual(['APP-1']);
  });

  it('names the crew model authentication as a prerequisite', () => {
    const at = readme.indexOf('## Prerequisites');
    const pre = readme.slice(at, readme.indexOf('\n## ', at + 1));
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

  it('documents the board, pause, notify and owner-wide state', () => {
    expect(readme).toContain('## The Studio board');
    expect(readme).toContain('`/studio`');
    expect(readme).toContain('studio pause');
    expect(readme).toMatch(/notify: \{ channel, command \}/);
    expect(readme).toContain('`blocks.json` in the owner root');
    expect(readme).toContain('.legacy-');
    expect(readme).toMatch(/Status: 0\.12\.2/);
    for (const command of ['/studio list', '/studio pipeline', '/studio more', '/studio lang']) {
      expect(readme).toContain(command);
    }
    expect(readme).toContain('Decision needed');
    expect(readme).not.toMatch(/crews cannot write the state base/);
    expect(readme).not.toMatch(/blocks?[^.]{0,40}per project/i);
  });
});

describe('README quick start at the top', () => {
  it('is the first section and goes install, setup, /studio:init, add, board, lead', () => {
    const at = readme.indexOf('## Quick start');
    expect(at).toBeGreaterThan(0);
    expect(readme.indexOf('\n## ')).toBe(at - 1);
    const quick = readme.slice(at, readme.indexOf('\n## ', at + 1));
    const steps = [
      '/plugin install studio@studio-marketplace',
      '`studio setup --link`',
      'claude setup-token',
      '`/studio:init`',
      '`studio init`',
      '`studio init --write`',
      '`/studio:add ',
      '`studio add ',
      '`/studio`',
      'run the Studio lead loop',
    ];
    let from = 0;
    for (const step of steps) {
      const i = quick.indexOf(step, from);
      expect(i, step).toBeGreaterThanOrEqual(from);
      from = i;
    }
  });
});

describe('README components', () => {
  it('has an example that loads on top of the quick start and infers as described', () => {
    const at = readme.indexOf('## Components');
    const m = /```yaml\n([\s\S]*?)```/.exec(readme.slice(at));
    const example = (m as RegExpExecArray)[1] as string;
    const quick = block('.studio/studio.yaml').replace(/^repos: .*\n/m, '');
    const d = mkdtempSync(join(tmpdir(), 'studio-readme-components-'));
    try {
      mkdirSync(join(d, '.studio'));
      writeFileSync(join(d, '.studio', 'studio.yaml'), `${quick}${example}`);
      const config = loadConfig(d);
      expect(config.components?.map((c) => c.id)).toEqual(['api', 'desktop', 'agent', 'web']);
      const item = loadBoard(dir).items[0];
      if (item === undefined) throw new Error('no item');
      expect(componentsOf({ ...item, touches: ['shared/**'] }, config)).toEqual(['api', 'desktop']);
      expect(componentsOf({ ...item, touches: ['docs/**'] }, config)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
