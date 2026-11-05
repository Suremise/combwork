// The real CLIs end by themselves on the exit command Combwork types at a lane's end (HI-1706, sessions.quit): Claude Code
// on /exit and Codex on /quit, each typed into the CLI at its prompt (through slots:test's quit, the lane end's own
// call), exit with code 0, and Combwork never kills them. No prompt is sent: Claude Code runs in a home of the suite's own
// with a made-up API key (lib.ownClaudeHome, no sign-in), Codex in the Codex test home in a folder trusted there.
// Throwaway profile and workspace. Dev build only: slots:test is refused by a packaged build.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'cliquit-profile')
const ws = path.join(lib.WORK, 'cliquit-ws')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  const codex = lib.codexSignedIn()
  if (!codex) console.log('SKIP Codex: the Codex test home is not signed in (environment): only Claude Code is checked')
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj)
  if (codex) lib.trustForCodex(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const claudeHome = lib.ownClaudeHome('cliquit')
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47795), CODEX_HOME: lib.CODEX_HOME, ...claudeHome.env })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  try {
    await lib.fitWindow(app, page, { width: 1200, height: 750 })
    await lib.appReady(page)
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
    const cases = [{ name: 'Claude Code', provider: 'claude-code', line: '/exit' }, ...(codex ? [{ name: 'Codex', provider: 'codex', line: '/quit', model: 'gpt-6-luna', effort: 'low' }] : [])]
    for (const c of cases) {
      const agent = await lib.addAgent(inv, proj, { name: c.name.replace(' ', ''), provider: c.provider, ...(c.model ? { model: c.model, effort: c.effort } : {}) })
      const key = lib.ptyKey(proj, agent.id)
      await inv('session:start', proj, { agentId: agent.id })
      if (c.provider === 'claude-code') await lib.acceptClaudeTrust(inv, proj, agent.id)
      const ready = await lib.until(async () => (await live(agent.id))?.status === 'ready', HUNG_MS, 300)
      check(`${c.name} starts and is at its prompt`, !!ready, lib.plainText(await inv('pty:buffer', key).catch(() => '')).slice(-400))
      // Its hive tools connected: Combwork types nothing into a CLI before then (sessions.hiveToolsSettled).
      await lib.until(() => lib.hiveToolsConnected(userData, agent.id), HUNG_MS, 300)
      const version = (await live(agent.id))?.cliVersion ?? null
      const since = Math.max(0, lib.hiveLogLines(userData).length - 1) // the last element is the empty one after the final newline
      const r = await inv('slots:test', proj, { op: 'quit', agent: agent.id })
      check(`${c.name}: its exit command is typed`, r === 'sent', JSON.stringify(r))
      const gone = await lib.until(async () => !(await live(agent.id)), HUNG_MS, 300)
      const after = lib.hiveLogLines(userData).slice(since)
      const mine = after.filter((l) => l.includes(`#${agent.id}`) || l.includes(`⁨${agent.id}⁩`))
      check(`${c.name}: ${c.line} was typed`, after.some((l) => l.includes(`typed ${c.line} (a test asked)`)), after.join('\n'))
      check(`${c.name} exits by itself (code 0)${version ? `, ${version}` : ''}`, !!gone && mine.some((l) => l.includes('[pty] exit') && /: 0⁩?$/.test(l.trim())), mine.join('\n'))
      check(`${c.name} is never killed`, !mine.some((l) => l.includes('[pty] kill')) && !after.some((l) => l.includes('still running') && l.includes('after its exit command')), mine.join('\n'))
    }
  } catch (err) {
    check('no unexpected error', false, err.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})()
