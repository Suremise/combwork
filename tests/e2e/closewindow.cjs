// File → Close Window and File → Exit with one window and with several. Close Window (menu, palette, Ctrl+Shift+W)
// does what the window's X does: on the last window it quits (asking first), with several it closes that window,
// asking about its workspace's agents only. With several windows Exit reads "Exit Hive (all windows)", its dialog
// says it closes them all and lists the agents by workspace, and "Close this window only" closes just that window
// (its agents stop, the other window's keep running). With busy agents that dialog keeps every control inside it, at
// 100% and 125%; from the unsaved-files question that comes first, Close this window only still asks about that
// window's agents. Two workspaces with the same folder name are listed apart (by full path, with the parent folder
// that tells them apart, readable at 4.5:1 in both themes). Close Workspace's tooltip says the window stays open. The
// agents run the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspaces and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'closewindow-profile')
const wsA = path.join(lib.WORK, 'closewindow-ws-a')
const wsB = path.join(lib.WORK, 'closewindow-ws-b')
const claudeHome = path.join(lib.WORK, 'closewindow-claude-home')
const alpha = path.join(wsA, 'alpha')
const beta = path.join(wsB, 'beta')
// Two more workspaces with the same folder name, "work" (#209).
const wsDup1 = path.join(lib.WORK, 'closewindow-dup-1', 'work')
const wsDup2 = path.join(lib.WORK, 'closewindow-dup-2', 'work')
const gamma = path.join(wsDup1, 'gamma')
const delta = path.join(wsDup2, 'delta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const invOn = (page) => (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])

;(async () => {
  for (const d of [userData, wsA, wsB, path.dirname(wsDup1), path.dirname(wsDup2), claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.gitProject(gamma)
  lib.gitProject(delta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha, beta, gamma, delta].map((p) => p.toLowerCase())))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  // Always ask before stopping a session, and closing the last window quits rather than going to the tray.
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'always', closeToTray: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page: p1, inv: inv1 } = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47915), CLAUDE_CONFIG_DIR: claudeHome } })
  app.on('window', (p) => p.on('pageerror', (e) => check('no page errors', false, e.message)))
  p1.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv1, p1, wsA)

  /** Starts a project's (new) agent and waits until it is ready: its id, or null. */
  const startAgent = async (inv, project, name = 'One') => {
    const a = await lib.addAgent(inv, project, { name })
    await inv('session:start', project, { agentId: a.id })
    const ready = await lib.until(async () => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === project.toLowerCase() && s.agentId === a.id && s.status === 'ready'), 20000)
    return ready ? a.id : null
  }
  /** Runs `fn` on the BrowserWindow showing workspace folder `name` (its title names it; every window has the same URL). */
  const onWindow = (name, fn) => app.evaluate(({ BrowserWindow }, [n, f]) => new Function('w', f)(BrowserWindow.getAllWindows().find((w) => w.getTitle().includes(n))), [name, fn])
  const liveIn = async (inv, project) => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === project.toLowerCase())
  /** The File menu's items in a window: [label, shortcut, tooltip]. */
  const fileMenu = async (page) => {
    await page.locator('.menubar-item', { hasText: 'File' }).click()
    const items = await page.locator('.menu .menu-item').evaluateAll((els) => els.map((e) => [e.querySelector('span')?.textContent ?? '', e.querySelector('.menu-key')?.textContent ?? '', e.getAttribute('title') ?? '']))
    return items
  }
  const closeMenu = (page) => page.keyboard.press('Escape')
  const clickMenu = async (page, label) => {
    await page.locator('.menubar-item', { hasText: 'File' }).click()
    await page.locator('.menu .menu-item', { hasText: label }).click()
  }
  /** The palette's commands matching `q`, in a window. */
  const palette = async (page, q) => {
    await invOn(page)('app:quitState') // a round trip, so the page is idle
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').fill(q)
    await lib.sleep(150)
    return page.locator('.palette-item').allTextContents()
  }
  /** The quit or close dialog in a window: its title, workspace groups, rows and buttons (null if none). */
  const dialogIn = (page) =>
    page
      .evaluate(() => {
        const d = [...document.querySelectorAll('.dialog')].find((x) => x.querySelector('.quit-agents'))
        if (!d) return null
        return {
          title: d.getAttribute('aria-label') ?? '',
          text: d.querySelector('.dialog-body p')?.textContent ?? '',
          groups: [...d.querySelectorAll('.quit-group')].map((g) => g.textContent.trim()),
          // Each row with the workspace heading above it.
          unsaved: d.querySelectorAll('.quit-unsaved .quit-row').length,
          // The agents' table (#572): a heading row per workspace, then its agents' rows, the project in the second cell.
          rows: [...(d.querySelector('.quit-agents tbody')?.children ?? [])].reduce((acc, el) => (el.classList.contains('quit-group') ? { ws: el.textContent.trim(), list: acc.list } : { ws: acc.ws, list: [...acc.list, `${acc.ws}|${el.children[1]?.textContent.trim()}`] }), { ws: '', list: [] }).list,
          buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)
        }
      })
      .catch(() => null)
  const waitDialog = (page, ms = 8000) => lib.until(() => dialogIn(page), ms)
  const cancel = async (page) => {
    await page.locator('.dialog button', { hasText: 'Cancel' }).click()
    await lib.until(async () => !(await dialogIn(page)), HUNG_MS)
  }

  // --- One window.
  check('an agent runs in A', await startAgent(inv1, alpha))
  let menu = await fileMenu(p1)
  await closeMenu(p1)
  const labels = menu.map((m) => m[0])
  check('File has Close Window just above Exit', labels.indexOf('Close Window') >= 0 && labels.indexOf('Close Window') === labels.indexOf('Exit') - 1, JSON.stringify(labels))
  check('Close Window shows Ctrl+Shift+W', menu.find((m) => m[0] === 'Close Window')?.[1] === 'Ctrl+Shift+W', JSON.stringify(menu.find((m) => m[0] === 'Close Window')))
  check('with one window, Exit is plain "Exit"', labels.includes('Exit') && !labels.some((l) => /all windows/.test(l)))
  check("Close Workspace's tooltip says the window stays open", /window stays open/.test(menu.find((m) => m[0] === 'Close Workspace')?.[2] ?? ''), menu.find((m) => m[0] === 'Close Workspace')?.[2])
  check('the palette has File: Close Window', (await palette(p1, 'close window')).some((t) => t.includes('File: Close Window')))
  // The palette's first Escape clears what was typed (#433), the next closes it.
  await p1.keyboard.press('Escape')
  if (await p1.locator('.palette').count()) await p1.keyboard.press('Escape')

  // Close Window on the last window: as its X, it quits (asking first). Cancelled both ways: the same dialog.
  await clickMenu(p1, 'Close Window')
  const lastByMenu = await waitDialog(p1)
  check('Close Window on the last window asks to quit, as X does', lastByMenu?.title === 'Quit Combwork?' && lastByMenu.rows.length === 1, JSON.stringify(lastByMenu))
  check('…with no "Close this window only" (one window)', !!lastByMenu && !lastByMenu.buttons.some((b) => /this window only/.test(b)), JSON.stringify(lastByMenu?.buttons))
  await cancel(p1)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  const lastByX = await waitDialog(p1)
  check("the window's X shows the same dialog", JSON.stringify(lastByX) === JSON.stringify(lastByMenu), JSON.stringify(lastByX))
  await cancel(p1)
  check('cancelled: still running', (await inv1('window:count')) === 1 && (await liveIn(inv1, alpha)))

  // --- Two windows: B opens in a second one, with its own agent.
  const openWindow = async (fromInv, ws) => {
    const next = app.waitForEvent('window')
    await fromInv('window:new')
    const p = await next
    await p.waitForLoadState('domcontentloaded')
    await lib.appReady(p)
    await lib.fitWindow(app, p, { width: 1400, height: 850 })
    await lib.openWorkspace(invOn(p), p, ws)
    return p
  }
  const openB = () => openWindow(inv1, wsB)
  let p2 = await openB()
  let inv2 = invOn(p2)
  check('an agent runs in B', await startAgent(inv2, beta))
  check('Hive counts two windows', !!(await lib.until(async () => (await inv1('window:count')) === 2, HUNG_MS)))
  menu = await fileMenu(p1)
  await closeMenu(p1)
  const exit = menu.find((m) => m[0].startsWith('Exit'))
  check('with two windows, Exit reads "Exit Hive (all windows)"', exit?.[0] === 'Exit Hive (all windows)', JSON.stringify(exit))
  check('…and its tooltip says it closes both', /all 2 windows/.test(exit?.[2] ?? ''), exit?.[2])
  check('the palette says so too', (await palette(p1, 'exit')).some((t) => t.includes('File: Exit Hive (all windows)')))
  // The palette's first Escape clears what was typed (#433), the next closes it.
  await p1.keyboard.press('Escape')
  if (await p1.locator('.palette').count()) await p1.keyboard.press('Escape')

  // Close Window in B from the menu, the palette and the X: the same "Close this window?" for B's agent alone.
  await clickMenu(p2, 'Close Window')
  const closeByMenu = await waitDialog(p2)
  check("Close Window (menu) with two windows asks about this window's agents only", closeByMenu?.title === 'Close this window?' && closeByMenu.rows.length === 1, JSON.stringify(closeByMenu))
  await cancel(p2)
  await palette(p2, 'close window')
  await p2.locator('.palette-item', { hasText: 'File: Close Window' }).click()
  const closeByPalette = await waitDialog(p2)
  check('Close Window (palette) shows the same dialog', JSON.stringify(closeByPalette) === JSON.stringify(closeByMenu), JSON.stringify(closeByPalette))
  await cancel(p2)
  await onWindow('closewindow-ws-b', 'w.close()')
  const closeByX = await waitDialog(p2)
  check("B's X shows the same dialog", JSON.stringify(closeByX) === JSON.stringify(closeByMenu), JSON.stringify(closeByX))
  await cancel(p2)
  check('cancelled: both windows and agents still there', (await inv1('window:count')) === 2 && (await liveIn(inv1, alpha)) && (await liveIn(inv1, beta)))

  // Ctrl+Shift+W, confirmed: B closes, its agent stops, A's keeps running.
  await p2.evaluate(() => document.activeElement?.blur())
  await p2.keyboard.press('Control+Shift+W')
  check('Ctrl+Shift+W asks the same', JSON.stringify(await waitDialog(p2)) === JSON.stringify(closeByMenu))
  const closedB = p2.waitForEvent('close', { timeout: 15000 }).then(() => true).catch(() => false)
  await p2.locator('.dialog button', { hasText: /Close window/ }).last().click()
  check('…and closes B when confirmed', await closedB)
  check("B's agent stopped, A's runs on", !!(await lib.until(async () => !(await liveIn(inv1, beta)), 5000)) && (await liveIn(inv1, alpha)))
  check('one window again: Exit is plain "Exit"', !!(await lib.until(async () => { const m = await fileMenu(p1); await closeMenu(p1); return m.some((x) => x[0] === 'Exit') }, HUNG_MS)))

  // --- Exit with two windows: says it closes both, groups the agents by workspace; "Close this window only".
  p2 = await openB()
  inv2 = invOn(p2)
  check('an agent runs in B again', await startAgent(inv2, beta, 'Two'))
  await clickMenu(p1, 'Exit Hive (all windows)')
  const asked = await lib.until(async () => ((await dialogIn(p1)) ? p1 : (await dialogIn(p2)) ? p2 : null), 8000)
  const quit = asked ? await dialogIn(asked) : null
  check('Exit asks in one window', !!quit)
  check('its title says it closes all 2 windows', quit?.title === 'Quit Combwork and close all 2 windows?', quit?.title)
  check('its text says every workspace', /closes all 2 windows and stops/.test(quit?.text ?? '') && /every workspace/.test(quit?.text ?? ''), quit?.text)
  check('the agents are grouped by workspace', JSON.stringify([...(quit?.groups ?? [])].sort()) === JSON.stringify(['closewindow-ws-a', 'closewindow-ws-b']), JSON.stringify(quit?.groups))
  check('…each under its own', JSON.stringify([...(quit?.rows ?? [])].sort()) === JSON.stringify(['closewindow-ws-a|alpha', 'closewindow-ws-b|beta']), JSON.stringify(quit?.rows))
  check('it offers "Close this window only"', !!quit?.buttons.some((b) => b.includes('Close this window only')), JSON.stringify(quit?.buttons))
  if (asked) await asked.screenshot({ path: path.join(lib.WORK, 'closewindow-exit-dark.png') })
  if (asked) {
    await invOn(asked)('settings:update', { appearance: { theme: 'light' } })
    await lib.sleep(300)
    await asked.screenshot({ path: path.join(lib.WORK, 'closewindow-exit-light.png') })
    await invOn(asked)('settings:update', { appearance: { theme: 'dark' } })
  }
  const other = asked === p1 ? p2 : p1
  const [mine, theirs] = asked === p1 ? [alpha, beta] : [beta, alpha]
  const closedOnly = asked ? asked.waitForEvent('close', { timeout: 15000 }).then(() => true).catch(() => false) : Promise.resolve(false)
  if (asked) await asked.locator('.dialog button', { hasText: 'Close this window only' }).click()
  check('"Close this window only" closes that window', await closedOnly)
  const invOther = invOn(other)
  check('without asking again: one window left, Hive still running', !!(await lib.until(async () => (await invOther('window:count')) === 1, 5000)))
  check("that window's agent stopped", !!(await lib.until(async () => !(await liveIn(invOther, mine)), 5000)))
  check("the other window's agent runs on", await liveIn(invOther, theirs))
  check('the other window has no dialog', !(await dialogIn(other)))

  // --- Busy agents in two windows: Exit's dialog (with Quit when agents finish) keeps every control inside it.
  const [missingWs, missingProject] = mine === alpha ? [wsA, alpha] : [wsB, beta]
  const pNew = await openWindow(invOther, missingWs)
  const invNew = invOn(pNew)
  const idNew = await startAgent(invNew, missingProject, 'Three')
  const idTheirs = (await invOther('session:live')).find((s) => s.projectPath.toLowerCase() === theirs.toLowerCase())?.agentId
  check('two windows again, an agent in each', !!idNew && !!idTheirs && (await invOther('window:count')) === 2)
  const work = async (inv, project, id) => {
    await inv('pty:write', lib.ptyKey(project, id), 'work 120')
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(project, id), '\r')
  }
  await work(invOther, theirs, idTheirs)
  await work(invNew, missingProject, idNew)
  check('both agents are working', !!(await lib.until(async () => (await invOther('session:live')).filter((s) => s.status === 'working').length === 2, 10000)))
  /** Everything wrong with the quit dialog's layout: a control outside the dialog, cut, or overlapping another. */
  const layout = (page) =>
    page.evaluate(() => {
      const d = [...document.querySelectorAll('.dialog')].find((x) => x.querySelector('.quit-agents'))
      if (!d) return { bad: ['no dialog'], buttons: [] }
      const box = d.getBoundingClientRect()
      const bad = []
      const controls = [...d.querySelectorAll('.dialog-footer > *, .quit-dontask, .quit-window-only > *')]
      for (const c of controls) {
        const r = c.getBoundingClientRect()
        const name = c.textContent.trim() || c.className
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) bad.push(`${name}: outside the dialog`)
        if (c.scrollWidth > c.clientWidth + 1) bad.push(`${name}: cut`)
      }
      const footer = [...d.querySelectorAll('.dialog-footer > *')].map((c) => [c.textContent.trim(), c.getBoundingClientRect()])
      for (let i = 0; i < footer.length; i++)
        for (let j = i + 1; j < footer.length; j++) {
          const [, a] = footer[i]
          const [, b] = footer[j]
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) bad.push(`${footer[i][0]} overlaps ${footer[j][0]}`)
        }
      return { bad, buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean) }
    })
  await clickMenu(other, 'Exit Hive (all windows)')
  const busyAt = await lib.until(async () => ((await dialogIn(other)) ? other : (await dialogIn(pNew)) ? pNew : null), 8000)
  check('Exit with busy agents asks', !!busyAt)
  if (busyAt) {
    const busyWs = path.basename((await invOn(busyAt)('workspace:get')).path)
    const l = await layout(busyAt)
    check('it offers Quit when agents finish and Close this window only', l.buttons.some((b) => /when agents finish/.test(b)) && l.buttons.some((b) => b.includes('Close this window only')), JSON.stringify(l.buttons))
    check('100%: every control is inside the dialog, uncut, apart', !l.bad.length, l.bad.join('; '))
    await busyAt.screenshot({ path: path.join(lib.WORK, 'closewindow-busy-dark.png') })
    await invOn(busyAt)('settings:update', { appearance: { theme: 'light' } })
    await lib.sleep(300)
    await busyAt.screenshot({ path: path.join(lib.WORK, 'closewindow-busy-light.png') })
    await invOn(busyAt)('settings:update', { appearance: { theme: 'dark' } })
    await onWindow(busyWs, 'w.webContents.setZoomFactor(1.25)')
    await lib.sleep(400)
    const z = await layout(busyAt)
    check('125%: every control is inside the dialog, uncut, apart', !z.bad.length, z.bad.join('; '))
    await busyAt.screenshot({ path: path.join(lib.WORK, 'closewindow-busy-125.png') })
    await onWindow(busyWs, 'w.webContents.setZoomFactor(1)')
    await cancel(busyAt)
  }

  // --- Unsaved files in both windows: the window asked about its files first, then Close this window only, still
  // asks about that window's agents (they weren't listed), and the other window and its agent stay.
  await invOther('files:setUnsaved', [path.join(theirs, 'a.ts')])
  await invNew('files:setUnsaved', [path.join(missingProject, 'a.ts')])
  await clickMenu(other, 'Exit Hive (all windows)')
  const firstAt = await lib.until(async () => ((await dialogIn(other)) ? other : (await dialogIn(pNew)) ? pNew : null), 8000)
  const first = firstAt ? await dialogIn(firstAt) : null
  check('Exit first asks one window about its unsaved file only', first?.unsaved === 1 && first.rows.length === 0, JSON.stringify(first))
  const [stays, closes] = firstAt === other ? [pNew, other] : [other, pNew]
  const [staysProject, closesProject] = firstAt === other ? [missingProject, theirs] : [theirs, missingProject]
  if (firstAt) {
    await firstAt.locator('.dialog button', { hasText: 'Discard the changes' }).click()
    await firstAt.locator('.dialog button', { hasText: 'Close this window only' }).click()
  }
  const then = await lib.until(async () => {
    const d = await dialogIn(closes)
    return d && d.title === 'Close this window?' ? d : null
  }, 8000)
  check('then it asks about that window\'s agent ("Close this window?"), as Close Window does', then?.rows.length === 1 && then.unsaved === 0, JSON.stringify(then))
  check('…and the window is still open meanwhile', (await invOn(stays)('window:count')) === 2 && (await liveIn(invOn(stays), closesProject)))
  const closedAfter = closes.waitForEvent('close', { timeout: 15000 }).then(() => true).catch(() => false)
  await closes.locator('.dialog button', { hasText: /Close window/ }).last().click()
  check('confirmed, that window closes', await closedAfter)
  const invStays = invOn(stays)
  check("its agent stopped, the other window's runs on", !!(await lib.until(async () => !(await liveIn(invStays, closesProject)), 5000)) && (await liveIn(invStays, staysProject)))
  check('the other window is still open, with no dialog', (await invStays('window:count')) === 1 && !(await dialogIn(stays)))

  // --- Two more workspaces both named "work", in two more windows: Exit's dialog keeps them apart, grouped by
  // full path, each heading with the parent folder that tells it apart and its full path on hover (#209).
  const pDup1 = await openWindow(invStays, wsDup1)
  const pDup2 = await openWindow(invStays, wsDup2)
  check('an agent runs in each "work" workspace', !!(await startAgent(invOn(pDup1), gamma)) && !!(await startAgent(invOn(pDup2), delta)))
  await clickMenu(stays, 'Exit Hive (all windows)')
  const dupPages = [stays, pDup1, pDup2]
  const dupAt = await lib.until(async () => { for (const pg of dupPages) if (await dialogIn(pg)) return pg; return null }, 8000)
  const dupQuit = dupAt ? await dialogIn(dupAt) : null
  check('Exit with three windows asks', dupQuit?.title === 'Quit Combwork and close all 3 windows?', dupQuit?.title)
  const heads = dupAt
    ? await dupAt.evaluate(() => [...document.querySelectorAll('.dialog .quit-group')].map((g) => ({ where: g.querySelector('.quit-group-where')?.textContent ?? '', name: g.textContent.replace(g.querySelector('.quit-group-where')?.textContent ?? '', '').trim(), title: g.getAttribute('title') ?? '' })))
    : []
  const works = heads.filter((h) => h.name === 'work')
  check('two separate "work" groups, not one', heads.length === 3 && works.length === 2, JSON.stringify(heads))
  check('…each with the parent folder that tells it apart', JSON.stringify(works.map((h) => h.where).sort()) === JSON.stringify(['closewindow-dup-1', 'closewindow-dup-2']), JSON.stringify(works))
  check('…and its full path on hover', JSON.stringify(works.map((h) => h.title.toLowerCase()).sort()) === JSON.stringify([wsDup1, wsDup2].map((x) => x.toLowerCase()).sort()), JSON.stringify(works))
  check('the workspace with a name of its own has no parent folder', heads.filter((h) => h.name !== 'work').every((h) => !h.where), JSON.stringify(heads))
  check('…and each agent is under its own', JSON.stringify([...(dupQuit?.rows ?? [])].filter((r) => r.startsWith('work')).sort()) === JSON.stringify(['workclosewindow-dup-1|gamma', 'workclosewindow-dup-2|delta']), JSON.stringify(dupQuit?.rows))
  /** The parent folder label's contrast against the dialog (#219): WCAG's ratio, from the computed colours. */
  const whereContrast = (pg) =>
    pg.evaluate(() => {
      const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      const lum = ([r, g, b]) => {
        const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const where = document.querySelector('.dialog .quit-group-where')
      const dialog = where?.closest('.dialog')
      if (!where || !dialog) return 0
      const [a, b] = [lum(rgb(getComputedStyle(where).color)), lum(rgb(getComputedStyle(dialog).backgroundColor))]
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    })
  if (dupAt) {
    const dark = await whereContrast(dupAt)
    check('dark: the parent folder reads at 4.5:1 or more against the dialog', dark >= 4.5, dark.toFixed(2))
    await dupAt.screenshot({ path: path.join(lib.WORK, 'closewindow-dup-dark.png') })
    await invOn(dupAt)('settings:update', { appearance: { theme: 'light' } })
    await lib.sleep(300)
    const light = await whereContrast(dupAt)
    check('light: …and in the light theme', light >= 4.5, light.toFixed(2))
    await dupAt.screenshot({ path: path.join(lib.WORK, 'closewindow-dup-light.png') })
    await invOn(dupAt)('settings:update', { appearance: { theme: 'dark' } })
    await cancel(dupAt)
  }

  // Done: quit without the dialog (no unsaved files, no question about sessions).
  await invStays('files:setUnsaved', [])
  await invStays('settings:update', { general: { confirmOnQuit: 'never' } })
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
