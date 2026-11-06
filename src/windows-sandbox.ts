import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipv4, LOOPBACK } from './egress-proxy.js';
import { ensureStateDir, removeStateEntry, writeStateFile } from './paths.js';
import type { Claude } from './ports.js';

/**
 * The crew sandbox of a worker on native Windows.
 *
 * Claude Code's sandbox does not run on native Windows (https://code.claude.com/docs/en/sandboxing:
 * "On native Windows, Claude Code runs commands unsandboxed"), so a worker there cannot rely on it.
 * Instead the whole crew, Claude Code included, runs as a dedicated local standard user the owner
 * creates once (`studio worker windows-setup` prints the script):
 *
 * - **Files.** The crew user is a member of Users only. The owner's profile (credentials, gh and
 *   git logins, Studio's state and owner config) is closed to other users by Windows' default
 *   profile ACL. For each run Studio grants the crew user only the run's own places: its clone,
 *   HOME and tmp dir (modify), its brief, settings and guard context (read) and its log (write).
 *   Toolchains, node, Git and Claude Code must be readable by it (Program Files is; the setup
 *   grants read on the paths it is given).
 * - **Network.** A firewall rule of the setup blocks every outbound connection of the crew user
 *   to anything but loopback. Its traffic goes through Studio's proxy on loopback
 *   (src/egress-proxy.ts), which tunnels only to the names of `network_allow` and the Claude API.
 * - **Proof, not trust.** Before every claim the worker starts a probe as the crew user and
 *   refuses to run crews unless it shows: the process runs as that user, not as an administrator;
 *   it cannot read the owner's profile, Studio's owner config or any deny path, nor write the
 *   owner's home; a direct connection out fails; the proxy refuses a name not on the list; and the
 *   environment Studio set reached it. Any other answer, or no answer, refuses (fail closed).
 *
 * Weaker than the macOS and Linux sandboxes, and said so in SECURITY.md: loopback is not filtered
 * by the Windows firewall, so the crew can reach services listening on loopback (denied ports are
 * refused only by the guard); and places on this machine that grant Users or Everyone access
 * (for example folders created at a drive root) are open to it unless denied by path.
 */

/** A local user name Studio accepts: letters, digits, `_` and `-`, at most 20 characters. */
export const CREW_USER_RE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;

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

/** A PowerShell single-quoted string literal. */
export function psQuote(s: string): string {
  if (/[\p{Cc}]/u.test(s)) throw new Error(`refusing a control character in ${JSON.stringify(s)}`);
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The one-time setup, for the owner to run in an elevated PowerShell as the account the worker runs
 * under (the credential file is encrypted for that account, DPAPI). It creates the crew user with a
 * random password nobody sees, a member of Users only; stores its credential for the owner alone;
 * adds the outbound firewall rule; and grants the crew user read on `readPaths` (toolchains, the
 * Studio plugin, Claude Code) and modify on `writePaths` (the crew Claude config dir). Idempotent:
 * an existing user keeps its password unless the credential file is missing.
 */
export function windowsSetupScript(o: {
  user: string;
  credFile: string;
  readPaths: readonly string[];
  writePaths: readonly string[];
}): string {
  if (!CREW_USER_RE.test(o.user)) throw new Error(`not a crew user name: ${o.user}`);
  const list = (ps: readonly string[]) => `@(${ps.map(psQuote).join(', ')})`;
  return `#Requires -RunAsAdministrator
# Studio: the crew sandbox user of this Windows worker. Run once in an elevated Windows PowerShell
# (powershell.exe), as the account that runs \`studio worker\`. Nothing here leaves this machine.
$ErrorActionPreference = 'Stop'
$name = ${psQuote(o.user)}
$credFile = ${psQuote(o.credFile)}
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$plain = [Convert]::ToBase64String($bytes) + 'aA1!'
$secret = ConvertTo-SecureString $plain -AsPlainText -Force
$plain = $null
$user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if ($null -eq $user) {
  $user = New-LocalUser -Name $name -Password $secret -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description 'Studio crew sandbox'
} elseif (-not (Test-Path -LiteralPath $credFile)) {
  Set-LocalUser -Name $name -Password $secret
} else {
  $secret = (Import-Clixml -LiteralPath $credFile).Password
}
# Users only, never Administrators (groups by SID: their names depend on the language).
$users = Get-LocalGroup -SID 'S-1-5-32-545'
if (-not (Get-LocalGroupMember -Group $users | Where-Object { $_.SID -eq $user.SID })) {
  Add-LocalGroupMember -Group $users -Member $user
}
$admins = Get-LocalGroup -SID 'S-1-5-32-544'
if (Get-LocalGroupMember -Group $admins | Where-Object { $_.SID -eq $user.SID }) {
  throw "$name is an administrator: remove it from that group first"
}
# The credential, for this account on this machine only.
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $credFile) | Out-Null
New-Object System.Management.Automation.PSCredential ($name, $secret) | Export-Clixml -LiteralPath $credFile
icacls $credFile /inheritance:r /grant:r "$($env:USERDOMAIN)\\$($env:USERNAME):F" | Out-Null
# No direct network: every outbound connection of the crew user to anything but loopback.
$sid = $user.SID.Value
$rule = 'Studio crew ' + $name + ': no direct network'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;$sid)" -RemoteAddress @(${OUTSIDE.map(psQuote).join(', ')}) | Out-Null
foreach ($p in ${list(o.readPaths)}) {
  if (Test-Path -LiteralPath $p) { icacls $p /grant "\${name}:(OI)(CI)RX" /Q | Out-Null }
}
foreach ($p in ${list(o.writePaths)}) {
  New-Item -ItemType Directory -Force -Path $p | Out-Null
  icacls $p /grant "\${name}:(OI)(CI)M" /Q | Out-Null
}
Write-Output "Studio crew user $name is ready; start the worker again."
`;
}

// ---- Grants for one run ------------------------------------------------------------------------

export interface Grant {
  path: string;
  /** `M` modify (with inheritance for a directory), `R` read, `W` write (a file). */
  rights: 'M' | 'R' | 'W';
}

/** The `icacls` arguments of one grant. */
export function grantArgs(user: string, g: Grant): string[] {
  if (!CREW_USER_RE.test(user)) throw new Error(`not a crew user name: ${user}`);
  let dir = false;
  try {
    dir = lstatSync(g.path).isDirectory();
  } catch {
    dir = false;
  }
  const rights = g.rights === 'R' ? 'RX' : g.rights;
  return [g.path, '/grant', `${user}:${dir ? '(OI)(CI)' : ''}${rights}`, '/Q'];
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

/** Grants every place of a run to the crew user; the first failure refuses the launch. */
export async function grantAll(
  run: RunFile,
  user: string,
  grants: readonly Grant[],
): Promise<void> {
  for (const g of grants) {
    const r = await run('icacls', grantArgs(user, g));
    if (r.code !== 0) {
      throw new Error(`cannot open ${g.path} to the crew user ${user}: icacls exited ${r.code}`);
    }
  }
}

// ---- Starting a process as the crew user -------------------------------------------------------

/** The crew host (bin/studio-crew-host.mjs): runs as the crew user, starts and stops the crew. */
export const CREW_HOST_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'studio-crew-host.mjs',
);

/**
 * The PowerShell that starts `node <host> <spec>` as the crew user and prints its pid. The
 * credential is decrypted inside PowerShell; Studio never holds the password. The environment of
 * this PowerShell is the one the host gets.
 */
export function startScript(o: {
  credFile: string;
  node: string;
  host: string;
  spec: string;
  cwd: string;
}): string {
  // Start-Process joins -ArgumentList with spaces: each argument is quoted for the command line.
  const arg = (s: string) => {
    if (/["\p{Cc}]/u.test(s)) throw new Error(`refusing a path with quotes: ${JSON.stringify(s)}`);
    return psQuote(`"${s}"`);
  };
  return [
    "$ErrorActionPreference = 'Stop'",
    `$c = Import-Clixml -LiteralPath ${psQuote(o.credFile)}`,
    `$p = Start-Process -FilePath ${psQuote(o.node)} -ArgumentList @(${arg(o.host)}, ${arg(o.spec)}) -Credential $c -WorkingDirectory ${psQuote(o.cwd)} -WindowStyle Hidden -PassThru`,
    '[Console]::Out.Write($p.Id)',
  ].join('\n');
}

export interface HostSpec {
  mode: 'run' | 'probe';
  /** The control dir of the run: the stop file, the host's record, the probe result. */
  dir: string;
  /** run: what to start, where, its prompt on stdin and the log it appends to. */
  cmd?: string;
  args?: string[];
  cwd?: string;
  prompt?: string;
  log?: string;
  /** probe: what must hold for the crew user. */
  probe?: ProbeSpec;
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
}

/** Where the control dir of a run lies: beside the crew's tmp dir, `tmp/<id>.host`. */
export const hostDirOf = (stateRoot: string, id: string): string =>
  join(stateRoot, 'tmp', `${id}.host`);

interface HostRecord {
  pid: number;
  nonce: string;
}

function readHostRecord(dir: string): HostRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8')) as Partial<HostRecord>;
    return typeof raw.pid === 'number' && typeof raw.nonce === 'string'
      ? { pid: raw.pid, nonce: raw.nonce }
      : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts the host as the crew user and returns its pid (the process Studio records). */
async function startHost(o: {
  run: RunFile;
  credFile: string;
  node: string;
  spec: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<number> {
  const script = startScript({
    credFile: o.credFile,
    node: o.node,
    host: CREW_HOST_BIN,
    spec: o.spec,
    cwd: o.cwd,
  });
  const r = await o.run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { env: o.env, timeoutMs: 120_000 },
  );
  const pid = Number(r.stdout.trim());
  if (r.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `cannot start a process as the crew user (powershell exited ${r.code}): ${r.stderr.split(/\r?\n/)[0] ?? ''}`,
    );
  }
  return pid;
}

/**
 * Claude Code for crews of this worker, started as the crew user through the host. `alive` and
 * `stop` work on the host's pid; the host stops its own tree when Studio writes `stop` in its
 * control dir, because the owner's account may not end processes of another user.
 */
export function windowsClaude(o: {
  stateRoot: string;
  credFile: string;
  claudeBin: string;
  run?: RunFile;
  node?: string;
}): Claude {
  const run = o.run ?? runFile;
  const node = o.node ?? process.execPath;
  const exists = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  /** The control dir whose host record names this pid. */
  const dirOf = (pid: number): string | undefined => {
    const tmp = join(o.stateRoot, 'tmp');
    let names: string[] = [];
    try {
      names = readdirSync(tmp).filter((n) => n.endsWith('.host'));
    } catch {
      return undefined;
    }
    return names.map((n) => join(tmp, n)).find((d) => readHostRecord(d)?.pid === pid);
  };
  return {
    async start(cwd, args, prompt, logPath, env) {
      const id =
        logPath
          .replace(/\\/g, '/')
          .split('/')
          .at(-1)
          ?.replace(/\.jsonl$/, '') ?? '';
      const dir = hostDirOf(o.stateRoot, id);
      const spec: HostSpec = {
        mode: 'run',
        dir,
        cmd: o.claudeBin,
        args,
        cwd,
        prompt,
        log: logPath,
      };
      const file = join(dir, 'spec.json');
      writeStateFile(o.stateRoot, file, JSON.stringify(spec));
      // The log exists before the crew user is granted it: the owner's file, appended by the host.
      closeSync(openSync(logPath, 'a'));
      const pid = await startHost({ run, credFile: o.credFile, node, spec: file, cwd, env });
      return { pid };
    },
    alive: exists,
    async identity(pid) {
      for (let i = 0; i < 50; i++) {
        const dir = dirOf(pid);
        const rec = dir === undefined ? undefined : readHostRecord(dir);
        if (rec !== undefined) return exists(pid) ? `host:${rec.nonce}` : undefined;
        if (!exists(pid)) return undefined;
        await sleep(200);
      }
      return undefined;
    },
    async stop(pid) {
      const dir = dirOf(pid);
      if (dir !== undefined) writeStateFile(o.stateRoot, join(dir, 'stop'), 'stop\n');
      for (let i = 0; i < 50 && exists(pid); i++) await sleep(200);
      if (exists(pid)) await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    },
  };
}

// ---- The probe ---------------------------------------------------------------------------------

export interface ProbeResult {
  check: string;
  ok: boolean;
  detail: string;
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

/** The checks a probe must report, every one of them. */
export const PROBE_CHECKS = ['user', 'admin', 'env', 'read', 'write', 'direct', 'proxy'];

/**
 * Starts the host in probe mode as the crew user, waits for its result and judges it. `run` and
 * `node` are seams for tests. Canaries: a file in the owner config dir (read) and the owner's home
 * (write); `mustNotRead` adds the worker's deny paths.
 */
export async function probeWindowsSandbox(o: {
  stateRoot: string;
  credFile: string;
  user: string;
  ownerHome: string;
  ownerConfigDir: string;
  mustNotRead: readonly string[];
  proxyPort: number;
  env: Record<string, string>;
  grant: (grants: Grant[]) => Promise<void>;
  run?: RunFile;
  node?: string;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const run = o.run ?? runFile;
  const dir = join(o.stateRoot, 'tmp', `probe-${randomBytes(4).toString('hex')}.host`);
  ensureStateDir(o.stateRoot, dir);
  const canary = join(o.ownerConfigDir, 'crew-probe-canary');
  writeStateFile(dirname(canary), canary, 'canary\n');
  try {
    const mark = randomBytes(8).toString('hex');
    const spec: HostSpec = {
      mode: 'probe',
      dir,
      probe: {
        user: o.user,
        mark,
        mustNotRead: [canary, o.ownerHome, ...o.mustNotRead],
        mustNotWrite: [join(o.ownerHome, `studio-probe-${mark}`)],
        direct: { host: 'github.com', port: 443 },
        proxy: { port: o.proxyPort, refused: 'example.invalid' },
      },
    };
    const file = join(dir, 'spec.json');
    writeStateFile(o.stateRoot, file, JSON.stringify(spec));
    await o.grant([{ path: dir, rights: 'M' }]);
    await startHost({
      run,
      credFile: o.credFile,
      node: o.node ?? process.execPath,
      spec: file,
      cwd: dir,
      env: { ...o.env, STUDIO_PROBE_MARK: mark },
    });
    const until = Date.now() + (o.timeoutMs ?? 60_000);
    const out = join(dir, 'probe.json');
    while (Date.now() < until && !existsSync(out)) await sleep(250);
    let results: ProbeResult[] | undefined;
    try {
      const raw = JSON.parse(readFileSync(out, 'utf8')) as unknown;
      results = Array.isArray(raw) ? (raw as ProbeResult[]) : undefined;
    } catch {
      results = undefined;
    }
    // Every check must be there: a host that left one out proves nothing about it.
    const missing = PROBE_CHECKS.find((c) => !(results ?? []).some((r) => r.check === c));
    if (results !== undefined && missing !== undefined) {
      return `the Windows crew sandbox could not be shown to hold here: the probe did not check ${missing}`;
    }
    return probeProblem(results);
  } finally {
    removeStateEntry(o.stateRoot, dir);
    removeStateEntry(dirname(canary), canary);
  }
}

// ---- The worker's side -------------------------------------------------------------------------

/** Where the crew user's credential lies, encrypted for the owner (DPAPI): the owner config dir. */
export const credFileIn = (ownerConfigDir: string): string =>
  join(ownerConfigDir, 'windows-crew.xml');

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

/** What the setup must open for reads: node, the Studio plugin, Claude Code, the toolchains. */
export function setupReadPaths(o: {
  node: string;
  claude: string | undefined;
  toolchains: readonly string[];
}): string[] {
  const plugin = resolve(dirname(CREW_HOST_BIN), '..');
  return [
    ...new Set([
      dirname(o.node),
      plugin,
      ...(o.claude === undefined ? [] : [dirname(o.claude)]),
      ...o.toolchains,
    ]),
  ];
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
 * crews as the crew user, the probe and the grants. `run` is a seam for tests.
 */
export async function windowsWorker(o: {
  user: string;
  stateRoot: string;
  ownerHome: string;
  ownerConfigDir: string;
  networkAllow: readonly string[];
  env: Record<string, string | undefined>;
  startProxy: (allow: readonly string[]) => Promise<{ port: number; close(): Promise<void> }>;
  run?: RunFile;
}): Promise<WindowsWorker> {
  const run = o.run ?? runFile;
  const credFile = credFileIn(o.ownerConfigDir);
  const path = o.env.PATH ?? o.env.Path;
  const claudeBin = findClaude(path);
  const proxy = await o.startProxy([...o.networkAllow, ...CLAUDE_HOSTS]);
  const grant = (grants: Grant[]) => grantAll(run, o.user, grants);
  const missing = (): string | undefined =>
    !existsSync(credFile)
      ? `no crew user credential at ${credFile}: run the script of studio worker windows-setup`
      : claudeBin === undefined
        ? 'claude is not on PATH'
        : undefined;
  return {
    claude: windowsClaude({
      stateRoot: o.stateRoot,
      credFile,
      claudeBin: claudeBin ?? 'claude',
      run,
    }),
    sandbox: {
      user: o.user,
      async probe(mustNotRead) {
        const why = missing();
        if (why !== undefined) return why;
        const tmp = ensureStateDir(o.stateRoot, join(o.stateRoot, 'tmp'));
        const probeEnv = windowsCrewEnv({
          proxyPort: proxy.port,
          homeDir: tmp,
          tmpDir: tmp,
          base: o.env,
        });
        return probeWindowsSandbox({
          stateRoot: o.stateRoot,
          credFile,
          user: o.user,
          ownerHome: o.ownerHome,
          ownerConfigDir: o.ownerConfigDir,
          mustNotRead,
          proxyPort: proxy.port,
          env: { ...probeEnv, PATH: path ?? '' },
          grant,
          run,
        });
      },
      launch: { user: o.user, proxyPort: proxy.port, grant },
    },
    close: () => proxy.close(),
  };
}
