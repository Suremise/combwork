// Isolated checks (#1435, SPEC §16.13): `hive-progress --check <name> --isolated` runs the project's check in a check copy
// of its own at the card's revision. Two fake Claude Code builders share the project folder (Where cards are built: the
// project folder), each on a card; the check is a script the test steers:
// - in the shared folder, another agent's edit while the check runs makes it uncounted; the same check with --isolated,
//   edited under the same way, counts, runs in copies/copy-1 at the card's revision, and its run's details name the copy;
// - with the project's one copy leased (its size set to 1), B2's isolated check waits ("waiting for a check copy"), then
//   runs in copy-1 once B1's has ended and the copy is quiet;
// - an isolated check that started a detached process of its own is stopped from the Progress panel: its whole tree ends
//   (the check and what it left), and the copy is used by the next run.
// Screenshots of the panel with the isolated run and its details. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const PORT = Number(lib.port(47843))
const at = (x) => path.join(lib.WORK, `isolatedcheck-${x}`)
const userData = at('profile')
const ws = at('ws')
const claudeHome = at('claude-home')
const tools = at('tools')
const shots = at('shots')
const alpha = path.join(ws, 'alpha')
const control = path.join(tools, 'control.json')
const started = path.join(tools, 'started.jsonl')
const go = path.join(tools, 'go.txt')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const gitIn = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: lib.baseEnv(), encoding: 'utf8' }).trim()
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** What the next check does: `pass`, `wait` (until go.txt), or `spawn` (a detached sleeper of its own, then waits for ever). */
const steer = (mode) => {
  for (const f of [go]) fs.rmSync(f, { force: true })
  fs.writeFileSync(control, JSON.stringify({ mode }))
}
const starts = () => (fs.existsSync(started) ? fs.readFileSync(started, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, tools, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, tools, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', '.gitignore': '.hive/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  const script = path.join(tools, 'check.js')
  fs.writeFileSync(
    script,
    [
      "const fs = require('fs')",
      `const control = ${JSON.stringify(control)}, started = ${JSON.stringify(started)}, go = ${JSON.stringify(go)}`,
      "const c = JSON.parse(fs.readFileSync(control, 'utf8'))",
      'let kid = null',
      "if (c.mode === 'spawn') { const k = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); k.unref(); kid = k.pid }",
      "fs.appendFileSync(started, JSON.stringify({ pid: process.pid, kid, cwd: process.cwd() }) + '\\n')",
      "if (c.mode === 'pass') process.exit(0)",
      "if (c.mode === 'spawn') setInterval(() => {}, 1000)",
      "else { const t = Date.now(); const tick = () => { if (fs.existsSync(go)) process.exit(0); if (Date.now() - t > 120000) process.exit(3); setTimeout(tick, 100) }; tick() }",
      ''
    ].join('\n')
  )
  steer('pass')
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' }) })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    // Cards built in the project folder (shared); the check "quick" before Review, the steered script.
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project', preChecks: ['quick'], commands: { quick: `node "${script}"` } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    for (const a of [b1, b2]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await until(async () => (await live(b1.id))?.status === 'ready' && (await live(b2.id))?.status === 'ready', HUNG_MS)))
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (id) => {
      const sessionId = (await live(id))?.sessionId
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.hive : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.HIVE_API_TOKEN_FILE, 'utf8')).token : null
    }
    const call = async (token, p) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const shells = () => {
      const f = path.join(claudeHome, 'fake-shell.jsonl')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    /** Types a shell command into an agent's fake session; resolves with its record once it has ended. */
    const shell = async (id, cmd) => {
      const before = shells().length
      await until(async () => (await live(id))?.status !== 'working', HUNG_MS)
      await inv('pty:write', lib.ptyKey(alpha, id), `shell: ${cmd}`)
      // Typed, then entered (the fake reads a line), as progressreport does.
      await lib.sleep(300)
      await inv('pty:write', lib.ptyKey(alpha, id), '\r')
      // Its own record: the first of its command after those there before it was typed (another agent's may come first).
      const index = await until(() => {
        const i = shells().findIndex((x, n) => n >= before && x.cmd === cmd && !taken.has(n))
        return i >= 0 ? i + 1 : null
      }, 120000)
      if (!index) return null
      taken.add(index - 1)
      return shells()[index - 1]
    }
    const taken = new Set()
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const a = (await inv('tasks:create', { title: 'Isolated A', project: 'alpha' })).number
    const b = (await inv('tasks:create', { title: 'Isolated B', project: 'alpha' })).number
    const [keyA, keyB] = [(await card(a)).key, (await card(b)).key]
    const [t1, t2] = [await tokenOf(b1.id), await tokenOf(b2.id)]
    const sa = await call(t1, `/v1/tasks/${encodeURIComponent(keyA)}/start`)
    const sb = await call(t2, `/v1/tasks/${encodeURIComponent(keyB)}/start`)
    check('B1 and B2 start their cards in the project folder', sa.status === 200 && sb.status === 200 && sa.body?.data?.folder?.toLowerCase() === alpha.toLowerCase(), JSON.stringify({ sa: sa.body, sb: sb.body }))
    const revision = gitIn(alpha, 'rev-parse', 'HEAD')
    const quick = async (n, run) => (await inv('tasks:work', n))?.checks.find((c) => c.name === 'quick' && c.run === run)
    const runs = async () => (await inv('progress:snapshot')).runs
    const otherEdit = () => fs.writeFileSync(path.join(alpha, 'a.ts'), 'export const a = 2\n')
    const undoEdit = () => gitIn(alpha, 'checkout', '--', 'a.ts')

    // --- In the shared folder: another agent's edit during the check makes it uncounted.
    steer('wait')
    const shared = shell(b1.id, `hive-progress --check quick --card "${keyA}"`)
    check('the shared-folder check starts in the project folder', !!(await until(() => starts().length === 1, HUNG_MS)) && starts()[0].cwd.toLowerCase() === alpha.toLowerCase(), JSON.stringify(starts()))
    otherEdit()
    fs.writeFileSync(go, 'go')
    const sharedRun = await shared
    undoEdit()
    check('…it passes', sharedRun?.code === 0, JSON.stringify(sharedRun))
    const sharedId = (await runs()).find((r) => r.check === 'quick' && r.card === a && !r.copy)?.id
    const sharedCheck = await until(() => quick(a, sharedId), HUNG_MS)
    check("…but doesn't count: files changed in the folder while it ran", sharedCheck?.counted === false && sharedCheck.whyNot === 'changed', JSON.stringify(sharedCheck))

    // --- The same check, isolated: in copies/copy-1 at the card's revision; the same edit doesn't touch it.
    await inv('project:updateConfig', alpha, { copies: { size: 1 } })
    steer('wait')
    const iso = shell(b1.id, `hive-progress --check quick --isolated --card "${keyA}"`)
    check('the isolated check starts in copies\\copy-1', !!(await until(() => starts().length === 2, HUNG_MS)) && /[\\/]copies[\\/]copy-1$/i.test(starts()[1].cwd), JSON.stringify(starts()[1]))
    check('…at the card\'s revision', gitIn(starts()[1].cwd, 'rev-parse', 'HEAD') === revision)
    const copies = () => inv('copies:list', alpha)
    check('…its copy leased to B1 for the card', !!(await until(async () => (await copies()).some((c) => c.name === 'copy-1' && c.state === 'leased' && c.lease?.card === a && c.lease.agent === b1.id && c.lease.kind === 'check'), HUNG_MS)), JSON.stringify(await copies()))
    const isoRunId = await until(async () => (await runs()).find((r) => r.check === 'quick' && r.copy === 'copy-1' && r.state === 'running')?.id, HUNG_MS)
    // The panel: the run, its Stop, and its details naming the copy.
    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click()
    check('the panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
    const isoRow = panel.locator(`[data-run="${isoRunId}"]`).first()
    check('…the isolated run shows, with Stop', !!(await until(async () => (await isoRow.count()) === 1 && (await isoRow.locator('button[aria-label="Stop this check and everything it started"]').count()) === 1, HUNG_MS)))
    await isoRow.locator('.progress-details-toggle').click()
    check("…its details name the copy", !!(await until(async () => /Copy\s*copy-1/.test((await isoRow.innerText().catch(() => '')) ?? ''), HUNG_MS)), await isoRow.innerText().catch(() => ''))
    await page.mouse.move(5, 5)
    await panel.screenshot({ path: path.join(shots, 'isolatedcheck-1-running.png') })
    otherEdit()
    fs.writeFileSync(go, 'go')
    const isoRun = await iso
    undoEdit()
    check('…it passes', isoRun?.code === 0, JSON.stringify(isoRun))
    const isoCheck = await until(() => quick(a, isoRunId), HUNG_MS)
    check('…and counts, isolated, for the card\'s revision', isoCheck?.counted === true && isoCheck.isolated === true && isoCheck.revision === revision, JSON.stringify(isoCheck))
    check('…its copy returned and freed', !!(await until(async () => (await copies()).every((c) => c.state === 'free' && !c.lease), HUNG_MS)), JSON.stringify(await copies()))

    // --- The one copy leased: B2's isolated check waits for it, then runs there.
    steer('wait')
    const holding = shell(b1.id, `hive-progress --check quick --isolated --card "${keyA}"`)
    check('B1 holds copy-1', !!(await until(() => starts().length === 3, HUNG_MS)))
    const waiting = shell(b2.id, `hive-progress --check quick --isolated --card "${keyB}"`)
    check('…B2\'s check waits: nothing of it runs while copy-1 is out', !!(await until(async () => (await live(b2.id))?.status === 'working', HUNG_MS)) && starts().length === 3)
    fs.writeFileSync(go, 'go')
    const held = await holding
    const waited = await waiting
    check("B1's check ends, then B2's runs in copy-1 and passes", held?.code === 0 && waited?.code === 0 && starts().length === 4 && /copies[\\/]copy-1$/i.test(starts()[3].cwd), JSON.stringify({ held: held?.code, waited, s: starts()[3] }))
    check('…having said it waited for a check copy', /waiting for a check copy/.test(waited?.stderr ?? ''), waited?.stderr)
    const bCheck = await until(async () => (await inv('tasks:work', b))?.checks.find((c) => c.name === 'quick' && c.isolated), HUNG_MS)
    check("…counted for B's card", bCheck?.counted === true, JSON.stringify(bCheck))

    // --- Stopped from the panel: the check and the process it started end, and the copy is used again.
    steer('spawn')
    const stopped = shell(b1.id, `hive-progress --check quick --isolated --card "${keyA}"`)
    const s5 = await until(() => starts()[4], HUNG_MS)
    check('a check that starts a detached process of its own runs in copy-1', !!s5 && !!s5.kid && /copy-1$/i.test(s5.cwd) && alive(s5.pid) && alive(s5.kid), JSON.stringify(s5))
    const stopId = await until(async () => (await runs()).find((r) => r.copy === 'copy-1' && r.state === 'running' && r.card === a)?.id, HUNG_MS)
    const stopRow = panel.locator(`[data-run="${stopId}"]`).first()
    await until(async () => (await stopRow.count()) === 1, HUNG_MS)
    await stopRow.locator('button[aria-label="Stop this check and everything it started"]').click()
    check('Stop ends the check and the process it left', !!(await until(() => !alive(s5.pid) && !alive(s5.kid), HUNG_MS)), JSON.stringify({ pid: alive(s5.pid), kid: alive(s5.kid) }))
    const stoppedRun = await stopped
    check('…its run ends stopped, not failed', stoppedRun?.code !== 0 && !!(await until(async () => (await runs()).find((r) => r.id === stopId)?.state === 'stopped', HUNG_MS)), JSON.stringify({ stoppedRun, state: (await runs()).find((r) => r.id === stopId)?.state }))
    check('…and copy-1 is free again', !!(await until(async () => (await copies()).every((c) => c.state === 'free'), HUNG_MS)), JSON.stringify(await copies()))
    steer('pass')
    const next = await shell(b2.id, `hive-progress --check quick --isolated --card "${keyB}"`)
    check('the next isolated check runs in copy-1', next?.code === 0 && /copy-1$/i.test(starts()[5]?.cwd ?? ''), JSON.stringify({ next, s: starts()[5] }))
    await panel.screenshot({ path: path.join(shots, 'isolatedcheck-2-stopped.png') })
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
