// The Assistant leaves a message for an agent that can't take a prompt now (#530), on fake Claude Code agents
// (fake-claude/), through cw_message_agent as the Assistant calls it (hive-mcp.js with the Assistant's token): a
// watching reviewer is woken by it at once and keeps its watch (cw_prompt_agent is refused and points to the tool); a
// working builder gets it queued (a delivery, #647, with its id), its pane's ⋯ shows "1 unread" (#977), and it is typed as its next
// line once the builder is idle, with its id to ack; cw_agent_activity says what waits and that it was offered (typed;
// received only when fetched with cw_inbox), and the pane shows it until the builder acks it with cw_inbox; the user
// cancels one from the ⋯, and it is
// never typed; one tied to a card's round (#652) is refused for a card out of Doing and Review, and stale, never told,
// once that card passes; a message queued for an agent whose card or agent watch fires meanwhile goes in one doorbell
// with that wake, read first; one whose sender may no longer send it (Control turned down) is refused, never typed. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'agentmessage-profile')
const ws = path.join(lib.WORK, 'agentmessage-ws')
const claudeHome = path.join(lib.WORK, 'agentmessage-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47867))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
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

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  // What each agent read when Combwork's doorbell rang (#650: fake Claude Code reads its inbox then), and the doorbells.
  const wakeLog = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent)
  }
  // As their checks read them: cards by number (named by key too, #1219: checked once below).
  const wakes = (agent) => wakeLog(agent).map((w) => lib.unkey(w.text))
  const bells = (agent) => wakeLog(agent).map((w) => lib.unkey(w.doorbell ?? ''))
  const say = async (id, text) => {
    // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(alpha, id) })
  }
  const idle = async (id) => ['ready', 'finished'].includes((await live(alpha, id))?.status)

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
  check('the agents start', !!(await until(async () => (await idle(builder.id)) && (await idle(reviewer.id)), HUNG_MS)))

  // The Assistant, for its own token: its tools go through hive-mcp.js as it calls them.
  const home = (await inv('workspace:refresh')).assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)
  const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const tool = (name, args) => {
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, HIVE_API_TOKEN: '', CW_PROJECT: '' }),
      timeout: 60000
    }).toString()
    const r = JSON.parse(out.split('\n')[0]).result
    return { text: r.content[0].text, isError: !!r.isError }
  }
  const activity = (agent) => JSON.parse(tool('cw_agent_activity', { project: 'alpha', agent }).text)
  // Its latest delivery (#647), as cw_agent_activity shows it: id, state, times.
  const lastDelivery = (agent) => activity(agent).inbox?.deliveries?.at(-1) ?? null

  // --- 1. A watching reviewer: cw_prompt_agent is refused and names the tool; a message wakes it, and its watch stays.
  const c1 = (await inv('tasks:create', { title: 'Review me later', project: 'alpha', agent: builder.id, column: 'doing' })).number
  await say(reviewer.id, `cw cw_wait_for_tasks ${JSON.stringify({ cards: [c1], column: 'review', wake: true })}`)
  check('the reviewer watches the card', !!(await until(async () => (await live(alpha, reviewer.id))?.status === 'watching', 15000)))
  const prompted = tool('cw_prompt_agent', { project: 'alpha', agent: 'Reviewer', text: 'Review the card' })
  check('cw_prompt_agent refuses a watching agent and points to cw_message_agent', prompted.isError && /cw_message_agent/.test(prompted.text), prompted.text)
  const sent = tool('cw_message_agent', { project: 'alpha', agent: 'Reviewer', text: `Darren answered #${c1}: review it when it returns.` })
  check('a message to a watching agent is told at once, with its id', !sent.isError && sent.text === 'Told Reviewer now (m1): it reads it with cw_inbox; its watch carries on.', sent.text)
  // Its doorbell (#650): the id, never the text, and that its watch carries on; it reads the message with cw_inbox.
  check('…its doorbell names it and says its watch carries on', !!(await until(async () => bells('Reviewer').some((t) => t.startsWith(`[CW] New in your inbox: 1 message (m1). Call cw_inbox to read it, act on it, then ack it. (Your watch is still on, waiting for #${c1} → Review:`)), 15000)), JSON.stringify(bells('Reviewer')))
  check('…and the reviewer reads it in its inbox', wakes('Reviewer').includes(`Darren answered #${c1}: review it when it returns.`) && !bells('Reviewer').some((t) => t.includes('Darren answered')), JSON.stringify(wakes('Reviewer')))
  check('…and is watching the card again after it', !!(await until(async () => (await live(alpha, reviewer.id))?.status === 'watching' && (await live(alpha, reviewer.id))?.watch?.cards?.[0] === c1, 15000)))
  await inv('tasks:update', c1, { column: 'review' })
  check('…so the card arriving in Review still wakes it', !!(await until(async () => wakes('Reviewer').some((t) => t.startsWith(`[CW] #${c1} (Builder's card) is in Review`)), 20000)), JSON.stringify(wakes('Reviewer')))

  // --- 2. A working builder: queued, shown in its pane, its doorbell typed once it is idle.
  await say(builder.id, 'work 8')
  check('the builder works', !!(await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)))
  const queued = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: `Add #${c1}'s follow-up to your lane after it.` })
  // Its id: the project's next (the reviewer's wake was a delivery too, #649).
  const mid = /^Queued for Builder \((m\d+), working\)/.exec(queued.text)?.[1] ?? '?'
  check('a message to a working agent is queued', !queued.isError && queued.text === `Queued for Builder (${mid}, working): Combwork tells it at its next tool call, at its turn's end or once it is idle; 1 waiting. cw_agent_activity says when it is received and acked.`, queued.text)
  // Its pane's ⋯ (#977): a badge, "1 unread" in its name's description, and an entry whose menu lists the messages.
  const pane = page.locator('.pane-header-bar', { hasText: 'Builder' }).locator('.pane-more')
  const unread = async () => /unread/.test((await pane.getAttribute('aria-description').catch(() => null)) ?? '')
  check("the builder's pane shows it waiting", !!(await until(async () => /1 unread/.test((await pane.getAttribute('aria-description').catch(() => null)) ?? '') && (await pane.locator('.pane-more-badge').count()) === 1, 10000)))
  await pane.click()
  await page.locator('.menu .menu-item', { hasText: '1 unread' }).click()
  check('…its ⋯ says who from and what', !!(await until(async () => (await page.locator('.menu .menu-item', { hasText: `${mid} from the Assistant (waiting): Add #${c1}'s follow-up` }).count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'agentmessage-waiting.png') })
  await page.keyboard.press('Escape')
  const waiting = activity('Builder')
  check('its activity lists the message waiting', waiting.inbox?.unread === 1 && waiting.inbox.deliveries.at(-1)?.id === mid && waiting.inbox.deliveries.at(-1)?.from === 'the Assistant' && waiting.inbox.deliveries.at(-1)?.state === 'queued', JSON.stringify(waiting))
  check('…not typed while it works', !wakes('Builder').length)
  check('once idle, its doorbell is typed, and the builder reads it', !!(await until(async () => wakes('Builder').some((t) => t === `Add #${c1}'s follow-up to your lane after it.`), 30000)) && bells('Builder').includes(`[CW] New in your inbox: 1 message (${mid}). Call cw_inbox to read it, act on it, then ack it.`), JSON.stringify(wakeLog('Builder')))
  // Read (#650: the only receipt): received through the inbox, and no longer unread in the pane; still the builder's to ack.
  check('…received as it reads it, and no longer unread in its pane', !!(await until(async () => lastDelivery('Builder')?.state === 'received' && lastDelivery('Builder')?.receivedVia === 'inbox' && !(await unread()), 15000)), JSON.stringify(lastDelivery('Builder')))
  const done = activity('Builder')
  check('…and its activity says when it was offered and received', done.inbox?.unread === 0 && !!done.inbox.deliveries.at(-1)?.offered && !!done.inbox.deliveries.at(-1)?.received, JSON.stringify(done))
  await until(() => idle(builder.id), 15000)
  // While it acts on that one, a second comes (#1531): one call acks the first and reads the second (ack with read),
  // which is received, not acked.
  await say(builder.id, `waitfile agentmessage-ack-go then cw cw_inbox {"ack":["${mid}"],"read":true}`)
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  const second = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'And note it in the README.' })
  const mid2 = /\((m\d+), working\)/.exec(second.text)?.[1] ?? '?'
  fs.writeFileSync(path.join(claudeHome, 'agentmessage-ack-go'), '')
  const state = (id) => (activity('Builder').inbox?.deliveries ?? []).find((d) => d.id === id)
  check('the builder acks the first and reads the second in one call (ack with read): the first acked, the second received only', !!(await until(async () => state(mid)?.state === 'acked' && state(mid2)?.state === 'received' && state(mid2)?.receivedVia === 'inbox', 15000)), JSON.stringify([state(mid), state(mid2)]))
  await until(() => idle(builder.id), 15000)
  // The reply it got, from its transcript: the ack line, then the read with the second, to ack once acted on.
  const s = await live(alpha, builder.id)
  const items = s?.sessionId ? ((await inv('transcript:read', alpha, s.sessionId).catch(() => null))?.items ?? []) : []
  const reply = items.filter((x) => x.kind === 'tool' && x.tool.name === 'combwork · cw_inbox').at(-1)?.tool.result ?? ''
  check('…its reply: the ack line, then the second, received', reply === `Acked ${mid}.\n1 new:\n${mid2} · the Assistant: And note it in the README.\nAck each with cw_inbox (ack: its ids) once you have acted on it.`, reply)
  await say(builder.id, `cw cw_inbox {"ack":["${mid2}"]}`)
  check('the builder acks it (cw_inbox): acked', !!(await until(async () => lastDelivery('Builder')?.state === 'acked' && !(await unread()), 15000)), JSON.stringify(lastDelivery('Builder')))

  // --- 3. Cancelled by the user from the pane: never typed.
  await until(() => idle(builder.id), 15000)
  await say(builder.id, 'work 6')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Never mind this one.' })
  await until(unread, 10000)
  await pane.click()
  await page.locator('.menu .menu-item', { hasText: '1 unread' }).click()
  await page.getByText('Cancel the Message', { exact: true }).click()
  check('the user cancels it from the pane', !!(await until(async () => !(await unread()), 5000)))
  check('…its activity says so', lastDelivery('Builder')?.state === 'cancelled' && lastDelivery('Builder')?.detail === 'cancelled by the user', JSON.stringify(lastDelivery('Builder')))
  await until(() => idle(builder.id), 20000)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that the cancelled message is NOT typed.
  check('…and it is never typed', !wakes('Builder').some((t) => t.includes('Never mind this one.')), JSON.stringify(wakes('Builder')))

  // --- 3b. Tied to a card round (#652): refused for a card out of Doing and Review; once the card passes, stale, never told.
  const c3 = (await inv('tasks:create', { title: 'Round-tied', project: 'alpha', agent: builder.id, column: 'todo' })).number
  const early = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Too early.', card: c3 })
  check('a message tied to a card not in Doing or Review is refused', early.isError && lib.unkey(early.text).includes(`#${c3} left Doing and Review: a message tied to its round needs it in Doing or Review`), early.text)
  await inv('tasks:update', c3, { column: 'doing' })
  // Busy until the card has passed (holduntil), so each message below is queued, never told.
  await say(builder.id, 'holduntil agentmessage-round-go')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  const tied = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Round 1: also cover the empty case.', card: c3 })
  const tiedId = /\((m\d+), for #\d+ round 1, working\)/.exec(lib.unkey(tied.text))?.[1]
  check('a message tied to its round is queued, saying the round', !tied.isError && !!tiedId && lib.unkey(tied.text).startsWith(`Queued for Builder (${tiedId}, for #${c3} round 1, working)`), tied.text)
  // Its reply names the card by key and number however it was given (#1219): its number, its key, or a key it had.
  const key3 = (await inv('tasks:list')).find((c) => c.number === c3)?.key
  const byNumber = `${key3}`
  check('…naming the card by key and number when given its number (#1219)', tied.text.includes(`, for ${byNumber} round 1, working)`), tied.text)
  const byKey = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Round 1: by key.', card: key3.toLowerCase() })
  check('…and when given its key, in any case', !byKey.isError && byKey.text.includes(`, for ${byNumber} round 1, working)`), byKey.text)
  const renamed = await inv('project:setKey', alpha, 'ALX')
  const byAlias = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Round 1: by its old key.', card: key3 })
  check('…and when given the key its project had: by the key it has now', renamed === 'ALX' && !byAlias.isError && byAlias.text.includes(`, for ALX-${key3.split('-')[1]} round 1, working)`), byAlias.text)
  await inv('tasks:update', c3, { column: 'passed' })
  const tiedDelivery = () => activity('Builder').inbox?.deliveries?.find((d) => d.id === tiedId) ?? null
  check('…the card passes before it is read: stale, saying why', !!(await until(() => tiedDelivery()?.state === 'stale' && lib.unkey(tiedDelivery()?.detail) === `#${c3} passed review`, 15000)), JSON.stringify(tiedDelivery()))
  check('…and no longer unread in its pane', !!(await until(async () => !(await unread()), 10000)))
  fs.writeFileSync(path.join(claudeHome, 'agentmessage-round-go'), '')
  await until(() => idle(builder.id), 20000)
  // Stale is an end: nothing can offer it after, so no doorbell names it and the builder never reads it.
  check('…never told or read', !bells('Builder').some((t) => t.includes(`${tiedId})`) || t.includes(`${tiedId},`)) && !wakes('Builder').some((t) => t.includes('Round 1: also cover the empty case.') || t.includes('Round 1: by')), JSON.stringify(wakeLog('Builder')))

  // --- 4. A message queued for a busy reviewer whose card watch fires meanwhile: both in one line, the message first.
  const c2 = (await inv('tasks:create', { title: 'Revised scope', project: 'alpha', agent: builder.id, column: 'doing' })).number
  await until(() => idle(reviewer.id), 15000)
  await say(reviewer.id, `cw cw_wait_for_tasks ${JSON.stringify({ cards: [c2], column: 'review', wake: true })}`)
  await until(async () => (await live(alpha, reviewer.id))?.status === 'watching', 15000)
  await say(reviewer.id, 'work 8')
  check('the watching reviewer works (the user gave it something)', !!(await until(async () => (await live(alpha, reviewer.id))?.status === 'working', 10000)))
  const before4 = wakes('Reviewer').length
  check('a message for it is queued', tool('cw_message_agent', { project: 'alpha', agent: 'Reviewer', text: 'Use the revised review scope.' }).text.startsWith('Queued for Reviewer (m'))
  await inv('tasks:update', c2, { column: 'review' })
  check('its watch wake and the message ring together, read in one go, the message first', !!(await until(async () => wakes('Reviewer').length > before4, 30000)) && /^\[CW\] New in your inbox: 1 message and 1 card event \(#\d+\) \(m\d+, m\d+\)\./.test(bells('Reviewer')[before4]) && /^Use the revised review scope\. \[CW\] #\d+ \(Builder's card\) is in Review/.test(wakes('Reviewer')[before4]), JSON.stringify(wakeLog('Reviewer').slice(before4)))
  check('its wakes name cards by key alone (#1219, HI-1661)', wakeLog('Reviewer').some((w) => lib.KEYED.test(w.text ?? '')), JSON.stringify(wakeLog('Reviewer').slice(-1)))
  await until(() => idle(reviewer.id), 15000)
  check('…and only once, received as it read it', wakes('Reviewer').filter((t) => t.includes('Use the revised review scope.')).length === 1 && !!(await until(() => activity('Reviewer').inbox?.deliveries?.filter((d) => d.text.startsWith('Use the revised review scope.')).every((d) => d.state === 'received'), 10000)), JSON.stringify(wakes('Reviewer').slice(before4)))

  // --- 5. The same with an agent watch: the builder waits for the reviewer to finish, is busy, and gets a message. The
  // order is held, not raced (#598): the reviewer works until the message is queued and the builder until its watch has
  // fired (each turn ends when the test makes its file, holduntil), so the wake waits for the builder and the message rides it.
  const firedFor = (agentId) => {
    try {
      return require('./storeDocs.cjs').storeDocs(ws, 'watches').some((w) => w.agentId === agentId && w.agents && w.fired)
    } catch {
      return false
    }
  }
  await until(() => idle(builder.id), HUNG_MS)
  await say(reviewer.id, 'holduntil agentmessage-reviewer-go')
  await until(async () => (await live(alpha, reviewer.id))?.status === 'working', HUNG_MS)
  await say(builder.id, `cw cw_wait_for_agents ${JSON.stringify({ agents: [{ project: 'alpha', agent: 'Reviewer' }], wake: true })}`)
  check('the builder watches the reviewer (an agent watch)', !!(await until(async () => (await live(alpha, builder.id))?.status === 'watching', HUNG_MS)))
  await say(builder.id, 'holduntil agentmessage-builder-go')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', HUNG_MS)
  const before5 = wakes('Builder').length
  tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Merge main before your next card.' })
  fs.writeFileSync(path.join(claudeHome, 'agentmessage-reviewer-go'), '')
  check("the reviewer finishing fires the busy builder's agent watch", !!(await until(() => firedFor(builder.id), HUNG_MS)))
  check('…and nothing is typed into the builder while it works', wakes('Builder').length === before5, JSON.stringify(wakes('Builder').slice(before5)))
  fs.writeFileSync(path.join(claudeHome, 'agentmessage-builder-go'), '')
  check('its agent watch wake and the message ring together, read in one go, the message first', !!(await until(async () => wakes('Builder').length > before5, HUNG_MS)) && wakes('Builder')[before5].startsWith('Merge main before your next card. [CW] Reviewer (alpha) finished'), JSON.stringify(wakeLog('Builder').slice(before5)))

  // --- 6. Settings → Assistant → Control turned down while a message waits: refused, never typed.
  await until(() => idle(builder.id), 15000)
  await say(builder.id, 'work 6')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'This needs Control agents.' })
  await inv('settings:update', { assistant: { control: 'look' } })
  check('with Control turned down, the waiting message is refused when the builder is idle', !!(await until(async () => lastDelivery('Builder')?.state === 'refused', 30000)), JSON.stringify(lastDelivery('Builder')))
  check('…and never typed', !wakes('Builder').some((t) => t.includes('This needs Control agents.')), JSON.stringify(wakes('Builder')))
  await inv('settings:update', { assistant: { control: 'projects' } })

  // --- 7. The project's own carrying-on switches off (#1497): the queued reply names only the ways left on, else that it
  // waits in its inbox.
  await until(() => idle(builder.id), 15000)
  await inv('project:updateConfig', alpha, { inboxCheckpoints: 'off', inboxIdleWakes: 'off' })
  await say(builder.id, 'work 6')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  const turnEnd = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Told at its turn’s end only.' })
  check("with the project's checkpoints and idle wakes off, the queued reply names only its turn's end", !turnEnd.isError && /\): Combwork tells it at its turn's end; \d+ waiting\./.test(turnEnd.text), turnEnd.text)
  await inv('project:updateConfig', alpha, { inboxStopContinuation: 'off' })
  const none = tool('cw_message_agent', { project: 'alpha', agent: 'Builder', text: 'Nothing tells it of this one.' })
  check('…all three off: it waits in its inbox, the user can Deliver Now', !none.isError && none.text.includes('): it waits in its inbox until it reads it with cw_inbox (the user can Deliver Now);'), none.text)
  check('…and the messages are cancelled', /^Cancelled 2 messages waiting for Builder\.$/.test(tool('cw_message_agent', { project: 'alpha', agent: 'Builder', cancel: true }).text))
  await inv('project:updateConfig', alpha, { inboxCheckpoints: 'inherit', inboxStopContinuation: 'inherit', inboxIdleWakes: 'inherit' })

  await inv('session:stop', alpha)
  await inv('session:stop', home)
  await until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
