import { lstatSync } from 'node:fs';
import { realish } from './paths.js';

/**
 * The OS sandbox a cache refresh step runs in. A refresh is no Claude session, so Claude Code's
 * sandbox cannot wrap it; it uses the platform sandbox that sandbox runs crew shells under:
 * Seatbelt (`sandbox-exec`) on macOS, bubblewrap (`bwrap`) on Linux. Elsewhere there is none and a
 * refresh refuses.
 *
 * The read side is the crews' (`sandboxDenyRead`: the real home, every credential location and the
 * state base are denied, then only the build dir and the toolchain paths come back). Writes go only
 * to the build dir, minus the build clone's `.git`, which owner-side git reads on the next refresh.
 * Seatbelt and bubblewrap cannot filter by host name (Claude Code does that with a proxy), so a step
 * either has the network or none: only the fetch steps, which run no project code, have it.
 */
export interface BuildSandbox {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  /** Inside `allowWrite`, written by nobody. */
  denyWrite: string[];
  network: boolean;
}

/** Literal and real spelling of each path: Seatbelt matches real paths (`/private/var/...`). */
const spellings = (paths: readonly string[]): string[] => [
  ...new Set(paths.flatMap((p) => [p, realish(p)])),
];

/** A path inside an SBPL string literal; anything that would need escaping is refused. */
function sbplPath(p: string): string {
  if (/["\\\p{Cc}]/u.test(p))
    throw new Error(
      `refusing a sandbox path with quotes or control characters: ${JSON.stringify(p)}`,
    );
  return `"${p}"`;
}

const subpaths = (paths: readonly string[]): string =>
  paths.map((p) => `(subpath ${sbplPath(p)})`).join(' ');

/** The Seatbelt profile of a step. Later rules win over earlier ones. */
export function seatbeltProfile(box: BuildSandbox): string {
  const lines = ['(version 1)', '(allow default)'];
  if (!box.network) lines.push('(deny network*)');
  const deny = spellings(box.denyRead);
  const allow = spellings([...box.allowRead, ...box.allowWrite]);
  if (deny.length > 0) lines.push(`(deny file-read* ${subpaths(deny)})`);
  if (allow.length > 0) lines.push(`(allow file-read* ${subpaths(allow)})`);
  // Names and sizes along the way: tools resolve their paths; contents stay denied.
  lines.push('(allow file-read-metadata)');
  lines.push('(deny file-write*)');
  lines.push(
    `(allow file-write* ${subpaths(spellings(box.allowWrite))} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  );
  const frozen = spellings(box.denyWrite);
  if (frozen.length > 0) lines.push(`(deny file-write* ${subpaths(frozen)})`);
  return lines.join('\n');
}

const kindOf = (p: string): 'dir' | 'file' | undefined => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return undefined;
  }
};

/** The bubblewrap arguments of a step, before `--`. */
export function bwrapArgs(box: BuildSandbox, cwd: string): string[] {
  const args = ['--die-with-parent', '--new-session', '--unshare-pid'];
  if (!box.network) args.push('--unshare-net');
  args.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');
  for (const p of spellings(box.denyRead)) {
    const kind = kindOf(p);
    if (kind === 'dir') args.push('--tmpfs', p);
    else if (kind === 'file') args.push('--ro-bind', '/dev/null', p);
  }
  for (const p of spellings(box.allowRead)) if (kindOf(p)) args.push('--ro-bind', p, p);
  for (const p of spellings(box.allowWrite)) if (kindOf(p)) args.push('--bind', p, p);
  for (const p of spellings(box.denyWrite)) if (kindOf(p)) args.push('--ro-bind', p, p);
  args.push('--chdir', cwd);
  return args;
}

/** `cmd args` wrapped in the platform sandbox; undefined where Studio knows none. */
export function sandboxed(
  platform: NodeJS.Platform,
  box: BuildSandbox,
  cwd: string,
  cmd: string,
  args: string[],
): { cmd: string; args: string[] } | undefined {
  if (platform === 'darwin') {
    return { cmd: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(box), cmd, ...args] };
  }
  if (platform === 'linux') {
    return { cmd: 'bwrap', args: [...bwrapArgs(box, cwd), '--', cmd, ...args] };
  }
  return undefined;
}
