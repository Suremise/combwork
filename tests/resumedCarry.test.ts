// A slot the agent's own Resume took (#1434: a free slot of the pool, under a carried lease) taken over by its next lane
// or card even when its line isn't merged (HI-1741): HB3's Resume took slot-f, on a card's line still in review; its lane
// was lent slot-d beside it, and with a pool sized to the builders another builder found no slot free. Its line stays
// when the slot moves to the new one. Left only while a branch holds its head (or it is merged) and it has no changes not
// committed; the checkout decided on is checked again in the handover's write. A handover not possible just then ends it
// once the new lease exists, the slot pass retrying while an operation or job holds it. Each test has its own
// workspace, board, pool and git; the rules are on; no session starts.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => true }))
// B1's lane, running (the slot pass ends a lane's lease once its lane isn't): only what the pass reads of it.
vi.mock('../src/main/lanes', async (orig) => ({ ...(await orig<object>()), rawLanes: async () => [{ id: 'lane-b1', state: 'active', cards: [] }] }))

const base = tempDir('resumedcarry-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardFile, boardRead } = await import('../src/main/boardStore')
const { SlotStore, fileSlotConn } = await import('../src/main/slots')
const { leaseForStart, lendLane, retireWaitOf, settleSlotCards } = await import('../src/main/slotCards')
const { holder, poolFor } = await import('../src/main/slotsApp')
const { sessions } = await import('../src/main/sessions')
const { loadedWatchFor } = await import('../src/main/watches')
const tasks = await import('../src/main/tasks')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const HUNG_MS = 20_000
type Ws = ReturnType<typeof createWorkspaceService>
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** A workspace of its own: project alpha with builders B1 and B2 (the pool's size), git on main. */
async function setup(name: string) {
  const wsPath = join(base, name, 'ws')
  const project = join(wsPath, 'alpha')
  gitRepo(project)
  commit(project, { '.gitignore': '.hive/\n', 'a.txt': 'a\n' }, 'first')
  const builder = (id: string) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: 'builder' })
  const write = (id: string): void => writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id, agents: [builder('b1'), builder('b2')] }))
  const ws: Ws = createWorkspaceService()
  mkdirSync(join(project, '.hive'), { recursive: true })
  write('p1')
  await ws.open(wsPath)
  const projectId = (await ws.projectConfig(project)).id ?? 'p1'
  write(projectId)
  await ws.refresh()
  const store = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
  cleanups.push(async () => {
    store.conn.close()
    await disposeWorkspaceService(ws)
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
  const pool = await run(() => poolFor(ws, project))
  const card = async (title: string, agent: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', agent }, { kind: 'user' }))).number
  const start = (n: number, agent: string) => run(() => leaseForStart(ws, project, { id: n }, agent, { dry: false, target: 'main' }))
  const lane = () => run(() => lendLane(ws, project, 'lane-b1', 'b1', 'main'))
  const leases = (agent: string) => store.openLeases().filter((l) => l.agent === agent)
  const leaseRow = (id: string) => boardRead(ws, (db) => db.prepare('SELECT why, ended_at FROM slot_leases WHERE id = ?').get(id) as { why: string | null; ended_at: string | null })
  const setWriter = async (slot: string, writerRun: string, lease: string): Promise<void> => {
    const me = await holder.self()
    await store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run(writerRun, lease, 'b1', me.pid, me.started, projectId, slot))
  }

  /**
   * B1's card X built in a slot on its line with a commit not merged, its lease ended (put back: the card waits in
   * review), then B1's Resume taking that free slot again under a carried lease (claimIn's carryIn), its run writing there.
   * `before` runs on the slot first (its checkout as the test wants it when Resume takes it).
   */
  const resumedB1 = async (before?: (folder: string, line: string) => void): Promise<{ slot: string; folder: string; line: string; carried: string; run: string }> => {
    const x = await card('X', 'b1')
    const r = await start(x, 'b1')
    if (!r || !('lease' in r)) throw new Error(`no slot for X: ${JSON.stringify(r)}`)
    const line = `hive/x-${x}`
    sh(r.folder, 'switch', '-q', '-c', line)
    commit(r.folder, { 'x.txt': 'x\n' }, 'X: work not merged')
    before?.(r.folder, line)
    expect(await pool.release(r.lease, 'putBack')).toBe(true)
    await pool.drained(r.slot)
    // Put back, a clean slot is detached at its target (HI-2014; its line kept, with X's work): B1, resumed there, takes
    // its line again. A test's own `before` (detached, its line gone) sets where it is itself.
    if (!before) sh(r.folder, 'switch', '-q', line)
    const carried = await pool.carry('b1', { name: r.slot, folder: r.folder })
    if (!carried) throw new Error('Resume could not take the slot')
    const RUN = 'run-b1'
    await setWriter(r.slot, RUN, carried.id)
    expect(pool.resumedCarry(carried)).toBe(true)
    return { slot: r.slot, folder: r.folder, line, carried: carried.id, run: RUN }
  }
  /** Kept carried: the lane lent another slot, the carried lease open, B1 holding both. */
  const keptCarried = async (b1: { slot: string; carried: string }): Promise<void> => {
    const got = await lane()
    expect('slot' in got && got.slot).not.toBe(b1.slot)
    expect(leaseRow(b1.carried)).toMatchObject({ why: null, ended_at: null })
    expect(leases('b1').map((l) => l.kind).sort()).toEqual(['carried', 'lane'])
  }
  return { ws, wsPath, project, projectId, store, pool, run, card, start, lane, leases, leaseRow, setWriter, resumedB1, keptCarried }
}

describe("a slot B1's Resume took, then B1's lane starts (HB3's sequence)", () => {
  it('its line not merged: the lane takes it over (one slot for B1, its run there under the lane), the line stays, and B2 still gets a slot', async () => {
    const t = await setup('handed')
    const b1 = await t.resumedB1()
    expect(await t.lane()).toEqual({ slot: b1.slot })
    expect(t.leaseRow(b1.carried)).toMatchObject({ why: 'handedOff', ended_at: expect.any(String) })
    const mine = t.leases('b1')
    expect(mine.map((l) => [l.kind, l.lane, l.slot])).toEqual([['lane', 'lane-b1', b1.slot]])
    // B1's run goes on in the same folder, now under the lane's lease.
    expect(t.pool.slots().find((s) => s.name === b1.slot)?.writer).toMatchObject({ run: b1.run, lease: mine[0].id })
    // Card X's work is on its line, which stays.
    expect(sh(t.project, 'log', '-1', '--format=%s', b1.line).trim()).toBe('X: work not merged')
    // The pool is sized to its two builders: B2's card still gets a slot of its own.
    const r = await t.start(await t.card('B2s', 'b2'), 'b2')
    expect(r && 'lease' in r ? r.slot : r).toEqual(expect.any(String))
    expect(r && 'lease' in r && r.slot).not.toBe(b1.slot)
    expect(t.leases('b2').map((l) => l.kind)).toEqual(['card'])
  })

  it('changes not committed in it: kept carried (they are its work), and the lane gets another slot', async () => {
    const t = await setup('dirty')
    const b1 = await t.resumedB1()
    writeFileSync(join(b1.folder, 'a.txt'), 'changed\n')
    await t.keptCarried(b1)
  })

  it('detached and not merged: kept (no branch holds its head); detached and merged: taken over', async () => {
    const t = await setup('detached')
    const b1 = await t.resumedB1((folder) => sh(folder, 'switch', '-q', '--detach'))
    await t.keptCarried(b1)

    const m = await setup('detached-merged')
    const b1m = await m.resumedB1((folder, line) => {
      sh(m.project, 'merge', '-q', '--ff-only', line)
      sh(folder, 'switch', '-q', '--detach')
    })
    expect(await m.lane()).toEqual({ slot: b1m.slot })
    expect(m.leaseRow(b1m.carried)).toMatchObject({ why: 'handedOff' })
  })

  it("its HEAD naming a branch that is gone: kept (its head no longer held)", async () => {
    const t = await setup('refgone')
    const b1 = await t.resumedB1((folder) => sh(folder, 'update-ref', '-d', `refs/heads/${sh(folder, 'symbolic-ref', '--short', 'HEAD').trim()}`))
    await t.keptCarried(b1)
  })

  it("its checkout changed after it was decided on, before the handover's write (a commit meanwhile): refused, nothing written; the lane gets another slot, and the pass ends the carried lease from its checkout now", async () => {
    const t = await setup('moved')
    const b1 = await t.resumedB1()
    const handOff = t.pool.handOff.bind(t.pool)
    const spy = vi.spyOn(t.pool, 'handOff').mockImplementationOnce(async (...args) => {
      commit(b1.folder, { 'late.txt': 'late\n' }, 'late work')
      return handOff(...args)
    })
    try {
      const got = await t.lane()
      expect(spy).toHaveBeenCalledOnce()
      expect('slot' in got && got.slot).not.toBe(b1.slot)
    } finally {
      spy.mockRestore()
    }
    // Refused in the write: the late commit is on the line, and nothing of the handover was written. The start's end of
    // the carried lease (after the lend) found it from the checkout as it is now.
    expect(sh(t.project, 'log', '-1', '--format=%s', b1.line).trim()).toBe('late work')
    expect(t.leaseRow(b1.carried)).toMatchObject({ why: 'superseded', ended_at: expect.any(String) })
    expect(t.leases('b1').map((l) => l.kind)).toEqual(['lane'])
  })

  it('an operation on its slot just then: the lane gets another slot; once it ends, the retry ends the carried lease with no start, its run never stopped; the slot drains when the run leaves, and B2 gets it', async () => {
    const t = await setup('job')
    const b1 = await t.resumedB1()
    // The workspace's watches loaded (none is B1's): unloaded, they count as work and no stop would even be looked at.
    expect(await t.run(() => loadedWatchFor(t.ws, t.project, 'b1'))).toBeNull()
    const stops: string[] = []
    const runNow = vi.spyOn(sessions, 'runNow').mockImplementation((_p: string, agent: string) => (agent === 'b1' ? ({ run: b1.run, starting: false } as never) : null))
    const stop = vi.spyOn(sessions, 'stop').mockImplementation((_p: string, agent?: string) => void stops.push(agent ?? ''))
    cleanups.push(() => (runNow.mockRestore(), stop.mockRestore()))
    // An operation of the pool's on the slot (a preparation under its lease, held at its last word before the slot's
    // files would change): the slot is the operation's until it ends.
    let open!: (why: string) => void
    const gate = new Promise<string>((res) => (open = res))
    const prep = t.pool.prepare(b1.carried, { line: 'hive/elsewhere', base: 'main', install: false, ready: () => gate })
    await vi.waitFor(() => expect(t.pool.slots().find((s) => s.name === b1.slot)?.op).toBeTruthy(), { timeout: HUNG_MS })
    const got = await t.lane()
    expect('slot' in got && got.slot).not.toBe(b1.slot)
    // Held while the operation runs, a pass later too: one retry waits, never a second beside it.
    expect(retireWaitOf(t.wsPath, t.project)).toEqual({ tries: 1, waiting: true })
    await t.run(() => settleSlotCards(t.ws, t.project))
    expect(t.leaseRow(b1.carried)).toMatchObject({ why: null, ended_at: null })
    expect(retireWaitOf(t.wsPath, t.project)).toEqual({ tries: 1, waiting: true })
    // The operation ends, changing nothing (not now): the retry (the pass asked for again after its pause) ends the
    // carried lease, nothing else asked.
    open('the test: not now')
    expect(await prep).toMatchObject({ retry: 'the test: not now' })
    expect(sh(b1.folder, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(b1.line)
    await vi.waitFor(() => expect(t.leaseRow(b1.carried)).toMatchObject({ why: 'superseded', ended_at: expect.any(String) }), { timeout: HUNG_MS, interval: 100 })
    // B1's run in the old folder holds the lane's lease: never stopped (HI-1731), and it keeps the slot until it leaves.
    expect(stops).toEqual([])
    expect(t.pool.slots().find((s) => s.name === b1.slot)?.writer).toMatchObject({ run: b1.run, lease: b1.carried })
    expect(sh(t.project, 'log', '-1', '--format=%s', b1.line).trim()).toBe('X: work not merged')
    // The run leaves (its next start in the lane's slot): the old slot drains, and B2's card gets it.
    expect(await t.store.clearWriterRun(b1.run)).toContain(b1.slot)
    await t.pool.drained(b1.slot)
    const r = await t.start(await t.card('B2s', 'b2'), 'b2')
    expect(r && 'lease' in r ? r.slot : r).toBe(b1.slot)
    expect(stops).toEqual([])
  })
})

describe("the retirement's retry goes with its workspace", () => {
  it('the workspace closing while a retry waits drops it; nothing of it runs after', async () => {
    const t = await setup('closing')
    const b1 = await t.resumedB1()
    let open!: (why: string) => void
    const gate = new Promise<string>((res) => (open = res))
    const prep = t.pool.prepare(b1.carried, { line: 'hive/elsewhere', base: 'main', install: false, ready: () => gate })
    await vi.waitFor(() => expect(t.pool.slots().find((s) => s.name === b1.slot)?.op).toBeTruthy(), { timeout: HUNG_MS })
    await t.lane()
    expect(retireWaitOf(t.wsPath, t.project)).toEqual({ tries: 1, waiting: true })
    // The workspace closes: its pools wait for the operation, which then ends; its lifetime ends, and the retry with it.
    const life = t.ws.lifetime
    const closing = disposeWorkspaceService(t.ws)
    open('the test: closing')
    await prep
    await closing
    expect(life.aborted).toBe(true)
    expect(retireWaitOf(t.wsPath, t.project)).toBeNull()
    // Its carried lease as it was (read from the board's file): nothing ran for it after.
    expect(t.store.lease(b1.carried)).toMatchObject({ to: null, why: null })
  })
})

describe("a carried lease's origin (SlotStore.resumedCarry), whatever the timestamps", () => {
  it("Resume's: a card's lease on the slot in the same millisecond still counts; an adopted worktree's: none since its slot was made, history under its name from before doesn't count", async () => {
    const t = await setup('origin')
    const b1 = await t.resumedB1()
    const carried = t.store.lease(b1.carried)!
    // The card's lease and the carried one in the same millisecond.
    const last = t.store.conn.read((db) => db.prepare("SELECT id FROM slot_leases WHERE project = ? AND slot = ? AND kind = 'card'").get(t.projectId, b1.slot) as { id: string }).id
    await t.store.conn.write((db) => db.prepare('UPDATE slot_leases SET from_at = ? WHERE id = ?').run(carried.from, last))
    expect(t.store.resumedCarry(carried)).toBe(true)
    // An adopted worktree: its slot made with its carried lease (carry on a slot the pool hasn't got), the only lease
    // since; an older card's lease under the same name, before the slot was made, doesn't count.
    const folder = join(t.wsPath, '..', 'adopted')
    sh(t.project, 'worktree', 'add', '-q', '-b', 'hive/hb2', folder)
    const adopted = (await t.pool.carry('b2', { name: 'hb2', folder }))!
    expect(adopted).toMatchObject({ kind: 'carried', slot: 'hb2' })
    expect(t.store.resumedCarry(adopted)).toBe(false)
    await t.store.conn.write((db) => db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, lane, agent, from_at, ended_at, why) VALUES ('l-old', ?, 'hb2', 'card', 1, NULL, 'b2', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'done')").run(t.projectId))
    expect(t.store.resumedCarry(adopted)).toBe(false)
  })
})
