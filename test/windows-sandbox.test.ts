import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ipv4, LOOPBACK } from '../src/egress-proxy.js';
import {
  CREW_HOST_BIN,
  findClaude,
  type Grant,
  grantArgs,
  type HostSpec,
  OUTSIDE,
  PROBE_CHECKS,
  type ProbeResult,
  probeProblem,
  probeWindowsSandbox,
  psQuote,
  type RunFile,
  startScript,
  windowsCrewEnv,
  windowsSetupScript,
} from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-win-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the setup script', () => {
  const script = windowsSetupScript({
    user: 'studio-crew',
    credFile: "C:\\Users\\o'wner\\.config\\studio\\windows-crew.xml",
    readPaths: ['C:\\Program Files\\nodejs'],
    writePaths: ['C:\\Users\\owner\\.config\\studio\\claude'],
  });

  it('makes a standard user, never an administrator, and keeps its credential for the owner', () => {
    expect(script).toMatch(/^#Requires -RunAsAdministrator/);
    expect(script).toContain("$name = 'studio-crew'");
    expect(script).toContain("Get-LocalGroup -SID 'S-1-5-32-545'");
    expect(script).toMatch(/S-1-5-32-544[\s\S]*throw "\$name is an administrator/);
    expect(script).toContain('Export-Clixml');
    expect(script).toContain("'C:\\Users\\o''wner\\.config\\studio\\windows-crew.xml'");
    // The password is never printed.
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

  it('opens the given paths, read or modify, and refuses a bad user name', () => {
    expect(script).toContain("@('C:\\Program Files\\nodejs')");
    expect(script).toContain('(OI)(CI)RX');
    expect(script).toContain('(OI)(CI)M');
    expect(() =>
      windowsSetupScript({ user: 'x; rm', credFile: 'c', readPaths: [], writePaths: [] }),
    ).toThrow(/not a crew user name/);
  });
});

describe('quoting', () => {
  it('quotes for PowerShell and refuses control characters', () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(() => psQuote('a\nb')).toThrow();
  });

  it('starts the host with the credential, its arguments quoted, and refuses quotes in paths', () => {
    const s = startScript({
      credFile: 'C:\\c.xml',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      host: 'C:\\p\\bin\\studio-crew-host.mjs',
      spec: 'C:\\s\\spec.json',
      cwd: 'C:\\w',
      dir: 'C:\\d',
    });
    expect(s).toContain("Import-Clixml -LiteralPath 'C:\\c.xml'");
    expect(s).toContain(
      `-ArgumentList @('"C:\\p\\bin\\studio-crew-host.mjs"', '"C:\\s\\spec.json"') -Credential $c`,
    );
    expect(() =>
      startScript({ credFile: 'c', node: 'n', host: 'h', spec: 'a"b', cwd: 'w', dir: 'd' }),
    ).toThrow(/quotes/);
  });

  it('grants with inheritance on a directory, plain on a file', () => {
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
    expect(() => grantArgs('a b', { path: file, rights: 'W' })).toThrow();
  });
});

describe('the crew environment', () => {
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
  let n = 0;
  /** A fake PowerShell: "starts" the host by answering its spec with `results`. */
  function fake(results: ProbeResult[] | undefined, code = 0) {
    const calls: string[][] = [];
    const run: RunFile = async (file, args, opts) => {
      calls.push([file, ...args]);
      const script = args.at(-1) as string;
      const spec = /'"([^"]+spec\.json)"'/.exec(script)?.[1] as string;
      const s = JSON.parse(readFileSync(spec, 'utf8')) as HostSpec;
      expect(s.mode).toBe('probe');
      // The environment travels in the spec; PowerShell itself gets only what Windows needs.
      expect(s.env?.STUDIO_PROBE_MARK).toBe(s.probe?.mark);
      expect(opts?.env?.STUDIO_PROBE_MARK).toBeUndefined();
      expect(opts?.env?.PATH).toBe('x');
      if (results !== undefined) writeFileSync(join(s.dir, 'probe.json'), JSON.stringify(results));
      return {
        code,
        stdout: code === 0 ? '4321' : '',
        stderr: code === 0 ? '' : 'Access is denied.',
      };
    };
    return { run, calls };
  }
  const setup = () => {
    const base = join(root, `p${n++}`);
    const stateRoot = join(base, 'state');
    const ownerConfigDir = join(base, 'config');
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(ownerConfigDir, { recursive: true });
    const granted: Grant[] = [];
    return {
      stateRoot,
      ownerConfigDir,
      credFile: join(ownerConfigDir, 'windows-crew.xml'),
      user: 'studio-crew',
      ownerHome: base,
      mustNotRead: ['D:\\data'],
      proxyPort: 1234,
      env: { PATH: 'x' },
      grant: async (g: Grant[]) => {
        granted.push(...g);
      },
      granted,
      timeoutMs: 2000,
      node: 'node',
    };
  };
  const ok = PROBE_CHECKS.map((check) => ({ check, ok: true, detail: '' }));

  it('passes when the host as the crew user reports every check held, and leaves nothing behind', async () => {
    const o = setup();
    const f = fake(ok);
    expect(await probeWindowsSandbox({ ...o, run: f.run })).toBeUndefined();
    expect(f.calls[0]?.[0]).toBe('powershell.exe');
    expect(o.granted).toHaveLength(1);
    expect(o.granted[0]?.rights).toBe('M');
  });

  it('refuses a failed check, a missing check, no answer, and a host that did not start', async () => {
    const o = setup();
    expect(
      await probeWindowsSandbox({
        ...o,
        run: fake(ok.map((r) => (r.check === 'read' ? { ...r, ok: false, detail: 'D:\\data' } : r)))
          .run,
      }),
    ).toBe('the Windows crew sandbox does not hold here: read: D:\\data');
    expect(
      await probeWindowsSandbox({ ...o, run: fake(ok.filter((r) => r.check !== 'proxy')).run }),
    ).toMatch(/did not check proxy/);
    expect(await probeWindowsSandbox({ ...o, run: fake(undefined).run })).toMatch(/no answer/);
    await expect(probeWindowsSandbox({ ...o, run: fake(ok, 1).run })).rejects.toThrow(
      /cannot start a process as the crew user/,
    );
  });

  it('asks the host to check the owner profile, the owner config and the deny paths', async () => {
    const o = setup();
    let spec: HostSpec | undefined;
    const run: RunFile = async (_f, args) => {
      const file = /'"([^"]+spec\.json)"'/.exec(args.at(-1) as string)?.[1] as string;
      spec = JSON.parse(readFileSync(file, 'utf8')) as HostSpec;
      writeFileSync(join(spec.dir, 'probe.json'), JSON.stringify(ok));
      return { code: 0, stdout: '1', stderr: '' };
    };
    await probeWindowsSandbox({ ...o, run });
    expect(spec?.probe?.mustNotRead).toEqual([
      join(o.ownerConfigDir, 'crew-probe-canary'),
      o.ownerHome,
      'D:\\data',
    ]);
    expect(spec?.probe?.user).toBe('studio-crew');
    expect(spec?.probe?.proxy).toEqual({ port: 1234, refused: 'example.invalid' });
  });
});
