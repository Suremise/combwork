// Claude Code's status line with "Combwork's status line in place of yours" off (#1285, #966 row 12), on the real Claude Code:
// the status line in the user's Claude Code settings shows again, run after Combwork's command with the same input, while
// Combwork still reads the status. The user's line is a script that prints a marker and the model's name from its input, so
// seeing it on screen shows that the JSON reached it whole (Combwork's hook server echoes it back for the chain). On again,
// only Combwork's runs: nothing of the user's on screen. A real Claude Code starts in a home of its own with a made-up API
// key (lib.ownClaudeHome, #368), never the user's ~/.claude; no prompt is sent, so nothing is spent.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const userData = path.join(lib.WORK, 'claudestatusline-profile')
const ws = path.join(lib.WORK, 'claudestatusline-ws')
const proj = path.join(ws, 'alpha')
const SWITCH = 'claude-code.override.statusLine'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  lib.enableProviders(userData)
  const claudeHome = lib.ownClaudeHome('claudestatusline')
  // The user's own status line, in their Claude Code settings: a marker and the model's name, from the JSON it is given.
  const script = path.join(claudeHome.home, 'myline.js')
  fs.writeFileSync(script, "let d = ''\nprocess.stdin.on('data', (c) => (d += c)).on('end', () => {\n  let m = '?'\n  try { m = JSON.parse(d).model.display_name } catch {}\n  process.stdout.write('MYLINE ' + m)\n})\n")
  fs.writeFileSync(path.join(claudeHome.home, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node "${script.split('\\').join('/')}"`, padding: 0 } }))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claudeHome.env })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const agent = await lib.soloAgent(inv, proj)
    const key = lib.ptyKey(proj, agent.id)
    const live = async () => (await inv('session:live')).find((l) => l.projectPath.toLowerCase() === proj.toLowerCase())
    const screen = async () => lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '')
    const launches = () => (fs.readFileSync(path.join(userData, 'logs', 'combwork.log'), 'utf8').match(/ spawn \W?session:/g) ?? []).length
    const start = async () => {
      const before = launches()
      await inv('session:start', proj, { agentId: agent.id })
      await lib.until(() => launches() > before, HUNG_MS)
      await lib.acceptClaudeTrust(inv, proj, agent.id)
      return !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS))
    }
    const stop = async () => {
      await inv('session:stop', proj, agent.id)
      await lib.until(async () => !(await live()), HUNG_MS)
    }

    // ---- Off: the user's status line shows, with the model from Claude Code's JSON; Combwork still reads the status.
    await inv('advanced:set', SWITCH, false)
    check('the real Claude Code is ready', await start(), JSON.stringify(await live().then((l) => l && { status: l.status })))
    const shown = await lib.until(async () => /MYLINE (?!\?)\S/.test(await screen()), HUNG_MS)
    check("off: the user's own status line shows, given Claude Code's JSON whole (its model's name)", !!shown, (await screen()).slice(-600))
    check('…and Combwork still reads the status (the model for the footer)', !!(await lib.until(async () => !!(await live())?.modelName, HUNG_MS)), JSON.stringify(await live().then((l) => l && { model: l.modelName })))
    await page.screenshot({ path: path.join(lib.WORK, 'claudestatusline-off.png') })
    await stop()

    // ---- On (the default): Combwork's alone, showing nothing.
    await inv('advanced:set', SWITCH, true)
    const mark = (await screen()).length
    check('on: the real Claude Code is ready', await start())
    check('…Combwork reads the status', !!(await lib.until(async () => !!(await live())?.modelName, HUNG_MS)))
    check("…and nothing of the user's status line shows", !(await screen()).slice(mark).includes('MYLINE'), (await screen()).slice(-400))
    await stop()
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
