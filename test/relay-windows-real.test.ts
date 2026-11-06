// The hand-over of a relay job's spec on a real Windows machine (the windows-latest CI job): the
// PowerShell child gets the spec on stdin, creates the runner through CIM and writes the spec into
// a pipe only the runner it created may read. The runner here is a stand-in that writes what it got.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe.skipIf(!on)('the profile reset of a crew user on Windows', () => {
  it('leaves no Run value, also with spaces in its name or as the default, no AutoRun, no extra environment', async () => {
    const reset = (await import(new URL('../bin/studio-crew-reset.mjs', import.meta.url).href)) as {
      registryLeft: (base: string) => string[];
      resetRegistry: (base: string) => string[];
    };
    // A root of its own under this user's key stands in for the crew user's HKCU.
    const base = `HKCU:\\Software\\StudioResetTest-${randomBytes(4).toString('hex')}\\`;
    const ps = (script: string) =>
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
      });
    ps(`$ErrorActionPreference = 'Stop'
$b = '${base}'
$run = Join-Path $b 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'
$once = Join-Path $b 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
$cp = Join-Path $b 'Software\\Microsoft\\Command Processor'
$envk = Join-Path $b 'Environment'
foreach ($k in @($run, $once, $cp, $envk)) { New-Item -Path $k -Force | Out-Null }
New-ItemProperty -LiteralPath $run -Name 'evil name with spaces' -Value 'calc.exe' | Out-Null
Set-ItemProperty -LiteralPath $run -Name '(default)' -Value 'calc.exe'
New-ItemProperty -LiteralPath $once -Name 'once' -Value 'calc.exe' | Out-Null
New-ItemProperty -LiteralPath $cp -Name 'AutoRun' -Value 'calc.exe' | Out-Null
New-ItemProperty -LiteralPath $envk -Name 'TEMP' -Value '%USERPROFILE%\\AppData\\Local\\Temp' -PropertyType ExpandString | Out-Null
New-ItemProperty -LiteralPath $envk -Name 'MY VAR' -Value 'x' | Out-Null
$cls = Join-Path $b 'Software\\Classes'
New-Item -Path (Join-Path $cls 'CLSID\\{00000000-0000-0000-0000-00000000beef}\\InprocServer32') -Force | Out-Null
New-Item -Path (Join-Path $cls 'Local Settings\\Software') -Force | Out-Null
$usf = Join-Path $b 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
$sf = Join-Path $b 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'
foreach ($k in @($usf, $sf)) { New-Item -Path $k -Force | Out-Null }
New-ItemProperty -LiteralPath $usf -Name 'Startup' -Value 'C:\\elsewhere\\Startup' -PropertyType ExpandString | Out-Null
New-ItemProperty -LiteralPath $usf -Name 'AppData' -Value '%USERPROFILE%\\AppData\\Roaming' -PropertyType ExpandString | Out-Null
New-ItemProperty -LiteralPath $usf -Name 'Favorites' -Value '%USERPROFILE%\\..\\Public' -PropertyType ExpandString | Out-Null
New-ItemProperty -LiteralPath $sf -Name 'Personal' -Value 'D:\\documents' | Out-Null
New-ItemProperty -LiteralPath $sf -Name '!Do not use this registry key' -Value 'x' | Out-Null`);
    try {
      const before = reset.registryLeft(base).join('; ');
      expect(before).toContain('evil name with spaces');
      expect(before).toContain('(Default)');
      expect(before).toContain('cmd AutoRun');
      expect(before).toContain('MY VAR');
      // A COM class of the user's own, shell folders out of the profile; Local Settings, AppData
      // inside the profile and the "!" note are no finding.
      expect(before).toContain('Software\\Classes');
      expect(before).toContain('User Shell Folders: Startup, Favorites');
      expect(before).toContain('Shell Folders: Personal');
      expect(before).not.toContain('AppData');
      expect(before).not.toContain('Do not use');
      expect(reset.resetRegistry(base)).toEqual([]);
      expect(reset.registryLeft(base)).toEqual([]);
      // TEMP stays as it was, unexpanded.
      expect(
        ps(
          `(Get-Item -LiteralPath (Join-Path '${base}' 'Environment')).GetValue('TEMP', $null, 'DoNotExpandEnvironmentNames')`,
        ).trim(),
      ).toBe('%USERPROFILE%\\AppData\\Local\\Temp');
      // Windows keeps Local Settings there; the reset leaves it.
      expect(
        ps(
          `Test-Path -LiteralPath (Join-Path '${base}' 'Software\\Classes\\Local Settings')`,
        ).trim(),
      ).toBe('True');
    } finally {
      ps(`Remove-Item -LiteralPath '${base}' -Recurse -Force`);
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
