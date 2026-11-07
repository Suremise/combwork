// One agent of an all-agents action (HI-2665): Resume (n) and Stop (n) in the project header are split buttons, their ▾
// a button of its own opening the menu of those agents; choosing one acts on that agent alone, as its pane would (Stop
// asks first; Cancel stops nobody). From the keyboard the ▾ opens the menu on its first agent, ↓ and Enter choose one,
// and Escape gives the focus back to the ▾. Agents ▾ has Start New for One Agent ▸, the narrow header's ⋯ Stop One
// Agent ▸ beside its Stop all entry (unchanged), and a project's sidebar menu Resume One Agent ▸ under Resume All.
// Three agents on the fake Claude Code (fake-claude/). Screenshots of the menus in both themes. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'oneagent-profile')
const ws = path.join(lib.WORK, 'oneagent-ws')
const claudeHome = path.join(lib.WORK, 'oneagent-claude-home')
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
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47899), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const { until } = lib
  // Starts an agent, trusts its folder and has one exchange, so it has a conversation to resume.
  const run = async (id) => {
    await inv('session:start', alpha, { agentId: id })
    await until(async () => ['waiting', 'ready'].includes((await live(id))?.status), HUNG_MS)
    if ((await live(id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    await until(async () => (await live(id))?.status === 'ready', HUNG_MS)
    // The line shown typed before its Enter.
    await inv('pty:write', lib.ptyKey(alpha, id), 'hello')
    await until(async () => /hello/.test(lib.plainText((await inv('pty:buffer', lib.ptyKey(alpha, id))) ?? '')), HUNG_MS)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    return until(async () => (await live(id))?.status === 'finished', HUNG_MS)
  }
  const header = page.locator('.project-header')
  const menuItems = () => page.locator('.menu .menu-item')
  const menuLabels = async () => (await menuItems().allInnerTexts()).map((t) => t.split('\n')[0].trim())
  const menuOpen = () => until(async () => (await menuItems().count()) > 0, 5000)
  const menuClosed = () => until(async () => (await page.locator('.menu').count()) === 0, 5000)
  // By its label exactly (an agent's row has its status words under its name).
  const pick = (label) => menuItems().filter({ has: page.getByText(label, { exact: true }) }).first().click()
  const running = async (agents) => Object.fromEntries(await Promise.all(agents.map(async (a) => [a.name, !!(await live(a.id))])))
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName)

  await page.getByText('alpha', { exact: true }).first().click()
  const ada = await lib.addAgent(inv, alpha, { name: 'Ada' })
  const bo = await lib.addAgent(inv, alpha, { name: 'Bo' })
  const cy = await lib.addAgent(inv, alpha, { name: 'Cy' })
  const all = [ada, bo, cy]
  for (const a of all) check(`${a.name} ran once`, !!(await run(a.id)))
  await inv('session:stop', alpha)
  check('all three stopped', !!(await until(async () => (await inv('session:live')).length === 0, HUNG_MS)))

  // --- Resume (3): its ▾, a button of its own, opens the menu of the stopped agents.
  const resumeArrow = header.getByRole('button', { name: 'Choose an agent to resume', exact: true })
  check('Resume (3) has its ▾, named for screen readers', !!(await until(async () => (await resumeArrow.count()) === 1, 5000)) && (await resumeArrow.getAttribute('aria-haspopup')) === 'menu')
  check('…beside the main part, which still resumes all 3', (await header.getByRole('button', { name: 'Resume all 3 stopped agents', exact: true }).count()) === 1)
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await resumeArrow.click()
    await menuOpen()
    await page.screenshot({ path: path.join(lib.WORK, `oneagent-resume-menu-${theme}.png`), clip: { x: 500, y: 0, width: 1000, height: 300 } })
    await page.keyboard.press('Escape')
    await menuClosed()
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // From the keyboard: Enter opens it on its first agent; Escape closes it, the focus back on the ▾.
  await resumeArrow.focus()
  await page.keyboard.press('Enter')
  await menuOpen()
  const labels = await menuLabels()
  check('the menu lists the three stopped agents, each with its state', JSON.stringify(labels) === JSON.stringify(['Ada', 'Bo', 'Cy']) && /Stopped/.test(await menuItems().first().innerText()), JSON.stringify(await menuItems().allInnerTexts()))
  const active = await page.evaluate(() => {
    const m = document.querySelector('.menu')
    const id = m?.getAttribute('aria-activedescendant')
    return id ? document.getElementById(id)?.innerText.split('\n')[0].trim() : null
  })
  check('…opened from the keyboard, on its first agent', active === 'Ada', String(active))
  await page.keyboard.press('Escape')
  await menuClosed()
  check('Escape closes it and gives the focus back to the ▾', (await focused()) === 'Choose an agent to resume', String(await focused()))

  // Chosen with the mouse: Bo alone resumes.
  await resumeArrow.click()
  await menuOpen()
  await pick('Bo')
  check('choosing Bo resumes Bo', !!(await until(async () => ['ready', 'finished'].includes((await live(bo.id))?.status), HUNG_MS)))
  check('…and only Bo', JSON.stringify(await running(all)) === JSON.stringify({ Ada: false, Bo: true, Cy: false }), JSON.stringify(await running(all)))
  // Chosen from the keyboard: ↓ and Enter take the second of Ada and Cy.
  await until(async () => (await resumeArrow.count()) === 1, 5000)
  await resumeArrow.focus()
  await page.keyboard.press('Enter')
  await menuOpen()
  check('the menu now lists Ada and Cy', JSON.stringify(await menuLabels()) === JSON.stringify(['Ada', 'Cy']), JSON.stringify(await menuLabels()))
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  check('↓ and Enter resume Cy', !!(await until(async () => ['ready', 'finished'].includes((await live(cy.id))?.status), HUNG_MS)))
  check('…and Ada stays stopped', !(await live(ada.id)))

  // --- Stop (2): its ▾ stops one, asking first as its pane does; Cancel stops nobody.
  const stopArrow = header.getByRole('button', { name: 'Choose an agent to stop', exact: true })
  check('Stop (2) has its ▾', !!(await until(async () => (await stopArrow.count()) === 1, 5000)))
  await stopArrow.click()
  await menuOpen()
  await page.screenshot({ path: path.join(lib.WORK, 'oneagent-stop-menu-dark.png'), clip: { x: 500, y: 0, width: 1000, height: 300 } })
  await pick('Bo')
  const asked = page.locator('.dialog', { hasText: 'Stop the running session of Bo' })
  check('choosing Bo asks first, naming Bo', !!(await until(async () => (await asked.count()) === 1, 5000)))
  await asked.getByRole('button', { name: 'Cancel' }).click()
  await until(async () => (await asked.count()) === 0, 5000)
  check('Cancel stops nobody', JSON.stringify(await running(all)) === JSON.stringify({ Ada: false, Bo: true, Cy: true }), JSON.stringify(await running(all)))
  await stopArrow.click()
  await menuOpen()
  await pick('Bo')
  await until(async () => (await asked.count()) === 1, 5000)
  await asked.getByRole('button', { name: 'Stop', exact: true }).click()
  check('confirmed, Bo stops', !!(await until(async () => !(await live(bo.id)), HUNG_MS)))
  check('…and only Bo', JSON.stringify(await running(all)) === JSON.stringify({ Ada: false, Bo: false, Cy: true }), JSON.stringify(await running(all)))

  // --- Agents ▾: Start New for One Agent ▸, after Start New (3).
  const agentsItems = await lib.agentsMenu(page)
  check('Agents ▾ has Start New for One Agent after Start New (3)', agentsItems.indexOf('Start New for One Agent') === agentsItems.indexOf('Start New (3)') + 1, JSON.stringify(agentsItems))
  await pick('Start New for One Agent')
  await until(async () => JSON.stringify(await menuLabels()) === JSON.stringify(['Ada', 'Bo', 'Cy']), 5000)
  check('…its sub-menu lists every agent', JSON.stringify(await menuLabels()) === JSON.stringify(['Ada', 'Bo', 'Cy']), JSON.stringify(await menuLabels()))
  await pick('Ada')
  check('choosing Ada starts Ada', !!(await until(async () => ['ready', 'finished', 'waiting'].includes((await live(ada.id))?.status), HUNG_MS)))
  check('…and only Ada (Bo stays stopped, Cy running)', JSON.stringify(await running(all)) === JSON.stringify({ Ada: true, Bo: false, Cy: true }), JSON.stringify(await running(all)))
  if ((await live(ada.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, ada.id), '\r')

  // --- The narrow header (the Assistant open at 900 px): Stop and Resume are in ⋯, Stop all unchanged, Stop One Agent ▸ after it.
  await lib.fitWindow(app, page, { width: 900, height: 900 })
  await page.keyboard.press('Control+Alt+I')
  const more = header.getByRole('button', { name: 'More actions' })
  const folded = await until(async () => (await header.locator('.act-stop').count()) === 0 && (await more.count()) === 1, 10000)
  check('900 px with the Assistant open: Stop has moved into ⋯', !!folded)
  await more.click()
  await menuOpen()
  const narrow = await menuLabels()
  const stopAt = narrow.indexOf('Stop all 2 running agents')
  check('⋯ keeps Stop all 2 running agents, with Stop One Agent after it', stopAt >= 0 && narrow[stopAt + 1] === 'Stop One Agent', JSON.stringify(narrow))
  await page.screenshot({ path: path.join(lib.WORK, 'oneagent-narrow-menu-dark.png') })
  await pick('Stop One Agent')
  await until(async () => JSON.stringify(await menuLabels()) === JSON.stringify(['Ada', 'Cy']), 5000)
  check('…its sub-menu lists Ada and Cy', JSON.stringify(await menuLabels()) === JSON.stringify(['Ada', 'Cy']), JSON.stringify(await menuLabels()))
  await pick('Cy')
  const askedCy = page.locator('.dialog', { hasText: 'Stop the running session of Cy' })
  await until(async () => (await askedCy.count()) === 1, 5000)
  await askedCy.getByRole('button', { name: 'Stop', exact: true }).click()
  check('Cy alone stops', !!(await until(async () => !(await live(cy.id)), HUNG_MS)) && !!(await live(ada.id)), JSON.stringify(await running(all)))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.fitWindow(app, page, { width: 1500, height: 900 })

  // --- The sidebar's project menu: Resume All's click is unchanged, Resume One Agent ▸ after it.
  await page.locator('.sidebar').getByText('alpha', { exact: true }).first().click({ button: 'right' })
  await menuOpen()
  const side = await menuLabels()
  check("the project's sidebar menu has Resume One Agent after Resume All", side.indexOf('Resume One Agent') === side.indexOf('Resume All') + 1 && side.indexOf('Resume All') >= 0, JSON.stringify(side))
  await page.screenshot({ path: path.join(lib.WORK, 'oneagent-sidebar-menu-dark.png') })
  await pick('Resume One Agent')
  await until(async () => JSON.stringify(await menuLabels()) === JSON.stringify(['Bo', 'Cy']), 5000)
  check('…its sub-menu lists Bo and Cy', JSON.stringify(await menuLabels()) === JSON.stringify(['Bo', 'Cy']), JSON.stringify(await menuLabels()))
  await pick('Cy')
  check('choosing Cy resumes Cy alone', !!(await until(async () => !!(await live(cy.id)), HUNG_MS)) && !(await live(bo.id)), JSON.stringify(await running(all)))

  await inv('session:stop', alpha)
  await until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
