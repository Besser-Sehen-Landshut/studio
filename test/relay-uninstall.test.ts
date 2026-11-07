// `studio relay uninstall`: the order of its steps, what it puts back, the CLI's refusals, and on
// the elevated windows-latest job a real run against what an install leaves.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CREW_DESCRIPTION, TREE_SOURCE } from '../src/crew-accounts.js';
import { realPorts } from '../src/ports.js';
import { type Exec, runRelayCommand } from '../src/relay-command.js';
import { readPairings, writePairings } from '../src/relay-pair.js';
import {
  type InstallRecord,
  LSA_RIGHTS,
  parseInstallRecord,
  RELAY_DESCRIPTION,
  relayUninstallScript,
  restoreSteps,
  treePathProblem,
  type UninstallOptions,
} from '../src/relay-uninstall.js';
import { installRecordFile, relaySetupScript, SSHD_SWAP } from '../src/relay-windows.js';
import { powershellEnv, windowsSetupScript } from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-uninstall-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const base: UninstallOptions = {
  relayUser: 'studio-relay',
  crewPrefix: 'studio-crew',
  task: 'Studio relay broker',
  home: 'C:\\ProgramData\\Studio\\relay',
  machine: 'C:\\Program Files\\Studio\\relay',
  readPaths: ['C:\\claude'],
  keepTree: false,
  forceStop: false,
  record: undefined,
  treeSource: 'C:\\plugins\\studio\\bin\\studio-tree.cs',
};

const recorded = (prior: InstallRecord['prior'], spoolerDisabled = false): InstallRecord => ({
  readPaths: [],
  spoolerDisabled,
  prior,
});

describe('the uninstall script', () => {
  it('cuts the leads off first, then the jobs, and removes the rest in a fail-safe order', () => {
    const s = relayUninstallScript(base);
    const order = [
      'authorized_keys',
      'NoRelayJob\n',
      'Unregister-ScheduledTask',
      '$retired = RetireJobUsers',
      'Remove-LocalGroup',
      'Remove-LocalUser -SID $account.SID',
      '# studio relay begin global',
      "-DisplayName 'Studio relay: sshd'",
      '[StudioTree]::Remove($p, $null)',
      "Write-Output 'done:",
    ].map((m) => {
      const at = s.indexOf(m, s.indexOf('[1/9]'));
      expect(at, m).toBeGreaterThan(0);
      return at;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Every broker task of the install, and numbered steps.
    for (const t of [
      'Studio relay broker',
      'Studio relay broker retire',
      'Studio relay broker fresh',
    ]) {
      expect(s).toContain(`'${t}'`);
    }
    for (let n = 1; n <= 9; n++) expect(s).toContain(`[${n}/9]`);
    // What stays installed, and how to remove it by hand.
    expect(s).toContain('winget uninstall --id Git.Git; winget uninstall --id OpenJS.NodeJS.LTS');
  });

  it("removes only what is Studio's: the relay account by its description, the group by its own", () => {
    const s = relayUninstallScript(base);
    expect(s).toContain(`$account.Description -ne '${RELAY_DESCRIPTION}'`);
    // One that served as the relay account but is not Studio's is disabled, loudly, never deleted.
    expect(s).toContain('Disable-LocalUser -SID $account.SID');
    expect(s).toContain('WARNING: the user $relay was not made by Studio');
    // Every process of the account, and every one whose owner cannot be read, holds it.
    expect(s).toContain('$still = @(Owned @($account.SID.Value))');
    expect(s).not.toContain('Owned @($account.SID.Value) | Where-Object { -not $_.Unreadable }');
    // The jobs check goes through Owned too, with the debug privilege, unreadable owners included.
    expect(s).toContain('@(Owned $sids | ForEach-Object');
    // sshd_config: checked as a temporary file, swapped in only when sshd takes it.
    expect(s).toContain('SshdConfigSwap $conf ($text.TrimEnd() + [Environment]::NewLine) $false');
    // A tree is removed only when its path ends in Studio\relay and is no drive root.
    expect(s).toContain("$bare -notmatch '[\\\\/]Studio[\\\\/]relay$'");
    expect(relayUninstallScript({ ...base, forcePath: true })).toContain('$forcePath = $true');
    expect(s).toContain('$group.Description -ne $groupDescription) { throw');
    // The relay account's profile goes the way a crew user's does: into the quarantine, never followed.
    expect(s).toContain("QuarantineProfile $account (Join-Path (Quarantine) 'trees')");
  });

  it('keeps both trees with --keep-tree, but never the keys, the pairings or the credential', () => {
    const s = relayUninstallScript({ ...base, keepTree: true });
    expect(s).not.toContain('[StudioTree]::Remove($p, $null)');
    expect(s).toContain('authorized_keys');
    expect(s).toContain('pairings.json');
    expect(s).toContain('crew-credential.bin');
  });

  it('refuses names that are not names', () => {
    expect(() => relayUninstallScript({ ...base, relayUser: 'a b' })).toThrow(/user name/);
    expect(() => relayUninstallScript({ ...base, crewPrefix: 'x'.repeat(20) })).toThrow(/prefix/);
    expect(() => relayUninstallScript({ ...base, task: "a'b" })).toThrow(/task/);
  });
});

describe('what uninstall turns back on', () => {
  it('nothing without a record: WebClient stays off, sshd stops and stays disabled', () => {
    const s = restoreSteps(undefined);
    expect(s).not.toContain("Set-Service -Name 'WebClient'");
    expect(s).toContain('Set-Service -Name sshd -StartupType Disabled');
    expect(s).toContain('no record says it ran before');
    expect(s).not.toContain('Enable-NetFirewallRule');
    expect(restoreSteps(recorded(null))).toBe(s);
  });

  it('the recorded state: WebClient as it was, sshd running again, the OpenSSH rule on again', () => {
    const s = restoreSteps(
      recorded({
        webClient: { exists: true, start: 'Manual', status: 'Running' },
        spooler: { exists: true, start: 'Automatic', status: 'Running' },
        sshd: { exists: true, start: 'Automatic', status: 'Running' },
        sshdRule: { exists: true, enabled: 'True' },
        sshdCapability: { name: 'OpenSSH.Server~~~~v1', state: 'Installed' },
      }),
    );
    expect(s).toContain("Set-Service -Name 'WebClient' -StartupType Manual");
    expect(s).toContain("Start-Service -Name 'WebClient'");
    // The spooler only when the install stopped it.
    expect(s).not.toContain("'Spooler'");
    expect(s).toContain('Restart-Service -Name sshd');
    expect(s).toContain('Enable-NetFirewallRule');
    expect(s).not.toContain('Remove-WindowsCapability');
  });

  it('a disabled service stays disabled; the spooler the install stopped comes back; an added OpenSSH server goes', () => {
    const s = restoreSteps(
      recorded(
        {
          webClient: { exists: true, start: 'Disabled', status: 'Stopped' },
          spooler: { exists: true, start: 'Automatic', status: 'Running' },
          sshd: { exists: false },
          sshdRule: { exists: false },
          sshdCapability: { name: 'OpenSSH.Server~~~~v1', state: 'NotPresent' },
        },
        true,
      ),
    );
    expect(s).not.toContain("Set-Service -Name 'WebClient'");
    expect(s).toContain("Set-Service -Name 'Spooler' -StartupType Automatic");
    expect(s).toContain('Set-Service -Name sshd -StartupType Disabled');
    expect(s).toContain("Remove-WindowsCapability -Online -Name 'OpenSSH.Server~~~~v1'");
    // A start type outside the three is never passed on.
    expect(
      restoreSteps(
        recorded({ webClient: { exists: true, start: 'Boot; evil', status: 'Running' } }),
      ),
    ).not.toContain('evil');
  });

  it('reads a record as Windows PowerShell writes it, one-element arrays included', () => {
    const r = parseInstallRecord(
      JSON.parse(
        '{"version":1,"relayUser":"studio-relay","readPaths":"C:\\\\claude","spoolerDisabled":true,"prior":{"webClient":{"exists":true,"start":"Manual","status":"Running"},"sshdCapability":null}}',
      ),
    );
    expect(r).toEqual({
      relayUser: 'studio-relay',
      readPaths: ['C:\\claude'],
      spoolerDisabled: true,
      prior: { webClient: { exists: true, start: 'Manual', status: 'Running' } },
    });
    expect(parseInstallRecord({ version: 2 })).toBeUndefined();
    expect(parseInstallRecord(null)).toBeUndefined();
  });
});

describe('the install records what it found', () => {
  const install = relaySetupScript({
    relayUser: 'studio-relay',
    crewPrefix: 'studio-crew',
    home: 'C:\\ProgramData\\Studio\\relay',
    machine: 'C:\\Program Files\\Studio\\relay',
    task: 'Studio relay broker',
    readPaths: ['C:\\claude'],
    source: { node: 'C:\\nodejs\\node.exe', studio: 'C:\\plugins\\studio' },
    install: { port: 22, scope: { tailscale: true }, disableSpooler: true },
  });
  it('before it changes anything, and writes it once the admin-only tree is there', () => {
    const captured = install.indexOf("$priorWebClient = ServiceState 'WebClient'");
    expect(captured).toBeGreaterThanOrEqual(0);
    for (const change of [
      'SshdOff\n',
      'Stop-Service -Name Spooler',
      'Stop-Service -Name WebClient',
    ]) {
      expect(install.indexOf(change), change).toBeGreaterThan(captured);
    }
    expect(install.indexOf('$priorSshdCapability = @{')).toBeLessThan(
      install.indexOf('Add-WindowsCapability'),
    );
    const written = install.indexOf(
      "$recordFile = 'C:\\Program Files\\Studio\\relay\\install-record.json'",
    );
    expect(written).toBeGreaterThan(install.indexOf('StrictFolder $machine'));
    expect(install).toContain('spoolerDisabled = ($true -or');
    // A record of an earlier run keeps the state before Studio; an old install without one is unknown.
    expect(install).toContain('if ($null -ne $old) { $prior = $old.prior }');
    expect(install).toContain('elseif ($priorMachine) { $prior = $null }');
  });
});

async function* none(): AsyncGenerator<string> {}

describe('studio relay uninstall', () => {
  const setup = () => {
    const machine = join(root, `m-${randomBytes(3).toString('hex')}`);
    mkdirSync(machine, { recursive: true });
    const scripts: string[] = [];
    const out: string[] = [];
    const exec: Exec = async (file, args) => {
      if (file === 'powershell.exe' && args.includes('-File')) {
        scripts.push(readFileSync(args.at(-1) as string, 'utf8'));
      }
      return { code: 0, stdout: 'False', stderr: '' };
    };
    const run = (values: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      runRelayCommand({
        rest: ['uninstall'],
        values,
        owner: { env: {}, homedir: machine },
        ports: realPorts(),
        env: {},
        stdin: none(),
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        exec,
        platform: { platform: 'win32', wsl: 'none', automountRoot: '/mnt/' },
        elevated: async () => true,
        machine,
        ...extra,
      });
    return { machine, scripts, out, run };
  };

  it('runs the script with the names of the record and names the leads to forget', async () => {
    const s = setup();
    writeFileSync(
      installRecordFile(s.machine),
      JSON.stringify({
        version: 1,
        relayUser: 'relay-x',
        crewPrefix: 'crew-x',
        task: 'Broker x',
        home: 'C:\\relay-home',
        readPaths: ['C:\\tools'],
        spoolerDisabled: false,
        prior: null,
      }),
    );
    writePairings(s.machine, {
      lab: {
        key: `ssh-ed25519 ${'A'.repeat(68)}`,
        secret: 'a'.repeat(43),
        pairedAt: '2026-11-06T10:00:00Z',
      },
    });
    expect(await s.run({ 'keep-tree': true })).toBe(0);
    const script = s.scripts[0] as string;
    expect(script).toContain("$relay = 'relay-x'");
    expect(script).toContain("$prefix = 'crew-x'");
    expect(script).toContain("'Broker x retire'");
    expect(script).toContain("$home_ = 'C:\\relay-home'");
    expect(script).toContain("$readPaths = @('C:\\tools')");
    expect(script).not.toContain('[StudioTree]::Remove($p, $null)');
    expect(s.out.join('')).toContain('remove workers.relay.lab from the owner config');
    // The script removes the pairings itself; the CLI only read them.
    expect(Object.keys(readPairings(s.machine))).toEqual(['lab']);
  });

  it('without a record: the defaults, and it says nothing is turned back on', async () => {
    const s = setup();
    expect(await s.run({ 'keep-tree': true })).toBe(0);
    expect(s.scripts[0]).toContain("$relay = 'studio-relay'");
    expect(s.scripts[0]).toContain("$prefix = 'studio-crew'");
    expect(s.out.join('')).toContain('No install record here');
  });

  it("removes only trees it can tell are Studio's: recorded or default, ending in Studio\\relay", async () => {
    const s = setup();
    // A folder that is not Studio\relay, and one without the install's record: refused.
    await expect(s.run()).rejects.toThrow(
      /removes no tree it cannot tell is Studio's: .* is not a folder Studio/,
    );
    const studio = join(s.machine, 'Studio', 'relay');
    mkdirSync(studio, { recursive: true });
    await expect(s.run({}, { machine: studio })).rejects.toThrow(
      /holds no install record of Studio's/,
    );
    writeFileSync(
      installRecordFile(studio),
      JSON.stringify({ version: 1, readPaths: [], spoolerDisabled: false, prior: null }),
    );
    expect(await s.run({}, { machine: studio })).toBe(0);
    // --force-path removes them all the same, and says so in the script.
    expect(await s.run({ 'force-path': true })).toBe(0);
    expect(s.scripts.at(-1)).toContain('$forcePath = $true');
    expect(
      treePathProblem({
        home: 'C:\\',
        machine: 'C:\\Program Files\\Studio\\relay',
        recordedHome: undefined,
        defaultHome: 'C:\\ProgramData\\Studio\\relay',
        defaultMachine: 'C:\\Program Files\\Studio\\relay',
        machineMarked: false,
      }),
    ).toMatch(/is not a folder Studio/);
    expect(
      treePathProblem({
        home: 'D:\\Data\\Studio\\relay',
        machine: 'C:\\Program Files\\Studio\\relay',
        recordedHome: 'C:\\ProgramData\\Studio\\relay',
        defaultHome: 'C:\\ProgramData\\Studio\\relay',
        defaultMachine: 'C:\\Program Files\\Studio\\relay',
        machineMarked: false,
      }),
    ).toMatch(/is not the relay home the install recorded/);
  });

  it('never removes the tree it runs from; with --keep-tree it may run there', async () => {
    const s = setup();
    const here = dirname(dirname(process.execPath));
    await expect(s.run({}, { machine: here })).rejects.toThrow(/while it runs from there/);
    expect(await s.run({ 'keep-tree': true }, { machine: here })).toBe(0);
  });

  it('refuses over SSH, unelevated and off Windows; a failed script says how to go on', async () => {
    const s = setup();
    await expect(s.run({}, { env: { SSH_CLIENT: 'x 1 22' } })).rejects.toThrow(/never over SSH/);
    await expect(s.run({}, { elevated: async () => false })).rejects.toThrow(/elevated/);
    await expect(
      s.run({}, { platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' } }),
    ).rejects.toThrow(/Windows relay worker/);
    expect(
      await s.run(
        { 'keep-tree': true },
        {
          exec: async (_f: string, a: string[]) => ({
            code: a.includes('-File') ? 1 : 0,
            stdout: 'False',
            stderr: '',
          }),
        },
      ),
    ).toBe(1);
    expect(s.out.join('')).toContain('run studio relay uninstall again');
  });
});

// Elevated, on the windows-latest job: what an install leaves, made here by hand and with the
// setup's own functions, and the uninstall run twice against it.
const elevated = process.platform === 'win32' && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';

describe.skipIf(!elevated)('studio relay uninstall on Windows', () => {
  const tag = randomBytes(3).toString('hex');
  const prefix = `stu${tag}`;
  const relayUser = `srl${tag}`;
  const task = `Studio test broker ${tag}`;
  const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
  const env = Object.fromEntries(
    Object.entries(powershellEnv(process.env)).filter(([k]) => k.toLowerCase() !== 'psmodulepath'),
  );
  const ps = (script: string) =>
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env,
    }).trim();
  const runFile = (script: string) => {
    const file = join(root, `run-${randomBytes(3).toString('hex')}.ps1`);
    writeFileSync(file, script);
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 },
    );
  };

  it("removes the accounts, the group with its rule and rights, the tasks, the trees and Studio's sshd lines, and again finds nothing", () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'studio-uninstall-real-')));
    const machine = join(work, 'pf', 'Studio', 'relay');
    const home = join(work, 'pd', 'Studio', 'relay');
    const tools = join(work, 'tools');
    const outside = join(work, 'outside');
    const conf = join(work, 'sshd_config');
    for (const d of [join(machine, 'pairing'), join(home, 'state'), tools, outside]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(outside, 'keep.txt'), 'the owner');
    writeFileSync(join(machine, 'authorized_keys'), 'x\n');
    writeFileSync(join(machine, 'pairing', 'pairings.json'), '{}\n');
    writeFileSync(
      conf,
      '# studio relay begin global\nPasswordAuthentication no\n# studio relay end global\nPort 22\n\n# studio relay begin\nMatch User x\n    PermitTTY no\n# studio relay end\n',
    );
    // The group with its firewall rule, logon rights and read grant, as the setup makes it.
    runFile(windowsSetupScript({ prefix, crewDir: join(work, 'crewdir'), readPaths: [tools] }));
    const groupSid = ps(`(Get-LocalGroup -Name '${prefix}s').SID.Value`);
    // A crew user of a job, the relay account, the broker tasks, the sshd rule, a link in state.
    ps(`$ErrorActionPreference = 'Stop'
$pw = ConvertTo-SecureString ('Aa1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
$c = New-LocalUser -Name '${prefix}-abc123' -Password $pw -Description ${q(CREW_DESCRIPTION)}
Add-LocalGroupMember -Group '${prefix}s' -Member $c
New-LocalUser -Name '${relayUser}' -Password $pw -Description ${q(RELAY_DESCRIPTION)} | Out-Null
foreach ($t in @(${q(task)}, ${q(`${task} retire`)}, ${q(`${task} fresh`)})) {
  Register-ScheduledTask -TaskName $t -TaskPath '\\' -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit 0') -User 'SYSTEM' | Out-Null
}
New-NetFirewallRule -DisplayName 'Studio relay: sshd' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -RemoteAddress 'fd7a::/48' | Out-Null
New-Item -ItemType Junction -Path ${q(join(home, 'state', 'link'))} -Target ${q(outside)} | Out-Null`);
    const script = relayUninstallScript({
      ...base,
      relayUser,
      crewPrefix: prefix,
      task,
      home,
      machine,
      readPaths: [tools],
      record: recorded({ webClient: { exists: false }, sshd: { exists: false } }),
      treeSource: TREE_SOURCE(),
      sshdConfig: conf,
    });
    const first = runFile(script);
    expect(first).toContain('done: Studio relay worker uninstalled');
    expect(first).toContain(`removed: the group ${prefix}s`);
    expect(first).toContain(`removed: the relay account ${relayUser}`);
    const state = JSON.parse(
      ps(`ConvertTo-Json -Compress @{
  users = @(Get-LocalUser | Where-Object { $_.Name -like '${prefix}-*' -or $_.Name -eq '${relayUser}' }).Count
  group = [bool](Get-LocalGroup -Name '${prefix}s' -ErrorAction SilentlyContinue)
  tasks = @(Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like ${q(`${task}*`)} }).Count
  crewRule = [bool](Get-NetFirewallRule -DisplayName 'Studio crews ${prefix}s: no direct network' -ErrorAction SilentlyContinue)
  sshdRule = [bool](Get-NetFirewallRule -DisplayName 'Studio relay: sshd' -ErrorAction SilentlyContinue)
  grant = [bool]((Get-Acl -LiteralPath ${q(tools)}).Access | Where-Object { $_.IdentityReference.Value -eq '${groupSid}' })
}`),
    ) as Record<string, unknown>;
    expect(state).toEqual({
      users: 0,
      group: false,
      tasks: 0,
      crewRule: false,
      sshdRule: false,
      grant: false,
    });
    // The group holds no logon right any more (LSA, as the uninstall removes them).
    expect(ps(`Add-Type -TypeDefinition ${q(LSA_RIGHTS)}; [StudioLsa]::Count('${groupSid}')`)).toBe(
      '0',
    );
    expect(existsSync(machine)).toBe(false);
    expect(existsSync(home)).toBe(false);
    // The link in state was removed as a link: what it pointed to is untouched.
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the owner');
    expect(readFileSync(conf, 'utf8').replace(/\r\n/g, '\n')).toBe('Port 22\n');
    // Run again: nothing is left to remove, and it still ends well.
    const second = runFile(script);
    expect(second).toContain('done: Studio relay worker uninstalled');
    expect(second).not.toContain('removed:');
  }, 600_000);

  it('a relay account Studio did not make is disabled, loudly, never deleted; a tree that is not Studio\\relay stays', () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'studio-uninstall-guard-')));
    const other = `sro${tag}`;
    ps(`$pw = ConvertTo-SecureString ('Aa1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
New-LocalUser -Name '${other}' -Password $pw -Description 'someone else' | Out-Null`);
    const plain = join(work, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'keep.txt'), 'x');
    const script = relayUninstallScript({
      ...base,
      relayUser: other,
      crewPrefix: `sgx${tag}`,
      task,
      home: plain,
      machine: join(work, 'pf', 'Studio', 'relay'),
      readPaths: [],
      record: undefined,
      treeSource: TREE_SOURCE(),
      sshdConfig: join(work, 'sshd_config'),
    });
    let failed = '';
    try {
      runFile(script);
    } catch (e) {
      failed = String((e as { stdout?: string }).stdout ?? '') + String(e);
    }
    expect(failed).toContain(`WARNING: the user ${other} was not made by Studio`);
    expect(failed).toContain('is not a folder Studio\\relay: nothing of it is removed');
    expect(ps(`[string](Get-LocalUser -Name '${other}').Enabled`)).toBe('False');
    expect(existsSync(join(plain, 'keep.txt'))).toBe(true);
    ps(`Remove-LocalUser -Name '${other}'`);
  }, 300_000);

  it('sshd_config: a config sshd refuses changes nothing; an accepted one is swapped in whole', () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'studio-sshd-swap-')));
    const conf = join(work, 'sshd_config');
    writeFileSync(conf, 'Port 22\n');
    const swap = (text: string, must: boolean) => {
      try {
        return runFile(
          `$ErrorActionPreference = 'Stop'\n${SSHD_SWAP}SshdConfigSwap ${q(conf)} ${q(text)} $${must}\nWrite-Output 'swapped'`,
        );
      } catch (e) {
        return `refused ${String((e as { stderr?: string }).stderr ?? e)}`;
      }
    };
    const sshd = existsSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'sshd.exe'),
    );
    if (sshd) {
      expect(swap('NotAnOption yes\n', true)).toMatch(
        /^refused .*sshd does not accept the new sshd_config/s,
      );
      expect(readFileSync(conf, 'utf8')).toBe('Port 22\n');
      expect(swap('Port 2222\n', true)).toContain('swapped');
      expect(readFileSync(conf, 'utf8')).toBe('Port 2222\n');
    } else {
      expect(swap('Port 2222\n', true)).toMatch(/sshd\.exe is not there/);
      expect(readFileSync(conf, 'utf8')).toBe('Port 22\n');
      expect(swap('Port 2222\n', false)).toContain('swapped');
    }
    // No temporary file or throwaway key is left behind.
    expect(readdirSync(work)).toEqual(['sshd_config']);
  }, 120_000);
});
