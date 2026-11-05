// A project agent's board calls are confined to its project: it gets its own Agent API token at launch (never the
// workspace's), and with it lists, reads, comments on, moves, creates and orders only its project's cards, whatever
// the request says about who is calling; other projects' cards answer as if they didn't exist, and a linked one
// shows as a number. Nor can it read another project's agents' conversations (activity, sessions), where a card
// started on an agent is its prompt, or type into, hand over, start or stop them (HI-2327). The workspace token (scripts) still sees all of it. The agent is the fake Claude Code;
// the calls are made with its token as its hive tools would. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const PORT = Number(lib.port(47907))
const HUNG_MS = 10000 // The existing stream wait limit, stated explicitly as a bound for a hung run.
const userData = path.join(lib.WORK, 'boardscope-profile')
const ws = path.join(lib.WORK, 'boardscope-ws')
const claudeHome = path.join(lib.WORK, 'boardscope-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, beta, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  // Session input on, so typing into another project's agent is refused for being another project's, not for being off.
  cfg.settings.agentApi = { ...cfg.settings.agentApi, allowSessionInput: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Alfie' })
  const other = await lib.addAgent(inv, beta, { name: 'Betty' })
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 20000)))

  // Cards: two of alpha's, two of beta's, one of the workspace's; alpha's #2 links to beta's #3.
  const make = async (title, project, column = 'todo') => (await inv('tasks:create', { title, project, column })).number
  const n = { A1: await make('A1', 'alpha'), B1: await make('B1', 'beta'), A2: await make('A2', 'alpha'), B2: await make('B2', 'beta'), W: await make('W', '') }
  await inv('tasks:update', n.A2, { links: [n.B1] })

  // The agent's token: the one its hive tools read (from --mcp-config), and the one in its environment.
  // Its own launch line (by its session id), not the file's last: another launch of the fake can be written after it.
  const sessionId = (await live())?.sessionId
  // The fake appends one JSON line per launch: only complete lines (ended by a newline) are read, so a read while the
  // next launch is half written waits for the rest; a complete line that isn't JSON fails, with the line.
  const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
  const launches = () => {
    const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
    return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => {
      try {
        return JSON.parse(l)
      } catch (e) {
        throw new Error(`fake-launches.jsonl has a complete line that isn't JSON (${e.message}): ${l.slice(0, 200)}`, { cause: e })
      }
    })
  }
  // How long its launch line may take to appear once Combwork shows it ready: generous, for a loaded machine.
  const LAUNCH_RECORD_MS = 20000
  const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), LAUNCH_RECORD_MS)
  const mcpServers = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers : {}
  check('the agent launched with the hive MCP server', !!mcpServers.combwork, JSON.stringify({ sessionId, launch: !!launch, servers: Object.keys(mcpServers), api: await inv('api:info').then((i) => ({ enabled: i.enabled, running: i.running, url: i.url, error: i.error })) }))
  if (!mcpServers.combwork) throw new Error('no hive server in the launch: the rest needs its token')
  const mcpEnv = mcpServers.combwork.env
  const agentToken = JSON.parse(fs.readFileSync(mcpEnv.CW_API_TOKEN_FILE, 'utf8')).token
  const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  check('the agent has a token of its own', !!agentToken && agentToken !== workspaceToken)
  check("its environment names its token's file, not the token (HI-2262)", launch.token === agentToken && !('HIVE_API_TOKEN' in launch.env) && launch.env.CW_API_TOKEN_FILE === mcpEnv.CW_API_TOKEN_FILE, JSON.stringify(launch.env))
  const call = async (token, method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const as = (method, p, body) => call(agentToken, method, p, body)
  // What a confused or misbehaving request might claim: to be beta's agent.
  const claim = { byAgent: other.id, agentProject: 'beta' }

  // --- Lists: only its project; another project's is refused.
  let r = await as('GET', '/v1/tasks')
  check("an unfiltered list is its project's cards", r.status === 200 && JSON.stringify(r.body.map((c) => c.title)) === '["A1","A2"]', JSON.stringify(r.body?.map?.((c) => c.title) ?? r))
  r = await as('GET', '/v1/tasks?project=beta')
  check("asking for another project's cards is refused", r.status === 403, JSON.stringify(r))
  r = await call(workspaceToken, 'GET', '/v1/tasks')
  // Changing a card's project (the workspace token may) takes it from its agent; an agent in the same change is refused.
  const moved = await make('Moving', 'alpha')
  await inv('tasks:update', moved, { agent: agent.id })
  let m = await call(workspaceToken, 'PATCH', `/v1/tasks/${moved}`, { project: 'beta', agent: other.id })
  check('a project change with an agent in it is refused (400)', m.status === 400 && /project first/.test(m.body?.error), JSON.stringify(m))
  m = await call(workspaceToken, 'PATCH', `/v1/tasks/${moved}`, { project: 'beta' })
  check('a project change takes the card from its agent, and says so', m.status === 200 && m.body.agent === null && m.body.history.slice(-1)[0].what === 'Taken from Alfie of alpha', JSON.stringify(m.body?.history?.slice(-2)))
  await inv('tasks:delete', moved)
  check('the workspace token still lists every card', r.status === 200 && r.body.length === 5, String(r.body?.length))
  // ?q= (#1237): the board's search, through its index for words, in the caller's scope.
  const titles = (x) => (x.status === 200 ? x.body.map((c) => c.title).sort() : x)
  r = await call(workspaceToken, 'GET', '/v1/tasks?q=bet')
  check('?q= finds cards by their words (the project, through the index)', JSON.stringify(titles(r)) === '["B1","B2"]', JSON.stringify(titles(r)))
  r = await as('GET', '/v1/tasks?q=bet')
  check("an agent's ?q= finds nothing of another project's", JSON.stringify(titles(r)) === '[]', JSON.stringify(titles(r)))
  r = await as('GET', '/v1/tasks?q=ALP')
  check("…and its own project's cards, case aside", JSON.stringify(titles(r)) === '["A1","A2"]', JSON.stringify(titles(r)))
  r = await call(workspaceToken, 'GET', `/v1/tasks?q=%23${n.W}`)
  check('?q= takes a card number too', JSON.stringify(titles(r)) === '["W"]', JSON.stringify(titles(r)))

  // --- Another project's card, or the workspace's: as if it didn't exist, whatever the request claims.
  for (const [what, x] of [['beta', n.B1], ['workspace', n.W]]) {
    r = await as('GET', `/v1/tasks/${x}`)
    check(`reading a ${what} card: not found`, r.status === 404 && r.body?.error === `Unknown task #${x}`, JSON.stringify(r))
    r = await as('PATCH', `/v1/tasks/${x}`, { column: 'review', ...claim })
    check(`moving it, claiming to be beta's agent: not found`, r.status === 404, JSON.stringify(r))
    r = await as('PATCH', `/v1/tasks/${x}`, { agent: null, comment: 'mine now' })
    check(`reassigning or commenting on it: not found`, r.status === 404, JSON.stringify(r))
    r = await as('POST', `/v1/tasks/${x}/comments`, { text: 'hi', ...claim })
    check(`commenting through the comments route: not found`, r.status === 404, JSON.stringify(r))
  }
  r = await as('GET', '/v1/tasks/999')
  check('the same answer as for a card that does not exist', r.status === 404 && r.body?.error === 'Unknown task #999', JSON.stringify(r))
  const b1 = (await inv('tasks:list')).find((c) => c.number === n.B1)
  check("beta's card is untouched", b1.column === 'todo' && b1.comments.length === 0 && b1.history.length === 1, JSON.stringify(b1))

  // --- Creating: its project by default, never another's or the workspace's.
  r = await as('POST', '/v1/tasks', { title: 'Follow-up', ...claim })
  check('a new card goes to its project', r.status === 200 && r.body.project === 'alpha' && r.body.createdBy === 'Alfie (alpha)', JSON.stringify(r.body))
  r = await as('POST', '/v1/tasks', { title: 'Sneaky', project: 'beta' })
  check("a card for another project is refused", r.status === 403, JSON.stringify(r))
  r = await as('POST', '/v1/tasks', { title: 'Global', project: '' })
  check('a card for the workspace is refused', r.status === 403, JSON.stringify(r))

  // --- Its own cards: changes work, the project can't change, links to beta show as numbers.
  r = await as('PATCH', `/v1/tasks/${n.A1}`, { column: 'review', comment: 'Done.', reply: 'short' })
  check('it moves and comments on its own card', r.status === 200 && r.body.column === 'review', JSON.stringify(r))
  check('the place it reports counts its project only', r.body?.of === 1, JSON.stringify(r.body))
  // The latest comment alone: its own card's, never another project's.
  await inv('tasks:comment', n.A1, 'Looks good.')
  await inv('tasks:comment', n.B1, 'BETA SECRET COMMENT')
  r = await as('GET', `/v1/tasks/${n.A1}/comments/latest`)
  check('the latest comment alone', r.status === 200 && JSON.stringify(Object.keys(r.body)) === '["number","comment"]' && r.body.comment?.text === 'Looks good.' && r.body.comment.by === 'You', JSON.stringify(r))
  r = await as('GET', `/v1/tasks/${n.B1}/comments/latest`)
  check("another project's latest comment: not found, and nothing of it", r.status === 404 && !JSON.stringify(r.body).includes('BETA'), JSON.stringify(r))
  r = await call(workspaceToken, 'GET', `/v1/tasks/${n.B1}/comments/latest`)
  check('the workspace token reads it', r.status === 200 && r.body.comment?.text === 'BETA SECRET COMMENT', JSON.stringify(r))
  r = await as('PATCH', `/v1/tasks/${n.A1}`, { project: 'beta' })
  check('moving its card to another project is refused', r.status === 403, JSON.stringify(r))
  r = await as('GET', `/v1/tasks/${n.A2}`)
  check("a linked card of another project is marked, as a number", r.status === 200 && JSON.stringify(r.body.links) === `[${n.B1}]` && JSON.stringify(r.body.elsewhere) === `[${n.B1}]`, JSON.stringify(r.body))
  r = await as('PATCH', `/v1/tasks/${n.A2}`, { links: [], reply: 'short' })
  check('changing the links keeps the one it cannot see', (await inv('tasks:list')).find((c) => c.number === n.A2).links.includes(n.B1))

  // --- Ordering: its own cards only.
  r = await as('POST', '/v1/tasks/reorder', { column: 'todo', cards: [n.A2, n.B2] })
  check('a reorder naming another project\'s card is refused', r.status === 400 && /no card/.test(r.body?.error), JSON.stringify(r))
  r = await as('PATCH', `/v1/tasks/${n.A2}`, { before: n.B2 })
  check('placing before another project\'s card is refused', r.status === 400 && /no card/.test(r.body?.error), JSON.stringify(r))

  // --- Its hive tools (the fake's "boardmove") use the same token: its own card moves, beta's doesn't.
  const before = fs.existsSync(path.join(claudeHome, 'fake-calls.jsonl')) ? fs.readFileSync(path.join(claudeHome, 'fake-calls.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
  await inv('pty:write', lib.ptyKey(alpha, agent.id), `boardmove ${n.A2} doing boardmove ${n.B2} doing`)
  await lib.sleep(100)
  await inv('pty:write', lib.ptyKey(alpha, agent.id), '\r')
  await until(async () => (await live())?.status === 'finished', 15000)
  const calls = fs.readFileSync(path.join(claudeHome, 'fake-calls.jsonl'), 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l))
  // The fake makes one call per prompt (the first boardmove); a second prompt tries beta's.
  check("through its hive tools' path: its card moves", calls[0]?.status === 200 && (await inv('tasks:list')).find((c) => c.number === n.A2).column === 'doing', JSON.stringify(calls))
  await inv('pty:write', lib.ptyKey(alpha, agent.id), `boardmove ${n.B2} doing`)
  await lib.sleep(100)
  await inv('pty:write', lib.ptyKey(alpha, agent.id), '\r')
  await until(async () => fs.readFileSync(path.join(claudeHome, 'fake-calls.jsonl'), 'utf8').split('\n').filter(Boolean).length > before + 1, 15000)
  const last = JSON.parse(fs.readFileSync(path.join(claudeHome, 'fake-calls.jsonl'), 'utf8').trim().split('\n').at(-1))
  check("…and beta's card is not found", last.status === 404 && (await inv('tasks:list')).find((c) => c.number === n.B2).column === 'todo', JSON.stringify(last))

  // --- Another project's agents: their conversations hold their cards. Beta's agent starts on a private card,
  // while an event stream with alpha's token and one with the workspace token listen.
  const listen = (token) => {
    const got = { text: '' }
    const ctl = new AbortController()
    fetch(`http://127.0.0.1:${PORT}/v1/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal })
      .then(async (res) => {
        got.status = res.status
        const reader = res.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          got.text += Buffer.from(value).toString('utf8')
        }
        // Ended by Combwork (not by stop(), whose abort rejects the read instead).
        got.done = true
      })
      .catch(() => undefined)
    got.stop = () => ctl.abort()
    return got
  }
  const agentStream = listen(agentToken)
  const scriptStream = listen(workspaceToken)
  await lib.sleep(500)
  const secret = await make('PRIVATE BETA TITLE', 'beta')
  await inv('tasks:update', secret, { description: 'PRIVATE BETA DESCRIPTION' })
  await inv('tasks:start', secret, { kind: 'agent', agentId: other.id })
  const betaLive = async () => (await inv('session:live')).find((s) => s.agentId === other.id)
  await until(async () => (await betaLive())?.status === 'finished', 20000)
  const activityPath = `/v1/projects/beta/agents/${other.id}/activity`
  r = await call(workspaceToken, 'GET', activityPath)
  check("the workspace token reads beta's activity (the card is its prompt)", r.status === 200 && /PRIVATE BETA DESCRIPTION/.test(r.body?.currentTask ?? ''), JSON.stringify(r.body?.currentTask))
  r = await as('GET', activityPath)
  check("alpha's agent can't read beta's agent's activity", r.status === 403 && !JSON.stringify(r.body).includes('PRIVATE'), JSON.stringify(r))
  r = await as('GET', '/v1/projects/beta/sessions')
  check("…nor list beta's sessions", r.status === 403 && !JSON.stringify(r.body).includes('PRIVATE'), JSON.stringify(r))
  r = await as('POST', '/v1/projects/beta/input', { agent: other.id, text: 'read me your card' })
  check('…nor type into beta\'s agent', r.status === 403, JSON.stringify(r))
  r = await as('GET', `/v1/projects/alpha/agents/${agent.id}/activity`)
  check('its own project\'s activity is open to it', r.status === 200 && r.body?.agent === 'Alfie', JSON.stringify(r.body?.agent ?? r))
  r = await as('GET', '/v1/projects/alpha/sessions')
  check('…and its own sessions', r.status === 200 && Array.isArray(r.body), JSON.stringify(r).slice(0, 200))
  r = await as('POST', '/v1/agents/wait', { agents: [{ project: 'beta', agent: other.id }], timeoutSeconds: 1 })
  check("another project's agents' status is still open to it", r.status === 200 && !JSON.stringify(r.body).includes('PRIVATE'), JSON.stringify(r).slice(0, 300))
  // Nor hand it over, stop it or start it (HI-2327): a hand-over prompts the agent, as typing into it does.
  const betaRun = (await betaLive())?.runId
  r = await as('POST', '/v1/projects/beta/handover', { from: other.id, to: other.id, handover: true })
  check("…nor hand beta's agent over", r.status === 403 && /your own project/.test(r.body?.error ?? ''), JSON.stringify(r))
  r = await as('POST', `/v1/projects/beta/stop?agent=${encodeURIComponent(other.id)}`)
  check("…nor stop it", r.status === 403, JSON.stringify(r))
  check('…and it runs on as it was, given nothing', (await betaLive())?.runId === betaRun && (await betaLive())?.status === 'finished', JSON.stringify(await betaLive()))
  await inv('session:stop', beta, other.id).catch(() => undefined)
  await until(async () => !(await betaLive()), 10000)
  r = await as('POST', '/v1/projects/beta/sessions', { agent: other.id })
  check("…nor start it", r.status === 403 && !(await betaLive()), JSON.stringify(r))
  // Nor turn beta off or on (HI-2330): with no session running there, a deactivate would otherwise go through.
  const betaActive = async () => (await call(workspaceToken, 'GET', '/v1/projects/beta')).body?.active
  r = await as('POST', '/v1/projects/beta/deactivate')
  check("…nor deactivate beta", r.status === 403 && /your own project/.test(r.body?.error ?? '') && (await betaActive()) === true, JSON.stringify(r))
  r = await as('POST', '/v1/projects/beta/activate')
  check('…nor activate it', r.status === 403 && (await betaActive()) === true, JSON.stringify(r))
  r = await as('POST', '/v1/projects/alpha/activate')
  check('its own project it may activate', r.status === 200 && r.body?.active === true, JSON.stringify(r).slice(0, 300))
  // Something of alpha's own, so its stream has something to show.
  await inv('pty:write', lib.ptyKey(alpha, agent.id), 'hello')
  await lib.sleep(100)
  await inv('pty:write', lib.ptyKey(alpha, agent.id), '\r')
  await until(async () => (await live())?.status === 'finished', 15000)
  await lib.sleep(800)
  agentStream.stop()
  scriptStream.stop()
  const betaPath = JSON.stringify(beta).slice(1, -1)
  const alphaPath = JSON.stringify(alpha).slice(1, -1)
  check('the event stream is open to the agent', agentStream.status === 200 && agentStream.text.includes(alphaPath), `${agentStream.status} ${agentStream.text.slice(0, 200)}`)
  check("…and carries nothing of beta's sessions", !agentStream.text.includes(betaPath) && !agentStream.text.includes('PRIVATE'), agentStream.text.slice(0, 400))
  check("the workspace token's stream has beta's sessions too", scriptStream.text.includes(betaPath) && scriptStream.text.includes(alphaPath), scriptStream.text.slice(0, 200))

  // --- Skills: another project's own skills are its agents' business; the workspace's Combwork skills are everyone's.
  fs.mkdirSync(path.join(beta, '.claude', 'skills', 'beta-secret'), { recursive: true })
  fs.writeFileSync(path.join(beta, '.claude', 'skills', 'beta-secret', 'SKILL.md'), '---\nname: beta-secret\ndescription: PRIVATE beta skill.\n---\n')
  r = await as('GET', '/v1/skills?project=beta')
  check("alpha's agent can't list beta's skills", r.status === 403 && !JSON.stringify(r.body).includes('PRIVATE'), JSON.stringify(r).slice(0, 300))
  r = await call(workspaceToken, 'GET', '/v1/skills?project=beta')
  check("…the workspace token can, and listings carry no folder paths", r.status === 200 && r.body.some((s) => s.name === 'beta-secret') && !JSON.stringify(r.body).includes(JSON.stringify(ws).slice(1, -1)), JSON.stringify(r).slice(0, 300))
  r = await as('GET', '/v1/skills?project=alpha')
  check('its own project\'s skills are open to it', r.status === 200 && r.body.some((s) => s.name === 'work-on-card' && s.level === 'hive'), JSON.stringify(r).slice(0, 300))
  r = await as('GET', '/v1/status')
  check('the status says who it is to Combwork', r.status === 200 && r.body.caller?.role === 'agent' && r.body.caller.project === 'alpha' && r.body.caller.agent === 'Alfie' && r.body.api?.version >= 2, JSON.stringify(r.body?.caller))

  // --- Another agent's card in Doing is its work in progress: Alfie can't move it on (409), even taking it in the same
  // change; the workspace token (a script, as the user's board) can.
  const alma = await lib.addAgent(inv, alpha, { name: 'Alma' })
  const busy = await make('Busy', 'alpha', 'doing')
  await inv('tasks:update', busy, { agent: alma.id })
  for (const patch of [{ column: 'done' }, { column: 'review' }, { column: 'done', agent: agent.id }]) {
    r = await as('PATCH', `/v1/tasks/${busy}`, patch)
    check(`another agent's card in Doing: ${JSON.stringify(patch)} is refused (409)`, r.status === 409 && /Alma, who is working on it: newer work is in progress/.test(r.body?.error), JSON.stringify(r))
  }
  const still = (await inv('tasks:list')).find((c) => c.number === busy)
  check('…and the card is as it was', still.column === 'doing' && still.agent === alma.id, JSON.stringify([still.column, still.agent]))
  r = await call(workspaceToken, 'PATCH', `/v1/tasks/${busy}`, { column: 'done' })
  check('the workspace token can move it', r.status === 200 && r.body.column === 'done', JSON.stringify(r.body?.column ?? r))
  await inv('tasks:delete', busy)

  // --- Its own project's agents it may still start and stop (HI-2327 confines only another project's).
  const almaLive = async () => (await inv('session:live')).find((s) => s.agentId === alma.id)
  r = await as('POST', '/v1/projects/alpha/sessions', { agent: alma.id })
  check("it starts its own project's agent", r.status === 200 && r.body?.agentId === alma.id && !!(await almaLive()), JSON.stringify(r).slice(0, 300))
  await until(async () => ['ready', 'finished'].includes((await almaLive())?.status), 20000)
  r = await as('POST', `/v1/projects/alpha/stop?agent=${encodeURIComponent(alma.id)}`)
  check('…and stops it', r.status === 200 && !!(await until(async () => !(await almaLive()), 10000)), JSON.stringify(r))

  // --- Once the agent stops, its token stops working, and an event stream it opened ends (HI-2416), as a revoked
  // viewer's does; one with the workspace token stays open.
  const endsWith = listen(agentToken)
  const staysOpen = listen(workspaceToken)
  check('a stream opened with its token before it stops is open', !!(await until(async () => endsWith.status === 200 && endsWith.text.includes(': connected'), HUNG_MS)), `${endsWith.status}`)
  await until(async () => staysOpen.status === 200, HUNG_MS)
  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await until(async () => !(await live()), 10000)
  r = await as('GET', '/v1/tasks')
  check('its token ends with it', r.status === 401, JSON.stringify(r))
  check('…and so does the stream it opened (HI-2416)', !!(await until(async () => endsWith.done, HUNG_MS)), endsWith.text.slice(-200))
  check("…the workspace token's stream stays open", !staysOpen.done)
  r = await fetch(`http://127.0.0.1:${PORT}/v1/events`, { headers: { Authorization: `Bearer ${agentToken}` } })
  check('…and a new stream with its token is refused', r.status === 401, String(r.status))
  staysOpen.stop()

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
