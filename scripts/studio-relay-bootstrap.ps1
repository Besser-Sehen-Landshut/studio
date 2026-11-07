#Requires -RunAsAdministrator
# Studio: set up this Windows PC as a relay worker in one step. Published with every release of
# Studio, its version and the SHA-256 of that release's bundle written in, so it installs exactly
# the Studio the lead pairs with. Run it in an elevated Windows PowerShell, at the PC itself or over
# remote desktop, never over SSH, with the line `studio relay pair` printed on the lead:
#
#   & ([scriptblock]::Create((irm <release url>/studio-relay-bootstrap.ps1))) -Pair '<line>'
#
# It checks Node.js (24 or later) and Git for Windows (2.35.2 or later), installed for all users,
# and offers to install a missing one with winget (it asks first, -Yes answers yes); downloads the
# release bundle (no git clone, no GitHub account) into a folder only administrators can change and
# refuses it unless its SHA-256 is the one written in here; then runs `studio relay install --pair
# <line>` from it, which installs everything else. -Uninstall runs `studio relay uninstall` from the
# same bundle instead. -DryRun says what it would do and changes nothing. Anything after the named
# parameters goes to `relay install` as it is (--source <range>, --interface <name>, --no-firewall).
[CmdletBinding()]
param(
  [string]$Pair,
  [switch]$Yes,
  [switch]$Uninstall,
  [switch]$DryRun,
  # A bundle downloaded already (offline): checked against the same SHA-256.
  [string]$Bundle,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
$version = '__STUDIO_VERSION__'
$sha256 = '__STUDIO_BUNDLE_SHA256__'
$repo = '__STUDIO_REPOSITORY__'
$url = "https://github.com/$repo/releases/download/v$version/studio-$version.zip"
$steps = 4
function Step([int]$n, [string]$what) { Write-Output "[$n/$steps] $what" }
function Fail([string]$why, [string]$fix) { throw "$why. Fix: $fix" }

if ($version -like '__*') { Fail 'this is the template of the bootstrap, not a released one' 'download studio-relay-bootstrap.ps1 from a release of Studio' }
if (-not $Uninstall -and -not $Pair -and -not $DryRun) { Fail 'no pairing line' "on the lead run: studio relay pair <label> <host>, then run this with -Pair '<the line it prints>'" }
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

Step 2 "Studio $version`: the release bundle, checked by its SHA-256"
# The staging folder: made with its final, protected DACL (SYSTEM and administrators only, nothing
# inherited) in one step, right in ProgramData, where other accounts may make folders of their own
# but cannot rename or remove this one. Never the user's TEMP: a process of the same user without
# elevation could change there what this elevated session hashed and then runs.
$work = Join-Path $env:ProgramData ('studio-bootstrap-' + [Guid]::NewGuid().ToString('N'))
if ($DryRun) { Write-Output "    would download $url into an admin-only folder in $env:ProgramData and check SHA-256 $sha256" }
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
    # One handle that shares reading only, open from the hash to the last unpacked byte: nobody can
    # write, replace or delete the bundle in between.
    Add-Type -AssemblyName System.IO.Compression
    $fs = [IO.File]::Open($zip, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $got = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($fs)).Replace('-', '')
      if ($got -ne $sha256) {
        Fail "the bundle's SHA-256 is $got, not $sha256 as released: nothing was installed" 'download the bootstrap of the release again; if this repeats, do not use this network'
      }
      Write-Output "    ok: SHA-256 $got"
      $fs.Position = 0
      $archive = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Read, $true)
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
  }

  $args2 = if ($Uninstall) { @('relay', 'uninstall') + @($Rest) } else { @('relay', 'install', '--pair', $Pair) + @($Rest) }
  $shown = if ($Uninstall) { 'studio relay uninstall' } else { 'studio relay install --pair <line>' }
  Step 3 $(if ($Uninstall) { 'remove the relay worker' } else { 'install the relay worker (it says each step)' })
  if ($DryRun) {
    Write-Output "    would run: $shown $($Rest -join ' ') with $nodeExe"
  } else {
    & $nodeExe $studio @args2
    $code = $LASTEXITCODE
  }
} finally {
  # The install copied Studio into its admin-only tree; the download is not needed any more.
  if (-not $DryRun) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($code -ne 0) { Fail "$shown stopped (exit $code)" 'fix what it said above and run this line again: it repairs' }
if ($DryRun) { Step 4 'done (dry run: nothing changed)' }
else { Step 4 $(if ($Uninstall) { 'done' } else { 'done. Next, on the lead: studio relay pair <label> --connect' }) }
