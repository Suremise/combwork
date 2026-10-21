// A lane's segmented bar in the Progress panel (#484): each card's segment from the board (column, blocked, review
// rounds), the hover text, folding a long lane's finished cards, and the header's numbers; an ended lane's segments as it
// left them, the card being worked, and the panel's order of lanes (#512).
import { describe, expect, it } from 'vitest'
import { cardSegment as segmentIn, chosenLaneRows, currentCard, DEFAULT_LANE_ROWS, draggedLaneRows, droppedLaneOrder, failedVerdictGist, fitSegments as fitIn, frozenSegment as frozenIn, keptLaneOrder, keyedLaneRows, LANE_ORDER_MAX, laneCards as laneCardsIn, laneRowsNow, laneRunning, lanesShown, laneSummary, maxLaneRows, mergedLaneOrder, nudgedLaneOrder, panelOrder, reviewRounds, SEGMENT_NOTE_MAX, laneWaitText, segmentMarks, segmentName, segmentsThatFit, laneSegmentWork, workNotes, type CardSegment, type SegmentState } from '../src/shared/laneBar'
import type { WorkBadge } from '../src/shared/workflow/workView'
import { refusalLines, type RuleId } from '../src/shared/workflow/refusals'
import type { LaneCard, LaneState, StoredText, TaskCard, TaskColumn } from '../src/shared/types'
import { fmt, tr } from '../src/shared/i18n'

// The segments' text is the window's (#798): worded with tr(), in English here.
const cardSegment = (n: number, c: TaskCard | undefined): CardSegment => segmentIn(n, c, tr)
const frozenSegment = (c: LaneCard): CardSegment => frozenIn(c, tr)
const laneCards = (numbers: readonly number[], tasks: readonly TaskCard[]): CardSegment[] => laneCardsIn(numbers, tasks, tr)
const fitSegments = (cards: CardSegment[], max: number): ReturnType<typeof fitIn> => fitIn(cards, max, tr, fmt.list)

const card = (number: number, column: TaskColumn, history: string[] = [], extra: Partial<TaskCard> = {}): TaskCard => ({
  number,
  title: `Card ${number}`,
  description: '',
  project: 'hive',
  agent: null,
  column,
  order: 0,
  labels: [],
  blocked: null,
  blockedBy: [],
  links: [],
  comments: [],
  history: history.map((what, i) => ({ at: new Date(1000 * (i + 1)).toISOString(), by: 'B1', what })),
  archived: false,
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  ...extra
})

describe('a card segment', () => {
  it('takes its state from the column, blocked and On Hold first', () => {
    expect(cardSegment(1, card(1, 'todo')).state).toBe('todo')
    expect(cardSegment(1, card(1, 'doing')).state).toBe('doing')
    expect(cardSegment(1, card(1, 'review')).state).toBe('review')
    expect(cardSegment(1, card(1, 'passed')).state).toBe('passed')
    expect(cardSegment(1, card(1, 'done')).state).toBe('done')
    expect(cardSegment(1, card(1, 'hold')).state).toBe('blocked')
    expect(cardSegment(1, card(1, 'doing', [], { blocked: 'needs a decision' })).state).toBe('blocked')
    // Finished stays finished, blocked or not.
    expect(cardSegment(1, card(1, 'passed', [], { blocked: 'stale reason' })).state).toBe('passed')
  })

  it('counts rounds from the review verdicts', () => {
    const inReview = card(4, 'review', ['Created in Todo', 'Moved to Doing', 'Moved to Review'])
    expect(cardSegment(4, inReview)).toMatchObject({ state: 'review', failed: false, round: 1, label: '#4 Card 4 · Review, round 1' })
    // Failed and still in Review (the builder hasn't picked it up): round 1 failed.
    const failed = card(4, 'review', ['Moved to Review', 'Started reviewing', 'Review failed'])
    expect(cardSegment(4, failed)).toMatchObject({ state: 'review', failed: true, round: 1, label: '#4 Card 4 · Review, round 1 failed review' })
    // Being fixed in Doing: still the failed round.
    const fixing = card(4, 'doing', ['Moved to Review', 'Review failed', 'Moved to Doing'])
    expect(cardSegment(4, fixing)).toMatchObject({ state: 'doing', failed: true, round: 1 })
    // Back in Review (moved, or returned in place): its next round, no longer failed.
    expect(cardSegment(4, card(4, 'review', ['Review failed', 'Moved to Doing', 'Moved to Review']))).toMatchObject({ failed: false, round: 2 })
    expect(cardSegment(4, card(4, 'review', ['Review failed', 'Returned for review, round 2']))).toMatchObject({ failed: false, round: 2 })
    // Several notes in one history line.
    expect(cardSegment(4, card(4, 'review', ['Review failed', 'Review failed', 'Moved to Doing; Given to B1', 'Moved to Review']))).toMatchObject({ failed: false, round: 3 })
    // Passed after two failures: passed in round 3.
    expect(cardSegment(4, card(4, 'passed', ['Review failed', 'Moved to Review', 'Review failed', 'Moved to Review', 'Review passed; Moved to Passed']))).toMatchObject({ state: 'passed', failed: false, round: 3, label: '#4 Card 4 · Passed in round 3' })
    expect(cardSegment(4, card(4, 'todo')).round).toBeNull()
  })

  it('says why a blocked card is blocked, and a card not on the board', () => {
    expect(cardSegment(7, card(7, 'doing', [], { blocked: 'waiting for Darren' }))).toMatchObject({ label: '#7 Card 7 · Doing, round 1', notes: ['#7: blocked: waiting for Darren'] })
    expect(cardSegment(7, card(7, 'hold'))).toMatchObject({ label: '#7 Card 7 · On Hold, waiting for you', notes: ['#7: On Hold: waiting for you to move it on'] })
    expect(cardSegment(9, undefined)).toMatchObject({ state: 'todo', label: '#9 · not on the board', notes: [] })
  })

  it('reads the verdicts with their history', () => {
    expect(reviewRounds(card(1, 'review', ['Review failed', 'Started reviewing']))).toEqual({ failures: 1, failedNow: false, reviewed: true })
    expect(reviewRounds(card(1, 'todo'))).toEqual({ failures: 0, failedNow: false, reviewed: false })
  })
})

describe("what a segment's marks mean (#706)", () => {
  const at = (s: number): string => new Date(1000 * s).toISOString()
  // A failed verdict by R1 at 3 s, its comment saved with it; an older one, and someone else's comment, around it.
  const reviewed = (column: TaskColumn, more: Partial<TaskCard> = {}): TaskCard =>
    card(650, column, [], {
      history: [
        { at: at(1), by: 'R1', what: 'Review failed' },
        { at: at(2), by: 'B1', what: 'Moved to Review' },
        { at: at(3), by: 'R1', what: 'Review failed' }
      ],
      comments: [
        { at: at(1), by: 'R1', text: 'Round 1: FAILED: an old finding' },
        { at: at(2), by: 'B1', text: 'Round 2 ready' },
        { at: at(3), by: 'R1', text: '\n**Round 2: FAILED: 2 findings**: the tooltip clips\n\n1. …' }
      ],
      ...more
    })

  it("a failed review's underline: the round that failed, the next one, and the reviewer's gist", () => {
    const s = cardSegment(650, reviewed('review'))
    expect(s).toMatchObject({ failed: true, round: 2, notes: ['#650: review failed (round 2): waiting for round 3', 'Reviewer: Round 2: FAILED: 2 findings: the tooltip clips'] })
    // The same text is its accessible name, after the label.
    expect(segmentName(s)).toBe('#650 Card 650 · Review, round 2 failed review. #650: review failed (round 2): waiting for round 3. Reviewer: Round 2: FAILED: 2 findings: the tooltip clips')
    // Being fixed in Doing: still waiting for its next round.
    expect(cardSegment(650, reviewed('doing', { history: [...reviewed('doing').history, { at: at(4), by: 'B1', what: 'Moved to Doing' }] })).notes[0]).toBe('#650: review failed (round 2): waiting for round 3')
  })

  it('no gist without a comment saved with the verdict, and none once the next round starts', () => {
    expect(failedVerdictGist({ history: [{ at: at(3), by: 'R1', what: 'Review failed' }], comments: [{ at: at(3), by: 'B1', text: 'not the reviewer' }, { at: at(60), by: 'R1', text: 'a minute later' }] })).toBeNull()
    expect(cardSegment(650, reviewed('review', { comments: [] })).notes).toEqual(['#650: review failed (round 2): waiting for round 3'])
    const next = reviewed('review', { history: [...reviewed('review').history, { at: at(5), by: 'B1', what: 'Returned for review, round 3' }] })
    expect(cardSegment(650, next)).toMatchObject({ failed: false, round: 3, notes: [] })
  })

  it("the hatching: a blocked card's reason or why it is On Hold, first line, cut when long", () => {
    expect(cardSegment(8, card(8, 'review', [], { blocked: 'Asked Darren about the colour\nmore detail' })).notes).toEqual(['#8: blocked: Asked Darren about the colour'])
    expect(cardSegment(8, card(8, 'hold', [], { blocked: 'parked for 0.6' })).notes).toEqual(['#8: On Hold: parked for 0.6'])
    const long = cardSegment(8, card(8, 'todo', [], { blocked: 'x'.repeat(400) })).notes[0]
    expect(long).toBe(`#8: blocked: ${'x'.repeat(SEGMENT_NOTE_MAX - 1)}…`)
    expect(cardSegment(8, card(8, 'doing', [], { blocked: '  \n ' })).notes).toEqual(['#8: blocked'])
    // A finished card isn't hatched, so a stale reason says nothing; nor does a card with no marks.
    expect(cardSegment(8, card(8, 'passed', [], { blocked: 'stale reason' })).notes).toEqual([])
    expect(cardSegment(8, card(8, 'doing')).notes).toEqual([])
  })

  it('a failed card that is blocked too says both', () => {
    expect(cardSegment(650, reviewed('doing', { blocked: 'which colour?', comments: [] })).notes).toEqual(['#650: review failed (round 2): waiting for round 3', '#650: blocked: which colour?'])
  })
})

describe('a lane', () => {
  const tasks = [card(1, 'done'), card(2, 'passed'), card(3, 'review'), card(4, 'doing'), card(5, 'todo')]

  it('keeps the lane order and its header numbers', () => {
    const cards = laneCards([3, 1, 5, 2, 4], tasks)
    expect(cards.map((c) => c.number)).toEqual([3, 1, 5, 2, 4])
    // #3 is in Review and #4 in Doing: the builder is building #4 (#512).
    expect(laneSummary(cards)).toEqual({ finished: 2, total: 5, current: 4 })
    expect(laneSummary(laneCards([3, 1, 5], tasks))).toEqual({ finished: 1, total: 3, current: 3 })
    expect(laneSummary(laneCards([1, 2], tasks))).toEqual({ finished: 2, total: 2, current: null })
  })

  it('shows every card while they fit, then folds the finished ones into one, then the last into "+n"', () => {
    const cards = laneCards([1, 2, 3, 4, 5], tasks)
    expect(fitSegments(cards, 5)).toBe(cards)
    const four = fitSegments(cards, 4)
    expect(four.map((s) => (s.kind === 'card' ? s.number : `${s.kind}:${s.numbers.join()}`))).toEqual(['finished:1,2', 3, 4, 5])
    expect(four[0]).toMatchObject({ label: '2 finished: #1, #2' })
    const three = fitSegments(cards, 3)
    expect(three.map((s) => (s.kind === 'card' ? s.number : `${s.kind}:${s.numbers.join()}`))).toEqual(['finished:1,2', 3, 'more:4,5'])
    // No finished cards to fold: straight to "+n".
    const todo: CardSegment[] = laneCards([3, 4, 5, 6, 7], tasks)
    expect(fitSegments(todo, 3).map((s) => (s.kind === 'card' ? s.number : `${s.kind}:${s.numbers.join()}`))).toEqual([3, 4, 'more:5,6,7'])
  })

  it('fits segments of at least 12 px with 2 px gaps, and never fewer than three', () => {
    expect(segmentsThatFit(240)).toBe(17)
    expect(segmentsThatFit(12)).toBe(3)
  })
})

describe('the card a lane is on (#512)', () => {
  const on = (...states: SegmentState[]) => currentCard(states.map((state, i) => ({ number: i + 1, state })))

  it('the card being built, else the one in Review, else the first still to do', () => {
    expect(on('done', 'review', 'doing', 'todo')).toEqual({ current: 3, waiting: false })
    expect(on('passed', 'todo', 'review')).toEqual({ current: 3, waiting: false })
    expect(on('done', 'todo', 'todo')).toEqual({ current: 2, waiting: false })
    expect(on('done', 'passed')).toEqual({ current: null, waiting: false })
  })

  it("waits for the user only while its first open card is blocked and nothing else is worked", () => {
    // The builder moved on to the next card while #1 waits for the user: working on #2, not waiting.
    expect(on('blocked', 'doing', 'todo')).toEqual({ current: 2, waiting: false })
    expect(on('blocked', 'review')).toEqual({ current: 2, waiting: false })
    // Nothing else being worked: waiting on the blocked card.
    expect(on('passed', 'blocked', 'todo')).toEqual({ current: 2, waiting: true })
    // A later card blocked (its own reason) doesn't make it wait.
    expect(on('doing', 'todo', 'blocked')).toEqual({ current: 1, waiting: false })
    // Finished as the caller says (a gone card counts as finished for the lane).
    expect(currentCard([{ number: 1, state: 'todo', finished: true }, { number: 2, state: 'todo' }])).toEqual({ current: 2, waiting: false })
  })
})

describe("an ended lane's segments (#512)", () => {
  const lc = (number: number, column: LaneCard['column'], over: Partial<LaneCard> = {}): LaneCard => ({ number, title: `Card ${number}`, column, blocked: null, round: 1, reviewing: false, ...over })

  it('shows each card as the lane left it, never failed (it keeps no verdicts)', () => {
    expect(frozenSegment(lc(5, 'doing', { round: 2 }))).toEqual({ kind: 'card', number: 5, name: '#5', state: 'doing', failed: false, round: 2, label: '#5 Card 5 · Doing, round 2, when the lane ended', notes: [] })
    expect(frozenSegment(lc(6, 'passed', { round: 3 }))).toMatchObject({ state: 'passed', round: 3, label: '#6 Card 6 · Passed in round 3, when the lane ended' })
    expect(frozenSegment(lc(7, 'todo'))).toMatchObject({ state: 'todo', round: null, label: '#7 Card 7 · Todo, when the lane ended' })
    // Its hatching says why, as the lane left it (#706).
    expect(frozenSegment(lc(8, 'review', { blocked: 'Asked Darren' }))).toMatchObject({ state: 'blocked', label: '#8 Card 8 · Review, round 1, when the lane ended', notes: ['#8: blocked: Asked Darren'] })
    expect(frozenSegment(lc(9, 'hold'))).toMatchObject({ state: 'blocked', label: '#9 Card 9 · On Hold, when the lane ended', notes: [] })
    expect(frozenSegment(lc(9, 'hold', { blocked: 'for 0.6' })).notes).toEqual(['#9: On Hold: for 0.6'])
    expect(frozenSegment(lc(10, 'gone'))).toMatchObject({ state: 'todo', round: null, label: '#10 · not on the board when the lane ended' })
  })

  it("says when the lane kept no record of a card, never where the board has it now", () => {
    expect(frozenSegment(lc(11, 'unrecorded'))).toEqual({ kind: 'card', number: 11, name: '#11', state: 'unrecorded', failed: false, round: null, label: '#11 Card 11 · not recorded: the lane ended before Hive kept where its cards were', notes: [] })
    expect(frozenSegment(lc(12, 'unrecorded', { title: '' })).label).toBe('#12 · not recorded: the lane ended before Hive kept where its cards were')
    // Not finished, not worked: such a lane has no current card to show.
    expect(laneSummary([frozenSegment(lc(11, 'unrecorded'))])).toMatchObject({ finished: 0, total: 1 })
  })
})

describe("the panel's order of lanes (#512)", () => {
  const lane = (id: string, state: LaneState, startedAt: string, endedAt: string | null = null) => ({ id, state, startedAt, endedAt })

  it('running first, then paused, newest first in each; then ended and abandoned in the order they finished (#568)', () => {
    const list = [
      lane('old-ended', 'ended', '2026-10-10T01:00:00Z', '2026-10-10T02:00:00Z'),
      lane('old-run', 'active', '2026-10-10T01:00:00Z'),
      lane('paused', 'paused', '2026-10-10T03:00:00Z'),
      lane('dropped', 'abandoned', '2026-10-09T23:00:00Z', '2026-10-10T04:00:00Z'),
      lane('new-run', 'active', '2026-10-10T05:00:00Z')
    ]
    expect(panelOrder(list).map((l) => l.id)).toEqual(['new-run', 'old-run', 'paused', 'old-ended', 'dropped'])
    expect(list[0].id).toBe('old-ended')
  })
})

describe("the user's order of lanes (#568)", () => {
  const lane = (id: string, state: LaneState, startedAt: string, endedAt: string | null = null) => ({ id, state, startedAt, endedAt })
  const ids = (ls: { id: string }[]): string[] => ls.map((l) => l.id)
  const a = lane('a', 'active', '2026-10-10T01:00:00Z')
  const b = lane('b', 'active', '2026-10-10T02:00:00Z')
  const c = lane('c', 'paused', '2026-10-10T03:00:00Z')

  it('without a move, nothing changes from the usual order', () => {
    expect(ids(panelOrder([a, b, c]))).toEqual(ids(panelOrder([a, b, c], [])))
    expect(ids(panelOrder([a, b, c]))).toEqual(['b', 'a', 'c'])
  })

  it('running lanes, paused ones too, follow the order the user put them in', () => {
    expect(ids(panelOrder([a, b, c], ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  it('a lane started since arrives on top, paused or not, newest first; the moved ones keep their order below it', () => {
    const d = lane('d', 'active', '2026-10-10T04:00:00Z')
    // Started after d, paused at once (its first card blocked): still on top.
    const e = lane('e', 'paused', '2026-10-10T05:00:00Z')
    expect(ids(panelOrder([a, b, c, d, e], ['a', 'c', 'b']))).toEqual(['e', 'd', 'a', 'c', 'b'])
    // One of them pausing later keeps its place among them: by when it started, not its state.
    expect(ids(panelOrder([a, b, c, { ...d, state: 'paused' as const }, { ...e, state: 'active' as const }], ['a', 'c', 'b']))).toEqual(['e', 'd', 'a', 'c', 'b'])
    expect(ids(panelOrder([a, b, c, { ...d, state: 'paused' as const }, { ...e, state: 'active' as const }].reverse(), ['a', 'c', 'b']))).toEqual(['e', 'd', 'a', 'c', 'b'])
    // Without an order, active before paused as ever (#512).
    expect(ids(panelOrder([a, b, c, d, e]))).toEqual(['d', 'b', 'a', 'e', 'c'])
  })

  it('a lane that pauses or runs again keeps its place in the order', () => {
    expect(ids(panelOrder([{ ...a, state: 'paused' as const }, b, { ...c, state: 'active' as const }], ['a', 'b', 'c']))).toEqual(['a', 'b', 'c'])
  })

  it('a lane that finishes leaves the order and drops to the very bottom, the latest finish last', () => {
    const early = lane('early', 'ended', '2026-10-09T01:00:00Z', '2026-10-10T06:00:00Z')
    const done = { ...a, state: 'ended' as const, endedAt: '2026-10-10T07:00:00Z' }
    const gone = { ...b, state: 'abandoned' as const, endedAt: '2026-10-10T08:00:00Z' }
    expect(ids(panelOrder([gone, early, c, done], ['a', 'b', 'c']))).toEqual(['c', 'early', 'a', 'b'])
  })

  it('ids it names that are no lane any more change nothing', () => {
    expect(ids(panelOrder([a, b], ['gone', 'a', 'b', 'old']))).toEqual(['a', 'b'])
  })

  it('only running lanes move', () => {
    expect((['active', 'paused', 'ended', 'abandoned'] as const).map(laneRunning)).toEqual([true, true, false, false])
  })

  it('a drop puts the lane before another, or after the last; a drop that leaves it in place is none', () => {
    const run = ['a', 'b', 'c', 'd']
    expect(droppedLaneOrder(run, 'd', 'a')).toEqual(['d', 'a', 'b', 'c'])
    expect(droppedLaneOrder(run, 'a', 'c')).toEqual(['b', 'a', 'c', 'd'])
    expect(droppedLaneOrder(run, 'a', null)).toEqual(['b', 'c', 'd', 'a'])
    expect(droppedLaneOrder(run, 'b', 'c')).toBeNull()
    expect(droppedLaneOrder(run, 'b', 'b')).toBeNull()
    expect(droppedLaneOrder(run, 'd', null)).toBeNull()
    expect(droppedLaneOrder(run, 'x', 'a')).toBeNull()
    expect(droppedLaneOrder(run, 'a', 'ended-lane')).toBeNull()
  })

  it('a move among the lanes a filtered panel shows leaves the others where they are', () => {
    // Shown: b, d (one project's); moved: d above b.
    expect(mergedLaneOrder(['a', 'b', 'c', 'd', 'e'], ['d', 'b'])).toEqual(['a', 'd', 'c', 'b', 'e'])
    expect(mergedLaneOrder(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual(['c', 'b', 'a'])
    expect(mergedLaneOrder(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('Alt+Up and Alt+Down move a lane a place, never past either end', () => {
    expect(nudgedLaneOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(nudgedLaneOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(nudgedLaneOrder(['a', 'b', 'c'], 'a', -1)).toBeNull()
    expect(nudgedLaneOrder(['a', 'b', 'c'], 'c', 1)).toBeNull()
    expect(nudgedLaneOrder(['a', 'b', 'c'], 'x', 1)).toBeNull()
  })

  it('an order is kept as lane ids, each once and a bounded list; anything else is none', () => {
    expect(keptLaneOrder(['a', 'b', 'a', '', 7, null, 'x'.repeat(65), 'c'])).toEqual(['a', 'b', 'c'])
    expect(keptLaneOrder('a')).toEqual([])
    expect(keptLaneOrder(null)).toEqual([])
    expect(keptLaneOrder(Array.from({ length: LANE_ORDER_MAX + 5 }, (_, i) => `l${i}`))).toHaveLength(LANE_ORDER_MAX)
  })
})

describe("the lanes section's height (#569)", () => {
  it('shows up to four lanes by default, and only as many as there are', () => {
    expect(DEFAULT_LANE_ROWS).toBe(4)
    expect([1, 2, 3, 4, 5, 9].map((n) => lanesShown(undefined, n))).toEqual([1, 2, 3, 4, 4, 4])
    expect(lanesShown(null, 7)).toBe(4)
  })

  it('a kept choice wins, as whole lanes, at least one, never more than there are', () => {
    expect(lanesShown(6, 9)).toBe(6)
    expect(lanesShown(6, 3)).toBe(3)
    expect(lanesShown(1, 5)).toBe(1)
    expect(chosenLaneRows(2.6)).toBe(3)
    expect(chosenLaneRows(0)).toBe(1)
    expect(chosenLaneRows(-4)).toBe(1)
    // A damaged value is no choice.
    expect(chosenLaneRows(Number.NaN)).toBe(4)
    expect(chosenLaneRows(Infinity)).toBe(4)
  })

  it('the most it can show: no more lanes than there are, nor than the room holds', () => {
    // 61 px a lane: 300 px holds four whole ones.
    expect(maxLaneRows(9, 300, 61)).toBe(4)
    expect(maxLaneRows(9, 305, 61)).toBe(5)
    expect(maxLaneRows(9, 304, 61)).toBe(5)
    expect(maxLaneRows(3, 1000, 61)).toBe(3)
    // Always one, however short.
    expect(maxLaneRows(5, 10, 61)).toBe(1)
    expect(maxLaneRows(5, 0, 0)).toBe(5)
  })

  it('dragging snaps to whole lanes: up for more, down for fewer, between one and the most', () => {
    expect(draggedLaneRows(4, 0, 61, 9)).toBe(4)
    expect(draggedLaneRows(4, -29, 61, 9)).toBe(4)
    expect(draggedLaneRows(4, -31, 61, 9)).toBe(5)
    expect(draggedLaneRows(4, -122, 61, 9)).toBe(6)
    expect(draggedLaneRows(4, 61, 61, 9)).toBe(3)
    expect(draggedLaneRows(4, 1000, 61, 9)).toBe(1)
    expect(draggedLaneRows(4, -1000, 61, 7)).toBe(7)
  })

  it('a panel too short for the choice shows the whole lanes that fit, and keeps the choice', () => {
    // Seven chosen, room for two (61 px a lane): two show, two is the most, seven is still the choice.
    expect(laneRowsNow(7, 7, 130, 61)).toEqual({ chosen: 7, shown: 2, max: 2 })
    // Room again: the choice shows.
    expect(laneRowsNow(7, 7, 1000, 61)).toEqual({ chosen: 7, shown: 7, max: 7 })
    // Not measured yet: the choice, up to the lanes there are.
    expect(laneRowsNow(undefined, 9, null, 61)).toEqual({ chosen: 4, shown: 4, max: 9 })
    // However short, one lane.
    expect(laneRowsNow(5, 6, -40, 61)).toEqual({ chosen: 5, shown: 1, max: 1 })
  })

  it('keys: Up a lane more, Down one fewer, Home one, End the most; others are not its', () => {
    expect(keyedLaneRows(4, 'ArrowUp', 7)).toBe(5)
    expect(keyedLaneRows(4, 'ArrowDown', 7)).toBe(3)
    expect(keyedLaneRows(7, 'ArrowUp', 7)).toBe(7)
    expect(keyedLaneRows(1, 'ArrowDown', 7)).toBe(1)
    expect(keyedLaneRows(4, 'Home', 7)).toBe(1)
    expect(keyedLaneRows(4, 'End', 7)).toBe(7)
    expect(keyedLaneRows(4, 'Enter', 7)).toBeNull()
  })
})

describe("a segment's hover: what the card's facts say (#1225)", () => {
  const short = (id: string): string => id.slice(0, 7)
  const badge = (over: Partial<WorkBadge> = {}): WorkBadge => ({ card: 7, stage: 'review', preWorkflow: false, adopted: false, revision: 'a3f2c1d9e8', verdict: null, checks: { passed: 0, failed: 0, notCounted: 0 }, stale: false, stalePass: null, noCode: false, refused: null, overridden: false, override: null, outsideRules: false, mergedInPart: false, leftTarget: false, accepted: false, merged: null, forYou: 0, decisionSince: false, lastSeq: 3, ...over })

  it('the revision under review, the last verdict on its revision, and the checks on it', () => {
    expect(workNotes(badge({ verdict: { pass: false, revision: 'b71e09a4cc', current: true }, checks: { passed: 2, failed: 1, notCounted: 4 } }), 'review', null, short, tr)).toEqual(['Under review: a3f2c1d', 'Last verdict: failed on b71e09a', 'Checks on it: 2 passed, 1 failed'])
    expect(workNotes(badge({ stage: 'active', verdict: { pass: true, revision: 'a3f2c1d9e8', current: false } }), 'doing', null, short, tr)).toEqual(['Revision: a3f2c1d', 'Last verdict: passed on a3f2c1d, which no longer counts'])
    // A no-code card's verdict has no revision.
    expect(workNotes(badge({ revision: null, verdict: { pass: true, revision: null, current: true } }), 'passed', null, short, tr)).toEqual(['Last verdict: passed'])
  })

  it("a move past its rules (#1275): who, which rules by name and why, when the window names them", () => {
    const names = { list: (items: string[]) => items.join(' + '), ruleName: (id: string) => (id === 'integrate.approved' ? 'Review and approval before merging' : id) }
    const o = { by: 'user' as const, move: 'active→done', rules: ['integrate.approved', 'done.contained'], reason: ' Merged by hand ', at: '' }
    expect(workNotes(badge({ revision: null, override: o }), 'done', null, short, tr, names)).toEqual(['You moved it past its rules: Review and approval before merging + done.contained. Reason: Merged by hand'])
    expect(workNotes(badge({ revision: null, override: { ...o, by: 'assistant', reason: '' } }), 'done', null, short, tr, names)).toEqual(['The Assistant moved it past its rules: Review and approval before merging + done.contained. No reason given.'])
    // Without the window's names (hive-mcp): no line.
    expect(workNotes(badge({ revision: null, override: o }), 'done', null, short, tr)).toEqual([])
  })

  // The gates, visible (#1279).
  const names = { list: (items: string[]) => items.join(' + '), ruleName: (id: string) => id, refusal: (rule: string, values: Record<string, string | number | StoredText>) => refusalLines(rule as RuleId, values, { one: (m, v) => tr(m, v), list: (items) => items.join(', '), names: true }) }
  const refused = { move: 'submit', rule: 'submit.empty', values: { card: 'alpha-7' }, at: '', times: 1 }

  it('a refused request (#1279): its reason and next step as the agent got them, the card named as the window names it; repeats counted after', () => {
    expect(workNotes(badge({ refused }), 'review', null, short, tr, names, 'AL-7')).toEqual(['AL-7 has no change to review. Commit the work, then submit.', 'Under review: a3f2c1d'])
    expect(workNotes(badge({ refused: { ...refused, times: 3 } }), 'doing', null, short, tr, names, 'AL-7')[0]).toBe('AL-7 has no change to review. Commit the work, then submit. (refused 3 times)')
    // A rule's names in the window's words (move.notFromHere names the stage and the moves).
    expect(workNotes(badge({ revision: null, refused: { move: 'submit', rule: 'move.notFromHere', values: { card: 'alpha-7', stage: 'todo', move: 'submit', moves: 'start' }, at: '', times: 1 } }), 'todo', null, short, tr, names, 'AL-7')[0]).toMatch(/^AL-7 /)
  })

  it('a stale pass (#1279): the revision it was for and the one now, through the platform', () => {
    expect(workNotes(badge({ stage: 'approved', stale: true, stalePass: { approved: 'a3f2c1d9e8', current: 'b71e09a4cc' } }), 'passed', null, short, tr)).toEqual(['Pass was for a3f2c1d; now at b71e09a', 'Revision: a3f2c1d'])
    expect(workNotes(badge({ revision: null, stale: true, stalePass: { approved: 'a3f2c1d9e8', current: null } }), 'passed', null, short, tr)).toEqual(['Pass was for a3f2c1d: it no longer holds'])
  })

  it('a no-code card (#1279): says so, with no revision or merge lines', () => {
    expect(workNotes(badge({ noCode: true, stage: 'done', revision: 'hash12345678', merged: '9f8e7d6c5b4a3', verdict: { pass: true, revision: null, current: true } }), 'done', 'ffffffffffff', short, tr)).toEqual(['No-code card: no commits', 'Last verdict: passed'])
  })

  it("a running lane's segment marks (#1279): a refusal, a stale pass and an override each with what it means; none in an ended lane", () => {
    const seg = { kind: 'card', number: 7, name: 'AL-7', state: 'passed', failed: false, round: 1, label: 'AL-7 x · Passed', notes: [] } as CardSegment
    const o = { by: 'user' as const, move: 'active→done', rules: ['done.contained'], reason: '', at: '' }
    const b = badge({ refused, stalePass: { approved: 'a3f2c1d9e8', current: 'b71e09a4cc' }, override: o })
    expect(segmentMarks({ frozen: null }, b, seg, short, tr, names)).toEqual({ refused: 'AL-7 has no change to review. Commit the work, then submit.', stale: 'Pass was for a3f2c1d; now at b71e09a', override: 'You moved it past its rules: done.contained. No reason given.' })
    expect(segmentMarks({ frozen: null }, badge(), seg, short, tr, names)).toEqual({})
    // Done, a stale pass no longer matters: no stale mark or line.
    expect(segmentMarks({ frozen: null }, b, { ...seg, state: 'done' }, short, tr, names)).not.toHaveProperty('stale')
    expect(workNotes(b, 'done', null, short, tr, names, 'AL-7').some((l) => l.startsWith('Pass was for'))).toBe(false)
    expect(segmentMarks({ frozen: [] }, b, seg, short, tr, names)).toEqual({})
    expect(segmentMarks({ frozen: null }, undefined, seg, short, tr, names)).toEqual({})
  })

  it('why a lane waits, in the window (#1279): each reason, the card by its key', () => {
    const name = (n: number): string => `HI-${n}`
    expect(laneWaitText({ reason: 'you', card: 12, ask: 'approve' }, name, tr)).toBe('waiting for you (approval): HI-12')
    expect(laneWaitText({ reason: 'you', card: 12 }, name, tr)).toBe('waiting for you (an answer): HI-12')
    expect(laneWaitText({ reason: 'notMerged', card: 11 }, name, tr)).toBe('waiting: HI-11 not merged')
    expect(laneWaitText({ reason: 'merging', card: 11 }, name, tr)).toBe('waiting: HI-11 merging')
    expect(laneWaitText({ reason: 'reviewer', card: 12 }, name, tr)).toBe('waiting for a reviewer on HI-12')
    expect(laneWaitText({ reason: 'stale', card: 12 }, name, tr)).toBe('stale: HI-12 must be submitted again')
    expect(laneWaitText({ reason: 'listChanges', card: 12 }, name, tr)).toBe('list changes after HI-12')
    expect(laneWaitText({ reason: 'roundLimit', card: 12 }, name, tr)).toBe('waiting for you: HI-12 reached its round limit')
    expect(laneWaitText({ reason: 'blocked', card: 3, blocked: 'x' }, name, tr)).toBe('HI-3 is blocked')
    expect(laneWaitText({ reason: 'hold', card: 3 }, name, tr)).toBe('HI-3 is On Hold')
  })

  it("its merge commit once Done: the Integrated fact's, else the lane's record; nothing for a card with no work recorded", () => {
    expect(workNotes(badge({ stage: 'done', merged: '9f8e7d6c5b4a3' }), 'done', 'ffffffffffff', short, tr)).toEqual(['Revision: a3f2c1d', 'Merged as 9f8e7d6'])
    expect(workNotes(badge({ stage: 'done', revision: null }), 'done', 'abc1234def5678', short, tr)).toEqual(['Merged as abc1234'])
    expect(workNotes(undefined, 'done', 'merged by hand', short, tr)).toEqual(['Merged as merged by hand'])
    expect(workNotes(undefined, 'review', 'abc1234def5678', short, tr)).toEqual([])
    expect(workNotes(badge({ revision: null }), 'todo', null, short, tr)).toEqual([])
  })

  it("an ended lane's card taken on again later: its segment says the lane's merge only, never the later cycle's work (HR5's round 1)", () => {
    // #7 was Done (merged as a1a1a1a) when its lane ended; reopened in another lane, it is under review at B, its check
    // failed, and later integrated as C.
    const frozen = { frozen: [{ number: 7, title: 'Reused', column: 'done' as const, blocked: null, round: 1, reviewing: false }], mergeCommit: 'a1a1a1a' }
    const seg = frozenSegment(frozen.frozen[0])
    const later = badge({ stage: 'review', revision: 'b2b2b2b2b2b2', verdict: { pass: false, revision: 'b2b2b2b2b2b2', current: true }, checks: { passed: 0, failed: 1, notCounted: 0 } })
    expect(laneSegmentWork(frozen, later, seg, short, tr)).toEqual(['Merged as a1a1a1a'])
    expect(laneSegmentWork(frozen, badge({ stage: 'done', merged: 'c3c3c3c3c3c3c3' }), seg, short, tr)).toEqual(['Merged as a1a1a1a'])
    // The lane that has it now reads its facts.
    expect(laneSegmentWork({ frozen: null, mergeCommit: null }, later, cardSegment(7, card(7, 'review')), short, tr)).toEqual(['Under review: b2b2b2b', 'Last verdict: failed on b2b2b2b', 'Checks on it: 0 passed, 1 failed'])
  })
})
