// Copilot's GitHub hosts (HI-2779, from HI-1201's design): the hosts the open workspaces and their projects resolve to
// (shared/githubHost.ts), each one route that its sign-in check, model listing, Sign in and launches all use, with the
// same environment. Each route's sign-in is told from its own evidence (hostEvidence), never from a remembered entry nor
// from another host: a GitHub CLI login on github.com never counts for yourcompany.ghe.com.
//
// Results are bound to the check run that asked (its generation): a host or switch change, a workspace closing or a newer
// check starts a new one, and an older run's late answers are dropped. Model listings are cached by the full context,
// with no secret in it: the route, the sign-in's source by name (a variable's name, a login's account), the token and
// update switches, and the executable and its version. A token's value is never read, so a new token behind the same
// variable is found by Check again.

import { basename, join } from 'path'
import { readFile } from 'original-fs/promises'
import type { HostCheck, HostCheckState, LaunchedSignInHost } from '../../../shared/types'
import { cleanGithubSettings, envValue, githubHostEnv, resolveGithubHosts, type ResolvedGithubHosts } from '../../../shared/githubHost'
import type { WorkspaceService } from '../../workspace'
import { createLogger, userText } from '../../logger'
import { copilotHome, noAutoUpdate, stripsTokens } from './home'
import type { CopilotModelsOutcome } from './models'

const log = createLogger('copilot')

/** One route: what a project (or a workspace's own default) resolves to, and the environment its Copilot children get. */
export interface CopilotRoute {
  key: string
  resolved: ResolvedGithubHosts
  env: Record<string, string>
  home: string
  usedBy: { workspace: string; projects: string[] }[]
}

/** A route's key: its hosts, whether settings chose them, and the CLI's home. No secret. */
export function routeKey(resolved: ResolvedGithubHosts, home: string): string {
  const cop = resolved.copilot.host ?? resolved.copilot.problem ?? '?'
  return `${cop}|${resolved.repo.host}|${resolved.levelsSet ? 'set' : 'env'}|${home.toLowerCase()}`
}

/** The route for a resolution: its environment (the hosts written, or the environment left as it is), home and key. */
export function routeOf(resolved: ResolvedGithubHosts, baseEnv: Record<string, string>): Omit<CopilotRoute, 'usedBy'> {
  const env = githubHostEnv(baseEnv, resolved)
  const home = copilotHome(env)
  return { key: routeKey(resolved, home), resolved, env, home }
}

/**
 * The routes in use: each open workspace's own default (its projects without settings of their own, and its Assistant),
 * and each project's that resolves elsewhere, merged by key. No workspace open: the environment's alone.
 */
export async function routesInUse(baseEnv: Record<string, string>, given?: readonly WorkspaceService[]): Promise<CopilotRoute[]> {
  // Loaded when asked, not with this module: the adapters load before the workspace service, which needs them.
  const workspaces = given ?? (await import('../../workspace')).openWorkspaces()
  const routes = new Map<string, CopilotRoute>()
  const add = (resolved: ResolvedGithubHosts, workspace: string | null, project: string | null): void => {
    const r = routeOf(resolved, baseEnv)
    const got = routes.get(r.key) ?? { ...r, usedBy: [] }
    routes.set(r.key, got)
    if (workspace === null) return
    let entry = got.usedBy.find((u) => u.workspace === workspace)
    if (!entry) got.usedBy.push((entry = { workspace, projects: [] }))
    if (project && !entry.projects.includes(project)) entry.projects.push(project)
  }
  for (const ws of workspaces) {
    // A workspace closing is gone from the routes already (its close starts a new generation: githubHostChanges.ts).
    if (!ws.path || ws.closing) continue
    const name = basename(ws.path)
    const wsOwn = cleanGithubSettings(ws.config.github)
    add(resolveGithubHosts(null, wsOwn, baseEnv), name, null)
    for (const p of ws.lastInfo?.projects ?? []) {
      const own = cleanGithubSettings(p.config.github)
      if (own) add(resolveGithubHosts(own, wsOwn, baseEnv), name, p.name)
    }
  }
  if (!routes.size) add(resolveGithubHosts(null, null, baseEnv), null, null)
  return [...routes.values()]
}

// -----------------------------------------------------------------------------
// Evidence
// -----------------------------------------------------------------------------

/** What `gh auth status --active --hostname <host> --json hosts` said of that host (never a token). */
export interface GhHostStatus {
  /** success: gh checked its login there; error: it couldn't (why: `error`); timeout; none: no login there. */
  state: 'success' | 'error' | 'timeout' | 'none' | 'other'
  login: string | null
  /** gh's own words for an error, at most 300 characters. */
  error: string | null
}

/** gh's reply for exactly `host` (null: unreadable). Another host's entry never stands in. */
export function parseGhStatus(stdout: string, host: string): GhHostStatus | null {
  try {
    const hosts = (JSON.parse(stdout) as { hosts?: Record<string, unknown> }).hosts
    if (!hosts || typeof hosts !== 'object') return null
    const key = Object.keys(hosts).find((k) => k.toLowerCase() === host.toLowerCase())
    const list = key ? hosts[key] : undefined
    const a = (Array.isArray(list) ? list : []).find((x) => x && typeof x === 'object' && (x as { active?: unknown }).active !== false) as Record<string, unknown> | undefined
    if (!a) return { state: 'none', login: null, error: null }
    const state = a.state === 'success' || a.state === 'error' || a.state === 'timeout' ? a.state : 'other'
    const error = typeof a.error === 'string' && a.error.trim() ? a.error.replace(/\s+/g, ' ').trim().slice(0, 300) : null
    return { state, login: typeof a.login === 'string' ? a.login : null, error }
  } catch {
    return null
  }
}

/** The stored Copilot login for `host` (config.json's loggedInUsers; an entry without a host is github.com's), else null. */
export function storedLoginFor(cliConfig: unknown, host: string): string | null {
  const c = cliConfig && typeof cliConfig === 'object' ? (cliConfig as Record<string, unknown>) : {}
  const norm = (h: unknown): string => (typeof h === 'string' && h.trim() ? h.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase() : 'github.com')
  const users = (Array.isArray(c.loggedInUsers) ? c.loggedInUsers : []).filter((u): u is Record<string, unknown> => !!u && typeof u === 'object' && norm(u.host) === host.toLowerCase())
  if (!users.length) return null
  const last = c.lastLoggedInUser && typeof c.lastLoggedInUser === 'object' ? (c.lastLoggedInUser as Record<string, unknown>) : null
  const user = users.find((u) => last && u.login === last.login && norm(u.host) === norm(last.host)) ?? users[0]
  return typeof user.login === 'string' ? user.login : ''
}

/**
 * The stored login Copilot uses when nothing chooses a host (no setting, no GH_HOST or COPILOT_GH_HOST): its last, else
 * its first, whatever host it is on, with that host. Null when none is stored.
 */
export function storedLoginAny(cliConfig: unknown): { login: string; host: string } | null {
  const c = cliConfig && typeof cliConfig === 'object' ? (cliConfig as Record<string, unknown>) : {}
  const users = (Array.isArray(c.loggedInUsers) ? c.loggedInUsers : []).filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
  if (!users.length) return null
  const norm = (h: unknown): string => (typeof h === 'string' && h.trim() ? h.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase() : 'github.com')
  const last = c.lastLoggedInUser && typeof c.lastLoggedInUser === 'object' ? (c.lastLoggedInUser as Record<string, unknown>) : null
  const user = users.find((u) => last && u.login === last.login && norm(u.host) === norm(last.host)) ?? users[0]
  return { login: typeof user.login === 'string' ? user.login : '', host: norm(user.host) }
}

/** The token variables Copilot reads, in its order (`copilot login --help`): set ones count, never read. */
export const COPILOT_TOKEN_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']

/** A host's sign-in evidence, before its model listing (hostEvidence). */
export interface HostEvidence {
  state: HostCheckState
  source: 'token' | 'stored' | 'gh' | 'local' | null
  variable: string | null
  account: string | null
  diagnostic?: string
  /** The host of the stored login taken (anyHost: the one Copilot uses when nothing chooses a host). */
  storedHost?: string
}

/** Whether the environment runs Copilot on a model of its own, with no GitHub sign-in (BYOK, offline). */
export function localModel(env: Record<string, string | undefined>): boolean {
  const offline = envValue(env, 'COPILOT_OFFLINE')
  return !!envValue(env, 'COPILOT_PROVIDER_BASE_URL') || (!!offline && /^(1|true|yes)$/i.test(offline))
}

/**
 * Which sign-in Copilot gets on `host`, in its own order: a model of its own (no sign-in), a token variable (named), a
 * stored login for this host, else the GitHub CLI's login for this host. `env` is the route's (stripped tokens already
 * out); `gh` null when gh isn't there or said nothing. Only gh checks a login: `verified` is its success there, and
 * names gh's identity, not a Copilot seat.
 */
export function hostEvidence(env: Record<string, string | undefined>, cliConfig: unknown, gh: GhHostStatus | null, host: string, anyHost = false): HostEvidence {
  if (localModel(env)) return { state: 'noSignIn', source: 'local', variable: null, account: null }
  const variable = COPILOT_TOKEN_VARS.find((k) => !!envValue(env, k))
  if (variable) return { state: 'configured', source: 'token', variable, account: null }
  // Nothing chooses a host (anyHost): Copilot takes its last stored login, on whichever host, as before HI-2779.
  const any = anyHost ? storedLoginAny(cliConfig) : null
  if (any) return { state: 'configured', source: 'stored', variable: null, account: any.login || null, storedHost: any.host }
  const stored = anyHost ? null : storedLoginFor(cliConfig, host)
  if (stored !== null) return { state: 'configured', source: 'stored', variable: null, account: stored || null }
  if (!gh || gh.state === 'none') return { state: 'installed', source: null, variable: null, account: null }
  if (gh.state === 'success') return { state: 'verified', source: 'gh', variable: null, account: gh.login }
  if (gh.state === 'error') return { state: 'unverified', source: 'gh', variable: null, account: gh.login, ...(gh.error ? { diagnostic: gh.error } : {}) }
  return { state: 'unknown', source: 'gh', variable: null, account: gh.login }
}

/** The evidence with its model listing (asked only once there is a sign-in to ask with). */
export function withModels(e: HostEvidence, o: CopilotModelsOutcome | null): HostEvidence & { models?: HostCheck['models'] } {
  if (!o) return e
  if (o.kind === 'ok') {
    const available = o.read.models.filter((m) => !m.unavailable).length
    const models = { available, unavailable: o.read.models.length - available, metadata: o.enablement }
    // A policy's refusal only when every model listed says so; some or none marked: entitlement unknown.
    return { ...e, models, ...(o.allDisabled && e.state !== 'noSignIn' ? { state: 'denied' as const } : {}) }
  }
  if (o.kind === 'error') return { ...e, ...(e.state === 'configured' ? { state: 'unverified' as const } : {}), diagnostic: o.message }
  return { ...e, ...(e.state === 'configured' ? { state: 'unknown' as const } : {}) }
}

/** Whether the listing is worth asking: there is a sign-in (or none needed) to ask with. */
export const asksModels = (s: HostCheckState): boolean => s === 'configured' || s === 'verified' || s === 'noSignIn'

/** The top-level signed in for existing callers (diagnostics, Automatic): yes, no, or unknown. */
export function loggedInOf(s: HostCheckState): boolean | null {
  if (s === 'verified' || s === 'configured' || s === 'noSignIn') return true
  if (s === 'installed') return false
  return null
}

/** The full context a listing is cached by: the route, the sign-in by name, the switches, the executable. No secret. */
export function contextKey(route: string, e: Pick<HostEvidence, 'source' | 'variable' | 'account'>, executable: string, version: string | null, strip = stripsTokens(), noUpdate = noAutoUpdate()): string {
  return [route, `${e.source ?? 'none'}:${e.variable ?? e.account ?? ''}`, `strip:${strip ? 1 : 0}`, `update:${noUpdate ? 0 : 1}`, `${executable.toLowerCase()}@${version ?? '?'}`].join('|')
}

// -----------------------------------------------------------------------------
// Checks, bound to their generation
// -----------------------------------------------------------------------------

let generation = 0
/** A new generation: a host or switch changed, a workspace closed, or a newer check started. Older answers are dropped. */
export function newGeneration(): number {
  return ++generation
}
export const currentGeneration = (): number => generation

/** Model listings by full context, from the generation that asked. */
const listings = new Map<string, { gen: number; outcome: CopilotModelsOutcome }>()

/** Keeps a listing only while its generation is current: a late answer after a change is dropped. */
export function keepListing(key: string, gen: number, outcome: CopilotModelsOutcome): boolean {
  if (gen !== generation) return false
  listings.set(key, { gen, outcome })
  return true
}

/** Each route's listing from its latest check (the catalogue Provider Setup keeps takes the first route's from here). */
const routeListings = new Map<string, { gen: number; outcome: CopilotModelsOutcome }>()

/** A route's listing from this generation's check, if it got one. */
export function routeListing(key: string): CopilotModelsOutcome | null {
  const l = routeListings.get(key)
  return l && l.gen === generation ? l.outcome : null
}

/** The listing this generation got for a context, if any. */
export function listingOf(key: string): CopilotModelsOutcome | null {
  const l = listings.get(key)
  return l && l.gen === generation ? l.outcome : null
}

/** What a check needs from outside (tests give fakes). */
export interface HostCheckDeps {
  executable: string
  version: string | null
  /** gh's reply for a host, in the route's environment (null: no gh, or nothing said). */
  ghStatus(host: string, env: Record<string, string>): Promise<GhHostStatus | null>
  /** The route's Copilot config.json, parsed (null: none). */
  cliConfig(home: string): Promise<unknown>
  /** Its model listing in the route's environment; null: not asked (Copilot turned off). */
  models(env: Record<string, string>): Promise<CopilotModelsOutcome | null>
}

/** The CLI's config.json in a home: JSON after a `//` comment line. */
export async function readCliConfig(home: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(join(home, 'config.json'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''))
  } catch {
    return null
  }
}

/**
 * One route's check: its evidence, then its listing when there is a sign-in to ask with. Null when a newer generation
 * started meanwhile: the caller drops it.
 */
export async function checkRoute(route: CopilotRoute, deps: HostCheckDeps, gen: number): Promise<HostCheck | null> {
  const r = route.resolved
  const base = { key: route.key, host: r.copilot.host, repoHost: r.repo.host, origin: r.copilot.origin, usedBy: route.usedBy }
  if (!r.copilot.host) return { ...base, state: r.copilot.problem === 'ghesProxyUnsupported' ? 'proxyUnsupported' : 'chooseHost', source: null, account: null }
  const host = r.copilot.host
  // No setting and no host variable: Copilot uses its last stored login on whichever host (legacy, as before HI-2779).
  const anyHost = !r.levelsSet && r.copilot.origin === 'default'
  // Copilot's own order: no gh call when a token or a stored login comes first (it would never use gh's).
  let evidence = hostEvidence(route.env, null, null, host, anyHost)
  if (evidence.state === 'installed') {
    const cliConfig = await deps.cliConfig(route.home)
    evidence = hostEvidence(route.env, cliConfig, null, host, anyHost)
    if (evidence.state === 'installed') evidence = hostEvidence(route.env, cliConfig, await deps.ghStatus(host, route.env), host, anyHost)
  }
  if (evidence.storedHost) base.host = evidence.storedHost
  if (gen !== generation) return null
  let checked: ReturnType<typeof withModels> = evidence
  if (asksModels(evidence.state)) {
    const key = contextKey(route.key, evidence, deps.executable, deps.version)
    const outcome = listingOf(key) ?? (await deps.models(route.env))
    if (gen !== generation) return null
    if (outcome && keepListing(key, gen, outcome)) routeListings.set(route.key, { gen, outcome })
    checked = withModels(evidence, outcome)
  }
  const source = checked.source === 'token' ? checked.variable : checked.source === 'stored' ? 'Copilot login' : checked.source === 'gh' ? 'GitHub CLI' : checked.source === 'local' ? 'local model' : null // i18n-ignore: sign-in sources as the CLIs name them, matched by tests (data-source)
  return { ...base, state: checked.state, source, account: checked.account, ...(checked.diagnostic ? { diagnostic: checked.diagnostic } : {}), ...(checked.models ? { models: checked.models } : {}) }
}

/** Every route's check, in order, for one generation; null when a newer one started meanwhile. */
export async function checkRoutes(routes: CopilotRoute[], deps: HostCheckDeps, gen = newGeneration()): Promise<HostCheck[] | null> {
  const out = await Promise.all(routes.map((r) => checkRoute(r, deps, gen)))
  if (gen !== generation || out.some((c) => !c)) return null
  for (const c of out) if (c?.diagnostic) log.info(`Copilot's check on a host answered: ${userText(c.diagnostic)}`)
  return out as HostCheck[]
}

/** What a launch on a resolution records (LaunchContext.signInHost), or why it can't sign in. */
export function launchedHostOf(resolved: ResolvedGithubHosts): LaunchedSignInHost | null {
  return resolved.copilot.host ? { host: resolved.copilot.host, repoHost: resolved.repo.host, origin: resolved.copilot.origin } : null
}
