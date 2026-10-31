import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalToolchainPaths,
  checkStateMarker,
  cloneOriginUrl,
  ensureStateDir,
  removeStateEntry,
  stateDirName,
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
  it('uses XDG_STATE_HOME, else <home>/.local/state, with a hashed project name', () => {
    const project = join(fresh(), 'my app!');
    mkdirSync(project);
    const name = stateDirName(realpathSync(project));
    expect(name).toMatch(/^[0-9a-f]{16}-my_app_$/);
    expect(stateRootFor(project, { homedir: '/h', env: {} })).toBe(
      `/h/.local/state/studio/${name}`,
    );
    expect(stateRootFor(project, { homedir: '/h', env: { XDG_STATE_HOME: '/s' } })).toBe(
      `/s/studio/${name}`,
    );
    expect(stateRootFor(project, { homedir: '/h', env: { XDG_STATE_HOME: 'rel' } })).toBe(
      `/h/.local/state/studio/${name}`,
    );
    expect(stateDirName(`/x/${'a'.repeat(40)}`)).toMatch(/^[0-9a-f]{16}-a{32}$/);
  });

  it('R61: two projects (same primary_repo, same base name) get different roots', () => {
    const a = join(fresh(), 'app');
    const b = join(fresh(), 'app');
    mkdirSync(a);
    mkdirSync(b);
    const opts = { homedir: '/h', env: {} };
    expect(stateRootFor(a, opts)).not.toBe(stateRootFor(b, opts));
    expect(() => stateRootFor(join(a, 'missing'), opts)).toThrow(/does not exist/);
  });
});

describe('checkStateMarker', () => {
  it('writes the marker once (0600) and refuses a mismatch or an unmarked root', () => {
    const state = join(fresh(), 'state');
    const m = { projectRealpath: '/p', originUrl: 'https://example.com/org/app.git' };
    checkStateMarker(state, m);
    expect(statSync(join(state, 'marker.json')).mode & 0o777).toBe(0o600);
    checkStateMarker(state, m);
    expect(() => checkStateMarker(state, { ...m, originUrl: 'x' })).toThrow(/marker/);
    expect(() => checkStateMarker(state, { ...m, projectRealpath: '/q' })).toThrow(/marker/);
    const unmarked = join(fresh(), 'state');
    mkdirSync(join(unmarked, 'clones'), { recursive: true });
    expect(() => checkStateMarker(unmarked, m)).toThrow(/no marker/);
  });
});

describe('cloneOriginUrl', () => {
  it('reads the single simple origin url and rejects anything else', () => {
    const clone = fresh();
    mkdirSync(join(clone, '.git'));
    const cfg = join(clone, '.git', 'config');
    const put = (s: string) => writeFileSync(cfg, s);
    put('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/org/app.git\n');
    expect(cloneOriginUrl(clone)).toBe('https://example.com/org/app.git');
    put('[remote "origin"]\n\turl = a\n\turl = b\n');
    expect(cloneOriginUrl(clone)).toBeUndefined();
    put('[remote "other"]\n\turl = a\n');
    expect(cloneOriginUrl(clone)).toBeUndefined();
    put('[remote "origin"]\n\turl = "a"\n');
    expect(cloneOriginUrl(clone)).toBeUndefined();
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
