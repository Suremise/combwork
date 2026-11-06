// Recent workspaces (#144): a folder that no longer exists is greyed with "not found", and opening it offers Remove
// from Recent; an entry is removed with its ✕ or right-click → Remove from Recent, on the welcome page and in File →
// Open Recent; Clear Recently Opened asks, then keeps only the workspace open; a workspace open in another window is
// marked so; every window's list follows a change made in another; and on the welcome page, Enter or Space on an
// entry's ✕ only removes it, while Enter on the entry opens it (#237). Dev build, throwaway profile and workspaces.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'recent-profile')
const [wsA, wsB, wsC] = ['recent-alpha', 'recent-beta', 'recent-gone'].map((n) => path.join(lib.WORK, n))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, wsA, wsB, wsC]) fs.rmSync(d, { recursive: true, force: true })
  for (const w of [wsA, wsB, wsC]) fs.mkdirSync(path.join(w, 'app'), { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47932) } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const recent = async () => (await inv('workspace:recent')).map((r) => path.basename(r.path))
  const shot = (name, p = page) => p.screenshot({ path: path.join(lib.WORK, `recent-${name}.png`) })

  // Three workspaces opened (the last first in the list), then closed: the welcome page lists them.
  for (const w of [wsC, wsB, wsA]) await lib.openWorkspace(inv, page, w)
  await inv('workspace:close')
  check('the three are recent, the last opened first', JSON.stringify(await recent()) === JSON.stringify(['recent-alpha', 'recent-beta', 'recent-gone']), JSON.stringify(await recent()))

  // A folder deleted since: greyed, "not found", still listed (it may come back, as a drive's would).
  fs.rmSync(wsC, { recursive: true, force: true })
  const welcomeEntry = (name) => page.locator('.welcome .recent-item', { hasText: name })
  // Shown again (File → Open Recent asks for the list): whether each folder is there is checked then.
  await page.locator('.menubar-item', { hasText: 'File' }).click()
  await page.locator('.menu-item', { hasText: 'Open Recent' }).hover()
  await page.keyboard.press('Escape')
  await lib.until(async () => (await welcomeEntry('recent-gone').getAttribute('class').catch(() => ''))?.includes('missing'), 10000)
  const gone = welcomeEntry('recent-gone')
  check('a deleted folder is greyed, with "not found"', (await gone.getAttribute('class')).includes('missing') && (await gone.innerText()).includes('not found') && (await gone.getAttribute('title')).includes('Not found'), await gone.innerText())
  check('…and not removed by itself', (await recent()).includes('recent-gone'))
  await shot('welcome-missing')
  // Opening it says so and offers to forget it.
  await gone.click()
  const dialog = page.locator('.dialog', { hasText: 'Workspace folder not found' })
  check('opening it says it can’t be found', !!(await lib.until(() => dialog.isVisible(), 5000)))
  await shot('missing-dialog')
  await dialog.getByRole('button', { name: 'Remove from Recent' }).click()
  check('…and Remove from Recent forgets it', !!(await lib.until(async () => !(await recent()).includes('recent-gone'), 5000)), JSON.stringify(await recent()))

  // Welcome page: ✕ on hover, and right-click → Remove from Recent.
  await welcomeEntry('recent-beta').hover()
  await welcomeEntry('recent-beta').locator('.recent-remove').click()
  check('the ✕ on the welcome page removes an entry', !!(await lib.until(async () => !(await recent()).includes('recent-beta'), 5000)), JSON.stringify(await recent()))
  check('…leaving its folder alone', fs.existsSync(wsB))
  await welcomeEntry('recent-alpha').click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Remove from Recent' }).click()
  check('right-click → Remove from Recent removes one', !!(await lib.until(async () => !(await recent()).includes('recent-alpha'), 5000)), JSON.stringify(await recent()))
  check('the welcome page says there are none', !!(await lib.until(async () => (await page.locator('.welcome', { hasText: 'No recent workspaces.' }).count()) === 1, 5000)))

  // Two windows: alpha open in this one; the other's list marks it, and follows changes made here.
  await lib.openWorkspace(inv, page, wsB)
  await lib.openWorkspace(inv, page, wsA)
  const next = app.waitForEvent('window')
  await inv('window:new')
  const page2 = await next
  await page2.waitForLoadState('domcontentloaded')
  await lib.appReady(page2)
  const entry2 = (name) => page2.locator('.welcome .recent-item', { hasText: name })
  await lib.until(async () => (await entry2('recent-alpha').innerText().catch(() => '')).includes('open in another window'), 10000)
  check('another window marks the workspace open here', (await entry2('recent-alpha').innerText()).includes('open in another window'), await entry2('recent-alpha').innerText().catch(() => ''))

  // File → Open Recent in this window: right-click → Remove from Recent; the other window's list follows.
  const openRecentMenu = async () => {
    await page.locator('.menubar-item', { hasText: 'File' }).click()
    await page.locator('.menu-item', { hasText: 'Open Recent' }).hover()
    await lib.until(async () => (await page.locator('.menu .recent-item').count()) > 0, 5000)
  }
  await openRecentMenu()
  check('File → Open Recent lists them, this window’s first', (await page.locator('.menu .recent-item').allInnerTexts()).map((t) => t.split('\n')[0].trim()).join(',').startsWith('recent-alpha'), JSON.stringify(await page.locator('.menu .recent-item').allInnerTexts()))
  await shot('menu')
  await page.locator('.menu .recent-item', { hasText: 'recent-beta' }).click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Remove from Recent' }).click()
  check('right-click in Open Recent → Remove from Recent removes one', !!(await lib.until(async () => !(await recent()).includes('recent-beta'), 5000)), JSON.stringify(await recent()))
  check('…and the other window’s list follows', !!(await lib.until(async () => (await entry2('recent-beta').count()) === 0, 5000)))

  // The ✕ in the menu, then Clear Recently Opened (asking first), which keeps the workspace open here.
  fs.mkdirSync(path.join(wsC, 'app'), { recursive: true })
  await lib.openWorkspace(inv, page, wsC)
  await lib.openWorkspace(inv, page, wsB)
  await lib.openWorkspace(inv, page, wsA)
  await openRecentMenu()
  const menuEntry = page.locator('.menu .recent-item', { hasText: 'recent-gone' })
  await menuEntry.hover()
  await menuEntry.locator('.recent-remove').click()
  check('the ✕ in Open Recent removes one', !!(await lib.until(async () => !(await recent()).includes('recent-gone'), 5000)), JSON.stringify(await recent()))
  await page.keyboard.press('Escape')
  await openRecentMenu()
  await page.locator('.menu-item', { hasText: 'Clear Recently Opened' }).click()
  const ask = page.locator('.dialog', { hasText: 'Clear recently opened workspaces?' })
  check('Clear Recently Opened asks first', !!(await lib.until(() => ask.isVisible(), 5000)))
  await ask.getByRole('button', { name: 'Clear' }).click()
  check('…then keeps only the workspace open', !!(await lib.until(async () => JSON.stringify(await recent()) === '["recent-alpha"]', 5000)), JSON.stringify(await recent()))
  check('…and the other window’s list follows', !!(await lib.until(async () => (await page2.locator('.welcome .recent-item').count()) === 1, 5000)))

  // The keyboard on the other window's welcome page (#237): Enter or Space on an entry's ✕ removes it and opens nothing
  // (its folder stays); Enter on the entry itself opens it.
  fs.mkdirSync(path.join(wsC, 'app'), { recursive: true })
  for (const w of [wsC, wsB, wsA]) await lib.openWorkspace(inv, page, w)
  await lib.until(async () => (await page2.locator('.welcome .recent-item').count()) === 3, 5000)
  const welcome2 = async () => (await page2.locator('.welcome').count()) === 1
  // As from the keyboard: the entry, then Tab to its ✕ (shown once the entry has the focus).
  await entry2('recent-beta').focus()
  await page2.keyboard.press('Tab')
  check(`Tab from beta's entry reaches its ✕`, await entry2('recent-beta').locator('.recent-remove').evaluate((b) => b === document.activeElement))
  await page2.keyboard.press('Enter')
  check('Enter on an entry’s ✕ removes it', !!(await lib.until(async () => !(await recent()).includes('recent-beta'), 5000)), JSON.stringify(await recent()))
  await lib.sleep(500)
  check('…and opens nothing: the window still shows the welcome page, beta stays forgotten', (await welcome2()) && !(await recent()).includes('recent-beta'), JSON.stringify(await recent()))
  check('…leaving its folder alone', fs.existsSync(wsB))
  // As from the keyboard: the entry, then Tab to its ✕ (shown once the entry has the focus).
  await entry2('recent-gone').focus()
  await page2.keyboard.press('Tab')
  check(`Tab from gone's entry reaches its ✕`, await entry2('recent-gone').locator('.recent-remove').evaluate((b) => b === document.activeElement))
  await page2.keyboard.press('Space')
  check('Space on an entry’s ✕ removes it too, opening nothing', !!(await lib.until(async () => !(await recent()).includes('recent-gone'), 5000)) && (await welcome2()), JSON.stringify(await recent()))
  await lib.openWorkspace(inv, page, wsB)
  await lib.openWorkspace(inv, page, wsA)
  await lib.until(async () => (await entry2('recent-beta').count()) === 1, 5000)
  await entry2('recent-beta').focus()
  await page2.keyboard.press('Enter')
  check('Enter on the entry itself opens it', !!(await lib.until(() => page2.evaluate(() => document.title.includes('recent-beta')).catch(() => false), 10000)), await page2.title())
  await app.close()
  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
