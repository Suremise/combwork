// The e2e runners' claims lock (tests/e2e/lanes.mjs, withLock): Windows refuses to make its folder while the one another
// runner just released is still being deleted, with EPERM (at times EACCES). HI-1800: a scenario runner failed claiming a
// lane on it. The lock is taken once the folder is gone; a folder that stays refused still fails, within the lock's bound.
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
// @ts-expect-error: plain .mjs modules without types
import { withLock } from './e2e/lanes.mjs'

// The lock folder's mkdir refused `refusals` times with `code`, as Windows does while its last holder's removal ends.
const refuse = vi.hoisted(() => ({ refusals: 0, code: 'EPERM', tried: 0 }))
vi.mock('fs', async (orig) => {
  const m = await orig<typeof import('fs')>()
  const mkdirSync = ((path: string, ...rest: unknown[]) => {
    if (String(path).endsWith('.claiming')) {
      refuse.tried++
      if (refuse.refusals > 0) {
        refuse.refusals--
        throw Object.assign(new Error(`${refuse.code}: operation not permitted, mkdir '${path}'`), { code: refuse.code })
      }
    }
    return (m.mkdirSync as (...a: unknown[]) => unknown)(path, ...rest)
  }) as typeof m.mkdirSync
  return { ...m, mkdirSync, default: { ...m, mkdirSync } }
})

describe("the e2e runners' claims lock (HI-1800)", () => {
  afterEach(() => {
    refuse.refusals = 0
    refuse.tried = 0
  })

  for (const code of ['EPERM', 'EACCES']) {
    it(`is taken once its folder, refused with ${code} while the last holder's removal ends, can be made`, async () => {
      const dir = tempDir('hive-lanes-lock-')
      Object.assign(refuse, { refusals: 3, code })
      expect(await withLock(dir, async () => 'held')).toBe('held')
      expect(refuse.tried).toBe(4)
      // Released: the folder is gone.
      expect(existsSync(join(dir, '.claiming'))).toBe(false)
      expect(readdirSync(dir)).toEqual([])
    })
  }

  it('fails, with the cause, when its folder is refused for longer than the lock is ever held', async () => {
    const dir = tempDir('hive-lanes-lock-')
    Object.assign(refuse, { refusals: Number.MAX_SAFE_INTEGER, code: 'EPERM' })
    // The bound is the lock's (4 × 10 s): its clock moved on rather than waited for.
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockImplementation(() => start + (refuse.tried > 1 ? 50_000 : 0))
    try {
      await expect(withLock(dir, async () => 'held')).rejects.toMatchObject({ code: 'EPERM' })
    } finally {
      now.mockRestore()
    }
    expect(refuse.tried).toBe(2)
  })
})
