// S60, the 1.0 upgrade's two-process test (#1207, SPEC §16.17, OP-41): a released 0.9 Hive (another profile) holds a
// workspace whose board it made while the dev build opens it. Since 1.1 the dev build first moves the workspace's .hive
// folders to .combwork (HI-2462, SPEC §4.1.1): while the 0.9 Hive has the board open, that is refused, saying so, and
// nothing changes (HI-2506: the upgrade's own "close it first" can't be reached from 0.9 any more). With the 0.9 Hive
// closed the folders move and the dev build asks first; Not Now leaves the board read-only with a banner; Upgrade runs,
// keeping the 0.9 copy. A 0.9 Hive opened afterwards finds no .hive and starts a fresh one beside .combwork, never
// reaching the moved board (Darren on HI-2506, 4 Nov: "no going back"). Help → Restore the 0.9 Board Backup… puts the
// copy back in .combwork. Last, a 0.9 Hive started *during* the upgrade (the dev build holding its lock,
// HIVE_TEST_UPGRADE_HOLD): what it shows is recorded for the RC notes. Banner and dialog in both themes.
//
// The 0.9 Hive is a packaged 0.9.x build: HIVE_E2E_HIVE09 (its win-unpacked folder), else the main checkout's
// dist/win-unpacked when that is 0.9.x; with neither, the suite is skipped. No agents. Throwaway profiles and workspace.
// lib.cjs keeps the 0.9 Hive's windows off screen and unfocused (#1253): a released build isn't quiet by itself.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const { endChildTree } = require('./folderProcesses.cjs')
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
// The board's folder: the 0.9 Hive's .hive until the dev build moves it to .combwork (HI-2462), the dev build's after
// (a .hive a 0.9 Hive makes again beside it is that Hive's own, HI-2506).
const tree = () => path.join(ws, fs.existsSync(path.join(ws, '.combwork', 'hive.db')) ? '.combwork' : '.hive')
const dbFileNow = () => path.join(tree(), 'hive.db')
const backupsNow = () => path.join(tree(), 'backups')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** The run ends early on purpose (step 8 with a packaged build), its checks so far its result. */
class StopHere extends Error {}
/** What the suite records for the RC notes and OP-41, not a check. */
const record = (what, text) => console.log(`RECORD ${what}: ${text}`)

/** A step that didn't finish within its bound: the run stops there, the step named (#1494). */
class Hung extends Error {}
/** The copies open, for what a hang says about each (set as they start). */
const running = []
/**
 * `p` within `ms`, else a FAIL naming `what` and the run stopped (#1494: a hang in the Sandbox printed nothing until the
 * guest's 900 s bound): IPC calls (page.evaluate has no timeout of its own), screenshots and clicks. What each Combwork
 * still answers is said first: its main process, its window, a screenshot.
 */
async function bounded(what, p, ms = HUNG_MS) {
  const LATE = {}
  let timer
  try {
    const r = await Promise.race([p, new Promise((res) => (timer = setTimeout(() => res(LATE), ms)))])
    if (r !== LATE) return r
  } finally {
    clearTimeout(timer)
  }
  check(`${what} within ${ms} ms`, false, 'hung')
  for (const h of running) {
    const answers = async (q) => (await Promise.race([q.then(() => 'answers', (e) => `fails: ${String(e?.message ?? e).split('\n')[0]}`), new Promise((res) => setTimeout(() => res('no answer in 5 s'), 5000))]))
    const main = await answers(h.app.evaluate(() => process.pid))
    const page = await answers(h.page.evaluate(() => document.readyState))
    const shot = path.join(shots, `hung-${h.name}.png`)
    const shown = await answers(h.page.screenshot({ path: shot, timeout: 5000 }))
    console.log(`HUNG ${h.name}: main process ${main}; window ${page}; screenshot ${shown === 'answers' ? shot : shown}`)
  }
  throw new Hung(what)
}
/**
 * Closes a Combwork within the bound, else ends its process and waits for it to exit (#1494: a hung Combwork mustn't hold the
 * run after the hang is said, HR6's round 1: at its start too).
 */
async function closeApp(app) {
  const closed = await Promise.race([app.close().then(() => true, () => false), new Promise((res) => setTimeout(() => res(false), HUNG_MS))])
  if (closed) return
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise((res) => proc.once('exit', res))
  // With what it started (its renderer, GPU and network processes), children first, by identity (#603).
  console.log(`a Combwork didn't close within ${HUNG_MS} ms: ended ${endChildTree(proc)} of its processes`)
  await Promise.race([exited, new Promise((res) => setTimeout(res, HUNG_MS))])
}
/** An IPC caller whose every call is bounded, named by its channel. */
const boundedInv = (name, inv, ms = HUNG_MS) => (ch, ...a) => bounded(`${name}: ${ch}`, inv(ch, ...a), ms)
/** A click within the bound, Playwright's own timeout naming its locator. */
const click = (locator, what) => bounded(`clicking ${what}`, locator.click({ timeout: HUNG_MS }), HUNG_MS + 5000)
const screenshot = (page, file) => bounded(`screenshot ${file}`, page.screenshot({ path: path.join(shots, file), timeout: HUNG_MS }), HUNG_MS + 5000)

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
  const db = new DatabaseSync(dbFileNow(), { readOnly: true, timeout: 5000 })
  try {
    return db.prepare('SELECT max(version) AS v FROM schema_version').get().v
  } finally {
    db.close()
  }
}
const copiesOf = (prefix) => (fs.existsSync(backupsNow()) ? fs.readdirSync(backupsNow()).filter((f) => f.startsWith(prefix)) : [])

/**
 * Starts the 0.9 Hive in its own profile on the workspace. Its Agent API finds the suite's port taken by the dev build at
 * times: it says so and runs on. `mayFail`: opening the workspace may fail (during the upgrade), the reason in `openError`.
 * `ms`: its calls' bound (longer while the dev build holds the upgrade's lock, which they may wait on).
 */
async function startOld(old, mayFail = false, ms = HUNG_MS) {
  const app = await _electron.launch({ executablePath: old.exe, args: [], env: lib.hiveEnv({ HIVE_USER_DATA: oldProfile }) })
  try {
    const page = await app.firstWindow()
    await lib.appReady(page)
    const inv = boundedInv('0.9 Hive', (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a]), ms)
    running.push({ name: '0.9', app, page })
    if (!mayFail) {
      await lib.openWorkspace(inv, page, ws)
      return { app, page, inv, openError: null }
    }
    return { app, page, inv, openError: await failure(inv('workspace:open', ws)) }
  } catch (e) {
    running.splice(0, running.length, ...running.filter((r) => r.app !== app))
    await closeApp(app)
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
  const records = await h.inv('session:list', alpha, { own: true })
  check(`…and none was recorded (${when})`, records.length === 0, JSON.stringify(records.map((r) => r.id)))
  // Its CLI's transcript is still in the project's folder (HI-1727): the full listing may show it, as a session started
  // outside Combwork (HI-1681), never as Combwork's.
  const all = await h.inv('session:list', alpha)
  check(`…any other session listed is the CLI's, not Combwork's (${when})`, all.every((r) => r.source === 'external'), JSON.stringify(all.map((r) => [r.id, r.source])))
}
const ASK = "Upgrade this workspace's board to 1.0?"

/** Screenshots of what is on screen in both themes, back to dark after. */
async function themes(dev, name) {
  for (const theme of ['dark', 'light']) {
    await dev.inv('settings:update', { appearance: { theme } })
    await bounded(`the ${theme} theme shown (${name})`, lib.until(async () => (await dev.page.evaluate(() => document.documentElement.dataset.theme).catch(() => '')) === theme, HUNG_MS), HUNG_MS + 5000)
    await screenshot(dev.page, `${name}-${theme}.png`)
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
    running.splice(0, running.length, ...running.filter((r) => r.app !== h.app))
    await closeApp(h.app)
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
    dev.inv = boundedInv('dev build', dev.inv)
    running.push({ name: 'dev', app: dev.app, page: dev.page })
    open.add(dev)
    dev.page.on('pageerror', (e) => check('no page errors', false, e.message))
    // While the 0.9 Hive has its board open, the move to .combwork (HI-2462) is refused, saying so: nothing changes.
    const refusedOpen = await failure(dev.inv('workspace:open', ws))
    check("while 0.9 holds it, the dev build's open is refused: its .hive can't be moved", /couldn't move .*\.hive to \.combwork: a program has a file in it open/.test(refusedOpen ?? ''), refusedOpen ?? 'opened')
    check('…nothing moved: no .combwork, the file still at v2, no 0.9 copy made', !fs.existsSync(path.join(ws, '.combwork')) && fs.existsSync(path.join(ws, '.hive', 'hive.db')) && fs.existsSync(path.join(alpha, '.hive', 'project.json')) && fileVersion() === 2 && copiesOf('hive-before-1.0-').length === 0)
    check('…and the 0.9 Hive still writes', (await failure(old1.inv('tasks:create', { title: 'Still 0.9', project: 'alpha' }))) === null)
    await screenshot(dev.page, '1-refused-move.png')

    // 3. The 0.9 Hive closed: the folders move, and the dev build asks before upgrading.
    await close(old1)
    await lib.openWorkspace(dev.inv, dev.page, ws)
    check('with 0.9 closed, the folders moved to .combwork', fs.existsSync(path.join(ws, '.combwork', 'hive.db')) && !fs.existsSync(path.join(ws, '.hive')) && fs.existsSync(path.join(alpha, '.combwork', 'project.json')) && !fs.existsSync(path.join(alpha, '.hive')))
    const ask = dialogWith(dev.page, ASK)
    check('the dev build asks before upgrading', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)))
    check('…saying why, that a 0.9 Combwork can then no longer open it, and that a backup is kept', /Combwork 1\.0 needs to upgrade this workspace's data\. A 0\.9 Combwork can then no longer open it; a backup of the board is kept/.test(await ask.innerText().catch(() => '')), await ask.innerText().catch(() => ''))
    check("…and to back up first: no going back to 0.9.3 once agents' worktrees become slots (#1441)", /Back up first: there's no going back to 0\.9\.3 once your agents' worktrees become slots\./.test(await ask.innerText().catch(() => '')), await ask.innerText().catch(() => ''))
    await themes(dev, '1-ask')

    // 4. Not Now: read-only, with the banner.
    await click(ask.getByRole('button', { name: 'Not Now', exact: true }), "the ask's Not Now")
    const banner = dev.page.locator('.board-upgrade')
    // On every view, not only the board's: here the project's Session view.
    check('Not Now leaves a banner at the top of the window', !!(await lib.until(async () => (await banner.count()) === 1 && (await ask.count()) === 0, HUNG_MS)))
    check("…which says the board is read-only and agents can't start", /its board is read-only here and its agents can't start/.test(await banner.innerText().catch(() => '')), await banner.innerText().catch(() => ''))
    await screenshot(dev.page, '3-banner-session.png')
    // New Session is off too, saying why (#1230): a start would be refused.
    const newSession = dev.page.locator('.session-empty-card .btn.act-start')
    check('…New Session is off, saying why', !!(await lib.until(async () => (await newSession.count()) === 1 && (await newSession.isDisabled()), HUNG_MS)) && /its agents can't start/.test((await newSession.getAttribute('title')) ?? ''), (await newSession.getAttribute('title').catch(() => null)) ?? 'no title')
    await refusesStart(dev, 'while the upgrade waits')
    await dev.page.locator('.activity-btn[aria-label="Task Board"]').click()
    check('the banner is there above the board too', !!(await lib.until(async () => (await banner.count()) === 1 && (await dev.page.locator('.board-toolbar').count()) === 1, HUNG_MS)))
    const newCard = dev.page.locator('.board-toolbar .btn.primary', { hasText: 'New Card' })
    check('…and New Card is off, saying why', (await newCard.isDisabled()) && /until it is upgraded to 1\.0, its board is read-only here/.test((await newCard.getAttribute('title')) ?? ''))
    await themes(dev, '3-banner')
    const refusedWrite = await failure(dev.inv('tasks:create', { title: 'Too soon', project: 'alpha' }))
    check('the dev build refuses a change meanwhile', /read-only until it is upgraded to 1\.0/.test(refusedWrite ?? ''), refusedWrite ?? 'accepted')
    check('…and shows the 0.9 cards', !!(await lib.until(async () => (await dev.page.locator('.task-card', { hasText: 'Still 0.9' }).count()) === 1, HUNG_MS)))
    // Its cards can be read, not changed (#1230): no dragging, and the card dialog's changes off, saying why.
    const tile = dev.page.locator('.task-card', { hasText: 'Still 0.9' })
    check('…its cards can not be dragged', (await tile.getAttribute('draggable')) === 'false', String(await tile.getAttribute('draggable')))
    check('…saying why on the card', /its board is read-only here/.test((await tile.getAttribute('title')) ?? ''), (await tile.getAttribute('title')) ?? 'no title')
    await tile.click()
    const dialog = dev.page.locator('.dialog', { has: dev.page.locator('.task-title-input') })
    check('…its card dialog opens', !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)))
    // Drawn with the dialog: there as soon as it is.
    const roBanner = dialog.locator('.task-read-only')
    check('…saying the card is read-only', (await roBanner.count()) === 1 && /its board is read-only here/.test(await roBanner.innerText()))
    const saveBtn = dialog.locator('.dialog-footer .btn.primary', { hasText: 'Save' })
    check("…with Save, the comment box and the decision box off", (await saveBtn.isDisabled()) && (await dialog.getByRole('textbox', { name: 'New comment' }).isDisabled()) && (await dialog.getByRole('textbox', { name: 'New decision' }).isDisabled()) && (await dialog.locator('.task-title-input').getAttribute('readonly')) !== null)
    await themes(dev, '3-dialog')
    // Typing changes nothing (the card has no description: its box is shown, read-only, round 2).
    const descBox = dialog.locator('.task-description-input')
    await descBox.click()
    await dev.page.keyboard.type('typed')
    await dialog.locator('.task-title-input').click()
    await dev.page.keyboard.type('typed')
    check('…typing in its description or title changes nothing', (await descBox.inputValue()) === '' && (await dialog.locator('.task-title-input').inputValue()) === 'Still 0.9', `${await descBox.inputValue()} | ${await dialog.locator('.task-title-input').inputValue()}`)
    await dev.page.keyboard.press('Escape')
    check('…and it closes with nothing to discard', !!(await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)))

    // 5. The banner's Upgrade… runs it.
    await click(banner.getByRole('button', { name: 'Upgrade…' }), "the banner's Upgrade…")
    await click(ask.getByRole('button', { name: 'Upgrade', exact: true }), "the ask's Upgrade (0.9 closed)")
    check('with the 0.9 Combwork closed, the upgrade runs', !!(await lib.until(async () => (await ask.count()) === 0 && (await dev.page.locator('.toast', { hasText: 'Board upgraded to 1.0' }).count()) === 1, HUNG_MS)))
    check('…the file moved on from v2', fileVersion() > 2, String(fileVersion()))
    check('…the 0.9 copy kept', copiesOf('hive-before-1.0-v2-').length === 1, String(copiesOf('hive-before')))
    check('…the banner gone, New Card on again', !!(await lib.until(async () => (await banner.count()) === 0 && !(await newCard.isDisabled()), HUNG_MS)))
    check('…and the board takes changes', (await failure(dev.inv('tasks:create', { title: 'Made in 1.0', project: 'alpha' }))) === null)
    const startFailed = await failure(dev.inv('session:start', alpha, { agentId: 'a-coder' }))
    check('…and its agent starts', startFailed === null && !!(await lib.until(async () => (await live(dev)).length === 1, HUNG_MS)), startFailed ?? 'not live')
    const markers = fs.readdirSync(path.join(ws, '.combwork', 'open'))
    check('the dev build marks the workspace open (.combwork/open)', markers.length === 1 && /^boardupgrade-dev-[0-9a-f]{8}\.json$/.test(markers[0]), String(markers))

    // 6. The 0.9 Hive opened afterwards: it finds no .hive, and starts a fresh one beside .combwork (Darren on HI-2506,
    // 4 Nov: "no going back"; as the 1.0 upgrade, downgrades aren't supported). Nothing it does reaches the moved board.
    const old2 = await startOld(old, true)
    open.add(old2)
    const read09 = old2.openError ?? (await failure(old2.inv('tasks:list')))
    const made09 = old2.openError ?? (await failure(old2.inv('tasks:create', { title: 'From 0.9 after', project: 'alpha' })))
    record('0.9 after the upgrade', old2.openError ? `opening the workspace failed: ${old2.openError}` : `the workspace opened on a fresh .hive; its board: ${read09 ?? 'read'}; a change: ${made09 ?? 'accepted'}`)
    check('0.9 opened afterwards starts a .hive of its own beside .combwork', fs.existsSync(path.join(ws, '.hive')) && fs.existsSync(path.join(ws, '.combwork', 'hive.db')))
    check("…which hasn't the moved board's cards", old2.openError !== null || !(await old2.inv('tasks:list')).some((c) => c.title === 'Made in 1.0'))
    check('…and nothing it does reaches the moved board', fileVersion() > 2 && !(await dev.inv('tasks:list')).some((c) => c.title === 'From 0.9 after') && (await dev.inv('tasks:list')).some((c) => c.title === 'Made in 1.0'))
    await screenshot(old2.page, '4-old-after.png')
    await close(old2)

    // 7. Help → Restore the 0.9 Board Backup…: not while the agent runs (it would go on unrecorded).
    const whileRunning = await failure(dev.inv('board:restore09'))
    check('Restore is refused while an agent runs', /Stop this workspace's agents and its Assistant first/.test(whileRunning ?? ''), whileRunning ?? 'restored')
    check('…nothing changed', fileVersion() > 2 && copiesOf('hive-before-restore-').length === 0)
    await dev.inv('session:stop', alpha, 'a-coder')
    check('the agent stopped', !!(await lib.until(async () => (await live(dev)).length === 0, HUNG_MS)))
    await click(dev.page.locator('.menubar-item', { hasText: 'Help' }), 'the Help menu')
    await click(lib.menuEntry(dev.page, 'Restore the 0.9 Board Backup…'), 'Restore the 0.9 Board Backup…')
    const restore = dialogWith(dev.page, 'Restore the 0.9 board backup?')
    check('Restore asks first', !!(await lib.until(async () => (await restore.count()) === 1, HUNG_MS)))
    await themes(dev, '5-restore')
    await click(restore.getByRole('button', { name: 'Restore', exact: true }), "the restore dialog's Restore")
    check('…then the 0.9 board is back', !!(await lib.until(async () => (await restore.count()) === 0 && (await dev.page.locator('.toast', { hasText: 'The 0.9 board is back' }).count()) === 1, HUNG_MS)))
    check('…the file at v2 again', fileVersion() === 2, String(fileVersion()))
    check('…the 1.0 board kept, and the 0.9 copy still there', copiesOf('hive-before-restore-').length === 1 && copiesOf('hive-before-1.0-').length === 1)
    check('…and the dev build is read-only again, with its banner', !!(await lib.until(async () => (await banner.count()) === 1, HUNG_MS)))
    await refusesStart(dev, 'after the restore')
    check("…the restored board has 0.9's cards, not the one made in 1.0", (await dev.inv('tasks:list')).some((c) => c.title === 'Still 0.9') && !(await dev.inv('tasks:list')).some((c) => c.title === 'Made in 1.0'))
    await close(dev)
    check('the dev build removed its marker as it closed', fs.readdirSync(path.join(ws, '.combwork', 'open')).length === 0)
    // The restored board stays in .combwork: a 0.9 Hive reads its own .hive (HI-2506, "no going back").

    // 8. A 0.9 Hive started during the upgrade: the dev build holds the lock (its main thread waits) while it starts.
    // The hold is for unpackaged builds only: a packaged one (HIVE_EXE, the Sandbox checks) ends here.
    if (process.env.HIVE_EXE) throw new StopHere('step 8 (a 0.9 Hive started during the upgrade) needs an unpackaged build: not run with HIVE_EXE')
    const dev2 = await lib.launch({ userData: devProfile, viewport: { width: 1400, height: 900 }, env: { ...claude, HIVE_TEST_UPGRADE_HOLD: `${HOLD_MS};${held}` } })
    dev2.inv = boundedInv('dev build', dev2.inv)
    running.push({ name: 'dev', app: dev2.app, page: dev2.page })
    open.add(dev2)
    await lib.openWorkspace(dev2.inv, dev2.page, ws)
    const ask2 = dialogWith(dev2.page, ASK)
    check('the dev build asks again', !!(await lib.until(async () => (await ask2.count()) === 1, HUNG_MS)))
    const started = Date.now()
    // Not awaited: the click's input goes through Electron's main thread, which the hold keeps waiting.
    const clicked = ask2.getByRole('button', { name: 'Upgrade', exact: true }).click({ timeout: HOLD_MS + HUNG_MS }).catch(() => undefined)
    check('…and holds the lock once its steps are in', !!(await lib.until(() => fs.existsSync(held), HUNG_MS)))
    const old4 = await startOld(old, true, HOLD_MS + HUNG_MS)
    open.add(old4)
    // What it shows: its own .hive (made in step 6), never the board being upgraded in .combwork (HI-2506).
    const during = old4.openError ?? (await failure(old4.inv('tasks:list')))
    const duringAt = Date.now() - started
    check('a 0.9 Hive started meanwhile opens its own .hive, within the hold', duringAt < HOLD_MS && fs.existsSync(path.join(ws, '.hive')), `${old4.openError ?? during ?? 'its own board read'} after ${duringAt} ms`)
    record(`0.9 started during the upgrade (after ${duringAt} ms)`, old4.openError ? `opening the workspace failed: ${old4.openError}` : `the workspace opened on its own .hive; its board: ${during ?? 'read'}`)
    if (!old4.openError) record('0.9 started during the upgrade, a change', (await failure(old4.inv('tasks:create', { title: 'During', project: 'alpha' }))) ?? 'accepted')
    await screenshot(old4.page, '6-old-during.png')
    await clicked
    check('the upgrade finishes once the hold ends', !!(await lib.until(async () => (await ask2.count()) === 0, HOLD_MS + HUNG_MS)) && fileVersion() > 2)
    // Its user tries again.
    const reopened = old4.openError ? await failure(old4.inv('workspace:open', ws)) : null
    if (old4.openError) record('the same 0.9 Hive opening the workspace again after the upgrade', reopened ?? 'opened')
    const after = await failure(old4.inv('tasks:list'))
    record('the same 0.9 Hive after the upgrade, its board', after ?? 'read')
    record('the same 0.9 Hive after the upgrade, a change', (await failure(old4.inv('tasks:create', { title: 'After', project: 'alpha' }))) ?? 'accepted')
    await screenshot(old4.page, '7-old-after-hold.png')
    check('nothing 0.9 tried meanwhile reached the board', !(await dev2.inv('tasks:list')).some((c) => c.title === 'During' || c.title === 'After'))
    await close(old4)
    await close(dev2)
  } catch (e) {
    if (e instanceof Hung) console.log(`STOPPED: ${e.message} didn't finish (its FAIL above, what each Combwork answered after it)`)
    else if (!(e instanceof StopHere)) throw e
    else console.log(`NOT RUN ${e.message}`)
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
