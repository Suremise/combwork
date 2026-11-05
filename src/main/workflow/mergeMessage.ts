// The message of the commit Hive's merge queue makes (§16.9.1, G19: HI-1697): a merge commit's, or a squash's one
// commit's. Hive's names the card (its key and title) and adds Hive's trailers; the branch's own is the message its
// commits have, with no card key and no `Hive-` trailer, for a project that keeps card numbers out of its history. Which
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

/** A `Hive-…:` trailer line, as Hive writes them (and a builder may have copied into a commit of the branch). */
const CW_TRAILER = /^Hive-[A-Za-z-]+:/

/** A message without Hive's trailer lines, its runs of blank lines (where they were) made one, trimmed. */
function withoutHiveTrailers(m: string): string {
  return m
    .split(/\r?\n/)
    .filter((l) => !CW_TRAILER.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The branch's own message (G19, the branch's own): one commit's message as it is; several, each one's in turn, oldest
 * first, the first one's subject the commit's subject (as git's own squash message joins them). `Hive-` trailers left
 * out. A branch with no message of its own (only merges) takes the card's title, with no key.
 */
export function branchMessage(messages: string[], title: string): string {
  const own = messages.map(withoutHiveTrailers).filter(Boolean)
  return own.length ? own.join('\n\n') : title.trim()
}

/** The merge's commit message, as the project's Commit message option says (G19; Hive's by default). */
export function mergeMessage(how: CommitMessage, i: MergeMessageInputs): string {
  if (how === 'branch') return branchMessage(i.messages, i.card.title)
  return `${i.card.key}: ${i.card.title}\n\nHive-Card: ${i.card.key}\nHive-Revision: ${i.revision}${i.updated ? `\nHive-Updated: ${i.updated}` : ''}${i.reviewers ? `\nHive-Reviewed-By: ${i.reviewers}` : ''}` // i18n-ignore: a commit message, in English
}

/**
 * The message of strict's merge of the target into the card's revision (G8, #1352), in the queue's folder: Hive's names
 * the card with its trailers; the branch's own is git's plain one, with no key (it lands in the target's history too).
 */
export function updateMessage(how: CommitMessage, target: string, card: string, revision: string): string {
  if (how === 'branch') return `Merge branch '${target}'` // i18n-ignore: a commit message, as git writes it
  return `Merge ${target} into ${card}\n\nHive-Card: ${card}\nHive-Revision: ${revision}` // i18n-ignore: a commit message, in English
}
