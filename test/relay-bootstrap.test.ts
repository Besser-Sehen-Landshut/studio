// The one-step setup of a Windows relay worker and its trust anchor: the release assets (bundle of
// the runtime paths, bootstrap with only the version and the repository filled in), the values the
// lead computes from its own Studio (the bootstrap's SHA-256, the tree digest), the line `relay
// pair` prints, the release workflow, and on the elevated windows-latest job the one-liner and the
// bootstrap itself.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LOOPBACK } from '../src/egress-proxy.js';

const execFileAsync = promisify(execFile);

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STUDIO_REPOSITORY, STUDIO_VERSION } from '../src/plugins.js';
import {
  BUNDLE_PATHS,
  bootstrapCommand,
  DEVICE_RE,
  fillBootstrap,
  leadAnchor,
  SEGMENT_RE,
  treeDigest,
} from '../src/relay-bootstrap.js';
import { renderPairLine } from '../src/relay-pair.js';
import { powershellEnv } from '../src/windows-sandbox.js';

const repoRoot = join(import.meta.dirname, '..');
const work = realpathSync(mkdtempSync(join(tmpdir(), 'studio-bootstrap-')));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const template = readFileSync(join(repoRoot, 'scripts', 'studio-relay-bootstrap.ps1'), 'utf8');
const sha = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex').toUpperCase();

/** The assets of HEAD under a made-up version, as the release workflow builds them for a tag. */
const VERSION = '9.9.9';
const assets = (() => {
  const out = join(work, 'assets');
  execFileSync(
    process.execPath,
    [
      join(repoRoot, 'scripts', 'release-assets.mjs'),
      '--tag',
      `v${VERSION}`,
      '--commit',
      'HEAD',
      '--repo',
      'owner/name',
      '--out',
      out,
    ],
    { cwd: repoRoot },
  );
  const zip = join(out, `studio-${VERSION}.zip`);
  const unpacked = join(work, 'unpacked');
  mkdirSync(unpacked);
  // bsdtar (Windows) reads a zip; elsewhere unzip.
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', unpacked]);
  else execFileSync('unzip', ['-q', zip, '-d', unpacked]);
  return {
    out,
    zip,
    unpacked: join(unpacked, 'studio'),
    bootstrap: join(out, 'studio-relay-bootstrap.ps1'),
    tree: readFileSync(join(out, 'tree-digest.txt'), 'utf8').trim(),
  };
})();

describe('the bootstrap template', () => {
  it('is ASCII, refuses to run as the template, and names exactly the bundle paths', () => {
    expect(template).toMatch(/^[\t\n\r -~]*$/);
    expect(template).toContain("if ($version -like '__*') { Fail 'this is the template");
    const listed = /\$bundlePaths = @\(([^)]*)\)/.exec(template)?.[1] ?? '';
    expect(listed.split(', ').map((x) => x.replace(/'/g, ''))).toEqual([...BUNDLE_PATHS]);
    const script = readFileSync(join(repoRoot, 'scripts', 'release-assets.mjs'), 'utf8');
    for (const p of BUNDLE_PATHS) expect(script).toContain(`'${p}',`);
    // Nothing of the bundle is written into the released script: the lead's values decide.
    expect(template).not.toMatch(/__STUDIO_BUNDLE_SHA256__|\$sha256/);
  });

  it('checks every zip entry before unpacking any, then the tree digest before running anything', () => {
    const checks = template.indexOf(
      'foreach ($e in $archive.Entries) {\n        $n = [string]$e.FullName',
    );
    const unpack = template.indexOf('$out = [IO.File]::Open($dest, [IO.FileMode]::CreateNew');
    const digest = template.indexOf('if ($digest -ne $Tree)');
    expect(checks).toBeGreaterThan(0);
    expect(unpack).toBeGreaterThan(checks);
    expect(digest).toBeGreaterThan(unpack);
    expect(template.indexOf('& $nodeExe $studio')).toBeGreaterThan(digest);
    for (const rule of [
      "$n.StartsWith('studio/', [StringComparison]::Ordinal)",
      "$seg -cnotmatch '^[A-Za-z0-9._-]+$' -or $seg.EndsWith('.') -or $seg -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$'",
      "if (($onDisk -join ',') -cne (@($bundlePaths | Sort-Object) -join ','))",
      "[void]$text.Append('paths: ' + ($bundlePaths -join ',') + \"`n\")",
      '-not ($bundlePaths -ccontains $parts[0])',
      'if ($mode -eq 0xA000)',
      "New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)",
      '[Array]::Sort($sorted, [StringComparer]::Ordinal)',
    ]) {
      expect(template, rule).toContain(rule);
    }
    expect(template).toContain("if (-not $DryRun -and $Tree -notmatch '^[0-9A-Fa-f]{64}$')");
  });

  it('checks elevation and the language mode itself, scrubs its pairing line, and gives Node.js a clean environment', () => {
    expect(template).toContain(
      "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage')",
    );
    expect(template).toContain('IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
    expect(template).toContain('(Get-PSReadLineOption -ErrorAction Stop).HistorySavePath');
    const clean = template.indexOf("$_.Name -like 'NODE_*' -or $_.Name -like 'npm_config_*'");
    expect(clean).toBeGreaterThan(0);
    expect(clean).toBeLessThan(template.indexOf('& $nodeExe $studio'));
    for (const v of ['ProgramFiles', 'ProgramData', 'ALLUSERSPROFILE', 'SystemRoot', 'windir']) {
      const at = template.indexOf(`$env:${v} = `);
      expect(at, v).toBeGreaterThan(0);
      expect(at, v).toBeLessThan(template.indexOf('& $nodeExe $studio'));
    }
  });

  it('every file of the bundle has a name the bootstrap takes', () => {
    const files = execFileSync('git', ['ls-files', '--', ...BUNDLE_PATHS], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f !== '');
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      for (const seg of f.split('/')) {
        expect(seg, f).toMatch(SEGMENT_RE);
        expect(seg.endsWith('.'), f).toBe(false);
        expect(DEVICE_RE.test(seg), f).toBe(false);
      }
    }
    expect(readFileSync(join(repoRoot, '.gitattributes'), 'utf8')).toContain(
      'scripts/studio-relay-bootstrap.ps1 text eol=lf',
    );
  });

  it('stages in an admin-only folder made before the download, never in TEMP; asks before winget; never over SSH', () => {
    expect(template).not.toMatch(/\$env:TEMP|\$env:TMP/i);
    const made = template.indexOf('[IO.Directory]::CreateDirectory($work, $acl)');
    expect(made).toBeGreaterThan(template.indexOf('$acl.SetAccessRuleProtection($true, $false)'));
    expect(made).toBeLessThan(template.indexOf('Invoke-WebRequest'));
    expect(template.indexOf('[IO.FileShare]::Read)')).toBeLessThan(
      template.indexOf('ComputeHash($fs)'),
    );
    expect(template.indexOf('$fs.Dispose()')).toBeGreaterThan(template.indexOf('$in.CopyTo($out)'));
    expect(template).toContain("$nodeExe = Join-Path $programFiles 'nodejs\\node.exe'");
    expect(template).toContain("$programFiles = [Environment]::GetFolderPath('ProgramFiles')");
    // Never read from the environment; only set (for Node.js) from the system's values.
    expect(template).not.toMatch(/\$env:(ProgramFiles|ProgramData|SystemRoot|windir)\b(?! = )/i);
    expect(template).not.toContain("GetEnvironmentVariable('Path', 'User')");
    expect(template).toContain('[IO.Directory]::Delete($work, $true)');
    expect(template).not.toMatch(/-Recurse/);
    expect(template.indexOf('Read-Host')).toBeLessThan(
      template.indexOf('& $wg install --id $id --exact --silent'),
    );
    expect(template).toContain("$x.Name -like 'sshd*'");
  });
});

describe('the release assets and the lead agree, from separate sources', () => {
  it('the released bootstrap is the template with version and repository, the bytes the lead computes', () => {
    const b = readFileSync(assets.bootstrap, 'utf8');
    expect(b).toContain(`$version = '${VERSION}'`);
    expect(b).toContain("$repo = 'owner/name'");
    expect(b).not.toMatch(/__STUDIO_/);
    expect(b).toBe(fillBootstrap(template, VERSION, 'owner/name'));
    const lead = leadAnchor(repoRoot, VERSION, 'owner/name');
    expect(sha(readFileSync(assets.bootstrap))).toBe(lead.bootstrapSha);
    const notes = readFileSync(join(assets.out, 'notes.md'), 'utf8');
    expect(notes).toContain(lead.bootstrapSha);
    expect(notes).toContain('is not trusted');
  });

  it("the bundle holds exactly the runtime paths; its tree digest is the lead's, whatever else the lead has", () => {
    const top = readdirSync(assets.unpacked).sort();
    expect(top).toEqual([...BUNDLE_PATHS].sort());
    expect(readdirSync(join(assets.unpacked, 'dist-bundle'))).toContain('studio.mjs');
    expect(treeDigest(assets.unpacked)).toBe(assets.tree);
    // The lead's Studio (this checkout, with src/, test/, node_modules beside the runtime paths). A
    // Windows checkout converts line ends, and the lead never runs on native Windows.
    if (process.platform !== 'win32') expect(leadAnchor(repoRoot).tree).toBe(assets.tree);
    // One changed byte anywhere in a runtime path is another digest.
    const changed = join(work, 'changed');
    cpSync(assets.unpacked, changed, { recursive: true });
    writeFileSync(
      join(changed, 'package.json'),
      `${readFileSync(join(changed, 'package.json'), 'utf8')} `,
    );
    expect(treeDigest(changed)).not.toBe(assets.tree);
  });

  it('the same commit gives the same bytes', () => {
    const again = join(work, 'again');
    execFileSync(
      process.execPath,
      [
        join(repoRoot, 'scripts', 'release-assets.mjs'),
        '--tag',
        `v${VERSION}`,
        '--commit',
        'HEAD',
        '--repo',
        'owner/name',
        '--out',
        again,
      ],
      { cwd: repoRoot },
    );
    expect(sha(readFileSync(join(again, `studio-${VERSION}.zip`)))).toBe(
      sha(readFileSync(assets.zip)),
    );
  });
});

describe('the line the lead prints', () => {
  const anchor = { bootstrapSha: 'A'.repeat(64), tree: 'b'.repeat(64) };
  it('checks the bootstrap by SHA-256 before it runs it, and hands it the tree digest', () => {
    const c = bootstrapCommand({ pair: 'studio-pair-2 lab x ssh-ed25519 AAAA' }, anchor);
    expect(c).toContain(
      `(Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/${STUDIO_REPOSITORY}/releases/download/v${STUDIO_VERSION}/studio-relay-bootstrap.ps1').RawContentStream.ToArray()`,
    );
    expect(c.startsWith('[Net.ServicePointManager]::SecurityProtocol = ')).toBe(true);
    expect(c).toContain('[Net.SecurityProtocolType]::Tls12');
    expect(c).toContain(
      `[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-', '') -ne '${anchor.bootstrapSha}'`,
    );
    expect(c.indexOf('ComputeHash($b)')).toBeLessThan(c.indexOf('[ScriptBlock]::Create'));
    expect(c).toContain(`-Pair 'studio-pair-2 lab x ssh-ed25519 AAAA' -Tree '${anchor.tree}'`);
    expect(bootstrapCommand({ uninstall: true }, anchor)).toContain(
      `-Uninstall -Tree '${anchor.tree}'`,
    );
  });
});

describe('the release workflow', () => {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')) as {
    on: Record<string, unknown>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<string, { 'runs-on': string; steps: { run?: string }[] }>;
  };
  it('runs on a GitHub-hosted runner when a release is published, and attaches both files', () => {
    expect(wf.on.release).toEqual({ types: ['published'] });
    for (const job of Object.values(wf.jobs)) expect(job['runs-on']).toBe('ubuntu-latest');
    const run = Object.values(wf.jobs)
      .flatMap((j) => j.steps.map((s) => s.run ?? ''))
      .join('\n');
    expect(run).toContain('node scripts/release-assets.mjs --tag "$TAG"');
    expect(run).toContain('studio-relay-bootstrap.ps1 SHA256SUMS --clobber');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
    expect(wf.concurrency.group).toMatch(/^release-/);
  });
});

// Elevated, on the windows-latest job: the one-liner and the bootstrap as released, without
// installing anything.
const elevated = process.platform === 'win32' && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';

describe.skipIf(!elevated)('the one-liner and the bootstrap on Windows', () => {
  const env = Object.fromEntries(
    Object.entries(powershellEnv(process.env)).filter(
      ([k]) => k.toLowerCase() !== 'psmodulepath' && !k.startsWith('SSH_'),
    ),
  );
  const ps = (args: string[], extra: Record<string, string> = {}) => {
    try {
      return {
        code: 0,
        out: execFileSync('powershell.exe', args, {
          encoding: 'utf8',
          env: { ...env, ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: `${x.stdout}${x.stderr}` };
    }
  };
  const pair = renderPairLine({
    label: 'lab',
    secret: 'a'.repeat(43),
    key: `ssh-ed25519 ${'A'.repeat(68)}`,
    deny: { hosts: ['nas.example'], ports: [5432], prefixes: [] },
  });

  it('the one-liner runs the downloaded script only when its SHA-256 is the expected one, upper or lower case', async () => {
    const text =
      '#Requires -RunAsAdministrator\r\n[CmdletBinding()]\r\nparam([string]$Pair, [string]$Tree, [switch]$Uninstall)\r\nWrite-Output "ran pair=$Pair tree=$Tree"\r\n';
    // A server on loopback stands in for the release; PowerShell runs asynchronously beside it.
    const server = createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'application/octet-stream' });
      r.end(text);
    });
    await new Promise<void>((done) => server.listen(0, LOOPBACK, done));
    const url = `http://${LOOPBACK}:${(server.address() as { port: number }).port}/studio-relay-bootstrap.ps1`;
    const ps = async (args: string[]) => {
      try {
        const r = await execFileAsync('powershell.exe', args, { encoding: 'utf8', env });
        return { code: 0, out: r.stdout };
      } catch (e) {
        const x = e as { code: number; stdout: string; stderr: string };
        return { code: x.code, out: `${x.stdout}${x.stderr}` };
      }
    };
    const right = { bootstrapSha: sha(text).toLowerCase(), tree: 'c'.repeat(64) };
    const ok = await ps([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      bootstrapCommand({ pair: 'p' }, right, '1.0.0', 'o/n', url),
    ]);
    expect(ok.out).toContain(`ran pair=p tree=${'c'.repeat(64)}`);
    const wrong = await ps([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      bootstrapCommand(
        { pair: 'p' },
        { ...right, bootstrapSha: 'D'.repeat(64) },
        '1.0.0',
        'o/n',
        url,
      ),
    ]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain('nothing was run');
    expect(wrong.out).not.toContain('ran pair');
    server.close();
  }, 60_000);

  // The runner's Node.js in Program Files is older than 24: a copy of the released bootstrap runs
  // with the job's Node.js and Git, so the steps after the checks are reached.
  const patched = () => {
    const file = join(work, 'bootstrap-here.ps1');
    const git = (
      execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0] as string
    ).trim();
    writeFileSync(
      file,
      readFileSync(assets.bootstrap, 'utf8')
        .replace(/^\$nodeExe = .*$/m, `$nodeExe = '${process.execPath.replace(/'/g, "''")}'`)
        .replace(/^\$gitExe = .*$/m, `$gitExe = '${git.replace(/'/g, "''")}'`),
    );
    return file;
  };
  const bootstrap = (args: string[], extra: Record<string, string> = {}, file = assets.bootstrap) =>
    ps(
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      extra,
    );
  const staged = () =>
    readdirSync(process.env.ProgramData ?? 'C:\\ProgramData').filter((f) =>
      f.startsWith('studio-bootstrap-'),
    );
  /** A zip made by PowerShell with these entries (name, and a link's attributes when given). */
  const zipOf = (name: string, entries: { name: string; link?: boolean }[]) => {
    const file = join(work, name);
    // One Add per entry: a single @(name, link) inside @() would be flattened into its parts.
    const list = entries
      .map(
        (e) =>
          `[void]$items.Add(@('${e.name.replace(/'/g, "''")}', ${e.link === true ? '$true' : '$false'}))`,
      )
      .join('\n');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression
$fs = [IO.File]::Create('${file}')
$z = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
$items = New-Object Collections.ArrayList
${list}
foreach ($e in $items) { $x = $z.CreateEntry($e[0]); if ($e[1]) { $x.ExternalAttributes = [int](0xA1FF -shl 16) }; $w = New-Object IO.StreamWriter($x.Open()); $w.Write('x'); $w.Dispose() }
$z.Dispose(); $fs.Dispose()`,
      ],
      { env },
    );
    return file;
  };

  it('a dry run names every step and changes nothing', () => {
    const r = bootstrap(['-Pair', pair, '-DryRun', '--source', 'fd7a::/48']);
    expect(r.out).toContain('[1/4] Node.js and Git for Windows');
    expect(r.out).toContain("check its tree digest against the lead's");
    expect(r.out).not.toContain(pair);
    expect(r.code).toBe(0);
  }, 120_000);

  it("refuses unsafe entries before unpacking any, and a bundle that is not the lead's Studio; the staging folder goes", () => {
    const before = staged().length;
    const file = patched();
    for (const [name, entries, said] of [
      ['dots.zip', [{ name: 'studio/bin/../../evil' }], 'unsafe path'],
      ['ads.zip', [{ name: 'studio/bin/studio:evil' }], 'unsafe path'],
      ['tilde.zip', [{ name: 'studio/bin/STUDIO~1' }], 'unsafe path'],
      ['dot.zip', [{ name: 'studio/bin/studio.' }], 'unsafe path'],
      ['device.zip', [{ name: 'studio/bin/aux.txt' }], 'unsafe path'],
      ['space.zip', [{ name: 'studio/bin/a b' }], 'unsafe path'],
      ['outside.zip', [{ name: 'evil.txt' }], 'outside studio/'],
      ['extra.zip', [{ name: 'studio/evil.txt' }], 'not part of Studio'],
      ['case.zip', [{ name: 'studio/bin/a' }, { name: 'studio/bin/A' }], 'differ only in case'],
      ['link.zip', [{ name: 'studio/bin/link', link: true }], 'holds a link'],
      ['other.zip', [{ name: 'studio/bin/studio' }], 'not exactly the paths of Studio'],
    ] as const) {
      const r = bootstrap(
        ['-Pair', pair, '-Tree', assets.tree, '-Bundle', zipOf(name, [...entries])],
        {},
        file,
      );
      expect(r.code, name).not.toBe(0);
      expect(r.out, name).toContain(said);
      expect(r.out, name).toContain('nothing was');
    }
    expect(staged().length).toBe(before);
  }, 300_000);

  it('refuses the real bundle when the lead expects another tree digest', () => {
    const r = bootstrap(
      ['-Pair', pair, '-Tree', 'ab'.repeat(32), '-Bundle', assets.zip],
      {},
      patched(),
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('is not the Studio');
    expect(r.out).toContain('nothing was run');
  }, 300_000);

  it("the real bundle with the lead's tree digest passes the checks and reaches relay install", () => {
    const r = bootstrap(
      ['-Pair', pair, '-Tree', assets.tree.toLowerCase(), '-Bundle', assets.zip],
      {},
      patched(),
    );
    expect(r.out).toContain(`ok: tree digest ${assets.tree}`);
    // Without a Tailscale interface and without --source the install itself stops, changing nothing.
    expect(r.out).toContain('no Tailscale interface here');
  }, 300_000);
});
