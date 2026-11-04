// The fake CLIs' way to call Hive's tools: through the real hive MCP server, started as the launch configured it (its
// command, arguments and environment), so a scripted call is what a model's call would be. The server runs the call
// against the Agent API, logs it (HIVE_TEST_MCP_LOG) and reports its reply's size to Hive's performance metrics, as
// it does for a real CLI. Used by fake-claude and fake-codex for their "hive", "boardmove", "boardreview" and
// "boardcomment" steps.
const { spawn } = require('child_process')

/**
 * Calls `tool` with `args` on the hive MCP server `server` ({ command, args, env }): initialize, tools/list, the call,
 * then end of input (the server sends its metrics report and exits). Resolves { text, isError }.
 */
function callHiveTool(server, tool, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...server.env }
    const p = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let buf = ''
    let result = null
    const done = (r) => {
      if (result) return
      result = r
      clearTimeout(timer)
      // End of input: the server flushes its metrics report and exits (waited for, so the report isn't lost).
      p.stdin.end()
    }
    const timer = setTimeout(() => {
      done({ text: 'The hive server did not answer', isError: true })
      p.kill()
    }, timeoutMs)
    p.on('exit', () => resolve(result ?? { text: 'The hive server exited', isError: true }))
    p.on('error', (e) => {
      done({ text: String(e), isError: true })
      resolve(result)
    })
    p.stdout.on('data', (d) => {
      buf += d
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        let m
        try {
          m = JSON.parse(buf.slice(0, i))
        } catch {
          m = null
        }
        buf = buf.slice(i + 1)
        if (m?.id === 3) done({ text: (m.result?.content ?? []).map((c) => c.text ?? '').join('\n') || JSON.stringify(m.error ?? null), isError: !!(m.error || m.result?.isError) })
      }
    })
    const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list' })
    send({ id: 3, method: 'tools/call', params: { name: tool, arguments: args } })
  })
}

/**
 * Connects the launch's hive MCP server as a CLI does when it starts (#865): initialize and notifications/initialized,
 * which the server tells Hive of (POST /v1/launch/connected), then end of input (it exits once that is sent). `held`:
 * a promise to wait for first (a test holding the connection back, as a resumed Claude Code connects after its
 * SessionStart). Resolves once the server has exited; never fails.
 */
async function connectHive(server, held) {
  if (!server) return
  if (held) await held
  await new Promise((resolve) => {
    const p = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => p.kill(), 30000)
    p.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    p.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
    const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
    send({ method: 'notifications/initialized' })
    p.stdin.end()
  })
}

/**
 * A Codex inline table as Hive writes it (`-c mcp_servers.combwork={command="…",args=["…"],env={K="…"}}`: strings are JSON
 * strings, keys bare or JSON strings) as an object.
 */
function fromCodexTable(text) {
  let json = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      // A JSON string, copied as it is.
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      json += text.slice(i, j + 1)
      i = j
    } else if (c === '=') json += ':'
    else if (/[A-Za-z0-9_-]/.test(c)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_.-]/.test(text[j])) j++
      const word = text.slice(i, j)
      json += /^(true|false|-?\d+(\.\d+)?)$/.test(word) ? word : JSON.stringify(word)
      i = j - 1
    } else json += c
  }
  return JSON.parse(json)
}

/**
 * Parses a scripted "hive TOOL {json}" step's arguments: the JSON object after the tool's name (no " then " in it), or
 * none.
 */
function parseHiveStep(step) {
  const m = /\bhive\s+(cw_[a-z_]+)(?:\s+(\{.*\}))?/i.exec(step)
  if (!m) return null
  let args = {}
  try {
    args = m[2] ? JSON.parse(m[2]) : {}
  } catch {
    args = {}
  }
  return { tool: m[1], args }
}

/** Whether a prompt is Hive's doorbell (#650): its fixed words naming what waits in the agent's inbox by id. */
const isDoorbell = (text) => String(text).startsWith('[CW] New in your inbox: ')

/**
 * Whether a doorbell names only tasks and handovers (a new piece of work, whose text is the agent's next prompt), not
 * wakes, messages or notices.
 */
const doorbellIsWork = (text) => /^\[CW\] New in your inbox: (\d+ (task|tasks|handover|handovers)( \(#[\d, #]+\))?( and |, )?)+ \(m/.test(String(text))

/**
 * cw_inbox's reply (shared/deliveries.ts inboxText) as its items: { ids, from, card, text }, oldest first. An item's
 * text may run over several lines (a task's); the reply's own lines (its count, what was received before, the ack note,
 * and what Hive adds to a tool's reply, such as #357's "[CW] #12 has 1 new decision…") aren't items.
 */
function inboxRows(reply) {
  const rows = []
  let open = false
  for (const line of String(reply ?? '').split('\n')) {
    const m = /^(m\d+(?:,m\d+)*) · (.+?)(?: · #(\d+))?: (.*)$/.exec(line)
    if (m) {
      rows.push({ ids: m[1].split(','), from: m[2], card: m[3] ? Number(m[3]) : null, text: m[4] })
      open = true
    } else if (/^(Received before, not acked yet: |Ack each with cw_inbox |\[CW\] )/.test(line)) open = false
    else if (open) rows[rows.length - 1].text += `\n${line}`
  }
  return rows
}

module.exports = { callHiveTool, connectHive, fromCodexTable, parseHiveStep, isDoorbell, doorbellIsWork, inboxRows }
