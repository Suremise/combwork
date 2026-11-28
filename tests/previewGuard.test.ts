// The Preview's network guard (HI-3615, the feasibility gate of design HI-3597 s21 §C′): the policy (previewPolicy.ts) and
// the filtering proxy (previewProxyCore.ts) with real sockets on loopback. A "public" test address (203.0.113.10,
// TEST-NET-3) is checked as the internet and then reached at a local fixture, as the proxy's tests-only connectTo maps it;
// a test resolver answers names, a rebinding one a public address and then 127.0.0.1. What Chromium adds (the partition,
// webRequest, WebSockets, service workers, WebRTC, the proxy's loss, a generation change) is tests/e2e/previewguard.cjs.
import { createServer, request, type Server } from 'http'
import { createServer as createTcp, type Server as TcpServer } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { startProxy, type ProxyEvent, type RunningProxy } from '../src/main/previewProxyCore'
import { checkAddresses, checkUrl, classifyAddress, openableUrl, sameOrigin } from '../src/shared/previewPolicy'

describe("the preview's policy (HI-3615)", () => {
  it('classes every loopback, private and public form, IPv4 carried in IPv6 included', () => {
    const cases: [string, string | null][] = [
      ['127.0.0.1', 'loopback'],
      ['127.0.0.2', 'loopback'],
      ['0.0.0.0', 'loopback'],
      ['::1', 'loopback'],
      ['::', 'loopback'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:7f00:1', 'loopback'],
      ['::127.0.0.1', 'loopback'],
      ['64:ff9b::7f00:1', 'loopback'],
      ['2002:7f00:1::1', 'loopback'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.168.1.1', 'private'],
      ['169.254.169.254', 'private'],
      ['100.64.0.1', 'private'],
      ['::ffff:10.0.0.1', 'private'],
      ['fc00::1', 'private'],
      ['fd12:3456::1', 'private'],
      ['fe80::1', 'private'],
      ['fe80::1%12', 'private'],
      ['ff02::1', 'private'],
      ['224.0.0.1', 'private'],
      ['255.255.255.255', 'private'],
      ['172.32.0.1', 'public'],
      ['8.8.8.8', 'public'],
      ['203.0.113.10', 'public'],
      ['2606:4700::1111', 'public'],
      ['::ffff:8.8.8.8', 'public'],
      ['not-an-ip', null],
      ['999.1.1.1', null]
    ]
    for (const [ip, want] of cases) expect([ip, classifyAddress(ip)]).toEqual([ip, want])
  })

  it("checks a page's URL: its own port over http and ws only; private refused; the internet over https and wss only; data:, blob: and about:blank", () => {
    const own = { ports: [46001, 46002] }
    const ok = (u: string): boolean => checkUrl(u, own).ok
    const why = (u: string): string | undefined => {
      const d = checkUrl(u, own)
      return d.ok ? undefined : d.why
    }
    for (const u of ['http://127.0.0.1:46001/', 'ws://127.0.0.1:46002/hmr', 'http://localhost:46001/x', 'http://[::1]:46001/', 'http://foo.localhost:46001/', 'https://example.com/', 'wss://example.com/socket', 'data:text/plain,hi', 'blob:http://127.0.0.1:46001/abc', 'about:blank']) expect([u, ok(u)]).toEqual([u, true])
    const refused: [string, string][] = [
      ['http://127.0.0.1:47822/v1/tasks', 'loopbackPort'],
      ['http://127.0.0.1:46003/', 'loopbackPort'],
      ['http://127.0.0.2:46003/', 'loopbackPort'],
      ['http://foo.localhost:47821/', 'loopbackPort'],
      ['http://0.0.0.0:47821/', 'loopbackPort'],
      // Decimal and hex forms, as the URL parser makes them dotted.
      ['http://2130706433:47822/', 'loopbackPort'],
      ['http://0x7f.1:47822/', 'loopbackPort'],
      ['http://[::ffff:127.0.0.1]:47822/', 'loopbackPort'],
      ['https://127.0.0.1:46001/', 'secureToLoopback'],
      ['http://10.0.0.1/', 'private'],
      ['https://192.168.1.1/', 'private'],
      ['https://[fe80::1]/', 'private'],
      ['http://example.com/', 'plainHttpOutside'],
      ['ws://example.com/', 'plainHttpOutside'],
      ['file:///C:/Windows/win.ini', 'scheme'],
      ['combwork-img://x/y.png', 'scheme'],
      ['chrome://settings', 'scheme'],
      ['devtools://devtools/bundled/inspector.html', 'scheme'],
      ['about:srcdoc', 'scheme'],
      ['https://user:pw@example.com/', 'badHost']
    ]
    for (const [u, w] of refused) expect([u, why(u)]).toEqual([u, w])
    // 127.0.0.2 is loopback too: on an own port it is the same machine's preview.
    expect(ok('http://127.0.0.2:46001/')).toBe(true)
  })

  it('checks resolved addresses whole: a name answering public and loopback at once is refused; localhost must stay loopback', () => {
    const own = { ports: [46001] }
    expect(checkAddresses(['203.0.113.10'], 443, true, own)).toEqual({ ok: true })
    expect(checkAddresses(['203.0.113.10'], 80, false, own)).toEqual({ ok: false, why: 'plainHttpOutside' })
    expect(checkAddresses(['203.0.113.10', '127.0.0.1'], 443, true, own)).toEqual({ ok: false, why: 'mixedAddresses' })
    expect(checkAddresses(['127.0.0.1'], 46001, false, own)).toEqual({ ok: true })
    expect(checkAddresses(['127.0.0.1'], 46001, true, own)).toEqual({ ok: true })
    expect(checkAddresses(['127.0.0.1'], 47822, true, own)).toEqual({ ok: false, why: 'loopbackPort' })
    expect(checkAddresses(['10.0.0.1'], 443, true, own)).toEqual({ ok: false, why: 'private' })
    expect(checkAddresses(['203.0.113.10'], 443, true, own, true)).toEqual({ ok: false, why: 'mixedAddresses' })
    expect(checkAddresses([], 443, true, own)).toEqual({ ok: false, why: 'unresolved' })
  })

  it("keeps navigation on the preview's own origin, and offers only plain http(s) URLs to the user's browser", () => {
    expect(sameOrigin('http://127.0.0.1:46001/a?b', 46001)).toBe(true)
    expect(sameOrigin('http://localhost:46001/', 46001)).toBe(true)
    expect(sameOrigin('http://127.0.0.1:46002/', 46001)).toBe(false)
    expect(sameOrigin('https://example.com/', 46001)).toBe(false)
    expect(sameOrigin('javascript:alert(1)', 46001)).toBe(false)
    expect(openableUrl('https://example.com/x')).toBe('https://example.com/x')
    for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'https://u:p@example.com/', 'combwork-img://x', 'not a url']) expect(openableUrl(bad)).toBeNull()
  })
})

// --- The proxy, on real sockets.

const servers: (Server | TcpServer)[] = []
const proxies: RunningProxy[] = []
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()))
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))))
})

/** An HTTP server on loopback, answering with `body(path)`, counting its hits. */
async function site(answer: (path: string) => { status?: number; headers?: Record<string, string>; body?: string }): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = []
  const s = createServer((req, res) => {
    hits.push(req.url ?? '')
    const a = answer(req.url ?? '')
    res.writeHead(a.status ?? 200, a.headers ?? {}).end(a.body ?? 'ok')
  })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const addr = s.address()
  return { port: typeof addr === 'object' && addr ? addr.port : 0, hits }
}

/** A request through the proxy in absolute form (as Chromium sends plain http to a proxy): its status and body. */
function viaProxy(proxy: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: proxy, path: url, method: 'GET', headers: { host: new URL(url).host } }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }))
    })
    r.on('error', fail)
    r.end()
  })
}

/** A CONNECT through the proxy: its status line's code, and the tunnel's socket when established. */
function tunnel(proxy: number, target: string): Promise<{ status: number; close: () => void }> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: proxy, method: 'CONNECT', path: target })
    r.on('connect', (res, socket) => ok({ status: res.statusCode ?? 0, close: () => socket.destroy() }))
    r.on('response', (res) => {
      res.resume()
      ok({ status: res.statusCode ?? 0, close: () => undefined })
    })
    r.on('error', fail)
    r.end()
  })
}

describe("the preview's filtering proxy (HI-3615 gate)", () => {
  async function setup(o: { resolve?: (h: string) => Promise<string[]> } = {}) {
    const own = await site(() => ({ body: 'own' }))
    const agentApi = await site(() => ({ body: 'combwork' }))
    // The "internet": 203.0.113.10:80/443 reached at this fixture; /away redirects to the Agent API stand-in.
    const external = await site((p) => (p === '/away' ? { status: 302, headers: { location: `http://127.0.0.1:${agentApi.port}/v1/tasks` } } : { body: 'external' }))
    const events: ProxyEvent[] = []
    const proxy = await startProxy({
      own: () => ({ ports: [own.port] }),
      resolve: o.resolve ?? (async (h) => (h === 'ext.test' ? ['203.0.113.10'] : h === 'loop.test' ? ['127.0.0.1'] : h === 'lan.test' ? ['10.0.0.5'] : [])),
      connectTo: (a) => (a === '203.0.113.10' ? { host: '127.0.0.1', port: external.port } : null),
      log: (e) => events.push(e)
    })
    proxies.push(proxy)
    return { own, agentApi, external, events, proxy }
  }

  it("lets loopback through only to the preview's own port: the Agent API's port, the proxy's own and foo.localhost's are refused", async () => {
    const { own, agentApi, proxy, events } = await setup()
    expect(await viaProxy(proxy.port, `http://127.0.0.1:${own.port}/page`)).toEqual({ status: 200, body: 'own' })
    expect(await viaProxy(proxy.port, `http://localhost:${own.port}/page`)).toEqual({ status: 200, body: 'own' })
    for (const u of [`http://127.0.0.1:${agentApi.port}/v1/tasks`, `http://127.0.0.2:${agentApi.port}/`, `http://foo.localhost:${agentApi.port}/`, `http://2130706433:${agentApi.port}/`, `http://[::ffff:127.0.0.1]:${agentApi.port}/`, `http://127.0.0.1:${proxy.port}/`]) {
      const r = await viaProxy(proxy.port, u)
      expect([u, r.status, r.body]).toEqual([u, 403, expect.stringContaining('loopbackPort')])
    }
    expect(agentApi.hits).toEqual([])
    expect(own.hits).toEqual(['/page', '/page'])
    expect(events.filter((e) => !e.ok).length).toBe(6)
  })

  it('refuses a name resolving to loopback, a private address, and plain http to the internet', async () => {
    const { agentApi, proxy } = await setup()
    expect((await viaProxy(proxy.port, `http://loop.test:${agentApi.port}/`)).body).toContain('loopbackPort')
    expect((await viaProxy(proxy.port, 'http://lan.test/')).body).toContain('private')
    expect((await viaProxy(proxy.port, 'http://10.0.0.1/')).body).toContain('private')
    expect((await viaProxy(proxy.port, 'http://ext.test/')).body).toContain('plainHttpOutside')
    expect((await viaProxy(proxy.port, 'http://nowhere.test/')).body).toContain('unresolved')
    expect(agentApi.hits).toEqual([])
  })

  it('tunnels to the internet, and refuses CONNECT to a private address, a loopback port not its own and a name resolving to loopback', async () => {
    const { own, agentApi, external, proxy } = await setup()
    const ok = await tunnel(proxy.port, 'ext.test:443')
    expect(ok.status).toBe(200)
    ok.close()
    // wss to its own port (Chromium tunnels WebSockets through a proxy).
    const ws = await tunnel(proxy.port, `127.0.0.1:${own.port}`)
    expect(ws.status).toBe(200)
    ws.close()
    for (const t of ['10.0.0.1:443', '192.168.0.1:443', `127.0.0.1:${agentApi.port}`, `loop.test:${agentApi.port}`, `[::1]:${agentApi.port}`, `2130706433:${agentApi.port}`, 'lan.test:443']) expect([t, (await tunnel(proxy.port, t)).status]).toEqual([t, 403])
    expect(external.hits).toEqual([])
  })

  it('a redirect from the internet back to a local service is a new request, refused', async () => {
    // As Chromium follows a redirect: the 3xx goes back to the page's network stack, which asks the proxy again.
    const resolve = async (h: string): Promise<string[]> => (h === 'ext.test' ? ['203.0.113.10'] : [])
    const s = await setup({ resolve })
    // The fixture's plain-http answer stands for the page's tunnelled https one: the proxy only sees where it goes next.
    const first = await new Promise<{ status: number; location?: string }>((ok, fail) => {
      const r = request({ host: '127.0.0.1', port: s.external.port, path: '/away' }, (res) => {
        res.resume()
        ok({ status: res.statusCode ?? 0, location: res.headers.location })
      })
      r.on('error', fail)
      r.end()
    })
    expect(first.status).toBe(302)
    const next = await viaProxy(s.proxy.port, first.location!)
    expect(next.status).toBe(403)
    expect(s.agentApi.hits).toEqual([])
  })

  it('pins each connection to the address it checked: a rebinding answer (public, then 127.0.0.1) never reaches loopback', async () => {
    let asked = 0
    const resolve = async (h: string): Promise<string[]> => (h === 'rebind.test' ? (asked++ === 0 ? ['203.0.113.10'] : ['127.0.0.1']) : [])
    const s = await setup({ resolve })
    const first = await tunnel(s.proxy.port, `rebind.test:${s.agentApi.port}`)
    // Resolved once to the public address, checked, and connected to the fixture standing for it.
    expect(first.status).toBe(200)
    first.close()
    const second = await tunnel(s.proxy.port, `rebind.test:${s.agentApi.port}`)
    expect(second.status).toBe(403)
    expect(asked).toBe(2)
    expect(s.agentApi.hits).toEqual([])
    expect(s.events.map((e) => [e.host, e.addresses, e.ok])).toEqual([
      ['rebind.test', ['203.0.113.10'], true],
      ['rebind.test', ['127.0.0.1'], false]
    ])
  })

  it('checks a WebSocket upgrade sent through it, and closes every connection when it closes', async () => {
    const s = await setup()
    // A raw TCP server for the own port's upgrade: it holds the connection open.
    let held = 0
    const ownWs = createTcp((c) => {
      held++
      c.on('data', () => c.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n'))
      c.on('error', () => undefined)
    })
    servers.push(ownWs)
    await new Promise<void>((r) => ownWs.listen(0, '127.0.0.1', r))
    const wsPort = (ownWs.address() as { port: number }).port
    const proxy = await startProxy({ own: () => ({ ports: [wsPort] }), log: () => undefined })
    proxies.push(proxy)
    const upgrade = (port: number): Promise<number> =>
      new Promise((ok, fail) => {
        const r = request({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${port}/hmr`, headers: { connection: 'Upgrade', upgrade: 'websocket', host: `127.0.0.1:${port}` } })
        r.on('upgrade', (res) => ok(res.statusCode ?? 0))
        r.on('response', (res) => {
          res.resume()
          ok(res.statusCode ?? 0)
        })
        r.on('error', fail)
        r.end()
      })
    expect(await upgrade(wsPort)).toBe(101)
    expect(await upgrade(s.agentApi.port)).toBe(403)
    expect(held).toBe(1)
    expect(proxy.open()).toBeGreaterThan(0)
    await proxy.close()
    expect(proxy.open()).toBe(0)
  })
})
