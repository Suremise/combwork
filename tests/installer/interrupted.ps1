# An interrupted update and its recovery (HI-3172) with Combwork's real installers, in Windows Sandbox only (never on the
# host). The mapped build folder (C:\build) holds old-setup.exe (a published release, the copy being updated, its own
# uninstaller), new-setup.exe (a local build of this branch), new-short-setup.exe (the same with
# CW_TEST_SHORT_RECOVERY_WAIT=1: a 20 s recovery-lock wait) and build\recovery.ps1 (for its descriptor check).
# Interruptions are the installer's process tree killed (taskkill /F /T): the first once the old Combwork.exe is gone
# (the old uninstaller has run), a resumed run's once the new copy's files start arriving. "Sign-in" here is the Run
# value's command run as Windows runs it at a sign-in (Run values aren't consumed: Windows leaves them in place), each
# result line says so; no case signs out. Results in C:\out\interrupted-results.txt, a line each (PASS/FAIL); exit 1 on
# any FAIL. -Only a,c,lock runs only those cases (the letter each case's result lines start with).
param([string]$Dir = 'C:\build', [string[]]$Only = @())
$ErrorActionPreference = 'Stop'
# powershell -File passes -Only a,b as one string.
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$out = 'C:\out\interrupted-results.txt'
$guid = '10a7595a-0e90-558c-b6b6-ae33bdd80748'
$runKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
$value = 'CombworkFinishUpdate'
$userDir = Join-Path $env:LOCALAPPDATA 'Programs\Combwork'
$machineDir = Join-Path $env:ProgramFiles 'Combwork'
$userRec = Join-Path $env:LOCALAPPDATA 'combwork-resume'
$machineRec = Join-Path $env:ProgramData 'Combwork\resume'
$newHash = (Get-FileHash (Join-Path $Dir 'new-setup.exe') -Algorithm SHA256).Hash
$checker = Join-Path $Dir 'recovery.ps1'
$fails = 0
function Say($ok, $what, $detail) {
  $line = "$(if ($ok) { 'PASS' } else { 'FAIL' }) $what $detail"
  Add-Content $out $line
  Write-Output $line
  if (-not $ok) { $script:fails++ }
}
function Log($what) { Add-Content $out "  $what"; Write-Output "  $what" }

function RegRoot($scope) { if ($scope -eq 'machine') { 'HKLM:' } else { 'HKCU:' } }
function RunValue($scope) { (Get-ItemProperty -Path "$(RegRoot $scope)\$runKey" -Name $value -ErrorAction SilentlyContinue).$value }
function RecDir($scope) { if ($scope -eq 'machine') { $machineRec } else { $userRec } }
function Payload($scope) { Join-Path (RecDir $scope) 'Combwork-Setup.exe' }
function PayloadHash($scope) { $p = Payload $scope; if (Test-Path -LiteralPath $p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash } else { $null } }
function Identity($folder) { $f = Join-Path $folder 'resources\build-identity.json'; if (Test-Path $f) { Get-Content $f -Raw | ConvertFrom-Json } else { $null } }
function IsNew($folder) { $id = Identity $folder; return ($id -and $id.local -eq $true -and (Test-Path (Join-Path $folder 'Combwork.exe'))) }
function IsOld($folder) { $id = Identity $folder; return ($id -and $id.local -ne $true -and (Test-Path (Join-Path $folder 'Combwork.exe'))) }
function Run($file, [string[]]$params) {
  if ($params) { return Start-Process -FilePath (Join-Path $Dir $file) -ArgumentList $params -PassThru }
  return Start-Process -FilePath (Join-Path $Dir $file) -PassThru
}
function Wait-Exit($p, $secs = 600) { if (-not $p.WaitForExit($secs * 1000)) { throw "$($p.Id) hung" }; return $p.ExitCode }
function Kill-Tree($p) { & taskkill.exe /F /T /PID $p.Id 2>&1 | Out-Null; $p.WaitForExit(30000) | Out-Null }
function Until($what, [scriptblock]$cond, $secs = 300) {
  $end = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $end) { if (& $cond) { return }; Start-Sleep -Milliseconds 50 }
  throw "timed out waiting for: $what"
}

# Clicks buttons in a process's dialogs until it exits (a shown installer: the resume question, its pages), by control
# ID with BM_CLICK, so nothing depends on which window has the focus: $first once, when a visible, enabled one is found
# (7, No to the question), then any of $then each time (6 Yes, 1 OK/Next/Finish, 2 Cancel).
$presser = @'
param([int]$TargetPid, [string]$First = '', [string]$Then = '6,1')
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class CwUi {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static bool Click(int pid, int[] ids) {
    var wins = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) wins.Add(h); return true; }, IntPtr.Zero);
    foreach (var w in wins) foreach (var id in ids) {
      var b = GetDlgItem(w, id);
      if (b != IntPtr.Zero && IsWindowVisible(b) && IsWindowEnabled(b)) { PostMessage(b, 0x00F5, IntPtr.Zero, IntPtr.Zero); return true; }
    }
    return false;
  }
}
"@
$ids = { param($s) [int[]]@($s -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ }) }
$todo = & $ids $First
$always = & $ids $Then
while (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) {
  if ($todo.Count) { if ([CwUi]::Click($TargetPid, $todo)) { $todo = @() } }
  else { [CwUi]::Click($TargetPid, $always) | Out-Null }
  Start-Sleep -Milliseconds 1500
}
'@
Set-Content 'C:\out\presser.ps1' $presser
function Start-Presser($p, [int[]]$then = @(6, 1), [int[]]$first = @()) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\out\presser.ps1', '-TargetPid', $p.Id, '-Then', ($then -join ','))
  if ($first.Count) { $a += @('-First', ($first -join ',')) }
  Start-Process powershell -ArgumentList $a -PassThru -WindowStyle Hidden
}
# The Run value's command, run as a sign-in runs it: its executable and its arguments.
function Start-RunValue($scope) {
  $cmd = RunValue $scope
  if (-not $cmd -or -not $cmd.StartsWith('"')) { throw "no Run value to run ($cmd)" }
  $q = $cmd.IndexOf('"', 1)
  return Start-Process -FilePath $cmd.Substring(1, $q - 1) -ArgumentList $cmd.Substring($q + 1).Trim() -PassThru
}
# The Run value's command run to its end, Yes to its question (as at a sign-in, a person answering): its exit code.
function Finish-RunValue($scope) {
  $p = Start-RunValue $scope
  $k = Start-Presser $p
  $c = Wait-Exit $p
  Stop-Process -Id $k.Id -ErrorAction SilentlyContinue
  return $c
}
# Combwork started from its folder, then stopped (only that one, by its path).
function Starts($folder) {
  $exe = Join-Path $folder 'Combwork.exe'
  Start-Process -FilePath $exe | Out-Null
  $ok = $false
  for ($i = 0; $i -lt 200; $i++) { if (Get-Process | Where-Object { $_.Path -eq $exe -and -not $_.HasExited }) { $ok = $true; break }; Start-Sleep -Milliseconds 100 }
  Start-Sleep -Seconds 5
  $alive = [bool](Get-Process | Where-Object { $_.Path -eq $exe })
  Get-Process | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
  return ($ok -and $alive)
}
function Want($case) { return ($Only.Count -eq 0 -or $Only -contains $case) }
function Reset {
  Get-Process | Where-Object { $_.Path -and $_.Path -like '*\Combwork.exe' } | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($d in @($userDir, $machineDir, 'C:\Custom Apps\My Combwork', 'C:\Custom Apps\CW\Combwork', 'C:\Custom Apps\CW')) {
    $un = Get-ChildItem -LiteralPath $d -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($un) { $p = Start-Process -FilePath $un.FullName -ArgumentList '/S', "_?=$d" -PassThru; $p.WaitForExit(120000) | Out-Null }
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
  }
  foreach ($s in 'user', 'machine') { Remove-ItemProperty -Path "$(RegRoot $s)\$runKey" -Name $value -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $userRec -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $env:ProgramData 'Combwork') -Recurse -Force -ErrorAction SilentlyContinue
}
function InstallOld($scope, $folder = '') {
  $a = @('/S', $(if ($scope -eq 'machine') { '/allusers' } else { '/currentuser' }))
  if ($folder) { $a += "/D=$folder" }
  $c = Wait-Exit (Run 'old-setup.exe' $a)
  $target = if ($folder) { $folder } elseif ($scope -eq 'machine') { $machineDir } else { $userDir }
  if ($c -ne 0 -or -not (IsOld $target)) { throw "old install ($scope $folder) failed: exit $c" }
}
# An update interrupted once the old copy is gone.
function Interrupt-Update($scope, [string[]]$params, $folder) {
  $p = Run 'new-setup.exe' $params
  Until 'the old Combwork.exe removed' { -not (Test-Path (Join-Path $folder 'Combwork.exe')) -or $p.HasExited }
  if ($p.HasExited) { throw "the update ended before it could be interrupted (exit $($p.ExitCode))" }
  Kill-Tree $p
}
function Sddl($path) { (Get-Acl -LiteralPath $path).Sddl }
function Trusted($path) { (& powershell -NoProfile -ExecutionPolicy Bypass -File $checker -CheckSddl (Sddl $path)) -eq 'trusted' }

# A standard user, for the per-machine probes.
$stdUser = 'cwprobe'
$stdPass = 'Cw!' + [guid]::NewGuid().ToString('N').Substring(0, 10)
& cmd.exe /c "net user $stdUser /delete >nul 2>&1"
& net.exe user $stdUser $stdPass /add | Out-Null
$stdCred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$stdUser", (ConvertTo-SecureString $stdPass -AsPlainText -Force))
# An action as that user: "allowed" if it ran without an error, else "denied". (A process started with -Credential
# gives back no exit code: the answer comes in a file that user can write.)
function AsStd([string]$action) {
  $res = 'C:\Users\Public\cwprobe.txt'
  Remove-Item $res -ErrorAction SilentlyContinue
  $command = "`$ErrorActionPreference = 'Stop'; `$r = try { $action; 'allowed' } catch { 'denied' }; Set-Content '$res' `$r"
  $p = Start-Process powershell -Credential $stdCred -ArgumentList '-NoProfile', '-Command', $command -PassThru -WindowStyle Hidden -WorkingDirectory 'C:\'
  $p.WaitForExit(120000) | Out-Null
  Until 'the probe answering' { Test-Path $res } 30
  return (Get-Content $res -Raw).Trim()
}

Set-Content $out "interrupted update checks $(Get-Date -Format o)"

if (Want 'a') {
# (a) A normal update, shown (as Install now runs it: --updated --force-run): no recovery left behind.
Reset
InstallOld 'user'
$p = Run 'new-setup.exe' @('--updated', '--force-run')
$k = Start-Presser $p
$c = Wait-Exit $p
Stop-Process -Id $k.Id -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.Path -eq (Join-Path $userDir 'Combwork.exe') } | Stop-Process -Force -ErrorAction SilentlyContinue
Say ($c -eq 0 -and (IsNew $userDir) -and -not (RunValue 'user') -and -not (Test-Path $userRec)) '(a) a shown update finishes and leaves no recovery' "exit $c; Run value '$(RunValue 'user')'; folder $(Test-Path $userRec)"
}

if (Want 'b') {
# (b) Cancelled before the install: a manual install over a per-user copy shows the scope page; Escape cancels it.
# Nothing armed, the old copy kept. (Both scopes installed can't be set up: an all-users install removes the per-user one.)
Reset
InstallOld 'user'
$p = Run 'new-setup.exe' @()
$k = Start-Presser $p @(2, 6)
$c = Wait-Exit $p 120
Stop-Process -Id $k.Id -ErrorAction SilentlyContinue
Say ((IsOld $userDir) -and -not (RunValue 'user') -and -not (Test-Path $userRec)) '(b) cancelled on the scope page: nothing armed, the old copy kept' "exit $c"
}

if (Want 'c') {
# (c) Two interruptions, then finished: per-user, shown, as Install now runs it.
Reset
InstallOld 'user'
Interrupt-Update 'user' @('--updated', '--force-run') $userDir
$cmd = RunValue 'user'
$want = "`"$userRec\Combwork-Setup.exe`" --cw-resume --updated --force-run /currentuser /D=$userDir"
Say ($cmd -eq $want -and (PayloadHash 'user') -eq $newHash -and -not (Test-Path (Join-Path $userDir 'Combwork.exe'))) '(c) interrupted after the old copy went: the Run value and a checked copy are there' "Run value '$cmd'"
# The resumed run (Run value run by hand, as at a sign-in), Yes to its question, interrupted as the new files arrive.
$p = Start-RunValue 'user'
$k = Start-Presser $p
Until 'the new files arriving' { (Test-Path $userDir) -and (Get-ChildItem -LiteralPath $userDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1) -or $p.HasExited }
$early = $p.HasExited
Kill-Tree $p
Stop-Process -Id $k.Id -ErrorAction SilentlyContinue
Say (-not $early -and (RunValue 'user') -eq $want -and (PayloadHash 'user') -eq $newHash) '(c) the resumed run interrupted too (Run value run by hand): the Run value and the copy are unchanged' "ended early: $early"
# Declined: No keeps it for the next sign-in.
$p = Start-RunValue 'user'
$k = Start-Presser $p @(1, 2) @(7)
$c = Wait-Exit $p 120
Stop-Process -Id $k.Id -ErrorAction SilentlyContinue
Say ($c -eq 8 -and (RunValue 'user') -eq $want -and (PayloadHash 'user') -eq $newHash) '(c) declined at the question (Run value run by hand): exit 8, recovery kept' "exit $c"
# Finished at last.
$p = Start-RunValue 'user'
$k = Start-Presser $p
$c = Wait-Exit $p
Stop-Process -Id $k.Id -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.Path -eq (Join-Path $userDir 'Combwork.exe') } | Stop-Process -Force -ErrorAction SilentlyContinue
Say ($c -eq 0 -and (IsNew $userDir) -and -not (RunValue 'user') -and (Test-Path (Payload 'user'))) '(c) finished (Run value run by hand): the new Combwork installed, the Run value gone, its own copy left inert' "exit $c"
Say (Starts $userDir) '(c) ...and the new Combwork starts' ''
# The next install removes the inert copy.
$c = Wait-Exit (Run 'new-setup.exe' @('--updated', '/S'))
Say ($c -eq 0 -and -not (Test-Path $userRec) -and -not (RunValue 'user')) '(c) the next install removes the leftover copy' "exit $c"
}

if (Want 'd') {
# (d) A custom folder: kept by the recovery, with its scope.
Reset
# Its name has Combwork in it: a shown install (the resumed run) appends \Combwork to a folder that doesn't (electron-
# builder's instFilesPre), as any shown update of such an install does.
$custom = 'C:\Custom Apps\My Combwork'
InstallOld 'user' $custom
Interrupt-Update 'user' @('--updated', '/S') $custom
$cmd = RunValue 'user'
Say ($cmd -like "*--cw-resume --updated /currentuser /D=$custom") '(d) a custom folder: the Run value names it and the scope' "Run value '$cmd'"
$c = Finish-RunValue 'user'
Say ($c -eq 0 -and (IsNew $custom) -and -not (Test-Path $userDir) -and -not (RunValue 'user')) '(d) ...the resumed run (Run value run by hand) installs it there' "exit $c"
}

if (Want 'e') {
# (e) Arming fails (the recovery folder denies this user writing): refused, exit 7, nothing removed or armed.
Reset
InstallOld 'user'
New-Item -ItemType Directory -Force $userRec | Out-Null
& icacls.exe $userRec /deny "$env:USERNAME`:(OI)(CI)(W)" | Out-Null
$c = Wait-Exit (Run 'new-setup.exe' @('--updated', '/S'))
Say ($c -eq 7 -and (IsOld $userDir) -and -not (RunValue 'user')) '(e) a recovery that cannot be staged: refused before anything is removed' "exit $c"
Say (Starts $userDir) '(e) ...and the old Combwork still starts' ''
& icacls.exe $userRec /remove:d "$env:USERNAME" | Out-Null
}

if (Want 'g') {
# (g) A failed second installer with a recovery armed: the recovery is untouched and still finishes.
Reset
InstallOld 'user'
Interrupt-Update 'user' @('--updated', '/S') $userDir
$cmd = RunValue 'user'; $hash = PayloadHash 'user'
Set-Content (Join-Path $userRec 'junk.txt') 'makes staging refuse'
$c = Wait-Exit (Run 'new-setup.exe' @('/S'))
Say ($c -eq 7 -and (RunValue 'user') -eq $cmd -and (PayloadHash 'user') -eq $hash) '(g) a second installer refused while a recovery is armed: its Run value and copy unchanged' "exit $c"
Remove-Item (Join-Path $userRec 'junk.txt')
$c = Finish-RunValue 'user'
Say ($c -eq 0 -and (IsNew $userDir) -and -not (RunValue 'user')) '(g) ...and that recovery (Run value run by hand) still finishes' "exit $c"
}

if (Want 'f') {
# (f) Per-machine: HKLM and ProgramData, a folder only administrators can change.
Reset
InstallOld 'machine'
Interrupt-Update 'machine' @('--updated', '/S') $machineDir
$cmd = RunValue 'machine'
Say ($cmd -like "`"$machineRec\Combwork-Setup.exe`" --cw-resume --updated /allusers /D=$machineDir" -and (PayloadHash 'machine') -eq $newHash -and -not (RunValue 'user')) '(f) per-machine interrupted: an HKLM Run value with /allusers, the copy in ProgramData' "Run value '$cmd'"
Say ((Trusted $machineRec) -and (Trusted (Split-Path $machineRec)) -and (Trusted (Payload 'machine'))) '(f) ...the folders and the copy pass the trust check' "$(Sddl $machineRec)"
$ok = AsStd "Get-ChildItem -LiteralPath '$machineRec' | Out-Null"
$w = AsStd "[IO.File]::WriteAllText('$(Payload 'machine')', 'x')"
$n = AsStd "[IO.File]::WriteAllText('$machineRec\x.txt', 'x')"
$r = AsStd "Rename-Item -LiteralPath '$machineRec' -NewName 'moved'"
Say ($ok -eq 'allowed' -and $w -eq 'denied' -and $n -eq 'denied' -and $r -eq 'denied' -and (PayloadHash 'machine') -eq $newHash) '(f) a standard user can read the folder but not replace the copy, add a file or rename it' "read $ok; write $w, create $n, rename $r"
$c = Finish-RunValue 'machine'
Say ($c -eq 0 -and (IsNew $machineDir) -and -not (RunValue 'machine')) '(f) the resumed run (Run value run by hand) finishes the per-machine install' "exit $c"

# (f) A recovery folder a standard user made first (their own, their full control): refused, and left as it was.
Reset
InstallOld 'machine'
$code = AsStd "New-Item -ItemType Directory -Force '$machineRec' | Out-Null"
$before = Sddl $machineRec
$c = Wait-Exit (Run 'new-setup.exe' @('--updated', '/S'))
Say ($code -eq 'allowed' -and $c -eq 7 -and (Sddl $machineRec) -eq $before -and (IsOld $machineDir) -and -not (RunValue 'machine')) "(f) a standard user's recovery folder: refused, its owner and ACL unchanged, the old copy kept" "exit $c; $before"

# (f) A child junction out of a trusted recovery folder: refused, its target untouched.
Reset
InstallOld 'machine'
Interrupt-Update 'machine' @('--updated', '/S') $machineDir
$cmd = RunValue 'machine'; $hash = PayloadHash 'machine'
New-Item -ItemType Directory -Force 'C:\canary' | Out-Null
Set-Content 'C:\canary\canary.txt' 'canary'
$canary = (Sddl 'C:\canary') + (Sddl 'C:\canary\canary.txt') + (Get-FileHash 'C:\canary\canary.txt').Hash
& cmd.exe /c mklink /J "$machineRec\x" 'C:\canary' | Out-Null
$c = Wait-Exit (Run 'new-setup.exe' @('/S', '/allusers'))
Say ($c -eq 7 -and ((Sddl 'C:\canary') + (Sddl 'C:\canary\canary.txt') + (Get-FileHash 'C:\canary\canary.txt').Hash) -eq $canary -and (RunValue 'machine') -eq $cmd -and (PayloadHash 'machine') -eq $hash) '(f) a junction inside the recovery folder: refused, its target and the armed recovery untouched' "exit $c"
& cmd.exe /c rmdir "$machineRec\x" | Out-Null
$c = Finish-RunValue 'machine'
Say ($c -eq 0 -and (IsNew $machineDir)) '(f) ...and the armed recovery (Run value run by hand) still finishes' "exit $c"

# (f) ProgramData\Combwork itself a junction: refused, its target untouched.
Reset
InstallOld 'machine'
New-Item -ItemType Directory -Force 'C:\canary2' | Out-Null
Set-Content 'C:\canary2\canary.txt' 'canary'
$canary = (Sddl 'C:\canary2') + (Get-FileHash 'C:\canary2\canary.txt').Hash
& cmd.exe /c mklink /J (Join-Path $env:ProgramData 'Combwork') 'C:\canary2' | Out-Null
$c = Wait-Exit (Run 'new-setup.exe' @('--updated', '/S'))
Say ($c -eq 7 -and ((Sddl 'C:\canary2') + (Get-FileHash 'C:\canary2\canary.txt').Hash) -eq $canary -and -not (Test-Path 'C:\canary2\resume') -and (IsOld $machineDir)) '(f) ProgramData\Combwork a junction: refused, its target untouched' "exit $c"
& cmd.exe /c rmdir (Join-Path $env:ProgramData 'Combwork') | Out-Null
}

if (Want 'lock') {
# (lock) The machine recovery lock, Global\CombworkRecovery-<APP_GUID>-machine, held by another process. A holder
# (powershell) takes it with default security and keeps it until the test writes C:\out\lock-release.txt (bounded at
# 5 minutes as a clean-up only); -System runs it as SYSTEM in session 0 (a scheduled task).
$lock = "Global\CombworkRecovery-$guid-machine"
$holder = @"
`$created = `$false
`$m = New-Object System.Threading.Mutex(`$true, '$lock', [ref]`$created)
Set-Content 'C:\out\lock-held.txt' "`$created `$((Get-Process -Id `$PID).SessionId)"
for (`$i = 0; `$i -lt 3000 -and -not (Test-Path 'C:\out\lock-release.txt'); `$i++) { Start-Sleep -Milliseconds 100 }
`$m.ReleaseMutex()
Set-Content 'C:\out\lock-done.txt' 'done'
"@
Set-Content 'C:\out\lock-holder.ps1' $holder
function Start-Holder([switch]$System) {
  Remove-Item 'C:\out\lock-held.txt', 'C:\out\lock-release.txt', 'C:\out\lock-done.txt' -ErrorAction SilentlyContinue
  if ($System) {
    & schtasks.exe /Create /F /TN cwlock /RU SYSTEM /SC ONCE /ST 23:59 /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\out\lock-holder.ps1" | Out-Null
    & schtasks.exe /Run /TN cwlock | Out-Null
  } else {
    Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\out\lock-holder.ps1' -WindowStyle Hidden | Out-Null
  }
  Until 'the holder saying it holds the lock' { try { $script:held = Get-Content 'C:\out\lock-held.txt' -ErrorAction Stop; [bool]$script:held } catch { $false } } 60
  Log "holder (created, session): $script:held"
}
function Stop-Holder {
  Set-Content 'C:\out\lock-release.txt' 'go'
  Until 'the holder letting go' { Test-Path 'C:\out\lock-done.txt' } 60
  & cmd.exe /c "schtasks /Delete /F /TN cwlock >nul 2>&1"
}
# Whether an installer is waiting on the lock: running, nothing armed and the old copy in place, throughout a 10 s look.
function Waiting($p) {
  for ($i = 0; $i -lt 100; $i++) { if ($p.HasExited -or (RunValue 'machine') -or -not (IsOld $machineDir)) { return $false }; Start-Sleep -Milliseconds 100 }
  return $true
}

Reset
InstallOld 'machine'
Start-Holder
$p = Run 'new-setup.exe' @('--updated', '/S')
$waiting = Waiting $p
Stop-Holder
$c = Wait-Exit $p
Say ($waiting -and $c -eq 0 -and (IsNew $machineDir) -and -not (RunValue 'machine')) '(lock) the machine lock held: the update waits, then installs once the test lets it go' "waiting: $waiting; exit $c"

Reset
InstallOld 'machine'
Start-Holder
$t0 = Get-Date
$c = Wait-Exit (Run 'new-short-setup.exe' @('--updated', '/S')) 180
$took = ((Get-Date) - $t0).TotalSeconds
Stop-Holder
Say ($c -eq 7 -and $took -ge 18 -and (IsOld $machineDir) -and -not (RunValue 'machine') -and -not (Test-Path $machineRec)) '(lock) held past the wait (20 s build): refused with exit 7, nothing changed' "exit $c; took $([int]$took) s"

# Held from session 0 by SYSTEM: the installer's CreateMutexW meets that object (one name across sessions: it is denied
# it, rather than making a new one) and, unable to wait on it, refuses at once: fail closed, nothing changed.
Reset
InstallOld 'machine'
Start-Holder -System
$c = Wait-Exit (Run 'new-setup.exe' @('--updated', '/S')) 180
Stop-Holder
Say ($script:held -like '* 0' -and $c -eq 7 -and (IsOld $machineDir) -and -not (RunValue 'machine') -and -not (Test-Path $machineRec)) '(lock) held from session 0 by SYSTEM, which this installer may not open: refused with exit 7, nothing changed' "exit $c; holder $script:held"
}

Reset
& cmd.exe /c "net user $stdUser /delete >nul 2>&1"
Add-Content $out "done: $fails failed"
exit $(if ($fails) { 1 } else { 0 })
