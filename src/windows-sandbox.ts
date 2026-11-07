import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREW_PREFIX_RE,
  type CrewAccount,
  type CrewAccounts,
  crewAccountFunctions,
  crewGroupFinish,
  crewGroupMake,
  GIT_MIN_CHECK,
  localCrewAccounts,
  TREE_SOURCE,
} from './crew-accounts.js';
import { ipv4, LOOPBACK } from './egress-proxy.js';
import { HeldError } from './held.js';
import {
  acquireStateLock,
  assertStatePath,
  ensureStateDir,
  removeStateEntry,
  writeStateFile,
} from './paths.js';
import type { Claude } from './ports.js';
import {
  type LockdownPlan,
  lockdownPlan,
  lockdownSection,
  POINT_AND_PRINT,
} from './relay-lockdown.js';
import { FOLDER_FUNCTIONS, withSteps } from './relay-windows.js';

/**
 * The crew sandbox of a worker on native Windows.
 *
 * Claude Code's sandbox does not run on native Windows (https://code.claude.com/docs/en/sandboxing:
 * "On native Windows, Claude Code runs commands unsandboxed"), so a worker there cannot rely on it.
 * Instead the whole crew, Claude Code included, runs as a local standard user made for its job and
 * deleted after it (crew-accounts.ts), in a group of Studio's the owner creates once (`studio worker
 * windows-setup` prints the script):
 *
 * - **Files.** A crew user is a member of Users and Studio's group only. The owner's profile
 *   (credentials, gh and git logins, Studio's state and owner config) is closed to other users by
 *   Windows' default profile ACL. For each run Studio grants the job's user only the run's own
 *   places: its clone, HOME, tmp dir and log (modify), its brief, settings and guard context (read),
 *   and takes the grants off when the run ends (`WindowsGrants`). One crew at a time. Toolchains,
 *   node, Git and Claude Code must be readable by the group (Program Files is; the setup grants read
 *   on the paths it is given). What a crew leaves in its profile goes with its user.
 * - **Network.** A firewall rule of the setup blocks every outbound connection of the group's
 *   members to anything but loopback. Its traffic goes through Studio's proxy on loopback
 *   (src/egress-proxy.ts), which tunnels only to the names of `network_allow` and the Claude API.
 * - **Proof, not trust.** Before every claim the worker starts a probe as the crew user of the
 *   coming job and refuses to run crews unless it shows: the process runs as that user, made for
 *   this job, not as an administrator;
 *   it cannot read the owner's profile, Studio's owner config or any deny path, nor write the
 *   owner's home; a direct connection out fails; the proxy refuses a name not on the list; and the
 *   environment Studio set reached it. Any other answer, or no answer, refuses (fail closed).
 *
 * Weaker than the macOS and Linux sandboxes, and said so in SECURITY.md: loopback is not filtered
 * by the Windows firewall, so the crew can reach services listening on loopback (denied ports are
 * refused only by the guard); and places on this machine that grant Users or Everyone access
 * (for example folders created at a drive root) are open to it unless denied by path.
 */

/** Every address but loopback, for the firewall rule: IPv4 around the 127 block, IPv6 around ::1. */
export const OUTSIDE = [
  `${ipv4(0, 0, 0, 0)}-${ipv4(126, 255, 255, 255)}`,
  `${ipv4(128, 0, 0, 0)}-${ipv4(255, 255, 255, 255)}`,
  '::',
  '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
];

/** What Claude Code itself needs out, on top of `network_allow`; other traffic is turned off. */
export const CLAUDE_HOSTS = ['api.anthropic.com'];

/** Environment for a crew on Windows: Claude Code's optional traffic off, all through the proxy. */
export function windowsCrewEnv(o: {
  proxyPort: number;
  homeDir: string;
  tmpDir: string;
  base: Record<string, string | undefined>;
}): Record<string, string> {
  const proxy = `http://${LOOPBACK}:${o.proxyPort}`;
  const env: Record<string, string> = {};
  // What Windows programs need to start at all; nothing of the owner's profile.
  for (const k of [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'ComSpec',
    'PATHEXT',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'ProgramData',
    'CommonProgramFiles',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
  ]) {
    const v = o.base[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    USERPROFILE: o.homeDir,
    APPDATA: join(o.homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(o.homeDir, 'AppData', 'Local'),
    TEMP: o.tmpDir,
    TMP: o.tmpDir,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}

/**
 * The admin-only folder of a native worker's crew users: the copy of the tree deleter the setup
 * makes and the elevated worker compiles, and the folder its compiler writes in.
 */
export const nativeCrewDir = (env: Record<string, string | undefined>): string =>
  join(env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files', 'Studio crew');
export const nativeCrewPlaces = (crewDir: string): { treeSource: string; treeTemp: string } => ({
  treeSource: join(crewDir, 'studio-tree.cs'),
  treeTemp: join(crewDir, 'tmp'),
});

/** A PowerShell single-quoted string literal. */
export function psQuote(s: string): string {
  if (/[\p{Cc}]/u.test(s)) throw new Error(`refusing a control character in ${JSON.stringify(s)}`);
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The one-time setup, for the owner to run in an elevated PowerShell. It makes Studio's group of
 * crew users with what every crew user gets through it (crew-accounts.ts): the outbound firewall
 * rule, the denied logons, and read on `readPaths` (toolchains, the Studio plugin, Claude Code, the
 * skills and plugins of the crew Claude config dir). The users themselves are made per job and
 * deleted after it, by the worker, which runs elevated. The tree deleter they need is copied into
 * an admin-only folder (`crewDir`), and compiled only from there, its temporary files in an
 * admin-only folder too. Idempotent; it takes away the shared crew user of earlier versions.
 */
export function windowsSetupScript(o: {
  prefix: string;
  /** The admin-only folder of the native worker's crew users (`nativeCrewDir`). */
  crewDir: string;
  readPaths: readonly string[];
  /** Places an earlier setup may have opened for writing (the crew Claude config dir): closed first. */
  revokePaths?: readonly string[];
  /** The network lockdown of the crew users' group (relay-lockdown.ts); null for `--no-firewall`. */
  lockdown?: LockdownPlan | null;
}): string {
  if (!CREW_PREFIX_RE.test(o.prefix)) {
    throw new Error(`not a crew user prefix (at most 13 characters): ${o.prefix}`);
  }
  const list = (ps: readonly string[]) => `@(${ps.map(psQuote).join(', ')})`;
  return withSteps(`#Requires -RunAsAdministrator
# Studio: the crew users of this Windows worker. Run once in an elevated Windows PowerShell
# (powershell.exe). Nothing here leaves this machine.
$ErrorActionPreference = 'Stop'
${GIT_MIN_CHECK}${FOLDER_FUNCTIONS}${crewAccountFunctions(o.prefix, nativeCrewPlaces(o.crewDir))}
# An earlier setup opened the crew Claude config dir for writing: that grant goes, all the way down.
foreach ($p in ${list(o.revokePaths ?? [])}) {
  if (Test-Path -LiteralPath $p) {
    icacls $p /remove:g $prefix /T /C /L /Q | Out-Null
    $g = Get-LocalGroup -Name ($prefix + 's') -ErrorAction SilentlyContinue
    if ($null -ne $g) { icacls $p /remove:g "*$($g.SID.Value)" /T /C /L /Q | Out-Null }
  }
}
$readPaths = ${list(o.readPaths)}
Step 'Git, and the group of the crew users'
${crewGroupMake()}# The tree deleter, copied into a folder only administrators may change, with its compiler's
# temporary folder: the elevated worker compiles it only from there.
$crewDir = ${psQuote(o.crewDir)}
SafeFolder $crewDir (Split-Path -Parent $crewDir)
StrictFolder $crewDir @()
StrictFolder (Join-Path $crewDir 'tmp') @()
Copy-Item -LiteralPath ${psQuote(TREE_SOURCE())} -Destination (Join-Path $crewDir 'studio-tree.cs') -Force
Step "the crew users' group: firewall rule, logon rights, read grants"
${crewGroupFinish()}Step 'network lockdown and printer drivers'
${lockdownSection(o.lockdown === undefined ? lockdownPlan({ denyHosts: [], denyPorts: [] }) : o.lockdown, '@($groupSid)')}${POINT_AND_PRINT}Write-Output "Done. Studio's crew users (group $($prefix)s) are ready. Next: studio worker --label <label>"
`);
}

// ---- Grants for one run ------------------------------------------------------------------------

export interface Grant {
  path: string;
  /** `M` modify (with inheritance for a directory), `R` read and execute. */
  rights: 'M' | 'R';
}

/** The SID of OWNER RIGHTS: an ACE for it replaces what a file's owner may do by default. */
const OWNER_RIGHTS = '*S-1-3-4';

/** A crew user as icacls takes it: by SID (`*S-1-5-21-...`), which works after it is deleted. */
const crewSid = (sid: string): string => {
  if (!/^S-1-5-21(-\d+)+$/.test(sid)) throw new Error(`not the SID of a local user: ${sid}`);
  return `*${sid}`;
};

/** The `icacls` arguments of one grant to the crew user of this SID. */
export function grantArgs(sid: string, g: Grant): string[] {
  const rights = g.rights === 'R' ? 'RX' : 'M';
  return [g.path, '/grant', `${crewSid(sid)}:${isDir(g.path) ? '(OI)(CI)' : ''}${rights}`, '/Q'];
}

/**
 * A writable directory also gets an inheritable OWNER RIGHTS entry with nothing but SYNCHRONIZE:
 * what the crew user creates there is owned by it, and an owner may by default read and change the
 * ACL of its files. With this entry it keeps no rights of its own once its grant is removed, so a
 * later crew cannot open what an earlier one left in another clone.
 */
export function ownerRightsArgs(path: string): string[] {
  return [path, '/grant', `${OWNER_RIGHTS}:(OI)(CI)(S)`, '/Q'];
}

/** The `icacls` arguments that take every grant of the crew user of this SID off a path. */
export function revokeArgs(sid: string, path: string): string[] {
  return [path, '/remove:g', crewSid(sid), '/Q'];
}

/**
 * The `icacls` calls that take a run's place back from the crew user, in order. Removing its grant
 * is not enough: what it created is owned by it, and an owner may change the ACL of its files.
 * So, below a directory, every ACL goes back to what it inherits (`/reset`, which also drops the
 * entries CREATOR OWNER gave the creator and any it set itself), and the owner of everything becomes
 * the account Studio runs as. The inheritable OWNER RIGHTS entry of the grant stays on the
 * directory, so even an owner keeps no rights of its own there.
 */
export function rootRevokeSteps(sid: string, ownerSid: string, path: string): string[][] {
  if (!OWNER_SID_RE.test(ownerSid)) throw new Error(`not a SID: ${ownerSid}`);
  return [revokeArgs(sid, path), [path, '/setowner', ownerSid, '/C', '/L', '/Q']];
}

/** Below a directory, once its links are gone: ACLs back to inherited, owner back to Studio's. */
export function deepRevokeSteps(ownerSid: string, path: string): string[][] {
  if (!OWNER_SID_RE.test(ownerSid)) throw new Error(`not a SID: ${ownerSid}`);
  // `/L` works on a link itself, never on what it points to; `removeLinks` has removed them anyway.
  return [
    [join(path, '*'), '/reset', '/T', '/C', '/L', '/Q'],
    [path, '/setowner', ownerSid, '/T', '/C', '/L', '/Q'],
  ];
}

/** The owner as icacls takes a SID: `*S-1-...`, never a name a template could garble. */
const OWNER_SID_RE = /^\*S-1-\d+(-\d+)+$/;

/** The SID of the account Studio runs as, in icacls' form, from `whoami /user`. */
export async function ownerSid(run: RunFile): Promise<string> {
  const r = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
  const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(r.stdout.trim())?.[1];
  if (r.code !== 0 || sid === undefined) throw new Error('cannot read the SID of this account');
  return `*${sid}`;
}

/**
 * Removes every link (symbolic link or junction) below `root`, which a crew may have planted
 * there, before any ACL work as the owner: such work must never reach a place outside the root.
 * Walks with lstat and never follows a link; a directory whose real path leaves the root, or a link
 * that cannot be removed, refuses.
 */
export function removeLinks(root: string): void {
  const top = realpathSync(root);
  const inside = (p: string) => p === top || p.startsWith(`${top}${sep}`);
  const walk = (dir: string) => {
    if (!inside(realpathSync(dir))) throw new Error(`${dir} leads outside ${root}`);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        try {
          unlinkSync(p);
        } catch {
          rmdirSync(p);
        }
        if (existsLink(p)) throw new Error(`cannot remove the link ${p}`);
      } else if (st.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(root);
}

function existsLink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

export type RunFile = (
  file: string,
  args: string[],
  opts?: { env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runFile: RunFile = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        ...(opts.env === undefined ? {} : { env: opts.env }),
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** The record and the lock of the crew users, owner-wide: all projects of this owner share them. */
const RECORD_FILE = 'windows-crew.json';
const LOCK_FILE = 'windows-crew.lock';
const LOCK_STALE_MS = 10 * 60_000;

interface GrantRecord {
  /** The crew user of the coming or running job. */
  account?: CrewAccount;
  /** Whether a crew was granted places as that user: then the next job gets a fresh one. */
  used?: boolean;
  /** The keeper of the crew that holds the grants, once it started. */
  keeper?: number;
  /** The SID the recorded places were granted to. */
  sid?: string;
  paths: string[];
}

function readGrantRecord(ownerRoot: string): GrantRecord {
  try {
    const raw = JSON.parse(readFileSync(join(ownerRoot, RECORD_FILE), 'utf8')) as GrantRecord;
    const a = raw.account;
    const n = a?.notes;
    const notes =
      n !== undefined && n !== null && Array.isArray(n.problems)
        ? {
            problems: n.problems.filter((x): x is string => typeof x === 'string'),
            ...(typeof n.quarantined === 'number' ? { quarantined: n.quarantined } : {}),
            ...(Array.isArray(n.stuck)
              ? { stuck: n.stuck.filter((x): x is string => typeof x === 'string') }
              : {}),
          }
        : undefined;
    const account =
      a !== undefined &&
      typeof a.user === 'string' &&
      typeof a.sid === 'string' &&
      typeof a.at === 'string'
        ? { user: a.user, sid: a.sid, at: a.at, ...(notes === undefined ? {} : { notes }) }
        : undefined;
    return {
      ...(account === undefined ? {} : { account }),
      // Anything but a plain false counts as used: the next job then gets a fresh user.
      used: raw.used !== false,
      ...(typeof raw.keeper === 'number' ? { keeper: raw.keeper } : {}),
      ...(typeof raw.sid === 'string' ? { sid: raw.sid } : {}),
      paths: Array.isArray(raw.paths) ? raw.paths.filter((p) => typeof p === 'string') : [],
    };
  } catch {
    return { paths: [] };
  }
}

const writeGrantRecord = (ownerRoot: string, r: GrantRecord) =>
  writeStateFile(ownerRoot, join(ownerRoot, RECORD_FILE), `${JSON.stringify(r)}\n`);

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The crew user of each job and its grants, recorded owner-wide (the owner's state root, never a
 * crew's places, under a lock across processes). One crew at a time on this machine: a fresh user
 * or a grant while a recorded keeper lives refuses. Before a job, `ready` gives the crew user to
 * probe and run as: the recorded one while no crew ran as it yet, else a fresh one, made after every
 * process of the earlier ones ended, their places were taken back, and they and their profiles were
 * deleted. Grants are taken off when a crew ends, when it is stopped, and before any later grant,
 * also after a crash.
 */
export class WindowsGrants {
  /** The owner's SID (`*S-1-...`), read once. */
  private sid: string | undefined;

  constructor(
    private readonly o: {
      ownerRoot: string;
      accounts: CrewAccounts;
      run: RunFile;
      /** The SID `/setowner` gives the places back to; read from `whoami` when absent. */
      owner?: string;
    },
  ) {}

  /** The crew user of the coming or running job, if one was made. */
  account(): CrewAccount | undefined {
    return readGrantRecord(this.o.ownerRoot).account;
  }

  get credFile(): string {
    return this.o.accounts.credFile;
  }

  paths(): string[] {
    return readGrantRecord(this.o.ownerRoot).paths;
  }

  /** Runs `fn` under the lock of the crew users, waiting up to 30 seconds for it. */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const until = Date.now() + 30_000;
    for (;;) {
      const lock = acquireStateLock(this.o.ownerRoot, LOCK_FILE, {
        now: new Date(),
        heartbeatStaleMs: LOCK_STALE_MS,
      });
      if (lock) {
        try {
          return await fn();
        } finally {
          lock.release();
        }
      }
      if (Date.now() >= until) {
        throw new HeldError('another launch holds the crew users of this machine; try again');
      }
      await sleep(250);
    }
  }

  private refuseWhileRunning(rec: GrantRecord): void {
    if (rec.keeper !== undefined && processExists(rec.keeper)) {
      throw new HeldError(
        'a crew is still running on this machine: one crew at a time, as all projects share its crew users',
      );
    }
  }

  /**
   * Takes every recorded place back, in one fixed order per place: the grant on the root goes
   * first and the root's owner becomes Studio's account, whatever happens next, so the crew user
   * loses its access at once; then the links below are removed; only when that worked, the ACLs
   * below go back to inherited and their owner to Studio's account. With `swept` false (processes
   * of a crew user may still run) only the first two steps run. A place where any step failed is
   * kept in the record and reported.
   */
  private async revokeLocked(swept = true): Promise<void> {
    const rec = readGrantRecord(this.o.ownerRoot);
    const failed: string[] = [];
    if (rec.paths.length > 0 && rec.sid === undefined) {
      throw new Error(`the crew grants on ${rec.paths.join(', ')} name no crew user`);
    }
    if (rec.paths.length > 0) this.sid ??= this.o.owner ?? (await ownerSid(this.o.run));
    const sid = this.sid as string;
    const icacls = async (args: string[]) => (await this.o.run('icacls', args)).code === 0;
    for (const p of rec.paths) {
      if (!existsSync(p)) continue;
      const dir = isDir(p);
      const [remove, rootOwner] = rootRevokeSteps(rec.sid as string, sid, p) as [
        string[],
        string[],
      ];
      if (!(await icacls(remove)) || !(await icacls(rootOwner))) {
        failed.push(p);
        continue;
      }
      if (!dir) continue;
      if (!swept) {
        failed.push(p);
        continue;
      }
      try {
        removeLinks(p);
      } catch {
        failed.push(p);
        continue;
      }
      for (const args of deepRevokeSteps(sid, p)) {
        if (!(await icacls(args))) {
          failed.push(p);
          break;
        }
      }
    }
    const { paths: _paths, sid: _sid, keeper: _keeper, ...keep } = rec;
    writeGrantRecord(this.o.ownerRoot, {
      ...keep,
      paths: failed,
      ...(failed.length > 0 && rec.sid !== undefined ? { sid: rec.sid } : {}),
    });
    if (failed.length > 0) {
      throw new Error(`cannot take the crew user's grants off ${failed.join(', ')}`);
    }
  }

  /**
   * Takes every recorded grant off, after the sweep: no crew process may plant a link behind the
   * walk. When the sweep refuses, the grants on the roots still go, and the sweep's refusal is
   * thrown.
   */
  revokeAll(): Promise<void> {
    return this.locked(() => this.revokeSwept());
  }

  private async revokeSwept(): Promise<void> {
    try {
      await this.o.accounts.sweep();
    } catch (e) {
      await this.revokeLocked(false).catch(() => {});
      throw e;
    }
    await this.revokeLocked();
  }

  /**
   * The crew user for the coming job: the recorded one while no crew ran as it and it still exists,
   * else a fresh one, after the places of the earlier ones are taken back and they are deleted.
   */
  ready(): Promise<CrewAccount> {
    return this.locked(async () => {
      const rec = readGrantRecord(this.o.ownerRoot);
      this.refuseWhileRunning(rec);
      if (
        rec.account !== undefined &&
        rec.used === false &&
        rec.paths.length === 0 &&
        (await this.o.accounts.exists(rec.account.sid))
      ) {
        return rec.account;
      }
      await this.revokeSwept();
      // Recorded as used before it is made: a crash halfway leaves no user that seems unused.
      writeGrantRecord(this.o.ownerRoot, { used: true, paths: [] });
      const account = await this.o.accounts.fresh();
      writeGrantRecord(this.o.ownerRoot, { account, used: false, paths: [] });
      return account;
    });
  }

  /** After a job: every process of the crew users ends, their places go back, they are deleted. */
  retire(): Promise<void> {
    return this.locked(async () => {
      const rec = readGrantRecord(this.o.ownerRoot);
      this.refuseWhileRunning(rec);
      await this.revokeSwept();
      writeGrantRecord(this.o.ownerRoot, { used: true, paths: [] });
      await this.o.accounts.retire();
    });
  }

  /**
   * Grants places to the crew user of the coming job (from `ready`). `launch`: for a crew, which
   * makes the user used, so the next job gets a fresh one; else (the probe's seed) it stays unused.
   */
  grant(grants: readonly Grant[], opts: { launch?: boolean } = {}): Promise<void> {
    return this.locked(async () => {
      const rec = readGrantRecord(this.o.ownerRoot);
      this.refuseWhileRunning(rec);
      const account = rec.account;
      if (account === undefined) {
        throw new Error('no crew user was made for this job: the probe before it did not run');
      }
      // Nothing of a crew user may run while its places are taken back and walked.
      await this.revokeSwept();
      // Recorded before granting: a crash halfway leaves nothing that is not taken off later.
      writeGrantRecord(this.o.ownerRoot, {
        account,
        used: opts.launch === true || rec.used !== false,
        sid: account.sid,
        paths: grants.map((g) => g.path),
      });
      for (const g of grants) {
        const steps = [
          grantArgs(account.sid, g),
          ...(g.rights === 'M' && isDir(g.path) ? [ownerRightsArgs(g.path)] : []),
        ];
        for (const args of steps) {
          const r = await this.o.run('icacls', args);
          if (r.code !== 0) {
            throw new Error(
              `cannot open ${g.path} to the crew user ${account.user}: icacls exited ${r.code}`,
            );
          }
        }
      }
    });
  }

  recordKeeper(pid: number): Promise<void> {
    return this.locked(async () => {
      writeGrantRecord(this.o.ownerRoot, {
        ...readGrantRecord(this.o.ownerRoot),
        keeper: pid,
      });
    });
  }
}

// ---- The keeper: starting, holding and stopping a crew -----------------------------------------

/** The crew host (bin/studio-crew-host.mjs): runs as the crew user, starts the crew. */
export const CREW_HOST_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'studio-crew-host.mjs',
);

/** The keeper's file name; the identity check looks for it on the command line. */
export const KEEPER_FILE = 'studio-crew-keeper.ps1';

/**
 * The keeper: a PowerShell of the owner that lives as long as the crew. It reads from its stdin a
 * first line with the paths whose grants it takes off at the end, then the spec. It creates a job
 * object that ends every process in it when its last handle closes, starts the host as the crew
 * user (`Start-Process -Credential`, whose process handle has full access) and puts it in the job
 * before the host has its spec, so nothing the crew starts escapes the job. The spec, with the
 * crew's environment and so the Claude token, goes to the host over a named pipe only the owner and
 * the crew user may open, and only once the pipe's client is that very host: it never lands on
 * disk. Then it waits for the host and takes the grants off. Ending the keeper (Studio's stop)
 * closes the job and so ends the crew's whole tree. The host's output goes to files in a directory
 * of the owner, which the crew user cannot reach.
 */
export const KEEPER_SCRIPT = `# Studio: the keeper of one crew on a Windows worker (src/windows-sandbox.ts).
param(
  [Parameter(Mandatory = $true)][string]$Cred,
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$HostBin,
  [Parameter(Mandatory = $true)][string]$Cwd,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Err,
  [Parameter(Mandatory = $true)][string]$User,
  [int]$WaitSeconds = 60
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StudioJob {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)]
  struct Extended {
    public Basic BasicLimits; public Io IoInfo; public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  public static void Terminate(IntPtr job) { TerminateJobObject(job, 1); }
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended info = new Extended();
    info.BasicLimits.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
    return job;
  }
  public static void Assign(IntPtr job, IntPtr process) {
    if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
  }
  public static uint ClientPid(IntPtr pipe) {
    uint pid;
    if (!GetNamedPipeClientProcessId(pipe, out pid)) throw new Win32Exception();
    return pid;
  }
}
'@
function Note([string]$line) { [Console]::Error.WriteLine("studio keeper: $line") }
Note 'started'
$raw = [Console]::In.ReadToEnd()
$nl = $raw.IndexOf([char]10)
if ($nl -lt 0) { throw 'no spec on stdin' }
# Windows PowerShell hands a JSON array on as one object: @() around it would nest it.
$revoke = ConvertFrom-Json $raw.Substring(0, $nl)
$spec = [Text.Encoding]::UTF8.GetBytes($raw.Substring($nl + 1))
$raw = $null
$p = $null
$job = $null
$crew = $null
try {
  $job = [StudioJob]::Create()
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $crew = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, $User)).Translate([Security.Principal.SecurityIdentifier])
  $security = New-Object System.IO.Pipes.PipeSecurity
  $security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, 'FullControl', 'Allow')))
  $security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($crew, 'ReadWrite', 'Allow')))
  $name = 'studio-' + [Guid]::NewGuid().ToString('N')
  $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($name, 'Out', 1, 'Byte', 'Asynchronous', 0, 65536, $security)
  # The password of this job's crew user, sealed for this machine (LocalMachine DPAPI) in a file
  # only SYSTEM, administrators and the account Studio runs as may read (crew-accounts.ts); an SSH
  # key logon (a relay worker) could not open the account's own DPAPI keys.
  Add-Type -AssemblyName System.Security
  $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($Cred), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  $secure = New-Object Security.SecureString
  foreach ($ch in [Text.Encoding]::UTF8.GetString($plain).ToCharArray()) { $secure.AppendChar($ch) }
  [Array]::Clear($plain, 0, $plain.Length)
  $c = New-Object System.Management.Automation.PSCredential ("$env:COMPUTERNAME\\$User", $secure)
  $p = Start-Process -FilePath $Node -ArgumentList @(('"' + $HostBin + '"'), $name) -Credential $c -WorkingDirectory $Cwd -WindowStyle Hidden -PassThru -RedirectStandardOutput $Out -RedirectStandardError $Err
  [StudioJob]::Assign($job, $p.Handle)
  Note "host $($p.Id) started in the job"
  $wait = $pipe.BeginWaitForConnection($null, $null)
  if (-not $wait.AsyncWaitHandle.WaitOne($WaitSeconds * 1000)) { throw 'the crew host did not connect' }
  $pipe.EndWaitForConnection($wait)
  Note 'host connected'
  if ([StudioJob]::ClientPid($pipe.SafePipeHandle.DangerousGetHandle()) -ne [uint32]$p.Id) {
    throw 'a process other than the crew host connected'
  }
  $pipe.Write($spec, 0, $spec.Length)
  $pipe.Flush()
  $pipe.WaitForPipeDrain()
  $pipe.Dispose()
  $spec = $null
  $p.WaitForExit()
  $code = $p.ExitCode
  Note "host ended with $code"
} catch {
  if ($null -ne $p -and -not $p.HasExited) { $p.Kill() }
  [Console]::Error.WriteLine("studio keeper: $($_.Exception.Message)")
  $code = 2
} finally {
  # Nothing the crew started outlives it here, then its grants go. The ownership reset and the
  # walk for planted links are Studio's, at the next grant or stop (WindowsGrants.revokeAll).
  if ($null -ne $job) { [StudioJob]::Terminate($job) }
  foreach ($r in $revoke) {
    if ($null -eq $crew -or -not (Test-Path -LiteralPath $r)) { continue }
    icacls $r /remove:g "*$($crew.Value)" /L /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
      [Console]::Error.WriteLine("studio keeper: cannot take the grant off $r ($LASTEXITCODE)")
      $code = 3
    }
  }
}
exit $code
`;

export interface HostSpec {
  /** seed: only writes `seed` (a file the crew user owns), for the probe's later check. */
  mode: 'run' | 'probe' | 'seed';
  seed?: string;
  /** run: what to start, where, its prompt on stdin and the log it appends to. */
  cmd?: string;
  args?: string[];
  cwd?: string;
  prompt?: string;
  log?: string;
  /** probe: what must hold for the crew user. */
  probe?: ProbeSpec;
  /** The environment of the crew (or of the probe's child); it may hold the Claude token. */
  env?: Record<string, string>;
}

export interface ProbeSpec {
  user: string;
  mark: string;
  mustNotRead: string[];
  mustNotWrite: string[];
  /** A name and port a direct connection must not reach. */
  direct: { host: string; port: number };
  /** The proxy, and a name it must refuse. */
  proxy: { port: number; refused: string };
  /**
   * A place granted to the crew user before and taken back since, and a file the crew user made
   * there: it must not change the file, its ACL, or add a file.
   */
  former?: { dir: string; file: string };
  /**
   * Relay workers: addresses (this machine's own on SMB, the owner's list) the crew user must not
   * connect to directly; the firewall rule must hold them.
   */
  unreachable?: { host: string; port: number }[];
  /** Denied ports that listen on loopback: the crew user must not connect to any of them. */
  loopback?: { host: string; port: number }[];
  /** Hosts whose `\\<host>\IPC$` the crew user opens without credentials (relay-hosts.ts). */
  smb?: string[];
  /** Whether the crew user must hold no stored credential (Credential Manager). */
  noStoredCredentials?: boolean;
  /**
   * The crew user made for this job: the host must run as this SID, in a profile made no earlier
   * than the user (a fresh user, never one an earlier crew ran as).
   */
  fresh: { sid: string; notBefore: string };
}

/** What PowerShell itself gets: what Windows programs need, no token, no PowerShell 7 modules. */
export function powershellEnv(env: Record<string, string | undefined>): Record<string, string> {
  const keep = new Set([
    'systemroot',
    'systemdrive',
    'windir',
    'comspec',
    'pathext',
    'path',
    'programfiles',
    'programdata',
    'number_of_processors',
    'processor_architecture',
    'os',
    'computername',
    'userdomain',
    'username',
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined && keep.has(e[0].toLowerCase()),
    ),
  );
}

/** Starts a keeper; `exited` settles with its exit code. A seam for tests. */
export type SpawnKeeper = (o: {
  args: string[];
  env: Record<string, string>;
  stdin: string;
  /** The keeper's own output, a file of the owner. */
  log: string;
  detached: boolean;
}) => Promise<{ pid: number; exited: Promise<number> }>;

export const spawnKeeper: SpawnKeeper = async (o) => {
  const fd = openSync(o.log, 'a');
  try {
    // Never Node's `detached` (DETACHED_PROCESS): a PowerShell started so wrote nothing and never
    // ran its script on the Windows runner. `windowsHide` gives it a hidden console of its own,
    // which a closed terminal of the worker does not take down; `unref` lets the worker go on.
    const child = spawn('powershell.exe', o.args, {
      env: o.env,
      stdio: ['pipe', fd, fd],
      windowsHide: true,
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve(child.pid as number));
    });
    const exited = new Promise<number>((resolve) => child.once('exit', (c) => resolve(c ?? 1)));
    child.stdin?.on('error', () => {});
    child.stdin?.end(o.stdin);
    if (o.detached) child.unref();
    return { pid, exited };
  } finally {
    closeSync(fd);
  }
};

/**
 * Files the keeper and the host write their output to, in the owner's `logs` dir, which no crew
 * user is granted: a link planted there would be followed with the owner's rights. Each is removed
 * first (a link is unlinked, never followed) and every directory on the way checked, right before
 * the keeper starts.
 */
function ownerFiles(stateRoot: string, name: string) {
  const logs = ensureStateDir(stateRoot, join(stateRoot, 'logs'));
  if (lstatSync(logs).isSymbolicLink()) throw new Error(`${logs} is a link`);
  const files = {
    out: join(logs, `${name}.host.out`),
    err: join(logs, `${name}.host.err`),
    keeper: join(logs, `${name}.keeper.log`),
  };
  for (const f of Object.values(files)) {
    removeStateEntry(stateRoot, f);
    assertStatePath(stateRoot, f);
  }
  return files;
}

/** Writes the keeper script into the owner's settings dir and returns its path. */
function keeperFile(stateRoot: string): string {
  const file = join(stateRoot, 'settings', KEEPER_FILE);
  writeStateFile(stateRoot, file, KEEPER_SCRIPT);
  return file;
}

function keeperArgs(o: {
  script: string;
  credFile: string;
  node: string;
  cwd: string;
  out: string;
  err: string;
  user: string;
}): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    o.script,
    '-Cred',
    o.credFile,
    '-Node',
    o.node,
    '-HostBin',
    CREW_HOST_BIN,
    '-Cwd',
    o.cwd,
    '-Out',
    o.out,
    '-Err',
    o.err,
    '-User',
    o.user,
  ];
}

/**
 * The PowerShell that tells whether `pid` is a keeper of this owner: its owner's SID is the
 * caller's, its command line runs the keeper file; then it prints the process's creation time.
 */
export const identityScript = (pid: number): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}'`,
    'if ($null -eq $p) { exit 3 }',
    '$o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid',
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    `if ($o.Sid -ne $me -or $p.CommandLine -notlike ${psQuote(`*${KEEPER_FILE}*`)}) { exit 4 }`,
    "[Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('o'))",
  ].join('\n');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Claude Code for crews of this worker, started as the crew user through a keeper. Studio records
 * the keeper (the owner's own process): `alive`, `identity` and `stop` work on it, never on anything
 * the crew controls. The identity is the keeper's creation time, read owner-side through CIM, and
 * only for a process of this owner running the keeper file. Stopping ends the keeper, which closes
 * its job and so ends the crew's tree; the grants are taken off then as well.
 */
export function windowsClaude(o: {
  stateRoot: string;
  claudeBin: string;
  grants: WindowsGrants;
  run?: RunFile;
  spawn?: SpawnKeeper;
  node?: string;
}): Claude {
  const run = o.run ?? runFile;
  const start = o.spawn ?? spawnKeeper;
  const node = o.node ?? process.execPath;
  return {
    async start(cwd, args, prompt, logPath, env) {
      const id =
        logPath
          .replace(/\\/g, '/')
          .split('/')
          .at(-1)
          ?.replace(/\.jsonl$/, '') ?? '';
      if (!/^[A-Z]+-\d+$/.test(id)) throw new Error(`not a crew log: ${logPath}`);
      const account = o.grants.account();
      if (account === undefined) throw new Error('no crew user was made for this job');
      const files = ownerFiles(o.stateRoot, id);
      const spec: HostSpec = {
        mode: 'run',
        cmd: o.claudeBin,
        args,
        cwd,
        prompt,
        log: logPath,
        env,
      };
      const k = await start({
        args: keeperArgs({
          script: keeperFile(o.stateRoot),
          credFile: o.grants.credFile,
          node,
          cwd,
          out: files.out,
          err: files.err,
          user: account.user,
        }),
        env: powershellEnv(env),
        stdin: `${JSON.stringify(o.grants.paths())}\n${JSON.stringify(spec)}`,
        log: files.keeper,
        detached: true,
      });
      await o.grants.recordKeeper(k.pid);
      return { pid: k.pid };
    },
    alive: processExists,
    async identity(pid) {
      if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return undefined;
      const r = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', identityScript(pid)],
        { env: powershellEnv(process.env), timeoutMs: 30_000 },
      );
      const at = r.stdout.trim();
      return r.code === 0 && at !== '' ? `keeper:${at}` : undefined;
    },
    async stop(pid) {
      if (processExists(pid)) await run('taskkill', ['/PID', String(pid), '/F']);
      for (let i = 0; i < 50 && processExists(pid); i++) await sleep(200);
      // Its processes end, its places go back, and the crew user and its profile are deleted.
      await o.grants.retire();
    },
  };
}

// ---- The probe ---------------------------------------------------------------------------------

export interface ProbeResult {
  check: string;
  ok: boolean;
  detail: string;
  /** `smb`: the system error code per host, 0 for a session that opened. */
  codes?: Record<string, number>;
}

/** The first check that did not hold, as the refusal line; undefined when all held. */
export function probeProblem(results: readonly ProbeResult[] | undefined): string | undefined {
  if (results === undefined || results.length === 0) {
    return 'the Windows crew sandbox could not be shown to hold here: the probe as the crew user gave no answer';
  }
  const bad = results.find((r) => !r.ok);
  return bad === undefined
    ? undefined
    : `the Windows crew sandbox does not hold here: ${bad.check}: ${bad.detail}`;
}

/** The checks a probe must report, every one of them, and those its extras add. */
export const probeChecks = (p: ProbeSpec): string[] => [
  ...PROBE_CHECKS,
  ...(p.unreachable === undefined ? [] : ['unreachable']),
  ...(p.loopback === undefined ? [] : ['loopback']),
  ...(p.smb === undefined ? [] : ['smb']),
  ...(p.noStoredCredentials === true ? ['credentials'] : []),
];

export const PROBE_CHECKS = [
  'user',
  'admin',
  'env',
  'read',
  'write',
  'direct',
  'proxy',
  'tasks',
  'former',
  'fresh',
];

/**
 * Starts the host in probe mode as the crew user of the coming job (`grants.ready`: a fresh one
 * unless no crew ran as the recorded one yet) through a keeper, waits for it and judges what it
 * printed. Canaries: a file in the owner config dir (read) and the owner's home (write);
 * `mustNotRead` adds the worker's deny paths. It runs in the Windows directory, which every user
 * may read, so it needs no grant.
 *
 * It first shows that taking a place back holds: a seed run as the crew user makes a file in a
 * place granted to it, the grant is taken back as after every run, and the probe must then fail to
 * change that file, its ACL, or add a file there.
 */
export async function probeWindowsSandbox(o: {
  stateRoot: string;
  ownerHome: string;
  ownerConfigDir: string;
  mustNotRead: readonly string[];
  /** The shared crew Claude config dir: its root and its plugins must not be writable. */
  crewConfigDir?: string;
  /** The crew users and their grants: the user to probe, and the check of a place taken back. */
  grants: WindowsGrants;
  proxyPort: number;
  env: Record<string, string>;
  spawn?: SpawnKeeper;
  node?: string;
  timeoutMs?: number;
  /** A relay worker: the checks of its probe on top. */
  extra?: Pick<ProbeSpec, 'unreachable' | 'loopback' | 'smb' | 'noStoredCredentials'>;
}): Promise<string | undefined> {
  const r = await probeWindowsResults(o);
  return 'problem' in r ? r.problem : probeProblem(r.results);
}

/**
 * The probe as `probeWindowsSandbox` runs it, with every result for a caller that judges more than
 * pass or fail (a relay worker: SMB codes, loopback listeners). A probe that did not finish, or
 * left out a check, is a problem.
 */
export async function probeWindowsResults(
  o: Parameters<typeof probeWindowsSandbox>[0],
): Promise<{ results: ProbeResult[] } | { problem: string }> {
  const start = o.spawn ?? spawnKeeper;
  const account = await o.grants.ready();
  const name = `probe-${randomBytes(4).toString('hex')}`;
  const files = ownerFiles(o.stateRoot, name);
  const canary = join(o.ownerConfigDir, 'crew-probe-canary');
  const formerDir = join(o.stateRoot, 'tmp', `${name}-former`);
  writeStateFile(dirname(canary), canary, 'canary\n');
  /** One host run as the crew user; false when it did not finish in time. */
  const host = async (spec: HostSpec, revoke: readonly string[] = []): Promise<boolean> => {
    for (const f of Object.values(files)) removeStateEntry(o.stateRoot, f);
    const k = await start({
      args: keeperArgs({
        script: keeperFile(o.stateRoot),
        credFile: o.grants.credFile,
        node: o.node ?? process.execPath,
        cwd: o.env.SystemRoot ?? o.env.SYSTEMROOT ?? 'C:\\Windows',
        out: files.out,
        err: files.err,
        user: account.user,
      }),
      env: powershellEnv(o.env),
      stdin: `${JSON.stringify(revoke)}\n${JSON.stringify(spec)}`,
      log: files.keeper,
      detached: false,
    });
    const timeout = sleep(o.timeoutMs ?? 120_000).then(() => 'timeout' as const);
    if ((await Promise.race([k.exited, timeout])) === 'timeout') {
      try {
        process.kill(k.pid);
      } catch {
        // gone already
      }
      return false;
    }
    return true;
  };
  const unfinished =
    'the Windows crew sandbox could not be shown to hold here: the probe as the crew user did not finish';
  try {
    const mark = randomBytes(8).toString('hex');
    ensureStateDir(o.stateRoot, formerDir);
    const file = join(formerDir, 'made-by-the-crew-user.txt');
    await o.grants.grant([{ path: formerDir, rights: 'M' }]);
    const seeded = await host({ mode: 'seed', seed: file, env: o.env });
    await o.grants.revokeAll();
    if (!seeded) return { problem: unfinished };
    const former = { dir: formerDir, file };
    const spec: HostSpec = {
      mode: 'probe',
      probe: {
        user: account.user,
        mark,
        mustNotRead: [canary, o.ownerHome, ...o.mustNotRead],
        mustNotWrite: [
          join(o.ownerHome, `studio-probe-${mark}`),
          ...(o.crewConfigDir === undefined
            ? []
            : [
                join(o.crewConfigDir, `studio-probe-${mark}`),
                join(o.crewConfigDir, 'plugins', `studio-probe-${mark}`),
              ]),
        ],
        direct: { host: 'github.com', port: 443 },
        proxy: { port: o.proxyPort, refused: 'example.invalid' },
        former,
        fresh: { sid: account.sid, notBefore: account.at },
        ...(o.extra ?? {}),
      },
      env: { ...o.env, STUDIO_PROBE_MARK: mark },
    };
    if (!(await host(spec))) return { problem: unfinished };
    let results: ProbeResult[] | undefined;
    try {
      const raw = JSON.parse(readFileSync(files.out, 'utf8')) as unknown;
      results = Array.isArray(raw) ? (raw as ProbeResult[]) : undefined;
    } catch {
      results = undefined;
    }
    // Every check must be there: a host that left one out proves nothing about it.
    const missing = probeChecks(spec.probe as ProbeSpec).find(
      (c) => !(results ?? []).some((r) => r.check === c),
    );
    if (results !== undefined && missing !== undefined) {
      return {
        problem: `the Windows crew sandbox could not be shown to hold here: the probe did not check ${missing}`,
      };
    }
    if (results === undefined || results.length === 0)
      return { problem: probeProblem(results) as string };
    return { results };
  } finally {
    for (const f of Object.values(files)) removeStateEntry(o.stateRoot, f);
    removeStateEntry(o.stateRoot, formerDir);
    removeStateEntry(dirname(canary), canary);
  }
}

// ---- The worker's side -------------------------------------------------------------------------

/**
 * Where the password of a native worker's crew user lies, sealed for this machine, readable only by
 * SYSTEM, administrators and the owner: the owner config dir.
 */
export const credFileIn = (ownerConfigDir: string): string =>
  join(ownerConfigDir, 'windows-crew.bin');

/** The first `claude` on PATH (`.exe`, `.cmd`), as the owner would start it; undefined if none. */
export function findClaude(path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(';')) {
    if (dir === '') continue;
    for (const name of ['claude.exe', 'claude.cmd']) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * What the setup opens for reads: node, the Studio plugin, Claude Code, the toolchains, and of the
 * crew Claude config dir only the skills and plugins (each run gets a writable config dir of its
 * own in its HOME).
 */
export function setupReadPaths(o: {
  node: string;
  claude: string | undefined;
  toolchains: readonly string[];
  crewConfigDir: string;
}): string[] {
  const plugin = resolve(dirname(CREW_HOST_BIN), '..');
  return [
    ...new Set([
      dirname(o.node),
      plugin,
      ...(o.claude === undefined ? [] : [dirname(o.claude)]),
      ...o.toolchains,
      join(o.crewConfigDir, 'skills'),
      join(o.crewConfigDir, 'plugins'),
    ]),
  ];
}

/**
 * A run's own Claude config dir in its HOME, writable by the crew user: the skills and the plugin
 * lists of the shared crew config dir are copied (plain files and folders, no links); the plugins
 * themselves stay in the shared dir, which the crew user may only read.
 */
export function runConfigDir(homeDir: string, shared: string): string {
  const dir = join(homeDir, '.claude-run');
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  const copy = (from: string, to: string) => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(from);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const n of readdirSync(from)) copy(join(from, n), join(to, n));
    } else if (st.isFile()) {
      copyFileSync(from, to);
    }
  };
  copy(join(shared, 'skills'), join(dir, 'skills'));
  for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
    copy(join(shared, 'plugins', f), join(dir, 'plugins', f));
  }
  copy(join(shared, 'settings.json'), join(dir, 'settings.json'));
  return dir;
}

export interface WindowsWorker {
  claude: Claude;
  sandbox: {
    user: string;
    probe(mustNotRead: readonly string[]): Promise<string | undefined>;
    launch: { user: string; proxyPort: number; grant(grants: Grant[]): Promise<void> };
  };
  close(): Promise<void>;
}

/**
 * Everything a native Windows worker needs for its crews: the proxy, the Claude port that starts
 * crews as the crew user of their job, the probe and the grants. The worker runs elevated and makes
 * and deletes the crew users itself (crew-accounts.ts). `run`, `spawn` and `accounts` are seams for
 * tests.
 */
export async function windowsWorker(o: {
  /** The name prefix of the crew users (`workers.self.windows.crew_user`). */
  prefix: string;
  stateRoot: string;
  /** The owner's state root: the crew users' record and lock, shared by all projects. */
  ownerRoot: string;
  /** The shared crew Claude config dir: the probe proves the crew user cannot write it. */
  crewConfigDir: string;
  ownerHome: string;
  ownerConfigDir: string;
  networkAllow: readonly string[];
  env: Record<string, string | undefined>;
  startProxy: (allow: readonly string[]) => Promise<{ port: number; close(): Promise<void> }>;
  run?: RunFile;
  spawn?: SpawnKeeper;
  accounts?: CrewAccounts;
}): Promise<WindowsWorker> {
  const run = o.run ?? runFile;
  const path = o.env.PATH ?? o.env.Path;
  const claudeBin = findClaude(path);
  const proxy = await o.startProxy([...o.networkAllow, ...CLAUDE_HOSTS]);
  const accounts =
    o.accounts ??
    localCrewAccounts({
      prefix: o.prefix,
      credFile: credFileIn(o.ownerConfigDir),
      run,
      reader: async () => (await ownerSid(run)).slice(1),
      ...nativeCrewPlaces(nativeCrewDir(o.env)),
    });
  const grants = new WindowsGrants({ ownerRoot: o.ownerRoot, accounts, run });
  return {
    claude: windowsClaude({
      stateRoot: o.stateRoot,
      claudeBin: claudeBin ?? 'claude',
      grants,
      run,
      ...(o.spawn === undefined ? {} : { spawn: o.spawn }),
    }),
    sandbox: {
      user: o.prefix,
      async probe(mustNotRead) {
        if (claudeBin === undefined) return 'claude is not on PATH';
        try {
          return await probe(mustNotRead);
        } catch (e) {
          // A probe that cannot run (no elevation, no crew user, a grant that cannot be taken back)
          // proves nothing: it refuses like a failed check.
          return `the Windows crew sandbox could not be shown to hold here: ${(e as Error).message}`;
        }
      },
      launch: {
        user: o.prefix,
        proxyPort: proxy.port,
        grant: (g) => grants.grant(g, { launch: true }),
      },
    },
    close: () => proxy.close(),
  };

  async function probe(mustNotRead: readonly string[]): Promise<string | undefined> {
    const tmp = ensureStateDir(o.stateRoot, join(o.stateRoot, 'tmp'));
    const probeEnv = windowsCrewEnv({
      proxyPort: proxy.port,
      homeDir: tmp,
      tmpDir: tmp,
      base: o.env,
    });
    return probeWindowsSandbox({
      stateRoot: o.stateRoot,
      ownerHome: o.ownerHome,
      ownerConfigDir: o.ownerConfigDir,
      mustNotRead,
      crewConfigDir: o.crewConfigDir,
      grants,
      proxyPort: proxy.port,
      env: { ...probeEnv, PATH: path ?? '' },
      ...(o.spawn === undefined ? {} : { spawn: o.spawn }),
    });
  }
}
