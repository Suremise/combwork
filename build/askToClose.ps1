# Asks the Combwork this installer is about to replace to close for the install (HI-1707), before the template's check ends
# it: run by installer.nsh's customInit (the outer instance, as the user), bundled into the installer.
#
# Finds the main Combwork process of this install folder only (its exact executable, not a renderer or helper: no --type=),
# writes Hive's request into its profile (written beside it, then renamed: Hive never reads half of one), waits for
# Combwork's acknowledgement, then for that process to exit (a handle on it, never its name). Combwork checks the request is for
# it (its id, its start, its executable) and fresh, records and tells its agents, and quits.
#
# Exit codes, for the installer's log: 0 no Combwork of this folder running, or it closed; 2 no profile to write to;
# 3 no acknowledgement (the request is removed, and the template's check ends Combwork as before); 4 acknowledged but still
# running when the wait ran out; 5 anything else that went wrong.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  # The running app's profile (HI-2461): Combwork's once a Combwork build has moved it, else Hive's (a 1.0 being replaced).
  [string]$Profile = $(if (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Combwork') -PathType Container) { Join-Path $env:APPDATA 'Combwork' } else { Join-Path $env:APPDATA 'Hive' }),
  [string]$ExeName = 'Hive.exe',
  [int]$AckMs = 3000,
  [int]$ExitMs = 30000
)
$ErrorActionPreference = 'Stop'
try {
  $exe = Join-Path $InstallDir $ExeName
  $main = Get-CimInstance Win32_Process -Filter "Name = '$ExeName'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $exe -and ($_.CommandLine -notmatch '--type=') } | Select-Object -First 1
  if (-not $main) { exit 0 }
  if (-not (Test-Path -LiteralPath $Profile -PathType Container)) { exit 2 }
  # The handle first: the process can't be another one with the same id once it is open.
  $proc = [Diagnostics.Process]::GetProcessById([int]$main.ProcessId)
  $nonce = [guid]::NewGuid().ToString()
  $request = [ordered]@{
    v = 1
    nonce = $nonce
    pid = [int]$main.ProcessId
    pidCreated = $main.CreationDate.ToUniversalTime().ToString('o')
    exe = $exe
    reason = 'install'
    at = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress
  $file = Join-Path $Profile 'restart-request.json'
  [IO.File]::WriteAllText("$file.tmp", $request, (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath "$file.tmp" -Destination $file -Force
  $ack = Join-Path $Profile "restart-ack-$nonce.json"
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath $ack) -and $clock.ElapsedMilliseconds -lt $AckMs) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $ack)) {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    exit 3
  }
  if ($proc.WaitForExit($ExitMs)) { exit 0 }
  exit 4
} catch {
  exit 5
}
