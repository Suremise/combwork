import type { Connection, ProviderId, ServerConnection, ServerModel } from '../shared/types'
import type { ServerCaps, ServerListing } from '../shared/providers'
import { providerDescriptor } from '../shared/providers'
import { msg, type Msg } from '../shared/i18n'
import { cleanModels, keyProblem, listedIds, listingUrl, mergeListed, parseBaseUrl, type BaseUrlProblem, type ServerModelsRead } from '../shared/serverConnection'
import { accountFolder, addAccount, connectionInternals, connectionReadyAgain, getAccount, isServer, loginKey, serverEnv } from './accounts'
import { hasPty } from './ptyHost'
import { emit } from './events'
import { hiveError } from './hiveError'
import { holdKey } from './keyMatcher'
import { keyInfo, removeKey, saveKey, withKey } from './keyStore'
import { createLogger, userText } from './logger'
import { providerService } from './providerService'

/**
 * Server connections (HI-1772, SPEC §11.2): a connection that gets its model from a server of the user's (DeepSeek's,
 * Ollama's, a company gateway) by a base URL, with a key or, for this machine's server, none. Its folder is made as a
 * sign-in connection's (its `projects\` junction shared), with nothing to sign in; its key is in the key store, bound to
 * the base URL's origin, and never sent to a window. Lock order: the connection's own lock, then the key store's.
 *
 * Its models are typed, or read from the server when the user asks (never at a launch): one bounded request from here,
 * redirects refused, the key (if any) decrypted for that request alone.
 */

const log = createLogger('servers')
const { locked, assertOn, mustGet, change } = connectionInternals

/** How long a model listing may take, and how much of its reply is read. */
const LIST_TIMEOUT_MS = 10_000
const LIST_MAX_BYTES = 1024 * 1024

const URL_PROBLEM: Record<BaseUrlProblem, Msg> = {
  invalid: msg({ id: 'main.server.url.invalid', defaultMessage: "That isn't a URL Hive can use: write it in full, such as https://api.example.com.", description: "An error saving a server connection's base URL (Settings → Connections): it can't be read as a URL." }),
  scheme: msg({ id: 'main.server.url.scheme', defaultMessage: 'The URL must start with https:// (or http:// for a server on this PC).', description: "An error saving a server connection's base URL: it isn't http or https." }),
  userinfo: msg({ id: 'main.server.url.userinfo', defaultMessage: "The URL can't hold a user name or password: give the key in its own field.", description: "An error saving a server connection's base URL: it has user:password@ in it, which Hive won't keep." }),
  extra: msg({ id: 'main.server.url.extra', defaultMessage: "The URL can't have a query (?…) or a fragment (#…): give the key in its own field.", description: "An error saving a server connection's base URL: it has a query string or a fragment, which Hive won't keep (a key could be in it)." }),
  remoteHttp: msg({ id: 'main.server.url.remoteHttp', defaultMessage: 'A server on another computer needs https://. Plain http:// is only for a server on this PC (localhost).', description: "An error saving a server connection's base URL: it uses http:// to a server that isn't on this computer, which would send the key unencrypted." })
}
const KEY_PROBLEM = {
  chars: msg({ id: 'main.server.key.chars', defaultMessage: 'A key has no spaces or special characters outside plain ASCII. Check what was pasted.', description: "An error saving a server connection's API key (Settings → Connections): it has spaces, line breaks or non-ASCII characters. The key itself is never shown." }),
  length: msg({ id: 'main.server.key.length', defaultMessage: 'A key is between {min, number} and {max, number} characters long. Check what was pasted.', description: "An error saving a server connection's API key: it is too short or too long. {min} and {max} are numbers. The key itself is never shown." })
}
const KEY_IN = msg({ id: 'main.server.key.inField', defaultMessage: 'The key appears in the {field, select, name {name} url {base URL} other {model list}}: take it out of there first. Nothing was saved.', description: "An error saving a server connection's API key: the key was also typed into another field ({field}: its name, its base URL or its models), where it would be kept unencrypted." })
const NOT_SERVER = msg({ id: 'main.server.notServer', defaultMessage: "That connection doesn't get its model from a server.", description: 'An error: an action for a server connection (its key, its models, its Set Up) was asked for a connection signed in through its CLI instead.' })
const NO_SERVERS = msg({ id: 'main.server.unsupported', defaultMessage: "{cli} can't get its model from a server in Hive.", description: 'An error adding a server connection for a coding agent CLI ({cli}: "Codex") that Hive has no server connections for.' })

function capsOf(cli: ProviderId): ServerCaps {
  const caps = providerDescriptor(cli).capabilities.connections?.server
  if (!caps) throw hiveError(NO_SERVERS, { cli: providerDescriptor(cli).name }, { kind: 'invalid' })
  return caps
}

function serverOf(id: string): { a: Connection; server: ServerConnection; caps: ServerCaps } {
  const a = mustGet(id)
  if (!isServer(a) || !a.server) throw hiveError(NOT_SERVER, undefined, { kind: 'invalid' })
  return { a, server: a.server, caps: capsOf(a.provider) }
}

function checkedUrl(raw: string): { url: string; origin: string; local: boolean } {
  const b = parseBaseUrl(raw)
  if (!b.ok) throw hiveError(URL_PROBLEM[b.why], undefined, { kind: 'invalid' })
  return b
}

function checkedKey(key: string): string {
  const p = keyProblem(key)
  if (p === 'length') throw hiveError(KEY_PROBLEM.length, { min: 16, max: 512 }, { kind: 'invalid' })
  if (p) throw hiveError(KEY_PROBLEM.chars, undefined, { kind: 'invalid' })
  return key
}

/** Refuses a key that also appears in a field kept unencrypted (its name, base URL or a model id). */
function assertKeyNotIn(key: string, fields: { name: string; url: string; models: readonly ServerModel[] }): void {
  const field = fields.name.includes(key) ? 'name' : fields.url.includes(key) ? 'url' : fields.models.some((m) => m.id.includes(key)) ? 'models' : null
  if (field) throw hiveError(KEY_IN, { field }, { kind: 'invalid' })
}

export interface ServerInput {
  cli: ProviderId
  name: string
  baseUrl: string
  preset?: string
  models: ServerModel[]
  modelsFrom: 'typed' | 'listed'
  /** Given only on Add, once: the key, when the server needs one. */
  key?: string
}

/**
 * Adds a server connection: its folder made, then its key (when given) saved for its base URL's origin. A key that
 * can't be saved leaves the connection added with no key, and says so.
 */
export async function addServerConnection(input: ServerInput): Promise<Connection & { keyFailed?: boolean }> {
  assertOn()
  const caps = capsOf(input.cli)
  const b = checkedUrl(input.baseUrl)
  const preset = caps.presets.find((p) => p.id === input.preset)?.id
  const models = cleanModels(input.models ?? [])
  const key = input.key ? checkedKey(input.key) : undefined
  // Checked before anything is made: a key in a field that is kept unencrypted refuses it all.
  if (key) assertKeyNotIn(key, { name: input.name, url: b.url, models })
  const endUse = key ? holdKey(key) : null
  try {
    const a = await addAccount(input.cli, input.name, { baseUrl: b.url, ...(preset ? { preset } : {}), models, modelsFrom: input.modelsFrom === 'listed' ? 'listed' : 'typed' })
    let keyFailed = false
    if (key) {
      try {
        await locked(a.id, () => saveKey(a.id, b.origin, key))
      } catch (e) {
        // Added with no key: said, and its row offers Add Key (adding again would make a second one).
        keyFailed = true
        log.warn(`connection ${a.id}: added, but its key couldn't be saved: ${userText(String((e as Error).message ?? e))}`)
      }
    }
    emit({ type: 'connections-changed' })
    return keyFailed ? { ...a, keyFailed } : a
  } finally {
    endUse?.()
  }
}

/**
 * Changes a server connection's server (its base URL, preset, models): a base URL at another origin removes its key in
 * the same locked step (`keyCleared`), so a key is never sent to a server it wasn't saved for.
 */
export async function editServerConnection(id: string, patch: { baseUrl?: string; preset?: string | null; models?: ServerModel[]; modelsFrom?: 'typed' | 'listed' }): Promise<{ keyCleared: boolean }> {
  assertOn()
  serverOf(id)
  return locked(id, async () => {
    const { server, caps } = serverOf(id)
    const b = patch.baseUrl !== undefined ? checkedUrl(patch.baseUrl) : null
    const before = parseBaseUrl(server.baseUrl)
    const moved = !!b && (!before.ok || before.origin !== b.origin)
    let keyCleared = false
    if (moved) keyCleared = await removeKey(id)
    change(id, (a) => {
      const s = { ...a.server! }
      if (b) s.baseUrl = b.url
      if (patch.preset !== undefined) {
        const p = caps.presets.find((x) => x.id === patch.preset)?.id
        if (p) s.preset = p
        else delete s.preset
      }
      if (patch.models) s.models = cleanModels(patch.models)
      if (patch.modelsFrom) s.modelsFrom = patch.modelsFrom === 'listed' ? 'listed' : 'typed'
      a.server = s
    })
    if (keyCleared) log.info(`connection ${id}: its base URL moved to another server, so its key was removed`)
    return { keyCleared }
  })
}

/** Saves (or replaces) a server connection's key, for its base URL's origin. Returns what the view shows. */
export async function setServerKey(id: string, key: string): Promise<{ last4: string }> {
  assertOn()
  checkedKey(key)
  serverOf(id)
  const endUse = holdKey(key)
  try {
    return await locked(id, async () => {
      const { a, server } = serverOf(id)
      const b = checkedUrl(server.baseUrl)
      assertKeyNotIn(key, { name: a.name, url: b.url, models: server.models })
      const info = await saveKey(id, b.origin, key)
      emit({ type: 'connections-changed' })
      // Agents a refused key stopped can carry on (Resume), as after signing in again.
      connectionReadyAgain(id)
      return { last4: info.last4 }
    })
  } finally {
    endUse()
  }
}

/** Removes a server connection's key (Remove Key): it then has none, and a launch needing one is refused. */
export async function removeServerKey(id: string): Promise<void> {
  assertOn()
  serverOf(id)
  await locked(id, () => removeKey(id))
  emit({ type: 'connections-changed' })
}

// ---------------------------------------------------------------------------
// Reading a server's models (when the user asks).
// ---------------------------------------------------------------------------

type ListResult = ServerModelsRead

/** Per connection, the listing under way: a newer one, a closed dialog or a change of its server or key ends it. */
const listings = new Map<string, { request: string; abort: AbortController }>()

/** The listing a connection's models are read with: its preset's, else its CLI's. */
function listingOf(server: ServerConnection, caps: ServerCaps): ServerListing {
  return caps.presets.find((p) => p.id === server.preset)?.listing ?? caps.listing
}

/** Ends a connection's model listing under way (its dialog closed), if it is `request`'s (or any, without one). */
export function cancelServerModels(id: string, request?: string): void {
  const l = listings.get(id)
  if (!l || (request && l.request !== request)) return
  l.abort.abort()
  listings.delete(id)
}

/**
 * Reads a server connection's models from its server and keeps them, the mappings of those still listed kept. One
 * request, from here: its key (if any) decrypted for it alone, redirects refused, at most LIST_MAX_BYTES read within
 * LIST_TIMEOUT_MS. A newer listing, its server or key changed meanwhile, or the connection gone: `stale`, nothing kept.
 * What a failure says is its kind (and HTTP status), never the server's reply.
 */
export async function readServerModels(id: string, request: string): Promise<ListResult> {
  assertOn()
  const { server, caps } = serverOf(id)
  const b = checkedUrl(server.baseUrl)
  const url = listingUrl(server.baseUrl, listingOf(server, caps))
  if (!url) return { ok: false, why: 'shape' } // i18n-ignore: a reason's code, not text
  cancelServerModels(id)
  const abort = new AbortController()
  listings.set(id, { request, abort })
  const timer = setTimeout(() => abort.abort(), LIST_TIMEOUT_MS)
  const got = await withKey(id, b.origin)
  const endUse = got ? holdKey(got.key) : () => undefined
  try {
    let res: Response
    try {
      res = await fetch(url, { method: 'GET', redirect: 'manual', signal: abort.signal, headers: { accept: 'application/json', ...(got ? { authorization: `Bearer ${got.key}` } : {}) } }) // i18n-ignore: an HTTP header
    } catch {
      return listings.get(id)?.request === request ? { ok: false, why: 'unreachable' } : { ok: false, why: 'stale' } // i18n-ignore: a reason's code, not text
    }
    if (res.status >= 300 && res.status < 400) return { ok: false, why: 'redirect', status: res.status } // i18n-ignore: a reason's code, not text
    if (res.status === 401) return { ok: false, why: 'refused', status: 401 } // i18n-ignore: a reason's code, not text
    if (res.status === 403) return { ok: false, why: 'forbidden', status: 403 } // i18n-ignore: a reason's code, not text
    if (!res.ok) return { ok: false, why: 'failed', status: res.status } // i18n-ignore: a reason's code, not text
    const body = await readBounded(res, abort)
    if (body === null) return listings.get(id)?.request === request ? { ok: false, why: 'tooBig' } : { ok: false, why: 'stale' } // i18n-ignore: a reason's code, not text
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { ok: false, why: 'shape' } // i18n-ignore: a reason's code, not text
    }
    const ids = listedIds(parsed, listingOf(server, caps))
    if (!ids) return { ok: false, why: 'shape' } // i18n-ignore: a reason's code, not text
    // Kept only if this is still the listing asked for, on the same server with the same key.
    return await locked(id, async () => {
      const now = getAccount(id)
      const nowUrl = now?.server ? parseBaseUrl(now.server.baseUrl) : null
      const keyNow = keyInfo(id)
      if (listings.get(id)?.request !== request || !now || !nowUrl?.ok || nowUrl.origin !== b.origin || (keyNow?.origin === b.origin ? keyNow.v : null) !== (got?.v ?? null)) return { ok: false, why: 'stale' } as const // i18n-ignore: a reason's code, not text
      const merged = mergeListed(now.server!.models, ids)
      change(id, (a) => (a.server = { ...a.server!, models: merged.models, modelsFrom: 'listed' }))
      log.info(`connection ${id}: ${ids.length} model(s) read from its server`)
      return { ok: true, models: merged.models, dropped: merged.dropped } as const
    })
  } catch (e) {
    log.warn(`connection ${id}'s models couldn't be read: ${userText(String((e as Error).message ?? e))}`)
    return { ok: false, why: 'failed' } // i18n-ignore: a reason's code, not text
  } finally {
    clearTimeout(timer)
    endUse()
    if (listings.get(id)?.request === request) listings.delete(id)
  }
}

/** A reply's text, read until LIST_MAX_BYTES: past that (or aborted) null, the request ended. */
async function readBounded(res: Response, abort: AbortController): Promise<string | null> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > LIST_MAX_BYTES) {
        abort.abort()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ---------------------------------------------------------------------------
// Set Up: the CLI's first-run screens, in a terminal of Hive's.
// ---------------------------------------------------------------------------

/**
 * Opens the CLI in a server connection's folder, with its server's variables, so the user answers its first-run screens
 * (its theme, its notes) in its own way before an agent starts on it: Hive types nothing and writes none of its files.
 * The key (if any) is masked while the terminal is open. Returns the terminal's key.
 */
export async function setUpServerConnection(id: string): Promise<string> {
  assertOn()
  serverOf(id)
  return locked(id, async () => {
    const { a, server, caps } = serverOf(id)
    // Already open: that one (its key's use is already counted until it closes).
    if (hasPty(loginKey(a))) return loginKey(a)
    await connectionInternals.assertUsable(a)
    const b = checkedUrl(server.baseUrl)
    const got = await withKey(id, b.origin)
    if (!got && !b.local) throw hiveError(msg({ id: 'main.server.setUp.noKey', defaultMessage: '{name} has no key yet. Add its key first, then set it up.', description: "An error opening Set Up for a server connection ({name}, its name in Settings → Connections): its server needs an API key and none is saved." }), { name: a.name }, { kind: 'conflict' })
    const endUse = got ? holdKey(got.key) : () => undefined
    const homeEnv = providerDescriptor(a.provider).capabilities.connections!.homeEnv
    try {
      return providerService.runAccountLogin(a.provider, id, { [homeEnv]: accountFolder(id) }, () => endUse(), { env: serverEnv(caps, server, got?.key ?? null), cwd: accountFolder(id) })
    } catch (e) {
      endUse()
      throw e
    }
  })
}
