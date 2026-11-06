// The Merge… button's count and the agent tab's ↑n: a worktree agent's commits and files not merged yet.
import { describe, expect, it } from 'vitest'
import { unmergedWork } from '../src/shared/defaults'

const st = (ahead: number, dirty: number, into: string | null = 'main') => ({ branch: 'cw/two', base: 'develop', into, ahead, dirty })

describe('unmergedWork', () => {
  it('counts commits, and says what else there is', () => {
    expect(unmergedWork(st(2, 1))).toEqual({ badge: '2', text: '2 commits not merged into main · 1 uncommitted file' })
    expect(unmergedWork(st(1, 0))).toEqual({ badge: '1', text: '1 commit not merged into main' })
  })
  it('shows a dot for uncommitted files alone', () => {
    expect(unmergedWork(st(0, 3))).toEqual({ badge: '•', text: '3 uncommitted files' })
  })
  it('has no badge when there is nothing to merge', () => {
    expect(unmergedWork(st(0, 0))).toEqual({ badge: null, text: 'Nothing to merge into main' })
  })
  it('names the base branch when the project folder has none checked out', () => {
    expect(unmergedWork(st(1, 0, null))?.text).toBe('1 commit not merged into develop')
  })
  it('knows nothing before git has been asked, or when it could not say', () => {
    expect(unmergedWork(undefined)).toBeNull()
    expect(unmergedWork(null)).toBeNull()
  })
})
