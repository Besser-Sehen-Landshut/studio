// The Windows crew sandbox of a relay worker, put together (src/relay-serve.ts `RelayWindows`):
// the checks before every start, as the relay account and as the crew user, the launch with the
// egress proxy, and stopping a crew. The relay account is a standard user: what needs an
// administrator (ending the crew user's processes) goes through the broker task.
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { LOOPBACK } from './egress-proxy.js';
import type { Ports } from './ports.js';
import { localSubnets, ownAddresses, smbCandidates, smbProblem } from './relay-hosts.js';
import type { RelayWindows } from './relay-serve.js';
import {
  brokerResultFile,
  brokerSweep,
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
  probeProblem,
  probeWindowsResults,
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
  user: string;
  /** The relay home (relay-windows.ts): the sealed credential and the broker's files. */
  home: string;
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
}): RelayWindows {
  const run = o.run ?? runFile;
  const credFile = machineCredFile(o.home);
  const path = o.env.PATH ?? o.env.Path;
  const claudeBin = findClaude(path) ?? 'claude';
  const ifaces = () => (o.interfaces ?? networkInterfaces)();
  const grants = new WindowsGrants({
    ownerRoot: o.ownerRoot,
    user: o.user,
    run,
    sweep: () =>
      brokerSweep({
        run,
        task: o.task,
        result: brokerResultFile(o.home),
        readFile: (f) => {
          try {
            return readFileSync(f, 'utf8');
          } catch {
            return undefined;
          }
        },
        now: () => new Date(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
  });
  const claude = () =>
    windowsClaude({
      stateRoot: o.stateRoot,
      credFile,
      claudeBin,
      user: o.user,
      grants,
      run,
      machine: true,
      ...(o.spawn === undefined ? {} : { spawn: o.spawn }),
    });
  return {
    async check({ deny, hosts }) {
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
      const cred = await machineCredProblem(run, credFile);
      if (cred !== undefined) return { problem: { kind: 'refused', line: cred }, warnings };
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
      const proxy = await o.startProxy([...CLAUDE_HOSTS]);
      try {
        const tmp = join(o.stateRoot, 'tmp');
        const r = await probeWindowsResults({
          stateRoot: o.stateRoot,
          credFile,
          user: o.user,
          ownerHome: o.ownerHome,
          ownerConfigDir: o.ownerConfigDir,
          mustNotRead: [...deny.paths, o.home],
          crewConfigDir: o.crewConfigDir,
          grants,
          proxyPort: proxy.port,
          env: {
            ...windowsCrewEnv({ proxyPort: proxy.port, homeDir: tmp, tmpDir: tmp, base: o.env }),
            PATH: path ?? '',
          },
          machine: true,
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
        launch: { user: o.user, proxyPort: proxy.port, grant: (g) => grants.grant(g) },
        close: () => proxy.close(),
      };
    },
    claude,
  };
}
