// The parts of relay workers that need no second machine: the wire, the ssh call, the lead's
// checks of a result bundle, the SMB candidates and verdicts, and the Windows pieces with fakes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { relayTargetSchema } from '../src/config.js';
import { realPorts } from '../src/ports.js';
import {
  localSubnets,
  rangeOf,
  smbCandidates,
  smbProblem,
  smbVerdict,
  tailnetPeers,
} from '../src/relay-hosts.js';
import { acceptResult, type RelayRecord } from '../src/relay-lead.js';
import {
  CHUNK_BYTES,
  encodeMessage,
  LineReader,
  parseAnswer,
  parseRequest,
  readMessage,
} from '../src/relay-protocol.js';
import { sshArgs } from '../src/relay-transport.js';
import {
  authorizedKeyLine,
  brokerScript,
  brokerSweep,
  loopbackListeners,
  relaySetupScript,
  sshdMatchBlock,
  webClientProblem,
} from '../src/relay-windows.js';
import { judgeRelayProbe } from '../src/relay-windows-check.js';
import type { ProbeResult, RunFile } from '../src/windows-sandbox.js';

/** A dotted IPv4 address from its parts: the repository refuses dotted literals. */
const ip = (...p: number[]): string => p.join('.');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-unit-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function* chunks(lines: Iterable<string>): AsyncGenerator<string> {
  for (const l of lines) yield l;
}
const roundTrip = async (header: object, payload?: Uint8Array, max = 10_000_000) =>
  readMessage(new LineReader(chunks([...encodeMessage(header, payload)].join('')), 1 << 20), max);

describe('the relay wire', () => {
  it('carries a header and a payload in chunks, checked by size and checksum', async () => {
    const payload = Buffer.alloc(CHUNK_BYTES * 2 + 17, 7);
    const got = await roundTrip({ studioRelay: 1, op: 'status', id: 'APP-1' }, payload);
    expect(got?.header).toMatchObject({ studioRelay: 1, op: 'status', id: 'APP-1', payload: true });
    expect(got?.payload?.equals(payload)).toBe(true);
    // Snake case on the wire.
    expect([...encodeMessage({ studioRelay: 1, headSha: null })][0]).toBe(
      '{"studio_relay":1,"head_sha":null}\n',
    );
  });

  it('refuses a payload over the cap, a broken checksum and an overlong line', async () => {
    await expect(roundTrip({ studioRelay: 1 }, Buffer.alloc(100), 10)).rejects.toThrow(/larger/);
    const lines = [...encodeMessage({ studioRelay: 1 }, Buffer.from('abc'))];
    lines[lines.length - 1] = '{"end":3,"sha256":"00"}\n';
    await expect(readMessage(new LineReader(chunks(lines), 1 << 20), 100)).rejects.toThrow(
      /checksum/,
    );
    await expect(readMessage(new LineReader(chunks(['x'.repeat(200)]), 100), 100)).rejects.toThrow(
      /too long/,
    );
  });

  it('parses requests strictly: another version or an unknown field refuses', () => {
    expect(parseRequest({ studioRelay: 1, op: 'hello' })).toEqual({ studioRelay: 1, op: 'hello' });
    expect(() => parseRequest({ studioRelay: 2, op: 'hello' })).toThrow(/protocol 2/);
    expect(() => parseRequest({ studioRelay: 1, op: 'exec', cmd: 'rm' })).toThrow(/unknown shape/);
    expect(() => parseRequest({ studioRelay: 1, op: 'status', id: '../x' })).toThrow();
    expect(() => parseRequest({ studioRelay: 1, op: 'hello', extra: 1 })).toThrow();
  });

  it('cleans lines from the worker and checks each answer against its op', () => {
    const a = parseAnswer('status', {
      studioRelay: 1,
      ok: true,
      state: 'held',
      line: 'busy\u001b[31m\u202e now',
    });
    expect(a).toMatchObject({ state: 'held', line: 'busy [31m  now' });
    expect(() => parseAnswer('status', { studioRelay: 1, ok: true, state: 'owned' })).toThrow();
    expect(parseAnswer('stop', { studioRelay: 1, ok: false, kind: 'held', line: 'x' })).toEqual({
      studioRelay: 1,
      ok: false,
      kind: 'held',
      line: 'x',
    });
  });
});

describe('the ssh call', () => {
  const target = relayTargetSchema.parse({
    host: 'worker.example',
    hostKey: `ssh-ed25519 ${'A'.repeat(68)}`,
    identityFile: '/keys/lab',
  });
  it('is closed: pinned key under an alias, no agent, no forwarding, no config, no password', () => {
    const args = sshArgs('lab', target, '/state/lab.known_hosts');
    const opts = args.flatMap((a, i) => (args[i - 1] === '-o' ? [a] : []));
    expect(args.slice(0, 2)).toEqual(['-F', 'none']);
    for (const o of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'UserKnownHostsFile=/state/lab.known_hosts',
      'GlobalKnownHostsFile=none',
      'HostKeyAlias=studio-relay-lab',
      'IdentitiesOnly=yes',
      'IdentityFile=/keys/lab',
      'IdentityAgent=none',
      'ForwardAgent=no',
      'ForwardX11=no',
      'ClearAllForwardings=yes',
      'ControlMaster=no',
      'ControlPath=none',
      'PermitLocalCommand=no',
      'ProxyCommand=none',
      'PasswordAuthentication=no',
    ]) {
      expect(opts).toContain(o);
    }
    // The host comes after `--`, so it can never be read as an option.
    expect(args.slice(-7)).toEqual([
      '-p',
      '22',
      '-l',
      'studio-relay',
      '--',
      'worker.example',
      'studio-relay',
    ]);
  });
});

describe('the lead checks a result bundle before it pushes', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

  function setup(name: string) {
    const base = join(root, name);
    mkdirSync(base);
    const origin = join(base, 'origin.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    const project = join(base, 'lead');
    git(base, 'clone', '-q', origin, project);
    git(project, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(project, 'a.txt'), 'a\n');
    git(project, 'add', 'a.txt');
    git(project, 'commit', '-q', '-m', 'a');
    git(project, 'push', '-q', 'origin', 'main');
    const sha = git(project, 'rev-parse', 'HEAD');
    // The crew's side: a clone with commits on studio/APP-1.
    const crew = join(base, 'crew');
    git(base, 'clone', '-q', origin, crew);
    git(crew, 'checkout', '-q', '-b', 'studio/APP-1');
    writeFileSync(join(crew, 'b.txt'), 'b\n');
    git(crew, 'add', 'b.txt');
    git(crew, 'commit', '-q', '-m', 'b');
    const head = git(crew, 'rev-parse', 'HEAD');
    const state = join(base, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'marker.json'), '{}');
    const bundle = (...refs: string[]) => {
      const f = join(base, `${refs.join('-').replace(/\W/g, '_')}.bundle`);
      git(crew, 'bundle', 'create', '-q', f, ...refs);
      return readFileSync(f);
    };
    const record: RelayRecord = {
      label: 'lab',
      sha,
      from: 'main',
      credential: 'default',
      startedAt: '2026-11-06T10:00:00Z',
      state: 'ended',
      seenAt: '2026-11-06T10:00:00Z',
    };
    const item = { id: 'APP-1', repo: 'org/app' } as WorkItem;
    const accept = (b: Buffer, h = head, rec = record) =>
      acceptResult({
        stateRoot: state,
        project,
        item,
        record: rec,
        ports: realPorts(),
        crewToken: 'unused-token-0001',
        head: h,
        bundle: b,
        url: origin,
      });
    return { origin, crew, head, sha, bundle, accept, git, record };
  }

  it('pushes exactly studio/<id> at the reported head, on top of the pinned commit', async () => {
    const s = setup('ok');
    expect(await s.accept(s.bundle('studio/APP-1', `^${s.sha}`))).toBeUndefined();
    expect(s.git(s.origin, 'rev-parse', 'refs/heads/studio/APP-1')).toBe(s.head);
  });

  it('refuses other refs, another head, a branch not on the pinned commit, and no bundle', async () => {
    const s = setup('bad');
    s.git(s.crew, 'branch', 'extra');
    expect(await s.accept(s.bundle('studio/APP-1', 'extra', `^${s.sha}`))).toMatch(
      /more or other refs/,
    );
    expect(await s.accept(s.bundle('main'))).toMatch(/another ref/);
    expect(await s.accept(s.bundle('studio/APP-1', `^${s.sha}`), 'e'.repeat(40))).toMatch(
      /head differs/,
    );
    expect(await s.accept(Buffer.from('not a bundle'))).toMatch(/not a git bundle/);
    // A head that does not descend from the pinned commit: an orphan branch.
    s.git(s.crew, 'checkout', '-q', '--orphan', 'other');
    s.git(s.crew, 'commit', '-q', '-m', 'orphan');
    s.git(s.crew, 'branch', '-f', 'studio/APP-1', 'other');
    const orphan = s.git(s.crew, 'rev-parse', 'HEAD');
    expect(await s.accept(s.bundle('studio/APP-1'), orphan)).toMatch(/does not descend/);
    expect(() => s.git(s.origin, 'rev-parse', '--verify', 'refs/heads/studio/APP-1')).toThrow();
  });

  it('never forces a push over a branch that moved meanwhile', async () => {
    const s = setup('moved');
    expect(await s.accept(s.bundle('studio/APP-1', `^${s.sha}`))).toBeUndefined();
    s.git(s.crew, 'checkout', '-q', '-b', 'side', s.sha);
    writeFileSync(join(s.crew, 'c.txt'), 'c\n');
    s.git(s.crew, 'add', 'c.txt');
    s.git(s.crew, 'commit', '-q', '-m', 'c');
    s.git(s.crew, 'branch', '-f', 'studio/APP-1', 'side');
    const other = s.git(s.crew, 'rev-parse', 'HEAD');
    expect(await s.accept(s.bundle('studio/APP-1', `^${s.sha}`), other)).toMatch(/never forced/);
    expect(s.git(s.origin, 'rev-parse', 'refs/heads/studio/APP-1')).toBe(s.head);
  });
});

describe('SMB candidates and verdicts', () => {
  const ifaces = {
    eth0: [
      {
        address: ip(192, 168, 10, 20),
        netmask: ip(255, 255, 255, 0),
        family: 'IPv4' as const,
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: `${ip(192, 168, 10, 20)}/24`,
      },
    ],
  };
  it('local subnets are the private ones, capped at /22; a range wider than /22 is refused', () => {
    expect(localSubnets(ifaces).map((r) => r.name)).toEqual([`${ip(192, 168, 10, 0)}/24`]);
    expect(rangeOf(`${ip(192, 0, 2, 0)}/24`)?.name).toBe(`${ip(192, 0, 2, 0)}/24`);
    expect(rangeOf(`${ip(10, 0, 0, 0)}/8`)).toBeUndefined();
  });

  it('takes explicit hosts, neighbors inside the ranges and tailnet peers; never itself', () => {
    const c = smbCandidates({
      entries: ['nas.example', `${ip(192, 0, 2, 0)}/24`, 'tailnet-peers'],
      neighbors: [
        { address: ip(192, 0, 2, 5), state: 'Reachable' },
        { address: ip(192, 0, 2, 6), state: 'Unreachable' },
        { address: ip(198, 51, 100, 7), state: 'Stale' },
      ],
      subnets: [],
      tailscale: JSON.stringify({ Peer: { a: { TailscaleIPs: [ip(100, 64, 0, 9), 'fd7a::9'] } } }),
      own: new Set([ip(192, 0, 2, 1)]),
    });
    expect(c.problem).toBeUndefined();
    expect(c.hosts).toEqual(['nas.example', ip(100, 64, 0, 9), 'fd7a::9', ip(192, 0, 2, 5)]);
  });

  it('never passes on an empty set: a range without neighbors refuses', () => {
    const c = smbCandidates({
      entries: ['local-subnets'],
      neighbors: [],
      subnets: localSubnets(ifaces),
      tailscale: undefined,
      own: new Set(),
    });
    expect(c.problem).toMatch(/no host in 192\.168\.10\.0\/24/);
    expect(
      smbCandidates({
        entries: [`${ip(192, 0, 2, 0)}/24`],
        neighbors: undefined,
        subnets: [],
        tailscale: undefined,
        own: new Set(),
      }).problem,
    ).toMatch(/cannot be read/);
    expect(tailnetPeers(undefined)).toBeUndefined();
  });

  it('judges each host by its code: denied and closed pass, a session fails, the rest holds', () => {
    for (const c of [5, 86, 1326, 1327, 1331, 1909]) expect(smbVerdict(c)).toBe('denied');
    for (const c of [53, 64, 67, 1231]) expect(smbVerdict(c)).toBe('closed');
    expect(smbVerdict(0)).toBe('open');
    expect(smbVerdict(1219)).toBe('other');
    expect(smbProblem([ip(192, 0, 2, 5)], { [ip(192, 0, 2, 5)]: 5 })).toBeUndefined();
    expect(smbProblem([ip(192, 0, 2, 5)], { [ip(192, 0, 2, 5)]: 0 })).toMatchObject({
      kind: 'refused',
      line: expect.stringContaining(ip(192, 0, 2, 5)),
    });
    expect(smbProblem([ip(192, 0, 2, 5)], { [ip(192, 0, 2, 5)]: 1219 })).toMatchObject({
      kind: 'held',
      line: expect.stringContaining('error 1219'),
    });
    expect(smbProblem([ip(192, 0, 2, 5)], {})).toMatchObject({ kind: 'held' });
  });
});

describe('the Windows relay worker, with fakes', () => {
  const fakeRun =
    (answers: Record<string, { code?: number; stdout?: string }>): RunFile =>
    async (file, args) => {
      const key = `${file} ${args.join(' ')}`;
      const hit = Object.entries(answers).find(([k]) => key.includes(k));
      return { code: hit?.[1].code ?? 0, stdout: hit?.[1].stdout ?? '', stderr: '' };
    };

  it('the broker answers in its file after the call, with nothing left; anything else refuses', async () => {
    let t = Date.parse('2026-11-06T10:00:00Z');
    const now = () => new Date(t);
    const sleep = async (ms: number) => {
      t += ms;
    };
    const fresh = JSON.stringify({ at: new Date(t + 500).toISOString(), found: 1, left: [] });
    await expect(
      brokerSweep({ run: fakeRun({}), task: 'T', result: 'r', readFile: () => fresh, now, sleep }),
    ).resolves.toBeUndefined();
    const stale = JSON.stringify({ at: '2026-11-06T09:00:00Z', found: 0, left: [] });
    await expect(
      brokerSweep({ run: fakeRun({}), task: 'T', result: 'r', readFile: () => stale, now, sleep }),
    ).rejects.toThrow(/did not answer/);
    const left = JSON.stringify({ at: new Date(t + 10).toISOString(), found: 2, left: [77] });
    await expect(
      brokerSweep({ run: fakeRun({}), task: 'T', result: 'r', readFile: () => left, now, sleep }),
    ).rejects.toThrow(/still running \(77\)/);
    await expect(
      brokerSweep({
        run: fakeRun({ schtasks: { code: 5 } }),
        task: 'T',
        result: 'r',
        readFile: () => fresh,
        now,
        sleep,
      }),
    ).rejects.toThrow(/cannot start the broker task/);
  });

  it('WebClient must be stopped and disabled; a machine without it is fine', async () => {
    const svc = (o: object) => fakeRun({ powershell: { stdout: JSON.stringify(o) } });
    expect(await webClientProblem(svc({ exists: false }))).toBeUndefined();
    expect(
      await webClientProblem(svc({ exists: true, status: 'Stopped', start: 'Disabled' })),
    ).toBeUndefined();
    expect(
      await webClientProblem(svc({ exists: true, status: 'Stopped', start: 'Manual' })),
    ).toMatch(/WebClient service is Stopped with start type Manual/);
    expect(await webClientProblem(fakeRun({ powershell: { code: 1 } }))).toMatch(/cannot be read/);
  });

  it('lists the listeners on loopback, wildcards included, and nothing else', async () => {
    const list = await loopbackListeners(
      fakeRun({
        powershell: {
          stdout: JSON.stringify([
            { p: 'tcp', a: ip(127, 0, 0, 1), n: 5432, o: 10 },
            { p: 'tcp', a: ip(0, 0, 0, 0), n: 445, o: 4 },
            { p: 'udp', a: '::1', n: 53, o: 9 },
            { p: 'tcp', a: ip(192, 0, 2, 4), n: 80, o: 11 },
          ]),
        },
      }),
    );
    expect(list?.map((l) => `${l.protocol} ${l.address}:${l.port}`)).toEqual([
      `tcp ${ip(127, 0, 0, 1)}:5432`,
      `tcp ${ip(0, 0, 0, 0)}:445`,
      'udp ::1:53',
    ]);
  });

  it('judges the probe: base checks refuse, a reachable denied port holds, SMB by its codes', () => {
    const ok = (check: string): ProbeResult => ({ check, ok: true, detail: '' });
    const base = [
      'user',
      'admin',
      'env',
      'read',
      'write',
      'direct',
      'proxy',
      'tasks',
      'former',
      'unreachable',
      'credentials',
    ].map(ok);
    expect(judgeRelayProbe(base, [])).toBeUndefined();
    expect(
      judgeRelayProbe([...base.slice(1), { check: 'user', ok: false, detail: 'runs as x' }], []),
    ).toMatchObject({ kind: 'refused' });
    expect(
      judgeRelayProbe(
        [...base, { check: 'loopback', ok: false, detail: `${ip(127, 0, 0, 1)}:5432` }],
        [],
      ),
    ).toMatchObject({ kind: 'held', line: expect.stringContaining(`${ip(127, 0, 0, 1)}:5432`) });
    expect(
      judgeRelayProbe(
        [...base, { check: 'smb', ok: false, detail: '', codes: { 'nas.example': 0 } }],
        ['nas.example'],
      ),
    ).toMatchObject({ kind: 'refused' });
  });

  it('setup: a standard relay account, the broker as SYSTEM for the relay account only, sshd closed', () => {
    const key = `ssh-ed25519 ${'B'.repeat(68)} lead`;
    const command =
      '"C:\\node\\node.exe" "C:\\studio\\bin\\studio" relay serve --home "C:\\ProgramData\\Studio\\relay"';
    const script = relaySetupScript({
      relayUser: 'studio-relay',
      crewUser: 'studio-crew',
      home: 'C:\\ProgramData\\Studio\\relay',
      task: 'Studio relay broker',
      readPaths: ['C:\\node'],
      command,
      leadKey: key,
      pluginSetup: '# plugins',
    });
    expect(script).toMatch(/#Requires -RunAsAdministrator/);
    expect(script).toContain('is an administrator: remove it from that group first');
    expect(script).toContain('DataProtectionScope]::LocalMachine');
    expect(script).not.toContain('Import-Clixml');
    expect(script).toContain('$sddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$relaySid)"');
    expect(script).toContain("RegisterTaskDefinition($task, $def, 6, 'SYSTEM', $null, 5, $sddl)");
    expect(script).toContain('Set-Service -Name WebClient -StartupType Disabled');
    expect(script).toContain(authorizedKeyLine({ key, command }).replace(/'/g, "''"));
    const block = sshdMatchBlock({
      relayUser: 'studio-relay',
      home: 'C:\\ProgramData\\Studio\\relay',
      command,
    });
    for (const line of [
      'Match User studio-relay',
      `    ForceCommand ${command}`,
      '    PermitTTY no',
      '    AllowTcpForwarding no',
      '    X11Forwarding no',
      '    PermitTunnel no',
      '    AllowAgentForwarding no',
      '    PasswordAuthentication no',
    ]) {
      expect(block).toContain(line);
    }
    expect(authorizedKeyLine({ key, command })).toMatch(/^restrict,command="/);
    expect(() => authorizedKeyLine({ key: 'ssh-ed25519 x\nssh-rsa y', command })).toThrow();
    // The broker takes no argument: the crew user is written into it.
    expect(brokerScript({ crewUser: 'studio-crew', result: 'C:\\r.json' })).toContain(
      "'studio-crew'",
    );
  });
});
