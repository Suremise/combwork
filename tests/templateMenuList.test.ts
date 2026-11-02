// The templates listed for Add Agent from Template's menu (HI-1948): the list main sends, its agents named for the
// project (agentNames), is opened on only while the window is still on the workspace it was asked in and still has
// the project; a reply that comes after the window left gives no menu. The real renderer store, main's reply held until
// the test lets it go.
import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceInfo } from '../src/shared/types'

/** Replies to templates:list, held until the test resolves them. */
const pending: ((v: unknown) => void)[] = []
;(globalThis as unknown as { window: unknown }).window = {
  hive: { invoke: (channel: string) => (channel === 'templates:list' ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(null)), on: () => () => {} },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}
// The renderer's modules, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface RendererStore {
  set: (u: Record<string, unknown>) => void
}
type Listed = { file: string; agentNames?: string[] }[] | null
const rendererStore = '../src/renderer/src/store'
const rendererList = '../src/renderer/src/templateList'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore
const { templatesStillHere } = (await import(/* @vite-ignore */ rendererList)) as { templatesStillHere: (path: string) => Promise<Listed> }

const project = (path: string) => ({ path, name: path.split('/').pop(), agents: [] })
const wsA = { path: 'C:/ws-a', projects: [project('C:/ws-a/alpha')] } as unknown as WorkspaceInfo
const wsB = { path: 'C:/ws-b', projects: [project('C:/ws-b/beta')] } as unknown as WorkspaceInfo
const LIST = [{ file: 'team-3x3.json', agentNames: ['AL-B1', 'AL-B2', 'AL-B3', 'AL-R1', 'AL-R2', 'AL-R3'] }]

beforeEach(() => {
  pending.length = 0
  store.set({ workspace: wsA })
})

describe("Add Agent from Template's list (HI-1948)", () => {
  it('still on the workspace: the list as main sent it, its agents named for the project', async () => {
    const listed = templatesStillHere('C:/ws-a/alpha')
    pending.shift()!(LIST)
    expect(await listed).toEqual(LIST)
  })

  it('the window moved to another workspace before the reply: no menu', async () => {
    const listed = templatesStillHere('C:/ws-a/alpha')
    store.set({ workspace: wsB })
    pending.shift()!(LIST)
    expect(await listed).toBeNull()
  })

  it('the project gone from the workspace before the reply: no menu', async () => {
    const listed = templatesStillHere('C:/ws-a/alpha')
    store.set({ workspace: { ...wsA, projects: [] } })
    pending.shift()!(LIST)
    expect(await listed).toBeNull()
  })
})
