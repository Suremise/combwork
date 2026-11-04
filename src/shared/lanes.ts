import { currentCard, idleKey, laneCardState } from './laneBar'
import type { LaneCard, LaneInfo, LaneSlotInfo, LaneState, LaneStatus, LaneWaitReason, TaskCard } from './types'
import type { StageId } from './workflow/facts'
import { cardRef } from './projectKeys'
import { unsubmittedText, type UnsubmittedCard } from './unsubmitted'
import { agentMsg, say, type AgentMsg } from './agentText'

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

/** A lane as kept (a row of the workspace's database, #1018; `.combwork/lanes.json` before). Paused isn't kept: it is read from the board (the current card is blocked). */
/**
 * A lane agent's new conversation owed (HI-2034, LaneRecord `freshStart`). `id`: this obligation (a retry is a new one).
 * `oldSession`: the conversation it must leave (its session id when deferred; null when unknown). `launching`: when a
 * launch of it began (set under the lock just before it): one still set when Hive looks again (a crash in between) is
 * never launched again by itself, only proven done by a new conversation of the agent since then, else blocked as
 * `uncertain`. `blocked`: no more automatic tries (`timeout`: not free within the wait; `uncertain`; `failed`, with why)
 * until the user retries it.
 */
export interface FreshStart {
  id: string
  agent: string
  role: 'builder' | 'reviewer'
  since: string
  oldSession: string | null
  /** The note its brief was made with (Start Lane…'s, or a slot wait's): its launch's brief says the same. */
  note?: string
  launching?: string
  blocked?: { at: string; why: 'timeout' | 'uncertain' | 'failed'; message?: string }
}

/** Fresh starts as kept (HI-2034): malformed ones left out; at most one per role. */
function readFreshStarts(v: unknown): FreshStart[] | null {
  if (!Array.isArray(v)) return null
  const out: FreshStart[] = []
  for (const f of v.slice(0, 4)) {
    if (!isObj(f) || !text(f.id, 64) || !text(f.agent, 128) || (f.role !== 'builder' && f.role !== 'reviewer') || !time(f.since) || out.some((x) => x.role === f.role)) continue
    const b = isObj(f.blocked) && time(f.blocked.at) && (f.blocked.why === 'timeout' || f.blocked.why === 'uncertain' || f.blocked.why === 'failed') ? f.blocked : null
    out.push({
      id: f.id as string,
      agent: f.agent as string,
      role: f.role,
      since: f.since as string,
      oldSession: text(f.oldSession, 128) ? (f.oldSession as string) : null,
      ...(typeof f.note === 'string' && f.note ? { note: f.note.slice(0, 4000) } : {}),
      ...(time(f.launching) ? { launching: f.launching as string } : {}),
      ...(b ? { blocked: { at: b.at as string, why: b.why as 'timeout' | 'uncertain' | 'failed', ...(typeof b.message === 'string' ? { message: b.message.slice(0, 500) } : {}) } } : {})
    })
  }
  return out.length ? out : null
}

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
  /**
   * Hive owns the lane (#1270, SPEC §16.11): the ruleset in force when it started (its cards, Todo ones too, use it until
   * it ends), a list change made while a card was in flight (applied at the next card boundary), and the runtime's card
   * in flight. Each only when set; kept in `lane_runs` and `lane_pending`.
   */
  ruleset?: string
  pending?: number[]
  inFlight?: number
  /**
   * Started from the window with no slot free (#1438, §16.10.2): its agents start once one is lent to it, with the user's
   * note in their brief. Kept with the lane (its row's `extra`), so it waits through a restart; cleared once it starts.
   * `stoppedOnly`: recorded by the Assistant or a script (HI-1934), so only its agents stopped then are started.
   */
  slotWait?: { since: string; note: string; stoppedOnly?: true }
  /**
   * The lane's agents still owed their new conversation (HI-2034): its start found one in a turn or with a prompt it
   * hadn't taken yet, so it is launched once free (laneStarts.ts' pass), within `hive.lanes.freshStartWaitMinutes`.
   * Kept with the lane (its row's `extra`), changed only under the lanes' lock. While its builder's is here, Hive gives
   * the builder no card (never into the old conversation).
   */
  freshStart?: FreshStart[]
  /**
   * The lane's brief for its builder (HI-1795: `cw_lane start`'s `brief`), kept with the lane (its row's `extra`).
   * `text` null: cleared. `rev` goes up at each change of text and each clear, never reused. In slots, every placement
   * of the lane's cards carries the text as it is then; outside slots it is delivered once per rev, and `out` is the rev
   * whose delivery has been made (the intent recorded: one owed is made by the next look, a crash between kept).
   */
  brief?: { text: string | null; rev: number; out: number | null; notIn?: string }
  /**
   * Reviewed by the project's reviewer pool (#1443, G17): no reviewer of its own (`reviewer` null); each card submitted is
   * given to the next free pooled reviewer. Kept with the lane (its row's `extra`).
   */
  pool?: true
}

// The limits and defaults (loopLimits.ts). A loop's rounds, wait and design check wait when its request doesn't say are
// the project's workflow options since HI-1766 (workflow/preferences.ts); a prompt's own values win over them.
import { LANE_MAX_CARDS, LANE_MAX_ROUNDS, LANE_MAX_WAIT_MINUTES } from './loopLimits'
export { LANE_MAX_CARDS, LANE_MAX_ROUNDS, LANE_MAX_WAIT_MINUTES, LOOP_ROUNDS, LOOP_STEP_WAIT_MAX_MINUTES, LOOP_STEP_WAIT_MINUTES, LOOP_WAIT_HOURS, LOOP_WAIT_MAX_HOURS } from './loopLimits'

/** The longest brief a lane keeps for its builder (HI-1795), in characters. */
export const LANE_BRIEF_MAX = 4000

/**
 * A lane's brief after a start that gives `brief` (HI-1795): undefined keeps it as it is (a list change, a reviewer's
 * join); '' (or only spaces) clears it; a text replaces it. A change of text, or a clear, takes the next rev (never one
 * used before, a clear's included); the same text changes nothing, so nothing is given again. `notIn` (a new lane's
 * only): the builder's conversation running as its lane began, which outside slots its brief is never offered into (the
 * next one gets it); an edit keeps the one its lane began with and never takes another, so an edited brief reaches the
 * lane's working conversation.
 */
export function nextBrief(was: LaneRecord['brief'], brief: string | undefined, notIn?: string | null): LaneRecord['brief'] {
  if (brief === undefined) return was
  const text = brief.trim() ? brief.trim().slice(0, LANE_BRIEF_MAX) : null
  if (!was) return text === null ? undefined : { text, rev: 1, out: null, ...(notIn ? { notIn } : {}) }
  if (was.text === text) return was
  // An edit keeps the exclusion its lane began with (HR4's HI-1795 round 2): never one of the lane's working conversation.
  return { text, rev: was.rev + 1, out: was.out, ...(was.notIn ? { notIn: was.notIn } : {}) }
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

/** Whether an agent builds a card as a running lane's builder in its project (HI-2047: its start names card-loop). */
export const laneBuilds = (lanes: readonly Pick<LaneRecord, 'state' | 'project' | 'builder' | 'cards'>[], project: string, agentId: string, card: number): boolean =>
  lanes.some((l) => running(l) && l.project.toLowerCase() === project.toLowerCase() && l.builder.id === agentId && l.cards.includes(card))

/**
 * A lane's card as the board has it (null: gone, archived, or in another project now). `of`: the running lane it is read
 * for, so an open card that isn't its own is marked held elsewhere (HI-1821): given to another agent than its builder,
 * or given to none and owned by another lane (`owner`: main's cardOwnersNow, the running lane listing it that owns it).
 */
export function laneCard(n: number, card: TaskCard | null, of?: { lane: string; builder: string; owner?: string | null }): LaneCard {
  if (!card) return { number: n, title: '', column: 'gone', blocked: null, round: 1, reviewing: false }
  const elsewhere = !of || card.column === 'done' ? null : card.agent ? (card.agent !== of.builder ? card.agent : null) : of.owner && of.owner !== of.lane ? of.owner : null
  return { number: n, title: card.title, column: card.column, blocked: card.blocked || null, round: card.history.filter((h) => VERDICT_FAILED.test(h.what)).length + 1, reviewing: !!card.review, ...(elsewhere ? { elsewhere } : {}) }
}

/** Whether a lane's card is finished for the loop: passed review, merged, or gone. */
const finished = (c: LaneCard): boolean => c.column === 'passed' || c.column === 'done' || c.column === 'gone'

/** Whether a lane's card is the lane's own work now: open and not held by another agent (HI-1821). */
export const ownOpen = (c: LaneCard): boolean => c.column !== 'done' && c.column !== 'gone' && c.column !== 'unrecorded' && !c.elsewhere

/**
 * A running lane's card for Hive to start on its builder (HI-1990), or null: the first of its own open cards, in Todo
 * and not blocked, in an active lane (every card before it Done or another lane's). Its first card too (HI-2029: a lane
 * started over a running builder never had it started, and read "active" for hours); a builder starting it itself, in
 * the turn it registers its lane, is never free in between, and its own start of one Hive started is that start.
 */
export function laneStartDue(lane: Pick<LaneInfo, 'state' | 'cards'>): LaneCard | null {
  if (lane.state !== 'active') return null
  const at = lane.cards.findIndex(ownOpen)
  if (at < 0) return null
  const c = lane.cards[at]
  return c.column === 'todo' && !c.blocked ? c : null
}

/**
 * Why a lane's card due to start (laneStartDue) isn't started yet (HI-2029), as laneStarts.ts finds it: its builder in a
 * turn or starting (`busy`), waiting on a watch of other work (`watching`), a line of Hive's on its way to it (`queued`),
 * its last start failed (`failed`), Hive's start refused for now and tried again (`refused`), or a card it depends on
 * not Done yet where its rules wait for that (`dependencies`, HI-2129: `waitsFor` names it).
 */
export type LaneStartWhy = 'busy' | 'watching' | 'queued' | 'failed' | 'refused' | 'fresh' | 'dependencies'
/** A lane's card waiting to be started, why, and its builder's name (LaneStatus `startWait`). */
export interface LaneStartWait {
  card: number
  why: LaneStartWhy
  agent: string
  /** `dependencies`: the card it waits for, by its key. */
  waitsFor?: string
  /** `refused` (HI-2468): the slot its start was refused as held, and what holds it (as a lane waiting for a slot says it). */
  held?: LaneSlotHeld
}

/**
 * The free slot a lane waiting for a slot was last refused as held (HI-2466), and what holds it: a session (`agent`,
 * its agent's name) or a process (a file or folder in it open). Hive tries the lend again until it is free. `broker`
 * (HI-2467): a process, and Windows Sandbox's broker (`broker`: its process name) was seen working in it, a Sandbox
 * running or not (`idle`; absent: not known).
 */
export interface LaneSlotHeld {
  slot: string
  /**
   * HI-2468, a refused start's: `left`, programs the last run of `agent` left running there (`program`, the first by
   * name, and `more` beyond it); `lastRun`, that run of `agent`'s not known to have ended.
   */
  held: 'session' | 'process' | 'broker' | 'left' | 'lastRun'
  agent?: string
  broker?: string
  idle?: boolean
  program?: string
  more?: number
}

/**
 * A held slot as a refused start's status carries it (HI-2468): the slot, what holds it, and the agent whose session
 * is in it as `heldBy` (the status's `agent` is the builder there), with the broker seen in it, if any.
 */
const heldStatus = (h: LaneSlotHeld): Pick<LaneStatus, 'slot' | 'held' | 'heldBy' | 'broker' | 'idle' | 'program' | 'more'> => ({ slot: h.slot, held: h.held, ...(h.agent ? { heldBy: h.agent } : {}), ...(h.broker ? { broker: h.broker } : {}), ...(h.idle !== undefined ? { idle: h.idle } : {}), ...(h.program ? { program: h.program } : {}), ...(h.more ? { more: h.more } : {}) })

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
 * (currentCard); an ended lane without its record has none. A card held elsewhere (HI-1821: another agent's, or, given
 * to none, another lane's: `owners`, main's owner lane by card) is never its current card nor why it waits.
 */
export function laneView(rec: LaneRecord, cards: ReadonlyMap<number, TaskCard | null>, names?: ReadonlyMap<string, string>, facts?: ReadonlyMap<number, LaneCardFacts> | null, atLimit?: ReadonlySet<number>, line?: number | null, hooksOut?: ReadonlySet<string>, rulesetNow?: string | null, rulesetStages?: StageId[] | null, slot?: { slot: string | null; waiting: boolean; info?: LaneSlotInfo | null; held?: LaneSlotHeld | null } | null, owners?: ReadonlyMap<number, string | null>, startWait?: LaneStartWait | null, teamPaused = false): LaneInfo {
  const unrecorded = !running(rec) && !rec.frozen
  // A card at its round limit waits for the user's answer (§16.11.4, `atLimit`: the main side's facts): it pauses the lane.
  const live = (n: number): LaneCard => ({ ...laneCard(n, cards.get(n) ?? null, { lane: rec.id, builder: rec.builder.id, owner: owners?.get(n) }), ...(atLimit?.has(n) ? { roundLimit: true } : {}) })
  const list = isFrozen(rec) ? rec.frozen! : rec.cards.map((n) => (unrecorded ? unrecordedCard(n, cards.get(n) ?? null) : live(n)))
  const { current, waiting } = unrecorded ? { current: null, waiting: false } : currentCard(list.map((c) => ({ number: c.number, state: laneCardState(c), finished: finished(c) || !!c.elsewhere })))
  // Its next card waiting while its builder's branch is brought up to date (§16.19.2, `line`: the main side's), when
  // nothing more pressing says why.
  const named = (a: LaneAgent): LaneAgent => ({ id: a.id, name: names?.get(a.id) ?? a.name })
  const found = running(rec) ? laneStatus(rec, list, current, waiting, facts ?? null) : null
  // Its builder's or reviewer's hooks not arriving (#1336, `hooksOut`: the main side's, by agent id) pauses it: nothing
  // is typed into that agent. Only what already waits for the user says more.
  const deaf = running(rec) && !unrecorded ? [rec.builder, rec.reviewer].find((a): a is LaneAgent => !!a && !!hooksOut?.has(a.id)) : undefined
  const hooks = deaf && !(found && USERS.has(found.reason)) ? { reason: 'hooks' as const, card: current, agent: named(deaf).name } : null
  // Waiting for a slot (#1438, `slot`: the main side's): lent none yet, so nothing of it can start; only what already
  // waits for the user, or its hooks, says more. A free slot held (HI-2466): which, and what holds it.
  const held = slot?.held ?? null
  const noSlot = running(rec) && !unrecorded && slot?.waiting && !(found && USERS.has(found.reason)) ? { reason: 'slot' as const, card: current, ...(held ? { slot: held.slot, held: held.held, ...(held.agent ? { agent: held.agent } : {}), ...(held.broker ? { broker: held.broker } : {}), ...(held.idle !== undefined ? { idle: held.idle } : {}) } : {}) } : null
  // Its slot being prepared (#1446: G15's warming, its setup or an install): said when nothing else is, never pausing.
  const preparing = running(rec) && !unrecorded && slot?.info?.state === 'preparing' ? { reason: 'preparing' as const, card: current, slot: slot.info.name } : null
  // Its card due to start and not started yet (HI-2029, laneStarts.ts: `startWait`), only while that card is the current
  // one and nothing else says why the lane waits: never "active" with its card untouched and nothing said. Not a pause.
  const waitsStart = running(rec) && !unrecorded && startWait && startWait.card === current && list.find((c) => c.number === current)?.column === 'todo' ? { reason: 'startWait' as const, card: startWait.card, why: startWait.why, agent: startWait.agent, ...(startWait.waitsFor ? { waitsFor: startWait.waitsFor } : {}), ...(startWait.why === 'refused' && startWait.held ? heldStatus(startWait.held) : {}) } : null
  // An agent still owed its new conversation (HI-2034, `freshStart`; its builder's first): said while Hive waits for it
  // to be free, and before anything else but its hooks and its slot once no more is tried (the user retries it or ends
  // the lane). Not a pause.
  const owed = running(rec) && !unrecorded ? (rec.freshStart?.find((f) => f.role === 'builder') ?? rec.freshStart?.[0] ?? null) : null
  const freshName = owed ? (owed.role === 'builder' ? rec.builder.name : (rec.reviewer?.name ?? owed.agent)) : ''
  const fresh = owed ? { reason: 'startWait' as const, card: current, why: 'fresh' as const, agent: freshName, ...(owed.blocked ? { freshBlocked: owed.blocked.why, ...(owed.blocked.message ? { freshWhy: owed.blocked.message } : {}) } : {}) } : null
  // Its workspace's team paused (HI-2081, `teamPaused`: main's): before anything else, as nothing of it moves until it resumes.
  const pausedTeam = running(rec) && !unrecorded && teamPaused ? { reason: 'teamPause' as const, card: current } : null
  const status = running(rec) ? (pausedTeam ?? hooks ?? noSlot ?? (fresh?.freshBlocked ? fresh : null) ?? found ?? (line != null ? { reason: 'lineUpdate' as const, card: line } : null) ?? fresh ?? waitsStart ?? preparing) : null
  // Reviewed by the pool (#1443): who gave its current card's last verdict, and who reviews it now (#1446), by name.
  const now = rec.pool && running(rec) && current !== null ? facts?.get(current) : undefined
  const agentName = (id: string): string => names?.get(id) ?? (rec.builder.id === id ? rec.builder.name : id)
  const state: LaneState = rec.state === 'active' && status && PAUSING.has(status.reason) ? 'paused' : rec.state
  return {
    id: rec.id,
    project: rec.project,
    name: rec.name,
    builder: named(rec.builder),
    reviewer: rec.reviewer ? named(rec.reviewer) : null,
    ...(rec.pool ? { pool: true } : {}),
    cards: list,
    current,
    state,
    pausedOn: state === 'paused' ? (status?.card ?? current) : null,
    rounds: rec.rounds,
    waitMinutes: rec.waitMinutes,
    startedBy: rec.startedBy,
    startedAt: rec.startedAt,
    updatedAt: rec.updatedAt,
    endedAt: rec.endedAt,
    mergeCommit: rec.mergeCommit,
    status,
    queued: running(rec) && rec.pending ? [...rec.pending] : null,
    oldRules: laneOldRules(rec, rulesetNow),
    stages: running(rec) && rec.ruleset && rulesetStages ? [...rulesetStages] : null,
    slot: running(rec) ? (slot?.slot ?? null) : null,
    slotInfo: running(rec) ? (slot?.info ?? null) : null,
    ...(now ? { poolReview: { lastVerdict: now.lastVerdict ? { name: agentName(now.lastVerdict.reviewer), pass: now.lastVerdict.pass } : null, reviewing: now.reviewing ? agentName(now.reviewing) : null } } : {})
  }
}

/**
 * Whether a lane runs under old rules (#1421, §16.5.4): running, with a ruleset recorded when it started (none from
 * before 1.0, nor while rules weren't enforced) that isn't its project's now (`now`: main's; none known, no mark).
 */
export const laneOldRules = (rec: Pick<LaneRecord, 'state' | 'ruleset'>, now: string | null | undefined): boolean => running(rec) && !!rec.ruleset && !!now && rec.ruleset !== now

/** What a lane's status reads of a card's facts (#1270): its stage, an open request for you, a stale pass, its rounds. */
export interface LaneCardFacts {
  stage: StageId
  forYou: boolean
  /** What the user is asked for (the first open request's kind), while forYou. */
  ask?: LaneStatus['ask']
  stale: boolean
  rounds: number
  /** Its last verdict's reviewer (an agent's id, or `user`) and whether it passed (#1446: a pool lane's hover). */
  lastVerdict?: { reviewer: string; pass: boolean } | null
  /** Who reviews its latest submission now (given or started, no verdict yet), by id (#1446). */
  reviewing?: string | null
  /** A Done card whose slot stayed on its line with uncommitted changes (HI-2014): the lane's next card waits for it. */
  slotDirty?: boolean
  /** A pool lane's card in Doing whose design waits for the pool to give it to a reviewer (HI-2310). */
  designWaits?: boolean
}

/** The reasons that pause a lane: it can't go on to its next card until they clear. */
const PAUSING: ReadonlySet<LaneWaitReason> = new Set(['blocked', 'hold', 'you', 'roundLimit', 'notMerged', 'merging', 'hooks', 'slot', 'teamPause'])
/** The reasons that already wait for the user: they say more than an agent's hooks not arriving (#1336). */
const USERS: ReadonlySet<LaneWaitReason> = new Set(['blocked', 'hold', 'you', 'roundLimit'])

/**
 * Why a running lane waits (#1270, SPEC §16.11.4), most pressing first: its card blocked or On Hold (with no other being
 * worked), a request for you, the round limit, the card before the next one passed but not merged (§16.11.2: one card
 * at a time), its pass gone stale, a card in Review nobody reviews, a list change queued. `facts` (the cards' fold) only
 * while workflow rules are enforced: without them, only a blocked or held card says why, as before 1.0.
 */
export function laneStatus(rec: Pick<LaneRecord, 'rounds' | 'pending'>, cards: readonly LaneCard[], current: number | null, waiting: boolean, facts: ReadonlyMap<number, LaneCardFacts> | null): LaneStatus | null {
  // Another agent's card isn't the lane's to wait on (HI-1821).
  const open = cards.filter(ownOpen)
  if (!open.length) return null
  if (waiting && current !== null) {
    const c = open.find((x) => x.number === current)!
    if (c.column === 'hold') return { reason: 'hold', card: c.number }
    // Its round limit's question open (§16.11.4, #1269): it waits for the user's answer.
    if (c.roundLimit && !c.blocked) return { reason: 'roundLimit', card: c.number }
    return { reason: 'blocked', card: c.number, ...(c.blocked ? { blocked: c.blocked } : {}) }
  }
  if (!facts) return null
  // A finished card's slot not safe to go on in (HI-2014: uncommitted changes kept it on its line): the user is asked.
  const unsafe = cards.find((c) => c.column === 'done' && facts.get(c.number)?.slotDirty)
  if (unsafe) return { reason: 'you', card: unsafe.number, ask: 'decide' }
  // The card the lane waits on: the first not Done when it has passed (merging next), else the one being worked.
  const focus = open[0].column === 'passed' ? open[0] : (open.find((c) => c.number === current) ?? open[0])
  const f = facts.get(focus.number)
  if (f?.forYou) return { reason: 'you', card: focus.number, ...(f.ask ? { ask: f.ask } : {}) }
  // Waiting for a merge only while a card after it waits to start: with every card passed, the lane's merge is due.
  if (focus.column === 'passed' && open.some((c) => c.column !== 'passed')) return { reason: f?.stage === 'merging' ? 'merging' : 'notMerged', card: focus.number }
  if (f?.stale) return { reason: 'stale', card: focus.number }
  if (focus.column === 'review' && !focus.reviewing) return { reason: 'reviewer', card: focus.number }
  // A pool lane's design nobody has taken yet (HI-2310): waiting for a reviewer too.
  if (focus.column === 'doing' && f?.designWaits) return { reason: 'reviewer', card: focus.number }
  // A queued change waits for its own card in flight, through Review and Approved until it is Done (HI-1821), never
  // for the card the lane would be on next.
  const anchor = open.find((c) => c.column === 'doing' || c.column === 'review' || c.column === 'passed')
  if (rec.pending && anchor) return { reason: 'listChanges', card: anchor.number }
  return null
}

/** A lane's wait as main last saw it (HI-1926): its key (reason, card, ask), when it began, and whether that was seen. */
export interface WaitStamp {
  key: string
  since: number
  observed: boolean
}

/** What makes a wait the same wait: its reason, its card and what the user is asked for; nothing else on the card. */
export const waitKey = (s: LaneStatus): string => `${s.reason}|${s.card ?? ''}|${s.ask ?? ''}`

/**
 * A lane's wait stamp now (HI-1926): kept while its key stays the same (a comment or an edit on the card changes
 * nothing), a new one when the reason, card or ask changes, none when it doesn't wait. `known`: the lane was listed
 * before (with or without a wait): a wait that begins then was seen to begin; the first listing's wait wasn't.
 */
export function stampWait(was: WaitStamp | undefined, status: LaneStatus | null, now: number, known: boolean): WaitStamp | undefined {
  if (!status) return undefined
  const key = waitKey(status)
  if (was && was.key === key) return was
  return { key, since: now, observed: known }
}

/**
 * What the hive tools say of lanes (dialects, HI-2435): a lane's line, its state and why it waits, and the replies of
 * cw_lane. Said where the text is sent (hive-mcp.js formats these replies in its own process, with its session's
 * dialect); `{card}` is a card's key or number, `{agent}` an agent's name.
 */
const L = {
  aCard: agentMsg({ id: 'lane.status.aCard', text: 'a card', note: 'Where a lane waits on no particular card: put in place of {card} in the lines below.' }),
  anAgent: agentMsg({ id: 'lane.status.anAgent', text: 'an agent', note: "Where the agent whose hooks aren't arriving isn't known: put in place of {agent}." }),
  itsAgent: agentMsg({ id: 'lane.status.itsAgent', text: 'its agent', note: "Where the agent owed a new conversation isn't known by name: put in place of {agent}." }),
  itsBuilder: agentMsg({ id: 'lane.status.itsBuilder', text: 'its builder', note: "Where the lane's builder isn't known by name: put in place of {agent}." }),
  itsSlot: agentMsg({ id: 'lane.status.itsSlot', text: 'its slot', note: "Where the slot being prepared isn't known by name: put in place of {slot}." }),
  aDependency: agentMsg({ id: 'lane.status.aDependency', text: 'a card it depends on', note: "Where the card a lane's next card waits for isn't known: put in place of {waitsFor}." }),
  blocked: agentMsg({ id: 'lane.status.blocked', text: '{card} is blocked', note: "A lane waits: its card is blocked (the user's to unblock), no reason given." }),
  blockedWhy: agentMsg({ id: 'lane.status.blockedWhy', text: '{card} is blocked ({why})', note: "A lane waits: its card is blocked; {why} is the card's blocked reason, as given." }),
  hold: agentMsg({ id: 'lane.status.hold', text: '{card} is On Hold', note: 'A lane waits: its card is On Hold (a column name).' }),
  you: agentMsg({ id: 'lane.status.you', text: 'waiting for the user on {card}', note: 'A lane waits: a request on its card waits for the user (For you).' }),
  roundLimit: agentMsg({ id: 'lane.status.roundLimit', text: '{card} reached the round limit: waiting for the user', note: "A lane waits: its card failed review as many times as the lane's rounds allow; the user decides (§16.11.4)." }),
  notMerged: agentMsg({ id: 'lane.status.notMerged', text: 'waiting: {card} not merged', note: 'A lane waits: its card passed but is not merged yet; a lane takes one card at a time (§16.11.2).' }),
  merging: agentMsg({ id: 'lane.status.merging', text: 'waiting: {card} merging', note: 'A lane waits: its passed card is being merged.' }),
  stale: agentMsg({ id: 'lane.status.stale', text: 'stale: {card} must be submitted again', note: "A lane's card's pass no longer holds (its work changed since): it is submitted again." }),
  reviewer: agentMsg({ id: 'lane.status.reviewer', text: 'waiting for a reviewer on {card}', note: 'A lane waits: its card is in Review, or its design waits, and nobody reviews it yet.' }),
  lineUpdate: agentMsg({ id: 'lane.status.lineUpdate', text: "waiting: bringing the builder's branch up to date before {card}", note: "A lane's next card waits while its builder's branch is brought up to date (§16.19.2)." }),
  listChanges: agentMsg({ id: 'lane.status.listChanges', text: 'list changes after {card}', note: "A change of the lane's card list is queued: it applies once {card}, the card in flight, is Done." }),
  hooks: agentMsg({ id: 'lane.status.hooks', text: "paused: {agent}'s hooks aren't arriving", note: "A lane pauses while its builder's or reviewer's hooks aren't arriving (#1336): nothing is typed into that agent." }),
  checkCopy: agentMsg({ id: 'lane.status.checkCopy', text: 'waiting for a check copy for {card}', note: "A lane waits for a check copy (a copy at the card's revision for its checks)." }),
  slot: agentMsg({ id: 'lane.status.slot', text: 'waiting for a slot', note: 'A lane started with no slot free waits for one to be lent to it (#1438).' }),
  slotHeld: agentMsg({ id: 'lane.status.slotHeld', text: "waiting for {slot}: {held, select, session {{agent}'s session is still in it} broker {a process still has a file or folder in it open: Windows Sandbox's broker ({broker}) is working in it{idle, select, yes {, with no Sandbox running} no {, with a Sandbox running} other {}}} other {a process still has a file or folder in it open}}", note: "HI-2466: a lane waiting for a slot, the only free one ({slot}) held: a session of the agent {agent} still runs in it, or (other) a process holds it. broker (HI-2467): a process holds it, and Windows Sandbox's broker ({broker}: its process name, such as WindowsSandboxServer) has the slot as its current folder; idle: yes, no Sandbox runs; no, one does; other, not known. Hive tries again until it is free." }),
  teamPause: agentMsg({ id: 'lane.status.teamPause', text: 'paused: the team is pausing', note: "The workspace's team is paused (before an update, HI-2081): nothing of a lane moves until it resumes." }),
  preparing: agentMsg({ id: 'lane.status.preparing', text: 'waiting: preparing {slot}', note: "A lane's slot is being prepared (warming, its setup or an install, #1446); {slot} is its name." }),
  freshTimeout: agentMsg({ id: 'lane.status.fresh.timeout', text: "{agent}'s new conversation didn't start (it wasn't free in time): retry it from the lane's row, or end the lane", note: "An agent owed a new conversation for its lane (HI-2034) wasn't free within the wait: no more automatic tries until the user retries it." }),
  freshUncertain: agentMsg({ id: 'lane.status.fresh.uncertain', text: "{agent}'s new conversation didn't start (Combwork closed as it started): retry it from the lane's row, or end the lane", note: 'An agent owed a new conversation (HI-2034) was being launched when Hive closed: never launched again by itself.' }),
  freshFailed: agentMsg({ id: 'lane.status.fresh.failed', text: "{agent}'s new conversation didn't start ({why}): retry it from the lane's row, or end the lane", note: "An agent's new conversation for its lane (HI-2034) failed to launch; {why} is why, as recorded." }),
  freshFailedBare: agentMsg({ id: 'lane.status.fresh.failedBare', text: "{agent}'s new conversation didn't start (its start failed): retry it from the lane's row, or end the lane", note: "An agent's new conversation for its lane (HI-2034) failed to launch, with no reason recorded." }),
  freshWaits: agentMsg({ id: 'lane.status.fresh.waits', text: 'waiting: {agent} starts in a new conversation once it is free', note: 'An agent is owed a new conversation for its lane (HI-2034): Hive launches it once the agent is free.' }),
  startDependencies: agentMsg({ id: 'lane.status.start.dependencies', text: '{card} waits to start: it waits for {waitsFor} to merge', note: "A lane's next card waits for a card it depends on to be merged (HI-2129); {waitsFor} is that card's key." }),
  startWatching: agentMsg({ id: 'lane.status.start.watching', text: '{card} waits to start: {agent} is waiting on other work', note: "A lane's next card isn't started yet (HI-2029): its builder waits on a watch of other cards." }),
  startQueued: agentMsg({ id: 'lane.status.start.queued', text: "{card} waits to start: a line of Combwork's is on its way to {agent}", note: "A lane's next card isn't started yet (HI-2029): a line Hive types is on its way to the builder." }),
  startFailed: agentMsg({ id: 'lane.status.start.failed', text: "{card} waits to start: {agent}'s last start failed", note: "A lane's next card isn't started yet (HI-2029): Hive's last start of it on the builder failed." }),
  startRefusedHeld: agentMsg({ id: 'lane.status.start.refusedHeld', text: "{card} waits to start: its start was refused for now, {slot} still in use ({held, select, session {{heldBy}'s session is still in it} left {{heldBy}'s last run left {program}{more, plural, =0 {} other { and # more}} running in it} lastRun {{heldBy}'s last run there isn't known to have ended} broker {a process still has a file or folder in it open: Windows Sandbox's broker ({broker}) is working in it{idle, select, yes {, with no Sandbox running} no {, with a Sandbox running} other {}}} other {a process still has a file or folder in it open}}); Combwork tries again", note: "A lane's next card isn't started yet (HI-2468): Hive's start of it was refused because its slot {slot} is still in use: a session of the agent {heldBy} still runs in it; left, the agent {heldBy}'s last run left programs running in it ({program}: the first one's name, such as node; {more}: how many more); lastRun, that run isn't known to have ended; or (broker) a process holds it, and Windows Sandbox's broker ({broker}: its process name) has the slot as its current folder, idle: yes, no Sandbox runs; no, one does; other, not known; or (other) a process holds it. Hive tries the start again." }),
  startRefused: agentMsg({ id: 'lane.status.start.refused', text: '{card} waits to start: its start was refused for now; Combwork tries again', note: "A lane's next card isn't started yet (HI-2029): Hive's start of it was refused for now, and is tried again." }),
  startBusy: agentMsg({ id: 'lane.status.start.busy', text: '{card} waits to start: {agent} is in a turn', note: "A lane's next card isn't started yet (HI-2029): its builder is in a turn, or starting." }),
  column: {
    hold: agentMsg({ id: 'lane.column.hold', text: 'On Hold', note: "A card's column in a lane's line (a column name)." }),
    todo: agentMsg({ id: 'lane.column.todo', text: 'Todo', note: "A card's column in a lane's line (a column name)." }),
    doing: agentMsg({ id: 'lane.column.doing', text: 'Doing', note: "A card's column in a lane's line (a column name)." }),
    review: agentMsg({ id: 'lane.column.review', text: 'Review', note: "A card's column in a lane's line (a column name)." }),
    passed: agentMsg({ id: 'lane.column.passed', text: 'Passed', note: "A card's column in a lane's line (a column name)." }),
    done: agentMsg({ id: 'lane.column.done', text: 'Done', note: "A card's column in a lane's line (a column name)." }),
    gone: agentMsg({ id: 'lane.column.gone', text: 'gone', note: "A lane's card that is gone (deleted, archived, or in another project now), in the lane's line." }),
    unrecorded: agentMsg({ id: 'lane.column.unrecorded', text: 'not recorded', note: "An ended lane's card with no record of where it was when the lane ended (#512), in the lane's line." })
  } satisfies Record<LaneCard['column'], AgentMsg>,
  cardRound: agentMsg({ id: 'lane.card.round', text: 'r{round}', note: "A lane's card's review round, after its column in the lane's line (\"#405 Review r2\")." }),
  cardBlocked: agentMsg({ id: 'lane.card.blocked', text: '(blocked)', note: "A lane's card that is blocked, after its column in the lane's line (\"#402 Doing (blocked)\")." }),
  pair: agentMsg({ id: 'lane.line.pair', text: '{builder} / {reviewer} ({project})', note: "A lane's builder and reviewer, and its project, at the start of its line." }),
  pairInSlot: agentMsg({ id: 'lane.line.pairInSlot', text: '{builder} / {reviewer} ({project}, in {slot})', note: "A lane's builder and reviewer, its project and the slot its cards are built in (#1438), at the start of its line." }),
  pool: agentMsg({ id: 'lane.line.pool', text: 'the reviewer pool', note: "In place of {reviewer}: the lane is reviewed by the project's reviewer pool (#1443)." }),
  noReviewer: agentMsg({ id: 'lane.line.noReviewer', text: 'no reviewer', note: 'In place of {reviewer}: the lane has no reviewer yet.' }),
  line: agentMsg({ id: 'lane.line.text', text: '{pair}: {state}; {cards}; rounds {rounds}, wait {wait}. {id}', note: 'A lane in one line, for the hive tools: "B1 / R1 (hive): active, on #405; #483 Passed, #405 Review r2; rounds 10, wait 6 h. lane-3fa2". {cards}: its cards, each "key column"; {id}: the lane\'s id.' }),
  lineNamed: agentMsg({ id: 'lane.line.named', text: '{pair} {name}: {state}; {cards}; rounds {rounds}, wait {wait}. {id}', note: "A lane in one line, as lane.line.text, with the lane's own name ({name})." }),
  hours: agentMsg({ id: 'lane.wait.hours', text: '{n} h', note: 'A lane\'s wait in hours ("6 h", "1.5 h").' }),
  minutes: agentMsg({ id: 'lane.wait.minutes', text: '{n} min', note: 'A lane\'s wait in minutes ("90 min").' }),
  paused: agentMsg({ id: 'lane.state.paused', text: 'paused, {why}', note: 'A paused lane\'s state; {why} is why it waits ("paused, #412 is blocked").' }),
  pausedRoundLimit: agentMsg({ id: 'lane.state.pausedRoundLimit', text: '{card} waits for the user at its round limit', note: "Why a lane is paused, where nothing more is known: its card at its round limit waits for the user's answer." }),
  activeOn: agentMsg({ id: 'lane.state.activeOn', text: 'active, on {card}', note: "A running lane's state: the card it is on." }),
  activeAllPassed: agentMsg({ id: 'lane.state.activeAllPassed', text: 'active, every card passed', note: "A running lane's state: every card passed, its merges remain." }),
  ended: agentMsg({ id: 'lane.state.ended', text: 'ended', note: "An ended lane's state (every card Done)." }),
  endedMerged: agentMsg({ id: 'lane.state.endedMerged', text: 'ended (merged {commit})', note: "An ended lane's state, with its merge commit ({commit})." }),
  abandoned: agentMsg({ id: 'lane.state.abandoned', text: 'abandoned', note: "An abandoned lane's state (ended before its cards were Done)." }),
  noLanes: agentMsg({ id: 'lane.list.none', text: 'No lanes.', note: 'cw_lane list with all: there are no lanes.' }),
  noLanesListed: agentMsg({ id: 'lane.list.noneListed', text: 'No lanes running or recently ended.', note: 'cw_lane list: no lane is running or ended recently (an ended lane stays listed an hour).' }),
  started: agentMsg({ id: 'lane.change.started', text: 'Lane started: {line}', note: "cw_lane start's reply for a new lane; {line} is the lane's line." }),
  joined: agentMsg({ id: 'lane.change.joined', text: 'Joined the lane: {line}', note: "cw_lane join's reply; {line} is the lane's line." }),
  updated: agentMsg({ id: 'lane.change.updated', text: 'Lane updated: {line}', note: "cw_lane start's reply for the builder's running lane, changed; {line} is the lane's line." }),
  earlierEnded: agentMsg({ id: 'lane.change.earlierEnded', text: 'Your earlier lane {id} ended.', note: "After a start's reply: the builder's earlier lane, sharing no card with the new list, ended (nothing of it left to do)." }),
  earlierAbandoned: agentMsg({ id: 'lane.change.earlierAbandoned', text: 'Your earlier lane {id} was abandoned.', note: "After a start's reply: the builder's earlier lane, sharing no card with the new list, was abandoned." }),
  endEnded: agentMsg({ id: 'lane.end.ended', text: 'Lane ended: {line}', note: "cw_lane end's reply; {line} is the lane's line." }),
  endAbandoned: agentMsg({ id: 'lane.end.abandoned', text: 'Lane abandoned: {line}', note: "cw_lane end's reply for an abandoned lane; {line} is the lane's line." }),
  nextWaits: agentMsg({ id: 'lane.next.waits', text: 'The lane waits: {why}. Start nothing new meanwhile.', note: 'cw_lane next, for a paused lane (#1270): why it waits.' }),
  nothingElse: agentMsg({ id: 'lane.next.nothingElse', text: 'Nothing else to start: the lane ends by itself once all are Done.', note: "cw_lane next, after its passed cards' places in the merge queue (#1354): no card is left to start." }),
  allDone: agentMsg({ id: 'lane.next.allDone', text: 'Every card of the lane is Done or past review: nothing to start. The lane ends by itself once all are Done.', note: 'cw_lane next, with no card left to start.' }),
  carryOn: agentMsg({ id: 'lane.next.carryOn', text: 'Carry on with {card}{also}.', note: 'cw_lane next: the card in flight (Doing or Review) to carry on; {card} is its key and title; {also} is " (why the lane waits)" or nothing.' }),
  carryOnIn: agentMsg({ id: 'lane.next.carryOnIn', text: 'Carry on with {card} in {slot}{also}.', note: 'cw_lane next: the card in flight to carry on, in the slot its lane builds in (#1438); {also} as in lane.next.carryOn.' }),
  afterQueue: agentMsg({ id: 'lane.next.afterQueue', text: 'Next: {card}, once {n, plural, one {it is} other {they are}} Done.', note: "cw_lane next, after its passed cards' places in the merge queue (#1354): the next card waits for them to be Done (one card at a time); {n} is how many." }),
  start: agentMsg({ id: 'lane.next.start', text: 'Next: {card}. Start it.', note: 'cw_lane next: the card to start next; {card} is its key and title.' }),
  startIn: agentMsg({ id: 'lane.next.startIn', text: 'Next: {card}. Start it: it is built in {slot}, on a new branch Combwork makes there.', note: "cw_lane next: the card to start next, built in the lane's slot (#1438), where Hive makes its line as it starts." }),
  cardsNone: agentMsg({ id: 'lane.args.cardsNone', text: 'cards must be the card numbers, in order (at least one)', note: "cw_lane start's refusal of its cards argument: none given, or not a list." }),
  cardsMax: agentMsg({ id: 'lane.args.cardsMax', text: 'at most {max} cards in a lane', note: "cw_lane start's refusal: too many cards." }),
  cardsNumbers: agentMsg({ id: 'lane.args.cardsNumbers', text: 'cards must be card numbers', note: "cw_lane start's refusal: a card in cards isn't a whole card number." }),
  cardsRepeat: agentMsg({ id: 'lane.args.cardsRepeat', text: 'cards must not repeat', note: "cw_lane start's refusal: a card is named twice." }),
  numberRange: agentMsg({ id: 'lane.args.numberRange', text: '{what} must be from 1 to {max}', note: "cw_lane start's refusal of rounds or waitMinutes ({what}, the argument's name) out of range." })
}

/** Why a lane waits, in a few English words for the hive tools ("waiting: HI-11 not merged"). */
export function laneStatusText(s: LaneStatus): string {
  const card = s.card !== null ? cardRef(s.card) : say(L.aCard)
  switch (s.reason) {
    case 'blocked':
      return s.blocked ? say(L.blockedWhy, { card, why: s.blocked }) : say(L.blocked, { card })
    case 'hold':
      return say(L.hold, { card })
    case 'you':
      return say(L.you, { card })
    case 'roundLimit':
      return say(L.roundLimit, { card })
    case 'notMerged':
      return say(L.notMerged, { card })
    case 'merging':
      return say(L.merging, { card })
    case 'stale':
      return say(L.stale, { card })
    case 'reviewer':
      return say(L.reviewer, { card })
    case 'lineUpdate':
      return say(L.lineUpdate, { card })
    case 'listChanges':
      return say(L.listChanges, { card })
    case 'hooks':
      return say(L.hooks, { agent: s.agent ?? say(L.anAgent) })
    case 'checkCopy':
      return say(L.checkCopy, { card })
    case 'slot':
      return s.slot && s.held ? say(L.slotHeld, { slot: s.slot, held: s.held, agent: s.agent ?? say(L.anAgent), broker: s.broker ?? '', idle: idleKey(s.idle) }) : say(L.slot)
    case 'teamPause':
      return say(L.teamPause)
    case 'preparing':
      return say(L.preparing, { slot: s.slot ?? say(L.itsSlot) })
    case 'startWait': {
      // An agent owed its new conversation (HI-2034): said of the agent, whichever card.
      if (s.why === 'fresh') {
        const agent = s.agent ?? say(L.itsAgent)
        if (!s.freshBlocked) return say(L.freshWaits, { agent })
        if (s.freshBlocked === 'timeout') return say(L.freshTimeout, { agent })
        if (s.freshBlocked === 'uncertain') return say(L.freshUncertain, { agent })
        return s.freshWhy !== undefined ? say(L.freshFailed, { agent, why: s.freshWhy }) : say(L.freshFailedBare, { agent })
      }
      if (s.why === 'dependencies') return say(L.startDependencies, { card, waitsFor: s.waitsFor ?? say(L.aDependency) })
      if (s.why === 'refused' && s.slot && s.held) return say(L.startRefusedHeld, { card, slot: s.slot, held: s.held, heldBy: s.heldBy ?? say(L.anAgent), broker: s.broker ?? '', idle: idleKey(s.idle), program: s.program ?? '', more: s.more ?? 0 })
      if (s.why === 'refused') return say(L.startRefused, { card })
      const agent = s.agent ?? say(L.itsBuilder)
      return say(s.why === 'watching' ? L.startWatching : s.why === 'queued' ? L.startQueued : s.why === 'failed' ? L.startFailed : L.startBusy, { card, agent })
    }
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
  // Its run (#1270): each part kept only when it reads as one (a queued list may be empty only while a card is in flight).
  const pending = Array.isArray(v.pending) && v.pending.length <= LANE_MAX_CARDS && v.pending.every((n) => whole(n, 1e9)) && new Set(v.pending).size === v.pending.length ? (v.pending as number[]) : null
  const fresh = v.state === 'active' ? readFreshStarts(v.freshStart) : null
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
    ...(snapshot ? { frozen: snapshot } : {}),
    ...(text(v.ruleset, 128) ? { ruleset: v.ruleset } : {}),
    ...(pending ? { pending } : {}),
    ...(whole(v.inFlight, 1e9) ? { inFlight: v.inFlight as number } : {}),
    ...(isObj(v.slotWait) && time(v.slotWait.since) && typeof v.slotWait.note === 'string' ? { slotWait: { since: v.slotWait.since as string, note: (v.slotWait.note as string).slice(0, 4000), ...(v.slotWait.stoppedOnly === true ? { stoppedOnly: true as const } : {}) } } : {}),
    ...(isObj(v.brief) && whole(v.brief.rev, 1e9) && (v.brief.text === null || typeof v.brief.text === 'string') && (v.brief.out === null || whole(v.brief.out, 1e9)) ? { brief: { text: v.brief.text === null ? null : (v.brief.text as string).slice(0, LANE_BRIEF_MAX), rev: v.brief.rev as number, out: v.brief.out as number | null, ...(text(v.brief.notIn, 128) ? { notIn: v.brief.notIn as string } : {}) } } : {}),
    ...(v.pool === true && !reviewer ? { pool: true as const } : {}),
    ...(fresh ? { freshStart: fresh } : {})
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
  if (!Array.isArray(v) || !v.length) return say(L.cardsNone)
  if (v.length > LANE_MAX_CARDS) return say(L.cardsMax, { max: LANE_MAX_CARDS })
  if (!v.every((n) => whole(n, 1e9))) return say(L.cardsNumbers)
  if (new Set(v).size !== v.length) return say(L.cardsRepeat)
  return v as number[]
}

/** A number of rounds or minutes from untrusted arguments (undefined: the default); a string says what's wrong. */
export function laneNumber(v: unknown, what: 'rounds' | 'waitMinutes', fallback: number): number | string {
  if (v === undefined || v === null) return fallback
  const max = what === 'rounds' ? LANE_MAX_ROUNDS : LANE_MAX_WAIT_MINUTES
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.round(v) < 1 || Math.round(v) > max) return say(L.numberRange, { what, max })
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
export const waitText = (minutes: number): string => (minutes >= 60 && minutes % 60 === 0 ? say(L.hours, { n: minutes / 60 }) : minutes >= 60 ? say(L.hours, { n: Math.round((minutes / 60) * 10) / 10 }) : say(L.minutes, { n: minutes }))

/** A lane's card in a few words: "#405 Review r2", "#412 Todo", "#402 Doing (blocked)". */
const cardWord = (c: LaneCard): string => `${cardRef(c.number)} ${say(L.column[c.column])}${c.round > 1 && c.column !== 'gone' && c.column !== 'unrecorded' ? ` ${say(L.cardRound, { round: c.round })}` : ''}${c.blocked ? ` ${say(L.cardBlocked)}` : ''}`

/**
 * A lane in one line, for the hive tools: "B1 / R1 (hive) lanes and loops: active, on #405; #483 Passed, #405 Review r2,
 * #412 Todo; rounds 10, wait 6 h. lane-3fa2".
 */
export function laneLine(l: LaneInfo): string {
  const who = { builder: l.builder.name, reviewer: l.reviewer?.name ?? say(l.pool ? L.pool : L.noReviewer), project: l.project }
  const pair = l.slot ? say(L.pairInSlot, { ...who, slot: l.slot }) : say(L.pair, who)
  const values = { pair, state: laneStateText(l), cards: l.cards.map(cardWord).join(', '), rounds: l.rounds, wait: waitText(l.waitMinutes), id: l.id }
  return l.name ? say(L.lineNamed, { ...values, name: l.name }) : say(L.line, values)
}

/**
 * A lane's state in a few words, as its line says it: "active, on #405", "paused, #412 is blocked", "active, every card
 * passed; waiting: #483 not merged", "ended (merged 3f2a)". Project status's pairs carry it too (HI-2271), so either
 * tool says which card a lane is on in the same words.
 */
export function laneStateText(l: LaneInfo): string {
  const said = l.status ? `; ${laneStatusText(l.status)}` : ''
  const paused = l.cards.find((c) => c.number === l.pausedOn)
  const card = l.pausedOn !== null ? cardRef(l.pausedOn) : say(L.aCard)
  const why = l.status ? laneStatusText(l.status) : say(paused?.roundLimit && !paused.blocked ? L.pausedRoundLimit : L.blocked, { card })
  if (l.state === 'paused') return say(L.paused, { why })
  if (l.state === 'active') return `${l.current !== null ? say(L.activeOn, { card: cardRef(l.current) }) : say(L.activeAllPassed)}${said}`
  if (l.state === 'ended') return l.mergeCommit ? say(L.endedMerged, { commit: l.mergeCommit }) : say(L.ended)
  return say(L.abandoned)
}

/** A listing of lanes, a line each. */
export function lanesText(lanes: readonly LaneInfo[], all = false): string {
  if (!lanes.length) return say(all ? L.noLanes : L.noLanesListed)
  return lanes.map(laneLine).join('\n')
}

/** What a start or join did, for the tool's reply. */
export type LaneChange = { lane: LaneInfo; did: 'started' | 'updated' | 'joined'; replaced?: LaneInfo | null; note?: string }

export function laneChangeText(r: LaneChange): string {
  const what = say(r.did === 'started' ? L.started : r.did === 'joined' ? L.joined : L.updated, { line: laneLine(r.lane) })
  const before = r.replaced ? ` ${say(r.replaced.state === 'ended' ? L.earlierEnded : L.earlierAbandoned, { id: r.replaced.id })}` : ''
  return `${what}${before}${r.note ? ` ${r.note}` : ''}`
}

/** What an end did (and why a merge commit given was ignored, #1270). */
export function laneEndText(l: LaneInfo & { note?: string }): string {
  return `${say(l.state === 'ended' ? L.endEnded : L.endAbandoned, { line: laneLine(l) })}${l.note ? ` ${l.note}` : ''}`
}

/**
 * What cw_lane next says (#1270): the card to start or carry on, or why the lane waits, or that every card is Done.
 * `queue`: the lane's passed cards Hive merges, each with where it is in the merge queue (#1354): the lane takes one card
 * at a time, so the next waits for them to be Done.
 */
export function laneNextText(r: { lane: LaneInfo; next: { card: number; title: string; carryOn: boolean } | null; waits: LaneStatus | null; queue?: { card: number; line: string }[]; unsubmitted?: UnsubmittedCard[] }): string {
  if (r.lane.state === 'paused' && r.waits) return say(L.nextWaits, { why: laneStatusText(r.waits) })
  // Each passed card's place in the merge queue (#1354): its key, then the queue's own line.
  const queued = r.queue?.length ? r.queue.map((q) => `${cardRef(q.card)}: ${q.line}`).join(' ') : ''
  if (!r.next) return queued ? `${queued} ${say(L.nothingElse)}` : say(L.allDone)
  const card = `${cardRef(r.next.card)} ${r.next.title}`
  const also = r.waits ? ` (${laneStatusText(r.waits)})` : ''
  // Its slot (#1438): where the card is built; Hive makes its line there as it starts.
  const slot = r.lane.slot
  // HI-2245: carried on in Review with commits past its submission: not handed over yet.
  const first = r.next.carryOn ? unsubmittedText(r.unsubmitted?.filter((u) => u.card === r.next!.card), undefined, true) : null
  if (r.next.carryOn) return `${slot ? say(L.carryOnIn, { card, slot, also }) : say(L.carryOn, { card, also })}${first ? ` ${first}` : ''}`
  if (queued) return `${queued} ${say(L.afterQueue, { card, n: r.queue!.length })}`
  return slot ? say(L.startIn, { card, slot }) : say(L.start, { card })
}
