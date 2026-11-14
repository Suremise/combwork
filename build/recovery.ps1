# An update's recovery copy (HI-3172, SPEC 11.1): run by installer.nsh's cwArmRecovery before anything is removed, by the
# instance that installs, while it holds the recovery lock. It stages a copy of this installer in the recovery folder as
# Combwork-Setup.new.exe and checks it (size and SHA-256); the installer then swaps it onto Combwork-Setup.exe and writes
# the Run value that runs it at the next sign-in. It never touches Combwork-Setup.exe itself, so an earlier interrupted
# install's recovery is kept whatever happens here.
#
# -Scope machine (a per-machine install, elevated; the folder under ProgramData): nothing that exists is changed. Each of
# the two folders, if it exists, must be a plain folder (no reparse point), owned by Administrators or SYSTEM, with no
# entry letting anyone else write, append, delete, delete children, change its permissions or take it over; one that
# doesn't is created here and given a protected ACL (Administrators and SYSTEM full control, Users read) on itself
# alone, then checked the same way. Never recursive, and nothing is followed. The recovery folder may hold only
# Combwork-Setup.exe and Combwork-Setup.new.exe, plain files passing the same check; anything else refuses.
# -Scope user (%LOCALAPPDATA%, the user's own): the folder is made if missing; its entries are checked the same way for
# names and reparse points (no ACL check).
#
# Output: one line, the last one says what was done: "staged", "self" (this installer is the recovery copy already, a
# resumed run: nothing staged), or "refused: <step>". Exit codes: 0 staged or self; 1 refused (Combwork-Setup.new.exe
# removed if this run made it). -CheckSddl <sddl> (tests): prints trusted or untrusted for a descriptor.
param(
  [ValidateSet('user', 'machine')][string]$Scope = 'user',
  [string]$Dir = '',
  [string]$Source = '',
  [string]$CheckSddl = ''
)
$ErrorActionPreference = 'Stop'

$Payload = 'Combwork-Setup.exe'
$Staged = 'Combwork-Setup.new.exe'
# Administrators, SYSTEM, TrustedInstaller.
$TrustedSids = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_DELETE_CHILD, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE.
$WriteMask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
# The ACL a folder made here gets: protected, Administrators and SYSTEM full control, Users read and execute.
$FolderSddl = 'D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)'

# Whether a security descriptor (SDDL) is one only Administrators, SYSTEM and TrustedInstaller can change: its owner is
# one of them, and no allow entry (inherit-only ones too) gives anyone else a write right.
function Test-TrustedSddl([string]$sddl) {
  $sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
  if (-not $sd.Owner -or $TrustedSids -notcontains $sd.Owner.Value) { return $false }
  if (-not $sd.DiscretionaryAcl) { return $false }
  foreach ($ace in $sd.DiscretionaryAcl) {
    if ($ace -isnot [System.Security.AccessControl.CommonAce]) { return $false }
    if ($ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
    if ($TrustedSids -contains $ace.SecurityIdentifier.Value) { continue }
    if (($ace.AccessMask -band $WriteMask) -ne 0) { return $false }
  }
  return $true
}

if ($CheckSddl) {
  if (Test-TrustedSddl $CheckSddl) { 'trusted' } else { 'untrusted' }
  exit 0
}

$stagedHere = $false
function Refuse([string]$step) {
  if ($script:stagedHere) { try { Remove-Item -LiteralPath (Join-Path $Dir $Staged) -Force } catch { } }
  "refused: $step"
  exit 1
}

# An entry's attributes, read on the entry itself (a reparse point is not followed).
function Get-Attrs([string]$path) { return [System.IO.File]::GetAttributes($path) }
function Test-Reparse([string]$path) { return ((Get-Attrs $path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 }
function Get-Sddl([string]$path) { return (Get-Acl -LiteralPath $path).Sddl }

# A folder of the recovery path (machine scope): checked if it exists, else made with its ACL and checked.
function Use-Folder([string]$path) {
  if (Test-Path -LiteralPath $path) {
    if (Test-Reparse $path) { Refuse "$path is a link" }
    if (((Get-Attrs $path) -band [System.IO.FileAttributes]::Directory) -eq 0) { Refuse "$path isn't a folder" }
    if (-not (Test-TrustedSddl (Get-Sddl $path))) { Refuse "$path can be changed by other users" }
    return
  }
  # Without -Force: one made meanwhile by someone else fails here.
  try { New-Item -ItemType Directory -Path $path | Out-Null } catch { Refuse "couldn't create $path" }
  try {
    $sec = New-Object System.Security.AccessControl.DirectorySecurity
    $sec.SetSecurityDescriptorSddlForm($FolderSddl, [System.Security.AccessControl.AccessControlSections]::Access)
    [System.IO.Directory]::SetAccessControl($path, $sec)
  } catch { Refuse "couldn't set the permissions of $path" }
  if (Test-Reparse $path) { Refuse "$path is a link" }
  if (-not (Test-TrustedSddl (Get-Sddl $path))) { Refuse "$path can be changed by other users" }
}

if (-not $Dir -or -not $Source) { Refuse 'no folder or installer given' }
$Dir = [System.IO.Path]::GetFullPath($Dir)
try {
  if ($Scope -eq 'machine') {
    Use-Folder (Split-Path -Parent $Dir)
    Use-Folder $Dir
  } elseif (Test-Path -LiteralPath $Dir) {
    if (Test-Reparse $Dir) { Refuse "$Dir is a link" }
  } else {
    try { New-Item -ItemType Directory -Path $Dir -Force | Out-Null } catch { Refuse "couldn't create $Dir" }
  }

  # What the recovery folder holds: only the two names, plain files, trusted ones in machine scope.
  foreach ($e in [System.IO.Directory]::EnumerateFileSystemEntries($Dir)) {
    $name = [System.IO.Path]::GetFileName($e)
    if ($name -ne $Payload -and $name -ne $Staged) { Refuse "unexpected $e" }
    $a = Get-Attrs $e
    if (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse "$e is a link" }
    if (($a -band [System.IO.FileAttributes]::Directory) -ne 0) { Refuse "$e is a folder" }
    if ($Scope -eq 'machine' -and -not (Test-TrustedSddl (Get-Sddl $e))) { Refuse "$e can be changed by other users" }
  }

  $src = [System.IO.Path]::GetFullPath($Source)
  $dst = Join-Path $Dir $Payload
  if ([string]::Equals($src, $dst, [System.StringComparison]::OrdinalIgnoreCase)) { 'self'; exit 0 }

  $new = Join-Path $Dir $Staged
  if (Test-Path -LiteralPath $new) {
    try { Remove-Item -LiteralPath $new -Force } catch { Refuse "couldn't remove an old $Staged" }
  }
  $script:stagedHere = $true
  try { Copy-Item -LiteralPath $src -Destination $new } catch { Refuse "couldn't copy the installer: $($_.Exception.Message)" }
  if (Test-Reparse $new) { Refuse "$new is a link" }
  if ($Scope -eq 'machine' -and -not (Test-TrustedSddl (Get-Sddl $new))) { Refuse "$new can be changed by other users" }
  if ((Get-Item -LiteralPath $src).Length -ne (Get-Item -LiteralPath $new).Length) { Refuse 'the copy is incomplete' }
  if ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $new -Algorithm SHA256).Hash) { Refuse "the copy doesn't match" }
  'staged'
  exit 0
} catch {
  Refuse "unexpected error: $($_.Exception.Message)"
}
