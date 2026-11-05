// A scripted stand-in for Copilot's model (#453): an OpenAI-compatible chat completions API the real Copilot CLI uses in
// its BYOK mode, offline (COPILOT_OFFLINE=true, COPILOT_PROVIDER_BASE_URL=<this>/v1, COPILOT_MODEL=gpt-4.1): no sign-in,
// no network, no credits. Checked with Copilot CLI 1.0.93 (the #403 spike). What the "model" does is the prompt's steps,
// separated by " then ", as the fake Claude Code and fake Codex take them:
//   skill NAME                 Copilot's skill tool (it reads the skill's SKILL.md)
//   hive TOOL {json}           a tool of the hive MCP server (Copilot names it hive-TOOL), run by the real server
//   boardmove N COLUMN, boardreview N ACTION [COLUMN], boardcomment N    cw_update_task, as the fakes do
//   work N                     waits N seconds before its next step (a turn that takes a while)
//   edit PATH OLD NEW          Copilot's edit tool (PATH relative to the session's folder)
//   write PATH TEXT…           its create tool
//   view PATH                  its view tool (reads a file)
//   skillref NAME FILE         its view tool on a skill's reference file, by the link in the SKILL.md it read (HI-2011)
//   shell COMMAND…             its powershell tool
//   question                   its ask_user tool (a question for the person)
//   say TEXT…                  the turn's last reply (default: "Done.")
//   checkpoint                 a view of README.md: a tool call after which Combwork's notice may come (#650)
//   ratelimited                every request refused with a 429 (a request-rate limit, HI-1973): Copilot tries again
//                              5 times, its error hook each time, then gives up (a rate_limit session error)
// Combwork's notices (#650: "[CW] New in your inbox…" added to a tool's result, "[CW] Before you finish…" as the prompt
// its Stop carried the turn on with) and its doorbell (the prompt "[CW] New in your inbox…") are followed as a model does:
// cw_inbox, then cw_inbox with ack for its ids; new work read so (a task, a handover) is then the prompt's steps.
// One step a model call: each tool's result comes back in the next request, which gets the next step. Every request is
// logged (`log`: one JSON line each, with the tools Copilot offered and the system prompt's length), so a suite can see
// what Copilot sent. Usage is reported with each reply (tokens, as an API would), so Combwork has some to count.
//
// node fake-copilot-api.cjs [port] [log]   runs it on its own (port 0: any free one), for probes.
const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const { parseHiveStep, isDoorbell, doorbellIsWork, inboxRows } = require('./fake-bridge.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A message's text, whatever its shape (a string, or parts). */
function textOf(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) return m.content.map((c) => c.text ?? '').join('')
  return ''
}

/** What the person wrote: Copilot sends it after a <current_datetime> line and other tags it adds. */
function promptOf(text) {
  return text.replace(/<current_datetime>[\s\S]*?<\/current_datetime>/g, '').replace(/<reminder>[\s\S]*?<\/reminder>/g, '').trim()
}

/** The tool Copilot offers under `name`, or one of its MCP tools named `<server>-<name>`; null when it offers neither. */
function offered(tools, name) {
  const names = (tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean)
  return names.find((n) => n === name) ?? names.find((n) => n.endsWith(`-${name}`)) ?? null
}

/** A prompt's steps as actions: { tool, args } calls, { wait } pauses and { say } replies. */
function actionsOf(prompt) {
  const out = []
  for (const raw of prompt.split(' then ')) {
    const step = raw.trim()
    let m
    for (const s of step.matchAll(/\bskill\s+([a-z0-9][\w-]*)/gi)) out.push({ tool: 'skill', args: { skill: s[1] } })
    for (const s of step.matchAll(/\bskillref\s+([a-z0-9][\w-]*)\s+([\w.-]+\.md)/gi)) out.push({ tool: 'view', args: { path: `.agents/skills/cw-${s[1]}/${s[2]}` }, ref: { skill: s[1], file: s[2] } })
    if ((m = /\bboardmove\s+(\d+)\s+(\w+)/i.exec(step))) out.push({ tool: 'cw_update_task', args: { number: Number(m[1]), column: m[2].toLowerCase() } })
    if ((m = /\bboardreview\s+(\d+)\s+(\w+)(?:\s+(hold|todo|doing|review|passed|done)\b)?/i.exec(step))) out.push({ tool: 'cw_update_task', args: { number: Number(m[1]), review: m[2].toLowerCase(), ...(m[3] ? { column: m[3].toLowerCase(), comment: 'Fake review: passed.' } : {}) } })
    if ((m = /\bboardcomment\s+(\d+)/i.exec(step))) out.push({ tool: 'cw_update_task', args: { number: Number(m[1]), comment: 'Fake: done, see the files.' } })
    const call = parseHiveStep(step)
    if (call) out.push({ tool: call.tool, args: call.args })
    // Anywhere in the step, as the fake CLIs read it ("… (work 10)").
    if ((m = /\bwork\s+(\d+)/i.exec(step))) out.push({ wait: Number(m[1]) * 1000 })
    if ((m = /^edit\s+(\S+)\s+(\S+)\s+(\S+)$/i.exec(step))) out.push({ tool: 'edit', args: { path: m[1], old_str: m[2], new_str: m[3] } })
    if ((m = /^write\s+(\S+)\s+([\s\S]+)$/i.exec(step))) out.push({ tool: 'create', args: { path: m[1], file_text: `${m[2]}\n` } })
    if ((m = /^view\s+(\S+)$/i.exec(step))) out.push({ tool: 'view', args: { path: m[1] } })
    // "checkpoint": a tool call of its own, after which Combwork's notice may come (#650).
    if (/^checkpoint$/i.test(step)) out.push({ tool: 'view', args: { path: 'README.md' } })
    if ((m = /^shell:?\s+([\s\S]+)$/i.exec(step))) out.push({ tool: 'powershell', args: { command: m[1], description: 'Run a command', mode: 'sync', initial_wait: 30 } })
    if (/^question$/i.test(step)) out.push({ tool: 'ask_user', args: { message: 'Which one should I use?', requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['first', 'second'] } }, required: ['choice'] } } })
    if ((m = /^say\s+([\s\S]+)$/i.exec(step))) out.push({ say: m[1] })
  }
  return out
}

/** An assistant message that calls cw_inbox (a notice followed), and its arguments. */
function inboxCall(m) {
  const c = m.role === 'assistant' && Array.isArray(m.tool_calls) ? m.tool_calls.find((t) => (t.function?.name ?? '').endsWith('cw_inbox')) : null
  if (!c) return null
  try {
    return JSON.parse(c.function.arguments || '{}')
  } catch {
    return {}
  }
}

/**
 * Combwork's notice (#650: "[CW] New in your inbox…" after a tool's result, as Copilot adds a postToolUse hook's context,
 * or "[CW] Before you finish…", the prompt its Stop carried the turn on with), followed as a model does: cw_inbox,
 * then cw_inbox with ack for the ids it listed. The call to make, or null (no notice, or followed already).
 */
function followNotice(msgs, tools) {
  // Where Copilot puts one, not a mention of one (Combwork's guidance and skills quote them): after a tool's result, or the
  // whole prompt.
  const isNotice = (m) => (m.role === 'tool' && /Additional guidance from postToolUse hooks:\s*\[CW\] New in your inbox/.test(textOf(m))) || (m.role === 'user' && /^\[CW\] (New in your inbox|Before you finish)/.test(promptOf(textOf(m))))
  const k = msgs.findLastIndex(isNotice)
  const name = offered(tools, 'cw_inbox')
  if (k < 0 || !name) return null
  const after = msgs.slice(k + 1)
  const calls = after.map(inboxCall).filter(Boolean)
  if (!calls.length) return { tool: name, args: {} }
  if (calls.some((a) => Array.isArray(a.ack))) return null
  const listed = after.find((m) => m.role === 'tool' && /\bnew:/.test(textOf(m)))
  const ids = [...new Set([...textOf(listed).matchAll(/\bm\d+\b/g)].map((x) => x[0]))]
  return ids.length ? { tool: name, args: { ack: ids } } : null
}

/**
 * The reply to one chat request: the next step's tool call (counting the tool calls already made since the person's
 * prompt), or the turn's last reply. `wait`: how long to pause first (work N steps before it). `prompt` and `step` say
 * what it went by, for the log.
 */
function decide(body) {
  const msgs = body.messages ?? []
  // The person's prompt: the last user message Copilot dated (<current_datetime>). Copilot adds others in a turn (a skill
  // it loaded comes back as one), which aren't the person's.
  let at = -1
  for (let i = msgs.length - 1; i >= 0 && at < 0; i--) if (msgs[i].role === 'user' && /<current_datetime>/.test(textOf(msgs[i]))) at = i
  if (at < 0) at = msgs.findLastIndex((m) => m.role === 'user')
  let prompt = promptOf(textOf(msgs[at]))
  const notice = followNotice(msgs, body.tools)
  if (notice) return { prompt: prompt.slice(0, 160), step: 'notice', wait: 0, ...notice }
  // Combwork's doorbell (#650), read (the notice above): new work it read (a task, a handover) is what it does; anything else
  // (a wake, a message) it has read, and its turn ends.
  if (isDoorbell(prompt)) {
    const listed = msgs.slice(at + 1).find((m) => m.role === 'tool' && /\bnew:/.test(textOf(m)))
    prompt = doorbellIsWork(prompt) ? inboxRows(textOf(listed)).map((x) => x.text).join(' ') : ''
  }
  // Its own steps' calls: those it made to follow a notice don't count.
  const done = msgs.slice(at + 1).filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length && !inboxCall(m)).length
  const actions = actionsOf(prompt)
  const out = { prompt: prompt.slice(0, 160), step: done }
  let wait = 0
  let n = 0
  for (const a of actions) {
    if (a.wait) {
      if (n >= done) wait += a.wait
      continue
    }
    if (a.say) continue
    if (n === done) {
      const name = offered(body.tools, a.tool)
      // A reference file: its link in SKILL.md as Copilot gave it (its skill tool says "loaded", and the skill comes as
      // context of its own), else a path that isn't there.
      const linked = !a.ref || msgs.some((m) => textOf(m).includes(`](${a.ref.file})`) || textOf(m).includes(`](./${a.ref.file})`))
      const args = linked ? a.args : { path: `.agents/skills/cw-${a.ref.skill}/no-link-to-${a.ref.file}` }
      return name ? { ...out, wait, tool: name, args } : { ...out, wait, text: `Fake Copilot: Copilot offers no tool ${a.tool}.` }
    }
    n++
  }
  const say = actions.filter((a) => a.say).pop()?.say
  // A turn takes a moment at least, as the fake CLIs' scripted turns do: one over at once can end between two looks at
  // the agent, which then never seems to have worked.
  return { ...out, wait: Math.max(wait, 1500), text: say ?? (actions.length || !prompt ? 'Done.' : `Fake Copilot: ${prompt.slice(0, 80)}`) }
}

const USAGE = { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240, prompt_tokens_details: { cached_tokens: 1000 } }

/** One reply as server-sent events, the way Copilot streams them (a tool call, or text), with the usage last. */
function stream(res, model, id, d) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  if (d.tool) {
    chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: d.tool, arguments: '' } }] }, null)
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(d.args) } }] }, null)
    chunk({}, 'tool_calls')
  } else {
    chunk({ role: 'assistant', content: '' }, null)
    chunk({ content: d.text }, null)
    chunk({}, 'stop')
  }
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: USAGE })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * Starts the stand-in on 127.0.0.1 (`port` 0: any free port). Resolves { port, url (…/v1, for COPILOT_PROVIDER_BASE_URL),
 * requests (how many chat requests it answered), close() }. `systems`: every request's system prompt in full in the log,
 * not only the first's (several sessions' instructions, #1433).
 */
function startFakeCopilotApi({ port = 0, log = null, systems = false } = {}) {
  let n = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = null
      }
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', owned_by: 'fake' }] }))
      }
      if (!req.url.includes('/chat/completions') || !body) {
        res.writeHead(404)
        return res.end()
      }
      const id = `fake${++n}`
      const d = decide(body)
      // "ratelimited" (HI-1973): refused as too many requests, as an OpenAI-style API says it.
      if (/\bratelimited\b/i.test(d.prompt ?? '')) {
        if (log) fs.appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), id, prompt: d.prompt, step: 'ratelimited', status: 429 })}\n`)
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        return res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }))
      }
      if (log) {
        const system = (body.messages ?? []).find((m) => m.role === 'system')
        // The system prompt (about 27 KB) in full only with the first request (each, with `systems`); its length with each.
        const sys = textOf(system)
        fs.appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), id, prompt: d.prompt, step: d.step, reply: d.tool ? { tool: d.tool, args: d.args } : { text: d.text }, tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name), systemLength: sys.length, ...(n === 1 || systems ? { system: sys } : {}) })}\n`)
      }
      if (d.wait) await sleep(d.wait)
      if (body.stream) return stream(res, body.model, id, d)
      res.writeHead(200, { 'content-type': 'application/json' })
      const message = d.tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${id}`, type: 'function', function: { name: d.tool, arguments: JSON.stringify(d.args) } }] } : { role: 'assistant', content: d.text }
      res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message, finish_reason: d.tool ? 'tool_calls' : 'stop' }], usage: USAGE }))
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port
      resolve({
        port: p,
        url: `http://127.0.0.1:${p}/v1`,
        get requests() {
          return n
        },
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

/**
 * The environment the real Copilot CLI needs to use the stand-in, for a test Combwork's hiveEnv: offline, this API, a model
 * id it knows. Its home (COPILOT_HOME) and the hidden GitHub CLI login (GH_CONFIG_DIR) come from the caller.
 */
function offlineEnv(api) {
  return { COPILOT_OFFLINE: 'true', COPILOT_PROVIDER_BASE_URL: api.url, COPILOT_MODEL: 'gpt-4.1' }
}

/**
 * A test Combwork's environment for running the real Copilot CLI offline against `api`, in folders of the caller's (`dir`):
 * its own COPILOT_HOME, a fake profile folder (Copilot also reads ~/.agents and the like), and the GitHub CLI's login
 * hidden (an empty GH_CONFIG_DIR, gh off PATH: with no stored login Copilot signs in with `gh auth token`). Never the
 * user's ~/.copilot, and no token variable (hiveEnv's allowlist passes none).
 * `above`, the profile folder, is a folder above every folder this Copilot works in (its workspace, projects,
 * worktrees, the Assistant's home): outside a git repository Copilot takes skills from every folder above its working
 * folder up to its profile folder, so one under the user's profile (hive-test is) would otherwise reach the user's own
 * ~\.claude\skills (#1308, tests/e2e/README.md).
 */
function copilotTestEnv(api, dir, { above } = {}) {
  if (!above) throw new Error('copilotTestEnv: give `above`, a folder above every folder Copilot works in (#1308)')
  const home = path.join(dir, 'copilot-home')
  const profile = above
  const gh = path.join(dir, 'copilot-gh')
  for (const d of [home, profile, gh]) fs.mkdirSync(d, { recursive: true })
  const PATH = pathWithoutGh(process.env.PATH || '')
  // Checked as Windows finds programs, so nothing on this PATH can run gh (and reach a real login through it).
  const where = spawnSync('where.exe', ['gh'], { encoding: 'utf8', env: { PATH, PATHEXT: process.env.PATHEXT ?? '', SystemRoot: process.env.SystemRoot ?? '' } })
  if (where.status === 0) throw new Error(`gh is still on the test PATH: ${where.stdout.trim()}`)
  return { PATH, USERPROFILE: profile, HOME: profile, COPILOT_HOME: home, GH_CONFIG_DIR: gh, ...offlineEnv(api) }
}

/** The names Windows runs a command by: bare (a script for Git Bash), each PATHEXT extension, and PowerShell's .ps1. */
const launcherNames = (name, pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD') => [name, ...pathext.split(';').filter(Boolean).map((e) => name + e.toLowerCase()), `${name}.ps1`]

/** The file a folder runs `name` with, or null. */
function launcherIn(dir, name, pathext) {
  for (const n of launcherNames(name, pathext)) {
    try {
      if (fs.statSync(path.join(dir, n)).isFile()) return path.join(dir, n)
    } catch {
      // Not there.
    }
  }
  return null
}

/**
 * A PATH with no way to run the GitHub CLI: every folder holding a gh launcher is left out, whatever the folder is called
 * (its own install, a portable folder, a shared one such as WinGet's Links). Copilot falls back to `gh auth token` for
 * its sign-in, so a test Copilot must find no gh at all (GH_CONFIG_DIR, empty, is the second layer). A tool tests need
 * (`needed`) that only such a folder held stays reachable through the folder its file links to (WinGet's Links are links
 * to each package's own folder), when that one has no gh; otherwise this throws, naming the tool, rather than leave gh
 * on PATH or a tool off it. `realpath` is for tests.
 */
function pathWithoutGh(value, { needed = ['git', 'node', 'copilot'], pathext = process.env.PATHEXT, realpath = fs.realpathSync } = {}) {
  const out = []
  const stranded = []
  const add = (d) => {
    if (!out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d)
  }
  for (const dir of value.split(';').filter(Boolean)) {
    if (!launcherIn(dir, 'gh', pathext)) {
      add(dir)
      continue
    }
    for (const tool of needed) {
      const file = launcherIn(dir, tool, pathext)
      if (!file) continue
      let real = null
      try {
        real = realpath(file)
      } catch {
        real = null
      }
      const home = real ? path.dirname(real) : null
      if (home && home.toLowerCase() !== dir.toLowerCase() && !launcherIn(home, 'gh', pathext)) add(home)
      else stranded.push({ tool, dir })
    }
  }
  const lost = stranded.filter((s) => !out.some((d) => launcherIn(d, s.tool, pathext)))
  if (lost.length) throw new Error(`Can't hide the GitHub CLI without losing ${lost.map((s) => `${s.tool} (it shares ${s.dir} with gh)`).join(', ')}`)
  return out.join(';')
}

/** Whether the standalone Copilot CLI is installed where Combwork looks for it (PATH, WinGet's link, npm's launcher). */
function copilotInstalled() {
  const { baseEnv } = require('./runContext.cjs')
  try {
    const out = execFileSync('where.exe', ['copilot'], { encoding: 'utf8', env: baseEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    if (out.split(/\r?\n/).some((l) => /\.(exe|cmd)$/i.test(l.trim()))) return true
  } catch {
    // Not on PATH.
  }
  const winget = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'copilot.exe') : null
  const npm = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'copilot.cmd') : null
  return [winget, npm].some((p) => p && fs.existsSync(p))
}

module.exports = { startFakeCopilotApi, offlineEnv, copilotTestEnv, copilotInstalled, pathWithoutGh, actionsOf, decide }

if (require.main === module) {
  startFakeCopilotApi({ port: Number(process.argv[2] ?? 0), log: process.argv[3] ?? null }).then((api) => console.log(`fake Copilot API on ${api.url}`))
}
