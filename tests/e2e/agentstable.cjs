// A project's agents as a table (#529), on fake Claude Code agents: the project tile's tooltip in the compact sidebar,
// the agent count and status in the full one, and the project header's status show a table (Agent with its status dot,
// Role in the workflow (#1430), State, Card cut to one line, Waiting for), a lane's builder beside its reviewer, with 12 agents (working, waiting on a
// background task, watching a card, idle, not running) and with 1 (on a card, and with none); the tooltip never scrolls,
// every column fits inside it, also narrow and zoomed with a long agent name (cut with an ellipsis); Tab reaches the
// tile, the sidebar status and the header badge, each showing the table and describing its rows to a screen reader (the
// accessibility tree), and Enter on the tile opens the project. Screenshots in both themes. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const PORT = Number(lib.port(47867))
const userData = path.join(lib.WORK, 'agentstable-profile')
const ws = path.join(lib.WORK, 'agentstable-ws')
const claudeHome = path.join(lib.WORK, 'agentstable-claude-home')
const shots = path.join(lib.WORK, 'agentstable-shots')
const alpha = path.join(ws, 'alpha')
const solo = path.join(ws, 'solo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = 15000) => lib.until(fn, ms, 150)
const LONG = 'Coordinator out of the box: fold the coordinator playbook into the Assistant mode and its skills, with a long title that wraps'

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(solo)
  const cenv = lib.fakeClaude(userData, claudeHome, [alpha, solo])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), ...cenv, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  for (const p of [alpha, solo]) await inv('project:setActive', p, true)
  await lib.waitForProvider(inv)
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  // --- Twelve agents in alpha, added builders first (the table pairs them by lane), and one in solo.
  const names = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6']
  const a = {}
  for (const n of names) a[n] = await lib.addAgent(inv, alpha, { name: n })
  const one = await lib.addAgent(inv, solo, { name: 'Solo' })
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const status = async (n) => (await live(a[n].id))?.status
  const say = (n, text, want) => lib.sendPrompt(inv, lib.ptyKey(alpha, a[n].id), text, { submitted: async () => (await status(n)) === want })
  for (const n of ['B1', 'B2', 'R1', 'R2']) await inv('session:start', alpha, { agentId: a[n].id })
  const ready = async () => (await Promise.all(['B1', 'B2', 'R1', 'R2'].map((n) => live(a[n].id)))).every((s) => s?.status === 'ready')
  check('four agents start', !!(await until(ready, 45000)))

  // The board: B1 on a card with a long title, B3 (not running) on another, R1 watching B1's for Review; solo's agent on one.
  // Each card's name as the window gives it (#1221): its key. What a watch waits for too (HI-1679: the window words a watch itself, never its English label).
  const keyOf = new Map()
  const K = (n) => keyOf.get(n) ?? `#${n}`
  const make = async (title, agent, project = 'alpha') => {
    const c = await inv('tasks:create', { title, project, column: 'doing', agent })
    keyOf.set(c.number, c.key)
    return c.number
  }
  const c1 = await make(LONG, a.B1.id)
  const c3 = await make('Lane C docs', a.B3.id)
  const cs = await make('Solo card', one.id, 'solo')
  // Lanes: B1 with R1, B2 with R2 (started with the workspace's token, naming the builder). Idle builders outside slots,
  // B1 and B2 get their lanes in new conversations (HI-2232), each taking the lane's brief as its first turn: quiet first
  // (idle, nothing of Combwork's being typed into them or waiting to be), so each is renewed at once, never left as it is
  // mid-turn nor owed; then done with their briefs in the new conversations before the suite types into them (HI-2247;
  // quiet alone isn't the brief's turn over, and a line typed during it is dropped: HI-2357, lib.laneBriefDone).
  const quiet = async (n) => lib.agentQuiet(PORT, 'alpha', await live(a[n].id), apiToken)
  const builders = ['B1', 'B2']
  check('B1 and B2 are quiet before their lanes', !!(await until(async () => (await Promise.all(builders.map(quiet))).every(Boolean), 45000)), JSON.stringify(await Promise.all(builders.map((n) => live(a[n].id)))))
  const before = Object.fromEntries(await Promise.all(builders.map(async (n) => [n, (await live(a[n].id))?.sessionId])))
  const l1 = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'B1', reviewer: 'R1', cards: [c1] })
  const l2 = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'B2', reviewer: 'R2', cards: [c3] })
  check('the lanes start', l1.status === 200 && l2.status === 200, JSON.stringify([l1, l2]))
  const renewed = async (n) => lib.laneBriefDone(PORT, 'alpha', await live(a[n].id), before[n], apiToken)
  check('…B1 and B2 in new conversations, done with their briefs', !!(await until(async () => (await Promise.all(builders.map(renewed))).every(Boolean), 45000)), JSON.stringify(await Promise.all(builders.map((n) => live(a[n].id)))))

  check('B1 works', (await say('B1', 'work 600', 'working')) > 0)
  check('B2 waits on a background task', (await say('B2', 'background 600', 'background')) > 0)
  check('R1 watches B1’s card', (await say('R1', `hive cw_wait_for_tasks ${JSON.stringify({ cards: [c1], column: 'review', wake: true, limitMinutes: 60 })}`, 'watching')) > 0)
  check('R2 is idle', (await status('R2')) === 'ready')

  const shoot = async (name, clip) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await until(async () => (await page.locator('.tip.agents-tip').count()) === 1, HUNG_MS)
      await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`), ...(clip ? { clip } : {}) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  /** What the agents table's tooltip shows, and whether everything in it fits (null when none is shown). */
  const readTable = () =>
    page.evaluate(() => {
      const tip = document.querySelector('.tip.agents-tip')
      const t = tip?.querySelector('table.agents-table')
      if (!tip || !t) return null
      const r = tip.getBoundingClientRect()
      const style = getComputedStyle(tip)
      const inner = { left: r.left + parseFloat(style.paddingLeft) - 0.5, right: r.right - parseFloat(style.paddingRight) + 0.5 }
      const cells = (tr) => [...tr.children].map((td) => td.textContent.trim())
      const cut = (sel) => [...t.querySelectorAll(sel)].filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.closest('tr').dataset.agent)
      return {
        head: cells(t.querySelector('thead tr')),
        rows: [...t.querySelectorAll('tbody tr')].map((tr) => ({ name: tr.dataset.agent, cells: cells(tr), dot: tr.querySelector('.dot')?.className ?? '' })),
        // A cut cell: its text is wider than the room it has (shown with an ellipsis).
        cut: cut('.agents-table-card > span'),
        cutNames: cut('.agents-table-name > span'),
        ellipsis: [...t.querySelectorAll('.agents-table-cut > span')].every((x) => getComputedStyle(x).textOverflow === 'ellipsis'),
        scrolls: tip.scrollHeight > tip.clientHeight + 1 || tip.scrollWidth > tip.clientWidth + 1,
        // Every header and cell inside the tooltip's content box: no column cut off.
        outside: [...t.querySelectorAll('th, td')].filter((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && (b.left < inner.left || b.right > inner.right) }).map((c) => c.textContent.trim().slice(0, 20)),
        inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        clipped: tip.classList.contains('clipped'),
        width: Math.round(r.width)
      }
    })
  /** Hovers something and waits for the agents table's tooltip; returns what it shows. */
  const hoverTable = async (locator) => {
    // Nothing focused (a focused trigger keeps its tooltip shown), the mouse away.
    await page.evaluate(() => document.activeElement?.blur?.())
    await page.mouse.move(700, 500)
    await until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
    await locator.hover()
    await until(async () => (await page.locator('.tip.agents-tip table.agents-table').count()) === 1, 5000)
    return readTable()
  }
  /** The accessibility tree's node for the focused element: its role, name and description, as a screen reader gets them. */
  const cdp = await page.context().newCDPSession(page)
  const focusedAx = async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement' })
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false })
    const n = nodes[0]
    return n ? { role: n.role?.value, name: n.name?.value ?? '', description: n.description?.value ?? '' } : null
  }
  const fits = (t) => !!t && !t.scrolls && t.inside && !t.clipped && t.outside.length === 0
  const fitText = (t) => JSON.stringify(t && { scrolls: t.scrolls, inside: t.inside, clipped: t.clipped, outside: t.outside, width: t.width })
  // A row's cells, past its Role (#1430: a project's table has it, the status bar's doesn't): name, state, card, waits.
  const row = (t, n) => {
    const c = t?.rows.find((r) => r.name === n)?.cells ?? []
    return t?.head[1] === 'Role' ? [c[0], ...c.slice(2)] : c
  }
  const roleOf = (t, n) => (t?.head[1] === 'Role' ? t.rows.find((r) => r.name === n)?.cells[1] : undefined)

  // --- The compact sidebar: the alpha tile's tooltip.
  await page.locator('.pane-header .icon-btn[aria-label^="Compact Sidebar"]').first().click()
  await until(async () => (await page.locator('.rail-project').count()) === 2, HUNG_MS)
  const tile = page.locator('.rail-project[aria-label^="alpha"]')
  const t12 = await hoverTable(tile)
  check('12 agents: a table with Agent, Role, State, Card and Waiting for', JSON.stringify(t12?.head) === JSON.stringify(['Agent', 'Role', 'State', 'Card', 'Waiting for']), JSON.stringify(t12?.head))
  check('…each with its role in the workflow (#1430): HB-style names build, R-named ones review', roleOf(t12, 'B1') === 'Builder' && roleOf(t12, 'R6') === 'Reviewer', JSON.stringify([roleOf(t12, 'B1'), roleOf(t12, 'R6')]))
  check('12 agents: a row each, a builder beside its reviewer (the lanes newest first, as in the Progress panel), then the rest', t12?.rows.map((r) => r.name).join(',') === 'B2,R2,B1,R1,B3,B4,B5,B6,R3,R4,R5,R6', t12?.rows.map((r) => r.name).join(','))
  check('working, with its card', row(t12, 'B1')[1] === 'Working…' && row(t12, 'B1')[2].startsWith(`${K(c1)} Coordinator`), JSON.stringify(row(t12, 'B1')))
  check('waiting on a background task', row(t12, 'B2')[1] === 'Waiting on 1 background task', JSON.stringify(row(t12, 'B2')))
  check('watching: what it waits for', row(t12, 'R1')[1] === 'Watching' && row(t12, 'R1')[3] === `${K(c1)} → Review`, JSON.stringify(row(t12, 'R1')))
  check('idle, with no card', row(t12, 'R2')[1] === 'Ready' && row(t12, 'R2')[2] === '—', JSON.stringify(row(t12, 'R2')))
  check('not running, on a card', row(t12, 'B3')[1] === 'Not running' && row(t12, 'B3')[2] === `${K(c3)} Lane C docs`, JSON.stringify(row(t12, 'B3')))
  check('each row has its status dot', ['working', 'background', 'watching', 'ready', 'stopped'].every((s, i) => t12?.rows.find((r) => r.name === ['B1', 'B2', 'R1', 'R2', 'B3'][i])?.dot.includes(s)), JSON.stringify(t12?.rows.slice(0, 5).map((r) => r.dot)))
  check('a long card title is cut to one line', JSON.stringify(t12?.cut) === '["B1"]', JSON.stringify(t12?.cut))
  check('the tooltip never scrolls, every column fits, it stays in the window', fits(t12), fitText(t12))
  const desc = (await tile.getAttribute('aria-description')) ?? ''
  check('the tile describes the same rows', desc.split('\n').length === 12 && desc.includes(`R1: Waiting for ${K(c1)} → Review`) && desc.includes('B2: Waiting on 1 background task'), desc)
  await shoot('rail-12')

  // --- Keyboard: Tab reaches the tile, which shows the table and has it in its accessible description; Enter opens it.
  await page.locator('.rail-project[aria-label^="solo"]').click()
  await until(async () => (await page.locator('.project-header h1', { hasText: 'solo' }).count()) === 1, HUNG_MS)
  await page.mouse.move(700, 500)
  await page.locator('.rail-btn[aria-label="Expand Sidebar"]').focus()
  await page.keyboard.press('Tab')
  check('Tab reaches the first project tile', !!(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')).startsWith('alpha'), HUNG_MS)))
  check('on keyboard focus it shows the table', !!(await until(async () => (await page.locator('.tip.agents-tip table.agents-table tbody tr').count()) === 12, 5000)))
  const ax = await focusedAx()
  check('a screen reader gets a button named for the project, with the rows as its description', ax?.role === 'button' && ax.name.startsWith('alpha') && ax.description.includes(`R1: Waiting for ${K(c1)} → Review`) && ax.description.includes('B3: Not running'), JSON.stringify(ax))
  await page.keyboard.press('Enter')
  check('Enter opens the project', !!(await until(async () => (await page.locator('.project-header h1', { hasText: 'alpha' }).count()) === 1, 5000)))

  // --- One agent (solo, its agent on a card, not running): one row, no Waiting for column.
  const t1 = await hoverTable(page.locator('.rail-project[aria-label^="solo"]'))
  check('1 agent: one row, no Waiting for', t1?.rows.length === 1 && row(t1, 'Solo')[2] === `${K(cs)} Solo card` && !t1.head.includes('Waiting for'), JSON.stringify(t1))
  check('1 agent: fits, never scrolls', fits(t1), fitText(t1))
  await shoot('rail-1')
  // …and without a card: still its table and its description.
  await inv('tasks:update', cs, { column: 'todo' })
  await until(async () => (await inv('tasks:list')).find((t) => t.number === cs)?.column === 'todo', 5000)
  const t0 = await hoverTable(page.locator('.rail-project[aria-label^="solo"]'))
  check('1 agent with no card: a table of one row', t0?.rows.length === 1 && row(t0, 'Solo')[1] === 'Not running' && row(t0, 'Solo')[2] === '—', JSON.stringify(t0?.rows))
  check('1 agent with no card: described', ((await page.locator('.rail-project[aria-label^="solo"]').getAttribute('aria-description')) ?? '') === 'Solo: Not running')
  await shoot('rail-1-nocard')

  // --- The full sidebar: the agent count, and the project header's status.
  await page.locator('.rail-btn[aria-label="Expand Sidebar"]').click()
  await until(async () => (await page.locator('.project-row').count()) === 2, HUNG_MS)
  const count = await hoverTable(page.locator('.project-row', { hasText: 'alpha' }).locator('.agent-count'))
  check('the agent count shows the same table', count?.rows.map((r) => r.name).join(',') === t12?.rows.map((r) => r.name).join(','), JSON.stringify(count?.rows.map((r) => r.name)))
  await shoot('sidebar-count')
  await page.locator('.project-row', { hasText: 'alpha' }).click()
  await until(async () => (await page.locator('.project-header h1', { hasText: 'alpha' }).count()) === 1, HUNG_MS)
  const header = await hoverTable(page.locator('.project-header .project-title .badge').first())
  check('the project header shows the same table', header?.rows.length === 12 && row(header, 'R1')[3] === `${K(c1)} → Review`, JSON.stringify(header?.rows.map((r) => r.cells)))
  await shoot('header')
  // The full sidebar's status and the header's badge on keyboard focus, each described.
  await page.mouse.move(700, 500)
  await until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
  const statusEl = page.locator('.project-row', { hasText: 'alpha' }).locator('.project-status')
  await page.locator('.project-row', { hasText: 'alpha' }).locator('.switch').focus()
  await page.keyboard.press('Shift+Tab')
  check('Shift+Tab reaches the sidebar status, which shows the table', !!(await until(async () => (await statusEl.evaluate((e) => e === document.activeElement)) && (await page.locator('.tip.agents-tip table.agents-table tbody tr').count()) === 12, 5000)))
  const axStatus = await focusedAx()
  check('…and is described', !!axStatus?.description.includes(`R1: Waiting for ${K(c1)} → Review`), JSON.stringify(axStatus))
  const badge = page.locator('.project-header .project-title .badge').first()
  await page.locator('.project-header h1').evaluate((e) => { e.tabIndex = -1; e.focus() })
  await page.keyboard.press('Tab')
  check('Tab reaches the header badge, which shows the table', !!(await until(async () => (await badge.evaluate((e) => e === document.activeElement)) && (await page.locator('.tip.agents-tip table.agents-table tbody tr').count()) === 12, 5000)))
  const axBadge = await focusedAx()
  check('…and is described', !!axBadge?.description.includes('B2: Waiting on 1 background task'), JSON.stringify(axBadge))

  // --- The status bar's running sessions (#572): the counts, then the running agents as a table, Agent · Project · State ·
  // Card · Waiting for, every column inside the tooltip; their plain-text lines as the item's description.
  const running = page.locator('.statusbar .status-item.running-sessions')
  const bar = await hoverTable(running)
  check("the status bar's running sessions show a table: Agent, Project, State, Card, Waiting for", JSON.stringify(bar?.head) === JSON.stringify(['Agent', 'Project', 'State', 'Card', 'Waiting for']), JSON.stringify(bar?.head))
  check('…of the four running agents, each with its project', JSON.stringify(bar?.rows.map((r) => r.name).sort()) === JSON.stringify(['B1', 'B2', 'R1', 'R2']) && bar.rows.every((r) => r.cells[1] === 'alpha'), JSON.stringify(bar?.rows))
  check('…B1 on its card, R1 waiting for it', row(bar, 'B1')[3].startsWith(`${K(c1)} `) && row(bar, 'R1')[4] === `${K(c1)} → Review`, JSON.stringify([row(bar, 'B1'), row(bar, 'R1')]))
  check('…the counts above it', /4 running session\(s\): 1 working, 1 waiting on background tasks/.test(await page.locator('.tip.agents-tip strong').first().innerText()))
  check('…every column inside the tooltip', fits(bar), fitText(bar))
  check('…and the item is described by its agents, a line each', new RegExp(`• B1 — in alpha · Working… · card ${K(c1)} `).test((await running.getAttribute('aria-description')) ?? '') && new RegExp(`• R1 — in alpha · Watching · waiting for ${K(c1)} → Review`).test((await running.getAttribute('aria-description')) ?? ''), await running.getAttribute('aria-description'))
  await shoot('statusbar-running')

  // --- Narrow and zoomed, with a long agent name: every column still fits, the long cells cut with an ellipsis.
  await inv('agents:update', alpha, a.B1.id, { name: 'Builder with a descriptive agent name' })
  await until(async () => (await page.locator('.pane-header-bar .agent-name', { hasText: 'Builder with a descriptive' }).count()) > 0, 5000)
  await lib.fitWindow(app, page, { width: 900, height: 560 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
  await until(async () => (await page.evaluate(() => Math.round(window.innerWidth))) === 720, 5000)
  await page.locator('.pane-header .icon-btn[aria-label^="Compact Sidebar"]').first().click()
  await until(async () => (await page.locator('.rail-project').count()) === 2, HUNG_MS)
  const narrow = await hoverTable(page.locator('.rail-project[aria-label^="alpha"]'))
  check('narrow at 125%: all five columns', JSON.stringify(narrow?.head) === JSON.stringify(['Agent', 'Role', 'State', 'Card', 'Waiting for']), JSON.stringify(narrow?.head))
  check('narrow at 125%: every column fits, nothing scrolls', fits(narrow), fitText(narrow))
  check('narrow at 125%: the long name and the long card are cut with an ellipsis', narrow?.cutNames.includes('Builder with a descriptive agent name') && narrow.cut.includes('Builder with a descriptive agent name') && narrow.ellipsis, JSON.stringify(narrow && { cutNames: narrow.cutNames, cut: narrow.cut, ellipsis: narrow.ellipsis }))
  check('narrow at 125%: the watch is still shown', row(narrow, 'R1')[3] === `${K(c1)} → Review`, JSON.stringify(row(narrow, 'R1')))
  await shoot('narrow-125')

  await app.close()
  console.log(failed ? `\n${failed} failed` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
