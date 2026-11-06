// Always on Top (#156): the title bar's pin, View → Always on Top, the palette and Ctrl+Alt+O all toggle the window and
// show the same state; two windows keep their own; the pin is remembered by workspace and comes back after a restart;
// the welcome page and a workspace never pinned are off. Dev build, throwaway profile and workspaces.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright-core')

const userData = path.join(lib.WORK, 'pin-profile')
const wsA = path.join(lib.WORK, 'pin-ws-a')
const wsB = path.join(lib.WORK, 'pin-ws-b')
const PORT = lib.port(47926)
const TITLED = ['website', 'cli', 'mobile-app']
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

async function start() {
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: PORT })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  app.on('window', (p) => p.on('pageerror', (e) => check('no page errors', false, e.message)))
  return app
}
const invOn = (page) => (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
/** The window's real state (Combwork asks Electron), and what its title bar shows. */
const onTop = (page) => invOn(page)('window:getAlwaysOnTop')
const pinLit = async (page) => (await page.locator('.titlebar-pin.on').count()) === 1 && (await page.locator('.titlebar-pin').getAttribute('aria-pressed')) === 'true'
const both = async (page, on) => (await onTop(page)) === on && (await pinLit(page)) === on

;(async () => {
  for (const d of [userData, wsA, wsB]) fs.rmSync(d, { recursive: true, force: true })
  for (const ws of [wsA, wsB]) fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
  // Titles whose text is a fractional width, each cut by a pixel's rounding before HI-2319.
  for (const n of TITLED) fs.mkdirSync(path.join(wsA, n), { recursive: true })
  lib.enableProviders(userData, [])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', reopenLastWorkspace: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let app = await start()
  const p1 = await app.firstWindow()
  await lib.fitWindow(app, p1, { width: 1300, height: 800 })
  await lib.appReady(p1)
  const inv1 = invOn(p1)

  // --- A welcome window pinned by hand stays pinned while another window opens and refreshes a workspace.
  check('the welcome page starts off', await both(p1, false))
  await p1.locator('.titlebar-pin').click()
  check('the welcome window can be pinned', !!(await lib.until(() => both(p1, true), 5000)))
  const other = app.waitForEvent('window')
  await inv1('window:new')
  const pw = await other
  await pw.waitForLoadState('domcontentloaded')
  await lib.appReady(pw)
  const invW = invOn(pw)
  await lib.openWorkspace(invW, pw, wsB)
  await invW('workspace:refresh')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that the other window's workspace events do NOT unpin it.
  check("another window opening and refreshing a workspace leaves the pinned welcome window on top, its pin lit", await both(p1, true))
  check('…and that window starts off', await both(pw, false))
  await pw.evaluate(() => window.combwork.invoke('window:close')).catch(() => undefined)
  await lib.until(() => app.windows().length === 1, 10000)
  await p1.locator('.titlebar-pin').click()
  check('unpinned again', !!(await lib.until(() => both(p1, false), 5000)))

  await lib.openWorkspace(inv1, p1, wsA)
  check('a workspace never pinned: off, the pin not lit', await both(p1, false))

  // --- HI-2319: a title with room is shown in full, at 100% and at fractional zooms (its width is fractional).
  const titleCut = () =>
    p1.evaluate(() => {
      const t = document.querySelector('.titlebar-title')
      if (!t || !t.style.maxWidth) return null
      const r = document.createRange()
      r.selectNodeContents(t)
      return { text: t.textContent, textW: r.getBoundingClientRect().width, boxW: t.getBoundingClientRect().width }
    })
  for (const zoom of [1, 1.1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    for (const n of TITLED) {
      await p1.locator('.project-row', { hasText: n }).first().click()
      let seen = null
      const whole = await lib.until(async () => {
        seen = await titleCut()
        return !!seen && seen.text.startsWith(`${n} — `) && seen.textW <= seen.boxW + 0.01
      }, 5000)
      check(`at ${zoom * 100}% zoom, the title "${n} — …" has room and is shown in full`, !!whole, JSON.stringify(seen))
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))

  // --- The title bar's pin.
  await p1.locator('.titlebar-pin').click()
  check('the pin turns it on, and lights', !!(await lib.until(() => both(p1, true), 5000)))
  // The tooltip hides on the click: away and back again to show it.
  await p1.mouse.move(600, 400)
  await p1.locator('.titlebar-pin').hover()
  check('its tooltip says on, with the shortcut', !!(await lib.until(async () => /Always on Top \(on\)\s+Ctrl\+Alt\+O/.test((await p1.locator('.tip').textContent().catch(() => '')) ?? ''), 5000)), await p1.locator('.tip').textContent().catch(() => ''))
  await p1.mouse.move(600, 400)
  await p1.screenshot({ path: path.join(lib.WORK, 'pin-1-on.png'), clip: { x: 0, y: 0, width: 1300, height: 120 } })

  // --- View → Always on Top: checked while on, and it turns it off.
  await p1.locator('.menubar-item', { hasText: 'View' }).first().click()
  const item = p1.locator('.menu .menu-item', { hasText: 'Always on Top' })
  check('View → Always on Top is checked', (await item.locator('.codicon-check').count()) === 1)
  check('…with its shortcut', /Ctrl\+Alt\+O/.test((await item.textContent()) ?? ''), await item.textContent())
  await p1.screenshot({ path: path.join(lib.WORK, 'pin-2-menu.png') })
  await item.click()
  check('the menu turns it off', !!(await lib.until(() => both(p1, false), 5000)))
  await p1.locator('.menubar-item', { hasText: 'View' }).first().click()
  check('…and then it is not checked', (await p1.locator('.menu .menu-item', { hasText: 'Always on Top' }).locator('.codicon-check').count()) === 0)
  await p1.keyboard.press('Escape')

  // --- Ctrl+Alt+O.
  await p1.locator('.titlebar-title').click({ force: true }).catch(() => undefined)
  await p1.keyboard.press('Control+Alt+O')
  check('Ctrl+Alt+O turns it on', !!(await lib.until(() => both(p1, true), 5000)))
  await p1.keyboard.press('Control+Alt+O')
  check('…and off', !!(await lib.until(() => both(p1, false), 5000)))

  // --- The palette: a check while on.
  // Opened only once the last one has closed, and searched once its input has the focus: typed into too early, the
  // search lost letters and the row wasn't found (a flake seen in a --repeat 3 run, #191).
  const palette = async () => {
    const input = p1.locator('.palette input')
    await lib.until(async () => (await input.count()) === 0, 5000)
    await p1.keyboard.press('Control+Shift+P')
    await lib.until(async () => (await input.count()) === 1 && (await input.evaluate((e) => e === document.activeElement).catch(() => false)), 5000)
    await input.fill('Always on Top')
    return p1.locator('.palette-item', { hasText: 'Always on Top' }).first()
  }
  let row = await palette()
  check('the palette offers it, unchecked while off', (await row.locator('.codicon-check').count()) === 0)
  await p1.keyboard.press('Enter')
  check('the palette turns it on', !!(await lib.until(() => both(p1, true), 5000)))
  row = await palette()
  check('…and shows it checked', !!(await lib.until(async () => (await row.locator('.codicon-check').count()) === 1, 5000)))
  // #172: the open palette's check follows a change made elsewhere, without closing it.
  await inv1('window:setAlwaysOnTop', false)
  check('a change while the palette is open clears its check there', !!(await lib.until(async () => (await both(p1, false)) && (await row.locator('.codicon-check').count()) === 0, 5000)))
  await inv1('window:setAlwaysOnTop', true)
  check('…and sets it again', !!(await lib.until(async () => (await both(p1, true)) && (await row.locator('.codicon-check').count()) === 1, 5000)))
  check('…with the palette still open on the same search', (await p1.locator('.palette input').inputValue()) === 'Always on Top')
  // The palette's first Escape clears what was typed (#433), the next closes it.
  await p1.keyboard.press('Escape')
  if (await p1.locator('.palette').count()) await p1.keyboard.press('Escape')

  // --- A second window: its own pin.
  const next = app.waitForEvent('window')
  await inv1('window:new')
  const p2 = await next
  await p2.waitForLoadState('domcontentloaded')
  await lib.appReady(p2)
  const inv2 = invOn(p2)
  check('a new window (the welcome page) is off', await both(p2, false))
  await lib.openWorkspace(inv2, p2, wsB)
  check('…and so is a workspace never pinned in it', await both(p2, false))
  check('the first window is still on', await both(p1, true))
  await p2.locator('.titlebar-pin').click()
  await lib.until(() => both(p2, true), 5000)
  await p2.locator('.titlebar-pin').click()
  check('pinning and unpinning the second leaves the first on', (await lib.until(() => both(p2, false), 5000)) && (await both(p1, true)))

  // --- Remembered by workspace, in Combwork's own config (never the workspace's .combwork).
  await lib.until(() => (JSON.parse(fs.readFileSync(cfgFile, 'utf8')).alwaysOnTop ?? {})[wsA.toLowerCase()] === true, 5000)
  const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).alwaysOnTop ?? {}
  check("config.json remembers A's pin only", saved[wsA.toLowerCase()] === true && !(wsB.toLowerCase() in saved), JSON.stringify(saved))
  const inCombwork = [wsA, wsB].some((ws) => fs.readdirSync(path.join(ws, '.combwork'), { recursive: true }).some((f) => /alwaysOnTop/.test(fs.statSync(path.join(ws, '.combwork', String(f))).isFile() ? fs.readFileSync(path.join(ws, '.combwork', String(f)), 'utf8') : '')))
  check("…and no workspace's .combwork does", !inCombwork)

  // --- The welcome page is off; the workspace's pin comes back with it.
  await inv1('workspace:close')
  check('closing the workspace (the welcome page): off', !!(await lib.until(() => both(p1, false), 5000)))
  await lib.openWorkspace(inv1, p1, wsA)
  check('opening it again: on', !!(await lib.until(() => both(p1, true), 5000)))

  // --- Quit and start again: each window comes back with its own pin.
  const exited = app.waitForEvent('close', { timeout: 20000 }).then(() => true).catch(() => false)
  await inv1('app:quit').catch(() => undefined)
  check('Combwork quits', await exited)
  app = await start()
  await app.firstWindow()
  await lib.until(async () => {
    const pages = app.windows()
    if (pages.length < 2) return false
    const paths = await Promise.all(pages.map((pg) => invOn(pg)('workspace:get').then((w) => w?.path ?? null).catch(() => null)))
    return paths.every(Boolean)
  }, 60000)
  const byWs = {}
  for (const pg of app.windows()) byWs[(await invOn(pg)('workspace:get')).path.toLowerCase()] = pg
  const a = byWs[wsA.toLowerCase()]
  const b = byWs[wsB.toLowerCase()]
  check('after a restart, A is on top again, its pin lit', !!a && !!(await lib.until(() => both(a, true), 10000)))
  check('…and B is not', !!b && (await both(b, false)))

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
