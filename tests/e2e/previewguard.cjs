// The Preview's network guard, its feasibility gate (HI-3615, design HI-3597 s21 §C′; s16 §E test 4): a test Combwork shows
// a fixture page in a preview's guarded view (preview:show, as the tab will), the page tries every path out, and nothing
// it may not reach is reached. Run twice: as built (webRequest checks first, the proxy behind it), then with webRequest's
// check off (CW_TEST_PREVIEW_PROXY_ONLY, test copies only), so the proxy alone is proved to hold every path.
// From the page:
// - its own port works (the page, its reports, a WebSocket to its own server, a service worker of its own);
// - fetch, XHR, an iframe, an image, a beacon, a WebSocket and a service worker's fetch to another loopback port (a
//   stand-in for another preview or program), to the Agent API's port, to 127.0.0.2, to foo.localhost, to a decimal IP
//   (2130706433), to a name resolving to 127.0.0.1 (loop.test), to a private address (10.255.255.1), file: and
//   combwork-img:: none reaches anything, each refused in the guard's log;
// - the internet (https://ext.test, a test name for 203.0.113.10, reached at a local https fixture the test trusts): allowed;
//   its redirect back to the stand-in's loopback port is refused;
// - WebRTC with a STUN server on a loopback UDP port: no packet reaches it;
// - a wss connection to the internet open before a generation change (Stop, Start) is closed after it;
// - the proxy killed: the preview is stopped ("network guard stopped") and its page gone.
// QUIC is off (Combwork's --disable-quic; a fixed proxy rules it out too). The proxy's own rules (pinning, rebinding,
// CONNECT to a private address) are tests/previewGuard.test.ts's. Dev build, throwaway profile; no agent.
// Dev build only (#1578): its resolver, address map, fixture certificate and proxy-alone mode are test copies' seams.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const dgram = require('dgram')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const q = require('./queueFixture.cjs')

// Above the e2e lanes' ports (lanes.mjs: 47939–48128), below Windows' dynamic range.
const PORT = Number(lib.port(48301))
const HUNG_MS = lib.timing('hang.step')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

/** A local server's port. */
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))

/** The page's probes (served as /): each tried once, reported to its own origin; "all-done" last. */
const PROBE_PAGE = `<!doctype html><html><body><h1 id="h">probe</h1><script>
const q = new URLSearchParams(location.search)
const S = q.get('s'), A = q.get('a'), U = q.get('u')
const report = (name, outcome) => fetch('/report', { method: 'POST', body: JSON.stringify({ name, outcome }) }).catch(() => {})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tryFetch = async (name, url) => { try { await fetch(url, { mode: 'no-cors' }); report(name, 'loaded') } catch { report(name, 'error') } }
const tryXhr = (name, url) => new Promise((r) => { const x = new XMLHttpRequest(); x.onloadend = () => { report(name, x.status ? 'loaded' : 'error'); r() }; x.open('GET', url); x.send() })
const tryEl = (name, tag, url) => new Promise((r) => { const e = document.createElement(tag); e.onload = () => { report(name, 'loaded'); r() }; e.onerror = () => { report(name, 'error'); r() }; e.src = url; document.body.appendChild(e); setTimeout(r, 3000) })
const tryWs = (name, url) => new Promise((r) => { try { const w = new WebSocket(url); w.onopen = () => { report(name, 'open'); w.close(); r() }; w.onerror = () => { report(name, 'error'); r() } } catch { report(name, 'error'); r() } })
;(async () => {
  const targets = { other: 'http://127.0.0.1:' + S, agentApi: 'http://127.0.0.1:' + A, loopback2: 'http://127.0.0.2:' + S, fooLocalhost: 'http://foo.localhost:' + S, decimal: 'http://2130706433:' + S, loopName: 'https://loop.test:' + S, privateAddr: 'https://10.255.255.1' }
  for (const [k, base] of Object.entries(targets)) {
    await tryFetch('fetch ' + k, base + '/fetch-' + k)
    await tryXhr('xhr ' + k, base + '/xhr-' + k)
    await tryEl('iframe ' + k, 'iframe', base + '/iframe-' + k)
    await tryEl('img ' + k, 'img', base + '/img-' + k)
    navigator.sendBeacon(base + '/beacon-' + k, 'x')
    await tryWs('ws ' + k, base.replace(/^http/, 'ws') + '/ws-' + k)
  }
  await tryEl('iframe file', 'iframe', 'file:///C:/Windows/win.ini')
  await tryEl('img combwork-img', 'img', 'combwork-img://x/y.png')
  await tryFetch('fetch external ok', 'https://ext.test/ok')
  await tryFetch('fetch external redirect', 'https://ext.test/away')
  try {
    const reg = await navigator.serviceWorker.register('/sw.js?s=' + S + '&a=' + A)
    await navigator.serviceWorker.ready
    report('sw', reg.active ? 'active' : 'registered')
  } catch (e) { report('sw', 'error ' + e) }
  await tryWs('ws own', 'ws://' + location.host + '/ws-own')
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:' + U }] })
    pc.createDataChannel('d')
    let n = 0
    pc.onicecandidate = (e) => { if (e.candidate) n++ }
    await pc.setLocalDescription(await pc.createOffer())
    for (let i = 0; i < 30 && pc.iceGatheringState !== 'complete'; i++) await wait(100)
    report('webrtc', 'candidates ' + n)
  } catch (e) { report('webrtc', 'error ' + e) }
  // An internet WebSocket kept open, for the generation change.
  window.held = new WebSocket('wss://ext.test/held')
  window.held.onopen = () => report('wss held', 'open')
  report('all-done', 'yes')
})()
</script></body></html>`

const SW = `self.addEventListener('install', (e) => { const q = new URL(location.href).searchParams; e.waitUntil(Promise.allSettled([fetch('http://127.0.0.1:' + q.get('s') + '/sw-fetch'), fetch('http://127.0.0.1:' + q.get('a') + '/v1/status')]).then(() => self.skipWaiting())) })
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))`

/** The dev server stand-in: the probe page, its service worker, its reports (to a file), and a WebSocket of its own. */
function devServer(file) {
  return [
    "const http = require('http'), fs = require('fs'), crypto = require('crypto')",
    `const page = ${JSON.stringify(PROBE_PAGE)}, sw = ${JSON.stringify(SW)}, out = ${JSON.stringify(file)}`,
    "const s = http.createServer((req, res) => {",
    "  if (req.url.startsWith('/report')) { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { fs.appendFileSync(out, b + '\\n'); res.end('ok') }); return }",
    "  if (req.url.startsWith('/sw.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(sw) }",
    "  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)",
    "})",
    "s.on('upgrade', (req, sock) => { const key = req.headers['sec-websocket-key']; const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + acc + '\\r\\n\\r\\n'); sock.on('error', () => {}) })",
    "s.listen(Number(process.env.PORT), '127.0.0.1')",
    ''
  ].join('\n')
}

/** A self-signed certificate for ext.test, made with Git's openssl: its key, certificate and Chromium's fingerprint of it. */
function certificate(dir) {
  const openssl = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')
  const key = path.join(dir, 'ext.key')
  const cert = path.join(dir, 'ext.crt')
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=ext.test', '-addext', 'subjectAltName=DNS:ext.test'], { stdio: 'ignore', env: lib.childEnv ? lib.childEnv() : undefined })
  const pem = fs.readFileSync(cert, 'utf8')
  const raw = new crypto.X509Certificate(pem).raw
  return { key: fs.readFileSync(key), cert: pem, fingerprint: `sha256/${crypto.createHash('sha256').update(raw).digest('base64')}` }
}

/** One phase: a test Combwork (proxy only or not), the probe page shown, its results and the guard's refusals. */
async function phase(name, proxyOnly) {
  const fx = q.queueProject(`pvguard-${name}`)
  q.prepare(fx)
  const results = path.join(fx.tools, 'results.jsonl')
  const server = path.join(fx.tools, 'server.js')
  fs.writeFileSync(server, devServer(results))
  // The stand-ins: another loopback service (another preview, a program), the internet's fixture, a STUN port.
  const hits = []
  /** Every socket the stand-ins hold (destroyed before their servers close, which would wait for them). */
  const kept = new Set()
  const other = http.createServer((req, res) => {
    hits.push(req.url)
    res.end('stand-in')
  })
  other.on('upgrade', (req, sock) => {
    hits.push(`upgrade ${req.url}`)
    sock.destroy()
  })
  other.on('connection', (sock) => {
    kept.add(sock)
    sock.on('close', () => kept.delete(sock))
  })
  const otherPort = await listen(other)
  const tls = certificate(fx.tools)
  const extHits = []
  let heldClosed = 0
  let heldOpen = 0
  const ext = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    extHits.push(req.url)
    if (req.url === '/away') return res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/redirected` }).end()
    res.writeHead(200, { 'access-control-allow-origin': '*' }).end('external')
  })
  ext.on('upgrade', (req, sock) => {
    const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`)
    heldOpen++
    kept.add(sock)
    // An HTTP server's sockets are half-open: the far end's close is their end (counted once, then closed here).
    let counted = false
    const gone = () => {
      if (counted) return
      counted = true
      heldClosed++
      sock.destroy()
    }
    sock.on('end', gone)
    sock.on('close', gone)
    sock.on('error', () => undefined)
  })
  const extPort = await listen(ext)
  const stun = dgram.createSocket('udp4')
  let udpPackets = 0
  stun.on('message', () => udpPackets++)
  await new Promise((r) => stun.bind(0, '127.0.0.1', r))
  const udpPort = stun.address().port
  const env = {
    CW_TEST_PREVIEW_DNS: JSON.stringify({ 'ext.test': [['203.0.113.10']], 'loop.test': [['127.0.0.1']] }),
    CW_TEST_PREVIEW_CONNECT: JSON.stringify({ '203.0.113.10:443': `127.0.0.1:${extPort}` }),
    CW_TEST_PREVIEW_CERT: tls.fingerprint,
    ...(proxyOnly ? { CW_TEST_PREVIEW_PROXY_ONLY: '1' } : {})
  }
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true, env })
  const tag = proxyOnly ? '[proxy alone] ' : ''
  try {
    const { page, inv } = h
    page.on('pageerror', (e) => check(`${tag}no page errors`, false, e.message))
    await inv('advanced:set', 'cw.preview.enabled', true)
    await inv('preview:setConfig', fx.alpha, { command: `node "${server}"`, path: `/?s=${otherPort}&a=${PORT}&u=${udpPort}` })
    const v = await inv('preview:start', fx.alpha)
    check(`${tag}the fixture's preview runs`, v.state === 'running', JSON.stringify(v.end))
    const shown = await inv('preview:show', fx.alpha, v.id, { x: 0, y: 120, width: 900, height: 600 })
    check(`${tag}its page is shown in the guarded view`, shown.id === v.id && (await inv('preview:test', { op: 'shown', id: v.id })).shown)
    const lines = () => (fs.existsSync(results) ? fs.readFileSync(results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    const done = await until(() => lines().some((l) => l.name === 'all-done'), HUNG_MS)
    check(`${tag}the page ran every probe, reporting to its own origin`, !!done, JSON.stringify(lines().slice(-3)))
    const said = Object.fromEntries(lines().map((l) => [l.name, l.outcome]))
    check(`${tag}nothing reached the other loopback service: fetch, XHR, iframe, image, beacon, WebSocket, the service worker's fetch, the redirect from the internet`, hits.length === 0, JSON.stringify(hits))
    check(`${tag}the internet is reached over https (ext.test, through the proxy)`, extHits.includes('/ok') && said['fetch external ok'] === 'loaded', JSON.stringify([extHits, said['fetch external ok']]))
    check(`${tag}…and its redirect to a loopback port is refused`, extHits.includes('/away') && !hits.includes('/redirected'))
    check(`${tag}its own port works: a WebSocket to its own server opens`, said['ws own'] === 'open', said['ws own'])
    check(`${tag}…and a service worker of its own registers`, /^(active|registered)$/.test(said.sw ?? ''), said.sw)
    check(`${tag}WebRTC: no packet reaches a loopback STUN port`, udpPackets === 0 && /^candidates \d+$/.test(said.webrtc ?? ''), JSON.stringify([udpPackets, said.webrtc]))
    const refusals = (await inv('preview:test', { op: 'refusals', id: v.id })) ?? []
    const by = (layer, re) => refusals.filter((r) => r.layer === layer && re.test(r.url))
    if (!proxyOnly) {
      check('webRequest refused the Agent API port, 127.0.0.2, foo.localhost, the decimal IP and the private address', [new RegExp(`127\\.0\\.0\\.1:${PORT}/`), /127\.0\.0\.2/, /foo\.localhost/, new RegExp(`127\\.0\\.0\\.1:${otherPort}/fetch-decimal`), /10\.255\.255\.1/].every((re) => by('webRequest', re).length > 0), JSON.stringify(refusals.slice(0, 40)))
      check('…and file: and combwork-img:', by('webRequest', /^file:/).length > 0 || by('webRequest', /^combwork-img:/).length > 0, JSON.stringify(refusals.filter((r) => /^(file|combwork-img):/.test(r.url))))
      check('the proxy refused the name resolving to 127.0.0.1 (https, past webRequest)', by('proxy', /loop\.test/).length > 0, JSON.stringify(refusals.filter((r) => r.layer === 'proxy')))
      check('webRequest refused the redirect from the internet', by('webRequest', /\/redirected/).length > 0)
    } else {
      check('[proxy alone] the proxy refused the Agent API port, the other port, 127.0.0.2, foo.localhost, the name resolving to loopback and the private address', [new RegExp(`127\\.0\\.0\\.1:${PORT}`), new RegExp(`:${otherPort}`), /127\.0\.0\.2/, /foo\.localhost/, /loop\.test/, /10\.255\.255\.1/].every((re) => by('proxy', re).length > 0), JSON.stringify(refusals.slice(0, 40)))
      check('[proxy alone] no webRequest refusal (its check is off)', refusals.every((r) => r.layer === 'proxy'))
    }
    // --- A connection open before a generation change is closed after it.
    check(`${tag}an internet WebSocket is held open`, !!(await until(() => heldOpen === 1 && heldClosed === 0, HUNG_MS)), JSON.stringify([heldOpen, heldClosed]))
    await inv('preview:stop', fx.alpha)
    check(`${tag}…the preview stopped (a generation change): that connection is closed`, !!(await until(() => heldClosed === 1, HUNG_MS)), JSON.stringify([heldOpen, heldClosed]))
    check(`${tag}…and its page is gone`, (await inv('preview:test', { op: 'shown', id: v.id })).viewDestroyed !== false)
    // --- The proxy killed: the preview stops, its page is gone, nothing more loads.
    const w = await inv('preview:start', fx.alpha)
    await inv('preview:show', fx.alpha, w.id, { x: 0, y: 120, width: 900, height: 600 })
    const before = lines().length
    const pid = await inv('preview:test', { op: 'killGuard', id: w.id })
    check(`${tag}the guard's proxy is killed`, typeof pid === 'number' && pid > 0, String(pid))
    const stopped = await until(async () => (await inv('preview:list', fx.alpha)).find((x) => x.id === w.id && x.state === 'stopped'), HUNG_MS)
    check(`${tag}…the preview is stopped: network guard stopped`, stopped?.end?.kind === 'guardStopped', JSON.stringify(stopped?.end))
    check(`${tag}…its page is gone`, (await inv('preview:test', { op: 'shown', id: w.id })).viewDestroyed !== false)
    check(`${tag}…and its page loaded nothing more`, lines().length >= before && !lines().slice(before).some((l) => l.name === 'all-done'))
  } catch (e) {
    check(`${tag}the phase went through`, false, e?.stack ?? String(e))
  } finally {
    await h.app.close().catch(() => undefined)
    for (const k of kept) k.destroy()
    for (const s of [other, ext]) {
      s.closeAllConnections?.()
      await new Promise((r) => s.close(() => r()))
    }
    stun.close()
  }
}

;(async () => {
  await phase('built', false)
  await phase('proxy', true)
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
