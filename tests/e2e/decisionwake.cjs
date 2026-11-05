// Decisions reach an agent waiting for the user (#401), on a fake Claude Code agent (fake-claude/): it works on a card,
// asks the user and its turn ends; two decisions recorded on the card within the settle give exactly one line ("#n has 2
// new decisions from the user…"), which it takes and acts on (it reads the card); the card's history says whom Combwork told.
// A decision recorded while it works isn't typed over its work: it hears of it once its turn ends. Nor while the user
// types in its terminal: once the typing pause has passed. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
// Under load a doorbell Combwork re-offered was read 24 s after the decisions (#729).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'decisionwake-profile')
const ws = path.join(lib.WORK, 'decisionwake-ws')
const claudeHome = path.join(lib.WORK, 'decisionwake-claude-home')
const mcpLog = path.join(lib.WORK, 'decisionwake-mcp.jsonl')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47858))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(mcpLog, { force: true })
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
  // A short typing pause, so "not while the user types" doesn't take long.
  cfg.settings.assistant = { ...cfg.settings.assistant, typingPause: 4, enterEndsPause: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // A short settle (15 s in Combwork), so the decisions recorded together are still told together, quickly.
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off', HIVE_TEST_DECISION_SETTLE_MS: '2500', HIVE_TEST_MCP_LOG: mcpLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
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
  const wakes = () => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).map((w) => w.text)
  }
  const reads = (n) => (fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((c) => c.tool === 'cw_read_task' && c.ok && JSON.parse(c.args).number === n)
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Asker' })
  const n = (await inv('tasks:create', { title: 'Pick the shots', project: 'alpha', agent: agent.id })).number
  // Wakes name the card by its key with the number the tools take (#1219): its own key, from the board.
  const named = `${(await card(n)).key}`
  check('the card has a key of its project', /^[A-Z]{2,4}-\d+$/.test(named), named)
  await inv('tasks:update', n, { column: 'doing', agent: agent.id })
  // What it does when Combwork's line comes: reads the card's decisions, as work-on-card says.
  fs.writeFileSync(path.join(claudeHome, 'fake-wakes-Asker.txt'), `cw cw_read_task {"number":${n}}\nhive cw_read_task {"number":${n}}\nhive cw_read_task {"number":${n}}\n`)
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(() => idle(agent.id), HUNG_MS)))
  // Its own turns, typed once it takes prompts and waited for to their end (#729: an idle wait returned before the fake,
  // starved under load, had taken the prompt, so the decisions came while it was about to work).
  const prompts = lib.fakePrompts(inv, lib.ptyKey(alpha, agent.id), () => live(agent.id), { home: claudeHome })
  const takesPrompts = async (what) => check(`${what}: it takes prompts again`, !!(await lib.until(prompts.takesPrompts, HUNG_MS)))
  // It asks the user and its turn ends (waiting for the user: finished, no question menu).
  check('it asks the user, and its turn ends', !!(await prompts.say('Here is the shot list: approve it? work 1')))

  // Two decisions within the settle: one line.
  await inv('tasks:update', n, { decision: 'Shot 1: wide, from the door.' })
  await lib.sleep(800)
  await inv('tasks:update', n, { decision: 'Shot 2: close on the counter.' })
  check('one line for the two decisions', !!(await until(async () => wakes().length >= 1, HUNG_MS)), JSON.stringify(wakes()))
  await lib.sleep(4000) // A fixed wait on purpose: this checks that a second line does NOT come.
  check('…exactly one, naming the card and both', wakes().length === 1 && wakes()[0] === `[CW] ${named} has 2 new decisions from the user: read them (cw_read_task) and carry on from where you asked.`, JSON.stringify(wakes()))
  check('it reads them', !!(await until(async () => reads(n).length >= 1, HUNG_MS)))
  check("the card's history says whom Combwork told", !!(await until(async () => (await card(n))?.history.some((h) => h.by === 'Combwork' && h.what === 'Told Asker (alpha) of 2 new decisions'), HUNG_MS)), JSON.stringify((await card(n))?.history.map((h) => h.what)))
  await takesPrompts('after the decisions')

  // A decision while it works: nothing typed into its work; one line once its turn ends. Its turn is held until the
  // check is done (#729: an 8 s turn could end first under load).
  await prompts.type('holduntil decisionwake-busy')
  check('it works', !!(await until(async () => (await live(agent.id))?.status === 'working', HUNG_MS)))
  await inv('tasks:update', n, { decision: 'Shot 3: the van outside.' })
  await lib.sleep(4500) // A fixed wait on purpose: this checks that nothing is typed while it works.
  check('nothing typed while it works', wakes().length === 1 && (await live(agent.id))?.status === 'working', JSON.stringify({ wakes: wakes().length, status: (await live(agent.id))?.status }))
  fs.writeFileSync(path.join(claudeHome, 'decisionwake-busy'), '')
  check('…then one line once its turn ends', !!(await until(async () => wakes().length === 2, HUNG_MS)) && wakes()[1].startsWith(`[CW] ${named} has 1 new decision from the user: read it`), JSON.stringify(wakes().slice(1)))
  await takesPrompts('after the decision')

  // While the user types in its terminal (no Enter): not until the typing pause has passed. The user keeps typing for
  // as long as the check runs (#729: a slow step under load could outlast the 4 s pause).
  const key = lib.ptyKey(alpha, agent.id)
  await inv('pty:write', key, 'half a thought')
  const typing = { on: true }
  const keepTyping = (async () => {
    // A key every half second, well inside the 4 s pause: typing, not a wait for a check.
    while (typing.on) {
      await lib.sleep(500)
      if (typing.on) await inv('pty:write', key, '.')
    }
  })()
  await inv('tasks:update', n, { decision: 'Shot 4: the sign.' })
  await lib.sleep(3500) // A fixed wait on purpose: this checks that nothing is typed over the user's typing.
  check('nothing typed while the user types there', wakes().length === 2, JSON.stringify(wakes().slice(2)))
  typing.on = false
  await keepTyping
  check('…then one line once the pause has passed', !!(await until(async () => wakes().length === 3, HUNG_MS)) && (wakes()[2] ?? '').startsWith(`[CW] ${named} has 1 new decision from the user: read it`), JSON.stringify(wakes().slice(2)))

  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
