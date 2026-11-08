import type { Account, ProviderId, ServerConnection, ServerModel } from '../shared/types'
import type { ServerCaps, ServerListing } from '../shared/providers'
import { providerDescriptor } from '../shared/providers'
import { msg, type Msg } from '../shared/i18n'
import { cleanModels, keepListedRemote, keyProblem, listedIds, listedRemote, listingUrl, mergeListed, parseBaseUrl, type BaseUrlProblem, type ServerModelsRead } from '../shared/serverConnection'
import { CONTEXT_MAX, tokensOf } from '../shared/serverDiagnostics'
import { outputFits } from '../shared/localModelLimits'
import { accountFolder, addAccount, connectionInternals, connectionReadyAgain, effectiveModels, getAccount, isServer, loginKey, readSetUp, rereadTrust, serverEnv } from './accounts'
import { hasPty } from './ptyHost'
import { emit } from './events'
import { combworkError } from './combworkError'
import { keyInfo, removeKey, saveKey, withKey } from './keyStore'
import { createLogger, userText } from './logger'
import { plainHttpGet, type PlainReply } from './plainHttpsJson'
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
const { locked, mustGet, change } = connectionInternals

/**
 * What else follows a server connection (HI-2683: its diagnostics, main/serverDiagnostics.ts, which registers here rather
 * than this module importing it): told when its server, key or models change, so what was asked for them stops and what
 * was read of them is dropped.
 */
const changedHooks: ((id: string) => void)[] = []
export function onServerChanged(fn: (id: string) => void): void {
  changedHooks.push(fn)
}
function serverChanged(id: string): void {
  for (const fn of changedHooks) {
    try {
      fn(id)
    } catch (e) {
      log.warn('a server connection hook failed', e)
    }
  }
}

/** How long a model listing may take, and how much of its reply is read. */
const LIST_TIMEOUT_MS = 10_000
const LIST_MAX_BYTES = 1024 * 1024

const URL_PROBLEM: Record<BaseUrlProblem, Msg> = {
  invalid: msg({ id: 'main.server.url.invalid', defaultMessage: "That isn't a URL Combwork can use: write it in full, such as https://api.example.com.", description: "An error saving a server connection's base URL (Settings → Accounts & Connections): it can't be read as a URL." }),
  scheme: msg({ id: 'main.server.url.scheme', defaultMessage: 'The URL must start with https:// (or http:// for a server on this PC).', description: "An error saving a server connection's base URL: it isn't http or https." }),
  userinfo: msg({ id: 'main.server.url.userinfo', defaultMessage: "The URL can't hold a user name or password: give the key in its own field.", description: "An error saving a server connection's base URL: it has user:password@ in it, which Combwork won't keep." }),
  extra: msg({ id: 'main.server.url.extra', defaultMessage: "The URL can't have a query (?…) or a fragment (#…): give the key in its own field.", description: "An error saving a server connection's base URL: it has a query string or a fragment, which Combwork won't keep (a key could be in it)." }),
  remoteHttp: msg({ id: 'main.server.url.remoteHttp', defaultMessage: 'A server on another computer needs https://. Plain http:// is only for a server on this PC (localhost).', description: "An error saving a server connection's base URL: it uses http:// to a server that isn't on this computer, which would send the key unencrypted." })
}
const KEY_PROBLEM = {
  chars: msg({ id: 'main.server.key.chars', defaultMessage: 'A key has no spaces or special characters outside plain ASCII. Check what was pasted.', description: "An error saving a server connection's API key (Settings → Accounts & Connections): it has spaces, line breaks or non-ASCII characters. The key itself is never shown." }),
  length: msg({ id: 'main.server.key.length', defaultMessage: 'A key is between {min, number} and {max, number} characters long. Check what was pasted.', description: "An error saving a server connection's API key: it is too short or too long. {min} and {max} are numbers. The key itself is never shown." })
}
const KEY_IN = msg({ id: 'main.server.key.inField', defaultMessage: 'The key appears in the {field, select, name {name} url {base URL} other {model list}}: take it out of there first. Nothing was saved.', description: "An error saving a server connection's API key: the key was also typed into another field ({field}: its name, its base URL or its models), where it would be kept unencrypted." })
const NOT_SERVER = msg({ id: 'main.server.notServer', defaultMessage: "That connection doesn't get its model from a server.", description: 'An error: an action for a server connection (its key, its models, its Set Up) was asked for a connection signed in through its CLI instead.' })
const NO_SERVERS = msg({ id: 'main.server.unsupported', defaultMessage: "{cli} can't get its model from a server in Combwork.", description: 'An error adding a server connection for a coding agent CLI ({cli}: "Codex") that Combwork has no server connections for.' })

function capsOf(cli: ProviderId): ServerCaps {
  const caps = providerDescriptor(cli).capabilities.connections?.server
  if (!caps) throw combworkError(NO_SERVERS, { cli: providerDescriptor(cli).name }, { kind: 'invalid' })
  return caps
}

export function serverOf(id: string): { a: Account; server: ServerConnection; caps: ServerCaps } {
  const a = mustGet(id)
  if (!isServer(a) || !a.server) throw combworkError(NOT_SERVER, undefined, { kind: 'invalid' })
  return { a, server: a.server, caps: capsOf(a.provider) }
}

export function checkedUrl(raw: string): { url: string; origin: string; local: boolean } {
  const b = parseBaseUrl(raw)
  if (!b.ok) throw combworkError(URL_PROBLEM[b.why], undefined, { kind: 'invalid' })
  return b
}

function checkedKey(key: string): string {
  const p = keyProblem(key)
  if (p === 'length') throw combworkError(KEY_PROBLEM.length, { min: 16, max: 512 }, { kind: 'invalid' })
  if (p) throw combworkError(KEY_PROBLEM.chars, undefined, { kind: 'invalid' })
  return key
}

/** Refuses a key that also appears in a field kept unencrypted (its name, base URL, a model's id or label). */
function assertKeyNotIn(key: string, fields: { name: string; url: string; models: readonly ServerModel[] }): void {
  const field = fields.name.includes(key) ? 'name' : fields.url.includes(key) ? 'url' : fields.models.some((m) => m.id.includes(key) || !!m.label?.includes(key)) ? 'models' : null
  if (field) throw combworkError(KEY_IN, { field }, { kind: 'invalid' })
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
export async function addServerConnection(input: ServerInput): Promise<Account & { keyFailed?: boolean }> {
  const caps = capsOf(input.cli)
  const b = checkedUrl(input.baseUrl)
  const preset = caps.presets.find((p) => p.id === input.preset)?.id
  // Typed (nothing read from its server yet): none marked remote (HI-1773; its preset's pattern applies as it runs).
  const models = keepListedRemote(input.models ?? [], [])
  const key = input.key ? checkedKey(input.key) : undefined
  // Checked before anything is made: a key in a field that is kept unencrypted refuses it all.
  if (key) assertKeyNotIn(key, { name: input.name, url: b.url, models })
  {
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
  }
}

/**
 * Changes a server connection's server (its base URL, preset, models): a base URL at another origin removes its key in
 * the same locked step (`keyCleared`), so a key is never sent to a server it wasn't saved for.
 */
export async function editServerConnection(id: string, patch: { baseUrl?: string; preset?: string | null; models?: ServerModel[]; modelsFrom?: 'typed' | 'listed' }): Promise<{ keyCleared: boolean }> {
  serverOf(id)
  return locked(id, async () => {
    const { server, caps } = serverOf(id)
    const b = patch.baseUrl !== undefined ? checkedUrl(patch.baseUrl) : null
    // Each model's output below its context (HI-2682): refused whole before anything changes, naming the first that isn't.
    const models = patch.models ? keepListedRemote(patch.models, server.models) : null
    const bad = models ? limitsProblem(models) : null
    if (bad) throw combworkError(NOT_BELOW, bad, { kind: 'invalid' })
    // A reading of its models under way was for the server as it was: ended (and its reply stale anyway).
    if (b || patch.preset !== undefined) cancelServerModels(id)
    // Its diagnostics were for the server and models as they were (HI-2683).
    serverChanged(id)
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
      // A model its server's listing marked remote stays so through an edit of its names (HI-1773); the window can't
      // mark or unmark one.
      if (models) s.models = models
      if (patch.modelsFrom) s.modelsFrom = patch.modelsFrom === 'listed' ? 'listed' : 'typed'
      a.server = s
    })
    if (keyCleared) log.info(`connection ${id}: its base URL moved to another server, so its key was removed`)
    return { keyCleared }
  })
}

/** Saves (or replaces) a server connection's key, for its base URL's origin. Returns what the view shows. */
export async function setServerKey(id: string, key: string): Promise<{ last4: string }> {
  checkedKey(key)
  serverOf(id)
  {
    return await locked(id, async () => {
      const { a, server } = serverOf(id)
      const b = checkedUrl(server.baseUrl)
      assertKeyNotIn(key, { name: a.name, url: b.url, models: server.models })
      // A reading of its models under way used the key before: ended; and its diagnostics (HI-2683).
      cancelServerModels(id)
      serverChanged(id)
      const info = await saveKey(id, b.origin, key)
      emit({ type: 'connections-changed' })
      // Agents a refused key stopped can carry on (Resume), as after signing in again.
      connectionReadyAgain(id)
      return { last4: info.last4 }
    })
  }
}

/**
 * Sets the context the user says one of its models has (HI-2683, `ServerModel.context`, shared with HI-2682), or clears
 * it (null). Only ever the user's: a server's reported values never come here.
 */
export async function setServerModelContext(id: string, model: string, tokens: number | null): Promise<void> {
  serverOf(id)
  const value = tokens === null ? null : tokensOf(tokens)
  if (tokens !== null && !value) throw combworkError(CONTEXT_PROBLEM, { max: CONTEXT_MAX }, { kind: 'invalid' })
  await locked(id, async () => {
    const { server } = serverOf(id)
    const was = server.models.find((m) => m.id === model)
    if (!was) throw combworkError(NO_MODEL, { model }, { kind: 'notFound' })
    // Never at or under its output budget (HI-2682): refused, naming both, the output never changed for it.
    if (value && was.output && was.output >= value) throw combworkError(NOT_BELOW, { model, output: was.output, context: value }, { kind: 'invalid' })
    change(id, (a) => (a.server = { ...a.server!, models: cleanModels(a.server!.models.map(({ context: _c, ...m }) => (m.id === model && value ? { ...m, context: value } : m.id === model ? m : { ...m, ...(_c ? { context: _c } : {}) }))) }))
  })
  emit({ type: 'connections-changed' })
}

/**
 * Sets the output budget the user gives one of its models (HI-2682, `ServerModel.output`), or clears it (null: the
 * default): a whole number of tokens, below its context when that is set (refused otherwise, nothing changed).
 */
export async function setServerModelOutput(id: string, model: string, tokens: number | null): Promise<void> {
  serverOf(id)
  const value = tokens === null ? null : tokensOf(tokens)
  if (tokens !== null && !value) throw combworkError(OUTPUT_PROBLEM, { max: CONTEXT_MAX }, { kind: 'invalid' })
  await locked(id, async () => {
    const { server } = serverOf(id)
    const was = server.models.find((m) => m.id === model)
    if (!was) throw combworkError(NO_MODEL, { model }, { kind: 'notFound' })
    if (value && was.context && value >= was.context) throw combworkError(NOT_BELOW, { model, output: value, context: was.context }, { kind: 'invalid' })
    change(id, (a) => (a.server = { ...a.server!, models: cleanModels(a.server!.models.map(({ output: _o, ...m }) => (m.id === model ? { ...m, ...(value ? { output: value } : {}) } : { ...m, ...(_o ? { output: _o } : {}) }))) }))
  })
  emit({ type: 'connections-changed' })
}

/** A model's saved limits that don't fit each other (HI-2682): the first whose output isn't below its context, or null. */
export function limitsProblem(models: readonly ServerModel[]): { model: string; output: number; context: number } | null {
  const m = models.find((x) => !outputFits(x))
  return m ? { model: m.id, output: m.output!, context: m.context! } : null
}

const CONTEXT_PROBLEM = msg({ id: 'main.server.context.invalid', defaultMessage: 'A context size is a whole number of tokens, from 1 to {max, number}.', description: "An error saving the context size a user typed for a server connection's model (its Server diagnostics): not a whole number in range. {max} is a number." })
const OUTPUT_PROBLEM = msg({ id: 'main.server.output.invalid', defaultMessage: 'An output budget is a whole number of tokens, from 1 to {max, number}.', description: "An error saving the output budget a user typed for a server connection's model (HI-2682): not a whole number in range. {max} is a number." })
const NOT_BELOW = msg({ id: 'main.server.output.notBelow', defaultMessage: 'The output budget of {model} ({output, number} tokens) must be smaller than its context size ({context, number} tokens). Lower the output budget first, or clear it to use the default.', description: "An error saving a server connection's model limits (HI-2682): its output budget isn't below its context size, so nothing was saved. {model} is a model's id; {output} and {context} are numbers of tokens. Output budget and context size are fields of the connection's models: as translated there." })
const NO_MODEL = msg({ id: 'main.server.context.noModel', defaultMessage: 'The connection has no model {model} now.', description: "An error saving a server connection's model context: the model was removed from the connection meanwhile. {model} is a model's id." })

/** Removes a server connection's key (Remove Key): it then has none, and a launch needing one is refused. */
export async function removeServerKey(id: string): Promise<void> {
  serverOf(id)
  cancelServerModels(id)
  serverChanged(id)
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
  const { server, caps } = serverOf(id)
  const b = checkedUrl(server.baseUrl)
  const url = listingUrl(server.baseUrl, listingOf(server, caps))
  if (!url) return { ok: false, why: 'shape' } // i18n-ignore: a reason's code, not text
  cancelServerModels(id)
  const abort = new AbortController()
  listings.set(id, { request, abort })
  const timer = setTimeout(() => abort.abort(), LIST_TIMEOUT_MS)
  const got = await withKey(id, b.origin)
  // What this reading was made for: the base URL in full (its path too), the preset and the key's own save id. Any of
  // them changed since (or a newer reading, or the connection gone), and whatever came back is stale.
  const asked = { baseUrl: server.baseUrl, preset: server.preset ?? null, key: got?.v ?? null }
  const current = (): boolean => {
    const now = getAccount(id)
    const k = keyInfo(id)
    return listings.get(id)?.request === request && !!now?.server && now.server.baseUrl === asked.baseUrl && (now.server.preset ?? null) === asked.preset && (k && k.origin === b.origin ? k.v : null) === asked.key
  }
  const said = (r: Exclude<ListResult, { ok: true }>): ListResult => (current() ? r : { ok: false, why: 'stale' }) // i18n-ignore: a reason's code, not text
  try {
    // Node's http(s), not fetch (HI-1836): no reply reaches Node's Brotli decoder (#1582); none is followed elsewhere.
    let res: PlainReply
    try {
      res = await plainHttpGet(url, { maxBytes: LIST_MAX_BYTES, signal: abort.signal, headers: { Accept: 'application/json', ...(got ? { Authorization: `Bearer ${got.key}` } : {}) } }) // i18n-ignore: an HTTP header
    } catch {
      return said({ ok: false, why: 'unreachable' }) // i18n-ignore: a reason's code, not text
    }
    if (res.status >= 300 && res.status < 400) return said({ ok: false, why: 'redirect', status: res.status }) // i18n-ignore: a reason's code, not text
    if (res.status === 401) return said({ ok: false, why: 'refused', status: 401 }) // i18n-ignore: a reason's code, not text
    if (res.status === 403) return said({ ok: false, why: 'forbidden', status: 403 }) // i18n-ignore: a reason's code, not text
    if (res.status < 200 || res.status >= 300) return said({ ok: false, why: 'failed', status: res.status }) // i18n-ignore: a reason's code, not text
    if (res.refused === 'tooBig') return said({ ok: false, why: 'tooBig' }) // i18n-ignore: a reason's code, not text
    // An encoded reply is refused unread: not a listing Combwork can read.
    if (res.refused) return said({ ok: false, why: 'shape' }) // i18n-ignore: a reason's code, not text
    let parsed: unknown
    try {
      parsed = JSON.parse(res.text)
    } catch {
      return said({ ok: false, why: 'shape' }) // i18n-ignore: a reason's code, not text
    }
    const ids = listedIds(parsed, listingOf(server, caps))
    if (!ids) return said({ ok: false, why: 'shape' }) // i18n-ignore: a reason's code, not text
    // Remote as this reading says (HI-1773): the server's own mark (its preset's pattern applies as the models run).
    const marked = new Set(listedRemote(parsed, listingOf(server, caps)))
    // Kept only if this is still the reading asked for, on the same server (its whole base URL) with the same key.
    return await locked(id, async () => {
      const now = getAccount(id)
      if (!now || !current()) return { ok: false, why: 'stale' } as const // i18n-ignore: a reason's code, not text
      const merged = mergeListed(now.server!.models, ids, (m) => marked.has(m))
      change(id, (a) => (a.server = { ...a.server!, models: merged.models, modelsFrom: 'listed' }))
      log.info(`connection ${id}: ${ids.length} model(s) read from its server`)
      return { ok: true, models: effectiveModels(caps, { ...now.server!, models: merged.models }), dropped: merged.dropped } as const
    })
  } catch (e) {
    log.warn(`connection ${id}'s models couldn't be read: ${userText(String((e as Error).message ?? e))}`)
    return { ok: false, why: 'failed' } // i18n-ignore: a reason's code, not text
  } finally {
    clearTimeout(timer)
    if (listings.get(id)?.request === request) listings.delete(id)
  }
}

// ---------------------------------------------------------------------------
// Set Up: the CLI's first-run screens, in a terminal of Combwork's.
// ---------------------------------------------------------------------------

/**
 * Opens the CLI in a server connection's folder, with its server's variables, so the user answers its first-run screens
 * (its theme, its notes) in its own way before an agent starts on it: Combwork types nothing and writes none of its files.
 * The key (if any) is masked while the terminal is open. Returns the terminal's key.
 */
export async function setUpServerConnection(id: string, folder?: string): Promise<string> {
  serverOf(id)
  return locked(id, async () => {
    const { a, server, caps } = serverOf(id)
    // Already open: that one (its key's use is already counted until it closes).
    if (hasPty(loginKey(a))) return loginKey(a)
    await connectionInternals.assertUsable(a)
    const b = checkedUrl(server.baseUrl)
    const got = await withKey(id, b.origin)
    if (!got && !b.local) throw combworkError(msg({ id: 'main.server.setUp.noKey', defaultMessage: '{name} has no key yet. Add its key first, then set it up.', description: "An error opening Set Up for a server connection ({name}, its name in Settings → Accounts & Connections): its server needs an API key and none is saved." }), { name: a.name }, { kind: 'conflict' })
    const homeEnv = providerDescriptor(a.provider).capabilities.connections!.homeEnv
    // Once it ends, its set-up state is read again (HI-1870).
    return providerService.runAccountLogin(a.provider, id, { [homeEnv]: accountFolder(id) }, () => (void readSetUp(id), rereadTrust(id)), { env: serverEnv(caps, server, got?.key ?? null), cwd: folder ?? accountFolder(id) })
  })
}
