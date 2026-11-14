// A restart (the project toolbar's, the Assistant's mode change: stopped, then resumed at once) resumes its conversation
// with its own agent where it ran in a slot (HI-3213: MB1's restart in mcp's slot-a was refused as "a worktree no agent
// uses any more", its slot dropped from what was resumed). The real renderer actions, with the window's IPC faked.
import { describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../src/shared/types'

;(globalThis as unknown as { window: unknown }).window = {
  combwork: { invoke: async () => null, on: () => () => {} },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}

// The renderer's module, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface Item {
  id: string
  agentId?: string
  cwd?: string
  slot?: string
}
const rendererActions = '../src/renderer/src/actions'
const actions = (await import(/* @vite-ignore */ rendererActions)) as {
  restartItem: (live: { sessionId: string; agentId: string }, item: { name?: string; cwd?: string; slot?: string } | undefined) => Item
  resumeTarget: (p: ProjectInfo | undefined, item: Item, preferred?: string) => string | null
}

const project = { path: 'D:\\HIVE\\mcp', name: 'mcp', agents: [{ id: 'a-mb1', name: 'MB1', place: { is: 'slot', folder: 'D:\\HIVE.worktrees\\mcp\\slot-a' } }, { id: 'a-mr1', name: 'MR1', place: { is: 'project', folder: 'D:\\HIVE\\mcp' } }] } as unknown as ProjectInfo

describe('what a restart resumes (HI-3213)', () => {
  it('a conversation that ran in a slot keeps its slot, so its own agent resumes it', () => {
    const listed = { name: 'mcp · MB1', cwd: 'D:\\HIVE.worktrees\\mcp\\slot-a', slot: 'slot-a' }
    const item = actions.restartItem({ sessionId: '47045579', agentId: 'a-mb1' }, listed)
    expect(item).toMatchObject({ id: '47045579', agentId: 'a-mb1', cwd: listed.cwd, slot: 'slot-a' })
    expect(actions.resumeTarget(project, item, 'a-mb1')).toBe('a-mb1')
    // Before: its slot dropped, the slot's folder read as a 0.9 worktree no agent works in.
    expect(actions.resumeTarget(project, { ...item, slot: undefined }, 'a-mb1')).toBeNull()
  })

  it('one in the project folder, or not listed, resumes as before', () => {
    expect(actions.restartItem({ sessionId: 's1', agentId: 'a-mr1' }, { name: 'x', cwd: project.path })).not.toHaveProperty('slot')
    const unlisted = actions.restartItem({ sessionId: 's2', agentId: 'a-mr1' }, undefined)
    expect(unlisted).toMatchObject({ id: 's2', agentId: 'a-mr1' })
    expect(actions.resumeTarget(project, unlisted, 'a-mr1')).toBe('a-mr1')
  })
})
