import type { LaneState, LaneStatus, LaneTitle, SessionStatus, StoredText, TaskCard, TaskColumn } from './types'
import { storedForAgents } from './taskHistory'
import { laneStatusText } from './lanes'
import { columnLabel } from './tasks'
import { brief, cardPart, historyBlocked, historyVerdict, WAKE_MAX_BYTES, WATCH_CHANGES, WATCH_MAX_CARDS, type CardChange, type WatchChange } from './watch'
import { cardRef } from './projectKeys'
import { agentMsg, say } from './agentText'
import { NOTICE_PREFIX } from './doorbell'
// Types only: agentWatch loads the translations, which hive-mcp (toolReplies imports this) never does.
import type { AgentEvent, WatchedAgent } from './agentWatch'

const T = {
  mergeStallIdle: agentMsg({ id: 'wake.lane.mergeStallIdle', text: 'Every card passed, but {builder} has been idle for {minutes} min with no merge slot claimed.', note: "Why a lane's merge has stalled (#869), in a lane watch's wake and the Agent API: its builder idle with no merge slot claimed. builder: its name; minutes: how long." }),
  mergeStallGone: agentMsg({ id: 'wake.lane.mergeStallNotRunning', text: "Every card passed, but {builder} isn't running.", note: "Why a lane's merge has stalled (#869): its builder isn't running. builder: its name." }),
  failed: agentMsg({ id: 'wake.lane.failed', text: '{card} failed review{by}', note: 'A lane watch wake\'s event: a lane\'s card failed review. card: "HI-12"; by: " (R1 (alpha))", its reviewer, or nothing.' }),
  passed: agentMsg({ id: 'wake.lane.passed', text: '{card} passed review{by}', note: 'A lane watch wake\'s event: a lane\'s card passed review. card: "HI-12"; by: " (R1 (alpha))", its reviewer, or nothing.' }),
  blocked: agentMsg({ id: 'wake.lane.blocked', text: '{card} is blocked', note: 'A lane watch wake\'s event: a lane\'s card became blocked (its reason follows). card: "HI-12".' }),
  reblocked: agentMsg({ id: 'wake.lane.reblocked', text: '{card} is still blocked, with news', note: 'A lane watch wake\'s event (#1475): a blocked card\'s reason changed, or its agent commented. card: "HI-12".' }),
  unblocked: agentMsg({ id: 'wake.lane.unblocked', text: '{card} is no longer blocked', note: 'A lane watch wake\'s event (#922): a lane\'s card\'s block lifted. card: "HI-12".' }),
  stalled: agentMsg({ id: 'wake.lane.stalled', text: '{card} is stalled', note: 'A lane watch wake\'s event: a lane\'s card stalled (why follows). card: "HI-12".' }),
  moved: agentMsg({ id: 'wake.lane.moved', text: '{card} is in {column}', note: 'A lane watch wake\'s event: a lane\'s card moved. card: "HI-12"; column: the board column\'s name ("Review").' }),
  asked: agentMsg({ id: 'wake.lane.waitsForUser', text: '{card} waits for the user{who, select, agent { ({by} asks)} hive { (Combwork asks)} other {}}', note: 'A lane watch wake\'s event (HI-1991): a new request for the user on a lane\'s card (what it asks follows). card: "HI-12"; who: agent (by: the asking agent\'s name), hive (Hive asked), or none (not known).' }),
  mergeDue: agentMsg({ id: 'wake.lane.mergeDue', text: 'all its cards passed: its merge is due', note: "A lane watch wake's event: every card of the lane passed, so its merge is due." }),
  mergeStalled: agentMsg({ id: 'wake.lane.mergeStalled', text: 'its merge is stalled', note: "A lane watch wake's event (#869): the lane's merge is due but nobody is doing it (why follows)." }),
  pausedMerge: agentMsg({ id: 'wake.lane.pausedMerge', text: 'paused for a merge: {status}', note: 'A lane watch wake\'s event (#1270): the lane waits for a card to merge. status: the lane\'s status ("waiting: HI-12 not merged").' }),
  ended: agentMsg({ id: 'wake.lane.ended', text: '{merged, select, yes {ended: merged at {commit}} other {ended (merged)}}', note: "A lane watch wake's event: the lane ended. merged: yes with its merge commit (commit: its first 12 characters), verified from its cards' facts (#1270)." }),
  abandoned: agentMsg({ id: 'wake.lane.abandoned', text: 'was abandoned', note: "A lane watch wake's event: the lane was abandoned." }),
  waiting: agentMsg({ id: 'wake.lane.agentWaiting', text: '{name} ({project}) is waiting for the user{onCard, select, yes { on {card}} other {}}{what}', note: 'A lane watch wake (#726): an agent of the followed projects started waiting for the user. name, project: the agent\'s; card: "HI-12" when onCard is yes; what: what it asks, quoted after a colon, or nothing.' }),
  tail: agentMsg({
    id: 'wake.lane.tail',
    text: 'Your lane watch has ended: read the cards named (cw_read_task), act on them, {asks, select, yes {tell the user what an agent waits for (cw_notify) and never answer it for them, } other {}}then watch the lanes again (cw_wait_for_tasks with lanes{keep, select, both {; your cards and agents stay unless you pass them, less the agents told here} cards {; your cards stay unless you pass cards} agents {; your agents stay unless you pass agents, less the agents told here} other {}}).',
    note: 'How a lane watch\'s wake ends: what to do. asks: yes when an agent waits for the user (#726, HI-1991); keep: what else the watch had beside its lanes, which stays when it is watched again (cards, agents (HI-1987), both or none).'
  }),
  lane: agentMsg({ id: 'wake.lane.lane', text: 'Lane {lane}: {events}', note: 'A lane watch wake: one lane and what happened in it. lane: its label ("B1 / R1 (greetings)"), or shorter its name ("greetings", else "B1 / R1"; HI-2522); events: its events, "; " between.' }),
  lanesChanged: agentMsg({ id: 'wake.lane.lanesChanged', text: '{n, plural, one {{n} lane changed} other {{n} lanes changed}}: {lanes}', note: 'A lane watch wake too long to tell in full: how many lanes changed, then each lane\'s name (HI-2522: else "B1 / R1") with its events by name ("greetings (HI-12 failed, merge-due)").' }),
  waitingNames: agentMsg({ id: 'wake.lane.waitingNames', text: 'waiting for the user: {agents}', note: 'A lane watch wake too long to tell in full: the agents waiting for the user, each "name (project)".' }),
  agentsChanged: agentMsg({ id: 'wake.lane.agentsChanged', text: 'agents changed: {agents}', note: 'A lane watch wake too long to tell in full: the agents it follows (HI-1987) that changed, each "name (project) event" (event: finished, waiting, stopped, error, untaken).' }),
  countLanes: agentMsg({ id: 'wake.lane.countLanes', text: '{n, plural, one {{n} lane changed} other {{n} lanes changed}}', note: 'A lane watch wake with only counts left: how many lanes changed.' }),
  countCards: agentMsg({ id: 'wake.lane.countCards', text: '{n} of your cards changed', note: 'A lane watch wake with only counts left: how many of the cards beside its lanes changed.' }),
  countWaits: agentMsg({ id: 'wake.lane.countWaits', text: '{n, plural, one {{n} agent is waiting for the user} other {{n} agents are waiting for the user}}', note: 'A lane watch wake with only counts left: how many agents wait for the user.' }),
  countAgents: agentMsg({ id: 'wake.lane.countAgents', text: '{n} of your agents changed', note: 'A lane watch wake with only counts left: how many of the agents it follows changed.' }),
  counted: agentMsg({ id: 'wake.lane.counted', text: '{what}: list them (cw_lane list, cw_list_projects, cw_agent_activity) and read their cards.', note: 'A lane watch wake with only counts left. what: the counts, ", " between ("2 lanes changed, 1 of your cards changed").' }),
  label: agentMsg({ id: 'wake.lane.label', text: 'Waiting on {lanes, select, all {all running lanes} one {{lane}} other {{n} lanes}}{also, select, yes { and {list}} other {}}', note: 'A lane watch\'s label (a watching agent\'s status, the Agent API). lanes: all (every running lane), one (lane: as wake.lane.oneLane names it, HI-2522) or some (n: how many); also: yes with the cards and agents beside them (list: "HI-12, HI-14, B2").' }),
  limit: agentMsg({
    id: 'wake.lane.limit',
    text: 'Nothing to tell on {lanes, select, all {the running lanes} one {{lane}} other {{n} lanes}}{also, select, yes { or {list}} other {}} in {hours, select, yes {{time} h} other {{time} min}}: your lane watch has ended. Check them (cw_lane list{agents, select, yes {, cw_agent_activity} other {}}), then watch again, or tell the user (cw_notify) if one seems stuck.',
    note: 'Typed when a lane watch\'s limit passes with nothing to tell. lanes: all, one (lane: as wake.lane.oneLane names it, HI-2522) or some (n: how many); also: yes with the cards and agents beside them (list); hours: yes when time is in hours ("1.5"), else minutes; agents: yes when it follows agents (HI-1987).'
  }),
  oneLane: agentMsg({ id: 'wake.lane.oneLane', text: "{kind, select, named {lane {name}} both {{builder}'s lane {name}} builder {{builder}'s lane} other {a lane}}", note: "HI-2522: one lane as a lane watch's label and limit line name it, never by its lane-… id. kind: named (name: its name), both (another lane has that name: builder, its builder's name, too), builder (it has no name: its builder's lane), or none (a lane not known: a watch from before HI-2522 on a lane no longer listed)." }),
  badCards: agentMsg({ id: 'wake.lane.badCards', text: 'cards must be card numbers (no repeats), or [] for none', note: "A lane watch's refusal: its cards argument isn't a list of card numbers." }),
  tooManyCards: agentMsg({ id: 'wake.lane.tooManyCards', text: 'at most {max} cards', note: "A lane watch's refusal: too many cards beside its lanes. max: the most." }),
  badChanges: agentMsg({ id: 'wake.lane.badChanges', text: 'changes must be any of {changes}', note: 'A lane watch\'s refusal: its changes argument names none it knows. changes: those it takes ("comment, column, …").' }),
  badLanes: agentMsg({ id: 'wake.lane.badLanes', text: 'lanes must be lane ids (cw_lane list), at most {max}, or ["all"]', note: "A lane watch's refusal: its lanes argument isn't lane ids or [\"all\"]. max: how many it takes." }),
  badEvents: agentMsg({ id: 'wake.lane.badEvents', text: 'events must be any of {events}', note: 'A lane watch\'s refusal: its events argument names none it knows. events: those it takes ("failed, blocked, …").' })
}

/**
 * Lane watches (#531): a watch on whole lanes (main/lanes.ts), not cards. On 10 Oct the Assistant, with seven lanes and
 * about 25 open cards, swapped cards in and out of its 20-card watch on every wake, missed one (#390 sat in Review
 * unreviewed), and was woken on every column move, most of which needed nothing. A lane watch follows each lane's cards
 * as the lane goes on (cards added included, no card limit), and counts only what a coordinator acts on.
 *
 * #726: the release card #720 was in no lane, so HB6 waited about 45 minutes for Darren's push before the Assistant
 * noticed. The same watch takes cards beside its lanes (`cards`, told as a card watch tells them, and when one becomes
 * blocked), and wakes when an agent of the projects it follows starts waiting for the user (`waiting`).
 */

/**
 * What a lane watch counts. The default is all but `passed`, `moved` and `paused-merge`. HI-1991: `paused` was split in
 * two, a lane paused for a merge (`paused-merge`) and a question for the user on a lane's card (`paused-user`), so an
 * Assistant dropping the merge noise no longer drops the questions with it (one sat unnoticed under For you for 20 min).
 */
export const LANE_EVENTS = ['failed', 'blocked', 'stalled', 'merge-due', 'ended', 'abandoned', 'waiting', 'passed', 'moved', 'paused-merge', 'paused-user', 'unblocked', 'reblocked'] as const
export type LaneEvent = (typeof LANE_EVENTS)[number]
export const LANE_DEFAULT_EVENTS: LaneEvent[] = ['failed', 'blocked', 'unblocked', 'reblocked', 'stalled', 'merge-due', 'ended', 'abandoned', 'waiting', 'paused-user']
/** What every lane watch counts, whatever its `events` (HI-1991): a question for the user is never filtered out. */
export const LANE_ALWAYS_EVENTS: LaneEvent[] = ['paused-user']
/**
 * What a watch naming lanes always counts (HI-2521): their end. Once its lanes end it has nothing left to watch, so a
 * watch that filtered the end out (a reviewer watching only for `failed`) would sit until its limit.
 */
export const LANE_END_EVENTS: LaneEvent[] = ['ended', 'abandoned']
/** A lane watch's events with those it always counts (LANE_ALWAYS_EVENTS, and named lanes' end): as asked, read back or made. */
export const withAlwaysEvents = (ids: LaneWatchCondition['ids'], events: readonly LaneEvent[]): LaneEvent[] => [...new Set([...events, ...LANE_ALWAYS_EVENTS, ...(ids === 'all' ? [] : LANE_END_EVENTS)])]
/** Event names from before, still accepted (HI-1991): `paused` told only a lane paused for a merge. */
const LANE_EVENT_ALIASES: Readonly<Record<string, LaneEvent>> = { paused: 'paused-merge' }
/** What counts on the cards beside a lane watch's lanes by default (#726); a card becoming blocked always does. */
export const LANE_CARD_CHANGES: WatchChange[] = ['comment', 'column', 'verdict']
/** At most this many lanes named in one watch ("all" follows every running lane, however many). */
export const LANE_WATCH_MAX = 50

export interface LaneWatchCondition {
  /** The lanes by id, or "all": every lane of the watcher's view running when it is checked (started later too). */
  ids: string[] | 'all'
  events: LaneEvent[]
}

/** A lane's card as a lane watch last saw it: its column, whether blocked and stalled, its latest failed and passed verdicts. */
export interface LaneCardMark {
  c: TaskColumn | 'gone'
  b: boolean
  s: boolean
  /** The latest "Review failed" and "Review passed" in its history (ISO), '' for none. */
  f: string
  p: string
  /**
   * While blocked (#1475), the latest news on the block (ISO): its blocked reason last set (a changed reason writes a new
   * "Blocked:" entry) or its agent's latest comment, whichever is later; '' when not blocked. Absent in marks from before.
   */
  r?: string
  /**
   * When its newest open request for the user was made (HI-1991: a For you request, such as an agent's cw_ask_user)
   * (ISO), '' for none. Absent in marks from before, and where its requests aren't known.
   */
  q?: string
}

/** A lane as a lane watch last saw it. */
export interface LaneMark {
  state: LaneState | 'gone'
  /** Every card passed or done, at least one not yet done: its merge is due. */
  mergeDue: boolean
  /** Its merge is due but stalled (#869, mergeStallReason); left out: not. */
  ms?: boolean
  cards: Record<string, LaneCardMark>
}

/** A lane now, for a watch: its marks and what its line says about each card. */
export interface LaneNow {
  id: string
  /** "B1 / R1 (greetings)". */
  label: string
  /** HI-2522: its name, else "B1 / R1": a wake line too long names it so, never by its id. Left out: by its id. */
  short?: string
  mark: LaneMark
  cards: { number: number; blocked: string | null; stalled: string | null; failedBy: string | null; passedBy: string | null; asked?: LaneAsked | null }[]
  /** Why its merge has stalled (#869), when it has. */
  mergeStall?: string | null
  /** Why it waits (#1270), as main worked it out: a pause the other events don't tell (a card not merged, merging). */
  status?: LaneStatus | null
  /** Its merge commit once it ended, verified from its cards' facts while rules are enforced (#1270). */
  mergeCommit?: string | null
}

/** A lane card's newest open request for the user (HI-1991): when it was made, who asked (null: Hive) and its text. */
export interface LaneAsked {
  since: string
  by: string | null
  /** Its English as stored; `shown`, Hive's own request as data, which a reader's chain says again (HI-2464). */
  text: string
  shown?: StoredText
}

/** One lane's events since its mark: what the wake line tells. */
export interface LaneHit {
  id: string
  label: string
  short?: string
  parts: { n: number | null; event: LaneEvent; text: string; detail?: string }[]
}

/** A card's latest failed and passed verdicts: when, and by whom ("R1 (alpha)"). */
export function verdictsOf(card: Pick<TaskCard, 'history'>): { failed: { at: string; by: string } | null; passed: { at: string; by: string } | null } {
  const f = card.history.findLast((h) => historyVerdict(h) === 'failed')
  const p = card.history.findLast((h) => historyVerdict(h) === 'passed')
  return { failed: f ? { at: f.at, by: f.by } : null, passed: p ? { at: p.at, by: p.by } : null }
}

/**
 * A lane's card mark from the card (null: gone from the watcher's view), its stall, if any, and its newest open request
 * for the user (HI-1991: null for none; left out, not known, and the mark has no `q`).
 */
export function laneCardMark(card: (Pick<TaskCard, 'column' | 'blocked' | 'history' | 'archived'> & Partial<Pick<TaskCard, 'comments' | 'agentName'>>) | null, stalled: string | null, asked?: LaneAsked | null): LaneCardMark {
  const gone = !card || card.archived
  const q = asked === undefined ? {} : { q: gone ? '' : (asked?.since ?? '') }
  if (gone) return { c: 'gone', b: false, s: false, f: '', p: '', r: '', ...q }
  const v = verdictsOf(card)
  return { c: card.column, b: !!card.blocked, s: !!stalled, f: v.failed?.at ?? '', p: v.passed?.at ?? '', r: blockNewsAt(card), ...q }
}

/**
 * When a blocked card last had news on its block (#1475), for `reblocked`: its blocked reason last set, or its agent's
 * latest comment (a builder re-shooting for the user's or the Assistant's OK and saying so). '' when it isn't blocked.
 */
export function blockNewsAt(card: Pick<TaskCard, 'blocked' | 'history'> & Partial<Pick<TaskCard, 'comments' | 'agentName'>>): string {
  if (!card.blocked) return ''
  const set = card.history.findLast((h) => historyBlocked(h))?.at ?? ''
  const name = card.agentName
  // A comment's author is its agent's name and project: "HB2 (hive)".
  const said = name ? (card.comments?.findLast((c) => c.by === name || c.by.startsWith(`${name} (`))?.at ?? '') : ''
  return said > set ? said : set
}

/** Whether a lane's merge is due: every card passed or done, at least one passed (not yet merged). */
export const mergeDue = (cards: readonly LaneCardMark[]): boolean => cards.length > 0 && cards.every((c) => c.c === 'passed' || c.c === 'done') && cards.some((c) => c.c === 'passed')

/** How long a lane's merge may wait with its builder idle and no merge slot claimed before a lane watch is told (#869). */
export const MERGE_STALL_MS = 10 * 60_000

/** A builder's statuses in which it does nothing until someone prompts it: its turn has ended, or it never started. */
const IDLE: readonly SessionStatus[] = ['ready', 'finished', 'stopped', 'error']

/** A lane's builder as it is now, for mergeStallReason: null when its session isn't running. */
export interface LaneBuilderNow {
  status: SessionStatus
  /** When its status last changed (ISO). */
  statusSince?: string
  backgroundTasks?: number
  /** Its place at the merge slot (holding it or waiting for it), if it has one. */
  mergeSlot?: string
}

/**
 * Why a lane whose merge is due has stalled (#869), or null: on 14 Oct lane G's cards had all passed, its builder's CLI
 * refused the commit, and the builder told the user and ended its turn. merge-due had already been told once, the cards
 * weren't blocked and the builder wasn't at a prompt, so nothing woke the Assistant for two hours. Stalled: every card
 * passed or done (one not yet merged), none blocked (a block is told as one), and its builder isn't running, or has been
 * idle (its turn ended, no background task) with no place at the merge slot, for MERGE_STALL_MS since the later of its
 * cards' last change and its own. A builder working, watching or waiting for the user (told as `waiting`) isn't stalled.
 */
export function mergeStallReason(lane: { state: LaneState | 'gone'; builder: string; cards: readonly { mark: LaneCardMark; updatedAt?: string }[] }, builder: LaneBuilderNow | null, now = Date.now()): string | null {
  if (lane.state !== 'active' && lane.state !== 'paused') return null
  const marks = lane.cards.map((c) => c.mark)
  if (!mergeDue(marks) || marks.some((m) => m.b)) return null
  if (builder && (!IDLE.includes(builder.status) || (builder.backgroundTasks ?? 0) > 0 || builder.mergeSlot)) return null
  const at = (iso: string | undefined): number => (iso ? Date.parse(iso) || 0 : 0)
  const since = Math.max(...lane.cards.map((c) => at(c.updatedAt)), at(builder?.statusSince))
  if (!since || now - since < MERGE_STALL_MS) return null
  const minutes = Math.round((now - since) / 60_000)
  return builder ? say(T.mergeStallIdle, { builder: lane.builder, minutes: String(minutes) }) : say(T.mergeStallGone, { builder: lane.builder })
}

const firstLine = (s: string): string => s.trim().split(/\r?\n/, 1)[0]

const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * What happened in a lane since its mark (`before`), of the events that count: a lane the watch hadn't seen yet (null)
 * starts from now, with nothing to tell. A card new to a followed lane (added since its mark) starts empty (#531 round 1
 * finding): neither blocked nor stalled, no verdict since `since` (when the watch began), so a block or stall it came
 * with is told, and a verdict since; without `since`, from now.
 */
export function laneHits(before: LaneMark | null | undefined, now: LaneNow, events: readonly LaneEvent[], since?: string): LaneHit | null {
  if (!before) return null
  const on = new Set(events)
  const parts: LaneHit['parts'] = []
  for (const c of now.cards) {
    const is = now.mark.cards[c.number]
    const was = before.cards[c.number] ?? (since && is ? { c: is.c, b: false, s: false, f: since, p: since, q: since } : undefined)
    if (!was || !is || is.c === 'gone') continue
    const card = cardRef(c.number)
    if (on.has('failed') && is.f > was.f) parts.push({ n: c.number, event: 'failed', text: say(T.failed, { card, by: c.failedBy ? ` (${c.failedBy})` : '' }) })
    if (on.has('passed') && is.p > was.p) parts.push({ n: c.number, event: 'passed', text: say(T.passed, { card, by: c.passedBy ? ` (${c.passedBy})` : '' }) })
    if (on.has('blocked') && is.b && !was.b) parts.push({ n: c.number, event: 'blocked', text: say(T.blocked, { card }), ...(c.blocked ? { detail: c.blocked } : {}) })
    // Still blocked, with news on it (#1475): its reason changed, or its agent commented (re-shot for an OK). A mark from
    // before has no `r`, and a fresh block is told as blocked.
    if (on.has('reblocked') && is.b && was.b && was.r !== undefined && is.r !== undefined && is.r > was.r) parts.push({ n: c.number, event: 'reblocked', text: say(T.reblocked, { card }), ...(c.blocked ? { detail: c.blocked } : {}) })
    // Its block lifted (#922, #1272): the agent or the user cleared it, so the lane goes on.
    if (on.has('unblocked') && !is.b && was.b) parts.push({ n: c.number, event: 'unblocked', text: say(T.unblocked, { card }) })
    if (on.has('stalled') && is.s && !was.s) parts.push({ n: c.number, event: 'stalled', text: say(T.stalled, { card }), ...(c.stalled ? { detail: c.stalled } : {}) })
    if (on.has('moved') && is.c !== was.c) parts.push({ n: c.number, event: 'moved', text: say(T.moved, { card, column: columnLabel(is.c) }) })
    // A new request for the user on it (HI-1991): an agent's question (cw_ask_user) or Hive's own, under For you. The
    // agent asking isn't waiting at a prompt, so `waiting` never tells it. A mark from before has no `q`.
    if (on.has('paused-user') && was.q !== undefined && is.q !== undefined && is.q > was.q) parts.push({ n: c.number, event: 'paused-user', text: say(T.asked, { card, who: !c.asked ? 'none' : c.asked.by ? 'agent' : 'hive', by: c.asked?.by ?? '' }), ...(c.asked?.text ? { detail: firstLine(storedForAgents(c.asked.text, c.asked.shown)) } : {}) })
  }
  if (on.has('merge-due') && now.mark.mergeDue && !before.mergeDue && now.mark.state !== 'ended' && now.mark.state !== 'abandoned') parts.push({ n: null, event: 'merge-due', text: say(T.mergeDue) })
  if (on.has('stalled') && now.mark.ms && !before.ms) parts.push({ n: null, event: 'stalled', text: say(T.mergeStalled), ...(now.mergeStall ? { detail: now.mergeStall } : {}) })
  // Paused for a merge (#1270, HI-1991): one card at a time, the next waiting for the last to merge. A blocked or held
  // card is told as blocked, and a request for the user (the round limit's too) as paused-user, above.
  const s = now.status
  if (on.has('paused-merge') && now.mark.state === 'paused' && before.state !== 'paused' && s && (s.reason === 'notMerged' || s.reason === 'merging')) parts.push({ n: s.card, event: 'paused-merge', text: say(T.pausedMerge, { status: laneStatusText(s) }), detail: s.reason })
  // With its merge commit when the lane's end named one (#1270: from its cards' facts, never an agent's say-so).
  if (on.has('ended') && now.mark.state === 'ended' && before.state !== 'ended') parts.push({ n: null, event: 'ended', text: say(T.ended, { merged: now.mergeCommit ? 'yes' : 'no', commit: now.mergeCommit?.slice(0, 12) ?? '' }) })
  if (on.has('abandoned') && now.mark.state === 'abandoned' && before.state !== 'abandoned') parts.push({ n: null, event: 'abandoned', text: say(T.abandoned) })
  return parts.length ? { id: now.id, label: now.label, ...(now.short ? { short: now.short } : {}), parts } : null
}

/**
 * A lane that has ended or been abandoned, as a lane watch's reply tells it at once (HI-2521: WR1 watched a lane that
 * had ended 2 s before, and sat watching it for its 6 h limit): "Lane B1 / R1 (greetings): ended: merged at …". Null
 * while it runs.
 */
export function laneOverPart(now: Pick<LaneNow, 'label' | 'mark' | 'mergeCommit'>): string | null {
  const s = now.mark.state
  if (s !== 'ended' && s !== 'abandoned') return null
  const events = s === 'ended' ? say(T.ended, { merged: now.mergeCommit ? 'yes' : 'no', commit: now.mergeCommit?.slice(0, 12) ?? '' }) : say(T.abandoned)
  return say(T.lane, { lane: now.label, events })
}

/**
 * A lane's mark with its cards' requests for the user carried over where they couldn't be read (HI-1991 round 1 finding):
 * a card with no `q` keeps its last mark's, or, new to the watch, `since` (when the watch began), so a question asked
 * meanwhile is told once they are read again. A card whose last mark is from before (no `q`) stays without one.
 */
export function keepAsked(was: LaneMark | null | undefined, now: LaneMark, since: string): LaneMark {
  if (Object.values(now.cards).every((c) => c.q !== undefined)) return now
  const cards: Record<string, LaneCardMark> = {}
  for (const [n, c] of Object.entries(now.cards)) {
    const q = c.q ?? (was?.cards[n] ? was.cards[n].q : since)
    cards[n] = q === undefined ? c : { ...c, q }
  }
  return { ...now, cards }
}

/**
 * Where a lane first seen by a watch on every lane starts, when it began after the watch did (#531): its cards as they
 * are, but neither blocked nor stalled, and no verdict before the watch began (`since`). So a block or stall it already
 * has is told once, and a verdict since the watch began; a lane there when the watch began starts from now instead.
 */
export function newLaneBase(now: LaneNow, since: string): LaneMark {
  const cards: Record<string, LaneCardMark> = {}
  for (const [n, c] of Object.entries(now.mark.cards)) cards[n] = { c: c.c, b: false, s: false, f: since, p: since, q: since }
  return { state: 'active', mergeDue: false, cards }
}

const jsonBytes = (s: string): number => new TextEncoder().encode(JSON.stringify(s)).length

/** An agent that started waiting for the user (#726): its name and project, its card (null: none), and what it asks (null: not known). */
export interface WaitHit {
  name: string
  project: string
  card: number | null
  what: string | null
}

const waitPart = (w: WaitHit, detail: number): string => say(T.waiting, { name: w.name, project: w.project, onCard: w.card ? 'yes' : 'no', card: w.card ? cardRef(w.card) : '', what: w.what && detail ? `: "${clip(w.what, detail)}"` : '' })

/** What a lane watch's line ends with: what to do, with the waits and the cards beside its lanes when it tells or keeps them. */
const tailOf = (waits: boolean, cards: boolean, agents: boolean): string => ` ${say(T.tail, { asks: waits ? 'yes' : 'no', keep: cards && agents ? 'both' : cards ? 'cards' : agents ? 'agents' : 'none' })}`

/** An agent a lane watch follows (HI-1987), as its line tells it: what it did, its reply cut to `max` (agentWatch's agentPart). */
export interface LaneAgentHit {
  agent: Pick<WatchedAgent, 'name' | 'project'>
  event: AgentEvent
  text: (max: number) => string
}

/**
 * The wake line for a lane watch's hits: each lane, then what happened in it, then the cards beside its lanes that
 * changed (#726, as a card watch tells them) and the agents waiting for the user (#726), one line within WAKE_MAX_BYTES.
 * `watching`: it has cards beside its lanes (the line says they stay). Details (blocked and stalled reasons, comments,
 * what an agent asks) give way first, then labels shorten to the lane's name (HI-2522; its id only for a lane from before), then each lane is only counted, the cards
 * named in a few words and the waiting agents by name.
 */
export function laneWakeLine(hits: readonly LaneHit[], more: { cards?: readonly CardChange[]; waits?: readonly WaitHit[]; watching?: boolean; agents?: readonly LaneAgentHit[]; following?: boolean } = {}): string {
  const cards = more.cards ?? []
  const waits = more.waits ?? []
  const agents = more.agents ?? []
  const asks = waits.length > 0 || hits.some((h) => h.parts.some((p) => p.event === 'paused-user'))
  const TAIL = tailOf(asks, !!more.watching, !!more.following)
  const part = (p: LaneHit['parts'][number], detail: number): string => (p.detail && detail ? `${p.text}: "${clip(p.detail, detail)}"` : p.text)
  const join = (lanes: string[], cs: string[], ws: string[], as: string[]): string => [...lanes, cs.join('; '), ws.join('; '), as.join('; ')].filter(Boolean).join(' | ')
  for (const detail of [120, 50, 0]) {
    for (const short of [false, true]) {
      const line = `${NOTICE_PREFIX}${join(hits.map((h) => say(T.lane, { lane: short ? (h.short ?? h.id) : h.label, events: h.parts.map((p) => part(p, detail)).join('; ') })), cards.map((c) => cardPart(c, detail)), waits.map((w) => waitPart(w, detail)), agents.map((a) => a.text(detail)))}.${TAIL}`
      if (jsonBytes(line) <= WAKE_MAX_BYTES) return line
    }
  }
  // The events by name (failed, merge-due…): the names a watch's `events` takes.
  const lanes = hits.length ? [say(T.lanesChanged, { n: hits.length, lanes: hits.map((h) => `${h.short ?? h.id} (${h.parts.map((p) => (p.n ? `${cardRef(p.n)} ${p.event}` : p.event)).join(', ')})`).join(', ') })] : []
  const counts = `${NOTICE_PREFIX}${join(lanes, cards.map(brief), waits.length ? [say(T.waitingNames, { agents: waits.map((w) => `${w.name} (${w.project})`).join(', ') })] : [], agents.length ? [say(T.agentsChanged, { agents: agents.map((a) => `${a.agent.name} (${a.agent.project}) ${a.event}`).join(', ') })] : [])}`
  if (jsonBytes(counts + `.${TAIL}`) <= WAKE_MAX_BYTES) return `${counts}.${TAIL}`
  const what = [hits.length ? say(T.countLanes, { n: hits.length }) : '', cards.length ? say(T.countCards, { n: String(cards.length) }) : '', waits.length ? say(T.countWaits, { n: waits.length }) : '', agents.length ? say(T.countAgents, { n: String(agents.length) }) : ''].filter(Boolean).join(', ')
  return `${NOTICE_PREFIX}${say(T.counted, { what })}${TAIL}`
}

const cardList = (cards: readonly number[]): string => cards.map((n) => `${cardRef(n)}`).join(', ')

/** A lane watch's lanes, for its messages: all, one (by its id) or how many. */
const lanesOf = (cond: LaneWatchCondition, titles?: Readonly<Record<string, LaneTitle>>): { lanes: string; lane: string; n: string } =>
  cond.ids === 'all' ? { lanes: 'all', lane: '', n: '' } : cond.ids.length === 1 ? { lanes: 'one', lane: say(T.oneLane, laneTitleArgs(cond.ids[0], titles?.[cond.ids[0]])), n: '1' } : { lanes: 'some', lane: '', n: String(cond.ids.length) }

/**
 * How a lane is named in a watch's label (HI-2522), as wake.lane.oneLane and the window's panes.watch.oneLane take it:
 * by its name (its builder's too when another lane has it), else as its builder's lane; one not known (a watch from
 * before HI-2522 on a lane no longer listed) as "a lane", never by its id (round 1 finding).
 */
export const laneTitleArgs = (id: string, t: LaneTitle | null | undefined): { kind: 'named' | 'both' | 'builder' | 'none'; name: string; builder: string } =>
  !t ? { kind: 'none', name: '', builder: '' } : t.name ? { kind: t.twin ? 'both' : 'named', name: t.name, builder: t.builder } : { kind: 'builder', name: '', builder: t.builder }

/**
 * Each lane's title (HI-2522) from the lanes in the watcher's view: its name and builder, and whether another lane there
 * has the same name.
 */
export function laneTitlesOf(ids: readonly string[], lanes: readonly { id: string; name: string | null; builder: { name: string } }[]): Record<string, LaneTitle> {
  const out: Record<string, LaneTitle> = {}
  for (const id of ids) {
    const l = lanes.find((x) => x.id === id)
    if (!l) continue
    const name = l.name?.trim() || null
    const twin = !!name && lanes.some((x) => x.id !== id && x.name?.trim().toLowerCase() === name.toLowerCase())
    out[id] = { name, builder: l.builder.name, ...(twin ? { twin: true as const } : {}) }
  }
  return out
}

/** A lane watch's label (its status, the pane): "Waiting on all running lanes", "Waiting on 3 lanes", with its cards (#726) "… and #720". */
export const laneWatchLabel = (cond: LaneWatchCondition, cards: readonly number[] = [], agents: readonly Pick<WatchedAgent, 'name'>[] = [], titles?: Readonly<Record<string, LaneTitle>>): string =>
  say(T.label, { ...lanesOf(cond, titles), also: cards.length || agents.length ? 'yes' : 'no', list: [...(cards.length ? [cardList(cards)] : []), ...agents.map((a) => a.name)].join(', ') })

/** The line typed when a lane watch's limit passes with nothing to tell. */
export function laneLimitLine(cond: LaneWatchCondition, minutes: number, cards: readonly number[] = [], agents: readonly Pick<WatchedAgent, 'name'>[] = [], titles?: Readonly<Record<string, LaneTitle>>): string {
  const also = [...(cards.length ? [cardList(cards)] : []), ...agents.map((a) => a.name)]
  const hours = minutes >= 60
  return NOTICE_PREFIX + say(T.limit, { ...lanesOf(cond, titles), also: also.length ? 'yes' : 'no', list: also.join(', '), hours: hours ? 'yes' : 'no', time: String(hours ? Math.round((minutes / 60) * 10) / 10 : minutes), agents: agents.length ? 'yes' : 'no' })
}

/** What became of a lane watch's cards beside its lanes (#726): those it has now, kept from the last lane watch, the ones they replace, and kept ones left out (done or gone). */
export interface LaneWatchCards {
  now: number[]
  kept?: true
  replaced?: number[]
  dropped?: number[]
  /** Of `now`, the watched lanes' own cards (#1531): kept as asked, but each wakes it on every move. */
  inLanes?: number[]
}

/**
 * What became of a lane watch's agents beside its lanes (HI-1987): those it follows now ("B2 (alpha)"), kept from the
 * last lane watch, and those not followed for not working now, each with its state (agentWatch's agentPart).
 */
export interface LaneWatchAgents {
  now: string[]
  kept?: true
  already?: string[]
}

/**
 * The cards beside a lane watch's lanes (#726) from untrusted arguments (`cards`, `changes`), or what is wrong. `cards`
 * left out keeps the last lane watch's, [] drops them; `changes` left out keeps theirs (else LANE_CARD_CHANGES).
 */
export function readLaneCards(args: { cards?: unknown; changes?: unknown }): { cards?: number[]; changes?: WatchChange[] } | string {
  const out: { cards?: number[]; changes?: WatchChange[] } = {}
  if (args.cards !== undefined) {
    const raw = args.cards
    if (!Array.isArray(raw) || raw.some((n) => !Number.isInteger(n) || (n as number) <= 0) || new Set(raw).size !== raw.length) return say(T.badCards)
    if (raw.length > WATCH_MAX_CARDS) return say(T.tooManyCards, { max: String(WATCH_MAX_CARDS) })
    out.cards = raw as number[]
  }
  if (args.changes !== undefined) {
    const c = args.changes
    if (!Array.isArray(c) || !c.length || c.some((x) => !WATCH_CHANGES.includes(x as WatchChange))) return say(T.badChanges, { changes: WATCH_CHANGES.join(', ') })
    out.changes = [...new Set(c as WatchChange[])]
  }
  return out
}

/** A lane watch's condition from untrusted arguments (`lanes`, `events`), or what is wrong. */
export function readLaneCondition(args: { lanes?: unknown; events?: unknown }): LaneWatchCondition | string {
  const l = args.lanes
  let ids: string[] | 'all'
  if (l === 'all' || (Array.isArray(l) && l.length === 1 && l[0] === 'all')) ids = 'all'
  else if (Array.isArray(l) && l.length && l.length <= LANE_WATCH_MAX && l.every((x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x)) && new Set(l).size === l.length) ids = l as string[]
  else return say(T.badLanes, { max: String(LANE_WATCH_MAX) })
  const e = Array.isArray(args.events) ? args.events.map((x) => (typeof x === 'string' && Object.hasOwn(LANE_EVENT_ALIASES, x) ? LANE_EVENT_ALIASES[x] : x)) : args.events
  if (e === undefined) return { ids, events: withAlwaysEvents(ids, LANE_DEFAULT_EVENTS) }
  if (!Array.isArray(e) || !e.length || e.some((x) => !LANE_EVENTS.includes(x as LaneEvent))) return say(T.badEvents, { events: LANE_EVENTS.join(', ') })
  // A question for the user always counts (HI-1991), whatever was asked for; so does named lanes' end (HI-2521), in a
  // watch read back from before too.
  return { ids, events: withAlwaysEvents(ids, e as LaneEvent[]) }
}

/** A saved lane watch condition, checked (null: not one Hive would have made). */
export function readSavedLaneCondition(v: unknown): LaneWatchCondition | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = readLaneCondition({ lanes: (v as { ids?: unknown }).ids === 'all' ? 'all' : (v as { ids?: unknown }).ids, events: (v as { events?: unknown }).events })
  return typeof r === 'string' || !Array.isArray((v as { events?: unknown }).events) ? null : r
}

const STATES = ['active', 'paused', 'ended', 'abandoned', 'gone']
const COLS = ['hold', 'todo', 'doing', 'review', 'passed', 'done', 'gone']
const iso = (x: unknown): x is string => x === '' || (typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x)))

/** A saved lane mark, checked (null: not one). */
export function readSavedLaneMark(v: unknown): LaneMark | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (!STATES.includes(r.state as string) || typeof r.mergeDue !== 'boolean' || !r.cards || typeof r.cards !== 'object' || Array.isArray(r.cards)) return null
  const cards: Record<string, LaneCardMark> = {}
  const entries = Object.entries(r.cards as Record<string, unknown>)
  if (entries.length > 200) return null
  for (const [k, c] of entries) {
    const m = c as Record<string, unknown> | null
    if (!/^\d{1,9}$/.test(k) || !m || !COLS.includes(m.c as string) || typeof m.b !== 'boolean' || typeof m.s !== 'boolean' || !iso(m.f) || !iso(m.p)) return null
    if ((m.r !== undefined && !iso(m.r)) || (m.q !== undefined && !iso(m.q))) return null
    cards[k] = { c: m.c as LaneCardMark['c'], b: m.b, s: m.s, f: m.f, p: m.p, ...(typeof m.r === 'string' ? { r: m.r } : {}), ...(typeof m.q === 'string' ? { q: m.q } : {}) }
  }
  return { state: r.state as LaneMark['state'], mergeDue: r.mergeDue, ...(r.ms === true ? { ms: true } : {}), cards }
}
