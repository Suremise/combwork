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

/** A review of the card's: a draft (an agent's verdict) or one the user wrote, and what came of posting it. */
export interface GithubReviewRow {
  /** Its draft's fact seq, or its first posting's for one the user wrote: stable, the window's key. */
  id: number
  draft: { seq: number; verdict: number; submission: number; revision: string | null; reviewer: string; body: string; auto: boolean; at: string } | null
  /** Its latest posting: who, when, and for which submission. */
  posting: { seq: number; by: 'combwork' | 'user'; at: string; submission: number | null } | null
  /** draft: not posted (yet); posting: claimed, no result yet; posted; failed (can be posted again); discarded. */
  state: 'draft' | 'posting' | 'posted' | 'failed' | 'discarded'
  posted?: { url: string | null; body: string; comments: string[]; inline: number; listed: number; at: string }
  error?: string
}

/** What the card dialog's Feedback to GitHub shows. */
export interface GithubReviewsView {
  feedback: GithubFeedback
  footer: boolean
  rows: (GithubReviewRow & { reviewerName: string | null; model: string | null })[]
  /** The user's open line comments on the card's latest submission, which a review written now carries. */
  openComments: number
  /** Whether the user can write a review of their own now (not under Agent). */
  canWrite: boolean
  url: string
}

/** The card's reviews to and on GitHub, oldest first. */
export function foldGithubReviews(facts: readonly FactLike[]): GithubReviewRow[] {
  const rows: GithubReviewRow[] = []
  const byDraft = new Map<number, GithubReviewRow>()
  const byPosting = new Map<number, GithubReviewRow>()
  for (const f of facts) {
    const d = f.data as Record<string, unknown>
    if (f.kind === 'GithubReviewDrafted') {
      const row: GithubReviewRow = { id: f.seq, draft: { seq: f.seq, verdict: Number(d.verdict), submission: Number(d.submission), revision: typeof d.revision === 'string' ? d.revision : null, reviewer: String(d.reviewer ?? ''), body: String(d.body ?? ''), auto: d.auto === true, at: f.at }, posting: null, state: 'draft' }
      rows.push(row)
      byDraft.set(f.seq, row)
    } else if (f.kind === 'GithubReviewPosting') {
      const draft = typeof d.draft === 'number' ? byDraft.get(d.draft) : undefined
      const posting = { seq: f.seq, by: d.by === 'combwork' ? ('combwork' as const) : ('user' as const), at: f.at, submission: typeof d.submission === 'number' ? d.submission : null }
      const row: GithubReviewRow = draft ?? { id: f.seq, draft: null, posting: null, state: 'posting' }
      if (!draft) rows.push(row)
      row.posting = posting
      row.state = 'posting'
      delete row.error
      byPosting.set(f.seq, row)
    } else if (f.kind === 'GithubReviewPosted') {
      const row = byPosting.get(Number(d.posting))
      if (!row) continue
      row.state = 'posted'
      row.posted = { url: typeof d.url === 'string' ? d.url : null, body: String(d.body ?? ''), comments: Array.isArray(d.comments) ? d.comments.map(String) : [], inline: Number(d.inline) || 0, listed: Number(d.listed) || 0, at: f.at }
    } else if (f.kind === 'GithubReviewFailed') {
      const row = byPosting.get(Number(d.posting))
      if (!row || row.state === 'posted') continue
      row.state = 'failed'
      row.error = String(d.error ?? '')
    } else if (f.kind === 'GithubReviewDiscarded') {
      const row = byDraft.get(Number(d.draft))
      if (row && (row.state === 'draft' || row.state === 'failed')) row.state = 'discarded'
    }
  }
  return rows
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
