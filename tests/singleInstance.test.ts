// A start whose single-instance lock is refused (HI-3454): it waits, within its bound, for the profile's lock to be
// released (a copy still ending holds it), then asks once more; a lock held throughout (a running copy) runs the bound
// out and the start leaves. The lock held by another process is the e2e suite unexpectedclose's: Node can't open a file
// shared for reading only, as Chromium does. Here, the wait's logic on a fake clock, and the free lock file's cases.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { LOCK_FILE, LOCK_POLL_MS, LOCK_RELEASE_WAIT_MS, lockOnceReleased, profileLockHeld } from '../src/main/singleInstance'
import { tempDir } from './tempDir'

/** A clock that moves only when the wait pauses, and how often it paused. */
function fakeClock() {
  let t = 1_000
  const c = { pauses: 0, now: () => t, pause: (ms: number) => ((t += ms), c.pauses++) }
  return c
}

describe('lockOnceReleased', () => {
  it('a lock free at once is asked for once, with no wait', () => {
    const c = fakeClock()
    let asked = 0
    const r = lockOnceReleased(() => (asked++, true), () => false, c)
    expect(r).toEqual({ taken: true, released: true, waitedMs: 0 })
    expect(asked).toBe(1)
    expect(c.pauses).toBe(0)
  })

  it('a lock released partway through is asked for once it is free, never before', () => {
    const c = fakeClock()
    let asked = 0
    let looks = 0
    const r = lockOnceReleased(() => (asked++, true), () => ++looks <= 3, c)
    expect(r.taken).toBe(true)
    expect(r.waitedMs).toBe(3 * LOCK_POLL_MS)
    expect(asked).toBe(1)
  })

  it('a lock free but taken by another start by then: released, not taken, asked once', () => {
    let asked = 0
    const r = lockOnceReleased(() => (asked++, false), () => false, fakeClock())
    expect(r).toMatchObject({ taken: false, released: true })
    expect(asked).toBe(1)
  })

  it('a lock held throughout (a running copy) runs the bound out and is never asked for again', () => {
    const c = fakeClock()
    let asked = 0
    const r = lockOnceReleased(() => (asked++, true), () => true, c)
    expect(r).toEqual({ taken: false, released: false, waitedMs: LOCK_RELEASE_WAIT_MS })
    expect(asked).toBe(0)
    expect(c.pauses).toBe(LOCK_RELEASE_WAIT_MS / LOCK_POLL_MS)
  })
})

describe('profileLockHeld', () => {
  it('no lock file: free', () => {
    expect(profileLockHeld(tempDir('lock-none-'))).toBe(false)
  })

  it('a lock file nobody has open (left behind): free', () => {
    const dir = tempDir('lock-left-')
    writeFileSync(join(dir, LOCK_FILE), '')
    expect(profileLockHeld(dir)).toBe(false)
  })
})
