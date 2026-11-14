// HI-3219: the user's line comments on a card's revision diff, written as card facts (shared/workflow/lineComments.ts). The
// quote and its context are read here from the submission's commits (revisionDiff.ts), never taken from the window, and
// cut to their limits; each change is checked in the write's own transaction against the card's facts as they are then.
// The window tells the board once a write is done (boardChanged), so the card's work is read again.

import { boardChanged } from '../boardStore'
import { combworkError } from '../combworkError'
import type { WorkspaceService } from '../workspace'
import { msg } from '../../shared/i18n'
import { randomUUID } from 'crypto'
import { anchorOf, feedbackBatch, feedbackExpectOf, foldLineComments, LINE_COMMENT_LIMITS, openReviewOf, pageOf, type FeedbackExpect, type FeedbackItem, type LineCommentView, type LineSide } from '../../shared/workflow/lineComments'
import { foldCard } from '../../shared/workflow/facts'
import { revisionShort } from '../../shared/platform/descriptors'
import { platformIdOf } from '../platform/registry'
import { runIntent, WorkflowRefusedError } from '../tasks'
import { feedbackComment } from './feedbackText'
import { isRefusal } from './runtime'
import { cardFacts } from './recorder'
import { projectPathOf, revisionDiff } from './revisionDiff'
import { workflowFor } from './service'

const M = {
  empty: msg({ id: 'board.work.comments.empty', defaultMessage: 'A comment needs some text.', description: "A line comment on a card's revision diff couldn't be saved: its text is empty." }),
  tooLong: msg({ id: 'board.work.comments.tooLong', defaultMessage: 'A comment can be at most {max, number} characters.', description: "A line comment on a card's revision diff couldn't be saved: its text is longer than {max} characters." }),
  binary: msg({ id: 'board.work.comments.binary', defaultMessage: 'Lines of a binary file, or of one too large to compare, can’t be commented on.', description: "A line comment couldn't be added: the file is binary, or too large for its diff to be shown." }),
  lines: msg({ id: 'board.work.comments.lines', defaultMessage: 'Lines {from} to {to} aren’t in that side of {path}.', description: "A line comment couldn't be added: the lines it names ({from} to {to}: line numbers, never formatted as amounts) aren't in that side (the original or the changed version) of the file {path}." }),
  tooMany: msg({ id: 'board.work.comments.tooMany', defaultMessage: 'This card has {max, number} open comments already: resolve some first.', description: "A line comment couldn't be added or reopened: the card already has the most open comments it can have ({max})." }),
  noCard: msg({ id: 'board.work.comments.noCard', defaultMessage: 'This card’s work can’t be read, so it can’t take comments.', description: "A line comment couldn't be saved: the card's work record (its facts) can't be read: a card from before 1.0, or its project has none." }),
  noComment: msg({ id: 'board.work.comments.noComment', defaultMessage: 'That comment is no longer on this card.', description: "A line comment couldn't be changed: it was deleted meanwhile." }),
  changed: msg({ id: 'board.work.comments.changed', defaultMessage: 'That comment was changed meanwhile: look at it again.', description: "A line comment's edit couldn't be saved: someone changed the comment since it was opened for editing." }),
  sent: msg({ id: 'board.work.comments.sent', defaultMessage: 'A comment sent to the builder can’t be deleted: resolve it instead.', description: "A line comment couldn't be deleted: it was already sent to the card's builder, so it can only be resolved. Glossary: builder." })
}

/** What the window sends to add a comment: where, and its Markdown. */
export interface LineCommentAdd {
  submission: number
  path: string
  side: LineSide
  from: number
  to: number
  body: string
}

/** A change to a comment: its Markdown (with the version it was edited from), resolved, reopened, or deleted. */
export type LineCommentChange = { edit: { body: string; version: number } } | 'resolve' | 'reopen' | 'delete'

/** Card `n`'s comments, oldest first. */
export function lineCommentsOf(ws: WorkspaceService, n: number): LineCommentView[] {
  return foldLineComments(cardFacts(ws, n))
}

const bodyOf = (body: unknown): string => {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) throw combworkError(M.empty)
  if (text.length > LINE_COMMENT_LIMITS.body) throw combworkError(M.tooLong, { max: LINE_COMMENT_LIMITS.body })
  return text
}

async function cardOf(ws: WorkspaceService, n: number) {
  const wf = await workflowFor(ws, projectPathOf(ws, n)).catch(() => null)
  const card = wf?.store.card(n) ?? null
  if (!wf || !card) throw combworkError(M.noCard)
  return { wf, card }
}

/** Adds the user's comment on lines of a submission's file; its id. */
export async function addLineComment(ws: WorkspaceService, n: number, a: LineCommentAdd): Promise<string> {
  const body = bodyOf(a?.body)
  const side: LineSide = a?.side === 'old' ? 'old' : 'new'
  const submission = Number(a?.submission)
  const path = String(a?.path ?? '')
  const from = Math.floor(Number(a?.from))
  const to = Math.floor(Number(a?.to))
  // The quote, from the commits: refused for a file the submission doesn't list, or whose side can't be read.
  const diff = await revisionDiff(ws, n, submission, path)
  if (diff.binary || diff.gitlink) throw combworkError(M.binary)
  const text = side === 'new' ? diff.modified : diff.original
  const count = text.split(/\r\n|\n|\r/).length
  if (!(from >= 1 && to >= from && to <= count)) throw combworkError(M.lines, { from: Number.isFinite(from) ? from : 0, to: Number.isFinite(to) ? to : 0, path })
  const anchor = anchorOf(text, from, to)
  const { wf, card } = await cardOf(ws, n)
  const id = await wf.write(card, null, 'user', (w) => {
    const open = foldLineComments(w.tx.facts(card.id)).filter((c) => c.state === 'open').length
    if (open >= LINE_COMMENT_LIMITS.open) throw combworkError(M.tooMany, { max: LINE_COMMENT_LIMITS.open })
    const made = `lc-${card.key}-${w.state().lastSeq + 1}`
    w.fact('LineComment', { id: made, submission, side, path, from, to, ...anchor, body })
    return made
  })
  boardChanged(ws)
  return id
}

/** Changes one of the card's comments, checked against its facts in the write. */
export async function changeLineComment(ws: WorkspaceService, n: number, id: string, change: LineCommentChange): Promise<void> {
  const edit = typeof change === 'object' && change && 'edit' in change ? { body: bodyOf(change.edit?.body), version: Number(change.edit?.version) } : null
  const { wf, card } = await cardOf(ws, n)
  await wf.write(card, null, 'user', (w) => {
    const all = foldLineComments(w.tx.facts(card.id))
    const c = all.find((x) => x.id === id)
    if (!c) throw combworkError(M.noComment)
    if (edit) {
      if (c.version !== edit.version) throw combworkError(M.changed)
      if (c.body !== edit.body) w.fact('LineCommentEdited', { id, body: edit.body, version: c.version + 1 })
    } else if (change === 'resolve') {
      if (c.state === 'open') w.fact('LineCommentResolved', { id })
    } else if (change === 'reopen') {
      if (c.state === 'open') return
      if (all.filter((x) => x.state === 'open').length >= LINE_COMMENT_LIMITS.open) throw combworkError(M.tooMany, { max: LINE_COMMENT_LIMITS.open })
      w.fact('LineCommentReopened', { id })
    } else if (change === 'delete') {
      if (c.sent) throw combworkError(M.sent)
      w.fact('LineCommentDeleted', { id })
    }
  })
  boardChanged(ws)
}

/** What a send's preview shows (HI-3220): its batch id, the card as it saw it, the open comments (each edited since last sent, or not), its builder and an open review. */
export interface FeedbackPreview {
  batch: string
  expect: FeedbackExpect | null
  builder: string | null
  review: { reviewer: string; submission: number } | null
  items: (LineCommentView & { edited: boolean })[]
}

/** Card `n`'s send preview: every comment not resolved, sent before or not, at its version now. */
export function feedbackPreview(ws: WorkspaceService, n: number): FeedbackPreview {
  const facts = cardFacts(ws, n)
  const st = foldCard(facts)
  const items = foldLineComments(facts).filter((c) => c.state === 'open').map((c) => ({ ...c, edited: c.sent && (c.sentVersion ?? 0) < c.version }))
  return { batch: randomUUID(), expect: feedbackExpectOf(st), builder: st.started?.builder ?? null, review: openReviewOf(st), items }
}

/** What the window sends: the preview's batch, the items it showed (each at its version), what it saw, and the review the user confirmed replacing. */
export interface FeedbackSend {
  batch: string
  items: { id: string; version: number }[]
  expect: FeedbackExpect
  replaces?: { reviewer: string; submission: number } | null
}

/** Sends card `n`'s comments to its builder as one fix round (Workflow.feedback), refused as it refuses. */
export async function sendFeedback(ws: WorkspaceService, n: number, a: FeedbackSend): Promise<void> {
  const projectPath = projectPathOf(ws, n)
  const { wf, card } = await cardOf(ws, n)
  const cfg = await ws.projectConfig(projectPath).catch(() => null)
  const platform = platformIdOf(projectPath, cfg?.platform)
  const batch = String(a?.batch ?? '')
  const items = Array.isArray(a?.items) ? a.items.map((it) => ({ id: String(it?.id ?? ''), version: Number(it?.version) })) : []
  // The verdict's comment is the card's comment too, in the same write (as an agent's verdict's is): what the builder's wake
  // names and its read of the card gives.
  let comment = ''
  const { reply } = await runIntent(
    wf,
    n,
    { kind: 'user' },
    (w) =>
      w.feedback(card.key, 'user', {
        batch,
        items,
        expect: a?.expect,
        replaces: a?.replaces ?? null,
        message: (chosen, latest) => (comment = feedbackComment(chosen, { revision: latest.revision ? revisionShort(platform, latest.revision) : '—', card: card.key, batch }))
      }),
    (_w, first) => (first && comment ? { opts: { comment, keepAgent: true } } : {})
  )
  if (isRefusal(reply)) throw new WorkflowRefusedError(reply)
  boardChanged(ws)
}

/** A page of a sent batch's items (HI-3220), each as it was sent; null when card `n` sent no such batch. */
export function feedbackRead(ws: WorkspaceService, n: number, batch: string, offset: number): { submission: number; round: number; items: FeedbackItem[]; next?: number } | null {
  const b = feedbackBatch(cardFacts(ws, n), batch)
  if (!b) return null
  const page = pageOf(b.items, offset)
  return { submission: b.submission, round: b.round, items: page.rows, ...(page.next !== undefined ? { next: page.next } : {}) }
}
