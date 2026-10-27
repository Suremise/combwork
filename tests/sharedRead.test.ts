// One read shared by the views asking with the same keys (HI-1754: For you was read once per view on each board change).
import { describe, expect, it } from 'vitest'
import { sharedRead } from '../src/renderer/src/sharedRead'

describe('sharedRead', () => {
  it('gives every caller with the same keys one read, and reads again when a key changes', async () => {
    let reads = 0
    const read = sharedRead(async () => ++reads)
    const board = {}
    const views = await Promise.all([read('ws', board), read('ws', board), read('ws', board)])
    expect(views).toEqual([1, 1, 1])
    expect(await read('ws', board)).toBe(1)
    // The board read again, another workspace, and back: each a new read.
    expect(await read('ws', {})).toBe(2)
    expect(await read('other', board)).toBe(3)
    expect(await read('ws', board)).toBe(4)
    expect(reads).toBe(4)
  })

  it('a failed read fails its callers, and the same keys read again after it', async () => {
    let fail = true
    let reads = 0
    const read = sharedRead(async () => {
      reads++
      if (fail) throw new Error('down')
      return 'ok'
    })
    const board = {}
    await expect(Promise.all([read('ws', board), read('ws', board)])).rejects.toThrow('down')
    expect(reads).toBe(1)
    fail = false
    // A view mounted after the failure, with the same keys: a new read, not the old failure.
    expect(await read('ws', board)).toBe('ok')
    expect(await read('ws', board)).toBe('ok')
    expect(reads).toBe(2)
  })

  it("an older read failing after a newer one started leaves the newer one shared", async () => {
    const pending: { resolve: (v: string) => void; reject: (e: Error) => void }[] = []
    let reads = 0
    const read = sharedRead(
      () =>
        new Promise<string>((resolve, reject) => {
          reads++
          pending.push({ resolve, reject })
        })
    )
    const older = read('ws', 'board 1')
    const newer = read('ws', 'board 2')
    pending[0].reject(new Error('down'))
    await expect(older).rejects.toThrow('down')
    // Still the newer read for its keys: no third read.
    expect(read('ws', 'board 2')).toBe(newer)
    pending[1].resolve('ok')
    expect(await newer).toBe('ok')
    expect(reads).toBe(2)
  })
})
