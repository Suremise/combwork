// Deliveries (#647): what the Assistant leaves for an agent is a saved record with an id and a state, on fake Claude Code
// agents (fake-claude/) and the Assistant's hive tools (cw-mcp.js with its token). A message for a working agent is
// queued and saved for the project (in the workspace's .combwork/combwork.db, #1018), its pane shows "✉ 1 unread"; the agent fetches it mid-turn with
// cw_inbox (received, so it isn't typed after) and acks it (acked); one typed into it is offered, and received once its
// CLI takes the line (#649), then acked; one not acked in time shows as overdue; cw_agent_activity gives each one's state
// and times, so the Assistant sees them. A stop of the agent keeps what waits for it; once the Assistant's launch ends,
// its message still waiting is refused (#645) and shown in the Assistant's activity list. Then Combwork restarts: what was
// refused stays so; a card event Combwork was offering when it stopped (as a watch's wake is, #649) is restored as uncertain,
// offered once more to the agent once it is resumed, saying it may repeat, and received once its CLI takes it. Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
// Overdue this long after it was made (instead of 30 minutes), so the suite sees one become overdue.
const OVERDUE_MS = 8000

const userData = path.join(lib.WORK, 'deliveries-profile')
const ws = path.join(lib.WORK, 'deliveries-ws')
const claudeHome = path.join(lib.WORK, 'deliveries-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47869))
const API = `http://127.0.0.1:${PORT}`
const { deliveriesOf, deliveriesPlace, putStoreDoc, storeMeta } = require('./storeDocs.cjs')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// The project's deliveries as saved (#1018: in the workspace's database).
const saved = () => deliveriesOf(alpha)

/** Starts Combwork on the suite's profile and workspace; its helpers. */
async function start() {
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off', CW_TEST_DELIVERY_OVERDUE_MS: String(OVERDUE_MS) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  return { app, page, inv, live }
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))

  let { app, page, inv, live } = await start()
  const until = (fn, ms) => lib.until(fn, ms, 250)
  // What the builder read when Combwork's doorbell rang (#650: fake Claude Code reads its inbox then), and the doorbells.
  const wakeLog = () => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === 'Builder')
  }
  const wakes = () => wakeLog().map((w) => w.text)
  const bells = () => wakeLog().map((w) => w.doorbell ?? '')
  const say = async (id, text) => {
    // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(alpha, id) })
  }
  const idle = async (id) => ['ready', 'finished'].includes((await live(alpha, id))?.status)
  /** What the agent's hive tool calls got back (its transcript's tool results), for the inbox's replies. */
  const toolResults = (sessionId) => {
    const dir = path.join(claudeHome, 'projects')
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).map((d) => path.join(dir, d, `${sessionId}.jsonl`)).find((x) => fs.existsSync(x)) : null
    if (!f) return []
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).flatMap((l) => {
      const e = JSON.parse(l)
      const c = e.message?.content
      return Array.isArray(c) ? c.filter((x) => x.type === 'tool_result').map((x) => String(x.content)) : []
    })
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  await inv('session:start', alpha, { agentId: builder.id })
  check('the builder starts', !!(await until(() => idle(builder.id), HUNG_MS)))
  const sessionId = (await live(alpha, builder.id)).sessionId

  const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const startAssistant = async () => {
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)
    return home
  }
  let home = await startAssistant()
  const tool = (name, args) => {
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, CW_API_TOKEN: '', CW_PROJECT: '' }),
      timeout: 60000
    }).toString()
    const r = JSON.parse(out.split('\n')[0]).result
    return { text: r.content[0].text, isError: !!r.isError }
  }
  const delivery = (id) => JSON.parse(tool('cw_agent_activity', { project: 'alpha', agent: 'Builder', detail: true }).text).inbox?.deliveries?.find((d) => d.id === id) ?? null
  // What its pane's ⋯ says needs a look (#977: its name's description, as its badge's hover lists it).
  const paneText = async () => (await page.locator('.pane-header-bar', { hasText: 'Builder' }).locator('.pane-more').getAttribute('aria-description').catch(() => null)) ?? ''

  // --- 1. Queued for a working agent: saved, shown in its pane, in its activity.
  await say(builder.id, 'waitfile deliveries-go1 then cw cw_inbox {} holduntil deliveries-go2')
  check('the builder works', !!(await until(async () => (await live(alpha, builder.id))?.status === 'working', HUNG_MS)))
  const left = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Rebase on main before the next card.' })
  check('a message for the working builder is queued, with its id', !left.isError && left.text.startsWith('Queued for Builder (m1, working)'), left.text)
  check('…saved in the project, with its sender and launch (no token)', saved()[0]?.id === 'm1' && saved()[0]?.state === 'queued' && saved()[0]?.from?.kind === 'assistant' && !!saved()[0]?.from?.launch && !/token/i.test(JSON.stringify(saved())), JSON.stringify(saved()))
  check("…its pane shows '1 unread'", !!(await until(async () => (await paneText()).trim().startsWith('1 unread'), HUNG_MS)), await paneText())
  check('…and its activity has it queued', delivery('m1')?.state === 'queued' && delivery('m1')?.from === 'the Assistant' && !!delivery('m1')?.created, JSON.stringify(delivery('m1')))

  // --- 2. The agent fetches it mid-turn with cw_inbox: received, and not typed after.
  fs.writeFileSync(path.join(claudeHome, 'deliveries-go1'), '')
  check('cw_inbox gives it the message, with its id and sender', !!(await until(() => toolResults(sessionId).some((t) => t.startsWith('1 new:\nm1 · the Assistant: Rebase on main before the next card.')), HUNG_MS)), JSON.stringify(toolResults(sessionId)))
  check('…it is received (fetched)', !!(await until(() => delivery('m1')?.state === 'received', HUNG_MS)) && delivery('m1')?.receivedVia === 'inbox' && !!delivery('m1')?.received, JSON.stringify(delivery('m1')))
  check('…and the pane no longer counts it unread', !!(await until(async () => !/unread/.test(await paneText()), HUNG_MS)), await paneText())
  fs.writeFileSync(path.join(claudeHome, 'deliveries-go2'), '')
  check('the builder is idle again', !!(await until(() => idle(builder.id), HUNG_MS)))
  // A message left now is told at once; had m1 been offered after it was received, its doorbell would name it too.
  const second = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Then take #2.' })
  check('a message for the idle builder is told at once', !second.isError && second.text === 'Told Builder now (m2): it reads it with cw_inbox.', second.text)
  check('…its doorbell names it by id, never its text (#650)', !!(await until(() => bells().includes('[CW] New in your inbox: 1 message (m2). Call cw_inbox to read it, act on it, then ack it.'), HUNG_MS)), JSON.stringify(bells()))
  check('…and the builder reads it in its inbox', !!(await until(() => wakes().includes('Then take #2.'), HUNG_MS)), JSON.stringify(wakes()))
  check('…the message it had fetched is never offered again', !wakes().some((t) => t.includes('Rebase on main')) && !bells().some((t) => /\bm1\b/.test(t)), JSON.stringify(wakeLog()))
  check('…offered (its doorbell typed), and received once it read it', !!(await until(async () => wakes().length > 0 && delivery('m2')?.state === 'received' && (await idle(builder.id)), HUNG_MS)) && delivery('m2')?.receivedVia === 'inbox' && !!delivery('m2')?.offered, JSON.stringify(delivery('m2')))

  // --- 3. Acked: the agent says it acted on m1; m2 isn't, and becomes overdue.
  await until(() => idle(builder.id), HUNG_MS)
  await say(builder.id, 'cw cw_inbox {"ack":["m1"]}')
  check('cw_inbox ack says what it acked', !!(await until(() => toolResults(sessionId).includes('Acked m1.'), HUNG_MS)), JSON.stringify(toolResults(sessionId).slice(-2)))
  check('…and the Assistant sees it acked, with its times', !!(await until(() => delivery('m1')?.state === 'acked', HUNG_MS)) && ['created', 'received', 'acked'].every((k) => !!delivery('m1')?.[k]) && !delivery('m1')?.overdue, JSON.stringify(delivery('m1')))
  check('m2, not acked in time, is overdue: in its activity', !!(await until(() => delivery('m2')?.overdue === true, HUNG_MS)), JSON.stringify(delivery('m2')))
  check("…and in the builder's pane", !!(await until(async () => /1 overdue/.test(await paneText()), HUNG_MS)), await paneText())
  await page.screenshot({ path: path.join(lib.WORK, 'deliveries-overdue.png') })
  await until(() => idle(builder.id), HUNG_MS)
  await say(builder.id, 'cw cw_inbox {"ack":["m2"]}')
  check('acked, it is no longer overdue', !!(await until(async () => delivery('m2')?.state === 'acked' && !(await paneText()), HUNG_MS)), JSON.stringify(delivery('m2')))

  // --- 4. The Assistant's launch ends with a message waiting: refused, and shown (#645); it stays so across a restart.
  await until(() => idle(builder.id), HUNG_MS)
  await say(builder.id, 'holduntil deliveries-go3')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', HUNG_MS)
  check('a message is queued for the working builder', tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'From the launch that ends.' }).text.startsWith('Queued for Builder (m3, working)'))
  // The builder stopped while it still works: a stop keeps what waits for it (nothing is offered to a stopped agent).
  await inv('session:stop', alpha)
  await until(async () => !(await live(alpha, builder.id)), HUNG_MS)
  check('…a stop of the builder keeps it waiting, saved', saved().find((d) => d.id === 'm3')?.state === 'queued', JSON.stringify(saved().find((d) => d.id === 'm3')))
  // The Assistant stops: the launch that left it has ended.
  await inv('session:stop', home)
  check("once the Assistant's launch has ended, its waiting message is refused", !!(await until(() => saved().find((d) => d.id === 'm3')?.state === 'refused', HUNG_MS)) && saved().find((d) => d.id === 'm3')?.detail === "the Assistant's session that left it ended", JSON.stringify(saved().find((d) => d.id === 'm3')))
  check("…and the refusal is in the Assistant's activity list", !!(await until(async () => (await inv('assistant:actions')).some((a) => a.text === 'A message for Builder (m3) was refused' && a.error === "the Assistant's session that left it ended"), HUNG_MS)), JSON.stringify((await inv('assistant:actions')).slice(-3)))
  await until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  await app.close()
  // A card event Combwork was offering the builder when it stopped (a watch's wake, #649): typed into a launch that is gone, its
  // CLI never took it.
  const place = deliveriesPlace(alpha)
  const next = storeMeta(place.ws, 'deliveries', 'next', place.scope)
  const at = new Date().toISOString()
  const eventId = `m${next}`
  putStoreDoc(place.ws, 'deliveries', eventId, { id: eventId, seq: next, agentId: builder.id, agentName: 'Builder', conversation: sessionId, kind: 'card-event', from: { kind: 'hive', name: 'Combwork' }, card: 7, body: '[CW] #7 is back in Review, round 2.', state: 'offered', created: at, offered: at, offers: 1, offerRun: 'a-launch-that-ended', expires: new Date(Date.now() + 3600_000).toISOString() }, { scope: place.scope, meta: { next: next + 1 } })

  ;({ app, page, inv, live } = await start())
  await page.getByText('alpha', { exact: true }).first().click()
  check('after the restart, the refused message stays refused', saved().find((d) => d.id === 'm3')?.state === 'refused', JSON.stringify(saved().find((d) => d.id === 'm3')))
  check('…and the card event is restored as uncertain: it may not have reached the builder', !!(await until(() => saved().find((d) => d.id === eventId)?.state === 'uncertain', HUNG_MS)) && saved().find((d) => d.id === eventId)?.detail === 'may not have reached it: Combwork stopped while offering it', JSON.stringify(saved().find((d) => d.id === eventId)))
  await inv('session:start', alpha, { agentId: builder.id, resumeId: sessionId })
  check('the builder is resumed in the same conversation', !!(await until(async () => (await idle(builder.id)) && (await live(alpha, builder.id))?.sessionId === sessionId, HUNG_MS)))
  check('…and is rung for the card event once more, saying it may repeat', !!(await until(() => bells().includes(`[CW] New in your inbox: 1 card event (#7) (${eventId}). Call cw_inbox to read it. (${eventId} again: Combwork restarted while offering it, so it may repeat.)`), HUNG_MS)), JSON.stringify(bells().slice(-2)))
  check('…which it reads', !!(await until(() => wakes().includes('[CW] #7 is back in Review, round 2.'), HUNG_MS)), JSON.stringify(wakes().slice(-2)))
  check('…never the refused message', !wakes().some((t) => t.includes('From the launch that ends.')), JSON.stringify(wakes()))
  check('…received as it read it, saved as such (a card event needs no ack)', !!(await until(() => saved().find((d) => d.id === eventId)?.state === 'received', HUNG_MS)) && saved().find((d) => d.id === eventId)?.receivedVia === 'inbox', JSON.stringify(saved().find((d) => d.id === eventId)))
  await until(() => idle(builder.id), HUNG_MS)
  check('…offered once more only', wakes().filter((t) => t.includes('is back in Review, round 2')).length === 1, JSON.stringify(wakes()))
  home = await startAssistant()
  check("the new Assistant launch sees each one's state", (() => {
    const r = JSON.parse(tool('cw_agent_activity', { project: 'alpha', agent: 'Builder', detail: true }).text).inbox?.deliveries ?? []
    return ['m1 acked', 'm2 acked', 'm3 refused', `${eventId} received`].every((x) => r.some((d) => `${d.id} ${d.state}` === x))
  })())

  await until(() => idle(builder.id), HUNG_MS)
  await inv('session:stop', alpha)
  await inv('session:stop', home)
  await until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
