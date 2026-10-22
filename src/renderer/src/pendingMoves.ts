// Agent moves shown before they are saved (#1229). A move, a swap or a pane placed is shown at once, then saved; a
// refresh that read the project before the save lands reports the order from before, and the window took each report as
// it came, so the panes and tiles went back until the move's own refresh. While a project's move is being saved, each
// report keeps that project's agents in the order shown (with their state as reported) and its panes' cells as shown.
// Relative, as the unit tests (tests/pendingMoves.test.ts) import it, which don't resolve @shared.
import type { ProjectConfig, WorkspaceInfo } from '../../shared/types'

/** What a move shows: the agents' order, and with panes placed, the cells and the layout they are for. */
export interface ShownMove {
  order: string[]
  placement?: ProjectConfig['placement']
  layout?: ProjectConfig['layout']
}

export interface PendingMoves {
  /** A move of the project's agents shown and being saved: ended by the function it returns, once saved or refused. */
  begin(path: string, shown: ShownMove): () => void
  /** The workspace as reported, with each project whose move is being saved as the window shows it. */
  keep(ws: WorkspaceInfo | null): WorkspaceInfo | null
}

export function pendingMoves(): PendingMoves {
  // Per project path: the moves being saved, and what the latest of them shows.
  const pending = new Map<string, { count: number; shown: ShownMove }>()
  return {
    begin(path, shown) {
      const now = pending.get(path)
      pending.set(path, { count: (now?.count ?? 0) + 1, shown })
      let ended = false
      return () => {
        if (ended) return
        ended = true
        const p = pending.get(path)
        if (!p) return
        if (p.count > 1) p.count--
        else pending.delete(path)
      }
    },
    keep(ws) {
      if (!ws || !pending.size) return ws
      return {
        ...ws,
        projects: ws.projects.map((p) => {
          const move = pending.get(p.path)
          if (!move) return p
          // In the order shown; an agent the move didn't know (added meanwhile) after those, as reported.
          const at = new Map(move.shown.order.map((id, i) => [id, i]))
          const agents = p.agents.map((a, i) => ({ a, k: at.get(a.id) ?? move.shown.order.length + i })).sort((x, y) => x.k - y.k).map((x) => x.a)
          const config = move.shown.placement ? { ...p.config, placement: move.shown.placement, ...(move.shown.layout ? { layout: move.shown.layout } : {}) } : p.config
          return { ...p, agents, config }
        })
      }
    }
  }
}

/** This window's moves being saved. */
export const movesShown = pendingMoves()
