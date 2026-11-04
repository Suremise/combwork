// A stand-in for Codex in end-to-end tests: Hive launches it through its real Codex adapter (Settings → Codex →
// path = fake-codex.cmd), so who is asked (an approval, a question, the auto-reviewer) is tested without signing
// in or spending tokens. It sends the hooks, in the order, and sets the terminal title the way Codex 0.160.0 did
// (tests/hookStatus.test.ts has the sequences):
// - `--version`, `login status` and the app server (hooks/list, account/read) answer as a signed-in Codex; in a
//   connection's folder (HI-1757), `login` signs it in and account/read says who, signed out until then. With fake-busy
//   there, every run in it writes there all the time, as Codex's databases do (HI-1873).
// - It titles its terminal "<project>", and "[ ! ] Action Required | <project>" (blinking with "[ . ]") while a
//   person must act: one title for everything asked. It sends SessionStart with the first prompt, as Codex does.
// - Prompts, typed and sent with Enter:
//   "review allow" / "review deny": a command its auto-reviewer approves (it runs) or denies (it doesn't, and
//   another command runs next). PermissionRequest comes either way; nobody is asked. "review long": a long
//   PowerShell command (an environment variable, a path) under review for 4 s, then approved.
//   "approve": the request is put to you: "y" approves it (another command ends beside it first), Esc rejects
//   it (the turn is interrupted).
//   "question": an async question (request_user_input_async): it works on meanwhile; "a" answers it, which it
//   waits for at the end of the turn. "late question": its hooks reach Hive after its title.
//   "hold": waits for "g" before its next step, so a test can wait until Hive has taken the steps before (#329).
//   Steps combine with " then " ("question then review deny").
//   The scenarios' steps, as the fake Claude Code takes them: "skill NAME" (a shell read of its SKILL.md),
//   "boardmove", "boardreview", "boardcomment" and "hive TOOL {json}" (through the launch's real hive MCP server),
//   "work N" and "shell: <command line>" (run in cmd with the session's environment, between its PreToolUse and
//   PostToolUse; fake-shell.jsonl in CODEX_HOME records it, #1486). "planusage F W": its rollout's rate limits, F% of
//   the 5-hour window and W% of the weekly one (HI-1882). "patch FILE" (HI-2386): an apply_patch edit of FILE, which
//   Hive's file lock may refuse (fake-edits.jsonl in CODEX_HOME records each try). Anything else: a short turn.
//   The turn ledger's cases (#648): "latetool" (a command whose PostToolUse reaches Hive after the turn's Stop),
//   "loststop" (no Stop reaches Hive; its rollout records the turn's end, task_complete) and "silent" (neither).
//   "ratelimited" (HI-1972): a 429 recorded only in its log database (logs_2.sqlite), then no hook until
//   fake-retried-<agent> is in CODEX_HOME.
//   Notices (#650), as Codex 0.162.1 takes them: context in a PostToolUse reply reaches "the model", and a Stop blocked
//   carries the same turn on to another Stop with stop_hook_active. Each ("[CW] …") is logged in fake-notices.jsonl in
//   CODEX_HOME; with fake-follow-notices.txt (or fake-follow-notices-<agent>.txt) there, it reads its inbox (cw_inbox)
//   and acks what it listed. "checkpoint": a command (PreToolUse, PostToolUse) whose reply it reads. Hive's doorbell
//   ("[CW] New in your inbox: …") it follows as a model does: it reads its inbox; new work it read (a task, a
//   handover) is its prompt, anything else (a wake, a message) is logged in fake-wakes.jsonl in CODEX_HOME, with the
//   doorbell's line as it was sent (`doorbell`, HI-1974).
// - Each prompt is a turn with its own id, which its hooks carry (turn_id) and its rollout records (task_started,
//   task_complete after Stop), as Codex 0.162.1 does.
// - With fake-code-mode.txt in CODEX_HOME (the scenarios', HI-2235) it works in code mode, as Codex 0.166.0 does: its
//   hive calls and skill reads are each made from a script (exec), its rollout recording each call the script made.
// - It connects the launch's hive MCP server as it starts (#865: the real server, which tells Hive it has connected).
// - A first prompt as its last plain argument (after "resume <id>" too) is its first turn, as Codex starts on one.
// - Ctrl+C twice ends it with SessionEnd.
// - While fake-nohooks-<agent> is in CODEX_HOME it sends no hook at all, as when a Codex update broke them (#1336). A
//   wake it read is answered with the next line of fake-wakes-<agent>.txt there, when there is one. With
//   FAKE_CODEX_VERSION 0.162.1 or later, a turn draws Codex's Working line as it begins.
// - "selfcompact" (HI-1916): a compaction it begins itself (PreCompact, PostCompact), then the turn under the same turn_id,
//   as Codex 0.164.0 did.
// - "compacting N" (#1514): a turn that compacts its conversation for N seconds first, as Codex's auto-compaction does
//   at a turn's start, sending no hook meanwhile (no UserPromptSubmit: Hive sees no prompt, as with RR2 on 23 Oct). With
//   fake-queue-<agent> in CODEX_HOME, a line typed while a turn runs is queued (as Codex queues input) and taken in the
//   same turn once it has compacted: recorded as a user message, with no UserPromptSubmit; a doorbell read as above.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { spawn } = require('child_process')
const { callHiveTool, connectHive, fromCodexTable, parseHiveStep, isDoorbell, doorbellIsWork, inboxRows } = require('../fake-bridge.cjs')

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION || '0.160.0'}`)
  process.exit(0)
}
if (args[0] === 'debug' && args[1] === 'models') {
  // Codex 0.160's recorded catalog (tests/fixtures/codex-debug-models.json), as Hive asks for its models (#125).
  process.stdout.write(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'codex-debug-models.json'), 'utf8'))
  process.exit(0)
}
// A connection's folder (HI-1757: a CODEX_HOME in an accounts folder): `login` signs it in as fake-login-as.json beside
// the accounts folder says ({ email, plan }), writing fake-account.json and auth.json (as a sign-in writes it), with no
// browser; the app server's account/read answers from fake-account.json, signed out (account null) without one.
const connectionHome = process.env.CODEX_HOME || ''
const inConnection = !!connectionHome && path.basename(path.dirname(connectionHome)).toLowerCase() === 'accounts'
const connectionAccount = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(connectionHome, 'fake-account.json'), 'utf8'))
  } catch {
    return null
  }
}
if (args[0] === 'login' && inConnection && args[1] !== 'status') {
  let as = { email: 'fake@example.com', plan: 'plus' }
  try {
    as = JSON.parse(fs.readFileSync(path.join(connectionHome, '..', 'fake-login-as.json'), 'utf8'))
  } catch {
    // The default identity.
  }
  console.log('Opening the browser to sign in… (the fake opens none)')
  fs.writeFileSync(path.join(connectionHome, 'fake-account.json'), JSON.stringify(as))
  fs.writeFileSync(path.join(connectionHome, 'auth.json'), '{"fake":true}')
  console.log('Successfully logged in')
  process.stdout.write('', () => process.exit(0))
  return
}
if (args[0] === 'login') {
  console.log('Logged in using ChatGPT')
  process.exit(0)
}
// Started plainly in a connection's folder (HI-1870: its Set Up, no agent's, with only `-c` overrides: HI-1893) with no
// sandbox there or given: its one-time Windows sandbox setup, answered at once (the non-admin one), written to the
// folder's config.toml as Codex keeps it.
const setUpRun = inConnection && !process.env.CW_AGENT && args.length % 2 === 0 && args.every((a, i) => i % 2 === 1 || a === '-c')
if (setUpRun) {
  const toml = path.join(connectionHome, 'config.toml')
  const now = fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : ''
  let next = now
  if (!/^\s*sandbox\s*=/m.test(next) && !args.some((a) => a.startsWith('windows.sandbox='))) next = `${next}${next && !next.endsWith('\n') ? '\n' : ''}[windows]\nsandbox = "unelevated"\n`
  // Run in a project's folder (HI-1870: Set Up opened where it isn't trusted yet): its trust question answered Yes, for
  // the folder's real path, as Codex records it (the suites' projects are their repositories' roots).
  const cwd = fs.realpathSync.native(process.cwd())
  if (path.relative(connectionHome, cwd).startsWith('..') && !next.includes(`[projects.'${cwd}']`)) next += `\n[projects.'${cwd}']\ntrust_level = "trusted"\n`
  if (next !== now) fs.writeFileSync(toml, next)
}
// A busy connection (HI-1873): while fake-busy is in a connection's folder, each run there (an agent, and Hive's own
// check's app server) writes at its top level as Codex's databases and logs do, in bursts, making and deleting a journal,
// so Windows reports some of it with no file name. Its login file is never touched.
if (inConnection) {
  setInterval(() => {
    if (!fs.existsSync(path.join(connectionHome, 'fake-busy'))) return
    const wal = path.join(connectionHome, `logs_2.sqlite-wal-${process.pid}`)
    for (let i = 0; i < 200; i++) fs.appendFileSync(wal, 'x')
    const journal = path.join(connectionHome, `state_5.sqlite-journal-${process.pid}`)
    fs.writeFileSync(journal, 'j')
    fs.rmSync(journal, { force: true })
  }, 500).unref()
}
if (args[0] === 'app-server') {
  // Hive asks how this version names and hashes its hooks (none), or who its connection's folder is signed in as. Its
  // pid goes to FAKE_CODEX_APPSERVER_LOG when a suite names one (HI-1757: none may be left running); its arguments to
  // fake-appservers.jsonl in a connection's folder (HI-1893: the sandbox its checks are given).
  if (process.env.FAKE_CODEX_APPSERVER_LOG) fs.appendFileSync(process.env.FAKE_CODEX_APPSERVER_LOG, `${process.pid}\n`)
  if (inConnection) fs.appendFileSync(path.join(connectionHome, 'fake-appservers.jsonl'), JSON.stringify({ args }) + '\n')
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
      else if (m.method === 'account/read') {
        const a = inConnection ? connectionAccount() : { email: 'fake@example.com', plan: 'plus' }
        process.stdout.write(JSON.stringify({ id: m.id, result: { account: a ? { type: 'chatgpt', email: a.email, planType: a.plan } : null, requiresOpenaiAuth: true, workspaceRouting: null } }) + '\n')
      } else if (m.method && m.method !== 'hooks/list' && m.method !== 'initialized') {
        // A request it doesn't know (an advanced setting naming another, HI-982), answered as Codex's app server does.
        process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: `unknown method: ${m.method}` } }) + '\n')
      } else if (m.method === 'hooks/list' && process.env.CODEX_HOME && fs.existsSync(path.join(process.env.CODEX_HOME, 'fake-hooks-list-hang.txt'))) {
        // No answer while fake-hooks-list-hang.txt is there (HI-982: Hive's listing timeout).
      } else if (m.method === 'hooks/list' && process.env.CODEX_HOME && fs.existsSync(path.join(process.env.CODEX_HOME, 'fake-hooks-list.json'))) {
        // A suite's hooks (HI-982: hooksview): those of fake-hooks-list.json, after the -c hooks.<event> it was given,
        // listed as Codex 0.164 lists the session flags' (codexownhooks pins the fields), trusted.
        const own = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'fake-hooks-list.json'), 'utf8'))
        const flags = []
        for (let k = 1; k < args.length; k++) {
          const c = args[k - 1] === '-c' && /^hooks\.([A-Za-z]+)=/.exec(args[k])
          const command = c && /command\s*=\s*("(?:[^"\\]|\\.)*")/.exec(args[k])
          if (command) flags.push({ key: `C:\\<session-flags>\\config.toml:${c[1].replace(/[A-Z]/g, (x, at) => (at ? '_' : '') + x.toLowerCase())}:0:0`, source: 'sessionFlags', command: JSON.parse(command[1]), trustStatus: 'trusted', currentHash: 'sha256:fake' })
        }
        process.stdout.write(JSON.stringify({ id: m.id, result: { data: [{ hooks: [...flags, ...own] }] } }) + '\n')
      } else if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { data: [] } }) + '\n')
    }
  })
  // As Codex does: its stdin closed, it ends.
  process.stdin.on('end', () => process.exit(0))
  return
}

// `[options] debug prompt-input` (#1285): the session's prompt as Codex renders it, offline. Its developer message is
// fake-developer-instructions.txt in CODEX_HOME (standing for whatever layers Codex took them from), or the last
// -c/--config developer_instructions=<TOML string> in the options (as Codex takes them: the last wins, "" clears
// them), then Codex's own texts; "!fail" exits with an error. Each run's options go in fake-prompt-input.jsonl, so a
// test sees Hive passed the agent's own arguments untouched.
const debugAt = args.indexOf('debug')
if (debugAt >= 0 && args[debugAt + 1] === 'prompt-input') {
  const opts = args.slice(0, debugAt)
  const home = process.env.CODEX_HOME
  if (home) fs.appendFileSync(path.join(home, 'fake-prompt-input.jsonl'), JSON.stringify({ cwd: process.cwd(), args: opts }) + '\n')
  const file = home && path.join(home, 'fake-developer-instructions.txt')
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (text === '!fail') {
    process.stderr.write('Error: config unreadable\n')
    process.exit(1)
  }
  let value = text
  for (let i = 1; i < opts.length; i++) {
    if ((opts[i - 1] === '-c' || opts[i - 1] === '--config') && opts[i].startsWith('developer_instructions=')) value = JSON.parse(opts[i].slice('developer_instructions='.length))
  }
  const content = [...(value !== null && value.trim() ? [value] : []), '<skills_instructions>\n## Skills', '<permissions instructions>\nFilesystem sandboxing']
  process.stdout.write(JSON.stringify([{ type: 'message', role: 'developer', content: content.map((t) => ({ type: 'input_text', text: t })) }, { type: 'message', role: 'user', content: [] }]))
  return
}

// Each launch is recorded in fake-launches.jsonl in CODEX_HOME: its folder and arguments (for what Hive tells it).
// With its home, agent, and the names (never the values) of the login variables it was given (HI-1757).
const loginVars = Object.keys(process.env).filter((k) => /^(CODEX_ACCESS_TOKEN|CODEX_API_KEY|OPENAI_API_KEY)$/i.test(k))
if (process.env.CODEX_HOME) fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-launches.jsonl'), JSON.stringify({ cwd: process.cwd(), args, home: process.env.CODEX_HOME, agent: process.env.CW_AGENT || null, loginVars, temp: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(TEMP|TMP|TMPDIR)$/i.test(k))) }) + '\n')

const hookUrl = /(http:\/\/127\.0\.0\.1:\d+\/hook\?run=[\w-]+)/.exec(args.find((a) => a.startsWith('hooks.Stop=')) ?? '')?.[1]
// Codex runs Hive's hook command, whose curl reads the Authorization header from the launch's auth file (#345).
const authFile = /-H \\?"@([^"\\]+)\\?"/.exec(args.find((a) => a.startsWith('hooks.Stop=')) ?? '')?.[1]
const authHeader = () => {
  try {
    return fs.readFileSync(authFile, 'utf8').replace(/^Authorization:\s*/i, '').trim()
  } catch {
    return ''
  }
}
const project = path.basename(process.cwd())
// "resume <id>" carries on that conversation, as Codex does; otherwise a new one.
const resuming = args[0] === 'resume' && /^[0-9a-f-]{36}$/i.test(args[1] ?? '')
const sessionId = resuming ? args[1] : randomUUID()
// Options that take a value, so a first prompt (the last plain argument, as Hive's adapter gives one) can be told apart.
const WITH_VALUE = new Set(['-c', '--config', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '-p', '--profile', '-i', '--image', '--add-dir'])
let firstPrompt = ''
for (let i = resuming ? 2 : 0; i < args.length; i++) {
  if (WITH_VALUE.has(args[i])) i++
  else if (!args[i].startsWith('-')) firstPrompt = args[i]
}
/**
 * The terminal's size, recorded in fake-sizes.jsonl in its home at the start and at each change (#247): what Hive tells
 * the CLI. Polled as well as on 'resize', which a ConPTY child doesn't always get.
 */
function recordSizes(dir, id) {
  if (!dir || !process.stdout.isTTY) return
  let last = ''
  const note = () => {
    const s = []
    if (process.stdout._handle?.getWindowSize?.(s) !== 0 || s.length < 2) return
    const [cols, rows] = s
    if (`${cols}x${rows}` === last) return
    last = `${cols}x${rows}`
    fs.appendFileSync(path.join(dir, 'fake-sizes.jsonl'), JSON.stringify({ sessionId: id, cols, rows, at: Date.now() }) + '\n')
  }
  note()
  process.stdout.on('resize', note)
  setInterval(note, 50).unref()
}
recordSizes(process.env.CODEX_HOME, sessionId)

/**
 * Its rollout, as Codex keeps one: CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, its first line the
 * session_meta (id, cwd). Written with the first prompt (when Codex starts recording); a resumed one is appended to.
 */
function rolloutPath() {
  const root = path.join(process.env.CODEX_HOME || '.', 'sessions')
  const find = (dir, depth) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const f = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) {
        const hit = find(f, depth + 1)
        if (hit) return hit
      } else if (e.name.endsWith(`-${sessionId}.jsonl`)) return f
    }
    return null
  }
  const existing = find(root, 0)
  if (existing) return existing
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const dir = path.join(root, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${sessionId}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ timestamp: now.toISOString(), type: 'session_meta', payload: { id: sessionId, cwd: process.cwd(), timestamp: now.toISOString() } }) + '\n')
  // Hive's instructions (-c developer_instructions=…), recorded as the developer message Codex starts its rollout with.
  const given = args.find((a, i) => args[i - 1] === '-c' && a.startsWith('developer_instructions='))
  if (given) fs.appendFileSync(file, JSON.stringify({ timestamp: now.toISOString(), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: JSON.parse(given.slice('developer_instructions='.length)) }] } }) + '\n')
  return file
}
let rollout = null
let started = false

const out = (s) => process.stdout.write(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const setTitle = (t) => out(`\x1b]0;${t}\x07`)

/** The turn under way: each prompt's own id, which its hooks carry (turn_id), as Codex 0.162.1's do. */
let turnId = null

/**
 * Its hooks are off (#1336): while fake-nohooks-<agent> is in CODEX_HOME (read at each hook), no hook is sent; it works
 * on as before.
 */
const hooksOff = () => !!process.env.CODEX_HOME && fs.existsSync(path.join(process.env.CODEX_HOME, `fake-nohooks-${String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')}`))

/** Sends a hook as Codex's curl command does; Hive's reply (JSON), or null. */
async function hook(event, extra = {}) {
  if (!hookUrl || hooksOff()) return null
  const res = await fetch(hookUrl, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: rollout, cwd: process.cwd(), model: 'gpt-fake', permission_mode: 'default', ...(turnId && event !== 'SessionStart' && event !== 'SessionEnd' ? { turn_id: turnId } : {}), ...extra })
  }).catch(() => null)
  return res ? await res.json().catch(() => null) : null
}

/** Hive's notice in a hook's reply (#650: context after a tool call, a block's reason at Stop), logged in fake-notices.jsonl; null when none. */
function noticeIn(reply, at) {
  const text = reply?.hookSpecificOutput?.additionalContext ?? (reply?.decision === 'block' ? reply.reason : null)
  if (typeof text !== 'string' || !text.startsWith('[CW]') || !process.env.CODEX_HOME) return null
  const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
  fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-notices.jsonl'), JSON.stringify({ agent, at, text, when: new Date().toISOString() }) + '\n')
  return text
}

/** Whether this agent follows Hive's notices (fake-follow-notices.txt in CODEX_HOME, or its own fake-follow-notices-<agent>.txt). */
function followsNotices() {
  const home = process.env.CODEX_HOME
  const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
  return !!home && (fs.existsSync(path.join(home, 'fake-follow-notices.txt')) || fs.existsSync(path.join(home, `fake-follow-notices-${agent}.txt`)))
}

/** Acts on a notice as a model that follows them: reads its inbox (cw_inbox), then acks the ids it listed. */
async function readInbox() {
  const listed = await hiveCall('cw_inbox', {})
  const ids = [...new Set([...String(listed?.text ?? '').matchAll(/\bm\d+\b/g)].map((m) => m[0]))]
  if (ids.length) await hiveCall('cw_inbox', { ack: ids })
}

/** Codex's own record of a turn starting or ending (task_started, task_complete), by its turn id. */
const turnRecord = (type) => fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, turn_id: turnId } }) + '\n')

/** How many things a person is asked now: one title for them all, "[ ! ] Action Required" blinking as Codex's does. */
let asking = 0
let blink = null
function asked(delta) {
  asking += delta
  clearInterval(blink)
  if (asking <= 0) return setTitle(project)
  let on = true
  setTitle(`[ ! ] Action Required | ${project}`)
  blink = setInterval(() => {
    on = !on
    setTitle(`[ ${on ? '!' : '.'} ] Action Required | ${project}`)
  }, 500)
}

/** The next key typed (one of `keys`). */
let onKey = null
const key = (keys) => new Promise((r) => (onKey = (k) => keys.includes(k) && (onKey = null, r(k), true)))

const CURL = { tool_name: 'Bash', tool_input: { command: 'curl.exe https://example.com' } }
// Codex adds a description to the request's input.
const CURL_REQUEST = { ...CURL, tool_input: { ...CURL.tool_input, description: 'Check the network' } }
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })
let busy = false

/** A long command, the kind that used to fill an agent's header while under review. */
const LONG = bash("$env:HIVE_E2E_DIR = 'C:\\Users\\someone\\AppData\\Local\\hive-test\\e2e'; npm.cmd run e2e -- icons bell resumeall --reporter verbose")

/** A permission request its auto-reviewer answers: nobody is asked, and the title doesn't change. */
async function review(allow, call = CURL, ms = 1500) {
  await hook('PreToolUse', call)
  await hook('PermissionRequest', call === CURL ? CURL_REQUEST : call)
  out('  Reviewing the request…\r\n')
  await sleep(ms)
  if (allow) return hook('PostToolUse', call)
  out('  Rejected by the auto-reviewer.\r\n')
  await hook('PreToolUse', bash('ls'))
  await hook('PostToolUse', bash('ls'))
}

/** A permission request put to you: true when approved ("y"), false when rejected (Esc). */
async function approve() {
  await hook('PreToolUse', CURL)
  await hook('PermissionRequest', CURL_REQUEST)
  out('  Would you like to run the following command?\r\n  $ curl.exe https://example.com\r\n  1. Yes, proceed (y)   3. No (esc)\r\n')
  asked(1)
  const k = await key(['y', '\x1b'])
  asked(-1)
  if (k === '\x1b') return false
  // Another command, run beside it, ends first.
  await hook('PreToolUse', bash('ls'))
  await hook('PostToolUse', bash('ls'))
  await hook('PostToolUse', CURL)
  return true
}

/** An async question: it returns at once, and Codex works on. `late`: its hooks reach Hive after the title. */
async function question(late) {
  const input = { questions: [{ title: 'Which colour?', options: ['Red', 'Blue'] }] }
  if (late) asked(1)
  if (late) await sleep(400)
  await hook('PreToolUse', { tool_name: 'request_user_input_async', tool_input: input })
  await hook('PostToolUse', { tool_name: 'request_user_input_async', tool_input: input })
  out('  Which colour? • Red • Blue\r\n  ? 1 question  (a to answer)\r\n')
  if (!late) asked(1)
}

/** One rollout entry, as Codex writes it. */
const record = (payload) => fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload }) + '\n')

/** The launch's hive MCP server (its -c mcp_servers.combwork table), or null. */
function hiveServer() {
  const arg = args.find((a) => a.startsWith('mcp_servers.combwork='))
  try {
    return arg ? fromCodexTable(arg.slice('mcp_servers.combwork='.length)) : null
  } catch {
    return null
  }
}

/**
 * Code mode (HI-2235), with fake-code-mode.txt in CODEX_HOME, as Codex 0.166.0 works: each call is made from a script
 * (its exec tool, `code`), which the rollout records, then each call the script made as it ends (an item_completed
 * event, from `run`'s `done`), then what the script printed (what `run` returns).
 */
const codeMode = () => !!process.env.CODEX_HOME && fs.existsSync(path.join(process.env.CODEX_HOME, 'fake-code-mode.txt'))
async function inScript(code, run) {
  const id = `call_${randomUUID().slice(0, 8)}`
  record({ type: 'custom_tool_call', name: 'exec', input: code, call_id: id })
  // With its start (started_at_ms), as Codex 0.166 records a call: Hive gives a call to the script it started in (HI-2240).
  const done = (item) => fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { id: `exec-${randomUUID()}`, ...item }, started_at_ms: Date.now() } }) + '\n')
  const printed = await run(done)
  record({ type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: printed }] })
}

/** A shell command that reads a file, recorded as Codex records it: a shell call, or in code mode a script's exec_command. */
function readFile(file) {
  const cmd = `Get-Content -Raw '${file}'`
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (codeMode()) {
    return inScript(`text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}));`, (done) => {
      done({ type: 'CommandExecution', command: ['powershell', '-Command', cmd], status: text === null ? 'failed' : 'completed', aggregated_output: text ?? 'Get-Content: no such file', exit_code: text === null ? 1 : 0 })
      return JSON.stringify({ exit_code: text === null ? 1 : 0, output: text ?? 'Get-Content: no such file' })
    })
  }
  const id = `call_${randomUUID().slice(0, 8)}`
  record({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['powershell', '-Command', cmd] }), call_id: id })
  record({ type: 'function_call_output', call_id: id, output: text ?? 'Process exited with code 1: no such file' })
}

/** A hive tool call through the launch's own hive MCP server, recorded as Codex records an MCP call and its output. */
async function hiveCall(tool, input) {
  const server = hiveServer()
  if (codeMode()) {
    let r = null
    await inScript(`text(await tools.mcp__combwork__${tool}(${JSON.stringify(input)}));`, async (done) => {
      r = server ? await callHiveTool(server, tool, input) : { text: 'error: no hive server', isError: true }
      const result = { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) }
      done({ type: 'McpToolCall', server: 'hive', tool, arguments: input, status: r.isError ? 'failed' : 'completed', result })
      return JSON.stringify(result)
    })
    return r
  }
  const id = `call_${randomUUID().slice(0, 8)}`
  record({ type: 'function_call', name: `mcp__combwork__${tool}`, arguments: JSON.stringify(input), call_id: id })
  const r = server ? await callHiveTool(server, tool, input) : { text: 'error: no hive server', isError: true }
  record({ type: 'function_call_output', call_id: id, output: r.isError && !/^error/i.test(r.text) ? `error: ${r.text}` : r.text })
  return r
}

/** Reads a skill as Codex does: its SKILL.md from the folder Hive delivered it to, with a shell command. */
function readSkill(name) {
  const dir = path.join(process.cwd(), '.agents', 'skills')
  const folder = [name, `cw-${name}`].map((d) => path.join(dir, d, 'SKILL.md')).find((f) => fs.existsSync(f)) ?? path.join(dir, name, 'SKILL.md')
  return readFile(folder)
}

/**
 * Follows a skill's link to one of its reference files (HI-2011), as Codex does: the link found in the delivered
 * SKILL.md (its copy in .agents/skills), resolved against that folder, and the file read with a shell command.
 */
function readSkillRef(name, file) {
  const dir = [name, `cw-${name}`].map((d) => path.join(process.cwd(), '.agents', 'skills', d)).find((d) => fs.existsSync(path.join(d, 'SKILL.md'))) ?? path.join(process.cwd(), '.agents', 'skills', name)
  const skill = fs.existsSync(path.join(dir, 'SKILL.md')) ? fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') : ''
  const target = skill.includes(`](${file})`) || skill.includes(`](./${file})`) ? path.resolve(dir, file) : path.join(dir, `no-link-to-${file}`)
  return readFile(target)
}

/**
 * The scenario steps the fake Claude Code takes too (tests/scenarios): "skill NAME", "boardmove N COLUMN", "boardreview N
 * ACTION [COLUMN]", "boardcomment N", "hive TOOL {json}" and "work N". Board changes go through the real hive MCP
 * server (cw_update_task), as a model's would. Whether the step was one of these.
 */
async function scripted(step) {
  let any = false
  for (const m of step.matchAll(/\bskill\s+([a-z0-9][\w-]*)/gi)) {
    await readSkill(m[1])
    any = true
  }
  for (const m of step.matchAll(/\bskillref\s+([a-z0-9][\w-]*)\s+([\w.-]+\.md)/gi)) {
    await readSkillRef(m[1], m[2])
    any = true
  }
  const move = /\bboardmove\s+(\d+)\s+(\w+)/i.exec(step)
  if (move) await hiveCall('cw_update_task', { number: Number(move[1]), column: move[2].toLowerCase() })
  const rev = /\bboardreview\s+(\d+)\s+(\w+)(?:\s+(hold|todo|doing|review|passed|done)\b)?/i.exec(step)
  if (rev) await hiveCall('cw_update_task', { number: Number(rev[1]), review: rev[2].toLowerCase(), ...(rev[3] ? { column: rev[3].toLowerCase(), comment: 'Fake review: passed.' } : {}) })
  const comment = /\bboardcomment\s+(\d+)/i.exec(step)
  if (comment) await hiveCall('cw_update_task', { number: Number(comment[1]), comment: 'Fake: done, see the files.' })
  const call = parseHiveStep(step)
  if (call) await hiveCall(call.tool, call.args)
  const pause = /\bwork\s+(\d+)/i.exec(step)
  if (pause) await sleep(Number(pause[1]) * 1000)
  // "checkpoint": a command of its own, whose PostToolUse reply may carry Hive's notice (#650).
  const check = /\bcheckpoint\b/i.test(step)
  if (check) {
    const c = { ...bash('ls'), tool_use_id: `exec-${randomUUID()}` }
    await hook('PreToolUse', c)
    if (noticeIn(await hook('PostToolUse', c), 'checkpoint') && followsNotices()) await readInbox()
  }
  // "shell: <command line>": runs it in cmd as its shell tool would, reported by its hooks (#1486: a scenario's commit).
  const sh = /\bshell:\s*(.+)$/i.exec(step)
  if (sh) {
    const c = { ...bash(sh[1].trim()), tool_use_id: `exec-${randomUUID()}` }
    await hook('PreToolUse', c)
    await shellRun(sh[1].trim())
    await hook('PostToolUse', c)
  }
  // "planusage F W": a token_count record with its plan's rate limits, as Codex writes one after each request (HI-1882):
  // F% of the 5-hour window and W% of the weekly one, each resetting in a few hours.
  const plan = /\bplanusage\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i.exec(step)
  if (plan) {
    const resets = Math.floor(Date.now() / 1000) + 3 * 3600
    const rateLimits = { primary: { used_percent: Number(plan[1]), window_minutes: 300, resets_at: resets }, secondary: { used_percent: Number(plan[2]), window_minutes: 10080, resets_at: resets }, plan_type: 'plus' }
    fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits } }) + '\n')
  }
  // "patch FILE" (HI-2386): an apply_patch edit appending a line to FILE (in its folder), which Codex asks Hive about first;
  // refused (Hive's file lock), the file is left alone. Each try goes in fake-edits.jsonl: allowed or not, and why.
  const edit = /\bpatch\s+([\w.-]+)/i.exec(step)
  if (edit) {
    const c = { tool_name: 'apply_patch', tool_use_id: `patch-${randomUUID()}`, tool_input: { command: `*** Begin Patch\n*** Update File: ${edit[1]}\n@@\n+edited\n*** End Patch` } }
    const reply = await hook('PreToolUse', c)
    const refused = reply?.hookSpecificOutput?.permissionDecision === 'deny' ? String(reply.hookSpecificOutput.permissionDecisionReason ?? '') : null
    if (refused === null) {
      fs.appendFileSync(path.join(process.cwd(), edit[1]), `edited by ${process.env.CW_AGENT || 'agent'}\n`)
      await hook('PostToolUse', c)
    }
    const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
    if (process.env.CODEX_HOME) fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-edits.jsonl'), JSON.stringify({ agent, file: edit[1], allowed: refused === null, reason: refused, at: new Date().toISOString() }) + '\n')
  }
  return any || !!(move || rev || comment || call || pause || check || sh || plan || edit)
}

/** A shell step's command, in cmd with the session's environment; the agent, command, exit code and output go to fake-shell.jsonl. */
function shellRun(cmd) {
  return new Promise((resolve) => {
    const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { cwd: process.cwd(), env: process.env, windowsVerbatimArguments: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('close', (code) => {
      if (process.env.CODEX_HOME) fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-shell.jsonl'), JSON.stringify({ agent: process.env.CW_AGENT || 'agent', cmd, code, stdout, stderr }) + '\n')
      resolve()
    })
  })
}

/**
 * What it does after a wake it read (#1336), as the fake Claude Code does: the next line of fake-wakes-<agent>.txt in
 * CODEX_HOME (taken), or null with none.
 */
function nextScripted() {
  if (!process.env.CODEX_HOME) return null
  const file = path.join(process.env.CODEX_HOME, `fake-wakes-${String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')}.txt`)
  if (!fs.existsSync(file)) return null
  const [first, ...rest] = fs.readFileSync(file, 'utf8').split('\n')
  fs.writeFileSync(file, rest.join('\n'))
  return first.trim() || null
}

/**
 * "ratelimited" (HI-1972): its model request refused with a 429, as Codex 0.164.0 records it, only in its log database
 * (logs_2.sqlite in CODEX_HOME: "retrying sampling request (1/5 in 400s)… last status: 429"), sending no hook. It waits,
 * as Codex does for its retry, until fake-retried-<agent> is in CODEX_HOME (taken), then goes on with its turn.
 */
async function rateLimited() {
  const home = process.env.CODEX_HOME
  if (!home) return
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(home, 'logs_2.sqlite'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC)')
    const now = Date.now()
    db.prepare("INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid) VALUES (?, ?, 'WARN', 'codex_core::responses_retry', ?, ?, ?)").run(Math.floor(now / 1000), (now % 1000) * 1e6, `session_loop{thread_id=${sessionId}}: stream disconnected - retrying sampling request (1/5 in 399.9997619s)... turn_id=${turnId} retries=1 max_retries=5 sampling_error=exceeded retry limit, last status: 429 Too Many Requests`, sessionId, `pid:${process.pid}:fake`)
  } finally {
    db.close()
  }
  const go = path.join(home, `fake-retried-${String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')}`)
  while (!fs.existsSync(go)) await sleep(100)
  fs.rmSync(go, { force: true })
}

/** Whether a line typed while a turn runs is queued and taken in it (fake-queue-<agent> in CODEX_HOME, #1514). */
function queues() {
  const home = process.env.CODEX_HOME
  return !!home && fs.existsSync(path.join(home, `fake-queue-${String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')}`))
}
/** Lines typed while a turn ran, queued for it (#1514). */
const queued = []

/** A user line as Codex records it: the message and the turn's item (#1371). */
function userLine(text) {
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n')
  // Its prompt as a turn's item, with the turn's id, as 0.159 records it (#1371: how Hive tells the person's turns).
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'text', text }] } } }) + '\n')
}

/** The queued lines, taken in the running turn with no UserPromptSubmit (#1514); a doorbell's inbox read and logged. */
async function takeQueued() {
  while (queued.length) {
    const text = queued.shift()
    userLine(text)
    if (!isDoorbell(text)) continue
    const r = await hiveCall('cw_inbox', {})
    const rows = r.isError ? [] : inboxRows(r.text)
    if (rows.length && followsNotices()) await hiveCall('cw_inbox', { ack: rows.flatMap((x) => x.ids) })
    if (process.env.CODEX_HOME) fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-wakes.jsonl'), JSON.stringify({ agent: String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_'), text: rows.map((x) => x.text).join(' '), at: new Date().toISOString(), queued: true }) + '\n')
  }
}

/** A prompt: its steps, separated by " then " ("question then review allow"). */
async function runPrompt(text) {
  busy = true
  out(`\r\n› ${text}\r\n`)
  if (!started) {
    started = true
    rollout = rolloutPath()
    await hook('SessionStart', { source: resuming ? 'resume' : 'startup' })
  }
  turnId = randomUUID()
  turnRecord('task_started')
  // Compacting first (#1514): no hook meanwhile, then what was queued is taken in this turn.
  const compacting = /^compacting (\d+)\b/.exec(text)
  if (compacting) {
    await sleep(Number(compacting[1]) * 1000)
    fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'compacted', payload: { message: '' } }) + '\n')
    userLine(text)
    await takeQueued()
  } else {
    // "selfcompact" (HI-1916): as Codex 0.164 did for HR5 (27 Oct), a compaction it begins itself, then the turn run under
    // that compaction's id: PreCompact and PostCompact, then its prompt, all under this turn's id.
    if (/^selfcompact\b/.test(text)) {
      await hook('PreCompact', { trigger: 'auto' })
      await sleep(300)
      await hook('PostCompact')
      await sleep(200)
    }
    userLine(text)
    await hook('UserPromptSubmit', { prompt: text })
  }
  // Hive's doorbell (#650): it reads its inbox (cw_inbox), as a model does, and acts on what it read (one that follows
  // notices acks it too); what else it read (a wake, a message) is logged in fake-wakes.jsonl in CODEX_HOME.
  if (isDoorbell(text)) {
    const work = doorbellIsWork(text)
    const r = await hiveCall('cw_inbox', {})
    const rows = r.isError ? [] : inboxRows(r.text)
    if (rows.length && followsNotices()) await hiveCall('cw_inbox', { ack: rows.flatMap((x) => x.ids) })
    const read = rows.map((x) => x.text).join(' ')
    if (!work && process.env.CODEX_HOME) fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-wakes.jsonl'), JSON.stringify({ agent: String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_'), text: read, doorbell: text, at: new Date().toISOString() }) + '\n')
    if (rows.length) text = work ? read : nextScripted() || ''
  }
  // As 0.162.1 does (FAKE_CODEX_VERSION), its Working line while a turn runs (#1336: what Hive's screen reading looks for).
  if (/^0\.16[2-9]|^0\.1[7-9]|^[1-9]/.test(process.env.FAKE_CODEX_VERSION || '')) out(`\r\n• Working (0s • esc to interrupt)\r\n`)
  let questions = 0
  let scriptedSteps = false
  // "latetool": a command whose PostToolUse reaches Hive only after the turn's Stop (#648).
  let late = null
  for (const step of text.split(' then ')) {
    if (step === 'latetool') {
      late = { ...bash('npm test'), tool_use_id: `exec-${randomUUID()}` }
      await hook('PreToolUse', late)
      await sleep(1000)
    } else if (step === 'review allow' || step === 'review deny') await review(step === 'review allow')
    else if (step === 'review long') await review(true, LONG, 4000)
    else if (step === 'question' || step === 'late question') {
      await question(step === 'late question')
      questions++
    } else if (step === 'hold') {
      await key(['g'])
    } else if (step === 'ratelimited') {
      await rateLimited()
    } else if (step === 'approve') {
      if (!(await approve())) {
        // Rejected: the turn is interrupted (a question stays).
        await hook('Interrupt')
        busy = false
        return promptLine()
      }
    } else if (await scripted(step)) scriptedSteps = true
    else await sleep(500)
  }
  // Scripted steps take a second at least, as the fake Claude Code's turns do: a turn that ends at once can be over
  // before anyone sees it working.
  if (scriptedSteps && !/\bwork\s+\d+/i.test(text)) await sleep(1000)
  // It waits for the answers, working meanwhile ("a" answers one: the answer comes as a prompt).
  for (; questions > 0; questions--) {
    await hook('PreToolUse', bash('Start-Sleep 30'))
    await key(['a'])
    asked(-1)
    await hook('UserPromptSubmit', { prompt: '<send_user_message_question_reply>Red' })
    await hook('PostToolUse', bash('Start-Sleep 30'))
  }
  // Its answer, as 0.159 records the model's reply: a message and the turn's item (#1371: the turn was taken up).
  record({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Done: ${text}` }] })
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'AgentMessage', content: [{ type: 'Text', text: `Done: ${text}` }] } } }) + '\n')
  out(`\r\nDone: ${text}\r\n`)
  // "loststop": its Stop never reaches Hive, though Codex records the turn's end; "silent": neither (#648).
  if (!/\b(loststop|silent)\b/.test(text)) {
    const reply = await hook('Stop', { last_assistant_message: `Done: ${text}`, stop_hook_active: false })
    // Blocked (#650: Hive's drain): the reason goes on in the same turn as a hook prompt (no UserPromptSubmit), then Stop again.
    if (reply?.decision === 'block') {
      if (noticeIn(reply, 'drain') && followsNotices()) await readInbox()
      await hook('Stop', { last_assistant_message: `Done: ${text}`, stop_hook_active: true })
    }
  }
  if (!/\bsilent\b/.test(text)) turnRecord('task_complete')
  if (late) await hook('PostToolUse', late)
  busy = false
  promptLine()
}

const promptLine = () => out('\r\n› Ask Codex to do anything\r\n')

let line = ''
let ctrlC = 0
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  // A lone Esc is a key; other escape sequences (focus reports) aren't. Alt+Enter (ESC CR, as Windows' console hands it
  // on) is a key of its own: a new line in the prompt, not a send, as Codex 0.164's editor takes it (HI-1327).
  const keys = data === '\x1b' ? ['\x1b'] : data.split('\x1b\r').flatMap((part, i) => [...(i > 0 ? ['alt-enter'] : []), ...part.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')])
  for (const ch of keys) {
    if (onKey?.(ch)) continue
    if (ch === '\x03') {
      if (++ctrlC >= 2) void hook('SessionEnd').then(() => process.exit(0))
      continue
    }
    ctrlC = 0
    if (ch === '\x15') line = ''
    else if (ch === '\r' || ch === '\n') {
      const text = line.trim()
      line = ''
      if (text && !busy) void runPrompt(text)
      // Typed while a turn runs (#1514): queued for it, as Codex queues input.
      else if (text && queues()) queued.push(text)
    } else if (ch === 'alt-enter') {
      if (!busy || queues()) line += '\n'
    } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
    else if (ch >= ' ' && (!busy || queues())) line += ch
  }
})

out('OpenAI Codex (fake, for Hive tests)\r\n')
// Its MCP servers connect as it starts (#865): the launch's hive server, through the real server, which tells Hive.
void connectHive(hiveServer())
setTitle(project)
promptLine()
if (firstPrompt) void runPrompt(firstPrompt)
