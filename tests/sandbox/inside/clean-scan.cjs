/**
 * Runs inside the Sandbox, as the user, with the host's Node (HI-2592, the clean-install check, scenario 9):
 *   C:\tools\node\node.exe C:\tools\combwork-tests\sandbox\inside\clean-scan.cjs baseline <prefix>   before the install
 *   C:\tools\node\node.exe C:\tools\combwork-tests\sandbox\inside\clean-scan.cjs scan <prefix>       after drive.cjs clean
 * baseline keeps what HKCU says of "hive" before anything is installed (C:\out\<prefix>-reg-before.txt), so the scan
 * counts only what the install and the app added. scan searches every place of ../clean.cjs CATEGORIES for "hive" and
 * writes C:\out\<prefix>-scan.json ({ places: { <id>: { scanned, count, hits, unread, why? } }, asar, skipped, at }; skipped: what couldn't be read, which fails its place), which
 * the host's report turns into checks (report.cjs, clean.cjs cleanChecks). What the driver kept for it: C:\out\<prefix>.json
 * (its facts: the workspace and the export's folder), <prefix>-window.json, -diagnostics.txt and -agent-env.txt.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { tally, scanText, scanTree, newRegistryHits } = require(path.join(__dirname, '..', 'clean.cjs'))
const { COMBWORK_GUID } = require(path.join(__dirname, '..', 'report.cjs'))

// The third argument, a folder for what it reads and writes in place of C:\out, is for trying it outside a Sandbox.
const [mode, prefix, outDir] = process.argv.slice(2)
const OUT = outDir || 'C:\\out'
const AUMID = 'it.surmise.combwork'
const out = (name) => path.join(OUT, `${prefix}-${name}`)
/** A command's output, also when it exits non-zero (reg query says "ERROR: … unable to find" with exit 1). */
const run = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return String(e.stdout ?? '')
  }
}
const ps = (cmd) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd])
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
const hkcuOldName = () => run('reg.exe', ['query', 'HKCU', '/f', 'hive', '/s'])

function scan() {
  const t = tally()
  const why = {}
  const drove = readJson(path.join(OUT, `${prefix}.json`))
  const facts = drove?.facts ?? {}
  const local = process.env.LOCALAPPDATA
  const install = path.join(local, 'Programs', 'Combwork')

  // The install folder: names and text files (Electron's, Chromium's and the native modules' binaries named only),
  // and every exe's version info (what Explorer and Task Manager show).
  if (!scanTree(t, 'install', install)) why.install = `${install} isn't there`
  const versions = ps(`Get-ChildItem -LiteralPath '${install}' -Recurse -Filter *.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.VersionInfo | Select-Object FileName, CompanyName, FileDescription, ProductName, ProductVersion, OriginalFilename, InternalName, LegalCopyright } | ConvertTo-Json -Compress`)
  for (const v of [].concat(versions.trim() ? JSON.parse(versions) : [])) scanText(t, 'install', `${v.FileName} (version info)`, JSON.stringify(v))

  // The profile folders: everything, binaries too (its databases are the app's own).
  if (!scanTree(t, 'roaming', path.join(process.env.APPDATA, 'Combwork'), { binary: 'scan' })) why.roaming = '%APPDATA%\\Combwork is empty or missing'
  if (!scanTree(t, 'local', path.join(local, 'Combwork'), { binary: 'scan' })) why.local = '%LOCALAPPDATA%\\Combwork is empty or missing'

  // The workspace with its git project, .git included (info/exclude, config, hooks), its packed objects named only.
  if (!facts.workspace || !scanTree(t, 'workspace', facts.workspace, { binary: 'scan', skip: (rel) => /(^|\/)\.git\/objects\//.test(rel) })) why.workspace = `no workspace (${facts.workspace ?? 'the driver named none'})`

  // The shortcuts: each .lnk on the Desktops and in the Start menus that starts Combwork, as Windows keeps it.
  const lnk = ps(`$sh = New-Object -ComObject WScript.Shell; $app = New-Object -ComObject Shell.Application; @(foreach ($d in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) { if (Test-Path $d) { Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $l = $sh.CreateShortcut($_.FullName); if ($l.TargetPath -like '*\\Programs\\Combwork\\*') { $item = $app.NameSpace($_.DirectoryName).ParseName($_.Name); [ordered]@{ file = $_.FullName; target = $l.TargetPath; arguments = $l.Arguments; workingDirectory = $l.WorkingDirectory; description = $l.Description; icon = $l.IconLocation; appUserModelId = [string]$item.ExtendedProperty('System.AppUserModel.ID') } } } } }) | ConvertTo-Json -Compress`)
  const shortcuts = lnk.trim() ? [].concat(JSON.parse(lnk)) : []
  for (const s of shortcuts) scanText(t, 'shortcuts', s.file, JSON.stringify(s))
  if (!shortcuts.length) why.shortcuts = 'no shortcut starts Combwork'

  // The registry: the app's own keys whole, wherever they are, and anything new in HKCU that names "hive".
  const keys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${COMBWORK_GUID}`,
    `HKCU\\Software\\${COMBWORK_GUID}`,
    `HKCU\\Software\\${AUMID}`,
    'HKCU\\Software\\Combwork',
    `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`,
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${AUMID}`,
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  ]
  for (const k of keys) {
    const dump = run('reg.exe', ['query', k, '/s'])
    if (dump.trim()) scanText(t, 'registry', k, dump)
  }
  // Any key under Classes naming Combwork (a protocol, a file type), whole.
  for (const k of new Set(run('reg.exe', ['query', 'HKCU\\Software\\Classes', '/f', 'combwork', '/k']).split(/\r?\n/).filter((l) => l.startsWith('HKEY_')).map((l) => l.trim()))) scanText(t, 'registry', k, run('reg.exe', ['query', k, '/s']))
  scanText(t, 'registry', 'the app\'s AppUserModelID', AUMID)
  let before = null
  try { before = fs.readFileSync(out('reg-before.txt'), 'utf8') } catch { /* below */ }
  if (before === null) why.registry = 'no record of HKCU before the install (baseline)'
  else {
    // Each new entry named by its key (a value's "<key>\<name> = <data>").
    const added = newRegistryHits(before, hkcuOldName())
    for (const e of added) scanText(t, 'registry', e.split(' = ')[0], e)
    if (!added.length) scanText(t, 'registry', 'HKCU, what was added since the install', '')
  }

  // The agent's environment, a variable a line, as `set` printed it in its session.
  let env = null
  try { env = fs.readFileSync(out('agent-env.txt'), 'utf8') } catch { /* below */ }
  if (env?.trim()) for (const line of env.split(/\r?\n/).filter(Boolean)) scanText(t, 'env', `env ${line.split('=')[0]}`, line)
  else why.env = 'the agent\'s `set` wasn\'t captured'

  // The window's text, each page as the driver read it; Copy Diagnostics; the exported board.
  const pages = readJson(out('window.json'))
  for (const p of [].concat(pages || [])) scanText(t, 'window', `window: ${p.where}`, p.text)
  if (!pages?.length) why.window = 'no window text was kept'
  let diag = null
  try { diag = fs.readFileSync(out('diagnostics.txt'), 'utf8') } catch { /* below */ }
  if (diag?.trim()) scanText(t, 'diagnostics', 'Copy Diagnostics', diag)
  else why.diagnostics = 'no diagnostics were copied'
  if (!facts.exportDir || !scanTree(t, 'export', facts.exportDir, { binary: 'scan' })) why.export = `no exported board (${facts.exportDir ?? 'the driver named none'})`

  for (const [k, w] of Object.entries(why)) t.places[k].why = w
  const res = { at: new Date().toISOString(), places: t.places, asar: t.asar, skipped: t.skipped.slice(0, 200) }
  fs.writeFileSync(out('scan.json'), JSON.stringify(res, null, 2))
  const counts = Object.entries(t.places).map(([k, p]) => `${k} ${p.count}/${p.scanned}`).join(', ')
  console.log(`hits/searched: ${counts}; app.asar ${t.asar.reduce((s, a) => s + a.count, 0)}`)
}

if (mode === 'baseline') {
  fs.writeFileSync(out('reg-before.txt'), hkcuOldName())
  console.log(`kept ${out('reg-before.txt')}`)
} else if (mode === 'scan') {
  scan()
} else {
  console.error(`clean-scan.cjs: baseline or scan, not ${mode}`)
  process.exitCode = 2
}
