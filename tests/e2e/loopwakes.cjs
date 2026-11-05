// Combwork's loop wakes (#405), on fake Claude Code agents (fake-claude/) with no card watches: a card in a lane arriving in
// Review wakes the lane's reviewer; a failed verdict and a passing one wake the builder; a wake waits while its agent
// works and is typed once it is idle; an agent whose own watch tells it gets one line, not two (a builder waiting for
// Passed alone still hears of a failed verdict); a wake waiting while the lane's reviewer changes goes to the new one;
// one waiting while its round is reviewed and failed is dropped;
// a card nobody reviews wakes no one; a project that turned it off (its workflow option Wake reviewers and builders, HI-1766) wakes no one. Each wake is noted on its
// card. #1475: a blocked lane card's news (its builder's comment) wakes a lane watch, and a lane abandoned ends its
// reviewer's card watch, leaving it idle for a new conversation. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
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
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
  }
  const say = async (id, text) => {
    // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
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
  // Wakes name a card by its key with the number the tools take (#1219): its own key, from the board.
  const named = async (n) => `${(await card(n)).key}`
  const [n1, n5, n6] = [await named(c1), await named(c5), await named(c6)]
  check('the card has a key of its project', /^[A-Z]{2,4}-\d+$/.test(n1), n1)
  // The builder registers its lane (card-loop does): Reviewer reviews its cards. Card 4 is in no lane.
  const lane = (who) => `hive cw_lane ${JSON.stringify({ action: 'start', cards: [c1, c2, c3, c5, c6], reviewer: who })}`
  await say(builder.id, lane('Reviewer'))
  check('the lane is registered', !!(await until(async () => (await inv('lanes:list')).some((l) => l.reviewer?.id === reviewer.id), 15000)))
  await until(() => idle(builder.id), 15000)

  // Into Review, no watches: the reviewer is woken, the builder (who moved it) isn't.
  await say(builder.id, `boardmove ${c1} review`)
  check('a card arriving in Review wakes its reviewer', !!(await until(async () => wakes('Reviewer').length === 1, 20000)) && wakes('Reviewer')[0] === `[CW] ${n1} (Builder's card) is in Review. You review this card in its loop: carry on with it (cw_read_task with latestComment for the comment in full).`, JSON.stringify(wakes('Reviewer')))
  check('…noted on the card', !!(await until(async () => (await said(c1)).includes('Combwork: Woke Reviewer (alpha) to review it (a loop wake)'), 10000)), JSON.stringify(await said(c1)))
  check("…and the builder isn't woken by its own move", wakes('Builder').length === 0, JSON.stringify(wakes('Builder')))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // Failed: the builder is woken with the verdict, the card back in Doing (HI-1946).
  await say(reviewer.id, `boardreview ${c1} start then boardreview ${c1} failed`)
  check('a failed verdict wakes the builder', !!(await until(async () => wakes('Builder').length === 1, 20000)) && (wakes('Builder')[0] ?? '').startsWith(`[CW] ${n1} is in Doing: Reviewer (alpha) failed it. This is your card in its loop: carry on`), JSON.stringify(wakes('Builder')))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // The reviewer works: the builder submits the card again; nothing is typed into the reviewer until it is idle, then once.
  await say(reviewer.id, 'work 8')
  check('the reviewer is working', !!(await until(async () => (await live(reviewer.id))?.status === 'working', 10000)))
  await say(builder.id, `boardmove ${c1} review`)
  await until(async () => (await said(c1)).some((x) => /Returned for review, round 2|Moved to Review/.test(x) && x.startsWith('Builder')), 10000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that nothing is typed while it works.
  check('nothing is typed into a working agent', (await live(reviewer.id))?.status === 'working' && wakes('Reviewer').length === 1, JSON.stringify({ status: (await live(reviewer.id))?.status, wakes: wakes('Reviewer') }))
  check('…it is woken once it is idle', !!(await until(async () => wakes('Reviewer').length === 2, 30000)) && wakes('Reviewer')[1].startsWith(`[CW] ${n1} (Builder's card) is in Review.`), JSON.stringify(wakes('Reviewer')))
  await lib.sleep(2000) // A fixed wait on purpose: no second line for the same handoff.
  check('…once', wakes('Reviewer').length === 2, JSON.stringify(wakes('Reviewer')))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // Passed: the builder is woken.
  await say(reviewer.id, `boardreview ${c1} start then boardreview ${c1} passed passed`)
  check('a passing verdict wakes the builder', !!(await until(async () => wakes('Builder').length === 2, 20000)) && wakes('Builder')[1].startsWith(`[CW] ${n1} is in Passed: Reviewer (alpha) passed it`), JSON.stringify(wakes('Builder')))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // The reviewer waits with its own watch: one line, its watch's, not two.
  await say(reviewer.id, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [c2], column: 'review', wake: true })}`)
  check('the reviewer watches the next card', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)))
  await say(builder.id, `boardmove ${c2} review`)
  check("its own watch wakes it", !!(await until(async () => wakes('Reviewer').length === 3, 20000)) && /Your card watch has ended/.test(wakes('Reviewer')[2]), JSON.stringify(wakes('Reviewer')))
  await lib.sleep(3000) // A fixed wait on purpose: this checks that a second line does NOT come.
  check('…one line, not two', wakes('Reviewer').length === 3 && !(await said(c2)).some((x) => x.startsWith('Combwork: Woke')), JSON.stringify({ wakes: wakes('Reviewer').slice(2), history: await said(c2) }))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // The builder waits for Passed alone; a failed verdict sends the card back to Doing (HI-1946), which that watch doesn't
  // count: Combwork wakes the builder, once. Put in Review again, the passing verdict then moves it to Passed: the watch tells
  // it, and Combwork doesn't too.
  await say(builder.id, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [c2], column: 'passed', wake: true })}`)
  check('the builder watches for Passed alone', !!(await until(async () => (await live(builder.id))?.status === 'watching', 15000)))
  await say(reviewer.id, `boardreview ${c2} start then boardreview ${c2} failed`)
  check('a failed verdict its Passed watch misses still wakes the builder', !!(await until(async () => wakes('Builder').length === 3, 20000)) && /failed it\. This is your card in its loop/.test(wakes('Builder')[2]), JSON.stringify(wakes('Builder')))
  await until(async () => (await idle(reviewer.id)) && ['ready', 'finished', 'watching'].includes((await live(builder.id))?.status), 15000)
  // Its next round: the user moves it to Review again (the builder still watching for Passed), which wakes its reviewer.
  await inv('tasks:update', c2, { column: 'review' })
  check("…its next round in Review wakes the reviewer", !!(await until(async () => wakes('Reviewer').length === 4, 20000)) && wakes('Reviewer')[3].startsWith(`[CW] ${await named(c2)} (Builder's card) is in Review.`), JSON.stringify(wakes('Reviewer').slice(3)))
  await until(() => idle(reviewer.id), 15000)
  await say(reviewer.id, `boardreview ${c2} start then boardreview ${c2} passed passed`)
  check('…and the passing one comes from its watch', !!(await until(async () => wakes('Builder').length === 4, 20000)) && /Your card watch has ended/.test(wakes('Builder')[3]), JSON.stringify(wakes('Builder')))
  await lib.sleep(3000) // A fixed wait on purpose: this checks that a second line does NOT come.
  check('…one line, not two', wakes('Builder').length === 4 && (await said(c2)).filter((x) => x === 'Combwork: Woke Builder (alpha) with its verdict (a loop wake)').length === 1, JSON.stringify({ wakes: wakes('Builder').slice(3), history: await said(c2) }))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // The reviewer, working on the user's prompt to review it, reviews and fails a card that arrived meanwhile: the
  // arrival's wake is dropped (the round is reviewed), and the builder is woken with the verdict.
  await say(reviewer.id, `work 6 then boardreview ${c6} start then boardreview ${c6} failed`)
  check('the reviewer is busy with its prompt', !!(await until(async () => (await live(reviewer.id))?.status === 'working', 10000)))
  await say(builder.id, `boardmove ${c6} review`)
  check('…and reviews the card that arrived meanwhile', !!(await until(async () => (await said(c6)).includes('Reviewer (alpha): Review failed'), 30000)), JSON.stringify(await said(c6)))
  check('the builder is woken with that verdict', !!(await until(async () => wakes('Builder').some((x) => x.startsWith(`[CW] ${n6} is in Doing: Reviewer (alpha) failed it`)), 20000)), JSON.stringify(wakes('Builder')))
  await until(() => idle(reviewer.id), 20000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that the reviewed arrival is NOT told.
  check("the reviewer isn't told of the arrival it has reviewed", wakes('Reviewer').length === 4 && !(await said(c6)).some((x) => x.startsWith('Combwork: Woke Reviewer')), JSON.stringify({ wakes: wakes('Reviewer').slice(4), history: await said(c6) }))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)

  // A wake waiting for the reviewer (working) when the lane's reviewer becomes Other: Other gets it, Reviewer doesn't.
  await say(reviewer.id, 'work 10')
  check('the reviewer is working again', !!(await until(async () => (await live(reviewer.id))?.status === 'working', 10000)))
  await say(builder.id, `boardmove ${c5} review`)
  await until(async () => (await card(c5))?.column === 'review', 10000)
  await until(() => idle(builder.id), 15000)
  await say(builder.id, lane('Other'))
  check("the lane's reviewer is now Other", !!(await until(async () => (await inv('lanes:list')).some((l) => l.reviewer?.id === other.id), 15000)))
  check('the waiting wake goes to the new reviewer', !!(await until(async () => wakes('Other').length === 1, 30000)) && wakes('Other')[0].startsWith(`[CW] ${n5} (Builder's card) is in Review. You review this card in its loop`), JSON.stringify(wakes('Other')))
  await until(() => idle(reviewer.id), 20000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that the old reviewer gets nothing.
  check('…and not to the old one', wakes('Reviewer').length === 4, JSON.stringify(wakes('Reviewer').slice(4)))
  await until(async () => (await idle(other.id)) && (await idle(builder.id)), 15000)

  // A card in no lane that nobody has reviewed: no one is woken.
  const c4 = await newCard('Fourth')
  await say(builder.id, `boardmove ${c4} review`)
  await until(async () => (await card(c4))?.column === 'review', 10000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that nothing comes.
  check('a card with no reviewer wakes no one', wakes('Reviewer').length === 4, JSON.stringify(wakes('Reviewer').slice(4)))

  // HI-2428 (HI-2410): the reviewer starts its review, asks its builder with cw_request_builder and ends its turn with
  // no watch; the builder answers with a comment alone (cw_update_task with only a comment) at once, then posts the
  // result later as a plain comment. Each wakes the reviewer.
  await say(other.id, `boardreview ${c5} start then hive cw_request_builder ${JSON.stringify({ card: n5, text: 'Please post a full npm test record.' })}`)
  check("the reviewer's request wakes the builder", !!(await until(async () => wakes('Builder').some((x) => x.includes('Please post a full npm test record.')), 20000)), JSON.stringify(wakes('Builder').slice(-2)))
  await until(async () => (await idle(other.id)) && (await idle(builder.id)), 15000)
  const otherBefore = wakes('Other').length
  await say(builder.id, `hive cw_update_task ${JSON.stringify({ number: c5, comment: "@Other: you're right, running it now." })}`)
  check("the builder's first answer, a comment alone, wakes the reviewer", !!(await until(async () => wakes('Other').length === otherBefore + 1, 20000)) && wakes('Other')[otherBefore].includes(`The builder replies: "@Other: you're right, running it now."`), JSON.stringify(wakes('Other').slice(otherBefore)))
  await until(async () => (await idle(other.id)) && (await idle(builder.id)), 15000)
  await say(builder.id, `boardcomment ${c5}`)
  check('…and so does its later plain comment', !!(await until(async () => wakes('Other').length === otherBefore + 2, 20000)) && wakes('Other')[otherBefore + 1].includes('The builder replies: "Fake: done, see the files."'), JSON.stringify(wakes('Other').slice(otherBefore)))
  check('…each kept in the history', (await said(c5)).filter((x) => x.startsWith('Builder (alpha): Replied to the reviewer')).length === 2, JSON.stringify(await said(c5)))
  await until(async () => (await idle(other.id)) && (await idle(builder.id)), 15000)
  // Other's wakes so far: the checks below count from here.
  const otherSeen = wakes('Other').length

  // Turned off for the project: a lane card arriving in Review wakes no one.
  await lib.setOwnOptions(inv, alpha, { loopWakes: false })
  await say(builder.id, `boardmove ${c3} review`)
  await until(async () => (await card(c3))?.column === 'review', 10000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that nothing comes.
  check('turned off in its options: no one is woken', wakes('Reviewer').length === 4 && wakes('Other').length === otherSeen && !(await said(c3)).some((x) => x.startsWith('Combwork: Woke')), JSON.stringify({ wakes: [...wakes('Reviewer').slice(4), ...wakes('Other').slice(otherSeen)], history: await said(c3) }))

  // #1475, on again: a blocked card's news wakes a lane watch, and a lane abandoned ends its reviewer's card watch, which
  // leaves it idle for the next lane's prompt in a new conversation.
  await lib.setOwnOptions(inv, alpha, { loopWakes: undefined })
  await until(() => idle(builder.id), 15000)
  const c7 = await newCard('Seventh')
  const n7 = await named(c7)
  // The first lane has a card in flight, so a new list would queue: it is abandoned first.
  for (const l of (await inv('lanes:list')).filter((x) => x.state === 'active' || x.state === 'paused')) await inv('lanes:end', l.id, true)
  await say(builder.id, `hive cw_lane ${JSON.stringify({ action: 'start', cards: [c7], reviewer: 'Other' })}`)
  const lane2 = await until(async () => (await inv('lanes:list')).find((l) => l.state === 'active' && l.cards.some((c) => c.number === c7)), 15000)
  check('a second lane starts with a new card', !!lane2)
  await until(() => idle(builder.id), 15000)
  const watchLanes = async () => {
    await say(reviewer.id, `hive cw_wait_for_tasks ${JSON.stringify({ lanes: ['all'], wake: true })}`)
    return !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 15000))
  }
  check('Reviewer watches the lanes', await watchLanes())
  await inv('tasks:update', c7, { blocked: 'Screenshots for your OK' })
  check('a block wakes the lane watch', !!(await until(async () => wakes('Reviewer').length === 5, 20000)) && /is blocked/.test(wakes('Reviewer')[4]), JSON.stringify(wakes('Reviewer').slice(4)))
  await until(() => idle(reviewer.id), 15000)
  check('…which watches the lanes again', await watchLanes())
  await say(builder.id, `boardcomment ${c7}`)
  check("its builder's comment on the card still blocked wakes it (reblocked)", !!(await until(async () => wakes('Reviewer').length === 6, 20000)) && wakes('Reviewer')[5].includes(`${n7} is still blocked, with news: "Screenshots for your OK"`), JSON.stringify(wakes('Reviewer').slice(5)))
  await until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), 15000)
  // Other, the new lane's reviewer, waits for the card in Review; the lane is abandoned with the card still in Doing.
  await say(other.id, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [c7], column: 'review', wake: true })}`)
  check('Other waits for the card in Review', !!(await until(async () => (await live(other.id))?.status === 'watching', 15000)))
  await inv('lanes:end', lane2.id, true)
  check("an abandoned lane ends its reviewer's card watch, saying there's nothing more to wait for", !!(await until(async () => wakes('Other').length === otherSeen + 1, 20000)) && wakes('Other')[otherSeen] === `[CW] ${n7}'s lane was abandoned (your watch on it ended). Your card watch has ended: there is nothing more to wait for on it. Don't watch it again; end your turn unless you have other work.`, JSON.stringify(wakes('Other').slice(otherSeen)))
  check('…noted on the card', !!(await until(async () => (await said(c7)).includes("Combwork: Ended Other (alpha)'s watch on it: its lane was abandoned"), 10000)), JSON.stringify(await said(c7)))
  check('…and leaves it idle with no watch', !!(await until(async () => (await idle(other.id)) && !(await live(other.id))?.watch, 15000)), JSON.stringify(await live(other.id)))
  // The next lane's prompt reaches it in a new conversation (the Assistant's cw_prompt_agent, with its token).
  const home = (await inv('workspace:refresh')).assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  const assistantLive = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  await until(async () => (await assistantLive())?.status === 'waiting', HUNG_MS)
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  await until(async () => (await assistantLive())?.status === 'ready', HUNG_MS)
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`), 'utf8')).token
  const runBefore = (await live(other.id))?.runId
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/projects/alpha/agents/Other/prompt`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'work 1', newConversation: true }) })
  const body = await res.json().catch(() => null)
  check('…so the next lane is given to it in a new conversation', res.status === 200 && body?.newConversation === true && !!(await until(async () => (await live(other.id))?.runId !== runBefore, HUNG_MS)), JSON.stringify({ status: res.status, body }))

  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
