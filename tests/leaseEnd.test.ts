// A lease's end (#1434, SPEC §16.10.2; slotsApp.ts's stopLeaseSession): the run writing in its slot under it (the
// slot's writer) is stopped once its turn has finished (not in a turn, no run going); a start of it still being prepared
// gives up. Only that run: one that replaced it (the agent started again, in this slot under a new lease or elsewhere)
// is never stopped for the old lease, nor a run of another lease, nor anything once that run is over.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionState } from '../src/shared/types'

/** The agent's run now, as sessions.runNow gives it. */
const runs = new Map<string, { run: string; starting: boolean }>()
const stopped: string[] = []

vi.mock('../src/main/sessions', () => ({
  sessions: {
    runNow: (_p: string, agent: string) => runs.get(agent) ?? null,
    stop: (_p: string, agent: string) => {
      stopped.push(`${agent}:${runs.get(agent)?.run ?? '-'}`)
      runs.delete(agent)
    },
    runLive: () => true,
    liveStates: () => []
  }
}))

const { tellListeners } = await import('../src/main/events')
const { setAgentBusy } = await import('../src/main/workflow/lineUpdates')
const { setRunsGoing } = await import('../src/main/workflow/service')
const { stopLeaseSession } = await import('../src/main/slotsApp')

const P = 'C:\\ws\\project'
type SlotArg = Parameters<typeof stopLeaseSession>[2]
const slotWith = (writer: { run: string; lease: string } | null): SlotArg => ({ name: 'slot-b', folder: 'C:\\ws.worktrees\\project\\slot-b', writer: writer && { ...writer, agent: 'b1', pid: 1, started: 1 } }) as SlotArg
const LEASE = { id: 'l1', agent: 'b1', why: 'done' } as Parameters<typeof stopLeaseSession>[1]
const status = (): void => tellListeners({ type: 'session-status', state: { agentId: 'b1', projectPath: P } as LiveSessionState })

afterEach(() => {
  runs.clear()
  stopped.length = 0
  setAgentBusy(null)
  setRunsGoing(null)
})

describe("a lease's end stops the run writing in its slot under it", () => {
  it('at once when that run is idle', () => {
    runs.set('b1', { run: 'run-1', starting: false })
    stopLeaseSession(P, LEASE, slotWith({ run: 'run-1', lease: 'l1' }))
    expect(stopped).toEqual(['b1:run-1'])
  })

  it('only once its turn and its runs have finished, and only once', () => {
    runs.set('b1', { run: 'run-1', starting: false })
    let busy = true
    let going = ['npm test']
    setAgentBusy(() => busy)
    setRunsGoing(() => going)
    stopLeaseSession(P, LEASE, slotWith({ run: 'run-1', lease: 'l1' }))
    status()
    expect(stopped).toEqual([])
    busy = false
    status()
    expect(stopped).toEqual([])
    going = []
    tellListeners({ type: 'progress-changed', workspacePath: 'C:\\ws', runs: [] })
    expect(stopped).toEqual(['b1:run-1'])
    // Started again since: its next run isn't the ended lease's to stop.
    runs.set('b1', { run: 'run-2', starting: false })
    status()
    expect(stopped).toEqual(['b1:run-1'])
  })

  it('never a run that replaced it while it was busy (the old one exited, the agent started again in the folder)', () => {
    runs.set('b1', { run: 'run-1', starting: false })
    let busy = true
    setAgentBusy(() => busy)
    stopLeaseSession(P, LEASE, slotWith({ run: 'run-1', lease: 'l1' }))
    // run-1 exits during its turn's end; run-2 (a new lease of the same slot, say) starts before its last status event.
    runs.set('b1', { run: 'run-2', starting: false })
    busy = false
    status()
    status()
    expect(stopped).toEqual([])
  })

  it('a start of it still being prepared gives up', () => {
    runs.set('b1', { run: 'run-1', starting: true })
    setAgentBusy(() => true)
    stopLeaseSession(P, LEASE, slotWith({ run: 'run-1', lease: 'l1' }))
    expect(stopped).toEqual(['b1:run-1'])
  })

  it("nothing when the slot has no writer, or a writer of another lease, or the run is over", () => {
    runs.set('b1', { run: 'run-1', starting: false })
    stopLeaseSession(P, LEASE, slotWith(null))
    stopLeaseSession(P, LEASE, slotWith({ run: 'run-1', lease: 'l0' }))
    stopLeaseSession(P, LEASE, slotWith({ run: 'run-9', lease: 'l1' }))
    status()
    expect(stopped).toEqual([])
  })
})
