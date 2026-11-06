// The Windows crew sandbox on a real Windows machine: only in the windows-latest CI job, which runs
// elevated and may create a local user (STUDIO_WINDOWS_SANDBOX_TEST=1). Never on a developer's
// machine by accident: it adds a user and a firewall rule.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EgressProxy, LOOPBACK, startEgressProxy } from '../src/egress-proxy.js';
import {
  credFileIn,
  probeWindowsSandbox,
  runFile,
  WindowsGrants,
  windowsClaude,
  windowsCrewEnv,
  windowsSetupScript,
} from '../src/windows-sandbox.js';

const on = process.platform === 'win32' && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';
const USER = 'studioci';
const TOKEN = 'token-that-must-never-be-on-disk-0123456789';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Every file below `dir` whose content holds `text`. */
function filesHolding(dir: string, text: string): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) hits.push(...filesHolding(p, text));
      else if (readFileSync(p, 'utf8').includes(text)) hits.push(p);
    } catch {
      // unreadable for the owner: not Studio's file
    }
  }
  return hits;
}

describe.skipIf(!on)('the Windows crew sandbox on Windows', () => {
  let base: string;
  let stateRoot: string;
  let ownerConfigDir: string;
  let proxy: EgressProxy;
  let grants: WindowsGrants;
  let crewConfigDir: string;

  /** Runs the setup script, elevated as this job is. */
  async function setup() {
    const script = join(base, 'setup.ps1');
    writeFileSync(
      script,
      windowsSetupScript({
        user: USER,
        credFile: credFileIn(ownerConfigDir),
        readPaths: [
          dirname(process.execPath),
          resolve(import.meta.dirname, '..'),
          join(crewConfigDir, 'plugins'),
        ],
        revokePaths: [crewConfigDir],
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
  }
  const env = () => ({
    ...windowsCrewEnv({
      proxyPort: proxy.port,
      homeDir: join(stateRoot, 'tmp'),
      tmpDir: join(stateRoot, 'tmp'),
      base: process.env,
    }),
    PATH: process.env.PATH ?? process.env.Path ?? '',
  });

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-win-real-')));
    stateRoot = join(base, 'state');
    ownerConfigDir = join(base, 'config');
    mkdirSync(join(stateRoot, 'tmp'), { recursive: true });
    mkdirSync(join(stateRoot, 'logs'), { recursive: true });
    mkdirSync(ownerConfigDir, { recursive: true });
    crewConfigDir = join(base, 'crew-claude');
    mkdirSync(join(crewConfigDir, 'plugins'), { recursive: true });
    await setup();
    expect(existsSync(credFileIn(ownerConfigDir))).toBe(true);
    proxy = await startEgressProxy({ allow: ['github.com'] });
    grants = new WindowsGrants({ ownerRoot: join(base, 'owner'), user: USER, run: runFile });
  }, 240_000);
  afterAll(async () => {
    await proxy?.close();
  });

  const probe = (user: string) =>
    probeWindowsSandbox({
      stateRoot,
      credFile: credFileIn(ownerConfigDir),
      user,
      ownerHome: homedir(),
      ownerConfigDir,
      mustNotRead: [],
      crewConfigDir,
      grants,
      proxyPort: proxy.port,
      env: env(),
      timeoutMs: 120_000,
      // Nothing a crew could leave behind to run in a later job (a fresh crew user has none).
      extra: { persistence: true },
    });

  it('a write grant an earlier setup left on the crew Claude config dir refuses, and the setup takes it off', async () => {
    const r = await runFile('icacls', [crewConfigDir, '/grant', `${USER}:(OI)(CI)M`, '/Q']);
    expect(r.code).toBe(0);
    expect(await probe(USER)).toMatch(/does not hold here: write: writable: .*crew-claude/);
    await setup();
    expect(await probe(USER)).toBeUndefined();
  }, 400_000);

  it('the probe as the crew user holds', async () => {
    expect(await probe(USER)).toBeUndefined();
  }, 150_000);

  it('the probe fails closed for a crew user that is not the one set up', async () => {
    // The keeper cannot even open its pipe to an unknown account: no answer, which refuses.
    expect(await probe('someoneelse')).toMatch(/could not be shown to hold|does not hold here/);
  }, 150_000);

  /** Starts `code` as a crew through the keeper, in its own clone, and waits for its first line. */
  async function crew(id: string, code: string) {
    const clone = join(stateRoot, 'clones', id);
    const log = join(stateRoot, 'logs', `${id}.jsonl`);
    mkdirSync(clone, { recursive: true });
    writeFileSync(log, 'before\n');
    await grants.grant([
      { path: clone, rights: 'M' },
      { path: log, rights: 'M' },
    ]);
    const claude = windowsClaude({
      stateRoot,
      credFile: credFileIn(ownerConfigDir),
      claudeBin: process.execPath,
      user: USER,
      grants,
    });
    const { pid } = await claude.start(clone, ['-e', code], 'hello crew', log, {
      ...env(),
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    let line: Record<string, string> | undefined;
    for (let i = 0; i < 200 && line === undefined; i++) {
      const first = readFileSync(log, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('{'));
      if (first !== undefined) line = JSON.parse(first);
      else await sleep(300);
    }
    const show = (f: string) => {
      const p = join(stateRoot, 'logs', f);
      return existsSync(p) ? `${f}: ${readFileSync(p, 'utf8')}` : `(no ${f})`;
    };
    return {
      claude,
      pid,
      clone,
      log,
      line,
      why: () => `${show(`${id}.keeper.log`)}; ${show(`${id}.host.err`)}`,
    };
  }

  it('a crew runs as the crew user in a job of the keeper, gets its spec by pipe, and stops with it', async () => {
    const code = [
      "let p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{",
      "require('fs').writeFileSync('secret.txt','from the first crew');",
      // A junction the crew plants to a place of the owner's: ACL work must never follow it.
      `require('fs').symlinkSync(${JSON.stringify('OUTSIDE')},'planted','junction');`,
      "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "console.log(JSON.stringify({who:require('os').userInfo().username,prompt:p,proxy:process.env.HTTPS_PROXY,",
      'token:process.env.CLAUDE_CODE_OAUTH_TOKEN,me:String(process.pid),child:String(c.pid)}));',
      'setInterval(()=>{},1000);});',
    ].join('');
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'owner.txt'), 'the owner');
    const aclBefore = (await runFile('icacls', [outside, '/T'])).stdout;
    const r = await crew('APP-1', code.replace(JSON.stringify('OUTSIDE'), JSON.stringify(outside)));
    expect(r.line?.who?.toLowerCase(), r.why()).toBe(USER);
    expect(r.line?.prompt).toBe('hello crew');
    expect(r.line?.proxy).toBe(`http://${LOOPBACK}:${proxy.port}`);
    expect(r.line?.token).toBe(TOKEN);
    expect(readFileSync(r.log, 'utf8').startsWith('before\n')).toBe(true);
    // The token reached the crew without touching the disk.
    expect(filesHolding(stateRoot, TOKEN).filter((f) => !f.endsWith('APP-1.jsonl'))).toEqual([]);
    // The identity is the keeper's, read owner-side.
    expect(await r.claude.identity(r.pid)).toMatch(/^keeper:\d{4}-/);
    expect(r.claude.alive(r.pid)).toBe(true);
    expect(existsSync(join(r.clone, 'planted'))).toBe(true);
    await r.claude.stop(r.pid);
    // Taking the clone back removed the junction and left the place it led to as it was.
    expect(existsSync(join(r.clone, 'planted'))).toBe(false);
    expect((await runFile('icacls', [outside, '/T'])).stdout).toBe(aclBefore);
    expect(readFileSync(join(outside, 'owner.txt'), 'utf8')).toBe('the owner');
    expect(r.claude.alive(r.pid)).toBe(false);
    // Ending the keeper ended the whole tree, the grandchild included.
    for (let i = 0; i < 50 && (exists(Number(r.line?.me)) || exists(Number(r.line?.child))); i++) {
      await sleep(200);
    }
    expect(exists(Number(r.line?.me))).toBe(false);
    expect(exists(Number(r.line?.child))).toBe(false);
    expect(grants.paths()).toEqual([]);
  }, 180_000);

  it('after its run, the crew user cannot read what an earlier crew left, though it made it', async () => {
    const first = join(stateRoot, 'clones', 'APP-1', 'secret.txt');
    expect(readFileSync(first, 'utf8')).toBe('from the first crew');
    const code = [
      "let r;try{r=require('fs').readFileSync(process.argv[1],'utf8')}catch(e){r=e.code}",
      "process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({read:r}));process.exit(0)});",
    ].join('');
    const clone = join(stateRoot, 'clones', 'APP-2');
    const r = await crew('APP-2', `${code}`.replace('process.argv[1]', JSON.stringify(first)));
    expect(r.line?.read, r.why()).toMatch(/^(EPERM|EACCES)$/);
    expect(existsSync(clone)).toBe(true);
    for (let i = 0; i < 50 && r.claude.alive(r.pid); i++) await sleep(200);
    expect(r.claude.alive(r.pid)).toBe(false);
    // The keeper took the grants off as the crew ended by itself.
    const acl = await runFile('icacls', [clone]);
    expect(acl.stdout.toLowerCase(), `${acl.stdout}; ${r.why()}`).not.toContain(`${USER}:`);
  }, 180_000);
});
