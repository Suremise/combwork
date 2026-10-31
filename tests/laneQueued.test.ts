// A lane's queued list change in Progress → Lanes (HI-2151): what it adds, takes off, moves to another lane or reorders,
// after which card, in a line; none once applied (no queued list) or when it changes nothing.
import { describe, expect, it } from 'vitest'
import { queuedChange, queuedChangeText, type QueuedLane } from '../src/shared/laneBar'
import { fmt, tr } from '../src/shared/i18n'
import type { TaskColumn } from '../src/shared/types'

const lane = (id: string, builder: string, cards: number[], queued: number[] | null, columns: TaskColumn[] = [], over: Partial<QueuedLane> = {}): QueuedLane => ({
  id,
  state: 'active',
  builder: { name: builder },
  cards,
  info: cards.map((number, i) => ({ number, column: columns[i] ?? 'todo' })),
  queued,
  status: null,
  ...over
})
const name = (n: number): string => `HI-${n}`
const text = (l: QueuedLane, all: QueuedLane[] = [l]): string | null => {
  const c = queuedChange(l, all)
  return c ? queuedChangeText(c, name, tr, fmt.list) : null
}

describe('queuedChange', () => {
  it('is none without a queued list (or once it applied), on an ended lane, or when it changes nothing', () => {
    expect(queuedChange(lane('a', 'HB3', [1, 2], null), [])).toBeNull()
    expect(queuedChange(lane('a', 'HB3', [1, 2], [1, 3], ['doing'], { state: 'ended' }), [])).toBeNull()
    expect(queuedChange(lane('a', 'HB3', [1, 2], [1, 2], ['doing']), [])).toBeNull()
  })

  it('names the cards added after the card in flight', () => {
    const l = lane('a', 'HB3', [2148], [2148, 2149], ['review'])
    expect(queuedChange(l, [l])).toEqual({ after: 2148, added: [2149], removed: [], order: null })
    expect(text(l)).toBe('Next, once HI-2148 is Done: HI-2149 added')
  })

  it('takes the card from its status when it says the list changes after it', () => {
    const l = lane('a', 'HB3', [5, 6], [5, 6, 7], ['done', 'passed'], { status: { reason: 'listChanges', card: 6 } })
    expect(queuedChange(l, [l])?.after).toBe(6)
    // Its own card in flight otherwise: never one held elsewhere.
    const held = lane('a', 'HB3', [5, 6], [5, 6, 7], ['doing', 'doing'])
    held.info = [{ number: 5, column: 'doing', elsewhere: 'x' }, { number: 6, column: 'doing' }]
    expect(queuedChange(held, [held])?.after).toBe(6)
    expect(text(lane('a', 'HB3', [5], [5, 7]))).toBe('Next: HI-7 added')
  })

  it('says where a card taken off goes: another running lane that lists it, or will', () => {
    const l = lane('a', 'HB3', [2148, 2121, 2122], [2148], ['doing'])
    const hb6 = lane('b', 'HB6', [2200], [2200, 2121], ['doing'])
    const ended = lane('c', 'HB1', [2122], null, ['done'], { state: 'ended' })
    expect(queuedChange(l, [l, hb6, ended])).toEqual({ after: 2148, added: [], removed: [{ card: 2121, to: 'HB6' }, { card: 2122, to: null }], order: null })
    expect(text(l, [l, hb6, ended])).toBe('Next, once HI-2148 is Done: HI-2122 taken off, HI-2121 moves to HB6’s lane')
  })

  it("reads another lane's queued list over its cards: one that drops the card isn't where it goes (HR1's round 1)", () => {
    const a = lane('a', 'HB3', [1, 2], [1], ['doing'])
    const b = lane('b', 'HB6', [3, 2], [3], ['doing'])
    expect(queuedChange(a, [a, b])?.removed).toEqual([{ card: 2, to: null }])
    expect(text(a, [a, b])).toBe('Next, once HI-1 is Done: HI-2 taken off')
    // B drops it and C will take it: C is where it goes.
    const c = lane('c', 'HB7', [4], [4, 2], ['doing'])
    expect(queuedChange(a, [a, b, c])?.removed).toEqual([{ card: 2, to: 'HB7' }])
  })

  it('gives the whole new order when the cards it keeps change places', () => {
    const l = lane('a', 'HB3', [1, 2, 3], [1, 3, 2, 4], ['doing'])
    expect(queuedChange(l, [l])).toEqual({ after: 1, added: [4], removed: [], order: [1, 3, 2, 4] })
    expect(text(l)).toBe('Next, once HI-1 is Done: HI-4 added, new order: HI-1, HI-3, HI-2, HI-4')
    // Added cards alone keep the order of the rest.
    expect(queuedChange(lane('a', 'HB3', [1, 2], [4, 1, 2], ['doing']), [])?.order).toBeNull()
  })

  it('joins several cards of a kind', () => {
    expect(text(lane('a', 'HB3', [1, 8, 9], [1, 2, 3], ['doing']))).toBe('Next, once HI-1 is Done: HI-2 and HI-3 added, HI-8 and HI-9 taken off')
  })
})
