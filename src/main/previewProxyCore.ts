// The Preview's filtering proxy (HI-3615, design HI-3597 s21 §C′, SPEC §16.21): the authoritative network boundary of a
// preview's page. Its partition's only route (fixed_servers, no DIRECT, loopback's bypass removed), so every connection
// the page makes comes here: plain http (absolute-form requests), WebSocket upgrades over them, and CONNECT tunnels (https,
// wss, and whatever else Chromium tunnels). For each it resolves the host once, checks every address it answered
// (previewPolicy.ts), and connects to the checked address itself: never resolving again, so a rebinding answer never gets
// a second lookup. Each redirect is a new request, checked again. Node's built-ins only: it runs in a utility process
// (previewProxy.ts) and in unit tests.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http'
import { connect, isIP, type Socket } from 'net'
import { lookup } from 'dns/promises'
import type { Duplex } from 'stream'
import { checkAddresses, isLocalhostName, type Decision, type OwnPorts, type Refusal } from '../shared/previewPolicy'

/** One decision of the proxy's, for its log (and the tests). */
export interface ProxyEvent {
  how: 'http' | 'connect' | 'upgrade'
  host: string
  port: number
  addresses: string[]
  ok: boolean
  why?: Refusal
}

export interface ProxyOptions {
  /** This preview's own ports: the only loopback ports allowed. */
  own: () => OwnPorts
  /** A host's addresses (default: the system's resolver, every address). Tests give their own (a rebinding one). */
  resolve?: (host: string) => Promise<string[]>
  /** Where a checked address is really reached (tests only: a public test address mapped to a local fixture). */
  connectTo?: (address: string, port: number) => { host: string; port: number } | null
  log: (e: ProxyEvent) => void
}

export interface RunningProxy {
  port: number
  /** Connections open now (the page's and their upstreams'). */
  open: () => number
  /** Closes it and every connection through it. */
  close: () => Promise<void>
}

const systemResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** A host as written in a request line or a Host header, canonical: an IP literal's own form, a name lower-cased; null if malformed. */
function canonicalHost(raw: string): string | null {
  try {
    const host = new URL(`http://${raw.includes(':') && !raw.startsWith('[') && isIP(raw) === 6 ? `[${raw}]` : raw}/`).hostname
    return host.replace(/^\[|\]$/g, '') || null
  } catch {
    return null
  }
}

/** Splits CONNECT's authority (host:port, [v6]:port). */
function authority(raw: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(raw.trim())
  if (!m) return null
  const host = canonicalHost(m[1])
  const port = Number(m[2])
  return host && port > 0 && port <= 65535 ? { host, port } : null
}

/** The response a refused request gets: 403, saying why (the page sees a failed load; the logs say what). */
const REFUSED_BODY = (why: Refusal): string => `Blocked by Combwork's preview network guard (${why})\n` // i18n-ignore: an HTTP body only a page's script or DevTools sees

export function startProxy(o: ProxyOptions): Promise<RunningProxy> {
  const resolve = o.resolve ?? systemResolve
  const sockets = new Set<Duplex>()
  const track = (s: Duplex): void => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
  }

  /** The host's addresses, resolved once, checked; the address to connect to when allowed. */
  const pin = async (how: ProxyEvent['how'], host: string, port: number, tunnel: boolean): Promise<{ d: Decision; to?: { host: string; port: number } }> => {
    const localhost = isLocalhostName(host)
    let addresses: string[]
    if (isIP(host)) addresses = [host]
    else if (localhost) addresses = ['127.0.0.1']
    else addresses = await resolve(host).catch(() => [])
    const d = checkAddresses(addresses, port, tunnel, o.own(), localhost)
    o.log({ how, host, port, addresses, ok: d.ok, ...(d.ok ? {} : { why: d.why }) })
    if (!d.ok) return { d }
    const at = addresses[0]
    return { d, to: o.connectTo?.(at, port) ?? { host: at, port } }
  }

  const server = createServer()
  server.on('connection', (s: Socket) => track(s))

  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (url.protocol !== 'http:') {
      res.writeHead(403, { 'content-type': 'text/plain' }).end(REFUSED_BODY('scheme'))
      return
    }
    const host = canonicalHost(url.host)
    const port = url.port ? Number(url.port) : 80
    if (!host) {
      res.writeHead(400).end()
      return
    }
    const { d, to } = await pin('http', host, port, false)
    if (!d.ok || !to) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end(REFUSED_BODY(d.ok ? 'unresolved' : d.why))
      req.resume()
      return
    }
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    const up = httpRequest({ host: to.host, port: to.port, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false, agent: false }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('socket', (s) => track(s))
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end()
      else res.destroy()
    })
    req.pipe(up)
  })

  server.on('connect', async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => undefined)
    const target = authority(req.url ?? '')
    if (!target) return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    const { d, to } = await pin('connect', target.host, target.port, true)
    if (!d.ok || !to) return void client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${REFUSED_BODY(d.ok ? 'unresolved' : d.why)}`)
    const up = connect(to.port, to.host)
    track(up)
    up.on('error', () => client.destroy())
    client.on('close', () => up.destroy())
    up.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(client)
      client.pipe(up)
    })
  })

  server.on('upgrade', async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => undefined)
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    }
    const host = canonicalHost(url.host)
    const port = url.port ? Number(url.port) : 80
    if (!host || (url.protocol !== 'http:' && url.protocol !== 'ws:')) return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    const { d, to } = await pin('upgrade', host, port, false)
    if (!d.ok || !to) return void client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${REFUSED_BODY(d.ok ? 'unresolved' : d.why)}`)
    const up = connect(to.port, to.host)
    track(up)
    up.on('error', () => client.destroy())
    client.on('close', () => up.destroy())
    up.once('connect', () => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) up.write(head)
      up.pipe(client)
      client.pipe(up)
    })
  })

  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      ok({
        port,
        open: () => sockets.size,
        // Over once the server and every connection through it have closed.
        close: async () => {
          const gone = [...sockets].map((s) => (s.destroyed && !sockets.has(s) ? Promise.resolve() : new Promise<void>((r) => (s.once('close', () => r()), s.destroy()))))
          await Promise.all([...gone, new Promise<void>((r) => server.close(() => r()))])
        }
      })
    })
  })
}
