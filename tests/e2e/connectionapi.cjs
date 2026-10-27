// The Agent API and connections (HI-1771, S4; behind Settings → Advanced → Connections (preview), the test seam off so
// the real rule applies): GET /v1/connections as each caller may see it (the workspace token and the Assistant every
// connection, a project agent only those on in its workspace, four fields; details=true widens nothing; never a folder
// or defaults; another one asked after by id or name is 404 to an agent); the Assistant adds and changes agents by
// connection name or id (two sharing a name: 409; unknown: 404; one off here: 409; another CLI than the provider: 409),
// an unrelated change keeping it and null clearing it; the status shows the chosen and the running connection; with the
// preview off, the routes and the field are refused. The fake Claude Code signs in, no browser.
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
const assistantHome = path.join(ws, '.hive', 'assistant')
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
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }] }))

  const { app, page } = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await inv('advanced:set', 'hive.accounts.preview', true)
    await lib.openWorkspace(inv, page, ws)
    const userToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body, token = userToken) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Hive-Workspace': encodeURIComponent(ws) }, ...(body ? { body: JSON.stringify(body) } : {}) })
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

    // --- The workspace token: every connection, with on, default and identity; nothing of where a login is kept.
    const all = await api('GET', '/v1/connections')
    const byId = Object.fromEntries((all.body?.connections ?? []).map((c) => [c.id, c]))
    check('the workspace token sees every connection, on or not', all.status === 200 && Object.keys(byId).length === 5 && byId[other.id]?.on === false && byId[max1.id]?.on === true && byId[max1.id]?.default === true && byId[max1.id]?.email === 'one@example.com', JSON.stringify(all.body))
    const raw = JSON.stringify(all.body) + JSON.stringify((await api('GET', '/v1/connections?details=true')).body) + JSON.stringify((await api('GET', `/v1/connections/${max1.id}?details=true`)).body)
    // (The reply's own `defaults` is each CLI's default connection id; no connection carries its model defaults.)
    const items = (all.body?.connections ?? []).concat((await api('GET', '/v1/connections?details=true')).body?.connections ?? [])
    check('…never a folder, a path, its defaults or raw login records, details or not', !/folder|accounts|\\\\|observed|accepted|orgId/.test(raw) && items.every((c) => !('defaults' in c) && !('defaultsFrom' in c)), raw.slice(0, 300))
    check('…and the defaults per CLI', all.body?.defaults?.['claude-code'] === max1.id)

    // --- A project agent (One, running on Max 1): only those on in its workspace, four fields.
    await inv('session:start', alpha, { agentId: 'a-one' })
    const sessionId = await lib.until(async () => (await live(alpha, 'a-one'))?.sessionId, HUNG_MS)
    const launch = await lib.until(() => lines(path.join(accountsRoot, max1.id, 'fake-launches.jsonl')).find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
    const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.hive : null
    const agentToken = hive ? JSON.parse(fs.readFileSync(hive.env.HIVE_API_TOKEN_FILE, 'utf8')).token : null
    check("One's own Agent API token found", !!agentToken)
    const mine = await api('GET', '/v1/connections?details=true', null, agentToken)
    const ids = (mine.body?.connections ?? []).map((c) => c.id).sort()
    check('a project agent sees only those on in its workspace (Other left out), details or not', mine.status === 200 && ids.join() === [max1.id, max2.id, twinA.id, twinB.id].sort().join(), JSON.stringify(mine.body))
    check('…with four fields alone', (mine.body?.connections ?? []).every((c) => Object.keys(c).sort().join() === 'cli,id,kind,name,signedIn'), JSON.stringify(mine.body?.connections?.[0]))
    const hidden = [await api('GET', `/v1/connections/${other.id}`, null, agentToken), await api('GET', '/v1/connections/Other', null, agentToken)]
    check('…Other asked after by id or by name: 404, as if there were none', hidden.every((r) => r.status === 404), JSON.stringify(hidden.map((r) => r.status)))
    check('…one on here, by name: its four fields', (await api('GET', '/v1/connections/max%202', null, agentToken)).body?.id === max2.id)

    // --- The status: One's chosen connection (the default: null) and the one its run is on.
    const one = (await api('GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.id === 'a-one')
    check('the status: One follows the default (connection null), runs on Max 1', one?.connection === null && one?.launchedConnection?.id === max1.id, JSON.stringify(one && { connection: one.connection, launchedConnection: one.launchedConnection }))

    // --- The Assistant: started on the workspace's default, its token, then agents by connection.
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
    check('the Assistant sees every connection', ((await asAssistant('GET', '/v1/connections')).body?.connections ?? []).length === 5)
    const add = async (name, extra) => asAssistant('POST', '/v1/projects/alpha/agents', { name, ...extra })
    const byName = await add('Vianame', { connection: 'max 2' })
    const viaRow = byName.body?.project?.agents?.find((a) => a.name === 'Vianame')
    check('the Assistant adds an agent by connection name: on Max 2, its CLI Claude Code', byName.status === 200 && viaRow?.connection?.id === max2.id && viaRow?.connection?.name === 'Max 2' && viaRow.provider === 'claude-code', JSON.stringify({ status: byName.status, body: byName.body?.error ?? viaRow }))
    const twin = await add('Twinned', { connection: 'Twin' })
    check('…a name two share: 409, naming both ids', twin.status === 409 && twin.body?.error?.includes(twinA.id) && twin.body?.error?.includes(twinB.id), JSON.stringify(twin))
    const nope = await add('Nowhere', { connection: 'Nope' })
    check('…an unknown one: 404', nope.status === 404, JSON.stringify(nope))
    const viaId = await add('Viaid', { connection: twinA.id })
    check('…by id: on that one', viaId.status === 200 && viaId.body?.project?.agents?.find((a) => a.name === 'Viaid')?.connection?.id === twinA.id, JSON.stringify(viaId.body?.error ?? ''))
    const offHere = await add('Offhere', { connection: other.id })
    check('…one not on here (by id): 409, nothing added', offHere.status === 409 && !(await api('GET', '/v1/projects/alpha')).body?.agents?.some((a) => a.name === 'Offhere'), JSON.stringify(offHere))
    const mismatch = await add('Mismatch', { provider: 'codex', connection: 'Max 1' })
    check('…a provider another than the connection’s CLI: 409', mismatch.status === 409 && /That connection is for Claude Code, not Codex/.test(mismatch.body?.error ?? ''), JSON.stringify(mismatch))
    const viaAgent = (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Vianame')
    await asAssistant('PATCH', `/v1/projects/alpha/agents/${viaAgent.id}`, { model: 'opus' })
    check('an unrelated change keeps its connection', (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Vianame')?.connection?.id === max2.id)
    await asAssistant('PATCH', `/v1/projects/alpha/agents/${viaAgent.id}`, { connection: null })
    check('…null clears it (the default again)', (await api('GET', '/v1/projects/alpha')).body.agents.find((a) => a.name === 'Vianame')?.connection === null)
    const projectAgent = await api('POST', '/v1/projects/alpha/agents', { name: 'Sneaky', connection: 'Max 1' }, agentToken)
    check('a project agent may not add agents (403), connection or not', projectAgent.status === 403, JSON.stringify(projectAgent))

    // --- Connections off: the routes and the field are refused.
    await inv('advanced:set', 'hive.accounts.preview', false)
    const off = [await api('GET', '/v1/connections'), await asAssistant('POST', '/v1/projects/alpha/agents', { name: 'Late', connection: 'Max 1' })]
    check('with the preview off, GET /v1/connections and a connection field are refused (409)', off.every((r) => r.status === 409 && /Connections are a preview/.test(r.body?.error ?? '')), JSON.stringify(off))
    await inv('advanced:set', 'hive.accounts.preview', true)
    await inv('session:stop', alpha, 'a-one')
    await inv('session:stop', assistantHome, 'assistant')
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
