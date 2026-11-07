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
//   from stdout), as agy 1.5.0's hooks.md has them: SessionStart with the first prompt; per execution PreInvocation
//   (invocationNum 0), the tool hooks around a tool call, PostInvocation and Stop. A Stop answered `continue` (or a
//   prompt with "carry on", as another hook's continuation) runs another execution with no new user step; a PreToolUse
//   answered `deny` is refused. A prompt with "needs approval" pauses on a permission prompt the status line alone tells
//   of (tool_confirmation_pending), until the next line typed; "edit <file>" writes the file through the tool hooks;
// - it starts the MCP servers of <USERPROFILE>\.gemini\config\mcp_config.json and of each workspace folder's
//   .agents\mcp_config.json (the cwd and each --add-dir), a server named in the profile replacing the project's of that
//   name, and keeps them running (one that ends falls back to the project's, as the real CLI's does);
// - each line typed is a turn: written to the transcript, answered "Done: <line>", the status line run again; a line
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
const conv = resumed || crypto.randomUUID()
const brain = path.join(home, '.gemini', 'antigravity-cli', 'brain', conv)
const logs = path.join(brain, '.system_generated', 'logs')
if (resumed && !fs.existsSync(brain)) {
  process.stderr.write(`Error: conversation ${resumed} not found\n`)
  process.exit(1)
}
fs.mkdirSync(logs, { recursive: true })
const transcript = path.join(logs, 'transcript_full.jsonl')
const short = path.join(logs, 'transcript.jsonl')
let step = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).length : 0
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
// transcript.jsonl has each tool argument encoded again, as 1.5.0's does.
const encoded = (o) => (o.tool_calls ? { ...o, tool_calls: o.tool_calls.map((c) => ({ ...c, args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, JSON.stringify(v)])) })) } : o)
const write = (o) => {
  const s = { step_index: step++, created_at: now(), ...o }
  fs.appendFileSync(transcript, JSON.stringify(s) + '\n')
  fs.appendFileSync(short, JSON.stringify(encoded(s)) + '\n')
}
const cli = path.join(home, '.gemini', 'antigravity-cli')
const keep = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(cli, rel)), { recursive: true })
  fs.writeFileSync(path.join(cli, rel), text)
}
keep(path.join('cache', 'last_conversations.json'), JSON.stringify({ [process.cwd()]: conv }))
// The conversation's own store, which a resume reads (1.5.0: conversations\<id>.db; the fake's is empty).
if (!fs.existsSync(path.join(cli, 'conversations', `${conv}.db`))) keep(path.join('conversations', `${conv}.db`), '')
// The transcript its hooks name (transcriptPath).
const full = transcript
log({ kind: 'session', args: argv, cwd: process.cwd(), conversation: conv, resumed: !!resumed, env: pick() })

// The status line, per --settings (never saved), through cmd /c as agy runs it.
let settings = {}
try {
  const s = flag('--settings')
  if (s) settings = JSON.parse(fs.existsSync(s) ? fs.readFileSync(s, 'utf8') : s)
} catch (e) {
  process.stderr.write(`Error: --settings: ${e.message}\n`)
  process.exit(1)
}
function statusLine(state, extra = {}) {
  const cmd = settings.statusLine?.command
  if (!cmd) return
  const model = flag('--model') || 'Gemini 3.8 Flash (Low)'
  const input = JSON.stringify({ conversation_id: conv, session_id: conv, transcript_path: transcript.replace(/\\/g, '/'), agent_state: state, cwd: process.cwd(), model: { id: model, display_name: model, effort: flag('--effort') || 'low' }, context_window: { context_window_size: 1048576 }, product: 'antigravity', ...extra })
  // Through cmd, the command line as given (Node quotes it for cmd's /s /c, so its own quotes reach it unchanged).
  spawnSync(cmd, [], { shell: true, input, timeout: 5000, windowsHide: true })
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
  for (const named of Object.values(defs)) {
    if (!named || named.enabled === false) continue
    for (const entry of named[event] ?? []) {
      if (TOOL_EVENTS.has(event)) for (const h of entry.hooks ?? []) out.push(h)
      else out.push(entry)
    }
  }
  return out
}
let lastUserInput = ''
function fire(event, extra = {}) {
  const payload = { conversationId: conv, workspacePaths: [process.cwd().replace(/\\/g, '/')], transcriptPath: full.replace(/\\/g, '/'), artifactDirectoryPath: brain.replace(/\\/g, '/'), modelName: flag('--model') || 'auto', lastUserInput, ...extra }
  const reply = {}
  for (const h of handlers(event)) {
    const r = spawnSync(h.command, [], { shell: true, input: JSON.stringify(payload), timeout: (h.timeout || 30) * 1000, windowsHide: true, encoding: 'utf8' })
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
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n')
  // One that ends: the project's of that name instead (the real CLI's fallback, HI-2544's sentinel runs).
  p.on('exit', () => {
    if (fallback) start(fallback, null)
  })
}
const { own, project } = servers()
for (const [name, def] of Object.entries(own)) start(def, project[name])
for (const [name, def] of Object.entries(project)) if (!own[name]) start(def, null)
log({ kind: 'mcp', conversation: conv, own: Object.keys(own), project: Object.keys(project) })

process.stdout.write(`Antigravity CLI 1.5.0 (fake) · conversation ${conv}\n> `)
statusLine('idle')
// Each request's tokens: its input without the cache read (4000 from the second request on), as 1.5.0 records them.
const tokens = () => ({ input_tokens: 3000 + 100 * step, cache_read_tokens: step > 1 ? 4000 : 0, output_tokens: 20 })
// Lines typed, taken in order: a turn's own (an approval) or the next prompt.
let waiting = null
const nextLine = () => new Promise((r) => (waiting = r))
let started = false
async function turn(text) {
  lastUserInput = text
  if (!started) {
    started = true
    fire('SessionStart')
  }
  // As agy records a prompt: the user's words wrapped with its own metadata; the first one says the model it starts on.
  const picked = step === 0 ? `\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to ${flag('--model') || 'Gemini 3.8 Flash (Low)'}. No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>` : ''
  write({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${now()}.\n</ADDITIONAL_METADATA>${picked}` })
  if (!fs.existsSync(path.join(cli, 'annotations', `${conv}.pbtxt`))) keep(path.join('annotations', `${conv}.pbtxt`), `title:${JSON.stringify(`Fake: ${text}`)}\n`)
  let carried = /carry on/i.test(text)
  for (let execution = 0; execution < 4; execution++) {
    statusLine('working')
    fire('PreInvocation', { invocationNum: 0, initialNumSteps: step })
    if (execution === 0 && /needs approval/i.test(text)) {
      // A permission prompt: no hook, only the status line, until the person answers (the next line typed).
      statusLine('tool_use', { tool_confirmation_pending: true })
      await nextLine()
      statusLine('working')
    }
    const tool = execution === 0 ? /^tool (.+)$/.exec(text) : null
    if (tool) {
      write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), tool_calls: [{ name: 'call_mcp_tool', args: { Arguments: {}, ServerName: 'fake', ToolName: 'echo' } }] })
      write({ source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `Created At: ${now()}\nCompleted At: ${now()}\n${tool[1]}` })
    }
    if (execution === 0 && text === 'image') {
      // read_file of an image: its result names the copy agy keeps in logs\media (1.5.0's media entry).
      write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), tool_calls: [{ name: 'read_file', args: { Path: path.join(process.cwd(), 'red.png') } }] })
      const media = path.join(logs, 'media', `step_${step}_media_0.png`)
      fs.mkdirSync(path.dirname(media), { recursive: true })
      fs.copyFileSync(path.join(__dirname, '..', '..', 'fixtures', 'antigravity', 'image-1.5.0-media.png'), media)
      write({ source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `Created At: ${now()}\nCompleted At: ${now()}\nShowing binary file of type image/png`, media: [{ mime_type: 'image/png', uri: `file:///${media.replace(/\\/g, '/')}` }] })
    }
    const edit = execution === 0 ? /edit (\S+)/i.exec(text) : null
    if (edit) {
      const target = path.resolve(process.cwd(), edit[1])
      const call = { name: 'write_to_file', args: { TargetFile: target, CodeContent: 'edited' } }
      const at = step
      const pre = fire('PreToolUse', { stepIdx: at, toolCall: call })
      if (pre.decision === 'deny') write({ source: 'SYSTEM', type: 'GENERIC', status: 'DONE', content: `Denied: ${pre.reason ?? ''}` })
      else {
        fs.writeFileSync(target, 'edited')
        write({ source: 'MODEL', type: 'CODE_ACTION', status: 'DONE', content: target })
      }
      fire('PostToolUse', { stepIdx: at, toolCall: call, error: pre.decision === 'deny' ? 'denied' : '' })
    }
    write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), content: `Done: ${text}` })
    fire('PostInvocation', { invocationNum: 0, initialNumSteps: step })
    const stop = fire('Stop', { executionNum: execution, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, error: '' })
    // Carried on (Combwork's reply, or another hook's continuation): a system message, then another execution.
    if (stop.decision === 'continue' || carried) {
      carried = false
      write({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: stop.reason || 'continue' })
      continue
    }
    break
  }
  process.stdout.write(`Done: ${text}\n> `)
  statusLine('idle')
}
let queue = Promise.resolve()
const first = flag('-i')
if (first) queue = queue.then(() => turn(first))
let line = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  for (const c of d) {
    if (c === '\r' || c === '\n') {
      const t = line.trim()
      line = ''
      if (!t) continue
      if (t === '/exit') return quit()
      // A turn waiting for its answer takes this line; else it is the next prompt.
      if (waiting) {
        const w = waiting
        waiting = null
        w(t)
      } else queue = queue.then(() => turn(t))
    } else line += c
  }
})
process.stdin.on('end', quit)
function quit() {
  for (const p of running) p.kill()
  process.exit(0)
}
