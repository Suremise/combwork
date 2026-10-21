// Codex pre-approves only Hive's own MCP tools (#1166), in the test CODEX_HOME. A workspace MCP server (stamp, Node
// built-ins, no annotations) is on in the project; an agent in each of Hive's Codex modes is asked to call a hive tool
// and then stamp's tool. Hive's tool runs without Codex asking in every mode; stamp's follows Codex's approval policy
// for the mode, recorded per mode in mcpapproval.json (asked, ran without asking, or neither). Then the Assistant on
// Codex uses its Hive tools, a read and a change (a card), without being asked. Short prompts on a small model.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxmcp-profile')
const ws = path.join(scratch, 'cxmcp-ws')
const proj = path.join(ws, 'demo')
const stampLog = path.join(ws, '.hive', 'mcp', 'stamp', 'calls.log')
const small = { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }
const MODES = ['read-only', 'ask', 'approve-for-me', 'full-access']
const TURN_MS = 180000
// The terminal catching up with what a hook or the stamp log said already: a bound for a hung run.
const SHOWN_MS = 30000
// Codex 0.163 calls MCP tools from one script (Hive's transcript: "Script"), whose result waits for every call in it:
// its screen says each call done, with its reply ("Called", redrawn over "Calling" as its last letters).
const LISTED = /ed hive\.hive_list_projects\s*└\s*demo \(on/
// Its reply names the card by its key with the number the tools take (#1219): "DE-1 (#1) created in Todo".
const CREATED = /ed hive\.hive_create_task\s*└\s*([A-Z]{2,4}-\d+) \(#(\d+)\) created in Todo/
const record = {}
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

// A third-party MCP server: one tool, stamp, that appends its text to calls.log. No annotations, so nothing tells
// Codex it is read-only.
const STAMP_SERVER = `const fs = require('fs')
const path = require('path')
const log = path.join(__dirname, 'calls.log')
let buf = ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stamp', version: '1.0.0' } } })
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'stamp', description: 'Stamps a text into the log.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
    else if (m.method === 'tools/call') {
      fs.appendFileSync(log, String(m.params.arguments && m.params.arguments.text) + '\\n')
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'stamped' }] } })
    } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } })
  }
})
`

function prepare() {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj)
  fs.mkdirSync(path.dirname(stampLog), { recursive: true })
  fs.writeFileSync(path.join(path.dirname(stampLog), 'server.js'), STAMP_SERVER)
  fs.writeFileSync(path.join(ws, '.hive', 'mcp', 'stamp.json'), JSON.stringify({ command: process.execPath, args: ['${HIVE_MCP_DIR}/stamp/server.js'] }))
  fs.writeFileSync(path.join(ws, '.hive', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['stamp'] } }))
  lib.trustForCodex(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  // Full access is offered only with Codex's dangerous mode on.
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex = { ...cfg.settings.providers.codex, enableDangerousMode: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
}

const stamped = (text) => (fs.existsSync(stampLog) ? fs.readFileSync(stampLog, 'utf8').split('\n').includes(text) : false)

;(async () => {
  prepare()
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47897), CODEX_HOME: lib.CODEX_HOME, PATH: lib.pathWithoutStoreAliases() })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('demo', { exact: true }).first().click()
    const live = async (p, id) => (await inv('session:live')).find((l) => l.projectPath.toLowerCase() === p.toLowerCase() && l.agentId === id)
    const screen = async (key) => lib.plainText(await inv('pty:buffer', key).catch(() => ''))

    for (const mode of MODES) {
      const def = await lib.addAgent(inv, proj, { name: `Codex ${mode}`, ...small, permissionMode: mode })
      const key = lib.ptyKey(proj, def.id)
      const out = (record[mode] = {})
      await lib.cliStep(`${mode}: hive and stamp`, { session: key }, async () => {
        await inv('session:start', proj, { agentId: def.id })
        const ready = await lib.until(async () => ['ready', 'waiting'].includes((await live(proj, def.id))?.status) && (await live(proj, def.id)), 90000, 500)
        check(`${mode}: ready`, ready?.status === 'ready', JSON.stringify(ready && { status: ready.status, msg: ready.statusMessage }))
        if (ready?.status !== 'ready') return
        check(`${mode}: runs in that mode`, ready.permissionMode === mode, ready.permissionMode)
        const prompt = `Call the hive_list_projects tool. Then call the stamp tool of the stamp MCP server with text "${mode}". Make no other tool calls, then reply DONE.`
        // What happens to stamp's call: Codex asks (the session waits for the user), it runs, or the turn ends without.
        // A prompt Codex takes while its MCP servers start can be answered without them ("that tool isn't available"):
        // then it is asked once more.
        let end = null
        for (let attempt = 1; attempt <= 2 && (!end || end === 'turn ended'); attempt++) {
          const sent = await lib.sendPrompt(inv, key, prompt, { submitted: async () => ['working', 'waiting'].includes((await live(proj, def.id))?.status) })
          check(`${mode}: prompt taken (attempt ${attempt})`, sent > 0)
          end = await lib.until(async () => {
            const l = await live(proj, def.id)
            if (l?.status === 'waiting') return 'asked'
            if (stamped(mode)) return 'ran'
            return l?.status === 'finished' || l?.status === 'ready' ? 'turn ended' : null
          }, TURN_MS, 1000)
          if (end === 'turn ended') console.log(`INFO ${mode}: attempt ${attempt} ended without stamp's call: ${JSON.stringify((await screen(key)).slice(-300))}`)
        }
        // Hive's reply on screen, which can come after the hook or the log write that ended the wait above; Codex asking
        // about a Hive tool instead ends it too, and fails below.
        const hive = await lib.until(async () => {
          const w = await live(proj, def.id)
          if (w?.status === 'waiting' && /hive/.test(w.statusMessage ?? '')) return 'asked'
          return LISTED.test(await screen(key)) ? 'shown' : null
        }, SHOWN_MS, 500)
        const l = await live(proj, def.id)
        out.stampCall = end ?? 'no outcome'
        out.stampRan = stamped(mode)
        out.hiveCall = hive === 'shown' ? 'called, with its reply' : hive === 'asked' ? `Codex asked: ${l?.statusMessage}` : null
        out.waitingMessage = l?.status === 'waiting' ? (l.statusMessage ?? '') : null
        // Codex's automatic reviewer looked at the call (Approve for me).
        out.reviewed = /Reviewing approval request/.test(await screen(key))
        out.screenEnd = (await screen(key)).slice(-1500)
        fs.writeFileSync(path.join(scratch, `mcpapproval-${mode}.txt`), (await screen(key)).slice(-6000))
        await page.screenshot({ path: path.join(scratch, `mcpapproval-${mode}.png`) })
        check(`${mode}: Hive's tool ran without Codex asking`, hive === 'shown', out.hiveCall ?? out.screenEnd.slice(-400))
        check(`${mode}: stamp's call came to an outcome`, !!end, out.screenEnd.slice(-400))
        if (end === 'asked') {
          check(`${mode}: Codex asks about stamp's tool, not Hive's`, /mcp__stamp__stamp/.test(out.waitingMessage) && !/hive/.test(out.waitingMessage), out.waitingMessage)
          check(`${mode}: stamp didn't run while Codex asked`, !out.stampRan)
        }
      })
      await inv('session:stop', proj, def.id)
      await lib.until(async () => !(await live(proj, def.id)), 30000, 500)
      console.log(`INFO ${mode}: stamp ${record[mode].stampCall}; hive ${JSON.stringify(record[mode].hiveCall)}`)
    }
    // Asked in the modes where Codex asks before an MCP tool runs: read-only and Ask (on-request).
    for (const mode of ['read-only', 'ask']) check(`${mode}: Codex asks before stamp's tool runs`, record[mode].stampCall === 'asked', record[mode].stampCall)
    // Approve for me: Codex's reviewer decides (it approved this harmless call in the #1166 trials). Full access: no asking.
    check("approve-for-me: Codex's reviewer decides", ['ran', 'asked'].includes(record['approve-for-me'].stampCall), record['approve-for-me'].stampCall)
    check('full-access: stamp runs without asking', record['full-access'].stampCall === 'ran', record['full-access'].stampCall)

    // The Assistant on Codex: its Hive tools, a read and a change within Control, without being asked.
    const home = (await inv('workspace:refresh')).assistant.path
    lib.trustForCodex(home)
    await inv('agents:update', home, 'assistant', small)
    const akey = lib.ptyKey(home, 'assistant')
    await lib.cliStep('the Assistant on Codex', { session: akey }, async () => {
      await inv('session:start', home, { agentId: 'assistant' })
      const ready = await lib.until(async () => ['ready', 'waiting'].includes((await live(home, 'assistant'))?.status) && (await live(home, 'assistant')), 90000, 500)
      check('Assistant: ready', ready?.status === 'ready', JSON.stringify(ready && { status: ready.status, msg: ready.statusMessage }))
      if (ready?.status !== 'ready') return
      const prompt = 'Call hive_list_projects, then add a card titled "MCP approval check" to project demo with hive_create_task. Make no other tool calls, then reply DONE.'
      check('Assistant: prompt taken', (await lib.sendPrompt(inv, akey, prompt, { submitted: async () => ['working', 'waiting', 'finished'].includes((await live(home, 'assistant'))?.status) })) > 0)
      let asked = false
      const done = await lib.until(async () => {
        const l = await live(home, 'assistant')
        if (l?.status === 'waiting') asked = true
        if (asked) return true
        // The turn over and both replies on screen (the terminal can follow the Stop hook).
        const shown = await screen(akey)
        return (l?.status === 'finished' || l?.status === 'ready') && LISTED.test(shown) && CREATED.test(shown)
      }, TURN_MS, 1000)
      const l = await live(home, 'assistant')
      const shown = await screen(akey)
      record.assistant = { asked, screenEnd: shown.slice(-1500) }
      fs.writeFileSync(path.join(scratch, 'mcpapproval-assistant.txt'), (await screen(akey)).slice(-6000))
      await page.screenshot({ path: path.join(scratch, 'mcpapproval-assistant.png') })
      check('Assistant: its turn ended', !!done, record.assistant.screenEnd.slice(-400))
      check('Assistant: never asked about a Hive tool', !asked, l?.statusMessage ?? '')
      check('Assistant: hive_list_projects ran', LISTED.test(shown), record.assistant.screenEnd.slice(-400))
      check('Assistant: hive_create_task ran', CREATED.test(shown), record.assistant.screenEnd.slice(-400))
      const card = (await inv('tasks:list')).find((t) => t.title === 'MCP approval check')
      record.assistant.cardMade = card ? { number: card.number, project: card.project } : null
      check('Assistant: the card is on the board, in demo', card?.project === 'demo', JSON.stringify(record.assistant.cardMade))
      const [, key, no] = CREATED.exec(shown) ?? []
      check('Assistant: the reply named that card, by its key and number', !!card && key === card.key && Number(no) === card.number, JSON.stringify({ key, no, card: card && { key: card.key, number: card.number } }))
    })
    await inv('session:stop', home, 'assistant')
    await lib.until(async () => !(await live(home, 'assistant')), 30000, 500)
  } finally {
    fs.writeFileSync(path.join(scratch, 'mcpapproval.json'), JSON.stringify(record, null, 2))
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
