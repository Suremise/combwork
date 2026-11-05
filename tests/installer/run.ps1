# The installer handoff's checks (#1647), run in Windows Sandbox only (never on the host) with build.mjs's stand-ins in
# the mapped build folder (C:\build) and results in C:\out\results.txt. Each case starts the stand-ins as electron-updater
# and the user would (silent, /S), in an order, and reads their exit codes and logs (C:\out\<name>.log: start and end
# ticks). PASS or FAIL a line each; exit 1 on any FAIL.
param([string]$Dir = 'C:\build')
$ErrorActionPreference = 'Stop'
$mutex = 'hive-test-1647-installer-mutex'
$out = 'C:\out\results.txt'
$fails = 0
function Say($ok, $what, $detail) {
  $line = "$(if ($ok) { 'PASS' } else { 'FAIL' }) $what $detail"
  Add-Content $out $line
  Write-Output $line
  if (-not $ok) { $script:fails++ }
}
function Start-Stand($file, $name) { Start-Process -FilePath (Join-Path $Dir $file) -ArgumentList '/S', "/NAME=$name" -PassThru }
function Ticks($name) {
  $f = "C:\out\$name.log"
  if (-not (Test-Path $f)) { return $null }
  $t = @{}
  foreach ($l in Get-Content $f) { $p = $l -split ' '; $t[$p[0]] = [uint32]$p[1] }
  return $t
}
# A process holding the test mutex for $secs, then releasing it (or exiting without: abandoned).
function Start-Holder($secs, [switch]$Abandon) {
  $release = if ($Abandon) { '' } else { '$m.ReleaseMutex();' }
  $cmd = "`$m = New-Object System.Threading.Mutex(`$true, '$mutex'); Start-Sleep -Seconds $secs; $release"
  Start-Process powershell -ArgumentList '-NoProfile', '-Command', $cmd -PassThru -WindowStyle Hidden
}
# Until the test mutex exists (the stand-in or holder started first holds it), so the order is the case's, not a race.
function Wait-Held { for ($i = 0; $i -lt 100; $i++) { try { [System.Threading.Mutex]::OpenExisting($mutex).Dispose(); return } catch { Start-Sleep -Milliseconds 100 } } throw 'the mutex was never taken' }
function Wait-Exit($p) { if (-not $p.WaitForExit(120000)) { throw "$($p.Id) hung" }; return $p.ExitCode }

Set-Content $out "installer handoff checks $(Get-Date -Format o)"

# 1. Alone: installs at once.
$p = Start-Stand 'local.exe' 'solo'
$code = Wait-Exit $p
Say ($code -eq 0 -and (Ticks 'solo')) 'a local installer alone installs' "exit $code"

# 2. The release installer first (electron-updater's install on quit), then the local one: it waits, and installs last.
$rel = Start-Stand 'release.exe' 'rel'
Wait-Held
$loc = Start-Stand 'local.exe' 'loc'
$rc = Wait-Exit $rel; $lc = Wait-Exit $loc
$r = Ticks 'rel'; $l = Ticks 'loc'
Say ($rc -eq 0 -and $lc -eq 0 -and $r -and $l -and $l.start -ge $r.end) 'release first: the local installer waits for it and installs last' "exits $rc/$lc; release ended $($r.end), local started $($l.start)"

# 3. The local installer first, then the release one (Combwork quit while it ran): the release quits, installing nothing.
$loc = Start-Stand 'local.exe' 'loc2'
Wait-Held
$rel = Start-Stand 'release.exe' 'rel2'
$rc = Wait-Exit $rel; $lc = Wait-Exit $loc
Say ($rc -eq 4 -and -not (Ticks 'rel2') -and $lc -eq 0 -and (Ticks 'loc2')) 'local first: the release installer quits and installs nothing' "exits release $rc, local $lc"

# 4. An installer that ended without letting the mutex go (abandoned): the local one goes on once it has ended.
$h = Start-Holder 3 -Abandon
Wait-Held
$loc = Start-Stand 'local.exe' 'loc3'
$lc = Wait-Exit $loc
Wait-Exit $h | Out-Null
Say ($lc -eq 0 -and (Ticks 'loc3')) 'an abandoned mutex: the local installer installs after it' "exit $lc"

# 5. Held past the wait (3 s here): nothing installed, exit 3.
$h = Start-Holder 20
Wait-Held
$loc = Start-Stand 'local-short.exe' 'loc4'
$lc = Wait-Exit $loc
Say ($lc -eq 3 -and -not (Ticks 'loc4')) 'held past its wait: the local installer installs nothing and exits 3' "exit $lc"
Wait-Exit $h | Out-Null

# 6. A release installer alone still installs (nothing of the wait in it).
$p = Start-Stand 'release.exe' 'rel3'
$code = Wait-Exit $p
Say ($code -eq 0 -and (Ticks 'rel3')) 'a release installer alone installs' "exit $code"

Add-Content $out "done: $fails failed"
exit $(if ($fails) { 1 } else { 0 })
