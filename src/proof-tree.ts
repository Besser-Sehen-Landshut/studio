import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

/**
 * A commit's tree, written out for a proof command (src/evidence.ts) exactly as git stores it:
 * listed with `git ls-tree` and each blob read with `git cat-file`, so nothing of
 * `.gitattributes` (export-ignore, export-subst, filters, line endings) applies. `git archive`
 * would honour those, and a pull request could make its extract differ from its tree. Only plain
 * files (100644, 100755) are written; a symbolic link, a submodule or another mode, a path that
 * leaves the tree or names `.git`, and a tree over the caps refuse the whole tree before anything
 * is written.
 */

export interface TreeCaps {
  /** Sum of the blob sizes. */
  maxBytes: number;
  maxFiles: number;
}

export interface TreeEntry {
  mode: string;
  oid: string;
  size: number;
  path: string;
}

/** Why a path may not be written below the tree dir; undefined when it may. */
function pathProblem(path: string): string | undefined {
  if (/\p{Cc}/u.test(path)) return 'a path with a control character';
  if (path.startsWith('/') || path.includes('\\')) return 'a path that is not plain';
  const parts = path.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'a path that leaves the tree';
  if (parts.some((s) => s.toLowerCase() === '.git')) return 'a path that names .git';
  return undefined;
}

/**
 * The entries of `git ls-tree -r -l -z --full-tree`, checked; why not when the tree holds anything
 * but plain files, or goes over the caps.
 */
export function parseTree(out: string, caps: TreeCaps): TreeEntry[] | string {
  const entries: TreeEntry[] = [];
  // A file system that ignores case (macOS) would write two such paths into one file.
  const folded = new Set<string>();
  let bytes = 0;
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (m === null) return 'a tree listing that cannot be read';
    const [, mode, type, oid, size, path] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (type === 'commit') return `a submodule (${JSON.stringify(path.slice(0, 120))})`;
    if (mode === '120000') return `a symbolic link (${JSON.stringify(path.slice(0, 120))})`;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      return `an entry of mode ${mode} (${JSON.stringify(path.slice(0, 120))})`;
    }
    const problem = pathProblem(path);
    if (problem !== undefined) return problem;
    const key = path.normalize('NFC').toLowerCase();
    if (folded.has(key)) return 'two paths that differ only in case';
    folded.add(key);
    bytes += Number(size);
    if (bytes > caps.maxBytes) return `more than ${Math.round(caps.maxBytes / 1024 / 1024)} MiB`;
    if (entries.length >= caps.maxFiles) return `more than ${caps.maxFiles} files`;
    entries.push({ mode, oid, size: Number(size), path });
  }
  return entries;
}

/**
 * Writes `entries` below `dest` with the blobs from one `git cat-file --batch` in `gitDir`. Every
 * blob must come back with the oid and size the listing named. Throws when git fails; the caller
 * treats that as a retry.
 */
export async function writeTree(
  gitDir: string,
  entries: readonly TreeEntry[],
  dest: string,
  timeoutMs: number,
): Promise<void> {
  if (entries.length === 0) return;
  const r = await execa('git', ['--no-replace-objects', 'cat-file', '--batch'], {
    cwd: gitDir,
    input: `${entries.map((e) => e.oid).join('\n')}\n`,
    encoding: 'buffer',
    maxBuffer: entries.reduce((n, e) => n + e.size + 128, 0),
    timeout: timeoutMs,
    stripFinalNewline: false,
  });
  const out = r.stdout as Uint8Array;
  let at = 0;
  for (const e of entries) {
    const nl = out.indexOf(0x0a, at);
    if (nl === -1) throw new Error('git cat-file ended early');
    const header = Buffer.from(out.subarray(at, nl)).toString('utf8');
    if (header !== `${e.oid} blob ${e.size}`) throw new Error(`git cat-file answered ${header}`);
    const body = out.subarray(nl + 1, nl + 1 + e.size);
    if (body.length !== e.size || out[nl + 1 + e.size] !== 0x0a) {
      throw new Error('git cat-file ended early');
    }
    const file = join(dest, e.path);
    mkdirSync(dirname(file), { recursive: true });
    // `wx`: never through something already there
    writeFileSync(file, body, { flag: 'wx', mode: e.mode === '100755' ? 0o755 : 0o644 });
    at = nl + 2 + e.size;
  }
}
