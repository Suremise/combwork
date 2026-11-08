// An Independent agent launches as from a terminal (HI-2731, Darren's 7 Nov 22:15 decision: "Independent behaves as if
// connection level switches are off"), on the fake Claude Code and the fake Codex: one agent of each Either → Independent
// → Either, a new session each time, beside a fresh agent only ever Independent. Either gets Combwork's server, its
// skills and its variables (and, on Codex, its developer_instructions); made Independent its next launch gets none of
// them and its skill copies are retired; made Either again, all of it is back; the fresh one gets what the changed one
// does. And a running agent made Independent restarts for it, as a role change does (HR1's round 1). Antigravity's is the
// antigravity suite's; Copilot (no fake CLI) is agentMcp.test's. Dev build, throwaway profile and homes.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'independentlaunch-profile')
const ws = path.join(lib.WORK, 'independentlaunch-ws')
const claudeHome = path.join(lib.WORK, 'independentlaunch-claude-home')
const codexHome = path.join(lib.WORK, 'independentlaunch-codex-home')
const proj = path.join(ws, 'alpha')
const PORT = lib.port(47803)
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const ownSkills = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome, ws]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(proj)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([proj.toLowerCase(), ws.toLowerCase()]))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
    const stop = async (id) => {
      await inv('session:stop', proj, id)
      await lib.until(async () => !(await live(id)), HUNG_MS)
    }
    /** One new session of the agent with `role`: what its CLI was given, read from the fake's record of that launch. */
    const launchAs = async (agent, role) => {
      await inv('agents:update', proj, agent.id, { workflowRole: role })
      const file = agent.provider === 'codex' ? path.join(codexHome, 'fake-launches.jsonl') : path.join(claudeHome, 'fake-launches.jsonl')
      const before = lines(file).length
      await inv('session:start', proj, { agentId: agent.id })
      const rec = await lib.until(() => lines(file)[before] ?? null, HUNG_MS)
      let got
      if (agent.provider === 'codex') {
        const args = rec?.args ?? []
        const keys = args.filter((_a, i) => args[i - 1] === '-c').map((v) => v.split('=')[0])
        got = { server: keys.includes('mcp_servers.combwork'), guidance: keys.includes('developer_instructions'), skills: ownSkills(path.join(proj, '.agents', 'skills')).some((n) => n.startsWith('cw-')), variables: rec?.agent !== null }
      } else {
        const opts = rec?.opts ?? {}
        const mcp = read(opts['--mcp-config'])
        got = { server: !!mcp?.mcpServers?.combwork, guidance: !!mcp?.mcpServers?.combwork && mcp.mcpServers.combwork.env?.CW_GUIDANCE !== '0', skills: ownSkills(path.join(opts['--plugin-dir'] ?? '', 'skills')).length > 0, variables: !!rec?.env?.CW_AGENT }
      }
      await stop(agent.id)
      return got
    }
    const all = { server: true, guidance: true, skills: true, variables: true }
    const none = { server: false, guidance: false, skills: false, variables: false }

    for (const provider of ['claude-code', 'codex']) {
      const label = provider === 'codex' ? 'Codex' : 'Claude Code'
      const one = await lib.addAgent(inv, proj, { name: `${label.replace(' ', '')}One`, provider })
      const asEither = await launchAs({ ...one, provider }, 'either')
      check(`${label}: an Either agent gets Combwork's server, guidance, skills and variables`, JSON.stringify(asEither) === JSON.stringify(all), JSON.stringify(asEither))
      const asIndependent = await launchAs({ ...one, provider }, 'independent')
      check(`${label}: made Independent, its next launch is as from a terminal, its skill copies retired`, JSON.stringify(asIndependent) === JSON.stringify(none), JSON.stringify(asIndependent))
      const again = await launchAs({ ...one, provider }, 'either')
      check(`${label}: made Either again, all of it is back`, JSON.stringify(again) === JSON.stringify(all), JSON.stringify(again))
      const fresh = await lib.addAgent(inv, proj, { name: `${label.replace(' ', '')}Fresh`, provider })
      const freshGot = await launchAs({ ...fresh, provider }, 'independent')
      check(`${label}: a fresh agent only ever Independent gets the same`, JSON.stringify(freshGot) === JSON.stringify(asIndependent), JSON.stringify(freshGot))
      // Independent again, so the next CLI's skill copies in the project start from none of this one's.
      await launchAs({ ...one, provider }, 'independent')
    }

    // A running agent made Independent restarts for it (idle: at once), and back.
    const runner = await lib.addAgent(inv, proj, { name: 'Runner' })
    await inv('session:start', proj, { agentId: runner.id })
    // Before any turn: a new session, no prompt.
    await lib.until(async () => (await live(runner.id))?.status === 'ready', HUNG_MS)
    const launchesBefore = lines(path.join(claudeHome, 'fake-launches.jsonl')).length
    await inv('agents:update', proj, runner.id, { workflowRole: 'independent' })
    const relaunched = await lib.until(() => (lines(path.join(claudeHome, 'fake-launches.jsonl')).length > launchesBefore ? lines(path.join(claudeHome, 'fake-launches.jsonl')).at(-1) : null), HUNG_MS)
    check('a running agent made Independent restarts at once, as from a terminal', !!relaunched && !read(relaunched.opts?.['--mcp-config'])?.mcpServers?.combwork && !relaunched.env?.CW_AGENT, JSON.stringify(relaunched?.opts ?? null))
    // Ready again in its restarted session, before any turn there.
    await lib.until(async () => (await live(runner.id))?.status === 'ready', HUNG_MS)
    const backBefore = lines(path.join(claudeHome, 'fake-launches.jsonl')).length
    await inv('agents:update', proj, runner.id, { workflowRole: 'either' })
    const back = await lib.until(() => (lines(path.join(claudeHome, 'fake-launches.jsonl')).length > backBefore ? lines(path.join(claudeHome, 'fake-launches.jsonl')).at(-1) : null), HUNG_MS)
    check('…and made Either again, restarts with Combwork’s server', !!back && !!read(back.opts?.['--mcp-config'])?.mcpServers?.combwork, JSON.stringify(back?.opts ?? null))
    await stop(runner.id)
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
