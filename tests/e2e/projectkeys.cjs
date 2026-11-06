// Project keys through the Agent API (#1219): a new workspace's projects get keys at its first open, cards are numbered
// in their project and carry their key, and every place a card is named takes its key (any case), an old key after a
// change, a moved card's key in its old project, or #N: reading and changing a card, blockedBy and before, a batch (a key
// no card has refused as that card, the rest changed), a reorder, a bounded wait and a progress run's card. A key no
// card has is 404. Replies name cards by key alone, "AL-1" (HI-1661), the Combwork tools' too: cw_lane's start, join, list and end, through
// the real combwork MCP server.
// Dev build, throwaway profile and workspace; no CLI is started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'projectkeys-profile')
const ws = path.join(lib.WORK, 'projectkeys-ws')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const PORT = Number(lib.port(47838))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const call = async (method, route, body) => {
      const r = await fetch(API + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }

    // --- Keys at the first open, from the folders' names.
    const keys = await lib.until(async () => {
      const k = await inv('project:keys')
      return k.length === 2 ? Object.fromEntries(k.map((x) => [path.basename(x.projectPath), x.key])) : null
    }, HUNG_MS)
    check('each project has a key at the first open (alpha AL, beta BE)', keys?.alpha === 'AL' && keys?.beta === 'BE', JSON.stringify(keys))

    // --- Cards numbered in their project, with their key; read by key in any case, or #N.
    const a1 = (await call('POST', '/v1/tasks', { title: 'First', project: 'alpha' })).body
    const b1 = (await call('POST', '/v1/tasks', { title: 'Beta first', project: 'beta' })).body
    const a2 = (await call('POST', '/v1/tasks', { title: 'Second', project: 'alpha', blockedBy: ['AL-1'] })).body
    check('new cards carry their key, counted in their project', a1?.key === 'AL-1' && b1?.key === 'BE-1' && a2?.key === 'AL-2', JSON.stringify([a1?.key, b1?.key, a2?.key]))
    check('blockedBy takes a key', JSON.stringify(a2?.blockedBy) === JSON.stringify([a1?.number]), JSON.stringify(a2?.blockedBy))
    for (const ref of ['AL-1', 'al-1', `%23${a1?.number}`, String(a1?.number)]) {
      const r = await call('GET', `/v1/tasks/${ref}`)
      check(`a card read as ${decodeURIComponent(ref)}`, r.status === 200 && r.body?.number === a1?.number, JSON.stringify(r))
    }
    const unknown = await call('GET', '/v1/tasks/AL-99')
    check('a key no card has is 404, in the words used', unknown.status === 404 && /Unknown card AL-99/.test(unknown.body?.error ?? ''), JSON.stringify(unknown))

    // --- before, a batch (a key no card has refused as that card), a reorder and a bounded wait by key.
    const placed = await call('PATCH', '/v1/tasks/AL-2', { before: 'AL-1', reply: 'short' })
    check('before takes a key, and the reply names the card by key', placed.status === 200 && placed.body?.key === 'AL-2', JSON.stringify(placed))
    const batch = await call('POST', '/v1/tasks/batch', { numbers: ['AL-1', 'AL-99', 'be-1'], addLabels: ['keyed'], reply: 'short' })
    check('a batch by key changes the cards it names, and refuses a key no card has as that card', batch.status === 200 && batch.body?.changed?.length === 2 && batch.body?.refused?.[0]?.error === 'Unknown card AL-99', JSON.stringify(batch))
    // Checked whole before any key is looked up (#1219 round 2, finding 3): over the limit, or a field a batch can't set,
    // refuses it all, even with keys no card has; a missing #N is refused as that card, as a missing key is.
    const tooMany = await call('POST', '/v1/tasks/batch', { numbers: Array.from({ length: 101 }, (_, i) => `AL-${900 + i}`), addLabels: ['x'] })
    check('a batch of over 100 cards is refused, keys or not', tooMany.status === 400 && !tooMany.body?.refused, JSON.stringify(tooMany).slice(0, 300))
    const badField = await call('POST', '/v1/tasks/batch', { numbers: ['AL-99'], title: 'x' })
    check('a batch setting a field it cannot is refused, with keys no card has', badField.status === 400 && /goes on one card/.test(badField.body?.error ?? ''), JSON.stringify(badField))
    const noPatch = await call('POST', '/v1/tasks/batch', { numbers: ['AL-99'] })
    check('…and one changing nothing', noPatch.status === 400 && !noPatch.body?.refused, JSON.stringify(noPatch))
    const mixed = await call('POST', '/v1/tasks/batch', { numbers: [`#${a1?.number}`, '#999', 'AL-98'], addLabels: ['mixed'], reply: 'short' })
    check('a missing #N is refused as that card, as a missing key is, and the card beside them changes', mixed.status === 200 && mixed.body?.changed?.length === 1 && mixed.body?.refused?.length === 2 && mixed.body.refused.some((r) => r.number === 999) && mixed.body.refused.some((r) => r.ref === 'AL-98'), JSON.stringify(mixed))
    const reordered = await call('POST', '/v1/tasks/reorder', { column: 'todo', cards: ['AL-1', 'AL-2'], reply: 'short' })
    check('a reorder takes keys, and names them in its reply', reordered.status === 200 && JSON.stringify(reordered.body?.top) === JSON.stringify([a1?.number, a2?.number]) && reordered.body?.names?.[String(a1?.number)] === 'AL-1', JSON.stringify(reordered))
    const waited = await call('POST', '/v1/tasks/wait', { cards: ['AL-1'], column: 'todo' })
    // Already in Todo: it answers at once, with the card, named by key for the Combwork tools' words.
    check('a wait takes a key', waited.status === 200 && [waited.body?.already, ...(waited.body?.changes ?? [])].some((c) => c?.number === a1?.number) && waited.body?.names?.[String(a1?.number)] === 'AL-1', JSON.stringify(waited))

    // --- cw_lane through the real combwork MCP server (#1219 round 2, finding 1): its replies name the cards by key.
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    const tool = (agentId, name, args) => {
      const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
        env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, CW_API_TOKEN_FILE: path.join(userData, 'agent-api.json'), CW_PROJECT: 'alpha', CW_AGENT_ID: agentId }),
        timeout: 60000
      }).toString()
      const r = JSON.parse(out.split('\n')[0]).result
      return { text: r.content[0].text, isError: !!r.isError }
    }
    // By key alone (HI-1661), never with the number beside it.
    const keyed2 = 'AL-2'
    const started = tool(builder.id, 'cw_lane', { action: 'start', cards: ['AL-2'], name: 'keyed' })
    check("cw_lane start's reply names its cards by key", !started.isError && started.text.startsWith('Lane started: ') && started.text.includes(keyed2) && !started.text.includes(`#${a2?.number}`), started.text)
    const joined = tool(reviewer.id, 'cw_lane', { action: 'join', builder: 'Builder' })
    check("…join's", !joined.isError && joined.text.startsWith('Joined the lane: ') && joined.text.includes(keyed2), joined.text)
    const listed = tool(builder.id, 'cw_lane', { action: 'list' })
    check("…list's", !listed.isError && listed.text.includes(keyed2), listed.text)
    const laneId = (await call('GET', '/v1/lanes')).body?.[0]?.id
    const ended = tool(builder.id, 'cw_lane', { action: 'end', lane: laneId, abandoned: true })
    check("…and end's", !ended.isError && ended.text.startsWith('Lane abandoned: ') && ended.text.includes(keyed2), ended.text)

    // --- A key changed: the cards show it, the old one still finds them.
    const changed = await inv('project:setKey', alpha, 'alp')
    const afterReply = await call('GET', '/v1/tasks/AL-1')
    const after = afterReply.body
    check('a key changed: the card shows the new key, the old one still finds it', changed === 'ALP' && after?.number === a1?.number && after?.key === 'ALP-1', JSON.stringify({ changed, status: afterReply.status, key: after?.key, number: after?.number, error: after?.error }))
    const refusedKey = await inv('project:setKey', beta, 'ALP').then(() => 'changed', (e) => String(e.message ?? e))
    check("another project's key is refused, saying why", /another project’s key/.test(refusedKey), refusedKey)

    // --- A card moved to another project: its next number there; its old keys still find it.
    const moved = await call('PATCH', '/v1/tasks/ALP-1', { project: 'beta', reply: 'short' })
    check('a card moved takes the next number in its new project', moved.status === 200 && moved.body?.key === 'BE-2', JSON.stringify(moved))
    for (const ref of ['ALP-1', 'AL-1', 'BE-2']) check(`…and ${ref} still finds it`, (await call('GET', `/v1/tasks/${ref}`)).body?.number === a1?.number)

    // --- A progress run's card by key (#1220 deferred it to this card).
    const resolved = await call('POST', '/v1/progress/resolve', { card: 'be-2' })
    // Named by its key now (HI-1661), as everything names it.
    check("a progress run's card takes a key, and names it by key", resolved.status === 200 && resolved.body?.card === 'BE-2', JSON.stringify(resolved))
    const resolvedUnknown = await call('POST', '/v1/progress/resolve', { card: 'BE-9' })
    check('…and a key no card has is refused in the words used', resolvedUnknown.status === 400 && /Unknown card BE-9/.test(resolvedUnknown.body?.error ?? ''), JSON.stringify(resolvedUnknown))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
