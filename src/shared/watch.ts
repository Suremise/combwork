/**
 * Waiting on cards (#128): what an agent waits for (cards, which changes count, a column to arrive in), what counts as a
 * change since it began waiting, and the one line Hive types to wake it. Pure, so the Agent API's waits, Hive's
 * wake-on-change watches and tests share it.
 *
 * A change is found by comparing each card with a snapshot taken when the wait began: its column, its latest comment's
 * time, its latest review verdict's time, its agent, and whether it is archived (or gone). A wait for a column alone
 * ("until it is in Review") counts only that: it is met as soon as the card is in that column, also if it already was,
 * and nothing else wakes it (a comment while the card is still in Doing doesn't). A column with `changes` naming
 * `column` is a move into it, or any other change listed ("verdict or into Done"); a card already there is met at once
 * too (#434). Only `fresh` waits for the next move into it: a card there must leave and come back.
 */
import type { StoredText, TaskCard, TaskColumn } from './types'
import { HISTORY, storedForAgents } from './taskHistory'
import { COLUMN_CHOICES, COLUMN_IDS, TASK_COLUMNS, columnLabel, isLoopStepEntry } from './tasks'
import { cardRef } from './projectKeys'
import { CAME_BACK } from './workflow/queue'
import { agentMsg, say } from './agentText'
import { NOTICE_PREFIX } from './doorbell'

/**
 * What counts as a change: a column move, a new comment, a review verdict, a change of agent. Default: any. `blocked` (a
 * card becoming blocked) isn't one to choose: a lane watch counts it for the cards beside its lanes (#726, `blocked`).
 * Nor are `request` (its reviewer asked its builder for something, #912) and `decision` (the user recorded, changed or
 * removed a decision): a watch that counts a verdict, a move or a comment counts them too (#1272, SPEC §16.8.2), and
 * so `step` (a card loop's step between builder and reviewer, #1382).
 */
export type WatchChange = 'column' | 'comment' | 'verdict' | 'agent' | 'blocked' | 'request' | 'decision' | 'step'
export const WATCH_CHANGES: readonly WatchChange[] = ['column', 'comment', 'verdict', 'agent']

/** A wait's condition: the cards (numbers), which changes count, and optionally a column one of them must be in. */
export interface WatchCondition {
  cards: number[]
  changes: WatchChange[]
  column?: TaskColumn
  /**
   * With a column: a move into it, or any other change listed (`changes` named `column` explicitly). A card already
   * there is met at once, as for a column alone (#434).
   */
  moveInto?: true
  /**
   * With a column (and so a move into it): only the next move into it counts. A card already there waits until it
   * leaves and comes back, or is returned for review: a reviewer waiting for a failed card's next round.
   */
  fresh?: true
  /** A card becoming blocked counts too (#726: the cards beside a lane watch's lanes). */
  blocked?: true
}

/** At most this many cards in one wait. */
export const WATCH_MAX_CARDS = 20
/** A bounded wait's longest (seconds): under Codex's tool timeout for hive (900 s), with room for the reply. */
export const WAIT_MAX_SECONDS = 840
/** The longest an Agent API agents wait (`POST /v1/agents/wait`, cw_wait_for_agents) holds a call. */
export const AGENT_WAIT_MAX_SECONDS = 600
/** A watch's default overall limit with no change before Hive wakes the agent to say so (minutes), and the most allowed. */
export const WATCH_DEFAULT_LIMIT_MINUTES = 120
export const WATCH_MAX_LIMIT_MINUTES = 24 * 60

/** A card as a wait last saw it. */
export interface CardMark {
  column: TaskColumn | 'gone'
  /** Latest comment's and verdict's times (ms; 0: none), its agent ('' none), archived. */
  comment: number
  verdict: number
  agent: string
  archived: boolean
}

const COLUMNS: readonly string[] = COLUMN_IDS
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A saved mark, checked (null: not one). */
export function readMark(v: unknown): CardMark | null {
  if (!isObj(v)) return null
  const column = v.column as CardMark['column']
  if (![...COLUMNS, 'gone'].includes(column) || !isTime(v.comment) || !isTime(v.verdict) || typeof v.agent !== 'string' || v.agent.length > 128 || typeof v.archived !== 'boolean') return null
  return { column, comment: v.comment, verdict: v.verdict, agent: v.agent, archived: v.archived }
}

/** A saved condition, checked (null: not one Hive would have made). */
export function readSavedCondition(v: unknown): WatchCondition | null {
  if (!isObj(v) || !Array.isArray(v.cards) || !Array.isArray(v.changes)) return null
  const cards = v.cards
  if (!cards.length || cards.length > WATCH_MAX_CARDS || cards.some((n) => !Number.isInteger(n) || (n as number) <= 0) || new Set(cards).size !== cards.length) return null
  const changes = v.changes
  if (!changes.length || changes.some((c) => !WATCH_CHANGES.includes(c as WatchChange)) || new Set(changes).size !== changes.length) return null
  if (v.column !== undefined && !COLUMNS.includes(v.column as string)) return null
  if (v.moveInto !== undefined && (v.moveInto !== true || v.column === undefined)) return null
  if (v.fresh !== undefined && (v.fresh !== true || v.moveInto !== true)) return null
  if (v.blocked !== undefined && v.blocked !== true) return null
  // A column goes with `column` among the changes (as readCondition makes it).
  if (v.column !== undefined && !changes.includes('column')) return null
  return { cards: cards as number[], changes: changes as WatchChange[], ...(v.column ? { column: v.column as TaskColumn } : {}), ...(v.moveInto ? { moveInto: true as const } : {}), ...(v.fresh ? { fresh: true as const } : {}), ...(v.blocked ? { blocked: true as const } : {}) }
}

/** A card's mark now (null card: gone). */
export function markOf(card: TaskCard | null): CardMark {
  if (!card) return { column: 'gone', comment: 0, verdict: 0, agent: '', archived: false }
  const last = card.comments.at(-1)
  const verdict = card.history.filter((h) => verdictOf(h) !== null).at(-1)
  return { column: card.column, comment: last ? Date.parse(last.at) || 0 : 0, verdict: verdict ? Date.parse(verdict.at) || 0 : 0, agent: card.agent ?? '', archived: card.archived }
}

/**
 * Whether a card moved into `column` after `since` (ISO), by its history (moved there, to its top or bottom, or before
 * another card in it; made there): a card that left and came back looks the same as one that never moved, by its marks.
 */
export function movedIntoSince(card: TaskCard | null, column: TaskColumn, since: string): boolean {
  if (!card) return false
  // A failed card returned for review without leaving Review (#214) comes back into it as much as one moved there.
  return card.history.some((h) => h.at > since && intoColumn(h) === column)
}

/**
 * What a history line says, for watches (dialects, HI-2437): by its message's id and values (`whatText`, #845), never its
 * words, which a dialect may change. A line from before #845 has only its English (`what`), stored once and never said
 * again: it is read by that English, the protocol of those old lines (decision 5: no migration).
 */
type HistoryLine = { what: string; whatText?: StoredText }
const H = HISTORY
const lineMsg = (e: HistoryLine): StoredText | null => (e.whatText && typeof e.whatText.id === 'string' ? e.whatText : null)
const isId = (e: HistoryLine, ...ms: { id: string }[]): boolean => {
  const s = lineMsg(e)
  return !!s && ms.some((m) => m.id === s.id)
}
/** The lines that move a card into the column their `column` value names (placing it before another, or Nth, isn't one). */
const MOVES = [H.moved, H.movedTop, H.movedBottom, H.movedBefore]
const columnValue = (s: StoredText): TaskColumn | null => {
  const c = s.values?.column
  return typeof c === 'string' && (COLUMN_IDS as readonly string[]).includes(c) ? (c as TaskColumn) : null
}

// The English of lines from before #845, as they were written then.
// agent-protocol: stored history lines from before #845, matched by their fixed English
const INTO_COLUMN = new RegExp(String.raw`^(?:Moved to (?:the (?:top|bottom) of )?|Created in )(${TASK_COLUMNS.map((c) => c.label).join('|')})\b|^(Returned for review)\b`)
const COLUMN_OF: Record<string, TaskColumn> = Object.fromEntries(TASK_COLUMNS.map((c) => [c.label, c.id]))
const MOVED_TO = /^Moved to (?:the (?:top|bottom) of )?(On Hold|Todo|Doing|Review|Passed|Done)\b/
const VERDICT = /^Review (passed|failed)/
const HANDS = /^(Given to|Taken from)\b/

/** The column a history line puts a card in (a move, made there, returned for review), else null. */
const intoColumn = (e: HistoryLine): TaskColumn | null => {
  const s = lineMsg(e)
  if (s) return s.id === H.returned.id ? 'review' : s.id === H.created.id || MOVES.some((m) => m.id === s.id) ? columnValue(s) : null
  const m = INTO_COLUMN.exec(e.what)
  return m ? (m[2] ? 'review' : COLUMN_OF[m[1]]) : null
}
/** The column a line moves a card to (not made there, nor returned for review), else null. */
const movedTo = (e: HistoryLine): TaskColumn | null => {
  const s = lineMsg(e)
  if (s) return MOVES.some((m) => m.id === s.id) ? columnValue(s) : null
  const m = MOVED_TO.exec(e.what)
  return m ? COLUMN_OF[m[1]] : null
}
/** A review's verdict in a line, else null. */
const verdictOf = (e: HistoryLine): 'passed' | 'failed' | null => {
  const s = lineMsg(e)
  if (s) return s.id === H.reviewPassed.id ? 'passed' : s.id === H.reviewFailed.id ? 'failed' : null
  const m = VERDICT.exec(e.what)
  return m ? (m[1] as 'passed' | 'failed') : null
}
/** Given to an agent or taken from one. */
const hands = (e: HistoryLine): boolean => (lineMsg(e) ? isId(e, H.given, H.takenFrom, H.takenFromAgent, H.takenFromOf, H.takenFromOfWorkspace) : HANDS.test(e.what))

// agent-protocol: stored history lines from before #845, matched by their fixed English
const REVIEW_STEP = /^(?:(Started reviewing)|Review (passed|failed)|(Review by .* stopped))/
const REVIEW_STEP_WHOLE = /^(?:(Started reviewing)|Review (passed|failed))$/
/**
 * A review's step in a line: started, its verdict, or stopped (by the user, or its session ended), else null. A line
 * from before #845 is read by its English: by how it starts, or with `whole`, only a started or a verdict line that is
 * nothing more ("Review passed"), as each caller read them before.
 */
export function reviewStep(e: HistoryLine, whole = false): 'started' | 'passed' | 'failed' | 'stopped' | null {
  const s = lineMsg(e)
  if (s) return s.id === H.reviewStarted.id ? 'started' : s.id === H.reviewStopped.id || s.id === H.reviewEnded.id ? 'stopped' : verdictOf(e)
  const m = (whole ? REVIEW_STEP_WHOLE : REVIEW_STEP).exec(e.what)
  return !m ? null : m[1] ? 'started' : m[2] ? (m[2] as 'passed' | 'failed') : 'stopped'
}

/** Marked blocked, in a line. */
export const historyBlocked = (e: HistoryLine): boolean => (lineMsg(e) ? isId(e, H.blocked) : BLOCKED.test(e.what))
/** A review's verdict, in a line read whole (a line from before #845: "Review passed", nothing more). */
export const historyWholeVerdict = (e: HistoryLine): boolean => {
  const s = reviewStep(e, true)
  return s === 'passed' || s === 'failed'
}
/** Returned for review (#214), in a line. */
export const historyReturned = (e: HistoryLine): boolean => (lineMsg(e) ? isId(e, H.returned) : RETURNED_ANY.test(e.what))
// agent-protocol: a stored history line from before #845, matched by its fixed English
const RETURNED_ANY = /^Returned for review/

export { intoColumn as historyIntoColumn, movedTo as historyMovedTo, verdictOf as historyVerdict }

/**
 * Where a watch's view of a card's history or comments ends (#224): the last entry it counted. By the entry's id
 * (`id:…`), which is unique on the card; for an entry from before ids, by its time, a short hash of who and what, and
 * its place (`<at>|<hash>|<place>`). Times alone can't order them: two entries can share a millisecond, also alike.
 */
export type EntryKey = string
type Entry = { at: string; by: string; what?: string; text?: string; id?: string }
const ID = /^[0-9a-f]{6,32}$/
const hasId = (e: Entry): boolean => typeof e.id === 'string' && ID.test(e.id)
const fnv = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
const hashOf = (e: Entry): string => fnv(`${e.by}\n${e.what ?? e.text ?? ''}`)
const keyAt = (list: Entry[], i: number): EntryKey => {
  const e = list[i]
  return hasId(e) ? `id:${e.id}` : `${e.at}|${hashOf(e)}|${i + 1}`
}
export const ENTRY_KEY = /^(id:[0-9a-f]{6,32}|[0-9TZ:.+-]{1,40}\|[0-9a-f]{8}\|\d{1,6})$/

/** Where a watch's view of a card ends: the last history entry and comment it had seen (null: none yet). */
export interface Seen {
  h: EntryKey | null
  c: EntryKey | null
}
export const seenOf = (card: TaskCard): Seen => ({ h: card.history.length ? keyAt(card.history, card.history.length - 1) : null, c: card.comments.length ? keyAt(card.comments, card.comments.length - 1) : null })

/**
 * Whether `entry` (one of `list`'s, as it was read then) is at or before the entry `key` names: a view that ended there
 * had it (#578). By its id; one from before ids by its time, text and author. Not in the list any more, or the key's
 * entry gone: false (nothing shows it was seen).
 */
export function entryWithin<T extends Entry>(list: T[], entry: T, key: EntryKey | null): boolean {
  if (!key) return false
  const i = hasId(entry) ? list.findIndex((e) => e.id === entry.id) : list.findIndex((e) => !hasId(e) && e.at === entry.at && e.by === entry.by && hashOf(e) === hashOf(entry))
  if (i < 0) return false
  const after = entriesAfter(list, key)
  // The key's entry not found (entriesAfter gives the whole list): nothing is within it.
  return after.length < list.length && i < list.length - after.length
}

/**
 * The entries after the one `key` names (all of them for null). A card's history and comments only grow at the end and
 * are capped at the start, so when that entry is no longer kept, every entry still kept came after it.
 */
function entriesAfter<T extends Entry>(list: T[], key: EntryKey | null): T[] {
  if (!key) return list
  if (key.startsWith('id:')) {
    const id = key.slice(3)
    const i = list.findIndex((e) => e.id === id)
    return i >= 0 ? list.slice(i + 1) : list
  }
  // An entry from before ids: at its place if it is still there, else the last one like it.
  const [at, hash, place] = key.split('|')
  const like = (e: T): boolean => !hasId(e) && e.at === at && hashOf(e) === hash
  const p = Number(place)
  if (p >= 1 && p <= list.length && like(list[p - 1])) return list.slice(p)
  for (let i = list.length - 1; i >= 0; i--) if (like(list[i])) return list.slice(i + 1)
  return list
}

/** A watch's starting point for a card: the card's mark, and where its view of the card ended. */
export interface Baseline {
  mark: CardMark
  seen: Seen
}

/**
 * A card's starting point for a watch an agent starts after a wake (#224): the card as that wake told it (`told`), moved
 * on, kind by kind, past what the agent (`self`, by its board name) did itself since, which it knows, unless someone else
 * made the same kind of change meanwhile. Anything else that happened since stays new to the watch, whatever its time.
 */
export function carriedOver(card: TaskCard, told: Baseline, self: string): CardMark {
  const h = entriesAfter(card.history, told.seen.h)
  const c = entriesAfter(card.comments, told.seen.c)
  const own = <T extends { by: string }>(xs: T[]): boolean => xs.length > 0 && xs.every((x) => x.by === self)
  const now = markOf(card)
  return {
    column: own(h.filter((e) => intoColumn(e))) ? now.column : told.mark.column,
    comment: own(c) ? now.comment : told.mark.comment,
    verdict: own(h.filter((e) => verdictOf(e) !== null)) ? now.verdict : told.mark.verdict,
    agent: own(h.filter((e) => hands(e))) ? now.agent : told.mark.agent,
    archived: told.mark.archived
  }
}

/**
 * HI-2302: a card's starting point for a watch from just after the watcher's (`self`, by its board name) own last change
 * to it, a comment or a history entry made after `after` (ISO: its launch, so a card it touched in an earlier run doesn't
 * fire a new watch with old news): what others did after that counts, as when PR1 asked PE-39's builder for logs, the
 * builder answered, and PR1's watch began a minute later from the card as it was then, the answer in it. A card's changes
 * have times in their order (tasks.ts changeTime, HI-2315), so only the lines of one change share a time; where others'
 * entries still share that change's millisecond (written before HI-2315), they stay new (a wake too many, never one
 * missed). Null: no such change, or
 * one a wake had already told it of (`told`: that wake is the later point, carriedOver's).
 */
export function ownCut(card: TaskCard, self: string, after: string, told?: Baseline): Baseline | null {
  const lastOwn = <T extends { at: string; by: string }>(xs: T[]): number => xs.findLastIndex((x) => x.by === self && x.at > after)
  const hi = lastOwn(card.history)
  const ci = lastOwn(card.comments)
  if (hi < 0 && ci < 0) return null
  if (told && (hi < 0 || entryWithin(card.history, card.history[hi], told.seen.h)) && (ci < 0 || entryWithin(card.comments, card.comments[ci], told.seen.c))) return null
  const t = [hi >= 0 ? card.history[hi].at : '', ci >= 0 ? card.comments[ci].at : ''].reduce((a, b) => (a > b ? a : b))
  const upTo = <T extends { at: string }>(xs: T[], own: number): T[] => xs.slice(0, Math.max(own, xs.findLastIndex((x) => x.at < t)) + 1)
  const history = upTo(card.history, hi)
  const comments = upTo(card.comments, ci)
  // Its column then: the last move in what it had seen (none kept: as it is now).
  const into = history.findLast((e) => intoColumn(e))
  const cut = { ...card, history, comments, column: into ? intoColumn(into)! : card.column }
  // Its agent then isn't kept by id (a history line names a board name): given to someone or taken from it by another
  // since, the agent it had is unknown (HR1's round 1 finding: the agent as it is now swallowed that reassignment), so the
  // watch counts it; else the card's agent as it is now, unchanged since.
  const handed = card.history.slice(history.length).some((e) => hands(e) && e.by !== self)
  return { mark: { ...markOf(cut), ...(handed ? { agent: AGENT_UNKNOWN } : {}) }, seen: seenOf(cut) }
}

/** A starting mark's agent no card has (ownCut: the card was reassigned since, from an agent not known): any agent differs from it. */
const AGENT_UNKNOWN = '?'

/**
 * What changed on one card since a watch's starting point (`base`), of the kinds that count (a card gone or archived
 * always counts): its column and agent against the starting mark; comments, verdicts and moves into a column by the
 * entries after where its view ended, so none is missed for sharing a millisecond with one already seen (#224). What
 * the watcher (`self`) did itself before the watch began (`since`) isn't news, nor is a comment of its own (`watcher`,
 * #1074: a builder watching for its verdict and a reviewer's comment isn't woken by its own Review comment).
 */
export function changesSince(card: TaskCard | null, base: Baseline & { since: string; self?: string; watcher?: string }, cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto' | 'blocked'>): WatchChange[] | 'gone' {
  const now = markOf(card)
  if (!card || now.column === 'gone' || (now.archived && !base.mark.archived)) return 'gone'
  const kinds = new Set(cond.changes.length ? cond.changes : WATCH_CHANGES)
  const news = <T extends { at: string; by: string }>(xs: T[]): T[] => (base.self ? xs.filter((x) => !(x.by === base.self && x.at <= base.since)) : xs)
  const h = news(entriesAfter(card.history, base.seen.h))
  const c = news(entriesAfter(card.comments, base.seen.c)).filter((x) => !base.watcher || x.by !== base.watcher)
  const out: WatchChange[] = []
  // Any move into the column counts, also for a watch that waits only to see it there (#521): a starting mark carried
  // over from a wake can say the card was there when it has left and come back since (told in Review, then Doing).
  // The watcher's own moves aren't news (HI-2015: a builder's submission moving its card into Review woke its watch):
  // a column changed only by its moves since doesn't count, nor a move into the column of its own.
  const moves = h.filter((e) => intoColumn(e))
  const ownMoves = !!base.watcher && moves.length > 0 && moves.every((e) => e.by === base.watcher)
  const moved = !!cond.column && h.some((e) => intoColumn(e) === cond.column && e.by !== base.watcher)
  // HI-2143: a watch on any move counts a card that left and came back (HR2's on HI-2122, begun in Review: passed,
  // returned by the merge queue, submitted again, in Review once more), unless every move since was its own.
  const back = !cond.column && moves.length > 0 && !ownMoves
  if (kinds.has('column') && ((now.column !== base.mark.column && !ownMoves) || moved || back) && (!cond.column || now.column === cond.column)) out.push('column')
  if (kinds.has('comment') && c.length) out.push('comment')
  if (kinds.has('verdict') && h.some((e) => verdictOf(e) !== null)) out.push('verdict')
  if (kinds.has('agent') && now.agent !== base.mark.agent) out.push('agent')
  // Blocked since, and still (#726): a block lifted again meanwhile has nothing left to tell.
  if (cond.blocked && card.blocked && h.some((e) => historyBlocked(e))) out.push('blocked')
  out.push(...handoffsIn(h, cond, base.watcher))
  return out
}

// The English of lines from before #845 (intoColumn's, above, says why).
// agent-protocol: stored history lines from before #845, matched by their fixed English
const BLOCKED = /^Blocked: /
/** A reviewer's request to the card's builder (#912), and a decision the user recorded, changed or removed, in a card's history. */
const REQUEST = /^Asked the builder: /
/** A builder's reply to its reviewer (HI-2302): counted as a loop step, its wake's kind. */
const REPLY = /^Replied to the reviewer: /
const DECISION = /^(Recorded a decision|Changed a decision|Removed a decision)\b/
/** Whether a history entry is a decision recorded, changed or removed, and which (null: none). */
export function decisionLine(e: HistoryLine): 'recorded' | 'changed' | 'removed' | null {
  const s = lineMsg(e)
  if (s) return s.id === H.decision.id ? 'recorded' : s.id === H.decisionChanged.id ? 'changed' : s.id === H.decisionRemoved.id ? 'removed' : null
  const m = DECISION.exec(e.what)
  return m ? (m[1] === 'Recorded a decision' ? 'recorded' : m[1] === 'Changed a decision' ? 'changed' : 'removed') : null
}

/**
 * Whether a watch counts a reviewer's request and a decision (#1272, SPEC §16.8.2): one that counts a verdict, a move or
 * a comment (a builder waiting for its verdict asked only for verdict and column, #912's case), but not one that waits
 * only to see a card in a column (a reviewer waiting for its arrival in Review).
 */
export const hearsHandoffs = (cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto'>): boolean =>
  !(cond.column && !cond.moveInto) && (!cond.changes.length || cond.changes.some((c) => c === 'verdict' || c === 'column' || c === 'comment'))

/** The requests and decisions among history entries new to a watch (`watcher`: its board name; its own aren't news). */
function handoffsIn(h: readonly (HistoryLine & { by: string })[], cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto'>, watcher?: string): WatchChange[] {
  if (!hearsHandoffs(cond)) return []
  const others = watcher ? h.filter((e) => e.by !== watcher) : h
  return [...(others.some((e) => (lineMsg(e) ? isId(e, H.reviewerRequest) : REQUEST.test(e.what))) ? ['request' as const] : []), ...(others.some((e) => decisionLine(e) !== null) ? ['decision' as const] : []), ...(others.some((e) => (lineMsg(e) ? isId(e, H.loopStep, H.builderReply) : isLoopStepEntry(e.what) || REPLY.test(e.what))) ? ['step' as const] : [])]
}

/**
 * The requests and decisions a wait counts on a card after `since` (ISO), by its history: for a wait that compares marks
 * (a bounded wait, a watch saved before #224), which have no place for them.
 */
export const handoffsSince = (card: TaskCard | null, since: string, cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto'>, watcher?: string): WatchChange[] =>
  card ? handoffsIn(card.history.filter((e) => e.at > since), cond, watcher) : []

/** A card's return for review in its history ("Returned for review, round 2"): its round, else null. */
// agent-protocol: a stored history line from before #845, matched by its fixed English
const RETURNED = /^Returned for review, round (\d+)/
function returnedRound(e: HistoryLine): number | null {
  const s = lineMsg(e)
  if (s) return s.id === H.returned.id && Number.isFinite(Number(s.values?.round)) ? Number(s.values!.round) : null
  const m = RETURNED.exec(e.what)
  return m ? Number(m[1]) : null
}

/**
 * Whether a card in Review can be returned for review (#214): its latest review failed, and nothing has started another
 * round since (moved, reviewed again, reassigned, already returned). Its round then: one more than the reviews that
 * failed since it last passed one. Null: not returnable (moving it to Review is no change).
 */
export function returnRound(card: TaskCard): number | null {
  if (card.column !== 'review' || card.archived || card.review) return null
  const i = card.history.findLastIndex((h) => verdictOf(h) !== null)
  if (i < 0 || verdictOf(card.history[i]) !== 'failed') return null
  if (card.history.slice(i + 1).some((h) => newRound(h))) return null
  const passed = card.history.findLastIndex((h) => verdictOf(h) === 'passed')
  return card.history.slice(passed + 1).filter((h) => verdictOf(h) === 'failed').length + 1
}

/**
 * What changed on one card between two marks, of the kinds that count (a card gone or archived always counts). With a
 * column to move into, a column change counts when the card is there now and either its column differs from before or it
 * `moved` there meanwhile (left and came back).
 */
export function changesBetween(before: CardMark, after: CardMark, cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto'>, moved = false): WatchChange[] | 'gone' {
  if (after.column === 'gone' || (after.archived && !before.archived)) return 'gone'
  const kinds = new Set(cond.changes.length ? cond.changes : WATCH_CHANGES)
  const out: WatchChange[] = []
  const columnChanged = after.column !== before.column || (!!cond.moveInto && moved)
  if (kinds.has('column') && columnChanged && (!cond.column || after.column === cond.column)) out.push('column')
  if (kinds.has('comment') && after.comment > before.comment) out.push('comment')
  if (kinds.has('verdict') && after.verdict > before.verdict) out.push('verdict')
  if (kinds.has('agent') && after.agent !== before.agent) out.push('agent')
  return out
}

/**
 * Whether a card already meets a column condition (a wait for "in Review" on a card in Review is met at once), also
 * one for a move into it (#434: a builder's "→ Passed" on a card already passed doesn't wait for a move that has
 * happened), unless it asks for a fresh one.
 */
export const alreadyThere = (mark: CardMark, cond: Pick<WatchCondition, 'column' | 'moveInto' | 'fresh'>): boolean => !!cond.column && !cond.fresh && mark.column === cond.column

/** A card nothing more comes of (HI-2153): in Done, or archived. A watch set on one answers at once with its state. */
export const cardOver = (mark: CardMark): boolean => mark.column === 'done' || mark.archived

/**
 * A wait's `since`: the marks of its cards, as a short opaque text an agent passes back so a change between two calls
 * is never missed. `n:column:comment:verdict:agent:archived`, comma-separated; times in base 36.
 */
export function encodeSince(marks: Map<number, CardMark>, at = Date.now()): string {
  return `@${at.toString(36)};` + [...marks]
    .map(([n, m]) => [n, m.column, m.comment.toString(36), m.verdict.toString(36), encodeURIComponent(m.agent), m.archived ? 1 : 0].join(':'))
    .join(',')
}

/** Marks read back from `since`, and when it was taken (null: not one Hive wrote). */
export function decodeSince(since: string): { marks: Map<number, CardMark>; at: number } | null {
  if (typeof since !== 'string' || since.length > 4000) return null
  const head = /^@([0-9a-z]+);/.exec(since)
  if (!head) return null
  const at = parseInt(head[1], 36)
  if (!Number.isFinite(at)) return null
  const out = new Map<number, CardMark>()
  for (const part of since.slice(head[0].length).split(',').filter(Boolean)) {
    const [n, column, comment, verdict, agent, archived] = part.split(':')
    const num = Number(n)
    if (!Number.isInteger(num) || num <= 0 || ![...COLUMNS, 'gone'].includes(column)) return null
    const c = parseInt(comment, 36)
    const v = parseInt(verdict, 36)
    if (!Number.isFinite(c) || !Number.isFinite(v) || (archived !== '0' && archived !== '1')) return null
    let a: string
    try {
      a = decodeURIComponent(agent ?? '')
    } catch {
      return null
    }
    out.set(num, { column: column as CardMark['column'], comment: c, verdict: v, agent: a, archived: archived === '1' })
  }
  return { marks: out, at }
}

/** The changes a reply reports for one card: its number, column now, who changed it last, and its latest comment's author and first line. */
export interface CardChange {
  number: number
  column: TaskColumn | 'gone'
  changes: WatchChange[] | 'gone'
  by: string | null
  comment: { by: string; firstLine: string } | null
  /** Gone because it was archived (#351), not deleted or moved out of view: only the user brings it back. */
  archived?: boolean
  /** Why it is blocked, when becoming blocked is a change it tells (#726). */
  blocked?: string
  /** For a wake line only (wakeAbout): whose card it is and the review's verdict. */
  about?: WakeAbout
}

/**
 * What a wake line adds so it can't be misread: `owner`, the agent of the card when another agent has it (its name;
 * null on the watcher's own card or one without an agent), and the review's verdict with its reviewer, when it is what
 * changed or, on another agent's card in Passed or Done, when that review passed it there.
 */
export interface WakeAbout {
  owner: string | null
  verdict: { passed: boolean; by: string } | null
  /** The round a failed card came back into Review for, when it was returned without leaving Review (#214). */
  returned?: number
  /**
   * HI-2087: the merge queue returned the card to its builder (it moved back for that): the return's own words (its key,
   * what came back, what to do next), which the line leads with in place of where it is and its latest comment (a
   * reviewer's pass, saying the opposite of what happened).
   */
  queueReturn?: string
  /**
   * HI-2143: the card is back in Review, submitted again after the merge queue returned it (queueReturn.ts's
   * resubmittedIn): the line leads with that, for its reviewer, in place of where it is and its latest comment (its own
   * pass).
   */
  resubmitted?: string
}

/**
 * History that starts another round of work or review (back to work, in Review again, a review started, another agent),
 * after which an earlier verdict no longer speaks for the card.
 */
// agent-protocol: stored history lines from before #845, matched by their fixed English
const NEW_ROUND = /^(Moved to (the (top|bottom) of )?(On Hold|Todo|Doing|Review)\b|Created in |Given to |Taken from |Moved to the workspace|Started reviewing|Returned for review)/
const ROUND_COLUMNS: readonly (TaskColumn | null)[] = ['hold', 'todo', 'doing', 'review']
function newRound(e: HistoryLine): boolean {
  if (!lineMsg(e)) return NEW_ROUND.test(e.what)
  return ROUND_COLUMNS.includes(movedTo(e) ?? null) || hands(e) || isId(e, H.created, H.toWorkspace, H.reviewStarted, H.returned)
}

/** A wake's context for the agent `watcher` (its id), from the card as it is now. */
export function wakeAbout(card: TaskCard | null, changes: WatchChange[] | 'gone', watcher: string): WakeAbout {
  if (!card || changes === 'gone') return { owner: null, verdict: null }
  const owner = card.agent && card.agent !== watcher ? (card.agentName ?? card.agent) : null
  // The latest verdict, only while nothing has started another round since (back to Doing, reviewed again, reassigned):
  // one from an earlier build never speaks for work done after it. History is in the order it happened.
  const i = card.history.findLastIndex((h) => verdictOf(h) !== null)
  // A failed card's move back to Doing in the verdict's own change is its verdict's doing (HI-1946), not another round.
  const itsMove = (h: TaskCard['history'][number]): boolean => h.at === card.history[i].at && h.by === card.history[i].by && movedTo(h) === 'doing'
  const current = i >= 0 && !card.history.slice(i + 1).some((h) => newRound(h) && !itsMove(h)) ? card.history[i] : null
  const passed = current ? verdictOf(current) === 'passed' : false
  // Passed or Done on another agent's card names its review only when that review passed it; moved there by hand, none.
  const wanted = changes.includes('verdict') || (!!owner && (card.column === 'passed' || card.column === 'done') && passed)
  // Into Review by a return for review (#214): its latest arrival there says so.
  const arrival = changes.includes('column') && card.column === 'review' ? card.history.findLast((h) => intoColumn(h) === 'review') : undefined
  const returned = arrival ? returnedRound(arrival) : null
  return { owner, verdict: wanted && current ? { passed, by: current.by } : null, ...(returned !== null ? { returned } : {}) }
}

/**
 * The wake lines' words (dialects, HI-2437): each said in the dialect of the session the wake is for (the caller's scope:
 * inDialectOf). `[CW] ` (NOTICE_PREFIX) is protocol, prepended in code. A line is cut to fit WAKE_MAX_BYTES by giving
 * way in its parts (a comment's first line, then details), so a line is said from its parts, each a message.
 */
const W = {
  lanesRunning: agentMsg({ id: 'wake.card.lanesRunning', text: 'Lanes are still running (cw_lane list): before you end your turn, watch them again in one lane watch, with any card outside them as cards (cw_wait_for_tasks with lanes ["all"], cards, wake; run-lanes).', note: "#402: what the Assistant's card wake ends with while lanes run: its watch has ended, and the lanes still need one. Kept whole: the rest of the line is cut to make room." }),
  cardEnded: agentMsg({ id: 'wake.card.ended', text: '{more, plural, =0 {} one { (and {count} more watched card changed)} other { (and {count} more watched cards changed)}}. Your card watch has ended: carry on (cw_read_task with latestComment for the comment in full).', note: "The end of a card watch's wake line, after the card and where it is now. more: other watched cards that changed too." }),
  withComment: agentMsg({ id: 'wake.card.withComment', text: '{head}; latest comment by {by}: "{comment}"{tail}', note: "A wake line with the card's latest comment: head is the card and where it is now, by the comment's author, comment its first line (cut with … to fit), tail what to do." }),
  archived: agentMsg({ id: 'wake.card.archived', text: 'was archived (off the board: only the user brings it back)', note: '#351: after the card\'s key, in a wake: it was archived.' }),
  gone: agentMsg({ id: 'wake.card.gone', text: 'is gone from your board (archived, deleted or moved to another project)', note: "After the card's key, in a wake: the card is out of the agent's view." }),
  owner: agentMsg({ id: 'wake.card.owner', text: "({owner}'s card)", note: "After the card's key, in a wake, when another agent has the card: its agent's name." }),
  verdict: agentMsg({ id: 'wake.card.verdict', text: ': {by} {passed, select, yes {passed} other {failed}} it', note: 'After where a card is, in a wake: its review\'s verdict and reviewer. passed: yes or no.' }),
  notMerged: agentMsg({ id: 'wake.card.notMerged', text: "(Passed isn't merged)", note: "#170: another agent's card in Passed: the review passed, the work isn't merged (Done is)." }),
  blocked: agentMsg({ id: 'wake.card.blocked', text: 'and blocked', note: '#726: after where a card is, in a wake: it became blocked (its reason left out to fit).' }),
  blockedWhy: agentMsg({ id: 'wake.card.blockedWhy', text: 'and blocked: "{why}"', note: '#726: after where a card is, in a wake: it became blocked, and why (cut with … to fit).' }),
  returned: agentMsg({ id: 'wake.card.returned', text: '{owner} was returned for review (round {round}){verdict}{blocked}{said}', note: "#214: after the card's key, in a wake: a failed card returned for review without leaving Review. owner, verdict, blocked and said are the line's other parts, or empty." }),
  inColumn: agentMsg({ id: 'wake.card.inColumn', text: '{owner} is in {column}{verdict}{merged}{blocked}{said}', note: "After the card's key, in a wake: where it is now (a column's name). owner, verdict, merged, blocked and said are the line's other parts, or empty." }),
  handRequest: agentMsg({ id: 'wake.card.request', text: 'its reviewer asks you something', note: "#912: in a wake's brackets: the card's reviewer asked its builder for something." }),
  handDecision: agentMsg({ id: 'wake.card.decision', text: 'a new decision from the user: read its decisions', note: '#1272: in a wake\'s brackets: the user recorded or changed a decision on the card.' }),
  handStep: agentMsg({ id: 'wake.card.step', text: 'a card loop step: read its latest comment', note: "#1382: in a wake's brackets: a card loop's step (a design, a follow-up, an answer)." }),
  resubmitted: agentMsg({ id: 'wake.card.resubmitted', text: '{card} is back in Review after the merge queue returned it', note: 'HI-2143: for its reviewer, a card submitted again after the merge queue returned it (its details left out to fit).' }),
  partComment: agentMsg({ id: 'wake.card.partComment', text: '{head} (latest comment by {by}: "{comment}")', note: "One card's part in a wake telling several: head the card and where it is, by the comment's author, comment its first line (cut with … to fit)." }),
  manyEnded: agentMsg({ id: 'wake.many.ended', text: '. Your card watch has ended: carry on (cw_read_task with latestComment on each card for its comment in full).', note: '#224: the end of a wake line telling several watched cards.' }),
  manyShort: agentMsg({ id: 'wake.many.short', text: '. Your card watch has ended. Details were left out to fit: read each card (cw_read_task) before you carry on.', note: '#226: the end of a wake line telling too many cards to say each in full.' }),
  numbersChanged: agentMsg({ id: 'wake.many.numbers', text: '{cards} changed{short}', note: '#226: a wake line naming its cards by key alone ("HI-1, HI-2"); short is its end (wake.many.short).' }),
  numbersMore: agentMsg({ id: 'wake.many.numbersMore', text: '{cards} and {more, plural, one {{count} more watched card} other {{count} more watched cards}} changed{short}', note: '#226: a wake line naming as many cards as fit, the rest counted; short is its end (wake.many.short).' }),
  countChanged: agentMsg({ id: 'wake.many.count', text: '{n} watched cards changed{short}', note: '#226: a wake line counting its cards, when not even their keys fit; short is its end.' }),
  briefGone: agentMsg({ id: 'wake.brief.gone', text: '{card} {archived, select, yes {archived} other {gone}}', note: '#226: a card in a few words, in a wake too long to tell each in full: archived, or gone from view.' }),
  briefReturned: agentMsg({ id: 'wake.brief.returned', text: '{card} returned for review (round {round})', note: '#226: a card in a few words: returned for review.' }),
  briefIn: agentMsg({ id: 'wake.brief.in', text: '{card} in {column}', note: '#226: a card in a few words: its column. What changed follows, each after ", " (wake.brief.passed…).' }),
  briefPassed: agentMsg({ id: 'wake.brief.passed', text: 'passed', note: '#226: after a card in a few words: its review passed.' }),
  briefFailed: agentMsg({ id: 'wake.brief.failed', text: 'failed', note: '#226: after a card in a few words: its review failed.' }),
  briefBlocked: agentMsg({ id: 'wake.brief.blocked', text: 'blocked', note: '#226, #726: after a card in a few words: it became blocked.' }),
  briefRequest: agentMsg({ id: 'wake.brief.request', text: 'a request', note: "#226, #912: after a card in a few words: its reviewer's request." }),
  briefDecision: agentMsg({ id: 'wake.brief.decision', text: 'a decision', note: '#226, #1272: after a card in a few words: a new decision.' }),
  briefStep: agentMsg({ id: 'wake.brief.step', text: 'a loop step', note: "#226, #1382: after a card in a few words: a card loop's step." }),
  replyNote: agentMsg({ id: 'wake.reply.note', text: '{user} replied to {agent} on {cards}{quoted, select, yes {: "{text}"} other {}}', note: "#418: in the Assistant's card wake: the user's reply to an agent of watched cards. user: the user's name; text: the reply's first line, when quoted is yes." }),
  repliesEnded: agentMsg({ id: 'wake.reply.ended', text: '. Your card watch has ended: carry on (cw_read_task for the card, cw_agent_activity for the agent).', note: "#418: the end of the Assistant's card wake telling only the user's replies." }),
  repliesShort: agentMsg({ id: 'wake.reply.short', text: '. Your card watch has ended. Details were left out to fit: read each card (cw_read_task) and agent (cw_agent_activity) before you carry on.', note: "#418: the end of the Assistant's card wake when its details don't fit." }),
  leftWatch: agentMsg({ id: 'wake.reply.leftWatch', text: '{cards} left your watch', note: "#420: in the Assistant's short card wake: cards that left its watch." }),
  repliedTo: agentMsg({ id: 'wake.reply.repliedTo', text: '{user} replied to {who}', note: "#418: in the Assistant's short card wake: the user replied to these agents." }),
  changed: agentMsg({ id: 'wake.reply.changed', text: '{cards} changed', note: "In the Assistant's short card wake: the watched cards that changed, by key." }),
  repliedToAgents: agentMsg({ id: 'wake.reply.repliedToAgents', text: '{user} replied to agents of your watched cards{short}', note: "#418: the Assistant's card wake when nothing more fits; short is its end (wake.reply.short)." }),
  relBlocked: agentMsg({ id: 'wake.released.blocked', text: '{card} is blocked{quoted, select, yes {: "{why}"} other {}}', note: '#420: a card that left a watch saved before #481: blocked, and why when quoted is yes.' }),
  relReviewedBy: agentMsg({ id: 'wake.released.reviewedBy', text: '{card} is reviewed by {reviewer}', note: '#420: a card that left a watch: another agent reviews it.' }),
  relReviewTaken: agentMsg({ id: 'wake.released.reviewTaken', text: "{card}'s review was taken from you", note: "#420: a card that left a reviewer's watch: its review was stopped or cleared by someone else." }),
  relDone: agentMsg({ id: 'wake.released.done', text: '{card} is in Done', note: '#1475: a card that left a watch: it reached Done (merged).' }),
  relLaneEnded: agentMsg({ id: 'wake.released.laneEnded', text: "{card}'s lane {abandoned, select, yes {was abandoned} other {ended}}", note: "#1475: a card that left a watch: the watcher's lane on it ended, or was abandoned." }),
  relReassignedTo: agentMsg({ id: 'wake.released.reassignedTo', text: '{card} was reassigned to {agent}', note: '#420: a card that left a watch: given to another agent.' }),
  relReassigned: agentMsg({ id: 'wake.released.reassigned', text: '{card} was reassigned (it has no agent now)', note: '#420: a card that left a watch: taken from its agent, given to none.' }),
  relEnded: agentMsg({ id: 'wake.released.ended', text: '{head} (your watch on it ended)', note: '#420: after what happened to a card that left a watch.' }),
  relOverTail: agentMsg({ id: 'wake.released.overTail', text: ". Your card watch has ended: there is nothing more to wait for on {n, plural, one {it} other {them}}. Don't watch {n, plural, one {it} other {them}} again; end your turn unless you have other work.", note: '#1475: the end of a wake whose every card left for good (Done, its lane ended): the agent ends its turn, so the next prompt finds it free.' }),
  relDropTail: agentMsg({ id: 'wake.released.dropTail', text: '. Your card watch has ended: drop {n, plural, one {it} other {them}} from your list and carry on with your next card.', note: '#420: the end of a wake whose every card left the watch.' }),
  relLeft: agentMsg({ id: 'wake.released.left', text: '{cards} left your watch ({over, select, yes {done, or its lane ended} other {reassigned, or reviewed by another}}){tail}', note: '#420: a wake whose cards left the watch, when their details don\'t fit; tail is its end.' }),
  whereWaits: agentMsg({ id: 'wake.where.waits', text: '{card} waits on {on}', note: "HI-2381: a timed-out watch's card waiting on other agents' cards in progress (on: their keys)." }),
  whereWorking: agentMsg({ id: 'wake.where.working', text: '{card} is in Doing with {agent}', note: "HI-2381: a timed-out watch's card that another agent is building." }),
  whereReviewing: agentMsg({ id: 'wake.where.reviewing', text: '{card} is in Review, being reviewed by {agent}', note: "HI-2295: a timed-out watch's card in Review, being reviewed." }),
  whereAssigned: agentMsg({ id: 'wake.where.assigned', text: "{card} is in Review: the reviewer pool gave it to {agent}, who hasn't started yet", note: "HI-2295: a timed-out watch's card the reviewer pool gave to a reviewer that hasn't started." }),
  wherePool: agentMsg({ id: 'wake.where.pool', text: '{card} is in Review, waiting for the reviewer pool to give it to a reviewer', note: "HI-2295: a timed-out watch's card waiting for the reviewer pool." }),
  whereReview: agentMsg({ id: 'wake.where.review', text: '{card} is in Review, waiting for its reviewer', note: "HI-2295: a timed-out watch's card waiting for its reviewer." }),
  hours: agentMsg({ id: 'wake.limit.hours', text: '{h} h', note: "A watch's limit in hours (1.5), in its timed-out wake." }),
  minutes: agentMsg({ id: 'wake.limit.minutes', text: '{m} min', note: "A watch's limit in minutes, in its timed-out wake." }),
  limitEnded: agentMsg({ id: 'wake.limit.ended', text: 'No change on {cards} in {dur}: your card watch has ended.', note: "The start of a watch's wake when its limit passes with no change." }),
  stepDrop: agentMsg({ id: 'wake.limit.drop', text: 'drop {n, plural, one {the first} other {those}} from your list', note: '#420: a step in a timed-out watch\'s wake, for the cards that left it (told first). Its first letter is capitalised in code when it comes first.' }),
  stepWatchReview: agentMsg({ id: 'wake.limit.watchReview', text: "watch {cards} again for {n, plural, one {its} other {their}} verdict (in a card loop, Combwork wakes you with it); don't tell the user about {n, plural, one {it} other {them}}", note: 'HI-2295: a step in a timed-out watch\'s wake: a review on its way is nothing to tell the user. Its first letter is capitalised in code when it comes first.' }),
  stepWatchWaiting: agentMsg({ id: 'wake.limit.watchWaiting', text: "watch {cards} again: another agent's work is going on; don't tell the user about {n, plural, one {it} other {them}}", note: "HI-2381: a step in a timed-out watch's wake: cards waiting on other agents' work. Its first letter is capitalised in code when it comes first." }),
  stepAsk: agentMsg({ id: 'wake.limit.ask', text: '{rest, select, yes {for the rest, } other {}}tell the user (cw_notify) and ask what to do', note: "A step in a timed-out watch's wake: the cards with no news. rest: yes after other steps. Its first letter is capitalised in code when it comes first." }),
  shortInReview: agentMsg({ id: 'wake.limit.inReview', text: '{cards} {n, plural, one {is in Review} other {are in Review}}', note: "HI-2295: a timed-out watch's cards in Review, when their details don't fit." }),
  shortWaiting: agentMsg({ id: 'wake.limit.waiting', text: '{cards} {n, plural, one {waits on work in progress} other {wait on work in progress}}', note: "HI-2381: a timed-out watch's cards waiting on others' work, when their details don't fit." }),
  leftWatchReassigned: agentMsg({ id: 'wake.limit.left', text: '{cards} left your watch (reassigned, or reviewed by another).', note: "#420: a timed-out watch's cards that left it, when their details don't fit." }),
  label: agentMsg({ id: 'wake.watch.label', text: 'Waiting for {cards}{hasColumn, select, yes { → {column}} other {}}', note: "What a watching agent shows (the Agent API's watch, its header): its cards, and the column it waits for." }),
  badCards: agentMsg({ id: 'wake.condition.cards', text: 'cards must be card numbers (at least one, no repeats)', note: "A card watch's or wait's arguments refused." }),
  tooManyCards: agentMsg({ id: 'wake.condition.tooMany', text: 'at most {max} cards', note: "A card watch's or wait's arguments refused: too many cards." }),
  badColumn: agentMsg({ id: 'wake.condition.column', text: 'column must be {choices}', note: "A card watch's or wait's arguments refused. choices: the columns' ids." }),
  badChanges: agentMsg({ id: 'wake.condition.changes', text: 'changes must be any of {choices}', note: "A card watch's or wait's arguments refused. choices: the changes' names." }),
  columnNeedsChange: agentMsg({ id: 'wake.condition.columnChange', text: 'with column, changes must include "column" (or leave changes out to wait only for the card to be in that column)', note: "#434: a card watch's or wait's arguments refused." }),
  badFresh: agentMsg({ id: 'wake.condition.fresh', text: 'fresh must be true or false', note: "A card watch's or wait's arguments refused." }),
  freshNeedsColumn: agentMsg({ id: 'wake.condition.freshColumn', text: 'fresh needs a column: it waits for the next move into it', note: "A card watch's or wait's arguments refused." }),
  loopReview: agentMsg({ id: 'wake.loop.review', text: 'You review this card in its loop: carry on with it', note: "#405: what a loop wake tells a card's reviewer as it arrives in Review." }),
  loopStep: agentMsg({ id: 'wake.loop.step', text: "You review this card in its loop: check it and answer with cw_loop_step (ok, or gaps saying what's missing, and its id)", note: "#1382: what a loop wake tells a card's reviewer about a design or follow-up to check." }),
  loopStepNotice: agentMsg({ id: 'wake.loop.stepNotice', text: 'Nothing to answer: carry on with your loop', note: "#1382: a loop wake telling a reviewer its builder went ahead with a design unchecked." }),
  loopReply: agentMsg({ id: 'wake.loop.reply', text: 'You review this card in its loop: carry on with your review', note: "HI-2302: a loop wake telling a reviewer its builder's reply." }),
  loopAnswer: agentMsg({ id: 'wake.loop.answer', text: 'The user answered: carry on from where you asked', note: "#1269: a wake with the user's answer to an agent's question." }),
  loopOwn: agentMsg({ id: 'wake.loop.own', text: 'This is your card in its loop: carry on', note: "#405: what a loop wake tells a card's builder (a verdict, a request, a note)." }),
  loopTail: agentMsg({ id: 'wake.loop.tail', text: '. {who} (cw_read_task with latestComment for the comment in full).', note: "#405: the end of a loop wake: who is what it tells the agent (wake.loop.review…, or its lane's next card)." }),
  loopSaid: agentMsg({ id: 'wake.loop.said', text: '. {whose, select, reviewerAsks {The reviewer asks} builderReplies {The builder replies} builder {The builder} reviewer {The reviewer} other {Combwork}}: "{text}"', note: "#912, #1382: in a loop wake, what a request, step or Hive's note says (cut with … to fit), and whose it is." }),
  lanePaused: agentMsg({ id: 'wake.lane.paused', text: 'Your lane is paused: cw_lane next says why', note: "HI-1990: a builder's Done wake when its lane is paused." }),
  laneLast: agentMsg({ id: 'wake.lane.last', text: "That was your lane's last card: the lane ends by itself, so end your turn unless you have other work", note: "HI-1990: a builder's Done wake on its lane's last card." }),
  laneNextHiveStarts: agentMsg({ id: 'wake.lane.nextHiveStarts', text: "Your lane's next card is {card} (\"{title}\"): Combwork starts it for you once your turn ends, so end your turn now", note: "HI-1990: a builder's Done wake, its lane's rules on: Hive starts the next card." }),
  laneNextStart: agentMsg({ id: 'wake.lane.nextStart', text: "Your lane's next card is {card} (\"{title}\"): start it now (cw_lane next, then cw_start_card); this card's own prompt doesn't narrow the lane", note: "HI-1990: a builder's Done wake, its lane's rules off: it starts the next card." }),
  laneNextStarted: agentMsg({ id: 'wake.lane.nextStarted', text: "Your lane's next card, {card} (\"{title}\"), is under way: carry on with it", note: "HI-1990: a builder's Done wake when its next card is already under way." }),
  laneNextWaits: agentMsg({ id: 'wake.lane.nextWaits', text: "Your lane's next card is {card} (\"{title}\"): cw_lane next says when it can start", note: "HI-1990: a builder's Done wake when its next card can't start yet." }),
  stepDesign: agentMsg({ id: 'wake.step.design', text: 'design{id} posted for your check (answer with its id)', note: "#1382: a loop wake's step: a design to check. id: the design's id after a space, or empty." }),
  stepFollowUp: agentMsg({ id: 'wake.step.followUp', text: 'follow-up{id} ready for your check (answer with its id)', note: "#1467: a loop wake's step: a follow-up to check. id: its id after a space, or empty." }),
  stepProceed: agentMsg({ id: 'wake.step.proceed', text: 'no check of design{id} came in time: the builder goes ahead with it as posted', note: "#1382: a loop wake's step: the builder went ahead unchecked." }),
  stepOk: agentMsg({ id: 'wake.step.ok', text: '{of, select, followUp {follow-up} other {design}}{id} is OK', note: "#1382: a loop wake's step: the reviewer's answer. of: what it checked." }),
  stepGaps: agentMsg({ id: 'wake.step.gaps', text: '{of, select, followUp {follow-up} other {design}}{id} has gaps', note: "#1382: a loop wake's step: the reviewer's answer. of: what it checked." })
}

/** The most characters a name takes in a wake line (an agent's, a reviewer's, a comment's author): one line, cut with "…". */
const NAME_MAX = 40
const shortName = (name: string): string => {
  const chars = [...name.replace(/\s+/g, ' ').trim()]
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join('')}…` : chars.join('')
}

/** A wake line's most bytes as saved (JSON-quoted). */
export const WAKE_MAX_BYTES = 1000
const jsonBytes = (s: string): number => new TextEncoder().encode(JSON.stringify(s)).length

/**
 * What the Assistant's card wake ends with while lanes are running (#402): its watch has ended, and the lanes still need
 * one. Kept whole: the rest of the line is cut to make room.
 */
export const lanesRunningTail = (): string => ` ${say(W.lanesRunning)}`
export function withLanesTail(line: string, max = WAKE_MAX_BYTES): string {
  const tail = lanesRunningTail()
  if (line.endsWith(tail)) return line
  let s = line
  if (jsonBytes(s + tail) > max) {
    while (s && jsonBytes(`${s}…${tail}`) > max) s = s.slice(0, -1)
    s = `${s}…`
  }
  return s + tail
}

const firstLine = (text: string, max = 160): string => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A change, for a reply or a wake line. */
export function cardChange(n: number, card: TaskCard | null, changes: WatchChange[] | 'gone'): CardChange {
  const last = card?.comments.at(-1)
  const by = card ? ([...card.history].sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.by ?? null) : null
  return { number: n, column: card ? card.column : 'gone', changes, by, comment: last ? { by: last.by, firstLine: firstLine(storedForAgents(last.text, last.appText)) } : null, ...(changes === 'gone' && card?.archived ? { archived: true } : {}), ...(changes !== 'gone' && changes.includes('blocked') && card?.blocked ? { blocked: card.blocked } : {}) }
}

const columnWord = (c: TaskColumn | 'gone'): string => (c === 'gone' ? 'gone' : columnLabel(c))

/**
 * The one line Hive types to wake a watching agent: the card (and whose, when it isn't the watcher's), where it is now
 * (with the reviewer's verdict when that changed; Passed on another agent's card says it isn't merged yet), and its latest
 * comment's author and first line, then what to do. Kept to one short line (the CLI sends a new line at once).
 */
export function wakeLine(change: CardChange, more = 0): string {
  return lineOf(change, say(W.cardEnded, { more, count: String(more) }))
}

/**
 * The line of Hive's loop wake (#405), typed with no card watch of the agent's: a card arrived in Review for its
 * reviewer (`review`), or its review's verdict for its builder (`verdict`). Worded as a card watch's line, so the
 * card-loop skill reads it the same way.
 */
/** How much of a reviewer's request a wake line quotes, and of Hive's own note (a returned card's needs its next step). */
const REQUEST_MAX = 200
const NOTE_MAX = 600
/** And of the user's answer (#1626): its reply whole, up to this; the card's comment has it in full. */
export const ANSWER_MAX = 4000

/**
 * `next`: for a builder's card Done in its lane (HI-1990), what comes next in the lane, in its words (laneNextWords),
 * told in place of carrying on with the card.
 */
/**
 * HI-2087: whether a loop wake is Hive's note that the merge queue returned the card (queueState's returnedText: a note
 * is only ever Hive's own words, never an agent's), so its line leads with it and its delivery is marked so.
 */
export const isReturnNote = (kind: LoopWakeKind, text?: string): boolean => kind === 'note' && !!text && text.replace(/\s+/g, ' ').includes(` ${CAME_BACK}: `)

export function loopWakeLine(change: CardChange, kind: LoopWakeKind, text?: string, next?: string): string {
  const who =
    kind === 'done' && next ? next : say(kind === 'review' ? W.loopReview : kind === 'step' ? W.loopStep : kind === 'stepNotice' ? W.loopStepNotice : kind === 'reply' ? W.loopReply : kind === 'answer' ? W.loopAnswer : W.loopOwn)
  // A reviewer's request (#912), a card loop's step (#1382) or Hive's own note (stale, an answer, what came back from the
  // merge queue and what to do next: #1354, up to NOTE_MAX): what it says, short, before what to do.
  const said = text ? [...text.replace(/\s+/g, ' ').trim()] : []
  const max = kind === 'request' || kind === 'step' || kind === 'stepAnswer' || kind === 'stepNotice' || kind === 'reply' ? REQUEST_MAX : kind === 'answer' ? ANSWER_MAX : NOTE_MAX
  const whose = kind === 'request' ? 'reviewerAsks' : kind === 'reply' ? 'builderReplies' : kind === 'step' || kind === 'stepNotice' ? 'builder' : kind === 'stepAnswer' ? 'reviewer' : 'hive'
  const tail = say(W.loopTail, { who })
  // HI-2087: Hive's note that the merge queue returned the card leads the line, as a watch's does: its column and the
  // review's pass first made HB2 take HI-2046 for merged.
  if (isReturnNote(kind, text)) return lineOf({ ...change, about: { owner: null, verdict: null, ...change.about, queueReturn: said.slice(0, max).join('') } }, tail)
  const what = !said.length ? '' : say(W.loopSaid, { whose, text: said.length > max ? `${said.slice(0, max - 1).join('')}…` : said.join('') })
  return lineOf(change, `${what}${tail}`)
}

/**
 * What comes next in a builder's lane, as its Done wake says it (HI-1990; English, agent-facing): its next card, which
 * Hive starts for it once its turn ends (`hiveStarts`, rules on), for it to start (`start`, rules off), already under way
 * (`started`) or not yet startable (`waits`); the lane paused; or none left.
 */
export function laneNextWords(next: { card: number; title: string; is: 'hiveStarts' | 'start' | 'started' | 'waits' } | 'paused' | 'last'): string {
  if (next === 'paused') return say(W.lanePaused)
  if (next === 'last') return say(W.laneLast)
  const title = [...next.title.trim()]
  const values = { card: cardRef(next.card), title: title.length > 60 ? `${title.slice(0, 59).join('')}…` : title.join('') }
  switch (next.is) {
    case 'hiveStarts':
      return say(W.laneNextHiveStarts, values)
    case 'start':
      return say(W.laneNextStart, values)
    case 'started':
      return say(W.laneNextStarted, values)
    case 'waits':
      return say(W.laneNextWaits, values)
  }
}

/**
 * What a loop wake is about (#405, #1266): a card arrived in Review (its reviewer's), a verdict, the card moved into Passed
 * or Done, a reviewer's request mid-review (#912), a note of Hive's (a pass gone stale), or the user's answer to a request
 * (#1269: the agent waiting on it, whether or not the card is in a loop), a card loop's step (#1382: `step`, a design to
 * check, and `stepNotice`, its builder going ahead unchecked, are its reviewer's; `stepAnswer`, the reviewer's answer, its
 * builder's; `reply`, the builder's reply to its reviewer, HI-2302, its reviewer's): the rest are its builder's.
 */
export const LOOP_WAKE_KINDS = ['review', 'verdict', 'approved', 'done', 'request', 'note', 'answer', 'step', 'stepAnswer', 'stepNotice', 'reply'] as const

/**
 * A card loop's step (#1382, #1467) as its wake quotes it: what the step is, with the design or follow-up it is about
 * (its id, which an answer names; `of`: which an answer checked), then its text (English, agent-facing).
 */
export function loopStepWords(step: string, text: string, design?: string, of?: string): string {
  const values = { id: design ? ` ${design}` : '', of: of === 'followUp' ? 'followUp' : 'design' }
  const what = step === 'design' ? W.stepDesign : step === 'followUp' ? W.stepFollowUp : step === 'proceed' ? W.stepProceed : step === 'ok' ? W.stepOk : step === 'gaps' ? W.stepGaps : null
  return `${what ? say(what, values) : step}: ${text}`
}
export type LoopWakeKind = (typeof LOOP_WAKE_KINDS)[number]

function lineOf(change: CardChange, tail: string): string {
  // HI-2087: a card the merge queue returned leads with the return and its reason (its words name the card).
  if (change.about?.queueReturn) return returnLine(change.about.queueReturn, (t) => `${NOTICE_PREFIX}${t}${tail}`)
  // HI-2143: and a card submitted again after that return, for its reviewer.
  if (change.about?.resubmitted && change.changes !== 'gone') return returnLine(change.about.resubmitted, (t) => `${NOTICE_PREFIX}${t}${tail}`)
  const head = `${cardRef(change.number)}${whereNow(change)}`
  if (!change.comment) return NOTICE_PREFIX + head + tail
  // The card, its state and what to do always fit (names are short); the comment's first line gives way, cut with "…".
  const by = shortName(change.comment.by)
  let text = [...change.comment.firstLine]
  const line = (cut: boolean): string => NOTICE_PREFIX + say(W.withComment, { head, by, comment: `${text.join('')}${cut ? '…' : ''}`, tail })
  if (jsonBytes(line(false)) <= WAKE_MAX_BYTES) return line(false)
  while (text.length && jsonBytes(line(true)) > WAKE_MAX_BYTES) text = text.slice(0, -1)
  return line(true)
}

/**
 * HI-2087: a return's words in a line `wrap` makes, within WAKE_MAX_BYTES (JSON, UTF-8: an output's last lines in
 * another script take three bytes a character), one line. Its first sentence (the card, that it came back, why) and its
 * last (what to do next) are kept; what is between (the log's path, the output's last lines) gives way first, cut with
 * "…"; then the first sentence's end (its files); then, only past that, the rest.
 */
function returnLine(back: string, wrap: (t: string) => string): string {
  const whole = back.replace(/\s+/g, ' ').trim().replace(/\.$/, '')
  if (jsonBytes(wrap(whole)) <= WAKE_MAX_BYTES) return wrap(whole)
  const first = whole.indexOf('. ', whole.indexOf(CAME_BACK))
  const last = whole.lastIndexOf('. ')
  // Cut from its end until it fits: the most of `xs` kept (one search, the line measured each time).
  const fitting = (xs: string[], make: (kept: string[]) => string): string | null => {
    let lo = 0
    let hi = xs.length
    if (jsonBytes(make([])) > WAKE_MAX_BYTES) return null
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (jsonBytes(make(xs.slice(0, mid))) <= WAKE_MAX_BYTES) lo = mid
      else hi = mid - 1
    }
    return make(xs.slice(0, lo))
  }
  const cut = (kept: string[], all: string[]): string => (kept.length < all.length ? `${kept.join('').trimEnd()}…` : kept.join(''))
  if (first >= 0 && last > first) {
    const head = [...whole.slice(0, first)]
    const mid = [...whole.slice(first + 2, last)]
    const next = whole.slice(last + 2)
    const withMid = fitting(mid, (m) => wrap(`${head.join('')}.${m.length ? ` ${cut(m, mid)}` : ''} ${next}`))
    if (withMid !== null) return withMid
    const withHead = fitting(head, (h) => wrap(`${cut(h, head)}. ${next}`))
    if (withHead !== null) return withHead
  }
  const all = [...whole]
  return fitting(all, (k) => wrap(cut(k, all))) ?? wrap('')
}

/**
 * A card's part of a wake line after its number: whose it is, where it is now and the verdict that put it there, and why
 * it is blocked when that is what changed (#726), cut to `blockedMax` characters (0: only that it is).
 */
function whereNow(change: CardChange, blockedMax = 120): string {
  const about = change.about
  // Gone also covers a card moved out of what the agent may see (another project): nothing about it is said then.
  if (change.changes === 'gone') return ` ${say(change.archived ? W.archived : W.gone)}`
  const owner = about?.owner ? ` ${say(W.owner, { owner: shortName(about.owner) })}` : ''
  const verdict = about?.verdict ? say(W.verdict, { by: shortName(about.verdict.by), passed: about.verdict.passed ? 'yes' : 'no' }) : ''
  // Passed means the review passed, not that the work is merged: Done is merged (#170).
  const merged = about?.owner && change.column === 'passed' ? ` ${say(W.notMerged)}` : ''
  const why = change.blocked ? [...change.blocked.replace(/\s+/g, ' ').trim()] : []
  const blocked = change.blocked ? ` ${blockedMax > 0 ? say(W.blockedWhy, { why: why.length > blockedMax ? `${why.slice(0, blockedMax - 1).join('')}…` : why.join('') }) : say(W.blocked)}` : ''
  const said = handoffWords(change.changes)
  return about?.returned ? say(W.returned, { owner, round: String(about.returned), verdict, blocked, said }) : say(W.inColumn, { owner, column: columnWord(change.column), verdict, merged, blocked, said })
}

/** What a wake adds for a reviewer's request and a new decision (#1272): " (its reviewer asks you something; a new decision)". */
function handoffWords(changes: WatchChange[]): string {
  const said = [changes.includes('request') ? say(W.handRequest) : '', changes.includes('decision') ? say(W.handDecision) : '', changes.includes('step') ? say(W.handStep) : ''].filter(Boolean)
  return said.length ? ` (${said.join('; ')})` : ''
}

/**
 * The line that wakes an agent for every watched card that changed (#224): one card as wakeLine says it; several, each
 * with where it is now and its verdict, so a second change that landed with the first isn't lost ("#217 is in Review:
 * Codex passed it; #119 is in Review: Codex failed it"). Comments' first lines give way first; then every card is still
 * named, in a few words (#226: "#217 in Review, passed; #119 in Review, failed"), or by number alone, with the agent told
 * that details were left out. Never cut mid-way, one line, within WAKE_MAX_BYTES.
 */
/**
 * A card's part of a line telling several (#224), its latest comment's first line (and why it is blocked, #726) cut to
 * `max` characters (0: left out). A lane watch's line tells its cards with it.
 */
export function cardPart(c: CardChange, max: number): string {
  // HI-2087: a card the merge queue returned: the return, its reason as far as `max` allows (none: that it came back).
  const back = c.about?.queueReturn
  if (back && c.changes !== 'gone') {
    const t = [...back.replace(/\.$/, '')]
    // agent-protocol: CAME_BACK is the return note's own words (shared/workflow/queue.ts), which isReturnNote finds it by
    return max > 0 ? (t.length > max * 2 ? `${t.slice(0, max * 2 - 1).join('')}…` : t.join('')) : `${cardRef(c.number)} ${CAME_BACK}`
  }
  // HI-2143: a card submitted again after that return, for its reviewer.
  const again = c.about?.resubmitted
  if (again && c.changes !== 'gone') {
    const t = [...again.replace(/\s+/g, ' ').trim()]
    return max > 0 ? (t.length > max * 2 ? `${t.slice(0, max * 2 - 1).join('')}…` : t.join('')) : say(W.resubmitted, { card: cardRef(c.number) })
  }
  const head = `${cardRef(c.number)}${whereNow(c, max)}`
  if (!c.comment || max <= 0 || c.changes === 'gone') return head
  const t = [...c.comment.firstLine]
  return say(W.partComment, { head, by: shortName(c.comment.by), comment: t.length > max ? `${t.slice(0, max - 1).join('')}…` : t.join('') })
}

export function wakeLines(changes: CardChange[]): string {
  if (changes.length <= 1) return changes.length ? wakeLine(changes[0]) : ''
  const tail = say(W.manyEnded)
  const part = cardPart
  const full = (max: number): string => `${NOTICE_PREFIX}${changes.map((c) => part(c, max)).join('; ')}${tail}`
  for (const max of [160, 80, 40, 0]) if (jsonBytes(full(max)) <= WAKE_MAX_BYTES) return full(max)
  // Too many to tell in full (#226): every card is still named, with where it is and its verdict, but not whose it is,
  // who reviewed it or what was said; failing that, by number alone. The agent is told to read them.
  const short = say(W.manyShort)
  const compact = `${NOTICE_PREFIX}${changes.map(brief).join('; ')}${short}`
  if (jsonBytes(compact) <= WAKE_MAX_BYTES) return compact
  const numbers = NOTICE_PREFIX + say(W.numbersChanged, { cards: cards(changes.map((c) => c.number)), short })
  if (jsonBytes(numbers) <= WAKE_MAX_BYTES) return numbers
  // More cards than a watch can have (WATCH_MAX_CARDS): as many numbers as fit, the rest counted.
  for (let shown = changes.length - 1; shown >= 1; shown--) {
    const line = NOTICE_PREFIX + say(W.numbersMore, { cards: cards(changes.slice(0, shown).map((c) => c.number)), more: changes.length - shown, count: String(changes.length - shown), short })
    if (jsonBytes(line) <= WAKE_MAX_BYTES) return line
  }
  return NOTICE_PREFIX + say(W.countChanged, { n: String(changes.length), short })
}

/** A card in a few words, for a wake line too long to tell each in full: where it is, its verdict, nothing else. */
export function brief(c: CardChange): string {
  if (c.changes === 'gone' || c.column === 'gone') return say(W.briefGone, { card: cardRef(c.number), archived: c.archived ? 'yes' : 'no' })
  const a = c.about
  if (a?.returned) return say(W.briefReturned, { card: cardRef(c.number), round: String(a.returned) })
  const flags = [a?.verdict ? say(a.verdict.passed ? W.briefPassed : W.briefFailed) : '', c.blocked ? say(W.briefBlocked) : '', c.changes.includes('request') ? say(W.briefRequest) : '', c.changes.includes('decision') ? say(W.briefDecision) : '', c.changes.includes('step') ? say(W.briefStep) : ''].filter(Boolean)
  return say(W.briefIn, { card: cardRef(c.number), column: columnWord(c.column) }) + flags.map((f) => `, ${f}`).join('')
}

/**
 * A reply of the user's to an agent (#418), for the Assistant's card watch: the agent, the watched cards it has or
 * reviews (one reply is told once, whatever the number of its cards), and the first line of what was sent.
 */
export interface ReplyNote {
  agentName: string
  cards: number[]
  text: string
}

/** How the user is named in the Assistant's wake lines (#426): Settings → General → Your name, "User" when empty. */
// agent-protocol: a name, the user's when they set none (Settings → General → Your name), as a name they set is shown
export const DEFAULT_USER_NAME = 'User'
export function userNameOf(name: string | undefined): string {
  // One line, a few words: a name can't break the line or take its room.
  const t = [...(name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()]
  return t.length ? (t.length > 40 ? `${t.slice(0, 39).join('')}…` : t.join('')) : DEFAULT_USER_NAME
}

const replyNote = (r: ReplyNote, max: number, user: string): string => {
  const t = [...r.text]
  return say(W.replyNote, { user, agent: shortName(r.agentName), cards: cards(r.cards), quoted: max > 0 ? 'yes' : 'no', text: t.length > max ? `${t.slice(0, max - 1).join('')}…` : t.join('') })
}

/**
 * The Assistant's card watch line with the user's replies (#418), first, and the cards that changed, together within
 * WAKE_MAX_BYTES: what was said (the replies', the comments') gives way first, then whose and the verdicts (a few words
 * each), then everything but numbers and agents' names; the instruction at the end always stays. `repliesTold`: the line
 * names every reply (else none is taken as told, and the next watch tells them). `user`: the user's name (userNameOf).
 */
export function cardWakeLine(changes: CardChange[], replies: ReplyNote[], released: Released[] = [], user = DEFAULT_USER_NAME): { line: string; repliesTold: boolean } {
  if (!replies.length && !released.length) return { line: wakeLines(changes), repliesTold: false }
  if (!replies.length && !changes.length) return { line: releasedLine(released), repliesTold: false }
  const tail = say(changes.length ? W.manyEnded : W.repliesEnded)
  const fits = (line: string): boolean => jsonBytes(line) <= WAKE_MAX_BYTES
  for (const [max, rmax] of [[160, 120], [80, 80], [40, 40], [0, 40], [0, 0]]) {
    const line = `${NOTICE_PREFIX}${[...released.map((r) => releasedPart(r, true)), ...replies.map((r) => replyNote(r, rmax, user)), ...changes.map((c) => cardPart(c, max))].join('; ')}${tail}`
    if (fits(line)) return { line, repliesTold: true }
  }
  const short = say(W.repliesShort)
  const compact = `${NOTICE_PREFIX}${[...released.map((r) => releasedPart(r, false)), ...replies.map((r) => replyNote(r, 0, user)), ...changes.map(brief)].join('; ')}${short}`
  if (fits(compact)) return { line: compact, repliesTold: true }
  const who = [...new Set(replies.map((r) => shortName(r.agentName)))].join(', ')
  const numbers = `${NOTICE_PREFIX}${[released.length ? say(W.leftWatch, { cards: cards(released.map((r) => r.number)) }) : '', replies.length ? say(W.repliedTo, { user, who }) : '', changes.length ? say(W.changed, { cards: cards(changes.map((c) => c.number)) }) : ''].filter(Boolean).join('; ')}${short}`
  if (fits(numbers)) return { line: numbers, repliesTold: true }
  // Never past the limit: the cards as a card line tells them; the replies are told by a later wake.
  return { line: wakeLines(changes) || NOTICE_PREFIX + say(W.repliedToAgents, { user, short }), repliesTold: !changes.length }
}

/**
 * A card that left a watch because the watcher's part in it ended (#420): reassigned to another agent, or reviewed by
 * another. Its agent's or reviewer's name now. 'blocked' is only in watches saved before #481: a blocked card is paused,
 * and stays in the watch now. #1475: 'done', the card reached Done (merged) where the watch couldn't count it, and
 * 'laneEnded', the watcher's lane on it ended or was abandoned: nothing more can come of the watch.
 */
export interface Released {
  number: number
  why: 'reassigned' | 'reviewer' | 'blocked' | 'done' | 'laneEnded'
  /** The agent it was given to or the reviewer reviewing it (null: nobody), or why it is blocked; for laneEnded, 'abandoned' or null (ended). */
  detail: string | null
}

export const RELEASE_REASONS: readonly Released['why'][] = ['reassigned', 'reviewer', 'blocked', 'done', 'laneEnded']

/** Released for good (#1475): the card's loop is over for the watcher, so there is no next card to carry on with on its account. */
const over = (r: Released): boolean => r.why === 'done' || r.why === 'laneEnded'

/** What happened to a released card, for a wake line: "#354 was reassigned to B4", "#356 is blocked: "…"". */
function releasedPart(r: Released, full: boolean): string {
  const card = cardRef(r.number)
  const head =
    r.why === 'blocked'
      ? say(W.relBlocked, { card, quoted: full && r.detail ? 'yes' : 'no', why: r.detail ? ([...r.detail].length > 120 ? `${[...r.detail].slice(0, 119).join('')}…` : r.detail) : '' })
      : r.why === 'reviewer'
        ? r.detail
          ? say(W.relReviewedBy, { card, reviewer: shortName(r.detail) })
          : say(W.relReviewTaken, { card })
        : r.why === 'done'
          ? say(W.relDone, { card })
          : r.why === 'laneEnded'
            ? say(W.relLaneEnded, { card, abandoned: r.detail === 'abandoned' ? 'yes' : 'no' })
            : r.detail
              ? say(W.relReassignedTo, { card, agent: shortName(r.detail) })
              : say(W.relReassigned, { card })
  return say(W.relEnded, { head })
}

/**
 * The line for a watch whose every card left it (#420): what happened to each, then to drop them and carry on. When each
 * left for good (#1475: Done, its lane ended), there is nothing more to wait for: the agent ends its turn, idle, unless it
 * has other work, so the next lane's prompt finds it free.
 */
export function releasedLine(released: Released[]): string {
  const n = released.length
  const tail = say(released.every(over) ? W.relOverTail : W.relDropTail, { n })
  for (const full of [true, false]) {
    const line = `${NOTICE_PREFIX}${released.map((r) => releasedPart(r, full)).join('; ')}${tail}`
    if (jsonBytes(line) <= WAKE_MAX_BYTES) return line
  }
  return NOTICE_PREFIX + say(W.relLeft, { cards: cards(released.map((r) => r.number)), over: released.every(over) ? 'yes' : 'no', tail })
}

/**
 * Where a timed-out watch's card is now, when it is in Review (HI-2295), read from the board as the limit passes: being
 * reviewed (`reviewer`: who), given by the reviewer pool to a reviewer that hasn't started (`assigned`), waiting for the
 * pool to give it to one (`pool`), or waiting for its reviewer (`review`). A dependency in progress (HI-2381): a card
 * that waits on another agent's card in Doing or Review (`waits`, `on` those), and that card, in Doing with its builder
 * (`working`, `reviewer` its builder): another's work going on is nothing to ask the user about either.
 */
export interface ReviewWhere {
  number: number
  state: 'reviewing' | 'assigned' | 'pool' | 'review' | 'waits' | 'working'
  reviewer?: string
  on?: number[]
}

/** Where a card is that waits on, or is, another agent's card in progress (HI-2381), rather than one in Review. */
const dependencyState = (w: ReviewWhere): boolean => w.state === 'waits' || w.state === 'working'

function wherePart(w: ReviewWhere): string {
  const values = { card: cardRef(w.number), agent: shortName(w.reviewer ?? ''), on: cards(w.on ?? []) }
  const m = w.state === 'waits' ? W.whereWaits : w.state === 'working' ? W.whereWorking : w.state === 'reviewing' ? W.whereReviewing : w.state === 'assigned' ? W.whereAssigned : w.state === 'pool' ? W.wherePool : W.whereReview
  return say(m, values)
}

/**
 * The line Hive types when a watch's overall limit passes with no change. Cards that left the watch meanwhile (#420) are
 * told first: drop them. A card in Review (HI-2295, `where`) is said to be there, by whom it is reviewed or that it waits for
 * a reviewer: a review on its way is nothing to tell the user, so only the other cards ask the agent to. Likewise a card
 * waiting on another agent's card in progress, and that card (HI-2381): watched again quietly, the lane showing the wait.
 */
export function limitLine(cond: WatchCondition, minutes: number, released: Released[] = [], where: ReviewWhere[] = []): string {
  const dur = minutes >= 60 ? say(W.hours, { h: String(Math.round((minutes / 60) * 10) / 10) }) : say(W.minutes, { m: String(minutes) })
  const gone = new Set(released.map((r) => r.number))
  const placed = where.filter((w) => cond.cards.includes(w.number) && !gone.has(w.number))
  const inReview = placed.filter((w) => !dependencyState(w))
  const waiting = placed.filter(dependencyState)
  const known = new Set(placed.map((w) => w.number))
  const rest = cond.cards.filter((n) => !gone.has(n) && !known.has(n))
  const steps: string[] = []
  if (released.length) steps.push(say(W.stepDrop, { n: released.length }))
  if (inReview.length) steps.push(say(W.stepWatchReview, { cards: cards(inReview.map((w) => w.number)), n: inReview.length }))
  if (waiting.length) steps.push(say(W.stepWatchWaiting, { cards: cards(waiting.map((w) => w.number)), n: waiting.length }))
  if (rest.length || !steps.length) steps.push(say(W.stepAsk, { rest: steps.length ? 'yes' : 'no' }))
  const todo = steps.join('; ')
  const ended = say(W.limitEnded, { cards: cards(cond.cards), dur })
  const shortParts = [...(inReview.length ? [say(W.shortInReview, { cards: cards(inReview.map((w) => w.number)), n: inReview.length })] : []), ...(waiting.length ? [say(W.shortWaiting, { cards: cards(waiting.map((w) => w.number)), n: waiting.length })] : [])]
  // The first step starts a sentence: its first letter is capitalised here (as the contract's first route is, card 1).
  const tailOf = (full: boolean): string => `${ended} ${placed.length ? `${full ? [...inReview, ...waiting].map(wherePart).join('; ') : shortParts.join('; ')}. ` : ''}${todo[0].toUpperCase()}${todo.slice(1)}.`
  for (const full of [true, false]) {
    const head = released.length ? `${released.map((r) => releasedPart(r, full)).join('; ')}. ` : ''
    const line = `${NOTICE_PREFIX}${head}${tailOf(full)}`
    if (jsonBytes(line) <= WAKE_MAX_BYTES) return line
  }
  return `${NOTICE_PREFIX}${released.length ? `${say(W.leftWatchReassigned, { cards: cards(released.map((r) => r.number)) })} ` : ''}${tailOf(false)}`
}

const cards = (ns: number[]): string => ns.map((n) => `${cardRef(n)}`).join(', ')

/** What a watching agent shows (its header, tab, the Agent API): "Waiting for #12 → Review", "Waiting for #12, #13". */
export function watchLabel(cond: Pick<WatchCondition, 'cards' | 'column'>): string {
  return say(W.label, { cards: cards(cond.cards), hasColumn: cond.column ? 'yes' : 'no', column: cond.column ? columnWord(cond.column) : '' })
}

/** A condition from untrusted arguments, or an error saying what is wrong. */
export function readCondition(args: { cards?: unknown; changes?: unknown; until?: unknown; column?: unknown; fresh?: unknown }): WatchCondition | string {
  const raw = Array.isArray(args.cards) ? args.cards : []
  const ns = [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0)
  if (!ns.length || ns.length !== raw.length) return say(W.badCards)
  if (ns.length > WATCH_MAX_CARDS) return say(W.tooManyCards, { max: String(WATCH_MAX_CARDS) })
  const column = args.column
  if (column !== undefined && !COLUMNS.includes(column as TaskColumn)) return say(W.badColumn, { choices: COLUMN_CHOICES })
  const list = args.changes ?? args.until
  const given = list !== undefined && list !== 'any'
  // A column alone: arriving in it is all that counts. Otherwise the kinds listed (default: any).
  const changes = !given ? (column ? ['column'] : [...WATCH_CHANGES]) : Array.isArray(list) ? [...new Set(list)] : [list]
  if (!changes.length || changes.some((c) => !WATCH_CHANGES.includes(c as WatchChange))) return say(W.badChanges, { choices: WATCH_CHANGES.join(', ') })
  if (column && !changes.includes('column')) return say(W.columnNeedsChange)
  if (args.fresh !== undefined && typeof args.fresh !== 'boolean') return say(W.badFresh)
  const fresh = args.fresh === true
  if (fresh && !column) return say(W.freshNeedsColumn)
  // A column with `column` named among the changes: a move into it, met at once by a card already there (#434). Fresh:
  // only the next move into it (a card already there waits for it to come back).
  const moveInto = !!column && (given || fresh)
  return { cards: ns, changes: changes as WatchChange[], ...(column ? { column: column as TaskColumn } : {}), ...(moveInto ? { moveInto: true as const } : {}), ...(fresh ? { fresh: true as const } : {}) }
}
