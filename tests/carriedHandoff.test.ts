// An adopted worktree handed over to its agent's first card under slots (#1441, SPEC §16.10.8): only when its carried
// lease is kept for nothing (no lane or card in flight from the upgrade), its folder is clean and its head is in the
// target; then, in one write, the carried lease ends (`handedOff`), the card's lease begins on the same slot and the
// conversations bound to it go on under the new lease. A failure in that write leaves all of it as it was; two Hives
// handing over at once, one wins; asked again (a restart), the start finds the card's lease. The workspace, its board, the
// pool and git are real; the rules are on; no session is started.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => true }))

const base = tempDir('carriedhandoff-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { boardFile, boardRead } = await import('../src/main/boardStore')
const { SlotStore, fileSlotConn } = await import('../src/main/slots')
const { keptFor, migrateSlots, startSlotMigration, stopSlotMigration } = await import('../src/main/slotMigration')
const { leaseForStart } = await import('../src/main/slotCards')
const { folderAgent, folderFacts } = await import('../src/main/agentFolders')
const { canResumeNow, resumeHold } = await import('../src/shared/agentFolders')
const { holder, poolFor } = await import('../src/main/slotsApp')
const { sessions } = await import('../src/main/sessions')
const { loadedWatchFor } = await import('../src/main/watches')
const { tellListeners } = await import('../src/main/events')
const { setAgentBusy } = await import('../src/main/workflow/lineUpdates')
const { workflowFor } = await import('../src/main/workflow/service')
const tasks = await import('../src/main/tasks')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const trees = join(base, 'trees')
const wt = (n: string): string => join(trees, n)
const ws = createWorkspaceService()
let projectId = 'p1'
let store: InstanceType<typeof SlotStore>

/**
 * Builders b1, b3 and b4 (unmerged work) with nothing in flight, b2 with a card in Doing from before the upgrade, and b5
 * with no worktree (the pool's size is the builders': room for one slot beside the four adopted).
 */
function writeProject(): void {
  const agent = (id: string) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: 'builder', worktree: { path: wt(`h${id}`), branch: `cw/h${id}`, base: 'main' } })
  const b5 = { id: 'b5', name: 'B5', provider: 'claude-code', workflowRole: 'builder' }
  writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: projectId, agents: [...['b1', 'b2', 'b3', 'b4'].map(agent), b5] }))
}
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
const open = (agent: string) => store.openLeases().find((l) => l.agent === agent) ?? null
const leaseOf = (id: string): string | null => boardRead(ws, (db) => (db.prepare('SELECT lease FROM sessions WHERE id = ?').get(id) as { lease: string | null } | undefined)?.lease ?? null)
const start = (card: number, builder: string, dry: boolean) => run(() => leaseForStart(ws, project, { id: card }, builder, { dry, target: 'main' }))
let card1 = 0
let card2 = 0

beforeAll(async () => {
  gitRepo(project)
  commit(project, { '.gitignore': '.combwork/\n', 'a.txt': 'a\n' }, 'first')
  for (const a of ['b1', 'b2', 'b3', 'b4']) sh(project, 'worktree', 'add', '-q', '-b', `cw/h${a}`, wt(`h${a}`))
  mkdirSync(join(project, '.combwork'), { recursive: true })
  writeProject()
  await ws.open(wsPath)
  projectId = (await ws.projectConfig(project)).id ?? 'p1'
  writeProject()
  await ws.refresh()
  store = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
  await run(() => tasks.createTask({ title: 'From 0.9', project: 'alpha', agent: 'b2', column: 'doing' }, { kind: 'user' }))
  for (const a of ['b1', 'b4']) await run(() => workspace.upsertSession(project, { id: `s-${a}`, agent: 'claude-code', agentId: a, cwd: wt(`h${a}`), name: `s-${a}`, lastActiveAt: new Date().toISOString() }))
  // B4's worktree has work not merged.
  commit(wt('hb4'), { 'c.txt': 'c\n' }, 'unmerged')
  startSlotMigration()
  await migrateSlots(ws)
  card1 = (await run(() => tasks.createTask({ title: 'First under slots', project: 'alpha', agent: 'b1' }, { kind: 'user' }))).number
  card2 = (await run(() => tasks.createTask({ title: "B2's next", project: 'alpha', agent: 'b2' }, { kind: 'user' }))).number
})

afterAll(async () => {
  stopSlotMigration()
  store.conn.close()
  await disposeWorkspaceService(ws)
})

describe("an adopted worktree handed over to its agent's first card (#1441)", () => {
  it('kept for a card in flight from the upgrade: never handed over', async () => {
    expect(open('b2')?.kind).toBe('carried')
    const r = await start(card2, 'b2', true)
    expect(r && 'slot' in r ? r.slot : null).not.toBe('hb2')
  })

  it('changes not committed in it: not handed over, and it stays carried', async () => {
    writeFileSync(join(wt('hb1'), 'a.txt'), 'changed\n')
    try {
      const r = await start(card1, 'b1', true)
      expect(r && 'slot' in r ? r.slot : null).not.toBe('hb1')
      expect(open('b1')?.kind).toBe('carried')
    } finally {
      sh(wt('hb1'), 'checkout', '--', 'a.txt')
    }
  })

  // One scenario: each step needs the one before it (B1's work merged, then handed over, then restarted).
  it("B1's first card: not while its head isn't merged; a failed write changes nothing; handed over in one write; resumed after a restart; asked again, the same lease", async () => {
    // Its head not in the target: not handed over; once merged, it can be (a dry start changes nothing).
    commit(wt('hb1'), { 'b.txt': 'b\n' }, 'unmerged work')
    expect(await start(card1, 'b1', true).then((r) => (r && 'slot' in r ? r.slot : null))).not.toBe('hb1')
    sh(project, 'merge', '-q', '--ff-only', 'cw/hb1')
    expect(await start(card1, 'b1', true).then((r) => (r && 'slot' in r ? r.slot : null))).toBe('hb1')
    expect(open('b1')?.kind).toBe('carried')

    // A failure inside the handover's write: the carried lease, the slot and the sessions as they were.
    const carried = open('b1')!
    const pool = await run(() => poolFor(ws, project))
    await expect(
      pool.handOff(carried.id, { card: card1, agent: 'b1' }, () => {
        throw new Error('injected')
      })
    ).rejects.toThrow('injected')
    expect(open('b1')).toEqual(carried)
    expect(store.openLeases().filter((l) => l.slot === 'hb1')).toHaveLength(1)
    expect(leaseOf('s-b1')).toBe(carried.id)

    // Handed over in one write: the carried lease ended, the card's begun on the same slot, its sessions rebound.
    const r = await start(card1, 'b1', false)
    expect(r && 'slot' in r ? { slot: r.slot, folder: r.folder.toLowerCase() } : r).toEqual({ slot: 'hb1', folder: wt('hb1').toLowerCase() })
    const now = open('b1')!
    expect(now).toMatchObject({ kind: 'card', card: card1, slot: 'hb1' })
    const ended = boardRead(ws, (db) => db.prepare('SELECT why, ended_at FROM slot_leases WHERE id = ?').get(carried.id) as { why: string; ended_at: string | null })
    expect(ended.why).toBe('handedOff')
    expect(ended.ended_at).not.toBeNull()
    expect(leaseOf('s-b1')).toBe(now.id)

    // After a restart (read afresh from the board): Resume All resumes the card's session in the same folder.
    const facts = await run(() => folderFacts(project))
    const rec = (await run(() => workspace.sessionsFile(project))).sessions.find((x) => x.id === 's-b1')!
    expect(rec.cwd?.toLowerCase()).toBe(wt('hb1').toLowerCase())
    expect(canResumeNow(facts, folderAgent({ id: 'b1', name: 'B1', workflowRole: 'builder' } as never), rec)).toBe(true)

    // Its start written again: the same lease, nothing handed twice.
    const again = await start(card1, 'b1', false)
    expect(again && 'lease' in again ? again.lease : null).toBe(now.id)
    expect(store.openLeases().filter((l) => l.agent === 'b1')).toHaveLength(1)
  })

  it("unmerged work in it: the card gets another slot, the adopted one stays carried and its conversation waits for the card", async () => {
    const card4 = (await run(() => tasks.createTask({ title: "B4's first", project: 'alpha', agent: 'b4' }, { kind: 'user' }))).number
    const carried = open('b4')!
    const r = await start(card4, 'b4', false)
    expect(r).toMatchObject({ slot: expect.stringMatching(/^slot-/) })
    expect(store.openLeases().filter((l) => l.agent === 'b4').map((l) => l.kind).sort()).toEqual(['card', 'carried'])
    expect(store.openLease('hb4')?.id).toBe(carried.id)
    const facts = await run(() => folderFacts(project))
    const s4 = (await run(() => workspace.sessionsFile(project))).sessions.find((x) => x.id === 's-b4')!
    expect(resumeHold(facts, folderAgent({ id: 'b4', name: 'B4', workflowRole: 'builder' } as never), s4)).toMatchObject({ is: 'after', card: card4 })
  })

  it('two Hives handing over the same carried lease at once: one wins, the other gets nothing', async () => {
    const carried = open('b3')!
    expect(carried.kind).toBe('carried')
    const card3 = (await run(() => tasks.createTask({ title: "B3's", project: 'alpha', agent: 'b3' }, { kind: 'user' }))).number
    const other = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
    try {
      const got = await Promise.all([store.handOff(carried.id, { card: card3, agent: 'b3' }), other.handOff(carried.id, { card: card3, agent: 'b3' })])
      expect(got.filter(Boolean)).toHaveLength(1)
    } finally {
      other.conn.close()
    }
    expect(store.openLeases().filter((l) => l.slot === 'hb3')).toHaveLength(1)
    expect(open('b3')?.kind).toBe('card')
  })
})

describe("a carried lease kept for a card its builder has left (HI-1731)", () => {
  // B2's adopted worktree is kept for its card in flight at the upgrade (From 0.9, Active), and B2's run writes there
  // (HB3's case). The pool's own lease-end hook (slotsApp's stopLeaseSession) decides whether that run is stopped:
  // `sessions` is watched, nothing is started.
  const RUN = 'run-b2'
  const stops: string[] = []
  const kept = (): number | null => {
    const l = open('b2')
    const k = l?.kind === 'carried' ? keptFor(ws, l.id) : null
    return k && 'card' in k ? k.card : null
  }
  const lineOf = (folder: string): string => sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const writerOf = (slot: string) => boardRead(ws, (db) => db.prepare('SELECT writer_run AS run, writer_lease AS lease FROM slots WHERE project = ? AND name = ?').get(projectId, slot) as { run: string | null; lease: string | null } | undefined)
  const leaseRow = (id: string) => boardRead(ws, (db) => db.prepare('SELECT why, ended_at FROM slot_leases WHERE id = ?').get(id) as { why: string | null; ended_at: string | null })
  const status = (): void => tellListeners({ type: 'session-status', state: { agentId: 'b2', projectPath: project } as never })
  let busy = false

  beforeAll(async () => {
    // The pool's five slots are all in use by now: B4's card's lease ended (put back) frees one for B2's starts here.
    const pool = await run(() => poolFor(ws, project))
    for (const l of store.openLeases().filter((x) => x.agent === 'b4' && x.kind === 'card')) await pool.release(l.id, 'putBack')
    // The workspace's watches loaded (none is anyone's): unloaded, they count as work (HR4), and no stop would be tried.
    expect(await run(() => loadedWatchFor(ws, project, 'b2'))).toBeNull()
    vi.spyOn(sessions, 'runNow').mockImplementation((_p: string, agent: string) => (agent === 'b2' && !stops.includes(RUN) ? ({ run: RUN, starting: false } as never) : null))
    vi.spyOn(sessions, 'stop').mockImplementation((_p: string, agent?: string) => void stops.push(agent === 'b2' ? RUN : (agent ?? '')))
    setAgentBusy((_p, agent) => agent === 'b2' && busy)
    // B2's run, live in this process (the holder), writing in hb2 under its carried lease.
    const me = await holder.self()
    const carried = open('b2')!
    await store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run(RUN, carried.id, 'b2', me.pid, me.started, projectId, 'hb2'))
  })

  afterAll(() => {
    setAgentBusy(null)
    vi.restoreAllMocks()
  })

  const stage = async (n: number): Promise<string> => {
    const wf = await run(() => workflowFor(ws, project))
    return wf!.state(wf!.store.card(n)).stage
  }
  const card = async (title: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', agent: 'b2' }, { kind: 'user' }))).number
  /** B2's card leases lent by the starts here, ended again (put back): B2 then holds its carried lease alone. */
  const drop = async (): Promise<void> => {
    const pool = await run(() => poolFor(ws, project))
    for (const l of store.openLeases().filter((x) => x.agent === 'b2' && x.kind === 'card')) await pool.release(l.id, 'putBack')
  }

  // One scenario: each step needs the one before it (the card Active, then left; the folder dirty, then clean; then ended).
  it("kept while that card is Active, while a start is refused, or while its folder has changes not committed; then ended (superseded) once B2 holds its new lease, its run never stopped", async () => {
    const a = kept()!
    const carried = open('b2')!
    expect(await stage(a)).toBe('active')
    // Still Active: another start of B2's leaves it carried (that card gets a slot of its own).
    await start(await card("B2's lane card"), 'b2', false)
    expect(store.openLease('hb2')?.id).toBe(carried.id)
    await drop()

    await run(() => tasks.updateTask(a, { column: 'hold' }, { kind: 'user' }))
    expect(await stage(a)).not.toBe('active')
    // A start refused (no slot lent): nothing ends, its run untouched.
    const pool = await run(() => poolFor(ws, project))
    const lend = vi.spyOn(pool, 'lend').mockResolvedValueOnce({ ok: false, refusal: { why: 'noSlot' } } as never)
    expect(await start(await card("B2's refused"), 'b2', false)).toMatchObject({ wait: expect.any(String) })
    lend.mockRestore()
    expect(store.openLease('hb2')?.id).toBe(carried.id)
    // Changes not committed in its folder: kept.
    writeFileSync(join(wt('hb2'), 'a.txt'), 'changed\n')
    await start(await card("B2's next"), 'b2', false)
    expect(store.openLease('hb2')?.id).toBe(carried.id)
    sh(wt('hb2'), 'checkout', '--', 'a.txt')
    await drop()
    // Its checkout changed after it was found clean, before the guarded end (B2's run committed meanwhile): kept, the
    // commit with it (HR4: the slot's line as the guard decided on it).
    const release = pool.release.bind(pool)
    const late = vi.spyOn(pool, 'release').mockImplementationOnce(async (...args) => {
      commit(wt('hb2'), { 'late.txt': 'late\n' }, 'late work')
      return release(...args)
    })
    await start(await card("B2's after a commit"), 'b2', false)
    late.mockRestore()
    expect(store.openLease('hb2')?.id).toBe(carried.id)
    expect(sh(wt('hb2'), 'log', '-1', '--format=%s').trim()).toBe('late work')
    await drop()
    expect(store.openLeases().filter((l) => l.agent === 'b2').map((l) => l.kind)).toEqual(['carried'])
    expect(stops).toEqual([])

    // Then, with that card left (On Hold) and the folder clean: ended (superseded) once B2 holds its new lease; its run,
    // now under that lease, is never stopped; the slot drains once it leaves; the line stays.
    expect(kept()).toBe(a)
    const line = lineOf(wt('hb2'))
    const b = await card("B2's last")
    const r = await start(b, 'b2', false)
    expect(r && 'lease' in r ? r.lease : r).toEqual(expect.any(String))
    expect(leaseRow(carried.id)).toMatchObject({ why: 'superseded', ended_at: expect.any(String) })
    expect(store.openLeases().filter((l) => l.agent === 'b2').every((l) => l.kind === 'card')).toBe(true)
    // The run in hb2 at its first idle moment, and after: kept running (it holds B's lease).
    status()
    status()
    expect(stops).toEqual([])
    expect(writerOf('hb2')).toMatchObject({ run: RUN, lease: carried.id })
    // Nothing reuses hb2 while that run writes there: it isn't free.
    expect(store.openLease('hb2')).toBeNull()
    expect(await stage(a)).not.toBe('active')
    // The run leaves (its next start elsewhere): hb2 drains, free to retire as any free slot.
    expect(await store.clearWriterRun(RUN)).toContain('hb2')
    await pool.drained('hb2')
    expect(writerOf('hb2')).toMatchObject({ run: null })
    expect(store.openLease('hb2')).toBeNull()
    expect(sh(project, 'branch', '--list', line).trim()).not.toBe('')
  })
})

describe("a carried lease ending before the new lease exists (HI-1731, HR4's interleaving)", () => {
  it("its end comes while its agent's run is busy starting a card: once that card's lease exists, the run isn't stopped", async () => {
    // B4's adopted worktree (kept carried: its unmerged work) with its card's lease ended again: B4 holds the carried
    // lease alone, and its run writes in its old folder. The pool ends that lease (as the pass does once what it is
    // kept for has ended) while the run is in its turn, starting another card whose lease doesn't exist yet.
    const pool = await run(() => poolFor(ws, project))
    for (const l of store.openLeases().filter((x) => x.agent === 'b4' && x.kind === 'card')) await pool.release(l.id, 'putBack')
    expect(await run(() => loadedWatchFor(ws, project, 'b4'))).toBeNull()
    const carried = open('b4')!
    expect(store.openLeases().filter((l) => l.agent === 'b4').map((l) => l.kind)).toEqual(['carried'])
    const RUN = 'run-b4'
    const stops: string[] = []
    let busy = true
    const runNow = vi.spyOn(sessions, 'runNow').mockImplementation((_p: string, agent: string) => (agent === 'b4' && !stops.length ? ({ run: RUN, starting: false } as never) : null))
    const stop = vi.spyOn(sessions, 'stop').mockImplementation(() => void stops.push(RUN))
    setAgentBusy((_p, agent) => agent === 'b4' && busy)
    const status = (): void => tellListeners({ type: 'session-status', state: { agentId: 'b4', projectPath: project } as never })
    try {
      const me = await holder.self()
      await store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run(RUN, carried.id, 'b4', me.pid, me.started, projectId, carried.slot))
      expect(await pool.release(carried.id, 'cardEnded')).toBe(true)
      // Its turn goes on: the card's lease is lent before the turn ends.
      const n = (await run(() => tasks.createTask({ title: "B4's next", project: 'alpha', agent: 'b4' }, { kind: 'user' }))).number
      const r = await start(n, 'b4', false)
      expect(r && 'lease' in r).toBe(true)
      // Idle: looked at again just before a stop, it holds that lease now, so its run goes on.
      busy = false
      status()
      status()
      await vi.waitFor(() => expect(runNow).toHaveBeenCalled())
      expect(stops).toEqual([])
    } finally {
      setAgentBusy(null)
      runNow.mockRestore()
      stop.mockRestore()
    }
  })
})
