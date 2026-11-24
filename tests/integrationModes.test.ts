// HI-2840: a platform's integration modes are its descriptor's
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
const { PLATFORMS } = await import('../src/shared/platform/descriptors')
const PLATFORM_IDS = Object.keys(PLATFORMS) as (keyof typeof PLATFORMS)[]

afterEach(() => {
  stand.modes = null
})

describe("a platform's integration modes are its descriptor's (HI-2840)", () => {
  it('declares each platform its finishes and a default among them: Git its five, None acceptance', () => {
    expect(Object.fromEntries(PLATFORM_IDS.map((p) => [p, { finishes: PLATFORMS[p].finishes, defaultFinish: PLATFORMS[p].defaultFinish }]))).toEqual({
      git: { finishes: ['combworkMerges', 'agentMerges', 'committed', 'notChecked', 'pullRequest'], defaultFinish: 'notChecked' },
      none: { finishes: ['accept'], defaultFinish: 'accept' }
    })
    for (const p of PLATFORM_IDS) expect(PLATFORMS[p].finishes).toContain(PLATFORMS[p].defaultFinish)
  })

  it("offers, defaults to and accepts exactly the descriptor's modes, whatever they are: no answer follows the id", () => {
    // Git given only Committed is done, and None a merge Combwork doesn't check beside acceptance.
    stand.modes = { git: { finishes: ['committed'], defaultFinish: 'committed' }, none: { finishes: ['accept', 'notChecked'], defaultFinish: 'notChecked' } }
    expect(formFinishes('git')).toEqual(['committed'])
    expect(formFinishes('none')).toEqual(['accept', 'notChecked'])
    expect(allOff('git').finish).toBe('committed')
    expect(allOff('none').finish).toBe('notChecked')
    const finishing = (platform: 'git' | 'none', finish: Finisher): string[] => contradictions({ ...allOff(platform), finish }).filter((c) => c === 'combworkMergesNeedsGit')
    // Each declared mode is accepted; one the descriptor doesn't declare is a contradiction.
    expect(finishing('git', 'committed')).toEqual([])
    expect(finishing('git', 'combworkMerges')).toEqual(['combworkMergesNeedsGit'])
    expect(finishing('none', 'notChecked')).toEqual([])
    expect(finishing('none', 'combworkMerges')).toEqual(['combworkMergesNeedsGit'])
  })

  it('words a mode a platform lacks as acceptance and merging not mixing (HI-2822)', () => {
    const finishing = (platform: 'git' | 'none', finish: Finisher): string[] => contradictions({ ...allOff(platform), finish }).filter((c) => c === 'combworkMergesNeedsGit')
    expect(finishing('git', 'accept')).toEqual(['combworkMergesNeedsGit'])
    expect(finishing('none', 'combworkMerges')).toEqual(['combworkMergesNeedsGit'])
    for (const p of ['git', 'none'] as const) expect(finishing(p, allOff(p).finish)).toEqual([])
  })
})
