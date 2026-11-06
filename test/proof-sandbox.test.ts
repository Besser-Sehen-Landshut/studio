import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bwrapArgs,
  LIMITS_REFUSED,
  limitedArgv,
  makeRunDir,
  proofEnv,
  realProofRunner,
  removeRunDir,
  type SandboxHost,
  type SandboxPlan,
  sandboxFor,
  sandboxUnavailable,
  seatbeltProfile,
} from '../src/proof-sandbox.js';

const plan = (over: Partial<SandboxPlan> = {}): SandboxPlan => ({
  run: '/private/var/folders/xy/T/studio-proof-abc',
  tmp: '/private/var/folders/xy/T/studio-proof-abc/tmp',
  cwd: '/private/var/folders/xy/T/studio-proof-abc/base',
  read: [],
  deny: [],
  ...over,
});

describe('the Seatbelt profile', () => {
  const home = '/srv/someone';
  it('denies the network, Mach services but a few, LaunchServices and AppleEvents', () => {
    const p = seatbeltProfile(plan(), home) as string;
    expect(p).toContain('(deny network*)');
    expect(p).toContain('(deny mach-lookup)');
    expect(p).toContain('(deny lsopen)');
    expect(p).toContain('(deny appleevent-send)');
    // no other process: no signals, no process information, no IPC, no registered services
    for (const rule of [
      '(deny mach-register)',
      '(deny signal)',
      '(allow signal (target same-sandbox))',
      '(deny process-info*)',
      '(allow process-info* (target same-sandbox))',
      '(deny ipc-posix*)',
      '(deny ipc-sysv*)',
    ]) {
      expect(p).toContain(rule);
    }
    expect(p).not.toMatch(/com\.apple\.(SecurityServer|securityd|trustd)/);
    // the allow-list of services comes after the deny, so it is the only way in
    expect(p.indexOf('(allow mach-lookup')).toBeGreaterThan(p.indexOf('(deny mach-lookup)'));
  });
  it('writes only in tmp; reads nothing of homes, shared temp dirs, volumes, the state', () => {
    const p = seatbeltProfile(plan({ deny: ['/srv/state', '/srv/studio-config'] }), home) as string;
    expect(p).toContain('(deny file-write*)');
    expect(p).toMatch(
      /\(allow file-write\* \(subpath "\/private\/var\/folders\/xy\/T\/studio-proof-abc\/tmp"\)/,
    );
    for (const d of [
      '/Users',
      '/Volumes',
      '/private/tmp',
      '/private/var/folders',
      '/srv/state',
      '/srv/studio-config',
      home,
    ]) {
      expect(p).toContain(`(subpath "${d}")`);
    }
    const denyAt = p.indexOf('(deny file-read*');
    const allowAt = p.indexOf(
      '(allow file-read* (subpath "/private/var/folders/xy/T/studio-proof-abc")',
    );
    expect(allowAt).toBeGreaterThan(denyAt);
    // the run dir's parents resolve, without their contents
    expect(p).toContain('(allow file-read-metadata (literal "/private/var/folders/xy/T")');
    expect(p).not.toMatch(/allow file-read\* \(subpath "\/private\/var\/folders"\)/);
  });
  it('lets the toolchain paths back in, read-only', () => {
    const p = seatbeltProfile(plan({ read: ['/srv/someone/.local/node'] }), home) as string;
    expect(p).toContain('(subpath "/srv/someone/.local/node")');
    expect(p).toContain('(literal "/srv/someone/.local")');
    expect(p).not.toMatch(/file-write\*[^\n]*\.local\/node/);
  });
  it('refuses a path it cannot quote, a tmp outside the run dir, a run dir in a fenced place', () => {
    expect(seatbeltProfile(plan({ read: ['/opt/a"b'] }), home)).toBeUndefined();
    expect(seatbeltProfile(plan({ read: ['/opt/a\\b'] }), home)).toBeUndefined();
    expect(seatbeltProfile(plan({ read: ['/opt/a\nb'] }), home)).toBeUndefined();
    expect(seatbeltProfile(plan({ read: ['relative'] }), home)).toBeUndefined();
    expect(seatbeltProfile(plan({ tmp: '/private/tmp/elsewhere' }), home)).toBeUndefined();
    expect(
      seatbeltProfile(
        plan({
          run: '/srv/someone/run',
          tmp: '/srv/someone/run/tmp',
          cwd: '/srv/someone/run',
        }),
        home,
      ),
    ).toBeUndefined();
    expect(
      seatbeltProfile(
        plan({ run: '/srv/state/run', tmp: '/srv/state/run/tmp', deny: ['/srv/state'] }),
        home,
      ),
    ).toBeUndefined();
  });
});

describe('the bubblewrap arguments', () => {
  const probe = (p: string) =>
    p === '/bin' || p === '/lib' ? 'link' : p === '/nix' ? 'missing' : 'dir';
  const link = (p: string) => `usr${p}`;
  const linux = plan({
    run: '/tmp/studio-proof-abc',
    tmp: '/tmp/studio-proof-abc/tmp',
    cwd: '/tmp/studio-proof-abc/base',
  });
  it('binds only system dirs, the toolchains and the run dir, in new namespaces', () => {
    const a = bwrapArgs({ ...linux, read: ['/home/someone/.cargo'] }, probe, link) as string[];
    const s = a.join(' ');
    expect(a.slice(0, 5)).toEqual([
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--cap-drop',
      'ALL',
    ]);
    expect(a).not.toContain('--share-net');
    expect(s).not.toMatch(/--(ro-)?bind \/ \//);
    expect(s).toContain('--ro-bind /usr /usr');
    expect(s).toContain('--symlink usr/bin /bin');
    expect(s).not.toContain('/nix');
    expect(s).toContain('--ro-bind /home/someone/.cargo /home/someone/.cargo');
    expect(s).not.toMatch(/--bind \/home/);
    expect(s).toContain('--tmpfs /tmp');
    expect(s).toContain('--ro-bind /tmp/studio-proof-abc /tmp/studio-proof-abc');
    expect(s).toContain('--bind /tmp/studio-proof-abc/tmp /tmp/studio-proof-abc/tmp');
    expect(s).toContain('--chdir /tmp/studio-proof-abc/base');
    expect(a.at(-1)).toBe('--');
    // the run dir comes after the fresh /tmp, its tmp last: later mounts win
    expect(s.indexOf('--ro-bind /tmp/studio-proof-abc ')).toBeGreaterThan(
      s.indexOf('--tmpfs /tmp'),
    );
    for (const never of ['/var', '/run', '/mnt', '/opt', '/root', '/home ']) {
      expect(s.includes(`--ro-bind ${never}`), never).toBe(false);
    }
  });
  it('refuses a tmp outside the run dir', () => {
    expect(bwrapArgs({ ...linux, tmp: '/tmp/other' }, probe, link)).toBeUndefined();
  });
});

describe('limits and environment', () => {
  it('sets CPU time and file size before the command, which never passes through a shell', () => {
    const a = limitedArgv(['node', 'prove.mjs', '$(touch x)'], {
      timeoutMs: 1000,
      cpuSeconds: 30,
      maxOutput: 10,
      maxFileBytes: 4 * 1024 * 1024,
    });
    expect(a.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(a[2]).toBe(
      `ulimit -t "$1" && ulimit -f "$2" || exit ${LIMITS_REFUSED}; shift 2; exec "$@"`,
    );
    expect(a.slice(3)).toEqual(['sh', '30', '4096', 'node', 'prove.mjs', '$(touch x)']);
  });
  it('the environment is an allow-list: nothing of the caller reaches the command', () => {
    const env = proofEnv(['/opt/tool'], '/r/tmp', { STUDIO_PROOF_NONCE: 'n' });
    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'STUDIO_PROOF_NONCE',
      'TMPDIR',
      'TZ',
    ]);
    expect(env.HOME).toBe('/r/tmp');
    expect(env.TMPDIR).toBe('/r/tmp');
    expect(env.PATH?.split(':').slice(0, 2)).toEqual(['/opt/tool/bin', '/opt/tool']);
    expect(env.PATH).not.toContain(homedir());
    expect(() => proofEnv([], '/t', { GH_TOKEN: 'x' })).toThrow(/not a proof variable/);
  });
});

describe('no sandbox, no command', () => {
  const host = (o: Partial<SandboxHost>): SandboxHost => ({
    platform: 'linux',
    exists: () => true,
    probe: () => 0,
    ...o,
  });
  it('a platform without a sandbox is refused', () => {
    for (const platform of ['win32', 'freebsd', 'aix'] as NodeJS.Platform[]) {
      expect(sandboxUnavailable(host({ platform }))).toBe(
        `no sandbox for proof commands on ${platform}`,
      );
    }
  });
  it('a missing tool is refused', () => {
    expect(sandboxUnavailable(host({ platform: 'darwin', exists: () => false }))).toBe(
      '/usr/bin/sandbox-exec is missing',
    );
    expect(sandboxUnavailable(host({ exists: () => false }))).toBe(
      'bubblewrap (bwrap) is not installed',
    );
  });
  it('a tool that does not start or refuses its arguments is refused', () => {
    expect(sandboxUnavailable(host({ probe: () => undefined }))).toMatch(/does not start/);
    expect(sandboxUnavailable(host({ probe: () => 1 }))).toMatch(/cannot create its namespaces/);
    expect(sandboxUnavailable(host({ platform: 'darwin', probe: () => 65 }))).toMatch(
      /refuses the profile/,
    );
    expect(sandboxUnavailable(host({}))).toBeUndefined();
  });
  it('bwrap is looked for in fixed places, never on the PATH', () => {
    const seen: string[] = [];
    sandboxFor(
      host({
        exists: (p) => {
          seen.push(p);
          return false;
        },
      }),
    );
    expect(seen.every((p) => p.startsWith('/'))).toBe(true);
  });
});

// The real sandbox of this machine, where there is one.
const why = sandboxUnavailable();
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'studio-sandbox-it-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(why !== undefined)(
  `the real sandbox${why === undefined ? '' : ` (skipped: ${why})`}`,
  () => {
    // node and its install, read-only, as a toolchain path would be
    const nodeDir = realpathSync(dirname(dirname(process.execPath)));
    const run = async (script: string, args: string[] = [], timeoutMs = 20_000) => {
      const dirs = makeRunDir();
      const base = join(dirs.run, 'base');
      mkdirSync(base);
      writeFileSync(join(base, 'prove.cjs'), script);
      try {
        return await realProofRunner.run(
          [process.execPath, 'prove.cjs', ...args],
          proofEnv([nodeDir], dirs.tmp, {}),
          { ...dirs, cwd: base, read: [nodeDir], deny: [scratch] },
          { timeoutMs, cpuSeconds: 20, maxOutput: 64 * 1024, maxFileBytes: 1024 * 1024 },
          'the-secret',
        );
      } finally {
        removeRunDir(dirs.run);
      }
    };
    const out = async (script: string, args: string[] = []) => {
      const r = await run(script, args);
      if (r.kind !== 'exited') throw new Error(`run ${r.kind}: ${'why' in r ? r.why : ''}`);
      return { code: r.code, text: r.stdout.trim() };
    };

    it('blocks the network: no connection, no name lookup', async () => {
      // A server of this test, outside the sandbox: reachable from here, not from inside.
      const server = createServer((c) => c.end());
      await new Promise<void>((done) => server.listen(0, 'localhost', done));
      const { port } = server.address() as AddressInfo;
      const probe = `
        const s = require('node:net').connect({ host: 'localhost', port: Number(process.argv.at(-1)), timeout: 3000 });
        s.on('connect', () => { console.log('open'); process.exit(0); });
        s.on('error', (e) => { console.log('blocked ' + e.code); process.exit(0); });
        s.on('timeout', () => { console.log('blocked timeout'); process.exit(0); });
      `;
      try {
        // the same probe connects without the sandbox, so a "blocked" inside means the sandbox
        const outside = execFileSync(process.execPath, ['-e', probe, String(port)], {
          encoding: 'utf8',
        });
        expect(outside.trim()).toBe('open');
        const r = await out(probe, [String(port)]);
        expect(r.text).toMatch(/^blocked /);
      } finally {
        server.close();
      }
      const dns = await out(`
        require('node:dns').lookup('example.com', (e) => console.log(e ? 'blocked' : 'resolved'));
      `);
      expect(dns.text).toBe('blocked');
    });
    it('keeps the home and shared temp files unreadable', async () => {
      const secret = join(scratch, 'secret.txt');
      writeFileSync(secret, 'secret');
      const r = await out(
        `
        const fs = require('node:fs');
        for (const p of process.argv.slice(2)) {
          try { fs.readdirSync(p); console.log('listed ' + p); continue; } catch {}
          try { fs.readFileSync(p); console.log('read ' + p); } catch (e) { console.log('denied ' + e.code); }
        }
      `,
        [homedir(), join(homedir(), '.gitconfig'), secret],
      );
      expect(r.text).not.toMatch(/listed|read /);
      expect(r.text.split('\n')).toHaveLength(3);
    });
    it('writes in tmp only, never in the base tree; sees an allow-listed environment', async () => {
      const r = await out(`
        const fs = require('node:fs');
        fs.writeFileSync(process.env.TMPDIR + '/a', 'x');
        console.log('tmp ' + fs.readFileSync(process.env.TMPDIR + '/a', 'utf8'));
        try { fs.writeFileSync('b', 'x'); console.log('base written'); } catch (e) { console.log('base denied'); }
        console.log('env ' + Object.keys(process.env).sort().join(','));
      `);
      expect(r.text).toContain('tmp x');
      expect(r.text).toContain('base denied');
      // the allow-list, and what the limit shell and macOS set themselves
      const own = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'];
      const set = ['PWD', 'SHLVL', 'OLDPWD', '_', '__CF_USER_TEXT_ENCODING'];
      const names = (/^env (.*)$/m.exec(r.text)?.[1] ?? '').split(',');
      expect(names).toEqual(expect.arrayContaining(own));
      expect(names.filter((n) => !own.includes(n) && !set.includes(n))).toEqual([]);
    });
    it('hands the secret on fd 3 only: a child started after the read finds nothing there', async () => {
      const r = await out(`
        const fs = require('node:fs');
        const secret = fs.readFileSync(3, 'utf8');
        const child = require('node:child_process').spawnSync(process.execPath, ['-e', \`
          let got = 'nothing';
          try { got = require('node:fs').readFileSync(3, 'utf8') || 'nothing'; } catch {}
          console.log(got + ' ' + JSON.stringify(process.env).includes('the-secret'));
        \`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore', 3] });
        console.log('top ' + secret);
        console.log('child ' + child.stdout.trim());
      `);
      expect(r.text).toContain('top the-secret');
      expect(r.text).toContain('child nothing false');
    });
    it('cannot signal a process outside the sandbox', async () => {
      const other = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        const r = await out(
          `
          try { process.kill(Number(process.argv.at(-1)), 'SIGTERM'); console.log('signalled'); }
          catch (e) { console.log('refused ' + e.code); }
        `,
          [String(other.pid)],
        );
        expect(r.text).toMatch(/^refused (EPERM|ESRCH)$/);
        expect(other.exitCode).toBeNull();
        expect(other.signalCode).toBeNull();
      } finally {
        other.kill();
      }
    });
    it('caps the output and the wall clock', async () => {
      const big = await run(
        `process.stdout.write('x'.repeat(1024 * 1024)); setTimeout(() => {}, 5000);`,
      );
      expect(big.kind === 'exited' && big.tooLarge).toBe(true);
      const slow = await run('setInterval(() => {}, 1000);', [], 1500);
      expect(slow.kind).toBe('timeout');
    });
  },
);
