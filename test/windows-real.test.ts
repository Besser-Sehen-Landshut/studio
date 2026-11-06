// The Windows crew sandbox on a real Windows machine: only in the windows-latest CI job, which runs
// elevated and may create a local user (STUDIO_WINDOWS_SANDBOX_TEST=1). Never on a developer's
// machine by accident: it adds a group, users and a firewall rule.
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
import { localCrewAccounts } from '../src/crew-accounts.js';
import { type EgressProxy, LOOPBACK, startEgressProxy } from '../src/egress-proxy.js';
import {
  credFileIn,
  nativeCrewDir,
  nativeCrewPlaces,
  ownerSid,
  powershellEnv,
  probeWindowsSandbox,
  runFile,
  WindowsGrants,
  windowsClaude,
  windowsCrewEnv,
  windowsSetupScript,
} from '../src/windows-sandbox.js';

const on = process.platform === 'win32' && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';
/** The name prefix of the crew users here: one user `studioci-<6 hex>` per job, group `studiocis`. */
const PREFIX = 'studioci';
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
        prefix: PREFIX,
        crewDir: nativeCrewDir(process.env),
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
    proxy = await startEgressProxy({ allow: ['github.com'] });
    grants = new WindowsGrants({
      ownerRoot: join(base, 'owner'),
      accounts: localCrewAccounts({
        ...nativeCrewPlaces(nativeCrewDir(process.env)),
        prefix: PREFIX,
        credFile: credFileIn(ownerConfigDir),
        run: runFile,
        reader: async () => (await ownerSid(runFile)).slice(1),
        // Small, so a profile of a few thousand files waits in the quarantine over several runs.
        pruneBudget: 1000,
      }),
      run: runFile,
    });
  }, 240_000);
  afterAll(async () => {
    await proxy?.close();
  });

  const probe = () =>
    probeWindowsSandbox({
      stateRoot,
      ownerHome: homedir(),
      ownerConfigDir,
      mustNotRead: [],
      crewConfigDir,
      grants,
      proxyPort: proxy.port,
      env: env(),
      timeoutMs: 120_000,
    });
  /** PowerShell of this elevated job, its answer trimmed. */
  const ps = async (script: string) =>
    (
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeoutMs: 120_000,
        env: powershellEnv(process.env),
      })
    ).stdout.trim();
  /** Entries waiting in the quarantine of retired profiles. */
  const quarantined = async () =>
    Number(
      await ps(
        `$q = Join-Path ([Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList').ProfilesDirectory)) 'Studio crew quarantine\\trees'; if (Test-Path -LiteralPath $q) { @(Get-ChildItem -LiteralPath $q -Recurse -Force -Attributes !ReparsePoint -ErrorAction SilentlyContinue).Count } else { 0 }`,
      ),
    );
  /** The crew users that exist now. */
  const crewUsers = async () =>
    (
      await ps(
        `@(Get-LocalUser | Where-Object { $_.Name -like '${PREFIX}-*' } | ForEach-Object { $_.Name }) -join ','`,
      )
    )
      .split(',')
      .filter((x) => x !== '');

  it('a write grant an earlier setup left on the crew Claude config dir refuses, and the setup takes it off', async () => {
    const group = await ps(`(Get-LocalGroup -Name '${PREFIX}s').SID.Value`);
    expect(group).toMatch(/^S-1-5-21-/);
    const r = await runFile('icacls', [crewConfigDir, '/grant', `*${group}:(OI)(CI)M`, '/Q']);
    expect(r.code).toBe(0);
    expect(await probe()).toMatch(/does not hold here: write: writable: .*crew-claude/);
    await setup();
    expect(await probe()).toBeUndefined();
  }, 400_000);

  it('the probe as the crew user of the coming job holds; it stays that user until a crew ran', async () => {
    expect(await probe()).toBeUndefined();
    const a = grants.account();
    expect(a?.user).toMatch(/^studioci-[0-9a-f]{6}$/);
    expect(await probe()).toBeUndefined();
    expect(grants.account()).toEqual(a);
    expect(await crewUsers()).toEqual([a?.user]);
  }, 300_000);

  /** Starts `code` as a crew through the keeper, in its own clone, and waits for its first line. */
  async function crew(id: string, code: string) {
    const clone = join(stateRoot, 'clones', id);
    const log = join(stateRoot, 'logs', `${id}.jsonl`);
    mkdirSync(clone, { recursive: true });
    writeFileSync(log, 'before\n');
    const account = await grants.ready();
    await grants.grant(
      [
        { path: clone, rights: 'M' },
        { path: log, rights: 'M' },
      ],
      { launch: true },
    );
    const claude = windowsClaude({
      stateRoot,
      claudeBin: process.execPath,
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
      account,
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
      // One in its own profile, which is deleted after the job: that must never follow it either.
      "const home=require('os').userInfo().homedir;",
      `require('fs').symlinkSync(${JSON.stringify('PROFILE_OUTSIDE')},require('path').join(home,'planted'),'junction');`,
      // A profile too big to delete in one go: it must not hold up the next job.
      "const bulk=require('path').join(home,'bulk');require('fs').mkdirSync(bulk);",
      "for(let i=0;i<3000;i++)require('fs').writeFileSync(require('path').join(bulk,'f'+i),'x');",
      "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "console.log(JSON.stringify({who:require('os').userInfo().username,home,prompt:p,proxy:process.env.HTTPS_PROXY,",
      'token:process.env.CLAUDE_CODE_OAUTH_TOKEN,me:String(process.pid),child:String(c.pid)}));',
      'setInterval(()=>{},1000);});',
    ].join('');
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'owner.txt'), 'the owner');
    const aclBefore = (await runFile('icacls', [outside, '/T'])).stdout;
    const profileOutside = join(base, 'profile-outside');
    mkdirSync(profileOutside, { recursive: true });
    writeFileSync(join(profileOutside, 'owner.txt'), 'the owner');
    const profileAclBefore = (await runFile('icacls', [profileOutside, '/T'])).stdout;
    const r = await crew(
      'APP-1',
      code
        .replace(JSON.stringify('OUTSIDE'), JSON.stringify(outside))
        .replace(JSON.stringify('PROFILE_OUTSIDE'), JSON.stringify(profileOutside)),
    );
    expect(r.line?.who?.toLowerCase(), r.why()).toBe(r.account.user);
    expect(existsSync(join(r.line?.home as string, 'planted'))).toBe(true);
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
    // Stopping deleted the crew user and moved its profile into the quarantine, where a part of it
    // was deleted; the junction in it led nowhere on the way.
    expect(await crewUsers()).toEqual([]);
    expect(existsSync(r.line?.home as string)).toBe(false);
    expect(await quarantined()).toBeGreaterThan(1000);
    expect(readFileSync(join(profileOutside, 'owner.txt'), 'utf8')).toBe('the owner');
    expect((await runFile('icacls', [profileOutside, '/T'])).stdout).toBe(profileAclBefore);
  }, 300_000);

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
    expect(r.account.user).toMatch(/^studioci-[0-9a-f]{6}$/);
    expect(existsSync(clone)).toBe(true);
    for (let i = 0; i < 50 && r.claude.alive(r.pid); i++) await sleep(200);
    expect(r.claude.alive(r.pid)).toBe(false);
    // The keeper took the grants off as the crew ended by itself.
    const acl = await runFile('icacls', [clone]);
    expect(acl.stdout.toLowerCase(), `${acl.stdout}; ${r.why()}`).not.toContain(r.account.user);
    expect(acl.stdout, acl.stdout).not.toContain(r.account.sid);
    // A used crew user is never probed or run again: the next job gets a fresh one, the old one
    // and its profile are deleted first.
    expect(await probe()).toBeUndefined();
    expect(grants.account()?.user).not.toBe(r.account.user);
    expect(await crewUsers()).toEqual([grants.account()?.user]);
    // The quarantine shrinks with every retire, and never held up a fresh user. The first retire
    // also moves in the profile of the user just made.
    await grants.retire();
    let left = await quarantined();
    for (let i = 0; i < 10 && left > 0; i++) {
      await grants.retire();
      const now = await quarantined();
      expect(now).toBeLessThan(left);
      left = now;
    }
    expect(left).toBe(0);
    expect(await crewUsers()).toEqual([]);
    expect(readFileSync(join(base, 'profile-outside', 'owner.txt'), 'utf8')).toBe('the owner');
  }, 400_000);
});
