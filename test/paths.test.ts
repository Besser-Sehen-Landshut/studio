import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acquireStateLock,
  canonicalToolchainPaths,
  checkStateMarker,
  cloneOriginUrl,
  ensureStateDir,
  inspectStateLock,
  normalizeOrigin,
  processIdentity,
  removeStateEntry,
  sameOrigin,
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

  it('takes another spelling of the same origin and refuses another repository', () => {
    const state = join(fresh(), 'state');
    const m = { projectRealpath: '/p', originUrl: 'git@github.com:org/repo.git' };
    checkStateMarker(state, m);
    for (const url of [
      'https://github.com/org/repo',
      'https://github.com/org/repo.git',
      'https://github.com/org/repo/',
      'ssh://git@github.com/org/repo.git',
      'https://GitHub.com/Org/Repo.git',
    ]) {
      expect(() => checkStateMarker(state, { ...m, originUrl: url })).not.toThrow();
    }
    expect(() =>
      checkStateMarker(state, { ...m, originUrl: 'https://github.com/org/other' }),
    ).toThrow(/another project or origin/);
    expect(() =>
      checkStateMarker(state, { ...m, originUrl: 'https://gitlab.com/org/repo' }),
    ).toThrow(/another project or origin/);
  });
});

describe('normalizeOrigin', () => {
  it('maps ssh, scp-like and https spellings of one repository to one identity', () => {
    const same = [
      'git@github.com:org/repo.git',
      'git@github.com:org/repo',
      'git@github.com:/org/repo.git',
      'ssh://git@github.com/org/repo.git',
      'ssh://git@github.com:22/org/repo',
      'git+ssh://git@github.com/org/repo.git',
      'https://github.com/org/repo',
      'https://github.com/org/repo.git',
      'https://github.com/org/repo/',
      'https://github.com/org/repo.git/',
      'https://user@github.com/org/repo.git',
      'https://www.github.com/org/repo',
      'HTTPS://GITHUB.COM/org/repo',
      '  https://github.com/org/repo  ',
    ];
    for (const url of same) expect(normalizeOrigin(url), url).toBe('github.com/org/repo');
  });

  it('ignores case on the host always, on owner and repository only on GitHub', () => {
    expect(sameOrigin('https://GitHub.com/Org/Repo', 'git@github.com:org/repo.git')).toBe(true);
    expect(sameOrigin('https://Git.Example.org/Org/Repo', 'https://git.example.org/Org/Repo')).toBe(
      true,
    );
    expect(sameOrigin('https://git.example.org/Org/Repo', 'https://git.example.org/org/repo')).toBe(
      false,
    );
  });

  it('tells different repositories, owners and hosts apart', () => {
    expect(sameOrigin('git@github.com:org/repo.git', 'git@github.com:org/repo2.git')).toBe(false);
    expect(sameOrigin('git@github.com:org/repo.git', 'git@github.com:other/repo.git')).toBe(false);
    expect(sameOrigin('git@github.com:org/repo.git', 'git@gitlab.com:org/repo.git')).toBe(false);
    expect(sameOrigin('https://github.com/org/repo', 'https://github.com/org/repo/sub')).toBe(
      false,
    );
  });

  it('keeps local paths as they are, without trailing slashes', () => {
    expect(normalizeOrigin('/srv/git/app.git/')).toBe('/srv/git/app.git');
    expect(normalizeOrigin('file:///srv/git/app.git')).toBe('file:///srv/git/app.git');
    expect(sameOrigin('/srv/git/app', '/srv/git/other')).toBe(false);
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

describe('acquireStateLock', () => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const now = () => new Date();
  const opts = (extra: Record<string, unknown> = {}) => ({
    now: now(),
    heartbeatStaleMs: 15 * MIN,
    ...extra,
  });
  /** pid of a process that has already exited */
  const deadPid = (): number => {
    const r = spawnSync(process.execPath, ['-e', '0']);
    return r.pid as number;
  };
  const writeLock = (d: string, body: Record<string, unknown>) =>
    writeFileSync(join(d, 'x.lock'), `${JSON.stringify({ token: 't', ...body })}\n`);

  it('is exclusive until released, then free again; records pid, startedAt, heartbeat', () => {
    const d = fresh();
    const a = acquireStateLock(d, 'x.lock', opts());
    expect(a).toBeDefined();
    expect(statSync(join(d, 'x.lock')).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(join(d, 'x.lock'), 'utf8'));
    expect(body.pid).toBe(process.pid);
    expect(typeof body.startedAt).toBe('string');
    expect(body.heartbeat).toBe(body.startedAt);
    expect(acquireStateLock(d, 'x.lock', opts())).toBeUndefined();
    a?.release();
    expect(existsSync(join(d, 'x.lock'))).toBe(false);
    const b = acquireStateLock(d, 'x.lock', opts());
    expect(b).toBeDefined();
    expect(b?.broke).toBeUndefined();
    b?.release();
  });

  it('breaks a lock whose holder pid is not running', () => {
    const d = fresh();
    const t = now().toISOString();
    writeLock(d, { pid: deadPid(), startedAt: t, heartbeat: t });
    const a = acquireStateLock(d, 'x.lock', opts());
    expect(a).toBeDefined();
    expect(a?.broke).toMatch(/not running/);
    expect(readFileSync(join(d, 'x.lock'), 'utf8')).not.toContain('"token":"t"');
    a?.release();
  });

  it('keeps a live holder with a fresh heartbeat, even when it started more than 6 h ago', () => {
    const d = fresh();
    const started = new Date(Date.now() - 7 * HOUR);
    writeLock(d, {
      pid: process.pid,
      startedAt: started.toISOString(),
      heartbeat: now().toISOString(),
    });
    utimesSync(join(d, 'x.lock'), started, started);
    expect(acquireStateLock(d, 'x.lock', opts())).toBeUndefined();
  });

  it('never breaks a live holder whose start time matches, however long it was silent', () => {
    const d = fresh();
    const old = new Date(Date.now() - 9 * HOUR).toISOString();
    const identity = processIdentity(process.pid);
    writeLock(d, { pid: process.pid, identity, startedAt: old, heartbeat: old });
    expect(acquireStateLock(d, 'x.lock', opts())).toBeUndefined();
    expect(inspectStateLock(d, 'x.lock', opts())).toEqual({
      state: 'held',
      pid: process.pid,
      silentMs: expect.any(Number),
    });
  });

  it('breaks a live holder it cannot verify only once the lock is very old', () => {
    const d = fresh();
    const old = new Date(Date.now() - 16 * MIN).toISOString();
    // No start time recorded (an older Studio), or none readable now: 16 minutes is not enough.
    writeLock(d, { pid: process.pid, startedAt: old, heartbeat: old });
    expect(acquireStateLock(d, 'x.lock', opts())).toBeUndefined();
    writeLock(d, { pid: process.pid, identity: 'x', startedAt: old, heartbeat: old });
    expect(acquireStateLock(d, 'x.lock', opts({ identityOf: () => undefined }))).toBeUndefined();
    const ancient = new Date(Date.now() - 61 * MIN).toISOString();
    writeLock(d, { pid: process.pid, startedAt: ancient, heartbeat: ancient });
    const a = acquireStateLock(d, 'x.lock', opts());
    expect(a?.broke).toMatch(/cannot be verified and was silent 61 min/);
    a?.release();
  });

  it('a lock without a pid is judged by its heartbeat', () => {
    const d = fresh();
    const old = new Date(Date.now() - 16 * MIN).toISOString();
    writeLock(d, { startedAt: old, heartbeat: old });
    expect(acquireStateLock(d, 'x.lock', opts())?.broke).toMatch(/heartbeat/);
  });

  it('heartbeat() refreshes the lock so it stays held', () => {
    const d = fresh();
    const t0 = new Date(Date.now() - 20 * MIN);
    const a = acquireStateLock(d, 'x.lock', opts({ now: t0 }));
    const t1 = new Date(t0.getTime() + 10 * MIN);
    a?.heartbeat(t1);
    expect(JSON.parse(readFileSync(join(d, 'x.lock'), 'utf8')).heartbeat).toBe(t1.toISOString());
    expect(acquireStateLock(d, 'x.lock', opts({ now: new Date(t1.getTime() + 5 * MIN) }))).toBe(
      undefined,
    );
    a?.release();
  });

  it('a lock without a readable body is judged by its mtime', () => {
    const d = fresh();
    writeFileSync(join(d, 'x.lock'), '');
    expect(acquireStateLock(d, 'x.lock', opts())).toBeUndefined();
    const old = new Date(Date.now() - 16 * MIN);
    utimesSync(join(d, 'x.lock'), old, old);
    expect(acquireStateLock(d, 'x.lock', opts())?.broke).toMatch(/unreadable/);
  });

  it('retries when the lock disappears between create and lstat (ENOENT race)', () => {
    const d = fresh();
    const t = now().toISOString();
    writeLock(d, { pid: process.pid, startedAt: t, heartbeat: t });
    let calls = 0;
    const lstat = (p: string) => {
      calls++;
      if (calls === 1) {
        rmSync(p); // the holder released right now
        const err = new Error('gone') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return lstatSync(p);
    };
    const a = acquireStateLock(d, 'x.lock', opts({ lstat }));
    expect(a).toBeDefined();
    expect(a?.broke).toBeUndefined();
    a?.release();
  });

  it('release leaves a lock that is no longer its own', () => {
    const d = fresh();
    const a = acquireStateLock(d, 'x.lock', opts());
    writeFileSync(join(d, 'x.lock'), '{"token":"someone-else"}\n');
    a?.release();
    a?.heartbeat(now());
    expect(readFileSync(join(d, 'x.lock'), 'utf8')).toContain('someone-else');
  });

  it('records the identity (start time) of the holding process', () => {
    const d = fresh();
    const a = acquireStateLock(d, 'x.lock', opts());
    const body = JSON.parse(readFileSync(join(d, 'x.lock'), 'utf8'));
    const own = processIdentity(process.pid);
    expect(own).toEqual(expect.any(String));
    expect(body.identity).toBe(own);
    a?.release();
  });

  it('breaks a lock whose pid belongs to another process now (a reboot reused it)', () => {
    const d = fresh();
    const t = now().toISOString();
    writeLock(d, {
      pid: process.pid,
      identity: 'a process of yesterday',
      startedAt: t,
      heartbeat: t,
    });
    const a = acquireStateLock(d, 'x.lock', opts());
    expect(a?.broke).toMatch(/pid \d+ is another process now/);
    a?.release();
  });

  it('keeps a live holder whose identity cannot be read right now, or that recorded none', () => {
    const d = fresh();
    const t = now().toISOString();
    writeLock(d, { pid: process.pid, identity: 'x', startedAt: t, heartbeat: t });
    expect(acquireStateLock(d, 'x.lock', opts({ identityOf: () => undefined }))).toBeUndefined();
    writeLock(d, { pid: process.pid, startedAt: t, heartbeat: t });
    expect(acquireStateLock(d, 'x.lock', opts())).toBeUndefined();
  });

  it('inspectStateLock says free, held or stale and changes nothing', () => {
    const d = fresh();
    expect(inspectStateLock(d, 'x.lock', { now: now(), heartbeatStaleMs: 15 * MIN })).toEqual({
      state: 'free',
    });
    const t = now().toISOString();
    writeLock(d, { pid: process.pid, startedAt: t, heartbeat: t });
    expect(inspectStateLock(d, 'x.lock', { now: now(), heartbeatStaleMs: 15 * MIN })).toEqual({
      state: 'held',
      pid: process.pid,
      silentMs: expect.any(Number),
    });
    const dead = deadPid();
    writeLock(d, { pid: dead, startedAt: t, heartbeat: t });
    expect(inspectStateLock(d, 'x.lock', { now: now(), heartbeatStaleMs: 15 * MIN })).toEqual({
      state: 'stale',
      reason: `holder pid ${dead} is not running`,
    });
    expect(JSON.parse(readFileSync(join(d, 'x.lock'), 'utf8')).pid).toBe(dead);
  });

  it('never follows a planted symlink at the lock path', () => {
    const d = fresh();
    const target = join(fresh(), 'victim');
    symlinkSync(target, join(d, 'x.lock'));
    expect(() => acquireStateLock(d, 'x.lock', opts())).toThrow(/not a regular file/);
    expect(existsSync(target)).toBe(false);
  });
});
