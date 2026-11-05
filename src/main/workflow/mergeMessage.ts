// The message of the commit Combwork's merge queue makes (§16.9.1, G19: HI-1697): a merge commit's, or a squash's one
// commit's. Combwork's names the card (its key and title) and adds Combwork's trailers; the branch's own is the message its
// commits have, with no card key and no `Combwork-` trailer, for a project that keeps card numbers out of its history. Which
// card a merge was is the queue's `Integrated` fact either way (its result names the commit), never the message.

import type { CommitMessage } from '../../shared/workflow/options'

/** What a merge's message is made from: the card, what was reviewed and merged, and the branch's own messages. */
export interface MergeMessageInputs {
  card: { key: string; title: string }
  /** The reviewed revision, and the queue's update of it when strict brought it up to date (#1352). */
  revision: string
  updated?: string
  /** The reviewers whose passes count for what is merged, joined. */
  reviewers?: string
  /** The branch's commits' messages, oldest first, with no merge commit (the branch's own only). */
  messages: string[]
}

/**
 * A `Combwork-…:` trailer line, as Combwork writes them (and a builder may have copied into a commit of the branch): a
 * commit Combwork makes carries none from its branch. The branch's own commits keep theirs: their history isn't
 * rewritten. A commit's text from before 1.1 is history, and Combwork reads nothing of it (HI-2594): a line in it is
 * kept as written, whatever it says.
 */
const CARD_TRAILER = /^Combwork-[A-Za-z-]+:/

/** A message without Combwork's trailer lines, its runs of blank lines (where they were) made one, trimmed. */
function withoutCardTrailers(m: string): string {
  return m
    .split(/\r?\n/)
    .filter((l) => !CARD_TRAILER.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The branch's own message (G19, the branch's own): one commit's message as it is; several, each one's in turn, oldest
 * first, the first one's subject the commit's subject (as git's own squash message joins them). `Combwork-` trailers left
 * out (a pre-1.1 `Hive-` one is kept as written). A branch with no message of its own (only merges) takes the card's title, with no key.
 */
export function branchMessage(messages: string[], title: string): string {
  const own = messages.map(withoutCardTrailers).filter(Boolean)
  return own.length ? own.join('\n\n') : title.trim()
}

/** The merge's commit message, as the project's Commit message option says (G19; Combwork's by default). */
export function mergeMessage(how: CommitMessage, i: MergeMessageInputs): string {
  if (how === 'branch') return branchMessage(i.messages, i.card.title)
  return `${i.card.key}: ${i.card.title}\n\nCombwork-Card: ${i.card.key}\nCombwork-Revision: ${i.revision}${i.updated ? `\nCombwork-Updated: ${i.updated}` : ''}${i.reviewers ? `\nCombwork-Reviewed-By: ${i.reviewers}` : ''}` // i18n-ignore: a commit message, in English
}

/**
 * The message of strict's merge of the target into the card's revision (G8, #1352), in the queue's folder: Combwork's names
 * the card with its trailers; the branch's own is git's plain one, with no key (it lands in the target's history too).
 */
export function updateMessage(how: CommitMessage, target: string, card: string, revision: string): string {
  if (how === 'branch') return `Merge branch '${target}'` // i18n-ignore: a commit message, as git writes it
  return `Merge ${target} into ${card}\n\nCombwork-Card: ${card}\nCombwork-Revision: ${revision}` // i18n-ignore: a commit message, in English
}
