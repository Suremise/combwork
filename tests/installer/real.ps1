# The installer handoff with Combwork's real installers (#1647), in Windows Sandbox only (never on the host): a local build's
# installer (npm run dist, local-setup.exe) and a release-style one of the same code (local: false, release-setup.exe) in
# the mapped build folder. Which ends up installed is read from the installed copy's resources\build-identity.json.
# Results in C:\out\real-results.txt, a line each (PASS/FAIL); exit 1 on any FAIL. -Timeout adds the 10-minute wait's
# timeout (about 11 minutes).
param([string]$Dir = 'C:\build', [switch]$Timeout)
$ErrorActionPreference = 'Stop'
# electron-builder's APP_GUID for appId it.surmise.combwork (UUID v5 in its namespace, HI-2460): the installers' mutex.
$mutex = '10a7595a-0e90-558c-b6b6-ae33bdd80748'
$installed = Join-Path $env:LOCALAPPDATA 'Programs\Combwork'
$exeName = 'Combwork.exe'
$out = 'C:\out\real-results.txt'
$fails = 0
function Say($ok, $what, $detail) {
  $line = "$(if ($ok) { 'PASS' } else { 'FAIL' }) $what $detail"
  Add-Content $out $line
  Write-Output $line
  if (-not $ok) { $script:fails++ }
}
function Run($file, [string[]]$params) { Start-Process -FilePath (Join-Path $Dir $file) -ArgumentList $params -PassThru }
function Wait-Exit($p, $secs = 900) { if (-not $p.WaitForExit($secs * 1000)) { throw "$($p.Id) hung" }; return $p.ExitCode }
function Identity { $f = Join-Path $installed 'resources\build-identity.json'; if (Test-Path $f) { return (Get-Content $f -Raw | ConvertFrom-Json) } else { return $null } }
function Held { try { [System.Threading.Mutex]::OpenExisting($mutex).Dispose(); return $true } catch { return $false } }
function Wait-Held { for ($i = 0; $i -lt 300; $i++) { if (Held) { return } ; Start-Sleep -Milliseconds 100 } ; throw 'the mutex was never taken' }
function Holder($secs, [switch]$Abandon) {
  $release = if ($Abandon) { '' } else { '$m.ReleaseMutex();' }
  Start-Process powershell -ArgumentList '-NoProfile', '-Command', "`$m = New-Object System.Threading.Mutex(`$true, '$mutex'); Start-Sleep -Seconds $secs; $release" -PassThru -WindowStyle Hidden
}
function Baseline {
  $c = Wait-Exit (Run 'release-setup.exe' @('/S'))
  $id = Identity
  if ($c -ne 0 -or -not $id -or $id.local) { throw "baseline release install failed: exit $c, identity $($id | ConvertTo-Json -Compress)" }
}

Set-Content $out "real installer handoff $(Get-Date -Format o)"

# 1. The pending update first: the release's installer as electron-updater runs it on quit (--updated /S), then the local
# one started while it runs. The local one waits, then installs last.
Baseline
New-Item -ItemType Directory -Force (Join-Path $env:LOCALAPPDATA 'hive-updater\pending') | Out-Null
Set-Content (Join-Path $env:LOCALAPPDATA 'hive-updater\pending\Hive-Setup-1.0.0-rc.2.exe') 'stand-in for a downloaded update'
$rel = Run 'release-setup.exe' @('--updated', '/S')
Wait-Held
$t0 = Get-Date
$loc = Run 'local-setup.exe' @('/S')
$rc = Wait-Exit $rel; $relEnd = Get-Date
$lc = Wait-Exit $loc; $locEnd = Get-Date
$id = Identity
Say ($rc -eq 0 -and $lc -eq 0 -and $id.local -eq $true -and $locEnd -gt $relEnd) 'pending update first: the local installer waits and its build is the one installed' "exits release $rc, local $lc; installed local=$($id.local); release done $([int]($relEnd - $t0).TotalSeconds) s, local $([int]($locEnd - $t0).TotalSeconds) s after the local one started"
Say (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'hive-updater\pending'))) "…and the local install dropped the updater's pending download" ''

# 2. The local installer first, then the pending update's (Combwork quit while it ran): the release's quits, the local stays.
Baseline
$loc = Run 'local-setup.exe' @('/S')
Wait-Held
$rel = Run 'release-setup.exe' @('--updated', '/S')
$rc = Wait-Exit $rel
$lc = Wait-Exit $loc
$id = Identity
Say ($lc -eq 0 -and $rc -ne 0 -and $id.local -eq $true) 'local first: the release installer quits, the local build is installed' "exits release $rc, local $lc; installed local=$($id.local)"

# 3. Another installer letting the mutex go (WAIT_OBJECT_0) after 15 s: the local one waits for it, then installs.
Baseline
$h = Holder 15
Wait-Held
$t0 = Get-Date
$lc = Wait-Exit (Run 'local-setup.exe' @('/S'))
$waited = ((Get-Date) - $t0).TotalSeconds
Wait-Exit $h | Out-Null
$id = Identity
Say ($lc -eq 0 -and $id.local -eq $true -and $waited -ge 12) 'a mutex released after 15 s: the local installer waits for it, then installs' "exit $lc; took $([int]$waited) s; installed local=$($id.local)"

# 4. One that ended holding it (WAIT_ABANDONED): the same.
Baseline
$h = Holder 10 -Abandon
Wait-Held
$lc = Wait-Exit (Run 'local-setup.exe' @('/S'))
Wait-Exit $h | Out-Null
$id = Identity
Say ($lc -eq 0 -and $id.local -eq $true) 'an abandoned mutex: the local installer installs after it' "exit $lc; installed local=$($id.local)"

# 5. The uninstaller never waits (its build has no wait): run while another holds the mutex, it finishes regardless.
$h = Holder 60
Wait-Held
$un = Get-ChildItem $installed -Filter 'Uninstall*.exe' | Select-Object -First 1
$t0 = Get-Date
$p = Start-Process -FilePath $un.FullName -ArgumentList '/S' -PassThru
$uc = Wait-Exit $p 120
$took = ((Get-Date) - $t0).TotalSeconds
# electron-builder's uninstaller copies itself and runs from a temp folder: give that a moment to remove the app.
for ($i = 0; $i -lt 300 -and (Test-Path (Join-Path $installed $exeName)); $i++) { Start-Sleep -Milliseconds 100 }
Say ($uc -eq 0 -and $took -lt 45 -and -not (Test-Path (Join-Path $installed $exeName))) 'the uninstaller, the mutex held: no wait, and it uninstalls' "exit $uc; took $([int]$took) s"
Stop-Process -Id $h.Id -ErrorAction SilentlyContinue

# 6. A release installer alone, with nothing installed: installs (no wait compiled into it).
$c = Wait-Exit (Run 'release-setup.exe' @('/S'))
$id = Identity
Say ($c -eq 0 -and $id.local -eq $false) 'a release installer alone installs' "exit $c"

# 7. (-Timeout) Held past the 10-minute wait: the local installer installs nothing, exits 3.
if ($Timeout) {
  $h = Holder 700
  Wait-Held
  $t0 = Get-Date
  $lc = Wait-Exit (Run 'local-setup.exe' @('/S')) 800
  $took = ((Get-Date) - $t0).TotalSeconds
  $id = Identity
  Say ($lc -eq 3 -and $id.local -eq $false -and $took -ge 590) 'held past its 10-minute wait: the local installer installs nothing, exit 3' "exit $lc; took $([int]$took) s; installed local=$($id.local)"
  Stop-Process -Id $h.Id -ErrorAction SilentlyContinue
}

Add-Content $out "done: $fails failed"
exit $(if ($fails) { 1 } else { 0 })
