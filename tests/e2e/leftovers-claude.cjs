// What the real Claude Code leaves running in the background is tracked as the agent's leftovers (#515, #507): the
// leftovers suite checks Hive's side with the fake. The agent runs `node linger.js` (it writes its pid and waits ten
// minutes) with the Bash tool's run_in_background, and is stopped as Hive stops it (its terminal ended), then the same
// with /exit typed into Claude Code. Either way the process must end with Claude Code or be listed (session:leftovers)
// and ended by End: with Claude Code 2.1.296 it outlives Hive's stop and is listed, and /exit ends it.
// It sends two short prompts with Haiku (tokens), in the Claude Code test home (CLAUDE_TEST_HOME, claudeHome: 'test'),
// never the user's own: not signed in there, the suite is skipped (tests/e2e/README.md). Each wait on the CLI is a
// lib.cliStep: a usage limit, sign-in or network failure there makes the suite a SKIP. Dev build, throwaway profile
// and workspace.
const lib = require('./lib.cjs')
const { CLAUDE_TEST_HOME } = require('./runContext.cjs')
const { _electron } = require('playwright-core')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const userData = path.join(lib.WORK, 'leftovers-claude-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test session (#174).
const ws = path.join(lib.WORK, 'leftovers-claude-ws')
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

// The test home's sign-in, as Claude Code says it (the runner asks too; this is for running the suite on its own).
const exe = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')].find((f) => fs.existsSync(f)) ?? 'claude'
const status = spawnSync(exe, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30000, env: lib.childEnv({ CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME }) })
let signedIn = true
try {
  signedIn = JSON.parse(status.stdout).loggedIn !== false
} catch {
  // An answer that can't be read: run, and the steps say what is wrong.
}
if (!signedIn) lib.skip(`environment: Claude Code isn't signed in to its test home ${CLAUDE_TEST_HOME} (tests/e2e/README.md)`)

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  // Writes its pid where the test reads it, and runs ten minutes (well past the test) unless ended.
  lib.gitProject(proj, { 'linger.js': "require('fs').writeFileSync(`linger-${process.argv[2]}.pid`, String(process.pid))\nsetTimeout(() => {}, 600000)\n" })
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.sessions = { ...cfg.settings.sessions, confirmStop: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47866), CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  try {
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    await page.getByText('demo', { exact: true }).first().click()
    const agent = await lib.addAgent(inv, proj, { name: 'Claude', model: 'haiku', permissionMode: 'bypassPermissions' })
    const key = lib.ptyKey(proj, agent.id)
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)
    const listed = async () => (await inv('session:leftovers')).find((l) => l.agentId === agent.id)

    /** Starts the agent and has it start `node linger.js <tag>` in the background: its pid, once it runs. */
    const startInBackground = (tag) =>
      lib.cliStep(`the ${tag} turn`, { session: key }, async () => {
        const launchMark = lib.hiveLogLines(userData).length
        await inv('session:start', proj, { agentId: agent.id })
        await lib.acceptClaudeTrust(inv, proj, agent.id, 60000)
        check(`Claude Code starts (${tag})`, !!(await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 90000, 500)), lib.plainText(await inv('pty:buffer', key)).slice(-400))
        const prompt = `Use the Bash tool once, with run_in_background set to true, to run: node linger.js ${tag}   Do not wait for it, read its output or check on it. Then reply with the single word STARTED.`
        await lib.sendPrompt(inv, key, prompt, { submitted: async () => (await live())?.status === 'working' || !!pidOf(tag), ready: () => lib.hiveToolsConnected(userData, agent.id, launchMark) })
        const pid = await lib.until(() => pidOf(tag), 120000, 500)
        check(`the agent started node linger.js in the background (${tag})`, !!pid && alive(pid), lib.plainText(await inv('pty:buffer', key)).slice(-600))
        // With the task running Claude Code's turn ends in background (it is told when the task ends: backgroundWakes).
        check(`its turn ends, waiting on the task (${tag})`, !!(await lib.until(async () => ['background', 'finished'].includes((await live())?.status), 120000, 500)), JSON.stringify(await live()))
        return pid
      })

    /** What became of the process once the CLI has gone: ended with it, or listed by Hive, and then End ends it. */
    const afterExit = async (how, pid) => {
      const was = await lib.until(async () => (!alive(pid) ? 'ended' : (await listed())?.processes.some((p) => p.pid === pid) ? 'listed' : null), 20000, 500)
      console.log(`INFO after ${how} the background process ${was === 'ended' ? 'ended with Claude Code' : was === 'listed' ? 'outlived it, listed' : 'outlived it, not listed'}`)
      check(`after ${how}, the background process ends with Claude Code or Hive lists it`, !!was, JSON.stringify(await listed()))
      if (was !== 'listed') return
      const found = await listed()
      check(`as a node process (${how})`, !!found && found.processes.find((p) => p.pid === pid)?.label.startsWith('node '), JSON.stringify(found))
      await page.screenshot({ path: path.join(lib.WORK, 'leftovers-claude-listed.png') })
      const ended = await inv('session:settleLeftovers', proj, agent.id, 'end')
      check(`End ends it (${how})`, ended >= 1 && (await lib.until(() => !alive(pid), 10000)), JSON.stringify({ ended, alive: alive(pid) }))
      check(`and it is no longer listed (${how})`, !!(await lib.until(async () => !(await listed()), 10000)))
    }

    // Stopped as Hive stops it (its terminal ended).
    const pid = await startInBackground('stop')
    await page.screenshot({ path: path.join(lib.WORK, 'leftovers-claude-running.png') })
    await inv('session:stop', proj, agent.id)
    check('Hive stops Claude Code', !!(await lib.until(async () => !(await live()), 20000)))
    await afterExit('Hive stops it', pid)

    // /exit: Claude Code ending by itself.
    const pid2 = await startInBackground('exit')
    // Enter on the command menu may only pick /exit from it: sendPrompt presses it again until Claude Code has gone.
    const exited = !!(await lib.sendPrompt(inv, key, '/exit', { submitted: async () => !(await live()), waitMs: 15000 }))
    check('/exit ends Claude Code', exited, lib.plainText(await inv('pty:buffer', key).catch(() => '')).slice(-800))
    if (exited) await afterExit('/exit', pid2)
    else await page.screenshot({ path: path.join(lib.WORK, 'leftovers-claude-exit.png') })
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
