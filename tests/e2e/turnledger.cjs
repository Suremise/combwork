// The turn ledger (#648): an agent's status follows its CLI's turns by their ids, so it can't freeze on "working". Acted
// out with the fake Claude Code (prompt_id, 2.1.296's screen) and the fake Codex (turn_id, its rollout's task_complete):
// - a final turn with no tool call ends finished;
// - a tool's PostToolUse that reaches Combwork after its turn's Stop leaves it finished (one way #642's agent stayed working);
// - a turn another Stop hook carries on works again at its next tool, and ends at its next Stop;
// - a Stop that never comes: Codex's own record of the turn's end ends it; Claude Code idle at its prompt on screen
//   (after a silence, HIVE_TEST_SILENT_MS here) ends it;
// - with no sign of the end at all, the state is unknown (never idle): the pane says how long it has been silent, with
//   Mark idle, and it takes a task once marked;
// - Codex waiting to retry after a 429, recorded only in its log database (HI-1972): its pane says so and when it
//   retries, and its next hook clears it;
// - Codex running a turn under the id of a compaction it began itself (HI-1916) is heard, and ends at its Stop;
// - the hook journal (logs/hooks.log) has each hook with its launch, turn id, call id, order and statuses.
// Idle compactions and recaps (#612) are the idlestatus suite's. Dev build, throwaway profile, workspace and CLI homes.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000
// How long a running turn may be silent before Combwork looks for its end on screen or says its state is unknown.
const SILENT_MS = 2000

const userData = path.join(lib.WORK, 'turnledger-profile')
const ws = path.join(lib.WORK, 'turnledger-ws')
const claudeHome = path.join(lib.WORK, 'turnledger-claude-home')
const codexHome = path.join(lib.WORK, 'turnledger-codex-home')
const proj = path.join(ws, 'alpha')
const API_PORT = lib.port(47870)
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  // HI-1972: Codex's log is looked at for a retry wait after its shortest quiet while, not 20 s.
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'codex.retry.checkAfterSeconds': 5, 'claude-code.retry.checkAfterSeconds': 5 } }))
  lib.gitProject(proj)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([proj.toLowerCase()]))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: API_PORT, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HIVE_TEST_SILENT_MS: String(SILENT_MS) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const until = async (fn, ms) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(100)
    return v
  }
  await lib.waitForProvider(inv, 'codex')
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()

  const claude = await lib.addAgent(inv, proj, { name: 'Claude' })
  const codex = await lib.addAgent(inv, proj, { name: 'Codex', provider: 'codex', permissionMode: 'full-access' })
  const live = async (a) => (await inv('session:live')).find((s) => s.agentId === a.id)
  for (const a of [claude, codex]) await inv('session:start', proj, { agentId: a.id })
  check('the agents start', !!(await until(async () => (await live(claude))?.status === 'ready' && (await live(codex))?.status === 'ready', HUNG_MS)))

  // Every status an agent goes through, to tell a turn under way from the one before.
  const seen = new Map()
  const watch = setInterval(async () => {
    try {
      for (const s of await inv('session:live')) {
        const list = seen.get(s.agentId) ?? []
        const now = `${s.status}|${s.turn?.state ?? ''}`
        if (list[list.length - 1] !== now) list.push(now)
        seen.set(s.agentId, list)
      }
    } catch {
      // The window is closing.
    }
  }, 50)
  /** Types a prompt and waits until its turn is under way. */
  const turn = async (a, text) => {
    seen.set(a.id, [])
    const key = lib.ptyKey(proj, a.id)
    await inv('pty:write', key, text)
    await lib.sleep(150)
    await inv('pty:write', key, '\r')
    return until(async () => (seen.get(a.id) ?? []).some((s) => s.startsWith('working|running')), HUNG_MS)
  }
  const is = (a, status, state) => until(async () => {
    const s = await live(a)
    return s?.status === status && (!state || s.turn?.state === state) && s
  }, HUNG_MS)
  const hooksLog = () => fs.readFileSync(path.join(userData, 'logs', 'hooks.log'), 'utf8')
  const hiveLog = () => fs.readFileSync(path.join(userData, 'logs', 'combwork.log'), 'utf8')
  const journal = (a, re) => until(() => fs.existsSync(path.join(userData, 'logs', 'hooks.log')) && hooksLog().split('\n').some((l) => l.includes(`run=${a.runId} `) && re.test(l)), HUNG_MS)

  for (const [a, name] of [[claude, 'Claude Code'], [codex, 'Codex']]) {
    // A final turn with no tool call.
    check(`${name}: a turn is under way`, !!(await turn(a, 'work 1')))
    const done = await is(a, 'finished', 'over')
    check(`${name}: a final turn with no tool call ends finished, its turn over by its own id`, !!done?.turn?.id, JSON.stringify(done?.turn))

    // A tool's end after the Stop.
    await turn(a, 'latetool')
    const after = await is(a, 'finished', 'over')
    const st = await live(a)
    const stale = await journal(st, /PostToolUse .*\(stale: a tool end of a turn that is over\)/)
    const still = await live(a)
    // Its statuses from this turn's start, once they show its end: working, then finished for good (none working after).
    const since = await until(() => {
      const states = seen.get(a.id) ?? []
      const from = states.slice(Math.max(0, states.findIndex((s) => s.startsWith('working'))))
      return from[0]?.startsWith('working') && from.includes('finished|over') && from
    }, HUNG_MS)
    const ended = since ? since.indexOf('finished|over') : -1
    check(`${name}: a tool end that reaches Combwork after the turn's Stop is old news: it stays finished`, !!after && !!stale && still?.status === 'finished' && ended > 0 && !since.slice(ended).some((s) => s.startsWith('working')), JSON.stringify(seen.get(a.id)))
  }

  // Claude Code: another Stop hook carries the turn on: working at its next tool, finished at its next Stop.
  await turn(claude, 'stopcontinue')
  check('a turn ends at its Stop', !!(await is(claude, 'finished', 'over')))
  fs.writeFileSync(path.join(claudeHome, 'fake-continue-Claude'), '')
  check('a tool after its Stop (another Stop hook carried it on) works again', !!(await is(claude, 'working', 'running')))
  fs.writeFileSync(path.join(claudeHome, 'fake-continue-done-Claude'), '')
  check('and its next Stop ends it', !!(await is(claude, 'finished', 'over')))

  // Codex: its Stop never reaches Combwork; its rollout records the turn's end (task_complete).
  await turn(codex, 'loststop')
  check("Codex: a turn whose Stop is lost ends from Codex's own record of it", !!(await is(codex, 'finished', 'over')))
  check('the log says so', !!(await until(() => /Codex recorded the end of turn [\w-]+ at .*, and Combwork saw no Stop: its turn is over/.test(hiveLog()), HUNG_MS)))

  // Claude Code: its Stop is lost and nothing records it; after a silence, its screen shows it idle at its prompt.
  await turn(claude, 'loststop')
  check('Claude Code: a turn whose Stop is lost ends once its screen shows it idle at its prompt', !!(await is(claude, 'finished', 'over')))
  check('the log says so', !!(await until(() => /Claude Code is idle at its prompt on screen after \d+ (s|min) of silence, and Combwork saw no Stop/.test(hiveLog()), HUNG_MS)))

  // Codex 0.160.0 (no screen check for it): no Stop, nothing recorded. Unknown, never idle; Mark idle.
  await turn(codex, 'silent')
  const unknown = await is(codex, 'working', 'unknown')
  check('Codex: a turn with no sign of its end is unknown after a silence, still working', !!unknown?.turn?.silentSince, JSON.stringify(unknown?.turn))
  const header = page.locator('.pane-header-bar', { hasText: 'Codex' })
  const label = await until(async () => /^Silent \d+ min · state unknown$/.test((await header.locator('.unknown-state .pane-status').innerText().catch(() => '')).trim()) && header, HUNG_MS)
  check('its pane says how long it has been silent, with Mark idle', !!label && (await header.getByRole('button', { name: 'Mark idle' }).isVisible()))
  await page.screenshot({ path: path.join(lib.WORK, 'turnledger-unknown.png') })
  check('the log says the state is unknown', !!(await until(() => /silent for \d+ (s|min) with no sign of its turn's end: state unknown \(turn [\w-]+ running/.test(hiveLog()), HUNG_MS)))
  await header.getByRole('button', { name: 'Mark idle' }).click()
  check('Mark idle makes it idle', !!(await is(codex, 'ready', 'over')))
  check('and it takes a task', !!(await turn(codex, 'work 1')) && !!(await is(codex, 'finished', 'over')))

  // HI-1972: its model request refused with a 429, recorded only in Codex's log database, no hook while it waits to
  // retry. Silent past SILENT_MS it goes unknown first; its log's wait, read after the quiet while, says what it waits on.
  await turn(codex, 'ratelimited')
  const waiting = await until(async () => {
    const s = await live(codex)
    return s?.retryWait?.status === 429 && s
  }, HUNG_MS)
  check("Codex: a 429 in its log is read as its wait to retry (try 1 of 5), its turn running again", waiting?.retryWait?.attempt === 1 && waiting.retryWait.max === 5 && waiting.status === 'working' && waiting.turn?.state === 'running', JSON.stringify(waiting && { retryWait: waiting.retryWait, turn: waiting.turn }))
  const retryText = () => header.locator('.pane-status.retrying').innerText().catch(() => '')
  const shown = await until(async () => /^Rate-limited \(429\) · retrying at .+ \(1 of 5\)$/.test((await retryText()).trim()), HUNG_MS)
  check('its pane says it was rate-limited and when it retries, not Working…', !!shown, await retryText())
  await page.screenshot({ path: path.join(lib.WORK, 'turnledger-retrying.png') })
  check('the log says it waits to retry', !!(await until(() => /Codex is waiting to retry its model request \(429, try 1\/5\) until \d{4}-/.test(hiveLog()), HUNG_MS)))
  // Its retry goes through: it carries on, and its next hook clears the wait.
  fs.writeFileSync(path.join(codexHome, 'fake-retried-Codex'), '')
  const over = await is(codex, 'finished', 'over')
  check('its retry going through clears it: the turn ends as usual', !!over && !over.retryWait, JSON.stringify(over?.retryWait))
  // HI-1996: afterwards, the wait is in the launch's tally: cw_agent_activity says how long it waited, with the model and
  // effort it runs with, and the footer model's hover says it too.
  const activityOf = async (name) => {
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const res = await fetch(`http://127.0.0.1:${API_PORT}/v1/projects/alpha/agents/${name}/activity`, { headers: { Authorization: `Bearer ${token}` } })
    return res.json()
  }
  const act = await activityOf('Codex')
  check('cw_agent_activity: the wait it had, its model and effort', act.retryWaits?.waits === 1 && act.retryWaits.latest?.status === 429 && act.retryWaits.latest.tries === 1 && !act.retryWaits.latest.ongoing && act.retryWaits.latest.since === waiting.retryWait.since && typeof act.retryWaits.seconds === 'number' && typeof act.model === 'string' && act.model.length > 0 && typeof act.effort === 'string', JSON.stringify({ retryWaits: act.retryWaits, model: act.model, effort: act.effort }))
  const footTip = await lib.hoverTip(page, page.locator('.agent-pane').filter({ has: header }).locator('.pane-footer-bar .foot-model'), (t) => /This session has waited/.test(t))
  check("the footer model's hover says how long this session waited for retries", /This session has waited (under a minute|\d+ minutes?) in all for Codex to retry rate-limited or failed requests \(1 wait, the latest from .+\): time not spent on its work\./.test(footTip), footTip)
  await page.screenshot({ path: path.join(lib.WORK, 'turnledger-retry-hover.png') })
  await page.mouse.move(5, 5)

  // HI-1973: Claude Code's 429 tries, recorded only in its transcript, no hook while it waits: read after its quiet while
  // (5 s here), its pane says it is rate-limited, which try of how many and when it retries; its next hook clears it.
  await turn(claude, 'ratelimited')
  const cWaiting = await until(async () => {
    const s = await live(claude)
    return s?.retryWait?.status === 429 && s
  }, HUNG_MS)
  const cw = cWaiting?.retryWait
  check("Claude Code: its transcript's 429 tries are read as its wait to retry (try 2 of 10), its first try the wait's start", cw?.attempt === 2 && cw.max === 10 && Date.parse(cw.since) < Date.parse(cw.at) && cWaiting.status === 'working', JSON.stringify(cw))
  const cHeader = page.locator('.pane-header-bar', { hasText: 'Claude' })
  const cText = () => cHeader.locator('.pane-status.retrying').innerText().catch(() => '')
  check("its pane says it was rate-limited, when it retries and which try of 10, not Working…", !!(await until(async () => /^Rate-limited \(429\) · retrying at .+ \(2 of 10\)$/.test((await cText()).trim()), HUNG_MS)), await cText())
  await page.screenshot({ path: path.join(lib.WORK, 'turnledger-retrying-claude.png') })
  fs.writeFileSync(path.join(claudeHome, 'fake-retried-Claude'), '')
  const cOver = await is(claude, 'finished', 'over')
  check("Claude Code: its retry going through clears it: the turn ends as usual", !!cOver && !cOver.retryWait, JSON.stringify(cOver?.retryWait))

  // HI-1996 (HR1's round 1): a running session's footer shows its own launch's model and effort, not the settings changed
  // since (the fake reports neither). A stopped agent changed the same way shows the change: that is when the window has it.
  const idle = await lib.addAgent(inv, proj, { name: 'Idle' })
  await page.locator('.layout-switch button[aria-label="Three columns"]').click()
  const footModel = (name) => page.locator('.agent-pane', { has: page.locator('.pane-header-bar .agent-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.foot-model')
  const footText = async (name) => (await footModel(name).innerText().catch(() => '')).trim()
  const launched = await until(async () => (await footText('Claude')) || null, HUNG_MS)
  const claudeLaunch = (await live(claude))?.launchedWith
  check('the launch kept the model and effort it gave its CLI', !!claudeLaunch && claudeLaunch.model === null && claudeLaunch.effort === null, JSON.stringify(claudeLaunch))
  // Sonnet at Low (Haiku takes no effort: decision E refuses the pair).
  await lib.setLaunch(inv, proj, claude.id, { model: 'sonnet', effort: 'low' })
  await lib.setLaunch(inv, proj, idle.id, { model: 'sonnet', effort: 'low' })
  const idleChanged = await until(async () => /Sonnet/.test(await footText('Idle')) && /Low/.test(await footText('Idle')), HUNG_MS)
  check("a stopped agent's footer shows its new settings (for new sessions)", !!idleChanged, await footText('Idle'))
  check("the running agent's footer still shows what it launched with, not Sonnet at Low", (await footText('Claude')) === launched && !/Sonnet|Low/.test(launched ?? ''), JSON.stringify({ launched, now: await footText('Claude') }))
  await page.screenshot({ path: path.join(lib.WORK, 'turnledger-footer-launch.png') })
  await lib.setLaunch(inv, proj, claude.id, { model: '', effort: '' })

  // Codex 0.164 compacting by itself, then running its turn under that compaction's id (HI-1916: HR5's "no hooks" on 27
  // Oct): heard as a turn, and finished at its Stop, with nothing of it stale.
  check("Codex: a turn under the id of a compaction it began itself is heard working", !!(await turn(codex, 'selfcompact then work 1')))
  check('…and finished at its Stop', !!(await is(codex, 'finished', 'over')))
  const sc = await live(codex)
  check("…the journal has its prompt beginning that turn, and nothing stale under the compaction's id", !!(await journal(sc, /UserPromptSubmit .*a turn under the id of a compaction the CLI began itself/)) && !hooksLog().split('\n').some((l) => l.includes(`run=${sc.runId} `) && l.includes("under a compaction's id")), hooksLog().split('\n').filter((l) => l.includes(`run=${sc.runId} `)).slice(-12).join(' | '))

  // The journal: launch, receive order, turn and call ids, and the statuses before and after.
  const st = await live(codex)
  check('the hook journal has each hook with its ids and statuses', !!(await journal(st, /seq=\d+ PreToolUse turn=[\w-]+ call=exec-[\w-]+ working→working/)) && !!(await journal(st, /seq=\d+ Stop turn=[\w-]+ call=- working→finished/)))

  clearInterval(watch)
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
