// HI-3219 (HI-3191's card B): line comments on a card's revision diff, kept as card facts (facts.ts: LineComment and the
// facts that edit, resolve, reopen and delete one) and folded here. A comment is anchored to lines of one submission's
// file: the new side in its revision, the old side (deleted lines) in its base; the commits are the submission's, never
// stored with it. Its quote and context are cut by characters as well as lines, so a minified file's one long line
// can't make a fact, a read or a page large, while `from` and `to` keep the real line numbers. Pure: main writes the
// facts (workflow/lineComments.ts), the window and the Agent API read this fold.

import { agentOf, type Actor, type CardState, type Fact } from './facts'

/** The limits a comment and its reads keep to (HI-3191's design s20). */
export const LINE_COMMENT_LIMITS = {
  /** A comment's Markdown, in characters. */
  body: 4000,
  /** Each quoted or context line, in characters, "…" included. */
  line: 200,
  /** The whole quote of the lines commented on, in characters. */
  quote: 2000,
  /** Context lines kept before and after the quote. */
  context: 2,
  /** Open comments on one card. */
  open: 200,
  /** A page of rows (Agent API), in characters of JSON. */
  page: 24000
} as const

export type LineSide = 'new' | 'old'

/** A comment as the fold leaves it. */
export interface LineCommentView {
  /** Stable: `lc-<card key>-<the fact's seq>`. */
  id: string
  /** Who wrote it: 'user', 'assistant' or an agent's id. */
  by: string
  at: string
  submission: number
  side: LineSide
  path: string
  from: number
  to: number
  lines: string
  before: string
  after: string
  body: string
  /** 1 as written; each edit raises it. */
  version: number
  state: 'open' | 'resolved'
  /** Sent to the card's builder (HI-3220): then it can only be resolved, never deleted. */
  sent: boolean
  /** The version it was last sent at (HI-3220): a higher `version` is edited since. */
  sentVersion?: number
}

/** A line cut to the limit, "…" in place of the rest. */
export const cutLine = (l: string): string => (l.length > LINE_COMMENT_LIMITS.line ? `${l.slice(0, LINE_COMMENT_LIMITS.line - 1)}…` : l)

/**
 * The quote and context of lines `from`..`to` (1-based, inclusive) of a file's text: each line cut to the line limit, the
 * quote to the quote limit (a long range keeps its first and last lines, "…N lines…" between), and up to two context
 * lines each side. Lines past the file's end are simply absent.
 */
export function anchorOf(text: string, from: number, to: number): { lines: string; before: string; after: string } {
  const all = text.split(/\r\n|\n|\r/)
  const pick = (a: number, b: number): string[] => all.slice(Math.max(0, a), Math.max(0, b)).map(cutLine)
  const chosen = pick(from - 1, to)
  return { lines: fitQuote(chosen), before: pick(from - 1 - LINE_COMMENT_LIMITS.context, from - 1).join('\n'), after: pick(to, to + LINE_COMMENT_LIMITS.context).join('\n') }
}

/** Lines joined within the quote limit: whole, or its first and last lines taken in turn with "…N lines…" between. */
function fitQuote(lines: string[]): string {
  const whole = lines.join('\n')
  if (whole.length <= LINE_COMMENT_LIMITS.quote) return whole
  const head: string[] = []
  const tail: string[] = []
  const gap = (n: number): string => `…${n} lines…`
  const size = (): number => [...head, gap(lines.length), ...tail].join('\n').length
  for (let i = 0, j = lines.length - 1; i <= j; ) {
    const takeHead = head.length <= tail.length
    const next = takeHead ? lines[i] : lines[j]
    if (size() + next.length + 1 > LINE_COMMENT_LIMITS.quote) break
    if (takeHead) head.push(lines[i++])
    else tail.unshift(lines[j--])
  }
  return [...head, gap(lines.length - head.length - tail.length), ...tail].join('\n')
}

/** Who an actor is, as a comment names its writer. */
const byOf = (a: Actor): string => agentOf(a) ?? a

/** A card's comments from its facts, oldest first; deleted ones left out. */
export function foldLineComments(facts: readonly Fact[]): LineCommentView[] {
  return [...foldHistory(facts).values()].filter((h) => !h.deleted).map((h) => h.view)
}

/** Each comment as it is, with its text at every version (`bodies[v - 1]`), deleted ones marked: what a batch is rebuilt from. */
function foldHistory(facts: readonly Fact[]): Map<string, { view: LineCommentView; bodies: string[]; deleted: boolean }> {
  const all = new Map<string, { view: LineCommentView; bodies: string[]; deleted: boolean }>()
  const out = {
    set: (id: string, view: LineCommentView) => all.set(id, { view, bodies: [view.body], deleted: false }),
    get: (id: string) => {
      const h = all.get(id)
      return h && !h.deleted ? h.view : undefined
    },
    delete: (id: string) => {
      const h = all.get(id)
      if (h) h.deleted = true
    }
  }
  for (const f of facts) {
    if (f.kind === 'FeedbackSent') {
      for (const it of (f.data as Fact<'FeedbackSent'>['data']).items) {
        const c = out.get(it.id)
        if (!c) continue
        c.sent = true
        c.sentVersion = it.version
      }
      continue
    }
    if (f.kind === 'LineComment') {
      const d = f.data as Fact<'LineComment'>['data']
      out.set(d.id, { id: d.id, by: byOf(f.actor), at: f.at, submission: d.submission, side: d.side, path: d.path, from: d.from, to: d.to, lines: d.lines, before: d.before, after: d.after, body: d.body, version: 1, state: 'open', sent: false })
      continue
    }
    const id = (f.data as { id?: unknown })?.id
    const c = typeof id === 'string' ? out.get(id) : undefined
    if (!c) continue
    if (f.kind === 'LineCommentEdited') {
      const d = f.data as Fact<'LineCommentEdited'>['data']
      c.body = d.body
      c.version = d.version
      all.get(c.id)!.bodies[d.version - 1] = d.body
    } else if (f.kind === 'LineCommentResolved') c.state = 'resolved'
    else if (f.kind === 'LineCommentReopened') c.state = 'open'
    else if (f.kind === 'LineCommentDeleted') out.delete(c.id)
  }
  return all
}

/** A sent batch's item as the batch read gives it: the comment at the version sent. */
export interface FeedbackItem {
  id: string
  version: number
  /**
   * The submission its lines are on (HI-3220 round 1: a comment left open is sent again from where it was made), that
   * submission's revision and base, and `source`: the commit its lines and quote are in, the base for the old side (lines
   * removed; a deleted file's are in the base alone), the revision for the new.
   */
  submission: number
  revision: string | null
  base: string | null
  source: string | null
  path: string
  side: LineSide
  from: number
  to: number
  lines: string
  before: string
  after: string
  body: string
}

/**
 * The items of a sent batch (HI-3220), in the order sent, each rebuilt from the facts at the version sent: what the
 * builder was given, whatever was edited, resolved or sent since; null when the card sent no such batch.
 */
export function feedbackBatch(facts: readonly Fact[], batch: string): { submission: number; round: number; items: FeedbackItem[] } | null {
  const sent = facts.find((f): f is Fact<'FeedbackSent'> => f.kind === 'FeedbackSent' && (f.data as Fact<'FeedbackSent'>['data']).batch === batch)
  if (!sent) return null
  const history = foldHistory(facts.filter((f) => f.seq < sent.seq))
  const revisionOf = submissionRevisions(facts)
  const items = sent.data.items.flatMap((it): FeedbackItem[] => {
    const h = history.get(it.id)
    if (!h) return []
    const c = h.view
    const at = revisionOf.get(c.submission)
    return [{ id: it.id, version: it.version, submission: c.submission, revision: at?.revision ?? null, base: at?.base ?? null, source: sourceOf(at, c.side), path: c.path, side: c.side, from: c.from, to: c.to, lines: c.lines, before: c.before, after: c.after, body: h.bodies[it.version - 1] ?? c.body }]
  })
  return { submission: sent.data.submission, round: sent.data.round, items }
}

/** Each submission's revision and base, by its fact's seq (a comment's `submission`). */
export function submissionRevisions(facts: readonly Fact[]): Map<number, { revision: string | null; base: string | null }> {
  return new Map(
    facts.flatMap((f) => {
      if (f.kind !== 'Submitted') return []
      const d = f.data as Fact<'Submitted'>['data']
      return [[f.seq, { revision: d.revision, base: d.base }] as [number, { revision: string | null; base: string | null }]]
    })
  )
}

/** The commit a comment's lines are in: its submission's base for the old side (lines removed), its revision for the new. */
export const sourceOf = (at: { revision: string | null; base: string | null } | undefined, side: LineSide): string | null => (side === 'old' ? at?.base : at?.revision) ?? null

/** Whether a batch id was sent on the card already (a second send of it is refused). */
export const batchSent = (facts: readonly Fact[], batch: string): boolean => facts.some((f) => f.kind === 'FeedbackSent' && (f.data as Fact<'FeedbackSent'>['data']).batch === batch)

/** An agent's review of the card's latest submission begun and not yet given its verdict, or null (HI-3220). */
export function openReviewOf(s: CardState): { reviewer: string; submission: number } | null {
  const sub = s.latest?.id
  if (sub === undefined) return null
  const reviewer = (s.reviewing[sub] ?? []).find((r) => r !== 'user' && !s.verdicts.some((v) => v.submission === sub && v.reviewer === r))
  return reviewer ? { reviewer, submission: sub } : null
}

/** What a send's preview saw of the card (HI-3220): its latest submission, its decision generation and its open review. */
export interface FeedbackExpect {
  submission: number
  generation: number
  review: { reviewer: string; submission: number } | null
}

export const feedbackExpectOf = (s: CardState): FeedbackExpect | null => (s.latest ? { submission: s.latest.id, generation: s.generation, review: openReviewOf(s) } : null)

/** Whether two previews saw the same card. */
export const sameExpect = (a: FeedbackExpect | null, b: FeedbackExpect | null): boolean =>
  !!a && !!b && a.submission === b.submission && a.generation === b.generation && (a.review?.reviewer ?? null) === (b.review?.reviewer ?? null) && (a.review?.submission ?? null) === (b.review?.submission ?? null)

/** How many comments are open, sent and resolved (a sent one still open counts in both open and sent). */
export function lineCommentCounts(views: readonly LineCommentView[]): { open: number; sent: number; resolved: number } {
  return { open: views.filter((c) => c.state === 'open').length, sent: views.filter((c) => c.sent).length, resolved: views.filter((c) => c.state === 'resolved').length }
}

/**
 * A page of rows from `offset`, as many as fit in `budget` characters of JSON (always at least one), and `next`: where
 * the next page starts, while rows remain.
 */
export function pageOf<T>(rows: readonly T[], offset: number, budget: number = LINE_COMMENT_LIMITS.page): { rows: T[]; next?: number } {
  const start = Math.max(0, Math.floor(offset) || 0)
  const out: T[] = []
  let used = 2
  for (let i = start; i < rows.length; i++) {
    const n = JSON.stringify(rows[i]).length + 1
    if (out.length && used + n > budget) break
    out.push(rows[i])
    used += n
  }
  const end = start + out.length
  return end < rows.length ? { rows: out, next: end } : { rows: out }
}
