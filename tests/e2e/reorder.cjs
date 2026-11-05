// Moving a project's agents: Move Left in an agent's menu (#975: the strip's tabs went), dragging a pane by its header
// onto another pane, Move Right and Move Left across a page, and the shortcut. The panes' cells are saved in project.json,
// with the order as they read (#762; dropping on page buttons and empty cells is in swap.cjs), and a running agent's
// terminal and session survive the moves. The agent runs the fake Claude Code (fake-claude/). Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'reorder-profile')
const ws = path.join(lib.WORK, 'reorder-ws')
const claudeHome = path.join(lib.WORK, 'reorder-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47895), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const saved = () => JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8')).agents.map((a) => a.name).join(',')
  const paneNames = async () => (await page.locator('.pane-header-bar .agent-name').allInnerTexts()).join(',')

  await page.getByText('alpha', { exact: true }).first().click()
  const names = ['One', 'Two', 'Three']
  const agents = []
  for (const name of names) agents.push(await lib.addAgent(inv, alpha, { name }))
  await inv('project:updateConfig', alpha, { layout: 'columns3' })
  // One runs, with something in its terminal.
  const one = agents[0]
  await inv('session:start', alpha, { agentId: one.id })
  await until(async () => (await live(one.id))?.status === 'ready', 15000)
  await inv('pty:write', lib.ptyKey(alpha, one.id), 'hello')
  await lib.sleep(300)
  await inv('pty:write', lib.ptyKey(alpha, one.id), '\r')
  await until(async () => (await live(one.id))?.status === 'finished', 15000)
  const session = (await live(one.id)).sessionId
  check('starts in the order added', saved() === 'One,Two,Three' && (await paneNames()) === 'One,Two,Three', await paneNames())

  // Move Left twice in Three's menu (its pane header's, #975): Three goes first.
  for (const want of ['One,Three,Two', 'Three,One,Two']) {
    await lib.agentMenu(page, 'Three')
    await lib.menuEntry(page, 'Move Left').click()
    await until(async () => saved() === want, HUNG_MS)
  }
  check("Move Left in an agent's menu moves it", saved() === 'Three,One,Two', saved())
  check('the panes follow', !!(await until(async () => (await paneNames()) === 'Three,One,Two', HUNG_MS)), await paneNames())
  await page.screenshot({ path: path.join(lib.WORK, 'reorder-1-move-left.png') })

  // Drag One's pane by its header onto Two's pane: One takes Two's place.
  const header = (n) => page.locator('.pane-header-bar', { hasText: n }).locator('.agent-name')
  const a = await header('One').boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 })
  const target = page.locator('.pane-drop').last()
  check('dragging a pane shows where it can go', !!(await until(async () => (await page.locator('.pane-drop').count()) === 2, HUNG_MS)))
  const b = await target.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
  await lib.sleep(200)
  await page.screenshot({ path: path.join(lib.WORK, 'reorder-2-pane-drag.png') })
  await page.mouse.up()
  check("dropping a pane on another puts it in that agent's place", !!(await until(async () => (await paneNames()) === 'Three,Two,One', HUNG_MS)), await paneNames())
  check('and saves it', !!(await until(async () => saved() === 'Three,Two,One', HUNG_MS)), saved())
  check('the running agent kept its session', (await live(one.id))?.sessionId === session)
  check('and its terminal', String(await inv('pty:buffer', lib.ptyKey(alpha, one.id))).includes('Done: hello'))

  // The running agent's header: Compact and Stop; Archive and Start New… is in its ⋯ menu.
  const oneBar = page.locator('.pane-header-bar', { hasText: 'One' })
  check('the header has Stop but no archive button', (await oneBar.getByRole('button', { name: 'Stop', exact: true }).count()) === 1 && (await oneBar.locator('button[aria-label*="Archive"]').count()) === 0)
  await oneBar.getByRole('button', { name: 'More', exact: true }).click()
  const archiveItem = page.locator('.menu .menu-item', { hasText: 'Archive and Start New…' })
  check("its ⋯ menu has Archive and Start New…", !!(await until(async () => (await archiveItem.count()) === 1, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'reorder-archive-menu.png') })
  await page.keyboard.press('Escape')
  await until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)

  // The shortcut moves the focused agent: One (last) to the left.
  await lib.showAgent(page, 'One')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft')
  check('Ctrl+Alt+Shift+Left moves the focused agent left', !!(await until(async () => saved() === 'Three,One,Two', HUNG_MS)), saved())

  // Two pages: four more agents (seven in all), the layout automatic again (a 3×2 grid: pages of six, #134).
  await inv('project:updateConfig', alpha, { layout: 'auto' })
  for (const name of ['Four', 'Five', 'Six', 'Seven']) await lib.addAgent(inv, alpha, { name })
  await until(async () => (await page.locator('.page-switch button').count()) === 2, HUNG_MS)
  check('seven agents make two pages', (await page.locator('.page-switch button').count()) === 2)
  // Move Right on the sixth (last of page 1) takes it to page 2.
  await lib.agentMenu(page, 'Six')
  await lib.menuEntry(page, 'Move Right').click()
  check('Move Right crosses to the next page', !!(await until(async () => saved() === 'Three,One,Two,Four,Five,Seven,Six', HUNG_MS)), saved())
  check('and the view follows the agent to its page', !!(await until(async () => (await page.locator('.page-switch button.active').innerText()).trim() === '2', HUNG_MS)))

  // Move Left on Six (first on page 2) takes it back to page 1's last cell, swapping with Seven.
  await lib.agentMenu(page, 'Six')
  await lib.menuEntry(page, 'Move Left').click()
  check('Move Left crosses back to the page before', !!(await until(async () => saved() === 'Three,One,Two,Four,Five,Six,Seven', HUNG_MS)), saved())
  await page.screenshot({ path: path.join(lib.WORK, 'reorder-3-pages.png') })
  check('still running throughout', (await live(one.id))?.sessionId === session)

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
