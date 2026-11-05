import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  availableVersions,
  compareVersions,
  DEFAULT_PLUGINS,
  INVALID_VERSION,
  installedSkills,
  installedVersions,
  listedVersions,
  PluginTrustError,
  pinMismatch,
  pinnedPlugins,
  pluginCommands,
  STUDIO_VERSION,
  skillDenyRules,
  unallowedPlugins,
} from '../src/plugins.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-plugins-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => {
  const d = join(root, `c${n++}`);
  mkdirSync(d);
  return d;
};
const put = (file: string, text = '---\ndescription: x\n---\n') => {
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
  it('a configured pin sets the version of a default; an extra counts only as the owner allows it', () => {
    const configured = [
      { name: 'superpowers@superpowers-marketplace', version: '7.1.0' },
      { name: 'pg@aiguide', version: '1.2.3' },
    ];
    expect(pinnedPlugins(configured).map((p) => `${p.name} ${p.version}`)).toEqual([
      'superpowers@superpowers-marketplace 7.1.0',
      `studio@studio-marketplace ${STUDIO_VERSION}`,
    ]);
    expect(unallowedPlugins(configured)).toEqual(['pg@aiguide']);
    const owner = [{ name: 'pg@aiguide', marketplace: 'https://github.com/acme/aiguide' }];
    const pins = pinnedPlugins(configured, owner);
    expect(pins.at(-1)).toEqual({
      name: 'pg@aiguide',
      version: '1.2.3',
      marketplace: 'https://github.com/acme/aiguide',
    });
    expect(unallowedPlugins(configured, owner)).toEqual([]);
    // The marketplace of a default stays.
    expect(pins[0]?.marketplace).toBe('https://github.com/obra/superpowers-marketplace.git');
  });
  it('studio.yaml cannot swap the marketplace of a default or of an allowed plugin', () => {
    expect(() =>
      pinnedPlugins([
        {
          name: 'superpowers@superpowers-marketplace',
          version: '7.0.2',
          marketplace: 'https://github.com/evil/superpowers-marketplace',
        },
      ]),
    ).toThrow(PluginTrustError);
    const owner = [{ name: 'pg@aiguide', marketplace: 'https://github.com/acme/aiguide' }];
    expect(() =>
      pinnedPlugins(
        [{ name: 'pg@aiguide', version: '1.0.0', marketplace: 'https://github.com/evil/aiguide' }],
        owner,
      ),
    ).toThrow(/may not change the marketplace of pg@aiguide/);
    // Naming the same marketplace is fine.
    expect(
      pinnedPlugins([
        {
          name: 'superpowers@superpowers-marketplace',
          version: '7.0.2',
          marketplace: 'https://github.com/obra/superpowers-marketplace.git',
        },
      ]),
    ).toHaveLength(2);
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
    const a = availableVersions(out)?.offered;
    expect(a?.get('superpowers@superpowers-marketplace')).toEqual({
      version: '7.1.0',
      security: false,
    });
    expect(a?.get('studio@studio-marketplace')).toEqual({ version: '0.12.1', security: true });
    expect(a?.has('other@m')).toBe(false);
    expect(availableVersions('[]')?.offered.size).toBe(0);
    expect(availableVersions('nope')).toBeUndefined();
  });
  it('a version or id with escape sequences or newlines is dropped and named, never kept', () => {
    const out = JSON.stringify({
      available: [
        { pluginId: 'superpowers@superpowers-marketplace', version: '7.1.0\u001b[2J\nrm -rf' },
        { pluginId: 'evil@m\u001b[31m', version: '1.0.0' },
        { pluginId: 'ok@m', version: '1.0.0' },
      ],
    });
    const a = availableVersions(out);
    expect([...(a?.offered.keys() ?? [])]).toEqual(['ok@m']);
    expect(a?.dropped).toEqual([
      'superpowers@superpowers-marketplace',
      '(an entry without a plain id)',
    ]);
    const listed = listedVersions(
      JSON.stringify([{ id: 'superpowers@superpowers-marketplace', version: '7\n\u001b[0m' }]),
    );
    expect(listed?.get('superpowers@superpowers-marketplace')).toBe(INVALID_VERSION);
    const d = dir();
    installed(d, { 'superpowers@superpowers-marketplace': { version: '7.0.2\u001b]0;x\u0007' } });
    expect(installedVersions(d)?.get('superpowers@superpowers-marketplace')).toBe(INVALID_VERSION);
    expect(pinMismatch(d, DEFAULT_PLUGINS)).not.toMatch(/\p{Cc}/u);
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
    put(join(d, 'skills', 'my-own', 'SKILL.md'), '---\nname: my-own\n---\n');
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
    expect(installedSkills(setup()).names.sort()).toEqual([
      'my-own',
      'studio:studio-crew',
      'studio:studio-lead',
      'superpowers:brainstorming',
      'superpowers:executing-plans',
      'superpowers:test-driven-development',
      'superpowers:write-plan',
      'ux-ui-design',
    ]);
    expect(installedSkills(dir())).toEqual({ names: [], invalid: [] });
  });
  it('a skill is named by its front matter; the directory name is denied too', () => {
    const d = setup();
    put(
      join(d, 'skills', 'harmless-dir', 'SKILL.md'),
      '---\nname: "deploy-prod"\ndescription: x\n---\n',
    );
    const { names } = installedSkills(d);
    expect(names).toContain('deploy-prod');
    expect(names).toContain('harmless-dir');
    const rules = skillDenyRules(d, ['studio:studio-crew', 'harmless-dir'], []);
    expect(rules).toContain('Skill(deploy-prod)');
  });
  it('a byte order mark before the front matter does not hide the name', () => {
    const d = setup();
    put(join(d, 'skills', 'bom', 'SKILL.md'), '﻿---\r\nname: deploy-prod\r\n---\r\nbody\n');
    const { names, invalid } = installedSkills(d);
    expect(invalid).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['deploy-prod', 'bom']));
  });
  it('a nested command gets the namespaced name, and its bare name is denied too', () => {
    const d = setup();
    put(join(d, 'commands', 'ops', 'deploy.md'), '# deploy\n');
    const sp = join(d, 'plugins', 'cache', 'superpowers-marketplace', 'superpowers', '7.0.2');
    put(join(sp, 'commands', 'db', 'migrate.md'), '# migrate\n');
    put(join(sp, 'commands', '.DS_Store'), 'x');
    const { names, invalid } = installedSkills(d);
    expect(invalid).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining([
        'ops:deploy',
        'deploy',
        'superpowers:db:migrate',
        'superpowers:migrate',
      ]),
    );
    const rules = skillDenyRules(d, ['studio:studio-crew'], []);
    expect(rules).toEqual(
      expect.arrayContaining(['Skill(ops:deploy)', 'Skill(superpowers:db:migrate)']),
    );
  });
  it.each([
    ['a file with another extension', (d: string) => put(join(d, 'commands', 'run.sh'), 'x')],
    [
      'a link',
      (d: string) => {
        mkdirSync(join(d, 'commands'), { recursive: true });
        symlinkSync(join(d, 'commands'), join(d, 'commands', 'loop'));
      },
    ],
    ['a directory a rule cannot name', (d: string) => put(join(d, 'commands', 'a b', 'x.md'), 'x')],
  ])('a command entry Studio cannot map refuses: %s', (_, make) => {
    const d = setup();
    make(d);
    expect(installedSkills(d).invalid).toHaveLength(1);
    expect(() => skillDenyRules(d, [], [])).toThrow(/a deny rule cannot hold/);
  });
  it('an unreadable commands directory refuses', () => {
    const d = setup();
    put(join(d, 'commands', 'inner', 'x.md'), 'x');
    chmodSync(join(d, 'commands', 'inner'), 0o000);
    try {
      expect(installedSkills(d).invalid).toEqual([join(d, 'commands', 'inner')]);
    } finally {
      chmodSync(join(d, 'commands', 'inner'), 0o700);
    }
  });
  it('ordinary front matter with a description and a tool list reads fine', () => {
    const d = setup();
    put(
      join(d, 'skills', 'normal', 'SKILL.md'),
      '---\nname: normal\ndescription: "Use when: x"\nallowed-tools: [Read, Grep]\n---\n',
    );
    expect(installedSkills(d).invalid).toEqual([]);
  });
  it('a SKILL.md without front matter is named by its directory', () => {
    const d = setup();
    put(join(d, 'skills', 'plain', 'SKILL.md'), '# Just text\n');
    expect(installedSkills(d)).toMatchObject({ invalid: [] });
    expect(installedSkills(d).names).toContain('plain');
  });
  it('plugin skills are found where installed_plugins.json says, not only in the cache', () => {
    const d = setup();
    const elsewhere = join(d, 'plugins', 'local', 'tools');
    put(join(elsewhere, 'skills', 'wipe', 'SKILL.md'), '---\nname: wipe-disk\n---\n');
    installed(d, { 'tools@local': [{ scope: 'user', version: '1.0.0', installPath: elsewhere }] });
    expect(installedSkills(d).names).toContain('tools:wipe-disk');
    expect(skillDenyRules(d, ['studio:studio-crew'], [])).toContain('Skill(tools:wipe-disk)');
  });
  it.each([
    ['a directory with spaces and parentheses', 'bad name(x)', '---\nname: x y\n---\n'],
    ['a front matter name a rule cannot hold', 'fine', '---\nname: "a) Bash(rm -rf"\n---\n'],
    ['a hidden directory', '.hidden', '---\n---\n'],
    [
      'a fine front matter name in a directory a rule cannot hold',
      'bad dir(x)',
      '---\nname: ok-name\n---\n',
    ],
    ['two name keys', 'dup', '---\nname: harmless\nname: deploy-prod\n---\n'],
    ['a name that is a list', 'listed', '---\nname: [a]\n---\n'],
    ['a name that is a number', 'numbered', '---\nname: 42\n---\n'],
    ['no closing delimiter', 'open', '---\nname: harmless\n# body\n'],
    ['a header that is no YAML', 'broken', '---\nname: "unterminated\n---\n'],
    ['a delimiter with trailing text', 'trailing', '--- x\nname: harmless\n---\n'],
    ['blank lines before the front matter', 'blank', '\n\n---\nname: deploy-prod\n---\n'],
    ['a merge key', 'merged', '---\nbase: &a {name: deploy-prod}\n<<: *a\n---\n'],
    ['an anchor and an alias on name', 'aliased', '---\nother: &n deploy-prod\nname: *n\n---\n'],
    ['an anchor on name', 'anchored', '---\nname: &n harmless\n---\n'],
    ['a tagged name', 'tagged', '---\nname: !!str deploy-prod\n---\n'],
    ['a tagged value elsewhere', 'tagged2', '---\nname: harmless\nx: !custom y\n---\n'],
    ['a nested map', 'nested', '---\nname: harmless\nmeta: {a: 1}\n---\n'],
    ['an oversized file', 'big', `---\nname: harmless\n---\n${'x'.repeat(300 * 1024)}`],
  ])('an installed skill with %s refuses: fail closed, never skipped', (_, dirName, text) => {
    const d = setup();
    put(join(d, 'skills', dirName, 'SKILL.md'), text);
    expect(installedSkills(d).invalid).toEqual([join(d, 'skills', dirName)]);
    expect(() => skillDenyRules(d, [], [])).toThrow(/a deny rule cannot hold/);
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
  it('a plugin skill is allowed only by its full name; a bare name allows only a skill without one', () => {
    const d = setup();
    put(join(d, 'skills', 'brainstorming', 'SKILL.md'));
    const rules = skillDenyRules(d, ['studio:studio-crew', 'brainstorming'], []);
    expect(rules).toContain('Skill(superpowers:brainstorming)');
    expect(rules).not.toContain('Skill(brainstorming)');
    const full = skillDenyRules(d, ['studio:studio-crew', 'superpowers:brainstorming'], []);
    expect(full).not.toContain('Skill(superpowers:brainstorming)');
    expect(full).toContain('Skill(brainstorming)');
  });
  it('bundled skills the brief does not name are denied by name; the named ones stay', () => {
    const rules = skillDenyRules(dir(), ['simplify'], [], ['simplify', 'batch', 'run', 'verify']);
    expect(rules.sort()).toEqual(['Skill(batch)', 'Skill(run)', 'Skill(verify)']);
  });
  it('a denied entry that is no plain skill name is dropped, never written as a rule', () => {
    expect(skillDenyRules(dir(), [], ['a) Bash(rm', 'ok-name'])).toEqual(['Skill(ok-name)']);
  });
});
