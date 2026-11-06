// A relay worker on native Windows (src/relay-serve.ts). The lead logs in over SSH as a dedicated
// standard account whose key is forced to `studio relay serve`: no administrator over SSH. What the
// crew sandbox needs elevated, and only that, runs in a broker task an administrator created once:
// it ends every process of the crew user and writes what it found to a file only the relay account
// and administrators read. Everything else of the Windows crew sandbox (src/windows-sandbox.ts) is
// reused unchanged: the crew user, the keeper and its job object, the loopback egress proxy, the
// grants per run and the probe before every start.
//
// An SSH key logon has no password, so Windows cannot open the account's own DPAPI keys: the crew
// user's password is sealed for the machine (LocalMachine DPAPI) in a file whose ACL lets only the
// relay account, SYSTEM and administrators read it. Any process of those accounts on this machine
// can open it; the crew user cannot read the file.
import { join } from 'node:path';
import { ipv4 } from './egress-proxy.js';
import type { Neighbor } from './relay-hosts.js';
import { OUTSIDE, powershellEnv, psQuote, type RunFile } from './windows-sandbox.js';

/** The machine-wide home of a relay worker: config, state, the crew credential, the broker. */
export const relayHomeDefault = (env: Record<string, string | undefined>): string =>
  join(env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData', 'Studio', 'relay');

/** The crew user's password, sealed for this machine. */
export const machineCredFile = (home: string): string => join(home, 'crew-credential.bin');
/** The broker's script and the file it answers in; both written by the setup, elevated. */
export const brokerScriptFile = (home: string): string => join(home, 'broker', 'sweep.ps1');
export const brokerResultFile = (home: string): string => join(home, 'broker', 'sweep.json');
/** The key the lead logs in with, forced to `studio relay serve` (sshd `AuthorizedKeysFile`). */
export const authorizedKeysFile = (home: string): string => join(home, 'authorized_keys');

/** The command sshd forces for the relay account: this Node, this Studio, nothing from the client. */
export const forcedCommand = (node: string, studioBin: string, home: string): string =>
  `"${node}" "${studioBin}" relay serve --home "${home}"`;

/**
 * The block for `sshd_config` (at its end): the relay account may only run the forced command,
 * with no terminal, no forwarding of any kind and no password, and its keys come from a file of
 * the setup's, not from its profile.
 */
export function sshdMatchBlock(o: { relayUser: string; home: string; command: string }): string {
  // sshd on Windows reads forward slashes and expands __PROGRAMDATA__ itself.
  const keys = authorizedKeysFile(o.home).replace(/\\/g, '/');
  return [
    `Match User ${o.relayUser}`,
    `    AuthorizedKeysFile "${keys}"`,
    `    ForceCommand ${o.command}`,
    '    PermitTTY no',
    '    AllowTcpForwarding no',
    '    AllowStreamLocalForwarding no',
    '    X11Forwarding no',
    '    PermitTunnel no',
    '    AllowAgentForwarding no',
    '    PasswordAuthentication no',
    '    GatewayPorts no',
    '',
  ].join('\n');
}

/** The line for the authorized keys file: the forced command, plus `restrict` as an extra. */
export function authorizedKeyLine(o: { key: string; command: string }): string {
  if (
    !/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]{40,2000}={0,2}( [^\p{Cc}"]{0,100})?$/u.test(
      o.key,
    )
  ) {
    throw new Error('not an SSH public key line: <type> <base64> [comment]');
  }
  return `restrict,command="${o.command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" ${o.key}`;
}

/**
 * The broker's script: ends every process of the crew user (by SID, through CIM) and writes how
 * many it found and which are left, with the time, to its answer file. It takes no argument: the
 * crew user is written into it by the setup.
 */
export const brokerScript = (o: { crewUser: string; result: string }): string =>
  [
    '# Studio relay broker: ends every process of the crew user. Written by the setup; runs as SYSTEM.',
    "$ErrorActionPreference = 'Stop'",
    `$result = ${psQuote(o.result)}`,
    'try {',
    `  $sid = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, ${psQuote(o.crewUser)})).Translate([Security.Principal.SecurityIdentifier]).Value`,
    '  function Crew { @(Get-CimInstance Win32_Process | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $sid } catch { $false } }) }',
    '  $found = Crew',
    '  foreach ($p in $found) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    '  if ($found.Count -gt 0) { Start-Sleep -Milliseconds 800 }',
    '  $left = @(Crew | ForEach-Object { [int]$_.ProcessId })',
    "  $out = @{ at = (Get-Date).ToUniversalTime().ToString('o'); found = $found.Count; left = $left }",
    '} catch {',
    "  $out = @{ at = (Get-Date).ToUniversalTime().ToString('o'); error = $_.Exception.Message }",
    '}',
    'Set-Content -LiteralPath $result -Value (ConvertTo-Json -Compress $out) -Encoding UTF8',
  ].join('\r\n');

/**
 * Ends every process of the crew user through the broker task and reads its answer: one written
 * after this call started, with nothing left. Anything else refuses (fail closed).
 */
export async function brokerSweep(o: {
  run: RunFile;
  task: string;
  result: string;
  readFile: (file: string) => string | undefined;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  waitMs?: number;
}): Promise<void> {
  const started = o.now().getTime();
  const r = await o.run('schtasks.exe', ['/Run', '/TN', o.task]);
  if (r.code !== 0) {
    throw new Error(
      `cannot start the broker task ${o.task} (schtasks exit ${r.code}); run the script of studio relay setup again, elevated`,
    );
  }
  const until = started + (o.waitMs ?? 60_000);
  for (;;) {
    const text = o.readFile(o.result)?.replace(/^\uFEFF/, '');
    let answer: { at?: unknown; left?: unknown; error?: unknown } | undefined;
    try {
      answer = text === undefined ? undefined : (JSON.parse(text) as typeof answer);
    } catch {
      answer = undefined;
    }
    const at = typeof answer?.at === 'string' ? Date.parse(answer.at) : Number.NaN;
    // Its own clock and this one are the same machine's; a second of slack for rounding.
    if (answer !== undefined && at >= started - 1000) {
      if (typeof answer.error === 'string') {
        throw new Error(
          `the broker could not end the crew user's processes: ${answer.error.slice(0, 200)}`,
        );
      }
      const left = Array.isArray(answer.left) ? answer.left : undefined;
      if (left === undefined) throw new Error('the broker answered in an unknown shape');
      if (left.length > 0) {
        throw new Error(
          `processes of the crew user are still running (${left.join(', ')}) and the broker cannot end them`,
        );
      }
      return;
    }
    if (o.now().getTime() >= until) throw new Error(`the broker task ${o.task} did not answer`);
    await o.sleep(500);
  }
}

/** A PowerShell run of the relay account with a JSON answer; undefined when it failed. */
async function psJson(run: RunFile, script: string): Promise<unknown> {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: powershellEnv(process.env),
    timeoutMs: 60_000,
  });
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout.trim() || 'null');
  } catch {
    return undefined;
  }
}

/**
 * The WebClient service turns `\\host@80\` paths into WebDAV connections the crew user's firewall
 * rule does not hold: it must be stopped and disabled. A machine without it is fine.
 */
export async function webClientProblem(run: RunFile): Promise<string | undefined> {
  const s = (await psJson(
    run,
    '$s = Get-Service -Name WebClient -ErrorAction SilentlyContinue; if ($null -eq $s) { \'{"exists":false}\' } else { ConvertTo-Json -Compress @{ exists = $true; status = [string]$s.Status; start = [string]$s.StartType } }',
  )) as { exists?: unknown; status?: unknown; start?: unknown } | undefined;
  if (s === undefined || s === null) return 'the WebClient service cannot be read';
  if (s.exists === false) return undefined;
  if (s.status !== 'Stopped' || s.start !== 'Disabled') {
    return `the WebClient service is ${String(s.status)} with start type ${String(s.start)}: WebDAV paths would pass the crew user's firewall rule; stop and disable it (Stop-Service WebClient; Set-Service WebClient -StartupType Disabled)`;
  }
  return undefined;
}

export interface Listener {
  protocol: 'tcp' | 'udp';
  address: string;
  port: number;
  pid: number;
}

/** Addresses a socket bound to answers on loopback from: loopback itself and the wildcards. */
export const onLoopback = (address: string): boolean =>
  /^127\./.test(address) || address === '::1' || address === ipv4(0, 0, 0, 0) || address === '::';

/** Every TCP and UDP listener of this machine on loopback (v4 and v6, wildcards included). */
export async function loopbackListeners(run: RunFile): Promise<Listener[] | undefined> {
  const raw = await psJson(
    run,
    "$t = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{ p = 'tcp'; a = [string]$_.LocalAddress; n = [int]$_.LocalPort; o = [int]$_.OwningProcess } }); $u = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object { @{ p = 'udp'; a = [string]$_.LocalAddress; n = [int]$_.LocalPort; o = [int]$_.OwningProcess } }); ConvertTo-Json -Compress -InputObject @($t + $u)",
  );
  if (!Array.isArray(raw)) return undefined;
  const out: Listener[] = [];
  for (const x of raw as { p?: unknown; a?: unknown; n?: unknown; o?: unknown }[]) {
    if ((x.p !== 'tcp' && x.p !== 'udp') || typeof x.a !== 'string' || typeof x.n !== 'number') {
      continue;
    }
    if (!onLoopback(x.a)) continue;
    out.push({ protocol: x.p, address: x.a, port: x.n, pid: typeof x.o === 'number' ? x.o : 0 });
  }
  return out;
}

/** The neighbor table (IPv4), as Windows keeps it; undefined when it cannot be read. */
export async function neighborTable(run: RunFile): Promise<Neighbor[] | undefined> {
  const raw = await psJson(
    run,
    'ConvertTo-Json -Compress -InputObject @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object { @{ a = [string]$_.IPAddress; s = [string]$_.State } })',
  );
  if (!Array.isArray(raw)) return undefined;
  return (raw as { a?: unknown; s?: unknown }[]).flatMap((x) =>
    typeof x.a === 'string' && typeof x.s === 'string' ? [{ address: x.a, state: x.s }] : [],
  );
}

/** `tailscale status --json`, or undefined when Tailscale is not installed or not running. */
export async function tailscaleStatus(run: RunFile): Promise<string | undefined> {
  const r = await run('tailscale', ['status', '--json'], { timeoutMs: 20_000 });
  return r.code === 0 ? r.stdout : undefined;
}

/**
 * Whether the sealed crew credential opens under this logon. Only a length comes back, never the
 * password; anything else is the refusal line.
 */
export async function machineCredProblem(run: RunFile, file: string): Promise<string | undefined> {
  const n = await psJson(
    run,
    `Add-Type -AssemblyName System.Security; $b = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes(${psQuote(file)}), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine); $n = $b.Length; [Array]::Clear($b, 0, $b.Length); $n`,
  );
  return typeof n === 'number' && n > 0
    ? undefined
    : `the crew user's credential (${file}) cannot be opened under this logon; run the script of studio relay setup again, elevated`;
}

/**
 * The one-time setup of a Windows relay worker, for an administrator to run in an elevated
 * PowerShell. It creates the relay account (standard user, never an administrator; SSH only), the
 * crew user with a password sealed for this machine, the outbound firewall rule of the crew user,
 * the broker task (SYSTEM; only the relay account may start it), the ACLs of the relay home, read
 * grants for the toolchains, and stops and disables WebClient. It prints the sshd block, and with
 * a lead key, writes its line. sshd_config itself is not changed: the owner adds the block.
 */
export function relaySetupScript(o: {
  relayUser: string;
  crewUser: string;
  home: string;
  task: string;
  readPaths: readonly string[];
  command: string;
  /** The lead's public key line, to authorize with the forced command. */
  leadKey?: string;
  /** Plugin setup for the crew Claude config dir of the relay home. */
  pluginSetup: string;
}): string {
  for (const u of [o.relayUser, o.crewUser]) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(u)) throw new Error(`not a local user name: ${u}`);
  }
  if (!/^[A-Za-z0-9 _-]{1,64}$/.test(o.task)) throw new Error(`not a task name: ${o.task}`);
  const list = (ps: readonly string[]) => `@(${ps.map(psQuote).join(', ')})`;
  const keyLine =
    o.leadKey === undefined ? undefined : authorizedKeyLine({ key: o.leadKey, command: o.command });
  const block = sshdMatchBlock({ relayUser: o.relayUser, home: o.home, command: o.command });
  return `#Requires -RunAsAdministrator
# Studio: the one-time setup of this Windows relay worker. Run it in an elevated Windows PowerShell
# (powershell.exe). Run it again after an update of Studio or of the plugins: it repairs and updates.
# Nothing here leaves this machine.
$ErrorActionPreference = 'Stop'
$relay = ${psQuote(o.relayUser)}
$crew = ${psQuote(o.crewUser)}
$home_ = ${psQuote(o.home)}
$task = ${psQuote(o.task)}
function NewSecret { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) + 'aA1!' }
function EnsureUser([string]$name, [string]$what, [string]$plain) {
  $u = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $u) {
    if (-not $plain) { $plain = NewSecret }
    $u = New-LocalUser -Name $name -Password (ConvertTo-SecureString $plain -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description $what
  } elseif ($plain) {
    Set-LocalUser -Name $name -Password (ConvertTo-SecureString $plain -AsPlainText -Force)
  }
  # Users only, never Administrators (groups by SID: their names depend on the language).
  $users = Get-LocalGroup -SID 'S-1-5-32-545'
  if (-not (Get-LocalGroupMember -Group $users | Where-Object { $_.SID -eq $u.SID })) { Add-LocalGroupMember -Group $users -Member $u }
  $admins = Get-LocalGroup -SID 'S-1-5-32-544'
  if (Get-LocalGroupMember -Group $admins | Where-Object { $_.SID -eq $u.SID }) { throw "$name is an administrator: remove it from that group first" }
  return $u
}
# The relay account: a standard user the lead logs in as over SSH, with a password nobody sees.
$relaySid = (EnsureUser $relay 'Studio relay (SSH, forced command)' $null).SID.Value
# The relay home: the relay account may change it, the crew user gets nothing (grants per run).
New-Item -ItemType Directory -Force -Path $home_, (Join-Path $home_ 'broker') | Out-Null
icacls $home_ /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$($relaySid):(OI)(CI)M" /Q | Out-Null
# The broker's folder: written by SYSTEM and administrators only, read by the relay account.
$broker = Join-Path $home_ 'broker'
icacls $broker /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$($relaySid):(OI)(CI)RX" /Q | Out-Null
# The crew user, its password sealed for this machine (LocalMachine DPAPI): an SSH key logon cannot
# open the relay account's own DPAPI keys. Only SYSTEM, administrators and the relay account read it.
$credFile = ${psQuote(machineCredFile(o.home))}
$plain = $null
if (-not (Test-Path -LiteralPath $credFile) -or $null -eq (Get-LocalUser -Name $crew -ErrorAction SilentlyContinue)) {
  $plain = NewSecret
}
$crewSid = (EnsureUser $crew 'Studio crew sandbox' $plain).SID.Value
if ($plain) {
  Add-Type -AssemblyName System.Security
  $sealed = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  $plain = $null
  [IO.File]::WriteAllBytes($credFile, $sealed)
}
icacls $credFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($relaySid):R" /Q | Out-Null
# No direct network for the crew user: every outbound connection to anything but loopback.
$rule = 'Studio crew ' + $crew + ': no direct network'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;$crewSid)" -RemoteAddress @(${OUTSIDE.map(psQuote).join(', ')}) | Out-Null
# The crew user logs on only through the keeper: no batch job, service, network or remote desktop.
$cfg = Join-Path $env:TEMP ('studio-rights-' + [Guid]::NewGuid().ToString('N') + '.inf')
$db = [IO.Path]::ChangeExtension($cfg, '.sdb')
secedit /export /cfg $cfg /areas USER_RIGHTS | Out-Null
$lines = [Collections.Generic.List[string]](Get-Content -LiteralPath $cfg)
$at = $lines.IndexOf('[Privilege Rights]')
if ($at -lt 0) { throw 'secedit gave no [Privilege Rights] section' }
foreach ($right in @('SeDenyBatchLogonRight', 'SeDenyServiceLogonRight', 'SeDenyNetworkLogonRight', 'SeDenyRemoteInteractiveLogonRight')) {
  $i = -1
  for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k] -like "$right *") { $i = $k } }
  if ($i -lt 0) { $lines.Insert($at + 1, "$right = *$crewSid") }
  elseif ($lines[$i] -notlike "**$crewSid*") { $lines[$i] = $lines[$i] + ",*$crewSid" }
}
Set-Content -LiteralPath $cfg -Value $lines -Encoding Unicode
secedit /configure /db $db /cfg $cfg /areas USER_RIGHTS /quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw "secedit could not set the logon rights ($LASTEXITCODE)" }
Remove-Item -LiteralPath $cfg, $db -ErrorAction SilentlyContinue
# The broker: ends every process of the crew user, as SYSTEM, with no argument. Only the relay
# account (and administrators) may start it; it answers in a file the relay account can only read.
$script = ${psQuote(brokerScriptFile(o.home))}
Set-Content -LiteralPath $script -Encoding UTF8 -Value @'
${brokerScript({ crewUser: o.crewUser, result: brokerResultFile(o.home) })}
'@
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\\')
$def = $service.NewTask(0)
$def.Settings.ExecutionTimeLimit = 'PT5M'
$def.Settings.MultipleInstances = 2
$action = $def.Actions.Create(0)
$action.Path = 'powershell.exe'
$action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"'
# SYSTEM runs it; SYSTEM and administrators own it; the relay account may read and run it.
$sddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$relaySid)"
$null = $folder.RegisterTaskDefinition($task, $def, 6, 'SYSTEM', $null, 5, $sddl)
# WebDAV paths (\\\\host@80\\) pass the crew user's firewall rule through the WebClient service:
# it is stopped and disabled.
Write-Output 'Stopping and disabling the WebClient service (WebDAV), which the crew sandbox does not hold.'
if (Get-Service -Name WebClient -ErrorAction SilentlyContinue) {
  Stop-Service -Name WebClient -Force -ErrorAction SilentlyContinue
  Set-Service -Name WebClient -StartupType Disabled
}
# Read, never write, for the crew user on Node.js, Studio, Claude Code and the toolchains.
foreach ($p in ${list(o.readPaths)}) {
  if (Test-Path -LiteralPath $p) { icacls $p /grant "\${crew}:(OI)(CI)RX" /Q | Out-Null }
}
# The pinned plugins in the crew Claude config dir of the relay home.
${o.pluginSetup}
${
  keyLine === undefined
    ? '# No lead key given: run studio relay setup --lead-key "<public key line>" to authorize one.'
    : `$keys = ${psQuote(authorizedKeysFile(o.home))}
Set-Content -LiteralPath $keys -Encoding ASCII -Value ${psQuote(keyLine)}
icacls $keys /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($relaySid):R" /Q | Out-Null`
}
Write-Output 'Add this block at the end of sshd_config (C:\\ProgramData\\ssh\\sshd_config), then Restart-Service sshd:'
Write-Output @'
${block}'@
Write-Output 'Host key to pin on the lead (workers.relay.<label>.host_key):'
Get-Content -LiteralPath (Join-Path $env:ProgramData 'ssh\\ssh_host_ed25519_key.pub') | ForEach-Object { ($_ -split ' ')[0..1] -join ' ' }
Write-Output "Studio relay worker is ready: relay account $relay, crew user $crew."
`;
}
