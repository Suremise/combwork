# Runs inside the Sandbox as the user (HI-2602, scenario 11): the profile move the installer couldn't make, made by the
# app at start (HI-2594, profileFolders.ts), with real installers, in order on one machine. Hive Desktop 1.0 is installed
# already (the host's install.ps1, so an App Control refusal is NOT RUN there).
#   11.1 Hive Desktop 1.0 run once, so its profile folders are its own; a mark put in each.
#   11.2 A file in %LOCALAPPDATA%\Hive held open (as a stray process holds it) while the new installer runs: it installs
#        (exit 0), moves the roaming folder, and leaves the local one where it was, with its own record in it.
#   11.3 Combwork started with the file still held: the start is refused, an error box naming both folders (screenshot
#        s11-refused.png), exit 1; nothing made under Combwork's local name, the roaming folder as it was.
#   11.4 Let go, Combwork started again: it moves the local folder itself, its record (the installer's, left in it, or
#        the app's own) arriving with it; the sign-in check after the move runs (screenshot s11-moved.png).
#   11.5 Started once more: the sign-in check doesn't run again.
#   profile-move.ps1 -New <installer>
# Writes C:\out\s11-profile.json ({ checks: [{ id, name, ok, detail }], facts, completed }) as it goes.
param(
  [Parameter(Mandatory = $true)][string]$New
)
$ErrorActionPreference = 'Stop'
$out = 'C:\out\s11-profile.json'
$res = [ordered]@{ checks = @(); facts = [ordered]@{}; completed = $false }
function Save { [IO.File]::WriteAllText($out, ($res | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false)) }
function Check([string]$id, [string]$name, [bool]$ok, $detail) {
  $res.checks += [ordered]@{ id = $id; name = $name; ok = $ok; detail = $(if ($ok) { $null } else { [string]$detail }) }
  Save
}

$hiveExe = Join-Path $env:LOCALAPPDATA 'Programs\Hive\Hive.exe'
$combExe = Join-Path $env:LOCALAPPDATA 'Programs\Combwork\Combwork.exe'
$roamHive = Join-Path $env:APPDATA 'Hive'
$roamComb = Join-Path $env:APPDATA 'Combwork'
$locHive = Join-Path $env:LOCALAPPDATA 'Hive'
$locComb = Join-Path $env:LOCALAPPDATA 'Combwork'
$mark = 'sandbox-mark.txt'
$record = 'profile-move.json'
# The error box's title (main.profileMove.refusedTitle, in English: the Sandbox's language).
$refusedTitle = "couldn't move its data folder"
# The log lines of the sign-in check after a move (profileNotices.ts): one per check, and the notices' phase ending.
$checkLine = 'profile: after the move, '
$doneLine = 'profile: start notices done'

# Every wait here waits for a condition, bounded by $HUNG (a hung run), never for time; one not met throws, so no case
# goes on from a precondition that wasn't reached.
$HUNG = 120
function WaitFor([scriptblock]$cond, [string]$what, [int]$secs = $HUNG) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not (& $cond)) {
    if ($clock.Elapsed.TotalSeconds -ge $secs) { throw "not met within $secs s: $what" }
    Start-Sleep -Milliseconds 200
  }
}
# Every process of an exact exe (its helpers too).
function ProcsOf([string]$exe) { @(Get-CimInstance Win32_Process -Filter "Name='$(Split-Path -Leaf $exe)'" | Where-Object { $_.ExecutablePath -eq $exe }) }
# An app this script started, closed: its window asked to close, then whatever of it is left ended; returns once none
# of its exe's processes is left (a helper still running would hold the profile's files).
function CloseApp($p, [string]$exe) {
  if (-not $p.HasExited) {
    $g = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
    if ($g -and $g.MainWindowHandle -ne 0) { [void]$g.CloseMainWindow() }
    [void]$p.WaitForExit(15000)
  }
  foreach ($x in ProcsOf $exe) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }
  WaitFor { (ProcsOf $exe).Count -eq 0 } "every $(Split-Path -Leaf $exe) ended"
}
function Launch([string]$exe, [string]$stderr) {
  $a = @{ FilePath = $exe; PassThru = $true }
  if ($stderr) { $a.RedirectStandardError = $stderr }
  $p = Start-Process @a
  $null = $p.Handle # keeps the exit code available after exit
  return $p
}
# The title of a process's main window, read fresh ('' while it has none).
function TitleOf($p) { $g = Get-Process -Id $p.Id -ErrorAction SilentlyContinue; if ($g -and $g.MainWindowHandle -ne 0) { $g.MainWindowTitle } else { '' } }
# A process of this script's holding a file open with no sharing until told to let go (C:\out\<name>.release), saying
# when it holds it (C:\out\<name>.ready): asserted before the case goes on.
function Holding([string]$name, [string]$file) {
  $ready = "C:\out\$name.ready"
  $release = "C:\out\$name.release"
  Remove-Item $ready, $release -ErrorAction SilentlyContinue
  $script = "`$f = [IO.File]::Open('$file', 'Open', 'ReadWrite', 'None'); [IO.File]::WriteAllText('$ready', 'held'); while (-not (Test-Path '$release')) { Start-Sleep -Milliseconds 200 }; `$f.Close()"
  $h = Start-Process powershell -ArgumentList '-NoProfile', '-Command', $script -PassThru -WindowStyle Hidden
  $null = $h.Handle
  WaitFor { Test-Path $ready } "$name holding $file"
  return [pscustomobject]@{ process = $h; release = $release }
}
function LetGo($held) {
  Set-Content $held.release 'go'
  if (-not $held.process.WaitForExit($HUNG * 1000)) { throw "the holder $($held.process.Id) didn't let go" }
}
# How many lines of the profile's logs (every *.log, read while the app may write them) contain $text.
function LogCount([string]$text) {
  $dir = Join-Path $roamComb 'logs'
  if (-not (Test-Path $dir)) { return 0 }
  $n = 0
  foreach ($f in Get-ChildItem $dir -Filter '*.log' -File) {
    try {
      $s = [IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite, Delete')
      try { $t = (New-Object IO.StreamReader($s)).ReadToEnd() } finally { $s.Close() }
      $n += @($t -split "`n" | Where-Object { $_.Contains($text) }).Count
    } catch { }
  }
  return $n
}
# A folder's files, each as its relative path and length, sorted: what "unchanged" compares.
function Listing([string]$dir) {
  if (-not (Test-Path $dir)) { return '(none)' }
  (@(Get-ChildItem $dir -Recurse -File -Force | ForEach-Object { "$($_.FullName.Substring($dir.Length)) $($_.Length)" }) | Sort-Object) -join '; '
}
function ReadRecord([string]$dir) {
  $f = Join-Path $dir $record
  if (-not (Test-Path $f)) { return $null }
  try { return [IO.File]::ReadAllText($f) | ConvertFrom-Json } catch { return [pscustomobject]@{ unreadable = $_.Exception.Message } }
}
function Has([string]$dir, [string]$name = $mark) { Test-Path (Join-Path $dir $name) }
function Folders { "roaming Hive $(Test-Path $roamHive), Combwork $(Test-Path $roamComb); local Hive $(Test-Path $locHive), Combwork $(Test-Path $locComb)" }
# The screen, as the user sees it, into C:\out\<name>.png (the host collects it).
function Shot([string]$name) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  $g = [Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save("C:\out\$name.png", [Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $bmp.Dispose() }
}
# Combwork started and running: its window up and the profile notices' phase over (a new "done" line in the log).
function StartCombwork {
  $done = LogCount $doneLine
  $p = Launch $combExe $null
  WaitFor { $p.HasExited -or ((TitleOf $p) -and (LogCount $doneLine) -gt $done) } 'Combwork running, its start notices done'
  if ($p.HasExited) { throw "Combwork ended at start (exit $($p.ExitCode)): $(Folders)" }
  return $p
}

try {
  # 11.1: Hive Desktop 1.0's own profile, as it made it: run once (its roaming log written, its window up), closed.
  $p = Launch $hiveExe $null
  WaitFor { (TitleOf $p) -and (Test-Path (Join-Path $roamHive 'logs')) } 'Hive Desktop running, its profile made'
  CloseApp $p $hiveExe
  New-Item -ItemType Directory -Force $locHive | Out-Null
  foreach ($d in @($roamHive, $locHive)) { Set-Content (Join-Path $d $mark) 'kept across the move' }
  Check '11.hive-profile' 'Hive Desktop 1.0 ran once: its profile folders are %APPDATA%\Hive and %LOCALAPPDATA%\Hive, no Combwork ones' ((Has $roamHive) -and (Has $locHive) -and -not (Test-Path $roamComb) -and -not (Test-Path $locComb)) (Folders)

  # 11.2: a file in the local folder held open while the new installer runs: it can't rename that folder.
  $held = Holding 'local-profile' (Join-Path $locHive $mark)
  $i = Start-Process -FilePath $New -ArgumentList '/S' -PassThru
  $null = $i.Handle
  if (-not $i.WaitForExit(300000)) { throw 'the installer ran over 300 s' }
  $code = $i.ExitCode
  $res.facts.install = [ordered]@{ exitCode = $code; folders = (Folders) }
  $res.facts.installerRecord = ReadRecord $locHive
  Check '11.installer-held' "Installed (exit 0) with the local folder held: the roaming folder moved, the local one left as %LOCALAPPDATA%\Hive with the installer's record in it, no %LOCALAPPDATA%\Combwork" ($code -eq 0 -and (Test-Path $combExe) -and (Has $roamComb) -and -not (Test-Path $roamHive) -and (Has $locHive) -and -not (Test-Path $locComb) -and $res.facts.installerRecord.by -eq 'installer') "exit $code; $(Folders); record $($res.facts.installerRecord | ConvertTo-Json -Compress)"
  Save

  # 11.3: Combwork started with the file still held: refused, with its error box; nothing made in Combwork's name.
  $roamingBefore = Listing $roamComb
  $localBefore = Listing $locHive
  $p = Launch $combExe 'C:\out\s11-refused-stderr.txt'
  WaitFor { $p.HasExited -or (TitleOf $p) } 'Combwork shows a window or ends'
  $title = TitleOf $p
  $res.facts.refusedTitle = $title
  if ($title) { Shot 's11-refused' }
  CloseApp $p $combExe
  $res.facts.refusedExit = $p.ExitCode
  $res.facts.refusedStderr = $(try { [IO.File]::ReadAllText('C:\out\s11-refused-stderr.txt') } catch { "unread: $($_.Exception.Message)" })
  Check '11.refused' "Started with the local folder held: the start is refused, an error box (`"...$refusedTitle`") naming the folder, then exit 1" ($title -like "*$refusedTitle*" -and $p.ExitCode -eq 1 -and $res.facts.refusedStderr.Contains($locHive)) "title '$title'; exit $($p.ExitCode); stderr $($res.facts.refusedStderr)"
  $roamingAfter = Listing $roamComb
  $localAfter = Listing $locHive
  Check '11.refused-unchanged' 'Nothing made under Combwork: no %LOCALAPPDATA%\Combwork, %LOCALAPPDATA%\Hive and %APPDATA%\Combwork as they were' (-not (Test-Path $locComb) -and $roamingAfter -eq $roamingBefore -and $localAfter -eq $localBefore) "$(Folders); roaming before [$roamingBefore] after [$roamingAfter]; local before [$localBefore] after [$localAfter]"

  # 11.4: let go, started again: the app moves the local folder itself, and checks the sign-ins once.
  LetGo $held
  $checks = LogCount $checkLine
  $p = StartCombwork
  Shot 's11-moved'
  $rec = ReadRecord $locComb
  $res.facts.record = $rec
  $res.facts.recordBy = $rec.by
  Check '11.moved' 'Let go, Combwork starts and moves %LOCALAPPDATA%\Hive to %LOCALAPPDATA%\Combwork with its data; both folders are Combwork''s, no Hive ones' ((Has $locComb) -and -not (Test-Path $locHive) -and (Has $roamComb) -and -not (Test-Path $roamHive)) (Folders)
  Check '11.record' "The record of the move arrived with the local folder (v 1, by the installer or the app, from %LOCALAPPDATA%\Hive)" ($rec.v -eq 1 -and @('installer', 'app') -contains $rec.by -and $rec.from -eq $locHive) ($rec | ConvertTo-Json -Compress)
  $first = (LogCount $checkLine) - $checks
  Check '11.sign-in-checked' 'The sign-in check after the move ran once at that start, and the record says it is done' ($first -eq 1 -and $rec.signInChecked -eq $true) "$first check line(s); record $($rec | ConvertTo-Json -Compress)"
  CloseApp $p $combExe

  # 11.5: started once more: no second sign-in check.
  $checks = LogCount $checkLine
  $p = StartCombwork
  $again = (LogCount $checkLine) - $checks
  CloseApp $p $combExe
  Check '11.sign-in-once' 'At the next start the sign-in check doesn''t run again' ($again -eq 0) "$again check line(s) at the next start"
  $res.completed = $true
} catch {
  Check '11.error' 'The profile move checks ran without an error' $false $_.Exception.Message
} finally {
  foreach ($exe in @($hiveExe, $combExe)) { foreach ($x in ProcsOf $exe) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue } }
  if ($held -and -not $held.process.HasExited) { Set-Content $held.release 'go' -ErrorAction SilentlyContinue }
  Save
}
"$(@($res.checks | Where-Object { $_.ok }).Count) of $($res.checks.Count) passed"
