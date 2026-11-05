// A card leaving the watch of an agent whose part in it ended (#420), on fake Claude Code agents (fake-claude/): a
// reviewer waiting for a card to arrive in Review is woken once when the card is given to another agent, and no longer
// waits; a watch on two cards keeps one that gets blocked (#481: paused, not gone), and wakes when it is unblocked and
// back in Review, also when the wake before told it there (#521); the card's new agent keeps its own watch; the card's history
// says whose watch ended; a card in Review stalls on a reviewer that hasn't started (#521), or that started and only
// watches it, with no verdict (#843). Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'watchrelease-profile')
const ws = path.join(lib.WORK, 'watchrelease-ws')
const claudeHome = path.join(lib.WORK, 'watchrelease-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47861))
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
  const watch = (cards, extra) => `cw cw_wait_for_tasks ${JSON.stringify({ cards, ...extra, wake: true })}`
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  const other = await lib.addAgent(inv, alpha, { name: 'Other' })
  const newCard = async (title) => {
    const n = (await inv('tasks:create', { title, project: 'alpha', agent: builder.id })).number
    await inv('tasks:update', n, { column: 'doing', agent: builder.id })
    return n
  }
  for (const a of [builder, reviewer, other]) await inv('session:start', alpha, { agentId: a.id })
  check('the agents start', !!(await until(async () => (await idle(builder.id)) && (await idle(reviewer.id)) && (await idle(other.id)), HUNG_MS)))

  // The reviewer waits for Builder's card to arrive in Review; the card is given to Other.
  const c1 = await newCard('First')
  // Wakes name a card by its key with the number the tools take (#1219): its own key, from the board.
  const named = async (n) => `${(await card(n)).key}`
  const n1 = await named(c1)
  check('the card has a key of its project', /^[A-Z]{2,4}-\d+$/.test(n1), n1)
  await say(reviewer.id, watch([c1], { column: 'review' }))
  check('the reviewer watches the card', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)))
  await inv('tasks:update', c1, { agent: other.id })
  check('given to another agent: the reviewer is woken', !!(await until(async () => wakes('Reviewer').length >= 1, 20000)))
  await lib.sleep(2000) // A fixed wait on purpose: this checks that a second line does NOT come.
  const w1 = wakes('Reviewer')
  check('…once, saying so, and to carry on', w1.length === 1 && w1[0] === `[CW] ${n1} was reassigned to Other (your watch on it ended). Your card watch has ended: drop it from your list and carry on with your next card.`, JSON.stringify(w1))
  check('…and it no longer waits', !!(await until(() => idle(reviewer.id), 15000)) && !(await live(reviewer.id))?.watch)
  check("the card's history says whose watch ended", !!(await until(async () => (await card(c1))?.history.some((h) => h.by === 'Combwork' && h.what === "Ended Reviewer (alpha)'s watch on it: reassigned to Other"), 10000)), JSON.stringify((await card(c1))?.history.map((h) => h.what)))

  // Its new agent watches it for a verdict; the reviewer starts reviewing it: the new agent keeps its watch.
  await say(other.id, watch([c1], { changes: ['verdict', 'column'], column: 'passed' }))
  await until(async () => (await live(other.id))?.status === 'watching', 15000)
  await inv('tasks:update', c1, { column: 'review', agent: other.id })
  await say(reviewer.id, `boardreview ${c1} start`)
  await until(async () => (await card(c1))?.review?.agent === reviewer.id, 15000)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that the new agent is NOT released.
  check("the card's new agent keeps its watch through a review", (await live(other.id))?.status === 'watching' && (await live(other.id))?.watch?.cards?.[0] === c1 && wakes('Other').length === 0, JSON.stringify({ status: (await live(other.id))?.status, wakes: wakes('Other') }))
  await until(() => idle(reviewer.id), 15000)

  // Two cards: one blocked stays in the watch, paused (#481), with no wake; unblocked and in Review, it wakes the reviewer.
  const c2 = await newCard('Second')
  const c3 = await newCard('Third')
  const [n2, n3] = [await named(c2), await named(c3)]
  await say(reviewer.id, watch([c2, c3], { column: 'review' }))
  await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)
  await inv('tasks:update', c2, { blocked: 'Waiting for the user to choose' })
  await lib.sleep(2000) // A fixed wait on purpose: this checks that the block neither wakes nor drops anything.
  check('a blocked card stays in a watch on two, with no wake', JSON.stringify((await live(reviewer.id))?.watch?.cards) === JSON.stringify([c2, c3]) && wakes('Reviewer').length === 1, JSON.stringify({ watch: (await live(reviewer.id))?.watch, wakes: wakes('Reviewer').slice(1) }))
  await inv('tasks:update', c2, { blocked: '' })
  await inv('tasks:update', c2, { column: 'review' })
  check('unblocked and back in Review, it wakes the reviewer', !!(await until(async () => wakes('Reviewer').length === 2, 20000)) && wakes('Reviewer')[1].startsWith(`[CW] ${n2} (Builder's card) is in Review`), JSON.stringify(wakes('Reviewer').slice(1)))
  check("…and its history ends nobody's watch", !(await card(c2)).history.some((h) => /^Ended .*'s watch on it/.test(h.what)), JSON.stringify((await card(c2)).history))

  // 10 Oct (#521): the wake told the reviewer the card was in Review; before it reviews, the builder takes it back and
  // blocks it to ask the user, the user answers and it is unblocked, and the reviewer watches again for it to be in Review
  // (column alone). Back in Review, it wakes the reviewer (it used to start from what the wake told: "in Review" already).
  await until(() => idle(reviewer.id), 15000)
  await inv('tasks:update', c2, { column: 'doing', blocked: 'Which icon?' })
  await inv('tasks:update', c2, { blocked: '' })
  await say(reviewer.id, watch([c2, c3], { column: 'review' }))
  check('the reviewer watches the card again, now in Doing', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)))
  await inv('tasks:update', c2, { column: 'review' })
  check('back in Review after a wake that told it there, it wakes the reviewer (#521)', !!(await until(async () => wakes('Reviewer').length === 3, 20000)) && wakes('Reviewer')[2].startsWith(`[CW] ${n2} (Builder's card) is in Review`), JSON.stringify(wakes('Reviewer').slice(2)))

  // A card in Review that its watching reviewer hasn't started on shows as stalled once it has waited 15 min (#521): in
  // its lane's row in the Progress panel. The window's clock is moved on 20 min (main's isn't: nothing else changes).
  await until(() => idle(reviewer.id), 15000)
  await say(builder.id, `cw cw_lane ${JSON.stringify({ action: 'start', cards: [c3], reviewer: 'Reviewer' })}`)
  await say(reviewer.id, watch([c3], { changes: ['verdict'] }))
  await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)
  await page.locator('.progress-rail').click()
  const lane = page.locator('.progress-lane').first()
  check('the lane shows in the Progress panel', !!(await until(async () => (await lane.count()) === 1, 15000)))
  await page.evaluate(() => {
    const real = Date.now
    Date.now = () => real() + 20 * 60_000
  })
  await inv('tasks:update', c3, { column: 'review' })
  const marker = lane.locator('.progress-lane-state.stalled')
  check("the lane says it is stalled: its card waits in Review on a reviewer that hasn't started", !!(await until(async () => (await marker.count()) === 1, 15000)))
  await marker.hover()
  // The window names the card by key (#1221).
  const C3 = await lib.cardLabel(inv, c3)
  const tip = page.locator('.tip', { hasText: `${C3}: Reviewer is watching ${C3} but hasn't started reviewing it: in Review for 20 min.` })
  check('…and its tooltip says why', !!(await until(async () => (await tip.count()) === 1, 5000)), (await page.locator('.tip').allInnerTexts()).join(' | '))
  await page.screenshot({ path: path.join(lib.WORK, 'watchrelease-stalled-lane.png') })
  // The lane's own wake (#405: the watch counts only a verdict) is typed into the reviewer meanwhile: taken first.
  await until(async () => wakes('Reviewer').some((t) => t.startsWith(`[CW] ${n3} (Builder's card) is in Review. You review this card`)) && (await idle(reviewer.id)), 20000)
  await say(reviewer.id, `boardreview ${c3} start`)
  check('…until its review starts', !!(await until(async () => (await marker.count()) === 0, 15000)))

  // #843: its review started, the reviewer goes back to watching it with no verdict and no block (a question left in a
  // comment): stalled again, for that, once it has only watched it for 15 min (the window's clock is still 20 min on).
  await until(() => idle(reviewer.id), 15000)
  await say(reviewer.id, watch([c3], { changes: ['verdict'] }))
  check('the reviewer watches the card it started reviewing', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)))
  check('…and the lane says it is stalled again', !!(await until(async () => (await marker.count()) === 1, 15000)))
  await page.mouse.move(0, 0)
  await marker.hover()
  const verdictTip = page.locator('.tip', { hasText: `${C3}: Reviewer started reviewing ${C3} but has given no verdict, and has only been watching it for 20 min.` })
  check('…its tooltip says the review has no verdict', !!(await until(async () => (await verdictTip.count()) === 1, 5000)), (await page.locator('.tip').allInnerTexts()).join(' | '))
  await page.screenshot({ path: path.join(lib.WORK, 'watchrelease-stalled-verdict.png') })
  await inv('tasks:update', c3, { blocked: 'Should the icon be a bee?' })
  check('…until its question blocks the card', !!(await until(async () => (await marker.count()) === 0, 15000)))

  // HI-2080: unblocked, it is stalled again; asking the user instead (For you, cw_ask_user) and watching again, the
  // reviewer waits on its own question, which isn't a stall.
  await inv('tasks:update', c3, { blocked: '' })
  check('unblocked, the lane says it is stalled again', !!(await until(async () => (await marker.count()) === 1, 15000)))
  await until(() => idle(reviewer.id), 15000)
  await say(reviewer.id, `cw cw_ask_user ${JSON.stringify({ card: `#${c3}`, kind: 'decide', text: 'Should the icon be a bee?' })}`)
  check('the reviewer asks the user (For you)', !!(await until(async () => (await inv('tasks:forYou', 'alpha')).items.some((i) => i.card === c3 && i.asker === reviewer.id), 15000)), JSON.stringify((await inv('tasks:forYou', 'alpha')).items))
  await until(() => idle(reviewer.id), 15000)
  await say(reviewer.id, watch([c3], { changes: ['verdict'] }))
  check('…and watching the card again while it waits for the answer, it isn\'t stalled (HI-2080)', !!(await until(async () => (await live(reviewer.id))?.status === 'watching' && (await marker.count()) === 0, 15000)), String(await marker.count()))

  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
