// The Activity map (HI-2903): the Activity tab's reads drawn as a honeycomb. HB1 and HB2 run the fake Claude Code; HB1
// works on a card. With HB1 alone in the filter its map shows: the fake drives each station (Read, Edit, Shell, Agents,
// Tools, You), a failed call turns Shell red, a fetched URL shows only its host, and the context ring turns amber at 70 %
// and red at 90 % (69 % stays as it is). Live, a new call sends a pulse; frozen, Map off or hidden, nothing is drawn,
// pulsed or read by the map (its counters). All agents: one shared map with an agent ring each, and a click on a ring
// shows that agent alone, the selection, its tabs and the strip kept, switching with another ring, back with the same or
// Escape (HI-3180). A prompt counts at You, by the word only. The map follows Hide finished, in the project's tab
// and the workspace's view; a turns read only the map wanted, held in main while the map is turned off, applies nothing
// once released. An agent set up while the shared map shows gets its context ring once it starts (HI-2929; a 0.9 worktree
// agent: NOT RUN on a packaged build, CW_EXE, where the rest runs). The Show toggles are kept. HI-3179: long paths and
// a long tool name stay inside their hexes (a file name, cut in its middle), wide and narrow; Last actions under the
// graph at full width; the split beside the list dragged, kept and reset. Both themes, wide and narrow. Fake Claude Code only (no sign-in, no tokens). Dev build, throwaway profile, workspace and CLI homes; quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'activitymap-profile')
const ws = path.join(lib.WORK, 'activitymap-ws')
const claudeHome = path.join(lib.WORK, 'activitymap-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const AGENTS = ['HB1', 'HB2'].map((n) => ({ id: n.toLowerCase(), name: n, provider: 'claude-code' }))

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: AGENTS }))
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47937), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const shots = path.join(lib.WORK, 'activitymap-shots')
  fs.mkdirSync(shots, { recursive: true })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const shoot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) })
    const counts = () => page.evaluate(() => ({ ...window.__cwActivityMap }))

    await inv('tasks:create', { title: 'Map card', project: 'alpha', agent: 'hb1', column: 'doing' })
    await page.getByText('alpha', { exact: true }).first().click()
    const liveOf = async (id) => (await inv('session:live')).find((x) => x.agentId === id) ?? null
    const idle = async (id) => ['ready', 'finished'].includes((await liveOf(id))?.status)
    for (const id of ['hb1', 'hb2']) {
      await inv('session:start', alpha, { agentId: id })
      await lib.until(() => idle(id), HUNG_MS)
    }
    /** A prompt for an agent, and its turn done. */
    const turn = async (id, text) => {
      await lib.sendPrompt(inv, lib.ptyKey(alpha, id), text, { submitted: async () => (await liveOf(id))?.status === 'working' })
      await lib.until(() => idle(id), HUNG_MS, 250)
    }

    // --- The tab, filtered to HB1, live: its own map.
    await page.locator('.tab', { hasText: 'Activity' }).click()
    const head = page.locator('.activity-head')
    // Hide finished off: the map, as the list, shows the agents between their turns (it follows that filter: below).
    await head.locator('.activity-hide input').uncheck()
    await head.locator('.activity-pick').first().click()
    await lib.menuEntry(page, 'HB1').click()
    await page.keyboard.press('Escape')
    const map = page.locator('.activity-map')
    check('one agent in the filter: its own map, beside the list', !!(await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'single', HUNG_MS, 250)))
    const toggles = page.locator('.activity-map-toggles')
    check('the Show toggles: Map, Feed and Context, all on', (await toggles.locator('[data-toggle][aria-pressed="true"]').count()) === 3)
    await head.getByRole('button', { name: 'Play', exact: true }).click()

    // --- Each station, a failure, names only, and a context under the amber line.
    const before = await counts()
    await turn('hb1', 'window 100000 then context 69000 then tool Read src/alpha/a.ts then tool Write src/alpha/b.ts then tool Bash npm-run-lint fail then tool WebFetch https://docs.example.com:8443/private/page?q=hush then tool WebFetch https://u:pw@login.example.com/ then tool Skill then tool mcp__github__get_issue then tool Agent')
    const station = (s) => page.locator(`.activity-map-station[data-station="${s}"]`)
    const countAt = async (s) => Number(await station(s).getAttribute('data-count').catch(() => '-1'))
    const all = ['you', 'read', 'edit', 'shell', 'agents', 'tools']
    check('each station counts this turn: You (its prompt), Read, Edit, Shell, Agents, Tools', !!(await lib.until(async () => (await countAt('you')) === 1 && (await countAt('read')) >= 1 && (await countAt('edit')) >= 1 && (await countAt('shell')) >= 1 && (await countAt('agents')) >= 1 && (await countAt('tools')) >= 3, HUNG_MS, 250)), JSON.stringify(await Promise.all(all.map(countAt))))
    check("…the prompt named by a word, never its text", /Prompt/.test(await station('you').evaluate((e) => e.textContent)) && !/window 100000|context 69000/.test(await map.evaluate((e) => e.textContent)))
    check('a failed call turns its station red', (await station('shell').getAttribute('data-failed')) === 'yes' && (await station('read').getAttribute('data-failed')) === 'no')
    const feed = page.locator('.activity-map-feed')
    const feedText = await feed.innerText()
    check("the feed names a fetched page by its host only: no port, path or query", /docs\.example\.com/.test(feedText) && !/8443|private|hush/.test(feedText), feedText)
    check("…and one whose address the log masks (a user and password) by its tool only", !/login\.example|pw/.test(feedText) && /WebFetch/.test(feedText), feedText)
    check('…a file by its last two segments, a command by its tool only', /alpha\/a\.ts/.test(feedText) && !/npm-run-lint/.test(feedText) && /Bash/.test(feedText), feedText)
    check('…and the map nowhere shows a command or a query', !/npm-run-lint|hush|pw/.test(await map.evaluate((e) => e.textContent)))
    const ctx = page.locator('.activity-map-context')
    const level = () => ctx.getAttribute('data-level').catch(() => null)
    check('context 69 %: the ring as it is', !!(await lib.until(async () => (await level()) === 'ok', HUNG_MS, 250)), String(await level()))
    const after = await counts()
    check('live, the new calls sent pulses', after.pulses > before.pulses, JSON.stringify([before, after]))
    await shoot('1-single-dark')

    // --- The thresholds: amber from 70 %, red from 90 %.
    await turn('hb1', 'window 100000 then context 70000 then tool Read src/alpha/c.ts')
    check('context 70 %: amber', !!(await lib.until(async () => (await level()) === 'amber', HUNG_MS, 250)), String(await level()))
    await turn('hb1', 'window 100000 then context 90000 then tool Read src/alpha/d.ts')
    check('context 90 %: red', !!(await lib.until(async () => (await level()) === 'red', HUNG_MS, 250)), String(await level()))
    await shoot('2-single-red-dark')

    // --- Frozen: nothing pulses.
    await head.getByRole('button', { name: 'Pause', exact: true }).click()
    const frozen0 = await counts()
    await turn('hb1', 'tool Read src/alpha/e.ts')
    await lib.until(async () => (await page.locator('.activity-pill').count()) > 0, HUNG_MS, 250)
    const frozen1 = await counts()
    check('frozen: no pulse for the calls that came meanwhile (counted in the pill instead)', frozen1.pulses === frozen0.pulses, JSON.stringify([frozen0, frozen1]))
    // Back to live: the calls held aren't sent as new (a new baseline). Counted from before Play (HI-2939: the burst came
    // with Play itself, before the pill went).
    await head.getByRole('button', { name: 'Play', exact: true }).click()
    await lib.until(async () => (await page.locator('.activity-pill').count()) === 0, HUNG_MS, 250)
    await lib.until(async () => (await countAt('read')) >= 1, HUNG_MS, 250)
    const relive = await counts()
    check('going live again: what was held sends no burst of pulses', relive.pulses === frozen1.pulses && relive.flying === 0, JSON.stringify([frozen1, relive]))

    // --- Hidden (the window minimised): no map reads, drawing or pulses.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // Taken once the map has the hide (pulses still in flight are dropped: one drawing), then nothing more may come.
    await lib.until(async () => {
      const c = await counts()
      return !c.active && c.flying === 0
    }, HUNG_MS, 100)
    const hidden0 = await counts()
    await turn('hb1', 'window 100000 then context 20000 then tool Read src/alpha/f.ts then tool Write src/alpha/g.ts')
    const hidden1 = await counts()
    check('hidden: the map reads, draws and pulses nothing', hidden1.reads === hidden0.reads && hidden1.turnReads === hidden0.turnReads && hidden1.renders === hidden0.renders && hidden1.pulses === hidden0.pulses, JSON.stringify([hidden0, hidden1]))
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // Shown again, it opens frozen as the tab does: Play to follow.
    await lib.until(async () => (await head.getByRole('button', { name: 'Play', exact: true }).count()) === 1, HUNG_MS, 250)
    const shown0 = await counts()
    await head.getByRole('button', { name: 'Play', exact: true }).click()
    await lib.until(async () => (await level()) === 'ok', HUNG_MS, 250)
    check('shown again: no burst of pulses for what came while hidden', (await counts()).pulses === shown0.pulses, JSON.stringify([shown0, await counts()]))

    // --- Map off: gone, and the map's own reads and pulses stop (the list keeps its own).
    await toggles.locator('[data-toggle="map"]').click()
    check('Map off: the map is gone, the list stays', !!(await lib.until(async () => (await map.count()) === 0, HUNG_MS, 250)) && (await page.locator('.activity-body > .activity-list, .activity-body > .pane-empty').count()) === 1)
    const off0 = await counts()
    await turn('hb1', 'window 100000 then context 30000 then tool Read src/alpha/h.ts')
    const off1 = await counts()
    check('Map off: no map reads, drawing or pulses', off1.reads === off0.reads && off1.turnReads === off0.turnReads && off1.renders === off0.renders && off1.pulses === off0.pulses, JSON.stringify([off0, off1]))
    await toggles.locator('[data-toggle="map"]').click()
    await lib.until(async () => (await map.count()) === 1, HUNG_MS, 250)
    // Feed off: kept for the next time.
    await toggles.locator('[data-toggle="feed"]').click()
    check('Feed off: the feed is gone, the map stays', !!(await lib.until(async () => (await feed.count()) === 0, HUNG_MS, 250)) && (await map.count()) === 1)
    check('…and kept', (await page.evaluate(() => localStorage.getItem('combwork.activity.map'))) === JSON.stringify({ map: true, feed: false, context: true }))
    await toggles.locator('[data-toggle="feed"]').click()

    // --- A read only the map wants (HB2's session: the list shows HB1's tab), held in main (CW_TEST_HOLD_IPC) while the map
    // is turned off: released, it applies nothing, and no map read starts with the map off (HR2's round 1).
    const heldTurns = () => app.evaluate(() => globalThis.__cwHeldIpc?.['activity:turns'] ?? 0)
    const gated = async (where, scope) => {
      const mapIn = page.locator(`${scope} .activity-map`)
      const mapToggle = page.locator(`${scope} .activity-map-toggles [data-toggle="map"]`)
      await mapToggle.click()
      await lib.until(async () => (await mapIn.count()) === 0, HUNG_MS, 250)
      await app.evaluate(() => {
        process.env.CW_TEST_HOLD_IPC = 'activity:turns'
      })
      const c0 = await counts()
      await mapToggle.click()
      const started = await lib.until(async () => (await counts()).turnReads > c0.turnReads && (await heldTurns()) >= 1, HUNG_MS, 100)
      await mapToggle.click()
      await lib.until(async () => (await mapIn.count()) === 0, HUNG_MS, 250)
      const c1 = await counts()
      await app.evaluate(() => {
        delete process.env.CW_TEST_HOLD_IPC
      })
      await lib.until(async () => (await heldTurns()) === 0, HUNG_MS, 100)
      // Calls made after the release answer after the held ones: the window has had their answers by then.
      for (let i = 0; i < 3; i++) await inv('session:live')
      const c2 = await counts()
      check(`${where}: a map read held while the map was turned off applies nothing once released`, !!started && c2.turnsApplied === c0.turnsApplied, JSON.stringify([c0, c1, c2]))
      check(`${where}: …and no map read starts while the map is off`, c2.turnReads === c1.turnReads, JSON.stringify([c1, c2]))
      await mapToggle.click()
      await lib.until(async () => (await mapIn.count()) === 1, HUNG_MS, 250)
    }
    await head.locator('.activity-pick').first().click()
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')
    await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'shared', HUNG_MS, 250)
    await gated('the project tab', '.activity-tab')

    // --- All agents: one shared map, a ring each; HB2's call among HB1's.
    check('all agents: one shared map', !!(await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'shared', HUNG_MS, 250)))
    const rings = page.locator('.activity-map-ring')
    check('…with a context ring per agent', !!(await lib.until(async () => (await rings.count()) === 2, HUNG_MS, 250)), String(await rings.count()))
    await head.getByRole('button', { name: 'Play', exact: true }).click().catch(() => undefined)
    await turn('hb2', 'window 100000 then context 40000 then tool Read src/beta/z.ts then tool Bash')
    check("HB2's calls count on the shared map beside HB1's", !!(await lib.until(async () => /beta\/z\.ts/.test(await feed.innerText().catch(() => '')), HUNG_MS, 250)))
    check('…each agent its own colour in the feed', (await feed.locator('.activity-map-dot').count()) > 0)
    await shoot('3-shared-dark')
    // HI-3180 (Darren's decision): a click on a ring shows that agent's map, the selection and the strip staying, so a
    // click switches to another; that one again, or Escape, shows them all.
    const pickText = () => head.locator('.activity-pick').first().innerText()
    const selection = await pickText()
    const centre = () => page.locator('.activity-map-centre').evaluate((e) => e.textContent).catch(() => '')
    const shownAlone = async (name) => (await map.getAttribute('data-mode').catch(() => null)) === 'single' && new RegExp(name).test(await centre())
    const marked = () => rings.evaluateAll((els) => els.filter((e) => e.getAttribute('aria-current') === 'true').map((e) => e.textContent))
    await rings.filter({ hasText: 'HB2' }).click()
    check("a click on HB2's ring shows its map alone", !!(await lib.until(() => shownAlone('HB2'), HUNG_MS, 250)))
    check('…the selection kept: the same Agents ▾, the same tabs', (await pickText()) === selection && (await page.locator('.activity-tab:not(.activity-workspace) .activity-agent-tab').count()) === 2, `${await pickText()} (was ${selection})`)
    check('…the strip still lists both agents, HB2 marked', (await rings.count()) === 2 && JSON.stringify((await marked()).map((t) => /HB2/.test(t))) === '[true]', JSON.stringify(await marked()))
    check("…and the list shows HB2's tab", !!(await lib.until(async () => (await page.locator('.activity-tab:not(.activity-workspace) .activity-agent-tab[aria-selected="true"]').innerText().catch(() => '')).includes('HB2'), HUNG_MS, 250)))
    await shoot('3b-strip-picked-dark')
    await rings.filter({ hasText: 'HB1' }).click()
    check('a click on another ring switches to it, the selection still kept', !!(await lib.until(() => shownAlone('HB1'), HUNG_MS, 250)) && (await pickText()) === selection && (await rings.count()) === 2)
    await rings.filter({ hasText: 'HB1' }).click()
    check('…the same ring again: every agent again, the shared map', !!(await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'shared', HUNG_MS, 250)) && (await marked()).length === 0)
    await rings.filter({ hasText: 'HB2' }).click()
    await lib.until(() => shownAlone('HB2'), HUNG_MS, 250)
    await page.keyboard.press('Escape')
    check('…and Escape does too', !!(await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'shared', HUNG_MS, 250)))
    await rings.filter({ hasText: 'HB2' }).click()
    await lib.until(() => shownAlone('HB2'), HUNG_MS, 250)

    // --- Hide finished, as the list has it, on a frozen snapshot that has settled (nothing new comes in to redraw it, HR2's
    // round 2): both agents idle, no map; off again, the map is back.
    await head.locator('.activity-pick').first().click()
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')
    await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'shared', HUNG_MS, 250)
    if ((await head.getByRole('button', { name: 'Pause', exact: true }).count()) === 1) await head.getByRole('button', { name: 'Pause', exact: true }).click()
    await head.getByRole('button', { name: 'Refresh', exact: true }).click()
    await lib.until(async () => (await head.getByRole('button', { name: 'Play', exact: true }).count()) === 1 && (await map.getAttribute('data-mode').catch(() => null)) === 'shared', HUNG_MS, 250)
    await head.locator('.activity-hide input').check()
    check('the project tab, frozen, Hide finished on and both agents idle: no map, as the list shows nothing', !!(await lib.until(async () => (await map.count()) === 0 && (await page.locator('.activity-tab .pane-empty').count()) === 1, HUNG_MS, 250)))
    await head.locator('.activity-hide input').uncheck()
    check('…Hide finished off, still frozen: the shared map again', !!(await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'shared', HUNG_MS, 250)) && (await head.getByRole('button', { name: 'Play', exact: true }).count()) === 1)

    // --- The workspace's Activity (the activity bar): its own Hide finished (on), then its shared map, and its held read.
    await page.locator('.activity-btn[aria-label="Activity"]').click()
    const wsMap = page.locator('.activity-workspace .activity-map')
    const wsHead = page.locator('.activity-workspace .activity-head')
    await lib.until(async () => (await wsHead.count()) === 1, HUNG_MS, 250)
    check('the workspace view, Hide finished on and both agents idle: no map', !!(await lib.until(async () => (await wsMap.count()) === 0 && (await page.locator('.activity-workspace .pane-empty').count()) === 1, HUNG_MS, 250)))
    await wsHead.locator('.activity-hide input').uncheck()
    check('…Hide finished off: one shared map of the workspace, a ring per agent', !!(await lib.until(async () => (await wsMap.getAttribute('data-mode').catch(() => null)) === 'shared' && (await page.locator('.activity-workspace .activity-map-ring').count()) === 2, HUNG_MS, 250)))
    await gated('the workspace view', '.activity-workspace')
    await page.locator('.activity-btn[aria-label="Projects"]').click()
    await lib.until(async () => (await head.count()) === 1, HUNG_MS, 250)

    // --- An agent set up while the shared map shows (HI-2929): its worktree's setup command waits for a gate, so the map
    // first has it setting up; started (the same session id), its ring shows its context as its footer does, never "—".
    // Its agent is a 0.9 worktree agent (the test copies' channel): a packaged build (CW_EXE) skips it, saying so.
    if (process.env.CW_EXE) console.log('NOT RUN an agent set up while the map shows (HI-2929) needs an unpackaged build: not run with CW_EXE')
    else {
      const gate = path.join(shots, 'setup-gate')
      const setupScript = path.join(shots, 'setup.cjs')
      fs.writeFileSync(setupScript, `const fs = require('fs')\nconst t = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(t); console.log('CW-SETUP-DONE') } }, 100)\n`)
      await inv('project:updateConfig', alpha, { worktreeSetup: `"${process.execPath}" "${setupScript}"` })
      const hb3 = await lib.addAgent(inv, alpha, { location: 'new-worktree', name: 'HB3' })
      if ((await head.getByRole('button', { name: 'Play', exact: true }).count()) === 1) await head.getByRole('button', { name: 'Play', exact: true }).click()
      await inv('session:start', alpha, { agentId: hb3.id })
      const ring3 = page.locator(`.activity-map-ring[data-agent="${hb3.id}"]`)
      check('HB3 is set up while the shared map shows it', !!(await lib.until(async () => (await liveOf(hb3.id))?.settingUp === true && (await ring3.count()) === 1, HUNG_MS, 250)))
      const setUpAs = (await liveOf(hb3.id))?.sessionId
      fs.writeFileSync(gate, '')
      await lib.acceptClaudeTrust(inv, alpha, hb3.id)
      await lib.until(() => idle(hb3.id), HUNG_MS)
      check('…then starts under the session id it was set up with', !!setUpAs && (await liveOf(hb3.id))?.sessionId === setUpAs, JSON.stringify([setUpAs, (await liveOf(hb3.id))?.sessionId]))
      await turn(hb3.id, 'window 100000 then context 50000 then tool Read src/alpha/i.ts')
      const ring3Text = () => ring3.locator('.faint').innerText().catch(() => '')
      check("…and its ring shows its context (50 %), not '—'", !!(await lib.until(async () => /50/.test(await ring3Text()), HUNG_MS, 250)), await ring3Text())
      await shoot('7-set-up-while-shown-dark')
      await inv('session:stop', alpha, hb3.id).catch(() => undefined)
    }

    // --- Light theme, and a narrow window: the map above the list.
    await head.locator('.activity-pick').first().click()
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')
    await inv('settings:update', { appearance: { theme: 'light' } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', HUNG_MS)
    await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'shared', HUNG_MS, 250)
    await shoot('4-shared-light')
    await head.locator('.activity-pick').first().click()
    await lib.menuEntry(page, 'HB1').click()
    await page.keyboard.press('Escape')
    await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'single', HUNG_MS, 250)
    await shoot('5-single-light')

    // --- HI-3179: the long names of Darren's screenshot. Each hex's text stays inside its outline (a path by its file
    // name, cut in its middle; the whole on hover); Last actions under the graph at full width; the split beside the
    // list dragged, kept and reset.
    await turn('hb1', 'tool Read lanequeue-shots/ended-today-long-narrowest.png then tool Edit installer/interrupted.ps1 then tool mcp__windows-sandbox__sandbox_screenshot')
    check('the long names reach their stations', !!(await lib.until(async () => /ended-today-long-narrowest\.png/.test((await station('read').locator('title').textContent()) ?? '') && /interrupted\.ps1/.test((await station('edit').locator('title').textContent()) ?? ''), HUNG_MS, 250)), String(await station('read').locator('title').textContent().catch(() => '')))
    // Each text's box (the SVG's own units) against its hex's outline; the centre's against its own.
    const textsOutside = () =>
      map.evaluate((m) => {
        const inside = (pts, x, y) => {
          let c = false
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) if (pts[i][1] > y !== pts[j][1] > y && x < ((pts[j][0] - pts[i][0]) * (y - pts[i][1])) / (pts[j][1] - pts[i][1]) + pts[i][0]) c = !c
          return c
        }
        const out = []
        for (const g of m.querySelectorAll('.activity-map-station, .activity-map-centre')) {
          const pts = g.querySelector(':scope > polygon').getAttribute('points').trim().split(/\s+/).map((p) => p.split(',').map(Number))
          for (const t of g.querySelectorAll(':scope > text')) {
            const b = t.getBBox()
            if (![[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].every(([x, y]) => inside(pts, x, y))) out.push(`${g.dataset.station ?? 'centre'}: ${t.textContent}`)
          }
        }
        return out
      })
    const lastOf = (s) => station(s).locator('.activity-map-station-last').textContent()
    // Fitted by its drawn width (HR1's round 2): how much of its start shows is the font's; its shape is not.
    const cutAs = (text, start, end) => typeof text === 'string' && text.startsWith(start) && text.endsWith(`…${end}`) && !text.includes('/')
    check('Read shows the file name alone, cut in its middle', cutAs(await lastOf('read'), 'ended-t', '.png'), await lastOf('read'))
    check('…Edit too', cutAs(await lastOf('edit'), 'interru', '.ps1'), await lastOf('edit'))
    check('…a long tool name cut in its middle, its start and end kept', /…/.test(await lastOf('tools')) && /^\S+…\S+$/.test(await lastOf('tools')), await lastOf('tools'))
    check('…the whole on the hover', /lanequeue-shots\/ended-today-long-narrowest\.png/.test(await station('read').locator('title').textContent()))
    const boardBox = () => page.locator('.activity-map-board').boundingBox()
    const feedBox = () => feed.boundingBox()
    for (const [width, label] of [[1500, 'wide'], [900, 'narrow']]) {
      await lib.fitWindow(app, page, { width, height: 900 })
      await page.waitForFunction((w) => window.innerWidth === w, width)
      check(`${label}: no hex text crosses its outline`, !!(await lib.until(async () => (await textsOutside()).length === 0, HUNG_MS, 250)), JSON.stringify(await textsOutside()))
      const [b, f, m] = [await boardBox(), await feedBox(), await map.boundingBox()]
      check(`${label}: Last actions under the graph, at the map's full width`, !!b && !!f && !!m && f.y >= b.y + b.height - 1 && f.width >= m.width - 24 - 2, JSON.stringify({ b, f, m }))
      await shoot(`7-long-names-${label}-light`)
    }
    // Wide characters (HR1's rounds 1 and 2), drawn by fallback fonts: a CJK file name and a full-width one, then a flag
    // sequence's and a wide Arabic ligature's, each fitted by its drawn width, never cut inside a character, and inside
    // its hex. (The fake CLI's tool names are ASCII only: a wide tool name, cut by the same function, is
    // tests/activityMap.test.ts's.)
    const titleOf = async (s) => (await station(s).locator('title').textContent().catch(() => '')) ?? ''
    const wideTurns = [
      { label: 'CJK and full-width', read: `dir/${'日'.repeat(20)}.ps1`, edit: `dir/ｆｕｌｌｗｉｄｔｈ${'Ｘ'.repeat(10)}.txt`, readStart: '日', readEnd: '.ps1', editStart: 'ｆ', editEnd: '.txt', shot: '7b-wide-names' },
      { label: 'flags and a ligature', read: `dir/${'🇬🇧'.repeat(20)}.ps1`, edit: `dir/${'ﷺ'.repeat(12)}.md`, readStart: '🇬🇧', readEnd: '.ps1', editStart: 'ﷺ', editEnd: '.md', shot: '7c-flags' }
    ]
    for (const w of wideTurns) {
      await turn('hb1', `tool Read ${w.read} then tool Edit ${w.edit}`)
      const [readName, editName] = [w.read.split('/').pop(), w.edit.split('/').pop()]
      check(`${w.label}: the names reach their stations, whole on the hover`, !!(await lib.until(async () => (await titleOf('read')).includes(readName) && (await titleOf('edit')).includes(editName), HUNG_MS, 250)), `${await titleOf('read')} | ${await titleOf('edit')}`)
      check(`…each cut in its middle between characters, its extension kept`, cutAs(await lastOf('read'), w.readStart, w.readEnd) && cutAs(await lastOf('edit'), w.editStart, w.editEnd) && [...(await lastOf('read')).split('…')[0]].length % [...w.readStart].length === 0, `${await lastOf('read')} | ${await lastOf('edit')}`)
      for (const [width, label] of [[1500, 'wide'], [900, 'narrow']]) {
        await lib.fitWindow(app, page, { width, height: 900 })
        await page.waitForFunction((x) => window.innerWidth === x, width)
        check(`…${label}: no text crosses its hex's outline`, !!(await lib.until(async () => (await textsOutside()).length === 0, HUNG_MS, 250)), JSON.stringify(await textsOutside()))
        await shoot(`${w.shot}-${label}-light`)
      }
    }
    // Wide again: the map beside the list, the split at its right edge.
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    const list = page.locator('.activity-body > .activity-list, .activity-body > .pane-empty').first()
    check('wide: the map beside the list', !!(await lib.until(async () => {
      const [m, l] = [await map.boundingBox(), await list.boundingBox()]
      return m && l && Math.abs(m.x + m.width - l.x) <= 2 ? true : null
    }, HUNG_MS, 250)))
    const split = map.locator(':scope > .pane-resizer')
    const wasW = (await map.boundingBox()).width
    const svgWas = (await page.locator('.activity-map-svg').boundingBox()).height
    const sb = await split.boundingBox()
    await page.mouse.move(sb.x + sb.width / 2, sb.y + 100)
    await page.mouse.down()
    await page.mouse.move(sb.x + sb.width / 2 + 160, sb.y + 100, { steps: 6 })
    await page.mouse.up()
    check('the split drags: the map 160 px wider', !!(await lib.until(async () => Math.abs((await map.boundingBox()).width - (wasW + 160)) <= 3, HUNG_MS, 250)), `${wasW} → ${(await map.boundingBox()).width}`)
    check('…kept as the app\'s other splits are', !!(await lib.until(async () => Math.abs(((await inv('ui:get')).panes?.activityMap ?? 0) - (wasW + 160)) <= 3, HUNG_MS, 250)), JSON.stringify((await inv('ui:get')).panes?.activityMap))
    check('…and the graph fills what it gained', (await page.locator('.activity-map-svg').boundingBox()).height >= svgWas - 1)
    await shoot('8-split-dragged-light')
    await split.dblclick()
    check('…a double-click puts it back', !!(await lib.until(async () => Math.abs((await map.boundingBox()).width - wasW) <= 3 && (await inv('ui:get')).panes?.activityMap == null, HUNG_MS, 250)), String((await map.boundingBox()).width))
    await lib.fitWindow(app, page, { width: 900, height: 900 })
    const above = await lib.until(async () => {
      const m = await map.boundingBox()
      // The list, or what it says with nothing running (both agents are idle by now).
      const l = await page.locator('.activity-body > .activity-list, .activity-body > .pane-empty').first().boundingBox()
      return m && l && m.y + m.height <= l.y + 1 ? true : null
    }, HUNG_MS, 250)
    check('narrow: the map above the list', !!above)
    await shoot('6-narrow-light')
    const overflow = await page.evaluate(() => document.querySelector('.activity-tab').scrollWidth > document.querySelector('.activity-tab').clientWidth + 1)
    check('narrow: nothing wider than the tab', !overflow)
    await inv('session:stop', alpha, 'hb1').catch(() => undefined)
    await inv('session:stop', alpha, 'hb2').catch(() => undefined)
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
