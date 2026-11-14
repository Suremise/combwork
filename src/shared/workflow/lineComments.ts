// HI-3219 (HI-3191's card B): line comments on a card's revision diff, kept as card facts (facts.ts: LineComment and the
// facts that edit, resolve, reopen and delete one) and folded here. A comment is anchored to lines of one submission's
// file: the new side in its revision, the old side (deleted lines) in its base; the commits are the submission's, never
// stored with it. Its quote and context are cut by characters as well as lines, so a minified file's one long line
// can't make a fact, a read or a page large, while `from` and `to` keep the real line numbers. Pure: main writes the
// facts (workflow/lineComments.ts), the window and the Agent API read this fold.

import { agentOf, type Actor, type Fact } from './facts'

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
  /** Sent to the card's builder (card C, HI-3220): then it can only be resolved, never deleted. */
  sent: boolean
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
  const out = new Map<string, LineCommentView>()
  for (const f of facts) {
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
    } else if (f.kind === 'LineCommentResolved') c.state = 'resolved'
    else if (f.kind === 'LineCommentReopened') c.state = 'open'
    else if (f.kind === 'LineCommentDeleted') out.delete(c.id)
  }
  return [...out.values()]
}

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
