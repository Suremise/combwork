# Runs inside the Sandbox as the user (HI-2460, scenario 8): the Combwork installer's edge cases over the 1.0 app,
# with real installers, in order on one machine:
#   8.1 The 1.0 app's installer mutex held: the new installer waits, changing nothing; released, it goes on and installs.
#   8.2 held past a test-shortened bound (-Short: an installer built with CW_TEST_SHORT_LEGACY_WAIT=1, 20 s): exit 4,
#       nothing changed.
#   8.3 The 1.0 app running and not closing (a stand-in at its exact exe that ignores the request): exit 5, the 1.0
#       app and the profile folders untouched.
#   8.4 The 1.0 app's uninstall not finishing (its exe held open, so it can't be removed): exit 6, the profile
#       folders untouched.
#   8.5 Combwork started over 1.0's folders (an installer's rename that didn't happen): its start moves them once
#       (HI-2594); the installer run again closes it and removes the 1.0 app, the folders left Combwork's.
#   install-edges.ps1 -Prev <1.0 installer> -New <installer> -Short <short-bound installer>
# Writes C:\out\edges.json ({ checks: [{ id, name, ok, detail }], completed }) as it goes.
param(
  [Parameter(Mandatory = $true)][string]$Prev,
  [Parameter(Mandatory = $true)][string]$New,
  [Parameter(Mandatory = $true)][string]$Short
)
$ErrorActionPreference = 'Stop'
$out = 'C:\out\edges.json'
$res = [ordered]@{ checks = @(); completed = $false }
function Save { [IO.File]::WriteAllText($out, ($res | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false)) }
function Check([string]$id, [string]$name, [bool]$ok, $detail) {
  $res.checks += [ordered]@{ id = $id; name = $name; ok = $ok; detail = $(if ($ok) { $null } else { [string]$detail }) }
  Save
}

$legacy = '35960567-b95c-520c-a9f1-e8bb85764724'
# old-name: begin edges-inputs
# The 1.0 app's name (its profile folders'), its exe, and the name a stand-in moves the real exe aside to.
$oldName = 'Hive'
$oldExeName = 'Hive.exe'
$oldRealName = 'Hive.real.exe'
# old-name: end edges-inputs
$oldDir = Join-Path $env:LOCALAPPDATA "Programs\$oldName"
$oldExe = Join-Path $oldDir $oldExeName
$combExe = Join-Path $env:LOCALAPPDATA 'Programs\Combwork\Combwork.exe'
$oldKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$legacy"
$roamOld = Join-Path $env:APPDATA $oldName
$roamComb = Join-Path $env:APPDATA 'Combwork'
$locOld = Join-Path $env:LOCALAPPDATA $oldName
$locComb = Join-Path $env:LOCALAPPDATA 'Combwork'

# Every wait here waits for a condition, bounded by $HUNG (a hung run), never for time; one not met throws, so no case
# goes on from a precondition that wasn't reached. The one exception is 8.1's observation that the installer keeps
# waiting while the mutex is held: a negative check, over a bounded span (it can only be observed for so long).
$HUNG = 120
function WaitFor([scriptblock]$cond, [string]$what, [int]$secs = $HUNG) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not (& $cond)) {
    if ($clock.Elapsed.TotalSeconds -ge $secs) { throw "not met within $secs s: $what" }
    Start-Sleep -Milliseconds 200
  }
}
function Install([string]$exe, [string]$arguments = '/S') { $p = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru; $null = $p.Handle; return $p }
function WaitExit($p, [int]$secs) { if ($p.WaitForExit($secs * 1000)) { return $p.ExitCode } else { return 'timeout' } }
# Ends a process this script started and waits until it has exited.
function EndOwn($p) {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  if (-not $p.WaitForExit($HUNG * 1000)) { throw "process $($p.Id) didn't exit" }
}
# A process of this script's holding something until it is told to let go (C:\out\<name>.release), saying when it holds
# it (C:\out\<name>.ready): asserted before the case goes on.
function Holding([string]$name, [string]$take, [string]$letGo) {
  $ready = "C:\out\$name.ready"
  $release = "C:\out\$name.release"
  Remove-Item $ready, $release -ErrorAction SilentlyContinue
  $script = "$take; [IO.File]::WriteAllText('$ready', 'held'); while (-not (Test-Path '$release')) { Start-Sleep -Milliseconds 200 }; $letGo"
  $h = Start-Process powershell -ArgumentList '-NoProfile', '-Command', $script -PassThru -WindowStyle Hidden
  $null = $h.Handle
  WaitFor { Test-Path $ready } "$name holding"
  return [pscustomobject]@{ process = $h; release = $release }
}
function LetGo($held) {
  Set-Content $held.release 'go'
  if (-not $held.process.WaitForExit($HUNG * 1000)) { throw "the holder $($held.process.Id) didn't let go" }
}
# The 1.0 app's installer mutex, owned until LetGo (as a running 1.0 installer holds it).
function HoldMutex { Holding 'mutex' "`$m = New-Object System.Threading.Mutex(`$true, '$legacy')" '$m.ReleaseMutex(); $m.Dispose()' }
# Whether a file can be opened with no sharing (nothing else holds it).
function Free([string]$file) { try { $f = [IO.File]::Open($file, 'Open', 'Read', 'None'); $f.Close(); return $true } catch { return $false } }
# The main process of an exact exe, running.
function MainOf([string]$exe) { Get-CimInstance Win32_Process -Filter "Name='$(Split-Path -Leaf $exe)'" | Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1 }
# Profile folders under 1.0's names with a file each, as 1.0 leaves them (each case checks they stayed or moved).
function OldProfiles {
  foreach ($p in @($roamComb, $locComb)) { if (Test-Path $p) { Rename-Item $p -NewName $oldName } }
  foreach ($p in @($roamOld, $locOld)) { New-Item -ItemType Directory -Force $p | Out-Null; Set-Content (Join-Path $p 'edge-mark.txt') 'mark' }
}
function ProfilesUntouched { (Test-Path (Join-Path $roamOld 'edge-mark.txt')) -and (Test-Path (Join-Path $locOld 'edge-mark.txt')) -and -not (Test-Path $roamComb) -and -not (Test-Path $locComb) }
function InstallPrev { $c = WaitExit (Install $Prev) 300; if ($c -ne 0 -or -not (Test-Path $oldExe)) { throw "The 1.0 app didn't install: exit $c" } }

try {
  # 8.1: waits while held (observed for 20 s: the negative check), then, released, goes on.
  InstallPrev
  OldProfiles
  $held = HoldMutex
  $p = Install $New
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not $p.HasExited -and $clock.Elapsed.TotalSeconds -lt 20) { Start-Sleep -Milliseconds 500 }
  $waiting = -not $p.HasExited
  Check '8.wait' 'The 1.0 app''s installer mutex held: the new installer waits (observed for 20 s)' $waiting "exited with $($p.ExitCode) while the mutex was held"
  Check '8.wait-unchanged' 'While it waits nothing changes: the 1.0 app installed, no Combwork, the profile folders as they were' ((Test-Path $oldExe) -and (Test-Path $oldKey) -and -not (Test-Path $combExe) -and (ProfilesUntouched)) "1.0 $(Test-Path $oldExe), key $(Test-Path $oldKey), combwork $(Test-Path $combExe), profiles $(ProfilesUntouched)"
  LetGo $held
  $code = WaitExit $p 180
  Check '8.continues' 'Released, it goes on: installed (exit 0), the 1.0 app removed, the folders moved' ($code -eq 0 -and (Test-Path $combExe) -and -not (Test-Path $oldKey) -and (Test-Path (Join-Path $roamComb 'edge-mark.txt')) -and (Test-Path (Join-Path $locComb 'edge-mark.txt'))) "exit $code; combwork $(Test-Path $combExe); key $(Test-Path $oldKey)"

  # 8.2: held past the shortened bound: refuses.
  InstallPrev
  OldProfiles
  $stamp = (Get-Item $combExe).LastWriteTimeUtc
  $held = HoldMutex
  $p = Install $Short
  $code = WaitExit $p 120
  Check '8.refuses' 'Held past its bound (20 s here): the installer stops (exit 4)' ($code -eq 4) "exit $code"
  Check '8.refuses-unchanged' 'Nothing changed: the 1.0 app installed, Combwork not reinstalled, the profile folders as they were' ((Test-Path $oldExe) -and (Test-Path $oldKey) -and ((Get-Item $combExe).LastWriteTimeUtc -eq $stamp) -and (ProfilesUntouched)) "1.0 $(Test-Path $oldExe), key $(Test-Path $oldKey), profiles $(ProfilesUntouched)"
  LetGo $held

  # 8.3: the 1.0 app running, not closing: a stand-in at its exact exe (Node) that ignores the request, running
  # (its exact main process listed) before the installer starts.
  Rename-Item $oldExe -NewName $oldRealName
  Copy-Item 'C:\tools\node\node.exe' $oldExe
  Set-Content 'C:\out\stay.cjs' "setInterval(() => {}, 1000)"
  $stay = Start-Process -FilePath $oldExe -ArgumentList 'C:\out\stay.cjs' -PassThru -WindowStyle Hidden
  $null = $stay.Handle
  WaitFor { $m = MainOf $oldExe; $m -and $m.ProcessId -eq $stay.Id } 'the stand-in exe running'
  $p = Install $New
  $code = WaitExit $p 240
  Check '8.running' 'The 1.0 app running and not closing: the installer stops (exit 5)' ($code -eq 5) "exit $code"
  Check '8.running-unchanged' 'Nothing changed: the 1.0 app installed, the profile folders as they were' ((Test-Path $oldKey) -and (Test-Path $oldExe) -and (ProfilesUntouched)) "key $(Test-Path $oldKey), profiles $(ProfilesUntouched)"
  EndOwn $stay
  WaitFor { Free $oldExe } 'the stand-in exe let go'
  Remove-Item $oldExe -Force
  Rename-Item (Join-Path $oldDir $oldRealName) -NewName $oldExeName

  # 8.4: its uninstall can't remove its exe (held open, not running): exit 6, the profile folders untouched.
  $held = Holding 'file' "`$f = [IO.File]::Open('$oldExe', 'Open', 'Read', 'None')" '$f.Close()'
  $p = Install $New
  $code = WaitExit $p 300
  Check '8.uninstall-fails' 'The 1.0 app''s uninstall not finishing: the installer stops (exit 6)' ($code -eq 6) "exit $code"
  Check '8.uninstall-fails-unchanged' 'The profile folders as they were' (ProfilesUntouched) "profiles $(ProfilesUntouched)"
  LetGo $held
  WaitFor { Free $oldExe } 'the exe let go'

  # 8.5: Combwork started over the folders its installer left (8.4's), with the 1.0 app installed again and not
  # running: its start moves them, once, by one rename each with its own record (HI-2594: it never runs on 1.0's
  # folders), and runs with its window; the installer run again closes it and removes the 1.0 app, the folders left as
  # they are.
  InstallPrev
  # 8.1's installer record came back to 1.0's local folder with OldProfiles (8.2), and a start keeps a record that is
  # there (profileFolders.ts): taken out, so this start's own (by app) is what 8.moved-at-start reads.
  $inherited = Join-Path $locOld 'profile-move.json'
  if (Test-Path $inherited) { Remove-Item -LiteralPath $inherited -Force }
  if (Test-Path $inherited) { throw "the inherited record at $inherited couldn't be removed" }
  $p = Start-Process -FilePath $combExe -PassThru
  $null = $p.Handle
  WaitFor { $g = Get-Process -Id $p.Id -ErrorAction SilentlyContinue; $g -and $g.MainWindowHandle -ne 0 } 'Combwork running with its window'
  $rec = try { Get-Content -Raw (Join-Path $locComb 'profile-move.json') | ConvertFrom-Json } catch { $null }
  $moved = (Test-Path (Join-Path $roamComb 'edge-mark.txt')) -and (Test-Path (Join-Path $locComb 'edge-mark.txt')) -and -not (Test-Path $roamOld) -and -not (Test-Path $locOld)
  Check '8.moved-at-start' 'Combwork''s start moved 1.0''s folders (its record by app) and runs with its window' ($moved -and $rec -and $rec.by -eq 'app') "moved $moved; record $(if ($rec) { $rec | ConvertTo-Json -Compress } else { 'none' })"
  $i = Install $New
  $code = WaitExit $i 300
  $still = -not $p.HasExited
  Check '8.moved-at-start-installed' 'Installed again (exit 0): that Combwork closed, the 1.0 app removed, the folders still Combwork''s' ($code -eq 0 -and -not $still -and -not (Test-Path $oldKey) -and (Test-Path (Join-Path $roamComb 'edge-mark.txt')) -and (Test-Path (Join-Path $locComb 'edge-mark.txt')) -and -not (Test-Path $roamOld) -and -not (Test-Path $locOld)) "exit $code; still running $still; key $(Test-Path $oldKey); roaming Combwork $(Test-Path $roamComb), 1.0 $(Test-Path $roamOld)"
  $res.completed = $true
} catch {
  Check '8.error' 'The edge cases ran without an error' $false $_.Exception.Message
} finally {
  Save
}
"$(@($res.checks | Where-Object { $_.ok }).Count) of $($res.checks.Count) passed"
