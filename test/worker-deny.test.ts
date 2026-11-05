import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig, wildcardOverIp } from '../src/config.js';
import { evaluateGuard } from '../src/guard.js';
import {
  automountRoot,
  detectPlatform,
  enforceDeny,
  hostPort,
  ipLiteral,
  mergeDeny,
  namedDeniedPort,
  normalizeHost,
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
    expect(p).toEqual({
      platform: 'linux',
      wsl: 'wsl2',
      interop: true,
      automountRoot: '/win/',
      windowsMounts: [],
    });
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
    expect(r).toEqual({ paths: [real], ports: [], allowRead: [], notes: [] });
  });
  it('a Windows drive path holds only inside WSL2, as the whole drive', () => {
    expect(run(['D:\\data'])).toEqual({
      refused: expect.stringMatching(/Windows path: only a worker inside WSL2/),
    });
    const r = run(['D:\\data', 'd:/other', 'C:\\ProgramData\\Backup'], [], wsl2);
    expect(r).toMatchObject({ paths: ['/mnt/d', '/mnt/c', '/mnt'] });
    expect('notes' in r && r.notes.join('\n')).toMatch(
      /whole drive \/mnt\/d is denied.*ignore case/,
    );
  });
  it('a path below the automount root is a Windows drive as well', () => {
    expect(run(['/mnt/e/Data'], [], wsl2)).toMatchObject({ paths: ['/mnt/e', '/mnt'] });
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
      allowRead: [],
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

describe('WSL2: Windows file systems are denied by default', () => {
  const mountinfo = [
    '36 25 0:31 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs',
    '37 25 0:32 / /mnt/e rw,noatime - drvfs E:\\134 rw',
    '38 25 0:33 / /data/win\\040share rw - virtiofs share rw',
    '24 1 8:32 / / rw - ext4 /dev/sdc rw',
  ].join('\n');
  const release = { '/proc/sys/kernel/osrelease': '5.15.90-microsoft-standard-WSL2' };
  it('reads every drvfs, 9p and virtiofs mount from mountinfo', () => {
    const p = detectPlatform(
      'linux',
      files({
        ...release,
        '/proc/self/mountinfo': mountinfo,
        '/proc/sys/fs/binfmt_misc/status': 'enabled',
      }),
      {},
      () => false,
    );
    expect(p.windowsMounts).toEqual(['/mnt/c', '/mnt/e', '/data/win share']);
  });
  it('tells WSL by other signs too, and refuses when its version cannot be told', () => {
    const cases: [
      Record<string, string>,
      (f: string) => boolean,
      (f: string) => string | undefined,
    ][] = [
      [{ WSL_DISTRO_NAME: 'Ubuntu' }, () => false, files({})],
      [{}, (f) => f === '/run/WSL', files({})],
      [{}, () => false, files({ '/proc/sys/fs/binfmt_misc/WSLInterop-late': 'enabled' })],
    ];
    for (const [env, exists, read] of cases) {
      const p = detectPlatform('linux', read, env, exists);
      expect(p.wsl).toBe('unknown');
      expect(sandboxProblem(p)).toMatch(/version cannot be told/);
    }
    expect(detectPlatform('linux', files({}), {}, () => false).wsl).toBe('none');
  });
  it('denies the automount root and every Windows mount; opens single places for reads', () => {
    const p: WorkerPlatform = { ...wsl2, windowsMounts: ['/mnt/c', '/data/share'] };
    const r = enforceDeny({
      deny: { paths: [], ports: [] },
      platform: p,
      networkAllow: [],
      keep,
      allowRead: ['C:\\analysis\\files', '/data/share/in'],
    });
    expect(r).toMatchObject({
      paths: ['/mnt', '/mnt/c', '/data/share'],
      allowRead: ['/mnt/c/analysis/files', '/data/share/in'],
    });
  });
  it('an opened place inside a denied path, or off the Windows mounts, refuses', () => {
    const run = (deny: string[], allowRead: string[], platform = wsl2) =>
      enforceDeny({
        deny: { paths: deny, ports: [] },
        platform,
        networkAllow: [],
        keep,
        allowRead,
      });
    expect(run(['D:\\data'], ['D:\\other'])).toEqual({
      refused: expect.stringMatching(/lies inside the denied \/mnt\/d; the deny list wins/),
    });
    expect(run([], ['/srv/elsewhere'])).toEqual({
      refused: expect.stringMatching(/does not lie on a Windows file system/),
    });
    expect(run([], ['/mnt/c/x'], linux)).toEqual({
      refused: expect.stringMatching(/only holds inside WSL2/),
    });
  });
  it('a worker checkout on a Windows drive refuses', () => {
    expect(
      enforceDeny({
        deny: { paths: [], ports: [] },
        platform: wsl2,
        networkAllow: [],
        keep: ['/mnt/c/work/project'],
      }),
    ).toEqual({ refused: expect.stringMatching(/lies on a Windows file system/) });
  });
});

describe('IP addresses in every spelling', () => {
  it('counts decimal, octal, hex, short, integer and IPv6 forms as addresses', () => {
    for (const h of ['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '[::ffff:7f00:1]', '::1']) {
      expect(ipLiteral(h), h).toBe(true);
    }
    for (const h of ['github.com', 'registry.npmjs.org', '1x.example']) {
      expect(ipLiteral(h), h).toBe(false);
    }
  });
  it('such a spelling without a port refuses when ports are denied', () => {
    for (const entry of [
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
      `[::ffff:${['127', '0', '0', '1'].join('.')}]`,
    ]) {
      expect(
        enforceDeny({
          deny: { paths: [], ports: [5432] },
          platform: linux,
          networkAllow: [entry],
          keep,
        }),
        entry,
      ).toEqual({ refused: expect.stringMatching(/may reach this machine/) });
    }
  });
});

describe('hosts are normalised before they are judged', () => {
  const lo = ['127', '0', '0', '1'].join('.');
  const spellings = [
    'localhost.',
    'LOCALHOST',
    '127.1',
    '0x7f.1',
    '2130706433',
    `[::ffff:${lo}]`,
    `${lo}.`,
    'LocalHost.',
  ];
  it('lowercases, drops one trailing dot and normalises IP spellings as a URL parser does', () => {
    expect(normalizeHost('localhost.')).toEqual({ host: 'localhost', wildcard: false, ip: 0 });
    expect(normalizeHost('LOCALHOST')).toEqual({ host: 'localhost', wildcard: false, ip: 0 });
    for (const h of ['127.1', '0x7f.1', '2130706433', `${lo}.`]) {
      expect(normalizeHost(h), h).toEqual({ host: lo, wildcard: false, ip: 4 });
    }
    expect(normalizeHost(`[::ffff:${lo}]`)).toEqual({
      host: '::ffff:7f00:1',
      wildcard: false,
      ip: 6,
    });
    expect(normalizeHost('*.NpmJS.org.')).toEqual({ host: 'npmjs.org', wildcard: true, ip: 0 });
    for (const bad of ['a..', 'exa mple.com', '[nope]', '.'])
      expect(normalizeHost(bad), bad).toBeUndefined();
  });
  it('every such spelling, without a port, refuses when ports are denied', () => {
    for (const entry of spellings) {
      expect(
        enforceDeny({
          deny: { paths: [], ports: [5432] },
          platform: linux,
          networkAllow: ['github.com', entry],
          keep,
        }),
        entry,
      ).toEqual({ refused: expect.stringMatching(/may reach this machine/) });
    }
  });
  it('a denied port is found behind any of them, and a host that does not parse refuses', () => {
    expect(
      enforceDeny({
        deny: { paths: [], ports: [5432] },
        platform: linux,
        networkAllow: ['LOCALHOST.:5432'],
        keep,
      }),
    ).toEqual({ refused: expect.stringMatching(/opens denied port 5432/) });
    expect(
      enforceDeny({
        deny: { paths: [], ports: [5432] },
        platform: linux,
        networkAllow: ['exa mple.com'],
        keep,
      }),
    ).toEqual({ refused: expect.stringMatching(/cannot be read as a host/) });
    // Named hosts with a dot and no local suffix stay allowed, in any case and with a trailing dot.
    expect(
      enforceDeny({
        deny: { paths: [], ports: [5432] },
        platform: linux,
        networkAllow: ['GitHub.com.', '*.npmjs.org'],
        keep,
      }),
    ).toMatchObject({ ports: [5432] });
  });
});

describe('a wildcard over an IP address is refused', () => {
  const lo = ['127', '0', '0', '1'].join('.');
  const wild = [`*.${lo}`, `*.${lo}.`, '*.0x7f.1', '*.2130706433', '*.[::1]', `*.${lo}:443`];
  it('in enforceDeny, with ports denied or not', () => {
    for (const entry of wild) {
      for (const ports of [[], [5432]]) {
        expect(
          enforceDeny({ deny: { paths: [], ports }, platform: linux, networkAllow: [entry], keep }),
          entry,
        ).toEqual({ refused: expect.stringMatching(/is a wildcard over an IP address/) });
      }
    }
    expect(
      enforceDeny({
        deny: { paths: [], ports: [5432] },
        platform: linux,
        networkAllow: ['*.npmjs.org'],
        keep,
      }),
    ).toMatchObject({ ports: [5432] });
  });
  it('when studio.yaml is loaded', () => {
    expect(wildcardOverIp(`*.${lo}`)).toBe(true);
    expect(wildcardOverIp('*.npmjs.org')).toBe(false);
    expect(wildcardOverIp(lo)).toBe(false);
    const yaml = (entry: string) =>
      `studio: 1\nprimary_repo: org/app\nrepos: [org/app]\nci: { provider: github, runners: github-hosted, runner_labels: [], capacity: { total: 4, merge_max_busy: 3, check_twice_seconds: 30 } }\nmerge: { strategy: studio-queue, contract_paths: [] }\nroles: { builder: { model: sonnet, wip: 1 } }\nsandbox: { network_allow: ["${entry}"] }\n`;
    for (const entry of wild) {
      expect(() => parseConfig(yaml(entry), 'studio.yaml'), entry).toThrow(
        /a wildcard over an IP address means nothing/,
      );
    }
    expect(parseConfig(yaml('*.npmjs.org'), 'studio.yaml').sandbox.networkAllow).toEqual([
      '*.npmjs.org',
    ]);
  });
});
