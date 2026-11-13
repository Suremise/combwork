// Lanes (#483): the card loops a workspace runs, as the card-loop skill registers them. How a lane reads against the
// board (its current card, paused while that is blocked, rounds), which are listed, what is kept, and the service:
// start, update, join (either order), end, an agent's removal, and following the board (all Done ends it). An ended or
// abandoned lane keeps its cards as it left them, and a lane is on the card being worked (#512).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { CombworkEvent, TaskCard } from '../src/shared/types'
import { preferencesOf } from '../src/shared/workflow/preferences'
import { allDone, keptLanes, laneCard, laneLine, laneNextText, laneView, listedLanes, readLane, readLanes, laneCards, laneNumber, laneName, LANE_LINGER_MS, LANE_NAME_MAX, LANE_KEEP_MS, MAX_LANES, type LaneRecord, type LaneSlotHeld } from '../src/shared/lanes'
import { tempDir } from './tempDir'
import { storeDocs } from './storeDocs'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const base = tempDir('cw-lanes-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')

/** Workflow rules off for one test (#1270: Combwork owns the lane while they are on), on again after it. */
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
const rulesOff = (): Promise<unknown> => advanced.set(ENFORCE, false)
afterEach(async () => {
  await advanced.set(ENFORCE, true)
})
const { onCombworkEvent } = await import('../src/main/events')
const { saveTable } = await import('../src/main/storeTables')

vi.setConfig({ testTimeout: 30_000 })

const rec = (over: Partial<LaneRecord> = {}): LaneRecord => ({
  id: 'lane-1',
  project: 'alpha',
  name: null,
  builder: { id: 'b1', name: 'B1' },
  reviewer: { id: 'r1', name: 'R1' },
  cards: [1, 2, 3],
  rounds: 10,
  waitMinutes: 360,
  state: 'active',
  startedBy: 'B1 (alpha)',
  startedAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  endedAt: null,
  mergeCommit: null,
  ...over
})

const card = (number: number, column: TaskCard['column'], over: Partial<TaskCard> = {}): TaskCard =>
  ({ number, title: `Card ${number}`, column, project: 'alpha', blocked: null, history: [], comments: [], archived: false, ...over }) as unknown as TaskCard

describe('a lane on slots (#1438)', () => {
  const cards = new Map([[1, card(1, 'done')], [2, card(2, 'todo')], [3, card(3, 'todo')]])

  it("its slot's details for the row's hover (#1446): lent or carried, its line, ready or preparing, waiting while preparing", () => {
    const info = { name: 'slot-b', carried: false, line: 'cw/HI/HI-2-lane-hover', state: 'ready' as const, since: '2026-10-23T10:00:00.000Z' }
    const v = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: 'slot-b', waiting: false, info })
    expect([v.slot, v.slotInfo, v.status]).toEqual(['slot-b', info, null])
    // Its builder's carried slot (a 0.9 worktree, #1441): named the same way.
    const carried = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: 'hb2', waiting: false, info: { ...info, name: 'hb2', carried: true } })
    expect([carried.slot, carried.slotInfo?.carried]).toEqual(['hb2', true])
    // Being prepared (G15's warming): said, never pausing, and nothing more pressing hidden by it.
    const preparing = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: 'slot-b', waiting: false, info: { ...info, state: 'preparing' } })
    expect([preparing.status, preparing.state]).toEqual([{ reason: 'preparing', card: 2, slot: 'slot-b' }, 'active'])
    expect(laneLine(preparing)).toContain('waiting: preparing slot-b')
    const blocked = laneView(rec(), new Map([[1, card(1, 'done')], [2, card(2, 'doing', { blocked: 'Asked the user' })], [3, card(3, 'todo')]]), undefined, null, undefined, null, undefined, null, null, { slot: 'slot-b', waiting: false, info: { ...info, state: 'preparing' } })
    expect(blocked.status?.reason).toBe('blocked')
    // Ended: none.
    expect(laneView(rec({ state: 'ended', endedAt: '2026-10-09T11:00:00.000Z' }), cards, undefined, null, undefined, null, undefined, null, null, { slot: 'slot-b', waiting: false, info }).slotInfo).toBeNull()
  })

  it("a pool lane's current card (#1446): who gave its last verdict and who reviews it now, by name; other lanes have none", () => {
    const pool = rec({ reviewer: null, pool: true })
    const names = new Map([['r1', 'HI-R1'], ['r2', 'HI-R2'], ['b1', 'B1']])
    const facts = new Map([[2, { stage: 'review' as const, forYou: false, stale: false, rounds: 1, lastVerdict: { reviewer: 'r1', pass: false }, reviewing: 'r2' }]])
    const live = new Map([[1, card(1, 'done')], [2, card(2, 'review')], [3, card(3, 'todo')]])
    expect(laneView(pool, live, names, facts).poolReview).toEqual({ lastVerdict: { name: 'HI-R1', pass: false }, reviewing: 'HI-R2' })
    const waiting = new Map([[2, { ...facts.get(2)!, reviewing: null }]])
    expect(laneView(pool, live, names, waiting).poolReview).toEqual({ lastVerdict: { name: 'HI-R1', pass: false }, reviewing: null })
    expect(laneView(rec(), live, names, facts).poolReview).toBeUndefined()
  })

  it("names its slot, and while it has none and waits for one: paused, 'waiting for a slot'; what waits for the user says more", () => {
    const v = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: 'slot-b', waiting: false })
    expect([v.slot, v.status, v.state]).toEqual(['slot-b', null, 'active'])
    expect(laneLine(v)).toContain('B1 / R1 (alpha, in slot-b)')
    const waiting = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: null, waiting: true })
    expect([waiting.state, waiting.status?.reason, waiting.slot]).toEqual(['paused', 'slot', null])
    expect(laneLine(waiting)).toContain('waiting for a slot')
    // HI-2466: its only free slot held: which, and by what.
    const held = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: null, waiting: true, held: { slot: 'slot-a', held: 'session', agent: 'CB1' } })
    expect([held.state, held.status]).toEqual(['paused', { reason: 'slot', card: 2, slot: 'slot-a', held: 'session', agent: 'CB1' }])
    expect(laneLine(held)).toContain("waiting for slot-a: CB1's session is still in it")
    const process = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: null, waiting: true, held: { slot: 'slot-a', held: 'process' } })
    // HI-3168: its builder already builds in slot-a for another card (an ended lane's card in flight): which slot and card.
    const byCard = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: null, waiting: true, held: { slot: 'slot-a', held: 'card', agent: 'B1', card: 7 } })
    expect([byCard.state, byCard.status]).toEqual(['paused', { reason: 'slot', card: 2, slot: 'slot-a', held: 'card', agent: 'B1', heldFor: 7 }])
    expect(laneLine(byCard)).toContain('waiting for a slot: B1 still builds in slot-a for #7, which keeps it until that card is Done or put back')
    expect(laneLine(process)).toContain('waiting for slot-a: a process still has a file or folder in it open')
    // HI-2467: Windows Sandbox's broker seen working in it, idle, a Sandbox running, or that not known.
    const broker = (idle?: boolean) => laneLine(laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: null, waiting: true, held: { slot: 'slot-a', held: 'broker', broker: 'WindowsSandboxServer', ...(idle !== undefined ? { idle } : {}) } }))
    expect(broker(true)).toContain("waiting for slot-a: a process still has a file or folder in it open: Windows Sandbox's broker (WindowsSandboxServer) is working in it, with no Sandbox running")
    expect(broker(false)).toContain("Windows Sandbox's broker (WindowsSandboxServer) is working in it, with a Sandbox running")
    expect(broker()).toContain("Windows Sandbox's broker (WindowsSandboxServer) is working in it")
    expect(broker()).not.toMatch(/Sandbox running/)
    const blocked =laneView(rec(), new Map([[1, card(1, 'doing', { blocked: 'Asked the user' })], [2, card(2, 'todo')], [3, card(3, 'todo')]]), undefined, null, undefined, null, undefined, null, null, { slot: null, waiting: true })
    expect(blocked.status?.reason).toBe('blocked')
    // Ended: no slot, no wait.
    const ended = laneView(rec({ state: 'ended', endedAt: '2026-10-09T11:00:00.000Z' }), cards, undefined, null, undefined, null, undefined, null, null, { slot: 'slot-b', waiting: true })
    expect([ended.slot, ended.status]).toEqual([null, null])
  })

  it('HI-2468: a running builder\'s start refused for its slot held names the slot and what holds it; refused otherwise, as before', () => {
    const view = (held?: LaneSlotHeld) => laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, null, undefined, { card: 2, why: 'refused', agent: 'B1', ...(held ? { held } : {}) })
    // Still a start's wait (never a wait for a slot): the builder is B1, and the session in the slot its own field.
    const session = view({ slot: 'slot-a', held: 'session', agent: 'CB1' })
    expect(session.status).toEqual({ reason: 'startWait', card: 2, why: 'refused', agent: 'B1', slot: 'slot-a', held: 'session', heldBy: 'CB1' })
    expect(laneLine(session)).toContain("#2 waits to start: its start was refused for now, slot-a still in use (CB1's session is still in it); Combwork tries again")
    expect(laneLine(view({ slot: 'slot-a', held: 'process' }))).toContain('#2 waits to start: its start was refused for now, slot-a still in use (a process still has a file or folder in it open); Combwork tries again')
    const broker = view({ slot: 'slot-a', held: 'broker', broker: 'WindowsSandboxServer', idle: false })
    expect(broker.status).toMatchObject({ reason: 'startWait', why: 'refused', slot: 'slot-a', held: 'broker', broker: 'WindowsSandboxServer', idle: false })
    expect(laneLine(broker)).toContain("slot-a still in use (a process still has a file or folder in it open: Windows Sandbox's broker (WindowsSandboxServer) is working in it, with a Sandbox running); Combwork tries again")
    // No slot free, as its builder's own last run still holds it: what that run left there, or that it isn't known to have ended.
    expect(laneLine(view({ slot: 'slot-a', held: 'left', agent: 'B1', program: 'node' }))).toContain("slot-a still in use (B1's last run left node running in it); Combwork tries again")
    expect(laneLine(view({ slot: 'slot-a', held: 'left', agent: 'B1', program: 'node', more: 2 }))).toContain("slot-a still in use (B1's last run left node and 2 more running in it); Combwork tries again")
    expect(view({ slot: 'slot-a', held: 'left', agent: 'B1', program: 'node', more: 2 }).status).toMatchObject({ held: 'left', heldBy: 'B1', program: 'node', more: 2 })
    expect(laneLine(view({ slot: 'slot-a', held: 'lastRun', agent: 'B1' }))).toContain("slot-a still in use (B1's last run there isn't known to have ended); Combwork tries again")
    // Refused for another reason, or nothing held any more: as before HI-2468.
    const bare = view()
    expect(bare.status).toEqual({ reason: 'startWait', card: 2, why: 'refused', agent: 'B1' })
    expect(laneLine(bare)).toContain('#2 waits to start: its start was refused for now; Combwork tries again')
    // A held slot kept with another reason (the builder busy) never shows: only a refused start says it.
    expect(laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, null, undefined, { card: 2, why: 'busy', agent: 'B1', held: { slot: 'slot-a', held: 'process' } }).status).toEqual({ reason: 'startWait', card: 2, why: 'busy', agent: 'B1' })
  })

  it("cw_lane next says where the next card is built", () => {
    const v = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: 'slot-b', waiting: false })
    expect(laneNextText({ lane: v, next: { card: 2, title: 'Card 2', carryOn: false }, waits: null })).toBe('Next: #2 Card 2. Start it: it is built in slot-b, on a new branch Combwork makes there.')
    expect(laneNextText({ lane: v, next: { card: 2, title: 'Card 2', carryOn: true }, waits: null })).toBe('Carry on with #2 Card 2 in slot-b.')
    const none = laneView(rec(), cards)
    expect(laneNextText({ lane: none, next: { card: 2, title: 'Card 2', carryOn: false }, waits: null })).toBe('Next: #2 Card 2. Start it.')
  })

  it('HI-2245: cw_lane next says to hand over a card carried on with commits past its submission, and nothing more without them', () => {
    const v = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, { slot: 'slot-b', waiting: false })
    const u = [{ card: 2, count: 2, atLeast: false, since: 'ab30f52' }]
    expect(laneNextText({ lane: v, next: { card: 2, title: 'Card 2', carryOn: true }, waits: null, unsubmitted: u })).toBe('Carry on with #2 Card 2 in slot-b. First hand it over: its line has 2 commits since its submission (ab30f52); cw_submit with followUp: true.')
    // Another card's fact isn't this one's; with none, the reply is as before.
    expect(laneNextText({ lane: v, next: { card: 2, title: 'Card 2', carryOn: true }, waits: null, unsubmitted: [{ ...u[0], card: 3 }] })).toBe('Carry on with #2 Card 2 in slot-b.')
    expect(laneNextText({ lane: v, next: { card: 2, title: 'Card 2', carryOn: true }, waits: null, unsubmitted: [] })).toBe('Carry on with #2 Card 2 in slot-b.')
  })
})

describe('a lane against the board', () => {
  it('its current card is the first not passed or done; rounds count failed reviews', () => {
    const failed = { at: '', by: 'R1', what: 'Review failed' }
    const v = laneView(rec(), new Map([[1, card(1, 'done')], [2, card(2, 'review', { history: [failed, failed] as TaskCard['history'], review: { agent: 'r1' } as TaskCard['review'] })], [3, card(3, 'todo')]]))
    expect(v.current).toBe(2)
    expect(v.state).toBe('active')
    expect(v.cards.map((c) => [c.number, c.column, c.round, c.reviewing])).toEqual([[1, 'done', 1, false], [2, 'review', 3, true], [3, 'todo', 1, false]])
  })

  it('is paused while its current card is blocked, and only then', () => {
    const paused = laneView(rec(), new Map([[1, card(1, 'passed')], [2, card(2, 'doing', { blocked: 'Asked the user' })], [3, card(3, 'todo')]]))
    expect([paused.state, paused.pausedOn]).toEqual(['paused', 2])
    // A later card blocked (its own reason) doesn't pause the lane.
    const later = laneView(rec(), new Map([[1, card(1, 'doing')], [2, card(2, 'todo')], [3, card(3, 'todo', { blocked: 'Needs #2' })]]))
    expect([later.state, later.pausedOn]).toEqual(['active', null])
    // An ended lane stays ended.
    expect(laneView(rec({ state: 'ended', endedAt: '2026-10-09T11:00:00.000Z' }), new Map([[1, card(1, 'doing', { blocked: 'x' })]])).state).toBe('ended')
  })

  it("is on the card being worked: a builder that moved on while a blocked card waits isn't paused (#512)", () => {
    const moved = laneView(rec(), new Map([[1, card(1, 'review', { blocked: 'Asked the user' })], [2, card(2, 'doing')], [3, card(3, 'todo')]]))
    expect([moved.state, moved.current, moved.pausedOn]).toEqual(['active', 2, null])
    expect(laneLine(moved)).toContain('active, on #2; #1 Review (blocked), #2 Doing')
    // A card in Review and the next in Doing (fixing while it is reviewed, or the next card started): the one in Doing.
    expect(laneView(rec(), new Map([[1, card(1, 'review')], [2, card(2, 'doing')], [3, card(3, 'todo')]])).current).toBe(2)
  })

  it('an ended or abandoned lane reads as it left its cards, not as the board has them now (#512)', () => {
    const frozen = [
      { number: 1, title: 'Card 1', column: 'passed' as const, blocked: null, round: 2, reviewing: false },
      { number: 2, title: 'Card 2', column: 'doing' as const, blocked: null, round: 1, reviewing: false },
      { number: 3, title: 'Card 3', column: 'todo' as const, blocked: null, round: 1, reviewing: false }
    ]
    const board = new Map([[1, card(1, 'done')], [2, card(2, 'done')], [3, card(3, 'doing')]])
    const v = laneView(rec({ state: 'abandoned', endedAt: '2026-10-09T11:00:00.000Z', frozen }), board)
    expect(v.cards).toEqual(frozen)
    expect([v.state, v.current]).toEqual(['abandoned', 2])
    // A running lane always reads the board (a stale snapshot ignored).
    expect(laneView(rec({ frozen }), board).cards.map((c) => c.column)).toEqual(['done', 'done', 'doing'])
  })

  it("one ended without that record (before #512, or a damaged one) says its cards weren't recorded, whatever the board does", () => {
    // An abandoned lane with no snapshot while another lane moves its card #2 Doing → Review → Done: it reads the same
    // throughout, its cards not recorded, with no current card, and only their titles from the board.
    const legacy = rec({ state: 'abandoned', endedAt: '2026-10-09T11:00:00.000Z', name: 'old' })
    const seen = (['doing', 'review', 'done'] as const).map((col) => laneView(legacy, new Map([[1, card(1, 'passed')], [2, card(2, col, { blocked: col === 'review' ? 'x' : null })], [3, null]])))
    for (const v of seen) {
      expect(v.cards).toEqual([
        { number: 1, title: 'Card 1', column: 'unrecorded', blocked: null, round: 1, reviewing: false },
        { number: 2, title: 'Card 2', column: 'unrecorded', blocked: null, round: 1, reviewing: false },
        { number: 3, title: '', column: 'unrecorded', blocked: null, round: 1, reviewing: false }
      ])
      expect([v.state, v.current, v.pausedOn]).toEqual(['abandoned', null, null])
      expect(laneLine(v)).toBe('B1 / R1 (alpha) old: abandoned; #1 not recorded, #2 not recorded, #3 not recorded; rounds 10, wait 6 h. lane-1')
    }
    // A snapshot that doesn't read back (damaged by hand) is dropped by readLane: the same.
    const damaged = readLane({ ...legacy, frozen: [{ number: 1 }, { number: 2 }, { number: 3 }] })!
    expect(laneView(damaged, new Map([[2, card(2, 'doing')]])).cards.map((c) => c.column)).toEqual(['unrecorded', 'unrecorded', 'unrecorded'])
  })

  it('a card gone (archived, deleted, another project) reads as gone and is skipped', () => {
    const v = laneView(rec(), new Map([[1, card(1, 'done')], [2, null], [3, card(3, 'todo')]]))
    expect(v.cards[1]).toMatchObject({ number: 2, column: 'gone', title: '' })
    expect(v.current).toBe(3)
  })

  it('names its agents as the project has them now', () => {
    const v = laneView(rec(), new Map(), new Map([['b1', 'Builder One']]))
    expect([v.builder.name, v.reviewer?.name]).toEqual(['Builder One', 'R1'])
  })

  it('all Done (gone cards aside) ends it; Passed is not merged; every card gone or held elsewhere ends it too (HI-3117)', () => {
    expect(allDone(laneView(rec(), new Map([[1, card(1, 'done')], [2, null], [3, card(3, 'done')]])).cards)).toBe(true)
    expect(allDone(laneView(rec(), new Map([[1, card(1, 'done')], [2, card(2, 'passed')], [3, card(3, 'done')]])).cards)).toBe(false)
    // Every card gone (archived): nothing left to do, so it ends rather than holding its builder for good.
    expect(allDone(laneView(rec(), new Map()).cards)).toBe(true)
    // A card given to another agent (held elsewhere) is that agent's: the lane doesn't wait for it to end.
    const of = { lane: 'lane-1', builder: 'b1' }
    expect(allDone([laneCard(1, card(1, 'done'), of), laneCard(2, card(2, 'todo', { agent: 'b9' }), of)])).toBe(true)
    expect(allDone([laneCard(1, card(1, 'done'), of), laneCard(2, card(2, 'todo', { agent: 'b1' }), of)])).toBe(false)
  })

  it('in a line: its pair, state, cards and id', () => {
    const v = laneView(rec({ name: 'lanes and loops' }), new Map([[1, card(1, 'passed')], [2, card(2, 'review', { history: [{ at: '', by: 'R1', what: 'Review failed' }] as TaskCard['history'] })], [3, card(3, 'todo')]]))
    expect(laneLine(v)).toBe('B1 / R1 (alpha) lanes and loops: active, on #2; #1 Passed, #2 Review r2, #3 Todo; rounds 10, wait 6 h. lane-1')
  })
})

describe('which lanes are listed and kept', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z')
  const ago = (ms: number): string => new Date(now - ms).toISOString()

  it('running ones, and ended ones for an hour unless their builder started another', () => {
    const live = rec({ id: 'a' })
    const recent = rec({ id: 'b', builder: { id: 'b2', name: 'B2' }, state: 'ended', endedAt: ago(10 * 60_000), startedAt: '2026-10-09T08:00:00.000Z' })
    const old = rec({ id: 'c', builder: { id: 'b3', name: 'B3' }, state: 'abandoned', endedAt: ago(LANE_LINGER_MS + 1000) })
    const replaced = rec({ id: 'd', state: 'ended', endedAt: ago(60_000), startedAt: '2026-10-09T09:00:00.000Z' })
    expect(listedLanes([live, recent, old, replaced], now).map((l) => l.id)).toEqual(['b', 'a'])
  })

  it('keeps running lanes and those ended within a day, at most MAX_LANES', () => {
    const list = [rec({ id: 'live' }), rec({ id: 'day', state: 'ended', endedAt: ago(LANE_KEEP_MS + 1) }), rec({ id: 'hour', state: 'ended', endedAt: ago(60_000) })]
    expect(keptLanes(list, now).map((l) => l.id)).toEqual(['live', 'hour'])
    const many = Array.from({ length: MAX_LANES + 5 }, (_, i) => rec({ id: `e${i}`, state: 'ended', endedAt: ago((MAX_LANES + 5 - i) * 1000) }))
    const kept = keptLanes([rec({ id: 'live' }), ...many], now)
    expect(kept.length).toBe(MAX_LANES)
    expect(kept.some((l) => l.id === 'live')).toBe(true)
    expect(kept.some((l) => l.id === 'e0')).toBe(false)
  })

  it('reads back only lanes it would have written', () => {
    expect(readLane(rec())).toEqual(rec())
    expect(readLane({ ...rec(), cards: [] })).toBeNull()
    expect(readLane({ ...rec(), cards: [1, 1] })).toBeNull()
    expect(readLane({ ...rec(), state: 'paused' })).toBeNull()
    expect(readLane({ ...rec(), state: 'ended', endedAt: null })).toBeNull()
    expect(readLane({ ...rec(), rounds: 0 })).toBeNull()
    expect(readLanes({ lanes: [rec(), rec(), 'junk', null] }).length).toBe(1)
    expect(readLanes('nonsense')).toEqual([])
    // Its snapshot (#512) reads back whole, or not at all (the lane kept, reading the board).
    const frozen = [1, 2, 3].map((number) => ({ number, title: `Card ${number}`, column: 'todo' as const, blocked: null, round: 1, reviewing: false }))
    const ended = rec({ state: 'ended', endedAt: '2026-10-09T11:00:00.000Z', frozen })
    expect(readLane(ended)).toEqual(ended)
    const { frozen: _dropped, ...without } = ended
    expect(readLane({ ...ended, frozen: frozen.slice(0, 2) })).toEqual(without)
    expect(readLane({ ...ended, frozen: [frozen[1], frozen[0], frozen[2]] })).toEqual(without)
    expect(readLane({ ...ended, frozen: [{ ...frozen[0], column: 'sideways' }, frozen[1], frozen[2]] })).toEqual(without)
  })

  it('checks what a call gives', () => {
    expect(laneCards([3, 1, 2])).toEqual([3, 1, 2])
    expect(laneCards([])).toHaveProperty('said')
    expect(laneCards([1, 1])).toHaveProperty('said')
    expect(laneCards([1.5])).toHaveProperty('said')
    expect(laneNumber(undefined, 'rounds', 5)).toBe(5)
    expect(laneNumber(360, 'waitMinutes', 120)).toBe(360)
    expect(laneNumber(0, 'rounds', 5)).toHaveProperty('said')
    expect(laneNumber(99999, 'waitMinutes', 5)).toHaveProperty('said')
    expect(laneName('  lanes\nand   loops ')).toBe('lanes and loops')
    expect(laneName('')).toBeNull()
  })

  it('a lane name is cut to LANE_NAME_MAX UTF-16 units, never inside a character, and a lane is never dropped for its name (HI-3119)', () => {
    const long = 'n'.repeat(103)
    expect(laneName(long)).toBe(`${'n'.repeat(LANE_NAME_MAX - 1)}…`)
    expect(laneName('n'.repeat(LANE_NAME_MAX))).toBe('n'.repeat(LANE_NAME_MAX))
    // An emoji (two units) straddling the cut is left out whole, not split into a lone surrogate.
    const emoji = laneName(`${'n'.repeat(LANE_NAME_MAX - 2)}😀${'n'.repeat(10)}`)!
    expect(emoji).toBe(`${'n'.repeat(LANE_NAME_MAX - 2)}…`)
    expect(emoji.length).toBeLessThanOrEqual(LANE_NAME_MAX)
    const fits = laneName(`${'n'.repeat(LANE_NAME_MAX - 3)}😀${'n'.repeat(10)}`)!
    expect(fits).toBe(`${'n'.repeat(LANE_NAME_MAX - 3)}😀…`)
    expect(fits.length).toBe(LANE_NAME_MAX)
    // Saved longer (by a build before this, or by hand): the lane reads, its name cut.
    expect(readLane({ ...rec(), name: long })).toEqual({ ...rec(), name: laneName(long) })
    expect(readLane({ ...rec(), name: '' })).toEqual({ ...rec(), name: null })
    expect(readLane({ ...rec(), name: 42 })).toEqual({ ...rec(), name: null })
    expect(readLanes({ lanes: [{ ...rec(), name: long }] })).toHaveLength(1)
  })
})

describe("a card loop's rounds and wait when the request doesn't say (#412, HI-1766: workflow options)", () => {
  it("the project's, else the workspace's, else Combwork's, else 10 rounds and 6 hours; values out of range are passed over", () => {
    const of = (levels: Parameters<typeof preferencesOf>[1]) => {
      const v = preferencesOf('git', levels).values
      return { rounds: v.loopRounds, waitHours: v.loopWaitHours }
    }
    expect(of({})).toEqual({ rounds: 10, waitHours: 6 })
    expect(of({ workspace: { git: { loopRounds: 4 } } })).toEqual({ rounds: 4, waitHours: 6 })
    expect(of({ global: { git: { loopWaitHours: 2 } }, workspace: { git: { loopRounds: 4 } }, project: { loopRounds: 7 } })).toEqual({ rounds: 7, waitHours: 2 })
    // Another platform's defaults don't apply.
    expect(of({ workspace: { none: { loopRounds: 4 } } })).toEqual({ rounds: 10, waitHours: 6 })
    expect(of({ workspace: { git: { loopRounds: 0, loopWaitHours: 25 } }, project: { loopRounds: 2.5, loopWaitHours: -1 } as never })).toEqual({ rounds: 10, waitHours: 6 })
  })
})

describe('the lanes service', () => {
  type WS = ReturnType<typeof createWorkspaceService>
  let w: WS
  const wsPath = join(base, 'ws')
  const events: CombworkEvent[] = []
  let off: () => void
  const user = { kind: 'user' } as const
  beforeAll(async () => {
    const p = join(wsPath, 'alpha')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'b2', name: 'B2', workflowRole: 'either' }, { id: 'g1', name: 'G1', workflowRole: 'generalist' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    lanes.startLanes()
    off = onCombworkEvent((e) => e.type === 'lanes-changed' && events.push(e))
  })
  afterAll(async () => {
    off()
    await disposeWorkspaceService(w)
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = (title: string) => run(() => tasks.createTask({ title, project: 'alpha' }, user))
  const until = async (fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> => {
    const t = Date.now()
    while (!(await fn()) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50))
    return fn()
  }

  it("a generalist is never a lane's builder or reviewer: a new lane, a reviewer change and a join are refused, nothing changed (HI-686)", async () => {
    const [c1, c2] = [await make('Gen one'), await make('Gen two')]
    const generalist = /G1 is a generalist: it takes no side in the workflow/
    await expect(lanes.startLane(w, { project: 'alpha', builder: 'g1', reviewer: 'r1', cards: [c1.number], by: 'the Assistant' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(generalist) })
    await expect(lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'g1', cards: [c1.number], by: 'the Assistant' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(generalist) })
    expect((await lanes.listLanes(w)).filter((l) => l.builder.id === 'g1' || l.reviewer?.id === 'g1' || l.builder.id === 'b2')).toEqual([])
    // A running lane: its reviewer not changed to the generalist, and a generalist can't join it.
    const kept = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number], by: 'B2 (alpha)' })
    await expect(lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'g1', cards: [c1.number, c2.number], by: 'the Assistant' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(generalist) })
    await expect(lanes.joinLane(w, { project: 'alpha', builder: 'b2', reviewer: 'g1', cards: [c1.number], by: 'G1 (alpha)' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(generalist) })
    const now = (await lanes.listLanes(w)).find((l) => l.id === kept.lane.id)
    expect([now?.reviewer?.id, now?.cards.map((x) => x.number)]).toEqual(['r1', [c1.number]])
    // The other roles as before: an either-role or guessed reviewer still reviews.
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number, c2.number], by: 'B2 (alpha)' })).did).toBe('updated')
    await lanes.endLane(w, kept.lane.id, { abandoned: true })
  })

  // HI-2664 (HR3's round 1): an agent whose role changed while it ran keeps its old side's tools until it restarts.
  it("an agent still on its old role's tools isn't given a lane part needing the new ones: refused, saying to restart it, nothing changed", async () => {
    const [c1] = [await make('Old tools')]
    const oldTools = /R1's role changed while it was running, and it still has its old role's tools: .*Restart it first/
    lanes.setPartToolsCheck((_p, id, part) => !(id === 'r1' && part === 'reviewer'))
    try {
      await expect(lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number], by: 'the Assistant' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(oldTools) })
      expect((await lanes.listLanes(w)).filter((l) => l.builder.id === 'b2' && l.state === 'active')).toEqual([])
      const kept = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: null, pool: true, cards: [c1.number], by: 'the Assistant' })
      await expect(lanes.joinLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number], by: 'R1 (alpha)' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(oldTools) })
      expect((await lanes.listLanes(w)).find((l) => l.id === kept.lane.id)?.reviewer ?? null).toBe(null)
      await lanes.endLane(w, kept.lane.id, { abandoned: true })
    } finally {
      lanes.setPartToolsCheck(() => true)
    }
    // Restarted with its tools: the same start goes ahead.
    const started = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number], by: 'the Assistant' })
    expect(started.lane.reviewer?.id).toBe('r1')
    await lanes.endLane(w, started.lane.id, { abandoned: true })
  })

  it('starts a lane, updates it when started again with a card in common, and starts anew with none', async () => {
    // A list sharing no card is another loop, as with workflow rules off: with them on it edits the running lane (#1270).
    await rulesOff()
    const [c1, c2, c3] = [await make('One'), await make('Two'), await make('Three')]
    const a = await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c1.number, c2.number], rounds: 10, waitMinutes: 360, name: 'first', by: 'B1 (alpha)' })
    expect(a.did).toBe('started')
    expect(a.lane).toMatchObject({ builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, rounds: 10, waitMinutes: 360, state: 'active', current: c1.number, startedBy: 'B1 (alpha)' })
    // Resumed or changed (a card added): the same lane, its reviewer kept.
    const b = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [c1.number, c2.number, c3.number], by: 'B1 (alpha)' })
    expect([b.did, b.lane.id, b.lane.reviewer?.id, b.lane.rounds, b.lane.cards.length]).toEqual(['updated', a.lane.id, 'r1', 10, 3])
    // Other cards altogether: the earlier lane is abandoned (its cards aren't done), a new one starts.
    const c4 = await make('Four')
    const c = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [c4.number], by: 'B1 (alpha)' })
    expect([c.did, c.replaced?.id, c.replaced?.state, c.lane.reviewer]).toEqual(['started', a.lane.id, 'abandoned', null])
    // One running lane per builder.
    const listed = await lanes.listLanes(w)
    expect(listed.filter((l) => l.builder.id === 'b1' && (l.state === 'active' || l.state === 'paused')).map((l) => l.id)).toEqual([c.lane.id])
    // The abandoned one isn't listed: its builder started another.
    expect(listed.some((l) => l.id === a.lane.id)).toBe(false)
    expect((await lanes.listLanes(w, { all: true })).some((l) => l.id === a.lane.id)).toBe(true)
    await lanes.endLane(w, c.lane.id, { abandoned: true })
  })

  it('a lane started with a name over LANE_NAME_MAX is saved with it cut, and stays listed; so does one renamed to one (HI-3119)', async () => {
    await rulesOff()
    const [c1, c2] = [await make('Long 1'), await make('Long 2')]
    const long = 'Lane '.repeat(21).trim()
    const a = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [c1.number], name: long, by: 'B1 (alpha)' })
    expect(a.lane.name).toBe(laneName(long))
    expect((await lanes.listLanes(w)).find((l) => l.id === a.lane.id)?.name).toBe(laneName(long))
    const emoji = `${'n'.repeat(LANE_NAME_MAX - 2)}😀 more`
    const b = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [c1.number, c2.number], name: emoji, by: 'B1 (alpha)' })
    expect([b.did, b.lane.id, b.lane.name]).toEqual(['updated', a.lane.id, laneName(emoji)])
    expect((await lanes.listLanes(w)).find((l) => l.id === a.lane.id)?.name).toBe(laneName(emoji))
    await lanes.endLane(w, a.lane.id, { abandoned: true })
  })

  it("a lane started without rounds or wait takes the project's workflow options as they resolve, else the workspace's; given ones win, and a lane keeps what it started with (#412, HI-1766)", async () => {
    // A list sharing no card is another loop, as with workflow rules off: with them on it edits the running lane (#1270).
    await rulesOff()
    const alpha = join(wsPath, 'alpha')
    const platform = w.info()!.projects.find((p) => p.name === 'alpha')!.platform?.id ?? 'none'
    const wasWorkflow = (await w.projectConfig(alpha)).workflow
    const [c1, c2, c3] = [await make('L1'), await make('L2'), await make('L3')]
    try {
      const plain = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [c1.number], by: 'B2 (alpha)' })
      expect([plain.lane.rounds, plain.lane.waitMinutes]).toEqual([10, 360])
      await w.saveWorkspaceConfigWith((c) => ({ workflow: { ...c.workflow, [platform]: { ...c.workflow?.[platform], loopRounds: 6, loopWaitHours: 3 } } }))
      const ws = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [c2.number], by: 'B2 (alpha)' })
      expect([ws.lane.rounds, ws.lane.waitMinutes]).toEqual([6, 180])
      await w.mutateProjectConfig(alpha, (c) => ({ workflow: { platform, preset: null, ...c.workflow, options: { ...(c.workflow?.platform === platform ? c.workflow.options : {}), loopRounds: 8 } } }))
      const proj = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [c3.number], by: 'B2 (alpha)' })
      expect([proj.lane.rounds, proj.lane.waitMinutes]).toEqual([8, 180])
      // The lanes started before keep what they started with.
      const listed = await lanes.listLanes(w, { all: true })
      expect(listed.find((l) => l.id === ws.lane.id)).toMatchObject({ rounds: 6, waitMinutes: 180 })
      const given = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [c3.number], rounds: 3, waitMinutes: 60, by: 'B2 (alpha)' })
      expect([given.lane.rounds, given.lane.waitMinutes]).toEqual([3, 60])
      await lanes.endLane(w, given.lane.id, { abandoned: true })
    } finally {
      await w.mutateProjectConfig(alpha, () => ({ workflow: wasWorkflow }))
      await w.saveWorkspaceConfigWith((c) => ({ workflow: { ...c.workflow, [platform]: {} } }))
    }
  })

  it('a reviewer joins its builder’s lane, before or after the builder starts it', async () => {
    const [c1, c2] = [await make('J1'), await make('J2')]
    // Before: no lane for B2 yet, so joining with the cards starts it.
    const early = await lanes.joinLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number, c2.number], by: 'R1 (alpha)' })
    expect([early.did, early.lane.builder.id, early.lane.reviewer?.id]).toEqual(['joined', 'b2', 'r1'])
    // The builder's own start then updates it, keeping its reviewer.
    const mine = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [c1.number, c2.number], rounds: 3, by: 'B2 (alpha)' })
    expect([mine.did, mine.lane.id, mine.lane.reviewer?.id, mine.lane.rounds]).toEqual(['updated', early.lane.id, 'r1', 3])
    // Without cards and no lane: refused, saying what to give.
    await lanes.endLane(w, mine.lane.id, {})
    await expect(lanes.joinLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', by: 'R1 (alpha)' })).rejects.toThrow(/no lane running yet/)
  })

  it("HI-2273: a running lane's start naming a reviewer that is no agent is refused, naming its reviewer, and changes nothing; a new lane starts without one", async () => {
    const [c1, c2, c3] = [await make('U1'), await make('U2'), await make('U3')]
    const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number, c2.number], by: 'B2 (alpha)' })).lane
    const guess = { project: 'alpha', builder: 'b2', reviewer: null, unknownReviewer: 'Reviewer', cards: [c1.number, c2.number, c3.number], by: 'B2 (alpha)', ownBuilder: true }
    await expect(lanes.startLane(w, guess)).rejects.toMatchObject({ status: 404, message: `No agent "Reviewer" in alpha; this lane's reviewer is R1: leave reviewer out to keep it.` })
    // Its reviewer and list as they were.
    const after = (await lanes.rawLanes(w)).find((l) => l.id === lane.id)!
    expect([after.state, after.reviewer?.id, after.cards, after.pending]).toEqual(['active', 'r1', [c1.number, c2.number], undefined])
    // Applied now too: refused before its card in flight could be put back.
    await expect(lanes.startLane(w, { ...guess, applyNow: true })).rejects.toThrow(/this lane's reviewer is R1/)
    // Leaving reviewer out keeps it.
    expect((await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [c1.number, c2.number, c3.number], by: 'B2 (alpha)', ownBuilder: true })).lane.reviewer?.id).toBe('r1')
    await lanes.endLane(w, lane.id, { abandoned: true })
    // A lane reviewed by the pool, and one with no reviewer yet, say so.
    const pool = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: null, pool: true, cards: [c1.number], by: 'the user' })).lane
    await expect(lanes.startLane(w, guess)).rejects.toThrow(`No agent "Reviewer" in alpha; this lane is reviewed by the project's reviewer pool: leave reviewer out.`)
    expect((await lanes.rawLanes(w)).find((l) => l.id === pool.id)?.pool).toBe(true)
    await lanes.endLane(w, pool.id, { abandoned: true })
    // No running lane: it starts without a reviewer, as before (one can join it); started again, refused as one with none.
    const fresh = await lanes.startLane(w, guess)
    expect([fresh.did, fresh.lane.reviewer]).toEqual(['started', null])
    await expect(lanes.startLane(w, guess)).rejects.toThrow(`No agent "Reviewer" in alpha; this lane has no reviewer yet: leave reviewer out, or name an agent of alpha.`)
    await lanes.endLane(w, fresh.lane.id, { abandoned: true })
  })

  it("HI-2273: next with no running lane says its lane just ended or was abandoned, never to start one; with none lately, to start one", async () => {
    const [c1] = [await make('N1')]
    const ended = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number], by: 'B2 (alpha)' })).lane
    await lanes.endLane(w, ended.id, {})
    // Ended by the user with its card still in Todo (HI-3118): said so, never "all its cards are Done".
    for (const agent of ['b2', 'r1']) await expect(lanes.laneNext(w, 'alpha', agent)).rejects.toThrow(`Your lane ${ended.id} was ended with #${c1.number} not Done: nothing more on it. Don't start it again; ask the user before starting another lane with that card.`)
    const abandoned = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number], by: 'B2 (alpha)' })).lane
    await lanes.endLane(w, abandoned.id, { abandoned: true })
    await expect(lanes.laneNext(w, 'alpha', 'b2')).rejects.toThrow(`Your lane ${abandoned.id} was abandoned: don't start it again; ask the user if there is more to do.`)
    // An agent that had no lane: as before.
    await expect(lanes.laneNext(w, 'alpha', 'g1')).rejects.toThrow('No running lane of yours: start one with cw_lane start, or ask the user')
  })

  it('a lane reviewed by the pool (#1443): kept with its row, nobody joins it, its builder keeps it; a reviewer named makes it one per lane', async () => {
    const [c1, c2] = [await make('Q1'), await make('Q2')]
    const started = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: null, pool: true, cards: [c1.number, c2.number], by: 'the user' })
    expect([started.lane.pool, started.lane.reviewer]).toEqual([true, null])
    expect(laneLine(started.lane)).toContain('B2 / the reviewer pool (alpha)')
    expect((await lanes.rawLanes(w)).find((l) => l.id === started.lane.id)?.pool).toBe(true)
    await expect(lanes.joinLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', by: 'R1 (alpha)' })).rejects.toThrow(/reviewed by the reviewer pool/)
    // The builder's own start (card-loop) names no reviewer: the pool stays.
    const mine = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [c1.number, c2.number], rounds: 3, by: 'B2 (alpha)' })
    expect([mine.did, mine.lane.id, mine.lane.pool, mine.lane.rounds]).toEqual(['updated', started.lane.id, true, 3])
    await expect(lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', pool: true, cards: [c1.number], by: 'B2 (alpha)' })).rejects.toThrow(/no reviewer of its own/)
    const named = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number, c2.number], by: 'B2 (alpha)' })
    expect([named.lane.id, named.lane.pool, named.lane.reviewer?.id]).toEqual([started.lane.id, undefined, 'r1'])
    expect(readLane({ ...rec(), reviewer: null, pool: true })?.pool).toBe(true)
    // A pool beside a reviewer of its own doesn't read back as one.
    expect(readLane({ ...rec(), pool: true })?.pool).toBeUndefined()
    await lanes.endLane(w, named.lane.id, { abandoned: true })
  })

  it("a builder's next loop, its last lane's cards passed but not merged: that lane ends (not abandoned), whoever registers first", async () => {
    // A list sharing no card is another loop, as with workflow rules off: with them on it edits the running lane (#1270).
    await rulesOff()
    const [p1, p2, n1, n2, m1] = [await make('P1'), await make('P2'), await make('N1'), await make('N2'), await make('M1')]
    const passed = async (...ns: number[]) => {
      for (const n of ns) await run(() => tasks.updateTask(n, { column: 'passed' }, user))
    }
    // The reviewer first: with cards, it joins only a lane that shares one, so the passed lane isn't taken over.
    const l1 = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [p1.number, p2.number], by: 'B1 (alpha)' })).lane
    await passed(p1.number, p2.number)
    const joined = await lanes.joinLane(w, { project: 'alpha', builder: 'b1', reviewer: 'b2', cards: [n1.number, n2.number], by: 'B2 (alpha)' })
    expect([joined.did, joined.lane.id === l1.id, joined.lane.reviewer?.id, joined.lane.cards.map((c) => c.number)]).toEqual(['joined', false, 'b2', [n1.number, n2.number]])
    expect(joined.replaced).toMatchObject({ id: l1.id, state: 'ended', reviewer: { id: 'r1' } })
    // The builder's start then updates that new lane.
    const mine = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [n1.number, n2.number], rounds: 4, by: 'B1 (alpha)' })
    expect([mine.did, mine.lane.id, mine.lane.reviewer?.id]).toEqual(['updated', joined.lane.id, 'b2'])
    // The builder first: its passed lane ends too; one with a card still to do is abandoned.
    await passed(n1.number, n2.number)
    const next = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [m1.number], by: 'B1 (alpha)' })
    expect([next.did, next.replaced?.id, next.replaced?.state]).toEqual(['started', joined.lane.id, 'ended'])
    // Without cards, a reviewer joins the builder's running lane, whatever its cards.
    const plain = await lanes.joinLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', by: 'R1 (alpha)' })
    expect([plain.lane.id, plain.lane.reviewer?.id]).toEqual([next.lane.id, 'r1'])
    await lanes.endLane(w, next.lane.id, { abandoned: true })
  })

  it('only its builder or reviewer ends it, among agents; the user and the Assistant may', async () => {
    // A list changed (or a lane ended) at once, as with workflow rules off: with them on, a change waits for the card boundary (#1270, tests/laneOwnership.test.ts).
    await rulesOff()
    const c = await make('E1')
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'B1 (alpha)' })).lane
    await expect(lanes.endLane(w, l.id, { project: 'alpha', agent: 'b2' })).rejects.toThrow(/builder or reviewer/)
    const ended = await lanes.endLane(w, l.id, { project: 'alpha', agent: 'b1', mergeCommit: 'abc1234' })
    expect([ended.state, ended.mergeCommit, !!ended.endedAt]).toEqual(['ended', 'abc1234', true])
    await expect(lanes.endLane(w, 'lane-none', {})).rejects.toThrow(/Unknown lane/)
  })

  it('an agent removed abandons its lanes', async () => {
    const c = await make('R1')
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c.number], by: 'B2 (alpha)' })).lane
    await lanes.laneAgentRemoved(w, 'alpha', 'r1')
    expect((await lanes.getLane(w, l.id)).state).toBe('abandoned')
  })

  it('an abandoned lane keeps its cards as it left them, while another lane works them (#512)', async () => {
    const [c1, c2] = [await make('Z1'), await make('Z2')]
    await run(() => tasks.updateTask(c1.number, { column: 'doing' }, user))
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number, c2.number], by: 'B2 (alpha)' })).lane
    const dropped = await lanes.endLane(w, l.id, { abandoned: true })
    expect(dropped.cards.map((c) => [c.number, c.column])).toEqual([[c1.number, 'doing'], [c2.number, 'todo']])
    // B1 takes the cards on in a lane of its own and moves them on.
    const next = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c1.number, c2.number], by: 'B1 (alpha)' })).lane
    await run(() => tasks.updateTask(c1.number, { column: 'review' }, user))
    await run(() => tasks.updateTask(c2.number, { column: 'doing' }, user))
    const after = await lanes.getLane(w, l.id)
    expect([after.state, after.cards.map((c) => c.column)]).toEqual(['abandoned', ['doing', 'todo']])
    expect((await lanes.getLane(w, next.id)).cards.map((c) => c.column)).toEqual(['review', 'doing'])
    // Kept in the workspace database (#1018), so it reads the same after a restart.
    const data = storeDocs<LaneRecord>(wsPath, 'lanes')
    const kept = data.find((x) => x.id === l.id)
    expect(kept?.frozen?.map((c) => c.column)).toEqual(['doing', 'todo'])
    // Without that record (a lane ended before #512, or the record damaged): not recorded, never the board's now.
    delete kept!.frozen
    await saveTable(wsPath, 'lanes', data)
    await run(() => tasks.updateTask(c1.number, { column: 'done' }, user))
    const legacy = await lanes.getLane(w, l.id)
    expect([legacy.state, legacy.current, legacy.cards.map((c) => [c.title, c.column])]).toEqual(['abandoned', null, [['Z1', 'unrecorded'], ['Z2', 'unrecorded']]])
    await lanes.endLane(w, next.id, { abandoned: true })
  })

  it('follows the board: paused while blocked, ended once every card is Done, and the window is told', async () => {
    const [c1, c2] = [await make('F1'), await make('F2')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c1.number, c2.number], by: 'B1 (alpha)' })).lane
    const told = (fn: (x: Extract<CombworkEvent, { type: 'lanes-changed' }>) => boolean) => until(() => events.some((e) => e.type === 'lanes-changed' && fn(e)), HUNG_MS)
    const mine = (e: Extract<CombworkEvent, { type: 'lanes-changed' }>) => e.lanes.find((x) => x.id === l.id)
    expect(await told((e) => mine(e)?.state === 'active')).toBe(true)
    await run(() => tasks.updateTask(c1.number, { column: 'doing', blocked: 'Asked the user' }, user))
    expect(await told((e) => mine(e)?.state === 'paused' && mine(e)?.pausedOn === c1.number)).toBe(true)
    await run(() => tasks.updateTask(c1.number, { blocked: '' }, user))
    expect(await told((e) => mine(e)?.state === 'active' && mine(e)?.current === c1.number)).toBe(true)
    await run(() => tasks.updateTask(c1.number, { column: 'done' }, user))
    await run(() => tasks.updateTask(c2.number, { column: 'done' }, user))
    expect(await told((e) => mine(e)?.state === 'ended')).toBe(true)
    expect((await lanes.getLane(w, l.id)).endedAt).not.toBeNull()
    // Ended by the board, it keeps its cards as they were (#512): a card reopened later doesn't show in it.
    await run(() => tasks.updateTask(c1.number, { column: 'doing' }, user))
    expect((await lanes.getLane(w, l.id)).cards.map((c) => c.column)).toEqual(['done', 'done'])
  })
})
