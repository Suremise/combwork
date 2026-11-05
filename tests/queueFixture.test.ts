// The merge queue's e2e fixture (tests/e2e/queueFixture.cjs): Release Slot on a slot a Combwork that ended at a seam left
// held (`releaseHeld`). HI-2177: Combwork may free that writer itself meanwhile (HI-2055), so a refusal counts as released
// only once a read shows that run no longer holds the slot (HR2's round 1).
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const req = createRequire(import.meta.url)
const { releaseHeld } = req('./e2e/queueFixture.cjs') as { releaseHeld: (fx: { alpha: string }, h: { inv: (channel: string, ...args: unknown[]) => Promise<unknown> }) => Promise<string[]> }

const fx = { alpha: 'C:\\ws\\alpha' }
const refused = new Error('slot-a changed meanwhile: its writer is no longer the one shown. Look again.')

/** A window whose slot-a is held by run r-1: its release refused; `after`, what reading its writer again gives. */
function hive(after: () => Promise<unknown>) {
  let reads = 0
  return {
    inv: async (channel: string): Promise<unknown> => {
      if (channel === 'slots:list') return [{ name: 'slot-a', writer: { held: true } }]
      if (channel === 'slots:heldWriter') return reads++ === 0 ? { run: 'r-1' } : after()
      if (channel === 'slots:releaseWriter') throw refused
      throw new Error(`unexpected ${channel}`)
    }
  }
}

describe("the queue fixture's Release Slot (HI-2177)", () => {
  it('refused, the writer then gone or another run: released (Combwork freed it itself)', async () => {
    expect(await releaseHeld(fx, hive(async () => null))).toEqual(['slot-a'])
    expect(await releaseHeld(fx, hive(async () => ({ run: 'r-2' })))).toEqual(['slot-a'])
  })

  it('refused, the same run still holding it: the release’s own error', async () => {
    await expect(releaseHeld(fx, hive(async () => ({ run: 'r-1' })))).rejects.toBe(refused)
  })

  it('refused, its writer unreadable: that error, never taken as released', async () => {
    const unreadable = new Error('the board could not be read')
    await expect(
      releaseHeld(
        fx,
        hive(async () => {
          throw unreadable
        })
      )
    ).rejects.toBe(unreadable)
  })
})
