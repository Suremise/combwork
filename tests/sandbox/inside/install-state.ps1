# Runs inside the Sandbox as the user: records what an install left on this machine, as JSON, for the host's checks.
#   install-state.ps1 -Out C:\out\<name>.json
# Both identities (HI-2460): Combwork (it.surmise.combwork, Programs\Combwork\Combwork.exe) and the 1.0 app before it
# (its folder and exe below, `old` in the record). Installed-apps entries (HKCU and HKLM Uninstall keys whose DisplayName
# starts with either app's name), each install folder, the profile folders (roaming and local, with the installer's
# record), the shortcuts on the Desktop and in the Start menu (with their targets), and the Run values that start
# either exe (Launch at login). `installDir` and `profileDir` are the current app's: Combwork's when it is installed.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Continue' # one unreadable item must not lose the whole record
# old-name: begin install-state-inputs
# The 1.0 app's name (its install and profile folders, its Installed-apps entry and shortcuts) and its exe.
$oldName = 'Hive'
$oldExe = 'Hive.exe'
# old-name: end install-state-inputs

$entries = @()
foreach ($root in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
  if (-not (Test-Path $root)) { continue }
  foreach ($k in Get-ChildItem $root) {
    $p = Get-ItemProperty $k.PSPath
    if ($p.DisplayName -like "$oldName*" -or $p.DisplayName -like 'Combwork*') {
      $entries += [ordered]@{ root = $root.Split(':')[0]; key = $k.PSChildName; displayName = $p.DisplayName; displayVersion = $p.DisplayVersion; publisher = $p.Publisher; installLocation = $p.InstallLocation; uninstallString = $p.UninstallString; quietUninstallString = $p.QuietUninstallString }
    }
  }
}

function Install([string]$folder, [string]$exeName) {
  $dir = Join-Path $env:LOCALAPPDATA "Programs\$folder"
  $exe = Join-Path $dir $exeName
  $exeVersion = $null
  if (Test-Path $exe) { $exeVersion = (Get-Item $exe).VersionInfo.ProductVersion }
  # Which build is installed: test builds carry the previous release's version number, so the app code's hash tells them apart.
  $asar = Join-Path $dir 'resources\app.asar'
  $asarSha256 = $null
  if (Test-Path $asar) { $asarSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $asar).Hash.ToLower() }
  $uninstallers = @(if (Test-Path $dir) { Get-ChildItem $dir -Filter 'Uninstall*.exe' | Select-Object -ExpandProperty Name })
  return [ordered]@{ path = $dir; exe = $exeName; exists = (Test-Path $dir); hasExe = (Test-Path $exe); exeVersion = $exeVersion; appAsarSha256 = $asarSha256; uninstaller = ($uninstallers.Count -gt 0); uninstallers = $uninstallers }
}
$installs = [ordered]@{ combwork = (Install 'Combwork' 'Combwork.exe'); old = (Install $oldName $oldExe) }
$current = if ($installs.combwork.exists) { $installs.combwork } else { $installs.old }

$shell = New-Object -ComObject WScript.Shell
$shortcuts = @()
foreach ($dir in [Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'), [Environment]::GetFolderPath('CommonDesktopDirectory'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')) {
  if (-not (Test-Path $dir)) { continue }
  foreach ($l in Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue) {
    $t = $shell.CreateShortcut($l.FullName).TargetPath
    if ($l.BaseName -like "*$oldName*" -or $l.BaseName -like '*Combwork*' -or $t -like "*\$oldName\*" -or $t -like '*\Combwork\*') { $shortcuts += [ordered]@{ name = $l.BaseName; folder = $dir; target = $t } }
  }
}

function ProfileOf([string]$parent, [string]$name) {
  $dir = Join-Path $parent $name
  $record = $null
  $rf = Join-Path $dir 'profile-move.json'
  if (Test-Path -LiteralPath $rf) { try { $record = [IO.File]::ReadAllText($rf) } catch { $record = "unreadable: $($_.Exception.Message)" } }
  return [ordered]@{ path = $dir; exists = (Test-Path $dir); files = @(if (Test-Path $dir) { Get-ChildItem $dir -File | Select-Object -ExpandProperty Name }); record = $record }
}
$profiles = [ordered]@{
  roamingCombwork = (ProfileOf $env:APPDATA 'Combwork'); roamingOld = (ProfileOf $env:APPDATA $oldName)
  localCombwork = (ProfileOf $env:LOCALAPPDATA 'Combwork'); localOld = (ProfileOf $env:LOCALAPPDATA $oldName)
}
$profileDir = if ($profiles.roamingCombwork.exists) { $profiles.roamingCombwork } else { $profiles.roamingOld }

$run = @()
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path $runKey) {
  foreach ($v in (Get-Item $runKey).Property) {
    $d = (Get-ItemProperty -LiteralPath $runKey -Name $v).$v
    if ($d -like "*$oldExe*" -or $d -like '*Combwork.exe*') { $run += [ordered]@{ name = $v; command = $d } }
  }
}

$state = [ordered]@{
  at = (Get-Date).ToString('o')
  user = $env:USERNAME
  uninstallEntries = $entries
  installs = $installs
  installDir = $current
  profiles = $profiles
  profileDir = $profileDir
  shortcuts = $shortcuts
  run = $run
  git = [bool](Get-Command git -ErrorAction SilentlyContinue)
  node = [bool](Get-Command node -ErrorAction SilentlyContinue)
}
[IO.File]::WriteAllText($Out, ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
