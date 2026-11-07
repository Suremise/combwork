import { tokensOf } from './serverDiagnostics'
import type { ServerListing } from './providers'
import type { ModelAlias, ServerModel } from './types'

/**
 * A server connection's rules (HI-1772), pure for main and the window alike: which base URLs are accepted (and which are
 * local, so may go without a key), what a key and a model id may be, and how models stand in for the CLI's aliases.
 */

export const MODEL_ALIASES: readonly ModelAlias[] = ['opus', 'sonnet', 'haiku']

/**
 * A reading of a server's models (HI-1772): its models kept (and the ids no longer listed), or why not, by kind only
 * (and its HTTP status), never what the server said; `stale`, a newer reading or a change of its server or key won.
 */
export type ServerModelsRead =
  | { ok: true; models: ServerModel[]; dropped: string[] }
  | { ok: false; why: 'refused' | 'forbidden' | 'unreachable' | 'failed' | 'shape' | 'redirect' | 'tooBig' | 'stale'; status?: number }

/** A key's bounds: printable ASCII, no spaces (an API key, a bearer token). */
export const KEY_MIN = 16
export const KEY_MAX = 512
/** Read from a server's model listing: at most this many ids. */
export const LISTED_MAX = 500
export const MODEL_ID_MAX = 200

export type BaseUrlProblem = 'invalid' | 'scheme' | 'userinfo' | 'extra' | 'remoteHttp'
export type BaseUrl = { ok: true; url: string; origin: string; local: boolean } | { ok: false; why: BaseUrlProblem }

/**
 * Whether a URL's host is this machine: `localhost`, an IPv4 address in 127.0.0.0/8 (as the URL parser writes it, so
 * `2130706433` is `127.0.0.1`) or `[::1]`. Names that only start or end like one (`localhost.example.com`,
 * `127.0.0.1.nip.io`) and IPv4 written inside IPv6 aren't.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '[::1]') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  return !!m && m.slice(1).every((x) => Number(x) <= 255)
}

/**
 * A base URL as kept (HI-1772): `https:`, or `http:` to this machine; no user name or password, query or fragment (a key
 * pasted into one would be kept in config). Its trailing slashes dropped.
 */
export function parseBaseUrl(raw: string): BaseUrl {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, why: 'invalid' } // i18n-ignore: a reason's code, not text
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'scheme' } // i18n-ignore: a reason's code, not text
  if (u.username || u.password) return { ok: false, why: 'userinfo' } // i18n-ignore: a reason's code, not text
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return { ok: false, why: 'extra' } // i18n-ignore: a reason's code, not text
  if (!u.hostname) return { ok: false, why: 'invalid' } // i18n-ignore: a reason's code, not text
  const local = isLoopbackHost(u.hostname)
  if (u.protocol === 'http:' && !local) return { ok: false, why: 'remoteHttp' } // i18n-ignore: a reason's code, not text
  const path = u.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${u.origin}${path}`, origin: u.origin, local }
}

/** The origin a base URL's key is bound to; null when it isn't a base URL Combwork takes. */
export function originOf(baseUrl: string): string | null {
  const b = parseBaseUrl(baseUrl)
  return b.ok ? b.origin : null
}

export type KeyProblem = 'chars' | 'length'

/** Why a key can't be taken (HI-1772): printable ASCII with no spaces, KEY_MIN to KEY_MAX characters; null: it can. */
export function keyProblem(key: string): KeyProblem | null {
  if (!/^[\x21-\x7e]*$/.test(key)) return 'chars' // i18n-ignore: a reason's code, not text
  if (key.length < KEY_MIN || key.length > KEY_MAX) return 'length' // i18n-ignore: a reason's code, not text
  return null
}

/** The longest name a user gives a server's model (HI-2684, `ServerModel.label`). */
export const MODEL_LABEL_MAX = 80

/**
 * A model's label as kept (HI-2684): a string with its control characters taken out, trimmed, cut to MODEL_LABEL_MAX
 * characters; undefined for anything else or nothing left.
 */
export function labelOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const s = [...v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()].slice(0, MODEL_LABEL_MAX).join('').trim()
  return s || undefined
}

/** A model id as a server names it: letters, digits and `_.:/@+[]-`, at most MODEL_ID_MAX. */
export function validModelId(id: string): boolean {
  return id.length > 0 && id.length <= MODEL_ID_MAX && /^[\w.:/@+[\]-]+$/.test(id)
}

/**
 * A server's models made consistent: valid ids, each once (its first), and each alias on at most one model (its first
 * there); aliases kept in MODEL_ALIASES' order, and `remote` as it was.
 */
export function cleanModels(models: readonly ServerModel[]): ServerModel[] {
  const seen = new Set<string>()
  const taken = new Set<ModelAlias>()
  const out: ServerModel[] = []
  for (const m of models) {
    const id = typeof m?.id === 'string' ? m.id.trim() : ''
    if (!validModelId(id) || seen.has(id)) continue
    seen.add(id)
    const as = MODEL_ALIASES.filter((a) => Array.isArray(m.as) && m.as.includes(a) && !taken.has(a))
    for (const a of as) taken.add(a)
    // The user's context for it (HI-2683), a positive whole number of tokens within CONTEXT_MAX, else none.
    const context = tokensOf(m.context)
    // Its output budget (HI-2682), the same whole number of tokens; kept as stored (its fit with the context is checked
    // where it is set and where a launch uses it, never by dropping it here).
    const output = tokensOf(m.output)
    // The user's name for it (HI-2684), cleaned (labelOf).
    const label = labelOf(m.label)
    out.push({ id, ...(as.length ? { as } : {}), ...(m.remote === true ? { remote: true as const } : {}), ...(context ? { context } : {}), ...(output ? { output } : {}), ...(label ? { label } : {}) })
  }
  return out
}

/**
 * Models as saved from a form (HI-1773): `remote` kept only where its server's listing said so (an edit of its names
 * keeps that, whatever the window sent); the window never marks a model, nor takes a mark off. A preset's pattern is
 * never saved: withRemote applies it as the models are used.
 */
export function keepListedRemote(models: readonly ServerModel[], before: readonly ServerModel[]): ServerModel[] {
  const was = new Set(before.filter((m) => m.remote).map((m) => m.id))
  return cleanModels(models.map(({ remote: _sent, ...m }) => {
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    return was.has(id) ? { ...m, remote: true as const } : m
  }))
}

/**
 * A server's models as they run now (HI-1773): remote where its listing said so, or where its preset's pattern takes
 * the id as it is set now. What a launch, the connection's row, the pickers and the footer all use.
 */
export function withRemote(models: readonly ServerModel[], isRemoteId: (id: string) => boolean): ServerModel[] {
  return models.map((m) => (m.remote || !isRemoteId(m.id) ? m : { ...m, remote: true as const }))
}

/** Each alias's model, where one stands in for it. */
export function aliasModels(models: readonly ServerModel[]): Partial<Record<ModelAlias, string>> {
  const out: Partial<Record<ModelAlias, string>> = {}
  for (const m of models) for (const a of m.as ?? []) out[a] ??= m.id
  return out
}

/** The model a server connection runs when none is chosen: Opus's, else Sonnet's, else its first (accounts.ts serverEnv's). */
export function serverDefaultModel(models: readonly ServerModel[]): string | undefined {
  const alias = aliasModels(models)
  return alias.opus ?? alias.sonnet ?? models[0]?.id
}

/**
 * What a model the CLI reports is on a server connection (HI-1772): the server's model, and the aliases it stands in
 * for (and whether its server runs it elsewhere, HI-1773). The CLI may report an alias's Claude name (`claude-sonnet-…`),
 * which is then that alias's model; an id the table doesn't know is itself, standing in for nothing.
 */
export function serverModelOf(models: readonly ServerModel[], reported: string): { id: string; as: ModelAlias[]; remote?: true } {
  const of = (m: ServerModel): { id: string; as: ModelAlias[]; remote?: true } => ({ id: m.id, as: m.as ?? [], ...(m.remote ? { remote: true as const } : {}) })
  // Its own id, else with a suffix the CLI drops in what it reports (`deepseek-flash[1m]`).
  const own = models.find((m) => m.id === reported) ?? models.find((m) => m.id.replace(/\[[^\]]*\]$/, '') === reported)
  if (own) return of(own)
  const alias = MODEL_ALIASES.find((a) => new RegExp(`^(claude-)?${a}\\b`, 'i').test(reported))
  const mapped = alias ? models.find((m) => m.as?.includes(alias)) : undefined
  return mapped ? of(mapped) : { id: reported, as: [] }
}

/** The URL a listing is read from: its path from the origin when it starts with `/`, else under the base URL. */
export function listingUrl(baseUrl: string, listing: ServerListing): string | null {
  const b = parseBaseUrl(baseUrl)
  if (!b.ok) return null
  return listing.path.startsWith('/') ? `${b.origin}${listing.path}` : `${b.url}/${listing.path}`
}

/** The ids in a listing's reply (its `list` array, each entry's `id` field): valid ones, each once, at most LISTED_MAX. Null: not that shape. */
export function listedIds(reply: unknown, listing: ServerListing): string[] | null {
  const list = reply && typeof reply === 'object' ? (reply as Record<string, unknown>)[listing.list] : undefined
  if (!Array.isArray(list)) return null
  const out: string[] = []
  for (const e of list) {
    const id = e && typeof e === 'object' ? (e as Record<string, unknown>)[listing.id] : undefined
    if (typeof id === 'string' && validModelId(id) && !out.includes(id)) out.push(id)
    if (out.length >= LISTED_MAX) break
  }
  return out
}

/** The ids a listing's reply says its server runs elsewhere (HI-1773): entries whose `remote` field isn't empty. */
export function listedRemote(reply: unknown, listing: ServerListing): string[] {
  const list = listing.remote && reply && typeof reply === 'object' ? (reply as Record<string, unknown>)[listing.list] : undefined
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const { [listing.id]: id, [listing.remote!]: remote } = e as Record<string, unknown>
    if (typeof id === 'string' && typeof remote === 'string' && remote.trim()) out.push(id)
  }
  return out
}

/**
 * A listing's ids as the connection's models: the mappings of ids still listed kept, and whether each is remote as this
 * reading says (`isRemote`: its listing's mark, else its preset's pattern), never as before; `dropped`, the ids no
 * longer listed (said to the user).
 */
export function mergeListed(before: readonly ServerModel[], ids: readonly string[], isRemote: (id: string) => boolean = () => false): { models: ServerModel[]; dropped: string[] } {
  const was = new Map(before.map((m) => [m.id, m]))
  const models = ids.map((id) => {
    const as = was.get(id)?.as
    // The user's context and output budget for a model still listed are theirs, kept (HI-2683, HI-2682): a listing
    // never sets them.
    const context = was.get(id)?.context
    const output = was.get(id)?.output
    // And its label (HI-2684): a listing never names a model.
    const label = was.get(id)?.label
    return { id, ...(as ? { as } : {}), ...(isRemote(id) ? { remote: true as const } : {}), ...(context ? { context } : {}), ...(output ? { output } : {}), ...(label ? { label } : {}) }
  })
  return { models: cleanModels(models), dropped: before.map((m) => m.id).filter((id) => !ids.includes(id)) }
}
