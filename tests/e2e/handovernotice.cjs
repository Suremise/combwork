// The long-conversation notice's Hand Over (#1057, Darren's choice for 0.9.0), on fake Claude Code agents. Past
// Settings → Sessions → Warn when a transcript is over, the notice informs, and offers Hand Over to… only while the agent
// may end its conversation now:
// - Idle, on no lane: Hand Over to…, which opens the dialog with the agent itself chosen.
// - Working (HI-1695): no notice until its turn ends, the footer's size saying it can hand over when it has finished and
//   opening nothing, the Agent API refusing a hand-over to itself (409); its turn over, the notice, with Hand Over to….
// - The idle builder of a running lane: nothing to click, only that it can hand over when it has finished.
// - A notice made while idle, clicked once the agent is on a lane: no dialog, a notice that it is busy; Hand Over to…
//   (⋯) doesn't offer the agent itself.
// - Hand Over to… itself, checked again before the conversation ends: the merge slot taken, or other work begun, while
//   it writes its handover, and its conversation isn't ended; otherwise it carries on in a new conversation.
// Screenshots of the notice in both states, in both themes. The fake CLI can't write a handover with Combwork's tools, so
// the test writes it, with the agent's session in its header, once Combwork has asked. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'handovernotice-profile')
const ws = path.join(lib.WORK, 'handovernotice-ws')
const claudeHome = path.join(lib.WORK, 'handovernotice-claude-home')
const shots = path.join(lib.WORK, 'handovernotice-shots')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47827))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const hdir = path.join(ws, '.combwork', 'shared', 'handovers')
  fs.mkdirSync(hdir, { recursive: true })
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off', ...lib.fakeClaude(userData, claudeHome, [alpha]) })
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.sessions = { ...cfg.settings.sessions, transcriptWarnMB: 1 }
  // The Agent API's hand-over (the refusal checked below) is session input.
  cfg.settings.agentApi = { ...cfg.settings.agentApi, allowSessionInput: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    await lib.waitForProvider(inv)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const idle = await lib.addAgent(inv, alpha, { name: 'Idle' })
    const busy = await lib.addAgent(inv, alpha, { name: 'Busy' })
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const staleAgent = await lib.addAgent(inv, alpha, { name: 'Stale' })
    await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    await lib.addAgent(inv, alpha, { name: 'Checker', workflowRole: 'reviewer' })
    const running = [idle, busy, builder, staleAgent]
    for (const a of running) await inv('session:start', alpha, { agentId: a.id })
    const statuses = async () => (await Promise.all(running.map((a) => live(a.id)))).map((s) => s?.status)
    check('the agents start', !!(await lib.until(async () => (await statuses()).every((s) => s === 'ready'), HUNG_MS, 300)), JSON.stringify(await statuses()))
    const say = async (a, text) => lib.sendPrompt(inv, lib.ptyKey(alpha, a.id), text, { submitted: async () => (await live(a.id))?.status === 'working' })
    const toastOf = (name) => page.locator('.toast', { hasText: `${name}: long conversation` })
    const footerOf = (name) => page.locator('.agent-pane', { has: lib.paneHeader(page, name) }).locator('.pane-footer-bar .foot-transcript')
    const dialog = page.locator('.dialog', { hasText: 'Hand over' })
    const selfChoice = dialog.locator('label.choice', { hasText: 'in a new conversation' })
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        // The notices fully shown (not fading in).
        await lib.until(async () => (await page.locator('.toast').evaluateAll((els) => els.every((e) => getComputedStyle(e).opacity === '1'))), HUNG_MS, 100)
        await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
    }
    const api = async (token, method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const make = async (title, column, agent) => (await inv('tasks:create', { title, project: 'alpha', column, agent })).number
    const lanes = async () => inv('lanes:list')
    /**
     * A lane started through the Agent API for an idle builder outside slots, which Combwork gives it in a new conversation
     * whose first turn is the lane's brief (HI-2232). Quiet first (idle, nothing of Combwork's being typed into it or waiting
     * to be), so it is renewed at once, never left as it is mid-turn nor owed; then `renewed` once its new conversation has
     * had its brief's turn and is quiet again, before the suite types into it (HI-2251; quiet alone isn't that turn over:
     * HI-2350, lib.laneBriefDone).
     */
    const quiet = async (a) => lib.agentQuiet(PORT, 'alpha', await live(a.id), workspaceToken)
    const laneOf = async (a, body) => {
      if (!(await lib.until(() => quiet(a), HUNG_MS, 200))) return { status: 0, body: `${a.name} wasn't quiet before its lane`, renewed: false, now: JSON.stringify(await live(a.id)) }
      const before = (await live(a.id))?.sessionId
      const r = await api(workspaceToken, 'POST', '/v1/lanes', body)
      const renewed = !!(await lib.until(async () => lib.laneBriefDone(PORT, 'alpha', await live(a.id), before, workspaceToken), HUNG_MS, 200))
      return { ...r, renewed, now: JSON.stringify(await live(a.id)) }
    }
    /**
     * Crosses the limit while idle (HI-1670): the transcript grows during the fake's turn, and Combwork's 5-second look could
     * make the notice then (working: no button). So the limit is off (Never) while it pads, and back at 1 MB once its turn
     * is over: the next look makes the notice, the agent idle. Its own turn (a new one) over, with the transcript past
     * 1 MB as Combwork's look read it: the pad taken, not another turn's end (HI-2350).
     */
    const pad = async (a) => {
      await inv('settings:update', { sessions: { transcriptWarnMB: 0 } })
      try {
        const turnBefore = (await live(a.id))?.turn?.id
        await lib.sendPrompt(inv, lib.ptyKey(alpha, a.id), 'pad 1200', {
          submitted: async () => {
            const s = await live(a.id)
            return !!s?.turn?.id && s.turn.id !== turnBefore
          }
        })
        return await lib.until(async () => {
          const s = await live(a.id)
          return s?.status === 'finished' && !!s.turn?.id && s.turn.id !== turnBefore && s.turn.state === 'over' && (s.transcriptBytes ?? 0) > 1024 * 1024
        }, HUNG_MS, 300)
      } finally {
        await inv('settings:update', { sessions: { transcriptWarnMB: 1 } })
      }
    }
    // The handover the agent is asked for, written as cw_create_handover would (its session in the header).
    let written = 0
    const writeHandover = (name, sessionId) => fs.writeFileSync(path.join(hdir, `2026-10-18-alpha-${name.toLowerCase()}-${++written}.md`), `# ${name}'s work\n\n- **Project:** alpha\n- **Session:** ${sessionId}\n\nCarry on.\n`)
    const writing = (name) => page.locator('.toast', { hasText: `${name} is writing a handover` })
    /** A hand-over of the agent to itself with a new handover, as Hand Over to… starts it: its outcome, once it settles. */
    const handOverSelf = (a) => inv('session:handOver', alpha, a.id, a.id, { handover: true }).then(() => 'ok', (e) => String(e?.message ?? e))
    const asked = async (a) => lib.until(async () => /Please write a handover/.test(lib.plainText(await inv('pty:buffer', lib.ptyKey(alpha, a.id)).catch(() => ''))) && (await live(a.id))?.status === 'finished', HUNG_MS, 300)

    // --- Idle, on no lane: Hand Over to…, which opens the dialog with the agent itself chosen.
    check('Idle crosses the limit', !!(await pad(idle)))
    const idleToast = toastOf('Idle')
    check('idle: the notice says so', !!(await lib.until(async () => (await idleToast.count()) === 1, HUNG_MS, 200)))
    const idleText = await idleToast.innerText().catch(() => '')
    check('…informing, with Hand Over to…', /over 1 MB\): it may slow down/.test(idleText) && /Hand Over to…/.test(idleText), idleText)
    await shoot('notice-idle')
    await idleToast.getByRole('button', { name: 'Hand Over to…', exact: true }).click()
    check('…which opens Hand Over to…, the agent itself chosen', !!(await lib.until(async () => (await dialog.count()) === 1 && ((await selfChoice.getAttribute('class')) ?? '').includes('selected'), HUNG_MS, 200)))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await dialog.count()) === 0, HUNG_MS, 200)

    // --- Working (HI-1695, Darren's option 1): no notice until its turn ends; meanwhile the footer says it can hand over
    // when it has finished and opens nothing, and the Agent API refuses. Its turn over: the notice, with Hand Over to….
    await say(busy, 'pad 1200 holduntil go-busy')
    const busyToast = toastOf('Busy')
    // Past the limit as Combwork's look has read it (its size in the footer's state), still in its turn.
    check('working past the limit', !!(await lib.until(async () => ((await live(busy.id))?.transcriptBytes ?? 0) > 1024 * 1024 && (await live(busy.id))?.status === 'working', HUNG_MS, 200)), JSON.stringify(await live(busy.id)))
    check('…no notice while it works', (await busyToast.count()) === 0)
    const busyFoot = footerOf('Busy')
    const tip = await lib.hoverTip(page, busyFoot, (t) => /when it has finished/.test(t))
    check("the footer's size says it can hand over when it has finished", /when it has finished/.test(tip), tip)
    await page.mouse.move(5, 5)
    await busyFoot.click()
    check('…and a click on it opens nothing', (await dialog.count()) === 0)
    const refused = await api(workspaceToken, 'POST', '/v1/projects/alpha/handover', { from: 'Busy', to: 'Busy', handover: false })
    check('the Agent API refuses handing it over to itself', refused.status === 409, JSON.stringify(refused))
    fs.writeFileSync(path.join(claudeHome, 'go-busy'), '')
    check('its turn over: the notice says so', !!(await lib.until(async () => (await busyToast.count()) === 1, HUNG_MS, 200)))
    const busyText = await busyToast.innerText().catch(() => '')
    check('…once, with Hand Over to… now it may hand over', /over 1 MB\): it may slow down/.test(busyText) && (await busyToast.getByRole('button', { name: 'Hand Over to…', exact: true }).count()) === 1, busyText)
    await shoot('notice-after-turn')

    // --- On a running lane, idle: nothing to click either.
    const n1 = await make('Lane card', 'review', builder.id)
    const started = await laneOf(builder, { project: 'alpha', builder: 'Builder', reviewer: 'Reviewer', name: 'notice lane', cards: [n1] })
    check('a lane starts', started.status === 200 && !!(await lib.until(async () => (await lanes()).some((l) => l.name === 'notice lane'), HUNG_MS, 200)), JSON.stringify(started))
    check('…its builder in a new conversation, done with its brief', started.renewed, started.now)
    check('its builder crosses the limit, idle', !!(await pad(builder)))
    const laneToast = toastOf('Builder')
    check('in a lane: the notice says so', !!(await lib.until(async () => (await laneToast.count()) === 1, HUNG_MS, 200)))
    const laneText = await laneToast.innerText().catch(() => '')
    check('…with nothing to click although it is idle', /when it has finished/.test(laneText) && (await laneToast.getByRole('button', { name: 'Hand Over to…', exact: true }).count()) === 0, laneText)

    // --- A notice made while idle, once the agent is on a lane in a new conversation (HI-2232): its offer was that
    // conversation's, so its button goes and it says so (HI-2320), rather than offer what no longer applies.
    check('Stale crosses the limit, idle', !!(await pad(staleAgent)))
    const stale = toastOf('Stale')
    check('…and its notice offers Hand Over to…', !!(await lib.until(async () => (await stale.getByRole('button', { name: 'Hand Over to…', exact: true }).count()) === 1, HUNG_MS, 200)))
    const n2 = await make('Stale lane card', 'review', staleAgent.id)
    const staleLane = await laneOf(staleAgent, { project: 'alpha', builder: 'Stale', reviewer: 'Checker', name: 'stale lane', cards: [n2] })
    check('Stale joins a lane, its card in Review', staleLane.status === 200 && !!(await lib.until(async () => (await lanes()).some((l) => l.name === 'stale lane'), HUNG_MS, 200)), JSON.stringify(staleLane))
    // Its old notice is its last conversation's: the new one is the lane's (HI-2232).
    check('…in a new conversation, done with its brief', staleLane.renewed, staleLane.now)
    const staleSession = (await live(staleAgent.id)).sessionId
    const staleRow = async () => (await page.evaluate(() => window.__cwBell())).find((t) => t.title.includes('Stale: long conversation'))
    // Its old conversation ended (the lane's renewal stops it first) or moved on: either says so.
    check('the old notice loses Hand Over to…, saying its conversation ended', !!(await lib.until(async () => ['Its conversation ended', 'It has a new conversation now'].includes((await staleRow())?.resolved), HUNG_MS, 200)) && (await stale.getByRole('button', { name: 'Hand Over to…', exact: true }).count()) === 0 && (await dialog.count()) === 0 && (await live(staleAgent.id))?.sessionId === staleSession, JSON.stringify(await staleRow()))
    await lib.agentMenu(page, 'Stale')
    await lib.menuEntry(page, 'Hand Over to…').click()
    check('Hand Over to… (⋯) opens', !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS, 200)))
    // The window learns of the lane a moment after Combwork (which refuses meanwhile): waited for.
    const off = await lib.until(async () => (await selfChoice.locator('input').isDisabled()) && /card loop/.test(await selfChoice.innerText()), HUNG_MS, 200)
    check("…without the agent itself while it is on the lane's card", !!off, await selfChoice.innerText().catch(() => ''))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await dialog.count()) === 0, HUNG_MS, 200)


    // --- Hand Over to… itself, checked again before the conversation ends.
    // The merge slot taken while it writes its handover: not ended.
    const idleSession = (await live(idle.id)).sessionId
    const launches = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const token = launches().find((l) => l.sessionId === idleSession)?.token
    const slotRun = handOverSelf(idle)
    check('Combwork asks Idle for a handover', !!(await asked(idle)) && (await writing('Idle').count()) > 0)
    const claim = await api(token, 'POST', '/v1/projects/alpha/merge-slot/claim', { cards: [], timeoutSeconds: 0 })
    check('…it takes the merge slot meanwhile', !!(await lib.until(async () => !!(await live(idle.id))?.mergeSlot, HUNG_MS, 200)), JSON.stringify(claim))
    writeHandover('Idle', idleSession)
    const slotOutcome = await slotRun
    check('…so, its handover written, its conversation is not ended', /took the merge slot, started other work or changed/.test(slotOutcome) && (await live(idle.id))?.sessionId === idleSession, slotOutcome)
    await api(token, 'POST', '/v1/projects/alpha/merge-slot/release', {})
    await lib.until(async () => !(await live(idle.id))?.mergeSlot, HUNG_MS, 200)
    // Other work begun after it answered (a task typed in): not ended either.
    const taskRun = handOverSelf(idle)
    const before = (await live(idle.id)).turn?.id
    check('Combwork asks again, and it answers', !!(await lib.until(async () => (await live(idle.id))?.turn?.id !== before, HUNG_MS, 200)) && !!(await asked(idle)))
    await say(idle, 'next task holduntil go-idle')
    check('…then a new task begins', (await live(idle.id))?.status === 'working')
    writeHandover('Idle', idleSession)
    const taskOutcome = await taskRun
    check('…so, its handover written, its conversation is not ended', /took the merge slot, started other work or changed/.test(taskOutcome) && (await live(idle.id))?.sessionId === idleSession, taskOutcome)
    fs.writeFileSync(path.join(claudeHome, 'go-idle'), '')
    await lib.until(async () => (await live(idle.id))?.status === 'finished', HUNG_MS, 300)
    // Nothing in the way: it carries on in a new conversation.
    const last = (await live(idle.id)).turn?.id
    const okRun = handOverSelf(idle)
    check('Combwork asks a third time, and it answers', !!(await lib.until(async () => (await live(idle.id))?.turn?.id !== last, HUNG_MS, 200)) && !!(await asked(idle)))
    writeHandover('Idle', idleSession)
    const okOutcome = await okRun
    check('…and, nothing in the way, the hand-over goes through', okOutcome === 'ok', okOutcome)
    const fresh = await lib.until(async () => {
      const s = await live(idle.id)
      return s?.sessionId && s.sessionId !== idleSession && s
    }, HUNG_MS, 300)
    check('…and it carries on in a new conversation', !!fresh, JSON.stringify(await live(idle.id)))
    console.log(`screenshots: ${shots}`)
  } finally {
    await app.close().catch(() => undefined)
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
