// The Progress panel's tabs (#1309), on fake Claude Code agents: Pulse · Merges · Runs · Lanes, a segmented control in
// its header whose words go below about 360 px (icons, each with its name), a tablist the arrow keys move through, the
// tab kept per workspace. Badges: agents waiting for the merge slot, failures nothing has passed since (red), lanes.
// Pulse: the merge, the runs going on, a line for the failures (it opens Runs on them), then the lanes right after,
// each with a dot for its current card's latest run. Runs: what runs, then every kept run by day (Today, Yesterday), a
// run tried several times the same day one line ("×3 · 2 failed, then passed"), found by words, filtered to failures,
// a lane's cards or an agent. Merges and Lanes: theirs alone. A first launch makes the agents and cards; yesterday's runs
// are written into the workspace's kept runs before the second. Screenshots of each tab, wide and narrow, both themes.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47842))
const userData = path.join(lib.WORK, 'progresstabs-profile')
const ws = path.join(lib.WORK, 'progresstabs-ws')
const claudeHome = path.join(lib.WORK, 'progresstabs-claude-home')
const shots = path.join(lib.WORK, 'progresstabs-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 200)
/** A run's or a group's line, "who · what" (HI-1701: two parts of one line). */
const lineOf = (head) => head.evaluate((el) => `${el.querySelector('.progress-recent-who')?.textContent} · ${el.querySelector('.progress-recent-text')?.textContent}`).catch(() => '')

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.git(alpha, ['branch', '-M', 'main'])
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })

  // --- First launch: the agents and the cards.
  let builder, reviewer
  const cards = []
  let app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    builder = await lib.addAgent(inv, alpha, { name: 'B1' })
    reviewer = await lib.addAgent(inv, alpha, { name: 'R1' })
    for (const title of ['Lane data', 'Lane hover', 'Docs']) cards.push(await inv('tasks:create', { title, project: 'alpha' }))
  } finally {
    await app.close().catch(() => undefined)
  }
  check('the agents and cards are made', !!builder?.id && !!reviewer?.id && cards.length === 3, JSON.stringify({ builder, cards: cards.map((c) => c.key) }))
  const [a, b, c] = cards

  // --- Kept runs (the workspace's history): yesterday B1's typecheck of A tried three times (failed, failed, passed) and
  // a script's nightly build that failed; earlier today B1's unit run of B, passed.
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
  const yesterday = startOfToday - 6 * 3600_000
  const kept = (id, at, o) => ({ id, title: o.title, command: o.command ?? null, startedAt: at, finishedAt: at + 40_000, updatedAt: at + 40_000, state: o.state, source: o.source ?? 'agent', agentName: o.agentName ?? 'B1', ...(o.source === 'api' ? {} : { projectPath: alpha, agentId: builder.id, provider: 'claude-code' }), ...(o.card ? { card: o.card } : {}), ...(o.check ? { check: o.check } : {}) })
  const history = [
    kept('k-today-unit', Date.now() - 600_000, { title: 'unit', command: 'npm test', state: 'passed', card: b.number }),
    kept('k-nightly', yesterday + 3 * 600_000, { title: 'nightly build', command: 'npm run build:nightly', state: 'failed', source: 'api', agentName: 'Script' }),
    kept('k-tc-3', yesterday + 2 * 600_000, { title: 'typecheck', command: 'npm run typecheck', state: 'passed', card: a.number, check: 'typecheck' }),
    kept('k-tc-2', yesterday + 600_000, { title: 'typecheck', command: 'npm run typecheck', state: 'failed', card: a.number, check: 'typecheck' }),
    kept('k-tc-1', yesterday, { title: 'typecheck', command: 'npm run typecheck', state: 'failed', card: a.number, check: 'typecheck' })
  ]
  const historyDir = path.join(userData, 'progress-history')
  fs.mkdirSync(historyDir, { recursive: true })
  fs.writeFileSync(path.join(historyDir, `${createHash('sha256').update(path.resolve(ws).toLowerCase()).digest('hex').slice(0, 16)}.json`), JSON.stringify({ version: 1, runs: history }))

  // --- Second launch: the agents run; a lane, a merge held and one waiting, runs going on and failing.
  app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...x) => page.evaluate(([ch2, y]) => window.combwork.invoke(ch2, ...y), [ch, x])
    if ((await inv('workspace:get'))?.path?.toLowerCase() !== ws.toLowerCase()) await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    for (const x of [builder, reviewer]) await inv('session:start', alpha, { agentId: x.id })
    check('the agents start', !!(await until(async () => (await live(builder.id))?.status === 'ready' && (await live(reviewer.id))?.status === 'ready', HUNG_MS)))
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (id) => {
      const sessionId = (await live(id))?.sessionId
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const [t1, tr] = [await tokenOf(builder.id), await tokenOf(reviewer.id)]
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (token, method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    check('each agent has its own token', !!t1 && !!tr && t1 !== tr)
    const lane = await api(t1, 'POST', '/v1/lanes', { cards: [a.number, b.number, c.number], reviewer: 'R1', name: 'tabs' })
    check('B1 starts a lane of three cards', lane.status === 200, JSON.stringify(lane.body))
    await inv('tasks:update', a.number, { column: 'doing', agent: builder.id })
    const held = await api(t1, 'POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', cards: [a.number], timeoutSeconds: 0 })
    const waits = await api(tr, 'POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', cards: [b.number], timeoutSeconds: 0 })
    check('B1 holds the merge slot, R1 waits for it', held.body?.held === true && waits.body?.held !== true, JSON.stringify({ held: held.body, waits: waits.body }))
    const e2e = (await api(t1, 'POST', '/v1/progress', { title: 'e2e', command: 'npm run e2e', total: 12, card: a.key })).body?.id
    await api(t1, 'PATCH', `/v1/progress/${e2e}`, { step: 4, stepName: 'carddialog' })
    for (let i = 0; i < 2; i++) {
      const id = (await api(workspaceToken, 'POST', '/v1/progress', { title: 'lint', command: 'npm run lint' })).body?.id
      await api(workspaceToken, 'POST', `/v1/progress/${id}/finish`, { ok: false, summary: '3 warnings', exitCode: 1 })
    }
    check('B1 runs e2e for its card', !!e2e)

    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click()
    check('the panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
    const tab = (name) => panel.locator(`.progress-tab[data-tab="${name}"]`)
    const showTab = async (name) => {
      await tab(name).click()
      return until(async () => (await panel.locator(`.progress-tab-${name}`).count()) === 1, HUNG_MS)
    }
    const setWidth = async (px) => {
      await panel.evaluate((el, w) => (el.style.width = `${w}px`), px)
      await until(async () => Math.round((await panel.boundingBox()).width) === px, HUNG_MS)
    }
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- The tabs: a tablist of four, Pulse chosen; badges with what they mean in each tab's name.
    check('four tabs in a tablist, Pulse chosen', (await panel.locator('[role="tablist"] [role="tab"]').count()) === 4 && (await tab('pulse').getAttribute('aria-selected')) === 'true')
    check('Merges: one merge waiting', !!(await until(async () => (await tab('merges').getAttribute('aria-label')) === 'Merges, 1 merge waiting', HUNG_MS)), await tab('merges').getAttribute('aria-label'))
    check('Runs, red: three failures nothing has passed since (the nightly build and two lints; the typecheck passed after)', !!(await until(async () => (await tab('runs').getAttribute('aria-label')) === 'Runs, 3 failures nothing has passed since' && (await tab('runs').locator('.progress-tab-badge.failed').textContent()) === '3', HUNG_MS)), await tab('runs').getAttribute('aria-label'))
    check('Lanes: one lane', !!(await until(async () => (await tab('lanes').getAttribute('aria-label')) === 'Lanes, 1 lane', HUNG_MS)), await tab('lanes').getAttribute('aria-label'))
    // Words when there's room: below about 360 px only the icons.
    const labelShown = () => tab('runs').locator('.progress-tab-label').evaluate((el) => getComputedStyle(el).display !== 'none')
    await setWidth(300)
    check('narrow (300 px), the tabs are icons', !!(await until(async () => !(await labelShown()), HUNG_MS)))
    await setWidth(440)
    check('wide (440 px), their words show', !!(await until(async () => labelShown(), HUNG_MS)))

    // --- Pulse: the merge, the run going on, the failures' line, the lane right after with its card's dot.
    check('Pulse shows the merge', (await panel.locator('.progress-tab-pulse .progress-merge-card').count()) === 1)
    check('…and the run going on', !!(await until(async () => (await panel.locator(`.progress-tab-pulse .progress-run[data-run="${e2e}"]`).count()) === 1, HUNG_MS)))
    const attention = panel.locator('.progress-attention')
    check('…and a line: 3 runs failed', !!(await until(async () => ((await attention.textContent()) ?? '').includes('3 runs failed'), HUNG_MS)), await attention.textContent().catch(() => ''))
    // Finished runs live in Runs (#1309, the Assistant's change): the failed lints leave Pulse after a few seconds, the
    // line counting them; only the run going on stays.
    const pulseRuns = () => panel.locator('.progress-tab-pulse .progress-run').evaluateAll((els) => els.map((e) => e.getAttribute('data-run')))
    check('…and the failed runs leave Pulse: only the run going on is a card there', !!(await until(async () => JSON.stringify(await pulseRuns()) === JSON.stringify([e2e]), HUNG_MS)), JSON.stringify(await pulseRuns()))
    // HI-1923: the line sits above the runs, after the merge, out of their scrolling list: it stays in sight however many.
    const order = await panel.locator('.progress-tab-pulse').evaluate((el) => {
      const box = (sel) => el.querySelector(sel)?.getBoundingClientRect() ?? null
      const line = box(':scope > .progress-attention')
      const merge = box('.progress-merge-card')
      const runs = box(':scope > .progress-body')
      return { line: line && { top: line.top, bottom: line.bottom }, merge: merge && { bottom: merge.bottom }, runs: runs && { top: runs.top } }
    })
    check('…the line above the runs, after the merge, outside their scrolling list', !!order.line && !!order.merge && !!order.runs && order.merge.bottom <= order.line.top && order.line.bottom <= order.runs.top, JSON.stringify(order))
    const dot = panel.locator('.progress-tab-pulse .lane-run-dot')
    check("…the lane, with a dot for its current card's latest run: e2e, running", !!(await until(async () => (await dot.count()) === 1 && ((await dot.getAttribute('class')) ?? '').includes('running'), HUNG_MS)) && (await dot.getAttribute('aria-label')) === `${a.key}'s latest run: e2e, running`, await dot.getAttribute('aria-label').catch(() => ''))
    const runsBox = await panel.locator('.progress-tab-pulse > .progress-body').boundingBox()
    const lanesBox = await panel.locator('.progress-tab-pulse .progress-lanes').boundingBox()
    check('…right after the runs: no gap', Math.abs(lanesBox.y - (runsBox.y + runsBox.height)) <= 2, JSON.stringify({ runsBox, lanesBox }))
    await shoot('pulse-wide')
    await setWidth(280)
    await shoot('pulse-narrow')

    // --- The failures' line opens Runs on them.
    await attention.click()
    check('the line opens Runs, failures only', !!(await until(async () => (await tab('runs').getAttribute('aria-selected')) === 'true' && (await panel.locator('.progress-runs-failed').getAttribute('aria-pressed')) === 'true', HUNG_MS)))
    // Its words with every card's runs open (HI-1701: a card whose runs all passed is closed).
    const text = async () => {
      for (const t of await panel.locator('.progress-card-toggle[aria-expanded="false"]').all()) await t.click().catch(() => undefined)
      return ((await panel.locator('.progress-tab-runs').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    }
    check('…the nightly build and the lints, nothing that passed', !!(await until(async () => /nightly build/.test(await text()) && /lint/.test(await text()) && !/unit/.test(await text()), HUNG_MS)), await text())
    await panel.locator('.progress-runs-clear').click()

    // --- Runs: by day, retries folded, found, filtered.
    const days = async () => panel.locator('.progress-runs-day > .progress-section').allTextContents()
    check('the runs by day: Today, then Yesterday', !!(await until(async () => JSON.stringify(await days()) === JSON.stringify(['Today', 'Yesterday']), HUNG_MS)), JSON.stringify(await days()))
    check('what runs is on top', (await panel.locator('.progress-tab-runs .progress-runs-body > .progress-run').first().getAttribute('data-run')) === e2e)
    const tc = panel.locator('.progress-runs-day').nth(1).locator('.progress-run-group')
    check(`yesterday's typecheck, tried three times, is one line under ${a.key}: B1 · typecheck ×3 · 2 failed, then passed`, (await lineOf(tc.locator('.progress-group-head'))) === 'B1 · typecheck ×3 · 2 failed, then passed' && (await panel.locator('.progress-runs-day').nth(1).locator(`.progress-card-runs[data-card-runs="${a.number}"] .progress-card-key`).textContent()) === a.key, await lineOf(tc.locator('.progress-group-head')))
    const lints = panel.locator('.progress-runs-day').first().locator('.progress-run-group')
    check("today's lint, failed twice, is one line too", (await lineOf(lints.locator('.progress-group-head'))) === 'Script · lint ×2 · 2 failed', await lineOf(lints.locator('.progress-group-head')))
    await tc.locator('.progress-group-head').click()
    check('…opened, each of its runs, newest first', !!(await until(async () => (await tc.locator('.progress-recent-item').count()) === 3, HUNG_MS)) && (await tc.locator('.progress-recent-item').first().getAttribute('data-run')) === 'k-tc-3')
    await setWidth(440)
    await shoot('runs-wide')
    await setWidth(280)
    await shoot('runs-narrow')
    await panel.locator('.progress-runs-search').fill('nightly')
    check('words find runs: "nightly" shows the nightly build only', !!(await until(async () => /nightly build/.test(await text()) && !/typecheck/.test(await text()) && !/lint/.test(await text()), HUNG_MS)), await text())
    await panel.locator('.progress-runs-clear').click()
    await panel.locator('.progress-runs-choices select[aria-label="Lane"]').selectOption({ label: 'B1 / R1 · tabs' })
    check("a lane's cards: its runs only (e2e, unit, typecheck), not the scripts'", !!(await until(async () => /e2e/.test(await text()) && /unit/.test(await text()) && /typecheck/.test(await text()) && !/nightly/.test(await text()) && !/lint/.test(await text()), HUNG_MS)), await text())
    await panel.locator('.progress-runs-clear').click()
    check('Clear shows every run again', !!(await until(async () => /nightly/.test(await text()) && /lint/.test(await text()), HUNG_MS)))

    // --- HI-1925: the finished runs docked at the bottom behind the lanes' edge, about 6.5 lane rows (61 px each),
    // what runs above; every run its own line with its time, its details closed; several opened at once, folded again
    // when Runs leaves the screen; dragged unsnapped, up to 10 rows, kept for the workspace; on a short window what
    // fits, its height back as the window grows; a filter matching only yesterday's: "No runs match." under Today.
    const dock = panel.locator('.progress-tab-runs > .progress-runs-dock')
    const dockList = dock.locator('.progress-runs-dock-list')
    const edge = dock.locator('.progress-lanes-edge')
    const dockH = async () => (await dockList.boundingBox())?.height ?? 0
    const near = (h, want) => Math.abs(h - want) <= 2
    check('the finished runs are docked below the edge, about 6.5 lane rows high; what runs is above them', (await edge.count()) === 1 && !!(await until(async () => near(await dockH(), 6.5 * 61), HUNG_MS)) && (await dock.locator(`[data-run="${e2e}"]`).count()) === 0 && (await panel.locator(`.progress-tab-runs > .progress-runs-body [data-run="${e2e}"]`).count()) === 1, String(await dockH()))
    check('…Today, then Yesterday, inside the dock', JSON.stringify(await dock.locator('.progress-runs-day > .progress-section').allTextContents()) === JSON.stringify(['Today', 'Yesterday']))
    const unit = dock.locator('.progress-recent-item[data-run="k-today-unit"]')
    const nightly = dock.locator('.progress-recent-item[data-run="k-nightly"]')
    check("every run its own line, with when it ended, its details closed (no card's runs folded away)", (await unit.count()) === 1 && (await nightly.count()) === 1 && /\d/.test((await unit.locator('.progress-recent-at').textContent()) ?? '') && (await dock.locator('.progress-details').count()) === 0 && (await dock.locator('.progress-card-toggle').count()) === 0)
    await unit.locator('.progress-recent').click()
    await nightly.locator('.progress-recent').click()
    check('…two opened at once', !!(await until(async () => (await dock.locator('.progress-details').count()) === 2, HUNG_MS)))
    await showTab('pulse')
    await showTab('runs')
    check('…folded again once Runs left the screen', !!(await until(async () => (await dock.locator('.progress-recent-item[data-run="k-today-unit"]').count()) === 1, HUNG_MS)) && (await dock.locator('.progress-details').count()) === 0)
    // A drag up of 100 px: 100 px taller, not a whole number of rows.
    const dragEdge = async (dy) => {
      const box = await edge.boundingBox()
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y + dy / 2)
      await page.mouse.move(x, y + dy)
      await page.mouse.up()
    }
    await dragEdge(-100)
    check('dragged up 100 px: 100 px taller, unsnapped', !!(await until(async () => near(await dockH(), 6.5 * 61 + 100), HUNG_MS)), String(await dockH()))
    const dockKey = `progress-runs-today:${ws.toLowerCase()}`
    const keptRows = async () => (await inv('ui:get')).panes?.[dockKey]
    check('…kept for the workspace', !!(await until(async () => Math.abs((await keptRows()) - (6.5 + 100 / 61)) < 0.02, HUNG_MS)), String(await keptRows()))
    await dragEdge(-2000)
    const most = Number(await edge.getAttribute('aria-valuemax'))
    // The separator says it to a tenth of a row; the dock is drawn to the pixel.
    check('dragged far up: no more than 10 rows, or what fits', most <= 10 && !!(await until(async () => Math.abs((await dockH()) - most * 61) <= 0.05 * 61 + 1 && Number(await edge.getAttribute('aria-valuenow')) === most, HUNG_MS)), `${most} ${await dockH()}`)
    await dragEdge(2000)
    check('dragged far down: a row at least', !!(await until(async () => near(await dockH(), 61), HUNG_MS)), String(await dockH()))
    await edge.dblclick()
    check('a double-click: back to 6.5 rows', !!(await until(async () => near(await dockH(), 6.5 * 61), HUNG_MS)) && !!(await until(async () => (await keptRows()) === undefined, HUNG_MS)), String(await dockH()))
    await dragEdge(-61)
    check('a row taller again (7.5 rows)', !!(await until(async () => near(await dockH(), 7.5 * 61), HUNG_MS)), String(await dockH()))
    // A short window: what fits, the runs above keeping their room, the separator saying so; grown again, its height back.
    await lib.fitWindow(app, page, { width: 1400, height: 520 })
    const short = await until(async () => {
      const h = await dockH()
      return h > 0 && h < 7.5 * 61 - 2 ? h : null
    }, HUNG_MS)
    check('a short window: the dock shows what fits, smaller than chosen, its separator saying so', !!short && Math.abs(Number(await edge.getAttribute('aria-valuenow')) * 61 - short) < 8 && Number(await edge.getAttribute('aria-valuemax')) < 7.5, `${short} ${await edge.getAttribute('aria-valuenow')}/${await edge.getAttribute('aria-valuemax')}`)
    await setWidth(440)
    await shoot('runs-dock-short')
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    check('…grown again: its height back (7.5 rows), the choice kept', !!(await until(async () => near(await dockH(), 7.5 * 61), HUNG_MS)), String(await dockH()))
    await setWidth(440)
    await shoot('runs-dock-tall')
    // A filter matching only yesterday's runs: Today says no run matches, Yesterday shows the match.
    await panel.locator('.progress-runs-search').fill('nightly')
    check('a filter matching only older runs: "No runs match." under Today, the match under Yesterday', !!(await until(async () => /No runs match\./.test((await dock.locator('.progress-runs-day[data-day="0"]').innerText().catch(() => '')) ?? '') && (await dock.locator('.progress-recent-item[data-run="k-nightly"]').count()) === 1, HUNG_MS)), await dock.innerText().catch(() => ''))
    await panel.locator('.progress-runs-clear').click()
    await edge.dblclick()

    // --- Merges and Lanes: theirs alone.
    await showTab('merges')
    check('Merges shows the merge, B1 holding, R1 waiting', !!(await until(async () => (await panel.locator('.progress-tab-merges .progress-merge-card').count()) === 1, HUNG_MS)) && /R1/.test((await panel.locator('.progress-tab-merges').innerText()) ?? ''))
    await setWidth(440)
    await shoot('merges-wide')
    await setWidth(280)
    await shoot('merges-narrow')
    await showTab('lanes')
    check('Lanes shows the lane, with no fold bar or edge', !!(await until(async () => (await panel.locator('.progress-tab-lanes .progress-lane').count()) === 1, HUNG_MS)) && (await panel.locator('.progress-tab-lanes .progress-lanes-bar, .progress-tab-lanes .progress-lanes-edge').count()) === 0)
    await setWidth(440)
    await shoot('lanes-wide')
    await setWidth(280)
    await shoot('lanes-narrow')

    // --- HI-1926: a lane opens to its cards in order, each with its state, round and time; folded again once the tab
    // is left. Its header says how long it has waited when it waits. Then seven lanes: stacked from the bottom, growing
    // upwards to the top, then scrolling, the first and the last reachable.
    await setWidth(440)
    const tabsLane = panel.locator('.progress-tab-lanes .progress-lane').first()
    await tabsLane.locator('.progress-lane-expand').click()
    const queueRows = tabsLane.locator('.progress-lane-queue-row')
    const queue = () => queueRows.evaluateAll((els) => els.map((e) => `${e.dataset.card}:${e.dataset.state}:${e.querySelector('.progress-lane-queue-round')?.textContent ?? ''}:${e.querySelector('.progress-lane-queue-time') ? 'time' : ''}`))
    // The lane's cards in its order: the first being worked (its time so far), the next two not started (no time).
    check('a lane opens to its cards in order: state, round and time so far for the one in progress, none for those to do', !!(await until(async () => {
      const q = await queue()
      return q.length === 3 && q[0].startsWith(`${a.number}:`) && q[0].endsWith(':r1:time') && q[1] === `${b.number}:todo:r1:` && q[2] === `${c.number}:todo:r1:`
    }, HUNG_MS)), JSON.stringify(await queue()))
    await queueRows.first().locator('.progress-lane-queue-key').click()
    check("…a card's key opens it", !!(await until(async () => (await page.locator('[role="dialog"]').filter({ hasText: a.key }).count()) > 0, HUNG_MS)))
    await page.keyboard.press('Escape')
    await shoot('lanes-queue')
    await showTab('pulse')
    await showTab('lanes')
    check('…folded again once the tab was left', !!(await until(async () => (await panel.locator('.progress-tab-lanes .progress-lane-queue').count()) === 0, HUNG_MS)))
    const waited = panel.locator('.progress-tab-lanes .progress-lane-waited')
    const why = panel.locator('.progress-tab-lanes .progress-lane-why')
    check('…a lane that waits says for how long', (await why.count()) === 0 || !!(await until(async () => /\d/.test((await waited.first().textContent().catch(() => '')) ?? ''), HUNG_MS)), `${await why.first().textContent().catch(() => '')} ${await waited.first().textContent().catch(() => '')}`)
    // A lane waiting for you (B1 asks about its card): its header says why and for how long, from when the wait began;
    // past the bound (Settings → Advanced, set to its least, a minute) the time is marked.
    const asked = await api(t1, 'POST', `/v1/tasks/${a.key}/ask`, { kind: 'decide', text: 'Which way should the lane go?' })
    check('B1 asks the user about its card', asked.status === 200, JSON.stringify(asked.body))
    const tabsWaited = tabsLane.locator('.progress-lane-waited')
    check('…its lane waits for you, saying for how long', !!(await until(async () => /for you|you/i.test((await tabsLane.locator('.progress-lane-why').textContent().catch(() => '')) ?? '') && /\d/.test((await tabsWaited.textContent().catch(() => '')) ?? ''), HUNG_MS)), `${await tabsLane.locator('.progress-lane-why').textContent().catch(() => '')} ${await tabsWaited.textContent().catch(() => '')}`)
    check('…not marked yet (under an hour)', !((await tabsWaited.getAttribute('class')) ?? '').includes('long'))
    // Its card, opened in the lane's queue, waits for you too (HR5's round 1: an ordinary request, not only a block).
    await tabsLane.locator('.progress-lane-expand').click()
    check("…and its card in the lane's queue is waiting for you", !!(await until(async () => (await tabsLane.locator(`.progress-lane-queue-row[data-card="${a.number}"]`).getAttribute('data-state').catch(() => null)) === 'waiting', HUNG_MS)), await tabsLane.locator(`.progress-lane-queue-row[data-card="${a.number}"]`).getAttribute('data-state').catch(() => ''))
    await tabsLane.locator('.progress-lane-expand').click()
    await shoot('lanes-wait')
    await inv('advanced:set', 'cw.lanes.waitYouMinutes', 1)
    // The bound a minute: marked once a minute has passed (a condition, bounded for a hung run).
    check('…past its bound (a minute, Settings → Advanced), the time is marked', !!(await until(async () => ((await tabsWaited.getAttribute('class').catch(() => '')) ?? '').includes('long'), 120_000)), await tabsWaited.textContent().catch(() => ''))
    await shoot('lanes-wait-long')
    await inv('advanced:set', 'cw.lanes.waitYouMinutes', null)
    // Six more lanes (solo, their builders started by Combwork): seven in all, more than fit.
    for (let i = 2; i <= 7; i++) {
      const bx = await lib.addAgent(inv, alpha, { name: `B${i}` })
      const card = await inv('tasks:create', { title: `Lane card ${i}`, project: 'alpha' })
      await inv('lanes:start', alpha, { builder: bx.id, reviewer: null, cards: [card.number], name: `solo ${i}` })
    }
    const laneList = panel.locator('.progress-tab-lanes .progress-lanes-list')
    check('seven lanes in the Lanes tab', !!(await until(async () => (await panel.locator('.progress-tab-lanes .progress-lane').count()) === 7, HUNG_MS)), String(await panel.locator('.progress-tab-lanes .progress-lane').count()))
    await lib.fitWindow(app, page, { width: 1400, height: 520 })
    const fill = async () =>
      laneList.evaluate((el) => {
        const rows = [...el.querySelectorAll(':scope > .progress-lane')]
        const box = el.getBoundingClientRect()
        el.scrollTop = 0
        const firstTop = rows[0].getBoundingClientRect().top - box.top
        el.scrollTop = el.scrollHeight
        const lastBottom = box.bottom - rows.at(-1).getBoundingClientRect().bottom
        return { scrolls: el.scrollHeight > el.clientHeight + 1, firstTop, lastBottom }
      })
    check('…more than fit: they fill the tab to the top and scroll, the first and the last reachable', !!(await until(async () => {
      const f = await fill()
      return f.scrolls && f.firstTop >= -1 && f.firstTop < 20 && f.lastBottom >= -1 && f.lastBottom < 20
    }, HUNG_MS)), JSON.stringify(await fill()))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    // A few lanes in a tall panel: at the bottom, growing upwards (the space above them).
    const bottomed = async () => laneList.evaluate((el) => {
      const rows = [...el.querySelectorAll(':scope > .progress-lane')]
      const box = el.getBoundingClientRect()
      return el.scrollHeight <= el.clientHeight + 1 ? Math.round(box.bottom - rows.at(-1).getBoundingClientRect().bottom) : null
    })
    check('…in a tall panel, all of them shown, stacked from the bottom', !!(await until(async () => {
      const gap = await bottomed()
      return gap !== null && gap < 20
    }, HUNG_MS)), String(await bottomed()))
    await shoot('lanes-seven')
    for (const l of await inv('lanes:list')) if ((l.name ?? '').startsWith('solo ')) await inv('lanes:end', l.id, true).catch(() => undefined)

    // --- The keyboard: arrow keys, Home and End move through the tabs, choosing as they go; the tab kept.
    // The tabs move the keyboard in an animation frame after choosing, which a busy window runs late: each key waits for
    // its tab chosen and the keyboard on it before the next (#1465: Right after Home went to Lanes, still focused, and
    // chose Pulse).
    const chosen = (t) => until(async () => (await tab(t).getAttribute('aria-selected')) === 'true' && (await page.evaluate(() => document.activeElement?.getAttribute('data-tab'))) === t, HUNG_MS)
    await tab('lanes').focus()
    await page.keyboard.press('ArrowRight')
    check('Right from the last tab is Pulse, with the keyboard on it', !!(await chosen('pulse')))
    await page.keyboard.press('ArrowLeft')
    check('Left from it is Lanes', !!(await chosen('lanes')))
    await page.keyboard.press('Home')
    const home = await chosen('pulse')
    await page.keyboard.press('ArrowRight')
    check('Home, then Right: Merges', !!home && !!(await chosen('merges')))
    const key = `progress-tab:${ws.toLowerCase()}`
    check('the tab is kept for the workspace', !!(await until(async () => (await inv('ui:get')).panes?.[key] === 1, HUNG_MS)))

    // --- HR6's round 1: a card is part of what a run is a run of. The same command fails for A, then passes for B:
    // A's failure stays unresolved (the badge up by one, and stays), and the two are lines of their own.
    const custom = async (card, ok) => {
      const id = (await api(t1, 'POST', '/v1/progress', { title: 'custom verification', command: 'node custom-verification.cjs', card: card.key })).body?.id
      await api(t1, 'POST', `/v1/progress/${id}/finish`, { ok })
      return id
    }
    const badgeNow = async () => Number((await tab('runs').locator('.progress-tab-badge').textContent().catch(() => '0')) ?? 0)
    const before = await badgeNow()
    await custom(a, false)
    check("a card's run failing raises the badge by one", !!(await until(async () => (await badgeNow()) === before + 1, HUNG_MS)), String(await badgeNow()))
    await custom(b, true)
    await showTab('runs')
    check("…another card's run of the same command passing doesn't resolve it, nor fold with it", !!(await until(async () => /custom verification/.test(await text()), HUNG_MS)) && (await badgeNow()) === before + 1 && !/custom verification ×2/.test(await text()), `${await badgeNow()} ${await text()}`)

    // --- HR6's round 1: the lane filter reads the lane as it is now. Chosen with [A, B, C]; A Done and the list
    // changed between cards to [A, C]: B's runs leave the filtered list, the choice stays the lane. A script changes it
    // (the workspace token): a builder's own start never takes a card off its lane (HI-2169), the Assistant, the user
    // and scripts do.
    await panel.locator('.progress-runs-choices select[aria-label="Lane"]').selectOption({ label: 'B1 / R1 · tabs' })
    check("the lane's filter shows B's unit run while B is in the lane", !!(await until(async () => /unit/.test(await text()), HUNG_MS)), await text())
    await inv('tasks:move', a.number, 'done', { confirm: true, reason: 'Merged by hand' })
    await until(async () => (await inv('tasks:list')).find((x) => x.number === a.number)?.column === 'done', HUNG_MS)
    const changed = await api(workspaceToken, 'POST', '/v1/lanes', { project: 'alpha', builder: 'B1', cards: [a.number, c.number], reviewer: 'R1', name: 'tabs' })
    check('between cards, the lane becomes [A, C]', changed.status === 200 && JSON.stringify(changed.body?.lane?.cards?.map((x) => x.number)) === JSON.stringify([a.number, c.number]), JSON.stringify(changed.body?.lane?.cards))
    check("…the filter follows it: B's runs leave, A's stay, the lane still chosen", !!(await until(async () => !/unit/.test(await text()) && /e2e/.test(await text()), HUNG_MS)) && (await panel.locator('.progress-runs-choices select[aria-label="Lane"]').inputValue()) !== '', await text())
    await panel.locator('.progress-runs-clear').click()
    await api(t1, 'POST', `/v1/progress/${e2e}/finish`, { ok: true })
    await api(t1, 'POST', '/v1/projects/alpha/merge-slot/release', { branch: 'main' })
  } finally {
    await app.close().catch(() => undefined)
  }

  // --- HI-1701: Today by card. A third launch with a busy Today kept, like Darren's (26 Oct): a heading per card, the
  // card with the newest run first and Other last; every card's runs shown, none folded (HI-1925: a line per run, only
  // its details folded); a line per run (who, what, how long), the card's key not repeated, review copies' names only in the
  // hover, retries folded with a failure-aware icon and the merge queue's checks in one line; the filters filter runs
  // within cards and hide empty ones.
  const t0 = Math.max(Date.now() - 50 * 60_000, startOfToday + 60_000)
  const REV = 'e2d018f4c1b2a3d4e5f60718293a4b5c6d7e8f90'
  const ran = (id, min, secs, o) => ({
    id,
    title: o.title,
    command: o.command ?? `npm run ${o.title}`,
    startedAt: t0 + min * 60_000,
    finishedAt: t0 + min * 60_000 + secs * 1000,
    updatedAt: t0 + min * 60_000 + secs * 1000,
    state: o.state ?? 'passed',
    source: o.source ?? 'agent',
    agentName: o.agentName ?? 'B1',
    ...(o.source === 'api' ? {} : { projectPath: alpha }),
    ...(o.source === 'hive' ? { defaultName: 'mergeQueue' } : o.source === 'api' ? {} : { agentId: o.agentId ?? builder.id, provider: 'claude-code' }),
    ...(o.card ? { card: o.card, revision: o.revision ?? REV } : {}),
    ...(o.check ? { check: o.check } : {}),
    ...(o.copy ? { copy: o.copy } : {})
  })
  const R1 = { agentName: 'R1', agentId: reviewer.id }
  const REV2 = '0123e4979f1c2b3a4d5e6f708192a3b4c5d6e7f8'
  // The merge queue's runs as queueChecks.ts names them, "<key> · <check> · <revision>", with no check name of their own.
  const queued = (card, label, revision = REV) => ({ card: card.number, title: `${card.key} · ${label} · ${revision.slice(0, 7)}`, command: `npm run ${label}`, revision, source: 'hive', agentName: 'Combwork (merge queue)' })
  const busy = [
    ran('b-unit', 1, 40, { card: b.number, title: 'unit', command: 'npm test' }),
    ran('b-review', 3, 20, { card: b.number, title: 'Review lint', command: 'npm run lint', copy: 'copy-7', ...R1 }),
    ran('b-q-install', 6, 30, { ...queued(b, 'npm ci'), command: 'npm ci' }),
    ran('b-q-lint', 7, 9, queued(b, 'lint')),
    ran('a-unit-1', 2, 50, { card: a.number, title: 'unit: 6 files', command: 'npm test -- tests/a', state: 'failed' }),
    ran('a-unit-2', 5, 50, { card: a.number, title: 'unit: 6 files', command: 'npm test -- tests/a', state: 'failed' }),
    ran('a-unit-3', 8, 50, { card: a.number, title: 'unit: 6 files', command: 'npm test -- tests/a' }),
    ran('nightly', 10, 300, { title: 'nightly build', command: 'npm run build:nightly', source: 'api', agentName: 'Script' }),
    ran('a-review', 12, 2, { card: a.number, title: 'Review delivery typecheck', command: 'npm run typecheck', copy: 'copy-5', ...R1 }),
    ran('my-check', 15, 4, { title: 'my check', command: 'node my-check.cjs', source: 'api', agentName: 'Script', state: 'failed' }),
    ran('a-cardloop', 20, 180, { card: a.number, title: 'cardloop on base c0ffee1', command: 'npm run e2e -- cardloop', state: 'failed' }),
    ran('a-final-1', 22, 30, { card: a.number, title: `${a.key} final typecheck`, check: 'typecheck' }),
    ran('a-final-2', 24, 30, { card: a.number, title: `${a.key} final typecheck`, check: 'typecheck' }),
    // The same check on an earlier revision (a resubmission): named once in the queue's line.
    ran('a-q-lint-old', 26, 6, queued(a, 'lint', REV2)),
    ran('a-q-lint', 30, 6, queued(a, 'lint')),
    ran('a-q-typecheck', 31, 7, queued(a, 'typecheck')),
    ran('c-e2e', 35, 95, { card: c.number, title: 'e2e: changes', command: 'npm run e2e -- changes' })
  ]
  fs.writeFileSync(path.join(historyDir, `${createHash('sha256').update(path.resolve(ws).toLowerCase()).digest('hex').slice(0, 16)}.json`), JSON.stringify({ version: 1, runs: busy }))
  app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors (busy Today)', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...x) => page.evaluate(([ch2, y]) => window.combwork.invoke(ch2, ...y), [ch, x])
    if ((await inv('workspace:get'))?.path?.toLowerCase() !== ws.toLowerCase()) await lib.openWorkspace(inv, page, ws)
    const panel = page.locator('.progress-panel')
    if (!(await panel.count())) await page.locator('.progress-rail').click()
    const tab = (name) => panel.locator(`.progress-tab[data-tab="${name}"]`)
    const showTab = async (name) => {
      await tab(name).click()
      return until(async () => (await panel.locator(`.progress-tab-${name}`).count()) === 1, HUNG_MS)
    }
    await until(async () => (await panel.count()) === 1, HUNG_MS)
    await panel.evaluate((el) => (el.style.width = '440px'))
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    await showTab('runs')
    const today = panel.locator('.progress-runs-day').first()
    const group = (card) => today.locator(`.progress-card-runs[data-card-runs="${card}"]`)
    const heads = () => today.locator('.progress-card-runs').evaluateAll((els) => els.map((e) => e.getAttribute('data-card-runs')))
    const want = [String(c.number), String(a.number), String(b.number), 'other']
    check('Today by card: the card with the newest run first, Other last; every card with its runs, none folded', !!(await until(async () => JSON.stringify(await heads()) === JSON.stringify(want), HUNG_MS)) && (await today.locator('.progress-card-toggle').count()) === 0, JSON.stringify(await heads()))
    const head = (card) => group(card).locator('.progress-card-head')
    const headText = async (card) => (await head(card).evaluate((el) => [...el.querySelectorAll('.progress-card-key, .progress-card-title, .progress-card-summary')].map((x) => x.textContent).join(' | ')).catch(() => ''))
    check(`${a.key}'s heading: its key, title and 10 runs · 3 failed, with a failure's icon`, (await headText(a.number)) === `${a.key} | Lane data | 10 runs · 3 failed` && (await head(a.number).locator('.progress-card-icon.codicon-error').count()) === 1, await headText(a.number))
    check(`${b.key}'s: 4 runs · all passed, with a pass's icon`, (await headText(b.number)) === `${b.key} | Lane hover | 4 runs · all passed` && (await head(b.number).locator('.progress-card-icon.codicon-pass').count()) === 1, await headText(b.number))
    const rows = (card) => group(card).locator('.progress-card-items > .progress-recent-item > .progress-recent, .progress-card-items > .progress-run-group > .progress-group-head')
    const lines = async (card) => Promise.all((await rows(card).all()).map((h) => lineOf(h)))
    const aLines = ['Combwork (merge queue) · lint, typecheck', 'B1 · final typecheck ×2 · all passed', 'B1 · cardloop on base c0ffee1', 'R1 · Review delivery typecheck', 'B1 · unit: 6 files ×3 · 2 failed, then passed']
    check(`${a.key}'s runs, a line each, newest first: the merge queue's checks in one, its key left out of a title`, JSON.stringify(await lines(a.number)) === JSON.stringify(aLines), JSON.stringify(await lines(a.number)))
    // The queue's titles carry the key and revision (HR6's round 1): opened, its runs name only their check.
    await group(a.number).locator('.progress-run-group').filter({ hasText: 'Combwork (merge queue)' }).locator('.progress-group-head').click()
    const queueRuns = () => group(a.number).locator('.progress-group-runs .progress-recent-text').allTextContents()
    check("…opened, the queue's runs, newest first, each its check alone", !!(await until(async () => JSON.stringify(await queueRuns()) === JSON.stringify(['typecheck', 'lint', 'lint']), HUNG_MS)), JSON.stringify(await queueRuns()))
    const itemsText = await group(a.number).locator('.progress-card-items').innerText()
    check(`…no key nor revision in ${a.key}'s lines`, !itemsText.includes(a.key) && !itemsText.includes(REV.slice(0, 7)) && !itemsText.includes(REV2.slice(0, 7)), itemsText)
    await group(a.number).locator('.progress-run-group').filter({ hasText: 'Combwork (merge queue)' }).locator('.progress-group-head').click()
    check('…one row shape: no line under a run, no copy name shown', (await group(a.number).locator('.progress-run-for').count()) === 0 && !/copy-5/.test(await group(a.number).innerText()))
    check('…the retries a warning (failed, then passed), the failed run a failure', (await group(a.number).locator('.progress-run-group').filter({ hasText: 'unit: 6 files' }).locator('.progress-group-head .codicon-warning').count()) === 1 && (await group(a.number).locator('.progress-recent-item[data-run="a-cardloop"] .progress-recent .codicon-error').count()) === 1)
    const reviewRow = group(a.number).locator('.progress-recent-item[data-run="a-review"] .progress-recent > .tip-wrap').first()
    const tipText = async () => (await page.locator('body > .tip').allTextContents().catch(() => [])).join(' | ')
    check('…its card, revision and copy in the hover', !!(await until(async () => {
      if ((await tipText()).includes(`${a.key} · e2d018f · in copy-5`)) return true
      // The runs are docked at the bottom (HI-1925), where the window's notices show: those first.
      for (const x of await page.locator('.toasts button[aria-label="Dismiss"]').all()) await x.click().catch(() => undefined)
      await reviewRow.hover({ timeout: 2000 }).catch(() => undefined)
      return false
    }, HUNG_MS)), await tipText())
    await page.mouse.move(5, 5)
    await shoot('runs-by-card')
    // A card whose runs all passed shows its run too (HI-1925: nothing folded but details); a click on a heading folds nothing.
    check(`${c.key}, all passed, shows its run`, JSON.stringify(await lines(c.number)) === JSON.stringify(['B1 · e2e: changes']), JSON.stringify(await lines(c.number)))
    await group(a.number).locator('.progress-card-head').click()
    check(`a click on ${a.key}'s heading folds nothing`, (await rows(a.number).count()) === aLines.length)
    // The filters filter the runs in each card and hide a card with none.
    await panel.locator('.progress-runs-failed').click()
    check(`Failed: ${a.key} (its failed runs) and Other, nothing else`, !!(await until(async () => JSON.stringify(await heads()) === JSON.stringify([String(a.number), 'other']), HUNG_MS)) && JSON.stringify(await lines(a.number)) === JSON.stringify(['B1 · cardloop on base c0ffee1', 'B1 · unit: 6 files ×2 · 2 failed']) && JSON.stringify(await lines('other')) === JSON.stringify(['Script · my check']), `${JSON.stringify(await heads())} ${JSON.stringify(await lines(a.number))}`)
    await shoot('runs-by-card-failed')
    await panel.locator('.progress-runs-clear').click()
    await panel.locator('.progress-runs-choices select[aria-label="Agent"]').selectOption({ label: 'R1' })
    check(`an agent: R1's runs, in ${a.key} and ${b.key}`, !!(await until(async () => JSON.stringify(await heads()) === JSON.stringify([String(a.number), String(b.number)]), HUNG_MS)), JSON.stringify(await heads()))
    await panel.locator('.progress-runs-clear').click()
    await panel.locator('.progress-runs-search').fill('nightly')
    check('words: the nightly build, in Other alone: 1 run, all passed', !!(await until(async () => JSON.stringify(await heads()) === JSON.stringify(['other']) && (await headText('other')) === 'Other |  | 1 run · all passed', HUNG_MS)), `${JSON.stringify(await heads())} ${await headText('other')}`)
    await panel.locator('.progress-runs-clear').click()
    // A card's key opens the card.
    await group(b.number).locator('.progress-card-key').click()
    check(`${b.key}'s key opens the card`, !!(await until(async () => (await page.locator('[role="dialog"]').filter({ hasText: b.key }).count()) > 0, HUNG_MS)))
    await page.keyboard.press('Escape')
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
