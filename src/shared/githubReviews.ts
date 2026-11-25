// HI-3559 (Feedback to GitHub; HI-3541's and HI-2843's decisions, HI-3553/r9 points 4 and 5): the reviews a pull
// request's card sends back to GitHub, folded from its facts (facts.ts: GithubReviewDrafted, …Posting, …Posted, …Failed,
// …Discarded), and how one is made: its body (the verdict or the user's words, the user's line comments that can't sit on
// GitHub's diff listed, an agent's footer) and its inline comments, placed only on lines the pull request's diff shows.
// Always a COMMENT review: approving is the user's (HI-3560) and merging stays on GitHub. Pure: main posts through gh.

import type { LineCommentView } from './workflow/lineComments'
import type { GithubFeedback } from './workflow/options'

/** A fact as the fold reads it. */
interface FactLike {
  seq: number
  kind: string
  at: string
  data: unknown
}

/**
 * A review of the card's: a draft (an agent's verdict) or one the user wrote, what each attempt to post it said, and what
 * came of the latest. A failed or uncertain one keeps its attempt's text (HR1's round 1), so posting again sends that.
 */
export interface GithubReviewRow {
  /** Its draft's fact seq, or its first posting's for one the user wrote: stable, the window's key and its id to post again. */
  id: number
  draft: { seq: number; verdict: number; submission: number; revision: string | null; reviewer: string; body: string; auto: boolean; at: string } | null
  /** Its latest posting: who, when, for which submission, and the text it sent (the draft as edited, or the user's own). */
  posting: { seq: number; by: 'combwork' | 'user'; at: string; submission: number | null; body: string } | null
  /** The text to show and post again: the latest attempt's, else the draft's. */
  text: string
  /**
   * draft: never posted; posting: claimed, no result yet; posted; failed: GitHub refused it or it wasn't sent (posting
   * again is safe); uncertain: it may have reached GitHub (no answer in time, or one that can't be read): check there
   * before posting again; discarded.
   */
  state: 'draft' | 'posting' | 'posted' | 'failed' | 'uncertain' | 'discarded'
  posted?: { url: string | null; body: string; comments: string[]; inline: number; listed: number; at: string; replies: ThreadReply[] }
  error?: string
}

/** What the card dialog's Feedback to GitHub shows. */
export interface GithubReviewsView {
  feedback: GithubFeedback
  footer: boolean
  rows: (GithubReviewRow & { reviewerName: string | null; model: string | null; can: RowActions })[]
  /** The user's open line comments on the card's latest submission, which a review written now carries. */
  openComments: number
  /** Whether the user can write a review of their own now (not under Agent). */
  canWrite: boolean
  url: string
  /** HI-3560: when the user last approved the pull request from the card (null: never). */
  approved: string | null
}

/** HI-3554: a fix card's reply on one review thread it addresses: posted (its url), refused (`error`), or maybe posted (`uncertain`). */
export interface ThreadReply {
  thread: number
  url?: string | null
  error?: string
  uncertain?: true
}

/** The replies a Posted fact holds, as read back (anything damaged dropped). */
function repliesOf(raw: unknown): ThreadReply[] {
  if (!Array.isArray(raw)) return []
  return (raw as Record<string, unknown>[]).filter((r) => r && Number.isInteger(r.thread)).map((r) => ({ thread: r.thread as number, ...(typeof r.url === 'string' || r.url === null ? { url: r.url as string | null } : {}), ...(typeof r.error === 'string' ? { error: r.error } : {}), ...(r.uncertain === true ? { uncertain: true as const } : {}) }))
}

/** The card's reviews to and on GitHub, oldest first. */
export function foldGithubReviews(facts: readonly FactLike[]): GithubReviewRow[] {
  const rows: GithubReviewRow[] = []
  const byDraft = new Map<number, GithubReviewRow>()
  const byId = new Map<number, GithubReviewRow>()
  const byPosting = new Map<number, GithubReviewRow>()
  for (const f of facts) {
    const d = f.data as Record<string, unknown>
    if (f.kind === 'GithubReviewDrafted') {
      const body = String(d.body ?? '')
      const row: GithubReviewRow = { id: f.seq, draft: { seq: f.seq, verdict: Number(d.verdict), submission: Number(d.submission), revision: typeof d.revision === 'string' ? d.revision : null, reviewer: String(d.reviewer ?? ''), body, auto: d.auto === true, at: f.at }, posting: null, text: body, state: 'draft' }
      rows.push(row)
      byDraft.set(f.seq, row)
      byId.set(f.seq, row)
    } else if (f.kind === 'GithubReviewPosting') {
      // A draft's, an earlier own review's again (`own`: its id), or a new one of the user's.
      const known = typeof d.draft === 'number' ? byDraft.get(d.draft) : typeof d.own === 'number' ? byId.get(d.own) : undefined
      const body = String(d.body ?? '')
      const posting = { seq: f.seq, by: d.by === 'combwork' ? ('combwork' as const) : ('user' as const), at: f.at, submission: typeof d.submission === 'number' ? d.submission : null, body }
      const row: GithubReviewRow = known ?? { id: f.seq, draft: null, posting: null, text: body, state: 'posting' }
      if (!known) {
        rows.push(row)
        byId.set(f.seq, row)
      }
      row.posting = posting
      row.text = body
      row.state = 'posting'
      delete row.error
      byPosting.set(f.seq, row)
    } else if (f.kind === 'GithubReviewPosted') {
      const row = byPosting.get(Number(d.posting))
      if (!row || row.posting?.seq !== Number(d.posting)) continue
      row.state = 'posted'
      row.posted = { url: typeof d.url === 'string' ? d.url : null, body: String(d.body ?? ''), comments: Array.isArray(d.comments) ? d.comments.map(String) : [], inline: Number(d.inline) || 0, listed: Number(d.listed) || 0, at: f.at, replies: repliesOf(d.replies) }
    } else if (f.kind === 'GithubReviewFailed') {
      const row = byPosting.get(Number(d.posting))
      if (!row || row.posting?.seq !== Number(d.posting) || row.state === 'posted') continue
      row.state = d.uncertain === true ? 'uncertain' : 'failed'
      row.error = String(d.error ?? '')
    } else if (f.kind === 'GithubReviewDiscarded') {
      const row = byDraft.get(Number(d.draft))
      // A posting never finished is discarded too, once the user may (rowActions: a stale one); a result written after still shows.
      if (row && (row.state === 'draft' || row.state === 'failed' || row.state === 'uncertain' || row.state === 'posting')) row.state = 'discarded'
    }
  }
  return rows
}

/**
 * HI-3560 (HR1's round 1): when the user last approved, from the card, the pull request it is about now (`source`), its
 * identity compared whole; an approval of another one (the card's source changed since) isn't this one's. Null: never.
 */
export function approvalOf(facts: readonly FactLike[], source: { host: string; owner: string; repo: string; number: number }): string | null {
  const same = (d: Record<string, unknown>): boolean =>
    typeof d.host === 'string' && typeof d.owner === 'string' && typeof d.repo === 'string' && d.number === source.number && d.host.toLowerCase() === source.host.toLowerCase() && d.owner.toLowerCase() === source.owner.toLowerCase() && d.repo.toLowerCase() === source.repo.toLowerCase()
  return facts.findLast((f) => f.kind === 'GithubPrApproved' && same(f.data as Record<string, unknown>))?.at ?? null
}

/** A posting claimed this long ago with no result (Combwork closed mid-post) is shown as maybe posted, and can be posted again. */
export const STUCK_MS = 10 * 60_000

/** What the user may do with a row now, and why it waits on them (HR1's round 1, finding 4: recovery never resends by itself). */
export interface RowActions {
  post: boolean
  discard: boolean
  /** abandoned: an automatic post that never started (its action gone); stale: a post that never finished; uncertain: one GitHub may have taken. */
  recovery: 'abandoned' | 'stale' | 'uncertain' | null
}

/**
 * Whether `by` may post `row` (null: a new review of the user's) under `feedback` now: the one rule main checks under its
 * claim and again just before each write to GitHub, and the window shows. `pending`: an automatic post of the draft is
 * still waiting to run (its action); `now` for a posting's age.
 */
export function rowActions(feedback: GithubFeedback, by: 'user' | 'combwork', row: GithubReviewRow | null, ctx: { now: number; pending: boolean }): RowActions {
  const none: RowActions = { post: false, discard: false, recovery: null }
  if (by === 'combwork') return { ...none, post: feedback === 'agent' && !!row?.draft?.auto && row.state === 'draft' }
  if (!row) return { ...none, post: feedback !== 'agent' }
  const stale = row.state === 'posting' && !!row.posting && ctx.now - Date.parse(row.posting.at) >= STUCK_MS
  const again = row.state === 'failed' || row.state === 'uncertain' || stale
  const abandoned = feedback === 'agent' && !!row.draft?.auto && row.state === 'draft' && !ctx.pending
  const recovery = abandoned ? 'abandoned' : stale ? 'stale' : row.state === 'uncertain' ? 'uncertain' : null
  // The user's own review: again under Both or You. A draft: under Both; under Agent, an automatic one that failed, never
  // started or never finished. Under You, never an agent's.
  const post = !row.draft ? feedback !== 'agent' && again : feedback === 'both' ? row.state === 'draft' || again : feedback === 'agent' && row.draft.auto && (again || abandoned)
  const discard = !!row.draft && (row.state === 'draft' || row.state === 'failed' || row.state === 'uncertain' || stale)
  return { post, discard, recovery }
}

/**
 * Whether `by` still has the authority it claimed with, checked again just before each write to GitHub (HR1's round 1,
 * finding 1): the option as it is now allows that kind of review, and the row's latest posting is still this claim.
 */
export function stillAllowed(feedback: GithubFeedback, by: 'user' | 'combwork', row: GithubReviewRow | null, posting: number): boolean {
  if (!row || row.state !== 'posting' || row.posting?.seq !== posting) return false
  if (by === 'combwork') return feedback === 'agent' && !!row.draft?.auto
  return !row.draft ? feedback !== 'agent' : feedback === 'both' || (feedback === 'agent' && row.draft.auto)
}

/**
 * The footer an agent's text carries on GitHub (HI-3541's decision: on by default, with an off switch), since gh posts as
 * the user's own account. English: it is posted to GitHub as written, for whoever reads the pull request.
 */
export const githubFooter = (model: string): string => `Drafted by ${model} in Combwork` // i18n-ignore: posted to GitHub as written, in English

/** A hunk of a file's change, from its `@@ -a,b +c,d @@` header: the old side's lines a..a+b-1, the new side's c..c+d-1. */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

/** The hunks of a unified diff of one file (`git diff -U3`), from their headers. */
export function parseHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    out.push({ oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]) })
  }
  return out
}

/** Whether lines `from`..`to` of a side sit in one hunk, where GitHub takes a review comment on them. */
export function inHunks(hunks: readonly DiffHunk[], side: 'new' | 'old', from: number, to: number): boolean {
  return hunks.some((h) => {
    const start = side === 'new' ? h.newStart : h.oldStart
    const n = side === 'new' ? h.newLines : h.oldLines
    return n > 0 && from >= start && to <= start + n - 1
  })
}

/** A line comment as GitHub's review takes it: on the new side (RIGHT) or the old (LEFT), one line or several. */
export interface InlineComment {
  path: string
  body: string
  line: number
  side: 'RIGHT' | 'LEFT'
  start_line?: number
  start_side?: 'RIGHT' | 'LEFT'
}

export const inlineOf = (c: Pick<LineCommentView, 'path' | 'side' | 'from' | 'to' | 'body'>): InlineComment => {
  const side = c.side === 'old' ? 'LEFT' : 'RIGHT'
  return { path: c.path, body: c.body, line: c.to, side, ...(c.from < c.to ? { start_line: c.from, start_side: side } : {}) }
}

/** The line comments that can't sit on GitHub's diff, listed in the review's body (English: posted as written). */
export function listedComments(comments: readonly Pick<LineCommentView, 'path' | 'side' | 'from' | 'to' | 'body'>[]): string {
  if (!comments.length) return ''
  const where = (c: Pick<LineCommentView, 'side' | 'from' | 'to'>): string => `${c.from === c.to ? `line ${c.from}` : `lines ${c.from}–${c.to}`}${c.side === 'old' ? ' (before the change)' : ''}` // i18n-ignore: posted to GitHub as written, in English
  return ['**Line comments**', ...comments.map((c) => `- \`${c.path}\`, ${where(c)}: ${c.body.replace(/\r?\n/g, ' ')}`)].join('\n') // i18n-ignore: posted to GitHub as written, in English
}

/** A review's body: its text, the comments listed, and the footer (an agent's only), separated by blank lines. */
export function reviewBody(text: string, listed: string, footer: string | null): string {
  return [text.trim(), listed, footer ? `---\n_${footer}_` : ''].filter(Boolean).join('\n\n')
}

/** The most a review's body (characters) GitHub takes is 65,536: one longer is cut, marked, with its footer kept. */
export const REVIEW_BODY_MAX = 65_000

/**
 * A review's body within `max` characters: its text and the comments listed cut (marked …) to leave room for the footer,
 * which is never cut off (HR1's round 1, finding 5).
 */
export function boundedBody(text: string, listed: string, footer: string | null, max: number = REVIEW_BODY_MAX): string {
  const tail = footer ? `\n\n---\n_${footer}_` : ''
  let head = [text.trim(), listed].filter(Boolean).join(`\n\n`)
  const room = max - tail.length
  if (head.length > room) head = `${head.slice(0, Math.max(0, room - 1))}…`
  return head + tail
}
