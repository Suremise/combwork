// Tools by side (HI-2664, Darren's decision): a project agent's Combwork tools follow its side of the workflow, set on
// its launch (CW_SIDE in the combwork server's env, its saved role's); a role change restarts it to load the new list,
// in the same conversation: an idle agent at once, by the change itself (every path's: updateAgent), a busy one only
// once asked (busy, then the window's Later: never; Restart When Its Turn Is Over: atSafePoint, at its turn's end). The
// work it gets meanwhile is the unit tests' (reviewerPool, laneStart, lanes). The agent is the fake Claude Code; the
// launch's --mcp-config is read for its combwork env.
// Tools by workflow (HI-2694, Darren's decision: launch-only): the tools its project's workflow makes unusable are left out
// too (CW_WORKFLOW_HIDDEN); a workflow change restarts an agent whose list it changes the same way, either way (added or
// removed): an idle one at once, a busy one once asked; until it has relaunched, it is given no work needing the new
// tools (a lane naming it as reviewer is refused).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'toolsides-profile')
const ws = path.join(lib.WORK, 'toolsides-ws')
const claudeHome = path.join(lib.WORK, 'toolsides-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** The fake's launches, newest last; each launch's combwork server env read from its --mcp-config. */
const launches = () => (fs.existsSync(path.join(claudeHome, 'fake-launches.jsonl')) ? fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const sideOf = (launch) => {
  try {
    return JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env.CW_SIDE ?? null
  } catch {
    return null
  }
}
/** The tools a launch's project workflow left out (HI-2694), as its combwork server was told them; null: not readable. */
const hiddenOf = (launch) => {
  try {
    const v = JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env.CW_WORKFLOW_HIDDEN
    return v ? v.split(',') : []
  } catch {
    return null
  }
}
const lacksReview = (launch) => ['cw_start_review', 'cw_verdict'].every((t) => (hiddenOf(launch) ?? []).includes(t))
const hasReview = (launch) => hiddenOf(launch) !== null && !['cw_start_review', 'cw_verdict'].some((t) => hiddenOf(launch).includes(t))

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.logFakeInput(claudeHome)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47931), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const agent = await lib.addAgent(inv, alpha, { name: 'Worker', workflowRole: 'builder' })
    const key = lib.ptyKey(alpha, agent.id)
    const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
    await inv('session:start', alpha, { agentId: agent.id })
    check('the builder starts', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)))
    const first = launches().at(-1)
    check("its combwork server is a builder's (CW_SIDE builder)", sideOf(first) === 'builder', String(sideOf(first)))

    // --- Idle: made a reviewer, the change itself restarts it (updateAgent, which Agent Settings, the Agent API and the
    // Assistant all go through: no call of the window's), with a reviewer's tools, in the same conversation.
    await inv('agents:update', alpha, agent.id, { workflowRole: 'reviewer' })
    check("an idle agent made a reviewer is restarted by the change itself, with a reviewer's tools", !!(await lib.until(async () => launches().length === 2 && sideOf(launches()[1]) === 'reviewer', HUNG_MS)), JSON.stringify(launches().map(sideOf)))
    check('…resuming its conversation', launches()[1].opts['--resume'] === first.sessionId, JSON.stringify(launches()[1].opts['--resume']))
    check('…and running again', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)))
    check("the window's question after it finds nothing more to do (one restart, never two)", (await inv('session:restartForTools', alpha, agent.id, 'ifIdle')) === 'same')
    check('…and none comes after', launches().length === 2)

    // --- Busy: its role changed in Agent Settings while it works, the window asks (the question's two answers).
    // A turn long enough for the dialogs (12 s of the fake's work), its end waited for, never its length.
    const turn = async (what) => {
      const typed = await lib.typeLine(inv, key, claudeHome, null, 'work 12', { live })
      check(`${what}: it starts a turn that takes a while`, typed.attempt > 0, JSON.stringify(typed.lost))
      return !!(await lib.until(async () => (await live())?.status === 'working', HUNG_MS))
    }
    const later = page.getByRole('button', { name: 'Later', exact: true })
    const whenOver = page.getByRole('button', { name: 'Restart When Its Turn Is Over', exact: true })
    /** Agent Settings…, the role chosen, Save: whether the restart question came (the agent busy). */
    const roleInSettings = async (role) => {
      await lib.agentMenu(page, 'Worker')
      await page.locator('.menu-item', { hasText: 'Agent Settings…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Worker settings' })
      await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)
      await dialog.getByRole('radiogroup', { name: 'Role in the workflow' }).locator(`[data-workflow-role="${role}"] input`).check()
      await dialog.getByRole('button', { name: 'Save' }).click()
      // Asked over Agent Settings, which closes once it is answered.
      return !!(await lib.until(async () => (await later.count()) === 1 && (await whenOver.count()) === 1, HUNG_MS))
    }
    const settingsClosed = async () => !!(await lib.until(async () => (await page.getByRole('dialog', { name: 'Worker settings' }).count()) === 0, HUNG_MS))
    await page.getByText('alpha', { exact: true }).first().click()

    // --- Later: made a builder while it works, it isn't restarted, then or once its turn is over.
    await turn('busy')
    check('a busy agent made a builder in Agent Settings: asked first (Restart When Its Turn Is Over, Later)', await roleInSettings('builder'))
    check('…its turn goes on, not restarted', (await live())?.status === 'working' && launches().length === 2)
    await later.click()
    // Later: nothing more is asked of it. Its turn ends on its old tools, and it stays on them.
    check('Later: the question goes, with Agent Settings', !!(await lib.until(async () => (await later.count()) === 0, HUNG_MS)) && (await settingsClosed()))
    check('…and its turn ends', await lib.agentIdle(inv, agent.id, HUNG_MS))
    check("…and it isn't restarted: still the reviewer's tools it launched with", launches().length === 2 && sideOf(launches().at(-1)) === 'reviewer', JSON.stringify(launches().map(sideOf)))
    check('…still a restart to make, should it be asked again', (await inv('session:restartForTools', alpha, agent.id, 'ifIdle')) === 'restarting')
    check("…which loads a builder's tools", !!(await lib.until(async () => launches().length === 3 && sideOf(launches()[2]) === 'builder', HUNG_MS)), JSON.stringify(launches().map(sideOf)))
    check('…in the same conversation', launches()[2].opts['--resume'] === first.sessionId)
    check('…running again', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)))

    // --- Busy, then Restart When Its Turn Is Over: made a reviewer while it works, restarted once the turn has ended.
    await turn('restart when over')
    check('busy again, made a reviewer: asked first', await roleInSettings('reviewer'))
    await whenOver.click()
    check('Restart When Its Turn Is Over: the question goes, with Agent Settings', !!(await lib.until(async () => (await whenOver.count()) === 0, HUNG_MS)) && (await settingsClosed()))
    check('…not while its turn goes on', (await live())?.status === 'working' && launches().length === 3)
    check("…relaunched with a reviewer's tools once its turn ended", !!(await lib.until(async () => launches().length === 4 && sideOf(launches()[3]) === 'reviewer', HUNG_MS)), JSON.stringify(launches().map(sideOf)))
    check('…in the same conversation', launches()[3].opts['--resume'] === first.sessionId)
    await lib.agentIdle(inv, agent.id, HUNG_MS)
    await inv('session:stop', alpha, agent.id).catch(() => undefined)
    await lib.until(async () => (await live())?.status === 'stopped' || !(await live()), HUNG_MS)

    // --- Tools by workflow (HI-2694). An either-role agent (both sides' tools) on a project with no review.
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${env.CW_API_PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    // No review, but not All off (which is really off, SPEC §16.6.4: it hides nothing): dependencies must be done first.
    const NO_REVIEW = { preset: null, options: { review: 'none', noSelfReview: false, folder: 'project', dependenciesDone: true } }
    const REVIEW = { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project', dependenciesDone: true } }
    await inv('workflow:setOptions', alpha, NO_REVIEW)
    const both = await lib.addAgent(inv, alpha, { name: 'Both', workflowRole: 'either' })
    const maker = await lib.addAgent(inv, alpha, { name: 'Maker', workflowRole: 'builder' })
    const bothKey = lib.ptyKey(alpha, both.id)
    const bothLive = async () => (await inv('session:live')).find((s) => s.agentId === both.id)
    const bothLaunches = () => launches().filter((l) => l.env?.CW_AGENT === 'Both')
    await inv('session:start', alpha, { agentId: both.id })
    // A launch or relaunch before any turn of its own: ready, not finished (HI-2688).
    check('an either-role agent starts', !!(await lib.until(async () => (await bothLive())?.status === 'ready', HUNG_MS)))
    const b0 = bothLaunches().at(-1)
    check('with no review, its launch leaves out the review tools (CW_WORKFLOW_HIDDEN), its side being both', !!b0 && sideOf(b0) === 'both' && lacksReview(b0), JSON.stringify(b0 && hiddenOf(b0)))

    // Idle: review by an agent turned on, the change itself restarts it with them, in the same conversation.
    await inv('workflow:setOptions', alpha, REVIEW)
    check('review turned on: an idle agent is restarted by the change itself, with the review tools', !!(await lib.until(async () => bothLaunches().length === 2 && hasReview(bothLaunches()[1]), HUNG_MS)), JSON.stringify(bothLaunches().map(hiddenOf)))
    check('…resuming its conversation', bothLaunches()[1]?.opts['--resume'] === b0.sessionId, JSON.stringify(bothLaunches()[1]?.opts['--resume']))
    // A launch or relaunch before any turn of its own: ready, not finished (HI-2688).
    check('…running again', !!(await lib.until(async () => (await bothLive())?.status === 'ready', HUNG_MS)))
    check('…and asked again, nothing more to do', (await inv('session:restartForTools', alpha, both.id, 'ifIdle')) === 'same')

    // Busy, review turned off (tools removed): asked, Restart When Its Turn Is Over: relaunched without them once its turn ends.
    const bothTurn = async (what) => {
      const typed = await lib.typeLine(inv, bothKey, claudeHome, null, 'work 12', { live: bothLive })
      check(`${what}: it starts a turn that takes a while`, typed.attempt > 0, JSON.stringify(typed.lost))
      return !!(await lib.until(async () => (await bothLive())?.status === 'working', HUNG_MS))
    }
    const asked = page.getByText('Restart Both for the new workflow?', { exact: true })
    await bothTurn('review off while busy')
    await inv('workflow:setOptions', alpha, NO_REVIEW)
    check('review turned off while it works: the window asks (Restart When Its Turn Is Over, Later)', !!(await lib.until(async () => (await asked.count()) === 1 && (await whenOver.count()) === 1 && (await later.count()) === 1, HUNG_MS)))
    check('…its turn goes on, not restarted', (await bothLive())?.status === 'working' && bothLaunches().length === 2)
    await whenOver.click()
    check('Restart When Its Turn Is Over: the question goes', !!(await lib.until(async () => (await asked.count()) === 0, HUNG_MS)))
    check('…relaunched without the review tools once its turn ended', !!(await lib.until(async () => bothLaunches().length === 3 && lacksReview(bothLaunches()[2]), HUNG_MS)), JSON.stringify(bothLaunches().map(hiddenOf)))
    check('…in the same conversation', bothLaunches()[2]?.opts['--resume'] === b0.sessionId)
    // A launch or relaunch before any turn of its own: ready, not finished (HI-2688).
    check('…running again', !!(await lib.until(async () => (await bothLive())?.status === 'ready', HUNG_MS)))

    // Busy, review turned on (tools added), Later: it keeps the tools it launched with, and work needing the new ones
    // waits for its relaunch: a lane naming it as reviewer is refused, saying to restart it first.
    const card = (await api('POST', '/v1/tasks', { title: 'Reviewed work', project: 'alpha' })).body?.number
    await bothTurn('review on while busy')
    await inv('workflow:setOptions', alpha, REVIEW)
    check('review turned on while it works: the window asks', !!(await lib.until(async () => (await asked.count()) === 1 && (await later.count()) === 1, HUNG_MS)))
    await later.click()
    check('Later: the question goes', !!(await lib.until(async () => (await asked.count()) === 0, HUNG_MS)))
    check('…and its turn ends', await lib.agentIdle(inv, both.id, HUNG_MS))
    check("…and it isn't restarted: still without the review tools", bothLaunches().length === 3 && lacksReview(bothLaunches().at(-1)), JSON.stringify(bothLaunches().map(hiddenOf)))
    const refused = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'Maker', reviewer: 'Both', cards: [card] })
    check('…a lane naming it as reviewer meanwhile is refused (409), saying to restart it first', refused.status === 409 && /restart/i.test(JSON.stringify(refused.body)), JSON.stringify(refused))
    check('…a workflow change that leaves its list as it is asks nothing again', (await inv('workflow:setOptions', alpha, { ...REVIEW, options: { ...REVIEW.options, maxAgents: 7 } }), (await asked.count()) === 0))
    check('…still a restart to make, should it be asked again', (await inv('session:restartForTools', alpha, both.id, 'ifIdle')) === 'restarting')
    check('…which loads the review tools', !!(await lib.until(async () => bothLaunches().length === 4 && hasReview(bothLaunches()[3]), HUNG_MS)), JSON.stringify(bothLaunches().map(hiddenOf)))
    // A launch or relaunch before any turn of its own: ready, not finished (HI-2688).
    check('…running again', !!(await lib.until(async () => (await bothLive())?.status === 'ready', HUNG_MS)))
    // A board change that brings a tool back with no settings change: on a project without review, a card moved into
    // Review by hand keeps the review tools, so a running agent launched without them is restarted with them.
    await inv('workflow:setOptions', alpha, NO_REVIEW)
    // A launch or relaunch before any turn of its own: ready, not finished (HI-2688).
    check('review off again: the idle agent is restarted without the review tools', !!(await lib.until(async () => bothLaunches().length === 5 && lacksReview(bothLaunches()[4]) && (await bothLive())?.status === 'ready', HUNG_MS)), JSON.stringify(bothLaunches().map(hiddenOf)))
    const moved = (await api('POST', '/v1/tasks', { title: 'Moved to Review by hand', project: 'alpha' })).body?.number
    await inv('tasks:update', moved, { column: 'review' }).catch(() => api('PATCH', `/v1/tasks/${moved}`, { column: 'review' }))
    check('a card moved into Review by hand: the agent is restarted with the review tools, no setting changed', !!(await lib.until(async () => bothLaunches().length === 6 && hasReview(bothLaunches()[5]), HUNG_MS)), JSON.stringify(bothLaunches().map(hiddenOf)))
    // A launch or relaunch before any turn of its own: ready, not finished (HI-2688).
    check('…running again', !!(await lib.until(async () => (await bothLive())?.status === 'ready', HUNG_MS)))
    await inv('session:stop', alpha, both.id).catch(() => undefined)
    void maker
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
