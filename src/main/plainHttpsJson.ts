/**
 * A GET of a JSON reply from the network, with Node's own https rather than fetch (#1582). fetch decompresses a
 * `Content-Encoding: br` reply with Node's bundled Brotli decoder, which CVE-2026-111497 makes unsafe on data from the
 * network until Electron bundles Node 24.22.1 (#1503); https never decompresses anything. This asks for the reply
 * unencoded and refuses an encoded one, so no network reply reaches a decoder. `tests/networkDecoding.test.ts` keeps
 * fetch out of the main process.
 */
import { request as httpRequest, type IncomingMessage } from 'http'
import { request as httpsRequest } from 'https'

export interface PlainJsonOptions {
  headers?: Record<string, string>
  /** The whole call, redirects and body included. */
  timeoutMs?: number
  /** The most the body may be, in bytes. */
  maxBytes?: number
}

/** fetch's own, so the services see the same caller as before (GitHub's API refuses a request without one). */
const DEFAULT_HEADERS = { Accept: '*/*', 'User-Agent': 'node' }
const MAX_REDIRECTS = 5

/**
 * The reply's JSON. Rejects on a status other than 2xx, an encoded reply, a body over `maxBytes`, JSON that doesn't
 * parse, or no whole reply within `timeoutMs`: the callers' "couldn't check".
 */
export function plainHttpsJson(url: string, opts: PlainJsonOptions = {}): Promise<unknown> {
  const { timeoutMs = 6000, maxBytes = 4 * 1024 * 1024 } = opts
  const own = Object.entries(opts.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'accept-encoding')
  const headers = { ...DEFAULT_HEADERS, ...Object.fromEntries(own), 'Accept-Encoding': 'identity' }
  return new Promise((resolve, reject) => {
    let req: ReturnType<typeof httpsRequest> | null = null
    let done = false
    const deadline = setTimeout(() => fail(new Error(`No reply within ${Math.ceil(timeoutMs / 1000)} s`)), timeoutMs)
    function fail(e: Error): void {
      if (done) return
      done = true
      clearTimeout(deadline)
      req?.destroy()
      reject(e)
    }
    function get(target: URL, redirects: number): void {
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return fail(new Error(`Not an http(s) URL: ${target.protocol}`))
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest
      const current = send(target, { method: 'GET', headers }, (res) => {
        // A throw here (a Location that isn't a URL) would be uncaught, outside the promise: it fails the call instead.
        try {
          reply(current, res, target, redirects)
        } catch (e) {
          res.destroy()
          fail(e as Error)
        }
      })
      req = current
      // Only the request still in play: one left behind by a redirect, destroyed, is no failure.
      current.on('error', (e) => current === req && fail(e))
      current.end()
    }
    function reply(current: ReturnType<typeof httpsRequest>, res: IncomingMessage, target: URL, redirects: number): void {
      if (done) return void res.destroy()
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location) {
        // Its body isn't read: closed now, so it can't outlive the call or escape maxBytes and the deadline.
        res.destroy()
        current.destroy()
        if (redirects >= MAX_REDIRECTS) return fail(new Error('Too many redirects'))
        const next = new URL(location, target)
        // Never from https down to http.
        if (target.protocol === 'https:' && next.protocol !== 'https:') return fail(new Error('Redirected off https'))
        return get(next, redirects + 1)
      }
      if (status < 200 || status >= 300) {
        res.destroy()
        return fail(new Error(`HTTP ${status}`))
      }
      const encoding = encodingOf(res)
      if (encoding) {
        res.destroy()
        return fail(new Error(`Refused an encoded reply (${encoding})`))
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > maxBytes) return fail(new Error(`Reply over ${maxBytes} bytes`))
        chunks.push(c)
      })
      res.on('end', () => {
        if (done) return
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          done = true
          clearTimeout(deadline)
          resolve(value)
        } catch (e) {
          fail(e as Error)
        }
      })
      res.on('error', fail)
      res.on('aborted', () => fail(new Error('Reply cut short')))
    }
    try {
      get(new URL(url), 0)
    } catch (e) {
      fail(e as Error)
    }
  })
}

/** The reply's Content-Encoding, or '' when there is none (or `identity`). */
function encodingOf(res: IncomingMessage): string {
  const raw = res.headers['content-encoding']
  const value = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).trim().toLowerCase()
  return value === 'identity' ? '' : value
}
