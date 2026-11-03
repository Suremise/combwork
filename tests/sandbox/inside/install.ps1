# Runs inside the Sandbox as the user: runs an installer (or the uninstaller), waits for it, and records the result.
#   install.ps1 -Exe <installer> -Arguments '/S' -Name <prefix> [-Uninstall]
# Writes C:\out\<prefix>-run.json ({ exe, arguments, exitCode, seconds, hiveRunning, running }) and C:\out\<prefix>-state.json
# (install-state.ps1). Both identities (HI-2460): Combwork (Programs\Combwork\Combwork.exe) and Hive Desktop before it
# (Programs\Hive\Hive.exe). `running` names which one runs afterwards; `hiveRunning` is whether the one this installer
# installs does (Combwork's when it is installed). The NSIS uninstaller returns at once and finishes from a copy of
# itself, so with -Uninstall it waits (up to 120 s) until the install folder and the Installed-apps entry are gone.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Arguments = '/S',
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+$')][string]$Name,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$apps = @(
  @{ name = 'combwork'; exe = (Join-Path $env:LOCALAPPDATA 'Programs\Combwork\Combwork.exe'); key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\10a7595a-0e90-558c-b6b6-ae33bdd80748' },
  @{ name = 'hive'; exe = (Join-Path $env:LOCALAPPDATA 'Programs\Hive\Hive.exe'); key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\35960567-b95c-520c-a9f1-e8bb85764724' }
)
# The uninstaller's own app: the one whose folder it is in.
$own = $apps | Where-Object { (Split-Path -Parent $_.exe) -ieq (Split-Path -Parent $Exe) } | Select-Object -First 1
$sw = [Diagnostics.Stopwatch]::StartNew()
# Not -Wait: it waits for the whole process tree, which includes the app that --force-run starts.
$p = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
$null = $p.Handle # keeps the exit code available after exit
$p.WaitForExit()
$exitCode = $p.ExitCode
if ($Uninstall -and $own) {
  # A file being deleted can answer "Access is denied" for a moment: that counts as still there.
  $present = { try { (Test-Path $own.exe) -or (Test-Path $own.key) } catch { $true } }
  while ($sw.Elapsed.TotalSeconds -lt 120 -and (& $present)) { Start-Sleep -Milliseconds 500 }
}
$seconds = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
function RunningOf($a) { [bool](Get-CimInstance Win32_Process -Filter "Name='$(Split-Path -Leaf $a.exe)'" | Where-Object { $_.ExecutablePath -eq $a.exe -and $_.CommandLine -notmatch '--type=' }) }
# --force-run starts the app after the install: give it a moment, then see which runs.
$running = @()
if (-not $Uninstall) {
  for ($i = 0; $i -lt 20 -and -not $running.Count; $i++) {
    $running = @($apps | Where-Object { RunningOf $_ } | ForEach-Object { $_.name })
    if (-not $running.Count) { Start-Sleep -Milliseconds 500 }
  }
}
$installed = if (Test-Path $apps[0].exe) { 'combwork' } else { 'hive' }
$run = [ordered]@{ exe = $Exe; arguments = $Arguments; exitCode = $exitCode; seconds = $seconds; hiveRunning = ($running -contains $installed); running = $running }
[IO.File]::WriteAllText("C:\out\$Name-run.json", ($run | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
& (Join-Path $PSScriptRoot 'install-state.ps1') -Out "C:\out\$Name-state.json"
"exit $exitCode in $seconds s"
