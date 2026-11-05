// A doorbell only once the hive tools are there (#865): a resumed Claude Code is ready at its SessionStart before its
// hive MCP server has connected, and a doorbell then is a turn that can't call cw_inbox. The launch's hive server
// tells Combwork when the CLI has connected it (POST /v1/launch/connected, with the launch's own token); until then Combwork
// types no line into the session, at most Settings → Advanced → "hive tools: wait to connect" from when it became ready.
// On fake Claude Code (fake-claude/), which connects the real hive server as it starts, or holds it back while
// fake-mcp-hold-<agent> is in its home until the test makes fake-mcp-go-<agent>:
// 1. Resumed with its connection held: a message waits (no doorbell), and once it connects, one doorbell rings and the
//    message is read. A task given while held waits too (round 3: it was refused), and is given once it connects.
// 2. The route: only the launch's own token; the workspace's, none, or an ended launch's are refused.
// 3. Never connected (held to the end): the doorbell rings once the bound (set to 3 s here) has passed.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
const { deliveriesOf } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'hivetools-profile')
const ws = path.join(lib.WORK, 'hivetools-ws')
const claudeHome = path.join(lib.WORK, 'hivetools-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47873))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const call = async (method, route, body, token = apiToken) => {
      const r = await fetch(API + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    // The Assistant gives tasks and leaves messages (the routes are its own): calls with its launch's token.
    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    const assistantNow = async () => (await inv('session:live')).find((s) => s.agentId === 'assistant')?.status
    check('the Assistant starts', !!(await until(async () => ['ready', 'finished'].includes(await assistantNow()), HUNG_MS)), await assistantNow())
    const asAssistant = (method, route, body) => call(method, route, body, JSON.parse(fs.readFileSync(asTokenFile, 'utf8')).token)
    // Combwork's doorbells in the builder's conversation (#650: a prompt "[CW] New in your inbox: …", read with cw_inbox).
    let sessionId = ''
    const bells = () => {
      const dir = path.join(claudeHome, 'projects')
      const f = fs.existsSync(dir) ? fs.readdirSync(dir).map((d) => path.join(dir, d, `${sessionId}.jsonl`)).find((x) => fs.existsSync(x)) : null
      if (!f) return []
      return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.startsWith('[CW] New in your inbox')).map((e) => e.message.content)
    }
    const delivery = (id) => deliveriesOf(alpha).find((d) => d.id === id) ?? null
    const hold = () => fs.writeFileSync(path.join(claudeHome, 'fake-mcp-hold-Builder'), '')
    const go = () => fs.writeFileSync(path.join(claudeHome, 'fake-mcp-go-Builder'), '')

    await page.getByText('alpha', { exact: true }).first().click()
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    await inv('session:start', alpha, { agentId: builder.id })
    check('the builder starts', !!(await until(() => idle(builder.id), HUNG_MS)))
    sessionId = (await live(builder.id)).sessionId
    // Its first launch's token, which stops working when that launch ends.
    const tokenDir = path.join(userData, 'agent-api')
    const firstToken = JSON.parse(fs.readFileSync(path.join(tokenDir, fs.readdirSync(tokenDir)[0]), 'utf8')).token
    // Started fresh, its tools connect as it starts: a message is told to it at once.
    const m0 = await asAssistant('POST', `/v1/projects/alpha/agents/Builder/message`, { text: 'Hello from the suite (fresh start).' })
    check('a message for a fresh launch is given', m0.status === 200 && !!(await until(() => delivery(m0.body?.id)?.state === 'acked' || delivery(m0.body?.id)?.state === 'received', HUNG_MS)), JSON.stringify(m0))
    const bellsFresh = bells().length

    // --- 1. Resumed, with its hive server's connection held back.
    await inv('session:stop', alpha, builder.id)
    check('the builder stops', !!(await until(async () => !(await live(builder.id)), HUNG_MS)))
    hold()
    await inv('session:start', alpha, { agentId: builder.id, resumeId: sessionId })
    check('it is resumed and ready', !!(await until(() => idle(builder.id), HUNG_MS)))
    const m1 = await asAssistant('POST', `/v1/projects/alpha/agents/Builder/message`, { text: 'Hello from the suite (resumed).' })
    // Leaving it offered it before the reply (leaveMessage awaits its offer): typed false is that offer held by the gate.
    check('a message is queued, not told', m1.status === 200 && m1.body?.typed === false && delivery(m1.body.id)?.state === 'queued', JSON.stringify(m1))
    check('no doorbell while held', bells().length === bellsFresh && delivery(m1.body.id)?.state === 'queued', `${bells().length} bells, ${delivery(m1.body.id)?.state}`)
    go()
    check('once connected, the message is read', !!(await until(() => ['received', 'acked'].includes(delivery(m1.body.id)?.state), HUNG_MS)), delivery(m1.body.id)?.state)
    check('with one doorbell', bells().length === bellsFresh + 1 && bells().at(-1).includes(m1.body.id), JSON.stringify(bells().slice(bellsFresh)))

    // --- 1b. A task given while its tools are connecting waits for them (round 3), then goes in: one doorbell.
    await inv('session:stop', alpha, builder.id)
    check('the builder stops (1b)', !!(await until(async () => !(await live(builder.id)), HUNG_MS)))
    hold()
    await inv('session:start', alpha, { agentId: builder.id, resumeId: sessionId })
    check('it is resumed and ready (1b)', !!(await until(() => idle(builder.id), HUNG_MS)))
    const bellsTask = bells().length
    let taskReply = null
    const taskCall = asAssistant('POST', `/v1/projects/alpha/agents/Builder/prompt`, { text: 'work 1' }).then((r) => (taskReply = r))
    const taskRecord = () => deliveriesOf(alpha).find((d) => d.kind === 'task' && d.body === 'work 1') ?? null
    check('a task while held is kept waiting, not refused', !!(await until(() => taskRecord()?.state === 'queued', HUNG_MS)) && taskReply === null, JSON.stringify({ record: taskRecord(), taskReply }))
    check('…with no doorbell', bells().length === bellsTask)
    go()
    await taskCall
    check('once connected, the task is given', taskReply?.status === 200 && !!taskReply.body?.ok, JSON.stringify(taskReply))
    check('…with one doorbell', !!(await until(() => bells().length === bellsTask + 1, HUNG_MS)) && bells().at(-1).includes(taskReply?.body?.id ?? '?'), JSON.stringify(bells().slice(bellsTask)))
    check('…and read', !!(await until(() => ['received', 'acked'].includes(taskRecord()?.state), HUNG_MS)), taskRecord()?.state)
    await until(() => idle(builder.id), HUNG_MS)

    // --- 2. Only the launch's own token says it has connected.
    const nowToken = JSON.parse(fs.readFileSync(path.join(tokenDir, fs.readdirSync(tokenDir)[0]), 'utf8')).token
    const own = await call('POST', '/v1/launch/connected', {}, nowToken)
    check("the launch's own token is taken", own.status === 200 && own.body?.ok === true, JSON.stringify(own))
    const script = await call('POST', '/v1/launch/connected', {})
    check("the workspace's token is refused", script.status === 403, JSON.stringify(script))
    const none = await call('POST', '/v1/launch/connected', {}, '')
    check('no token is refused', none.status === 401, JSON.stringify(none))
    const old = await call('POST', '/v1/launch/connected', {}, firstToken)
    check("an ended launch's token is refused", old.status === 401 && firstToken !== nowToken, JSON.stringify(old))

    // --- 3. Never connected: the bound (3 s here) lets the doorbell through.
    await inv('advanced:set', 'cw.mcp.connectSeconds', 3)
    await inv('session:stop', alpha, builder.id)
    check('the builder stops again', !!(await until(async () => !(await live(builder.id)), HUNG_MS)))
    hold()
    await inv('session:start', alpha, { agentId: builder.id, resumeId: sessionId })
    check('resumed again', !!(await until(() => idle(builder.id), HUNG_MS)))
    const m2 = await asAssistant('POST', `/v1/projects/alpha/agents/Builder/message`, { text: 'Hello from the suite (never connected).' })
    check('a message for it is taken', m2.status === 200, JSON.stringify(m2))
    check('after the bound, it is told anyway', !!(await until(() => ['received', 'acked'].includes(delivery(m2.body.id)?.state), HUNG_MS)), delivery(m2.body.id)?.state)
    check('with one doorbell', bells().length === bellsFresh + 3 && bells().at(-1).includes(m2.body.id), JSON.stringify(bells().slice(bellsFresh)))
    // Its held connection ends with the launch.
    go()
    await inv('session:stop', alpha, builder.id)
  } catch (e) {
    check('no errors', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})()
