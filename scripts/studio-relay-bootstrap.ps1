#Requires -RunAsAdministrator
# Studio: set up this Windows PC as a relay worker in one step. Published with every release of
# Studio, its version and the SHA-256 of that release's bundle written in, so it installs exactly
# the Studio the lead pairs with. Run it in an elevated Windows PowerShell, at the PC itself or over
# remote desktop, never over SSH, with the line `studio relay pair` printed on the lead:
#
#   & ([scriptblock]::Create((irm <release url>/studio-relay-bootstrap.ps1))) -Pair '<line>'
#
# It checks Node.js (24 or later) and Git for Windows (2.35.2 or later) and offers to install a
# missing one with winget (it asks first, -Yes answers yes); downloads the release bundle (no git
# clone, no GitHub account) and refuses it unless its SHA-256 is the one written in here; then runs
# `studio relay install --pair <line>` from it, which installs everything else. -Uninstall runs
# `studio relay uninstall` from the same bundle instead. -DryRun says what it would do and changes
# nothing. Anything after the named parameters goes to `relay install` as it is (--source <range>,
# --interface <name>, --no-firewall, ...).
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

function Fresh { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function VersionOf([string]$exe, [string]$pattern) {
  $cmd = Get-Command $exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $cmd) { return $null }
  $text = [string](& $cmd.Source --version 2>$null)
  if ($text -notmatch $pattern) { return $null }
  [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
}
# A missing or old program: winget installs it for the whole machine, after a yes.
function Need([string]$what, [string]$exe, [string]$pattern, [version]$min, [string]$id) {
  $have = VersionOf $exe $pattern
  if ($null -ne $have -and $have -ge $min) { Write-Output "    ok: $what $have"; return }
  $why = if ($null -eq $have) { 'missing' } else { "$have is older than $min" }
  if ($DryRun) { Write-Output "    would install: $what ($why) with winget install --id $id"; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "$what is $why and winget is not there" "install $what $min or later by hand, then run this again" }
  if (-not $Yes) {
    $a = Read-Host "    $what is $why. Install it now with winget (winget install --id $id)? [y/N]"
    if ($a -notmatch '^(y|yes|j|ja)$') { Fail "$what is $why" "winget install --id $id --exact --scope machine, then run this again" }
  }
  Write-Output "    installing: $what (winget $id)"
  winget install --id $id --exact --silent --scope machine --accept-package-agreements --accept-source-agreements | Out-Null
  Fresh
  $have = VersionOf $exe $pattern
  if ($null -eq $have -or $have -lt $min) { Fail "$what is still $why after winget" "install $what $min or later by hand, then run this again" }
  Write-Output "    ok: $what $have"
}

Step 1 'Node.js and Git for Windows'
Need 'Node.js' 'node' 'v(\d+)\.(\d+)\.(\d+)' ([version]'24.0.0') 'OpenJS.NodeJS.LTS'
Need 'Git for Windows' 'git' '(\d+)\.(\d+)\.(\d+)' ([version]'2.35.2') 'Git.Git'

Step 2 "Studio $version: the release bundle, checked by its SHA-256"
$work = Join-Path $env:TEMP ('studio-bootstrap-' + [Guid]::NewGuid().ToString('N'))
if ($DryRun) { Write-Output "    would download $url and check SHA-256 $sha256" }
else {
  New-Item -ItemType Directory -Path $work | Out-Null
  $zip = Join-Path $work "studio-$version.zip"
  if ($Bundle) { Copy-Item -LiteralPath $Bundle -Destination $zip }
  else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  }
  $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
  if ($got -ne $sha256) {
    Remove-Item -LiteralPath $work -Recurse -Force
    Fail "the bundle's SHA-256 is $got, not $sha256 as released: nothing was installed" 'download the bootstrap of the release again; if this repeats, do not use this network'
  }
  Write-Output "    ok: SHA-256 $got"
  Expand-Archive -LiteralPath $zip -DestinationPath $work
}

$studio = Join-Path $work 'studio\bin\studio'
$args2 = if ($Uninstall) { @('relay', 'uninstall') + @($Rest) } else { @('relay', 'install', '--pair', $Pair) + @($Rest) }
$shown = if ($Uninstall) { 'studio relay uninstall' } else { 'studio relay install --pair <line>' }
Step 3 $(if ($Uninstall) { 'remove the relay worker' } else { 'install the relay worker (it says each step)' })
if ($DryRun) {
  Write-Output "    would run: $shown $($Rest -join ' ')"
  Step 4 'done (dry run: nothing changed)'
  return
}
try {
  & node $studio @args2
  $code = $LASTEXITCODE
} finally {
  # The install copied Studio into its admin-only tree; the download is not needed any more.
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($code -ne 0) { Fail "$shown stopped (exit $code)" 'fix what it said above and run this line again: it repairs' }
Step 4 $(if ($Uninstall) { 'done' } else { 'done. Next, on the lead: studio relay pair <label> --connect' })
