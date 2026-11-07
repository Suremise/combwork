/**
 * A GET of a JSON reply from the network, with Node's own https rather than fetch (#1582). fetch decompresses a
 * `Content-Encoding: br` reply with Node's bundled Brotli decoder, which CVE-2026-111497 makes unsafe on data from the
 * network before Node 24.22.1 (bundled since Electron 44.10.0, HI-1503: kept, so the next such flaw can't reach it
 * either); https never decompresses anything. This asks for the reply
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

export interface PlainGetOptions {
  headers?: Record<string, string>
  /** The most the body may be, in bytes. */
  maxBytes?: number
  /** Ends the call (the caller's deadline, or a newer call): it rejects. */
  signal?: AbortSignal
}

export interface PlainRequestOptions extends PlainGetOptions {
  method?: 'GET' | 'POST'
  /** A request body, sent as it is (the caller sets its Content-Type). */
  body?: string
  /**
   * How much of a non-2xx reply's body to read, in bytes (HI-2683: a server's error, to classify it): at most this, cut
   * there (`errorText`), an encoded one not read. 0, the default: none, as plainHttpGet.
   */
  errorBytes?: number
}

/** A reply as plainHttpGet read it: `text` only for a 2xx whose body was read whole and unencoded. */
export interface PlainReply {
  status: number
  /** A 2xx reply's body; '' for any other status (not read). */
  text: string
  /** Why a 2xx reply's body wasn't read: over maxBytes, or encoded (refused, never decoded). */
  refused?: 'tooBig' | 'encoded'
  /** A non-2xx reply's body, its first `errorBytes` at most (only when asked for, HI-2683). */
  errorText?: string
}

/**
 * One GET, as plainHttpsJson asks (unencoded, with Node's http or https rather than fetch: #1582), that follows no
 * redirect: a 3xx comes back as its status. For a caller that tells failures apart by status (a server connection's
 * model listing, HI-1836). Rejects only when there is no reply (unreachable, the signal, a reply cut short).
 */
export function plainHttpGet(url: string, opts: PlainGetOptions = {}): Promise<PlainReply> {
  return plainHttpRequest(url, { ...opts, method: 'GET' })
}

/**
 * plainHttpGet's request with any method and a body (HI-2683: a server's tool-call test is a POST): the same rules, no
 * redirect followed, unencoded only, a 2xx body within `maxBytes`, and of a non-2xx one only its first `errorBytes`.
 */
export function plainHttpRequest(url: string, opts: PlainRequestOptions = {}): Promise<PlainReply> {
  const { maxBytes = 4 * 1024 * 1024, signal, method = 'GET', body, errorBytes = 0 } = opts
  const own = Object.entries(opts.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'accept-encoding')
  const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...Object.fromEntries(own), 'Accept-Encoding': 'identity' }
  if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'))
  return new Promise((resolve, reject) => {
    let req: ReturnType<typeof httpsRequest> | null = null
    let done = false
    const onAbort = (): void => fail(new Error('Aborted'))
    function finish(): boolean {
      if (done) return false
      done = true
      signal?.removeEventListener('abort', onAbort)
      return true
    }
    function fail(e: Error): void {
      if (!finish()) return
      req?.destroy()
      reject(e)
    }
    function settle(reply: PlainReply, res: IncomingMessage): void {
      if (!finish()) return
      res.destroy()
      resolve(reply)
    }
    if (signal?.aborted) return reject(new Error('Aborted'))
    signal?.addEventListener('abort', onAbort)
    try {
      const target = new URL(url)
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return fail(new Error(`Not an http(s) URL: ${target.protocol}`))
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest
      req = send(target, { method, headers }, (res) => {
        if (done) return void res.destroy()
        const status = res.statusCode ?? 0
        const ok = status >= 200 && status < 300
        if (!ok && (errorBytes <= 0 || (status >= 300 && status < 400) || encodingOf(res))) return settle({ status, text: '' }, res)
        if (ok && encodingOf(res)) return settle({ status, text: '', refused: 'encoded' }, res)
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (ok && size > maxBytes) return settle({ status, text: '', refused: 'tooBig' }, res)
          chunks.push(c)
          // An error's body: its first errorBytes only, the rest not read.
          if (!ok && size >= errorBytes) settle({ status, text: '', errorText: Buffer.concat(chunks).subarray(0, errorBytes).toString('utf8') }, res)
        })
        res.on('end', () => {
          if (!finish()) return
          const all = Buffer.concat(chunks)
          resolve(ok ? { status, text: all.toString('utf8') } : { status, text: '', errorText: all.subarray(0, errorBytes).toString('utf8') })
        })
        res.on('error', fail)
        res.on('aborted', () => fail(new Error('Reply cut short')))
      })
      req.on('error', fail)
      req.end(body)
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
