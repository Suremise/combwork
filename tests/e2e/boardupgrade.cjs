// S60, the 1.0 upgrade's two-process test (#1207, SPEC §16.17, OP-41): a released 0.9 Hive (another profile) holds a
// workspace whose board it made while the dev build opens it. The dev build asks first; Upgrade is refused with "close
// it first" and nothing changes; Not Now leaves the board read-only with a banner. With the 0.9 Hive closed the upgrade
// runs, keeping the 0.9 copy; the 0.9 Hive opened afterwards can't open the board (its cards are in 1.0's tables, #1209),
// and says so. Help → Restore the 0.9 Board
// Backup… puts the copy back, after which 0.9 writes again. Last, a 0.9 Hive started *during* the upgrade (the dev build
// holding its lock, HIVE_TEST_UPGRADE_HOLD): what it shows is recorded for the RC notes. Banner and dialog in both themes.
//
// The 0.9 Hive is a packaged 0.9.x build: HIVE_E2E_HIVE09 (its win-unpacked folder), else the main checkout's
// dist/win-unpacked when that is 0.9.x; with neither, the suite is skipped. No agents. Throwaway profiles and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000
// How long the dev build holds the upgrade's lock in the last step: room for a 0.9 Hive to start and try the board.
const HOLD_MS = 60000

const devProfile = path.join(lib.WORK, 'boardupgrade-dev')
const oldProfile = path.join(lib.WORK, 'boardupgrade-old')
const ws = path.join(lib.WORK, 'boardupgrade-ws')
const shots = path.join(lib.WORK, 'boardupgrade-shots')
const held = path.join(lib.WORK, 'boardupgrade-held.txt')
const claudeHome = path.join(lib.WORK, 'boardupgrade-claude')
const alpha = path.join(ws, 'alpha')
const dbFile = path.join(ws, '.hive', 'hive.db')
const backups = path.join(ws, '.hive', 'backups')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** What the suite records for the RC notes and OP-41, not a check. */
const record = (what, text) => console.log(`RECORD ${what}: ${text}`)

/** The 0.9 build to run, or why there is none. */
function hive09() {
  let dir = process.env.HIVE_E2E_HIVE09
  if (!dir) {
    const main = /^worktree (.+)$/m.exec(lib.git(lib.ROOT, 'worktree list --porcelain'))?.[1]
    if (!main) return { why: "no main checkout found (git worktree list)" }
    dir = path.join(main, 'dist', 'win-unpacked')
  }
  const exe = path.join(dir, 'Hive.exe')
  if (!fs.existsSync(exe)) return { why: `no Hive 0.9 build at ${dir} (set HIVE_E2E_HIVE09 to a 0.9.x win-unpacked folder)` }
  let version = '?'
  try {
    version = JSON.parse(require('@electron/asar').extractFile(path.join(dir, 'resources', 'app.asar'), 'package.json').toString('utf8')).version
  } catch (e) {
    return { why: `couldn't read the version of ${dir}: ${e.message}` }
  }
  if (!version.startsWith('0.9.')) return { why: `${dir} is Hive ${version}, not 0.9.x (set HIVE_E2E_HIVE09 to a 0.9.x win-unpacked folder)` }
  return { exe, version }
}

/** The board file's schema version, read on a connection of its own. */
function fileVersion() {
  const db = new DatabaseSync(dbFile, { readOnly: true, timeout: 5000 })
  try {
    return db.prepare('SELECT max(version) AS v FROM schema_version').get().v
  } finally {
    db.close()
  }
}
const copiesOf = (prefix) => (fs.existsSync(backups) ? fs.readdirSync(backups).filter((f) => f.startsWith(prefix)) : [])

/**
 * Starts the 0.9 Hive in its own profile on the workspace. Its Agent API finds the suite's port taken by the dev build at
 * times: it says so and runs on. `mayFail`: opening the workspace may fail (during the upgrade), the reason in `openError`.
 */
async function startOld(old, mayFail = false) {
  const app = await _electron.launch({ executablePath: old.exe, args: [], env: lib.hiveEnv({ HIVE_USER_DATA: oldProfile }) })
  try {
    const page = await app.firstWindow()
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    if (!mayFail) {
      await lib.openWorkspace(inv, page, ws)
      return { app, page, inv, openError: null }
    }
    return { app, page, inv, openError: await failure(inv('workspace:open', ws)) }
  } catch (e) {
    await app.close().catch(() => undefined)
    throw e
  }
}

/** An IPC call's error message, or null when it succeeded. */
const failure = (p) => p.then(() => null, (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))

const dialogWith = (page, text) => page.locator('.dialog', { hasText: text })
/** The dev build's running sessions. */
const live = (h) => h.inv('session:live')

/** An agent's start refused, saying why, before anything starts: no session running, none recorded. */
async function refusesStart(h, when) {
  const why = await failure(h.inv('session:start', alpha, { agentId: 'a-coder' }))
  check(`${when}, the agent is refused a start, saying why`, /upgrade it to 1\.0 before starting agents/.test(why ?? ''), why ?? 'started')
  check(`…none runs (${when})`, (await live(h)).length === 0)
  // The 0.9 board has none (the one run in step 5 is in the 1.0 board, kept aside by the restore).
  const records = await h.inv('session:list', alpha)
  check(`…and none was recorded (${when})`, records.length === 0, JSON.stringify(records.map((r) => r.id)))
}
const ASK = "Upgrade this workspace's board to 1.0?"

/** Screenshots of what is on screen in both themes, back to dark after. */
async function themes(dev, name) {
  for (const theme of ['dark', 'light']) {
    await dev.inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await dev.page.evaluate(() => document.documentElement.dataset.theme).catch(() => '')) === theme, HUNG_MS)
    await dev.page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
  }
  await dev.inv('settings:update', { appearance: { theme: 'dark' } })
}

;(async () => {
  const old = hive09()
  if (!old.exe) lib.skip(`environment: ${old.why}`)
  console.log(`0.9 Hive: ${old.version} (${old.exe})`)
  for (const d of [devProfile, oldProfile, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(held, { force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-coder', name: 'Coder' }] }))
  const open = new Set()
  const close = async (h) => {
    open.delete(h)
    await h.app.close().catch(() => undefined)
  }
  try {
    // 1. The 0.9 Hive makes the board, and keeps the workspace open.
    const old1 = await startOld(old)
    open.add(old1)
    await old1.inv('tasks:create', { title: 'Made in 0.9', project: 'alpha' })
    check('0.9 made the board at its schema (v2)', fileVersion() === 2, String(fileVersion()))

    // 2. The dev build opens it: asked first.
    // The fake Claude Code for the project's agent: what may start, and when.
    fs.mkdirSync(devProfile, { recursive: true })
    const claude = lib.fakeClaude(devProfile, claudeHome, [alpha])
    const dev = await lib.launch({ userData: devProfile, viewport: { width: 1400, height: 900 }, env: claude })
    open.add(dev)
    dev.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(dev.inv, dev.page, ws)
    const ask = dialogWith(dev.page, ASK)
    check('the dev build asks before upgrading', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)))
    check('…saying why, that a 0.9 Hive can then no longer open it, and that a backup is kept', /Hive 1\.0 needs to upgrade this workspace's data\. A 0\.9 Hive can then no longer open it; a backup is kept/.test(await ask.innerText().catch(() => '')), await ask.innerText().catch(() => ''))
    await themes(dev, '1-ask')

    // 3. Upgrade while the 0.9 Hive has it open: refused, nothing changed.
    await ask.getByRole('button', { name: 'Upgrade', exact: true }).click()
    check('Upgrade is refused: "close it first"', !!(await lib.until(async () => /Another Hive has this workspace open: close it first\./.test(await ask.innerText().catch(() => '')), HUNG_MS)), await ask.innerText().catch(() => ''))
    await themes(dev, '2-refused')
    check('…the file still at v2, no 0.9 copy made', fileVersion() === 2 && copiesOf('hive-before-1.0-').length === 0)
    check('…and the 0.9 Hive still writes', (await failure(old1.inv('tasks:create', { title: 'Still 0.9', project: 'alpha' }))) === null)

    // 4. Not Now: read-only, with the banner.
    await ask.getByRole('button', { name: 'Not Now', exact: true }).click()
    const banner = dev.page.locator('.board-upgrade')
    // On every view, not only the board's: here the project's Session view.
    check('Not Now leaves a banner at the top of the window', !!(await lib.until(async () => (await banner.count()) === 1 && (await ask.count()) === 0, HUNG_MS)))
    check("…which says the board is read-only and agents can't start", /its board is read-only here and its agents can't start/.test(await banner.innerText().catch(() => '')), await banner.innerText().catch(() => ''))
    await dev.page.screenshot({ path: path.join(shots, '3-banner-session.png') })
    await refusesStart(dev, 'while the upgrade waits')
    await dev.page.locator('.activity-btn[aria-label="Task Board"]').click()
    check('the banner is there above the board too', !!(await lib.until(async () => (await banner.count()) === 1 && (await dev.page.locator('.board-toolbar').count()) === 1, HUNG_MS)))
    const newCard = dev.page.locator('.board-toolbar .btn.primary', { hasText: 'New Card' })
    check('…and New Card is off, saying why', (await newCard.isDisabled()) && /until it is upgraded to 1\.0, its board is read-only here/.test((await newCard.getAttribute('title')) ?? ''))
    await themes(dev, '3-banner')
    const refusedWrite = await failure(dev.inv('tasks:create', { title: 'Too soon', project: 'alpha' }))
    check('the dev build refuses a change meanwhile', /read-only until it is upgraded to 1\.0/.test(refusedWrite ?? ''), refusedWrite ?? 'accepted')
    check('…and shows the 0.9 cards', !!(await lib.until(async () => (await dev.page.locator('.task-card', { hasText: 'Still 0.9' }).count()) === 1, HUNG_MS)))

    // 5. The 0.9 Hive closed: the banner's Upgrade… runs it.
    await close(old1)
    await banner.getByRole('button', { name: 'Upgrade…' }).click()
    await ask.getByRole('button', { name: 'Upgrade', exact: true }).click()
    check('with the 0.9 Hive closed, the upgrade runs', !!(await lib.until(async () => (await ask.count()) === 0 && (await dev.page.locator('.toast', { hasText: 'Board upgraded to 1.0' }).count()) === 1, HUNG_MS)))
    check('…the file moved on from v2', fileVersion() > 2, String(fileVersion()))
    check('…the 0.9 copy kept', copiesOf('hive-before-1.0-v2-').length === 1, String(copiesOf('hive-before')))
    check('…the banner gone, New Card on again', !!(await lib.until(async () => (await banner.count()) === 0 && !(await newCard.isDisabled()), HUNG_MS)))
    check('…and the board takes changes', (await failure(dev.inv('tasks:create', { title: 'Made in 1.0', project: 'alpha' }))) === null)
    const startFailed = await failure(dev.inv('session:start', alpha, { agentId: 'a-coder' }))
    check('…and its agent starts', startFailed === null && !!(await lib.until(async () => (await live(dev)).length === 1, HUNG_MS)), startFailed ?? 'not live')
    const markers = fs.readdirSync(path.join(ws, '.hive', 'open'))
    check('the dev build marks the workspace open (.hive/open)', markers.length === 1 && /^boardupgrade-dev-[0-9a-f]{8}\.json$/.test(markers[0]), String(markers))

    // 6. The 0.9 Hive opened afterwards: it can no longer open the board, its cards being in 1.0's tables (#1209; Darren,
    // 20 Oct), and says so: the workspace not opened, or opened with its board unreadable. Nothing it tries reaches the board.
    const old2 = await startOld(old, true)
    open.add(old2)
    const read09 = old2.openError ?? (await failure(old2.inv('tasks:list')))
    check("0.9 opened afterwards can't open the board, saying so", read09 !== null && /couldn't be opened|newer version of Hive/.test(read09), read09 ?? 'read it')
    const refused09 = old2.openError ?? (await failure(old2.inv('tasks:create', { title: 'From 0.9 after', project: 'alpha' })))
    check('…nor change it', refused09 !== null, 'accepted')
    record('0.9 after the upgrade', old2.openError ? `opening the workspace failed: ${old2.openError}` : `the workspace opened; its board: ${read09}; a change: ${refused09}`)
    await old2.page.screenshot({ path: path.join(shots, '4-old-after.png') })
    await close(old2)

    // 7. Help → Restore the 0.9 Board Backup…: not while the agent runs (it would go on unrecorded).
    const whileRunning = await failure(dev.inv('board:restore09'))
    check('Restore is refused while an agent runs', /Stop this workspace's agents and its Assistant first/.test(whileRunning ?? ''), whileRunning ?? 'restored')
    check('…nothing changed', fileVersion() > 2 && copiesOf('hive-before-restore-').length === 0)
    await dev.inv('session:stop', alpha, 'a-coder')
    check('the agent stopped', !!(await lib.until(async () => (await live(dev)).length === 0, HUNG_MS)))
    await dev.page.locator('.menubar-item', { hasText: 'Help' }).click()
    await lib.menuEntry(dev.page, 'Restore the 0.9 Board Backup…').click()
    const restore = dialogWith(dev.page, 'Restore the 0.9 board backup?')
    check('Restore asks first', !!(await lib.until(async () => (await restore.count()) === 1, HUNG_MS)))
    await themes(dev, '5-restore')
    await restore.getByRole('button', { name: 'Restore', exact: true }).click()
    check('…then the 0.9 board is back', !!(await lib.until(async () => (await restore.count()) === 0 && (await dev.page.locator('.toast', { hasText: 'The 0.9 board is back' }).count()) === 1, HUNG_MS)))
    check('…the file at v2 again', fileVersion() === 2, String(fileVersion()))
    check('…the 1.0 board kept, and the 0.9 copy still there', copiesOf('hive-before-restore-').length === 1 && copiesOf('hive-before-1.0-').length === 1)
    check('…and the dev build is read-only again, with its banner', !!(await lib.until(async () => (await banner.count()) === 1, HUNG_MS)))
    await refusesStart(dev, 'after the restore')
    await close(dev)
    check('the dev build removed its marker as it closed', fs.readdirSync(path.join(ws, '.hive', 'open')).length === 0)
    const old3 = await startOld(old)
    open.add(old3)
    check('0.9 writes the restored board again', (await failure(old3.inv('tasks:create', { title: 'After the restore', project: 'alpha' }))) === null)
    check("…which hasn't the card made in 1.0", !(await old3.inv('tasks:list')).some((c) => c.title === 'Made in 1.0'))
    await close(old3)

    // 8. A 0.9 Hive started during the upgrade: the dev build holds the lock (its main thread waits) while it starts.
    const dev2 = await lib.launch({ userData: devProfile, viewport: { width: 1400, height: 900 }, env: { ...claude, HIVE_TEST_UPGRADE_HOLD: `${HOLD_MS};${held}` } })
    open.add(dev2)
    await lib.openWorkspace(dev2.inv, dev2.page, ws)
    const ask2 = dialogWith(dev2.page, ASK)
    check('the dev build asks again', !!(await lib.until(async () => (await ask2.count()) === 1, HUNG_MS)))
    const started = Date.now()
    // Not awaited: the click's input goes through Electron's main thread, which the hold keeps waiting.
    const clicked = ask2.getByRole('button', { name: 'Upgrade', exact: true }).click({ timeout: HOLD_MS + HUNG_MS }).catch(() => undefined)
    check('…and holds the lock once its steps are in', !!(await lib.until(() => fs.existsSync(held), HUNG_MS)))
    const old4 = await startOld(old, true)
    open.add(old4)
    // What it shows: the workspace not opened, or opened with its board unreadable.
    const during = old4.openError ?? (await failure(old4.inv('tasks:list')))
    const duringAt = Date.now() - started
    check('a 0.9 Hive started meanwhile is kept off the board', during !== null && duringAt < HOLD_MS, `${during ?? 'read it'} after ${duringAt} ms`)
    record(`0.9 started during the upgrade (after ${duringAt} ms)`, old4.openError ? `opening the workspace failed: ${old4.openError}` : `the workspace opened; its board: ${during}`)
    if (!old4.openError) record('0.9 started during the upgrade, a change', (await failure(old4.inv('tasks:create', { title: 'During', project: 'alpha' }))) ?? 'accepted')
    await old4.page.screenshot({ path: path.join(shots, '6-old-during.png') })
    await clicked
    check('the upgrade finishes once the hold ends', !!(await lib.until(async () => (await ask2.count()) === 0, HOLD_MS + HUNG_MS)) && fileVersion() > 2)
    // Its user tries again.
    const reopened = old4.openError ? await failure(old4.inv('workspace:open', ws)) : null
    if (old4.openError) record('the same 0.9 Hive opening the workspace again after the upgrade', reopened ?? 'opened')
    const after = await failure(old4.inv('tasks:list'))
    record('the same 0.9 Hive after the upgrade, its board', after ?? 'read')
    record('the same 0.9 Hive after the upgrade, a change', (await failure(old4.inv('tasks:create', { title: 'After', project: 'alpha' }))) ?? 'accepted')
    await old4.page.screenshot({ path: path.join(shots, '7-old-after-hold.png') })
    check('nothing 0.9 tried meanwhile reached the board', !(await dev2.inv('tasks:list')).some((c) => c.title === 'During' || c.title === 'After'))
    await close(old4)
    await close(dev2)
  } finally {
    for (const h of [...open]) await close(h)
  }
  console.log(`\nScreenshots: ${shots}`)
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
