import type { LaneState, LaneStatus, SessionStatus, TaskCard, TaskColumn } from './types'
import { laneStatusText } from './lanes'
import { columnLabel } from './tasks'
import { brief, cardPart, WAKE_MAX_BYTES, WATCH_CHANGES, WATCH_MAX_CARDS, type CardChange, type WatchChange } from './watch'
import { cardRef } from './projectKeys'

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

/** What a lane watch counts. The default is all but `passed` and `moved`. */
export const LANE_EVENTS = ['failed', 'blocked', 'stalled', 'merge-due', 'ended', 'abandoned', 'waiting', 'passed', 'moved', 'paused'] as const
export type LaneEvent = (typeof LANE_EVENTS)[number]
export const LANE_DEFAULT_EVENTS: LaneEvent[] = ['failed', 'blocked', 'stalled', 'merge-due', 'ended', 'abandoned', 'waiting']
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
  mark: LaneMark
  cards: { number: number; blocked: string | null; stalled: string | null; failedBy: string | null; passedBy: string | null }[]
  /** Why its merge has stalled (#869), when it has. */
  mergeStall?: string | null
  /** Why it waits (#1270), as main worked it out: a pause the other events don't tell (a card not merged, merging). */
  status?: LaneStatus | null
}

/** One lane's events since its mark: what the wake line tells. */
export interface LaneHit {
  id: string
  label: string
  parts: { n: number | null; event: LaneEvent; text: string; detail?: string }[]
}

const VERDICT_FAILED = /^Review failed\b/
const VERDICT_PASSED = /^Review passed\b/

/** A card's latest failed and passed verdicts: when, and by whom ("R1 (alpha)"). */
export function verdictsOf(card: Pick<TaskCard, 'history'>): { failed: { at: string; by: string } | null; passed: { at: string; by: string } | null } {
  const f = card.history.findLast((h) => VERDICT_FAILED.test(h.what))
  const p = card.history.findLast((h) => VERDICT_PASSED.test(h.what))
  return { failed: f ? { at: f.at, by: f.by } : null, passed: p ? { at: p.at, by: p.by } : null }
}

/** A lane's card mark from the card (null: gone from the watcher's view) and its stall, if any. */
export function laneCardMark(card: Pick<TaskCard, 'column' | 'blocked' | 'history' | 'archived'> | null, stalled: string | null): LaneCardMark {
  if (!card || card.archived) return { c: 'gone', b: false, s: false, f: '', p: '' }
  const v = verdictsOf(card)
  return { c: card.column, b: !!card.blocked, s: !!stalled, f: v.failed?.at ?? '', p: v.passed?.at ?? '' }
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
  return builder ? `Every card passed, but ${lane.builder} has been idle for ${minutes} min with no merge slot claimed.` : `Every card passed, but ${lane.builder} isn't running.`
}

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
    const was = before.cards[c.number] ?? (since && is ? { c: is.c, b: false, s: false, f: since, p: since } : undefined)
    if (!was || !is || is.c === 'gone') continue
    if (on.has('failed') && is.f > was.f) parts.push({ n: c.number, event: 'failed', text: `${cardRef(c.number)} failed review${c.failedBy ? ` (${c.failedBy})` : ''}` })
    if (on.has('passed') && is.p > was.p) parts.push({ n: c.number, event: 'passed', text: `${cardRef(c.number)} passed review${c.passedBy ? ` (${c.passedBy})` : ''}` })
    if (on.has('blocked') && is.b && !was.b) parts.push({ n: c.number, event: 'blocked', text: `${cardRef(c.number)} is blocked`, ...(c.blocked ? { detail: c.blocked } : {}) })
    if (on.has('stalled') && is.s && !was.s) parts.push({ n: c.number, event: 'stalled', text: `${cardRef(c.number)} is stalled`, ...(c.stalled ? { detail: c.stalled } : {}) })
    if (on.has('moved') && is.c !== was.c) parts.push({ n: c.number, event: 'moved', text: `${cardRef(c.number)} is in ${columnLabel(is.c)}` })
  }
  if (on.has('merge-due') && now.mark.mergeDue && !before.mergeDue && now.mark.state !== 'ended' && now.mark.state !== 'abandoned') parts.push({ n: null, event: 'merge-due', text: 'all its cards passed: its merge is due' })
  if (on.has('stalled') && now.mark.ms && !before.ms) parts.push({ n: null, event: 'stalled', text: 'its merge is stalled', ...(now.mergeStall ? { detail: now.mergeStall } : {}) })
  // Paused for a reason the events above don't tell (#1270): a blocked or held card, a request for you and the round
  // limit are told as themselves (blocked, For you); one card at a time waiting for a merge isn't.
  const s = now.status
  if (on.has('paused') && now.mark.state === 'paused' && before.state !== 'paused' && s && (s.reason === 'notMerged' || s.reason === 'merging')) parts.push({ n: s.card, event: 'paused', text: `paused: ${laneStatusText(s)}`, detail: s.reason })
  if (on.has('ended') && now.mark.state === 'ended' && before.state !== 'ended') parts.push({ n: null, event: 'ended', text: 'ended (merged)' })
  if (on.has('abandoned') && now.mark.state === 'abandoned' && before.state !== 'abandoned') parts.push({ n: null, event: 'abandoned', text: 'was abandoned' })
  return parts.length ? { id: now.id, label: now.label, parts } : null
}

/**
 * Where a lane first seen by a watch on every lane starts, when it began after the watch did (#531): its cards as they
 * are, but neither blocked nor stalled, and no verdict before the watch began (`since`). So a block or stall it already
 * has is told once, and a verdict since the watch began; a lane there when the watch began starts from now instead.
 */
export function newLaneBase(now: LaneNow, since: string): LaneMark {
  const cards: Record<string, LaneCardMark> = {}
  for (const [n, c] of Object.entries(now.mark.cards)) cards[n] = { c: c.c, b: false, s: false, f: since, p: since }
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

const waitPart = (w: WaitHit, detail: number): string => `${w.name} (${w.project}) is waiting for the user${w.card ? ` on ${cardRef(w.card)}` : ''}${w.what && detail ? `: "${clip(w.what, detail)}"` : ''}`

/** What a lane watch's line ends with: what to do, with the waits and the cards beside its lanes when it tells or keeps them. */
const tailOf = (waits: boolean, cards: boolean): string =>
  ` Your lane watch has ended: read the cards named (hive_read_task), act on them, ${waits ? 'tell the user what an agent waits for (hive_notify) and never answer it for them, ' : ''}then watch the lanes again (hive_wait_for_tasks with lanes${cards ? '; your cards stay unless you pass cards' : ''}).`

/**
 * The wake line for a lane watch's hits: each lane, then what happened in it, then the cards beside its lanes that
 * changed (#726, as a card watch tells them) and the agents waiting for the user (#726), one line within WAKE_MAX_BYTES.
 * `watching`: it has cards beside its lanes (the line says they stay). Details (blocked and stalled reasons, comments,
 * what an agent asks) give way first, then labels shorten to the lane's id, then each lane is only counted, the cards
 * named in a few words and the waiting agents by name.
 */
export function laneWakeLine(hits: readonly LaneHit[], more: { cards?: readonly CardChange[]; waits?: readonly WaitHit[]; watching?: boolean } = {}): string {
  const cards = more.cards ?? []
  const waits = more.waits ?? []
  const TAIL = tailOf(waits.length > 0, !!more.watching)
  const part = (p: LaneHit['parts'][number], detail: number): string => (p.detail && detail ? `${p.text}: "${clip(p.detail, detail)}"` : p.text)
  const join = (lanes: string[], cs: string[], ws: string[]): string => [...lanes, cs.join('; '), ws.join('; ')].filter(Boolean).join(' | ')
  for (const detail of [120, 50, 0]) {
    for (const short of [false, true]) {
      const line = `[Hive] ${join(hits.map((h) => `Lane ${short ? h.id : h.label}: ${h.parts.map((p) => part(p, detail)).join('; ')}`), cards.map((c) => cardPart(c, detail)), waits.map((w) => waitPart(w, detail)))}.${TAIL}`
      if (jsonBytes(line) <= WAKE_MAX_BYTES) return line
    }
  }
  const lanes = hits.length ? [`${hits.length} lane${hits.length === 1 ? '' : 's'} changed: ${hits.map((h) => `${h.id} (${h.parts.map((p) => (p.n ? `${cardRef(p.n)} ${p.event}` : p.event)).join(', ')})`).join(', ')}`] : []
  const counts = `[Hive] ${join(lanes, cards.map(brief), waits.length ? [`waiting for the user: ${waits.map((w) => `${w.name} (${w.project})`).join(', ')}`] : [])}`
  if (jsonBytes(counts + `.${TAIL}`) <= WAKE_MAX_BYTES) return `${counts}.${TAIL}`
  const what = [hits.length ? `${hits.length} lane${hits.length === 1 ? '' : 's'} changed` : '', cards.length ? `${cards.length} of your cards changed` : '', waits.length ? `${waits.length} agent${waits.length === 1 ? ' is' : 's are'} waiting for the user` : ''].filter(Boolean).join(', ')
  return `[Hive] ${what}: list them (hive_lane list, hive_list_projects) and read their cards.${TAIL}`
}

const cardList = (cards: readonly number[]): string => cards.map((n) => `${cardRef(n)}`).join(', ')

/** A lane watch's label (its status, the pane): "Waiting on all running lanes", "Waiting on 3 lanes", with its cards (#726) "… and #720". */
export const laneWatchLabel = (cond: LaneWatchCondition, cards: readonly number[] = []): string =>
  `${cond.ids === 'all' ? 'Waiting on all running lanes' : `Waiting on ${cond.ids.length === 1 ? `lane ${cond.ids[0]}` : `${cond.ids.length} lanes`}`}${cards.length ? ` and ${cardList(cards)}` : ''}`

/** The line typed when a lane watch's limit passes with nothing to tell. */
export function laneLimitLine(cond: LaneWatchCondition, minutes: number, cards: readonly number[] = []): string {
  const dur = minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10} h` : `${minutes} min`
  return `[Hive] Nothing to tell on ${cond.ids === 'all' ? 'the running lanes' : cond.ids.length === 1 ? `lane ${cond.ids[0]}` : `${cond.ids.length} lanes`}${cards.length ? ` or ${cardList(cards)}` : ''} in ${dur}: your lane watch has ended. Check them (hive_lane list), then watch again, or tell the user (hive_notify) if one seems stuck.`
}

/** What became of a lane watch's cards beside its lanes (#726): those it has now, kept from the last lane watch, the ones they replace, and kept ones left out (done or gone). */
export interface LaneWatchCards {
  now: number[]
  kept?: true
  replaced?: number[]
  dropped?: number[]
}

/**
 * The cards beside a lane watch's lanes (#726) from untrusted arguments (`cards`, `changes`), or what is wrong. `cards`
 * left out keeps the last lane watch's, [] drops them; `changes` left out keeps theirs (else LANE_CARD_CHANGES).
 */
export function readLaneCards(args: { cards?: unknown; changes?: unknown }): { cards?: number[]; changes?: WatchChange[] } | string {
  const out: { cards?: number[]; changes?: WatchChange[] } = {}
  if (args.cards !== undefined) {
    const raw = args.cards
    if (!Array.isArray(raw) || raw.some((n) => !Number.isInteger(n) || (n as number) <= 0) || new Set(raw).size !== raw.length) return 'cards must be card numbers (no repeats), or [] for none'
    if (raw.length > WATCH_MAX_CARDS) return `at most ${WATCH_MAX_CARDS} cards`
    out.cards = raw as number[]
  }
  if (args.changes !== undefined) {
    const c = args.changes
    if (!Array.isArray(c) || !c.length || c.some((x) => !WATCH_CHANGES.includes(x as WatchChange))) return `changes must be any of ${WATCH_CHANGES.join(', ')}`
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
  else return `lanes must be lane ids (hive_lane list), at most ${LANE_WATCH_MAX}, or ["all"]`
  const e = args.events
  if (e === undefined) return { ids, events: [...LANE_DEFAULT_EVENTS] }
  if (!Array.isArray(e) || !e.length || e.some((x) => !LANE_EVENTS.includes(x as LaneEvent))) return `events must be any of ${LANE_EVENTS.join(', ')}`
  return { ids, events: [...new Set(e as LaneEvent[])] }
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
    cards[k] = { c: m.c as LaneCardMark['c'], b: m.b, s: m.s, f: m.f, p: m.p }
  }
  return { state: r.state as LaneMark['state'], mergeDue: r.mergeDue, ...(r.ms === true ? { ms: true } : {}), cards }
}
