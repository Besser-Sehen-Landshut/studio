import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRules,
  blockedAddress,
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

describe('blockedAddress', () => {
  it('blocks loopback, private, link-local, multicast, unspecified and mapped forms', () => {
    for (const a of [
      ipv4(127, 0, 0, 1),
      ipv4(10, 0, 0, 1),
      ipv4(172, 20, 0, 1),
      ipv4(192, 168, 0, 1),
      ipv4(169, 254, 169, 254),
      ipv4(100, 64, 0, 1),
      ipv4(0, 0, 0, 0),
      ipv4(224, 0, 0, 1),
      ipv4(255, 255, 255, 255),
      '::',
      '::1',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      `::ffff:${ipv4(127, 0, 0, 1)}`,
      'not-an-address',
    ]) {
      expect(blockedAddress(a), a).toBe(true);
    }
    expect(blockedAddress(ipv4(140, 82, 121, 3))).toBe(false);
  });

  it('judges an IPv6 address by the IPv4 address it carries', () => {
    const inside = [
      '64:ff9b::7f00:1', // NAT64 of loopback
      `64:ff9b::${ipv4(10, 0, 0, 1)}`,
      '2002:c0a8:101::1', // 6to4 of a private address
      '::a00:1', // IPv4-compatible, private
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo, client a documentation address, inverted
      '2001:0:a00:1::1', // Teredo, private server
      '100::1', // discard-only
    ];
    for (const a of inside) expect(blockedAddress(a), a).toBe(true);
    // The same forms around a public address pass.
    expect(blockedAddress(`64:ff9b::${ipv4(140, 82, 121, 3)}`)).toBe(false);
    expect(blockedAddress('2002:8c52:7903::1')).toBe(false);
    expect(blockedAddress('2606:50c0:8000::153')).toBe(false);
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

  /** github.com resolves to a public address; the others lead inside. */
  const PUBLIC = ipv4(140, 82, 121, 3);
  const answers: Record<string, string[]> = {
    'github.com': [PUBLIC],
    'inside.github.com': [ipv4(10, 1, 2, 3)],
    'mixed.github.com': [PUBLIC, '::1'],
    'mapped.github.com': [`::ffff:${ipv4(192, 168, 1, 1)}`],
  };
  const start = () =>
    startEgressProxy({
      allow: ['github.com', '*.github.com'],
      resolve: async (host) => {
        const a = answers[host];
        if (a === undefined) throw new Error('ENOTFOUND');
        return a;
      },
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
    // The tunnel goes to the address the proxy checked, not to the name.
    expect(dialed).toContain(`${PUBLIC}:443`);
    await proxy.close();
  });

  it('refuses an allowed name whose answer leads inside, or that does not resolve', async () => {
    const proxy = await start();
    const before = dialed.length;
    for (const name of ['inside', 'mixed', 'mapped', 'gone']) {
      expect(await talk(proxy.port, `CONNECT ${name}.github.com:443 HTTP/1.1\r\n\r\n`)).toMatch(
        /^HTTP\/1\.1 403 /,
      );
    }
    expect(dialed.length).toBe(before);
    expect(proxy.refused).toEqual([
      `inside.github.com:443 (resolves to a local or private address (${ipv4(10, 1, 2, 3)}))`,
      'mixed.github.com:443 (resolves to a local or private address (::1))',
      `mapped.github.com:443 (resolves to a local or private address (::ffff:${ipv4(192, 168, 1, 1)}))`,
      'gone.github.com:443 (does not resolve)',
    ]);
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
