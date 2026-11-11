// The window's edits of a running lane's list (HI-2898, Progress → Lanes): move, add, remove, cancel a queued change,
// Move here and undo, each through the one list writer (applyLaneList), bound to the lane's id and list revision, checked
// again at the write, the card's assignment saved with the lanes in one board change, all or nothing.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { LaneEdit, LaneEditResult } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('cw-lane-edit-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const edits = await import('../src/main/laneEdits')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
const { dayBounds } = await import('../src/shared/laneDay')

vi.setConfig({ testTimeout: 60_000 })

describe('laneEditOf: what IPC passes is checked field by field', () => {
  it('takes each op, and refuses a malformed one', () => {
    expect(edits.laneEditOf({ op: 'move', lane: 'lane-ab12', rev: 3, card: 5, to: 1 })).toEqual({ op: 'move', lane: 'lane-ab12', rev: 3, card: 5, to: 1 })
    expect(edits.laneEditOf({ op: 'transfer', card: 5, from: { lane: 'lane-a1', rev: 0 }, to: { lane: 'lane-b2', rev: 4 }, at: 0, extra: 'x' })).toEqual({ op: 'transfer', card: 5, from: { lane: 'lane-a1', rev: 0 }, to: { lane: 'lane-b2', rev: 4 }, at: 0 })
    const bad: unknown[] = [null, [], { op: 'drop' }, { op: 'move', lane: '../x', rev: 0, card: 1, to: 0 }, { op: 'add', lane: 'lane-a1', rev: -1, card: 1 }, { op: 'add', lane: 'lane-a1', rev: 0, card: 1.5 }, { op: 'remove', lane: 'lane-a1', rev: 0, card: 0 }, { op: 'move', lane: 'lane-a1', rev: 0, card: 1, to: 9999 }, { op: 'undo', undo: { lanes: [], card: null } }, { op: 'undo', undo: { lanes: [{ before: { lane: 'lane-a1', cards: [1, 1], pending: null }, rev: 1 }], card: null } }, { op: 'undo', undo: { lanes: [{ before: { lane: 'lane-a1', cards: [1], pending: null }, rev: 1 }], card: { number: 1, before: 'a b', after: null, head: null } } }]
    for (const v of bad) expect(() => edits.laneEditOf(v), JSON.stringify(v)).toThrow(/isn’t one Combwork can make/)
  })

  it('takes a time in the last two days for Ended today', () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    expect(edits.endedSinceOf('2026-11-10T00:00:00Z', now)).toBe(Date.parse('2026-11-10T00:00:00Z'))
    for (const v of ['yesterday', '2026-11-07T00:00:00Z', '2026-11-11T00:00:00Z', 5]) expect(() => edits.endedSinceOf(v, now)).toThrow()
  })
})

describe('dayBounds: Ended today is the local calendar day', () => {
  it('starts at local midnight and ends at the next, 23 or 25 hours on a DST day', () => {
    const prev = process.env.TZ
    try {
      // Europe/Rome leaves summer time on 25 Oct 2026: that day has 25 hours.
      process.env.TZ = 'Europe/Rome'
      const d = dayBounds(new Date(2026, 9, 25, 15, 0))
      expect(d.start.getHours()).toBe(0)
      expect(d.end.getDate()).toBe(26)
      expect(d.end.getHours()).toBe(0)
      expect((d.end.getTime() - d.start.getTime()) / 3_600_000).toBe(25)
      const spring = dayBounds(new Date(2026, 2, 29, 12, 0))
      expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23)
      expect(dayBounds(new Date(2026, 10, 10, 0, 0)).start.getTime()).toBe(new Date(2026, 10, 10).getTime())
    } finally {
      if (prev === undefined) delete process.env.TZ
      else process.env.TZ = prev
    }
  })
})

describe('editLanes (HI-2898)', () => {
  type WS = ReturnType<typeof createWorkspaceService>
  let w: WS
  const wsPath = join(base, 'ws')
  const project = join(wsPath, 'alpha')
  const user = { kind: 'user' } as const
  const resumed: string[] = []
  beforeAll(async () => {
    mkdirSync(join(project, '.combwork'), { recursive: true })
    writeFileSync(join(project, 'a.txt'), 'a\n')
    writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2' }, { id: 'b3', name: 'B3' }, { id: 'r1', name: 'R1', workflowRole: 'either' }] }))
    mkdirSync(join(wsPath, 'beta', '.combwork'), { recursive: true })
    writeFileSync(join(wsPath, 'beta', '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'c1', name: 'C1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    edits.laneEditHooks.resume = async (_p, l) => void resumed.push(l.id)
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
  })
  beforeEach(async () => {
    await advanced.set(ENFORCE, true)
    // Each test's lanes alone: every running lane ended first.
    for (const l of await lanes.listLanes(w, { all: true })) if (l.state === 'active' || l.state === 'paused') await lanes.endLane(w, l.id, { abandoned: true })
    resumed.length = 0
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = async (title: string, o: { project?: string; agent?: string } = {}): Promise<number> => (await run(() => tasks.createTask({ title, project: o.project ?? 'alpha', ...(o.agent ? { agent: o.agent } : {}) }, user))).number
  const start = async (builder: string, cards: number[]) => (await lanes.startLane(w, { project: 'alpha', builder, reviewer: 'r1', cards, by: 'the user' })).lane
  const lane = (id: string) => lanes.getLane(w, id)
  const raw = async (id: string) => (await lanes.rawLanes(w)).find((l) => l.id === id)!
  const edit = (e: LaneEdit): Promise<LaneEditResult> => run(() => edits.editLanes(w, e))
  const card = (n: number) => run(() => tasks.getTask(n, w))
  const doing = (n: number, agent: string) => run(() => tasks.updateTask(n, { column: 'doing', agent }, user))

  it('moves a queued card, between cards at once, and its revision goes up each time (ABA too)', async () => {
    const [a, b, c] = [await make('A'), await make('B'), await make('C')]
    const l = await start('b1', [a, b, c])
    expect(l.listRev).toBe(0)
    const r = await edit({ op: 'move', lane: l.id, rev: 0, card: c, to: 0 })
    expect(r.lanes).toEqual([{ lane: l.id, queuedAfter: null, rev: 1 }])
    expect((await lane(l.id)).cards.map((x) => x.number)).toEqual([c, a, b])
    expect((await lane(l.id)).listRev).toBe(1)
    expect(resumed).toEqual([l.id])
    // Back as it was: the same list, a new revision; the edit made on revision 0 is refused now.
    // Its reply names the revision it left (HI-2932): what the window's next quick edit names.
    const back = await edit({ op: 'move', lane: l.id, rev: 1, card: c, to: 2 })
    expect((await lane(l.id)).cards.map((x) => x.number)).toEqual([a, b, c])
    expect((await lane(l.id)).listRev).toBe(2)
    expect(back.lanes[0].rev).toBe(2)
    await expect(edit({ op: 'move', lane: l.id, rev: 0, card: c, to: 0 })).rejects.toThrow(/changed meanwhile/)
    expect((await lane(l.id)).cards.map((x) => x.number)).toEqual([a, b, c])
  })

  it('keeps the card in flight and the cards before it in their places, checked at the write', async () => {
    const [a, b, c] = [await make('A'), await make('B'), await make('C')]
    const l = await start('b1', [a, b, c])
    await doing(a, 'b1')
    const rev = (await lane(l.id)).listRev
    await expect(edit({ op: 'move', lane: l.id, rev, card: c, to: 0 })).rejects.toThrow(/keep their places/)
    await expect(edit({ op: 'move', lane: l.id, rev, card: a, to: 2 })).rejects.toThrow(/has started/)
    await expect(edit({ op: 'remove', lane: l.id, rev, card: a })).rejects.toThrow(/has started/)
    // A card started after the window read the lane (its revision unchanged): refused at the write.
    await doing(b, 'b1')
    await expect(edit({ op: 'move', lane: l.id, rev, card: b, to: 2 })).rejects.toThrow(/has started/)
    expect((await raw(l.id)).cards).toEqual([a, b, c])
  })

  it('queues an edit behind the card in flight; editing that queued list keeps it queued; Cancel change drops it', async () => {
    const [a, b, c, d] = [await make('A'), await make('B'), await make('C'), await make('D')]
    const l = await start('b1', [a, b])
    await doing(a, 'b1')
    const r = await edit({ op: 'add', lane: l.id, rev: 0, card: c })
    expect(r.lanes).toEqual([{ lane: l.id, queuedAfter: a, rev: 1 }])
    let rec = await raw(l.id)
    expect(rec.cards).toEqual([a, b])
    expect(rec.pending).toEqual([a, b, c])
    const r2 = await edit({ op: 'add', lane: l.id, rev: 1, card: d, at: 1 })
    rec = await raw(l.id)
    expect(rec.pending).toEqual([a, d, b, c])
    // Its undo puts the queued list back exactly as it was, not the applied one.
    await edit({ op: 'undo', undo: r2.undo! })
    rec = await raw(l.id)
    expect(rec.cards).toEqual([a, b])
    expect(rec.pending).toEqual([a, b, c])
    // Cancel change: bound to the revision shown.
    await expect(edit({ op: 'cancel', lane: l.id, rev: 1 })).rejects.toThrow(/changed meanwhile/)
    await edit({ op: 'cancel', lane: l.id, rev: rec.listRev! })
    rec = await raw(l.id)
    expect(rec.pending).toBeUndefined()
    expect(rec.cards).toEqual([a, b])
    await expect(edit({ op: 'cancel', lane: l.id, rev: rec.listRev! })).rejects.toThrow(/no queued change/)
  })

  it('removes a queued card back to the board, and undoes it', async () => {
    const [a, b] = [await make('A'), await make('B')]
    const l = await start('b1', [a, b])
    const r = await edit({ op: 'remove', lane: l.id, rev: 0, card: b })
    expect((await raw(l.id)).cards).toEqual([a])
    expect((await card(b)).column).toBe('todo')
    expect((await card(b)).archived).toBe(false)
    await edit({ op: 'undo', undo: r.undo! })
    expect((await raw(l.id)).cards).toEqual([a, b])
    // A second undo of the same edit: the list moved on since.
    await expect(edit({ op: 'undo', undo: r.undo! })).rejects.toThrow(/changed meanwhile/)
  })

  it('undoes a removal from a lane whose card is in flight: the cards put back exactly, not queued', async () => {
    const [a, b, c] = [await make('A'), await make('B'), await make('C')]
    const l = await start('b1', [a, b, c])
    await doing(a, 'b1')
    // A removal keeping the card in flight applies at once (as cw_lane start's does).
    const r = await edit({ op: 'remove', lane: l.id, rev: 0, card: b })
    expect(r.lanes).toEqual([{ lane: l.id, queuedAfter: null, rev: 1 }])
    expect((await raw(l.id)).cards).toEqual([a, c])
    await edit({ op: 'undo', undo: r.undo! })
    const rec = await raw(l.id)
    expect(rec.cards).toEqual([a, b, c])
    expect(rec.pending).toBeUndefined()
  })

  it("refuses to bring back a card taken off that was started since and returned to Todo, keeping its work (HR1's round 1)", async () => {
    const [a, b] = [await make('A'), await make('B')]
    const l = await start('b1', [a, b])
    const r = await edit({ op: 'remove', lane: l.id, rev: 0, card: b })
    expect(r.undo?.back).toEqual([{ number: b, head: expect.anything(), work: false }])
    // Started by another agent outside the lane, then back in Todo, given to nobody: its start stays in its facts.
    await doing(b, 'b3')
    await run(() => tasks.updateTask(b, { column: 'todo', agent: null }, user))
    await expect(edit({ op: 'undo', undo: r.undo! })).rejects.toThrow(/changed since/)
    expect((await raw(l.id)).cards).toEqual([a])
    // Even with its history head as the edit left it, work it gained since refuses the undo.
    const forged = { ...r.undo!, back: [{ number: b, head: (await card(b)).history.at(-1)?.id ?? null, work: false }] }
    await expect(edit({ op: 'undo', undo: forged })).rejects.toThrow(/keeps work/)
    // And with no record of the card at all, nothing comes back.
    await expect(edit({ op: 'undo', undo: { ...r.undo!, back: [] } })).rejects.toThrow(/changed since/)
    expect((await raw(l.id)).cards).toEqual([a])
  })

  it('refuses to bring back a card taken off that was given to another agent since, restoring nothing', async () => {
    const [a, b] = [await make('A'), await make('B')]
    const l = await start('b1', [a, b])
    const r = await edit({ op: 'remove', lane: l.id, rev: 0, card: b })
    await run(() => tasks.updateTask(b, { agent: 'b3' }, user))
    await expect(edit({ op: 'undo', undo: r.undo! })).rejects.toThrow(/changed since/)
    expect((await raw(l.id)).cards).toEqual([a])
    expect((await card(b)).agent).toBe('b3')
    // Given back to nobody: the same state, but a new history entry, so still refused.
    await run(() => tasks.updateTask(b, { agent: null }, user))
    await expect(edit({ op: 'undo', undo: r.undo! })).rejects.toThrow(/changed since/)
    expect((await raw(l.id)).cards).toEqual([a])
  })

  it('refuses a card from another project, a Done one, one not in To do, one already there, and one on another lane', async () => {
    const [a, b, x] = [await make('A'), await make('B'), await make('X')]
    const other = await make('Other', { project: 'beta' })
    const done = await make('Done')
    await run(() => tasks.updateTask(done, { column: 'done' }, user))
    const held = await make('Held')
    await run(() => tasks.updateTask(held, { column: 'hold' }, user))
    const l = await start('b1', [a])
    const m = await start('b2', [x])
    await expect(edit({ op: 'add', lane: l.id, rev: 0, card: other })).rejects.toThrow(/isn’t one of alpha’s cards/)
    await expect(edit({ op: 'add', lane: l.id, rev: 0, card: done })).rejects.toThrow(/Done already/)
    await expect(edit({ op: 'add', lane: l.id, rev: 0, card: held })).rejects.toThrow(/isn’t in To do/)
    await expect(edit({ op: 'add', lane: l.id, rev: 0, card: a })).rejects.toThrow(/on this lane already/)
    await expect(edit({ op: 'add', lane: l.id, rev: 0, card: x })).rejects.toThrow(/on the lane of B2/)
    expect((await raw(l.id)).cards).toEqual([a])
    expect((await raw(m.id)).cards).toEqual([x])
    void b
  })

  it('refuses a card placed before one it depends on', async () => {
    const [a, b, c] = [await make('A'), await make('B'), await make('C')]
    await run(() => tasks.updateTask(c, { blockedBy: [b] }, user))
    const l = await start('b1', [a, b, c])
    await expect(edit({ op: 'move', lane: l.id, rev: 0, card: c, to: 0 })).rejects.toThrow(/depends on/)
    await expect(edit({ op: 'move', lane: l.id, rev: 0, card: b, to: 2 })).rejects.toThrow(/depends on/)
    const d = await make('D')
    await run(() => tasks.updateTask(d, { blockedBy: [a] }, user))
    await expect(edit({ op: 'add', lane: l.id, rev: 0, card: d, at: 0 })).rejects.toThrow(/depends on/)
    await edit({ op: 'add', lane: l.id, rev: 0, card: d, at: 1 })
    expect((await raw(l.id)).cards).toEqual([a, d, b, c])
  })

  it('refuses a card keeping work from an earlier start', async () => {
    const [a, k] = [await make('A'), await make('Kept')]
    const l = await start('b1', [a])
    await doing(k, 'b3')
    await run(() => tasks.updateTask(k, { column: 'todo', agent: null }, user))
    await expect(edit({ op: 'add', lane: l.id, rev: 0, card: k })).rejects.toThrow(/keeps work/)
    expect((await raw(l.id)).cards).toEqual([a])
  })

  it('Add of a card given to another agent takes it off that agent in the same change; undo gives it back', async () => {
    const a = await make('A')
    const given = await make('Given', { agent: 'b3' })
    const own = await make('Own', { agent: 'b1' })
    const l = await start('b1', [a])
    const r = await edit({ op: 'add', lane: l.id, rev: 0, card: given })
    expect((await card(given)).agent).toBeNull()
    expect(r.undo?.card).toMatchObject({ number: given, before: 'b3', after: null })
    await edit({ op: 'undo', undo: r.undo! })
    expect((await card(given)).agent).toBe('b3')
    expect((await raw(l.id)).cards).toEqual([a])
    // The builder's own card: left as it is, nothing to give back.
    const r2 = await edit({ op: 'add', lane: l.id, rev: 2, card: own })
    expect((await card(own)).agent).toBe('b1')
    expect(r2.undo?.card).toBeNull()
    // Only the last change undoes: an older one's lane moved on since.
    await expect(edit({ op: 'undo', undo: r.undo! })).rejects.toThrow(/changed meanwhile/)
    await edit({ op: 'undo', undo: r2.undo! })
    expect((await card(own)).agent).toBe('b1')
    expect((await raw(l.id)).cards).toEqual([a])
  })

  it('Move here takes a card off one lane and onto another in one change, with its assignment, and the lane takes it next', async () => {
    const [a, x] = [await make('A'), await make('X')]
    const t = await make('T', { agent: 'b1' })
    const from = await start('b1', [a, t])
    const to = await start('b2', [x])
    await doing(x, 'b2')
    await run(() => tasks.updateTask(x, { column: 'done' }, user))
    const r = await edit({ op: 'transfer', card: t, from: { lane: from.id, rev: 0 }, to: { lane: to.id, rev: 0 } })
    expect((await raw(from.id)).cards).toEqual([a])
    expect((await raw(to.id)).cards).toEqual([x, t])
    expect((await card(t)).agent).toBeNull()
    expect((await lanes.laneNext(w, 'alpha', 'b2')).next?.card).toBe(t)
    expect(resumed.sort()).toEqual([from.id, to.id].sort())
    // Undone whole: both lists and its agent.
    await edit({ op: 'undo', undo: r.undo! })
    expect((await raw(from.id)).cards).toEqual([a, t])
    expect((await raw(to.id)).cards).toEqual([x])
    expect((await card(t)).agent).toBe('b1')
  })

  it('a refused destination leaves the source lane and the assignment as they were', async () => {
    const [a, x, dep] = [await make('A'), await make('X'), await make('Dep')]
    const t = await make('T', { agent: 'b1' })
    await run(() => tasks.updateTask(t, { blockedBy: [dep] }, user))
    const from = await start('b1', [a, t])
    const to = await start('b2', [x, dep])
    await expect(edit({ op: 'transfer', card: t, from: { lane: from.id, rev: 0 }, to: { lane: to.id, rev: 0 }, at: 0 })).rejects.toThrow(/depends on/)
    await expect(edit({ op: 'transfer', card: t, from: { lane: from.id, rev: 0 }, to: { lane: to.id, rev: 7 } })).rejects.toThrow(/changed meanwhile/)
    expect((await raw(from.id)).cards).toEqual([a, t])
    expect((await raw(to.id)).cards).toEqual([x, dep])
    expect((await card(t)).agent).toBe('b1')
    expect((await raw(from.id)).listRev ?? 0).toBe(0)
  })

  it("refuses an undo once the card was given to someone since, even back again (same state, new history), restoring nothing", async () => {
    const [a, x] = [await make('A'), await make('X')]
    const t = await make('T', { agent: 'b1' })
    const from = await start('b1', [a, t])
    const to = await start('b2', [x])
    const r = await edit({ op: 'transfer', card: t, from: { lane: from.id, rev: 0 }, to: { lane: to.id, rev: 0 } })
    await run(() => tasks.updateTask(t, { agent: 'b3' }, user))
    await run(() => tasks.updateTask(t, { agent: null }, user))
    await expect(edit({ op: 'undo', undo: r.undo! })).rejects.toThrow(/changed since/)
    expect((await raw(from.id)).cards).toEqual([a])
    expect((await raw(to.id)).cards).toEqual([x, t])
    expect((await card(t)).agent).toBeNull()
  })

  it('refuses an undo after another change of either lane, and an edit of a lane ended and started again', async () => {
    const [a, b, x] = [await make('A'), await make('B'), await make('X')]
    const from = await start('b1', [a, b])
    const to = await start('b2', [x])
    const r = await edit({ op: 'transfer', card: b, from: { lane: from.id, rev: 0 }, to: { lane: to.id, rev: 0 } })
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [x, b, a], by: 'the user' }).catch(() => undefined)
    await edit({ op: 'move', lane: to.id, rev: (await raw(to.id)).listRev!, card: b, to: 0 })
    await expect(edit({ op: 'undo', undo: r.undo! })).rejects.toThrow(/changed meanwhile/)
    expect((await raw(from.id)).cards).toEqual([a])
    // Ended and a new lane for the same builder: the old id and revision never match it.
    await lanes.endLane(w, from.id, { abandoned: true })
    const again = await start('b1', [a])
    expect(again.id).not.toBe(from.id)
    await expect(edit({ op: 'add', lane: from.id, rev: 1, card: a })).rejects.toThrow(/has ended/)
  })

  it('refuses a forged undo that would move a card before one already started', async () => {
    const [a, b] = [await make('A'), await make('B')]
    const l = await start('b1', [a, b])
    await doing(a, 'b1')
    await expect(edit({ op: 'undo', undo: { lanes: [{ before: { lane: l.id, cards: [b, a], pending: null }, rev: 0 }], card: null, back: [] } })).rejects.toThrow(/keep their places/)
    expect((await raw(l.id)).cards).toEqual([a, b])
  })

  it("the runtime's own list writes move the revision on too: applying or dropping a queued list, changing the cards", async () => {
    const { FactStore } = await import('../src/main/workflow/factStore')
    const [a, b] = [await make('A'), await make('B')]
    const l = await start('b1', [a])
    const facts = FactStore.forBoard(w, { project: 'alpha', key: 'alpha' })
    const rev = async () => (await raw(l.id)).listRev ?? 0
    const { boardWrite } = await import('../src/main/boardStore')
    const save = (fn: () => void) => boardWrite(w, async () => fn())
    await save(() => facts.saveLane({ ...facts.lane(l.id)!, pending: [a, b] }))
    expect(await rev()).toBe(1)
    // The same list again: nothing changed, no new revision.
    await save(() => facts.saveLane({ ...facts.lane(l.id)! }))
    expect(await rev()).toBe(1)
    await save(() => facts.saveLane({ ...facts.lane(l.id)!, cards: [a, b], pending: null }))
    expect(await rev()).toBe(2)
    expect((await raw(l.id)).cards).toEqual([a, b])
    // An edit made on the revision before the runtime's write is refused.
    await expect(edit({ op: 'move', lane: l.id, rev: 1, card: b, to: 0 })).rejects.toThrow(/changed meanwhile/)
  })

  it('lists the lanes ended since a time, newest first', async () => {
    const a = await make('A')
    const since = Date.now() - 1
    const l = await start('b1', [a])
    await lanes.endLane(w, l.id, { abandoned: true })
    const ended = await lanes.lanesEndedSince(w, since)
    expect(ended.map((x) => x.id)).toContain(l.id)
    expect(await lanes.lanesEndedSince(w, Date.now() + 60_000)).toEqual([])
  })
})
