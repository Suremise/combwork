// The taskbar button when something needs you: a badge with the count (setOverlayIcon, recorded in the test build's
// main process) and the count in the window title; an agent that only finished is never counted (#1632), one at a
// permission prompt is until it goes on. An agent starting
// to wait for input while the window is in the background flashes the button (recorded to the notify log; the window's
// focus is faked), and both settings turn these off. The agents are the fake Claude Code. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'taskbar-profile')
const ws = path.join(lib.WORK, 'taskbar-ws')
const claudeHome = path.join(lib.WORK, 'taskbar-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, beta, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Quiet (HIVE_TEST_QUIET): the flashes are recorded to the notify log, not made.
  const notifyLog = path.join(lib.WORK, 'taskbar-notify.log')
  fs.rmSync(notifyLog, { force: true })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47904), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_QUIET: '1', HIVE_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  // Record the badge and flashes; the window's focus can be faked.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    globalThis.__overlay = []
    globalThis.__focused = null
    const set = w.setOverlayIcon.bind(w)
    w.setOverlayIcon = (img, desc) => {
      globalThis.__overlay.push({ png: img ? img.toPNG().toString('base64') : null, desc })
      set(img, desc)
    }
    const focused = w.isFocused.bind(w)
    w.isFocused = () => (globalThis.__focused === null ? focused() : globalThis.__focused)
  })
  const overlay = () => app.evaluate(() => globalThis.__overlay.at(-1) ?? null)
  // Each flash started (true) or stopped (false), since the last clearFlashes().
  const flashLog = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'flash').map((e) => e.on)
  let flashesFrom = 0
  const flashes = async () => flashLog().slice(flashesFrom)
  const clearFlashes = () => (flashesFrom = flashLog().length)
  const title = () => page.title()

  await page.getByText('alpha', { exact: true }).first().click()
  const one = await lib.addAgent(inv, alpha, { name: 'One' })
  const two = await lib.addAgent(inv, beta, { name: 'Two' })
  const live = async (p, a) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === a.id)
  await inv('session:start', alpha, { agentId: one.id })
  await inv('session:start', beta, { agentId: two.id })
  check('the agents start', !!(await until(async () => (await live(alpha, one))?.status === 'ready' && (await live(beta, two))?.status === 'ready', 20000)))
  const send = async (p, a, text) => {
    await inv('pty:write', lib.ptyKey(p, a.id), text)
    await lib.sleep(100)
    await inv('pty:write', lib.ptyKey(p, a.id), '\r')
  }
  check('no count while nothing needs you', !/^\(\d/.test(await title()))

  // --- Beta's agent finishes while alpha is shown: told quietly in the status bar, never counted (#1632).
  await send(beta, two, 'go')
  const finishedShown = await until(async () => (await page.locator('.statusbar .inbox-finished').count()) === 1, 10000)
  check('a finish alone: no count in the title (#1632)', !!finishedShown && !/^\(\d/.test(await title()), await title())
  check('…and no badge', (await overlay())?.png == null)
  check('finishing never flashes the button', (await flashes()).length === 0)

  // --- An agent at a permission prompt needs you: the count and the badge, until it goes on (the window focused, as
  // the test says: Windows won't give a background app the focus while another window has it; so no flash).
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__focused = true
    BrowserWindow.getAllWindows()[0].emit('focus')
  })
  await page.getByText('beta', { exact: true }).first().click()
  await send(beta, two, 'ask waitfile taskbar-go')
  check('the title shows the count', !!(await until(async () => (await title()).startsWith('(1) '), 10000)), await title())
  const badge = await until(async () => (await overlay())?.png && (await overlay()), 5000)
  check('the taskbar button gets a badge', !!badge?.png && badge.desc === '1 needs you', JSON.stringify(badge?.desc))
  if (badge?.png) fs.writeFileSync(path.join(lib.WORK, 'taskbar-badge-1.png'), Buffer.from(badge.png, 'base64'))
  fs.writeFileSync(path.join(claudeHome, 'taskbar-go'), '')
  check('once it goes on, the count clears', !!(await until(async () => !/^\(\d/.test(await title()), 8000)), await title())
  check('and the badge', !!(await until(async () => (await overlay())?.png === null, 5000)))

  // --- An agent asking for input while the window is in the background flashes the button.
  await app.evaluate(() => (globalThis.__focused = false))
  await send(alpha, one, 'ask work 3')
  check('a question in the background flashes the button', !!(await until(async () => (await flashes()).includes(true), 8000)), JSON.stringify(await flashes()))
  await until(async () => (await live(alpha, one))?.status === 'finished', 10000)

  // --- Both settings turn them off; turning the flash off stops the one under way (the window was never focused).
  await inv('settings:update', { notifications: { taskbarCount: false, flashOnWaiting: false } })
  check('turning the flash off stops it', !!(await until(async () => (await flashes()).at(-1) === false, HUNG_MS)), JSON.stringify(await flashes()))
  clearFlashes()
  await page.getByText('alpha', { exact: true }).first().click()
  await send(beta, two, 'ask go')
  await until(async () => (await live(beta, two))?.status === 'finished', 10000)
  await lib.sleep(800)
  check('with the settings off: no count in the title', !/^\(\d/.test(await title()), await title())
  check('no badge', (await overlay())?.png == null)
  check('and no flash', (await flashes()).length === 0, JSON.stringify(await flashes()))

  for (const [p, a] of [[alpha, one], [beta, two]]) await inv('session:stop', p, a.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
