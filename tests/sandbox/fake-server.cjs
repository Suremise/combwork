// Tests only (tests/sandboxChecks.test.ts): a fake windows-sandbox MCP server, so the Sandbox checks' runner is tested
// without the hive-mcp project or a Sandbox. It answers the tools the runner calls over stdio, in the server's reply
// shapes the runner reads, and records each call in the state file it shares with stub-wsb.cjs (WSB_STUB_STATE):
//   { sandboxes: [id], calls: [['env', its settings] | ['start', args] | ['run', command] | ['stop', id, 'server'] ...],
//     fail: { stop: n, guest: [{ match, exit, stdout, stderr }] } }
// fail.guest scripts what a guest command answers: the first whose match (a regex) finds the command; else exit 0.
// Like the real server, it stops its Sandbox when its input ends.
const fs = require('fs')
const crypto = require('crypto')
const { createInterface } = require('readline')

const file = process.env.WSB_STUB_STATE
const read = () => { const s = JSON.parse(fs.readFileSync(file, 'utf8')); s.calls ||= []; s.sandboxes ||= []; s.fail ||= {}; return s }
const write = s => fs.writeFileSync(file, JSON.stringify(s))
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError })
// A 1×1 JPEG is enough: the runner only saves what it gets.
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z'

let current = null
function stop() {
  const s = read()
  s.calls.push(['stop', current, 'server'])
  if (s.fail.stop) {
    if (s.fail.stop > 0) s.fail.stop--
    write(s)
    return false
  }
  s.sandboxes = s.sandboxes.filter(x => x !== current)
  write(s)
  current = null
  return true
}

const tools = {
  sandbox_start(args) {
    const s = read()
    current = crypto.randomUUID()
    // What the runner gave it: its settings, and one variable of the shell's that it mustn't pass on.
    const env = n => process.env[n] ?? null
    s.calls.push(['env', { WSB_SANDBOX_ROOT: env('WSB_SANDBOX_ROOT'), WSB_TOOL_DIRS: env('WSB_TOOL_DIRS'), WSB_MCP_ENABLED: env('WSB_MCP_ENABLED'), WSB_ALLOWED_ROOTS: env('WSB_ALLOWED_ROOTS'), HIVE_API_TOKEN: env('HIVE_API_TOKEN') }])
    s.calls.push(['start', args])
    s.sandboxes.push(current)
    write(s)
    return text(`Started Sandbox ${current}, network off.\nUser session ready.${args.smartAppControl === 'off' ? '\nSmart App Control: turned off in this Sandbox by option.' : ''}`)
  },
  sandbox_run({ command }) {
    const s = read()
    s.calls.push(['run', command])
    write(s)
    const g = (s.fail.guest || []).find(x => new RegExp(x.match).test(command)) || {}
    const exit = g.exit ?? 0
    return text(`exit ${exit} in 0.1 s\n--- stdout\n${g.stdout || ''}\n--- stderr\n${g.stderr || ''}`)
  },
  sandbox_screenshot() {
    return { content: [{ type: 'text', text: 'desktop' }, { type: 'image', data: JPEG, mimeType: 'image/jpeg' }] }
  },
  sandbox_collect() {
    return text('Files in C:\\out: none')
  },
  sandbox_stop() {
    if (!current) return text('No Sandbox is running.')
    const id = current
    return stop() ? text(`Stopped Sandbox ${id} (confirmed).`) : text(`Stop of Sandbox ${id} NOT confirmed.`, true)
  }
}

createInterface({ input: process.stdin }).on('line', l => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-windows-sandbox', version: '0' } } })
  if (m.method !== 'tools/call') return m.id !== undefined && m.method ? send({ id: m.id, error: { code: -32601, message: 'Method not found' } }) : undefined
  const tool = tools[m.params.name]
  send({ id: m.id, result: tool ? tool(m.params.arguments || {}) : text(`Unknown tool ${m.params.name}`, true) })
}).on('close', () => {
  if (current) stop()
})
