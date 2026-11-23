// A Git project's GitHub link (HI-3550, from HI-2843's design): which repository on its GitHub host (HI-2779's setting)
// it is, read from its remotes. Pure: main reads the remotes and asks gh (ghCli.ts); the window shows the link in
// Version Control → Workflow → GitHub.

import type { GithubHostOrigin } from './githubHost'

/** A repository on a GitHub host, as every gh call names it (`-R host/owner/repo`). */
export interface GithubRepoRef {
  host: string
  owner: string
  repo: string
}

/** A remote of the project whose URL is a repository on the GitHub host. */
export interface GithubRemoteCandidate {
  remote: string
  owner: string
  repo: string
}

/**
 * A remote's URL as a repository, or null: `https://host/owner/repo(.git)`, `ssh://git@host[:port]/owner/repo(.git)`
 * and scp-like `git@host:owner/repo(.git)`. The host is lower-cased and loses any port and user; nothing else is
 * accepted (a path deeper than owner/repo, a local folder, another scheme).
 */
export function parseGithubRemote(url: string): GithubRepoRef | null {
  const u = url.trim()
  let host: string | undefined
  let path: string | undefined
  const scheme = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u)
  if (scheme) {
    host = scheme[2]
    path = scheme[3]
  } else {
    // scp-like: [user@]host:owner/repo, never a Windows drive (C:\…) or a path with no host.
    const scp = /^(?:[^@/\\\s]+@)?([^:/\\\s]+):(?!\/\/)([^\\]+)$/.exec(u)
    if (!scp || scp[1].length === 1) return null
    host = scp[1]
    path = scp[2]
  }
  const parts = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2 || parts.some((p) => !p || !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..')) return null
  return { host: host.toLowerCase(), owner: parts[0], repo: parts[1] }
}

/** A remote as `git remote -v` gives it (gitRepo.ts' GitRemote). */
export interface RemoteUrls {
  name: string
  fetchUrl: string
  pushUrl: string
}

/**
 * The remotes on `host`, origin first then by name, and the one linked: the user's choice while it still matches,
 * else origin, else the only one. Several and none chosen (no origin among them): `linked` is null, for the user to
 * choose. None on the host: the project has no GitHub link.
 */
export function githubRepoOf(remotes: readonly RemoteUrls[], host: string, chosen?: string | null): { candidates: GithubRemoteCandidate[]; linked: GithubRemoteCandidate | null } {
  const h = host.toLowerCase()
  const candidates = remotes
    .map((r) => ({ name: r.name, ref: parseGithubRemote(r.fetchUrl || r.pushUrl) }))
    .filter((r): r is { name: string; ref: GithubRepoRef } => !!r.ref && r.ref.host === h)
    .map((r) => ({ remote: r.name, owner: r.ref.owner, repo: r.ref.repo }))
    .sort((a, b) => (a.remote === 'origin' ? -1 : b.remote === 'origin' ? 1 : a.remote.localeCompare(b.remote)))
  const pick = (name: string | null | undefined): GithubRemoteCandidate | null => (name ? (candidates.find((c) => c.remote === name) ?? null) : null)
  const linked = pick(chosen) ?? pick('origin') ?? (candidates.length === 1 ? candidates[0] : null)
  return { candidates, linked }
}

/** The repository's page on its host. */
export const githubRepoUrl = (r: GithubRepoRef): string => `https://${r.host}/${r.owner}/${r.repo}`

/** What gh says about its sign-in on a host: signed in (as `login`), signed out, not installed, no answer, or an error. */
export type GhState = 'signedIn' | 'signedOut' | 'missing' | 'timeout' | 'failed'

export interface GhStatus {
  host: string
  state: GhState
  login: string | null
  /** gh's version, when it answered (`gh --version`'s first line's number). */
  version: string | null
  /** gh's own words for a failure, at most 300 characters (the user's own text: never logged unwrapped). */
  error: string | null
}

/** A Git project's GitHub link and gh's status on its host, as Version Control → Workflow → GitHub shows them. */
export interface GithubLink {
  host: string
  hostOrigin: GithubHostOrigin
  /** The project's remotes on the host (origin first) and the one linked; null: none, or several to choose from. */
  candidates: GithubRemoteCandidate[]
  linked: (GithubRemoteCandidate & { url: string }) | null
  /** The remote the user chose (project.json `githubRemote`), kept even while it no longer matches. */
  chosen: string | null
  gh: GhStatus
}
