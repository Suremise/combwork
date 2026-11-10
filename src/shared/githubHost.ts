// The GitHub host a workspace's projects use (HI-2779, from HI-1201's design): a workspace default (workspace.json
// `github`) and a project override (project.json `github`), and the separate host Copilot signs in on. One resolver for
// Copilot's sign-in check, model catalogue, Sign in and launches, and for the window's "where it comes from".
//
// Hosts are hostnames only: no scheme but https, no credentials, path, query, fragment or port, never a token. The repo
// host and the Copilot host resolve independently:
//
// | Case                       | Condition                                  | Copilot host                                  | Env written                  |
// |----------------------------|--------------------------------------------|-----------------------------------------------|------------------------------|
// | legacy                     | neither level sets anything                | COPILOT_GH_HOST, else GH_HOST, else github.com | none: the environment's own  |
// | explicit host              | the nearest Copilot choice is a host        | that host                                     | GH_HOST=repo, COPILOT_GH_HOST |
// | explicit 'repo'            | the nearest Copilot choice is 'repo'        | the repo host if cloud; else choose            | both, if cloud               |
// | inherit, cloud repo host   | a level sets something, no Copilot choice   | the repo host (inherited host variables aside) | both = the repo host         |
// | inherit, GHES repo host    | a level sets something, no Copilot choice   | choose (never a cloud host from the env)       | none: no launch              |
// | proxy                      | the nearest Copilot choice is 'ghes-proxy'  | not supported yet                              | none: no launch              |

/** github.com; Enterprise Cloud with data residency (`*.ghe.com`); GitHub Enterprise Server (any other host). */
export type GithubHostKind = 'github' | 'ghe-cloud' | 'ghes'

/** A level's GitHub settings, as stored. Each field left out inherits. */
export interface GithubHostSettings {
  /** The repositories' host, normalised (lower case, no scheme). */
  host?: string
  kind?: GithubHostKind
  /** Where Copilot signs in: a cloud host, 'repo' (the same as the GitHub host), or 'ghes-proxy' (not supported yet). */
  copilotHost?: string
  copilotKind?: GithubHostKind
}

export const GITHUB_COM = 'github.com'
/** The Copilot choice "the same as the GitHub host". */
export const COPILOT_SAME_AS_REPO = 'repo'
/** The Copilot choice "GitHub Enterprise Server's Copilot proxy": a preview Combwork doesn't support yet (HI-1201's card 5). */
export const COPILOT_GHES_PROXY = 'ghes-proxy'

/** Why a host was refused. */
export type GithubHostRejection = 'empty' | 'scheme' | 'credentials' | 'path' | 'query' | 'port' | 'invalid' | 'notCloud'

export type ParsedHost = { ok: true; host: string; kind: GithubHostKind } | { ok: false; reason: GithubHostRejection }

/** The kind of a normalised host. */
export function githubHostKind(host: string): GithubHostKind {
  if (host === GITHUB_COM) return 'github'
  if (host.endsWith('.ghe.com')) return 'ghe-cloud'
  return 'ghes'
}

/** Whether Copilot can sign in there itself (github.com, `*.ghe.com`): a GHES host has no cloud Copilot of its own. */
export const isCloudHost = (kind: GithubHostKind): boolean => kind !== 'ghes'

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * A host as typed: a bare hostname or `https://host` (one trailing slash allowed), normalised to lower case. Refused:
 * another scheme, credentials, a path, a query or fragment, a port, an IP address or a malformed name.
 */
export function parseGithubHost(input: unknown): ParsedHost {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  let s = input.trim()
  if (!s) return { ok: false, reason: 'empty' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  if (s.length > 253 + 9) return { ok: false, reason: 'invalid' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  // A scheme, not a host and its port (github.com:8443).
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(s)
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'https' || !s.slice(scheme[0].length).startsWith('//')) return { ok: false, reason: 'scheme' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
    s = s.slice(scheme[0].length + 2)
  } else if (s.startsWith('//')) return { ok: false, reason: 'scheme' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  if (s.includes('@')) return { ok: false, reason: 'credentials' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  if (/[?#]/.test(s)) return { ok: false, reason: 'query' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  if (s.endsWith('/')) s = s.slice(0, -1)
  if (/[/\\]/.test(s)) return { ok: false, reason: 'path' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  if (s.includes(':')) return { ok: false, reason: 'port' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  const host = s.toLowerCase().replace(/\.$/, '')
  const labels = host.split('.')
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) return { ok: false, reason: 'invalid' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  return { ok: true, host, kind: githubHostKind(host) }
}

export type ParsedCopilotChoice = { ok: true; value: string; kind?: GithubHostKind } | { ok: false; reason: GithubHostRejection }

/** A Copilot sign-in choice: 'repo', 'ghes-proxy', or a cloud host (github.com, `*.ghe.com`). */
export function parseCopilotChoice(input: unknown): ParsedCopilotChoice {
  if (input === COPILOT_SAME_AS_REPO || input === COPILOT_GHES_PROXY) return { ok: true, value: input }
  const p = parseGithubHost(input)
  if (!p.ok) return p
  if (!isCloudHost(p.kind)) return { ok: false, reason: 'notCloud' } // i18n-ignore: a rejection's code; the window shows its message (main/githubHosts.ts)
  return { ok: true, value: p.host, kind: p.kind }
}

/** A change to a level's GitHub settings: a field given as null is removed (inherits); one left out stays. */
export interface GithubHostChange {
  host?: string | null
  copilotHost?: string | null
}

/**
 * A level's settings after a change, every value parsed again (main's mutation boundary, whoever asks): refused with the
 * field and its reason. Stored values are re-derived, so a kind is never taken from the caller.
 */
export function applyGithubHostChange(now: GithubHostSettings | undefined, change: GithubHostChange): { ok: true; value: GithubHostSettings } | { ok: false; field: 'host' | 'copilotHost'; reason: GithubHostRejection } {
  const next: GithubHostSettings = { ...now }
  if (change.host !== undefined) {
    if (change.host === null) {
      delete next.host
      delete next.kind
    } else {
      const p = parseGithubHost(change.host)
      if (!p.ok) return { ok: false, field: 'host', reason: p.reason }
      next.host = p.host
      next.kind = p.kind
    }
  }
  if (change.copilotHost !== undefined) {
    if (change.copilotHost === null) {
      delete next.copilotHost
      delete next.copilotKind
    } else {
      const p = parseCopilotChoice(change.copilotHost)
      if (!p.ok) return { ok: false, field: 'copilotHost', reason: p.reason }
      next.copilotHost = p.value
      if (p.kind) next.copilotKind = p.kind
      else delete next.copilotKind
    }
  }
  return { ok: true, value: next }
}

/** Stored settings read defensively (a hand-edited file): only values that parse count, the rest are ignored. */
export function cleanGithubSettings(raw: unknown): GithubHostSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: GithubHostSettings = {}
  const host = r.host === undefined ? null : parseGithubHost(r.host)
  if (host?.ok) {
    out.host = host.host
    out.kind = host.kind
  }
  const cop = r.copilotHost === undefined ? null : parseCopilotChoice(r.copilotHost)
  if (cop?.ok) {
    out.copilotHost = cop.value
    if (cop.kind) out.copilotKind = cop.kind
  }
  return out.host || out.copilotHost ? out : undefined
}

/** Where a resolved value comes from. */
export type GithubHostOrigin = 'project' | 'workspace' | 'environment' | 'default'

/** Why Copilot has no host to sign in on. */
export type CopilotHostProblem = 'chooseCopilotHost' | 'ghesProxyUnsupported'

export interface ResolvedGithubHosts {
  /** Whether the project or its workspace sets anything (else the environment decides, as before HI-2779). */
  levelsSet: boolean
  repo: { host: string; kind: GithubHostKind; origin: GithubHostOrigin }
  copilot: { host: string | null; kind: GithubHostKind | null; origin: GithubHostOrigin; choice: 'host' | 'repo' | 'inherit' | 'proxy' | 'environment'; problem?: CopilotHostProblem }
}

/** An environment variable's value, by its name in any case (Windows' environment is case-insensitive). */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const up = name.toUpperCase()
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === up && v?.trim()) return v.trim()
  return undefined
}

/** A host from an environment variable, when it parses (anything else is ignored, as an unusable value). */
function envHost(env: Record<string, string | undefined>, name: string): { host: string; kind: GithubHostKind } | null {
  const v = envValue(env, name)
  if (!v) return null
  const p = parseGithubHost(v)
  return p.ok ? { host: p.host, kind: p.kind } : null
}

/**
 * The project's GitHub host and Copilot's sign-in host (the table above), from the project's settings, its workspace's
 * and the environment Copilot gets. `project` null: the workspace's own (the Assistant's home, a workspace-wide check).
 */
export function resolveGithubHosts(project: GithubHostSettings | null | undefined, workspace: GithubHostSettings | null | undefined, env: Record<string, string | undefined>): ResolvedGithubHosts {
  const p = cleanGithubSettings(project)
  const w = cleanGithubSettings(workspace)
  const levelsSet = !!(p || w)
  const envRepo = envHost(env, 'GH_HOST')
  const repo: ResolvedGithubHosts['repo'] = p?.host
    ? { host: p.host, kind: githubHostKind(p.host), origin: 'project' }
    : w?.host
      ? { host: w.host, kind: githubHostKind(w.host), origin: 'workspace' }
      : envRepo
        ? { ...envRepo, origin: 'environment' }
        : { host: GITHUB_COM, kind: 'github', origin: 'default' }
  if (!levelsSet) {
    const envCop = envHost(env, 'COPILOT_GH_HOST') ?? envRepo
    return { levelsSet, repo, copilot: envCop ? { ...envCop, origin: 'environment', choice: 'environment' } : { host: GITHUB_COM, kind: 'github', origin: 'default', choice: 'environment' } }
  }
  const choice = p?.copilotHost !== undefined ? { value: p.copilotHost, origin: 'project' as const } : w?.copilotHost !== undefined ? { value: w.copilotHost, origin: 'workspace' as const } : null
  if (choice?.value === COPILOT_GHES_PROXY) return { levelsSet, repo, copilot: { host: null, kind: null, origin: choice.origin, choice: 'proxy', problem: 'ghesProxyUnsupported' } }
  if (choice && choice.value !== COPILOT_SAME_AS_REPO) return { levelsSet, repo, copilot: { host: choice.value, kind: githubHostKind(choice.value), origin: choice.origin, choice: 'host' } }
  // 'repo', or no choice at either level: the repo host when Copilot can sign in there; a GHES host needs a choice.
  const how = choice ? 'repo' : 'inherit'
  const origin = choice?.origin ?? repo.origin
  if (!isCloudHost(repo.kind)) return { levelsSet, repo, copilot: { host: null, kind: null, origin, choice: how, problem: 'chooseCopilotHost' } }
  return { levelsSet, repo, copilot: { host: repo.host, kind: repo.kind, origin, choice: how } }
}

/** A level's form (HI-2779): its own settings, what it resolves to, and what it would resolve to without its own. */
export interface GithubHostsForm {
  own: GithubHostSettings
  resolved: ResolvedGithubHosts
  inherited: ResolvedGithubHosts
}

/** The host variables Combwork writes for Copilot, removed in every spelling before they are. */
const HOST_VARS = ['GH_HOST', 'COPILOT_GH_HOST']

/**
 * A Copilot child's environment with the resolved hosts: untouched when neither level sets anything (the legacy case);
 * otherwise GH_HOST is the repo host and COPILOT_GH_HOST Copilot's, whatever the inherited environment had, in any
 * spelling. No Copilot host (a choice to make, the proxy): none written, and the inherited ones removed, so nothing signs
 * Copilot in on a host the settings didn't choose.
 */
export function githubHostEnv(env: Record<string, string>, resolved: ResolvedGithubHosts): Record<string, string> {
  if (!resolved.levelsSet) return { ...env }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!HOST_VARS.includes(k.toUpperCase())) out[k] = v
  if (resolved.copilot.host) {
    out.GH_HOST = resolved.repo.host
    out.COPILOT_GH_HOST = resolved.copilot.host
  }
  return out
}
