// The Notifications bell on the activity bar: muted with nothing unread; with unread notifications it shows its dot
// in the accent (at least 3:1 against the bar, in both themes, at 100% and 150%, on hover and focus) and says how
// many to assistive technology; opening the panel reads them, and only new ones light it again. The status bar
// doesn't change. Notifications arrive as main sends them (a toast event to the window). Dev build, throwaway
// profile; no workspace or agents needed.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
const until = (fn) => lib.until(fn, HUNG_MS, 100)
const userData = path.join(lib.WORK, 'bell-profile')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47897), HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])

  let n = 0
  /** A notification, as main sends one (events.ts toast()). */
  const notify = async () => {
    n++
    await app.evaluate(({ BrowserWindow }, i) => {
      BrowserWindow.getAllWindows()[0].webContents.send('hive:event', { type: 'toast', toast: { id: `t${i}`, level: 'info', title: `Notice ${i}`, timestamp: new Date().toISOString() } })
    }, n)
    await lib.sleep(150)
  }
  const bell = page.locator('.activitybar button[aria-label="Notifications"]')
  /** The bell's state: unread class, icon, what it tells assistive technology, its colour and its contrast with the bar. */
  const state = () =>
    bell.evaluate((b) => {
      const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
      const lum = ([r, g, bl]) => {
        const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl)
      }
      const fg = getComputedStyle(b).color
      const bg = getComputedStyle(b.closest('.activitybar')).backgroundColor
      const [l1, l2] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x)
      const root = getComputedStyle(document.documentElement)
      return {
        unread: b.classList.contains('unread'),
        dot: !!b.querySelector('.codicon-bell-dot'),
        name: b.getAttribute('aria-label'),
        desc: b.getAttribute('aria-description'),
        fg,
        faint: root.getPropertyValue('--fg-faint').trim(),
        contrast: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 10) / 10
      }
    })
  const statusBar = () => page.locator('.statusbar').evaluate((s) => s.outerHTML)
  const hex = (c) => '#' + (c.match(/\d+/g) || []).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')

  // --- Nothing unread: the muted bell.
  const statusBefore = await statusBar()
  let s = await state()
  check('nothing unread: muted, plain bell, no unread status', !s.unread && !s.dot && s.desc === null && hex(s.fg) === s.faint, JSON.stringify(s))

  // --- One, then several.
  await notify()
  s = await state()
  check('one unread: the dot, highlighted, "1 unread"', s.unread && s.dot && s.desc === '1 unread' && s.name === 'Notifications' && hex(s.fg) !== s.faint, JSON.stringify(s))
  await notify()
  await notify()
  s = await state()
  check('three unread: "3 unread"', s.unread && s.desc === '3 unread', JSON.stringify(s))
  check('the status bar is as it was', (await statusBar()) === statusBefore)

  // --- Both themes and a larger UI: clear against the bar, on hover and with keyboard focus too.
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    for (const zoom of [1, 1.5]) {
      await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
      await page.mouse.move(400, 400)
      await lib.sleep(300)
      const rest = await state()
      check(`${theme} ${zoom * 100}%: at least 3:1 against the bar`, rest.unread && rest.contrast >= 3, JSON.stringify(rest))
      await bell.hover()
      const hover = await state()
      check(`${theme} ${zoom * 100}%: the same on hover`, hover.fg === rest.fg, `${hover.fg} vs ${rest.fg}`)
      await page.mouse.move(400, 400)
      await bell.focus()
      const focus = await state()
      check(`${theme} ${zoom * 100}%: the same with focus`, focus.fg === rest.fg, `${focus.fg} vs ${rest.fg}`)
      await page.screenshot({ path: path.join(lib.WORK, `bell-${theme}-${zoom * 100}.png`), clip: { x: 0, y: 0, width: 220, height: 850 } })
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.mouse.move(400, 400)

  // --- Opening the panel reads them; notifications while it is open don't light it.
  await bell.click()
  // Not hovered or focused, so it shows its resting colour.
  await page.mouse.move(400, 400)
  await bell.evaluate((b) => b.blur())
  await lib.sleep(300)
  s = await state()
  check('opened: muted again, no unread status', !s.unread && !s.dot && s.desc === null && hex(s.fg) === s.faint, JSON.stringify(s))
  await notify()
  s = await state()
  check('one arriving while the panel is open: still muted', !s.unread, JSON.stringify(s))
  // Clear all, and close the panel: the old ones don't light it.
  await page.locator('.notif-panel button[aria-label="Clear all"]').click()
  await page.locator('.notif-panel button[aria-label="Close"]').click()
  await lib.sleep(300)
  s = await state()
  check('cleared and closed: muted', !s.unread, JSON.stringify(s))

  // --- New ones after reading light it again, counted from zero.
  await notify()
  s = await state()
  check('a new one after reading: highlighted, "1 unread"', s.unread && s.desc === '1 unread', JSON.stringify(s))
  // Show Notifications (the command) reads them too.
  await page.keyboard.press('Control+Alt+U')
  await lib.sleep(300)
  check('Show Notifications reads them', !(await state()).unread)
  check('the status bar is still as it was', (await statusBar()) === statusBefore)

  // --- HI-2354: Clear all with a pop-up showing (one that needs you, which stays until handled) clears it too: closing
  // the panel brings nothing back, and the panel stays empty.
  // Show Notifications left the panel open: closed with its own button.
  if ((await page.locator('.notif-panel').count()) > 0) await page.locator('.notif-panel button[aria-label="Close"]').click()
  await until(async () => (await page.locator('.notif-panel').count()) === 0)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('hive:event', { type: 'toast', toast: { id: 'stays', kind: 'needsYou', level: 'info', title: 'Waiting for you', timestamp: new Date().toISOString() } })
  })
  const waiting = page.locator('.popups .popup', { hasText: 'Waiting for you' })
  check('a pop-up that needs you shows', !!(await until(async () => (await waiting.count()) === 1)))
  await bell.click()
  await page.locator('.notif-panel button[aria-label="Clear all"]').click()
  await page.locator('.notif-panel button[aria-label="Close"]').click()
  await until(async () => (await page.locator('.notif-panel').count()) === 0)
  check('Clear all, then the panel closed: the pop-up is gone too, not back on screen', (await page.locator('.popups .popup').count()) === 0)
  await bell.click()
  check('…and the panel, opened again, is empty', !!(await until(async () => (await page.locator('.notif-panel .notif-item').count()) === 0 && (await page.locator('.notif-panel .empty-state').count()) === 1)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
