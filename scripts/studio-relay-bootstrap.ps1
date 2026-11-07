#Requires -RunAsAdministrator
# Studio: set up this Windows PC as a relay worker in one step. Published with every release of
# Studio, its version and repository written in. Run it in an elevated Windows PowerShell, at the PC
# itself or over remote desktop, never over SSH, with the line `studio relay pair` printed on the
# lead. That line downloads this script, runs it only when its SHA-256 is the one the lead's own
# Studio expects, and hands it -Tree: the digest the bundle must have, from the lead's own Studio
# (src/relay-bootstrap.ts). Nothing of the release vouches for itself.
#
# It checks Node.js (24 or later) and Git for Windows (2.35.2 or later), installed for all users,
# and offers to install a missing one with winget (it asks first, -Yes answers yes); downloads the
# release bundle (no git clone, no GitHub account) into a folder only administrators can change,
# checks every entry before unpacking any, and refuses the bundle unless its tree digest is -Tree;
# then runs `studio relay install --pair <line>` from it, which installs everything else.
# -Uninstall runs `studio relay uninstall` from the same bundle instead (`studio relay bootstrap
# uninstall` on the lead prints that line). -DryRun says what it would do and changes nothing.
# Anything after the named parameters goes to `relay install` as it is (--source <range>,
# --interface <name>, --no-firewall).
[CmdletBinding()]
param(
  [string]$Pair,
  # The tree digest of the bundle, from the lead's own Studio.
  [string]$Tree,
  [switch]$Yes,
  [switch]$Uninstall,
  [switch]$DryRun,
  # A bundle downloaded already (offline): checked the same way.
  [string]$Bundle,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
$version = '__STUDIO_VERSION__'
$repo = '__STUDIO_REPOSITORY__'
$url = "https://github.com/$repo/releases/download/v$version/studio-$version.zip"
# The paths of the plugin a relay worker runs (src/relay-bootstrap.ts BUNDLE_PATHS): nothing else.
$bundlePaths = @('.claude-plugin', 'bin', 'capabilities', 'dist-bundle', 'hooks', 'schema', 'skills', 'package.json', 'LICENSE')
$steps = 4
function Step([int]$n, [string]$what) { Write-Output "[$n/$steps] $what" }
function Fail([string]$why, [string]$fix) { throw "$why. Fix: $fix" }

if ($version -like '__*') { Fail 'this is the template of the bootstrap, not a released one' 'download studio-relay-bootstrap.ps1 from a release of Studio' }
# Run as a script block (the lead's line), #Requires does not hold: elevation is checked here.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Fail "PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) (Constrained Language Mode, set by a policy of this PC)" 'run it in a PowerShell with full language mode, or set the worker up with studio relay install by hand' }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'this PowerShell is not elevated' 'open PowerShell with Run as administrator and paste the line again' }
# The pairing line holds a single-use secret: best effort, it leaves this user's PSReadLine history.
function ForgetPair {
  if (-not $Pair) { return }
  try {
    $secret = $Pair.Split(' ')[2]
    $hist = (Get-PSReadLineOption -ErrorAction Stop).HistorySavePath
    if ($secret -and (Test-Path -LiteralPath $hist)) {
      $lines = @(Get-Content -LiteralPath $hist -Encoding UTF8)
      $keep = @($lines | Where-Object { -not $_.Contains($secret) })
      if ($keep.Count -ne $lines.Count) { Set-Content -LiteralPath $hist -Value $keep -Encoding UTF8 }
    }
  } catch { }
}
ForgetPair
if (-not $Uninstall -and -not $Pair -and -not $DryRun) { Fail 'no pairing line' "on the lead run: studio relay pair <label> <host> and paste the whole line it prints" }
if (-not $DryRun -and $Tree -notmatch '^[0-9A-Fa-f]{64}$') { Fail 'no tree digest from the lead' 'paste the whole line studio relay pair (or studio relay bootstrap uninstall) printed on the lead' }
if ($Pair -and $Pair -notmatch '^studio-pair-1 [a-z][a-z0-9-]{0,31} [A-Za-z0-9_-]{43} ssh-ed25519 [A-Za-z0-9+/]{40,2000}={0,2}$') { Fail 'that is not a pairing line' "copy the whole line studio relay pair printed on the lead, in single quotes" }

# Never over SSH: the install stops sshd while it runs and would cut this session off.
$overSsh = [bool]($env:SSH_CONNECTION -or $env:SSH_CLIENT -or $env:SSH_TTY)
if (-not $overSsh) {
  $p = $PID
  for ($i = 0; $i -lt 16 -and $p; $i++) {
    $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
    if ($null -eq $x) { break }
    if ($x.Name -like 'sshd*') { $overSsh = $true; break }
    $p = $x.ParentProcessId
  }
}
if ($overSsh) { Fail 'this runs in an SSH session, and the install stops sshd' 'run it at the PC itself or over remote desktop' }

# Only the machine's PATH: a folder of the user's PATH is writable without elevation, and what this
# elevated session starts by name must not come from there.
function Fresh { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') }
Fresh
# Node.js and Git run from where winget installs them for all users (Program Files, which only
# administrators change), never from a folder the user could write.
$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$gitExe = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
function VersionOf([string]$exe, [string]$pattern) {
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null }
  $text = [string](& $exe --version 2>$null)
  if ($text -notmatch $pattern) { return $null }
  [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
}
# A missing or old program: winget installs it for the whole machine, after a yes.
function Need([string]$what, [string]$exe, [string]$pattern, [version]$min, [string]$id) {
  $have = VersionOf $exe $pattern
  if ($null -ne $have -and $have -ge $min) { Write-Output "    ok: $what $have ($exe)"; return }
  $why = if ($null -eq $have) { "not installed for all users ($exe)" } else { "$have, older than $min" }
  if ($DryRun) { Write-Output "    would install: $what ($why) with winget install --id $id"; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "$what is $why and winget is not there" "install $what $min or later for all users, then run this again" }
  if (-not $Yes) {
    $a = Read-Host "    $what is $why. Install it now with winget (winget install --id $id)? [y/N]"
    if ($a -notmatch '^(y|yes|j|ja)$') { Fail "$what is $why" "winget install --id $id --exact --scope machine, then run this again" }
  }
  Write-Output "    installing: $what (winget $id)"
  winget install --id $id --exact --silent --scope machine --accept-package-agreements --accept-source-agreements | Out-Null
  Fresh
  $have = VersionOf $exe $pattern
  if ($null -eq $have -or $have -lt $min) { Fail "$what is still $why after winget" "install $what $min or later for all users, then run this again" }
  Write-Output "    ok: $what $have"
}

Step 1 'Node.js and Git for Windows'
Need 'Node.js' $nodeExe 'v(\d+)\.(\d+)\.(\d+)' ([version]'24.0.0') 'OpenJS.NodeJS.LTS'
Need 'Git for Windows' $gitExe '(\d+)\.(\d+)\.(\d+)' ([version]'2.35.2') 'Git.Git'

Step 2 "Studio $version`: the release bundle, checked against the lead's Studio"
# The staging folder: made with its final, protected DACL (SYSTEM and administrators only, nothing
# inherited) in one step, right in ProgramData, where other accounts may make folders of their own
# but cannot rename or remove this one. Never the user's TEMP: a process of the same user without
# elevation could change there what this elevated session hashed and then runs.
$work = Join-Path $env:ProgramData ('studio-bootstrap-' + [Guid]::NewGuid().ToString('N'))
if ($DryRun) { Write-Output "    would download $url into an admin-only folder in $env:ProgramData and check its tree digest against the lead's" }
else {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  }
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  if (Test-Path -LiteralPath $work) { Fail "$work exists already" 'run this again' }
  $null = [IO.Directory]::CreateDirectory($work, $acl)
  $item = Get-Item -LiteralPath $work -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-Acl -LiteralPath $work).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') {
    Fail "$work is not the admin-only folder this made" 'run this again'
  }
}
$studio = Join-Path $work 'studio\bin\studio'
$code = 0
try {
  if (-not $DryRun) {
    $zip = Join-Path $work "studio-$version.zip"
    if ($Bundle) { Copy-Item -LiteralPath $Bundle -Destination $zip }
    else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    }
    # One handle that shares reading only, open from the first check to the last unpacked byte:
    # nobody can write, replace or delete the bundle in between.
    Add-Type -AssemblyName System.IO.Compression
    $fs = [IO.File]::Open($zip, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $got = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($fs)).Replace('-', '')
      Write-Output "    SHA-256 of the download: $got (for reference: the tree digest decides)"
      $fs.Position = 0
      $archive = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Read, $true)
      # Every entry, before anything is unpacked: below studio/, no '..', '.' or empty part, no
      # absolute path, drive letter, backslash or ':' (an alternate data stream), no link, no two
      # names that differ only in case, and only the paths of the bundle.
      $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      foreach ($e in $archive.Entries) {
        $n = [string]$e.FullName
        if (-not $n.StartsWith('studio/', [StringComparison]::Ordinal)) { Fail "the bundle holds $n outside studio/: nothing was unpacked" 'download the bootstrap of the release again' }
        $rel = $n.Substring(7).TrimEnd('/')
        if ($rel -eq '') { continue }
        $parts = $rel.Split('/')
        # Each segment plain (letters, digits, '.', '_', '-'): no '~' (short names), no space, '\',
        # ':' (an alternate data stream) or drive letter; no trailing dot, no '.' or '..', no device name.
        foreach ($seg in $parts) {
          if ($seg -cnotmatch '^[A-Za-z0-9._-]+$' -or $seg.EndsWith('.') -or $seg -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$') { Fail "the bundle names an unsafe path ($n): nothing was unpacked" 'download the bootstrap of the release again' }
        }
        if (-not ($bundlePaths -ccontains $parts[0])) { Fail "the bundle holds $n, which is not part of Studio: nothing was unpacked" 'download the bootstrap of the release again' }
        $mode = 0
        try { $mode = ([int64]$e.ExternalAttributes -shr 16) -band 0xF000 } catch { $mode = 0 }
        if ($mode -eq 0xA000) { Fail "the bundle holds a link ($n): nothing was unpacked" 'download the bootstrap of the release again' }
        if (-not $seen.Add($rel)) { Fail "the bundle holds $n twice (names that differ only in case): nothing was unpacked" 'download the bootstrap of the release again' }
      }
      $top = [IO.Path]::GetFullPath($work).TrimEnd('\') + '\'
      foreach ($e in $archive.Entries) {
        $dest = [IO.Path]::GetFullPath((Join-Path $work $e.FullName))
        if (-not $dest.StartsWith($top, [StringComparison]::OrdinalIgnoreCase)) { Fail "the bundle names a path outside its folder: $($e.FullName)" 'download the bootstrap of the release again' }
        if ($e.FullName.EndsWith('/')) { $null = [IO.Directory]::CreateDirectory($dest); continue }
        $null = [IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
        $in = $e.Open()
        try {
          $out = [IO.File]::Open($dest, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
          try { $in.CopyTo($out) } finally { $out.Dispose() }
        } finally { $in.Dispose() }
      }
      $archive.Dispose()
    } finally { $fs.Dispose() }
    # The tree digest of what lies on disk now, as the lead computes it over its own Studio: the
    # top level must be exactly the bundle paths.
    $base = Join-Path $work 'studio'
    $onDisk = @(Get-ChildItem -LiteralPath $base -Force | ForEach-Object { $_.Name } | Sort-Object)
    if (($onDisk -join ',') -cne (@($bundlePaths | Sort-Object) -join ',')) { Fail "the bundle holds $($onDisk -join ', '), not exactly the paths of Studio: nothing was run" 'download the bootstrap of the release again' }
    $sha = [Security.Cryptography.SHA256]::Create()
    $rels = [Collections.Generic.List[string]]::new()
    foreach ($f in [IO.Directory]::EnumerateFiles($base, '*', [IO.SearchOption]::AllDirectories)) { $rels.Add($f.Substring($base.Length + 1).Replace('\', '/')) }
    $sorted = $rels.ToArray()
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    $text = New-Object Text.StringBuilder
    [void]$text.Append('paths: ' + ($bundlePaths -join ',') + "`n")
    foreach ($r in $sorted) {
      $h = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $base $r)))).Replace('-', '').ToLowerInvariant()
      [void]$text.Append($h + '  ' + $r + "`n")
    }
    $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text.ToString()))).Replace('-', '')
    if ($digest -ne $Tree) { Fail "the bundle is not the Studio $version of the lead (tree digest $digest, the lead expects $Tree): nothing was run" 'update Studio on the lead or use the release of its version; if this repeats, do not use this network' }
    Write-Output "    ok: tree digest $digest, as the lead's Studio $version
  }

  $args2 = if ($Uninstall) { @('relay', 'uninstall') + @($Rest) } else { @('relay', 'install', '--pair', $Pair) + @($Rest) }
  $shown = if ($Uninstall) { 'studio relay uninstall' } else { 'studio relay install --pair <line>' }
  Step 3 $(if ($Uninstall) { 'remove the relay worker' } else { 'install the relay worker (it says each step)' })
  if ($DryRun) {
    Write-Output "    would run: $shown $($Rest -join ' ') with $nodeExe"
  } else {
    # Nothing of this session's environment steers Node.js or npm: no NODE_OPTIONS (preloads),
    # NODE_PATH, NODE_EXTRA_CA_CERTS or any other NODE_* and npm_config_*.
    foreach ($k in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'NODE_*' -or $_.Name -like 'npm_config_*' } | ForEach-Object { $_.Name })) { Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue }
    & $nodeExe $studio @args2
    $code = $LASTEXITCODE
  }
} finally {
  ForgetPair
  # The install copied Studio into its admin-only tree; the download is not needed any more.
  # .NET deletes the tree without following a link (a recursive Remove-Item of Windows PowerShell
  # may); the folder is admin-only, made by this run.
  if (-not $DryRun -and (Test-Path -LiteralPath $work)) { try { [IO.Directory]::Delete($work, $true) } catch { Write-Output "    note: $work stays: $($_.Exception.Message)" } }
}
if ($code -ne 0) { Fail "$shown stopped (exit $code)" 'fix what it said above and run this line again: it repairs' }
if ($DryRun) { Step 4 'done (dry run: nothing changed)' }
else { Step 4 $(if ($Uninstall) { 'done' } else { 'done. Next, on the lead: studio relay pair <label> --connect' }) }
