// HI-3554 (HI-2843's design): a pull request's comments on its card, and "Address feedback". The comments, review bodies
// and inline review threads GitHub has on the pull request a card is about (its GitHub source, or the one it opened, in
// PR open), as main reads them through gh; the ones the user picks go on a fix card beside its source, quoted to agents
// as outside text (anyone can write them on a public repository), never as instructions. Pure: main reads GitHub.

/** The most of one comment's body kept (characters; the rest cut, marked …). */
export const FEEDBACK_BODY_MAX = 4000
/** The most items a pull request's read keeps (the newest), and a fix card carries. */
export const FEEDBACK_MAX_ITEMS = 100
/** The most replies a thread keeps (the first ones). */
const REPLIES_MAX = 30

/** Who wrote a comment and how GitHub relates them to the repository (author_association; null: it didn't say). */
export interface FeedbackAuthor {
  login: string | null
  association: string | null
}

/** A reply in a review thread. */
export interface FeedbackReply extends FeedbackAuthor {
  body: string
  at: string | null
}

/**
 * One thing to address: a conversation comment, a review's own body (with its state), or an inline review thread (its
 * first comment, where it is, and the replies). `id` is the kind's letter and GitHub's id: what the window sends back.
 */
export interface FeedbackItem extends FeedbackAuthor {
  id: string
  kind: 'comment' | 'review' | 'thread'
  body: string
  at: string | null
  url: string | null
  /** A review's state as GitHub gives it (APPROVED, CHANGES_REQUESTED, COMMENTED…). */
  state?: string
  /** A thread's file and line. */
  path?: string
  line?: number | null
  replies?: FeedbackReply[]
}

/** The pull request whose feedback it is: its repository on its host, and its number. */
export interface FeedbackTarget {
  host: string
  owner: string
  repo: string
  number: number
}

/** What the card dialog shows: the pull request's feedback as read now, or why it couldn't be read (gh's own words). */
export type PrFeedbackRead = { target: FeedbackTarget; open: boolean; items: FeedbackItem[]; at: number } | { target: FeedbackTarget | null; problem: 'missing' | 'signedOut' | 'timeout' | 'failed' | 'noPr'; detail: string | null }

/** How the card shows GitHub's association: the repository's own people by their role, anyone else as from outside. */
export function associationLabel(a: string | null | undefined): 'owner' | 'member' | 'collaborator' | 'outside' | 'unknown' {
  const v = (a ?? '').toUpperCase()
  if (!v) return 'unknown'
  return v === 'OWNER' ? 'owner' : v === 'MEMBER' ? 'member' : v === 'COLLABORATOR' ? 'collaborator' : 'outside'
}

/** A body from GitHub as kept: line ends made \n, control characters but tab and newline dropped, at most FEEDBACK_BODY_MAX. */
export function clipFeedback(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  return s.length > FEEDBACK_BODY_MAX ? `${s.slice(0, FEEDBACK_BODY_MAX - 1)}…` : s
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const assoc = (v: unknown): string | null => (typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v) ? v : null)
const loginOf = (v: unknown): string | null => (v && typeof v === 'object' ? str((v as { login?: unknown }).login) : null)
const time = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * The feedback of a pull request from gh's answers: `view`, `pr view --json comments,reviews` (conversation comments and
 * reviews, each with its author and authorAssociation); `inline`, the REST list of its review comments (user,
 * author_association, path, line, in_reply_to_id), grouped into threads by the comment they answer. Reviews with no body
 * of their own (only inline comments) are left out, as are empty comments. Oldest first, the newest FEEDBACK_MAX_ITEMS.
 */
export function feedbackOf(view: unknown, inline: unknown): FeedbackItem[] {
  const v = (view && typeof view === 'object' ? view : {}) as Record<string, unknown>
  const out: FeedbackItem[] = []
  for (const c of Array.isArray(v.comments) ? (v.comments as Record<string, unknown>[]) : []) {
    const body = clipFeedback(c?.body)
    const id = str(c?.id)
    if (!body || !id) continue
    out.push({ id: `c:${id}`, kind: 'comment', login: loginOf(c.author), association: assoc(c.authorAssociation), body, at: str(c.createdAt), url: str(c.url) })
  }
  for (const r of Array.isArray(v.reviews) ? (v.reviews as Record<string, unknown>[]) : []) {
    const body = clipFeedback(r?.body)
    const id = str(r?.id)
    if (!body || !id) continue
    out.push({ id: `r:${id}`, kind: 'review', login: loginOf(r.author), association: assoc(r.authorAssociation), body, at: str(r.submittedAt), url: null, ...(str(r.state) ? { state: str(r.state)! } : {}) })
  }
  const list = Array.isArray(inline) ? (inline as Record<string, unknown>[]) : []
  const roots = new Map<number, FeedbackItem>()
  const replies: Record<string, unknown>[] = []
  for (const c of list) {
    if (!c || !Number.isInteger(c.id)) continue
    if (Number.isInteger(c.in_reply_to_id)) {
      replies.push(c)
      continue
    }
    const body = clipFeedback(c.body)
    if (!body) continue
    const line = Number.isInteger(c.line) ? (c.line as number) : Number.isInteger(c.original_line) ? (c.original_line as number) : null
    roots.set(c.id as number, { id: `t:${c.id}`, kind: 'thread', login: loginOf(c.user), association: assoc(c.author_association), body, at: str(c.created_at), url: str(c.html_url), path: str(c.path) ?? '', line, replies: [] })
  }
  for (const c of replies.sort((a, b) => time(a.created_at) - time(b.created_at))) {
    const root = roots.get(c.in_reply_to_id as number)
    const body = clipFeedback(c.body)
    if (!root || !body || root.replies!.length >= REPLIES_MAX) continue
    root.replies!.push({ login: loginOf(c.user), association: assoc(c.author_association), body, at: str(c.created_at) })
  }
  out.push(...roots.values())
  return out.sort((a, b) => time(a.at) - time(b.at)).slice(-FEEDBACK_MAX_ITEMS)
}

/** A fix card's kept feedback as it is read back (anything damaged dropped): never trusted beyond its shape. */
export function cleanFeedback(raw: unknown): FeedbackItem[] {
  if (!Array.isArray(raw)) return []
  const out: FeedbackItem[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue
    const kind = r.kind === 'comment' || r.kind === 'review' || r.kind === 'thread' ? r.kind : null
    const id = str(r.id)
    const body = clipFeedback(r.body)
    if (!kind || !id || !body) continue
    const replies = kind === 'thread' && Array.isArray(r.replies) ? (r.replies as Record<string, unknown>[]).filter((x) => x && clipFeedback(x.body)).slice(0, REPLIES_MAX).map((x) => ({ login: str(x.login), association: assoc(x.association), body: clipFeedback(x.body), at: str(x.at) })) : undefined
    out.push({ id, kind, login: str(r.login), association: assoc(r.association), body, at: str(r.at), url: str(r.url), ...(kind === 'review' && str(r.state) ? { state: str(r.state)! } : {}), ...(kind === 'thread' ? { path: str(r.path) ?? '', line: Number.isInteger(r.line) ? (r.line as number) : null, replies: replies ?? [] } : {}) })
    if (out.length >= FEEDBACK_MAX_ITEMS) break
  }
  return out
}

/** One item as an agent reads it, inside its card's outsideText: who (and whether a member), where, and their words. */
export interface FeedbackForAgents {
  kind: FeedbackItem['kind']
  author: string | null
  /** False: GitHub says they aren't one of the repository's members; null: unknown. */
  authorIsMember: boolean | null
  state?: string
  path?: string
  line?: number | null
  body: string
  replies?: { author: string | null; authorIsMember: boolean | null; body: string }[]
}

const member = (a: string | null): boolean | null => {
  const l = associationLabel(a)
  return l === 'unknown' ? null : l !== 'outside'
}

/** A fix card's feedback for an agent's read (HI-3554): quoted data beside the source's body, under its outside-text note. */
export function feedbackForAgents(items: readonly FeedbackItem[]): FeedbackForAgents[] {
  return items.map((i) => ({
    kind: i.kind,
    author: i.login,
    authorIsMember: member(i.association),
    ...(i.state ? { state: i.state } : {}),
    ...(i.kind === 'thread' ? { path: i.path ?? '', line: i.line ?? null } : {}),
    body: i.body,
    ...(i.kind === 'thread' ? { replies: (i.replies ?? []).map((r) => ({ author: r.login, authorIsMember: member(r.association), body: r.body })) } : {})
  }))
}
