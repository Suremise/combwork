// A lane's segmented bar in the Progress panel (#484): each card's segment from the board (column, blocked, review
// rounds), the hover text, folding a long lane's finished cards, and the header's numbers; an ended lane's segments as it
// left them, the card being worked, and the panel's order of lanes (#512).
import { describe, expect, it } from 'vitest'
import { cardSegment as segmentIn, chosenLaneRows, laneRowsRange, MORE_LANE_ROWS, currentCard, DEFAULT_LANE_ROWS, draggedLaneRows, droppedLaneOrder, failedVerdictGist, fitSegments as fitIn, frozenSegment as frozenIn, keptLaneOrder, keyedLaneRows, LANE_ORDER_MAX, laneCards as laneCardsIn, laneRowsNow, laneRunning, lanesShown, laneSummary, maxLaneRows, mergedLaneOrder, nudgedLaneOrder, panelOrder, reviewRounds, SEGMENT_NOTE_MAX, foldedMarks, laneWaitText, segmentMarks, segmentName, segmentsThatFit, laneSegmentWork, workNotes, type CardSegment, type SegmentState } from '../src/shared/laneBar'
import type { WorkBadge } from '../src/shared/workflow/workView'
import { cardOldRulesNote, laneCardTime, laneOldRulesNote, laneWaitTime, pulseLanes } from '../src/shared/laneBar'
import { stampWait } from '../src/shared/lanes'
import { laneLegend, legendSources, segmentStage } from '../src/shared/laneStages'
import { mustCompile } from '../src/shared/workflow/compile'
import { preset } from '../src/shared/workflow/options'
import { refusal, refusalLines, type RuleId } from '../src/shared/workflow/refusals'
import type { LaneCard, LaneState, StoredText, TaskCard, TaskColumn } from '../src/shared/types'
import { fmt, setLanguage, tr } from '../src/shared/i18n'
import type { Tr } from '../src/shared/tasks'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

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
    expect(cardSegment(4, card(4, 'passed', ['Review failed', 'Moved to Review', 'Review failed', 'Moved to Review', 'Review passed; Moved to Passed']))).toMatchObject({ state: 'passed', failed: false, round: 3, label: '#4 Card 4 · Approved in round 3' })
    expect(cardSegment(4, card(4, 'todo')).round).toBeNull()
  })

  it('says why a blocked card is blocked, and a card not on the board', () => {
    expect(cardSegment(7, card(7, 'doing', [], { blocked: 'waiting for Darren' }))).toMatchObject({ label: '#7 Card 7 · Active, round 1', notes: ['#7: blocked: waiting for Darren'] })
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
    expect(frozenSegment(lc(5, 'doing', { round: 2 }))).toEqual({ kind: 'card', number: 5, name: '#5', state: 'doing', failed: false, round: 2, label: '#5 Card 5 · Active, round 2, when the lane ended', notes: [] })
    expect(frozenSegment(lc(6, 'passed', { round: 3 }))).toMatchObject({ state: 'passed', round: 3, label: '#6 Card 6 · Approved in round 3, when the lane ended' })
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
  it('shows up to six lanes by default (HI-1673), and only as many as there are', () => {
    expect(DEFAULT_LANE_ROWS).toBe(6)
    expect([1, 2, 3, 6, 7, 9].map((n) => lanesShown(undefined, n))).toEqual([1, 2, 3, 6, 6, 6])
    expect(lanesShown(null, 7)).toBe(6)
  })

  it('a kept choice wins within the range: never fewer than the lanes there are up to six, nor more than ten (HI-1673)', () => {
    expect(lanesShown(8, 9)).toBe(8)
    expect(lanesShown(6, 3)).toBe(3)
    // Dragged (or kept from before) below the floor: every lane up to six still shows.
    expect(lanesShown(1, 5)).toBe(5)
    expect(lanesShown(1, 9)).toBe(6)
    // No more than four over the floor, nor than there are.
    expect(lanesShown(20, 30)).toBe(10)
    expect(lanesShown(20, 8)).toBe(8)
    expect(chosenLaneRows(2.6)).toBe(3)
    expect(chosenLaneRows(0)).toBe(1)
    expect(chosenLaneRows(-4)).toBe(1)
    // A damaged value is no choice.
    expect(chosenLaneRows(Number.NaN)).toBe(6)
    expect(chosenLaneRows(Infinity)).toBe(6)
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

  it('the range: the floor is every lane up to six, the most four more, ten at most (HI-1673)', () => {
    expect(MORE_LANE_ROWS).toBe(4)
    expect([1, 2, 6, 7, 9, 10, 15].map((n) => laneRowsRange(n))).toEqual([
      { min: 1, top: 1 },
      { min: 2, top: 2 },
      { min: 6, top: 6 },
      { min: 6, top: 7 },
      { min: 6, top: 9 },
      { min: 6, top: 10 },
      { min: 6, top: 10 }
    ])
    // A workspace's own lanes shown moves the floor, and the most with it.
    expect(laneRowsRange(9, 3)).toEqual({ min: 3, top: 7 })
  })

  it('the lanes take priority: the floor shows however short the panel; more than it only as far as they fit, and the choice is kept', () => {
    // Darren's two lanes: both show, whatever was chosen, and the range is only those two (no drag hides one).
    expect(laneRowsNow(1, 2, 300, 61)).toEqual({ chosen: 2, shown: 2, min: 2, max: 2 })
    expect(laneRowsNow(undefined, 2, 30, 61)).toEqual({ chosen: 2, shown: 2, min: 2, max: 2 })
    // Ten chosen of twelve, room for seven (61 px a lane): seven show, seven is the most, ten is still the choice.
    expect(laneRowsNow(10, 12, 430, 61)).toEqual({ chosen: 10, shown: 7, min: 6, max: 7 })
    // Room again: the choice shows.
    expect(laneRowsNow(10, 12, 1000, 61)).toEqual({ chosen: 10, shown: 10, min: 6, max: 10 })
    // Short of room for the floor with the runs keeping theirs: the floor all the same, the runs giving way (behind it).
    expect(laneRowsNow(10, 12, 250, 61)).toEqual({ chosen: 10, shown: 6, min: 6, max: 6 })
    // Too short even with the runs given up: the whole lanes that fit, the rest scrolling.
    expect(laneRowsNow(10, 12, 30, 61)).toEqual({ chosen: 10, shown: 2, min: 2, max: 2 })
    // Not measured yet: the choice, up to the most.
    expect(laneRowsNow(undefined, 9, null, 61)).toEqual({ chosen: 6, shown: 6, min: 6, max: 9 })
  })

  it('a drag and the keys stay within the range: never below the floor, never past the most', () => {
    // Nine lanes, six shown: dragged down by two lanes, still six; up by two, eight.
    expect(draggedLaneRows(6, 122, 61, 9, 6)).toBe(6)
    expect(draggedLaneRows(6, -122, 61, 9, 6)).toBe(8)
    expect(keyedLaneRows(6, 'ArrowDown', 9, 6)).toBe(6)
    expect(keyedLaneRows(8, 'Home', 9, 6)).toBe(6)
    expect(keyedLaneRows(6, 'End', 9, 6)).toBe(9)
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
  const badge = (over: Partial<WorkBadge> = {}): WorkBadge => ({ card: 7, stage: 'review', preWorkflow: false, adopted: false, revision: 'a3f2c1d9e8', verdict: null, checks: { passed: 0, failed: 0, notCounted: 0 }, stale: false, stalePass: null, noCode: false, refused: null, overridden: false, override: null, outsideRules: false, mergedInPart: false, leftTarget: false, accepted: false, merged: null, forYou: 0, kind: 'code', kindProposed: null, reviewSkip: null, reviewSkipProposed: null, decisionSince: false, oldRules: false, stages: null, line: null, lines: [], underReview: null, startedAt: null, endedAt: null, lastSeq: 3, ...over })

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
    // Each a whole sentence on a line of its own (HI-1585), the repeats on one after them.
    expect(workNotes(badge({ refused }), 'review', null, short, tr, names, 'AL-7')).toEqual(['AL-7: nothing committed to review.', "Commit the card's work, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing. A card that needs no change is no-code: ask for that with hive_ask_user (action noCode).", 'Under review: a3f2c1d'])
    expect(workNotes(badge({ refused: { ...refused, times: 3 } }), 'doing', null, short, tr, names, 'AL-7').slice(0, 3)).toEqual(['AL-7: nothing committed to review.', "Commit the card's work, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing. A card that needs no change is no-code: ask for that with hive_ask_user (action noCode).", 'Refused 3 times in a row.'])
    // A rule's names in the window's words (move.notFromHere names the stage and the moves).
    expect(workNotes(badge({ revision: null, refused: { move: 'submit', rule: 'move.notFromHere', values: { card: 'alpha-7', stage: 'todo', move: 'submit', moves: 'start' }, at: '', times: 1 } }), 'todo', null, short, tr, names, 'AL-7')[0]).toMatch(/^AL-7 /)
  })

  it("the user's own move refused (HI-1851): a rule worded for agents has the user's words, the card left to the toast's title; others as agents get them", () => {
    const window = { one: (m: Parameters<typeof tr>[0], v?: Record<string, string | number>) => tr(m, v), list: (items: string[]) => items.join(', '), names: true, forUser: true }
    expect(refusalLines('submit.empty', { card: 'AL-7' }, window)).toEqual({ message: 'Nothing is committed to review yet.', next: "Commit the card's work, then move it again.", change: null })
    // An agent's refusal says which next step fits its folder (HI-2227): uncommitted changes to commit, or none (no-code).
    const agent = { ...window, forUser: false }
    expect(refusalLines('submit.empty', { card: 'AL-7', changes: 'yes' }, agent).next).toBe("Commit the card's work, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing.")
    expect(refusalLines('submit.empty', { card: 'AL-7', changes: 'none' }, agent).next).toMatch(/^Its folder has no changes either\. .*no-code: ask for that with hive_ask_user \(action noCode\), or hive_ask_assistant where it's already decided\./)
    expect(refusalLines('submit.unchanged', { card: 'AL-7' }, window).message).toBe("AL-7: its files haven't changed since it started.")
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
    expect(segmentMarks({ frozen: null }, b, seg, short, tr, names)).toEqual({ refused: 'AL-7: nothing committed to review. Commit the card\'s work, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing. A card that needs no change is no-code: ask for that with hive_ask_user (action noCode).', stale: 'Pass was for a3f2c1d; now at b71e09a', override: 'You moved it past its rules: done.contained. No reason given.' })
    expect(segmentMarks({ frozen: null }, badge(), seg, short, tr, names)).toEqual({})
    // Done, a stale pass no longer matters: no stale mark or line.
    expect(segmentMarks({ frozen: null }, b, { ...seg, state: 'done' }, short, tr, names)).not.toHaveProperty('stale')
    expect(workNotes(b, 'done', null, short, tr, names, 'AL-7').some((l) => l.startsWith('Pass was for'))).toBe(false)
    expect(segmentMarks({ frozen: [] }, b, seg, short, tr, names)).toEqual({})
    expect(segmentMarks({ frozen: null }, undefined, seg, short, tr, names)).toEqual({})
  })

  it("folded segments keep their cards' marks (HR6's #1279 round 1): each mark of each folded card, named by its card", () => {
    const o = { by: 'user' as const, move: 'active→done', rules: ['done.contained'], reason: 'Merged by hand', at: '' }
    const segs = [
      { kind: 'card', number: 1, name: 'AL-1', state: 'done', failed: false, round: 1, label: 'AL-1', notes: [] },
      { kind: 'card', number: 2, name: 'AL-2', state: 'passed', failed: false, round: 1, label: 'AL-2', notes: [] },
      { kind: 'card', number: 27, name: 'AL-27', state: 'todo', failed: false, round: null, label: 'AL-27', notes: [] }
    ] as CardSegment[]
    const badges = new Map([
      [1, badge({ card: 1, override: o })],
      [2, badge({ card: 2, stalePass: { approved: 'a3f2c1d9e8', current: 'b71e09a4cc' } })],
      [27, badge({ card: 27, revision: null, refused: { ...refused, values: { card: 'alpha-27' } } })]
    ])
    const marks = foldedMarks({ frozen: null }, badges, segs, [1, 2, 27], () => short, tr, names)
    expect(marks).toEqual({
      refused: ['AL-27: AL-27: nothing committed to review. Commit the card\'s work, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing. A card that needs no change is no-code: ask for that with hive_ask_user (action noCode).'],
      stale: ['AL-2: Pass was for a3f2c1d; now at b71e09a'],
      override: ['AL-1: You moved it past its rules: done.contained. Reason: Merged by hand'],
      oldRules: []
    })
    expect(foldedMarks({ frozen: [] }, badges, segs, [1, 2, 27], () => short, tr, names)).toEqual({ refused: [], stale: [], override: [], oldRules: [] })
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
    // #1438's and #1435's, and #1446's slot being prepared.
    expect(laneWaitText({ reason: 'slot', card: null }, name, tr)).toBe('waiting for a slot')
    expect(laneWaitText({ reason: 'checkCopy', card: 12 }, name, tr)).toBe('waiting for a check copy for HI-12')
    expect(laneWaitText({ reason: 'preparing', card: 12, slot: 'slot-b' }, name, tr)).toBe('waiting: preparing slot-b')
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

describe('stages in a lane (#1421): names over the categories, the divider, the legend, Solo, old rules', () => {
  // A Pair project where Hive merges: Review, Approved and Merging (Merging inside Approved).
  const pairStages = { stages: mustCompile(preset('git', 'pair')).stages, names: {} }
  const solo = { stages: mustCompile(preset('git', 'solo')).stages, names: {} }
  const withBadge = (stage: WorkBadge['stage']) => ({ stage })

  it("a segment says its card's stage: Merging inside Approved, a project's rename; the category's colour stays its state", () => {
    expect(pairStages.stages.map((s) => s.id)).toEqual(expect.arrayContaining(['review', 'approved', 'merging']))
    const merging = segmentStage(card(7, 'passed'), withBadge('merging'), pairStages, tr)
    expect(merging).toMatchObject({ id: 'merging', name: 'Merging', renamed: false })
    const seg = segmentIn(7, card(7, 'passed'), tr, merging)
    expect(seg.state).toBe('passed')
    expect(seg.label).toBe('#7 Card 7 · Merging')
    expect(segmentName(seg)).toContain('Merging')
    expect(segmentIn(8, card(8, 'review'), tr, segmentStage(card(8, 'review'), withBadge('review'), pairStages, tr)).label).toBe('#8 Card 8 · Review, round 1')
    // Renamed by the project (N5): its own name.
    const renamed = { ...pairStages, names: { review: 'Checking' } }
    expect(segmentIn(8, card(8, 'review'), tr, segmentStage(card(8, 'review'), withBadge('review'), renamed, tr)).label).toBe('#8 Card 8 · Checking, round 1')
    // A badge read before the card's last move (another category): its column's stage.
    expect(segmentStage(card(9, 'done'), withBadge('merging'), pairStages, tr).id).toBe('done')
    // No stages known (the project's version control not recorded): the stage's own name, no divider.
    expect(segmentStage(card(9, 'doing'), undefined, undefined, tr)).toEqual({ id: 'active', name: 'Active', renamed: false, category: [] })
  })

  it("Approved with Merging: both in the hover with a divider, the card's own marked; one stage: none", () => {
    const approved = segmentIn(7, card(7, 'passed'), tr, segmentStage(card(7, 'passed'), withBadge('approved'), pairStages, tr))
    expect(approved.stages).toEqual([
      { id: 'approved', name: 'Approved', own: true },
      { id: 'merging', name: 'Merging', own: false }
    ])
    expect(segmentIn(8, card(8, 'review'), tr, segmentStage(card(8, 'review'), withBadge('review'), pairStages, tr)).stages).toBeUndefined()
    // A card still in a stage its project's options no longer produce shows it beside the others (§16.5.2).
    expect(solo.stages.map((s) => s.id)).not.toContain('merging')
    expect(segmentStage(card(7, 'passed'), withBadge('merging'), solo, tr).category.map((s) => s.id)).toContain('merging')
  })

  it('a card On Hold says it waits for you, or its renamed stage', () => {
    const hold = card(5, 'hold')
    expect(segmentIn(5, hold, tr, segmentStage(hold, undefined, pairStages, tr)).label).toBe('#5 Card 5 · On Hold, waiting for you')
    expect(segmentIn(5, hold, tr, segmentStage(hold, undefined, { ...pairStages, names: { hold: 'Parked' } }, tr)).label).toBe('#5 Card 5 · Parked')
  })

  it("the legend: by category in the lanes' order, each with its segment's look and the stages of the projects shown, renames once each", () => {
    const groups = laneLegend([pairStages, { ...pairStages, names: { approved: 'Ready' } }], tr)
    expect(groups.map((g) => g.category)).toEqual(['todo', 'doing', 'review', 'passed', 'done', 'hold'])
    expect(groups.map((g) => g.state)).toEqual(['todo', 'doing', 'review', 'passed', 'done', 'blocked'])
    const approved = groups.find((g) => g.category === 'passed')!
    expect(approved.name).toBe('Approved')
    expect(approved.stages).toEqual(['Approved', 'Merging', 'Ready'])
    // A category whose only stage has its own name lists none.
    expect(groups.find((g) => g.category === 'review')!.stages).toEqual([])
    // No projects known: the categories alone.
    expect(laneLegend([], tr).every((g) => g.stages.length === 0)).toBe(true)
  })

  it("the legend: a stage named as its category but for its spaces lists none (#1496: pt-BR's no-break space)", () => {
    const ptBr: Tr = (m, ...v) => (m.id === 'board.column.todo' ? 'A\u00a0fazer' : m.id === 'workflow.stage.todo' ? 'A fazer' : tr(m, ...v))
    expect(laneLegend([pairStages], ptBr).find((g) => g.category === 'todo')).toMatchObject({ name: 'A\u00a0fazer', stages: [] })
    // Two projects naming a stage alike but for a space: listed once.
    const approved = laneLegend([{ ...pairStages, names: { approved: 'Pronto  já' } }, { ...pairStages, names: { approved: 'Pronto já' } }], tr).find((g) => g.category === 'passed')!
    expect(approved.stages).toEqual(['Pronto  já', 'Merging'])
    // Every language shipped: no category's row repeats its own name.
    const LOCALES = join(__dirname, '..', 'locales')
    try {
      for (const code of readdirSync(LOCALES, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'en' && !d.name.startsWith('.')).map((d) => d.name)) {
        const dir = join(LOCALES, code)
        setLanguage(code, Object.assign({}, ...readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))))
        const repeated = laneLegend([pairStages], tr).filter((g) => g.stages.length === 1)
        expect(repeated, code).toEqual([])
      }
    } finally {
      setLanguage('en', {})
    }
  })

  it("Pulse leaves out a Solo project's ended lanes, never a running one; Pair, Team and none as they are", () => {
    const lanes = [
      { id: 'a', project: 'solo', state: 'ended' as LaneState },
      { id: 'b', project: 'solo', state: 'active' as LaneState },
      { id: 'c', project: 'solo', state: 'paused' as LaneState },
      { id: 'd', project: 'team', state: 'ended' as LaneState },
      { id: 'e', project: 'none', state: 'abandoned' as LaneState }
    ]
    const presets: Record<string, string | null> = { solo: 'solo', team: 'team', none: null }
    expect(pulseLanes(lanes, (p) => presets[p]).map((l) => l.id)).toEqual(['b', 'c', 'd', 'e'])
  })

  it("old rules: the lane's mark and a card's line say what they mean, and that rules aren't enforced when off", () => {
    expect(laneOldRulesNote(true, tr)).toBe('Old rules: this lane started under the workflow options from before they changed, and keeps them until it ends. New lanes and cards use the new options.')
    expect(laneOldRulesNote(false, tr)).toMatch(/Workflow rules aren’t enforced now/)
    const seg = cardSegment(7, card(7, 'doing'))
    const names = { list: (items: string[]) => items.join(', '), ruleName: (id: string) => id }
    const b: WorkBadge = { card: 7, stage: 'active', preWorkflow: false, adopted: false, revision: null, verdict: null, checks: { passed: 0, failed: 0, notCounted: 0 }, stale: false, stalePass: null, noCode: false, refused: null, overridden: false, override: null, outsideRules: false, mergedInPart: false, leftTarget: false, accepted: false, merged: null, forYou: 0, kind: 'code', kindProposed: null, reviewSkip: null, reviewSkipProposed: null, decisionSince: false, oldRules: true, stages: null, line: null, lines: [], underReview: null, startedAt: null, endedAt: null, lastSeq: 3 }
    expect(segmentMarks({ frozen: null }, b, seg, (x) => x, tr, names).oldRules).toBe(cardOldRulesNote(true, tr))
    expect(segmentMarks({ frozen: null }, b, seg, (x) => x, tr, names, false).oldRules).toMatch(/aren’t enforced now/)
    // An ended lane's segments have no marks; nor a card without it.
    expect(segmentMarks({ frozen: [] }, b, seg, (x) => x, tr, names).oldRules).toBeUndefined()
    expect(segmentMarks({ frozen: null }, { ...b, oldRules: false }, seg, (x) => x, tr, names).oldRules).toBeUndefined()
    // Folded into "✓ n" or "+n", the mark isn't lost.
    expect(foldedMarks({ frozen: null }, new Map([[7, b]]), [seg], [7], () => (x) => x, tr, names).oldRules).toEqual([`#7: ${cardOldRulesNote(true, tr)}`])
  })
})

describe("old rules keep their stages (HR4's #1421 round 1): the options now produce others", () => {
  // The project switched to Solo (no review, nothing merging); a lane and its cards still under Pair (Hive merges).
  const pair = mustCompile(preset('git', 'pair')).stages.map((s) => s.id)
  const soloNow = { stages: mustCompile(preset('git', 'solo')).stages, names: { approved: 'Ready' } }

  it("a card in flight keeps its own ruleset's stages for its divider; names are the project's now", () => {
    expect(soloNow.stages.map((s) => s.id)).not.toContain('approved')
    const s = segmentStage(card(7, 'passed'), { stage: 'merging', stages: pair }, soloNow, tr)
    expect(s.category).toEqual([
      { id: 'approved', name: 'Ready' },
      { id: 'merging', name: 'Merging' }
    ])
    // Without its own stages it would read the project's now: Merging alone, no divider.
    expect(segmentStage(card(7, 'passed'), { stage: 'merging' }, soloNow, tr).category.map((x) => x.id)).toEqual(['merging'])
  })

  it("a lane's card in Todo takes its lane's recorded stages", () => {
    // A Todo card's category is Todo, one stage: its lane's stages give the category list it reads from.
    const todo = segmentStage(card(8, 'todo'), undefined, soloNow, tr, pair)
    expect(todo.id).toBe('todo')
    // A lane's Approved card with no badge yet (none read): the lane's stages, Approved and Merging.
    expect(segmentStage(card(9, 'passed'), undefined, soloNow, tr, pair).category.map((x) => x.id)).toEqual(['approved', 'merging'])
  })

  it('the legend lists the stages the lanes shown have: an old-rules lane and its cards, by the names now', () => {
    const badges = new Map([[7, { stages: pair }]])
    const sources = legendSources([{ project: 'alpha', stages: pair, cards: [7], frozen: null }], () => soloNow, badges)
    const approved = laneLegend(sources, tr).find((g) => g.category === 'passed')!
    expect(approved.stages).toEqual(['Ready', 'Merging'])
    // A lane with none recorded, or ended: its project's stages now (no Merging); an ended lane's cards add none.
    const now = laneLegend(legendSources([{ project: 'alpha', stages: null, cards: [], frozen: null }], () => soloNow, new Map()), tr)
    expect(now.find((g) => g.category === 'passed')!.stages).toEqual([])
    const ended = laneLegend(legendSources([{ project: 'alpha', stages: pair, cards: [7], frozen: [] }], () => soloNow, badges), tr)
    expect(ended.find((g) => g.category === 'passed')!.stages).toEqual([])
  })
})

describe('refusals name the user as you in the window, as the user to agents (HI-1585, glossary §1 rule 10)', () => {
  // The window's formats: the board's toast (forUser) and the card's stored refusals (CardWork), neither saying who reads.
  const inCard = { one: (m: Parameters<typeof tr>[0], v?: Record<string, string | number>) => tr(m, v), list: (items: string[]) => fmt.list(items, 'unit'), names: true }
  const toast = { ...inCard, forUser: true }
  const override = { card: 'AL-1', stage: 'done', rules: 'review' }

  it("agents' English is as before", () => {
    const r = refusal('move.needsOverride', override)
    expect(r.next).toBe("Move it anyway only with the user's reason. One they gave with their request is enough (\"I merged it by hand\", say): move it again with override and that reason, in their words. With none, tell them which rules this skips and ask for theirs.")
    expect(r.change).toBe('These rules are set in Version Control, where the user can change them.')
    expect(refusal('loop.followUpChecked', { card: 'AL-1' }).next).toBe("Wait for the reviewer's ok or gaps; if none comes, ask the user.")
    expect(refusal('lane.lineBehind', { card: 'AL-2', line: 'hive/AL-2', target: 'main', earlier: 'AL-1' }).next).toBe('Leave it as it is: Hive brings hive/AL-2 up to date with main once you are idle, or asks the user, and tells you when AL-2 can start.')
    expect(refusal('merge.hiveMerges', { card: 'AL-1', target: 'main', queue: 'paused', waits: 'answer' }).next).toBe('It is in the merge queue for main, which is paused until the user answers in For you: wait for Done, or for it to come back.')
    expect(refusal('platform.unknown', { card: 'AL-1', offer: 'repositoryGone' }).next).toMatch(/^The project's Git repository is gone: ask the user to restore it/)
  })

  it('the window says you, on the card and in the toast alike, in English too', () => {
    for (const f of [inCard, toast]) {
      const l = refusalLines('move.needsOverride', override, f)
      expect(l.next).toBe('Moving it anyway needs your reason: one you gave for it, or one you give once told which rules this skips.')
      expect(l.change).toBe('These rules are set in Version Control, where you can change them.')
    }
    expect(refusalLines('loop.followUpChecked', { card: 'AL-1' }, inCard).next).toBe("The agent waits for the reviewer's ok or gaps; if none comes, it asks you.")
    expect(refusalLines('merge.hiveMerges', { card: 'AL-1', target: 'main', queue: 'paused', waits: 'fix' }, inCard).next).toBe('It is in the merge queue for main, which is paused until you fix what stopped it and resume it; it moves to Done once merged, or comes back.')
    expect(refusalLines('platform.unknown', { card: 'AL-1', offer: 'repositoryGone' }, inCard).next).toMatch(/^The project's Git repository is gone: restore it, or switch the project to None/)
  })

  it("who reads it is never kept in the refusal: one recorded before (no reader) or as an agent's reads as you in the window", () => {
    const r = refusal('move.needsOverride', override)
    expect(r.values).toEqual(override)
    expect(refusalLines(r.rule, r.values, inCard).change).toBe('These rules are set in Version Control, where you can change them.')
    // A recorded value never chooses for the window.
    expect(refusalLines('move.needsOverride', { ...override, reader: 'agent' }, inCard).change).toBe('These rules are set in Version Control, where you can change them.')
  })
})

describe("a lane's wait and its cards' times (HI-1926)", () => {
  const T = Date.parse('2026-10-28T10:00:00.000Z')
  const MIN = 60_000

  it('a wait is stamped when it begins, kept while its reason, card and ask stay, reset when one changes', () => {
    const reviewer = { reason: 'reviewer' as const, card: 5 }
    // The lane listed before: the wait was seen to begin.
    const a = stampWait(undefined, reviewer, T, true)!
    expect(a).toMatchObject({ since: T, observed: true })
    // Later, the same wait (a comment on the card changes nothing in it): kept.
    expect(stampWait(a, { ...reviewer, blocked: undefined }, T + 10 * MIN, true)).toBe(a)
    // Another reason, another card, another ask: a new wait.
    expect(stampWait(a, { reason: 'you', card: 5 }, T + 11 * MIN, true)).toMatchObject({ since: T + 11 * MIN })
    expect(stampWait(a, { reason: 'reviewer', card: 6 }, T + 12 * MIN, true)).toMatchObject({ since: T + 12 * MIN })
    const you = stampWait(undefined, { reason: 'you', card: 5, ask: 'approve' }, T, true)!
    expect(stampWait(you, { reason: 'you', card: 5, ask: 'decide' }, T + MIN, true)).toMatchObject({ since: T + MIN })
    // No longer waiting: none; a wait with no card (a slot) is stamped too.
    expect(stampWait(a, null, T + MIN, true)).toBeUndefined()
    expect(stampWait(undefined, { reason: 'slot', card: null }, T, true)).toMatchObject({ since: T, observed: true })
    // The first listing (Hive just started, or the workspace opened): not seen to begin, so at least that long.
    expect(stampWait(undefined, reviewer, T, false)).toMatchObject({ since: T, observed: false })
  })

  it("its time, marked past its bound: for you (a request, a round limit) and a reviewer, each its own", () => {
    expect(laneWaitTime(null, T, 60, 15)).toBeNull()
    expect(laneWaitTime({ reason: 'reviewer' }, T, 60, 15)).toBeNull()
    expect(laneWaitTime({ reason: 'reviewer', since: T - 14 * MIN }, T, 60, 15)).toEqual({ ms: 14 * MIN, long: false })
    expect(laneWaitTime({ reason: 'reviewer', since: T - 15 * MIN }, T, 60, 15)).toEqual({ ms: 15 * MIN, long: true })
    expect(laneWaitTime({ reason: 'you', since: T - 59 * MIN }, T, 60, 15)!.long).toBe(false)
    expect(laneWaitTime({ reason: 'roundLimit', since: T - 60 * MIN }, T, 60, 15)!.long).toBe(true)
    // The bounds are the settings': changed, they apply.
    expect(laneWaitTime({ reason: 'you', since: T - 5 * MIN }, T, 5, 15)!.long).toBe(true)
    expect(laneWaitTime({ reason: 'reviewer', since: T - 5 * MIN }, T, 60, 30)!.long).toBe(false)
    // Other reasons are never marked long.
    expect(laneWaitTime({ reason: 'slot', since: T - 999 * MIN }, T, 60, 15)!.long).toBe(false)
  })

  it("a card's time: so far while in progress, took and its commit once Done, from its own cycle; nothing it can't know", () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    const badge = (start: number | null, end: number | null, merged: string | null = null) => ({ startedAt: start === null ? null : iso(start), endedAt: end === null ? null : iso(end), merged })
    expect(laneCardTime('doing', badge(T - 20 * MIN, null), null, T)).toEqual({ soFar: 20 * MIN })
    expect(laneCardTime('review', badge(T - 20 * MIN, null), null, T)).toEqual({ soFar: 20 * MIN })
    expect(laneCardTime('done', badge(T - 50 * MIN, T - 10 * MIN, 'abc1234def'), null, T)).toEqual({ took: 40 * MIN, merged: 'abc1234def' })
    // Done with no integration or acceptance known, Todo, or no start known: nothing.
    expect(laneCardTime('done', badge(T - 50 * MIN, null), null, T)).toBeNull()
    expect(laneCardTime('todo', badge(null, null), null, T)).toBeNull()
    expect(laneCardTime('doing', undefined, null, T)).toBeNull()
  })

  it("an ended lane's card: what happened before the lane ended only; a later completion or a reopened cycle shows nothing, an unfinished card's time doesn't run on", () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    const ended = iso(T - 60 * MIN)
    const badge = (start: number, end: number | null, merged: string | null = null) => ({ startedAt: iso(start), endedAt: end === null ? null : iso(end), merged })
    // Done before the lane ended: took, and its commit.
    expect(laneCardTime('done', badge(T - 120 * MIN, T - 90 * MIN, 'abc'), ended, T)).toEqual({ took: 30 * MIN, merged: 'abc' })
    // Completed after the lane ended: never rewrites the lane's history.
    expect(laneCardTime('done', badge(T - 120 * MIN, T - 30 * MIN, 'late'), ended, T)).toBeNull()
    // Reopened later (a cycle that started after the lane ended).
    expect(laneCardTime('doing', badge(T - 10 * MIN, null), ended, T)).toBeNull()
    // Unfinished when the lane ended: no growing "so far".
    expect(laneCardTime('doing', badge(T - 120 * MIN, null), ended, T)).toBeNull()
  })
})
