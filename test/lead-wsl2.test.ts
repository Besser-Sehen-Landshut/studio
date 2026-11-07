// The lead on a Windows PC, in WSL2: what the lead machine checks find, and `relay pair` with
// `--connect` run there (Linux paths, the Linux ssh client, the host key pinned), with the files
// that must never lie on a Windows drive mounted into the distribution.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOwnerConfig } from '../src/config.js';
import {
  installCommand,
  leadKind,
  leadMachineProblem,
  onPath,
  onWindowsDrive,
} from '../src/lead-machine.js';
import { realPorts } from '../src/ports.js';
import { type Exec, runRelayCommand } from '../src/relay-command.js';
import { pairProof, parsePairLine } from '../src/relay-pair.js';
import { encodeMessage, LineReader, readMessage } from '../src/relay-protocol.js';
import type { RelayTransport } from '../src/relay-transport.js';
import type { WorkerPlatform } from '../src/worker-deny.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-wsl2-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const wsl2 = (o: Partial<WorkerPlatform> = {}): WorkerPlatform => ({
  platform: 'linux',
  wsl: 'wsl2',
  interop: true,
  automountRoot: '/mnt/',
  windowsMounts: [],
  ...o,
});

describe('the lead machine', () => {
  it('tells the kinds apart; native Windows and WSL1 get the way to WSL2', () => {
    expect(leadKind(wsl2())).toBe('wsl2');
    expect(leadKind({ platform: 'linux', wsl: 'wsl1', automountRoot: '/mnt/' })).toBe('wsl1');
    expect(leadKind({ platform: 'linux', wsl: 'unknown', automountRoot: '/mnt/' })).toBe('wsl1');
    expect(leadKind({ platform: 'linux', wsl: 'none', automountRoot: '/mnt/' })).toBe('linux');
    expect(leadKind({ platform: 'darwin', wsl: 'none', automountRoot: '/mnt/' })).toBe('macos');
    expect(leadKind({ platform: 'win32', wsl: 'none', automountRoot: '/mnt/' })).toBe('windows');
    expect(leadMachineProblem('windows', {})?.fix).toContain('wsl --install -d Ubuntu-24.04');
    expect(leadMachineProblem('wsl1', { WSL_DISTRO_NAME: 'Debian' })?.fix).toContain(
      'wsl --set-version Debian 2',
    );
    // Interop is the worker's concern; the lead runs with it on.
    expect(leadMachineProblem('wsl2', {})).toBeUndefined();
  });

  it('names the install command of each tool for Ubuntu and for macOS', () => {
    expect(installCommand('node', 'wsl2')).toContain('setup_24.x');
    expect(installCommand('gh', 'wsl2')).toBe('sudo apt-get install -y gh');
    expect(installCommand('ssh', 'wsl2')).toBe('sudo apt-get install -y openssh-client');
    expect(installCommand('claude', 'wsl2')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installCommand('gh', 'macos')).toBe('brew install gh');
  });

  it('knows a Windows drive: the automount root and the drvfs mounts, never elsewhere', () => {
    expect(onWindowsDrive('/mnt/c/work/project', wsl2())).toBe(true);
    expect(onWindowsDrive('/mnt/c', wsl2())).toBe(true);
    expect(onWindowsDrive('/home/me/project', wsl2())).toBe(false);
    expect(onWindowsDrive('/mntx/c', wsl2())).toBe(false);
    expect(
      onWindowsDrive('/win/d/x', wsl2({ automountRoot: '/', windowsMounts: ['/win/d'] })),
    ).toBe(true);
    // An automount root of / would make every path a Windows one: only its mounts count then.
    expect(onWindowsDrive('/home/me', wsl2({ automountRoot: '/' }))).toBe(false);
    expect(
      onWindowsDrive('/mnt/c/x', { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' }),
    ).toBe(false);
  });

  it('finds an executable on PATH only', () => {
    const dir = join(root, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'plain'), 'x');
    chmodSync(join(dir, 'tool'), 0o755);
    expect(onPath('tool', { PATH: dir })).toBe(join(dir, 'tool'));
    expect(onPath('plain', { PATH: dir })).toBeUndefined();
    expect(onPath('tool', {})).toBeUndefined();
  });
});

async function* none(): AsyncGenerator<string> {}

describe('relay pair from a WSL2 lead', () => {
  const lead = (o: { platform?: WorkerPlatform; xdg?: string; exec?: Exec } = {}) => {
    const home = join(root, `lead-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(home, { recursive: true });
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      ...(o.xdg === undefined ? {} : { XDG_CONFIG_HOME: o.xdg, XDG_STATE_HOME: o.xdg }),
    };
    const owner = { env, homedir: home };
    const hostFile = join(home, 'host');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostFile]);
    const host = readFileSync(`${hostFile}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
    const out: string[] = [];
    let secret: string | undefined;
    const transport: RelayTransport = {
      async call() {
        const lines = encodeMessage({
          studioRelay: 1,
          ok: true,
          studio: '9.9.9',
          platform: 'win32',
          plugins: {},
          busy: null,
          held: null,
          pairProofs: secret === undefined ? [] : [{ label: 'lab', mac: pairProof(secret, host) }],
          warnings: [],
        });
        return (await readMessage(
          new LineReader(
            (async function* () {
              yield* lines;
            })(),
            1 << 20,
          ),
          0,
        )) as { header: Record<string, unknown> };
      },
    };
    const exec: Exec =
      o.exec ??
      (async (file, args) => {
        if (file === 'ssh-keyscan')
          return { code: 0, stdout: `worker.example ${host}\n`, stderr: '' };
        try {
          return { code: 0, stdout: execFileSync(file, args, { encoding: 'utf8' }), stderr: '' };
        } catch {
          return { code: 1, stdout: '', stderr: '' };
        }
      });
    const run = (rest: string[], values: Record<string, unknown> = {}) =>
      runRelayCommand({
        rest,
        values,
        owner,
        ports: realPorts(),
        env,
        homedir: home,
        stdin: none(),
        stdout: (s) => out.push(s),
        stderr: () => {},
        transport: () => transport,
        exec,
        platform: o.platform ?? wsl2(),
      });
    const take = () => {
      const line = /-Pair '([^']+)'/.exec(out.join(''))?.[1] as string;
      secret = parsePairLine(line).secret;
    };
    return { home, owner, out, run, take, host };
  };

  it('pairs and connects with Linux paths, the host key pinned; prints the bootstrap line for the PC', async () => {
    const l = lead();
    expect(await l.run(['pair', 'lab', 'worker.example'])).toBe(0);
    const printed = l.out.join('');
    expect(printed).toContain("studio-relay-bootstrap.ps1))) -Pair 'studio-pair-1 lab ");
    expect(printed).toContain('never over SSH');
    l.take();
    expect(await l.run(['pair', 'lab'], { connect: true })).toBe(0);
    const target = loadOwnerConfig(l.owner).workers?.relay.lab;
    expect(target?.hostKey).toBe(l.host);
    expect(target?.identityFile.startsWith(`${l.home}/`)).toBe(true);
    expect(target?.identityFile).not.toMatch(/^\/mnt\//);
  });

  it('refuses keys and pinned host keys on a Windows drive, before any key is made', async () => {
    const win = join(root, 'c-drive');
    mkdirSync(win, { recursive: true });
    const l = lead({
      platform: wsl2({ windowsMounts: [win] }),
      xdg: join(win, 'Users', 'me', 'cfg'),
    });
    await expect(l.run(['pair', 'lab', 'worker.example'])).rejects.toThrow(
      /is on a Windows drive, which keeps no file modes, so ssh would refuse the key: unset XDG_CONFIG_HOME/,
    );
    expect(l.out.join('')).toBe('');
  });

  it('names the package when ssh-keygen or ssh-keyscan is missing', async () => {
    const missing: Exec = async () => ({ code: 127, stdout: '', stderr: '' });
    const l = lead({ exec: missing });
    await expect(l.run(['pair', 'lab', 'worker.example'])).rejects.toThrow(
      'ssh-keygen is not installed here: sudo apt-get install -y openssh-client, then run this again',
    );
    // A pairing that waits, and no ssh-keyscan.
    const m = lead();
    await m.run(['pair', 'lab', 'worker.example']);
    const n = lead({ exec: missing });
    await expect(
      runRelayCommand({
        rest: ['pair', 'lab'],
        values: { connect: true },
        owner: m.owner,
        ports: realPorts(),
        env: m.owner.env,
        homedir: m.home,
        stdin: none(),
        stdout: () => {},
        stderr: () => {},
        exec: missing,
        platform: wsl2(),
      }),
    ).rejects.toThrow('ssh-keyscan is not installed here: sudo apt-get install -y openssh-client');
    expect(n.out).toEqual([]);
  });
});
