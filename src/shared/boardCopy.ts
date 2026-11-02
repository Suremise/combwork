import type { TaskCard, TaskChanges, TaskCursor } from './types'
import { sortCards } from './tasks'

/**
 * A window's copy of the board as main last sent it (HI-1715, `tasks:changes`): the server's cards by number, never
 * changed here (what the window shows is made from them: an optimistic move changes only that), for one workspace, with
 * the cursor to send for the next read (null: the next read is whole).
 */
export interface BoardCopy {
  ws: string
  cursor: TaskCursor | null
  cards: ReadonlyMap<number, TaskCard>
}

/**
 * A read's reply taken into the copy it was asked with (`sent`, null for none): a whole one replaces it, else its cards
 * replace theirs; either way the cards not among its numbers are gone. Null for a stale reply (nothing to take).
 */
export function takeChanges(sent: BoardCopy | null, ws: string, reply: TaskChanges): BoardCopy | null {
  if (reply.stale) return null
  const cards = new Map(reply.full || !sent ? [] : sent.cards)
  for (const c of reply.cards) cards.set(c.number, c)
  const numbers = new Set(reply.numbers)
  for (const n of cards.keys()) if (!numbers.has(n)) cards.delete(n)
  return { ws, cursor: reply.mark === null ? null : { board: reply.board, mark: reply.mark }, cards }
}

/**
 * The board the window shows from a copy: its cards in board order, a reference to a card that is gone left out (a new
 * object for that card, the copy's own untouched), as main leaves them out of a card it reads.
 */
export function shownCards(copy: BoardCopy): TaskCard[] {
  const has = (n: number): boolean => copy.cards.has(n)
  return sortCards(
    [...copy.cards.values()].map((c) => (c.blockedBy.every(has) && c.links.every(has) ? c : { ...c, blockedBy: c.blockedBy.filter(has), links: c.links.filter(has) }))
  )
}
