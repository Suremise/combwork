// Hive owns the lane (#1270, SPEC §16.11): a list change made while a card is in flight is queued and applied at the
// next card boundary (the builder told, none dropped: S3); a lane's cards start under the ruleset it started with (S19);
// one card at a time (a lane's card starts only once the ones before it are Done: S43's P4 form); a lane ends by itself
// once its cards are Done, its merge commit from their facts (an agent's ignored) and a verified lane-end event fired
// once; why a lane waits, as data; cw_lane next. With workflow rules off, a lane is bookkeeping, as before 1.0.
import { AsyncLocalStorage } from 'async_hooks'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { HiveEvent, LaneCard } from '../src/shared/types'
import { laneNextText, laneStatus, laneStatusText, type LaneCardFacts } from '../src/shared/lanes'
import { laneHits, type LaneNow } from '../src/shared/laneWatch'
import { tempDir } from './tempDir'

/** The bound for a hung run: the lanes are read again within it after each change. */
const HUNG_MS = 15_000

const base = tempDir('hive-lane-ownership-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const store = await import('../src/main/boardStore')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE, workflowFor } = await import('../src/main/workflow/service')
const { FactStore } = await import('../src/main/workflow/factStore')
const { onHiveEvent } = await import('../src/main/events')
const { deliveriesOf } = await import('../src/main/deliveries')
const { agentActor } = await import('../src/shared/workflow/facts')
const tables = await import('../src/main/storeTables')

vi.setConfig({ testTimeout: 60_000 })

afterEach(async () => {
  await advanced.set(ENFORCE, true)
})

// --- Why a lane waits, as data (pure).

const lc = (number: number, column: LaneCard['column'], over: Partial<LaneCard> = {}): LaneCard => ({ number, title: `Card ${number}`, column, blocked: null, round: 1, reviewing: false, ...over })
const ff = (over: Partial<LaneCardFacts> = {}): LaneCardFacts => ({ stage: 'active', forYou: false, stale: false, rounds: 0, ...over })

describe('why a lane waits (laneStatus)', () => {
  const rec = { rounds: 3 }
  it('says each reason, most pressing first, on the card it is about', () => {
    expect(laneStatus(rec, [lc(1, 'doing', { blocked: 'A question' }), lc(2, 'todo')], 1, true, null)).toEqual({ reason: 'blocked', card: 1, blocked: 'A question' })
    expect(laneStatus(rec, [lc(1, 'hold'), lc(2, 'todo')], 1, true, null)).toEqual({ reason: 'hold', card: 1 })
    expect(laneStatus(rec, [lc(1, 'review'), lc(2, 'todo')], 1, false, new Map([[1, ff({ stage: 'review', forYou: true })]]))).toEqual({ reason: 'you', card: 1 })
    expect(laneStatus(rec, [lc(1, 'doing', { roundLimit: true }), lc(2, 'todo')], 1, true, new Map([[1, ff({ rounds: 3 })]]))).toEqual({ reason: 'roundLimit', card: 1 })
    expect(laneStatus(rec, [lc(1, 'passed'), lc(2, 'todo')], null, false, new Map([[1, ff({ stage: 'approved' })]]))).toEqual({ reason: 'notMerged', card: 1 })
    expect(laneStatus(rec, [lc(1, 'passed'), lc(2, 'todo')], null, false, new Map([[1, ff({ stage: 'merging' })]]))).toEqual({ reason: 'merging', card: 1 })
    expect(laneStatus(rec, [lc(1, 'review', { reviewing: true }), lc(2, 'todo')], 1, false, new Map([[1, ff({ stage: 'review', stale: true })]]))).toEqual({ reason: 'stale', card: 1 })
    expect(laneStatus(rec, [lc(1, 'review'), lc(2, 'todo')], 1, false, new Map([[1, ff({ stage: 'review' })]]))).toEqual({ reason: 'reviewer', card: 1 })
    // A pool lane's design nobody has taken yet (HI-2310).
    expect(laneStatus(rec, [lc(1, 'doing'), lc(2, 'todo')], 1, false, new Map([[1, ff({ designWaits: true })]]))).toEqual({ reason: 'reviewer', card: 1 })
    expect(laneStatus({ rounds: 3, pending: [1, 2, 3] }, [lc(1, 'doing'), lc(2, 'todo')], 1, false, new Map([[1, ff()]]))).toEqual({ reason: 'listChanges', card: 1 })
    expect(laneStatus(rec, [lc(1, 'doing'), lc(2, 'todo')], 1, false, new Map([[1, ff()]]))).toBeNull()
    expect(laneStatus(rec, [lc(1, 'done'), lc(2, 'gone')], null, false, new Map())).toBeNull()
  })

  it("a Done card's slot kept on its line by uncommitted changes holds the next card: the user is asked (HI-2014)", () => {
    expect(laneStatus(rec, [lc(1, 'done'), lc(2, 'todo')], null, false, new Map([[1, ff({ stage: 'done', slotDirty: true })]]))).toEqual({ reason: 'you', card: 1, ask: 'decide' })
    // Once clean (the question closed), the lane goes on.
    expect(laneStatus(rec, [lc(1, 'done'), lc(2, 'todo')], null, false, new Map([[1, ff({ stage: 'done' })]]))).toBeNull()
  })

  it('with rules off (no facts) says only a blocked or held card, as before 1.0', () => {
    expect(laneStatus(rec, [lc(1, 'passed'), lc(2, 'todo')], null, false, null)).toBeNull()
    expect(laneStatus(rec, [lc(1, 'review'), lc(2, 'todo')], 1, false, null)).toBeNull()
    expect(laneStatus(rec, [lc(1, 'doing', { blocked: 'Why' })], 1, true, null)).toEqual({ reason: 'blocked', card: 1, blocked: 'Why' })
  })

  it('reads in English for the hive tools', () => {
    expect(laneStatusText({ reason: 'notMerged', card: 11 })).toBe('waiting: #11 not merged')
    expect(laneStatusText({ reason: 'listChanges', card: 12 })).toBe('list changes after #12')
  })

  it('a lane paused for a merge is a lane event of its own; one paused for a block is told as the block', () => {
    const now = (status: LaneNow['status']): LaneNow => ({ id: 'l', label: 'B1 / R1', mark: { state: 'paused', mergeDue: false, cards: { 1: { c: 'passed', b: false, s: false, f: '', p: '' } } }, cards: [{ number: 1, blocked: null, stalled: null, failedBy: null, passedBy: null }], status })
    const before = { state: 'active' as const, mergeDue: false, cards: { 1: { c: 'passed' as const, b: false, s: false, f: '', p: '' } } }
    expect(laneHits(before, now({ reason: 'notMerged', card: 1 }), ['paused-merge'])?.parts).toEqual([{ n: 1, event: 'paused-merge', text: 'paused for a merge: waiting: #1 not merged', detail: 'notMerged' }])
    expect(laneHits(before, now({ reason: 'blocked', card: 1 }), ['paused-merge'])).toBeNull()
  })
})

// --- The service.

describe('Hive owns the lane (lanes.ts, #1270)', () => {
  type WS = ReturnType<typeof createWorkspaceService>
  let w: WS
  const wsPath = join(base, 'ws')
  const project = join(wsPath, 'alpha')
  const ended: HiveEvent[] = []
  let off: () => void
  const user = { kind: 'user' } as const
  beforeAll(async () => {
    mkdirSync(join(project, '.hive'), { recursive: true })
    writeFileSync(join(project, 'a.txt'), 'a\n')
    writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2' }, { id: 'r1', name: 'R1' }] }))
    // Another project, for a card moved there and back (HI-1821).
    mkdirSync(join(wsPath, 'beta', '.hive'), { recursive: true })
    writeFileSync(join(wsPath, 'beta', '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'c1', name: 'C1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    lanes.startLanes()
    off = onHiveEvent((e) => e.type === 'lane-ended' && ended.push(e))
  })
  afterAll(async () => {
    off()
    await disposeWorkspaceService(w)
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = async (title: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha' }, user))).number
  const move = (n: number, column: 'todo' | 'doing' | 'review' | 'passed' | 'done') => run(() => tasks.updateTask(n, { column, ...(column === 'doing' ? { agent: 'b1' } : {}) }, user))
  const lane = (id: string) => lanes.getLane(w, id)
  const facts = () => FactStore.forBoard(w, { project: 'alpha', key: 'alpha' })

  it('S3: a card added while one is in flight is queued, applied once that card is Done, the builder told; none dropped', async () => {
    const [a, b] = [await make('S3 a'), await make('S3 b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })).lane
    await move(a, 'doing')
    const asked = Date.now()
    const r = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a, b], by: 'B1 (alpha)' })
    expect(r.did).toBe('updated')
    expect(r.note).toMatch(new RegExp(`queued: it applies once #${a} is Done`))
    expect(r.lane.cards.map((c) => c.number)).toEqual([a])
    expect(r.lane.queued).toEqual([a, b])
    expect(r.lane.status).toEqual({ reason: 'listChanges', card: a, since: expect.any(Number) })
    // HI-1926: since is when the wait began, the list change.
    expect(r.lane.status!.since).toBeGreaterThanOrEqual(asked)
    expect(r.lane.status!.since).toBeLessThanOrEqual(Date.now())
    // The runtime reads a queued card as the lane's already (its ruleset).
    expect(facts().card(b).lane).toBe(l.id)
    await move(a, 'done')
    await vi.waitFor(async () => expect((await lane(l.id)).cards.map((c) => c.number)).toEqual([a, b]), { timeout: HUNG_MS })
    expect((await lane(l.id)).queued).toBeNull()
    await vi.waitFor(async () => expect((await deliveriesOf(project, 'b1')).some((d) => d.kind === 'rebrief' && /card list changed, as queued/.test(d.body))).toBe(true), { timeout: HUNG_MS })
  })

  it('HI-2167: a new card placed on its builder’s lane: refused with none when one is needed, else started; last or next, queued while a card is in flight, from the queued list', async () => {
    const [p1, p2, p3, p4, p5] = [await make('Place 1'), await make('Place 2'), await make('Place 3'), await make('Place 4'), await make('Place 5')]
    const nums = (r: { lane: { cards: { number: number }[] } }) => r.lane.cards.map((c) => c.number)
    // cw_create_task's lane: "B2" with no running lane: refused, no lane started.
    await expect(lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [], place: { card: p1, needsLane: true }, by: 'B2 (alpha)' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/B2 has no running lane in alpha: the card was made but not placed/) })
    expect((await lanes.listLanes(w)).some((l) => l.builder.id === 'b2')).toBe(false)
    // { builder, reviewer }: starts one with the card alone (its `cards` ignored).
    const started = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [p5], place: { card: p1 }, by: 'B2 (alpha)' })
    expect([started.did, nums(started), started.lane.reviewer?.id]).toEqual(['started', [p1], 'r1'])
    // Between cards: last, then next (before the first card still in Todo), at once.
    expect(nums(await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [], place: { card: p2, needsLane: true }, by: 'B2 (alpha)' }))).toEqual([p1, p2])
    const next = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [], place: { card: p3, position: 'next', needsLane: true }, by: 'B2 (alpha)' })
    expect([next.did, next.lane.id, nums(next), next.lane.queued]).toEqual(['updated', started.lane.id, [p3, p1, p2], null])
    // A card in flight: the placement is queued as cw_lane start's list change is, the reviewer kept.
    await run(() => tasks.updateTask(p3, { column: 'doing', agent: 'b2' }, user))
    const queued = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [], place: { card: p4, needsLane: true }, by: 'B2 (alpha)' })
    expect([nums(queued), queued.lane.queued, queued.lane.reviewer?.id]).toEqual([[p3, p1, p2], [p3, p1, p2, p4], 'r1'])
    expect(queued.note).toMatch(new RegExp(`queued: it applies once #${p3} is Done`))
    // Placed again meanwhile: on the queued list, so the queued card stays; next goes after the card in flight.
    const again = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [], place: { card: p5, position: 'next', needsLane: true }, by: 'B2 (alpha)' })
    expect(again.lane.queued).toEqual([p3, p5, p1, p2, p4])
    await lanes.endLane(w, started.lane.id, { abandoned: true })
  })

  it("HI-2167: cw_lane start's safety net names a card made by someone else since the caller's turn began, moments ago; never the caller's own, one from before its turn, an older one, or with no turn", async () => {
    const c = await make('Fresh card')
    const made = Date.parse((await run(() => tasks.getTask(c))).createdAt!)
    const by = tasks.actorName(user)
    const turn = made - 1000
    expect(await lanes.freshCardsNote(w, [c], 'HB6', turn, 'alpha', made + 3000)).toMatch(new RegExp(`^Warning: #${c} was created 3 s ago by ${by}: is it the card you meant\\? To put a new card on a lane, create it with cw_create_task's lane`))
    expect(await lanes.freshCardsNote(w, [c], by, turn, 'alpha', made + 3000)).toBeNull()
    // Made before the caller's turn began: a card it was told of (the user's, asking it to put it on a lane).
    expect(await lanes.freshCardsNote(w, [c], 'HB6', made + 1, 'alpha', made + 3000)).toBeNull()
    expect(await lanes.freshCardsNote(w, [c], 'HB6', turn, 'alpha', made + lanes.FRESH_CARD_MS)).toBeNull()
    expect(await lanes.freshCardsNote(w, [c], 'HB6', null, 'alpha', made + 3000)).toBeNull()
  })

  it("HI-2167 (HR3's round 1): the safety net reads only cards in the caller's scope; one outside it is told as one that doesn't exist", async () => {
    const other = (await run(() => tasks.createTask({ title: 'Beta fresh', project: 'beta' }, user))).number
    const loose = (await run(() => tasks.createTask({ title: 'Workspace fresh' }, user))).number
    const moved = await make('Moved fresh')
    await run(() => tasks.updateTask(moved, { project: 'beta' }, user))
    const at = Date.now() + 1000
    const turn = at - 60_000
    // An alpha agent: beta's card, a workspace card and one moved out of alpha say no more than a card that doesn't exist.
    for (const n of [other, loose, moved, 999_999]) expect(await lanes.freshCardsNote(w, [n], 'HB6', turn, 'alpha', at), `#${n}`).toBeNull()
    // The Assistant and scripts (no scope): the workspace's cards.
    expect(await lanes.freshCardsNote(w, [other], 'HB6', turn, null, at)).toMatch(/^Warning: .+ was created \d+ s ago by /)
  })

  it("HI-2169: a builder's own start with its first card alone keeps the Assistant's second (set with applyNow): the first goes Done, the lane goes on to the second", async () => {
    const [a, b] = [await make('Own a'), await make('Own b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [a], by: 'Assistant' })).lane
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [a, b], applyNow: true, by: 'Assistant' })).lane.cards.map((c) => c.number)).toEqual([a, b])
    // HB6's card-loop registration, naming only the card its start prompt gave it.
    const own = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [a], ownBuilder: true, by: 'B2 (alpha)' })
    expect([own.lane.id, own.lane.cards.map((c) => c.number)]).toEqual([l.id, [a, b]])
    expect(own.note).toMatch(new RegExp(`#${b} stays on the lane, after the cards you listed: a builder's own cw_lane start adds or reorders cards, never takes one off`))
    // It still reorders and adds.
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [b, a], ownBuilder: true, by: 'B2 (alpha)' })).lane.cards.map((c) => c.number)).toEqual([b, a])
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [a, b], by: 'Assistant' })
    await run(() => tasks.updateTask(a, { column: 'doing', agent: 'b2' }, user))
    await run(() => tasks.updateTask(a, { column: 'done' }, user))
    await vi.waitFor(async () => expect((await lanes.laneNext(w, 'alpha', 'b2')).next?.card).toBe(b), { timeout: HUNG_MS })
    expect((await lane(l.id)).state).not.toBe('ended')
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it("HI-2169: a builder's re-registration with its card in flight keeps the queued list, which applies once that card is Done", async () => {
    const [a, b] = [await make('Queue a'), await make('Queue b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [a], by: 'Assistant' })).lane
    await run(() => tasks.updateTask(a, { column: 'doing', agent: 'b2' }, user))
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [a, b], by: 'Assistant' })).lane.queued).toEqual([a, b])
    const own = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [a], ownBuilder: true, by: 'B2 (alpha)' })
    expect([own.lane.cards.map((c) => c.number), own.lane.queued]).toEqual([[a], [a, b]])
    await run(() => tasks.updateTask(a, { column: 'done' }, user))
    await vi.waitFor(async () => expect((await lane(l.id)).cards.map((c) => c.number)).toEqual([a, b]), { timeout: HUNG_MS })
    await vi.waitFor(async () => expect((await lanes.laneNext(w, 'alpha', 'b2')).next?.card).toBe(b), { timeout: HUNG_MS })
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it("HI-2169: the Assistant's, the user's or a script's start still takes a card off; with rules off, the builder's own does too", async () => {
    const [a, b] = [await make('Off a'), await make('Off b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [a, b], by: 'Assistant' })).lane
    const takenOff = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [a], by: 'Assistant' })
    expect([takenOff.lane.cards.map((c) => c.number), takenOff.note]).toEqual([[a], undefined])
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [a, b], by: 'Assistant' })
    await advanced.set(ENFORCE, false)
    const unruled = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [a], ownBuilder: true, by: 'B2 (alpha)' })
    expect(unruled.lane.cards.map((c) => c.number)).toEqual([a])
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it('between cards a change applies at once; with rules off, at once even mid-card', async () => {
    const [a, b, c] = [await make('Now a'), await make('Now b'), await make('Now c')]
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })
    const now = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a, b], by: 'B1 (alpha)' })
    expect([now.lane.cards.map((x) => x.number), now.lane.queued, now.note]).toEqual([[a, b], null, undefined])
    await move(a, 'doing')
    await advanced.set(ENFORCE, false)
    const unruled = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a, b, c], by: 'B1 (alpha)' })
    expect([unruled.lane.cards.map((x) => x.number), unruled.lane.queued]).toEqual([[a, b, c], null])
    await lanes.endLane(w, unruled.lane.id, { abandoned: true })
  })

  it("S19: a lane's cards start under the ruleset it started with; a card outside it under the current one; none kept with rules off", async () => {
    const [a, b, loose] = [await make('S19 a'), await make('S19 b'), await make('S19 loose')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a, b], by: 'B1 (alpha)' })).lane
    const kept = facts().lane(l.id)!.ruleset
    expect(kept).toBeTruthy()
    // The options change after the lane started.
    await w.mutateProjectConfig(project, () => ({ workflow: { platform: 'none', preset: null, options: { review: 'agent', noSelfReview: true } } }))
    await move(a, 'doing')
    await move(loose, 'doing')
    const startedUnder = (n: number) => facts().facts(n).find((f) => f.kind === 'Started')?.ruleset
    await vi.waitFor(() => expect(startedUnder(a)).toBe(kept), { timeout: HUNG_MS })
    const now = (await workflowFor(w, project))!.currentRuleset(false).id
    await vi.waitFor(() => expect(startedUnder(loose)).toBe(now), { timeout: HUNG_MS })
    expect(now).not.toBe(kept)
    await advanced.set(ENFORCE, false)
    const plain = (await lanes.startLane(w, { project: 'alpha', builder: 'r1', cards: [await make('S19 off')], by: 'R1 (alpha)' })).lane
    expect(facts().lane(plain.id)!.ruleset).toBeNull()
    for (const x of [l, plain]) await lanes.endLane(w, x.id, { abandoned: true })
    await w.mutateProjectConfig(project, () => ({ workflow: undefined }))
  })

  it("S43 (P4): one card at a time: the lane's next card can't start before the one before it is Done; then it can", async () => {
    const [a, b] = [await make('One a'), await make('One b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a, b], by: 'B1 (alpha)' })).lane
    const wf = (await workflowFor(w, project))!
    const refused = await store.boardWrite(w, async () => wf.start(`#${b}`, agentActor('b1')))
    expect(refused).toMatchObject({ refused: true, rule: 'lane.oneAtATime' })
    // The runtime names cards by the project's name until #1294 gives it keys.
    expect((refused as { message: string }).message).toBe(`alpha-${b} can't start yet: alpha-${a}, before it in its lane, isn't Done.`)
    await move(a, 'doing')
    await move(a, 'done')
    expect(await store.boardWrite(w, async () => wf.start(`#${b}`, agentActor('b1')))).toMatchObject({ ok: true })
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it("why a lane waits comes with it: a card passed but not merged pauses it; cw_lane next names the card or the wait", async () => {
    const [a, b] = [await make('Wait a'), await make('Wait b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })).lane
    const first = await lanes.laneNext(w, 'alpha', 'b1')
    expect(laneNextText({ ...first, lane: { ...first.lane, cards: first.lane.cards } })).toBe(`Next: #${a} Wait a. Start it.`)
    await move(a, 'doing')
    expect(laneNextText(await lanes.laneNext(w, 'alpha', 'b1'))).toBe(`Carry on with #${a} Wait a.`)
    const passed = Date.now()
    await move(a, 'passed')
    const paused = await lane(l.id)
    expect([paused.state, paused.status, paused.pausedOn]).toEqual(['paused', { reason: 'notMerged', card: a, since: expect.any(Number) }, a])
    // HI-1926: since is when the wait began, the pass.
    expect(paused.status!.since).toBeGreaterThanOrEqual(passed)
    expect(paused.status!.since).toBeLessThanOrEqual(Date.now())
    expect(laneNextText(await lanes.laneNext(w, 'alpha', 'b1'))).toBe(`The lane waits: waiting: #${a} not merged. Start nothing new meanwhile.`)
    await advanced.set(ENFORCE, false)
    expect((await lane(l.id)).status).toBeNull()
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it("a lane ends by itself once its cards are Done, its merge commit their facts', the event once; an agent ends it only then, and never abandons it", async () => {
    const [a, b] = [await make('End a'), await make('End b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })).lane
    await expect(lanes.endLane(w, l.id, { project: 'alpha', agent: 'b1' })).rejects.toThrow(/ends by itself once all its cards are Done/)
    await expect(lanes.endLane(w, l.id, { project: 'alpha', agent: 'b1', abandoned: true })).rejects.toThrow(/Only the user or the Assistant abandons/)
    const before = ended.length
    await move(a, 'doing')
    await move(a, 'done')
    // b's work is in once started: an Integrated fact names its result revision (a has none, as under Not checked).
    await move(b, 'doing')
    await store.boardWrite(w, async () => facts().tx((tx) => tx.append(b, { kind: 'Integrated', actor: 'outside', source: 'observed', data: { revision: 'rev-b', target: 'main', result: 'merged-b', method: 'merge', by: 'agent' } })))
    await move(b, 'done')
    await vi.waitFor(async () => expect((await lane(l.id)).state).toBe('ended'), { timeout: HUNG_MS })
    expect((await lane(l.id)).mergeCommit).toBe('merged-b')
    await vi.waitFor(() => expect(ended.length).toBe(before + 1), { timeout: HUNG_MS })
    expect(ended[before]).toMatchObject({ type: 'lane-ended', lane: l.id, project: 'alpha', results: [{ card: a, revision: null }, { card: b, revision: 'merged-b' }] })
    // An agent's merge commit afterwards changes nothing; nor is the event fired again.
    const again = await lanes.endLane(w, l.id, { project: 'alpha', agent: 'b1', mergeCommit: 'abc1234' })
    expect(again.mergeCommit).toBe('merged-b')
    await lanes.refresh(w)
    expect(ended.length).toBe(before + 1)
  })

  it('a list sharing no card, mid-card, edits the running lane: queued, never a new lane abandoning it (HR6 round 1, finding 1)', async () => {
    const [a, b] = [await make('Disjoint a'), await make('Disjoint b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    await move(a, 'doing')
    const r = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [b], by: 'B1 (alpha)' })
    expect([r.did, r.lane.id, r.lane.state, r.lane.queued, r.replaced ?? null]).toEqual(['updated', l.id, 'active', [b], null])
    // The card in flight stays the lane's until it is Done; then the list without it applies.
    expect(r.lane.cards.map((c) => c.number)).toEqual([a])
    await move(a, 'done')
    await vi.waitFor(async () => expect((await lane(l.id)).cards.map((c) => c.number)).toEqual([b]), { timeout: HUNG_MS })
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it("a card queued in front can't start before the card in flight is Done (HR6 round 1, finding 2)", async () => {
    const [a, b] = [await make('Front a'), await make('Front b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    await move(a, 'doing')
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [b, a], by: 'B1 (alpha)' })).lane.queued).toEqual([b, a])
    const wf = (await workflowFor(w, project))!
    expect(await store.boardWrite(w, async () => wf.start(`#${b}`, agentActor('b1')))).toMatchObject({ refused: true, rule: 'lane.oneAtATime', values: { earlier: `alpha-${a}` } })
    await move(a, 'done')
    await vi.waitFor(async () => expect((await lane(l.id)).cards.map((c) => c.number)).toEqual([b, a]), { timeout: HUNG_MS })
    expect(await store.boardWrite(w, async () => wf.start(`#${b}`, agentActor('b1')))).toMatchObject({ ok: true })
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it('a card reopened between the read and the save: the lane goes on, no end and no event (HR6 round 1, finding 3)', async () => {
    const a = await make('Reopen a')
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    await move(a, 'doing')
    const before = ended.length
    // The refresh reads a Done; at its next wait (the project's agents' names) the card is reopened.
    const real = w.projectConfig.bind(w)
    let reopened = false
    const spy = vi.spyOn(w, 'projectConfig').mockImplementation(async (p) => {
      // Only the lanes' read of names, once it has read the card Done (its stack names it): the move's own reads pass.
      if (!reopened && (new Error().stack ?? '').includes('namesOf')) {
        reopened = true
        await move(a, 'todo')
      }
      return real(p)
    })
    try {
      await run(() => tasks.updateTask(a, { column: 'done' }, user))
      await lanes.refresh(w)
      await vi.waitFor(() => expect(reopened).toBe(true), { timeout: HUNG_MS })
      await lanes.refresh(w)
    } finally {
      spy.mockRestore()
    }
    const now = await lane(l.id)
    expect([now.state, now.cards[0].column]).toEqual(['active', 'todo'])
    expect(ended.length).toBe(before)
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it("a card started while a list change is decided: the change is queued, the card stays the lane's (HR6 round 2)", async () => {
    const [a, b] = [await make('Started a'), await make('Started b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    // The change reads A in Todo (between cards); at its names lookup A starts. Only the change's own lookup (#1414): the
    // lanes' following refreshes 300 ms after a change and looks the names up too, and a move made there under load isn't
    // one the change waits for, so the change applied B before A's start had landed.
    const real = w.projectConfig.bind(w)
    const change = new AsyncLocalStorage<true>()
    let started = false
    const spy = vi.spyOn(w, 'projectConfig').mockImplementation(async (p) => {
      if (!started && change.getStore() && (new Error().stack ?? '').includes('namesOf')) {
        started = true
        await move(a, 'doing')
      }
      return real(p)
    })
    let r: Awaited<ReturnType<typeof lanes.startLane>>
    try {
      r = await change.run(true, () => lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [b], by: 'B1 (alpha)' }))
    } finally {
      spy.mockRestore()
    }
    expect(started).toBe(true)
    expect([r.lane.id, r.lane.cards.map((c) => c.number), r.lane.cards[0].column, r.lane.queued]).toEqual([l.id, [a], 'doing', [b]])
    expect(r.note).toMatch(new RegExp(`queued: it applies once #${a} is Done`))
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  // HR6's round 3: a later queued card can't pass an earlier one at the Done boundary. A's Done and C's start in one board
  // change, so no refresh comes between them (the queue is still there, checked).
  it('at the boundary, a later queued card is refused; the earlier one starts, applying the queued list in its start (round 4)', async () => {
    const [a, b, c] = [await make('Boundary a'), await make('Boundary b'), await make('Boundary c')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    await move(a, 'doing')
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [b, c], by: 'B1 (alpha)' })).lane.queued).toEqual([b, c])
    const wf = (await workflowFor(w, project))!
    const early = await store.boardWrite(w, async () => {
      expect(await wf.move(`#${a}`, 'done', 'user', { confirm: true })).toMatchObject({ ok: true })
      expect(facts().lane(l.id)!.pending).toEqual([b, c])
      return wf.start(`#${c}`, agentActor('b1'))
    })
    expect(early).toMatchObject({ refused: true, rule: 'lane.oneAtATime', values: { earlier: `alpha-${b}` } })
    // B, first in the queued list, starts; the list applies (in its start, or the refresh's, whichever is first).
    expect(await store.boardWrite(w, async () => wf.start(`#${b}`, agentActor('b1')))).toMatchObject({ ok: true })
    expect(facts().lane(l.id)).toMatchObject({ cards: [b, c], pending: null })
    expect(await store.boardWrite(w, async () => wf.start(`#${c}`, agentActor('b1')))).toMatchObject({ refused: true, values: { earlier: `alpha-${b}` } })
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it('the same from the stored state: the queue and the Done written in the start’s own board change, the list applied before the check (round 4)', async () => {
    const [a, b, c] = [await make('Stored a'), await make('Stored b'), await make('Stored c')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    await move(a, 'doing')
    const wf = (await workflowFor(w, project))!
    const out = await store.boardWrite(w, async () => {
      // A Done and [B, C] queued, as stored, with nothing applied yet.
      facts().tx((tx) => {
        tx.append(a, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'active', to: 'done', cause: 'user' } })
        tx.setStage(a, 'done')
      })
      facts().saveLane({ ...facts().lane(l.id)!, pending: [b, c] })
      const refused = await wf.start(`#${c}`, agentActor('b1'))
      const started = await wf.start(`#${b}`, agentActor('b1'))
      return { refused, started, lane: facts().lane(l.id) }
    })
    expect(out.refused).toMatchObject({ refused: true, rule: 'lane.oneAtATime', values: { earlier: `alpha-${b}` } })
    expect(out.started).toMatchObject({ ok: true })
    expect(out.lane).toMatchObject({ cards: [b, c], pending: null })
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  /** A card Done as stored (its facts and stage), with no board event: nothing reads the lanes again meanwhile. */
  const doneAsStored = (n: number) => store.boardWrite(w, async () => facts().tx((tx) => {
    tx.append(n, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'active', to: 'done', cause: 'user' } })
    tx.setStage(n, 'done')
  }))
  /** How often a lane's builder was told its queued list applied: the runtime's wakes and lanes.ts's rebriefs. */
  const announced = async (cards: number[]): Promise<number> => {
    const db = store.workspaceDb(wsPath).reader
    const wakes = (db.prepare("SELECT payload FROM card_actions WHERE kind = 'wake'").all() as { payload: string }[]).filter((r) => r.payload.includes('card list changed') && r.payload.includes(`now ${cards.map((c) => `alpha-${c}`).join(', ')}.`)).length
    const keys = cards.map((c) => `#${c}`)
    const rebriefs = (await deliveriesOf(project, 'b1')).filter((d) => d.kind === 'rebrief' && /card list changed/.test(d.body) && keys.every((k) => d.body.includes(k))).length
    return wakes + rebriefs
  }

  it('a lanes.ts save read before the runtime applied a queued list is read again, never saved over it (HR6, round 4)', async () => {
    const [a, b, c] = [await make('Race a'), await make('Race b'), await make('Race c')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    await move(a, 'doing')
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [b, c], by: 'B1 (alpha)' })).lane.queued).toEqual([b, c])
    await doneAsStored(a)
    const wf = (await workflowFor(w, project))!
    // The reviewer's join reads the lane (queued [B, C]); before it saves, B starts, which applies the queue.
    let started: unknown = null
    tables.tableTestHooks.beforeSave = async (s) => {
      if (s !== 'lanes' || started) return
      started = await store.boardWrite(w, async () => wf.start(`#${b}`, agentActor('b1')))
    }
    try {
      await lanes.joinLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', by: 'R1 (alpha)' })
    } finally {
      tables.tableTestHooks.beforeSave = null
    }
    expect(started).toMatchObject({ ok: true })
    // The join was decided again on the lane as the start left it: no queue back, the list not put back, joined.
    expect(facts().lane(l.id)).toMatchObject({ cards: [b, c], pending: null })
    expect(await lane(l.id)).toMatchObject({ state: 'active', reviewer: { id: 'r1' }, queued: null })
    expect(facts().card(b).stage).toBe('active')
    expect(await announced([b, c])).toBe(1)
    // Following the board after it applies nothing again, tells nothing again, and doesn't end the lane.
    await lanes.refresh(w)
    expect(await announced([b, c])).toBe(1)
    expect(await lane(l.id)).toMatchObject({ state: 'active', queued: null })
    expect(ended.some((e) => e.type === 'lane-ended' && e.lane === l.id)).toBe(false)
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it('a queued list that takes the card out, applied in its start: the card starts again as a card outside the lane, under the current ruleset (HR6, round 4)', async () => {
    const [a, b, c] = [await make('Out a'), await make('Out b'), await make('Out c')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a, b], by: 'B1 (alpha)' })).lane
    const kept = facts().lane(l.id)!.ruleset
    await w.mutateProjectConfig(project, () => ({ workflow: { platform: 'none', preset: null, options: { review: 'agent', noSelfReview: true } } }))
    try {
      await move(a, 'doing')
      // B taken out, C added, queued while A is in flight; A then Done, as stored.
      expect((await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a, c], by: 'B1 (alpha)' })).lane.queued).toEqual([a, c])
      await doneAsStored(a)
      const wf = (await workflowFor(w, project))!
      expect(facts().card(b).lane).toBe(l.id)
      expect(await store.boardWrite(w, async () => wf.start(`#${b}`, agentActor('b1')))).toMatchObject({ ok: true })
      expect(facts().lane(l.id)).toMatchObject({ cards: [a, c], pending: null })
      expect(facts().card(b).lane ?? null).toBeNull()
      const now = wf.currentRuleset(false).id
      expect(now).not.toBe(kept)
      expect(facts().facts(b).find((f) => f.kind === 'Started')?.ruleset).toBe(now)
      expect(await announced([a, c])).toBe(1)
    } finally {
      await lanes.endLane(w, l.id, { abandoned: true })
      await w.mutateProjectConfig(project, () => ({ workflow: undefined }))
    }
  })

  it('a reorder while a start gathers: the start is checked against the lane as it is where it is written (HR6, round 4)', async () => {
    const [a, b, c] = [await make('Reorder a'), await make('Reorder b'), await make('Reorder c')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    await move(a, 'doing')
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [b, c], by: 'B1 (alpha)' })).lane.queued).toEqual([b, c])
    await doneAsStored(a)
    const wf = (await workflowFor(w, project))!
    const hooks = wf.cfg.hooks
    let reordered = false
    // B's start gathers with [B, C] queued; before it writes, the lane becomes [C, B] (as a reorder between cards saves
    // it: the lane's own tables, written here, inside the start's board change, where lanes.ts can't save).
    wf.cfg.hooks = { beforeWrite: async (m) => {
      if (m !== 'start' || reordered) return
      reordered = true
      facts().saveLane({ ...facts().lane(l.id)!, cards: [c, b], pending: null })
    } }
    try {
      expect(await store.boardWrite(w, async () => wf.start(`#${b}`, agentActor('b1')))).toMatchObject({ refused: true, rule: 'lane.oneAtATime', values: { earlier: `alpha-${c}` } })
    } finally {
      wf.cfg.hooks = hooks
    }
    expect(reordered).toBe(true)
    expect(facts().lane(l.id)).toMatchObject({ cards: [c, b], pending: null })
    expect(await store.boardWrite(w, async () => wf.start(`#${c}`, agentActor('b1')))).toMatchObject({ ok: true })
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  it("with rules off an agent ends a lane as before: its merge commit as given, unverified", async () => {
    await advanced.set(ENFORCE, false)
    const a = await make('Off a')
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    const done = await lanes.endLane(w, l.id, { project: 'alpha', agent: 'b1', mergeCommit: 'abc1234' })
    expect([done.state, done.mergeCommit]).toEqual(['ended', 'abc1234'])
  })

  // HI-1821: cards moved from B1's lane to B2's. B2's start listing cards B1's lane still has warns, B1's change leaves
  // them at once (its own card in flight kept), and B1's lane goes on to its own next card.
  it("a card moved from lane A to lane B: B's start warns while A lists it, A's change applies at once, A goes on to its own card (HI-1821)", async () => {
    const [a1, x, y, a2, a3] = [await make('Moved a1'), await make('Moved x'), await make('Moved y'), await make('Moved a2'), await make('Moved a3')]
    const la = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a1, x, y, a2], by: 'Assistant' })).lane
    await move(a1, 'doing')
    const lb = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [x, y], by: 'Assistant' }))
    expect(lb.note).toMatch(new RegExp(`^Warning: #${x} is also in B1's lane \\(${la.id}\\); #${y} is also in B1's lane`))
    expect(facts().card(x).lane).toBe(lb.lane.id)
    // Only cards taken out, A1 in flight kept: at once, not queued after A1.
    const r = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a1, a2], by: 'Assistant' })
    expect([r.lane.id, r.lane.cards.map((c) => c.number), r.lane.queued, r.note]).toEqual([la.id, [a1, a2], null, undefined])
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [x, y], by: 'Assistant' })).note).toBeUndefined()
    // A change that adds a card while A1 is in flight still waits for A1 (#1270), never for B2's cards.
    await run(() => tasks.updateTask(x, { column: 'doing', agent: 'b2' }, user))
    const added = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a1, a2, a3], by: 'Assistant' })
    expect(added.note).toMatch(new RegExp(`queued: it applies once #${a1} is Done`))
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a1, a2], by: 'Assistant' })
    await move(a1, 'done')
    const wf = (await workflowFor(w, project))!
    expect(await store.boardWrite(w, async () => wf.start(`#${a2}`, agentActor('b1')))).toMatchObject({ ok: true })
    await vi.waitFor(async () => expect((await lanes.laneNext(w, 'alpha', 'b1')).next).toMatchObject({ card: a2, carryOn: true }), { timeout: HUNG_MS })
    for (const l of [la, lb.lane]) await lanes.endLane(w, l.id, { abandoned: true })
  })

  // HI-1821, as it was seen: a lane listing a card another agent has (from before one lane a card) takes, waits on and keys
  // its queued change to none of it.
  it("a lane never takes, waits on or queues behind a card another agent has (HI-1821)", async () => {
    const [x, a1, z, a2, a3] = [await make('Held x'), await make('Held a1'), await make('Held z'), await make('Held a2'), await make('Held a3')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [x, a1, z, a2], by: 'Assistant' })).lane
    await run(() => tasks.updateTask(x, { column: 'doing', agent: 'b2' }, user))
    await run(() => tasks.updateTask(z, { column: 'review', agent: 'b2' }, user))
    const seen = await lane(l.id)
    expect([seen.cards.find((c) => c.number === x)?.elsewhere, seen.current, seen.state, seen.status]).toEqual(['b2', a1, 'active', null])
    expect((await lanes.laneNext(w, 'alpha', 'b1')).next).toMatchObject({ card: a1, carryOn: false })
    // B2's cards in flight don't hold A's list: a change between A's own cards applies at once.
    const r = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [x, a1, z, a2, a3], by: 'Assistant' })
    expect([r.lane.queued, r.note]).toEqual([null, undefined])
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [x, a1, z, a2], by: 'Assistant' })
    const wf = (await workflowFor(w, project))!
    expect(await store.boardWrite(w, async () => wf.start(`#${a1}`, agentActor('b1')))).toMatchObject({ ok: true })
    // A1 in flight: a change is queued after A1, B2's X before it in the list never.
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [x, a1, a2, z], by: 'Assistant' })).note).toMatch(new RegExp(`queued: it applies once #${a1} is Done`))
    await move(a1, 'done')
    await vi.waitFor(async () => expect((await lane(l.id)).queued).toBeNull(), { timeout: HUNG_MS })
    // Its next own card starts though B2's Z is before it in the list.
    expect(await store.boardWrite(w, async () => wf.start(`#${a2}`, agentActor('b1')))).toMatchObject({ ok: true })
    await lanes.endLane(w, l.id, { abandoned: true })
  })

  // HI-1821 as reported: HB3's lane [HI-1771, HI-1757, HI-1758, HI-1782], the middle two moved to HB6's lane.
  it("the reported sequence: the moved cards leave at once; a queued change keeps its own card as anchor through Review and Approved; then the lane's own next card (HI-1821)", async () => {
    const [own1, x1, x2, own2, extra] = [await make('Seq 1771'), await make('Seq 1757'), await make('Seq 1758'), await make('Seq 1782'), await make('Seq extra')]
    const la = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [own1, x1, x2, own2], by: 'Assistant' })).lane
    await move(own1, 'doing')
    // 04:45: the Assistant re-runs the start without them, the lane's own card in flight: at once.
    const r = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [own1, own2], by: 'Assistant' })
    expect([r.lane.cards.map((c) => c.number), r.lane.queued, r.note]).toEqual([[own1, own2], null, undefined])
    const lb = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [x1, x2], by: 'Assistant' })
    expect(lb.note).toBeUndefined()
    await run(() => tasks.updateTask(x1, { column: 'doing', agent: 'b2' }, user))
    await run(() => tasks.updateTask(x2, { agent: 'b2', blocked: 'Asked the user' }, user))
    // A change that adds a card waits for its own card, never B2's, through Review and Approved.
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [own1, own2, extra], by: 'Assistant' })).note).toMatch(new RegExp(`queued: it applies once #${own1} is Done`))
    await move(own1, 'review')
    expect([(await lane(la.id)).queued, (await lane(la.id)).status?.card]).toEqual([[own1, own2, extra], own1])
    await move(own1, 'passed')
    expect([(await lane(la.id)).queued, (await lane(la.id)).status?.card]).toEqual([[own1, own2, extra], own1])
    await move(own1, 'done')
    await vi.waitFor(async () => expect((await lane(la.id)).cards.map((c) => c.number)).toEqual([own1, own2, extra]), { timeout: HUNG_MS })
    const now = await lane(la.id)
    expect([now.queued, now.current, now.state, now.status]).toEqual([null, own2, 'active', null])
    expect((await lanes.laneNext(w, 'alpha', 'b1')).next).toMatchObject({ card: own2, carryOn: false })
    const wf = (await workflowFor(w, project))!
    expect(await store.boardWrite(w, async () => wf.start(`#${own2}`, agentActor('b1')))).toMatchObject({ ok: true })
    for (const l of [la, lb.lane]) await lanes.endLane(w, l.id, { abandoned: true })
  })

  it('a card given to no agent that two lanes list is the newer lane’s, the holder’s once given; the other lane skips it, the runtime too (HI-1821)', async () => {
    const [u, a1] = [await make('Shared u'), await make('Shared a1')]
    const la = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [u, a1], by: 'Assistant' })).lane
    const lb = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [u], by: 'Assistant' })
    expect(lb.note).toMatch(new RegExp(`^Warning: #${u} is also in B1's lane \\(${la.id}\\)`))
    const seenA = await lane(la.id)
    expect([seenA.cards.find((c) => c.number === u)?.elsewhere, seenA.current]).toEqual([lb.lane.id, a1])
    expect([(await lane(lb.lane.id)).cards[0].elsewhere, (await lane(lb.lane.id)).current]).toEqual([undefined, u])
    expect(facts().card(u).lane).toBe(lb.lane.id)
    expect((await lanes.laneNext(w, 'alpha', 'b1')).next).toMatchObject({ card: a1 })
    const wf = (await workflowFor(w, project))!
    expect(await store.boardWrite(w, async () => wf.start(`#${a1}`, agentActor('b1')))).toMatchObject({ ok: true })
    // Given to B1: B1's lane's (the holder's lane), B2's skips it.
    await run(() => tasks.updateTask(u, { agent: 'b1' }, user))
    expect(facts().card(u).lane).toBe(la.id)
    expect([(await lane(la.id)).cards[0].elsewhere, (await lane(lb.lane.id)).cards[0].elsewhere]).toEqual([undefined, 'b1'])
    for (const l of [la, lb.lane]) await lanes.endLane(w, l.id, { abandoned: true })
  })

  it('two lanes started at once with one card: the lanes’ lock orders them, the second’s reply warns from the first’s stored row, and the view and runtime name one owner (HI-1821)', async () => {
    const u = await make('Race u')
    const [r1, r2] = await Promise.all([lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [u], by: 'Assistant' }), lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [u], by: 'Assistant' })])
    const warned = [r1, r2].filter((r) => (r.note ?? '').startsWith('Warning: '))
    expect(warned).toHaveLength(1)
    const first = warned[0] === r1 ? r2 : r1
    expect(warned[0].note).toContain(`is also in ${first === r1 ? 'B1' : 'B2'}'s lane (${first.lane.id})`)
    // One owner, the same for the view and the runtime: the other lane marks the card held by it.
    const owner = facts().card(u).lane
    const other = owner === r1.lane.id ? r2.lane.id : r1.lane.id
    expect([owner === r1.lane.id || owner === r2.lane.id, (await lane(owner!)).cards[0].elsewhere, (await lane(other)).cards[0].elsewhere]).toEqual([true, undefined, owner])
    for (const r of [r1, r2]) await lanes.endLane(w, r.lane.id, { abandoned: true })
  })

  // HR4's round 1: a card moved to another project, listed by a newer lane there, and moved back (leaving its agent) is
  // its project's lane's, never the other project's, for the view, the runtime and the check under the board's lock.
  it('a card moved to another project and back is its own project’s lane’s, though a newer lane there still lists it (HI-1821)', async () => {
    const [u, a1] = [await make('Away u'), await make('Away a1')]
    const b1 = (await run(() => tasks.createTask({ title: 'Beta b1', project: 'beta' }, user))).number
    const la = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [u, a1], by: 'Assistant' })).lane
    await run(() => tasks.updateTask(u, { project: 'beta' }, user))
    const lb = (await lanes.startLane(w, { project: 'beta', builder: 'c1', cards: [u, b1], by: 'Assistant' })).lane
    await run(() => tasks.updateTask(u, { project: 'alpha' }, user))
    const seen = await lane(la.id)
    expect([seen.cards[0].elsewhere, seen.current, facts().card(u).lane]).toEqual([undefined, u, la.id])
    expect((await lanes.laneNext(w, 'alpha', 'b1')).next).toMatchObject({ card: u })
    // Under the board's lock: U started (given to no agent) while a change is decided reads as the lane's own card in
    // flight, so the change is queued after it.
    const real = w.projectConfig.bind(w)
    const change = new AsyncLocalStorage<true>()
    let started = false
    const spy = vi.spyOn(w, 'projectConfig').mockImplementation(async (p) => {
      if (!started && change.getStore() && (new Error().stack ?? '').includes('namesOf')) {
        started = true
        await run(() => tasks.updateTask(u, { column: 'doing' }, user))
      }
      return real(p)
    })
    let r: Awaited<ReturnType<typeof lanes.startLane>>
    try {
      r = await change.run(true, () => lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a1, u], by: 'Assistant' }))
    } finally {
      spy.mockRestore()
    }
    expect(started).toBe(true)
    expect([r.lane.cards.map((c) => c.number), r.lane.queued]).toEqual([[u, a1], [a1, u]])
    expect(r.note).toMatch(new RegExp(`queued: it applies once #${u} is Done`))
    for (const l of [la, lb]) await lanes.endLane(w, l.id, { abandoned: true })
  })

  // Last in this describe: it gives the projects keys, which the tests above match as #n.
  it("HI-2169 (HR3's round 1): a builder's own start names the cards it keeps as it may see them: its project's by key; another project's, a workspace card, one moved out and a missing one by number alone", async () => {
    const keys = await import('../src/main/projectKeys')
    await keys.keyProjects(w)
    const own = (await run(() => tasks.createTask({ title: 'Keyed own', project: 'alpha' }, user))).number
    const kept = (await run(() => tasks.createTask({ title: 'Keyed kept', project: 'alpha' }, user))).number
    const beta = await run(() => tasks.createTask({ title: 'Keyed beta', project: 'beta' }, user))
    const loose = (await run(() => tasks.createTask({ title: 'Keyed loose' }, user))).number
    const moved = await run(() => tasks.createTask({ title: 'Keyed moved', project: 'alpha' }, user))
    const missing = 999_999
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [own, kept, beta.number, loose, moved.number, missing], by: 'Assistant' })).lane
    await run(() => tasks.updateTask(moved.number, { project: 'beta' }, user))
    const movedKey = (await run(() => tasks.getTask(moved.number))).key!
    const r = await keys.withCardNames(w, () => lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [own], ownBuilder: true, by: 'B2 (alpha)' }), 'alpha')
    const keptKey = (await run(() => tasks.getTask(kept))).key!
    expect(keptKey).toBeTruthy()
    expect(r.note).toContain(`${keptKey}, #${beta.number}, #${loose}, #${moved.number}, #${missing} stay on the lane`)
    for (const k of [beta.key!, movedKey]) expect(r.note).not.toContain(k)
    await lanes.endLane(w, l.id, { abandoned: true })
  })
})
