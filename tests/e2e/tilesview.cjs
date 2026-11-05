// The Session tab's Tiles view and focus view (#976). Thirteen agents, three of them running the fake Claude Code
// (fake-claude/): A finished a turn (its reply on its tile), B works, M (the thirteenth) waits for a permission. Tiles: as many
// a page as fit (HI-1951): all 13 on one page at 1500×900; then the area made room for 12, so two pages, and resized
// back and forth keeping the tile the keyboard is on; in the panes' order (Settings → Sessions → Tile order, the default) M is on page 2, highlighted, and
// page 2's button counts it; By urgency puts it first. A tile shows the state's mark, name, provider, status and the start
// of the latest reply. The keyboard: one tab stop in the grid, arrows between tiles, Enter opens the focus view (the agent's
// live pane beside a strip of the others); Esc in the terminal stays the CLI's, Esc outside it (the strip), Ctrl+Alt+Esc,
// the strip's Tiles button and the Tiles toggle go back, the keyboard on the agent's tile. Paging with the page buttons and
// Ctrl+Alt+PageDown; the chip's list opens an agent's focus view; Panes leaves it. Reordering (#993), in the panes'
// order: a tile dragged onto another swaps them, onto a page button goes to that page's end, and Move Agent Left/Right
// (the keys, an override without modifiers, the tile's menu) move the tile the keyboard is on, other shortcuts and chords
// still working there; the order is saved and the panes show it; By urgency, no tile drags. The strip's card chips (#1021):
// each agent's card (Active, reviewing, held in Review or Approved) in its column's colour, blocked red, a long name cut
// before its chip, the chips in line, the status without the chip's number, a click opening the card; its edge resizes
// it (within its bounds, saved, kept after a restart, double-click resets). Throwaway profile, workspace and
// CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'tilesview-profile')
const ws = path.join(lib.WORK, 'tilesview-ws')
const claudeHome = path.join(lib.WORK, 'tilesview-claude-home')
const alpha = path.join(ws, 'alpha')
const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']
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
  let { app, page, inv } = await lib.launch({ userData, env: { CLAUDE_CONFIG_DIR: claudeHome, HIVE_API_PORT: lib.port(47825) }, viewport: { width: 1500, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')) === 'alpha', HUNG_MS)
    // More than the 12 agents a project has by default (#562).
    await lib.setMaxAgents(inv, 24, 'workspace')
    const ids = {}
    for (const name of NAMES) ids[name] = (await lib.addAgent(inv, alpha, { name })).id
    for (const name of ['A', 'B', 'M']) await inv('session:start', alpha, { agentId: ids[name] })
    for (const name of ['A', 'B', 'M']) await lib.until(async () => ['ready', 'waiting'].includes((await live(ids[name]))?.status), HUNG_MS)
    for (const name of ['A', 'B', 'M']) if ((await live(ids[name]))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, ids[name]), '\r')
    for (const name of ['A', 'B', 'M']) await lib.until(async () => (await live(ids[name]))?.status === 'ready', HUNG_MS)
    const prompts = (name) => lib.fakePrompts(inv, lib.ptyKey(alpha, ids[name]), () => live(ids[name]), { home: claudeHome })
    await prompts('A').type('hello tiles')
    await lib.until(async () => (await live(ids.A))?.replyStart === 'Done: hello tiles', HUNG_MS)
    await prompts('B').type('work 300')
    await lib.until(async () => (await live(ids.B))?.status === 'working', HUNG_MS)
    await prompts('M').type('ask work 300')
    await lib.until(async () => (await live(ids.M))?.status === 'waiting', HUNG_MS)
    await inv('workspace:refresh')

    // --- Panes | Tiles (HI-1951: a page holds as many tiles as fit): at 1500×900 all 13 fit, on one page, no page buttons.
    await page.locator('.view-switch [data-view="tiles"]').click()
    const tileNames = () => page.locator('.agent-tile .tile-name').allInnerTexts().catch(() => [])
    const pager = page.locator('.session-toolbar .tile-pages')
    const pageButtons = () => page.locator('.session-toolbar .tile-pages button').evaluateAll((els) => els.map((b) => `${b.childNodes[0].textContent}${b.classList.contains('active') ? '*' : ''}${b.querySelector('.tile-page-count') ? `(${b.querySelector('.tile-page-count').textContent})` : ''}`).join(' '))
    check('Tiles: all 13 tiles on one page at 1500×900, in the panes order, no page buttons (HI-1951)', !!(await lib.until(async () => (await tileNames()).join() === NAMES.join() && (await pager.count()) === 0, HUNG_MS)), (await tileNames()).join())
    check('…all on screen, no scrolling', await page.locator('.agent-tiles').evaluate((el) => el.scrollHeight <= el.clientHeight))
    /** Both themes' screenshots of the window, for the Assistant's OK (HI-1951). */
    const themed = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(lib.WORK, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    await themed('tilesview-onepage')
    // A smaller window (1100×650): 4 fit, so the tiles page, 6 to a page (the floor, Darren's decision: as Panes' largest
    // page), the area scrolling; the pager on the toolbar. Back at 1500×900, one page again.
    await lib.fitWindow(app, page, { width: 1100, height: 650 })
    check('a smaller window: the tiles page, 6 to a page (the floor), the pager showing three pages', !!(await lib.until(async () => (await pager.count()) === 1 && (await tileNames()).join() === NAMES.slice(0, 6).join() && (await pageButtons()).startsWith('1* 2 3'), HUNG_MS)), JSON.stringify({ tiles: await tileNames(), pages: await pageButtons().catch(() => '') }))
    check('…the area scrolls to show them', await page.locator('.agent-tiles').evaluate((el) => el.scrollHeight > el.clientHeight))
    await themed('tilesview-paged')
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    check('…the window back at 1500×900: one page of 13 again', !!(await lib.until(async () => (await pager.count()) === 0 && (await tileNames()).length === 13, HUNG_MS)), (await tileNames()).join())
    // Resized while a focus view is open (HR1's HI-1951 round 1): Back to Tiles shows the page with its agent, worked out
    // at the new size, the keyboard on its tile; resized again in the grid, it keeps them.
    const tileOf = (name) => page.locator('.agent-tile', { has: page.locator('.tile-name', { hasText: new RegExp(`^${name}$`) }) })
    const keyboardTile = () => page.evaluate(() => document.activeElement?.closest?.('.agent-tile')?.querySelector('.tile-name')?.textContent ?? null)
    await tileOf('M').click()
    check("M's focus view (all 13 on one page)", !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 0 && (await page.locator('.tile-strip-back').count()) === 1, HUNG_MS)))
    await lib.fitWindow(app, page, { width: 1100, height: 650 })
    await page.locator('.tile-strip-back').click()
    check('…the window made 1100×650, then Back to Tiles: page 3 with M, the keyboard on M', !!(await lib.until(async () => (await tileNames()).join() === 'M' && (await pageButtons()) === '1 2 3*' && (await keyboardTile()) === 'M', HUNG_MS)), JSON.stringify({ tiles: await tileNames(), pages: await pageButtons().catch(() => ''), on: await keyboardTile() }))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    check('…back at 1500×900: one page of 13, M still with the keyboard', !!(await lib.until(async () => (await pager.count()) === 0 && (await tileNames()).length === 13 && (await keyboardTile()) === 'M', HUNG_MS)), JSON.stringify({ tiles: await tileNames(), on: await keyboardTile() }))
    /**
     * The Tiles area made the size of `cols` columns × `rows` rows of tiles (a smaller window's, as the page measures it:
     * its columns of at least 230 px and its height over a tile's), by a style of its own so it holds while the grid is
     * drawn again (the focus view and back); null: the window's again.
     */
    const fitTiles = (cols, rows) =>
      page.evaluate(([c, r]) => {
        document.getElementById('tiles-fit-test')?.remove()
        if (!c) return
        // Worked out once per size while a grid is drawn, then reused (the focus view has none).
        const kept = (window.__tilesFit ??= {})[`${c}x${r}`]
        if (kept) return void document.head.append(Object.assign(document.createElement('style'), { id: 'tiles-fit-test', textContent: kept }))
        const g = document.querySelector('.tile-grid')
        const css = getComputedStyle(g)
        const px = (v) => parseFloat(v) || 0
        const h = g.querySelector('.agent-tile').offsetHeight
        // c columns as wide as the suite's tiles were (short of room for one more: 200 px over, a column takes 238) and r rows.
        const width = c * (230 + px(css.columnGap)) + px(css.paddingLeft) + px(css.paddingRight) + 200
        const height = r * h + (r - 1) * px(css.rowGap) + px(css.paddingTop) + px(css.paddingBottom) + 10
        const text = `.agent-tiles { right: auto !important; bottom: auto !important; width: ${width}px !important; height: ${height}px !important; }`
        window.__tilesFit[`${c}x${r}`] = text
        document.head.append(Object.assign(document.createElement('style'), { id: 'tiles-fit-test', textContent: text }))
      }, [cols, rows])
    // A smaller area, room for 12 (4 × 3): the page holds 12, so two pages, as the rest of the suite has them. M, which
    // has the keyboard, keeps its page (2) as it shrinks; the suite goes on from page 1.
    await fitTiles(4, 3)
    await lib.until(async () => (await pager.count()) === 1, HUNG_MS)
    await page.locator('.session-toolbar .tile-pages button').nth(0).click()
    check('a smaller Tiles area that holds 12: 12 tiles on page 1, in the panes order', !!(await lib.until(async () => (await tileNames()).join() === NAMES.slice(0, 12).join(), HUNG_MS)), (await tileNames()).join())
    check('…all on screen, no scrolling', await page.locator('.agent-tiles').evaluate((el) => el.scrollHeight <= el.clientHeight))
    check('…no terminal drawn for them (none on screen)', (await page.locator('.terminal-host:not(.hidden)').count()) === 0)
    // A page chosen after a resize in the focus view is the page shown (HR1's HI-1951 round 2): in the small window (6 a
    // page), M's focus view from page 3; the area made room for 12 meanwhile; page 1's button shows page 1 (A to L), not
    // M's page.
    await fitTiles(null)
    await lib.fitWindow(app, page, { width: 1100, height: 650 })
    await lib.until(async () => (await pageButtons()).startsWith('1') && (await pageButtons()).split(' ').length === 3, HUNG_MS)
    await page.locator('.session-toolbar .tile-pages button').nth(2).click()
    await lib.until(async () => (await tileNames()).join() === 'M', HUNG_MS)
    await page.locator('.agent-tile', { has: page.locator('.tile-name', { hasText: /^M$/ }) }).click()
    await lib.until(async () => (await page.locator('.tile-strip-back').count()) === 1, HUNG_MS)
    await fitTiles(4, 3)
    await page.locator('.session-toolbar .tile-pages button').nth(0).click()
    check("…M's focus view, the area resized to hold 12, then page 1's button: page 1 (A to L), not M's", !!(await lib.until(async () => (await tileNames()).join() === NAMES.slice(0, 12).join() && (await pageButtons()) === '1* 2(1)', HUNG_MS)), JSON.stringify({ tiles: await tileNames(), pages: await pageButtons().catch(() => '') }))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.until(async () => (await tileNames()).join() === NAMES.slice(0, 12).join() && (await pageButtons()) === '1* 2(1)', HUNG_MS)
    const tile = (name) => page.locator('.agent-tile', { has: page.locator('.tile-name', { hasText: new RegExp(`^${name}$`) }) })
    const aTile = await tile('A').evaluate((el) => ({ mark: [...(el.querySelector('.state-mark')?.classList ?? [])].join(' '), provider: el.querySelector('.tile-provider')?.textContent, reply: el.querySelector('.tile-reply')?.textContent }))
    check("A's tile: idle (a ring), Claude Code, the start of its reply", aTile.mark.includes('idle') && aTile.provider === 'Claude Code' && aTile.reply === 'Done: hello tiles', JSON.stringify(aTile))
    check("B's tile: working (its mark)", (await tile('B').locator('.state-mark.working').count()) === 1)
    check("C's tile: Not running", (await tile('C').locator('.tile-status').innerText()) === 'Not running')
    check('two tile pages; page 2 counts M, waiting there', !!(await lib.until(async () => (await pageButtons()) === '1* 2(1)', HUNG_MS)), await pageButtons())
    // The count is said as well as shown: page 2's accessible name, while page 1 is chosen (the badge itself is hidden).
    const pageNames = () => page.locator('.session-toolbar .tile-pages button').evaluateAll((els) => els.map((b) => `${b.getAttribute('aria-label')}${b.getAttribute('aria-current') ? ' (current)' : ''}`).join(' | '))
    check("…page 2's accessible name says so", (await pageNames()) === 'Tile page 1 (current) | Tile page 2, 1 agent waiting for you or stalled', await pageNames())
    check("…in the accessibility tree too", !!(await page.getByRole('button', { name: 'Tile page 2, 1 agent waiting for you or stalled', exact: true }).count()))
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-grid.png') })
    // Resizing moves between the two, keeping the tile the keyboard is on (HI-1951): M, on page 2, has it; the area grown,
    // one page and M still has it; shrunk again, page 2 with M shows.
    const keyboardOn = () => page.evaluate(() => document.activeElement?.closest?.('.agent-tile')?.querySelector('.tile-name')?.textContent ?? null)
    await page.locator('.session-toolbar .tile-pages button').nth(1).click()
    await lib.until(async () => (await tileNames()).join() === 'M', HUNG_MS)
    await tile('M').focus()
    await fitTiles(null)
    check('the area grown: one page of all 13, no page buttons, M still with the keyboard', !!(await lib.until(async () => (await pager.count()) === 0 && (await tileNames()).length === 13 && (await keyboardOn()) === 'M', HUNG_MS)), JSON.stringify({ tiles: await tileNames(), on: await keyboardOn() }))
    await fitTiles(4, 3)
    check('…shrunk again: page 2 shown, M on it, still with the keyboard', !!(await lib.until(async () => (await pageButtons()) === '1 2*' && (await tileNames()).join() === 'M' && (await keyboardOn()) === 'M', HUNG_MS)), JSON.stringify({ pages: await pageButtons(), tiles: await tileNames(), on: await keyboardOn() }))
    await page.locator('.session-toolbar .tile-pages button').nth(0).click()
    await lib.until(async () => (await pageButtons()) === '1* 2(1)', HUNG_MS)

    // --- One height for every tile (#1145), whatever each shows: a reply (A), work (B), nothing (C…); and it stays while a
    // progress run starts on A (its progress line and bar) and ends. A's reply first runs to its two lines.
    const longReply = 'a reply long enough to fill both of the lines a tile gives it, and more after that, so it is cut short'
    await prompts('A').type(longReply)
    await lib.until(async () => (await live(ids.A))?.replyStart?.includes('long enough') && ['ready', 'finished'].includes((await live(ids.A))?.status), HUNG_MS)
    const heights = () => page.locator('.agent-tile').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10))
    const before = await heights()
    check('every tile is the same height', before.length === 12 && new Set(before).size === 1, before.join())
    // Its reply cut at its second line is in full on hover. The tip has content once the tile has measured the reply as
    // cut, which under load can come after a hover began (HI-1861): hovered again until it shows.
    let replyTip = ''
    await lib.until(async () => (replyTip = await lib.hoverTip(page, tile('A').locator('.tile-reply'), (t) => t.includes('so it is cut short'), 3000)).includes(longReply), HUNG_MS)
    check("A's reply, cut short, is in full on hover", replyTip.includes(longReply), replyTip)
    await page.mouse.move(5, 5)
    // A run whose title is too long for its line (round 1 finding 1: its tooltip's wrapper changed the line's width, and
    // measuring it again and again took the window down).
    const runDone = path.join(lib.WORK, 'tilesview-run-done')
    const runTitle = 'A very long progress run title that should be truncated cleanly in every narrow tile'
    await prompts('A').type(`shell: cw-progress --title "${runTitle}" -- node -e "setInterval(() => require('fs').existsSync(process.argv[1]) && process.exit(0), 100)" ${runDone}`)
    const progressShown = () => tile('A').evaluate((el) => el.querySelector('.tile-progress-text')?.textContent ?? '')
    check("A's tile shows its progress run", !!(await lib.until(async () => (await progressShown()).startsWith(runTitle), HUNG_MS)), await progressShown())
    const during = await heights()
    check('…and no tile changed height', during.length === 12 && during.every((h) => h === before[0]), `${before[0]} → ${during.join()}`)
    const cut = await tile('A').evaluate((el) => {
      const line = el.querySelector('.tile-progress-text .tile-line')
      const row = el.querySelector('.tile-progress-text')
      return { cut: !!line && line.scrollWidth > line.clientWidth, fits: !!line && !!row && line.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5 }
    })
    check('…its long title is cut short within its line', cut.cut && cut.fits, JSON.stringify(cut))
    const runTip = await lib.hoverTip(page, tile('A').locator('.tile-progress-text'), (t) => t.includes(runTitle), HUNG_MS)
    check('…in full on hover', runTip.includes(runTitle), runTip)
    await page.mouse.move(5, 5)
    check('…and the window is still the tiles (no error)', (await page.locator('.error-boundary').count()) === 0 && (await page.locator('.agent-tile').count()) === 12)
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-grid-run.png') })
    fs.writeFileSync(runDone, '')
    check('the run ends and A is idle again', !!(await lib.until(async () => (await progressShown()) === '' && ['ready', 'finished'].includes((await live(ids.A))?.status), HUNG_MS)))
    const after = await heights()
    check('…every tile still the same height', after.every((h) => h === before[0]), after.join())

    // Three badges at once in one tile (round 1 finding 2): its context past the threshold, a long transcript and a
    // background task. They stay on its one line, the warnings first, each cut short rather than cut through or hidden,
    // and all of them are in full on hover.
    await inv('settings:update', { sessions: { compactSuggestTokens: 100000, transcriptWarnMB: 1 } })
    await inv('session:start', alpha, { agentId: ids.D })
    await lib.until(async () => ['ready', 'waiting'].includes((await live(ids.D))?.status), HUNG_MS)
    if ((await live(ids.D))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, ids.D), '\r')
    await lib.until(async () => (await live(ids.D))?.status === 'ready', HUNG_MS)
    await prompts('D').type('context 500000 pad 1200 background 300')
    const badges = () =>
      tile('D').evaluate((el) => {
        const row = el.querySelector('.tile-badges').getBoundingClientRect()
        return [...el.querySelectorAll('.tile-badges .tile-badge')].map((b) => {
          const r = b.getBoundingClientRect()
          const t = b.querySelector('.tile-badge-text')
          return { text: t.textContent, warn: b.classList.contains('warn'), inside: r.left >= row.left - 0.5 && r.right <= row.right + 0.5, shown: t.clientWidth > 0, cut: t.scrollWidth > t.clientWidth }
        })
      })
    check("D's tile has its three badges", !!(await lib.until(async () => (await badges()).length === 3, HUNG_MS)), JSON.stringify(await badges()))
    const b3 = await badges()
    check('…the warnings first', b3[0].warn && b3[1].warn && !b3[2].warn, JSON.stringify(b3))
    check('…each within the line, none hidden', b3.every((b) => b.inside && b.shown), JSON.stringify(b3))
    check('…cut short with an ellipsis where they need it', b3.some((b) => b.cut) && (await tile('D').evaluate((el) => getComputedStyle(el.querySelector('.tile-badge-text')).textOverflow)) === 'ellipsis', JSON.stringify(b3))
    check('…and D keeps the tiles\' height', (await heights()).every((h) => h === before[0]), (await heights()).join())
    const badgeTip = await lib.hoverTip(page, tile('D').locator('.tile-badges'), (t) => b3.every((b) => t.includes(b.text)), HUNG_MS)
    check('…all of them in full on hover', b3.every((b) => badgeTip.includes(b.text)), badgeTip)
    await page.mouse.move(5, 5)
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-badges.png') })
    await inv('session:stop', alpha, ids.D)
    await lib.until(async () => !(await live(ids.D)), HUNG_MS)

    // --- Page 2: M, highlighted where it is.
    await page.locator('.session-toolbar .tile-pages button').nth(1).click()
    check('page 2: M alone, highlighted (waiting)', !!(await lib.until(async () => (await tileNames()).join() === 'M', HUNG_MS)) && (await tile('M').evaluate((el) => el.classList.contains('urgent') && el.classList.contains('waiting'))), (await tileNames()).join())
    check('…page 1 has nothing urgent to count', (await pageButtons()) === '1 2*', await pageButtons())
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Alt+PageDown')
    check('Ctrl+Alt+PageDown: back round to page 1', !!(await lib.until(async () => (await pageButtons()) === '1* 2(1)', HUNG_MS)), await pageButtons())

    // --- The keyboard: one tab stop; arrows move between tiles; Enter opens the focus view.
    const tabStops = () => page.locator('.agent-tile[tabindex="0"]').count()
    check('one tab stop in the grid', (await tabStops()) === 1)
    await tile('A').focus()
    const focusedTile = () => page.evaluate(() => document.activeElement?.closest?.('.agent-tile')?.querySelector('.tile-name')?.textContent ?? null)
    await page.keyboard.press('ArrowRight')
    check('→: B', (await focusedTile()) === 'B', await focusedTile())
    const cols = await page.locator('.agent-tile').evaluateAll((els) => els.filter((e) => e.offsetTop === els[0].offsetTop).length)
    await page.keyboard.press('ArrowDown')
    check(`↓: a row down (${cols} columns)`, (await focusedTile()) === NAMES[1 + cols], await focusedTile())
    await page.keyboard.press('Home')
    check('Home: A', (await focusedTile()) === 'A', await focusedTile())
    await page.keyboard.press('ArrowRight')
    check('…the tab stop follows the keyboard', (await page.locator('.agent-tile[tabindex="0"] .tile-name').innerText()) === 'B')
    await page.keyboard.press('Enter')
    const stripNames = () => page.locator('.tile-strip .tile-strip-item .tile-strip-name').allInnerTexts().catch(() => [])
    const paneName = () => page.locator('.agent-pane .pane-header-bar .agent-name').innerText().catch(() => '')
    const inFocus = async (name) => (await page.locator('.agents-area.shown.tile-focus').count()) === 1 && (await paneName()) === name && (await page.locator('.tile-strip-item.active .tile-strip-name').innerText().catch(() => '')) === name
    check("Enter: B's focus view, its pane beside the strip of all 13", !!(await lib.until(async () => (await inFocus('B')) && (await stripNames()).length === 13, HUNG_MS)), `${await paneName()} ${(await stripNames()).join()}`)
    check("…its live terminal shown, with the keyboard", !!(await lib.until(async () => (await page.locator('.terminal-host:not(.hidden)').count()) === 1 && (await page.evaluate(() => !!document.activeElement?.closest('.terminal-host'))), HUNG_MS)))
    check('…the grid gone, the pages none chosen', (await page.locator('.tile-grid').count()) === 0 && (await pageButtons()) === '1 2(1)', await pageButtons())
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-focus.png') })
    // Esc in the terminal is the CLI's: the focus view stays. Then a letter: keys are handled in order, so once the letter
    // is on the CLI's screen, the window has handled the Esc before it (taken back with Backspace).
    await page.keyboard.press('Escape')
    await page.keyboard.press('q')
    const screen = async () => lib.plainText(await inv('pty:buffer', lib.ptyKey(alpha, ids.B)).catch(() => ''))
    check('Esc in the terminal: the CLI has it (and the letter after it)', !!(await lib.until(async () => /\sq\s*$/.test(await screen()), HUNG_MS)), (await screen()).slice(-200))
    check('…still the focus view, the terminal keeping the keyboard', (await inFocus('B')) && (await page.evaluate(() => !!document.activeElement?.closest('.terminal-host'))))
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Control+Alt+Escape')
    check('Ctrl+Alt+Esc (Back to Tiles): the grid, the keyboard on B', !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 1 && (await focusedTile()) === 'B', HUNG_MS)), String(await focusedTile()))

    // --- The mouse: a tile opens it; the strip switches; Esc outside the terminal, and the Tiles toggle, go back.
    await tile('A').click()
    check("a click: A's focus view", !!(await lib.until(async () => inFocus('A'), HUNG_MS)), await paneName())
    await page.locator('.tile-strip-item', { has: page.locator('.tile-strip-name', { hasText: /^M$/ }) }).click()
    check("the strip's M: M's focus view (on page 2 of the tiles)", !!(await lib.until(async () => inFocus('M'), HUNG_MS)), await paneName())
    await page.locator('.tile-strip-item.active').focus()
    await page.keyboard.press('Escape')
    check('Esc on the strip: the grid on page 2, the keyboard on M', !!(await lib.until(async () => (await tileNames()).join() === 'M' && (await focusedTile()) === 'M', HUNG_MS)), `${(await tileNames()).join()} ${await focusedTile()}`)
    await tile('M').click()
    await lib.until(async () => inFocus('M'), HUNG_MS)
    await page.locator('.view-switch [data-view="tiles"]').click()
    check('the Tiles toggle again: the grid', !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 1, HUNG_MS)))
    await page.locator('.tile-strip-back').count().then((n) => check('…the strip gone', n === 0))

    // --- The chip's list opens an agent's focus view; Panes leaves it, and Tiles shows the grid again.
    await page.locator('.session-toolbar .summary-chip').click()
    await lib.until(async () => (await lib.menuEntry(page, 'B').count()) === 1, HUNG_MS)
    await lib.menuEntry(page, 'B').click()
    check("the chip's list: B's focus view", !!(await lib.until(async () => inFocus('B'), HUNG_MS)), await paneName())
    await page.locator('.view-switch [data-view="panes"]').click()
    check('Panes: the panes, no strip', !!(await lib.until(async () => (await page.locator('.agents-area.shown:not(.tile-focus)').count()) === 1 && (await page.locator('.tile-strip').count()) === 0, HUNG_MS)))
    await page.locator('.view-switch [data-view="tiles"]').click()
    check('Tiles again: the grid, not the focus view', !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 1 && (await page.locator('.tile-strip').count()) === 0, HUNG_MS)))

    // --- Tile order By urgency: M (waiting) first, then B (working), then the idle ones in their order.
    await inv('settings:update', { sessions: { tileOrder: 'urgency' } })
    const byUrgency = ['M', 'B', ...NAMES.filter((n) => n !== 'M' && n !== 'B')]
    check('By urgency: M, B, then the others in their order', !!(await lib.until(async () => (await tileNames()).join() === byUrgency.slice(0, 12).join(), HUNG_MS)), (await tileNames()).join())
    check('…nothing urgent on page 2 to count', (await pageButtons()) === '1* 2', await pageButtons())
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-urgency.png') })
    check('…no tile drags (the order is computed)', (await page.locator('.agent-tile[draggable="true"]').count()) === 0)
    await inv('settings:update', { sessions: { tileOrder: 'panes' } })

    // --- Reordering (#993), Same as panes: tiles drag like pane headers, and the panes follow.
    const saved = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8')).agents.map((a) => a.name).join()
      } catch {
        return '' // being written
      }
    }
    await page.locator('.session-toolbar .tile-pages button').nth(0).click()
    check('Same as panes again: the tiles drag', !!(await lib.until(async () => (await tileNames()).join() === NAMES.slice(0, 12).join() && (await page.locator('.agent-tile[draggable="true"]').count()) === 12, HUNG_MS)), (await tileNames()).join())
    const at = async (loc) => {
      const b = await loc.boundingBox()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }
    // A native drag with the mouse, as swap.cjs drags: press, nudge until the page's dragstart, over each stop in turn
    // (until it shows the drag over it: a tile its drop target, a page button its mark), release, then wait for its end.
    const dragState = () => page.evaluate(() => window.__tileDrag)
    const drag = async (from, stops, shot) => {
      await page.evaluate(() => {
        window.__tileDrag = 'none'
        document.addEventListener('dragstart', () => (window.__tileDrag = 'started'), { once: true })
        document.addEventListener('dragend', () => (window.__tileDrag = 'ended'), { once: true })
      })
      const a = await at(from)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      let dx = 0
      if (!(await lib.until(async () => (await dragState()) !== 'none' || void (await page.mouse.move(a.x + 8 + (dx = 1 - dx), a.y, { steps: 2 })), HUNG_MS))) throw new Error('the drag never started (no dragstart)')
      for (const loc of stops) {
        const b = await at(loc)
        await page.mouse.move(b.x, b.y, { steps: 8 })
        if ((await loc.locator('.tile-drop').count()) > 0) {
          if (!(await lib.until(async () => (await loc.locator('.tile-drop.over').count()) > 0 || void (await page.mouse.move(b.x + (dx = 1 - dx), b.y, { steps: 2 })), HUNG_MS))) throw new Error('the tile never showed the drag over it')
        } else if (!(await lib.until(async () => (await loc.evaluate((el) => el.classList.contains('drop-target'))) || void (await page.mouse.move(b.x + (dx = 1 - dx), b.y, { steps: 2 })), HUNG_MS))) throw new Error('the page button never showed the drag over it')
      }
      if (shot) await page.screenshot({ path: path.join(lib.WORK, shot) })
      await page.mouse.up()
      // The source can leave the screen (moved to another page): then the drop targets going is the end.
      await lib.until(async () => (await dragState()) === 'ended' || (await page.locator('.tile-drop').count()) === 0, HUNG_MS)
    }
    const order = (names) => names.join()
    await drag(tile('A'), [tile('C')], 'tilesview-drag.png')
    const swapped = ['C', 'B', 'A', ...NAMES.slice(3)]
    check('A dropped on C: they swap, saved in project.json', !!(await lib.until(async () => saved() === order(swapped) && (await tileNames()).join() === order(swapped.slice(0, 12)), HUNG_MS)), `${saved()} / ${(await tileNames()).join()}`)
    check('…the drag has ended: no drop targets left', !!(await lib.until(async () => (await page.locator('.tile-drop, .tile-pages button.drop-target').count()) === 0, HUNG_MS)))
    // A move shown while its save is held (#1229): a refresh meanwhile reads the order from before it, and its report
    // reaches the window (seen by a listener after the window's own, then drawn); the tiles keep the move.
    await app.evaluate(() => void (process.env.HIVE_TEST_SLOW_IPC = 'agents:move=20000*1'))
    await tile('C').focus()
    await page.keyboard.press('Control+Alt+Shift+ArrowRight')
    const held = ['B', 'C', 'A', ...NAMES.slice(3)]
    check('Move Agent Right on C, its save held: shown at once, not saved yet', !!(await lib.until(async () => (await tileNames()).join() === order(held.slice(0, 12)), HUNG_MS)) && saved() === order(swapped), `${saved()} / ${(await tileNames()).join()}`)
    await page.evaluate(() => {
      window.__olderOrder = null
      window.hive.onEvent((e) => {
        const p = e.type === 'workspace-changed' && window.__olderOrder === null ? e.workspace?.projects.find((x) => x.name === 'alpha') : null
        if (p) window.__olderOrder = p.agents.map((a) => a.name).join()
      })
    })
    await inv('workspace:refresh')
    const older = await lib.until(() => page.evaluate(() => window.__olderOrder), HUNG_MS)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    check('…a refresh meanwhile reports the order from before the move', older === order(swapped), String(older))
    check('…and the tiles keep the move', (await tileNames()).join() === order(held.slice(0, 12)), (await tileNames()).join())
    await app.evaluate(() => void (process.env.HIVE_TEST_SLOW_IPC = ''))
    // Bound: the save's hold left over, plus a hung run's.
    check('…saved once its save goes on, still shown', !!(await lib.until(async () => saved() === order(held) && (await tileNames()).join() === order(held.slice(0, 12)), 20000 + HUNG_MS)), `${saved()} / ${(await tileNames()).join()}`)
    await tile('C').focus()
    await page.keyboard.press('Control+Alt+Shift+ArrowLeft')
    check('…and Move Agent Left puts it back', !!(await lib.until(async () => saved() === order(swapped) && (await tileNames()).join() === order(swapped.slice(0, 12)), HUNG_MS)), `${saved()} / ${(await tileNames()).join()}`)
    // Page 2's button: B goes to the end, the grid showing it there.
    await drag(tile('B'), [page.locator('.session-toolbar .tile-pages button').nth(1)])
    const toEnd = ['C', 'A', ...NAMES.slice(3), 'B']
    check("B dropped on page 2's button: last, page 2 shown", !!(await lib.until(async () => saved() === order(toEnd) && (await tileNames()).join() === 'B' && (await pageButtons()).endsWith(' 2*'), HUNG_MS)), `${saved()} / ${(await tileNames()).join()} / ${await pageButtons()}`)
    // The keyboard: Move Agent Left on B's tile takes it to page 1, the keyboard staying on it.
    await tile('B').focus()
    await page.keyboard.press('Control+Alt+Shift+ArrowLeft')
    const left = ['C', 'A', ...NAMES.slice(3, 12), 'B', 'M']
    check('Move Agent Left (Ctrl+Alt+Shift+←) on B: a place left, onto page 1, the keyboard on it', !!(await lib.until(async () => saved() === order(left) && (await tileNames()).join() === order(left.slice(0, 12)) && (await focusedTile()) === 'B', HUNG_MS)), `${saved()} / ${(await tileNames()).join()} / ${await focusedTile()}`)
    // The panes show the same order (three columns: B's page, as B is focused).
    await inv('project:updateConfig', alpha, { layout: 'columns3' })
    await inv('workspace:refresh')
    await page.locator('.view-switch [data-view="panes"]').click()
    const paneNames = () => page.locator('.agent-pane .pane-header-bar .agent-name').allInnerTexts().catch(() => [])
    check('Panes: the same order (K, L, B on its page)', !!(await lib.until(async () => (await paneNames()).join() === 'K,L,B' && (await page.locator('.agents-area.shown:not(.tile-focus)').count()) === 1, HUNG_MS)), (await paneNames()).join())
    // Back in Tiles, B's menu (from the keyboard) moves it back.
    await page.locator('.view-switch [data-view="tiles"]').click()
    await lib.until(async () => (await tile('B').count()) === 1, HUNG_MS)
    await tile('B').focus()
    await page.keyboard.press('Shift+F10')
    await lib.until(async () => (await lib.menuEntry(page, 'Move Right').count()) === 1, HUNG_MS)
    await lib.menuEntry(page, 'Move Right').click()
    check("the tile's menu, Move Right: B a place right, page 2 shown", !!(await lib.until(async () => saved() === order(toEnd) && (await tileNames()).join() === 'B', HUNG_MS)), `${saved()} / ${(await tileNames()).join()}`)
    // Other shortcuts still work from a tile, chords too: Ctrl+K Ctrl+S (Keyboard Shortcuts).
    await tile('B').focus()
    await page.keyboard.press('Control+K')
    await page.keyboard.press('Control+S')
    check('a chord from a tile: Ctrl+K Ctrl+S opens Keyboard Shortcuts', !!(await lib.until(async () => (await page.locator('.dialog').innerText().catch(() => '')).startsWith('Keyboard Shortcuts'), HUNG_MS)), `${await page.locator('.dialog').count()} dialogs`)
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.dialog').count()) === 0, HUNG_MS)
    // Move Agent Right bound to F6 (no modifier): on A's tile it moves A, not B (the agent moved last).
    await inv('settings:update', { keybindings: { 'agent.moveRight': 'F6' } })
    await lib.until(async () => (await inv('settings:get')).keybindings['agent.moveRight'] === 'F6', HUNG_MS)
    await page.locator('.session-toolbar .tile-pages button').nth(0).click()
    await lib.until(async () => (await tile('A').count()) === 1, HUNG_MS)
    await tile('A').focus()
    await page.keyboard.press('F6')
    const f6 = ['C', 'D', 'A', ...NAMES.slice(4), 'B']
    check("Move Agent Right on F6, on A's tile: A a place right, the keyboard on it", !!(await lib.until(async () => saved() === order(f6) && (await tileNames()).join() === order(f6.slice(0, 12)) && (await focusedTile()) === 'A', HUNG_MS)), `${saved()} / ${await focusedTile()}`)
    // Bound to a plain arrow, the command wins over moving between tiles: Move Agent Left on ←.
    await inv('settings:update', { keybindings: { 'agent.moveRight': 'F6', 'agent.moveLeft': 'ArrowLeft' } })
    await lib.until(async () => (await inv('settings:get')).keybindings['agent.moveLeft'] === 'ArrowLeft', HUNG_MS)
    await tile('A').focus()
    await page.keyboard.press('ArrowLeft')
    const back = ['C', 'A', ...NAMES.slice(3), 'B']
    check("Move Agent Left on ←, on A's tile: A moves back (not the keyboard to the tile beside it)", !!(await lib.until(async () => saved() === order(back) && (await tileNames()).join() === order(back.slice(0, 12)) && (await focusedTile()) === 'A', HUNG_MS)), `${saved()} / ${await focusedTile()}`)
    // A chord ending in an arrow: Move Agent Right on Ctrl+K ←, on A's tile, moves A (the arrow is the chord's, not the grid's).
    // ← alone is bound to nothing again (Move Agent Left back on its default).
    await inv('settings:update', { keybindings: { 'agent.moveRight': 'Mod+K ArrowLeft', 'agent.moveLeft': 'Mod+Alt+Shift+ArrowLeft' } })
    await lib.until(async () => {
      const kb = (await inv('settings:get')).keybindings
      return kb['agent.moveRight'] === 'Mod+K ArrowLeft' && kb['agent.moveLeft'] === 'Mod+Alt+Shift+ArrowLeft'
    }, HUNG_MS)
    await tile('A').focus()
    await page.keyboard.press('Control+K')
    await page.keyboard.press('ArrowLeft')
    check("Move Agent Right on Ctrl+K ←, on A's tile: A a place right, the keyboard on it", !!(await lib.until(async () => saved() === order(f6) && (await tileNames()).join() === order(f6.slice(0, 12)) && (await focusedTile()) === 'A', HUNG_MS)), `${saved()} / ${await focusedTile()}`)
    // An arrow bound to nothing still moves between tiles, and moves no agent.
    await page.keyboard.press('ArrowRight')
    check('an unbound → still moves the keyboard to the next tile (E), the order unchanged', !!(await lib.until(async () => (await focusedTile()) === 'E', HUNG_MS)) && saved() === order(f6), `${await focusedTile()} / ${saved()}`)

    // --- The strip's card chips (#1021): what each agent works on (Active), reviews, or holds in Review or Approved, tinted
    // with the column the card is in (blocked: red); a long name ends in an ellipsis before its chip, the chips in a
    // column; the status drops the number the chip shows; a click opens the card.
    const LONG = 'A builder with a really long name for the strip'
    ids[LONG] = (await lib.addAgent(inv, alpha, { name: LONG })).id
    const card = async (title, agent, column) => (await inv('tasks:create', { title, project: 'alpha', agent: ids[agent], column })).number
    const doingCard = await card('Chip in Doing', LONG, 'doing')
    const passedCard = await card('Chip in Passed', 'C', 'passed')
    const reviewCard = await card('Chip in Review', 'D', 'review')
    const blockedCard = await card('Chip blocked', 'E', 'doing')
    await inv('tasks:update', blockedCard, { blocked: 'Waiting for an answer' })
    // A reviews D's card with its own tool call, then watches it into Passed.
    await prompts('A').type(`cw cw_update_task ${JSON.stringify({ number: reviewCard, review: 'start' })}`)
    await lib.until(async () => (await inv('tasks:list')).find((c) => c.number === reviewCard)?.review?.agent === ids.A, HUNG_MS)
    await prompts('A').type(`cw cw_wait_for_tasks ${JSON.stringify({ cards: [reviewCard], column: 'passed', changes: ['verdict', 'column'], wake: true })}`)
    await lib.until(async () => (await live(ids.A))?.status === 'watching', HUNG_MS)
    await page.locator('.session-toolbar .tile-pages button').nth(0).click()
    await tile('A').click()
    await lib.until(async () => inFocus('A'), HUNG_MS)
    const row = (name) => page.locator('.tile-strip-row', { has: page.locator('.tile-strip-name', { hasText: new RegExp(`^${name}$`) }) })
    const chipOf = (name) => row(name).locator('.tile-strip-chip .card-chip')
    const chipInfo = (name) => chipOf(name).evaluate((el) => ({ text: el.textContent, column: el.dataset.column, col: el.style.getPropertyValue('--col'), blocked: !!el.dataset.blocked, review: !!el.dataset.review, label: el.getAttribute('aria-label') })).catch(() => null)
    const chips = { [LONG]: [doingCard, 'doing', '#3b82f6'], C: [passedCard, 'passed', '#14b8a6'], A: [reviewCard, 'review', '#a371f7'], D: [reviewCard, 'review', '#a371f7'] }
    check('the strip: a chip on each row with a card', !!(await lib.until(async () => (await page.locator('.tile-strip-chip .card-chip').count()) === 5, HUNG_MS)), String(await page.locator('.tile-strip-chip .card-chip').count()))
    // Each card by key (#1221).
    const L = {}
    for (const n of [doingCard, passedCard, reviewCard, blockedCard]) L[n] = await lib.cardLabel(inv, n)
    for (const [name, [n, column, col]] of Object.entries(chips)) {
      const c = await chipInfo(name)
      check(`…${name.length > 2 ? 'the long-named builder' : name}: ${L[n]}, in its column's colour (${column})`, c?.text === L[n] && c.column === column && c.col === col, JSON.stringify(c))
    }
    check("…A's is the reviewer's chip (the eye)", (await chipInfo('A'))?.review && (await row('A').locator('.tile-strip-chip .codicon-eye').count()) === 1)
    const blocked = await chipInfo('E')
    check("…E's blocked card: red, and said so", blocked?.blocked && blocked.col === 'var(--error)' && blocked.label === `Card ${L[blockedCard]}, Active, blocked`, JSON.stringify(blocked))
    check("…C's accessible name: the card and its column", (await chipInfo('C'))?.label === `Card ${L[passedCard]}, Approved`, (await chipInfo('C'))?.label)
    check('…no card, no chip (F)', (await row('F').locator('.card-chip').count()) === 0)
    // Waited for: A can still say Working… a moment after its watch began (HI-1861), so its status is read until it settles.
    const statusOf = (name) => row(name).locator('.tile-strip-status').innerText().catch(() => '')
    check("…A's status drops the number its chip shows: Waiting → Approved", !!(await lib.until(async () => (await statusOf('A')) === 'Waiting → Approved', HUNG_MS)), await statusOf('A'))
    // The layout: the long name cut before its chip, never under it; the chips' right edges in a column.
    const layout = () =>
      page.locator('.tile-strip-row').evaluateAll((rows) =>
        rows.map((r) => {
          const name = r.querySelector('.tile-strip-name')
          const chip = r.querySelector('.tile-strip-chip .card-chip')
          return { cut: name.scrollWidth > name.clientWidth, nameRight: name.getBoundingClientRect().right, chipLeft: chip?.getBoundingClientRect().left ?? null, chipRight: chip?.getBoundingClientRect().right ?? null, rowRight: r.getBoundingClientRect().right }
        })
      )
    const fits = (rows) => rows.every((r) => r.chipLeft === null || (r.nameRight <= r.chipLeft && r.chipRight <= r.rowRight)) && new Set(rows.filter((r) => r.chipRight !== null).map((r) => Math.round(r.chipRight))).size === 1
    const longCut = async () => (await layout())[(await page.locator('.tile-strip-name').allInnerTexts()).indexOf(LONG)]?.cut
    check('…the long name ends in an ellipsis before its chip; the chips line up', (await longCut()) && fits(await layout()), JSON.stringify(await layout()))
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-chips.png') })
    await chipOf('C').click()
    const dialog = lib.cardDialog(page, await lib.cardLabel(inv, passedCard))
    check("a click on C's chip opens its card, the focus view staying on A", !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)) && (await inFocus('A')))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)

    // --- Resizing (#1021): the strip's edge drags like the other splitters, the pane beside it following; the width is
    // saved, kept within its bounds, and double-click resets it.
    const widths = () => page.evaluate(() => ({ strip: Math.round(document.querySelector('.tile-strip').getBoundingClientRect().width), left: Math.round(document.querySelector('.agents-area.tile-focus').getBoundingClientRect().left - document.querySelector('.tile-strip').getBoundingClientRect().left) }))
    const dragEdge = async (dx) => {
      const b = await page.locator('.tile-strip > .pane-resizer').boundingBox()
      await page.mouse.move(b.x + b.width / 2, b.y + 300)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width / 2 + dx, b.y + 300, { steps: 8 })
      await page.mouse.up()
    }
    const savedWidth = async () => (await inv('ui:get')).panes?.tileStrip
    await dragEdge(120)
    check('dragging the edge 120 px right: the strip 320 px, the pane beside it, saved', !!(await lib.until(async () => (await widths()).strip === 320 && (await widths()).left === 320 && (await savedWidth()) === 320, HUNG_MS)), `${JSON.stringify(await widths())} saved ${await savedWidth()}`)
    check('…the long name shows more of itself, the chips still in line', fits(await layout()), JSON.stringify(await layout()))
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-strip-wide.png') })
    await dragEdge(-400)
    check('dragged far left: held at its narrowest (170 px)', !!(await lib.until(async () => (await widths()).strip === 170 && (await savedWidth()) === 170, HUNG_MS)), JSON.stringify(await widths()))
    check('…the chips keep their place, no name under them', fits(await layout()), JSON.stringify(await layout()))
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-strip-narrow.png') })
    await dragEdge(150)
    await lib.until(async () => (await savedWidth()) === 320, HUNG_MS)

    // A restart keeps it.
    await inv('session:stop', alpha).catch(() => undefined)
    await lib.until(async () => (await inv('session:live').catch(() => [])).length === 0, HUNG_MS)
    await app.close()
    ;({ app, page, inv } = await lib.launch({ userData, env: { CLAUDE_CONFIG_DIR: claudeHome, HIVE_API_PORT: lib.port(47825) }, viewport: { width: 1500, height: 900 } }))
    page.on('pageerror', (e) => check('no page errors (restarted)', false, e.message))
    for (const w of app.windows().slice(1)) await w.close().catch(() => undefined)
    await lib.openWorkspace(inv, page, ws)
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.until(async () => (await tile('A').count()) === 1, HUNG_MS)
    await tile('A').click()
    check('after a restart: the strip as wide as it was left (320 px)', !!(await lib.until(async () => (await page.locator('.tile-strip').count()) === 1 && (await widths()).strip === 320, HUNG_MS)), JSON.stringify(await widths().catch(() => null)))
    await page.locator('.tile-strip > .pane-resizer').dblclick()
    check('double-click on the edge: back to 200 px, nothing saved', !!(await lib.until(async () => (await widths()).strip === 200 && (await widths()).left === 200 && (await savedWidth()) === undefined, HUNG_MS)), `${JSON.stringify(await widths())} saved ${await savedWidth()}`)
  } finally {
    await inv('session:stop', alpha).catch(() => undefined)
    await lib.until(async () => (await inv('session:live').catch(() => [])).length === 0, HUNG_MS)
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
