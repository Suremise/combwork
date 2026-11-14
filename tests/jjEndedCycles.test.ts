// HI-2950: when a jj card's cycle has ended without Integrated (design HI-2950/s10), the one predicate the sweep, its
// owner and its row deletion read: an earlier cycle; the current one in Todo; the current one Done with no Integrated.
// HI-2990: the sweep's predicate is `cycleOver` (ended, or Integrated), and a drop held back keeps a cycle live.
import { describe, expect, it } from 'vitest'
import { cycleEnded, cycleOver } from '../src/main/workflow/reconcile'
import { cycleLive, type JjAttemptEntry } from '../src/main/platform/jjCandidateStep'

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

describe('cycleOver (HI-2990): ended, or Integrated', () => {
  it("the current cycle with Integrated is over in Done and in Approved (recorded while the rules were off); without, as cycleEnded", () => {
    expect(cycleOver({ stage: 'done' }, { cycle: 3, integrated }, 3)).toBe(true)
    expect(cycleOver({ stage: 'approved' }, { cycle: 3, integrated }, 3)).toBe(true)
    for (const stage of ['active', 'review', 'approved'] as const) expect(cycleOver({ stage }, { cycle: 3, integrated: null }, 3)).toBe(false)
    expect(cycleOver({ stage: 'todo' }, { cycle: 3, integrated: null }, 3)).toBe(true)
    expect(cycleOver({ stage: 'active' }, { cycle: 9, integrated: null }, 3)).toBe(true)
    expect(cycleOver({ stage: 'done' }, { cycle: 3, integrated }, 5)).toBe(false)
  })
})

describe('cycleLive (HI-2990): a drop held back is still to do', () => {
  const entry = (record: Partial<JjAttemptEntry['record']>, more: Partial<JjAttemptEntry> = {}): JjAttemptEntry => ({ fp: {} as never, record: { attempt: 'a1', card: 'AM-1', style: 'merge', revision: 'r', base: 'b', expected: 'e', phase: 'done', baseOp: 'o', ops: [], commits: [], pins: [], ...record }, ...more })
  it('a held drop (phase dropped, no state) is live whatever its outcome; settled ones are not', () => {
    expect(cycleLive([entry({ phase: 'dropped', outcome: 'updated' })])).toBe(true)
    expect(cycleLive([entry({ phase: 'dropped' })])).toBe(true)
    expect(cycleLive([entry({ phase: 'dropped', outcome: 'updated' }, { state: 'dropped' })])).toBe(false)
    expect(cycleLive([entry({ phase: 'dropped', outcome: 'candidate' }, { state: 'kept' })])).toBe(false)
    expect(cycleLive([entry({ outcome: 'conflict' }, { failure: { reason: 'conflict', log: '' } })])).toBe(false)
    expect(cycleLive([entry({ outcome: 'candidate' })])).toBe(true)
    expect(cycleLive([entry({ phase: 'writing' })])).toBe(true)
  })
})
