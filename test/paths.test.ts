import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalToolchainPaths,
  ensureStateDir,
  removeStateEntry,
  repoSlug,
  stateRootFor,
  writeStateFile,
} from '../src/paths.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-paths-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(root, `d${n++}`);
  mkdirSync(d);
  return d;
};

describe('stateRootFor', () => {
  it('uses XDG_STATE_HOME, else <home>/.local/state, with the repo slug', () => {
    expect(stateRootFor({ primaryRepo: 'org/app' }, { homedir: '/h', env: {} })).toBe(
      '/h/.local/state/studio/org__app',
    );
    expect(
      stateRootFor({ primaryRepo: 'org/app' }, { homedir: '/h', env: { XDG_STATE_HOME: '/s' } }),
    ).toBe('/s/studio/org__app');
    expect(
      stateRootFor({ primaryRepo: 'org/app' }, { homedir: '/h', env: { XDG_STATE_HOME: 'rel' } }),
    ).toBe('/h/.local/state/studio/org__app');
  });

  it('refuses slugs that are not one safe path segment', () => {
    expect(repoSlug('org/app.js')).toBe('org__app.js');
    for (const bad of ['..', '.', 'org/a b', 'org\\app', 'org/a;b', '']) {
      expect(() => repoSlug(bad)).toThrow(/primary_repo/);
    }
  });
});

describe('state root helpers', () => {
  it('create 0700 directories and 0600 files', () => {
    const state = join(fresh(), 'state');
    const dir = ensureStateDir(state, join(state, 'a', 'b'));
    for (const d of [state, join(state, 'a'), dir]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    writeStateFile(state, join(state, 'x', 'f.json'), '{}');
    expect(statSync(join(state, 'x', 'f.json')).mode & 0o777).toBe(0o600);
  });

  it('refuse symlinked components and paths outside the root; unlink a symlinked target', () => {
    const base = fresh();
    const state = join(base, 'state');
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'keep'), { recursive: true });
    mkdirSync(state);
    symlinkSync(outside, join(state, 'link'));
    expect(() => ensureStateDir(state, join(state, 'link', 'x'))).toThrow(/symlink/);
    expect(() => writeStateFile(state, join(state, 'link', 'f'), 'x')).toThrow(/symlink/);
    expect(() => removeStateEntry(state, join(state, 'link', 'keep'))).toThrow(/symlink/);
    expect(() => removeStateEntry(state, join(base, 'outside'))).toThrow(/not inside/);
    removeStateEntry(state, join(state, 'link'));
    expect(statSync(join(outside, 'keep')).isDirectory()).toBe(true);
  });
});

describe('canonicalToolchainPaths', () => {
  it('returns real paths and refuses anything that reaches a protected place', () => {
    const base = fresh();
    const home = join(base, 'home');
    const project = join(base, 'project');
    const stateRoot = join(home, '.local', 'state', 'studio', 'org__app');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    mkdirSync(join(home, '.toolchains', 'node'), { recursive: true });
    mkdirSync(join(project, 'sub'), { recursive: true });
    const ctx = { home, env: {}, projectDir: project, stateRoot, platform: 'linux' as const };
    symlinkSync(join(home, '.toolchains', 'node'), join(base, 'node-link'));
    expect(canonicalToolchainPaths([join(base, 'node-link')], ctx)).toEqual([
      join(home, '.toolchains', 'node'),
    ]);
    symlinkSync(join(home, '.ssh'), join(base, 'ssh-link'));
    symlinkSync(home, join(base, 'home-link'));
    for (const [bad, why] of [
      [join(base, 'ssh-link'), /protected location/],
      [join(base, 'home-link'), /home directory/],
      [join(home, 'missing'), /does not exist/],
      [join(project, 'sub'), /project directory/],
      [base, /home directory/],
    ] as const) {
      expect(() => canonicalToolchainPaths([bad], ctx)).toThrow(why);
    }
  });
});
