# Runs inside the Sandbox as the user (HI-2460, scenario 8): the Combwork installer's edge cases over Hive Desktop 1.0,
# with real installers, in order on one machine:
#   8.1 Hive Desktop's installer mutex held: the new installer waits, changing nothing; released, it goes on and installs.
#   8.2 held past a test-shortened bound (-Short: an installer built with HIVE_TEST_SHORT_LEGACY_WAIT=1, 20 s): exit 4,
#       nothing changed.
#   8.3 Hive Desktop running and not closing (a stand-in at its exact Hive.exe that ignores the request): exit 5, Hive
#       Desktop and the profile folders untouched.
#   8.4 Hive Desktop's uninstall not finishing (its Hive.exe held open, so it can't be removed): exit 6, the profile
#       folders untouched.
#   8.5 Combwork running on Hive's folders (HI-2461's fallback) as the installer runs again: Combwork closes, the folders
#       move.
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
$hiveDir = Join-Path $env:LOCALAPPDATA 'Programs\Hive'
$hiveExe = Join-Path $hiveDir 'Hive.exe'
$combExe = Join-Path $env:LOCALAPPDATA 'Programs\Combwork\Combwork.exe'
$hiveKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$legacy"
$roamHive = Join-Path $env:APPDATA 'Hive'
$roamComb = Join-Path $env:APPDATA 'Combwork'
$locHive = Join-Path $env:LOCALAPPDATA 'Hive'
$locComb = Join-Path $env:LOCALAPPDATA 'Combwork'

function Install([string]$exe, [string]$arguments = '/S') { $p = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru; $null = $p.Handle; return $p }
function WaitExit($p, [int]$secs) { if ($p.WaitForExit($secs * 1000)) { return $p.ExitCode } else { return 'timeout' } }
# A process holding Hive Desktop's installer mutex for $secs, owned from its start (as a running 1.0 installer would).
function Holder([int]$secs) {
  $h = Start-Process powershell -ArgumentList '-NoProfile', '-Command', "`$m = New-Object System.Threading.Mutex(`$true, '$legacy'); [IO.File]::WriteAllText('C:\out\holder.txt', 'held'); Start-Sleep -Seconds $secs; `$m.ReleaseMutex()" -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 100 -and -not (Test-Path 'C:\out\holder.txt'); $i++) { Start-Sleep -Milliseconds 100 }
  Remove-Item 'C:\out\holder.txt' -ErrorAction SilentlyContinue
  return $h
}
# Profile folders under Hive's names with a file each, as 1.0 leaves them (each case checks they stayed or moved).
function HiveProfiles {
  foreach ($p in @($roamComb, $locComb)) { if (Test-Path $p) { Rename-Item $p -NewName 'Hive' } }
  foreach ($p in @($roamHive, $locHive)) { New-Item -ItemType Directory -Force $p | Out-Null; Set-Content (Join-Path $p 'edge-mark.txt') 'mark' }
}
function ProfilesUntouched { (Test-Path (Join-Path $roamHive 'edge-mark.txt')) -and (Test-Path (Join-Path $locHive 'edge-mark.txt')) -and -not (Test-Path $roamComb) -and -not (Test-Path $locComb) }
function InstallPrev { $c = WaitExit (Install $Prev) 300; if ($c -ne 0 -or -not (Test-Path $hiveExe)) { throw "Hive Desktop 1.0 didn't install: exit $c" } }

try {
  # 8.1: waits while held, then goes on.
  InstallPrev
  HiveProfiles
  $h = Holder 45
  $p = Install $New
  Start-Sleep -Seconds 20
  $waiting = -not $p.HasExited
  Check '8.wait' 'Hive Desktop''s installer mutex held: the new installer waits' $waiting "exited with $($p.ExitCode) while the mutex was held"
  Check '8.wait-unchanged' 'While it waits nothing changes: Hive Desktop installed, no Combwork, the profile folders as they were' ((Test-Path $hiveExe) -and (Test-Path $hiveKey) -and -not (Test-Path $combExe) -and (ProfilesUntouched)) "hive $(Test-Path $hiveExe), key $(Test-Path $hiveKey), combwork $(Test-Path $combExe), profiles $(ProfilesUntouched)"
  $code = WaitExit $p 180
  Check '8.continues' 'Released, it goes on: installed (exit 0), Hive Desktop removed, the folders moved' ($code -eq 0 -and (Test-Path $combExe) -and -not (Test-Path $hiveKey) -and (Test-Path (Join-Path $roamComb 'edge-mark.txt')) -and (Test-Path (Join-Path $locComb 'edge-mark.txt'))) "exit $code; combwork $(Test-Path $combExe); key $(Test-Path $hiveKey)"
  Stop-Process -Id $h.Id -ErrorAction SilentlyContinue

  # 8.2: held past the shortened bound: refuses.
  InstallPrev
  HiveProfiles
  $stamp = (Get-Item $combExe).LastWriteTimeUtc
  $h = Holder 180
  $p = Install $Short
  $code = WaitExit $p 120
  Check '8.refuses' 'Held past its bound (20 s here): the installer stops (exit 4)' ($code -eq 4) "exit $code"
  Check '8.refuses-unchanged' 'Nothing changed: Hive Desktop installed, Combwork not reinstalled, the profile folders as they were' ((Test-Path $hiveExe) -and (Test-Path $hiveKey) -and ((Get-Item $combExe).LastWriteTimeUtc -eq $stamp) -and (ProfilesUntouched)) "hive $(Test-Path $hiveExe), key $(Test-Path $hiveKey), profiles $(ProfilesUntouched)"
  Stop-Process -Id $h.Id -ErrorAction SilentlyContinue

  # 8.3: Hive Desktop running, not closing: a stand-in at its exact Hive.exe (Node) that ignores the request.
  Rename-Item $hiveExe -NewName 'Hive.real.exe'
  Copy-Item 'C:\tools\node\node.exe' $hiveExe
  Set-Content 'C:\out\stay.cjs' "setInterval(() => {}, 1000)"
  $stay = Start-Process -FilePath $hiveExe -ArgumentList 'C:\out\stay.cjs' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $p = Install $New
  $code = WaitExit $p 240
  Check '8.running' 'Hive Desktop running and not closing: the installer stops (exit 5)' ($code -eq 5) "exit $code"
  Check '8.running-unchanged' 'Nothing changed: Hive Desktop installed, the profile folders as they were' ((Test-Path $hiveKey) -and (Test-Path $hiveExe) -and (ProfilesUntouched)) "key $(Test-Path $hiveKey), profiles $(ProfilesUntouched)"
  Stop-Process -Id $stay.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Remove-Item $hiveExe -Force
  Rename-Item (Join-Path $hiveDir 'Hive.real.exe') -NewName 'Hive.exe'

  # 8.4: its uninstall can't remove Hive.exe (held open, not running): exit 6, the profile folders untouched.
  $hold = Start-Process powershell -ArgumentList '-NoProfile', '-Command', "`$f = [IO.File]::Open('$hiveExe', 'Open', 'Read', 'None'); [IO.File]::WriteAllText('C:\out\held.txt', 'held'); Start-Sleep 300; `$f.Close()" -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 100 -and -not (Test-Path 'C:\out\held.txt'); $i++) { Start-Sleep -Milliseconds 100 }
  $p = Install $New
  $code = WaitExit $p 300
  Check '8.uninstall-fails' 'Hive Desktop''s uninstall not finishing: the installer stops (exit 6)' ($code -eq 6) "exit $code"
  Check '8.uninstall-fails-unchanged' 'The profile folders as they were' (ProfilesUntouched) "profiles $(ProfilesUntouched)"
  Stop-Process -Id $hold.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  # 8.5: Combwork running on Hive's folders (the fallback): the installer closes it, removes what is left of Hive
  # Desktop, and moves the folders.
  InstallPrev
  $p = Start-Process -FilePath $combExe -PassThru
  for ($i = 0; $i -lt 120; $i++) { $g = Get-Process -Id $p.Id -ErrorAction SilentlyContinue; if ($g -and $g.MainWindowHandle -ne 0) { break }; Start-Sleep -Milliseconds 500 }
  $up = [bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue)
  Check '8.fallback-running' 'Combwork runs on Hive''s folders (the fallback)' ($up -and (Test-Path $roamHive) -and -not (Test-Path $roamComb)) "running $up"
  $i = Install $New
  $code = WaitExit $i 300
  $still = [bool](Get-CimInstance Win32_Process -Filter "Name='Combwork.exe'" | Where-Object { $_.ProcessId -eq $p.Id })
  Check '8.fallback-moved' 'Installed again (exit 0): that Combwork closed, Hive Desktop removed, the folders moved' ($code -eq 0 -and -not $still -and -not (Test-Path $hiveKey) -and (Test-Path (Join-Path $roamComb 'edge-mark.txt')) -and (Test-Path (Join-Path $locComb 'edge-mark.txt')) -and -not (Test-Path $roamHive)) "exit $code; still running $still; key $(Test-Path $hiveKey); roaming Combwork $(Test-Path $roamComb)"
  $res.completed = $true
} catch {
  Check '8.error' 'The edge cases ran without an error' $false $_.Exception.Message
} finally {
  Save
}
"$(@($res.checks | Where-Object { $_.ok }).Count) of $($res.checks.Count) passed"
