// The friendliness pass over the setup flows: --dry-run of account add and of every relay command
// that writes, the numbered steps of the Windows setup scripts, the next line at the end, and the
// owner's language.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stringsFor } from '../hooks/i18n/index.js';
import { runAccount } from '../src/account-command.js';
import { listAccounts } from '../src/accounts.js';
import { ownerStateRootFor } from '../src/paths.js';
import { realPorts } from '../src/ports.js';
import { type Exec, runRelayCommand } from '../src/relay-command.js';
import { writePending } from '../src/relay-pair.js';
import { relaySetupScript, withSteps } from '../src/relay-windows.js';
import { windowsSetupScript } from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-friendly-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = () => {
  const h = join(root, `h${n++}`);
  mkdirSync(h, { recursive: true });
  return h;
};

async function* none(): AsyncGenerator<string> {}

const WIN = { platform: 'win32' as const, wsl: 'none' as const, automountRoot: '/mnt/' };

const relay = async (
  rest: string[],
  values: Record<string, unknown>,
  o: { env?: Record<string, string>; machine?: string; elevated?: boolean } = {},
) => {
  const h = home();
  const out: string[] = [];
  const ran: string[] = [];
  const exec: Exec = async (file, args) => {
    ran.push([file, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  const code = await runRelayCommand({
    rest,
    values,
    owner: { env: o.env ?? {}, homedir: h },
    ports: realPorts(),
    env: o.env ?? {},
    homedir: h,
    stdin: none(),
    stdout: (s) => out.push(s),
    stderr: (s) => out.push(s),
    exec,
    platform: WIN,
    elevated: async () => o.elevated ?? false,
    machine: o.machine ?? join(h, 'machine'),
  });
  return { code, out: out.join(''), ran, home: h };
};

describe('--dry-run of the relay commands: what they would do, nothing done', () => {
  it('relay install: without elevation, every step named, no script run', async () => {
    const r = await relay(['install'], {
      'dry-run': true,
      source: 'fd7a::/48',
      'no-firewall': true,
    });
    expect(r.code).toBe(0);
    expect(r.ran).toEqual([]);
    expect(r.out.split('\n')[0]).toBe('Dry run: nothing is written, stored or changed.');
    expect(r.out).toContain('would put NO network lockdown in place (--no-firewall, unsafe)');
    expect(r.out).toContain('reachable only from the source fd7a::/48');
    expect(existsSync(join(r.home, 'machine'))).toBe(false);
  });

  it('relay uninstall: the order it would remove things in', async () => {
    const r = await relay(['uninstall'], { 'dry-run': true, 'keep-tree': true });
    expect(r.code).toBe(0);
    expect(r.ran).toEqual([]);
    const lines = r.out.split('\n').filter((l) => l.startsWith('   would'));
    expect(lines[0]).toContain('remove every lead key and pairing first');
    expect(r.out).toContain('(--keep-tree)');
  });

  it('relay unpair and relay pair: nothing written, no key made, no secret printed', async () => {
    expect((await relay(['unpair', 'lab'], { 'dry-run': true })).out).toContain(
      'would remove the pairing of lab',
    );
    const p = await relay(['pair', 'lab', 'worker.example'], { 'dry-run': true });
    expect(p.code).toBe(0);
    expect(p.ran).toEqual([]);
    expect(p.out).toContain('would make the key');
    expect(p.out).not.toMatch(/studio-pair-2/);
    expect(existsSync(join(p.home, '.config', 'studio', 'relay'))).toBe(false);
  });

  it('relay pair --connect --dry-run leaves an expired pairing where it is; the real run removes it', async () => {
    const h = home();
    const owner = { env: {}, homedir: h };
    writePending(owner, {
      label: 'lab',
      host: 'worker.example',
      port: 22,
      user: 'studio-relay',
      secret: 'a'.repeat(43),
      identityFile: join(h, 'key'),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const file = join(ownerStateRootFor(owner), 'relay', 'pair-lab.json');
    expect(existsSync(file)).toBe(true);
    const connect = (values: Record<string, unknown>) =>
      runRelayCommand({
        rest: ['pair', 'lab'],
        values: { connect: true, ...values },
        owner,
        ports: realPorts(),
        env: {},
        homedir: h,
        stdin: none(),
        stdout: () => {},
        stderr: () => {},
        exec: async () => ({ code: 1, stdout: '', stderr: '' }),
        platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' },
      });
    await expect(connect({ 'dry-run': true })).rejects.toThrow(/expired/);
    expect(existsSync(file)).toBe(true);
    await expect(connect({})).rejects.toThrow(/expired/);
    expect(existsSync(file)).toBe(false);
  });

  it('relay pair speaks German, the line and the commands unchanged', async () => {
    const h = home();
    const out: string[] = [];
    await runRelayCommand({
      rest: ['pair', 'lab', 'worker.example'],
      values: {},
      owner: { env: { LANG: 'de_DE.UTF-8', PATH: process.env.PATH }, homedir: h },
      ports: realPorts(),
      env: { LANG: 'de_DE.UTF-8', PATH: process.env.PATH },
      homedir: h,
      stdin: none(),
      stdout: (s) => out.push(s),
      stderr: () => {},
      exec: async (file, args) => {
        try {
          return { code: 0, stdout: execFileSync(file, args, { encoding: 'utf8' }), stderr: '' };
        } catch {
          return { code: 1, stdout: '', stderr: '' };
        }
      },
      platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' },
    });
    const text = out.join('');
    expect(text).toContain('1. Auf dem Windows-PC, in einer PowerShell als Administrator');
    expect(text).toContain("studio-relay-bootstrap.ps1').RawContentStream.ToArray()");
    expect(text).toContain("-Pair 'studio-pair-2 lab ");
    expect(text).toContain('2. Danach hier: studio relay pair lab --connect');
  });
});

describe('account add', () => {
  it('--dry-run checks the label and says what it would ask and store; a real add ends with what comes next', async () => {
    const h = home();
    const owner = { env: {}, homedir: h };
    const out: string[] = [];
    const base = {
      owner,
      ownerRoot: join(h, 'state'),
      ports: realPorts(),
      env: {},
      json: false,
      stdout: (s: string) => out.push(s),
      stderr: () => {},
    };
    expect(
      await runAccount({ ...base, args: ['add', 'main'], isTerminal: false, dryRun: true }),
    ).toBe(0);
    expect(out.join('')).toMatch(
      /would ask for the token of claude setup-token at a hidden prompt and store it as main/,
    );
    expect(listAccounts(owner)).toEqual([]);
    await expect(
      runAccount({ ...base, args: ['add', '.bad'], isTerminal: false, dryRun: true }),
    ).rejects.toThrow(/not a label/);
    out.length = 0;
    await runAccount({
      ...base,
      args: ['add', 'second'],
      isTerminal: true,
      readSecret: async () => 'fake-value-account-token-friendly-1',
      pins: () => ({ pins: [], unallowed: [] }),
    });
    expect(out.join('')).toContain('account second stored and active');
  });
});

describe('numbered steps in the Windows setup scripts', () => {
  const steps = (s: string) => s.split('\n').filter((l) => /^Step ['"]/.test(l));
  it('count every step, and define the counter before the first one, after #Requires', () => {
    for (const script of [
      relaySetupScript({
        relayUser: 'studio-relay',
        crewPrefix: 'studio-crew',
        home: 'C:\\ProgramData\\Studio\\relay',
        machine: 'C:\\Program Files\\Studio\\relay',
        task: 'Studio relay broker',
        readPaths: [],
        source: { node: 'C:\\n\\node.exe', studio: 'C:\\s' },
        install: { port: 22, scope: { tailscale: true } },
      }),
      windowsSetupScript({ prefix: 'studio-crew', crewDir: 'C:\\c', readPaths: [] }),
    ]) {
      const total = steps(script).length;
      expect(total).toBeGreaterThan(2);
      expect(script).toContain(`$stepTotal = ${total}\n`);
      expect(script.indexOf('function Step(')).toBeLessThan(script.indexOf("\nStep '"));
    }
    expect(withSteps("#Requires -RunAsAdministrator\nStep 'a'\n").startsWith('#Requires')).toBe(
      true,
    );
  });
});

describe('the setup texts', () => {
  it('German covers every setup text and keeps the commands', () => {
    const de = stringsFor('de').setup;
    expect(de.fix('studio setup')).toBe('   Behebung: studio setup');
    expect(de.next('studio doctor')).toBe('Fertig. Als Nächstes: studio doctor');
    expect(de.wsl1Fix('Ubuntu')).toContain('wsl --set-version Ubuntu 2');
    expect(readdirSync(join(import.meta.dirname, '..', 'hooks', 'locales'))).toContain('de.ts');
  });
});
