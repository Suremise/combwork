import { msg } from './i18n/msg'
import { columnName, type Tr } from './tasks'
import type { LaneCard, LaneState, TaskCard, TaskColumn } from './types'
import type { WorkBadge } from './workflow/workView'

/**
 * A lane in the Progress panel (#484): a segmented bar, one equal-width segment per card in the lane's order, coloured
 * and patterned by where the card is. How a card reads there comes from the board alone (its column, blocked reason and
 * review verdicts), so a lane needs only its cards' numbers.
 */

/**
 * A card's segment: Done, Passed, in Review, in Doing, still to do, or blocked / waiting for the user (On Hold); or, in a
 * lane that ended without a record of its cards, unrecorded (not known, #512).
 */
export type SegmentState = 'done' | 'passed' | 'review' | 'doing' | 'todo' | 'blocked' | 'unrecorded'

export interface CardSegment {
  kind: 'card'
  number: number
  state: SegmentState
  /** Its latest review failed and it hasn't gone back for the next round yet. */
  failed: boolean
  /** The round it is in (Doing or Review), failed or passed in; null before its first round and when not on the board. */
  round: number | null
  /** Hover text: "#405 Built-in loop wakes · Review, round 2". */
  label: string
  /**
   * What its marks mean (#706), each a line under the label in its hover and after it in its accessible name: a failed
   * review's red underline ("#650: review failed (round 4): waiting for round 5", then the reviewer's gist) and the red
   * cross-hatching of a blocked or On Hold card (its reason's first line).
   */
  notes: string[]
}

/** Finished cards folded into one segment ("✓ 6"), or the rest of a lane too long for its bar ("+4"). */
export interface FoldedSegment {
  kind: 'finished' | 'more'
  numbers: number[]
  label: string
}

export type LaneSegment = CardSegment | FoldedSegment

/** The narrowest a card's segment gets (px) before finished cards fold into one, and the gap between segments. */
export const SEGMENT_MIN_PX = 12
export const SEGMENT_GAP_PX = 2

const VERDICT = /^Review (passed|failed)/
/** What starts a card's next round after a failed review: back in Review (returned or moved), or a review starting. */
const NEXT_ROUND = /^(Returned for review|Moved to (the (top|bottom) of )?Review\b|Started reviewing)/

/** A history line's parts: one change can note several ("Moved to Review; Returned for review, round 2"). */
const parts = (what: string): string[] => what.split('; ')

const FINISHED: readonly SegmentState[] = ['done', 'passed']
export const isFinished = (s: SegmentState): boolean => FINISHED.includes(s)

function stateOf(c: TaskCard): SegmentState {
  if (c.column === 'done') return 'done'
  if (c.column === 'passed') return 'passed'
  if (c.blocked || c.column === 'hold') return 'blocked'
  if (c.column === 'review') return 'review'
  if (c.column === 'doing') return 'doing'
  return 'todo'
}

/** Its failed reviews, and whether the latest verdict failed with no next round started since. */
export function reviewRounds(c: TaskCard): { failures: number; failedNow: boolean; reviewed: boolean } {
  const lines = c.history.flatMap((h) => parts(h.what))
  const failures = lines.filter((l) => l.startsWith('Review failed')).length
  const last = lines.findLastIndex((l) => VERDICT.test(l))
  const failedNow = last >= 0 && lines[last].startsWith('Review failed') && !lines.slice(last + 1).some((l) => NEXT_ROUND.test(l))
  return { failures, failedNow, reviewed: last >= 0 }
}

/** The longest a note's quoted line (a blocked reason, a reviewer's gist) runs in a segment's hover before it is cut. */
export const SEGMENT_NOTE_MAX = 160

/** A text's first line that isn't blank, cut to SEGMENT_NOTE_MAX. */
function oneLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > SEGMENT_NOTE_MAX ? `${line.slice(0, SEGMENT_NOTE_MAX - 1)}…` : line
}

/** How long after a verdict its comment is taken as the verdict's: both are saved in the same change. */
const VERDICT_COMMENT_MS = 10_000

/** The first line of the comment its reviewer gave with its latest failed verdict, if any (#706). */
export function failedVerdictGist(c: Pick<TaskCard, 'history' | 'comments'>): string | null {
  const v = c.history.findLast((h) => parts(h.what).some((p) => p.startsWith('Review failed')))
  const at = v ? Date.parse(v.at) : NaN
  if (!v || Number.isNaN(at)) return null
  const said = c.comments.find((x) => x.by === v.by && Date.parse(x.at) >= at && Date.parse(x.at) - at <= VERDICT_COMMENT_MS)
  // Plain text in a tooltip: a heading's marks and bold dropped.
  const line = said ? oneLine(said.text.replace(/^\s*#+\s+/gm, '').replace(/\*\*|__/g, '')) : ''
  return line || null
}

/**
 * Why a blocked segment is hatched (#706): "#7: blocked: <its reason's first line>", "#7: On Hold: <reason>", or with no
 * reason, On Hold until the user moves it; null for an ended lane's card On Hold with none (its label says it all).
 */
function blockedNote(n: number, hold: boolean, blocked: string | null, live: boolean, tr: Tr): string | null {
  const reason = blocked ? oneLine(blocked) : ''
  if (reason && hold) return tr(msg({ id: 'board.lane.holdReason', defaultMessage: '#{card}: On Hold: {reason}', description: "A lane segment's note in the Progress panel (its hover): the card is On Hold (a board column), and why, in the user's own words ({reason}). {card} is its number." }), { card: n, reason })
  if (reason) return tr(msg({ id: 'board.lane.blockedReason', defaultMessage: '#{card}: blocked: {reason}', description: "A lane segment's note in the Progress panel (its hover): the card is blocked, and why, in the user's or an agent's own words ({reason}). {card} is its number." }), { card: n, reason })
  if (!hold) return tr(msg({ id: 'board.lane.blocked', defaultMessage: '#{card}: blocked', description: "A lane segment's note in the Progress panel (its hover): the card is blocked, with no reason given. {card} is its number." }), { card: n })
  return live ? tr(msg({ id: 'board.lane.holdWaiting', defaultMessage: '#{card}: On Hold: waiting for you to move it on', description: "A lane segment's note in the Progress panel (its hover): the card is On Hold (a board column) until the user moves it. {card} is its number." }), { card: n }) : null
}

/**
 * Where a card is, for its segment's label: its column, and its review round (#484, #706): "Review, round 2", "Review,
 * round 1 failed review", "Passed in round 3". `hold` is how On Hold reads (live: waiting for you; ended: plain).
 */
function whereText(column: TaskColumn, round: number | null, how: 'failed' | 'in-round' | 'after' | 'none', hold: 'waiting' | 'plain', tr: Tr): string {
  const where = column === 'hold' ? (hold === 'waiting' ? tr(msg({ id: 'board.lane.holdWaitingShort', defaultMessage: 'On Hold, waiting for you', description: "Where a lane's card is, in its segment's label (Progress panel): On Hold (a board column) until the user moves it on." })) : columnName('hold', tr)) : columnName(column, tr)
  if (how === 'none' || round === null) return where
  if (how === 'failed') return tr(msg({ id: 'board.lane.roundFailed', defaultMessage: '{where}, round {round} failed review', description: "Where a lane's card is, in its segment's label (Progress panel): its column ({where}, \"Review\"), and that its review round {round} failed." }), { where, round })
  if (how === 'in-round') return tr(msg({ id: 'board.lane.inRound', defaultMessage: '{where}, round {round}', description: "Where a lane's card is, in its segment's label (Progress panel): its column ({where}, \"Doing\" or \"Review\") and the review round it is in ({round}, a number)." }), { where, round })
  return tr(msg({ id: 'board.lane.afterRound', defaultMessage: '{where} in round {round}', description: "Where a lane's finished card is, in its segment's label (Progress panel): its column ({where}, \"Passed\" or \"Done\") and the review round it passed in ({round}, a number above 1)." }), { where, round })
}

/**
 * What a card's facts say of its work (#1225), a line each under its segment's label in the hover: the revision under
 * review (or its revision), the last verdict and on which revision (and that it no longer counts), the checks on that
 * revision, and its merge commit once Done: its `Integrated` fact's, else the lane's own record of its merge. Revisions
 * through the project's platform (`short`, revisionShort). Nothing for a card with no work recorded.
 */
export function workNotes(b: WorkBadge | undefined, state: SegmentState, laneMerge: string | null, short: (id: string) => string, tr: Tr): string[] {
  const out: string[] = []
  if (b?.revision) out.push(tr(msg({ id: 'board.lane.workRevision', defaultMessage: '{review, select, yes {Under review: {revision}} other {Revision: {revision}}}', description: "A line in a lane segment's hover (Progress panel): the card's revision (a short commit id, a3f2c1d), the one under review when the card is in Review." }), { review: b.stage === 'review' ? 'yes' : 'no', revision: short(b.revision) }))
  if (b?.verdict)
    out.push(
      tr(
        msg({
          id: 'board.lane.workVerdict',
          defaultMessage: '{pass, select, yes {Last verdict: passed} other {Last verdict: failed}}{revision, select, none {} other { on {revision}}}{current, select, no {, which no longer counts} other {}}',
          description: "A line in a lane segment's hover (Progress panel): the card's last review verdict, passed or failed, on which revision (a short commit id; none for a card without one: keep that branch empty), and whether it no longer counts (a newer change or decision since). Keep the select keys as they are."
        }),
        { pass: b.verdict.pass ? 'yes' : 'no', revision: b.verdict.revision ? short(b.verdict.revision) : 'none', current: b.verdict.current ? 'yes' : 'no' } // i18n-ignore: select keys, never shown
      )
    )
  if (b && b.checks.passed + b.checks.failed > 0) out.push(tr(msg({ id: 'board.lane.workChecks', defaultMessage: 'Checks on it: {passed, number} passed, {failed, number} failed', description: "A line in a lane segment's hover (Progress panel): how many of the checks on the card's revision passed and failed (each check's latest run that counted)." }), { passed: b.checks.passed, failed: b.checks.failed }))
  const merge = b?.merged ?? (state === 'done' ? laneMerge : null)
  if (merge && state === 'done') out.push(tr(msg({ id: 'board.lane.workMerged', defaultMessage: 'Merged as {commit}', description: "A line in a lane segment's hover (Progress panel), for a Done card: the commit that merged it (a short commit id)." }), { commit: /^[0-9a-f]{12,}$/i.test(merge) ? short(merge) : merge }))
  return out
}

/** A card segment's accessible name: its label and its notes (#706). */
export function segmentName(s: CardSegment): string {
  return [s.label, ...s.notes].join('. ')
}

/** A card number's segment, from the card as it is on the board (or not: archived and deleted cards may be missing). */
export function cardSegment(n: number, card: TaskCard | undefined, tr: Tr): CardSegment {
  if (!card) return { kind: 'card', number: n, state: 'todo', failed: false, round: null, label: tr(msg({ id: 'board.lane.notOnBoard', defaultMessage: '#{card} · not on the board', description: "A lane segment's label (Progress panel) for a card that isn't on the board (archived or deleted). {card} is its number." }), { card: n }), notes: [] }
  const state = stateOf(card)
  const { failures, failedNow, reviewed } = reviewRounds(card)
  const inRound = card.column === 'doing' || card.column === 'review'
  const failed = failedNow && inRound && !isFinished(state)
  // A failed card is in the round that failed until it goes back; a finished one passed in the round after its failures.
  const round = failed ? failures : inRound || (isFinished(state) && reviewed) ? failures + 1 : null
  const how = failed ? 'failed' : round !== null && inRound ? 'in-round' : round !== null && round > 1 ? 'after' : 'none'
  const what = whereText(card.column, round, how, 'waiting', tr)
  const notes: string[] = []
  // The red underline: which round failed and what comes next, then the reviewer's own one-line gist.
  if (failed) {
    notes.push(tr(msg({ id: 'board.lane.reviewFailed', defaultMessage: '#{card}: review failed (round {round}): waiting for round {next}', description: "A lane segment's note in the Progress panel (its hover, under a red underline): the card's review round {round} failed and the next round ({next}) hasn't started. {card} is its number." }), { card: n, round: round ?? 0, next: (round ?? 0) + 1 }))
    const gist = failedVerdictGist(card)
    if (gist) notes.push(tr(msg({ id: 'board.lane.reviewerGist', defaultMessage: 'Reviewer: {gist}', description: "A lane segment's note in the Progress panel: the first line of the reviewer's failed verdict ({gist}, in the reviewer's own words)." }), { gist }))
  }
  // The red cross-hatching: why it can't go on.
  const why = state === 'blocked' ? blockedNote(n, card.column === 'hold', card.blocked, true, tr) : null
  if (why) notes.push(why)
  return { kind: 'card', number: n, state, failed, round, label: segmentLabel(n, card.title, what, tr), notes }
}

/** "#405 Built-in loop wakes · Review, round 2": a card segment's label. */
const segmentLabel = (n: number, title: string, where: string, tr: Tr): string =>
  tr(msg({ id: 'board.lane.label', defaultMessage: '#{card} {title} · {where}', description: "A lane segment's label (Progress panel): the card's number, title (the user's own words) and where it is ({where}: \"Review, round 2\")." }), { card: n, title, where })

/** A lane card's state as the lane last read it (LaneCard): a gone card reads as still to do, as one not on the board. */
export function laneCardState(c: LaneCard): SegmentState {
  if (c.column === 'unrecorded') return 'unrecorded'
  if (c.column === 'done') return 'done'
  if (c.column === 'passed') return 'passed'
  if (c.blocked || c.column === 'hold') return 'blocked'
  if (c.column === 'review') return 'review'
  if (c.column === 'doing') return 'doing'
  return 'todo'
}

/**
 * A segment as the lane left it when it ended or was abandoned (#512): frozen, so a card another lane works on now never
 * shows as worked here too. The lane keeps no review verdicts, so a frozen segment marks no failed round.
 */
export function frozenSegment(c: LaneCard, tr: Tr): CardSegment {
  const state = laneCardState(c)
  if (c.column === 'gone') return { kind: 'card', number: c.number, state, failed: false, round: null, label: tr(msg({ id: 'board.lane.goneWhenEnded', defaultMessage: '#{card} · not on the board when the lane ended', description: "A lane segment's label (Progress panel), in a lane that has ended: the card wasn't on the board then. {card} is its number." }), { card: c.number }), notes: [] }
  // Ended without a record of its cards: said so, rather than the board's now presented as when it ended.
  if (c.column === 'unrecorded') {
    const label = c.title
      ? tr(msg({ id: 'board.lane.unrecorded', defaultMessage: '#{card} {title} · not recorded: the lane ended before Hive kept where its cards were', description: "A lane segment's label (Progress panel), in a lane that ended before Hive recorded its cards' columns. {card} is the card's number, {title} its title (the user's own words)." }), { card: c.number, title: c.title })
      : tr(msg({ id: 'board.lane.unrecordedUntitled', defaultMessage: '#{card} · not recorded: the lane ended before Hive kept where its cards were', description: "A lane segment's label (Progress panel), in a lane that ended before Hive recorded its cards' columns. {card} is the card's number." }), { card: c.number })
    return { kind: 'card', number: c.number, state, failed: false, round: null, label, notes: [] }
  }
  const inRound = c.column === 'doing' || c.column === 'review'
  const round = inRound || isFinished(state) ? c.round : null
  const what = whereText(c.column, round, round !== null && inRound ? 'in-round' : round !== null && round > 1 ? 'after' : 'none', 'plain', tr)
  const why = state === 'blocked' ? blockedNote(c.number, c.column === 'hold', c.blocked, false, tr) : null
  const label = tr(msg({ id: 'board.lane.labelWhenEnded', defaultMessage: '#{card} {title} · {where}, when the lane ended', description: "A lane segment's label (Progress panel), in a lane that has ended: the card's number, title (the user's own words) and where it was then ({where}: \"Review, round 2\")." }), { card: c.number, title: c.title, where: what })
  return { kind: 'card', number: c.number, state, failed: false, round, label, notes: why ? [why] : [] }
}

/**
 * The card a lane is on (#512): the one its builder is building (the first in Doing that isn't blocked), else the first
 * in Review, else the first still to do. `waiting`: the lane can't go on until the user answers: its first unfinished
 * card is blocked (or On Hold) and no other is in Doing or Review; that card is then the current one. A builder that
 * moved on to the next card while a blocked one waits is working, not waiting. `finished` defaults to Passed or Done.
 */
export function currentCard(cards: readonly { number: number; state: SegmentState; finished?: boolean }[]): { current: number | null; waiting: boolean } {
  const open = cards.filter((c) => !(c.finished ?? isFinished(c.state)))
  if (!open.length) return { current: null, waiting: false }
  const free = open.filter((c) => c.state !== 'blocked')
  const worked = free.find((c) => c.state === 'doing') ?? free.find((c) => c.state === 'review')
  if (open[0].state === 'blocked' && !worked) return { current: open[0].number, waiting: true }
  return { current: (worked ?? free[0] ?? open[0]).number, waiting: false }
}

const GROUP: Record<LaneState, number> = { active: 0, paused: 1, ended: 2, abandoned: 2 }

/** A lane still running (active or paused), which the user can move; an ended or abandoned one has finished. */
export const laneRunning = (state: LaneState): boolean => GROUP[state] < 2

/**
 * The panel's order of lanes (#512, #568): the running ones (active and paused), then the finished ones (ended and
 * abandoned) in the order they finished, the latest last. Running lanes are in the user's order (`order`: lane ids,
 * kept per workspace) once they have moved one: lanes it doesn't name (started since) on top, newest first (paused or
 * not), then the others as it has them. Without one, active before paused, newest first in each.
 */
export function panelOrder<T extends { id: string; state: LaneState; startedAt: string; endedAt: string | null }>(lanes: readonly T[], order: readonly string[] = []): T[] {
  const placed = new Map(order.map((id, i) => [id, i]))
  const rank = (l: T): number => placed.get(l.id) ?? -1
  // With an order, the lanes it doesn't name are newest first whatever their state (a new lane paused at once, on a
  // blocked card, still arrives on top); without one, active before paused (#512).
  const group = (l: T): number => (placed.size ? 0 : GROUP[l.state])
  const running = lanes.filter((l) => laneRunning(l.state)).sort((a, b) => rank(a) - rank(b) || group(a) - group(b) || b.startedAt.localeCompare(a.startedAt))
  const finished = lanes.filter((l) => !laneRunning(l.state)).sort((a, b) => (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt))
  return [...running, ...finished]
}

/**
 * The running lanes' order (ids) once `id` is dropped before `before` (another running lane), or after the last of them
 * (null); null when that leaves it where it is.
 */
export function droppedLaneOrder(running: readonly string[], id: string, before: string | null): string[] | null {
  if (!running.includes(id) || before === id) return null
  const rest = running.filter((x) => x !== id)
  const at = before === null ? rest.length : rest.indexOf(before)
  if (at < 0) return null
  const next = [...rest.slice(0, at), id, ...rest.slice(at)]
  return next.join('\n') === running.join('\n') ? null : next
}

/** The most lanes a kept order names: more than ever run at once. */
export const LANE_ORDER_MAX = 100

/** A lane order as it is kept: lane ids, each once, at most LANE_ORDER_MAX; anything else is no order ([]). */
export function keptLaneOrder(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, LANE_ORDER_MAX)
}

/**
 * A new order of the lanes shown (the panel filtered to a project or an agent) as the whole workspace's: the lanes not
 * shown keep their places, and the shown ones fill theirs in their new order.
 */
export function mergedLaneOrder(all: readonly string[], shownNext: readonly string[]): string[] {
  const shown = new Set(shownNext)
  const next = [...shownNext]
  return all.map((id) => (shown.has(id) ? (next.shift() ?? id) : id))
}

/** The running lanes' order (ids) once `id` moves a place up (-1) or down (1); null at the end it can't pass. */
export function nudgedLaneOrder(running: readonly string[], id: string, by: -1 | 1): string[] | null {
  const i = running.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= running.length) return null
  const next = [...running]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

/** Every card of a lane as a segment, in the lane's order. */
export function laneCards(numbers: readonly number[], tasks: readonly TaskCard[], tr: Tr): CardSegment[] {
  const byNumber = new Map(tasks.map((t) => [t.number, t]))
  return numbers.map((n) => cardSegment(n, byNumber.get(n), tr))
}

/** How many segments fit in a bar this wide (at least three: the finished fold, a card and the rest). */
export function segmentsThatFit(widthPx: number): number {
  return Math.max(3, Math.floor((widthPx + SEGMENT_GAP_PX) / (SEGMENT_MIN_PX + SEGMENT_GAP_PX)))
}

/** Joins a list in the window's language (`fmt.list`): this module is also reached from hive-mcp, which never loads the translations. */
type ListOf = (items: string[], type?: 'conjunction' | 'unit') => string

/** "#3, #4, #5", or the first eight and how many more as the list's last item ("#1, #2 … #8 and 3 more"). */
function cardList(ns: number[], tr: Tr, list: ListOf): string {
  const shown = ns.slice(0, 8).map((n) => `#${n}`)
  return ns.length > 8 ? list([...shown, tr(msg({ id: 'board.lane.andMore', defaultMessage: '{n, plural, one {# more} other {# more}}', description: "The last item of a folded lane segment's list of cards (Progress panel), after the first eight card numbers: how many more there are ({n}). Hive joins it to the list (\"#1, #2 … #8 and 3 more\")." }), { n: ns.length - 8 })]) : list(shown, 'unit')
}

/**
 * The bar's segments when there's room for `max`: every card while they fit; past that, the finished cards (Passed and
 * Done) fold into one "✓ n" segment at the left, and if that isn't enough either, the last ones fold into "+n".
 */
export function fitSegments(cards: CardSegment[], max: number, tr: Tr, list: ListOf): LaneSegment[] {
  if (cards.length <= max) return cards
  const finished = cards.filter((c) => isFinished(c.state))
  const rest = cards.filter((c) => !isFinished(c.state))
  const out: LaneSegment[] = finished.length ? [{ kind: 'finished', numbers: finished.map((c) => c.number), label: tr(msg({ id: 'board.lane.finished', defaultMessage: '{n, plural, one {# finished: {cards}} other {# finished: {cards}}}', description: "A lane segment's label (Progress panel) for its finished cards folded into one: how many ({n}) and which ({cards}: \"#3, #4\")." }), { n: finished.length, cards: cardList(finished.map((c) => c.number), tr, list) }) }] : []
  const room = Math.max(1, max - out.length)
  if (rest.length <= room) return [...out, ...rest]
  const more = rest.slice(room - 1)
  return [...out, ...rest.slice(0, room - 1), { kind: 'more', numbers: more.map((c) => c.number), label: tr(msg({ id: 'board.lane.more', defaultMessage: '{n, plural, one {# more: {cards}} other {# more: {cards}}}', description: "A lane segment's label (Progress panel) for the cards that don't fit its bar, folded into one: how many ({n}) and which ({cards}: \"#3, #4\")." }), { n: more.length, cards: cardList(more.map((c) => c.number), tr, list) }) }]
}

/** A lane's header numbers: its finished cards out of all, and the card it is on (currentCard). */
export function laneSummary(cards: CardSegment[]): { finished: number; total: number; current: number | null } {
  return { finished: cards.filter((c) => isFinished(c.state)).length, total: cards.length, current: currentCard(cards).current }
}

/**
 * How many lanes the Progress panel's lanes section shows before it scrolls (#569): up to four by default (Settings →
 * Advanced → Progress panel: lanes shown, and a workspace's own: #367, the `fallback` below); the user drags
 * the section's top edge (or presses Up and Down on it) for more or fewer, in whole lanes, kept per workspace. With fewer
 * lanes than that, the section is only as tall as they are.
 */
export const DEFAULT_LANE_ROWS = 4

/** The height the runs above keep (px) when the lanes are dragged up: about a run and a half. */
export const RUNS_KEEP_PX = 120

/** A kept choice as a whole number of lanes, at least one; the default (`fallback`) when there is none (or it isn't a number). */
export function chosenLaneRows(kept: number | null | undefined, fallback = DEFAULT_LANE_ROWS): number {
  return typeof kept === 'number' && Number.isFinite(kept) ? Math.max(1, Math.round(kept)) : fallback
}

/** The lanes shown: the choice, but never more than there are (no empty space) and at least one. */
export function lanesShown(kept: number | null | undefined, count: number, fallback = DEFAULT_LANE_ROWS): number {
  return Math.max(1, Math.min(count, chosenLaneRows(kept, fallback)))
}

/**
 * The most lanes the section can show: no more than there are, nor than fit in `roomPx` (the list's height now and what
 * the runs above can give up, keeping RUNS_KEEP_PX) at `pitchPx` a lane; always at least one.
 */
export function maxLaneRows(count: number, roomPx: number, pitchPx: number): number {
  const fit = pitchPx > 0 ? Math.floor((roomPx + 1) / pitchPx) : count
  return Math.max(1, Math.min(count, fit))
}

/**
 * The lanes shown now: the choice, but no more than fit in `roomPx` (null: not measured yet), so a panel too short for
 * the choice shows whole lanes and leaves the runs their room; the choice itself is kept for when there is room again.
 * `max` is the most that fit, the splitter's maximum.
 */
export function laneRowsNow(kept: number | null | undefined, count: number, roomPx: number | null, pitchPx: number, fallback = DEFAULT_LANE_ROWS): { chosen: number; shown: number; max: number } {
  const chosen = lanesShown(kept, count, fallback)
  const max = roomPx === null ? count : maxLaneRows(count, roomPx, pitchPx)
  return { chosen, shown: Math.min(chosen, max), max }
}

/** Dragging the top edge by `dyPx` (negative is up, showing more) from `startRows`, snapped to whole lanes. */
export function draggedLaneRows(startRows: number, dyPx: number, pitchPx: number, max: number): number {
  const rows = pitchPx > 0 ? Math.round(startRows - dyPx / pitchPx) : startRows
  return Math.max(1, Math.min(max, rows))
}

/** A key on the focused edge: Up shows a lane more, Down one fewer, Home one, End as many as fit; null for other keys. */
export function keyedLaneRows(rows: number, key: string, max: number): number | null {
  const next = key === 'ArrowUp' ? rows + 1 : key === 'ArrowDown' ? rows - 1 : key === 'Home' ? 1 : key === 'End' ? max : null
  return next === null ? null : Math.max(1, Math.min(max, next))
}
