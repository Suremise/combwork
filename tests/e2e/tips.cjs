// Tips: the day's tip in a card when Combwork starts (once a day), Next tip, Learn more (the user guide at its
// heading), closing it, a moment's tip once (a second agent), Help → Tips… (grouped, searchable, Try it runs the
// command, Learn more closes it), and Don't show tips. No agents run. Dev build, throwaway profile and workspace with tips turned on.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'tips-profile')
const ws = path.join(lib.WORK, 'tips-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(alpha, { recursive: true })
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  // On, as for a new user (the suites turn tips off by default).
  cfg.settings.general = { ...cfg.settings.general, showTips: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 860 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
    return v
  }
  const card = page.locator('.tip-card')
  const title = () => card.locator('.tip-title').innerText().catch(() => '')
  const saved = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).ui?.tips ?? {}

  // --- The day's tip.
  check('a tip shows when Combwork starts', !!(await until(async () => (await card.count()) === 1, 10000)))
  check('the first tip, numbered', (await title()) === 'Compact with a focus' && /Tip · 1 of \d+/.test(await card.locator('.tip-head').innerText()), await title())
  check('its shortcut is shown', (await card.locator('.tip-text kbd').count()) === 1)
  check('it is not a dialog: the window works around it', (await page.locator('[role="dialog"]').count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'tips-1-card.png') })
  await card.getByRole('button', { name: 'Next tip' }).click()
  check('Next tip shows the next one', !!(await until(async () => (await title()) === 'A long conversation? Hand it over to itself', HUNG_MS)), await title())

  // --- Learn more: the user guide at the tip's heading.
  await card.getByRole('button', { name: 'Learn more' }).click()
  const target = page.locator('.docs-target')
  check('Learn more opens the user guide at its heading', !!(await until(async () => (await target.count()) === 1 && (await target.innerText()).trim() === 'Long conversations', HUNG_MS)))
  // By the heading's explicit id (#1535), its empty anchor not shown: a renamed heading keeps the link.
  check("by the heading's id", (await target.getAttribute('id')) === 'long-conversations' && (await target.locator('a').count()) === 0)
  check('and the card stays beside it', (await card.count()) === 1)
  await page.keyboard.press('Control+Shift+E')
  await card.getByRole('button', { name: 'Close' }).click()
  check('✕ closes the card', !!(await until(async () => (await card.count()) === 0, HUNG_MS)))
  await until(async () => (saved().seen ?? []).length >= 2, HUNG_MS)
  const s1 = saved()
  check('what was shown is remembered', s1.seen?.includes('compact-focus') && s1.seen.includes('handover-self') && /^\d{4}-\d\d-\d\d$/.test(s1.shownOn ?? ''), JSON.stringify(s1))

  // --- A moment: the second agent, once.
  await lib.addAgent(inv, alpha, { name: 'One' })
  await lib.addAgent(inv, alpha, { name: 'Two' })
  check('a second agent brings its tip', !!(await until(async () => (await title()) === 'Several agents side by side', 6000)), await title())
  await page.screenshot({ path: path.join(lib.WORK, 'tips-2-moment.png') })
  await card.getByRole('button', { name: 'Close' }).click()
  await lib.addAgent(inv, alpha, { name: 'Three' })
  await lib.sleep(1500) // A fixed wait on purpose: this checks that the tip does NOT show again, which no condition can show.
  check('only once', (await card.count()) === 0)

  // --- Reloading the window the same day: no tip again.
  await lib.sleep(800)
  await page.reload()
  await lib.sleep(6000) // A fixed wait on purpose: this checks that no tip shows after a reload (one would within 4 s of loading), which no condition can show.
  check('one tip a day: none after a reload', (await card.count()) === 0)

  // --- Help → Tips….
  await page.locator('.menubar-item', { hasText: 'Help' }).first().click()
  await page.locator('.menu .menu-item', { hasText: 'Tips…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Tips' })
  check('Help → Tips… lists them by group', !!(await until(async () => (await dialog.count()) === 1, HUNG_MS)) && (await dialog.locator('h3').count()) >= 5 && (await dialog.locator('.tips-item').count()) >= 25)
  // Narrows them: some, not all (a number fixed here would break with each new tip that mentions worktrees).
  const all = await dialog.locator('.tips-item').count()
  await dialog.getByPlaceholder('Search tips').fill('worktree')
  const found = await dialog.locator('.tips-item').count()
  check('search narrows them', found >= 1 && found < all / 2, `${found} of ${all}`)
  await page.screenshot({ path: path.join(lib.WORK, 'tips-3-dialog.png') })
  await dialog.getByPlaceholder('Search tips').fill('task board')
  await dialog.locator('.tips-item', { hasText: 'Plan work on the task board' }).getByRole('button', { name: 'Try it' }).click()
  check('Try it runs the command (the board opens) and closes the list', !!(await until(async () => (await dialog.count()) === 0 && (await page.locator('h1', { hasText: 'Task Board' }).count()) === 1, HUNG_MS)))

  // --- Learn more from the list: the list closes, and the guide at the heading is in front and usable.
  await page.locator('.menubar-item', { hasText: 'Help' }).first().click()
  await page.locator('.menu .menu-item', { hasText: 'Tips…' }).click()
  await until(async () => (await dialog.count()) === 1, HUNG_MS)
  await dialog.getByPlaceholder('Search tips').fill('quit')
  await dialog.locator('.tips-item', { hasText: 'Quit when agents finish' }).getByRole('button', { name: 'Learn more' }).click()
  check('Learn more closes the list', !!(await until(async () => (await dialog.count()) === 0 && (await page.locator('.overlay').count()) === 0, HUNG_MS)))
  check('and shows the guide at its heading', !!(await until(async () => (await target.count()) === 1 && (await target.innerText()).trim() === 'Quitting' && (await target.isVisible()), HUNG_MS)))
  // Nothing covers it: what's under the heading's middle is the heading.
  const onTop = (await target.count()) === 1 && (await target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
  }))
  check('nothing covers the guide', onTop)

  // --- Don't show tips, from the card.
  await page.keyboard.press('Control+Shift+E')
  await page.locator('.menubar-item', { hasText: 'Help' }).first().click()
  await page.locator('.menu .menu-item', { hasText: 'Tips…' }).click()
  const sw = dialog.getByRole('switch', { name: 'Show a tip when Combwork starts' })
  check('the list has the setting, on', (await sw.getAttribute('aria-checked')) === 'true')
  await dialog.getByRole('button', { name: 'Close' }).last().click()
  // Another window shows the day's tip while this one is still loading (#295): this one's older snapshot mustn't undo
  // it. Its startup is held on a slowed call, and the change comes meanwhile (as R5's probe for #266 did).
  await inv('ui:changeTips', { shownOn: '2000-01-01' })
  await app.evaluate(() => {
    process.env.CW_TEST_SLOW_IPC = 'provider:info=2500*1'
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await lib.sleep(500) // A fixed wait on purpose: the change must come while startup waits on the slowed call (2.5 s).
  const now = new Date()
  await inv('ui:changeTips', { shownOn: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` })
  await lib.appReady(page)
  await lib.sleep(6000) // A fixed wait on purpose: this checks that no tip shows on start (one would within 4 s of loading), which no condition can show.
  check("a tip another window showed while this one loaded counts (none again today)", (await card.count()) === 0)

  // The next day: as if the last tip showed long ago.
  await inv('ui:changeTips', { shownOn: '2000-01-01' })
  await page.reload()
  check('the next day, a tip again', !!(await until(async () => (await card.count()) === 1, 10000)))
  await card.getByRole('button', { name: "Don't show tips" }).click()
  check("Don't show tips closes it and says where they are", !!(await until(async () => (await card.count()) === 0 && (await page.locator('.toast', { hasText: 'Tips are off' }).count()) === 1, HUNG_MS)))
  check('and turns the setting off', !!(await until(async () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).settings.general.showTips === false, HUNG_MS)))
  await inv('ui:changeTips', { shownOn: '2000-01-01' })
  await page.reload()
  await lib.sleep(6000) // A fixed wait on purpose: this checks that no tip shows on start (one would within 4 s of loading), which no condition can show.
  check('with tips off, none shows on start', (await card.count()) === 0)

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
