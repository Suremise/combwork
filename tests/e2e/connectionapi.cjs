// The Agent API and connections (HI-1771, S4; HI-2108: connections are setups on accounts; the test seam off so the real
// rule applies): GET /v1/connections as each caller may see it (the workspace token and the Assistant every connection
// and account, a project agent only those usable in its workspace, without extra arguments; details=true widens nothing;
// never a folder; another one asked after by id or name is 404 to an agent); the Assistant adds and changes agents by
// connection name or id (two sharing a name: 409; unknown: 404; one whose account is off here: 409), provider, model,
// effort, mode and context200k refused naming the connections to use (decision D), an unrelated change keeping it and
// null giving its CLI's first usable one; a card started on a new agent takes connection the same way, provider refused
// (HI-2121); cw_connection makes and changes a connection only with Change settings on;
// the status shows the chosen connection and the account it runs on, with the connection on it the run launched with
// (HI-2406: two on one account told apart). The fake Claude Code signs in, no browser.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
const PORT = Number(lib.port(47794))

const userData = path.join(lib.WORK, 'connectionapi-profile')
const home = path.join(lib.WORK, 'connectionapi-claude-home')
const ws = path.join(lib.WORK, 'connectionapi-ws')
const alpha = path.join(ws, 'alpha')
const assistantHome = path.join(ws, '.combwork', 'assistant')
const accountsRoot = path.join(userData, 'accounts')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }] }))

  const { app, page } = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const liveNow = () => inv('session:live').catch(() => null)
  /**
   * Stops every session still live, each on its own (one that fails leaves the rest to stop), and waits until none is:
   * the sessions left, [] once all have stopped (HI-2180: one still in its turn as the copy closes is asked about,
   * Confirm on quit's default, and that question held app.close() until the runner's 10 minutes).
   */
  const stopAll = async () => {
    await Promise.all(((await liveNow()) ?? []).map((l) => inv('session:stop', l.projectPath, l.agentId).catch(() => undefined)))
    await lib.until(async () => (await liveNow())?.length === 0, HUNG_MS)
    return ((await liveNow()) ?? [{ agentId: '(the window no longer answers)' }]).map((l) => [l.agentId, l.status])
  }
  let stopped = false
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const userToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body, token = userToken) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Combwork-Workspace': encodeURIComponent(ws) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const live = async (project, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === project.toLowerCase() && s.agentId === agentId && s.status !== 'stopped') ?? null

    // --- Five connections: Max 1, Max 2, two named Twin (on here), and Other (not on here).
    const connect = async (name, email, on = true) => {
      fs.mkdirSync(accountsRoot, { recursive: true })
      fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email, orgId: 'org-1' }))
      const a = await inv('connections:add', 'claude-code', name)
      fs.writeFileSync(path.join(accountsRoot, a.id, 'fake-trusted.json'), JSON.stringify([alpha, ws, assistantHome].map((f) => f.toLowerCase())))
      await inv('connections:signIn', a.id)
      await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === a.id && c.accepted?.email === email) ?? null, HUNG_MS)
      if (on) await inv('connections:setOn', a.id, true)
      return a
    }
    const max1 = await connect('Max 1', 'one@example.com')
    const max2 = await connect('Max 2', 'two@example.com')
    const twinA = await connect('Twin', 'ta@example.com')
    const twinB = await connect('Twin', 'tb@example.com')
    const other = await connect('Other', 'other@example.com', false)

    // Each account's base connection (HI-2106: made with it, named after it): what an agent chooses.
    const rows = (await inv('connections:list')).connectionRows
    const base = (a) => rows.find((c) => c.account === a.id)?.id
    const [c1, c2, cTa, cTb, cOther] = [max1, max2, twinA, twinB, other].map(base)

    // --- The workspace token (HI-2108): every connection, with its account, CLI and values, and `usable: false` on one
    // whose account is off here; every account, with on and identity; nothing of where a login is kept.
    // Claude Code's (GitHub Copilot's sign-in is an account with its connection too, decision C: left out here).
    const claude = (list) => (list ?? []).filter((c) => c.cli === 'claude-code')
    const all = await api('GET', '/v1/connections')
    const byId = Object.fromEntries(claude(all.body?.connections).map((c) => [c.id, c]))
    const accountsById = Object.fromEntries((all.body?.accounts ?? []).map((a) => [a.id, a]))
    check('the workspace token sees every connection, its account named, usable or not', all.status === 200 && Object.keys(byId).length === 5 && byId[c1]?.account === 'Max 1' && byId[c1]?.cli === 'claude-code' && !('usable' in byId[c1]) && byId[cOther]?.usable === false, JSON.stringify(all.body?.connections))
    check('…and every account, with on and who it is signed in as', Object.keys(accountsById).length === 5 && accountsById[other.id]?.on === false && accountsById[max1.id]?.on === true && accountsById[max1.id]?.email === 'one@example.com', JSON.stringify(all.body?.accounts))
    const raw = JSON.stringify(all.body) + JSON.stringify((await api('GET', '/v1/connections?details=true')).body) + JSON.stringify((await api('GET', `/v1/connections/${c1}?details=true`)).body)
    check('…never a folder, a path or raw login records, details or not; no default (decision A)', !/folder|accounts\\|\\\\|observed|accepted|orgId/.test(raw) && !('defaults' in (all.body ?? {})), raw.slice(0, 300))

    // --- A project agent (One, running on Max 1): only those usable in its workspace, without extra arguments.
    await inv('session:start', alpha, { agentId: 'a-one' })
    const sessionId = await lib.until(async () => (await live(alpha, 'a-one'))?.sessionId, HUNG_MS)
    const launch = await lib.until(() => lines(path.join(accountsRoot, max1.id, 'fake-launches.jsonl')).find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
    const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
    const agentToken = hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    check("One's own Agent API token found", !!agentToken)
    const mine = await api('GET', '/v1/connections?details=true', null, agentToken)
    const ids = claude(mine.body?.connections).map((c) => c.id).sort()
    check('a project agent sees only the connections usable in its workspace (Other left out), details or not', mine.status === 200 && ids.join() === [c1, c2, cTa, cTb].sort().join(), JSON.stringify(mine.body))
    check('…their id, name, account, CLI and values alone; accounts with four fields', (mine.body?.connections ?? []).every((c) => Object.keys(c).every((k) => ['id', 'name', 'account', 'cli', 'model', 'effort', 'context200k', 'mode'].includes(k))) && (mine.body?.accounts ?? []).every((a) => Object.keys(a).sort().join() === 'cli,id,kind,name,signedIn'), JSON.stringify(mine.body))
    const hidden = [await api('GET', `/v1/connections/${cOther}`, null, agentToken), await api('GET', '/v1/connections/Other', null, agentToken)]
    check('…Other asked after by id or by name: 404, as if there were none', hidden.every((r) => r.status === 404), JSON.stringify(hidden.map((r) => r.status)))
    check('…one usable here, by name: it', (await api('GET', '/v1/connections/max%202', null, agentToken)).body?.id === c2)

    // --- The status: One's connection (none of its own before HI-2106: pinned to the one it ran on) and its run's account.
    const one = (await api('GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.id === 'a-one')
    check("the status: One is on Max 1's base connection (HI-2106), named, and runs on Max 1", one?.connection?.id === c1 && one?.connection?.name === 'Max 1' && one?.launchedConnection?.id === max1.id, JSON.stringify(one && { connection: one.connection, launchedConnection: one.launchedConnection }))

    // --- The Assistant: started on the first usable, its token, then agents by connection.
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    const ready = await lib.until(async () => {
      const st = await live(assistantHome, 'assistant')
      if (st?.status === 'waiting') await inv('pty:write', lib.ptyKey(assistantHome, 'assistant'), '\r')
      return st?.status === 'ready' || st?.status === 'finished'
    }, HUNG_MS)
    check('the Assistant starts', !!ready)
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const assistantToken = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
    const asAssistant = (method, route, body) => api(method, route, body, assistantToken)
    check('the Assistant sees every connection', claude((await asAssistant('GET', '/v1/connections')).body?.connections).length === 5)
    const add = async (name, extra) => asAssistant('POST', '/v1/projects/alpha/agents', { name, ...extra })
    const byName = await add('Vianame', { connection: 'max 2' })
    const viaRow = byName.body?.project?.agents?.find((a) => a.name === 'Vianame')
    check('the Assistant adds an agent by connection name: on Max 2, its CLI Claude Code', byName.status === 200 && viaRow?.connection?.id === c2 && viaRow?.connection?.name === 'Max 2' && viaRow.provider === 'claude-code', JSON.stringify({ status: byName.status, body: byName.body?.error ?? viaRow }))
    const twin = await add('Twinned', { connection: 'Twin' })
    check('…a name two share: 409, naming both ids', twin.status === 409 && twin.body?.error?.includes(cTa) && twin.body?.error?.includes(cTb), JSON.stringify(twin))
    const nope = await add('Nowhere', { connection: 'Nope' })
    check('…an unknown one: 404', nope.status === 404, JSON.stringify(nope))
    const viaId = await add('Viaid', { connection: cTa })
    check('…by id: on that one', viaId.status === 200 && viaId.body?.project?.agents?.find((a) => a.name === 'Viaid')?.connection?.id === cTa, JSON.stringify(viaId.body?.error ?? ''))
    const offHere = await add('Offhere', { connection: cOther })
    check('…one whose account is off here (by id): 409, nothing added', offHere.status === 409 && !(await api('GET', '/v1/projects/alpha')).body?.agents?.some((a) => a.name === 'Offhere'), JSON.stringify(offHere))
    // Decision D (HI-2108): the old settings are refused, naming the connections to use; nothing is added.
    const old = await add('Oldway', { provider: 'claude-code', model: 'opus' })
    check("…provider and model: 400, naming the first usable account's connections, nothing added", old.status === 400 && /provider, model/.test(old.body?.error ?? '') && /On Max 1: Max 1/.test(old.body?.error ?? '') && !(await api('GET', '/v1/projects/alpha')).body?.agents?.some((a) => a.name === 'Oldway'), JSON.stringify(old))
    const viaAgent = (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Vianame')
    const oldPatch = await asAssistant('PATCH', `/v1/projects/alpha/agents/${viaAgent.id}`, { effort: 'high' })
    check("a change of effort: 400, naming its account's connections; its connection kept", oldPatch.status === 400 && /On Max 2: Max 2/.test(oldPatch.body?.error ?? '') && (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Vianame')?.connection?.id === c2, JSON.stringify(oldPatch))
    await asAssistant('PATCH', `/v1/projects/alpha/agents/${viaAgent.id}`, { workflowRole: 'reviewer' })
    check('an unrelated change keeps its connection', (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Vianame')?.connection?.id === c2)
    await asAssistant('PATCH', `/v1/projects/alpha/agents/${viaAgent.id}`, { connection: null })
    check('…null: its CLI’s first usable one (HI-2106, decision H)', (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Vianame')?.connection?.id === c1)
    const projectAgent = await api('POST', '/v1/projects/alpha/agents', { name: 'Sneaky', connection: 'Max 1' }, agentToken)
    check('a project agent may not add agents (403), connection or not', projectAgent.status === 403, JSON.stringify(projectAgent))

    // --- cw_start_task on a new agent (HI-2121): connection as cw_add_agent takes it; provider refused (decision D).
    const card = (await api('POST', '/v1/tasks', { title: 'Started by connection', project: 'alpha' })).body?.number
    const column = async () => (await api('GET', `/v1/tasks/${card}`)).body?.column
    const oldStart = await asAssistant('POST', `/v1/tasks/${card}/start`, { name: 'Bystart', provider: 'claude-code' })
    check("a start on a new agent with provider: 400, naming the first usable account's connections; nothing added or moved", oldStart.status === 400 && /provider/.test(oldStart.body?.error ?? '') && /On Max 1: Max 1/.test(oldStart.body?.error ?? '') && (await column()) === 'todo' && !(await api('GET', '/v1/projects/alpha')).body?.agents?.some((a) => a.name === 'Bystart'), JSON.stringify(oldStart))
    const withAgent = await asAssistant('POST', `/v1/tasks/${card}/start`, { agent: 'One', connection: 'Max 2' })
    check('…a connection with an existing agent: 400, nothing moved', withAgent.status === 400 && /new agent/.test(withAgent.body?.error ?? '') && (await column()) === 'todo', JSON.stringify(withAgent))
    const offStart = await asAssistant('POST', `/v1/tasks/${card}/start`, { name: 'Bystart', connection: 'Other' })
    check('…a connection not usable here: 404, nothing moved', offStart.status === 404 && (await column()) === 'todo', JSON.stringify(offStart))
    const started = await asAssistant('POST', `/v1/tasks/${card}/start`, { name: 'Bystart', connection: 'max 2', reply: 'short' })
    const starter = (await api('GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Bystart')
    check('…by connection name: a new agent on Max 2, its CLI Claude Code, the card in Doing', started.status === 200 && started.body?.added === true && starter?.connection?.id === c2 && starter?.provider === 'claude-code' && (await column()) === 'doing', JSON.stringify({ status: started.status, body: started.body?.error ?? starter }))
    // --- cw_connection (HI-2108): the Assistant makes and changes a connection, only with Change settings on.
    const before = (await inv('connections:list')).connectionRows.length
    const shut = await asAssistant('POST', '/v1/connections', { account: 'Max 2', name: 'Max 2 · High', effort: 'high' })
    check('making a connection with Change settings off: 403, nothing made', shut.status === 403 && /Change settings is off/.test(shut.body?.error ?? '') && (await inv('connections:list')).connectionRows.length === before, JSON.stringify(shut))
    await inv('settings:update', { assistant: { changeSettings: true } })
    const made = await asAssistant('POST', '/v1/connections', { account: 'Max 2', name: 'Max 2 · High', effort: 'high' })
    check('…on: made on the account named, as listed', made.status === 200 && made.body?.name === 'Max 2 · High' && made.body?.account === 'Max 2' && made.body?.effort === 'high', JSON.stringify(made))
    const noAccount = await asAssistant('POST', '/v1/connections', { account: 'Nobody', name: 'X' })
    check('…on an account that isn’t there: 404 (accounts are the user’s)', noAccount.status === 404, JSON.stringify(noAccount))
    const changed = await asAssistant('PATCH', `/v1/connections/${encodeURIComponent('Max 2 · High')}`, { mode: 'plan', effort: '' })
    check('…changed by name: its mode set, its effort back to the CLI’s', changed.status === 200 && changed.body?.mode === 'plan' && !('effort' in (changed.body ?? {})), JSON.stringify(changed))
    const onIt = await asAssistant('PATCH', `/v1/projects/alpha/agents/${viaAgent.id}`, { connection: 'Max 2 · High' })
    check('…and an agent pointed at it', onIt.status === 200 && (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Vianame')?.connection?.id === made.body?.id, JSON.stringify(onIt.body?.error ?? ''))
    const byAgent = await api('POST', '/v1/connections', { account: 'Max 1', name: 'Sneaky' }, agentToken)
    check('a project agent may not make connections (403)', byAgent.status === 403, JSON.stringify(byAgent))
    await inv('settings:update', { assistant: { changeSettings: false } })

    // --- HI-2406: two runs on one account (Max 1), each on its own connection: the status names the connection each
    // launched with, beside the account, for the workspace and for a project agent (both usable here).
    const sonnet = await inv('connection:add', max1.id, { name: 'Max 1 · Sonnet', model: 'sonnet' })
    const viaid = (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Viaid')
    const moved = await asAssistant('PATCH', `/v1/projects/alpha/agents/${viaid.id}`, { connection: sonnet.id })
    check('Viaid moved onto Max 1 · Sonnet', moved.status === 200 && (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.id === viaid.id)?.connection?.id === sonnet.id, JSON.stringify({ status: moved.status, error: moved.body?.error, sonnet }))
    await inv('session:start', alpha, { agentId: viaid.id })
    const runs = async (token) => {
      const agents = (await api('GET', '/v1/projects/alpha', null, token)).body?.agents ?? []
      return Object.fromEntries(['a-one', viaid.id].map((id) => [id, agents.find((a) => a.id === id)?.launchedConnection ?? null]))
    }
    const both = await lib.until(async () => {
      const r = await runs()
      return r[viaid.id]?.connection ? r : null
    }, HUNG_MS)
    const named = (r) => !!r && r['a-one']?.id === max1.id && r['a-one']?.name === 'Max 1' && r['a-one']?.connection?.id === c1 && r['a-one']?.connection?.name === 'Max 1' && r[viaid.id]?.id === max1.id && r[viaid.id]?.connection?.id === sonnet.id && r[viaid.id]?.connection?.name === 'Max 1 · Sonnet'
    check('the status: One and Viaid both run on Max 1, each naming the connection it launched with (HI-2406)', named(both), JSON.stringify(both))
    const asAgent = await runs(agentToken)
    check('…and so for a project agent: both are usable in its workspace', named(asAgent), JSON.stringify(asAgent))

    // Every session the suite started, Bystart's too.
    const left = await stopAll()
    stopped = left.length === 0
    check('every session it started has stopped, so the copy closes without asking', stopped, JSON.stringify(left))
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    // On a failure too: what is still running is stopped, and the close never waits on a question nobody answers.
    if (!stopped) {
      const left = await stopAll()
      if (left.length) check('after the failure, every session it started has stopped', false, JSON.stringify(left))
    }
    await inv('settings:update', { general: { confirmOnQuit: 'never' } }).catch(() => undefined)
    const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), HUNG_MS))])
    if (!closed) check('the copy closes', false, `still open after ${HUNG_MS} ms: the runner ends what is left`)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
