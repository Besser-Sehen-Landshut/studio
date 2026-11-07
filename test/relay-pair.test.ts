// Pairing a lead with a relay worker, the worker's authorized keys, and the install script.
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
  authorizedKeysPlan,
  keyFingerprint,
  keyscanKey,
  PAIR_TTL_MS,
  pairProof,
  pairProofs,
  parsePairLine,
  proofHolds,
  readPairings,
  renderPairLine,
  writePairings,
} from '../src/relay-pair.js';
import { encodeMessage, LineReader, readMessage } from '../src/relay-protocol.js';
import { serveRelay } from '../src/relay-serve.js';
import type { RelayTransport } from '../src/relay-transport.js';
import {
  authorizedKeysFile,
  authorizedKeysScript,
  relaySetupScript,
} from '../src/relay-windows.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-pair-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const keygen = (file: string) =>
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
const newKey = () => {
  const f = join(root, `k${n++}`);
  keygen(f);
  return readFileSync(`${f}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
};
const SECRET = 'a'.repeat(43);
const T0 = Date.parse('2026-11-06T10:00:00Z');

async function* chunks(lines: Iterable<string>): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

describe('pairing lines, fingerprints and proofs', () => {
  it('a line holds the label, the secret and the key, and nothing else parses', () => {
    const key = newKey();
    const line = renderPairLine({ label: 'lab', secret: SECRET, key });
    expect(parsePairLine(line)).toEqual({ label: 'lab', secret: SECRET, key });
    for (const bad of [
      `${line} extra`,
      line.replace('studio-pair-1', 'studio-pair-2'),
      line.replace(SECRET, 'short'),
      line.replace('lab', 'Lab'),
    ]) {
      expect(() => parsePairLine(bad), bad).toThrow(/not a pairing line/);
    }
  });

  it('the fingerprint is the one ssh-keygen prints', () => {
    const f = join(root, `fp${n++}`);
    keygen(f);
    const key = readFileSync(`${f}.pub`, 'utf8');
    const printed = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${f}.pub`], {
      encoding: 'utf8',
    }).split(' ')[1];
    expect(keyFingerprint(key)).toBe(printed);
    expect(keyscanKey(`# x\nworker.example ${key}`)).toBe(
      key.trim().split(' ').slice(0, 2).join(' '),
    );
  });

  it('a proof binds one host key to one secret, compared in constant time', () => {
    const host = newKey();
    const other = newKey();
    const mac = pairProof(SECRET, host);
    expect(proofHolds(SECRET, host, mac)).toBe(true);
    expect(proofHolds(SECRET, other, mac)).toBe(false);
    expect(proofHolds('b'.repeat(43), host, mac)).toBe(false);
    expect(proofHolds(SECRET, host, 'not hex')).toBe(false);
  });

  it('a worker proves its pairings for an hour, never after', () => {
    const host = newKey();
    const pairings = {
      lab: { key: newKey(), secret: SECRET, pairedAt: new Date(T0).toISOString() },
    };
    expect(pairProofs(pairings, host, new Date(T0 + 10 * 60_000))).toEqual([
      { label: 'lab', mac: pairProof(SECRET, host) },
    ]);
    expect(pairProofs(pairings, host, new Date(T0 + PAIR_TTL_MS + 1))).toEqual([]);
    expect(pairProofs(pairings, undefined, new Date(T0))).toEqual([]);
  });

  it('hello names the proofs of the pairings the worker records', async () => {
    const home = join(root, `relay-home-${n++}`);
    mkdirSync(home);
    const host = newKey();
    writePairings(home, {
      lab: { key: newKey(), secret: SECRET, pairedAt: new Date().toISOString() },
    });
    const ctx = relayContext({
      owner: { env: { PATH: process.env.PATH }, homedir: home },
      home,
      lead: 'lab',
      pairings: home,
      ports: realPorts(),
      env: { PATH: process.env.PATH },
      homedir: home,
      platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' },
      load: async () => ({ cpuPercent: 1, freeDiskGb: 100 }),
      hostKey: () => host,
      log: () => {},
    });
    let out = '';
    await serveRelay(ctx, chunks(encodeMessage({ studioRelay: 1, op: 'hello' })), (s) => {
      out += s;
    });
    const msg = await readMessage(new LineReader(chunks([out]), 1 << 20), 0);
    expect(msg?.header).toMatchObject({
      ok: true,
      pairProofs: [{ label: 'lab', mac: pairProof(SECRET, host) }],
    });
  });
});

describe('the authorized keys of a worker are exactly its pairings', () => {
  const command = '"C:\\node.exe" "C:\\studio\\bin\\studio" relay serve --home "C:\\relay"';
  it('one forced line per pairing, in label order; any other line is named as removed', () => {
    const a = newKey();
    const b = newKey();
    const pairings = {
      zeta: { key: b, secret: SECRET, pairedAt: '2026-11-06T10:00:00Z' },
      lab: { key: a, secret: SECRET, pairedAt: '2026-11-06T10:00:00Z' },
    };
    const want = (k: string, l: string) =>
      `restrict,command="\\"C:\\\\node.exe\\" \\"C:\\\\studio\\\\bin\\\\studio\\" relay serve --home \\"C:\\\\relay\\" --lead ${l}" ${k} studio-relay-${l}`;
    const plan = authorizedKeysPlan({
      pairings,
      command,
      existing: `${want(a, 'lab')}\r\nssh-ed25519 ${'Z'.repeat(68)} someone-else\r\n\r\n`,
    });
    expect(plan.keyLines).toEqual([want(a, 'lab'), want(b, 'zeta')]);
    expect(plan.removed).toEqual([`ssh-ed25519 ${'Z'.repeat(68)} someone-else`]);
    expect(plan.lines).toEqual([
      { label: 'lab', fingerprint: keyFingerprint(a) },
      { label: 'zeta', fingerprint: keyFingerprint(b) },
    ]);
    expect(authorizedKeysPlan({ pairings: {}, command, existing: undefined }).keyLines).toEqual([]);
  });

  it('is written whole in its admin-only folder: final ACL on a temporary file, then one replace', () => {
    const script = authorizedKeysScript({
      file: 'C:\\relay\\authorized_keys',
      lines: ['restrict,command="x" ssh-ed25519 AAAA studio-relay-lab'],
      relayUser: 'studio-relay',
    });
    expect(script).toContain('$tmp = Join-Path (Split-Path -Parent $target)');
    const acl = script.indexOf(
      `icacls $tmp /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($relaySid):R"`,
    );
    const move = script.indexOf('[IO.File]::Replace($tmp, $target, [NullString]::Value)');
    expect(acl).toBeGreaterThan(0);
    expect(move).toBeGreaterThan(acl);
    // Replace keeps the DACL of the file it replaced: the intended one goes on again after it.
    expect(
      script.indexOf(
        `icacls $target /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($relaySid):R"`,
      ),
    ).toBeGreaterThan(move);
    expect(() =>
      authorizedKeysScript({ file: 'x', lines: ['a\nb'], relayUser: 'studio-relay' }),
    ).toThrow();
  });

  it('install and unpair rewrite it from the record, and refuse off Windows or unelevated', async () => {
    const home = join(root, `worker-${n++}`);
    mkdirSync(home);
    const key = newKey();
    writePairings(home, { lab: { key, secret: SECRET, pairedAt: '2026-11-06T10:00:00Z' } });
    writeFileSync(authorizedKeysFile(home), `ssh-ed25519 ${'Y'.repeat(68)} stray\n`);
    const scripts: string[] = [];
    const out: string[] = [];
    const exec: Exec = async (_file, args) => {
      scripts.push(args.at(-1) ?? '');
      return { code: 0, stdout: '', stderr: '' };
    };
    const base = {
      owner: { env: {}, homedir: home },
      ports: realPorts(),
      env: {},
      stdin: chunks([]),
      stdout: (s: string) => out.push(s),
      stderr: () => {},
      exec,
      platform: { platform: 'win32' as const, wsl: 'none' as const, automountRoot: '/mnt/' },
      elevated: async () => true,
      machine: home,
    };
    expect(await runRelayCommand({ ...base, rest: ['unpair', 'lab'], values: { home } })).toBe(0);
    expect(readPairings(home)).toEqual({});
    // The file is written with no line at all, and the stray key is named as removed.
    expect(scripts.at(-1)).toContain('(@() | ForEach-Object');
    expect(out.join('')).toMatch(
      /removed an authorized key no pairing names: SHA256:\S+ \(stray\)/,
    );
    expect(out.join('')).toContain('authorized: no lead');
    await expect(
      runRelayCommand({
        ...base,
        elevated: async () => false,
        rest: ['unpair', 'lab'],
        values: { home },
      }),
    ).rejects.toThrow(/elevated/);
    await expect(
      runRelayCommand({
        ...base,
        platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' },
        rest: ['install'],
        values: { home },
      }),
    ).rejects.toThrow(/sets up a Windows relay worker/);
    // Never over SSH: the install stops sshd. By the environment, or an sshd among the parents.
    await expect(
      runRelayCommand({
        ...base,
        env: { SSH_CONNECTION: 'peer 22 me 22' },
        rest: ['install'],
        values: { home, source: 'fd7a::/48' },
      }),
    ).rejects.toThrow(/never over SSH/);
    await expect(
      runRelayCommand({
        ...base,
        exec: async () => ({ code: 0, stdout: 'True', stderr: '' }),
        rest: ['install'],
        values: { home, source: 'fd7a::/48' },
      }),
    ).rejects.toThrow(/never over SSH/);
  });
});

describe('studio relay pair on the lead', () => {
  function setup(o: { workerSecret?: (line: string) => string; workerHost?: string } = {}) {
    const home = join(root, `lead-${n++}`);
    mkdirSync(home);
    const owner = { env: { PATH: process.env.PATH }, homedir: home };
    const host = newKey();
    const presented = o.workerHost ?? host;
    const now = { t: T0 };
    const out: string[] = [];
    let secret: string | undefined;
    const transport: RelayTransport = {
      async call(header) {
        expect(header.op).toBe('hello');
        const lines = [
          ...encodeMessage({
            studioRelay: 1,
            ok: true,
            studio: '9.9.9',
            platform: 'win32',
            plugins: {},
            busy: null,
            held: null,
            // The worker proves its own host key, whatever key the lead was shown.
            pairProofs:
              secret === undefined ? [] : [{ label: 'lab', mac: pairProof(secret, host) }],
            warnings: [],
          }),
        ];
        return (await readMessage(new LineReader(chunks(lines), 1 << 20), 0)) as {
          header: Record<string, unknown>;
        };
      },
    };
    const exec: Exec = async (file, args) => {
      if (file === 'ssh-keyscan')
        return { code: 0, stdout: `worker.example ${presented}\n`, stderr: '' };
      try {
        return { code: 0, stdout: execFileSync(file, args, { encoding: 'utf8' }), stderr: '' };
      } catch {
        return { code: 1, stdout: '', stderr: '' };
      }
    };
    const ports = {
      ...realPorts(),
      clock: { now: () => new Date(now.t), sleep: async () => {} },
    };
    const run = (rest: string[], values: Record<string, unknown> = {}) =>
      runRelayCommand({
        rest,
        values,
        owner,
        ports,
        env: owner.env,
        homedir: home,
        stdin: chunks([]),
        stdout: (s) => out.push(s),
        stderr: () => {},
        transport: () => transport,
        exec,
      });
    /** The worker takes the line printed last (or another secret). */
    const workerTakes = () => {
      const line = /--pair "([^"]+)"/.exec(out.join(''))?.[1] as string;
      const p = parsePairLine(line);
      secret = o.workerSecret?.(p.secret) ?? p.secret;
      return p;
    };
    return { home, owner, out, run, now, host, workerTakes };
  }

  it('pins the host key the worker proves with the secret, once', async () => {
    const s = setup();
    expect(await s.run(['pair', 'lab', 'worker.example'])).toBe(0);
    expect(existsSync(join(s.home, '.config', 'studio', 'relay', 'lab_ed25519'))).toBe(true);
    s.workerTakes();
    s.now.t += 20 * 60_000;
    expect(await s.run(['pair', 'lab'], { connect: true })).toBe(0);
    expect(s.out.join('')).toContain(keyFingerprint(s.host));
    expect(loadOwnerConfig(s.owner).workers?.relay.lab).toMatchObject({
      host: 'worker.example',
      user: 'studio-relay',
      port: 22,
      hostKey: s.host,
      identityFile: join(s.home, '.config', 'studio', 'relay', 'lab_ed25519'),
    });
    // The secret is used up: a second connect has nothing to go on.
    await expect(s.run(['pair', 'lab'], { connect: true })).rejects.toThrow(
      /no pairing of lab is waiting/,
    );
  });

  it('rejects another host key than the worker proves: nothing is pinned', async () => {
    const s = setup({ workerHost: newKey() });
    await s.run(['pair', 'lab', 'worker.example']);
    s.workerTakes();
    await expect(s.run(['pair', 'lab'], { connect: true })).rejects.toThrow(
      /did not prove this host key/,
    );
    expect(loadOwnerConfig(s.owner).workers?.relay.lab).toBeUndefined();
  });

  it('rejects a worker that holds another secret', async () => {
    const s = setup({ workerSecret: () => 'c'.repeat(43) });
    await s.run(['pair', 'lab', 'worker.example']);
    s.workerTakes();
    await expect(s.run(['pair', 'lab'], { connect: true })).rejects.toThrow(
      /did not prove this host key/,
    );
  });

  it('rejects an expired secret', async () => {
    const s = setup();
    await s.run(['pair', 'lab', 'worker.example']);
    s.workerTakes();
    s.now.t += PAIR_TTL_MS + 60_000;
    await expect(s.run(['pair', 'lab'], { connect: true })).rejects.toThrow(/expired/);
    expect(loadOwnerConfig(s.owner).workers?.relay.lab).toBeUndefined();
  });

  it('keeps what else the owner config holds, comments included', async () => {
    const s = setup();
    const file = join(s.home, '.config', 'studio', 'config.yaml');
    mkdirSync(join(s.home, '.config', 'studio'), { recursive: true });
    writeFileSync(file, '# my notes\nnotify: { quiet: "22:00-07:00" }\n');
    await s.run(['pair', 'lab', 'worker.example'], { port: '2222', user: 'relay-bot' });
    s.workerTakes();
    expect(await s.run(['pair', 'lab'], { connect: true })).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('# my notes');
    expect(loadOwnerConfig(s.owner).notify?.quiet).toBe('22:00-07:00');
    expect(loadOwnerConfig(s.owner).workers?.relay.lab).toMatchObject({
      port: 2222,
      user: 'relay-bot',
    });
  });
});

describe('the install script', () => {
  it('prerequisites, the sshd block between markers checked by sshd -t, sshd only from the scope', () => {
    const base = {
      relayUser: 'studio-relay',
      crewPrefix: 'studio-crew',
      home: 'C:\\ProgramData\\Studio\\relay',
      machine: 'C:\\Program Files\\Studio\\relay',
      task: 'Studio relay broker',
      readPaths: [],
      source: { node: 'C:\\nodejs\\node.exe', studio: 'C:\\plugins\\studio' },
    };
    const tail = relaySetupScript({ ...base, install: { port: 22, scope: { tailscale: true } } });
    expect(
      relaySetupScript({
        ...base,
        install: { port: 22, scope: { tailscale: true }, forceStop: true },
      }),
    ).toContain('$forceStop = $true');
    for (const s of [
      "Need 'Git' { Get-Command git -ErrorAction SilentlyContinue } 'Git.Git'",
      "Need 'Claude Code' { Get-Command claude -ErrorAction SilentlyContinue } 'Anthropic.ClaudeCode'",
      'Add-WindowsCapability -Online -Name $ssh.Name',
      '# studio relay begin',
      '# studio relay end',
      "$exe = Join-Path $env:SystemRoot 'System32\\OpenSSH\\sshd.exe'",
      // The new config goes to a temporary file, sshd checks that one (with a throwaway host key
      // when there is none), and only an accepted one replaces the old in one step.
      "$tmp = Join-Path $dir ('.sshd_config.' + [Guid]::NewGuid().ToString('N') + '.tmp')",
      "$sshdArgs = '-t -f \"' + $tmp + '\"'",
      "$sshdArgs += ' -h \"' + $key + '\"'",
      'if ($tested.ExitCode -ne 0) { throw "sshd does not accept the new sshd_config; $conf stays as it was" }',
      '[IO.File]::Replace($tmp, $conf, [NullString]::Value)',
      'SshdConfigSwap $conf $new $true',
      // A user of the relay account's name that Studio did not make is never taken over.
      "if ($null -ne $existing -and $existing.Description -ne 'Studio relay (SSH, forced command)') { throw",
      // Keys only for every account, at the top where sshd reads it first.
      '# studio relay begin global\nPasswordAuthentication no\nKbdInteractiveAuthentication no',
      // sshd stays stopped and closed until the end; a failure leaves it so.
      // No relay job runs while the folders are walked: refused before sshd stops, checked again
      // after, every process of the relay account and the crew user.
      "$_.Name -eq 'studio-relay' -or ($_.Name -match $crewRe -and $_.Description -eq 'Studio crew (one job)')",
      '$forceStop = $false',
      '# Before sshd stops: a running job is refused while the lead can still reach it.\nNoRelayJob\ntry {',
      'SshdOff\n# With sshd off no new job starts: once more, for one that started in between.\nNoRelayJob\nSet-Service -Name sshd -StartupType Automatic',
      '$ok = $true\n} finally {\n  if (-not $ok) {\n    SshdOff',
      "-like '*Tailscale*'",
      '$scope = @{ InterfaceAlias = $ts.Name }',
      "Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule",
      'Set-Service -Name WebClient -StartupType Disabled',
      // The record of pairings: written by SYSTEM and administrators only.
      "foreach ($sub in @('broker', 'config', 'setup-state', 'pairing'))",
    ]) {
      expect(tail, s).toContain(s);
    }
    // sshd starts only once everything checked out, never before the end.
    expect(tail.indexOf('Start-Service sshd\nWrite-Output "ok: relay account')).toBeGreaterThan(
      tail.indexOf('-ExitCode -ne 0'),
    );
    expect(tail).not.toContain('Restart-Service sshd');
    // The spooler's state is only read (for uninstall), never changed without --disable-spooler.
    expect(tail).not.toMatch(/(Stop|Set)-Service -Name Spooler/);
    const kept = relaySetupScript({
      ...base,
      install: { port: 22, scope: { tailscale: true }, keepPasswords: true, disableSpooler: true },
    });
    expect(kept).not.toContain('PasswordAuthentication no\nKbdInteractiveAuthentication no');
    expect(kept).toContain('Set-Service -Name Spooler -StartupType Disabled');
    // No key is written by the script: authorized keys come from the record alone.
    expect(tail).not.toMatch(/\$keys = |Set-Content -LiteralPath \$keys/);
    const source = relaySetupScript({
      ...base,
      install: { port: 2222, scope: { source: 'fd7a::/48' } },
    });
    expect(source).toContain("$scope = @{ RemoteAddress = 'fd7a::/48' }");
    expect(source).toContain('-LocalPort 2222');
    expect(relaySetupScript(base)).toContain('Add this block at the end of sshd_config');
  });
});
