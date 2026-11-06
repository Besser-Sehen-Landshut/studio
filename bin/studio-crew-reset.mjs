// What a crew could leave in the crew user's profile to start in a later job, taken away by the
// crew user itself before every start of a relay crew (src/windows-sandbox.ts, mode `reset` of the
// crew host). Running as the crew user, it can reach no more than the crew could anyway: a link a
// crew planted leads nowhere it could not already change. Still, it never follows one: a link is
// removed as a link, a folder is never walked into or removed.
//
// The registry is read through its API (PowerShell's GetValueNames), never by parsing `reg query`
// text, so value names with spaces and the default value count like any other.
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

const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * PowerShell that names what is left under `base` (`HKCU:\` for the crew user) that would start a
 * program in a later job: any value of the Run and RunOnce keys (the default value and names with
 * spaces included), cmd's AutoRun, any environment value but TEMP and TMP. Prints a JSON list.
 */
export const registryLeftScript = (base) => `$ErrorActionPreference = 'Stop'
$base = ${psString(base)}
$left = @()
function Names([string]$k) { if (Test-Path -LiteralPath $k) { @((Get-Item -LiteralPath $k).GetValueNames() | ForEach-Object { if ($_ -eq '') { '(Default)' } else { $_ } }) } else { @() } }
foreach ($k in @('Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce')) {
  $n = Names (Join-Path $base $k)
  if ($n.Count -gt 0) { $left += ($k.Split('\\')[-1] + ': ' + ($n -join ', ')) }
}
if ((Names (Join-Path $base 'Software\\Microsoft\\Command Processor')) -contains 'AutoRun') { $left += 'cmd AutoRun' }
$n = @(Names (Join-Path $base 'Environment') | Where-Object { @('TEMP', 'TMP') -notcontains $_.ToUpperInvariant() })
if ($n.Count -gt 0) { $left += ('Environment: ' + ($n -join ', ')) }
ConvertTo-Json -Compress -InputObject @($left)
`;

/**
 * PowerShell that resets the registry under `base` as its owner: the Run and RunOnce keys and the
 * Environment key are deleted and made anew (Environment with its TEMP and TMP back as they were),
 * cmd's AutoRun goes. Then it prints what is left, as `registryLeftScript` does.
 */
export const registryResetScript = (base) => `$ErrorActionPreference = 'Stop'
$base = ${psString(base)}
function Fresh([string]$k) { if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force }; New-Item -Path $k -Force | Out-Null }
foreach ($k in @('Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce')) { Fresh (Join-Path $base $k) }
$cp = Join-Path $base 'Software\\Microsoft\\Command Processor'
if (Test-Path -LiteralPath $cp) { Remove-ItemProperty -LiteralPath $cp -Name AutoRun -ErrorAction SilentlyContinue }
$envKey = Join-Path $base 'Environment'
$keep = @{}
if (Test-Path -LiteralPath $envKey) {
  $item = Get-Item -LiteralPath $envKey
  foreach ($n in @('TEMP', 'TMP')) { $v = $item.GetValue($n, $null, 'DoNotExpandEnvironmentNames'); if ($null -ne $v) { $keep[$n] = $v } }
}
Fresh $envKey
foreach ($n in $keep.Keys) { New-ItemProperty -LiteralPath $envKey -Name $n -Value $keep[$n] -PropertyType ExpandString | Out-Null }
${registryLeftScript(base).replace("$ErrorActionPreference = 'Stop'\n", '')}`;

const powershell = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** What is left in the registry under `base`; a list that could not be read is a problem too. */
export function registryLeft(base = 'HKCU:\\') {
  try {
    const left = JSON.parse(powershell(registryLeftScript(base)).trim() || '[]');
    return Array.isArray(left) ? left : ['the registry cannot be read'];
  } catch {
    return ['the registry cannot be read'];
  }
}

/** Resets the registry under `base`; returns what is left afterwards (nothing, when it worked). */
export function resetRegistry(base = 'HKCU:\\') {
  try {
    const left = JSON.parse(powershell(registryResetScript(base)).trim() || '[]');
    return Array.isArray(left) ? left : ['the registry reset gave no answer'];
  } catch (e) {
    return [`the registry reset failed: ${String(e?.message ?? e).split('\n')[0]}`];
  }
}
