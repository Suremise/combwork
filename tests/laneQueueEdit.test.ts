// Progress → Lanes' editable queue (HI-2898): the window's working list, which rows keep their places, and where a
// nudge or a drop puts a card. Main checks each edit again; this only decides what the window offers.
import { describe, expect, it } from 'vitest'
import { addedPlace, droppedPlace, fixedRows, newerLanes, nudgedPlace, ownRunAfter, queueRows, revisionToName, type QueueLane } from '../src/shared/laneQueueEdit'
import type { LaneCard } from '../src/shared/types'

const lc = (number: number, column: LaneCard['column'], over: Partial<LaneCard> = {}): LaneCard => ({ number, title: `Card ${number}`, column, blocked: null, round: 1, reviewing: false, ...over })
const lane = (info: LaneCard[], queued: number[] | null = null): QueueLane => ({ cards: info.map((c) => c.number), queued, info })

describe('queueRows', () => {
  it('reads the queued list when there is one, a card only it has from the board', () => {
    const l = lane([lc(1, 'doing'), lc(2, 'todo')], [1, 3, 2])
    const board = new Map([[3, { number: 3, title: 'New', column: 'todo' as const, agent: 'b9' }]])
    const rows = queueRows(l, board, 'b1')
    expect(rows.map((r) => r.card.number)).toEqual([1, 3, 2])
    // Card 3 is another agent's: it doesn't count as queued.
    expect(rows.map((r) => r.queued)).toEqual([false, false, true])
    expect(queueRows(lane([lc(1, 'doing')], [1, 4]), new Map(), 'b1')[1].card.column).toBe('gone')
  })
})

describe('fixedRows, nudgedPlace, droppedPlace', () => {
  const rows = queueRows(lane([lc(1, 'done'), lc(2, 'doing'), lc(3, 'todo'), lc(4, 'todo'), lc(5, 'todo', { elsewhere: 'b9' }), lc(6, 'todo')]), new Map(), 'b1')

  it('keeps every row up to the last that is not queued', () => {
    expect(fixedRows(rows)).toBe(5)
    expect(fixedRows(queueRows(lane([lc(1, 'todo'), lc(2, 'todo')]), new Map(), 'b1'))).toBe(0)
  })

  it('nudges a queued card a place, never into the fixed rows or past the end', () => {
    const free = queueRows(lane([lc(1, 'doing'), lc(2, 'todo'), lc(3, 'todo')]), new Map(), 'b1')
    expect(nudgedPlace(free, 3, -1)).toBe(1)
    expect(nudgedPlace(free, 2, -1)).toBeNull()
    expect(nudgedPlace(free, 3, 1)).toBeNull()
    expect(nudgedPlace(free, 1, 1)).toBeNull()
    expect(nudgedPlace(rows, 6, -1)).toBeNull()
  })

  it('places a drop before a row, or last, never among the fixed rows or where it already is', () => {
    const free = queueRows(lane([lc(1, 'doing'), lc(2, 'todo'), lc(3, 'todo'), lc(4, 'todo')]), new Map(), 'b1')
    // A move: where it ends up in the list less itself.
    expect(droppedPlace(free, 4, 2)).toBe(1)
    expect(droppedPlace(free, 2, null)).toBe(3)
    expect(droppedPlace(free, 2, 3)).toBeNull()
    expect(droppedPlace(free, 3, 1)).toBeNull()
    // A new card: where it goes in.
    expect(droppedPlace(free, null, 2)).toBe(1)
    expect(droppedPlace(free, null, null)).toBe(4)
    expect(droppedPlace(free, 99, 2)).toBe(1)
  })
})

describe('the revision an edit asked in turn names (HI-2932)', () => {
  it('two quick edits on the list shown: the second names what the first left', () => {
    // Both asked on revision 5; the first made here took it to 6.
    const run = ownRunAfter(undefined, 5, 6)
    expect(run).toEqual({ base: 5, now: 6 })
    expect(revisionToName(5, 6, run)).toBe(6)
    // A third, still on 5: the run goes on unbroken (6 → 7), so it names 7.
    const on = ownRunAfter(run, 6, 7)
    expect(on).toEqual({ base: 5, now: 7 })
    expect(revisionToName(5, 7, on)).toBe(7)
    expect(revisionToName(6, 7, on)).toBe(7)
  })

  it("someone else's change between: the one shown, which main refuses as changed meanwhile", () => {
    const run = ownRunAfter(undefined, 5, 6)
    // Another window or an agent moved it on to 7 after this window's edit.
    expect(revisionToName(5, 7, run)).toBe(5)
    expect(revisionToName(6, 7, run)).toBe(6)
    // Changed before the user looked at revision 4: never taken for ours.
    expect(revisionToName(4, 6, run)).toBe(4)
    // No edit made here: the one shown.
    expect(revisionToName(5, 6, undefined)).toBe(5)
    expect(revisionToName(6, 6, undefined)).toBe(6)
  })

  it("two quick drops from the board before the same card keep their order: each placed when its turn comes (HR1's round 1)", () => {
    // A in flight (fixed), then X and Y; C and D both dropped before X while C's edit is under way.
    const at0 = lane([lc(1, 'doing'), lc(20, 'todo'), lc(21, 'todo')])
    const c = addedPlace(queueRows(at0, new Map(), 'b1'), 20)
    expect(c).toEqual({ at: 1 })
    // C made: the rows D's turn reads.
    const at1 = lane([lc(1, 'doing'), lc(30, 'todo'), lc(20, 'todo'), lc(21, 'todo')])
    expect(addedPlace(queueRows(at1, new Map(), 'b1'), 20)).toEqual({ at: 2 })
    // Last, or no place given: no `at` (main adds it last); before a fixed card: last too.
    expect(addedPlace(queueRows(at1, new Map(), 'b1'), null)).toEqual({ at: 4 })
    expect(addedPlace(queueRows(at1, new Map(), 'b1'), undefined)).toEqual({})
    expect(addedPlace(queueRows(at1, new Map(), 'b1'), 1)).toEqual({})
  })

  it('a read of the lanes landing after a newer one never takes a lane back to an older revision', () => {
    const held = [{ id: 'A', listRev: 1, cards: ['a1'] }, { id: 'B', listRev: 1, cards: ['b1'] }]
    const older = [{ id: 'A', listRev: 1, cards: ['a1'] }, { id: 'B', listRev: 0, cards: ['b0'] }, { id: 'C', listRev: 0, cards: [] }]
    const merged = newerLanes(held, older)
    expect(merged.map((l) => [l.id, l.listRev])).toEqual([['A', 1], ['B', 1], ['C', 0]])
    expect(merged[1]).toBe(held[1])
    // A lane the read no longer lists is gone; a newer read wins.
    expect(newerLanes(held, [{ id: 'B', listRev: 2, cards: ['b2'] }])).toEqual([{ id: 'B', listRev: 2, cards: ['b2'] }])
  })

  it('a run broken by another change starts again from the edit that followed it', () => {
    const run = ownRunAfter({ base: 5, now: 6 }, 8, 9)
    expect(run).toEqual({ base: 8, now: 9 })
    expect(revisionToName(6, 9, run)).toBe(6)
    expect(revisionToName(8, 9, run)).toBe(9)
  })
})
