// The one-step setup of a Windows relay worker: the release assets (bundle, bootstrap with the
// bundle's SHA-256 written in), the release workflow that attaches them, the command `relay pair`
// prints, and on the elevated windows-latest job the bootstrap itself.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STUDIO_REPOSITORY, STUDIO_VERSION } from '../src/plugins.js';
import { bootstrapCommand } from '../src/relay-command.js';
import { powershellEnv } from '../src/windows-sandbox.js';

const repoRoot = join(import.meta.dirname, '..');
const work = realpathSync(mkdtempSync(join(tmpdir(), 'studio-bootstrap-')));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const template = readFileSync(join(repoRoot, 'scripts', 'studio-relay-bootstrap.ps1'), 'utf8');
/** A released tag that this checkout has (CI fetches all of them). */
const tag = (() => {
  try {
    return execFileSync('git', ['tag', '--list', 'v*.*.*', '--sort=-v:refname'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .find((t) => /^v\d+\.\d+\.\d+$/.test(t));
  } catch {
    return undefined;
  }
})();

const assets = (() => {
  if (tag === undefined) return undefined;
  const out = join(work, 'assets');
  execFileSync(
    process.execPath,
    [
      join(repoRoot, 'scripts', 'release-assets.mjs'),
      '--tag',
      tag,
      '--repo',
      'owner/name',
      '--out',
      out,
    ],
    { cwd: repoRoot },
  );
  const version = tag.slice(1);
  return {
    out,
    version,
    zip: join(out, `studio-${version}.zip`),
    bootstrap: join(out, 'studio-relay-bootstrap.ps1'),
  };
})();

const sha = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();

describe('the bootstrap template', () => {
  it('is ASCII and refuses to run as the template', () => {
    expect(template).toMatch(/^[\t\n\r -~]*$/);
    expect(template).toContain("if ($version -like '__*') { Fail 'this is the template");
  });

  it('checks the SHA-256 before it unpacks or runs anything, and asks before winget', () => {
    const check = template.indexOf('if ($got -ne $sha256)');
    expect(check).toBeGreaterThan(0);
    expect(template.indexOf('New-Object IO.Compression.ZipArchive($fs')).toBeGreaterThan(check);
    expect(template.indexOf('& $nodeExe $studio')).toBeGreaterThan(check);
    expect(template.indexOf('Read-Host')).toBeLessThan(
      template.indexOf('winget install --id $id --exact --silent'),
    );
    // Never over SSH, by the environment and by an sshd among the parents.
    expect(template).toContain('$env:SSH_CONNECTION');
    expect(template).toContain("$x.Name -like 'sshd*'");
    expect(template).toContain("'relay', 'install', '--pair', $Pair");
  });

  it('stages in an admin-only folder made before the download, never in TEMP, and holds the bundle from hash to unpack', () => {
    expect(template).not.toMatch(/\$env:TEMP|\$env:TMP/i);
    const made = template.indexOf('[IO.Directory]::CreateDirectory($work, $acl)');
    expect(made).toBeGreaterThan(template.indexOf('$acl.SetAccessRuleProtection($true, $false)'));
    expect(made).toBeLessThan(template.indexOf('Invoke-WebRequest'));
    expect(made).toBeLessThan(template.indexOf('Copy-Item -LiteralPath $Bundle'));
    expect(template).toContain("$work = Join-Path $env:ProgramData ('studio-bootstrap-'");
    // Read sharing only, one handle for the hash and the unpacking, closed only after both.
    const open = template.indexOf('[IO.FileShare]::Read)');
    expect(open).toBeGreaterThan(0);
    expect(template.indexOf('ComputeHash($fs)')).toBeGreaterThan(open);
    expect(template.indexOf('$fs.Dispose()')).toBeGreaterThan(template.indexOf('$in.CopyTo($out)'));
    expect(template).toContain('names a path outside its folder');
    // Node.js and Git from Program Files, PATH from the machine only; the staging folder goes.
    expect(template).toContain("$nodeExe = Join-Path $env:ProgramFiles 'nodejs\\node.exe'");
    expect(template).toContain("[Environment]::GetEnvironmentVariable('Path', 'Machine') }");
    expect(template).not.toContain("GetEnvironmentVariable('Path', 'User')");
    expect(template).toContain('[IO.Directory]::Delete($work, $true)');
    expect(template).not.toMatch(/-Recurse/);
  });
});

describe.skipIf(assets === undefined)('the release assets', () => {
  const a = assets as NonNullable<typeof assets>;
  it('write the version, the bundle SHA-256 and the repository into the bootstrap', () => {
    const b = readFileSync(a.bootstrap, 'utf8');
    expect(b).toContain(`$version = '${a.version}'`);
    expect(b).toContain(`$sha256 = '${sha(a.zip)}'`);
    expect(b).toContain("$repo = 'owner/name'");
    expect(b).not.toMatch(/__STUDIO_/);
    expect(b).toContain('\r\n');
    const sums = readFileSync(join(a.out, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain(`${sha(a.zip).toLowerCase()}  studio-${a.version}.zip`);
    expect(sums).toContain(`${sha(a.bootstrap).toLowerCase()}  studio-relay-bootstrap.ps1`);
    const notes = readFileSync(join(a.out, 'notes.md'), 'utf8');
    expect(notes).toContain(sha(a.bootstrap));
    expect(notes).toContain(`releases/download/${tag}/studio-relay-bootstrap.ps1`);
  });

  it('bundle the plugin as the install copies it, without tests or workflows', () => {
    const list = execFileSync(
      'git',
      ['archive', '--format=tar', tag as string, '--', '.', ':(exclude)test', ':(exclude).github'],
      {
        cwd: repoRoot,
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    expect(list.length).toBeGreaterThan(0);
    const names = execFileSync('unzip', ['-Z1', a.zip], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(names).toContain('studio/bin/studio\n');
    expect(names).toContain('studio/dist-bundle/studio.mjs\n');
    expect(names).toContain('studio/.claude-plugin/plugin.json\n');
    expect(names).not.toMatch(/^studio\/test\//m);
    expect(names).not.toMatch(/^studio\/\.github\//m);
    // The same tag gives the same bytes: the hash a release names is stable.
    const again = join(work, 'again');
    execFileSync(
      process.execPath,
      [
        join(repoRoot, 'scripts', 'release-assets.mjs'),
        '--tag',
        tag as string,
        '--repo',
        'owner/name',
        '--out',
        again,
      ],
      { cwd: repoRoot },
    );
    expect(sha(join(again, `studio-${a.version}.zip`))).toBe(sha(a.zip));
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
    // Never cancelled half-way, and never in the group of the push CI.
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
    expect(wf.concurrency.group).toMatch(/^release-/);
  });
});

describe('relay pair prints the one line for the PC', () => {
  it('names the bootstrap of this very version and passes the line in single quotes', () => {
    const c = bootstrapCommand('studio-pair-1 lab x ssh-ed25519 AAAA');
    expect(c).toBe(
      `& ([scriptblock]::Create((irm https://github.com/${STUDIO_REPOSITORY}/releases/download/v${STUDIO_VERSION}/studio-relay-bootstrap.ps1))) -Pair 'studio-pair-1 lab x ssh-ed25519 AAAA'`,
    );
  });
});

// Elevated, on the windows-latest job: the bootstrap as released, without installing anything.
const elevated = process.platform === 'win32' && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';

describe.skipIf(!elevated || assets === undefined)('the bootstrap on Windows', () => {
  const a = assets as NonNullable<typeof assets>;
  const env = Object.fromEntries(
    Object.entries(powershellEnv(process.env)).filter(
      ([k]) => k.toLowerCase() !== 'psmodulepath' && !k.startsWith('SSH_'),
    ),
  );
  const pair = `studio-pair-1 lab ${'a'.repeat(43)} ssh-ed25519 ${'A'.repeat(68)}`;
  // The runner's Node.js in Program Files is older than 24 (the job's own is elsewhere): a copy of
  // the bootstrap runs with the job's Node.js and Git, so the later steps are reached.
  const patched = () => {
    const file = join(work, 'bootstrap-here.ps1');
    const git = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(
      /\r?\n/,
    )[0] as string;
    writeFileSync(
      file,
      readFileSync(a.bootstrap, 'utf8')
        .replace(/^\$nodeExe = .*$/m, `$nodeExe = '${process.execPath.replace(/'/g, "''")}'`)
        .replace(/^\$gitExe = .*$/m, `$gitExe = '${git.trim().replace(/'/g, "''")}'`),
    );
    return file;
  };
  const staged = () =>
    readdirSync(process.env.ProgramData ?? 'C:\\ProgramData').filter((f) =>
      f.startsWith('studio-bootstrap-'),
    );
  const run = (args: string[], extra: Record<string, string> = {}, file = a.bootstrap) => {
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
        { encoding: 'utf8', env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { code: 0, out };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: `${x.stdout}${x.stderr}` };
    }
  };

  it('a dry run names every step and changes nothing', () => {
    const r = run(['-Pair', pair, '-DryRun', '--source', 'fd7a::/48']);
    expect(r.out).toContain('[1/4] Node.js and Git for Windows');
    expect(r.out).toMatch(/(ok|would install): Node\.js/);
    expect(r.out).toContain(
      `would download https://github.com/owner/name/releases/download/v${a.version}/studio-${a.version}.zip`,
    );
    expect(r.out).toContain('would run: studio relay install --pair <line> --source fd7a::/48');
    expect(r.out).not.toContain(pair);
    expect(r.code).toBe(0);
  }, 120_000);

  it('refuses a bundle with another SHA-256, a line that is none, and an SSH session', () => {
    const other = join(work, 'other.zip');
    writeFileSync(other, 'not the bundle');
    const before = staged().length;
    const bad = run(['-Pair', pair, '-Bundle', other], {}, patched());
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('nothing was installed');
    // The admin-only staging folder it made is gone again.
    expect(staged().length).toBe(before);
    expect(run(['-Pair', 'studio-pair-1 lab short']).out).toContain('that is not a pairing line');
    expect(run(['-Pair', pair], { SSH_CONNECTION: 'x 1 y 22' }).out).toContain(
      'runs in an SSH session',
    );
  }, 120_000);
});
