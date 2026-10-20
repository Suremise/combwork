// Project keys through the Agent API (#1219): a new workspace's projects get keys at its first open, cards are numbered
// in their project and carry their key, and every place a card is named takes its key (any case), an old key after a
// change, a moved card's key in its old project, or #N: reading and changing a card, blockedBy and before, a batch (a key
// no card has refused as that card, the rest changed), a reorder, a bounded wait and a progress run's card. A key no
// card has is 404. Replies name cards "AL-1 (#1)".
// Dev build, throwaway profile and workspace; no CLI is started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
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

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
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
    const reordered = await call('POST', '/v1/tasks/reorder', { column: 'todo', cards: ['AL-1', 'AL-2'], reply: 'short' })
    check('a reorder takes keys, and names them in its reply', reordered.status === 200 && JSON.stringify(reordered.body?.top) === JSON.stringify([a1?.number, a2?.number]) && reordered.body?.names?.[String(a1?.number)] === `AL-1 (#${a1?.number})`, JSON.stringify(reordered))
    const waited = await call('POST', '/v1/tasks/wait', { cards: ['AL-1'], column: 'todo' })
    check('a wait takes a key', waited.status === 200 && waited.body?.already?.number === a1?.number, JSON.stringify(waited))

    // --- A key changed: the cards show it, the old one still finds them.
    const changed = await inv('project:setKey', alpha, 'alp')
    const after = (await call('GET', '/v1/tasks/AL-1')).body
    check('a key changed: the card shows the new key, the old one still finds it', changed === 'ALP' && after?.number === a1?.number && after?.key === 'ALP-1', JSON.stringify({ changed, key: after?.key }))
    const refusedKey = await inv('project:setKey', beta, 'ALP').then(() => 'changed', (e) => String(e.message ?? e))
    check("another project's key is refused, saying why", /another project’s key/.test(refusedKey), refusedKey)

    // --- A card moved to another project: its next number there; its old keys still find it.
    const moved = await call('PATCH', '/v1/tasks/ALP-1', { project: 'beta', reply: 'short' })
    check('a card moved takes the next number in its new project', moved.status === 200 && moved.body?.key === 'BE-2', JSON.stringify(moved))
    for (const ref of ['ALP-1', 'AL-1', 'BE-2']) check(`…and ${ref} still finds it`, (await call('GET', `/v1/tasks/${ref}`)).body?.number === a1?.number)

    // --- A progress run's card by key (#1220 deferred it to this card).
    const resolved = await call('POST', '/v1/progress/resolve', { card: 'be-2' })
    check("a progress run's card takes a key", resolved.status === 200 && resolved.body?.card === `#${a1?.number}`, JSON.stringify(resolved))
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
