// One local standard user per crew job on native Windows (src/windows-sandbox.ts). The setup makes
// a group of Studio's once, which carries what every crew user must have: the outbound firewall rule
// (nothing but loopback), the denied logons (no batch job, service, network or remote desktop) and
// the read grants on Node.js, Studio, Claude Code and the toolchains. Before a job, a fresh user is
// made and put in that group, its password sealed for this machine (LocalMachine DPAPI) in a file
// only SYSTEM, administrators and the account Studio runs as may read; after the job, its processes
// are ended and the user and its profile are deleted. Nothing a crew leaves in its profile reaches a
// later job, which runs as another user with a profile of its own.
//
// Making and deleting users needs an administrator. A native worker runs elevated and runs these
// scripts itself; a relay worker's account is a standard user and asks its broker tasks, which run
// them as SYSTEM (src/relay-windows.ts).
import { dirname, join } from 'node:path';
import { CREW_HOST_BIN, OUTSIDE, powershellEnv, psQuote, type RunFile } from './windows-sandbox.js';

/** The tree deleter (bin/studio-tree.cs) beside the crew host. */
export const TREE_SOURCE = (): string => join(dirname(CREW_HOST_BIN), 'studio-tree.cs');

/**
 * The name prefix of the crew users: letters, digits, `_` and `-`, at most 13 characters, so that
 * `<prefix>-<6 hex>` is a local user name of at most 20.
 */
export const CREW_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_-]{0,12}$/;

/** The description that marks a user as a crew user of Studio's: only those are ever deleted. */
export const CREW_DESCRIPTION = 'Studio crew (one job)';
export const GROUP_DESCRIPTION = 'Studio crews: one local user per job';

/** The group of the crew users: the prefix and an `s`. */
export const crewGroupName = (prefix: string): string => `${prefix}s`;

/** The user one job runs as. `at`: when it was made, by the clock of this machine. */
export interface CrewAccount {
  user: string;
  sid: string;
  at: string;
}

/** What makes and deletes the crew users: the worker itself, elevated, or the broker tasks. */
export interface CrewAccounts {
  /** The sealed password of the current crew user. */
  credFile: string;
  /** Ends every process of every crew user; refuses when one is left or they cannot be listed. */
  sweep(): Promise<void>;
  /** Ends their processes, then deletes every crew user and its profile. */
  retire(): Promise<void>;
  /** Retires every crew user, then makes a new one and seals its password. */
  fresh(): Promise<CrewAccount>;
  /** Whether a crew user of this SID still exists. */
  exists(sid: string): Promise<boolean>;
}

const prefixOf = (prefix: string): string => {
  if (!CREW_PREFIX_RE.test(prefix)) {
    throw new Error(`not a crew user prefix (at most 13 characters): ${prefix}`);
  }
  return prefix;
};

/**
 * The PowerShell functions that find, end, delete and make crew users. Only a local user whose name
 * is `<prefix>-<6 hex>` and whose description is Studio's counts as one. A profile is deleted only
 * after every reparse point in it is removed as a link, never followed, and only when it is a folder
 * right below the profiles folder of this machine.
 */
export const crewAccountFunctions = (prefix: string, treeSource: string = TREE_SOURCE()): string =>
  `$prefix = ${psQuote(prefixOf(prefix))}
$treeSource = ${psQuote(treeSource)}
$crewDescription = ${psQuote(CREW_DESCRIPTION)}
$groupDescription = ${psQuote(GROUP_DESCRIPTION)}
${CREW_ACCOUNT_BODY}`;

const CREW_ACCOUNT_BODY = String.raw`function CrewGroup {
  $g = Get-LocalGroup -Name ($prefix + 's') -ErrorAction SilentlyContinue
  if ($null -eq $g) { throw "there is no group $($prefix)s: run the setup script of Studio again, elevated" }
  if ($g.Description -ne $groupDescription) { throw "the group $($g.Name) is not Studio's" }
  $g
}
function JobUsers {
  $re = '^' + [regex]::Escape($prefix) + '-[0-9a-f]{6}$'
  # Every member of Studio's group must be one of them: anything else there refuses.
  $g = Get-LocalGroup -Name ($prefix + 's') -ErrorAction SilentlyContinue
  if ($null -ne $g) {
    foreach ($m in @(Get-LocalGroupMember -Group $g)) {
      $mu = if ($m.ObjectClass -eq 'User') { Get-LocalUser -SID $m.SID -ErrorAction SilentlyContinue } else { $null }
      if ($null -eq $mu -or $mu.Name -notmatch $re -or $mu.Description -ne $crewDescription) {
        throw "the group $($g.Name) holds $($m.Name), which is not a crew user of Studio's: remove it from the group"
      }
    }
  }
  @(Get-LocalUser | Where-Object { $_.Name -match $re -and $_.Description -eq $crewDescription })
}
function OwnedBy([string[]]$sids) {
  @(Get-CimInstance Win32_Process | Where-Object { try { $sids -contains (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid } catch { $false } })
}
function SweepJobUsers {
  $sids = @(JobUsers | ForEach-Object { $_.SID.Value })
  if ($sids.Count -eq 0) { return @{ found = 0; left = @() } }
  $found = OwnedBy $sids
  foreach ($p in $found) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($found.Count -gt 0) { Start-Sleep -Milliseconds 800 }
  @{ found = $found.Count; left = @(OwnedBy $sids | ForEach-Object { [int]$_.ProcessId }) }
}
function NoneLeft {
  $s = SweepJobUsers
  if ($s.left.Count -gt 0) { throw "processes of the crew users are still running ($($s.left -join ', ')) and cannot be ended" }
}
# A tree deleted as administrators or SYSTEM, never following a link and whatever its DACLs say
# (bin/studio-tree.cs: backup and restore semantics, long paths).
function RemoveTree([string]$root, $afterList) {
  if (-not ('StudioTree' -as [type])) { Add-Type -Path $treeSource }
  [StudioTree]::Remove($root, $afterList)
}
function ProfileRoot {
  $list = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
  [Environment]::ExpandEnvironmentVariables($list.ProfilesDirectory).TrimEnd('\')
}
# No logon as a crew user any more: disabled, with a new password nobody ever learns. What could
# start one of its processes (the relay account, which could unseal the old password) cannot.
function LockJobUser($u) {
  Disable-LocalUser -SID $u.SID
  Set-LocalUser -SID $u.SID -Password (ConvertTo-SecureString (NewSecret) -AsPlainText -Force)
}
function RemoveJobUser($u) {
  $sid = $u.SID.Value
  $prof = $null
  for ($i = 0; $i -lt 60; $i++) {
    $prof = Get-CimInstance Win32_UserProfile -Filter ("SID='" + $sid + "'")
    if ($null -eq $prof -or -not $prof.Loaded) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($null -ne $prof) {
    if ($prof.Loaded) { throw "the profile of $($u.Name) is still loaded" }
    $path = [string]$prof.LocalPath
    $root = ProfileRoot
    $rest = if ($path.Length -gt $root.Length + 1) { $path.Substring($root.Length + 1) } else { '' }
    if (-not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $rest -eq '' -or $rest.Contains('\')) {
      throw "the profile of $($u.Name) is at $path, not a folder right below $root"
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "the profile of $($u.Name) at $path is a reparse point" }
    # Studio deletes the folder itself, never following a link, before Windows forgets the profile.
    RemoveTree $path $null
    NoneLeft
    try { Remove-CimInstance -InputObject $prof } catch { }
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid
    if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
    RemoveTree $path $null
  }
  Remove-LocalUser -SID $sid
}
function RetireJobUsers {
  $users = JobUsers
  foreach ($u in $users) { LockJobUser $u }
  NoneLeft
  $gone = @()
  foreach ($u in $users) { RemoveJobUser $u; $gone += $u.Name }
  $gone
}
function NewSecret { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) + 'aA1!' }
# The password, sealed for this machine, in a file only SYSTEM, administrators and the reader read:
# written beside the target with its final ACL, then swapped in.
function SealFor([string]$file, [string]$plain, [string]$reader) {
  Add-Type -AssemblyName System.Security
  $sealed = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  $tmp = Join-Path (Split-Path -Parent $file) ('.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllBytes($tmp, $sealed)
  icacls $tmp /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($reader):R" /L /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $tmp -Force; throw "cannot set the ACL of $file" }
  if (Test-Path -LiteralPath $file) { [IO.File]::Replace($tmp, $file, [NullString]::Value) } else { [IO.File]::Move($tmp, $file) }
  # Replace keeps the DACL of the file it replaced: the intended one goes on again.
  icacls $file /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($reader):R" /L /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "cannot set the ACL of $file" }
  icacls $file /setowner '*S-1-5-32-544' /L /Q | Out-Null
}
function NewJobUser([string]$credFile, [string]$reader) {
  $g = CrewGroup
  $b = New-Object byte[] 3
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $name = $prefix + '-' + (($b | ForEach-Object { $_.ToString('x2') }) -join '')
  $plain = NewSecret
  $u = New-LocalUser -Name $name -Password (ConvertTo-SecureString $plain -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description $crewDescription
  try {
    # Users and Studio's group only, never Administrators (groups by SID: names depend on the language).
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    if (-not (Get-LocalGroupMember -Group $users | Where-Object { $_.SID -eq $u.SID })) { Add-LocalGroupMember -Group $users -Member $u }
    Add-LocalGroupMember -Group $g -Member $u
    if (Get-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-544') | Where-Object { $_.SID -eq $u.SID }) { throw "$name is an administrator" }
    SealFor $credFile $plain $reader
  } catch {
    Remove-LocalUser -SID $u.SID
    throw
  }
  $plain = $null
  @{ user = $name; sid = $u.SID.Value }
}
`;

export type CrewAccountOp = 'sweep' | 'retire' | 'fresh';

/** Where a broker script names the relay account's SID, filled in by the setup. */
export const RELAY_SID_SLOT = '__STUDIO_RELAY_SID__';

/**
 * One operation on the crew users as one script, with its answer as JSON: to `result` (the broker,
 * as SYSTEM) or to stdout. `at` is when it began; an error is an answer too.
 */
export function crewAccountScript(o: {
  op: CrewAccountOp;
  prefix: string;
  /** fresh: where the sealed password goes, and the SID that may read it. */
  credFile?: string;
  reader?: string;
  result?: string;
  /** The tree deleter to load (bin/studio-tree.cs): the admin-only copy on a relay worker. */
  treeSource?: string;
}): string {
  if (o.op === 'fresh' && (o.credFile === undefined || o.reader === undefined)) {
    throw new Error('a fresh crew user needs a credential file and its reader');
  }
  if (o.reader !== undefined && o.reader !== '$relaySid' && !/^S-1-\d+(-\d+)+$/.test(o.reader)) {
    throw new Error(`not a SID: ${o.reader}`);
  }
  // A broker's reader is the relay account, whose SID the setup puts in when it registers the task.
  const reader = o.reader === '$relaySid' ? `'${RELAY_SID_SLOT}'` : psQuote(o.reader ?? '');
  const body =
    o.op === 'sweep'
      ? '  $s = SweepJobUsers\n  $out.found = $s.found\n  $out.left = $s.left'
      : o.op === 'retire'
        ? '  $out.removed = @(RetireJobUsers)\n  $out.left = @()'
        : `  $out.removed = @(RetireJobUsers)\n  $n = NewJobUser ${psQuote(o.credFile ?? '')} ${reader}\n  $out.user = $n.user\n  $out.sid = $n.sid`;
  const write =
    o.result === undefined
      ? '[Console]::Out.Write((ConvertTo-Json -Compress $out))'
      : `Set-Content -LiteralPath ${psQuote(o.result)} -Value (ConvertTo-Json -Compress $out) -Encoding UTF8`;
  return `$ErrorActionPreference = 'Stop'
$out = @{ op = ${psQuote(o.op)}; at = (Get-Date).ToUniversalTime().ToString('o') }
try {
${crewAccountFunctions(o.prefix, o.treeSource ?? TREE_SOURCE())}
${body}
} catch {
  $out.error = $_.Exception.Message
}
${write}
`;
}

/** An answer of a crew account script: undefined when it has not the shape it must have. */
export function judgeCrewAnswer(
  op: CrewAccountOp,
  answer: unknown,
): { error: string } | { left: number[] } | { account: CrewAccount } | undefined {
  const a = answer as {
    op?: unknown;
    at?: unknown;
    error?: unknown;
    left?: unknown;
    user?: unknown;
    sid?: unknown;
  } | null;
  if (a === null || typeof a !== 'object' || a.op !== op || typeof a.at !== 'string') {
    return undefined;
  }
  if (typeof a.error === 'string') return { error: a.error.slice(0, 300) };
  if (op === 'fresh') {
    if (
      typeof a.user !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,12}-[0-9a-f]{6}$/.test(a.user) ||
      typeof a.sid !== 'string' ||
      !/^S-1-5-21(-\d+)+$/.test(a.sid)
    ) {
      return undefined;
    }
    return { account: { user: a.user, sid: a.sid, at: a.at } };
  }
  // Windows PowerShell writes a one-element array as its element.
  const left = Array.isArray(a.left) ? a.left : typeof a.left === 'number' ? [a.left] : undefined;
  if (left === undefined || !left.every((n) => Number.isInteger(n))) return undefined;
  return { left: left as number[] };
}

/** Throws the refusal of an answer; returns the account of a fresh one. */
function settle(op: CrewAccountOp, raw: unknown, where: string): CrewAccount | undefined {
  const j = judgeCrewAnswer(op, raw);
  if (j === undefined) throw new Error(`${where} answered in an unknown shape`);
  if ('error' in j) throw new Error(`${where} could not ${op} the crew users: ${j.error}`);
  if ('left' in j && j.left.length > 0) {
    throw new Error(
      `processes of the crew users are still running (${j.left.join(', ')}) and ${where} cannot end them`,
    );
  }
  return 'account' in j ? j.account : undefined;
}

/** Whether a crew user of this SID exists, asked as any account may. */
export async function crewUserExists(run: RunFile, sid: string): Promise<boolean> {
  if (!/^S-1-5-21(-\d+)+$/.test(sid)) return false;
  const r = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::Out.Write($null -ne (Get-LocalUser -SID ${psQuote(sid)} -ErrorAction SilentlyContinue))`,
    ],
    { env: powershellEnv(process.env), timeoutMs: 60_000 },
  );
  return r.code === 0 && r.stdout.trim() === 'True';
}

/**
 * The crew users of a native worker, which runs elevated: it runs the scripts itself. Without an
 * elevated token it could neither see every process of a crew user nor make one: that refuses.
 */
export function localCrewAccounts(o: {
  prefix: string;
  credFile: string;
  run: RunFile;
  /** The SID of the account Studio runs as (`S-1-...`), which reads the sealed password. */
  reader: () => Promise<string>;
}): CrewAccounts {
  const call = async (op: CrewAccountOp): Promise<CrewAccount | undefined> => {
    const script = crewAccountScript({
      op,
      prefix: o.prefix,
      ...(op === 'fresh' ? { credFile: o.credFile, reader: await o.reader() } : {}),
    });
    const elevated =
      'if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { [Console]::Out.Write(\'{"notElevated":true}\'); exit 0 }\n';
    const r = await o.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', elevated + script],
      { env: powershellEnv(process.env), timeoutMs: 300_000 },
    );
    let raw: unknown;
    try {
      raw = JSON.parse(r.stdout.trim());
    } catch {
      raw = undefined;
    }
    if ((raw as { notElevated?: unknown } | undefined)?.notElevated === true) {
      throw new Error(
        'the worker does not run elevated, so it can neither see every process of a crew user nor make one: run studio worker in an elevated PowerShell (as administrator)',
      );
    }
    return settle(op, raw, 'this worker');
  };
  return {
    credFile: o.credFile,
    sweep: async () => {
      await call('sweep');
    },
    retire: async () => {
      await call('retire');
    },
    fresh: async () => (await call('fresh')) as CrewAccount,
    exists: (sid) => crewUserExists(o.run, sid),
  };
}

/**
 * The crew users of a relay worker, through its broker tasks (SYSTEM): each operation is a task of
 * its own with its script in the action, started by the relay account, answering in a file of the
 * admin-only tree. Only an answer written after the start counts.
 */
export function brokerCrewAccounts(o: {
  run: RunFile;
  /** The task of each operation. */
  tasks: Record<CrewAccountOp, string>;
  /** The answer file of each operation. */
  results: Record<CrewAccountOp, string>;
  credFile: string;
  readFile: (file: string) => string | undefined;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  waitMs?: number;
}): CrewAccounts {
  const call = async (op: CrewAccountOp): Promise<CrewAccount | undefined> => {
    const started = o.now().getTime();
    const task = o.tasks[op];
    const r = await o.run('schtasks.exe', ['/Run', '/TN', task]);
    if (r.code !== 0) {
      throw new Error(
        `cannot start the broker task ${task} (schtasks exit ${r.code}); run studio relay install again, elevated`,
      );
    }
    const until = started + (o.waitMs ?? (op === 'sweep' ? 60_000 : 300_000));
    for (;;) {
      const text = o.readFile(o.results[op])?.replace(/^﻿/, '');
      let raw: { at?: unknown } | undefined;
      try {
        raw = text === undefined ? undefined : (JSON.parse(text) as typeof raw);
      } catch {
        raw = undefined;
      }
      const at = typeof raw?.at === 'string' ? Date.parse(raw.at) : Number.NaN;
      // Its own clock and this one are the same machine's; a second of slack for rounding.
      if (raw !== undefined && at >= started - 1000) return settle(op, raw, 'the broker');
      if (o.now().getTime() >= until) throw new Error(`the broker task ${task} did not answer`);
      await o.sleep(500);
    }
  };
  return {
    credFile: o.credFile,
    sweep: async () => {
      await call('sweep');
    },
    retire: async () => {
      await call('retire');
    },
    fresh: async () => (await call('fresh')) as CrewAccount,
    exists: (sid) => crewUserExists(o.run, sid),
  };
}

/**
 * The part of a setup that makes Studio's group of crew users and what it carries: the outbound
 * firewall rule (nothing but loopback), the denied logons, and the read grants on `$readPaths`
 * (set before). It takes away the one shared crew user of earlier versions (named the prefix, with
 * Studio's old description), with its processes, its profile and its firewall rule. Sets
 * `$groupSid`. Runs elevated, after `crewAccountFunctions`.
 */
export const crewGroupSetup =
  (): string => `# Studio's group of crew users: every crew user is made in it for one job and deleted after.
$group = Get-LocalGroup -Name ($prefix + 's') -ErrorAction SilentlyContinue
if ($null -eq $group) { $group = New-LocalGroup -Name ($prefix + 's') -Description $groupDescription }
elseif ($group.Description -ne $groupDescription) { throw "a group $($group.Name) exists and is not Studio's: remove it or choose another crew_user prefix" }
$groupSid = $group.SID.Value
# The shared crew user of earlier versions goes, with what it left.
$old = Get-LocalUser -Name $prefix -ErrorAction SilentlyContinue
if ($null -ne $old -and $old.Description -eq 'Studio crew sandbox') {
  LockJobUser $old
  $left = @(OwnedBy @($old.SID.Value))
  foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  RemoveJobUser $old
  Get-NetFirewallRule -DisplayName ('Studio crew ' + $prefix + ': no direct network') -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Output "Removed the shared crew user $prefix of an earlier version."
}
# Crew users left by a crash go now.
$null = RetireJobUsers
# No direct network for any crew user: every outbound connection to anything but loopback.
$rule = 'Studio crews ' + $group.Name + ': no direct network'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;$groupSid)" -RemoteAddress @(${OUTSIDE.map(psQuote).join(', ')}) | Out-Null
# Crew users log on only through Studio's keeper: no batch job, service, network or remote desktop.
$cfg = Join-Path $env:TEMP ('studio-rights-' + [Guid]::NewGuid().ToString('N') + '.inf')
$db = [IO.Path]::ChangeExtension($cfg, '.sdb')
secedit /export /cfg $cfg /areas USER_RIGHTS | Out-Null
$lines = [Collections.Generic.List[string]](Get-Content -LiteralPath $cfg)
$at = $lines.IndexOf('[Privilege Rights]')
if ($at -lt 0) { throw 'secedit gave no [Privilege Rights] section' }
foreach ($right in @('SeDenyBatchLogonRight', 'SeDenyServiceLogonRight', 'SeDenyNetworkLogonRight', 'SeDenyRemoteInteractiveLogonRight')) {
  $i = -1
  for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k] -like "$right *") { $i = $k } }
  if ($i -lt 0) { $lines.Insert($at + 1, "$right = *$groupSid") }
  elseif ($lines[$i] -notlike "**$groupSid*") { $lines[$i] = $lines[$i] + ",*$groupSid" }
}
Set-Content -LiteralPath $cfg -Value $lines -Encoding Unicode
secedit /configure /db $db /cfg $cfg /areas USER_RIGHTS /quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw "secedit could not set the logon rights ($LASTEXITCODE)" }
Remove-Item -LiteralPath $cfg, $db -ErrorAction SilentlyContinue
# Read, never write, for the crew users on Claude Code and the toolchains.
foreach ($p in $readPaths) {
  if (Test-Path -LiteralPath $p) { icacls $p /grant "*$($groupSid):(OI)(CI)RX" /L /Q | Out-Null }
}
`;

/**
 * PowerShell of a setup that refuses Git for Windows older than 2.35.2: older versions read a
 * `.git` another user planted above a folder (CVE-2022-24765), and crews of other users work on
 * this machine.
 */
export const GIT_MIN_CHECK = String.raw`$gitCmd = Get-Command git -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $gitCmd) { throw 'Git for Windows is not installed: install 2.35.2 or later (winget install --id Git.Git)' }
$gitVersion = [string](& $gitCmd.Source --version)
if ($gitVersion -notmatch '(\d+)\.(\d+)\.(\d+)') { throw "cannot read the version of Git: $gitVersion" }
if ([version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]) -lt [version]'2.35.2') { throw "Git $($Matches[0]) is older than 2.35.2: update Git for Windows (winget upgrade --id Git.Git)" }
Write-Output "ok: Git $($Matches[0])"
`;
