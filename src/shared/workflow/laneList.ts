// A lane's card list, owned by Hive (SPEC §16.11.1): the loop reads its next card from here, not from its brief.
// Changing the list is never refused: while a card is in flight the change is queued and applied at the next card
// boundary. The lane keeps the ruleset in force when it started until it ends (§16.6.5).
//
// Kept in lanes.ts's tables since #1291 (factStore.ts `lane`): one record per lane. #1270 makes it the app's.

export interface LaneList {
  id: string
  cards: number[]
  /** The ruleset in force when the runtime started the lane: its cards, Todo ones included, use it until the lane ends (null: a lane it didn't start, on the current options). */
  ruleset: string | null
  /** A list change made while a card was in flight, applied at the next card boundary. */
  pending: number[] | null
  /** The card in flight (Active, Review, Approved or Merging), if any. */
  current: number | null
  ended: boolean
}

export const newLane = (id: string, cards: number[], ruleset: string): LaneList => ({ id, cards: [...cards], ruleset, pending: null, current: null, ended: false })

/** Changes the list: applied now between cards, queued while one is in flight. Never refused. */
export function changeList(lane: LaneList, cards: number[]): LaneList {
  if (lane.current !== null) return { ...lane, pending: [...cards] }
  return { ...lane, cards: [...cards], pending: null }
}

/**
 * The lane's next card, at a card boundary: the current card is done, so a queued list change applies first, then the
 * first card that isn't done. One card at a time (§16.11.2): nothing while the current card isn't done.
 */
export function nextCard(lane: LaneList, isDone: (card: number) => boolean): { lane: LaneList; card: number | null } {
  if (lane.current !== null && !isDone(lane.current)) return { lane, card: lane.current }
  const cards = lane.pending ?? lane.cards
  const card = cards.find((c) => !isDone(c)) ?? null
  return { lane: { ...lane, cards, pending: null, current: card, ended: card === null }, card }
}
