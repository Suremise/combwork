// A wake its CLI doesn't take (#430), on a fake Claude Code agent (fake-claude/): a normal wake is taken and the log says
// how soon; then the CLI drops the Enter of the wake and of Combwork's Enter again (fake-drop-enters, as a CLI not reading
// its input): Combwork presses Enter at most twice, then marks the agent ("A line Combwork typed wasn't taken" in its pane, its
// live state) and tells the user once; the user pressing Enter there submits the line and clears the mark. Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'wakeuntaken-profile')
const ws = path.join(lib.WORK, 'wakeuntaken-ws')
const claudeHome = path.join(lib.WORK, 'wakeuntaken-claude-home')
const notifyLog = path.join(lib.WORK, 'wakeuntaken-notify.jsonl')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47859))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(notifyLog, { force: true })
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

  // How long a wake has to be taken (10 s in Combwork): set in Combwork's main process for each part (takeWindow, below).
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off', HIVE_TEST_NOTIFY_LOG: notifyLog })
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
  const wakeRecords = () => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  const wakes = () => wakeRecords().map((w) => w.text)
  const hiveLog = () => {
    const f = path.join(userData, 'logs', 'combwork.log')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  }
  // The Windows notifications the user got: each tell() also logs an `entry` line (HI-2320), not a second notice (HI-2369).
  const notices = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'notification')
  const say = async (id, text) => {
    // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
  }
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
  /** Combwork's window for a typed wake to be taken, from now on (HIVE_TEST_WAKE_TAKE_MS, read at each wake). */
  const takeWindow = (ms) => app.evaluate((_, v) => void (process.env.HIVE_TEST_WAKE_TAKE_MS = v), String(ms))

  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Watcher' })
  const card = (await inv('tasks:create', { title: 'Watched', project: 'alpha' })).number
  // Wakes name a card by its key with the number the tools take (#1219): its own key, from the board.
  const named = `${(await inv('tasks:list')).find((c) => c.number === card).key}`
  check('the card has a key of its project', /^[A-Z]{2,4}-\d+$/.test(named), named)
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(() => idle(agent.id), HUNG_MS)))
  const watch = async () => {
    await say(agent.id, `hive cw_wait_for_tasks {"cards":[${card}],"changes":["comment"],"wake":true}`)
    return until(async () => (await live(agent.id))?.status === 'watching', HUNG_MS)
  }

  // A wake its CLI takes: the log says it was taken, and how soon. The window is a hung run's bound here (#664): a CLI
  // starved under load reads its input seconds late, and a short window would mark a wake it does take.
  await takeWindow(HUNG_MS)
  check('it watches the card', !!(await watch()))
  await inv('tasks:comment', card, 'First change')
  check('the wake is taken', !!(await until(async () => wakes().length === 1, HUNG_MS)))
  check('…and the log says so, with how soon', !!(await until(async () => /The wake typed into ⁨?[\w-]+⁩? was taken after \d+ ms/.test(hiveLog()), HUNG_MS)), hiveLog().split('\n').filter((l) => /wake typed/.test(l)).join(' | '))
  await until(() => idle(agent.id), HUNG_MS)

  // Its CLI drops the wake's Enter and Combwork's Enter again (not reading its input). A short window, so the two Enters
  // don't take long: the CLI drops them however late it reads them.
  await takeWindow(1500)
  fs.writeFileSync(path.join(claudeHome, 'fake-drop-enters-Watcher.txt'), '2')
  check('it watches again', !!(await watch()))
  await inv('tasks:comment', card, 'Second change')
  const marked = await until(async () => (await live(agent.id))?.untakenLine, HUNG_MS)
  check('not taken after Enter again: the agent is marked', !!marked && marked.text.startsWith(`[CW] New in your inbox: 1 card event (${named}) (m`) && /^\[CW\] New in your inbox: 1 card event \(.+\) \(m\d+\)\./.test(marked.text), JSON.stringify(marked))
  // Combwork's two Enters were pressed before it marked the agent, but the CLI may not have read them yet (#664, under load).
  const drops = () => fs.readFileSync(path.join(claudeHome, 'fake-drop-enters-Watcher.txt'), 'utf8').trim()
  check('Combwork pressed Enter twice, never a third time (the CLI dropped both)', !!(await until(async () => drops() === '0', HUNG_MS)) && wakes().length === 1, JSON.stringify({ left: drops(), wakes: wakes().length }))
  check('the log says: Enter again, still not taken', /wasn't taken: pressed Enter again/.test(hiveLog()) && /still wasn't taken/.test(hiveLog()))
  check('its pane says so', !!(await until(async () => (await page.locator('.pane-status', { hasText: "A line Combwork typed wasn't taken" }).count()) >= 1, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'wakeuntaken-marked.png') })
  const toldOf = () => notices().filter((n) => /hasn't taken a line Combwork typed/.test(JSON.stringify(n)))
  const told = (await until(async () => toldOf().length > 0 && toldOf(), HUNG_MS)) || []
  check('the user is told once', told.length === 1, JSON.stringify(notices()))

  // The user presses Enter in its terminal: the line goes in, and the mark goes.
  await inv('pty:write', lib.ptyKey(alpha, agent.id), '\r')
  check("the user's Enter submits the line Combwork typed", !!(await until(async () => wakes().length === 2 && /Second change/.test(wakes()[1]), HUNG_MS)), JSON.stringify(wakes()))
  check('…sent by the third Enter it got (two dropped)', !!(await until(async () => wakeRecords()[1]?.enter === 3, HUNG_MS)), JSON.stringify(wakeRecords()))
  check('…and the mark is gone', !!(await until(async () => !(await live(agent.id))?.untakenLine, HUNG_MS)))
  check('still told only once', notices().filter((n) => /hasn't taken a line Combwork typed/.test(JSON.stringify(n))).length === 1)

  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
