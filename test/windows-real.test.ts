// The Windows crew sandbox on a real Windows machine: only in the windows-latest CI job, which runs
// elevated and may create a local user (STUDIO_WINDOWS_SANDBOX_TEST=1). Never on a developer's
// machine by accident: it adds a user and a firewall rule.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EgressProxy, LOOPBACK, startEgressProxy } from '../src/egress-proxy.js';
import {
  credFileIn,
  grantAll,
  hostDirOf,
  probeWindowsSandbox,
  runFile,
  windowsClaude,
  windowsCrewEnv,
  windowsSetupScript,
} from '../src/windows-sandbox.js';

const on = process.platform === 'win32' && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';
const USER = 'studioci';

describe.skipIf(!on)('the Windows crew sandbox on Windows', () => {
  let base: string;
  let stateRoot: string;
  let ownerConfigDir: string;
  let proxy: EgressProxy;
  const env = () => ({
    ...windowsCrewEnv({
      proxyPort: proxy.port,
      homeDir: join(stateRoot, 'tmp'),
      tmpDir: join(stateRoot, 'tmp'),
      base: process.env,
    }),
    PATH: process.env.PATH ?? process.env.Path ?? '',
  });
  const grant = (g: Parameters<typeof grantAll>[2]) => grantAll(runFile, USER, g);

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-win-real-')));
    stateRoot = join(base, 'state');
    ownerConfigDir = join(base, 'config');
    mkdirSync(join(stateRoot, 'tmp'), { recursive: true });
    mkdirSync(ownerConfigDir, { recursive: true });
    const script = join(base, 'setup.ps1');
    writeFileSync(
      script,
      windowsSetupScript({
        user: USER,
        credFile: credFileIn(ownerConfigDir),
        readPaths: [dirname(process.execPath), resolve(import.meta.dirname, '..')],
        writePaths: [],
      }),
    );
    const r = await runFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      // Windows PowerShell must not load the modules of the PowerShell 7 that runs this job.
      {
        timeoutMs: 180_000,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (e): e is [string, string] =>
              e[1] !== undefined && e[0].toLowerCase() !== 'psmodulepath',
          ),
        ),
      },
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(credFileIn(ownerConfigDir))).toBe(true);
    proxy = await startEgressProxy({ allow: ['github.com'] });
  }, 240_000);
  afterAll(async () => {
    await proxy?.close();
  });

  it('the probe as the crew user holds', async () => {
    const problem = await probeWindowsSandbox({
      stateRoot,
      credFile: credFileIn(ownerConfigDir),
      user: USER,
      ownerHome: homedir(),
      ownerConfigDir,
      mustNotRead: [],
      proxyPort: proxy.port,
      env: env(),
      grant,
      timeoutMs: 90_000,
    });
    expect(problem).toBeUndefined();
  }, 120_000);

  it('the probe fails closed when the process does not run as the expected user', async () => {
    const problem = await probeWindowsSandbox({
      stateRoot,
      credFile: credFileIn(ownerConfigDir),
      user: 'someoneelse',
      ownerHome: homedir(),
      ownerConfigDir,
      mustNotRead: [],
      proxyPort: proxy.port,
      env: env(),
      grant,
      timeoutMs: 90_000,
    });
    expect(problem).toMatch(/does not hold here: user: runs as studioci/i);
  }, 120_000);

  it('a crew runs as the crew user, gets its prompt and the proxy, appends to its log and stops', async () => {
    const id = 'APP-1';
    const cwd = join(stateRoot, 'clones', id);
    const log = join(stateRoot, 'logs', `${id}.jsonl`);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dirname(log), { recursive: true });
    mkdirSync(hostDirOf(stateRoot, id), { recursive: true });
    writeFileSync(log, 'before\n');
    await grant([
      { path: cwd, rights: 'M' },
      { path: hostDirOf(stateRoot, id), rights: 'M' },
      { path: log, rights: 'W' },
    ]);
    const claude = windowsClaude({
      stateRoot,
      credFile: credFileIn(ownerConfigDir),
      claudeBin: process.execPath,
    });
    const crew = [
      "let p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{",
      "console.log(JSON.stringify({who:require('os').userInfo().username,prompt:p,proxy:process.env.HTTPS_PROXY}));",
      'setInterval(()=>{},1000);});',
    ].join('');
    const { pid } = await claude.start(cwd, ['-e', crew], 'hello crew', log, env());
    const identity = await claude.identity(pid);
    const dir = hostDirOf(stateRoot, id);
    const show = (f: string) =>
      existsSync(join(dir, f)) ? `${f}: ${readFileSync(join(dir, f), 'utf8')}` : `(no ${f})`;
    expect(
      identity ?? `none; ${show('host.err')}; ${show('host.out')}; ${show('host.json')}`,
    ).toMatch(/^host:[0-9a-f]+$/);
    expect(existsSync(join(hostDirOf(stateRoot, id), 'spec.json'))).toBe(false);
    let line: { who: string; prompt: string; proxy: string } | undefined;
    for (let i = 0; i < 100 && line === undefined; i++) {
      const last = readFileSync(log, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('{'));
      if (last !== undefined) line = JSON.parse(last);
      else await new Promise((r) => setTimeout(r, 300));
    }
    expect(readFileSync(log, 'utf8').startsWith('before\n')).toBe(true);
    expect(line?.who.toLowerCase()).toBe(USER);
    expect(line?.prompt).toBe('hello crew');
    expect(line?.proxy).toBe(`http://${LOOPBACK}:${proxy.port}`);
    expect(claude.alive(pid)).toBe(true);
    await claude.stop(pid);
    expect(claude.alive(pid)).toBe(false);
  }, 120_000);
});
