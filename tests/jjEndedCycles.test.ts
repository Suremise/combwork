// HI-2950: when a jj card's cycle has ended without Integrated (design HI-2950/s10), the one predicate the sweep, its
// owner and its row deletion read: an earlier cycle; the current one in Todo; the current one Done with no Integrated.
import { describe, expect, it } from 'vitest'
import { cycleEnded } from '../src/main/workflow/reconcile'

const integrated = { revision: 'r', target: 'main', result: 'x', method: 'merge', by: 'outside' } as never

describe('cycleEnded (HI-2950)', () => {
  it('an earlier cycle has ended, whatever the stage', () => {
    for (const stage of ['todo', 'active', 'review', 'approved', 'done'] as const) expect(cycleEnded({ stage }, { cycle: 9, integrated: null }, 3)).toBe(true)
  })
  it('the current cycle: ended in Todo, or Done with no Integrated; never while Active, in Review or Approved', () => {
    expect(cycleEnded({ stage: 'todo' }, { cycle: 3, integrated: null }, 3)).toBe(true)
    expect(cycleEnded({ stage: 'done' }, { cycle: 3, integrated: null }, 3)).toBe(true)
    expect(cycleEnded({ stage: 'done' }, { cycle: 3, integrated }, 3)).toBe(false)
    for (const stage of ['active', 'review', 'approved', 'merging'] as const) expect(cycleEnded({ stage }, { cycle: 3, integrated: null }, 3)).toBe(false)
  })
  it('a later cycle than the current one (a stale read) is never ended', () => {
    expect(cycleEnded({ stage: 'todo' }, { cycle: 3, integrated: null }, 5)).toBe(false)
  })
})
