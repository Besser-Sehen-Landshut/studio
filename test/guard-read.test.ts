import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_GLOBS, evaluateGuard, type GuardContext } from '../src/guard.js';

let root: string;
let wt: string;
let outside: string;
let state: string;
let brief: string;
let caps: string;
let home: string;
let tmp: string;
let login: string;
let plugins: string;
let ctx: GuardContext;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-read-')));
  wt = join(root, 'wt');
  outside = join(root, 'elsewhere');
  state = join(root, 'state');
  brief = join(state, 'briefs', 'APP-1.md');
  caps = join(state, 'briefs', 'APP-1.caps');
  home = join(state, 'homes', 'APP-1');
  tmp = join(state, 'tmp', 'APP-1');
  login = join(root, 'login');
  plugins = join(login, 'plugins', 'cache');
  for (const d of [join(wt, 'sub'), outside, join(root, 'wt-other'), caps, home, tmp, plugins]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(join(root, 'wt-secret'));
  writeFileSync(join(root, 'wt-secret', '.env'), 'x');
  symlinkSync(outside, join(wt, 'link'));
  ctx = {
    worktree: wt,
    ownerOnly: [],
    deployCommands: [],
    secretGlobs: [...DEFAULT_SECRET_GLOBS, login, `${login}/**`],
    readRoots: [brief, caps, home, tmp, plugins],
    skillRoots: [plugins],
    skillRootWaivedGlobs: [login, `${login}/**`],
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const decide = (toolName: string, toolInput: Record<string, unknown>, cwd?: string) =>
  evaluateGuard({ toolName, toolInput, cwd }, ctx).decision;
const read = (file_path: string, cwd?: string) => decide('Read', { file_path }, cwd);

describe('read tools stay in the crew area', () => {
  it.each<[string, () => string]>([
    ['the clone', () => join(wt, 'sub', 'a.ts')],
    ['the own brief', () => brief],
    ['a copied analyzer', () => join(caps, 'analyzers', 'diff-review.md')],
    ['the crew HOME', () => join(home, '.gitconfig')],
    ['the crew tmp dir', () => join(tmp, 'diff.txt')],
    [
      'a skill file of a plugin in a login dir',
      () => join(plugins, 'm', 'p', '1', 'skills', 's', 'x.md'),
    ],
  ])('Read of %s is allowed', (_name, file) => {
    expect(read(file())).toBe('allow');
  });

  it.each<[string, () => string]>([
    ['another brief', () => join(state, 'briefs', 'APP-2.md')],
    ['a name that starts like the brief', () => `${brief}.bak`],
    ['a directory that starts like the caps', () => join(`${caps}2`, 'x.md')],
    ['another clone', () => join(root, 'wt-other', 'a.ts')],
    ['another file of the login', () => join(login, 'settings.json')],
    ['a way out of the plugins', () => `${plugins}/../../.credentials.json`],
    ['the system', () => '/etc/hosts'],
    ['the home shorthand', () => '~/notes.txt'],
    ['a dotted way out', () => `${wt}/../elsewhere/a.ts`],
    ['a link out of the clone', () => join(wt, 'link', 'a.ts')],
  ])('Read of %s is denied', (_name, file) => {
    expect(read(file())).toBe('deny');
  });

  describe('secret rules inside the read roots', () => {
    const owner = () => join(root, 'owner');
    const hardened = (): GuardContext => {
      const skills = join(owner(), 'accounts', 'a', 'plugins', 'cache');
      return {
        ...ctx,
        secretGlobs: [
          ...DEFAULT_SECRET_GLOBS,
          owner(),
          `${owner()}/**`,
          join(owner(), 'crew-token'),
        ],
        readRoots: [skills],
        skillRoots: [skills],
        skillRootWaivedGlobs: [owner(), `${owner()}/**`],
      };
    };
    const at = (file_path: string) =>
      evaluateGuard({ toolName: 'Read', toolInput: { file_path } }, hardened()).decision;
    const skills = () => join(owner(), 'accounts', 'a', 'plugins', 'cache');

    it('only the waived directory rule gives way to a skill file', () => {
      expect(at(join(skills(), 'm', 'p', '1', 'skills', 's', 'SKILL.md'))).toBe('allow');
    });
    it.each(['.env', 'cert.pem', 'id_rsa', 'credentials.json', '.npmrc'])(
      'the default rule for %s still applies in a plugin',
      (name) => {
        expect(at(join(skills(), 'm', name))).toBe('deny');
      },
    );
    it('with no waived list, a secret glob over the login applies to its plugins too', () => {
      const none: GuardContext = { ...hardened(), skillRootWaivedGlobs: undefined };
      const r = evaluateGuard(
        { toolName: 'Read', toolInput: { file_path: join(skills(), 'SKILL.md') } },
        none,
      );
      expect(r.decision).toBe('deny');
    });
    it('a waived list that is not a list is an invalid context', () => {
      const bad = { ...ctx, skillRootWaivedGlobs: 'x' } as unknown as GuardContext;
      const r = evaluateGuard({ toolName: 'Read', toolInput: { file_path: brief } }, bad);
      expect(r.reason).toContain('invalid');
    });
  });

  describe('saved tool outputs', () => {
    const projects = () => join(login, 'projects', 'clone');
    const withResults = (): GuardContext => ({
      ...ctx,
      toolResultGlobs: [`${projects()}/*/tool-results/**`],
      skillRootWaivedGlobs: [login, `${login}/**`],
    });
    const at = (file_path: string) =>
      evaluateGuard({ toolName: 'Read', toolInput: { file_path } }, withResults()).decision;

    it('a saved output is readable', () => {
      expect(at(join(projects(), 'session', 'tool-results', 'out.txt'))).toBe('allow');
    });
    it.each(['session.jsonl', 'session/subagents/a.jsonl', 'memory/MEMORY.md'])(
      'the transcript or file %s is not',
      (rel) => {
        expect(at(join(projects(), rel))).toBe('deny');
      },
    );
    it('a dotted way out of a saved output is not', () => {
      expect(at(`${projects()}/session/tool-results/../../session.jsonl`)).toBe('deny');
    });
    it('a secret name among them stays denied', () => {
      expect(at(join(projects(), 'session', 'tool-results', '.env'))).toBe('deny');
    });
  });

  describe('paths a tool may read differently', () => {
    it.each([
      ' /etc/hosts',
      '/etc/hosts ',
      '\t/etc/hosts',
      '\n/etc/hosts',
      ' ~/x',
      '~root/x',
      '~+/x',
      'sub/a\u0000.ts',
      'sub/a\n.ts',
      'sub/a.ts ',
      ' sub/a.ts',
      ' /etc/hosts',
    ])('Read of %j is denied, also when it would land in the clone', (p) => {
      expect(read(p, wt)).toBe('deny');
    });
    it('a space inside a name is fine', () => {
      expect(read('sub/my file.ts', wt)).toBe('allow');
    });
    it.each([
      ['Grep', { pattern: 'x', path: ' /etc' }],
      ['Glob', { pattern: '*', path: ' /etc' }],
      ['Glob', { pattern: ' /etc/*' }],
      ['Glob', { pattern: ' ~/*' }],
      ['Glob', { pattern: '{sub, /etc}/*' }],
    ])('%s %j is denied', (name, input) => {
      expect(decide(name, input, wt)).toBe('deny');
    });
  });

  describe('a tool may normalise `..` before it follows a link', () => {
    it('both the written and the real path must be allowed', () => {
      mkdirSync(join(wt, 'sub', 'deep'), { recursive: true });
      symlinkSync(join(wt, 'sub', 'deep'), join(wt, 'inner'));
      try {
        // Written form leaves the clone (<root>/wt-other/x), real form stays in it (<wt>/wt-other/x).
        expect(read(`${wt}/inner/../../wt-other/x`)).toBe('deny');
        expect(decide('Grep', { pattern: 'x', path: `${wt}/inner/../../wt-other` })).toBe('deny');
        expect(decide('Glob', { pattern: '*', path: `${wt}/inner/../../wt-other` })).toBe('deny');
        expect(decide('Glob', { pattern: `${wt}/inner/../../wt-other/*` })).toBe('deny');
        // Written form stays inside the clone, real form leaves it.
        expect(read(`${wt}/link/../a.ts`)).toBe('deny');
        expect(decide('Grep', { pattern: 'x', path: `${wt}/link/../sub` })).toBe('deny');
        expect(decide('Glob', { pattern: `${wt}/link/../*` })).toBe('deny');
        expect(decide('Glob', { pattern: '*', path: `${wt}/link/../sub` })).toBe('deny');
      } finally {
        rmSync(join(wt, 'inner'));
      }
    });
    it('a link that stays inside on both forms is fine', () => {
      symlinkSync(join(wt, 'sub'), join(wt, 'inner'));
      try {
        expect(read(`${wt}/inner/a.ts`)).toBe('allow');
      } finally {
        rmSync(join(wt, 'inner'));
      }
    });
    it('a listed root works under its written and its real spelling', () => {
      symlinkSync(state, join(root, 'state-link'));
      const viaLink = join(root, 'state-link', 'briefs', 'APP-1.md');
      const linked: GuardContext = { ...ctx, readRoots: [viaLink] };
      for (const file_path of [viaLink, brief]) {
        expect(
          evaluateGuard({ toolName: 'Read', toolInput: { file_path } }, linked).decision,
          file_path,
        ).toBe('allow');
      }
    });
  });

  describe('fields that do not fit the tool', () => {
    it.each([
      'Read',
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'Grep',
      'Glob',
      'Skill',
      'TodoWrite',
      'Task',
      'Agent',
    ])('a command on %s is denied', (name) => {
      const r = decide(name, {
        command: 'ls',
        file_path: join(wt, 'a.ts'),
        notebook_path: join(wt, 'a.ipynb'),
        pattern: '*',
      });
      expect(r).toBe('deny');
    });
    it('a command cannot carry a Read past the read rule', () => {
      expect(decide('Read', { command: 'ls', file_path: '/etc/hosts' })).toBe('deny');
    });
    it('Bash needs a string command', () => {
      expect(decide('Bash', {})).toBe('deny');
      expect(decide('Bash', { command: 1 })).toBe('deny');
    });
    it.each<[string, Record<string, unknown>]>([
      ['Grep', { pattern: 'x', path: ['/etc'] }],
      ['Grep', { pattern: 'x', path: 1 }],
      ['Grep', { pattern: 'x', path: null }],
      ['Glob', { pattern: '*', path: { a: 1 } }],
      ['Glob', { pattern: ['/etc/*'] }],
      ['Glob', {}],
    ])('%s %j is denied', (name, input) => {
      expect(decide(name, input, wt)).toBe('deny');
    });
  });

  it('a relative path counts from the working directory', () => {
    expect(read('sub/a.ts', wt)).toBe('allow');
    expect(read('../elsewhere/a.ts', wt)).toBe('deny');
    expect(read('a.ts', outside)).toBe('deny');
  });

  it('a file name with a dollar sign in the clone is allowed', () => {
    expect(read(join(wt, 'routes', '$id.tsx'))).toBe('allow');
  });

  it('a Read with no path is denied', () => {
    expect(decide('Read', {})).toBe('deny');
  });

  it.each<[string, Record<string, unknown>]>([
    ['Grep', { pattern: 'x' }],
    ['Grep', { pattern: 'x', path: 'sub' }],
    ['Grep', { pattern: 'x', glob: '**/*.ts' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Glob', { pattern: 'sub/*.ts' }],
    ['Glob', { pattern: '*.ts', path: 'sub' }],
    ['Glob', { pattern: '{src,test}/**/*.ts' }],
    ['Glob', { pattern: '*.ts', path: '' }],
  ])('%s %j in the clone is allowed', (name, input) => {
    expect(decide(name, input, wt)).toBe('allow');
  });

  it.each<[string, Record<string, unknown>]>([
    ['Grep', { pattern: 'x', path: '/etc' }],
    ['Grep', { pattern: 'x', path: '..' }],
    ['Glob', { pattern: '*', path: '/etc' }],
    ['Glob', { pattern: '/etc/*' }],
    ['Glob', { pattern: '/**' }],
    ['Glob', { pattern: '../**' }],
    ['Glob', { pattern: 'sub/../../**' }],
    ['Glob', { pattern: '*/../../**' }],
    ['Glob', { pattern: '{sub,/etc}/*' }],
    ['Glob', { pattern: '~/*' }],
  ])('%s %j is denied', (name, input) => {
    expect(decide(name, input, wt)).toBe('deny');
  });

  it('a search with no path counts from the working directory', () => {
    expect(decide('Grep', { pattern: 'x' }, outside)).toBe('deny');
    expect(decide('Glob', { pattern: '*' }, outside)).toBe('deny');
  });

  it('without a list only the clone is readable', () => {
    const bare: GuardContext = { ...ctx, readRoots: undefined, skillRoots: undefined };
    const at = (file_path: string) =>
      evaluateGuard({ toolName: 'Read', toolInput: { file_path } }, bare).decision;
    expect(at(join(wt, 'a.ts'))).toBe('allow');
    expect(at(brief)).toBe('deny');
  });

  it.each(['readRoots', 'skillRoots'])('%s that is not a list is an invalid context', (key) => {
    const bad = { ...ctx, [key]: 'x' } as unknown as GuardContext;
    const r = evaluateGuard({ toolName: 'Read', toolInput: { file_path: brief } }, bad);
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('invalid');
  });

  it('secrets in the clone stay denied', () => {
    const secret = join(root, 'wt-secret');
    const inClone = (toolName: string, toolInput: Record<string, unknown>) =>
      evaluateGuard({ toolName, toolInput, cwd: secret }, { ...ctx, worktree: secret }).decision;
    expect(inClone('Read', { file_path: join(secret, '.env') })).toBe('deny');
    expect(inClone('Grep', { pattern: 'x', path: join(secret, '.env') })).toBe('deny');
    expect(inClone('Grep', { pattern: 'x' })).toBe('deny');
  });

  it('writes are not widened', () => {
    expect(decide('Write', { file_path: brief })).toBe('deny');
    expect(decide('Edit', { file_path: join(plugins, 'x.md') })).toBe('deny');
  });
});
