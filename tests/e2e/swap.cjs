// Dragging agents swaps panes (#135), with Playwright's mouse as a person drags: a pane dropped on another pane swaps
// the two (running or stopped), in a fresh window and after clicking agents into panes (what failed before, when a
// stored pane arrangement won over the order); Move Left in an agent's menu (#975: the strip's tabs inserted); holding a dragged agent over a
// page button switches to that page, to drop it on a pane there (the swap crosses pages); a drop on a page button
// moves it to that page's first empty cell (#762); a drop on an empty pane moves it there, leaving its own cell empty;
// and no page button is a target where a drop would change nothing (its own page's, or a page with no empty cell,
// #238). After every step the panes show the cells saved for the layout, and the order follows them as they read. Four
// agents in three columns (pages abc | d); one runs the fake Claude Code (fake-claude/) and keeps its session
// throughout. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'swap-profile')
const ws = path.join(lib.WORK, 'swap-ws')
const claudeHome = path.join(lib.WORK, 'swap-claude-home')
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

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47885), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const projectJson = () => lib.projectConfig(userData, alpha) // with this user's view over it (HI-1749)
  const saved = () => projectJson().agents.map((a) => a.name)
  const paneNames = async () => (await page.locator('.pane-header-bar .agent-name').allInnerTexts()).map((t) => t.trim())
  const activePage = async () => Number((await page.locator('.page-switch button.active').innerText().catch(() => '1')).trim())
  // The panes show the saved cells (#762; before any move, the order): the page on screen holds cells (page − 1)·3 … +3.
  const matches = async () => {
    const now = projectJson()
    const name = (id) => now.agents.find((a) => a.id === id)?.name
    const cells = now.placement?.columns3 ?? now.agents.map((a) => a.id)
    const p = await activePage()
    return JSON.stringify(await paneNames()) === JSON.stringify(cells.slice((p - 1) * 3, p * 3).filter(Boolean).map(name))
  }
  const settle = async (want) => lib.until(async () => saved().join(',') === want && (await matches()), 8000)
  const at = async (loc) => {
    const b = await loc.boundingBox()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  // A native drag with the mouse: press, small moves until the drag has started (the page's dragstart), over each stop
  // in turn, and release, then wait for its dragend. A pane with a drop target is left only once it shows the drop as
  // over it; anything else (a page button, which shows its page after being held over) is held over for `hold` ms.
  // Each move nudges by a pixel: a native drag only follows the mouse while it moves.
  const dragState = () => page.evaluate(() => window.__swapDrag)
  const drag = async (from, stops, hold = 150) => {
    await page.evaluate(() => {
      window.__swapDrag = 'none'
      document.addEventListener('dragstart', () => (window.__swapDrag = 'started'), { once: true })
      document.addEventListener('dragend', () => (window.__swapDrag = 'ended'), { once: true })
    })
    const a = await at(from)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    let dx = 0
    if (!(await lib.until(async () => (await dragState()) !== 'none' || void (await page.mouse.move(a.x + 8 + (dx = 1 - dx), a.y, { steps: 2 })), HUNG_MS))) throw new Error('the drag never started (no dragstart)')
    for (const s of stops) {
      const loc = typeof s === 'function' ? await s() : s
      const b = await at(loc)
      await page.mouse.move(b.x, b.y, { steps: 8 })
      if ((await loc.locator('.pane-drop').count()) > 0) {
        if (!(await lib.until(async () => (await loc.locator('.pane-drop.over').count()) > 0 || void (await page.mouse.move(b.x + (dx = 1 - dx), b.y, { steps: 2 })), HUNG_MS))) throw new Error('the drop target never showed the drag over it')
      } else {
        await lib.sleep(hold)
        await page.mouse.move(b.x + 1, b.y, { steps: 2 })
        await lib.sleep(typeof s === 'function' ? 100 : hold)
      }
    }
    await page.mouse.up()
    // A source that left the screen (its page switched) gets no dragend in the page: then the drop targets going is the
    // end, which the case after such a drag checks.
    await lib.until(async () => (await dragState()) === 'ended' || (await page.locator('.pane-drop').count()) === 0, HUNG_MS)
  }
  const header = (n) => page.locator('.pane-header-bar', { hasText: n }).locator('.agent-name')
  const pane = (n) => page.locator('.agent-pane', { has: page.locator('.pane-header-bar', { hasText: n }) })

  await page.getByText('alpha', { exact: true }).first().click()
  const agents = []
  for (const name of ['One', 'Two', 'Three', 'Four']) agents.push(await lib.addAgent(inv, alpha, { name }))
  await inv('project:updateConfig', alpha, { layout: 'columns3' })
  await inv('workspace:refresh')
  const one = agents[0]
  await inv('session:start', alpha, { agentId: one.id })
  await lib.until(async () => (await live(one.id))?.status === 'ready', 15000)
  const session = (await live(one.id)).sessionId
  check('four agents in three columns: One, Two, Three on page 1', !!(await settle('One,Two,Three,Four')), JSON.stringify(await paneNames()))

  // --- A fresh window: One (running) dropped on Three's pane (stopped): they swap.
  await drag(header('One'), [pane('Three')])
  check('a pane dropped on another swaps them (running and stopped)', !!(await settle('Three,Two,One,Four')), `${saved()} / ${await paneNames()}`)
  check('the running agent kept its session', (await live(one.id))?.sessionId === session)
  check('the drag has ended: no drop targets left', (await page.locator('.pane-drop').count()) === 0)

  // --- After choosing agents into panes (the case that failed; #975: from the summary chip's list), drag Two onto One's pane.
  for (const n of ['Four', 'Two', 'One']) await lib.showAgent(page, n)
  await drag(header('Two'), [pane('One')])
  check('after choosing agents: a pane dropped on another swaps them too', !!(await settle('Three,One,Two,Four')), `${saved()} / ${await paneNames()}`)

  // --- No drop target on its own pane; a drop there does nothing.
  await drag(header('Three'), [pane('Three')])
  check('dropping an agent on its own pane does nothing', !!(await settle('Three,One,Two,Four')), saved().join(','))

  // --- One place at a time (#975: the strip's tabs inserted like browser tabs): Move Left in Four's menu, three times.
  for (const want of ['Three,One,Four,Two', 'Three,Four,One,Two', 'Four,Three,One,Two']) {
    await lib.agentMenu(page, 'Four')
    await lib.menuEntry(page, 'Move Left').click()
    await settle(want)
  }
  check("Move Left in an agent's menu: Four first, the panes follow", !!(await settle('Four,Three,One,Two')), `${saved()} / ${await paneNames()}`)

  // --- Hold over a page button to switch, then drop on a pane there: the swap crosses pages. From page 2 (Two), its
  // own pane header dragged (it leaves the screen when page 1 shows), held over "1", dropped on Three's pane.
  await page.locator('.page-switch button[aria-label="Agent page 2"]').click()
  await lib.until(async () => (await activePage()) === 2, 5000)
  check('page 2 shows Two', JSON.stringify(await paneNames()) === '["Two"]', JSON.stringify(await paneNames()))
  await drag(header('Two'), [page.locator('.page-switch button[aria-label="Agent page 1"]'), () => pane('Three')], 900)
  check('holding over page 1 showed it, and the drop swapped across pages', !!(await settle('Four,Two,One,Three')), `${saved()} / ${await paneNames()} / page ${await activePage()}`)
  check('the drag has ended after its source left the screen', !!(await lib.until(async () => (await page.locator('.pane-drop').count()) === 0, HUNG_MS)))

  // --- Escape after the hover switched pages (the dragged pane has left the screen), released without moving: the drag
  // ends at once, nothing moves, nothing restarts.
  await page.locator('.page-switch button[aria-label="Agent page 2"]').click()
  await lib.until(async () => (await activePage()) === 2, 5000)
  const before = saved().join(',')
  const s = await at(header('Three'))
  await page.mouse.move(s.x, s.y)
  await page.mouse.down()
  await page.mouse.move(s.x + 8, s.y, { steps: 3 })
  await lib.sleep(150)
  const p1 = await at(page.locator('.page-switch button[aria-label="Agent page 1"]'))
  await page.mouse.move(p1.x, p1.y, { steps: 8 })
  await lib.sleep(150)
  await page.mouse.move(p1.x + 1, p1.y, { steps: 2 })
  check('held over page 1, it shows (the dragged pane is gone)', !!(await lib.until(async () => (await activePage()) === 1, HUNG_MS)) && (await page.locator('.pane-drop').count()) === 3)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await lib.sleep(400)
  check('Escape ends the drag at once: no drop targets or drag marks left', (await page.locator('.pane-drop').count()) === 0 && (await page.locator('.pane-header-bar.dragging, .page-switch button.drop-target').count()) === 0, `${await page.locator('.pane-drop').count()} drop targets`)
  check('…and nothing moved', saved().join(',') === before && (await matches()), `${saved()} vs ${before}`)
  check('…and One still runs its session', (await live(one.id))?.sessionId === session)
  // A drop outside any target (the project header) cancels too.
  await drag(header('One'), [page.locator('.project-header h1')])
  check('a drop outside the targets moves nothing and leaves no drop targets', saved().join(',') === before && (await page.locator('.pane-drop').count()) === 0, `${saved()} / ${await page.locator('.pane-drop').count()}`)

  // --- A drop on a page button: to that page's first empty cell (#762; Four, from page 1, beside Three on page 2). Its
  // own cell on page 1 stays empty.
  await drag(header('Four'), [page.locator('.page-switch button[aria-label="Agent page 2"]')])
  check("a drop on a page button moves the agent to that page's first empty cell", !!(await lib.until(async () => saved().join(',') === 'Two,One,Three,Four', 8000)), saved().join(','))
  check('the panes show the cells saved', !!(await lib.until(matches, 5000)), `${saved()} / ${await paneNames()}`)
  check('…its cell on page 1 is left empty', JSON.stringify(projectJson().placement?.columns3?.map((id) => projectJson().agents.find((a) => a.id === id)?.name ?? null)) === '[null,"Two","One","Three","Four"]', JSON.stringify(projectJson().placement))

  // --- A drop on an empty pane (page 2 has two agents and a spare cell): the agent moves there. Two (on page 1) is held
  // over page 2's button until it shows, then dropped on the spare pane. Page 1 first (Four's move showed page 2).
  await page.locator('.page-switch button[aria-label="Agent page 1"]').click()
  await lib.until(async () => (await activePage()) === 1, 5000)
  await drag(header('Two'), [page.locator('.page-switch button[aria-label="Agent page 2"]'), () => page.locator('.agent-pane:not(:has(.pane-header-bar))').last()], 900)
  check('a drop on an empty pane moves the agent there', !!(await settle('One,Three,Four,Two')), `${saved()} / ${await paneNames()}`)

  // --- No page button is a target where a drop changes nothing (#238): Two is on page 2, now full; page 1 has two empty
  // cells. Each hover is shorter than the page switch (600 ms).
  const order = saved().join(',')
  const t2 = await at(header('Two'))
  await page.mouse.move(t2.x, t2.y)
  await page.mouse.down()
  await page.mouse.move(t2.x + 8, t2.y, { steps: 3 })
  await lib.sleep(150)
  const hover = async (loc) => {
    const b = await at(loc)
    await page.mouse.move(b.x, b.y, { steps: 8 })
    await lib.sleep(120)
    await page.mouse.move(b.x + 1, b.y, { steps: 2 })
    await lib.sleep(120)
  }
  const button = (n) => page.locator(`.page-switch button[aria-label="Agent page ${n}"]`)
  await hover(button(2))
  check("the agent dragged: its own page's button isn't a target", (await page.locator('.page-switch button.drop-target').count()) === 0)
  await hover(button(1))
  check("…while page 1's button is one (it has empty cells)", (await button(1).getAttribute('class'))?.includes('drop-target'), await button(1).getAttribute('class'))
  await hover(button(2))
  await page.mouse.up()
  await lib.sleep(400)
  check("released on its own page's button: nothing moved, the drag has ended", saved().join(',') === order && (await matches()) && (await page.locator('.pane-drop, .page-switch button.drop-target').count()) === 0, `${saved()} / ${await paneNames()}`)
  await page.screenshot({ path: path.join(lib.WORK, 'swap-done.png') })
  check('One still runs its own session', (await live(one.id))?.sessionId === session)

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
