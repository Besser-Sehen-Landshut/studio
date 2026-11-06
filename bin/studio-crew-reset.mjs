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
 * spaces included), cmd's AutoRun, any environment value but TEMP and TMP, a COM class of the user's
 * own, a shell folder outside the profile. Prints a JSON list.
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
# COM classes of the user's own (a hijack of a class a program loads): none but Local Settings,
# which Windows keeps there itself.
$classes = Join-Path $base 'Software\\Classes'
if (Test-Path -LiteralPath $classes) {
  $extra = @(Get-ChildItem -LiteralPath $classes | Where-Object { $_.PSChildName -ne 'Local Settings' })
  if ($extra.Count -gt 0 -or (Names $classes).Count -gt 0) { $left += 'Software\\Classes' }
}
# Shell folders moved out of the profile (Startup or Documents somewhere a later job would read):
# Windows writes its defaults back, all inside the profile. Only the variables of the profile count.
$root = [Environment]::GetFolderPath('UserProfile').TrimEnd('\\')
foreach ($k in @('Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders')) {
  $p = Join-Path $base $k
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $item = Get-Item -LiteralPath $p
  $moved = @(foreach ($n in $item.GetValueNames()) {
    if ($n.StartsWith('!')) { continue }
    $v = [string]$item.GetValue($n, '', 'DoNotExpandEnvironmentNames')
    $v = $v -ireplace '%USERPROFILE%', $root -ireplace '%APPDATA%', ($root + '\\AppData\\Roaming') -ireplace '%LOCALAPPDATA%', ($root + '\\AppData\\Local')
    if ($v.Contains('%') -or -not $v.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase) -or $v.Contains('..')) { if ($n -eq '') { '(Default)' } else { $n } }
  })
  if ($moved.Count -gt 0) { $left += ($k.Split('\\')[-1] + ': ' + ($moved -join ', ')) }
}
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
# The user's own COM classes (Local Settings stays, Windows keeps it there) and its shell folder
# keys go: Windows writes its defaults back.
$classes = Join-Path $base 'Software\\Classes'
if (Test-Path -LiteralPath $classes) {
  Get-ChildItem -LiteralPath $classes | Where-Object { $_.PSChildName -ne 'Local Settings' } | ForEach-Object { Remove-Item -LiteralPath $_.PSPath -Recurse -Force }
  $item = Get-Item -LiteralPath $classes
  foreach ($n in $item.GetValueNames()) { if ($n -eq '') { Remove-ItemProperty -LiteralPath $classes -Name '(default)' } else { Remove-ItemProperty -LiteralPath $classes -Name $n } }
}
foreach ($k in @('Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders')) { Fresh (Join-Path $base $k) }
${registryLeftScript(base).replace("$ErrorActionPreference = 'Stop'\n", '')}`;

const powershell = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * PowerShell profiles in a Documents folder (`PowerShell` and `WindowsPowerShell`): every profile
 * script goes, a link as a link. Returns the names removed and what could not be.
 */
export function resetProfiles(documents) {
  const removed = [];
  const left = [];
  for (const sub of ['PowerShell', 'WindowsPowerShell']) {
    const dir = join(documents, sub);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        unlinkSync(dir);
      } catch {
        rmdirSync(dir);
      }
      removed.push(sub);
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!/profile\.ps1$/i.test(name)) continue;
      const p = join(dir, name);
      const e = lstatSync(p);
      if (e.isSymbolicLink() || e.isFile()) {
        unlinkSync(p);
        removed.push(`${sub}\\${name}`);
      } else {
        left.push(`${sub}\\${name}`);
      }
    }
  }
  return { removed, left };
}

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
