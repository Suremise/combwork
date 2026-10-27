// A lane's brief for its builder (HI-1795, laneBriefs.ts, shared/lanes.ts nextBrief): kept with the lane through its
// updates (none given: kept; the same text: nothing changes; a new text or a clear: the next rev, never one used before),
// a queued list change and a restart (a fresh read of the board); outside slots, delivered to the builder once per rev,
// a replaced or cleared one's delivery not received yet cancelled, one owed made by the next look (a crash between the
// lane's save and its delivery). A real workspace and board, rules on, a project not built in slots.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-lane-briefs-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { deliveriesOf, readInbox } = await import('../src/main/deliveries')
const { LANE_BRIEF_SOURCE, laneBriefRefreshForTests, settleLaneBriefs } = await import('../src/main/laneBriefs')
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
    mkdirSync(join(project, '.hive'), { recursive: true })
    writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] }))
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
    // Read back from the board by a Hive started again (the workspace closed, then opened by a new service).
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
})
