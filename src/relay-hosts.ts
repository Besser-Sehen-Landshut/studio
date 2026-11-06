// The hosts a Windows crew must not reach over SMB (`deny.hosts`), as the probe of a Windows worker
// checks them before every start. The crew user's firewall rule does not hold SMB: a UNC path goes
// through the kernel redirector in the System process, whatever user asked for it. So the probe,
// as the crew user, opens `\\<host>\IPC$` without credentials against every candidate: a session
// that opens fails the start; access denied or not found passes; anything else holds it.
//
// Candidates are never found by connecting from the worker's accounts, whose outbound traffic to
// private ranges the owner's firewall may block (a sweep would find nothing and prove nothing):
// they are the explicit entries, the neighbor table inside the configured ranges, and the peers of
// `tailscale status --json`. A configured range with no candidate refuses: an empty set never
// passes.
import { networkInterfaces } from 'node:os';
import { DENY_HOST_KEYWORDS } from './config.js';

/** IPv4 as a 32-bit number; undefined for anything else. */
export function ipv4Number(s: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return (
    (((parts[0] as number) << 24) >>> 0) +
    ((parts[1] as number) << 16) +
    ((parts[2] as number) << 8) +
    (parts[3] as number)
  );
}

const ipv4Text = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export interface Range {
  /** The range as written or found: `<address>/<bits>`. */
  name: string;
  base: number;
  bits: number;
}

/** The widest range one entry may cover: /22, 1024 addresses. */
export const WIDEST_BITS = 22;

export function rangeOf(cidr: string): Range | undefined {
  const m = /^([^/]+)\/(\d{1,2})$/.exec(cidr);
  const ip = m === null ? undefined : ipv4Number(m[1] as string);
  if (m === null || ip === undefined) return undefined;
  const bits = Number(m[2]);
  if (bits < WIDEST_BITS || bits > 32) return undefined;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const base = (ip & mask) >>> 0;
  return { name: `${ipv4Text(base)}/${bits}`, base, bits };
}

export const inRange = (r: Range, ip: number): boolean =>
  r.bits === 0 || ip >>> (32 - r.bits) === r.base >>> (32 - r.bits);

/** 10/8, 172.16/12, 192.168/16: the private IPv4 ranges a local subnet may lie in. */
export function privateIpv4(ip: number): boolean {
  return ip >>> 24 === 10 || ip >>> 20 === (172 << 4) + 1 || ip >>> 16 === (192 << 8) + 168;
}

/**
 * The private IPv4 subnets this machine's interfaces sit in, each capped at /22 around the
 * interface's own address (a wider subnet is checked only where the machine itself is).
 */
export function localSubnets(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): Range[] {
  const out: Range[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = ipv4Number(a.address);
      if (ip === undefined || !privateIpv4(ip)) continue;
      const bits = Math.max(WIDEST_BITS, Number(a.cidr?.split('/')[1] ?? 24));
      const r = rangeOf(`${a.address}/${bits}`);
      if (r !== undefined && !out.some((o) => o.name === r.name)) out.push(r);
    }
  }
  return out;
}

/** The addresses of a machine's own interfaces: never a candidate. */
export function ownAddresses(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): Set<string> {
  return new Set(
    Object.values(ifaces).flatMap((l) => (l ?? []).map((a) => a.address.toLowerCase())),
  );
}

/** The peer addresses of `tailscale status --json`; undefined when it cannot be read. */
export function tailnetPeers(json: string | undefined): string[] | undefined {
  if (json === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  const peers = (raw as { Peer?: unknown } | null)?.Peer;
  if (peers === null || typeof peers !== 'object') return [];
  const out: string[] = [];
  for (const p of Object.values(peers as Record<string, unknown>)) {
    const ips = (p as { TailscaleIPs?: unknown } | null)?.TailscaleIPs;
    if (!Array.isArray(ips)) continue;
    for (const ip of ips) {
      if (typeof ip === 'string' && /^[0-9A-Fa-f:.]{2,45}$/.test(ip) && !out.includes(ip)) {
        out.push(ip);
      }
    }
  }
  return out;
}

/** One entry of the neighbor table (`Get-NetNeighbor`): an address and its state. */
export interface Neighbor {
  address: string;
  state: string;
}

/** States of a neighbor entry that name no machine that answered. */
const NO_HOST = new Set(['unreachable', 'incomplete']);

export interface Candidates {
  /** Addresses and names the crew user's SMB check goes against. */
  hosts: string[];
  /** Why the check cannot be trusted now: a configured range without any candidate. */
  problem?: string;
  /** Lines for doctor: where the candidates came from, what could not be read. */
  notes: string[];
}

/**
 * The SMB candidates of a deny list: every explicit host or address; of the neighbor table, the
 * addresses inside each configured range (`local-subnets` expands to this machine's private
 * subnets); with `tailnet-peers`, the peers Tailscale knows. A range with no candidate at all is a
 * problem: the probe must never pass on an empty set.
 */
export function smbCandidates(o: {
  entries: readonly string[];
  neighbors: readonly Neighbor[] | undefined;
  subnets: readonly Range[];
  /** `tailscale status --json`, or undefined when Tailscale is not installed or not running. */
  tailscale: string | undefined;
  own: ReadonlySet<string>;
}): Candidates {
  const hosts: string[] = [];
  const notes: string[] = [];
  const add = (h: string) => {
    const k = h.toLowerCase();
    if (!o.own.has(k) && !hosts.includes(k)) hosts.push(k);
  };
  const ranges: Range[] = [];
  for (const e of o.entries) {
    if (e === 'local-subnets') {
      if (o.subnets.length === 0)
        notes.push('local-subnets: this machine sits in no private IPv4 subnet');
      for (const s of o.subnets) if (!ranges.some((r) => r.name === s.name)) ranges.push(s);
    } else if (e === 'tailnet-peers') {
      const peers = tailnetPeers(o.tailscale);
      if (peers === undefined) {
        notes.push(
          'tailnet-peers: Tailscale is not installed or not running here; no peers checked',
        );
      } else {
        notes.push(`tailnet-peers: ${peers.length} peer address(es)`);
        for (const p of peers) add(p);
      }
    } else if (e.includes('/')) {
      const r = rangeOf(e);
      if (r !== undefined && !ranges.some((x) => x.name === r.name)) ranges.push(r);
    } else if (!(DENY_HOST_KEYWORDS as readonly string[]).includes(e)) {
      add(e);
    }
  }
  let problem: string | undefined;
  for (const r of ranges) {
    if (o.neighbors === undefined) {
      problem = `the neighbor table cannot be read, so the hosts of ${r.name} cannot be found for the SMB check`;
      break;
    }
    const inside = o.neighbors.filter((n) => {
      const ip = ipv4Number(n.address);
      return ip !== undefined && inRange(r, ip) && !NO_HOST.has(n.state.toLowerCase());
    });
    const before = hosts.length;
    for (const n of inside) add(n.address);
    notes.push(`${r.name}: ${hosts.length - before} neighbor(s)`);
    if (inside.length === 0) {
      problem = `the neighbor table holds no host in ${r.name}, so the SMB check would prove nothing; check the range in deny.hosts`;
      break;
    }
  }
  return { hosts, notes, ...(problem === undefined ? {} : { problem }) };
}

/** System error codes of an SMB connection the crew user could not open: it was refused. */
export const SMB_DENIED = [5, 86, 1326, 1327, 1331, 1909] as const;
/** System error codes of an SMB connection that found nothing to talk to. */
export const SMB_CLOSED = [53, 64, 67, 1231] as const;

/** The verdict of one host's SMB check as the crew user: its system error code, 0 for a session. */
export function smbVerdict(code: number): 'denied' | 'closed' | 'open' | 'other' {
  if (code === 0) return 'open';
  if ((SMB_DENIED as readonly number[]).includes(code)) return 'denied';
  if ((SMB_CLOSED as readonly number[]).includes(code)) return 'closed';
  return 'other';
}

/**
 * Judges the crew user's SMB results: a session without credentials fails the start, any code
 * that is neither denied nor closed holds it, naming the host and the code. A candidate without a
 * result holds as well.
 */
export function smbProblem(
  hosts: readonly string[],
  results: Readonly<Record<string, number>> | undefined,
): { kind: 'held' | 'refused'; line: string } | undefined {
  if (hosts.length === 0) return undefined;
  if (results === undefined) {
    return { kind: 'held', line: 'the SMB check as the crew user gave no answer' };
  }
  for (const h of hosts) {
    const code = results[h];
    if (code === undefined) {
      return { kind: 'held', line: `the SMB check as the crew user gave no answer for ${h}` };
    }
    const v = smbVerdict(code);
    if (v === 'open') {
      return {
        kind: 'refused',
        line: `the crew user opened an SMB session to ${h} without credentials; close that share or deny the host to the crew user`,
      };
    }
    if (v === 'other') {
      return {
        kind: 'held',
        line: `the SMB check of ${h} as the crew user ended with error ${code}`,
      };
    }
  }
  return undefined;
}
