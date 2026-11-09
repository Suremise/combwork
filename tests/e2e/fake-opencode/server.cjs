// The fake opencode's private server (`opencode serve`, or a TUI's --standalone one): the routes and event stream of the
// real 2.2.6 as recorded (tests/fixtures/opencode/real-2.2.6: wire/, events/, messages/). Basic auth `opencode:<password>`
// on every route (401 UnauthorizedError otherwise); /api/event an SSE stream (`data: {json}` blocks, `: heartbeat`
// comments) that starts with server.connected and replays nothing after a disconnect; sessions, their messages (newest
// first, `idle` markers at each turn's end), permissions, interrupt, export and import. Its turns are a fake model's: what
// a prompt says it does (see `scripted` below), each a tool call or a reply, with the events the real one sent for it.
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const store = require('./store.cjs')
const config = require('./config.cjs')
const { callOwnTool, parseToolStep, isDoorbell, doorbellIsWork, inboxRows } = require('../fake-bridge.cjs')

const VERSION = '2.2.6'
const SNAPSHOT = 'f9f4a137eafda739c874d9f1ff5de0924cc85bea'
const INSTRUCTIONS_DELTA = { 'core/codemode': '74a1fe4cac15f42fd158773d5d180e363ce6fbfcde6213fc51a7f5d0a79775bc', 'core/skill-guidance': '8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9', 'core/date': 'f5037a79687112a772ccf5ed4b2589caebf713959392bc4d0630977e1a6b4009', 'core/environment': '996bcfb91c5a9c9a37f473eb59aa94c1ffffe5bd30729270f32861e3b164b6fb' }
const SLUGS = ['crisp-star', 'brave-star', 'tidy-pixel', 'glowing-nebula', 'curious-canyon']
const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
/** A session's title request (HI-2762's R0: the first usage.updated, before any step): in the session's tokens, in no message. */
const TITLE_TOKENS = { input: 457, output: 312, reasoning: 0, cache: { read: 0, write: 0 } }
const addTokens = (a, b) => ({ input: a.input + b.input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write } })

/**
 * Starts a server. opts: { env, cwd, hostname, port (0: free), password, log(entry) }. Resolves { url, port, close() }.
 * Every MCP server the config lets start is started now and kept running, as the real one does.
 */
async function startServer(opts) {
  const env = opts.env || process.env
  const log = opts.log || (() => {})
  const cwd = opts.cwd || process.cwd()
  const cfgFor = (dir) => config.load(dir || cwd, env)
  const boot = cfgFor(cwd)
  for (const l of boot.loaded) log({ kind: 'loaded', ...l })
  // Each instructions file's text, as the real one puts it in the model's system prompt (a scenario reads a launch's mode
  // in it, as it reads Copilot's stand-in's log), cut at 256 KB.
  for (const l of boot.loaded) if (l.kind === 'instructions') {
    try { log({ kind: 'instructions-text', path: l.path, text: fs.readFileSync(l.path, 'utf8').slice(0, 262144) }) } catch { /* gone: nothing to show */ }
  }
  const auth = 'Basic ' + Buffer.from(`opencode:${opts.password ?? ''}`).toString('base64')
  const clients = new Set()
  const pending = new Map() // permission id → { request, resolve }
  const turns = new Map() // session id → { abort }
  const queues = new Map()

  // --- MCP servers, started once (stdio, initialize then initialized, as an MCP client does).
  const children = []
  const mcpStatus = {}
  const started = config.startedServers(boot)
  for (const [name, def] of Object.entries(started)) {
    const cmd = Array.isArray(def.command) ? def.command : [def.command, ...(def.args || [])]
    if (!cmd[0]) continue
    try {
      const p = spawn(cmd[0], cmd.slice(1), { env: { ...env, ...(def.environment || def.env) }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      children.push(p)
      p.on('error', () => (mcpStatus[name] = 'failed'))
      p.stdin.on('error', () => undefined)
      p.stdout.on('data', () => (mcpStatus[name] = 'connected'))
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-opencode', version: VERSION } } }) + '\n')
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      mcpStatus[name] = 'pending'
    } catch {
      mcpStatus[name] = 'failed'
    }
  }
  // Each server's token, as a test names it (CW_MCP_TOKEN, R0's CW_PROBE_TOKEN), or Combwork's own server's per-agent token
  // file (CW_API_TOKEN_FILE): whose server it is.
  const tokenOf = (d) => {
    const e = d.environment || d.env || {}
    return e.CW_MCP_TOKEN ?? e.CW_PROBE_TOKEN ?? e.CW_API_TOKEN_FILE ?? null
  }
  log({ kind: 'mcp', started: Object.keys(started), tokens: Object.fromEntries(Object.entries(started).map(([n, d]) => [n, tokenOf(d)])), configured: Object.keys(boot.servers) })

  // --- Events.
  let evCount = 0
  const eventId = () => store.newId('evt')
  /** The types each stream asked for (`?types=`, HI-2760's recording: only those, plus server.connected); none: all. */
  const wanted = new WeakMap()
  function send(e) {
    const block = `data: ${JSON.stringify(e)}\n\n`
    for (const c of clients) {
      const only = wanted.get(c)
      if (!c.writableEnded && (!only || only.has(e.type))) c.write(block)
    }
    evCount++
  }
  /** One event; durable ones carry the session's next seq (kept with the session, so a restart carries on). */
  function emit(type, data, { sid, durable = false, location, metadata, version = 1 } = {}) {
    const e = { id: eventId(), created: Date.now(), ...(metadata ? { metadata } : {}), type, ...(location ? { location } : {}), data }
    if (durable && sid) {
      const seq = store.change((db) => {
        const s = db.sessions[sid]
        s.seq = (s.seq ?? -1) + 1
        return s.seq
      }, env)
      e.durable = { aggregateID: sid, seq, version }
    }
    send(e)
    return e
  }
  const session = (sid) => store.read(env).sessions[sid]
  let logReads = 0
  /** A submission, as the TUI's prompt makes one (an inbox item), its turn queued after the session's others; `done` once it ended. */
  function submit(sid, text) {
    const inboxID = store.newId('msg')
    const now = Date.now()
    pushMessage(sid, { id: inboxID, time: { created: now }, text, type: 'user' })
    emit('session.inbox.enqueued', { inboxID, sessionID: sid, item: { type: 'user', payload: { text }, delivery: 'steer' } }, { sid, durable: true, location: loc(sid) })
    const q = (queues.get(sid) || Promise.resolve()).then(() => runTurn(sid, text, inboxID))
    queues.set(sid, q.catch(() => undefined))
    return { inboxID, now, text, done: q.catch(() => undefined) }
  }
  const loc = (sid) => session(sid)?.info.location

  function createSession(body) {
    const id = body.id ?? store.newId('ses')
    const now = Date.now()
    const dir = body.location?.directory || cwd
    const existing = session(id)
    if (existing) return existing.info
    const info = { id, projectID: store.projectId(dir), ...(body.model ? { model: body.model } : {}), cost: 0, tokens: zeroTokens(), time: { created: now, updated: now }, ...(body.permissions ? { permissions: body.permissions } : {}), location: { directory: dir } }
    store.change((db) => {
      db.sessions[id] = { info, messages: [], seq: -1 }
    }, env)
    emit('session.created', { sessionID: id, slug: SLUGS[Math.floor(Math.random() * SLUGS.length)], version: VERSION, projectID: info.projectID, location: info.location, subpath: '', ...(body.permissions ? { permissions: body.permissions } : {}), ...(body.model ? { model: body.model } : {}) }, { sid: id, durable: true, location: info.location })
    log({ kind: 'session', created: id, dir })
    return info
  }
  const updateInfo = (sid, fn) => store.change((db) => fn(db.sessions[sid].info, db.sessions[sid]), env)
  const pushMessage = (sid, m) => store.change((db) => db.sessions[sid].messages.push(m), env)
  const setMessage = (sid, id, fn) => store.change((db) => fn(db.sessions[sid].messages.find((m) => m.id === id)), env)

  // --- A turn: the fake model's steps for a prompt, each with the events the real one sent (events/*.json).
  function modelOf(sid) {
    const s = session(sid)
    if (s.info.model) return { id: s.info.model.id, providerID: s.info.model.providerID }
    const m = String(cfgFor(s.info.location.directory).model || 'opencode/big-pickle')
    const i = m.indexOf('/')
    return { id: m.slice(i + 1), providerID: m.slice(0, i) }
  }
  const stepTokens = (n) => ({ input: 200 + 100 * n, output: 40, reasoning: 0, cache: { read: n ? 4800 : 0, write: 0 } })

  async function runTurn(sid, text, inboxID) {
    const l = loc(sid)
    const ctl = { aborted: false, reason: null, wake: null }
    turns.set(sid, ctl)
    const d = { sid, durable: true, location: l }
    const model = modelOf(sid)
    const cfg = cfgFor(l.directory)
    log({ kind: 'turn', session: sid, text, model })
    emit('session.execution.started', { sessionID: sid }, { sid, durable: true })
    updateInfo(sid, (info) => {
      info.time.busy = Date.now()
      delete info.outcome
    })
    emit('session.instructions.updated', { sessionID: sid, delta: INSTRUCTIONS_DELTA }, { ...d, metadata: { instructions: { initial: true } }, version: 2 })
    emit('session.inbox.delivered', { sessionID: sid, inboxID }, d)
    const provider = config.allowed(cfg, 'provider.use', model.providerID)
    // A provider that fails at once fails its title call too: no usage or rename (events/failed-provider-400.json).
    const failsAtOnce = !provider || /^fail\b/i.test(text)
    // Its first turn names it: the title's request is counted in the session's tokens, never in a message's (HI-2762's R0).
    const titled = !failsAtOnce && !session(sid).info.title
    const titleTokens = titled ? TITLE_TOKENS : zeroTokens()
    if (!failsAtOnce) emit('session.usage.updated', { sessionID: sid, cost: 0, tokens: addTokens(session(sid).info.tokens, titleTokens) })
    if (titled) {
      const title = text.slice(0, 40)
      updateInfo(sid, (info) => (info.title = title))
      emit('session.renamed', { sessionID: sid, title }, d)
    }
    // The stream lost mid-turn (HI-2758 Q5): what happens meanwhile reaches no one, and is never replayed.
    // A test's over-long frame (never 2.2.6's): one event of the session's whose data line is 300 KB.
    if (/\blong frame\b/i.test(text)) emit('session.step.started', { sessionID: sid, assistantMessageID: store.newId('msg'), padding: 'x'.repeat(300 * 1024) }, d)
    if (/\bdrop events\b/i.test(text))
      for (const c of [...clients]) {
        clients.delete(c)
        c.end()
      }
    let n = 0
    let total = titleTokens

    const step = async (body) => {
      const msgId = store.newId('msg')
      const now = Date.now()
      pushMessage(sid, { id: msgId, time: { created: now }, type: 'assistant', agent: 'build', model, content: [], snapshot: { start: SNAPSHOT, end: SNAPSHOT, files: [] } })
      emit('session.step.started', { sessionID: sid, agent: 'build', model, assistantMessageID: msgId, snapshot: SNAPSHOT, started: now }, d)
      if (MODEL_MS) await waitOrAbort(ctl, MODEL_MS)
      const r = await body(msgId)
      return r
    }
    const endStep = (msgId, finish, rawFinish) => {
      const tokens = stepTokens(n++)
      total = addTokens(total, tokens)
      setMessage(sid, msgId, (m) => Object.assign(m, { time: { ...m.time, streamed: Date.now(), completed: Date.now() }, finish, rawFinish, cost: 0, tokens }))
      emit('session.step.ended', { sessionID: sid, assistantMessageID: msgId, finish, rawFinish, tokens, cost: 0, snapshot: SNAPSHOT, files: [] }, d)
      emit('session.usage.updated', { sessionID: sid, cost: 0, tokens: total })
    }
    const failStep = (msgId, error, extra = {}) => {
      setMessage(sid, msgId, (m) => Object.assign(m, { time: { ...m.time, completed: Date.now() }, finish: 'error', error }))
      emit('session.step.failed', { sessionID: sid, assistantMessageID: msgId, error, ...extra, snapshot: SNAPSHOT, files: [] }, d)
    }
    /** One tool call in its own step: input, call, [permission], run, result; false when the turn ended there. */
    const toolStep = (name, input, run, permission) =>
      step(async (msgId) => {
        const callId = 'call_' + Math.random().toString(36).slice(2, 10)
        emit('session.tool.input.started', { sessionID: sid, assistantMessageID: msgId, id: callId, name }, d)
        emit('session.tool.input.ended', { sessionID: sid, assistantMessageID: msgId, id: callId, text: JSON.stringify(input) }, d)
        emit('session.tool.called', { sessionID: sid, assistantMessageID: msgId, id: callId, input, executed: false }, d)
        emit('session.step.streamed', { sessionID: sid, assistantMessageID: msgId }, d)
        const created = Date.now()
        const part = (state) => setMessage(sid, msgId, (m) => (m.content = [{ type: 'tool', id: callId, name, executed: false, state, time: { created, ran: Date.now(), completed: Date.now() } }]))
        if (permission) {
          const reply = await ask(sid, l, { action: permission.action, resources: permission.resources, save: permission.save, source: { type: 'tool', messageID: msgId, id: callId } }, ctl)
          if (reply !== 'once' && reply !== 'always') {
            const error = reply === 'reject' ? { type: 'aborted', message: 'The user declined this tool call' } : { type: 'aborted', message: 'Step interrupted' }
            part({ status: 'error', input, error })
            emit('session.tool.failed', { sessionID: sid, assistantMessageID: msgId, id: callId, error, executed: false }, { ...d, version: 2 })
            const tokens = stepTokens(n++)
            total = addTokens(total, tokens)
            failStep(msgId, { type: 'aborted', message: 'Step interrupted' }, { rawFinish: 'tool_calls', tokens, cost: 0 })
            emit('session.usage.updated', { sessionID: sid, cost: 0, tokens: total })
            ctl.aborted = true
            ctl.reason = reply === 'reject' ? 'shutdown' : 'user'
            return false
          }
        }
        if (ctl.aborted) return false
        const r = await run(callId, msgId)
        if (r.isError) {
          const error = { type: 'tool', message: r.text }
          part({ status: 'error', input, error })
          emit('session.tool.failed', { sessionID: sid, assistantMessageID: msgId, id: callId, error, executed: false }, { ...d, version: 2 })
        } else {
          part({ status: 'completed', input, content: [{ type: 'text', text: r.text }], metadata: r.metadata })
          emit('session.tool.success', { sessionID: sid, assistantMessageID: msgId, id: callId, content: [{ type: 'text', text: r.text }], metadata: r.metadata, executed: false }, d)
        }
        endStep(msgId, 'tool-calls', 'tool_calls')
        return true
      })

    // The tools a fake model calls.
    const shellRule = (command) => {
      if (/\bneeds approval\b/i.test(text)) return 'ask'
      const rules = [...(cfg.global.permissions || []), ...(session(sid).info.permissions || [])]
      let effect = 'allow'
      for (const p of rules) if (p.action === 'shell' && new RegExp('^' + String(p.resource ?? '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(command)) effect = p.effect
      return effect
    }
    const shell = (command) => {
      const rule = shellRule(command)
      if (rule === 'deny') return toolStep('shell', { command }, async () => ({ text: `Permission denied: shell ${command}`, isError: true }))
      return toolStep('shell', { command }, (callId, msgId) => shellRun(sid, l, command, callId, msgId), rule === 'ask' ? { action: 'shell', resources: [command], save: [command.split(' ')[0] + ' *'] } : null)
    }
    const serverDef = (name) => {
      const def = config.startedServers(cfg)[name]
      if (!def) return null
      const cmd = Array.isArray(def.command) ? def.command : [def.command, ...(def.args || [])]
      return { command: cmd[0], args: cmd.slice(1), env: def.environment || def.env || {} }
    }
    /** An MCP tool, as 2.2.6 calls one: through Code Mode's `execute` (events/mcp-through-execute.json). */
    let lastCall = null
    const mcp = async (server, tool, args) => {
      const code = `return await tools.${server}.${tool}(${JSON.stringify(args)})`
      lastCall = { text: `error: no MCP server ${server}`, isError: true }
      await toolStep('execute', { code }, async (callId, msgId) => {
        const calls = [{ tool: `${server}.${tool}`, status: 'running', input: args }]
        emit('session.tool.progress', { sessionID: sid, assistantMessageID: msgId, id: callId, metadata: { toolCalls: calls } }, { location: l })
        const def = serverDef(server)
        if (def) lastCall = await callOwnTool(def, tool, args)
        log({ kind: 'mcp-call', server, tool, args, isError: !!lastCall.isError })
        return { ...lastCall, metadata: { toolCalls: [{ ...calls[0], status: lastCall.isError ? 'error' : 'completed' }], truncated: false } }
      })
      return lastCall
    }
    const read = (file) => toolStep('read', { filePath: file }, async () => (fs.existsSync(file) ? { text: fs.readFileSync(file, 'utf8'), metadata: { truncated: false } } : { text: `File not found: ${file}`, isError: true }))
    /**
     * 2.2.6's external_directory, for an edit outside the session's folder (HI-2772, from the pinned opencode.exe:
     * FileAccess.resolve and authorizeExternal): its resource the file's folder, slashed, and /*; the last rule of the
     * config's `permissions` then the session's that matches decides (Kw: slashes either way, any case), else it asks.
     * Only the edit checks it here: what else 2.2.6 checks it for, the fake doesn't model.
     */
    const external = (file) => {
      const rel = path.relative(l.directory, file)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return null
      const resource = `${path.dirname(file).replace(/\\/g, '/')}/*`
      const kw = (value, pattern) => new RegExp('^' + String(pattern).replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'si').test(value.replace(/\\/g, '/'))
      const rules = [...(cfg.global.permissions || []), ...(session(sid).info.permissions || [])]
      const effect = rules.findLast((p) => kw('external_directory', p.action) && kw(resource, p.resource ?? '*'))?.effect ?? 'ask'
      return { effect, resource }
    }
    const edit = (file) => {
      const ext = external(file)
      if (ext) log({ kind: 'external-directory', file, ...ext })
      if (ext?.effect === 'deny') return toolStep('edit', { filePath: file, oldString: '', newString: 'edited' }, async () => ({ text: `Permission denied: external_directory ${ext.resource}`, isError: true }))
      return toolStep('edit', { filePath: file, oldString: '', newString: 'edited' }, async () => {
        fs.appendFileSync(file, `edited by ${env.CW_AGENT || 'agent'}\n`)
        log({ kind: 'edit', agent: env.CW_AGENT || 'agent', file: path.basename(file), allowed: true })
        return { text: 'Edit applied successfully.', metadata: { truncated: false } }
      }, ext?.effect === 'ask' ? { action: 'external_directory', resources: [ext.resource], save: [ext.resource] } : null)
    }
    // A skill as 2.2.6 offers one: only those it loaded (config.cjs: the config folder's skills, and the project's or the
    // home's as the switches let them), by its folder's name, its id (skills/config-dir.json, HI-2761's R0b).
    const loadedSkills = () => cfg.loaded.filter((x) => x.kind === 'skill').map((x) => x.path)
    const skillDir = (name) => loadedSkills().find((x) => path.basename(x) === name && fs.existsSync(path.join(x, 'SKILL.md'))) ?? path.join(cfg.cfgDir, 'skills', name)
    /**
     * The `skill` tool `{id}` 2.2.6 loads a skill with: its SKILL.md for one it offers, else an error. (R0b recorded the
     * tool and the listing, not a call's result: the fake answers with the file's text.)
     */
    const skillTool = (name) =>
      toolStep('skill', { id: name }, async () => {
        const dir = loadedSkills().find((x) => path.basename(x) === name && fs.existsSync(path.join(x, 'SKILL.md')))
        log({ kind: 'skill-tool', id: name, found: !!dir })
        return dir ? { text: fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), metadata: { truncated: false } } : { text: `Skill not found: ${name}`, isError: true }
      })
    const skillRef = (name, file) => {
      const dir = skillDir(name)
      const t = fs.existsSync(path.join(dir, 'SKILL.md')) ? fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') : ''
      return t.includes(`](${file})`) || t.includes(`](./${file})`) ? path.resolve(dir, file) : path.join(dir, `no-link-to-${file}`)
    }
    const own = (tool, args) => mcp('combwork', tool, args)

    // The scenarios' steps (tests/scenarios), as the other fakes take them.
    async function scripted(s) {
      for (const m of s.matchAll(/\bskill\s+([a-z0-9][\w-]*)/gi)) await skillTool(m[1])
      for (const m of s.matchAll(/\bskillref\s+([a-z0-9][\w-]*)\s+([\w.-]+\.md)/gi)) await read(skillRef(m[1], m[2]))
      const move = /\bboardmove\s+(\d+)\s+(\w+)/i.exec(s)
      if (move) await own('cw_update_task', { number: Number(move[1]), column: move[2].toLowerCase() })
      const rev = /\bboardreview\s+(\d+)\s+(\w+)(?:\s+(hold|todo|doing|review|passed|done)\b)?/i.exec(s)
      if (rev) await own('cw_update_task', { number: Number(rev[1]), review: rev[2].toLowerCase(), ...(rev[3] ? { column: rev[3].toLowerCase(), comment: 'Fake review: passed.' } : {}) })
      const comment = /\bboardcomment\s+(\d+)/i.exec(s)
      if (comment) await own('cw_update_task', { number: Number(comment[1]), comment: 'Fake: done, see the files.' })
      const c = parseToolStep(s)
      if (c) await own(c.tool, c.args)
      const pause = /\bwork\s+(\d+)/i.exec(s)
      if (pause) await step(async (msgId) => {
        await waitOrAbort(ctl, Number(pause[1]) * 1000)
        if (!ctl.aborted) endStep(msgId, 'stop', 'stop')
      })
      const sh = /\bshell:\s*(.+)$/i.exec(s)
      if (sh) await shell(sh[1].trim())
      // A file in the session's folder, or "a path" anywhere (an absolute one outside: external_directory, HI-2772).
      const patch = /\bpatch\s+(?:"([^"]+)"|([\w.-]+))/i.exec(s)
      if (patch) await edit(path.resolve(l.directory, patch[1] ?? patch[2]))
    }

    let failure = null
    try {
      // A policy-denied provider fails the turn, not the session's creation or model change (HB1's 2.2.6 run, HI-2759).
      if (!provider) failure = { type: 'provider.no-route', message: `Model unavailable: ${model.providerID}/${model.id}` }
      else if (/^fail\b/i.test(text)) failure = { type: 'provider.invalid-request', message: 'fake provider refused', status: 400 }
      if (!failure) {
        let work = text
        if (isDoorbell(text)) {
          const isWork = doorbellIsWork(text)
          const r = await own('cw_inbox', {})
          const rows = r.isError ? [] : inboxRows(r.text)
          if (rows.length && follows(env)) await own('cw_inbox', { ack: rows.flatMap((x) => x.ids) })
          const readText = rows.map((x) => x.text).join(' ')
          if (!isWork) log({ kind: 'wake', text: readText, doorbell: text })
          work = isWork ? readText : (rows.length && nextScripted(env)) || ''
        }
        for (const s of work.split(' then ')) {
          if (ctl.aborted) break
          await scripted(s)
        }
        if (!ctl.aborted && /^needs approval\b/i.test(work)) await shell('echo hi')
        const toolLine = /^tool (.+)$/.exec(work)
        if (!ctl.aborted && toolLine) await toolStep('execute', { code: 'return "fake"' }, async () => ({ text: toolLine[1], metadata: { truncated: false } }))
      }
      // A model with no route fails before any step: only the user message and the idle marker (HI-2760's recording,
      // wire/message-paging.json); a provider that answers with an error takes a step first (events/failed-provider-400.json).
      if (!ctl.aborted && failure?.type !== 'provider.no-route') {
        await step(async (msgId) => {
          if (failure) return failStep(msgId, failure)
          if (/\bslow\b/i.test(text)) await waitOrAbort(ctl, 60000)
          if (ctl.aborted) {
            // Interrupted mid-step: what it streamed so far, then the step failed (events/interrupted.json).
            emit('session.step.streamed', { sessionID: sid, assistantMessageID: msgId }, d)
            return failStep(msgId, { type: 'aborted', message: 'Step interrupted' })
          }
          const reply = `Done: ${text}`
          emit('session.text.started', { sessionID: sid, assistantMessageID: msgId, ordinal: 0 }, d)
          emit('session.text.delta', { sessionID: sid, assistantMessageID: msgId, ordinal: 0, delta: reply }, { location: l })
          emit('session.text.ended', { sessionID: sid, assistantMessageID: msgId, ordinal: 0, text: reply }, d)
          emit('session.step.streamed', { sessionID: sid, assistantMessageID: msgId }, d)
          setMessage(sid, msgId, (m) => m.content.push({ type: 'text', text: reply }))
          endStep(msgId, 'stop', 'stop')
        })
      }
    } catch (e) {
      failure = { type: 'unknown', message: String(e?.message || e) }
    }
    // The turn's end: execution.succeeded, failed or interrupted (never session.idle), and its idle marker.
    turns.delete(sid)
    const outcome = failure ? 'failed' : ctl.aborted ? 'interrupted' : 'succeeded'
    pushMessage(sid, { id: store.newId('msg'), time: { created: Date.now() }, type: 'idle', outcome, ...(failure ? { error: failure } : {}) })
    updateInfo(sid, (info) => {
      info.outcome = outcome
      info.time.idle = Date.now()
      info.time.updated = Date.now()
      info.tokens = addTokens(info.tokens, total)
    })
    if (outcome === 'failed') emit('session.execution.failed', { sessionID: sid, error: failure }, { sid, durable: true })
    else if (outcome === 'interrupted') emit('session.execution.interrupted', { sessionID: sid, reason: ctl.reason || 'user' }, { sid, durable: true })
    else emit('session.execution.succeeded', { sessionID: sid }, { sid, durable: true })
    log({ kind: 'turn-end', session: sid, outcome })
  }

  /** A permission request: permission.asked, then waits for a reply (or the turn's interrupt). */
  function ask(sid, l, req, ctl) {
    const id = store.newId('per')
    const request = { id, sessionID: sid, ...req }
    emit('permission.asked', request, { location: l })
    log({ kind: 'permission', session: sid, action: req.action, resources: req.resources })
    return new Promise((resolve) => {
      pending.set(id, { request, resolve })
      ctl.wake = () => {
        pending.delete(id)
        resolve(null)
      }
    })
  }
  function waitOrAbort(ctl, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms)
      function done() {
        clearTimeout(t)
        ctl.wake = null
        resolve()
      }
      ctl.wake = done
    })
  }
  /** A shell command (cmd here; 2.2.6 runs PowerShell), its shell.created, progress and shell.exited events. */
  function shellRun(sid, l, command, callId, msgId) {
    const shId = store.newId('sh')
    emit('shell.created', { info: { id: shId, status: 'running', command, cwd: l.directory, metadata: { sessionID: sid }, time: { started: Date.now() } } }, { location: l })
    emit('session.tool.progress', { sessionID: sid, assistantMessageID: msgId, id: callId, metadata: { shellID: shId } }, { location: l })
    return new Promise((resolve) => {
      const p = spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: l.directory, env, windowsVerbatimArguments: true, windowsHide: true })
      let out = ''
      p.stdout.on('data', (x) => (out += x))
      p.stderr.on('data', (x) => (out += x))
      p.on('close', (code) => {
        emit('shell.exited', { id: shId, exit: code, status: 'exited' }, { location: l })
        log({ kind: 'shell', cmd: command, code, out })
        resolve({ text: out, isError: false, metadata: { status: 'completed', truncated: false, exit: code } })
      })
    })
  }

  // --- HTTP.
  const json = (res, status, body) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), vary: 'Origin, Accept-Encoding' })
    res.end(text)
  }
  const notFound = (res, sid) => json(res, 404, { _tag: 'SessionNotFoundError', sessionID: sid, message: `Session not found: ${sid}` })
  const bodyOf = (req) =>
    new Promise((resolve) => {
      let b = ''
      req.on('data', (x) => (b += x))
      req.on('end', () => {
        try {
          resolve(b ? JSON.parse(b) : {})
        } catch {
          resolve(null)
        }
      })
    })
  const listing = (dir, data) => ({ location: { directory: dir || cwd }, data })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    if (req.headers.authorization !== auth) return json(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' })
    log({ kind: 'http', method: req.method, path: p })
    let m
    if (req.method === 'GET' && p === '/api/info') return json(res, 200, { version: VERSION, pid: process.pid, hostname: os.hostname(), urls: [base], paths: { tmp: path.join(path.dirname(store.dbPath(env)), 'opencode', 'tmp') }, capabilities: { persistentPty: true } })
    if (req.method === 'GET' && p === '/api/event') {
      res.writeHead(200, { 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'content-type': 'text/event-stream', vary: 'Origin', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
      res.write(`data: ${JSON.stringify({ id: eventId(), type: 'server.connected', data: {} })}\n\n`)
      res.write(': heartbeat\n\n')
      const types = url.searchParams.getAll('types')
      if (types.length) wanted.set(res, new Set(types))
      clients.add(res)
      const hb = setInterval(() => res.write(': heartbeat\n\n'), 10000)
      req.on('close', () => {
        clearInterval(hb)
        clients.delete(res)
      })
      return
    }
    if (p === '/api/session' && req.method === 'GET') {
      const all = Object.values(store.read(env).sessions).map((s) => s.info).sort((a, b) => b.time.created - a.time.created)
      return json(res, 200, { data: all })
    }
    if (p === '/api/session' && req.method === 'POST') {
      const body = await bodyOf(req)
      if (!body) return json(res, 400, { _tag: 'InvalidRequestError', message: 'Invalid JSON', kind: 'Payload' })
      if (body.id !== undefined && !String(body.id).startsWith('ses')) return json(res, 400, { _tag: 'InvalidRequestError', message: 'Expected a string starting with "ses"\n  at ["id"]', kind: 'Payload' })
      return json(res, 200, { data: createSession(body) })
    }
    if ((m = /^\/api\/session\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const s = session(m[1])
      return s ? json(res, 200, { data: s.info }) : notFound(res, m[1])
    }
    if ((m = /^\/api\/session\/([^/]+)\/model$/.exec(p)) && req.method === 'POST') {
      // 204 even for a policy-denied provider: the denial shows at the next prompt (HB1's 2.2.6 run, HI-2759).
      const body = (await bodyOf(req)) || {}
      if (!session(m[1])) return notFound(res, m[1])
      updateInfo(m[1], (info) => (info.model = { id: body.id ?? body.modelID, providerID: body.providerID }))
      res.writeHead(204)
      return res.end()
    }
    if ((m = /^\/api\/session\/([^/]+)\/message$/.exec(p)) && req.method === 'GET') {
      const s = session(m[1])
      if (!s) return notFound(res, m[1])
      return messagePage(res, s.messages, url.searchParams)
    }
    // The durable log (HI-2760's recording of 2.2.6): only its watermark, the session's last durable seq, as one frame.
    if ((m = /^\/api\/experimental\/session\/([^/]+)\/log$/.exec(p)) && req.method === 'GET') {
      if (!session(m[1])) return notFound(res, m[1])
      // A test's race (FAKE_OPENCODE_RACE_ON_LOG=n, never 2.2.6's): before the n-th watermark is answered, a whole turn
      // runs to its end, as if submitted between a snapshot's last message page and its second watermark.
      logReads++
      if (Number(env.FAKE_OPENCODE_RACE_ON_LOG) === logReads) await submit(m[1], 'raced').done
      const s = session(m[1])
      res.writeHead(200, { 'cache-control': 'no-cache, no-transform', 'content-type': 'text/event-stream' })
      return res.end(`data: ${JSON.stringify({ type: 'log.synced', aggregateID: m[1], seq: Math.max(0, s.seq ?? 0) })}\n\n`)
    }
    if ((m = /^\/api\/session\/([^/]+)\/prompt$/.exec(p)) && req.method === 'POST') {
      const sid = m[1]
      if (!session(sid)) return notFound(res, sid)
      const body = (await bodyOf(req)) || {}
      const { inboxID, now, text } = submit(sid, String(body.text ?? ''))
      return json(res, 200, { data: { id: inboxID, sessionID: sid, time: { created: now }, type: 'user', payload: { text }, delivery: 'steer' } })
    }
    if ((m = /^\/api\/session\/([^/]+)\/interrupt$/.exec(p)) && req.method === 'POST') {
      const ctl = turns.get(m[1])
      if (ctl) {
        ctl.aborted = true
        ctl.reason = 'user'
        ctl.wake?.()
      }
      log({ kind: 'interrupt', session: m[1], running: !!ctl })
      return json(res, 200, { interrupted: !!ctl })
    }
    if ((m = /^\/api\/session\/([^/]+)\/permission$/.exec(p)) && req.method === 'GET') return json(res, 200, { data: [...pending.values()].map((x) => x.request).filter((r) => r.sessionID === m[1]) })
    if ((m = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(p)) && req.method === 'POST') {
      const body = (await bodyOf(req)) || {}
      const it = pending.get(m[2])
      if (!it) return json(res, 404, { _tag: 'PermissionNotFoundError', requestID: m[2], message: `Permission request not found: ${m[2]}` })
      pending.delete(m[2])
      const reply = body.decision ?? body.reply
      emit('permission.replied', { sessionID: m[1], requestID: m[2], reply }, { location: loc(m[1]) })
      log({ kind: 'permission-reply', session: m[1], reply })
      it.resolve(reply)
      res.writeHead(204)
      return res.end()
    }
    if ((m = /^\/api\/experimental\/session\/([^/]+)\/export$/.exec(p)) && req.method === 'GET') {
      const s = session(m[1])
      return s ? json(res, 200, { data: { info: s.info, messages: [...s.messages].reverse() } }) : notFound(res, m[1])
    }
    if (p === '/api/experimental/session/import' && req.method === 'POST') {
      const body = await bodyOf(req)
      if (!body?.info) return json(res, 400, { _tag: 'InvalidRequestError', message: 'Missing key\n  at ["info"]', kind: 'Payload' })
      const r = importSession(body, env)
      return r.conflict ? json(res, 409, { _tag: 'ConflictError', message: `Session already exists: ${body.info.id}`, resource: body.info.id }) : json(res, 200, { data: r.info })
    }
    // OpenCode Go's and Console's limits: none without a Console sign-in, which the fake never has (HI-2762's R0,
    // wire/usage-limits-signed-out.json).
    if (p === '/api/experimental/usage/limits' && req.method === 'GET') return json(res, 200, { location: { directory: url.searchParams.get('location[directory]') || process.cwd() }, data: null })
    if (p === '/api/mcp' && req.method === 'GET') return json(res, 200, listing(null, Object.entries(mcpStatus).map(([name, status]) => ({ name, status }))))
    if (p === '/api/model' && req.method === 'GET') return json(res, 200, listing(null, modelsOf(boot, env).map((x) => ({ id: x.id, modelID: x.id, providerID: x.providerID, name: x.name }))))
    if (p === '/api/integration' && req.method === 'GET') return json(res, 200, listing(null, integrations(boot, env)))
    if ((m = /^\/api\/integration\/([^/]+)\/connect\/key$/.exec(p)) && req.method === 'POST') {
      const body = (await bodyOf(req)) || {}
      if (!boot.providers[m[1]]) return json(res, 404, { _tag: 'IntegrationNotFoundError', integrationID: m[1], message: `Integration not found: ${m[1]}` })
      store.change((db) => {
        db.credentials = (db.credentials || []).map((c) => (c.integration === m[1] ? { ...c, active: false } : c))
        db.credentials.push({ id: store.newId('cred'), integration: m[1], label: body.label ?? 'default', type: 'key', key: String(body.key ?? ''), active: true })
      }, env)
      log({ kind: 'credential', integration: m[1] })
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(404, { 'content-length': 0 })
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port || 0, opts.hostname || '127.0.0.1', resolve)
  })
  const port = server.address().port
  const base = `http://${opts.hostname || '127.0.0.1'}:${port}`
  log({ kind: 'listening', url: base })
  return {
    url: base,
    port,
    eventsSent: () => evCount,
    close: () => {
      for (const c of clients) c.end()
      for (const ch of children) ch.kill()
      server.closeAllConnections?.()
      return new Promise((r) => server.close(r))
    }
  }
}

// A model call's time (FAKE_OPENCODE_MODEL_MS; the scenarios', so a turn is seen under way as a real one is; else none).
/**
 * A session's messages as GET /api/session/<id>/message pages them (HI-2760's recording of 2.2.6,
 * tests/fixtures/opencode/real-2.2.6/wire/message-paging.json): `limit` at most 200 (else a 400), `order` desc (the
 * default, newest first) or asc, and `cursor`, an opaque token (base64 JSON {id, order, direction}): `next` continues past
 * the page's last message in its order, `previous` goes back before its first. Every page has both cursors.
 */
function messagePage(res, messages, q) {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const limitText = q.get('limit')
  const limit = limitText === null ? 100 : Number(limitText)
  if (!Number.isInteger(limit) || limit < 1) return json(400, { _tag: 'InvalidRequestError', message: 'Expected a positive integer\n  at ["limit"]', kind: 'Query' })
  if (limit > 200) return json(400, { _tag: 'InvalidRequestError', message: 'Expected a value less than or equal to 200\n  at ["limit"]', kind: 'Query' })
  let order = q.get('order') === 'asc' ? 'asc' : 'desc'
  let page
  const token = q.get('cursor')
  const ordered = () => (order === 'desc' ? [...messages].reverse() : [...messages])
  if (token) {
    let c
    try {
      c = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    } catch {
      return json(400, { _tag: 'InvalidRequestError', message: 'Invalid cursor', kind: 'Query' })
    }
    order = c.order === 'asc' ? 'asc' : 'desc'
    const all = ordered()
    const at = all.findIndex((m) => m.id === c.id)
    if (at < 0) return json(400, { _tag: 'InvalidRequestError', message: 'Invalid cursor', kind: 'Query' })
    page = c.direction === 'previous' ? all.slice(Math.max(0, at - limit), at) : all.slice(at + 1, at + 1 + limit)
  } else page = ordered().slice(0, limit)
  const cursor = (id, direction) => Buffer.from(JSON.stringify({ id, order, direction })).toString('base64')
  return json(200, { data: page, cursor: page.length ? { previous: cursor(page[0].id, 'previous'), next: cursor(page[page.length - 1].id, 'next') } : { previous: null, next: null } })
}

const MODEL_MS = Number(process.env.FAKE_OPENCODE_MODEL_MS ?? 0)
const follows = (env) => env.FAKE_OPENCODE_FOLLOW_NOTICES === '1'
/** What it does after a wake it read: the next line of fake-wakes-<agent>.txt in FAKE_OPENCODE_WAKES (taken), or null. */
function nextScripted(env) {
  if (!env.FAKE_OPENCODE_WAKES) return null
  const file = path.join(env.FAKE_OPENCODE_WAKES, `fake-wakes-${String(env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')}.txt`)
  if (!fs.existsSync(file)) return null
  const [first, ...rest] = fs.readFileSync(file, 'utf8').split('\n')
  fs.writeFileSync(file, rest.join('\n'))
  return first.trim() || null
}

// The built-in `opencode` provider's free models 2.2.6 listed with no account (cli/models-with-ollama-and-builtins.txt).
const BUILTIN = ['beam-free', 'big-pickle', 'crouton-alpha-free', 'deepseek-v4.1-flash-free', 'flint-40b-free', 'glm-5.3-flash-free', 'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free', 'nemotron-3.5-super-vl-free', 'pulse-alpha-free']
/** The models a config offers: its providers' models, the built-in ones and FAKE_OPENCODE_MODELS, each provider.use allows. */
function modelsOf(cfg, env = process.env) {
  const out = []
  for (const [pid, p] of Object.entries(cfg.providers || {})) for (const [mid, m] of Object.entries(p.models || {})) out.push({ providerID: pid, id: mid, name: m.name || mid })
  for (const id of BUILTIN) out.push({ providerID: 'opencode', id, name: id })
  for (const full of String(env.FAKE_OPENCODE_MODELS || '').split(',').filter(Boolean)) {
    const i = full.indexOf('/')
    out.push({ providerID: full.slice(0, i), id: full.slice(i + 1), name: full.slice(i + 1) })
  }
  return out.filter((x) => config.allowed(cfg, 'provider.use', x.providerID)).sort((a, b) => `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`))
}
/** The integrations, as 2.2.6 lists a configured one (r4: a key method, an env method, its connections). */
function integrations(cfg, env = process.env) {
  const creds = store.read(env).credentials || []
  return Object.entries(cfg.providers || {}).map(([id, p]) => {
    const envName = `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    const connections = [...creds.filter((c) => c.integration === id).map((c) => ({ type: 'credential', id: c.id, label: c.label, method: 'key' })), ...(env[envName] ? [{ type: 'env', name: envName }] : [])]
    return { id, name: p.name || id, methods: [{ type: 'key', label: 'Manually enter API Key' }, { type: 'env', names: [envName] }], connections }
  })
}
/** Imports an export's data ({ info, messages: newest first }); a session that exists already is a conflict. */
function importSession(body, env = process.env) {
  return store.change((db) => {
    if (db.sessions[body.info.id]) return { conflict: true }
    db.sessions[body.info.id] = { info: body.info, messages: [...(body.messages || [])].reverse(), seq: -1 }
    return { info: body.info }
  }, env)
}

module.exports = { startServer, modelsOf, integrations, importSession, VERSION }
