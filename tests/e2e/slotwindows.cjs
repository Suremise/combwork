// Slot writers with two workspaces open through a quit (HI-2299): after an update restart, a second workspace's slots
// stayed held by the gone Hive's ended runs, its window closed first and their releases tried after its workspace had
// closed ("No workspace is open"). Window 1 has workspace A (alpha: B1 in slot-a, S1 in slot-b), window 2 workspace B
// (beta: C1 in slot-a), each lent through `slots:test`, as a card's start does:
// 1. S1 leaves a process running (a real survivor) and is stopped; it's kept running.
// 2. B is closed (Close Workspace, as Darren did) and reopened with no quit: C1's release was written while B was still
//    open (no "wasn't released"), and its slot-a is free. C1 runs there again, and window 2 (not the last) is closed
//    first: the same.
// 3. Hive quits; the next start opens A: B1's slot-a comes back free, S1's slot-b stays held (its process still runs).
// 4. B is opened later, in a second window: C1's slot-a is free with no question (no writer, nothing to release).
// A stopped run's release waits for its job to be seen empty (about 2 s), so a close that doesn't wait races it. The
// agents run the fake Claude Code. Dev build only (slots:test). Throwaway profile, workspaces and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const at = (x) => path.join(lib.WORK, `slotwindows-${x}`)
const userData = at('profile')
const wsA = at('ws-a')
const wsB = at('ws-b')
const home = at('claude-home')
const alpha = path.join(wsA, 'alpha')
const beta = path.join(wsB, 'beta')
const slotsOf = (ws, p) => ['slot-a', 'slot-b'].map((s) => path.join(`${ws}.worktrees`, p, s))
const PORT = Number(lib.port(47821))
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const invOn = (page) => (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
const logText = () => {
  try {
    return fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')
  } catch {
    return ''
  }
}

;(async () => {
  for (const d of [userData, wsA, wsB, `${wsA}.worktrees`, `${wsB}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  const env = lib.fakeClaude(userData, home, [alpha, beta, wsA, wsB, ...slotsOf(wsA, 'alpha'), ...slotsOf(wsB, 'beta')])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const start = async () => {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, wsA)
  }
  /** A second window, on workspace B. */
  const openB = async () => {
    const next = h.app.waitForEvent('window')
    await h.inv('window:new')
    const p = await next
    await p.waitForLoadState('domcontentloaded')
    await lib.appReady(p)
    p.on('pageerror', (e) => check('no page errors (window 2)', false, e.message))
    await lib.openWorkspace(invOn(p), p, wsB)
    return p
  }
  const until = (fn, ms) => lib.until(fn, ms, 250)
  const live = async (inv, project, id) => (await inv('session:live')).find((s) => same(s.projectPath, project) && s.agentId === id) ?? null
  const idle = async (inv, project, id) => ['ready', 'finished'].includes((await live(inv, project, id))?.status)
  const slot = async (inv, project, name) => (await inv('slots:list', project)).find((s) => s.name === name)
  const agentInfo = async (inv, project, id) => (await inv('workspace:refresh')).projects.find((p) => same(p.path, project))?.agents.find((a) => a.id === id)
  /** Lent `name` for a card and started there, idle. */
  const runIn = async (inv, project, agent, card, name) => {
    const lent = await inv('slots:test', project, { op: 'lend', agent: agent.id, card })
    check(`#${card} is lent ${name} for ${agent.name}`, lent?.ok && lent.slot.name === name, JSON.stringify(lent))
    await inv('session:start', project, { agentId: agent.id })
    const s = await until(async () => ((await idle(inv, project, agent.id)) ? live(inv, project, agent.id) : null), HUNG_MS)
    check(`${agent.name} runs in ${name}`, s?.slot === name, JSON.stringify(s))
    return s
  }
  /** S1's lingering node, by pid and start time: ended at the end. */
  const kept = []

  try {
    await start()
    const invA = h.inv
    const b1 = await lib.addAgent(invA, alpha, { name: 'B1', workflowRole: 'builder' })
    const s1 = await lib.addAgent(invA, alpha, { name: 'S1', workflowRole: 'builder' })
    let p2 = await openB()
    let invB = invOn(p2)
    const c1 = await lib.addAgent(invB, beta, { name: 'C1', workflowRole: 'builder' })
    const runB1 = await runIn(invA, alpha, b1, 12, 'slot-a')
    const runS1 = await runIn(invA, alpha, s1, 13, 'slot-b')
    const runC1 = await runIn(invB, beta, c1, 21, 'slot-a')

    // --- 1. S1 leaves a process running and is stopped: kept running, its writer stays.
    const lingerFile = path.join(home, 'fake-linger.jsonl')
    const lingering = () => (fs.existsSync(lingerFile) ? fs.readFileSync(lingerFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])
    await lib.sendPrompt(invA, lib.ptyKey(alpha, s1.id), 'linger 1', { submitted: async () => (await live(invA, alpha, s1.id))?.status === 'working' || lingering().length > 0 })
    check('S1 leaves a process running', !!(await until(async () => lingering().length === 1 && (await idle(invA, alpha, s1.id)), HUNG_MS)))
    kept.push(...lib.identify(lingering()))
    await invA('session:stop', alpha, s1.id)
    check('…stopped, its leftover listed', !!(await until(async () => !(await live(invA, alpha, s1.id)) && (await invA('session:leftovers')).some((l) => l.agentId === s1.id), HUNG_MS)))
    await invA('session:settleLeftovers', alpha, s1.id, 'keep')

    // --- 2. B closed (Close Workspace, no card in flight) and reopened in the same Hive: C1's release was written while
    // B was open, and its slot-a is free again.
    /** How the run's release went, once the log says: 'released', 'failed' (its workspace closed first), or null. */
    const releaseOf = (run) => {
      const text = logText()
      return text.includes(`The slot writer ${run} wasn't released`) ? 'failed' : text.includes(`The slot writer ${run} was released`) ? 'released' : null
    }
    const releaseLines = (run) => logText().split('\n').filter((l) => l.includes(`slot writer ${run}`) || l.includes('closing ')).join(' | ')
    check('B closes', (await invB('workspace:close')) !== false)
    const closedRelease = await until(() => releaseOf(runC1.runId), HUNG_MS)
    check("C1's release was written before B closed (not \"wasn't released\")", closedRelease === 'released', releaseLines(runC1.runId))
    await lib.openWorkspace(invB, p2, wsB)
    check("reopened without a quit, C1's slot-a is free: no writer, still lent to #21", !!(await until(async () => {
      const s = await slot(invB, beta, 'slot-a')
      return s && !s.writer && s.lease?.card === 21
    }, HUNG_MS)), JSON.stringify(await slot(invB, beta, 'slot-a')))
    await invB('session:start', beta, { agentId: c1.id })
    const runC1b = await until(async () => ((await idle(invB, beta, c1.id)) ? live(invB, beta, c1.id) : null), HUNG_MS)
    check('C1 starts in slot-a again', runC1b?.slot === 'slot-a' && runC1b.runId !== runC1.runId, JSON.stringify(runC1b))

    // --- 2b. Window 2 closed first (not the last): C1 stops, and its release is written while B is open.
    const closed = p2.waitForEvent('close', { timeout: HUNG_MS }).then(() => true, () => false)
    await h.app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle().includes(title))?.close(), path.basename(wsB))
    check('window 2 closes', await closed)
    check('…one window left', !!(await until(async () => (await invA('window:count')) === 1, HUNG_MS)))
    const windowRelease = await until(() => releaseOf(runC1b.runId), HUNG_MS)
    check("…C1's release written before its window's workspace closed", windowRelease === 'released', releaseLines(runC1b.runId))

    // --- 3. Hive quits (B1 still running); the next start opens A.
    await h.app.close()
    h = null
    await start()
    const invA2 = h.inv
    check("B1's slot-a comes back free: no writer, still lent to #12", !!(await until(async () => {
      const s = await slot(invA2, alpha, 'slot-a')
      return s && !s.writer && s.lease?.card === 12
    }, HUNG_MS)), JSON.stringify(await slot(invA2, alpha, 'slot-a')))
    check("S1's slot-b stays held: its process still runs", !!(await until(async () => (await slot(invA2, alpha, 'slot-b'))?.writer?.held === true && (await invA2('slots:heldWriter', alpha, 'slot-b'))?.run === runS1.runId, HUNG_MS)), JSON.stringify(await slot(invA2, alpha, 'slot-b')))
    check('…named on S1 (Release Slot…)', !!(await until(async () => (await agentInfo(invA2, alpha, s1.id))?.heldSlot === 'slot-b', HUNG_MS)))
    check('B1 starts in slot-a', (await runIn(invA2, alpha, b1, 12, 'slot-a'))?.runId !== runB1.runId)

    // --- 4. B opened later, in a second window: C1's slot-a is free with no question.
    p2 = await openB()
    invB = invOn(p2)
    check("C1's slot-a is free when B is opened after the start: no writer, still lent to #21", !!(await until(async () => {
      const s = await slot(invB, beta, 'slot-a')
      return s && !s.writer && s.lease?.card === 21
    }, HUNG_MS)), JSON.stringify(await slot(invB, beta, 'slot-a')))
    check('…nothing offered to release on C1', !(await agentInfo(invB, beta, c1.id))?.heldSlot)
    await invB('session:start', beta, { agentId: c1.id })
    const s5 = await until(async () => ((await idle(invB, beta, c1.id)) ? live(invB, beta, c1.id) : null), HUNG_MS)
    check('C1 starts in slot-a', s5?.slot === 'slot-a', JSON.stringify(s5))
  } finally {
    await h?.app.close().catch(() => undefined)
    lib.endExactly(kept)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
