// The slot a builder's own run still writes in, its lease ended, taken over by its next lane or card (HI-1762): HB5's
// lane ended with its session in its turn in slot-a (HI-1706's gentle end waiting for that turn), and its next lane's
// start, in that turn, found no slot free in a pool sized to the builders: its own writer held the only idle one. Now
// the start takes that slot over in one write (the lease begun on it, the writer moved to it, its conversations rebound),
// and the old lease's end no longer owns the run: the gentle end stops (its fence lost) and a card's plain end never
// stops it. One agent, one slot: an own slot that can't be taken over just then makes the start wait, never lent a
// second one, and a dry start says the same. Another agent's writer is never taken. Each test has its own workspace,
// board, pool and git; the rules are on; the run is a stand-in (sessions spied), nothing is started.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => true }))
// The lanes running (the slot pass ends a lane's lease once its lane isn't): the next ones, never the one that ended.
const { running } = vi.hoisted(() => ({ running: new Set<string>() }))
vi.mock('../src/main/lanes', async (orig) => ({ ...(await orig<object>()), rawLanes: async () => [...running].map((id) => ({ id, state: 'active', cards: [] })) }))

const base = tempDir('writtenslot-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardFile, boardRead, boardWrite, boardWriteOp } = await import('../src/main/boardStore')
const { SlotStore, fileSlotConn } = await import('../src/main/slots')
const { leaseForStart, lendLane } = await import('../src/main/slotCards')
const { holder, laneEndOf, poolFor } = await import('../src/main/slotsApp')
const { sessions } = await import('../src/main/sessions')
const { tellListeners } = await import('../src/main/events')
const { setAgentBusy } = await import('../src/main/workflow/lineUpdates')
const tasks = await import('../src/main/tasks')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const HUNG_MS = 20_000
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  running.clear()
})

/** A workspace of its own: project alpha with these builders (the pool's size), git on main; B1's run spied. */
async function setup(name: string, builders = ['b1', 'b2']) {
  const wsPath = join(base, name, 'ws')
  const project = join(wsPath, 'alpha')
  gitRepo(project)
  commit(project, { '.gitignore': '.combwork/\n', 'a.txt': 'a\n' }, 'first')
  const builder = (id: string) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: 'builder' })
  const write = (id: string): void => writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id, agents: builders.map(builder) }))
  const ws = createWorkspaceService()
  mkdirSync(join(project, '.combwork'), { recursive: true })
  write('p1')
  await ws.open(wsPath)
  const projectId = (await ws.projectConfig(project)).id ?? 'p1'
  write(projectId)
  await ws.refresh()
  const store = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
  // B1's run: live (this Combwork's), in a turn until the test ends it; every stop and quit recorded, never done.
  const RUN = 'run-b1'
  let busy = true
  const stops: string[] = []
  const runNow = vi.spyOn(sessions, 'runNow').mockImplementation((_p: string, agent: string) => (agent === 'b1' ? ({ run: RUN, starting: false } as never) : null))
  const stop = vi.spyOn(sessions, 'stop').mockImplementation((_p: string, agent?: string) => void stops.push(`stop ${agent}`))
  const quit = vi.spyOn(sessions, 'quit').mockImplementation(async (_p: string, agent: string) => (stops.push(`quit ${agent}`), 'sent') as never)
  setAgentBusy((_p, agent) => agent === 'b1' && busy)
  cleanups.push(async () => {
    setAgentBusy(null)
    runNow.mockRestore()
    stop.mockRestore()
    quit.mockRestore()
    store.conn.close()
    await disposeWorkspaceService(ws)
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
  const pool = await run(() => poolFor(ws, project))
  const card = async (title: string, agent: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', agent }, { kind: 'user' }))).number
  const start = (n: number, agent: string, dry = false) => run(() => leaseForStart(ws, project, { id: n }, agent, { dry, target: 'main' }))
  const lane = (id: string, agent = 'b1') => {
    running.add(id)
    return run(() => lendLane(ws, project, id, agent, 'main'))
  }
  const leases = (agent: string) => store.openLeases().filter((l) => l.agent === agent)
  const writerOf = (slot: string) => pool.slots().find((s) => s.name === slot)?.writer ?? null
  const setWriter = async (slot: string, lease: string, agent = 'b1', who?: { pid: number; started: number }): Promise<void> => {
    const me = who ?? (await holder.self())
    await store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run(agent === 'b1' ? RUN : `run-${agent}`, lease, agent, me.pid, me.started, projectId, slot))
  }
  /** B1's conversation, recorded in the slot under the lease (#1434), as a start binds it. */
  const bindSession = async (lease: string, folder: string): Promise<void> => {
    await run(() => ws.upsertSession(project, { id: 's-b1', agent: 'claude-code', agentId: 'b1', cwd: folder, name: 's-b1', lastActiveAt: new Date().toISOString() }))
    const host = (await ws.sessionScope(project)).scope
    await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare('UPDATE sessions SET lease = ? WHERE host = ? AND id = ?').run(lease, host, 's-b1')))
  }
  const sessionLease = async (): Promise<string | null> => {
    const host = (await ws.sessionScope(project)).scope
    return boardRead(ws, (db) => (db.prepare('SELECT lease FROM sessions WHERE host = ? AND id = ?').get(host, 's-b1') as { lease: string | null } | undefined)?.lease ?? null)
  }
  const status = (): void => tellListeners({ type: 'session-status', state: { agentId: 'b1', projectPath: project } as never })
  const idle = (): void => {
    busy = false
    status()
  }
  /** B1's lane in a slot, its run writing there under it, its conversation bound to it; then the lane ends (B1 in its turn). */
  const laneEndedWithB1There = async (): Promise<{ slot: string; old: string }> => {
    const first = await lane('lane-old')
    if (!('slot' in first)) throw new Error(JSON.stringify(first))
    const old = leases('b1')[0]
    await setWriter(first.slot, old.id)
    await bindSession(old.id, pool.slots().find((s) => s.name === first.slot)!.folder)
    running.delete('lane-old')
    expect(await pool.release(old.id, 'laneEnded')).toBe(true)
    return { slot: first.slot, old: old.id }
  }
  return { ws, project, projectId, store, pool, run, card, start, lane, leases, writerOf, setWriter, bindSession, sessionLease, idle, status, stops, laneEndedWithB1There }
}

describe("B1's next start takes over the slot its own run still writes in (HI-1762)", () => {
  it("a lane's gentle end waiting for B1's turn, the pool full but for it: a dry start names it, B1's next lane takes it (writer and conversation moved), and the old end ends nothing", async () => {
    const t = await setup('lane')
    const b1 = await t.laneEndedWithB1There()
    const ending = laneEndOf(b1.old)
    expect(ending).not.toBeNull()
    // B2 takes the pool's other slot: B1's own is the only one left.
    const r2 = await t.start(await t.card('B2s', 'b2'), 'b2')
    expect(r2 && 'lease' in r2 ? r2.slot : r2).not.toBe(b1.slot)
    // The window's dry start for B1 advertises its own slot; its next lane's start, in that same turn, takes it.
    const next = await t.card('B1 next', 'b1')
    expect(await t.start(next, 'b1', true)).toMatchObject({ slot: b1.slot, lease: '' })
    expect(await t.lane('lane-next')).toEqual({ slot: b1.slot })
    const now = t.leases('b1')
    expect(now.map((l) => [l.kind, l.lane, l.slot])).toEqual([['lane', 'lane-next', b1.slot]])
    expect(t.writerOf(b1.slot)).toMatchObject({ run: 'run-b1', lease: now[0].id })
    expect(await t.sessionLease()).toBe(now[0].id)
    // Its turn ends (the idle callback, after the rebinding): the old lane's end has lost its run, so it ends nothing.
    t.idle()
    const why = await Promise.race([ending!, new Promise<string>((res) => setTimeout(() => res('still waiting'), HUNG_MS))])
    expect(why).toBe('the run or its lease is gone: nothing ended')
    expect(t.stops).toEqual([])
  })

  it("a card's plain end, the pool full but for it: B1's next card takes the slot, and the old lease's stop, at B1's idle moment, finds its writer under the new lease: not stopped", async () => {
    const t = await setup('card')
    const x = await t.start(await t.card('X', 'b1'), 'b1')
    if (!x || !('lease' in x)) throw new Error(JSON.stringify(x))
    await t.setWriter(x.slot, x.lease)
    expect(await t.pool.release(x.lease, 'done')).toBe(true)
    const r2 = await t.start(await t.card('B2s', 'b2'), 'b2')
    expect(r2 && 'lease' in r2 ? r2.slot : r2).not.toBe(x.slot)
    const y = await t.start(await t.card('Y', 'b1'), 'b1')
    expect(y && 'lease' in y ? y.slot : y).toBe(x.slot)
    expect(t.writerOf(x.slot)).toMatchObject({ run: 'run-b1', lease: y && 'lease' in y ? y.lease : '' })
    // The old lease's stop looks at B1's idle moment (on its status, at once): its writer is the new lease's, so no stop.
    t.idle()
    expect(t.stops).toEqual([])
  })

  it("taken over by a card for another line than the slot was made from: the slot records that card's target (HI-2185)", async () => {
    const t = await setup('target')
    const x = await t.start(await t.card('X', 'b1'), 'b1')
    if (!x || !('lease' in x)) throw new Error(JSON.stringify(x))
    expect(t.pool.slots().find((s) => s.name === x.slot)?.target).toBe('main')
    await t.setWriter(x.slot, x.lease)
    expect(await t.pool.release(x.lease, 'done')).toBe(true)
    const next = await t.card('Y', 'b1')
    const y = await t.run(() => leaseForStart(t.ws, t.project, { id: next }, 'b1', { dry: false, target: '1.0.0' }))
    expect(y && 'lease' in y ? y.slot : y).toBe(x.slot)
    expect(t.pool.slots().find((s) => s.name === x.slot)?.target).toBe('1.0.0')
    t.idle()
  })

  it("a lane lent before its target was known (a waiting lane's): its card's start records the card's target, and released, the slot waits detached at that line's head (HI-2185)", async () => {
    const t = await setup('held')
    sh(t.project, 'branch', '1.0.0', 'main')
    sh(t.project, 'switch', '-q', '1.0.0')
    commit(t.project, { 'line.txt': 'on 1.0.0\n' }, 'on 1.0.0')
    sh(t.project, 'switch', '-q', 'main')
    // As startWaitingLanes lends it: no target.
    running.add('lane-w')
    const pre = await t.pool.lend({ lane: 'lane-w', agent: 'b1' }, { install: false })
    if (!pre.ok) throw new Error(JSON.stringify(pre.refusal))
    const slotOf = () => t.pool.slots().find((s) => s.name === pre.slot.name)!
    expect(slotOf().target).toBe('main')
    const n = await t.card('Lane card', 'b1')
    // A dry start writes nothing.
    expect(await t.run(() => leaseForStart(t.ws, t.project, { id: n, lane: 'lane-w' }, 'b1', { dry: true, target: '1.0.0' }))).toMatchObject({ slot: pre.slot.name })
    expect(slotOf().target).toBe('main')
    const r = await t.run(() => leaseForStart(t.ws, t.project, { id: n, lane: 'lane-w' }, 'b1', { dry: false, target: '1.0.0' }))
    expect(r && 'lease' in r ? r.lease : r).toBe(pre.lease.id)
    expect(slotOf().target).toBe('1.0.0')
    // Its card's line from 1.0.0, then the lane's lease released: the pool's settle detaches it at 1.0.0's head.
    sh(pre.slot.folder, 'switch', '-q', '-c', 'cw/AM-1-lane-card', '1.0.0')
    commit(pre.slot.folder, { 'work.txt': 'work\n' }, 'work')
    running.delete('lane-w')
    expect(await t.pool.release(pre.lease.id, 'laneEnded')).toBe(true)
    expect(slotOf().state).toBe('ready')
    expect(sh(pre.slot.folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    expect(sh(pre.slot.folder, 'rev-parse', 'HEAD').trim()).toBe(sh(t.project, 'rev-parse', '1.0.0').trim())
  })

  it("a start whose chosen lease ended before it recorded its target: it waits, and the slot's target is left as it was (HI-2185)", async () => {
    const t = await setup('lost')
    sh(t.project, 'branch', '1.0.0', 'main')
    // The slot made from main by an earlier card (a new one records the target it is made from).
    const x = await t.start(await t.card('Earlier', 'b1'), 'b1')
    if (!x || !('lease' in x)) throw new Error(JSON.stringify(x))
    expect(await t.pool.release(x.lease, 'done')).toBe(true)
    const n = await t.card('X', 'b1')
    const spy = vi.spyOn(t.pool, 'serves').mockImplementation(async (lease: string) => (await t.pool.release(lease, 'done'), false))
    try {
      const r = await t.run(() => leaseForStart(t.ws, t.project, { id: n }, 'b1', { dry: false, target: '1.0.0' }))
      expect(r).toMatchObject({ wait: expect.stringMatching(/ended while the start took it/) })
    } finally {
      spy.mockRestore()
    }
    expect(t.pool.slots().every((s) => s.target === 'main')).toBe(true)
  })

  it("its own slot busy just then (a job on it), another slot free: the start waits (a dry start too), never a second slot; once settled, it takes its own", async () => {
    const t = await setup('busy', ['b1', 'b2', 'b3'])
    const b1 = await t.laneEndedWithB1There()
    await t.store.conn.write((db) => db.prepare('UPDATE slots SET job = ? WHERE project = ? AND name = ?').run('job-1', t.projectId, b1.slot))
    const slotsBefore = t.pool.slots().length
    const next = await t.card('B1 next', 'b1')
    expect(await t.start(next, 'b1', true)).toMatchObject({ wait: expect.stringMatching(/own slot .* has a command of its own running: this start waits for it/) })
    expect(await t.lane('lane-next')).toMatchObject({ waiting: expect.stringMatching(/own slot .* has a command of its own running/) })
    expect(t.leases('b1')).toEqual([])
    expect(t.pool.slots().length).toBe(slotsBefore)
    await t.store.jobSettled(b1.slot, 'job-1')
    expect(await t.lane('lane-next')).toEqual({ slot: b1.slot })
  })

  it("another agent's writer is not B1's: B1 is lent another slot; B1's own run held by another Combwork: it waits, never a second slot", async () => {
    const t = await setup('other')
    const first = await t.lane('lane-old')
    if (!('slot' in first)) throw new Error(JSON.stringify(first))
    const old = t.leases('b1')[0]
    await t.setWriter(first.slot, old.id, 'b2')
    running.delete('lane-old')
    await t.pool.release(old.id, 'laneEnded')
    const next = await t.lane('lane-next')
    expect('slot' in next && next.slot).not.toBe(first.slot)

    const u = await setup('otherhive')
    const a = await u.lane('lane-old')
    if (!('slot' in a)) throw new Error(JSON.stringify(a))
    const l = u.leases('b1')[0]
    await u.setWriter(a.slot, l.id, 'b1', { pid: 1, started: 1 })
    running.delete('lane-old')
    await u.pool.release(l.id, 'laneEnded')
    // The window's dry start says what the real one does (HI-1787): both wait, neither advertises nor lends a slot.
    const slotsBefore = u.pool.slots().length
    expect(await u.start(await u.card('B1 next', 'b1'), 'b1', true)).toMatchObject({ wait: expect.stringMatching(/own slot .* is held by another Combwork's run: this start waits for it/) })
    expect(await u.lane('lane-next')).toMatchObject({ waiting: expect.stringMatching(/own slot .* is held by another Combwork's run/) })
    expect(u.leases('b1')).toEqual([])
    expect(u.pool.slots().length).toBe(slotsBefore)
  })
})
