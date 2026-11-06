# The Combwork installer's upgrade from Hive Desktop (HI-2460, SPEC §4.3): run by installer.nsh's customInit (the outer
# instance, as the user), after it holds both installers' mutexes, before anything is installed. In order, and nothing
# after a step that failed:
#   1. Asks the running app of each exact installation to close (askToClose.ps1): the Combwork of -InstallDir, and
#      the Hive Desktop recorded under its own app ID's keys (its InstallLocation), then checks by exact executable path
#      that neither main process runs (an enumeration that fails counts as running).
#   2. Removes Hive Desktop: its uninstaller, as electron-builder's uninstallOldVersion runs one (a copy, /S
#      /KEEP_APP_DATA --updated _?=<its folder>), then checks its uninstall entry and its Hive.exe are gone, and removes
#      the Run values whose executable is exactly its Hive.exe (Launch at login; any other value is left alone).
#   3. Moves the profile folders, %APPDATA% and %LOCALAPPDATA% each on its own: Hive → Combwork by one rename, only when
#      Hive is a folder and Combwork is confirmed absent. Before the local rename, the installer's record
#      (profile-move.json, HI-2461's contract) is put inside Hive's folder, so it arrives with the folder or not at all.
#      Nothing is ever deleted or copied; a rename that fails leaves both, for the app's first start to move once or to
#      refuse to start (HI-2594: it never runs on Hive's folders).
#
# Exit codes, for the installer: 0 done (each folder moved or left, as its line says); 5 an app still runs, or whether it
# does couldn't be told: nothing changed; 6 Hive Desktop couldn't be removed: the profile folders untouched (its line
# says what was left). Each step writes a line to the output, which the installer's log keeps.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$ExeName = 'Combwork.exe',
  [string]$OldExeName = 'Hive.exe',
  [string]$InstallKey = 'HKCU:\Software\35960567-b95c-520c-a9f1-e8bb85764724',
  [string]$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\35960567-b95c-520c-a9f1-e8bb85764724',
  [string]$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
  [string]$AppData = $env:APPDATA,
  [string]$LocalAppData = $env:LOCALAPPDATA,
  [string]$OldName = 'Hive',
  [string]$NewName = 'Combwork',
  [string]$WorkDir = $env:TEMP,
  [int]$AckMs = 3000,
  [int]$ExitMs = 30000,
  [int]$RunningWaitMs = 30000,
  [int]$UninstallMs = 300000,
  [switch]$SkipAsk,
  # Tests only: the process list to look at instead of Windows' (Candidates).
  [string]$ProcessesFile = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say([string]$line) { Write-Output $line }
function Same([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  try { return ([IO.Path]::GetFullPath($a).TrimEnd('\') -ieq [IO.Path]::GetFullPath($b).TrimEnd('\')) } catch { return $false }
}

# ------------------------------------------------------------------------------------------------ looking

# A path's state: folder, file, missing (the system says it isn't there), or unknown (it couldn't be looked at).
function Look([string]$p) {
  try {
    $i = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    if ($i.PSIsContainer) { return 'folder' } else { return 'file' }
  } catch [System.Management.Automation.ItemNotFoundException] {
    return 'missing'
  } catch {
    return "unknown ($($_.Exception.GetType().Name))"
  }
}

# The processes named like an executable: Windows' list, or -ProcessesFile's (a test's: a JSON array of { Name,
# ExecutablePath, CommandLine, ProcessId }, so an unreadable identity can be given).
function Candidates([string]$name) {
  if ($ProcessesFile) { return @([IO.File]::ReadAllText($ProcessesFile) | ConvertFrom-Json | Where-Object { $_.Name -ieq $name }) }
  return @(Get-CimInstance Win32_Process -Filter "Name = '$($name.Replace("'", "''"))'" -ErrorAction Stop)
}

# The main processes of an exact executable: their ids, or $null when whether it runs can't be told. Of the processes
# named like it, one whose executable can't be read (no path given: another user's, a protected one) makes it unknown,
# never "not running"; one positively elsewhere (another installation) is left out; one of this executable counts unless
# its command line positively says it is a child (--type=: Chromium's helpers), an unreadable command line counting too.
function Running([string]$exe) {
  try {
    $ids = @()
    foreach ($p in Candidates (Split-Path -Leaf $exe)) {
      if (-not $p.ExecutablePath) { return $null }
      if (-not (Same $p.ExecutablePath $exe)) { continue }
      if ($p.CommandLine -and $p.CommandLine -match '--type=') { continue }
      $ids += $p.ProcessId
    }
    # The leading comma keeps an empty list a list (PowerShell would return $null, read as "can't be told").
    return , $ids
  } catch {
    return $null
  }
}

# Waits until no main process of any of `exes` runs: 'none', 'running <exe>', or 'unknown <exe>'.
function WaitNone([string[]]$exes, [int]$ms) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $busy = $null
    foreach ($e in $exes) {
      $r = Running $e
      if ($null -eq $r) { return "unknown $e" }
      if ($r.Count) { $busy = $e; break }
    }
    if (-not $busy) { return 'none' }
    if ($clock.ElapsedMilliseconds -ge $ms) { return "running $busy" }
    Start-Sleep -Milliseconds 250
  }
}

# The executable a command line starts: its quoted first part, or up to and with the first ".exe".
function ExeOf([string]$command) {
  if (-not $command) { return $null }
  $c = $command.Trim()
  if ($c.StartsWith('"')) {
    $end = $c.IndexOf('"', 1)
    if ($end -lt 0) { return $null }
    return $c.Substring(1, $end - 1)
  }
  $i = $c.IndexOf('.exe', [StringComparison]::OrdinalIgnoreCase)
  if ($i -lt 0) { return $null }
  return $c.Substring(0, $i + 4)
}

# What follows the executable on a command line (an uninstaller's own arguments, such as /currentuser).
function ArgsOf([string]$command, [string]$exe) {
  $c = $command.Trim()
  if ($c.StartsWith('"')) { return $c.Substring($exe.Length + 2).Trim() }
  return $c.Substring($exe.Length).Trim()
}

# ------------------------------------------------------------------------------------------------ 1. close

$old = $null
$uninstall = $null
try {
  if (Test-Path -LiteralPath $InstallKey) { $old = (Get-ItemProperty -LiteralPath $InstallKey -ErrorAction Stop).InstallLocation }
  if (Test-Path -LiteralPath $UninstallKey) { $uninstall = (Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction Stop).UninstallString }
} catch {
  Say "hive desktop: its records couldn't be read ($($_.Exception.Message)): nothing changed"
  exit 6
}
if ($uninstall -and -not $old) { $old = Split-Path -Parent (ExeOf $uninstall) }
$oldExe = if ($old) { Join-Path $old $OldExeName } else { $null }
Say $(if ($old) { "previous installation: Hive Desktop in $old" } else { 'previous installation: none' })

$newExe = Join-Path $InstallDir $ExeName
if (-not $SkipAsk) {
  foreach ($pair in @(@($InstallDir, $ExeName), @($old, $OldExeName))) {
    if (-not $pair[0]) { continue }
    $code = 5
    try {
      & (Join-Path $here 'askToClose.ps1') -InstallDir $pair[0] -ExeName $pair[1] -AckMs $AckMs -ExitMs $ExitMs | Out-Null
      $code = $LASTEXITCODE
    } catch { $code = 5 }
    Say "asked $(Join-Path $pair[0] $pair[1]) to close: $code"
  }
}
$exes = @($newExe) + $(if ($oldExe) { @($oldExe) } else { @() })
$state = WaitNone $exes $RunningWaitMs
if ($state -ne 'none') {
  Say "still running: ${state}: nothing changed"
  exit 5
}
Say 'running: none'

# ------------------------------------------------------------------------------------------------ 2. remove Hive Desktop

if ($old) {
  $un = ExeOf $uninstall
  # Its uninstaller is its own: in its install folder, as its records say.
  if (-not $un -or -not (Same (Split-Path -Parent $un) $old) -or (Look $un) -ne 'file') {
    Say "hive desktop: its uninstaller ($uninstall) isn't in ${old}: nothing changed"
    exit 6
  }
  $copy = Join-Path $WorkDir ("hive-desktop-uninstall-" + [guid]::NewGuid().ToString('N') + '.exe')
  $exit = $null
  try {
    Copy-Item -LiteralPath $un -Destination $copy -ErrorAction Stop
    $list = @()
    $own = ArgsOf $uninstall $un
    if ($own) { $list += $own }
    # _?= keeps it from copying itself and returning at once; it must be last and unquoted (NSIS).
    $list += @('/S', '/KEEP_APP_DATA', '--updated', "_?=$old")
    $p = Start-Process -FilePath $copy -ArgumentList $list -PassThru -WindowStyle Hidden
    if ($p.WaitForExit($UninstallMs)) { $exit = $p.ExitCode } else { $exit = 'timeout' }
  } catch {
    $exit = "error ($($_.Exception.Message))"
  } finally {
    Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue
  }
  $entry = Test-Path -LiteralPath $UninstallKey
  $exeLeft = Look $oldExe
  if ($exit -ne 0 -or $entry -or $exeLeft -ne 'missing') {
    Say "hive desktop: its uninstall didn't finish (exit $exit; uninstall entry $(if ($entry) { 'still there' } else { 'gone' }); $OldExeName $exeLeft): the profile folders untouched"
    exit 6
  }
  Say 'hive desktop: removed (its data kept)'
  # Its Launch at login: only the Run values that start exactly its Hive.exe.
  try {
    if (Test-Path -LiteralPath $RunKey) {
      $values = (Get-Item -LiteralPath $RunKey -ErrorAction Stop).Property
      foreach ($v in $values) {
        $cmd = (Get-ItemProperty -LiteralPath $RunKey -Name $v -ErrorAction Stop).$v
        if ($cmd -is [string] -and (Same (ExeOf $cmd) $oldExe)) {
          Remove-ItemProperty -LiteralPath $RunKey -Name $v -ErrorAction Stop
          Say "launch at login: removed Hive Desktop's ($v)"
        }
      }
    }
  } catch {
    Say "launch at login: Hive Desktop's couldn't be checked ($($_.Exception.Message)); Combwork registers its own"
  }
}

# ------------------------------------------------------------------------------------------------ 3. move the profile folders

$record = 'profile-move.json'

# The installer's record in a folder: 'ours' (v 1, by installer), 'none', or 'foreign' (anything else, never replaced).
function RecordIn([string]$folder) {
  $f = Join-Path $folder $record
  $s = Look $f
  if ($s -eq 'missing') { return 'none' }
  if ($s -ne 'file') { return 'foreign' }
  try {
    $r = [IO.File]::ReadAllText($f) | ConvertFrom-Json -ErrorAction Stop
    if ($r.v -eq 1 -and $r.by -eq 'installer' -and $r.from) { return 'ours' }
  } catch { }
  return 'foreign'
}

function Move-Profile([string]$label, [string]$parent, [bool]$withRecord) {
  if (-not $parent) { Say "${label}: no folder to look in"; return }
  $from = Join-Path $parent $OldName
  $to = Join-Path $parent $NewName
  $was = Look $from
  $now = Look $to
  # A clean install's line names no old folder (HI-2632): only one that is there, or can't be looked at, is named.
  if ($was -eq 'missing') { Say "${label}: no earlier profile to move"; return }
  if ($was -ne 'folder') { Say "${label}: $from is ${was}: nothing to move"; return }
  if ($now -ne 'missing') { Say "${label}: $to is ${now}: left as it is, $from too"; return }
  if ($withRecord) {
    $have = RecordIn $from
    if ($have -eq 'none') {
      try {
        $json = [ordered]@{ v = 1; from = $from; movedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture); by = 'installer' } | ConvertTo-Json -Compress
        $f = Join-Path $from $record
        [IO.File]::WriteAllText("$f.tmp", $json, (New-Object Text.UTF8Encoding $false))
        Move-Item -LiteralPath "$f.tmp" -Destination $f -ErrorAction Stop
        Say "${label}: the installer's record put in $from"
      } catch {
        Remove-Item -LiteralPath (Join-Path $from "$record.tmp") -Force -ErrorAction SilentlyContinue
        Say "${label}: the installer's record couldn't be put in $from ($($_.Exception.Message)): not moved, tried again next install"
        return
      }
    } elseif ($have -eq 'ours') {
      Say "${label}: the installer's record from an earlier try is in $from"
    } else {
      Say "${label}: $from holds a $record that isn't the installer's: kept as it is, moved without a record"
    }
  }
  try {
    Rename-Item -LiteralPath $from -NewName $NewName -ErrorAction Stop
    Say "${label}: moved $from to $to"
  } catch {
    Say "${label}: $from couldn't be moved ($($_.Exception.Message)): both left as they are"
  }
}

Move-Profile 'roaming' $AppData $false
Move-Profile 'local' $LocalAppData $true
exit 0
