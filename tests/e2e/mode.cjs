// Live permission mode: reported mode, switching with Shift+Tab (API and badge menu), Shift+Tab typed
// in the terminal, restart into Don't ask, the "Switch Now" offer after a settings change.
// Throwaway profile; trusted scratch workspace ws/demo. A real Claude Code session starts, but no
// prompt is ever sent (only Shift+Tab keys), so it runs in a Claude Code home of its own with a made-up API key
// (lib.ownClaudeHome, #368), never the user's ~/.claude. Clipboard untouched.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'mode-profile')
const ws = path.join(scratch, 'ws'), proj = path.join(ws, 'demo')
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(proj, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
;(async () => {
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ CW_USER_DATA: userData, ...lib.ownClaudeHome('mode').env })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  await page.keyboard.press('Escape')
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const live = async () => (await inv('session:live')).find((l) => l.projectPath.toLowerCase() === proj.toLowerCase())
  /** How many times Combwork has launched a session's process (its log's spawn lines): to wait for a relaunch. */
  const launches = () => (fs.readFileSync(path.join(userData, 'logs', 'combwork.log'), 'utf8').match(/ spawn \W?session:/g) ?? []).length
  const waitMode = async (m, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await live())?.permissionMode === m) return true; await sleep(200) } return false }
  await inv('workspace:open', ws); await sleep(600)
  await inv('project:updateConfig', proj, { providers: {}, layout: 'single', keybindings: {} })
  const settings = await inv('settings:get')
  check('default mode is Auto', settings.providers['claude-code'].defaultPermissionMode === 'auto', settings.providers['claude-code'].defaultPermissionMode)
  await page.getByText('demo', { exact: true }).first().click(); await sleep(400)
  const agent = await lib.soloAgent(inv, proj)
  await inv('workspace:refresh')
  await inv('session:start', proj, { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  const t0 = Date.now(); while (Date.now() - t0 < 20000 && (await live())?.status !== 'ready') await sleep(300)
  check('session ready', (await live())?.status === 'ready', (await live())?.status)
  check('starts in Auto', await waitMode('auto'), (await live())?.permissionMode)
  await page.screenshot({ path: path.join(scratch, 'mode-1-auto.png') })
  check('header badge shows Auto', /Auto/.test(await page.locator('.pane-footer-bar .mode-badge').innerText()))

  // API switch (what the menu uses)
  let r = await inv('session:setMode', proj, agent.id, 'plan')
  check('switch to Plan live', r.ok && (await waitMode('plan')), JSON.stringify(r))
  r = await inv('session:setMode', proj, agent.id, 'manual')
  check('switch to Manual live', r.ok && (await waitMode('manual')), JSON.stringify(r))
  // Shift+Tab typed in the terminal by the user shows up in Combwork
  await inv('pty:write', lib.ptyKey(proj, agent.id), '\x1b[Z')
  check('Shift+Tab in the terminal is picked up', await waitMode('acceptEdits'), (await live())?.permissionMode)
  check('no restart banner for mode changes', (await page.locator('.banner', { hasText: 'Restart the session' }).count()) === 0)

  // Badge menu → Auto
  await page.locator('.pane-footer-bar .mode-badge').click(); await sleep(400)
  const items = await page.locator('.menu .menu-item').allTextContents()
  check('menu lists modes with the current one marked', items.some((t) => /Accept edits.*Current mode/.test(t)) && items.some((t) => /Don't ask.*Restarts the session/.test(t)), JSON.stringify(items.slice(0, 6)))
  await page.screenshot({ path: path.join(scratch, 'mode-2-menu.png') })
  await page.locator('.menu .menu-item', { hasText: /^Auto/ }).first().click()
  check('menu switches to Auto', await waitMode('auto'))

  // Keyboard shortcut opens the menu
  await page.locator('.project-header h1').click()
  await page.keyboard.press('Control+Alt+M'); await sleep(400)
  check('Ctrl+Alt+M opens the mode menu', (await page.locator('.menu .menu-header', { hasText: 'Permission mode' }).count()) === 1)
  await page.keyboard.press('Escape'); await sleep(200)

  // Don't ask needs a restart; the conversation id is kept
  const sid = (await live()).sessionId
  await page.locator('.pane-footer-bar .mode-badge').click(); await sleep(300)
  await page.locator('.menu .menu-item', { hasText: "Don't ask" }).click(); await sleep(400)
  check('restart is confirmed first', await page.locator('.dialog', { hasText: "Restart in Don't ask?" }).count() === 1)
  const before = launches()
  await page.locator('.dialog button', { hasText: 'Restart' }).last().click()
  // The relaunch can be asked to trust the folder again: the first session's "Yes" may not have been saved yet when the
  // restart stopped it, a few seconds after it started (#283, on a busy machine). Answered as at the start, once the
  // relaunch's own process runs: until then the terminal still holds the first session's screen, its question too.
  // A relaunch that never spawns fails here, with no key sent to the old terminal (#341).
  const relaunch = await lib.acceptRelaunchTrust(inv, proj, agent.id, () => launches() > before)
  check('the restart starts a new Claude Code process', relaunch.spawned, `launches: ${launches()}, before: ${before}`)
  if (relaunch.trusted) console.log('(the relaunch asked to trust the folder again: answered yes)')
  const t1 = Date.now(); while (relaunch.spawned && Date.now() - t1 < 25000 && !((await live())?.permissionMode === 'dontAsk' && (await live())?.status === 'ready')) await sleep(300)
  const l2 = await live()
  // Nothing was typed in this session, so there is no conversation to resume: it restarts as a new one.
  check("restarted in Don't ask (a new session: nothing to resume yet)", l2?.permissionMode === 'dontAsk' && l2?.status === 'ready' && l2?.sessionId !== sid, JSON.stringify({ m: l2?.permissionMode, status: l2?.status, same: l2?.sessionId === sid }))
  // What the relaunch's Claude Code shows, when it isn't ready (#283): a question it is waiting on, or why it stopped.
  if (l2?.status !== 'ready') console.log(`(its terminal: …${lib.plainText(await inv('pty:buffer', lib.ptyKey(proj, agent.id)).catch(() => '')).slice(-1500)})`)

  // Settings change: offered, not forced
  await lib.setProjectLaunch(inv, proj, 'claude-code', { permissionMode: 'plan' }); await inv('workspace:refresh'); await sleep(1200) // A fixed wait on purpose: this checks the mode does NOT change until asked.
  check('mode unchanged until asked', (await live())?.permissionMode === 'dontAsk')
  const toast = page.locator('.toast', { hasText: 'Permission mode changed to Plan' })
  check('offer to switch running agents', (await toast.count()) === 1)
  await page.screenshot({ path: path.join(scratch, 'mode-3-offer.png') })
  // Don't ask → Plan is in the cycle (Shift+Tab from Don't ask goes to Manual first)
  await toast.locator('button', { hasText: 'Switch Now' }).click()
  // The real CLI takes longer to switch when the machine is busy (other suites run beside the CLI lane).
  check('Switch Now moves it to Plan', await waitMode('plan', 30000), `${(await live())?.permissionMode}; toasts: ${JSON.stringify(await page.locator('.toast').allInnerTexts())}`)
  await inv('workspace:refresh'); await sleep(1200) // A fixed wait on purpose: this checks that no second offer appears.
  check('no second offer', (await page.locator('.toast', { hasText: 'Permission mode changed' }).count()) <= 1)

  await inv('session:stop', proj); await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await inv('project:updateConfig', proj, { providers: {} })
  await app.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
