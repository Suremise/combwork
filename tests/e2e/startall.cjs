// The project header's batch actions and tidy-up (#216, #974): Resume and Stop beside the Active switch, and Start New,
// Archive and Start New and Remove All for every agent in its Agents ▾ menu, each saying how many agents it acts on
// ("Stop (2)", #275, also in the Session menu and the palette), the same agents its question lists, following agents as
// they start and stop; the state line ("1 waiting · 2 working", #974); folding at narrow widths (icons, then Agents ▾'s
// actions in ⋯, then Active, the status to one count, then Resume and Stop, one row at any width, #1051); Explorer, Terminal and Remove Project… in the ⋯ menu, with their keys (HI-2551); the Session menu and the palette have both new
// actions; the Project menu lists every tab and Project Settings; the session toolbar's summary chip counts the agents. Three agents run the fake Claude Code (fake-claude/): one working, one idle,
// one stopped. Start New (All) asks once (the working one flagged), Cancel changes nothing, and then every agent has a
// new session with the old ones kept; Archive and Start New (All) archives each agent's session and starts fresh ones.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'startall-profile')
const ws = path.join(lib.WORK, 'startall-ws')
const claudeHome = path.join(lib.WORK, 'startall-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const PORT = lib.port(47884)
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  /** The open menu's rows, `label=keys` ('-' a separator), as keys.cjs reads them (HI-2551: ⋯'s entries show their keys). */
  const menuRows = () => page.locator('.menu').last().evaluate((m) => [...m.children].map((c) => (c.classList.contains('menu-sep') ? '-' : `${c.querySelector('.menu-label, :scope > span:not(.menu-key)')?.textContent.trim() ?? c.textContent.trim()}=${c.querySelector('.menu-key')?.textContent.trim() ?? ''}`)))
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const type = async (id, text) => {
    // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
  }
  // Starts an agent (trusting its folder) and has one exchange, so it has a conversation.
  const run = async (id) => {
    await inv('session:start', alpha, { agentId: id })
    await until(async () => ['waiting', 'ready'].includes((await live(id))?.status), HUNG_MS)
    if ((await live(id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    await until(async () => (await live(id))?.status === 'ready', HUNG_MS)
    await type(id, 'hello')
    return until(async () => (await live(id))?.status === 'finished', HUNG_MS)
  }
  const sessions = async () => inv('session:list', alpha)

  await page.getByText('alpha', { exact: true }).first().click()
  const w = await lib.addAgent(inv, alpha, { name: 'Worker' })
  const i = await lib.addAgent(inv, alpha, { name: 'Idle' })
  const s = await lib.addAgent(inv, alpha, { name: 'Stopped' })
  for (const a of [w, i, s]) check(`${a.name} ran once`, !!(await run(a.id)))
  await inv('session:stop', alpha, s.id)
  check('Stopped stopped', !!(await until(async () => !(await live(s.id)), HUNG_MS)))
  await type(w.id, 'work 120')
  check('Worker is working', !!(await until(async () => (await live(w.id))?.status === 'working', HUNG_MS)))
  const before = { w: (await live(w.id)).sessionId, i: (await live(i.id)).sessionId }
  await inv('workspace:refresh')

  // --- The header (#974): Active · Resume · Stop (2) · Agents ▾ · ⋯ (two running, one stopped with a session to resume;
  // all three have one to archive), and its state line from the agents' marks.
  const header = page.locator('.project-header .actions')
  const labels = async () => (await header.locator('button').allInnerTexts()).map((t) => t.trim()).filter(Boolean)
  check('the header shows Resume Agent, Stop (2) and Agents, in that order', !!(await until(async () => JSON.stringify(await labels()) === JSON.stringify(['Resume Agent', 'Stop (2)', 'Agents']), 5000)), JSON.stringify(await labels()))
  const stateLine = page.locator('.project-header .project-state')
  check('its state line: 1 working · 1 idle · 1 stopped (the idle ones and the stopped apart, #1035), with the working mark', !!(await until(async () => (await stateLine.innerText().catch(() => '')).trim() === '1 working · 1 idle · 1 stopped' && (await stateLine.locator('.state-mark.working').count()) === 1, 5000)), await stateLine.innerText().catch(() => ''))
  const tipOf = async (name) => {
    await header.getByRole('button', { name, exact: true }).hover()
    const tip = page.locator('.tip')
    await tip.waitFor({ timeout: 3000 }).catch(() => undefined)
    const t = (await tip.count()) ? (await tip.innerText()).trim() : null
    await page.mouse.move(0, 0)
    await lib.until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
    return t
  }
  // Short labels, the full wording in the tooltip and the accessible name (#1035).
  check('the tooltips and accessible names keep the full meaning', (await tipOf('Stop all 2 running agents')) === 'Stop all 2 running agents' && /Actions on all the project's agents/.test((await tipOf('Agents')) ?? ''), `${await tipOf('Stop all 2 running agents')} / ${await tipOf('Agents')}`)
  // Quiet (#1035): Resume and Stop look like Agents ▾ (its fill, no coloured edge), their colour on the icon; Stop's wash on hover.
  const look = (sel) =>
    header.locator(sel).evaluate((b) => {
      const css = getComputedStyle(b)
      return { bg: css.backgroundColor, border: css.borderColor, color: css.color, icon: getComputedStyle(b.querySelector('.codicon')).color }
    })
  const agentsLook = await look('button.agents-menu')
  const stopLook = await look('button.act-stop')
  const resumeLook = await look('button.act-resume')
  check("Resume and Stop wear Agents ▾'s quiet style, their colour on the icon only", [stopLook, resumeLook].every((l) => l.bg === agentsLook.bg && l.border === agentsLook.border && l.color === agentsLook.color && l.icon !== l.color), JSON.stringify({ agentsLook, stopLook, resumeLook }))
  await header.locator('button.act-stop').hover()
  check("…and Stop's red wash shows on hover", !!(await until(async () => {
    const l = await look('button.act-stop')
    return l.bg !== agentsLook.bg && l.border !== agentsLook.border
  }, 5000)), JSON.stringify(await look('button.act-stop')))
  await page.mouse.move(0, 0)
  check('no Explorer or Terminal button in the header', (await header.locator('button', { hasText: /Explorer|Terminal/ }).count()) === 0)
  // Agents ▾: the batch actions with their counts, Start Fresh (Idle Agents)… after Start New (#1437), Remove All last
  // after a line; each in its action's colour (#344).
  check('Agents ▾ has Start New (3), Start Fresh (Idle Agents)…, Archive and Start New (3) and Remove All (3)…', JSON.stringify(await lib.agentsMenu(page)) === JSON.stringify(['Start New (3)', 'Start Fresh (Idle Agents)…', 'Archive and Start New (3)', 'Remove All (3)…']), JSON.stringify(await lib.agentsMenu(page)))
  const acts = () => page.locator('.menu .menu-item').evaluateAll((items) => items.map((m) => [...m.classList].find((c) => c.startsWith('act-')) ?? 'none'))
  check("each entry wears its action's colour", JSON.stringify(await acts()) === JSON.stringify(['act-start', 'act-start', 'act-archive-start', 'act-remove']), JSON.stringify(await acts()))
  check('…with a line before Remove All', !!(await page.locator('.menu > *').evaluateAll((els) => els.at(-2)?.classList.contains('menu-sep'))))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, 5000)
    await page.screenshot({ path: path.join(lib.WORK, `startall-header-${theme}.png`), clip: { x: 0, y: 0, width: 1500, height: 260 } })
  }
  await page.keyboard.press('Escape')
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // From the keyboard (#974): Enter on Agents ▾ opens it with the focus in the menu, its chosen entry named as the active
  // descendant (what a screen reader announces) and the button expanded; ↓ moves it; Escape closes it and gives the focus
  // back to the button.
  const agentsButton = page.locator('.project-header .agents-menu')
  await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
  await agentsButton.focus()
  await page.keyboard.press('Enter')
  const focusState = () =>
    page.evaluate(() => {
      const f = document.activeElement
      const id = f?.getAttribute('aria-activedescendant')
      const chosen = id ? document.getElementById(id) : null
      return { role: f?.getAttribute('role') ?? f?.tagName, chosen: chosen?.getAttribute('role') === 'menuitem' ? chosen.innerText.trim() : null, expanded: document.querySelector('.project-header .agents-menu')?.getAttribute('aria-expanded'), onButton: f?.classList.contains('agents-menu') ?? false }
    })
  const opened = await lib.until(async () => {
    const f = await focusState()
    return f.role === 'menu' && f.chosen === 'Start New (3)' && f.expanded === 'true' ? f : null
  }, HUNG_MS)
  check('Enter on Agents ▾: the focus is in the menu, on Start New (3) as its active descendant, the button expanded', !!opened, JSON.stringify(await focusState()))
  await page.keyboard.press('ArrowDown')
  check('↓: the active descendant is Start Fresh (Idle Agents)…', !!(await lib.until(async () => (await focusState()).chosen === 'Start Fresh (Idle Agents)…', HUNG_MS)), JSON.stringify(await focusState()))
  await page.keyboard.press('Escape')
  check('Escape: the menu closes, the focus back on Agents ▾, no longer expanded', !!(await lib.until(async () => {
    const f = await focusState()
    return (await page.locator('.menu').count()) === 0 && f.onButton && f.expanded === 'false'
  }, HUNG_MS)), JSON.stringify(await focusState()))
  await page.evaluate(() => document.activeElement?.blur())
  // Narrower: the actions turn to icons (named for screen readers and in their tooltips) and the title gives way; at the
  // narrowest window Combwork supports (900 px, sidebar and rails open), every action is inside the header, on screen and
  // the thing under its own centre, in both themes. With the Assistant's panel open too, Agents ▾'s actions go into ⋯.
  // Every action found and read in one evaluation in the page, so a refold (the Assistant opening) can't leave a stale or
  // detached control between the two (a locator's evaluateAll queries first, then evaluates).
  const actionsAt = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.project-header .actions button, .project-header .actions label')]
        .filter((el) => !(el.tagName === 'BUTTON' && el.closest('label')))
        .map((el) => {
          const r = el.getBoundingClientRect()
          const h = el.closest('.project-header').getBoundingClientRect()
          const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return { width: Math.round(h.width), name: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim(), inside: r.left >= h.left - 0.5 && r.right <= h.right + 0.5 && r.right <= window.innerWidth, hit: !!t && (t === el || el.contains(t)) }
        })
    )
  const allReachable = (list) => list.length > 0 && list.every((a) => a.inside && a.hit)
  await lib.fitWindow(app, page, { width: 1020, height: 900 })
  check('narrow (1020 px): every action is in the header and clickable', !!(await lib.until(async () => allReachable(await actionsAt()), 5000)), JSON.stringify(await actionsAt()))
  await page.screenshot({ path: path.join(lib.WORK, 'startall-header-narrow.png'), clip: { x: 0, y: 0, width: 1020, height: 120 } })
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.fitWindow(app, page, { width: 900, height: 900 })
    const names = ['Active', "Resume Stopped's last session", 'Stop all 2 running agents', 'Agents', 'More actions']
    const at = (await lib.until(async () => {
      const a = await actionsAt()
      return JSON.stringify(a.map((x) => x.name)) === JSON.stringify(names) && allReachable(a) ? a : null
    }, 5000)) || (await actionsAt())
    check(`${theme}, 900 px: Active, Resume, Stop (2), Agents ▾ and ⋯ are all in the header and clickable`, JSON.stringify(at.map((a) => a.name)) === JSON.stringify(names) && allReachable(at), JSON.stringify(at))
    check(`${theme}, 900 px: the header keeps one row`, (await page.locator('.project-header').evaluate((el) => el.getBoundingClientRect().height)) < 48)
    await page.screenshot({ path: path.join(lib.WORK, `startall-header-900-${theme}.png`), clip: { x: 0, y: 0, width: 900, height: 120 } })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // Really clicked at 900 px: Start New asks (Cancel), and ⋯ opens with Explorer and Terminal.
  await lib.agentsMenuRun(page, 'Start New (3)')
  const asked = page.locator('.dialog', { hasText: 'Start new sessions for all agents?' })
  check('900 px: Start New opens its question', !!(await lib.until(async () => (await asked.count()) === 1, 5000)))
  await asked.getByRole('button', { name: 'Cancel' }).click()
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, 5000)
  const narrowItems = (await menuRows()).map((r) => r.split('=')[0])
  check('900 px: ⋯ opens with Explorer and Terminal first', JSON.stringify(narrowItems.slice(0, 2)) === JSON.stringify(['Explorer', 'Terminal']), JSON.stringify(narrowItems))
  await page.keyboard.press('Escape')
  // Squeezed further (#1051), the header stays one row: Agents ▾'s actions, then Active, go into ⋯ and the status keeps
  // its most urgent count; narrowest, Resume and Stop go too, leaving the name, the status and ⋯. ⋯ lists what folded
  // away first, in the header's order. Never a second row of controls above the name.
  const menuNames = async () => {
    await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
    await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, 5000)
    const names = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.split('\n')[0].trim())
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.menu').count()) === 0, 5000)
    return names
  }
  const oneRow = () => page.locator('.project-header').evaluate((el) => el.getBoundingClientRect().height < 48)
  const statusText = () => page.locator('.project-header .badge-text').innerText().catch(() => '')
  const toggleProgress = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', { type: 'menu-command', command: 'progress.toggle', args: [] }))
  // The Progress panel open at 900 px: the header about 265 px.
  await page.evaluate(() => document.activeElement?.blur())
  await toggleProgress()
  // As far as this status needs (here "1 working · 1 idle · 1 stopped", so all the way): Active in ⋯, and Resume and
  // Stop each in the header or in ⋯ (never both, never lost), ⋯ last in the row.
  const RUN = ["Resume Stopped's last session", 'Stop all 2 running agents']
  const at265 = (await lib.until(async () => {
    const a = await actionsAt()
    return a.at(-1)?.name === 'More actions' && !a.some((x) => x.name === 'Active') && allReachable(a) && (await oneRow()) ? a : null
  }, 5000)) || (await actionsAt())
  check('900 px with the Progress panel (~265 px): one row, Active gone from it, the rest and ⋯ reachable', at265.at(-1)?.name === 'More actions' && !at265.some((x) => x.name === 'Active') && allReachable(at265) && (await oneRow()), JSON.stringify(at265))
  check('…the status its most urgent count only, the rest in its tooltip', !(await statusText()).includes('·') && (await statusText()).length > 0, await statusText())
  const items265 = await menuNames()
  const folded = RUN.filter((n) => !at265.some((x) => x.name === n))
  check("…⋯ starts with Active, then what of Resume and Stop left the row, then Agents ▾'s actions", JSON.stringify(items265.slice(0, 5 + folded.length)) === JSON.stringify(['Active', ...folded, 'Start New (3)', 'Start Fresh (Idle Agents)…', 'Archive and Start New (3)', 'Remove All (3)…']), JSON.stringify({ items265, row: at265.map((x) => x.name) }))
  await page.screenshot({ path: path.join(lib.WORK, 'startall-header-265.png'), clip: { x: 0, y: 0, width: 900, height: 120 } })
  await toggleProgress()
  // The Assistant's panel open too (a main area of about a hundred pixels): only ⋯ is left beside the name.
  await page.keyboard.press('Control+Alt+I')
  const cramped = (await lib.until(async () => {
    const a = await actionsAt()
    return a.length === 1 && a[0].name === 'More actions' && allReachable(a) && (await oneRow()) ? a : null
  }, 5000)) || (await actionsAt())
  check('900 px with the Assistant open (a squeezed main area): one row, only ⋯ beside the name, reachable', cramped.length === 1 && cramped[0].name === 'More actions' && allReachable(cramped) && (await oneRow()), JSON.stringify(cramped))
  const crampedItems = await menuNames()
  check("…⋯ starts with Active, Resume and Stop, then Agents ▾'s actions", JSON.stringify(crampedItems.slice(0, 7)) === JSON.stringify(['Active', "Resume Stopped's last session", 'Stop all 2 running agents', 'Start New (3)', 'Start Fresh (Idle Agents)…', 'Archive and Start New (3)', 'Remove All (3)…']), JSON.stringify(crampedItems))
  await page.screenshot({ path: path.join(lib.WORK, 'startall-header-cramped.png') })
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.until(async () => (await page.locator('.project-header .agents-menu').count()) === 1, 5000)

  // --- ⋯: Explorer, Terminal, Remove Project… (Changes is a tab; Project Settings is More ▾'s, HI-2551), each with its
  // command's keys where it has some: Terminal's by default, and a key given to Remove Project shows too.
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, 5000)
  const items = await menuRows()
  check('⋯ has Explorer, Terminal (Ctrl+Shift+`) and Remove Project…, without Changes or Project Settings', JSON.stringify(items) === JSON.stringify(['Explorer=', 'Terminal=Ctrl+Shift+`', '-', 'Remove Project…=']), JSON.stringify(items))
  await page.screenshot({ path: path.join(lib.WORK, 'startall-project-menu.png') })
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.menu').count()) === 0, 5000)
  await inv('settings:setKeybinding', 'project.remove', 'Ctrl+Alt+Shift+R')
  await lib.until(async () => (await inv('settings:get')).keybindings['project.remove'] === 'Ctrl+Alt+Shift+R', HUNG_MS)
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, 5000)
  const rebound = await menuRows()
  check("…a key given to Remove Project shows on it (the user's overrides apply)", rebound.at(-1) === 'Remove Project…=Ctrl+Alt+Shift+R', JSON.stringify(rebound))
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.menu').count()) === 0, 5000)
  await inv('settings:setKeybinding', 'project.remove', undefined)

  // --- Menus: the Project menu lists every tab in the strip's order; the Session menu has both new actions.
  const menuItems = async (name) => {
    await page.locator('.menubar .menubar-item', { hasText: name }).click()
    await lib.sleep(250)
    const t = await page.locator('.menu .menu-item > span:not(.menu-key)').allInnerTexts()
    await page.keyboard.press('Escape')
    return t.map((x) => x.trim())
  }
  const project = await menuItems('Project')
  const tabs = project.filter((t) => t.startsWith('Go to '))
  check('the Project menu lists the 13 tabs in the strip order, and Project Settings', JSON.stringify(tabs) === JSON.stringify(['Session', 'Overview', 'Performance', 'Tasks', 'Sessions', 'Files', 'Attachments', 'Version Control', 'Activity', 'Memory', 'Skills', 'Templates', 'MCP', 'Project Settings'].map((t) => `Go to ${t}`)), JSON.stringify(tabs))
  check('and Explorer and Terminal', project.some((t) => /Explorer/.test(t)) && project.some((t) => /Terminal/.test(t)), JSON.stringify(project))
  const session = await menuItems('Session')
  check('the Session menu has Start New (3)… and Archive and Start New (3)…', session.includes('Start New (3)…') && session.includes('Archive and Start New (3)…') && session.includes('Archive Session and Start New…'), JSON.stringify(session))
  const palette = async () => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').fill('Start New')
    await lib.sleep(300)
    const found = await page.locator('.palette-item').allInnerTexts()
    // The palette's first Escape clears what was typed (#433), the next closes it.
    await page.keyboard.press('Escape')
    if (await page.locator('.palette').count()) await page.keyboard.press('Escape')
    return found
  }
  const found = await palette()
  check('the palette has both, with their counts', found.some((t) => t.includes('Start New (3)…')) && found.some((t) => t.includes('Archive and Start New (3)…')), JSON.stringify(found))

  // --- The session toolbar beside them (#975: the agent strip went): its summary chip counts every agent, idle ones too.
  const chipText = () => page.locator('.session-toolbar .summary-chip-text').innerText().catch(() => '')
  check("the summary chip: 1 working · 1 idle · 1 stopped, as the header (HI-1908)", !!(await until(async () => (await chipText()) === '1 working · 1 idle · 1 stopped', HUNG_MS)), await chipText())
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await page.locator('.session-toolbar').screenshot({ path: path.join(lib.WORK, `startall-toolbar-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.mouse.move(0, 0)

  // The confirms' agents are a table (#572): each row's cells by its agent's name; the plain lines stay for screen readers.
  const tableOf = (d) =>
    d.locator('table.agents-table').evaluate((t) => ({
      heads: [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim()),
      rows: Object.fromEntries([...t.querySelectorAll('tbody tr[data-agent]')].map((r) => [r.dataset.agent, [...r.children].map((c) => ({ text: c.textContent.trim(), warn: c.classList.contains('agents-table-warn') }))])),
      hidden: t.closest('[aria-hidden="true"]') !== null
    }))
  const plainLines = (d) => d.locator('.agents-detail .visually-hidden').innerText()
  const bothThemes = async (name) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await page.screenshot({ path: path.join(lib.WORK, `${name}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  // --- Stop (2): the running agents as a table, Agent · State · Card, its card named; Cancel changes nothing.
  const card = (await inv('tasks:create', { title: 'Batch tables', project: 'alpha', column: 'doing', agent: w.id })).number
  // Once the window's board has it: the Worker's pane header shows the card.
  await until(async () => (await lib.paneHeader(page, 'Worker').innerText().catch(() => '')).includes(await lib.cardLabel(inv, card)), HUNG_MS)
  // Idle reviews another card (started with its own token, as its CLI would): its row says "reviewing #n …".
  const reviewed = (await inv('tasks:create', { title: 'Review table', project: 'alpha', column: 'review', agent: s.id })).number
  // The cards by key, as the window names them (#1221).
  const [cardName, reviewedName] = [await lib.cardLabel(inv, card), await lib.cardLabel(inv, reviewed)]
  const launches = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const idleToken = launches().filter((l) => l.sessionId === before.i).at(-1)?.token
  const startReview = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${reviewed}`, { method: 'PATCH', headers: { Authorization: `Bearer ${idleToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ review: 'start' }) })
  check('Idle starts reviewing a card', !!idleToken && startReview.status === 200, `${!!idleToken} ${startReview.status}`)
  await until(async () => (await lib.paneHeader(page, 'Idle').innerText().catch(() => '')).includes(reviewedName), HUNG_MS)
  // What a screen reader gets: the accessibility tree's text (the table is hidden from it, so a cell is never said twice).
  const cdp = await page.context().newCDPSession(page)
  const axTexts = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes.filter((n) => !n.ignored).map((n) => n.name?.value ?? '')
  const stopDialog = page.locator('.dialog', { hasText: 'Stop all agents?' })
  await header.getByRole('button', { name: 'Stop all 2 running agents', exact: true }).click()
  await stopDialog.waitFor({ timeout: 5000 })
  const stopTable = await tableOf(stopDialog)
  check('Stop all lists the running agents as a table: Agent, State, Card', JSON.stringify(stopTable.heads) === JSON.stringify(['Agent', 'State', 'Card']) && JSON.stringify(Object.keys(stopTable.rows).sort()) === JSON.stringify(['Idle', 'Worker']), JSON.stringify(stopTable))
  check("…the Worker's card in its row, and the one Idle reviews in its", stopTable.rows.Worker?.[2]?.text === `${cardName} Batch tables` && /Working/.test(stopTable.rows.Worker?.[1]?.text ?? '') && stopTable.rows.Idle?.[2]?.text === `reviewing ${reviewedName} Review table`, JSON.stringify(stopTable.rows))
  const stopAx = await axTexts()
  check('…a screen reader gets each card too, the reviewed one as such', stopAx.some((t) => t.includes(`• Worker — Working`) && t.includes(`card ${cardName} Batch tables`)) && stopAx.some((t) => t.includes(`• Idle — `) && t.includes(`card reviewing ${reviewedName} Review table`)), JSON.stringify(stopAx.filter((t) => t.includes('•'))))
  // The table itself is out of the accessibility tree, so no cell of it is said twice.
  const tableIgnored = async () => {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.dialog table.agents-table' })
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })
    return nodes.length > 0 && nodes.every((n) => n.ignored)
  }
  check('…and the table itself is ignored by screen readers, so nothing is said twice', (await tableIgnored()) && !stopAx.includes(`${cardName} Batch tables`), JSON.stringify(stopAx.filter((t) => /Batch tables/.test(t))))
  check('…the table hidden from screen readers, its plain lines for them instead, and the note under it', stopTable.hidden && /• Worker — Working/.test(await plainLines(stopDialog)) && /conversations are kept/.test(await stopDialog.locator('.agents-detail-note').innerText()))
  await bothThemes('startall-stop-confirm')
  await stopDialog.getByRole('button', { name: 'Cancel' }).click()
  await stopDialog.waitFor({ state: 'detached', timeout: 5000 })
  check('…and Cancel stops nobody', (await live(w.id))?.status === 'working' && !!(await live(i.id)))

  // --- Start New (All): one question listing every agent, the working one flagged; Cancel changes nothing.
  const dialog = page.locator('.dialog', { hasText: 'Start new sessions for all agents?' })
  await lib.agentsMenuRun(page, 'Start New (3)')
  await dialog.waitFor({ timeout: 5000 })
  const text = await dialog.innerText()
  check('it lists every agent, flagging the working one', /Worker — Working.*\(will be interrupted\)/.test(text) && /Idle — /.test(text) && /Stopped — Not running · A new session/.test(text), text)
  const newTable = await tableOf(dialog)
  const newAx = await axTexts()
  check('…a screen reader gets each agent with its card and what happens to it', newAx.some((t) => t.includes(`• Worker — Working`) && t.includes(`card ${cardName} Batch tables`) && t.includes('Stopped (will be interrupted), then a new session')) && newAx.some((t) => t.includes(`card reviewing ${reviewedName} Review table`)), JSON.stringify(newAx.filter((t) => t.includes('•'))))
  check('…as a table: Agent, State, Card, What happens', JSON.stringify(newTable.heads) === JSON.stringify(['Agent', 'State', 'Card', 'What happens']) && Object.keys(newTable.rows).length === 3, JSON.stringify(newTable))
  check('…the working one stopped first, in the warning colour; the stopped one only starts', newTable.rows.Worker?.[3]?.text === 'Stopped (will be interrupted), then a new session' && newTable.rows.Worker[3].warn && newTable.rows.Stopped?.[3]?.text === 'A new session' && !newTable.rows.Stopped[3].warn && newTable.rows.Stopped?.[1]?.text === 'Not running', JSON.stringify(newTable.rows))
  await bothThemes('startall-confirm')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await lib.sleep(1500) // on purpose: nothing may stop or start after Cancel
  check('Cancel changes nothing', (await live(w.id))?.sessionId === before.w && (await live(w.id))?.status === 'working' && (await live(i.id))?.sessionId === before.i && !(await live(s.id)))
  await lib.agentsMenuRun(page, 'Start New (3)')
  await dialog.waitFor({ timeout: 5000 })
  await dialog.getByRole('button', { name: 'Start new' }).click()
  const fresh = await until(async () => {
    const l = await Promise.all([w, i, s].map((a) => live(a.id)))
    return l.every((x) => x && ['ready', 'waiting'].includes(x.status)) && l[0].sessionId !== before.w && l[1].sessionId !== before.i ? l : null
  }, 30000)
  check('every agent has a new session', !!fresh, JSON.stringify(await Promise.all([w, i, s].map((a) => live(a.id)))))
  const list = await sessions()
  check('the old sessions are kept, not archived', [before.w, before.i].every((id) => list.some((x) => x.id === id && !x.archived)), JSON.stringify(list.map((x) => [x.id.slice(0, 8), x.archived])))

  // --- Archive and Start New (All): each agent's session archived, fresh ones started.
  for (const a of [w, i, s]) {
    if ((await live(a.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, a.id), '\r')
    await until(async () => (await live(a.id))?.status === 'ready', HUNG_MS)
    await type(a.id, 'hello')
    await until(async () => (await live(a.id))?.status === 'finished', HUNG_MS)
  }
  const current = Object.fromEntries(await Promise.all([w, i, s].map(async (a) => [a.id, (await live(a.id)).sessionId])))
  await type(w.id, 'work 120')
  await until(async () => (await live(w.id))?.status === 'working', HUNG_MS)
  // The dialog lists the window's agent states, which follow main's within a batch (HI-1806): once its chip says so (HI-1845).
  await until(async () => /^1 working\b/.test(await chipText()), HUNG_MS)
  const archiveDialog = page.locator('.dialog', { hasText: 'Archive and start new for all agents?' })
  await lib.agentsMenuRun(page, 'Archive and Start New (3)')
  await archiveDialog.waitFor({ timeout: 5000 })
  const arcappText = await archiveDialog.innerText()
  const archiveTable = await tableOf(archiveDialog)
  check('Archive lists them as a table too, saying each session is archived', archiveTable.rows.Worker?.[3]?.text === 'Stopped (will be interrupted), then its session archived, then a new one' && Object.keys(archiveTable.rows).length === 3, JSON.stringify(archiveTable.rows))
  check('Archive asks once, listing the agents with sessions, the working one flagged', /Worker — Working.*\(will be interrupted\)/.test(arcappText) && /Idle — /.test(arcappText) && /Stopped — /.test(arcappText) && /\.combwork\/archive/.test(arcappText), arcappText)
  await archiveDialog.getByRole('button', { name: 'Archive and start new' }).click()
  const renewed = await until(async () => {
    const l = await Promise.all([w, i, s].map((a) => live(a.id)))
    return l.every((x) => x && x.sessionId !== current[x.agentId] && ['ready', 'waiting'].includes(x.status))
  }, 30000)
  check('every agent has a fresh session', !!renewed)
  const after = await sessions()
  const archivedIds = Object.values(current).filter((id) => after.some((x) => x.id === id && x.archived))
  check("each agent's session was archived", archivedIds.length === 3, JSON.stringify(after.map((x) => [x.id.slice(0, 8), x.archived])))
  check('in .combwork/archive', fs.existsSync(path.join(alpha, '.combwork', 'archive')) && fs.readdirSync(path.join(alpha, '.combwork', 'archive'), { recursive: true }).length > 0)
  check('no failure notice', (await page.locator('.toast.error').count()) === 0)

  // --- The counts follow the agents (#275): Idle and Stopped stop (after an exchange, so each has a session to resume).
  for (const a of [i, s]) {
    if ((await live(a.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, a.id), '\r')
    await until(async () => (await live(a.id))?.status === 'ready', HUNG_MS)
    await type(a.id, 'hello')
    await until(async () => (await live(a.id))?.status === 'finished', HUNG_MS)
    await inv('session:stop', alpha, a.id)
    await until(async () => !(await live(a.id)), HUNG_MS)
  }
  await inv('workspace:refresh')
  check('one running, two to resume: Resume (2), Stop Agent, Agents', !!(await until(async () => JSON.stringify(await labels()) === JSON.stringify(['Resume (2)', 'Stop Agent', 'Agents']), 10000)), JSON.stringify(await labels()))
  check('…and Resume says it in full in its tooltip and accessible name', (await tipOf('Resume all 2 stopped agents')) === 'Resume all 2 stopped agents')
  // The count is what the question lists.
  await lib.agentsMenuRun(page, 'Archive and Start New (3)')
  await archiveDialog.waitFor({ timeout: 5000 })
  const listed = (await archiveDialog.innerText()).split('\n').filter((l) => l.startsWith('• '))
  check('Archive and Start New (3) lists 3 agents', listed.length === 3, JSON.stringify(listed))
  await archiveDialog.getByRole('button', { name: 'Cancel' }).click()
  // Idle resumes: two running again, one to resume.
  await header.getByRole('button', { name: 'Resume all 2 stopped agents' }).waitFor({ timeout: 5000 })
  const idleSession = (await inv('session:list', alpha)).find((x) => x.agentId === i.id && !x.archived && x.id !== current[i.id])
  await inv('session:start', alpha, { agentId: i.id, resumeId: idleSession?.id })
  check('Idle resumed: Resume Agent, Stop (2)', !!(await until(async () => JSON.stringify((await labels()).slice(0, 2)) === JSON.stringify(['Resume Agent', 'Stop (2)']), 15000)), JSON.stringify(await labels()))

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
