// How a watching agent's status words its watch in the window (HI-1679): by the cards' keys, in the user's language,
// and, beside the chips of the cards it waits on, shortly. Apart from ui.tsx so a unit test can read it.
import { watchText } from '../../../shared/agentWatch'
import { fmt, msg, tr } from '../../../shared/i18n'
import { columnName } from '../../../shared/tasks'
import type { LiveSessionState, TaskWatchInfo } from '../../../shared/types'

/** A watch as an agent's status words it (HI-1679): watchText's line, its cards by key, in the window's language. */
export const watchStatus = (w: Pick<TaskWatchInfo, 'cards' | 'column' | 'agents' | 'lanes'>): string => watchText(w, tr, (l) => fmt.list(l, 'unit'))

const WAITING_INTO = msg({ id: 'panes.tiles.waitingInto', defaultMessage: 'Waiting → {column}', description: "An agent's status in the focus view's strip while it waits for its card (named by the chip beside it) to move into a board column ({column})." })
const WAITING_CARD = msg({ id: 'panes.tiles.waitingCard', defaultMessage: 'Waiting for its card', description: "An agent's status in the focus view's strip while it waits for its card (named by the chip beside it) to change." })
const WAITING_FOR = msg({ id: 'panes.running.waitingFor', defaultMessage: 'Waiting for', description: "A running agent's status in the Overview's Running now while it waits for several cards to change: the cards' chips follow it (or how many there are, when they don't fit)." })

/**
 * A watching agent waiting on cards, as a row with their chips beside it words it (#1021, HI-1679): "Waiting → Passed",
 * "Waiting for its card" or, for several, "Waiting for", the chips naming the cards. `status`: its whole status
 * (statusText), which the row keeps for its hover. Null when the status says more than the watch (a question, its
 * runtime's own words) or the watch follows lanes or agents: the row shows the whole status.
 */
export function cardsWait(live: Pick<LiveSessionState, 'status' | 'watch'>, status: string): { cards: number[]; line: string } | null {
  const w = live.status === 'watching' ? live.watch : undefined
  if (!w || w.agents?.length || w.lanes?.length || !w.cards.length || status !== watchStatus(w)) return null
  return { cards: w.cards, line: w.column ? tr(WAITING_INTO, { column: columnName(w.column, tr) }) : tr(w.cards.length === 1 ? WAITING_CARD : WAITING_FOR) }
}
