// HI-3220: the words of a send of line comments to a card's builder. The window's refusals are messages (the user's
// language); what reaches the builder (the failed verdict's comment) is agent text, in English. The comment lists the
// comments sent, each with its lines quoted, for as many as fit in FEEDBACK_COMMENT_BUDGET characters, and names the batch
// read for the rest: nothing sent is ever only in a cut comment.

import { msg } from '../../shared/i18n'
import { agentMsg, say } from '../../shared/agentText'
import type { LineCommentView } from '../../shared/workflow/lineComments'

/** The window's refusals of a send. */
export const FEEDBACK_REFUSED = {
  notHere: msg({ id: 'board.work.send.notHere', defaultMessage: 'Comments can be sent to the builder from Review or Approved only.', description: "Sending a card's line comments to its builder was refused: the card is in another column (Doing, Todo, Done…). Glossary: builder." }),
  integrated: msg({ id: 'board.work.send.integrated', defaultMessage: 'This card’s work is merged already: its comments can’t go back to the builder.', description: "Sending a card's line comments to its builder was refused: the card's work has been merged into its target already." }),
  changed: msg({ id: 'board.work.send.changed', defaultMessage: 'The card changed since you opened this: look again.', description: "Sending a card's line comments to its builder was refused: since the preview opened, the card got a new submission, a new decision, or a reviewer started or ended a review." }),
  noBuilder: msg({ id: 'board.work.send.noBuilder', defaultMessage: 'This card has no builder to send its comments to.', description: "Sending a card's line comments was refused: no agent built the card's work (it has no builder). Glossary: builder." }),
  alreadySent: msg({ id: 'board.work.send.alreadySent', defaultMessage: 'These comments were sent already.', description: "Sending a card's line comments was refused: this very send was made already (a second click, or a retry)." }),
  itemsChanged: msg({ id: 'board.work.send.itemsChanged', defaultMessage: 'A comment changed since you opened this (edited, resolved or deleted): look again.', description: "Sending a card's line comments was refused: one of the comments in the preview was edited, resolved or deleted since it opened." }),
  nothing: msg({ id: 'board.work.send.nothing', defaultMessage: 'There are no open comments to send.', description: "Sending a card's line comments was refused: none of its comments is open." }),
  reviewing: msg({ id: 'board.work.send.reviewing', defaultMessage: '{reviewer} is reviewing this card: confirm replacing its review to send your comments.', description: "Sending a card's line comments was refused: a reviewer agent ({reviewer}, its name) is reviewing the card, and the send replaces that review only once the user confirms it." })
}

/** What the builder reads: its words (agent text). */
const T = {
  header: agentMsg({ id: 'feedback.header', text: '{n, plural, one {# line comment} other {# line comments}} from the user, each on the revision it names:', note: "HI-3220: the first line of the failed verdict a send of the user's line comments writes, read by the card's builder. A comment left open goes again later, still on the revision it was made on, so each names its own." }),
  item: agentMsg({ id: 'feedback.item', text: '[{id}] {path}:{lines} ({side, select, old {removed lines} other {new}}) on {revision}', note: "HI-3220: each line comment's heading in the failed verdict sent to the builder: its id, file, line or lines (12 or 12-14) as they are in its own revision, its side (lines removed, in the base, or the revision's), and that revision (short). Keep the select keys." }),
  more: agentMsg({ id: 'feedback.more', text: 'And {m} more: cw_read_task with number {card}, feedback "{batch}" and offset {offset}.', note: "HI-3220: the failed verdict's last line when not every comment sent fits in it: how many more there are, and the batch read that gives them all (the card, the send's batch id, where to start)." })
}

/** The most characters of the comments' items in the verdict's comment (HI-3191's design s17). */
export const FEEDBACK_COMMENT_BUDGET = 18000

/** The failed verdict's comment for a send: the header, then each comment as fits, then the batch read for the rest. */
export function feedbackComment(items: readonly LineCommentView[], o: { revisionOf: (submission: number) => string; card: string; batch: string }): string {
  const head = say(T.header, { n: items.length })
  const parts: string[] = []
  let used = 0
  for (const c of items) {
    const quote = c.lines.split('\n').map((l) => `> ${l}`).join('\n')
    const part = `${say(T.item, { id: c.id, path: c.path, lines: c.from === c.to ? String(c.from) : `${c.from}-${c.to}`, side: c.side, revision: o.revisionOf(c.submission) })}\n${quote}\n${c.body}`
    if (used + part.length + 2 > FEEDBACK_COMMENT_BUDGET) break
    parts.push(part)
    used += part.length + 2
  }
  const left = items.length - parts.length
  return [head, ...parts, ...(left ? [say(T.more, { m: left, card: o.card, batch: o.batch, offset: parts.length })] : [])].join('\n\n')
}
