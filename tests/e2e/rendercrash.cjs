// A window whose page crashes is reloaded, its terminals reattach and the agents keep running; a second crash
// within a minute asks instead (Reload / Open Logs / Quit Hive); a hang offers Wait / Reload, and recovering
// dismisses that. Native dialogs are stubbed in the test build's main process. Crashes only this test build's
// page (forcefullyCrashRenderer), never another Hive. The agent is the fake Claude Code. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'rendercrash-profile')
const ws = path.join(lib.WORK, 'rendercrash-ws')
const claudeHome = path.join(lib.WORK, 'rendercrash-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn().catch(() => null)) && Date.now() - t < ms) await lib.sleep(250)
  return v
}

// Playwright gives up on a page whose renderer crashed (it throws "Target crashed" from its connection), so once the
// page has crashed every look at it goes through the main process (executeJavaScript), which isn't affected.
process.on('uncaughtException', (e) => {
  if (/Target crashed/.test(String(e?.message))) return
  console.error(e)
  process.exit(1)
})

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47901), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Steady' })
  const key = lib.ptyKey(alpha, agent.id)
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 20000)))
  await inv('pty:write', key, 'remember this line')
  await lib.sleep(200)
  await inv('pty:write', key, '\r')
  check('it answers', !!(await until(async () => (await live())?.status === 'finished', 10000)))

  // Native dialogs: recorded, answered as the test says (a pending answer leaves the box open).
  await app.evaluate(({ dialog }) => {
    globalThis.__boxes = []
    globalThis.__answer = 0
    dialog.showMessageBox = (_win, o) => {
      globalThis.__boxes.push({ message: o.message, buttons: o.buttons, signal: o.signal })
      if (globalThis.__answer === 'pending') return new Promise((resolve) => o.signal?.addEventListener('abort', () => resolve({ response: 0 })))
      return Promise.resolve({ response: globalThis.__answer })
    }
  })
  // The page, through the main process.
  // A page that is reloading never answers: give up after a few seconds (until() asks again).
  const js = (code) =>
    Promise.race([
      app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(c), code),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no answer from the page')), 3000))
    ])
  const invMain = (ch, ...a) => js(`window.hive.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(a)})`)
  const liveMain = async () => (await invMain('session:live')).find((s) => s.agentId === agent.id)
  const shot = async (name) => {
    const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(path.join(lib.WORK, name), Buffer.from(b64, 'base64'))
  }
  const boxes = () => app.evaluate(() => globalThis.__boxes.map((b) => ({ message: b.message, buttons: b.buttons.join(','), aborted: !!b.signal?.aborted })))
  const crash = async () => {
    console.log('(crashing the page)')
    await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    await lib.sleep(1000) // A fixed wait on purpose: the crash has to take the page down first, so what follows sees the reloaded page, not the old one.
  }
  const pageBack = () => until(() => js("!!window.hive && !!document.querySelector('.menubar')"), 20000)
  const toastText = () => js(`[...document.querySelectorAll('.toast')].map((t) => t.innerText).find((t) => t.includes("Combwork's window stopped and was reloaded")) ?? ''`)

  // --- A crash: reloaded, with a note, the agent still running and its terminal attached.
  await crash()
  check('the page comes back by itself', !!(await pageBack()))
  check('a note says it was reloaded and the agents kept running', !!(await until(async () => /Your agents kept running/.test(await toastText()), 10000)))
  check('no question was asked', (await boxes()).length === 0)
  check('the agent is still running', (await liveMain())?.status === 'finished')
  check("its terminal shows what it printed before", !!(await until(() => js(`window.__hiveTerminalTextAt?.(${JSON.stringify(key)}, 'remember this line') ?? null`), 10000)))
  await shot('rendercrash-1-reloaded.png')

  // --- Again within a minute: it asks instead of reloading in a loop.
  await crash()
  check('a second crash asks', !!(await until(async () => (await boxes()).some((b) => /stopped working/.test(b.message)), 10000)))
  const asked = (await boxes()).find((b) => /stopped working/.test(b.message))
  check('with Reload, Open Logs and Quit Hive', asked?.buttons === 'Reload,Open Logs,Quit Hive', asked?.buttons)
  check('Reload brings the page back', !!(await pageBack()))
  check('the agent is still running after both', (await liveMain())?.status === 'finished')

  // --- A hang: Wait / Reload, gone once the page responds again.
  await app.evaluate(() => {
    globalThis.__boxes = []
    globalThis.__answer = 'pending'
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unresponsive'))
  check('a hang offers Wait and Reload after a few seconds', !!(await until(async () => (await boxes()).some((b) => /isn't responding/.test(b.message) && b.buttons === 'Wait,Reload'), 9000)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('responsive'))
  check('it goes away when the page responds again', !!(await until(async () => (await boxes())[0]?.aborted, HUNG_MS)))

  // --- A hang, then Reload: the page is reloaded without a crash note.
  await app.evaluate(() => {
    globalThis.__boxes = []
    globalThis.__answer = 1
  })
  const before = await js('performance.timeOrigin')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unresponsive'))
  check('Reload reloads the page', !!(await until(async () => (await js('performance.timeOrigin')) !== before && (await pageBack()), 20000)))
  await lib.sleep(2500) // A fixed wait on purpose: this checks that no crash note or second question appears.
  check('without a crash note or another question', (await toastText()) === '' && (await boxes()).length === 1)
  check('and the agent is still running', (await liveMain())?.status === 'finished')

  await invMain('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close().catch(() => undefined)
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
