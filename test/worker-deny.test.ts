import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateGuard } from '../src/guard.js';
import {
  automountRoot,
  detectPlatform,
  enforceDeny,
  hostPort,
  mergeDeny,
  namedDeniedPort,
  sandboxProblem,
  type WorkerPlatform,
} from '../src/worker-deny.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-deny-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const linux: WorkerPlatform = { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' };
const wsl2: WorkerPlatform = {
  platform: 'linux',
  wsl: 'wsl2',
  interop: false,
  automountRoot: '/mnt/',
};
const keep = [join(root, 'project'), join(root, 'state')];

const files = (m: Record<string, string>) => (f: string) => m[f];

describe('detectPlatform', () => {
  it('tells WSL2 from WSL1 and plain Linux by the kernel release', () => {
    expect(
      detectPlatform('linux', files({ '/proc/sys/kernel/osrelease': '6.8.0-45-generic' })).wsl,
    ).toBe('none');
    expect(
      detectPlatform('linux', files({ '/proc/sys/kernel/osrelease': '4.4.0-19041-Microsoft' })).wsl,
    ).toBe('wsl1');
    const p = detectPlatform(
      'linux',
      files({
        '/proc/sys/kernel/osrelease': '5.15.90-microsoft-standard-WSL2',
        '/proc/sys/fs/binfmt_misc/WSLInterop': 'enabled\ninterpreter /init\n',
        '/etc/wsl.conf': '[automount]\nroot = /win/\n',
      }),
    );
    expect(p).toEqual({ platform: 'linux', wsl: 'wsl2', interop: true, automountRoot: '/win/' });
  });
  it('interop is off without its binfmt entry; unknown when binfmt_misc cannot be read', () => {
    const release = { '/proc/sys/kernel/osrelease': '5.15.90-microsoft-standard-WSL2' };
    expect(
      detectPlatform('linux', files({ ...release, '/proc/sys/fs/binfmt_misc/status': 'enabled\n' }))
        .interop,
    ).toBe(false);
    expect(detectPlatform('linux', files(release)).interop).toBeUndefined();
  });
  it('macOS and Windows are what they are', () => {
    expect(detectPlatform('darwin', files({})).wsl).toBe('none');
    expect(detectPlatform('win32', files({})).platform).toBe('win32');
  });
  it('reads the automount root of wsl.conf, with comments and quotes', () => {
    expect(automountRoot(undefined)).toBe('/mnt/');
    expect(automountRoot('[boot]\nroot=/x\n[automount]\n# c\nroot = "/drives" # here\n')).toBe(
      '/drives/',
    );
    expect(automountRoot('[automount]\nroot = relative\n')).toBe('/mnt/');
  });
});

describe('sandboxProblem', () => {
  it('refuses native Windows, WSL1 and WSL2 with interop on or unknown', () => {
    expect(sandboxProblem({ platform: 'win32', wsl: 'none', automountRoot: '/mnt/' })).toMatch(
      /native Windows has no sandbox.*WSL2/,
    );
    expect(sandboxProblem({ ...wsl2, wsl: 'wsl1' })).toMatch(/WSL1 has no sandbox/);
    expect(sandboxProblem({ ...wsl2, interop: true })).toMatch(
      /interop is on.*outside the sandbox/,
    );
    const { interop: _i, ...unknown } = wsl2;
    expect(sandboxProblem(unknown)).toMatch(/cannot tell whether WSL interop is off/);
    expect(sandboxProblem({ platform: 'freebsd', wsl: 'none', automountRoot: '/mnt/' })).toMatch(
      /no sandbox/,
    );
  });
  it('allows macOS, Linux and WSL2 with interop off', () => {
    expect(sandboxProblem(linux)).toBeUndefined();
    expect(sandboxProblem({ ...linux, platform: 'darwin' })).toBeUndefined();
    expect(sandboxProblem(wsl2)).toBeUndefined();
  });
});

describe('enforceDeny', () => {
  const run = (
    paths: string[],
    ports: number[] = [],
    platform = linux,
    networkAllow = ['github.com'],
  ) => enforceDeny({ deny: { paths, ports }, platform, networkAllow, keep });

  it('denies a POSIX path as written and as its real path', () => {
    const real = join(root, 'data');
    mkdirSync(real);
    const r = run([`${real}/`]);
    expect(r).toEqual({ paths: [real], ports: [], notes: [] });
  });
  it('a Windows drive path holds only inside WSL2, as the whole drive', () => {
    expect(run(['D:\\data'])).toEqual({
      refused: expect.stringMatching(/Windows path: only a worker inside WSL2/),
    });
    const r = run(['D:\\data', 'd:/other', 'C:\\ProgramData\\Backup'], [], wsl2);
    expect(r).toMatchObject({ paths: ['/mnt/d', '/mnt/c'] });
    expect('notes' in r && r.notes.join('\n')).toMatch(
      /whole drive \/mnt\/d is denied.*ignore case/,
    );
  });
  it('a path below the automount root is a Windows drive as well', () => {
    expect(run(['/mnt/e/Data'], [], wsl2)).toMatchObject({ paths: ['/mnt/e'] });
    expect(run(['/mnt/e/Data'], [], linux)).toMatchObject({ paths: ['/mnt/e/Data'] });
  });
  it('refuses a deny entry over the worker checkout or state, and /', () => {
    expect(run([root])).toEqual({ refused: expect.stringMatching(/overlaps .*own checkout/) });
    expect(run([join(root, 'state', 'clones')])).toEqual({
      refused: expect.stringMatching(/overlaps/),
    });
    expect(run(['/'])).toEqual({ refused: expect.stringMatching(/denies everything/) });
    expect(run(['relative/path'])).toEqual({ refused: expect.stringMatching(/not an absolute/) });
  });
  it('with ports denied, a network_allow entry that may reach this machine refuses', () => {
    const lo = ['127', '0', '0', '1'].join('.');
    for (const entry of ['localhost', lo, '[::1]', '*', 'dbhost', 'nas.local', 'x.internal']) {
      expect(run([], [5432], linux, ['github.com', entry])).toEqual({
        refused: expect.stringMatching(/may reach this machine/),
      });
    }
    expect(run([], [5432], linux, ['github.com', `${lo}:5432`])).toEqual({
      refused: expect.stringMatching(/opens denied port 5432/),
    });
    expect(run([], [5432], linux, ['github.com', `${lo}:3000`, '*.npmjs.org'])).toEqual({
      paths: [],
      ports: [5432],
      notes: [],
    });
    // Without denied ports the network list is the sandbox's business, as for local crews.
    expect(run([], [], linux, ['localhost'])).toMatchObject({ ports: [] });
  });
  it('splits host and port', () => {
    expect(hostPort('example.org:8080')).toEqual({ host: 'example.org', port: 8080 });
    expect(hostPort('[::1]:443')).toEqual({ host: '[::1]', port: 443 });
    expect(hostPort('[::1]')).toEqual({ host: '[::1]' });
    expect(hostPort('github.com')).toEqual({ host: 'github.com' });
  });
});

describe('mergeDeny', () => {
  it('is the union: the repository can only add to the machine list, and the other way round', () => {
    expect(
      mergeDeny({ paths: ['/a'], ports: [5432] }, undefined, { paths: ['/b', '/a'], ports: [22] }),
    ).toEqual({ paths: ['/a', '/b'], ports: [5432, 22] });
  });
});

describe('denied ports in the guard', () => {
  it('finds a port in the usual spellings, not inside other numbers', () => {
    expect(namedDeniedPort('psql -h db -p 5432', [5432])).toBe(5432);
    expect(namedDeniedPort('psql postgres://u@db:5432/x', [5432])).toBe(5432);
    expect(namedDeniedPort('tool --port=5432', [5432])).toBe(5432);
    expect(namedDeniedPort('psql "port=5432 host=db"', [5432])).toBe(5432);
    expect(namedDeniedPort('echo 154321 :54320', [5432])).toBeUndefined();
    expect(namedDeniedPort('pnpm test', [])).toBeUndefined();
  });
  it('a crew command that names one is denied', () => {
    const wt = join(root, 'wt');
    mkdirSync(wt, { recursive: true });
    const ctx = {
      worktree: wt,
      ownerOnly: [],
      deployCommands: [],
      secretGlobs: [],
      deniedPorts: [5432],
    };
    expect(
      evaluateGuard({ toolName: 'Bash', toolInput: { command: 'nc db 5432 -p 5432' } }, ctx),
    ).toEqual({
      decision: 'deny',
      reason: 'port 5432 is denied on this worker machine',
    });
    expect(evaluateGuard({ toolName: 'Bash', toolInput: { command: 'ls' } }, ctx).decision).toBe(
      'allow',
    );
    expect(
      evaluateGuard(
        { toolName: 'Bash', toolInput: { command: 'ls' } },
        { ...ctx, deniedPorts: [0] },
      ).decision,
    ).toBe('deny');
  });
});

describe('a crew never writes claim refs', () => {
  const wt = join(root, 'wt-claims');
  mkdirSync(wt, { recursive: true });
  const ctx = {
    worktree: wt,
    ownerOnly: [],
    deployCommands: [],
    secretGlobs: [],
    item: 'APP-1',
    base: 'main',
  };
  const bash = (command: string) =>
    evaluateGuard({ toolName: 'Bash', toolInput: { command }, cwd: wt }, ctx);
  it('refuses a push to refs/studio/*, in full or as a short name git would match there', () => {
    expect(bash('git push origin HEAD:refs/studio/claims/APP-1')).toMatchObject({
      decision: 'deny',
      reason: expect.stringMatching(/non-branch ref/),
    });
    expect(bash('git push origin HEAD:studio/claims/APP-1')).toMatchObject({
      decision: 'deny',
      reason: expect.stringMatching(/name a branch in full/),
    });
    expect(bash('git push origin HEAD:studio/APP-2')).toMatchObject({ decision: 'deny' });
  });
  it('lets the item branch through, short or in full', () => {
    expect(bash('git push origin HEAD:refs/heads/studio/APP-1').decision).toBe('allow');
    expect(bash('git push origin HEAD:studio/APP-1').decision).toBe('allow');
  });
  it('refuses gh api, which could write any ref', () => {
    for (const c of [
      'gh api -X PATCH repos/org/app/git/refs/studio/claims/APP-1',
      'gh api repos/org/app/git/refs',
    ]) {
      expect(bash(c).decision).toBe('deny');
    }
  });
});
