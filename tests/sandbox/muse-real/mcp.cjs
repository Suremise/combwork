// A minimal stdio MCP server standing in for Combwork's tools in the Sandbox check (HI-3202): logs its start, with
// CW_PROBE as Muse resolved it from its ${VAR}, and each request, to argv[3]; lists one tool.
const fs = require('fs')
const name = process.argv[2] || 'unnamed'
const file = process.argv[3]
const log = (s) => fs.appendFileSync(file, `${new Date().toISOString()} ${s}\n`)
log(`started CW_PROBE=${process.env.CW_PROBE}`)
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    log(`<- ${msg.method ?? 'reply'}`)
    if (msg.id === undefined) continue
    let result = {}
    if (msg.method === 'initialize') result = { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '0.0.1' } }
    else if (msg.method === 'tools/list') result = { tools: [{ name: `${name}_ping`, description: 'probe', inputSchema: { type: 'object', properties: {} } }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  }
})
