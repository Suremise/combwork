// What the agents had started, after Combwork closed unexpectedly (#987): while an agent runs, the running marker keeps what
// its launch started (its process job's members, each by id and start time). The fake Claude Code's "linger 1" leaves a
// node running, as a test run under cw-progress was left (Darren, 17 Oct). The test copy is ended from outside (by its
// own pid and start time, lib.identify, never by name): the node keeps running, and the next start's "Combwork closed
// unexpectedly" notice says one process the agents started is still running, with Stop Them. Nothing is stopped on its
// own; Stop Them ends exactly that node. A kept record whose pid names another process by then (a stranger's, with
// another start time) is never listed, and the stranger is never ended. #1008: a command left running through
// cw-progress (fake-claude's "progress-linger": cmd → cw-progress → a node) is one item of the notice, named by its
// title, and Stop Them ends its whole tree; the Agent API says whether the launch it was started in still runs (a test
// run waiting for a slot asks it). Fake Claude Code; dev build, throwaway profile and workspace, quiet.
const lib = require('./lib.cjs')
const { processes, descendantsIn, endAsCrash } = require('./folderProcesses.cjs')
const { _electron } = require('playwright-core')
const { spawn, execFileSync } = require('child_process')
const { baseEnv } = require('./runContext.cjs')
const fs = require('fs')
const net = require('net')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000
const START_MS = 30000

const base = path.join(lib.WORK, 'unexpectedclose-leftovers')
const userData = path.join(base, 'profile')
const home = path.join(base, 'claude-home')
const ws = path.join(base, 'ws')
const proj = path.join(ws, 'site')
const markerFile = path.join(userData, 'running.json')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const marker = () => {
  try {
    return JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    return null
  }
}
const API_PORT = lib.port(47835)
const pidsIn = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])

// Playwright loses its connection to a copy ended from outside: not this suite's failure.
process.on('uncaughtException', (e) => {
  if (/Target page, context or browser has been closed|has been closed|Target crashed|ECONNRESET|EPIPE/.test(String(e?.message))) return
  console.error(e)
  process.exit(1)
})

const identities = []
let claudeEnv = null

/** Starts a copy of Combwork on the profile, with its workspace restored. */
async function start() {
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(API_PORT), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  identities.push(...lib.identify([app.process().pid]))
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  return { app, page, inv }
}

/** A GET of the copy's Agent API with the workspace's token: { status, body }. */
async function apiGet(route) {
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const r = await fetch(`http://127.0.0.1:${API_PORT}${route}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/**
 * Ends the copy from outside, as a crash or a kill would: its own process (by pid and start time) and what it started,
 * apart from the cw-progress run under `outlives` (its pid): from the shell that ran the cw-progress command down, it
 * keeps going, as a test run did when Combwork closed under it (#1008).
 */
async function endFromOutside(app, outlives) {
  const proc = app.process()
  const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
  const id = identities.find((i) => i.pid === proc.pid)
  const list = processes()
  const root = id && list.find((p) => p.pid === id.pid && Math.abs(p.started - id.started) <= 1)
  const byPid = new Map(list.map((p) => [p.pid, p]))
  let top = byPid.get(outlives)
  for (let up = top && byPid.get(top.parent); up && up.started <= top.started && /(hive|cw)-progress/i.test(up.commandLine); up = byPid.get(up.parent)) top = up
  const kept = new Set(top ? [top.pid, ...descendantsIn(list, top.pid).map((d) => d.pid)] : [])
  const ended = root && !kept.has(root.pid) ? endAsCrash(list, { pid: root.pid, started: root.started }, descendantsIn(list, root.pid).filter((p) => !kept.has(p.pid))) : 0
  const exited = await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), HUNG_MS))])
  return ended > 0 && exited
}

/** Whether nothing listens on the Agent API port (on 127.0.0.1, where Combwork listens), told as lanes.mjs portFree tells it. */
const apiPortFree = () =>
  new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(API_PORT, '127.0.0.1', () => srv.close(() => resolve(true)))
  })

/** What listens on the Agent API port (netstat), each owner by pid and command line: for a port that is never freed. */
const portHolders = () => {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', env: baseEnv(), windowsHide: true })
    const pids = new Set(out.split(/\r?\n/).filter((l) => l.includes(`127.0.0.1:${API_PORT} `) && /LISTENING/.test(l)).map((l) => Number(l.trim().split(/\s+/).pop())))
    const list = processes()
    return JSON.stringify([...pids].map((pid) => list.find((p) => p.pid === pid) ?? { pid, gone: true }))
  } catch (e) {
    return String(e)
  }
}

/** The notice's text in the window, once it is shown. */
const notice = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).find((t) => t.includes('Combwork closed unexpectedly')) ?? '')

;(async () => {
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  const started = Date.now()
  claudeEnv = lib.fakeClaude(userData, home, [proj])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Someone else's process, whose pid a kept record will name with another start time: never listed or ended. It names
  // the suite's folder, so the clean-up below finds it, and ends itself once this suite's process is gone (or after an hour).
  const strangerCode = `const suite = ${process.pid}; setInterval(() => { try { process.kill(suite, 0) } catch { process.exit(0) } }, 1000); setTimeout(() => process.exit(0), 3600000)`
  const stranger = spawn(process.execPath, ['-e', strangerCode, base], { cwd: base, detached: true, stdio: 'ignore', windowsHide: true, env: lib.childEnv() })
  stranger.unref()

  let current = null
  // The suite's own hold on the Agent API port, while the second copy starts (HI-2196).
  let held = null
  try {
    // --- 1. An agent whose command leaves a node running; the copy ended from outside while the agent runs.
    let node
    let runId
    let progressNode
    {
      current = await start()
      const { app, page, inv } = current
      await lib.openWorkspace(inv, page, ws)
      await lib.waitForProvider(inv)
      const agent = await lib.soloAgent(inv, proj, { name: 'Website' })
      const key = lib.ptyKey(proj, agent.id)
      const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)
      await inv('session:start', proj, { agentId: agent.id })
      await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), START_MS)
      const lingerFile = path.join(home, 'fake-linger.jsonl')
      await lib.sendPrompt(inv, key, 'linger 1', { submitted: async () => (await live())?.status === 'working' || pidsIn(lingerFile).length > 0 })
      await lib.until(async () => pidsIn(lingerFile).length === 1 && (await live())?.status === 'finished', START_MS)
      ;[node] = pidsIn(lingerFile)
      check('the agent left a node running, and still runs', !!node && lib.processRunning(node) && !!(await live()), String(node))
      // A command left running through cw-progress, as a test run is: cmd → cw-progress → a node. Started late, as on
      // a machine under load (#1100: the three processes took longer than the turn, and the marker missed them), and the
      // turn ends before it starts (#1134): the processes joining the launch's job have the marker written again, not
      // only at the next minute's heartbeat.
      const progressFile = path.join(home, 'fake-progress-linger.jsonl')
      fs.writeFileSync(path.join(home, 'fake-progress-delay-ms.txt'), '5000')
      await lib.sendPrompt(inv, key, 'progress-linger nowait', { submitted: async () => (await live())?.status === 'working' || pidsIn(progressFile).length > 0 })
      await lib.until(async () => pidsIn(progressFile).length === 1 && (await live())?.status === 'finished', START_MS)
      ;[progressNode] = pidsIn(progressFile)
      check('…and a node through cw-progress', !!progressNode && lib.processRunning(progressNode), String(progressNode))
      // The Agent API says whether a launch is still the agent's running one (#1008).
      runId = (await live())?.runId
      const launch = (run) => apiGet(`/v1/projects/site/agents/Website/launches/${encodeURIComponent(run)}`)
      const now = await launch(runId)
      const other = await launch('no-such-launch')
      check("the Agent API says the agent's launch runs, and another doesn't", !!runId && now.body?.running === true && other.body?.running === false, JSON.stringify([now, other]))
      const unknown = await apiGet('/v1/projects/site/agents/Nobody/launches/x')
      check('…and an agent it has not is 404', unknown.status === 404, JSON.stringify(unknown))
      const kept = await lib.until(() => marker()?.processes?.some((l) => l.agentId === agent.id && l.processes.some((p) => p.pid === node && /^\d+$/.test(p.created))), HUNG_MS)
      check("the running marker keeps what the agent's launch started, each process with its start time", !!kept, JSON.stringify(marker()?.processes))
      const keptRun = await lib.until(() => marker()?.processes?.some((l) => l.processes.some((p) => p.run === 'Left running' && p.parent > 0)) && marker()?.processes?.some((l) => l.processes.some((p) => p.pid === progressNode && p.parent > 0)), HUNG_MS)
      check("…the cw-progress run's own process with its title, and each process with its parent", !!keptRun, JSON.stringify(marker()?.processes))
      // The window's workspace is remembered as it opens (config.json), so the next start opens it again.
      await lib.until(() => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).windows?.some((w) => w.workspace?.toLowerCase() === ws.toLowerCase()), HUNG_MS)
      check('the copy is ended from outside', await endFromOutside(app, progressNode))
      current = null
    }
    check('the node keeps running after it', lib.processRunning(node) && lib.processRunning(progressNode))
    // The cw-progress run's processes as kept: all of them are stopped by Stop Them below, the run as a whole.
    const runPids = marker().processes.flatMap((l) => l.processes).filter((p) => p.pid !== node).map((p) => p.pid)
    // A kept record whose pid names another process now: the stranger's, with another start time.
    const left = marker()
    left.processes.push({ projectPath: proj, agentId: 'gone', agentName: 'Gone', processes: [{ pid: stranger.pid, name: 'node.exe', label: 'node old-server.js', created: '116444736000000000' }] })
    fs.writeFileSync(markerFile, JSON.stringify(left, null, 2))

    // --- 2. The next start: the notice says it still runs, with Stop Them; nothing stops on its own.
    {
      // The ended copy's Agent API socket is gone before the next copy listens on its port (HI-2193: once in 28 runs it
      // wasn't yet, and the next copy's API failed to start). If something keeps it, the check names what.
      check("the ended copy's Agent API port is free again", !!(await lib.until(apiPortFree, HUNG_MS)), portHolders())
      // HI-2196: held as the next copy starts (as the copy just ended may still hold it), the port is tried again after
      // the unexpected close, and the API listens once it is freed.
      const logFile = path.join(userData, 'logs', 'combwork.log')
      const logFrom = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0
      const newLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(logFrom) : '')
      held = net.createServer()
      await new Promise((r, j) => (held.once('error', j), held.listen(API_PORT, '127.0.0.1', r)))
      const starting = start()
      starting.catch(() => undefined)
      check('after the unexpected close, the next copy tries its port again while it is in use', !!(await lib.until(() => newLog().includes(`port ${API_PORT} is in use after an unexpected close`), START_MS)), newLog().split('\n').filter((l) => /\[servers\]/.test(l)).join(' | '))
      await new Promise((r) => held.close(r))
      held = null
      current = await starting
      check('…and its Agent API listens once the port is free', !!(await lib.until(() => new RegExp(`Agent API listening on 127\\.0\\.0\\.1:${API_PORT} after \\d+ tries`).test(newLog()), HUNG_MS)), newLog().split('\n').filter((l) => /\[servers\]/.test(l)).join(' | '))
      const { page, inv } = current
      const text = await lib.until(() => notice(page), START_MS)
      // The node, and the cw-progress run as one item named by its title (cmd, cw-progress and its node).
      const said = /(\d+) processes the agents started are still running: ([^\n]*)/.exec(text)
      check('the notice says Combwork closed unexpectedly, and what the agents started that is still running', !!said && /node [^,]*linger/.test(said[2]), text)
      check('…the cw-progress run as one item, named by its title, with how many of its processes run', !!said && /Left running \((\d+) processes\)/.test(said[2]) && Number(/Left running \((\d+)/.exec(said[2])[1]) >= 2 && !/(hive|cw)-progress|cmd /.test(said[2]), text)
      const launch = await apiGet(`/v1/projects/site/agents/Website/launches/${encodeURIComponent(runId)}`)
      check('the Agent API says the launch the run was started in has ended', launch.body?.running === false, JSON.stringify(launch))
      check("…not the stranger's process, whose pid a record names with another start time", !!text && !/old-server/.test(text), text)
      check('…with Stop Them', /Stop Them/.test(text), text)
      await page.screenshot({ path: path.join(lib.WORK, 'unexpectedclose-leftovers-notice.png') })
      check('Copy Diagnostics says how many the agents had started and how many still run', /the agents had started \d+ process\(es\), \d+ still running now/.test(await inv('app:diagnostics')))
      check('nothing is stopped on its own', lib.processRunning(node) && lib.processRunning(progressNode) && lib.processRunning(stranger.pid))
      await page.locator('.toast', { hasText: 'Combwork closed unexpectedly' }).getByRole('button', { name: 'Stop Them' }).click()
      check('Stop Them ends the node', !!(await lib.until(() => !lib.processRunning(node), HUNG_MS)))
      check("…and the cw-progress run's whole tree", !!(await lib.until(() => !runPids.some((p) => lib.processRunning(p)), HUNG_MS)), JSON.stringify(runPids.filter((p) => lib.processRunning(p))))
      check('…and says so', !!(await lib.until(async () => (await page.locator('.toast', { hasText: /Stopped \d+ processes/ }).count()) > 0, HUNG_MS)))
      check("the stranger's process still runs", lib.processRunning(stranger.pid))
      const quitting = await lib.quitWatch(current.app)
      await inv('app:quit').catch(() => undefined)
      check('the test copy quits', await quitting.gone(HUNG_MS))
      current = null
    }
  } catch (e) {
    check('no unexpected error', false, e?.stack ?? String(e))
  } finally {
    if (held) held.close()
    if (current) await current.app.close().catch(() => undefined)
    // Anything left of a copy this suite started, by its own pid and start time only, and the processes naming the
    // suite's folder (the node, the stranger), each ended as the process it was.
    for (const id of identities) lib.endTreeExactly(id)
    lib.stopProcessesIn(base, started)
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})()
