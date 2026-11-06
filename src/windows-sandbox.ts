import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipv4, LOOPBACK } from './egress-proxy.js';
import { HeldError } from './held.js';
import {
  acquireStateLock,
  assertStatePath,
  ensureStateDir,
  removeStateEntry,
  writeStateFile,
} from './paths.js';
import type { Claude } from './ports.js';

/**
 * The crew sandbox of a worker on native Windows.
 *
 * Claude Code's sandbox does not run on native Windows (https://code.claude.com/docs/en/sandboxing:
 * "On native Windows, Claude Code runs commands unsandboxed"), so a worker there cannot rely on it.
 * Instead the whole crew, Claude Code included, runs as a dedicated local standard user the owner
 * creates once (`studio worker windows-setup` prints the script):
 *
 * - **Files.** The crew user is a member of Users only. The owner's profile (credentials, gh and
 *   git logins, Studio's state and owner config) is closed to other users by Windows' default
 *   profile ACL. For each run Studio grants the crew user only the run's own places: its clone,
 *   HOME, tmp dir and log (modify), its brief, settings and guard context (read), and takes the
 *   grants off when the run ends (`WindowsGrants`). One crew at a time, as all share the user.
 *   Toolchains, node, Git and Claude Code must be readable by it (Program Files is; the setup
 *   grants read on the paths it is given).
 * - **Network.** A firewall rule of the setup blocks every outbound connection of the crew user
 *   to anything but loopback. Its traffic goes through Studio's proxy on loopback
 *   (src/egress-proxy.ts), which tunnels only to the names of `network_allow` and the Claude API.
 * - **Proof, not trust.** Before every claim the worker starts a probe as the crew user and
 *   refuses to run crews unless it shows: the process runs as that user, not as an administrator;
 *   it cannot read the owner's profile, Studio's owner config or any deny path, nor write the
 *   owner's home; a direct connection out fails; the proxy refuses a name not on the list; and the
 *   environment Studio set reached it. Any other answer, or no answer, refuses (fail closed).
 *
 * Weaker than the macOS and Linux sandboxes, and said so in SECURITY.md: loopback is not filtered
 * by the Windows firewall, so the crew can reach services listening on loopback (denied ports are
 * refused only by the guard); and places on this machine that grant Users or Everyone access
 * (for example folders created at a drive root) are open to it unless denied by path.
 */

/** A local user name Studio accepts: letters, digits, `_` and `-`, at most 20 characters. */
export const CREW_USER_RE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;

/** Every address but loopback, for the firewall rule: IPv4 around the 127 block, IPv6 around ::1. */
export const OUTSIDE = [
  `${ipv4(0, 0, 0, 0)}-${ipv4(126, 255, 255, 255)}`,
  `${ipv4(128, 0, 0, 0)}-${ipv4(255, 255, 255, 255)}`,
  '::',
  '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
];

/** What Claude Code itself needs out, on top of `network_allow`; other traffic is turned off. */
export const CLAUDE_HOSTS = ['api.anthropic.com'];

/** Environment for a crew on Windows: Claude Code's optional traffic off, all through the proxy. */
export function windowsCrewEnv(o: {
  proxyPort: number;
  homeDir: string;
  tmpDir: string;
  base: Record<string, string | undefined>;
}): Record<string, string> {
  const proxy = `http://${LOOPBACK}:${o.proxyPort}`;
  const env: Record<string, string> = {};
  // What Windows programs need to start at all; nothing of the owner's profile.
  for (const k of [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'ComSpec',
    'PATHEXT',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'ProgramData',
    'CommonProgramFiles',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
  ]) {
    const v = o.base[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    USERPROFILE: o.homeDir,
    APPDATA: join(o.homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(o.homeDir, 'AppData', 'Local'),
    TEMP: o.tmpDir,
    TMP: o.tmpDir,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}

/** A PowerShell single-quoted string literal. */
export function psQuote(s: string): string {
  if (/[\p{Cc}]/u.test(s)) throw new Error(`refusing a control character in ${JSON.stringify(s)}`);
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The one-time setup, for the owner to run in an elevated PowerShell as the account the worker runs
 * under (the credential file is encrypted for that account, DPAPI). It creates the crew user with a
 * random password nobody sees, a member of Users only; stores its credential for the owner alone;
 * adds the outbound firewall rule; and grants the crew user read on `readPaths` (toolchains, the
 * Studio plugin, Claude Code, the skills and plugins of the crew Claude config dir). Idempotent:
 * an existing user keeps its password unless the credential file is missing.
 */
export function windowsSetupScript(o: {
  user: string;
  credFile: string;
  readPaths: readonly string[];
  /** Places an earlier setup may have opened for writing (the crew Claude config dir): closed first. */
  revokePaths?: readonly string[];
}): string {
  if (!CREW_USER_RE.test(o.user)) throw new Error(`not a crew user name: ${o.user}`);
  const list = (ps: readonly string[]) => `@(${ps.map(psQuote).join(', ')})`;
  return `#Requires -RunAsAdministrator
# Studio: the crew sandbox user of this Windows worker. Run once in an elevated Windows PowerShell
# (powershell.exe), as the account that runs \`studio worker\`. Nothing here leaves this machine.
$ErrorActionPreference = 'Stop'
$name = ${psQuote(o.user)}
$credFile = ${psQuote(o.credFile)}
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$plain = [Convert]::ToBase64String($bytes) + 'aA1!'
$secret = ConvertTo-SecureString $plain -AsPlainText -Force
$plain = $null
$user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if ($null -eq $user) {
  $user = New-LocalUser -Name $name -Password $secret -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description 'Studio crew sandbox'
} elseif (-not (Test-Path -LiteralPath $credFile)) {
  Set-LocalUser -Name $name -Password $secret
} else {
  $secret = (Import-Clixml -LiteralPath $credFile).Password
}
# Users only, never Administrators (groups by SID: their names depend on the language).
$users = Get-LocalGroup -SID 'S-1-5-32-545'
if (-not (Get-LocalGroupMember -Group $users | Where-Object { $_.SID -eq $user.SID })) {
  Add-LocalGroupMember -Group $users -Member $user
}
$admins = Get-LocalGroup -SID 'S-1-5-32-544'
if (Get-LocalGroupMember -Group $admins | Where-Object { $_.SID -eq $user.SID }) {
  throw "$name is an administrator: remove it from that group first"
}
# The credential, for this account on this machine only.
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $credFile) | Out-Null
New-Object System.Management.Automation.PSCredential ($name, $secret) | Export-Clixml -LiteralPath $credFile
icacls $credFile /inheritance:r /grant:r "$($env:USERDOMAIN)\\$($env:USERNAME):F" | Out-Null
# No direct network: every outbound connection of the crew user to anything but loopback.
$sid = $user.SID.Value
$rule = 'Studio crew ' + $name + ': no direct network'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;$sid)" -RemoteAddress @(${OUTSIDE.map(psQuote).join(', ')}) | Out-Null
# An earlier setup opened the crew Claude config dir for writing: that grant goes, all the way down.
foreach ($p in ${list(o.revokePaths ?? [])}) {
  if (Test-Path -LiteralPath $p) { icacls $p /remove:g $name /T /C /Q | Out-Null }
}
# No logon as a batch job (no scheduled task with a stored password), as a service, over the
# network or by remote desktop: the crew user starts processes only through Studio's keeper.
$cfg = Join-Path $env:TEMP ('studio-rights-' + [Guid]::NewGuid().ToString('N') + '.inf')
$db = [IO.Path]::ChangeExtension($cfg, '.sdb')
secedit /export /cfg $cfg /areas USER_RIGHTS | Out-Null
$lines = [Collections.Generic.List[string]](Get-Content -LiteralPath $cfg)
$at = $lines.IndexOf('[Privilege Rights]')
if ($at -lt 0) { throw 'secedit gave no [Privilege Rights] section' }
foreach ($right in @('SeDenyBatchLogonRight', 'SeDenyServiceLogonRight', 'SeDenyNetworkLogonRight', 'SeDenyRemoteInteractiveLogonRight')) {
  $i = -1
  for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k] -like "$right *") { $i = $k } }
  if ($i -lt 0) { $lines.Insert($at + 1, "$right = *$sid") }
  elseif ($lines[$i] -notlike "**$sid*") { $lines[$i] = $lines[$i] + ",*$sid" }
}
Set-Content -LiteralPath $cfg -Value $lines -Encoding Unicode
secedit /configure /db $db /cfg $cfg /areas USER_RIGHTS /quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw "secedit could not set the logon rights ($LASTEXITCODE)" }
Remove-Item -LiteralPath $cfg, $db -ErrorAction SilentlyContinue
foreach ($p in ${list(o.readPaths)}) {
  if (Test-Path -LiteralPath $p) { icacls $p /grant "\${name}:(OI)(CI)RX" /Q | Out-Null }
}
Write-Output "Studio crew user $name is ready; start the worker again."
`;
}

// ---- Grants for one run ------------------------------------------------------------------------

export interface Grant {
  path: string;
  /** `M` modify (with inheritance for a directory), `R` read and execute. */
  rights: 'M' | 'R';
}

/** The SID of OWNER RIGHTS: an ACE for it replaces what a file's owner may do by default. */
const OWNER_RIGHTS = '*S-1-3-4';

/** The `icacls` arguments of one grant. */
export function grantArgs(user: string, g: Grant): string[] {
  if (!CREW_USER_RE.test(user)) throw new Error(`not a crew user name: ${user}`);
  const rights = g.rights === 'R' ? 'RX' : 'M';
  return [g.path, '/grant', `${user}:${isDir(g.path) ? '(OI)(CI)' : ''}${rights}`, '/Q'];
}

/**
 * A writable directory also gets an inheritable OWNER RIGHTS entry with nothing but SYNCHRONIZE:
 * what the crew user creates there is owned by it, and an owner may by default read and change the
 * ACL of its files. With this entry it keeps no rights of its own once its grant is removed, so a
 * later crew cannot open what an earlier one left in another clone.
 */
export function ownerRightsArgs(path: string): string[] {
  return [path, '/grant', `${OWNER_RIGHTS}:(OI)(CI)(S)`, '/Q'];
}

/** The `icacls` arguments that take every grant of the crew user off a path. */
export function revokeArgs(user: string, path: string): string[] {
  if (!CREW_USER_RE.test(user)) throw new Error(`not a crew user name: ${user}`);
  return [path, '/remove:g', user, '/Q'];
}

/**
 * The `icacls` calls that take a run's place back from the crew user, in order. Removing its grant
 * is not enough: what it created is owned by it, and an owner may change the ACL of its files.
 * So, below a directory, every ACL goes back to what it inherits (`/reset`, which also drops the
 * entries CREATOR OWNER gave the creator and any it set itself), and the owner of everything becomes
 * the account Studio runs as. The inheritable OWNER RIGHTS entry of the grant stays on the
 * directory, so even an owner keeps no rights of its own there.
 */
export function revokeSteps(user: string, owner: string, path: string, dir: boolean): string[][] {
  if (!/^[^\p{Cc}"*?<>|]+$/u.test(owner)) throw new Error(`not an account name: ${owner}`);
  return [
    revokeArgs(user, path),
    ...(dir ? [[join(path, '*'), '/reset', '/T', '/C', '/Q']] : []),
    [path, '/setowner', owner, ...(dir ? ['/T'] : []), '/C', '/Q'],
  ];
}

/** The account Studio runs as, for `icacls /setowner`. */
export const ownerAccount = (env: Record<string, string | undefined> = process.env): string =>
  env.USERDOMAIN !== undefined && env.USERNAME !== undefined
    ? `${env.USERDOMAIN}\\${env.USERNAME}`
    : (env.USERNAME ?? '');

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

export type RunFile = (
  file: string,
  args: string[],
  opts?: { env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runFile: RunFile = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        ...(opts.env === undefined ? {} : { env: opts.env }),
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** The record and the lock of one crew user, owner-wide: all projects of this owner share it. */
const recordFile = (user: string) => `windows-crew-${user.toLowerCase()}.json`;
const lockFile = (user: string) => `windows-crew-${user.toLowerCase()}.lock`;
const LOCK_STALE_MS = 10 * 60_000;

interface GrantRecord {
  /** The keeper of the crew that holds the grants, once it started. */
  keeper?: number;
  paths: string[];
}

function readGrantRecord(ownerRoot: string, user: string): GrantRecord {
  try {
    const raw = JSON.parse(readFileSync(join(ownerRoot, recordFile(user)), 'utf8')) as GrantRecord;
    return {
      ...(typeof raw.keeper === 'number' ? { keeper: raw.keeper } : {}),
      paths: Array.isArray(raw.paths) ? raw.paths.filter((p) => typeof p === 'string') : [],
    };
  } catch {
    return { paths: [] };
  }
}

const writeGrantRecord = (ownerRoot: string, user: string, r: GrantRecord) =>
  writeStateFile(ownerRoot, join(ownerRoot, recordFile(user)), `${JSON.stringify(r)}\n`);

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Ends every process of the crew user (found by owner SID through CIM) and prints how many it
 * found and which are left. Run before a grant: whatever a crew left outside its job (a scheduled
 * task, a WMI start) must not see the next crew's places. Ending another user's process takes an
 * administrator; without one, a process that is left refuses the grant.
 */
export const sweepScript = (user: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `$sid = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, ${psQuote(user)})).Translate([Security.Principal.SecurityIdentifier]).Value`,
    'function Crew { @(Get-CimInstance Win32_Process | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $sid } catch { $false } }) }',
    '$found = Crew',
    'foreach ($p in $found) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    'if ($found.Count -gt 0) { Start-Sleep -Milliseconds 800 }',
    '$left = @(Crew | ForEach-Object { [int]$_.ProcessId })',
    '[Console]::Out.Write((ConvertTo-Json -Compress @{ found = $found.Count; left = $left }))',
  ].join('\n');

/**
 * The grants of the one crew a crew user runs at a time, recorded owner-wide per crew user (the
 * owner's state root, never a crew's places, under a lock across processes), so that they are taken
 * off when it ends, when it is stopped, and before any later grant, also after a crash, and so that
 * two projects of the owner sharing the crew user cannot run crews at once: a grant while a
 * recorded keeper lives refuses, and so does a grant while processes of the crew user are left.
 */
export class WindowsGrants {
  constructor(
    private readonly o: { ownerRoot: string; user: string; run: RunFile; owner?: string },
  ) {}

  paths(): string[] {
    return readGrantRecord(this.o.ownerRoot, this.o.user).paths;
  }

  /** Runs `fn` under the crew user's lock, waiting up to 30 seconds for it. */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const until = Date.now() + 30_000;
    for (;;) {
      const lock = acquireStateLock(this.o.ownerRoot, lockFile(this.o.user), {
        now: new Date(),
        heartbeatStaleMs: LOCK_STALE_MS,
      });
      if (lock) {
        try {
          return await fn();
        } finally {
          lock.release();
        }
      }
      if (Date.now() >= until) {
        throw new HeldError(`another launch holds the crew user ${this.o.user}; try again`);
      }
      await sleep(250);
    }
  }

  private async revokeLocked(): Promise<void> {
    const rec = readGrantRecord(this.o.ownerRoot, this.o.user);
    const failed: string[] = [];
    const owner = this.o.owner ?? ownerAccount();
    for (const p of rec.paths) {
      if (!existsSync(p)) continue;
      for (const args of revokeSteps(this.o.user, owner, p, isDir(p))) {
        const r = await this.o.run('icacls', args);
        if (r.code !== 0) {
          failed.push(p);
          break;
        }
      }
    }
    writeGrantRecord(this.o.ownerRoot, this.o.user, { paths: failed });
    if (failed.length > 0) {
      throw new Error(`cannot take the crew user's grants off ${failed.join(', ')}`);
    }
  }

  /** Takes every recorded grant off; a failure is thrown after all were tried. */
  revokeAll(): Promise<void> {
    return this.locked(() => this.revokeLocked());
  }

  /** Ends what is left of the crew user; refuses when something cannot be ended. */
  private async sweep(): Promise<void> {
    const r = await this.o.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', sweepScript(this.o.user)],
      { env: powershellEnv(process.env), timeoutMs: 120_000 },
    );
    let left: unknown;
    try {
      left = (JSON.parse(r.stdout) as { left?: unknown }).left;
    } catch {
      left = undefined;
    }
    if (r.code !== 0 || !Array.isArray(left)) {
      throw new Error(`cannot list the processes of the crew user ${this.o.user}`);
    }
    if (left.length > 0) {
      throw new Error(
        `processes of the crew user ${this.o.user} are still running (${left.join(', ')}) and cannot be ended from this account; end them as an administrator`,
      );
    }
  }

  grant(grants: readonly Grant[]): Promise<void> {
    return this.locked(async () => {
      const rec = readGrantRecord(this.o.ownerRoot, this.o.user);
      if (rec.keeper !== undefined && processExists(rec.keeper)) {
        throw new HeldError(
          `a crew of the crew user ${this.o.user} is still running: one crew at a time on this machine, as all projects share the crew user`,
        );
      }
      await this.revokeLocked();
      await this.sweep();
      // Recorded before granting: a crash halfway leaves nothing that is not taken off later.
      writeGrantRecord(this.o.ownerRoot, this.o.user, { paths: grants.map((g) => g.path) });
      for (const g of grants) {
        const steps = [
          grantArgs(this.o.user, g),
          ...(g.rights === 'M' && isDir(g.path) ? [ownerRightsArgs(g.path)] : []),
        ];
        for (const args of steps) {
          const r = await this.o.run('icacls', args);
          if (r.code !== 0) {
            throw new Error(
              `cannot open ${g.path} to the crew user ${this.o.user}: icacls exited ${r.code}`,
            );
          }
        }
      }
    });
  }

  recordKeeper(pid: number): Promise<void> {
    return this.locked(async () => {
      writeGrantRecord(this.o.ownerRoot, this.o.user, {
        ...readGrantRecord(this.o.ownerRoot, this.o.user),
        keeper: pid,
      });
    });
  }
}

// ---- The keeper: starting, holding and stopping a crew -----------------------------------------

/** The crew host (bin/studio-crew-host.mjs): runs as the crew user, starts the crew. */
export const CREW_HOST_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'studio-crew-host.mjs',
);

/** The keeper's file name; the identity check looks for it on the command line. */
export const KEEPER_FILE = 'studio-crew-keeper.ps1';

/**
 * The keeper: a PowerShell of the owner that lives as long as the crew. It reads from its stdin a
 * first line with the paths whose grants it takes off at the end, then the spec. It creates a job
 * object that ends every process in it when its last handle closes, starts the host as the crew
 * user (`Start-Process -Credential`, whose process handle has full access) and puts it in the job
 * before the host has its spec, so nothing the crew starts escapes the job. The spec, with the
 * crew's environment and so the Claude token, goes to the host over a named pipe only the owner and
 * the crew user may open, and only once the pipe's client is that very host: it never lands on
 * disk. Then it waits for the host and takes the grants off. Ending the keeper (Studio's stop)
 * closes the job and so ends the crew's whole tree. The host's output goes to files in a directory
 * of the owner, which the crew user cannot reach.
 */
export const KEEPER_SCRIPT = `# Studio: the keeper of one crew on a Windows worker (src/windows-sandbox.ts).
param(
  [Parameter(Mandatory = $true)][string]$Cred,
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$HostBin,
  [Parameter(Mandatory = $true)][string]$Cwd,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Err,
  [Parameter(Mandatory = $true)][string]$User,
  [int]$WaitSeconds = 60
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StudioJob {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)]
  struct Extended {
    public Basic BasicLimits; public Io IoInfo; public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended info = new Extended();
    info.BasicLimits.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
    return job;
  }
  public static void Assign(IntPtr job, IntPtr process) {
    if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
  }
  public static uint ClientPid(IntPtr pipe) {
    uint pid;
    if (!GetNamedPipeClientProcessId(pipe, out pid)) throw new Win32Exception();
    return pid;
  }
}
'@
$raw = [Console]::In.ReadToEnd()
$nl = $raw.IndexOf([char]10)
if ($nl -lt 0) { throw 'no spec on stdin' }
$revoke = @(ConvertFrom-Json $raw.Substring(0, $nl))
$spec = [Text.Encoding]::UTF8.GetBytes($raw.Substring($nl + 1))
$raw = $null
$p = $null
try {
  $job = [StudioJob]::Create()
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $crew = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, $User)).Translate([Security.Principal.SecurityIdentifier])
  $security = New-Object System.IO.Pipes.PipeSecurity
  $security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, 'FullControl', 'Allow')))
  $security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($crew, 'ReadWrite', 'Allow')))
  $name = 'studio-' + [Guid]::NewGuid().ToString('N')
  $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($name, 'Out', 1, 'Byte', 'Asynchronous', 0, 65536, $security)
  $c = Import-Clixml -LiteralPath $Cred
  $p = Start-Process -FilePath $Node -ArgumentList @(('"' + $HostBin + '"'), $name) -Credential $c -WorkingDirectory $Cwd -WindowStyle Hidden -PassThru -RedirectStandardOutput $Out -RedirectStandardError $Err
  [StudioJob]::Assign($job, $p.Handle)
  $wait = $pipe.BeginWaitForConnection($null, $null)
  if (-not $wait.AsyncWaitHandle.WaitOne($WaitSeconds * 1000)) { throw 'the crew host did not connect' }
  $pipe.EndWaitForConnection($wait)
  if ([StudioJob]::ClientPid($pipe.SafePipeHandle.DangerousGetHandle()) -ne [uint32]$p.Id) {
    throw 'a process other than the crew host connected'
  }
  $pipe.Write($spec, 0, $spec.Length)
  $pipe.Flush()
  $pipe.WaitForPipeDrain()
  $pipe.Dispose()
  $spec = $null
  $p.WaitForExit()
  $code = $p.ExitCode
} catch {
  if ($null -ne $p -and -not $p.HasExited) { $p.Kill() }
  [Console]::Error.WriteLine("studio keeper: $($_.Exception.Message)")
  $code = 2
} finally {
  # As Studio's revokeSteps: the grant goes, ACLs below go back to inherited, the owner is ours.
  $owner = "$($env:USERDOMAIN)$($env:USERNAME)"
  foreach ($r in $revoke) {
    if (-not (Test-Path -LiteralPath $r)) { continue }
    icacls $r /remove:g $User /Q | Out-Null
    if (Test-Path -LiteralPath $r -PathType Container) {
      icacls (Join-Path $r '*') /reset /T /C /Q | Out-Null
      icacls $r /setowner $owner /T /C /Q | Out-Null
    } else {
      icacls $r /setowner $owner /C /Q | Out-Null
    }
  }
}
exit $code
`;

export interface HostSpec {
  /** seed: only writes `seed` (a file the crew user owns), for the probe's later check. */
  mode: 'run' | 'probe' | 'seed';
  seed?: string;
  /** run: what to start, where, its prompt on stdin and the log it appends to. */
  cmd?: string;
  args?: string[];
  cwd?: string;
  prompt?: string;
  log?: string;
  /** probe: what must hold for the crew user. */
  probe?: ProbeSpec;
  /** The environment of the crew (or of the probe's child); it may hold the Claude token. */
  env?: Record<string, string>;
}

export interface ProbeSpec {
  user: string;
  mark: string;
  mustNotRead: string[];
  mustNotWrite: string[];
  /** A name and port a direct connection must not reach. */
  direct: { host: string; port: number };
  /** The proxy, and a name it must refuse. */
  proxy: { port: number; refused: string };
  /**
   * A place granted to the crew user before and taken back since, and a file the crew user made
   * there: it must not change the file, its ACL, or add a file.
   */
  former?: { dir: string; file: string };
}

/** What PowerShell itself gets: what Windows programs need, no token, no PowerShell 7 modules. */
export function powershellEnv(env: Record<string, string | undefined>): Record<string, string> {
  const keep = new Set([
    'systemroot',
    'systemdrive',
    'windir',
    'comspec',
    'pathext',
    'path',
    'programfiles',
    'programdata',
    'number_of_processors',
    'processor_architecture',
    'os',
    'computername',
    'userdomain',
    'username',
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined && keep.has(e[0].toLowerCase()),
    ),
  );
}

/** Starts a keeper; `exited` settles with its exit code. A seam for tests. */
export type SpawnKeeper = (o: {
  args: string[];
  env: Record<string, string>;
  stdin: string;
  /** The keeper's own output, a file of the owner. */
  log: string;
  detached: boolean;
}) => Promise<{ pid: number; exited: Promise<number> }>;

export const spawnKeeper: SpawnKeeper = async (o) => {
  const fd = openSync(o.log, 'a');
  try {
    const child = spawn('powershell.exe', o.args, {
      env: o.env,
      detached: o.detached,
      stdio: ['pipe', fd, fd],
      windowsHide: true,
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve(child.pid as number));
    });
    const exited = new Promise<number>((resolve) => child.once('exit', (c) => resolve(c ?? 1)));
    child.stdin?.on('error', () => {});
    child.stdin?.end(o.stdin);
    if (o.detached) child.unref();
    return { pid, exited };
  } finally {
    closeSync(fd);
  }
};

/**
 * Files the keeper and the host write their output to, in the owner's `logs` dir, which no crew
 * user is granted: a link planted there would be followed with the owner's rights. Each is removed
 * first (a link is unlinked, never followed) and every directory on the way checked, right before
 * the keeper starts.
 */
function ownerFiles(stateRoot: string, name: string) {
  const logs = ensureStateDir(stateRoot, join(stateRoot, 'logs'));
  if (lstatSync(logs).isSymbolicLink()) throw new Error(`${logs} is a link`);
  const files = {
    out: join(logs, `${name}.host.out`),
    err: join(logs, `${name}.host.err`),
    keeper: join(logs, `${name}.keeper.log`),
  };
  for (const f of Object.values(files)) {
    removeStateEntry(stateRoot, f);
    assertStatePath(stateRoot, f);
  }
  return files;
}

/** Writes the keeper script into the owner's settings dir and returns its path. */
function keeperFile(stateRoot: string): string {
  const file = join(stateRoot, 'settings', KEEPER_FILE);
  writeStateFile(stateRoot, file, KEEPER_SCRIPT);
  return file;
}

function keeperArgs(o: {
  script: string;
  credFile: string;
  node: string;
  cwd: string;
  out: string;
  err: string;
  user: string;
}): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    o.script,
    '-Cred',
    o.credFile,
    '-Node',
    o.node,
    '-HostBin',
    CREW_HOST_BIN,
    '-Cwd',
    o.cwd,
    '-Out',
    o.out,
    '-Err',
    o.err,
    '-User',
    o.user,
  ];
}

/**
 * The PowerShell that tells whether `pid` is a keeper of this owner: its owner's SID is the
 * caller's, its command line runs the keeper file; then it prints the process's creation time.
 */
export const identityScript = (pid: number): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}'`,
    'if ($null -eq $p) { exit 3 }',
    '$o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid',
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    `if ($o.Sid -ne $me -or $p.CommandLine -notlike ${psQuote(`*${KEEPER_FILE}*`)}) { exit 4 }`,
    "[Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('o'))",
  ].join('\n');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Claude Code for crews of this worker, started as the crew user through a keeper. Studio records
 * the keeper (the owner's own process): `alive`, `identity` and `stop` work on it, never on anything
 * the crew controls. The identity is the keeper's creation time, read owner-side through CIM, and
 * only for a process of this owner running the keeper file. Stopping ends the keeper, which closes
 * its job and so ends the crew's tree; the grants are taken off then as well.
 */
export function windowsClaude(o: {
  stateRoot: string;
  credFile: string;
  claudeBin: string;
  user: string;
  grants: WindowsGrants;
  run?: RunFile;
  spawn?: SpawnKeeper;
  node?: string;
}): Claude {
  const run = o.run ?? runFile;
  const start = o.spawn ?? spawnKeeper;
  const node = o.node ?? process.execPath;
  return {
    async start(cwd, args, prompt, logPath, env) {
      const id =
        logPath
          .replace(/\\/g, '/')
          .split('/')
          .at(-1)
          ?.replace(/\.jsonl$/, '') ?? '';
      if (!/^[A-Z]+-\d+$/.test(id)) throw new Error(`not a crew log: ${logPath}`);
      const files = ownerFiles(o.stateRoot, id);
      const spec: HostSpec = {
        mode: 'run',
        cmd: o.claudeBin,
        args,
        cwd,
        prompt,
        log: logPath,
        env,
      };
      const k = await start({
        args: keeperArgs({
          script: keeperFile(o.stateRoot),
          credFile: o.credFile,
          node,
          cwd,
          out: files.out,
          err: files.err,
          user: o.user,
        }),
        env: powershellEnv(env),
        stdin: `${JSON.stringify(o.grants.paths())}\n${JSON.stringify(spec)}`,
        log: files.keeper,
        detached: true,
      });
      await o.grants.recordKeeper(k.pid);
      return { pid: k.pid };
    },
    alive: processExists,
    async identity(pid) {
      if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return undefined;
      const r = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', identityScript(pid)],
        { env: powershellEnv(process.env), timeoutMs: 30_000 },
      );
      const at = r.stdout.trim();
      return r.code === 0 && at !== '' ? `keeper:${at}` : undefined;
    },
    async stop(pid) {
      if (processExists(pid)) await run('taskkill', ['/PID', String(pid), '/F']);
      for (let i = 0; i < 50 && processExists(pid); i++) await sleep(200);
      await o.grants.revokeAll();
    },
  };
}

// ---- The probe ---------------------------------------------------------------------------------

export interface ProbeResult {
  check: string;
  ok: boolean;
  detail: string;
}

/** The first check that did not hold, as the refusal line; undefined when all held. */
export function probeProblem(results: readonly ProbeResult[] | undefined): string | undefined {
  if (results === undefined || results.length === 0) {
    return 'the Windows crew sandbox could not be shown to hold here: the probe as the crew user gave no answer';
  }
  const bad = results.find((r) => !r.ok);
  return bad === undefined
    ? undefined
    : `the Windows crew sandbox does not hold here: ${bad.check}: ${bad.detail}`;
}

/** The checks a probe must report, every one of them. */
export const PROBE_CHECKS = [
  'user',
  'admin',
  'env',
  'read',
  'write',
  'direct',
  'proxy',
  'tasks',
  'former',
];

/**
 * Starts the host in probe mode as the crew user through a keeper, waits for it and judges what it
 * printed. Canaries: a file in the owner config dir (read) and the owner's home (write);
 * `mustNotRead` adds the worker's deny paths. It runs in the Windows directory, which every user
 * may read, so it needs no grant.
 *
 * With `grants`, it first shows that taking a place back holds: a seed run as the crew user makes a
 * file in a place granted to it, the grant is taken back as after every run, and the probe must
 * then fail to change that file, its ACL, or add a file there.
 */
export async function probeWindowsSandbox(o: {
  stateRoot: string;
  credFile: string;
  user: string;
  ownerHome: string;
  ownerConfigDir: string;
  mustNotRead: readonly string[];
  /** The shared crew Claude config dir: its root and its plugins must not be writable. */
  crewConfigDir?: string;
  /** The crew user's grants: for the check of a place taken back. */
  grants?: WindowsGrants;
  proxyPort: number;
  env: Record<string, string>;
  spawn?: SpawnKeeper;
  node?: string;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const start = o.spawn ?? spawnKeeper;
  const name = `probe-${randomBytes(4).toString('hex')}`;
  const files = ownerFiles(o.stateRoot, name);
  const canary = join(o.ownerConfigDir, 'crew-probe-canary');
  const formerDir = join(o.stateRoot, 'tmp', `${name}-former`);
  writeStateFile(dirname(canary), canary, 'canary\n');
  /** One host run as the crew user; false when it did not finish in time. */
  const host = async (spec: HostSpec, revoke: readonly string[] = []): Promise<boolean> => {
    for (const f of Object.values(files)) removeStateEntry(o.stateRoot, f);
    const k = await start({
      args: keeperArgs({
        script: keeperFile(o.stateRoot),
        credFile: o.credFile,
        node: o.node ?? process.execPath,
        cwd: o.env.SystemRoot ?? o.env.SYSTEMROOT ?? 'C:\\Windows',
        out: files.out,
        err: files.err,
        user: o.user,
      }),
      env: powershellEnv(o.env),
      stdin: `${JSON.stringify(revoke)}\n${JSON.stringify(spec)}`,
      log: files.keeper,
      detached: false,
    });
    const timeout = sleep(o.timeoutMs ?? 120_000).then(() => 'timeout' as const);
    if ((await Promise.race([k.exited, timeout])) === 'timeout') {
      try {
        process.kill(k.pid);
      } catch {
        // gone already
      }
      return false;
    }
    return true;
  };
  const unfinished =
    'the Windows crew sandbox could not be shown to hold here: the probe as the crew user did not finish';
  try {
    const mark = randomBytes(8).toString('hex');
    let former: { dir: string; file: string } | undefined;
    if (o.grants !== undefined) {
      ensureStateDir(o.stateRoot, formerDir);
      const file = join(formerDir, 'made-by-the-crew-user.txt');
      await o.grants.grant([{ path: formerDir, rights: 'M' }]);
      const seeded = await host({ mode: 'seed', seed: file, env: o.env });
      await o.grants.revokeAll();
      if (!seeded) return unfinished;
      former = { dir: formerDir, file };
    }
    const spec: HostSpec = {
      mode: 'probe',
      probe: {
        user: o.user,
        mark,
        mustNotRead: [canary, o.ownerHome, ...o.mustNotRead],
        mustNotWrite: [
          join(o.ownerHome, `studio-probe-${mark}`),
          ...(o.crewConfigDir === undefined
            ? []
            : [
                join(o.crewConfigDir, `studio-probe-${mark}`),
                join(o.crewConfigDir, 'plugins', `studio-probe-${mark}`),
              ]),
        ],
        direct: { host: 'github.com', port: 443 },
        proxy: { port: o.proxyPort, refused: 'example.invalid' },
        ...(former === undefined ? {} : { former }),
      },
      env: { ...o.env, STUDIO_PROBE_MARK: mark },
    };
    if (!(await host(spec))) return unfinished;
    let results: ProbeResult[] | undefined;
    try {
      const raw = JSON.parse(readFileSync(files.out, 'utf8')) as unknown;
      results = Array.isArray(raw) ? (raw as ProbeResult[]) : undefined;
    } catch {
      results = undefined;
    }
    // Every check must be there: a host that left one out proves nothing about it.
    const missing = PROBE_CHECKS.find((c) => !(results ?? []).some((r) => r.check === c));
    if (results !== undefined && missing !== undefined) {
      return `the Windows crew sandbox could not be shown to hold here: the probe did not check ${missing}`;
    }
    return probeProblem(results);
  } finally {
    for (const f of Object.values(files)) removeStateEntry(o.stateRoot, f);
    removeStateEntry(o.stateRoot, formerDir);
    removeStateEntry(dirname(canary), canary);
  }
}

// ---- The worker's side -------------------------------------------------------------------------

/** Where the crew user's credential lies, encrypted for the owner (DPAPI): the owner config dir. */
export const credFileIn = (ownerConfigDir: string): string =>
  join(ownerConfigDir, 'windows-crew.xml');

/** The first `claude` on PATH (`.exe`, `.cmd`), as the owner would start it; undefined if none. */
export function findClaude(path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(';')) {
    if (dir === '') continue;
    for (const name of ['claude.exe', 'claude.cmd']) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * What the setup opens for reads: node, the Studio plugin, Claude Code, the toolchains, and of the
 * crew Claude config dir only the skills and plugins (each run gets a writable config dir of its
 * own in its HOME).
 */
export function setupReadPaths(o: {
  node: string;
  claude: string | undefined;
  toolchains: readonly string[];
  crewConfigDir: string;
}): string[] {
  const plugin = resolve(dirname(CREW_HOST_BIN), '..');
  return [
    ...new Set([
      dirname(o.node),
      plugin,
      ...(o.claude === undefined ? [] : [dirname(o.claude)]),
      ...o.toolchains,
      join(o.crewConfigDir, 'skills'),
      join(o.crewConfigDir, 'plugins'),
    ]),
  ];
}

/**
 * A run's own Claude config dir in its HOME, writable by the crew user: the skills and the plugin
 * lists of the shared crew config dir are copied (plain files and folders, no links); the plugins
 * themselves stay in the shared dir, which the crew user may only read.
 */
export function runConfigDir(homeDir: string, shared: string): string {
  const dir = join(homeDir, '.claude-run');
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  const copy = (from: string, to: string) => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(from);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const n of readdirSync(from)) copy(join(from, n), join(to, n));
    } else if (st.isFile()) {
      copyFileSync(from, to);
    }
  };
  copy(join(shared, 'skills'), join(dir, 'skills'));
  for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
    copy(join(shared, 'plugins', f), join(dir, 'plugins', f));
  }
  copy(join(shared, 'settings.json'), join(dir, 'settings.json'));
  return dir;
}

export interface WindowsWorker {
  claude: Claude;
  sandbox: {
    user: string;
    probe(mustNotRead: readonly string[]): Promise<string | undefined>;
    launch: { user: string; proxyPort: number; grant(grants: Grant[]): Promise<void> };
  };
  close(): Promise<void>;
}

/**
 * Everything a native Windows worker needs for its crews: the proxy, the Claude port that starts
 * crews as the crew user, the probe and the grants. `run` and `spawn` are seams for tests.
 */
export async function windowsWorker(o: {
  user: string;
  stateRoot: string;
  /** The owner's state root: the crew user's grant record and lock, shared by all projects. */
  ownerRoot: string;
  /** The shared crew Claude config dir: the probe proves the crew user cannot write it. */
  crewConfigDir: string;
  ownerHome: string;
  ownerConfigDir: string;
  networkAllow: readonly string[];
  env: Record<string, string | undefined>;
  startProxy: (allow: readonly string[]) => Promise<{ port: number; close(): Promise<void> }>;
  run?: RunFile;
  spawn?: SpawnKeeper;
}): Promise<WindowsWorker> {
  const run = o.run ?? runFile;
  const credFile = credFileIn(o.ownerConfigDir);
  const path = o.env.PATH ?? o.env.Path;
  const claudeBin = findClaude(path);
  const proxy = await o.startProxy([...o.networkAllow, ...CLAUDE_HOSTS]);
  const grants = new WindowsGrants({ ownerRoot: o.ownerRoot, user: o.user, run });
  const missing = (): string | undefined =>
    !existsSync(credFile)
      ? `no crew user credential at ${credFile}: run the script of studio worker windows-setup`
      : claudeBin === undefined
        ? 'claude is not on PATH'
        : undefined;
  return {
    claude: windowsClaude({
      stateRoot: o.stateRoot,
      credFile,
      claudeBin: claudeBin ?? 'claude',
      user: o.user,
      grants,
      run,
      ...(o.spawn === undefined ? {} : { spawn: o.spawn }),
    }),
    sandbox: {
      user: o.user,
      async probe(mustNotRead) {
        const why = missing();
        if (why !== undefined) return why;
        const tmp = ensureStateDir(o.stateRoot, join(o.stateRoot, 'tmp'));
        const probeEnv = windowsCrewEnv({
          proxyPort: proxy.port,
          homeDir: tmp,
          tmpDir: tmp,
          base: o.env,
        });
        return probeWindowsSandbox({
          stateRoot: o.stateRoot,
          credFile,
          user: o.user,
          ownerHome: o.ownerHome,
          ownerConfigDir: o.ownerConfigDir,
          mustNotRead,
          crewConfigDir: o.crewConfigDir,
          grants,
          proxyPort: proxy.port,
          env: { ...probeEnv, PATH: path ?? '' },
          ...(o.spawn === undefined ? {} : { spawn: o.spawn }),
        });
      },
      launch: { user: o.user, proxyPort: proxy.port, grant: (g) => grants.grant(g) },
    },
    close: () => proxy.close(),
  };
}
