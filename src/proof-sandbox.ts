import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * The sandbox for proof commands (`proof: command` in studio.yaml, src/evidence.ts). A proof
 * command has no Claude Code session, so Studio applies the operating system primitives itself:
 * Seatbelt (`sandbox-exec`) on macOS, bubblewrap (`bwrap`) on Linux. Anywhere else, or when the
 * tool is missing or cannot start, `unavailable` says why and no command runs: the rule proves
 * nothing. A command never runs unsandboxed.
 *
 * Inside: no network (no sockets at all on macOS, an empty network namespace on Linux), the run
 * dir readable and only its `tmp` writable (HOME and TMPDIR point there), the system's programs and
 * libraries, and the owner's toolchain paths read-only. Not there: the home, other users' homes,
 * the shared temp dirs, the state root, the owner and Claude config, removable volumes, and on
 * Linux everything that is not mounted in explicitly (`/var`, `/run`, `/mnt`, `/opt`, ...). On
 * macOS the keychain and every other Mach service but a few for logging and user lookup are shut,
 * so the command cannot hand work to a process outside (LaunchServices, AppleEvents); it registers
 * no Mach service, uses no POSIX or System V IPC, and sees and signals no process outside its own
 * sandbox. The macOS profile allows by default and denies all of that explicitly (SECURITY.md
 * names what that leaves open). The command
 * gets a CPU-time and a file-size limit through `ulimit`, which its children inherit, a wall-clock
 * timeout that kills its whole process group, and a cap on what it prints.
 */

export interface SandboxPlan {
  /** The run dir, a real path outside the home and the state: readable, not writable. */
  run: string;
  /** The writable dir inside `run`: the command's HOME and TMPDIR. */
  tmp: string;
  /** Where the command starts, inside `run`. */
  cwd: string;
  /** Extra read-only dirs: the owner's toolchain paths, real paths. */
  read: readonly string[];
  /** Paths that stay unreadable on macOS besides the fixed ones: the home, state, configs. */
  deny: readonly string[];
}

export interface SandboxLimits {
  /** Wall clock: the process group is killed after it. */
  timeoutMs: number;
  /** CPU seconds of each process (`ulimit -t`), inherited by its children. */
  cpuSeconds: number;
  /** Bytes of stdout kept; beyond them the run is killed and `tooLarge`. */
  maxOutput: number;
  /** The largest file the command may write (`ulimit -f`). */
  maxFileBytes: number;
}

export type SandboxRun =
  | { kind: 'exited'; code: number; stdout: string; tooLarge: boolean }
  | { kind: 'timeout' }
  | { kind: 'failed'; why: string };

/** Runs proof commands sandboxed; the port tests replace. */
export interface ProofRunner {
  /** Why no command can run sandboxed here; undefined when one can. */
  unavailable(): Promise<string | undefined>;
  run(
    argv: readonly string[],
    env: Record<string, string>,
    plan: SandboxPlan,
    limits: SandboxLimits,
    /** Written to the command's fd 3 and closed: the one way a value reaches it unseen by the environment. */
    secret: string,
  ): Promise<SandboxRun>;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Where bubblewrap is looked for: fixed places, never the owner's PATH. */
const BWRAP = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
const KILL_GRACE_MS = 2000;
/** Exit code of the limit wrapper when `ulimit` refuses: the command did not run. */
export const LIMITS_REFUSED = 125;

const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The real path of `p`, or of its nearest existing parent with the rest appended. */
export function realOr(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(realOr(parent), basename(abs));
}

/** Every parent of `p` up to (not including) the root. */
const ancestors = (p: string): string[] => {
  const out: string[] = [];
  for (let d = dirname(p); d !== dirname(d); d = dirname(d)) out.push(d);
  return out;
};

/** A path Seatbelt's profile language can quote: absolute, no quote, backslash or control character. */
const quotable = (p: string): boolean => p.startsWith('/') && !/["\\\p{Cc}]/u.test(p);

/** Read by nobody inside, on macOS: homes, volumes, shared temp dirs, machine-wide settings. */
const MAC_DENY = [
  '/Users',
  '/Volumes',
  '/Library',
  '/opt',
  '/private/tmp',
  '/private/var/tmp',
  '/private/var/folders',
  '/private/var/root',
];
/** Let back in below MAC_DENY: developer tools (git, clang), frameworks, Homebrew and MacPorts. */
const MAC_SYSTEM_READ = [
  '/Library/Developer',
  '/Library/Frameworks',
  '/opt/homebrew',
  '/opt/local',
];
/** Mach services a command may look up: logging, notifications, user and group lookup. */
const MAC_MACH = [
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
];

/**
 * The Seatbelt profile for `plan`; undefined when a path cannot be written into it safely, or the
 * run dir lies where it should not (in a denied place other than a shared temp dir).
 */
export function seatbeltProfile(plan: SandboxPlan, home = homedir()): string | undefined {
  // Every path as given must be absolute: a relative one would resolve against Studio's cwd.
  if ([plan.run, plan.tmp, ...plan.read, ...plan.deny].some((p) => !p.startsWith('/'))) {
    return undefined;
  }
  const run = realOr(plan.run);
  const tmp = realOr(plan.tmp);
  if (!within(tmp, run)) return undefined;
  const read = [...plan.read.map(realOr), ...MAC_SYSTEM_READ.filter(existsSync)];
  const deny = [...new Set([...MAC_DENY, realOr(home), ...plan.deny.map(realOr)])];
  // The run dir lies in a shared temp dir, never in the home, the state or a config dir.
  const fenced = deny.filter((d) => !MAC_DENY.includes(d));
  if (fenced.some((d) => within(run, d) || within(d, run))) return undefined;
  if ([run, tmp, ...read, ...deny].some((p) => !quotable(p))) return undefined;
  const q = (p: string) => `"${p}"`;
  const subpaths = (ps: readonly string[]) => ps.map((p) => `(subpath ${q(p)})`).join(' ');
  // Their parents must resolve (realpath reads every one), without their contents.
  const parents = [...new Set([run, ...read].flatMap(ancestors))].filter((p) =>
    deny.some((d) => within(p, d)),
  );
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny mach-lookup)',
    `(allow mach-lookup ${MAC_MACH.map((n) => `(global-name ${q(n)})`).join(' ')})`,
    '(deny mach-register)',
    // Signals and process information only within the sandbox: the command and its children.
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '(deny ipc-posix*)',
    '(deny ipc-sysv*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(tmp)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))`,
    `(deny file-read* ${subpaths(deny)})`,
    ...(parents.length === 0
      ? []
      : [`(allow file-read-metadata ${parents.map((p) => `(literal ${q(p)})`).join(' ')})`]),
    `(allow file-read* ${subpaths([run, ...read])})`,
    '',
  ].join('\n');
}

/** System dirs bound read-only on Linux, when they exist; a symlink (merged /usr) stays one. */
const LINUX_SYSTEM = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc',
  '/nix',
];

/**
 * The bubblewrap arguments before the command. Nothing of the host is there but what is bound
 * here: the system dirs read-only, a fresh /proc, /dev and /tmp, the toolchain paths read-only,
 * the run dir read-only and its tmp writable. New namespaces of every kind (no network), no
 * capabilities, a new session (no terminal injection), and the whole tree dies with Studio.
 * Undefined when the tmp dir is not inside the run dir.
 */
export function bwrapArgs(
  plan: SandboxPlan,
  probe: (p: string) => 'dir' | 'link' | 'missing' = probeDir,
  link: (p: string) => string = readlinkSync,
): string[] | undefined {
  if ([plan.run, plan.tmp, plan.cwd, ...plan.read].some((p) => !p.startsWith('/'))) {
    return undefined;
  }
  const run = resolve(plan.run);
  const tmp = resolve(plan.tmp);
  if (!within(tmp, run)) return undefined;
  const system = LINUX_SYSTEM.flatMap((d) => {
    const kind = probe(d);
    if (kind === 'missing') return [];
    return kind === 'link' ? ['--symlink', link(d), d] : ['--ro-bind', d, d];
  });
  return [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--cap-drop',
    'ALL',
    ...system,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...plan.read.flatMap((r) => ['--ro-bind', resolve(r), resolve(r)]),
    '--ro-bind',
    run,
    run,
    '--bind',
    tmp,
    tmp,
    '--chdir',
    resolve(plan.cwd),
    '--',
  ];
}

function probeDir(p: string): 'dir' | 'link' | 'missing' {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return 'link';
    return st.isDirectory() ? 'dir' : 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * The command behind its limits: a POSIX shell sets the CPU time and file size and replaces itself
 * with the command, which never passes through a shell. When `ulimit` refuses, it exits with
 * LIMITS_REFUSED and the command does not run.
 */
export function limitedArgv(argv: readonly string[], limits: SandboxLimits): string[] {
  const blocks = Math.max(1, Math.floor(limits.maxFileBytes / 1024));
  return [
    '/bin/sh',
    '-c',
    `ulimit -t "$1" && ulimit -f "$2" || exit ${LIMITS_REFUSED}; shift 2; exec "$@"`,
    'sh',
    String(Math.max(1, Math.ceil(limits.cpuSeconds))),
    String(blocks),
    ...argv,
  ];
}

/** System program dirs on the sandbox's PATH, after the toolchain paths. */
const SYSTEM_PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];
/** The names `vars` may add to a proof command's environment. */
const PROOF_VAR = /^STUDIO_PROOF_[A-Z_]+$/;

/**
 * The whole environment of a proof command, an allow-list: PATH (each toolchain path and its
 * `bin`, then the system dirs), HOME and TMPDIR in its tmp dir, a fixed locale and zone, and the
 * `STUDIO_PROOF_*` values. Nothing of Studio's own environment (tokens, the owner's PATH, proxies)
 * reaches it.
 */
export function proofEnv(
  read: readonly string[],
  tmp: string,
  vars: Record<string, string>,
): Record<string, string> {
  const path = [...read.flatMap((d) => [join(d, 'bin'), d]), ...SYSTEM_PATH];
  const env: Record<string, string> = {
    PATH: [...new Set(path)].join(':'),
    HOME: tmp,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
  };
  for (const [k, v] of Object.entries(vars)) {
    if (!PROOF_VAR.test(k)) throw new Error(`not a proof variable: ${k}`);
    env[k] = v;
  }
  return env;
}

/**
 * A run dir for one command: `run` (0700) in the system temp dir, with `tmp` inside, by real
 * paths. Never inside the home: a temp dir there falls back to /tmp.
 */
export function makeRunDir(home = homedir()): { run: string; tmp: string } {
  let base = realOr(tmpdir());
  if (within(base, realOr(home))) base = realOr('/tmp');
  const run = realpathSync(mkdtempSync(join(base, 'studio-proof-')));
  const tmp = join(run, 'tmp');
  mkdirSync(tmp, { mode: 0o700 });
  return { run, tmp };
}

/** What a platform needs to run sandboxed; the real one reads the machine, tests replace it. */
export interface SandboxHost {
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  /** Exit code of a short probe run, or undefined when it could not start. */
  probe(file: string, args: string[]): number | undefined;
}

const realHost: SandboxHost = {
  platform: process.platform,
  exists: existsSync,
  probe(file, args) {
    try {
      const r = spawnSync(file, args, {
        stdio: 'ignore',
        timeout: 10_000,
        env: { PATH: '/usr/bin:/bin' },
      });
      return r.error === undefined ? (r.status ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  },
};

/** The sandbox program and its arguments before the command; why not when there is none. */
export function sandboxFor(
  host: SandboxHost,
): { tool: string; wrap: (plan: SandboxPlan) => string[] | undefined } | { why: string } {
  if (host.platform === 'darwin') {
    if (!host.exists(SANDBOX_EXEC)) return { why: `${SANDBOX_EXEC} is missing` };
    return {
      tool: SANDBOX_EXEC,
      wrap: (plan) => {
        const profile = seatbeltProfile(plan);
        return profile === undefined ? undefined : ['-p', profile];
      },
    };
  }
  if (host.platform === 'linux') {
    const tool = BWRAP.find((p) => host.exists(p));
    if (tool === undefined) return { why: 'bubblewrap (bwrap) is not installed' };
    return { tool, wrap: (plan) => bwrapArgs(plan) };
  }
  return { why: `no sandbox for proof commands on ${host.platform}` };
}

/**
 * Why commands cannot run sandboxed on `host`; undefined when they can. The probe runs a real
 * plan, with the arguments a command would get, so a profile or option the tool rejects shows here.
 */
export function sandboxUnavailable(host: SandboxHost = realHost): string | undefined {
  const s = sandboxFor(host);
  if ('why' in s) return s.why;
  const { run, tmp } = makeRunDir();
  try {
    const args = s.wrap({ run, tmp, cwd: run, read: [], deny: [] });
    if (args === undefined) return 'the sandbox profile cannot be written';
    const code = host.probe(s.tool, [...args, '/bin/sh', '-c', 'exit 0']);
    if (code === undefined) return `${s.tool} does not start`;
    if (code !== 0) {
      return host.platform === 'linux'
        ? 'bwrap cannot create its namespaces here (unprivileged user namespaces may be off)'
        : `${s.tool} refuses the profile (exit ${code})`;
    }
    return undefined;
  } finally {
    removeRunDir(run);
  }
}

/** Removes a run dir; best effort. */
export function removeRunDir(run: string): void {
  try {
    spawnSync('/bin/rm', ['-rf', '--', run], { stdio: 'ignore', timeout: 60_000 });
  } catch {
    // a leftover in the temp dir holds no secret: an extract of two commits and the diff
  }
}

/** Spawns in a process group of its own; a timeout or too much output kills the whole group. */
function runGroup(
  file: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxOutput: number;
    secret: string;
  },
): Promise<SandboxRun> {
  return new Promise((done) => {
    let settled = false;
    const finish = (r: SandboxRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      done(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
      });
    } catch (e) {
      done({ kind: 'failed', why: `cannot start: ${(e as Error).message}` });
      return;
    }
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone already
      }
    };
    // The secret goes to fd 3 and the pipe is closed at once: the command reads it to the end,
    // and whatever it starts after that reads nothing there.
    const secretPipe = child.stdio[3] as import('node:stream').Writable | null;
    secretPipe?.on('error', () => {
      // the command closed fd 3 without reading: it gets no secret
    });
    secretPipe?.end(opts.secret);
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    child.stdout?.on('data', (b: Buffer) => {
      if (tooLarge) return;
      size += b.length;
      if (size > opts.maxOutput) {
        tooLarge = true;
        killGroup();
        return;
      }
      chunks.push(b);
    });
    const timer = setTimeout(() => {
      killGroup();
      finish({ kind: 'timeout' });
    }, opts.timeoutMs);
    // A grandchild that left the group and holds stdout open must not hold the run.
    const hard = setTimeout(() => finish({ kind: 'timeout' }), opts.timeoutMs + KILL_GRACE_MS);
    timer.unref();
    hard.unref();
    child.on('error', (e) => finish({ kind: 'failed', why: `cannot start: ${e.message}` }));
    child.on('close', (code, signal) => {
      // Once the command exited, nothing of its group may outlive it.
      killGroup();
      finish({
        kind: 'exited',
        code: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(chunks).toString('utf8'),
        tooLarge,
      });
    });
  });
}

let availability: Promise<string | undefined> | undefined;

/** The real runner: the machine's sandbox, probed once per process. */
export const realProofRunner: ProofRunner = {
  unavailable() {
    availability ??= Promise.resolve().then(() => sandboxUnavailable());
    return availability;
  },
  async run(argv, env, plan, limits, secret) {
    const why = await this.unavailable();
    if (why !== undefined) return { kind: 'failed', why: `no sandbox: ${why}` };
    if (argv.length === 0) return { kind: 'failed', why: 'no command' };
    const s = sandboxFor(realHost);
    if ('why' in s) return { kind: 'failed', why: `no sandbox: ${s.why}` };
    const args = s.wrap(plan);
    if (args === undefined) return { kind: 'failed', why: 'the sandbox profile cannot be written' };
    return runGroup(s.tool, [...args, ...limitedArgv(argv, limits)], {
      cwd: plan.cwd,
      env,
      timeoutMs: limits.timeoutMs,
      maxOutput: limits.maxOutput,
      secret,
    });
  },
};
