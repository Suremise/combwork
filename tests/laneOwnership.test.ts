// Hive owns the lane (#1270, SPEC §16.11): a list change made while a card is in flight is queued and applied at the
// next card boundary (the builder told, none dropped: S3); a lane's cards start under the ruleset it started with (S19);
// one card at a time (a lane's card starts only once the ones before it are Done: S43's P4 form); a lane ends by itself
// once its cards are Done, its merge commit from their facts (an agent's ignored) and a verified lane-end event fired
// once; why a lane waits, as data; hive_lane next. With workflow rules off, a lane is bookkeeping, as before 1.0.
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
    expect(laneStatus(rec, [lc(1, 'doing'), lc(2, 'todo')], 1, false, new Map([[1, ff({ rounds: 3 })]]))).toEqual({ reason: 'roundLimit', card: 1 })
    expect(laneStatus(rec, [lc(1, 'passed'), lc(2, 'todo')], null, false, new Map([[1, ff({ stage: 'approved' })]]))).toEqual({ reason: 'notMerged', card: 1 })
    expect(laneStatus(rec, [lc(1, 'passed'), lc(2, 'todo')], null, false, new Map([[1, ff({ stage: 'merging' })]]))).toEqual({ reason: 'merging', card: 1 })
    expect(laneStatus(rec, [lc(1, 'review', { reviewing: true }), lc(2, 'todo')], 1, false, new Map([[1, ff({ stage: 'review', stale: true })]]))).toEqual({ reason: 'stale', card: 1 })
    expect(laneStatus(rec, [lc(1, 'review'), lc(2, 'todo')], 1, false, new Map([[1, ff({ stage: 'review' })]]))).toEqual({ reason: 'reviewer', card: 1 })
    expect(laneStatus({ rounds: 3, pending: [1, 2, 3] }, [lc(1, 'doing'), lc(2, 'todo')], 1, false, new Map([[1, ff()]]))).toEqual({ reason: 'listChanges', card: 1 })
    expect(laneStatus(rec, [lc(1, 'doing'), lc(2, 'todo')], 1, false, new Map([[1, ff()]]))).toBeNull()
    expect(laneStatus(rec, [lc(1, 'done'), lc(2, 'gone')], null, false, new Map())).toBeNull()
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
    expect(laneHits(before, now({ reason: 'notMerged', card: 1 }), ['paused'])?.parts).toEqual([{ n: 1, event: 'paused', text: 'paused: waiting: #1 not merged', detail: 'notMerged' }])
    expect(laneHits(before, now({ reason: 'blocked', card: 1 }), ['paused'])).toBeNull()
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
    writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] }))
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
    const r = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a, b], by: 'B1 (alpha)' })
    expect(r.did).toBe('updated')
    expect(r.note).toMatch(new RegExp(`queued: it applies once #${a} is Done`))
    expect(r.lane.cards.map((c) => c.number)).toEqual([a])
    expect(r.lane.queued).toEqual([a, b])
    expect(r.lane.status).toEqual({ reason: 'listChanges', card: a })
    // The runtime reads a queued card as the lane's already (its ruleset).
    expect(facts().card(b).lane).toBe(l.id)
    await move(a, 'done')
    await vi.waitFor(async () => expect((await lane(l.id)).cards.map((c) => c.number)).toEqual([a, b]), { timeout: HUNG_MS })
    expect((await lane(l.id)).queued).toBeNull()
    await vi.waitFor(async () => expect((await deliveriesOf(project, 'b1')).some((d) => d.kind === 'rebrief' && /card list changed, as queued/.test(d.body))).toBe(true), { timeout: HUNG_MS })
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

  it("why a lane waits comes with it: a card passed but not merged pauses it; hive_lane next names the card or the wait", async () => {
    const [a, b] = [await make('Wait a'), await make('Wait b')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })).lane
    const first = await lanes.laneNext(w, 'alpha', 'b1')
    expect(laneNextText({ ...first, lane: { ...first.lane, cards: first.lane.cards } })).toBe(`Next: #${a} Wait a. Start it.`)
    await move(a, 'doing')
    expect(laneNextText(await lanes.laneNext(w, 'alpha', 'b1'))).toBe(`Carry on with #${a} Wait a.`)
    await move(a, 'passed')
    const paused = await lane(l.id)
    expect([paused.state, paused.status, paused.pausedOn]).toEqual(['paused', { reason: 'notMerged', card: a }, a])
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

  it("with rules off an agent ends a lane as before: its merge commit as given, unverified", async () => {
    await advanced.set(ENFORCE, false)
    const a = await make('Off a')
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [a], by: 'B1 (alpha)' })).lane
    const done = await lanes.endLane(w, l.id, { project: 'alpha', agent: 'b1', mergeCommit: 'abc1234' })
    expect([done.state, done.mergeCommit]).toEqual(['ended', 'abc1234'])
  })
})
