import { msg } from './i18n/msg'
import { columnName, type Tr } from './tasks'
import { cardLabel } from './projectKeys'
import type { LaneCard, LaneState, LaneStatus, TaskCard, TaskColumn } from './types'
import type { WorkBadge, WorkOverride, WorkRefusal } from './workflow/workView'
import type { StageId } from './workflow/facts'

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
  /** Its name as the window gives it (#1221): its key, else #n. */
  name?: string
  state: SegmentState
  /** Its latest review failed and it hasn't gone back for the next round yet. */
  failed: boolean
  /** The round it is in (Doing or Review), failed or passed in; null before its first round and when not on the board. */
  round: number | null
  /** Hover text: "#405 Built-in loop wakes · Review, round 2", by the card's stage name (#1421). */
  label: string
  /**
   * Where its category has more than one stage (Approved and Merging, #1421): each of them by name in board order, the
   * card's own marked, for its hover's divided line. Absent with one stage, and in an ended lane.
   */
  stages?: { id: StageId; name: string; own: boolean }[]
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
function blockedNote(name: string, hold: boolean, blocked: string | null, live: boolean, tr: Tr): string | null {
  const reason = blocked ? oneLine(blocked) : ''
  if (reason && hold) return tr(msg({ id: 'board.lane.holdReason', defaultMessage: '{card}: On Hold: {reason}', description: "A lane segment's note in the Progress panel (its hover): the card is On Hold (a board column), and why, in the user's own words ({reason}). {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: name, reason })
  if (reason) return tr(msg({ id: 'board.lane.blockedReason', defaultMessage: '{card}: blocked: {reason}', description: "A lane segment's note in the Progress panel (its hover): the card is blocked, and why, in the user's or an agent's own words ({reason}). {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: name, reason })
  if (!hold) return tr(msg({ id: 'board.lane.blocked', defaultMessage: '{card}: blocked', description: "A lane segment's note in the Progress panel (its hover): the card is blocked, with no reason given. {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: name })
  return live ? tr(msg({ id: 'board.lane.holdWaiting', defaultMessage: '{card}: On Hold: waiting for you to move it on', description: "A lane segment's note in the Progress panel (its hover): the card is On Hold (a board column) until the user moves it. {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: name }) : null
}

/**
 * Where a card is, for its segment's label: its column, and its review round (#484, #706): "Review, round 2", "Review,
 * round 1 failed review", "Passed in round 3". `hold` is how On Hold reads (live: waiting for you; ended: plain).
 */
function whereText(column: TaskColumn, round: number | null, how: 'failed' | 'in-round' | 'after' | 'none', hold: 'waiting' | 'plain', tr: Tr, stage?: SegmentStage): string {
  // By its stage's name (#1421: "Merging" inside Approved, a project's rename); On Hold says it waits for you unless renamed.
  const named = stage && (column !== 'hold' || stage.renamed) ? stage.name : null
  const where = named ?? (column === 'hold' ? (hold === 'waiting' ? tr(msg({ id: 'board.lane.holdWaitingShort', defaultMessage: 'On Hold, waiting for you', description: "Where a lane's card is, in its segment's label (Progress panel): On Hold (a board column) until the user moves it on." })) : columnName('hold', tr)) : columnName(column, tr))
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
/** How a move past a card's rules names them (#1275): the window's list and each rule's name; hive-mcp passes none. */
export interface OverrideNames {
  list: ListOf
  ruleName: (id: string) => string
  /**
   * A refusal's reason and next step in the window's language (#1279: refusals.ts's `refusalLines`, which this module
   * doesn't import: hive-mcp reaches it, and must never load the translations). Without it, no refused line.
   */
  refusal?: (rule: string, values: WorkRefusal['values']) => { message: string; next: string }
}

/** A move past a card's rules (#1275, §16.8.4): who made it, the rules it skipped and why, for its mark and hover. */
export function overrideNote(o: WorkOverride, tr: Tr, names: OverrideNames): string {
  const reason = o.reason.trim()
  return tr(msg({ id: 'board.work.badgeOverride', defaultMessage: '{by, select, assistant {The Assistant moved it past its rules} other {You moved it past its rules}}: {rules}. {hasReason, select, yes {Reason: {reason}} other {No reason given.}}', description: "Tooltip and accessible name of a mark on a board card (and a line in its lane segment's hover): a move made an exception to the card's workflow rules (glossary: override), by the user (other) or the Hive Assistant (assistant) (select: translate each); {rules} lists the rules it skipped (their names); then the reason the user or the Assistant gave (their own words), or that none was given. Glossary: rule, override." }), { by: o.by, rules: names.list(o.rules.map(names.ruleName), 'unit'), hasReason: reason ? 'yes' : 'no', reason }) // i18n-ignore: select keys, never shown
}

/**
 * A refused request (#1279), in the window's language as the agent got it in English: its reason and its next step, each
 * a whole sentence on a line of its own (glossary §1 rule 3, HI-1585), then how many times in a row it was refused when
 * more than once. `name`: the card as the window names it.
 */
export function refusedNote(r: WorkRefusal, tr: Tr, lines: NonNullable<OverrideNames['refusal']>, name?: string): string[] {
  const l = lines(r.rule, { ...r.values, ...(name && r.values.card !== undefined ? { card: name } : {}) })
  const times = r.times > 1 ? [tr(msg({ id: 'board.lane.workRefused', defaultMessage: 'Refused {times, number} times in a row.', description: "A line in a lane segment's hover (Progress panel), for its red notch, after the refusal's reason and next step (each a line of its own): the card's latest request was refused by its workflow rules this many times in a row ({times}, more than one). Glossary: refused, rule." }), { times: r.times })] : []
  return [l.message, l.next, ...times]
}

/** A content-stale pass (#1279): "Pass was for a3f2c1d; now at b71e09a", revisions through the project's platform. */
export function stalePassNote(p: { approved: string | null; current: string | null }, short: (id: string) => string, tr: Tr): string {
  return tr(msg({ id: 'board.lane.workStalePass', defaultMessage: '{now, select, none {Pass was for {approved}: it no longer holds} other {Pass was for {approved}; now at {current}}}', description: "A line in a lane segment's hover (Progress panel), with its stale mark: the card's pass was for one revision ({approved}, a short commit id) and the card is at another now ({current}); none: the revision now isn't known. Keep the select keys." }), { approved: p.approved ? short(p.approved) : '?', current: p.current ? short(p.current) : '', now: p.current ? 'yes' : 'none' }) // i18n-ignore: select keys and a placeholder, never shown
}

export function workNotes(b: WorkBadge | undefined, state: SegmentState, laneMerge: string | null, short: (id: string) => string, tr: Tr, names?: OverrideNames, name?: string): string[] {
  const out: string[] = []
  // A no-code card has no commits (#1279): it says so, and has no revision or merge lines.
  if (b?.noCode) out.push(tr(msg({ id: 'board.lane.workNoCode', defaultMessage: 'No-code card: no commits', description: "A line in a lane segment's hover (Progress panel): the card is a no-code card (its work isn't code), so it has no commits to show. Glossary: no-code card." })))
  if (b?.refused && names?.refusal) out.push(...refusedNote(b.refused, tr, names.refusal, name))
  // Stale until it is submitted again; once Done (merged, or moved there past its rules) it no longer matters.
  if (b?.stalePass && state !== 'done') out.push(stalePassNote(b.stalePass, short, tr))
  if (b?.revision && !b.noCode) out.push(tr(msg({ id: 'board.lane.workRevision', defaultMessage: '{review, select, yes {Under review: {revision}} other {Revision: {revision}}}', description: "A line in a lane segment's hover (Progress panel): the card's revision (a short commit id, a3f2c1d), the one under review when the card is in Review." }), { review: b.stage === 'review' ? 'yes' : 'no', revision: short(b.revision) }))
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
  if (b?.override && names) out.push(overrideNote(b.override, tr, names))
  const merge = b?.merged ?? (state === 'done' ? laneMerge : null)
  if (merge && state === 'done' && !b?.noCode) out.push(tr(msg({ id: 'board.lane.workMerged', defaultMessage: 'Merged as {commit}', description: "A line in a lane segment's hover (Progress panel), for a Done card: the commit that merged it (a short commit id)." }), { commit: /^[0-9a-f]{12,}$/i.test(merge) ? short(merge) : merge }))
  return out
}

/**
 * A lane segment's work lines (#1225), as the lane's row shows them. A running lane's card reads its facts now (`badge`,
 * this cycle's). An ended or abandoned lane shows its cards as it left them (#512): a card taken on again later is in a
 * later cycle whose revision, verdicts, checks and merge aren't this lane's (HR5's #1225 round 1), so its segments say
 * only the lane's own record of its merge.
 */
export function laneSegmentWork(lane: { frozen: unknown; mergeCommit: string | null }, badge: WorkBadge | undefined, s: CardSegment, short: (id: string) => string, tr: Tr, names?: OverrideNames): string[] {
  return workNotes(lane.frozen ? undefined : badge, s.state, lane.mergeCommit, short, tr, names, s.name)
}

/**
 * A running lane's segment marks from its card's facts (#1279), each by pattern and colour beside the state's, with what
 * it means (its accessible name says it too): a request refused (a red notch, cleared by the card's next move), a stale
 * pass (amber dashed edges, until it is submitted again or is Done), a move past its rules (a corner mark). An ended lane's
 * segments have none (their facts may be a later cycle's).
 */
export interface SegmentMarks {
  refused?: string
  stale?: string
  override?: string
  /** In flight under old rules (#1421): the options changed since it started (a fact, shown whether rules are enforced or not). */
  oldRules?: string
}

/** `enforced`: whether workflow rules are enforced now (Settings → Advanced): off, an old rules line says so. */
export function segmentMarks(lane: { frozen: unknown }, b: WorkBadge | undefined, s: CardSegment, short: (id: string) => string, tr: Tr, names: OverrideNames, enforced = true): SegmentMarks {
  if (lane.frozen || !b) return {}
  return {
    // Its sentences side by side, for the mark's accessible name and a folded segment's line: each one whole.
    ...(b.refused && names.refusal ? { refused: refusedNote(b.refused, tr, names.refusal, s.name).join(' ') } : {}),
    ...(b.stalePass && s.state !== 'done' ? { stale: stalePassNote(b.stalePass, short, tr) } : {}),
    ...(b.override ? { override: overrideNote(b.override, tr, names) } : {}),
    ...(b.oldRules && s.state !== 'done' ? { oldRules: cardOldRulesNote(enforced, tr) } : {})
  }
}

/**
 * Why a running lane waits (#1270's status, #1279), for its header and accessible name: "waiting for you (approval)",
 * "waiting: HI-11 not merged", "waiting for a reviewer on HI-12", "list changes after HI-12". `name`: a card as the
 * window names it (its key).
 */
export function laneWaitText(s: LaneStatus, name: (n: number) => string, tr: Tr): string {
  const card = s.card !== null ? name(s.card) : ''
  // Its slot being prepared (#1446): not a pause, said with the slot's name.
  // One of its agents owed its new conversation (HI-2034): waiting for it to be free, or no more tried (the user retries
  // it from the row, or ends the lane).
  if (s.reason === 'startWait' && s.why === 'fresh' && !s.freshBlocked) return tr(msg({ id: 'board.lanes.waitsFresh', defaultMessage: 'waiting: {agent} starts in a new conversation once it is free', description: "Why a lane waits, in its header in the Progress panel, lower case (HI-2034): its agent {agent} (an agent's name) was busy as the lane started (in a turn, or reading a message), so Hive starts it in a new conversation with the lane's brief once it is free. The lane isn't paused." }), { agent: s.agent ?? '' })
  if (s.reason === 'startWait' && s.why === 'fresh') return tr(msg({ id: 'board.lanes.freshBlocked', defaultMessage: '{agent}’s new conversation didn’t start ({why, select, timeout {it wasn’t free in time} uncertain {Hive closed as it started} other {{reason}}}): retry it, or end the lane', description: "Why a lane waits, in its header in the Progress panel (HI-2034): its agent {agent} (an agent's name) is owed a new conversation for the lane, and Hive stopped trying. why (select): it wasn't free within the wait (Settings → Advanced); Hive closed while starting it, so it may not have started; or (other) its start failed, {reason} saying why (a sentence, may be in English). The row's Retry New Conversation button tries again. Translate each." }), { agent: s.agent ?? '', why: s.freshBlocked ?? 'failed', reason: s.freshWhy ?? '' }) // i18n-ignore: select keys, never shown
  // Its card due to start and not started yet (HI-2029): why, said at once (not a pause).
  if (s.reason === 'startWait' && s.why === 'dependencies') return tr(msg({ id: 'board.lanes.waitsDependency', defaultMessage: '{card} waits to start: it waits for {dependency} to merge', description: "Why a lane waits, in its header in the Progress panel (HI-2129): its card {card} (its key, such as HI-12) is due to start, but it depends on the card {dependency} (its key, such as HI-11), which isn't merged (Done) yet, and the project's workflow starts a card only once the cards it depends on are. Hive starts it once that card is merged. The lane isn't paused." }), { card, dependency: s.waitsFor ?? '' })
  if (s.reason === 'startWait') return tr(msg({ id: 'board.lanes.waitsStart', defaultMessage: '{card} waits to start: {why, select, watching {{agent} is waiting on other work} queued {a line of Hive’s is on its way to {agent}} failed {{agent}’s last start failed} refused {its start was refused for now, and Hive tries again} other {{agent} is in a turn}}', description: "Why a lane waits, in its header in the Progress panel (HI-2029): its card {card} (its key, such as HI-12) is due to start but isn't started yet. why (select): its builder {agent} (an agent's name) is waiting on other work (a card watch); a line Hive types (a message or a wake) is about to reach it; its last start failed; Hive's start was refused for now and is tried again; or (other) it is in a turn (working, starting, waiting for the user). Translate each. The lane isn't paused." }), { card, why: s.why ?? 'busy', agent: s.agent ?? '' }) // i18n-ignore: select keys, never shown
  if (s.reason === 'teamPause') return tr(msg({ id: 'board.lanes.teamPause', defaultMessage: 'paused: the team is pausing', description: "Why a lane waits, in its header in the Progress panel, lower case (HI-2081): the user (or the Hive Assistant) paused the whole team before an update, so Hive starts none of the lane's cards and wakes none of its agents until the team resumes. 'The team' is every agent of the workspace." }))
  if (s.reason === 'preparing') return tr(msg({ id: 'board.lanes.waitsPreparing', defaultMessage: 'waiting: preparing {slot}', description: "Why a lane waits, in its header in the Progress panel, lower case: Hive is preparing its slot (a working folder it lends to the lane: its setup command or a dependency install before the next card). {slot} is the slot's name, such as slot-b: keep it as it is. The lane isn't paused." }), { slot: s.slot ?? '' })
  return tr(
    msg({
      id: 'board.lanes.waits',
      defaultMessage:
        '{reason, select, blocked {{card} is blocked} hold {{card} is On Hold} you {waiting for you ({ask, select, approve {approval} decide {a decision} test {a test} signIn {a sign-in} other {an answer}}): {card}} roundLimit {waiting for you: {card} reached its round limit} notMerged {waiting: {card} not merged} merging {waiting: {card} merging} stale {stale: {card} must be submitted again} reviewer {waiting for a reviewer on {card}} lineUpdate {waiting: bringing the builder’s branch up to date before {card}} hooks {paused: {agent}\'s hooks aren\'t arriving} checkCopy {waiting for a check copy for {card}} slot {waiting for a slot} other {list changes after {card}}}',
      description:
        "Why a lane (a builder and its reviewer working through cards) waits, in its header in the Progress panel, lower case. {card} is a card's name (its key, such as HI-12). reason: blocked or On Hold (a board column); waiting for the user (ask: for their approval, a decision, a test, a sign-in or another answer); at its round limit (the user decides how to go on); a card passed but not merged yet (or merging now), so the next can't start (one card at a time); its pass is stale (the builder must submit again); nobody reviews it; Hive brings the builder's branch up to date before that card (after a squash merge, #1271); hooks: the agent {agent} (a name) has stopped sending Hive its hooks (the calls that tell Hive what it is doing), so the lane is paused; checkCopy: its review or check waits for a check copy (a folder Hive keeps at one revision for a review or an isolated check) to be free; slot: every slot (a working folder Hive lends to a card or a lane) is in use, so the lane can't start until one is free; changes to the lane's list of cards apply once that card is done (other). Keep the select keys. Glossary: lane, round limit, stale."
    }),
    { reason: s.reason, ask: s.ask ?? 'other', card, agent: s.agent ?? '' } // i18n-ignore: select keys, never shown
  )
}

/** What queuedChange reads of a lane: the window's Lane, or main's. */
export interface QueuedLane {
  id: string
  state: LaneState
  builder: { name: string }
  cards: readonly number[]
  info: readonly Pick<LaneCard, 'number' | 'column' | 'elsewhere'>[]
  queued: readonly number[] | null
  status: LaneStatus | null
}

/**
 * A running lane's queued list change (HI-2151, #1270), as Progress → Lanes shows it under its cards: the card in flight
 * it applies after (null: none known), the cards it adds, those it takes off (each with the builder of another running
 * lane whose list will have it, its queued one when it has one, else its cards; else null), and the whole new list when
 * the cards it keeps change order. Null: none queued, or one the same as its cards.
 */
export interface QueuedChange {
  after: number | null
  added: number[]
  removed: { card: number; to: string | null }[]
  order: number[] | null
}

export function queuedChange(lane: QueuedLane, all: readonly QueuedLane[]): QueuedChange | null {
  const q = lane.queued
  if (!q || (lane.state !== 'active' && lane.state !== 'paused')) return null
  const now = new Set(lane.cards)
  const next = new Set(q)
  const added = q.filter((n) => !now.has(n))
  const others = all.filter((l) => l.id !== lane.id && (l.state === 'active' || l.state === 'paused'))
  const removed = lane.cards.filter((n) => !next.has(n)).map((card) => ({ card, to: others.find((l) => (l.queued ?? l.cards).includes(card))?.builder.name ?? null }))
  const kept = q.filter((n) => now.has(n))
  const was = lane.cards.filter((n) => next.has(n))
  const order = kept.some((n, i) => n !== was[i]) ? [...q] : null
  if (!added.length && !removed.length && !order) return null
  // As its status names it, else its own card in flight (Active, In review or Approved), as main keys the change to it.
  const flying = lane.info.find((c) => !c.elsewhere && (c.column === 'doing' || c.column === 'review' || c.column === 'passed'))
  const after = lane.status?.reason === 'listChanges' && lane.status.card !== null ? lane.status.card : (flying?.number ?? null)
  return { after, added, removed, order }
}

/**
 * A queued list change in a line (HI-2151): "Next, once HI-2148 is Done: HI-2149 added, HI-2121 moves to HB6’s lane".
 * `name`: a card as the window names it (its key).
 */
export function queuedChangeText(c: QueuedChange, name: (n: number) => string, tr: Tr, list: ListOf): string {
  const cards = (ns: readonly number[], type: 'conjunction' | 'unit' = 'conjunction'): string => list(ns.map(name), type)
  const said: string[] = []
  if (c.added.length) said.push(tr(msg({ id: 'board.lanes.queuedAdded', defaultMessage: '{n, plural, one {{cards} added} other {{cards} added}}', description: "Part of a lane's queued list change (Progress panel → Lanes, HI-2151): the cards {cards} (their keys, such as HI-12, joined: \"HI-12 and HI-13\"; {n} of them) are added to the lane's list. Hive joins the parts with commas." }), { n: c.added.length, cards: cards(c.added) }))
  const off = c.removed.filter((r) => r.to === null).map((r) => r.card)
  if (off.length) said.push(tr(msg({ id: 'board.lanes.queuedRemoved', defaultMessage: '{n, plural, one {{cards} taken off} other {{cards} taken off}}', description: "Part of a lane's queued list change (Progress panel → Lanes, HI-2151): the cards {cards} (their keys, joined; {n} of them) are taken off the lane's list. Hive joins the parts with commas." }), { n: off.length, cards: cards(off) }))
  const to = [...new Set(c.removed.flatMap((r) => (r.to === null ? [] : [r.to])))]
  for (const builder of to) {
    const moved = c.removed.filter((r) => r.to === builder).map((r) => r.card)
    said.push(tr(msg({ id: 'board.lanes.queuedMoves', defaultMessage: '{n, plural, one {{cards} moves to {builder}’s lane} other {{cards} move to {builder}’s lane}}', description: "Part of a lane's queued list change (Progress panel → Lanes, HI-2151): the cards {cards} (their keys, joined; {n} of them) leave this lane's list for another lane's, whose builder is {builder} (an agent's name, such as HB6). Hive joins the parts with commas." }), { n: moved.length, cards: cards(moved), builder }))
  }
  if (c.order) said.push(tr(msg({ id: 'board.lanes.queuedOrder', defaultMessage: 'new order: {cards}', description: "Part of a lane's queued list change (Progress panel → Lanes, HI-2151), lower case: its cards change order, and {cards} is the whole new list in order (keys, such as HI-12, joined with commas). Hive joins the parts with commas." }), { cards: cards(c.order, 'unit') }))
  return tr(msg({ id: 'board.lanes.queuedChange', defaultMessage: '{after, select, yes {Next, once {card} is Done: {changes}} other {Next: {changes}}}', description: "A line under a lane's cards in the Progress panel's Lanes tab (HI-2151): a change to the lane's list of cards made while a card was in flight, which Hive applies once that card ({card}, its key such as HI-12) is Done (merged); other: the card isn't known. {changes}: what changes, such as \"HI-13 added, HI-9 moves to HB6’s lane\". Keep the select keys. Glossary: Done, lane." }), { after: c.after !== null ? 'yes' : 'no', card: c.after !== null ? name(c.after) : '', changes: list(said, 'unit') }) // i18n-ignore: select keys, never shown
}

/**
 * A folded segment's marks ("✓ n", "+n": HR6's #1279 round 1): every mark of the cards folded into it, so folding never
 * hides one (an override is never invisible, a refusal never lost on a long lane). Each kind is shown once on the folded
 * segment, its lines naming their card ("AL-1: You moved it past its rules…"), for its hover and accessible name.
 * `cards`: the lane's card segments; `short`: a card's revisions as its project shows them.
 */
export interface FoldedMarks {
  refused: string[]
  stale: string[]
  override: string[]
  oldRules: string[]
}

export function foldedMarks(lane: { frozen: unknown }, badges: ReadonlyMap<number, WorkBadge>, cards: readonly CardSegment[], numbers: readonly number[], short: (n: number) => (id: string) => string, tr: Tr, names: OverrideNames, enforced = true): FoldedMarks {
  const out: FoldedMarks = { refused: [], stale: [], override: [], oldRules: [] }
  for (const n of numbers) {
    const s = cards.find((c) => c.number === n)
    if (!s) continue
    const m = segmentMarks(lane, badges.get(n), s, short(n), tr, names, enforced)
    const name = s.name ?? `#${n}`
    for (const k of ['refused', 'stale', 'override', 'oldRules'] as const) if (m[k]) out[k].push(tr(msg({ id: 'board.lane.foldedMark', defaultMessage: '{card}: {mark}', description: "A line in the hover of a lane segment that folds several cards (\"✓ 6\", \"+4\", Progress panel): one card's mark. {card} is its name (its key, such as AL-12), {mark} what the mark says, a sentence already translated (a refusal, a stale pass, a move past its rules)." }), { card: name, mark: m[k]! }))
  }
  return out
}

/** A card segment's accessible name: its label and its notes (#706). */
export function segmentName(s: CardSegment): string {
  return [s.label, ...s.notes].join('. ')
}

/**
 * A card's stage for its segment (#1421, laneStages.ts's `segmentStage`): its id and name (its project's rename, else the
 * stage's own), whether it is a rename, and the other stages of its category the project shows (§16.5.2: Approved and
 * Merging), each by name.
 */
export interface SegmentStage {
  id: StageId
  name: string
  renamed: boolean
  category: { id: StageId; name: string }[]
}

/** A card number's segment, from the card as it is on the board (or not: archived and deleted cards may be missing). */
export function cardSegment(n: number, card: TaskCard | undefined, tr: Tr, stage?: SegmentStage): CardSegment {
  // Named by its key where it has one (#1221).
  const name = card ? cardLabel(card) : `#${n}`
  if (!card) return { kind: 'card', number: n, name, state: 'todo', failed: false, round: null, label: tr(msg({ id: 'board.lane.notOnBoard', defaultMessage: '{card} · not on the board', description: "A lane segment's label (Progress panel) for a card that isn't on the board (archived or deleted). {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: name }), notes: [] }
  const state = stateOf(card)
  const { failures, failedNow, reviewed } = reviewRounds(card)
  const inRound = card.column === 'doing' || card.column === 'review'
  const failed = failedNow && inRound && !isFinished(state)
  // A failed card is in the round that failed until it goes back; a finished one passed in the round after its failures.
  const round = failed ? failures : inRound || (isFinished(state) && reviewed) ? failures + 1 : null
  const how = failed ? 'failed' : round !== null && inRound ? 'in-round' : round !== null && round > 1 ? 'after' : 'none'
  const what = whereText(card.column, round, how, 'waiting', tr, stage)
  const notes: string[] = []
  // The red underline: which round failed and what comes next, then the reviewer's own one-line gist.
  if (failed) {
    notes.push(tr(msg({ id: 'board.lane.reviewFailed', defaultMessage: '{card}: review failed (round {round}): waiting for round {next}', description: "A lane segment's note in the Progress panel (its hover, under a red underline): the card's review round {round} failed and the next round ({next}) hasn't started. {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: name, round: round ?? 0, next: (round ?? 0) + 1 }))
    const gist = failedVerdictGist(card)
    if (gist) notes.push(tr(msg({ id: 'board.lane.reviewerGist', defaultMessage: 'Reviewer: {gist}', description: "A lane segment's note in the Progress panel: the first line of the reviewer's failed verdict ({gist}, in the reviewer's own words)." }), { gist }))
  }
  // The red cross-hatching: why it can't go on.
  const why = state === 'blocked' ? blockedNote(name, card.column === 'hold', card.blocked, true, tr) : null
  if (why) notes.push(why)
  const stages = stage && stage.category.length > 1 ? stage.category.map((s) => ({ ...s, own: s.id === stage.id })) : undefined
  return { kind: 'card', number: n, name, state, failed, round, label: segmentLabel(name, card.title, what, tr), notes, ...(stages ? { stages } : {}) }
}

/** "#405 Built-in loop wakes · Review, round 2": a card segment's label. */
const segmentLabel = (name: string, title: string, where: string, tr: Tr): string =>
  tr(msg({ id: 'board.lane.label', defaultMessage: '{card} {title} · {where}', description: "A lane segment's label (Progress panel): the card’s name (its key, such as AM-12, or #12 for a card with none), title (the user's own words) and where it is ({where}: \"Review, round 2\")." }), { card: name, title, where })

/** A lane card's state as the lane last read it (LaneCard): a gone card reads as still to do, as one not on the board. */
export function laneCardState(c: LaneCard): SegmentState {
  if (c.column === 'unrecorded') return 'unrecorded'
  if (c.column === 'done') return 'done'
  if (c.column === 'passed') return 'passed'
  if (c.blocked || c.roundLimit || c.column === 'hold') return 'blocked'
  if (c.column === 'review') return 'review'
  if (c.column === 'doing') return 'doing'
  return 'todo'
}

/**
 * A segment as the lane left it when it ended or was abandoned (#512): frozen, so a card another lane works on now never
 * shows as worked here too. The lane keeps no review verdicts, so a frozen segment marks no failed round.
 */
export function frozenSegment(c: LaneCard, tr: Tr, name = `#${c.number}`): CardSegment {
  const state = laneCardState(c)
  if (c.column === 'gone') return { kind: 'card', number: c.number, name, state, failed: false, round: null, label: tr(msg({ id: 'board.lane.goneWhenEnded', defaultMessage: '{card} · not on the board when the lane ended', description: "A lane segment's label (Progress panel), in a lane that has ended: the card wasn't on the board then. {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: name }), notes: [] }
  // Ended without a record of its cards: said so, rather than the board's now presented as when it ended.
  if (c.column === 'unrecorded') {
    const label = c.title
      ? tr(msg({ id: 'board.lane.unrecorded', defaultMessage: '{card} {title} · not recorded: the lane ended before Hive kept where its cards were', description: "A lane segment's label (Progress panel), in a lane that ended before Hive recorded its cards' columns. {card} is the card’s name: its key, such as AM-12, or #12 for a card with none, {title} its title (the user's own words)." }), { card: name, title: c.title })
      : tr(msg({ id: 'board.lane.unrecordedUntitled', defaultMessage: '{card} · not recorded: the lane ended before Hive kept where its cards were', description: "A lane segment's label (Progress panel), in a lane that ended before Hive recorded its cards' columns. {card} is the card’s name: its key, such as AM-12, or #12 for a card with none." }), { card: name })
    return { kind: 'card', number: c.number, name, state, failed: false, round: null, label, notes: [] }
  }
  const inRound = c.column === 'doing' || c.column === 'review'
  const round = inRound || isFinished(state) ? c.round : null
  const what = whereText(c.column, round, round !== null && inRound ? 'in-round' : round !== null && round > 1 ? 'after' : 'none', 'plain', tr)
  const why = state === 'blocked' ? blockedNote(name, c.column === 'hold', c.blocked, false, tr) : null
  const label = tr(msg({ id: 'board.lane.labelWhenEnded', defaultMessage: '{card} {title} · {where}, when the lane ended', description: "A lane segment's label (Progress panel), in a lane that has ended: the card’s name (its key, such as AM-12, or #12 for a card with none), title (the user's own words) and where it was then ({where}: \"Review, round 2\")." }), { card: name, title: c.title, where: what })
  return { kind: 'card', number: c.number, name, state, failed: false, round, label, notes: why ? [why] : [] }
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
 * The lanes Pulse shows (#1421): a project whose preset is Solo (or options customised from it) works without loops, so
 * Pulse shows its lanes only while one runs; its ended ones stay in the Lanes tab. `preset`: a project's (folder name).
 */
export function pulseLanes<T extends { project: string; state: LaneState }>(lanes: readonly T[], preset: (project: string) => string | null | undefined): T[] {
  return lanes.filter((l) => laneRunning(l.state) || preset(l.project) !== 'solo')
}

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

/**
 * Every card of a lane as a segment, in the lane's order. `stageOf`: a card's stage (laneStages.ts's segmentStage), for its label by stage
 * name (#1421); without it, by column.
 */
export function laneCards(numbers: readonly number[], tasks: readonly TaskCard[], tr: Tr, stageOf?: (card: TaskCard) => SegmentStage | undefined): CardSegment[] {
  const byNumber = new Map(tasks.map((t) => [t.number, t]))
  return numbers.map((n) => {
    const card = byNumber.get(n)
    return cardSegment(n, card, tr, card && stageOf?.(card))
  })
}

/**
 * A running lane's old rules mark (#1421, §16.5.4), its hover and accessible name: it started under the options before a
 * change and keeps them until it ends; new lanes and cards use the new ones. `enforced`: off, it says the rules aren't.
 */
export function laneOldRulesNote(enforced: boolean, tr: Tr): string {
  return tr(msg({ id: 'board.lanes.oldRulesTip', defaultMessage: 'Old rules: this lane started under the workflow options from before they changed, and keeps them until it ends. New lanes and cards use the new options.{enforced, select, no { Workflow rules aren’t enforced now (Settings → Advanced).} other {}}', description: "Tooltip and accessible name of a lane's \"old rules\" mark (Progress panel): the project's workflow options changed while the lane ran; it keeps the ones it started with until it ends. enforced no: the switch \"Workflow rules are enforced\" (Settings → Advanced) is off. Keep the select keys. Glossary: lane, workflow options." }), { enforced: enforced ? 'yes' : 'no' }) // i18n-ignore: select keys, never shown
}

/** A card segment's old rules line (#1421): its card keeps the options it started with until it is Done. */
export function cardOldRulesNote(enforced: boolean, tr: Tr): string {
  return tr(msg({ id: 'board.lane.oldRules', defaultMessage: 'Old rules: this card started under the workflow options from before they changed, and keeps them until it’s Done.{enforced, select, no { Workflow rules aren’t enforced now.} other {}}', description: "A line in a lane segment's hover and accessible name (Progress panel), with its old rules mark: the card's project's workflow options changed while it was in flight, and it keeps the ones it started with until it is Done (unless they are applied to it). enforced no: the switch \"Workflow rules are enforced\" is off. Keep the select keys. Glossary: workflow options." }), { enforced: enforced ? 'yes' : 'no' }) // i18n-ignore: select keys, never shown
}

/** How many segments fit in a bar this wide (at least three: the finished fold, a card and the rest). */
export function segmentsThatFit(widthPx: number): number {
  return Math.max(3, Math.floor((widthPx + SEGMENT_GAP_PX) / (SEGMENT_MIN_PX + SEGMENT_GAP_PX)))
}

/** Joins a list in the window's language (`fmt.list`): this module is also reached from hive-mcp, which never loads the translations. */
type ListOf = (items: string[], type?: 'conjunction' | 'unit') => string

/** "AM-3, AM-4, #5" (by key where they have one), or the first eight and how many more as the list's last item ("#1, #2 … #8 and 3 more"). */
function cardList(segs: CardSegment[], tr: Tr, list: ListOf): string {
  const ns = segs.map((c) => c.name ?? `#${c.number}`)
  const shown = ns.slice(0, 8)
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
  const out: LaneSegment[] = finished.length ? [{ kind: 'finished', numbers: finished.map((c) => c.number), label: tr(msg({ id: 'board.lane.finished', defaultMessage: '{n, plural, one {# finished: {cards}} other {# finished: {cards}}}', description: "A lane segment's label (Progress panel) for its finished cards folded into one: how many ({n}) and which ({cards}: \"#3, #4\")." }), { n: finished.length, cards: cardList(finished, tr, list) }) }] : []
  const room = Math.max(1, max - out.length)
  if (rest.length <= room) return [...out, ...rest]
  const more = rest.slice(room - 1)
  return [...out, ...rest.slice(0, room - 1), { kind: 'more', numbers: more.map((c) => c.number), label: tr(msg({ id: 'board.lane.more', defaultMessage: '{n, plural, one {# more: {cards}} other {# more: {cards}}}', description: "A lane segment's label (Progress panel) for the cards that don't fit its bar, folded into one: how many ({n}) and which ({cards}: \"#3, #4\")." }), { n: more.length, cards: cardList(more, tr, list) }) }]
}

/** A lane's header numbers: its finished cards out of all, and the card it is on (currentCard). */
export function laneSummary(cards: CardSegment[]): { finished: number; total: number; current: number | null } {
  return { finished: cards.filter((c) => isFinished(c.state)).length, total: cards.length, current: currentCard(cards).current }
}

/**
 * How many lanes the Progress panel's lanes section shows before it scrolls (#569; HI-1673, Darren: as before #1309):
 * all of them up to six (Settings → Advanced → Progress panel: lanes shown, and a workspace's own: #367, the `fallback`
 * below), its floor: a drag never shows fewer lanes than there are up to it, nor fewer than it with more lanes (folding
 * the section makes it smaller). The user drags the section's top edge (or presses Up and Down on it) for up to
 * MORE_LANE_ROWS more, in whole lanes, kept per workspace, and back down to the floor. With fewer lanes than the floor,
 * the section is only as tall as they are.
 */
export const DEFAULT_LANE_ROWS = 6

/** How many lanes more than the floor the top edge can be dragged up to show (HI-1673: six, then up to ten). */
export const MORE_LANE_ROWS = 4

/** The range a drag picks the lanes shown from: the floor (every lane up to `fallback`) and the most (up to MORE_LANE_ROWS more). */
export function laneRowsRange(count: number, fallback = DEFAULT_LANE_ROWS): { min: number; top: number } {
  const min = Math.max(1, Math.min(count, fallback))
  return { min, top: Math.max(min, Math.min(count, fallback + MORE_LANE_ROWS)) }
}

/** The height the runs above keep (px) when the lanes are dragged up: about a run and a half. */
export const RUNS_KEEP_PX = 120

/**
 * How long a lane has waited (HI-1926), in ms from its status's `since` to `now`; null when it doesn't wait or isn't
 * stamped. `long`: past its bound: for you (a request, a round limit) after `youMin`, a reviewer after `reviewerMin`.
 */
export function laneWaitTime(s: Pick<LaneStatus, 'reason' | 'since'> | null, now: number, youMin: number, reviewerMin: number): { ms: number; long: boolean } | null {
  if (!s || typeof s.since !== 'number') return null
  const ms = Math.max(0, now - s.since)
  const bound = s.reason === 'you' || s.reason === 'roundLimit' ? youMin : s.reason === 'reviewer' ? reviewerMin : null
  return { ms, long: bound !== null && ms >= bound * 60_000 }
}

/**
 * A lane's card's time and merge commit (HI-1926), from its cycle's facts (`startedAt`, `endedAt`, `merged`: its work
 * badge): Done, how long it took and its merge commit; in progress, how long so far; nothing for Todo, a card gone or not
 * recorded, or a time not known. An ended lane (`laneEnded`) shows only what its facts say happened before it ended: a
 * cycle started after it (the card reopened) or ended after it shows no time or commit, and an unfinished card's time
 * doesn't run on.
 */
export function laneCardTime(column: string, badge: { startedAt: string | null; endedAt: string | null; merged: string | null } | undefined, laneEnded: string | null, now: number): { took?: number; soFar?: number; merged?: string } | null {
  const start = badge?.startedAt ? Date.parse(badge.startedAt) : NaN
  if (!Number.isFinite(start)) return null
  const end = badge?.endedAt ? Date.parse(badge.endedAt) : NaN
  const cutoff = laneEnded ? Date.parse(laneEnded) : NaN
  if (Number.isFinite(cutoff)) {
    if (start > cutoff || column !== 'done' || !Number.isFinite(end) || end > cutoff) return null
    return { took: Math.max(0, end - start), ...(badge?.merged ? { merged: badge.merged } : {}) }
  }
  if (column === 'done') return Number.isFinite(end) ? { took: Math.max(0, end - start), ...(badge?.merged ? { merged: badge.merged } : {}) } : null
  if (column === 'doing' || column === 'review' || column === 'passed' || column === 'hold') return { soFar: Math.max(0, now - start) }
  return null
}

/** A kept choice as a whole number of lanes, at least one; the default (`fallback`) when there is none (or it isn't a number). */
export function chosenLaneRows(kept: number | null | undefined, fallback = DEFAULT_LANE_ROWS): number {
  return typeof kept === 'number' && Number.isFinite(kept) ? Math.max(1, Math.round(kept)) : fallback
}

/** The lanes shown: the choice, within the range (never fewer than the floor, nor more than there are or the most). */
export function lanesShown(kept: number | null | undefined, count: number, fallback = DEFAULT_LANE_ROWS): number {
  const { min, top } = laneRowsRange(count, fallback)
  return Math.max(min, Math.min(top, chosenLaneRows(kept, fallback)))
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
 * The lanes shown now: the choice, within the range. The lanes take priority (HI-1673: the runs go behind them): the
 * floor takes all the room the runs could give up (`roomPx` is what they give up keeping RUNS_KEEP_PX, so RUNS_KEEP_PX
 * more), and only a panel too short even for that shows fewer, as many whole lanes as fit, the rest scrolling. More than
 * the floor only as far as they fit in `roomPx` (null: not measured yet), so dragging up leaves the runs their room; the
 * choice itself is kept for when there is room again. `min` and `max` are the splitter's range now.
 */
export function laneRowsNow(kept: number | null | undefined, count: number, roomPx: number | null, pitchPx: number, fallback = DEFAULT_LANE_ROWS): { chosen: number; shown: number; min: number; max: number } {
  const range = laneRowsRange(count, fallback)
  const min = roomPx === null ? range.min : Math.min(range.min, maxLaneRows(count, roomPx + RUNS_KEEP_PX, pitchPx))
  const chosen = lanesShown(kept, count, fallback)
  const max = Math.max(min, roomPx === null ? range.top : Math.min(range.top, maxLaneRows(count, roomPx, pitchPx)))
  return { chosen, shown: Math.max(min, Math.min(chosen, max)), min, max }
}

/** Dragging the top edge by `dyPx` (negative is up, showing more) from `startRows`, snapped to whole lanes, between `min` and `max`. */
export function draggedLaneRows(startRows: number, dyPx: number, pitchPx: number, max: number, min = 1): number {
  const rows = pitchPx > 0 ? Math.round(startRows - dyPx / pitchPx) : startRows
  return Math.max(min, Math.min(max, rows))
}

/** A key on the focused edge: Up shows a lane more, Down one fewer, Home the floor, End as many as fit; null for other keys. */
export function keyedLaneRows(rows: number, key: string, max: number, min = 1): number | null {
  const next = key === 'ArrowUp' ? rows + 1 : key === 'ArrowDown' ? rows - 1 : key === 'Home' ? min : key === 'End' ? max : null
  return next === null ? null : Math.max(min, Math.min(max, next))
}
