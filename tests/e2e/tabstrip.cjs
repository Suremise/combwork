// A project's tab strip at every width: its nine tabs and More ▾ (#1043) labelled while they fit (Settings opens from the header's ⋯, #974); icons with the active tab's label when
// they don't (switching back only with a little room to spare, so it doesn't flicker); icons only, scrolling with the
// active tab in view, when even that doesn't fit. No tab is ever cut off unless the strip scrolls, at the window's
// minimum width too; icon-only tabs keep their name (tooltip and accessible label) and order, and dragging files over
// the Session tab still switches to it. Light and dark screenshots. The agent runs the fake Claude Code (fake-claude/).
// Opened in a narrow window, the tabs fit at once, with no resize (#812): on Combwork's start with the project restored, on
// switching to another project, and on showing the project again after another view.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'tabstrip-profile')
const ws = path.join(lib.WORK, 'tabstrip-ws')
const claudeHome = path.join(lib.WORK, 'tabstrip-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
// The strip's tabs, then More ▾ (#1043), which shows the name of the tab of its menu that is open.
const LABELS = ['Session', 'Overview', 'Performance', 'Tasks', 'Sessions', 'Files', 'Attachments', 'Version Control', 'Activity', 'More']
const MORE = ['Memory', 'Skills', 'Templates', 'MCP']
const SPARE = 12
let failed = 0
const inv2 = (page, ch, ...a) => page.evaluate(([c, args]) => window.combwork.invoke(c, ...args), [ch, a])
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const HEIGHT = 800
  let viewport = 1700 // wide enough for every label (the 12 tabs need about 1000 px of strip, and 12 more to go back to them)
  const { app, page, inv } = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47914), CLAUDE_CONFIG_DIR: claudeHome }, viewport: { width: viewport, height: HEIGHT } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const strip = page.locator('.tabs')
  await strip.waitFor()

  /** The strip's fit, width, and everything wrong with it for that fit. */
  const inspect = () =>
    strip.evaluate((s, [labels, more]) => {
      const box = s.getBoundingClientRect()
      const tabs = [...s.querySelectorAll('.tab')]
      const bad = []
      const fit = s.dataset.fit
      const active = s.querySelector('.tab.active')
      const shown = (t) => t.querySelector('.tab-label').getBoundingClientRect().width > 2
      if (tabs.length !== labels.length) bad.push(`${tabs.length} tabs`)
      tabs.forEach((t, i) => {
        // Same order, and each keeps its name for screen readers whether or not it shows.
        const name = t.querySelector('.tab-label')?.textContent
        if (name !== labels[i] && !(t.classList.contains('tab-more') && more.includes(name) && t === active)) bad.push(`tab ${i} is ${t.textContent}`)
        if (t.getBoundingClientRect().height !== tabs[0].getBoundingClientRect().height) bad.push(`${labels[i]} has another height`)
        const iconOnly = t.classList.contains('icon-only')
        const want = fit === 'all-icons' || (fit === 'icons' && t !== active)
        if (iconOnly !== want || shown(t) === iconOnly) bad.push(`${labels[i]}: ${iconOnly ? 'icon' : 'label'} (${shown(t) ? 'shown' : 'hidden'}) in ${fit}`)
      })
      const scrolls = s.scrollWidth > s.clientWidth
      if (fit !== 'all-icons') {
        if (scrolls) bad.push(`scrolls in ${fit}: ${s.scrollWidth} > ${s.clientWidth}`)
        for (const t of tabs) {
          const r = t.getBoundingClientRect()
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5) bad.push(`${t.textContent} cut off`)
        }
      }
      // The active tab is always wholly in view.
      const a = active.getBoundingClientRect()
      if (a.left < box.left - 0.5 || a.right > box.right + 0.5) bad.push('the active tab is out of view')
      const measured = [...document.querySelectorAll('.tabs-measure .tab-m')].map((m) => m.getBoundingClientRect().width)
      const sum = (sizes) => Math.ceil(sizes.reduce((x, y) => x + y, 0))
      return { fit, width: s.clientWidth, scrolls, bad, active: active.textContent.trim(), labelsNeed: sum(measured.filter((_, i) => i % 2 === 0)), iconsNeed: sum(measured.filter((_, i) => i % 2 === 1)) }
    }, [LABELS, MORE])
  /** Sizes the page so the strip is `target` CSS pixels wide (Playwright's viewport, which can go below the window's minimum). */
  const widthTo = async (target) => {
    for (let i = 0; i < 8; i++) {
      const w = (await inspect()).width
      if (w === target) return true
      viewport = Math.max(200, viewport + target - w)
      await page.setViewportSize({ width: viewport, height: HEIGHT })
      await lib.sleep(120)
    }
    return (await inspect()).width === target
  }
  const expectFit = async (what, fit) => {
    await lib.sleep(150)
    const r = await inspect()
    check(`${what}: ${fit}, nothing cut off`, r.fit === fit && !r.bad.length, `${r.fit} at ${r.width}px; ${r.bad.join('; ')}`)
    return r
  }
  const shot = (file) => page.screenshot({ path: path.join(lib.WORK, file), clip: { x: 0, y: 0, width: viewport, height: 140 } })

  // --- Wide: every tab labelled.
  const wide = await expectFit('1700 px window', 'labels')
  await shot('tabstrip-1-labels.png')
  const { labelsNeed } = wide

  // --- The switching point, both ways: labels at exactly their width, icons one pixel under, and back only with room to spare.
  check(`strip sized to ${labelsNeed}px`, await widthTo(labelsNeed))
  await expectFit(`exactly the labels' width (${labelsNeed}px)`, 'labels')
  check(`strip sized to ${labelsNeed - 1}px`, await widthTo(labelsNeed - 1))
  await expectFit('one pixel short', 'icons')
  check('the active tab (Session) keeps its label', (await inspect()).active === 'Session')
  await widthTo(labelsNeed)
  await expectFit('back to the labels\' width: no flicker, still', 'icons')
  await widthTo(labelsNeed + SPARE - 1)
  await expectFit('still short of the spare room', 'icons')
  await widthTo(labelsNeed + SPARE)
  await expectFit('with room to spare', 'labels')

  // --- Icons, another tab active: it takes the label, Session gives it up; its tooltip names it with its shortcut.
  await widthTo(Math.round(labelsNeed * 0.75))
  await expectFit('three quarters of the labels\' width', 'icons')
  await page.locator('.tabs .tab', { hasText: 'Performance' }).click()
  const perf = await expectFit('Performance active', 'icons')
  check('Performance has the label now', perf.active === 'Performance', perf.active)
  await shot('tabstrip-2-icons-dark.png')
  await page.locator('.tabs .tab', { hasText: 'Version Control' }).hover()
  const tip = page.locator('.tip')
  check('an icon-only tab\'s tooltip names it', !!(await lib.until(async () => ((await tip.textContent().catch(() => '')) ?? '').startsWith('Version Control'), HUNG_MS)), await tip.textContent().catch(() => ''))
  await page.mouse.move(5, 500)
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await shot('tabstrip-3-icons-light.png')
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // --- Icons only: the active label doesn't fit either; then not even the icons, so it scrolls with the active tab in view.
  const { iconsNeed } = await inspect()
  await widthTo(iconsNeed + 20)
  await expectFit(`${iconsNeed + 20}px: room for the icons but not Performance's label`, 'all-icons')
  await lib.openMoreTab(page, 'MCP')
  // Short of the icons: the strip itself is held narrower, as docked panels would make it. A narrower page no longer gets
  // it there: the work keeps its least width (HI-1737), so with nine tabs the page overflows instead (HI-1844).
  const cap = await page.addStyleTag({ content: `.tabs { max-width: ${iconsNeed - 40}px; }` })
  check('strip held short of the icons', !!(await lib.until(async () => (await inspect()).width === iconsNeed - 40, HUNG_MS)), `${(await inspect()).width}px, the icons need ${iconsNeed}px`)
  const narrow = await expectFit('too narrow even for the icons, MCP (in More ▾, the last) active', 'all-icons')
  check('More ▾ is last and in view, showing MCP', (await inspect()).active === 'MCP' && (await page.locator('.tabs .tab').last().evaluate((t) => t.classList.contains('tab-more'))))
  check('the strip scrolls', narrow.scrolls, `${narrow.width}px wide, the icons need ${iconsNeed}px`)
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().evaluate((t) => t.click())
  await expectFit('Session active (clicked off screen)', 'all-icons')
  check('Session is scrolled into view', (await inspect()).active === 'Session' && !(await inspect()).bad.length)
  await shot('tabstrip-4-scrolls.png')
  await cap.evaluate((s) => s.remove())

  // --- Wider again: labels back.
  viewport = 1700
  await page.setViewportSize({ width: viewport, height: HEIGHT })
  await expectFit('1700 px again', 'labels')

  // --- Project Settings (#974): not a tab; opened from the header's ⋯, it shows with no tab chosen, and a tab leaves it.
  check('no Settings tab in the strip', (await page.locator('.tabs .tab', { hasText: /^\s*Settings\s*$/ }).count()) === 0)
  await lib.openProjectSettings(page)
  check("Project Settings opens from ⋯, with no tab chosen", (await page.locator('.tabs .tab.active').count()) === 0)
  await page.locator('.tabs .tab', { hasText: 'Overview' }).click()
  check('a tab leaves it', !!(await lib.until(async () => (await page.locator('.tabs .tab.active', { hasText: 'Overview' }).count()) === 1 && (await page.locator('.tab-body .settings-top').count()) === 0, HUNG_MS)))
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
  await expectFit('back on Session', 'labels')

  // --- The window at its minimum width, sidebar shown: all twelve tabs on screen, with no scrolling.
  const [minW] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize())
  check('the window has a minimum width', minW > 0, String(minW))
  viewport = minW
  await lib.fitWindow(app, page, { width: minW, height: HEIGHT })
  const atMin = await expectFit(`the window's minimum width (${minW}px)`, 'icons')
  check('no tab is off screen at the minimum width', !atMin.scrolls)
  await shot('tabstrip-5-minimum.png')
  // Hiding the sidebar there gives the strip more room, and the labels if they fit in it.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+B')
  await lib.until(async () => (await inspect()).width > atMin.width, HUNG_MS)
  const noSidebar = await inspect()
  await expectFit(`sidebar hidden at the minimum width (${noSidebar.width}px)`, noSidebar.width >= labelsNeed ? 'labels' : 'icons')
  await page.keyboard.press('Control+B')
  await lib.until(async () => (await inspect()).width === atMin.width, HUNG_MS)
  await expectFit('sidebar shown again', 'icons')

  // --- Dragging files over the (icon-only) Session tab switches to it while an agent runs.
  await lib.addAgent(inv, alpha, { name: 'One' })
  await inv('session:start', alpha, {})
  check('the agent starts', !!(await lib.until(async () => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.status === 'ready'), 20000)))
  await page.locator('.tabs .tab', { hasText: 'Files' }).click()
  await expectFit('Files active', 'icons')
  await page.locator('.tabs .tab').first().evaluate((t) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'drop.txt', { type: 'text/plain' }))
    t.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  check('dragging files over the icon-only Session tab switches to it', !!(await lib.until(async () => (await inspect()).active === 'Session', HUNG_MS)), (await inspect()).active)

  await inv('session:stop', alpha).catch(() => undefined)

  // --- Opened narrow (#812): the fit is right on first show, with no resize to set it. Combwork starts from saved bounds as
  // narrow as it allows (sidebar shown: room for the icons but not the labels, as above), and nothing sizes the window or
  // the page after that (lib.launch would: fitWindow), so only Combwork's own first layout can get the fit right.
  await app.close()
  const narrowBounds = { width: minW, height: HEIGHT, maximized: false }
  const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  saved.window = narrowBounds
  saved.windows = (saved.windows ?? []).map((w) => ({ workspace: w.workspace, ...narrowBounds }))
  fs.writeFileSync(cfgFile, JSON.stringify(saved, null, 2))
  const again = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47914), CLAUDE_CONFIG_DIR: claudeHome }) })
  try {
    const p = await again.firstWindow()
    p.on('pageerror', (e) => check('no page errors (narrow start)', false, e.message))
    await lib.appReady(p)
    const sizes = []
    const fitOf = () => p.evaluate(() => {
      const s = document.querySelector('.tabs')
      return s && s.clientWidth > 0 ? { fit: s.dataset.fit, scrolls: s.scrollWidth > s.clientWidth, width: s.clientWidth, window: innerWidth } : null
    })
    /** Waits for the strip to show `fit` without scrolling; a bound for a hung run, then says what it showed. */
    const fitsAs = async (what, fit) => {
      const ok = await lib.until(async () => { const r = await fitOf(); if (r) sizes.push(r.window); return r && r.fit === fit && !r.scrolls }, HUNG_MS)
      check(`${what}: ${fit}, no scrolling`, !!ok, JSON.stringify(await fitOf()))
    }
    const narrowShot = (file) => p.screenshot({ path: path.join(lib.WORK, file), clip: { x: 0, y: 0, width: sizes[0] ?? minW, height: 140 } })
    await fitsAs('Combwork started narrow with alpha restored', 'icons')
    await narrowShot('tabstrip-6-start-narrow-dark.png')
    await p.getByText('beta', { exact: true }).first().click()
    await lib.until(async () => (await p.locator('.project-header h1').textContent().catch(() => '')) === 'beta', HUNG_MS)
    await fitsAs('switched to beta', 'icons')
    await inv2(p, 'settings:update', { appearance: { theme: 'light' } })
    await lib.until(() => p.evaluate(() => document.documentElement.dataset.theme === 'light'), HUNG_MS)
    await narrowShot('tabstrip-7-beta-narrow-light.png')
    await inv2(p, 'settings:update', { appearance: { theme: 'dark' } })
    // Hidden behind another view (its strip laid out at no width), then shown again.
    await p.locator('.activity-btn[aria-label="Workspace Overview"]').click()
    await lib.until(() => p.evaluate(() => !document.querySelector('.tabs')?.offsetParent), HUNG_MS)
    await p.locator('.activity-btn[aria-label="Projects"]').click()
    await fitsAs('beta shown again after Workspace Overview', 'icons')
    // Nothing resized the window meanwhile: every reading was at the one width it opened at.
    check('the window kept the width it opened at', sizes.length > 0 && sizes.every((w) => w === sizes[0]), sizes.join(', '))

    // --- A window opening on a display smaller than the bounds it starts from (saved on a larger display: #812) fits
    // the display, rather than running off its edge laid out for its full size, labels and all. The display is a stand-in
    // (Electron's screen, answering for a 1000 x 640 one), and the window starts from this one's, made larger.
    const SMALL = { x: 0, y: 0, width: 1000, height: 640 }
    await again.evaluate(({ BrowserWindow, screen }, area) => {
      BrowserWindow.getAllWindows()[0].setSize(1600, 900)
      const display = { ...screen.getPrimaryDisplay(), bounds: area, workArea: area }
      screen.getPrimaryDisplay = () => display
      screen.getAllDisplays = () => [display]
      screen.getDisplayNearestPoint = () => display
    }, SMALL)
    await inv2(p, 'window:new')
    const second = await lib.until(() => again.evaluate(({ BrowserWindow }) => { const all = BrowserWindow.getAllWindows(); return all.length > 1 ? all.reduce((x, y) => (y.id > x.id ? y : x)).getSize() : null }), HUNG_MS)
    check('a window from bounds larger than its display opens fitted to it', !!second && second[0] <= SMALL.width && second[1] <= SMALL.height, JSON.stringify(second))
  } finally {
    await again.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
