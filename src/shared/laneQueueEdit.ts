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

/**
 * Where a card added before another (`before`: its number; null: last) goes in the rows as they are now (HI-2932, HR1's
 * round 1: worked out when the edit's turn comes, as a move's is, so two quick drops keep their order); none given, or
 * not a place there: last (no `at`).
 */
export function addedPlace(rows: readonly QueueRow[], before: number | null | undefined): { at?: number } {
  if (before === undefined) return {}
  const at = droppedPlace(rows, null, before)
  return at === null ? {} : { at }
}

/**
 * The lanes a read of them brings (`fresh`: which lanes there are, in its order), each kept as `held` has it when that
 * is at a later list revision (HI-2932, HR1's round 1): a lane's revision only goes up, so the one at the higher
 * revision was read later, and an older read landing last never takes a lane back.
 */
export function newerLanes<L extends { id: string; listRev?: number }>(held: readonly L[], fresh: readonly L[]): L[] {
  const had = new Map(held.map((l) => [l.id, l]))
  return fresh.map((l) => {
    const h = had.get(l.id)
    return h && (h.listRev ?? 0) > (l.listRev ?? 0) ? h : l
  })
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

/**
 * Where the focus goes after an edit asked from a lane's rows (HI-3068), never before that edit shows, nor for anyone
 * else's change. Only the latest intent counts; one whose edit wasn't made (refused, or nothing to do) is dropped by its
 * own id, so no later update acts on it.
 * - A card taken off (`off`): the focused row is gone once the card's row is, whoever took it off, so the focus moves
 *   then, in that render (HI-3020: never left on the page's body), to `to` (the next card's row, or the lane's own row).
 *   An update that leaves the card's row there, another's reorder or insertion, leaves it waiting.
 * - A card moved (`move`): its row drawn again may lose the focus, so it is put back on the card's row, but only for
 *   this edit made (HR1's round 2: a list index changed by someone else's insertion is no proof): at the answer, if the
 *   lane is drawn with the card where this move put it (`aim`); else at the next drawing, which the window's read of the
 *   lanes before the answer (laneEdits' reload) makes one of its result or later.
 */
export class QueueFocus {
  private intent: { id: number; kind: 'off' | 'move'; card: number; to: number | 'lane'; want: number | null; made: boolean } | null = null
  private seq = 0
  private seen: readonly number[] | null = null

  /** An edit asked of `card` (`to`: where the focus goes when it is taken off); returns its id. */
  ask(kind: 'off' | 'move', card: number, to: number | 'lane' = card): number {
    this.intent = { id: ++this.seq, kind, card, to, want: null, made: false }
    return this.seq
  }

  /** Where move `id` puts its card, as its edit is made from the rows when its turn comes. */
  aim(id: number, want: number): void {
    if (this.intent?.id === id) this.intent.want = want
  }

  /**
   * Edit `id` answered. Not made: its intent goes (if still the latest). A move made: the card to focus now if the lane
   * is drawn with it in its new place already, else null and the next drawing does.
   */
  settled(id: number, made: boolean): number | null {
    const i = this.intent
    if (!i || i.id !== id) return null
    if (!made) {
      this.intent = null
      return null
    }
    if (i.kind === 'off') return null
    i.made = true
    if (this.seen && i.want !== null && this.seen.indexOf(i.card) === i.want) {
      this.intent = null
      return i.card
    }
    return null
  }

  /** The lane drawn with `list`: the row (a card) or the lane ('lane') to focus now, or null. */
  due(list: readonly number[]): number | 'lane' | null {
    this.seen = list
    const i = this.intent
    if (!i) return null
    if (i.kind === 'off') {
      if (list.includes(i.card)) return null
      this.intent = null
      return i.to !== 'lane' && list.includes(i.to) ? i.to : 'lane'
    }
    if (!i.made) return null
    this.intent = null
    return list.includes(i.card) ? i.card : null
  }
}
