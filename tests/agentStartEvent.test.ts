// An agent's start told to the window (HI-1977): main's `agent-start` event sets the agent's `start` in the store at once,
// for the board's Stalled mark (stallAgentOf): starting isn't stalled, a failure says why, and null clears it. Only that
// agent of that project changes, its project found by path in any case. A read of the project made before a change and
// arriving after it (HR6's round 1) doesn't undo it: the change stands until a read as new as it (its `startSeq`). The
// real renderer store.
import { describe, expect, it } from 'vitest'
import type { AgentInfo, WorkspaceInfo } from '../src/shared/types'
import { stallAgentOf } from '../src/shared/tasks'

;(globalThis as unknown as { window: unknown }).window = { hive: { invoke: async () => null, on: () => () => {} }, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) }
// The renderer's module, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface RendererStore {
  get: () => { workspace: WorkspaceInfo }
  set: (u: Record<string, unknown>) => void
  showWorkspace: (ws: WorkspaceInfo | null, other: boolean) => void
  agentStartChanged: (path: string, agentId: string, start: AgentInfo['start'] | null, seq: number) => void
}
const rendererStore = '../src/renderer/src/store'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore

// Each test's counts start past the last's: the store keeps what it was told for the module's life, as the window does.
let base = 0
const agent = (id: string, startSeq: number, start?: AgentInfo['start']): AgentInfo => ({ id, name: id.toUpperCase(), live: null, startSeq, ...(start ? { start } : {}) }) as AgentInfo
const project = (name: string, startSeq: number, b1Start?: AgentInfo['start']) => ({ name, path: `D:\\ws\\${name}`, agents: [agent('b1', startSeq, b1Start), agent('b2', startSeq)] })
/** The workspace as main reads it, at `startSeq` changes. */
const read = (startSeq: number, b1Start?: AgentInfo['start']): WorkspaceInfo => ({ path: 'D:\\ws', projects: [project('alpha', startSeq, b1Start), project('beta', startSeq)] }) as unknown as WorkspaceInfo
const agentOf = (projectName: string, id: string): AgentInfo => store.get().workspace.projects.find((p) => p.name === projectName)!.agents.find((a) => a.id === id)!
const markOf = () => stallAgentOf(agentOf('alpha', 'b1'))

describe("an agent's start told to the window (HI-1977)", () => {
  it("sets that agent's start: starting, then failed with why, then cleared", () => {
    base += 100
    store.set({ workspace: read(base) })
    store.agentStartChanged('d:\\WS\\alpha', 'b1', { starting: true }, base + 1)
    expect(agentOf('alpha', 'b1').start).toEqual({ starting: true })
    expect(markOf()).toEqual({ name: 'B1', running: true, failed: null, waiting: null })
    // Nothing else changes.
    expect(agentOf('alpha', 'b2')).not.toHaveProperty('start')
    expect(agentOf('beta', 'b1')).not.toHaveProperty('start')

    store.agentStartChanged('D:\\ws\\alpha', 'b1', { failed: 'error: unknown option --bogus' }, base + 2)
    expect(markOf()).toEqual({ name: 'B1', running: false, failed: 'error: unknown option --bogus', waiting: null })

    store.agentStartChanged('D:\\ws\\alpha', 'b1', null, base + 3)
    expect(agentOf('alpha', 'b1')).not.toHaveProperty('start')
    expect(markOf()).toEqual({ name: 'B1', running: false, failed: null, waiting: null })
  })

  it('a project not in the window changes nothing', () => {
    base += 100
    store.set({ workspace: read(base) })
    const before = store.get().workspace
    store.agentStartChanged('D:\\other\\alpha', 'b1', { starting: true }, base + 1)
    expect(store.get().workspace).toBe(before)
  })

  it("a read made before a start, arriving after it, doesn't undo it; a read as new as it replaces it (HR6's round 1)", () => {
    base += 100
    store.set({ workspace: read(base) })
    // A refresh reads B1 (nothing under way), then B1's start begins and is told, then that read arrives.
    const older = read(base)
    store.agentStartChanged('D:\\ws\\alpha', 'b1', { starting: true }, base + 1)
    store.showWorkspace(older, false)
    expect(markOf()).toEqual({ name: 'B1', running: true, failed: null, waiting: null })
    // Set any other way too (an action's answer).
    store.set({ workspace: read(base) })
    expect(agentOf('alpha', 'b1').start).toEqual({ starting: true })
    // The refresh after the change, as new as it: its read stands, and later ones too (the start ended meanwhile).
    store.showWorkspace(read(base + 1, { starting: true }), false)
    expect(agentOf('alpha', 'b1').start).toEqual({ starting: true })
    store.showWorkspace(read(base + 2), false)
    expect(agentOf('alpha', 'b1')).not.toHaveProperty('start')
  })

  it("a read made while starting, arriving after the failure, doesn't hide its reason; a clear (a new start, a hold run out) stands too", () => {
    base += 100
    store.set({ workspace: read(base) })
    store.agentStartChanged('D:\\ws\\alpha', 'b1', { starting: true }, base + 1)
    const starting = read(base + 1, { starting: true })
    store.agentStartChanged('D:\\ws\\alpha', 'b1', { failed: "Combwork couldn't get slot-a ready: busy" }, base + 2)
    store.showWorkspace(starting, false)
    expect(markOf()).toEqual({ name: 'B1', running: false, failed: "Combwork couldn't get slot-a ready: busy", waiting: null })
    // Cleared (a hold run out, told as a change): an older read that had it starting doesn't bring it back.
    store.agentStartChanged('D:\\ws\\alpha', 'b1', null, base + 3)
    store.showWorkspace(starting, false)
    expect(agentOf('alpha', 'b1')).not.toHaveProperty('start')
    // A change told twice, or out of turn, is the newer one's.
    store.agentStartChanged('D:\\ws\\alpha', 'b1', { starting: true }, base + 2)
    expect(agentOf('alpha', 'b1')).not.toHaveProperty('start')
  })
})
