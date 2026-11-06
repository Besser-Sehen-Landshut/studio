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
import { win32 } from 'node:path';
import { ipv4 } from './egress-proxy.js';
import type { Neighbor } from './relay-hosts.js';
import { OUTSIDE, powershellEnv, psQuote, type RunFile } from './windows-sandbox.js';

/** Every path here is a Windows path, also where tests run elsewhere. */
const join = win32.join;

/**
 * Where a relay worker keeps what the relay account writes: its config and state, each in its own
 * folder the relay account may fill but never rename or remove. The folder itself, and everything
 * above it, only administrators may change.
 */
export const relayHomeDefault = (env: Record<string, string | undefined>): string =>
  join(env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData', 'Studio', 'relay');

/**
 * The admin-only tree of a relay worker: the copies of Node.js and Studio the forced command runs,
 * the sealed crew credential, the broker's answer and the authorized keys. Only SYSTEM and
 * administrators write anything here; the relay account reads what it needs.
 */
export const relayMachineDefault = (env: Record<string, string | undefined>): string =>
  join(env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files', 'Studio', 'relay');

/** The crew user's password, sealed for this machine. */
export const machineCredFile = (machine: string): string => join(machine, 'crew-credential.bin');
/** The file the broker answers in; its folder only SYSTEM and administrators write. */
export const brokerResultFile = (machine: string): string => join(machine, 'broker', 'answer.json');
/** The keys the leads log in with, each forced to `studio relay serve` (sshd `AuthorizedKeysFile`). */
export const authorizedKeysFile = (machine: string): string => join(machine, 'authorized_keys');
/** The Node.js and the Studio the forced command runs: admin-only copies. */
export const machineNode = (machine: string): string => join(machine, 'node', 'node.exe');
export const machineStudio = (machine: string): string => join(machine, 'studio');
export const machineStudioBin = (machine: string): string =>
  join(machine, 'studio', 'bin', 'studio');

/** The command sshd forces for the relay account: the admin-only Node and Studio, nothing else. */
export const forcedCommand = (machine: string, home: string): string =>
  `"${machineNode(machine)}" "${machineStudioBin(machine)}" relay serve --home "${home}"`;

/**
 * The block for `sshd_config` (at its end): the relay account may only run the forced command,
 * with no terminal, no forwarding of any kind and no password; its keys come from the admin-only
 * tree, not from its profile. `ExposeAuthInfo` tells the forced command which key logged in, so
 * it serves that key's lead only.
 */
export function sshdMatchBlock(o: { relayUser: string; machine: string; command: string }): string {
  const keys = authorizedKeysFile(o.machine).replace(/\\/g, '/');
  return [
    `Match User ${o.relayUser}`,
    `    AuthorizedKeysFile "${keys}"`,
    `    ForceCommand ${o.command}`,
    '    ExposeAuthInfo yes',
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

/** A lead's name as its key's comment carries it: `studio-relay-<lead>`. */
export const keyTag = (lead: string): string => `studio-relay-${lead}`;

/** The line of one lead's key: the forced command naming that lead, plus `restrict` as an extra. */
export function authorizedKeyLine(o: { key: string; command: string; lead: string }): string {
  const key = o.key.trim().split(/\s+/).slice(0, 2).join(' ');
  if (
    !/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]{40,2000}={0,2}$/.test(key)
  ) {
    throw new Error('not an SSH public key line: <type> <base64> [comment]');
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(o.lead)) throw new Error('not a lead name');
  const command = `${o.command} --lead ${o.lead}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `restrict,command="${command}" ${key} ${keyTag(o.lead)}`;
}

/** The lead a key line names by its comment; `default` for a key without Studio's tag. */
export function leadOfKeyComment(comment: string | undefined): string {
  const m = /^studio-relay-([a-z][a-z0-9-]{0,31})$/.exec(comment ?? '');
  return m?.[1] ?? 'default';
}

/**
 * The lead of the key this SSH session logged in with: sshd (`ExposeAuthInfo`) names the key in
 * the file `SSH_USER_AUTH` points to; the admin-only authorized keys file says whose it is.
 * Undefined when either cannot tell.
 */
export function leadFromAuthInfo(
  authInfo: string | undefined,
  keysText: string | undefined,
): string | undefined {
  if (authInfo === undefined || keysText === undefined) return undefined;
  const used = /^publickey (\S+) (\S+)/m.exec(authInfo);
  if (used === null) return undefined;
  for (const line of keysText.split(/\r?\n/)) {
    const m =
      /(?:^|\s)(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?: (\S+))?\s*$/.exec(
        line,
      );
    if (m !== null && m[1] === used[1] && m[2] === used[2]) {
      const tag = /^studio-relay-([a-z][a-z0-9-]{0,31})$/.exec(m[3] ?? '');
      return tag?.[1];
    }
  }
  return undefined;
}

/**
 * The broker: ends every process of the crew user (by SID, through CIM), then takes away what a
 * crew could have left in the crew user's profile to run in the next job (the AutoRun of cmd, its
 * own environment values and Run keys, the Startup folder), and writes what it found, with the
 * time, to its answer file. It is the task's action itself (no script file anyone could change)
 * and takes no argument: the crew user and the answer file are written into it by the setup.
 */
export const brokerScript = (o: { crewUser: string; result: string }): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `$result = ${psQuote(o.result)}`,
    'try {',
    `  $sid = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, ${psQuote(o.crewUser)})).Translate([Security.Principal.SecurityIdentifier]).Value`,
    '  function Crew { @(Get-CimInstance Win32_Process | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $sid } catch { $false } }) }',
    '  $found = Crew',
    '  foreach ($p in $found) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    '  if ($found.Count -gt 0) { Start-Sleep -Milliseconds 800 }',
    '  $left = @(Crew | ForEach-Object { [int]$_.ProcessId })',
    '  $reset = $false',
    '  $profile = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | Select-Object -First 1).LocalPath',
    '  if ($left.Count -eq 0 -and $profile) {',
    '    $hive = "Registry::HKEY_USERS\\$sid"',
    '    $loaded = Test-Path -LiteralPath $hive',
    "    if (-not $loaded) { & reg.exe load \"HKU\\$sid\" (Join-Path $profile 'NTUSER.DAT') | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'cannot load the crew user profile' } }",
    '    try {',
    '      Remove-ItemProperty -LiteralPath "$hive\\Software\\Microsoft\\Command Processor" -Name AutoRun -ErrorAction SilentlyContinue',
    '      $envKey = "$hive\\Environment"',
    "      if (Test-Path -LiteralPath $envKey) { foreach ($n in (Get-Item -LiteralPath $envKey).GetValueNames()) { if ($n -notin @('TEMP', 'TMP')) { Remove-ItemProperty -LiteralPath $envKey -Name $n } } }",
    '      foreach ($k in @(\'Software\\Microsoft\\Windows\\CurrentVersion\\Run\', \'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce\')) { if (Test-Path -LiteralPath "$hive\\$k") { Remove-Item -LiteralPath "$hive\\$k" -Recurse -Force } }',
    '    } finally {',
    '      if (-not $loaded) { [GC]::Collect(); [GC]::WaitForPendingFinalizers(); & reg.exe unload "HKU\\$sid" | Out-Null }',
    '    }',
    "    $startup = Join-Path $profile 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup'",
    '    if (Test-Path -LiteralPath $startup) { Get-ChildItem -LiteralPath $startup -Force | Remove-Item -Recurse -Force }',
    '    $reset = $true',
    '  }',
    "  $out = @{ at = (Get-Date).ToUniversalTime().ToString('o'); found = $found.Count; left = $left; reset = $reset }",
    '} catch {',
    "  $out = @{ at = (Get-Date).ToUniversalTime().ToString('o'); error = $_.Exception.Message }",
    '}',
    'Set-Content -LiteralPath $result -Value (ConvertTo-Json -Compress $out) -Encoding UTF8',
  ].join('\r\n');

/** The broker as a task action: PowerShell with the script encoded, so no file holds it. */
export const brokerArguments = (o: { crewUser: string; result: string }): string =>
  `-NoProfile -NonInteractive -EncodedCommand ${Buffer.from(brokerScript(o), 'utf16le').toString('base64')}`;

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
 * PowerShell that writes a file of the admin-only tree whole: a temporary file in the same folder
 * gets its final ACL first, then replaces the old file in one step (`[IO.File]::Replace`, or a
 * move when there is none yet). `$relaySid` must be set. The lines are quoted one by one.
 */
export function adminFileSnippet(o: {
  file: string;
  lines: readonly string[];
  readers: 'relay' | 'none';
}): string {
  const text = `(@(${o.lines.map(psQuote).join(', ')}) | ForEach-Object { $_ + [char]13 + [char]10 }) -join ''`;
  const relay = o.readers === 'relay' ? ` "*$($relaySid):R"` : '';
  return `$target = ${psQuote(o.file)}
$tmp = Join-Path (Split-Path -Parent $target) ('.' + [Guid]::NewGuid().ToString('N') + '.tmp')
[IO.File]::WriteAllText($tmp, ${text}, (New-Object Text.ASCIIEncoding))
icacls $tmp /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F'${relay} /Q | Out-Null
if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $tmp -Force; throw "cannot set the ACL of $target" }
icacls $tmp /setowner '*S-1-5-32-544' /Q | Out-Null
if (Test-Path -LiteralPath $target) { [IO.File]::Replace($tmp, $target, $null) } else { [IO.File]::Move($tmp, $target) }`;
}

/**
 * The one-time setup of a Windows relay worker, for an administrator to run in an elevated
 * PowerShell. It refuses a path of Studio's that holds a reparse point or a folder another account
 * owns; makes the admin-only tree (copies of Node.js and Studio the forced command runs, the sealed
 * crew credential, the broker's answer folder, the authorized keys) and the relay home (only its
 * `state` and `config` folders take the relay account's writes, and it can rename or remove
 * neither); creates the relay account (standard user, never an administrator; SSH only), the crew
 * user, the crew user's outbound firewall rule and denied logons, the broker task (SYSTEM, its
 * script in the action, only the relay account may start it), read grants for the toolchains, and
 * stops and disables WebClient. With a lead key, it writes the authorized keys. It prints the sshd
 * block; sshd_config itself is not changed here.
 */
export function relaySetupScript(o: {
  relayUser: string;
  crewUser: string;
  home: string;
  machine: string;
  task: string;
  readPaths: readonly string[];
  /** The Node.js and the Studio plugin folder to copy into the admin-only tree. */
  source: { node: string; studio: string };
  /**
   * `studio relay install`: also the prerequisites (winget, the OpenSSH server), the sshd block
   * written into sshd_config, and an inbound rule that lets only `scope` reach sshd.
   */
  install?: RelayInstall;
}): string {
  for (const u of [o.relayUser, o.crewUser]) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(u)) throw new Error(`not a local user name: ${u}`);
  }
  if (!/^[A-Za-z0-9 _-]{1,64}$/.test(o.task)) throw new Error(`not a task name: ${o.task}`);
  const list = (ps: readonly string[]) => `@(${ps.map(psQuote).join(', ')})`;
  const command = forcedCommand(o.machine, o.home);
  const block = sshdMatchBlock({ relayUser: o.relayUser, machine: o.machine, command });
  const pluginSetup = `$env:XDG_CONFIG_HOME = ${psQuote(join(o.home, 'config'))}; $env:XDG_STATE_HOME = ${psQuote(join(o.home, 'state'))}; & ${psQuote(machineNode(o.machine))} ${psQuote(machineStudioBin(o.machine))} account setup-plugins`;
  return `${o.install === undefined ? '' : installHead(o.install)}#Requires -RunAsAdministrator
# Studio: the setup of this Windows relay worker. Run it in an elevated Windows PowerShell
# (powershell.exe). Run it again after an update of Studio or of the plugins: it repairs and updates.
# Nothing here leaves this machine.
$ErrorActionPreference = 'Stop'
$relay = ${psQuote(o.relayUser)}
$crew = ${psQuote(o.crewUser)}
$home_ = ${psQuote(o.home)}
$machine = ${psQuote(o.machine)}
$task = ${psQuote(o.task)}
$adminSids = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# Every folder of Studio's, from the drive down: no reparse point anywhere, and none another account
# owns (a folder planted there before would keep its owner's rights).
function SafeFolder([string]$path, [string]$top) {
  $walk = $path
  while ($walk) {
    if (Test-Path -LiteralPath $walk) {
      $item = Get-Item -LiteralPath $walk -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$walk is a reparse point: refusing to set up Studio there" }
      if ($walk.Length -gt $top.Length -and $walk.StartsWith($top, [StringComparison]::OrdinalIgnoreCase)) {
        $owner = (Get-Acl -LiteralPath $walk).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($adminSids -notcontains $owner) { throw "$walk is owned by $owner, not by administrators: remove it, then run this again" }
      }
    }
    $up = Split-Path -Parent $walk
    if (-not $up -or $up -eq $walk) { break }
    $walk = $up
  }
}
function LockFolder([string]$path, [string[]]$grants) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  icacls $path /setowner '*S-1-5-32-544' /Q | Out-Null
  icacls $path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' @grants /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "cannot set the ACL of $path" }
}
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
$dataStudio = Split-Path -Parent $home_
$filesStudio = Split-Path -Parent $machine
SafeFolder $home_ (Split-Path -Parent $dataStudio)
SafeFolder $machine (Split-Path -Parent $filesStudio)
# The relay account: a standard user the lead logs in as over SSH, with a password nobody sees.
$relaySid = (EnsureUser $relay 'Studio relay (SSH, forced command)' $null).SID.Value
$plain = $null
$credFile = ${psQuote(machineCredFile(o.machine))}
if (-not (Test-Path -LiteralPath $credFile) -or $null -eq (Get-LocalUser -Name $crew -ErrorAction SilentlyContinue)) {
  $plain = NewSecret
}
$crewSid = (EnsureUser $crew 'Studio crew sandbox' $plain).SID.Value
# The admin-only tree: administrators and SYSTEM write; the relay account reads; the crew user reads
# Node.js and Studio only.
LockFolder $filesStudio @("*$($relaySid):(OI)(CI)RX")
LockFolder $machine @("*$($relaySid):(OI)(CI)RX")
LockFolder (Join-Path $machine 'broker') @("*$($relaySid):(OI)(CI)RX")
# The record of pairings (studio relay install --pair): administrators write it, the relay account
# reads it for the proofs of a pairing.
LockFolder (Join-Path $machine 'pairing') @("*$($relaySid):(OI)(CI)RX")
LockFolder (Join-Path $machine 'node') @("*$($relaySid):(OI)(CI)RX", "*$($crewSid):(OI)(CI)RX")
LockFolder (Join-Path $machine 'studio') @("*$($relaySid):(OI)(CI)RX", "*$($crewSid):(OI)(CI)RX")
# The copies the forced command runs: never the files of an account that can change them.
Copy-Item -LiteralPath ${psQuote(o.source.node)} -Destination ${psQuote(machineNode(o.machine))} -Force
& robocopy.exe ${psQuote(o.source.studio)} ${psQuote(machineStudio(o.machine))} /MIR /XD node_modules .git .worktrees /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "cannot copy Studio into $machine (robocopy $LASTEXITCODE)" }
icacls ${psQuote(machineStudio(o.machine))} /reset /T /C /Q | Out-Null
# The relay home: the relay account may fill state and config, never rename or remove them, and
# nothing else of the home.
LockFolder $dataStudio @("*$($relaySid):RX")
LockFolder $home_ @("*$($relaySid):RX")
foreach ($sub in @('state', 'config')) {
  LockFolder (Join-Path $home_ $sub) @("*$($relaySid):(RX,WD,AD)", "*$($relaySid):(OI)(CI)(IO)M")
}
# The crew user's password, sealed for this machine (LocalMachine DPAPI): an SSH key logon cannot
# open the relay account's own DPAPI keys. Only SYSTEM, administrators and the relay account read it.
if ($plain) {
  Add-Type -AssemblyName System.Security
  $sealed = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  $plain = $null
  $tmp = Join-Path $machine ('.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllBytes($tmp, $sealed)
  icacls $tmp /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($relaySid):R" /Q | Out-Null
  if (Test-Path -LiteralPath $credFile) { [IO.File]::Replace($tmp, $credFile, $null) } else { [IO.File]::Move($tmp, $credFile) }
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
# The broker: ends every process of the crew user and resets its profile, as SYSTEM, with no
# argument; its script is the action itself, so no file of it exists. Only the relay account (and
# administrators) may start it; it answers in a folder the relay account can only read.
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\\')
$def = $service.NewTask(0)
$def.Settings.ExecutionTimeLimit = 'PT5M'
$def.Settings.MultipleInstances = 2
$action = $def.Actions.Create(0)
$action.Path = 'powershell.exe'
$action.Arguments = ${psQuote(brokerArguments({ crewUser: o.crewUser, result: brokerResultFile(o.machine) }))}
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
# Read, never write, for the crew user on Claude Code and the toolchains.
foreach ($p in ${list(o.readPaths)}) {
  if (Test-Path -LiteralPath $p) { icacls $p /grant "\${crew}:(OI)(CI)RX" /Q | Out-Null }
}
# The pinned plugins in the crew Claude config dir of the relay home.
${pluginSetup}
${o.install === undefined ? setupTail(block) : installTail(block, o.install)}`;
}

/** Where sshd may be reached from: the Tailscale interface, another interface, or a source range. */
export type SshdScope = { tailscale: true } | { interface: string } | { source: string };

export interface RelayInstall {
  port: number;
  scope: SshdScope;
  /** Keep password logons of sshd for other accounts; by default sshd takes keys only. */
  keepPasswords?: boolean;
  /** Stop and disable the print spooler, which acts for users in a service. */
  disableSpooler?: boolean;
}

const setupTail = (
  block: string,
) => `Write-Output 'Add this block at the end of sshd_config (C:\\ProgramData\\ssh\\sshd_config), then Restart-Service sshd:'
Write-Output @'
${block}'@
Write-Output 'Authorize the lead with studio relay install --pair "<line>" (the line studio relay pair prints on the lead).'
Write-Output "Studio relay worker is ready: relay account $relay, crew user $crew."
`;

/**
 * Writes the relay account's authorized keys file whole: a temporary file in the same folder gets
 * its ACL first (SYSTEM and administrators full control, the relay account read, nothing
 * inherited), then replaces the old file in one rename. Run elevated.
 */
export function authorizedKeysScript(o: {
  file: string;
  lines: readonly string[];
  relayUser: string;
}): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(o.relayUser)) throw new Error('not a local user name');
  return `$ErrorActionPreference = 'Stop'
$relaySid = (Get-LocalUser -Name ${psQuote(o.relayUser)}).SID.Value
${adminFileSnippet({ file: o.file, lines: o.lines, readers: 'relay' })}
`;
}

/**
 * The start of `studio relay install`: sshd stays stopped and the rule OpenSSH adds for every
 * address stays off until the end, where everything checked out; whatever fails on the way leaves
 * sshd stopped and every inbound rule for it off. Then the prerequisites: Git and Claude Code
 * through winget (for the whole machine), the OpenSSH server as the Windows capability it is.
 */
const installHead = (i: RelayInstall) => `#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ok = $false
function SshdOff {
  Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue
  Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
}
try {
function Fresh { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Need([string]$what, [scriptblock]$have, [string]$id) {
  if (& $have) { Write-Output "ok: $what"; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "$what is missing and winget is not there to install it; install $what by hand" }
  Write-Output "installing: $what (winget $id)"
  winget install --id $id --exact --silent --scope machine --accept-package-agreements --accept-source-agreements | Out-Null
  Fresh
  if (-not (& $have)) { throw "$what is still missing after winget install $id; install it by hand" }
}
Need 'Git' { Get-Command git -ErrorAction SilentlyContinue } 'Git.Git'
Need 'Claude Code' { Get-Command claude -ErrorAction SilentlyContinue } 'Anthropic.ClaudeCode'
$ssh = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1
if ($null -eq $ssh) { throw 'this Windows has no OpenSSH server capability' }
if ($ssh.State -ne 'Installed') { Write-Output 'installing: OpenSSH server'; Add-WindowsCapability -Online -Name $ssh.Name | Out-Null } else { Write-Output 'ok: OpenSSH server' }
SshdOff
Set-Service -Name sshd -StartupType Automatic
${
  i.disableSpooler === true
    ? `Write-Output 'Stopping and disabling the print spooler (--disable-spooler).'
Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue
Set-Service -Name Spooler -StartupType Disabled`
    : ''
}
`;

/**
 * The end of `studio relay install`: the sshd block between Studio's markers at the end of
 * sshd_config and, unless password logons are kept for other accounts, keys only for everyone at
 * its top (sshd takes the first value it reads). The file is checked with `sshd -t`, run so that a
 * start that fails counts as a failure; a config sshd refuses is put back byte for byte. Only then
 * does sshd start, reachable only from the scope.
 */
function installTail(block: string, i: RelayInstall): string {
  if (!Number.isInteger(i.port) || i.port < 1 || i.port > 65535) throw new Error('not a port');
  const scope =
    'tailscale' in i.scope
      ? `$ts = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like '*Tailscale*' -or $_.Name -like 'Tailscale*' } | Select-Object -First 1
if ($null -eq $ts) { throw 'no Tailscale interface here: run studio relay install --interface <name> or --source <range>' }
$scope = @{ InterfaceAlias = $ts.Name }
$where = 'the Tailscale interface ' + $ts.Name`
      : 'interface' in i.scope
        ? `$scope = @{ InterfaceAlias = ${psQuote(i.scope.interface)} }
$where = 'the interface ' + ${psQuote(i.scope.interface)}`
        : `$scope = @{ RemoteAddress = ${psQuote(i.scope.source)} }
$where = 'the source ' + ${psQuote(i.scope.source)}`;
  const global =
    i.keepPasswords === true
      ? ''
      : `# studio relay begin global
PasswordAuthentication no
KbdInteractiveAuthentication no
# studio relay end global
`;
  return `$conf = Join-Path $env:ProgramData 'ssh\\sshd_config'
if (-not (Test-Path -LiteralPath $conf)) {
  # The first start of sshd writes its default config; it stays stopped afterwards.
  Start-Service sshd
  for ($k = 0; $k -lt 20 -and -not (Test-Path -LiteralPath $conf); $k++) { Start-Sleep -Milliseconds 500 }
  SshdOff
}
$before = [IO.File]::ReadAllBytes($conf)
$text = [Text.Encoding]::UTF8.GetString($before)
$text = [regex]::Replace($text, '(?s)# studio relay begin global.*?# studio relay end global\\r?\\n?', '')
$text = [regex]::Replace($text, '(?s)\\r?\\n?# studio relay begin\\r?\\n.*?# studio relay end\\r?\\n?', [Environment]::NewLine)
$global = @'
${global}'@
$ours = @'
# studio relay begin
${block}# studio relay end
'@
$new = $global + $text.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $ours
[IO.File]::WriteAllText($conf, $new, (New-Object Text.UTF8Encoding $false))
$exe = Join-Path $env:SystemRoot 'System32\\OpenSSH\\sshd.exe'
$tested = $null
if (Test-Path -LiteralPath $exe) { $tested = Start-Process -FilePath $exe -ArgumentList '-t' -Wait -PassThru -NoNewWindow }
if ($null -eq $tested -or $tested.ExitCode -ne 0) {
  [IO.File]::WriteAllBytes($conf, $before)
  throw 'sshd does not accept the new sshd_config (or could not check it); it was put back as it was'
}
${scope}
$rule = 'Studio relay: sshd'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${i.port} @scope | Out-Null
Start-Service sshd
Write-Output "ok: relay account $relay, crew user $crew, broker task $task"
Write-Output "ok: sshd forces studio relay serve for $relay; port ${i.port} only from $where${i.keepPasswords === true ? '' : '; keys only, for every account'}"
Write-Output 'ok: WebClient stopped and disabled'
$ok = $true
} finally {
  if (-not $ok) {
    SshdOff
    Get-NetFirewallRule -DisplayName 'Studio relay: sshd' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
    Write-Output 'stopped: sshd is stopped and closed until studio relay install runs through'
  }
}
`;
}
