// Hive's loop wakes (#405), on fake Claude Code agents (fake-claude/) with no card watches: a card in a lane arriving in
// Review wakes the lane's reviewer; a failed verdict and a passing one wake the builder; a wake waits while its agent
// works and is typed once it is idle; an agent whose own watch tells it gets one line, not two (a builder waiting for
// Passed alone still hears of a failed verdict); a wake waiting while the lane's reviewer changes goes to the new one;
// one waiting while its round is reviewed and failed is dropped;
// a card nobody reviews wakes no one; a project that turned it off (Project Settings → Card loops) wakes no one. Each wake is noted on its
// card. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'loopwakes-profile')
const ws = path.join(lib.WORK, 'loopwakes-ws')
const claudeHome = path.join(lib.WORK, 'loopwakes-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47866))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  // The wakes as their checks read them: cards by number (they name them by key too, #1219: checked once below).
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => lib.unkey(w.text))
  }
  const say = async (id, text) => {
    await inv('pty:write', lib.ptyKey(alpha, id), text)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  }
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const said = async (n) => (await card(n))?.history.map((h) => `${h.by}: ${h.what}`) ?? []

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  const other = await lib.addAgent(inv, alpha, { name: 'Other' })
  const newCard = async (title, column = 'doing') => {
    const n = (await inv('tasks:create', { title, project: 'alpha', agent: builder.id })).number
    if (column !== 'todo') await inv('tasks:update', n, { column, agent: builder.id })
    return n
  }
  for (const a of [builder, reviewer, other]) await inv('session:start', alpha, { agentId: a.id })
  check('the agents start', !!(await until(async () => (await idle(builder.id)) && (await idle(reviewer.id)) && (await idle(other.id)), HUNG_MS)))
  const c1 = await newCard('First')
  const c2 = await newCard('Second')
  const c3 = await newCard('Third', 'todo')
  const c5 = await newCard('Fifth')
  const c6 = await newCard('Sixth')
  // The builder registers its lane (card-loop does): Reviewer reviews its cards. Card 4 is in no lane.
  const lane = (who) => `hive hive_lane ${JSON.stringify({ action: 'start', cards: [c1, c2, c3, c5, c6], reviewer: who })}`
  await say(builder.id, lane('Reviewer'))
  check('the lane is registered', !!(await until(async () => (await inv('lanes:list')).some((l) => l.reviewer?.id === reviewer.id), 15000)))
  await until(() => idle(builder.id), 15000)

  // Into Review, no watches: the reviewer is woken, the builder (who moved it) isn't.
  await say(builder.id, `boardmove ${c1} review`)
  check('a card arriving in Review wakes its reviewer', !!(await until(async () => wakes('Reviewer').length === 1, 20000)) && wakes('Reviewer')[0] === `[Hive] #${c1} (Builder's card) is in Review. You review this card in its loop: carry on with it (hive_read_task with latestComment for the comment in full).`, JSON.stringify(wakes('Reviewer')))
  check('…naming the card by key, with the number the tools take (#1219)', fs.readFileSync(path.join(claudeHome, 'fake-wakes.jsonl'), 'utf8').split('\n').some((l) => lib.KEYED.test(l)))
  check('…noted on the card', !!(await until(async () => (await said(c1)).includes('Hive: Woke Reviewer (alpha) to review it (a loop wake)'), 10000)), JSON.stringify(await said(c1)))
  check("…and the builder isn't woken by its own move", wakes('Builder').length === 0, JSON.stringify(wakes('Builder')))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // Failed: the builder is woken with the verdict.
  await say(reviewer.id, `boardreview ${c1} start then boardreview ${c1} failed`)
  check('a failed verdict wakes the builder', !!(await until(async () => wakes('Builder').length === 1, 20000)) && new RegExp(`^\\[Hive\\] #${c1} is in Review: Reviewer \\(alpha\\) failed it\\. This is your card in its loop: carry on`).test(wakes('Builder')[0]), JSON.stringify(wakes('Builder')))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // The reviewer works: the builder returns the card; nothing is typed into the reviewer until it is idle, then once.
  await say(reviewer.id, 'work 8')
  check('the reviewer is working', !!(await until(async () => (await live(reviewer.id))?.status === 'working', 10000)))
  await say(builder.id, `boardmove ${c1} review`)
  await until(async () => (await said(c1)).some((x) => /Returned for review, round 2|Moved to Review/.test(x) && x.startsWith('Builder')), 10000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that nothing is typed while it works.
  check('nothing is typed into a working agent', (await live(reviewer.id))?.status === 'working' && wakes('Reviewer').length === 1, JSON.stringify({ status: (await live(reviewer.id))?.status, wakes: wakes('Reviewer') }))
  check('…it is woken once it is idle', !!(await until(async () => wakes('Reviewer').length === 2, 30000)) && wakes('Reviewer')[1].startsWith(`[Hive] #${c1} (Builder's card) was returned for review (round 2)`), JSON.stringify(wakes('Reviewer')))
  await lib.sleep(2000) // A fixed wait on purpose: no second line for the same handoff.
  check('…once', wakes('Reviewer').length === 2, JSON.stringify(wakes('Reviewer')))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // Passed: the builder is woken.
  await say(reviewer.id, `boardreview ${c1} start then boardreview ${c1} passed passed`)
  check('a passing verdict wakes the builder', !!(await until(async () => wakes('Builder').length === 2, 20000)) && wakes('Builder')[1].startsWith(`[Hive] #${c1} is in Passed: Reviewer (alpha) passed it`), JSON.stringify(wakes('Builder')))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // The reviewer waits with its own watch: one line, its watch's, not two.
  await say(reviewer.id, `hive hive_wait_for_tasks ${JSON.stringify({ cards: [c2], column: 'review', wake: true })}`)
  check('the reviewer watches the next card', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)))
  await say(builder.id, `boardmove ${c2} review`)
  check("its own watch wakes it", !!(await until(async () => wakes('Reviewer').length === 3, 20000)) && /Your card watch has ended/.test(wakes('Reviewer')[2]), JSON.stringify(wakes('Reviewer')))
  await lib.sleep(3000) // A fixed wait on purpose: this checks that a second line does NOT come.
  check('…one line, not two', wakes('Reviewer').length === 3 && !(await said(c2)).some((x) => x.startsWith('Hive: Woke')), JSON.stringify({ wakes: wakes('Reviewer').slice(2), history: await said(c2) }))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // The builder waits for Passed alone; a failed verdict leaves the card in Review, which that watch doesn't count: Hive
  // wakes the builder, once. The passing verdict then moves it to Passed: the watch tells it, and Hive doesn't too.
  await say(builder.id, `hive hive_wait_for_tasks ${JSON.stringify({ cards: [c2], column: 'passed', wake: true })}`)
  check('the builder watches for Passed alone', !!(await until(async () => (await live(builder.id))?.status === 'watching', 15000)))
  await say(reviewer.id, `boardreview ${c2} start then boardreview ${c2} failed`)
  check('a failed verdict its Passed watch misses still wakes the builder', !!(await until(async () => wakes('Builder').length === 3, 20000)) && /failed it\. This is your card in its loop/.test(wakes('Builder')[2]), JSON.stringify(wakes('Builder')))
  await until(async () => (await idle(reviewer.id)) && ['ready', 'finished', 'watching'].includes((await live(builder.id))?.status), 15000)
  await say(reviewer.id, `boardreview ${c2} start then boardreview ${c2} passed passed`)
  check('…and the passing one comes from its watch', !!(await until(async () => wakes('Builder').length === 4, 20000)) && /Your card watch has ended/.test(wakes('Builder')[3]), JSON.stringify(wakes('Builder')))
  await lib.sleep(3000) // A fixed wait on purpose: this checks that a second line does NOT come.
  check('…one line, not two', wakes('Builder').length === 4 && (await said(c2)).filter((x) => x === 'Hive: Woke Builder (alpha) with its verdict (a loop wake)').length === 1, JSON.stringify({ wakes: wakes('Builder').slice(3), history: await said(c2) }))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // The reviewer, working on the user's prompt to review it, reviews and fails a card that arrived meanwhile: the
  // arrival's wake is dropped (the round is reviewed), and the builder is woken with the verdict.
  await say(reviewer.id, `work 6 then boardreview ${c6} start then boardreview ${c6} failed`)
  check('the reviewer is busy with its prompt', !!(await until(async () => (await live(reviewer.id))?.status === 'working', 10000)))
  await say(builder.id, `boardmove ${c6} review`)
  check('…and reviews the card that arrived meanwhile', !!(await until(async () => (await said(c6)).includes('Reviewer (alpha): Review failed'), 30000)), JSON.stringify(await said(c6)))
  check('the builder is woken with that verdict', !!(await until(async () => wakes('Builder').some((x) => x.startsWith(`[Hive] #${c6} is in Review: Reviewer (alpha) failed it`)), 20000)), JSON.stringify(wakes('Builder')))
  await until(() => idle(reviewer.id), 20000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that the reviewed arrival is NOT told.
  check("the reviewer isn't told of the arrival it has reviewed", wakes('Reviewer').length === 3 && !(await said(c6)).some((x) => x.startsWith('Hive: Woke Reviewer')), JSON.stringify({ wakes: wakes('Reviewer').slice(3), history: await said(c6) }))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // A wake waiting for the reviewer (working) when the lane's reviewer becomes Other: Other gets it, Reviewer doesn't.
  await say(reviewer.id, 'work 10')
  check('the reviewer is working again', !!(await until(async () => (await live(reviewer.id))?.status === 'working', 10000)))
  await say(builder.id, `boardmove ${c5} review`)
  await until(async () => (await card(c5))?.column === 'review', 10000)
  await until(() => idle(builder.id), 15000)
  await say(builder.id, lane('Other'))
  check("the lane's reviewer is now Other", !!(await until(async () => (await inv('lanes:list')).some((l) => l.reviewer?.id === other.id), 15000)))
  check('the waiting wake goes to the new reviewer', !!(await until(async () => wakes('Other').length === 1, 30000)) && wakes('Other')[0].startsWith(`[Hive] #${c5} (Builder's card) is in Review. You review this card in its loop`), JSON.stringify(wakes('Other')))
  await until(() => idle(reviewer.id), 20000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that the old reviewer gets nothing.
  check('…and not to the old one', wakes('Reviewer').length === 3, JSON.stringify(wakes('Reviewer').slice(3)))
  await until(async () => (await idle(other.id)) && (await idle(builder.id)), 15000)

  // A card in no lane that nobody has reviewed: no one is woken.
  const c4 = await newCard('Fourth')
  await say(builder.id, `boardmove ${c4} review`)
  await until(async () => (await card(c4))?.column === 'review', 10000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that nothing comes.
  check('a card with no reviewer wakes no one', wakes('Reviewer').length === 3, JSON.stringify(wakes('Reviewer').slice(3)))

  // Turned off for the project: a lane card arriving in Review wakes no one.
  await inv('project:updateConfig', alpha, { loopWakes: false })
  await say(builder.id, `boardmove ${c3} review`)
  await until(async () => (await card(c3))?.column === 'review', 10000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that nothing comes.
  check('turned off in Project Settings: no one is woken', wakes('Reviewer').length === 3 && wakes('Other').length === 1 && !(await said(c3)).some((x) => x.startsWith('Hive: Woke')), JSON.stringify({ wakes: [...wakes('Reviewer').slice(3), ...wakes('Other').slice(1)], history: await said(c3) }))

  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
