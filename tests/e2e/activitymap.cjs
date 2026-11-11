// The Activity map (HI-2903): the Activity tab's reads drawn as a honeycomb. HB1 and HB2 run the fake Claude Code; HB1
// works on a card. With HB1 alone in the filter its map shows: the fake drives each station (Read, Edit, Shell, Agents,
// Tools, You), a failed call turns Shell red, a fetched URL shows only its host, and the context ring turns amber at 70 %
// and red at 90 % (69 % stays as it is). Live, a new call sends a pulse; frozen, Map off or hidden, nothing is drawn,
// pulsed or read by the map (its counters). All agents: one shared map with an agent ring each, and a click on a ring
// shows that agent alone. A prompt counts at You, by the word only. The map follows Hide finished, in the project's tab
// and the workspace's view; a turns read only the map wanted, held in main while the map is turned off, applies nothing
// once released. The Show toggles are kept. Both themes, wide and narrow. Fake Claude Code only (no sign-in, no
// tokens). Dev build, throwaway profile, workspace and CLI homes; quiet.
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
    await rings.filter({ hasText: 'HB2' }).click()
    check("a click on HB2's ring shows its map alone", !!(await lib.until(async () => (await map.getAttribute('data-mode').catch(() => null)) === 'single' && /HB2/.test(await page.locator('.activity-map-centre').evaluate((e) => e.textContent).catch(() => '')), HUNG_MS, 250)))

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
