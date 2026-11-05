// Keyboard shortcuts: Settings editor (record, chord, conflict, refused keys, remove, reset), its tabs by category
// (HI-1838: All and each category with counts, the keyboard, remembered, a search showing All with its matches counted,
// no Category filter (the tabs choose the category, HI-1878: Set alone above the table), a clash across categories named with its category), project
// overrides, and some new defaults (Go to Project, layouts, next tab); Alt+1…9 for the tabs in the strip's order, More ▾'s
// tabs, and the Project menu matching them (#1043). Throwaway profile and workspace;
// no sessions started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
const scratch = lib.WORK, userData = path.join(scratch, 'keys-profile'), ws = path.join(scratch, 'keys-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
for (const n of ['alpha', 'bravo']) fs.mkdirSync(path.join(ws, n), { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
;(async () => {
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  await page.keyboard.press('Escape')
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click(); await lib.until(async () => /alpha/.test(await page.locator('.project-header h1').innerText().catch(() => '')), HUNG_MS)
  const tab = () => page.locator('.tabs .tab.active').innerText()

  // New defaults
  await page.keyboard.press('Control+p'); await lib.until(async () => (await page.locator('.palette input[placeholder="Go to project"]').count()) === 1, HUNG_MS)
  check('Ctrl+P: Go to Project', await page.locator('.palette input[placeholder="Go to project"]').count() === 1)
  await page.keyboard.type('bravo'); await page.keyboard.press('Enter'); await lib.until(async () => /bravo/.test(await page.locator('.project-header h1').innerText().catch(() => '')), HUNG_MS)
  check('Go to Project opens it', /bravo/.test(await page.locator('.project-header h1').innerText()))
  await page.keyboard.press('Control+Tab'); await lib.until(async () => /Overview/.test(await tab().catch(() => '')), HUNG_MS)
  check('Ctrl+Tab: next project tab', /Overview/.test(await tab()), await tab())
  await page.keyboard.press('Control+Shift+Tab'); await lib.until(async () => /Session/.test(await tab().catch(() => '')), HUNG_MS)
  check('Ctrl+Shift+Tab: previous tab', /Session/.test(await tab()), await tab())
  // Alt+1…9: the strip's tabs in the order they show (#1043; Activity last, HI-1254); More ▾'s have none.
  const MAIN = ['Session', 'Overview', 'Performance', 'Tasks', 'Sessions', 'Files', 'Attachments', 'Version Control', 'Activity']
  const strip = (await page.locator('.tabs .tab:not(.tab-more) .tab-label').allInnerTexts()).map((t) => t.trim())
  check('the strip shows the main tabs, in order, then More ▾', JSON.stringify(strip) === JSON.stringify(MAIN) && (await page.locator('.tabs .tab').last().evaluate((t) => t.classList.contains('tab-more'))), JSON.stringify(strip))
  const reached = []
  for (const [i, label] of [...MAIN.entries()].reverse()) {
    await page.keyboard.press(`Alt+${i + 1}`)
    if (await lib.until(async () => (await tab().catch(() => '')).trim() === label, HUNG_MS)) reached.push(label)
  }
  check('Alt+1…9 open the tabs in the order they show', reached.length === MAIN.length, `reached ${JSON.stringify(reached)}`)
  check('tab shortcuts never hide the sidebar', (await page.locator('.project-row').count()) === 2)
  // More ▾: its four tabs with no keys, then a separator and Project Settings… (HI-1840) with its command's key.
  const moreRows = () => page.locator('.menu').last().evaluate((m) => [...m.children].map((c) => (c.classList.contains('menu-sep') ? '-' : `${c.querySelector('.menu-label, :scope > span:not(.menu-key)')?.textContent.trim() ?? c.textContent.trim()}=${c.querySelector('.menu-key')?.textContent.trim() ?? ''}`)))
  const openMore = async () => {
    await page.locator('.tabs .tab-more').click()
    await lib.until(async () => (await page.locator('.menu .menu-item').count()) === 5, HUNG_MS)
  }
  await openMore()
  const moreItems = await moreRows()
  check('More ▾ lists Memory, Skills, Templates and MCP with no keys, then a separator and Project Settings… with Alt+0', JSON.stringify(moreItems) === JSON.stringify(['Memory=', 'Skills=', 'Templates=', 'MCP=', '-', 'Project Settings…=Alt+0']), JSON.stringify(moreItems))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await page.screenshot({ path: path.join(scratch, `keys-more-settings-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await lib.menuEntry(page, 'Project Settings…').click()
  check('…choosing it opens Project Settings, no tab of the strip chosen, More ▾ keeping its own name', !!(await lib.until(async () => (await page.locator('.tab-body .settings-top').count()) > 0 && (await page.locator('.tabs .tab.active').count()) === 0 && (await page.locator('.tabs .tab-more .tab-label').innerText()).trim() === 'More', HUNG_MS)), await page.locator('.tabs .tab-more .tab-label').innerText().catch(() => ''))
  // Its key follows the user's: changed, the menu shows the new one; reset, Alt+0 again.
  await inv('settings:setKeybinding', 'project.tab.settings', 'Alt+Shift+0')
  await lib.until(async () => (await inv('settings:get')).keybindings['project.tab.settings'] === 'Alt+Shift+0', HUNG_MS)
  await openMore()
  check('…its key follows a change of the shortcut (Alt+Shift+0)', (await moreRows()).at(-1) === 'Project Settings…=Alt+Shift+0', JSON.stringify(await moreRows()))
  await page.keyboard.press('Escape'); await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
  await inv('settings:setKeybinding', 'project.tab.settings', undefined)
  await lib.until(async () => !('project.tab.settings' in (await inv('settings:get')).keybindings), HUNG_MS)
  await page.keyboard.press('Alt+1'); await lib.until(async () => (await tab().catch(() => '')).trim() === 'Session', HUNG_MS)
  for (const label of ['Memory', 'Skills', 'Templates', 'MCP']) {
    let ok = true
    await lib.openMoreTab(page, label).catch(() => (ok = false))
    check(`More ▾ → ${label} opens it, and More ▾ shows its name`, ok && (await tab()).trim() === label, await tab())
  }
  // From the keyboard: focus More ▾, Enter opens its menu on its first entry, Enter chooses it.
  await page.locator('.tabs .tab-more').focus(); await page.keyboard.press('Enter')
  await lib.until(async () => (await page.locator('.menu .menu-item.active').count()) === 1, HUNG_MS)
  await page.keyboard.press('Enter')
  check('More ▾ works from the keyboard', !!(await lib.until(async () => (await tab().catch(() => '')).trim() === 'Memory', HUNG_MS)), await tab())
  await page.keyboard.press('Alt+1'); await lib.until(async () => (await tab().catch(() => '')).trim() === 'Session', HUNG_MS)
  check('a main tab gives More ▾ its own name back', (await page.locator('.tabs .tab-more .tab-label').innerText()).trim() === 'More')
  // The menu bar's Project menu: the main tabs with Alt+1…9, then More ▾'s, then Project Settings (Alt+0).
  await page.locator('.menubar-item[data-menu="project"]').click(); await lib.until(async () => (await page.locator('.menu [data-command^="project.tab."]').count()) === 14, HUNG_MS)
  const menuRows = await page.locator('.menu').last().evaluate((m) => [...m.children].map((c) => (c.classList.contains('menu-sep') ? '-' : `${c.getAttribute('data-command') ?? ''}=${c.querySelector('.menu-key')?.textContent.trim() ?? ''}`)))
  const tabRows = menuRows.slice(menuRows.findIndex((r) => r.startsWith('project.tab.')), menuRows.findIndex((r) => r.startsWith('project.tab.settings')) + 1)
  const wantRows = ['session', 'overview', 'performance', 'tasks', 'sessions', 'files', 'images', 'changes', 'activity'].map((id, i) => `project.tab.${id}=Alt+${i + 1}`).concat(['-', 'project.tab.memory=', 'project.tab.skills=', 'project.tab.templates=', 'project.tab.mcp=', '-', 'project.tab.settings=Alt+0'])
  check('the Project menu matches the strip and its keys', JSON.stringify(tabRows) === JSON.stringify(wantRows), JSON.stringify(tabRows))
  await page.screenshot({ path: path.join(scratch, 'keys-0-project-menu.png') })
  await page.keyboard.press('Escape'); await page.mouse.click(5, 500); await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
  await page.keyboard.press('Control+Alt+2'); await lib.until(async () => (await inv('workspace:refresh')).projects.find((x) => x.name === 'bravo')?.config.layout === 'columns2', HUNG_MS)
  const p = (await inv('workspace:refresh')).projects.find((x) => x.name === 'bravo')
  check('Ctrl+Alt+2: two-column layout', p.config.layout === 'columns2', JSON.stringify(p.config.layout))
  await page.keyboard.press('Control+Alt+1'); await lib.until(async () => (await inv('workspace:refresh')).projects.find((x) => x.name === 'bravo')?.config.layout === 'single', HUNG_MS)

  // Settings → Keyboard Shortcuts
  await page.keyboard.press('Control+,'); await lib.until(async () => (await page.locator('.settings-nav .row', { hasText: 'Keyboard Shortcuts' }).count()) > 0, HUNG_MS)
  await page.locator('.settings-nav .row', { hasText: 'Keyboard Shortcuts' }).click(); await lib.until(async () => (await page.locator('.kb-table tr:not(.kb-cat)').count()) > 60, HUNG_MS)
  check('editor lists commands', (await page.locator('.kb-table tr:not(.kb-cat)').count()) > 60, String(await page.locator('.kb-table tr:not(.kb-cat)').count()))

  // --- Tabs by category (HI-1838): All, then each category in the commands' order, each with its count.
  const kbTabs = () => page.locator('.kb-tabs [role="tab"]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-tab'), label: e.querySelector('.hive-tab-label').textContent.trim(), count: Number((e.querySelector('.hive-tab-count')?.textContent ?? '').replace(/\D/g, '') || -1), selected: e.getAttribute('aria-selected') === 'true' })))
  const kbTab = (id) => page.locator(`.kb-tabs [role="tab"][data-tab="${id}"]`)
  const selectedKb = async () => (await kbTabs()).find((t) => t.selected)?.id ?? null
  const bodyRows = () => page.locator('.kb-table tbody td.kb-label').count()
  // The column headers' names, as written (their CSS shows them in capitals); the filter row under them left out.
  const headers = () => page.locator('.kb-table thead tr:first-child th').evaluateAll((ths) => ths.map((th) => th.textContent.trim()).filter(Boolean))
  const configKb = (key) => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).ui?.tabs?.[key]
  const t0 = await kbTabs()
  // The categories in the order All lists them (its default order is the commands').
  const shownOrder = [...new Set((await page.locator('.kb-table tbody td.kb-category').allInnerTexts()).map((c) => c.trim()))]
  check('tabs: All first and chosen, then each category in the commands’ order', t0[0]?.id === 'all' && t0[0].selected && JSON.stringify(t0.slice(1).map((t) => t.label)) === JSON.stringify(shownOrder) && t0.length > 6, JSON.stringify([t0.map((t) => t.label), shownOrder]))
  check('…each with its count, All’s every command, the categories’ adding up to it', t0[0].count === (await bodyRows()) && t0.slice(1).reduce((n, t) => n + t.count, 0) === t0[0].count, JSON.stringify(t0.map((t) => t.count)))
  check('All has the Category column', (await headers()).includes('Category'), JSON.stringify(await headers()))
  const session = t0.find((t) => t.id === 'session')
  await kbTab('session').click()
  check('the Session tab: its commands alone, without the Category column', !!(await lib.until(async () => (await selectedKb()) === 'session' && (await bodyRows()) === session.count && !(await headers()).includes('Category'), HUNG_MS)), JSON.stringify([await selectedKb(), await bodyRows(), await headers()]))
  check('…remembered in the settings', !!(await lib.until(() => configKb('shortcuts') === 'session', HUNG_MS)), String(configKb('shortcuts')))
  // Its filters above the table (HI-1878): Set's alone, with no Category column to filter.
  const filterBar = (k) => page.locator(`.kb-table .table-filter-bar [data-filter="${k}"]`)
  check('…its filters above the table: Set, no Category', (await filterBar('category').count()) === 0 && (await filterBar('source').count()) === 1 && (await page.locator('.kb-table tr.table-filters').count()) === 0)
  await page.screenshot({ path: path.join(scratch, 'keys-tabs-session-dark.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.screenshot({ path: path.join(scratch, 'keys-tabs-session-light.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  // The keyboard: the arrows move along the tabs, the focus with them.
  await kbTab('session').focus()
  await page.keyboard.press('ArrowRight')
  const next = t0[t0.findIndex((t) => t.id === 'session') + 1]
  const focusedKb = () => page.evaluate(() => document.activeElement?.closest('.kb-tabs') ? document.activeElement.getAttribute('data-tab') : null)
  check('ArrowRight: the next category, focused', !!(await lib.until(async () => (await selectedKb()) === next.id && (await focusedKb()) === next.id && (await bodyRows()) === next.count, HUNG_MS)), JSON.stringify([await selectedKb(), await focusedKb()]))
  await page.keyboard.press('Home')
  check('Home: All', !!(await lib.until(async () => (await selectedKb()) === 'all' && (await focusedKb()) === 'all', HUNG_MS)))
  // The tabs choose the category: All has no Category filter of its own, only Set's (the Assistant's HI-1878 review).
  check('All has no Category filter, only Set above the table', (await filterBar('category').count()) === 0 && (await filterBar('source').count()) === 1)
  await kbTab('session').click()
  check('…the Session tab shows all its commands', !!(await lib.until(async () => (await selectedKb()) === 'session' && (await bodyRows()) === session.count, HUNG_MS)), String(await bodyRows()))
  // Sorting works as the columns change: Command A to Z inside the tab.
  await page.locator('.kb-table th button', { hasText: 'Command' }).click()
  const sessionLabels = () => page.locator('.kb-table tbody td.kb-label').evaluateAll((tds) => tds.map((td) => td.firstChild.textContent.trim()))
  check('…and Command sorts them A to Z', !!(await lib.until(async () => { const l = await sessionLabels(); return l.length === session.count && l.every((x, i) => !i || l[i - 1].localeCompare(x, undefined, { sensitivity: 'base' }) <= 0) }, HUNG_MS)), (await sessionLabels()).join(' | '))
  await page.locator('.kb-table th button', { hasText: 'Command' }).click(); await page.locator('.kb-table th button', { hasText: 'Command' }).click()
  // The Set filter inside a tab: Changed, none yet.
  await page.locator('.kb-table select[aria-label="Filter Set"]').selectOption('Default')
  check('…its Set filter works there too', !!(await lib.until(async () => (await bodyRows()) === session.count, HUNG_MS)))
  await page.locator('.kb-table select[aria-label="Filter Set"]').selectOption('')
  await kbTab('all').click()
  check('back in All, every command', !!(await lib.until(async () => (await selectedKb()) === 'all' && (await bodyRows()) === t0[0].count, HUNG_MS)), String(await bodyRows()))
  await kbTab('session').click()
  await lib.until(async () => (await selectedKb()) === 'session' && configKb('shortcuts') === 'session', HUNG_MS)
  // A search shows All, each tab's count its matches; a tab clicked meanwhile narrows it, not remembered; cleared, the
  // tab remembered before is back.
  const kbSearch = page.locator('.kb-toolbar input')
  await kbSearch.fill('notifications')
  check('a search shows All, its count the matches, a category’s count its own', !!(await lib.until(async () => { const t = await kbTabs(); return (await selectedKb()) === 'all' && t[0].count === (await bodyRows()) && t[0].count > 1 && t[0].count < t0[0].count && t.slice(1).reduce((n, x) => n + x.count, 0) === t[0].count && t.find((x) => x.id === 'session').count === 0 }, HUNG_MS)), JSON.stringify(await kbTabs()))
  await page.screenshot({ path: path.join(scratch, 'keys-tabs-search-dark.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.screenshot({ path: path.join(scratch, 'keys-tabs-search-light.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const withMatches = (await kbTabs()).find((t) => t.id !== 'all' && t.count > 0)
  await kbTab(withMatches.id).click()
  check('…a category clicked meanwhile shows its matches alone', !!(await lib.until(async () => (await selectedKb()) === withMatches.id && (await bodyRows()) === withMatches.count, HUNG_MS)), String(await bodyRows()))
  check('…and isn’t remembered', configKb('shortcuts') === 'session', String(configKb('shortcuts')))
  // The click holds for that query only (HI-1885, as Advanced's HI-1839): a changed query, not cleared first, shows All
  // with its matches, even where the clicked tab has none; back to the first query, still All, the click gone.
  await kbSearch.fill('compact')
  check('…a changed query shows All with its matches, not the tab clicked before', !!(await lib.until(async () => { const t = await kbTabs(); return (await selectedKb()) === 'all' && t[0].count > 0 && (await bodyRows()) === t[0].count && t.find((x) => x.id === 'session').count > 0 }, HUNG_MS)), JSON.stringify([await selectedKb(), await bodyRows(), await kbTabs()]))
  await kbSearch.fill('notifications')
  check('…and the first query again: All, the old click not revived', !!(await lib.until(async () => (await selectedKb()) === 'all' && (await bodyRows()) === (await kbTabs())[0].count && (await bodyRows()) > withMatches.count - 1 && (await kbTabs())[0].count > 1, HUNG_MS)), JSON.stringify([await selectedKb(), await bodyRows()]))
  check('…nothing remembered from the search', configKb('shortcuts') === 'session', String(configKb('shortcuts')))
  await kbSearch.fill('')
  check('cleared: the tab remembered before, Session, is back with its commands', !!(await lib.until(async () => (await selectedKb()) === 'session' && (await bodyRows()) === session.count && (await kbTabs())[0].count === t0[0].count, HUNG_MS)), JSON.stringify([await selectedKb(), await bodyRows()]))
  // A clash with a command in another tab: recording it asks, naming the command with its category; the warning says so.
  const firstSession = page.locator('.kb-table tbody tr').first()
  await firstSession.locator('.icon-btn[aria-label^="Change shortcut"]').click()
  await lib.until(async () => /Press the keys/.test(await firstSession.innerText()), HUNG_MS)
  await page.keyboard.press('Control+Shift+P')
  const inUse = page.locator('.dialog', { hasText: 'Shortcut already in use' })
  check('a clash with View’s Show All Commands asks, naming it with its category', !!(await lib.until(async () => (await inUse.innerText().catch(() => '')).includes('View: Show All Commands'), HUNG_MS)), await inUse.innerText().catch(() => ''))
  const before = (await inv('settings:get')).keybindings
  await inUse.getByRole('button', { name: 'Use it' }).click()
  const clashed = await lib.until(async () => Object.entries((await inv('settings:get')).keybindings).find(([k, v]) => v === 'Mod+Shift+P' && !(k in before))?.[0] ?? null, HUNG_MS)
  check('…Use it saves it', !!clashed, JSON.stringify((await inv('settings:get')).keybindings))
  const warn = firstSession.locator('.kb-warn')
  const tip = await lib.hoverTip(page, warn, (t) => t.includes('View: Show All Commands')).catch(() => '')
  check('…and its warning names the other tab’s command with its category', !!tip, String(tip))
  await firstSession.locator('.icon-btn[aria-label^="Reset to default"]').click()
  check('…reset', !!(await lib.until(async () => !(clashed in (await inv('settings:get')).keybindings), HUNG_MS)))
  await kbTab('all').click()
  await lib.until(async () => (await selectedKb()) === 'all' && (await bodyRows()) === t0[0].count, HUNG_MS)
  // German in a narrow window: the tabs' longer names and counts wrap onto another line, every tab whole, none scrolled
  // out of sight (HR5's design check).
  const base = (await inv('app:info')).language
  const deDir = path.join(lib.ROOT, 'locales', 'de')
  const deMessages = Object.assign({}, ...fs.readdirSync(deDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(deDir, f), 'utf8'))))
  const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })
  await lib.fitWindow(app, page, { width: 1000, height: 900 })
  await speak({ ...base, code: 'de', locale: 'de', messages: deMessages })
  const tabsFit = () => page.locator('.kb-tabs').evaluate((list) => {
    const l = list.getBoundingClientRect()
    const tabs = [...list.querySelectorAll('[role="tab"]')].map((t) => t.getBoundingClientRect())
    return { inside: tabs.every((t) => t.left >= l.left - 0.5 && t.right <= l.right + 0.5), scrolls: list.scrollWidth > list.clientWidth + 1, lines: new Set(tabs.map((t) => Math.round(t.top))).size, first: list.querySelector('.hive-tab-label')?.textContent }
  })
  check('German, narrow: the tabs wrap, each whole, none scrolled away', !!(await lib.until(async () => { const f = await tabsFit(); return f.first === 'Alle' && f.inside && !f.scrolls && f.lines > 1 }, HUNG_MS)), JSON.stringify(await tabsFit()))
  // …and the table: the command and its Shortcut whole beside the sticky actions, Category kept after them, reached by
  // scrolling sideways; its and Set's filters above the table, in view without scrolling, with no empty band under the
  // headers (HI-1878); the sticky cells on the editor's own surface, the editor hovered (HR5's HI-1838 round 1, the
  // Assistant's screenshot review).
  const tableFit = () => page.locator('.kb-table').evaluate((t) => {
    const wrap = t.querySelector('.table-wrap')
    const w = wrap.getBoundingClientRect()
    const box = (sel) => t.querySelector(sel)?.getBoundingClientRect() ?? null
    const actions = box('thead tr:first-child th.kb-actions'), cat = box('thead tr:first-child th.kb-category'), label = box('thead tr:first-child th.kb-label')
    const shownCells = (row) => [...(t.querySelector(row)?.children ?? [])].filter((c) => c.getBoundingClientRect().width > 0).length
    const bg = (el) => getComputedStyle(el).backgroundColor
    const stickyHead = t.querySelector('thead tr:first-child th.kb-actions')
    return {
      // The values themselves, row by row: the Shortcut cell may run on under the actions, empty there.
      labelAndKeyWhole: !!label && label.left >= w.left - 0.5 && [...t.querySelectorAll('tbody tr')].slice(0, 8).every((tr) => { const v = tr.querySelector('.kb-key-value')?.getBoundingClientRect(), a = tr.querySelector('td.kb-actions')?.getBoundingClientRect(), n = tr.querySelector('td.kb-label')?.getBoundingClientRect(); return !!v && !!a && !!n && v.right <= a.left + 0.5 && n.left >= w.left - 0.5 }),
      categoryKept: !!cat && cat.width > 0,
      categoryInView: !!cat && !!actions && cat.left >= w.left - 0.5 && cat.right <= actions.left + 0.5,
      filtersAbove: !t.querySelector('tr.table-filters') && !t.querySelector('.table-filter-bar [data-filter="category"]') && ['source'].every((k) => { const f = t.querySelector(`.table-filter-bar [data-filter="${k}"] select`)?.getBoundingClientRect(); return !!f && f.width > 0 && f.left >= w.left - 0.5 && f.right <= w.right + 0.5 && f.bottom <= w.top + 0.5 }) && shownCells('thead tr:first-child') > 0,
      surface: bg(stickyHead) === bg(document.body) && ['rgba(0, 0, 0, 0)', 'transparent'].includes(bg(t.closest('.setting'))),
      scrolls: wrap.scrollWidth > wrap.clientWidth
    }
  })
  await page.locator('.kb-table tbody tr').first().hover()
  check('German, narrow: the command and its Shortcut whole beside the actions, Category kept after them, its and Set’s filters above the table in view, the sticky cells on the editor’s surface', !!(await lib.until(async () => { const f = await tableFit(); return f.labelAndKeyWhole && f.categoryKept && f.filtersAbove && f.surface }, HUNG_MS)), JSON.stringify(await tableFit()))
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme)
    check(`…its sticky header on the editor’s surface in the ${theme} theme`, !!(await lib.until(async () => (await tableFit()).surface, HUNG_MS)))
  }
  // Usable before any sideways scroll (HI-1878): each filter narrows the rows, and All puts them back; the strip wraps
  // inside the editor rather than widening it.
  check('…the filters wrap inside the editor', await page.locator('.kb-editor').evaluate((e) => { const bar = e.querySelector('.table-filter-bar'); return !!bar && bar.scrollWidth <= bar.clientWidth + 1 && e.scrollWidth <= e.clientWidth + 1 }))
  const allRows = await bodyRows()
  {
    const select = filterBar('source').locator('select')
    const pick = await select.locator('option').nth(1).getAttribute('value')
    await select.selectOption(pick)
    // Set may have one value here (every shortcut its default): it narrows nothing, and every row is still its.
    check(`…its Set filter, not scrolled to, keeps only "${pick}"`, !!(await lib.until(async () => { const n = await bodyRows(); const v = await page.locator('.kb-table tbody td.kb-source').allInnerTexts(); return n > 0 && v.every((c) => (c.trim() || pick) === pick) }, HUNG_MS)) && (await page.locator('.kb-table .table-wrap').evaluate((w) => w.scrollLeft)) === 0, String(await bodyRows()))
    await select.selectOption('')
    check('…and All shows every row again', !!(await lib.until(async () => (await bodyRows()) === allRows, HUNG_MS)), String(await bodyRows()))
  }
  if ((await tableFit()).scrolls) {
    await page.locator('.kb-table .table-wrap').evaluate((w) => (w.scrollLeft = w.scrollWidth))
    check('…scrolled sideways, Category whole beside the actions', !!(await lib.until(async () => (await tableFit()).categoryInView, HUNG_MS)), JSON.stringify(await tableFit()))
    await page.locator('.kb-table .table-wrap').evaluate((w) => (w.scrollLeft = 0))
  }
  await page.mouse.move(5, 5)
  await page.locator('.kb-tabs').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(scratch, 'keys-tabs-narrow-de-dark.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.screenshot({ path: path.join(scratch, 'keys-tabs-narrow-de-light.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await speak(base)
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.until(async () => (await tabsFit()).first === 'All', HUNG_MS)
  // A DataTable (#250): sorting by a header in All, with the edit controls kept.
  await page.locator('.kb-table th button', { hasText: 'Command' }).click()
  const labels = () => page.locator('.kb-table tbody td.kb-label').evaluateAll((tds) => tds.map((td) => td.firstChild.textContent.trim()))
  check('Command sorts every command A to Z', !!(await lib.until(async () => { const l = await labels(); return l.length === t0[0].count && l.every((x, i) => !i || l[i - 1].localeCompare(x, undefined, { sensitivity: 'base' }) <= 0) }, HUNG_MS)), (await labels()).slice(0, 10).join(' | '))
  await page.locator('.kb-table th button', { hasText: 'Command' }).click(); await page.locator('.kb-table th button', { hasText: 'Command' }).click()
  await page.locator('.kb-toolbar input').fill('Show Notifications'); await sleep(200)
  const row = page.locator('.kb-table tr', { hasText: 'Show Notifications' }).first()
  await row.locator('.icon-btn[aria-label^="Change shortcut"]').click(); await lib.until(async () => /Press the keys/.test(await row.innerText()), HUNG_MS)
  check('recording prompt', /Press the keys/.test(await row.innerText()))
  await page.keyboard.press('Control+Alt+Y'); await lib.until(async () => (await inv('settings:get')).keybindings['view.notifications'] === 'Mod+Alt+Y', 10000)
  let s = await inv('settings:get')
  check('recorded Ctrl+Alt+Y', s.keybindings['view.notifications'] === 'Mod+Alt+Y', JSON.stringify(s.keybindings))
  check('row shows Changed', /Changed/.test(await row.innerText()))
  await page.screenshot({ path: path.join(scratch, 'keys-1-settings.png') })
  // Wide, both themes (HI-1878: the filters above the table).
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.screenshot({ path: path.join(scratch, 'keys-1-settings-light.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.locator('.settings-top input.input').first().click()
  await page.keyboard.press('Control+Alt+Y'); await lib.until(async () => (await page.locator('.notif-panel').count()) === 1, HUNG_MS)
  check('new shortcut works', await page.locator('.notif-panel').count() === 1)
  // The bell closes (HI-2376): its shortcut toggles it, and Escape closes it, but not from a field, which uses Escape
  // itself. Escape in the search field first: the shortcut then closes the bell, which it would reopen had Escape closed it.
  const bell = page.locator('.notif-panel')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Alt+Y'); await lib.until(async () => (await bell.count()) === 0, HUNG_MS)
  check('Escape in a field leaves the bell open; its shortcut closes it', await bell.count() === 0)
  await page.keyboard.press('Control+Alt+Y'); await lib.until(async () => (await bell.count()) === 1, HUNG_MS)
  check('its shortcut opens it again', await bell.count() === 1)
  await page.evaluate(() => document.activeElement?.blur())
  // Closed, as the refusal below needs: pop-ups give way to the open bell (HI-2320, HI-2373).
  await page.keyboard.press('Escape'); await lib.until(async () => (await bell.count()) === 0, HUNG_MS)
  check('Escape closes the bell', await bell.count() === 0)
  // Chord
  await row.locator('.icon-btn[aria-label^="Change shortcut"]').click(); await sleep(200)
  // The chord's two presses a beat apart, as a person types them; then the wait for the saved chord.
  await page.keyboard.press('Control+K'); await sleep(300); await page.keyboard.press('Control+J'); await lib.until(async () => (await inv('settings:get')).keybindings['view.notifications'] === 'Mod+K Mod+J', HUNG_MS)
  s = await inv('settings:get')
  check('chord recorded', s.keybindings['view.notifications'] === 'Mod+K Mod+J', s.keybindings['view.notifications'])
  // Refused key
  await row.locator('.icon-btn[aria-label^="Change shortcut"]').click(); await sleep(200)
  await page.keyboard.press('Control+C'); await lib.until(async () => (await page.locator('.toast', { hasText: "can't be used" }).count()) >= 1, 10000)
  check('Ctrl+C refused: its pop-up shows', (await page.locator('.toast', { hasText: "can't be used" }).count()) >= 1)
  s = await inv('settings:get')
  check('Ctrl+C refused: the chord is kept', s.keybindings['view.notifications'] === 'Mod+K Mod+J', s.keybindings['view.notifications'])
  // Conflict asks
  await row.locator('.icon-btn[aria-label^="Change shortcut"]').click(); await sleep(200)
  await page.keyboard.press('Control+Shift+P'); await lib.until(async () => (await page.locator('.dialog', { hasText: 'Shortcut already in use' }).count()) === 1, 10000)
  check('conflict asks first', await page.locator('.dialog', { hasText: 'Shortcut already in use' }).count() === 1)
  await page.locator('.dialog button', { hasText: 'Cancel' }).click(); await sleep(200)
  // Remove, then reset
  await row.locator('.icon-btn[aria-label="Remove shortcut"]').click(); await lib.until(async () => (await inv('settings:get')).keybindings['view.notifications'] === null, HUNG_MS)
  check('removed', (await inv('settings:get')).keybindings['view.notifications'] === null)
  await row.locator('.icon-btn[aria-label^="Reset to default"]').click(); await lib.until(async () => !('view.notifications' in (await inv('settings:get')).keybindings), HUNG_MS)
  check('reset to default', !('view.notifications' in (await inv('settings:get')).keybindings))

  // Project override: alpha gets Alt+F for Files; bravo keeps Alt+6
  await page.keyboard.press('Escape')
  if (!(await page.locator('.project-row').count())) await page.locator('.activity-btn[aria-label="Projects"]').click()
  await sleep(300)
  console.log('rows before alpha', await page.locator('.project-row').count(), await page.evaluate(() => document.querySelector('.activity-btn.active')?.getAttribute('aria-label')))
  await page.locator('.project-row', { hasText: 'alpha' }).click(); await lib.until(async () => /alpha/.test(await page.locator('.project-header h1').innerText().catch(() => '')), HUNG_MS)
  await lib.openProjectSettings(page)
  await page.locator('.settings-nav .row, .psettings-nav .row, .row', { hasText: 'Keyboard Shortcuts' }).first().click(); await lib.until(async () => (await page.locator('.kb-table').innerText().catch(() => '')).includes('Go to Files'), HUNG_MS)
  check('project editor lists only project/session commands', !(await page.locator('.kb-table').innerText()).includes('Toggle Sidebar') && (await page.locator('.kb-table').innerText()).includes('Go to Files'))
  check('…its Set filter above the table, no Category one (its tabs choose)', (await filterBar('category').count()) === 0 && (await filterBar('source').count()) === 1 && (await page.locator('.kb-table tr.table-filters').count()) === 0)
  const projectTabs = await kbTabs()
  check('…its tabs: All, Project and Session, All chosen (its own remembered tab)', JSON.stringify(projectTabs.map((t) => [t.id, t.selected])) === JSON.stringify([['all', true], ['project', false], ['session', false]]), JSON.stringify(projectTabs))
  console.log('rows after kb nav', await page.locator('.project-row').count())
  const frow = page.locator('.kb-table tr', { hasText: 'Go to Files' }).first()
  await frow.locator('.icon-btn[aria-label^="Change shortcut"]').click(); await sleep(200)
  await page.keyboard.press('Alt+F'); await lib.until(async () => (await inv('workspace:refresh')).projects.find((x) => x.name === 'alpha')?.config.keybindings?.['project.tab.files'] === 'Alt+F', 10000)
  const alpha = (await inv('workspace:refresh')).projects.find((x) => x.name === 'alpha')
  check('saved in the project', alpha.config.keybindings?.['project.tab.files'] === 'Alt+F', JSON.stringify(alpha.config.keybindings))
  await page.screenshot({ path: path.join(scratch, 'keys-2-project.png') })
  console.log('rows after record', await page.locator('.project-row').count())
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click(); await sleep(200)
  await page.keyboard.press('Alt+F'); await lib.until(async () => /Files/.test(await tab().catch(() => '')), HUNG_MS)
  console.log('rows after altF', await page.locator('.project-row').count())
  check('Alt+F opens Files in alpha', /Files/.test(await tab()), await tab())
  await page.locator('.project-row', { hasText: 'bravo' }).click(); await lib.until(async () => /bravo/.test(await page.locator('.project-header h1').innerText().catch(() => '')), HUNG_MS)
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click(); await lib.until(async () => /Session/.test(await tab().catch(() => '')), HUNG_MS)
  await page.keyboard.press('Alt+F'); await sleep(500) // A fixed wait on purpose: this checks that Alt+F does NOT switch tabs in bravo.
  check('Alt+F does nothing in bravo', /Session/.test(await tab()), await tab())
  await page.keyboard.press('Alt+6'); await lib.until(async () => /Files/.test(await tab().catch(() => '')), HUNG_MS)
  check('bravo keeps Alt+6', /Files/.test(await tab()), await tab())

  // Shortcuts dialog reflects changes and links to the editor
  await page.locator('.project-row', { hasText: 'alpha' }).click(); await lib.until(async () => /alpha/.test(await page.locator('.project-header h1').innerText().catch(() => '')), HUNG_MS)
  await page.locator('.project-header h1').click()
  await page.keyboard.press('Control+K'); await page.keyboard.press('Control+S'); await lib.until(async () => (await page.locator('.dialog').innerText().catch(() => '')).includes('Alt+F'), HUNG_MS)
  check('shortcuts dialog shows the project key', (await page.locator('.dialog').innerText()).includes('Alt+F'))
  await page.locator('.dialog button', { hasText: 'Customise' }).click(); await lib.until(async () => (await page.locator('.kb-editor').count()) === 1, HUNG_MS)
  check('Customise opens the editor', await page.locator('.kb-editor').count() === 1)
  await app.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
