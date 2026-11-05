import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { execa } from 'execa';
import type { EvidenceRun, EvidenceRunner } from './ports.js';

/**
 * The sandbox for evidence commands. It uses the operating system primitives Claude Code's own
 * sandbox uses for crews (https://code.claude.com/docs/en/sandboxing): Seatbelt (`sandbox-exec`) on
 * macOS, bubblewrap (`bwrap`) on Linux. Crews get that sandbox from their Claude Code session; an
 * evidence command has no session, so Studio applies the same primitives itself. On a platform
 * without either, `unavailable` says why and no evidence command runs: such rules prove nothing.
 *
 * What it allows: reading the file system except the `hidden` paths (credentials, Claude config,
 * Studio's state), writing only below `writable`, no network, and on macOS no lookup of the
 * keychain services.
 */

const PROBE_MS = 10_000;
const KILL_GRACE_MS = 2000;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The real path of `p`, or of its nearest existing parent with the rest appended. */
function realOr(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(realOr(parent), abs.slice(parent.length + 1));
}

const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** A path Seatbelt's profile language can quote: no quote, backslash or control character. */
const quotable = (p: string): boolean => !/["\\\p{Cc}]/u.test(p);

/** The Seatbelt profile; undefined when a path cannot be written into it safely. */
export function seatbeltProfile(writable: string, hidden: readonly string[]): string | undefined {
  const w = realOr(writable);
  const all = [w, ...hidden.map(realOr)];
  if (!all.every(quotable)) return undefined;
  const q = (p: string) => `"${p}"`;
  // A hidden path that holds the writable one may not lose its metadata, or nothing below it
  // resolves (realpath reads every parent): those lose only their contents.
  const ancestors = all.slice(1).filter((h) => within(w, h));
  const others = all.slice(1).filter((h) => !within(w, h));
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(w)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
    ...(others.length === 0
      ? []
      : [`(deny file-read* ${others.map((h) => `(subpath ${q(h)})`).join(' ')})`]),
    ...(ancestors.length === 0
      ? []
      : [`(deny file-read-data ${ancestors.map((h) => `(subpath ${q(h)})`).join(' ')})`]),
    `(allow file-read* file-read-data (subpath ${q(w)}))`,
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))',
    '',
  ].join('\n');
}

/** The bubblewrap arguments before the command. */
export function bwrapArgs(cwd: string, writable: string, hidden: readonly string[]): string[] {
  const w = resolve(writable);
  const masks = hidden.flatMap((h) => {
    const p = resolve(h);
    let dir: boolean;
    try {
      dir = lstatSync(p).isDirectory();
    } catch {
      return [];
    }
    return dir ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p];
  });
  return [
    '--die-with-parent',
    '--new-session',
    '--unshare-net',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    ...masks,
    // After the masks: the run dir lies inside the hidden state.
    '--bind',
    w,
    w,
    '--chdir',
    resolve(cwd),
    '--',
  ];
}

async function probe(file: string, args: string[]): Promise<boolean> {
  try {
    const r = await execa(file, args, { reject: false, stdin: 'ignore', timeout: PROBE_MS });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

let availability: Promise<string | undefined> | undefined;

/** Why commands cannot run sandboxed on this machine; undefined when they can. Read once. */
function sandboxUnavailable(): Promise<string | undefined> {
  availability ??= (async () => {
    if (process.platform === 'darwin') {
      return (await probe(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']))
        ? undefined
        : 'sandbox-exec does not run here';
    }
    if (process.platform === 'linux') {
      return (await probe('bwrap', [
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--unshare-net',
        'true',
      ]))
        ? undefined
        : 'bwrap (bubblewrap) is missing or cannot create a namespace here';
    }
    return `no sandbox for evidence commands on ${process.platform}`;
  })();
  return availability;
}

/** Spawns in a process group of its own; a timeout or too much output kills the whole group. */
function runGroup(
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; maxBytes: number },
): Promise<EvidenceRun> {
  return new Promise((done) => {
    let settled = false;
    const finish = (r: EvidenceRun) => {
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
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      finish({ kind: 'failed', why: `cannot start: ${(e as Error).message}` });
      return;
    }
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone already
      }
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length;
      if (size > opts.maxBytes) {
        tooLarge = true;
        killGroup();
        return;
      }
      chunks.push(b);
    });
    const timer = setTimeout(() => {
      killGroup();
      finish({ kind: 'failed', why: `timed out after ${Math.round(opts.timeoutMs / 1000)} s` });
    }, opts.timeoutMs);
    // A grandchild that left the group and holds stdout open must not hold the run.
    const hard = setTimeout(
      () => finish({ kind: 'failed', why: 'did not end' }),
      opts.timeoutMs + KILL_GRACE_MS,
    );
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

export const realEvidence: EvidenceRunner = {
  unavailable: sandboxUnavailable,
  async extract(tarFile, dest) {
    await execa('tar', ['-xf', tarFile, '-C', dest], { stdin: 'ignore', timeout: 300_000 });
  },
  async run(argv, opts) {
    const why = await sandboxUnavailable();
    if (why !== undefined) return { kind: 'failed', why };
    if (argv.length === 0) return { kind: 'failed', why: 'no command' };
    const o = {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
    };
    if (process.platform === 'darwin') {
      const profile = seatbeltProfile(opts.writable, opts.hidden);
      if (profile === undefined) {
        return { kind: 'failed', why: 'a path cannot be written into the sandbox profile' };
      }
      return runGroup(SANDBOX_EXEC, ['-p', profile, ...argv], o);
    }
    return runGroup('bwrap', [...bwrapArgs(opts.cwd, opts.writable, opts.hidden), ...argv], o);
  },
};
