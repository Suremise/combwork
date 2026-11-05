// Codex's background terminals: a command Codex leaves running when its turn ends is counted, Codex stays finished
// (it isn't told when the command ends, so it never carries on by itself), and the count drops when it ends.
// Test CODEX_HOME, throwaway profile and workspace. One short prompt on a small model.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { runningCliSuites, printSandboxDiagnostics } = require('./codexDiagnostics.cjs')
const { processes, namesFile } = require('./folderProcesses.cjs')

const userData = path.join(lib.WORK, 'cxbg-profile')
const ws = path.join(lib.WORK, 'cxbg-ws')
const proj = path.join(ws, 'demo')
// The file the command writes as it ends, named for this run: a check that it started never takes another suite's (#658).
const marker = `bg-done-${process.pid}-${Date.now().toString(36)}.txt`
let failed = 0
let diagnosticWindow = null
let diagnosticPrinted = false
const diagnostics = (terminal = '') => {
  if (!diagnosticWindow || diagnosticPrinted) return
  diagnosticPrinted = true
  printSandboxDiagnostics({ ...diagnosticWindow, terminal }, path.join(lib.WORK, 'codex-sandbox-diagnostics.json'))
}
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  if (!lib.codexSignedIn()) lib.skip('environment: Codex is not signed in to the test home')
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj, { 'notes.txt': 'hi\n' })
  lib.trustForCodex(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47897), CODEX_HOME: lib.CODEX_HOME, PATH: lib.pathWithoutStoreAliases() })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  await lib.addAgent(inv, proj, { name: 'Codex', provider: 'codex', model: 'gpt-6-luna', effort: 'low' })
  const agent = (await inv('workspace:get')).projects.find((p) => p.name === 'demo').agents.find((a) => a.name === 'Codex')
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)
  const seen = new Set()
  const until = async (fn, ms) => {
    const t = Date.now()
    let v
    for (;;) {
      const s = await live()
      if (s) seen.add(s.status)
      if ((v = await fn(s)) || Date.now() - t > ms) return v
      await lib.sleep(700)
    }
  }

  await inv('session:start', proj, { agentId: agent.id })
  check('Codex starts', !!(await until((s) => s?.status === 'ready', 60000)))
  const key = lib.ptyKey(proj, agent.id)
  // Printing only the id is the form that went uncounted (#162): Combwork mustn't depend on what the script prints.
  const prompt =
    `Call exec_command once with cmd "Start-Sleep -Seconds 40; Set-Content -Path ${marker} -Value done" and yield_time_ms 1000. It will return a session id while the command keeps running: do not wait for it, poll it or call write_stdin. If you call it from a script, print only its session id (text(r.session_id)). Reply with the single word STARTED and end your turn.`
  // Codex answering the prompt is the CLI's part (a usage limit or the network there is the environment's: lib.cliStep).
  diagnosticWindow = { from: Date.now(), peersBefore: runningCliSuites() }
  const t0 = await lib.cliStep('the prompt’s turn', { session: key }, async () => {
    // Typed the way Combwork types prompts (a long text at once is a paste to Codex, and Enter then adds a line).
    for (let i = 0; i < prompt.length; i += 8) {
      await inv('pty:write', key, prompt.slice(i, i + 8))
      await lib.sleep(15)
    }
    await lib.until(async () => (await inv('pty:buffer', key)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '').includes('endyourturn.'), 15000) // the whole prompt is in Codex's input
    await inv('pty:write', key, '\r')
    const ended = await until((s) => s?.status === 'finished' && s, 120000)
    const started = Date.now()
    check('its turn ends: finished, not background (Codex is never told)', ended?.status === 'finished', JSON.stringify(ended && { status: ended.status }))
    // Starting the command is Codex's part too: its sandbox can refuse to (#658, the environment's where it says so).
    const running = await lib.until(() => fs.existsSync(path.join(proj, marker)) || namesFile(processes(), marker), 10000, 1000)
    check('Codex started the command', running, lib.plainText(await inv('pty:buffer', key)).slice(-600))
    if (!running) diagnostics(lib.plainText(await inv('pty:buffer', key)))
    return started
  })
  // Combwork's part: counting what the turn left running.
  const counted = await until((s) => s?.backgroundTasks === 1 && s, 10000)
  check('the running command is counted', counted?.backgroundTasks === 1, JSON.stringify(counted && { tasks: counted.backgroundTasks }))
  if (!counted) diagnostics(lib.plainText(await inv('pty:buffer', key)))
  seen.clear()
  await page.screenshot({ path: path.join(lib.WORK, 'codex-background.png') })

  // The command ends about 40 s after it started: the count drops, and Codex doesn't start a turn of its own.
  const done = await until((s) => !s?.backgroundTasks && fs.existsSync(path.join(proj, marker)) && s, 90000)
  check('the count drops when the command ends', !!done && !done.backgroundTasks, JSON.stringify(done && { tasks: done.backgroundTasks, file: fs.existsSync(path.join(proj, marker)) }))
  if (!done) diagnostics(lib.plainText(await inv('pty:buffer', key)))
  await until(() => Date.now() - t0 > 60000, 30000)
  const after = await live()
  check('Codex stayed finished: no turn of its own when the command ended', after?.status === 'finished' && !seen.has('working'), JSON.stringify({ status: after?.status, seen: [...seen] }))

  await inv('session:stop', proj, agent.id).catch(() => undefined)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  diagnostics()
  process.exit(1)
})
