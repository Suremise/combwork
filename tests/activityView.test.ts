// The Activity tabs' kept views under their key since 1.1, and the names upgrade's step moving those kept before it (HI-2610).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadActivityView, saveActivityView, upgradeActivityViews } from '../src/renderer/src/activityView'

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return {
    get length() {
      return m.size
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    entries: () => Object.fromEntries(m)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('the Activity tabs\' kept views (HI-2610)', () => {
  it('keeps a view under combwork.activity.<project>', () => {
    const s = memory()
    vi.stubGlobal('localStorage', s)
    saveActivityView('D:\\Work\\App', { tab: 'b1', showOwn: true, opened: 3 })
    expect(s.entries()).toEqual({ 'combwork.activity.d:\\work\\app': JSON.stringify({ tab: 'b1', showOwn: true }) })
    expect(loadActivityView('D:\\Work\\App')).toEqual({ tab: 'b1', showOwn: true })
  })

  it('moves the views kept before 1.1 once, a view under the new key staying', () => {
    const s = memory({
      'hive.activity.d:\\a': JSON.stringify({ tab: 'old-a' }),
      'hive.activity.workspace:d:\\ws': JSON.stringify({ forCard: 7 }),
      'hive.activity.d:\\b': JSON.stringify({ tab: 'old-b' }),
      'combwork.activity.d:\\b': JSON.stringify({ tab: 'new-b' }),
      'other.key': 'x'
    })
    upgradeActivityViews(s)
    expect(s.entries()).toEqual({
      'combwork.activity.d:\\a': JSON.stringify({ tab: 'old-a' }),
      'combwork.activity.workspace:d:\\ws': JSON.stringify({ forCard: 7 }),
      'combwork.activity.d:\\b': JSON.stringify({ tab: 'new-b' }),
      'other.key': 'x'
    })
    vi.stubGlobal('localStorage', s)
    expect(loadActivityView('D:\\A')).toEqual({ tab: 'old-a' })
    // Again: nothing old is left, so nothing changes.
    const before = s.entries()
    upgradeActivityViews(s)
    expect(s.entries()).toEqual(before)
  })

  it('never throws when storage is blocked', () => {
    const blocked = { get length(): number { throw new Error('blocked') }, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
    expect(() => upgradeActivityViews(blocked)).not.toThrow()
  })
})
