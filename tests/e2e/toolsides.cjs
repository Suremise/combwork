// Tools by side (HI-2664, Darren's decision): a project agent's Combwork tools follow its side of the workflow, set on
// its launch (CW_SIDE in the combwork server's env); a role change restarts it to load the new list, in the same
// conversation: an idle agent at once, a busy one only once asked (restartForSide: busy, then atSafePoint, which waits
// for its turn's end). The agent is the fake Claude Code; the launch's --mcp-config is read for its combwork env.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'toolsides-profile')
const ws = path.join(lib.WORK, 'toolsides-ws')
const claudeHome = path.join(lib.WORK, 'toolsides-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** The fake's launches, newest last; each launch's combwork server env read from its --mcp-config. */
const launches = () => (fs.existsSync(path.join(claudeHome, 'fake-launches.jsonl')) ? fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const sideOf = (launch) => {
  try {
    return JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env.CW_SIDE ?? null
  } catch {
    return null
  }
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.logFakeInput(claudeHome)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47931), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const agent = await lib.addAgent(inv, alpha, { name: 'Worker', workflowRole: 'builder' })
    const key = lib.ptyKey(alpha, agent.id)
    const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
    await inv('session:start', alpha, { agentId: agent.id })
    check('the builder starts', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)))
    const first = launches().at(-1)
    check("its combwork server is a builder's (CW_SIDE builder)", sideOf(first) === 'builder', String(sideOf(first)))

    // --- Idle: made a reviewer, it restarts at once with a reviewer's tools, in the same conversation.
    await inv('agents:update', alpha, agent.id, { workflowRole: 'reviewer' })
    check('an idle agent made a reviewer is restarted at once', (await inv('session:restartForSide', alpha, agent.id, 'ifIdle')) === 'restarting')
    check("…relaunched with a reviewer's tools", !!(await lib.until(async () => launches().length === 2 && sideOf(launches()[1]) === 'reviewer', HUNG_MS)), JSON.stringify(launches().map(sideOf)))
    check('…resuming its conversation', launches()[1].opts['--resume'] === first.sessionId, JSON.stringify(launches()[1].opts['--resume']))
    check('…and running again', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)))
    check('the same side again changes nothing', (await inv('session:restartForSide', alpha, agent.id, 'ifIdle')) === 'same')

    // --- Busy: made a builder again while it works, it is not restarted unasked; asked, it restarts at its turn's end.
    const typed = await lib.typeLine(inv, key, claudeHome, null, 'work 4', { live })
    check('it starts a turn that takes a while', typed.attempt > 0, JSON.stringify(typed.lost))
    await lib.until(async () => (await live())?.status === 'working', HUNG_MS)
    await inv('agents:update', alpha, agent.id, { workflowRole: 'builder' })
    check('a busy agent made a builder is not restarted unasked: busy', (await inv('session:restartForSide', alpha, agent.id, 'ifIdle')) === 'busy')
    check('…its turn goes on', (await live())?.status === 'working' && launches().length === 2)
    check('asked to, it restarts when its turn is over', (await inv('session:restartForSide', alpha, agent.id, 'atSafePoint')) === 'restarting')
    check("…relaunched with a builder's tools once its turn ended", !!(await lib.until(async () => launches().length === 3 && sideOf(launches()[2]) === 'builder', HUNG_MS)), JSON.stringify(launches().map(sideOf)))
    check('…in the same conversation', launches()[2].opts['--resume'] === first.sessionId)
    await lib.agentIdle(inv, agent.id, HUNG_MS)
    await inv('session:stop', alpha, agent.id).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
