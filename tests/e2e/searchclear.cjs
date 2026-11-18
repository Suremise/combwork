// A clear (×) button in every search and filter box (#433), through the shared SearchInput. The board's search: no ×
// while empty; typing filters the cards and shows the ×, inside the box, its size unchanged; clicking it ("Clear")
// clears the filter as typing would and keeps the focus in the box; Escape with text clears it too. In a dialog (Tips)
// the first Escape clears the box and the second closes the dialog; the same in the command palette. Settings' search
// has it too. Both themes. Dev build, throwaway profile and workspace, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'searchclear-profile')
const ws = path.join(lib.WORK, 'searchclear-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
  lib.enableProviders(userData)
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1300, height: 800 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const until = (fn, ms) => lib.until(fn, ms)
  const shot = async (name) => {
    for (const t of ['dark', 'light']) {
      await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t)
      await lib.sleep(200)
      await page.screenshot({ path: path.join(lib.WORK, `searchclear-${name}-${t}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
  const focused = (input) => input.evaluate((el) => document.activeElement === el)

  // --- The board's search.
  await inv('tasks:create', { title: 'Login form errors', project: 'alpha' })
  await inv('tasks:create', { title: 'Password reset', project: 'alpha' })
  await page.getByRole('button', { name: 'Task Board' }).click()
  const box = page.locator('.board-search .search-box')
  const input = box.locator('input')
  const clear = box.getByRole('button', { name: 'Clear' })
  const tiles = page.locator('.task-card')
  await until(async () => (await tiles.count()) === 2, HUNG_MS)
  check('an empty search box has no ×', (await box.count()) === 1 && (await clear.count()) === 0 && (await input.getAttribute('data-clearable')) !== null)
  const size = async () => {
    const b = await input.boundingBox()
    return b && `${Math.round(b.width)}x${Math.round(b.height)}`
  }
  const empty = await size()
  await input.fill('login')
  check('typing filters the cards and shows the ×, named "Clear"', !!(await until(async () => (await tiles.count()) === 1, HUNG_MS)) && (await clear.count()) === 1)
  const cb = await clear.boundingBox()
  const ib = await input.boundingBox()
  check('…inside the box, on its right, the box the same size', !!cb && !!ib && cb.x > ib.x + ib.width / 2 && cb.x + cb.width <= ib.x + ib.width && cb.y >= ib.y && cb.y + cb.height <= ib.y + ib.height && (await size()) === empty, JSON.stringify({ cb, ib, empty, now: await size() }))
  await clear.hover()
  check('…its tooltip says Clear', !!(await until(async () => (await page.locator('.tip', { hasText: /^Clear$/ }).count()) > 0, HUNG_MS)))
  await shot('board')
  await clear.click()
  check('clicking it clears the box and the filter, and the focus stays in the box', (await input.inputValue()) === '' && !!(await until(async () => (await tiles.count()) === 2, HUNG_MS)) && (await clear.count()) === 0 && (await focused(input)))
  await input.fill('password')
  await until(async () => (await tiles.count()) === 1, HUNG_MS)
  await input.press('Escape')
  check('Escape with text clears it too, keeping the focus', (await input.inputValue()) === '' && !!(await until(async () => (await tiles.count()) === 2, HUNG_MS)) && (await focused(input)))

  // --- In a dialog: the first Escape clears the box, the second closes the dialog.
  await page.keyboard.press('Control+Shift+P')
  const palette = page.locator('.palette')
  await until(async () => (await palette.count()) === 1, HUNG_MS)
  const paletteInput = palette.locator('.search-box input')
  await paletteInput.fill('zzz nothing')
  check('the palette has the × too', (await palette.getByRole('button', { name: 'Clear' }).count()) === 1)
  await page.keyboard.press('Escape')
  check('in the palette, the first Escape clears what is typed and keeps it open', (await palette.count()) === 1 && (await paletteInput.inputValue()) === '')
  await page.keyboard.press('Escape')
  check('…and the second closes it', !!(await until(async () => (await palette.count()) === 0, HUNG_MS)))
  await page.keyboard.press('Control+Shift+P')
  await until(async () => (await palette.count()) === 1, HUNG_MS)
  await paletteInput.fill('Tips…')
  await page.keyboard.press('Enter')
  const tips = page.locator('.dialog', { has: page.locator('.tips-top') })
  await until(async () => (await tips.count()) === 1, HUNG_MS)
  const tipsInput = tips.locator('.search-box input')
  await tipsInput.fill('worktree')
  check('the Tips dialog has the ×', (await tips.getByRole('button', { name: 'Clear' }).count()) === 1)
  await page.keyboard.press('Escape')
  check('in a dialog, the first Escape clears the box and keeps the dialog', (await tips.count()) === 1 && (await tipsInput.inputValue()) === '')
  await page.keyboard.press('Escape')
  check('…and the second closes the dialog', !!(await until(async () => (await tips.count()) === 0, HUNG_MS)))

  // --- Settings' search.
  await page.keyboard.press('Control+,')
  const settingsBox = page.locator('.settings-top .search-box')
  await until(async () => (await settingsBox.count()) === 1, HUNG_MS)
  await settingsBox.locator('input').fill('theme')
  check("Settings' search has the ×", (await settingsBox.getByRole('button', { name: 'Clear' }).count()) === 1)
  await shot('settings')
  await settingsBox.getByRole('button', { name: 'Clear' }).click()
  check('…which clears it', (await settingsBox.locator('input').inputValue()) === '')

  await app.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
