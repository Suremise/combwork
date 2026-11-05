// What Codex leaves running in a background terminal is tracked as the agent's leftovers (#515, #507): the leftovers
// suite checks Combwork's side with the fake. The agent runs `node linger.js` (it writes its pid and waits ten minutes)
// with exec_command, leaving it running as its turn ends (codex-background), and is stopped as Combwork stops it (its
// terminal ended), then the same with /exit typed into Codex. Either way the process must end with Codex or be listed
// (session:leftovers) and ended by End: Codex 0.162 ends its background terminals as it exits, both ways.
// Test CODEX_HOME, throwaway profile and workspace. Two short prompts on a small model.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'leftovers-codex-profile')
const ws = path.join(lib.WORK, 'leftovers-codex-ws')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Each linger.js by its identity (pid and start time) once its pid is read: a check or the clean-up never takes a
// process that got the pid after it ended (#603: a remembered pid killed here could be a concurrent run's Vitest worker).
const ids = new Map()
const alive = (pid) => ids.has(pid) && lib.stillSame([ids.get(pid)]).length === 1
const pidOf = (tag) => {
  const f = path.join(proj, `linger-${tag}.pid`)
  const pid = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8').trim()) : 0
  if (pid && !ids.has(pid)) for (const id of lib.identify([pid])) ids.set(id.pid, id)
  return pid
}

;(async () => {
  if (!lib.codexSignedIn()) lib.skip('environment: Codex is not signed in to the test home')
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  // Writes its pid where the test reads it, and runs ten minutes (well past the test) unless ended.
  lib.gitProject(proj, { 'linger.js': "require('fs').writeFileSync(`linger-${process.argv[2]}.pid`, String(process.pid))\nsetTimeout(() => {}, 600000)\n" })
  lib.trustForCodex(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.sessions = { ...cfg.settings.sessions, confirmStop: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47867), CODEX_HOME: lib.CODEX_HOME })
  // Codex runs commands in PowerShell 7 where there is one: kept on PATH, the Microsoft Store's too (an alias in
  // WindowsApps). That one is a packaged app whose children start outside every job, and Codex doesn't end them as it
  // exits: Combwork's process tracker takes them in (#543, SPEC §6.2 Leftover processes), so they are listed and ended.
  const storePwsh = (() => {
    try {
      return !!fs.lstatSync(path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe'))
    } catch {
      return false
    }
  })()
  console.log(`INFO the Store's PowerShell 7 is ${storePwsh ? '' : 'not '}installed: Codex's commands run in ${storePwsh ? 'it' : 'another shell'}`)
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  try {
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('demo', { exact: true }).first().click()
    const agent = await lib.addAgent(inv, proj, { name: 'Codex', provider: 'codex', model: 'gpt-6-luna', effort: 'low' })
    const key = lib.ptyKey(proj, agent.id)
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)
    const listed = async () => (await inv('session:leftovers')).find((l) => l.agentId === agent.id)

    /** Starts the agent and has it leave `node linger.js <tag>` running in a background terminal: its pid. */
    const startInBackground = (tag) =>
      lib.cliStep(`the ${tag} turn`, { session: key }, async () => {
        await inv('session:start', proj, { agentId: agent.id })
        check(`Codex starts (${tag})`, !!(await lib.until(async () => (await live())?.status === 'ready', 60000, 500)), lib.plainText(await inv('pty:buffer', key)).slice(-400))
        const prompt = `Call exec_command once with cmd "node linger.js ${tag}" and yield_time_ms 1000. It will return a session id while the command keeps running: do not wait for it, poll it or call write_stdin. Reply with the single word STARTED and end your turn.`
        // Typed the way Combwork types prompts (a long text at once is a paste to Codex, and Enter then adds a line).
        for (let i = 0; i < prompt.length; i += 8) {
          await inv('pty:write', key, prompt.slice(i, i + 8))
          await lib.sleep(15)
        }
        await lib.until(async () => lib.plainText(await inv('pty:buffer', key)).replace(/\s+/g, '').includes('endyourturn.'), 15000)
        await inv('pty:write', key, '\r')
        const pid = await lib.until(() => pidOf(tag), 120000, 500)
        check(`the agent started node linger.js in a background terminal (${tag})`, !!pid && alive(pid), lib.plainText(await inv('pty:buffer', key)).slice(-600))
        check(`its turn ends (${tag})`, !!(await lib.until(async () => (await live())?.status === 'finished', 120000, 500)), JSON.stringify(await live()))
        return pid
      })

    /** What became of the process once the CLI has gone: ended with it, or listed by Combwork, and then End ends it. */
    const afterExit = async (how, pid) => {
      const was = await lib.until(async () => (!alive(pid) ? 'ended' : (await listed())?.processes.some((p) => p.pid === pid) ? 'listed' : null), 20000, 500)
      console.log(`INFO after ${how} the background process ${was === 'ended' ? 'ended with Codex' : was === 'listed' ? 'outlived it, listed' : 'outlived it, not listed'}`)
      check(`after ${how}, the background process ends with Codex or Combwork lists it`, !!was, JSON.stringify(await listed()))
      if (was !== 'listed') return
      const found = await listed()
      check(`as a node process (${how})`, !!found && found.processes.find((p) => p.pid === pid)?.label.startsWith('node '), JSON.stringify(found))
      await page.screenshot({ path: path.join(lib.WORK, 'leftovers-codex-listed.png') })
      const ended = await inv('session:settleLeftovers', proj, agent.id, 'end')
      check(`End ends it (${how})`, ended >= 1 && (await lib.until(() => !alive(pid), 10000)), JSON.stringify({ ended, alive: alive(pid) }))
      check(`and it is no longer listed (${how})`, !!(await lib.until(async () => !(await listed()), 10000)))
    }

    // Stopped as Combwork stops it (its terminal ended).
    const pid = await startInBackground('stop')
    await page.screenshot({ path: path.join(lib.WORK, 'leftovers-codex-running.png') })
    await inv('session:stop', proj, agent.id)
    check('Combwork stops Codex', !!(await lib.until(async () => !(await live()), 20000)))
    await afterExit('Combwork stops it', pid)

    // /exit: Codex ending by itself.
    const pid2 = await startInBackground('exit')
    // Enter on the command menu may only pick /exit from it: sendPrompt presses it again until Codex has gone.
    const exited = !!(await lib.sendPrompt(inv, key, '/exit', { submitted: async () => !(await live()), waitMs: 15000 }))
    check('/exit ends Codex', exited, lib.plainText(await inv('pty:buffer', key).catch(() => '')).slice(-800))
    if (exited) await afterExit('/exit', pid2)
  } finally {
    await app.close().catch(() => undefined)
    lib.endExactly([...ids.values()])
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  lib.endExactly([...ids.values()])
  process.exit(1)
})
