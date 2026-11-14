// A stand-in for Meta's Muse Code 1.4.20 (HI-3202), as its offline probes saw it (the HI-3202 design: hooks given with
// `-c hooks=<json>`, Combwork's MCP server with `-c mcpServers.<name>=<json>`, both only in a trusted workspace for MCP;
// sessions in <XDG_DATA_HOME>/muse/sessions/YYYY/MM/DD/<id>/session.jsonl). No network, sign-in or model.
// - `muse --version`; `muse [resume <id>] [--model M] [--reasoning-effort E] [--approval-mode X] [--trust-workspace]
//   [--disable-sandbox] [-c KEY=JSON]... [-- PROMPT]`; an unknown -c key or field refuses the run (exit 2), as Muse does,
//   and so does a prompt after `resume <id>` (1.4.20: "unknown argument `resume`"). `muse sandbox windows check` (its
//   status: setup_required while FAKE_MUSE_SANDBOX_FILE exists, else ready) and `muse login` (marks the account signed in:
//   <XDG_CONFIG_HOME>/muse/auth.json).
// - Hooks run as `%COMSPEC% /C <command>` with Node's own argument escaping (a `"` reaches cmd as `\"`, as Rust's does in
//   1.4.20: a quoted path breaks), Muse's hook environment (Windows' own variables and its ids only) and the event's JSON
//   on stdin; SessionStart's plain stdout becomes a developer context block, whole when it is at most 16384 bytes, else
//   none (1.4.20 fails such a hook); a PreToolUse exit 2 or {"decision":"block"} blocks the tool.
// - In its pane: a composer `› `; each line a turn: `edit <path>` (a write, through PreToolUse), `call <tool> [json]` (an
//   MCP tool), `ask` (a Notification, then a y/n line), else `echo: <line>`; `/exit` ends it.
// - FAKE_MUSE_SANDBOX_FILE (existing, without --disable-sandbox): Muse's Windows sandbox screen first, never passed by itself.
// Every launch, hook, MCP server, tool call and file write or block goes to FAKE_MUSE_LOG (JSON lines).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const argv = process.argv.slice(2)
const log = (e) => process.env.FAKE_MUSE_LOG && fs.appendFileSync(process.env.FAKE_MUSE_LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...e })}\n`)
const out = (s) => process.stdout.write(s)
const fail = (code, message) => {
  process.stderr.write(`muse: ${message}\n`)
  log({ kind: 'refused', message })
  process.exit(code)
}

if (argv[0] === '--version' || argv[0] === '-V') {
  out('Muse Code 1.4.20 (1.4.20-R8619.1)\n')
  process.exit(0)
}
const accountEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null, XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? null, META_API_KEY: !!process.env.META_API_KEY, MUSE_CUSTOM_HEADERS: !!process.env.MUSE_CUSTOM_HEADERS }
if (argv[0] === 'sandbox' && argv[1] === 'windows' && argv[2] === 'check') {
  const setup = !!process.env.FAKE_MUSE_SANDBOX_FILE && fs.existsSync(process.env.FAKE_MUSE_SANDBOX_FILE)
  log({ kind: 'sandboxCheck', env: accountEnv, setup })
  out(setup ? 'backend=windows_elevated\nstatus=setup_required\nreason=sandbox users are not ready\n' : 'backend=windows_elevated\nstatus=ready\n')
  process.exit(setup ? 1 : 0)
}
if (argv[0] === 'login') {
  // Signs the account in as `muse login` would once the user approves its code (here at once): auth.json in its config root.
  log({ kind: 'login', env: accountEnv })
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.USERPROFILE || '.', '.config'), 'muse')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"meta":{"kind":"fake"}}\n')
  out('Logged in. Credential saved to auth.json\n')
  process.exit(0)
}

// ---- Arguments.
const opts = { resume: null, model: null, effort: null, approval: 'on-request', trust: false, noSandbox: false, hooks: {}, servers: {}, foreignSkills: true, foreignRules: true, prompt: null }
let i = 0
if (argv[0] === 'resume') {
  opts.resume = argv[1] ?? null
  i = 2
}
const SERVER_FIELDS = new Set(['command', 'args', 'env', 'mode', 'enabled', 'url', 'headers', 'framing', 'transport'])
for (; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--model') opts.model = argv[++i]
  else if (a === '--reasoning-effort' || a === '--effort') opts.effort = argv[++i]
  else if (a === '--approval-mode') opts.approval = argv[++i]
  else if (a === '--trust-workspace') opts.trust = true
  else if (a === '--disable-sandbox') opts.noSandbox = true
  else if (a === '-c' || a === '--config') {
    const kv = argv[++i] ?? ''
    const eq = kv.indexOf('=')
    const key = kv.slice(0, eq)
    let value
    try {
      value = JSON.parse(kv.slice(eq + 1))
    } catch {
      fail(2, `-c ${key}: refusing run: value isn't JSON`)
    }
    if (key === 'hooks') opts.hooks = value
    else if (key === 'context.foreign_personal_skills') opts.foreignSkills = value !== false
    else if (key === 'context.foreign_personal_rules') opts.foreignRules = value !== false
    else if (key === 'mcpServers') fail(2, '-c mcpServers: refusing run: set one server per -c')
    else if (key.startsWith('mcpServers.') && key.split('.').length === 2) {
      const bad = Object.keys(value ?? {}).find((k) => !SERVER_FIELDS.has(k))
      if (bad) fail(2, `-c ${key}: refusing run: unknown key: no such setting (see \`--help\` for the -c/--config shape)`)
      // 1.4.20: an env or header value only as one whole ${VAR} naming a set variable (observed: a literal refuses the run).
      const leaves = [...Object.values(value?.env ?? {}), ...Object.values(value?.headers ?? {})]
      const leafOk = (v) => {
        const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(v))
        return !!m && process.env[m[1]] !== undefined
      }
      if (!leaves.every(leafOk)) fail(2, `-c ${key}: refusing run: secret leaves need exactly one whole-value \`\${VAR}\` naming a set variable (see \`--help\` for the -c/--config shape)`)
      opts.servers[key.slice('mcpServers.'.length)] = value
    } else fail(2, `-c ${key}: refusing run: unknown key: no such setting (see \`--help\` for the -c/--config shape)`)
  } else if (a === '--') {
    opts.prompt = argv.slice(i + 1).join(' ') || null
    break
  } else if (!a.startsWith('-')) opts.prompt = a
}
if (opts.resume && opts.prompt) fail(2, 'invalid TUI options: unknown argument `resume`')

// ---- Its session.
const dataHome = process.env.XDG_DATA_HOME || path.join(process.env.USERPROFILE || '.', '.local', 'share')
const sessionsRoot = path.join(dataHome, 'muse', 'sessions')
const findSession = (id) => {
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === id ? [path.join(d, e.name)] : walk(path.join(d, e.name))) : [])) : [])
  return walk(sessionsRoot)[0] ?? null
}
const uuid7 = () => {
  const h = Date.now().toString(16).padStart(12, '0') + crypto.randomBytes(10).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
let sessionDir
const id = opts.resume ?? uuid7()
if (opts.resume) {
  sessionDir = findSession(opts.resume)
  if (!sessionDir) fail(1, `no session ${opts.resume} to resume`)
} else {
  const d = new Date()
  sessionDir = path.join(sessionsRoot, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'), id)
  fs.mkdirSync(sessionDir, { recursive: true })
}
const sessionFile = path.join(sessionDir, 'session.jsonl')
let sequence = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).length : 0
const record = (payloadType, payload) => fs.appendFileSync(sessionFile, `${JSON.stringify({ schema_version: 1, id: crypto.randomUUID(), stream: { kind: 'session', id }, sequence: ++sequence, recorded_at: Date.now() * 1000, record_type: 'event', durability: 'durable', causation_id: null, payload_type: payloadType, payload_schema_version: 1, payload })}\n`)
const runEvent = (runId, event) => record('runtime.session', { kind: 'run', run_id: runId, event })
if (!opts.resume) record('runtime.session.metadata', { kind: 'metadata', record: { workspace_root: process.cwd(), provider_id: 'echo', build: { sha: 'fake', semver: '1.4.20' } } })

log({ kind: 'launch', args: argv, cwd: process.cwd(), sessionId: id, resumed: !!opts.resume, trust: opts.trust, model: opts.model, effort: opts.effort, approval: opts.approval, foreignSkills: opts.foreignSkills, foreignRules: opts.foreignRules, prompt: opts.prompt, servers: Object.keys(opts.servers), serverDefs: opts.servers, hookEvents: Object.keys(opts.hooks), env: accountEnv })

// ---- Hooks: `%COMSPEC% /C <command>`, Muse's hook environment (1.4.20, observed), the event's JSON on stdin.
const KEPT = new Set(['COMSPEC', 'HOME', 'PATH', 'PATHEXT', 'PROMPT', 'SHELL', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'WINDIR'])
const hookEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => KEPT.has(k.toUpperCase()))), MUSE_SESSION_ID: id, MUSE_THREAD_ID: id })
const base = () => ({ session_id: id, cwd: process.cwd(), transcript_path: null, model: opts.model ?? 'unknown', permission_mode: 'default' })
/** Runs the event's hooks; their results ({ code, stdout }), in order. */
async function hook(event, fields) {
  const results = []
  for (const group of opts.hooks[event] ?? []) {
    for (const h of group.hooks ?? []) {
      const cmd = h.commandWindows || h.command
      if (!cmd) continue
      const r = await new Promise((resolve) => {
        // Node's own escaping, as Rust's: a quote in the command reaches cmd as \", which cmd doesn't undo.
        const p = spawn(process.env.ComSpec || 'cmd.exe', ['/C', cmd], { cwd: process.cwd(), env: hookEnv(), windowsHide: true })
        const chunks = []
        p.stdout.on('data', (d) => chunks.push(d))
        p.stderr.on('data', () => undefined)
        const timer = setTimeout(() => p.kill(), (Number(h.timeout) || 60) * 1000)
        p.on('close', (code) => (clearTimeout(timer), resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') })))
        p.stdin.end(JSON.stringify({ hook_event_name: event, ...base(), ...fields }))
      })
      log({ kind: 'hook', event, exit: r.code, stdoutBytes: Buffer.byteLength(r.stdout), stdout: r.stdout.slice(0, 500) })
      results.push(r)
    }
  }
  return results
}

// ---- MCP servers (stdio): initialize, initialized, tools/list; tools/call on request.
const servers = new Map()
// Whole-value ${VAR} references resolve from Muse's own environment (its --help: "Secrets only as whole-value ${VAR}").
const resolveRefs = (env) =>
  Object.fromEntries(
    Object.entries(env ?? {}).map(([k, v]) => {
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(v))
      return [k, m ? (process.env[m[1]] ?? '') : v]
    })
  )
function startServer(name, def) {
  const p = spawn(def.command, def.args ?? [], { cwd: process.cwd(), env: { ...hookEnv(), ...resolveRefs(def.env), MUSE_SESSION_ID: id }, windowsHide: true })
  const s = { p, buf: '', next: 1, waiting: new Map(), tools: [] }
  p.stdout.on('data', (d) => {
    s.buf += d
    let n
    while ((n = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, n).trim()
      s.buf = s.buf.slice(n + 1)
      if (!line) continue
      try {
        const m = JSON.parse(line)
        if (m.id !== undefined && s.waiting.has(m.id)) s.waiting.get(m.id)(m)
      } catch {
        /* not JSON-RPC */
      }
    }
  })
  p.on('error', (e) => log({ kind: 'mcpError', server: name, message: e.message }))
  s.request = (method, params) =>
    new Promise((resolve) => {
      const rid = s.next++
      s.waiting.set(rid, resolve)
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`)
      setTimeout(() => resolve({ error: { message: 'timeout' } }), 15000)
    })
  servers.set(name, s)
  return s
}
async function startServers() {
  const names = Object.keys(opts.servers).filter((n) => opts.servers[n].enabled !== false)
  if (!opts.trust) {
    if (names.length) log({ kind: 'withheld', servers: names })
    return
  }
  for (const name of names) {
    const def = opts.servers[name]
    if (!def.command) continue
    const s = startServer(name, def)
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tbh', version: '0.1.0' } })
    s.p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
    const list = await s.request('tools/list', {})
    s.tools = (list.result?.tools ?? []).map((t) => t.name)
    log({ kind: 'mcp', server: name, tools: s.tools })
  }
}

// ---- Its pane.
const prompt = () => out('\r\n› ')
let busy = false
let asking = null
async function turn(text) {
  busy = true
  const runId = uuid7()
  const turnId = uuid7()
  await hook('UserPromptSubmit', { prompt: text, turn_id: turnId })
  runEvent(runId, { kind: 'started', prompt: text })
  let reply = `echo: ${text}`
  const edit = /^edit (\S+)( then ask)?$/.exec(text)
  const call = /^call (\S+)(?: (.+))?$/.exec(text)
  if (edit) {
    const file = path.resolve(process.cwd(), edit[1])
    const results = await hook('PreToolUse', { tool_name: 'write_file', tool_input: { path: file, content: 'edited by fake-muse\n' }, tool_use_id: `call-${turnId}`, turn_id: turnId })
    let blocked = null
    for (const r of results) {
      let j = null
      try {
        j = JSON.parse(r.stdout)
      } catch {
        /* plain text */
      }
      if (r.code === 2) blocked = r.stdout.trim() || 'blocked'
      else if (j && j.decision === 'block') blocked = String(j.reason ?? 'blocked')
    }
    if (blocked) reply = `Blocked: ${blocked}`
    else {
      fs.appendFileSync(file, 'edited by fake-muse\n')
      reply = `Wrote ${file}`
    }
    log({ kind: blocked ? 'blocked' : 'write', file, reason: blocked })
    // `then ask`: the turn goes on to a question, so its edit's claim stays held until it is answered.
    if (!blocked && edit[2]) {
      await hook('PostToolUse', { tool_name: 'write_file', tool_input: { path: file }, tool_use_id: `call-${turnId}`, turn_id: turnId })
      await hook('Notification', { message: 'Approve?' })
      out('\r\nApprove? (y/n) ')
      asking = { runId, turnId }
      return
    }
  } else if (call) {
    const [, tool, args] = call
    const s = [...servers.values()].find((x) => x.tools.includes(tool))
    if (!s) reply = `No tool ${tool}`
    else {
      let a = {}
      try {
        a = args ? JSON.parse(args) : {}
      } catch {
        /* none */
      }
      const r = await s.request('tools/call', { name: tool, arguments: a })
      reply = r.error ? `Tool error: ${r.error.message}` : (r.result?.content ?? []).map((c) => c.text ?? '').join('\n')
      log({ kind: 'toolCall', tool, ok: !r.error, text: reply.slice(0, 500) })
    }
  } else if (text === 'ask') {
    await hook('Notification', { message: 'Approve?' })
    out('\r\nApprove? (y/n) ')
    asking = { runId, turnId }
    return
  }
  finish(runId, turnId, reply)
}
async function finish(runId, turnId, reply) {
  out(`\r\n${reply.replace(/\n/g, '\r\n')}`)
  runEvent(runId, { kind: 'assistant_message_committed', message_id: crypto.randomUUID(), response_id: 'fake', text: reply })
  runEvent(runId, { kind: 'model_completed', usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 2, reasoning_tokens: 1 }, duration_ms: 3 })
  runEvent(runId, { kind: 'terminal', terminal: 'completed', reason: null })
  await hook('Stop', { last_assistant_message: reply, stop_hook_active: false, turn_id: turnId })
  busy = false
  prompt()
}

async function main() {
  if (process.env.FAKE_MUSE_SANDBOX_FILE && fs.existsSync(process.env.FAKE_MUSE_SANDBOX_FILE) && !opts.noSandbox) {
    out('Set up the Windows sandbox\r\nMuse needs administrator rights to create two local accounts (muse-sbx-r1, muse-sbx-u1)\r\n')
    log({ kind: 'sandboxScreen' })
    return // waits there: Combwork never answers it
  }
  await startServers()
  const started = await hook('SessionStart', { source: opts.resume ? 'resume' : 'startup' })
  for (const r of started) {
    // 1.4.20 (tests/fixtures/muse/guidance-limit-1.4.20.json): 16384 bytes kept whole (its trailing newline trimmed); one
    // byte more fails the hook, and nothing of it is kept. A hook that fails adds nothing either.
    const bytes = Buffer.byteLength(r.stdout)
    const text = r.code === 0 && bytes <= 16384 ? r.stdout.replace(/\s+$/, '') : ''
    if (text) runEvent(uuid7(), { kind: 'context_block_updated', id: 'hook:session_start:session:0', role: 'developer', source: 'runtime_hook', lifecycle: 'session_start', text })
    log({ kind: 'context', exit: r.code, bytes, kept: Buffer.byteLength(text), head: text.slice(0, 200), text })
  }
  out(`\x1b]0;${path.basename(process.cwd())}\x07Muse Code 1.4.20 · ${opts.model ?? 'muse-spark-1.2'} · ${process.cwd()}\r\n`)
  ready = true
  if (opts.prompt) await turn(opts.prompt)
  else prompt()
}

let line = ''
// Lines entered before it is ready, or while a turn runs, wait their turn (as its composer queues them), in order.
let ready = false
const queue = []
const take = (text) => {
  if (asking) {
    const a = asking
    asking = null
    void finish(a.runId, a.turnId, text === 'y' ? 'Approved.' : 'Declined.')
  } else if (text === '/exit') {
    log({ kind: 'exit', sessionId: id })
    for (const s of servers.values()) s.p.kill()
    process.exit(0)
  } else if (text) void turn(text)
  else prompt()
}
const drain = () => {
  // take() starts a turn or a question (busy or asking): one line at a time, the next on a later tick.
  if (ready && !busy && !asking && queue.length) take(queue.shift())
}
setInterval(drain, 50).unref()
process.stdin.setRawMode?.(true)
process.stdin.on('data', (d) => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\r' || ch === '\n') {
      const text = line.trim()
      line = ''
      if (asking && ready) take(text)
      else {
        if (busy) log({ kind: 'typedWhileBusy', text })
        queue.push(text)
        drain()
      }
    } else if (ch === '\x15') line = ''
    else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
    else if (ch >= ' ') {
      line += ch
      out(ch)
    }
  }
})
process.stdin.on('end', () => {
  // A pipe closed (not a pane): what it was given finishes, then it ends.
  const wait = () => (!ready || busy || asking || queue.length ? setTimeout(wait, 50) : (servers.forEach((s) => s.p.kill()), process.exit(0)))
  setTimeout(wait, 50)
})
main().catch((e) => fail(1, e.message))
