// Room for the work beside the Assistant's panel (HI-1737, Darren's decision): in a narrow or zoomed window what is
// beside the work gives way in order, covering nothing. At 900 px and 150% (600 CSS px) the sidebar and the panel had
// left the main pane 0 px. The window at 900 px with the sidebar on Projects and the Assistant's panel open, at 100%,
// 125% and 150%: the main pane keeps 280 px or more, nothing reaches past the window, the panel narrows first (to 240
// px, never under), then the sidebar, then the Projects list folds to its rail while the window stays narrow; the saved
// sidebar (its width, not compact) is unchanged. Expand Sidebar on the folded rail shows the list anyway; the panel
// closed (room again), the list is back on its own. Another sidebar view (Notes, no rail) at 150%: the sidebar at its
// least width, the work takes what is left, nothing past the window. Screenshots at each zoom, light and dark (captured
// by Electron: an element's screenshot is wrong under zoom, HI-1696). Dev build, throwaway profile and workspace; no
// CLI is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'panelroom-profile')
const ws = path.join(lib.WORK, 'panelroom-ws')
const alpha = path.join(ws, 'alpha')
const shots = path.join(lib.WORK, 'panelroom-shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.hive/\n' })
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'Builder' }, { id: 'r1', name: 'Reviewer' }] }))

  const { app, page } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    await lib.until(async () => (await page.locator('.tabs .tab').count()) > 0, HUNG_MS)

    /** The workbench as laid out now: each part's width and right edge, the window's width, the sidebar's form. */
    const room = () => page.evaluate(() => {
      const w = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { width: Math.round(r.width), right: Math.round(r.right) }
      }
      const bench = document.querySelector('.workbench')
      return {
        window: window.innerWidth,
        main: w('.workbench > .main-area'),
        sidebar: w('.workbench > .sidebar'),
        compact: !!document.querySelector('.workbench > .sidebar.compact'),
        panel: w('.workbench > .assistant-panel'),
        widest: Math.max(...[...bench.children].map((c) => Math.round(c.getBoundingClientRect().right))),
        // What never gives way: the activity bar, the Progress panel's folded strip.
        others: [...bench.children].filter((c) => !c.matches('.main-area, .sidebar, .assistant-panel, .progress-panel')).reduce((n, c) => n + Math.round(c.getBoundingClientRect().width), 0),
        overflow: bench.scrollWidth - bench.clientWidth
      }
    })
    const fitsWindow = (r) => r.widest <= r.window + 1 && r.overflow <= 1
    // The work's least room: 280 px, or all that is left beside everything else at its least (the sidebar's rail or 160
    // px, the panel's 240) when the window hasn't 280 to give (a pixel for rounding).
    const least = (r) => Math.min(280, r.window - r.others - (r.compact ? 48 : 160) - 240) - 1
    const capture = async (name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
        fs.writeFileSync(path.join(shots, `panelroom-${name}-${theme}.png`), Buffer.from(png, 'base64'))
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const zoomTo = async (z, width) => {
      await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), z)
      await lib.until(async () => Math.abs((await page.evaluate(() => window.innerWidth)) - width / z) <= 2, HUNG_MS)
    }
    const saved = async () => {
      const ui = await inv('ui:get')
      return { width: ui.sidebarWidth, compact: !!ui.sidebarCompact }
    }
    const before = await saved()

    await lib.fitWindow(app, page, { width: 900, height: 850 })
    await page.locator('.assistant-rail').click()
    await lib.until(async () => (await page.locator('.assistant-panel').count()) === 1, HUNG_MS)

    // At each zoom: the work keeps its room, nothing past the window, the panel never under its least width.
    const expect = { 1: { folded: false }, 1.25: { folded: true }, 1.5: { folded: true } }
    for (const z of [1, 1.25, 1.5]) {
      await zoomTo(z, 900)
      const pct = `${Math.round(z * 100)}%`
      const ok = await lib.until(async () => {
        const r = await room()
        return r.main.width >= least(r) && r.panel.width >= 240 && fitsWindow(r) && r.compact === expect[z].folded && r
      }, HUNG_MS)
      check(`900 px at ${pct}, the Assistant's panel open: the work keeps 280 px or all that is left, the panel 240 or more, nothing past the window; the Projects list ${expect[z].folded ? 'folded to its rail' : 'shown'}`, !!ok, JSON.stringify(await room()))
      await capture(`assistant-${Math.round(z * 100)}`)
    }
    // At 100% the panel gave way before the sidebar: the sidebar kept its own width (280) while the panel narrowed.
    await zoomTo(1, 900)
    const at100 = await lib.until(async () => {
      const r = await room()
      return !r.compact && r.sidebar.width >= before.width && r.panel.width < 430 && r
    }, HUNG_MS)
    check('at 100%: the panel narrowed first, the sidebar kept its width', !!at100, JSON.stringify(await room()))
    check('…and what is saved of the sidebar is unchanged (its width, not compact)', JSON.stringify(await saved()) === JSON.stringify(before), JSON.stringify(await saved()))

    // Folded at 150%: Expand Sidebar shows the list anyway; the work takes what is left, nothing past the window.
    await zoomTo(1.5, 900)
    await lib.until(async () => (await room()).compact, HUNG_MS)
    await page.locator('.sidebar.compact').getByRole('button', { name: 'Expand Sidebar' }).click()
    check('Expand Sidebar on the folded rail: the list shows, nothing past the window', !!(await lib.until(async () => {
      const r = await room()
      return !r.compact && fitsWindow(r) && r.main.width > 0
    }, HUNG_MS)), JSON.stringify(await room()))
    await capture('assistant-150-expanded')
    check('…still not compact in what is saved', !(await saved()).compact)
    // The panel closed: room again, and the list stays (no fold); folded again only when short once more.
    await page.keyboard.press('Control+Alt+I')
    await lib.until(async () => (await page.locator('.assistant-rail').count()) === 1, HUNG_MS)
    check("the Assistant's panel closed at 150%: the list, the work at 280 px or more", !!(await lib.until(async () => {
      const r = await room()
      return !r.compact && r.main.width >= 280 && fitsWindow(r)
    }, HUNG_MS)), JSON.stringify(await room()))
    await page.locator('.assistant-rail').click()
    await lib.until(async () => (await page.locator('.assistant-panel').count()) === 1, HUNG_MS)
    check('opened again: folded to the rail again, the work at 280 px or all that is left', !!(await lib.until(async () => {
      const r = await room()
      return r.compact && r.main.width >= least(r) && fitsWindow(r)
    }, HUNG_MS)), JSON.stringify(await room()))

    // Another sidebar view (Notes: no rail) at 150%: the sidebar at its least width, the work takes what is left.
    await page.getByRole('button', { name: 'Notes' }).first().click()
    check('Notes at 150%: the sidebar at 160 px, the panel at 240, the work takes the rest, nothing past the window', !!(await lib.until(async () => {
      const r = await room()
      return r.sidebar.width <= 161 && r.panel.width >= 240 && r.main.width > 100 && fitsWindow(r)
    }, HUNG_MS)), JSON.stringify(await room()))
    await capture('assistant-150-notes')
    await page.getByRole('button', { name: 'Projects' }).first().click()
    await zoomTo(1, 900)
    check('back at 100%: the list, as saved', !!(await lib.until(async () => !(await room()).compact, HUNG_MS)) && JSON.stringify(await saved()) === JSON.stringify(before), JSON.stringify(await saved()))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'ALL PASS')
  process.exit(failed ? 1 : 0)
})()
