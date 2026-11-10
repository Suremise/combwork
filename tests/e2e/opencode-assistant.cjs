// The Combwork Assistant on OpenCode (HI-2771), through Combwork with the fake opencode (fake-opencode/: no sign-in, no
// model, no network): its state view goes into its session as Combwork's one instruction entry, combwork.state-view
// (2.2.6's experimental routes, tests/fixtures/opencode/real-2.2.6/wire/instruction-entries.json). What the fake's
// server took is the evidence, never the view's being built: the entry put before the TUI started, naming the card in
// hand; put again after a compaction Combwork asked for and saw end; on a resume, put by the new run (a refused put is
// a refusal, never counted, and the session still starts); with the journal off, Combwork's entry removed on the next
// resume, and someone else's entry left as it was. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'opencode-assistant-profile')
const ws = path.join(lib.WORK, 'opencode-assistant-ws')
const alpha = path.join(ws, 'alpha')
const home = path.join(ws, '.combwork', 'assistant')
const fakeLog = path.join(lib.WORK, 'opencode-assistant-fake.jsonl')
const modeFile = path.join(lib.WORK, 'opencode-assistant-entry-mode.txt')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** The fake's log, in the order its lines were written. */
const lines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const entryOps = () => lines().filter((e) => e.kind === 'instruction-entry')
/** Where in the log an entry request was (its time stamps it). */
const entryAt = (e) => lines().findIndex((x) => x.kind === 'instruction-entry' && x.at === e?.at && x.method === e?.method)
/** Where in the log the TUIs started (opencode given --server). */
const tuiAt = () => lines().flatMap((e, i) => (e.kind === 'launch' && Array.isArray(e.args) && e.args.includes('--server') ? [i] : []))

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const f of [fakeLog, modeFile]) fs.rmSync(f, { force: true })
  fs.writeFileSync(modeFile, '')
  fs.mkdirSync(userData, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'opencode'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.opencode = { ...cfg.settings.providers.opencode, executablePath: path.join(__dirname, 'fake-opencode', 'opencode.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = { FAKE_OPENCODE_LOG: fakeLog, FAKE_OPENCODE_SEED_ENTRY: 'someone.else=theirs', FAKE_OPENCODE_ENTRY_MODE: modeFile, CW_TEST_CLI_HOME_CONNECTION: '0' }
  const { app, page } = await lib.launch({ userData, env })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'opencode')
    await lib.openWorkspace(inv, page, ws)
    const fake = path.join(__dirname, 'fake-opencode', 'opencode.cmd')
    const selected = await lib.until(async () => (await inv('provider:refresh', 'opencode'))?.opencode?.path ?? null, HUNG_MS)
    if (String(selected ?? '').toLowerCase() !== fake.toLowerCase()) {
      console.log(`FAIL stopped before any session: Combwork selected ${selected ?? 'no opencode'}, not the fake`)
      process.exitCode = 1
      return
    }
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant' && s.status !== 'stopped') ?? null
    const card = await inv('tasks:create', { title: 'Friendlier greeting', project: 'alpha', column: 'doing' })
    await inv('journal:set', { enabled: true })

    // --- The Assistant on an OpenCode account, its connection naming its model (kept to its own provider, HI-2769).
    const account = await inv('connections:add', 'opencode', 'OpenCode · Local')
    await inv('connections:setOn', account.id, true)
    const conn = await inv('connection:add', account.id, { name: 'OpenCode · big-pickle', model: 'opencode/big-pickle' })
    await inv('agents:update', home, 'assistant', { provider: 'opencode', connection: conn.id })
    const start = async (resumeId) => {
      const tuis = tuiAt().length
      await inv('session:start', home, { agentId: 'assistant', ...(resumeId ? { resumeId } : {}) })
      return lib.until(async () => (tuiAt().length > tuis ? tuiAt()[tuis] : null), HUNG_MS)
    }
    const stop = async () => {
      await inv('session:stop', home, 'assistant')
      await lib.until(async () => !(await live()), HUNG_MS)
    }

    // --- Its start: the view put before the TUI started, naming the card in hand; someone else's entry untouched.
    const firstTui = await start()
    const sid = (await live())?.sessionId
    const ops = entryOps()
    const put = ops.find((e) => e.method === 'PUT' && e.status === 204)
    const putAt = entryAt(put)
    check('the view went into its session as combwork.state-view, before its TUI started', !!put && put.key === 'combwork.state-view' && put.session === sid && putAt >= 0 && putAt < firstTui, JSON.stringify({ ops, putAt, firstTui }))
    check('…naming the card in hand, and leaving someone else\'s entry as it was', typeof put?.value === 'string' && put.value.includes(`#${card.number}`) && JSON.stringify(put.keys) === '["someone.else","combwork.state-view"]', JSON.stringify(put))

    // --- A compaction Combwork asked for, seen to end: the view put again after it.
    const before = entryOps().length
    await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS)
    await inv('session:compact', home, undefined, 'assistant')
    const ended = await lib.until(async () => lines().findIndex((e) => e.kind === 'compaction-end' && e.session === sid) + 1 || null, HUNG_MS)
    const again = await lib.until(async () => entryOps().slice(before).find((e) => e.method === 'PUT' && e.status === 204) ?? null, HUNG_MS)
    check('after the compaction ended, the view put again (once)', !!again && entryAt(again) > ended - 1 && entryOps().slice(before).filter((e) => e.method === 'PUT').length === 1, JSON.stringify({ ended, ops: entryOps().slice(before) }))

    // --- The stream lost across a compaction's end: the launcher's repair snapshot shows it ended, and the view is put
    // again, once; another resync after it puts nothing more.
    fs.writeFileSync(modeFile, 'drop-compaction')
    const lostFrom = entryOps().length
    const compactions = lines().filter((e) => e.kind === 'compaction-end').length
    await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS)
    await inv('session:compact', home, undefined, 'assistant')
    await lib.until(async () => (lines().filter((e) => e.kind === 'compaction-end').length > compactions ? true : null), HUNG_MS)
    fs.writeFileSync(modeFile, '')
    const recovered = await lib.until(async () => entryOps().slice(lostFrom).find((e) => e.method === 'PUT' && e.status === 204) ?? null, HUNG_MS)
    check("a compaction whose end the stream missed: the resync's snapshot recovers it and the view is put again", !!recovered && typeof recovered.value === 'string' && /after a compaction/.test(recovered.value), JSON.stringify(entryOps().slice(lostFrom)))
    // Another resync (a turn that drops the stream at its start): no compaction to recover, so nothing more is put.
    const resyncFrom = entryOps().length
    const streams = () => lines().filter((e) => e.kind === 'http' && e.method === 'GET' && e.path === '/api/event').length
    const streamsBefore = streams()
    const turns = lines().filter((e) => e.kind === 'turn-end').length
    await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS)
    await lib.sendPrompt(inv, lib.ptyKey(home, 'assistant'), 'drop events then reply', { submitted: async () => lines().some((e) => e.kind === 'turn' && /drop events/.test(e.text ?? '')), tries: 2, waitMs: HUNG_MS })
    await lib.until(async () => (lines().filter((e) => e.kind === 'turn-end').length > turns ? true : null), HUNG_MS)
    await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS)
    // The launcher reconnected (a new stream) and so resynced: and still nothing more was put.
    await lib.until(async () => (streams() > streamsBefore ? true : null), HUNG_MS)
    check('…and a later resync (the stream reconnected) puts nothing more', streams() > streamsBefore && entryOps().slice(resyncFrom).filter((e) => e.method === 'PUT').length === 0, JSON.stringify({ streams: [streamsBefore, streams()], ops: entryOps().slice(resyncFrom) }))
    await stop()

    // --- Resumed with its put refused: a refusal, never counted as given, and the session still starts.
    fs.writeFileSync(modeFile, 'refuse')
    const refusedFrom = entryOps().length
    await start(sid)
    const refused = await lib.until(async () => entryOps().slice(refusedFrom).find((e) => e.method === 'PUT') ?? null, HUNG_MS)
    check('a refused put is logged as refused (500), and the resumed session starts all the same', refused?.status === 500 && !!(await live()), JSON.stringify(refused))
    fs.writeFileSync(modeFile, '')
    await stop()

    // --- Resumed with its put never answered: the TUI starts within the launch's bound all the same, and no put of that
    // run is ever taken afterwards (cut off at Combwork's budget: uncertain, never counted as given).
    fs.writeFileSync(modeFile, 'hang')
    const hungFrom = entryOps().length
    const t0 = Date.now()
    await start(sid)
    check('a put never answered: the resumed TUI starts all the same, within its bound', Date.now() - t0 < HUNG_MS && !!(await live()), `${Date.now() - t0} ms`)
    fs.writeFileSync(modeFile, '')
    await stop()
    check('…and no put of that run was taken', entryOps().slice(hungFrom).every((e) => e.status === 'hung'), JSON.stringify(entryOps().slice(hungFrom)))

    // --- Resumed: the new run puts it.
    const resumedFrom = entryOps().length
    const resumedTui = await start(sid)
    const resumedPut = entryOps().slice(resumedFrom).find((e) => e.method === 'PUT' && e.status === 204)
    check('resumed, the new run put the view before its TUI', !!resumedPut && entryAt(resumedPut) >= 0 && entryAt(resumedPut) < resumedTui, JSON.stringify(entryOps().slice(resumedFrom)))
    await stop()

    // --- The journal off: on the next resume Combwork's entry is removed, someone else's left.
    await inv('journal:set', { enabled: false })
    const offFrom = entryOps().length
    await start(sid)
    const removed = await lib.until(async () => entryOps().slice(offFrom).find((e) => e.method === 'DELETE') ?? null, HUNG_MS)
    check("with the journal off, Combwork's entry is removed on the resume, someone else's left; nothing put", removed?.status === 204 && removed.key === 'combwork.state-view' && JSON.stringify(removed.keys) === '["someone.else"]' && !entryOps().slice(offFrom).some((e) => e.method === 'PUT'), JSON.stringify(entryOps().slice(offFrom)))
    await stop()
    check('the fake logged no errors', !lines().some((e) => e.kind === 'error'), JSON.stringify(lines().filter((e) => e.kind === 'error')))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
