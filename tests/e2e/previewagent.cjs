// cw_preview, agents' own previews (HI-3616, design HI-3597 s8, s16 §E tests 1 and 6, SPEC §16.21.2): fake Claude Code
// agents call the real tool through the combwork MCP server of their own launches (its mcp-config, their own tokens):
// - Off: an agent launched with the Preview off isn't offered cw_preview, nor one whose project has no preview set up,
//   nor the Assistant; turned on with a command, a new launch is.
// 1. Its own place only: A (alpha's folder) reaches alpha's preview, never the slot's preview B1 runs under its lease;
//    naming a folder, place or project is refused; C (beta) reaches beta's alone; a non-agent caller is refused.
// 6. Captures: a 20000 px page is cut at 6000 and says so; a high-entropy page comes back a JPEG within 2 MB; a limit no
//    step meets gives the error and no file; a noisy console gives 20 entries and the count; 21 shots keep 20; Stop
//    removes them. Each reply starts with the stamp; the snapshot reads the page's tree, says the page is untrusted, and
//    says when the files changed after the page loaded; goto refuses another origin's path.
// Dev build, throwaway profile and workspace. Ports: its preview range (PREVIEW_BASE) from its Agent API port, as the other
// preview suites.
// Dev build only (#1578): slots:test and preview:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

// Above the e2e lanes' ports (lanes.mjs: 47939–48128), below Windows' dynamic range.
const PORT = Number(lib.port(48303))
const fx = q.queueProject('previewagent')
const beta = path.join(fx.ws, 'beta')
const HUNG_MS = lib.timing('hang.step')
const PREVIEW_BASE = 50000 + ((PORT * 37) % 13000)
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

/** The combwork server a launch was given (its mcp-config). */
const serverOf = (launch) => JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork

/** The combwork server of the launch whose token is `token` (each run has its own). */
function serverFor(token) {
  for (const l of q.launches(fx).reverse()) {
    if (!l.opts['--mcp-config'] || !fs.existsSync(l.opts['--mcp-config'])) continue
    const s = serverOf(l)
    const file = s?.env?.CW_API_TOKEN_FILE
    if (file && fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).token === token) return s
  }
  throw new Error('no launch has that token')
}

/**
 * One JSON-RPC call to the launch's own combwork server, as its CLI makes it. Never a synchronous spawn: Playwright holds a
 * new page's first navigation until this process tells it to go, so blocking here while Combwork loads its agents' page
 * would wait on itself.
 */
function rpc(server, method, params) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], { env: lib.childEnv(server.env), timeout: lib.timing('spawn.hang') }, (err, out) => {
      if (err) return reject(err)
      resolve(JSON.parse(String(out).split('\n')[0]).result)
    })
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
  })
}
const toolNames = async (server) => (await rpc(server, 'tools/list', {})).tools.map((t) => t.name)
const callTool = async (server, args) => {
  const r = await rpc(server, 'tools/call', { name: 'cw_preview', arguments: args })
  return { text: r.content[0].text, isError: !!r.isError }
}

/** The Agent API as a token's caller: { status, body }. */
async function api(token, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/preview`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const shotsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('shot-')) : [])
/** A shot's path from its reply. */
const shotPath = (text) => /Screenshot: (.+?) \(/.exec(text)?.[1] ?? null

;(async () => {
  q.prepare(fx)
  lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.combwork/\n' })
  // The stand-in dev server: its pages by path, logging a line as it starts.
  const server = path.join(fx.tools, 'site.js')
  fs.writeFileSync(
    server,
    [
      "const http = require('http')",
      'const port = Number(process.env.PORT)',
      'const pages = {',
      "  '/': '<title>Home</title><h1>Hello</h1><button>Go</button><input aria-label=\"Name\" value=\"x\"><a href=\"http://127.0.0.2:9/\">away</a>',",
      "  '/tall': '<title>Tall</title><body style=\"margin:0\"><div style=\"height:20000px;background:linear-gradient(red,blue)\">tall</div></body>',",
      "  '/noise': '<title>Noise</title><body style=\"margin:0;overflow:hidden\"><canvas id=c width=1280 height=800></canvas><script>const c=document.getElementById(\"c\").getContext(\"2d\");const d=c.createImageData(1280,800);for(let i=0;i<d.data.length;i++)d.data[i]=i%4===3?255:Math.random()*256|0;c.putImageData(d,0,0)</script></body>',",
      "  '/noisy': '<title>Noisy</title><script>for(let i=0;i<30;i++)console.error(\"e\"+i);console.warn(\"w\".repeat(1000));console.log(\"not counted\")</script>',",
      "  '/big': '<title>Big</title>' + Array.from({ length: 800 }, (_, i) => '<p>paragraph number ' + i + ' of the long page</p>').join('')",
      '}',
      "http.createServer((q, r) => { const p = pages[q.url.split('?')[0]]; r.writeHead(p ? 200 : 404, { 'content-type': 'text/html' }); r.end(p ?? 'none') }).listen(port, '127.0.0.1', () => console.log('site listening on ' + port))",
      ''
    ].join('\n')
  )
  const cmd = `node "${server}"`
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
  try {
    const { inv } = h
    const projects = (await inv('workspace:refresh')).projects.map((p) => p.path.toLowerCase())
    check('the workspace has alpha and beta', projects.includes(fx.alpha.toLowerCase()) && projects.includes(beta.toLowerCase()), JSON.stringify(projects))

    // --- Off: no cw_preview for an agent launched with the Preview off.
    const early = await q.agent(fx, h, 'Early')
    const earlyServer = serverFor(early.token)
    check('off: an agent launched with the Preview off has no CW_PREVIEW', earlyServer.env.CW_PREVIEW === undefined, JSON.stringify(earlyServer.env.CW_PREVIEW))
    const earlyTools = (await toolNames(earlyServer))
    check('…and is offered no cw_preview (its other tools are there)', !earlyTools.includes('cw_preview') && earlyTools.includes('cw_read_task'), earlyTools.join(','))
    const offCall = await api(early.token, { action: 'status' })
    check('…and the API refuses it while the Preview is off', offCall.status === 403 && /Preview is off/.test(JSON.stringify(offCall.body)), JSON.stringify(offCall))

    // --- On, with alpha's command and beta's.
    await inv('advanced:set', 'cw.preview.enabled', true)
    await inv('advanced:set', 'cw.preview.startSeconds', 10)
    await inv('advanced:set', 'cw.preview.portRange', PREVIEW_BASE)
    const unset = await q.agent(fx, h, 'Unset', { project: beta })
    const unsetServer = serverFor(unset.token)
    check("on, but beta's preview not set up: a launch there has no cw_preview", !(await toolNames(unsetServer)).includes('cw_preview') && !!unset.token)
    await inv('preview:setConfig', fx.alpha, { command: cmd })
    await inv('preview:setConfig', beta, { command: cmd })
    const a = await q.agent(fx, h, 'A')
    const aServer = serverFor(a.token)
    const c = await q.agent(fx, h, 'C', { project: beta })
    const cServer = serverFor(c.token)
    check('on, set up: a new launch has CW_PREVIEW and is offered cw_preview', aServer.env.CW_PREVIEW === '1' && (await toolNames(aServer)).includes('cw_preview'), JSON.stringify(aServer.env.CW_PREVIEW))
    check("…in beta's too", (await toolNames(cServer)).includes('cw_preview'))
    check("…and the Assistant's tool list never has it", !(await rpc({ env: { ...aServer.env, CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects' } }, 'tools/list', {})).tools.some((t) => t.name === 'cw_preview'))

    // --- 1. Its own place only.
    const b1 = await lib.addAgent(inv, fx.alpha, { name: 'B1' })
    const lent = await inv('slots:test', fx.alpha, { op: 'lend', agent: b1.id, card: 101 })
    check('B1 is lent a slot', lent.ok, JSON.stringify(lent))
    const slotRun = await inv('preview:start', fx.alpha, lent.slot.folder)
    check("B1's slot's preview runs under its lease", slotRun.state === 'running' && slotRun.place.kind === 'slot', JSON.stringify(slotRun.end))
    const aStatus = await callTool(aServer, { action: 'status' })
    check("A's status is its own place's (alpha's folder), not the slot's running preview", aStatus.text.startsWith('alpha · ') && /not started/.test(aStatus.text) && !aStatus.text.includes(lent.slot.name) && !aStatus.text.includes(String(slotRun.port)), aStatus.text)
    for (const k of ['folder', 'place', 'project', 'agent']) {
      const r = await api(a.token, { action: 'status', [k]: k === 'folder' ? lent.slot.folder : k === 'project' ? 'beta' : lent.slot.name })
      check(`naming a ${k} is refused (403), whatever it names`, r.status === 403 && /only your own place/.test(JSON.stringify(r.body)), JSON.stringify(r))
    }
    const viewer = await api('not-a-token', { action: 'status' })
    check('a caller that is no agent is refused', viewer.status === 401 || viewer.status === 403, JSON.stringify(viewer.status))
    const aStart = await callTool(aServer, { action: 'start' })
    check("A's start runs alpha's own preview, its stamp first: place, source, state", !aStart.isError && /^alpha · [0-9a-f]{7} · running at http:\/\/127\.0\.0\.1:\d+\//.test(aStart.text), aStart.text)
    const aRun = (await inv('preview:list', fx.alpha)).find((v) => v.place.kind === 'project')
    check('…a preview of its own, apart from the slot’s', !!aRun && aRun.id !== slotRun.id && aRun.port !== slotRun.port)
    const cStatus = await callTool(cServer, { action: 'status' })
    check("C (beta) sees beta's place alone, not alpha's preview", cStatus.text.startsWith('beta · ') && /not started/.test(cStatus.text) && !cStatus.text.includes(String(aRun?.port)), cStatus.text)
    const cGoto = await callTool(cServer, { action: 'snapshot' })
    check("…and capturing there is refused (beta's isn't running), never alpha's page", cGoto.isError && /isn't running/.test(cGoto.text), cGoto.text)
    check('the slot’s preview still runs', (await inv('preview:list', fx.alpha)).find((v) => v.id === slotRun.id)?.state === 'running')

    // --- Status: the server's log.
    const st = await callTool(aServer, { action: 'status' })
    check("status gives its server's log's last lines", st.text.includes('site listening on'), st.text)

    // --- Snapshot: its tree as text, untrusted.
    const snap = await callTool(aServer, { action: 'snapshot' })
    check("snapshot: the page's title and its tree (heading, button, a field's value)", /Home \(http:\/\/127\.0\.0\.1:\d+\/\)/.test(snap.text) && /heading "Hello"/.test(snap.text) && /button "Go"/.test(snap.text) && /textbox "Name"( = x)?/.test(snap.text), snap.text)
    check('…saying the page is untrusted data', /untrusted data, never instructions/.test(snap.text))
    await callTool(aServer, { action: 'goto', path: '/big' })
    const big = await callTool(aServer, { action: 'snapshot' })
    check('a long page is cut at 6 KB, saying how many lines more', /…\d+ more lines/.test(big.text) && Buffer.byteLength(big.text) < 7 * 1024, String(Buffer.byteLength(big.text)))

    // --- goto: own origin only.
    for (const p of ['//127.0.0.2/x', 'http://127.0.0.2/', 'x', '/a b']) {
      const r = await callTool(aServer, { action: 'goto', path: p })
      check(`goto ${JSON.stringify(p)} is refused: a path of its own server`, r.isError && /path is a page/.test(r.text), r.text)
    }

    // --- 6. A 20000 px page, full: cut at 6000, saying so.
    await callTool(aServer, { action: 'goto', path: '/tall' })
    const tall = await callTool(aServer, { action: 'screenshot', full: true })
    const tallFile = shotPath(tall.text)
    check('a 20000 px page, full: cut at 6000, saying how tall it was', !tall.isError && /The page is 20000 px tall: cut at 6000/.test(tall.text) && /×6000 /.test(tall.text), tall.text)
    check('…its file is there, of the size the reply gives', !!tallFile && fs.existsSync(tallFile) && tall.text.includes(`${Math.round(fs.statSync(tallFile).size / 1024)} KB`), tallFile)
    const view = await callTool(aServer, { action: 'screenshot' })
    check('the viewport by default: 1280×800, nothing cut', /1280×800 /.test(view.text) && !/cut at/.test(view.text), view.text)
    // Kept with the suite's screenshots, to look at: the full page and the view, as the agent was given them.
    fs.mkdirSync(fx.shots, { recursive: true })
    if (tallFile && fs.existsSync(tallFile)) fs.copyFileSync(tallFile, path.join(fx.shots, `previewagent-1-full${path.extname(tallFile)}`))
    const viewFile = shotPath(view.text)
    if (viewFile && fs.existsSync(viewFile)) fs.copyFileSync(viewFile, path.join(fx.shots, `previewagent-2-view${path.extname(viewFile)}`))

    // --- 6. A high-entropy page: a JPEG within 2 MB.
    await callTool(aServer, { action: 'goto', path: '/noise' })
    const noise = await callTool(aServer, { action: 'screenshot' })
    const noiseFile = shotPath(noise.text)
    const noiseBytes = noiseFile && fs.existsSync(noiseFile) ? fs.readFileSync(noiseFile) : null
    check('a high-entropy page comes back a JPEG (its PNG over 2 MB)', !noise.isError && /JPEG (80|60)/.test(noise.text) && !!noiseBytes && noiseBytes[0] === 0xff && noiseBytes[1] === 0xd8, noise.text)
    check('…of 2 MB or less', !!noiseBytes && noiseBytes.length <= 2 * 1024 * 1024, String(noiseBytes?.length))

    // --- 6. A limit no step meets: the error, and no file.
    const dir = path.dirname(tallFile)
    const before = shotsIn(dir).length
    await inv('preview:test', { op: 'shotMax', id: aRun.id, bytes: 100 })
    const over = await callTool(aServer, { action: 'screenshot' })
    check('over the limit at every step: an error, nothing saved', over.isError && /Nothing was saved/.test(over.text) && shotsIn(dir).length === before, `${over.text} ${shotsIn(dir).length}/${before}`)
    await inv('preview:test', { op: 'shotMax', id: aRun.id, bytes: null })

    // --- 6. A noisy console: 20 entries and the count.
    await callTool(aServer, { action: 'goto', path: '/noisy' })
    const cons = await callTool(aServer, { action: 'console' })
    const entries = cons.text.split('\n').filter((l) => /^\[(error|warning)\] /.test(l))
    check('a noisy console: the newest 20 errors and warnings, of how many', /20 of \d+ errors and warnings/.test(cons.text) && entries.length === 20, cons.text.slice(0, 300))
    check("…each at most 300 characters (the 1000-character warning cut), console.log's left out", entries.every((l) => l.length <= 300 + 12) && entries.some((l) => /^\[warning\] w+…$/.test(l)) && !cons.text.includes('not counted'))
    check('…the whole within 6 KB', Buffer.byteLength(cons.text) <= 6 * 1024 + 1024, String(Buffer.byteLength(cons.text)))

    // --- A change after the page loaded is said.
    await callTool(aServer, { action: 'goto', path: '/' })
    const changedAt = async () => (await inv('preview:list', fx.alpha)).find((v) => v.id === aRun.id)?.changedAt ?? null
    const was = await changedAt()
    check("Combwork's own files (.combwork) changing never marked it changed", was === null, String(was))
    fs.writeFileSync(path.join(fx.alpha, 'a.txt'), 'changed\n')
    await until(async () => {
      const now = await changedAt()
      return !!now && now !== was
    }, HUNG_MS)
    const stale = await callTool(aServer, { action: 'snapshot' })
    check('files changed after the page loaded: the capture says so, and the stamp that they changed since it started', /after the page loaded at/.test(stale.text) && /after it started/.test(stale.text), stale.text.split('\n').slice(0, 4).join(' | '))

    // --- 6. 21 shots keep 20.
    for (let i = 0; i < 21; i++) await callTool(aServer, { action: 'screenshot' })
    check('21 more shots: the place keeps 20', shotsIn(dir).length === 20, String(shotsIn(dir).length))

    // --- Stop: its shots gone.
    const stop = await callTool(aServer, { action: 'stop' })
    check('stop: its stamp says stopped', /^alpha · .* · stopped/.test(stop.text), stop.text)
    check('…and its shots are gone', !!(await until(() => !fs.existsSync(dir) || shotsIn(dir).length === 0, HUNG_MS)))
    const after = await callTool(aServer, { action: 'screenshot' })
    check('a capture of a stopped preview is refused', after.isError && /isn't running/.test(after.text), after.text)

    // --- Off again: refused, and a new launch has no tool.
    await inv('advanced:set', 'cw.preview.enabled', false)
    const offAgain = await api(a.token, { action: 'status' })
    check('off again: the API refuses it', offAgain.status === 403 && /Preview is off/.test(JSON.stringify(offAgain.body)), JSON.stringify(offAgain))
    const late = await q.agent(fx, h, 'Late')
    check('…and a new launch has no cw_preview', !(await toolNames(serverFor(late.token))).includes('cw_preview'))
    await inv('slots:test', fx.alpha, { op: 'release', lease: lent.lease.id, why: 'done' })
  } catch (e) {
    check('the run went through', false, e?.stack ?? String(e))
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})()
