// Restarts announced and resumed (HI-1707), on fake Claude Code agents in a throwaway profile and workspace:
// 1. An installer's request to close (restart-request.json in the profile, for this copy's process): the agents that
//    were working, watching a card, and a running lane's builder and reviewer are told and recorded, Combwork acknowledges
//    and quits by itself. At the next start they resume in their conversations one at a time, each with a note of where
//    it was; the lane's card shows no stall meanwhile; an agent that never gets ready (fake-start-hold) is stopped and
//    reported before the next one starts; a request left from the earlier process is removed, never acted on.
// 2. Combwork ended from outside while an agent is starting: the next start resumes it once, and nothing else twice.
// 3. An ordinary quit: the next start offers to resume, and nothing resumes until Resume is chosen.
// 4. An offer left unanswered, then another quit with another agent working: one offer of both; Don't Resume resumes none.
// 5. Settings → Advanced → Resume agents after an update off: an install offers instead of resuming.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'restartresume-profile')
const claudeHome = path.join(lib.WORK, 'restartresume-claude-home')
const ws = path.join(lib.WORK, 'restartresume-ws')
const alpha = path.join(ws, 'alpha')
// A second workspace, in a window of its own.
const wsB = path.join(lib.WORK, 'restartresume-ws-b')
const beta = path.join(wsB, 'beta')
const PORT = Number(lib.port(47797))
const recordFile = path.join(userData, 'restart.json')
const requestFile = path.join(userData, 'restart-request.json')
const logFile = path.join(userData, 'logs', 'combwork.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const record = () => {
  try {
    return JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  } catch {
    return null
  }
}
const logLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : [])

// Playwright loses its connection to a copy that quit by itself or was ended from outside: not this suite's failure.
process.on('uncaughtException', (e) => {
  if (/Target page, context or browser has been closed|has been closed|Target crashed|ECONNRESET|EPIPE/.test(String(e?.message))) return
  console.error(e)
  process.exit(1)
})

let claudeEnv = null
const identities = []

/** Whether a process is running (signal 0 only checks). */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/**
 * Combwork's main process, as its running marker names it (process.pid in Combwork: what the installer finds, and what a request
 * must name). Playwright's launched process isn't always it.
 */
async function hivePid(launchedAt) {
  const m = await lib.until(() => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(userData, 'running.json'), 'utf8'))
      return r.pid && Date.parse(r.startedAt) >= launchedAt - 2000 ? r : null
    } catch {
      return null
    }
  }, HUNG_MS)
  return m?.pid ?? 0
}
/** Waits for a process to be gone. */
const gone = (pid) => lib.until(() => !alive(pid), HUNG_MS, 200)

/** Starts a copy of Combwork on the profile, its workspace restored. */
async function start() {
  const launchedAt = Date.now()
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off', ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  identities.push(...lib.identify([app.process().pid]))
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const token = () => JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', 'X-Combwork-Workspace': ws }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const pid = await hivePid(launchedAt)
  identities.push(...lib.identify([pid]))
  return { app, page, inv, api, live, pid }
}

/** Ends the copy from outside, as a kill would: its own process (by pid and start time) and what it started. */
async function endFromOutside(c) {
  const id = identities.find((i) => i.pid === c.pid)
  const ended = id ? lib.endTreeExactly(id) : 0
  return ended > 0 && !!(await gone(c.pid))
}

/** Quits the copy as the user does (no dialog: Confirm on quit is never), and waits for it to be gone. */
async function quit(c) {
  await c.app.close().catch(() => undefined)
  return !!(await gone(c.pid))
}

/** When a process started, as Windows says (the installer reads it the same way). */
function processStart(pid) {
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString('o')`], { env: { SystemRoot: root, windir: root, PSModulePath: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }, encoding: 'utf8', windowsHide: true })
  return r.stdout.trim()
}

/** The installer's request, as hiveAskToClose.ps1 writes it, for a copy's process: written beside, then renamed. */
function writeRequest(pid, nonce) {
  const text = JSON.stringify({ v: 1, nonce, pid, pidCreated: processStart(pid), exe: lib.ELECTRON, reason: 'install', at: new Date().toISOString() })
  fs.writeFileSync(`${requestFile}.tmp`, text)
  fs.renameSync(`${requestFile}.tmp`, requestFile)
}

/** The first prompt of the agent's conversation now (the note a resume gives, as its CLI took it). */
async function notes(c, id, project = alpha) {
  const s = (await c.inv('session:live')).find((x) => x.projectPath.toLowerCase() === project.toLowerCase() && x.agentId === id)
  if (!s?.sessionId) return []
  const t = await c.inv('transcript:read', project, s.sessionId).catch(() => null)
  return (t?.items ?? []).filter((x) => x.kind === 'user' && /^\[CW\] Combwork (restarted|was quit)/.test(x.text ?? '')).map((x) => x.text)
}
/** A notice's text in whichever window shows it (a notice goes to one window of several), and that window. */
async function anyToast(c, re) {
  for (const p of c.app.windows()) {
    const text = await toastText(p, re).catch(() => '')
    if (text) return { page: p, text }
  }
  return null
}
/** Clicks a notice's button in the window that shows it; a check fails when no window shows the notice. */
async function clickToast(c, title, button) {
  const found = await lib.until(() => anyToast(c, new RegExp(title.replace(/[?()]/g, '\\$&'))), HUNG_MS)
  check(`a notice "${title}" to click ${button} on`, !!found)
  if (found) await found.page.locator('.toast', { hasText: title }).first().getByRole('button', { name: button, exact: true }).click()
}
const toastText = (page, re) => page.evaluate((src) => [...document.querySelectorAll('.toast')].map((t) => t.innerText).find((t) => new RegExp(src).test(t)) ?? '', re.source)

;(async () => {
  for (const d of [userData, ws, wsB]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha, beta])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  let c = null
  const agents = {}
  try {
    // --- 1. An installer's request: told, recorded, quit by itself; resumed one at a time at the next start.
    c = await start()
    await lib.openWorkspace(c.inv, c.page, ws)
    await c.page.getByText('alpha', { exact: true }).first().click()
    await lib.waitForProvider(c.inv)
    for (const name of ['Worker', 'Watcher', 'Builder', 'Reviewer']) agents[name] = await lib.addAgent(c.inv, alpha, { name })
    const say = (a, text) => lib.sendPrompt(c.inv, lib.ptyKey(alpha, a.id), text, { submitted: async () => ['working', 'watching'].includes((await c.live(a.id))?.status) })
    for (const a of Object.values(agents)) await c.inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await lib.until(async () => (await Promise.all(Object.values(agents).map((a) => c.live(a.id)))).every((s) => s?.status === 'ready'), HUNG_MS, 300)))
    const watched = (await c.inv('tasks:create', { title: 'Watched card', project: 'alpha', column: 'doing', agent: agents.Worker.id })).number
    const laneCard = (await c.inv('tasks:create', { title: 'Lane card', project: 'alpha', column: 'doing', agent: agents.Builder.id })).number
    const laneKey = (await c.inv('tasks:list')).find((t) => t.number === laneCard)?.key ?? `#${laneCard}`
    const lane = await c.api('POST', '/v1/lanes', { project: 'alpha', builder: 'Builder', reviewer: 'Reviewer', name: 'restart lane', cards: [laneCard] })
    check('a lane runs, Builder and Reviewer its agents', lane.status === 200, JSON.stringify(lane))
    await say(agents.Worker, 'holduntil go-worker')
    await say(agents.Watcher, `cw cw_wait_for_tasks {"cards":[${watched}],"wake":true,"limitMinutes":60}`)
    check('Worker works and Watcher watches its card', !!(await lib.until(async () => (await c.live(agents.Worker.id))?.status === 'working' && (await c.live(agents.Watcher.id))?.status === 'watching', HUNG_MS, 300)))
    // A second workspace in a window of its own, its agent working too.
    const nextWindow = c.app.waitForEvent('window')
    await c.inv('window:new')
    const pageB = await nextWindow
    await pageB.waitForLoadState('domcontentloaded')
    await lib.appReady(pageB)
    const invB = (ch, ...a) => pageB.evaluate(([x, y]) => window.combwork.invoke(x, ...y), [ch, a])
    await lib.openWorkspace(invB, pageB, wsB)
    agents.Other = await lib.addAgent(invB, beta, { name: 'Other' })
    const liveOther = async () => (await c.inv('session:live')).find((s) => s.projectPath.toLowerCase() === beta.toLowerCase() && s.agentId === agents.Other.id)
    await invB('session:start', beta, { agentId: agents.Other.id })
    await lib.until(async () => (await liveOther())?.status === 'ready', HUNG_MS, 300)
    await lib.sendPrompt(invB, lib.ptyKey(beta, agents.Other.id), 'holduntil go-other', { submitted: async () => (await liveOther())?.status === 'working' })
    check('a second workspace, in a window of its own, has Other working', (await liveOther())?.status === 'working')
    // At the next start resumes have 10 s to be ready (Watcher won't be: below).
    await c.inv('advanced:set', 'cw.restart.resumeReadySeconds', 10)
    const firstPid = c.pid
    const nonce = '6f1c8b2e-0a43-4d6e-9b5a-3c2d1e0f9a87'
    writeRequest(firstPid, nonce)
    const quitByItself = await gone(firstPid)
    check('the installer asks Combwork to close: it acknowledges, and quits by itself', !!quitByItself && fs.existsSync(path.join(userData, `restart-ack-${nonce}.json`)))
    c = null
    const rec = record()
    const entries = Object.fromEntries((rec?.entries ?? []).map((e) => [e.agentName, e]))
    check('the record is an install, with the four pending', rec?.reason === 'install' && ['Worker', 'Watcher', 'Builder', 'Reviewer'].every((n) => entries[n]?.state === 'pending'), JSON.stringify(rec))
    check('…and Other, of the second workspace', entries.Other?.state === 'pending' && entries.Other?.workspace?.toLowerCase() === wsB.toLowerCase(), JSON.stringify(entries.Other))
    check('…Watcher watching, Builder and Reviewer in the lane, on its card', entries.Watcher?.status === 'watching' && entries.Builder?.lane?.role === 'builder' && entries.Reviewer?.lane?.role === 'reviewer' && entries.Builder?.card?.label === laneKey, JSON.stringify([entries.Watcher, entries.Builder]))

    // The next start: Watcher never gets ready (its CLI holds before its session), and resumes have 10 s to be ready.
    fs.writeFileSync(path.join(claudeHome, 'fake-start-hold-Watcher'), '')
    // A request left from the earlier process: removed, never acted on.
    writeRequest(firstPid, '7a2d9c3b-1b54-4e7f-8c6b-4d3e2f1a0b98')
    const before = logLines().length
    c = await start()
    check("the earlier process's request is removed, and Combwork runs on", !!(await lib.until(() => !fs.existsSync(requestFile), HUNG_MS)) && logLines().slice(before).some((l) => /Removed an installer's request to close: (for another process|for an earlier process|stale)/.test(l)))
    // Builder isn't running yet as the others resume first: its lane card shows no stall meanwhile.
    let unstalledWhileWaiting = null
    let stallSeen = ''
    await lib.until(async () => {
      if (await c.live(agents.Builder.id)) return true
      const card = await c.api('GET', `/v1/tasks/${laneCard}`)
      if (card.status === 200) {
        if (card.body?.stalled) stallSeen = card.body.stalled
        unstalledWhileWaiting = (unstalledWhileWaiting ?? true) && !card.body?.stalled
      }
      return false
    }, HUNG_MS, 200)
    check("the lane's card shows no stall while Builder waits to resume", unstalledWhileWaiting === true, `${unstalledWhileWaiting}: ${stallSeen}`)
    check('Worker, Builder and Reviewer resume in their conversations', !!(await lib.until(async () => (await Promise.all(['Worker', 'Builder', 'Reviewer'].map((n) => c.live(agents[n].id)))).every((s) => s && s.status !== 'starting'), HUNG_MS, 300)))
    for (const n of ['Worker', 'Builder', 'Reviewer']) check(`…${n} in the conversation it had`, (await c.live(agents[n].id))?.sessionId === entries[n].sessionId)
    const workerNote = (await lib.until(async () => (await notes(c, agents.Worker.id))[0], HUNG_MS)) ?? ''
    check("Worker's note says it restarted for an update, and when", /^\[CW\] Combwork restarted for an update.* at \d\d:\d\d UTC; your session was stopped and is resumed now\./.test(workerNote), workerNote)
    const builderNote = (await lib.until(async () => (await notes(c, agents.Builder.id))[0], HUNG_MS)) ?? ''
    check("Builder's note names its card, round and lane, and to re-arm its watch", builderNote.includes(`You were on ${laneKey}, round 1, in lane 'restart lane' (its builder).`) && builderNote.includes('re-arm your card watch'), builderNote)
    // Other, in the second workspace's window (restored with the first), resumes too: Watcher's failure holds up no one.
    const otherNote = (await lib.until(async () => (await notes(c, agents.Other.id, beta))[0], HUNG_MS)) ?? ''
    check("Other resumes in the second workspace, in its conversation, with its note", otherNote.startsWith('[CW] Combwork restarted for an update') && (await c.inv('session:live')).find((s) => s.agentId === agents.Other.id)?.sessionId === entries.Other?.sessionId, otherNote)
    const report = await lib.until(async () => {
      for (const p of c.app.windows()) {
        const t = await toastText(p, /Resumed 4 agents after the update/).catch(() => '')
        if (t) return t
      }
      return ''
    }, HUNG_MS)
    check('one notice says what was resumed, and that Watcher was stopped, not ready in time', !!report && report.includes("Not resumed: Watcher (alpha): it didn't get ready in time, so it was stopped."), report)
    // One at a time: each agent's launch after the one before it was resumed or stopped. The queue's order is the record's
    // (the live sessions' order as Combwork closed), which isn't the suite's to fix: the lane's start above gives the idle
    // Builder a new conversation (HI-2232), so it comes after Reviewer now. So taken in the order they were launched.
    const lines = logLines().slice(before)
    const at = (re) => lines.findIndex((l) => re.test(l))
    const spawned = (a) => at(new RegExp(`\\[pty\\] spawn .*#${a.id}`))
    const settledAt = (n) => {
      const resumed = at(new RegExp(`Resumed .*${n}.* after Combwork restarted`))
      return resumed >= 0 ? resumed : at(new RegExp(`${n}.* wasn't ready within`))
    }
    const order = ['Worker', 'Watcher', 'Builder', 'Reviewer'].sort((a, b) => spawned(agents[a]) - spawned(agents[b]))
    const serial = order.every((n) => spawned(agents[n]) >= 0) && order.slice(1).every((n, i) => settledAt(order[i]) >= 0 && spawned(agents[n]) > settledAt(order[i]))
    check('…one at a time: each started after the one before it was resumed, or stopped', serial, JSON.stringify(order.map((n) => [n, spawned(agents[n]), settledAt(n)])))
    check('Watcher was stopped, not left starting', !(await c.live(agents.Watcher.id)))
    check('every agent was told before the quit (its inbox has the line)', (await Promise.all(order.map(async (n) => (await c.api('GET', `/v1/projects/alpha/agents/${n}/deliveries?limit=50`)).body?.deliveries?.some((d) => /Combwork is restarting for an update/.test(d.text ?? d.body ?? ''))))).every(Boolean))
    check('the record is gone: every entry has its outcome', !!(await lib.until(() => !fs.existsSync(recordFile), HUNG_MS)), JSON.stringify(record()))

    // --- 2. Ended from outside while an agent is starting: resumed once at the next start, nothing else twice.
    // Resumes have long enough again: Worker, held below, is still starting when Combwork is ended.
    await c.inv('advanced:set', 'cw.restart.resumeReadySeconds', 90)
    // Worker working again; a close for an install records it (and the lane's two); then it is held at its next resume.
    await lib.sendPrompt(c.inv, lib.ptyKey(alpha, agents.Worker.id), 'holduntil go-worker-2', { submitted: async () => (await c.live(agents.Worker.id))?.status === 'working' })
    writeRequest(c.pid, '8b3e0d4c-2c65-4f80-9d7c-5e4f3a2b1c09')
    check('Combwork quits by itself for the install', !!(await gone(c.pid)))
    c = null
    fs.writeFileSync(path.join(claudeHome, 'fake-start-hold-Worker'), '')
    c = await start()
    check('Worker is starting (its CLI held)', !!(await lib.until(async () => (await c.live(agents.Worker.id))?.status === 'starting' && record()?.entries?.find((e) => e.agentName === 'Worker')?.state === 'starting', HUNG_MS, 200)), JSON.stringify(record()))
    check('Combwork is ended from outside meanwhile', await endFromOutside(c))
    c = null
    const midway = logLines().length
    c = await start()
    check('the next start resumes Worker, once', !!(await lib.until(async () => (await c.live(agents.Worker.id))?.status && (await c.live(agents.Worker.id)).status !== 'starting', HUNG_MS, 300)))
    const resumedLines = () => logLines().slice(midway).filter((l) => /Resumed .*Worker.* after Combwork restarted/.test(l)).length
    await lib.until(() => resumedLines() >= 1 && !fs.existsSync(recordFile), HUNG_MS)
    check('…its resume logged once since', resumedLines() === 1, String(resumedLines()))

    // --- 3. An ordinary quit: offered at the next start, nothing resumed until Resume. The lane's agents and Other
    // stopped first, so Worker is the one working.
    // Once this start's resumes have their outcomes (the record gone), the others are stopped. Other, of the second
    // workspace, runs here when the install recorded it (still on its note, on a slow machine) and this start resumed it
    // (not the one ended from outside, as the record's order has it): it may still be working on its note or the
    // install's line when the test quits, and the quit then records it too (HI-2202).
    check('the queue settles', !!(await lib.until(() => !fs.existsSync(recordFile), HUNG_MS)), JSON.stringify(record()))
    const liveAny = async (project, id) => (await c.inv('session:live')).find((s) => s.projectPath.toLowerCase() === project.toLowerCase() && s.agentId === id)
    console.log(`INFO Other ${(await liveAny(beta, agents.Other.id)) ? 'runs: stopped' : "doesn't run"} before the quit`)
    const others = ['Watcher', 'Builder', 'Reviewer']
    for (const n of others) await c.inv('session:stop', alpha, agents[n].id)
    // The second workspace's window stops Other (a window's calls are its own workspace's).
    for (const p of c.app.windows()) await p.evaluate(([x, id]) => window.combwork.invoke('session:stop', x, id), [beta, agents.Other.id]).catch(() => undefined)
    check('Watcher, Builder, Reviewer and Other are stopped', !!(await lib.until(async () => (await Promise.all([...others.map((n) => c.live(agents[n].id)), liveAny(beta, agents.Other.id)])).every((s) => !s), HUNG_MS, 300)))
    await lib.sendPrompt(c.inv, lib.ptyKey(alpha, agents.Worker.id), 'holduntil go-worker-3', { submitted: async () => (await c.live(agents.Worker.id))?.status === 'working' })
    check('Combwork quits', await quit(c))
    c = null
    check('the quit recorded Worker alone, and the record is a quit', record()?.reason === 'quit' && record()?.entries?.length === 1 && record()?.entries?.[0]?.agentName === 'Worker' && record()?.entries?.[0]?.state === 'pending', JSON.stringify(record()))
    c = await start()
    const offer = await lib.until(async () => (await anyToast(c, /Resume the agent that was working\?/))?.text, HUNG_MS)
    check('the next start offers to resume Worker', !!offer && /Combwork was quit while they were working or in a card loop: Worker \(alpha\)/.test(offer), offer)
    check('…and resumes nothing meanwhile (the record has it offered)', record()?.entries?.find((e) => e.agentName === 'Worker')?.state === 'offered' && !(await c.live(agents.Worker.id)), JSON.stringify(record()))
    await clickToast(c, 'Resume the agent that was working?', 'Resume')
    check('Resume resumes it, its note saying Combwork was quit', !!(await lib.until(async () => ((await notes(c, agents.Worker.id)).at(-1) ?? '').startsWith('[CW] Combwork was quit and started again'), HUNG_MS)))

    // --- 4. An offer left unanswered, then another quit with Builder working too: one offer of both; Don't Resume.
    await lib.sendPrompt(c.inv, lib.ptyKey(alpha, agents.Worker.id), 'holduntil go-worker-4', { submitted: async () => (await c.live(agents.Worker.id))?.status === 'working' })
    check('Combwork quits again', await quit(c))
    c = null
    c = await start()
    await lib.until(async () => (await anyToast(c, /Resume the agent that was working\?/))?.text, HUNG_MS)
    await c.inv('session:start', alpha, { agentId: agents.Builder.id }).catch(() => undefined)
    await lib.until(async () => (await c.live(agents.Builder.id))?.status === 'ready', HUNG_MS, 300)
    await lib.sendPrompt(c.inv, lib.ptyKey(alpha, agents.Builder.id), 'holduntil go-builder', { submitted: async () => (await c.live(agents.Builder.id))?.status === 'working' })
    check('Combwork quits with the offer unanswered', await quit(c))
    c = null
    c = await start()
    const both = await lib.until(async () => (await anyToast(c, /Resume the 2 agents that were working\?/))?.text, HUNG_MS)
    check('the next start offers both: the earlier offer kept, Builder added', !!both && both.includes('Worker (alpha)') && both.includes('Builder (alpha)'), both)
    await clickToast(c, 'Resume the 2 agents that were working?', "Don't Resume")
    check("Don't Resume resumes neither, and the record is gone", !!(await lib.until(() => !fs.existsSync(recordFile), HUNG_MS)) && !(await c.live(agents.Worker.id)) && !(await c.live(agents.Builder.id)))

    // --- 5. Resume agents after an update off: an install offers instead.
    await c.inv('advanced:set', 'cw.restart.resumeAfterUpdate', false)
    await c.inv('session:start', alpha, { agentId: agents.Worker.id })
    await lib.until(async () => (await c.live(agents.Worker.id))?.status === 'ready', HUNG_MS, 300)
    await lib.sendPrompt(c.inv, lib.ptyKey(alpha, agents.Worker.id), 'holduntil go-worker-5', { submitted: async () => (await c.live(agents.Worker.id))?.status === 'working' })
    writeRequest(c.pid, '9c4f1e5d-3d76-4091-8e8d-6f5a4b3c2d10')
    check('Combwork quits by itself for the install (the switch off)', !!(await gone(c.pid)))
    c = null
    c = await start()
    const offered = await lib.until(async () => (await anyToast(c, /Resume the agent that was working\?/))?.text, HUNG_MS)
    check('with the switch off, an install offers to resume, saying it was an update', !!offered && /Combwork restarted for an update while they were working or in a card loop: Worker \(alpha\)/.test(offered) && !(await c.live(agents.Worker.id)), offered)
  } catch (e) {
    check('no error', false, e?.stack ?? String(e))
  } finally {
    if (c) await quit(c).catch(() => undefined)
    // Whatever of this suite's copies still runs (a step that failed midway): ended, by pid and start time.
    for (const id of identities) if (alive(id.pid)) lib.endTreeExactly(id)
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})()
