// Any dialog moves by its header (#133), as the card dialog does (carddialog checks it in depth): Add Agent and Agent
// Settings move with the pointer, stay inside the window below the title bar however far they're dragged, go back on
// Escape mid-drag, and open centred again next time; a question over the card dialog moves on its own, and Escape
// closes only it; the image viewer (an opt-out, sized to its image) stays put. Pictured in both themes. Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR, the fake Claude Code; quiet, never focused.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'dialogs-profile')
const ws = path.join(lib.WORK, 'dialogs-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  // A session's image, for the Attachments tab's viewer.
  const id = '11111111-aaaa-bbbb-cccc-000000000001'
  fs.mkdirSync(path.join(alpha, '.hive', 'attachments', id), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'attachments', id, '2026-10-05_10-00-00.png'), lib.samplePng(400, 200))
  fs.writeFileSync(path.join(alpha, '.hive', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id, agent: 'claude-code', name: 'Pictures', createdAt: '', lastActiveAt: '', archived: false }] }))
  const claude = lib.fakeClaude(userData, path.join(lib.WORK, 'dialogs-claude-home'), [alpha])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47933), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 820 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()

  const top = () => page.locator('.dialog[role="dialog"]').last()
  const box = (l) => l.boundingBox()
  const titleBarBottom = () => page.locator('.titlebar').evaluate((t) => t.getBoundingClientRect().bottom)
  /** Drags a dialog's header from a point in it by dx, dy (release: false holds the pointer down). */
  const dragBy = async (dialog, dx, dy, release = true) => {
    const h = await box(dialog.locator('.dialog-header'))
    const x = h.x + h.width * 0.35
    const y = h.y + h.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y + (dy * i) / 5)
    if (release) await page.mouse.up()
  }
  const near = (a, b, dx = 0, dy = 0) => Math.abs(b.x - a.x - dx) <= 2 && Math.abs(b.y - a.y - dy) <= 2
  const inWindow = async (dialog) => {
    const h = await box(dialog.locator('.dialog-header'))
    const v = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    return h.x >= -0.5 && h.x + h.width <= v.width + 0.5 && h.y >= (await titleBarBottom()) - 0.5 && h.y + h.height <= v.height + 0.5
  }
  /** The checks every movable dialog gets: moves with the pointer, clamped, Escape mid-drag puts it back. */
  const movesWell = async (name, dialog) => {
    check(`${name}: movable (its header shows the move cursor)`, (await dialog.getAttribute('class')).includes('movable'))
    const start = await box(dialog)
    await dragBy(dialog, -140, 70)
    const moved = await box(dialog)
    check(`${name}: dragging its header moves it with the pointer`, near(start, moved, -140, 70), `${start.x},${start.y} → ${moved.x},${moved.y}`)
    await dragBy(dialog, 3000, -3000)
    check(`${name}: dragged far off, its header stays in the window, below the title bar`, await inWindow(dialog), JSON.stringify(await box(dialog.locator('.dialog-header'))))
    const before = await box(dialog)
    await dragBy(dialog, -200, 150, false)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    const after = await box(dialog)
    check(`${name}: Escape while dragging puts it back and keeps it open`, near(before, after) && (await dialog.count()) === 1, `${before.x},${before.y} → ${after.x},${after.y}`)
    return start
  }

  // --- Add Agent.
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  const add = page.locator('.dialog', { hasText: 'Add an agent' })
  await lib.until(async () => (await add.count()) === 1, 5000)
  const addStart = await movesWell('Add Agent', add)
  await page.screenshot({ path: path.join(lib.WORK, 'dialogs-add-moved.png') })
  await page.keyboard.press('Escape')
  await lib.until(async () => (await add.count()) === 0, HUNG_MS)
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  await lib.until(async () => (await add.count()) === 1, 5000)
  check('Add Agent: opens centred again next time', near(addStart, await box(add)), JSON.stringify(await box(add)))
  await page.keyboard.press('Escape')

  // --- Agent Settings (the footer's model).
  await lib.addAgent(inv, alpha, { name: 'Coder' })
  await lib.until(async () => (await page.locator('.pane-footer-bar .pane-foot-item').count()) > 0, 10000)
  await page.locator('.pane-footer-bar .pane-foot-item').first().click()
  const settings = top()
  await lib.until(async () => (await settings.innerText().catch(() => '')).includes('Model'), 5000)
  await movesWell('Agent Settings', settings)
  // Its fields still take input where they are, after a move. (Its effort picker went to the connection, HI-2108.)
  await dragBy(settings, 120, -40)
  const note = settings.locator('#agent-role')
  const was = await note.inputValue()
  await note.fill('Moved and typed')
  check('Agent Settings: moved, its fields still work', !!(await lib.until(async () => (await note.inputValue()) === 'Moved and typed', HUNG_MS)))
  await note.fill(was)
  await lib.until(async () => (await note.inputValue()) === was, HUNG_MS)
  // Both themes, moved.
  await page.screenshot({ path: path.join(lib.WORK, 'dialogs-settings-moved.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await page.screenshot({ path: path.join(lib.WORK, 'dialogs-settings-moved-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.dialog').count()) === 0, HUNG_MS)

  // --- A question over the card dialog: each moves on its own; Escape closes the top one only.
  await inv('tasks:create', { title: 'Move the question', description: 'Words', project: 'alpha' })
  await page.keyboard.press('Control+Shift+J')
  const tile = page.locator('.task-card', { hasText: 'Move the question' })
  await lib.until(async () => (await tile.count()) === 1, 5000)
  await tile.click()
  const card = page.locator('.dialog[role="dialog"]').first()
  await lib.until(async () => (await card.locator('.task-title-input').count()) === 1, 5000)
  await card.locator('.task-title-input').fill('Move the question, edited')
  await page.keyboard.press('Escape')
  const ask = page.locator('.dialog', { hasText: 'Discard unsaved changes?' })
  await lib.until(async () => (await ask.count()) === 1, 5000)
  const cardAt = await box(card)
  const askAt = await box(ask)
  await dragBy(ask, 110, 60)
  check('a question over a dialog moves on its own', near(askAt, await box(ask), 110, 60) && near(cardAt, await box(card)), JSON.stringify({ ask: await box(ask), card: await box(card) }))
  await page.keyboard.press('Escape')
  const closedTop = !!(await lib.until(async () => (await ask.count()) === 0, HUNG_MS))
  check('…and Escape closes only the question', closedTop && (await card.count()) === 1, JSON.stringify({ ask: await ask.count(), dialogs: await page.locator('.dialog').count(), titles: await page.locator('.dialog-header h2').allInnerTexts() }))
  await page.keyboard.press('Escape')
  await lib.until(async () => (await ask.count()) === 1, HUNG_MS)
  await ask.getByRole('button', { name: 'Discard' }).click()
  await lib.until(async () => (await page.locator('.dialog').count()) === 0, HUNG_MS)

  // --- The image viewer stays put (an opt-out).
  await page.locator('.activity-btn[aria-label="Projects"]').click()
  await page.getByText('alpha', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Attachments' }).click()
  await lib.until(async () => (await page.locator('.thumb').count()) === 1, 10000)
  await page.locator('.thumb').first().click()
  const viewer = top()
  await lib.until(async () => (await viewer.count()) === 1, 5000)
  const vAt = await box(viewer)
  await dragBy(viewer, -150, 80)
  check('the image viewer stays put', !(await viewer.getAttribute('class')).includes('movable') && near(vAt, await box(viewer)), JSON.stringify(await box(viewer)))
  await page.keyboard.press('Escape')

  await app.close()
  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
