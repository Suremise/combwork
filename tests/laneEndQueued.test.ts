// HI-3118: a lane with a list change queued behind its card in flight (a card added). cw_lane next and cw_lane end read
// the queued list once the boundary has passed (no card of the lane's own in flight), whether or not the lanes' look has
// applied it yet: the end is refused while it has open work, and the queue is never lost nor applied by the refusal.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-lane-endq-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
const { laneNextText } = await import('../src/shared/lanes')
const { workspaceDb } = await import('../src/main/boardStore')

vi.setConfig({ testTimeout: 60_000 })
afterEach(async () => {
  await advanced.set(ENFORCE, true)
})

describe('a lane ended or asked for its next card with a list change queued (HI-3118)', () => {
  type WS = ReturnType<typeof createWorkspaceService>
  let w: WS
  const wsPath = join(base, 'ws')
  const user = { kind: 'user' } as const
  beforeAll(async () => {
    const p = join(wsPath, 'alpha')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [...['b1', 'b3', 'b4', 'b5'].map((id) => ({ id, name: id.toUpperCase(), workflowRole: 'builder' })), { id: 'b2', name: 'B2', workflowRole: 'either' }, { id: 'b9', name: 'B9', workflowRole: 'reviewer' }, { id: 'r1', name: 'R1', workflowRole: 'either' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
    ;(await import('../src/main/boardStore')).closeAllBoards()
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = (title: string, agent: string) => run(() => tasks.createTask({ title, project: 'alpha', agent }, user))
  const move = (n: number, column: 'doing' | 'done') => run(() => tasks.updateTask(n, { column }, user))
  /** A lane of [a] for `b`, a in Doing, q added (queued behind a). */
  const queuedLane = async (b: string) => {
    const [a, q] = [await make(`In flight ${b}`, b), await make(`Queued ${b}`, b)]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: b, reviewer: 'r1', cards: [a.number], by: 'the Assistant' })).lane
    await move(a.number, 'doing')
    const added = await lanes.startLane(w, { project: 'alpha', builder: b, cards: [a.number, q.number], by: 'the Assistant' })
    expect(added.lane.queued).toEqual([a.number, q.number])
    return { a: a.number, q: q.number, id: l.id }
  }
  const ref = (n: number) => new RegExp(`(#|-)${n}\\b`)

  it('end first: its card Done, the look not run yet: next is the queued card, and the end is refused naming it, the queue kept', async () => {
    expect(await lanes.lanesEnforced()).toBe(true)
    const { a, q, id } = await queuedLane('b1')
    await move(a, 'done')
    expect((await lanes.laneNext(w, 'alpha', 'b1')).next?.card).toBe(q)
    await expect(lanes.endLane(w, id, { project: 'alpha', agent: 'b1' })).rejects.toThrow(ref(q))
    const now = await lanes.getLane(w, id)
    expect([now.state, now.queued]).toEqual(['active', [a, q]])
    // The look then applies it, as it would have.
    await lanes.refresh(w)
    const after = await lanes.getLane(w, id)
    expect([after.state, after.cards.map((c) => c.number)]).toEqual(['active', [a, q]])
    expect((await lanes.laneNext(w, 'alpha', 'b1')).next?.card).toBe(q)
    await lanes.endLane(w, id, { abandoned: true })
  })

  it('look first: the same next card, and the same refusal', async () => {
    const { a, q, id } = await queuedLane('b2')
    await move(a, 'done')
    await lanes.refresh(w)
    expect((await lanes.laneNext(w, 'alpha', 'b2')).next?.card).toBe(q)
    await expect(lanes.endLane(w, id, { project: 'alpha', agent: 'b2' })).rejects.toThrow(ref(q))
    await lanes.endLane(w, id, { abandoned: true })
  })

  it('its card still in flight: the current list is read, next carries on with it, and the end is refused naming it', async () => {
    const { a, id } = await queuedLane('b3')
    const r = await lanes.laneNext(w, 'alpha', 'b3')
    expect([r.next?.card, r.next?.carryOn]).toEqual([a, true])
    await expect(lanes.endLane(w, id, { project: 'alpha', agent: 'b3' })).rejects.toThrow(ref(a))
    expect((await lanes.getLane(w, id)).queued).toEqual([a, (await lanes.getLane(w, id)).queued![1]])
    await lanes.endLane(w, id, { abandoned: true })
  })

  it("the queued card given to another agent meanwhile: nothing of the lane's own is left, so its builder may end it, on its queued list", async () => {
    const { a, q, id } = await queuedLane('b4')
    await move(a, 'done')
    await run(() => tasks.updateTask(q, { agent: 'b9' }, user))
    const ended = await lanes.endLane(w, id, { project: 'alpha', agent: 'b4' })
    expect(ended.state).toBe('ended')
    expect(ended.cards.map((c) => c.number)).toEqual([a, q])
  })

  it("what cw_lane next says of a lane that just ended: all Done only when it was; the user's End with cards open names them", async () => {
    const said = (agent: string) => lanes.laneNext(w, 'alpha', agent).then(() => '', (e: Error) => e.message)
    // Ended with every card Done.
    const d = await make('Done one', 'b5')
    const done = (await lanes.startLane(w, { project: 'alpha', builder: 'b5', reviewer: 'r1', cards: [d.number], by: 'the Assistant' })).lane
    await move(d.number, 'doing')
    await move(d.number, 'done')
    await lanes.refresh(w)
    expect((await lanes.getLane(w, done.id)).state).toBe('ended')
    expect(await said('b5')).toMatch(/has ended: all its cards are Done/)
    // The user's End with one card in Doing and one in Todo.
    const [o1, o2] = [await make('Open one', 'b5'), await make('Open two', 'b5')]
    const open = (await lanes.startLane(w, { project: 'alpha', builder: 'b5', reviewer: 'r1', cards: [o1.number, o2.number], by: 'the Assistant' })).lane
    await move(o1.number, 'doing')
    await lanes.endLane(w, open.id, {})
    const text = await said('b5')
    expect(text).toMatch(/was ended with .* not Done/)
    expect(text).toMatch(ref(o1.number))
    expect(text).toMatch(ref(o2.number))
    expect(text).not.toMatch(/all its cards are Done/)
  })

  it('an agent that only reviews gets a reviewer answer: the card waiting in Review in any of its lanes, else none; one that also builds gets its lane', async () => {
    await advanced.set(ENFORCE, false)
    const [x1, y1, z1] = [await make('Lane A card', 'b1'), await make('Lane B card', 'b2'), await make('Own lane card', 'r1')]
    const a = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'b9', cards: [x1.number], by: 'You' })).lane
    const b = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'b9', cards: [y1.number], by: 'You' })).lane
    // Nothing in Review yet: none, never "Next: … Start it."
    const none = await lanes.laneNext(w, 'alpha', 'b9')
    expect(none.review).toBeNull()
    expect(laneNextText(none)).toMatch(/No card of your lanes waits for your review/)
    // The second lane's card submitted: that one, whatever the first lane has.
    await run(() => tasks.updateTask(y1.number, { column: 'review' }, user))
    const r = await lanes.laneNext(w, 'alpha', 'b9')
    expect([r.lane.id, r.review?.card]).toEqual([b.id, y1.number])
    expect(laneNextText(r)).toMatch(new RegExp(`${ref(y1.number).source}.*waits for your review \\(lane ${b.id}\\)`))
    expect(laneNextText(r)).not.toMatch(/Start it/)
    // HR2's round 1: the first lane's card in Review too, its review held by another agent (r1): never offered; the free
    // one is. Once B9 holds a review itself, that one comes first (it carries on with it).
    await run(() => tasks.updateTask(x1.number, { column: 'review' }, user))
    const reviewBy = (n: number, agent: string | null) => workspaceDb(w.path!).writer.prepare('UPDATE cards SET review_agent = ?, review_agent_name = ?, review_since = ? WHERE number = ?').run(agent, agent?.toUpperCase() ?? null, agent ? new Date().toISOString() : null, n)
    reviewBy(x1.number, 'r1')
    expect((await lanes.laneNext(w, 'alpha', 'b9')).review?.card).toBe(y1.number)
    reviewBy(y1.number, 'r1')
    expect((await lanes.laneNext(w, 'alpha', 'b9')).review).toBeNull()
    reviewBy(x1.number, 'b9')
    expect((await lanes.laneNext(w, 'alpha', 'b9')).review?.card).toBe(x1.number)
    reviewBy(y1.number, null)
    expect((await lanes.laneNext(w, 'alpha', 'b9')).review?.card).toBe(x1.number)
    reviewBy(x1.number, null)
    // An agent that builds a lane and reviews another: its own lane, as a builder.
    const own = (await lanes.startLane(w, { project: 'alpha', builder: 'r1', reviewer: 'b2', cards: [z1.number], by: 'You' })).lane
    await lanes.endLane(w, a.id, { abandoned: true })
    const both = await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [x1.number], by: 'You' })
    const mine = await lanes.laneNext(w, 'alpha', 'r1')
    expect([mine.lane.id, mine.review, mine.next?.card]).toEqual([own.id, undefined, z1.number])
    for (const l of [b, own, both.lane]) await lanes.endLane(w, l.id, { abandoned: true })
  })
})
