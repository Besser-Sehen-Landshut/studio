// The parts of relay workers that need no second machine: the wire, the ssh call, the lead's
// checks of a result bundle, the SMB candidates and verdicts, and the Windows pieces with fakes.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { relayTargetSchema } from '../src/config.js';
import { realPorts } from '../src/ports.js';
import { sessionLead } from '../src/relay-command.js';
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
import {
  copyCrewObjects,
  relayHandoffScript,
  STUDIO_BIN,
  systemSpawnRunner,
} from '../src/relay-serve.js';
import { sshArgs } from '../src/relay-transport.js';
import {
  authorizedKeyLine,
  brokerArguments,
  brokerScript,
  brokerSweep,
  forcedCommand,
  leadFromAuthInfo,
  loopbackListeners,
  relaySetupScript,
  sshdMatchBlock,
  webClientProblem,
} from '../src/relay-windows.js';
import { judgeRelayProbe, machineTreeProblem } from '../src/relay-windows-check.js';
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

describe('the result repository of the lead holds the pinned main, nothing else of the owner', () => {
  it('refuses a result that leans on a commit the owner has but did not send', async () => {
    const GIT_ENV = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
    const base = join(root, 'private');
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
    // A commit only the owner's checkout has, never pushed, never sent to the worker.
    git(project, 'checkout', '-q', '-b', 'private');
    writeFileSync(join(project, 'secret.txt'), 'owner only\n');
    git(project, 'add', 'secret.txt');
    git(project, 'commit', '-q', '-m', 'private');
    const priv = git(project, 'rev-parse', 'HEAD');
    // The crew's branch sits on that commit, and its bundle names it as a prerequisite.
    git(project, 'checkout', '-q', '-b', 'studio/APP-1');
    writeFileSync(join(project, 'b.txt'), 'b\n');
    git(project, 'add', 'b.txt');
    git(project, 'commit', '-q', '-m', 'b');
    const head = git(project, 'rev-parse', 'HEAD');
    const file = join(base, 'r.bundle');
    git(project, 'bundle', 'create', '-q', file, 'studio/APP-1', `^${priv}`);
    git(project, 'checkout', '-q', 'main');
    const state = join(base, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'marker.json'), '{}');
    const problem = await acceptResult({
      stateRoot: state,
      project,
      item: { id: 'APP-1', repo: 'org/app' } as WorkItem,
      record: {
        label: 'lab',
        sha,
        from: 'main',
        credential: 'default',
        startedAt: '2026-11-06T10:00:00Z',
        state: 'ended',
        seenAt: '2026-11-06T10:00:00Z',
      },
      ports: realPorts(),
      crewToken: 'unused-token-0001',
      head,
      bundle: readFileSync(file),
      url: origin,
    });
    expect(problem).toMatch(/does not apply on top of the pinned commit/);
    expect(() => git(origin, 'rev-parse', '--verify', 'refs/heads/studio/APP-1')).toThrow();
    expect(() => git(origin, 'cat-file', '-e', priv)).toThrow();
  });
});

describe("the worker reads a crew's clone as files only", () => {
  const clone = (name: string) => {
    const dir = join(root, name);
    execFileSync('git', ['init', '-q', '-b', 'studio/APP-1', dir]);
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    execFileSync('git', ['add', 'x.txt'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'x'],
      { cwd: dir },
    );
    return dir;
  };
  it('copies objects and reads the branch head, git never running in the clone', () => {
    const c = clone('crew-ok');
    const dest = join(root, 'dest-ok');
    mkdirSync(dest);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: c, encoding: 'utf8' }).trim();
    expect(copyCrewObjects(c, dest, 'APP-1', root)).toBe(head);
    // Packs come without the crew's own index files: the worker builds them from the packs.
    execFileSync('git', ['repack', '-q', '-a', '-d'], { cwd: c });
    const dest2 = join(root, 'dest-packed');
    mkdirSync(dest2);
    copyCrewObjects(c, dest2, 'APP-1', root);
    const packs = readdirSync(join(dest2, 'objects', 'pack'));
    expect(packs.some((f) => f.endsWith('.pack'))).toBe(true);
    expect(packs.filter((f) => !f.endsWith('.pack'))).toEqual([]);
  });
  it('refuses a .git that is a link or a file, alternates, and a link among the objects', () => {
    const a = clone('crew-alt');
    mkdirSync(join(a, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(a, '.git', 'objects', 'info', 'alternates'), '/elsewhere\n');
    expect(() => copyCrewObjects(a, join(root, 'd1'), 'APP-1', root)).toThrow(/alternates/);
    const b = join(root, 'crew-link');
    mkdirSync(b);
    symlinkSync(join(clone('crew-target'), '.git'), join(b, '.git'));
    expect(() => copyCrewObjects(b, join(root, 'd2'), 'APP-1', root)).toThrow(/not a plain folder/);
    const f = join(root, 'crew-file');
    mkdirSync(f);
    writeFileSync(join(f, '.git'), 'gitdir: /elsewhere\n');
    expect(() => copyCrewObjects(f, join(root, 'd3'), 'APP-1', root)).toThrow(/not a plain folder/);
    const l = clone('crew-objlink');
    const objects = join(l, '.git', 'objects');
    const sub = readdirSync(objects).find((n) => /^[0-9a-f]{2}$/.test(n)) as string;
    const first = readdirSync(join(objects, sub))[0] as string;
    rmSync(join(objects, sub, first));
    symlinkSync('/etc/hosts', join(objects, sub, first));
    expect(() => copyCrewObjects(l, join(root, 'd4'), 'APP-1', root)).toThrow(
      /a link among the objects/,
    );
  });
});

describe('what a crew leaves to start in a later job goes, as the crew user, never through a link', () => {
  it('removes files and links as links; targets outside survive; folders are left and named', async () => {
    const resetModule = new URL('../bin/studio-crew-reset.mjs', import.meta.url).href;
    const { resetStartup } = (await import(resetModule)) as {
      resetStartup: (dir: string) => { removed: string[]; left: string[] };
    };
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'deep'), { recursive: true });
    writeFileSync(join(outside, 'deep', 'precious.txt'), 'keep\n');
    writeFileSync(join(outside, 'file.txt'), 'keep\n');
    const startup = join(root, 'Startup');
    mkdirSync(startup);
    writeFileSync(join(startup, 'evil.cmd'), 'start x\n');
    writeFileSync(join(startup, 'desktop.ini'), '[x]\n');
    // A planted link to a folder outside (a junction on Windows) and one to a file outside.
    symlinkSync(join(outside, 'deep'), join(startup, 'to-folder'), 'dir');
    symlinkSync(join(outside, 'file.txt'), join(startup, 'to-file'));
    mkdirSync(join(startup, 'sub'));
    writeFileSync(join(startup, 'sub', 'inside.txt'), 'x\n');
    const r = resetStartup(startup);
    expect(r.removed.sort()).toEqual(['evil.cmd', 'to-file', 'to-folder']);
    expect(r.left).toEqual(['sub']);
    expect(readFileSync(join(outside, 'deep', 'precious.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(startup, 'sub', 'inside.txt'), 'utf8')).toBe('x\n');
    expect(readdirSync(startup).sort()).toEqual(['desktop.ini', 'sub']);
    // A Startup folder that is itself a link is not touched.
    const linked = join(root, 'StartupLink');
    symlinkSync(join(outside, 'deep'), linked, 'dir');
    expect(resetStartup(linked).removed).toEqual([]);
    expect(readFileSync(join(outside, 'deep', 'precious.txt'), 'utf8')).toBe('keep\n');
  });
});

describe("PowerShell modules of the crew user's own never stand in for core ones", () => {
  const resetModule = new URL('../bin/studio-crew-reset.mjs', import.meta.url).href;
  it('removes Documents PowerShell Modules folders, a link as a link, never following one', async () => {
    const { resetProfiles } = (await import(resetModule)) as {
      resetProfiles: (documents: string) => { removed: string[]; left: string[] };
    };
    const outside = join(root, 'modules-outside');
    mkdirSync(join(outside, 'Evil'), { recursive: true });
    writeFileSync(join(outside, 'Evil', 'Evil.psm1'), 'keep\n');
    const documents = join(root, 'Documents');
    // WindowsPowerShell\Modules is a link; PowerShell\Modules a folder with a link inside.
    mkdirSync(join(documents, 'WindowsPowerShell'), { recursive: true });
    symlinkSync(outside, join(documents, 'WindowsPowerShell', 'Modules'), 'dir');
    mkdirSync(join(documents, 'PowerShell', 'Modules', 'Microsoft.PowerShell.Security'), {
      recursive: true,
    });
    writeFileSync(
      join(documents, 'PowerShell', 'Modules', 'Microsoft.PowerShell.Security', 'x.psm1'),
      'x\n',
    );
    symlinkSync(outside, join(documents, 'PowerShell', 'Modules', 'linked'), 'dir');
    const r = resetProfiles(documents);
    expect(r.removed.sort()).toEqual(['PowerShell\\Modules', 'WindowsPowerShell\\Modules']);
    expect(r.left).toEqual([]);
    expect(readdirSync(join(documents, 'PowerShell'))).toEqual([]);
    expect(readdirSync(join(documents, 'WindowsPowerShell'))).toEqual([]);
    expect(readFileSync(join(outside, 'Evil', 'Evil.psm1'), 'utf8')).toBe('keep\n');
  });
  it('every PowerShell of the crew host and the reset runs pinned to $PSHOME modules', async () => {
    const { pinnedPowerShell } = (await import(resetModule)) as {
      pinnedPowerShell: (script: string) => {
        file: string;
        args: string[];
        env: Record<string, string>;
      };
    };
    const saved = { ...process.env };
    process.env.psmodulepath = 'C:\\evil';
    process.env.PSModulePath = 'C:\\evil';
    try {
      const ps = pinnedPowerShell('Get-Acl x');
      expect(ps.file).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
      expect(ps.env.PSModulePath).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]Modules$/);
      expect(Object.keys(ps.env).filter((k) => k.toLowerCase() === 'psmodulepath')).toEqual([
        'PSModulePath',
      ]);
      expect(ps.args.at(-1)).toMatch(/^\$env:PSModulePath = Join-Path \$PSHOME 'Modules'\n/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    // No other way to PowerShell in the files the crew user runs.
    for (const f of ['../bin/studio-crew-host.mjs', '../bin/studio-crew-reset.mjs']) {
      // The one full path of the pinned PowerShell aside.
      const text = readFileSync(new URL(f, import.meta.url), 'utf8').replace(
        "join(PS_HOME, 'powershell.exe')",
        '',
      );
      expect(text, f).not.toMatch(/['"`]powershell(\.exe)?['"`]/);
    }
  });
});

describe('the lead reads one answer, and no more than one answer may be', () => {
  it('stops at the cap of all bytes, and drops what comes after the answer', async () => {
    const big = (async function* () {
      for (let i = 0; i < 100; i++) yield `${'x'.repeat(1000)}\n`;
    })();
    const capped = new LineReader(big, 2000, 10_000);
    await expect(
      (async () => {
        for (;;) if ((await capped.next()) === undefined) return;
      })(),
    ).rejects.toThrow(/larger than allowed/);
    const r = new LineReader(chunks(['{"a":1}\n', 'more\n']), 100);
    expect(await r.next()).toBe('{"a":1}');
    r.stop();
    expect(await r.next()).toBeUndefined();
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

describe('the hand-over of a spec to a Windows runner', () => {
  it('goes over stdin to a child, then a pipe only the relay account may open, only to the runner', async () => {
    const calls: { file: string; args: string[]; stdin: string }[] = [];
    const start = systemSpawnRunner({
      home: 'C:\\ProgramData\\Studio\\relay',
      platform: 'win32',
      lead: 'lab',
      spawn: async (file, args, stdin) => {
        calls.push({ file, args, stdin });
        return { code: 0, stdout: '4711' };
      },
    });
    const spec = JSON.stringify({ nonce: 'n', job: { token: 'secret-token-value' } });
    expect(await start({ id: 'APP-1', spec, log: 'unused' })).toEqual({ pid: 4711 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // The spec is the child's stdin, never an argument.
    expect(call?.stdin).toBe(spec);
    expect(call?.args.join(' ')).not.toContain('secret-token-value');
    const script = call?.args.at(-1) ?? '';
    expect(script).toBe(
      relayHandoffScript({
        node: process.execPath,
        bin: STUDIO_BIN,
        id: 'APP-1',
        home: 'C:\\ProgramData\\Studio\\relay',
        lead: 'lab',
      }),
    );
    expect(script).toContain('relay run APP-1 --lead lab --pipe');
  });

  it('the pipe: an explicit DACL of the relay account alone, the client checked before a byte', () => {
    const script = relayHandoffScript({
      node: 'C:\\node.exe',
      bin: 'C:\\studio',
      id: 'APP-1',
      home: undefined,
      lead: 'default',
    });
    expect(script).toContain('$security.SetAccessRuleProtection($true, $false)');
    expect(script.match(/AddAccessRule/g)).toHaveLength(1);
    expect(script).toContain("PipeAccessRule($me, 'FullControl', 'Allow')");
    expect(script).not.toMatch(/Everyone|S-1-1-0|Anonymous/);
    expect(script).toContain("NamedPipeServerStream($name, 'Out', 1,");
    const check = script.indexOf('[StudioRelayPipe]::ClientPid(');
    expect(check).toBeGreaterThan(0);
    expect(script.indexOf('$pipe.Write(')).toBeGreaterThan(check);
    expect(script).toContain(
      "-ne $runner) {\n    throw 'a process other than the runner connected'",
    );
    expect(() =>
      relayHandoffScript({
        node: 'C:\\node.exe"',
        bin: 'x',
        id: 'APP-1',
        home: undefined,
        lead: 'default',
      }),
    ).toThrow();
  });

  it('relay serve listens on nothing for the spec', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'relay-serve.ts'), 'utf8');
    expect(source).not.toMatch(/createServer|\.listen\(/);
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

  it('setup: admin-only tree and copies, a home the relay account cannot rename, the broker in the task action', () => {
    const key = `ssh-ed25519 ${'B'.repeat(68)} studio-relay-lab`;
    const machine = 'C:\\Program Files\\Studio\\relay';
    const home = 'C:\\ProgramData\\Studio\\relay';
    const script = relaySetupScript({
      relayUser: 'studio-relay',
      crewUser: 'studio-crew',
      home,
      machine,
      task: 'Studio relay broker',
      readPaths: ['C:\\claude'],
      source: { node: 'C:\\nodejs\\node.exe', studio: 'C:\\plugins\\studio' },
      leadKey: key,
    });
    expect(script).toMatch(/#Requires -RunAsAdministrator/);
    expect(script).toContain('is an administrator: remove it from that group first');
    expect(script).toContain('DataProtectionScope]::LocalMachine');
    // No path of Studio's with a reparse point or a folder another account owns.
    expect(script).toContain('is a reparse point: refusing to set up Studio there');
    expect(script).toContain('not by administrators: remove it, then run this again');
    // Every folder of Studio's gets a protected DACL built from scratch: nothing added before stays.
    expect(script).toContain('$acl.SetAccessRuleProtection($true, $false)');
    expect(script).toContain('(Get-Item -LiteralPath $path -Force).SetAccessControl($acl)');
    // The home: only state takes the relay account's writes, and it can rename or remove nothing.
    expect(script).toContain(`StrictFolder $home_ @(,@($relaySid, $rx, 'None', 'None'))`);
    expect(script).toContain(
      `StrictFolder (Join-Path $home_ 'state') @(@($relaySid, 'ReadAndExecute, CreateFiles, CreateDirectories, Synchronize', 'None', 'None'), @($relaySid, 'Modify, Synchronize', $tree, 'InheritOnly'))`,
    );
    expect(script).toContain('NoLinksIn $home_');
    expect(script).not.toContain("Join-Path $home_ 'config'");
    // The worker's config and the plugins: in the admin-only tree, set up there elevated.
    expect(script).toContain(`$env:XDG_CONFIG_HOME = 'C:\\Program Files\\Studio\\relay\\config'`);
    // Every icacls works on a link itself, never on what it points to.
    for (const line of script.split('\n').filter((l) => /^\s*icacls /.test(l))) {
      expect(line, line).toContain('/L');
    }
    // Node.js and Studio run from admin-only copies; no junction of the source comes along.
    expect(script).toContain(
      `'C:\\nodejs\\node.exe' -Destination 'C:\\Program Files\\Studio\\relay\\node\\node.exe'`,
    );
    expect(script).toMatch(/robocopy\.exe .* \/MIR \/XJ /);
    // The broker has no script file: its action carries it, encoded.
    expect(script).not.toContain('sweep.ps1');
    expect(script).toContain('-EncodedCommand ');
    expect(script).toContain('$sddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$relaySid)"');
    expect(script).toContain('Set-Service -Name WebClient -StartupType Disabled');
    // The key file: final ACL on a temporary file in the admin-only folder, then one replace.
    const keyLine = authorizedKeyLine({ key, command: forcedCommand(machine, home), lead: 'lab' });
    expect(keyLine).toContain(
      'relay serve --home \\"C:\\\\ProgramData\\\\Studio\\\\relay\\" --lead lab',
    );
    expect(keyLine.endsWith(' studio-relay-lab')).toBe(true);
    expect(script).toContain(keyLine.replace(/'/g, "''"));
    expect(script).toContain('[IO.File]::Replace($tmp, $target, $null)');
    const block = sshdMatchBlock({
      relayUser: 'studio-relay',
      machine,
      command: forcedCommand(machine, home),
    });
    for (const line of [
      'Match User studio-relay',
      '    AuthorizedKeysFile "C:/Program Files/Studio/relay/authorized_keys"',
      `    ForceCommand "${machine}\\node\\node.exe" "${machine}\\studio\\bin\\studio" relay serve --home "${home}"`,
      '    ExposeAuthInfo yes',
      '    PermitTTY no',
      '    AllowTcpForwarding no',
      '    PasswordAuthentication no',
    ]) {
      expect(block).toContain(line);
    }
    expect(() =>
      authorizedKeyLine({ key: 'ssh-ed25519 x\nssh-rsa y', command: 'x', lead: 'lab' }),
    ).toThrow();
    // The broker ends the crew user's processes and touches nothing of its files or registry:
    // SYSTEM never walks a tree a crew could have planted links in.
    const broker = brokerScript({ crewUser: 'studio-crew', result: 'C:\\r.json' });
    expect(broker).toContain("'studio-crew'");
    for (const s of ['Remove-Item', 'Remove-ItemProperty', 'reg.exe', 'Startup', 'HKEY_USERS']) {
      expect(broker, s).not.toContain(s);
    }
    const encoded =
      brokerArguments({ crewUser: 'studio-crew', result: 'C:\\r.json' }).split(' ').at(-1) ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(broker);
  });

  it('which lead a session is for: the key decides on Windows, a --lead must agree', () => {
    const key = `ssh-ed25519 ${'D'.repeat(68)}`;
    const keys = `restrict,command="x --lead lab" ${key} studio-relay-lab\r\n`;
    const dir = join(root, `auth-${Date.now()}`);
    mkdirSync(dir);
    const auth = join(dir, 'auth');
    writeFileSync(auth, `publickey ${key}\n`);
    const keysFile = join(dir, 'keys');
    writeFileSync(keysFile, keys);
    expect(leadFromAuthInfo(`publickey ${key}\n`, keys)).toBe('lab');
    expect(leadFromAuthInfo(`publickey ssh-ed25519 ${'E'.repeat(68)}\n`, keys)).toBeUndefined();
    const env = { SSH_USER_AUTH: auth };
    expect(sessionLead({ platform: 'win32', flag: undefined, env, keysFile })).toEqual({
      lead: 'lab',
    });
    expect(sessionLead({ platform: 'win32', flag: 'other', env, keysFile })).toEqual({
      problem: 'this key belongs to another lead',
    });
    expect(sessionLead({ platform: 'win32', flag: 'lab', env: {}, keysFile })).toMatchObject({
      problem: expect.stringContaining('cannot tell which lead'),
    });
    expect(
      sessionLead({ platform: 'linux', flag: undefined, env: {}, keysFile: undefined }),
    ).toEqual({
      lead: 'default',
    });
  });

  it('serves nothing from copies outside the admin-only tree', async () => {
    expect(
      await machineTreeProblem(async () => ({ code: 0, stdout: '[]', stderr: '' }), {
        machine: 'C:\\Program Files\\Studio\\relay',
        home: 'C:\\ProgramData\\Studio\\relay',
        node: 'C:\\Users\\x\\node.exe',
        studioBin: 'C:\\Program Files\\Studio\\relay\\studio\\bin\\studio',
      }),
    ).toMatch(/runs only from the admin-only copies/);
    const tree = {
      machine: 'C:\\Program Files\\Studio\\relay',
      home: 'C:\\ProgramData\\Studio\\relay',
      node: 'C:\\Program Files\\Studio\\relay\\node\\node.exe',
      studioBin: 'C:\\Program Files\\Studio\\relay\\studio\\bin\\studio',
    };
    expect(
      await machineTreeProblem(async () => ({ code: 0, stdout: '[]', stderr: '' }), tree),
    ).toBeUndefined();
    expect(
      await machineTreeProblem(
        async () => ({ code: 0, stdout: '["x is writable by S-1-5-21-1"]', stderr: '' }),
        tree,
      ),
    ).toMatch(/cannot be trusted \(x is writable by S-1-5-21-1\)/);
    expect(
      await machineTreeProblem(async () => ({ code: 1, stdout: '', stderr: '' }), tree),
    ).toMatch(/cannot be checked/);
  });
});
