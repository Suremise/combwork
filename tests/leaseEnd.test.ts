// A lease's end (#1434, SPEC §16.10.2; slotsApp.ts's stopLeaseSession): its builder's session in the slot is stopped
// once its turn has finished (not in a turn, no run going), also one still starting there as the lease ended; a session
// elsewhere, or none, is left alone.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionState } from '../src/shared/types'

const live = new Map<string, Partial<LiveSessionState> & { cwd: string }>()
const starting = new Set<string>()
const stopped: string[] = []

vi.mock('../src/main/sessions', () => ({
  sessions: {
    liveFor: (_p: string, agent: string) => live.get(agent) ?? null,
    startingFor: (_p: string, agent: string) => starting.has(agent),
    stop: (_p: string, agent: string) => {
      stopped.push(agent)
      live.delete(agent)
    },
    liveStates: () => []
  }
}))

const { tellListeners } = await import('../src/main/events')
const { setAgentBusy } = await import('../src/main/workflow/lineUpdates')
const { setRunsGoing } = await import('../src/main/workflow/service')
const { stopLeaseSession } = await import('../src/main/slotsApp')

const P = 'C:\\ws\\project'
const SLOT = { name: 'slot-b', folder: 'C:\\ws.worktrees\\project\\slot-b' } as Parameters<typeof stopLeaseSession>[2]
const LEASE = { id: 'l1', agent: 'b1', why: 'done' } as Parameters<typeof stopLeaseSession>[1]
const status = (): void => tellListeners({ type: 'session-status', state: { agentId: 'b1', projectPath: P } as LiveSessionState })

afterEach(() => {
  live.clear()
  starting.clear()
  stopped.length = 0
  setAgentBusy(null)
  setRunsGoing(null)
})

describe("a lease's end stops its builder's session in the slot", () => {
  it('at once when the builder is idle there', () => {
    live.set('b1', { cwd: SLOT.folder })
    stopLeaseSession(P, LEASE, SLOT)
    expect(stopped).toEqual(['b1'])
  })

  it('only once its turn and its runs have finished', () => {
    live.set('b1', { cwd: SLOT.folder })
    let busy = true
    let runs = ['npm test']
    setAgentBusy(() => busy)
    setRunsGoing(() => runs)
    stopLeaseSession(P, LEASE, SLOT)
    status()
    expect(stopped).toEqual([])
    busy = false
    status()
    expect(stopped).toEqual([])
    runs = []
    tellListeners({ type: 'progress-changed', workspacePath: 'C:\\ws', runs: [] })
    expect(stopped).toEqual(['b1'])
    // Stopped once: later changes don't stop it again.
    live.set('b1', { cwd: SLOT.folder })
    status()
    expect(stopped).toEqual(['b1'])
  })

  it('also a session still starting there as the lease ended, once it runs and is idle', () => {
    starting.add('b1')
    stopLeaseSession(P, LEASE, SLOT)
    expect(stopped).toEqual([])
    starting.delete('b1')
    live.set('b1', { cwd: SLOT.folder })
    status()
    expect(stopped).toEqual(['b1'])
  })

  it('never a session elsewhere (the project folder, another slot), nor when none runs', () => {
    live.set('b1', { cwd: P })
    stopLeaseSession(P, LEASE, SLOT)
    stopLeaseSession(P, { ...LEASE, agent: 'b2' }, SLOT)
    status()
    expect(stopped).toEqual([])
  })
})
