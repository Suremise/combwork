// Structural sharing (HI-1806): a workspace sent again keeps the window's objects wherever they are equal, so what reads
// one by reference (a selector, React.memo) sees no change there.
import { describe, expect, it } from 'vitest'
import { keepSame } from '../src/shared/keepSame'

const workspace = () => ({
  path: 'C:\\ws',
  projects: [
    { name: 'alpha', config: { agents: [{ id: 'a1' }] }, agents: [{ id: 'a1', live: { status: 'working' } }, { id: 'a2', live: null }] },
    { name: 'beta', config: { agents: [] }, agents: [] }
  ]
})

describe('keepSame', () => {
  it('gives the old copy back when the new one is equal throughout', () => {
    const before = workspace()
    expect(keepSame(before, workspace())).toBe(before)
  })

  it('keeps each unchanged part and replaces only the path to a change', () => {
    const before = workspace()
    const next = workspace()
    next.projects[0].agents[1].live = { status: 'ready' }
    const kept = keepSame(before, next)
    expect(kept).not.toBe(before)
    expect(kept.projects[0]).not.toBe(before.projects[0])
    expect(kept.projects[0].agents[1]).not.toBe(before.projects[0].agents[1])
    expect(kept.projects[0].agents[1]).toEqual({ id: 'a2', live: { status: 'ready' } })
    // Untouched siblings are the window's own objects.
    expect(kept.projects[0].agents[0]).toBe(before.projects[0].agents[0])
    expect(kept.projects[0].config).toBe(before.projects[0].config)
    expect(kept.projects[1]).toBe(before.projects[1])
    expect(kept).toEqual(next)
  })

  it('takes added, removed and reordered entries as changes', () => {
    const before = workspace()
    const added = workspace()
    added.projects.push({ name: 'gamma', config: { agents: [] }, agents: [] })
    expect(keepSame(before, added).projects).toHaveLength(3)
    expect(keepSame(before, added).projects[0]).toBe(before.projects[0])
    const removed = { ...workspace(), projects: [workspace().projects[0]] }
    expect(keepSame(before, removed).projects).toEqual(removed.projects)
    const reordered = { ...workspace(), projects: [...workspace().projects].reverse() }
    expect(keepSame(before, reordered).projects.map((p) => p.name)).toEqual(['beta', 'alpha'])
    // A key gone, or one added, is a change even with the others equal.
    const one = { a: 1 }
    expect(keepSame({ a: 1, b: 2 }, one)).toStrictEqual({ a: 1 })
    expect(keepSame(one, { a: 1, b: undefined })).not.toBe(one)
    expect(keepSame(one, { a: 1, b: undefined })).toStrictEqual({ a: 1, b: undefined })
  })

  it('compares what isn’t a plain object or array by reference', () => {
    const d = new Date(0)
    expect(keepSame(d, new Date(0))).not.toBe(d)
    expect(keepSame(null, { a: 1 })).toEqual({ a: 1 })
    expect(keepSame({ a: 1 }, null)).toBeNull()
    expect(keepSame([1, 2], { 0: 1, 1: 2 })).toEqual({ 0: 1, 1: 2 })
  })
})
