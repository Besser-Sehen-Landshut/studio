// The assets of a GitHub release of Studio (.github/workflows/release.yml): the bundle of the
// tagged commit (`studio-<version>.zip`, a git archive without tests and workflows) and the
// one-step setup of a Windows relay worker (`studio-relay-bootstrap.ps1`) with that version, the
// bundle's SHA-256 and the repository written in; `SHA256SUMS` of both, and `notes.md`, the section
// the workflow appends to the release notes.
//
//   node scripts/release-assets.mjs --tag v1.2.3 --repo owner/name --out <dir>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: { tag: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } },
});
const tag = values.tag ?? '';
const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
if (version === undefined) throw new Error(`--tag: v<major>.<minor>.<patch>, not ${tag}`);
const repo = values.repo ?? '';
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error('--repo: <owner>/<name>');
if (values.out === undefined) throw new Error('--out: a folder');
const out = values.out;
mkdirSync(out, { recursive: true });

const sha256 = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();

const bundle = join(out, `studio-${version}.zip`);
execFileSync(
  'git',
  [
    'archive',
    '--format=zip',
    '--prefix=studio/',
    '-o',
    bundle,
    tag,
    '--',
    '.',
    ':(exclude)test',
    ':(exclude).github',
  ],
  { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
);
const bundleSha = sha256(bundle);

const template = readFileSync(join(root, 'scripts', 'studio-relay-bootstrap.ps1'), 'utf8');
const bootstrap = join(out, 'studio-relay-bootstrap.ps1');
const filled = template
  .replaceAll('__STUDIO_VERSION__', version)
  .replaceAll('__STUDIO_BUNDLE_SHA256__', bundleSha)
  .replaceAll('__STUDIO_REPOSITORY__', repo);
if (/__STUDIO_[A-Z0-9_]+__/.test(filled)) throw new Error('a placeholder of the bootstrap is left');
// Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page: the script stays ASCII.
if (/[^\t\n\r -~]/.test(filled)) throw new Error('the bootstrap must be ASCII');
writeFileSync(bootstrap, filled.replace(/\r?\n/g, '\r\n'));
const bootstrapSha = sha256(bootstrap);

writeFileSync(
  join(out, 'SHA256SUMS'),
  `${bundleSha.toLowerCase()}  studio-${version}.zip\n${bootstrapSha.toLowerCase()}  studio-relay-bootstrap.ps1\n`,
);
const base = `https://github.com/${repo}/releases/download/${tag}`;
writeFileSync(
  join(out, 'notes.md'),
  `
### Windows relay worker in one line

On the lead: \`studio relay pair <label> <host>\`. On the Windows PC, in an elevated PowerShell (at the PC or over remote desktop, never over SSH):

\`\`\`powershell
& ([scriptblock]::Create((irm ${base}/studio-relay-bootstrap.ps1))) -Pair '<the line studio relay pair printed>'
\`\`\`

| Asset | SHA-256 |
| --- | --- |
| \`studio-relay-bootstrap.ps1\` | \`${bootstrapSha}\` |
| \`studio-${version}.zip\` | \`${bundleSha}\` |

The bootstrap installs exactly this bundle: it refuses any other SHA-256.
`,
);
process.stdout.write(`${bundle}\n${bootstrap}\n`);
