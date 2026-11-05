// The user's replies to agents told to the Assistant (#418), on fake Claude Code sessions (fake-claude/): the Assistant
// watches a card (cw_wait_for_tasks with wake); the user answers the card's agent by typing in its pane, and the
// Assistant is woken once with the reply's first line. Not for keystrokes without Enter, nor for a line Combwork types into
// the agent, nor for a turn its CLI starts by itself after the user's Enter (HI-2410: a background task's end), nor with Settings → Assistant → Tell the Assistant when I reply to an agent off. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'replytell-profile')
const ws = path.join(lib.WORK, 'replytell-ws')
const claudeHome = path.join(lib.WORK, 'replytell-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47862))
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
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
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
  const home = (await inv('workspace:refresh')).assistant.path
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  /** What Combwork typed into the Assistant to wake it (the fake logs each line from Combwork). */
  const wakes = () => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === 'Assistant').map((w) => w.text)
  }
  /**
   * Types into a terminal as the user does; Enter separately when asked. Into the Assistant (its watches), typed again if
   * a wake of Combwork's disturbed it (lib.typeLine, #1560). Into the builder not (#1560's exemption): its typing is the
   * user's reply under test, which a second try would send twice; a pause before its Enter, on purpose: the fake reads
   * a typed line before its Enter, as a CLI does.
   */
  const type = async (p, id, text, enter = true) => {
    if (p === home && enter) return lib.typeLine(inv, lib.ptyKey(p, id), claudeHome, null, text, { live: () => live(p, id) })
    await inv('pty:write', lib.ptyKey(p, id), text)
    if (!enter) return
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(p, id), '\r')
  }
  const idle = async (p, id) => ['ready', 'finished'].includes((await live(p, id))?.status)

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const card = (await inv('tasks:create', { title: 'Pick the icon', project: 'alpha', agent: builder.id })).number
  // Wakes name a card by its key with the number the tools take (#1219): its own key, from the board.
  const named = `${(await inv('tasks:list')).find((c) => c.number === card).key}`
  check('the card has a key of its project', /^[A-Z]{2,4}-\d+$/.test(named), named)
  await inv('tasks:update', card, { column: 'doing', agent: builder.id })
  await inv('session:start', alpha, { agentId: builder.id })
  await inv('session:start', home, { agentId: 'assistant' })
  check('both start', !!(await until(async () => (await idle(alpha, builder.id)) && (await idle(home, 'assistant')), HUNG_MS)))
  const watchCard = async () => {
    await type(home, 'assistant', `cw cw_wait_for_tasks {"cards":[${card}],"column":"review","wake":true}`)
    return until(async () => (await live(home, 'assistant'))?.status === 'watching', 15000)
  }

  // The Assistant watches the card; the user types in Builder's pane without sending: nothing.
  check("the Assistant watches the Builder's card", !!(await watchCard()))
  await type(alpha, builder.id, 'C, the hive', false)
  await lib.sleep(2500) // A fixed wait on purpose: this checks that keystrokes without Enter tell nothing.
  check('keystrokes without Enter: no wake', wakes().length === 0, JSON.stringify(wakes()))
  // The user sends the answer: one wake, with its first line, naming the agent and the card.
  await type(alpha, builder.id, ' cell')
  check('the reply wakes the Assistant', !!(await until(async () => wakes().length >= 1, 20000)))
  await lib.sleep(2000) // A fixed wait on purpose: this checks that a second line does NOT come.
  const w1 = wakes()
  check('…once, with the reply, the agent and the card', w1.length === 1 && w1[0].startsWith(`[CW] User replied to Builder on ${named}: "C, the hive cell"`), JSON.stringify(w1))
  await until(async () => (await idle(home, 'assistant')) && (await idle(alpha, builder.id)), 20000)

  // A line Combwork types into Builder (a task the Assistant gives it, then watches its card) isn't the user's.
  await type(home, 'assistant', `cw cw_prompt_agent {"project":"alpha","agent":"Builder","text":"work 2"} then cw cw_wait_for_tasks {"cards":[${card}],"column":"review","wake":true}`)
  check('the Assistant gives Builder a task, then watches its card', !!(await until(async () => (await live(alpha, builder.id))?.status === 'working', 15000)) && !!(await until(async () => (await live(home, 'assistant'))?.status === 'watching', 15000)))
  await until(() => idle(alpha, builder.id), 20000)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that Combwork's own line tells nothing.
  check("Combwork's own typed line: no wake", wakes().length === 1, JSON.stringify(wakes().slice(1)))

  // Settings → Assistant → Tell the Assistant when I reply to an agent, off: the user's reply tells nothing.
  await inv('settings:update', { assistant: { tellReplies: false } })
  await type(alpha, builder.id, 'Use the second one')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  await until(() => idle(alpha, builder.id), 20000)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that nothing is told with the setting off.
  check('with the setting off: no wake', wakes().length === 1, JSON.stringify(wakes().slice(1)))
  check('…and the Assistant still watches', (await live(home, 'assistant'))?.status === 'watching')
  // On again: told, naming the user as Settings → General → Your name says (#426).
  await inv('settings:update', { assistant: { tellReplies: true }, general: { userName: 'Darren' } })
  await type(alpha, builder.id, 'Ship it')
  check('on again: the next reply is told, by the name in Settings', !!(await until(async () => wakes().length === 2 && wakes()[1].startsWith(`[CW] Darren replied to Builder on ${named}: "Ship it"`), 20000)), JSON.stringify(wakes().slice(1)))

  // #1099: the Assistant watches Builder while Builder is idle (answered at once: no watch starts) and ends its turn.
  // The user's reply to Builder still reaches it within seconds, as a wake of its own.
  await until(async () => (await idle(home, 'assistant')) && (await idle(alpha, builder.id)), HUNG_MS)
  await type(home, 'assistant', `cw cw_wait_for_agents ${JSON.stringify({ agents: [{ project: 'alpha', agent: 'Builder' }], wake: true })}`)
  check('an agent watch on idle Builder is answered at once', !!(await until(async () => (await idle(home, 'assistant')) && (await live(home, 'assistant'))?.status !== 'watching', HUNG_MS)))
  const before = wakes().length
  const t0 = Date.now()
  await type(alpha, builder.id, 'Go ahead and push')
  const told = await until(() => wakes().slice(before).find((x) => x.startsWith('[CW] Darren replied to Builder (alpha): "Go ahead and push"')), HUNG_MS)
  check('the reply reaches the Assistant within seconds with no watch of its own (#1099)', !!told && Date.now() - t0 < 15000, JSON.stringify({ wakes: wakes().slice(before), ms: Date.now() - t0 }))

  // HI-2410: a turn Claude Code starts by itself (a background task's end, its prompt hook a <task-notification>) soon
  // after the user pressed Enter in the pane (answering a dialog, say: no prompt of theirs) isn't the user's reply.
  await until(() => idle(alpha, builder.id), HUNG_MS)
  const b0 = wakes().length
  await type(alpha, builder.id, 'background 8')
  check("the user's prompt that starts a background task is told", !!(await until(() => wakes().slice(b0).find((x) => x.startsWith('[CW] Darren replied to Builder (alpha): "background 8"')), HUNG_MS)), JSON.stringify(wakes().slice(b0)))
  // Its turn is over, the task runs on: the user's Enter, with nothing typed, before the task ends.
  check('Builder waits on its background task', !!(await until(async () => (await live(alpha, builder.id))?.status === 'background', HUNG_MS)), (await live(alpha, builder.id))?.status)
  await inv('pty:write', lib.ptyKey(alpha, builder.id), '\r')
  // The task ends: its own turn starts and ends.
  check("the task's end starts a turn by itself", !!(await until(async () => (await live(alpha, builder.id))?.status === 'working', HUNG_MS)), (await live(alpha, builder.id))?.status)
  await until(() => idle(alpha, builder.id), HUNG_MS)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that the task's turn tells nothing.
  check("the task's own turn isn't told as the user's reply", wakes().length === b0 + 1 && !wakes().some((x) => x.includes('task-notification')), JSON.stringify(wakes().slice(b0)))

  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
