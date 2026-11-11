import type { LaneCard, TaskColumn } from './types'

/**
 * Progress → Lanes' editable queue (HI-2898): what the window works out from a running lane before it asks main to change
 * it. Main checks every edit again as it saves (laneEdits.ts); this only decides what the window offers.
 */

/** A lane as the queue reads it: its cards, its queued list (null: none) and its cards as main read them. */
export interface QueueLane {
  cards: number[]
  queued: number[] | null
  info: LaneCard[]
}

/** A card as the board has it now, for a card the lane's queued list adds (main read only the lane's own cards). */
export interface BoardCard {
  number: number
  title: string
  column: TaskColumn
  agent?: string | null
}

/** One row of the queue: its card, and whether it is queued (it can be moved or taken off). */
export interface QueueRow {
  card: LaneCard
  queued: boolean
}

/**
 * A lane's revisions this window's own edits took it through, one after another with nothing else between (HI-2932):
 * from `base` (the revision its first such edit named) to `now` (what its last one left).
 */
export interface OwnRun {
  base: number
  now: number
}

/** The run after an edit made here took a lane from `sent` to `after`: the same run when it went on from its end, else a new one. */
export function ownRunAfter(run: OwnRun | undefined, sent: number, after: number): OwnRun {
  return run && run.now === sent ? { base: run.base, now: after } : { base: sent, now: after }
}

/**
 * The revision an edit asked in turn names (HI-2932): the lane's now (`current`) when that is what the user saw, or when
 * only this window's own edits came between (`shown` in the run that ends at `current`); else the one shown, which main
 * refuses as changed meanwhile, as it should: someone else changed the list after the user looked.
 */
export function revisionToName(shown: number, current: number, run: OwnRun | undefined): number {
  if (shown === current) return current
  return run && run.now === current && shown >= run.base && shown < run.now ? current : shown
}

/** Whether a lane's card waits its turn: in To do, and not another agent's (only such cards move, HI-2898). */
export const queuedCard = (c: Pick<LaneCard, 'column' | 'elsewhere'>): boolean => c.column === 'todo' && !c.elsewhere

/**
 * The lane's working list (its queued list when it has one, as the edits change it) as rows, each card as main read it,
 * or, a card only the queued list has, as the board has it now (`builder`: the lane's, for whose it is).
 */
export function queueRows(l: QueueLane, board: ReadonlyMap<number, BoardCard>, builder: string): QueueRow[] {
  return (l.queued ?? l.cards).map((n) => {
    const known = l.info.find((c) => c.number === n)
    const b = board.get(n)
    const card: LaneCard = known ?? { number: n, title: b?.title ?? '', column: b ? b.column : 'gone', blocked: null, round: 1, reviewing: false, ...(b?.agent && b.agent !== builder ? { elsewhere: b.agent } : {}) }
    return { card, queued: queuedCard(card) }
  })
}

/** How many rows at the top keep their places: up to the last that isn't queued (in flight, finished, held, another's). */
export function fixedRows(rows: readonly QueueRow[]): number {
  let fixed = 0
  rows.forEach((r, i) => {
    if (!r.queued) fixed = i + 1
  })
  return fixed
}

/** Where a queued card goes moved up (-1) or down (+1) a place, never into the rows that keep theirs; null: it can't. */
export function nudgedPlace(rows: readonly QueueRow[], card: number, by: -1 | 1): number | null {
  const i = rows.findIndex((r) => r.card.number === card)
  const to = i + by
  if (i < 0 || !rows[i].queued || to < fixedRows(rows) || to >= rows.length) return null
  return to
}

/**
 * Where a card dropped before row `before` (null: after the last) ends up in the list less itself, for a move (`to`), or
 * where a new card goes (`at`); null when it would go among the rows that keep their places, or nowhere new.
 */
export function droppedPlace(rows: readonly QueueRow[], card: number | null, before: number | null): number | null {
  const fixed = fixedRows(rows)
  const list = rows.map((r) => r.card.number)
  const at = before === null ? list.length : list.indexOf(before)
  if (at < 0 || at < fixed) return null
  if (card === null || !list.includes(card)) return at
  const from = list.indexOf(card)
  const to = from < at ? at - 1 : at
  return to === from ? null : to
}
