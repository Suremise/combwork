// A stand-in for Google's Antigravity CLI (agy) 1.5.0, for HI-2544's adapter checks: no sign-in, no model, no network.
// What it does is what the adapter relies on, as HI-2543's and HI-2544's runs of the real CLI showed:
// - `agy --version` prints 1.5.0; `agy models` prints the recorded list (tests/fixtures/advanced/models-antigravity-1.5.0.txt),
//   or, with FAKE_AGY_SIGNED_OUT=1, the recorded signed-out error (exit 1);
// - a session reads its home from USERPROFILE (never HOME); it reopens `--conversation <id>`, else makes a new id;
//   it keeps the conversation in <USERPROFILE>\.gemini\antigravity-cli\brain\<id>\.system_generated\logs\transcript_full.jsonl
//   (and transcript.jsonl, each argument encoded again), as 1.5.0's steps (HI-2546: tests/fixtures/antigravity), its title
//   in annotations\<id>.pbtxt and the folder's last conversation in cache\last_conversations.json;
// - it runs the `--settings` file's statusLine command (through cmd /c, as agy does) with the session's state on stdin;
// - it runs the hooks of <USERPROFILE>\.gemini\config\hooks.json (through cmd /c, the payload on stdin, the reply read
//   from stdout), as agy 1.5.0 ran them in HI-2545's recorded runs: SessionStart with a conversation's first prompt; each
//   model call between a PreInvocation and a PostInvocation (invocationNum counted across the turn, a continuation's
//   included; initialNumSteps the steps before it), the tool hooks around a tool call, and Stop. A Stop answered `continue`
//   (or a prompt with "carry on", as another hook's continuation) runs another execution with no new user step. A
//   PreToolUse answered `deny`, or with no decision, is refused (the tool's step an error, no PostToolUse); `allow` runs
//   it. A prompt with "needs approval" pauses on a permission prompt the status line alone tells of
//   (tool_confirmation_pending) until the next line typed: "n" cancels it, ending the turn with no hook at all;
//   "edit <file>" edits the file (edit_file, its Path) through the tool hooks; "/new" starts another conversation;
// - it starts the MCP servers of <USERPROFILE>\.gemini\config\mcp_config.json and of each workspace folder's
//   .agents\mcp_config.json (the cwd and each --add-dir), a server named in the profile replacing the project's of that
//   name, and keeps them running (one that ends falls back to the project's, as the real CLI's does);
// - each line typed is a turn: written to the transcript, answered "Done: <line>", the status line run again ("quota G O"
//   also puts the plan's quota in it from then on, HI-2734: Gemini's share left G, the other models' O); a line
//   "tool <text>" also calls an MCP tool (call_mcp_tool) whose result is <text>, and "image" reads an image (read_file, its
//   result naming a copy in logs\media); a resume needs the conversation's store (conversations\<id>.db), as 1.5.0's does.
// Every launch is logged to FAKE_AGY_LOG (a JSON line: its arguments, cwd, and the environment the adapter sets).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const FIX = path.join(__dirname, '..', '..', 'fixtures', 'advanced')
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const all = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
const home = process.env.USERPROFILE || ''

function log(entry) {
  if (!process.env.FAKE_AGY_LOG) return
  fs.mkdirSync(path.dirname(process.env.FAKE_AGY_LOG), { recursive: true })
  fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n')
}

if (argv[0] === '--version') {
  process.stdout.write('1.5.0\n')
  process.exit(0)
}
if (argv[0] === 'models') {
  log({ kind: 'models', env: pick() })
  process.stderr.write('Fetching available models...\n')
  if (process.env.FAKE_AGY_SIGNED_OUT === '1') {
    process.stderr.write(fs.readFileSync(path.join(FIX, 'models-signedout-antigravity-1.5.0.txt'), 'utf8').split('\n').slice(1).join('\n'))
    process.exit(1)
  }
  process.stdout.write(fs.readFileSync(path.join(FIX, 'models-antigravity-1.5.0.txt'), 'utf8'))
  process.exit(0)
}

function pick() {
  const keys = ['USERPROFILE', 'HOME', 'AGY_CLI_DISABLE_AUTO_UPDATE', 'GEMINI_API_KEY', 'AGY_ADC_AUTH', 'AGY_ACCOUNT']
  return Object.fromEntries(keys.filter((k) => process.env[k] !== undefined).map((k) => [k, k === 'GEMINI_API_KEY' ? '(set)' : process.env[k]]))
}

// --- A session.
const resumed = flag('--conversation')
// The conversation it runs: the one resumed, else a new one; `/new` starts another (1.5.0: SessionStart at its prompt).
let conv, brain, logs, transcript, short, full, step
// Whether its status line names the conversation yet: 1.5.0's says conversation_id "" until a new one's first prompt
// (HI-2548's real run; a resumed one is named from the start).
let named = false
const cli = path.join(home, '.gemini', 'antigravity-cli')
const keep = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(cli, rel)), { recursive: true })
  fs.writeFileSync(path.join(cli, rel), text)
}
function openConversation(id) {
  conv = id
  named = !!resumed && id === resumed
  brain = path.join(home, '.gemini', 'antigravity-cli', 'brain', conv)
  logs = path.join(brain, '.system_generated', 'logs')
  fs.mkdirSync(logs, { recursive: true })
  transcript = path.join(logs, 'transcript_full.jsonl')
  short = path.join(logs, 'transcript.jsonl')
  // The transcript its hooks name (transcriptPath).
  full = transcript
  step = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).length : 0
  keep(path.join('cache', 'last_conversations.json'), JSON.stringify({ [process.cwd()]: conv }))
  // The conversation's own store, which a resume reads (1.5.0: conversations\<id>.db; the fake's is empty).
  if (!fs.existsSync(path.join(cli, 'conversations', `${conv}.db`))) keep(path.join('conversations', `${conv}.db`), '')
}
if (resumed && !fs.existsSync(path.join(cli, 'brain', resumed))) {
  process.stderr.write(`Error: conversation ${resumed} not found\n`)
  process.exit(1)
}
openConversation(resumed || crypto.randomUUID())
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
// transcript.jsonl has each tool argument encoded again, as 1.5.0's does.
const encoded = (o) => (o.tool_calls ? { ...o, tool_calls: o.tool_calls.map((c) => ({ ...c, args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, JSON.stringify(v)])) })) } : o)
const write = (o) => {
  const s = { step_index: step++, created_at: now(), ...o }
  fs.appendFileSync(transcript, JSON.stringify(s) + '\n')
  fs.appendFileSync(short, JSON.stringify(encoded(s)) + '\n')
}
log({ kind: 'session', args: argv, cwd: process.cwd(), conversation: conv, resumed: !!resumed, env: pick() })

// A hook's or the status line's command as agy 1.5.0 runs it (HI-2548's probe of the real CLI recorded the command line):
// `cmd /c "<command>"`, each " in the command escaped as \" (Go's argument escaping, which cmd doesn't undo).
const asAgy = (command) => `/c "${command.replace(/"/g, '\\"')}"`
// The status line, per --settings (never saved), through cmd /c as agy runs it.
let settings = {}
try {
  const s = flag('--settings')
  if (s) settings = JSON.parse(fs.existsSync(s) ? fs.readFileSync(s, 'utf8') : s)
} catch (e) {
  process.stderr.write(`Error: --settings: ${e.message}\n`)
  process.exit(1)
}
// The plan's quota and name its status line carries (HI-2734), once a turn "quota G O" set them: Gemini's share left G and
// the other models' O, as 1.5.0 sends them (tests/fixtures/advanced/statusline-run-antigravity-1.5.0.jsonl).
let quota = null
function statusLine(state, extra = {}) {
  const cmd = settings.statusLine?.command
  if (!cmd) return
  if (quota) extra = { ...quota, ...extra }
  const model = flag('--model') || 'Gemini 3.8 Flash (Low)'
  const input = JSON.stringify({ conversation_id: named ? conv : '', session_id: named ? conv : '', transcript_path: transcript.replace(/\\/g, '/'), agent_state: state, cwd: process.cwd(), model: { id: model, display_name: model, effort: flag('--effort') || 'low' }, context_window: { context_window_size: 1048576 }, product: 'antigravity', ...extra })
  spawnSync(process.env.ComSpec || 'cmd.exe', [asAgy(cmd)], { windowsVerbatimArguments: true, input, timeout: 5000, windowsHide: true })
  log({ kind: 'status', state, ...extra })
}

// Hooks: the profile's hooks.json (read each time, as a launch rewrites it), each handler run through cmd with the payload.
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])
function handlers(event) {
  let defs = {}
  try {
    defs = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'hooks.json'), 'utf8'))
  } catch {
    return []
  }
  const out = []
  for (const def of Object.values(defs)) {
    if (!def || def.enabled === false) continue
    for (const entry of def[event] ?? []) {
      if (TOOL_EVENTS.has(event)) for (const h of entry.hooks ?? []) out.push(h)
      else out.push(entry)
    }
  }
  return out
}
let lastUserInput = ''
// A model call's time (FAKE_AGY_MODEL_MS; the scenarios' 700 ms, so a turn is seen under way as a real one is; else none).
const MODEL_MS = Number(process.env.FAKE_AGY_MODEL_MS ?? 0)
const thinking = () => MODEL_MS > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MODEL_MS)
function fire(event, extra = {}) {
  const payload = { conversationId: conv, workspacePaths: [process.cwd().replace(/\\/g, '/')], transcriptPath: full.replace(/\\/g, '/'), artifactDirectoryPath: brain.replace(/\\/g, '/'), modelName: flag('--model') || 'auto', lastUserInput, ...extra }
  const reply = {}
  for (const h of handlers(event)) {
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', [asAgy(h.command)], { windowsVerbatimArguments: true, input: JSON.stringify(payload), timeout: (h.timeout || 30) * 1000, windowsHide: true, encoding: 'utf8' })
    try {
      Object.assign(reply, JSON.parse(r.stdout || '{}'))
    } catch {}
  }
  log({ kind: 'hook', event, payload: { ...payload, lastUserInput: undefined }, reply })
  return reply
}

// MCP servers: the profile's, then each workspace folder's .agents (a name in the profile wins).
function servers() {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}
    } catch {
      return {}
    }
  }
  const own = read(path.join(home, '.gemini', 'config', 'mcp_config.json'))
  const project = {}
  for (const d of [process.cwd(), ...all('--add-dir')]) Object.assign(project, read(path.join(d, '.agents', 'mcp_config.json')))
  return { own, project }
}
const running = []
function start(def, fallback) {
  if (!def?.command) return
  const p = spawn(def.command, def.args || [], { env: { ...process.env, ...def.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  running.push(p)
  p.on('error', () => undefined)
  p.stdin.on('error', () => undefined)
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agy', version: '1.5.0' } } }) + '\n')
  // As an MCP client does once initialized (the Combwork server then tells Combwork the launch has connected, #865).
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  // One that ends: the project's of that name instead (the real CLI's fallback, HI-2544's sentinel runs).
  p.on('exit', () => {
    if (fallback) start(fallback, null)
  })
}
const { own, project } = servers()
for (const [name, def] of Object.entries(own)) start(def, project[name])
for (const [name, def] of Object.entries(project)) if (!own[name]) start(def, null)
log({ kind: 'mcp', conversation: conv, own: Object.keys(own), project: Object.keys(project) })

// --- The scenarios' steps (HI-2548), as fake-claude and fake-codex take them: "skill NAME" and "skillref NAME FILE" (a
// read_file of the delivered copy in .agents\skills), "cw TOOL {json}", "boardmove N COLUMN", "boardreview N ACTION
// [COLUMN]", "boardcomment N" (a call_mcp_tool through the launch's real Combwork MCP server, the profile's `combwork`),
// "work N" (a model call of N seconds), "shell: <command line>" (a run_command in cmd) and "patch FILE" (an edit_file appending a line).
// Each is a model call of its own between PreInvocation and PostInvocation, its tool between PreToolUse and PostToolUse
// (a deny refuses it), and its call and result steps in the transcript as 1.5.0 writes them.
const { callOwnTool, parseToolStep, isDoorbell, doorbellIsWork, inboxRows } = require('../fake-bridge.cjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Whether it follows Combwork's notices as a model does (the scenarios': FAKE_AGY_FOLLOW_NOTICES=1). */
const follows = () => process.env.FAKE_AGY_FOLLOW_NOTICES === '1'
/** A tool's result step, as 1.5.0 writes one: its times first, then the output, or an error. */
const result = (text, error) => write({ source: 'MODEL', type: 'GENERIC', status: error ? 'ERROR' : 'DONE', ...(error ? { error: text } : {}), content: `Created At: ${now()}\nCompleted At: ${now()}\n${error ? `Encountered error in step execution: ${text}` : text}` })
/** One tool call in a model call: its call step, PreToolUse (a deny refuses it), what it does, its result, PostToolUse. */
async function tool(invoked, toolCall, run) {
  await invoked(async () => {
    write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), tool_calls: [toolCall] })
    const at = step
    const pre = fire('PreToolUse', { stepIdx: at, toolCall })
    if (pre.decision === 'deny' || !pre.decision) {
      result(`tool call denied by pre-tool hook: ${pre.reason ?? ''}`, true)
      return
    }
    const r = await run()
    result(r.text, r.isError)
    fire('PostToolUse', { stepIdx: at, toolCall, error: r.isError ? r.text : '' })
  })
}
let lastCall = null
/** A Combwork tool, through the launch's own Combwork MCP server (the profile's), as agy's call_mcp_tool. */
async function ownCall(name, args, invoked) {
  const def = servers().own.combwork
  lastCall = { text: 'error: no Combwork MCP server', isError: true }
  await tool(invoked, { name: 'call_mcp_tool', args: { Arguments: args, ServerName: 'combwork', ToolName: name } }, async () => {
    lastCall = def?.command ? await callOwnTool({ command: def.command, args: def.args, env: def.env }, name, args) : lastCall
    return lastCall
  })
  return lastCall
}
async function readInbox(invoked) {
  const listed = await ownCall('cw_inbox', {}, invoked)
  const ids = [...new Set([...String(listed?.text ?? '').matchAll(/\bm\d+\b/g)].map((m) => m[0]))]
  if (ids.length) await ownCall('cw_inbox', { ack: ids }, invoked)
}
/** A file read as agy reads one (read_file, its Path). */
const readFile = (file, invoked) => tool(invoked, { name: 'read_file', args: { Path: file } }, async () => (fs.existsSync(file) ? { text: fs.readFileSync(file, 'utf8') } : { text: `file not found: ${file}`, isError: true }))
const skillDir = (name) => [name, `cw-${name}`].map((d) => path.join(process.cwd(), '.agents', 'skills', d)).find((d) => fs.existsSync(path.join(d, 'SKILL.md'))) ?? path.join(process.cwd(), '.agents', 'skills', name)
/** A skill's reference file, by the link its delivered SKILL.md has (HI-2011). */
function skillRef(name, file) {
  const dir = skillDir(name)
  const text = fs.existsSync(path.join(dir, 'SKILL.md')) ? fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') : ''
  return text.includes(`](${file})`) || text.includes(`](./${file})`) ? path.resolve(dir, file) : path.join(dir, `no-link-to-${file}`)
}
/** A command in cmd with the session's environment, as run_command; logged (kind "shell"). */
function shellRun(cmd) {
  return new Promise((resolve) => {
    const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { cwd: process.cwd(), env: process.env, windowsVerbatimArguments: true, windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => {
      log({ kind: 'shell', cmd, code, out })
      resolve({ text: out || `exit code ${code}`, isError: code !== 0 })
    })
  })
}
/** One scenario step (the text between " then "s); nothing when it is none of them. */
async function scripted(s, invoked) {
  for (const m of s.matchAll(/\bskill\s+([a-z0-9][\w-]*)/gi)) await readFile(path.join(skillDir(m[1]), 'SKILL.md'), invoked)
  for (const m of s.matchAll(/\bskillref\s+([a-z0-9][\w-]*)\s+([\w.-]+\.md)/gi)) await readFile(skillRef(m[1], m[2]), invoked)
  const move = /\bboardmove\s+(\d+)\s+(\w+)/i.exec(s)
  if (move) await ownCall('cw_update_task', { number: Number(move[1]), column: move[2].toLowerCase() }, invoked)
  const rev = /\bboardreview\s+(\d+)\s+(\w+)(?:\s+(hold|todo|doing|review|passed|done)\b)?/i.exec(s)
  if (rev) await ownCall('cw_update_task', { number: Number(rev[1]), review: rev[2].toLowerCase(), ...(rev[3] ? { column: rev[3].toLowerCase(), comment: 'Fake review: passed.' } : {}) }, invoked)
  const comment = /\bboardcomment\s+(\d+)/i.exec(s)
  if (comment) await ownCall('cw_update_task', { number: Number(comment[1]), comment: 'Fake: done, see the files.' }, invoked)
  const c = parseToolStep(s)
  if (c) await ownCall(c.tool, c.args, invoked)
  const pause = /\bwork\s+(\d+)/i.exec(s)
  // A model call that takes N seconds (agy's turn begins with its invocation zero, so the turn is under way meanwhile).
  if (pause) await invoked(() => sleep(Number(pause[1]) * 1000))
  const sh = /\bshell:\s*(.+)$/i.exec(s)
  if (sh) await tool(invoked, { name: 'run_command', args: { CommandLine: sh[1].trim(), WaitMsBeforeAsync: 5000, toolSummary: sh[1].trim().slice(0, 60) } }, () => shellRun(sh[1].trim()))
  const patch = /\bpatch\s+([\w.-]+)/i.exec(s)
  if (patch) {
    const target = path.resolve(process.cwd(), patch[1])
    let allowed = false
    await tool(invoked, { name: 'edit_file', args: { Path: target, Target: '', Replacement: 'edited' } }, async () => {
      allowed = true
      fs.appendFileSync(target, `edited by ${process.env.CW_AGENT || 'agent'}\n`)
      return { text: `Made 1 replacement in ${target}` }
    })
    log({ kind: 'edit', agent: process.env.CW_AGENT || 'agent', file: patch[1], allowed })
  }
}

// Its first-run screens (1.5.0: a colour scheme, then its Terms of Service & Data Use), until cache\onboarding.json says
// they are done: here the line "accept" completes them, writing what 1.5.0 writes (onboarding.json, jetski_state's
// post_onboarding block). Nothing else is taken until then.
const onboardingFile = path.join(cli, 'cache', 'onboarding.json')
const readOnboarded = () => {
  try {
    return JSON.parse(fs.readFileSync(onboardingFile, 'utf8')).onboardingComplete === true
  } catch {
    return false
  }
}
let onboarded = readOnboarded()
log({ kind: 'onboarding', shown: !onboarded, env: pick() })
if (!onboarded) process.stdout.write('Choose a colour scheme\nTerms of Service & Data Use (type accept)\n> ')
else process.stdout.write(`Antigravity CLI 1.5.0 (fake) · conversation ${conv}\n> `)
statusLine('idle')
// Each request's tokens: its input without the cache read (4000 from the second request on), as 1.5.0 records them.
const tokens = () => ({ input_tokens: 3000 + 100 * step, cache_read_tokens: step > 1 ? 4000 : 0, output_tokens: 20 })
// Lines typed, taken in order: a turn's own (an approval) or the next prompt.
let waiting = null
const nextLine = () => new Promise((r) => (waiting = r))
let started = false
async function turn(text) {
  // The user's /new: another conversation, its SessionStart with its first prompt (1.5.0's).
  if (text === '/new') {
    openConversation(crypto.randomUUID())
    started = false
    process.stdout.write('> ')
    statusLine('idle')
    return
  }
  lastUserInput = text
  named = true
  // The prompt shown in its pane, as agy's TUI shows the user's message (a first prompt given with -i too).
  process.stdout.write(`${text}\n`)
  if (!started) {
    started = true
    fire('SessionStart')
  }
  // As agy records a prompt: the user's words wrapped with its own metadata; the first one says the model it starts on.
  const picked = step === 0 ? `\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to ${flag('--model') || 'Gemini 3.8 Flash (Low)'}. No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>` : ''
  write({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${now()}.\n</ADDITIONAL_METADATA>${picked}` })
  if (!fs.existsSync(path.join(cli, 'annotations', `${conv}.pbtxt`))) keep(path.join('annotations', `${conv}.pbtxt`), `title:${JSON.stringify(`Fake: ${text}`)}\n`)
  // Its model calls, counted across the turn (1.5.0: a continuation doesn't start the count again), each between a
  // PreInvocation and a PostInvocation naming the steps before it.
  let invocation = 0
  const call = (body) => {
    const at = step
    fire('PreInvocation', { invocationNum: invocation, initialNumSteps: at })
    thinking()
    body()
    fire('PostInvocation', { invocationNum: invocation, initialNumSteps: at })
    invocation++
  }
  // A model call whose tool runs asynchronously (a Combwork tool, a command).
  const invoked = async (body) => {
    const at = step
    fire('PreInvocation', { invocationNum: invocation, initialNumSteps: at })
    thinking()
    await body()
    fire('PostInvocation', { invocationNum: invocation, initialNumSteps: at })
    invocation++
  }
  const q = /^quota ([\d.]+) ([\d.]+)$/.exec(text)
  if (q) {
    const week = new Date(Date.now() + 5 * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z')
    quota = { quota: { '3p-weekly': { remaining_fraction: Number(q[2]), reset_time: week, reset_in_seconds: 432000 }, 'gemini-weekly': { remaining_fraction: Number(q[1]), reset_time: week, reset_in_seconds: 432000 } }, plan_tier: 'Antigravity Starter Quota' }
  }
  let carried = /carry on/i.test(text)
  // Combwork's doorbell (#650): it reads its inbox as a model does (and acks what it read, following notices); new work
  // it read (a task, a handover) is what this turn does, anything else is logged (kind "wake").
  statusLine('working')
  if (isDoorbell(text)) {
    // New work: only tasks and handovers, a card named by its key ("1 task (AL-1) (m1)") or its number.
    const work = doorbellIsWork(text) || /^\[CW\] New in your inbox: (\d+ (task|tasks|handover|handovers)( \([^)]*\))?( and |, )?)+ \(m\d/.test(text)
    const r = await ownCall('cw_inbox', {}, invoked)
    const rows = r.isError ? [] : inboxRows(r.text)
    if (rows.length && follows()) await ownCall('cw_inbox', { ack: rows.flatMap((x) => x.ids) }, invoked)
    const read = rows.map((x) => x.text).join(' ')
    if (!work) log({ kind: 'wake', text: read, doorbell: text })
    text = work ? read : ''
  }
  // The scenarios' steps (tests/scenarios), as the other fakes take them, each step a model call of its own.
  for (const s of text.split(' then ')) await scripted(s, invoked)
  for (let execution = 0; execution < 4; execution++) {
    statusLine('working')
    const toolLine = execution === 0 ? /^tool (.+)$/.exec(text) : null
    if (toolLine) {
      call(() => {
        write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), tool_calls: [{ name: 'call_mcp_tool', args: { Arguments: {}, ServerName: 'fake', ToolName: 'echo' } }] })
        write({ source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `Created At: ${now()}\nCompleted At: ${now()}\n${toolLine[1]}` })
      })
    }
    if (execution === 0 && text === 'image') {
      call(() => {
        // read_file of an image: its result names the copy agy keeps in logs\media (1.5.0's media entry).
        write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), tool_calls: [{ name: 'read_file', args: { Path: path.join(process.cwd(), 'red.png') } }] })
        const media = path.join(logs, 'media', `step_${step}_media_0.png`)
        fs.mkdirSync(path.dirname(media), { recursive: true })
        fs.copyFileSync(path.join(__dirname, '..', '..', 'fixtures', 'antigravity', 'image-1.5.0-media.png'), media)
        write({ source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `Created At: ${now()}\nCompleted At: ${now()}\nShowing binary file of type image/png`, media: [{ mime_type: 'image/png', uri: `file:///${media.replace(/\\/g, '/')}` }] })
      })
    }
    const edit = execution === 0 ? /edit (\S+)/i.exec(text) : null
    if (edit) {
      call(() => {
        const target = path.resolve(process.cwd(), edit[1])
        const toolCall = { name: 'edit_file', args: { Path: target, Target: 'x', Replacement: 'edited' } }
        write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), tool_calls: [toolCall] })
        const at = step
        const pre = fire('PreToolUse', { stepIdx: at, toolCall })
        // 1.5.0: deny, or no decision at all, refuses the tool; allow (and ask, force_ask) leave it to the mode.
        if (pre.decision === 'deny' || !pre.decision) {
          const why = `tool call denied by pre-tool hook: ${pre.reason ?? ''}`
          write({ source: 'MODEL', type: 'GENERIC', status: 'ERROR', error: why, content: `Created At: ${now()}\nCompleted At: ${now()}\nEncountered error in step execution: ${why}` })
          process.stdout.write(`Denied: ${pre.reason ?? ''}\n`)
          return
        }
        fs.writeFileSync(target, 'edited')
        write({ source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `Created At: ${now()}\nCompleted At: ${now()}\nMade 1 replacement in ${target}` })
        fire('PostToolUse', { stepIdx: at, toolCall, error: '' })
      })
    }
    if (execution === 0 && /needs approval/i.test(text)) {
      // A command the model calls, which agy asks about: no hook, only the status line, until the person answers (the next
      // line typed). Cancelled ("n"), the turn ends with no hook at all (1.5.0's: no result, PostInvocation or Stop), its
      // status line idle.
      const at = step
      fire('PreInvocation', { invocationNum: invocation, initialNumSteps: at })
      write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo hi', WaitMsBeforeAsync: 5000, toolSummary: 'Echo hi' } }] })
      statusLine('tool_use', { tool_confirmation_pending: true })
      const answer = await nextLine()
      if (/^n/i.test(answer)) {
        process.stdout.write('Interrupted\n> ')
        statusLine('idle')
        return
      }
      statusLine('working')
      write({ source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `Created At: ${now()}\nCompleted At: ${now()}\nhi` })
      fire('PostInvocation', { invocationNum: invocation, initialNumSteps: at })
      invocation++
    }
    call(() => write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), content: `Done: ${text}` }))
    const stop = fire('Stop', { executionNum: execution, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, error: '' })
    // Carried on (Combwork's reply, or another hook's continuation): a system message, then another execution.
    if (stop.decision === 'continue' || carried) {
      carried = false
      write({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\nStop hook blocked termination: ${stop.reason || 'continue'}\n</SYSTEM_MESSAGE>` })
      // Combwork's notice ("[CW] …"): one that follows notices reads its inbox and acks it, as a model does.
      if (String(stop.reason ?? '').startsWith('[CW]')) {
        log({ kind: 'notice', at: 'Stop', text: stop.reason })
        if (follows()) await readInbox(invoked)
      }
      continue
    }
    break
  }
  process.stdout.write(`Done: ${text}\n> `)
  statusLine('idle')
}
let queue = Promise.resolve()
const first = flag('-i')
if (first && onboarded) queue = queue.then(() => turn(first))
let line = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  for (const c of d) {
    if (c === '\r' || c === '\n') {
      // A bracketed paste's marks (their ESC dropped below) aren't text either.
      const t = line.replace(/\[20[01]~/g, '').trim()
      line = ''
      if (!t) continue
      if (t === '/exit') return quit()
      if (!onboarded) {
        if (t !== 'accept') continue
        keep(path.join('cache', 'onboarding.json'), JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true }, null, 2))
        keep('jetski_state.pbtxt', 'post_onboarding: {\n  completed_steps: POST_ONBOARDING_STEP_TYPE_MANAGER_WELCOME\n}\ninstallation_uuid: "fake-installation"\n')
        onboarded = true
        log({ kind: 'onboarded', env: pick() })
        process.stdout.write(`Antigravity CLI 1.5.0 (fake) · conversation ${conv}\n> `)
        continue
      }
      // A turn waiting for its answer takes this line; else it is the next prompt.
      if (waiting) {
        const w = waiting
        waiting = null
        w(t)
      } else queue = queue.then(() => turn(t))
    } else if (c === '\x15') line = ''
    // Ctrl+U clears its input, as agy's does (Combwork sends it before a line it types); other control keys aren't text.
    else if (c >= ' ' || c === '\t') line += c
  }
})
process.stdin.on('end', quit)
function quit() {
  for (const p of running) p.kill()
  process.exit(0)
}
