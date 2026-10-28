// The turn ledger (#648): an agent's status follows its CLI's turns by their ids, so it can't freeze on "working". Acted
// out with the fake Claude Code (prompt_id, 2.1.296's screen) and the fake Codex (turn_id, its rollout's task_complete):
// - a final turn with no tool call ends finished;
// - a tool's PostToolUse that reaches Hive after its turn's Stop leaves it finished (one way #642's agent stayed working);
// - a turn another Stop hook carries on works again at its next tool, and ends at its next Stop;
// - a Stop that never comes: Codex's own record of the turn's end ends it; Claude Code idle at its prompt on screen
//   (after a silence, HIVE_TEST_SILENT_MS here) ends it;
// - with no sign of the end at all, the state is unknown (never idle): the pane says how long it has been silent, with
//   Mark idle, and it takes a task once marked;
// - Codex running a turn under the id of a compaction it began itself (HI-1916) is heard, and ends at its Stop;
// - the hook journal (logs/hooks.log) has each hook with its launch, turn id, call id, order and statuses.
// Idle compactions and recaps (#612) are the idlestatus suite's. Dev build, throwaway profile, workspace and CLI homes.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000
// How long a running turn may be silent before Hive looks for its end on screen or says its state is unknown.
const SILENT_MS = 2000

const userData = path.join(lib.WORK, 'turnledger-profile')
const ws = path.join(lib.WORK, 'turnledger-ws')
const claudeHome = path.join(lib.WORK, 'turnledger-claude-home')
const codexHome = path.join(lib.WORK, 'turnledger-codex-home')
const proj = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(proj)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([proj.toLowerCase()]))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47870), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HIVE_TEST_SILENT_MS: String(SILENT_MS) })
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
  const hiveLog = () => fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')
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
    check(`${name}: a tool end that reaches Hive after the turn's Stop is old news: it stays finished`, !!after && !!stale && still?.status === 'finished' && ended > 0 && !since.slice(ended).some((s) => s.startsWith('working')), JSON.stringify(seen.get(a.id)))
  }

  // Claude Code: another Stop hook carries the turn on: working at its next tool, finished at its next Stop.
  await turn(claude, 'stopcontinue')
  check('a turn ends at its Stop', !!(await is(claude, 'finished', 'over')))
  fs.writeFileSync(path.join(claudeHome, 'fake-continue-Claude'), '')
  check('a tool after its Stop (another Stop hook carried it on) works again', !!(await is(claude, 'working', 'running')))
  fs.writeFileSync(path.join(claudeHome, 'fake-continue-done-Claude'), '')
  check('and its next Stop ends it', !!(await is(claude, 'finished', 'over')))

  // Codex: its Stop never reaches Hive; its rollout records the turn's end (task_complete).
  await turn(codex, 'loststop')
  check("Codex: a turn whose Stop is lost ends from Codex's own record of it", !!(await is(codex, 'finished', 'over')))
  check('the log says so', !!(await until(() => /Codex recorded the end of turn [\w-]+ at .*, and Hive saw no Stop: its turn is over/.test(hiveLog()), HUNG_MS)))

  // Claude Code: its Stop is lost and nothing records it; after a silence, its screen shows it idle at its prompt.
  await turn(claude, 'loststop')
  check('Claude Code: a turn whose Stop is lost ends once its screen shows it idle at its prompt', !!(await is(claude, 'finished', 'over')))
  check('the log says so', !!(await until(() => /Claude Code is idle at its prompt on screen after \d+ (s|min) of silence, and Hive saw no Stop/.test(hiveLog()), HUNG_MS)))

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
