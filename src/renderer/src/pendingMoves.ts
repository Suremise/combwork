// Agent moves shown before they are saved (#1229). A move, a swap or a pane placed is shown at once, then saved; a
// refresh that read the project before the save lands reports the order from before, and the window took each report as
// it came, so the panes and tiles went back until the move's own refresh. While a project's move is being saved, each
// report keeps that project's agents in the order shown (with their state as reported) and its panes' cells as shown:
// the latest move's that wasn't refused. Once the last of them has ended, a report is taken as it comes; if one was
// refused, what was kept meanwhile may not be what was saved, so the window reads the workspace again.
// Relative, as the unit tests (tests/pendingMoves.test.ts) import it, which don't resolve @shared.
import type { ProjectConfig, WorkspaceInfo } from '../../shared/types'

/** What a move shows: the agents' order, and with panes placed, the cells and the layout they are for. */
export interface ShownMove {
  order: string[]
  placement?: ProjectConfig['placement']
  layout?: ProjectConfig['layout']
}

export interface PendingMoves {
  /**
   * A move of the project's agents shown and being saved. Its end takes whether it was saved, and returns whether the
   * window should read the workspace again (the project's last move ended, and one of them was refused).
   */
  begin(path: string, shown: ShownMove): (saved: boolean) => boolean
  /** The workspace as reported, with each project whose move is being saved as the window shows it. */
  keep(ws: WorkspaceInfo | null): WorkspaceInfo | null
}

interface Move {
  shown: ShownMove
  done: boolean
  refused: boolean
}

export function pendingMoves(): PendingMoves {
  // Per project path: its moves being saved, oldest first, until the last has ended.
  const pending = new Map<string, Move[]>()
  return {
    begin(path, shown) {
      const moves = pending.get(path) ?? []
      const move: Move = { shown, done: false, refused: false }
      moves.push(move)
      pending.set(path, moves)
      return (saved) => {
        if (move.done) return false
        move.done = true
        move.refused = !saved
        if (moves.some((m) => !m.done)) return false
        if (pending.get(path) === moves) pending.delete(path)
        return moves.some((m) => m.refused)
      }
    },
    keep(ws) {
      if (!ws || !pending.size) return ws
      return {
        ...ws,
        projects: ws.projects.map((p) => {
          // Moves all refused, the last still ending: as reported.
          const move = pending.get(p.path)?.findLast((m) => !m.refused)?.shown
          if (!move) return p
          // In the order shown; an agent the move didn't know (added meanwhile) after those, as reported.
          const at = new Map(move.order.map((id, i) => [id, i]))
          const agents = p.agents.map((a, i) => ({ a, k: at.get(a.id) ?? move.order.length + i })).sort((x, y) => x.k - y.k).map((x) => x.a)
          const config = move.placement ? { ...p.config, placement: move.placement, ...(move.layout ? { layout: move.layout } : {}) } : p.config
          return { ...p, agents, config }
        })
      }
    }
  }
}

/** This window's moves being saved. */
export const movesShown = pendingMoves()
