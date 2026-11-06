// An agent in a card loop that ends its turn with no card watch (#376): which of its cards are still in play, and what a
// stalled card says. (The e2e loopwatch suite runs it on fake Claude Code agents: the grace, the flag, the notice.)
import { describe, expect, it } from 'vitest'
import { cardsInPlay, othersCards, owedCards, unwatched } from '../src/main/loopCheck'
import { providerDescriptor } from '../src/shared/providers'
import { backgroundTaskMinutes, builderJobOf, laneOrderWait, laneOrderWaitReason, LOOP_STEP_STALL_GRACE_MS, loopStepWait, loopStepWaitReason, notWatchingAgent, pendingDesign, pendingStep, notWatchingReason, REVIEW_WAIT_STALL_MS, reviewVerdictWaitReason, reviewWaitReason, reviewWaiter, laneReviewOwed } from '../src/shared/tasks'
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
    expect(notWatchingReason(card(779, { column: 'review' }), agents)).toBe("AMR3 hasn't taken the wake Combwork typed for #779: it waits in its prompt.")
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

describe("another's card isn't the watcher's loop: a card's stall is its own builder's and reviewer's (HI-2381)", () => {
  // CB2's next card 10 waits on CB1's card 8 (in Doing, CR1 reviewing its design); CB2 watched both.
  const board = [card(8, { column: 'doing', agent: 'cb1' }), card(10, { column: 'todo', blockedBy: [8] }), card(12, { column: 'doing', agent: 'cb1' })]
  const none = (): null => null
  const cr1 = (n: number): string | null => (n === 8 ? 'cr1' : null)
  it("drops another builder's card with another reviewer, whatever else the watch names", () => {
    expect(othersCards(board, 'cb2', [8, 10], cr1)).toEqual([8])
    // The blocker alone, or its dependent card taken out of the watch (HR1, round 1): still CB1's and CR1's.
    expect(othersCards(board, 'cb2', [8], cr1)).toEqual([8])
    // The review on it names its reviewer too (a pool card in Review, say).
    expect(othersCards([card(8, { column: 'review', agent: 'cb1', review: { agent: 'cr1' } as never })], 'cb2', [8], none)).toEqual([8])
  })
  it('with no reviewer known, drops it too: only its builder and reviewer owe it (the Assistant, after HR1 round 2)', () => {
    // The blocker alone in a lane whose reviewer was removed (HR1's case), with or without its dependent card.
    expect(othersCards(board, 'cb2', [8], none)).toEqual([8])
    expect(othersCards(board, 'cb2', [8, 10], none)).toEqual([8])
    // A card nothing watched waits on, and one with no builder: the same.
    expect(othersCards(board, 'cb2', [12], none)).toEqual([12])
    expect(othersCards([card(9, { column: 'review' })], 'cb2', [9], none)).toEqual([9])
  })
  it('keeps its own builder and reviewer in the loop, and cards out of play', () => {
    expect(othersCards(board, 'cb1', [8, 10], cr1)).toEqual([])
    expect(othersCards(board, 'cr1', [8, 10], cr1)).toEqual([])
    expect(othersCards([card(8, { column: 'review', agent: 'cb1', review: { agent: 'cr1' } as never }), card(10, { blockedBy: [8] })], 'cr1', [8, 10], none)).toEqual([])
    expect(othersCards([card(8, { column: 'passed', agent: 'cb1' })], 'cb2', [8], cr1)).toEqual([])
    // Not watched: not its to drop.
    expect(othersCards(board, 'cb2', [10], cr1)).toEqual([])
    // Without the drop, card 8 was owed by CB2, and stalled with its name on it.
    expect(owedCards(board, 'alpha', 'cb2', [8, 10], { wakes: true, reviewerOf: () => 'cr1' })).toEqual([8])
  })
})

describe("what a loop agent with no watch owes, while Combwork's loop wakes reach it (HI-1693)", () => {
  const h = (what: string) => ({ at: '2026-10-26T11:00:00.000Z', by: 'HB1 (alpha)', what })
  const reach = { wakes: true, reviewerOf: () => 'r1' }
  const own = (over: Partial<TaskCard>) => card(1, { agent: 'b1', ...over })
  it("the other side's move isn't owed: a builder's card in Review or with its design waiting, a reviewer's card in Doing", () => {
    expect(owedCards([own({ column: 'review', history: [h('Moved to Review')] })], 'alpha', 'b1', [1], reach)).toEqual([])
    expect(owedCards([own({ column: 'doing', history: [h('Moved to Doing'), h('Posted a design for the reviewer to check: "Plan"')] })], 'alpha', 'b1', [1], reach)).toEqual([])
    expect(owedCards([own({ column: 'doing' })], 'alpha', 'r1', [1], reach)).toEqual([])
  })
  it('its own move is: a builder on its card in Doing, or failed and left in Review; a reviewer with a step to answer, or on a card in Review', () => {
    expect(owedCards([own({ column: 'doing' })], 'alpha', 'b1', [1], reach)).toEqual([1])
    expect(owedCards([own({ column: 'review', history: [h('Moved to Review'), h('Started reviewing'), h('Review failed')] })], 'alpha', 'b1', [1], reach)).toEqual([1])
    expect(owedCards([own({ column: 'doing', history: [h('Moved to Doing'), h('Posted a design for the reviewer to check: "Plan"')] })], 'alpha', 'r1', [1], reach)).toEqual([1])
    expect(owedCards([own({ column: 'review', history: [h('Moved to Review')] })], 'alpha', 'r1', [1], reach)).toEqual([1])
  })
  it("a builder asked something mid-review owes the answer until it has given one (a line or a comment of its own since)", () => {
    const asked = [h('Moved to Review'), { ...h('Asked the builder: "Which commit should I review?"'), by: 'R1 (alpha)' }]
    expect(owedCards([own({ column: 'review', agentName: 'B1', history: asked })], 'alpha', 'b1', [1], reach)).toEqual([1])
    const answered = { at: '2026-10-26T11:00:01.000Z', by: 'B1 (alpha)', text: 'The latest: 1a2b3c4.' }
    expect(owedCards([own({ column: 'review', agentName: 'B1', history: asked, comments: [answered] as never })], 'alpha', 'b1', [1], reach)).toEqual([])
    // A request from before the card came back for review is that round's: answered or not, the verdict waits now.
    expect(owedCards([own({ column: 'review', agentName: 'B1', history: [...asked, h('Returned for review, round 2')] })], 'alpha', 'b1', [1], reach)).toEqual([])
  })
  // HI-2080: HB5 asked Darren on HI-2068 and ended its turn; "isn't watching" fired over "waiting for the user".
  it('a card with an open For you request of its own (asked of the user) is the user\'s move: not owed, wherever it is; once closed, owed as before', () => {
    const asked = (n: number) => n === 1
    for (const c of [own({ column: 'doing' }), own({ column: 'review', history: [h('Moved to Review')] })]) {
      expect(owedCards([c], 'alpha', 'b1', [1], { ...reach, asked })).toEqual([])
      expect(owedCards([c], 'alpha', 'r1', [1], { ...reach, asked })).toEqual([])
      // Even with no reviewer: the user's answer wakes the one that asked, in or out of a loop.
      expect(owedCards([c], 'alpha', 'b1', [1], { wakes: true, reviewerOf: () => null, asked })).toEqual([])
    }
    // Answered or closed (none open): its own move again.
    expect(owedCards([own({ column: 'doing' })], 'alpha', 'b1', [1], { ...reach, asked: () => false })).toEqual([1])
    // With loop wakes off the answer wakes nobody, so it is owed as before.
    expect(owedCards([own({ column: 'doing' })], 'alpha', 'b1', [1], { ...reach, wakes: false, asked })).toEqual([1])
  })

  it('everything is owed where no loop wake reaches it: none can (loop wakes off, no inbox), or the card has no reviewer', () => {
    const inReview = [own({ column: 'review', history: [h('Moved to Review')] })]
    expect(owedCards(inReview, 'alpha', 'b1', [1], { ...reach, wakes: false })).toEqual([1])
    expect(owedCards(inReview, 'alpha', 'b1', [1], { wakes: true, reviewerOf: () => null })).toEqual([1])
  })

  // HI-2321 (seen on HI-2320): HR1 checked design s10, the pool gave its revision s19 to HR2, and HR1 was flagged.
  it("a pool card is owed only by its builder and the reviewer the pool has for it now: an earlier step's reviewer is out of its loop", () => {
    const pool = () => true
    const revision = [h('Moved to Doing'), h('Posted a design for the reviewer to check: "Plan"'), { ...h('Design has gaps: "More"'), by: 'HR1 (alpha)' }, h('Posted a design for the reviewer to check: "Plan, revised"')]
    const toHr2 = { wakes: true, reviewerOf: () => 'r2', pool }
    // The revision is HR2's to check: HR2 owes it, HR1 (who watched the card for s10) owes nothing.
    expect(owedCards([own({ column: 'doing', history: revision })], 'alpha', 'r2', [1], toHr2)).toEqual([1])
    expect(owedCards([own({ column: 'doing', history: revision })], 'alpha', 'r1', [1], toHr2)).toEqual([])
    // Checked, or no reviewer given it yet: still nothing of HR1's, loop wakes or not; its builder's own move stays its.
    expect(owedCards([own({ column: 'doing' })], 'alpha', 'r1', [1], { wakes: true, reviewerOf: () => null, pool })).toEqual([])
    expect(owedCards([own({ column: 'review', history: [h('Moved to Review')] })], 'alpha', 'r1', [1], { ...toHr2, wakes: false })).toEqual([])
    expect(owedCards([own({ column: 'doing' })], 'alpha', 'b1', [1], { wakes: true, reviewerOf: () => null, pool })).toEqual([1])
    // The pool's reviewer now still owes its move: a card in Review it hasn't given a verdict on, a design given to it.
    expect(owedCards([own({ column: 'review', history: [h('Moved to Review')] })], 'alpha', 'r2', [1], toHr2)).toEqual([1])
    expect(owedCards([own({ column: 'review', history: [h('Moved to Review')] })], 'alpha', 'r2', [1], { ...toHr2, wakes: false })).toEqual([1])
    // Outside the pool, a card's other watchers are flagged as before.
    expect(owedCards([own({ column: 'doing', history: revision })], 'alpha', 'r1', [1], { ...toHr2, pool: () => false })).toEqual([1])
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
  describe('names the agent that owes the review, never a builder only watching it (HI-2636)', () => {
    // HB1, another lane's builder, watches the card for Done; HR3 is the pool's reviewer given it, idle, with no watch.
    const hb1 = { name: 'HB1', project: 'alpha', agentId: 'b1', cards: [506], status: 'watching' }
    const hr3 = { name: 'HR3', project: 'alpha', agentId: 'r3', cards: [506], status: 'watching' }
    const at = t0 + 20 * 60_000
    const given = { agentId: 'r3', name: 'HR3', givenAt: new Date(t0 + 2 * 60_000).toISOString(), status: 'finished' }
    it('a pool card: its given reviewer, watching or not, said as given', () => {
      expect(reviewWaitReason(inReview(), [hb1], at, undefined, given)).toBe("#506 was given to HR3 to review 18 min ago, and it hasn't started reviewing it: in Review for 20 min.")
      expect(reviewWaitReason(inReview(), [hb1, hr3], at, undefined, given)).toBe("#506 was given to HR3 to review 18 min ago, and it hasn't started reviewing it: in Review for 20 min.")
      expect(reviewWaitReason(inReview(), [hb1], at, undefined, { ...given, status: 'working' })).toBe("#506 was given to HR3 to review 18 min ago, and it hasn't started reviewing it (it is working on something else): in Review for 20 min.")
      // Given only just now (every reviewer was busy): its own wait first.
      expect(reviewWaitReason(inReview(), [hb1], at, undefined, { ...given, givenAt: new Date(at - 60_000).toISOString() })).toBeNull()
    })
    it('a pool card nobody was given yet: no stall, whoever watches it', () => {
      expect(reviewWaitReason(inReview(), [hb1, hr3], at, undefined, null)).toBeNull()
    })
    it("a lane's reviewer: only it, when it watches", () => {
      const lane = { agentId: 'r3', name: 'HR3' }
      expect(reviewWaitReason(inReview(), [hb1], at, undefined, lane)).toBeNull()
      expect(reviewWaitReason(inReview(), [hb1, hr3], at, undefined, lane)).toBe("HR3 is watching #506 but hasn't started reviewing it: in Review for 20 min.")
    })
    it("a pool card given to HR3, another reviewer (HR2) only watching it: HR3, never HR2 (HR1's round 1)", () => {
      const hr2 = { name: 'HR2', project: 'alpha', agentId: 'r2', cards: [506], status: 'watching' }
      // Main's check: HR3 given it, said so; HR2's watch counts for nothing.
      expect(reviewWaitReason(inReview(), [hr2], at, undefined, given)).toBe("#506 was given to HR3 to review 18 min ago, and it hasn't started reviewing it: in Review for 20 min.")
      expect(reviewWaiter(inReview(), [hr2], given)).toBeNull()
      // The window's (laneReviewOwed from its pool lane): HR3 when it watches, nobody otherwise, never HR2.
      const agents = [{ id: 'b1', name: 'HB1' }, { id: 'r2', name: 'HR2' }, { id: 'r3', name: 'HR3' }]
      const pool = (name: string | null, current: number | null = 506) => ({ builder: 'b2', reviewer: null, poolReviewing: { card: current, name }, cards: [{ number: 506, column: 'review' }] })
      const board = (lane: ReturnType<typeof pool>) => reviewWaitReason(inReview(), [hr2, hb1], at, (m: never, v: Record<string, unknown>) => `${(m as { id: string }).id}:${v.agent}`, laneReviewOwed(inReview(), lane, agents, true))
      expect(laneReviewOwed(inReview(), pool('HR3'), agents, true)).toEqual({ agentId: 'r3', name: 'HR3' })
      expect(board(pool('HR3'))).toBeNull()
      expect(reviewWaitReason(inReview(), [hr2, hr3], at, (m: never, v: Record<string, unknown>) => `${(m as { id: string }).id}:${v.agent}`, laneReviewOwed(inReview(), pool('HR3'), agents, true))).toBe('board.stalled.reviewWait:HR3')
      // Not given out yet, or its current card another: nobody.
      expect(laneReviewOwed(inReview(), pool(null), agents, true)).toBeNull()
      expect(laneReviewOwed(inReview(), pool('HR3', 507), agents, true)).toBeNull()
      expect(board(pool(null))).toBeNull()
      // In no lane: nobody with the rules on (the pool gives it out); a watcher that reviews with them off.
      expect(laneReviewOwed(inReview(), null, agents, true)).toBeNull()
      expect(laneReviewOwed(inReview(), null, agents, false)).toBeUndefined()
      // A lane's own reviewer, as long as it is one of the project's agents.
      expect(laneReviewOwed(inReview(), { builder: 'b2', reviewer: 'r3', cards: [] }, agents, true)).toEqual({ agentId: 'r3', name: 'HR3' })
      expect(laneReviewOwed(inReview(), { builder: 'b2', reviewer: 'gone', cards: [] }, agents, true)).toBeNull()
    })
    it('nobody known to owe it: a watcher that may review, never a builder', () => {
      const reviews = (id: string): boolean => id.startsWith('r')
      expect(reviewWaitReason(inReview(), [hb1], at, undefined, undefined, reviews)).toBeNull()
      expect(reviewWaitReason(inReview(), [hb1, hr3], at, undefined, undefined, reviews)).toBe("HR3 is watching #506 but hasn't started reviewing it: in Review for 20 min.")
      expect(reviewWaiter(inReview(), [hb1, hr3], undefined, reviews)?.name).toBe('HR3')
    })
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

describe("a started review waiting on its builder's background job for the card (HI-1993)", () => {
  const t0 = Date.parse('2026-10-28T15:00:00.000Z')
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const ms = (min: number) => t0 + min * 60_000
  const limit = 60 * 60_000
  const started = (over: Partial<TaskCard> = {}) => card(191, { column: 'review', agent: 'b1', review: { agent: 'r1', agentName: 'LR1', since: at(0) }, ...over })
  // LR1 asked for a 50-run stress proof two minutes in, and went back to watching the card for it.
  const watching = [{ name: 'LR1', project: 'alpha', agentId: 'r1', cards: [191], status: 'watching', watchSince: at(2) }]
  const run = (over: Record<string, unknown> = {}) => ({ agentId: 'b1', projectPath: 'D:\\work\\alpha', card: 191, state: 'running' as const, staleReason: null, startedAt: ms(3), finishedAt: null, ...over })
  const stall = (job: ReturnType<typeof builderJobOf>, now: number) => reviewVerdictWaitReason(started(), watching, now, undefined, job)

  it("no stall while the builder's run for the card goes, or its background tasks do", () => {
    // A Progress run of the builder's for the card: running, or quiet with its process still there.
    expect(stall(builderJobOf(started(), [run()], null, limit, ms(50)), ms(50))).toBeNull()
    expect(stall(builderJobOf(started(), [run({ state: 'stale', staleReason: 'quiet' })], null, limit, ms(50)), ms(50))).toBeNull()
    // Its CLI's background tasks (a background shell or a Monitor), with no run.
    expect(stall(builderJobOf(started(), [], { backgroundTasks: 1 }, limit, ms(50)), ms(50))).toBeNull()
  })

  it("once the job ends with no verdict: a stall, its clock from the job's end", () => {
    const ended = [run({ state: 'passed', finishedAt: ms(40) })]
    expect(stall(builderJobOf(started(), ended, null, limit, ms(54)), ms(54))).toBeNull()
    expect(stall(builderJobOf(started(), ended, null, limit, ms(55)), ms(55))).toBe('LR1 started reviewing #191 but has given no verdict, and has only been watching it for 15 min.')
    // Background tasks that ended: from when they did.
    const tasks = { backgroundTasks: 0, backgroundEndedAt: at(30) }
    expect(stall(builderJobOf(started(), [], tasks, limit, ms(44)), ms(44))).toBeNull()
    expect(stall(builderJobOf(started(), [], tasks, limit, ms(45)), ms(45))).toMatch(/^LR1 started reviewing #191 but has given no verdict/)
    // A run that never ends counts only to the background task limit from its start: then it is taken as ended.
    expect(builderJobOf(started(), [run()], null, limit, ms(63) - 1)).toEqual({ running: true, endedAt: null })
    expect(builderJobOf(started(), [run()], null, limit, ms(63))).toEqual({ running: false, endedAt: ms(63) })
    expect(stall(builderJobOf(started(), [run()], null, limit, ms(78)), ms(78))).toMatch(/watching it for 15 min\.$/)
    // A run its agent stopped before it finished isn't going.
    expect(stall(builderJobOf(started(), [run({ state: 'stale', staleReason: 'agent-stopped' })], null, limit, ms(30)), ms(30))).toMatch(/^LR1 started reviewing/)
  })

  it('no job at all: a stall, as before', () => {
    expect(builderJobOf(started(), [], null, limit, ms(30))).toBeNull()
    expect(stall(null, ms(30))).toBe(reviewVerdictWaitReason(started(), watching, ms(30)))
    expect(stall(null, ms(30))).toMatch(/watching it for 28 min\.$/)
    // Runs that aren't the builder's for this card, in its project, are none of its job.
    const others = [run({ agentId: 'r1' }), run({ card: 192 }), run({ projectPath: 'D:\\work\\beta' }), run({ projectPath: null })]
    expect(builderJobOf(started(), others, null, limit, ms(30))).toBeNull()
    expect(builderJobOf(started({ agent: null }), [run()], { backgroundTasks: 2 }, limit, ms(30))).toBeNull()
  })

  it('the background task limit as Settings keeps it', () => {
    expect([backgroundTaskMinutes(60), backgroundTaskMinutes(5), backgroundTaskMinutes(900), backgroundTaskMinutes(undefined)]).toEqual([60, 10, 480, 60])
  })
})

describe("a lane's deadlock: its reviewer waits for an earlier card while its builder waits on a later one's review (#1410)", () => {
  // 22 Oct: HB2 sent #1364 to Review ahead of #1344 (Todo); HR2 kept the lane's order and watched #1344; HB2 watched #1364.
  const t0 = Date.parse('2026-10-22T02:08:07.437Z')
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const sent = (over: Partial<TaskCard> = {}) => card(1364, { column: 'review', agent: 'b2', history: [{ at: at(0), by: 'HB2 (alpha)', what: 'Moved to Review' }], ...over })
  const lane = { builder: 'b2', reviewer: 'r2', cards: [{ number: 1384, column: 'passed', movedAt: at(-60) }, { number: 1344, column: 'todo', movedAt: at(-300) }, { number: 1364, column: 'review', movedAt: at(0) }, { number: 1390, column: 'todo', movedAt: at(-300) }] }
  const hr2 = { name: 'HR2', project: 'alpha', agentId: 'r2', cards: [1344], status: 'watching', watchSince: at(0) }
  const hb2 = { name: 'HB2', project: 'alpha', agentId: 'b2', cards: [1364], status: 'watching', watchSince: at(0) }
  it('stalled once the mutual wait has held for the limit, naming the earlier card the reviewer waits for', () => {
    expect(laneOrderWaitReason(sent(), lane, [hr2, hb2], t0 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [hr2, hb2], t0 + REVIEW_WAIT_STALL_MS)).toBe('HR2 is waiting for #1344, before #1364 in the lane, while HB2 waits on the review of #1364: each has waited on the other for 15 min.')
    expect(laneOrderWaitReason(sent(), lane, [hr2, hb2], t0 + 5 * 3600_000)).toMatch(/for 5 h\.$/)
    // The reviewer watching both: it waits for the one still to come, not the one it passed.
    expect(laneOrderWait(sent(), lane, [{ ...hr2, cards: [1384, 1344] }, hb2], t0 + 3600_000)?.waitsFor.number).toBe(1344)
  })
  it('counts from the latest of the arrival in Review, the earlier card\'s last move and both watches (round 1: HR6\'s design review)', () => {
    // A card in Review for an hour, its reviewer's watch on the earlier card started a minute ago: not yet.
    const fresh = { ...hr2, watchSince: at(59) }
    expect(laneOrderWaitReason(sent(), lane, [fresh, hb2], t0 + 60 * 60_000)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [fresh, hb2], t0 + 59 * 60_000 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [fresh, hb2], t0 + 59 * 60_000 + REVIEW_WAIT_STALL_MS)).toMatch(/for 15 min\.$/)
    // The builder's replacement watch the same way.
    expect(laneOrderWaitReason(sent(), lane, [hr2, { ...hb2, watchSince: at(50) }], t0 + 60 * 60_000)).toBeNull()
    // The earlier card moved (back to Todo) five minutes ago: counted from then.
    const moved = { ...lane, cards: [lane.cards[0], { ...lane.cards[1], movedAt: at(55) }, lane.cards[2], lane.cards[3]] }
    expect(laneOrderWaitReason(sent(), moved, [hr2, hb2], t0 + 60 * 60_000)).toBeNull()
    expect(laneOrderWaitReason(sent(), moved, [hr2, hb2], t0 + 55 * 60_000 + REVIEW_WAIT_STALL_MS)).toMatch(/for 15 min\.$/)
    // Returned for review later: counted from its return.
    const back = sent({ history: [{ at: at(0), by: 'HB2 (alpha)', what: 'Moved to Review' }, { at: at(1), by: 'HR2 (alpha)', what: 'Started reviewing' }, { at: at(2), by: 'HR2 (alpha)', what: 'Review failed' }, { at: at(40), by: 'HB2 (alpha)', what: 'Returned for review, round 2' }] })
    expect(laneOrderWaitReason(back, lane, [hr2, hb2], t0 + 50 * 60_000)).toBeNull()
    expect(laneOrderWaitReason(back, lane, [hr2, hb2], t0 + 40 * 60_000 + REVIEW_WAIT_STALL_MS)).toMatch(/for 15 min\.$/)
    // A time not known (a watch's start, the earlier card's last move) never makes it look old: not flagged.
    const day = t0 + 24 * 3600_000
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, watchSince: undefined }, hb2], day)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [hr2, { ...hb2, watchSince: 'not a time' }], day)).toBeNull()
    expect(laneOrderWaitReason(sent(), { ...lane, cards: [lane.cards[0], { ...lane.cards[1], movedAt: null }, lane.cards[2], lane.cards[3]] }, [hr2, hb2], day)).toBeNull()
  })
  it('only for a card the reviewer waits for that comes before it in the lane, with both agents only watching', () => {
    const late = t0 + 3600_000
    // A later card of the lane, or one not in it: no deadlock (the reviewer is ahead of the builder, or elsewhere).
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, cards: [1390] }, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, cards: [77] }, hb2], late)).toBeNull()
    // Either side at work (or its state unknown): it may be about to move.
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, status: 'working' }, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [hr2, { ...hb2, status: 'working' }], late)).toBeNull()
    // Other agents with the same watches don't stand in for the lane's builder and reviewer, nor another project's.
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, agentId: 'r9' }, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [hr2, { ...hb2, agentId: 'b9' }], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, project: 'beta' }, hb2], late)).toBeNull()
  })
  it('gone once either side resumes or the watches align; not while reviewed, blocked, elsewhere or without a lane', () => {
    const late = t0 + 3600_000
    expect(laneOrderWaitReason(sent(), lane, [{ ...hr2, cards: [1344, 1364] }, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), { ...lane, cards: [lane.cards[0], { number: 1344, column: 'review', movedAt: at(1) }, lane.cards[2], lane.cards[3]] }, [hr2, hb2], late)).toBeNull()
    // The builder at work on the card the reviewer waits for, or not watching at all.
    expect(laneOrderWaitReason(sent(), lane, [hr2, { ...hb2, cards: [1344] }], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), lane, [hr2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), null, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), { ...lane, reviewer: null }, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent(), { ...lane, cards: lane.cards.filter((c) => c.number !== 1364) }, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent({ review: { agent: 'r2', agentName: 'HR2', since: '' } as never }), lane, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent({ blocked: 'Asked the user' }), lane, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent({ archived: true }), lane, [hr2, hb2], late)).toBeNull()
    expect(laneOrderWaitReason(sent({ column: 'doing' }), lane, [hr2, hb2], late)).toBeNull()
  })
})

describe('a design its builder posted in Doing that nobody checks (#1382)', () => {
  // 21 Oct: HB5 posted #1305's design at 15:19 with the card in Doing; HR5 watched for Review only; the card sat 6 hours.
  const t0 = Date.parse('2026-10-21T15:19:00.000Z')
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const posted = { at: at(0), by: 'HB5 (alpha)', what: 'Posted a design for the reviewer to check: "Design: …"' }
  const doing = (history = [posted], over: Partial<TaskCard> = {}) => card(1305, { column: 'doing', agent: 'b5', history: [{ at: at(-90), by: 'HB5 (alpha)', what: 'Moved to Doing' }, ...history], ...over })
  const hb5 = { name: 'HB5', project: 'alpha', agentId: 'b5', cards: [1305], status: 'watching', watchSince: at(0) }
  const bound = 30 * 60_000
  it('stalled once the builder has only watched past its wait and a grace, naming it; not before', () => {
    expect(pendingDesign(doing())).toEqual(posted)
    expect(loopStepWaitReason(doing(), [hb5], bound, t0 + bound + LOOP_STEP_STALL_GRACE_MS - 1000)).toBeNull()
    expect(loopStepWaitReason(doing(), [hb5], bound, t0 + bound + LOOP_STEP_STALL_GRACE_MS)).toBe("HB5 posted a design on #1305 for its reviewer to check and has waited 35 min: nobody has answered it, and it hasn't gone ahead as posted (cw_loop_step proceed).")
    expect(loopStepWaitReason(doing(), [hb5], bound, t0 + 6 * 3600_000)).toMatch(/has waited 6 h:/)
    // Its own bound: a project that waits two hours flags it later.
    expect(loopStepWaitReason(doing(), [hb5], 120 * 60_000, t0 + 60 * 60_000)).toBeNull()
    // Counted from the design, never its builder's watch: watching again (a turn taken, a restart) doesn't restart it.
    expect(loopStepWaitReason(doing(), [{ ...hb5, watchSince: at(20) }], bound, t0 + bound + LOOP_STEP_STALL_GRACE_MS)).toMatch(/has waited 35 min:/)
  })
  it('due when its line says, as kept when it was posted, whatever the setting is now (HR4 round 1, finding 1)', () => {
    const kept = { ...posted, whatText: { id: 'tasks.history.loopStep', values: { step: 'design', text: 'Design: …', until: at(45) } } }
    expect(loopStepWaitReason(doing([kept]), [hb5], bound, t0 + 45 * 60_000 + LOOP_STEP_STALL_GRACE_MS - 1000)).toBeNull()
    expect(loopStepWaitReason(doing([kept]), [hb5], bound, t0 + 45 * 60_000 + LOOP_STEP_STALL_GRACE_MS)).toMatch(/has waited 50 min:/)
    // Posted again: the newer design's own deadline.
    const again = { ...kept, at: at(40), whatText: { ...kept.whatText, values: { ...kept.whatText.values, until: at(70) } } }
    expect(loopStepWaitReason(doing([kept, again]), [hb5], bound, t0 + 60 * 60_000)).toBeNull()
  })
  it('not stalled once answered, gone ahead, moved, blocked, or with its builder at work or not watching it', () => {
    const late = t0 + 6 * 3600_000
    for (const what of ['Checked the design: OK: "Fine"', 'Checked the design: gaps: "Bounds?"', 'Went ahead with the design unchecked: "No answer"', 'Moved to Review']) {
      expect(pendingDesign(doing([posted, { at: at(5), by: 'X', what }]))).toBeNull()
      expect(loopStepWaitReason(doing([posted, { at: at(5), by: 'X', what }]), [hb5], bound, late)).toBeNull()
    }
    // Posted again after its gaps: waiting again.
    expect(pendingDesign(doing([posted, { at: at(5), by: 'HR5 (alpha)', what: 'Checked the design: gaps: "Bounds?"' }, { ...posted, at: at(9) }]))?.at).toBe(at(9))
    expect(loopStepWaitReason(doing([], {}), [hb5], bound, late)).toBeNull()
    expect(loopStepWaitReason(doing([posted], { blocked: 'Build as posted, or wait?' }), [hb5], bound, late)).toBeNull()
    expect(loopStepWaitReason(doing([posted], { column: 'review' }), [hb5], bound, late)).toBeNull()
    expect(loopStepWaitReason(doing(), [{ ...hb5, status: 'working' }], bound, late)).toBeNull()
    expect(loopStepWaitReason(doing(), [{ ...hb5, cards: [1306] }], bound, late)).toBeNull()
    // A builder watching with no start known is still only watching: flagged (the design's time decides).
    expect(loopStepWaitReason(doing(), [{ ...hb5, watchSince: undefined }], bound, late)).toMatch(/has waited 6 h:/)
  })
})

describe('a follow-up its builder posted in Review or Passed that nobody checks (#1467)', () => {
  // 22 Oct: HB3 posted #1419's screenshot fixes on the card in Passed; HR3 watched for its move into Review, which never came.
  const t0 = Date.parse('2026-10-22T16:00:00.000Z')
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const posted = { at: at(0), by: 'HB3 (alpha)', what: 'Posted a follow-up for the reviewer to check: "Fixes: …"' }
  const passed = (history = [posted], over: Partial<TaskCard> = {}) => card(1419, { column: 'passed', agent: 'b3', history: [{ at: at(-90), by: 'HR3 (alpha)', what: 'Moved to Passed' }, ...history], ...over })
  const hb3 = { name: 'HB3', project: 'alpha', agentId: 'b3', cards: [1419], status: 'watching', watchSince: at(0) }
  // A design's bound (Card loops → Design check wait) doesn't apply: a follow-up has no going ahead, only the stall's.
  const bound = 120 * 60_000
  it('stalled once its builder has only watched it REVIEW_WAIT_STALL_MS since the follow-up, in Passed or Review; not before', () => {
    expect(pendingStep(passed())).toEqual({ entry: posted, step: 'followUp' })
    expect(pendingDesign(passed())).toBeNull()
    expect(loopStepWaitReason(passed(), [hb3], bound, t0 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(loopStepWaitReason(passed(), [hb3], bound, t0 + REVIEW_WAIT_STALL_MS)).toBe('HB3 posted a follow-up on #1419 for its reviewer to check and has waited 15 min: nobody has answered it (cw_loop_step ok or gaps).')
    expect(loopStepWait(passed(), [hb3], bound, t0 + REVIEW_WAIT_STALL_MS)?.step).toBe('followUp')
    expect(loopStepWaitReason(passed([posted], { column: 'review' }), [hb3], bound, t0 + 5 * 3600_000)).toMatch(/has waited 5 h:/)
    // Counted from the follow-up, never its builder's watch.
    expect(loopStepWaitReason(passed(), [{ ...hb3, watchSince: at(14) }], bound, t0 + REVIEW_WAIT_STALL_MS)).toMatch(/has waited 15 min:/)
  })
  it('not stalled once answered (gaps included), moved, blocked, elsewhere, or with its builder at work or not watching it', () => {
    const late = t0 + 6 * 3600_000
    for (const what of ['Checked the follow-up: OK: "Fine"', 'Checked the follow-up: gaps: "The dark theme"', 'Moved to Done', 'Returned for review']) {
      expect(pendingStep(passed([posted, { at: at(5), by: 'X', what }]))).toBeNull()
      expect(loopStepWaitReason(passed([posted, { at: at(5), by: 'X', what }]), [hb3], bound, late)).toBeNull()
    }
    // Posted again after its gaps: waiting again, from the new one.
    const again = passed([posted, { at: at(5), by: 'HR3 (alpha)', what: 'Checked the follow-up: gaps: "The dark theme"' }, { ...posted, at: at(30) }])
    expect(loopStepWaitReason(again, [hb3], bound, t0 + 40 * 60_000)).toBeNull()
    expect(loopStepWaitReason(again, [hb3], bound, t0 + 45 * 60_000)).toMatch(/has waited 15 min:/)
    expect(loopStepWaitReason(passed([posted], { blocked: 'Which theme?' }), [hb3], bound, late)).toBeNull()
    expect(loopStepWaitReason(passed([posted], { column: 'doing' }), [hb3], bound, late)).toBeNull()
    expect(loopStepWaitReason(passed(), [{ ...hb3, status: 'working' }], bound, late)).toBeNull()
    expect(loopStepWaitReason(passed(), [{ ...hb3, cards: [1420] }], bound, late)).toBeNull()
  })
  it("a change of place in its column isn't a move: the step still waits, its stall aged from its post (HR4's round 1 finding)", () => {
    // Lines as Combwork writes them: the words, and the message with its column.
    const line = (min: number, id: string, what: string, column: string, more: Record<string, string | number> = {}) => ({ at: at(min), by: 'HB3 (alpha)', what, whatText: { id: `tasks.history.${id}`, values: { column, ...more } } })
    const into = line(-90, 'moved', 'Moved to Approved', 'passed')
    const typed = (column: TaskCard['column'], ...after: ReturnType<typeof line>[]) => card(1419, { column, agent: 'b3', history: [line(-90, 'moved', `Moved to ${column}`, column), posted, ...after] })
    // Within Passed and within Review: top, bottom, before another card, a place by number.
    for (const [column, name] of [['passed', 'Approved'], ['review', 'Review']] as const) {
      for (const moved of [line(5, 'movedBottom', `Moved to the bottom of ${name}`, column), line(5, 'movedTop', `Moved to the top of ${name}`, column), line(5, 'movedBeforeIn', `Moved before #1400 in ${name}`, column, { before: 1400 }), line(5, 'placed', `Placed 2nd in ${name}`, column, { place: 2 })]) {
        expect(pendingStep(typed(column, moved))?.entry).toEqual(posted)
        expect(loopStepWaitReason(typed(column, moved), [hb3], bound, t0 + 16 * 60_000)).toMatch(/has waited 16 min:/)
      }
    }
    // Into another column, at its top or bottom too: the step ends.
    expect(pendingStep(card(1419, { column: 'review', agent: 'b3', history: [into, posted, line(5, 'movedTop', 'Moved to the top of Review', 'review')] }))).toBeNull()
    expect(pendingStep(typed('passed', line(5, 'moved', 'Moved to Done', 'done')))).toBeNull()
    expect(pendingStep(typed('passed', line(5, 'movedBefore', 'Moved to Review, before #1400', 'review', { before: 1400 })))).toBeNull()
    // A design in Doing the same way (#1382): reordered in Doing it still waits; moved on, it doesn't.
    const design = { ...posted, what: 'Posted a design for the reviewer to check: "Design: …"' }
    const doing = (...after: ReturnType<typeof line>[]) => ({ history: [line(-90, 'moved', 'Moved to Active', 'doing'), design, ...after] })
    expect(pendingStep(doing(line(5, 'movedTop', 'Moved to the top of Active', 'doing')))?.step).toBe('design')
    expect(pendingDesign(doing(line(5, 'movedBottom', 'Moved to the bottom of Active', 'doing')))).toEqual(design)
    expect(pendingStep(doing(line(5, 'movedBottom', 'Moved to the bottom of Todo', 'todo')))).toBeNull()
  })
  it('the column a step was posted in is kept on its line: a real move ends it, a change of place keeps it, with the lines before trimmed (#1495)', () => {
    const line = (min: number, id: string, what: string, column: string) => ({ at: at(min), by: 'You', what, whatText: { id: `tasks.history.${id}`, values: { column } } })
    // MAX_HISTORY keeps 300 lines: a long stay in Passed can trim its arrival before a follow-up is posted.
    const earlier = Array.from({ length: 298 }, (_, i) => ({ at: at(-60), by: 'Combwork', what: `Note ${i}` }))
    const keptIn = (column: string) => ({ ...posted, whatText: { id: 'tasks.history.loopStep', values: { step: 'followUp', text: 'Fixes: …', column } } })
    const trimmed = (column: string, ...after: ReturnType<typeof line>[]) => ({ history: [...earlier, keptIn(column), ...after] })
    // Into Review from Passed, at its top or bottom: the step ends (HR4's case on #1467: a phantom follow-up before).
    expect(pendingStep(trimmed('passed', line(5, 'movedTop', 'Moved to the top of Review', 'review')))).toBeNull()
    expect(pendingStep(trimmed('passed', line(5, 'movedBottom', 'Moved to the bottom of Review', 'review')))).toBeNull()
    // Its place within Passed changed: it still waits.
    for (const [id, what] of [['movedTop', 'Moved to the top of Approved'], ['movedBottom', 'Moved to the bottom of Approved'], ['placed', 'Placed 2nd in Approved']]) expect(pendingStep(trimmed('passed', line(5, id, what, 'passed')))?.step).toBe('followUp')
    expect(pendingStep(trimmed('passed'))?.step).toBe('followUp')
    // The kept column wins over the lines before it; a line from before #1495 keeps reading them.
    expect(pendingStep({ history: [line(-90, 'moved', 'Moved to Review', 'review'), keptIn('passed'), line(5, 'movedTop', 'Moved to the top of Approved', 'passed')] })?.step).toBe('followUp')
    expect(pendingStep({ history: [line(-90, 'moved', 'Moved to Approved', 'passed'), posted, line(5, 'movedTop', 'Moved to the top of Review', 'review')] })).toBeNull()
  })
})
