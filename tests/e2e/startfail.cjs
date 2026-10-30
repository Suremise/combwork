// An agent whose CLI exits before its session starts shows why: a red bar under its terminal with the CLI's error,
// a hint, Retry and Agent Settings…, a stalled mark and "Failed to start" in its header, and a toast when its pane
// isn't on screen. Retry starts it again once fixed; a stop or a normal end shows no failure. The agent runs the
// fake Claude Code (fake-claude/), made to fail with `--model fail-start`. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'startfail-profile')
const ws = path.join(lib.WORK, 'startfail-ws')
const claudeHome = path.join(lib.WORK, 'startfail-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47897), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Starter', model: 'fail-start' })
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
  const header = page.locator('.pane-header-bar', { hasText: 'Starter' })
  const pane = page.locator('.agent-pane', { has: header })
  const bar = pane.locator('.start-failed')
  const text = (l) => l.innerText().catch(() => '')

  // --- It fails at start, on screen.
  await inv('session:start', alpha, { agentId: agent.id })
  check('the failure shows under the terminal', !!(await until(async () => (await bar.count()) === 1, HUNG_MS)))
  const said = await text(bar)
  check("it gives the CLI's error", /Couldn't start: error: option '--model <model>' argument 'fail-start' is invalid\./.test(said), said)
  check('with a hint for the fix', /choose another in Agent Settings/.test(said), said)
  check('with Retry and Agent Settings…', (await bar.getByRole('button', { name: 'Retry' }).count()) === 1 && (await bar.getByRole('button', { name: 'Agent Settings…' }).count()) === 1)
  check('the header says Failed to start, in red', /Failed to start/.test(await text(header.locator('.pane-status.failed'))) && (await header.locator('.state-mark.stalled').count()) === 1)
  check("its pane header's mark is stalled (#975: the strip's tab went red)", (await header.locator('.state-mark.stalled').count()) === 1)
  check('no toast while its pane is on screen', (await page.locator('.toast', { hasText: "couldn't start" }).count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'startfail-1-bar.png') })

  // --- Agent Settings… opens the agent's settings.
  await bar.getByRole('button', { name: 'Agent Settings…' }).click()
  check('Agent Settings… opens them', !!(await until(async () => (await page.getByRole('dialog', { name: 'Starter settings' }).count()) === 1, 5000)))
  await page.keyboard.press('Escape')
  await lib.sleep(300)

  // --- ✕ puts back the usual "Session ended" bar.
  await bar.getByRole('button', { name: /Dismiss/ }).click()
  check('✕ dismisses it', !!(await until(async () => (await bar.count()) === 0 && (await pane.locator('.session-ended').count()) === 1, 5000)))
  check('and the header goes back to not running', /Not running/.test(await text(header.locator('.pane-status'))) && (await header.locator('.state-mark.stalled').count()) === 0)

  // --- Off screen: a toast with Show.
  await page.locator('.tab', { hasText: 'Files' }).click()
  await inv('session:start', alpha, { agentId: agent.id })
  const toast = page.locator('.toast', { hasText: "Starter couldn't start" })
  check('off screen, a toast says so', !!(await until(async () => (await toast.count()) === 1, HUNG_MS)))
  check('the toast has the hint and Show', /choose another in Agent Settings/.test(await text(toast)) && (await toast.getByRole('button', { name: 'Show' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'startfail-2-toast.png') })
  await toast.getByRole('button', { name: 'Show' }).click()
  check('Show opens the agent with the failure', !!(await until(async () => (await bar.count()) === 1, 5000)))

  // --- Fixed, Retry starts it, and the failure goes.
  // Saved by the time agents:update returns, and Retry starts it from what's saved.
  await lib.setLaunch(inv, alpha, agent.id, { model: '' })
  await bar.getByRole('button', { name: 'Retry' }).click()
  check('Retry starts it again', !!(await until(async () => (await live())?.status === 'ready', 15000)))
  check('the failure is gone once it starts', !!(await until(async () => (await bar.count()) === 0 && !/Failed to start/.test(await text(header)) && (await header.locator('.state-mark.stalled').count()) === 0, HUNG_MS)))

  // --- A stop isn't a failed start.
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 8000)
  // The pane says the session ended once the stop reaches it; a failure would show by then, in place of that.
  check('a stop shows no failure', !!(await until(async () => (await pane.locator('.session-ended:not(.start-failed)').count()) === 1, HUNG_MS)) && (await bar.count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'startfail-3-stopped.png') })

  // --- A bare "--" in extra arguments (#523): Hive passes the task after its own, so a connection's are refused with
  // one (HI-2122: extra arguments are a connection's), and one saved before (a config.json edited by hand) stops the
  // launch, saying why, before the CLI starts.
  const refused = 'Hive passes the task after "--"; remove it from extra arguments.'
  const connectionOf = () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'project.json'), 'utf8')).agents.find((x) => x.id === agent.id).connection
  const saved = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).connections.find((c) => c.id === connectionOf())
  const before = connectionOf()
  const saving = await lib.setLaunch(inv, alpha, agent.id, { extraArgs: '--allowedTools Read Bash --' }).then(() => '', (e) => String(e?.message ?? e))
  check('a connection with a bare "--" is refused, saying why', saving.includes(refused), saving)
  check('and the agent keeps its connection', connectionOf() === before, connectionOf())
  await lib.setLaunch(inv, alpha, agent.id, { extraArgs: '--append-system-prompt=--' })
  check('an option whose value is "--" is written with "="', saved()?.extraArgs === '--append-system-prompt=--', JSON.stringify(saved()))
  await app.close()
  const cfgNow = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfgNow.connections.find((c) => c.id === connectionOf()).extraArgs = '--allowedTools Read Bash --'
  fs.writeFileSync(cfgFile, JSON.stringify(cfgNow, null, 2))
  const again = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page2 = await again.firstWindow()
  page2.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(again, page2, { width: 1400, height: 850 })
  await lib.appReady(page2)
  const inv2 = (ch, ...a) => page2.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv2, page2, ws)
  await page2.getByText('alpha', { exact: true }).first().click()
  const started = await inv2('session:start', alpha, { agentId: agent.id, prompt: 'Work on card #12' }).then(() => '', (e) => String(e?.message ?? e))
  // …and where to fix it: its connection, by name, in Settings → Accounts & Connections (HI-2140).
  const fixIn = `Fix it in its connection, ${cfgNow.connections.find((c) => c.id === connectionOf()).name}, in Settings → Accounts & Connections.`
  check('a saved bare "--" stops the launch, saying why and naming its connection', started.includes(refused) && started.includes(fixIn), started)
  check('and the CLI never started', !(await inv2('session:live')).some((x) => x.projectPath.toLowerCase() === alpha.toLowerCase() && x.agentId === agent.id))
  // Started from the window, the refusal shows as a notification.
  // New Session from its ⋯ (#977: the header shows Resume in Stop's place while it has a session to resume).
  await page2.locator('.pane-header-bar', { hasText: 'Starter' }).getByRole('button', { name: 'More', exact: true }).click()
  await page2.locator('.menu .menu-item', { hasText: 'New Session' }).click()
  const notice = page2.locator('.toast', { hasText: refused })
  check('the window shows why', !!(await until(async () => (await notice.count()) === 1, HUNG_MS)), JSON.stringify(await page2.locator('.toast').allInnerTexts()))
  await page2.screenshot({ path: path.join(lib.WORK, 'startfail-4-dashes.png') })

  await again.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
