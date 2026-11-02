// A watching agent's status in the window (HI-1679): its watch's cards by key (the board's names, cardRef), never the
// workspace-wide number its English `label` may carry, and the short line beside the chip of the one card it waits on.
import { describe, expect, it } from 'vitest'
import { namedBy } from '../src/shared/projectKeys'
import { cardsWait, watchStatus } from '../src/renderer/src/components/watchLine'
import type { TaskWatchInfo } from '../src/shared/types'

// The board's names: HI-1673 is the workspace's #1675, so a number shown is another card's.
const KEYS: Record<number, string> = { 1168: 'HI-1168', 1675: 'HI-1673', 12: 'AMPS-12' }
const keyed = (n: number): string => KEYS[n] ?? `#${n}`
const watch = (over: Partial<TaskWatchInfo>): TaskWatchInfo => ({ cards: [], label: 'Waiting for #1168', limitAt: '2026-10-26T12:00:00.000Z', ...over }) as TaskWatchInfo

describe("a watching agent's status names its cards by key (HI-1679)", () => {
  it('a card watch, into a column or not, one card or several', () => {
    namedBy(keyed, () => {
      expect(watchStatus(watch({ cards: [1168], column: 'passed' }))).toBe('Waiting for HI-1168 → Approved')
      expect(watchStatus(watch({ cards: [1675], column: 'review' }))).toBe('Waiting for HI-1673 → Review')
      expect(watchStatus(watch({ cards: [1168, 12] }))).toBe('Waiting for HI-1168, AMPS-12')
    })
  })

  it('a lane watch keeps the cards it also follows by key; an agent watch names its agents', () => {
    namedBy(keyed, () => {
      expect(watchStatus(watch({ cards: [1168], lanes: ['lane-e1d9ff'] }))).toBe('Waiting on lane lane-e1d9ff and HI-1168')
      expect(watchStatus(watch({ agents: ['HB4', 'HR4'] }))).toBe('Waiting for HB4, HR4 to finish')
    })
  })

  it('a card the board has no key for keeps its number', () => {
    namedBy(keyed, () => expect(watchStatus(watch({ cards: [99], column: 'done' }))).toBe('Waiting for #99 → Done'))
  })

  it('waiting on cards, beside their chips: the short line and the cards; a lane, agents or more said, the whole status', () => {
    namedBy(keyed, () => {
      const one = watch({ cards: [1168], column: 'passed' })
      const status = watchStatus(one)
      expect(cardsWait({ status: 'watching', watch: one }, status)).toEqual({ cards: [1168], line: 'Waiting → Approved' })
      expect(cardsWait({ status: 'watching', watch: watch({ cards: [1168] }) }, 'Waiting for HI-1168')).toEqual({ cards: [1168], line: 'Waiting for its card' })
      // Several (the Assistant on HI-1679: a chip each, never a key cut in the text): the same short line, or "Waiting for".
      const two = watch({ cards: [1168, 12], column: 'review' })
      expect(cardsWait({ status: 'watching', watch: two }, watchStatus(two))).toEqual({ cards: [1168, 12], line: 'Waiting → Review' })
      const both = watch({ cards: [1168, 12] })
      expect(cardsWait({ status: 'watching', watch: both }, watchStatus(both))).toEqual({ cards: [1168, 12], line: 'Waiting for' })
      // Its status says more (a question it works on beside the watch): the row shows all of it.
      expect(cardsWait({ status: 'watching', watch: one }, `${status} · has a question for you`)).toBeNull()
      const lane = watch({ cards: [1168], lanes: ['lane-e1d9ff'] })
      expect(cardsWait({ status: 'watching', watch: lane }, watchStatus(lane))).toBeNull()
      const agents = watch({ agents: ['HB4'] })
      expect(cardsWait({ status: 'watching', watch: agents }, watchStatus(agents))).toBeNull()
      expect(cardsWait({ status: 'working', watch: one }, 'Working…')).toBeNull()
    })
  })
})
