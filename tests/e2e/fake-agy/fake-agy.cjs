// A stand-in for Google's Antigravity CLI (agy) 1.5.0, for HI-2544's adapter checks: no sign-in, no model, no network.
// What it does is what the adapter relies on, as HI-2543's and HI-2544's runs of the real CLI showed:
// - `agy --version` prints 1.5.0; `agy models` prints the recorded list (tests/fixtures/advanced/models-antigravity-1.5.0.txt),
//   or, with FAKE_AGY_SIGNED_OUT=1, the recorded signed-out error (exit 1);
// - a session reads its home from USERPROFILE (never HOME); it reopens `--conversation <id>`, else makes a new id;
//   it keeps the conversation in <USERPROFILE>\.gemini\antigravity-cli\brain\<id>\.system_generated\logs\transcript_full.jsonl
//   (and transcript.jsonl, each argument encoded again), as 1.5.0's steps (HI-2546: tests/fixtures/antigravity), its title
//   in annotations\<id>.pbtxt and the folder's last conversation in cache\last_conversations.json;
// - it runs the `--settings` file's statusLine command (through cmd /c, as agy does) with the session's state on stdin;
// - it starts the MCP servers of <USERPROFILE>\.gemini\config\mcp_config.json and of each workspace folder's
//   .agents\mcp_config.json (the cwd and each --add-dir), a server named in the profile replacing the project's of that
//   name, and keeps them running (one that ends falls back to the project's, as the real CLI's does);
// - each line typed is a turn: written to the transcript, answered "Done: <line>", the status line run again; a line
//   "tool <text>" also calls an MCP tool (call_mcp_tool) whose result is <text>.
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
function statusLine(state) {
  const cmd = settings.statusLine?.command
  if (!cmd) return
  const model = flag('--model') || 'Gemini 3.8 Flash (Low)'
  const input = JSON.stringify({ conversation_id: conv, session_id: conv, transcript_path: transcript.replace(/\\/g, '/'), agent_state: state, cwd: process.cwd(), model: { id: model, display_name: model, effort: flag('--effort') || 'low' }, context_window: { context_window_size: 1048576 }, product: 'antigravity' })
  // Through cmd, the command line as given (Node quotes it for cmd's /s /c, so its own quotes reach it unchanged).
  spawnSync(cmd, [], { shell: true, input, timeout: 5000, windowsHide: true })
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
const turn = (text) => {
  // The first prompt says the model it starts on, as 1.5.0's does.
  const picked = step === 0 ? `\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to ${flag('--model') || 'Gemini 3.8 Flash (Low)'}. No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>` : ''
  write({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${now()}.\n</ADDITIONAL_METADATA>${picked}` })
  if (!fs.existsSync(path.join(cli, 'annotations', `${conv}.pbtxt`))) keep(path.join('annotations', `${conv}.pbtxt`), `title:${JSON.stringify(`Fake: ${text}`)}\n`)
  statusLine('working')
  const tool = /^tool (.+)$/.exec(text)
  if (tool) {
    write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), tool_calls: [{ name: 'call_mcp_tool', args: { Arguments: {}, ServerName: 'fake', ToolName: 'echo' } }] })
    write({ source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `Created At: ${now()}\nCompleted At: ${now()}\n${tool[1]}` })
  }
  write({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...tokens(), content: `Done: ${text}` })
  process.stdout.write(`Done: ${text}\n> `)
  statusLine('idle')
}
const first = flag('-i')
if (first) turn(first)
let line = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  for (const c of d) {
    if (c === '\r' || c === '\n') {
      const t = line.trim()
      line = ''
      if (!t) continue
      if (t === '/exit') return quit()
      turn(t)
    } else line += c
  }
})
process.stdin.on('end', quit)
function quit() {
  for (const p of running) p.kill()
  process.exit(0)
}
