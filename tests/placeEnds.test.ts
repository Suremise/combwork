// A place's end and its holds (HI-3614, HI-3615 round 2, placeEnds.ts): every listener's work awaited, the held jobs
// handed back; and a pool's settle of a preview's hold clears it only once the Preview proves that preview's page gone
// too, never merely because its dev server's job ended.
import { afterEach, describe, expect, it } from 'vitest'
import { isPreviewHold, onPlaceEnded, placeEnded, setPreviewHoldCheck, settleHeld } from '../src/main/placeEnds'

afterEach(() => setPreviewHoldCheck(null))

describe("a place's end (HI-3614)", () => {
  it("waits for every listener's work and hands back the jobs still held", async () => {
    let done = false
    const off = onPlaceEnded(async () => {
      await Promise.resolve()
      done = true
      return { held: ['preview-0a1b'] }
    })
    const off2 = onPlaceEnded(() => undefined)
    expect(await placeEnded({ kind: 'generation', id: 'lease-1' })).toEqual(['preview-0a1b'])
    expect(done).toBe(true)
    off()
    off2()
    expect(await placeEnded({ kind: 'generation', id: 'lease-1' })).toEqual([])
  })
})

describe("a pool's settle of a preview's hold (HI-3615 round 2)", () => {
  it("clears it only when the job's processes ended and the Preview proves its page gone too", async () => {
    let guardGone = false
    const asked: string[] = []
    setPreviewHoldCheck(async (job) => (asked.push(job), guardGone))
    const ended = async (): Promise<boolean> => true
    expect(await settleHeld('preview-0a1b', ended)).toBe(false)
    guardGone = true
    expect(await settleHeld('preview-0a1b', ended)).toBe(true)
    // A job not ended: never asked further.
    expect(await settleHeld('preview-0a1b', async () => false)).toBe(false)
    // A slot's own job (its setup's): the Preview isn't asked.
    expect(await settleHeld('slot-1a2b3c', ended)).toBe(true)
    expect(asked).toEqual(['preview-0a1b', 'preview-0a1b'])
  })

  it('knows a preview hold by its job or its id', () => {
    expect(isPreviewHold('preview-0a1b2c3d4e5f')).toBe(true)
    expect(isPreviewHold('pv-0a1b2c3d4e5f')).toBe(true)
    expect(isPreviewHold('copy-1a2b')).toBe(false)
    expect(isPreviewHold('preview-x')).toBe(false)
  })
})
