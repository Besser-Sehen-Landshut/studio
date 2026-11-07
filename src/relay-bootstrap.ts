// The trust anchor of the one-step setup of a Windows relay worker (scripts/studio-relay-bootstrap.ps1).
// A hash taken from a release says nothing the release could not fake, so both values the PC checks
// come from the lead's own Studio, which arrived through the plugin's git channel:
// - the SHA-256 of the bootstrap script: the release fills only the version and the repository into
//   the template, so the lead fills its own copy the same way and knows the exact bytes;
// - the tree digest of the bundle: the SHA-256 of `<sha256>  <path>` lines, sorted by path, over a
//   fixed list of the plugin's runtime paths. The release bundle holds exactly these paths; the lead
//   computes the digest over its installed plugin, the bootstrap over what it unpacked, and refuses
//   anything else.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_REPOSITORY, STUDIO_VERSION } from './plugins.js';

/** The paths of the plugin a relay worker runs, and nothing else: what the release bundle holds. */
export const BUNDLE_PATHS: readonly string[] = [
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

const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex').toUpperCase();

/**
 * The released bootstrap from its template: the version and the repository filled in, ASCII, CRLF
 * line ends. The release workflow and the lead fill it the same way (scripts/release-assets.mjs
 * does it in plain JavaScript; a test holds the two to the same bytes).
 */
export function fillBootstrap(template: string, version: string, repo: string): string {
  const filled = template
    .replaceAll('__STUDIO_VERSION__', version)
    .replaceAll('__STUDIO_REPOSITORY__', repo);
  if (/__STUDIO_[A-Z0-9_]+__/.test(filled))
    throw new Error('a placeholder of the bootstrap is left');
  if (/[^\t\n\r -~]/.test(filled)) throw new Error('the bootstrap must be ASCII');
  return filled.replace(/\r?\n/g, '\r\n');
}

/** Every file below `root` within `BUNDLE_PATHS`, as `/`-separated paths; links never followed. */
function bundleFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, ...rel.split('/'));
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) throw new Error(`${rel} is a link: refusing to hash it`);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) walk(`${rel}/${name}`);
    } else if (st.isFile()) out.push(rel);
  };
  for (const p of BUNDLE_PATHS) walk(p);
  return out.sort();
}

/** A path segment the bootstrap takes: plain characters only (the zip check, src and PS alike). */
export const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** Windows device names, with or without an extension: never a file name of the bundle. */
export const DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * The tree digest of a plugin folder (the lead's installed Studio, or an unpacked bundle): the
 * SHA-256 of `paths: <the bundle paths>` and then one line `<sha256>  <path>` per file, sorted by
 * path (ordinal, `/` between segments). Every bundle path must be there.
 */
export function treeDigest(root: string): string {
  for (const p of BUNDLE_PATHS) {
    try {
      lstatSync(join(root, p));
    } catch {
      throw new Error(`${p} is missing in ${root}: not a complete Studio`);
    }
  }
  const lines = bundleFiles(root).map(
    (rel) => `${sha256(readFileSync(join(root, ...rel.split('/')))).toLowerCase()}  ${rel}\n`,
  );
  return sha256(`paths: ${BUNDLE_PATHS.join(',')}\n${lines.join('')}`);
}

/** The plugin folder this Studio runs from. */
const pluginRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The two values the PC checks, from this Studio's own files. */
export function leadAnchor(
  root = pluginRoot(),
  version = STUDIO_VERSION,
  repo = STUDIO_REPOSITORY,
): { bootstrapSha: string; tree: string } {
  const template = readFileSync(join(root, 'scripts', 'studio-relay-bootstrap.ps1'), 'utf8');
  return { bootstrapSha: sha256(fillBootstrap(template, version, repo)), tree: treeDigest(root) };
}

/**
 * The one line for the PC: it downloads the bootstrap of this Studio's release, runs it only when
 * its SHA-256 is the one this Studio expects (compared on the hex, case-insensitively), and hands it
 * the tree digest the bundle must have. `pair`: the pairing line; without it, `-Uninstall`.
 */
export function bootstrapCommand(
  o: { pair: string } | { uninstall: true },
  anchor = leadAnchor(),
  version = STUDIO_VERSION,
  repo = STUDIO_REPOSITORY,
  /** Where the bootstrap lies; the release by default (tests give a file URL). */
  url = `https://github.com/${repo}/releases/download/v${version}/studio-relay-bootstrap.ps1`,
): string {
  const args = 'pair' in o ? `-Pair '${o.pair}'` : '-Uninstall';
  // TLS 1.2 first; the raw bytes are hashed before anything decodes them.
  return `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; $b = (Invoke-WebRequest -UseBasicParsing -Uri '${url}').RawContentStream.ToArray(); if ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-', '') -ne '${anchor.bootstrapSha}') { throw 'this is not the bootstrap of Studio ${version} the lead runs: nothing was run' }; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($b))) ${args} -Tree '${anchor.tree}'`;
}
