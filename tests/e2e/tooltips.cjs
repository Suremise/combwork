// Tooltips appear next to their anchor everywhere, including at the window's right edge (#257): they used to be
// shifted left as if every tooltip were 380 px wide, so the Notifications panel's ✕ showed "Close" over the first
// notification. Hovers real buttons near the edges (the Notifications panel, the title bar, the status bar, the
// Assistant panel's header on the right and on the left), at 100% and 125% zoom, in both themes, and checks each
// tooltip is beside its anchor (left- or right-aligned, below or above) and inside the window. Dev build, throwaway
// profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'tooltips-profile')
const ws = path.join(lib.WORK, 'tooltips-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(path.join(ws, 'alpha'))
  lib.enableProviders(userData)

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47923) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)

  /** Hovers the element and measures its tooltip, its anchor (the tooltip's wrapper) and the window. */
  const hover = async (locator, shot) => {
    await page.mouse.move(700, 450)
    await lib.until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
    await locator.hover()
    const shown = await lib.until(() => page.evaluate(() => {
      const t = document.querySelector('.tip')
      return !!t && getComputedStyle(t).visibility === 'visible'
    }), HUNG_MS)
    if (!shown) return null
    const geo = await locator.evaluate((el) => {
      const r = (b) => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom })
      return { anchor: r(el.closest('.tip-wrap').getBoundingClientRect()), tip: r(document.querySelector('.tip').getBoundingClientRect()), text: document.querySelector('.tip').innerText, view: { width: innerWidth, height: innerHeight } }
    })
    if (shot) await page.screenshot({ path: path.join(lib.WORK, `tooltips-${shot}.png`) })
    await page.mouse.move(700, 450)
    return geo
  }
  const near = (a, b) => Math.abs(a - b) <= 2
  /** Beside its anchor (aligned with one of its sides, just below or above it) and at least 8 px inside the window. */
  const beside = async (name, locator, expect = {}) => {
    const g = await hover(locator, expect.shot)
    if (!g) return check(`${name}: its tooltip shows`, false)
    const { anchor: a, tip: t, view: v } = g
    const inside = t.left >= 7.5 && t.top >= 7.5 && t.right <= v.width - 7.5 && t.bottom <= v.height - 7.5
    // Aligned with a side of its anchor, or held 8 px inside the window when the anchor is closer to the edge than that.
    const aligned = near(t.left, a.left) || near(t.right, a.right) || (near(t.left, 8) && a.left < 10) || (near(t.right, v.width - 8) && a.right > v.width - 10)
    const vertical = near(t.top, a.bottom + 8) || near(t.bottom, a.top - 8)
    const detail = `"${g.text.slice(0, 40)}" tip ${JSON.stringify(t)} anchor ${JSON.stringify(a)} view ${v.width}×${v.height}`
    check(`${name}: its tooltip is beside it and inside the window`, inside && aligned && vertical, detail)
    if (expect.rightAligned) check(`${name}: … right-aligned with it (within 2 px)`, near(t.right, a.right), detail)
    if (expect.above) check(`${name}: … above it`, near(t.bottom, a.top - 8), detail)
    return g
  }

  for (const [zoom, theme] of [[1, 'dark'], [1.25, 'light']]) {
    const at = `${zoom * 100}% ${theme}`
    await inv('settings:update', { appearance: { theme } })
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await lib.sleep(300)

    // The Notifications panel's ✕ and Clear all, the report's case.
    if ((await page.locator('.notif-panel').count()) === 0) await page.locator('.activity-btn[aria-label="Notifications"]').click()
    await lib.until(async () => (await page.locator('.notif-panel').count()) === 1, HUNG_MS)
    const close = page.locator('.notif-panel button[aria-label="Close"]')
    const closeBox = await close.boundingBox()
    const g = await beside(`${at}: Notifications ✕`, close, { rightAligned: closeBox && closeBox.x + closeBox.width > (await page.evaluate(() => innerWidth)) - 200, shot: `notifications-${theme}` })
    if (g) check(`${at}: … not far left of it (it was up to 380 px)`, g.anchor.right - g.tip.right <= 2 && g.tip.left > g.anchor.left - 120, JSON.stringify(g))
    await beside(`${at}: Notifications Clear all`, page.locator('.notif-panel button[aria-label="Clear all"]'))
    await close.click()

    // The title bar's Always on Top, left of the window controls.
    await beside(`${at}: title bar Always on Top`, page.locator('.titlebar-pin'))

    // Every status bar item: at the bottom, so above, and the long ones (providers) inside the window.
    const items = page.locator('.statusbar .tip-wrap > *:first-child')
    const n = await items.count()
    check(`${at}: the status bar has tooltips`, n > 0)
    for (let i = 0; i < n; i++) {
      const item = items.nth(i)
      if (!(await item.isVisible())) continue
      await beside(`${at}: status bar item ${i + 1}`, item, { above: true })
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))

  // The Assistant panel's header on the right, then on the left (#158).
  for (const side of ['right', 'left']) {
    await inv('settings:update', { assistant: { panelSide: side } })
    await page.reload()
    await lib.appReady(page)
    if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
    const header = page.locator('.assistant-header .tip-wrap > *:first-child')
    check(`Assistant panel on the ${side}: it shows, with its header buttons`, !!(await lib.until(async () => (await header.count()) > 0, 10000)))
    const count = await header.count()
    for (const i of [...new Set([0, count - 1])]) {
      if (await header.nth(i).isVisible()) await beside(`Assistant panel on the ${side}: header item ${i + 1} of ${count}`, header.nth(i), { shot: `assistant-${side}-${i + 1}` })
    }
  }

  // HI-2084: a hover tooltip whose anchor goes (its panel folded from the keyboard, the mouse still on it) lets go of
  // the hover slot as it unmounts, with no other tooltip shown after it: nothing keeps the detached anchor.
  const held = () => page.evaluate(() => window.__hiveHoveredTip())
  const button = page.locator('.assistant-header .tip-wrap > *:first-child').first()
  check('a hover tooltip: none holds the slot before', (await held()) === null, JSON.stringify(await held()))
  await page.mouse.move(700, 450)
  await button.hover()
  const up = await lib.until(() => page.evaluate(() => {
    const t = document.querySelector('.tip')
    return !!t && getComputedStyle(t).visibility === 'visible'
  }), HUNG_MS)
  check("…its tooltip shows, holding the slot with its anchor in the page", !!up && JSON.stringify(await held()) === '{"connected":true}', JSON.stringify(await held()))
  await page.keyboard.press('Control+Alt+I')
  check('…its panel folded from the keyboard, the mouse not moved', !!(await lib.until(async () => (await page.locator('.assistant-panel').count()) === 0, HUNG_MS)))
  check('…its anchor gone, the slot is let go (no detached anchor kept) and no tooltip shows', !!(await lib.until(async () => (await held()) === null, HUNG_MS)) && (await page.locator('.tip').count()) === 0, JSON.stringify(await held()))

  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
