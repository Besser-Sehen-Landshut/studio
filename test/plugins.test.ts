import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  availableVersions,
  compareVersions,
  DEFAULT_PLUGINS,
  installedSkills,
  installedVersions,
  listedVersions,
  pinMismatch,
  pinnedPlugins,
  pluginCommands,
  STUDIO_VERSION,
  skillDenyRules,
} from '../src/plugins.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-plugins-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => {
  const d = join(root, `c${n++}`);
  mkdirSync(d);
  return d;
};
const put = (file: string, text = '---\nname: x\n---\n') => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const installed = (d: string, plugins: Record<string, unknown>) =>
  put(
    join(d, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }, null, 2),
  );

describe('pinned plugins', () => {
  it('Studio pins itself at the version it ships as', () => {
    const at = (f: string) =>
      (JSON.parse(readFileSync(join(import.meta.dirname, '..', f), 'utf8')) as { version: string })
        .version;
    expect(STUDIO_VERSION).toBe(at('package.json'));
    expect(STUDIO_VERSION).toBe(at('.claude-plugin/plugin.json'));
  });
  it('defaults pin the plugins Studio needs, Studio at its own version', () => {
    expect(DEFAULT_PLUGINS.map((p) => p.name)).toEqual([
      'superpowers@superpowers-marketplace',
      'studio@studio-marketplace',
    ]);
    expect(DEFAULT_PLUGINS.find((p) => p.name.startsWith('studio@'))?.version).toBe(STUDIO_VERSION);
    for (const p of DEFAULT_PLUGINS) expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('a configured pin replaces the default of the same name; others are added', () => {
    const pins = pinnedPlugins([
      { name: 'superpowers@superpowers-marketplace', version: '7.1.0' },
      { name: 'pg@aiguide', version: '1.2.3' },
    ]);
    expect(pins.map((p) => `${p.name} ${p.version}`)).toEqual([
      'superpowers@superpowers-marketplace 7.1.0',
      `studio@studio-marketplace ${STUDIO_VERSION}`,
      'pg@aiguide 1.2.3',
    ]);
    // The marketplace of a default stays when the pin names none.
    expect(pins[0]?.marketplace).toMatch(/^https:\/\//);
  });
  it('setup commands add each marketplace once over HTTPS, then install each plugin', () => {
    const cmds = pluginCommands(DEFAULT_PLUGINS);
    expect(cmds.map((c) => c.join(' '))).toEqual([
      'plugin marketplace add https://github.com/obra/superpowers-marketplace.git',
      'plugin marketplace add https://github.com/Besser-Sehen-Landshut/studio.git',
      'plugin install superpowers@superpowers-marketplace',
      'plugin install studio@studio-marketplace',
    ]);
  });
});

describe('installed versions', () => {
  it('reads installed_plugins.json, an entry list or a single entry', () => {
    const d = dir();
    installed(d, {
      'superpowers@superpowers-marketplace': [{ scope: 'user', version: '7.0.2' }],
      'studio@studio-marketplace': { scope: 'user', version: '0.11.0' },
    });
    const v = installedVersions(d);
    expect(v?.get('superpowers@superpowers-marketplace')).toBe('7.0.2');
    expect(v?.get('studio@studio-marketplace')).toBe('0.11.0');
  });
  it('an absent or malformed file cannot tell', () => {
    expect(installedVersions(dir())).toBeUndefined();
    const d = dir();
    put(join(d, 'plugins', 'installed_plugins.json'), '{oops');
    expect(installedVersions(d)).toBeUndefined();
  });
  it('a version that differs from its pin refuses, naming both and the way out', () => {
    const d = dir();
    installed(d, {
      'superpowers@superpowers-marketplace': [{ scope: 'user', version: '7.0.1' }],
      'studio@studio-marketplace': [{ scope: 'user', version: STUDIO_VERSION }],
    });
    const why = pinMismatch(d, DEFAULT_PLUGINS);
    expect(why).toContain('superpowers@superpowers-marketplace');
    expect(why).toContain('7.0.1');
    expect(why).toContain('7.0.2');
    expect(why).toContain('studio account setup-plugins');
  });
  it('matching versions, a plugin not listed or no record at all do not refuse', () => {
    const d = dir();
    installed(d, {
      'superpowers@superpowers-marketplace': [{ scope: 'user', version: '7.0.2' }],
    });
    expect(pinMismatch(d, DEFAULT_PLUGINS)).toBeUndefined();
    expect(pinMismatch(dir(), DEFAULT_PLUGINS)).toBeUndefined();
  });
  it('plugin list --json gives the installed versions', () => {
    const out = JSON.stringify([
      { id: 'superpowers@superpowers-marketplace', version: '7.0.2', enabled: true },
      { id: 'x', version: 3 },
    ]);
    expect(listedVersions(out)?.get('superpowers@superpowers-marketplace')).toBe('7.0.2');
    expect(listedVersions('not json')).toBeUndefined();
  });
  it('plugin list --json --available gives the offered versions and security hints', () => {
    const out = JSON.stringify({
      installed: [],
      available: [
        { pluginId: 'superpowers@superpowers-marketplace', version: '7.1.0', description: 'x' },
        {
          pluginId: 'studio@studio-marketplace',
          version: '0.12.1',
          description: 'Security fix for the guard (GHSA-xxxx)',
        },
        { pluginId: 'other@m', description: 'no version' },
      ],
    });
    const a = availableVersions(out);
    expect(a?.get('superpowers@superpowers-marketplace')).toEqual({
      version: '7.1.0',
      security: false,
    });
    expect(a?.get('studio@studio-marketplace')).toEqual({ version: '0.12.1', security: true });
    expect(a?.has('other@m')).toBe(false);
    expect(availableVersions('[]')?.size).toBe(0);
    expect(availableVersions('nope')).toBeUndefined();
  });
  it('compares versions by number, a text version only for equality', () => {
    expect(compareVersions('7.10.0', '7.9.1')).toBeGreaterThan(0);
    expect(compareVersions('7.0.2', '7.0.2')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('abc123', 'abc123')).toBe(0);
    expect(compareVersions('abc123', 'def456')).toBeGreaterThan(0);
  });
});

describe('installed skills and the deny list', () => {
  const setup = () => {
    const d = dir();
    put(join(d, 'skills', 'ux-ui-design', 'SKILL.md'));
    put(join(d, 'skills', 'my-own', 'SKILL.md'));
    put(join(d, 'skills', 'bad name(x)', 'SKILL.md'));
    const cache = join(d, 'plugins', 'cache', 'superpowers-marketplace', 'superpowers', '7.0.2');
    put(join(cache, 'skills', 'test-driven-development', 'SKILL.md'));
    put(join(cache, 'skills', 'brainstorming', 'SKILL.md'));
    put(join(cache, 'skills', 'executing-plans', 'SKILL.md'));
    put(join(cache, 'commands', 'write-plan.md'));
    const studio = join(d, 'plugins', 'cache', 'studio-marketplace', 'studio', '0.12.0');
    put(join(studio, 'skills', 'studio-crew', 'SKILL.md'));
    put(join(studio, 'skills', 'studio-lead', 'SKILL.md'));
    return d;
  };
  it('lists user skills by name and plugin skills and commands with their plugin', () => {
    expect(installedSkills(setup()).sort()).toEqual([
      'my-own',
      'studio:studio-crew',
      'studio:studio-lead',
      'superpowers:brainstorming',
      'superpowers:executing-plans',
      'superpowers:test-driven-development',
      'superpowers:write-plan',
      'ux-ui-design',
    ]);
    expect(installedSkills(dir())).toEqual([]);
  });
  it('denies every installed skill the matrix does not name, and the denied ones', () => {
    const rules = skillDenyRules(
      setup(),
      ['studio:studio-crew', 'superpowers:test-driven-development', 'ux-ui-design'],
      ['superpowers:executing-plans', 'skill-from-the-index'],
    );
    expect(rules.sort()).toEqual([
      'Skill(my-own)',
      'Skill(skill-from-the-index)',
      'Skill(studio:studio-lead)',
      'Skill(superpowers:brainstorming)',
      'Skill(superpowers:executing-plans)',
      'Skill(superpowers:write-plan)',
    ]);
  });
  it('a skill named without its plugin allows the plugin skill of that name', () => {
    const rules = skillDenyRules(setup(), ['studio:studio-crew', 'brainstorming'], []);
    expect(rules).not.toContain('Skill(superpowers:brainstorming)');
    expect(rules).toContain('Skill(superpowers:test-driven-development)');
  });
  it('a denied entry that is no plain skill name is dropped, never written as a rule', () => {
    expect(skillDenyRules(dir(), [], ['a) Bash(rm', 'ok-name'])).toEqual(['Skill(ok-name)']);
  });
});
