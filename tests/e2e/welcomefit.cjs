// The welcome page in a narrow window (#265): at 800 px with the sidebar open, in both themes and at 125% zoom, with
// recent workspaces whose paths are long, nothing makes the page wider than its area. Tabbing to an entry and its ✕
// doesn't scroll it sideways, the hero and the entries' names stay readable (a long path shortens first; a name too
// long for the row shortens, its tooltip whole), and the ✕ stays inside the page and shows its focus. Dev build, throwaway profile and workspaces.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'welcomefit-profile')
const base = path.join(lib.WORK, 'welcomefit-ws')
const deep = path.join(base, 'a-rather-long-folder-name-for-workspaces', 'another-long-folder-name-under-it', 'and-one-more-level')
const workspaces = [path.join(deep, 'beta'), path.join(deep, 'alpha'), path.join(base, 'a-workspace-whose-own-name-is-quite-long-indeed')]
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, base]) fs.rmSync(d, { recursive: true, force: true })
  for (const w of workspaces) fs.mkdirSync(path.join(w, 'app'), { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 800, height: 850 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  for (const w of workspaces) await lib.openWorkspace(inv, page, w)
  await inv('workspace:close')
  await lib.until(async () => (await page.locator('.welcome .recent-item').count()) === 3, lib.timing('hang.ui'))
  // The sidebar open, as the review found it.
  const sidebarOpen = async () => (await page.locator('.sidebar').count()) === 1 && (await page.locator('.sidebar').isVisible())
  if (!(await sidebarOpen())) await page.keyboard.press('Control+B')
  check('the sidebar is open beside the welcome page', await sidebarOpen())

  /** What overflows, and what isn't readable, on the page as it is now. */
  const measure = () =>
    page.evaluate(() => {
      const w = document.querySelector('.welcome')
      const box = w.getBoundingClientRect()
      const inside = (el) => {
        const r = el.getBoundingClientRect()
        return r.left >= box.left - 0.5 && r.right <= box.right + 0.5
      }
      const names = [...document.querySelectorAll('.welcome .recent-item')].map((row) => {
        const name = row.querySelector('.recent-name')
        return { text: name.textContent, whole: name.scrollWidth <= name.clientWidth + 1, shown: name.clientWidth, inside: inside(name), tip: row.title }
      })
      return {
        scrollWidth: w.scrollWidth,
        clientWidth: w.clientWidth,
        scrollLeft: w.scrollLeft,
        hero: inside(document.querySelector('.welcome-hero h1')) && inside(document.querySelector('.welcome-hero p')),
        headings: [...document.querySelectorAll('.welcome h3')].every(inside),
        names
      }
    })

  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.themeShown(page, theme)
    for (const zoom of [1, 1.25]) {
      // Drawn at the zoom and settled (its layout after the change).
      await lib.zoomTo(app, page, zoom)
      const label = `${theme}, ${zoom * 100}%`
      const m = await measure()
      check(`${label}: the page is no wider than its area`, m.scrollWidth <= m.clientWidth, JSON.stringify({ scrollWidth: m.scrollWidth, clientWidth: m.clientWidth }))
      check(`${label}: the hero and headings are inside it`, m.hero && m.headings, JSON.stringify(m))
      // Short names are whole; a name too long for the row shortens, keeping most of the row and the full path in its tooltip.
      check(`${label}: short names are whole, and every name is inside`, m.names.every((n) => n.inside && (n.text.length > 30 || n.whole)), JSON.stringify(m.names))
      check(`${label}: a long name shows whole or most of it, the tooltip has it all`, m.names.every((n) => n.whole || (n.shown >= 150 && n.tip.includes(n.text))), JSON.stringify(m.names))
      // Tab to the first entry, then its ✕: focus moves, the page doesn't scroll sideways, and the ✕ is inside it.
      await page.locator('.welcome .recent-item').first().focus()
      await page.keyboard.press('Tab')
      const focused = await page.evaluate(() => {
        const el = document.activeElement
        const r = el.getBoundingClientRect()
        const box = document.querySelector('.welcome').getBoundingClientRect()
        return { remove: el.classList.contains('recent-remove'), inside: r.left >= box.left && r.right <= box.right, outline: getComputedStyle(el).outlineStyle, visible: getComputedStyle(el).visibility }
      })
      const after = await measure()
      check(`${label}: Tab reaches the ✕, shown with its focus ring, inside the page`, focused.remove && focused.inside && focused.visible === 'visible' && focused.outline !== 'none', JSON.stringify(focused))
      check(`${label}: …and nothing scrolls sideways`, after.scrollLeft === 0, String(after.scrollLeft))
      await page.screenshot({ path: path.join(lib.WORK, `welcomefit-${theme}-${zoom * 100}.png`) })
      await page.keyboard.press('Shift+Tab')
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  // Enter on the entry still opens it.
  await page.locator('.welcome .recent-item').first().focus()
  await page.keyboard.press('Enter')
  check('Enter on an entry still opens it', !!(await lib.until(async () => (await inv('workspace:get'))?.path === workspaces[2], lib.timing('hang.ui'))))

  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
