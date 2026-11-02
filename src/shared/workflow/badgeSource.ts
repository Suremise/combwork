import { serialReads } from '../coalesce'
import type { WorkBadge } from './workView'

/** What the window shows of the work badges: the workspace they are of, by card. */
export interface ShownBadges {
  ws: string
  badges: Map<number, WorkBadge>
}

export const NO_BADGES = new Map<number, WorkBadge>()

/**
 * The window's one source of work badges (#1629: each view read them for itself, four or five reads of every board
 * change), `fetch` reading them for a workspace. `ask(ws, why)`: read again for these reasons (the board, a project's
 * workflow, the projects); the same reasons asked by another view ask nothing more. One read at a time (serialReads):
 * a read for a workspace the window has left is dropped. A badge that didn't change keeps its object, and what is shown
 * stays the same when none did, so views showing them don't redraw.
 */
export function makeBadgeSource(fetch: (ws: string) => Promise<WorkBadge[]>): { ask: (ws: string, why: readonly unknown[]) => void; subscribe: (l: () => void) => () => void; get: () => ShownBadges } {
  let shown: ShownBadges = { ws: '', badges: NO_BADGES }
  const listeners = new Set<() => void>()
  let asked: { ws: string; why: readonly unknown[] } | null = null
  const take = (ws: string, list: WorkBadge[]): void => {
    const before = shown.ws === ws ? shown.badges : NO_BADGES
    let same = shown.ws === ws && before.size === list.length
    const next = new Map<number, WorkBadge>()
    for (const b of list) {
      const had = before.get(b.card)
      const keep = had && JSON.stringify(had) === JSON.stringify(b)
      if (!keep) same = false
      next.set(b.card, keep ? had : b)
    }
    if (same) return
    shown = { ws, badges: next }
    for (const l of listeners) l()
  }
  const reads = serialReads(fetch, take)
  return {
    ask(ws, why) {
      if (asked && asked.ws === ws && asked.why.length === why.length && asked.why.every((x, i) => x === why[i])) return
      asked = { ws, why }
      reads.ask(ws)
    },
    subscribe(l) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    get: () => shown
  }
}
