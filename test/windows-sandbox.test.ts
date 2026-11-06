import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ipv4, LOOPBACK } from '../src/egress-proxy.js';
import { HeldError } from '../src/held.js';
import {
  CREW_HOST_BIN,
  findClaude,
  grantArgs,
  type HostSpec,
  identityScript,
  KEEPER_FILE,
  KEEPER_SCRIPT,
  OUTSIDE,
  ownerRightsArgs,
  PROBE_CHECKS,
  type ProbeResult,
  powershellEnv,
  probeProblem,
  probeWindowsSandbox,
  psQuote,
  type RunFile,
  revokeArgs,
  runConfigDir,
  type SpawnKeeper,
  setupReadPaths,
  WindowsGrants,
  windowsClaude,
  windowsCrewEnv,
  windowsSetupScript,
} from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-win-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

describe('the setup script', () => {
  const script = windowsSetupScript({
    user: 'studio-crew',
    credFile: "C:\\Users\\o'wner\\.config\\studio\\windows-crew.xml",
    readPaths: ['C:\\Program Files\\nodejs'],
  });

  it('makes a standard user, never an administrator, and keeps its credential for the owner', () => {
    expect(script).toMatch(/^#Requires -RunAsAdministrator/);
    expect(script).toContain("$name = 'studio-crew'");
    expect(script).toContain("Get-LocalGroup -SID 'S-1-5-32-545'");
    expect(script).toMatch(/S-1-5-32-544[\s\S]*throw "\$name is an administrator/);
    expect(script).toContain('Export-Clixml');
    expect(script).toContain("'C:\\Users\\o''wner\\.config\\studio\\windows-crew.xml'");
    expect(script).not.toMatch(/Write-Output .*\$plain/);
  });

  it('blocks every outbound connection of that user except loopback', () => {
    expect(script).toMatch(/New-NetFirewallRule .*-Direction Outbound -Action Block/);
    expect(script).toContain('-LocalUser "D:(A;;CC;;;$sid)"');
    expect(script).toContain(`'${OUTSIDE[0]}', '${OUTSIDE[1]}'`);
    expect(OUTSIDE[0]).toBe(`${ipv4(0, 0, 0, 0)}-${ipv4(126, 255, 255, 255)}`);
    expect(script).toContain("'::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'");
    expect(script).not.toContain(`${ipv4(127, 0, 0, 0)}-`);
  });

  it('opens the given paths for reading only, and refuses a bad user name', () => {
    expect(script).toContain("@('C:\\Program Files\\nodejs')");
    expect(script).toContain('(OI)(CI)RX');
    expect(script).not.toMatch(/\(OI\)\(CI\)M/);
    expect(() => windowsSetupScript({ user: 'x; rm', credFile: 'c', readPaths: [] })).toThrow(
      /not a crew user name/,
    );
  });

  it('opens of the crew Claude config dir only the skills and the plugins', () => {
    const paths = setupReadPaths({
      node: join('n', 'node.exe'),
      claude: undefined,
      toolchains: [],
      crewConfigDir: join('c', 'claude'),
    });
    expect(paths).toContain(join('c', 'claude', 'skills'));
    expect(paths).toContain(join('c', 'claude', 'plugins'));
    expect(paths).not.toContain(join('c', 'claude'));
  });
});

describe('quoting and the keeper', () => {
  it('quotes for PowerShell and refuses control characters', () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(() => psQuote('a\nb')).toThrow();
  });

  it('the keeper jails the host in a kill-on-close job before it hands over the spec by pipe', () => {
    const at = (s: string) => KEEPER_SCRIPT.indexOf(s);
    expect(KEEPER_SCRIPT).toContain('0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(at('[StudioJob]::Assign($job, $p.Handle)')).toBeGreaterThan(at('Start-Process'));
    expect(at('[StudioJob]::ClientPid(')).toBeGreaterThan(at('[StudioJob]::Assign('));
    expect(at('$pipe.Write($spec')).toBeGreaterThan(at('[StudioJob]::ClientPid('));
    expect(KEEPER_SCRIPT).toContain("PipeAccessRule($crew, 'ReadWrite', 'Allow')");
    // The grants come off however the host ends.
    expect(at('icacls $r /remove:g $User')).toBeGreaterThan(at('} finally {'));
    // Nothing of the spec is written to a file.
    expect(KEEPER_SCRIPT).not.toMatch(/Set-Content|Out-File|WriteAllText/);
  });

  it('identity: only a keeper of this owner, by its creation time', () => {
    const s = identityScript(4321);
    expect(s).toContain("-Filter 'ProcessId=4321'");
    expect(s).toContain('GetOwnerSid');
    expect(s).toContain(`-notlike '*${KEEPER_FILE}*'`);
    expect(s).toContain('CreationDate');
  });

  it('PowerShell gets what Windows needs, never a token', () => {
    expect(
      powershellEnv({
        Path: 'p',
        SystemRoot: 'C:\\Windows',
        CLAUDE_CODE_OAUTH_TOKEN: 'secret',
        PSModulePath: 'x',
        HTTPS_PROXY: 'y',
      }),
    ).toEqual({ Path: 'p', SystemRoot: 'C:\\Windows' });
  });
});

describe('grants', () => {
  it('modify inherits on a directory, read on a file; OWNER RIGHTS keeps owners from re-opening', () => {
    const file = join(root, 'f');
    writeFileSync(file, '');
    expect(grantArgs('crew', { path: root, rights: 'M' })).toEqual([
      root,
      '/grant',
      'crew:(OI)(CI)M',
      '/Q',
    ]);
    expect(grantArgs('crew', { path: file, rights: 'R' })).toEqual([
      file,
      '/grant',
      'crew:RX',
      '/Q',
    ]);
    expect(ownerRightsArgs(root)).toEqual([root, '/grant', '*S-1-3-4:(OI)(CI)(S)', '/Q']);
    expect(revokeArgs('crew', file)).toEqual([file, '/remove:g', 'crew', '/Q']);
    expect(() => grantArgs('a b', { path: file, rights: 'R' })).toThrow();
  });

  const fakeIcacls = () => {
    const calls: string[][] = [];
    const run: RunFile = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    return { run, calls };
  };

  it('takes the last run off before the next grant, records first, and refuses while a crew runs', async () => {
    const stateRoot = join(root, `g${n++}`);
    const dir = join(stateRoot, 'clone');
    mkdirSync(dir, { recursive: true });
    const f = fakeIcacls();
    const g = new WindowsGrants({ stateRoot, user: 'crew', run: f.run });
    await g.grant([{ path: dir, rights: 'M' }]);
    expect(f.calls).toEqual([
      ['icacls', dir, '/grant', 'crew:(OI)(CI)M', '/Q'],
      ['icacls', dir, '/grant', '*S-1-3-4:(OI)(CI)(S)', '/Q'],
    ]);
    expect(g.paths()).toEqual([dir]);
    // A live keeper (this test process) holds the worker: no second crew.
    g.recordKeeper(process.pid);
    await expect(g.grant([{ path: dir, rights: 'M' }])).rejects.toThrow(HeldError);
    // Once it is gone, the next grant first takes the old ones off.
    g.recordKeeper(2 ** 22 + 12345);
    f.calls.length = 0;
    await g.grant([{ path: dir, rights: 'R' }]);
    expect(f.calls[0]).toEqual(['icacls', dir, '/remove:g', 'crew', '/Q']);
    await g.revokeAll();
    expect(g.paths()).toEqual([]);
  });
});

describe('the crew environment and config', () => {
  it('sends everything through the proxy, keeps the profile out, and Claude traffic minimal', () => {
    const env = windowsCrewEnv({
      proxyPort: 4567,
      homeDir: 'C:\\s\\homes\\A-1',
      tmpDir: 'C:\\s\\tmp\\A-1',
      base: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\owner', GH_TOKEN: 'x' },
    });
    expect(env).toMatchObject({
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\s\\homes\\A-1',
      TEMP: 'C:\\s\\tmp\\A-1',
      HTTPS_PROXY: `http://${LOOPBACK}:4567`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('a run gets its own config dir: skills and plugin lists copied, no link, no login', () => {
    const shared = join(root, `shared${n++}`);
    mkdirSync(join(shared, 'skills', 'a'), { recursive: true });
    writeFileSync(join(shared, 'skills', 'a', 'SKILL.md'), 'x');
    symlinkSync('/etc/hosts', join(shared, 'skills', 'link'));
    mkdirSync(join(shared, 'plugins', 'cache'), { recursive: true });
    writeFileSync(join(shared, 'plugins', 'installed_plugins.json'), '{}');
    writeFileSync(join(shared, '.claude.json'), '{"secret":1}');
    const home = join(root, `home${n++}`);
    mkdirSync(home);
    const dir = runConfigDir(home, shared);
    expect(dir).toBe(join(home, '.claude-run'));
    expect(readFileSync(join(dir, 'skills', 'a', 'SKILL.md'), 'utf8')).toBe('x');
    expect(existsSync(join(dir, 'skills', 'link'))).toBe(false);
    expect(existsSync(join(dir, 'plugins', 'installed_plugins.json'))).toBe(true);
    expect(existsSync(join(dir, 'plugins', 'cache'))).toBe(false);
    expect(existsSync(join(dir, '.claude.json'))).toBe(false);
  });

  it('finds claude on a Windows PATH', () => {
    const dir = join(root, 'bin');
    mkdirSync(dir);
    writeFileSync(join(dir, 'claude.cmd'), '');
    expect(findClaude(`C:\\nowhere;${dir}`)).toBe(join(dir, 'claude.cmd'));
    expect(findClaude(undefined)).toBeUndefined();
  });

  it('the host ships beside the other bins', () => {
    expect(CREW_HOST_BIN.replace(/\\/g, '/')).toMatch(/\/bin\/studio-crew-host\.mjs$/);
  });
});

/** A fake keeper start: records what it got, and answers a probe through its out file. */
function fakeSpawn(answer?: (spec: HostSpec) => ProbeResult[] | undefined) {
  const calls: { args: string[]; env: Record<string, string>; stdin: string; detached: boolean }[] =
    [];
  const spawn: SpawnKeeper = async (o) => {
    calls.push({ args: o.args, env: o.env, stdin: o.stdin, detached: o.detached });
    const spec = JSON.parse(o.stdin.slice(o.stdin.indexOf('\n') + 1)) as HostSpec;
    const out = o.args[o.args.indexOf('-Out') + 1] as string;
    const results = answer?.(spec);
    if (results !== undefined) writeFileSync(out, JSON.stringify(results));
    return { pid: 4321, exited: Promise.resolve(0) };
  };
  return { spawn, calls };
}

describe('the Claude port', () => {
  it('starts a detached keeper whose stdin carries the grants and the spec; no spec file anywhere', async () => {
    const stateRoot = join(root, `c${n++}`);
    mkdirSync(join(stateRoot, 'logs'), { recursive: true });
    const f = fakeSpawn();
    const grants = new WindowsGrants({
      stateRoot,
      user: 'crew',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const claude = windowsClaude({
      stateRoot,
      credFile: 'C:\\c.xml',
      claudeBin: 'claude.exe',
      user: 'crew',
      grants,
      spawn: f.spawn,
      node: 'node.exe',
    });
    const log = join(stateRoot, 'logs', 'APP-1.jsonl');
    const r = await claude.start('C:\\clone', ['-p'], 'hi', log, {
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      Path: 'p',
    });
    expect(r.pid).toBe(4321);
    const c = f.calls[0];
    expect(c?.detached).toBe(true);
    expect(c?.env).toEqual({ Path: 'p' });
    expect(c?.args).toContain('-Cred');
    expect(c?.args[c.args.indexOf('-Out') + 1]).toBe(join(stateRoot, 'logs', 'APP-1.host.out'));
    const [first, rest] = [
      c?.stdin.split('\n')[0],
      c?.stdin.slice((c?.stdin.indexOf('\n') ?? 0) + 1),
    ];
    expect(JSON.parse(first as string)).toEqual([]);
    expect(JSON.parse(rest as string)).toMatchObject({
      mode: 'run',
      cmd: 'claude.exe',
      prompt: 'hi',
      log,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    });
    expect(readFileSync(join(stateRoot, 'settings', KEEPER_FILE), 'utf8')).toBe(KEEPER_SCRIPT);
    expect(existsSync(join(stateRoot, 'tmp'))).toBe(false);
  });

  it('removes a link planted where the host output goes, never following it', async () => {
    const stateRoot = join(root, `c${n++}`);
    mkdirSync(join(stateRoot, 'logs'), { recursive: true });
    const target = join(root, `target${n++}`);
    writeFileSync(target, 'keep');
    symlinkSync(target, join(stateRoot, 'logs', 'APP-2.host.out'));
    const claude = windowsClaude({
      stateRoot,
      credFile: 'c',
      claudeBin: 'claude.exe',
      user: 'crew',
      grants: new WindowsGrants({
        stateRoot,
        user: 'crew',
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
      spawn: fakeSpawn().spawn,
    });
    await claude.start('C:\\clone', [], '', join(stateRoot, 'logs', 'APP-2.jsonl'), {});
    expect(existsSync(join(stateRoot, 'logs', 'APP-2.host.out'))).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });
});

describe('probeProblem', () => {
  const all = (over: Partial<Record<string, boolean>> = {}): ProbeResult[] =>
    PROBE_CHECKS.map((check) => ({ check, ok: over[check] ?? true, detail: `${check} detail` }));

  it('holds only when every check held', () => {
    expect(probeProblem(all())).toBeUndefined();
    expect(probeProblem(all({ direct: false }))).toBe(
      'the Windows crew sandbox does not hold here: direct: direct detail',
    );
    expect(probeProblem([])).toMatch(/gave no answer/);
    expect(probeProblem(undefined)).toMatch(/gave no answer/);
  });
});

describe('probeWindowsSandbox', () => {
  const setup = () => {
    const base = join(root, `p${n++}`);
    const stateRoot = join(base, 'state');
    const ownerConfigDir = join(base, 'config');
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(ownerConfigDir, { recursive: true });
    return {
      stateRoot,
      ownerConfigDir,
      credFile: join(ownerConfigDir, 'windows-crew.xml'),
      user: 'studio-crew',
      ownerHome: base,
      mustNotRead: ['D:\\data'],
      proxyPort: 1234,
      env: { PATH: 'x', SystemRoot: 'C:\\Windows' },
      timeoutMs: 2000,
      node: 'node',
    };
  };
  const ok = PROBE_CHECKS.map((check) => ({ check, ok: true, detail: '' }));

  it('passes when the host as the crew user reports every check held, and leaves nothing behind', async () => {
    const o = setup();
    const f = fakeSpawn(() => ok);
    expect(await probeWindowsSandbox({ ...o, spawn: f.spawn })).toBeUndefined();
    const c = f.calls[0];
    expect(c?.detached).toBe(false);
    // The mark travels in the spec, never in PowerShell's own environment; it runs in Windows.
    const spec = JSON.parse(c?.stdin.slice(c.stdin.indexOf('\n') + 1) as string) as HostSpec;
    expect(spec.env?.STUDIO_PROBE_MARK).toBe(spec.probe?.mark);
    expect(c?.env.STUDIO_PROBE_MARK).toBeUndefined();
    expect(c?.args[c.args.indexOf('-Cwd') + 1]).toBe('C:\\Windows');
    expect(spec.probe?.mustNotRead).toEqual([
      join(o.ownerConfigDir, 'crew-probe-canary'),
      o.ownerHome,
      'D:\\data',
    ]);
    expect(existsSync(join(o.ownerConfigDir, 'crew-probe-canary'))).toBe(false);
  });

  it('refuses a failed check, a missing check, no answer, and a host that never finishes', async () => {
    const o = setup();
    const failing = ok.map((r) =>
      r.check === 'read' ? { ...r, ok: false, detail: 'D:\\data' } : r,
    );
    expect(await probeWindowsSandbox({ ...o, spawn: fakeSpawn(() => failing).spawn })).toBe(
      'the Windows crew sandbox does not hold here: read: D:\\data',
    );
    expect(
      await probeWindowsSandbox({
        ...o,
        spawn: fakeSpawn(() => ok.filter((r) => r.check !== 'proxy')).spawn,
      }),
    ).toMatch(/did not check proxy/);
    expect(await probeWindowsSandbox({ ...o, spawn: fakeSpawn(() => undefined).spawn })).toMatch(
      /no answer/,
    );
    const hanging: SpawnKeeper = async () => ({ pid: 2 ** 22 + 99, exited: new Promise(() => {}) });
    expect(await probeWindowsSandbox({ ...o, timeoutMs: 100, spawn: hanging })).toMatch(
      /did not finish/,
    );
  });
});
