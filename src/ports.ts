import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { execa } from 'execa';

export interface Gh {
  /**
   * `gh api <path> [--paginate] [--jq <jq>]`, returns stdout. Paginates by default (opt out with
   * `{ paginate: false }` for single-page reads); with `--jq` the filter runs per page, so use
   * filters that emit one line per record. Throws on a non-zero exit.
   */
  api(path: string, jq?: string, opts?: { paginate?: boolean }): Promise<string>;
  /** Runs `gh <args>` without throwing on a non-zero exit. */
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface Git {
  /** Runs `git <args>` in `cwd`, returns stdout. Throws on non-zero exit with stderr in the message. */
  run(cwd: string, args: string[]): Promise<string>;
}

export interface Claude {
  /** Starts a detached session; stdout and stderr are appended to `logPath`. */
  start(
    cwd: string,
    args: string[],
    prompt: string,
    logPath: string,
    env: Record<string, string>,
  ): Promise<{ pid: number }>;
  /** True while the session leader or any process of its group is running. */
  alive(pid: number): boolean;
  /**
   * What tells this process from a later one with a reused pid: its start time. Undefined when it
   * cannot be read, also when the pid has no process of its own. Never throws.
   */
  identity(pid: number): Promise<string | undefined>;
  /** SIGTERM, then SIGKILL after a grace period, sent to the whole process group (POSIX). */
  stop(pid: number): Promise<void>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface Host {
  loadAvg1(): number;
  /** Logical CPUs available to this process. */
  cpuCount(): number;
}

/** Everything that handles a credential value goes through here: nothing is logged or echoed. */
export interface Credentials {
  /**
   * Runs `command` without a shell and with exactly `env`; stderr is discarded. A timeout, a stdout
   * above `maxBytes` or a start failure come back as a non-zero `code`, never as an exception.
   */
  runProvider(
    command: string,
    env: Record<string, string>,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<{ code: number; stdout: string }>;
  /** `gh <args>` authenticated with `token` through `GH_TOKEN`, never through argv. */
  ghWithToken(
    token: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface Ports {
  gh: Gh;
  credentials: Credentials;
  git: Git;
  claude: Claude;
  clock: Clock;
  host: Host;
}

const STOP_GRACE_MS = 5000;
const STOP_POLL_MS = 100;
const IDENTITY_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function realPorts(claudeBin = 'claude'): Ports {
  const clock: Clock = { now: () => new Date(), sleep };

  const gh: Gh = {
    async api(path, jq, opts) {
      const args = [
        'api',
        path,
        ...(opts?.paginate === false ? [] : ['--paginate']),
        ...(jq === undefined ? [] : ['--jq', jq]),
      ];
      const r = await execa('gh', args);
      return r.stdout;
    },
    async run(args) {
      const r = await execa('gh', args, { reject: false });
      return { code: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
  };

  const git: Git = {
    async run(cwd, args) {
      const r = await execa('git', args, { cwd, reject: false });
      if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${r.exitCode}): ${r.stderr}`);
      }
      return r.stdout;
    },
  };

  const probe = (target: number): boolean => {
    try {
      process.kill(target, 0);
      return true;
    } catch (e) {
      // EPERM: the process exists but belongs to someone else.
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  // Sessions are started detached, so the child leads its own process group (POSIX). `alive` is true
  // while the leader or any member of that group (shells, tools, MCP servers) is still running.
  const posix = process.platform !== 'win32';
  const alive = (pid: number): boolean => (posix && probe(-pid)) || probe(pid);
  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(posix ? -pid : pid, sig);
    } catch (e) {
      if (!posix || (e as NodeJS.ErrnoException).code !== 'ESRCH') return;
      // Not a group leader after all: signal the process itself.
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };

  const claude: Claude = {
    async start(cwd, args, prompt, logPath, env) {
      const fd = openSync(logPath, 'a');
      try {
        // Plain spawn: execa's typings do not cover raw file descriptors for a detached child.
        const child = spawn(claudeBin, args, {
          cwd,
          env,
          detached: true,
          stdio: ['pipe', fd, fd],
        });
        const pid = await new Promise<number>((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', () => resolve(child.pid as number));
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(prompt);
        child.unref();
        return { pid };
      } finally {
        closeSync(fd);
      }
    },
    alive,
    async identity(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      // Locale and zone are pinned: a changed setting must not read as another process.
      const r = await execa('ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { LC_ALL: 'C', TZ: 'UTC' },
        reject: false,
        stdin: 'ignore',
        timeout: IDENTITY_TIMEOUT_MS,
      });
      const text = r.failed ? '' : String(r.stdout).trim();
      return text === '' ? undefined : text;
    },
    async stop(pid) {
      if (!alive(pid)) return;
      signal(pid, 'SIGTERM');
      for (let waited = 0; waited < STOP_GRACE_MS; waited += STOP_POLL_MS) {
        await sleep(STOP_POLL_MS);
        if (!alive(pid)) return;
      }
      signal(pid, 'SIGKILL');
    },
  };

  const host: Host = {
    loadAvg1: () => loadavg()[0] ?? 0,
    cpuCount: () => availableParallelism(),
  };
  const credentials: Credentials = {
    async runProvider(command, env, opts) {
      const child = execa(command, [], {
        env,
        extendEnv: false,
        shell: false,
        reject: false,
        stdin: 'ignore',
        stderr: 'ignore',
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBytes,
        forceKillAfterDelay: 1000,
      });
      // A grandchild holding stdout open must not outlive the timeout: that counts as a failure.
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<{ code: number; stdout: string }>((resolve) => {
        timer = setTimeout(() => resolve({ code: 1, stdout: '' }), opts.timeoutMs + 2000);
        timer.unref();
      });
      const run = child.then((r) => ({
        code: r.failed ? r.exitCode || 1 : 0,
        stdout: r.failed ? '' : String(r.stdout ?? ''),
      }));
      try {
        return await Promise.race([run, late]);
      } finally {
        clearTimeout(timer);
      }
    },
    async ghWithToken(token, args) {
      // GH_HOST is pinned: the token never goes to a host named by the environment.
      const r = await execa('gh', args, {
        env: { GH_TOKEN: token, GH_HOST: 'github.com' },
        reject: false,
        stdin: 'ignore',
      });
      return { code: r.exitCode ?? 1, stdout: String(r.stdout), stderr: String(r.stderr) };
    },
  };
  return { gh, git, claude, clock, host, credentials };
}
