// The network lockdown of a Windows worker (`studio relay install`, `studio worker windows-setup`):
// outbound Windows Firewall block rules, bound to the crew users' group and, on a relay worker, to
// the relay account (which runs the egress proxy), for every local range: the private IPv4 ranges,
// carrier-grade NAT (where Tailscale lives), link-local, and IPv6 unique-local and link-local. The
// internet stays open; the DNS resolvers the machine uses stay open on port 53 only. `deny.hosts`
// and `deny.ports` become rules too. A crew user already has no direct network at all (its own rule,
// crew-accounts.ts); the lockdown adds the relay account and keeps the group under it as well.
//
// The install proves it: a throwaway user, made like a crew user but outside the group, is bound
// into the rule for one probe and must be refused by the firewall itself (WSAEACCES, 10013) on every
// local target it tries; it is probed before as well, so the output shows what the rule changed.
// Anything else fails the install closed. Every start of a relay job checks the same as the relay
// account itself.
import { lookup as dnsLookup } from 'node:dns/promises';
import { hextets, ipv4 } from './egress-proxy.js';
import { powershellEnv, psQuote, type RunFile } from './windows-sandbox.js';

/**
 * The lockdown of a setup on this machine: its resolvers as Windows reports them, the deny list of
 * its config, and each host name of it resolved now (the firewall takes addresses only).
 */
export async function lockdownFor(o: {
  resolvers: () => Promise<string[]>;
  deny: { hosts: readonly string[]; ports: readonly number[] };
  lookup?: (name: string) => Promise<string[]>;
}): Promise<LockdownPlan> {
  const lookup =
    o.lookup ??
    (async (name: string) => {
      try {
        return (await dnsLookup(name, { all: true })).map((a) => a.address);
      } catch {
        return [];
      }
    });
  const resolved: Record<string, string[]> = {};
  for (const h of o.deny.hosts) {
    if (h === 'local-subnets' || h === 'tailnet-peers' || h.includes('/')) continue;
    if (addressSpan(h) !== undefined) continue;
    resolved[h] = await lookup(h);
  }
  return lockdownPlan({
    resolvers: await o.resolvers(),
    denyHosts: o.deny.hosts,
    resolved,
    denyPorts: o.deny.ports,
  });
}

/** The firewall group of every lockdown rule: install replaces them, uninstall removes them. */
export const LOCKDOWN_GROUP = 'Studio relay lockdown';
export const LOCKDOWN_RULE = 'Studio relay lockdown: no local network';

/** The local IPv4 ranges: private, carrier-grade NAT, link-local. */
const LOCAL_V4: readonly (readonly [number, number, number, number, number])[] = [
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
];
/** The local IPv6 ranges: unique-local (fd00::/8 inside it) and link-local. */
const LOCAL_V6: readonly (readonly [string, number])[] = [
  ['fc00::', 7],
  ['fe80::', 10],
];

interface Span {
  v6: boolean;
  lo: bigint;
  hi: bigint;
}

const v4Big = (s: string): bigint | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m === null) return undefined;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return undefined;
  return p.reduce((a, x) => (a << 8n) + BigInt(x), 0n);
};
const v6Big = (s: string): bigint | undefined => {
  if (!s.includes(':')) return undefined;
  const h = hextets(s);
  return h === undefined ? undefined : h.reduce((a, x) => (a << 16n) + BigInt(x), 0n);
};
const span = (v6: boolean, base: bigint, bits: number): Span => {
  const width = v6 ? 128 : 32;
  const size = 1n << BigInt(width - bits);
  const lo = (base / size) * size;
  return { v6, lo, hi: lo + size - 1n };
};
const text = (v6: boolean, n: bigint): string => {
  if (!v6) {
    const b = [24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n));
    return ipv4(b[0] as number, b[1] as number, b[2] as number, b[3] as number);
  }
  return Array.from({ length: 8 }, (_, i) =>
    ((n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16),
  ).join(':');
};
const spanText = (s: Span): string =>
  s.lo === s.hi ? text(s.v6, s.lo) : `${text(s.v6, s.lo)}-${text(s.v6, s.hi)}`;

/** The local ranges as spans. */
const localSpans = (): Span[] => [
  ...LOCAL_V4.map(([a, b, c, d, bits]) => span(false, v4Big(ipv4(a, b, c, d)) as bigint, bits)),
  ...LOCAL_V6.map(([a, bits]) => span(true, v6Big(a) as bigint, bits)),
];

/** An address (v4 or v6, a zone index dropped) as a one-address span; undefined if it is none. */
function addressSpan(a: string): Span | undefined {
  const bare = a.replace(/%.*$/, '');
  const n4 = v4Big(bare);
  if (n4 !== undefined) return { v6: false, lo: n4, hi: n4 };
  const n6 = v6Big(bare);
  return n6 === undefined ? undefined : { v6: true, lo: n6, hi: n6 };
}

/** `spans` without the single addresses `holes`, as firewall address ranges. */
function carve(spans: readonly Span[], holes: readonly Span[]): Span[] {
  let out = [...spans];
  for (const h of holes) {
    out = out.flatMap((s) => {
      if (s.v6 !== h.v6 || h.lo > s.hi || h.hi < s.lo) return [s];
      const parts: Span[] = [];
      if (h.lo > s.lo) parts.push({ v6: s.v6, lo: s.lo, hi: h.lo - 1n });
      if (h.hi < s.hi) parts.push({ v6: s.v6, lo: h.hi + 1n, hi: s.hi });
      return parts;
    });
  }
  return out;
}

export interface LockdownPlan {
  /** Every local range, the resolvers left out: blocked for every protocol and port. */
  local: string[];
  /** The resolvers inside the local ranges: blocked on every TCP and UDP port but 53. */
  resolvers: string[];
  /** The addresses of `deny.hosts` (and the names resolved now): blocked entirely. */
  hosts: string[];
  /** `deny.ports`: blocked on every address, TCP and UDP. */
  ports: number[];
  /** What could not become a rule, for the install's output. */
  notes: string[];
}

/**
 * The rules of a lockdown: every local range with the machine's DNS resolvers carved out of it
 * (they stay reachable on port 53), the explicit `deny.hosts` (addresses, IPv4 ranges, and names as
 * they resolve now) and `deny.ports`. The keywords `local-subnets` and `tailnet-peers` lie inside
 * the local ranges.
 */
export function lockdownPlan(o: {
  resolvers: readonly string[];
  denyHosts: readonly string[];
  /** Names of `deny.hosts` resolved by the caller: name to addresses (empty when it did not resolve). */
  resolved?: Readonly<Record<string, readonly string[]>>;
  denyPorts: readonly number[];
}): LockdownPlan {
  const notes: string[] = [];
  const locals = localSpans();
  const inLocal = (s: Span) => locals.some((l) => l.v6 === s.v6 && s.lo >= l.lo && s.hi <= l.hi);
  const holes: Span[] = [];
  for (const r of o.resolvers) {
    const s = addressSpan(r);
    if (s !== undefined && inLocal(s) && !holes.some((h) => h.v6 === s.v6 && h.lo === s.lo)) {
      holes.push(s);
    }
  }
  holes.sort((a, b) => (a.v6 === b.v6 ? (a.lo < b.lo ? -1 : 1) : a.v6 ? 1 : -1));
  const hosts: string[] = [];
  const add = (s: Span | undefined) => {
    if (s === undefined) return;
    const t = spanText(s);
    if (!hosts.includes(t)) hosts.push(t);
  };
  for (const h of o.denyHosts) {
    if (h === 'local-subnets' || h === 'tailnet-peers') continue;
    const cidr = /^([^/]+)\/(\d{1,3})$/.exec(h);
    if (cidr !== null) {
      const base = v4Big(cidr[1] as string);
      if (base !== undefined) add(span(false, base, Number(cidr[2])));
      continue;
    }
    const a = addressSpan(h);
    if (a !== undefined) {
      add(a);
      continue;
    }
    const got = o.resolved?.[h] ?? [];
    if (got.length === 0) {
      notes.push(`deny.hosts ${h}: does not resolve now, so no firewall rule holds it`);
      continue;
    }
    for (const x of got) add(addressSpan(x));
    notes.push(`deny.hosts ${h}: blocked at ${got.join(', ')} as it resolves now`);
  }
  return {
    local: carve(locals, holes).map(spanText),
    resolvers: holes.map(spanText),
    hosts,
    ports: [...new Set(o.denyPorts)].sort((a, b) => a - b),
    notes,
  };
}

/** Local targets the probe always tries: the first host of each local IPv4 range, port 445. */
export const PROBE_FIXED: readonly string[] = LOCAL_V4.map(
  ([a, b, c, d]) => `${ipv4(a, b, c, d + 1)}:445`,
);

/**
 * PowerShell run as a user (relay account or probe user) that tries a TCP connection to each
 * `host:port` of `$targets` and prints one JSON object: target to `open`, `timeout` or the Windows
 * socket error code. The firewall refusing it is code 10013 (WSAEACCES), immediately.
 */
export const CONNECT_TEST = String.raw`$res = @{}
$open = @{}
function Code($x) {
  $e = $x
  while ($null -ne $e.InnerException) { $e = $e.InnerException }
  if ($e -is [Net.Sockets.SocketException]) { [string]$e.ErrorCode } else { 'error' }
}
foreach ($t in $targets) {
  $at = $t.LastIndexOf(':')
  $c = New-Object Net.Sockets.TcpClient
  try { $open[$t] = @($c, $c.ConnectAsync($t.Substring(0, $at).Trim('[', ']'), [int]$t.Substring($at + 1))) }
  catch { $res[$t] = Code $_.Exception; $c.Dispose() }
}
$deadline = [DateTime]::UtcNow.AddMilliseconds(3000)
foreach ($t in @($open.Keys)) {
  $c = $open[$t][0]
  $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
  try { if ($open[$t][1].Wait($left)) { $res[$t] = 'open' } else { $res[$t] = 'timeout' } }
  catch { $res[$t] = Code $_.Exception }
  finally { $c.Dispose() }
}
[Console]::Out.Write((ConvertTo-Json -Compress $res))
`;

/**
 * No route to the network or host, or an address no connection can go to (WSAENETUNREACH,
 * WSAEHOSTUNREACH, WSAEADDRNOTAVAIL): nothing left the machine.
 */
export const NO_ROUTE: readonly string[] = ['10051', '10065', '10049'];

/** The firewall's own refusal of a connection (WSAEACCES). */
export const FIREWALL_REFUSED = '10013';

/** The targets of a probe that the firewall did not refuse; empty when the lockdown holds. */
export function unrefused(results: Readonly<Record<string, string>>): string[] {
  const all = Object.entries(results);
  // No route at all reaches nothing either, but proves nothing: one refusal at least.
  if (all.length > 0 && !all.some(([, r]) => r === FIREWALL_REFUSED)) {
    return all.map(
      ([t, r]) => `${t} ${r === 'open' ? 'opened' : r === 'timeout' ? 'timed out' : `error ${r}`}`,
    );
  }
  return all
    .filter(([, r]) => r !== FIREWALL_REFUSED && !NO_ROUTE.includes(r))
    .map(
      ([t, r]) => `${t} ${r === 'open' ? 'opened' : r === 'timeout' ? 'timed out' : `error ${r}`}`,
    );
}

/**
 * PowerShell of the lockdown, for a setup script that has `$groupSid` (and `$relaySid` on a relay
 * worker) set and the crew functions loaded (`NewSecret`, `RetireJobUsers`). `LockdownRules` puts
 * the rules in place for a list of SIDs; `LockdownCheck` reads them back from the active store with
 * the firewall profiles; `LockdownProbe` binds a throwaway user into the rule, probes before and
 * after, and refuses unless the firewall refused every target.
 */
export function lockdownFunctions(plan: LockdownPlan): string {
  const list = (xs: readonly (string | number)[]) =>
    `@(${xs.map((x) => (typeof x === 'number' ? String(x) : psQuote(x))).join(', ')})`;
  return `$lockGroup = ${psQuote(LOCKDOWN_GROUP)}
$lockLocal = ${list(plan.local)}
$lockResolvers = ${list(plan.resolvers)}
$lockHosts = ${list(plan.hosts)}
$lockPorts = ${list(plan.ports)}
function LockdownRules([string[]]$sids) {
  Get-NetFirewallRule -Group $lockGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $who = 'D:' + (($sids | ForEach-Object { "(A;;CC;;;$_)" }) -join '')
  $base = @{ Group = $lockGroup; Direction = 'Outbound'; Action = 'Block'; LocalUser = $who; Profile = 'Any' }
  New-NetFirewallRule @base -DisplayName ${psQuote(LOCKDOWN_RULE)} -RemoteAddress ($lockLocal + $lockHosts) | Out-Null
  foreach ($p in @('TCP', 'UDP')) {
    if ($lockResolvers.Count -gt 0) { New-NetFirewallRule @base -DisplayName "Studio relay lockdown: DNS resolvers, $p but port 53" -Protocol $p -RemotePort @('1-52', '54-65535') -RemoteAddress $lockResolvers | Out-Null }
    if ($lockPorts.Count -gt 0) { New-NetFirewallRule @base -DisplayName "Studio relay lockdown: denied ports, $p" -Protocol $p -RemotePort ([string[]]$lockPorts) | Out-Null }
  }
}
# The rules as Windows applies them: present, on, blocking, bound to every SID; every firewall
# profile on and taking local rules. Returns the problems.
function LockdownCheck([string[]]$sids) {
  $problems = @()
  foreach ($p in @(Get-NetFirewallProfile -PolicyStore ActiveStore)) {
    if ([string]$p.Enabled -ne 'True') { $problems += "Windows Firewall is off for the $($p.Name) profile (turn it on: Set-NetFirewallProfile -Profile $($p.Name) -Enabled True)" }
    if ([string]$p.AllowLocalFirewallRules -eq 'False') { $problems += "a policy makes the $($p.Name) profile ignore local firewall rules" }
  }
  $r = @(Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName ${psQuote(LOCKDOWN_RULE)} -ErrorAction SilentlyContinue)
  if ($r.Count -ne 1) { $problems += 'the lockdown rule is not in the active firewall policy' }
  else {
    if ([string]$r[0].Enabled -ne 'True' -or [string]$r[0].Action -ne 'Block' -or [string]$r[0].Direction -ne 'Outbound') { $problems += 'the lockdown rule is not an enabled outbound block' }
    $who = [string]($r[0] | Get-NetFirewallSecurityFilter).LocalUser
    foreach ($s in $sids) { if ($who -notlike "*$s*") { $problems += "the lockdown rule does not hold $s" } }
  }
  ,$problems
}
# Runs the connect test as a user with this password; the answer as a hashtable.
function ConnectAs([string]$name, [string]$sid, [string]$plain, [string[]]$targets) {
  # The test goes to the user as a file: a command line of a logon with credentials holds at most
  # 1024 characters. Its folder, and the answer files in it, only administrators change; the user
  # reads the script, and writes its answer through the handles it is given.
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @($sid, 'ReadAndExecute'))) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($r[0])), $r[1], 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  }
  $dir = Join-Path $env:ProgramData ('studio-probe-' + [Guid]::NewGuid().ToString('N'))
  $null = [IO.Directory]::CreateDirectory($dir, $acl)
  $file = Join-Path $dir 'probe.ps1'
  $out = Join-Path $dir 'out.json'
  $err = Join-Path $dir 'err.txt'
  try {
    $script = '$targets = @(' + (($targets | ForEach-Object { "'" + $_ + "'" }) -join ', ') + ")\`r\`n" + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(CONNECT_TEST, 'utf8').toString('base64')}'))
    [IO.File]::WriteAllText($file, $script, (New-Object Text.ASCIIEncoding))
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    $c = New-Object System.Management.Automation.PSCredential ("$env:COMPUTERNAME\\$name", $secure)
    $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    $p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $file + '"')) -Credential $c -WorkingDirectory $env:SystemRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit(120000)) { $p.Kill(); throw 'the probe as the throwaway user did not finish' }
    $raw = Get-Content -Raw -LiteralPath $out -ErrorAction SilentlyContinue
    if (-not $raw) { throw "the probe as the throwaway user gave no answer: $(Get-Content -Raw -LiteralPath $err -ErrorAction SilentlyContinue)" }
    $h = @{}
    foreach ($q in (ConvertFrom-Json $raw).PSObject.Properties) { $h[$q.Name] = [string]$q.Value }
    $h
  } finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}
# Local targets for the probe: the fixed ones, the default gateways, the resolvers (port 80: 53
# stays open) and a few neighbors, IPv4 only.
function ProbeTargets {
  $t = @(${PROBE_FIXED.map(psQuote).join(', ')})
  $local = '^(10\\.|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.|192\\.168\\.)'
  $gw = @(Get-NetRoute -DestinationPrefix '${ipv4(0, 0, 0, 0)}/0' -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.NextHop } | Where-Object { $_ -match $local })
  $dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ -match $local })
  $nb = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { [string]$_.IPAddress -match $local -and [string]$_.IPAddress -notmatch '\\.(0|255)$' -and @('Unreachable', 'Incomplete', 'Permanent') -notcontains [string]$_.State } | Select-Object -First 3 | ForEach-Object { [string]$_.IPAddress })
  $t += @($gw | ForEach-Object { "$($_):445" }) + @($dns | ForEach-Object { "$($_):80" }) + @($nb | ForEach-Object { "$($_):445" })
  @($t | Select-Object -Unique | Select-Object -First 12)
}
# A throwaway user, made like a crew user but in no group of Studio's, bound into the rules for one
# probe: every local target must be refused by the firewall. Before and after are printed.
function LockdownProbe([string[]]$sids) {
  $b = New-Object byte[] 3
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $name = $prefix + '-' + (($b | ForEach-Object { $_.ToString('x2') }) -join '')
  $plain = NewSecret
  $u = New-LocalUser -Name $name -Password (ConvertTo-SecureString $plain -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description $crewDescription
  try {
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $u
    $targets = ProbeTargets
    $before = ConnectAs $name $u.SID.Value $plain $targets
    LockdownRules (@($sids) + @($u.SID.Value))
    $after = ConnectAs $name $u.SID.Value $plain $targets
  } finally {
    LockdownRules $sids
    $plain = $null
    $null = RetireJobUsers
    if (Get-LocalUser -SID $u.SID -ErrorAction SilentlyContinue) { Remove-LocalUser -SID $u.SID }
  }
  $open = @($before.Keys | Where-Object { $before[$_] -ne '${FIREWALL_REFUSED}' }).Count
  # No route at all (10051, 10065) reaches nothing either; the firewall must refuse the rest, and
  # at least one target.
  Write-Output "lockdown probe: before the rule $open of $($targets.Count) local targets were not refused by the firewall; after it:"
  $bad = @($after.Keys | Where-Object { @(${NO_ROUTE.concat([FIREWALL_REFUSED])
    .map((c) => `'${c}'`)
    .join(', ')}) -notcontains $after[$_] } | ForEach-Object { "$_ $($after[$_])" })
  $refused = @($after.Keys | Where-Object { $after[$_] -eq '${FIREWALL_REFUSED}' }).Count
  if ($after.Count -ne $targets.Count -or $bad.Count -gt 0 -or $refused -eq 0) { throw "the network lockdown does not hold: the firewall did not refuse $($bad -join ', '); nothing was opened to the lead. Check that no other firewall product replaces Windows Firewall, then run this again" }
  Write-Output "ok: all $($targets.Count) refused by the firewall"
}
`;
}

/** The DNS resolvers this machine uses, by Windows; empty when they cannot be read. */
export async function dnsResolvers(
  run: (file: string, args: string[]) => Promise<{ code: number; stdout: string }>,
): Promise<string[]> {
  const r = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'ConvertTo-Json -Compress -InputObject @(Get-DnsClientServerAddress -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Select-Object -Unique)',
  ]);
  if (r.code !== 0) return [];
  try {
    const raw = JSON.parse(r.stdout.trim() || '[]') as unknown;
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter(
      (x): x is string => typeof x === 'string' && /^[0-9A-Fa-f:.%]{2,64}$/.test(x),
    );
  } catch {
    return [];
  }
}

/**
 * The lockdown as the relay account sees it, before every start: a direct connection to each fixed
 * local target must be refused by the firewall itself. Undefined when it holds; else the refusal.
 */
export async function lockdownProblem(run: RunFile): Promise<string | undefined> {
  const targets = PROBE_FIXED.map(psQuote).join(', ');
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$targets = @(${targets})\n${CONNECT_TEST}`],
    { env: powershellEnv(process.env), timeoutMs: 60_000 },
  );
  let results: Record<string, string> | undefined;
  try {
    const raw = r.code === 0 ? (JSON.parse(r.stdout.trim()) as unknown) : undefined;
    results = raw !== null && typeof raw === 'object' ? (raw as Record<string, string>) : undefined;
  } catch {
    results = undefined;
  }
  if (results === undefined || Object.keys(results).length !== PROBE_FIXED.length) {
    return 'the network lockdown cannot be checked as the relay account; run studio relay install again, elevated';
  }
  const bad = unrefused(results);
  return bad.length === 0
    ? undefined
    : `the network lockdown does not hold for the relay account (${bad.join(', ')}): run studio relay install again, elevated`;
}

/** Where Windows keeps the Point and Print policy. */
export const POINT_AND_PRINT_KEY =
  'HKLM:\\Software\\Policies\\Microsoft\\Windows NT\\Printers\\PointAndPrint';

/**
 * PowerShell that lets only administrators install printer drivers (Point and Print), whatever the
 * spooler does: a crew user cannot bring a driver in through it.
 */
export const POINT_AND_PRINT = `# Printer drivers: administrators only install them (Point and Print); the spooler stays on.
if (-not (Test-Path -LiteralPath '${POINT_AND_PRINT_KEY}')) { New-Item -Path '${POINT_AND_PRINT_KEY}' -Force | Out-Null }
Set-ItemProperty -LiteralPath '${POINT_AND_PRINT_KEY}' -Name RestrictDriverInstallationToAdministrators -Type DWord -Value 1
Write-Output 'ok: printer drivers only by administrators (RestrictDriverInstallationToAdministrators=1)'
`;

/**
 * The part of a setup script that puts the lockdown in place, proves it and reads it back, for the
 * SIDs `sids` (a PowerShell expression); with `plan` null (`--no-firewall`) it removes the rules and
 * says the machine is open to its network.
 */
export function lockdownSection(plan: LockdownPlan | null, sids: string): string {
  if (plan === null) {
    return `# --no-firewall: no lockdown, and none of an earlier run stays.
Get-NetFirewallRule -Group ${psQuote(LOCKDOWN_GROUP)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Output 'UNSAFE (--no-firewall): no network lockdown; the relay account, which runs the proxy of the crews, can reach every machine of the local network and the tailnet directly'
`;
  }
  return `# The network lockdown: no local network for the crews and the account that runs their proxy.
Write-Output 'Network lockdown: putting the rules in place and proving them with a throwaway user (this takes a moment).'
${lockdownFunctions(plan)}${plan.notes.map((n) => `Write-Output ${psQuote(n)}\n`).join('')}$lockSids = ${sids}
LockdownRules $lockSids
LockdownProbe $lockSids
$lockProblems = LockdownCheck $lockSids
if (@($lockProblems).Count -gt 0) { throw "the network lockdown does not hold: $(@($lockProblems) -join '; ')" }
Write-Output 'ok: network lockdown (local ranges blocked, DNS resolvers on port 53 only, the internet open)'
`;
}
