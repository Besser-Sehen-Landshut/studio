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
New-ItemProperty -LiteralPath $envk -Name 'MY VAR' -Value 'x' | Out-Null`);
    try {
      const before = reset.registryLeft(base).join('; ');
      expect(before).toContain('evil name with spaces');
      expect(before).toContain('(Default)');
      expect(before).toContain('cmd AutoRun');
      expect(before).toContain('MY VAR');
      expect(reset.resetRegistry(base)).toEqual([]);
      expect(reset.registryLeft(base)).toEqual([]);
      // TEMP stays as it was, unexpanded.
      expect(
        ps(
          `(Get-Item -LiteralPath (Join-Path '${base}' 'Environment')).GetValue('TEMP', $null, 'DoNotExpandEnvironmentNames')`,
        ).trim(),
      ).toBe('%USERPROFILE%\\AppData\\Local\\Temp');
    } finally {
      ps(`Remove-Item -LiteralPath '${base}' -Recurse -Force`);
    }
  }, 120_000);
});
