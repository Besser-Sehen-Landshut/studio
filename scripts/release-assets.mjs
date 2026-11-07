// The assets of a GitHub release of Studio (.github/workflows/release.yml): the bundle of the
// tagged commit (`studio-<version>.zip`: exactly the runtime paths of the plugin, as
// src/relay-bootstrap.ts BUNDLE_PATHS names them) and the one-step setup of a Windows relay worker
// (`studio-relay-bootstrap.ps1`, the template with the version and the repository filled in, so a
// lead of that version can tell its exact bytes). `SHA256SUMS` and `notes.md` give the hashes for
// reference only: the PC trusts what the lead's own Studio expects, never the release.
//
//   node scripts/release-assets.mjs --tag v1.2.3 --repo owner/name --out <dir>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Must equal BUNDLE_PATHS of src/relay-bootstrap.ts (a test holds them together). */
export const BUNDLE_PATHS = [
  '.claude-plugin',
  'bin',
  'capabilities',
  'dist-bundle',
  'hooks',
  'schema',
  'skills',
  'package.json',
  'LICENSE',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    tag: { type: 'string' },
    repo: { type: 'string' },
    out: { type: 'string' },
    // The commit to build from; the tag by default (tests build HEAD under a made-up version).
    commit: { type: 'string' },
  },
});
const tag = values.tag ?? '';
const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
if (version === undefined) throw new Error(`--tag: v<major>.<minor>.<patch>, not ${tag}`);
const repo = values.repo ?? '';
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error('--repo: <owner>/<name>');
if (values.out === undefined) throw new Error('--out: a folder');
const out = values.out;
mkdirSync(out, { recursive: true });

const rev = values.commit ?? tag;
const sha256 = (data) => createHash('sha256').update(data).digest('hex').toUpperCase();
const git = (args, o = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30, ...o });

const bundle = join(out, `studio-${version}.zip`);
git(['archive', '--format=zip', '--prefix=studio/', '-o', bundle, rev, '--', ...BUNDLE_PATHS], {
  stdio: ['ignore', 'inherit', 'inherit'],
});

// The tree digest of the tag's runtime paths, as the lead and the bootstrap compute it.
const files = git(['ls-tree', '-r', '-z', '--name-only', rev, '--', ...BUNDLE_PATHS], {
  encoding: 'utf8',
})
  .split('\0')
  .filter((f) => f !== '')
  .sort();
const tree = sha256(
  `paths: ${BUNDLE_PATHS.join(',')}\n` +
    files
      .map((f) => `${sha256(git(['cat-file', 'blob', `${rev}:${f}`])).toLowerCase()}  ${f}\n`)
      .join(''),
);

// The template of the tag, filled as src/relay-bootstrap.ts fillBootstrap does it.
const template = git(['show', `${rev}:scripts/studio-relay-bootstrap.ps1`], { encoding: 'utf8' });
const filled = template
  .replaceAll('__STUDIO_VERSION__', version)
  .replaceAll('__STUDIO_REPOSITORY__', repo);
if (/__STUDIO_[A-Z0-9_]+__/.test(filled)) throw new Error('a placeholder of the bootstrap is left');
// Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page: the script stays ASCII.
if (/[^\t\n\r -~]/.test(filled)) throw new Error('the bootstrap must be ASCII');
const bootstrapText = filled.replace(/\r?\n/g, '\r\n');
const bootstrap = join(out, 'studio-relay-bootstrap.ps1');
writeFileSync(bootstrap, bootstrapText);
const bootstrapSha = sha256(Buffer.from(bootstrapText, 'utf8'));
const bundleSha = sha256(readFileSync(bundle));

writeFileSync(
  join(out, 'SHA256SUMS'),
  `${bundleSha.toLowerCase()}  studio-${version}.zip\n${bootstrapSha.toLowerCase()}  studio-relay-bootstrap.ps1\n`,
);
writeFileSync(join(out, 'tree-digest.txt'), `${tree}\n`);
writeFileSync(
  join(out, 'notes.md'),
  `
### Windows relay worker in one line

On the lead (Studio ${version}): \`studio relay pair <label> <host>\` prints the line for the PC. It downloads \`studio-relay-bootstrap.ps1\` of this release and runs it only when its SHA-256 is the one the lead's own Studio expects, and the bootstrap installs the bundle only when its tree digest is the one the lead's Studio has: what this release says about itself is not trusted.

For reference (a lead of this version computes the same values from its own files):

| | SHA-256 |
| --- | --- |
| \`studio-relay-bootstrap.ps1\` | \`${bootstrapSha}\` |
| tree digest of the bundle | \`${tree}\` |
| \`studio-${version}.zip\` | \`${bundleSha}\` |
`,
);
process.stdout.write(`${bundle}\n${bootstrap}\n`);
