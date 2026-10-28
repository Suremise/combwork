// The projects' keys read between the board's reads (HI-1948): a menu that names agents with a project's key reads the
// keys from main when the window has none for it yet, so Hive's own templates' agents are AL-B1, never {key}-B1. The
// read is kept only for the workspace it was made for (one the window left meanwhile is dropped, its keys never put
// over the next workspace's), only the latest such read, and never over keys a board read brought since. The real
// renderer store, its main replies held until the test lets them go.
import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceInfo } from '../src/shared/types'

/** Replies to project:keys, held until the test resolves them, in order. */
const pending: ((v: unknown) => void)[] = []
;(globalThis as unknown as { window: unknown }).window = {
  hive: { invoke: (channel: string) => (channel === 'project:keys' ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(null)), on: () => () => {} },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}
// The renderer's module, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
type Keys = { projectPath: string; key: string; aliases: string[] }[]
interface RendererStore {
  get: () => { projectKeys: Keys; boardReads: number; workspace: WorkspaceInfo | null }
  set: (u: Record<string, unknown>) => void
  readProjectKeys: () => Promise<boolean>
  projectKeyOf: (s: { projectKeys: Keys }, p: string) => string | null
}
const rendererStore = '../src/renderer/src/store'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore

const wsA = { path: 'C:/ws-a', projects: [] } as unknown as WorkspaceInfo
const wsB = { path: 'C:/ws-b', projects: [] } as unknown as WorkspaceInfo
const A_KEYS: Keys = [{ projectPath: 'C:/ws-a/alpha', key: 'AL', aliases: [] }]
const B_KEYS: Keys = [{ projectPath: 'C:/ws-b/beta', key: 'BE', aliases: [] }]

beforeEach(() => {
  pending.length = 0
  store.set({ workspace: wsA, projectKeys: [] })
})

describe("the projects' keys read for a menu (HI-1948)", () => {
  it("the window has no key yet: main's read brings it, so the menu names AL-B1", async () => {
    expect(store.projectKeyOf(store.get(), 'C:/ws-a/alpha')).toBeNull()
    const read = store.readProjectKeys()
    pending.shift()!(A_KEYS)
    expect(await read).toBe(true)
    expect(store.projectKeyOf(store.get(), 'C:/ws-a/alpha')).toBe('AL')
  })

  it("a read still waiting when the window moves to another workspace is dropped: B's keys stay, and the menu isn't opened", async () => {
    const read = store.readProjectKeys()
    // The window moves to B, whose board read brings B's keys.
    store.set({ workspace: wsB, projectKeys: B_KEYS })
    pending.shift()!(A_KEYS)
    expect(await read).toBe(false)
    expect(store.get().projectKeys).toEqual(B_KEYS)
  })

  it('never over keys a board read brought since it began, nor over a later read of its own', async () => {
    const reads = store.get().boardReads
    const first = store.readProjectKeys()
    // A board read lands meanwhile with keys of its own (newer than this read's).
    store.set({ projectKeys: [{ projectPath: 'C:/ws-a/alpha', key: 'AN', aliases: ['AL'] }], boardReads: reads + 1 })
    pending.shift()!(A_KEYS)
    expect(await first).toBe(true)
    expect(store.projectKeyOf(store.get(), 'C:/ws-a/alpha')).toBe('AN')
    // Two reads at once: the older's reply, landing last, is dropped.
    store.set({ projectKeys: [] })
    const older = store.readProjectKeys()
    const newer = store.readProjectKeys()
    pending[1]([{ projectPath: 'C:/ws-a/alpha', key: 'NW', aliases: [] }])
    await newer
    pending[0](A_KEYS)
    await older
    expect(store.projectKeyOf(store.get(), 'C:/ws-a/alpha')).toBe('NW')
  })

  it('no workspace: nothing is read', async () => {
    store.set({ workspace: null })
    expect(await store.readProjectKeys()).toBe(false)
    expect(pending).toHaveLength(0)
  })
})
