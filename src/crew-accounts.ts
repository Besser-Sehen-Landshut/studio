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
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CREW_HOST_BIN, OUTSIDE, powershellEnv, psQuote, type RunFile } from './windows-sandbox.js';

/** Entries of the quarantine deleted per retire: bounded time, a huge tree goes over several. */
export const PRUNE_BUDGET = 20_000;

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
  /** What the run that made it reported about the users it retired and the quarantine. */
  notes?: CrewNotes;
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
export const crewAccountFunctions = (prefix: string, o: CrewScriptPlaces): string =>
  `# Only the machine's PATH: a folder of the user's PATH is writable without elevation.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$prefix = ${psQuote(prefixOf(prefix))}
$treeSource = ${psQuote(o.treeSource)}
$treeTemp = ${psQuote(o.treeTemp ?? '')}
$pruneBudget = ${Math.max(1, Math.trunc(o.pruneBudget ?? PRUNE_BUDGET))}
$crewDescription = ${psQuote(CREW_DESCRIPTION)}
$groupDescription = ${psQuote(GROUP_DESCRIPTION)}
${o.bodyFile === undefined ? CREW_ACCOUNT_BODY : bodyLoader(o.bodyFile)}`;

/** Where the scripts find what they load, and how much of the quarantine a run deletes. */
export interface CrewScriptPlaces {
  /** The tree deleter to compile (bin/studio-tree.cs): always a copy in an admin-only folder. */
  treeSource: string;
  /** An admin-only folder for the compiler's temporary files (SYSTEM's own TEMP is shared). */
  treeTemp?: string;
  /** Entries of the quarantine deleted in a run. */
  pruneBudget?: number;
  /**
   * A broker: the functions come from this file of the admin-only tree (the setup writes
   * `CREW_ACCOUNT_BODY` there), checked against its SHA-256 before they run, so the task's action
   * stays short.
   */
  bodyFile?: string;
}

/** The SHA-256 of the functions as the setup writes them (UTF-8, no BOM), in upper-case hex. */
export const CREW_ACCOUNT_BODY_SHA256 = (): string =>
  createHash('sha256').update(CREW_ACCOUNT_BODY, 'utf8').digest('hex').toUpperCase();

/** PowerShell that reads the functions once, checks their hash, and runs exactly those bytes. */
const bodyLoader = (file: string): string => `$bodyBytes = [IO.File]::ReadAllBytes(${psQuote(file)})
$bodyHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bodyBytes)).Replace('-', '')
if ($bodyHash -ne '${CREW_ACCOUNT_BODY_SHA256()}') { throw "the functions in ${file.replace(/"/g, '')} are not the ones this task was made with (SHA-256 $bodyHash): run studio relay install again, elevated" }
. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bodyBytes)))
`;

/** The functions of the crew users, without the variables they read. */
export const CREW_ACCOUNT_BODY = String.raw`function CrewGroup {
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
# The processes of these SIDs, each with its owner. A process whose owner cannot be read could be a
# crew user's: it is listed as such (Unreadable), never left out. The minimal processes of the
# kernel (pid 0 and 4, and those pid 4 started) have no owner to read.
function Owned([string[]]$sids) {
  LoadTree
  [StudioTree]::Debug()
  @(Get-CimInstance Win32_Process | ForEach-Object {
    $id = [int]$_.ProcessId
    $o = [StudioTree]::OwnerOf($id)
    if ($null -eq $o) {
      if (@(0, 4) -notcontains $id -and [int]$_.ParentProcessId -ne 4) { [pscustomobject]@{ Id = $id; Sid = ''; Name = [string]$_.Name; Unreadable = $true } }
    } elseif ($sids -contains $o) {
      [pscustomobject]@{ Id = $id; Sid = $o; Name = [string]$_.Name; Unreadable = $false }
    }
  })
}
# The SIDs of deleted crew users whose processes were not yet seen gone (in the quarantine folder,
# admin-only): every sweep looks for them too.
function RetiredFile { Join-Path (Quarantine) 'retired-sids.txt' }
function ReadRetired {
  $f = RetiredFile
  if (-not (Test-Path -LiteralPath $f)) { return @() }
  @(Get-Content -LiteralPath $f | Where-Object { $_ -match '^S-1-5-21(-\d+)+$' })
}
function WriteRetired([string[]]$sids) { Set-Content -LiteralPath (RetiredFile) -Value @($sids) -Encoding ASCII }
# Ends every process of the crew users and of the retired SIDs; says which are left, and whose.
function SweepJobUsers {
  $retired = @(ReadRetired)
  $sids = @(@(JobUsers | ForEach-Object { $_.SID.Value }) + $retired | Select-Object -Unique)
  if ($sids.Count -eq 0) { return @{ found = 0; left = @(); leftSids = @(); leftNames = @() } }
  $found = @(Owned $sids | Where-Object { -not $_.Unreadable })
  foreach ($p in $found) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  if ($found.Count -gt 0) { Start-Sleep -Milliseconds 800 }
  $after = @(Owned $sids)
  # A process of an owner that cannot be read may be any crew user's: it holds them all.
  $leftSids = if (@($after | Where-Object { $_.Unreadable }).Count -gt 0) { $sids } else { @($after | ForEach-Object { $_.Sid } | Select-Object -Unique) }
  # A retired SID with nothing left needs no more watching: no logon can start one again.
  $keep = @($retired | Where-Object { $leftSids -contains $_ })
  if ($keep.Count -ne $retired.Count) { WriteRetired $keep }
  @{ found = $found.Count; left = @($after | ForEach-Object { $_.Id }); leftSids = $leftSids; leftNames = @($after | ForEach-Object { if ($_.Unreadable) { "$($_.Id) $($_.Name) (owner unreadable)" } else { "$($_.Id) $($_.Name)" } }) }
}
# The tree deleter, compiled from an admin-only copy, its temporary files in an admin-only folder:
# SYSTEM's own TEMP takes files of other users too.
function LoadTree {
  if ('StudioTree' -as [type]) { return }
  if ($treeTemp) {
    $t = Get-Item -LiteralPath $treeTemp -Force -ErrorAction SilentlyContinue
    if ($null -eq $t -or ($t.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$treeTemp is missing or a reparse point: run the setup of Studio again, elevated" }
    $env:TEMP = $treeTemp
    $env:TMP = $treeTemp
  }
  Add-Type -Path $treeSource
}
function ProfileRoot {
  $list = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
  [Environment]::ExpandEnvironmentVariables($list.ProfilesDirectory).TrimEnd('\')
}
# Where profiles of retired crew users wait to be deleted, a bounded number of entries per run:
# a folder right below the profiles folder (only administrators make folders there), owned by
# administrators, its DACL protected (SYSTEM and administrators only).
function Quarantine {
  $q = Join-Path (ProfileRoot) 'Studio crew quarantine'
  $item = Get-Item -LiteralPath $q -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    New-Item -ItemType Directory -Path $q | Out-Null
    icacls $q /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /L /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "cannot set the ACL of $q" }
    icacls $q /setowner '*S-1-5-32-544' /L /Q | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $q 'trees') | Out-Null
    return $q
  }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$q is a reparse point" }
  $acl = Get-Acl -LiteralPath $q
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (@('S-1-5-32-544', 'S-1-5-18') -notcontains $owner) { throw "$q is owned by $owner" }
  if (-not $acl.AreAccessRulesProtected) { throw "$q inherits its ACL" }
  $trees = Get-Item -LiteralPath (Join-Path $q 'trees') -Force -ErrorAction SilentlyContinue
  if ($null -eq $trees) { New-Item -ItemType Directory -Path (Join-Path $q 'trees') | Out-Null }
  elseif ($trees.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$q\trees is a reparse point" }
  $q
}
# No logon as a crew user any more: disabled, with a new password nobody ever learns. What could
# start one of its processes (the relay account, which could unseal the old password) cannot.
function LockJobUser($u) {
  Disable-LocalUser -SID $u.SID
  Set-LocalUser -SID $u.SID -Password (ConvertTo-SecureString (NewSecret) -AsPlainText -Force)
}
# The profile leaves the profiles folder in one rename, into the quarantine, and Windows forgets it.
function QuarantineProfile($u, [string]$q) {
  $sid = $u.SID.Value
  $prof = $null
  for ($i = 0; $i -lt 60; $i++) {
    $prof = Get-CimInstance Win32_UserProfile -Filter ("SID='" + $sid + "'")
    if ($null -eq $prof -or -not $prof.Loaded) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($null -eq $prof) { return }
  if ($prof.Loaded) { throw "its profile is still loaded" }
  $path = [string]$prof.LocalPath
  $root = ProfileRoot
  $rest = if ($path.Length -gt $root.Length + 1) { $path.Substring($root.Length + 1) } else { '' }
  if (-not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $rest -eq '' -or $rest.Contains('\')) {
    throw "its profile is at $path, not a folder right below $root"
  }
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if ($null -ne $item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "its profile at $path is a reparse point" }
    [StudioTree]::Move($path, (Join-Path $q ($sid + '-' + [Guid]::NewGuid().ToString('N'))))
  }
  try { Remove-CimInstance -InputObject $prof } catch { }
  $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid
  if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
}
# Entries of the quarantine that could not be deleted, with the number of runs in a row they failed
# (admin-only, in the quarantine). One that failed $stuckRuns times is left alone from then on and
# named to doctor; pruning goes on past it.
$stuckRuns = 3
function StuckFile { Join-Path (Quarantine) 'stuck.txt' }
function ReadStuck {
  $f = StuckFile
  $map = @{}
  if (Test-Path -LiteralPath $f) {
    foreach ($line in @(Get-Content -LiteralPath $f)) {
      $at = $line.IndexOf([char]9)
      if ($at -gt 0) { $map[$line.Substring($at + 1)] = [int]$line.Substring(0, $at) }
    }
  }
  $map
}
# Counts this run's failures on, keeps entries that still exist, and returns those now left alone.
function TrackStuck($stuck, [string[]]$failed) {
  $next = @{}
  foreach ($k in $stuck.Keys) { if ([IO.Directory]::Exists($k) -or [IO.File]::Exists($k)) { $next[$k] = $stuck[$k] } }
  foreach ($f in $failed) { $next[$f] = 1 + $(if ($next.ContainsKey($f)) { $next[$f] } else { 0 }) }
  Set-Content -LiteralPath (StuckFile) -Value @($next.Keys | ForEach-Object { "$($next[$_])" + [char]9 + $_ }) -Encoding UTF8
  @($next.Keys | Where-Object { $next[$_] -ge $stuckRuns } | ForEach-Object { $_ -replace '^\\\\\?\\', '' })
}
# Retiring a crew user never waits for its profile to be deleted. Per user, each step runs only when
# the one before it held: lock it, see none of its processes left, move its profile into the
# quarantine, see none of its processes left once more, list its SID as retired, delete the
# account. A user whose step failed is kept (locked, so the next sweep finds it and the next retire
# tries again); the other users go on. Then up to $pruneBudget entries of the quarantine go.
function RetireJobUsers {
  LoadTree
  $users = @(JobUsers)
  $problems = @()
  $locked = @()
  foreach ($u in $users) {
    try { LockJobUser $u; $locked += $u } catch { $problems += "$($u.Name): cannot lock it, kept: $($_.Exception.Message)" }
  }
  $s = SweepJobUsers
  $q = $null
  try { $q = Quarantine } catch { $problems += "the quarantine: $($_.Exception.Message)" }
  $moved = @()
  foreach ($u in $locked) {
    if ($s.leftSids -contains $u.SID.Value) { $problems += "$($u.Name): its processes are still running, kept"; continue }
    if ($null -eq $q) { $problems += "$($u.Name): no quarantine for its profile, kept"; continue }
    try { QuarantineProfile $u (Join-Path $q 'trees'); $moved += $u } catch { $problems += "$($u.Name): its profile stays where it is, kept: $($_.Exception.Message)" }
  }
  $s2 = SweepJobUsers
  $gone = @()
  foreach ($u in $moved) {
    $sid = $u.SID.Value
    if ($s2.leftSids -contains $sid) { $problems += "$($u.Name): its processes are still running, kept"; continue }
    try {
      WriteRetired (@(@(ReadRetired) + $sid | Select-Object -Unique))
      Remove-LocalUser -SID $sid
      $gone += $u.Name
    } catch { $problems += "$($u.Name): cannot delete it, kept: $($_.Exception.Message)" }
  }
  $quarantine = @{ trees = 0; pruned = 0; done = $false; stuck = @() }
  if ($null -ne $q) {
    $trees = Join-Path $q 'trees'
    try {
      $stuck = ReadStuck
      $skip = @($stuck.Keys | Where-Object { $stuck[$_] -ge $stuckRuns })
      $r = [StudioTree]::Prune($trees, $pruneBudget, $true, $null, [string[]]$skip)
      $quarantine.pruned = $r.Deleted
      $quarantine.done = $r.Done
      $quarantine.stuck = @(TrackStuck $stuck @($r.Failed))
    } catch { $problems += "the quarantine: $($_.Exception.Message)" }
    try { $quarantine.trees = @(Get-ChildItem -LiteralPath $trees -Force -ErrorAction Stop).Count } catch { $quarantine.trees = -1 }
  }
  # Every process still running of a crew user, kept or retired: a fresh user waits for none.
  @{ removed = $gone; problems = $problems; left = @($s2.left); leftNames = @($s2.leftNames); quarantine = $quarantine }
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

/** A retire's part of a script: its answer, with every user's problems and the quarantine. */
const RETIRE_BODY = [
  '  $r = RetireJobUsers',
  '  $out.removed = @($r.removed)',
  '  $out.problems = @($r.problems)',
  '  $out.left = @($r.left)',
  '  $out.leftNames = @($r.leftNames)',
  '  $out.quarantine = $r.quarantine',
].join('\n');

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
  /** What the script loads, from admin-only folders, and the prune budget. */
  places: CrewScriptPlaces;
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
      ? '  $s = SweepJobUsers\n  $out.found = $s.found\n  $out.left = @($s.left)\n  $out.leftNames = @($s.leftNames)'
      : o.op === 'retire'
        ? RETIRE_BODY
        : `${RETIRE_BODY}\n  if (@($out.left).Count -eq 0) {\n    $n = NewJobUser ${psQuote(o.credFile ?? '')} ${reader}\n    $out.user = $n.user\n    $out.sid = $n.sid\n  }`;
  const write =
    o.result === undefined
      ? '[Console]::Out.Write((ConvertTo-Json -Compress $out))'
      : `Set-Content -LiteralPath ${psQuote(o.result)} -Value (ConvertTo-Json -Compress $out) -Encoding UTF8`;
  return `$ErrorActionPreference = 'Stop'
$out = @{ op = ${psQuote(o.op)}; at = (Get-Date).ToUniversalTime().ToString('o') }
try {
${crewAccountFunctions(o.prefix, o.places)}
${body}
} catch {
  $out.error = $_.Exception.Message
}
${write}
`;
}

/** What a retire or fresh run reports beside its result: problems by user, and the quarantine. */
export interface CrewNotes {
  /** One line per user and step that failed; the other steps ran on. */
  problems: string[];
  /** Profiles of retired users still waiting in the quarantine; -1 when it cannot be read. */
  quarantined?: number;
  /** Entries of the quarantine that failed several runs and are left alone now. */
  stuck?: string[];
}

/** An answer of a crew account script: undefined when it has not the shape it must have. */
export function judgeCrewAnswer(
  op: CrewAccountOp,
  answer: unknown,
):
  | { error: string }
  | { left: number[]; names?: string[]; notes: CrewNotes }
  | { account: CrewAccount; notes: CrewNotes }
  | undefined {
  const a = answer as {
    op?: unknown;
    at?: unknown;
    error?: unknown;
    left?: unknown;
    user?: unknown;
    sid?: unknown;
    problems?: unknown;
    quarantine?: unknown;
    leftNames?: unknown;
  } | null;
  if (a === null || typeof a !== 'object' || a.op !== op || typeof a.at !== 'string') {
    return undefined;
  }
  if (typeof a.error === 'string') return { error: a.error.slice(0, 300) };
  // Windows PowerShell writes a one-element array as its element.
  const list = (x: unknown): unknown[] | undefined =>
    Array.isArray(x) ? x : x === undefined || x === null ? [] : [x];
  const left = Array.isArray(a.left) ? a.left : typeof a.left === 'number' ? [a.left] : undefined;
  if (left === undefined || !left.every((n) => Number.isInteger(n))) return undefined;
  const problems = (list(a.problems) ?? [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.slice(0, 300))
    .slice(0, 20);
  const q = a.quarantine as { trees?: unknown; stuck?: unknown } | undefined;
  const stuck = (list(q?.stuck) ?? [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.slice(0, 500))
    .slice(0, 20);
  const notes: CrewNotes = {
    problems,
    ...(typeof q?.trees === 'number' && Number.isInteger(q.trees) ? { quarantined: q.trees } : {}),
    ...(stuck.length > 0 ? { stuck } : {}),
  };
  const names = (list(a.leftNames) ?? [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.slice(0, 200))
    .slice(0, 10);
  if (op !== 'fresh' || left.length > 0) {
    return { left: left as number[], ...(names.length > 0 ? { names } : {}), notes };
  }
  if (
    typeof a.user !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,12}-[0-9a-f]{6}$/.test(a.user) ||
    typeof a.sid !== 'string' ||
    !/^S-1-5-21(-\d+)+$/.test(a.sid)
  ) {
    return undefined;
  }
  return { account: { user: a.user, sid: a.sid, at: a.at }, notes };
}

/** Throws the refusal of an answer; returns the account of a fresh one and the notes. */
function settle(
  op: CrewAccountOp,
  raw: unknown,
  where: string,
): { account?: CrewAccount; notes?: CrewNotes } {
  const j = judgeCrewAnswer(op, raw);
  if (j === undefined) throw new Error(`${where} answered in an unknown shape`);
  if ('error' in j) throw new Error(`${where} could not ${op} the crew users: ${j.error}`);
  if ('left' in j && j.left.length > 0) {
    const which = 'names' in j && j.names !== undefined ? j.names.join(', ') : j.left.join(', ');
    throw new Error(
      `processes of the crew users (or of an owner that cannot be read) are still running (${which}) and ${where} cannot end them`,
    );
  }
  return 'account' in j ? { account: j.account, notes: j.notes } : { notes: j.notes };
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
  /** The admin-only copy of the tree deleter and the admin-only folder its compiler writes in. */
  treeSource: string;
  treeTemp: string;
  /** Entries of the quarantine deleted per retire (tests make it small). */
  pruneBudget?: number;
}): CrewAccounts {
  const call = async (op: CrewAccountOp): Promise<{ account?: CrewAccount; notes?: CrewNotes }> => {
    const script = crewAccountScript({
      op,
      prefix: o.prefix,
      places: {
        treeSource: o.treeSource,
        treeTemp: o.treeTemp,
        ...(o.pruneBudget === undefined ? {} : { pruneBudget: o.pruneBudget }),
      },
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
    fresh: async () => {
      const r = await call('fresh');
      return {
        ...(r.account as CrewAccount),
        ...(r.notes === undefined ? {} : { notes: r.notes }),
      };
    },
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
  const call = async (op: CrewAccountOp): Promise<{ account?: CrewAccount; notes?: CrewNotes }> => {
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
    fresh: async () => {
      const r = await call('fresh');
      return {
        ...(r.account as CrewAccount),
        ...(r.notes === undefined ? {} : { notes: r.notes }),
      };
    },
    exists: (sid) => crewUserExists(o.run, sid),
  };
}

/**
 * The first part of a setup for Studio's group of crew users: the group itself. Sets `$group` and
 * `$groupSid`. Runs elevated, after `crewAccountFunctions`.
 */
export const crewGroupMake =
  (): string => `# Studio's group of crew users: every crew user is made in it for one job and deleted after.
$group = Get-LocalGroup -Name ($prefix + 's') -ErrorAction SilentlyContinue
if ($null -eq $group) { $group = New-LocalGroup -Name ($prefix + 's') -Description $groupDescription }
elseif ($group.Description -ne $groupDescription) { throw "a group $($group.Name) exists and is not Studio's: remove it or choose another crew_user prefix" }
$groupSid = $group.SID.Value
`;

/**
 * The rest of it, once the admin-only copy of the tree deleter is in place: it takes away the one
 * shared crew user of earlier versions (named the prefix, with Studio's old description) with its
 * processes, profile and firewall rule, and crew users a crash left; makes what the group carries:
 * the outbound firewall rule (nothing but loopback), the denied logons, and the read grants on
 * `$readPaths` (set before).
 */
export const crewGroupFinish =
  (): string => `# The shared crew user of earlier versions goes, with what it left.
$old = Get-LocalUser -Name $prefix -ErrorAction SilentlyContinue
if ($null -ne $old -and $old.Description -eq 'Studio crew sandbox') {
  LoadTree
  LockJobUser $old
  foreach ($p in @(Owned @($old.SID.Value) | Where-Object { -not $_.Unreadable })) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  $oldLeft = @(Owned @($old.SID.Value))
  if ($oldLeft.Count -gt 0) { throw "processes of the old crew user $prefix may still run ($(@($oldLeft | ForEach-Object { "$($_.Id) $($_.Name)" }) -join ', ')): end them, then run this again" }
  QuarantineProfile $old (Join-Path (Quarantine) 'trees')
  WriteRetired (@(@(ReadRetired) + $old.SID.Value | Select-Object -Unique))
  Remove-LocalUser -SID $old.SID
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
export const GIT_MIN_CHECK = String.raw`$gitExe = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Git\cmd\git.exe'
if (-not (Test-Path -LiteralPath $gitExe -PathType Leaf)) { throw 'Git for Windows is not installed for all users: install 2.35.2 or later (winget install --id Git.Git --exact --scope machine)' }
$gitVersion = [string](& $gitExe --version)
if ($gitVersion -notmatch '(\d+)\.(\d+)\.(\d+)') { throw "cannot read the version of Git: $gitVersion" }
if ([version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]) -lt [version]'2.35.2') { throw "Git $($Matches[0]) is older than 2.35.2: update Git for Windows (winget upgrade --id Git.Git)" }
Write-Output "ok: Git $($Matches[0])"
`;
