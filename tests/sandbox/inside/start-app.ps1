# Runs inside the Sandbox as the user: starts an installed app and waits until its exact main process runs with a
# window, so a step that needs it running (the previous release, as the new installer starts: HI-2460) never races it.
#   start-app.ps1 -Exe <path> -Name <prefix> [-TimeoutSec 90]
# Writes C:\out\<prefix>.json ({ exe, pid, window, seconds }); exit 0 once it runs with a window, 1 if it never did.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+$')][string]$Name,
  [int]$TimeoutSec = 90
)
$ErrorActionPreference = 'Stop'
$exe = [Environment]::ExpandEnvironmentVariables($Exe)
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process -FilePath $exe | Out-Null
$found = $null
$window = $false
while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
  $main = Get-CimInstance Win32_Process -Filter "Name='$(Split-Path -Leaf $exe)'" | Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
  if ($main) {
    $found = $main.ProcessId
    $p = Get-Process -Id $found -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { $window = $true; break }
  }
  Start-Sleep -Milliseconds 500
}
$r = [ordered]@{ exe = $exe; pid = $found; window = $window; seconds = [Math]::Round($sw.Elapsed.TotalSeconds, 1) }
[IO.File]::WriteAllText("C:\out\$Name.json", ($r | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
if ($window) { "running: pid $found with a window in $($r.seconds) s"; exit 0 }
"not running with a window after $TimeoutSec s (pid $found)"
exit 1
