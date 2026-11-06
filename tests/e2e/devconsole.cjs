// The developer console's capture (#636): nothing is captured until someone watches; a watched agent's launch, hooks
// and status line arrive live, each next to what Combwork made of it (the status it set), redacted (the prompt's text never
// reaches the console); an agent reads its own session over the Agent API and no other source (refused as unknown);
// Combwork's own events show an agent's API call; the setting off refuses every read; and reads never start capture: with no
// console open (before it opens and after it closes) they are told nothing is captured, and nothing is kept.
// Fake Claude Code; dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'devconsole-profile')
const ws = path.join(lib.WORK, 'devconsole-ws')
const claudeHome = path.join(lib.WORK, 'devconsole-claude-home')
const alpha = path.join(ws, 'alpha')
// A long project name and long, alike agent names: a listing's display labels cut them, its arguments must not.
const longProject = path.join(ws, 'developer-console-capture-and-recording-contract-fixtures-project')
const LONG_AGENTS = ['Builder for the developer console capture layer', 'Builder for the developer console capture layer 2']
const PORT = Number(lib.port(47871))
const BASE = `http://127.0.0.1:${PORT}`
// What the prompt says that must never reach the console.
const PRIVATE = 'zebra-umbrella-quartz'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(longProject)
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, devConsole: true }
  // Arguments that carry text: an inline option value, and a value that begins with a dash (#636 round 3).
  cfg.settings.providers['claude-code'].extraArgs = `--append-system-prompt=${PRIVATE}-inline --allowedTools -${PRIVATE}-dash`
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, token = apiToken) => {
      const r = await fetch(`${BASE}${route}`, { method, headers: { Authorization: `Bearer ${token}` } })
      return { status: r.status, body: await r.json().catch(() => null) }
    }

    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2' })
    for (const name of LONG_AGENTS) await lib.addAgent(inv, longProject, { name })
    const sources = await lib.until(async () => {
      const list = await inv('console:sources')
      return list.some((s) => s.agentId === b1.id) && list.some((s) => s.agentId === b2.id) ? list : null
    }, HUNG_MS)
    const b1Source = sources?.find((s) => s.agentId === b1.id)
    check("the window lists the workspace's agents, its Assistant and Combwork as sources", !!b1Source && sources.some((s) => s.kind === 'assistant') && sources.some((s) => s.kind === 'combwork'), JSON.stringify(sources))
    check('…none of them captured while nobody watches', sources?.every((s) => !s.capturing && s.events === 0), JSON.stringify(sources))

    // --- Every listed source reads back with exactly the arguments the listing gives (long and alike names too).
    const listing = await api('GET', '/v1/console/sources?limit=100')
    const misread = []
    for (const row of listing.body?.sources ?? []) {
      const q = new URLSearchParams(row.select).toString()
      const r = await api('GET', `/v1/console/events?${q}`)
      if (r.status !== 200 || JSON.stringify(r.body?.source?.select) !== JSON.stringify(row.select)) misread.push(`${q} → ${r.status} ${JSON.stringify(r.body)}`)
    }
    check('every listed source reads with its listed arguments', listing.body?.total >= 6 && misread.length === 0, misread.join('; ') || JSON.stringify(listing.body))
    const longRows = (listing.body?.sources ?? []).filter((row) => row.select?.project === path.basename(longProject))
    check('…the long project given whole, each alike agent by its own id', longRows.length === LONG_AGENTS.length && new Set(longRows.map((row) => row.select.agent)).size === LONG_AGENTS.length, JSON.stringify(longRows))

    // --- A read with no console open starts nothing: it says so, and nothing is captured afterwards either.
    const before = await api('GET', '/v1/console/events?agent=B1&project=alpha')
    check('a read with no console open: nothing captured, and it says so', before.status === 200 && before.body.source.capturing === false && before.body.events.length === 0, JSON.stringify(before.body))
    check('…and starts no capture', (await inv('console:sources')).every((s) => !s.capturing), JSON.stringify(await inv('console:sources')))

    // --- The window watches B1 before it starts: its launch, hooks and status line arrive live, with what Combwork made of each.
    await page.evaluate(() => {
      window.__console = []
      window.combwork.onEvent((e) => {
        if (e.type === 'console-events') window.__console.push(...e.events)
      })
    })
    const snapshot = await inv('console:subscribe', [b1Source.id])
    check('subscribing starts its capture, empty so far', Array.isArray(snapshot[b1Source.id]) && snapshot[b1Source.id].length === 0, JSON.stringify(snapshot))
    const live = () => page.evaluate(() => window.__console)
    const seen = (pred) => lib.until(async () => (await live()).find(pred), HUNG_MS)

    await inv('session:start', alpha, { agentId: b1.id })
    const launched = await seen((e) => e.kind === 'launch')
    check("its launch: the CLI, its version and its known option names, the rest counted", typeof launched?.raw?.otherArgs === 'number' && launched.raw.otherArgs >= 2 && launched.raw.switches?.includes('--session-id') && launched.raw.switches.includes('--allowedTools') && launched?.made?.status !== undefined && !JSON.stringify(launched).includes(PRIVATE), JSON.stringify(launched))
    const started = await seen((e) => e.kind === 'hook' && e.name === 'SessionStart')
    check('SessionStart arrives next to what Combwork made of it', started?.made?.event?.kind === 'start' && typeof started.made.status === 'string' && started.summary.startsWith('SessionStart → start;'), JSON.stringify(started))
    check('…from the provider that sent it', started?.provider === 'claude-code')
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status === 'ready', HUNG_MS)

    const key = lib.ptyKey(alpha, b1.id)
    const sent = await lib.sendPrompt(inv, key, `edit a.ts window 150000 ${PRIVATE}`, { submitted: async () => !!(await live()).find((e) => e.name === 'UserPromptSubmit') })
    check('the prompt is taken', sent > 0)
    const prompt = await seen((e) => e.name === 'UserPromptSubmit')
    check('UserPromptSubmit: Combwork took it for a prompt and set the agent working', prompt?.made?.event?.kind === 'prompt' && prompt.made.status === 'working', JSON.stringify(prompt?.made))
    check('…its text hidden, only its length kept', /^<text: \d+ chars>$/.test(prompt?.raw?.prompt ?? ''), JSON.stringify(prompt?.raw))
    const pre = await seen((e) => e.name === 'PreToolUse')
    check('PreToolUse (Edit): its tool and file kept, its edit hidden', pre?.raw?.tool_name === 'Edit' && (pre.raw.tool_input?.file_path ?? '').endsWith('a.ts') && (pre.raw.tool_input?.old_string ?? '').startsWith('<text'), JSON.stringify(pre?.raw))
    const stop = await seen((e) => e.name === 'Stop')
    check('Stop: Combwork ended the turn', stop?.made?.event?.kind === 'stop' && stop.made.actions?.includes('turnEnded'), JSON.stringify(stop?.made))
    const statusLine = await seen((e) => e.kind === 'statusline')
    check('the status line: next to the context window Combwork read from it', statusLine?.made?.contextWindow === 150000 && /window 150000/.test(statusLine.summary), JSON.stringify(statusLine))
    const all = JSON.stringify(await live())
    check('the prompt\'s words reach no event (raw, made or summary)', !all.includes(PRIVATE))
    const snap = await inv('console:snapshot', b1Source.id, 0)
    check("the window's snapshot is the same events", snap.length >= 4 && snap.every((e) => e.source === b1Source.id), String(snap.length))

    // --- B1 reads its own session over the Agent API (its own token), and no other source.
    const tokenDir = path.join(userData, 'agent-api')
    const b1Token = JSON.parse(fs.readFileSync(path.join(tokenDir, fs.readdirSync(tokenDir).find((f) => f.endsWith('.json'))), 'utf8')).token
    const own = await api('GET', '/v1/console/events', b1Token)
    check('an agent reads its own session: rows, not payloads', own.status === 200 && own.body.events.some((e) => e.name === 'UserPromptSubmit') && own.body.events.every((e) => e.raw === undefined), JSON.stringify(own.body).slice(0, 400))
    const launchFull = await api('GET', `/v1/console/events?seq=${launched.seq}`, b1Token)
    check('…its launch read in full keeps no argument text', launchFull.status === 200 && launchFull.body.events.length === 1 && !JSON.stringify(launchFull.body).includes(PRIVATE) && !JSON.stringify(own.body).includes(PRIVATE), JSON.stringify(launchFull.body).slice(0, 400))
    const full = await api('GET', `/v1/console/events?seq=${prompt.seq}`, b1Token)
    check('…and one in full on request, still redacted', full.status === 200 && full.body.events[0]?.raw?.prompt?.startsWith('<text:') && !JSON.stringify(full.body).includes(PRIVATE), JSON.stringify(full.body).slice(0, 300))
    for (const [what, q] of [
      ['another agent of its project', `agent=B2`],
      ["Combwork's own events", 'source=combwork'],
      ["the Assistant's", 'source=assistant'],
      ['an agent that does not exist', 'agent=Nobody']
    ]) {
      const r = await api('GET', `/v1/console/events?${q}`, b1Token)
      check(`…not ${what}: refused as unknown`, r.status === 404 && r.body?.error === 'Not a developer console source you can read', `${r.status} ${JSON.stringify(r.body)}`)
    }
    const listed = await api('GET', '/v1/console/sources', b1Token)
    check('…and lists only its own session', listed.status === 200 && listed.body.total === 1 && listed.body.sources[0].select?.agent === b1.id && listed.body.sources[0].label === 'alpha · B1' && listed.body.sources[0].capturing === true, JSON.stringify(listed.body))

    // --- Combwork's own events, once the window watches them too: B1's API call shows there and in B1's session.
    const notYet = await api('GET', '/v1/console/events?source=combwork')
    check("Combwork's events aren't captured until the window watches them", notYet.status === 200 && notYet.body.source.capturing === false, JSON.stringify(notYet.body))
    await inv('console:subscribe', [b1Source.id, sources.find((s) => s.kind === 'combwork').id])
    await api('GET', '/v1/status', b1Token)
    const combworkEvents = await lib.until(async () => {
      const r = await api('GET', '/v1/console/events?source=combwork')
      return r.body?.events?.find((e) => e.kind === 'api' && e.name === 'GET /v1/status') ? r.body : null
    }, HUNG_MS)
    check("an agent's API call is in Combwork's events, who made it and how it went", /by agent .* → 200 ok/.test(combworkEvents?.events.find((e) => e.name === 'GET /v1/status')?.summary ?? ''), JSON.stringify(combworkEvents))
    check('…and in its own session', (await inv('console:snapshot', b1Source.id, 0)).some((e) => e.kind === 'api' && e.name === 'GET /v1/status'))
    check("…but the console's own reads aren't", !(await inv('console:snapshot', b1Source.id, 0)).some((e) => e.name.includes('/v1/console')))

    // --- Off in Settings: every read is refused.
    await inv('settings:update', { agentApi: { devConsole: false } })
    const off = await api('GET', '/v1/console/events', b1Token)
    check('with the setting off, reading is refused', off.status === 403 && /Settings → Agent API/.test(off.body?.error ?? ''), JSON.stringify(off))
    await inv('settings:update', { agentApi: { devConsole: true } })

    // --- The console closing ends capture, whatever the agents read: nothing is kept, and reads start nothing.
    await inv('console:subscribe', [])
    const closed = await inv('console:sources')
    check('with the console closed, nothing is captured or kept', closed.every((s) => !s.capturing && s.events === 0), JSON.stringify(closed))
    const afterClose = await api('GET', '/v1/console/events', b1Token)
    check('…an agent reading its own session is told nothing is captured', afterClose.status === 200 && afterClose.body.source.capturing === false && afterClose.body.events.length === 0, JSON.stringify(afterClose.body))
    await lib.sendPrompt(inv, key, 'work 1', { submitted: async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status === 'working' })
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status !== 'working', HUNG_MS)
    await api('GET', '/v1/console/events', b1Token)
    const still = await inv('console:sources')
    check('…and a turn and more reads later, still nothing is', still.every((s) => !s.capturing && s.events === 0), JSON.stringify(still))
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
