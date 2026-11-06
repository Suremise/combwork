// The Combwork Assistant's panel on the left or the right (#158): right by default; moved from the command palette, the
// View menu, the panel's ⋯ menu and Settings → Assistant → Panel side. On the left it sits between the project list
// and the main area, is resized from its right edge, folds to its strip there (its arrow pointing the other way), and
// no longer pushes the tip card and toasts away from the bottom-right corner. The choice survives a restart.
// Screenshots in both themes. No agents run. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'assistantside-profile')
const ws = path.join(lib.WORK, 'assistantside-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(path.join(ws, 'alpha'))
  lib.enableProviders(userData)

  const start = async () => {
    const r = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47918) } })
    r.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(r.app, r.page, { width: 1400, height: 850 })
    return r
  }
  let { app, page, inv } = await start()
  await lib.openWorkspace(inv, page, ws)

  /** Where the panel (or its strip), the project list and the main area are. */
  const layout = () =>
    page.evaluate(() => {
      const box = (sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect()
        return r && r.width > 0 ? { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) } : null
      }
      return { panel: box('.assistant-panel'), rail: box('.assistant-rail'), sidebar: box('.sidebar'), main: box('.main-area'), corner: getComputedStyle(document.documentElement).getPropertyValue('--corner-right').trim() }
    })
  const leftOfMain = (l, what) => !!l[what] && !!l.sidebar && !!l.main && l[what].left >= l.sidebar.right - 1 && l[what].right <= l.main.left + 1
  const rightOfMain = (l, what) => !!l[what] && !!l.main && l[what].left >= l.main.right - 1
  const side = async () => (await inv('settings:get')).assistant.panelSide
  const palette = async (q) => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').fill(q)
    await lib.sleep(200)
    return page.locator('.palette-item').allTextContents()
  }

  // --- Right by default.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.until(async () => !!(await layout()).panel, 5000)
  let l = await layout()
  check('by default the panel is on the right, after the main area', rightOfMain(l, 'panel'), JSON.stringify(l))
  check('…and the tip corner keeps left of it', !!(await lib.until(async () => parseInt((await layout()).corner) > l.panel.width, HUNG_MS)), (await layout()).corner)

  // The header's fold button (#1330): its chevron points to the edge the panel folds to.
  const foldIcon = () => page.locator('.assistant-header .assistant-panel-fold .codicon').getAttribute('class')
  check('on the right, its fold button points right', /codicon-chevron-right/.test(await foldIcon()), await foldIcon())

  // --- The palette: "Move Assistant Panel to the Left".
  let items = await palette('move assistant')
  check('the palette offers "Move Assistant Panel to the Left"', items.some((t) => t.includes('Move Assistant Panel to the Left')), JSON.stringify(items))
  await page.locator('.palette-item', { hasText: 'Move Assistant Panel to the Left' }).click()
  await lib.until(async () => leftOfMain(await layout(), 'panel'), 5000)
  l = await layout()
  check('moved: the panel is between the project list and the main area', leftOfMain(l, 'panel'), JSON.stringify(l))
  check('…saved as a setting', (await side()) === 'left')
  check('on the left, its fold button points left', !!(await lib.until(async () => /codicon-chevron-left/.test(await foldIcon()), HUNG_MS)), await foldIcon())
  // The corner is measured on the next frame after the layout changes: wait for it rather than read it at once.
  const corner = await lib.until(async () => ((await layout()).corner === '14px' ? '14px' : null), HUNG_MS)
  check('…and the tip corner is back at the window edge', corner === '14px', (await layout()).corner)

  // Resized from its right edge: dragging it right makes it wider.
  const resizer = page.locator('.assistant-panel > .pane-resizer')
  const rb = await resizer.boundingBox()
  const before = l.panel.width
  await page.mouse.move(rb.x + rb.width / 2, rb.y + 200)
  await page.mouse.down()
  await page.mouse.move(rb.x + rb.width / 2 + 60, rb.y + 200, { steps: 5 })
  await page.mouse.move(rb.x + rb.width / 2 + 120, rb.y + 200, { steps: 5 })
  await page.mouse.up()
  await lib.sleep(200)
  l = await layout()
  check('on the left it is resized from its right edge (dragged right: wider)', Math.abs(l.panel.width - before - 120) <= 4, `${before} → ${l.panel.width}`)
  check('…and the main area gives the room', leftOfMain(l, 'panel'), JSON.stringify(l))
  await page.mouse.move(900, 600)
  await page.screenshot({ path: path.join(lib.WORK, 'assistantside-left-dark.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await page.screenshot({ path: path.join(lib.WORK, 'assistantside-left-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // Folded: its strip stays on the left, its arrow pointing right (to open it).
  // Folded from the header's ⋯ (its Fold the Assistant panel item, #1330's one word for it), then from its button.
  await page.locator('.assistant-header button[aria-label="More"]').click()
  await page.locator('.menu .menu-item', { hasText: 'Fold the Assistant panel' }).click()
  await lib.until(async () => !!(await layout()).rail, 5000)
  l = await layout()
  check('hidden, its strip is on the left too', leftOfMain(l, 'rail'), JSON.stringify(l))
  check("…with the arrow pointing into the window", (await page.locator('.assistant-rail .codicon-chevron-right').count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'assistantside-rail-left.png') })
  await page.locator('.assistant-rail').click()
  await lib.until(async () => !!(await layout()).panel, 5000)
  await page.locator('.assistant-header .assistant-panel-fold').click()
  check('on the left, its fold button folds it to the left strip', !!(await lib.until(async () => leftOfMain(await layout(), 'rail'), HUNG_MS)), JSON.stringify(await layout()))
  await page.locator('.assistant-rail').click()
  await lib.until(async () => !!(await layout()).panel, 5000)

  // --- The View menu says the other way, and moves it back.
  await page.locator('.menubar-item', { hasText: 'View' }).click()
  const viewItems = await page.locator('.menu .menu-item').allTextContents()
  check('View has "Move Assistant Panel to the Right" while it is on the left', viewItems.some((t) => t.includes('Move Assistant Panel to the Right')), JSON.stringify(viewItems))
  await page.locator('.menu .menu-item', { hasText: 'Move Assistant Panel to the Right' }).click()
  await lib.until(async () => rightOfMain(await layout(), 'panel'), 5000)
  check('…which puts it back on the right', rightOfMain(await layout(), 'panel') && (await side()) === 'right')

  // --- The panel's ⋯ menu.
  await page.locator('.assistant-header button[aria-label="More"]').click()
  await page.locator('.menu .menu-item', { hasText: 'Move Panel to the Left' }).click()
  await lib.until(async () => leftOfMain(await layout(), 'panel'), 5000)
  check("the panel's ⋯ menu moves it too", leftOfMain(await layout(), 'panel') && (await side()) === 'left')

  // --- Settings → Assistant → Panel side.
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).click()
  const select = page.locator('.setting', { has: page.locator('.s-title', { hasText: 'Panel side' }) }).locator('select')
  check('Settings → Assistant has Panel side, showing Left', (await select.inputValue().catch(() => '')) === 'left')
  await select.selectOption('right')
  check('…and choosing Right there moves it', !!(await lib.until(async () => rightOfMain(await layout(), 'panel') && (await side()) === 'right', 5000)))
  await select.selectOption('left')
  await lib.until(async () => (await side()) === 'left', 5000)

  // --- After a restart: still on the left.
  await app.close()
  ;({ app, page, inv } = await start())
  await lib.until(async () => (await inv('workspace:get'))?.path?.toLowerCase() === ws.toLowerCase(), 20000)
  check('after a restart it is still on the left', !!(await lib.until(async () => { const x = await layout(); return leftOfMain(x, 'panel') || leftOfMain(x, 'rail') }, 15000)), JSON.stringify(await layout()))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
