// The Assistant's actions in the window (HI-1863): told by events, shown with the agents' states (setWithLive's batch),
// once by id against the panel's snapshot (assistant:actions), and never in another workspace than the one they were
// told in: a workspace switch shows the previous one's waiting actions and drops them in the same update. The real
// renderer store, with fake timers for its batch, so the order is the window's own.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantAction, WorkspaceInfo } from '../src/shared/types'

;(globalThis as unknown as { window: unknown }).window = { hive: { invoke: async () => null, on: () => () => {} }, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) }
// The renderer's module, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface RendererStore {
  get: () => { assistantActions: AssistantAction[] }
  set: (u: Record<string, unknown> | ((s: { assistantActions: AssistantAction[] }) => Record<string, unknown>)) => void
  setWithLive: (change: () => Record<string, unknown>) => void
  noteAssistantAction: (a: AssistantAction) => void
  showWorkspace: (ws: WorkspaceInfo | null, other: boolean) => void
  useStore: { setState: (u: Record<string, unknown>) => void }
}
const rendererStore = '../src/renderer/src/store'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore
const { withSnapshot } = await import('../src/shared/assistantChangeList')

const workspace = (path: string): WorkspaceInfo => ({ path, projects: [] }) as unknown as WorkspaceInfo
const act = (id: string, at: string): AssistantAction => ({ id, at, text: id, ok: true })
const ids = () => store.get().assistantActions.map((a) => a.id)
/** The panel's snapshot loaded and installed, as Assistant.tsx does. */
const loadSnapshot = (snapshot: AssistantAction[]) => store.set((s) => ({ assistantActions: withSnapshot(s.assistantActions, snapshot) }))
/** A batch under way (the agents' states coming in): what is told next waits for its end. */
const batchUnderWay = () => store.setWithLive(() => ({}))

beforeAll(() => vi.useFakeTimers())
afterAll(() => vi.useRealTimers())
beforeEach(() => {
  vi.runAllTimers()
  store.set({ workspace: workspace('A'), assistantActions: [] })
})

describe("the Assistant's actions told while a batch is under way (HI-1863)", () => {
  it("a workspace switch drops the previous workspace's waiting action: the new one's panel never shows it", () => {
    batchUnderWay()
    store.noteAssistantAction(act('A-action', '2026-10-28T05:00:02Z'))
    store.showWorkspace(workspace('B'), true)
    expect(ids()).toEqual([])
    // B's own history, older than A's action.
    loadSnapshot([act('B-action', '2026-10-28T05:00:01Z')])
    vi.runAllTimers()
    expect(ids()).toEqual(['B-action'])
    // An empty history too.
    store.set({ assistantActions: [] })
    loadSnapshot([])
    expect(ids()).toEqual([])
  })

  it('an action told in one workspace is never shown in another, however its batch ends', () => {
    batchUnderWay()
    store.noteAssistantAction(act('A-action', '2026-10-28T05:00:02Z'))
    // The workspace changed without flushing (not through set): the queued action is A's, so it is left out.
    store.useStore.setState({ workspace: workspace('B') })
    vi.runAllTimers()
    expect(ids()).toEqual([])
  })

  it('the same workspace: an action queued, a snapshot with it loaded, then the batch shown: once', () => {
    batchUnderWay()
    const a = act('a', '2026-10-28T05:00:02Z')
    store.noteAssistantAction(a)
    loadSnapshot([act('z', '2026-10-28T05:00:01Z'), a])
    vi.runAllTimers()
    expect(ids()).toEqual(['z', 'a'])
  })

  it('told twice, and a newer one after a snapshot without it: each once, in order', () => {
    batchUnderWay()
    store.noteAssistantAction(act('a', '1'))
    store.noteAssistantAction(act('a', '1'))
    vi.runAllTimers()
    batchUnderWay()
    store.noteAssistantAction(act('b', '3'))
    vi.runAllTimers()
    loadSnapshot([act('a', '1')])
    expect(ids()).toEqual(['a', 'b'])
  })

  it('the same workspace reported again keeps its actions', () => {
    store.noteAssistantAction(act('a', '1'))
    vi.runAllTimers()
    store.showWorkspace(workspace('A'), false)
    expect(ids()).toEqual(['a'])
  })
})
