// An agent waiting on a background task it started: shown as background (not finished), waited for by
// cw_wait_for_agents, refused new tasks, and finished once the task's notification has run its turn. #726: a message
// still reaches it while its own background task runs (a timer it set), within seconds. The agent runs the fake Claude
// Code (fake-claude/), so nothing signs in or spends tokens. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'bg-profile')
const ws = path.join(lib.WORK, 'bg-ws')
const claudeHome = path.join(lib.WORK, 'bg-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47896))
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
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.agentApi = { enabled: true, port: Number(PORT), provideHiveMcp: true, allowSessionInput: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (p, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === agentId)
  // The doorbells Tester's CLI took (the fake records each in fake-wakes.jsonl).
  const doorbells = () => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === 'Tester' && !!w.doorbell)
  }
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }
  // Adding agents and giving them tasks is the Assistant's: start it (also the fake) and use its token.
  const info = await inv('workspace:refresh')
  const home = info.assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => (await live(home, 'assistant'))?.status === 'waiting', HUNG_MS)
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)
  const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
  const api = async (method, p, body) => {
    const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  // An agent that starts a 12-second background task and ends its turn at once.
  await page.getByText('alpha', { exact: true }).first().click()
  const added = await api('POST', '/v1/projects/alpha/agents', { name: 'Tester', prompt: 'background 12' })
  check('the agent starts on its task', added.status === 200, JSON.stringify(added.body))
  const id = added.body?.agent?.id
  await until(async () => (await live(alpha, id))?.status === 'waiting', HUNG_MS)
  await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  const bg = await until(async () => {
    const s = await live(alpha, id)
    return s?.status === 'background' && s
  }, HUNG_MS)
  check('its turn ends with the task running: background, not finished', bg?.backgroundTasks === 1, JSON.stringify(bg && { status: bg.status, tasks: bg.backgroundTasks }))
  const t0 = Date.now()

  const short = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 5 })
  check('waiting goes on through the background task', short.body?.timedOut === true && short.body.agents[0].status === 'background' && short.body.agents[0].backgroundTasks === 1, JSON.stringify(short.body))
  const ignoring = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 30, ignoreBackground: true })
  check('ignoreBackground returns at the end of its turn', ignoring.body?.timedOut === false && ignoring.body.waitedSeconds <= 2, JSON.stringify(ignoring.body))
  const refused = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'something else' })
  check('no new task while it waits on its background task', refused.status === 409 && /background task/.test(refused.body?.error ?? ''), JSON.stringify(refused.body))
  const runId = (await inv('session:live')).find((s) => s.agentName === 'Tester')?.runId
  const fresh = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'something else', newConversation: true })
  const still = (await inv('session:live')).find((s) => s.agentName === 'Tester')
  check('nor a new conversation (#437): its run goes on', fresh.status === 409 && /background task/.test(fresh.body?.error ?? '') && !!runId && still?.runId === runId, JSON.stringify(fresh.body))
  const act = (await api('GET', '/v1/projects/alpha/agents/Tester/activity')).body
  check('its activity counts the task', act?.status === 'background' && act.backgroundTasks === 1, JSON.stringify(act && { status: act.status, tasks: act.backgroundTasks }))
  const status = await page.locator('.pane-status').first().innerText().catch(() => '')
  check("the pane says what it's waiting on", /Waiting on 1 background task/.test(status), status)
  await page.screenshot({ path: path.join(lib.WORK, 'background.png') })
  const overview = (await api('GET', '/v1/projects/alpha')).body
  check('the project status shows it too', overview?.agents?.[0]?.status === 'background' && overview.agents[0].backgroundTasks === 1, JSON.stringify(overview?.agents))

  // The task ends: its notification starts a turn by itself, which then ends with nothing left running.
  const done = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 60 })
  const a = done.body?.agents?.[0]
  check('waiting returns once the task has ended and the agent finished', done.body?.timedOut === false && a?.status === 'finished' && a.backgroundTasks === 0 && Date.now() - t0 >= 9000, JSON.stringify(done.body))
  const after = (await api('GET', '/v1/projects/alpha/agents/Tester/activity')).body
  check('it replied to the task notification', /background task .* has finished/.test(after?.latestReply ?? ''), after?.latestReply)
  const given = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'work 1' })
  check('then it takes a task again', given.status === 200, JSON.stringify(given.body))
  await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 30 })

  // #1584: two subagents run in the background (the Agent tool's async_launched) keep it in the background, not
  // finished, through the first one's end (its notification's turn) until the second ends.
  const subs = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'subagent 6 subagent 14' })
  const two = await until(async () => {
    const s = await live(alpha, id)
    return s?.status === 'background' && s.backgroundTasks === 2 && s
  }, HUNG_MS)
  check('its turn ends with two subagents running: background, two tasks (#1584)', subs.status === 200 && !!two, JSON.stringify(await live(alpha, id)))
  // Its turn for the first one's end has replied and is over (the count drops when the end is read, before that turn).
  const one = await until(async () => {
    const s = await live(alpha, id)
    const reply = (await api('GET', '/v1/projects/alpha/agents/Tester/activity')).body?.latestReply ?? ''
    return s?.backgroundTasks === 1 && s.status === 'background' && /subagent Review part 1 has finished/.test(reply) && s
  }, HUNG_MS)
  check("the first one's end leaves it in the background, the other running", !!one, JSON.stringify(await live(alpha, id)))
  const subsDone = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 60 })
  const last = subsDone.body?.agents?.[0]
  check('it finishes once the last subagent has ended', subsDone.body?.timedOut === false && last?.status === 'finished' && last.backgroundTasks === 0, JSON.stringify(subsDone.body))

  // #712: a launch's task is on its CLI's command line, taken only after SessionStart. Held there (the fake keeps it
  // until fake-launch-go), the agent is ready but hasn't begun its task: a wait doesn't take that for idle.
  fs.writeFileSync(path.join(claudeHome, 'fake-launch-hold-Tester'), '')
  const before = (await live(alpha, id))?.runId
  const renewed = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'work 1', newConversation: true })
  check('a new conversation on a task starts (#712)', renewed.status === 200, JSON.stringify(renewed.body))
  const ready = await until(async () => {
    const s = await live(alpha, id)
    return s?.runId !== before && s?.status === 'ready' && s
  }, HUNG_MS)
  check('its CLI is ready, its task held', !!ready, JSON.stringify(await live(alpha, id)))
  // #721: a message left in that gap rings its doorbell only once its CLI has taken the task (typed before, the task's
  // prompt would be taken for the doorbell's, and the doorbell would go first). Left before the gap's 5 s wait below,
  // which is when it would have rung.
  const rangBefore = doorbells().length
  const inGap = await api('POST', '/v1/projects/alpha/agents/Tester/message', { text: 'The release notes are in the shared notes.' })
  const held = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 5 })
  check('a wait in that gap waits: the task counts as given (#712)', held.body?.timedOut === true && held.body.agents[0].status === 'ready', JSON.stringify(held.body))
  check('no doorbell is typed in that gap (#721)', inGap.status === 200 && doorbells().length === rangBefore, JSON.stringify({ left: inGap.body, rang: doorbells().length - rangBefore }))
  const busyNow = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'something else' })
  check('and nothing more is given it meanwhile', busyNow.status === 409 && /hasn't taken yet/.test(busyNow.body?.error ?? ''), JSON.stringify(busyNow.body))
  const goAt = new Date().toISOString()
  fs.writeFileSync(path.join(claudeHome, 'fake-launch-go-Tester'), '')
  const took = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 30 })
  check('once it takes the task, the wait ends with the task done', took.body?.timedOut === false && took.body.agents[0].status === 'finished', JSON.stringify(took.body))
  // It hears of it after the task (at its turn's end, or by a doorbell then), and reads it.
  const gapRead = await until(async () => {
    const inbox = (await api('GET', '/v1/projects/alpha/agents/Tester/activity')).body?.inbox
    return !!inbox?.deliveries?.some((d) => d.id === inGap.body?.id && (d.state === 'received' || d.state === 'acked'))
  }, HUNG_MS)
  const early = doorbells().slice(rangBefore).filter((w) => w.at < goAt)
  check('then it reads the message, nothing typed before its task was taken (#721)', gapRead && early.length === 0, JSON.stringify({ early, goAt, read: gapRead }))
  await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 30 })

  // #726: its turn over while a long background task of its own runs (a timer to renew a merge slot, say), a message
  // rings its doorbell within seconds, not once the task ends; it reads the message from its inbox.
  const timer = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'background 60' })
  const timing = await until(async () => {
    const s = await live(alpha, id)
    return s?.status === 'background' && s.backgroundTasks === 1 && s
  }, HUNG_MS)
  check('it waits on a long background task of its own', timer.status === 200 && !!timing, JSON.stringify(timer.body))
  const rang = doorbells().length
  const t1 = Date.now()
  const left = await api('POST', '/v1/projects/alpha/agents/Tester/message', { text: 'Darren pushed the tag: carry on with the release.' })
  const heard = await until(async () => doorbells().length > rang, HUNG_MS)
  const during = await live(alpha, id)
  check('a message rings its doorbell within seconds while the task runs', left.status === 200 && !!heard && Date.now() - t1 < 15000 && during?.backgroundTasks === 1, JSON.stringify({ left: left.body, ms: Date.now() - t1, tasks: during?.backgroundTasks }))
  const read = await until(async () => {
    const inbox = (await api('GET', '/v1/projects/alpha/agents/Tester/activity')).body?.inbox
    return !!inbox?.deliveries?.some((d) => d.id === left.body?.id && (d.state === 'received' || d.state === 'acked'))
  }, HUNG_MS)
  check('it reads the message from its inbox', !!read, JSON.stringify((await api('GET', '/v1/projects/alpha/agents/Tester/activity')).body?.inbox))

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
