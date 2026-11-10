// jjRecovery's capped reader (HI-2795 round 3, HR1's round 2 finding): a live file is read from its opened handle in
// bounded chunks, never more than its cap plus one byte, however large it is or grows.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readCapped } from '../src/main/platform/jjRecovery'
import { tempDir } from './tempDir'

describe('readCapped', () => {
  it('reads a file within its cap whole', async () => {
    const f = join(tempDir('cap-'), 'a.txt')
    writeFileSync(f, 'hello')
    expect((await readCapped(f, 5))?.toString()).toBe('hello')
    expect((await readCapped(f, 100))?.toString()).toBe('hello')
  })

  it('a file past its cap is "over", and no more than cap + 1 bytes are read', async () => {
    const f = join(tempDir('cap-'), 'big.bin')
    writeFileSync(f, Buffer.alloc(1024 * 1024, 7))
    for (const cap of [0, 4, 65535, 65536, 200_000]) {
      let seen = 0
      expect(await readCapped(f, cap, (n) => (seen += n))).toBe('over')
      expect(seen).toBeLessThanOrEqual(cap + 1)
    }
  })

  it('a file that is missing or unreadable is null', async () => {
    expect(await readCapped(join(tempDir('cap-'), 'none.txt'), 10)).toBeNull()
  })
})
