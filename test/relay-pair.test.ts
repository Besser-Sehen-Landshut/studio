// Pairing a lead with a relay worker, and the install script of a Windows relay worker.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
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
import { realPorts } from '../src/ports.js';
import { type Exec, relayContext, runRelayCommand } from '../src/relay-command.js';
import {
  hostKeyCode,
  keyscanKey,
  newPairCode,
  PAIR_CODE_RE,
  parsePairLine,
  readPairings,
  renderPairLine,
  writePairing,
} from '../src/relay-pair.js';
import { encodeMessage, LineReader, readMessage } from '../src/relay-protocol.js';
import { serveRelay } from '../src/relay-serve.js';
import type { RelayTransport } from '../src/relay-transport.js';
import { relaySetupScript } from '../src/relay-windows.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-pair-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const keygen = (file: string) =>
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
const pubOf = (file: string) =>
  readFileSync(`${file}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');

async function* chunks(lines: Iterable<string>): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

describe('pairing lines and codes', () => {
  it('a line holds the label, a one-time code and the key, and nothing else parses', () => {
    const f = join(root, `k${n++}`);
    keygen(f);
    const code = newPairCode();
    expect(code).toMatch(PAIR_CODE_RE);
    const line = renderPairLine({ label: 'lab', code, key: pubOf(f) });
    expect(parsePairLine(line)).toEqual({ label: 'lab', code, key: pubOf(f) });
    for (const bad of [
      `${line} extra`,
      line.replace('studio-pair-1', 'studio-pair-2'),
      line.replace(code, 'OOOO-0000'),
      line.replace('lab', 'Lab'),
      'ssh-ed25519 AAAA',
    ]) {
      expect(() => parsePairLine(bad), bad).toThrow(/not a pairing line/);
    }
  });

  it('the host key code is the key itself, the same on both machines', () => {
    const f = join(root, `h${n++}`);
    keygen(f);
    const key = pubOf(f);
    expect(hostKeyCode(key)).toMatch(PAIR_CODE_RE);
    expect(hostKeyCode(`${key} comment`)).toBe(hostKeyCode(key));
    const g = join(root, `h${n++}`);
    keygen(g);
    expect(hostKeyCode(pubOf(g))).not.toBe(hostKeyCode(key));
    expect(keyscanKey(`# comment\nworker.example ${key}\n`)).toBe(key);
    expect(keyscanKey('worker.example ssh-rsa AAAA\n')).toBeUndefined();
  });

  it('a worker keeps its pairings by label and names their codes in hello', async () => {
    const home = join(root, `relay-home-${n++}`);
    mkdirSync(home);
    writePairing(home, 'lab', 'ABCD-EFGH');
    writePairing(home, 'lab', 'JKMN-PQRS');
    expect(readPairings(home)).toEqual({ lab: 'JKMN-PQRS' });
    const ctx = relayContext({
      owner: { env: { PATH: process.env.PATH }, homedir: home },
      home,
      ports: realPorts(),
      env: { PATH: process.env.PATH },
      homedir: home,
      platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' },
      load: async () => ({ cpuPercent: 1, freeDiskGb: 100 }),
      log: () => {},
    });
    let out = '';
    await serveRelay(ctx, chunks(encodeMessage({ studioRelay: 1, op: 'hello' })), (s) => {
      out += s;
    });
    const msg = await readMessage(new LineReader(chunks([out]), 1 << 20), 0);
    expect(msg?.header).toMatchObject({ ok: true, pairCodes: ['JKMN-PQRS'] });
  });
});

describe('studio relay pair on the lead', () => {
  function setup() {
    const home = join(root, `lead-${n++}`);
    mkdirSync(home);
    const owner = { env: { PATH: process.env.PATH }, homedir: home };
    const worker = join(root, `worker-host-${n++}`);
    keygen(worker);
    const out: string[] = [];
    let pairCodes: string[] = [];
    const transport: RelayTransport = {
      async call(header) {
        const lines = [
          ...encodeMessage({
            studioRelay: 1,
            ok: true,
            studio: '9.9.9',
            platform: 'win32',
            plugins: {},
            busy: null,
            held: null,
            pairCodes,
            warnings: [],
          }),
        ];
        expect(header.op).toBe('hello');
        return (await readMessage(new LineReader(chunks(lines), 1 << 20), 0)) as {
          header: Record<string, unknown>;
        };
      },
    };
    const exec: Exec = async (file, args) => {
      if (file === 'ssh-keyscan') {
        return { code: 0, stdout: `worker.example ${pubOf(worker)}\n`, stderr: '' };
      }
      try {
        const stdout = execFileSync(file, args, { encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
      } catch {
        return { code: 1, stdout: '', stderr: '' };
      }
    };
    const run = (
      rest: string[],
      values: Record<string, unknown> = {},
      readLine?: (p: string) => Promise<string | undefined>,
    ) =>
      runRelayCommand({
        rest,
        values,
        owner,
        ports: realPorts(),
        env: owner.env,
        homedir: home,
        stdin: chunks([]),
        stdout: (s) => out.push(s),
        stderr: () => {},
        transport: () => transport,
        exec,
        ...(readLine === undefined ? {} : { readLine }),
      });
    return {
      home,
      owner,
      out,
      run,
      hostCode: hostKeyCode(pubOf(worker)),
      hostKey: pubOf(worker),
      setCodes: (c: string[]) => {
        pairCodes = c;
      },
    };
  }

  it('prints one line, then pins the host key only when its code is confirmed', async () => {
    const s = setup();
    expect(await s.run(['pair', 'lab', 'worker.example'])).toBe(0);
    const line = /studio relay install --pair "([^"]+)"/.exec(s.out.join(''))?.[1] as string;
    const pair = parsePairLine(line);
    expect(pair.label).toBe('lab');
    expect(existsSync(join(s.home, '.config', 'studio', 'relay', 'lab_ed25519'))).toBe(true);
    // The worker took the pairing.
    s.setCodes([pair.code]);
    // A code that does not match pins nothing.
    expect(await s.run(['pair', 'lab'], { connect: true, code: 'AAAA-AAAA' })).toBe(1);
    expect(loadOwnerConfig(s.owner).workers?.relay.lab).toBeUndefined();
    // Asked in a terminal, a "no" pins nothing either.
    expect(await s.run(['pair', 'lab'], { connect: true }, async () => 'n')).toBe(1);
    // Confirmed: the worker goes into the owner config with the pinned key.
    expect(
      await s.run(['pair', 'lab'], { connect: true }, async (prompt) => {
        expect(prompt).toContain(s.hostCode);
        return 'y';
      }),
    ).toBe(0);
    expect(loadOwnerConfig(s.owner).workers?.relay.lab).toMatchObject({
      host: 'worker.example',
      user: 'studio-relay',
      port: 22,
      hostKey: s.hostKey,
      identityFile: join(s.home, '.config', 'studio', 'relay', 'lab_ed25519'),
    });
  });

  it('refuses a worker that did not take this pairing, and a connect without a pairing', async () => {
    const s = setup();
    await s.run(['pair', 'lab', 'worker.example']);
    s.setCodes(['ZZZZ-ZZZZ']);
    await expect(s.run(['pair', 'lab'], { connect: true, code: s.hostCode })).rejects.toThrow(
      /did not take this pairing/,
    );
    expect(loadOwnerConfig(s.owner).workers?.relay.lab).toBeUndefined();
    await expect(s.run(['pair', 'other'], { connect: true, code: s.hostCode })).rejects.toThrow(
      /no pairing of other is waiting/,
    );
    // Without a terminal and without --code, nothing is pinned.
    await expect(s.run(['pair', 'lab'], { connect: true })).rejects.toThrow(/no terminal/);
  });

  it('keeps what else the owner config holds, comments included', async () => {
    const s = setup();
    const file = join(s.home, '.config', 'studio', 'config.yaml');
    mkdirSync(join(s.home, '.config', 'studio'), { recursive: true });
    writeFileSync(file, '# my notes\nnotify: { quiet: "22:00-07:00" }\n');
    await s.run(['pair', 'lab', 'worker.example'], { port: '2222', user: 'relay-bot' });
    const line = /--pair "([^"]+)"/.exec(s.out.join(''))?.[1] as string;
    s.setCodes([parsePairLine(line).code]);
    expect(await s.run(['pair', 'lab'], { connect: true, code: s.hostCode })).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# my notes');
    expect(loadOwnerConfig(s.owner).notify?.quiet).toBe('22:00-07:00');
    expect(loadOwnerConfig(s.owner).workers?.relay.lab).toMatchObject({
      port: 2222,
      user: 'relay-bot',
    });
  });
});

describe('studio relay install', () => {
  it('runs on Windows only', async () => {
    await expect(
      runRelayCommand({
        rest: ['install'],
        values: {},
        owner: { env: {}, homedir: root },
        ports: realPorts(),
        env: {},
        stdin: chunks([]),
        stdout: () => {},
        stderr: () => {},
        platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' },
      }),
    ).rejects.toThrow(/sets up a Windows relay worker/);
  });

  it('its script: prerequisites, the sshd block between markers checked by sshd -t, sshd only from the scope', () => {
    const base = {
      relayUser: 'studio-relay',
      crewUser: 'studio-crew',
      home: 'C:\\ProgramData\\Studio\\relay',
      task: 'Studio relay broker',
      readPaths: [],
      command:
        '"C:\\node.exe" "C:\\studio\\bin\\studio" relay serve --home "C:\\ProgramData\\Studio\\relay"',
      leadKey: `ssh-ed25519 ${'C'.repeat(68)} studio-relay-lab`,
      pluginSetup: '# plugins',
    };
    const tail = relaySetupScript({ ...base, install: { port: 22, scope: { tailscale: true } } });
    for (const s of [
      "Need 'Git' { Get-Command git -ErrorAction SilentlyContinue } 'Git.Git'",
      "Need 'Claude Code' { Get-Command claude -ErrorAction SilentlyContinue } 'Anthropic.ClaudeCode'",
      'Add-WindowsCapability -Online -Name $ssh.Name',
      '# studio relay begin',
      '# studio relay end',
      "'System32\\OpenSSH\\sshd.exe') -t",
      "throw 'sshd does not accept the new sshd_config; it was put back as it was'",
      "-like '*Tailscale*'",
      '$scope = @{ InterfaceAlias = $ts.Name }',
      "Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule",
      'Set-Service -Name WebClient -StartupType Disabled',
      // A key paired again replaces its own line, and only that one.
      "$_.EndsWith(' ' + 'studio-relay-lab')",
    ]) {
      expect(tail, s).toContain(s);
    }
    expect(tail).not.toContain('Add this block at the end of sshd_config');
    const source = relaySetupScript({
      ...base,
      install: { port: 2222, scope: { source: 'fd7a::/48' } },
    });
    expect(source).toContain("$scope = @{ RemoteAddress = 'fd7a::/48' }");
    expect(source).toContain('-LocalPort 2222');
    // Without install it stays the printed setup.
    expect(relaySetupScript(base)).toContain('Add this block at the end of sshd_config');
  });
});
