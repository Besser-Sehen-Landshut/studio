// The network lockdown of Windows workers: the rules it plans, the scripts that put it in place,
// prove it and take it away, the check before every relay start, the SMB check as the relay
// account, the proxy's mirror of the local networks, and on the elevated windows-latest job the
// rules, the probe and the check for real.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { relayTargetSchema, workerDenySchema } from '../src/config.js';
import { crewAccountFunctions, TREE_SOURCE } from '../src/crew-accounts.js';
import { checkedAddress, ipv4, onLinkBlockList } from '../src/egress-proxy.js';
import { realPorts } from '../src/ports.js';
import { type Exec, runRelayCommand, scriptOfRun } from '../src/relay-command.js';
import { relayDoctor } from '../src/relay-lead.js';
import {
  denyNameDrift,
  entrySpan,
  inLocalRange,
  judgeLockdown,
  judgeLockdownAll,
  LOCKDOWN_GROUP,
  LOCKDOWN_RULE,
  LOCKDOWN_STATE,
  type LockdownState,
  type LockdownWant,
  lockdownFor,
  lockdownPlan,
  lockdownPortsRule,
  lockdownProblem,
  lockdownSection,
  lockdownWant,
  NO_LOCKDOWN,
  PROBE_FIXED,
  parseLockdownState,
  ROUTE_FUNCTIONS,
  SMB_AS_ME,
  SMB_LAN_RULE,
  unrefused,
} from '../src/relay-lockdown.js';
import { encodeMessage, LineReader, readMessage } from '../src/relay-protocol.js';
import type { RelayTransport } from '../src/relay-transport.js';
import { parseInstallRecord, relayUninstallScript, restoreSteps } from '../src/relay-uninstall.js';
import { installRecordFile, relaySetupScript } from '../src/relay-windows.js';
import { relayWindows } from '../src/relay-windows-check.js';
import {
  powershellEnv,
  type RunFile,
  runFile,
  windowsSetupScript,
} from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-lockdown-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const empty = { denyHosts: [], denyPorts: [] };

describe('the lockdown plan', () => {
  it('blocks the fixed local ranges of both families, broadcast, multicast and NAT64, nothing of the internet', () => {
    const p = lockdownPlan(empty);
    expect(p.local).toEqual([
      `${ipv4(10, 0, 0, 0)}-${ipv4(10, 255, 255, 255)}`,
      `${ipv4(100, 64, 0, 0)}-${ipv4(100, 127, 255, 255)}`,
      `${ipv4(169, 254, 0, 0)}-${ipv4(169, 254, 255, 255)}`,
      `${ipv4(172, 16, 0, 0)}-${ipv4(172, 31, 255, 255)}`,
      `${ipv4(192, 168, 0, 0)}-${ipv4(192, 168, 255, 255)}`,
      `${ipv4(198, 18, 0, 0)}-${ipv4(198, 19, 255, 255)}`,
      `${ipv4(224, 0, 0, 0)}-${ipv4(239, 255, 255, 255)}`,
      ipv4(255, 255, 255, 255),
      'fc00:0:0:0:0:0:0:0-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'fe80:0:0:0:0:0:0:0-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'ff00:0:0:0:0:0:0:0-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      '64:ff9b:0:0:0:0:0:0-64:ff9b:0:0:0:0:ffff:ffff',
    ]);
    expect(p.hosts).toEqual([]);
    expect(p.blockSmbLan).toBe(false);
    expect(inLocalRange(ipv4(9, 9, 9, 9))).toBe(false);
  });

  it('turns deny.hosts and deny.ports into rules; names as they resolve now, said so', async () => {
    const p = lockdownPlan({
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
    expect(p.names).toEqual({ 'nas.example': [ipv4(198, 51, 100, 9)], 'gone.example': [] });
    expect(p.notes.join('\n')).toContain('gone.example: does not resolve now');
    const viaLookup = await lockdownFor({
      deny: { hosts: ['nas.example', ipv4(203, 0, 113, 1)], ports: [] },
      lookup: async (n) => (n === 'nas.example' ? [ipv4(198, 51, 100, 3)] : []),
      blockSmbLan: true,
    });
    expect(viaLookup.hosts).toEqual([ipv4(198, 51, 100, 3), ipv4(203, 0, 113, 1)]);
    expect(viaLookup.blockSmbLan).toBe(true);
  });

  it('reads every way Windows writes an address entry', () => {
    const s = (e: string) => {
      const x = entrySpan(e);
      return x === undefined ? undefined : [x.lo.toString(16), x.hi.toString(16)];
    };
    expect(s(`${ipv4(10, 1, 0, 0)}/16`)).toEqual(s(`${ipv4(10, 1, 0, 0)}/${ipv4(255, 255, 0, 0)}`));
    expect(s(`${ipv4(10, 1, 0, 0)}-${ipv4(10, 1, 255, 255)}`)).toEqual(
      s(`${ipv4(10, 1, 0, 0)}/16`),
    );
    expect(s('2001:db8:1::/64')).toEqual([
      '20010db8000100000000000000000000',
      '20010db800010000ffffffffffffffff',
    ]);
    expect(s('LocalSubnet')).toBeUndefined();
    expect(s(`${ipv4(10, 0, 0, 0)}/${ipv4(255, 0, 255, 0)}`)).toBeUndefined();
  });
});

describe('names of deny.hosts', () => {
  it('the install records each name with the addresses its rule holds', () => {
    const p = lockdownPlan({
      denyHosts: ['nas.example'],
      resolved: { 'nas.example': [ipv4(198, 51, 100, 9)] },
      denyPorts: [],
    });
    const s = relaySetupScript({
      relayUser: 'studio-relay',
      crewPrefix: 'studio-crew',
      home: 'C:\\h',
      machine: 'C:\\m',
      task: 'Studio relay broker',
      readPaths: [],
      source: { node: 'C:\\n.exe', studio: 'C:\\s' },
      lockdown: p,
    });
    expect(s).toContain(`lockdownNames = (ConvertFrom-Json '${JSON.stringify(p.names)}')`);
    expect(
      parseInstallRecord({
        version: 1,
        spoolerDisabled: false,
        prior: null,
        lockdownNames: { 'nas.example': ipv4(198, 51, 100, 9), x: null },
      })?.lockdownNames,
    ).toEqual({ 'nas.example': [ipv4(198, 51, 100, 9)], x: [] });
  });

  it('names a name that moved past its rule, or came after the install; local addresses are held anyway', async () => {
    const lookup = async (n: string) =>
      n === 'nas.example'
        ? [ipv4(198, 51, 100, 9), ipv4(203, 0, 113, 50), ipv4(192, 168, 1, 7)]
        : [ipv4(198, 51, 100, 9)];
    expect(
      await denyNameDrift({
        denyHosts: [
          'local-subnets',
          ipv4(203, 0, 113, 1),
          'nas.example',
          'new.example',
          'same.example',
        ],
        recorded: {
          'nas.example': [ipv4(198, 51, 100, 9)],
          'same.example': [ipv4(198, 51, 100, 9)],
        },
        lookup,
      }),
    ).toEqual([
      `deny.hosts nas.example now resolves to ${ipv4(203, 0, 113, 50)}, which no firewall rule holds`,
      'deny.hosts new.example has no firewall rule yet (added after the install)',
    ]);
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

  it('relay install: rules for the relay account and the group with the routes of the machine, proved and read back before sshd starts', () => {
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
    expect(s).toContain('-RemoteAddress ($lockLocal + $lockHosts + $routes)');
    expect(s).toContain('$routes = @(LocalRoutes)');
    // No exception for any resolver: name resolution goes through the DNS Client service.
    expect(s).not.toMatch(/\$lockResolvers|RemotePort @\('1-52'/);
    expect(s).toContain('throw "the network lockdown does not hold');
    expect(s).toContain('firewall = $true');
    expect(s).not.toContain('Stop-Service -Name Spooler');
    // SMB to the local networks for everyone only when asked.
    expect(s).toContain('$lockSmbLan = $false');
    expect(lockdownSection(lockdownPlan({ ...empty, blockSmbLan: true }), '@()')).toContain(
      `-DisplayName '${SMB_LAN_RULE}' -Protocol TCP -RemotePort @('445', '139')`,
    );
  });

  it('the routes: everything but the default route and loopback; an IPv6 target from the gateway or a unique-local neighbor', () => {
    expect(ROUTE_FUNCTIONS).toContain(
      `$d -ne '${ipv4(0, 0, 0, 0)}/0' -and $d -ne '::/0' -and $d -notlike '127.*' -and $d -ne '::1/128'`,
    );
    expect(ROUTE_FUNCTIONS).toContain("Get-NetRoute -DestinationPrefix '::/0'");
    expect(ROUTE_FUNCTIONS).toContain(
      "'[' + [string]$gw.NextHop + '%' + $gw.InterfaceIndex + ']:445'",
    );
    const probe = lockdownSection(lockdownPlan(empty), '@()');
    expect(probe).toContain('$v6 = V6Target\n  if ($v6) { $t += $v6 }');
  });

  it('--no-firewall: no rules, the earlier ones removed, said to be unsafe, recorded', () => {
    const s = relay(null);
    expect(s).not.toContain('LockdownProbe');
    expect(s).toContain(`Get-NetFirewallRule -Group '${LOCKDOWN_GROUP}'`);
    expect(s).toContain('UNSAFE (--no-firewall)');
    expect(s).toContain('firewall = $false');
  });

  it('worker windows-setup: the group alone', () => {
    const s = windowsSetupScript({ prefix: 'studio-crew', crewDir: 'C:\\crew', readPaths: [] });
    expect(s).toContain('$lockSids = @($groupSid)');
    expect(s).toContain('LockdownProbe $lockSids');
  });

  it('the throwaway user: bound for the probe only, its files in an admin-only folder, deleted by name', () => {
    const s = lockdownSection(lockdownPlan(empty), '@($groupSid)');
    expect(s).toContain('LockdownRules (@($sids) + @($u.SID.Value))');
    const fin = s.indexOf('} finally {\n    LockdownRules $sids');
    expect(fin).toBeGreaterThan(s.indexOf('$after = ConnectAs'));
    expect(s.indexOf('$null = RetireJobUsers', fin)).toBeGreaterThan(fin);
    expect(s).toContain("@('10051', '10065', '10049', '10013') -notcontains $after[$_]");
    expect(s).toContain('$refused -eq 0');
    expect(s).toContain('[IO.Directory]::CreateDirectory($dir, $acl)');
    expect(s).toContain(
      'foreach ($f in @($file, $out, $err)) { Remove-Item -LiteralPath $f -Force',
    );
    expect(s).not.toMatch(/-Recurse|\$env:TEMP/);
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
    expect(restoreSteps(undefined)).not.toContain('RestrictDriverInstallationToAdministrators');
  });
});

describe('the check before every relay start', () => {
  const me = 'S-1-5-21-1-2-3-1001';
  const all = (r: string) => Object.fromEntries(PROBE_FIXED.map((t) => [t, r]));
  const good = (): LockdownState => ({
    me,
    profiles: ['Domain', 'Private', 'Public'].map((name) => ({
      name,
      enabled: 'True',
      local: 'True',
    })),
    rules: [
      {
        enabled: 'True',
        action: 'Block',
        direction: 'Outbound',
        users: `D:(A;;CC;;;S-1-5-21-9)(A;;CC;;;${me})`,
        remote: [
          `${ipv4(10, 0, 0, 0)}/${ipv4(255, 0, 0, 0)}`,
          '2001:db8:1::/64',
          `${ipv4(192, 168, 0, 0)}-${ipv4(192, 168, 255, 255)}`,
        ],
      },
    ],
    routes: [`${ipv4(10, 4, 0, 0)}/16`, `${ipv4(192, 168, 1, 0)}/24`, '2001:db8:1::/64'],
    ports: (['TCP', 'UDP'] as const).map((protocol) => ({
      protocol,
      enabled: 'True',
      action: 'Block',
      direction: 'Outbound',
      users: `D:(A;;CC;;;S-1-5-21-9)(A;;CC;;;${me})`,
      remote: ['5432', '6000-6010'],
    })),
    v6: '[fe80::1%12]:445',
    connect: { ...all('10013'), '[fe80::1%12]:445': '10013' },
  });

  it('holds when the rule is there, bound to this account, covers every local prefix, and the firewall refuses every target', () => {
    expect(judgeLockdown(good())).toBeUndefined();
  });

  it('refuses a new network the rule does not hold, an IPv6 global prefix of the LAN too', () => {
    expect(judgeLockdown({ ...good(), routes: [...good().routes, '2001:db8:2::/64'] })).toMatch(
      /the local network 2001:db8:2::\/64 has no firewall rule .*run studio relay install again/,
    );
  });

  it('refuses a profile off, local rules ignored, a missing or foreign rule, an IPv6 target not refused', () => {
    const off = good();
    off.profiles[1] = { name: 'Private', enabled: 'False', local: 'True' };
    expect(judgeLockdown(off)).toMatch(
      /off for the Private profile: Set-NetFirewallProfile -Profile Private -Enabled True/,
    );
    const ignored = good();
    ignored.profiles[0] = { name: 'Domain', enabled: 'True', local: 'False' };
    expect(judgeLockdown(ignored)).toMatch(/ignore local firewall rules/);
    expect(judgeLockdown({ ...good(), rules: [] })).toMatch(/not in the active firewall policy/);
    const other = good();
    (other.rules[0] as LockdownState['rules'][number]).users = 'D:(A;;CC;;;S-1-5-21-9)';
    expect(judgeLockdown(other)).toMatch(/does not hold the relay account/);
    // A longer SID that starts with this one is another account: the ACE's SID must match whole.
    const longer = good();
    (longer.rules[0] as LockdownState['rules'][number]).users = `D:(A;;CC;;;${me}0)`;
    expect(judgeLockdown(longer)).toMatch(/does not hold the relay account/);
    expect(lockdownSection(lockdownPlan(empty), '@()')).toContain("$who.Contains(';' + $s + ')')");
    expect(
      judgeLockdown({ ...good(), connect: { ...all('10013'), '[fe80::1%12]:445': 'timeout' } }),
    ).toMatch(/\[fe80::1%12\]:445 timed out/);
    expect(judgeLockdown({ ...good(), connect: all('10013') })).toMatch(
      /IPv6 target .* was not probed/,
    );
    expect(judgeLockdown({ ...good(), v6: null, connect: all('10051') })).toMatch(/does not hold/);
    expect(unrefused({ a: 'open' })).toEqual(['a opened']);
  });

  it('holds the start for a deny.prefixes span added to the config after the install', async () => {
    // Inside the rule's addresses (a part of 10/8): held already.
    const inside = await lockdownWant({
      deny: { hosts: [], ports: [], prefixes: [`${ipv4(10, 9, 0, 0)}/16`] },
    });
    expect(judgeLockdownAll(good(), inside)).toBeUndefined();
    const added = await lockdownWant({
      deny: {
        hosts: [],
        ports: [5432],
        prefixes: [`${ipv4(198, 51, 100, 0)}/24`, '2001:db8:9::/48'],
      },
    });
    const r = judgeLockdownAll(good(), added);
    expect(r?.kind).toBe('held');
    expect(r?.line).toMatch(
      /^deny\.prefixes \S+ has no firewall rule; deny\.prefixes \S+ has no firewall rule: run studio relay install again, elevated/,
    );
    expect(r?.line).toContain('2001:db8:9::');
    // The same through the check as the relay account, from the state the active store gives.
    const state = async () => ({ code: 0, stdout: JSON.stringify(good()), stderr: '' });
    expect((await lockdownProblem(state, added))?.line).toBe(r?.line);
    expect(await lockdownProblem(state, inside)).toBeUndefined();
  });

  it('holds the start for a deny.ports entry added after the install, for TCP and UDP alike', async () => {
    const held = await lockdownWant({ deny: { hosts: [], ports: [5432, 6005] } });
    expect(judgeLockdownAll(good(), held)).toBeUndefined();
    const added = await lockdownWant({ deny: { hosts: [], ports: [5432, 6379] } });
    expect(judgeLockdownAll(good(), added)).toEqual({
      kind: 'held',
      line: expect.stringMatching(
        /^deny\.ports 6379 has no TCP firewall rule; deny\.ports 6379 has no UDP firewall rule: run studio relay install again/,
      ),
    });
    // A UDP rule gone, or one bound to another account, holds no port.
    const noUdp = { ...good(), ports: good().ports.filter((x) => x.protocol === 'TCP') };
    expect(judgeLockdownAll(noUdp, held)?.line).toMatch(
      /deny\.ports 5432 has no UDP firewall rule/,
    );
    const foreign = good();
    for (const x of foreign.ports) x.users = 'D:(A;;CC;;;S-1-5-21-9)';
    expect(judgeLockdownAll(foreign, held)?.line).toMatch(/deny\.ports 5432 has no TCP/);
  });

  it('holds the start for a deny.hosts address, or a name as it resolves now, outside the rule', async () => {
    const want = await lockdownWant({
      deny: { hosts: [ipv4(203, 0, 113, 7), 'nas.example'], ports: [] },
      lookup: async () => [ipv4(198, 51, 100, 9)],
    });
    expect(judgeLockdownAll(good(), want)?.line).toMatch(
      new RegExp(
        `deny\\.hosts ${ipv4(203, 0, 113, 7).replace(/\./g, '\\.')}\\S* has no firewall rule; deny\\.hosts ${ipv4(198, 51, 100, 9).replace(/\./g, '\\.')}\\S* has no firewall rule`,
      ),
    );
    // A failing base check refuses first, whatever the config asks.
    expect(judgeLockdownAll({ ...good(), rules: [] }, want)?.kind).toBe('refused');
    expect(LOCKDOWN_STATE).toContain('Get-NetFirewallPortFilter');
    expect(LOCKDOWN_STATE).toContain(`'${lockdownPortsRule('TCP')}'`);
    expect(LOCKDOWN_STATE).toContain(`'${lockdownPortsRule('UDP')}'`);
    expect(lockdownSection(lockdownPlan(empty), '@()')).toContain(`'${lockdownPortsRule('UDP')}'`);
  });

  it('reads the state as Windows PowerShell prints it; no answer is a refusal', async () => {
    const one = parseLockdownState({
      me,
      profiles: { name: 'Public', enabled: 'True', local: 'True' },
      rules: {
        enabled: 'True',
        action: 'Block',
        direction: 'Outbound',
        users: `D:(A;;CC;;;${me})`,
        remote: `${ipv4(10, 0, 0, 0)}/8`,
      },
      routes: `${ipv4(10, 4, 0, 0)}/16`,
      v6: null,
      connect: all('10013'),
    });
    expect(one?.profiles).toHaveLength(1);
    expect(one?.rules[0]?.remote).toEqual([`${ipv4(10, 0, 0, 0)}/8`]);
    expect(judgeLockdown(one as LockdownState)).toBeUndefined();
    expect(
      (await lockdownProblem(async () => ({ code: 1, stdout: '', stderr: '' })))?.line,
    ).toMatch(/cannot be checked/);
    expect(
      await lockdownProblem(async () => ({ code: 0, stdout: JSON.stringify(good()), stderr: '' })),
    ).toBeUndefined();
    expect(LOCKDOWN_STATE).toContain(`-DisplayName '${LOCKDOWN_RULE}'`);
    expect(LOCKDOWN_STATE).toContain('Get-NetFirewallAddressFilter');
  });

  it('the SMB check as the relay account: IPC$ of each candidate without credentials, sessions closed at once', () => {
    const s = SMB_AS_ME([ipv4(192, 168, 1, 5), 'nas.example', 'bad host']);
    expect(s).toContain(`@('${ipv4(192, 168, 1, 5)}', 'nas.example')`);
    expect(s).toContain('WNetAddConnection2($r, $null, $null, 0)');
    expect(s).toContain(
      'if ($c -eq 0) { [void][StudioSmb]::WNetCancelConnection2($target, 0, $true) }',
    );
  });
});

describe('the proxy refuses the networks of this machine too', () => {
  it('a public name that resolves into a network the machine sits in is refused like a private one', async () => {
    const onLink = onLinkBlockList({
      eth0: [
        {
          address: ipv4(203, 0, 113, 10),
          netmask: ipv4(255, 255, 255, 0),
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: `${ipv4(203, 0, 113, 10)}/24`,
        },
        {
          address: '2001:db8:5::10',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '2001:db8:5::10/64',
          scopeid: 0,
        },
      ],
    });
    const resolve = (a: string) => async () => [a];
    expect(await checkedAddress(resolve(ipv4(203, 0, 113, 77)), 'x.example', onLink)).toMatchObject(
      { refused: expect.stringContaining('local or private') },
    );
    expect(await checkedAddress(resolve('2001:db8:5::99'), 'x.example', onLink)).toMatchObject({
      refused: expect.any(String),
    });
    expect(await checkedAddress(resolve(ipv4(9, 9, 9, 9)), 'x.example', onLink)).toEqual({
      address: ipv4(9, 9, 9, 9),
    });
  });
});

describe('the checks of a relay start (relayWindows.check)', () => {
  const machine = (record: Record<string, unknown>) => {
    const m = join(root, `m-${randomBytes(3).toString('hex')}`);
    mkdirSync(m, { recursive: true });
    writeFileSync(
      installRecordFile(m),
      JSON.stringify({ version: 1, readPaths: [], spoolerDisabled: false, prior: null, ...record }),
    );
    return m;
  };
  // Windows as the relay account sees it: a standard user, no WebClient, no loopback listener.
  const run: RunFile = async (file, args) => {
    const cmd = args.join(' ');
    if (file === 'whoami')
      return { code: 0, stdout: '"BUILTIN\\Users","Alias","S-1-5-32-545"', stderr: '' };
    if (cmd.includes('WebClient')) return { code: 0, stdout: '{"exists":false}', stderr: '' };
    if (cmd.includes('Get-NetTCPConnection')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const windows = (
    m: string,
    o: {
      lookup?: (n: string) => Promise<string[]>;
      smb?: Record<string, number>;
      lockdown?: Parameters<typeof relayWindows>[0]['lockdown'];
    } = {},
  ) =>
    relayWindows({
      prefix: 'studio-crew',
      home: join(m, 'home'),
      machine: m,
      task: 'Studio relay broker',
      stateRoot: join(m, 'state'),
      ownerRoot: join(m, 'owner'),
      crewConfigDir: join(m, 'crew'),
      ownerHome: m,
      ownerConfigDir: join(m, 'config'),
      unreachable: [],
      env: {},
      ports: realPorts(),
      startProxy: async () => ({ port: 1, close: async () => {} }),
      run,
      interfaces: () => ({}),
      lockdown: o.lockdown ?? (async () => undefined),
      lookup: o.lookup ?? (async () => [ipv4(198, 51, 100, 9)]),
      smbAsMe: async () => o.smb ?? {},
    });
  const deny = { paths: [], ports: [] } as unknown as Parameters<
    ReturnType<typeof relayWindows>['check']
  >[0]['deny'];

  it('a deny.hosts name past its rule holds the start, with the fix', async () => {
    const m = machine({
      firewall: true,
      lockdownNames: { 'nas.example': [ipv4(198, 51, 100, 9)] },
    });
    const r = await windows(m, { lookup: async () => [ipv4(203, 0, 113, 50)] }).check({
      deny,
      hosts: ['nas.example'],
    });
    expect(r.problem).toEqual({
      kind: 'held',
      line: `deny.hosts nas.example now resolves to ${ipv4(203, 0, 113, 50)}, which no firewall rule holds: run studio relay install again, elevated, so the firewall rules follow the names`,
    });
  });

  it('hands the check every deny entry in force, prefixes and ports added later included; a gap holds the start', async () => {
    const m = machine({ firewall: true, lockdownNames: {} });
    let seen: LockdownWant | undefined;
    const r = await windows(m, {
      lockdown: async (_run, want) => {
        seen = want;
        return {
          kind: 'held',
          line: 'deny.ports 6379 has no TCP firewall rule: run studio relay install again',
        };
      },
    }).check({
      deny: { ...deny, ports: [6379], prefixes: [`${ipv4(198, 51, 100, 0)}/24`] },
      hosts: [],
    });
    expect(seen?.ports).toEqual([6379]);
    expect(seen?.spans.map((x) => x.from)).toEqual(['deny.prefixes']);
    expect(r.problem).toEqual({
      kind: 'held',
      line: 'deny.ports 6379 has no TCP firewall rule: run studio relay install again',
    });
  });

  it('an SMB session the relay account opens refuses the start', async () => {
    const m = machine({
      firewall: true,
      lockdownNames: { 'nas.example': [ipv4(198, 51, 100, 9)] },
    });
    const r = await windows(m, { smb: { 'nas.example': 0 } }).check({
      deny,
      hosts: ['nas.example'],
    });
    expect(r.problem?.kind).toBe('refused');
    expect(r.problem?.line).toContain('the relay account opened an SMB session to nas.example');
  });

  it('without a lockdown every check says so', async () => {
    const m = machine({ firewall: false });
    const r = await windows(m, { smb: { 'nas.example': 0 } }).check({
      deny,
      hosts: ['nas.example'],
    });
    expect(r.warnings).toContain(NO_LOCKDOWN);
  });
});

describe('a worker without its lockdown, as the lead sees it', () => {
  const transport = (warnings: string[]): RelayTransport => ({
    async call(header) {
      const msg =
        header.op === 'probe'
          ? { studioRelay: 1, ok: true, problem: null, kind: null, load: null, warnings: [] }
          : {
              studioRelay: 1,
              ok: true,
              studio: '1.0.0',
              platform: 'win32',
              plugins: {},
              busy: null,
              held: null,
              pairProofs: [],
              warnings,
            };
      return (await readMessage(
        new LineReader(
          (async function* () {
            yield* encodeMessage(msg);
          })(),
          1 << 20,
        ),
        0,
      )) as {
        header: Record<string, unknown>;
      };
    },
  });
  it('doctor fails on it, with the fix, unless the lead accepted it', async () => {
    const no = await relayDoctor({
      transport: transport([NO_LOCKDOWN]),
      label: 'lab',
      studioVersion: '1.0.0',
      pins: [],
    });
    expect(no.ok).toBe(false);
    expect(no.lines.join('\n')).toContain(
      'accept it with workers.relay.lab.accept_no_firewall: true',
    );
    const yes = await relayDoctor({
      transport: transport([NO_LOCKDOWN]),
      label: 'lab',
      studioVersion: '1.0.0',
      pins: [],
      acceptNoFirewall: true,
    });
    expect(yes.ok).toBe(true);
    expect(yes.lines.join('\n')).toContain('note: no network lockdown');
  });
  it('deny.prefixes: further networks of either family become part of the rule; nonsense is refused', () => {
    const p = lockdownPlan({
      ...empty,
      denyPrefixes: ['2001:db8:ab00::/56', `${ipv4(203, 0, 113, 0)}/24`],
    });
    expect(p.hosts).toEqual([
      '2001:db8:ab00:0:0:0:0:0-2001:db8:ab00:ff:ffff:ffff:ffff:ffff',
      `${ipv4(203, 0, 113, 0)}-${ipv4(203, 0, 113, 255)}`,
    ]);
    const deny = (prefixes: string[]) => workerDenySchema.safeParse({ prefixes }).success;
    expect(deny(['2001:db8::/56', `${ipv4(203, 0, 113, 0)}/24`])).toBe(true);
    expect(deny(['2001:db8::/129'])).toBe(false);
    expect(deny(['nas.example/24'])).toBe(false);
    expect(deny([`${ipv4(203, 0, 113, 0)}`])).toBe(false);
  });

  it('the lead config takes accept_no_firewall, off by default', () => {
    const base = {
      host: 'worker.example',
      hostKey: `ssh-ed25519 ${'A'.repeat(68)}`,
      identityFile: '/home/o/.ssh/k',
    };
    expect(relayTargetSchema.parse(base).acceptNoFirewall).toBeUndefined();
    expect(relayTargetSchema.parse({ ...base, acceptNoFirewall: true }).acceptNoFirewall).toBe(
      true,
    );
  });
});

async function* none(): AsyncGenerator<string> {}

describe('studio relay install and setup with and without --no-firewall', () => {
  const run = async (sub: string, values: Record<string, unknown>) => {
    const machine = join(root, `m-${randomBytes(3).toString('hex')}`);
    const scripts: string[] = [];
    const out: string[] = [];
    const exec: Exec = async (file, _args, o) => {
      const script = scriptOfRun(o);
      if (script !== undefined) scripts.push(script);
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

  it('install: the lockdown; --no-firewall: none, said unsafe; --block-smb-lan: the machine-wide SMB rule', async () => {
    const on = await run('install', { source: 'fd7a::/48' });
    expect(on.script).toContain('LockdownProbe $lockSids');
    expect(on.script).toContain('$lockSmbLan = $false');
    expect((await run('install', { source: 'fd7a::/48', 'block-smb-lan': true })).script).toContain(
      '$lockSmbLan = $true',
    );
    const off = await run('install', { source: 'fd7a::/48', 'no-firewall': true });
    expect(off.script).not.toContain('LockdownProbe');
    expect(off.script).toContain('UNSAFE (--no-firewall)');
  });

  it('setup prints the same lockdown', async () => {
    expect((await run('setup', {})).script).toContain('LockdownProbe $lockSids');
    expect((await run('setup', { 'no-firewall': true })).script).toContain('UNSAFE');
    expect(NO_LOCKDOWN).toContain('--no-firewall');
  });
});

// Elevated, on the windows-latest job.
const elevated = process.platform === 'win32' && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';

describe.skipIf(!elevated)('the lockdown on Windows', () => {
  const env = Object.fromEntries(
    Object.entries(powershellEnv(process.env)).filter(([k]) => k.toLowerCase() !== 'psmodulepath'),
  );
  const runPs = (script: string) => {
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
    const out = runPs(`$ErrorActionPreference = 'Stop'
${crewAccountFunctions(prefix, { treeSource: TREE_SOURCE() })}
$g = New-LocalGroup -Name '${prefix}s' -Description $groupDescription
$groupSid = $g.SID.Value
try {
${lockdownSection(lockdownPlan({ denyHosts: [], denyPorts: [5432], blockSmbLan: true }), '@($groupSid)')}
  Write-Output ('rules: ' + @(Get-NetFirewallRule -Group '${LOCKDOWN_GROUP}').Count)
  Write-Output ('routes held: ' + @(LocalRoutes).Count)
} finally {
  Get-NetFirewallRule -Group '${LOCKDOWN_GROUP}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Remove-LocalGroup -SID $g.SID
}
Write-Output ('left users: ' + @(Get-LocalUser | Where-Object { $_.Name -like '${prefix}-*' }).Count)`);
    expect(out).toMatch(/lockdown probe: before the rule \d+ of \d+ local targets/);
    expect(out).toMatch(/ok: all \d+ refused by the firewall/);
    expect(out).toContain('ok: network lockdown');
    // The local rule, TCP and UDP for the denied port, and the machine-wide SMB rule.
    expect(out).toContain('rules: 4');
    expect(out).toMatch(/routes held: [1-9]/);
    expect(out).toContain('left users: 0');
  }, 300_000);

  it('the check as this account: the real rules with the routes of this machine hold; without them, or for an entry added later, the start waits', async () => {
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
    expect((await lockdownProblem(runFile))?.line).toMatch(/not in the active firewall policy/);
    // The real rule, bound to this account, for the length of the test.
    runPs(`$ErrorActionPreference = 'Stop'
${lockdownSection(
  lockdownPlan({ denyHosts: [], denyPorts: [5432], denyPrefixes: [`${ipv4(198, 51, 100, 0)}/24`] }),
  `@('${me}')`,
)
  .split('\n')
  .filter((l) => !/^(LockdownProbe|\$lockProblems|if \(@\(\$lockProblems)/.test(l))
  .join('\n')}`);
    try {
      expect(await lockdownProblem(runFile)).toBeUndefined();
      // What the install wrote, read back from the active store: held.
      const installed = await lockdownWant({
        deny: { hosts: [], ports: [5432], prefixes: [`${ipv4(198, 51, 100, 0)}/24`] },
      });
      expect(await lockdownProblem(runFile, installed)).toBeUndefined();
      // A prefix and a port added to the config after the install: the start waits.
      const later = await lockdownWant({
        deny: {
          hosts: [],
          ports: [5432, 6379],
          prefixes: [`${ipv4(198, 51, 100, 0)}/24`, `${ipv4(203, 0, 113, 0)}/24`],
        },
      });
      const r = await lockdownProblem(runFile, later);
      expect(r?.kind).toBe('held');
      expect(r?.line).toMatch(
        /^deny\.prefixes \S+ has no firewall rule; deny\.ports 6379 has no TCP firewall rule; deny\.ports 6379 has no UDP firewall rule: run studio relay install again/,
      );
    } finally {
      runPs(
        `Get-NetFirewallRule -Group '${LOCKDOWN_GROUP}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
      );
    }
  }, 180_000);
});
