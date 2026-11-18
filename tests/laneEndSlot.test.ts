// HI-3118: a lane over while its card is in flight in the lane's slot. The release's own write decides (SlotStore
// laneOver, slotCards' laneOverIn): the lane's lease becomes that card's in place (same id), so the card keeps its slot
// and work and no other card is lent it; with none in flight the lease ends as before; only the card started on it last
// counts (HI-3353: one started before it, its slot prepared over since, keeps nothing, even On Hold);
// a lane still running is left alone. And a card whose slot's lease Combwork did end can't submit from that folder
// (platform.slotLeft), whoever works there now. Real Git, the runtime and a slot pool on the board's database.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { B1, B2, commit, moved, refusedBy, setup, sh, type Env } from './workflow/harness'
import { preset } from '../src/shared/workflow/options'
import { boardFile, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { cardUsesLease, laneOverIn } from '../src/main/slotCards'
import { timing } from './timing.cjs'

const closers: (() => void | Promise<void>)[] = []
let env: Env | null = null
let enforced = true
afterEach(async () => {
  enforced = true
  for (const c of closers.splice(0).reverse()) await c()
  env?.close()
  env = null
})

async function lanePool(cap = 1) {
  const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [], folder: 'slots' as const }, { autoRun: false, enforced: () => enforced }))
  const conn = fileSlotConn(boardFile(e.home))
  const store = new SlotStore(conn, 'p-test')
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const pool = new SlotPool({ store, project: e.project, root: join(e.home, 'slot-root'), options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => cap, cap: () => cap, runner: async () => ({ ok: true, exitCode: 0, logPath: null, settled: true }), settle: async () => true, holder, sessionIn: () => null })
  closers.push(async () => {
    await pool.close()
    conn.close()
  })
  const leases = new Map<string, { slot: string; folder: string; lease: string }>()
  e.wf.cfg.slotFor = async (_card, builder) => ({ ...leases.get(builder)!, fresh: false })
  e.wf.cfg.slotUnused = async () => undefined
  // As the app wires it (service.ts): the submit asks the board's slot leases.
  e.wf.cfg.slotHeld = (lease, slot, folder, card) => e.wf.store.leaseHolds(lease, slot, folder, card)
  /** A lane of `cards` for B1, lent a slot; its first card started there with a commit. */
  const laneWith = async (cards: number[]) => {
    e.wf.startLane('L', cards, 'R1')
    const lane = await pool.lend({ lane: 'L', agent: 'B1' }, { target: 'main' })
    if (!lane.ok) throw new Error(JSON.stringify(lane))
    leases.set('B1', { slot: lane.slot.name, folder: lane.slot.folder, lease: lane.lease.id })
    return lane
  }
  const startIn = async (card: { id: number; key: string }, agent = B1, lease: string) => {
    moved(await e.wf.start(card.key, agent))
    const s = e.wf.state(card.id).started!
    await pool.prepare(lease, { line: s.line!, base: s.base!, install: false, target: 'main' })
    return s
  }
  // As the lanes service ends it (the user's End or Abandon): its row no longer active.
  const endLane = () => e.wf['saveLane']({ ...e.wf.lane('L')!, ended: true })
  const releaseLane = (lease: string) => pool.releaseLane(lease, 'laneEnded', (db, id) => laneOverIn(db, e.wf, id, lease))
  return { e, store, pool, leases, laneWith, startIn, endLane, releaseLane }
}

describe('a lane over with its card in flight (HI-3118)', { timeout: timing('test.hang') }, () => {
  it("its lease becomes the card's in place: the card keeps its slot and work, no other card gets it, and it submits", async () => {
    const { e, store, pool, laneWith, startIn, endLane, releaseLane } = await lanePool(1)
    const c1 = e.wf.createCard({ title: 'Lane card' })
    const c9 = e.wf.createCard({ title: 'Other card' })
    const lane = await laneWith([c1.id])
    await startIn(c1, B1, lane.lease.id)
    const work = commit(lane.slot.folder, { 'one.txt': 'one\n' }, 'card 1 work')
    // Still running: nothing is decided.
    expect(await releaseLane(lane.lease.id)).toBeNull()
    expect(store.openLease(lane.slot.name)?.kind).toBe('lane')
    endLane()
    const r = await releaseLane(lane.lease.id)
    expect(r && 'card' in r ? r.card : r).toMatchObject({ id: lane.lease.id, kind: 'card', card: c1.id, lane: null, agent: 'B1' })
    expect(store.openLease(lane.slot.name)).toMatchObject({ id: lane.lease.id, kind: 'card', card: c1.id })
    // Its folder untouched: on the card's line, its work there.
    expect(sh(lane.slot.folder, 'rev-parse', 'HEAD')).toBe(work)
    expect(sh(lane.slot.folder, 'branch', '--show-current')).toBe(e.wf.state(c1.id).started!.line)
    // The pool (one slot) has nothing to lend another card.
    const other = await pool.lend({ card: c9.id, agent: 'B2' }, { target: 'main' })
    expect(other.ok).toBe(false)
    // The card submits from its slot.
    moved(await e.wf.submit(c1.key, B1, { summary: 'one' }))
    expect(e.wf.state(c1.id).stage).toBe('review')
    // A second pass decides nothing more: the lease is a card's now.
    expect(await releaseLane(lane.lease.id)).toBeNull()
  })

  it('reassigned in flight, the card keeps the slot all the same: its cycle holds it, not its builder', async () => {
    const { e, store, laneWith, startIn, endLane, releaseLane } = await lanePool(1)
    const c1 = e.wf.createCard({ title: 'Lane card' })
    const lane = await laneWith([c1.id])
    await startIn(c1, B1, lane.lease.id)
    workspaceDb(e.home).writer.prepare('UPDATE cards SET agent = ? WHERE number = ?').run('B2', c1.id)
    endLane()
    const r = await releaseLane(lane.lease.id)
    expect(r && 'card' in r).toBe(true)
    expect(store.openLease(lane.slot.name)?.card).toBe(c1.id)
  })

  it('with no card in flight there (put back, or none started), the lease ends as before and the slot is free', async () => {
    const { e, store, laneWith, startIn, endLane, releaseLane } = await lanePool(1)
    const c1 = e.wf.createCard({ title: 'Lane card' })
    const lane = await laneWith([c1.id])
    await startIn(c1, B1, lane.lease.id)
    moved(await e.wf.putBack(c1.key, B1, {}))
    endLane()
    const r = await releaseLane(lane.lease.id)
    expect(r && 'ended' in r ? r.ended : r).toMatchObject({ id: lane.lease.id, why: 'laneEnded' })
    expect(store.openLease(lane.slot.name)).toBeNull()
  })

  it("a card of it that can't be read keeps the lease (HR2's round 1): nothing ends, nothing is re-kinded, the folder as it was", async () => {
    const { e, store, laneWith, startIn, endLane, releaseLane } = await lanePool(1)
    const c1 = e.wf.createCard({ title: 'Lane card' })
    const lane = await laneWith([c1.id])
    await startIn(c1, B1, lane.lease.id)
    const head = commit(lane.slot.folder, { 'one.txt': 'one\n' }, 'card 1 work')
    endLane()
    const read = e.wf.store.card.bind(e.wf.store)
    const spy = vi.spyOn(e.wf.store, 'card').mockImplementation((n: number) => {
      if (n === c1.id) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
      return read(n)
    })
    try {
      expect(await releaseLane(lane.lease.id)).toBeNull()
    } finally {
      spy.mockRestore()
    }
    expect(store.openLease(lane.slot.name)).toMatchObject({ id: lane.lease.id, kind: 'lane' })
    expect(sh(lane.slot.folder, 'rev-parse', 'HEAD')).toBe(head)
    // Readable again: the next pass decides, the card keeping its slot.
    const r = await releaseLane(lane.lease.id)
    expect(r && 'card' in r ? r.card.card : r).toBe(c1.id)
  })

  it('with two cards in flight on the lane lease (rules allow one; a race), the one started last keeps it: the slot was prepared for it (HI-3353)', async () => {
    const { e, store, laneWith, startIn, endLane, releaseLane } = await lanePool(1)
    const c1 = e.wf.createCard({ title: 'One' })
    const c2 = e.wf.createCard({ title: 'Two' })
    const lane = await laneWith([c1.id, c2.id])
    await startIn(c1, B1, lane.lease.id)
    // The second started on the same lease regardless (the rules' one-at-a-time set aside for the test).
    enforced = false
    await startIn(c2, B1, lane.lease.id)
    endLane()
    const r = await releaseLane(lane.lease.id)
    expect(r && 'card' in r ? r.card.card : r).toBe(c2.id)
    expect(store.openLease(lane.slot.name)).toMatchObject({ id: lane.lease.id, kind: 'card', card: c2.id })
  })

  // HI-3353 (CB2 on CL-217): a lane card put On Hold mid-lane while the lane's later cards went on in its slot, then the
  // lane ended with its last card Done. The held card kept the lane's lease as its own, so its builder's one slot was
  // held for good and every later start of that builder's (a new lane's first card, a start across the rules) got none.
  it('a card started before another on its lease, On Hold at the lane\'s end, keeps nothing: the lease ends, and its builder is lent a new lane\'s slot', async () => {
    const { e, store, pool, laneWith, startIn, endLane, releaseLane } = await lanePool(1)
    const held = e.wf.createCard({ title: 'Umbrella, put On Hold' })
    const next = e.wf.createCard({ title: 'Lane card after it' })
    const lane = await laneWith([held.id, next.id])
    await startIn(held, B1, lane.lease.id)
    moved(await e.wf.move(held.key, 'hold', 'user'))
    expect(e.wf.state(held.id).stage).toBe('hold')
    // The lane goes on with its next card, prepared in the same slot over the held one's line (its list reordered, in
    // CB2's lane: the rules' order set aside here).
    enforced = false
    await startIn(next, B1, lane.lease.id)
    enforced = true
    expect(sh(lane.slot.folder, 'branch', '--show-current')).toBe(e.wf.state(next.id).started!.line)
    moved(await e.wf.putBack(next.key, B1, {}))
    endLane()
    const r = await releaseLane(lane.lease.id)
    expect(r && 'ended' in r ? r.ended : r).toMatchObject({ id: lane.lease.id, why: 'laneEnded' })
    expect(store.openLease(lane.slot.name)).toBeNull()
    // The held card still holds its line; its builder's next lane is lent the slot.
    expect(e.wf.state(held.id).stage).toBe('hold')
    e.wf.startLane('L2', [e.wf.createCard({ title: 'New lane card' }).id], 'R1')
    const again = await pool.lend({ lane: 'L2', agent: 'B1' }, { target: 'main' })
    expect(again.ok && again.slot.name).toBe(lane.slot.name)
  })

  it("a lease already made such a card's (before HI-3353) isn't used by it: the release pass ends it, and the builder's next lend goes through", async () => {
    const { e, store, pool, laneWith, startIn, endLane } = await lanePool(1)
    const held = e.wf.createCard({ title: 'Umbrella, put On Hold' })
    const next = e.wf.createCard({ title: 'Lane card after it' })
    const lane = await laneWith([held.id, next.id])
    await startIn(held, B1, lane.lease.id)
    moved(await e.wf.move(held.key, 'hold', 'user'))
    enforced = false
    await startIn(next, B1, lane.lease.id)
    enforced = true
    moved(await e.wf.putBack(next.key, B1, {}))
    endLane()
    // As the lane's end decided before the fix: the held card's, in place.
    const made = await pool.releaseLane(lane.lease.id, 'laneEnded', () => ({ over: true, cards: [held.id] }))
    expect(made && 'card' in made ? made.card.card : made).toBe(held.id)
    const l = store.openLease(lane.slot.name)!
    expect(l).toMatchObject({ kind: 'card', card: held.id })
    // The live record: B1 can't be lent another lane's slot while it stands (one agent, one slot).
    e.wf.startLane('L2', [e.wf.createCard({ title: 'New lane card' }).id], 'R1')
    const refused = await pool.lend({ lane: 'L2', agent: 'B1' }, { target: 'main' })
    expect(!refused.ok && refused.refusal).toMatchObject({ why: 'agentLeased', card: held.id })
    // The release pass's question (settleOnce): the held card doesn't use it, as another card started on it since.
    expect(cardUsesLease(e.wf, l)).toBe(false)
    expect(await pool.release(l.id, 'movedOn', () => !cardUsesLease(e.wf, l))).toBe(true)
    const again = await pool.lend({ lane: 'L2', agent: 'B1' }, { target: 'main' })
    expect(again.ok && again.slot.name).toBe(lane.slot.name)
  })

  it("a card's own lease is still used by it On Hold (the last card started on it)", async () => {
    const { e, store, laneWith, startIn, endLane, releaseLane } = await lanePool(1)
    const c1 = e.wf.createCard({ title: 'Lane card, held last' })
    const lane = await laneWith([c1.id])
    await startIn(c1, B1, lane.lease.id)
    moved(await e.wf.move(c1.key, 'hold', 'user'))
    endLane()
    const r = await releaseLane(lane.lease.id)
    expect(r && 'card' in r ? r.card.card : r).toBe(c1.id)
    expect(cardUsesLease(e.wf, store.openLease(lane.slot.name)!)).toBe(true)
  })

  it("a card whose slot's lease Combwork ended can't submit from it, before or after the slot is lent on; the new card can", async () => {
    const { e, store, pool, leases, laneWith, startIn } = await lanePool(1)
    const c1 = e.wf.createCard({ title: 'Lane card' })
    const c9 = e.wf.createCard({ title: 'Other card' })
    const lane = await laneWith([c1.id])
    await startIn(c1, B1, lane.lease.id)
    commit(lane.slot.folder, { 'one.txt': 'one\n' }, 'card 1 work')
    // The lease ended outright (as before this change, or by hand): the folder isn't the card's any more.
    await pool.release(lane.lease.id, 'laneAbandoned')
    await pool.refresh()
    const free = refusedBy(await e.wf.submit(c1.key, B1, { summary: 'one' }), 'platform.slotLeft')
    expect(free.message).toContain(lane.slot.name)
    expect(e.wf.state(c1.id).stage).toBe('active')
    // Lent to B2's card, which works there.
    const other = await pool.lend({ card: c9.id, agent: 'B2' }, { target: 'main' })
    if (!other.ok) throw new Error(JSON.stringify(other))
    expect(other.slot.name).toBe(lane.slot.name)
    leases.set('B2', { slot: other.slot.name, folder: other.slot.folder, lease: other.lease.id })
    await startIn(c9, B2, other.lease.id)
    commit(other.slot.folder, { 'nine.txt': 'nine\n' }, 'card 9 work')
    const head = sh(other.slot.folder, 'rev-parse', 'HEAD')
    refusedBy(await e.wf.submit(c1.key, B1, { summary: 'one' }), 'platform.slotLeft')
    // Refused with nothing changed there: B2's checkout, head and lease as they were.
    expect(sh(other.slot.folder, 'rev-parse', 'HEAD')).toBe(head)
    expect(store.openLease(other.slot.name)).toMatchObject({ id: other.lease.id, card: c9.id })
    moved(await e.wf.submit(c9.key, B2, { summary: 'nine' }))
  })
})
