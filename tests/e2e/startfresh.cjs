// Fresh starts at natural breaks (#1437, SPEC §16.10.4): on fake Claude Code agents, the Assistant never started, with
// Combwork "focused" (stubbed: a test window never takes the OS focus) so its notices are banners:
// 1. A lane ends (its card Done) with every agent idle: one "A good moment to start fresh" banner, with Start Fresh
//    (Idle Agents).
// 2. Its button opens Start Fresh (Idle Agents)' question: the two idle agents start fresh, a working one and a stopped
//    one are left as they are (listed with why); the old conversations stay in the Sessions tab.
// 3. With no lane running, a solo card Done: one banner. A card still in Review: none (until it is Done itself).
// 4. Settings → Notifications' switch off: none.
// 5. A lane ends, or a solo card is Done, while its agent is still in its turn: not yet; told once the turn ends.
// 6. The banner's button with another project shown (beta, nothing running): alpha's question all the same.
// Screenshots of the question and the banner, light and dark. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const userData = path.join(lib.WORK, 'startfresh-profile')
const ws = path.join(lib.WORK, 'startfresh-ws')
const home = path.join(lib.WORK, 'startfresh-claude-home')
const shots = path.join(lib.WORK, 'startfresh-shots')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const PORT = Number(lib.port(47818))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  const env = lib.fakeClaude(userData, home, [alpha, beta, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT) }, viewport: { width: 1400, height: 850 } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id) ?? null
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const say = async (id, text) => {
      // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
      await lib.typeLine(inv, lib.ptyKey(alpha, id), home, null, text, { live: () => live(id) })
    }
    const hiveLog = () => fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')
    /** The nudges Combwork told, by what ended (its log line names it). */
    const nudges = () => [...hiveLog().matchAll(/Suggested a fresh start in .*?\((.+?)\)/g)].map((m) => m[1])
    /** The decisions not to suggest one, by what ended and why. */
    const notNudged = () => [...hiveLog().matchAll(/No fresh-start suggestion in .*?\((.+?)\): (.+)/g)].map((m) => `${m[1]}: ${m[2].trim()}`)
    const banner = page.locator('.popups .popup', { hasText: 'A good moment to start fresh' })
    /** Closes the fresh-start banners shown (one at a time, each seen gone). */
    const closeBanners = async () => {
      for (let n = await banner.count(); n > 0; n = await banner.count()) {
        await banner.first().locator('.popup-close').click()
        await until(async () => (await banner.count()) < n, HUNG_MS)
      }
    }
    const themed = async (name, shoot) => {
      for (const theme of ['light', 'dark']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes(theme), HUNG_MS)
        await shoot(path.join(shots, `startfresh-${name}-${theme}.png`))
      }
      await inv('settings:update', { appearance: { theme: 'light' } })
    }
    // Combwork focused: its notices are banners in the window, as the notification settings say.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.isFocused = () => true
      w.emit('focus')
    })
    await page.getByText('alpha', { exact: true }).first().click()
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder', workflowRole: 'builder' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer', workflowRole: 'reviewer' })
    const busy = await lib.addAgent(inv, alpha, { name: 'Busy' })
    const stopped = await lib.addAgent(inv, alpha, { name: 'Stopped' })
    for (const a of [builder, reviewer, busy]) await inv('session:start', alpha, { agentId: a.id })
    check('three agents run, idle; one stays stopped', !!(await until(async () => (await idle(builder.id)) && (await idle(reviewer.id)) && (await idle(busy.id)), HUNG_MS)) && !(await live(stopped.id)))
    const conv = { builder: (await live(builder.id)).sessionId, reviewer: (await live(reviewer.id)).sessionId, busy: (await live(busy.id)).sessionId }

    // --- 1. A lane ends with every agent idle: one nudge.
    const a = (await inv('tasks:create', { title: 'Greeting says Hi', project: 'alpha', agent: builder.id, column: 'doing' })).number
    await say(builder.id, `hive cw_lane ${JSON.stringify({ action: 'start', cards: [a], reviewer: 'Reviewer', name: 'greetings' })}`)
    const lane = await until(async () => (await inv('lanes:list')).find((l) => l.state === 'active' && l.cards.length === 1), HUNG_MS)
    check('the lane runs', !!lane, JSON.stringify(await inv('lanes:list')))
    await until(() => idle(builder.id), HUNG_MS)
    await inv('tasks:update', a, { column: 'done' })
    check('the lane ends with its card Done', !!(await until(async () => (await inv('lanes:list')).find((l) => l.id === lane.id)?.state === 'ended', HUNG_MS)))
    check('…one nudge: "A good moment to start fresh", for the lane', !!(await until(async () => (await banner.count()) === 1 && nudges().length === 1, HUNG_MS)) && nudges()[0] === `lane:${lane.id}`, JSON.stringify(nudges()))
    check('…with Start Fresh (Idle Agents)', (await banner.locator('button.btn', { hasText: 'Start Fresh (Idle Agents)' }).count()) === 1)
    await themed('nudge', (file) => banner.screenshot({ path: file }))

    // --- 2. Its button: the question lists who will and won't; the idle two start fresh, the working and stopped are left.
    await say(busy.id, 'holduntil busy-go')
    check('Busy is working meanwhile', !!(await until(async () => (await live(busy.id))?.status === 'working', HUNG_MS)))
    await banner.locator('button.btn', { hasText: 'Start Fresh (Idle Agents)' }).click()
    const dialog = page.locator('.modal, [role="dialog"]').filter({ hasText: 'Start 2 idle agents fresh?' }).first()
    check('the question: Start 2 idle agents fresh?', !!(await until(async () => (await dialog.count()) === 1, HUNG_MS)))
    const text = await dialog.innerText()
    check('…Builder and Reviewer start fresh, Busy is working, Stopped stays stopped', /Builder: idle: starts fresh/.test(text) && /Reviewer: idle: starts fresh/.test(text) && /Busy: working: left as it is/.test(text) && /Stopped: stopped: left stopped/.test(text), text)
    await themed('question', (file) => dialog.screenshot({ path: file }))
    await dialog.locator('button', { hasText: /^Start Fresh$/ }).click()
    const freshNow = async (id, was) => (await idle(id)) && (await live(id))?.sessionId && (await live(id)).sessionId !== was
    check('Builder and Reviewer are in new conversations', !!(await until(async () => (await freshNow(builder.id, conv.builder)) && (await freshNow(reviewer.id, conv.reviewer)), HUNG_MS)))
    check('…Busy kept its conversation, still working; Stopped is still stopped', (await live(busy.id))?.sessionId === conv.busy && (await live(busy.id))?.status === 'working' && !(await live(stopped.id)))
    const listed = (await inv('session:list', alpha)).map((s) => s.id)
    check('…their old conversations stay in the Sessions tab', listed.includes(conv.builder) && listed.includes(conv.reviewer), JSON.stringify(listed))
    fs.writeFileSync(path.join(home, 'busy-go'), '')
    await until(() => idle(busy.id), HUNG_MS)

    // --- 3. No lane running: a solo card Done is one nudge; with a card in Review, none (until that one is Done).
    const waits = (await inv('tasks:create', { title: 'Waits for review', project: 'alpha', agent: builder.id, column: 'review' })).number
    const solo = (await inv('tasks:create', { title: 'Solo work', project: 'alpha', agent: builder.id, column: 'doing' })).number
    await inv('tasks:update', solo, { column: 'done' })
    check("a card in Review: no nudge for the solo card (its work hasn't finished)", !!(await until(async () => notNudged().includes(`card:${solo}: its work hasn't finished`), HUNG_MS)), JSON.stringify(notNudged()))
    await inv('tasks:update', waits, { column: 'done' })
    check('a card in Review: no nudge for the solo card; once it is Done, one, for it', !!(await until(async () => nudges().length === 2, HUNG_MS)) && nudges()[1] === `card:${waits}`, JSON.stringify(nudges()))

    // --- 4. The switch off (Settings → Notifications): none. Then on again: the next is told, and only it.
    await inv('settings:update', { notifications: { suggestFreshStart: false } })
    // An agent busy again (a new quiet spell follows): its turn seen to start, then to end.
    await say(builder.id, 'hello')
    await until(async () => (await live(builder.id))?.status === 'working', HUNG_MS)
    await until(() => idle(builder.id), HUNG_MS)
    const off = (await inv('tasks:create', { title: 'Done with the switch off', project: 'alpha', agent: builder.id, column: 'doing' })).number
    await inv('tasks:update', off, { column: 'done' })
    check('the switch off: none for its card', !!(await until(async () => notNudged().includes(`card:${off}: turned off`), HUNG_MS)), JSON.stringify(notNudged()))
    await inv('settings:update', { notifications: { suggestFreshStart: true } })
    const on = (await inv('tasks:create', { title: 'Done with it on again', project: 'alpha', agent: builder.id, column: 'doing' })).number
    await inv('tasks:update', on, { column: 'done' })
    check('the switch off: none for its card; on again: the next one only', !!(await until(async () => nudges().length === 3, HUNG_MS)) && nudges()[2] === `card:${on}` && !nudges().includes(`card:${off}`), JSON.stringify(nudges()))
    await closeBanners()

    // --- 5. The usual order: the work is marked Done while its agent is still in its turn. Not yet; told as it ends.
    const finishing = async (go, done, trigger) => {
      await say(builder.id, `holduntil ${go}`)
      await until(async () => (await live(builder.id))?.status === 'working', HUNG_MS)
      await done()
      const waited = !!(await until(async () => notNudged().includes(`${trigger()}: its work hasn't finished`), HUNG_MS))
      fs.writeFileSync(path.join(home, go), '')
      return waited
    }
    const b = (await inv('tasks:create', { title: 'Greeting says Hello', project: 'alpha', agent: builder.id, column: 'doing' })).number
    await say(builder.id, `hive cw_lane ${JSON.stringify({ action: 'start', cards: [b], reviewer: 'Reviewer', name: 'hellos' })}`)
    const lane2 = await until(async () => (await inv('lanes:list')).find((l) => l.state === 'active' && l.cards.some((x) => x.number === b)), HUNG_MS)
    await until(() => idle(builder.id), HUNG_MS)
    const laneWaited = await finishing('lane-go', () => inv('tasks:update', b, { column: 'done' }), () => `lane:${lane2.id}`)
    check('a lane ends while its builder finishes its turn: not yet', laneWaited, JSON.stringify(notNudged()))
    check('…told once the turn ends, for the lane', !!(await until(async () => nudges().length === 4, HUNG_MS)) && nudges()[3] === `lane:${lane2.id}`, JSON.stringify(nudges()))
    await until(() => idle(builder.id), HUNG_MS)
    await closeBanners()
    const c = (await inv('tasks:create', { title: 'Solo finish', project: 'alpha', agent: builder.id, column: 'doing' })).number
    check('a solo card Done while its agent finishes its turn: not yet', await finishing('solo-go', () => inv('tasks:update', c, { column: 'done' }), () => `card:${c}`), JSON.stringify(notNudged()))
    check('…told once the turn ends, for the card', !!(await until(async () => nudges().length === 5 && (await banner.count()) === 1, HUNG_MS)) && nudges()[4] === `card:${c}`, JSON.stringify(nudges()))

    // --- 6. Its button with another project shown (beta, no agent running): alpha's question, alpha shown.
    const shown = (name) => page.locator('.sidebar .project-row.selected', { hasText: name })
    await page.locator('.sidebar .project-row', { hasText: 'beta' }).first().click()
    check('beta shown', !!(await until(async () => (await shown('beta').count()) === 1, HUNG_MS)))
    await banner.locator('button.btn').click()
    const alphaQuestion = page.locator('.modal, [role="dialog"]').filter({ hasText: /idle agents? fresh\?/ }).first()
    check("the button with beta shown: alpha's question, alpha shown", !!(await until(async () => (await alphaQuestion.count()) === 1 && /in alpha start/.test(await alphaQuestion.innerText()) && (await shown('alpha').count()) === 1, HUNG_MS)))
    await alphaQuestion.locator('button', { hasText: 'Cancel' }).click()
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
