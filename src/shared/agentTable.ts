import { agentDoingCards, agentReviewCards } from './tasks'
import { cardLabel } from './projectKeys'
import type { LaneState, TaskCard, TaskWatchInfo } from './types'

/**
 * A project's agents as a table (#529: the project tile's tooltip, the sidebar's agent count and the project header's
 * status): what goes in each row comes from the renderer; the order and the "Waiting for" cell are here.
 */

/** What the table needs of a lane: its state and its pair, by agent id. */
export interface TableLane {
  state: LaneState
  builder: { agentId: string }
  reviewer: { agentId: string } | null
}

/**
 * The agents in the table's order: each running lane's builder then its reviewer (in the lanes' order, as the Progress
 * panel shows them; paused lanes count, ended ones don't), then everyone else in the project's order. An agent in two
 * lanes goes with the first.
 */
export function laneOrder<T extends { id: string }>(agents: readonly T[], lanes: readonly TableLane[]): T[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const out: T[] = []
  const placed = new Set<string>()
  const put = (id: string | undefined): void => {
    const a = id === undefined ? undefined : byId.get(id)
    if (a && !placed.has(a.id)) {
      placed.add(a.id)
      out.push(a)
    }
  }
  for (const l of lanes) {
    if (l.state !== 'active' && l.state !== 'paused') continue
    put(l.builder.agentId)
    put(l.reviewer?.agentId)
  }
  for (const a of agents) put(a.id)
  return out
}

/** "HI-4 Attention inbox" (#4 for a card with no key; +1 when there are more), for a tooltip, a table's cell or a status line; empty for none. */
export function cardsText(cards: readonly Pick<TaskCard, 'number' | 'key' | 'title'>[]): string {
  if (!cards.length) return ''
  return `${cardLabel(cards[0])} ${cards[0].title}${cards.length > 1 ? ` +${cards.length - 1}` : ''}`
}

/**
 * An agent's Card cell: the card it works on (in Doing), else the one it reviews ("reviewing #12 …"); empty for none.
 * `project` is the project's name, as the board has it.
 */
export function agentCardText(cards: readonly TaskCard[], project: string, agentId: string): string {
  const doing = cardsText(agentDoingCards(cards, project, agentId))
  if (doing) return doing
  const reviewing = cardsText(agentReviewCards(cards, project, agentId))
  return reviewing ? `reviewing ${reviewing}` : ''
}

/** A column as an agents table's plain text says it (#572): its cell in words ("card #12 …"); none for a state or a sentence. */
export interface TextColumn {
  cell?: (text: string) => string
}

/** A row of an agents table, or a heading across it, as its plain text needs them. */
export type TextRow = { name: string; cells: readonly { text: string }[] } | { groupText: string }

/**
 * An agents table as plain text (#572), for screen readers and a confirm's copy: a line an agent with every cell the
 * table shows, in its order ("• B1 — Working… · card #12 Lanes · worktree hive/b1 · Stopped (will be interrupted),
 * then a new session"; an empty cell left out), and a heading's line ("workspace-a:") over its agents.
 */
export function agentRowsText(columns: readonly TextColumn[], rows: readonly TextRow[]): string {
  return rows
    .map((r) => {
      if ('groupText' in r) return `${r.groupText}:`
      const cells = columns.flatMap((c, i) => (r.cells[i]?.text ? [c.cell ? c.cell(r.cells[i].text) : r.cells[i].text] : []))
      return `• ${r.name}${cells.length ? ` — ${cells.join(' · ')}` : ''}`
    })
    .join('\n')
}

/** A watching agent's "Waiting for" cell: its watch's label without the words ("#506, #509 → Review", "B6 to finish"). */
export function waitingFor(watch: Pick<TaskWatchInfo, 'label'> | undefined): string {
  return watch ? watch.label.replace(/^Waiting for\s+/i, '') : ''
}
