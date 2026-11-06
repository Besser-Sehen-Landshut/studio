import {
  chmodSync,
  existsSync,
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
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CREW_DESCRIPTION,
  type CrewAccounts,
  crewAccountScript,
  GIT_MIN_CHECK,
  GROUP_DESCRIPTION,
  judgeCrewAnswer,
  localCrewAccounts,
  TREE_SOURCE,
} from '../src/crew-accounts.js';
import { ipv4, LOOPBACK } from '../src/egress-proxy.js';
import { HeldError } from '../src/held.js';
import {
  CREW_HOST_BIN,
  deepRevokeSteps,
  findClaude,
  grantArgs,
  type HostSpec,
  identityScript,
  KEEPER_FILE,
  KEEPER_SCRIPT,
  OUTSIDE,
  ownerRightsArgs,
  ownerSid,
  PROBE_CHECKS,
  type ProbeResult,
  powershellEnv,
  probeProblem,
  probeWindowsSandbox,
  psQuote,
  type RunFile,
  removeLinks,
  revokeArgs,
  rootRevokeSteps,
  runConfigDir,
  type SpawnKeeper,
  setupReadPaths,
  WindowsGrants,
  windowsClaude,
  windowsCrewEnv,
  windowsSetupScript,
  windowsWorker,
} from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-win-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

describe('the setup script', () => {
  const script = windowsSetupScript({
    prefix: 'studio-crew',
    readPaths: ['C:\\Program Files\\nodejs'],
    revokePaths: ['C:\\Users\\owner\\.config\\studio\\claude'],
  });

  it("makes Studio's group of crew users; the users themselves come per job", () => {
    expect(script).toMatch(/^#Requires -RunAsAdministrator/);
    // Git for Windows 2.35.2 or later (CVE-2022-24765), before anything else.
    expect(script).toContain(GIT_MIN_CHECK);
    expect(GIT_MIN_CHECK).toContain("-lt [version]'2.35.2'");
    expect(script).toContain("$prefix = 'studio-crew'");
    expect(script).toContain(`$groupDescription = '${GROUP_DESCRIPTION}'`);
    expect(script).toContain("New-LocalGroup -Name ($prefix + 's') -Description $groupDescription");
    // A group of that name that is not Studio's refuses.
    expect(script).toContain("is not Studio's: remove it or choose another crew_user prefix");
    // No user and no password is made here.
    expect(script).not.toContain('New-LocalUser -Name $name -Password $secret');
    expect(script).not.toContain('Export-Clixml');
    expect(script).not.toMatch(/Write-Output .*\$plain/);
  });

  it('takes away the shared crew user of earlier versions and crew users a crash left', () => {
    expect(script).toContain("$old.Description -eq 'Studio crew sandbox'");
    expect(script).toContain('QuarantineProfile $old (Quarantine)');
    expect(script).toContain('$null = RetireJobUsers');
  });

  it('blocks every outbound connection of the group except loopback', () => {
    expect(script).toMatch(/New-NetFirewallRule .*-Direction Outbound -Action Block/);
    expect(script).toContain('-LocalUser "D:(A;;CC;;;$groupSid)"');
    expect(script).toContain(`'${OUTSIDE[0]}', '${OUTSIDE[1]}'`);
    expect(OUTSIDE[0]).toBe(`${ipv4(0, 0, 0, 0)}-${ipv4(126, 255, 255, 255)}`);
    expect(script).toContain("'::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'");
    expect(script).not.toContain(`${ipv4(127, 0, 0, 0)}-`);
  });

  it('closes what an earlier setup opened for writing, before it opens anything for reading', () => {
    const at = (x: string) => script.indexOf(x);
    expect(script).toContain("@('C:\\Users\\owner\\.config\\studio\\claude')");
    expect(script).toContain('icacls $p /remove:g $prefix /T /C /L /Q');
    expect(at('/remove:g $prefix')).toBeLessThan(at('(OI)(CI)RX'));
  });

  it('denies the group batch, service, network and remote desktop logons', () => {
    for (const right of [
      'SeDenyBatchLogonRight',
      'SeDenyServiceLogonRight',
      'SeDenyNetworkLogonRight',
      'SeDenyRemoteInteractiveLogonRight',
    ]) {
      expect(script).toContain(`'${right}'`);
    }
    expect(script).toContain('"$right = *$groupSid"');
    expect(script).toContain('secedit /configure');
  });

  it('opens the given paths for reading only, to the group, and refuses a bad prefix', () => {
    expect(script).toContain("$readPaths = @('C:\\Program Files\\nodejs')");
    expect(script).toContain('"*$($groupSid):(OI)(CI)RX"');
    expect(script).not.toMatch(/\(OI\)\(CI\)M/);
    expect(() => windowsSetupScript({ prefix: 'x; rm', readPaths: [] })).toThrow(/prefix/);
    // `<prefix>-<6 hex>` must be a local user name of at most 20 characters.
    expect(() => windowsSetupScript({ prefix: 'abcdefghijklmn', readPaths: [] })).toThrow(
      /at most 13/,
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
    expect(at('icacls $r /remove:g "*$($crew.Value)"')).toBeGreaterThan(at('} finally {'));
    // The job ends before the grants go, and every icacls call is checked.
    expect(at('[StudioJob]::Terminate($job)')).toBeLessThan(
      at('icacls $r /remove:g "*$($crew.Value)"'),
    );
    expect(KEEPER_SCRIPT).toContain('if ($LASTEXITCODE -ne 0)');
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

const SID = 'S-1-5-21-1-2-3-1001';
const OWNER = '*S-1-5-21-1-2-3-500';

/** Crew users in memory: what was asked of them, in order. `left` makes the sweep refuse. */
function fakeAccounts(o: { left?: number[]; gone?: boolean } = {}) {
  const ops: string[] = [];
  let made = 0;
  const accounts: CrewAccounts = {
    credFile: 'C:\\cred.bin',
    async sweep() {
      ops.push('sweep');
      if ((o.left ?? []).length > 0) {
        throw new Error(`processes of the crew users are still running (${o.left?.join(', ')})`);
      }
    },
    async retire() {
      ops.push('retire');
    },
    async fresh() {
      ops.push('fresh');
      made++;
      return { user: `studio-crew-00000${made}`, sid: `${SID}${made}`, at: '2026-01-01T00:00:00Z' };
    },
    async exists() {
      return o.gone !== true;
    },
  };
  return { accounts, ops };
}

/** icacls always succeeds unless `failArg` is among its arguments. */
const recordingRun = (failArg?: string) => {
  const calls: string[][] = [];
  const run: RunFile = async (file, args) => {
    calls.push([file, ...args]);
    return {
      code: failArg !== undefined && args.includes(failArg) ? 5 : 0,
      stdout: '',
      stderr: '',
    };
  };
  return {
    run,
    calls,
    icacls: () => calls.filter((c) => c[0] === 'icacls').map((c) => c.slice(1)),
  };
};

describe('grants and the crew user of each job', () => {
  it('grants by SID: modify inherits on a directory, read on a file; OWNER RIGHTS keeps owners out', () => {
    const file = join(root, 'f');
    writeFileSync(file, '');
    expect(grantArgs(SID, { path: root, rights: 'M' })).toEqual([
      root,
      '/grant',
      `*${SID}:(OI)(CI)M`,
      '/Q',
    ]);
    expect(grantArgs(SID, { path: file, rights: 'R' })).toEqual([
      file,
      '/grant',
      `*${SID}:RX`,
      '/Q',
    ]);
    expect(ownerRightsArgs(root)).toEqual([root, '/grant', '*S-1-3-4:(OI)(CI)(S)', '/Q']);
    expect(revokeArgs(SID, file)).toEqual([file, '/remove:g', `*${SID}`, '/Q']);
    // Only the SID of a local user; never a name a template could garble.
    expect(() => grantArgs('crew', { path: file, rights: 'R' })).toThrow(/not the SID/);
    expect(() => grantArgs('S-1-5-18', { path: file, rights: 'R' })).toThrow(/not the SID/);
  });

  const place = () => {
    const base = join(root, `g${n++}`);
    const dir = join(base, 'clone');
    mkdirSync(dir, { recursive: true });
    return { ownerRoot: join(base, 'owner'), dir };
  };

  it('a fresh crew user per job: kept while no crew ran as it, a new one after a launch', async () => {
    const { ownerRoot, dir } = place();
    const f = fakeAccounts();
    const r = recordingRun();
    const g = new WindowsGrants({ ownerRoot, accounts: f.accounts, run: r.run, owner: OWNER });
    // Without a crew user made for the job, nothing is granted.
    await expect(g.grant([{ path: dir, rights: 'M' }])).rejects.toThrow(/no crew user was made/);
    const first = await g.ready();
    expect(f.ops).toEqual(['sweep', 'fresh']);
    // The probe's seed grant leaves it unused: the same user again.
    await g.grant([{ path: dir, rights: 'M' }]);
    await g.revokeAll();
    expect(await g.ready()).toEqual(first);
    // A launch uses it up: the next job first takes its places back, then a fresh user.
    await g.grant([{ path: dir, rights: 'M' }], { launch: true });
    expect(r.icacls().at(-2)).toEqual([dir, '/grant', `*${first.sid}:(OI)(CI)M`, '/Q']);
    f.ops.length = 0;
    r.calls.length = 0;
    const second = await g.ready();
    expect(second.sid).not.toBe(first.sid);
    expect(f.ops).toEqual(['sweep', 'fresh']);
    expect(r.icacls()[0]).toEqual([dir, '/remove:g', `*${first.sid}`, '/Q']);
    // A recorded user that is gone is never reused.
    const gone = fakeAccounts({ gone: true });
    const g2 = new WindowsGrants({
      ownerRoot: place().ownerRoot,
      accounts: gone.accounts,
      run: r.run,
      owner: OWNER,
    });
    await g2.ready();
    await g2.ready();
    expect(gone.ops.filter((o) => o === 'fresh')).toHaveLength(2);
  });

  it('one crew at a time, owner-wide: a live keeper holds every grant, fresh user and retire', async () => {
    const { ownerRoot, dir } = place();
    const f = fakeAccounts();
    const r = recordingRun();
    const one = new WindowsGrants({ ownerRoot, accounts: f.accounts, run: r.run, owner: OWNER });
    await one.ready();
    await one.grant([{ path: dir, rights: 'M' }], { launch: true });
    await one.recordKeeper(process.pid);
    const other = new WindowsGrants({ ownerRoot, accounts: f.accounts, run: r.run, owner: OWNER });
    await expect(other.grant([{ path: dir, rights: 'M' }])).rejects.toThrow(HeldError);
    await expect(other.ready()).rejects.toThrow(/one crew at a time/);
    await expect(other.retire()).rejects.toThrow(HeldError);
    // Once it is gone, retiring takes the places back and deletes the crew users.
    await one.recordKeeper(2 ** 22 + 12345);
    f.ops.length = 0;
    await other.retire();
    expect(f.ops).toEqual(['sweep', 'retire']);
    expect(other.paths()).toEqual([]);
    expect(other.account()).toBeUndefined();
  });

  it('takes the last run back in one fixed order, by SID, before the next grant', async () => {
    const { ownerRoot, dir } = place();
    const f = fakeAccounts();
    const r = recordingRun();
    const g = new WindowsGrants({ ownerRoot, accounts: f.accounts, run: r.run, owner: OWNER });
    const a = await g.ready();
    await g.grant([{ path: dir, rights: 'M' }]);
    expect(r.icacls()).toEqual([
      [dir, '/grant', `*${a.sid}:(OI)(CI)M`, '/Q'],
      [dir, '/grant', '*S-1-3-4:(OI)(CI)(S)', '/Q'],
    ]);
    r.calls.length = 0;
    await g.grant([{ path: dir, rights: 'R' }]);
    // The grant on the root, its owner, then (links gone) everything below.
    expect(r.icacls().slice(0, 4)).toEqual([
      [dir, '/remove:g', `*${a.sid}`, '/Q'],
      [dir, '/setowner', OWNER, '/C', '/L', '/Q'],
      [join(dir, '*'), '/reset', '/T', '/C', '/L', '/Q'],
      [dir, '/setowner', OWNER, '/T', '/C', '/L', '/Q'],
    ]);
    await g.revokeAll();
    expect(g.paths()).toEqual([]);
  });

  it('refuses a grant and a fresh user while processes of a crew user are left', async () => {
    const { ownerRoot, dir } = place();
    const ok = fakeAccounts();
    const r = recordingRun();
    await new WindowsGrants({ ownerRoot, accounts: ok.accounts, run: r.run, owner: OWNER }).ready();
    const f = fakeAccounts({ left: [77, 78] });
    const g = new WindowsGrants({ ownerRoot, accounts: f.accounts, run: r.run, owner: OWNER });
    r.calls.length = 0;
    await expect(g.grant([{ path: dir, rights: 'M' }])).rejects.toThrow(/still running \(77, 78\)/);
    expect(r.icacls()).toEqual([]);
    // The recorded user is unused and exists: it is kept, nothing swept. A used one is not.
    await g.ready();
    expect(f.ops).toEqual(['sweep']);
  });

  it('a file taken back gets its owner reset; a bad account name refuses', () => {
    const file = join(root, `rf${n++}`);
    writeFileSync(file, '');
    expect(rootRevokeSteps(SID, OWNER, file)).toEqual([
      [file, '/remove:g', `*${SID}`, '/Q'],
      [file, '/setowner', OWNER, '/C', '/L', '/Q'],
    ]);
    expect(() => rootRevokeSteps(SID, 'HOST\\owner', file)).toThrow(/not a SID/);
    expect(() => deepRevokeSteps('HOST\\owner', file)).toThrow(/not a SID/);
  });

  describe('taking back when a step fails', () => {
    const setupPlace = async (run: RunFile, left?: number[]) => {
      const { ownerRoot, dir } = place();
      const f = fakeAccounts();
      const g = new WindowsGrants({ ownerRoot, accounts: f.accounts, run, owner: OWNER });
      const a = await g.ready();
      await g.grant([{ path: dir, rights: 'M' }]);
      const failing = new WindowsGrants({
        ownerRoot,
        accounts: fakeAccounts({ left: left ?? [] }).accounts,
        run,
        owner: OWNER,
      });
      return { g, failing, dir, sid: a.sid };
    };

    // A folder that cannot be listed stands in for a walk that fails; chmod does not do that on Windows.
    it.skipIf(process.platform === 'win32')(
      'a walk that fails still takes the grant off the root, skips the recursive steps, and reports it',
      async () => {
        const r = recordingRun();
        const { g, dir, sid } = await setupPlace(r.run);
        const locked = join(dir, 'locked');
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        r.calls.length = 0;
        try {
          await expect(g.revokeAll()).rejects.toThrow(/cannot take the crew user's grants off/);
        } finally {
          chmodSync(locked, 0o700);
        }
        expect(r.icacls()).toEqual([
          [dir, '/remove:g', `*${sid}`, '/Q'],
          [dir, '/setowner', OWNER, '/C', '/L', '/Q'],
        ]);
        expect(g.paths()).toEqual([dir]);
      },
    );

    it('the sweep comes first; when it refuses, only the roots are taken back', async () => {
      const r = recordingRun();
      const { g, failing, dir, sid } = await setupPlace(r.run, [77]);
      r.calls.length = 0;
      await expect(failing.revokeAll()).rejects.toThrow(/still running \(77\)/);
      expect(r.icacls()).toEqual([
        [dir, '/remove:g', `*${sid}`, '/Q'],
        [dir, '/setowner', OWNER, '/C', '/L', '/Q'],
      ]);
      expect(g.paths()).toEqual([dir]);
    });

    it('a grant that cannot be removed is kept in the record, and nothing else runs on it', async () => {
      const r = recordingRun('/remove:g');
      const { g, dir, sid } = await setupPlace(r.run);
      r.calls.length = 0;
      await expect(g.revokeAll()).rejects.toThrow(/cannot take the crew user's grants off/);
      expect(r.icacls()).toEqual([[dir, '/remove:g', `*${sid}`, '/Q']]);
      expect(g.paths()).toEqual([dir]);
    });
  });

  it('reads the owner SID from whoami, and refuses without one', async () => {
    const answer =
      (stdout: string, code = 0): RunFile =>
      async () => ({ code, stdout, stderr: '' });
    expect(await ownerSid(answer('"host\\owner","S-1-5-21-1-2-3-1001"\r\n'))).toBe(
      '*S-1-5-21-1-2-3-1001',
    );
    await expect(ownerSid(answer('', 1))).rejects.toThrow(/SID/);
  });

  it('removes every link below a place before ACL work, and leaves what it pointed to alone', () => {
    const base = join(root, `links${n++}`);
    const dir = join(base, 'place');
    const outside = join(base, 'outside');
    mkdirSync(join(dir, 'deep'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    writeFileSync(join(dir, 'deep', 'mine.txt'), 'x');
    symlinkSync(outside, join(dir, 'to-outside'), 'dir');
    symlinkSync(join(outside, 'keep.txt'), join(dir, 'deep', 'file-link'));
    removeLinks(dir);
    expect(readdirSync(dir).sort()).toEqual(['deep']);
    expect(readdirSync(join(dir, 'deep'))).toEqual(['mine.txt']);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('a worker that is not elevated refuses to claim: its probe answers with the refusal', async () => {
    const base = join(root, `w${n++}`);
    const ownerConfigDir = join(base, 'config');
    mkdirSync(ownerConfigDir, { recursive: true });
    const bin = join(base, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude.exe'), '');
    const spawned: string[] = [];
    const w = await windowsWorker({
      prefix: 'crew',
      stateRoot: join(base, 'state'),
      ownerRoot: join(base, 'owner'),
      crewConfigDir: join(base, 'crew'),
      ownerHome: base,
      ownerConfigDir,
      networkAllow: [],
      env: { PATH: bin, SystemRoot: 'C:\\Windows' },
      startProxy: async () => ({ port: 1, close: async () => {} }),
      run: async (file) =>
        file === 'powershell.exe'
          ? { code: 0, stdout: '{"notElevated":true}', stderr: '' }
          : { code: 0, stdout: '"h\\o","S-1-5-21-1-2-3-1001"', stderr: '' },
      spawn: async (o) => {
        spawned.push(o.stdin);
        return { pid: 1, exited: Promise.resolve(0) };
      },
    });
    expect(await w.sandbox.probe([])).toMatch(
      /could not be shown to hold here: the worker does not run elevated/,
    );
    // Nothing ran as a crew user.
    expect(spawned).toEqual([]);
  });
});

describe('the crew user scripts', () => {
  it("count only users of the prefix with Studio's description; retire never waits for a profile", () => {
    const s = crewAccountScript({ op: 'retire', prefix: 'studio-crew', pruneBudget: 500 });
    expect(s).toContain("$prefix = 'studio-crew'");
    expect(s).toContain(`$crewDescription = '${CREW_DESCRIPTION}'`);
    expect(s).toContain("'-[0-9a-f]{6}$'");
    expect(s).toContain('$_.Description -eq $crewDescription');
    expect(s).toContain(`$treeSource = '${TREE_SOURCE()}'`);
    expect(s).toContain('$pruneBudget = 500');
    // One order, each step for every user even when it failed for another: lock (disabled, a
    // password nobody knows), sweep, profile into the quarantine, sweep, delete the account, then
    // a bounded part of the quarantine.
    const retire = s.slice(s.indexOf('function RetireJobUsers'));
    const at = (x: string) => retire.indexOf(x);
    const order = [
      'foreach ($u in $users) { try { LockJobUser $u } catch {',
      '$null = SweepJobUsers',
      'try { QuarantineProfile $u $q } catch {',
      '$s = SweepJobUsers',
      'try { Remove-LocalUser -SID $u.SID; $gone += $u.Name } catch {',
      '[StudioTree]::Prune($q, $pruneBudget, $true, $null)',
    ];
    for (let i = 1; i < order.length; i++) {
      expect(at(order[i - 1] as string), order[i - 1]).toBeGreaterThan(0);
      expect(at(order[i - 1] as string), order[i]).toBeLessThan(at(order[i] as string));
    }
    expect(s).toContain('Disable-LocalUser -SID $u.SID');
    expect(s).toContain('Set-LocalUser -SID $u.SID -Password (ConvertTo-SecureString (NewSecret)');
    // The profile is moved in one rename; nothing deletes it in place, nothing with Remove-Item
    // (which follows junctions in Windows PowerShell).
    const quarantine = s.slice(
      s.indexOf('function QuarantineProfile'),
      s.indexOf('function RetireJobUsers'),
    );
    expect(quarantine).toContain('[StudioTree]::Move($path, (Join-Path $q');
    expect(quarantine).not.toMatch(/Remove-Item -LiteralPath \$path/);
    expect(s).toContain("Join-Path (ProfileRoot) 'Studio crew quarantine'");
    expect(s).toContain(
      "icacls $q /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'",
    );
    expect(s).toContain('inherits its ACL');
    expect(s).toContain('is a reparse point');
    expect(s).toContain('not a folder right below');
    // A member of the group that is not a crew user of Studio's refuses everything.
    expect(s).toContain("which is not a crew user of Studio's: remove it from the group");
    expect(s).toContain('$out.problems = @($r.problems)');
  });

  it('a fresh user is a standard user in the group, its password sealed for the reader only', () => {
    const s = crewAccountScript({
      op: 'fresh',
      prefix: 'studio-crew',
      credFile: 'C:\\c\\crew.bin',
      reader: 'S-1-5-21-9-9-9-1001',
    });
    expect(s).toContain("NewJobUser 'C:\\c\\crew.bin' 'S-1-5-21-9-9-9-1001'");
    expect(s).toContain('Add-LocalGroupMember -Group $g -Member $u');
    expect(s).toContain("Get-LocalGroup -SID 'S-1-5-32-544'");
    expect(s).toContain('DataProtectionScope]::LocalMachine');
    expect(s).toContain(`"*$($reader):R"`);
    // A fresh user only when no process of an earlier one is left.
    expect(s).toMatch(
      /\$r = RetireJobUsers[\s\S]*if \(@\(\$out\.left\)\.Count -eq 0\) \{\s*\$n = NewJobUser/,
    );
    // Replace keeps the DACL of the file it replaced: the intended one goes on after it.
    const seal = s.slice(s.indexOf('function SealFor'));
    expect(seal.indexOf('[IO.File]::Replace(')).toBeLessThan(
      seal.lastIndexOf(
        `icacls $file /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($reader):R" /L /Q`,
      ),
    );
    expect(() => crewAccountScript({ op: 'fresh', prefix: 'studio-crew' })).toThrow(/reader/);
    expect(() =>
      crewAccountScript({ op: 'fresh', prefix: 'x', credFile: 'c', reader: "a'b" }),
    ).toThrow(/not a SID/);
  });

  it('judges answers: an error, processes left, a fresh user with its notes, and nothing else', () => {
    const none = { problems: [] };
    expect(judgeCrewAnswer('sweep', { op: 'sweep', at: 'x', left: [] })).toEqual({
      left: [],
      notes: none,
    });
    expect(judgeCrewAnswer('sweep', { op: 'sweep', at: 'x', left: 77 })).toMatchObject({
      left: [77],
    });
    expect(judgeCrewAnswer('sweep', { op: 'retire', at: 'x', left: [] })).toBeUndefined();
    expect(judgeCrewAnswer('retire', { op: 'retire', at: 'x', error: 'no' })).toEqual({
      error: 'no',
    });
    const fresh = {
      op: 'fresh',
      at: 'x',
      left: [],
      problems: 'studio-crew-aaaaaa: its profile stays where it is: busy',
      quarantine: { trees: 2, pruned: 500, done: false },
      user: 'studio-crew-0a1b2c',
      sid: SID,
    };
    expect(judgeCrewAnswer('fresh', fresh)).toEqual({
      account: { user: 'studio-crew-0a1b2c', sid: SID, at: 'x' },
      notes: {
        problems: ['studio-crew-aaaaaa: its profile stays where it is: busy'],
        quarantined: 2,
      },
    });
    // Processes left: no fresh user, and that refuses.
    expect(judgeCrewAnswer('fresh', { op: 'fresh', at: 'x', left: [9] })).toMatchObject({
      left: [9],
    });
    expect(judgeCrewAnswer('fresh', { ...fresh, user: 'Administrator' })).toBeUndefined();
    expect(judgeCrewAnswer('fresh', { ...fresh, sid: 'S-1-5-18' })).toBeUndefined();
  });

  it('the native worker runs them itself, elevated, and reads their answer', async () => {
    const scripts: string[] = [];
    const answers: Record<string, unknown> = {
      fresh: { op: 'fresh', at: '2026-01-01T00:00:00Z', left: [], user: 'crew-0a1b2c', sid: SID },
      retire: { op: 'retire', at: 'x', left: [] },
      sweep: { op: 'sweep', at: 'x', left: [5] },
    };
    const a = localCrewAccounts({
      prefix: 'crew',
      credFile: 'C:\\c.bin',
      reader: async () => 'S-1-5-21-9-9-9-1001',
      run: async (_file, args) => {
        const script = args.at(-1) as string;
        scripts.push(script);
        const op = /\$out = @\{ op = '(\w+)'/.exec(script)?.[1] as string;
        return { code: 0, stdout: JSON.stringify(answers[op]), stderr: '' };
      },
    });
    expect(await a.fresh()).toEqual({
      user: 'crew-0a1b2c',
      sid: SID,
      at: '2026-01-01T00:00:00Z',
      notes: { problems: [] },
    });
    expect(scripts[0]).toMatch(/^if \(-not \(\[Security\.Principal\.WindowsPrincipal\]/);
    await a.retire();
    await expect(a.sweep()).rejects.toThrow(/still running \(5\)/);
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
      ownerRoot: join(stateRoot, 'owner'),
      accounts: fakeAccounts().accounts,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const claude = windowsClaude({
      stateRoot,
      claudeBin: 'claude.exe',
      grants,
      spawn: f.spawn,
      node: 'node.exe',
    });
    const log = join(stateRoot, 'logs', 'APP-1.jsonl');
    // No crew user made for the job: nothing starts.
    await expect(claude.start('C:\\clone', ['-p'], 'hi', log, {})).rejects.toThrow(/no crew user/);
    const account = await grants.ready();
    const r = await claude.start('C:\\clone', ['-p'], 'hi', log, {
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      Path: 'p',
    });
    expect(r.pid).toBe(4321);
    const c = f.calls[0];
    expect(c?.detached).toBe(true);
    expect(c?.env).toEqual({ Path: 'p' });
    expect(c?.args[c.args.indexOf('-Cred') + 1]).toBe('C:\\cred.bin');
    expect(c?.args[c.args.indexOf('-User') + 1]).toBe(account.user);
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
    const grants = new WindowsGrants({
      ownerRoot: join(stateRoot, 'owner'),
      accounts: fakeAccounts().accounts,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    await grants.ready();
    const claude = windowsClaude({
      stateRoot,
      claudeBin: 'claude.exe',
      grants,
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
    const accounts = fakeAccounts();
    const calls: string[][] = [];
    const run: RunFile = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    return {
      stateRoot,
      ownerConfigDir,
      ownerHome: base,
      mustNotRead: ['D:\\data'],
      proxyPort: 1234,
      env: { PATH: 'x', SystemRoot: 'C:\\Windows' },
      timeoutMs: 2000,
      node: 'node',
      grants: new WindowsGrants({
        ownerRoot: join(base, 'owner'),
        accounts: accounts.accounts,
        run,
        owner: OWNER,
      }),
      ops: accounts.ops,
      calls,
    };
  };
  const ok = PROBE_CHECKS.map((check) => ({ check, ok: true, detail: '' }));

  it('probes the crew user made for the job, and leaves nothing behind', async () => {
    const { ops, calls, ...o } = setup();
    const f = fakeSpawn(() => ok);
    expect(
      await probeWindowsSandbox({ ...o, crewConfigDir: join('C:', 'crew'), spawn: f.spawn }),
    ).toBeUndefined();
    expect(ops).toEqual(['sweep', 'fresh', 'sweep', 'sweep']);
    const account = o.grants.account();
    const c = f.calls[1];
    expect(c?.detached).toBe(false);
    expect(c?.args[c.args.indexOf('-User') + 1]).toBe(account?.user);
    // The mark travels in the spec, never in PowerShell's own environment; it runs in Windows.
    const spec = JSON.parse(c?.stdin.slice(c.stdin.indexOf('\n') + 1) as string) as HostSpec;
    expect(spec.probe?.user).toBe(account?.user);
    // The host must run as the SID made for this job, in a profile no older than it.
    expect(spec.probe?.fresh).toEqual({ sid: account?.sid, notBefore: account?.at });
    expect(spec.env?.STUDIO_PROBE_MARK).toBe(spec.probe?.mark);
    expect(c?.env.STUDIO_PROBE_MARK).toBeUndefined();
    expect(c?.args[c.args.indexOf('-Cwd') + 1]).toBe('C:\\Windows');
    expect(spec.probe?.mustNotRead).toEqual([
      join(o.ownerConfigDir, 'crew-probe-canary'),
      o.ownerHome,
      'D:\\data',
    ]);
    expect(existsSync(join(o.ownerConfigDir, 'crew-probe-canary'))).toBe(false);
    expect(spec.probe?.mustNotWrite.slice(1)).toEqual([
      join('C:', 'crew', `studio-probe-${spec.probe?.mark}`),
      join('C:', 'crew', 'plugins', `studio-probe-${spec.probe?.mark}`),
    ]);
    // A second probe before any launch probes the same user.
    await probeWindowsSandbox({ ...o, spawn: fakeSpawn(() => ok).spawn });
    expect(o.grants.account()).toEqual(account);
  });

  it('a seed run makes a file in a granted place, which is taken back before the probe', async () => {
    const { ops: _ops, calls, ...o } = setup();
    const modes: string[] = [];
    let former: { dir: string; file: string } | undefined;
    const f = fakeSpawn((spec) => {
      modes.push(spec.mode);
      if (spec.mode === 'seed') {
        // Granted to the crew user while it seeds.
        expect(o.grants.paths()).toEqual([dirname(spec.seed as string)]);
        return undefined;
      }
      former = spec.probe?.former;
      // Taken back before the probe.
      expect(o.grants.paths()).toEqual([]);
      return ok;
    });
    expect(await probeWindowsSandbox({ ...o, spawn: f.spawn })).toBeUndefined();
    expect(modes).toEqual(['seed', 'probe']);
    expect(former?.file).toBe(join(former?.dir as string, 'made-by-the-crew-user.txt'));
    expect(calls.some((c) => c.includes('/setowner'))).toBe(true);
    expect(existsSync(former?.dir as string)).toBe(false);
  });

  it('refuses a failed check, a missing check, no answer, and a host that never finishes', async () => {
    const { ops: _ops, calls: _calls, ...o } = setup();
    const failing = ok.map((r) =>
      r.check === 'read' ? { ...r, ok: false, detail: 'D:\\data' } : r,
    );
    expect(await probeWindowsSandbox({ ...o, spawn: fakeSpawn(() => failing).spawn })).toBe(
      'the Windows crew sandbox does not hold here: read: D:\\data',
    );
    expect(
      await probeWindowsSandbox({
        ...o,
        spawn: fakeSpawn(() => ok.filter((r) => r.check !== 'fresh')).spawn,
      }),
    ).toMatch(/did not check fresh/);
    expect(await probeWindowsSandbox({ ...o, spawn: fakeSpawn(() => undefined).spawn })).toMatch(
      /no answer/,
    );
    const hanging: SpawnKeeper = async () => ({ pid: 2 ** 22 + 99, exited: new Promise(() => {}) });
    expect(await probeWindowsSandbox({ ...o, timeoutMs: 100, spawn: hanging })).toMatch(
      /did not finish/,
    );
  });
});
