// A main area squeezed by the side panels (#227): at 1400×850 and 125% zoom, with the Projects sidebar, a 430 px
// Assistant panel and the Progress panel open, the project view is about 80 px wide. Its empty states (no agents; an
// agent not running, two columns chosen: shown one at a time there, #1037) stay inside it: nothing of the main area is under the pointer anywhere over
// the sidebar, the Assistant or Progress, and the empty state's first button can still be reached by scrolling it into
// view. Assistant on the left and the right, both themes, 100% and 125%. Dev build, throwaway profile and workspace,
// the fake Claude Code (the Assistant's); quiet. Then in German (HI-2536), two stopped agents' panes side by side at
// 900 px and 1400 px keep New Session and Resume without a sideways scrollbar, wrapping them where they don't fit.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'narrowmain-profile')
const ws = path.join(lib.WORK, 'narrowmain-ws')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const p of [alpha, beta]) lib.gitProject(p)
  const claude = lib.fakeClaude(userData, path.join(lib.WORK, 'narrowmain-claude-home'), [ws])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47936), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  // beta: one agent, never started, two columns chosen (its second pane empty where there is room for two).
  await lib.addAgent(inv, beta, { name: 'Coder' })
  await inv('project:updateConfig', beta, { layout: 'columns2' })
  await inv('ui:setPane', 'assistant', 430)
  await inv('ui:setPane', `progress-open:${ws.toLowerCase()}`, 1)
  const zoom = (f) => app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), f)

  /** The panels as laid out, and whatever of the main area is under points spread over the side panels. */
  const probe = () =>
    page.evaluate(() => {
      const main = document.querySelector('.main-area')
      const box = (sel) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.checkVisibility({ visibilityProperty: true }))
        const r = el?.getBoundingClientRect()
        return r && r.width > 0 ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } : null
      }
      const m = box('.main-area')
      const sides = { sidebar: box('.sidebar'), assistant: box('.assistant-panel'), progress: box('.progress-panel') }
      const leaks = []
      for (const [name, r] of Object.entries(sides)) {
        if (!r) continue
        for (let x = r.left + 2; x < r.right - 1; x += 6)
          for (let y = r.top + 2; y < r.bottom - 1; y += 12) {
            const hit = document.elementFromPoint(x, y)
            if (hit && main.contains(hit)) leaks.push(`${name} ${Math.round(x)},${Math.round(y)}: ${hit.tagName}.${String(hit.className).slice(0, 40)}`)
          }
      }
      // Panes side by side: nothing of one under the pointer over the other.
      const panes = [...document.querySelectorAll('.agent-pane')].filter((e) => e.checkVisibility({ visibilityProperty: true }))
      for (const pane of panes) {
        const r = pane.getBoundingClientRect()
        for (let x = r.left + 2; x < r.right - 1; x += 6)
          for (let y = r.top + 2; y < r.bottom - 1; y += 12) {
            const hit = document.elementFromPoint(x, y)
            const other = panes.find((q) => q !== pane && q.contains(hit))
            if (other) leaks.push(`pane ${Math.round(x)},${Math.round(y)}: ${hit.tagName}.${String(hit.className).slice(0, 40)}`)
          }
      }
      return { main: m, panes: panes.length, sides: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, v && Math.round(v.width)])), leaks: leaks.slice(0, 5), leakCount: leaks.length }
    })
  /** Whether the empty state's first button is shown, after scrolling it into view, inside the main area and clickable. */
  const reachable = (selector) =>
    page.evaluate((sel) => {
      const btn = [...document.querySelectorAll(sel)].find((e) => e.checkVisibility({ visibilityProperty: true }))
      if (!btn) return { found: false }
      btn.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = btn.getBoundingClientRect()
      const m = document.querySelector('.main-area').getBoundingClientRect()
      const box = btn.closest('.session-empty, .pane-placeholder')?.getBoundingClientRect() ?? m
      // The middle of the part of it that shows (a button wider than the area shows in part).
      const left = Math.max(r.left, box.left, m.left)
      const right = Math.min(r.right, box.right, m.right)
      const x = (left + right) / 2
      const y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y)
      return { found: true, hits: right > left && !!hit && btn.contains(hit), inMain: right > left && x >= m.left && x <= m.right }
    }, selector)

  /** Whether the empty state's explanation shows. */
  const explanation = () => page.evaluate(() => !![...document.querySelectorAll('.session-empty-card > h2 + p')].find((e) => e.checkVisibility({ visibilityProperty: true })))
  const run = async (label, project, buttons, panes) => {
    await page.locator('.project-row', { hasText: project }).first().click()
    await lib.sleep(500)
    const p = await probe()
    check(`${label}: the main area is squeezed between the panels`, !!p.main && p.main.width < 400 && !!p.sides.assistant && !!p.sides.progress && p.panes === panes, JSON.stringify(p))
    check(`${label}: nothing of the main area over the side panels${panes > 1 ? ', nor of a pane over the other' : ''}`, p.leakCount === 0, JSON.stringify(p))
    for (const [name, sel] of buttons) {
      const r = await reachable(sel)
      check(`${label}: ${name} can be scrolled to and clicked inside its area`, r.found && r.hits && r.inMain, JSON.stringify(r))
    }
    return p
  }

  for (const side of ['left', 'right']) {
    await inv('settings:update', { assistant: { panelSide: side } })
    await page.reload()
    await lib.appReady(page)
    if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
    await lib.until(async () => (await page.locator('.assistant-panel').count()) === 1 && (await page.locator('.progress-panel').count()) === 1, 10000)
    for (const z of [1, 1.25]) {
      await zoom(z)
      await lib.sleep(400)
      const tag = `Assistant ${side}, ${z * 100}%`
      const p = await run(`${tag}, no agents`, 'alpha', [['New Session', '.session-empty-card .btn.act-start']], 1)
      const lead = await explanation()
      const room = await page.evaluate(() => document.querySelector('.session-empty-card')?.parentElement?.getBoundingClientRect().width ?? null)
      check(`${tag}, no agents: the explanation ${p.main.width < 280 ? 'gives way to the title and buttons' : 'shows'}`, lead === p.main.width >= 280, `${lead}; main ${p.main.width}px, the card's room ${room}px`)
      await page.screenshot({ path: path.join(lib.WORK, `narrowmain-${side}-${z * 100}-alpha.png`) })
      // Two columns chosen are too narrow for a terminal here: one at a time, the agent's empty state alone (#1037).
      await run(`${tag}, an agent not running, two columns chosen`, 'beta', [['New Session', '.session-empty-card .btn.act-start']], 1)
      await page.screenshot({ path: path.join(lib.WORK, `narrowmain-${side}-${z * 100}-beta.png`) })
    }
    await zoom(1)
  }
  // Light theme, the tightest case again.
  await inv('settings:update', { appearance: { theme: 'light' } })
  await zoom(1.25)
  await lib.sleep(400)
  await run('light, 125%, no agents', 'alpha', [['New Session', '.session-empty-card .btn.act-start']], 1)
  await page.screenshot({ path: path.join(lib.WORK, 'narrowmain-light-125-alpha.png') })

  // The Assistant's empty state, short of room there, scrolls inside its area: the WORKSPACE section's inactive-projects
  // row is what is under its own middle, nothing of the empty state is over the section or the footer, and Start
  // Assistant, scrolled to, is under the pointer at its middle (HI-2198: centred, it spilled up over the row).
  /** The Assistant's empty state at the least window, or null while the panel isn't there. */
  const assistantIdle = () =>
    page.evaluate(() => {
      const panel = document.querySelector('.assistant-panel')
      const idle = panel?.querySelector('.assistant-idle')
      if (!idle) return null
      const fold = panel.querySelector('.assistant-fold')
      fold?.scrollIntoView({ block: 'nearest' })
      const f = fold?.getBoundingClientRect()
      const hit = f && document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2)
      const over = []
      for (const sel of ['.assistant-top', '.assistant-footer']) {
        const r = panel.querySelector(sel).getBoundingClientRect()
        for (let x = r.left + 2; x < r.right - 1; x += 6)
          for (let y = r.top + 2; y < r.bottom - 1; y += 6) if (idle.contains(document.elementFromPoint(x, y))) over.push(`${sel} ${Math.round(x)},${Math.round(y)}`)
      }
      const btn = idle.querySelector('.btn.act-start')
      btn.scrollIntoView({ block: 'nearest' })
      const b = btn.getBoundingClientRect()
      const onTop = btn.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))
      idle.scrollTop = 0
      return { fold: !!fold, foldOnTop: !!hit && fold.contains(hit), under: hit ? String(hit.className).slice(0, 40) : null, scrolls: idle.scrollHeight > idle.clientHeight + 1, over: over.slice(0, 3), overCount: over.length, startOnTop: onTop }
    })
  await lib.fitWindow(app, page, { width: 900, height: 560 })
  for (const side of ['left', 'right']) {
    await inv('settings:update', { assistant: { panelSide: side } })
    await page.reload()
    await lib.appReady(page)
    await lib.until(async () => (await page.locator(side === 'left' ? '.assistant-panel.on-left' : '.assistant-panel:not(.on-left)').count()) === 1 && (await page.locator('.assistant-idle .btn.act-start').count()) === 1, HUNG_MS)
    for (const z of [1, 1.25]) {
      await zoom(z)
      await lib.until(() => page.evaluate((f) => Math.abs(innerHeight * f - 560) < 2, z), HUNG_MS)
      // As laid out once it holds (the panels settle after a zoom): else its last read.
      let idle = null
      await lib.until(async () => (idle = await assistantIdle()) && idle.fold && idle.foldOnTop && idle.overCount === 0 && idle.startOnTop, HUNG_MS)
      const tag = `least window, Assistant ${side}, ${z * 100}%`
      check(`${tag}: the inactive-projects row is under its own middle, with nothing of the empty state over the workspace or the footer`, !!idle && idle.fold && idle.foldOnTop && idle.overCount === 0, JSON.stringify(idle))
      check(`${tag}: Start Assistant, scrolled to, is on top at its middle`, !!idle && idle.startOnTop, JSON.stringify(idle))
      await page.screenshot({ path: path.join(lib.WORK, `narrowmain-least-assistant-${side}-${z * 100}.png`) })
    }
    await zoom(1)
  }

  // The window at its least (900 × 560, WINDOW_MIN), at 100% and 125%: every activity bar button, Settings last, scrolled
  // into view, is what is under the pointer at its middle (elementFromPoint, no click) and ends above the status bar
  // (HI-1957: thirteen buttons since HI-1664 put Settings under it in a 650 px window; termsize clicks Settings there).
  // Its width is checked too (HI-2180): squeezed for the room, the sidebar's resizer lay over the buttons' middles.
  const activityBar = () =>
    page.evaluate(() => {
      const ab = document.querySelector('.activitybar')
      const status = document.querySelector('.statusbar').getBoundingClientRect()
      const misses = []
      for (const btn of ab.querySelectorAll('.activity-btn')) {
        btn.scrollIntoView({ block: 'nearest' })
        const r = btn.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (!hit || !btn.contains(hit) || r.bottom > status.top + 0.5) misses.push(`${btn.getAttribute('aria-label')} ${Math.round(r.top)}-${Math.round(r.bottom)}${hit && !btn.contains(hit) ? ` under ${String(hit.className).slice(0, 30)}` : ''}`)
      }
      const buttons = ab.querySelectorAll('.activity-btn').length
      const heights = [...ab.querySelectorAll('.activity-btn')].map((b) => Math.round(b.getBoundingClientRect().height))
      ab.scrollTop = 0
      return { buttons, width: Math.round(ab.getBoundingClientRect().width), heights: [...new Set(heights)], misses }
    })
  const whole = (bar) => bar.buttons >= 13 && bar.width === 48 && bar.misses.length === 0
  /** The activity bar once it is whole, as laid out now (the window and its panels settle after a change): else its last read. */
  const wholeBar = async () => {
    let bar = null
    await lib.until(async () => whole((bar = await activityBar())), HUNG_MS)
    return bar
  }
  await lib.fitWindow(app, page, { width: 900, height: 560 })
  for (const z of [1, 1.25]) {
    await zoom(z)
    const zoomed = await lib.until(() => page.evaluate((f) => Math.abs(innerHeight * f - 560) < 2 && devicePixelRatio > 0, z), HUNG_MS)
    const bar = await wholeBar()
    check(`least window, ${z * 100}%: every activity bar button, scrolled to, is on top at its middle, above the status bar`, !!zoomed && whole(bar), JSON.stringify({ zoomed, ...bar }))
    await page.screenshot({ path: path.join(lib.WORK, `narrowmain-least-${z * 100}.png`) })
  }
  // The Projects list expanded from its rail there (the user's Expand Sidebar): the work gives way, never the activity bar.
  await page.locator('.sidebar .rail-btn').first().click()
  const listed = await lib.until(() => page.evaluate(() => !!document.querySelector('.sidebar:not(.compact) .sidebar-resizer')), HUNG_MS)
  check('least window, 125%: Expand Sidebar shows the Projects list, not its rail', !!listed)
  const expanded = await wholeBar()
  check('…and the activity bar keeps its width, every button on top', !!listed && whole(expanded), JSON.stringify(expanded))
  await page.screenshot({ path: path.join(lib.WORK, 'narrowmain-least-125-expanded.png') })
  await lib.fitWindow(app, page, { width: 1400, height: 850 })

  // A roomy window: the empty state is as before, centred and whole, with no scrolling.
  await zoom(1)
  await inv('ui:setPane', `progress-open:${ws.toLowerCase()}`, 0)
  await page.reload()
  await lib.appReady(page)
  await lib.fitWindow(app, page, { width: 1600, height: 900 })
  await page.locator('.project-row', { hasText: 'alpha' }).first().click()
  await lib.sleep(500)
  const roomy = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.session-empty')].find((x) => x.getClientRects().length)
    const c = e?.querySelector('.session-empty-card')?.getBoundingClientRect()
    const r = e?.getBoundingClientRect()
    return e && c ? { scrolls: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1, centred: Math.abs(c.left + c.width / 2 - (r.left + r.width / 2)) < 2, width: Math.round(c.width) } : null
  })
  check('roomy: the empty state is centred, whole, without scrolling', !!roomy && !roomy.scrolls && roomy.centred && roomy.width > 300, JSON.stringify(roomy))
  // "No agents yet" is what shows, not an empty pane's placeholder over it (the reviewer's #158 screenshot had both).
  const shown = await page.evaluate(() => {
    const h = [...document.querySelectorAll('.session-empty-card h2')].find((e) => e.checkVisibility({ visibilityProperty: true }))
    const r = h?.getBoundingClientRect()
    const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { title: h?.textContent ?? null, onTop: !!hit && h.contains(hit), placeholders: [...document.querySelectorAll('.pane-placeholder')].filter((e) => e.checkVisibility({ visibilityProperty: true })).length }
  })
  check('roomy: "No agents yet" is on top, with no empty pane over it', shown.title === 'No agents yet' && shown.onTop && shown.placeholders === 0, JSON.stringify(shown))
  check('…with its explanation', await explanation())
  await page.screenshot({ path: path.join(lib.WORK, 'narrowmain-roomy.png') })
  // For the German panes below: a second agent for beta, and the Assistant and Progress panels closed, as the window
  // HI-2536 was found in.
  await lib.addAgent(inv, beta, { name: 'Reviewer' })
  await inv('ui:setPane', `assistant-open:${ws.toLowerCase()}`, 0)
  await inv('ui:setPane', `progress-open:${ws.toLowerCase()}`, 0)

  await app.close()

  // German, two stopped agents in two columns (HI-2536): "Neue Sitzung" and the split "Fortsetzen" are wider than
  // English, and at 900 px their row made a sideways scrollbar under each pane. They wrap instead: no placeholder
  // scrolls sideways, at 900 px and 1400 px, in both themes.
  const de = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47936), ...claude, HIVE_LANG: 'de' }) })
  try {
    const dpage = await de.firstWindow()
    dpage.on('pageerror', (e) => check('German: no page errors', false, e.message))
    await lib.fitWindow(de, dpage, { width: 900, height: 860 })
    await lib.appReady(dpage)
    const dinv = (ch, ...a) => dpage.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await dpage.locator('.project-row', { hasText: 'beta' }).first().click()
    const placeholders = () =>
      dpage.evaluate(() =>
        [...document.querySelectorAll('.pane-placeholder')]
          .filter((e) => e.checkVisibility({ visibilityProperty: true }) && e.querySelector('.btns'))
          .map((e) => ({ width: e.clientWidth, sideways: e.scrollWidth - e.clientWidth, label: e.querySelector('.act-start')?.textContent?.trim() ?? '' }))
      )
    let seen = []
    const fits = async () => {
      seen = await placeholders()
      return seen.length === 2 && seen.every((x) => x.sideways <= 1 && /Neue Sitzung/.test(x.label))
    }
    for (const width of [900, 1400]) {
      await lib.fitWindow(de, dpage, { width, height: 860 })
      for (const theme of ['light', 'dark']) {
        await dinv('settings:update', { appearance: { theme } })
        check(`German, ${width} px, ${theme}: both stopped agents' panes keep their buttons without a sideways scrollbar`, !!(await lib.until(fits, HUNG_MS, 150)), JSON.stringify(seen))
        await dpage.screenshot({ path: path.join(lib.WORK, `narrowmain-de-panes-${width}-${theme}.png`) })
      }
    }
  } finally {
    await de.close()
  }
  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
