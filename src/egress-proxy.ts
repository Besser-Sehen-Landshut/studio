import { lookup } from 'node:dns/promises';
import {
  BlockList,
  createServer,
  isIP,
  type Server,
  type Socket,
  connect as tcpConnect,
} from 'node:net';
import { networkInterfaces } from 'node:os';
import { hostPort, normalizeHost } from './worker-deny.js';

/**
 * The network boundary of a crew on native Windows (src/windows-sandbox.ts). Claude Code's own
 * sandbox does not run there, and a firewall rule can only allow or block addresses, not names. So
 * the crew user's processes may reach nothing but loopback (a firewall rule of the setup), and
 * this proxy on loopback is how they reach the outside: an HTTP CONNECT tunnel to an allowed name
 * on port 443 (or the port its `network_allow` entry names), nothing else. Plain HTTP requests,
 * IP literals, local names and every name not on the list are refused before any connection.
 */

/** An IPv4 address from its four parts (the public repository's tests refuse dotted literals). */
export const ipv4 = (...parts: [number, number, number, number]): string => parts.join('.');

/** The IPv4 loopback address, where the proxy listens. */
export const LOOPBACK = ipv4(127, 0, 0, 1);

export interface EgressProxy {
  port: number;
  /** Names refused so far, newest last (at most 50), for the worker's log. */
  refused: string[];
  close(): Promise<void>;
}

/** One allowlist entry: an exact name or `*.name` (its subdomains, not the name itself). */
interface Rule {
  host: string;
  wildcard: boolean;
  port: number;
}

const HEADER_LIMIT = 8 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;

export function allowRules(entries: readonly string[]): Rule[] {
  const rules: Rule[] = [];
  for (const entry of entries) {
    const { host, port } = hostPort(entry);
    const n = normalizeHost(host);
    // An IP literal or a bare `*` is never a name the proxy lets through.
    if (n === undefined || n.ip !== 0 || n.host === '*') continue;
    rules.push({ host: n.host, wildcard: n.wildcard, port: port ?? 443 });
  }
  return rules;
}

/** Whether `host:port` is allowed: undefined, or the reason it is not. */
export function egressProblem(
  rules: readonly Rule[],
  host: string,
  port: number,
): string | undefined {
  const n = normalizeHost(host);
  if (n === undefined || n.wildcard) return 'not a host name';
  if (n.ip !== 0) return 'an IP address';
  const h = n.host;
  if (h === 'localhost' || h.endsWith('.localhost') || !h.includes('.')) return 'a local name';
  const hit = rules.some(
    (r) => r.port === port && (r.wildcard ? h.endsWith(`.${r.host}`) : h === r.host),
  );
  return hit ? undefined : 'not in network_allow';
}

/** `CONNECT host:port HTTP/1.1` as the first line of a request head; undefined for anything else. */
export function connectTarget(head: string): { host: string; port: number } | undefined {
  const line = head.split('\r\n')[0] ?? '';
  const m = /^CONNECT ([^\s]+) HTTP\/1\.[01]$/.exec(line);
  if (!m) return undefined;
  const { host, port } = hostPort(m[1] as string);
  if (port === undefined || port < 1 || port > 65_535) return undefined;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return { host: bare, port };
}

/**
 * Addresses no allowed name may lead to: this machine, private networks, link-local, multicast,
 * unspecified and reserved ranges, IPv4 and IPv6 (mapped IPv4 included). A public name that
 * resolves to one of them (a DNS answer pointing inside) is refused like the address itself.
 */
const BLOCKED = (() => {
  const b = new BlockList();
  const v4 = (a: number, c: number, d: number, e: number, prefix: number) =>
    b.addSubnet(ipv4(a, c, d, e), prefix, 'ipv4');
  v4(0, 0, 0, 0, 8); // this network, unspecified
  v4(10, 0, 0, 0, 8); // private
  v4(100, 64, 0, 0, 10); // shared address space (carrier-grade NAT)
  v4(127, 0, 0, 0, 8); // loopback
  v4(169, 254, 0, 0, 16); // link-local
  v4(172, 16, 0, 0, 12); // private
  v4(192, 0, 0, 0, 24); // protocol assignments
  v4(192, 168, 0, 0, 16); // private
  v4(192, 0, 2, 0, 24); // documentation
  v4(198, 51, 100, 0, 24); // documentation
  v4(203, 0, 113, 0, 24); // documentation
  v4(198, 18, 0, 0, 15); // benchmarking
  v4(224, 0, 0, 0, 4); // multicast
  v4(240, 0, 0, 0, 4); // reserved, broadcast
  for (const [net, prefix] of [
    ['::', 128], // unspecified
    ['::1', 128], // loopback
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
    ['64:ff9b:1::', 48], // local-use translation
    ['100::', 64], // discard-only
  ] as const) {
    b.addSubnet(net, prefix, 'ipv6');
  }
  return b;
})();

/** Whether an address is one no tunnel may reach; anything that is not an address counts as one. */
export function blockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return BLOCKED.check(address, 'ipv4');
  if (kind !== 6) return true;
  const h = hextets(address);
  if (h === undefined) return true;
  // An IPv6 address that carries an IPv4 address is judged by that one too.
  if (embeddedIpv4(h).some((v4) => BLOCKED.check(v4, 'ipv4'))) return true;
  return BLOCKED.check(address, 'ipv6');
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail included); undefined if bad. */
export function hextets(address: string): number[] | undefined {
  let a = address.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const [b0, b1, b2, b3] = dotted.slice(1).map(Number) as [number, number, number, number];
    a = `${a.slice(0, dotted.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return undefined;
  const part = (x: string) => (x === '' ? [] : x.split(':').map((g) => Number.parseInt(g, 16)));
  const head = part(halves[0] as string);
  const tail = halves.length === 2 ? part(halves[1] as string) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return undefined;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : undefined;
}

const v4Of = (hi: number, lo: number): string =>
  ipv4((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255);

/**
 * The IPv4 addresses an IPv6 address carries: IPv4-mapped (::ffff:0:0/96), IPv4-compatible
 * (::/96), NAT64 (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001::/32: its server, and its
 * client, stored inverted).
 */
export function embeddedIpv4(h: readonly number[]): string[] {
  const [a, b, c, d, e, f, g, i] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zero = (...xs: number[]) => xs.every((x) => x === 0);
  const out: string[] = [];
  if (zero(a, b, c, d, e) && (f === 0xffff || f === 0)) out.push(v4Of(g, i));
  if (a === 0x64 && b === 0xff9b && zero(c, d, e, f)) out.push(v4Of(g, i));
  if (a === 0x2002) out.push(v4Of(b, c));
  if (a === 0x2001 && b === 0) out.push(v4Of(c, d), v4Of(g ^ 0xffff, i ^ 0xffff));
  return out;
}

export type Resolve = (host: string) => Promise<string[]>;

const systemResolve: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The address a tunnel to an allowed name goes to: resolved here, refused when any answer is an
 * address no tunnel may reach (a mixed answer is not trusted), else the first answer. The proxy
 * connects to exactly this address, so a second lookup cannot lead elsewhere.
 */
export async function checkedAddress(
  resolve: Resolve,
  host: string,
  /** The networks of this machine, on top of the fixed ranges (`onLinkBlockList`). */
  extra?: BlockList,
): Promise<{ address: string } | { refused: string }> {
  let answers: string[];
  try {
    answers = await resolve(host);
  } catch {
    return { refused: 'does not resolve' };
  }
  if (answers.length === 0) return { refused: 'does not resolve' };
  const bad = answers.find(
    (a) =>
      blockedAddress(a) || (extra !== undefined && extra.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4')),
  );
  if (bad !== undefined) return { refused: `resolves to a local or private address (${bad})` };
  return { address: answers[0] as string };
}

function reply(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Starts the proxy on loopback with a free port. An allowed name is resolved by the proxy and
 * the tunnel goes to the checked address. `dial` and `resolve` are seams for tests.
 */
/**
 * The networks this machine sits in (every prefix of its interfaces, both families), as the
 * Windows lockdown blocks them from its routing table: a name that resolves into one is refused
 * like a private address, also where the network is a public range.
 */
export function onLinkBlockList(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): BlockList {
  const b = new BlockList();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal || a.cidr === null) continue;
      const [net, bits] = a.cidr.split('/');
      try {
        b.addSubnet(net as string, Number(bits), a.family === 'IPv6' ? 'ipv6' : 'ipv4');
      } catch {
        // not an address BlockList takes
      }
    }
  }
  return b;
}

export async function startEgressProxy(o: {
  allow: readonly string[];
  dial?: (address: string, port: number) => Socket;
  resolve?: Resolve;
  /** The networks of this machine to refuse on top of the fixed ranges; its interfaces by default. */
  onLink?: BlockList;
}): Promise<EgressProxy> {
  const rules = allowRules(o.allow);
  const onLink = o.onLink ?? onLinkBlockList();
  const refused: string[] = [];
  const resolve = o.resolve ?? systemResolve;
  const dial = o.dial ?? ((address: string, port: number) => tcpConnect({ host: address, port }));
  const refuse = (client: Socket, what: string) => {
    refused.push(what);
    if (refused.length > 50) refused.shift();
    reply(client, '403 Forbidden');
  };
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > HEADER_LIMIT) reply(client, '431 Request Header Fields Too Large');
        return;
      }
      client.off('data', onData);
      const target = connectTarget(head.subarray(0, end).toString('latin1'));
      if (target === undefined) {
        reply(client, '405 Method Not Allowed');
        return;
      }
      const why = egressProblem(rules, target.host, target.port);
      if (why !== undefined) {
        refuse(client, `${target.host}:${target.port} (${why})`);
        return;
      }
      void checkedAddress(resolve, target.host, onLink).then((checked) => {
        if (client.destroyed) return;
        if ('refused' in checked) {
          refuse(client, `${target.host}:${target.port} (${checked.refused})`);
          return;
        }
        tunnel(checked.address, target.port);
      });
      const tunnel = (address: string, port: number) => {
        const upstream = dial(address, port);
        sockets.add(upstream);
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
        upstream.on('close', () => sockets.delete(upstream));
        upstream.once('connect', () => {
          upstream.setTimeout(0);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const rest = head.subarray(end + 4);
          if (rest.length > 0) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => {
          if (!client.destroyed) reply(client, '502 Bad Gateway');
          upstream.destroy();
        });
        client.on('close', () => upstream.destroy());
      };
    };
    client.on('data', onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('egress proxy: no port');
  return {
    port: address.port,
    refused,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
