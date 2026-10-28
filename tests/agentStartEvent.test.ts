// An agent's start told to the window (HI-1977): main's `agent-start` event sets the agent's `start` in the store at once,
// for the board's Stalled mark (stallAgentOf): starting isn't stalled, a failure says why, and null clears it. Only that
// agent of that project changes, its project found by path in any case. The real renderer store.
import { describe, expect, it } from 'vitest'
import type { AgentInfo, WorkspaceInfo } from '../src/shared/types'
import { stallAgentOf } from '../src/shared/tasks'

;(globalThis as unknown as { window: unknown }).window = { hive: { invoke: async () => null, on: () => () => {} }, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) }
// The renderer's module, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface RendererStore {
  get: () => { workspace: WorkspaceInfo }
  set: (u: Record<string, unknown>) => void
  agentStartChanged: (path: string, agentId: string, start: AgentInfo['start'] | null) => void
}
const rendererStore = '../src/renderer/src/store'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore

const agent = (id: string): AgentInfo => ({ id, name: id.toUpperCase(), live: null }) as AgentInfo
const project = (name: string) => ({ name, path: `D:\\ws\\${name}`, agents: [agent('b1'), agent('b2')] })
const agentOf = (projectName: string, id: string): AgentInfo => store.get().workspace.projects.find((p) => p.name === projectName)!.agents.find((a) => a.id === id)!

describe("an agent's start told to the window (HI-1977)", () => {
  it('sets that agent\'s start: starting, then failed with why, then cleared', () => {
    store.set({ workspace: { path: 'D:\\ws', projects: [project('alpha'), project('beta')] } as unknown as WorkspaceInfo })
    store.agentStartChanged('d:\\WS\\alpha', 'b1', { starting: true })
    expect(agentOf('alpha', 'b1').start).toEqual({ starting: true })
    expect(stallAgentOf(agentOf('alpha', 'b1'))).toEqual({ name: 'B1', running: true, failed: null })
    // Nothing else changes.
    expect(agentOf('alpha', 'b2')).not.toHaveProperty('start')
    expect(agentOf('beta', 'b1')).not.toHaveProperty('start')

    store.agentStartChanged('D:\\ws\\alpha', 'b1', { failed: 'error: unknown option --bogus' })
    expect(stallAgentOf(agentOf('alpha', 'b1'))).toEqual({ name: 'B1', running: false, failed: 'error: unknown option --bogus' })

    store.agentStartChanged('D:\\ws\\alpha', 'b1', null)
    expect(agentOf('alpha', 'b1')).not.toHaveProperty('start')
    expect(stallAgentOf(agentOf('alpha', 'b1'))).toEqual({ name: 'B1', running: false, failed: null })
  })

  it('a project not in the window changes nothing', () => {
    store.set({ workspace: { path: 'D:\\ws', projects: [project('alpha')] } as unknown as WorkspaceInfo })
    const before = store.get().workspace
    store.agentStartChanged('D:\\other\\alpha', 'b1', { starting: true })
    expect(store.get().workspace).toBe(before)
  })
})
