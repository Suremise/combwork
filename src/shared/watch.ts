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
import type { TaskCard, TaskColumn } from './types'
import { COLUMN_CHOICES, COLUMN_IDS, TASK_COLUMNS, columnLabel, isLoopStepEntry } from './tasks'
import { cardRef } from './projectKeys'
import { CAME_BACK } from './workflow/queue'

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
/** The longest an Agent API agents wait (`POST /v1/agents/wait`, hive_wait_for_agents) holds a call. */
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

const VERDICT = /^Review (passed|failed)/

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
  const verdict = card.history.filter((h) => VERDICT.test(h.what)).at(-1)
  return { column: card.column, comment: last ? Date.parse(last.at) || 0 : 0, verdict: verdict ? Date.parse(verdict.at) || 0 : 0, agent: card.agent ?? '', archived: card.archived }
}

/**
 * Whether a card moved into `column` after `since` (ISO), by its history ("Moved to Review", "Moved to the top of Review",
 * "Moved to Review, before #3"): a card that left and came back looks the same as one that never moved, by its marks.
 */
export function movedIntoSince(card: TaskCard | null, column: TaskColumn, since: string): boolean {
  if (!card) return false
  const w = columnLabel(column)
  // A failed card returned for review without leaving Review (#214) comes back into it as much as one moved there.
  const re = new RegExp(`^(Moved to (the (top|bottom) of )?${w}\\b|Created in ${w}\\b${column === 'review' ? '|Returned for review\\b' : ''})`)
  return card.history.some((h) => h.at > since && re.test(h.what))
}

/** History that puts a card in a column, and which. */
const INTO_COLUMN = new RegExp(String.raw`^(?:Moved to (?:the (?:top|bottom) of )?|Created in )(${TASK_COLUMNS.map((c) => c.label).join('|')})\b|^(Returned for review)\b`)
const COLUMN_OF: Record<string, TaskColumn> = Object.fromEntries(TASK_COLUMNS.map((c) => [c.label, c.id]))
const intoColumn = (what: string): TaskColumn | null => {
  const m = INTO_COLUMN.exec(what)
  return m ? (m[2] ? 'review' : COLUMN_OF[m[1]]) : null
}
const HANDS = /^(Given to|Taken from)\b/

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
    column: own(h.filter((e) => intoColumn(e.what))) ? now.column : told.mark.column,
    comment: own(c) ? now.comment : told.mark.comment,
    verdict: own(h.filter((e) => VERDICT.test(e.what))) ? now.verdict : told.mark.verdict,
    agent: own(h.filter((e) => HANDS.test(e.what))) ? now.agent : told.mark.agent,
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
  const into = history.findLast((e) => intoColumn(e.what))
  const cut = { ...card, history, comments, column: into ? intoColumn(into.what)! : card.column }
  // Its agent then isn't kept by id (a history line names a board name): given to someone or taken from it by another
  // since, the agent it had is unknown (HR1's round 1 finding: the agent as it is now swallowed that reassignment), so the
  // watch counts it; else the card's agent as it is now, unchanged since.
  const handed = card.history.slice(history.length).some((e) => HANDS.test(e.what) && e.by !== self)
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
  const moves = h.filter((e) => intoColumn(e.what))
  const ownMoves = !!base.watcher && moves.length > 0 && moves.every((e) => e.by === base.watcher)
  const moved = !!cond.column && h.some((e) => intoColumn(e.what) === cond.column && e.by !== base.watcher)
  // HI-2143: a watch on any move counts a card that left and came back (HR2's on HI-2122, begun in Review: passed,
  // returned by the merge queue, submitted again, in Review once more), unless every move since was its own.
  const back = !cond.column && moves.length > 0 && !ownMoves
  if (kinds.has('column') && ((now.column !== base.mark.column && !ownMoves) || moved || back) && (!cond.column || now.column === cond.column)) out.push('column')
  if (kinds.has('comment') && c.length) out.push('comment')
  if (kinds.has('verdict') && h.some((e) => VERDICT.test(e.what))) out.push('verdict')
  if (kinds.has('agent') && now.agent !== base.mark.agent) out.push('agent')
  // Blocked since, and still (#726): a block lifted again meanwhile has nothing left to tell.
  if (cond.blocked && card.blocked && h.some((e) => BLOCKED.test(e.what))) out.push('blocked')
  out.push(...handoffsIn(h, cond, base.watcher))
  return out
}

const BLOCKED = /^Blocked: /
/** A reviewer's request to the card's builder (#912), and a decision the user recorded, changed or removed, in a card's history. */
const REQUEST = /^Asked the builder: /
/** A builder's reply to its reviewer (HI-2302): counted as a loop step, its wake's kind. */
const REPLY = /^Replied to the reviewer: /
const DECISION = /^(Recorded a decision|Changed a decision|Removed a decision)\b/
/** Whether a history entry is a decision recorded, changed or removed. */
export const isDecisionEntry = (what: string): boolean => DECISION.test(what)

/**
 * Whether a watch counts a reviewer's request and a decision (#1272, SPEC §16.8.2): one that counts a verdict, a move or
 * a comment (a builder waiting for its verdict asked only for verdict and column, #912's case), but not one that waits
 * only to see a card in a column (a reviewer waiting for its arrival in Review).
 */
export const hearsHandoffs = (cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto'>): boolean =>
  !(cond.column && !cond.moveInto) && (!cond.changes.length || cond.changes.some((c) => c === 'verdict' || c === 'column' || c === 'comment'))

/** The requests and decisions among history entries new to a watch (`watcher`: its board name; its own aren't news). */
function handoffsIn(h: readonly { by: string; what: string }[], cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto'>, watcher?: string): WatchChange[] {
  if (!hearsHandoffs(cond)) return []
  const others = watcher ? h.filter((e) => e.by !== watcher) : h
  return [...(others.some((e) => REQUEST.test(e.what)) ? ['request' as const] : []), ...(others.some((e) => DECISION.test(e.what)) ? ['decision' as const] : []), ...(others.some((e) => isLoopStepEntry(e.what) || REPLY.test(e.what)) ? ['step' as const] : [])]
}

/**
 * The requests and decisions a wait counts on a card after `since` (ISO), by its history: for a wait that compares marks
 * (a bounded wait, a watch saved before #224), which have no place for them.
 */
export const handoffsSince = (card: TaskCard | null, since: string, cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto'>, watcher?: string): WatchChange[] =>
  card ? handoffsIn(card.history.filter((e) => e.at > since), cond, watcher) : []

/** A card's return for review in its history: "Returned for review, round 2". */
const RETURNED = /^Returned for review, round (\d+)/

/**
 * Whether a card in Review can be returned for review (#214): its latest review failed, and nothing has started another
 * round since (moved, reviewed again, reassigned, already returned). Its round then: one more than the reviews that
 * failed since it last passed one. Null: not returnable (moving it to Review is no change).
 */
export function returnRound(card: TaskCard): number | null {
  if (card.column !== 'review' || card.archived || card.review) return null
  const i = card.history.findLastIndex((h) => VERDICT.test(h.what))
  if (i < 0 || VERDICT.exec(card.history[i].what)![1] !== 'failed') return null
  if (card.history.slice(i + 1).some((h) => NEW_ROUND.test(h.what))) return null
  const passed = card.history.findLastIndex((h) => h.what.startsWith('Review passed'))
  return card.history.slice(passed + 1).filter((h) => h.what.startsWith('Review failed')).length + 1
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
const NEW_ROUND = /^(Moved to (the (top|bottom) of )?(On Hold|Todo|Doing|Review)\b|Created in |Given to |Taken from |Moved to the workspace|Started reviewing|Returned for review)/

const INTO_REVIEW = /^(Moved to (the (top|bottom) of )?Review\b|Created in Review\b|Returned for review\b)/
const TO_DOING = /^Moved to (the (top|bottom) of )?Doing\b/

/** A wake's context for the agent `watcher` (its id), from the card as it is now. */
export function wakeAbout(card: TaskCard | null, changes: WatchChange[] | 'gone', watcher: string): WakeAbout {
  if (!card || changes === 'gone') return { owner: null, verdict: null }
  const owner = card.agent && card.agent !== watcher ? (card.agentName ?? card.agent) : null
  // The latest verdict, only while nothing has started another round since (back to Doing, reviewed again, reassigned):
  // one from an earlier build never speaks for work done after it. History is in the order it happened.
  const i = card.history.findLastIndex((h) => VERDICT.test(h.what))
  // A failed card's move back to Doing in the verdict's own change is its verdict's doing (HI-1946), not another round.
  const itsMove = (h: TaskCard['history'][number]): boolean => h.at === card.history[i].at && h.by === card.history[i].by && TO_DOING.test(h.what)
  const current = i >= 0 && !card.history.slice(i + 1).some((h) => NEW_ROUND.test(h.what) && !itsMove(h)) ? card.history[i] : null
  const passed = current ? VERDICT.exec(current.what)![1] === 'passed' : false
  // Passed or Done on another agent's card names its review only when that review passed it; moved there by hand, none.
  const wanted = changes.includes('verdict') || (!!owner && (card.column === 'passed' || card.column === 'done') && passed)
  // Into Review by a return for review (#214): its latest arrival there says so.
  const arrival = changes.includes('column') && card.column === 'review' ? card.history.findLast((h) => INTO_REVIEW.test(h.what)) : undefined
  const returned = arrival ? RETURNED.exec(arrival.what) : null
  return { owner, verdict: wanted && current ? { passed, by: current.by } : null, ...(returned ? { returned: Number(returned[1]) } : {}) }
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
export const LANES_RUNNING_TAIL = ' Lanes are still running (hive_lane list): before you end your turn, watch them again in one lane watch, with any card outside them as cards (hive_wait_for_tasks with lanes ["all"], cards, wake; run-lanes).'
export function withLanesTail(line: string, max = WAKE_MAX_BYTES): string {
  if (line.endsWith(LANES_RUNNING_TAIL)) return line
  let s = line
  if (jsonBytes(s + LANES_RUNNING_TAIL) > max) {
    while (s && jsonBytes(`${s}…${LANES_RUNNING_TAIL}`) > max) s = s.slice(0, -1)
    s = `${s}…`
  }
  return s + LANES_RUNNING_TAIL
}

const firstLine = (text: string, max = 160): string => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A change, for a reply or a wake line. */
export function cardChange(n: number, card: TaskCard | null, changes: WatchChange[] | 'gone'): CardChange {
  const last = card?.comments.at(-1)
  const by = card ? ([...card.history].sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.by ?? null) : null
  return { number: n, column: card ? card.column : 'gone', changes, by, comment: last ? { by: last.by, firstLine: firstLine(last.text) } : null, ...(changes === 'gone' && card?.archived ? { archived: true } : {}), ...(changes !== 'gone' && changes.includes('blocked') && card?.blocked ? { blocked: card.blocked } : {}) }
}

const columnWord = (c: TaskColumn | 'gone'): string => (c === 'gone' ? 'gone' : columnLabel(c))

/**
 * The one line Hive types to wake a watching agent: the card (and whose, when it isn't the watcher's), where it is now
 * (with the reviewer's verdict when that changed; Passed on another agent's card says it isn't merged yet), and its latest
 * comment's author and first line, then what to do. Kept to one short line (the CLI sends a new line at once).
 */
export function wakeLine(change: CardChange, more = 0): string {
  const others = more ? ` (and ${more} more watched card${more === 1 ? '' : 's'} changed)` : ''
  return lineOf(change, `${others}. Your card watch has ended: carry on (hive_read_task with latestComment for the comment in full).`)
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
    kind === 'done' && next ? next : kind === 'review' ? 'You review this card in its loop: carry on with it' : kind === 'step'
        ? "You review this card in its loop: check it and answer with hive_loop_step (ok, or gaps saying what's missing, and its id)"
        : kind === 'stepNotice'
          ? 'Nothing to answer: carry on with your loop'
          : kind === 'reply'
            ? 'You review this card in its loop: carry on with your review'
          : kind === 'answer' ? 'The user answered: carry on from where you asked' : 'This is your card in its loop: carry on'
  // A reviewer's request (#912), a card loop's step (#1382) or Hive's own note (stale, an answer, what came back from the
  // merge queue and what to do next: #1354, up to NOTE_MAX): what it says, short, before what to do.
  const said = text ? [...text.replace(/\s+/g, ' ').trim()] : []
  const max = kind === 'request' || kind === 'step' || kind === 'stepAnswer' || kind === 'stepNotice' || kind === 'reply' ? REQUEST_MAX : kind === 'answer' ? ANSWER_MAX : NOTE_MAX
  const whose = kind === 'request' ? 'The reviewer asks' : kind === 'reply' ? 'The builder replies' : kind === 'step' || kind === 'stepNotice' ? 'The builder' : kind === 'stepAnswer' ? 'The reviewer' : 'Hive'
  const tail = `. ${who} (hive_read_task with latestComment for the comment in full).`
  // HI-2087: Hive's note that the merge queue returned the card leads the line, as a watch's does: its column and the
  // review's pass first made HB2 take HI-2046 for merged.
  if (isReturnNote(kind, text)) return lineOf({ ...change, about: { owner: null, verdict: null, ...change.about, queueReturn: said.slice(0, max).join('') } }, tail)
  const what = !said.length ? '' : `. ${whose}: "${said.length > max ? `${said.slice(0, max - 1).join('')}…` : said.join('')}"`
  return lineOf(change, `${what}${tail}`)
}

/**
 * What comes next in a builder's lane, as its Done wake says it (HI-1990; English, agent-facing): its next card, which
 * Hive starts for it once its turn ends (`hiveStarts`, rules on), for it to start (`start`, rules off), already under way
 * (`started`) or not yet startable (`waits`); the lane paused; or none left.
 */
export function laneNextWords(next: { card: number; title: string; is: 'hiveStarts' | 'start' | 'started' | 'waits' } | 'paused' | 'last'): string {
  if (next === 'paused') return 'Your lane is paused: hive_lane next says why'
  if (next === 'last') return "That was your lane's last card: the lane ends by itself, so end your turn unless you have other work"
  const title = [...next.title.trim()]
  const card = `${cardRef(next.card)} ("${title.length > 60 ? `${title.slice(0, 59).join('')}…` : title.join('')}")`
  switch (next.is) {
    case 'hiveStarts':
      return `Your lane's next card is ${card}: Hive starts it for you once your turn ends, so end your turn now`
    case 'start':
      return `Your lane's next card is ${card}: start it now (hive_lane next, then hive_start_card); this card's own prompt doesn't narrow the lane`
    case 'started':
      return `Your lane's next card, ${card}, is under way: carry on with it`
    case 'waits':
      return `Your lane's next card is ${card}: hive_lane next says when it can start`
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
  const id = design ? ` ${design}` : ''
  const checked = of === 'followUp' ? 'follow-up' : 'design'
  const what: Record<string, string> = { design: `design${id} posted for your check (answer with its id)`, followUp: `follow-up${id} ready for your check (answer with its id)`, proceed: `no check of design${id} came in time: the builder goes ahead with it as posted`, ok: `${checked}${id} is OK`, gaps: `${checked}${id} has gaps` }
  return `${what[step] ?? step}: ${text}`
}
export type LoopWakeKind = (typeof LOOP_WAKE_KINDS)[number]

function lineOf(change: CardChange, tail: string): string {
  // HI-2087: a card the merge queue returned leads with the return and its reason (its words name the card).
  if (change.about?.queueReturn) return returnLine(change.about.queueReturn, (t) => `[Hive] ${t}${tail}`)
  // HI-2143: and a card submitted again after that return, for its reviewer.
  if (change.about?.resubmitted && change.changes !== 'gone') return returnLine(change.about.resubmitted, (t) => `[Hive] ${t}${tail}`)
  const head = `[Hive] ${cardRef(change.number)}${whereNow(change)}`
  if (!change.comment) return head + tail
  // The card, its state and what to do always fit (names are short); the comment's first line gives way, cut with "…".
  const by = shortName(change.comment.by)
  let text = [...change.comment.firstLine]
  const line = (cut: boolean): string => `${head}; latest comment by ${by}: "${text.join('')}${cut ? '…' : ''}"${tail}`
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
  if (change.changes === 'gone') return change.archived ? ' was archived (off the board: only the user brings it back)' : ' is gone from your board (archived, deleted or moved to another project)'
  const owner = about?.owner ? ` (${shortName(about.owner)}'s card)` : ''
  const verdict = about?.verdict ? `: ${shortName(about.verdict.by)} ${about.verdict.passed ? 'passed' : 'failed'} it` : ''
  // Passed means the review passed, not that the work is merged: Done is merged (#170).
  const merged = about?.owner && change.column === 'passed' ? " (Passed isn't merged)" : ''
  const why = change.blocked ? [...change.blocked.replace(/\s+/g, ' ').trim()] : []
  const blocked = change.blocked ? ` and blocked${blockedMax > 0 ? `: "${why.length > blockedMax ? `${why.slice(0, blockedMax - 1).join('')}…` : why.join('')}"` : ''}` : ''
  const said = handoffWords(change.changes)
  return about?.returned ? `${owner} was returned for review (round ${about.returned})${verdict}${blocked}${said}` : `${owner} is in ${columnWord(change.column)}${verdict}${merged}${blocked}${said}`
}

/** What a wake adds for a reviewer's request and a new decision (#1272): " (its reviewer asks you something; a new decision)". */
function handoffWords(changes: WatchChange[]): string {
  const said = [changes.includes('request') ? 'its reviewer asks you something' : '', changes.includes('decision') ? 'a new decision from the user: read its decisions' : '', changes.includes('step') ? 'a card loop step: read its latest comment' : ''].filter(Boolean)
  return said.length ? ` (${said.join('; ')})` : ''
}

/**
 * The line that wakes an agent for every watched card that changed (#224): one card as wakeLine says it; several, each
 * with where it is now and its verdict, so a second change that landed with the first isn't lost ("#217 is in Review:
 * Codex passed it; #119 is in Review: Codex failed it"). Comments' first lines give way first; then every card is still
 * named, in a few words (#226: "#217 in Review, passed; #119 in Review, failed"), or by number alone, with the agent told
 * that details were left out. Never cut mid-way, one line, within WAKE_MAX_BYTES.
 */
const MANY_TAIL = '. Your card watch has ended: carry on (hive_read_task with latestComment on each card for its comment in full).'
/**
 * A card's part of a line telling several (#224), its latest comment's first line (and why it is blocked, #726) cut to
 * `max` characters (0: left out). A lane watch's line tells its cards with it.
 */
export function cardPart(c: CardChange, max: number): string {
  // HI-2087: a card the merge queue returned: the return, its reason as far as `max` allows (none: that it came back).
  const back = c.about?.queueReturn
  if (back && c.changes !== 'gone') {
    const t = [...back.replace(/\.$/, '')]
    return max > 0 ? (t.length > max * 2 ? `${t.slice(0, max * 2 - 1).join('')}…` : t.join('')) : `${cardRef(c.number)} ${CAME_BACK}`
  }
  // HI-2143: a card submitted again after that return, for its reviewer.
  const again = c.about?.resubmitted
  if (again && c.changes !== 'gone') {
    const t = [...again.replace(/\s+/g, ' ').trim()]
    return max > 0 ? (t.length > max * 2 ? `${t.slice(0, max * 2 - 1).join('')}…` : t.join('')) : `${cardRef(c.number)} is back in Review after the merge queue returned it`
  }
  const head = `${cardRef(c.number)}${whereNow(c, max)}`
  if (!c.comment || max <= 0 || c.changes === 'gone') return head
  const t = [...c.comment.firstLine]
  return `${head} (latest comment by ${shortName(c.comment.by)}: "${t.length > max ? `${t.slice(0, max - 1).join('')}…` : t.join('')}")`
}

export function wakeLines(changes: CardChange[]): string {
  if (changes.length <= 1) return changes.length ? wakeLine(changes[0]) : ''
  const tail = MANY_TAIL
  const part = cardPart
  const full = (max: number): string => `[Hive] ${changes.map((c) => part(c, max)).join('; ')}${tail}`
  for (const max of [160, 80, 40, 0]) if (jsonBytes(full(max)) <= WAKE_MAX_BYTES) return full(max)
  // Too many to tell in full (#226): every card is still named, with where it is and its verdict, but not whose it is,
  // who reviewed it or what was said; failing that, by number alone. The agent is told to read them.
  const short = '. Your card watch has ended. Details were left out to fit: read each card (hive_read_task) before you carry on.'
  const compact = `[Hive] ${changes.map(brief).join('; ')}${short}`
  if (jsonBytes(compact) <= WAKE_MAX_BYTES) return compact
  const numbers = `[Hive] ${changes.map((c) => `${cardRef(c.number)}`).join(', ')} changed${short}`
  if (jsonBytes(numbers) <= WAKE_MAX_BYTES) return numbers
  // More cards than a watch can have (WATCH_MAX_CARDS): as many numbers as fit, the rest counted.
  for (let shown = changes.length - 1; shown >= 1; shown--) {
    const more = changes.length - shown
    const line = `[Hive] ${changes.slice(0, shown).map((c) => `${cardRef(c.number)}`).join(', ')} and ${more} more watched card${more === 1 ? '' : 's'} changed${short}`
    if (jsonBytes(line) <= WAKE_MAX_BYTES) return line
  }
  return `[Hive] ${changes.length} watched cards changed${short}`
}

/** A card in a few words, for a wake line too long to tell each in full: where it is, its verdict, nothing else. */
export function brief(c: CardChange): string {
  if (c.changes === 'gone' || c.column === 'gone') return `${cardRef(c.number)} ${c.archived ? 'archived' : 'gone'}`
  const a = c.about
  if (a?.returned) return `${cardRef(c.number)} returned for review (round ${a.returned})`
  return `${cardRef(c.number)} in ${columnWord(c.column)}${a?.verdict ? (a.verdict.passed ? ', passed' : ', failed') : ''}${c.blocked ? ', blocked' : ''}${c.changes.includes('request') ? ', a request' : ''}${c.changes.includes('decision') ? ', a decision' : ''}${c.changes.includes('step') ? ', a loop step' : ''}`
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
export const DEFAULT_USER_NAME = 'User'
export function userNameOf(name: string | undefined): string {
  // One line, a few words: a name can't break the line or take its room.
  const t = [...(name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()]
  return t.length ? (t.length > 40 ? `${t.slice(0, 39).join('')}…` : t.join('')) : DEFAULT_USER_NAME
}

const replyNote = (r: ReplyNote, max: number, user: string): string => {
  const t = [...r.text]
  return `${user} replied to ${shortName(r.agentName)} on ${cards(r.cards)}${max > 0 ? `: "${t.length > max ? `${t.slice(0, max - 1).join('')}…` : t.join('')}"` : ''}`
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
  const tail = changes.length ? MANY_TAIL : '. Your card watch has ended: carry on (hive_read_task for the card, hive_agent_activity for the agent).'
  const fits = (line: string): boolean => jsonBytes(line) <= WAKE_MAX_BYTES
  for (const [max, rmax] of [[160, 120], [80, 80], [40, 40], [0, 40], [0, 0]]) {
    const line = `[Hive] ${[...released.map((r) => releasedPart(r, true)), ...replies.map((r) => replyNote(r, rmax, user)), ...changes.map((c) => cardPart(c, max))].join('; ')}${tail}`
    if (fits(line)) return { line, repliesTold: true }
  }
  const short = '. Your card watch has ended. Details were left out to fit: read each card (hive_read_task) and agent (hive_agent_activity) before you carry on.'
  const compact = `[Hive] ${[...released.map((r) => releasedPart(r, false)), ...replies.map((r) => replyNote(r, 0, user)), ...changes.map(brief)].join('; ')}${short}`
  if (fits(compact)) return { line: compact, repliesTold: true }
  const who = [...new Set(replies.map((r) => shortName(r.agentName)))].join(', ')
  const numbers = `[Hive] ${[released.length ? `${cards(released.map((r) => r.number))} left your watch` : '', replies.length ? `${user} replied to ${who}` : '', changes.length ? `${changes.map((c) => `${cardRef(c.number)}`).join(', ')} changed` : ''].filter(Boolean).join('; ')}${short}`
  if (fits(numbers)) return { line: numbers, repliesTold: true }
  // Never past the limit: the cards as a card line tells them; the replies are told by a later wake.
  return { line: wakeLines(changes) || `[Hive] ${user} replied to agents of your watched cards${short}`, repliesTold: !changes.length }
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
  const head =
    r.why === 'blocked'
      ? `${cardRef(r.number)} is blocked${full && r.detail ? `: "${[...r.detail].length > 120 ? `${[...r.detail].slice(0, 119).join('')}…` : r.detail}"` : ''}`
      : r.why === 'reviewer'
        ? r.detail
          ? `${cardRef(r.number)} is reviewed by ${shortName(r.detail)}`
          : `${cardRef(r.number)}'s review was taken from you`
        : r.why === 'done'
          ? `${cardRef(r.number)} is in Done`
          : r.why === 'laneEnded'
            ? `${cardRef(r.number)}'s lane ${r.detail === 'abandoned' ? 'was abandoned' : 'ended'}`
            : `${cardRef(r.number)} was reassigned${r.detail ? ` to ${shortName(r.detail)}` : ' (it has no agent now)'}`
  return `${head} (your watch on it ended)`
}

/**
 * The line for a watch whose every card left it (#420): what happened to each, then to drop them and carry on. When each
 * left for good (#1475: Done, its lane ended), there is nothing more to wait for: the agent ends its turn, idle, unless it
 * has other work, so the next lane's prompt finds it free.
 */
export function releasedLine(released: Released[]): string {
  const one = released.length === 1
  const tail = released.every(over)
    ? `. Your card watch has ended: there is nothing more to wait for on ${one ? 'it' : 'them'}. Don't watch ${one ? 'it' : 'them'} again; end your turn unless you have other work.`
    : `. Your card watch has ended: drop ${one ? 'it' : 'them'} from your list and carry on with your next card.`
  for (const full of [true, false]) {
    const line = `[Hive] ${released.map((r) => releasedPart(r, full)).join('; ')}${tail}`
    if (jsonBytes(line) <= WAKE_MAX_BYTES) return line
  }
  return `[Hive] ${cards(released.map((r) => r.number))} left your watch (${released.every(over) ? 'done, or its lane ended' : 'reassigned, or reviewed by another'})${tail}`
}

/**
 * Where a timed-out watch's card is now, when it is in Review (HI-2295), read from the board as the limit passes: being
 * reviewed (`reviewer`: who), given by the reviewer pool to a reviewer that hasn't started (`assigned`), waiting for the
 * pool to give it to one (`pool`), or waiting for its reviewer (`review`).
 */
export interface ReviewWhere {
  number: number
  state: 'reviewing' | 'assigned' | 'pool' | 'review'
  reviewer?: string
}

function wherePart(w: ReviewWhere): string {
  const ref = cardRef(w.number)
  return w.state === 'reviewing'
    ? `${ref} is in Review, being reviewed by ${shortName(w.reviewer ?? '')}`
    : w.state === 'assigned'
      ? `${ref} is in Review: the reviewer pool gave it to ${shortName(w.reviewer ?? '')}, who hasn't started yet`
      : w.state === 'pool'
        ? `${ref} is in Review, waiting for the reviewer pool to give it to a reviewer`
        : `${ref} is in Review, waiting for its reviewer`
}

/**
 * The line Hive types when a watch's overall limit passes with no change. Cards that left the watch meanwhile (#420) are
 * told first: drop them. A card in Review (HI-2295, `where`) is said to be there, by whom it is reviewed or that it waits for
 * a reviewer: a review on its way is nothing to tell the user, so only the other cards ask the agent to.
 */
export function limitLine(cond: WatchCondition, minutes: number, released: Released[] = [], where: ReviewWhere[] = []): string {
  const dur = minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10} h` : `${minutes} min`
  const gone = new Set(released.map((r) => r.number))
  const inReview = where.filter((w) => cond.cards.includes(w.number) && !gone.has(w.number))
  const reviewed = new Set(inReview.map((w) => w.number))
  const rest = cond.cards.filter((n) => !gone.has(n) && !reviewed.has(n))
  const steps: string[] = []
  if (released.length) steps.push(`drop ${released.length === 1 ? 'the first' : 'those'} from your list`)
  if (inReview.length) steps.push(`watch ${cards(inReview.map((w) => w.number))} again for ${inReview.length === 1 ? 'its' : 'their'} verdict (in a card loop, Hive wakes you with it); don't tell the user about ${inReview.length === 1 ? 'it' : 'them'}`)
  if (rest.length || !steps.length) steps.push(`${steps.length ? 'for the rest, ' : ''}tell the user (hive_notify) and ask what to do`)
  const todo = steps.join('; ')
  const ended = `No change on ${cards(cond.cards)} in ${dur}: your card watch has ended. `
  const tailOf = (full: boolean): string => `${ended}${inReview.length ? `${full ? inReview.map(wherePart).join('; ') : `${cards(inReview.map((w) => w.number))} ${inReview.length === 1 ? 'is' : 'are'} in Review`}. ` : ''}${todo[0].toUpperCase()}${todo.slice(1)}.`
  for (const full of [true, false]) {
    const head = released.length ? `${released.map((r) => releasedPart(r, full)).join('; ')}. ` : ''
    const line = `[Hive] ${head}${tailOf(full)}`
    if (jsonBytes(line) <= WAKE_MAX_BYTES) return line
  }
  return `[Hive] ${released.length ? `${cards(released.map((r) => r.number))} left your watch (reassigned, or reviewed by another). ` : ''}${tailOf(false)}`
}

const cards = (ns: number[]): string => ns.map((n) => `${cardRef(n)}`).join(', ')

/** What a watching agent shows (its header, tab, the Agent API): "Waiting for #12 → Review", "Waiting for #12, #13". */
export function watchLabel(cond: Pick<WatchCondition, 'cards' | 'column'>): string {
  return `Waiting for ${cards(cond.cards)}${cond.column ? ` → ${columnWord(cond.column)}` : ''}`
}

/** A condition from untrusted arguments, or an error saying what is wrong. */
export function readCondition(args: { cards?: unknown; changes?: unknown; until?: unknown; column?: unknown; fresh?: unknown }): WatchCondition | string {
  const raw = Array.isArray(args.cards) ? args.cards : []
  const ns = [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0)
  if (!ns.length || ns.length !== raw.length) return 'cards must be card numbers (at least one, no repeats)'
  if (ns.length > WATCH_MAX_CARDS) return `at most ${WATCH_MAX_CARDS} cards`
  const column = args.column
  if (column !== undefined && !COLUMNS.includes(column as TaskColumn)) return `column must be ${COLUMN_CHOICES}`
  const list = args.changes ?? args.until
  const given = list !== undefined && list !== 'any'
  // A column alone: arriving in it is all that counts. Otherwise the kinds listed (default: any).
  const changes = !given ? (column ? ['column'] : [...WATCH_CHANGES]) : Array.isArray(list) ? [...new Set(list)] : [list]
  if (!changes.length || changes.some((c) => !WATCH_CHANGES.includes(c as WatchChange))) return `changes must be any of ${WATCH_CHANGES.join(', ')}`
  if (column && !changes.includes('column')) return 'with column, changes must include "column" (or leave changes out to wait only for the card to be in that column)'
  if (args.fresh !== undefined && typeof args.fresh !== 'boolean') return 'fresh must be true or false'
  const fresh = args.fresh === true
  if (fresh && !column) return 'fresh needs a column: it waits for the next move into it'
  // A column with `column` named among the changes: a move into it, met at once by a card already there (#434). Fresh:
  // only the next move into it (a card already there waits for it to come back).
  const moveInto = !!column && (given || fresh)
  return { cards: ns, changes: changes as WatchChange[], ...(column ? { column: column as TaskColumn } : {}), ...(moveInto ? { moveInto: true as const } : {}), ...(fresh ? { fresh: true as const } : {}) }
}
