import { describe, expect, it } from 'vitest'
import { syncLoginItemAtStart } from '../src/main/loginItem'

// HI-2460: an update that moves the exe (Hive.exe → Combwork.exe) needs Launch at login written again for the new one,
// only while the setting is on and only by the installed app.
describe('Launch at login at start (HI-2460)', () => {
  const calls: unknown[] = []
  const set = (s: unknown): void => void calls.push(s)

  it('on, installed: written for this exe, hidden', () => {
    calls.length = 0
    expect(syncLoginItemAtStart(true, true, set)).toBe(true)
    expect(calls).toEqual([{ openAtLogin: true, args: ['--hidden'] }])
  })

  it('off: nothing written (a user who turned it off is never registered)', () => {
    calls.length = 0
    expect(syncLoginItemAtStart(false, true, set)).toBe(false)
    expect(calls).toEqual([])
  })

  it('a dev or test build: nothing written, on or off', () => {
    calls.length = 0
    expect(syncLoginItemAtStart(true, false, set)).toBe(false)
    expect(syncLoginItemAtStart(false, false, set)).toBe(false)
    expect(calls).toEqual([])
  })
})
