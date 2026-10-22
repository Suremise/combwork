// An agent in a card loop that ends its turn with no card watch (#376): which of its cards are still in play, and what a
// stalled card says. (The e2e loopwatch suite runs it on fake Claude Code agents: the grace, the flag, the notice.)
import { describe, expect, it } from 'vitest'
import { cardsInPlay, unwatched } from '../src/main/loopCheck'
import { providerDescriptor } from '../src/shared/providers'
import { laneOrderWait, laneOrderWaitReason, notWatchingAgent, notWatchingReason, REVIEW_WAIT_STALL_MS, reviewVerdictWaitReason, reviewWaitReason } from '../src/shared/tasks'
import type { TaskCard } from '../src/shared/types'

const card = (number: number, over: Partial<TaskCard> = {}): TaskCard => ({ number, title: `Card ${number}`, project: 'alpha', column: 'todo', agent: null, archived: false, labels: [], blockedBy: [], links: [], comments: [], history: [], ...over }) as unknown as TaskCard

describe('cards in play for a loop agent (#376)', () => {
  const board = [
    card(1, { column: 'review' }), // watched, in Review
    card(2, { column: 'doing' }), // watched, in Doing
    card(3, { column: 'passed' }), // watched, passed: its part is over
    card(4, { column: 'review', archived: true }), // watched, archived
    card(5, { column: 'review', agent: 'a1' }), // its own card in Review
    card(6, { column: 'review', review: { agent: 'a1', agentName: 'R', since: '' } as never }), // one it is reviewing
    card(7, { column: 'doing', agent: 'a1' }), // its own card in Doing: it may be asking the user, not counted
    card(8, { column: 'review', agent: 'a1', project: 'beta' }), // another project's agent with the same id
    card(9, { column: 'review', agent: 'a2' }), // someone else's
    card(10, { column: 'review', project: 'beta' }) // watched, but moved to another project
  ]
  it('the cards it last watched in Doing or Review, and those in Review it is the agent or reviewer of', () => {
    expect(cardsInPlay(board, 'Alpha', 'a1', [1, 2, 3, 4, 10])).toEqual([1, 2, 5, 6])
    expect(cardsInPlay(board, 'alpha', 'a1', [])).toEqual([5, 6])
    expect(cardsInPlay(board, 'alpha', 'a3', [9])).toEqual([9])
    expect(cardsInPlay(board, 'alpha', 'a3', [3])).toEqual([])
  })

  it("a card shows as stalled while an agent left it with no watch, only in Doing or Review", () => {
    const agents = [{ name: 'Builder', project: 'alpha' }, { name: 'R6', project: 'alpha', notWatching: [333] }]
    expect(notWatchingReason(card(333, { column: 'review' }), agents)).toBe("R6 isn't watching #333: its turn ended with no card watch.")
    expect(notWatchingReason(card(333, { column: 'doing' }), agents)).toMatch(/^R6 isn't watching #333/)
    expect(notWatchingReason(card(333, { column: 'passed' }), agents)).toBeNull()
    expect(notWatchingReason(card(333, { column: 'review', archived: true }), agents)).toBeNull()
    expect(notWatchingReason(card(334, { column: 'review' }), agents)).toBeNull()
    // Moved to another project: its old project's agent isn't on it any more.
    expect(notWatchingReason(card(333, { column: 'review', project: 'beta' }), agents)).toBeNull()
  })

  it("an agent that did watch, whose wake waits untaken in its prompt, is stalled for that, not for ending its turn without a watch (#777)", () => {
    const agents = [{ name: 'AMR3', project: 'alpha', notWatching: [779], untaken: true }]
    expect(notWatchingReason(card(779, { column: 'review' }), agents)).toBe("AMR3 hasn't taken the wake Hive typed for #779: it waits in its prompt.")
    expect(notWatchingAgent(card(779, { column: 'review' }), agents)?.untaken).toBe(true)
    expect(notWatchingReason(card(779, { column: 'passed' }), agents)).toBeNull()
  })

  it("an agent whose turn ended with background tasks running is not flagged where they wake it; where they don't (Codex), it is (#521)", () => {
    expect(unwatched({ provider: 'claude-code', status: 'finished' })).toBe(true)
    expect(unwatched({ provider: 'claude-code', status: 'ready' })).toBe(true)
    expect(unwatched({ provider: 'claude-code', status: 'finished', backgroundTasks: 1 })).toBe(false)
    expect(unwatched({ provider: 'claude-code', status: 'background', backgroundTasks: 1 })).toBe(false)
    // Codex tracks tasks but isn't woken when they end: nothing will wake it.
    expect(providerDescriptor('codex').capabilities.backgroundWakes).toBe(false)
    expect(unwatched({ provider: 'codex', status: 'finished', backgroundTasks: 1 })).toBe(true)
    expect(unwatched({ provider: 'claude-code', status: 'watching', watch: { cards: [1], changes: ['column'], label: '', since: '', limitAt: '' } })).toBe(false)
    expect(unwatched(null)).toBe(false)
  })
})

describe('a card in Review its watching reviewer has not started on (#521)', () => {
  const t0 = Date.parse('2026-10-10T07:39:57.143Z')
  const inReview = (over: Partial<TaskCard> = {}) => card(506, { column: 'review', agent: 'b2', history: [{ at: '2026-10-10T07:39:57.143Z', by: 'HB2 (alpha)', what: 'Moved to Review' }], ...over })
  const watchers = [{ name: 'HR2', project: 'alpha', agentId: 'r2', cards: [506, 509] }]
  it('stalled once it has waited the limit while an agent other than its own watches it', () => {
    expect(reviewWaitReason(inReview(), watchers, t0 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(reviewWaitReason(inReview(), watchers, t0 + REVIEW_WAIT_STALL_MS)).toBe("HR2 is watching #506 but hasn't started reviewing it: in Review for 15 min.")
    expect(reviewWaitReason(inReview(), watchers, t0 + 5 * 3600_000 + 5 * 60_000)).toBe("HR2 is watching #506 but hasn't started reviewing it: in Review for 5 h 5 min.")
    // Returned for review counts as coming into it.
    expect(reviewWaitReason(inReview({ history: [{ at: '2026-10-10T07:39:57.143Z', by: 'HB2 (alpha)', what: 'Returned for review, round 2' }] }), watchers, t0 + REVIEW_WAIT_STALL_MS)).toMatch(/^HR2 is watching #506/)
  })
  it('names the reviewer\'s real state: working on something else, or silent with its state unknown (#642, #648)', () => {
    const at = t0 + 37 * 60_000
    expect(reviewWaitReason(inReview(), [{ ...watchers[0], status: 'watching' }], at)).toBe("HR2 is watching #506 but hasn't started reviewing it: in Review for 37 min.")
    expect(reviewWaitReason(inReview(), [{ ...watchers[0], status: 'working' }], at)).toBe("HR2 is watching #506 but hasn't started reviewing it (it is working on something else): in Review for 37 min.")
    expect(reviewWaitReason(inReview(), [{ ...watchers[0], status: 'working', silentMinutes: 23 }], at)).toBe("HR2 is watching #506 but hasn't started reviewing it (it shows working, but has been silent for 23 min: state unknown): in Review for 37 min.")
  })
  it("not while it is reviewed, blocked, elsewhere, archived, watched by none or only by its own agent, or another project's", () => {
    const late = t0 + 3600_000
    expect(reviewWaitReason(inReview({ review: { agent: 'r2', agentName: 'HR2', since: '' } as never }), watchers, late)).toBeNull()
    expect(reviewWaitReason(inReview({ blocked: 'Asked the user' }), watchers, late)).toBeNull()
    expect(reviewWaitReason(inReview({ column: 'doing' }), watchers, late)).toBeNull()
    expect(reviewWaitReason(inReview({ archived: true }), watchers, late)).toBeNull()
    expect(reviewWaitReason(inReview(), [], late)).toBeNull()
    expect(reviewWaitReason(inReview(), [{ name: 'HB2', project: 'alpha', agentId: 'b2', cards: [506] }], late)).toBeNull()
    expect(reviewWaitReason(inReview(), [{ ...watchers[0], project: 'beta' }], late)).toBeNull()
    expect(reviewWaitReason(inReview({ history: [] }), watchers, late)).toBeNull()
  })
  it('not for a round already reviewed: a failed card waiting in Review for its fixes; its next return can stall again (round 1 finding)', () => {
    const h = (s: number, by: string, what: string) => ({ at: new Date(t0 + s * 1000).toISOString(), by, what })
    const failed = [h(0, 'HB2 (alpha)', 'Moved to Review'), h(1, 'HR2 (alpha)', 'Started reviewing'), h(2, 'HR2 (alpha)', 'Review failed')]
    expect(reviewWaitReason(inReview({ history: failed }), watchers, t0 + 3600_000)).toBeNull()
    expect(reviewWaitReason(inReview({ history: failed.slice(0, 2) }), watchers, t0 + 3600_000)).toBeNull()
    // Returned for review (round 2) and nobody starts on it: stalled once it has waited the limit.
    const back = [...failed, h(600, 'HB2 (alpha)', 'Returned for review, round 2')]
    expect(reviewWaitReason(inReview({ history: back }), watchers, t0 + 600_000 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(reviewWaitReason(inReview({ history: back }), watchers, t0 + 600_000 + REVIEW_WAIT_STALL_MS)).toBe("HR2 is watching #506 but hasn't started reviewing it: in Review for 15 min.")
  })
})

describe('a card in Review whose reviewer started, gave no verdict and only watches it (#843)', () => {
  const t0 = Date.parse('2026-10-14T15:00:00.000Z')
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const started = (over: Partial<TaskCard> = {}) => card(805, { column: 'review', agent: 'b3', review: { agent: 'r3', agentName: 'HR3', since: at(0) }, ...over })
  // HR3 asked the user in a comment two minutes in (a turn of its own), then went back to watching the card.
  const watching = [{ name: 'HR3', project: 'alpha', agentId: 'r3', cards: [805], status: 'watching', watchSince: at(2) }]
  it('stalled once it has only watched it for the limit, from the later of its review starting and its watch', () => {
    expect(reviewVerdictWaitReason(started(), watching, t0 + 2 * 60_000 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(reviewVerdictWaitReason(started(), watching, t0 + 2 * 60_000 + REVIEW_WAIT_STALL_MS)).toBe('HR3 started reviewing #805 but has given no verdict, and has only been watching it for 15 min.')
    expect(reviewVerdictWaitReason(started(), watching, t0 + 77 * 60_000)).toBe('HR3 started reviewing #805 but has given no verdict, and has only been watching it for 1 h 15 min.')
    // A watch from before its review started counts from the review; one with no time known, from the review too.
    expect(reviewVerdictWaitReason(started(), [{ ...watching[0], watchSince: at(-30) }], t0 + REVIEW_WAIT_STALL_MS)).toMatch(/only been watching it for 15 min\.$/)
    expect(reviewVerdictWaitReason(started(), [{ ...watching[0], watchSince: undefined }], t0 + REVIEW_WAIT_STALL_MS)).toMatch(/^HR3 started reviewing #805/)
  })
  it('not while its reviewer works (or its state is unknown), nor once it is blocked with a question or has its verdict', () => {
    const late = t0 + 3600_000
    // Working on it (a long test run), or on something else with the watch still set.
    expect(reviewVerdictWaitReason(started(), [{ ...watching[0], status: 'working' }], late)).toBeNull()
    // Shows working but silent: its state is unknown (#648), not known to be only watching.
    expect(reviewVerdictWaitReason(started(), [{ ...watching[0], status: 'working', silentMinutes: 40 } as never], late)).toBeNull()
    // Waiting for the user (a permission prompt) isn't watching the card.
    expect(reviewVerdictWaitReason(started(), [{ ...watching[0], status: 'waiting' }], late)).toBeNull()
    // It asked the user the way #840 says: the card is blocked with its question.
    expect(reviewVerdictWaitReason(started({ blocked: 'Should the notice name the branch?' }), watching, late)).toBeNull()
    // Its verdict ends its review (the card keeps no review): a failed round waiting for its builder isn't stalled on it.
    expect(reviewVerdictWaitReason(started({ review: undefined }), watching, late)).toBeNull()
  })
  it('only its own reviewer watching it counts, in its project, on a card still in Review', () => {
    const late = t0 + 3600_000
    expect(reviewVerdictWaitReason(started(), [{ ...watching[0], agentId: 'r1', name: 'HR1' }], late)).toBeNull()
    expect(reviewVerdictWaitReason(started(), [{ ...watching[0], cards: [806] }], late)).toBeNull()
    expect(reviewVerdictWaitReason(started(), [{ ...watching[0], project: 'beta' }], late)).toBeNull()
    expect(reviewVerdictWaitReason(started({ column: 'passed' }), watching, late)).toBeNull()
    expect(reviewVerdictWaitReason(started({ archived: true }), watching, late)).toBeNull()
    expect(reviewVerdictWaitReason(started(), [], late)).toBeNull()
    // The other review stall (#521) is for a review not started: the two never both apply.
    expect(reviewWaitReason(started({ history: [{ at: at(-1), by: 'HB3 (alpha)', what: 'Moved to Review' }] }), watching, late)).toBeNull()
  })
})

describe("a lane's deadlock: its reviewer waits for one card while its builder waits on another's review (#1410)", () => {
  // 22 Oct: HB2 sent #1364 to Review ahead of #1344 (Todo); HR2 kept the lane's order and watched #1344; HB2 watched #1364.
  const t0 = Date.parse('2026-10-22T02:08:07.437Z')
  const sent = (over: Partial<TaskCard> = {}) => card(1364, { column: 'review', agent: 'b2', history: [{ at: '2026-10-22T02:08:07.437Z', by: 'HB2 (alpha)', what: 'Moved to Review' }], ...over })
  const lane = { builder: 'b2', reviewer: 'r2', cards: [{ number: 1384, column: 'passed' }, { number: 1344, column: 'todo' }, { number: 1364, column: 'review' }] }
  const hr2 = { name: 'HR2', project: 'alpha', agentId: 'r2', cards: [1344], status: 'watching' }
  const hb2 = { name: 'HB2', project: 'alpha', agentId: 'b2', cards: [1364], status: 'watching' }
  it('stalled once the card has waited the limit, naming the card the reviewer waits for', () => {
    expect(laneOrderWaitReason(sent(), lane, [hr2, hb2], t0 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [hr2, hb2], t0 + REVIEW_WAIT_STALL_MS)).toBe('HR2 is waiting for #1344, not #1364, while HB2 waits on the review of #1364: each waits on the other. In Review for 15 min.')
    expect(laneOrderWaitReason(sent(), lane, [hr2, hb2], t0 + 5 * 3600_000)).toMatch(/In Review for 5 h\.$/)
    // The reviewer watching both: it waits for the one still to come, not the one it passed.
    expect(laneOrderWait(sent(), lane, [{ ...hr2, cards: [1384, 1344] }, hb2], t0 + 3600_000)?.waitsFor.number).toBe(1344)
  })
  it('not while the reviewer watches the card, works, or only watches cards in Review; nor without the builder\'s watch, a lane, or a review not yet due', () => {
    const late = t0 + 3600_000
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, cards: [1344, 1364] }, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, status: 'working' }, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), { ...lane, cards: [...lane.cards.slice(0, 1), { number: 1344, column: 'review' }, lane.cards[2]] }, [hr2, hb2], late)).toBeNull()
    // The builder at work on the card the reviewer waits for: no deadlock.
    expect(laneOrderWaitReason(sent(), lane, [hr2, { ...hb2, cards: [1344] }], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [hr2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), null, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), { ...lane, reviewer: null }, [hr2, hb2], late)).toBeNull()
    // Reviewed, blocked, archived, in another column, or another project's agents.
    expect(laneOrderWaitReason(sent({ review: { agent: 'r2', agentName: 'HR2', since: '' } as never }), lane, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent({ blocked: 'Asked the user' }), lane, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent({ archived: true }), lane, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent({ column: 'doing' }), lane, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, project: 'beta' }, hb2], late)).toBeNull()
  })
})
