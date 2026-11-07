// The network lockdown of a Windows worker (`studio relay install`, `studio worker windows-setup`):
// outbound Windows Firewall block rules, bound to the crew users' group and, on a relay worker, to
// the relay account (which runs the egress proxy). Blocked: a fixed set of ranges (private IPv4,
// carrier-grade NAT where Tailscale lives, link-local, broadcast, multicast, benchmarking, IPv6
// unique-local, link-local, multicast and the local NAT64 prefix) and, from the routing table of the
// machine, every prefix it reaches without the default route: every on-link network of both
// families (an IPv6 global prefix of the LAN included) and every internal route (a VPN, a second
// network). The internet stays open. Name resolution goes through the DNS Client service, which
// runs as NetworkService, so no resolver needs an exception. `deny.hosts` and `deny.ports` become
// rules too; `--block-smb-lan` adds a machine-wide rule for SMB to the local networks.
//
// The install proves it: a throwaway user, made like a crew user but outside the group, is bound
// into the rule for one probe and must be refused by the firewall itself (WSAEACCES, 10013) on every
// local target it tries, an IPv6 one among them when the machine has IPv6; it is probed before as
// well, so the output shows what the rule changed. Anything else fails the install closed. Every
// start of a relay job checks the same as the relay account: the rule in the active policy, every
// firewall profile on, every current local prefix inside the rule, and the probe.
import { lookup as dnsLookup } from 'node:dns/promises';
import { hextets, ipv4 } from './egress-proxy.js';
import { powershellEnv, psQuote, type RunFile } from './windows-sandbox.js';

/** Resolves a name to its addresses, empty when it does not resolve. */
const resolveAll = async (name: string): Promise<string[]> => {
  try {
    return (await dnsLookup(name, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
};

/**
 * The lockdown of a setup on this machine: the deny list of its config, each host name of it
 * resolved now (the firewall takes addresses only).
 */
export async function lockdownFor(o: {
  deny: { hosts: readonly string[]; ports: readonly number[]; prefixes?: readonly string[] };
  lookup?: (name: string) => Promise<string[]>;
  blockSmbLan?: boolean;
}): Promise<LockdownPlan> {
  const lookup = o.lookup ?? resolveAll;
  const resolved: Record<string, string[]> = {};
  for (const h of o.deny.hosts) {
    if (isDenyName(h)) resolved[h] = await lookup(h);
  }
  return lockdownPlan({
    denyHosts: o.deny.hosts,
    resolved,
    denyPorts: o.deny.ports,
    denyPrefixes: o.deny.prefixes ?? [],
    ...(o.blockSmbLan === true ? { blockSmbLan: true } : {}),
  });
}

/** The firewall group of every lockdown rule: install replaces them, uninstall removes them. */
export const LOCKDOWN_GROUP = 'Studio relay lockdown';
export const LOCKDOWN_RULE = 'Studio relay lockdown: no local network';
export const SMB_LAN_RULE = 'Studio relay lockdown: no SMB to the local network (all users)';
/** The rule of `deny.ports` for one protocol. */
export const lockdownPortsRule = (protocol: 'TCP' | 'UDP'): string =>
  `Studio relay lockdown: denied ports, ${protocol}`;

/** The fixed IPv4 ranges: private, carrier-grade NAT, link-local, benchmarking, multicast, broadcast. */
const LOCAL_V4: readonly (readonly [number, number, number, number, number])[] = [
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15],
  [224, 0, 0, 0, 4],
  [255, 255, 255, 255, 32],
];
/** The fixed IPv6 ranges: unique-local (fd00::/8 inside it), link-local, multicast, NAT64 local use. */
const LOCAL_V6: readonly (readonly [string, number])[] = [
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
];
/** The private IPv4 ranges of the probe's fixed targets. */
const PRIVATE_V4 = LOCAL_V4.slice(0, 5);

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

/** The fixed ranges as spans. */
const localSpans = (): Span[] => [
  ...LOCAL_V4.map(([a, b, c, d, bits]) => span(false, v4Big(ipv4(a, b, c, d)) as bigint, bits)),
  ...LOCAL_V6.map(([a, bits]) => span(true, v6Big(a) as bigint, bits)),
];

/** An address (v4 or v6, a zone index dropped) as a one-address span; undefined if it is none. */
function addressSpan(a: string): Span | undefined {
  const bare = a.replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  const n4 = v4Big(bare);
  if (n4 !== undefined) return { v6: false, lo: n4, hi: n4 };
  const n6 = v6Big(bare);
  return n6 === undefined ? undefined : { v6: true, lo: n6, hi: n6 };
}

/** The bits of a dotted IPv4 mask, undefined when it is not a contiguous one. */
const maskBits = (mask: string): number | undefined => {
  const n = v4Big(mask);
  if (n === undefined) return undefined;
  const bits = n.toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? (bits.indexOf('0') === -1 ? 32 : bits.indexOf('0')) : undefined;
};

/**
 * One address entry as Windows Firewall or the routing table writes it: an address, `a-b`,
 * `addr/bits` or `addr/mask`; undefined for a keyword or anything else.
 */
export function entrySpan(entry: string): Span | undefined {
  const e = entry.trim();
  const dash = /^([^-]+)-([^-]+)$/.exec(e);
  if (dash !== null) {
    const a = addressSpan(dash[1] as string);
    const b = addressSpan(dash[2] as string);
    return a !== undefined && b !== undefined && a.v6 === b.v6 && a.lo <= b.hi
      ? { v6: a.v6, lo: a.lo, hi: b.hi }
      : undefined;
  }
  const slash = /^([^/]+)\/([^/]+)$/.exec(e);
  if (slash !== null) {
    const a = addressSpan(slash[1] as string);
    if (a === undefined) return undefined;
    const bits = /^\d{1,3}$/.test(slash[2] as string)
      ? Number(slash[2])
      : a.v6
        ? undefined
        : maskBits(slash[2] as string);
    if (bits === undefined || bits > (a.v6 ? 128 : 32)) return undefined;
    return span(a.v6, a.lo, bits);
  }
  return addressSpan(e);
}

/** Whether `inner` lies wholly inside one of `outer`. */
const covered = (inner: Span, outer: readonly Span[]): boolean =>
  outer.some((o) => o.v6 === inner.v6 && inner.lo >= o.lo && inner.hi <= o.hi);

/** A deny.hosts entry that is a host name (not a keyword, a range or an address). */
const isDenyName = (h: string): boolean =>
  h !== 'local-subnets' &&
  h !== 'tailnet-peers' &&
  !h.includes('/') &&
  addressSpan(h) === undefined;

export interface LockdownPlan {
  /** The fixed ranges: blocked for every protocol and port (the routes of the machine on top). */
  local: string[];
  /** The addresses of `deny.hosts` (and the names resolved now): blocked entirely. */
  hosts: string[];
  /** `deny.ports`: blocked on every address, TCP and UDP. */
  ports: number[];
  /** What could not become a rule, for the install's output. */
  notes: string[];
  /** Each host name of `deny.hosts` with the addresses its rule holds (empty: it did not resolve). */
  names: Record<string, string[]>;
  /** `--block-smb-lan`: SMB (445, 139) to the local networks blocked for every account. */
  blockSmbLan: boolean;
}

/**
 * The rules of a lockdown: every fixed local range, the explicit `deny.hosts` (addresses, IPv4
 * ranges, and names as they resolve now) and `deny.ports`. The keywords `local-subnets` and
 * `tailnet-peers` lie inside the fixed ranges; the routes of the machine are added where the
 * rules are made.
 */
export function lockdownPlan(o: {
  denyHosts: readonly string[];
  /** Names of `deny.hosts` resolved by the caller: name to addresses (empty when it did not resolve). */
  resolved?: Readonly<Record<string, readonly string[]>>;
  denyPorts: readonly number[];
  /** `deny.prefixes`: further networks, any family and length. */
  denyPrefixes?: readonly string[];
  blockSmbLan?: boolean;
}): LockdownPlan {
  const notes: string[] = [];
  const hosts: string[] = [];
  const names: Record<string, string[]> = {};
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
    names[h] = [...got];
    if (got.length === 0) {
      notes.push(`deny.hosts ${h}: does not resolve now, so no firewall rule holds it`);
      continue;
    }
    for (const x of got) add(addressSpan(x));
    notes.push(`deny.hosts ${h}: blocked at ${got.join(', ')} as it resolves now`);
  }
  for (const p of o.denyPrefixes ?? []) {
    const s = entrySpan(p);
    if (s === undefined)
      notes.push(`deny.prefixes ${p}: not an address/prefix, so no firewall rule holds it`);
    else add(s);
  }
  return {
    local: localSpans().map(spanText),
    hosts,
    ports: [...new Set(o.denyPorts)].sort((a, b) => a - b),
    notes,
    names,
    blockSmbLan: o.blockSmbLan === true,
  };
}

/** Whether an address lies in a fixed local range, which the lockdown blocks whatever else. */
export function inLocalRange(address: string): boolean {
  const s = addressSpan(address);
  return s !== undefined && covered(s, localSpans());
}

/**
 * Names of `deny.hosts` whose firewall rule no longer holds them, resolved anew: a name now
 * resolving to an address outside the local ranges that its rule does not name, or a name added
 * to the config after the install. A start waits on any of them (fail closed); `relay install`
 * again writes the rules from the names anew.
 */
export async function denyNameDrift(o: {
  denyHosts: readonly string[];
  /** The names and addresses the install wrote rules for (install record). */
  recorded: Readonly<Record<string, readonly string[]>>;
  lookup?: (name: string) => Promise<string[]>;
}): Promise<string[]> {
  const lookup = o.lookup ?? resolveAll;
  const out: string[] = [];
  for (const h of o.denyHosts) {
    if (!isDenyName(h)) continue;
    const held = o.recorded[h];
    if (held === undefined) {
      out.push(`deny.hosts ${h} has no firewall rule yet (added after the install)`);
      continue;
    }
    const now = (await lookup(h)).filter((a) => !inLocalRange(a) && !held.includes(a));
    if (now.length > 0) {
      out.push(`deny.hosts ${h} now resolves to ${now.join(', ')}, which no firewall rule holds`);
    }
  }
  return out;
}

/** Local targets the probe always tries: the first host of each private IPv4 range, port 445. */
export const PROBE_FIXED: readonly string[] = PRIVATE_V4.map(
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
  $c = New-Object Net.Sockets.TcpClient($(if ($t.StartsWith('[')) { [Net.Sockets.AddressFamily]::InterNetworkV6 } else { [Net.Sockets.AddressFamily]::InterNetwork }))
  try { $open[$t] = @($c, $c.ConnectAsync([Net.IPAddress]::Parse($t.Substring(0, $at).Trim('[', ']')), [int]$t.Substring($at + 1))) }
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

const said = (t: string, r: string) =>
  `${t} ${r === 'open' ? 'opened' : r === 'timeout' ? 'timed out' : `error ${r}`}`;

/** The targets of a probe that the firewall did not refuse; empty when the lockdown holds. */
export function unrefused(results: Readonly<Record<string, string>>): string[] {
  const all = Object.entries(results);
  // No route at all reaches nothing either, but proves nothing: one refusal at least.
  if (all.length > 0 && !all.some(([, r]) => r === FIREWALL_REFUSED)) {
    return all.map(([t, r]) => said(t, r));
  }
  return all
    .filter(([, r]) => r !== FIREWALL_REFUSED && !NO_ROUTE.includes(r))
    .map(([t, r]) => said(t, r));
}

/**
 * PowerShell: `LocalRoutes`, every prefix of the routing table the machine reaches without the
 * default route (on-link networks of both families and internal routes), loopback left out; and
 * `V6Target`, one IPv6 address of the local network to probe (the default gateway, else a
 * unique-local neighbor), `[addr%if]:445`, or nothing when the machine has no IPv6 there.
 */
export const ROUTE_FUNCTIONS = `function LocalRoutes {
  @(Get-NetRoute -ErrorAction SilentlyContinue | Where-Object {
    $d = [string]$_.DestinationPrefix
    $d -ne '${ipv4(0, 0, 0, 0)}/0' -and $d -ne '::/0' -and $d -notlike '127.*' -and $d -ne '::1/128' -and $_.InterfaceAlias -notlike 'Loopback*'
  } | ForEach-Object { [string]$_.DestinationPrefix } | Sort-Object -Unique)
}
function V6Target {
  $gw = Get-NetRoute -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | Where-Object { [string]$_.NextHop -ne '::' } | Select-Object -First 1
  if ($null -ne $gw) { return '[' + [string]$gw.NextHop + '%' + $gw.InterfaceIndex + ']:445' }
  $n = Get-NetNeighbor -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { [string]$_.IPAddress -match '^f[cd]' -and @('Unreachable', 'Incomplete', 'Permanent') -notcontains [string]$_.State } | Select-Object -First 1
  if ($null -ne $n) { return '[' + [string]$n.IPAddress + ']:445' }
  $null
}
`;

/**
 * PowerShell of the lockdown, for a setup script that has `$groupSid` (and `$relaySid` on a relay
 * worker) set and the crew functions loaded (`NewSecret`, `RetireJobUsers`). `LockdownRules` puts
 * the rules in place for a list of SIDs, with the routes of the machine; `LockdownCheck` reads them
 * back from the active store with the firewall profiles; `LockdownProbe` binds a throwaway user
 * into the rule, probes before and after, and refuses unless the firewall refused every target.
 */
export function lockdownFunctions(plan: LockdownPlan): string {
  const list = (xs: readonly (string | number)[]) =>
    `@(${xs.map((x) => (typeof x === 'number' ? String(x) : psQuote(x))).join(', ')})`;
  const accepted = [...NO_ROUTE, FIREWALL_REFUSED].map((c) => `'${c}'`).join(', ');
  return `$lockGroup = ${psQuote(LOCKDOWN_GROUP)}
$lockLocal = ${list(plan.local)}
$lockHosts = ${list(plan.hosts)}
$lockPorts = ${list(plan.ports)}
$lockSmbLan = ${plan.blockSmbLan ? '$true' : '$false'}
${ROUTE_FUNCTIONS}# The new rules first, under names of their own, and only then the old ones go: there is never a
# moment without a rule (for a while both block). A rule that cannot be made leaves the old ones.
function LockdownRules([string[]]$sids) {
  $old = @(Get-NetFirewallRule -Group $lockGroup -ErrorAction SilentlyContinue)
  $tag = [Guid]::NewGuid().ToString('N')
  $who = 'D:' + (($sids | ForEach-Object { "(A;;CC;;;$_)" }) -join '')
  $base = @{ Group = $lockGroup; Direction = 'Outbound'; Action = 'Block'; Profile = 'Any' }
  $routes = @(LocalRoutes)
  New-NetFirewallRule @base -Name ('StudioLockdown-local-' + $tag) -LocalUser $who -DisplayName ${psQuote(LOCKDOWN_RULE)} -RemoteAddress ($lockLocal + $lockHosts + $routes) | Out-Null
  foreach ($p in @('TCP', 'UDP')) {
    if ($lockPorts.Count -gt 0) { New-NetFirewallRule @base -Name ('StudioLockdown-ports-' + $p + '-' + $tag) -LocalUser $who -DisplayName $(if ($p -eq 'TCP') { ${psQuote(lockdownPortsRule('TCP'))} } else { ${psQuote(lockdownPortsRule('UDP'))} }) -Protocol $p -RemotePort ([string[]]$lockPorts) | Out-Null }
  }
  # --block-smb-lan: SMB to the local networks for every account, the owner's own shares included.
  if ($lockSmbLan) { New-NetFirewallRule @base -Name ('StudioLockdown-smb-' + $tag) -DisplayName ${psQuote(SMB_LAN_RULE)} -Protocol TCP -RemotePort @('445', '139') -RemoteAddress ($lockLocal + $routes) | Out-Null }
  if ($old.Count -gt 0) { $old | Remove-NetFirewallRule }
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
    # The SID of an ACE whole (';<sid>)'), never a prefix of a longer one.
    foreach ($s in $sids) { if (-not $who.Contains(';' + $s + ')')) { $problems += "the lockdown rule does not hold $s" } }
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
  $dir = Join-Path ($sys.programData) ('studio-probe-' + [Guid]::NewGuid().ToString('N'))
  $null = [IO.Directory]::CreateDirectory($dir, $acl)
  $file = Join-Path $dir 'probe.ps1'
  $out = Join-Path $dir 'out.json'
  $err = Join-Path $dir 'err.txt'
  try {
    $script = '$targets = @(' + (($targets | ForEach-Object { "'" + $_ + "'" }) -join ', ') + ")\`r\`n" + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(CONNECT_TEST, 'utf8').toString('base64')}'))
    [IO.File]::WriteAllText($file, $script, (New-Object Text.ASCIIEncoding))
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    $c = New-Object System.Management.Automation.PSCredential ("$env:COMPUTERNAME\\$name", $secure)
    $ps = Join-Path ($sys.windows) 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    $p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $file + '"')) -Credential $c -WorkingDirectory ($sys.windows) -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit(120000)) { $p.Kill(); throw 'the probe as the throwaway user did not finish' }
    $raw = Get-Content -Raw -LiteralPath $out -ErrorAction SilentlyContinue
    if (-not $raw) { throw "the probe as the throwaway user gave no answer: $(Get-Content -Raw -LiteralPath $err -ErrorAction SilentlyContinue)" }
    $h = @{}
    foreach ($q in (ConvertFrom-Json $raw).PSObject.Properties) { $h[$q.Name] = [string]$q.Value }
    $h
  } finally {
    # Only the files it made, by name, then the empty folder: nothing is followed or recursed.
    foreach ($f in @($file, $out, $err)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
  }
}
# Local targets for the probe: the fixed ones, the default gateways, the resolvers and a few
# neighbors (IPv4), and one IPv6 target when the machine has IPv6 on its network.
function ProbeTargets {
  $t = @(${PROBE_FIXED.map(psQuote).join(', ')})
  $local = '^(10\\.|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.|192\\.168\\.)'
  $gw = @(Get-NetRoute -DestinationPrefix '${ipv4(0, 0, 0, 0)}/0' -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.NextHop } | Where-Object { $_ -match $local })
  $dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ -match $local })
  $nb = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { [string]$_.IPAddress -match $local -and [string]$_.IPAddress -notmatch '\\.(0|255)$' -and @('Unreachable', 'Incomplete', 'Permanent') -notcontains [string]$_.State } | Select-Object -First 3 | ForEach-Object { [string]$_.IPAddress })
  $t += @($gw | ForEach-Object { "$($_):445" }) + @($dns | ForEach-Object { "$($_):53" }) + @($nb | ForEach-Object { "$($_):445" })
  $v6 = V6Target
  if ($v6) { $t += $v6 }
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
  Write-Output "lockdown probe: before the rule $open of $($targets.Count) local targets were not refused by the firewall; after it:"
  # No route at all (10051, 10065, 10049) reaches nothing either; the firewall must refuse the rest,
  # and at least one target.
  $bad = @($after.Keys | Where-Object { @(${accepted}) -notcontains $after[$_] } | ForEach-Object { "$_ $($after[$_])" })
  $refused = @($after.Keys | Where-Object { $after[$_] -eq '${FIREWALL_REFUSED}' }).Count
  if ($after.Count -ne $targets.Count -or $bad.Count -gt 0 -or $refused -eq 0) { throw "the network lockdown does not hold: the firewall did not refuse $($bad -join ', '); nothing was opened to the lead. Check that no other firewall product replaces Windows Firewall, then run this again" }
  Write-Output "ok: all $($targets.Count) refused by the firewall"
}
`;
}

/**
 * PowerShell the relay account runs before every start: the state of the lockdown as Windows
 * applies it (the profiles, the rule in the active store with its users and addresses, the current
 * local prefixes) and the connect test against the fixed targets and the IPv6 one, as one JSON.
 */
export const LOCKDOWN_STATE = `$ErrorActionPreference = 'Stop'
${ROUTE_FUNCTIONS}$state = @{ me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; profiles = @(); rules = @(); routes = @(LocalRoutes) }
foreach ($p in @(Get-NetFirewallProfile -PolicyStore ActiveStore)) { $state.profiles += @{ name = [string]$p.Name; enabled = [string]$p.Enabled; local = [string]$p.AllowLocalFirewallRules } }
foreach ($r in @(Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName ${psQuote(LOCKDOWN_RULE)} -ErrorAction SilentlyContinue)) {
  $state.rules += @{ enabled = [string]$r.Enabled; action = [string]$r.Action; direction = [string]$r.Direction; users = [string]($r | Get-NetFirewallSecurityFilter).LocalUser; remote = @(($r | Get-NetFirewallAddressFilter).RemoteAddress | ForEach-Object { [string]$_ }) }
}
# The rules of deny.ports, from the active store too: protocol and remote ports as applied.
$state.ports = @()
foreach ($name in @(${psQuote(lockdownPortsRule('TCP'))}, ${psQuote(lockdownPortsRule('UDP'))})) {
  foreach ($r in @(Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $name -ErrorAction SilentlyContinue)) {
    $pf = $r | Get-NetFirewallPortFilter
    $state.ports += @{ protocol = [string]$pf.Protocol; enabled = [string]$r.Enabled; action = [string]$r.Action; direction = [string]$r.Direction; users = [string]($r | Get-NetFirewallSecurityFilter).LocalUser; remote = @($pf.RemotePort | ForEach-Object { [string]$_ }) }
  }
}
$targets = @(${PROBE_FIXED.map(psQuote).join(', ')})
$v6 = V6Target
if ($v6) { $targets += $v6 }
$state.v6 = $v6
$json = & { ${CONNECT_TEST.replace('[Console]::Out.Write((ConvertTo-Json -Compress $res))', 'ConvertTo-Json -Compress $res')} }
$state.connect = ConvertFrom-Json $json
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 5 $state))
`;

/** The state `LOCKDOWN_STATE` prints, as far as the judgement needs it. */
export interface LockdownState {
  me: string;
  profiles: { name: string; enabled: string; local: string }[];
  rules: { enabled: string; action: string; direction: string; users: string; remote: string[] }[];
  routes: string[];
  /** The rules of `deny.ports` (TCP and UDP) in the active store. */
  ports: {
    protocol: string;
    enabled: string;
    action: string;
    direction: string;
    users: string;
    remote: string[];
  }[];
  v6: string | null;
  connect: Record<string, string>;
}

/**
 * What the config asks the lockdown to hold now: the addresses and networks of `deny.hosts` (names
 * resolved anew) and `deny.prefixes`, each with where it comes from, and `deny.ports`.
 */
export interface LockdownWant {
  spans: { entry: string; from: string }[];
  ports: readonly number[];
  /** The lead the start is for: its `--update-deny` line is the fix. */
  lead?: string;
}

/** `LockdownWant` from the deny list in force: the plan the install would write now. */
export async function lockdownWant(o: {
  deny: { hosts: readonly string[]; ports: readonly number[]; prefixes?: readonly string[] };
  lookup?: (name: string) => Promise<string[]>;
  lead?: string;
}): Promise<LockdownWant> {
  const plan = await lockdownFor(o);
  const fromPrefix = new Set(
    (o.deny.prefixes ?? []).flatMap((p) => {
      const s = entrySpan(p);
      return s === undefined ? [] : [spanText(s)];
    }),
  );
  // The prefixes as written (the line names them so); the rest of the plan's addresses is deny.hosts.
  return {
    spans: [
      ...(o.deny.prefixes ?? []).map((entry) => ({ entry, from: 'deny.prefixes' })),
      ...plan.hosts
        .filter((h) => !fromPrefix.has(h))
        .map((entry) => ({ entry, from: 'deny.hosts' })),
    ],
    ports: plan.ports,
    ...(o.lead === undefined ? {} : { lead: o.lead }),
  };
}

const asList = (x: unknown): unknown[] =>
  Array.isArray(x) ? x : x === undefined || x === null ? [] : [x];

/** The state as printed (Windows PowerShell writes a one-element array as its element). */
export function parseLockdownState(raw: unknown): LockdownState | undefined {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object' || typeof r.me !== 'string') return undefined;
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  const connect: Record<string, string> = {};
  if (r.connect !== null && typeof r.connect === 'object') {
    for (const [k, v] of Object.entries(r.connect as Record<string, unknown>)) connect[k] = str(v);
  }
  return {
    me: r.me,
    profiles: asList(r.profiles).map((p) => {
      const q = p as Record<string, unknown>;
      return { name: str(q.name), enabled: str(q.enabled), local: str(q.local) };
    }),
    rules: asList(r.rules).map((p) => {
      const q = p as Record<string, unknown>;
      return {
        enabled: str(q.enabled),
        action: str(q.action),
        direction: str(q.direction),
        users: str(q.users),
        remote: asList(q.remote).map(str),
      };
    }),
    routes: asList(r.routes)
      .map(str)
      .filter((x) => x !== ''),
    ports: asList(r.ports).map((p) => {
      const q = p as Record<string, unknown>;
      return {
        protocol: str(q.protocol),
        enabled: str(q.enabled),
        action: str(q.action),
        direction: str(q.direction),
        users: str(q.users),
        remote: asList(q.remote).map(str),
      };
    }),
    v6: typeof r.v6 === 'string' && r.v6 !== '' ? r.v6 : null,
    connect,
  };
}

/**
 * The judgement of the lockdown before a start: every firewall profile on and taking local rules;
 * the rule once, enabled, an outbound block, bound to this account; every local prefix of the
 * routing table inside its addresses (a new network the install did not see refuses: an IPv6
 * global prefix of the LAN too); the firewall's own refusal from every target, the IPv6 one
 * included. Undefined when all holds.
 */
export function judgeLockdown(s: LockdownState): string | undefined {
  return judgeLockdownAll(s)?.line;
}

/** A remote port entry of a firewall rule (`5432` or `5000-5010`) holding `port`. */
const portHeld = (entries: readonly string[], port: number): boolean =>
  entries.some((e) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(e.trim());
    if (m === null) return false;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    return port >= lo && port <= hi;
  });

/**
 * The deny entries of the config the active rules do not hold: a `deny.prefixes` span, an address
 * of `deny.hosts` (a name as it resolves now) outside the lockdown rule's addresses, a `deny.ports`
 * entry missing from the TCP or the UDP rule. An entry added to the config after the install is
 * otherwise silently not enforced.
 */
export function lockdownGaps(s: LockdownState, want: LockdownWant): string[] {
  const gaps: string[] = [];
  const rule = s.rules.length === 1 ? s.rules[0] : undefined;
  const held = (rule?.remote ?? []).flatMap((e) => {
    const x = entrySpan(e);
    return x === undefined ? [] : [x];
  });
  for (const w of want.spans) {
    const x = entrySpan(w.entry);
    if (x === undefined || !covered(x, held))
      gaps.push(`${w.from} ${w.entry} has no firewall rule`);
  }
  for (const protocol of ['TCP', 'UDP'] as const) {
    const rules = s.ports.filter(
      (r) =>
        r.protocol.toUpperCase() === protocol &&
        r.enabled === 'True' &&
        r.action === 'Block' &&
        r.direction === 'Outbound' &&
        r.users.includes(`;${s.me})`),
    );
    for (const p of want.ports) {
      if (!rules.some((r) => portHeld(r.remote, p))) {
        gaps.push(`deny.ports ${p} has no ${protocol} firewall rule`);
      }
    }
  }
  return gaps;
}

/** The fix of a deny entry without its rule. */
export const gapFix = (lead = '<label>'): string =>
  `on the lead, run studio relay pair ${lead} --update-deny and paste the line it prints in an elevated PowerShell on this PC (it adds the entry to workers.serve.deny and writes the firewall rules anew)`;

/** `judgeLockdown`, and with `want` the gaps of the config: those hold the start. */
export function judgeLockdownAll(
  s: LockdownState,
  want?: LockdownWant,
): { kind: 'held' | 'refused'; line: string } | undefined {
  const base = judgeLockdownBase(s);
  if (base !== undefined) return { kind: 'refused', line: base };
  const gaps = want === undefined ? [] : lockdownGaps(s, want);
  return gaps.length === 0
    ? undefined
    : { kind: 'held', line: `${gaps.join('; ')}: ${gapFix(want?.lead)}` };
}

function judgeLockdownBase(s: LockdownState): string | undefined {
  const fix = 'run studio relay install again, elevated';
  for (const p of s.profiles) {
    if (p.enabled !== 'True') {
      return `Windows Firewall is off for the ${p.name} profile: Set-NetFirewallProfile -Profile ${p.name} -Enabled True, elevated`;
    }
    if (p.local === 'False')
      return `a policy makes the ${p.name} profile ignore local firewall rules`;
  }
  if (s.profiles.length === 0) return `the firewall profiles cannot be read; ${fix}`;
  if (s.rules.length !== 1) return `the lockdown rule is not in the active firewall policy; ${fix}`;
  const rule = s.rules[0] as LockdownState['rules'][number];
  if (rule.enabled !== 'True' || rule.action !== 'Block' || rule.direction !== 'Outbound') {
    return `the lockdown rule is not an enabled outbound block; ${fix}`;
  }
  // The SID of an ACE whole (`;<sid>)`), never a prefix of a longer one.
  if (!rule.users.includes(`;${s.me})`))
    return `the lockdown rule does not hold the relay account; ${fix}`;
  const held = rule.remote.flatMap((e) => {
    const x = entrySpan(e);
    return x === undefined ? [] : [x];
  });
  for (const route of s.routes) {
    const r = entrySpan(route);
    if (r === undefined) return `the route ${route} cannot be read; ${fix}`;
    if (!covered(r, held)) {
      return `the local network ${route} has no firewall rule (a network the install did not see); ${fix}`;
    }
  }
  if (s.v6 !== null && !(s.v6 in s.connect))
    return `the IPv6 target ${s.v6} was not probed; ${fix}`;
  const bad = unrefused(s.connect);
  if (Object.keys(s.connect).length < PROBE_FIXED.length || bad.length > 0) {
    return `the network lockdown does not hold for the relay account (${bad.join(', ') || 'no answer'}); ${fix}`;
  }
  return undefined;
}

/**
 * The lockdown as the relay account sees it, before every start (`judgeLockdown`). Undefined when
 * it holds; else the refusal.
 */
export async function lockdownProblem(
  run: RunFile,
  want?: LockdownWant,
): Promise<{ kind: 'held' | 'refused'; line: string } | undefined> {
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', LOCKDOWN_STATE],
    {
      env: powershellEnv(process.env),
      timeoutMs: 60_000,
    },
  );
  let state: LockdownState | undefined;
  try {
    state = r.code === 0 ? parseLockdownState(JSON.parse(r.stdout.trim()) as unknown) : undefined;
  } catch {
    state = undefined;
  }
  if (state === undefined) {
    return {
      kind: 'refused',
      line: 'the network lockdown cannot be checked as the relay account; run studio relay install again, elevated',
    };
  }
  return judgeLockdownAll(state, want);
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

/** The line every check and answer of a relay worker without a lockdown carries. */
export const NO_LOCKDOWN =
  'no network lockdown (studio relay install --no-firewall): the relay account can reach the local network';

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
Write-Output 'ok: network lockdown (the local networks blocked, the internet open)'
`;
}

/**
 * PowerShell the relay account runs before every start: `\\\\<host>\\IPC$` of each candidate opened
 * without credentials, as the crew user's probe does, printing host to system error code (0: a
 * session opened, which is closed at once).
 */
export const SMB_AS_ME = (hosts: readonly string[]): string => `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudioSmb {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class Res { public int Scope; public int Type; public int DisplayType; public int Usage; public string LocalName; public string RemoteName; public string Comment; public string Provider; }
  [DllImport("mpr.dll", CharSet = CharSet.Unicode)] public static extern int WNetAddConnection2(Res r, string password, string user, int flags);
  [DllImport("mpr.dll", CharSet = CharSet.Unicode)] public static extern int WNetCancelConnection2(string name, int flags, bool force);
}
'@
$codes = @{}
foreach ($h in @(${hosts
  .filter((h) => /^[A-Za-z0-9.:-]{1,253}$/.test(h))
  .map(psQuote)
  .join(', ')})) {
  $target = '\\\\' + $h + '\\IPC$'
  $r = New-Object StudioSmb+Res
  $r.RemoteName = $target
  $c = [StudioSmb]::WNetAddConnection2($r, $null, $null, 0)
  if ($c -eq 0) { [void][StudioSmb]::WNetCancelConnection2($target, 0, $true) }
  $codes[$h] = $c
}
[Console]::Out.Write((ConvertTo-Json -Compress $codes))
`;

/** The system error codes of `SMB_AS_ME`, by host; undefined when it gave no answer. */
export async function smbCodesAsMe(
  run: RunFile,
  hosts: readonly string[],
): Promise<Record<string, number> | undefined> {
  if (hosts.length === 0) return {};
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', SMB_AS_ME(hosts)],
    {
      env: powershellEnv(process.env),
      timeoutMs: 120_000,
    },
  );
  try {
    const raw = r.code === 0 ? (JSON.parse(r.stdout.trim()) as Record<string, unknown>) : undefined;
    if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') out[k] = v;
    return out;
  } catch {
    return undefined;
  }
}
