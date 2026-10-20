import { currentCard, laneCardState } from './laneBar'
import type { LaneCard, LaneInfo, LaneState, ProjectConfig, TaskCard, WorkspaceConfig } from './types'
import { cardRef } from './projectKeys'

/**
 * Lanes (#483): a builder and a reviewer taking a project's cards in order, as the card-loop skill registers them. What
 * a lane is made of, how it reads against the board now (its cards, the current one, paused or not), which lanes are
 * listed, and how a hive tool says so. Pure, so the service, the Agent API and tests share it.
 *
 * A lane is bookkeeping, never a gate: a loop runs the same without one (an older Hive, a failed registration), and a
 * solo agent working a card has none.
 */

/** A lane's agent: its id, and its name as last known (the project's agents give the current one). */
export interface LaneAgent {
  id: string
  name: string
}

/** A lane as kept (a row of the workspace's database, #1018; `.hive/lanes.json` before). Paused isn't kept: it is read from the board (the current card is blocked). */
export interface LaneRecord {
  id: string
  project: string
  name: string | null
  builder: LaneAgent
  reviewer: LaneAgent | null
  cards: number[]
  rounds: number
  waitMinutes: number
  state: 'active' | 'ended' | 'abandoned'
  startedBy: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  mergeCommit: string | null
  /**
   * Its cards as they were when it ended or was abandoned (#512), so it reads as it was left, not as the board has those
   * cards now (another lane may be working them). Missing for lanes ended before it was kept.
   */
  frozen?: LaneCard[]
}

/** At most this many cards in a lane, rounds per card, and minutes of wait (a day, as a card watch's longest). */
export const LANE_MAX_CARDS = 50
export const LANE_MAX_ROUNDS = 50
export const LANE_MAX_WAIT_MINUTES = 24 * 60

/** Card loops' rounds and wait when nothing says otherwise (#412: Darren's Rounds 10, Wait 6h). */
export const LOOP_ROUNDS = 10
export const LOOP_WAIT_HOURS = 6
/** The wait settings' range, in hours (a lane's wait is at most a day). */
export const LOOP_WAIT_MAX_HOURS = LANE_MAX_WAIT_MINUTES / 60

/**
 * A card loop's rounds and wait when its request doesn't say (#412): the project's (Project Settings → Card loops),
 * else the workspace's (Settings → Workspace → Card loops), else LOOP_ROUNDS and LOOP_WAIT_HOURS. A prompt's own values
 * win over all of them; lanes started without them get these.
 */
export function loopDefaults(ws?: Pick<WorkspaceConfig, 'loops'> | null, project?: Partial<Pick<ProjectConfig, 'loopRounds' | 'loopWaitHours'>> | null): { rounds: number; waitHours: number } {
  const ok = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max
  const pick = (own: unknown, shared: unknown, def: number, max: number): number => (ok(own, max) ? own : ok(shared, max) ? shared : def)
  return { rounds: pick(project?.loopRounds, ws?.loops?.rounds, LOOP_ROUNDS, LANE_MAX_ROUNDS), waitHours: pick(project?.loopWaitHours, ws?.loops?.waitHours, LOOP_WAIT_HOURS, LOOP_WAIT_MAX_HOURS) }
}
/** A lane's name, at most. */
export const LANE_NAME_MAX = 80
/** An ended lane stays listed this long (unless its builder starts another), and is kept in the file this long. */
export const LANE_LINGER_MS = 60 * 60_000
export const LANE_KEEP_MS = 24 * 60 * 60_000
/** At most this many lanes kept in a workspace: past it, the oldest ended ones go first. */
export const MAX_LANES = 200

const VERDICT_FAILED = /^Review failed/

/** Whether a lane is still running (active or paused). */
export const running = (l: Pick<LaneRecord, 'state'>): boolean => l.state === 'active'

/** A lane's card as the board has it (null: gone, archived, or in another project now). */
export function laneCard(n: number, card: TaskCard | null): LaneCard {
  if (!card) return { number: n, title: '', column: 'gone', blocked: null, round: 1, reviewing: false }
  return { number: n, title: card.title, column: card.column, blocked: card.blocked || null, round: card.history.filter((h) => VERDICT_FAILED.test(h.what)).length + 1, reviewing: !!card.review }
}

/** Whether a lane's card is finished for the loop: passed review, merged, or gone. */
const finished = (c: LaneCard): boolean => c.column === 'passed' || c.column === 'done' || c.column === 'gone'

/** Whether a lane reads its cards as it left them (ended or abandoned, with its snapshot) rather than from the board. */
export const isFrozen = (rec: Pick<LaneRecord, 'state' | 'frozen'>): boolean => !running(rec) && !!rec.frozen

/**
 * An ended lane's card with no record of where it was (#512): ended before Hive kept one, or the record didn't read back.
 * Only its title comes from the board; where it is now is another lane's business, never this one's history.
 */
const unrecordedCard = (n: number, card: TaskCard | null): LaneCard => ({ number: n, title: card?.title ?? '', column: 'unrecorded', blocked: null, round: 1, reviewing: false })

/**
 * A lane as it reads now: a running one's cards from the board (`cards`: each card, or null when gone or outside the
 * lane's project); an ended or abandoned one's as it left them (`frozen`), or `unrecorded` without that record, never
 * as the board has them now (#512). Its agents' names as the project has them now (`names`: by id; one missing keeps the
 * name last known). Its current card is the one being worked, and it is paused only while it waits for the user
 * (currentCard); an ended lane without its record has none.
 */
export function laneView(rec: LaneRecord, cards: ReadonlyMap<number, TaskCard | null>, names?: ReadonlyMap<string, string>): LaneInfo {
  const unrecorded = !running(rec) && !rec.frozen
  const list = isFrozen(rec) ? rec.frozen! : rec.cards.map((n) => (unrecorded ? unrecordedCard : laneCard)(n, cards.get(n) ?? null))
  const { current, waiting } = unrecorded ? { current: null, waiting: false } : currentCard(list.map((c) => ({ number: c.number, state: laneCardState(c), finished: finished(c) })))
  const state: LaneState = rec.state === 'active' && waiting ? 'paused' : rec.state
  const named = (a: LaneAgent): LaneAgent => ({ id: a.id, name: names?.get(a.id) ?? a.name })
  return {
    id: rec.id,
    project: rec.project,
    name: rec.name,
    builder: named(rec.builder),
    reviewer: rec.reviewer ? named(rec.reviewer) : null,
    cards: list,
    current,
    state,
    pausedOn: state === 'paused' ? current : null,
    rounds: rec.rounds,
    waitMinutes: rec.waitMinutes,
    startedBy: rec.startedBy,
    startedAt: rec.startedAt,
    updatedAt: rec.updatedAt,
    endedAt: rec.endedAt,
    mergeCommit: rec.mergeCommit
  }
}

/** Whether every card of a lane is merged (Done), so the lane has ended. Gone cards don't count against it. */
export const allDone = (cards: readonly LaneCard[]): boolean => cards.some((c) => c.column === 'done') && cards.every((c) => c.column === 'done' || c.column === 'gone')

/**
 * The lanes listed (the window's panel, the Agent API without `all`): running ones, and ended ones until their builder
 * starts another or LANE_LINGER_MS passes. Oldest first.
 */
export function listedLanes<T extends Pick<LaneRecord, 'state' | 'endedAt' | 'startedAt' | 'builder' | 'project'>>(lanes: readonly T[], now: number): T[] {
  const later = (l: T): boolean => lanes.some((o) => o !== l && o.project.toLowerCase() === l.project.toLowerCase() && o.builder.id === l.builder.id && o.startedAt > l.startedAt)
  return lanes.filter((l) => running(l) || (!!l.endedAt && now - Date.parse(l.endedAt) < LANE_LINGER_MS && !later(l))).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

/** Lanes worth keeping in the file: running ones, and ended ones for LANE_KEEP_MS; at most MAX_LANES (newest kept). */
export function keptLanes(lanes: readonly LaneRecord[], now: number): LaneRecord[] {
  const kept = lanes.filter((l) => running(l) || !l.endedAt || now - Date.parse(l.endedAt) < LANE_KEEP_MS)
  if (kept.length <= MAX_LANES) return kept
  const ended = kept.filter((l) => !running(l)).sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
  const drop = new Set(ended.slice(0, kept.length - MAX_LANES))
  return kept.filter((l) => !drop.has(l))
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const time = (v: unknown): v is string => text(v, 40) && Number.isFinite(Date.parse(v))
const agentOf = (v: unknown): LaneAgent | null => (isObj(v) && text(v.id, 128) && text(v.name, 200) ? { id: v.id, name: v.name } : null)
const whole = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max
const COLUMNS: readonly LaneCard['column'][] = ['hold', 'todo', 'doing', 'review', 'passed', 'done', 'gone']
const cardOf = (v: unknown): LaneCard | null =>
  isObj(v) && whole(v.number, 1e9) && typeof v.title === 'string' && v.title.length <= 1000 && COLUMNS.includes(v.column as LaneCard['column']) && (v.blocked === null || (typeof v.blocked === 'string' && v.blocked.length <= 2000)) && whole(v.round, 1000) && typeof v.reviewing === 'boolean'
    ? { number: v.number, title: v.title, column: v.column as LaneCard['column'], blocked: v.blocked as string | null, round: v.round, reviewing: v.reviewing }
    : null

/** A kept lane, checked (the file can be edited by hand); null if it isn't one. */
export function readLane(v: unknown): LaneRecord | null {
  if (!isObj(v) || !text(v.id, 64) || !text(v.project, 260)) return null
  const builder = agentOf(v.builder)
  const reviewer = v.reviewer === null ? null : agentOf(v.reviewer)
  if (!builder || (v.reviewer !== null && !reviewer)) return null
  const cards = v.cards
  if (!Array.isArray(cards) || !cards.length || cards.length > LANE_MAX_CARDS || !cards.every((n) => whole(n, 1e9)) || new Set(cards).size !== cards.length) return null
  if (!whole(v.rounds, LANE_MAX_ROUNDS) || !whole(v.waitMinutes, LANE_MAX_WAIT_MINUTES)) return null
  if (!['active', 'ended', 'abandoned'].includes(v.state as string)) return null
  if (!text(v.startedBy, 200) || !time(v.startedAt) || !time(v.updatedAt) || !(v.endedAt === null || time(v.endedAt))) return null
  if (v.state !== 'active' && v.endedAt === null) return null
  if (!(v.name === null || text(v.name, LANE_NAME_MAX)) || !(v.mergeCommit === null || text(v.mergeCommit, 64))) return null
  // Its snapshot, kept only when every card of it reads back (else it reads from the board, as before #512).
  const frozen = Array.isArray(v.frozen) && v.frozen.length === cards.length ? v.frozen.map(cardOf) : null
  const snapshot = frozen?.every((c, i) => c && c.number === cards[i]) ? (frozen as LaneCard[]) : null
  return {
    id: v.id,
    project: v.project,
    name: v.name as string | null,
    builder,
    reviewer,
    cards: cards as number[],
    rounds: v.rounds as number,
    waitMinutes: v.waitMinutes as number,
    state: v.state as LaneRecord['state'],
    startedBy: v.startedBy,
    startedAt: v.startedAt,
    updatedAt: v.updatedAt,
    endedAt: v.endedAt as string | null,
    mergeCommit: v.mergeCommit as string | null,
    ...(snapshot ? { frozen: snapshot } : {})
  }
}

/** The lanes in a lanes file's data; anything malformed is left out. */
export function readLanes(data: unknown): LaneRecord[] {
  const list = isObj(data) && Array.isArray(data.lanes) ? data.lanes : []
  const out: LaneRecord[] = []
  for (const v of list.slice(0, MAX_LANES * 2)) {
    const l = readLane(v)
    if (l && !out.some((o) => o.id === l.id)) out.push(l)
  }
  return out
}

/** A lane's cards, from untrusted arguments: whole card numbers, in order, no repeats, at least one. */
export function laneCards(v: unknown): number[] | string {
  if (!Array.isArray(v) || !v.length) return 'cards must be the card numbers, in order (at least one)'
  if (v.length > LANE_MAX_CARDS) return `at most ${LANE_MAX_CARDS} cards in a lane`
  if (!v.every((n) => whole(n, 1e9))) return 'cards must be card numbers'
  if (new Set(v).size !== v.length) return 'cards must not repeat'
  return v as number[]
}

/** A number of rounds or minutes from untrusted arguments (undefined: the default); a string says what's wrong. */
export function laneNumber(v: unknown, what: 'rounds' | 'waitMinutes', fallback: number): number | string {
  if (v === undefined || v === null) return fallback
  const max = what === 'rounds' ? LANE_MAX_ROUNDS : LANE_MAX_WAIT_MINUTES
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.round(v) < 1 || Math.round(v) > max) return `${what} must be from 1 to ${max}`
  return Math.round(v)
}

/** A lane's name from untrusted arguments: one line, trimmed, cut to LANE_NAME_MAX (null: none). */
export function laneName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = [...v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()]
  if (!t.length) return null
  return t.length > LANE_NAME_MAX ? `${t.slice(0, LANE_NAME_MAX - 1).join('')}…` : t.join('')
}

/** A wait in a few words: "6 h", "90 min". */
export const waitText = (minutes: number): string => (minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10} h` : `${minutes} min`)

const COLUMN_WORD: Record<LaneCard['column'], string> = { hold: 'On Hold', todo: 'Todo', doing: 'Doing', review: 'Review', passed: 'Passed', done: 'Done', gone: 'gone', unrecorded: 'not recorded' }

/** A lane's card in a few words: "#405 Review r2", "#412 Todo", "#402 Doing (blocked)". */
const cardWord = (c: LaneCard): string => `${cardRef(c.number)} ${COLUMN_WORD[c.column]}${c.round > 1 && c.column !== 'gone' && c.column !== 'unrecorded' ? ` r${c.round}` : ''}${c.blocked ? ' (blocked)' : ''}`

/**
 * A lane in one line, for the hive tools: "B1 / R1 (hive) lanes and loops: active, on #405; #483 Passed, #405 Review r2,
 * #412 Todo; rounds 10, wait 6 h. lane-3fa2".
 */
export function laneLine(l: LaneInfo): string {
  const pair = `${l.builder.name} / ${l.reviewer?.name ?? 'no reviewer'} (${l.project})`
  const state = l.state === 'paused' ? `paused, ${l.pausedOn !== null ? cardRef(l.pausedOn) : 'a card'} is blocked` : l.state === 'active' ? (l.current !== null ? `active, on ${cardRef(l.current)}` : 'active, every card passed') : l.state === 'ended' ? `ended${l.mergeCommit ? ` (merged ${l.mergeCommit})` : ''}` : 'abandoned'
  return `${pair}${l.name ? ` ${l.name}` : ''}: ${state}; ${l.cards.map(cardWord).join(', ')}; rounds ${l.rounds}, wait ${waitText(l.waitMinutes)}. ${l.id}`
}

/** A listing of lanes, a line each. */
export function lanesText(lanes: readonly LaneInfo[], all = false): string {
  if (!lanes.length) return all ? 'No lanes.' : 'No lanes running or recently ended.'
  return lanes.map(laneLine).join('\n')
}

/** What a start or join did, for the tool's reply. */
export type LaneChange = { lane: LaneInfo; did: 'started' | 'updated' | 'joined'; replaced?: LaneInfo | null; note?: string }

export function laneChangeText(r: LaneChange): string {
  const what = r.did === 'started' ? 'Lane started' : r.did === 'joined' ? 'Joined the lane' : 'Lane updated'
  const before = r.replaced ? ` Your earlier lane ${r.replaced.id} ${r.replaced.state === 'ended' ? 'ended' : 'was abandoned'}.` : ''
  return `${what}: ${laneLine(r.lane)}${before}${r.note ? ` ${r.note}` : ''}`
}

/** What an end did. */
export function laneEndText(l: LaneInfo): string {
  return `Lane ${l.state === 'ended' ? 'ended' : 'abandoned'}: ${laneLine(l)}`
}
