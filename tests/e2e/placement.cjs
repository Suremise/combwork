// Any agent in any cell (#762), with Playwright's mouse and keyboard as a person uses them: a lone agent in a grid of
// six is dragged to another cell and moved every way from the keyboard (each move said, and the edge); two agents in a
// grid of six leave four empty cells ("Drop an agent here"); a pane dragged onto an empty cell moves there, onto another pane the two
// swap; Move Agent Up (its shortcut) moves a pane up a row, said to screen readers; a new agent takes the first empty
// cell; another layout shows the agents in the cells' order and switching back restores the cells; an empty cell's Move
// Agent Here brings an agent from another page; agents added and removed leave the others where they are (add, add,
// remove: the removed one's cell stays empty); and the cells survive a restart. Pictured in both themes. Dev build,
// throwaway profile and workspace; no sessions run.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'placement-profile')
const ws = path.join(lib.WORK, 'placement-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const launch = async () => {
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47938) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  return { app, page, inv }
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let { app, page, inv } = await launch()
  await lib.openWorkspace(inv, page, ws)
  const projectJson = () => lib.projectConfig(userData, alpha) // with this user's view over it (HI-1749)
  /** A layout's saved cells by agent name ("." for an empty cell), joined: "One . . Two". */
  const savedCells = (layout) => {
    const c = projectJson()
    return (c.placement?.[layout] ?? []).map((id) => c.agents.find((a) => a.id === id)?.name ?? '.').join(' ')
  }
  /** The panes on screen in their cells' order, "." for an empty one. */
  const shownCells = async () =>
    (await page.locator('.agent-pane').evaluateAll((els) => els.map((el) => el.querySelector('.pane-header-bar .agent-name')?.textContent?.trim() ?? '.'))).join(' ')
  const pane = (n) => page.locator('.agent-pane', { has: lib.paneHeader(page, n) })
  const empty = () => page.locator('.agent-pane:not(:has(.pane-header-bar))')
  const at = async (loc) => {
    const b = await loc.boundingBox()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  // A native drag with the mouse: press, small moves until the drag has started, over the target until it shows the drop
  // as over it, release, and wait for the drop targets to go. Each move nudges by a pixel: a native drag only follows
  // the mouse while it moves.
  const drag = async (from, to) => {
    await page.evaluate(() => {
      window.__placeDrag = 'none'
      document.addEventListener('dragstart', () => (window.__placeDrag = 'started'), { once: true })
    })
    const a = await at(from)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    let dx = 0
    if (!(await lib.until(async () => (await page.evaluate(() => window.__placeDrag)) !== 'none' || void (await page.mouse.move(a.x + 8 + (dx = 1 - dx), a.y, { steps: 2 })), HUNG_MS))) throw new Error('the drag never started (no dragstart)')
    const target = await to()
    const b = await at(target)
    await page.mouse.move(b.x, b.y, { steps: 8 })
    if (!(await lib.until(async () => (await target.locator('.pane-drop.over').count()) > 0 || void (await page.mouse.move(b.x + (dx = 1 - dx), b.y, { steps: 2 })), HUNG_MS))) throw new Error('the drop target never showed the drag over it')
    await page.mouse.up()
    await lib.until(async () => (await page.locator('.pane-drop').count()) === 0, HUNG_MS)
  }
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes(t), HUNG_MS)
  }

  const said = async () => (await page.locator('.session-toolbar [role="status"]').textContent()).trim()
  // A move from the keyboard, done once it is said, saved and shown: the window says it at once, before the save ends,
  // so the next key waits for all three (the grid of six's cells, `cells` as savedCells writes them).
  const key = async (k, want, cells) => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press(`Control+Alt+Shift+${k}`)
    const shown = cells.split(' ').concat(Array(6).fill('.')).slice(0, 6).join(' ')
    return !!(await lib.until(async () => (await said()) === want && savedCells('grid6') === cells && (await shownCells()) === shown, HUNG_MS))
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const one = await lib.addAgent(inv, alpha, { name: 'One' })
  await inv('project:updateConfig', alpha, { layout: 'grid6' })
  await inv('workspace:refresh')
  // --- A lone agent (#762 round 2): it can be dragged, and moved every way from the keyboard.
  check('one agent in a grid of six: the first cell, five empty to drop it on', !!(await lib.until(async () => (await shownCells()) === 'One . . . . .', HUNG_MS)) && (await page.getByText('Drop an agent here').count()) === 5, await shownCells())
  await drag(lib.paneHeader(page, 'One').locator('.agent-name'), () => empty().last())
  check('a lone agent dragged onto an empty cell moves there', !!(await lib.until(async () => savedCells('grid6') === '. . . . . One' && (await shownCells()) === '. . . . . One', HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)
  await lib.showAgent(page, 'One')
  // Each save held back (#762 round 3): the moves are said at once, and each key waits for its save before the next.
  await app.evaluate(() => void (process.env.HIVE_TEST_SLOW_IPC = 'agents:place=400'))
  check('…Up from the keyboard: said, saved and shown', await key('ArrowUp', 'One: row 1, column 3', '. . One'), `${await said()} / ${savedCells('grid6')}`)
  check('…Left', await key('ArrowLeft', 'One: row 1, column 2', '. One'), `${await said()} / ${savedCells('grid6')}`)
  check('…Down', await key('ArrowDown', 'One: row 2, column 2', '. . . . One'), `${await said()} / ${savedCells('grid6')}`)
  check('…Right', await key('ArrowRight', 'One: row 2, column 3', '. . . . . One'), `${await said()} / ${savedCells('grid6')}`)
  await app.evaluate(() => void (process.env.HIVE_TEST_SLOW_IPC = ''))
  check('…and at the edge it says so, moving nothing', await key('ArrowRight', "One can't move further right", '. . . . . One'), `${await said()} / ${savedCells('grid6')}`)
  await lib.agentMenu(page, 'One')
  // At the last cell: Move Left and Move Up go somewhere, Move Right and Move Down don't.
  const enabled = async (label) => (await lib.menuEntry(page, label).count()) === 1 && !(await lib.menuEntry(page, label).getAttribute('class')).includes('disabled')
  check('its menu offers the moves that go somewhere (#762 round 2)', (await enabled('Move Left')) && (await enabled('Move Up')) && !(await enabled('Move Right')) && !(await enabled('Move Down')), JSON.stringify(await page.locator('.menu .menu-item').allInnerTexts()))
  await page.keyboard.press('Escape')
  await inv('agents:place', alpha, 'grid6', [one.id])
  await inv('workspace:refresh')

  await lib.addAgent(inv, alpha, { name: 'Two' })
  check('two agents in a grid of six: the first two cells, four empty', !!(await lib.until(async () => (await shownCells()) === 'One Two . . . .', HUNG_MS)), await shownCells())
  check('an empty cell says an agent can be dropped there', (await page.getByText('Drop an agent here').count()) === 4)

  // --- One dragged onto the last cell: it moves there, its own cell left empty.
  await drag(lib.paneHeader(page, 'One').locator('.agent-name'), () => empty().last())
  check('a pane dropped on an empty cell moves there', !!(await lib.until(async () => (await shownCells()) === '. Two . . . One', HUNG_MS)), await shownCells())
  check('…saved for the layout', !!(await lib.until(async () => savedCells('grid6') === '. Two . . . One', HUNG_MS)), savedCells('grid6'))
  check('…with the order as the cells read', projectJson().agents.map((a) => a.name).join(',') === 'Two,One')

  // --- Two dragged onto One's pane: they swap.
  await drag(lib.paneHeader(page, 'Two').locator('.agent-name'), () => pane('One'))
  check('a pane dropped on another swaps them', !!(await lib.until(async () => savedCells('grid6') === '. One . . . Two' && (await shownCells()) === '. One . . . Two', HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)

  // --- A pane moved while its save is held (#1229): a refresh meanwhile reads the cells from before, and its report
  // reaches the window (seen by a listener after the window's own, then drawn); the panes stay where they were moved.
  await app.evaluate(() => void (process.env.HIVE_TEST_SLOW_IPC = 'agents:place=20000*1'))
  await lib.showAgent(page, 'Two')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft')
  check('Move Agent Left on Two, its save held: shown at once, not saved yet', !!(await lib.until(async () => (await shownCells()) === '. One . . Two .', HUNG_MS)) && savedCells('grid6') === '. One . . . Two', `${savedCells('grid6')} / ${await shownCells()}`)
  await page.evaluate(() => {
    window.__olderCells = null
    window.combwork.onEvent((e) => {
      const p = e.type === 'workspace-changed' && window.__olderCells === null ? e.workspace?.projects.find((x) => x.name === 'alpha') : null
      if (p) window.__olderCells = (p.config.placement?.grid6 ?? []).map((id) => p.agents.find((a) => a.id === id)?.name ?? '.').join(' ')
    })
  })
  await inv('workspace:refresh')
  const older = await lib.until(() => page.evaluate(() => window.__olderCells), HUNG_MS)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  check('…a refresh meanwhile reports the cells from before the move', older === '. One . . . Two', String(older))
  check('…and the panes stay where they were moved', (await shownCells()) === '. One . . Two .', await shownCells())
  await app.evaluate(() => void (process.env.HIVE_TEST_SLOW_IPC = ''))
  // Bound: the save's hold left over, plus a hung run's.
  check('…saved once its save goes on, still shown', !!(await lib.until(async () => savedCells('grid6') === '. One . . Two' && (await shownCells()) === '. One . . Two .', 20000 + HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+ArrowRight')
  check('…and Move Agent Right puts it back', !!(await lib.until(async () => savedCells('grid6') === '. One . . . Two' && (await shownCells()) === '. One . . . Two', HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)

  // --- Two moves of a pane, the later refused while the earlier's save is held (#1229 round 3): the panes show the
  // earlier's cells, and once it is saved, what was saved, with no other refresh needed.
  await app.evaluate(() => void (process.env.HIVE_TEST_SLOW_IPC = 'agents:place=20000*1'))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft')
  check('Move Agent Left on Two, its save held', !!(await lib.until(async () => (await shownCells()) === '. One . . Two .', HUNG_MS)) && savedCells('grid6') === '. One . . . Two', `${savedCells('grid6')} / ${await shownCells()}`)
  // The next save fails at once (the held one has taken its delay already, and takes no failure once this one has).
  await app.evaluate(() => void (process.env.HIVE_TEST_FAIL_IPC = 'agents:place*1'))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft')
  const refused = page.locator('.toast', { hasText: 'Could not move the agent' })
  check("…Move Agent Left again, refused: the panes show the first move's cells, not the refused one's", !!(await lib.until(async () => (await refused.count()) > 0 && (await shownCells()) === '. One . . Two .', HUNG_MS)), `${await refused.count()} toasts / ${await shownCells()}`)
  await app.evaluate(() => void (process.env.HIVE_TEST_SLOW_IPC = process.env.HIVE_TEST_FAIL_IPC = ''))
  // Bound: the save's hold left over, plus a hung run's.
  check('…once the first is saved, the panes show what was saved', !!(await lib.until(async () => savedCells('grid6') === '. One . . Two' && (await shownCells()) === '. One . . Two .', 20000 + HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)
  await page.locator('.toast .icon-btn[aria-label="Dismiss"], .toast button[title="Dismiss"]').first().click().catch(() => undefined)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+ArrowRight')
  check('…and Move Agent Right puts it back again', !!(await lib.until(async () => savedCells('grid6') === '. One . . . Two' && (await shownCells()) === '. One . . . Two', HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)
  for (const t of ['dark', 'light']) {
    await theme(t)
    await page.screenshot({ path: path.join(lib.WORK, `placement-1-grid-${t}.png`) })
  }

  // --- The keyboard: Two focused, Ctrl+Alt+Shift+Up moves its pane up a row; said to screen readers.
  await lib.showAgent(page, 'Two')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+ArrowUp')
  check('Move Agent Up moves the pane up a row', !!(await lib.until(async () => savedCells('grid6') === '. One Two' && (await shownCells()) === '. One Two . . .', HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)
  check('…and says where it went', !!(await lib.until(async () => (await said()) === 'Two: row 1, column 3', HUNG_MS)), await said())
  await page.keyboard.press('Control+Alt+Shift+ArrowUp')
  check('…and that it is at the top already', !!(await lib.until(async () => (await said()) === "Two can't move further up", HUNG_MS)), await said())

  // --- A new agent takes the first empty cell.
  await lib.addAgent(inv, alpha, { name: 'Three' })
  check('a new agent takes the first empty cell', !!(await lib.until(async () => (await shownCells()) === 'Three One Two . . .', HUNG_MS)), await shownCells())

  // --- Two columns (nothing placed there): the agents in the cells' order, two pages. Grid of six again: as left.
  await inv('project:updateConfig', alpha, { layout: 'columns2' })
  await inv('workspace:refresh')
  check('another layout shows the agents in the order the cells read', !!(await lib.until(async () => (await shownCells()) === 'One Two', HUNG_MS)), await shownCells())
  // Page 2 holds the third agent and an empty cell: Move Agent Here there brings an agent from page 1.
  await page.locator('.page-switch button[aria-label="Agent page 2"]').click()
  await lib.until(async () => (await empty().count()) === 1, HUNG_MS)
  await empty().getByRole('button', { name: 'Move Agent Here' }).click()
  check("an empty cell's Move Agent Here lists the other page's agents", !!(await lib.until(async () => (await lib.menuEntry(page, 'One').count()) === 1 && (await lib.menuEntry(page, 'Two').count()) === 1, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'placement-2-move-here-menu.png') })
  await lib.menuEntry(page, 'One').click()
  check('…and choosing one moves it into that cell', !!(await lib.until(async () => savedCells('columns2') === '. Two Three One' && (await shownCells()) === 'Three One', HUNG_MS)), `${savedCells('columns2')} / ${await shownCells()}`)
  await page.screenshot({ path: path.join(lib.WORK, 'placement-2-columns2.png') })
  await inv('project:updateConfig', alpha, { layout: 'grid6' })
  await inv('workspace:refresh')
  check('back in the grid of six, the panes are where they were put', !!(await lib.until(async () => (await shownCells()) === 'Three One Two . . .', HUNG_MS)), await shownCells())

  // --- Add, add, remove (#762 round 2): Four takes the first empty cell and keeps it; One removed leaves its cell empty.
  await lib.addAgent(inv, alpha, { name: 'Four' })
  check('a fourth agent takes the first empty cell, saved', !!(await lib.until(async () => savedCells('grid6') === 'Three One Two Four' && (await shownCells()) === 'Three One Two Four . .', HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)
  await inv('agents:remove', alpha, one.id, { deleteWorktree: false })
  check("a removed agent's cell stays empty: the others stay where they are", !!(await lib.until(async () => savedCells('grid6') === 'Three . Two Four' && (await shownCells()) === 'Three . Two Four . .', HUNG_MS)), `${savedCells('grid6')} / ${await shownCells()}`)

  // --- A restart keeps the cells.
  await app.close()
  ;({ app, page, inv } = await launch())
  await page.getByText('alpha', { exact: true }).first().click()
  check('after a restart, the panes are in the same cells', !!(await lib.until(async () => (await shownCells()) === 'Three . Two Four . .', HUNG_MS)), await shownCells())
  await theme('dark')
  await page.screenshot({ path: path.join(lib.WORK, 'placement-3-restart-dark.png') })

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
