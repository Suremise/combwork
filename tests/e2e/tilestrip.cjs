// Reordering the focus view's strip (#1053): in the Tiles view's focus view, the strip's rows move as the tiles do (#993),
// changing the same saved order (project.json's agents), which the tiles and the panes follow. A row dragged up or down
// the list shows a line where it would go (before a row, or after the last), and dropped there goes there; the agent
// shown stays shown (its pane, the strip's mark). The keyboard: Alt+Up and Alt+Down on a row, its menu (Shift+F10: Move
// Up, Move Down) and Move Agent Left/Right move that row's agent, the keyboard staying on it and a screen reader told
// where it went (or that it can't go further). A row with a card chip (#1021) moves with its chip, and the line spans the
// strip resized wider. By urgency, nothing moves. Screenshots in both themes (Darren's OK on the card). Six agents of the
// fake Claude Code, none started; a throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'tilestrip-profile')
const ws = path.join(lib.WORK, 'tilestrip-ws')
const claudeHome = path.join(lib.WORK, 'tilestrip-claude-home')
const alpha = path.join(ws, 'alpha')
const NAMES = ['A', 'B', 'C', 'D', 'E', 'F']
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.fakeClaude(userData, claudeHome, [alpha])
  const { app, page, inv } = await lib.launch({ userData, env: { CLAUDE_CONFIG_DIR: claudeHome, HIVE_API_PORT: lib.port(47799) }, viewport: { width: 1300, height: 800 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    await inv('settings:update', { appearance: { theme: 'light' } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', HUNG_MS)
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')) === 'alpha', HUNG_MS)
    const ids = {}
    for (const name of NAMES) ids[name] = (await lib.addAgent(inv, alpha, { name })).id
    // C works on a card: its row has a chip (#1021).
    const chipCard = (await inv('tasks:create', { title: 'A card on the strip', project: 'alpha', agent: ids.C, column: 'doing' })).number
    await inv('workspace:refresh')

    const saved = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'project.json'), 'utf8')).agents.map((a) => a.name).join()
      } catch {
        return '' // being written
      }
    }
    const order = (names) => names.join()
    const stripNames = () => page.locator('.tile-strip .tile-strip-item .tile-strip-name').allInnerTexts().catch(() => [])
    const tileNames = () => page.locator('.agent-tile .tile-name').allInnerTexts().catch(() => [])
    const paneName = () => page.locator('.agent-pane .pane-header-bar .agent-name').innerText().catch(() => '')
    const inFocus = async (name) => (await page.locator('.agents-area.shown.tile-focus').count()) === 1 && (await paneName()) === name && (await page.locator('.tile-strip-item.active .tile-strip-name').innerText().catch(() => '')) === name
    const row = (name) => page.locator('.tile-strip-row', { has: page.locator('.tile-strip-name', { hasText: new RegExp(`^${name}$`) }) })
    const item = (name) => row(name).locator('.tile-strip-item')
    const focusedRow = () => page.evaluate(() => document.activeElement?.closest?.('.tile-strip-item')?.querySelector('.tile-strip-name')?.textContent ?? null)
    const said = () => page.locator('.tile-strip [role="status"]').innerText().catch(() => '')
    // Where the line is: drop-before on a row, or drop-after on the last ('A>' before A, '>F' after F).
    const line = () => page.locator('.tile-strip-row').evaluateAll((rows) => rows.flatMap((r) => [r.classList.contains('drop-before') ? `${r.querySelector('.tile-strip-name').textContent}>` : null, r.classList.contains('drop-after') ? `>${r.querySelector('.tile-strip-name').textContent}` : null]).filter(Boolean).join())
    const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `tilestrip-${name}.png`) })

    // --- Tiles, then A's focus view.
    await page.locator('.view-switch [data-view="tiles"]').click()
    await lib.until(async () => (await tileNames()).join() === order(NAMES), HUNG_MS)
    await page.locator('.agent-tile', { has: page.locator('.tile-name', { hasText: /^A$/ }) }).click()
    check("A's focus view: the strip of all six, in the panes' order", !!(await lib.until(async () => (await inFocus('A')) && (await stripNames()).join() === order(NAMES), HUNG_MS)), `${await paneName()} ${(await stripNames()).join()}`)
    check('…every row drags (Same as panes)', (await page.locator('.tile-strip-item[draggable="true"]').count()) === 6)
    check("…C's row has its card's chip", !!(await lib.until(async () => (await row('C').locator('.tile-strip-chip .card-chip').count()) === 1, HUNG_MS)))
    // HI-2000: its key whole on one line (a chip's key broke at its hyphen where it was squeezed), in both themes.
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      const lines = await row('C').locator('.tile-strip-chip .card-chip-number').evaluate((key) => {
        const range = document.createRange()
        range.selectNodeContents(key)
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
      })
      check(`…its key on one line (${theme})`, lines === 1, String(lines))
      await row('C').screenshot({ path: path.join(lib.WORK, `tilestrip-chip-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    // A native drag with the mouse, as tilesview drags: press, nudge until the page's dragstart, over each stop in turn
    // (until the strip shows the line where the stop says), release, then wait for the drag's end.
    const dragState = () => page.evaluate(() => window.__stripDrag)
    const at = async (loc, fy) => {
      const b = await loc.boundingBox()
      return { x: b.x + b.width / 2, y: b.y + b.height * fy }
    }
    const drag = async (from, stops, shotName) => {
      await page.evaluate(() => {
        window.__stripDrag = 'none'
        document.addEventListener('dragstart', () => (window.__stripDrag = 'started'), { once: true })
        document.addEventListener('dragend', () => (window.__stripDrag = 'ended'), { once: true })
      })
      const a = await at(from, 0.5)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      let dy = 0
      if (!(await lib.until(async () => (await dragState()) !== 'none' || void (await page.mouse.move(a.x, a.y + 4 + (dy = 1 - dy), { steps: 2 })), HUNG_MS))) throw new Error('the drag never started (no dragstart)')
      for (const { loc, fy, want } of stops) {
        const b = await at(loc, fy)
        await page.mouse.move(b.x, b.y, { steps: 8 })
        let dx = 0
        if (!(await lib.until(async () => (await line()) === want || void (await page.mouse.move(b.x + (dx = 1 - dx), b.y, { steps: 2 })), HUNG_MS))) throw new Error(`the line never showed ${want || 'nowhere'} (${await line()})`)
      }
      if (shotName) await shot(shotName)
      await page.mouse.up()
      await lib.until(async () => (await dragState()) === 'ended', HUNG_MS)
    }

    // D dragged up over B's top half: the line before B; over its own row: no line (it would stay); back to B, dropped.
    await drag(item('D'), [{ loc: item('B'), fy: 0.25, want: 'B>' }, { loc: item('D'), fy: 0.3, want: '' }, { loc: item('B'), fy: 0.25, want: 'B>' }], 'drag-light')
    const dUp = ['A', 'D', 'B', 'C', 'E', 'F']
    check('D dropped before B: the strip shows it, saved in project.json', !!(await lib.until(async () => saved() === order(dUp) && (await stripNames()).join() === order(dUp), HUNG_MS)), `${saved()} / ${(await stripNames()).join()}`)
    check('…the line gone with the drag, nothing dimmed', !!(await lib.until(async () => (await line()) === '' && (await page.locator('.tile-strip-row.dragging').count()) === 0, HUNG_MS)), await line())
    check('…A still shown (its pane, its mark)', await inFocus('A'))
    // A (the agent shown) dragged below F's middle: the line after the last row; dropped, last, and still shown.
    await drag(item('A'), [{ loc: item('F'), fy: 0.75, want: '>F' }])
    const aLast = ['D', 'B', 'C', 'E', 'F', 'A']
    check('A dropped after F (the last): last, saved', !!(await lib.until(async () => saved() === order(aLast) && (await stripNames()).join() === order(aLast), HUNG_MS)), `${saved()} / ${(await stripNames()).join()}`)
    check('…and A is still the one shown', await inFocus('A'))
    // C, with its chip, dragged to the top (over the Tiles button above the rows: before the first).
    await drag(item('C'), [{ loc: page.locator('.tile-strip-back'), fy: 0.5, want: 'D>' }])
    const cFirst = ['C', 'D', 'B', 'E', 'F', 'A']
    check('C (with its chip) dropped above the first row: first, saved', !!(await lib.until(async () => saved() === order(cFirst) && (await stripNames()).join() === order(cFirst), HUNG_MS)), `${saved()} / ${(await stripNames()).join()}`)
    check("…its chip moved with it, still the card's", (await row('C').locator('.tile-strip-chip .card-chip').innerText()).includes(String(chipCard)) && (await page.locator('.tile-strip-row').first().locator('.tile-strip-chip .card-chip').count()) === 1)

    // --- The keyboard: Alt+Up and Alt+Down on a row.
    await item('B').focus()
    await page.keyboard.press('Alt+ArrowUp')
    const bUp = ['C', 'B', 'D', 'E', 'F', 'A']
    check('Alt+Up on B: a place up, saved, the keyboard still on B', !!(await lib.until(async () => saved() === order(bUp) && (await stripNames()).join() === order(bUp) && (await focusedRow()) === 'B', HUNG_MS)), `${saved()} / ${await focusedRow()}`)
    check('…said to screen readers: "B: 2 of 6"', !!(await lib.until(async () => (await said()) === 'B: 2 of 6', HUNG_MS)), await said())
    check('…A still shown', await inFocus('A'))
    await page.keyboard.press('Alt+ArrowUp')
    await page.keyboard.press('Alt+ArrowUp')
    const bFirst = ['B', 'C', 'D', 'E', 'F', 'A']
    check('Alt+Up twice more: B first, then "B is already first", the order kept', !!(await lib.until(async () => (await said()) === 'B is already first' && saved() === order(bFirst) && (await stripNames()).join() === order(bFirst), HUNG_MS)), `${await said()} / ${saved()}`)
    await page.keyboard.press('Alt+ArrowDown')
    check('Alt+Down: B a place down again, the keyboard on it', !!(await lib.until(async () => saved() === order(bUp) && (await focusedRow()) === 'B' && (await said()) === 'B: 2 of 6', HUNG_MS)), `${saved()} / ${await focusedRow()} / ${await said()}`)
    // Plain arrows still move between the rows, and move nothing.
    await page.keyboard.press('ArrowDown')
    check('↓ alone: the keyboard to the next row (D), the order kept', !!(await lib.until(async () => (await focusedRow()) === 'D', HUNG_MS)) && saved() === order(bUp), `${await focusedRow()} / ${saved()}`)
    // Its menu from the keyboard: Move Down.
    await page.keyboard.press('Shift+F10')
    await lib.until(async () => (await lib.menuEntry(page, 'Move Down').count()) === 1, HUNG_MS)
    check("D's menu: Move Up and Move Down, with Alt+↑ and Alt+↓", (await lib.menuEntry(page, 'Move Up').count()) === 1 && (await page.locator('.menu').innerText()).includes('Alt+'), await page.locator('.menu').innerText())
    await shot('menu')
    await lib.menuEntry(page, 'Move Down').click()
    const dDown = ['C', 'B', 'E', 'D', 'F', 'A']
    check("the menu's Move Down: D a place down, the keyboard back on it", !!(await lib.until(async () => saved() === order(dDown) && (await focusedRow()) === 'D', HUNG_MS)), `${saved()} / ${await focusedRow()}`)
    // A's row (the last) can't go down: its menu has Move Down unavailable.
    await item('A').focus()
    await page.keyboard.press('Shift+F10')
    await lib.until(async () => (await lib.menuEntry(page, 'Move Down').count()) === 1, HUNG_MS)
    check("…the last row's menu: Move Down unavailable", !!(await lib.until(async () => lib.menuEntry(page, 'Move Down').evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true'), HUNG_MS)))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
    check('…Esc closes the menu, still the focus view', await inFocus('A'))
    // Move Agent Left (Ctrl+Alt+Shift+←) on F's row moves F, not A (the agent shown).
    await item('F').focus()
    await page.keyboard.press('Control+Alt+Shift+ArrowLeft')
    const fUp = ['C', 'B', 'E', 'F', 'D', 'A']
    check("Move Agent Left on F's row: F a place up, the keyboard on it, A still shown", !!(await lib.until(async () => saved() === order(fUp) && (await focusedRow()) === 'F', HUNG_MS)) && (await inFocus('A')), `${saved()} / ${await focusedRow()}`)

    // --- The strip resized wider (#1021): the line spans the row.
    const b = await page.locator('.tile-strip > .pane-resizer').boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + 400)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + 120, b.y + 400, { steps: 8 })
    await page.mouse.up()
    await lib.until(async () => Math.round((await page.locator('.tile-strip').boundingBox()).width) === 320, HUNG_MS)
    await page.evaluate(() => {
      window.__stripDrag = 'none'
      document.addEventListener('dragstart', () => (window.__stripDrag = 'started'), { once: true })
      document.addEventListener('dragend', () => (window.__stripDrag = 'ended'), { once: true })
    })
    // Held over E's top half, measured, then dropped where it started (nothing moves).
    const from = await at(item('D'), 0.5)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    let dy = 0
    await lib.until(async () => (await dragState()) !== 'none' || void (await page.mouse.move(from.x, from.y + 4 + (dy = 1 - dy), { steps: 2 })), HUNG_MS)
    const over = await at(item('E'), 0.25)
    await page.mouse.move(over.x, over.y, { steps: 8 })
    let dx = 0
    await lib.until(async () => (await line()) === 'E>' || void (await page.mouse.move(over.x + (dx = 1 - dx), over.y, { steps: 2 })), HUNG_MS)
    const spans = await row('E').evaluate((r) => {
      const l = getComputedStyle(r, '::before')
      return { line: parseFloat(l.width), row: r.getBoundingClientRect().width, colour: l.backgroundColor }
    })
    check('the strip at 320 px: the line spans the row, in the accent', spans.line >= spans.row - 6 && spans.row > 280 && spans.colour !== 'rgba(0, 0, 0, 0)', JSON.stringify(spans))
    // Back over its own place: no line; let go there, nothing moves.
    const home = await at(item('D'), 0.5)
    await page.mouse.move(home.x, home.y, { steps: 8 })
    await lib.until(async () => (await line()) === '' || void (await page.mouse.move(home.x + (dx = 1 - dx), home.y, { steps: 2 })), HUNG_MS)
    await page.mouse.up()
    await lib.until(async () => (await dragState()) === 'ended', HUNG_MS)
    check('…let go where it started: the order kept', saved() === order(fUp) && (await stripNames()).join() === order(fUp), saved())

    // --- Dark too: the line and the menu (Darren's OK on the card).
    await inv('settings:update', { appearance: { theme: 'dark' } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', HUNG_MS)
    await drag(item('A'), [{ loc: item('B'), fy: 0.25, want: 'B>' }], 'drag-dark')
    const aUp = ['C', 'A', 'B', 'E', 'F', 'D']
    check('dark: A dropped before B, saved', !!(await lib.until(async () => saved() === order(aUp) && (await stripNames()).join() === order(aUp), HUNG_MS)), saved())
    await item('E').focus()
    await page.keyboard.press('Shift+F10')
    await lib.until(async () => (await lib.menuEntry(page, 'Move Up').count()) === 1, HUNG_MS)
    await shot('menu-dark')
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
    await inv('settings:update', { appearance: { theme: 'light' } })

    // --- The same order in the tiles and the panes.
    await page.locator('.tile-strip-back').click()
    check('the tiles: the same order', !!(await lib.until(async () => (await tileNames()).join() === order(aUp), HUNG_MS)), (await tileNames()).join())
    await inv('project:updateConfig', alpha, { layout: 'grid6' })
    await inv('workspace:refresh')
    await page.locator('.view-switch [data-view="panes"]').click()
    const paneNames = () => page.locator('.agent-pane .pane-header-bar .agent-name').allInnerTexts().catch(() => [])
    check('the panes: the same order', !!(await lib.until(async () => (await paneNames()).join() === order(aUp), HUNG_MS)), (await paneNames()).join())

    // --- By urgency: the order is computed, so no row moves.
    await page.locator('.view-switch [data-view="tiles"]').click()
    await inv('settings:update', { sessions: { tileOrder: 'urgency' } })
    await lib.until(async () => (await page.locator('.agent-tile').count()) === 6, HUNG_MS)
    await page.locator('.agent-tile').first().click()
    await lib.until(async () => (await page.locator('.tile-strip-item').count()) === 6, HUNG_MS)
    check('By urgency: no row drags', (await page.locator('.tile-strip-item[draggable="true"]').count()) === 0)
    const first = (await stripNames())[0]
    await item(first).focus()
    await page.keyboard.press('Alt+ArrowDown')
    await page.keyboard.press('Shift+F10')
    await page.keyboard.press('ArrowDown')
    // The keys are handled in order: once ↓ has moved the keyboard to the next row, Alt+Down and the menu key had theirs.
    const second = (await stripNames())[1]
    check('…Alt+Down moves nothing, and a row has no menu (↓ after them moves the keyboard)', !!(await lib.until(async () => (await focusedRow()) === second, HUNG_MS)) && saved() === order(aUp) && (await page.locator('.menu').count()) === 0 && (await stripNames())[0] === first, `${await focusedRow()} / ${saved()} / ${await page.locator('.menu').count()} menus`)
    await inv('settings:update', { sessions: { tileOrder: 'panes' } })
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
