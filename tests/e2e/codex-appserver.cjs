// What a Codex launch through its app server would rely on (#653's spike, before Combwork builds that launch mode): the
// real TUI attached to `codex app-server` with `--remote`, and a client of Combwork's on the same WebSocket. Checked against
// the installed Codex so that a Codex update that changes any of it (the WebSocket is documented as experimental) fails
// here first. In the Codex test home (a few short turns, low effort), without a test Combwork (noCombwork). Each part:
// - the TUI's thread is joined (thread/resume) once its first turn is written (joining earlier says "no rollout found");
// - a typed turn and a turn Combwork starts (turn/start) both come as identified turn/started and turn/completed, and their
//   user message's clientId tells them apart (Combwork's own id, or the TUI's); the TUI shows Combwork's turn, and a draft the
//   user is typing stays in its prompt;
// - Combwork's hooks given to the app server run for both (UserPromptSubmit, Stop);
// - turn/interrupt ends a running turn as interrupted (0.164.0: a command it ran goes on, its end reported later under
//   the interrupted turn: not checked here, notes/2026-10-20-codex-app-server-spike.md);
// - an approval request reaches both the TUI and Combwork's client; answered in the TUI, Combwork's client sees it resolved;
// - Combwork's client can drop and rejoin;
// - after the app server is replaced, `codex resume <id> --remote` brings the thread back, and it is joined again.
// Not checked here (the spike's evidence only, notes/2026-10-20-codex-app-server-spike.md): the running TUI reconnecting
// by itself to a new server on the same port, and the user's Enter racing turn/start (one turn with both messages).
// A turn Codex holds for a rate limit (a 429 it waits minutes to retry, which no client is told of) makes the suite a SKIP
// for the environment (rateLimited, #1617), not a FAIL.
const lib = require('./lib.cjs')
const { spawn } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const pty = require('@lydell/node-pty')
const { Terminal } = require('@xterm/headless')
const { endChildTree } = require('./folderProcesses.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 90000

const work = path.join(lib.WORK, 'codex-appserver-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const env = () => lib.childEnv({ CODEX_HOME: lib.CODEX_HOME, PATH: lib.pathWithoutStoreAliases() })
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })
const text = (s) => [{ type: 'text', text: s, text_elements: [] }]

/**
 * The test home's own MCP servers turned off, as Combwork's launch turns off the user's (#1281), so the app server runs as a
 * Combwork launch would: one of them (userfake) never starts, and each thread an app server loads would start it again.
 */
const ownServersOff = () => {
  const config = path.join(lib.CODEX_HOME, 'config.toml')
  const names = fs.existsSync(config) ? [...fs.readFileSync(config, 'utf8').matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1]) : []
  return names.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`])
}
/**
 * Whether Codex is waiting out a rate limit on this thread since `from` (ms): its own log in the test home (logs_*.sqlite)
 * has a sampling request it will retry after a 429 Too Many Requests, which reaches no client (0.164.0: no `error`
 * notification, the TUI just shows "Working") and holds the turn for its back-off (13 s to over 9 min, #1617). The
 * reason, as lib's environment failures say it, or null.
 */
function rateLimited(threadId, from) {
  const { DatabaseSync } = require('node:sqlite')
  for (const name of fs.existsSync(lib.CODEX_HOME) ? fs.readdirSync(lib.CODEX_HOME).filter((f) => /^logs_\d+\.sqlite$/.test(f)) : []) {
    let db = null
    try {
      db = new DatabaseSync(path.join(lib.CODEX_HOME, name), { readOnly: true })
      const rows = db.prepare("select feedback_log_body b from logs where ts >= ? and target = 'codex_core::responses_retry' order by ts").all(Math.floor(from / 1000))
      const hit = rows.map((r) => String(r.b ?? '')).find((b) => b.includes(threadId) && /429 Too Many Requests/.test(b))
      if (hit) return `usage or rate limit: Codex retries the turn's request after a 429 Too Many Requests (${/retrying sampling request \([^)]*\)/.exec(hit)?.[0] ?? 'its log'})`
    } catch {
      // A log Codex has changed or locked says nothing either way: the failure stays a FAIL.
    } finally {
      db?.close()
    }
  }
  return null
}

/** `codex app-server` on a WebSocket, with Combwork's hooks (`hookArgs`). */
const appServer = (port, hookArgs) => spawn('codex.exe', ['app-server', '--listen', `ws://127.0.0.1:${port}`, '-c', 'model_reasoning_effort="low"', ...ownServersOff(), ...hookArgs], { cwd: work, env: env(), windowsHide: true, stdio: 'ignore' })

/** The real TUI in a terminal, attached to the app server, with its screen rendered. */
function tui(args) {
  const term = new Terminal({ cols: 110, rows: 32, allowProposedApi: true })
  const t = pty.spawn('codex.exe', args, { cols: 110, rows: 32, cwd: work, env: env(), useConpty: true })
  t.onData((d) => term.write(d))
  const screen = () => {
    const b = term.buffer.active
    const rows = []
    for (let i = 0; i < term.rows; i++) rows.push((b.getLine(b.viewportY + i)?.translateToString(true) ?? '').replace(/\s+$/, ''))
    return rows.join('\n')
  }
  const type = async (s) => {
    for (let i = 0; i < s.length; i += 8) {
      t.write(s.slice(i, i + 8))
      await lib.sleep(10) // on purpose: typed in pieces, as Combwork types
    }
  }
  /** The end of `s` (spaces left out, as the TUI wraps it) shows on the screen. */
  const shows = (s) => screen().replace(/\s+/g, '').includes(s.replace(/\s+/g, '').slice(-16))
  /** `s` typed, and shown in the prompt: a step that needs it there fails, saying what the screen showed. */
  const typeShown = async (s) => {
    await type(s)
    if (!(await lib.until(() => shows(s), 20000, 100))) throw new Error(`"${s}" didn't show in the TUI's prompt: ${tail(screen())}`)
  }
  /** A line typed and sent once it shows in the prompt. */
  const say = async (s) => {
    await typeShown(s)
    t.write('\r')
  }
  /** The TUI at its prompt, ready for input; else the step fails, saying what it showed. */
  const ready = async (what) => {
    if (!(await lib.until(() => /Ask Codex to do anything|›/.test(screen()), HUNG_MS, 200))) throw new Error(`the TUI isn't at its prompt ${what}: ${tail(screen())}`)
  }
  return { t, screen, type, typeShown, say, ready, kill: () => t.kill() }
}
const tail = (screen) => screen.split('\n').filter(Boolean).slice(-6).join(' | ')
/** The notifications a client got, by method, for a failed check (streamed deltas left out). */
const methods = (events) => events.map((e) => e.method).filter((m) => !/delta|tokenUsage|rateLimits/i.test(m))

const notices = new Set()

/** How long Combwork's client waits for the app server to open its connection or answer a call. */
const CALL_MS = 60000

/**
 * Combwork's side: a JSON-RPC client on the app server's WebSocket. Its connection and every call are bounded (CALL_MS),
 * and a connection that closes or fails rejects what is still waiting, so a server that drops or stops answering fails
 * the step that waited on it instead of holding the suite.
 */
async function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  const events = []
  let closed = false
  const fail = (why) => {
    for (const [, p] of pending) p.reject(new Error(why))
    pending.clear()
  }
  ws.addEventListener('close', () => {
    closed = true
    fail('the app server closed the connection')
  })
  ws.addEventListener('error', () => fail('the connection to the app server failed'))
  try {
    await new Promise((r, j) => {
      const timer = setTimeout(() => j(new Error(`the app server didn't open the connection within ${CALL_MS} ms`)), CALL_MS)
      ws.addEventListener('open', () => (clearTimeout(timer), r()), { once: true })
      ws.addEventListener('error', () => (clearTimeout(timer), j(new Error('no app server'))), { once: true })
      ws.addEventListener('close', () => (clearTimeout(timer), j(new Error('the app server closed the connection'))), { once: true })
    })
  } catch (e) {
    ws.close()
    throw e
  }
  let n = 0
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(String(m.data))
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg)
      pending.delete(msg.id)
    } else if (msg.method) {
      events.push(msg)
      // Said once in the log, for the spike note: what Codex is about to change (0.164.0 sends one to a joining client).
      const notice = msg.method === 'deprecationNotice' ? JSON.stringify(msg.params) : null
      if (notice && !notices.has(notice)) console.log(`(deprecationNotice: ${notices.add(notice) && notice})`)
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error(`${method}: the connection is closed`))
      const id = ++n
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method}: no answer within ${CALL_MS} ms`))
      }, CALL_MS)
      pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) })
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    await call('initialize', { clientInfo: { name: 'cw-e2e', title: 'Combwork e2e', version: '0' }, capabilities: null })
  } catch (e) {
    ws.close()
    throw e
  }
  ws.send(JSON.stringify({ method: 'initialized' }))
  const seen = (method, pred = () => true, from = 0) => events.slice(from).find((e) => e.method === method && pred(e))
  return { call, events, seen, closed: () => closed, close: () => ws.close() }
}

;(async () => {
  let srv = null
  let ui = null
  let c = null
  let hooks = null
  let skipped = null
  try {
    if (!lib.codexSignedIn()) lib.skip('the Codex test home has no sign-in (tests/e2e/README.md)')
    fs.rmSync(work, { recursive: true, force: true })
    lib.gitProject(work, { 'README.md': '# probe\n' })
    lib.trustForCodex(work, lib.CODEX_HOME)

    // Combwork's hooks as its Codex launch gives them (hookForwardCommand's form, hookHash's trust), to a stand-in.
    const seenHooks = []
    hooks = http.createServer((req, res) => {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => {
        try {
          seenHooks.push(JSON.parse(b).hook_event_name)
        } catch {
          seenHooks.push(null)
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise((r) => hooks.listen(0, '127.0.0.1', r))
    const authFile = path.join(lib.WORK, 'codex-appserver-hook-auth.txt')
    fs.writeFileSync(authFile, 'Authorization: Bearer e2e')
    const command = `curl.exe -s -m 5 -X POST -H "@${authFile.split('\\').join('/')}" -H "Content-Type: application/json" --data-binary "@-" "http://127.0.0.1:${hooks.address().port}/hook"`
    const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v)
    const hash = (label) => 'sha256:' + createHash('sha256').update(JSON.stringify(sortDeep({ event_name: label, hooks: [{ type: 'command', command, timeout: 5, async: false }] }))).digest('hex')
    const flags = 'C:\\<session-flags>\\config.toml'
    const hookArgs = []
    for (const [event] of [['UserPromptSubmit'], ['Stop']]) hookArgs.push('-c', `hooks.${event}=[{hooks=[{type="command",command='${command}',timeout=5}]}]`)
    hookArgs.push('-c', `hooks.state={${['user_prompt_submit', 'stop'].map((l) => `'${flags}:${l}:0:0'={trusted_hash="${hash(l)}"}`).join(',')}}`)

    const port = await freePort()
    srv = appServer(port, hookArgs)
    c = await lib.until(async () => client(port).catch(() => null), HUNG_MS, 300)
    check('the app server listens on its WebSocket, and a client of Combwork\'s initializes', !!c)
    if (!c) throw new Error('no app server')
    // The TUI in read-only, asking before anything else (its own flags set its thread's sandbox and approvals).
    ui = tui(['--remote', `ws://127.0.0.1:${port}`, '-C', work, '-s', 'read-only', '-a', 'on-request'])
    const threadId = await lib.until(async () => ((await c.call('thread/loaded/list', {})).result?.data ?? [])[0], HUNG_MS, 300)
    check('the TUI attached with --remote loads its thread on the app server', !!threadId)
    await ui.ready('after it attached')

    // A step waiting on Codex's model (lib.cliStep). lib's own skip reads a test Combwork's sessions, and this suite starts
    // none: a check failing in a step while Codex waits out a rate limit on the thread (rateLimited) makes the suite a
    // SKIP for the environment instead, as long as nothing failed before it.
    const step = async (name, fn) => {
      const from = Date.now()
      const before = failed
      await lib.cliStep(name, fn)
      const why = failed > before && !before ? rateLimited(threadId, from) : null
      if (why) throw Object.assign(new Error(why), { skip: { why: `environment: ${why} (in "${name}")`, fails: failed - before } })
    }

    await step('a typed first turn, then joining the thread', async () => {
      const early = await c.call('thread/resume', { threadId })
      console.log(`(joining before the first turn: ${early.error?.message ?? 'ok'})`)
      const h0 = seenHooks.length
      await ui.say('Reply with just: one')
      check('the typed turn ends (the thread shows idle)', !!(await lib.until(() => c.seen('thread/status/changed', (e) => e.params.threadId === threadId && e.params.status.type === 'idle'), HUNG_MS)))
      const joined = await c.call('thread/resume', { threadId })
      check('Combwork joins the thread once its first turn is written', !joined.error, JSON.stringify(joined.error))
      check("Combwork's hooks given to the app server run for a typed turn (UserPromptSubmit, Stop)", !!(await lib.until(() => ['UserPromptSubmit', 'Stop'].every((h) => seenHooks.slice(h0).includes(h)), 20000)), JSON.stringify(seenHooks.slice(h0)))
    })

    await step('typed and Combwork turns, identified', async () => {
      const n = c.events.length
      await ui.say('Reply with just: typed')
      const done = await lib.until(() => c.seen('turn/completed', () => true, n), HUNG_MS)
      const typed = c.events.slice(n).find((e) => e.method === 'item/completed' && e.params?.item?.type === 'userMessage')
      check('a typed turn comes as identified turn/started and turn/completed', !!c.seen('turn/started', () => true, n) && !!done?.params?.turn?.id, JSON.stringify({ status: done?.params?.turn?.status, events: methods(c.events.slice(n)) }))
      check("…its user message has the TUI's own clientId", !!typed?.params?.item?.clientId && typed.params.item.clientId !== 'cw-m1', JSON.stringify(typed?.params?.item))
      await ui.ready('after the typed turn')
      // The draft in the prompt before Combwork's turn starts (else a draft arriving late would pass without testing it).
      await ui.typeShown('DRAFT kept')
      const h1 = seenHooks.length
      const m = c.events.length
      const started = await c.call('turn/start', { threadId, clientUserMessageId: 'cw-m1', input: text('[CW] New in your inbox: 1 message (m1). Reply with just: two') })
      const combworkDone = await lib.until(() => c.seen('turn/completed', (e) => e.params.turn.id === started.result?.turn?.id, m), HUNG_MS)
      const own = c.events.slice(m).find((e) => e.method === 'item/completed' && e.params?.item?.type === 'userMessage')
      check('a turn Combwork starts comes as identified turn events too, with the id turn/start answered', !!combworkDone && combworkDone.params.turn.status === 'completed', JSON.stringify(started.error ?? combworkDone?.params?.turn?.status))
      check("…its user message has Combwork's clientUserMessageId", own?.params?.item?.clientId === 'cw-m1', JSON.stringify(own?.params?.item?.clientId))
      check('…the TUI shows it, and the draft the user is typing stays in its prompt', !!(await lib.until(() => /New in your inbox: 1 message \(m1\)/.test(ui.screen()) && /DRAFT kept/.test(ui.screen()), 15000)), ui.screen().split('\n').filter(Boolean).slice(-6).join(' | '))
      check("…and Combwork's hooks run for it too", !!(await lib.until(() => ['UserPromptSubmit', 'Stop'].every((h) => seenHooks.slice(h1).includes(h)), 20000)), JSON.stringify(seenHooks.slice(h1)))
      // Clear the draft (Ctrl+U), as the user would.
      ui.t.write('\x15')
    })

    await step('turn/interrupt', async () => {
      const n = c.events.length
      const long = await c.call('turn/start', { threadId, clientUserMessageId: 'cw-long', input: text('Run this shell command and wait for it: Start-Sleep -Seconds 30. Then reply with just: slept') })
      const id = long.result?.turn?.id
      await lib.until(() => c.seen('item/started', (e) => /command|approval/i.test(JSON.stringify(e.params?.item?.type ?? '')), n) || c.events.slice(n).find((e) => e.id !== undefined), HUNG_MS)
      const intr = await c.call('turn/interrupt', { threadId, turnId: id })
      const ended = await lib.until(() => c.seen('turn/completed', (e) => e.params.turn.id === id, n), HUNG_MS)
      check('turn/interrupt ends a running turn as interrupted', !intr.error && ended?.params?.turn?.status === 'interrupted', JSON.stringify(intr.error ?? ended?.params?.turn?.status))
      await lib.until(() => c.seen('thread/status/changed', (e) => e.params.status.type === 'idle', n), HUNG_MS)
    })

    await step('an approval request', async () => {
      await ui.ready('before the next step')
      const n = c.events.length
      await c.call('turn/start', { threadId, clientUserMessageId: 'cw-approve', input: text('Create a file named approved.txt containing hi in the current folder with a shell command.') })
      const asked = await lib.until(() => c.events.slice(n).find((e) => e.id !== undefined && /requestApproval/.test(e.method)), HUNG_MS)
      check("an approval request reaches Combwork's client", !!asked, JSON.stringify(c.events.slice(n).map((e) => e.method)))
      check('…and the TUI asks it', !!(await lib.until(() => /Would you like to run|Yes, proceed/.test(ui.screen()), 20000)), ui.screen().split('\n').filter(Boolean).slice(-6).join(' | '))
      ui.t.write('\r')
      check("answered in the TUI, Combwork's client sees it resolved", !!(await lib.until(() => c.seen('serverRequest/resolved', () => true, n), 20000)))
      const done = await lib.until(() => c.seen('turn/completed', () => true, n), HUNG_MS)
      check('…and the turn goes on and ends', done?.params?.turn?.status === 'completed' && fs.existsSync(path.join(work, 'approved.txt')), JSON.stringify(done?.params?.turn?.status))
    })

    await step("Combwork's client drops and rejoins", async () => {
      c.close()
      await lib.until(() => c.closed(), 10000)
      c = await client(port)
      const again = await c.call('thread/resume', { threadId })
      console.log(`(rejoining: the thread is ${JSON.stringify(again.result?.thread?.status ?? again.error)})`)
      const n = c.events.length
      const t = await c.call('turn/start', { threadId, clientUserMessageId: 'cw-again', input: text('Reply with just: rejoined') })
      const done = await lib.until(() => c.seen('turn/completed', (e) => e.params.turn.id === t.result?.turn?.id, n), HUNG_MS)
      check('a new connection rejoins the thread and gets its turn events', !again.error && done?.params?.turn?.status === 'completed', JSON.stringify(again.error ?? t.error ?? { status: done?.params?.turn?.status, events: methods(c.events.slice(n)) }))
    })

    await step('resume --remote on a new app server', async () => {
      ui.kill()
      c.close()
      endChildTree(srv)
      const port2 = await freePort()
      srv = appServer(port2, hookArgs)
      c = await lib.until(async () => client(port2).catch(() => null), HUNG_MS, 300)
      // No -s or -a: a remote resume refuses permission overrides (Codex 0.163: "Permission overrides are not supported when
      // resuming a remote task"); the thread keeps the sandbox and approvals it was made with.
      ui = tui(['resume', threadId, '--remote', `ws://127.0.0.1:${port2}`, '-C', work])
      check('`codex resume <id> --remote` brings the thread back, with its history', !!(await lib.until(() => /rejoined/.test(ui.screen()), HUNG_MS, 300)), ui.screen().split('\n').filter(Boolean).slice(-6).join(' | '))
      const joined = await c.call('thread/resume', { threadId })
      const n = c.events.length
      await ui.ready('before the next step')
      await ui.say('Reply with just: resumed')
      const done = await lib.until(() => c.seen('turn/completed', () => true, n), HUNG_MS)
      check('…and Combwork joins it again and gets its turns', !joined.error && done?.params?.turn?.status === 'completed', JSON.stringify(joined.error ?? { status: done?.params?.turn?.status, events: methods(c.events.slice(n)), screen: tail(ui.screen()) }))
    })
  } catch (e) {
    if (e.skip) skipped = e.skip
    else check('no error', false, e.stack)
  } finally {
    try {
      c?.close()
    } catch {}
    try {
      ui?.kill()
    } catch {}
    if (srv) endChildTree(srv)
    hooks?.close()
  }
  // A skip, as lib.cliStep says one: the runner takes it only if no other check failed (SKIPPED-FAILS).
  if (skipped) console.log(`SKIPPED ${skipped.why}\nSKIPPED-FAILS ${skipped.fails}`)
  else console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  // A ConPTY terminal just killed holds the process if it exits at once: given a moment to close first.
  setTimeout(() => process.exit(failed && !skipped ? 1 : 0), 2000) // on purpose: the terminal's close, not a check
})()
