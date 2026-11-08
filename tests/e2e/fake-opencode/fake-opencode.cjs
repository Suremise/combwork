// A stand-in for OpenCode v2.2.6 (`opencode`), for the OpenCode provider's checks (HI-2759 on): no sign-in, no model, no
// network. Everything it does is what the real 2.2.6 did in HI-2758's probe and HI-2763's R0 recordings
// (tests/fixtures/opencode/real-2.2.6, its README says which and how); what was never recorded it refuses rather than guesses.
// - `--version` prints `opencode v2.2.6`; `--help` and the subcommands' `--help` print the recorded text;
// - `serve --hostname H --port N` runs the private server (server.cjs) with OPENCODE_PASSWORD; like the real one it
//   keeps running when its stdin closes (HB1's HI-2759 run), so only ending its process tree stops it;
// - commands that need a server (`models`, `auth list|login`, `stats`, `session list|export|import`, `debug config`)
//   run against a private one only: `--standalone`, `--server <url>` or <OPENCODE_CONFIG_DIR>\service.json
//   {"disabled":true}. Without any of them the real one starts its shared background service (127.0.0.1:28894, which
//   outlives it); the fake refuses (exit 1) so a launch that would do that fails its test;
// - with no subcommand it is the TUI: `[--server <url> | --standalone] [--session <id>] [<dir>]`, a line-mode pane: each
//   line typed is a prompt to its server, the session's history and replies are shown from the server, a permission
//   asked is answered by the next line ("y" once, "a" always, anything else reject), Esc interrupts, Ctrl+C quits (0).
//   Given an absent --session it shows a new-session screen and creates nothing (tui/session-absent-*.json); a prompt
//   typed there is refused (what 2.2.6 does then was not recorded). With no --session its first prompt makes one;
// - the config and what it loads (config.cjs), its data root (store.cjs: OPENCODE_DB), and its MCP servers are the
//   launch's own: its environment is all it reads.
// Every launch is logged to FAKE_OPENCODE_LOG (a JSON line: its arguments, cwd and the environment the adapter sets).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config.cjs')
const store = require('./store.cjs')
const { startServer, modelsOf, integrations, importSession, VERSION } = require('./server.cjs')

const FIX = path.join(__dirname, '..', '..', 'fixtures', 'opencode', 'real-2.2.6', 'cli')
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (...names) => names.some((n) => argv.includes(n))
const VALUED = ['--server', '--session', '-s', '--prompt', '--hostname', '--port', '--format', '--method', '--answer', '--log-level', '--days', '--year', '--project', '--limit']
const positional = argv.filter((a, i) => !a.startsWith('-') && !VALUED.includes(argv[i - 1]))
const fixture = (name) => {
  // Checked out with CRLF on Windows (.gitattributes): what 2.2.6 printed had LF.
  const t = fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n')
  const m = /--- stdout\n([\s\S]*?)\n--- stderr\n([\s\S]*)$/.exec(t)
  return m ? { stdout: m[1], stderr: m[2] } : { stdout: t, stderr: '' }
}

const SECRET = /KEY|TOKEN|SECRET|PASSWORD/i
const ENV_KEYS = ['OPENCODE_CONFIG_DIR', 'OPENCODE_DB', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_PASSWORD', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED', 'CLOUDSDK_CONFIG', 'AZURE_CONFIG_DIR', 'AZD_CONFIG_DIR', 'METADATA_SERVER_DETECTION', 'NO_GCE_CHECK', 'CW_AGENT']
// Ambient provider credentials the adapter strips unless a connection sets them (only whether each is set is logged).
const AMBIENT = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AZURE_OPENAI_API_KEY', 'AZURE_API_KEY', 'GITHUB_TOKEN']
function pick() {
  const env = {}
  for (const k of ENV_KEYS) if (process.env[k] !== undefined) env[k] = SECRET.test(k) ? '(set)' : process.env[k]
  for (const k of AMBIENT) if (process.env[k] !== undefined) env[k] = '(set)'
  return env
}
function log(entry) {
  if (!process.env.FAKE_OPENCODE_LOG) return
  fs.mkdirSync(path.dirname(process.env.FAKE_OPENCODE_LOG), { recursive: true })
  fs.appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n')
}

const cfgDir = () => config.load(null).cfgDir
const serviceDisabled = () => config.readJson(path.join(cfgDir(), 'service.json'))?.disabled === true
const cfgJson = () => config.readJson(path.join(cfgDir(), 'opencode.json')) || {}
log({ kind: 'launch', args: argv, cwd: process.cwd(), env: pick(), serviceDisabled: serviceDisabled(), update: cfgJson().update ?? null })

if (has('--version', '-v') && positional.length === 0) {
  process.stdout.write(`opencode v${VERSION}\n`)
  process.exit(0)
}
const HELP = { '': 'help.txt', stats: 'stats-help.txt', auth: 'auth-help.txt', 'auth login': 'auth-login-help.txt', session: 'session-help.txt', models: 'models-help.txt' }
if (has('--help', '-h')) {
  const key = [positional.slice(0, 2).join(' '), positional[0] || ''].find((k) => HELP[k] !== undefined)
  if (key === undefined) {
    process.stderr.write(`fake opencode: no recorded help for "${positional.join(' ')}"\n`)
    process.exit(1)
  }
  process.stdout.write(fixture(HELP[key]).stdout.replace(/\n?$/, '\n'))
  process.exit(0)
}

const ANSI = { grey: (s) => `\x1b[90m${s}\x1b[39m`, red: (s) => `\x1b[31m${s}\x1b[39m` }
const sub = positional[0]
const NEEDS_SERVER = ['models', 'auth', 'stats', 'session', 'debug', 'mcp']
if (NEEDS_SERVER.includes(sub) && !has('--standalone', '--server') && !serviceDisabled()) {
  log({ kind: 'shared-service', args: argv })
  process.stderr.write(`fake opencode: "${argv.join(' ')}" would start OpenCode's shared background service (127.0.0.1:28894, outliving this command). Pass --standalone or --server <url>, or write {"disabled":true} to ${path.join(cfgDir(), 'service.json')}.\n`)
  process.exit(1)
}

;(async () => {
  if (sub === 'serve') return serve()
  if (sub === 'models') {
    const cfg = config.load(process.cwd())
    process.stdout.write(modelsOf(cfg).map((m) => `${m.providerID}/${m.id}\n`).join(''))
    return process.exit(0)
  }
  if (sub === 'auth' && positional[1] === 'list') {
    const cfg = config.load(process.cwd())
    const rows = integrations(cfg).filter((x) => x.connections.length).map(({ id, name, connections }) => ({ id, name, connections }))
    if (flag('--format') === 'json') process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
    else process.stdout.write(rows.length ? rows.map((r) => `${r.name} (${r.id})\n`).join('') : 'No authenticated integrations\n')
    return process.exit(0)
  }
  if (sub === 'auth' && positional[1] === 'login') {
    // Without a terminal, as 2.2.6 answered (cli/auth-login-*.txt); in one, its sign-in screens weren't recorded.
    if (process.stdin.isTTY) {
      process.stderr.write('fake opencode: an interactive sign-in was not recorded\n')
      return process.exit(1)
    }
    const answer = flag('--answer')
    const why = !positional[2] ? 'Pass an integration ID or name when running without an interactive terminal' : answer ? `Unknown form field: ${answer.split('=')[0]}` : 'API key input requires an interactive terminal'
    process.stdout.write(`${positional[2] ? `${ANSI.grey('T')}  Connect an integration\n` : ''}${ANSI.grey('|')}\n${ANSI.red('x')}  ${why}\n${ANSI.grey('|')}\n${ANSI.grey('—')}  Failed\n\n`)
    return process.exit(1)
  }
  if (sub === 'stats') return stats()
  if (sub === 'session') return sessionCmd()
  if (sub === 'debug' && positional[1] === 'config') {
    const cfg = config.load(process.cwd())
    process.stdout.write(JSON.stringify(cfg.loaded.filter((l) => l.kind === 'config').map((l) => ({ type: 'document', path: l.path, info: config.readJson(l.path) })), null, 2) + '\n')
    return process.exit(0)
  }
  if (sub && !fs.existsSync(path.resolve(sub))) {
    process.stderr.write(`fake opencode: "${sub}" is not a recorded command\n`)
    return process.exit(1)
  }
  return tui()
})().catch((e) => {
  log({ kind: 'error', error: String(e?.stack || e) })
  process.stderr.write(String(e?.stack || e) + '\n')
  process.exit(1)
})

async function serve() {
  // A fault in a turn is logged, never the end of the server (the suites would see a reset connection, not the fault).
  process.on('unhandledRejection', (e) => log({ kind: 'error', error: String(e?.stack || e) }))
  process.on('uncaughtException', (e) => log({ kind: 'error', error: String(e?.stack || e) }))
  const s = await startServer({ env: process.env, cwd: process.cwd(), hostname: flag('--hostname') || '127.0.0.1', port: Number(flag('--port') || 0), password: process.env.OPENCODE_PASSWORD ?? '', log })
  process.stdout.write(`opencode server listening on ${s.url}\n`)
  // Its stdin closing ends nothing (as 2.2.6's): only a kill stops it.
  process.stdin.on('error', () => undefined)
  process.stdin.resume()
  process.stdin.on('end', () => log({ kind: 'stdin-closed', still: 'running' }))
  setInterval(() => undefined, 1 << 30)
}

function stats() {
  const db = store.read(process.env)
  const sessions = Object.values(db.sessions)
  const steps = []
  const tools = {}
  let prompts = 0
  for (const s of sessions)
    for (const m of s.messages) {
      if (m.type === 'user') prompts++
      if (m.type === 'assistant' && m.tokens) steps.push(m)
      for (const c of m.content || []) {
        if (c.type !== 'tool') continue
        const u = (tools[c.name] ||= { name: c.name, calls: 0, succeeded: 0, failed: 0, unfinished: 0, durationP50: 0 })
        u.calls++
        if (c.state?.status === 'completed') u.succeeded++
        else u.failed++
      }
    }
  const sum = (xs) => xs.reduce((a, t) => ({ input: a.input + t.input, output: a.output + t.output, reasoning: a.reasoning + t.reasoning, cache: { read: a.cache.read + t.cache.read, write: a.cache.write + t.cache.write } }), { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  const tokens = sum(steps.map((m) => m.tokens))
  const usage = Object.values(tools)
  const totals = usage.reduce((a, u) => ({ calls: a.calls + u.calls, succeeded: a.succeeded + u.succeeded, failed: a.failed + u.failed, unfinished: 0 }), { calls: 0, succeeded: 0, failed: 0, unfinished: 0 })
  const days = [...new Set(steps.map((m) => new Date(m.time.created).toISOString().slice(0, 10)))]
  const byModel = {}
  for (const m of steps) {
    const k = `${m.model.providerID}/${m.model.id}`
    byModel[k] ||= { model: { id: m.model.id, providerID: m.model.providerID }, steps: 0, tokens: [], cost: 0 }
    byModel[k].steps++
    byModel[k].tokens.push(m.tokens)
  }
  const year = new Date().getUTCFullYear()
  if (has('--json')) {
    process.stdout.write(JSON.stringify({ range: { from: Date.UTC(year, 0, 1), to: Date.now() }, sessions: sessions.length, subagents: 0, prompts, steps: steps.length, tokens, cost: 0, tools: { mode: 'detail', totals, usage }, activeDays: days.length, streak: days.length ? 1 : 0, activity: days.map((date) => ({ date, steps: steps.filter((m) => new Date(m.time.created).toISOString().startsWith(date)).length })), models: Object.values(byModel).map((x) => ({ ...x, tokens: sum(x.tokens) })) }, null, 2) + '\n')
    return process.exit(0)
  }
  if (!sessions.length) process.stdout.write(fixture('stats-empty.txt').stdout.replace(/\n?$/, '\n'))
  else {
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    const all = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    process.stdout.write(`opencode stats · ${year} so far · all projects\n\n${sessions.length} sessions\n${prompts} prompts · ${steps.length} steps · ${k(all)} tokens\n${totals.calls ? ((100 * totals.succeeded) / totals.calls).toFixed(1) : '100.0'}% tool success · ${days.length} active day${days.length === 1 ? '' : 's'} · best streak ${days.length ? 1 : 0} day\n\nopencode.ai\n`)
  }
  process.exit(0)
}

function sessionCmd() {
  const what = positional[1]
  if (what === 'export') {
    const s = store.read(process.env).sessions[positional[2]]
    if (!s) {
      process.stderr.write(`Session not found: ${positional[2]}\n`)
      return process.exit(1)
    }
    process.stdout.write(JSON.stringify({ info: s.info, messages: [...s.messages].reverse() }, null, 2) + '\n')
    return process.exit(0)
  }
  if (what === 'import') {
    const body = JSON.parse(fs.readFileSync(positional[2], 'utf8'))
    // 2.2.6 said this for one that exists (cli/session-import-again.txt); a first import's output wasn't recorded: none.
    if (importSession(body, process.env).conflict) process.stderr.write('Session already exists\n')
    return process.exit(0)
  }
  if (what === 'list') {
    const rows = Object.values(store.read(process.env).sessions).map((s) => s.info).filter((i) => path.resolve(i.location.directory).toLowerCase() === process.cwd().toLowerCase()).sort((a, b) => b.time.updated - a.time.updated)
    if (flag('--format') === 'json') process.stdout.write(JSON.stringify(rows.map((i) => ({ id: i.id, title: i.title ?? '', updated: i.time.updated, created: i.time.created, projectId: i.projectID, directory: i.location.directory })), null, 2) + '\n')
    else process.stdout.write(rows.map((i) => `${i.id}\t${i.title ?? ''}\t${new Date(i.time.updated).toLocaleString('en-GB')}\n`).join(''))
    return process.exit(0)
  }
  process.stderr.write(`fake opencode: "session ${what ?? ''}" is not a recorded command\n`)
  process.exit(1)
}

// --- The TUI.
async function tui() {
  const dir = positional[0] ? path.resolve(positional[0]) : process.cwd()
  let url = flag('--server')
  let password = process.env.OPENCODE_PASSWORD ?? ''
  let own = null
  if (!url) {
    // --standalone (or the service disabled): a private server of its own, ended with it.
    password = crypto.randomBytes(18).toString('base64url')
    own = await startServer({ env: process.env, cwd: dir, port: 0, password, log })
    url = own.url
  }
  const headers = { authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'), 'content-type': 'application/json' }
  const api = async (method, p, body) => {
    const r = await fetch(url + p, body ? { method, headers, body: JSON.stringify(body) } : { method, headers })
    const t = await r.text()
    let j = null
    try {
      j = t ? JSON.parse(t) : null
    } catch {}
    return { status: r.status, body: j }
  }
  const out = (s) => process.stdout.write(s)
  let sid = flag('--session') ?? flag('-s') ?? null
  let absent = false
  out(`OpenCode ${VERSION} (fake) · ${dir}\n`)
  if (sid) {
    const r = await api('GET', `/api/session/${sid}`)
    if (r.status === 200) {
      const msgs = (await api('GET', `/api/session/${sid}/message`)).body?.data ?? []
      for (const m of [...msgs].reverse()) {
        if (m.type === 'user') out(`> ${m.text}\n`)
        for (const c of m.content || []) if (c.type === 'text') out(`${c.text}\n`)
      }
      out(`session ${sid}\n`)
    } else absent = true
  }
  log({ kind: 'tui', server: own ? 'standalone' : url, session: sid, absent })
  out('Ask anything…\n> ')

  // The session's events, from its server.
  let waiting = null // a permission asked: { id }
  const ac = new AbortController()
  ;(async () => {
    const r = await fetch(url + '/api/event', { headers: { authorization: headers.authorization, accept: 'text/event-stream' }, signal: ac.signal })
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true })
      for (let i; (i = buf.indexOf('\n\n')) >= 0; ) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
        if (!data) continue
        let e
        try {
          e = JSON.parse(data)
        } catch {
          continue
        }
        if (!sid || e.data?.sessionID !== sid) continue
        if (e.type === 'session.text.ended') out(`${e.data.text}\n`)
        else if (e.type === 'session.tool.called') out(`· ${JSON.stringify(e.data.input)}\n`)
        else if (e.type === 'permission.asked') {
          waiting = { id: e.data.id }
          out(`Permission required: ${e.data.action} ${e.data.resources.join(' ')} — allow once (y), always (a), reject (n)?\n`)
        } else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)) out(`${e.type === 'session.execution.succeeded' ? '' : `[${e.type.split('.').pop()}]\n`}> `)
      }
    }
  })().catch(() => undefined)

  const quit = async (code = 0) => {
    ac.abort()
    if (own) await own.close()
    process.exit(code)
  }
  const submit = async (t) => {
    if (waiting) {
      const w = waiting
      waiting = null
      const decision = /^y/i.test(t) ? 'once' : /^a/i.test(t) ? 'always' : 'reject'
      await api('POST', `/api/session/${sid}/permission/${w.id}/reply`, { decision })
      return
    }
    if (absent) {
      log({ kind: 'refused', why: 'a prompt on an absent --session (not recorded)', session: sid })
      out(`fake opencode: ${sid} doesn't exist, and what 2.2.6 does with a prompt then wasn't recorded\n> `)
      return
    }
    if (!sid) sid = (await api('POST', '/api/session', { location: { directory: dir } })).body?.data?.id
    out(`${t}\n`)
    await api('POST', `/api/session/${sid}/prompt`, { text: t })
  }
  let line = ''
  let chain = Promise.resolve()
  const first = flag('--prompt')
  if (first) chain = chain.then(() => submit(first))
  process.stdin.setEncoding('utf8')
  if (process.stdin.isTTY) process.stdin.setRawMode?.(true)
  process.stdin.on('data', (d) => {
    if (d === '\x1b' && sid) {
      chain = chain.then(() => api('POST', `/api/session/${sid}/interrupt`, {}))
      return
    }
    for (const c of d) {
      if (c === '\x03') return void quit(0)
      if (c === '\r' || c === '\n') {
        const t = line.replace(/\x1b?\[20[01]~/g, '').trim()
        line = ''
        if (!t) continue
        if (t === '/exit') return void quit(0)
        chain = chain.then(() => submit(t))
      } else if (c === '\x15') line = ''
      else if (c >= ' ' || c === '\t') line += c
    }
  })
  process.stdin.on('end', () => void quit(0))
}
