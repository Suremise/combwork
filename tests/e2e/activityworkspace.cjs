// Activity's workspace level (HI-1664): the activity bar's Activity, the same "what's running now" as a project's tab
// across every session host of the workspace with an agent running, its tabs grouped by project. Two projects whose
// builders share the id hb1 (each its own tab, its own work), and the Combwork Assistant as a group of its own. Its sidebar:
// Whole workspace, and each project's row opening that project's own tab, whose filters stay its own. Opened from a card
// (its agents now: a project card's builder; a workspace card's agents in both projects, found again when one stops),
// from a Progress panel run's details and from a lane's menu (Show in Activity). Frozen when opened; nothing read or
// drawn while the window is minimised (the view's own counters, __hiveWorkspaceActivity), one call a tick for what runs
// now in every project; a status change alone never finds a card's agents again or reads the session lists beyond their
// cadence. A card whose builder went on to its next card (its session's record keeping this one) has nobody on it. A
// card's Activity whose agents come back after the window went elsewhere (another view, another workspace) doesn't open
// (HR5's round 1: activity:cardAgents made slow, HIVE_TEST_SLOW_IPC). Both themes. Fake Claude Code only (no sign-in, no tokens). Dev build, throwaway profile,
// workspace and CLI homes; quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { sessionsOf, putSessions } = require('./storeDocs.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'activityworkspace-profile')
const ws = path.join(lib.WORK, 'activityworkspace-ws')
const claudeHome = path.join(lib.WORK, 'activityworkspace-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const assistantHome = path.join(ws, '.combwork', 'assistant')
const otherWs = path.join(lib.WORK, 'activityworkspace-other-ws')
const PORT = Number(lib.port(47797))
const identity = { name: 'Hive Activity Test', email: 'activityworkspace@example.com' }
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// The same ids in both projects (HR5's design check: a host and an id together name an agent).
const AGENTS = [
  { id: 'hb1', name: 'HB1', provider: 'claude-code', workflowRole: 'builder' },
  { id: 'hr1', name: 'HR1', provider: 'claude-code', workflowRole: 'reviewer' }
]

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome, otherWs]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(path.join(otherWs, 'gamma'))
  for (const p of [alpha, beta]) {
    lib.gitProject(p, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
    lib.git(p, ['branch', '-M', 'main'])
    fs.mkdirSync(path.join(p, '.combwork'), { recursive: true })
    fs.writeFileSync(path.join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: AGENTS }))
  }
  const slotA = path.join(`${ws}.worktrees`, 'beta', 'slot-a')
  const claude = lib.fakeClaude(userData, claudeHome, [alpha, beta, ws, assistantHome, slotA])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off', HIVE_TEST_SLOW_IPC: 'activity:cardAgents=2500', ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const shots = path.join(lib.WORK, 'activityworkspace-shots')
  fs.rmSync(shots, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const shoot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) })
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const liveOf = async (p, id) => (await inv('session:live')).find((x) => same(x.projectPath, p) && x.agentId === id) ?? null

    // --- HB1 runs in both projects, each its own command (a mark on its command line says whose); the Assistant runs.
    await page.getByText('alpha', { exact: true }).first().click()
    for (const [p, mark] of [[alpha, 'ALPHAWORK'], [beta, 'BETAWORK']]) {
      await inv('session:start', p, { agentId: 'hb1' })
      await until(async () => ['ready', 'finished'].includes((await liveOf(p, 'hb1'))?.status), HUNG_MS)
      await lib.sendPrompt(inv, lib.ptyKey(p, 'hb1'), `shell: node -e "setTimeout(()=>{},120000)" ${mark} then work 120`, { submitted: async () => (await liveOf(p, 'hb1'))?.status === 'working' })
    }
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => ['ready', 'finished'].includes((await liveOf(home, 'assistant'))?.status), HUNG_MS)
    // Working (an idle agent has no tab with Hide finished on).
    await lib.sendPrompt(inv, lib.ptyKey(home, 'assistant'), 'work 120', { submitted: async () => (await liveOf(home, 'assistant'))?.status === 'working' })
    const runsMark = async (p, mark) => (await inv('activity:now', p)).launches.flatMap((l) => l.processes).some((x) => (x.command ?? x.label).includes(mark))
    await until(async () => (await runsMark(alpha, 'ALPHAWORK')) && (await runsMark(beta, 'BETAWORK')), HUNG_MS)

    // --- The activity bar's Activity: the tabs grouped by project, hb1 in each, the Assistant its own group.
    await page.locator('.activity-btn[aria-label="Activity"]').click()
    const view = page.locator('.activity-workspace')
    const head = view.locator('.activity-head')
    const refresh = () => head.getByRole('button', { name: 'Refresh', exact: true }).click()
    const groups = async () => view.locator('.activity-tab-group').evaluateAll((els) => els.map((g) => `${g.dataset.host}:${[...g.querySelectorAll('.activity-agent-tab')].map((t) => t.dataset.agent).join(',')}`))
    const fresh = async (fn) => until(async () => {
      if (await fn()) return true
      await refresh()
      return false
    }, HUNG_MS)
    const assistantName = (await inv('workspace:refresh')).assistant.name
    check('the workspace level: tabs grouped by project, hb1 in alpha and in beta, the Assistant its own group', !!(await fresh(async () => JSON.stringify(await groups()) === JSON.stringify(['alpha:hb1', 'beta:hb1', `${assistantName}:assistant`]))), JSON.stringify(await groups()))
    const tabOf = (host, agent) => view.locator(`.activity-agent-tab[data-host="${host}"][data-agent="${agent}"]`)
    const listText = () => view.locator('.activity-list').innerText().catch(() => '')
    await tabOf('beta', 'hb1').click()
    check("beta's hb1: its own work, never alpha's (the same agent id)", !!(await fresh(async () => /BETAWORK/.test(await listText()) && !/ALPHAWORK/.test(await listText()))) && (await tabOf('beta', 'hb1').getAttribute('aria-selected')) === 'true' && (await tabOf('alpha', 'hb1').getAttribute('aria-selected')) === 'false', await listText())
    await tabOf('alpha', 'hb1').click()
    check("alpha's hb1: its own", !!(await fresh(async () => /ALPHAWORK/.test(await listText()) && !/BETAWORK/.test(await listText()))), await listText())
    await tabOf(assistantName, 'assistant').click()
    check("the Assistant's tab: its work under Now", !!(await fresh(async () => (await view.locator('.activity-part').count()) === 1 && (await view.locator('.activity-group[data-group="now"]').count()) === 1)))
    check('it opens frozen (Play offered, not pressed)', (await head.locator('.activity-live').getAttribute('aria-pressed')) === 'false')
    await tabOf('beta', 'hb1').click()
    await page.mouse.move(5, 5)
    await shoot('1-workspace-dark')

    // --- Its sidebar: Whole workspace, each project with its running agents' count.
    const sidebar = page.locator('.sidebar')
    check('its sidebar: Whole workspace (selected), then each project with its running count', (await sidebar.locator('.row.selected', { hasText: 'Whole workspace' }).count()) === 1 && /1/.test(await sidebar.locator('.row', { hasText: 'alpha' }).innerText()) && /1/.test(await sidebar.locator('.row', { hasText: 'beta' }).innerText()))

    // --- Its filters are its own: alpha's HB1 picked here; alpha's own tab is untouched.
    await head.locator('.activity-pick').first().click()
    await lib.menuEntry(page, 'alpha · HB1').click()
    await page.keyboard.press('Escape')
    check('Agents ▾ picks an agent with its project: only that group shows', !!(await until(async () => JSON.stringify(await groups()) === JSON.stringify(['alpha:hb1']), HUNG_MS)), JSON.stringify(await groups()))
    await sidebar.locator('.row', { hasText: 'alpha' }).click()
    const projectHead = page.locator('.activity-tab:not(.activity-workspace) .activity-head')
    check("a project's row opens its own Activity tab, its filters its own (all agents)", !!(await until(async () => /All agents/.test(await projectHead.locator('.activity-pick').first().innerText().catch(() => '')), HUNG_MS)))
    await page.locator('.activity-btn[aria-label="Activity"]').click()
    check('…and the workspace level keeps its own filter', !!(await until(async () => /1 agent/.test(await head.locator('.activity-pick').first().innerText().catch(() => '')), HUNG_MS)))
    await head.locator('.activity-pick').first().click()
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')

    // --- Nothing read or drawn while the window is hidden; one call a tick for every project's processes.
    const counts = () => page.evaluate(() => ({ ...window.__hiveWorkspaceActivity }))
    const before = await counts()
    await until(async () => (await counts()).now >= before.now + 3, HUNG_MS)
    const shownCounts = await counts()
    check('shown: what runs now read in one call a tick for every project (never one per project)', shownCounts.now - before.now >= 3 && shownCounts.lists - before.lists <= 2 * 3, JSON.stringify([before, shownCounts]))
    // The window hidden, as minimised: a quiet test copy's window is never on screen, so minimising it doesn't change
    // the page's visibility; it is said as Chromium says it.
    const visibility = (state) =>
      page.evaluate((v) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
        document.dispatchEvent(new Event('visibilitychange'))
      }, state)
    await visibility('hidden')
    // Measured from its render as hidden (the view draws once as it learns it is hidden), then nothing more.
    check('hidden: the view learns it', !!(await until(async () => (await counts()).active === false, HUNG_MS)))
    const hidden0 = await counts()
    // An agent starting in alpha changes the agents' live state meanwhile (store updates that would draw it).
    await inv('session:start', alpha, { agentId: 'hr1' })
    await until(async () => ['ready', 'finished'].includes((await liveOf(alpha, 'hr1'))?.status), HUNG_MS)
    const hidden1 = await counts()
    check('hidden: nothing read, nothing drawn, though agents changed', hidden1.now === hidden0.now && hidden1.lists === hidden0.lists && hidden1.turns === hidden0.turns && hidden1.renders === hidden0.renders, JSON.stringify([hidden0, hidden1]))
    await visibility('visible')
    check('shown again, it reads again', !!(await until(async () => (await counts()).now > hidden1.now, HUNG_MS)))

    // --- From a card: alpha's card in Doing, its builder's tab; a workspace card's agents in both projects.
    const one = await inv('tasks:create', { title: 'Alpha card', project: 'alpha', agent: 'hb1', column: 'doing' })
    await page.locator('.activity-btn[aria-label="Task Board"]').click()
    const card = page.locator('.task-card', { hasText: 'Alpha card' }).first()
    await until(async () => (await card.count()) === 1, HUNG_MS)
    await card.click()
    await page.locator('.dialog[role="dialog"]').getByRole('button', { name: 'Activity', exact: true }).click()
    const forCard = head.locator('.activity-for-card')
    check("a card's Activity: the workspace level on its builder alone, its Card chip, frozen", !!(await fresh(async () => /Card \w+-\d+/.test(await forCard.innerText().catch(() => '')) && JSON.stringify(await groups()) === JSON.stringify(['alpha:hb1']))) && (await head.locator('.activity-live').getAttribute('aria-pressed')) === 'false', JSON.stringify(await groups()))
    await page.mouse.move(5, 5)
    await shoot('2-for-card-dark')
    // Another view chosen while its agents are found: it doesn't open over it.
    const settled = () => page.evaluate(() => ({ ...window.__hiveCardActivity }))
    const s0 = await settled()
    await page.locator('.activity-btn[aria-label="Task Board"]').click()
    await card.click()
    await page.locator('.dialog[role="dialog"]').getByRole('button', { name: 'Activity', exact: true }).click()
    await page.locator('.activity-btn[aria-label="Projects"]').click()
    check('another view chosen while its agents are found: Activity stays shut', !!(await until(async () => (await settled()).settled > s0.settled, HUNG_MS)) && (await settled()).dropped === s0.dropped + 1 && (await page.locator('.activity-workspace').count()) === 0, JSON.stringify([s0, await settled()]))
    // A card its builder went on from (in Review, HB1 building Alpha card now), on HB1's running session's record as a
    // card loop's session keeps it: nobody on it now.
    const old = await inv('tasks:create', { title: 'Alpha old', project: 'alpha', agent: 'hb1', column: 'review' })
    {
      const sid = (await liveOf(alpha, 'hb1')).sessionId
      const f = sessionsOf(alpha)
      const rec = f.sessions.find((x) => x.id === sid)
      rec.cards = [...(rec.cards ?? []), { number: old.number, title: old.title }]
      putSessions(alpha, f)
    }
    await page.locator('.activity-btn[aria-label="Task Board"]').click()
    const oldCard = page.locator('.task-card', { hasText: 'Alpha old' }).first()
    await until(async () => (await oldCard.count()) === 1, HUNG_MS)
    await oldCard.click({ button: 'right' })
    await lib.menuEntry(page, 'Activity').click()
    check("a card its builder went on from: nobody on it, never the builder's next card", !!(await fresh(async () => /Nobody is working on/.test(await view.locator('.pane-empty').innerText().catch(() => '')) && (await groups()).length === 0)), JSON.stringify(await groups()))
    await shoot('2b-moved-on-dark')
    // A workspace card (no project, so no builder or reviewer): nobody on it; then on the records of both HB1s' running
    // sessions, its agents in both projects.
    const wsCard = await inv('tasks:create', { title: 'Workspace card', column: 'doing' })
    const both = async () => (await inv('activity:cardAgents', wsCard.number)).map((a) => path.basename(a.path)).sort().join(',')
    check('a workspace card nobody works on: no agents', (await both()) === '', await both())
    const openWsCard = async () => {
      await page.locator('.activity-btn[aria-label="Task Board"]').click()
      const el = page.locator('.task-card', { hasText: 'Workspace card' }).first()
      await until(async () => (await el.count()) === 1, HUNG_MS)
      await el.click({ button: 'right' })
      await lib.menuEntry(page, 'Activity').click()
    }
    await openWsCard()
    check('…its Activity says nobody works on it, never every agent', !!(await fresh(async () => /Nobody is working on/.test(await view.locator('.pane-empty').innerText().catch(() => '')) && (await groups()).length === 0)), JSON.stringify(await groups()))
    for (const p of [alpha, beta]) {
      const sid = (await liveOf(p, 'hb1')).sessionId
      const f = sessionsOf(p)
      const rec = f.sessions.find((x) => x.id === sid)
      rec.cards = [...(rec.cards ?? []), { number: wsCard.number, title: wsCard.title }]
      putSessions(p, f)
    }
    check('a workspace card: its agents found in both projects, by their running sessions', !!(await until(async () => (await both()) === 'alpha,beta', HUNG_MS)), await both())
    await openWsCard()
    check("…its Activity: both HB1s, each in its project's group", !!(await fresh(async () => JSON.stringify(await groups()) === JSON.stringify(['alpha:hb1', 'beta:hb1']))), JSON.stringify(await groups()))
    // A status change alone (HR1, running since the hidden check, takes a turn: the same session): a card's agents not
    // found again, and the session lists read only at their cadence (every 5 ticks, each host shown).
    const c0 = await counts()
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'hr1'), 'work 3', { submitted: async () => (await liveOf(alpha, 'hr1'))?.status === 'working' })
    await until(async () => ['ready', 'finished'].includes((await liveOf(alpha, 'hr1'))?.status), HUNG_MS)
    await until(async () => (await counts()).now >= c0.now + 2, HUNG_MS)
    const c1 = await counts()
    check('a status change alone: no card lookup, the session lists at their cadence', c1.cardAgents === c0.cardAgents && c1.lists - c0.lists <= (Math.floor((c1.now - c0.now) / 5) + 1) * 3, JSON.stringify([c0, c1]))
    await inv('session:stop', alpha, 'hr1').catch(() => undefined)
    // Beta's HB1 stops: found again, only alpha's; then alpha's too: nobody, said so.
    await inv('session:stop', beta, 'hb1')
    check("…one stops: found again, the other's alone", !!(await fresh(async () => JSON.stringify(await groups()) === JSON.stringify(['alpha:hb1']))), JSON.stringify(await groups()))
    await inv('session:stop', alpha, 'hb1')
    check('…nobody works on it now: said so, nothing past substituted', !!(await fresh(async () => /Nobody is working on/.test(await view.locator('.pane-empty').innerText().catch(() => '')))), await view.innerText().catch(() => ''))
    await shoot('3-nobody-dark')
    await forCard.getByRole('button').click()
    void one

    // --- From the Progress panel: a run's details, and a lane's menu (Show in Activity).
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', target: 'main', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool', commands: {} } })
    const lc = (await inv('tasks:create', { title: 'Lane card', project: 'beta' })).number
    const lane = await inv('lanes:start', beta, { builder: 'hb1', reviewer: null, pool: true, cards: [lc], name: 'Activity lane' })
    check("beta's lane starts its builder", !!(await until(async () => !!(await liveOf(beta, 'hb1'))?.sessionId, HUNG_MS)), JSON.stringify(lane))
    await page.locator('.progress-rail').click().catch(() => undefined)
    const panel = page.locator('.progress-panel')
    await until(async () => (await panel.count()) === 1, HUNG_MS)
    const laneId = (lane.lane ?? lane).id
    const laneRow = panel.locator(`.progress-lane[data-lane="${laneId}"]`)
    await until(async () => (await laneRow.count()) === 1, HUNG_MS)
    await laneRow.locator('.progress-lane-top').click({ button: 'right' })
    await lib.menuEntry(page, 'Show in Activity').click()
    check("a lane's Show in Activity: the workspace level on its builder", !!(await fresh(async () => JSON.stringify(await groups()) === JSON.stringify(['beta:hb1']) && /1 agent/.test(await head.locator('.activity-pick').first().innerText().catch(() => '')))), JSON.stringify(await groups()))
    // A run of beta's HB1 (its own token, as cw-progress sends it), its details' Show in Activity.
    const launches = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const token = launches.filter((l) => same(l.env?.CW_PROJECT ?? '', beta) || same(l.cwd, slotA)).at(-1)?.token
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/progress`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'e2e: activity run' }) })
    const runId = (await res.json().catch(() => null))?.id
    check("beta's HB1 reports a run", !!runId, String(res.status))
    const tab = panel.locator('.progress-tab[data-tab="runs"]')
    if ((await tab.getAttribute('aria-selected').catch(() => null)) !== 'true') await tab.click().catch(() => undefined)
    const runRow = panel.locator(`.progress-run[data-run="${runId}"]`)
    await until(async () => {
      for (const h of await panel.locator('.progress-card-toggle[aria-expanded="false"], .progress-group-head[aria-expanded="false"]').all()) await h.click().catch(() => undefined)
      return (await runRow.count()) === 1
    }, HUNG_MS)
    await runRow.locator('.progress-bar').click()
    await until(async () => (await runRow.locator('.progress-details').count()) === 1, HUNG_MS)
    await runRow.locator('.progress-details').getByRole('button', { name: 'Show in Activity' }).click()
    check("a run's Show in Activity: the workspace level on its agent", !!(await fresh(async () => JSON.stringify(await groups()) === JSON.stringify(['beta:hb1']))), JSON.stringify(await groups()))
    await fetch(`http://127.0.0.1:${PORT}/v1/progress/${runId}/finish`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) }).catch(() => undefined)

    // --- Light theme.
    await inv('settings:update', { appearance: { theme: 'light' } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', HUNG_MS)
    await page.mouse.move(5, 5)
    await shoot('4-lane-light')
    await forCard.getByRole('button').click().catch(() => undefined)
    await head.locator('.activity-pick').first().click()
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')
    await fresh(async () => (await groups()).length >= 2)
    await shoot('5-workspace-light')
    // Another workspace opened while a card's agents are found: it never opens there (HR5's round 1).
    const s1 = await settled()
    await page.locator('.activity-btn[aria-label="Task Board"]').click()
    await card.click()
    await page.locator('.dialog[role="dialog"]').getByRole('button', { name: 'Activity', exact: true }).click()
    await inv('workspace:open', otherWs)
    check('another workspace opened while its agents are found: Activity stays shut there', !!(await until(async () => (await settled()).settled > s1.settled, HUNG_MS)) && (await settled()).dropped === s1.dropped + 1 && (await page.locator('.activity-for-card').count()) === 0 && (await page.evaluate(() => document.title)).includes('activityworkspace-other-ws'), JSON.stringify([s1, await settled()]))
    await lib.openWorkspace(inv, page, ws)
    for (const [p, id] of [[beta, 'hb1'], [home, 'assistant']]) await inv('session:stop', p, id).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`Screenshots: ${shots}`)
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
