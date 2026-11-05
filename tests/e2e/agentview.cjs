// Claude Code's agent view stays off in Combwork's sessions: ← on an empty prompt must not move the session into
// Claude Code's background service (where Combwork can't see or stop it). Throwaway profile and workspace; no prompt
// is sent. If a background job appears anyway, it is stopped and removed. Claude Code runs in a home of the suite's
// own with a made-up API key (lib.ownClaudeHome, #368), never the user's ~/.claude; the job check asks it about that home.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const userData = path.join(lib.WORK, 'agentview-profile')
const ws = path.join(lib.WORK, 'agentview-ws')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  lib.enableProviders(userData, ['claude-code'])
  const claudeHome = lib.ownClaudeHome('agentview')
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47894), ...claudeHome.env })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1200, height: 750 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const settings = await inv('settings:get')
  check('background sessions are off by default', settings.providers['claude-code'].allowBackgroundSessions === false)
  const agent = await lib.soloAgent(inv, proj)
  await inv('session:start', proj, { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  const t0 = Date.now()
  while (Date.now() - t0 < 25000 && (await inv('session:live'))[0]?.status !== 'ready') await lib.sleep(300)
  const live = (await inv('session:live'))[0]
  check('session ready', live?.status === 'ready', live?.status)
  const claude = live?.executable || path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe')
  const jobs = () => {
    try {
      return JSON.parse(execFileSync(claude, ['agents', '--json'], { encoding: 'utf8', env: lib.childEnv(claudeHome.env) })).filter((j) => j.kind === 'background' && j.cwd.toLowerCase() === proj.toLowerCase())
    } catch {
      return []
    }
  }
  await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === agent.id)?.status === 'ready', 15000)
  await inv('pty:write', lib.ptyKey(proj, agent.id), '\x1b[D')
  await lib.sleep(6000) // A fixed wait on purpose: this checks that the session does NOT move into Claude Code's background view after ←.
  const left = jobs()
  check('← on an empty prompt keeps the session in Combwork', left.length === 0, JSON.stringify(left))
  check('the session is still running in Combwork', (await inv('session:live'))[0]?.status === 'ready')
  for (const j of left) {
    try {
      execFileSync(claude, ['stop', j.id], { env: lib.childEnv(claudeHome.env) })
      execFileSync(claude, ['rm', j.id], { env: lib.childEnv(claudeHome.env) })
    } catch {
      // best effort
    }
  }
  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
