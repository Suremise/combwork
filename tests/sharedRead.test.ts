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

  it('a failed read fails its callers; the next keys read again', async () => {
    let fail = true
    const read = sharedRead(async () => {
      if (fail) throw new Error('down')
      return 'ok'
    })
    const board = {}
    await expect(read('ws', board)).rejects.toThrow('down')
    fail = false
    expect(await read('ws', {})).toBe('ok')
  })
})
