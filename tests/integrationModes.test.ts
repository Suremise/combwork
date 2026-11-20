// HI-2840 (no jj in the app's code): a platform's integration modes are its descriptor's
// `finishes` and `defaultFinish`, and the options form, a new project's options and the contradictions follow them, never a
// platform's id. Here the descriptors are changed under the workflow's options (a stand-in list for each platform) and
// every answer moves with them; the real descriptors' own data is pinned beside it. gitAudit.test.ts fails a second
// list declared anywhere else.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Finisher } from '../src/shared/workflow/options'

const stand = vi.hoisted(() => ({ modes: null as null | Record<string, { finishes: Finisher[]; defaultFinish: Finisher }> }))

vi.mock('../src/shared/platform/descriptors', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/platform/descriptors')>()
  // Each platform's descriptor as it is, its modes the stand-in's while a test sets them.
  const PLATFORMS = Object.fromEntries(
    Object.entries(real.PLATFORMS).map(([id, d]) => [
      id,
      new Proxy(d, { get: (t, k) => (stand.modes?.[id] && (k === 'finishes' || k === 'defaultFinish') ? stand.modes[id][k] : Reflect.get(t, k)) })
    ])
  )
  return { ...real, PLATFORMS }
})

const { allOff, contradictions, formFinishes } = await import('../src/shared/workflow/options')
const { PLATFORMS, PLATFORM_IDS } = await import('../src/shared/platform/descriptors')

afterEach(() => {
  stand.modes = null
})

describe("a platform's integration modes are its descriptor's (HI-2840)", () => {
  it('declares each platform its finishes and a default among them: Git its four, None acceptance, jj Combwork’s advance (the default, HI-3235), its preview and click (HI-3236) and the user integrating', () => {
    expect(Object.fromEntries(PLATFORM_IDS.map((p) => [p, { finishes: PLATFORMS[p].finishes, defaultFinish: PLATFORMS[p].defaultFinish }]))).toEqual({
      git: { finishes: ['combworkMerges', 'agentMerges', 'committed', 'notChecked'], defaultFinish: 'notChecked' },
      none: { finishes: ['accept'], defaultFinish: 'accept' },
      jj: { finishes: ['combworkAdvances', 'previewAdvance', 'userIntegrates'], defaultFinish: 'combworkAdvances' }
    })
    for (const p of PLATFORM_IDS) expect(PLATFORMS[p].finishes).toContain(PLATFORMS[p].defaultFinish)
  })

  it("offers, defaults to and accepts exactly the descriptor's modes, whatever they are: no answer follows the id", () => {
    // jj given a second mode beside the user integrating (as HI-2840's stage 2 gives it Combwork's advance), and a default
    // of it; Git given only the user integrating.
    stand.modes = { jj: { finishes: ['notChecked', 'userIntegrates'], defaultFinish: 'notChecked' }, git: { finishes: ['userIntegrates'], defaultFinish: 'userIntegrates' } }
    expect(formFinishes('jj')).toEqual(['notChecked', 'userIntegrates'])
    expect(formFinishes('git')).toEqual(['userIntegrates'])
    expect(allOff('jj').finish).toBe('notChecked')
    expect(allOff('git').finish).toBe('userIntegrates')
    const finishing = (platform: 'git' | 'jj', finish: Finisher): string[] => contradictions({ ...allOff(platform), finish }).filter((c) => c === 'jjYouIntegrate' || c === 'combworkMergesNeedsGit')
    // Each declared mode is accepted; one the descriptor doesn't declare is a contradiction, worded for the platform's way.
    expect(finishing('jj', 'notChecked')).toEqual([])
    expect(finishing('jj', 'userIntegrates')).toEqual([])
    expect(finishing('jj', 'agentMerges')).toEqual(['jjYouIntegrate'])
    expect(finishing('git', 'userIntegrates')).toEqual([])
    expect(finishing('git', 'combworkMerges')).toEqual(['jjYouIntegrate'])
  })

  it('words a mode a platform lacks as before: You integrate where the user integrates or chosen where work merges, else acceptance', () => {
    const finishing = (platform: 'git' | 'jj' | 'none', finish: Finisher): string[] => contradictions({ ...allOff(platform), finish }).filter((c) => c === 'jjYouIntegrate' || c === 'combworkMergesNeedsGit')
    expect(finishing('git', 'accept')).toEqual(['combworkMergesNeedsGit'])
    expect(finishing('git', 'userIntegrates')).toEqual(['jjYouIntegrate'])
    expect(finishing('none', 'combworkMerges')).toEqual(['combworkMergesNeedsGit'])
    expect(finishing('none', 'userIntegrates')).toEqual(['combworkMergesNeedsGit'])
    expect(finishing('jj', 'accept')).toEqual(['jjYouIntegrate'])
    expect(finishing('jj', 'combworkMerges')).toEqual(['jjYouIntegrate'])
    // HI-3235: Combwork's advance where it isn't declared (Git's queue merges, None accepts).
    expect(finishing('git', 'combworkAdvances')).toEqual(['jjYouIntegrate'])
    expect(finishing('none', 'combworkAdvances')).toEqual(['combworkMergesNeedsGit'])
    expect(finishing('jj', 'userIntegrates')).toEqual([])
    expect(finishing('jj', 'previewAdvance')).toEqual([])
    expect(finishing('git', 'previewAdvance')).toEqual(['jjYouIntegrate'])
    for (const p of ['git', 'none', 'jj'] as const) expect(finishing(p, allOff(p).finish)).toEqual([])
  })
})
