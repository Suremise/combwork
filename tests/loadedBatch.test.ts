// A workspace's parts loaded in one batch (HI-1938): opening a workspace loads a dozen parts (lanes, merge slots, queues,
// the Assistant's lists, Settings → Advanced…), each answering on its own. setLoaded shows one at once when none came
// lately, and those coming meanwhile together at the batch's end, in one update of the store; a direct set of one of
// those parts shows what waits first, so an older answer never replaces it. The real renderer store, with fake timers.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceInfo } from '../src/shared/types'

;(globalThis as unknown as { window: unknown }).window = { hive: { invoke: async () => null, on: () => () => {} }, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) }
// The renderer's module, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface Parts {
  mergeSlots: unknown[]
  laneOrder: Record<string, string[]>
  skillsVersion: number
}
interface RendererStore {
  get: () => Parts
  set: (u: Record<string, unknown>) => void
  setLoaded: (change: Record<string, unknown> | ((s: Parts) => Record<string, unknown>)) => void
  useStore: { subscribe: (fn: () => void) => () => void }
}
const rendererStore = '../src/renderer/src/store'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore

const workspace = { path: 'A', projects: [] } as unknown as WorkspaceInfo
let updates = 0

beforeAll(() => {
  vi.useFakeTimers()
  store.useStore.subscribe(() => updates++)
})
afterAll(() => vi.useRealTimers())
beforeEach(() => {
  vi.runAllTimers()
  store.set({ workspace, mergeSlots: [], laneOrder: {}, skillsVersion: 0 })
  updates = 0
})

describe("a workspace's parts loaded together (HI-1938)", () => {
  it('one on its own shows at once', () => {
    store.setLoaded({ mergeSlots: ['s'] })
    expect(store.get().mergeSlots).toEqual(['s'])
    expect(updates).toBe(1)
  })

  it('those answering while a batch is under way show together, in one update, in the order they came', () => {
    store.setLoaded({ mergeSlots: ['first'] })
    store.setLoaded({ laneOrder: { a: ['l1'] } })
    store.setLoaded((s) => ({ skillsVersion: s.skillsVersion + 1 }))
    store.setLoaded((s) => ({ skillsVersion: s.skillsVersion + 1 }))
    store.setLoaded({ mergeSlots: ['second'] })
    expect(store.get().mergeSlots).toEqual(['first'])
    expect(updates).toBe(1)
    vi.advanceTimersByTime(250)
    expect(store.get()).toMatchObject({ mergeSlots: ['second'], laneOrder: { a: ['l1'] }, skillsVersion: 2 })
    expect(updates).toBe(2)
  })

  it('a direct set of a loaded part shows what waits first: an older answer never replaces it', () => {
    store.setLoaded({ skillsVersion: 1 })
    store.setLoaded({ laneOrder: { a: ['older'] } })
    store.set({ laneOrder: { a: ['newer'] } })
    expect(store.get().laneOrder).toEqual({ a: ['newer'] })
    vi.runAllTimers()
    expect(store.get().laneOrder).toEqual({ a: ['newer'] })
  })
})
