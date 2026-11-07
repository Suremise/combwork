/**
 * A server connection's diagnostics (HI-2683, design s7 and s11, OK'd by HR3): its model's context as the server reports
 * it, and a small structured tool-call test, both read-only and asked for by the user, never at a launch. The rules are
 * readServerModels' (serverConnections.ts): the base URL as it is checked there (this PC over http, else https), no
 * redirect followed, the key (if any) decrypted for each request alone, here in main, and never sent to a window, put in
 * a result or a log; what a failure says is a code (and an HTTP status), never the server's text, which is read only to
 * tell failures apart (shared/serverDiagnostics.ts).
 *
 * Each check is one request id, for one connection and model: it captures the connection's base URL, preset and the
 * key's save version, and is `stale` once any of them changes, the model leaves the connection, the connection goes, or a
 * newer check (or a cancel by that id) replaces it. That is checked after the key's lookup, before each request and
 * after each reply, so the tool test's second request is never sent with settings or a key that changed. No retries; at
 * most one check a connection and model, and CHECKS_MAX at once; the last results kept, at most CACHE_MAX, dropped when
 * their connection changes.
 */
import type { ServerConnection } from '../shared/types'
import { parseBaseUrl } from '../shared/serverConnection'
import { judgeStep1, judgeStep2, llamaProps, llamaTrained, ollamaPs, ollamaShow, step1Body, step2Body, testResult, type ContextCheck, type LastCheck, type ServerContext, type StepReply, type ToolTest } from '../shared/serverDiagnostics'
import { getAccount, onAccountRemoved } from './accounts'
import { keyInfo, withKey } from './keyStore'
import { plainHttpRequest, type PlainReply } from './plainHttpsJson'
import { checkedUrl, onServerChanged, serverOf } from './serverConnections'
import { createLogger } from './logger'

const log = createLogger('servers')

/** A read's deadline; an inference's (a model loading cold can take a while); the most of a reply read; of an error's. */
const READ_TIMEOUT_MS = 10_000
const INFER_TIMEOUT_MS = 120_000
const MAX_BYTES = 1024 * 1024
const ERROR_BYTES = 8 * 1024
/** Checks at once, in all; results kept. */
export const CHECKS_MAX = 4
export const CACHE_MAX = 32

interface Run {
  request: string
  abort: AbortController
}
const runs = new Map<string, Run>()
const cache = new Map<string, LastCheck>()
let active = 0

const keyOf = (id: string, model: string): string => `${id}\0${model}`

/** Cancels a connection's checks: one model's, or all of them; with `request`, only that one (a newer one stays). */
export function cancelServerChecks(id: string, model?: string, request?: string): void {
  for (const [k, r] of runs) {
    if (!k.startsWith(`${id}\0`) || (model !== undefined && k !== keyOf(id, model)) || (request && r.request !== request)) continue
    r.abort.abort()
    runs.delete(k)
  }
}

/** A connection changed (its server, key or models) or went: its checks stop, and its results are dropped. */
export function serverChecksChanged(id: string): void {
  cancelServerChecks(id)
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}\0`)) cache.delete(k)
}

/** A connection and model's last results (as data: no key, no server text). */
export function lastServerCheck(id: string, model: string): LastCheck {
  return cache.get(keyOf(id, model)) ?? {}
}

function remember(id: string, model: string, part: Partial<LastCheck>): void {
  const k = keyOf(id, model)
  const had = cache.get(k) ?? {}
  cache.delete(k)
  cache.set(k, { ...had, ...part })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

/**
 * One check's frame: its request id made current (a newer one for the same model cancels the older), a slot, what it was
 * asked for, and `current()`, which is false from the moment any of that changed. The slot and the run are freed however
 * it ends.
 */
async function framed<T>(id: string, model: string, request: string, timeoutMs: number, body: (c: Frame) => Promise<T>, stale: T, busy: T): Promise<T> {
  const { server } = serverOf(id)
  const b = checkedUrl(server.baseUrl)
  if (!server.models.some((m) => m.id === model)) return stale
  if (active >= CHECKS_MAX) return busy
  cancelServerChecks(id, model)
  const run: Run = { request, abort: new AbortController() }
  runs.set(keyOf(id, model), run)
  active++
  const timer = setTimeout(() => run.abort.abort(), timeoutMs)
  try {
    const got = await withKey(id, b.origin)
    const asked = { baseUrl: server.baseUrl, preset: server.preset ?? null, key: got?.v ?? null }
    const current = (): boolean => {
      if (runs.get(keyOf(id, model)) !== run || run.abort.signal.aborted) return false
      const now = getAccount(id)?.server as ServerConnection | undefined
      const k = keyInfo(id)
      return !!now && now.baseUrl === asked.baseUrl && (now.preset ?? null) === asked.preset && now.models.some((m) => m.id === model) && (k && k.origin === b.origin ? k.v : null) === asked.key
    }
    // The key's lookup took a moment: a change meanwhile, and nothing is sent.
    if (!current()) return stale
    const headers = (json = false): Record<string, string> => ({ Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), ...(got ? { Authorization: `Bearer ${got.key}` } : {}) }) // i18n-ignore: HTTP headers
    return await body({ b, server, current, signal: run.abort.signal, headers })
  } finally {
    clearTimeout(timer)
    active--
    if (runs.get(keyOf(id, model)) === run) runs.delete(keyOf(id, model))
  }
}

interface Frame {
  b: { url: string; origin: string; local: boolean }
  server: ServerConnection
  current: () => boolean
  signal: AbortSignal
  headers: (json?: boolean) => Record<string, string>
}

/** A reply's JSON, or null (not 2xx, not read whole, not JSON). */
const jsonOf = (r: PlainReply): unknown => {
  if (r.status < 200 || r.status >= 300 || r.refused) return null
  try {
    return JSON.parse(r.text)
  } catch {
    return null
  }
}

/**
 * Reads what the server reports of a model's context: llama.cpp's `/props` (and `/v1/models`' trained size), else
 * Ollama's `/api/ps` (and `/api/show`'s), each from the server's root. A base URL with a path (a gateway) reaches no root
 * of the server's own: nothing is asked, and it says so (`prefixed`).
 */
export function readServerContext(id: string, model: string, request: string): Promise<ContextCheck> {
  return framed<ContextCheck>(
    id,
    model,
    request,
    READ_TIMEOUT_MS * 3,
    async ({ b, server, current, signal, headers }) => {
      const at = Date.now()
      if (b.url !== b.origin) {
        const r: ContextCheck = { ok: true, context: { kind: 'generic', prefixed: true }, at }
        remember(id, model, { context: r })
        return r
      }
      const get = async (path: string): Promise<unknown> => {
        if (!current()) throw new Stale()
        const r = await plainHttpRequest(`${b.origin}${path}`, { headers: headers(), maxBytes: MAX_BYTES, signal })
        if (!current()) throw new Stale()
        return jsonOf(r)
      }
      const post = async (path: string, body: unknown): Promise<unknown> => {
        if (!current()) throw new Stale()
        const r = await plainHttpRequest(`${b.origin}${path}`, { method: 'POST', body: JSON.stringify(body), headers: headers(true), maxBytes: MAX_BYTES, signal })
        if (!current()) throw new Stale()
        return jsonOf(r)
      }
      try {
        // Ollama's preset asks Ollama first; anything else llama.cpp first. Which it is, is what answers.
        const order = server.preset === 'ollama' ? (['ollama', 'llamacpp'] as const) : (['llamacpp', 'ollama'] as const)
        let context: ServerContext = { kind: 'generic' }
        let reached = false
        for (const kind of order) {
          if (kind === 'llamacpp') {
            const props = await get('/props').then((j) => { reached = true; return llamaProps(j) }, (e) => { if (e instanceof Stale) throw e; return null })
            if (!props) continue
            const trained = await get('/v1/models').then((j) => llamaTrained(j, model), (e) => { if (e instanceof Stale) throw e; return null })
            context = { kind: 'llamacpp', templateTools: props.templateTools, ...(props.nCtx ? { allocated: { tokens: props.nCtx, source: 'llamacpp.props', readAt: Date.now() } } : {}), ...(trained ? { trained: { tokens: trained, source: 'llamacpp.models', readAt: Date.now() } } : {}) }
            break
          }
          const ps = await get('/api/ps').then((j) => { reached = true; return ollamaPs(j, model) }, (e) => { if (e instanceof Stale) throw e; return null })
          if (!ps) continue
          const show = await post('/api/show', { model }).then(ollamaShow, (e) => { if (e instanceof Stale) throw e; return null })
          context = {
            kind: 'ollama',
            loaded: ps.loaded,
            ...(ps.contextLength ? { allocated: { tokens: ps.contextLength, source: 'ollama.ps', readAt: Date.now() } } : {}),
            ...(show?.trained ? { trained: { tokens: show.trained, source: 'ollama.show', readAt: Date.now() } } : {}),
            ...(show?.numCtx ? { configured: { tokens: show.numCtx, source: 'ollama.numCtx', readAt: Date.now() } } : {})
          }
          break
        }
        if (!reached && context.kind === 'generic') return current() ? { ok: false, why: 'unreachable' } : { ok: false, why: 'stale' } // i18n-ignore: a failure's code, not text (the window says each in its words)
        if (!current()) return { ok: false, why: 'stale' } // i18n-ignore: a failure's code, not text (the window says each in its words)
        const r: ContextCheck = { ok: true, context, at }
        remember(id, model, { context: r })
        log.info(`connection ${id}: context read (${context.kind})`)
        return r
      } catch (e) {
        if (e instanceof Stale) return { ok: false, why: 'stale' } // i18n-ignore: a failure's code, not text (the window says each in its words)
        throw e
      }
    },
    { ok: false, why: 'stale' }, // i18n-ignore: a failure's code, not text (the window says each in its words)
    { ok: false, why: 'busy' } // i18n-ignore: a failure's code, not text (the window says each in its words)
  )
}

class Stale extends Error {}

/**
 * The tool-call test: through the Messages API Claude Code itself calls (`<base URL>/v1/messages`, as it builds it from
 * ANTHROPIC_BASE_URL), one tool and a request that needs it; then, only if that was exactly one call of it with the city
 * asked about, and only while the check is still current, its synthetic result, whose code the finished answer must
 * hold. Never automatic; no retries; nothing the model returns is run.
 */
export function testServerTools(id: string, model: string, request: string, random: () => number = Math.random): Promise<ToolTest> {
  return framed<ToolTest>(
    id,
    model,
    request,
    INFER_TIMEOUT_MS * 2,
    async ({ b, current, signal, headers }) => {
      const url = `${b.url}/v1/messages`
      const send = async (body: unknown): Promise<StepReply | null> => {
        // Right before each request: a change since, and nothing is sent.
        if (!current()) return null
        let r: PlainReply
        try {
          r = await plainHttpRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { ...headers(true), 'anthropic-version': '2023-06-01' }, maxBytes: MAX_BYTES, errorBytes: ERROR_BYTES, signal }) // i18n-ignore: an HTTP header
        } catch {
          return current() ? { status: 0 } : null
        }
        if (!current()) return null
        if (r.refused) return { status: r.status, text: '' }
        return { status: r.status, ...(r.text ? { text: r.text } : {}), ...(r.errorText ? { errorText: r.errorText } : {}) }
      }
      const finish = (t: ToolTest): ToolTest => {
        const at = Date.now()
        const done = { ...t, at } as ToolTest & { at: number }
        remember(id, model, { tools: done })
        log.info(`connection ${id}: tool test ${t.ok ? 'passed' : `failed (${t.why}${t.step ? `, step ${t.step}` : ''})`}`)
        return done
      }
      const one = await send(step1Body(model))
      if (!one) return { ok: false, why: 'stale' } // i18n-ignore: a failure's code, not text (the window says each in its words)
      if (one.status === 0) return finish({ ok: false, why: 'unreachable', step: 1 }) // i18n-ignore: a failure's code, not text (the window says each in its words)
      const j1 = judgeStep1(one)
      if (!j1.ok) return finish({ ok: false, why: j1.why, step: 1, seen: j1.seen })
      const result = testResult(random)
      const two = await send(step2Body(model, j1.toolUse!, result.text))
      if (!two) return { ok: false, why: 'stale' } // i18n-ignore: a failure's code, not text (the window says each in its words)
      if (two.status === 0) return finish({ ok: false, why: 'unreachable', step: 2 }) // i18n-ignore: a failure's code, not text (the window says each in its words)
      const j2 = judgeStep2(two, result.code)
      return finish(j2.ok ? { ok: true, at: 0 } : { ok: false, why: j2.why, step: 2, seen: j2.seen })
    },
    { ok: false, why: 'stale' }, // i18n-ignore: a failure's code, not text (the window says each in its words)
    { ok: false, why: 'busy' } // i18n-ignore: a failure's code, not text (the window says each in its words)
  )
}

/** Whether a base URL reaches a server's own root (no path): only then are its context fields asked for. */
export const rootOf = (baseUrl: string): boolean => {
  const b = parseBaseUrl(baseUrl)
  return b.ok && b.url === b.origin
}

// Told when a server connection's server, key or models change (serverConnections.ts), and when it is removed (accounts.ts).
onServerChanged(serverChecksChanged)
onAccountRemoved(serverChecksChanged)
