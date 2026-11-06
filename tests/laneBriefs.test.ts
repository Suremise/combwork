// A lane's brief for its builder (HI-1795, laneBriefs.ts, shared/lanes.ts nextBrief): kept with the lane through its
// updates (none given: kept; the same text: nothing changes; a new text or a clear: the next rev, never one used before),
// a queued list change and a restart (a fresh read of the board); outside slots, delivered to the builder once per rev,
// a replaced or cleared one's delivery not received yet cancelled, one owed made by the next look (a crash between the
// lane's save and its delivery). A real workspace and board, rules on, a project not built in slots.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-lane-briefs-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { deliveriesOf, readInbox } = await import('../src/main/deliveries')
const { LANE_BRIEF_SOURCE, laneBriefHoldsForTests, laneBriefRefreshForTests, settleLaneBriefs } = await import('../src/main/laneBriefs')
const { sessions } = await import('../src/main/sessions')
const { nextBrief } = await import('../src/shared/lanes')

describe("a lane's brief as it changes (nextBrief)", () => {
  it('none given keeps it; the same text changes nothing; a new text or a clear takes the next rev; a clear then a re-add never reuses one', () => {
    expect(nextBrief(undefined, undefined)).toBeUndefined()
    expect(nextBrief(undefined, '')).toBeUndefined()
    const one = nextBrief(undefined, '  Stay off src/renderer.  ')!
    expect(one).toEqual({ text: 'Stay off src/renderer.', rev: 1, out: null })
    expect(nextBrief(one, undefined)).toBe(one)
    expect(nextBrief({ ...one, out: 1 }, 'Stay off src/renderer.')).toEqual({ ...one, out: 1 })
    const two = nextBrief({ ...one, out: 1 }, 'Stay off src/main.')!
    expect(two).toEqual({ text: 'Stay off src/main.', rev: 2, out: 1 })
    const cleared = nextBrief(two, '')!
    expect(cleared).toEqual({ text: null, rev: 3, out: 1 })
    expect(nextBrief(cleared, '')).toBe(cleared)
    expect(nextBrief(cleared, 'Back again.')).toEqual({ text: 'Back again.', rev: 4, out: 1 })
    expect(nextBrief(undefined, 'x'.repeat(5000))!.text).toHaveLength(4000)
  })
})

describe("a lane's brief kept with the lane, and delivered outside slots (HI-1795)", () => {
  type WS = ReturnType<typeof createWorkspaceService>
  let w: WS
  const wsPath = join(base, 'ws')
  const project = join(wsPath, 'alpha')
  const user = { kind: 'user' } as const
  beforeAll(async () => {
    mkdirSync(join(project, '.combwork'), { recursive: true })
    writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    lanes.startLanes()
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
  })
  // Each test's lane ended after it, so the next starts its own (with rules on, a start edits the builder's running lane).
  afterEach(async () => {
    for (const l of await lanes.rawLanes(w)) if (l.state === 'active') await lanes.endLane(w, l.id, { abandoned: true })
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = async (title: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha' }, user))).number
  const move = (n: number, column: 'doing' | 'done') => run(() => tasks.updateTask(n, { column, ...(column === 'doing' ? { agent: 'b1' } : {}) }, user))
  const briefOf = async (id: string) => (await lanes.rawLanes(w)).find((l) => l.id === id)?.brief
  /** The builder's lane-brief deliveries of a lane, as `<rev>:<state>`, oldest first. */
  const briefs = async (id: string) => (await deliveriesOf(project, 'b1')).filter((d) => d.source === LANE_BRIEF_SOURCE && d.ref?.startsWith(`${id}:`)).map((d) => `${d.ref!.split(':')[1]}:${d.state}`)
  const start = (cards: number[], brief?: string) => lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards, by: 'the Assistant', ...(brief !== undefined ? { brief } : {}) })

  it('kept through updates without one and a queued list change, changed by a new text or a clear, and read back after a restart', async () => {
    const [a, b] = [await make('Kept a'), await make('Kept b')]
    const l = (await start([a], 'Lane order: a then b.')).lane
    expect(await briefOf(l.id)).toMatchObject({ text: 'Lane order: a then b.', rev: 1 })
    // An update with no brief (the list changed between cards): kept as it is.
    await start([a, b])
    expect(await briefOf(l.id)).toMatchObject({ text: 'Lane order: a then b.', rev: 1 })
    // A card in flight: the list change is queued; the brief is still the lane's.
    await move(a, 'doing')
    const queued = await start([a, b, await make('Kept c')])
    expect(queued.lane.queued).not.toBeNull()
    expect(await briefOf(l.id)).toMatchObject({ text: 'Lane order: a then b.', rev: 1 })
    // The same text again: nothing changes.
    await start([a, b], 'Lane order: a then b.')
    expect(await briefOf(l.id)).toMatchObject({ rev: 1 })
    await start([a, b], 'Stay off the renderer.')
    expect(await briefOf(l.id)).toMatchObject({ text: 'Stay off the renderer.', rev: 2 })
    // Read back from the board by a Combwork started again (the workspace closed, then opened by a new service).
    await disposeWorkspaceService(w)
    w = createWorkspaceService()
    await w.open(wsPath)
    expect(await briefOf(l.id)).toMatchObject({ text: 'Stay off the renderer.', rev: 2 })
  })

  it('delivered once per rev; an update without one delivers nothing; a replaced one not received is cancelled; a clear then a re-add gives a new rev', async () => {
    const a = await make('Delivered a')
    const l = (await start([a], 'First brief.')).lane
    await settleLaneBriefs(w)
    expect(await briefs(l.id)).toEqual(['1:queued'])
    expect((await deliveriesOf(project, 'b1')).find((d) => d.ref === `${l.id}:1`)?.body).toMatch(/Your lane's brief \(lane .*, from the Assistant\):\nFirst brief\./)
    expect(await briefOf(l.id)).toMatchObject({ rev: 1, out: 1 })
    // Looked at again, and an update with no brief: nothing more.
    await settleLaneBriefs(w)
    await start([a])
    await settleLaneBriefs(w)
    expect(await briefs(l.id)).toEqual(['1:queued'])
    // Replaced before it was received: the old one cancelled, the new one queued.
    await start([a], 'Second brief.')
    await settleLaneBriefs(w)
    expect(await briefs(l.id)).toEqual(['1:cancelled', '2:queued'])
    // Received, then replaced: the received one stays as it was; the new one follows.
    await readInbox(project, 'b1')
    await start([a], 'Third brief.')
    await settleLaneBriefs(w)
    expect(await briefs(l.id)).toEqual(['1:cancelled', '2:received', '3:queued'])
    // Cleared: its unreceived delivery cancelled, nothing new; re-added: the next rev, never one used before.
    await start([a], '')
    await settleLaneBriefs(w)
    expect(await briefs(l.id)).toEqual(['1:cancelled', '2:received', '3:cancelled'])
    expect(await briefOf(l.id)).toMatchObject({ text: null, rev: 4, out: 4 })
    await start([a], 'Back again.')
    await settleLaneBriefs(w)
    expect(await briefs(l.id)).toEqual(['1:cancelled', '2:received', '3:cancelled', '5:queued'])
  })

  it("refreshed just before it is offered: only its lane's current brief, of a running lane, is offered; any other is cancelled", async () => {
    const a = await make('Refreshed a')
    const l = (await start([a], 'Current one.')).lane
    const at = (rev: number) => laneBriefRefreshForTests({ source: LANE_BRIEF_SOURCE, ref: `${l.id}:${rev}` } as never, project)
    expect(await at(1)).toBeNull()
    await start([a], 'Replaced.')
    expect(await at(1)).toEqual({ cancel: expect.stringMatching(/no longer current/) })
    expect(await at(2)).toBeNull()
    await start([a], '')
    expect(await at(2)).toEqual({ cancel: expect.stringMatching(/no longer current/) })
    await start([a], 'Again.')
    expect(await at(4)).toBeNull()
    await lanes.endLane(w, l.id, { abandoned: true })
    expect(await at(4)).toEqual({ cancel: expect.stringMatching(/no longer current/) })
  })

  it("a lane's start task, which shares the source's id (laneStart.ts: ref <lane>:<role>), is never cancelled as a brief (HI-2029: Legible's and HB5's lanes)", async () => {
    const a = await make('Start task a')
    const l = (await start([a], 'Its brief.')).lane
    for (const role of ['builder', 'reviewer']) expect(await laneBriefRefreshForTests({ source: LANE_BRIEF_SOURCE, kind: 'task', ref: `${l.id}:${role}` } as never, project)).toBeNull()
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it("two open workspaces whose folders share a prefix (ws, ws-other): each one's current brief stays valid, found in its own workspace (HR4's round 1)", async () => {
    const otherPath = `${wsPath}-other`
    const otherProject = join(otherPath, 'alpha')
    mkdirSync(join(otherProject, '.combwork'), { recursive: true })
    writeFileSync(join(otherProject, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] }))
    const other = createWorkspaceService()
    await other.open(otherPath)
    try {
      const mine = (await start([await make('Mine a')], 'Brief of ws.')).lane
      const theirCard = (await inWorkspace(other, () => tasks.createTask({ title: 'Theirs a', project: 'alpha' }, user))).number
      const theirs = (await lanes.startLane(other, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [theirCard], by: 'the Assistant', brief: 'Brief of ws-other.' })).lane
      expect(await laneBriefRefreshForTests({ source: LANE_BRIEF_SOURCE, ref: `${mine.id}:1` } as never, project)).toBeNull()
      expect(await laneBriefRefreshForTests({ source: LANE_BRIEF_SOURCE, ref: `${theirs.id}:1` } as never, otherProject)).toBeNull()
      // Each lane is only its own workspace's: asked from the other's project, it isn't found there.
      expect(await laneBriefRefreshForTests({ source: LANE_BRIEF_SOURCE, ref: `${theirs.id}:1` } as never, project)).toEqual({ cancel: expect.stringMatching(/no longer current/) })
      await lanes.endLane(other, theirs.id, { abandoned: true })
    } finally {
      await disposeWorkspaceService(other)
    }
  })

  it("never offered into the builder's conversation running as the brief was given: its next conversation (or none running) gets it", async () => {
    const a = await make('Not in a')
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'the Assistant', brief: 'For the next conversation.', briefNotIn: 'conv-old' })).lane
    await settleLaneBriefs(w)
    const d = (await deliveriesOf(project, 'b1')).find((x) => x.source === LANE_BRIEF_SOURCE && x.ref === `${l.id}:1`)!
    expect(d.meta).toMatchObject({ notIn: 'conv-old' })
    const running = vi.spyOn(sessions, 'liveFor')
    try {
      running.mockReturnValue({ sessionId: 'conv-old' } as never)
      expect(laneBriefHoldsForTests(d, project, 'offer' as never)).toBe(false)
      running.mockReturnValue({ sessionId: 'conv-new' } as never)
      expect(laneBriefHoldsForTests(d, project, 'offer' as never)).toBe(true)
      running.mockReturnValue(null)
      expect(laneBriefHoldsForTests(d, project, 'offer' as never)).toBe(true)
    } finally {
      running.mockRestore()
    }
  })

  it("a lane's edits (HR4's round 2): before its first new conversation they keep its exclusion; after, they reach its working conversation", async () => {
    const a = await make('Edited a')
    // As the API does, each start passes the builder's conversation running then.
    const edit = (brief: string, running: string) => lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'the Assistant', brief, briefNotIn: running })
    const l = (await edit('First.', 'conv-old')).lane
    const offered = async (rev: number, running: string): Promise<boolean> => {
      await settleLaneBriefs(w)
      const d = (await deliveriesOf(project, 'b1')).find((x) => x.source === LANE_BRIEF_SOURCE && x.ref === `${l.id}:${rev}`)!
      const live = vi.spyOn(sessions, 'liveFor').mockReturnValue({ sessionId: running } as never)
      try {
        return laneBriefHoldsForTests(d, project, 'offer' as never)
      } finally {
        live.mockRestore()
      }
    }
    // The new lane: never into the conversation it began beside.
    expect(await offered(1, 'conv-old')).toBe(false)
    // Edited before the builder's first new conversation: still not into that one, and the lane keeps that exclusion.
    await edit('Edited before.', 'conv-old')
    expect(await briefOf(l.id)).toMatchObject({ rev: 2, notIn: 'conv-old' })
    expect(await offered(2, 'conv-old')).toBe(false)
    expect(await offered(2, 'conv-lane')).toBe(true)
    // The builder works in its lane conversation (it got the brief there); edited again from there: that conversation
    // gets it, with no restart (it is never excluded, whatever conversation the edit was given beside).
    await edit('Edited after.', 'conv-lane')
    expect(await briefOf(l.id)).toMatchObject({ rev: 3, notIn: 'conv-old' })
    expect(await offered(3, 'conv-lane')).toBe(true)
  })

  it("one owed (saved, its delivery not yet made or not yet recorded) is made by the next look, once", async () => {
    const a = await make('Owed a')
    // Saved with the lane, no look yet (a crash before its delivery): the next look makes it.
    const l = (await start([a], 'Owed brief.')).lane
    expect(await briefOf(l.id)).toMatchObject({ rev: 1, out: null })
    await settleLaneBriefs(w)
    expect(await briefs(l.id)).toEqual(['1:queued'])
    // Made, but its record lost (a crash between the delivery and the lane's save): the next look makes no second one.
    await lanes.mutateLanes(w, (all) => {
      const x = all.find((y) => y.id === l.id)!
      x.brief = { ...x.brief!, out: null }
    })
    await settleLaneBriefs(w)
    expect(await briefs(l.id)).toEqual(['1:queued'])
    expect(await briefOf(l.id)).toMatchObject({ rev: 1, out: 1 })
  })

  describe("a list change that raced its lane's end (HI-2097)", () => {
    /** The lane ended as all its cards merged, `ago` ms before now. */
    const ended = (id: string, ago = 0) =>
      lanes.mutateLanes(w, (all) => {
        const x = all.find((y) => y.id === id)!
        Object.assign(x, { state: 'ended', endedAt: new Date(Date.now() - ago).toISOString() })
      })
    const named = (cards: number[], brief: string) => lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards, name: 'Race lane', brief, by: 'the Assistant' })

    it('a start just after it ended carries its brief and name, and leaves out a card already Done, saying both', async () => {
      const [a, b] = [await make('Raced a'), await make('Raced b')]
      const l = (await named([a], 'Test slots: two heavy.')).lane
      await move(a, 'done')
      await ended(l.id)
      const r = await start([a, b])
      expect([r.did, r.lane.id === l.id, r.lane.name, r.lane.cards.map((c) => c.number)]).toEqual(['started', false, 'Race lane', [b]])
      expect(await briefOf(r.lane.id)).toMatchObject({ text: 'Test slots: two heavy.', rev: 1 })
      expect(r.note).toContain(`B1's lane ${l.id} had just ended (all merged): started a new lane with its brief and name`)
      expect(r.note).toMatch(/is already Done: left out\./)
    })

    it('a start with its own name carries only the brief, and says only that (HI-2104)', async () => {
      const [a, b] = [await make('Renamed a'), await make('Renamed b')]
      const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], name: 'Old', brief: 'The kept brief.', by: 'the Assistant' })).lane
      await move(a, 'done')
      await ended(l.id)
      const r = await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [b], name: 'New', by: 'the Assistant' })
      expect([r.did, r.lane.id === l.id, r.lane.name]).toEqual(['started', false, 'New'])
      expect(await briefOf(r.lane.id)).toMatchObject({ text: 'The kept brief.', rev: 1 })
      expect(r.note).toContain(`B1's lane ${l.id} had just ended (all merged): started a new lane with its brief;`)
      expect(r.note).not.toContain('brief and name')
    })

    it('a start with its own brief uses that', async () => {
      const [a, b] = [await make('Own a'), await make('Own b')]
      const l = (await named([a], 'The old brief.')).lane
      await move(a, 'done')
      await ended(l.id)
      const r = await start([b], 'A new brief.')
      expect(await briefOf(r.lane.id)).toMatchObject({ text: 'A new brief.', rev: 1 })
      expect(r.note ?? '').not.toContain('had just ended')
    })

    it('a start long after it ended carries nothing', async () => {
      const [a, b] = [await make('Late a'), await make('Late b')]
      const l = (await named([a], 'Long gone.')).lane
      await move(a, 'done')
      await ended(l.id, lanes.LANE_CARRY_MS + 60_000)
      // The earlier tests' lanes, ended just now, too.
      await lanes.mutateLanes(w, (all) => {
        for (const x of all) if (x.state === 'ended') x.endedAt = new Date(Date.now() - lanes.LANE_CARRY_MS - 60_000).toISOString()
      })
      const r = await start([b])
      expect([r.did, r.lane.name, await briefOf(r.lane.id)]).toEqual(['started', null, undefined])
    })

    it('a list of only Done cards starts no lane', async () => {
      const a = await make('All done a')
      const l = (await named([a], 'Done already.')).lane
      await move(a, 'done')
      await ended(l.id)
      await expect(start([a])).rejects.toThrow(/already Done: no lane started/)
      expect((await lanes.rawLanes(w)).filter((x) => x.state === 'active')).toEqual([])
    })
  })
})
