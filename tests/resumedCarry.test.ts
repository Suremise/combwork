// A slot the agent's own Resume took (#1434: a free slot of the pool, under a carried lease) taken over by its next lane
// or card even when its line isn't merged (HI-1741): HB3's Resume took slot-f, on a card's line still in review; its lane
// was lent slot-d beside it, and with a pool sized to the builders another builder found no slot free. Its line stays
// when the slot moves to the new one. Changes not committed keep it carried; a handover not possible just then ends it
// once the new lease exists. Each test has its own workspace, board, pool and git; the rules are on; no session starts.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => true }))

const base = tempDir('resumedcarry-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardFile, boardRead } = await import('../src/main/boardStore')
const { SlotStore, fileSlotConn } = await import('../src/main/slots')
const { leaseForStart, lendLane } = await import('../src/main/slotCards')
const { holder, poolFor } = await import('../src/main/slotsApp')
const tasks = await import('../src/main/tasks')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

type Ws = ReturnType<typeof createWorkspaceService>
const cleanups: (() => Promise<void>)[] = []
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
  const leases = (agent: string) => store.openLeases().filter((l) => l.agent === agent)
  const leaseRow = (id: string) => boardRead(ws, (db) => db.prepare('SELECT why, ended_at FROM slot_leases WHERE id = ?').get(id) as { why: string | null; ended_at: string | null })

  /**
   * B1's card X built in a slot on its line with a commit not merged, its lease ended (put back: the card waits in
   * review), then B1's Resume taking that free slot again under a carried lease (claimIn's carryIn), its run writing there.
   */
  const resumedB1 = async (): Promise<{ slot: string; folder: string; line: string; carried: string; run: string }> => {
    const x = await card('X', 'b1')
    const r = await start(x, 'b1')
    if (!r || !('lease' in r)) throw new Error(`no slot for X: ${JSON.stringify(r)}`)
    const line = `hive/x-${x}`
    sh(r.folder, 'switch', '-q', '-c', line)
    commit(r.folder, { 'x.txt': 'x\n' }, 'X: work not merged')
    expect(await pool.release(r.lease, 'putBack')).toBe(true)
    await pool.drained(r.slot)
    const carried = await pool.carry('b1', { name: r.slot, folder: r.folder })
    if (!carried) throw new Error('Resume could not take the slot')
    const RUN = 'run-b1'
    const me = await holder.self()
    await store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run(RUN, carried.id, 'b1', me.pid, me.started, projectId, r.slot))
    expect(pool.resumedCarry(carried)).toBe(true)
    return { slot: r.slot, folder: r.folder, line, carried: carried.id, run: RUN }
  }
  return { ws, project, store, pool, run, card, start, leases, leaseRow, resumedB1 }
}

describe("a slot B1's Resume took, then B1's lane starts (HB3's sequence)", () => {
  it('its line not merged: the lane takes it over (one slot for B1, its run there under the lane), the line stays, and B2 still gets a slot', async () => {
    const t = await setup('handed')
    const b1 = await t.resumedB1()
    const got = await t.run(() => lendLane(t.ws, t.project, 'lane-b1', 'b1', 'main'))
    expect(got).toEqual({ slot: b1.slot })
    expect(t.leaseRow(b1.carried)).toMatchObject({ why: 'handedOff', ended_at: expect.any(String) })
    const mine = t.leases('b1')
    expect(mine.map((l) => [l.kind, l.lane, l.slot])).toEqual([['lane', 'lane-b1', b1.slot]])
    // B1's run goes on in the same folder, now under the lane's lease.
    expect(t.pool.slots().find((s) => s.name === b1.slot)?.writer).toMatchObject({ run: b1.run, lease: mine[0].id })
    // Card X's work is on its line, which stays.
    expect(sh(t.project, 'log', '-1', '--format=%s', b1.line).trim()).toBe('X: work not merged')
    // The pool is sized to its two builders: B2's card still gets a slot of its own.
    const r = await t.start(await t.card('B2s', 'b2'), 'b2')
    expect(r && 'lease' in r ? r.slot : r).toEqual(expect.not.stringMatching(new RegExp(`^${b1.slot}$`)))
    expect(t.leases('b2').map((l) => l.kind)).toEqual(['card'])
  })

  it('changes not committed in it: kept carried (they are its work), and the lane gets another slot', async () => {
    const t = await setup('dirty')
    const b1 = await t.resumedB1()
    writeFileSync(join(b1.folder, 'a.txt'), 'changed\n')
    const got = await t.run(() => lendLane(t.ws, t.project, 'lane-b1', 'b1', 'main'))
    expect(got).toMatchObject({ slot: expect.any(String) })
    expect('slot' in got && got.slot).not.toBe(b1.slot)
    expect(t.leaseRow(b1.carried)).toMatchObject({ why: null, ended_at: null })
    expect(t.leases('b1').map((l) => l.kind).sort()).toEqual(['carried', 'lane'])
  })

  it('not possible just then (the handover refused): the lane gets another slot, then the carried lease ends (superseded) and B2 gets the freed slot', async () => {
    const t = await setup('superseded')
    const b1 = await t.resumedB1()
    // Its run has left (its writer cleared), so the slot frees once the lease ends.
    await t.store.clearWriterRun(b1.run)
    const handOff = vi.spyOn(t.pool, 'handOff').mockResolvedValueOnce(null)
    try {
      const got = await t.run(() => lendLane(t.ws, t.project, 'lane-b1', 'b1', 'main'))
      expect(handOff).toHaveBeenCalledOnce()
      expect('slot' in got && got.slot).not.toBe(b1.slot)
    } finally {
      handOff.mockRestore()
    }
    expect(t.leaseRow(b1.carried)).toMatchObject({ why: 'superseded', ended_at: expect.any(String) })
    expect(t.leases('b1').map((l) => l.kind)).toEqual(['lane'])
    expect(sh(t.project, 'log', '-1', '--format=%s', b1.line).trim()).toBe('X: work not merged')
    const r = await t.start(await t.card('B2s', 'b2'), 'b2')
    expect(r && 'lease' in r ? r.slot : r).toBe(b1.slot)
  })
})
