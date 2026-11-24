// An issue source (HI-3555, HI-2844's design): where a project's issues come from, behind one small seam (list, read,
// close), so GitLab, Linear or Jira can plug in later. Only GitHub is built (main's issueSources.ts, through gh). Our own
// board stays the source of truth: nothing is written to the issue source when an issue is pulled in or its card moves;
// the one write is closing shipped issues once their release is published, by the user's click. Pure.

import type { GhState, GithubRepoRef } from './githubRepo'
import type { GithubSource } from './githubSource'

/** What an issue list is narrowed to: words to search for, one label, one assignee (each the source's own filter). */
export interface IssueQuery {
  search?: string
  label?: string
  assignee?: string
}

/** The longest a query's search, label or assignee may be (characters): longer is cut. */
export const ISSUE_QUERY_MAX = 200

/** A query as the window sent it: trimmed strings, at most ISSUE_QUERY_MAX each, empty ones dropped. */
export function cleanIssueQuery(raw: unknown): IssueQuery {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: IssueQuery = {}
  for (const k of ['search', 'label', 'assignee'] as const) {
    const v = typeof r[k] === 'string' ? (r[k] as string).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, ISSUE_QUERY_MAX) : ''
    if (v) out[k] = v
  }
  return out
}

/** An open issue as the board's From GitHub… lists it, and the card (not archived) already about it, if any. */
export interface OpenIssue {
  number: number
  /** GitHub's title: someone else's words, the window's to show. */
  title: string
  url: string
  author: string | null
  labels: string[]
  assignees: string[]
  card: number | null
}

/** Why an issue source couldn't be asked: gh's state, or the project has no link to ask on. */
export type IssueProblem = Exclude<GhState, 'signedIn'> | 'noLink'

/** HR1's round 1: the release's tag on GitHub names another commit than the repository's own tag of that name. */
export type ReleaseProblem = IssueProblem | 'notReleased' | 'tagMismatch'

/** What the Issues tab shows: the repository and its open issues, or why they couldn't be listed (gh's own words). */
export type OpenIssuesRead = { repo: GithubRepoRef; issues: OpenIssue[] } | { repo: GithubRepoRef | null; problem: IssueProblem; detail: string | null }

/** An issue read in full: the card's source (with its author and standing) and its body (clipped), and its labels. */
export interface IssueRead {
  source: GithubSource
  body: string
  labels: string[]
}

/** What closing one issue came to. */
export type IssueCloseResult = { ok: true } | { ok: false; problem: Exclude<GhState, 'signedIn'>; detail: string | null }

/**
 * The seam: what Combwork asks of an issue source. Each call names its repository itself; a failure is a kind and the
 * source's own words. `close` is the only write, used only by the close at publish (closeShippedIssues).
 */
export interface IssueSource {
  readonly repo: GithubRepoRef
  list(q: IssueQuery): Promise<{ ok: true; issues: Omit<OpenIssue, 'card'>[] } | { ok: false; problem: Exclude<GhState, 'signedIn'>; detail: string | null }>
  /** The issue, its state, and its comments' bodies (the close's read-back: a comment an earlier attempt posted). */
  read(number: number): Promise<{ ok: true; issue: IssueRead; state: 'open' | 'closed'; comments: string[] } | { ok: false; problem: Exclude<GhState, 'signedIn'>; detail: string | null }>
  /**
   * Whether `tag`'s release is published (not a draft; none: not published), and (HR1's round 1) the commit the tag names
   * on the source itself, peeled (lightweight or annotated), null when it has no such tag. Unreadable: not ok.
   */
  published(tag: string): Promise<{ ok: true; published: boolean; url: string | null; commit: string | null } | { ok: false; problem: Exclude<GhState, 'signedIn'>; detail: string | null }>
  /** Closes it as completed, with `comment` first when given (null: closed without one). */
  close(number: number, comment: string | null): Promise<IssueCloseResult>
}

/** The most open issues the Issues tab lists (newest first). */
export const OPEN_ISSUES_LIMIT = 100

/** The most labels a card takes from an issue (beside github-issue), each at most ISSUE_LABEL_MAX characters. */
export const ISSUE_LABELS_MAX = 20
export const ISSUE_LABEL_MAX = 50

/** An issue's labels as a card takes them: trimmed, commas (the label field's separator) made spaces, no repeats. */
export function issueCardLabels(labels: readonly string[]): string[] {
  const out: string[] = []
  for (const l of labels) {
    const s = String(l).replace(/[,\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ISSUE_LABEL_MAX)
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s)
    if (out.length >= ISSUE_LABELS_MAX) break
  }
  return out
}

/**
 * The comment a shipped issue is closed with (HI-2844: "Fixed in <version>"). English: posted to GitHub as written, for
 * whoever reads the issue, like HI-3559's footer.
 */
export const fixedInComment = (version: string): string => `Fixed in ${version}` // i18n-ignore: posted to GitHub as written, in English

/** A shipped card linked to an issue, as Close Shipped Issues… lists it. */
export interface ShippedIssue {
  card: number
  issue: number
  url: string
  /** Its state on GitHub now: closed ones are left as they are; unknown when it couldn't be read. */
  state: 'open' | 'closed' | 'unknown'
}

/** A released line Close Shipped Issues… offers: its release tag and the commit the tag names. */
export interface ReleasedLine {
  line: string
  tag: string
  commit: string
}

/**
 * What a close authorises (the preview shown, sent back by the click): the repository, the release (its line, tag and
 * tagged commit) and the shipped cards' issues. Main closes nothing unless all of it is still so.
 */
export interface ShippedPreview {
  repo: GithubRepoRef
  line: string
  tag: string
  commit: string
  issues: { card: number; issue: number }[]
}

/** What Close Shipped Issues… shows for a line: its release on GitHub, and its shipped issues. */
export type ShippedIssuesRead =
  | (Omit<ShippedPreview, 'issues'> & { version: string; published: boolean; releaseUrl: string | null; issues: ShippedIssue[] })
  | { repo: GithubRepoRef | null; problem: ReleaseProblem; detail: string | null }

/**
 * Each issue's outcome of a close, read back from GitHub: closed now, already closed, failed (still open, the source's
 * words), unknown (it couldn't be read back: never taken as closed), or stopped (not written: something it rests on
 * changed while the close went on).
 */
export interface CloseOutcome {
  issue: number
  card: number
  outcome: 'closed' | 'alreadyClosed' | 'failed' | 'unknown' | 'stopped'
  detail: string | null
}

/** A preview as the window sent it, its shape checked (null: not one). */
export function cleanPreview(raw: unknown): ShippedPreview | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const repo = r?.repo && typeof r.repo === 'object' ? (r.repo as Record<string, unknown>) : null
  const s = (o: Record<string, unknown> | null, k: string): string | null => (o && typeof o[k] === 'string' && (o[k] as string).length <= 250 ? (o[k] as string) : null)
  const [host, owner, name, line, tag, commit] = [s(repo, 'host'), s(repo, 'owner'), s(repo, 'repo'), s(r, 'line'), s(r, 'tag'), s(r, 'commit')]
  if (!host || !owner || !name || !line || !tag || !commit || !Array.isArray(r?.issues) || r.issues.length > 1000) return null
  const issues = (r.issues as unknown[]).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})).filter((x) => Number.isInteger(x.card) && Number.isInteger(x.issue)).map((x) => ({ card: x.card as number, issue: x.issue as number }))
  if (issues.length !== r.issues.length) return null
  return { repo: { host, owner, repo: name }, line, tag, commit, issues }
}

/** Whether two previews authorise the same close: one repository, release and set of card–issue pairs. */
export function samePreview(a: ShippedPreview, b: ShippedPreview): boolean {
  const pairs = (p: ShippedPreview): string => JSON.stringify([...p.issues].map((i) => `${i.card}:${i.issue}`).sort())
  const repo = (p: ShippedPreview): string => `${p.repo.host}/${p.repo.owner}/${p.repo.repo}`.toLowerCase()
  return repo(a) === repo(b) && a.line === b.line && a.tag === b.tag && a.commit === b.commit && pairs(a) === pairs(b)
}

/** The version a release line's issues are fixed in: the line's name, without a leading v (`v1.7.0` → `1.7.0`). */
export const versionOfLine = (line: string): string => line.replace(/^v(?=\d)/, '')
