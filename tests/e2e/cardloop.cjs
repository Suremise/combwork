// The card loop with wake-on-change (#128), on two fake Claude Code agents (fake-claude/): a builder and a reviewer work
// through two cards in order, one passing first time and one failing once then passing, each waiting with
// cw_wait_for_tasks wake (no polling): Combwork types one line into the waiting agent when its card changes, and the
// fake answers it with the next line of its wake script. Checked: the order, the rounds, the final columns, one wake per
// change; the watching status (header, Agent API), dispatch refused while watching, cw_wait_for_agents not waiting on
// a watcher; no wake typed while the agent works or the user types; a watch surviving a stop and resume; Cancel. The
// loop's lane (#483): made by the reviewer's join, updated by the builder's start, ended once its cards are Done.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'cardloop-profile')
const ws = path.join(lib.WORK, 'cardloop-ws')
const claudeHome = path.join(lib.WORK, 'cardloop-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47901))
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
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  // A short typing pause, so the test of "not while the user types" doesn't take long.
  cfg.settings.assistant = { ...cfg.settings.assistant, typingPause: 4, enterEndsPause: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => !agent || w.agent === agent).map((w) => ({ ...w, raw: w.text, text: lib.unkey(w.text) }))
  }
  const script = (agent, lines) => fs.writeFileSync(path.join(claudeHome, `fake-wakes-${agent}.txt`), lines.join('\n') + '\n')
  const start = async (id) => {
    await inv('session:start', alpha, { agentId: id })
    return until(async () => (await live(id))?.status === 'ready', HUNG_MS)
  }
  /**
   * Types a prompt into an agent (as the user does), Enter included, once its fake takes prompts (lib.fakePrompts: its
   * session idle or watching, its last turn drawn over). Typed blind, a prompt that came as a turn ended on Combwork's side
   * but not yet on the fake's was dropped, and the suite then waited for a watch that never began (#1130).
   */
  const typers = new Map()
  const say = async (id, text) => {
    if (!typers.has(id)) typers.set(id, lib.fakePrompts(inv, lib.ptyKey(alpha, id), () => live(id), { home: claudeHome }))
    await typers.get(id).type(text)
  }
  // Cards as `#N`, their workspace numbers: a plain number reading as another card's key is refused (HI-2197).
  const wait = (n, extra) => `cw cw_wait_for_tasks ${JSON.stringify({ cards: (Array.isArray(n) ? n : [n]).map((x) => `#${x}`), ...extra, wake: true })}`

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  const first = await inv('tasks:create', { title: 'First card', project: 'alpha', agent: builder.id })
  const c1 = first.number
  const c2 = (await inv('tasks:create', { title: 'Second card', project: 'alpha', agent: builder.id })).number
  const built = (n) => `boardmove ${n} doing then ${wait(n, { changes: ['verdict', 'column'], column: 'passed' })} then boardmove ${n} review then boardcomment ${n}`
  // What each does when woken, in order: c1 passes first time; c2 fails once, then passes. A lane's next card starts once
  // the one before it is Done (#1270, OP-36; agents' moves are intents, #1268): the builder reports c1 merged first.
  script('Builder', [`boardmove ${c1} done then ${built(c2)}`, built(c2), 'work 1'])
  script('Reviewer', [
    `boardreview ${c1} start then boardreview ${c1} passed passed then ${wait(c2, { column: 'review' })}`,
    `boardreview ${c2} start then ${wait(c2, { column: 'review', fresh: true })} then boardreview ${c2} failed`,
    `boardreview ${c2} start then boardreview ${c2} passed passed`
  ])
  await start(reviewer.id)
  await start(builder.id)
  // The builder busy on other work first (watching a card of its own): the lane the reviewer's join makes then waits to
  // start c1, saying why, and the builder registers its lane and starts c1 itself (HI-2029: Combwork starts a lane's first
  // card on its builder once the builder is free).
  const elsewhere = (await inv('tasks:create', { title: 'Elsewhere', project: 'alpha' })).number
  await say(builder.id, wait(elsewhere, { column: 'done' }))
  await until(async () => (await live(builder.id))?.status === 'watching', HUNG_MS)

  // The reviewer joins the builder's lane first (#483): Combwork makes the lane, which the builder's own start then updates.
  // Then it waits for c1 to arrive in Review: watching, never idle.
  const lane = (body) => `cw cw_lane ${JSON.stringify(body)}`
  // The project's own Card loops rounds and wait (workflow options since HI-1766): the lane the join makes takes them.
  await lib.setOwnOptions(inv, alpha, { loopRounds: 7, loopWaitHours: 5 })
  await say(reviewer.id, `${lane({ action: 'join', builder: 'Builder', cards: [c1, c2] })} then ${wait(c1, { column: 'review' })}`)
  const watching = await until(async () => (await live(reviewer.id))?.status === 'watching', HUNG_MS)
  const st = await live(reviewer.id)
  check('the reviewer is watching: status watching, with what for', !!watching && st?.watch?.label === `Waiting for ${first.key} → Review`, JSON.stringify({ status: st?.status, watch: st?.watch }))
  // The window words the watch itself (HI-1679): the card by its key, where the Agent API's label above has its number.
  check('its header says so', !!(await until(async () => (await page.locator('.pane-status.watching', { hasText: `Waiting for ${first.key} → Review` }).count()) >= 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'cardloop-watching.png') })
  /** Whether the watching header's ⋯ (Cancel Card Watch is in its menu, #977) is on screen where a click lands on it (not clipped or covered). */
  const cancelHit = (agentName) =>
    page.locator('.pane-header-bar', { hasText: agentName }).locator('.pane-more').first().evaluate((b) => {
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { clickable: !!hit && (hit === b || b.contains(hit)), x: Math.round(r.x), width: Math.round(r.width), hit: hit?.className ?? null }
    })
  /** Polls cancelHit until ⋯ is clickable (the layout settles after a resize), bounded for a hung run. */
  const cancelHitWhenSettled = async (agentName) => (await until(async () => {
    const r = await cancelHit(agentName).catch(() => null)
    return r?.clickable && r
  }, HUNG_MS)) || (await cancelHit(agentName).catch(() => ({ clickable: false })))
  // Combwork's narrowest window (900 px), two panes: ⋯ still fits, the label gives way.
  await lib.fitWindow(app, page, { width: 900, height: 750 })
  const narrow = await cancelHitWhenSettled('Reviewer')
  check('at 900 px in two panes, ⋯ is where a click lands on it', narrow.clickable, JSON.stringify(narrow))
  await page.screenshot({ path: path.join(lib.WORK, 'cardloop-watching-narrow.png') })
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(500)
  const activity = await api('GET', `/v1/projects/alpha/agents/Reviewer/activity`)
  check('the Agent API reports it watching, with the cards', activity.body?.status === 'watching' && activity.body?.watching?.cards?.[0] === c1 && activity.body?.statusMessage === `Waiting for ${first.key} → Review`, JSON.stringify(activity.body).slice(0, 200))
  // Every status reply says what it waits for: project status, the project list and its short rows.
  // By its key everywhere (HI-1688): the Agent API's status, the project list and its short rows.
  const label = `Waiting for ${first.key} → Review`
  const status = (await api('GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Reviewer')
  check('project status: watching, statusMessage and the watch', status?.status === 'watching' && status?.statusMessage === label && status?.watching?.cards?.[0] === c1 && status?.watching?.column === 'review', JSON.stringify(status))
  const listed = (await api('GET', '/v1/projects')).body?.find((p) => p.name === 'alpha')?.agents?.find((a) => a.name === 'Reviewer')
  check('project list: the same', listed?.statusMessage === label && listed?.watching?.label === label, JSON.stringify(listed))
  const row = (await api('GET', '/v1/projects?view=short')).body?.find((p) => p.name === 'alpha')?.agents?.find((a) => a.name === 'Reviewer')
  check('project list, short rows: what it waits for', row?.status === 'watching' && row?.watching === label, JSON.stringify(row))
  // Quitting and closing treat a watcher as busy. The dialog says what it waits for; "Quit when agents finish" waits for
  // it only while another agent works on its card (c1 in Todo: no; in Doing with the builder: yes).
  await inv('settings:update', { general: { confirmOnQuit: 'working' } })
  const quitDialog = async () => {
    await inv('app:quit')
    await until(async () => (await page.locator('.quit-row').count()) > 0, 5000)
    const r = { rows: (await page.locator('.quit-row').allInnerTexts()).join(' | '), waitOffered: (await page.locator('.dialog button', { hasText: 'Quit when' }).count()) === 1 }
    await page.locator('.dialog button', { hasText: /^\s*Cancel\s*$/ }).click()
    await until(async () => (await page.locator('.quit-row').count()) === 0, 5000)
    return r
  }
  const dormant = await quitDialog()
  check('quit dialog: the watcher names its card; no waiting for a card nobody works on', dormant.rows.includes(`${first.key}`) && !dormant.waitOffered, JSON.stringify(dormant))
  await inv('tasks:update', c1, { column: 'doing', agent: builder.id })
  check('a card with another agent in Doing keeps quitting waiting', !!(await until(async () => (await quitDialog()).waitOffered, 8000)))
  let closed = false
  const closing = inv('workspace:close').then(() => (closed = true))
  const asked = await until(async () => !!(await inv('app:quitState'))?.request, 5000)
  check('closing the workspace asks before stopping a watcher', !!asked && !closed)
  await page.locator('.dialog button', { hasText: /^\s*Cancel\s*$/ }).click()
  await closing
  check('…and cancelling keeps it watching', (await live(reviewer.id))?.status === 'watching')
  await inv('tasks:update', c1, { column: 'todo' })
  // Merge and the Assistant's stop treat it as busy too (unit-tested: mergeBlocked, the stop route's question).
  // Dispatch: starting a card on a watching agent is refused (the user's Start too), saying why.
  const spare = (await inv('tasks:create', { title: 'Something else', project: 'alpha' })).number
  const refused = await inv('tasks:start', spare, { kind: 'agent', agentId: reviewer.id }).then(() => 'started', (e) => String(e?.message ?? e))
  check('a card started on a watching agent is refused, saying why', /card watch/.test(refused), refused)
  check('…and nothing was typed into it (still watching)', (await live(reviewer.id))?.status === 'watching')
  const t0 = Date.now()
  const waited = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Reviewer' }], timeoutSeconds: 20 })
  check('cw_wait_for_agents doesn’t wait on a watcher: it reports watching at once, with what for', waited.body?.agents?.[0]?.status === 'watching' && waited.body?.agents?.[0]?.statusMessage === label && waited.body?.agents?.[0]?.watching?.cards?.[0] === c1 && Date.now() - t0 < 5000 && waited.body?.timedOut === false, JSON.stringify(waited.body))

  const joined = (await api('GET', '/v1/lanes')).body?.[0]
  check('the reviewer joining made the lane (#483): the builder, the reviewer, the cards in order', joined?.builder?.name === 'Builder' && joined?.reviewer?.name === 'Reviewer' && joined?.cards?.map((c) => c.number).join() === `${c1},${c2}` && joined?.state === 'active' && joined?.current === c1, JSON.stringify(joined))
  check('…with the project’s own rounds and wait, as its workflow options resolve (HI-1766)', joined?.rounds === 7 && joined?.waitMinutes === 300, JSON.stringify({ rounds: joined?.rounds, waitMinutes: joined?.waitMinutes }))
  // Its first card not started while its builder watches other work, and the lane says so (HI-2029).
  const waitsStart = await until(async () => (await api('GET', '/v1/lanes')).body?.[0]?.status, HUNG_MS)
  check('…its first card waits to start while the builder watches other work, the lane saying so (HI-2029)', waitsStart?.reason === 'startWait' && waitsStart?.why === 'watching' && waitsStart?.card === c1 && (await card(c1))?.column === 'todo', JSON.stringify({ waitsStart, c1: (await card(c1))?.column }))
  // The builder registers its lane (the same one, now with its rounds and wait), works c1, watching for its verdict
  // before moving it to Review; then the loop runs by itself.
  await say(builder.id, `${lane({ action: 'start', cards: [c1, c2], reviewer: 'Reviewer', rounds: 3, waitMinutes: 240, name: 'two cards' })} then ${built(c1)}`)
  const registered = await until(async () => (await api('GET', '/v1/lanes')).body?.find((l) => l.rounds === 3), HUNG_MS)
  check("the builder's start updated that lane: one lane, its rounds, wait and name", (await api('GET', '/v1/lanes')).body?.length === 1 && registered?.id === joined?.id && registered?.waitMinutes === 240 && registered?.name === 'two cards' && registered?.startedBy === 'Reviewer (alpha)', JSON.stringify(registered))
  const done = await until(async () => (await card(c1))?.column === 'done' && (await card(c2))?.column === 'passed', 90000)
  check('c1 ends in Done (reported merged before c2 began), c2 in Passed (#170)', !!done, JSON.stringify({ c1: (await card(c1))?.column, c2: (await card(c2))?.column }))
  await until(async () => wakes('Builder').length >= 3 && (await live(builder.id))?.status === 'finished', 20000)
  const bw = wakes('Builder').map((w) => w.text)
  const rw = wakes('Reviewer').map((w) => w.text)
  check('the builder was woken once per verdict: c1 passed, c2 failed, c2 passed', bw.length === 3 && bw[0].includes(`#${c1}`) && bw[1].includes(`#${c2}`) && bw[2].includes(`#${c2}`), JSON.stringify(bw))
  // The reviewer watches the builder's cards: each wake says whose card it is (#143).
  check("the reviewer was woken once per arrival: c1, c2, c2 again, each naming the builder's card", rw.length === 3 && rw[0].includes(`#${c1} (Builder's card) is in Review`) && rw[1].includes(`#${c2} (Builder's card) is in Review`) && rw[2].includes(`#${c2} (Builder's card) is in Review`), JSON.stringify(rw))
  // The builder's own cards: no owner, the reviewer and its verdict named (#143); Passed isn't called unmerged on its own card.
  // A failed card is back in Doing with its builder (HI-1946).
  check("the builder's wakes name the reviewer's verdict: passed, failed, passed", bw.length === 3 && bw[0].includes(`#${c1} is in Passed: Reviewer (alpha) passed it;`) && bw[1].includes(`#${c2} is in Doing: Reviewer (alpha) failed it;`) && bw[2].includes(`#${c2} is in Passed: Reviewer (alpha) passed it;`), JSON.stringify(bw))
  check('…naming the card by key alone (#1219, HI-1661)', wakes().some((w) => lib.KEYED.test(w.raw ?? '')), JSON.stringify(wakes().slice(-2).map((w) => w.raw)))
  // A pass is one call (verdict, move to Passed and comment): the wake names that comment, not the builder's before it (#138).
  const passed = 'latest comment by Reviewer (alpha): "Fake review: passed."'
  check("the builder's wakes on a pass name the reviewer's comment from the same call", bw.length === 3 && bw[0].includes(passed) && bw[2].includes(passed), JSON.stringify(bw))
  const h2 = (await card(c2)).history.map((h) => h.what)
  check('c2: failed once, then passed (two rounds)', h2.filter((x) => x === 'Review failed').length === 1 && h2.filter((x) => x === 'Review passed').length === 1, h2.join(' | '))
  check('c1 passed first time', (await card(c1)).history.filter((h) => h.what === 'Review failed').length === 0)
  // Each move left its facts (#1216), over IPC: c2's start, two submissions, two reviews and their verdicts, its moves.
  const facts2 = await inv('tasks:facts', c2)
  const kinds2 = facts2.map((f) => f.kind)
  const subs2 = facts2.filter((f) => f.kind === 'Submitted')
  const verdicts2 = facts2.filter((f) => f.kind === 'Verdict')
  check("c2's facts: Started by the builder, then two submissions (rounds 1, 2), each reviewed and given its verdict", kinds2[0] === 'Started' && facts2[0].data.builder && subs2.length === 2 && subs2.map((f) => f.data.round).join() === '1,2' && kinds2.filter((k) => k === 'ReviewStarted').length === 2 && verdicts2.map((f) => f.data.pass).join() === 'false,true', JSON.stringify(kinds2))
  check('…each verdict on the submission before it, by the reviewer agent', verdicts2.every((v, i) => v.data.submission === subs2[i].seq && v.actor.startsWith('agent:')), JSON.stringify(verdicts2.map((v) => [v.actor, v.data.submission])))
  check('…its moves recorded as the agents asked them (intent), ending in Passed (approved)', facts2.filter((f) => f.kind === 'Moved').at(-1)?.data.to === 'approved' && facts2.filter((f) => f.kind === 'Moved').every((f) => f.data.cause === 'intent'), JSON.stringify(facts2.filter((f) => f.kind === 'Moved').map((f) => f.data)))
  const passedAt = (await card(c1)).history.find((h) => h.what === 'Review passed')?.at ?? ''
  const c2Doing = (await card(c2)).history.find((h) => h.what.startsWith('Moved to Doing'))?.at ?? ''
  check('in order: c1 passed before c2 was begun', !!passedAt && !!c2Doing && passedAt < c2Doing, JSON.stringify({ passedAt, c2Doing }))
  const end = await until(async () => (await live(builder.id))?.status === 'finished' && (await live(reviewer.id))?.status === 'finished', 15000)
  check('at the end neither is watching', !!end, JSON.stringify({ b: (await live(builder.id))?.status, r: (await live(reviewer.id))?.status }))
  // The lane as the window has it: c1 Done, c2 passed in two rounds, still running until it is merged.
  const passedLane = (await inv('lanes:list')).find((l) => l.id === joined?.id)
  check('the lane: c1 Done, c2 Passed after two rounds, nothing current, still active', passedLane?.state === 'active' && passedLane?.current === null && passedLane?.cards.map((c) => `${c.column}:${c.round}`).join() === 'done:1,passed:2', JSON.stringify(passedLane))
  // Merged (Done): the lane ends by itself and stays listed for now, with when it ended.
  await inv('tasks:update', c1, { column: 'done' })
  await inv('tasks:update', c2, { column: 'done' })
  const endedLane = await until(async () => (await inv('lanes:list')).find((l) => l.id === joined?.id && l.state === 'ended'), HUNG_MS)
  check('all its cards Done: the lane has ended, still listed, with its end time', !!endedLane?.endedAt, JSON.stringify(endedLane))

  // --- Not over the user's typing or the agent's own work; survives a stop and resume; Cancel.
  const third = await lib.addAgent(inv, alpha, { name: 'Third' })
  const c3 = (await inv('tasks:create', { title: 'Third card', project: 'alpha' })).number
  script('Third', ['work 1', 'work 1', 'work 1', 'work 1'])
  await start(third.id)
  await say(third.id, wait(c3, { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching', HUNG_MS)
  // The user types (no Enter) in its terminal, then the card changes: no wake while the user may still be typing.
  await inv('pty:write', lib.ptyKey(alpha, third.id), 'half a thought')
  await inv('tasks:comment', c3, 'First change')
  await lib.sleep(2000) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('no wake while the user is typing there', wakes('Third').length === 0, JSON.stringify(wakes('Third')))
  const afterPause = await until(async () => wakes('Third').length === 1, 15000)
  check('…and one wake once the typing pause has passed', !!afterPause && wakes('Third').length === 1)
  await until(async () => (await live(third.id))?.status === 'finished', HUNG_MS)
  // A watch, then the agent busy (a turn the user started): the change waits for its turn to end.
  await say(third.id, wait(c3, { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching', HUNG_MS)
  await say(third.id, 'work 4')
  await until(async () => (await live(third.id))?.status === 'working', HUNG_MS)
  await inv('tasks:comment', c3, 'Second change')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('no wake while the agent is working', wakes('Third').length === 1)
  check('…and one wake when its turn ends', !!(await until(async () => wakes('Third').length === 2, 15000)))
  await until(async () => (await live(third.id))?.status === 'finished', HUNG_MS)
  // A watch survives a stop and a resume: a change while it is stopped wakes it once it is back.
  await say(third.id, wait(c3, { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching', HUNG_MS)
  const sid = (await live(third.id)).sessionId
  await inv('session:stop', alpha, third.id)
  await until(async () => !(await live(third.id)), HUNG_MS)
  await inv('tasks:comment', c3, 'Third change')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('no wake while it is stopped', wakes('Third').length === 2)
  await inv('session:start', alpha, { agentId: third.id, resumeId: sid })
  check('…and one wake after it is resumed', !!(await until(async () => wakes('Third').length === 3, 30000)))
  await until(async () => (await live(third.id))?.status === 'finished', HUNG_MS)
  // Compact while watching: allowed (the watch is kept); a change during the compaction wakes it only once that has ended.
  await say(third.id, wait(c3, { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching', HUNG_MS)
  await page.keyboard.press('Control+3')
  await lib.sleep(500)
  // Compact… in its ⋯ (#977).
  await page.locator('.pane-header-bar', { hasText: 'Third' }).getByLabel('More').first().click()
  const compactItem = page.locator('.menu .menu-item', { hasText: 'Compact…' })
  await until(() => compactItem.isVisible(), HUNG_MS)
  check('Compact… is on for a watching agent', !(await compactItem.evaluate((el) => el.classList.contains('disabled'))))
  await compactItem.click()
  await page.locator('.compact-focus textarea').fill('hold 4')
  await page.locator('.dialog button', { hasText: /^\s*Compact\s*$/ }).click()
  const compactingNow = await until(async () => (await live(third.id))?.status === 'working', 8000)
  check('…it compacts, its watch kept', !!compactingNow && !!(await live(third.id))?.watch, JSON.stringify(await live(third.id)))
  await inv('tasks:comment', c3, 'During the compaction')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('no wake while it compacts', wakes('Third').length === 3, JSON.stringify(wakes('Third')))
  check('…and one wake once the compaction has ended', !!(await until(async () => wakes('Third').length === 4, 20000)))
  await until(async () => (await live(third.id))?.status === 'finished', HUNG_MS)
  // Cancel Card Watch in its ⋯ (#977): the watch ends, the status is finished again, and a change wakes nothing. A longer
  // label (three cards) in a narrow pane (three panes, under 340 px each): ⋯ stays clickable, and Cancel is chosen there.
  // Cards not in Done: a watch on one already there answers at once and never watches (HI-2153), as c1 and c2 are now.
  const open = [(await inv('tasks:create', { title: 'Open one', project: 'alpha' })).number, (await inv('tasks:create', { title: 'Open two', project: 'alpha' })).number]
  await say(third.id, wait([c3, ...open], { changes: ['comment'] }))
  check('Third watches three cards', !!(await until(async () => (await live(third.id))?.watch?.cards?.length === 3 && (await live(third.id))?.status === 'watching', HUNG_MS)), JSON.stringify(await live(third.id)))
  await page.keyboard.press('Control+3')
  await lib.sleep(500)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1))
  await lib.fitWindow(app, page, { width: 1100, height: 750 })
  const tight = await cancelHitWhenSettled('Third')
  check('three panes (under 340 px each), a three-card label: ⋯ is clickable', tight.clickable, JSON.stringify(tight))
  await page.screenshot({ path: path.join(lib.WORK, 'cardloop-watching-tight.png') })
  await page.locator('.pane-header-bar', { hasText: 'Third' }).getByLabel('More').first().click()
  check('the agent menu offers Cancel Card Watch', !!(await until(async () => (await page.getByText('Cancel Card Watch').count()) >= 1, HUNG_MS)))
  await page.getByText('Cancel Card Watch').first().click()
  check('Cancel ends the watch', !!(await until(async () => (await live(third.id))?.status === 'finished' && !(await live(third.id))?.watch, 5000)))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(500)
  await inv('tasks:comment', c3, 'Fourth change')
  await lib.sleep(2500) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('…and a later change wakes nothing', wakes('Third').length === 4)

  // --- A watch on another agent's card (a dependency, #143): the wake says whose card it is, and that Passed isn't merged.
  const dep = (await inv('tasks:create', { title: 'Needed first', project: 'alpha', agent: builder.id, column: 'review' })).number
  script('Third', ['work 1'])
  await say(third.id, wait(dep, { column: 'passed' }))
  const depWatched = await until(async () => (await live(third.id))?.watch?.cards?.includes(dep), HUNG_MS)
  check('Third watches the dependency before it moves', !!depWatched, JSON.stringify(await live(third.id)))
  await inv('tasks:update', dep, { column: 'passed' })
  check("a dependency's wake names its agent and says Passed isn't merged", !!(await until(async () => wakes('Third').length === 5, 15000)) && wakes('Third')[4].text.includes(`#${dep} (Builder's card) is in Passed (Passed isn't merged)`), JSON.stringify(wakes('Third').slice(4)))
  await until(async () => (await live(third.id))?.status === 'finished', HUNG_MS)

  // --- A bounded wait (no wake): it returns on a comment, a move and a verdict; times out; since misses nothing.
  const c4 = (await inv('tasks:create', { title: 'Waited on', project: 'alpha', agent: builder.id })).number
  const t1 = Date.now()
  const quiet = await api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 2 })
  check('no change: it times out (after the timeout), with a since', quiet.body?.timedOut === true && (quiet.body?.since ?? '').startsWith('@') && Date.now() - t1 >= 1900, JSON.stringify(quiet.body))
  // Each from the last wait's since (#1130): a change made before the wait has registered (under load) still counts.
  let lastSince = quiet.body?.since
  const onChange = async (change, cond = {}) => {
    const t = Date.now()
    const pending = api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 30, ...(lastSince ? { since: lastSince } : {}), ...cond })
    await change()
    const r = await pending
    lastSince = r.body?.since ?? lastSince
    return { r: r.body, ms: Date.now() - t }
  }
  const byComment = await onChange(() => inv('tasks:comment', c4, 'A note\nmore'), { changes: ['comment'] })
  check('it returns on a new comment, with its first line', byComment.r?.changes?.[0]?.changes?.includes('comment') && byComment.r.changes[0].comment?.firstLine === 'A note' && byComment.ms < 10000, JSON.stringify(byComment))
  const byMove = await onChange(() => inv('tasks:update', c4, { column: 'review' }), { column: 'review' })
  check('it returns on a move into the column', byMove.r?.changes?.[0]?.column === 'review' && byMove.ms < 10000, JSON.stringify(byMove))
  // since: a change between two waits is never missed.
  const since = byMove.r.since
  await inv('tasks:comment', c4, 'Between two waits')
  const missed = await api('POST', '/v1/tasks/wait', { cards: [c4], changes: ['comment'], since, timeoutSeconds: 5 })
  lastSince = missed.body?.since ?? lastSince
  check('with since, a change made between two waits is reported at once', missed.body?.changes?.[0]?.comment?.firstLine === 'Between two waits', JSON.stringify(missed.body))
  // A verdict: the reviewer's own tools (the wait itself as a script, the verdict through the reviewer's fake).
  const byVerdict = await onChange(() => say(reviewer.id, `boardreview ${c4} start then boardreview ${c4} failed`), { changes: ['verdict'] })
  check('it returns on a review verdict', byVerdict.r?.changes?.[0]?.changes?.includes('verdict'), JSON.stringify(byVerdict.r))
  // Per caller: at most two at a time.
  const a1 = api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 3 })
  const a2 = api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 3 })
  await lib.sleep(300)
  const a3 = await api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 3 })
  check('a third wait at once from the same caller is refused (429)', a3.status === 429, JSON.stringify(a3))
  await Promise.all([a1, a2])
  // Scope: a project agent's token waits only on its own project's cards.
  fs.mkdirSync(path.join(ws, 'beta'), { recursive: true })
  await inv('workspace:refresh')
  const c5 = (await inv('tasks:create', { title: 'Beta card', project: 'beta' })).number
  // Every agent here is alpha's: its newest token (the files don't name the project) is an alpha agent's.
  const tokenDir = path.join(userData, 'agent-api')
  const newest = fs.readdirSync(tokenDir).map((f) => ({ f, t: fs.statSync(path.join(tokenDir, f)).mtimeMs })).sort((x, y) => y.t - x.t)[0]
  const agentToken = newest ? JSON.parse(fs.readFileSync(path.join(tokenDir, newest.f), 'utf8')).token : null
  if (agentToken) {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/wait`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cards: [c5], timeoutSeconds: 1 }) })
    check("an alpha agent can't wait on beta's card (unknown to it)", r.status === 404, String(r.status))
  } else check('an agent token was found to test scope with', false, fs.readdirSync(path.join(userData, 'agent-api')).join(','))

  await page.screenshot({ path: path.join(lib.WORK, 'cardloop.png') })

  // --- Quit when agents finish, with only a watcher left: it waits while another agent works on a card the watcher
  // waits on, and quits once none is, though no wake comes (the cards leave Doing without reaching Review).
  const q1 = (await inv('tasks:create', { title: 'Quit one', project: 'alpha', column: 'doing', agent: builder.id })).number
  const q2 = (await inv('tasks:create', { title: 'Quit two', project: 'alpha', column: 'doing', agent: builder.id })).number
  const reviewerWakes = wakes('Reviewer').length
  await say(reviewer.id, wait([q1, q2], { column: 'review' }))
  await until(async () => (await live(reviewer.id))?.status === 'watching', HUNG_MS)
  await inv('app:quit')
  const quitWhen = page.locator('.dialog button', { hasText: 'Quit when' })
  await until(async () => (await quitWhen.count()) === 1, 5000)
  await quitWhen.click()
  const pendingNow = await until(async () => (await inv('app:quitState'))?.pending === true, 5000)
  check('a quit is pending, waiting on the watcher', !!pendingNow && (await inv('app:quitState')).working === 1, JSON.stringify(await inv('app:quitState')))
  const quitting = await lib.quitWatch(app)
  await inv('tasks:update', q1, { column: 'done' })
  await lib.sleep(2500) // A fixed wait on purpose: this checks that Combwork does NOT quit yet, which no condition can show.
  const still = await inv('app:quitState')
  check('…still waiting while the other card it watches is in Doing with the builder', still?.pending === true && still?.working === 1, JSON.stringify(still))
  const moved = Date.now()
  await inv('tasks:update', q2, { column: 'todo' })
  // Combwork decides to quit (#424): timed from the move; its process ending after that is Electron's, only waited for.
  check('…and Combwork quits once no watched card is being worked on', !!(await quitting.untilDecided(20000)) && (await quitting.gone(30000)), quitting.timings(moved))
  check('…without waking the watcher', wakes('Reviewer').length === reviewerWakes, JSON.stringify(wakes('Reviewer').slice(reviewerWakes)))
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
