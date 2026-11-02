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
