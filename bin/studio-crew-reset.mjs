// What a crew could leave in the crew user's profile to start in a later job, taken away by the
// crew user itself before every start of a relay crew (src/windows-sandbox.ts, mode `reset` of the
// crew host). Running as the crew user, it can reach no more than the crew could anyway: a link a
// crew planted leads nowhere it could not already change. Still, it never follows one: a link is
// removed as a link, a folder is never walked into or removed.
//
// Self-contained on purpose, like the crew host that loads it: no import of Studio's sources.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Empties a Startup folder of what starts with a logon: plain files and links go (a link as a
 * link, never what it points to); a folder is left and reported, as is `desktop.ini`. A Startup
 * folder that is itself a link is not touched at all.
 */
export function resetStartup(dir) {
  const removed = [];
  const left = [];
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return { removed, left };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { removed, left: [`${dir} is not a plain folder`] };
  }
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const e = lstatSync(p);
    if (e.isSymbolicLink()) {
      try {
        unlinkSync(p);
      } catch {
        rmdirSync(p);
      }
      removed.push(name);
    } else if (e.isFile()) {
      if (name.toLowerCase() === 'desktop.ini') continue;
      unlinkSync(p);
      removed.push(name);
    } else {
      left.push(name);
    }
  }
  return { removed, left };
}

const reg = (args) => {
  try {
    return execFileSync('reg', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

/** The value names `reg query` prints for a key. */
export function regValueNames(out) {
  return (out ?? '')
    .split(/\r?\n/)
    .map((l) => /^\s{4}(\S+)\s+REG_[A-Z_]+/.exec(l)?.[1])
    .filter((n) => n !== undefined);
}

/** The crew user's own registry: cmd's AutoRun, its environment values, its Run keys' values. */
export function resetRegistry() {
  const removed = [];
  if (
    reg(['delete', 'HKCU\\Software\\Microsoft\\Command Processor', '/v', 'AutoRun', '/f']) !==
    undefined
  ) {
    removed.push('AutoRun');
  }
  for (const n of regValueNames(reg(['query', 'HKCU\\Environment']))) {
    if (['TEMP', 'TMP'].includes(n.toUpperCase())) continue;
    if (reg(['delete', 'HKCU\\Environment', '/v', n, '/f']) !== undefined)
      removed.push(`Environment ${n}`);
  }
  for (const k of ['Run', 'RunOnce']) {
    const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\${k}`;
    for (const n of regValueNames(reg(['query', key]))) {
      if (reg(['delete', key, '/v', n, '/f']) !== undefined) removed.push(`${k} ${n}`);
    }
  }
  return removed;
}
