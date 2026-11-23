// A card's GitHub source (HI-3551, from HI-2843's design): the pull request or issue it is about, on the project's GitHub
// link (HI-3550). A PR's card works on the PR's own branch (main's start); its finish is its pull request, never a merge
// here. Pure: main reads GitHub through ghCli.ts and keeps the PR's identity in the start's evidence (Started.pr).

import type { GithubRepoRef } from './githubRepo'

/** What gh's `pr view` said of a pull request when its card's source was set (evidence, never a permission). */
export interface GithubPrFacts {
  /** The PR's head branch, on its own repository (a fork's, or the base repository's). */
  headRef: string
  /** The branch it would merge into on the base repository. */
  baseRef: string
  /** Its head is on another repository (a fork). */
  crossRepository: boolean
  /** The fork's author lets maintainers push to its head branch. */
  maintainerCanModify: boolean
}

export interface GithubSource extends GithubRepoRef {
  kind: 'pr' | 'issue'
  number: number
  url: string
  /** Its title on GitHub when it was set: outside text, never read as an instruction. */
  title: string
  pr?: GithubPrFacts
}

/** A source as typed: a URL of a pull request or issue, or `#n` (`n`) on the project's linked repository. */
export type SourceRef = { ref: GithubRepoRef; number: number; kind: 'pr' | 'issue' | null } | { error: 'notGithub' | 'otherRepo' | 'noLink' }

const NAME = /^[A-Za-z0-9_.-]+$/

/** Reads what the user typed against the project's linked repository (null: none). Another host or repository is refused. */
export function parseSourceRef(input: string, link: GithubRepoRef | null): SourceRef {
  const s = input.trim()
  const num = /^#?(\d{1,9})$/.exec(s)
  if (num) return link ? { ref: link, number: Number(num[1]), kind: null } : { error: 'noLink' }
  const m = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d{1,9})(?:[/?#].*)?$/i.exec(s)
  if (!m || !NAME.test(m[2]) || !NAME.test(m[3])) return { error: 'notGithub' }
  if (!link) return { error: 'noLink' }
  const ref = { host: m[1].toLowerCase(), owner: m[2], repo: m[3].replace(/\.git$/i, '') }
  if (ref.host !== link.host.toLowerCase() || ref.owner.toLowerCase() !== link.owner.toLowerCase() || ref.repo.toLowerCase() !== link.repo.toLowerCase()) return { error: 'otherRepo' }
  return { ref: link, number: Number(m[5]), kind: m[4].toLowerCase() === 'pull' ? 'pr' : 'issue' }
}

/** A saved source as it is read back (a damaged one dropped): never trusted beyond its shape. */
export function cleanSource(raw: unknown): GithubSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const str = (k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string) : null)
  const kind = r.kind === 'pr' || r.kind === 'issue' ? r.kind : null
  const host = str('host')
  const owner = str('owner')
  const repo = str('repo')
  const url = str('url')
  if (!kind || !host || !owner || !repo || !url || !Number.isInteger(r.number) || (r.number as number) <= 0) return undefined
  const p = r.pr as Record<string, unknown> | undefined
  const pr = kind === 'pr' && p && typeof p.headRef === 'string' && typeof p.baseRef === 'string' ? { headRef: p.headRef, baseRef: p.baseRef, crossRepository: p.crossRepository === true, maintainerCanModify: p.maintainerCanModify === true } : undefined
  if (kind === 'pr' && !pr) return undefined
  return { kind, host, owner, repo, number: r.number as number, url, title: str('title') ?? '', ...(pr ? { pr } : {}) }
}

/** The label a card made from GitHub carries, so a lane is given such cards like any others. */
export const sourceLabel = (kind: GithubSource['kind']): string => (kind === 'pr' ? 'github-pr' : 'github-issue')

/** Whether two sources name the same pull request or issue (the start's check that the card is still about it). */
export const sameSource = (a: Pick<GithubSource, 'kind' | 'host' | 'owner' | 'repo' | 'number'> | null | undefined, b: Pick<GithubSource, 'kind' | 'host' | 'owner' | 'repo' | 'number'> | null | undefined): boolean =>
  !!a && !!b && a.kind === b.kind && a.number === b.number && a.host.toLowerCase() === b.host.toLowerCase() && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()

/** A PR card's line (HI-3551): its own `cw/<project>/<key>…` line, so a fix round finds it again, named for the PR. */
export const prLineName = (projectKey: string, key: string, number: number): string => `cw/${projectKey}/${key}-pr-${number}`

/** Where a PR's head and base are fetched to (never a branch of the user's): pinned in the start's evidence. */
export const prRefs = (number: number): { head: string; base: string } => ({ head: `refs/cw/pr/${number}/head`, base: `refs/cw/pr/${number}/base` })

/**
 * Whether Combwork could push fixes to a PR's head, by what gh said when its source was set: a fork whose author didn't
 * allow maintainer edits can't take a push. Evidence shown on the card; the push itself (HI-3552) reads GitHub again.
 */
export function prPushable(s: Pick<GithubSource, 'kind' | 'pr'>): { ok: true } | { ok: false; why: 'fork' } {
  return s.kind === 'pr' && s.pr?.crossRepository && !s.pr.maintainerCanModify ? { ok: false, why: 'fork' } : { ok: true }
}

/** The PR identity a start records (Started.pr): what it was started on, read again by everything after it. */
export interface StartedPr {
  host: string
  owner: string
  repo: string
  number: number
  headRef: string
  baseRef: string
  /** The PR's head and base as fetched for this start. */
  headOid: string
  baseOid: string
  crossRepository: boolean
  maintainerCanModify: boolean
  /** A fix round's start found GitHub's head with commits the card's line lacks (pushed from outside): kept, never taken in. */
  headOutside?: true
}
