// The machine's Windows, Program Files and ProgramData folders as one PowerShell function, shared by
// Node.js (src/windows-sandbox.ts), every elevated script (MACHINE_PATH in src/relay-windows.ts) and
// the bootstrap (scripts/studio-relay-bootstrap.ps1 holds the same text; a test compares them).
// No imports: the scripts' modules load it while they import each other.

/**
 * PowerShell function `SystemFolders`: the Windows folder from the kernel
 * (`GetFolderPath('Windows')`, which is GetWindowsDirectory), Program Files from
 * `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\ProgramFilesDir` and ProgramData from
 * `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\ProgramData`, read in the 64-bit
 * view without expansion, and only `%SystemDrive%` replaced by the Windows folder's drive. Nothing
 * of the environment counts. Each must lie on that drive, outside `<drive>:\Users`, exist, and be
 * owned by TrustedInstaller, SYSTEM or the Administrators group; else it throws.
 */
export const SYSTEM_FOLDERS = String.raw`function SystemFolders {
  $win = [Environment]::GetFolderPath('Windows')
  if ($win -notmatch '^[A-Za-z]:\\[^\\/:*?"<>|%]+$') { throw "Windows names no Windows folder ($win)" }
  $drive = $win.Substring(0, 2)
  $hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  $raw = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  $pf = [string]$hklm.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion').GetValue('ProgramFilesDir', $null, $raw)
  $pd = [string]$hklm.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList').GetValue('ProgramData', $null, $raw)
  $owners = @('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-5-18', 'S-1-5-32-544')
  $out = @{ windows = $win }
  foreach ($k in @(@('programFiles', $pf), @('programData', $pd))) {
    $v = [regex]::Replace($k[1], '%SystemDrive%', $drive, 'IgnoreCase').TrimEnd('\')
    if ($v -notmatch '^[A-Za-z]:\\[^\\/:*?"<>|%]+$' -or -not $v.StartsWith($drive + '\', [StringComparison]::OrdinalIgnoreCase) -or $v -ieq ($drive + '\Users') -or $v.StartsWith($drive + '\Users\', [StringComparison]::OrdinalIgnoreCase)) { throw "Windows names no usable $($k[0]) folder ($v)" }
    if (-not [IO.Directory]::Exists($v)) { throw "$v ($($k[0])) does not exist" }
    $owner = (New-Object IO.DirectoryInfo($v)).GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owners -notcontains $owner) { throw "$v ($($k[0])) is owned by $owner, not by TrustedInstaller, SYSTEM or administrators" }
    $out[$k[0]] = $v
  }
  $out
}
`;
