// HI-3219: the user's line comments on a card's revision diff, written as card facts (shared/workflow/lineComments.ts). The
// quote and its context are read here from the submission's commits (revisionDiff.ts), never taken from the window, and
// cut to their limits; each change is checked in the write's own transaction against the card's facts as they are then.
// The window tells the board once a write is done (boardChanged), so the card's work is read again.

import { boardChanged } from '../boardStore'
import { combworkError } from '../combworkError'
import type { WorkspaceService } from '../workspace'
import { msg } from '../../shared/i18n'
import { anchorOf, foldLineComments, LINE_COMMENT_LIMITS, type LineCommentView, type LineSide } from '../../shared/workflow/lineComments'
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
