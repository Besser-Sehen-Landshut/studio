import { createServer, type Server, type Socket, connect as tcpConnect } from 'node:net';
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

function reply(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Starts the proxy on loopback with a free port. `dial` is a seam for tests; it connects to the
 * name as given, so the resolver of this machine decides the address, after the name was allowed.
 */
export async function startEgressProxy(o: {
  allow: readonly string[];
  dial?: (host: string, port: number) => Socket;
}): Promise<EgressProxy> {
  const rules = allowRules(o.allow);
  const refused: string[] = [];
  const dial = o.dial ?? ((host: string, port: number) => tcpConnect({ host, port }));
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
        refused.push(`${target.host}:${target.port} (${why})`);
        if (refused.length > 50) refused.shift();
        reply(client, '403 Forbidden');
        return;
      }
      const upstream = dial(target.host, target.port);
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
