// The Hive Assistant's control (Settings → Assistant → Control), through the Agent API with the Assistant's own
// token, with the Agent API itself turned off. Agents run the fake Claude Code (fake-claude/), so nothing signs in
// or spends tokens. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'control-profile')
const ws = path.join(lib.WORK, 'control-ws')
const claudeHome = path.join(lib.WORK, 'control-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47895))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n' })
  fs.mkdirSync(path.join(ws, 'gamma'))
  lib.enableProviders(userData)
  // Claude Code is the fake one; the Agent API is off (the Assistant still gets in with its own token).
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.agentApi = { enabled: false }
  // Closing at the end must not wait on the quit dialog (an agent may still be working).
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // A long pause, which Enter doesn't end, so the typing checks hold however long the steps take.
  cfg.settings.assistant = { ...cfg.settings.assistant, typingPause: 600, enterEndsPause: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const info = await inv('workspace:refresh')
  const home = info.assistant.path
  const live = async (p, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === agentId)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }

  // The Assistant starts in the workspace folder; the fake asks to trust it, which shows as waiting for the user.
  await page.getByText('gamma', { exact: true }).first().click()
  await lib.sleep(300)
  await inv('session:start', home, { agentId: 'assistant' })
  const asking = await until(async () => (await live(home, 'assistant'))?.status === 'waiting' && (await live(home, 'assistant')), HUNG_MS)
  check('a trust question before the start shows as waiting', !!asking && /trust/i.test(asking.statusMessage ?? ''), JSON.stringify(asking && { status: asking.status, msg: asking.statusMessage }))
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  check('answered, it starts', !!(await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)))

  // Its hive tools: its own token file, its role and control level.
  const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
  // In its launch's private folder in Hive's user data, not the project (#345).
  const mcp = JSON.parse(fs.readFileSync(path.join(lib.launchDir(userData, (await live(home, 'assistant')).runId), 'mcp.json'), 'utf8')).mcpServers.hive
  check("the Assistant's hive tools use its token and role", mcp?.env.HIVE_API_TOKEN_FILE === tokenFile && mcp.env.HIVE_ROLE === 'assistant' && mcp.env.HIVE_ASSISTANT_CONTROL === 'projects', JSON.stringify(mcp?.env))
  // Its skills: the workspace's skills for the Assistant (coordinate-agents and the shared ones), none for agents only.
  const assistantSkills = fs.readdirSync(path.join(home, '.hive', 'launch-assistant', 'plugin', 'skills')).sort()
  // use-hive-api is for both (HI-2012): its tools.md, the hive tools' detail, is copied with it.
  check('the Assistant gets the skills for it', ['coordinate-agents', 'handover', 'pick-up', 'split-work', 'workspace-note', 'use-hive-api'].every((n) => assistantSkills.includes(n)) && fs.existsSync(path.join(home, '.hive', 'launch-assistant', 'plugin', 'skills', 'use-hive-api', 'tools.md')) && !['work-on-card', 'review-agent-work', 'merge-ready'].some((n) => assistantSkills.includes(n)), assistantSkills.join(','))
  // Its instructions: its control level and boundaries, the skill that says how, then the mode.
  const told = fs.readFileSync(path.join(home, '.hive', 'launch-assistant', 'instructions.md'), 'utf8')
  check('its instructions give its control level and point to coordinate-agents, before the mode', /Control agents and create projects/.test(told) && told.indexOf('coordinate-agents skill') > 0 && told.indexOf('coordinate-agents skill') < told.indexOf('# Your mode'), told.slice(0, 300))
  const api = async (method, p, body, bearer = token) => {
    const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  check('with the Agent API off, its own token is refused', (await api('GET', '/v1/projects', null, apiToken)).status === 403)
  check("the Assistant's token still works", (await api('GET', '/v1/projects')).status === 200)
  /**
   * Waits for an agent of alpha to be done with a task Hive just gave it (#680): its activity has the task (`task`, a
   * pattern) and the reply to it. agents/wait can answer before that task is taken (the last turn's "finished", or a new
   * launch still starting), so its answer is shown, never relied on; the activity is read until it has both, bounded for
   * a hung run; with `session`, in that conversation (a task in the same words as the one before it). Returns
   * { act, waited } once done, else null with what the wait and the activity said.
   */
  const taskDone = async (name, task, session = null) => {
    const waited = (await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: name }], timeoutSeconds: 30 })).body
    let act = null
    const t = Date.now()
    let looks = 0
    const done = await until(async () => {
      looks++
      act = (await api('GET', `/v1/projects/alpha/agents/${name}/activity`)).body
      return task.test(act?.currentTask ?? '') && act.latestReply === `Done: ${act.currentTask}` && (!session || act.sessionId === session)
    }, lib.TURN_HUNG_MS)
    if (looks > 1) console.log(`  (${name}'s task ${done ? 'was done' : 'was not done'} ${Date.now() - t} ms after agents/wait answered ${JSON.stringify(waited)})`)
    if (!done) console.log(`DIAGNOSTIC ${name}: agents/wait said ${JSON.stringify(waited)}; its activity ${JSON.stringify(act && { task: act.currentTask, reply: act.latestReply, status: act.status, sessionId: act.sessionId })}; its session ${JSON.stringify((await inv('session:live')).find((x) => x.agentName === name) ?? null)}`)
    return done ? { act, waited } : null
  }
  const providers = (await api('GET', '/v1/providers')).body
  check('it lists the providers with their models, efforts and modes', providers?.some((p) => p.id === 'claude-code' && p.enabled && p.installed && p.models.length && p.efforts.length && p.modes.length), JSON.stringify(providers?.map((p) => p.id)))

  // Project agents read what they are given from their inbox with Hive's tools (#650): on from here for their tasks, and
  // off again for the hand-over checks below.
  await inv('settings:update', { agentApi: { enabled: true } })
  await lib.until(async () => (await api('GET', '/v1/status').catch(() => ({}))).status === 200, 10000)

  // Create a project; add an agent that starts on a task (on the command line). The view stays on gamma.
  const created = await api('POST', '/v1/projects', { name: 'beta' })
  check('it creates a project, turned on', created.status === 200 && created.body?.active === true && fs.existsSync(path.join(ws, 'beta')), JSON.stringify(created.body))
  const added = await api('POST', '/v1/projects/alpha/agents', { name: 'Builder', prompt: 'work 3' })
  check('it adds an agent that starts on a task', added.status === 200 && added.body?.agent?.name === 'Builder', JSON.stringify(added.body))
  const builder = added.body?.agent?.id
  const trusting = await until(async () => (await live(alpha, builder))?.status === 'waiting', HUNG_MS)
  check("a new folder's trust question waits for the user", !!trusting)
  const askingRun = (await live(alpha, builder))?.runId
  const askingFresh = await api('POST', '/v1/projects/alpha/agents/Builder/prompt', { text: 'work 1', newConversation: true })
  check('no new conversation for an agent waiting for the user', askingFresh.status === 409 && /waiting for the user/.test(askingFresh.body?.error) && !!askingRun && (await live(alpha, builder))?.runId === askingRun, JSON.stringify(askingFresh.body))
  await inv('pty:write', lib.ptyKey(alpha, builder), '\r')
  check('then it works on the task', !!(await until(async () => (await live(alpha, builder))?.status === 'working', HUNG_MS)))
  check("the user's view didn't move", (await page.locator('.project-header, .project-title').first().innerText().catch(() => '')).includes('gamma'))
  const busy = await api('POST', `/v1/projects/alpha/agents/Builder/prompt`, { text: 'more' })
  check('no task for a working agent', busy.status === 409 && /working/.test(busy.body?.error), JSON.stringify(busy.body))
  const workingRun = (await live(alpha, builder))?.runId
  const busyFresh = await api('POST', `/v1/projects/alpha/agents/Builder/prompt`, { text: 'more', newConversation: true })
  check('nor a new conversation for it (#437): its run goes on', busyFresh.status === 409 && /working/.test(busyFresh.body?.error) && (await live(alpha, builder))?.runId === workingRun, JSON.stringify(busyFresh.body))
  const waited = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Builder' }], timeoutSeconds: 30 })
  check('waiting returns when it finishes', waited.body?.timedOut === false && waited.body.agents[0].status === 'finished', JSON.stringify(waited.body))
  const act = (await taskDone('Builder', /^work 3$/))?.act
  check('its activity: the task (#650: read from its inbox) and the reply', !!act, JSON.stringify(act))
  const typed = await api('POST', '/v1/projects/alpha/agents/Builder/prompt', { text: 'next' })
  check("no task where the user typed in the last minute", typed.status === 409 && /typed/.test(typed.body?.error), JSON.stringify(typed.body))
  const typedFresh = await api('POST', '/v1/projects/alpha/agents/Builder/prompt', { text: 'next', newConversation: true })
  check('nor a new conversation there', typedFresh.status === 409 && /typed/.test(typedFresh.body?.error) && (await live(alpha, builder))?.runId === workingRun, JSON.stringify(typedFresh.body))
  // The user's last key was Enter: with Enter ends the pause, the task goes in.
  await inv('settings:update', { assistant: { enterEndsPause: true } })
  const afterEnter = await api('POST', '/v1/projects/alpha/agents/Builder/prompt', { text: 'work 1' })
  check('Enter ends the pause', afterEnter.status === 200, JSON.stringify(afterEnter.body))
  // Done with it before the next step: a new conversation is refused while it works.
  check('…and it does that task', !!(await taskDone('Builder', /^work 1$/)))

  // A new lane (#437): an idle agent's next task in a new conversation, in one call; the old one stays in its history.
  const old = await live(alpha, builder)
  const fresh = await api('POST', '/v1/projects/alpha/agents/Builder/prompt', { text: 'work 1', newConversation: true })
  check('an idle agent takes a task in a new conversation', fresh.status === 200 && fresh.body?.newConversation === true, JSON.stringify(fresh.body))
  const renewed = await until(async () => { const s = await live(alpha, builder); return s?.sessionId && s.sessionId !== old?.sessionId && s }, HUNG_MS)
  check('it runs as a new launch with a new session', !!old?.sessionId && !!renewed && renewed.runId !== old.runId, JSON.stringify({ old: old?.sessionId, now: renewed?.sessionId }))
  // Its own task, in the new conversation: not the one before it (the same words), so read in the new session.
  const freshAct = renewed ? (await taskDone('Builder', /^work 1$/, renewed.sessionId))?.act : null
  check('on the task, with no handover', !!freshAct, JSON.stringify(freshAct && { task: freshAct.currentTask, reply: freshAct.latestReply }))
  const history = (await inv('session:list', alpha)).map((s) => s.id)
  check('the old conversation stays in the Sessions history', history.includes(old?.sessionId) && history.includes(renewed?.sessionId), JSON.stringify(history))
  check('it is listed in Done by the Assistant', (await inv('assistant:actions')).some((x) => x.ok && x.text.startsWith('Gave Builder in alpha a task in a new conversation')))
  await inv('settings:update', { assistant: { enterEndsPause: false } })

  // A second agent, started idle, takes a task; its edit shows as a locked file and a tool call.
  const second = await api('POST', '/v1/projects/alpha/agents', { name: 'Fixer', start: true })
  const fixer = second.body?.agent?.id
  check('an agent started idle is ready', !!(await until(async () => (await live(alpha, fixer))?.status === 'ready', HUNG_MS)))
  const given = await api('POST', '/v1/projects/alpha/agents/Fixer/prompt', { text: 'edit a.ts work 6' })
  check('an idle agent takes a task', given.status === 200, JSON.stringify(given.body))
  await until(async () => (await live(alpha, fixer))?.status === 'working', HUNG_MS)
  // What it shows while the edit is locked, as one read (#680: a second read after the wait can come after its turn).
  let working = null
  const edited = await until(async () => {
    working = (await api('GET', '/v1/projects/alpha/agents/Fixer/activity')).body
    return working?.recentTools?.some((t) => t.tool === 'Edit') && working.lockedFiles?.includes('a.ts')
  }, HUNG_MS)
  check('its activity shows the edit and the locked file', !!edited, JSON.stringify(working))

  // Stopping a busy agent asks the user, in the panel: no, then yes.
  await inv('settings:update', {})
  await page.keyboard.press('Control+Alt+I').catch(() => {})
  await lib.sleep(500)
  const stopping = api('POST', '/v1/projects/alpha/agents/Fixer/stop', { reason: 'testing' })
  const card = page.locator('.assistant-question', { hasText: 'Stop Fixer in alpha?' })
  await card.waitFor({ timeout: 10000 }).catch(() => {})
  check('stopping a busy agent asks the user on a card', (await card.count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'control-1-question.png') })
  await card.locator('button', { hasText: "Don't stop" }).click()
  const refused = await stopping
  check("the user's no is the answer", refused.status === 409 && /chose not to stop/.test(refused.body?.error) && !!(await live(alpha, fixer)), JSON.stringify(refused.body))
  const stopping2 = api('POST', '/v1/projects/alpha/agents/Fixer/stop', {})
  await card.waitFor({ timeout: 10000 }).catch(() => {})
  const qs = await inv('assistant:questions')
  await inv('assistant:answer', qs[0]?.id, true)
  check('and a yes stops it', (await stopping2).status === 200 && !!(await until(async () => !(await live(alpha, fixer)), HUNG_MS)))
  // HI-1994: an agent only watching a card (its turn over, a card watch running) is idle: stopped with no question.
  const watched = (await api('POST', '/v1/tasks', { title: 'Watched card', project: 'alpha' })).body?.number
  await api('POST', '/v1/projects/alpha/agents/Fixer/start', {})
  await until(async () => (await live(alpha, fixer))?.status === 'ready', HUNG_MS)
  await api('POST', '/v1/projects/alpha/agents/Fixer/prompt', { text: `hive hive_wait_for_tasks ${JSON.stringify({ cards: [`#${watched}`], column: 'done', wake: true })}` })
  check('Fixer watches a card', !!(await until(async () => (await live(alpha, fixer))?.status === 'watching', HUNG_MS)), (await live(alpha, fixer))?.status)
  const quiet = await api('POST', '/v1/projects/alpha/agents/Fixer/stop', { reason: 'testing' })
  check('stopping an agent that only watches asks nothing: it stops at once', quiet.status === 200 && quiet.body?.wasRunning === true && (await inv('assistant:questions')).length === 0 && !!(await until(async () => !(await live(alpha, fixer)), HUNG_MS)), JSON.stringify(quiet.body))
  const stoppedFresh = await api('POST', '/v1/projects/alpha/agents/Fixer/prompt', { text: 'work 1', newConversation: true })
  check('a stopped agent gets no new conversation: start it instead', stoppedFresh.status === 409 && /isn't running/.test(stoppedFresh.body?.error) && !(await live(alpha, fixer)), JSON.stringify(stoppedFresh.body))

  // What it did is listed in the panel.
  const done = await inv('assistant:actions')
  check('its actions are listed', done.some((x) => x.text.startsWith('Created the project beta')) && done.some((x) => x.text.startsWith('Stopped Fixer')) && done.some((x) => !x.ok), JSON.stringify(done.map((x) => x.text)))
  // The list opens from "Done by the Assistant (n)" at the panel's watch line (#979: closed until then).
  const doneLink = page.locator('.assistant-panel .assistant-done-link')
  if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
  await until(async () => (await doneLink.count()) === 1, HUNG_MS)
  if ((await doneLink.getAttribute('aria-expanded')) !== 'true') await doneLink.click()
  check('the panel shows them', !!(await until(async () => (await page.locator('.assistant-action').count()) >= 3, HUNG_MS)), String(await page.locator('.assistant-action').count()))
  await page.screenshot({ path: path.join(lib.WORK, 'control-2-actions.png') })

  // Look and advise: changes are refused (and listed).
  await inv('settings:update', { assistant: { control: 'look' } })
  const looked = await api('POST', '/v1/projects/alpha/agents', { name: 'Nope' })
  check('Look and advise refuses changes', looked.status === 403 && /Look and advise/.test(looked.body?.error), JSON.stringify(looked.body))
  check('but it can still read', (await api('GET', '/v1/projects/alpha/agents/Builder/activity')).status === 200)
  // Lanes at Look (#500): listed; started, joined and ended only at Control agents.
  check('it lists lanes', (await api('GET', '/v1/lanes')).status === 200)
  const laneStart = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'Builder', cards: [1] })
  check("…and can't start one", laneStart.status === 403 && /Look and advise/.test(laneStart.body?.error), JSON.stringify(laneStart.body))
  const laneJoin = await api('POST', '/v1/lanes/join', { project: 'alpha', builder: 'Builder', reviewer: 'Fixer' })
  check("…join one", laneJoin.status === 403, JSON.stringify(laneJoin.body))
  const laneEnd = await api('POST', '/v1/lanes/lane-000000/end', { abandoned: true })
  check('…or end one', laneEnd.status === 403, JSON.stringify(laneEnd.body))
  await inv('settings:update', { assistant: { control: 'agents' } })
  check('Control agents can\'t create projects', (await api('POST', '/v1/projects', { name: 'delta' })).status === 403)
  check('nor remove agents (no such call)', (await api('DELETE', `/v1/projects/alpha/agents/Builder`)).status === 404)

  // From the latest handover: there has to be one.
  const none = await api('POST', '/v1/projects/alpha/handover', { from: 'Builder', to: 'Fixer', handover: false })
  check('no hand-over from the latest handover when there is none', none.status === 409 && /no handover/i.test(none.body?.error), JSON.stringify(none.body))
  fs.mkdirSync(path.join(ws, '.hive', 'shared', 'handovers'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.hive', 'shared', 'handovers', '2026-10-01-alpha-plan.md'), '# Plan\n\n- **Project:** alpha\n\nwork 1\n')
  // Handing over: refused at once while project agents lack Hive's tools (the Agent API is off), then done.
  await inv('settings:update', { agentApi: { enabled: false } })
  const noTools = await api('POST', '/v1/projects/alpha/handover', { from: 'Builder', to: 'Fixer', handover: false })
  check("no hand-over while agents can't use Hive's tools", noTools.status === 409 && /Hive's tools/.test(noTools.body?.error), JSON.stringify(noTools.body))
  await inv('settings:update', { agentApi: { enabled: true } })
  await lib.until(async () => (await api('GET', '/v1/status').catch(() => ({}))).status === 200, 10000)
  const typedIn = await api('POST', '/v1/projects/alpha/handover', { from: 'Builder', to: 'Fixer', handover: false })
  check('no hand-over from an agent the user just typed in', typedIn.status === 409 && /typed/.test(typedIn.body?.error), JSON.stringify(typedIn.body))
  await api('POST', '/v1/projects/alpha/agents', { name: 'Checker' })
  const handed = await api('POST', '/v1/projects/alpha/handover', { from: 'Fixer', to: 'Checker', handover: false })
  check('it hands one agent\'s work over to another', handed.status === 200, JSON.stringify(handed.body))
  const picked = await until(async () => /Read the handover "handovers\/2026-10-01-alpha-plan\.md"/.test((await api('GET', '/v1/projects/alpha/agents/Checker/activity')).body?.currentTask ?? ''), 30000)
  check('the other agent starts on the handover', !!picked)
  check('the hand-over is listed', (await inv('assistant:actions')).some((x) => x.ok && x.text.startsWith("Handing Fixer's work over to Checker")))

  // Through its real hive tools, with the Agent API on: the CLI hands its own environment to MCP servers, and
  // that may carry the Agent API's token (HIVE_API_TOKEN); the Assistant's tools must still use its own.
  const viaTool = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hive_activate_project', arguments: { project: 'alpha', active: true } } }) + '\n',
    env: lib.childEnv({ HIVE_API_TOKEN: apiToken, ...mcp.env, HIVE_API_URL: API }),
    timeout: 15000
  }).toString()
  const toolReply = JSON.parse(viaTool.split('\n')[0]).result
  const asAssistant = (await inv('assistant:actions')).some((x) => x.ok && x.text === 'Activated alpha')
  check("its hive tools act as the Assistant with the Agent API on", !toolReply?.isError && asAssistant, JSON.stringify(toolReply).slice(0, 300))

  // The task board: the Assistant adds and starts cards, and moves one to Done without a question.
  const added2 = await api('POST', '/v1/tasks', { title: 'Write the README', project: 'alpha', description: 'work 1' })
  check('the Assistant adds a card', added2.status === 200 && added2.body?.createdBy === 'Assistant', JSON.stringify(added2.body))
  const cardNo = added2.body?.number
  const started = await api('POST', `/v1/tasks/${cardNo}/start`, { name: 'Writer' })
  check('and starts it on a new agent', started.status === 200 && started.body?.added === true && started.body?.card?.column === 'doing', JSON.stringify(started.body))
  const writer = (await inv('workspace:get')).projects.find((x) => x.name === 'alpha').agents.find((a) => a.name === 'Writer')
  check('which runs the card', !!writer && !!(await until(async () => (await live(alpha, writer.id))?.status === 'finished', 30000)))
  await api('PATCH', `/v1/tasks/${cardNo}`, { column: 'review', comment: 'Ready.' })
  const moved = await api('PATCH', `/v1/tasks/${cardNo}`, { column: 'done' })
  check('the Assistant moves it to Done', moved.status === 200 && moved.body?.column === 'done', JSON.stringify(moved.body))
  check('without asking the user', (await page.locator('.assistant-question').count()) === 0)
  check('its history says the Assistant did it', moved.body?.history?.at(-1)?.by === 'Assistant' && moved.body.history.at(-1).what === 'Moved to Done', JSON.stringify(moved.body?.history?.at(-1)))

  // The list names cards by key alone (#1219, HI-1661): each card's own key, from the board.
  const named = async (n) => `${(await inv('tasks:list')).find((c) => c.number === n)?.key}`
  const cardName = await named(cardNo)
  check('the board changes are listed, the card by its key', /^[A-Z]{2,4}-\d+$/.test(cardName) && (await inv('assistant:actions')).some((x) => x.ok && x.text.startsWith(`Started ${cardName} on a new agent, Writer`)), cardName)
  // Putting cards in order: listed in Done by the Assistant; the order of Done is the user's, refused without asking.
  const o1 = (await api('POST', '/v1/tasks', { title: 'Order one', project: 'alpha' })).body.number
  const o2 = (await api('POST', '/v1/tasks', { title: 'Order two', project: 'alpha' })).body.number
  const ordered = await api('POST', '/v1/tasks/reorder', { column: 'todo', cards: [o2, o1] })
  const o2Card = (await api('GET', `/v1/tasks/${o2}`)).body
  check('the Assistant puts cards in order', ordered.status === 200 && ordered.body[0]?.number === o2 && o2Card.history.at(-1)?.by === 'Assistant', JSON.stringify(ordered.body?.map?.((c) => c.number) ?? ordered))
  const top = await api('PATCH', `/v1/tasks/${o1}`, { position: 'top' })
  check('and one card to the top', top.status === 200 && (await api('GET', '/v1/tasks?column=todo')).body[0]?.number === o1, JSON.stringify(top.body))
  const listed = (await inv('assistant:actions')).map((x) => x.ok && x.text)
  const [o1Name, o2Name] = [await named(o1), await named(o2)]
  check('both are listed in Done by the Assistant, by key', listed.includes(`Put ${o2Name}, ${o1Name} at the top of Todo`) && listed.some((t) => t && t.startsWith(`${o1Name} `) && t.endsWith('moved it to the top of Todo')), JSON.stringify({ o1Name, o2Name, listed: listed.slice(-3) }))
  const doneTop = await api('PATCH', `/v1/tasks/${cardNo}`, { position: 'top' })
  check("the Assistant can't put Done in order, and the user isn't asked", doneTop.status === 403 && (await page.locator('.assistant-question').count()) === 0, JSON.stringify(doneTop))
  // A lane the Assistant starts unwatched (#402): the reply nudges it to watch the lanes; with a lane watch on them all (#531), it doesn't.
  const builderId = (await inv('workspace:get')).projects.find((x) => x.name === 'alpha').agents.find((a) => a.name === 'Builder')?.id
  const wasLive = await live(alpha, builderId)
  const unwatched = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'Builder', cards: [o1, o2] })
  check('a lane started with no watch following it: the reply says to watch the lanes', unwatched.status === 200 && /No watch of yours follows this lane/.test(unwatched.body?.note ?? ''), JSON.stringify(unwatched.body))
  // HI-2232 (Darren's decision (a)): Builder, idle outside slots, is given the lane in a new conversation, as Start Lane… gives it;
  // not free at its launch, it is owed one (HI-2034). Here it isn't free: the user pressed Enter in its terminal above, and the
  // suite's typing pause (600 s, enterEndsPause off) still holds, so its run is left for now and the reply says Hive gives it the
  // lane once it is free, not to prompt it (HI-2029, HR1: a prompt would race Hive's start). The reply comes once the lane's launch
  // is over, so a new conversation given now would show by now.
  const nowLive = await live(alpha, builderId)
  check("…its builder, idle but not free (the user typed there), is owed the lane's new conversation, and the reply says not to prompt it (HI-2232, HI-2034)", wasLive?.status === 'finished' && !!wasLive.sessionId && nowLive?.sessionId === wasLive.sessionId && nowLive?.runId === wasLive.runId && /Builder wasn't free: Hive gives it the lane in a new conversation once it is, so don't prompt it\./.test(unwatched.body?.note ?? ''), JSON.stringify({ note: unwatched.body?.note, status: wasLive?.status, before: wasLive?.sessionId, after: nowLive?.sessionId }))
  const watching = await api('POST', '/v1/tasks/wait', { lanes: ['all'], wake: true })
  const rewatched = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'Builder', cards: [o1, o2] })
  check('…and with one, no nudge', watching.status === 200 && rewatched.status === 200 && !/No watch of yours/.test(rewatched.body?.note ?? ''), JSON.stringify({ watching: watching.body, rewatched: rewatched.body }))
  await api('POST', '/v1/tasks/wait', { cancel: true })
  // HR2's HI-1900 round 1: its running lane updated while Builder is stopped starts Builder on it (never left active, stuck).
  await inv('session:stop', alpha, builderId)
  check('Builder stopped', !!(await until(async () => !(await live(alpha, builderId)), HUNG_MS)))
  const updated = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'Builder', cards: [o2, o1] })
  check("…its lane updated meanwhile starts Builder on it, and the reply says so", updated.status === 200 && updated.body?.did === 'updated' && /Builder wasn't running: started it on the lane\./.test(updated.body?.note ?? '') && !!(await until(async () => !!(await live(alpha, builderId)), HUNG_MS)), JSON.stringify(updated.body?.note))
  await api('POST', `/v1/lanes/${encodeURIComponent(rewatched.body?.lane?.id ?? unwatched.body?.lane?.id)}/end`, { abandoned: true })

  // No limit on its changes for one message (#1170; it stopped at 30): 40 more changes, then a batch, all apply.
  const statuses = []
  for (let n = 0; n < 40; n++) statuses.push((await api('POST', '/v1/projects/alpha/activate')).status)
  check('more than 30 changes for one message all apply', statuses.every((s) => s === 200), JSON.stringify(statuses))
  const batch = await api('POST', '/v1/tasks/batch', { numbers: [o1, o2], addLabels: ['many'] })
  const labelled = [(await api('GET', `/v1/tasks/${o1}`)).body.labels, (await api('GET', `/v1/tasks/${o2}`)).body.labels]
  check('…and a batch after them changes its cards', batch.status === 200 && labelled.every((l) => l?.includes('many')), JSON.stringify({ status: batch.status, body: batch.body, labelled }))

  // Undo (#1282): the user's next message starts a new group of the Assistant's changes. Its own
  // change, listed by that message and undone with its tool: what it changed comes back, and the undo is listed in Done
  // by the Assistant. An id that isn't one of its own changes is refused.
  const before = (await api('GET', '/v1/assistant/changes')).body?.[0]?.group
  const sinceBefore = (await live(home, 'assistant'))?.statusSince
  await inv('pty:write', lib.ptyKey(home, 'assistant'), 'hello')
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  await until(async () => (async (s) => !!s && ['finished', 'ready'].includes(s.status) && s.statusSince !== sinceBefore)(await live(home, 'assistant')), HUNG_MS)
  await api('PATCH', `/v1/tasks/${cardNo}`, { labels: ['undo-me'] })
  const kept = (await api('GET', '/v1/assistant/changes')).body
  const relabel = kept?.flatMap((g) => g.changes).find((c) => c.card === cardNo && c.fields.includes('labels'))
  check('its change is kept for undo, by its message, with the field it set', !!relabel && kept[0]?.group !== before && kept[0].changes.includes(relabel), JSON.stringify(kept).slice(0, 400))
  const undoTool = (args) => JSON.parse(execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hive_undo', arguments: args } }) + '\n', env: lib.childEnv({ ...mcp.env, HIVE_API_URL: API }), timeout: 15000 }).toString().split('\n')[0]).result
  const undoneReply = undoTool({ change: relabel?.id })
  check('hive_undo undoes it: the label it set is gone', !undoneReply?.isError && (undoneReply?.content?.[0]?.text ?? '').startsWith('Undid 1 of 1 change in full.') && (await api('GET', `/v1/tasks/${cardNo}`)).body?.labels?.length === 0, JSON.stringify(undoneReply).slice(0, 300))
  check('…listed in Done by the Assistant', (await inv('assistant:actions')).some((x) => x.ok && x.kind === 'undo' && x.card === cardNo), JSON.stringify((await inv('assistant:actions')).slice(-2)))
  check('…and in the window\'s list as undone', (await inv('assistant:changes')).flatMap((g) => g.changes).some((c) => c.id === relabel?.id && !!c.undoneAt))
  check('an id that is not one of its changes is refused', (await api('POST', '/v1/assistant/undo', { change: 'not-a-change' })).status === 404)
  // A change undo can't take back is still listed, with why (#1282 round 3): withdrawn messages aren't sent again.
  const cancelled = await api('POST', '/v1/projects/alpha/agents/Builder/message', { cancel: true })
  const finals = ((await api('GET', '/v1/assistant/changes')).body?.[0]?.changes ?? []).filter((c) => c.final)
  check("a change it can't undo is listed with why", cancelled.status === 200 && finals.some((c) => /withdrew/.test(c.final)), JSON.stringify({ status: cancelled.status, finals }))

  // The tools its hive MCP server offers follow the control level; project agents never get them.
  const tools = (envExtra) => {
    const outText = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', env: lib.childEnv({ HIVE_API_URL: API, ...envExtra }), timeout: 10000 }).toString()
    return JSON.parse(outText.split('\n')[0]).result.tools.map((t) => t.name)
  }
  const asAgent = tools({ HIVE_PROJECT: 'alpha' })
  const asAgents = tools({ HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'agents' })
  const asLook = tools({ HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'look' })
  check('project agents get no control tools', !asAgent.includes('hive_add_agent') && !asAgent.includes('hive_agent_activity') && !asAgent.includes('hive_start_task'), asAgent.join(','))
  check('project agents get the board tools', ['hive_list_tasks', 'hive_read_task', 'hive_create_task', 'hive_update_task', 'hive_reorder_tasks'].every((t) => asAgent.includes(t)), asAgent.join(','))
  check('Control agents: agent tools, no project creation', asAgents.includes('hive_prompt_agent') && asAgents.includes('hive_stop_agent') && asAgents.includes('hive_hand_over') && asAgents.includes('hive_start_task') && !asAgents.includes('hive_create_project'))
  check('Look and advise: reading tools only', asLook.includes('hive_agent_activity') && asLook.includes('hive_wait_for_agents') && asLook.includes('hive_list_tasks') && !asLook.includes('hive_add_agent') && !asLook.includes('hive_start_task'))
  // Its lane tool says only list works there (#500); trusted at every level (sessions' trustedHiveTools, unit-tested).
  const laneTool = (envExtra) => JSON.parse(execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', env: lib.childEnv({ HIVE_API_URL: API, ...envExtra }), timeout: 10000 }).toString().split('\n')[0]).result.tools.find((t) => t.name === 'hive_lane')
  check('Look and advise: hive_lane says only list works', /only list works/.test(laneTool({ HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'look' })?.description ?? '') && !/only list works/.test(laneTool({ HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'agents' })?.description ?? ''))

  // --- HI-2328: an agent change waiting behind project.json's lock is checked again with its write. The user's own write is
  // held just before its file is replaced (as in assistantsettings), the Assistant's change queues behind it, Control is
  // lowered or the Assistant's session ends, and once the lock is free the old change changes nothing.
  const projectFile = path.join(alpha, '.hive', 'project.json')
  const holdNextWrite = () =>
    app.evaluate((_, target) => {
      const f = process.mainModule.require('original-fs/promises')
      const original = global.__hiveTestRename ?? (global.__hiveTestRename = f.rename)
      global.__hiveTestGate = { entered: false }
      f.rename = async (...args) => {
        if (!global.__hiveTestGate.entered && String(args[1]).toLowerCase() === target.toLowerCase()) {
          global.__hiveTestGate.entered = true
          await new Promise((resolve) => (global.__hiveTestGate.release = resolve))
          f.rename = original
        }
        return original(...args)
      }
    }, projectFile)
  const held = () => lib.until(() => app.evaluate(() => global.__hiveTestGate.entered), HUNG_MS)
  const release = () => app.evaluate(() => global.__hiveTestGate.release())
  // A change queued for the lock: withFileLock (fsutil.ts) sets the file's key (its path in lower case) to the queue's
  // promise in the same step as the call, so a promise set to that key while the user's write holds it is a change queued
  // behind it, past its checks before the lock (assistantsettings says more). Counted only while it waits, then put back.
  const watchLockQueue = () =>
    app.evaluate((_, lockKey) => {
      const set = (global.__hiveTestMapSet ??= Map.prototype.set)
      global.__hiveTestQueued = 0
      // eslint-disable-next-line eslint/no-extend-native -- in the test copy only, and put back once the change is queued
      Map.prototype.set = function (k, v) {
        if (k === lockKey && typeof v?.then === 'function') global.__hiveTestQueued++
        return set.call(this, k, v)
      }
    }, projectFile.toLowerCase())
  const queuedForLock = async () => {
    const queued = !!(await lib.until(() => app.evaluate(() => global.__hiveTestQueued > 0), 30000))
    await app.evaluate(() => {
      // eslint-disable-next-line eslint/no-extend-native -- putting Map's own set back
      Map.prototype.set = global.__hiveTestMapSet
    })
    return queued
  }
  // Started in the page and left there: the write is held on purpose.
  const userWrite = (value) =>
    page.evaluate(([p, v]) => {
      window.__userWrite = window.hive.invoke('project:updateConfig', p, { compactSuggestTokens: v }).then(() => 'saved', (e) => e.message)
    }, [alpha, value])
  const alphaAgents = async () => (await inv('workspace:get')).projects.find((x) => x.name === 'alpha').agents.map((a) => a.name)
  const lastRefusal = async () => (await inv('assistant:actions')).filter((a) => !a.ok).at(-1)

  // Control lowered while its rename of Checker waits: refused under the lock, Checker keeps its name.
  await holdNextWrite()
  await userWrite(300001)
  check("HI-2328: the user's write holds alpha's project.json", !!(await held()))
  await watchLockQueue()
  const renaming = api('PATCH', '/v1/projects/alpha/agents/Checker', { name: 'Renamed' })
  check("…the Assistant's rename of Checker waits behind it", await queuedForLock())
  await inv('settings:update', { assistant: { control: 'look' } })
  await release()
  const renamed = await renaming
  check('…Control lowered meanwhile: refused when its turn comes', renamed.status === 403 && /turned Settings → Assistant → Control down before this change was made/.test(renamed.body?.error ?? ''), JSON.stringify(renamed))
  check('…and Checker keeps its name', (await alphaAgents()).includes('Checker') && !(await alphaAgents()).includes('Renamed'), JSON.stringify(await alphaAgents()))
  check("…the user's write is saved", (await page.evaluate(() => window.__userWrite)) === 'saved')
  check('…listed as not done', (await lastRefusal())?.kind === 'update-agent', JSON.stringify(await lastRefusal()))
  await inv('settings:update', { assistant: { control: 'agents' } })

  // The Assistant stopped while its added agent waits: its session's change adds nothing (the Assistant isn't used after this).
  await holdNextWrite()
  await userWrite(300002)
  check("the user's write holds it again", !!(await held()))
  await watchLockQueue()
  const adding = api('POST', '/v1/projects/alpha/agents', { name: 'Late' })
  check("…the Assistant's new agent waits behind it", await queuedForLock())
  await inv('session:stop', home, 'assistant')
  check('…the Assistant stopped meanwhile', !!(await until(async () => !(await live(home, 'assistant')), HUNG_MS)))
  await release()
  const late = await adding
  check('…its session ended: refused when its turn comes', late.status === 409 && /session that asked for this ended before the change was made/.test(late.body?.error ?? ''), JSON.stringify(late))
  check('…and no agent Late is added', !(await alphaAgents()).includes('Late'), JSON.stringify(await alphaAgents()))
  check("…the user's write is saved too", (await page.evaluate(() => window.__userWrite)) === 'saved')

  // Let the agents finish before closing.
  await until(async () => !(await inv('session:live')).some((s) => s.status === 'working' || s.status === 'starting'), 30000)
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
