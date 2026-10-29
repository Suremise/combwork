// Always on Top (src/main/pin.ts): per window, remembered by workspace in Hive's own config, following the workspace
// the window shows.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/types'

const store: { cfg: Pick<AppConfig, 'alwaysOnTop'> } = { cfg: {} }
vi.mock('../src/main/config', () => ({
  config: { get: () => store.cfg, update: (fn: (c: Pick<AppConfig, 'alwaysOnTop'>) => void) => fn(store.cfg) }
}))
const { carryPin, pinFollower, pinnedFor, setPinned } = await import('../src/main/pin')

const fakeWindow = () => {
  let top = false
  return { setAlwaysOnTop: vi.fn((on: boolean) => (top = on)), isAlwaysOnTop: () => top, isDestroyed: () => false }
}

beforeEach(() => {
  store.cfg = {}
})

describe('Always on Top', () => {
  it('is remembered for the workspace, whatever the path case, and forgotten when turned off', () => {
    const w = fakeWindow()
    expect(setPinned(w as never, 'C:\\Work\\Hive', true)).toBe(true)
    expect(store.cfg.alwaysOnTop).toEqual({ 'c:\\work\\hive': true })
    expect(pinnedFor('c:\\WORK\\hive')).toBe(true)
    expect(pinnedFor('C:\\Work\\Other')).toBe(false)
    expect(setPinned(w as never, 'C:\\Work\\Hive', false)).toBe(false)
    expect(store.cfg.alwaysOnTop).toEqual({})
    expect(pinnedFor('C:\\Work\\Hive')).toBe(false)
  })

  it('a window with no workspace can be pinned, and nothing is remembered', () => {
    const w = fakeWindow()
    expect(setPinned(w as never, null, true)).toBe(true)
    expect(store.cfg.alwaysOnTop).toBeUndefined()
    expect(pinnedFor(null)).toBe(false)
  })

  it("a window takes the pin of each workspace it opens, once, so a later change isn't undone", () => {
    store.cfg.alwaysOnTop = { 'c:\\pinned': true }
    const w = fakeWindow()
    const follow = pinFollower(w as never)
    // The welcome page: off (already off, nothing to change).
    expect(follow(null)).toBe(false)
    // A pinned workspace opens in it: on.
    expect(follow('C:\\Pinned')).toBe(true)
    expect(w.isAlwaysOnTop()).toBe(true)
    // The user unpins it; another refresh of the same workspace leaves it as the user set it.
    w.setAlwaysOnTop(false)
    expect(follow('C:\\pinned')).toBe(false)
    expect(w.isAlwaysOnTop()).toBe(false)
    // Another workspace, never pinned: off. Back to the welcome page: off.
    w.setAlwaysOnTop(true)
    expect(follow('C:\\Other')).toBe(true)
    expect(w.isAlwaysOnTop()).toBe(false)
  })

  it("a welcome window pinned by hand stays pinned when other windows' workspaces change", () => {
    store.cfg.alwaysOnTop = { 'c:\\pinned': true }
    const w = fakeWindow()
    const follow = pinFollower(w as never)
    // The user pins the new window on the welcome page (nothing is remembered for it).
    w.setAlwaysOnTop(true)
    // Another window opens a workspace: every window hears it, and this one still shows no workspace.
    expect(follow(null)).toBe(false)
    expect(w.isAlwaysOnTop()).toBe(true)
    expect(follow(null)).toBe(false)
    expect(w.isAlwaysOnTop()).toBe(true)
    // Its own workspace opening does apply that workspace's pin (off for one never pinned).
    expect(follow('C:\\Never')).toBe(true)
    expect(w.isAlwaysOnTop()).toBe(false)
  })

  it('two windows keep their own pins', () => {
    const a = fakeWindow()
    const b = fakeWindow()
    setPinned(a as never, 'C:\\One', true)
    setPinned(b as never, 'C:\\Two', false)
    expect([a.isAlwaysOnTop(), b.isAlwaysOnTop()]).toEqual([true, false])
    expect([pinnedFor('C:\\One'), pinnedFor('C:\\Two')]).toEqual([true, false])
  })

  it('a moved workspace takes its pin to its new folder (HI-2007); one never pinned stays unpinned', () => {
    setPinned(fakeWindow() as never, 'C:\\Old\\Work', true)
    setPinned(fakeWindow() as never, 'C:\\Other', true)
    expect(carryPin('c:\\old\\WORK', 'D:\\New\\Work')).toBe(true)
    expect(store.cfg.alwaysOnTop).toEqual({ 'd:\\new\\work': true, 'c:\\other': true })
    expect([pinnedFor('D:\\New\\Work'), pinnedFor('C:\\Old\\Work')]).toEqual([true, false])
    expect(carryPin('C:\\Never', 'D:\\Elsewhere')).toBe(false)
    expect(pinnedFor('D:\\Elsewhere')).toBe(false)
  })
})
