// Mock Agent API + drive out/main/hive-mcp.js over stdio.
const lib = require('./lib.cjs')
const path = require('path')
const http = require('http'), { spawn } = require('child_process')
const tree = [{ relPath: 'handovers', name: 'handovers', isDir: true, children: [
  { relPath: 'handovers/README.md', name: 'README.md', isDir: false },
  { relPath: 'handovers/2026-09-28-hive-initial-build.md', name: '2026-09-28-hive-initial-build.md', isDir: false },
  { relPath: 'handovers/2026-09-29-hive-image-paste.md', name: '2026-09-29-hive-image-paste.md', isDir: false },
  { relPath: 'handovers/2026-09-30-mcp-server-work.md', name: '2026-09-30-mcp-server-work.md', isDir: false }
] }]
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  res.setHeader('Content-Type', 'application/json')
  if (u.pathname === '/v1/shared') return res.end(JSON.stringify(tree))
  // A project's handovers, newest first (#514: Hive finds them; here by the file name alone).
  if (u.pathname === '/v1/shared/handovers') {
    const want = u.searchParams.get('project')
    const files = tree[0].children.filter((f) => f.name !== 'README.md' && (!want || f.name.slice(11).startsWith(`${want}-`)))
    return res.end(JSON.stringify(files.map((f) => ({ path: f.relPath })).reverse()))
  }
  if (u.pathname === '/v1/shared/file') return res.end(JSON.stringify({ path: u.searchParams.get('path'), content: '# content of ' + u.searchParams.get('path') }))
  res.statusCode = 404; res.end('{}')
})
srv.listen(0, async () => {
  const port = srv.address().port
  const run = (project, msgs) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(lib.ROOT, 'dist/win-unpacked/resources/app.asar.unpacked/out/main/cw-mcp.js')], { env: lib.childEnv({ CW_API_URL: `http://127.0.0.1:${port}`, CW_API_TOKEN_FILE: lib.tokenFile('t'), CW_PROJECT: project }) })
    let out = ''
    p.stdout.on('data', (d) => { out += d; if (out.trim().split('\n').length >= msgs.length) { p.kill(); resolve(out.trim().split('\n').map((l) => JSON.parse(l))) } })
    for (const m of msgs) p.stdin.write(JSON.stringify(m) + '\n')
  })
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cw_read_latest_handover', arguments: {} } }
  ]
  for (const project of ['hive', 'mcp', 'other']) {
    const r = await run(project, msgs)
    const init = r.find((x) => x.id === 1), call = r.find((x) => x.id === 2)
    console.log(`--- ${project}`)
    console.log(init.result.instructions.split('\n').slice(-1)[0])
    console.log('tool ->', call.result.content[0].text.replace(/\s+/g, ' ').slice(0, 120))
  }
  srv.close()
})
