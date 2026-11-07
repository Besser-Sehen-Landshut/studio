// The Windows crew sandbox of a relay worker, put together (src/relay-serve.ts `RelayWindows`):
// the checks before every start, as the relay account and as the crew user of the job, the launch
// with the egress proxy, and stopping a crew. The relay account is a standard user: what needs an
// administrator (ending the crew users' processes, deleting them, making a fresh one per job) goes
// through the broker tasks.
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { brokerCrewAccounts } from './crew-accounts.js';
import { LOOPBACK } from './egress-proxy.js';
import { HeldError } from './held.js';
import type { Ports } from './ports.js';
import { localSubnets, ownAddresses, smbCandidates, smbProblem } from './relay-hosts.js';
import {
  denyNameDrift,
  gapFix,
  type LockdownWant,
  lockdownProblem,
  lockdownWant,
  NO_LOCKDOWN,
  smbCodesAsMe,
} from './relay-lockdown.js';
import type { RelayWindows } from './relay-serve.js';
import { readInstallRecord } from './relay-uninstall.js';
import {
  brokerResultFiles,
  brokerTasks,
  loopbackListeners,
  machineCredFile,
  machineCredProblem,
  neighborTable,
  tailscaleStatus,
  webClientProblem,
} from './relay-windows.js';
import {
  CLAUDE_HOSTS,
  findClaude,
  type ProbeResult,
  powershellEnv,
  probeProblem,
  probeWindowsResults,
  psQuote,
  type RunFile,
  runFile,
  type SpawnKeeper,
  WindowsGrants,
  windowsClaude,
  windowsCrewEnv,
} from './windows-sandbox.js';

/** Whether this process holds an enabled Administrators group: a relay account must not. */
export async function elevated(run: RunFile): Promise<boolean | undefined> {
  const r = await run('whoami', ['/groups', '/fo', 'csv', '/nh']);
  if (r.code !== 0) return undefined;
  return r.stdout
    .split(/\r?\n/)
    .some((l) => l.includes('S-1-5-32-544') && !/deny only|nur verweigern/i.test(l));
}

/** Checks a relay start judges itself, from the results the crew user's probe printed. */
const OWN_CHECKS = ['smb', 'loopback'];

/**
 * Judges a relay probe: every base check of the Windows crew sandbox must hold (else refused); a
 * session the crew user opened over SMB refuses, any other SMB error holds; a denied loopback port
 * the crew user reached holds (the owner stops that service or the start waits).
 */
export function judgeRelayProbe(
  results: readonly ProbeResult[],
  smbHosts: readonly string[],
): { kind: 'held' | 'refused'; line: string } | undefined {
  const base = probeProblem(results.filter((r) => !OWN_CHECKS.includes(r.check)));
  if (base !== undefined) return { kind: 'refused', line: base };
  const loop = results.find((r) => r.check === 'loopback');
  if (loop !== undefined && !loop.ok) {
    return {
      kind: 'held',
      line: `the crew user can reach a denied port on loopback (${loop.detail}); stop that service or move it off loopback`,
    };
  }
  if (smbHosts.length > 0) {
    const smb = results.find((r) => r.check === 'smb');
    return smbProblem(smbHosts, smb?.codes);
  }
  return undefined;
}

export function relayWindows(o: {
  /** The name prefix of the crew users. */
  prefix: string;
  /** The relay home (relay-windows.ts): state and config; the crew user must not read it. */
  home: string;
  /** The admin-only tree: the sealed credential and the brokers' answers. */
  machine: string;
  task: string;
  stateRoot: string;
  ownerRoot: string;
  crewConfigDir: string;
  ownerHome: string;
  ownerConfigDir: string;
  /** Addresses the crew user must not reach, from `workers.serve.probe_unreachable`. */
  unreachable: readonly string[];
  env: Record<string, string | undefined>;
  ports: Ports;
  startProxy: (allow: readonly string[]) => Promise<{ port: number; close(): Promise<void> }>;
  run?: RunFile;
  spawn?: SpawnKeeper;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  /** Seam for tests: the lockdown check as the relay account. */
  lockdown?: (
    run: RunFile,
    want: LockdownWant,
  ) => Promise<{ kind: 'held' | 'refused'; line: string } | undefined>;
  /** Seam for tests: name resolution of deny.hosts. */
  lookup?: (name: string) => Promise<string[]>;
  /** Seam for tests: the SMB check as the relay account. */
  smbAsMe?: (run: RunFile, hosts: readonly string[]) => Promise<Record<string, number> | undefined>;
}): RelayWindows {
  const run = o.run ?? runFile;
  const credFile = machineCredFile(o.machine);
  const path = o.env.PATH ?? o.env.Path;
  const claudeBin = findClaude(path) ?? 'claude';
  const ifaces = () => (o.interfaces ?? networkInterfaces)();
  const accounts = brokerCrewAccounts({
    run,
    tasks: brokerTasks(o.task),
    results: brokerResultFiles(o.machine),
    credFile,
    readFile: (f) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return undefined;
      }
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const grants = new WindowsGrants({ ownerRoot: o.ownerRoot, accounts, run });
  const claude = () =>
    windowsClaude({
      stateRoot: o.stateRoot,
      claudeBin,
      grants,
      run,
      ...(o.spawn === undefined ? {} : { spawn: o.spawn }),
    });
  return {
    async check({ deny, hosts, lead }) {
      const warnings: string[] = [];
      const admin = await elevated(run);
      if (admin !== false) {
        return {
          problem: {
            kind: 'refused',
            line:
              admin === undefined
                ? 'cannot tell whether the relay account is an administrator'
                : 'the relay account is an administrator: the lead must log in as a standard account (studio relay setup)',
          },
          warnings,
        };
      }
      // The network lockdown, as the relay account itself meets it: refused by the firewall. Only
      // an install with --no-firewall goes without, and doctor says so.
      const record = readInstallRecord(o.machine);
      if (record?.firewall === false) {
        warnings.push(NO_LOCKDOWN);
      } else {
        // The rule in the active policy, every profile on, every local prefix inside the rule, and
        // the firewall's own refusal from the fixed targets and an IPv6 one; then every deny entry
        // of the config in force (prefixes, hosts as they resolve now, ports) inside the active
        // rules: one added after the install holds the start.
        const want = await lockdownWant({
          deny: { hosts, ports: deny.ports, prefixes: deny.prefixes ?? [] },
          ...(o.lookup === undefined ? {} : { lookup: o.lookup }),
          ...(lead === undefined ? {} : { lead }),
        });
        const lock = await (o.lockdown ?? lockdownProblem)(run, want);
        if (lock !== undefined) return { problem: lock, warnings };
        // Every name of deny.hosts resolved anew: one past its rule holds the start.
        const drift = await denyNameDrift({
          denyHosts: hosts,
          recorded: record?.lockdownNames ?? {},
          ...(o.lookup === undefined ? {} : { lookup: o.lookup }),
        });
        if (drift.length > 0) {
          return {
            problem: {
              kind: 'held',
              line: `${drift.join('; ')}: ${gapFix(lead)}`,
            },
            warnings,
          };
        }
      }
      const web = await webClientProblem(run);
      if (web !== undefined) return { problem: { kind: 'held', line: web }, warnings };
      // Loopback is not filtered by the Windows firewall, and the crew user's rule leaves it open
      // for the proxy: a denied port listening there would be open to the crew.
      const listeners = await loopbackListeners(run);
      if (listeners === undefined) {
        return {
          problem: { kind: 'held', line: 'the loopback listeners cannot be read' },
          warnings,
        };
      }
      const loopback: { host: string; port: number }[] = [];
      for (const l of listeners) {
        if (deny.ports.includes(l.port)) {
          if (l.protocol === 'udp') {
            return {
              problem: {
                kind: 'held',
                line: `denied UDP port ${l.port} listens on ${l.address} (pid ${l.pid}); stop that service or move it off loopback`,
              },
              warnings,
            };
          }
          const host = l.address.includes(':') ? '::1' : LOOPBACK;
          if (!loopback.some((x) => x.host === host && x.port === l.port))
            loopback.push({ host, port: l.port });
        } else {
          warnings.push(
            `loopback listener ${l.protocol} ${l.address}:${l.port} (pid ${l.pid}) is open to the crew user`,
          );
        }
      }
      const candidates = smbCandidates({
        entries: hosts,
        neighbors: hosts.some((h) => h === 'local-subnets' || h.includes('/'))
          ? await neighborTable(run)
          : [],
        subnets: localSubnets(ifaces()),
        tailscale: hosts.includes('tailnet-peers') ? await tailscaleStatus(run) : undefined,
        own: ownAddresses(ifaces()),
      });
      warnings.push(...candidates.notes);
      if (candidates.hosts.length > 0)
        warnings.push(`SMB candidates: ${candidates.hosts.join(', ')}`);
      if (candidates.problem !== undefined) {
        return { problem: { kind: 'refused', line: candidates.problem }, warnings };
      }
      // SMB goes through the redirector in the System process, past every per-user rule: the relay
      // account must not open a session either (the crew user's probe below checks the crew user).
      if (candidates.hosts.length > 0) {
        const codes = await (o.smbAsMe ?? smbCodesAsMe)(run, candidates.hosts);
        const smb = smbProblem(candidates.hosts, codes);
        if (smb !== undefined) {
          return {
            problem: {
              kind: smb.kind,
              line: smb.line.replace(/the crew user/g, 'the relay account'),
            },
            warnings,
          };
        }
      }
      // Hosts of the network found above: a direct connection to them must fail (the firewall rule
      // of the crew user). This machine's own addresses count as loopback for Windows and are left
      // out; the loopback listeners above cover them.
      const neighbors = candidates.hosts.filter((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h)).slice(0, 8);
      const unreachable = [
        ...neighbors.flatMap((host) => [445, ...deny.ports].map((port) => ({ host, port }))),
        ...o.unreachable.map((e) => {
          const at = e.lastIndexOf(':');
          return { host: e.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(e.slice(at + 1)) };
        }),
      ];
      // The crew user of the coming job: a fresh one, unless no crew ran as the one made before.
      try {
        const account = await grants.ready();
        // What retiring the last crew users left to say: doctor shows it.
        for (const line of account.notes?.problems ?? [])
          warnings.push(`retiring a crew user: ${line}`);
        for (const path of account.notes?.stuck ?? []) {
          warnings.push(
            `the quarantine cannot delete ${path}; it is left alone: delete it by hand`,
          );
        }
        const waiting = account.notes?.quarantined ?? 0;
        if (waiting !== 0) {
          warnings.push(
            waiting < 0
              ? 'the quarantine of retired crew profiles cannot be read'
              : `${waiting} retired crew profile(s) wait in the quarantine; each retire deletes part of them`,
          );
        }
      } catch (e) {
        return {
          problem: {
            kind: e instanceof HeldError ? 'held' : 'refused',
            line: `no crew user for the coming job: ${(e as Error).message}`,
          },
          warnings,
        };
      }
      const cred = await machineCredProblem(run, credFile);
      if (cred !== undefined) return { problem: { kind: 'refused', line: cred }, warnings };
      const proxy = await o.startProxy([...CLAUDE_HOSTS]);
      try {
        const tmp = join(o.stateRoot, 'tmp');
        const r = await probeWindowsResults({
          stateRoot: o.stateRoot,
          ownerHome: o.ownerHome,
          ownerConfigDir: o.ownerConfigDir,
          mustNotRead: [...deny.paths, o.home, credFile],
          crewConfigDir: o.crewConfigDir,
          grants,
          proxyPort: proxy.port,
          env: {
            ...windowsCrewEnv({ proxyPort: proxy.port, homeDir: tmp, tmpDir: tmp, base: o.env }),
            PATH: path ?? '',
          },
          timeoutMs: 300_000,
          extra: {
            unreachable,
            loopback,
            smb: candidates.hosts,
            noStoredCredentials: true,
          },
          ...(o.spawn === undefined ? {} : { spawn: o.spawn }),
        });
        if ('problem' in r) return { problem: { kind: 'refused', line: r.problem }, warnings };
        const judged = judgeRelayProbe(r.results, candidates.hosts);
        return judged === undefined ? { warnings } : { problem: judged, warnings };
      } catch (e) {
        return {
          problem: {
            kind: 'refused',
            line: `the Windows crew sandbox could not be shown to hold here: ${(e as Error).message}`,
          },
          warnings,
        };
      } finally {
        await proxy.close();
      }
    },
    async launch(networkAllow) {
      const proxy = await o.startProxy([...networkAllow, ...CLAUDE_HOSTS]);
      return {
        claude: claude(),
        launch: {
          user: o.prefix,
          proxyPort: proxy.port,
          grant: (g) => grants.grant(g, { launch: true }),
        },
        close: () => proxy.close(),
      };
    },
    claude,
    sweep: () => accounts.sweep(),
    retire: () => grants.retire(),
  };
}

/**
 * Whether the admin-only tree may be trusted to run from: the folders of the copies of Node.js and
 * Studio this process runs, the tree around them, and the relay home with every folder above it.
 * None may be a reparse point, each must be owned by administrators, SYSTEM or TrustedInstaller,
 * and in the tree no other account may write. Undefined when all holds; else the refusal.
 */
export async function machineTreeProblem(
  run: RunFile,
  o: { machine: string; home: string; node: string; studioBin: string },
): Promise<string | undefined> {
  const inside = (p: string, dir: string) =>
    p.toLowerCase().startsWith(`${dir.toLowerCase().replace(/[\\/]+$/, '')}\\`);
  if (!inside(o.node, o.machine) || !inside(o.studioBin, o.machine)) {
    return `studio relay serve runs only from the admin-only copies in ${o.machine} (studio relay install)`;
  }
  const m = psQuote(o.machine);
  const h = psQuote(o.home);
  const script = `$ErrorActionPreference = 'Stop'
$admin = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$write = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
$fill = [Security.AccessControl.FileSystemRights]'ReadAndExecute, CreateFiles, CreateDirectories, Synchronize'
function Up([string]$p) { $out = @(); while ($p) { $out += $p; $u = Split-Path -Parent $p; if (-not $u -or $u -eq $p) { break }; $p = $u }; $out }
$problems = @()
foreach ($p in @(Up ${m}) + @(Up (Join-Path ${h} 'state'))) {
  if (-not (Test-Path -LiteralPath $p)) { $problems += "$p is missing"; continue }
  if ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { $problems += "$p is a reparse point" }
}
# No reparse point anywhere in the config (small, admin-only), none just below state: the elevated
# install hands DACL entries down these folders.
$todo = New-Object Collections.Stack
if (Test-Path -LiteralPath (Join-Path ${m} 'config')) { $todo.Push((Join-Path ${m} 'config')) }
while ($todo.Count -gt 0) {
  foreach ($c in Get-ChildItem -LiteralPath $todo.Pop() -Force) {
    if ($c.Attributes -band [IO.FileAttributes]::ReparsePoint) { $problems += "$($c.FullName) is a reparse point"; continue }
    if ($c.PSIsContainer) { $todo.Push($c.FullName) }
  }
}
if (Test-Path -LiteralPath (Join-Path ${h} 'state')) {
  foreach ($c in Get-ChildItem -LiteralPath (Join-Path ${h} 'state') -Force) {
    if ($c.Attributes -band [IO.FileAttributes]::ReparsePoint) { $problems += "$($c.FullName) is a reparse point" }
  }
}
# Each folder of Studio's: owned by administrators, its DACL protected, and no entry but the ones
# the setup makes. Only state takes the relay account's writes: files and folders added to it, and
# modify below it (inherit-only); it can rename or remove neither state nor anything above.
$folders = @(
  @(${m}, 'read'), @((Join-Path ${m} 'node'), 'read'), @((Join-Path ${m} 'studio'), 'read'),
  @((Join-Path ${m} 'broker'), 'read'),
  @((Join-Path ${m} 'config'), 'read'), @((Split-Path -Parent ${h}), 'read'), @(${h}, 'read'),
  @((Join-Path ${h} 'state'), 'fill')
)
foreach ($f in $folders) {
  $p = $f[0]
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $acl = Get-Acl -LiteralPath $p
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($admin -notcontains $owner) { $problems += "$p is owned by $owner" }
  if (-not $acl.AreAccessRulesProtected) { $problems += "$p inherits its ACL" }
  foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $r.IdentityReference.Value
    if ($admin -contains $sid) { continue }
    if ($r.AccessControlType -ne 'Allow') { continue }
    $writes = ($r.FileSystemRights -band $write) -ne 0
    if ($f[1] -eq 'fill' -and $sid -eq $me) {
      if ($r.PropagationFlags -eq 'InheritOnly') { continue }
      if (([int]$r.FileSystemRights -band (-bnot [int]$fill)) -ne 0) { $problems += "$p gives $sid more than adding files" }
      continue
    }
    if ($writes) { $problems += "$p is writable by $sid" }
  }
}
ConvertTo-Json -Compress -InputObject @($problems)`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: powershellEnv(process.env),
    timeoutMs: 60_000,
  });
  let problems: unknown;
  try {
    problems = r.code === 0 ? JSON.parse(r.stdout.trim() || 'null') : undefined;
  } catch {
    problems = undefined;
  }
  if (!Array.isArray(problems)) return 'the admin-only tree of this relay worker cannot be checked';
  return problems.length === 0
    ? undefined
    : `the admin-only tree of this relay worker cannot be trusted (${problems.slice(0, 3).join('; ')}); run studio relay install again, elevated`;
}
