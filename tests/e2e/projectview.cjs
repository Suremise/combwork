// A project's view out of project.json (HI-1749): with the project's project.json held open by another program (a
// PowerShell holding it without delete sharing, as an editor or an indexer can, so replacing it fails with EPERM), the
// Session tab's Panes | Tiles switch still works and says no error, writing no project file; a change of the project's
// config fails as before, and hive.log says so (the IPC call's failure, the replace that gave up with its tries and time,
// and the process that had the file open). Let go, the config change is written, without the view in it; the view
// switched is still the project's after a restart. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'projectview-profile')
const ws = path.join(lib.WORK, 'projectview-ws')
const alpha = path.join(ws, 'alpha')
const file = path.join(alpha, '.hive', 'project.json')
const logFile = path.join(userData, 'logs', 'hive.log')
const release = path.join(lib.WORK, 'projectview-release')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Another program holding project.json open without delete sharing, until `release` exists (two minutes at most). */
function holdFile() {
  fs.rmSync(release, { force: true })
  const script = `$f = [System.IO.File]::Open($env:HOLD_FILE, 'Open', 'Read', 'Read'); Write-Output ready; $end = (Get-Date).AddMinutes(2); while (-not (Test-Path $env:HOLD_RELEASE) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 100 }; $f.Close()`
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: lib.childEnv({ HOLD_FILE: file, HOLD_RELEASE: release }), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const ready = new Promise((res) => ps.stdout.on('data', (d) => String(d).includes('ready') && res(true)))
  const ended = new Promise((res) => ps.on('exit', res))
  return { ps, ready, letGo: async () => (fs.writeFileSync(release, ''), await ended) }
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  let { app, page, inv } = await lib.launch({ userData })
  let hold = null
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await lib.openWorkspace(inv, page, ws)
    await lib.addAgent(inv, alpha, { name: 'Coder' })
    await page.getByText('alpha', { exact: true }).first().click()
    const tilesButton = page.locator('.view-switch [data-view="tiles"]')
    check('the Session tab shows its Panes | Tiles switch', !!(await lib.until(async () => (await tilesButton.count()) === 1, HUNG_MS)))
    const before = fs.readFileSync(file, 'utf8')

    // --- Held: the view switch works, with no error; the file isn't written.
    hold = holdFile()
    check('another program holds project.json', !!(await Promise.race([hold.ready, new Promise((r) => setTimeout(() => r(false), HUNG_MS))])))
    const mark = logText().length
    await tilesButton.click()
    check('Tiles while project.json is held: the tiles show', !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 1, HUNG_MS)))
    const error = page.locator('.toast', { hasText: 'Could not change the view' })
    check('…and no "Could not change the view"', (await error.count()) === 0)
    check('…project.json not written', fs.readFileSync(file, 'utf8') === before)

    // A change of the config can't be written meanwhile: it fails, and hive.log says why and what held the file.
    const refused = await inv('project:updateConfig', alpha, { chime: 'on' }).then(() => null, (e) => String(e.message ?? e))
    check('a config change while it is held fails with EPERM', /EPERM/.test(refused ?? ''), refused ?? 'it was written')
    const since = () => logText().slice(mark)
    check('hive.log: the IPC call failed, with its code', !!(await lib.until(() => /\[WARN\] \[ipc\] ipc project:updateConfig failed: .*EPERM.* \(EPERM\)/.test(since()), HUNG_MS)), since().split('\n').filter((l) => /\[ipc\]|\[files\]/.test(l)).join(' | '))
    check('hive.log: the replace that gave up, with its tries and time', /\[WARN\] \[files\] replacing .*project\.json.* failed with EPERM after 21 tries over \d+ ms: another process had it open/.test(since()))
    const named = await lib.until(() => /\[WARN\] \[files\] .*project\.json.* was open in (.*)/.exec(since())?.[1], HUNG_MS)
    check('hive.log: what had it open, as Windows says', !!named && named.includes(String(hold.ps.pid)) && /PowerShell/i.test(named), named ?? 'no line')
    if (named) console.log(`  was open in ${named}`)

    // --- Let go: the config change is written, without the view in it.
    await hold.letGo()
    hold = null
    await inv('project:updateConfig', alpha, { chime: 'on' })
    const saved = onDisk()
    check('let go: the config change is written', saved.chime === 'on', JSON.stringify(saved))
    check('…and project.json has no view in it', !('sessionView' in saved) && !('layout' in saved) && !('placement' in saved), Object.keys(saved).join(', '))

    // --- After a restart, the project still shows Tiles: the view was kept for this user.
    await app.close()
    ;({ app, page, inv } = await lib.launch({ userData }))
    await lib.until(async () => (await inv('workspace:get'))?.path === ws, HUNG_MS)
    await page.getByText('alpha', { exact: true }).first().click()
    check('after a restart: still Tiles', !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 1, HUNG_MS)))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    if (hold) await hold.letGo().catch(() => undefined)
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
