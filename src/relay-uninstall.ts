// `studio relay uninstall` on a Windows relay worker (src/relay-windows.ts): takes away what
// `relay install` made, in an order that never leaves the machine more open than before. First no
// lead can log in any more (every key and pairing goes), then no job runs, then the broker tasks
// go, the crew users are retired the way every job's crew user is, then their group, the relay
// account with its profile, Studio's lines of sshd_config and its firewall rules, and the two
// trees. Services Studio stopped are started again only when the install recorded that they ran
// before; without a record nothing is turned back on. Every step finds its part gone and goes on,
// so running it again finishes what an earlier run left.
import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { CREW_PREFIX_RE, crewAccountFunctions } from './crew-accounts.js';
import {
  authorizedKeysFile,
  brokerTasks,
  installRecordFile,
  machineCredFile,
  machineStudio,
  relayJobFunctions,
} from './relay-windows.js';
import { psQuote } from './windows-sandbox.js';

const join = (...parts: string[]): string =>
  parts[0]?.startsWith('/') === true ? posix.join(...parts) : win32.join(...parts);

/** What `relay install` creates as the relay account's description: only that user is removed. */
export const RELAY_DESCRIPTION = 'Studio relay (SSH, forced command)';

/** The state of a Windows service as the install found it. */
export interface ServiceState {
  exists: boolean;
  start?: string;
  status?: string;
}

/** What the install recorded (src/relay-windows.ts, `recordSnippet`). */
export interface InstallRecord {
  relayUser?: string;
  crewPrefix?: string;
  task?: string;
  home?: string;
  readPaths: string[];
  spoolerDisabled: boolean;
  /** The machine before the first install; null when an earlier version installed without a record. */
  prior: {
    webClient?: ServiceState;
    spooler?: ServiceState;
    sshd?: ServiceState;
    sshdRule?: { exists: boolean; enabled?: string };
    sshdCapability?: { name: string; state: string } | null;
  } | null;
}

const START_TYPES = ['Automatic', 'Manual', 'Disabled'] as const;

const service = (x: unknown): ServiceState | undefined => {
  const s = x as { exists?: unknown; start?: unknown; status?: unknown } | null | undefined;
  if (s === null || typeof s !== 'object' || typeof s.exists !== 'boolean') return undefined;
  return {
    exists: s.exists,
    ...(typeof s.start === 'string' ? { start: s.start } : {}),
    ...(typeof s.status === 'string' ? { status: s.status } : {}),
  };
};

/** The install record of this admin-only tree; undefined when there is none or it cannot be read. */
export function readInstallRecord(machine: string): InstallRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(installRecordFile(machine), 'utf8').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  return parseInstallRecord(raw);
}

export function parseInstallRecord(raw: unknown): InstallRecord | undefined {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object' || r.version !== 1) return undefined;
  const str = (k: string) => (typeof r[k] === 'string' ? { [k]: r[k] as string } : {});
  const p = r.prior as Record<string, unknown> | null | undefined;
  let prior: InstallRecord['prior'] = null;
  if (p !== null && typeof p === 'object') {
    const rule = p.sshdRule as { exists?: unknown; enabled?: unknown } | undefined;
    const cap = p.sshdCapability as { name?: unknown; state?: unknown } | null | undefined;
    const webClient = service(p.webClient);
    const spooler = service(p.spooler);
    const sshd = service(p.sshd);
    prior = {
      ...(webClient === undefined ? {} : { webClient }),
      ...(spooler === undefined ? {} : { spooler }),
      ...(sshd === undefined ? {} : { sshd }),
      ...(rule !== undefined && typeof rule.exists === 'boolean'
        ? {
            sshdRule: {
              exists: rule.exists,
              ...(typeof rule.enabled === 'string' ? { enabled: rule.enabled } : {}),
            },
          }
        : {}),
      ...(cap !== undefined && cap !== null && typeof cap.name === 'string'
        ? { sshdCapability: { name: cap.name, state: String(cap.state) } }
        : {}),
    };
  }
  const paths = Array.isArray(r.readPaths)
    ? r.readPaths
    : r.readPaths === undefined
      ? []
      : [r.readPaths];
  return {
    ...str('relayUser'),
    ...str('crewPrefix'),
    ...str('task'),
    ...str('home'),
    readPaths: paths.filter((x): x is string => typeof x === 'string'),
    spoolerDisabled: r.spoolerDisabled === true,
    prior,
  };
}

/** A start type to restore: only one of the three a service may be set to, else none. */
const startType = (s: ServiceState | undefined): (typeof START_TYPES)[number] | undefined =>
  START_TYPES.find((t) => t === s?.start);

/**
 * The PowerShell that puts back the services and the OpenSSH rule as the record says they were,
 * and the lines that say what stays as it is. Nothing is turned on without a record of it.
 */
export function restoreSteps(record: InstallRecord | undefined): string {
  const prior = record?.prior ?? null;
  const out: string[] = [];
  const say = (line: string) => out.push(`Write-Output ${psQuote(line)}`);
  const restore = (name: string, s: ServiceState | undefined) => {
    const start = startType(s);
    if (s?.exists !== true || start === undefined || start === 'Disabled') {
      say(`left as it is: ${name} (it was not enabled before the install, or no record says so)`);
      return;
    }
    out.push(
      `if (Get-Service -Name ${psQuote(name)} -ErrorAction SilentlyContinue) {`,
      `  Set-Service -Name ${psQuote(name)} -StartupType ${start}`,
      ...(s.status === 'Running' ? [`  Start-Service -Name ${psQuote(name)}`] : []),
      `  Write-Output ${psQuote(`restored: ${name} (${start}${s.status === 'Running' ? ', running' : ''}, as before the install)`)}`,
      '}',
    );
  };
  restore('WebClient', prior?.webClient);
  if (record?.spoolerDisabled === true) restore('Spooler', prior?.spooler);
  // sshd: running before, it runs again with its own config; else it stops, and an OpenSSH server
  // the install added goes. Without a record it stops and stays off.
  const sshd = prior?.sshd;
  out.push('if (Get-Service -Name sshd -ErrorAction SilentlyContinue) {');
  if (prior !== null && sshd?.exists === true && sshd.status === 'Running') {
    out.push(
      `  Set-Service -Name sshd -StartupType ${startType(sshd) ?? 'Automatic'}`,
      '  Restart-Service -Name sshd',
      "  Write-Output 'restored: sshd runs as before the install, without Studio''s lines'",
    );
  } else {
    const start =
      prior !== null && sshd?.exists === true ? (startType(sshd) ?? 'Disabled') : 'Disabled';
    out.push(
      '  Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue',
      `  Set-Service -Name sshd -StartupType ${start}`,
      prior === null
        ? "  Write-Output 'stopped: sshd (no record says it ran before; to use it again: Set-Service sshd -StartupType Automatic; Start-Service sshd)'"
        : `  Write-Output 'stopped: sshd, start type ${start}, as before the install'`,
    );
  }
  out.push('}');
  const cap = prior?.sshdCapability;
  if (
    cap !== undefined &&
    cap !== null &&
    cap.state !== 'Installed' &&
    /^OpenSSH\.Server~[\w.~-]+$/.test(cap.name)
  ) {
    out.push(
      `if ((Get-WindowsCapability -Online -Name ${psQuote(cap.name)}).State -eq 'Installed') {`,
      `  Remove-WindowsCapability -Online -Name ${psQuote(cap.name)} | Out-Null`,
      "  Write-Output 'removed: the OpenSSH server the install added'",
      '}',
    );
  }
  if (prior?.sshdRule?.exists === true && prior.sshdRule.enabled === 'True') {
    out.push(
      "Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Enable-NetFirewallRule",
      "Write-Output 'restored: the firewall rule OpenSSH-Server-In-TCP is on, as before the install'",
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * C# for the logon rights of a SID, through LSA: `RemoveAll` takes every right it holds away
 * (none held is fine), `Count` says how many it holds.
 */
export const LSA_RIGHTS = String.raw`using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class StudioLsa {
  [StructLayout(LayoutKind.Sequential)]
  struct Attributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes_; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attributes, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool all, IntPtr rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out uint count);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr buffer);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  const uint NotFound = 0xC0000034;
  static IntPtr Open() {
    var a = new Attributes();
    a.Length = Marshal.SizeOf(a);
    IntPtr h;
    uint st = LsaOpenPolicy(IntPtr.Zero, ref a, 0x000F0FFF, out h);
    if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
    return h;
  }
  static byte[] Bytes(string sid) {
    var s = new SecurityIdentifier(sid);
    var b = new byte[s.BinaryLength];
    s.GetBinaryForm(b, 0);
    return b;
  }
  public static void RemoveAll(string sid) {
    IntPtr h = Open();
    try {
      uint st = LsaRemoveAccountRights(h, Bytes(sid), true, IntPtr.Zero, 0);
      if (st != 0 && st != NotFound) throw new Win32Exception(LsaNtStatusToWinError(st));
    } finally { LsaClose(h); }
  }
  public static int Count(string sid) {
    IntPtr h = Open();
    try {
      IntPtr rights;
      uint count;
      uint st = LsaEnumerateAccountRights(h, Bytes(sid), out rights, out count);
      if (st == NotFound) return 0;
      if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
      LsaFreeMemory(rights);
      return (int)count;
    } finally { LsaClose(h); }
  }
}
`;

export interface UninstallOptions {
  relayUser: string;
  crewPrefix: string;
  task: string;
  home: string;
  machine: string;
  readPaths: readonly string[];
  /** Keep the admin-only tree and the relay home (keys, pairings and the credential still go). */
  keepTree: boolean;
  forceStop: boolean;
  record: InstallRecord | undefined;
  /** The tree deleter when the admin-only copy is gone already: the running Studio's own. */
  treeSource: string;
  /** sshd_config; the one of the OpenSSH server by default (tests give another). */
  sshdConfig?: string;
}

/** How many steps the uninstall shows; each prints `[n/STEPS]`. */
export const UNINSTALL_STEPS = 9;

/**
 * The script of `studio relay uninstall`, for an elevated PowerShell. Each step runs only when the
 * one before it held; a step that fails stops the script with its reason, and running it again
 * goes on from there.
 */
export function relayUninstallScript(o: UninstallOptions): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(o.relayUser)) {
    throw new Error(`not a local user name: ${o.relayUser}`);
  }
  if (!CREW_PREFIX_RE.test(o.crewPrefix))
    throw new Error(`not a crew user prefix: ${o.crewPrefix}`);
  if (!/^[A-Za-z0-9 _-]{1,64}$/.test(o.task)) throw new Error(`not a task name: ${o.task}`);
  const tasks = Object.values(brokerTasks(o.task));
  const step = (n: number, what: string) =>
    `Write-Output ${psQuote(`[${n}/${UNINSTALL_STEPS}] ${what}`)}`;
  const conf =
    o.sshdConfig === undefined
      ? "Join-Path $env:ProgramData 'ssh\\sshd_config'"
      : psQuote(o.sshdConfig);
  const adminCopy = join(machineStudio(o.machine), 'bin', 'studio-tree.cs');
  return `#Requires -RunAsAdministrator
# Studio: uninstall this Windows relay worker (studio relay uninstall). Run it in an elevated
# Windows PowerShell. Run it again when it stops: every step finds what is gone and goes on.
$ErrorActionPreference = 'Stop'
$relay = ${psQuote(o.relayUser)}
$home_ = ${psQuote(o.home)}
$machine = ${psQuote(o.machine)}
$readPaths = @(${o.readPaths.map(psQuote).join(', ')})
${crewAccountFunctions(o.crewPrefix, { treeSource: adminCopy })}# The tree deleter from the admin-only copy, or once that is gone, from the Studio running this.
if (-not (Test-Path -LiteralPath $treeSource)) { $treeSource = ${psQuote(o.treeSource)} }
${relayJobFunctions({ relayUser: o.relayUser, crewPrefix: o.crewPrefix, forceStop: o.forceStop, what: 'uninstall' })}
${step(1, 'leads: every key and pairing goes, so no lead can log in')}
foreach ($f in @(${psQuote(authorizedKeysFile(o.machine))}, ${psQuote(join(o.machine, 'pairing', 'pairings.json'))})) {
  if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Output "removed: $f" }
}
${step(2, 'jobs: none may run while the rest goes')}
NoRelayJob
${step(3, 'broker tasks')}
foreach ($t in @(${tasks.map(psQuote).join(', ')})) {
  if (Get-ScheduledTask -TaskName $t -TaskPath '\\' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $t -TaskPath '\\' -Confirm:$false
    Write-Output "removed: broker task $t"
  }
}
Remove-Item -LiteralPath ${psQuote(machineCredFile(o.machine))} -Force -ErrorAction SilentlyContinue
${step(4, 'crew users: retired as after every job')}
$group = Get-LocalGroup -Name ($prefix + 's') -ErrorAction SilentlyContinue
if ($null -ne $group -and $group.Description -ne $groupDescription) { throw "the group $($group.Name) is not Studio's: remove it by hand, or give the prefix of Studio's group with the worker config" }
for ($i = 0; $i -lt 5 -and @(JobUsers).Count -gt 0; $i++) { $retired = RetireJobUsers }
$left = @(JobUsers)
if ($left.Count -gt 0) { throw "crew users are left ($(@($left | ForEach-Object { $_.Name }) -join ', ')): $(@($retired.problems) -join '; '); run studio relay uninstall --force-stop" }
${step(5, "the crew users' group, its firewall rule, logon rights and read grants")}
if ($null -ne $group) {
  $groupSid = $group.SID.Value
  Get-NetFirewallRule -DisplayName ('Studio crews ' + $group.Name + ': no direct network') -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  # Every logon right the group holds (Studio gave it only the denied ones), straight through LSA:
  # secedit's export fails on some machines with an extended error.
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(LSA_RIGHTS, 'utf8').toString('base64')}')))
  [StudioLsa]::RemoveAll($groupSid)
  foreach ($p in $readPaths) {
    if (Test-Path -LiteralPath $p) { icacls $p /remove:g "*$groupSid" /L /Q | Out-Null }
  }
  Remove-LocalGroup -SID $group.SID
  Write-Output "removed: the group $($group.Name)"
}
${step(6, 'the relay account and its profile')}
$account = Get-LocalUser -Name $relay -ErrorAction SilentlyContinue
if ($null -ne $account -and $account.Description -ne ${psQuote(RELAY_DESCRIPTION)}) {
  Write-Output "left as it is: the user $relay, which Studio did not make (its description is not Studio's)"
} elseif ($null -ne $account) {
  LoadTree
  LockJobUser $account
  foreach ($p in @(Owned @($account.SID.Value) | Where-Object { -not $_.Unreadable })) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  $still = @(Owned @($account.SID.Value) | Where-Object { -not $_.Unreadable })
  if ($still.Count -gt 0) { throw "processes of $relay still run ($(@($still | ForEach-Object { "$($_.Id) $($_.Name)" }) -join ', ')): run studio relay uninstall --force-stop" }
  QuarantineProfile $account (Join-Path (Quarantine) 'trees')
  Remove-LocalUser -SID $account.SID
  Write-Output "removed: the relay account $relay and its profile"
}
# The quarantine of retired profiles: emptied, and removed once no group of Studio's crews is left.
$q = Join-Path (ProfileRoot) 'Studio crew quarantine'
if (Test-Path -LiteralPath $q) {
  LoadTree
  $trees = Join-Path $q 'trees'
  if (Test-Path -LiteralPath $trees) { for ($i = 0; $i -lt 200; $i++) { if (([StudioTree]::Prune($trees, $pruneBudget, $true, $null)).Done) { break } } }
  $waiting = @(Get-ChildItem -LiteralPath $trees -Force -ErrorAction SilentlyContinue).Count
  $others = @(Get-LocalGroup | Where-Object { $_.Description -eq $groupDescription }).Count
  if ($waiting -eq 0 -and $others -eq 0) { [StudioTree]::Remove($q, $null); Write-Output "removed: $q" }
  else { Write-Output "left: $q ($waiting profile(s) waiting, $others other group(s) of Studio's crews)" }
}
${step(7, "Studio's lines in sshd_config and its firewall rules")}
$conf = ${conf}
if (Test-Path -LiteralPath $conf) {
  $before = [IO.File]::ReadAllBytes($conf)
  $text = [Text.Encoding]::UTF8.GetString($before)
  $text = [regex]::Replace($text, '(?s)# studio relay begin global.*?# studio relay end global\\r?\\n?', '')
  $text = [regex]::Replace($text, '(?s)\\r?\\n?# studio relay begin\\r?\\n.*?# studio relay end\\r?\\n?', [Environment]::NewLine)
  if ($text -ne [Text.Encoding]::UTF8.GetString($before)) {
    [IO.File]::WriteAllText($conf, $text.TrimEnd() + [Environment]::NewLine, (New-Object Text.UTF8Encoding $false))
    $exe = Join-Path $env:SystemRoot 'System32\\OpenSSH\\sshd.exe'
    # sshd checks a config only with its host keys; without them it never ran with this one.
    if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath (Join-Path $env:ProgramData 'ssh\\ssh_host_ed25519_key'))) {
      $tested = Start-Process -FilePath $exe -ArgumentList @('-t', '-f', ('"' + $conf + '"')) -Wait -PassThru -NoNewWindow
      if ($tested.ExitCode -ne 0) { [IO.File]::WriteAllBytes($conf, $before); throw "sshd does not accept $conf without Studio's lines; it was put back as it was" }
    }
    Write-Output "removed: Studio's lines in $conf"
  }
}
Get-NetFirewallRule -DisplayName 'Studio relay: sshd' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
${step(8, o.keepTree ? 'the admin-only tree and the relay home stay (--keep-tree)' : 'the admin-only tree and the relay home')}
${
  o.keepTree
    ? ''
    : `foreach ($p in @($home_, $machine)) {
  $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { continue }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $item.Delete() } else { LoadTree; [StudioTree]::Remove($p, $null) }
  Write-Output "removed: $p"
  $up = Split-Path -Parent $p
  if ((Test-Path -LiteralPath $up) -and @(Get-ChildItem -LiteralPath $up -Force).Count -eq 0) { Remove-Item -LiteralPath $up -Force; Write-Output "removed: $up" }
}
`
}${step(9, 'services Studio changed')}
${restoreSteps(o.record)}Write-Output 'done: Studio relay worker uninstalled'
`;
}
