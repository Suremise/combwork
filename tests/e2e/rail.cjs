// Compact Projects sidebar: toggle, snap by dragging, persistence, tooltips, context menu.
// Throwaway profile and workspace; no sessions started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'rail-profile')
const ws = path.join(scratch, 'rail-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
for (const n of ['hive', 'web-dashboard', 'apiServer', 'notes']) fs.mkdirSync(path.join(ws, n), { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
/** Whether fn() comes true (checked until it does, up to HUNG_MS). */
const becomes = async (fn) => !!(await lib.until(fn, HUNG_MS))
;(async () => {
  lib.enableProviders(userData)
  const env = lib.combworkEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws); await sleep(800)
  await inv('project:setActive', path.join(ws, 'hive'), true)
  await inv('project:setActive', path.join(ws, 'web-dashboard'), true)
  const sbWidth = () => page.locator('.sidebar').first().evaluate((e) => Math.round(e.getBoundingClientRect().width)).catch(() => -1)
  // The two active projects are listed first once the workspace has them.
  await lib.until(async () => (await page.locator('.project-row:not(.inactive)').count()) === 2 && (await page.locator('.project-row').count()) === 4, HUNG_MS)

  check('starts full', (await sbWidth()) === 280 && (await page.locator('.rail').count()) === 0)
  await page.locator('.pane-header .icon-btn[aria-label^="Compact Sidebar"]').first().click()
  check('button compacts', await becomes(async () => (await sbWidth()) === 48 && (await page.locator('.rail').count()) === 1), `(${await sbWidth()})`)
  // Each tile shows its project's key (#1221), given from the folder's name.
  const keysShown = ['HI', 'WE', 'AP', 'NO']
  const labels = await lib.until(async () => { const l = await page.locator('.rail-initials').allTextContents(); return JSON.stringify(l) === JSON.stringify(keysShown) && l }, HUNG_MS) || (await page.locator('.rail-initials').allTextContents())
  check('the tiles show the projects’ keys', JSON.stringify(labels) === JSON.stringify(keysShown), JSON.stringify(labels))
  // 3- and 4-letter keys shrink to fit: the tiles keep their size and the rail its width (#1221). Screenshots of 2, 3
  // and 4 letters, in both themes.
  const tileSize = () => page.locator('.rail-project').evaluateAll((els) => els.map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`).join(' '))
  const sizesBefore = await tileSize()
  await inv('project:setKey', path.join(ws, 'web-dashboard'), 'WEB')
  await inv('project:setKey', path.join(ws, 'apiServer'), 'APIS')
  const longKeys = ['HI', 'WEB', 'APIS', 'NO']
  check('a changed key shows on its tile', await becomes(async () => JSON.stringify(await page.locator('.rail-initials').allTextContents()) === JSON.stringify(longKeys)), JSON.stringify(await page.locator('.rail-initials').allTextContents()))
  const fits = await page.locator('.rail-initials').evaluateAll((els) => els.map((e) => ({ text: e.textContent, inside: e.scrollWidth <= e.parentElement.clientWidth, cls: e.className })))
  check('3 and 4 letters fit their tile, smaller', fits.every((f) => f.inside) && /rail-initials-3/.test(fits[1].cls) && /rail-initials-4/.test(fits[2].cls) && !/rail-initials-\d/.test(fits[0].cls), JSON.stringify(fits))
  check('…without changing the tiles or the rail', (await tileSize()) === sizesBefore && (await sbWidth()) === 48, `${sizesBefore} → ${await tileSize()}, ${await sbWidth()}`)
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.locator('.rail').screenshot({ path: path.join(scratch, `rail-keys-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  check('separator between active and other', (await page.locator('.rail-sep').count()) === 1)
  check('saved', await becomes(async () => (await inv('ui:get')).sidebarCompact === true))

  await page.locator('.rail-project').nth(1).click()
  check('click selects project', await becomes(() => page.locator('.rail-project').nth(1).evaluate((e) => e.classList.contains('selected'))))
  // A tip shows after its delay (ui.tsx): wait for it, not for the delay.
  await page.locator('.rail-project').nth(0).hover()
  const tipText = () => page.locator('.tip').first().textContent({ timeout: 1000 }).catch(() => '').then((t) => t ?? '')
  const tip = (await lib.until(async () => { const t = await tipText(); return /hive/.test(t) && /No session/.test(t) && t }, HUNG_MS)) || (await tipText())
  check('tooltip shows name and status', /hive/.test(tip) && /No session/.test(tip), JSON.stringify(tip))
  await page.screenshot({ path: path.join(scratch, 'rail-1-tip.png') })
  await page.mouse.move(700, 400)
  await page.locator('.rail-project').nth(0).click({ button: 'right' })
  check('context menu', await becomes(() => page.getByText('Resume Last Session').first().isVisible()))
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.getByText('Resume Last Session').count()) === 0, HUNG_MS)

  // Other panels stay full width while compact is on
  await page.locator('.activity-btn[aria-label="Shared Notes"]').click()
  check('notes full width', await becomes(async () => (await sbWidth()) === 280))
  await page.locator('.activity-btn[aria-label="Projects"]').click()
  check('back to rail', await becomes(async () => (await sbWidth()) === 48))

  // Drag out restores; drag in snaps
  const drag = async (dx) => {
    const b = await page.locator('.sidebar-resizer').boundingBox()
    const x = b.x + b.width / 2, y = b.y + 300
    await page.mouse.move(x, y); await page.mouse.down()
    await page.mouse.move(x + dx / 2, y, { steps: 4 }); await page.mouse.move(x + dx, y, { steps: 4 })
    await page.mouse.up()
  }
  await drag(250)
  check('drag out expands', await becomes(async () => (await sbWidth()) === 298 && (await inv('ui:get')).sidebarCompact === false), `(${await sbWidth()})`)
  await drag(-230)
  check('drag in snaps to rail', await becomes(async () => (await sbWidth()) === 48 && (await inv('ui:get')).sidebarCompact === true), `(${await sbWidth()})`)

  // Keyboard shortcut
  await page.keyboard.press('Control+Alt+B')
  check('Ctrl+Alt+B expands to the earlier width', await becomes(async () => (await sbWidth()) === 298), `(${await sbWidth()})`)
  await page.keyboard.press('Control+Alt+B')
  check('Ctrl+Alt+B compacts', await becomes(async () => (await sbWidth()) === 48))

  // Persists across reload
  await page.reload(); await lib.appReady(page)
  check('kept after reload', (await sbWidth()) === 48)

  // Count badges and status dots stick out of the tiles: fully visible (outline included) inside the scrolling list,
  // and a badge clear of the dot of the tile above, at the zoom levels Combwork offers and with a two-digit count.
  await page.evaluate(() => {
    document.querySelectorAll('.rail-project').forEach((t, i) => {
      const b = document.createElement('span')
      b.className = 'project-need-count'
      b.textContent = i === 1 ? '12' : '1'
      t.appendChild(b)
    })
  })
  for (const zoom of [1, 1.25, 1.5]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await sleep(400)
    const bad = await page.evaluate(() => {
      const list = document.querySelector('.rail-list').getBoundingClientRect()
      const out = (r, pad) => r.top - pad < list.top - 0.5 || r.bottom + pad > list.bottom + 0.5 || r.left - pad < list.left - 0.5 || r.right + pad > list.right + 0.5
      const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      const tiles = [...document.querySelectorAll('.rail-project')]
      const problems = []
      tiles.forEach((t, i) => {
        const badge = t.querySelector('.project-need-count').getBoundingClientRect()
        const dot = t.querySelector('.dot').getBoundingClientRect()
        // The 2px outline each has, in CSS pixels (zoom scales both alike).
        if (out(badge, 2)) problems.push(`badge ${i} clipped`)
        if (out(dot, 2) && i < 2) problems.push(`dot ${i} clipped`)
        if (i > 0) {
          const above = tiles[i - 1].querySelector('.dot').getBoundingClientRect()
          const grown = { left: above.left - 2, right: above.right + 2, top: above.top - 2, bottom: above.bottom + 2 }
          if (overlap({ left: badge.left - 2, right: badge.right + 2, top: badge.top - 2, bottom: badge.bottom + 2 }, grown)) problems.push(`badge ${i} on dot ${i - 1}`)
        }
      })
      return problems
    })
    check(`badges and dots fully visible and apart at ${zoom * 100}%`, bad.length === 0, JSON.stringify(bad))
    if (zoom === 1.5) await page.screenshot({ path: path.join(scratch, 'rail-badges-150.png'), clip: { x: 0, y: 0, width: 160, height: 320 } })
    if (zoom === 1) await page.screenshot({ path: path.join(scratch, 'rail-badges.png'), clip: { x: 0, y: 0, width: 120, height: 260 } })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await page.evaluate(() => document.querySelectorAll('.rail-project .project-need-count').forEach((b) => b.remove()))
  await page.screenshot({ path: path.join(scratch, 'rail-2.png') })
  await page.locator('.rail-btn[aria-label="Expand Sidebar"]').click()
  check('expand button', await becomes(async () => (await sbWidth()) > 200))
  await page.screenshot({ path: path.join(scratch, 'rail-3-full.png') })

  // Light theme look
  await page.keyboard.press('Control+Alt+B'); await sleep(300)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' }); await sleep(300)
  await page.screenshot({ path: path.join(scratch, 'rail-4-light.png') })

  await app.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
