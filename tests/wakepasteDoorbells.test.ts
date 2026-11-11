// HI-2875: wakepaste-copilot's put-off round took the held doorbell's id from what the screen showed that a snapshot
// didn't. Copilot redraws its whole conversation as its pane narrows, so a snapshot taken during that redraw missed an
// earlier doorbell (m3, in its history): the round took m3 for the held one and waited for history to leave the
// screen, failing at its bound with the input empty and m4 long taken back (rc.3, run-20261110-041049). The held id now
// comes from Combwork's deliveries (tests/e2e/wakepaste-cli/doorbells.cjs).
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { doorbellIds, newDelivery } = require('./e2e/wakepaste-cli/doorbells.cjs') as {
  doorbellIds: (text: string) => string[]
  newDelivery: (before: readonly string[], rows: readonly { id: string }[] | undefined) => string | null
}

/** A doorbell in Copilot's history in a narrow pane, as rc.3's screen drew it: wrapped, its time and border in its first row. */
const asked = (id: string): string => [` ❯ [CW] New in your inbox: 1 04:13 ┃`, `   message (${id}). Call              ┃`, `   cw_inbox to read it, act        ┃`, `   on it, then ack it.             ┃`, ``, ` ● cw_inbox (MCP: combw… Acked ${id}. ┃`, ` ● Done.                           ┃`, ``].join('\n')
const input = (text: string): string => ['────────────────────────────────────', text, '────────────────────────────────────', ' Interactive                gpt-4.1'].join('\n')
const held = input(['❯ [CW] New in your inbox: 1', '  message (m4). Call cw_inbox to', '  read it, act on it, then ack', '  it.'].join('\n'))

// The pane just narrowed: Copilot part-way through drawing its conversation again (m3 not drawn yet).
const snapshot = [asked('m1'), asked('m2'), input('❯')].join('\n')
// m4 typed and held before its Enter, the whole conversation drawn again.
const whileHeld = [asked('m1'), asked('m2'), asked('m3'), held].join('\n')
// rc.3's failure screen: m4 taken back, its input empty, m1–m3 in its history.
const takenBack = [asked('m1'), asked('m2'), asked('m3'), input('❯')].join('\n')

describe('the held doorbell of the put-off round (HI-2875)', () => {
  it('a screen difference takes an earlier doorbell redrawn after the snapshot for the held one, which never leaves', () => {
    const earlier = new Set(doorbellIds(snapshot))
    const picked = doorbellIds(whileHeld).find((x) => !earlier.has(x))
    expect(picked).toBe('m3')
    // Taken back, the input is empty, and m3 is still in its history: a wait for it to leave ends only at its bound.
    expect(doorbellIds(takenBack).filter((x) => x === picked)).toHaveLength(1)
  })

  it("Combwork's deliveries name the held one, shown once while held and gone once taken back", () => {
    const before = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }].map((d) => d.id)
    const m = newDelivery(before, [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }])
    expect(m).toBe('m4')
    expect(doorbellIds(whileHeld).filter((x) => x === m)).toHaveLength(1)
    expect(doorbellIds(takenBack).filter((x) => x === m)).toHaveLength(0)
  })

  it('no new delivery yet is none, and the newest new one is taken', () => {
    expect(newDelivery(['m1'], [{ id: 'm1' }])).toBeNull()
    expect(newDelivery(['m1'], undefined)).toBeNull()
    expect(newDelivery(['m1'], [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }])).toBe('m3')
  })

  it("finds a doorbell however Copilot wrapped it, its time and border in the first row (HI-2387)", () => {
    expect(doorbellIds(whileHeld)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })
})
