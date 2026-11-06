// A lane's due card waiting for the cards it depends on (HI-2618). On 5 Nov HB6's HI-2616 was next in its lane while the
// three cards it depends on (HI-2610, HI-2611, HI-2612) were still being built in other lanes, and the lane-next stall
// reported it to the Assistant's lane watch 29 times: each lane-start look cleared the lanes' start waits and set them
// again only after its awaits, so a reading in between saw nothing waited on. Now the lane says every dependency it waits
// on (a state, from the board, the rules on or off), the stall checks leave it alone, a look's waits are published whole
// and only by a look still current, and the wait is an episode kept with the lane: with the rules off its builder is told
// once when the last dependency lands (its delivery made once by a receipt in the deliveries' own transaction), whatever
// crashes or prunes meanwhile.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

vi.mock('../src/main/ptyHost', async (original) => ({ ...(await original<object>()), writePty: () => undefined }))

const base = tempDir('cw-lanedeps-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { checkLaneStarts, laneStartsTestHooks } = await import('../src/main/laneStarts')
const { laneDepsTestHooks, laneDepsRefreshForTests, LANE_DEPS_SOURCE, startLaneDeps } = await import('../src/main/laneDeps')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
const deliveries = await import('../src/main/deliveries')
const { cardStallIn, laneOrderView, laneNextWaitReason, LANE_NEXT_STALL_MS } = await import('../src/main/cardStall')
const { lanesNowIn } = await import('../src/main/watches')
const { laneStatusText } = await import('../src/shared/lanes')

const user = { kind: 'user' } as const
const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const card = async (title: string, agent: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', agent }, user))).number
const move = (n: number, column: 'todo' | 'done'): Promise<unknown> => run(() => tasks.updateTask(n, { column }, user))
const keyOf = async (n: number): Promise<string> => (await (await import('../src/main/workflow/service')).workflowFor(w, p))!.store.card(n).key
const episode = async (lane: string) => (await lanes.rawLanes(w)).find((l) => l.id === lane)?.depEpisode
const wakes = async (builder: string) => (await deliveries.deliveriesOf(p, builder)).filter((d) => d.source === LANE_DEPS_SOURCE)
/** A lane's next card and the three cards it depends on, being built elsewhere, as HB6's lane had HI-2616. */
async function hb6(builder: string): Promise<{ lane: string; next: number; deps: number[] }> {
  const deps = [await card('Sweep 2 fixes 1', 'o1'), await card('Sweep 2 fixes 2', 'o2'), await card('Sweep 2 fixes 3', 'o3')]
  const prev = await card('Sweep 2 fixes 4', builder)
  const next = await card('Sweep 2 fixes 7', builder)
  await run(() => tasks.updateTask(next, { blockedBy: deps }, user))
  const lane = (await lanes.startLane(w, { project: 'alpha', builder, reviewer: 'r1', cards: [prev, next], by: 'the Assistant' })).lane.id
  await move(prev, 'done')
  return { lane, next, deps }
}

describe("a lane's due card waiting on its dependencies (HI-2618)", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'o1', 'o2', 'o3', 'r1']
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: ids.map((id) => ({ id, name: id.toUpperCase() })) }))
    w = createWorkspaceService()
    await w.open(wsPath)
    await w.mutateProjectConfig(p, () => ({ workflow: { platform: 'none', preset: null, options: { dependenciesDone: true } } }))
    startLaneDeps()
  })
  afterAll(async () => {
    await advanced.set(ENFORCE, true)
    await disposeWorkspaceService(w)
    ;(await import('../src/main/boardStore')).closeAllBoards()
  })
  beforeEach(async () => {
    laneStartsTestHooks.midPass = null
    laneStartsTestHooks.beforeStart = null
    laneDepsTestHooks.afterClaim = null
    laneDepsTestHooks.afterEnqueue = null
    for (const l of await lanes.listLanes(w)) if (l.state === 'active' || l.state === 'paused') await lanes.endLane(w, l.id, { abandoned: true })
    await advanced.set(ENFORCE, true)
  })

  it('HB6\'s case: the lane says every dependency it waits on, and nothing calls it stalled, even while a look is held between its awaits', async () => {
    const { lane, next, deps } = await hb6('b1')
    const keys = await Promise.all(deps.map(keyOf))
    await checkLaneStarts(w)
    const view = await lanes.getLane(w, lane)
    expect(view.status).toMatchObject({ reason: 'startWait', card: next, why: 'dependencies', waitingOn: keys })
    expect(view.dueDeps).toEqual({ card: next, open: keys, readyAt: null })
    expect(laneStatusText(view.status!)).toContain(`it waits for ${keys.join(', ')} to merge`)
    const c = await run(() => tasks.getTask(next, w))
    // Read as the stall check reads it, 40 minutes on: with the status, and with it gone (the board alone decides).
    const order = laneOrderView(view, () => undefined)
    const later = Date.now() + 40 * 60_000
    expect(laneNextWaitReason(c, order, { name: 'B1', status: 'watching' }, later)).toBeNull()
    expect(laneNextWaitReason(c, { ...order, waitsForDependency: undefined }, { name: 'B1', status: 'watching' }, later)).toBeNull()
    // A second look held between its awaits: the lanes, the card and the lane watch read meanwhile still say it waits.
    let release!: () => void
    let held!: () => void
    const reached = new Promise<void>((r) => (held = r))
    laneStartsTestHooks.midPass = () => {
      held()
      return new Promise<void>((r) => (release = r))
    }
    const pass = checkLaneStarts(w)
    await reached
    laneStartsTestHooks.midPass = null
    const during = await lanes.getLane(w, lane)
    expect(during.status).toMatchObject({ why: 'dependencies', waitingOn: keys })
    expect(await cardStallIn(w, c, new Map(), laneOrderView(during, () => undefined))).toBeNull()
    const watch = (await lanesNowIn(w, {}, new Date(0).toISOString())).find((l) => l.id === lane)!
    expect(watch.cards.find((x) => x.number === next)?.stalled ?? null).toBeNull()
    release()
    await pass
    // And a third look, unchanged: the same.
    await checkLaneStarts(w)
    expect((await lanes.getLane(w, lane)).status).toMatchObject({ why: 'dependencies', waitingOn: keys })
  })

  it('a look that fails publishes nothing, and one overtaken by a later look publishes nothing', async () => {
    const { lane, deps } = await hb6('b2')
    const keys = await Promise.all(deps.map(keyOf))
    await checkLaneStarts(w)
    laneStartsTestHooks.midPass = async () => {
      throw new Error('a look that failed')
    }
    await expect(checkLaneStarts(w)).rejects.toThrow(/a look that failed/)
    expect((await lanes.getLane(w, lane)).status).toMatchObject({ why: 'dependencies', waitingOn: keys })
    // Overtaken: the first look held while a second runs to its end; the first's end changes nothing.
    let release!: () => void
    laneStartsTestHooks.midPass = () => new Promise<void>((r) => (release = r))
    const first = checkLaneStarts(w)
    await vi.waitFor(() => expect(release).toBeDefined())
    laneStartsTestHooks.midPass = null
    await move(deps[0], 'done')
    await checkLaneStarts(w)
    const after = (await lanes.getLane(w, lane)).status
    release()
    await first
    expect((await lanes.getLane(w, lane)).status).toEqual(after)
  })

  it('the rules on: no readiness wake (Combwork starts the card), the episode claimed once the last one lands; the stall counts from then', async () => {
    const { lane, next, deps } = await hb6('b3')
    // Combwork's start of it once they are Done is laneStarts.test.ts's (HI-2129): held here, its builder not running.
    laneStartsTestHooks.beforeStart = async () => {
      throw new Error('not started in this test')
    }
    await checkLaneStarts(w)
    const ep = await episode(lane)
    expect(ep).toMatchObject({ card: next, state: 'waiting' })
    // One of them Done: still waiting, the same episode.
    await move(deps[0], 'done')
    await checkLaneStarts(w)
    expect(await episode(lane)).toMatchObject({ id: ep!.id, state: 'waiting' })
    for (const d of deps.slice(1)) await move(d, 'done')
    const view = await lanes.getLane(w, lane)
    expect(view.dueDeps).toMatchObject({ card: next, open: [] })
    const readyAt = Date.parse(view.dueDeps!.readyAt!)
    // Its builder watching (not started), counted from the last dependency's Done, not the card before it. (The status
    // still says the last look's dependency wait until the next look, which would start it: read without it.)
    const c = await run(() => tasks.getTask(next, w))
    const order = { ...laneOrderView(view, () => undefined), waitsForDependency: undefined }
    expect(laneNextWaitReason(c, order, { name: 'B3', status: 'watching' }, readyAt + LANE_NEXT_STALL_MS - 60_000)).toBeNull()
    expect(laneNextWaitReason(c, order, { name: 'B3', status: 'watching' }, readyAt + LANE_NEXT_STALL_MS + 60_000)).toMatch(/the last of the cards it depends on went Done 16 min ago, and B3 is only watching/)
    await checkLaneStarts(w)
    expect(await episode(lane)).toMatchObject({ id: ep!.id, state: 'sent' })
    expect(await wakes('b3')).toEqual([])
  })

  it('the rules off: the lane still says what it waits on; its builder is told once, when the last lands; a reopened one is a new episode', async () => {
    await advanced.set(ENFORCE, false)
    const { lane, next, deps } = await hb6('b4')
    await checkLaneStarts(w)
    expect((await lanes.getLane(w, lane)).status).toMatchObject({ reason: 'startWait', why: 'dependencies', waitingOn: await Promise.all(deps.map(keyOf)) })
    const first = await episode(lane)
    expect(first).toMatchObject({ card: next, state: 'waiting' })
    await move(deps[0], 'done')
    await move(deps[1], 'done')
    await checkLaneStarts(w)
    expect(await wakes('b4')).toEqual([])
    await move(deps[2], 'done')
    await checkLaneStarts(w)
    const told = await wakes('b4')
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(new RegExp(`${await keyOf(next)}'s dependencies are Done \\(${(await Promise.all(deps.map(keyOf))).join(', ')}\\)`))
    expect(await episode(lane)).toMatchObject({ id: first!.id, state: 'sent' })
    // Looks after it, unchanged: nothing more.
    await checkLaneStarts(w)
    await checkLaneStarts(w)
    expect(await wakes('b4')).toHaveLength(1)
    // A dependency reopened: a new episode; Done again, one more wake.
    await move(deps[1], 'todo')
    await checkLaneStarts(w)
    const second = await episode(lane)
    expect(second).toMatchObject({ card: next, state: 'waiting' })
    expect(second!.id).not.toBe(first!.id)
    await move(deps[1], 'done')
    await checkLaneStarts(w)
    expect(await wakes('b4')).toHaveLength(2)
  })

  it('crash boundaries: after the claim and before the delivery, one is made next; after the delivery and before its checkpoint, none more; received, acked and pruned with the cursor still pending, none more', async () => {
    await advanced.set(ENFORCE, false)
    const { lane, deps } = await hb6('b5')
    await checkLaneStarts(w)
    for (const d of deps) await move(d, 'done')
    // The claim made, then "Combwork stops" before the delivery.
    laneDepsTestHooks.afterClaim = async () => {
      throw new Error('stopped after the claim')
    }
    await expect(checkLaneStarts(w)).rejects.toThrow(/stopped after the claim/)
    expect(await episode(lane)).toMatchObject({ state: 'pending' })
    expect(await wakes('b5')).toEqual([])
    laneDepsTestHooks.afterClaim = null
    // The next look makes it, and stops before its checkpoint.
    laneDepsTestHooks.afterEnqueue = async () => {
      throw new Error('stopped after the delivery')
    }
    await expect(checkLaneStarts(w)).rejects.toThrow(/stopped after the delivery/)
    expect(await wakes('b5')).toHaveLength(1)
    expect(await episode(lane)).toMatchObject({ state: 'pending' })
    laneDepsTestHooks.afterEnqueue = null
    // Received and acked by its builder; its callback's checkpoint lost (put back to pending), and its row pruned.
    const [d] = await wakes('b5')
    await deliveries.readInbox(p, 'b5')
    await deliveries.ackDeliveries(p, 'b5', [d.id])
    await lanes.mutateLanes(w, (ls) => {
      const l = ls.find((x) => x.id === lane)!
      l.depEpisode = { ...l.depEpisode!, state: 'pending' }
    })
    const { workspaceDb } = await import('../src/main/boardStore')
    workspaceDb(wsPath).writer.prepare('DELETE FROM deliveries WHERE id = ?').run(d.id)
    await deliveries.forgetDeliveriesForTests()
    expect(await wakes('b5')).toEqual([])
    // The receipt says it was made: no second, and the episode is checkpointed.
    await checkLaneStarts(w)
    expect(await wakes('b5')).toEqual([])
    expect(await episode(lane)).toMatchObject({ state: 'sent' })
  })

  it('two makings at once of one episode\'s wake: one delivery, one receipt; the other says it was made', async () => {
    const nd = { agentId: 'b6', kind: 'card-event' as const, from: { kind: 'combwork' as const, name: 'Combwork' }, body: 'once', source: 'test-once', ref: 'r', once: 'test-once:lane#1#e1' }
    const [a, b] = await Promise.all([deliveries.createDeliveryOnce(p, nd), deliveries.createDeliveryOnce(p, nd)])
    expect([a.made, b.made].filter(Boolean)).toHaveLength(1)
    expect((await deliveries.deliveriesOf(p, 'b6')).filter((x) => x.source === 'test-once')).toHaveLength(1)
    expect(await deliveries.deliveryReceiptForTests(p, nd.once)).toBe(true)
    // Ended and gone since: still once.
    const made = (a.made ? a : b).record!
    await deliveries.cancelDeliveries(p, 'b6', 'test', undefined, (r) => r.id === made.id)
    expect((await deliveries.createDeliveryOnce(p, nd)).made).toBe(false)
  })

  it('a queued wake no longer due is cancelled by its refresh: a dependency reopened, the card started, the lane ended, the rules turned on', async () => {
    await advanced.set(ENFORCE, false)
    const { lane, next, deps } = await hb6('b7')
    await checkLaneStarts(w)
    for (const d of deps) await move(d, 'done')
    await checkLaneStarts(w)
    const [d] = await wakes('b7')
    expect(await laneDepsRefreshForTests(d, p)).toBeNull()
    await move(deps[0], 'todo')
    await checkLaneStarts(w)
    expect(await laneDepsRefreshForTests(d, p)).toMatchObject({ cancel: expect.stringMatching(/dependency wait changed|open again/) })
    await move(deps[0], 'done')
    await checkLaneStarts(w)
    const [, again] = await wakes('b7')
    expect(await laneDepsRefreshForTests(again, p)).toBeNull()
    await advanced.set(ENFORCE, true)
    expect(await laneDepsRefreshForTests(again, p)).toMatchObject({ cancel: /Combwork starts/ })
    await advanced.set(ENFORCE, false)
    await move(next, 'done')
    expect(await laneDepsRefreshForTests(again, p)).toMatchObject({ cancel: expect.any(String) })
    await lanes.endLane(w, lane, { abandoned: true })
    expect(await laneDepsRefreshForTests(again, p)).toMatchObject({ cancel: /no longer running/ })
  })

  it('a look held while the same service closes and reopens the same workspace writes no cursor and publishes nothing into the new open', async () => {
    await advanced.set(ENFORCE, false)
    const { lane } = await hb6('b8')
    let release!: () => void
    let held!: () => void
    const reached = new Promise<void>((r) => (held = r))
    laneStartsTestHooks.midPass = () => {
      held()
      return new Promise<void>((r) => (release = r))
    }
    const pass = checkLaneStarts(w)
    await reached
    laneStartsTestHooks.midPass = null
    await w.close()
    await w.open(wsPath)
    release()
    await pass.catch(() => undefined)
    expect(await episode(lane)).toBeUndefined()
    expect((await lanes.getLane(w, lane)).status?.why).toBe('dependencies')
    // The new open's own look does its work.
    await checkLaneStarts(w)
    expect(await episode(lane)).toMatchObject({ state: 'waiting' })
  })
})
