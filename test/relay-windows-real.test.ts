// The hand-over of a relay job's spec on a real Windows machine (the windows-latest CI job): the
// PowerShell child gets the spec on stdin, creates the runner through CIM and writes the spec into
// a pipe only the runner it created may read. The runner here is a stand-in that writes what it got.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TREE_SOURCE } from '../src/crew-accounts.js';
import { systemSpawnRunner } from '../src/relay-serve.js';
import { FOLDER_FUNCTIONS } from '../src/relay-windows.js';
import { machineTreeProblem } from '../src/relay-windows-check.js';
import { powershellEnv, runFile } from '../src/windows-sandbox.js';

const on = process.platform === 'win32';

describe.skipIf(!on)('the relay hand-over on Windows', () => {
  it('reaches the runner it created, through a pipe of the relay account', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-win-')));
    const out = join(dir, 'got.txt');
    // Started as `<node> <bin> relay run APP-1 --pipe <name> --home <dir>`: it reads the pipe.
    const bin = join(dir, 'runner.mjs');
    writeFileSync(
      bin,
      `import { connect } from 'node:net';
import { writeFileSync } from 'node:fs';
const name = process.argv[process.argv.indexOf('--pipe') + 1];
const chunks = [];
const s = connect('\\\\\\\\.\\\\pipe\\\\' + name);
s.on('data', (d) => chunks.push(d));
s.on('end', () => writeFileSync(${JSON.stringify(out)}, Buffer.concat(chunks)));
s.on('error', (e) => writeFileSync(${JSON.stringify(out)}, 'error ' + e.code));
`,
    );
    const start = systemSpawnRunner({ home: dir, platform: 'win32', bin, lead: 'lab' });
    const spec = JSON.stringify({ nonce: 'n', job: { token: 'token-for-the-handover-test-0001' } });
    const { pid } = await start({ id: 'APP-1', spec, log: join(dir, 'log') });
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(out, 'utf8')).toBe(spec);
  }, 120_000);
});

// Elevated (the windows-latest job): the backup and restore privileges are an administrator's.
describe.skipIf(!(on && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1'))(
  "deleting a crew user's profile",
  () => {
    it('follows no link, also one planted after the listing; a Deny entry and a long path do not stop it', () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-tree-')));
      const outside = join(base, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'owner.txt'), 'the owner');
      const root = join(base, 'profile');
      // A path of more than 260 characters, in a folder closed to everyone by a Deny entry.
      const deep = join(
        root,
        'closed',
        ...Array.from({ length: 8 }, (_, i) => `${i}${'d'.repeat(40)}`),
      );
      mkdirSync(deep, { recursive: true });
      expect(deep.length).toBeGreaterThan(300);
      writeFileSync(join(deep, 'deep.txt'), 'x');
      symlinkSync(outside, join(deep, 'link-deep'), 'junction');
      symlinkSync(outside, join(root, 'link'), 'junction');
      writeFileSync(join(root, 'readonly.txt'), 'x');
      const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
      const run = (script: string) =>
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          env: powershellEnv(process.env),
        });
      run(
        `Set-ItemProperty -LiteralPath ${q(join(root, 'readonly.txt'))} -Name IsReadOnly -Value $true; icacls ${q(join(root, 'closed'))} /deny '*S-1-1-0:(OI)(CI)F' /Q | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls' }`,
      );
      const before = run(`(Get-Acl -LiteralPath ${q(outside)}).Sddl`);
      // A junction to the outside appears in the profile right after its listing.
      run(`$ErrorActionPreference = 'Stop'
Add-Type -Path ${q(TREE_SOURCE())}
$script:planted = $false
$hook = [Action[string]]{ param($d) if (-not $script:planted -and $d.TrimEnd('\\') -ieq ${q(`\\\\?\\${root}`)}) { $script:planted = $true; cmd /c mklink /J ${q(join(root, 'late'))} ${q(outside)} | Out-Null } }
[StudioTree]::Remove(${q(root)}, $hook)
if (-not $script:planted) { throw 'the hook never ran' }`);
      expect(existsSync(root)).toBe(false);
      expect(readFileSync(join(outside, 'owner.txt'), 'utf8')).toBe('the owner');
      expect(run(`(Get-Acl -LiteralPath ${q(outside)}).Sddl`)).toBe(before);
    }, 120_000);
  },
);

describe.skipIf(!on)('the PowerShell of the crew user on Windows', () => {
  it('loads core modules from $PSHOME only, whatever PSModulePath it was given', async () => {
    const reset = (await import(new URL('../bin/studio-crew-ps.mjs', import.meta.url).href)) as {
      powershell: (script: string) => string;
    };
    // A module named like a core one, first in the module path, that marks its own loading.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'studio-shadow-')));
    const mod = join(dir, 'Microsoft.PowerShell.Security');
    const marker = join(dir, 'loaded.txt');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `New-Item -ItemType Directory -Path '${mod}' | Out-Null; Set-Content -LiteralPath '${join(mod, 'Microsoft.PowerShell.Security.psm1')}' -Value "Set-Content -LiteralPath '${marker}' -Value x; function Get-Acl { 'shadow' }; Export-ModuleMember -Function Get-Acl"`,
    ]);
    const saved = process.env.PSModulePath;
    process.env.PSModulePath = `${dir};${saved ?? ''}`;
    try {
      const out = reset.powershell('(Get-Acl -LiteralPath $env:SystemRoot).GetType().Name');
      expect(out.trim()).toBe('DirectorySecurity');
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PSModulePath = saved;
    }
  }, 120_000);
});

// Elevated only (the windows-latest job): folders with an owner and a DACL of the setup's.
const elevated = on && process.env.STUDIO_WINDOWS_SANDBOX_TEST === '1';

describe.skipIf(!elevated)("the relay worker's folders on Windows", () => {
  const ps = (script: string) =>
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: powershellEnv(process.env),
    });
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-acl-')));
  const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
  const strict = (path: string, rules: string) =>
    ps(`$ErrorActionPreference = 'Stop'
${FOLDER_FUNCTIONS}
$relaySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$tree = 'ContainerInherit, ObjectInherit'
$rx = 'ReadAndExecute, Synchronize'
StrictFolder ${q(path)} ${rules}`);
  const readOnly = `@(,@($relaySid, $rx, $tree, 'None'))`;

  it('a pre-created folder with a foreign entry gets a DACL from scratch; a junction or a foreign owner refuses', () => {
    const pre = join(base, 'pre');
    ps(
      `New-Item -ItemType Directory -Path ${q(pre)} | Out-Null; icacls ${q(pre)} /grant '*S-1-5-32-545:(OI)(CI)M' /Q | Out-Null`,
    );
    strict(pre, readOnly);
    const acl = ps(
      `(Get-Acl -LiteralPath ${q(pre)}).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }`,
    );
    expect(acl).not.toContain('S-1-5-32-545');
    expect(ps(`(Get-Acl -LiteralPath ${q(pre)}).AreAccessRulesProtected`).trim()).toBe('True');
    const target = join(base, 'target');
    const junction = join(base, 'junction');
    ps(
      `New-Item -ItemType Directory -Path ${q(target)} | Out-Null; New-Item -ItemType Junction -Path ${q(junction)} -Target ${q(target)} | Out-Null`,
    );
    expect(() => strict(junction, readOnly)).toThrow(/reparse point/);
    const foreign = join(base, 'foreign');
    ps(
      `New-Item -ItemType Directory -Path ${q(foreign)} | Out-Null; icacls ${q(foreign)} /setowner '*S-1-5-32-545' /Q | Out-Null`,
    );
    expect(() => strict(foreign, readOnly)).toThrow(/not by administrators/);
  }, 120_000);

  it('a new DACL is never handed down through a junction below; an unchanged one is left alone', () => {
    const fill = `@(@($relaySid, 'ReadAndExecute, CreateFiles, CreateDirectories, Synchronize', 'None', 'None'), @($relaySid, 'Modify, Synchronize', $tree, 'InheritOnly'))`;
    const state = join(base, 'state');
    const outside = join(base, 'outside');
    ps(
      `New-Item -ItemType Directory -Path ${q(join(state, 'deep'))} -Force | Out-Null; New-Item -ItemType Directory -Path ${q(outside)} | Out-Null`,
    );
    const before = ps(`(Get-Acl -LiteralPath ${q(outside)}).Sddl`);
    ps(
      `New-Item -ItemType Junction -Path ${q(join(state, 'deep', 'link'))} -Target ${q(outside)} | Out-Null`,
    );
    expect(() => strict(state, fill)).toThrow(/reparse point below/);
    expect(ps(`(Get-Acl -LiteralPath ${q(outside)}).Sddl`)).toBe(before);
    // Without the junction the DACL is set; set again, with a junction made since, nothing moves.
    ps(`(Get-Item -LiteralPath ${q(join(state, 'deep', 'link'))} -Force).Delete()`);
    strict(state, fill);
    ps(
      `New-Item -ItemType Junction -Path ${q(join(state, 'deep', 'link'))} -Target ${q(outside)} | Out-Null`,
    );
    strict(state, fill);
    expect(ps(`(Get-Acl -LiteralPath ${q(outside)}).Sddl`)).toBe(before);
  }, 120_000);

  it('the tree check holds for the setup layout and refuses a state with a foreign writer', async () => {
    const machine = join(base, 'pf', 'Studio', 'relay');
    const home = join(base, 'pd', 'Studio', 'relay');
    for (const p of [
      join(base, 'pf'),
      join(base, 'pf', 'Studio'),
      machine,
      join(machine, 'node'),
      join(machine, 'studio'),
      join(machine, 'config'),
      join(base, 'pd'),
      join(base, 'pd', 'Studio'),
      home,
    ]) {
      strict(p, readOnly);
    }
    strict(
      join(home, 'state'),
      `@(@($relaySid, 'ReadAndExecute, CreateFiles, CreateDirectories, Synchronize', 'None', 'None'), @($relaySid, 'Modify, Synchronize', $tree, 'InheritOnly'))`,
    );
    const tree = {
      machine,
      home,
      node: join(machine, 'node', 'node.exe'),
      studioBin: join(machine, 'studio', 'bin', 'studio'),
    };
    expect(await machineTreeProblem(runFile, tree)).toBeUndefined();
    // A junction in the config, or just below state, is refused.
    const outside = join(base, 'outside-tree');
    ps(`New-Item -ItemType Directory -Path ${q(outside)} | Out-Null`);
    ps(
      `New-Item -ItemType Junction -Path ${q(join(machine, 'config', 'link'))} -Target ${q(outside)} | Out-Null`,
    );
    expect(await machineTreeProblem(runFile, tree)).toMatch(/config\\link is a reparse point/);
    ps(`(Get-Item -LiteralPath ${q(join(machine, 'config', 'link'))} -Force).Delete()`);
    ps(
      `New-Item -ItemType Junction -Path ${q(join(home, 'state', 'link'))} -Target ${q(outside)} | Out-Null`,
    );
    expect(await machineTreeProblem(runFile, tree)).toMatch(/state\\link is a reparse point/);
    ps(`(Get-Item -LiteralPath ${q(join(home, 'state', 'link'))} -Force).Delete()`);
    expect(await machineTreeProblem(runFile, tree)).toBeUndefined();
    ps(`icacls ${q(join(home, 'state'))} /grant '*S-1-5-32-545:(M)' /Q | Out-Null`);
    expect(await machineTreeProblem(runFile, tree)).toMatch(/writable by S-1-5-32-545/);
  }, 180_000);
});
