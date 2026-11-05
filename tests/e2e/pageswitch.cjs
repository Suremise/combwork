// Switching pane pages with the agents' terminals running (HI-1828). Nine fake Claude Code agents in six panes: page 2's
// three take WebGL contexts as they are shown, and page 1's terminals (hidden now) give theirs back within the budget
// (eight). xterm then drew a terminal given back with its DOM renderer in the page, measuring each character's width with
// a layout of the whole window each time: a page switch froze the window 0.4–0.9 s (5–7 s on the user's 14 agents). A
// terminal that gives its WebGL back while hidden is taken out of the page until it is shown; hidden terminals are off
// screen, so xterm doesn't draw them. Here: one of page 1's is out of the page while page 2 shows, what is printed into
// it meanwhile is kept, and back on page 1 it is in its pane again, drawing with WebGL and fitted. Then the same with
// WebGL unavailable as it is shown: it draws with the DOM renderer, its text as wide as its cells (its widths measured
// again: out of the page they were 0).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'pageswitch-profile')
const ws = path.join(lib.WORK, 'pageswitch-ws')
const claudeHome = path.join(lib.WORK, 'pageswitch-claude-home')
const proj = path.join(ws, 'alpha')
const AGENTS = 9
const MARK = 'PAGESWITCH-MARK-0123456789'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(proj)
  const env = lib.fakeClaude(userData, claudeHome, [proj])
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, CW_API_PORT: lib.port(47924) }, viewport: { width: 1500, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    const agents = []
    for (let i = 1; i <= AGENTS; i++) agents.push(await lib.addAgent(inv, proj, { name: `P${i}` }))
    await inv('project:updateConfig', proj, { layout: 'grid6' })
    for (const a of agents) await inv('session:start', proj, { agentId: a.id })
    const live = () => inv('session:live')
    check(`all ${AGENTS} agents run`, !!(await lib.until(async () => {
      const l = await live()
      return agents.every((a) => l.find((s) => s.agentId === a.id)?.status === 'ready')
    }, 90000)))

    // Each terminal as the window has it: shown, in the page, and drawing with WebGL (a canvas, no DOM rows).
    const terminals = () =>
      page.evaluate((keys) =>
        keys.map((k) => {
          const host = document.querySelector(`.terminal-host[data-pty=${JSON.stringify(k)}]`)
          const xterm = host?.querySelector('.xterm')
          return { key: k, shown: !!host && !host.classList.contains('hidden'), inPage: !!xterm, webgl: !!xterm?.querySelector('canvas:not(.xterm-link-layer)') && !xterm.querySelector('.xterm-rows')?.childElementCount }
        }), agents.map((a) => lib.ptyKey(proj, a.id)))
    const go = async (n) => {
      await page.locator(`.page-switch button[aria-label="Agent page ${n}"]`).click()
      return lib.until(async () => (await page.locator('.page-switch button.active').innerText().catch(() => '')).trim() === String(n), HUNG_MS)
    }
    const lines = (key) => page.evaluate((k) => window.__hiveTerminalLines(k)?.join('\n') ?? '', key)
    const print = (key, text) => page.evaluate(([k, t]) => window.__hiveTerminalOutput(k, t), [key, text])

    // Page 1: six shown, each with WebGL.
    const first = await lib.until(async () => {
      const t = await terminals()
      return t.filter((x) => x.shown && x.webgl).length === 6 && t
    }, HUNG_MS)
    check('page 1 shows six terminals, each drawing with WebGL', !!first, JSON.stringify(await terminals()))
    const page1 = (first || []).filter((x) => x.shown).map((x) => x.key)

    // Page 2: its three take WebGL; one of page 1's gives its context back, and is out of the page while hidden.
    check('page 2 shows', !!(await go(2)))
    const out = await lib.until(async () => {
      const t = await terminals()
      const away = t.filter((x) => page1.includes(x.key) && !x.inPage)
      return t.filter((x) => x.shown && x.webgl).length === 3 && (await page.evaluate(() => window.__hiveWebglCount())) <= 8 && away.length > 0 && away
    }, HUNG_MS)
    check('page 2 draws with WebGL, and a terminal of page 1 that gave its context back is out of the page', !!out, JSON.stringify(await terminals()))
    const parked = out ? out[0].key : page1[0]
    // Printed by its CLI, through its pty (the fake echoes what is typed into its input box), as an agent's output comes
    // while its page is hidden. Written into xterm alone, it wasn't on the pty's screen: page 1's terminals can still be
    // waiting for a fit as page 2 shows (shown with WebGL isn't fitted), and their resize back on page 1 has ConPTY repaint
    // the screen without it (HI-2374).
    await inv('pty:write', parked, 'printed while out of the page')
    check('what is printed into it meanwhile is kept', !!(await lib.until(async () => (await lines(parked)).includes('printed while out of the page'), HUNG_MS)), await lines(parked))

    // Back on page 1: in its pane again, with WebGL, fitted and inside its pane.
    check('page 1 shows again', !!(await go(1)))
    const back = await lib.until(async () => {
      const t = (await terminals()).find((x) => x.key === parked)
      return t?.shown && t.inPage && t.webgl && (await page.evaluate(() => window.__hiveTerminalsFitted() && window.__hiveTerminalsInside()))
    }, HUNG_MS)
    check('…the terminal is back in its pane, drawing with WebGL, fitted', !!back, JSON.stringify(await terminals()))
    check('…with what was printed while it was out', (await lines(parked)).includes('printed while out of the page'), await lines(parked))

    // WebGL unavailable as it is shown again (a GPU that refuses contexts): the DOM renderer draws it, its text as wide as
    // its cells. Its widths were measured out of the page (0): unmeasured again, the mark would be about twice as wide.
    check('page 2 shows again', !!(await go(2)))
    const out2 = await lib.until(async () => {
      const away = (await terminals()).filter((x) => page1.includes(x.key) && !x.inPage)
      return away.length > 0 && away
    }, HUNG_MS)
    check('…and a terminal of page 1 is out of the page again', !!out2, JSON.stringify(await terminals()))
    const parked2 = out2 ? out2[0].key : page1[0]
    await page.evaluate(() => {
      const getContext = HTMLCanvasElement.prototype.getContext
      window.__pageswitchGetContext = getContext
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/.test(type) ? null : getContext.call(this, type, ...rest)
      }
    })
    check('page 1 shows, WebGL unavailable', !!(await go(1)))
    // The mark's width on screen, against its length in the terminal's cells.
    const widths = () =>
      page.evaluate(([k, mark]) => {
        const xterm = document.querySelector(`.terminal-host[data-pty=${JSON.stringify(k)}] .xterm`)
        const screen = xterm?.querySelector('.xterm-screen')
        const row = [...(xterm?.querySelectorAll('.xterm-rows > div') ?? [])].find((r) => r.textContent.includes(mark))
        const state = window.__hiveTerminalState(k)
        if (!screen || !row || !state) return null
        // Drawn in one style, the mark is one run of text (characters drawn at a width not their own are split apart).
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node && !node.textContent.includes(mark)) node = walker.nextNode()
        if (!node) return { mark: null, split: true }
        const range = document.createRange()
        const at = node.textContent.indexOf(mark)
        range.setStart(node, at)
        range.setEnd(node, at + mark.length)
        return { mark: range.getBoundingClientRect().width, cells: (screen.getBoundingClientRect().width / state.cols) * mark.length }
      }, [parked2, MARK])
    const shownWithDom = await lib.until(async () => {
      const t = (await terminals()).find((x) => x.key === parked2)
      return t?.shown && t.inPage && !t.webgl && (await page.evaluate(() => window.__hiveTerminalsFitted()))
    }, HUNG_MS)
    check('…the terminal is back in its pane, drawing with the DOM renderer, fitted', !!shownWithDom, JSON.stringify(await terminals()))
    // The mark printed now, once the pane has settled (its CLI redraws its screen as the DOM renderer's cells fit it anew).
    const dom = await lib.until(async () => {
      if (!(await lines(parked2)).includes(MARK)) await print(parked2, `\r\n${MARK}\r\n`)
      const w = await widths()
      return w?.mark && Math.abs(w.mark - w.cells) <= w.cells * 0.1 && w
    }, HUNG_MS)
    const drawn = () => page.evaluate((k) => [...document.querySelectorAll(`.terminal-host[data-pty=${JSON.stringify(k)}] .xterm-rows > div`)].map((r) => r.textContent).join('\n'), parked2)
    check('…its text as wide as its cells', !!dom, `${JSON.stringify((await terminals()).find((x) => x.key === parked2))} ${JSON.stringify(await widths())}\nlines:\n${await lines(parked2)}\ndrawn:\n${await drawn()}`)
    await page.evaluate(() => (HTMLCanvasElement.prototype.getContext = window.__pageswitchGetContext))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
