// Hidden terminals keep their size (#247): opening Settings (and changing the terminal's font while it's open), another
// project tab, another project and a layout that hides an agent never tell a running session a size the window didn't
// give it. Each fake CLI records every size it is given (fake-sizes.jsonl): none is below 20 × 5, nothing changes while
// its terminal is hidden, coming back gives the same size as before (or one new size after a font change), no
// in-between size while the view settles (a smaller window, 125% zoom), and a terminal that was scrolled to the bottom
// is still at the bottom well after (xterm syncs its scroll position late), while one scrolled up to read stays on its
// line. At the end, at the narrowest window with the Progress panel open, what a terminal shows re-wraps (#896), and two
// columns there show one at a time, with two again once there is room (#1037). A
// Claude Code agent and a Codex agent (the fakes).
// Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'termsize-profile')
const ws = path.join(lib.WORK, 'termsize-ws')
const claudeHome = path.join(lib.WORK, 'termsize-claude-home')
const codexHome = path.join(lib.WORK, 'termsize-codex-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const MIN_COLS = 20
const MIN_ROWS = 5
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Every size a fake CLI was given, oldest first: { sessionId, cols, rows, at }. */
function sizes(home) {
  try {
    return fs.readFileSync(path.join(home, 'fake-sizes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47924), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  // Low, so a few turns scroll the terminals.
  await lib.fitWindow(app, page, { width: 1300, height: 560 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.waitForProvider(inv, 'codex')
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()

  const claude = await lib.addAgent(inv, alpha, { name: 'Writer' })
  const codex = await lib.addAgent(inv, alpha, { name: 'Checker', provider: 'codex' })
  await page.locator('.layout-switch button[aria-label="Two columns"]').click()
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  for (const a of [claude, codex]) await inv('session:start', alpha, { agentId: a.id })
  check('both agents start', !!(await lib.until(async () => (await live(claude.id))?.status === 'ready' && (await live(codex.id))?.status === 'ready', 25000)))
  const agents = [
    { name: 'Claude Code', a: claude, home: claudeHome, key: lib.ptyKey(alpha, claude.id) },
    { name: 'Codex', a: codex, home: codexHome, key: lib.ptyKey(alpha, codex.id) }
  ]
  const state = (key) => page.evaluate((k) => window.__hiveTerminalState(k), key)
  // Turns until each terminal has scrolled.
  for (const g of agents) {
    for (let i = 1; i <= 12 && !((await state(g.key))?.baseY > 0); i++) {
      await inv('pty:write', g.key, `turn ${i}`)
      await lib.sleep(100)
      await inv('pty:write', g.key, '\r')
      // The turn starting may be over before it is seen (a fast turn): up to 3 s for it, then the wait for its end.
      await lib.until(async () => (await live(g.a.id))?.status !== 'finished', 3000)
      await lib.until(async () => (await live(g.a.id))?.status === 'finished', 10000)
    }
  }
  const atBottom = (s) => !!s && s.viewportY === s.baseY
  for (const g of agents) {
    const s = await state(g.key)
    check(`${g.name}: its terminal has scrolled and is at the bottom`, atBottom(s) && s.baseY > 0, JSON.stringify(s))
  }
  await lib.sleep(500)

  /** Hides the terminals with `hide`, waits, shows them with `show`: what each CLI was given meanwhile and after. */
  const roundTrip = async (label, hide, show, { whileHidden, sizeChanges = false } = {}) => {
    const before = agents.map((g) => ({ g, n: sizes(g.home).length, last: sizes(g.home).at(-1), term: null }))
    for (const b of before) b.term = await state(b.g.key)
    await hide()
    await lib.sleep(700)
    if (whileHidden) await whileHidden()
    await lib.sleep(900)
    const hidden = agents.map((g, i) => sizes(g.home).slice(before[i].n))
    await show()
    // Shown again: one new size after a font change; otherwise none, which only time can tell (on purpose).
    if (sizeChanges) await lib.until(() => agents.every((g, i) => sizes(g.home).length > before[i].n), 5000)
    // No further size may follow, and past the time Combwork holds a terminal at the bottom, it must stay there.
    await lib.sleep(1600) // on purpose
    for (const [i, b] of before.entries()) {
      const g = b.g
      const during = hidden[i]
      check(`${label}: ${g.name} is told nothing while hidden`, during.length === 0, JSON.stringify(during))
      const after = sizes(g.home).slice(b.n)
      const small = after.filter((s) => s.cols < MIN_COLS || s.rows < MIN_ROWS)
      check(`${label}: ${g.name} is never given a size below ${MIN_COLS} × ${MIN_ROWS}`, small.length === 0, JSON.stringify(small))
      const now = sizes(g.home).at(-1)
      const term = await state(g.key)
      if (sizeChanges) check(`${label}: ${g.name} is given one new size, its terminal's`, after.length === 1 && now.cols === term.cols && now.rows === term.rows, JSON.stringify({ after, term }))
      else check(`${label}: ${g.name} keeps its size`, after.length === 0 && term.cols === b.term.cols && term.rows === b.term.rows, JSON.stringify({ after, before: b.term, term }))
      check(`${label}: ${g.name}'s terminal is still at the bottom`, atBottom(term), JSON.stringify(term))
    }
  }

  const settingsBtn = page.locator('.activity-btn[aria-label="Settings"]')
  const projectsBtn = page.locator('.activity-btn[aria-label="Projects"]')
  await roundTrip('Settings', () => settingsBtn.click(), () => projectsBtn.click())
  // The bug's path: the terminal's appearance changes while Settings hides it.
  await roundTrip('Settings, font changed meanwhile', () => settingsBtn.click(), () => projectsBtn.click(), {
    whileHidden: () => inv('settings:update', { appearance: { terminalFontSize: 15 } }),
    sizeChanges: true
  })
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-after-settings.png') })
  // Shown again, xterm can move the view itself a moment later (its scroll position synced from a stale one): Combwork puts
  // a terminal that follows its output back at the bottom. The same move, made just after coming back from Settings.
  await settingsBtn.click()
  await lib.sleep(500)
  await projectsBtn.click()
  await lib.sleep(200)
  for (const g of agents) await page.evaluate((k) => window.__hiveTerminalScrollLines(k, -3), g.key)
  await lib.sleep(1600) // on purpose: past the hold, it must still be at the bottom
  for (const g of agents) check(`late scroll after Settings: ${g.name} is put back at the bottom`, atBottom(await state(g.key)), JSON.stringify(await state(g.key)))
  await roundTrip('Files tab', () => page.locator('.tabs .tab', { hasText: 'Files' }).first().click(), () => page.locator('.tabs .tab', { hasText: 'Session' }).first().click())
  await roundTrip('Another project', () => page.getByText('beta', { exact: true }).first().click(), () => page.getByText('alpha', { exact: true }).first().click())
  // One at a time hides the Codex agent; it may be given its new pane's size when shown, never a tiny one.
  const n0 = sizes(codexHome).length
  await page.locator('.layout-switch button[aria-label="One at a time"]').click()
  await lib.sleep(1000) // on purpose: nothing may happen
  check('One at a time: the hidden Codex agent is told nothing', sizes(codexHome).length === n0, JSON.stringify(sizes(codexHome).slice(n0)))
  await page.locator('.layout-switch button[aria-label="Two columns"]').click()
  await lib.until(async () => (await page.locator('.agent-pane:visible').count()) === 2, 5000)
  await lib.sleep(600)
  for (const g of agents) {
    const small = sizes(g.home).filter((s) => s.cols < MIN_COLS || s.rows < MIN_ROWS)
    check(`whole run: ${g.name} was never given a size below ${MIN_COLS} × ${MIN_ROWS}`, small.length === 0, JSON.stringify(small))
    check(`whole run: ${g.name}'s terminal ends at the bottom`, atBottom(await state(g.key)))
  }

  // A smaller window, where the project header measures itself and shortens a moment after being shown, at 100% and 125%:
  // coming back from Settings settles at once, with no in-between size.
  await lib.fitWindow(app, page, { width: 1000, height: 650 })
  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await lib.sleep(1500) // on purpose: the new window size and zoom settle first
    await roundTrip(`Settings at 1000 × 650, ${zoom * 100}%`, () => settingsBtn.click(), () => projectsBtn.click())
  }
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-zoom.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await lib.sleep(1500) // on purpose: settle again

  // Scrolled up to read: Settings and back leaves it on its line; scrolled back down, it follows the output again.
  const writer = agents[0]
  await page.locator(`.terminal-host[data-pty=${JSON.stringify(writer.key)}]`).hover()
  await page.mouse.wheel(0, -120)
  await lib.until(async () => !atBottom(await state(writer.key)), HUNG_MS)
  const reading = await state(writer.key)
  check('reader: Claude Code scrolled up', !atBottom(reading), JSON.stringify(reading))
  await settingsBtn.click()
  await lib.sleep(500)
  await projectsBtn.click()
  await lib.sleep(1600) // on purpose: nothing may move it
  const back = await state(writer.key)
  check('reader: still on the same line after Settings', back.viewportY === reading.viewportY && back.baseY === reading.baseY, JSON.stringify({ reading, back }))
  await page.locator(`.terminal-host[data-pty=${JSON.stringify(writer.key)}]`).hover()
  for (let i = 0; i < 10 && !atBottom(await state(writer.key)); i++) await page.mouse.wheel(0, 120)
  check('reader: scrolled back down to the bottom', !!(await lib.until(async () => atBottom(await state(writer.key)), HUNG_MS)), JSON.stringify(await state(writer.key)))
  await roundTrip('Settings after scrolling back down', () => settingsBtn.click(), () => projectsBtn.click())
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-end.png') })

  // Narrowed, what the terminal shows re-wraps instead of being cut at its edge (#896): Combwork's exit line, and a line as
  // wide as the terminal was, written in a wide window. xterm keeps a line's cells past a narrower terminal's edge
  // without drawing them, so only what is drawn counts.
  const fitted = () => page.evaluate(() => window.__hiveTerminalsFitted())
  const drawn = async () => {
    const cols = (await state(writer.key)).cols
    return ((await page.evaluate((k) => window.__hiveTerminalLines(k), writer.key)) ?? []).map((l) => l.slice(0, cols)).join('')
  }
  // One pane: two columns at the narrowest window with the panel open are narrower than Combwork fits a terminal to.
  await page.locator('.layout-switch button[aria-label="One at a time"]').click()
  await lib.fitWindow(app, page, { width: 1400, height: 650 })
  await inv('session:stop', alpha, claude.id)
  check('reflow: Combwork writes its exit line', !!(await lib.until(async () => (await drawn()).includes('[process exited with code'), HUNG_MS)), await drawn())
  check('reflow: the terminal is fitted to the wide window', !!(await lib.until(fitted, HUNG_MS)), JSON.stringify(await state(writer.key)))
  const wide = (await state(writer.key)).cols
  const marker = Array.from({ length: wide }, (_, i) => String.fromCharCode(65 + (i % 26))).join('')
  await page.evaluate(([k, d]) => window.__hiveTerminalOutput(k, d), [writer.key, `${marker}\r\n`])
  // The narrowest window, with the Progress panel open.
  await lib.fitWindow(app, page, { width: 900, height: 650 })
  if (!(await page.locator('.progress-panel').count())) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', { type: 'menu-command', command: 'progress.toggle', args: [] }))
  check('reflow: the Progress panel opens', !!(await lib.until(async () => (await page.locator('.progress-panel').count()) > 0, HUNG_MS)))
  check('reflow: the terminal narrows', !!(await lib.until(async () => (await state(writer.key)).cols < wide && (await fitted()), HUNG_MS)), JSON.stringify({ wide, now: await state(writer.key) }))
  check('reflow: the wide line and the exit line are whole after narrowing', !!(await lib.until(async () => { const t = await drawn(); return t.includes(marker) && t.includes('[process exited with code') }, HUNG_MS)), JSON.stringify({ wide, cols: (await state(writer.key)).cols, drawn: await drawn() }))
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-reflow.png') })

  // Two columns chosen there are narrower than a terminal can be fitted to: the layout shows one at a time instead
  // (#1037), the button still the one chosen, and goes back to two once there is room: the Progress panel closed, or the
  // window wider. Tiles and its focus view (the pane beside the strip) and back keep to what fits.
  const panes = () => page.locator('.agent-pane').count()
  const layoutButton = () => page.evaluate(() => [...document.querySelectorAll('.layout-switch button.active, .layout-switch button.layout-menu')].map((b) => b.getAttribute('aria-label')).join())
  // Fitted, and drawn inside its pane: one too small to fit counts as fitted, so its screen is measured too.
  const inside = () => page.evaluate(() => window.__hiveTerminalsInside())
  const fewer = (n) => lib.until(async () => (await panes()) === n && (await fitted()) && (await inside()), HUNG_MS)
  const toggleProgress = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', { type: 'menu-command', command: 'progress.toggle', args: [] }))
  // At this width the toolbar folds the layouts into one button with a menu (#886).
  await page.locator('.layout-switch button.layout-menu').click()
  await page.getByRole('menuitem', { name: 'Two columns' }).click()
  // Chosen (the layout button says so), it is shown as one at a time.
  check('narrow: the layout button is Two columns', !!(await lib.until(async () => (await layoutButton()) === 'Two columns', HUNG_MS)), await layoutButton())
  check('narrow: two columns chosen show one pane, its terminal fitted', !!(await fewer(1)), JSON.stringify({ panes: await panes(), fitted: await fitted(), inside: await inside() }))
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-narrow.png') })
  await page.locator('.view-switch [data-view="tiles"]').click()
  await lib.until(async () => (await page.locator('.tile-grid').count()) === 1, HUNG_MS)
  await page.locator('.agent-tile', { has: page.locator('.tile-name', { hasText: /^Checker$/ }) }).click()
  // No room for the strip beside a terminal: it gives way, and the agent's pane takes the width.
  check('narrow: the focus view shows its agent fitted, the strip giving way', !!(await lib.until(async () => (await page.locator('.tile-strip').count()) === 0 && (await panes()) === 1 && (await fitted()) && (await inside()), HUNG_MS)), JSON.stringify({ strip: await page.locator('.tile-strip').count(), panes: await panes(), inside: await inside() }))
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-focus-narrow.png') })
  // Wide, the strip widened by its edge (#1021: as far as the pane beside it leaves room for); narrower, it narrows so the pane keeps a terminal's
  // width, then gives way altogether; wide again, it is as wide as it was made. The Progress panel closed, for the room to
  // widen it (the strip takes at most 40% of the Session tab, #1050).
  const stripWidth = () => page.evaluate(() => Math.round(document.querySelector('.tile-strip')?.getBoundingClientRect().width ?? 0))
  await toggleProgress()
  await lib.until(async () => (await page.locator('.progress-panel').count()) === 0, HUNG_MS)
  await lib.fitWindow(app, page, { width: 1400, height: 650 })
  await lib.until(async () => (await stripWidth()) === 200, HUNG_MS)
  const edge = await page.locator('.tile-strip > .pane-resizer').boundingBox()
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 + 300, edge.y + 200, { steps: 8 })
  await page.mouse.up()
  check('focus: the strip widened', !!(await lib.until(async () => (await stripWidth()) >= 380, HUNG_MS)), String(await stripWidth()))
  const made = await stripWidth()
  await lib.fitWindow(app, page, { width: 900, height: 650 })
  check('focus, 900 px, no Progress: the strip narrower than chosen, the terminal fitted inside its pane', !!(await lib.until(async () => { const w = await stripWidth(); return w >= 170 && w < made && (await fitted()) && (await inside()) }, HUNG_MS)), JSON.stringify({ strip: await stripWidth(), inside: await inside() }))
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-focus-strip.png') })
  // The terminal comes first (#1050): the strip takes at most 40% of the Session tab (never below its 170 px), and is at
  // its least while the terminal beside it still has 24 px over its own least (min), whatever the font; the chosen
  // width is kept.
  const share = () => page.evaluate(() => {
    const strip = document.querySelector('.tile-strip')
    const tab = strip?.closest('.tab-body')
    return strip && tab ? { strip: Math.round(strip.getBoundingClientRect().width), tab: Math.round(tab.getBoundingClientRect().width), pane: Math.round(document.querySelector('.agents-area.tile-focus').getBoundingClientRect().width), min: window.__hiveTerminalMinWidth() } : null
  })
  const shared = (w) => !!w && w.strip <= Math.min(made, Math.max(170, Math.floor(w.tab * 0.4))) + 1 && w.pane >= w.min - 1 && (w.strip <= 170 || w.pane >= w.min + 23)
  check('focus, 900 px: the strip at most 40% of the tab, the terminal wider than it', !!(await lib.until(async () => { const w = await share(); return shared(w) && w.pane > w.strip }, HUNG_MS)), JSON.stringify({ ...(await share()), made }))
  await lib.fitWindow(app, page, { width: 800, height: 650 })
  check('focus, 800 px: the strip at its least, the terminal still wider than its least', !!(await lib.until(async () => { const w = await share(); return w?.strip === 170 && shared(w) && (await fitted()) && (await inside()) }, HUNG_MS)), JSON.stringify(await share()))
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-focus-least.png') })
  // A large terminal font (HR4's case: 24 px, a terminal's least 342 px): the strip still at its least before the terminal.
  const fontWas = (await inv('settings:get')).appearance?.terminalFontSize
  await inv('settings:update', { appearance: { terminalFontSize: 24 } })
  for (const width of [950, 900]) {
    await lib.fitWindow(app, page, { width, height: 650 })
    check(`focus, 24 px font, ${width} px: the strip narrower first, the terminal over its least`, !!(await lib.until(async () => { const w = await share(); return w?.min > 300 && shared(w) && (await fitted()) && (await inside()) }, HUNG_MS)), JSON.stringify(await share()))
  }
  check('focus, 24 px font, 900 px: the strip at its least', (await share())?.strip === 170, JSON.stringify(await share()))
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-focus-font24.png') })
  await inv('settings:update', { appearance: { terminalFontSize: fontWas } })
  await lib.until(async () => (await share())?.min < 300, HUNG_MS)
  await lib.fitWindow(app, page, { width: 900, height: 650 })
  await toggleProgress()
  check('focus, 900 px, Progress open: the strip gives way, the terminal inside', !!(await lib.until(async () => (await stripWidth()) === 0 && (await fitted()) && (await inside()), HUNG_MS)), JSON.stringify({ strip: await stripWidth(), inside: await inside() }))
  await toggleProgress()
  await lib.until(async () => (await page.locator('.progress-panel').count()) === 0, HUNG_MS)
  await lib.fitWindow(app, page, { width: 1400, height: 650 })
  check('focus, wide again: the strip as wide as it was made', !!(await lib.until(async () => (await stripWidth()) === made && (await inside()), HUNG_MS)), `${await stripWidth()}, made ${made}`)
  await page.locator('.tile-strip > .pane-resizer').dblclick()
  await lib.until(async () => (await stripWidth()) === 200, HUNG_MS)
  await toggleProgress()
  await lib.until(async () => (await page.locator('.progress-panel').count()) > 0, HUNG_MS)
  await lib.fitWindow(app, page, { width: 900, height: 650 })
  await page.locator('.view-switch [data-view="panes"]').click()
  check('narrow: Panes again, still one pane', !!(await fewer(1)), String(await panes()))
  await toggleProgress()
  check('narrow: the Progress panel closed, two columns again, both fitted', !!(await fewer(2)), JSON.stringify({ panes: await panes(), fitted: await fitted() }))
  await toggleProgress()
  check('narrow: the panel open again, one pane', !!(await fewer(1)), String(await panes()))
  await lib.fitWindow(app, page, { width: 1400, height: 650 })
  check('wide: two columns again, both fitted', !!(await fewer(2)), JSON.stringify({ panes: await panes(), fitted: await fitted() }))
  // At the boundary, a pixel at a time each way: one change of layout each way, the way back to two a little past where
  // two stop fitting, so a window edge dragged across it doesn't flicker.
  const bodyWidth = () => page.evaluate(() => Math.round(document.querySelector('.tab-body').getBoundingClientRect().width))
  const settled = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
  const walk = async (from, to) => {
    const seen = []
    for (let w = from; w !== to; w += from < to ? 1 : -1) {
      const before = await bodyWidth()
      await page.setViewportSize({ width: w, height: 650 })
      await lib.until(async () => (await bodyWidth()) !== before, HUNG_MS)
      await settled()
      const n = await panes()
      if (seen.at(-1)?.panes !== n) seen.push({ window: w, body: await bodyWidth(), panes: n })
    }
    return seen
  }
  await page.setViewportSize({ width: 960, height: 650 })
  await fewer(1)
  const up = await walk(960, 1120)
  const down = await walk(1120, 960)
  const crossed = (seen, a, b) => seen.length === 2 && seen[0].panes === a && seen[1].panes === b
  check('boundary: widening a pixel at a time, one change, 1 → 2', crossed(up, 1, 2), JSON.stringify(up))
  check('boundary: narrowing a pixel at a time, one change, 2 → 1', crossed(down, 2, 1), JSON.stringify(down))
  check('boundary: two come back further out than they go', up.length === 2 && down.length === 2 && up[1].body > down[1].body + 1, JSON.stringify({ up, down }))
  await lib.fitWindow(app, page, { width: 1400, height: 650 })
  await fewer(2)
  // Two columns for two agents is the automatic layout.
  const saved = (await inv('workspace:get')).projects.find((p) => p.path === alpha)?.config.layout
  check('wide: the layout chosen was never changed', saved === 'auto', String(saved))
  for (const g of agents) {
    const small = sizes(g.home).filter((s) => s.cols < MIN_COLS || s.rows < MIN_ROWS)
    check(`narrow and back: ${g.name} was never given a size below ${MIN_COLS} × ${MIN_ROWS}`, small.length === 0, JSON.stringify(small))
  }

  for (const a of [claude, codex]) await inv('session:stop', alpha, a.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
