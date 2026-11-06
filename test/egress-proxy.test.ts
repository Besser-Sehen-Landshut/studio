import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRules,
  connectTarget,
  egressProblem,
  ipv4,
  LOOPBACK,
  startEgressProxy,
} from '../src/egress-proxy.js';

describe('the allowlist', () => {
  const rules = allowRules([
    'github.com',
    '*.crates.io',
    'example.org:8443',
    ipv4(10, 0, 0, 1),
    '*',
  ]);

  it('lets an exact name on 443, a subdomain of a wildcard, and a named port through', () => {
    expect(egressProblem(rules, 'github.com', 443)).toBeUndefined();
    expect(egressProblem(rules, 'GitHub.com.', 443)).toBeUndefined();
    expect(egressProblem(rules, 'static.crates.io', 443)).toBeUndefined();
    expect(egressProblem(rules, 'example.org', 8443)).toBeUndefined();
  });

  it('refuses other ports, other names, the bare wildcard name, IPs and local names', () => {
    expect(egressProblem(rules, 'github.com', 22)).toBe('not in network_allow');
    expect(egressProblem(rules, 'api.github.com', 443)).toBe('not in network_allow');
    expect(egressProblem(rules, 'crates.io', 443)).toBe('not in network_allow');
    expect(egressProblem(rules, 'evilgithub.com', 443)).toBe('not in network_allow');
    expect(egressProblem(rules, ipv4(10, 0, 0, 1), 443)).toBe('an IP address');
    expect(egressProblem(rules, '0x7f.1', 443)).toBe('an IP address');
    expect(egressProblem(rules, '[::1]', 443)).toBe('an IP address');
    expect(egressProblem(rules, 'localhost', 443)).toBe('a local name');
    expect(egressProblem(rules, 'intranet', 443)).toBe('a local name');
  });

  it('never turns an IP literal or a bare * into a rule', () => {
    expect(rules.map((r) => r.host)).toEqual(['github.com', 'crates.io', 'example.org']);
  });
});

describe('connectTarget', () => {
  it('reads CONNECT host:port and nothing else', () => {
    expect(connectTarget('CONNECT github.com:443 HTTP/1.1\r\nHost: x')).toEqual({
      host: 'github.com',
      port: 443,
    });
    expect(connectTarget('CONNECT [::1]:443 HTTP/1.1')).toEqual({ host: '::1', port: 443 });
    expect(connectTarget('GET http://github.com/ HTTP/1.1')).toBeUndefined();
    expect(connectTarget('CONNECT github.com HTTP/1.1')).toBeUndefined();
    expect(connectTarget('CONNECT github.com:0 HTTP/1.1')).toBeUndefined();
  });
});

describe('the proxy', () => {
  let upstream: Server;
  let upstreamPort = 0;
  const dialed: string[] = [];

  beforeAll(async () => {
    upstream = createServer((s) => s.pipe(s));
    await new Promise<void>((r) => upstream.listen(0, LOOPBACK, () => r()));
    upstreamPort = (upstream.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

  /** Sends `text` to the proxy and collects what comes back until it closes or `until` matches. */
  const talk = (port: number, text: string, until?: RegExp) =>
    new Promise<string>((resolve) => {
      const s: Socket = connect({ host: LOOPBACK, port });
      let got = '';
      s.on('data', (d) => {
        got += d.toString('latin1');
        if (until?.test(got)) {
          s.destroy();
          resolve(got);
        }
      });
      s.on('close', () => resolve(got));
      s.write(text);
    });

  const start = () =>
    startEgressProxy({
      allow: ['github.com'],
      dial: (host, port) => {
        dialed.push(`${host}:${port}`);
        return connect({ host: LOOPBACK, port: upstreamPort });
      },
    });

  it('tunnels an allowed name, bytes after the head included', async () => {
    const proxy = await start();
    const got = await talk(
      proxy.port,
      'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\nping',
      /ping$/,
    );
    expect(got).toBe('HTTP/1.1 200 Connection Established\r\n\r\nping');
    expect(dialed).toContain('github.com:443');
    await proxy.close();
  });

  it('refuses a name that is not allowed, and plain HTTP, without dialing', async () => {
    const proxy = await start();
    const before = dialed.length;
    expect(await talk(proxy.port, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n')).toMatch(
      /^HTTP\/1\.1 403 /,
    );
    expect(await talk(proxy.port, 'GET http://github.com/ HTTP/1.1\r\n\r\n')).toMatch(
      /^HTTP\/1\.1 405 /,
    );
    expect(await talk(proxy.port, `CONNECT ${LOOPBACK}:22 HTTP/1.1\r\n\r\n`)).toMatch(
      /^HTTP\/1\.1 403 /,
    );
    expect(dialed.length).toBe(before);
    expect(proxy.refused).toEqual([
      'example.com:443 (not in network_allow)',
      `${LOOPBACK}:22 (an IP address)`,
    ]);
    await proxy.close();
  });

  it('refuses an endless head', async () => {
    const proxy = await start();
    expect(
      await talk(proxy.port, `CONNECT github.com:443 HTTP/1.1\r\nX: ${'a'.repeat(9000)}`),
    ).toMatch(/^HTTP\/1\.1 431 /);
    await proxy.close();
  });
});
