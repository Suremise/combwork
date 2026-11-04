// The hive MCP bridge's metrics reports (POST /v1/metrics/mcp) never hold it up: against a mock Agent API that answers
// tool calls but never answers a report, the replies come at once, at most one report is in flight however many calls
// there are, and once its CLI closes its input the bridge exits within the report's own deadline (3 s) plus a margin,
// not after one deadline per batch. Uses the built bridge (out/main/hive-mcp.js; npx electron-vite build first) and
// no Hive app or profile.
const lib = require('./lib.cjs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  let reportsInFlight = 0
  let maxInFlight = 0
  let reports = 0
  const held = []
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/v1/metrics/mcp')) {
      // A stalled endpoint: read the report, never answer.
      reports++
      reportsInFlight++
      maxInFlight = Math.max(maxInFlight, reportsInFlight)
      req.on('data', () => undefined)
      req.on('close', () => reportsInFlight--)
      held.push(res)
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(req.url.startsWith('/v1/tasks') ? '[]' : '{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const API = `http://127.0.0.1:${server.address().port}`
  const env = lib.childEnv({ CW_API_URL: API, CW_API_TOKEN_FILE: lib.tokenFile('test-token'), CW_PROJECT: 'alpha' })

  /** Runs the bridge with `calls` tool calls, closes its input once every reply is in, and times its exit from there. */
  const run = (calls) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      let replies = 0
      let closedAt = 0
      const started = Date.now()
      child.stdout.on('data', (d) => {
        out += d
        replies = out.split('\n').filter((l) => l.includes('"result"')).length
        if (replies === calls && !closedAt) {
          closedAt = Date.now()
          child.stdin.end()
        }
      })
      child.on('exit', () => resolve({ replies, replyMs: closedAt - started, exitMs: Date.now() - closedAt }))
      for (let i = 0; i < calls; i++) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'cw_list_tasks', arguments: {} } }) + '\n')
    })

  const one = await run(1)
  check('a stalled report endpoint: the reply comes at once', one.replies === 1 && one.replyMs < 3000, JSON.stringify(one))
  check('…and the bridge exits within the report deadline, not waiting on it', one.exitMs < 4500, JSON.stringify(one))

  reports = 0
  maxInFlight = 0
  const burst = await run(150)
  check('a burst of 150 calls: every reply comes', burst.replies === 150, JSON.stringify(burst))
  check('…with at most one report in flight', maxInFlight <= 1, `max ${maxInFlight}, ${reports} sent`)
  check('…and the bridge still exits within one deadline (the rest dropped, not queued per batch)', burst.exitMs < 4500, JSON.stringify(burst))

  for (const r of held) r.destroy()
  server.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
