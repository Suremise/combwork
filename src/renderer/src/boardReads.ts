import { shownCards, takeChanges, type BoardCopy } from '../../shared/boardCopy'
import type { TaskCard, TaskChanges, TaskCursor } from '../../shared/types'

/** What a board read asks main: the whole board (archived cards in full), or what changed since a cursor (HI-1715). */
export interface BoardAsks {
  list(): Promise<TaskCard[]>
  changes(since: TaskCursor | null): Promise<TaskChanges>
}

/** A read begun: its request, and what to make of its reply once it comes (`take`). */
export interface BoardRead {
  request: Promise<TaskCard[] | TaskChanges>
  /**
   * The cards to show from its reply, given the window as it is now: null when the reply isn't for it any more (another
   * workspace, the other mode, another copy since), `again` for a stale one (read again).
   */
  take(reply: TaskCard[] | TaskChanges, now: { ws: string | null; whole: boolean }): TaskCard[] | 'again' | null
}

/**
 * The window's board reads (store.ts readTasks, HI-1715). It keeps the board as main last sent it (BoardCopy) and asks for
 * what changed since; `whole` (the Archived view or an archived card's dialog open: the archived cards in full) reads the
 * whole board and keeps no copy. A reply is taken only into the copy it was asked from, in the mode it was asked in, for
 * the workspace still shown: a whole one replaces the copy, a delta merges into it, and only a reply taken moves its
 * cursor on. What is shown is made from the copy each time, so a card shown moved before main agreed (Board's optimistic
 * move) is the server's again after the next read.
 */
export function boardReader(asks: BoardAsks): { begin(ws: string, whole: boolean): BoardRead; clear(): void } {
  let copy: BoardCopy | null = null
  return {
    begin(ws, whole) {
      if (whole) copy = null
      const sent = !whole && copy?.ws === ws ? copy : null
      return {
        request: whole ? asks.list() : asks.changes(sent?.cursor ?? null),
        take(reply, now) {
          if (now.ws !== ws) return null
          if (Array.isArray(reply)) return whole && now.whole ? reply : null
          if (whole || now.whole || (copy?.ws === ws ? copy : null) !== sent) return null
          const next = takeChanges(sent, ws, reply)
          if (!next) return 'again'
          copy = next
          return shownCards(next)
        }
      }
    },
    clear() {
      copy = null
    }
  }
}
