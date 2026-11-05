// A lease's end (#1434, SPEC §16.10.2; slotsApp.ts's stopLeaseSession): the run writing in its slot under it (the
// slot's writer) is stopped once its turn has finished (not in a turn, no run going); a start of it still being prepared
// gives up. Only that run: one that replaced it (the agent started again, in this slot under a new lease or elsewhere)
// is never stopped for the old lease, nor a run of another lease, nor anything once that run is over.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionState } from '../src/shared/types'
import { tempDir } from './tempDir'

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

/** The project's lanes as kept, and each agent's watch, as lanes.ts and watches.ts give them. */
let lanesNow: { id: string; project: string; state: string; builder: { id: string }; reviewer?: { id: string } | null }[] = []
const watching = new Map<string, { label: string } | 'unknown'>()
// Only watchKnown, never the original module (HI-1786): were slotsApp loaded from inside this factory (as it was through
// cardStall → reviewCopies until HI-1785), its import('./watches') would get the original, not this.
vi.mock('../src/main/watches', () => ({ watchKnown: (_p: string, agent: string) => watching.get(agent) ?? null }))
/** The project's cards in flight its agent builds or reviews, as the board's query finds them (none: undefined). */
let inFlight: { number: number } | undefined
let boardFails = false
let reads = 0
/** The board's reads so far: each look reads the lanes' and the cards' tables. */
const asked = (): number => reads
vi.mock('../src/main/boardStore', async (orig) => ({
  ...(await orig<object>()),
  boardRead: (_ws: unknown, fn: (db: unknown) => unknown) => {
    if (boardFails) throw new Error('the board is closing')
    reads++
    // The lanes' table (a running lane of the project the agent builds or reviews), else the cards' (one in flight).
    return fn({
      prepare: (sql: string) => ({
        get: (project: string, builder: string, reviewer: string) => {
          if (!/FROM lanes/.test(sql)) return inFlight
          const l = lanesNow.find((x) => x.state === 'active' && x.project.toLowerCase() === project.toLowerCase() && (x.builder.id === builder || x.reviewer?.id === reviewer))
          return l ? { id: l.id, builder: l.builder.id } : undefined
        }
      })
    })
  }
}))

const { tellListeners } = await import('../src/main/events')
const { setAgentBusy } = await import('../src/main/workflow/lineUpdates')
const { setRunsGoing } = await import('../src/main/workflow/service')
const { stopLeaseSession } = await import('../src/main/slotsApp')
const { advanced } = await import('../src/main/advanced')
const { LANES_GENTLE_END } = await import('../src/shared/advanced')
advanced.load(tempDir('cw-leaseend-'))

const P = 'C:\\ws\\project'
type SlotArg = Parameters<typeof stopLeaseSession>[2]
const slotWith = (writer: { run: string; lease: string } | null): SlotArg => ({ name: 'slot-b', folder: 'C:\\ws.worktrees\\project\\slot-b', writer: writer && { ...writer, agent: 'b1', pid: 1, started: 1 } }) as SlotArg
const LEASE = { id: 'l1', agent: 'b1', why: 'done' } as Parameters<typeof stopLeaseSession>[1]
/** A lane's lease, and the workspace and pool its end is given (a pool whose slot's writer is still run-1). */
const LANE_LEASE = { id: 'l1', agent: 'b1', why: 'laneEnded', lane: 'lane-1', to: new Date().toISOString() } as Parameters<typeof stopLeaseSession>[1]
const AT = { ws: { lifetime: new AbortController().signal }, pool: { slots: () => [slotWith({ run: 'run-1', lease: 'l1' })] } } as unknown as NonNullable<Parameters<typeof stopLeaseSession>[3]>
const status = (): void => tellListeners({ type: 'session-status', state: { agentId: 'b1', projectPath: P } as LiveSessionState })

afterEach(() => {
  inFlight = undefined
  boardFails = false
  reads = 0
  lanesNow = []
  watching.clear()
  runs.clear()
  // A look still listening (a carried lease's that found work, HI-1784) sees its run gone and lets go.
  status()
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

  it("a lane's lease with the gentle end turned off (HI-1706): stopped at its first idle moment, as before", async () => {
    await advanced.set(LANES_GENTLE_END, false)
    try {
      runs.set('b1', { run: 'run-1', starting: false })
      stopLeaseSession(P, LANE_LEASE, slotWith({ run: 'run-1', lease: 'l1' }), AT)
      expect(stopped).toEqual(['b1:run-1'])
    } finally {
      await advanced.set(LANES_GENTLE_END, true)
    }
  })

  it("a lane's lease with it on is ended gently, never stopped at its first idle moment (HI-1706)", () => {
    runs.set('b1', { run: 'run-1', starting: false })
    stopLeaseSession(P, LANE_LEASE, slotWith({ run: 'run-1', lease: 'l1' }), AT)
    status()
    expect(stopped).toEqual([])
  })

  it("a lane's reviewer holds no lease: its end stops only the slot's writer, never the reviewer (HI-1706)", async () => {
    await advanced.set(LANES_GENTLE_END, false)
    try {
      runs.set('b1', { run: 'run-1', starting: false })
      runs.set('r1', { run: 'run-r', starting: false })
      stopLeaseSession(P, LANE_LEASE, slotWith({ run: 'run-1', lease: 'l1' }), AT)
      expect(stopped).toEqual(['b1:run-1'])
      expect(runs.get('r1')).toEqual({ run: 'run-r', starting: false })
    } finally {
      await advanced.set(LANES_GENTLE_END, true)
    }
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

describe("a carried lease's end never stops an agent with work elsewhere (HI-1731)", () => {
  /** HB3's: an adopted worktree's lease kept for a card, ended as that card went to Done. */
  const CARRIED = { id: 'l1', agent: 'b1', kind: 'carried', why: 'cardEnded', card: null, lane: null, to: new Date().toISOString() } as unknown as Parameters<typeof stopLeaseSession>[1]
  const at = (open: { id: string; kind: string; card?: number | null; lane?: string | null; to?: string | null }[] = []) => ({ ws: { lifetime: new AbortController().signal }, pool: { slots: () => [slotWith({ run: 'run-1', lease: 'l1' })], leasesOf: () => open.map((l) => ({ card: null, lane: null, to: null, ...l })) } }) as unknown as NonNullable<Parameters<typeof stopLeaseSession>[3]>

  it('building a running lane: its session goes on, at its first idle moment and after', async () => {
    runs.set('b1', { run: 'run-1', starting: false })
    lanesNow = [{ id: 'lane-b', project: 'project', state: 'active', builder: { id: 'b1' } }]
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    status()
    expect(stopped).toEqual([])
    expect(runs.get('b1')).toEqual({ run: 'run-1', starting: false })
  })

  it('holding another lease (a card started since), or watching: goes on too', async () => {
    runs.set('b1', { run: 'run-1', starting: false })
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at([{ id: 'l1', kind: 'carried', to: 'x' }, { id: 'l2', kind: 'card', card: 7 }]))
    watching.set('b1', { label: 'Waiting for HI-9 → Review' })
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    status()
    expect(stopped).toEqual([])
  })

  it("reviewing a running lane, a card in flight it builds or reviews (no lease yet), or watches not loaded: goes on", async () => {
    runs.set('b1', { run: 'run-1', starting: false })
    lanesNow = [{ id: 'lane-r', project: 'project', state: 'active', builder: { id: 'b9' }, reviewer: { id: 'b1' } }]
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    lanesNow = []
    inFlight = { number: 12 }
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    inFlight = undefined
    watching.set('b1', 'unknown')
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    status()
    expect(stopped).toEqual([])
  })

  it("what can't be told counts as work: a board read that fails keeps it running", async () => {
    runs.set('b1', { run: 'run-1', starting: false })
    boardFails = true
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    status()
    expect(stopped).toEqual([])
  })

  it('work arriving while it waits for its turn to end is seen just before the stop: it goes on', async () => {
    runs.set('b1', { run: 'run-1', starting: false })
    let busy = true
    setAgentBusy(() => busy)
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    // Its turn starts a card meanwhile (no lease yet); at the idle moment the look, made then with nothing awaited (and
    // the first it makes: in a turn till then), sees it.
    expect(asked()).toBe(0)
    inFlight = { number: 13 }
    busy = false
    status()
    expect(asked()).toBe(2)
    expect(stopped).toEqual([])
  })

  it('work that ends after its lease is asked again at each idle moment: once there is none, it is stopped (HI-1784)', async () => {
    // B1's: the lane's carried lease ended as its last card was merged, its watch on that card not ended yet.
    runs.set('b1', { run: 'run-1', starting: false })
    watching.set('b1', { label: 'Waiting for AL-2 → Passed' })
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    status()
    expect(stopped).toEqual([])
    // Its watch ends (a status event), it takes its turn, and is idle again with nothing.
    let busy = true
    setAgentBusy(() => busy)
    watching.clear()
    status()
    expect(stopped).toEqual([])
    busy = false
    status()
    expect(stopped).toEqual(['b1:run-1'])
  })

  it("work found is never asked again once its run has left the slot (the slot's writer another run, or none)", async () => {
    runs.set('b1', { run: 'run-1', starting: false })
    watching.set('b1', { label: 'Waiting for HI-9 → Review' })
    let writer: { run: string; lease: string } | null = { run: 'run-1', lease: 'l1' }
    const moving = { ...at(), pool: { ...at().pool, slots: () => [slotWith(writer)] } } as unknown as NonNullable<Parameters<typeof stopLeaseSession>[3]>
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), moving)
    expect(asked()).toBe(2)
    // Its next start elsewhere moved it: the slot drains, and its looks end there, never reading the board again.
    writer = null
    watching.clear()
    status()
    status()
    expect(asked()).toBe(2)
    expect(stopped).toEqual([])
  })

  it("work arriving during its one await (before the first look) is seen too: B's lease made then", async () => {
    runs.set('b1', { run: 'run-1', starting: false })
    const open: { id: string; kind: string; card?: number | null }[] = []
    const ended = stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at(open))
    // While the look waits for its one import, B's start lends B's lease.
    open.push({ id: 'l2', kind: 'card', card: 21 })
    await ended
    status()
    expect(stopped).toEqual([])
  })

  it("a lane of another project, or one it doesn't build, or one ended, isn't work of its: stopped once idle, as before", async () => {
    runs.set('b1', { run: 'run-1', starting: false })
    lanesNow = [
      { id: 'lane-x', project: 'other', state: 'active', builder: { id: 'b1' } },
      { id: 'lane-y', project: 'project', state: 'active', builder: { id: 'b2' } },
      { id: 'lane-z', project: 'project', state: 'ended', builder: { id: 'b1' } }
    ]
    let busy = true
    setAgentBusy(() => busy)
    await stopLeaseSession(P, CARRIED, slotWith({ run: 'run-1', lease: 'l1' }), at())
    status()
    expect(stopped).toEqual([])
    busy = false
    status()
    // Asked again just before (an await), then stopped.
    await vi.waitFor(() => expect(stopped).toEqual(['b1:run-1']))
  })
})
