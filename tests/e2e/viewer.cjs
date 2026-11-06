// Getting Combwork ready for Apiary (#620): the discovery file (the API's address, no token) is written on start, cleared
// while the Agent API is off and on quit; a viewer token made in Settings → Agent API reads every documented GET route
// and follows the event stream, and every documented write is refused (403) with nothing changed; the stream sends the
// new events (progress, merge slots, notices, the Assistant's actions with their kind and targets (#763: a task, a
// message, cards added, given, moved, batched, ordered, commented and started, a lane started, joined and ended, a
// project turned on, an agent's settings, refusals with the agent named and Combwork's own reason, never the value sent)
// and the agents it adds) live, without a notice's
// body, and a project agent's stream only its project's; GET /v1/progress is the Progress panel's runs; nothing private
// reaches a viewer, on the stream or in GET /v1/progress: not a message queued for a working agent, nor a wrapped
// command's arguments (a credential) or a reporter's text; a revoked viewer is refused at once and its stream ends.
// Fake Claude Code; dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
// The Agent API's version as the code under test has it (servers.ts), not a copy here that lags the next bump (HI-1847).
const API_VERSION = Number(/export const API_VERSION = (\d+)/.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'servers.ts'), 'utf8'))[1])

const userData = path.join(lib.WORK, 'viewer-profile')
const ws = path.join(lib.WORK, 'viewer-ws')
const claudeHome = path.join(lib.WORK, 'viewer-claude-home')
const notifyLog = path.join(lib.WORK, 'viewer-notify.log')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const PORT = Number(lib.port(47881))
const BASE = `http://127.0.0.1:${PORT}`
const discovery = path.join(userData, 'agent-api-discovery.json')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const readDiscovery = () => {
  try {
    return JSON.parse(fs.readFileSync(discovery, 'utf8'))
  } catch {
    return null
  }
}

/** An event-stream client: the events it has received ({ type, data }), and whether the stream has ended. */
function stream(token) {
  const events = []
  const ac = new AbortController()
  const s = { events, ended: false, status: 0, close: () => ac.abort() }
  s.open = fetch(`${BASE}/v1/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal }).then((r) => {
    s.status = r.status
    if (!r.ok) return r.status
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const type = /^event: (.*)$/m.exec(chunk)?.[1]
            const data = /^data: (.*)$/m.exec(chunk)?.[1]
            if (type && data) events.push({ type, data: JSON.parse(data) })
          }
        }
      } catch {
        // Aborted by the test.
      }
      s.ended = true
    })()
    return r.status
  })
  return s
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(notifyLog, { force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.git(alpha, ['branch', '-M', 'main'])
  // The workspace too: its Assistant runs in it (.combwork\assistant).
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase(), ws.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // The developer console's routes too (#636): they answer only while agents may read it.
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, devConsole: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body, token = apiToken) => {
    const r = await fetch(`${BASE}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  // --- Discovery: the address, never a token.
  const found = await lib.until(readDiscovery, HUNG_MS)
  check('the discovery file names the running API', found?.app === 'Combwork' && found.url === BASE && found.port === PORT && found.api === API_VERSION && typeof found.pid === 'number', JSON.stringify({ found, API_VERSION }))
  const discoveryText = fs.readFileSync(discovery, 'utf8')
  check('…and holds no token', !/token"\s*:/i.test(discoveryText) && !discoveryText.includes(apiToken), discoveryText)
  check('its health check answers', (await fetch(`${found.url}/v1/health`).then((r) => r.json())).ok === true)

  // --- A viewer token, made in Settings → Agent API.
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Agent API' }).click()
  const row = page.locator('.setting', { has: page.locator('.s-title', { hasText: 'Viewer tokens' }) })
  await row.getByLabel("New viewer token's name").fill('Apiary')
  await row.locator('.btn', { hasText: 'Make viewer token' }).click()
  const made = await lib.until(async () => (await inv('api:info')).viewers.find((v) => v.name === 'Apiary'), HUNG_MS)
  check('Make viewer token makes one', !!made && made.token.length >= 32 && made.token !== apiToken, JSON.stringify((await inv('api:info')).viewers))
  check('…shown in its row, ready to copy', !!(await lib.until(async () => (await row.getByLabel("Apiary's token").inputValue()) === made?.token, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'viewer-settings.png') })
  const kept = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api-viewers.json'), 'utf8'))
  check("it is kept in Combwork's profile, apart from the workspace token", kept.viewers?.[0]?.token === made?.token && !JSON.stringify(kept).includes(apiToken))
  check('a second one with the same name is refused', await inv('api:createViewer', 'apiary').then(() => false, (e) => /already a viewer token/.test(String(e))))
  const viewer = made.token
  const as = (method, route, body) => api(method, route, body, viewer)
  const status = await as('GET', '/v1/status')
  check('GET /v1/status says who it is: a read-only viewer of the workspace', status.status === 200 && status.body.caller?.role === 'viewer' && status.body.caller.name === 'Apiary' && status.body.caller.readOnly === true && status.body.api?.version === API_VERSION, JSON.stringify({ caller: status.body?.caller, api: status.body?.api, API_VERSION }))

  // --- An agent, for the merge slot, its activity and its own token's stream.
  await page.keyboard.press('Escape')
  await page.getByText('alpha', { exact: true }).first().click()
  const ann = await lib.addAgent(inv, alpha, { name: 'Ann' })
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  await inv('session:start', alpha, { agentId: ann.id })
  check('the agent starts', !!(await lib.until(async () => (await live(ann.id))?.status === 'ready', HUNG_MS)))
  const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
  const annToken = await lib.until(() => {
    const lines = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8').split('\n').filter((l) => l.trim().endsWith('}')) : []
    return lines.map((l) => JSON.parse(l)).filter((l) => l.cwd.toLowerCase() === alpha.toLowerCase()).at(-1)?.token
  }, HUNG_MS)
  check("the agent's own token is known", !!annToken)
  const card = (await api('POST', '/v1/tasks', { title: 'Show the office', project: 'alpha' })).body?.number
  check('a card to read', typeof card === 'number')

  // --- Every documented GET route answers a viewer (no 401 or 403): it reads everything.
  const doc = await as('GET', '/v1/docs/agent-api')
  const fill = (route) =>
    route
      .replace(/\{name\}/g, 'alpha')
      .replace(/\{agent\}/g, 'Ann')
      .replace(/\{n\}/g, String(card))
      .replace(/\{id\}/g, 'x')
      .replace(/\{[a-z]+\}/gi, 'x')
  const docText = String(doc.body?.content ?? '').replace(/\r\n/g, '\n')
  const routesIn = (text, method) => [...new Set([...text.matchAll(new RegExp('`' + method + ' (/v1/[^`\\s?\\[]*)', 'g'))].map((m) => fill(m[1])))]
  const documented = (method) => routesIn(docText, method)
  // The routes the reference says are the Assistant's only: the tables after a line saying so.
  const assistantTables = [...docText.matchAll(/^.*the Assistant's only.*\n\n((?:\|.*\n?)+)/gim)].map((m) => m[1]).join('\n')
  // …and whole sections whose first paragraph says they are (Templates, HI-1502: "The Combwork Assistant's alone").
  const assistantSections = docText
    .split(/^(?=#{2,3} )/m)
    .filter((s) => /Assistant's (?:only|alone)/i.test(s.split(/\n\n/)[1] ?? ''))
    .join('\n')
  const assistantGets = routesIn(assistantTables + '\n' + assistantSections, 'GET')
  const gets = documented('GET').filter((r) => r !== '/v1/events' && !assistantGets.includes(r))
  check('the reference lists the GET routes', gets.length >= 20 && gets.includes('/v1/progress'), gets.join(' '))
  check("…and which are the Assistant's only", assistantGets.includes('/v1/journal/x') && !assistantGets.includes('/v1/progress'), assistantGets.join(' '))
  const openToViewer = []
  for (const r of assistantGets) {
    const res = await as('GET', r)
    if (res.status !== 403) openToViewer.push(`${r} ${res.status}`)
  }
  check("a viewer is refused the Assistant's GET routes (403)", openToViewer.length === 0, openToViewer.join(', '))
  const refusedGets = []
  for (const r of gets) {
    const res = await as('GET', r)
    if (res.status === 401 || res.status === 403) refusedGets.push(`${r} ${res.status}`)
  }
  check('a viewer reads every documented GET route', refusedGets.length === 0, refusedGets.join(', '))
  const [mine, theirs] = [await as('GET', '/v1/projects?view=short'), await api('GET', '/v1/projects?view=short')]
  check('…seeing what the workspace token sees', mine.status === 200 && JSON.stringify(mine.body.map((p) => p.name)) === JSON.stringify(theirs.body.map((p) => p.name)), JSON.stringify(mine.body))

  // --- Every documented write is refused, and changes nothing.
  const before = JSON.stringify((await api('GET', '/v1/tasks')).body)
  const notesBefore = JSON.stringify((await api('GET', '/v1/shared')).body)
  const writes = ['POST', 'PUT', 'PATCH', 'DELETE'].flatMap((m) => documented(m).map((r) => [m, r]))
  check('the reference lists the writes', writes.length >= 20 && writes.some(([m, r]) => m === 'POST' && r === '/v1/tasks/wait'), writes.map((w) => w.join(' ')).join(', '))
  const journalWrites = ['POST /v1/journal', 'POST /v1/journal/recall', 'PATCH /v1/journal/x', 'DELETE /v1/journal/x']
  check("…the Assistant's journal among them", journalWrites.every((w) => writes.some((x) => x.join(' ') === w)), journalWrites.join(', '))
  const allowed = []
  for (const [m, r] of writes) {
    const res = await as(m, r, { title: 'Viewer was here', text: 'x', path: 'viewer.md', content: 'x', message: 'x', column: 'done', action: 'claim', cards: [card] })
    if (res.status !== 403 || !/read-only/.test(res.body?.error ?? '')) allowed.push(`${m} ${r} ${res.status}`)
  }
  check('a viewer is refused every documented write (403, read-only)', allowed.length === 0, allowed.join(', '))
  check('…and the board and notes are as they were', JSON.stringify((await api('GET', '/v1/tasks')).body) === before && JSON.stringify((await api('GET', '/v1/shared')).body) === notesBefore)
  check('…a route no one has is refused the same, before anything', (await as('POST', '/v1/nothing-here')).status === 403)

  // --- The stream: the new events, live.
  const viewerStream = stream(viewer)
  const annStream = stream(annToken)
  check('a viewer and an agent open the event stream', (await viewerStream.open) === 200 && (await annStream.open) === 200)
  const seen = (s, type, test = () => true) => lib.until(() => s.events.find((e) => e.type === type && test(e.data)), HUNG_MS)

  // Progress: a script's run.
  const runId = (await api('POST', '/v1/progress', { title: 'viewer probe', total: 3, step: 1 })).body?.id
  const progressEvent = await seen(viewerStream, 'progress-changed', (d) => d.runs.some((r) => r.id === runId))
  check('progress-changed arrives with the run', !!progressEvent && progressEvent.data.workspacePath.toLowerCase() === ws.toLowerCase(), JSON.stringify(viewerStream.events.map((e) => e.type)))
  const panel = await inv('progress:list')
  const viaApi = await as('GET', '/v1/progress')
  const rows = (runs) => runs.map((r) => `${r.id} ${r.state} ${r.step}/${r.total} ${r.agentName}`).join(', ')
  check("GET /v1/progress is the Progress panel's runs", viaApi.status === 200 && viaApi.body.enabled === true && rows(viaApi.body.runs) === rows(panel) && panel.some((r) => r.id === runId), JSON.stringify({ api: rows(viaApi.body?.runs ?? []), panel: rows(panel) }))
  await api('POST', `/v1/progress/${runId}/finish`, { ok: true })
  check('…and its finish arrives', !!(await seen(viewerStream, 'progress-changed', (d) => d.runs.some((r) => r.id === runId && r.state === 'passed'))))
  check("an agent's stream gets the workspace's progress without other projects' runs", !!(await seen(annStream, 'progress-changed')) && annStream.events.filter((e) => e.type === 'progress-changed').every((e) => e.data.runs.every((r) => r.projectPath?.toLowerCase() === alpha.toLowerCase())))
  check("an agent's GET /v1/progress has its project's runs only", (await api('GET', '/v1/progress', undefined, annToken)).body?.runs?.length === 0)

  // The merge slot: the agent claims and releases it.
  const claim = await api('POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', cards: [card], timeoutSeconds: 0 }, annToken)
  check('the agent holds the merge slot', claim.status === 200 && claim.body?.slot?.holder?.name === 'Ann', JSON.stringify(claim))
  const held = (d) => d.slots.some((s) => s.project.toLowerCase() === alpha.toLowerCase() && s.holder?.name === 'Ann')
  const holding = await seen(viewerStream, 'merge-slots-changed', held)
  check('merge-slots-changed arrives with its holder', !!holding)
  check("…and on the agent's own stream", !!(await seen(annStream, 'merge-slots-changed', held)))
  await api('POST', '/v1/projects/alpha/merge-slot/release', { branch: 'main' }, annToken)
  const after = viewerStream.events.indexOf(holding)
  check('…and when it is free again', !!(await lib.until(() => viewerStream.events.slice(after + 1).find((e) => e.type === 'merge-slots-changed' && !held(e.data)), HUNG_MS)))

  // Notices: an agent that asks for permission (waiting), moves on (resolved), and finishes.
  const asker = await lib.addAgent(inv, alpha, { name: 'Asker' })
  await inv('session:start', alpha, { agentId: asker.id, prompt: 'ask' })
  const waiting = await seen(viewerStream, 'notice', (d) => d.notice.kind === 'waiting' && d.notice.agentId === asker.id)
  check('a waiting notice arrives, without its body', !!waiting && /Asker/.test(waiting.data.notice.title) && !('body' in waiting.data.notice), JSON.stringify(viewerStream.events.filter((e) => e.type.startsWith('notice'))))
  check('…and notice-resolved once it moves on', !!(await seen(viewerStream, 'notice-resolved', (d) => d.agentId === asker.id)))
  const finished = await seen(viewerStream, 'notice', (d) => d.notice.kind === 'finished')
  check('a finished notice arrives, without the reply', !!finished && !('body' in finished.data.notice), JSON.stringify(finished?.data))
  check('no notice on the stream carries a body', viewerStream.events.filter((e) => e.type === 'notice').every((e) => !('body' in e.data.notice)))

  // --- Nothing private reaches a viewer: a message queued for a working agent (the Assistant's), a wrapped command's
  // arguments (a credential), a reporter's own text.
  const SECRET = 'PRIVATE_SENTINEL_620'
  const leaks = () => viewerStream.events.filter((e) => JSON.stringify(e.data).includes(SECRET) || JSON.stringify(e.data).includes(apiToken))
  await inv('settings:update', { assistant: { control: 'projects' } })
  await inv('session:start', path.join(ws, '.combwork', 'assistant'), { agentId: 'assistant' })
  check('the Assistant starts', !!(await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === 'assistant')?.status === 'ready', HUNG_MS)))
  const assistantFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const assistantToken = (await lib.until(() => fs.existsSync(assistantFile) && JSON.parse(fs.readFileSync(assistantFile, 'utf8')).token, HUNG_MS)) || ''
  check('the Assistant gives Ann a long task', (await api('POST', '/v1/projects/alpha/agents/Ann/prompt', { text: 'work 8' }, assistantToken)).status === 200)
  // At work on it once she has read it from her inbox (#650: its doorbell names it; what she reads then is all she has).
  check('…and she works on it', !!(await lib.until(async () => (await live(ann.id))?.status === 'working' && !(await live(ann.id))?.inbox?.unread?.length, HUNG_MS)))
  const queued = await api('POST', '/v1/projects/alpha/agents/Ann/message', { text: `Next, ${SECRET}` }, assistantToken)
  check('a message for her waits in Combwork', queued.status === 200 && queued.body?.typed === false && !!(await lib.until(async () => (await live(ann.id))?.inbox?.unread?.length === 1, HUNG_MS)), JSON.stringify(queued))
  const waitingFor = await seen(viewerStream, 'session-status', (d) => d.state.agentId === ann.id && d.state.inbox?.unread?.length === 1)
  check('the stream says a message waits, from whom, not what it says', !!waitingFor && waitingFor.data.state.inbox.unread[0].from !== undefined && !('text' in waitingFor.data.state.inbox.unread[0]), JSON.stringify(waitingFor?.data?.state?.inbox))
  const left = await seen(viewerStream, 'assistant-activity', (d) => /Left Ann in alpha a message/.test(d.action.text))
  check("the Assistant's action arrives, without the message", !!left && !left.data.action.text.includes(SECRET), JSON.stringify(left?.data))
  const added = await api('POST', '/v1/projects/alpha/agents', { name: 'Runner' }, assistantToken)
  check('agent-added arrives for the agent the Assistant adds', added.status === 200 && !!(await seen(viewerStream, 'agent-added', (d) => d.agentId === added.body?.agent?.id)), JSON.stringify(added.body?.agent ?? added))

  // --- #763: each action says what it was with fields (kind and targets), so a viewer needn't read its line.
  const act = (test) => seen(viewerStream, 'assistant-activity', (d) => test(d.action))
  const shown = (e) => JSON.stringify(e?.data?.action ?? viewerStream.events.filter((x) => x.type === 'assistant-activity').map((x) => x.data.action))
  const prompted = await act((a) => a.kind === 'prompt-agent' && a.agent?.id === ann.id)
  check('the task the Assistant gave carries kind, project and agent', prompted?.data.action.project === 'alpha' && prompted.data.action.agent.name === 'Ann' && prompted.data.action.ok === true, shown(prompted))
  check('…its message too', left?.data.action.kind === 'message-agent' && left.data.action.project === 'alpha' && left.data.action.agent?.id === ann.id && left.data.action.agent?.name === 'Ann', shown(left))
  check('…and the agent it added, by id', !!(await act((a) => a.kind === 'add-agent' && a.project === 'alpha' && a.agent?.id === added.body?.agent?.id && a.agent?.name === 'Runner')), shown())
  const tourCard = await api('POST', '/v1/tasks', { title: 'Office tour', project: 'alpha' }, assistantToken)
  const tour = tourCard.body?.number
  check('a card it adds carries its number and column', !!(await act((a) => a.kind === 'create-task' && a.card === tour && a.column === 'todo' && a.project === 'alpha')), shown())
  await api('PATCH', `/v1/tasks/${tour}`, { column: 'hold' }, assistantToken)
  check('a card it moves carries the column it went to', !!(await act((a) => a.kind === 'update-task' && a.card === tour && a.column === 'hold' && a.ok)), shown())
  await api('POST', '/v1/tasks/batch', { numbers: [tour], column: 'todo' }, assistantToken)
  check('a batch says each card and where it went', !!(await act((a) => a.kind === 'update-tasks' && a.card === tour && a.column === 'todo' && a.ok)), shown())
  await api('POST', '/v1/tasks/reorder', { column: 'todo', cards: [tour] }, assistantToken)
  check('putting cards in order says the column and the cards', !!(await act((a) => a.kind === 'reorder-tasks' && a.column === 'todo' && JSON.stringify(a.cards) === JSON.stringify([tour]))), shown())
  const started = await api('POST', `/v1/tasks/${tour}/start`, { name: 'Starter' }, assistantToken)
  check('starting a card says the card, its project, the agent and Doing', started.status === 200 && !!(await act((a) => a.kind === 'start-task' && a.card === tour && a.project === 'alpha' && a.agent?.name === 'Starter' && typeof a.agent?.id === 'string' && a.column === 'doing')), shown())
  const refused = await api('POST', '/v1/projects/alpha/agents/Runner/prompt', { text: `Again, ${SECRET}` }, assistantToken)
  check('a refusal has the kind it tried, ok false, its targets', refused.status === 409 && !!(await act((a) => a.kind === 'prompt-agent' && a.ok === false && !!a.error && a.agent?.id === added.body?.agent?.id)), shown())
  // A refusal whose error quotes what was sent (a setting's value): the stream gets Combwork's own reason, the agent named.
  const badSetting = await api('PATCH', `/v1/projects/alpha/agents/${ann.id}`, { mcpServers: [`${SECRET}/invalid`] }, assistantToken)
  check("a refused setting change says why in Combwork's words, not with the value sent", badSetting.status === 400 && !!(await act((a) => a.kind === 'update-agent' && a.ok === false && a.error === 'The request was invalid' && a.agent?.id === ann.id)), shown())
  // The agents Combwork knows before a change are named on it, a refusal's too.
  const desk = (await api('POST', '/v1/tasks', { title: 'Desk work', project: 'alpha', agent: 'Ann' }, assistantToken)).body?.number
  check('a card added for an agent names it', !!(await act((a) => a.kind === 'create-task' && a.card === desk && a.agent?.id === ann.id && a.agent?.name === 'Ann')), shown())
  const loose = (await api('POST', '/v1/tasks', { title: 'Loose card', project: 'alpha' }, assistantToken)).body?.number
  await api('PATCH', `/v1/tasks/${loose}`, { agent: ann.id }, assistantToken)
  check('a card given to an agent names it', !!(await act((a) => a.kind === 'update-task' && a.card === loose && a.ok && a.agent?.id === ann.id)), shown())
  await api('POST', `/v1/tasks/${loose}/comments`, { text: `Note ${SECRET}` }, assistantToken)
  check('a comment says its card, not what it says', !!(await act((a) => a.kind === 'comment-task' && a.card === loose && a.ok)), shown())
  await inv('settings:update', { assistant: { control: 'look' } })
  const lookStart = await api('POST', `/v1/tasks/${loose}/start`, { agent: ann.id }, assistantToken)
  check('a card start refused by Control names the agent it was for', lookStart.status === 403 && !!(await act((a) => a.kind === 'start-task' && a.ok === false && a.card === loose && a.agent?.id === ann.id && a.error === 'Not allowed by Settings → Assistant → Control')), shown())
  await inv('settings:update', { assistant: { control: 'projects' } })
  const lane = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'Ann', cards: [desk] }, assistantToken)
  const laneId = lane.body?.lane?.id
  check('a lane it starts says its id, cards and builder', lane.status === 200 && !!(await act((a) => a.kind === 'lane-start' && a.lane === laneId && JSON.stringify(a.cards) === JSON.stringify([desk]) && a.agent?.id === ann.id)), shown())
  const joined = await api('POST', '/v1/lanes/join', { project: 'alpha', builder: 'Ann', reviewer: 'Runner' }, assistantToken)
  check('a reviewer joining it is named, with the lane', joined.status === 200 && !!(await act((a) => a.kind === 'lane-join' && a.lane === laneId && a.agent?.name === 'Runner' && a.ok)), shown())
  await api('POST', `/v1/lanes/${laneId}/end`, { abandoned: true }, assistantToken)
  check('…and ending it', !!(await act((a) => a.kind === 'lane-end' && a.lane === laneId && a.ok)), shown())
  await api('POST', '/v1/projects/beta/activate', {}, assistantToken)
  check('turning a project on names it', !!(await act((a) => a.kind === 'activate-project' && a.project === 'beta' && a.ok)), shown())
  await api('PATCH', `/v1/projects/alpha/agents/${ann.id}`, { workflowRole: 'builder' }, assistantToken)
  check("changing an agent's settings names it", !!(await act((a) => a.kind === 'update-agent' && a.ok && a.agent?.id === ann.id)), shown())
  // An agent added whose start then fails, the error carrying a private value (round 3: a lower-level error can quote
  // anything): the stream says it in Combwork's own words; the Assistant's panel keeps the error.
  const LAUNCH_SECRET = 'PRIVATE_LAUNCH_ERROR_763'
  const mainFs = (arg) => app.evaluate((_main, a) => {
    const fsp = process.mainModule.require('original-fs/promises')
    globalThis.__viewerRealWriteFile ??= fsp.writeFile
    if (a === null) fsp.writeFile = globalThis.__viewerRealWriteFile
    else fsp.writeFile = async (file, ...rest) => {
      if (/[\\/]launches[\\/]/i.test(String(file))) throw new Error(`Launch setup refused: ${a}`)
      return globalThis.__viewerRealWriteFile.call(fsp, file, ...rest)
    }
  }, arg)
  let failsToStart
  try {
    await mainFs(LAUNCH_SECRET)
    failsToStart = await api('POST', '/v1/projects/alpha/agents', { name: 'FailsToStart', start: true }, assistantToken)
  } finally {
    await mainFs(null)
  }
  const failedAdd = await act((a) => a.kind === 'add-agent' && a.agent?.name === 'FailsToStart')
  check("an agent added whose start failed is said in Combwork's words, not with the error", failsToStart?.status === 200 && failedAdd?.data.action.ok === true && failedAdd.data.action.text === "Added FailsToStart to alpha; it didn't start", shown(failedAdd))
  check('…nothing of the error is on the stream', !viewerStream.events.some((e) => JSON.stringify(e.data).includes(LAUNCH_SECRET)))
  check("…and the Assistant's panel keeps it", (await inv('assistant:actions')).some((a) => a.kind === 'add-agent' && a.text.includes(LAUNCH_SECRET)))
  const kinds = viewerStream.events.filter((e) => e.type === 'assistant-activity').map((e) => e.data.action)
  check('every action on the stream has a kind', kinds.length > 0 && kinds.every((a) => typeof a.kind === 'string'), shown())
  const FIELDS = ['id', 'at', 'text', 'ok', 'error', 'kind', 'project', 'agent', 'toAgent', 'card', 'cards', 'lane', 'column', 'settingId']
  check('…and only the documented fields', kinds.every((a) => Object.keys(a).every((k) => FIELDS.includes(k))), shown())
  // Real wrapped commands, as an agent runs them: one with no title of its own, so its command line is its title, longer
  // than a title (120) and a command (200) are kept, the credential early in its arguments (round 2's finding); one with
  // a title of its own.
  const longArgs = `Authorization: Bearer ${apiToken} ${SECRET} ${'z'.repeat(150)}`
  await inv('session:start', alpha, { agentId: added.body?.agent?.id, prompt: `shell: cw-progress -- cmd /c echo ${longArgs} then shell: cw-progress --title "viewer check" -- cmd /c echo ${SECRET}` })
  const runnerRuns = () => inv('progress:list').then((list) => list.filter((r) => r.agentName === 'Runner' && r.state === 'passed'))
  check('the wrapped commands report their runs', !!(await lib.until(async () => (await runnerRuns()).length === 2, HUNG_MS)), JSON.stringify(await runnerRuns()))
  const wrapped = (await runnerRuns()).find((r) => r.title !== 'viewer check')
  const titled = (await runnerRuns()).find((r) => r.title === 'viewer check')
  check("…the long one's title and command cut to different lengths in the panel, the credential in both", !!wrapped && wrapped.title.length === 120 && wrapped.command.length === 200 && wrapped.title.includes(apiToken) && wrapped.command.includes(SECRET), JSON.stringify(wrapped && { title: wrapped.title.length, command: wrapped.command.length }))
  // A script's run with a reporter's own text everywhere it can put some.
  const scriptRun = (await api('POST', '/v1/progress', { title: 'secret probe', command: `curl -H "Authorization: Bearer ${apiToken}"`, stepName: SECRET, waiting: SECRET })).body?.id
  await api('POST', `/v1/progress/${scriptRun}/finish`, { ok: false, summary: SECRET, logPath: `C:\\${SECRET}.log` })
  check('…the script run ends', !!(await seen(viewerStream, 'progress-changed', (d) => d.runs.some((r) => r.id === scriptRun && r.state === 'failed'))))
  const publicRuns = await as('GET', '/v1/progress')
  const wrappedRow = publicRuns.body?.runs?.find((r) => r.id === wrapped?.id)
  check('GET /v1/progress calls the run with no title of its own "a command", nothing of its command line', wrappedRow?.title === 'a command' && wrappedRow.titleFromCommand === true && !('command' in wrappedRow), JSON.stringify(wrappedRow))
  check('…and the other by the title it was given', publicRuns.body?.runs?.find((r) => r.id === titled?.id)?.title === 'viewer check')
  check('…and gives neither run\'s command line nor a reporter\'s text', !JSON.stringify(publicRuns.body).includes(SECRET) && !JSON.stringify(publicRuns.body).includes(apiToken))
  check('nothing private reached the viewer\'s stream', leaks().length === 0, JSON.stringify(leaks().map((e) => e.type)))

  // --- Revoked in Settings: refused at once, its stream ended.
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Agent API' }).click()
  await row.locator('.btn', { hasText: 'Revoke' }).click()
  await page.locator('.dialog .btn', { hasText: 'Revoke' }).click()
  check('Revoke takes it off the list', !!(await lib.until(async () => (await inv('api:info')).viewers.length === 0, HUNG_MS)))
  check('…its stream ends', !!(await lib.until(() => viewerStream.ended, HUNG_MS)))
  check('…and it is refused (401)', (await as('GET', '/v1/status')).status === 401)
  check("the agent's stream goes on", !annStream.ended)
  annStream.close()

  // --- The discovery file follows the API: gone while it is off, back when it is on, gone on quit.
  await inv('settings:update', { agentApi: { enabled: false } })
  check('turning the Agent API off clears the discovery file', !!(await lib.until(() => !fs.existsSync(discovery), HUNG_MS)))
  await inv('settings:update', { agentApi: { enabled: true } })
  check('…turning it on writes it again', !!(await lib.until(() => readDiscovery()?.url === BASE, HUNG_MS)))
  const quit = await lib.quitWatch(app)
  await inv('app:quit').catch(() => undefined)
  check('Combwork quits', !!(await quit.untilDecided(HUNG_MS)))
  check('…and has cleared the discovery file', !fs.existsSync(discovery), fs.existsSync(discovery) ? fs.readFileSync(discovery, 'utf8') : '')
  await quit.gone(HUNG_MS)

  await app.close().catch(() => undefined)
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
