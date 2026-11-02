// A row of tabs' rules (HI-1837, components/Tabs.tsx): the keys that move along it, and what a remembered selection
// becomes when the tabs offered change.
import { describe, expect, it } from 'vitest'
import { REMEMBERED_TABS_MAX, rememberTab, shownTab, tabAfterKey } from '../src/shared/tabs'

const ids = ['a', 'b', 'c'] as const

describe('tabAfterKey', () => {
  it('moves with the arrows, wrapping at the ends', () => {
    expect(tabAfterKey(ids, 'a', 'ArrowRight')).toBe('b')
    expect(tabAfterKey(ids, 'c', 'ArrowRight')).toBe('a')
    expect(tabAfterKey(ids, 'b', 'ArrowLeft')).toBe('a')
    expect(tabAfterKey(ids, 'a', 'ArrowLeft')).toBe('c')
  })
  it('goes to the ends with Home and End', () => {
    expect(tabAfterKey(ids, 'b', 'Home')).toBe('a')
    expect(tabAfterKey(ids, 'b', 'End')).toBe('c')
  })
  it('leaves other keys to the page', () => {
    expect(tabAfterKey(ids, 'b', 'Enter')).toBeNull()
    expect(tabAfterKey(ids, 'b', 'ArrowDown')).toBeNull()
    expect(tabAfterKey([], 'b' as string, 'ArrowRight')).toBeNull()
  })
  it('moves from the first tab when the selected one is no longer offered', () => {
    expect(tabAfterKey(ids, 'gone' as 'a', 'ArrowRight')).toBe('b')
  })
})

describe('shownTab', () => {
  it('shows the remembered tab while it is offered', () => {
    expect(shownTab(ids, 'c', 'a')).toBe('c')
  })
  it('falls back when the remembered tab is not offered or was never chosen', () => {
    expect(shownTab(ids, 'gone', 'b')).toBe('b')
    expect(shownTab(ids, undefined, 'b')).toBe('b')
  })
  it('shows the first offered when neither the remembered nor the fallback is (a search offering one)', () => {
    expect(shownTab(['b', 'c'], 'a', 'a')).toBe('b')
  })
})

describe('rememberTab', () => {
  it('sets a row’s tab, keeping the others', () => {
    expect(rememberTab({ x: '1' }, 'y', '2')).toEqual({ x: '1', y: '2' })
    expect(rememberTab({ x: '1', y: '2' }, 'x', '3')).toEqual({ y: '2', x: '3' })
  })
  it('keeps at most the limit, the least recently chosen going first', () => {
    let all: Record<string, string> = {}
    for (let i = 0; i < REMEMBERED_TABS_MAX + 5; i++) all = rememberTab(all, `k${i}`, 't')
    all = rememberTab(all, 'k10', 'again')
    const keys = Object.keys(all)
    expect(keys).toHaveLength(REMEMBERED_TABS_MAX)
    expect(keys).not.toContain('k4')
    expect(keys[0]).toBe('k5')
    expect(keys.at(-1)).toBe('k10')
  })
})
