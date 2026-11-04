// Following a lane to its end without the Assistant (#1266, SPEC §16.11.4), on fake Claude Code agents (fake-claude/),
// the Assistant never started: Hive notifies the user of a lane's failed review (one notice naming the lane and the
// card), a card of it blocked (with why), and every card passed so its merge is due; nothing for a plain move into
// Review, and nothing when Settings → Notifications has notifications off. A quiet test copy records each notice in
// HIVE_TEST_NOTIFY_LOG, which this reads. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1578): it starts this checkout's Electron itself.
const lib = require('./lib.cjs')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'lanenotices-profile')
const ws = path.join(lib.WORK, 'lanenotices-ws')
const claudeHome = path.join(lib.WORK, 'lanenotices-claude-home')
const notifyLog = path.join(lib.WORK, 'lanenotices-notify.jsonl')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47829))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(notifyLog, { force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_NOTIFY_LOG: notifyLog, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const until = async (fn, ms) => {
      const t = Date.now()
      let v
      while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
      return v
    }
    const say = async (id, text) => {
      // Typed again if a wake of Hive's disturbed it (lib.typeLine, #1560).
      await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
    }
    const idle = async (id) => ['ready', 'finished', 'watching'].includes((await live(id))?.status)
    /** The lane notices recorded so far (Windows notifications a quiet copy records); they name cards as the window does (#1221). */
    const notices = () =>
      (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
        .filter((n) => n.kind === 'notification' && (n.title ?? '').startsWith('Lane '))
        .map((n) => ({ title: n.title, body: n.body ?? '' }))
    /** A card as the window names it: its key (AL-1). */
    const label = async (n) => (await inv('tasks:list')).find((c) => c.number === n)?.key ?? `#${n}`

    await page.getByText('alpha', { exact: true }).first().click()
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
    for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start; the Assistant never does', !!(await until(async () => (await idle(builder.id)) && (await idle(reviewer.id)), HUNG_MS)) && !(await inv('session:live')).some((s) => s.agentId === 'assistant'))

    // A lane: Builder builds #a and #b, Reviewer reviews. Registered by the builder, as card-loop does.
    const newCard = async (title) => (await inv('tasks:create', { title, project: 'alpha', agent: builder.id, column: 'doing' })).number
    const a = await newCard('Greeting says Hi')
    const b = await newCard('Greeting trims the name')
    await say(builder.id, `hive cw_lane ${JSON.stringify({ action: 'start', cards: [a, b], reviewer: 'Reviewer', name: 'greetings' })}`)
    check('the lane is running', !!(await until(async () => (await inv('lanes:list')).some((l) => l.state === 'active' && l.cards.length === 2), HUNG_MS)), JSON.stringify(await inv('lanes:list')))

    // A plain move into Review: no notice.
    await inv('tasks:update', a, { column: 'review' })
    await until(() => idle(reviewer.id), HUNG_MS)
    await say(reviewer.id, `boardreview ${a} start`)
    await until(async () => (await inv('tasks:list')).find((c) => c.number === a)?.review?.agent === reviewer.id, HUNG_MS)
    // The review fails: one notice naming the lane and the card.
    await until(() => idle(reviewer.id), HUNG_MS)
    await say(reviewer.id, `boardreview ${a} failed`)
    const keyA = await label(a)
    const keyB = await label(b)
    check('the cards have keys', /^[A-Z]{2,4}-\d+$/.test(keyA), keyA)
    const failedNotice = () => notices().find((n) => n.body.includes(`${keyA} failed review`))
    check('a failed review is a notice naming the lane and the card', !!(await until(async () => !!failedNotice(), HUNG_MS)) && failedNotice().title === 'Lane Builder / Reviewer (greetings)', JSON.stringify(notices()))
    check('the move into Review alone told nothing', notices().length === 1, JSON.stringify(notices()))

    // A card blocked, with why.
    await inv('tasks:update', b, { blocked: 'Which greeting does the README show?' })
    const blockedNotice = () => notices().find((n) => n.body.includes(`${keyB} is blocked: Which greeting does the README show?`))
    check('a card blocked is a notice with why', !!(await until(async () => !!blockedNotice(), HUNG_MS)), JSON.stringify(notices()))

    // Every card passed: its merge is due.
    await inv('tasks:update', b, { blocked: '' })
    for (const n of [a, b]) {
      await inv('tasks:update', n, { column: 'review' })
      await until(() => idle(reviewer.id), HUNG_MS)
      await say(reviewer.id, `boardreview ${n} start`)
      await until(async () => (await inv('tasks:list')).find((c) => c.number === n)?.review?.agent === reviewer.id, HUNG_MS)
      await until(() => idle(reviewer.id), HUNG_MS)
      await say(reviewer.id, `boardreview ${n} passed passed`)
      await until(async () => (await inv('tasks:list')).find((c) => c.number === n)?.column === 'passed', HUNG_MS)
    }
    // One card at a time (#1270): the first passed while the next went on, so the lane paused for its merge, said so.
    const pausedNotice = () => notices().find((n) => n.body.includes(`${keyA} passed review: the lane waits for it to be merged`))
    check('a lane paused for a card not merged is a notice saying why', !!(await until(async () => !!pausedNotice(), HUNG_MS)), JSON.stringify(notices()))
    const dueNotice = () => notices().find((n) => n.body.includes('its merge is due'))
    check('every card passed: a notice that its merge is due', !!(await until(async () => !!dueNotice(), HUNG_MS)), JSON.stringify(notices()))

    // With Hive focused (stubbed: a test window never takes the OS focus), a lane's notice is a banner in the window, as
    // the user's notification settings say: before and after, for the screenshots.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.isFocused = () => true
      w.emit('focus')
    })
    await page.screenshot({ path: path.join(lib.WORK, 'lanenotices-1-before.png') })
    await inv('tasks:update', a, { blocked: 'Release notes first?' })
    const banner = page.locator('.popups .popup', { hasText: 'Lane Builder / Reviewer (greetings)' })
    check('with Hive focused, a lane notice is a pop-up in the window', !!(await until(async () => (await banner.count()) > 0, HUNG_MS)), JSON.stringify(await page.locator('.popups .popup').allInnerTexts()))
    check('…naming the card by its key and why it is blocked', (await banner.first().innerText()).includes(`${keyA} is blocked: Release notes first?`), await banner.first().innerText())
    await page.screenshot({ path: path.join(lib.WORK, 'lanenotices-2-banner.png') })
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.isFocused = () => false
      w.emit('blur')
    })
    await inv('tasks:update', a, { blocked: '' })

    // The durable notice (#1266): each notice is a line in its card's history, there to read whatever became of the
    // notification. The card whose review failed says so, in its dialog's History.
    await showBoard(page)
    await openByTitle(page, a)
    const dialog = lib.cardDialog(page, await lib.cardLabel(inv, a))
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.getByText(/History \(\d+\)/).first().click()
    const noted = dialog.locator('.task-history', { hasText: 'Notified you that its review failed' })
    check("the card's history keeps the notice: \"Notified you that its review failed\"",!!(await until(async () => (await noted.count()) > 0, HUNG_MS)), await dialog.locator('.task-history').innerText().catch(() => ''))
    check('…and with what it said: "Notified you that it\'s blocked: Release notes first?"', (await dialog.locator('.task-history', { hasText: "Notified you that it's blocked: Release notes first?" }).count()) > 0, await dialog.locator('.task-history').innerText().catch(() => ''))
    await dialog.locator('.task-history').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(lib.WORK, 'lanenotices-3-history.png') })
    await page.keyboard.press('Escape')

    // Notifications off (Settings → Notifications): nothing more is told.
    await inv('settings:update', { notifications: { desktopNotifications: false } })
    const told = notices().length
    await inv('tasks:update', a, { blocked: 'Waiting for the release' })
    await lib.sleep(3000) // A fixed wait on purpose: this checks that nothing comes (a lane is looked at within a second of a change).
    check('with notifications off, a card blocked tells nothing', notices().length === told, JSON.stringify(notices().slice(told)))

    await inv('session:stop', alpha)
    await until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
