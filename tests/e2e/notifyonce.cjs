// One notification system (HI-2320): each event is told exactly once, in one place, and is in the bell. While a Hive
// window is focused, an agent finishing, an agent waiting for you, and an agent's warning or result (cw_notify) are
// each one entry: one pop-up, one bell row, no Windows notification. With Hive in the background, the agent's finish and
// wait are one Windows notification and one quiet bell row, never a pop-up; Hive's own messages (a warning) wait as a
// pop-up in the window, its clock paused. A focus change while finishes are being collected decides where their group
// goes. A waiting agent's entry says Answered once it no longer asks, and a newer ask is its own entry, untouched by the
// older one's answer. The test copy runs quiet and records each entry it tells and each Windows notification it would
// show (HIVE_TEST_NOTIFY_LOG); the window's focus is stubbed. Fake Claude Code; throwaway profile and workspace.
// Kinds routed by main alone (plan usage, a lane's notice, a long conversation, an update, Hive closing) are covered by
// tests/notify.test.ts, which runs the same table and tell().
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright-core')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const PORT = Number(lib.port(47712))
const userData = path.join(lib.WORK, 'notifyonce-profile')
const ws = path.join(lib.WORK, 'notifyonce-ws')
const alpha = path.join(ws, 'alpha')
const claudeHome = path.join(lib.WORK, 'notifyonce-claude-home')
const notifyLog = path.join(lib.WORK, 'notifyonce-notify.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.rmSync(notifyLog, { force: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, chimeEnabled: false, desktopNotifications: true, notifyOnFinished: true, notifyOnWaiting: true, bannerSeconds: 2 }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_QUIET: '1', HIVE_TEST_NOTIFY_LOG: notifyLog, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const one = await lib.addAgent(inv, alpha, { name: 'One' })
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === one.id)
    await inv('session:start', alpha, { agentId: one.id })
    check('the agent starts', !!(await lib.until(async () => (await live())?.status === 'ready', 25000)))
    const send = async (text) => {
      await inv('pty:write', lib.ptyKey(alpha, one.id), text)
      await lib.sleep(100)
      await inv('pty:write', lib.ptyKey(alpha, one.id), '\r')
    }
    const status = async () => (await live())?.status
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const notifyApi = (body) => fetch(`http://127.0.0.1:${PORT}/v1/notify`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status)
    const setFocus = (on) =>
      app.evaluate(({ BrowserWindow }, f) => {
        const w = BrowserWindow.getAllWindows()[0]
        w.isFocused = () => f
        w.emit(f ? 'focus' : 'blur')
      }, on)
    const log = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    const bell = () => page.evaluate(() => window.__hiveBell())
    const popupTexts = () => page.locator('.popups .popup').allInnerTexts()
    /** Everything Hive did for one event, found by its title: entries told, Windows notifications, bell rows, pop-ups. */
    const told = async (title) => {
      const entries = log().filter((e) => e.kind === 'entry' && e.title.includes(title))
      return {
        entries: entries.map((e) => e.route),
        windows: log().filter((e) => e.kind === 'notification' && e.title.includes(title)).length,
        bell: (await bell()).filter((t) => t.title.includes(title)).map((t) => (t.quiet ? 'quiet' : 'shown')),
        popups: (await popupTexts()).filter((t) => t.includes(title)).length
      }
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

    // --- Focused: each kind once, as a pop-up and a bell row.
    await setFocus(true)
    await send('go work 1')
    const finishTitle = 'alpha finished'
    check('focused, an agent finishing: one entry, one pop-up, one bell row, no Windows notification', !!(await lib.until(async () => same(await told(finishTitle), { entries: ['popup'], windows: 0, bell: ['shown'], popups: 1 }), HUNG_MS)), JSON.stringify(await told(finishTitle)))
    await page.screenshot({ path: path.join(lib.WORK, 'notifyonce-1-finished.png') })
    check('…the pop-up closes after its seconds, the bell keeps it', !!(await lib.until(async () => same(await told(finishTitle), { entries: ['popup'], windows: 0, bell: ['shown'], popups: 0 }), HUNG_MS)))

    for (const [level, title, kind] of [['warning', 'Disk nearly full', 'warning'], ['info', 'Build finished', 'result']]) {
      check(`cw_notify ${level} accepted`, (await notifyApi({ title, level, source: alpha })) === 200)
      check(`focused, a ${kind}: one entry, one pop-up, one bell row of its kind, no Windows notification`, !!(await lib.until(async () => same(await told(title), { entries: ['popup'], windows: 0, bell: ['shown'], popups: 1 }), HUNG_MS)) && (await bell()).find((t) => t.title === title)?.kind === kind, JSON.stringify(await told(title)))
    }

    // --- Waiting: one entry per ask; the older ask's answer leaves the newer one alone.
    await send('ask work 2')
    check('focused, an agent waiting: one needs-you entry and pop-up', !!(await lib.until(async () => (await told('needs your input')).popups === 1, HUNG_MS)), JSON.stringify(await told('needs your input')))
    check('…answered (it moves on): its bell row says Answered', !!(await lib.until(async () => (await bell()).some((t) => t.kind === 'needsYou' && t.resolved === 'Answered'), HUNG_MS)), JSON.stringify(await bell()))
    await lib.until(async () => (await status()) === 'finished', HUNG_MS)
    await send('ask work 4')
    await lib.until(async () => (await bell()).filter((t) => t.kind === 'needsYou').length === 2, HUNG_MS)
    const asks = (await bell()).filter((t) => t.kind === 'needsYou')
    check('a newer ask is an entry of its own, unresolved while it waits; the older one still says Answered', asks.length === 2 && asks[0].resolved === null && asks[1].resolved === 'Answered', JSON.stringify(asks))
    check('…and the newer one says Answered once it is', !!(await lib.until(async () => (await bell()).filter((t) => t.kind === 'needsYou').every((t) => t.resolved === 'Answered'), HUNG_MS)))
    await lib.until(async () => (await status()) === 'finished', HUNG_MS)
    await lib.until(async () => (await page.locator('.popups .popup').count()) === 0, HUNG_MS)

    // --- In the background: agents' news is one Windows notification and a quiet bell row; Hive's own warning waits.
    await setFocus(false)
    const before = log().filter((e) => e.kind === 'notification').length
    await send('go work 1')
    check('in the background, a finish: one Windows notification, one quiet bell row, no pop-up', !!(await lib.until(async () => {
      const t = await told(finishTitle)
      return t.windows === 1 && t.entries.filter((r) => r === 'windows').length === 1 && t.bell.filter((b) => b === 'quiet').length === 1 && t.popups === 0
    }, HUNG_MS)), JSON.stringify(await told(finishTitle)))
    check('cw_notify warning accepted in the background', (await notifyApi({ title: 'Hooks are quiet', level: 'warning', source: alpha })) === 200)
    check('…Hive\'s own warning: a pop-up that waits in the window, no Windows notification', !!(await lib.until(async () => same(await told('Hooks are quiet'), { entries: ['popup'], windows: 0, bell: ['shown'], popups: 1 }), HUNG_MS)))
    await lib.sleep(3500) // A fixed wait on purpose: longer than its 2 s, to show it does NOT close while the window is in the background.
    check('…still there while the window is in the background', (await told('Hooks are quiet')).popups === 1)
    await setFocus(true)
    check('…and closes after its seconds once the window is focused', !!(await lib.until(async () => (await told('Hooks are quiet')).popups === 0, HUNG_MS)))
    check('only the finish went to Windows', log().filter((e) => e.kind === 'notification').length === before + 1)

    // --- A focus change while finishes are collected: the group goes where things are when it is told.
    await setFocus(false)
    await send('go work 1')
    await lib.until(async () => (await status()) === 'finished', HUNG_MS)
    await setFocus(true)
    const n = log().filter((e) => e.kind === 'entry' && e.title.includes(finishTitle)).length
    check('focused before the group was told: it pops up, no Windows notification', !!(await lib.until(async () => log().filter((e) => e.kind === 'entry' && e.title.includes(finishTitle)).length === n + 1, HUNG_MS)) && log().filter((e) => e.kind === 'entry' && e.title.includes(finishTitle)).at(-1).route === 'popup' && log().filter((e) => e.kind === 'notification').length === before + 1, JSON.stringify(log().slice(-3)))

    // --- Every entry the window was given is under the bell, each once.
    const ids = (await bell()).map((t) => t.id)
    check('the bell has each entry once', ids.length === new Set(ids).size && ids.length >= 8, JSON.stringify(await bell()))
    await page.locator('.activitybar button[aria-label="Notifications"]').click()
    await lib.until(async () => (await page.locator('.notif-panel .notif-item').count()) === ids.length, HUNG_MS)
    check('…and its panel lists them all', (await page.locator('.notif-panel .notif-item').count()) === ids.length)
    check('…an answered ask reads Answered there', (await page.locator('.notif-panel .notif-item.kind-needsYou .entry-outcome', { hasText: 'Answered' }).count()) === 2)
    await page.screenshot({ path: path.join(lib.WORK, 'notifyonce-2-bell.png') })

    await inv('session:stop', alpha, one.id).catch(() => undefined)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  } catch (e) {
    check('the run', false, e.message)
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
