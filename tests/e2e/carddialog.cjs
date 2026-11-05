// An open task card: dragged by its header within the window (its header and × always reachable, below the title
// bar; moved back in when the window shrinks; Escape mid-drag puts it back; reopened in the usual place), its
// buttons, fields and unsaved-edit question working as before. And the native window buttons dimmed with every
// backdrop (a card, a question over it, the command palette) until the last one goes, in either theme, across a
// theme change, maximise/restore and a reload, each window on its own. The buttons' colours are recorded by
// wrapping setTitleBarOverlay in main. Dev build, throwaway profile and workspace.
//
// Maximise and restore are simulated by default: the window takes a screen's work-area size off screen, says it is
// maximised and emits the events Combwork listens for, so the checks of the card and the buttons run quiet. That covers
// Combwork's handling of the events, not Electron's and Windows' own maximise. HIVE_E2E_NATIVE=1 (`node
// tests/e2e/carddialog.cjs` only: the runner drops it) runs the same checks with the real maximize() and unmaximize()
// in a normal, not quiet, window, which comes on screen and takes the focus while it runs.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const NATIVE = process.env.HIVE_E2E_NATIVE === '1'
const userData = path.join(lib.WORK, 'carddialog-profile')
const ws = path.join(lib.WORK, 'carddialog-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 5000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(100)
  return v
}

// The window buttons' colours: the theme's, and dimmed as the backdrops (black at 45% each, stacked) dim them.
const DARK = { color: '#1f1f1f', dim: '#111111', dim2: '#090909' }
const LIGHT = { color: '#f3f3f3', dim: '#868686', dim2: '#4a4a4a' }

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(path.join(ws, 'alpha'))
  if (NATIVE) console.log('Native maximise and restore (HIVE_E2E_NATIVE=1): the test window comes on screen and takes the focus.')
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47895), HIVE_TEST_TIPS: 'off', ...(NATIVE ? { HIVE_TEST_QUIET: '0' } : {}) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 860 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)

  // Every window's button colours, as main sets them.
  const record = () =>
    app.evaluate(({ BrowserWindow }) => {
      globalThis.__tb ??= new Map()
      for (const w of BrowserWindow.getAllWindows()) {
        if (globalThis.__tb.has(w.id)) continue
        globalThis.__tb.set(w.id, [])
        const set = w.setTitleBarOverlay.bind(w)
        w.setTitleBarOverlay = (o) => {
          globalThis.__tb.get(w.id).push(o.color)
          set(o)
        }
      }
    })
  await record()
  const firstId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  // On Windows, maximising always brings the window on screen and to the front, taking the focus from whatever the user
  // is doing (there is no maximise without it), and the test copies never do that (HIVE_TEST_QUIET: their windows stay
  // off screen). So by default the window takes the size of a screen's work area, where it is, as maximising does, and
  // says it is maximised, with the events Combwork listens for. With HIVE_E2E_NATIVE=1, Electron maximises it for real.
  const native = (max) =>
    app.evaluate(
      ({ BrowserWindow }, m) =>
        new Promise((done) => {
          const w = BrowserWindow.getAllWindows()[0]
          if (w.isMaximized() === m) return done(true)
          w.once(m ? 'maximize' : 'unmaximize', () => done(w.isMaximized() === m))
          if (m) w.maximize()
          else w.unmaximize()
          setTimeout(() => done(w.isMaximized() === m), 3000)
        }),
      max
    )
  const maximise = async () => {
    if (NATIVE) return check('native: maximize() maximises the window', await native(true))
    await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const b = w.getBounds()
      globalThis.__restoreBounds = b
      const area = screen.getPrimaryDisplay().workArea
      w.setBounds({ x: b.x, y: b.y, width: area.width, height: area.height })
      w.isMaximized = () => true
      w.emit('maximize')
    })
  }
  const unmaximise = async () => {
    if (NATIVE) return check('native: unmaximize() restores the window', await native(false))
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.isMaximized = () => false
      w.setBounds(globalThis.__restoreBounds)
      w.emit('unmaximize')
    })
  }
  /** The colour the window's buttons were last given (null: never changed since recording began). */
  const buttons = (id = firstId) => app.evaluate((_e, i) => globalThis.__tb.get(i)?.at(-1) ?? null, id)
  const buttonsAre = (want, id) => until(async () => (await buttons(id)) === want, HUNG_MS)

  await inv('tasks:create', { title: 'Move me around', description: 'Some words', project: 'alpha' })
  await page.keyboard.press('Control+Shift+J')
  const tile = page.locator('.task-card', { hasText: 'Move me around' })
  await until(async () => (await tile.count()) === 1, HUNG_MS)
  const dialog = page.locator('.dialog[role="dialog"]').first()
  const header = dialog.locator('.dialog-header')
  const open = async () => {
    await tile.click()
    await until(async () => (await dialog.count()) === 1, HUNG_MS)
  }
  const box = (l = dialog) => l.boundingBox()
  /** Backdrops on the page now: each darkens what is under it (the title bar too) once more. */
  const layers = () => page.locator('.overlay').count()
  const titleBarBottom = () => page.locator('.titlebar').evaluate((t) => t.getBoundingClientRect().bottom)
  /** Drags the header from a point in it (a fraction of its width from the left) by dx, dy. */
  const dragBy = async (dx, dy, { at = 0.4, release = true } = {}) => {
    const h = await box(header)
    const x = h.x + h.width * at
    const y = h.y + h.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y + (dy * i) / 5)
    if (release) await page.mouse.up()
  }
  const inWindow = async () => {
    const h = await box(header)
    const v = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    return h.x >= -0.5 && h.x + h.width <= v.width + 0.5 && h.y >= (await titleBarBottom()) - 0.5 && h.y + h.height <= v.height + 0.5
  }

  // --- #88: the native buttons dim with the card, and stay dimmed under a question over it.
  await open()
  check('dark: opening a card dims the window buttons', !!(await buttonsAre(DARK.dim)), await buttons())
  const start = await box()

  // --- #87: dragged by its header.
  await dragBy(-150, 90)
  const moved = await box()
  check('dragging the header moves the card with the pointer', Math.abs(moved.x - start.x + 150) <= 2 && Math.abs(moved.y - start.y - 90) <= 2, `${start.x},${start.y} → ${moved.x},${moved.y}`)
  check('releasing it leaves the card open where it was put', (await dialog.count()) === 1)
  check('dragging selects no text', (await page.evaluate(() => String(getSelection()))) === '')
  check('the header shows it can be moved', (await header.evaluate((h) => getComputedStyle(h).cursor)) === 'move')

  // Far off every edge: the header and its × stay in the window, below the title bar.
  for (const [dx, dy, edge] of [[-3000, -3000, 'top left'], [3000, 3000, 'bottom right'], [3000, -3000, 'top right']]) {
    await dragBy(dx, dy)
    check(`dragged far off the ${edge}: the header stays in the window, below the title bar`, await inWindow(), JSON.stringify(await box(header)))
  }
  const close = dialog.locator('.dialog-header button[aria-label^="Close"]')
  const xBox = await box(close)
  check('in the top right corner the × is clear of the window buttons', xBox.y >= (await titleBarBottom()) - 0.5)

  // Escape mid-drag puts it back, and the card stays open.
  const before = await box()
  await dragBy(-200, 120, { release: false })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  const after = await box()
  check('Escape while dragging puts it back and keeps the card open', (await dialog.count()) === 1 && Math.abs(after.x - before.x) <= 1 && Math.abs(after.y - before.y) <= 1, `${before.x},${before.y} → ${after.x},${after.y}`)

  // Pressing on the × and moving doesn't drag; the header's buttons and the fields work as before.
  const xAt = await box(close)
  await page.mouse.move(xAt.x + xAt.width / 2, xAt.y + xAt.height / 2)
  await page.mouse.down()
  await page.mouse.move(xAt.x - 100, xAt.y + 100, { steps: 4 })
  const still = await box()
  await page.mouse.up()
  check("a press on the × doesn't drag", Math.abs(still.x - after.x) <= 1 && Math.abs(still.y - after.y) <= 1)
  await dialog.locator('.task-title-input').fill('Move me around, edited')
  check('its fields take typing', (await dialog.locator('.task-title-input').inputValue()) === 'Move me around, edited')
  const bodyText = dialog.locator('.dialog-body').first()
  const b = await box(bodyText)
  const placed = await box()
  await page.mouse.move(b.x + 20, b.y + b.height - 12)
  await page.mouse.down()
  await page.mouse.move(b.x + 220, b.y + b.height - 12, { steps: 4 })
  await page.mouse.up()
  const placed2 = await box()
  check('dragging in its body moves nothing', Math.abs(placed2.x - placed.x) <= 1 && Math.abs(placed2.y - placed.y) <= 1)

  // Unsaved edits: closing asks first, over the moved card; keeping editing leaves it where it was.
  await close.click()
  const question = page.locator('.dialog[role="dialog"]', { hasText: 'Discard unsaved changes?' })
  check('closing with an edit asks first', !!(await until(async () => (await question.count()) === 1, HUNG_MS)))
  check('the question over the card: two backdrops, the window buttons dimmed twice like the page', !!(await buttonsAre(DARK.dim2)) && (await layers()) === 2, `${await buttons()} · ${await layers()} backdrops`)
  await question.getByRole('button', { name: 'Keep Editing' }).click()
  await until(async () => (await question.count()) === 0, HUNG_MS)
  const kept = await box()
  check('keeping editing: the card is still open, still where it was put', (await dialog.count()) === 1 && Math.abs(kept.x - placed2.x) <= 1 && Math.abs(kept.y - placed2.y) <= 1)
  check('and the window buttons are dimmed once again (the card is still up)', !!(await buttonsAre(DARK.dim)) && (await layers()) === 1, `${await buttons()} · ${await layers()} backdrops`)

  // The window gets smaller: the card is moved back in.
  await dragBy(3000, 3000)
  await lib.fitWindow(app, page, { width: 900, height: 600 })
  await lib.sleep(400)
  check('the window made smaller: the header is moved back into it', await inWindow(), JSON.stringify(await box(header)))
  await lib.fitWindow(app, page, { width: 1400, height: 860 })

  // The window changes in the middle of a drag, then Escape: back where the drag began, as far as the window allows now.
  const resizes = {
    'made smaller': async () => lib.fitWindow(app, page, { width: 900, height: 600 }),
    'maximised and restored smaller': async () => {
      await maximise()
      await lib.sleep(400)
      await unmaximise()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
    }
  }
  for (const [what, resize] of Object.entries(resizes)) {
    await dragBy(3000, 3000)
    await dragBy(-60, -40, { release: false })
    await resize()
    await lib.sleep(500)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await lib.sleep(200)
    // Maximising can end the drag (the window drops the pointer capture): then Escape closes the card, which asks
    // first (its title is edited). Keep editing.
    if ((await question.count()) === 1) {
      check(`${what} during a drag ended it: Escape asks before closing the edited card`, true)
      await question.getByRole('button', { name: 'Keep Editing' }).click()
      await until(async () => (await question.count()) === 0, HUNG_MS)
    }
    check(`${what} during a drag, then Escape: the card stays open, its header in the window`, (await dialog.count()) === 1 && (await layers()) === 1 && (await inWindow()), JSON.stringify(await box(header)))
    const xNow = await box(close)
    const v = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    check(`${what} during a drag, then Escape: its × is in the window`, xNow.x + xNow.width <= v.w + 0.5 && xNow.y + xNow.height <= v.h + 0.5, JSON.stringify(xNow))
    await lib.fitWindow(app, page, { width: 1400, height: 860 })
    await lib.sleep(300)
  }

  // Maximised and restored: still in the window, the buttons still dimmed.
  await maximise()
  await lib.sleep(500)
  check('maximised: the header in the window, the buttons dimmed', (await inWindow()) && (await buttons()) === DARK.dim)
  await unmaximise()
  await lib.sleep(500)
  check('restored: the same', (await inWindow()) && (await buttons()) === DARK.dim)

  // A theme change while it is open: the new theme's colours, dimmed.
  await inv('settings:update', { appearance: { theme: 'light' } })
  check('light theme while the card is open: dimmed in its colours', !!(await buttonsAre(LIGHT.dim)), await buttons())

  // Discarding closes it: the buttons are the theme's again. The question over it in light: dimmed twice.
  await close.click()
  await until(async () => (await question.count()) === 1, HUNG_MS)
  check('light: the question over the card dims the window buttons twice, like the page', !!(await buttonsAre(LIGHT.dim2)) && (await layers()) === 2, `${await buttons()} · ${await layers()} backdrops`)
  await question.getByRole('button', { name: 'Discard' }).click()
  check('the last dialog closed: the window buttons are bright again', !!(await buttonsAre(LIGHT.color)), await buttons())
  await inv('settings:update', { appearance: { theme: 'dark' } })
  check('dark again, undimmed', !!(await buttonsAre(DARK.color)), await buttons())

  // Reopened: the usual place.
  await open()
  const again = await box()
  check('reopened in the usual place', Math.abs(again.x - start.x) <= 1 && Math.abs(again.y - start.y) <= 1, `${start.x},${start.y} vs ${again.x},${again.y}`)

  // Display scaling (UI zoom 150%): it still follows the pointer and stays in the window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5))
  await lib.sleep(500)
  const z0 = await box()
  await dragBy(-80, 60)
  const z1 = await box()
  check('at 150%: the card follows the pointer', Math.abs(z1.x - z0.x + 80) <= 2 && Math.abs(z1.y - z0.y - 60) <= 2, `${z0.x},${z0.y} → ${z1.x},${z1.y}`)
  await dragBy(3000, 3000)
  check('at 150%: and stays in the window', await inWindow(), JSON.stringify(await box(header)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await lib.sleep(300)

  // A new card is movable too.
  await page.keyboard.press('Escape')
  check('a card without edits closes with Escape, the buttons bright', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)) && !!(await buttonsAre(DARK.color)), await buttons())
  await page.evaluate(() => document.querySelector('.board-column .pane-header button[aria-label="New card"], button[aria-label="New card"]')?.click())
  const fresh = page.locator('.dialog[role="dialog"]', { hasText: 'New Card' })
  if (await until(async () => (await fresh.count()) === 1, HUNG_MS)) {
    const n0 = await box(fresh)
    await dragBy(100, 50)
    const n1 = await box(fresh)
    check('a new card can be moved too', Math.abs(n1.x - n0.x - 100) <= 2 && Math.abs(n1.y - n0.y - 50) <= 2)
    await page.keyboard.press('Escape')
    await until(async () => (await fresh.count()) === 0, HUNG_MS)
  } else check('a new card can be moved too', false, 'no New card button found')

  // --- The command palette is a backdrop too, and over a card two.
  await page.keyboard.press('Control+Shift+P')
  check('the command palette dims the window buttons', !!(await until(async () => (await page.locator('.palette').count()) === 1, HUNG_MS)) && !!(await buttonsAre(DARK.dim)), await buttons())
  await page.keyboard.press('Escape')
  check('closing it brightens them', !!(await buttonsAre(DARK.color)), await buttons())
  await open()
  await buttonsAre(DARK.dim)
  await page.keyboard.press('Control+Shift+P')
  const palette = await until(async () => (await page.locator('.palette').count()) === 1, HUNG_MS)
  if (palette) {
    check('the palette over a card: dimmed twice, like the page', !!(await buttonsAre(DARK.dim2)) && (await layers()) === 2, `${await buttons()} · ${await layers()} backdrops`)
    await page.keyboard.press('Escape')
    await until(async () => (await page.locator('.palette').count()) === 0, HUNG_MS)
    check('Escape closes the palette, not the card under it: dimmed once again', (await page.locator('.palette').count()) === 0 && (await dialog.count()) === 1 && (await layers()) === 1 && !!(await buttonsAre(DARK.dim)), `${await buttons()} · ${await layers()} backdrops · ${await dialog.count()} dialogs`)
  } else check("the palette over a card: it doesn't open there, and the buttons stay dimmed once", (await layers()) === 1 && (await buttons()) === DARK.dim, `${await buttons()} · ${await layers()} backdrops`)
  if ((await dialog.count()) === 1) await page.keyboard.press('Escape')
  check('all closed: bright again', !!(await until(async () => (await layers()) === 0, HUNG_MS)) && !!(await buttonsAre(DARK.color)), `${await buttons()} · ${await layers()} backdrops · ${await dialog.count()} dialogs · history ${await app.evaluate((_e, i) => globalThis.__tb.get(i).slice(-6).join(' '), firstId)}`)

  // --- A reload with a card open doesn't leave them dimmed.
  await open()
  await buttonsAre(DARK.dim)
  await page.reload()
  await lib.appReady(page)
  check('a reload with a card open leaves the window buttons bright', !!(await buttonsAre(DARK.color)), await buttons())

  // --- Each window on its own: a card in one doesn't dim the other's buttons.
  await inv('window:new')
  await until(async () => (await app.windows()).length === 2, 8000)
  await lib.until(async () => { const w = (await app.windows())[1]; return !!w && (await w.evaluate(() => !!document.querySelector('.app .workbench')).catch(() => false)) }, 15000)
  await record()
  const ids = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.id))
  const otherId = ids.find((i) => i !== firstId)
  // Keys go to this page whichever window has the OS focus (the test copies never take it: HIVE_TEST_QUIET).
  await page.keyboard.press('Control+Shift+J')
  await open()
  check('a card in one window dims its buttons', !!(await buttonsAre(DARK.dim)), await buttons())
  check("and not the other window's", (await buttons(otherId)) !== DARK.dim, String(await buttons(otherId)))
  await page.keyboard.press('Escape')
  await buttonsAre(DARK.color)

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
