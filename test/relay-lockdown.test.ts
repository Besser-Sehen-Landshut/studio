// The network lockdown of Windows workers: the rules it plans, the scripts that put it in place,
// prove it and take it away, the check before every relay start, and on the elevated windows-latest
// job the rules, the probe and the check for real.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crewAccountFunctions, TREE_SOURCE } from '../src/crew-accounts.js';
import { ipv4 } from '../src/egress-proxy.js';
import { realPorts } from '../src/ports.js';
import { type Exec, runRelayCommand } from '../src/relay-command.js';
import {
  CONNECT_TEST,
  dnsResolvers,
  LOCKDOWN_GROUP,
  lockdownFor,
  lockdownPlan,
  lockdownProblem,
  lockdownSection,
  PROBE_FIXED,
  unrefused,
} from '../src/relay-lockdown.js';
import { relayUninstallScript, restoreSteps } from '../src/relay-uninstall.js';
import { relaySetupScript } from '../src/relay-windows.js';
import { powershellEnv, runFile, windowsSetupScript } from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-lockdown-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const empty = { resolvers: [], denyHosts: [], denyPorts: [] };

describe('the lockdown plan', () => {
  it('blocks every local range, IPv4 and IPv6, and nothing of the internet', () => {
    const p = lockdownPlan(empty);
    expect(p.local).toEqual([
      `${ipv4(10, 0, 0, 0)}-${ipv4(10, 255, 255, 255)}`,
      `${ipv4(100, 64, 0, 0)}-${ipv4(100, 127, 255, 255)}`,
      `${ipv4(169, 254, 0, 0)}-${ipv4(169, 254, 255, 255)}`,
      `${ipv4(172, 16, 0, 0)}-${ipv4(172, 31, 255, 255)}`,
      `${ipv4(192, 168, 0, 0)}-${ipv4(192, 168, 255, 255)}`,
      'fc00:0:0:0:0:0:0:0-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'fe80:0:0:0:0:0:0:0-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    ]);
    expect(p.resolvers).toEqual([]);
    expect(p.hosts).toEqual([]);
  });

  it('carves the local resolvers out (port 53 stays open to them), a public one needs nothing', () => {
    const p = lockdownPlan({
      ...empty,
      resolvers: [
        ipv4(192, 168, 1, 1),
        ipv4(9, 9, 9, 9),
        'fd00::1',
        'fe80::1%12',
        ipv4(192, 168, 1, 1),
      ],
    });
    expect(p.resolvers).toEqual([ipv4(192, 168, 1, 1), 'fd00:0:0:0:0:0:0:1', 'fe80:0:0:0:0:0:0:1']);
    expect(p.local).toContain(`${ipv4(192, 168, 0, 0)}-${ipv4(192, 168, 1, 0)}`);
    expect(p.local).toContain(`${ipv4(192, 168, 1, 2)}-${ipv4(192, 168, 255, 255)}`);
    expect(p.local).toContain('fc00:0:0:0:0:0:0:0-fd00:0:0:0:0:0:0:0');
    expect(p.local).toContain('fd00:0:0:0:0:0:0:2-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    expect(p.local.join(',')).not.toContain(ipv4(9, 9, 9, 9));
  });

  it('turns deny.hosts and deny.ports into rules; names as they resolve now, said so', () => {
    const p = lockdownPlan({
      resolvers: [],
      denyHosts: [
        'local-subnets',
        'tailnet-peers',
        ipv4(203, 0, 113, 7),
        `${ipv4(198, 51, 100, 0)}/24`,
        '2001:db8::5',
        'nas.example',
        'gone.example',
      ],
      resolved: { 'nas.example': [ipv4(198, 51, 100, 9)], 'gone.example': [] },
      denyPorts: [5432, 22, 5432],
    });
    expect(p.hosts).toEqual([
      ipv4(203, 0, 113, 7),
      `${ipv4(198, 51, 100, 0)}-${ipv4(198, 51, 100, 255)}`,
      '2001:db8:0:0:0:0:0:5',
      ipv4(198, 51, 100, 9),
    ]);
    expect(p.ports).toEqual([22, 5432]);
    expect(p.notes.join('\n')).toContain('nas.example: blocked at');
    expect(p.notes.join('\n')).toContain('gone.example: does not resolve now');
  });

  it('asks Windows for the resolvers and resolves names itself', async () => {
    const plan = await lockdownFor({
      resolvers: () =>
        dnsResolvers(async () => ({
          code: 0,
          stdout: JSON.stringify([ipv4(192, 168, 1, 1), 'not an address!']),
        })),
      deny: { hosts: ['nas.example', ipv4(203, 0, 113, 1)], ports: [] },
      lookup: async (n) => (n === 'nas.example' ? [ipv4(198, 51, 100, 3)] : []),
    });
    expect(plan.resolvers).toEqual([ipv4(192, 168, 1, 1)]);
    expect(plan.hosts).toEqual([ipv4(198, 51, 100, 3), ipv4(203, 0, 113, 1)]);
    expect(await dnsResolvers(async () => ({ code: 1, stdout: '' }))).toEqual([]);
    expect(await dnsResolvers(async () => ({ code: 0, stdout: `"${ipv4(10, 0, 0, 2)}"` }))).toEqual(
      [ipv4(10, 0, 0, 2)],
    );
  });
});

describe('the lockdown in the setup scripts', () => {
  const relay = (lockdown?: ReturnType<typeof lockdownPlan> | null) =>
    relaySetupScript({
      relayUser: 'studio-relay',
      crewPrefix: 'studio-crew',
      home: 'C:\\ProgramData\\Studio\\relay',
      machine: 'C:\\Program Files\\Studio\\relay',
      task: 'Studio relay broker',
      readPaths: [],
      source: { node: 'C:\\nodejs\\node.exe', studio: 'C:\\plugins\\studio' },
      install: { port: 22, scope: { tailscale: true } },
      ...(lockdown === undefined ? {} : { lockdown }),
    });

  it('relay install: rules for the relay account and the group, proved and read back before sshd starts', () => {
    const s = relay();
    const at = (m: string) => {
      const i = s.indexOf(m);
      expect(i, m).toBeGreaterThan(0);
      return i;
    };
    const order = [
      at('Studio crews '),
      at('$lockSids = @($relaySid, $groupSid)'),
      at('LockdownRules $lockSids\nLockdownProbe $lockSids'),
      at('$lockProblems = LockdownCheck $lockSids'),
      at('RestrictDriverInstallationToAdministrators -Type DWord -Value 1'),
      at('Start-Service sshd\nWrite-Output "ok: relay account'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A failure throws inside the install's try: sshd stays stopped and closed.
    expect(s).toContain('throw "the network lockdown does not hold');
    expect(s).toContain('firewall = $true');
    // The spooler stays on unless asked; drivers are for administrators only either way.
    expect(s).not.toContain('Stop-Service -Name Spooler');
  });

  it('--no-firewall: no rules, the earlier ones removed, said to be unsafe, recorded', () => {
    const s = relay(null);
    expect(s).not.toContain('LockdownProbe');
    expect(s).toContain(`Get-NetFirewallRule -Group '${LOCKDOWN_GROUP}'`);
    expect(s).toContain('UNSAFE (--no-firewall)');
    expect(s).toContain('firewall = $false');
    expect(lockdownSection(null, '@()')).not.toContain('New-NetFirewallRule');
  });

  it('worker windows-setup: the group alone', () => {
    const s = windowsSetupScript({ prefix: 'studio-crew', crewDir: 'C:\\crew', readPaths: [] });
    expect(s).toContain('$lockSids = @($groupSid)');
    expect(s).toContain('LockdownProbe $lockSids');
    expect(s).toContain('RestrictDriverInstallationToAdministrators');
  });

  it('the throwaway user is bound into the rule for the probe only, and goes after it', () => {
    const s = lockdownSection(lockdownPlan(empty), '@($groupSid)');
    expect(s).toContain('LockdownRules (@($sids) + @($u.SID.Value))');
    const fin = s.indexOf('} finally {\n    LockdownRules $sids');
    expect(fin).toBeGreaterThan(s.indexOf('$after = ConnectAs'));
    expect(s.indexOf('$null = RetireJobUsers', fin)).toBeGreaterThan(fin);
    // Every target must be the firewall's own refusal.
    // Every target is the firewall's refusal or has no route at all, and one at least is refused.
    expect(s).toContain("@('10051', '10065', '10013') -notcontains $after[$_]");
    expect(s).toContain('$refused -eq 0');
    // The probe script goes as a file in an admin-only folder (a credential logon's command line
    // holds 1024 characters), its answer in the same folder.
    expect(s).toContain("$dir = Join-Path $env:ProgramData ('studio-probe-'");
    expect(s).toContain("'-File', ('\"' + $file + '\"')");
    expect(s).not.toMatch(/\$env:TEMP/);
  });

  it('uninstall removes the rules and puts Point and Print back as recorded', () => {
    const u = relayUninstallScript({
      relayUser: 'studio-relay',
      crewPrefix: 'studio-crew',
      task: 'Studio relay broker',
      home: 'C:\\h',
      machine: 'C:\\m',
      readPaths: [],
      keepTree: false,
      forceStop: false,
      record: undefined,
      treeSource: 'C:\\t.cs',
    });
    expect(u).toContain(`Get-NetFirewallRule -Group '${LOCKDOWN_GROUP}'`);
    const prior = (pointAndPrint: { exists: boolean; value?: number }) =>
      restoreSteps({ readPaths: [], spoolerDisabled: false, prior: { pointAndPrint } });
    expect(prior({ exists: false })).toContain('Remove-ItemProperty');
    expect(prior({ exists: true, value: 0 })).toContain(
      'RestrictDriverInstallationToAdministrators -Type DWord -Value 0',
    );
    expect(restoreSteps(undefined)).not.toContain('RestrictDriverInstallationToAdministrators');
  });
});

describe('the check before every relay start', () => {
  const answer =
    (results: Record<string, string>, code = 0) =>
    async () => ({
      code,
      stdout: JSON.stringify(results),
      stderr: '',
    });
  const all = (r: string) => Object.fromEntries(PROBE_FIXED.map((t) => [t, r]));

  it('holds when the firewall refuses every fixed target, and names what it did not', async () => {
    expect(await lockdownProblem(answer(all('10013')))).toBeUndefined();
    const one = { ...all('10013'), [PROBE_FIXED[0] as string]: 'timeout' };
    expect(await lockdownProblem(answer(one))).toMatch(
      /does not hold for the relay account \(.*timed out\): run studio relay install again/,
    );
    expect(await lockdownProblem(answer(all('10061')))).toMatch(/error 10061/);
    // A target without any route reaches nothing; but at least one must be the firewall's refusal.
    const noRoute = { ...all('10013'), [PROBE_FIXED[2] as string]: '10051' };
    expect(await lockdownProblem(answer(noRoute))).toBeUndefined();
    expect(await lockdownProblem(answer(all('10051')))).toMatch(/error 10051/);
    expect(await lockdownProblem(answer({}, 1))).toMatch(/cannot be checked/);
    expect(await lockdownProblem(answer({ x: '10013' }))).toMatch(/cannot be checked/);
    expect(unrefused({ a: 'open' })).toEqual(['a opened']);
  });
});

async function* none(): AsyncGenerator<string> {}

describe('studio relay install and setup with and without --no-firewall', () => {
  const run = async (sub: string, values: Record<string, unknown>) => {
    const machine = join(root, `m-${randomBytes(3).toString('hex')}`);
    const scripts: string[] = [];
    const out: string[] = [];
    const exec: Exec = async (file, args) => {
      if (args.includes('-File')) scripts.push(readFileSync(args.at(-1) as string, 'utf8'));
      const cmd = args.at(-1) ?? '';
      if (cmd.includes('Get-DnsClientServerAddress')) {
        return { code: 0, stdout: JSON.stringify([ipv4(192, 168, 7, 1)]), stderr: '' };
      }
      return { code: 0, stdout: file === 'powershell.exe' ? '1' : '', stderr: '' };
    };
    await runRelayCommand({
      rest: [sub],
      values,
      owner: { env: {}, homedir: machine },
      ports: realPorts(),
      env: {},
      stdin: none(),
      stdout: (s) => out.push(s),
      stderr: () => {},
      exec,
      platform: { platform: 'win32', wsl: 'none', automountRoot: '/mnt/' },
      elevated: async () => true,
      machine,
    });
    return { script: scripts[0] ?? out.join(''), out: out.join('') };
  };

  it("install: the lockdown with this machine's resolver carved out; --no-firewall: none, said unsafe", async () => {
    const on = await run('install', { source: 'fd7a::/48' });
    expect(on.script).toContain('LockdownProbe $lockSids');
    expect(on.script).toContain(`$lockResolvers = @('${ipv4(192, 168, 7, 1)}')`);
    const off = await run('install', { source: 'fd7a::/48', 'no-firewall': true });
    expect(off.script).not.toContain('LockdownProbe');
    expect(off.script).toContain('UNSAFE (--no-firewall)');
  });

  it('setup prints the same lockdown', async () => {
    expect((await run('setup', {})).script).toContain('LockdownProbe $lockSids');
    expect((await run('setup', { 'no-firewall': true })).script).toContain('UNSAFE');
  });
});

// Elevated, on the windows-latest job.
const elevated = process.platform === 'win32' && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';

describe.skipIf(!elevated)('the lockdown on Windows', () => {
  const env = Object.fromEntries(
    Object.entries(powershellEnv(process.env)).filter(([k]) => k.toLowerCase() !== 'psmodulepath'),
  );
  const runScript = (script: string) => {
    const file = join(root, `l-${randomBytes(3).toString('hex')}.ps1`);
    writeFileSync(file, script);
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', env },
    );
  };

  it('a throwaway user bound into the rule is refused by the firewall everywhere local; the rules read back; then they go', () => {
    const tag = randomBytes(3).toString('hex');
    const prefix = `slk${tag}`;
    const out = runScript(`$ErrorActionPreference = 'Stop'
${crewAccountFunctions(prefix, { treeSource: TREE_SOURCE() })}
$g = New-LocalGroup -Name '${prefix}s' -Description $groupDescription
$groupSid = $g.SID.Value
try {
${lockdownSection(lockdownPlan({ resolvers: [], denyHosts: [], denyPorts: [5432] }), '@($groupSid)')}
  Write-Output ('rules: ' + @(Get-NetFirewallRule -Group '${LOCKDOWN_GROUP}').Count)
} finally {
  Get-NetFirewallRule -Group '${LOCKDOWN_GROUP}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Remove-LocalGroup -SID $g.SID
}
Write-Output ('left users: ' + @(Get-LocalUser | Where-Object { $_.Name -like '${prefix}-*' }).Count)`);
    expect(out).toMatch(/lockdown probe: before the rule \d+ of \d+ local targets/);
    expect(out).toMatch(/ok: all \d+ refused by the firewall/);
    expect(out).toContain('ok: network lockdown');
    // The local rule, and TCP and UDP for the denied port.
    expect(out).toContain('rules: 3');
    expect(out).toContain('left users: 0');
  }, 300_000);

  it('the check as this account: refused by a rule bound to it, not refused without one', async () => {
    const me = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      ],
      { encoding: 'utf8', env },
    ).trim();
    // Only the fixed probe targets, for this account, for the length of the test.
    const name = `Studio lockdown test ${randomBytes(3).toString('hex')}`;
    const addresses = PROBE_FIXED.map((t) => `'${t.slice(0, t.lastIndexOf(':'))}'`).join(', ');
    expect(await lockdownProblem(runFile)).toMatch(/does not hold for the relay account/);
    runScript(
      `New-NetFirewallRule -DisplayName '${name}' -Direction Outbound -Action Block -LocalUser 'D:(A;;CC;;;${me})' -RemoteAddress @(${addresses}) | Out-Null`,
    );
    try {
      expect(await lockdownProblem(runFile)).toBeUndefined();
    } finally {
      runScript(`Get-NetFirewallRule -DisplayName '${name}' | Remove-NetFirewallRule`);
    }
    expect(CONNECT_TEST).toContain('ConnectAsync');
  }, 120_000);
});
