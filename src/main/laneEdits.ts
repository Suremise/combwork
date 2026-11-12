import { join } from 'path'
import { withValues } from '../shared/advanced'
import { msg } from '../shared/i18n'
import { LANE_MAX_CARDS, running, type LaneRecord } from '../shared/lanes'
import { cardRef } from '../shared/projectKeys'
import { foldCard } from '../shared/workflow/facts'
import { targetOfRulesetId } from '../shared/workflow/compile'
import type { LaneEdit, LaneEditResult, LaneEditUndo, LaneListState, TaskCard } from '../shared/types'
import { boardRead, cardPlacesNow } from './boardStore'
import { combworkError } from './combworkError'
import { applyLaneList, laneDefaultTarget, LaneError, lanesEnforced, mutateInBoard, refuseOtherTargets, refuseWhileTeamPaused } from './lanes'
import { resumeLaneBuilder } from './laneStart'
import { createLogger, userText } from './logger'
import { progress } from './progressService'
import { withCardNames } from './projectKeys'
import { getTask, updateTask, type TaskActor } from './tasks'
import { FactStore } from './workflow/factStore'
import { inWorkspace, type WorkspaceService } from './workspace'

const log = createLogger('lanes')

/**
 * The window's edits of a running lane's list (HI-2898, Progress → Lanes; SPEC §16.11.3): move a queued card, add one
 * (the picker, or dragged from the board), remove one (back to the board, never deleted), cancel the lane's queued change,
 * move a card here from another lane (Move here), and undo the last of these.
 *
 * One list writer: each edit is saved through lanes.ts' `applyLaneList`, as `cw_lane start` is, so it is queued behind
 * the lane's card in flight or applied between cards exactly as that is. Each runs as one change of the board
 * (`mutateInBoard`): the lanes it changes and the card assignment it makes are saved together or not at all, every
 * check below made again at the write, under the board's lock, with nothing awaited between it and the save.
 *
 * Bound to what the window showed: each edit names its lane by id and the revision of its list (LaneRecord.listRev); a
 * lane ended, gone, or with another revision is refused, nothing saved. Only queued cards move: the start of the lane's
 * working list up to its last card that isn't queued (in flight, in Review, Approved, Done, on hold, or another agent's)
 * keeps its places in every edit, an undo's included.
 *
 * These refusals are the window's own: `cw_lane start` keeps its rules as they are.
 */

const M = {
  changed: msg({ id: 'service.laneEdit.changed', defaultMessage: 'The cards of {lane} changed meanwhile: look again, then try again.', description: "HI-2898: an error editing a lane's cards in Progress → Lanes (a lane: a builder and a reviewer agent working through cards in turn): the lane's list changed since the window showed it (an agent, the Assistant or another window changed it), so nothing was changed. {lane} is its builder / reviewer (B1 / R1)." }),
  ended: msg({ id: 'service.laneEdit.ended', defaultMessage: '{lane} has ended: its cards can’t be changed any more.', description: "HI-2898: an error editing a lane's cards in Progress → Lanes: the lane ended (or was abandoned) meanwhile. {lane} is its builder / reviewer, or its id when it's gone." }),
  notQueued: msg({ id: 'service.laneEdit.notQueued', defaultMessage: '{card} has started, or isn’t to do any more: only cards still waiting their turn can be moved or taken off.', description: "HI-2898: an error moving or removing a card ({card}, its key) in a lane's cards (Progress → Lanes): only cards still waiting in To do, not another agent's, can be; this one is in progress, in review, approved, done, on hold or another agent's." }),
  fixedPlace: msg({ id: 'service.laneEdit.fixedPlace', defaultMessage: 'Cards already started or finished keep their places: {card} can only go after them.', description: "HI-2898: an error moving or adding a card in a lane's cards (Progress → Lanes) to a place before a card that's already in progress, in review, approved or done ({card}: the card moved or added, its key)." }),
  otherProject: msg({ id: 'service.laneEdit.otherProject', defaultMessage: '{card} isn’t one of {project}’s cards, or it’s archived.', description: "HI-2898: an error adding a card ({card}, its key) to a lane (Progress → Lanes): it belongs to another project than the lane's ({project}), or it's archived." }),
  done: msg({ id: 'service.laneEdit.done', defaultMessage: '{card} is Done already.', description: "HI-2898: an error adding a card ({card}, its key) to a lane (Progress → Lanes): it's already Done." }),
  notTodo: msg({ id: 'service.laneEdit.notTodo', defaultMessage: '{card} isn’t in To do: only cards not started yet join a lane.', description: "HI-2898: an error adding a card ({card}, its key) to a lane (Progress → Lanes): it's in progress, in review, approved or on hold. To do is the board's column of cards not started (as the board names it)." }),
  onLane: msg({ id: 'service.laneEdit.onLane', defaultMessage: '{card} is on the lane of {builder}: take it off there first, or use Move here.', description: "HI-2898: an error adding a card ({card}, its key) to a lane (Progress → Lanes): another running lane (of the builder agent {builder}) has it. Move here is the button beside this message that moves it: as it's translated there." }),
  full: msg({ id: 'service.laneEdit.full', defaultMessage: 'A lane can have at most {max, number} cards, and {lane} has that many already: take one off first.', description: "HI-3061: an error adding a card to a lane, or moving one to it from another lane (Progress → Lanes): the lane already has the most cards a lane can have ({max}, 50). {lane} is its builder / reviewer (B1 / R1)." }),
  already: msg({ id: 'service.laneEdit.already', defaultMessage: '{card} is on this lane already.', description: "HI-2898: an error adding a card ({card}, its key) to a lane (Progress → Lanes) that already has it." }),
  kept: msg({ id: 'service.laneEdit.keptWork', defaultMessage: '{card} keeps work from an earlier start (a branch, a slot or a run): it stays where it is. Carry it on from its card instead.', description: "HI-2898: an error adding a card ({card}, its key) to a lane, or moving it to another lane (Progress → Lanes): it was started before and its work is kept (a branch, a slot lent for it, or a run in progress), so Combwork won't hand it to another builder from here." }),
  dependency: msg({ id: 'service.laneEdit.dependency', defaultMessage: '{card} depends on {dep}, which would come after it: put {dep} first.', description: "HI-2898: an error moving or adding a card in a lane's cards (Progress → Lanes): {card} (a key) depends on {dep} (a key: it's blocked by it), and the change would put {dep} later in the lane." }),
  notOnLane: msg({ id: 'service.laneEdit.notOnLane', defaultMessage: '{card} isn’t on this lane any more.', description: "HI-2898: an error moving or removing a card ({card}, its key) in a lane's cards (Progress → Lanes) that the lane no longer has." }),
  noQueued: msg({ id: 'service.laneEdit.noQueued', defaultMessage: '{lane} has no queued change to cancel.', description: "HI-2898: an error cancelling a lane's queued change (Progress → Lanes: a change of its cards waiting for its card in progress to be Done) when it has none any more. {lane} is its builder / reviewer." }),
  cardChanged: msg({ id: 'service.laneEdit.cardChanged', defaultMessage: '{card} changed since (it was given to an agent, moved or edited): the change wasn’t undone.', description: "HI-2898: an error undoing an edit of lanes (Progress → Lanes) that took a card ({card}, its key) from an agent: the card changed since, so nothing was undone." }),
  invalid: msg({ id: 'service.laneEdit.invalid', defaultMessage: 'That change of a lane’s cards isn’t one Combwork can make.', description: "HI-2898: an error, a change of a lane's cards sent by the window (Progress → Lanes) was malformed (a mistake in Combwork, or a window from another version). Rarely seen." }),
  since: msg({ id: 'service.laneEdit.since', defaultMessage: 'Ended lanes are listed from a time in the last two days.', description: "HI-2898: an error, the window asked for the lanes that ended since a time that isn't a time in the last 48 hours (a mistake in Combwork). Rarely seen." })
}

/** The most cards an edit's list may hold, and the ids a lane has. */
const MAX_LIST = 200
const LANE_ID = /^lane-[0-9a-f]{1,32}$/
const HISTORY_ID = /^[\w-]{1,64}$/
const AGENT_ID = /^[\w.-]{1,128}$/

const isCard = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 1e9
const isPlace = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_LIST
const isRev = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= Number.MAX_SAFE_INTEGER
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isList = (v: unknown): v is number[] => Array.isArray(v) && v.length <= MAX_LIST && v.every(isCard) && new Set(v).size === v.length
const isSeen = (v: unknown): v is Record<string, unknown> & { lane: string; rev: number } => isObj(v) && typeof v.lane === 'string' && LANE_ID.test(v.lane) && isRev(v.rev)
const agentOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && AGENT_ID.test(v))

/** A window's lane edit as IPC passed it (HI-2898, HR1's input check): each field checked, else refused as invalid. */
export function laneEditOf(v: unknown): LaneEdit {
  const bad = (): never => {
    throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  }
  if (!isObj(v)) return bad()
  const at = v.at === undefined ? undefined : isPlace(v.at) ? v.at : bad()
  switch (v.op) {
    case 'move':
      return isSeen(v) && isCard(v.card) && isPlace(v.to) ? { op: 'move', lane: v.lane, rev: v.rev, card: v.card, to: v.to } : bad()
    case 'add':
      return isSeen(v) && isCard(v.card) ? { op: 'add', lane: v.lane, rev: v.rev, card: v.card, ...(at !== undefined ? { at } : {}) } : bad()
    case 'remove':
      return isSeen(v) && isCard(v.card) ? { op: 'remove', lane: v.lane, rev: v.rev, card: v.card } : bad()
    case 'cancel':
      return isSeen(v) ? { op: 'cancel', lane: v.lane, rev: v.rev } : bad()
    case 'transfer':
      return isCard(v.card) && isSeen(v.from) && isSeen(v.to) ? { op: 'transfer', card: v.card, from: { lane: v.from.lane, rev: v.from.rev }, to: { lane: v.to.lane, rev: v.to.rev }, ...(at !== undefined ? { at } : {}) } : bad()
    case 'undo': {
      const u = v.undo
      if (!isObj(u) || !Array.isArray(u.lanes) || u.lanes.length < 1 || u.lanes.length > 2) return bad()
      const lanes = u.lanes.map((x: unknown) => {
        if (!isObj(x) || !isRev(x.rev) || !isObj(x.before)) return bad()
        const b = x.before
        if (typeof b.lane !== 'string' || !LANE_ID.test(b.lane) || !isList(b.cards) || (b.pending !== null && !isList(b.pending))) return bad()
        return { before: { lane: b.lane, cards: [...b.cards], pending: b.pending === null ? null : [...(b.pending as number[])] }, rev: x.rev }
      })
      if (lanes.length === 2 && lanes[0].before.lane === lanes[1].before.lane) return bad()
      const c = u.card
      if (c !== null && (!isObj(c) || !isCard(c.number) || !agentOrNull(c.before) || !agentOrNull(c.after) || (c.head !== null && (typeof c.head !== 'string' || !HISTORY_ID.test(c.head))))) return bad()
      const back = u.back
      if (!Array.isArray(back) || back.length > MAX_LIST) return bad()
      const backs = back.map((x: unknown) => (isObj(x) && isCard(x.number) && (x.head === null || (typeof x.head === 'string' && HISTORY_ID.test(x.head))) && typeof x.work === 'boolean' ? { number: x.number, head: x.head as string | null, work: x.work } : bad()))
      return { op: 'undo', undo: { lanes, card: c === null ? null : { number: c.number as number, before: c.before as string | null, after: c.after as string | null, head: c.head as string | null }, back: backs } }
    }
    default:
      return bad()
  }
}

/** The time Ended today lists from, as IPC passed it: an ISO time in the last 48 hours (local midnight, normally). */
export function endedSinceOf(v: unknown, now = Date.now()): number {
  const t = typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN
  if (!Number.isFinite(t) || t > now + 60_000 || now - t > 48 * 3_600_000) throw combworkError(M.since, undefined, { kind: 'invalid' })
  return t
}

/** Unit tests' seam: how a changed lane's stopped builder is started on it (never a CLI in a unit test). */
export const laneEditHooks: { resume: (projectPath: string, lane: LaneRecord) => Promise<unknown> } = { resume: resumeLaneBuilder }

/** Who makes the window's edits, as the board records it. */
const USER: TaskActor = { kind: 'user' }

/** A lane as its messages name it: builder / reviewer. */
const pairOf = (l: LaneRecord): string => (l.reviewer ? `${l.builder.name} / ${l.reviewer.name}` : l.builder.name)

/** A refusal, in the window's language, naming cards by key. */
function refuse(ws: WorkspaceService, status: number, m: Parameters<typeof withValues>[0], values: Record<string, string | number> = {}): never {
  throw new LaneError(status, withCardNames(ws, () => withValues(m, values)))
}

const working = (l: LaneRecord): number[] => [...(l.pending ?? l.cards)]
const stateOf = (l: LaneRecord): LaneListState => ({ lane: l.id, cards: [...l.cards], pending: l.pending ? [...l.pending] : null, rev: l.listRev ?? 0 })
const sameList = (a: readonly number[] | null, b: readonly number[] | null): boolean => (a === null || b === null ? a === b : a.length === b.length && a.every((n, i) => n === b[i]))

/** The running lane an edit names, at the revision it names: refused otherwise. */
function laneSeen(ws: WorkspaceService, lanes: LaneRecord[], id: string, rev: number): LaneRecord {
  const l = lanes.find((x) => x.id === id)
  if (!l || !running(l)) refuse(ws, 409, M.ended, { lane: l ? pairOf(l) : id })
  if ((l.listRev ?? 0) !== rev) refuse(ws, 409, M.changed, { lane: pairOf(l) })
  return l
}

/**
 * Whether a card is queued on a lane, as the board has it now: on the board, in its project, in To do, given to nobody or
 * to its builder. Read on the board change's own connection inside it (cardPlacesNow), so under its lock.
 */
function queuedOn(places: ReturnType<typeof cardPlacesNow>, l: LaneRecord, n: number): boolean {
  const c = places.get(n)
  return !!c && !c.archived && c.project.toLowerCase() === l.project.toLowerCase() && c.column === 'todo' && (!c.agent || c.agent === l.builder.id)
}

/** How long the start of a lane's working list is that keeps its places: up to its last card that isn't queued. */
function fixedLength(ws: WorkspaceService, l: LaneRecord, list: readonly number[]): number {
  const places = cardPlacesNow(ws, list)
  let fixed = 0
  list.forEach((n, i) => {
    if (!queuedOn(places, l, n)) fixed = i + 1
  })
  return fixed
}

/** Refused when `next` doesn't keep the start of `was` that keeps its places; `card` is the card the edit moves or adds. */
function keepsFixed(ws: WorkspaceService, l: LaneRecord, was: readonly number[], next: readonly number[], card: number | null): void {
  const fixed = fixedLength(ws, l, was)
  if (!sameList(was.slice(0, fixed), next.slice(0, fixed))) refuse(ws, 409, M.fixedPlace, { card: cardRef(card ?? next.find((n, i) => n !== was[i]) ?? was[0]) })
}

/** Each card's cards it depends on (blockedBy), as its project's records have them. */
function dependsOn(ws: WorkspaceService, l: LaneRecord, list: readonly number[]): Map<number, number[]> {
  const store = FactStore.forBoard(ws, { project: l.project, key: '' })
  const out = new Map<number, number[]>()
  for (const n of list) {
    try {
      out.set(n, store.card(n).blockedBy)
    } catch {
      out.set(n, [])
    }
  }
  return out
}

/** The cards of a list placed before a card of it they depend on, as pairs `card<dep`. */
function outOfOrder(list: readonly number[], deps: Map<number, number[]>): Map<string, { card: number; dep: number }> {
  const out = new Map<string, { card: number; dep: number }>()
  list.forEach((n, i) => {
    for (const d of deps.get(n) ?? []) if (list.indexOf(d) > i) out.set(`${n}<${d}`, { card: n, dep: d })
  })
  return out
}

/** Refused when `next` puts a card before one it depends on that `was` didn't. */
function keepsDependencies(ws: WorkspaceService, l: LaneRecord, was: readonly number[], next: readonly number[]): void {
  const deps = dependsOn(ws, l, [...new Set([...was, ...next])])
  const before = outOfOrder(was, deps)
  for (const [k, v] of outOfOrder(next, deps)) if (!before.has(k)) refuse(ws, 409, M.dependency, { card: cardRef(v.card), dep: cardRef(v.dep) })
}

/**
 * Whether a card has work kept from an earlier start (HR1's s17 check): a start or a line on its facts, a slot lease open
 * for it, or a run of it in progress. Such a card is never brought into a lane from the window.
 */
function keepsWork(ws: WorkspaceService, l: LaneRecord, n: number): boolean {
  try {
    const s = foldCard(FactStore.forBoard(ws, { project: l.project, key: '' }).facts(n))
    if (s.started || s.lines.length) return true
  } catch {
    // A card with no facts (from before 1.0): nothing recorded of it.
  }
  const leased = boardRead(ws, (db) => {
    try {
      return !!db.prepare('SELECT 1 FROM slot_leases WHERE card = ? AND ended_at IS NULL').get(n) // i18n-ignore: SQL
    } catch {
      return false
    }
  })
  return leased || (!!ws.path && progress.list(ws.path).some((r) => r.card === n && r.state === 'running'))
}

/**
 * The checks for a card the edit brings into lane `l` (add, Move here, an undo putting it back): on the board, in the
 * lane's project, in To do, on no other running lane than `leaving`, not on this one already (`fresh`), keeping no earlier
 * work (`work`), and merging where the lane does.
 */
function bringable(ws: WorkspaceService, lanes: LaneRecord[], l: LaneRecord, n: number, o: { leaving?: LaneRecord | null; fresh: boolean; work: boolean; def: string | null }): void {
  const c = cardPlacesNow(ws, [n]).get(n)
  if (!c || c.archived || c.project.toLowerCase() !== l.project.toLowerCase()) refuse(ws, 409, M.otherProject, { card: cardRef(n), project: l.project })
  if (c.column === 'done') refuse(ws, 409, M.done, { card: cardRef(n) })
  if (c.column !== 'todo') refuse(ws, 409, M.notTodo, { card: cardRef(n) })
  if (o.fresh && working(l).includes(n)) refuse(ws, 409, M.already, { card: cardRef(n) })
  const other = lanes.find((x) => x !== l && x !== o.leaving && running(x) && x.project.toLowerCase() === l.project.toLowerCase() && (x.cards.includes(n) || !!x.pending?.includes(n)))
  if (other) refuse(ws, 409, M.onLane, { card: cardRef(n), builder: other.builder.name })
  if (o.work && keepsWork(ws, l, n)) refuse(ws, 409, M.kept, { card: cardRef(n) })
  refuseOtherTargets(ws, l.project, [n], l.ruleset ? targetOfRulesetId(l.ruleset) : null, o.def, null)
}

/** The checks for a card the edit moves within its lane or takes off it: on the lane, and queued there. */
function queuedHere(ws: WorkspaceService, l: LaneRecord, n: number): void {
  if (!working(l).includes(n)) refuse(ws, 409, M.notOnLane, { card: cardRef(n) })
  if (!queuedOn(cardPlacesNow(ws, [n]), l, n)) refuse(ws, 409, M.notQueued, { card: cardRef(n) })
}

/** What an edit decided before the board's change: the lanes it changes, and the card it brings in, if any. */
interface Plan {
  op: LaneEdit['op']
  card: number | null
  /** Each lane with its new working list (cancel: the applied list, checked, HI-2943), or (an undo) the list to put back exactly. */
  lanes: { lane: LaneRecord; next: number[]; restore?: Omit<LaneListState, 'rev' | 'lane'> }[]
  /** The card brought into a lane (add, Move here), with the lane it leaves (Move here). */
  brings: { card: number; into: LaneRecord; leaving: LaneRecord | null } | null
  /** An undo's card: its agent put back, while it is as the edit left it. */
  undoCard: LaneEditUndo['card']
  /** An undo's cards brought back, as the edit left them. */
  back: LaneEditUndo['back']
  /** Each project's own Merges into, for the target check. */
  def: Map<string, string | null>
}

/** A place in a list, clamped to it: none, last. */
const placeAt = (list: readonly number[], at: number | undefined): number => (at === undefined || !Number.isInteger(at) || at < 0 || at > list.length ? list.length : at)

function plan(ws: WorkspaceService, lanes: LaneRecord[], e: LaneEdit, def: Map<string, string | null>): Plan {
  if (e.op === 'undo') {
    const ls = e.undo.lanes.map((u) => ({ lane: laneSeen(ws, lanes, u.before.lane, u.rev), next: [...(u.before.pending ?? u.before.cards)], restore: { cards: [...u.before.cards], pending: u.before.pending ? [...u.before.pending] : null } }))
    return { op: e.op, card: e.undo.card?.number ?? null, lanes: ls, brings: null, undoCard: e.undo.card, back: e.undo.back, def }
  }
  if (e.op === 'transfer') {
    const from = laneSeen(ws, lanes, e.from.lane, e.from.rev)
    const to = laneSeen(ws, lanes, e.to.lane, e.to.rev)
    if (from === to) refuse(ws, 409, M.already, { card: cardRef(e.card) })
    const into = working(to).filter((n) => n !== e.card)
    into.splice(placeAt(into, e.at), 0, e.card)
    return { op: e.op, card: e.card, lanes: [{ lane: from, next: working(from).filter((n) => n !== e.card) }, { lane: to, next: into }], brings: { card: e.card, into: to, leaving: from }, undoCard: null, back: [], def }
  }
  const l = laneSeen(ws, lanes, e.lane, e.rev)
  const list = working(l)
  if (e.op === 'cancel') {
    if (!l.pending) refuse(ws, 409, M.noQueued, { lane: pairOf(l) })
    // The list as it applies now, through every check an edit gets (HI-2943), never put back unchecked: a card the queued
    // change took off that another running lane holds now (Move here after a queued reorder) stays there, and each other
    // card it brings back is checked as any card brought in (below). What's left saves as any edit's list does.
    const held = (n: number): boolean => lanes.some((x) => x !== l && running(x) && x.project.toLowerCase() === l.project.toLowerCase() && (x.cards.includes(n) || !!x.pending?.includes(n)))
    return { op: e.op, card: null, lanes: [{ lane: l, next: l.cards.filter((n) => list.includes(n) || !held(n)) }], brings: null, undoCard: null, back: [], def }
  }
  if (e.op === 'remove') return { op: e.op, card: e.card, lanes: [{ lane: l, next: list.filter((n) => n !== e.card) }], brings: null, undoCard: null, back: [], def }
  if (e.op === 'move') {
    const next = list.filter((n) => n !== e.card)
    next.splice(Math.max(0, Math.min(next.length, Number.isInteger(e.to) ? e.to : next.length)), 0, e.card)
    return { op: e.op, card: e.card, lanes: [{ lane: l, next }], brings: null, undoCard: null, back: [], def }
  }
  const next = [...list]
  next.splice(placeAt(list, e.at), 0, e.card)
  return { op: e.op, card: e.card, lanes: [{ lane: l, next }], brings: { card: e.card, into: l, leaving: null }, undoCard: null, back: [], def }
}

/** The last entry of a card's history: what an undo of its assignment is bound to (an entry is never written twice). */
const headOf = (c: TaskCard): string | null => c.history.at(-1)?.id ?? null

/**
 * Makes a window edit of lanes (HI-2898): checked, saved in one board change with any card assignment it makes, then the
 * builders of the lanes it changed started on them if they aren't running (as an update of a lane by the user or the
 * Assistant does). Returns what it did and how to undo it.
 */
export async function editLanes(ws: WorkspaceService, e: LaneEdit): Promise<LaneEditResult> {
  refuseWhileTeamPaused(ws)
  const on = await lanesEnforced()
  let before: LaneListState[] = []
  let cardUndo: LaneEditUndo['card'] = null
  let back: LaneEditUndo['back'] = []
  let queued: { lane: string; queuedAfter: number | null }[] = []
  const done = await mutateInBoard(
    ws,
    async (lanes) => {
      // Each project's own Merges into, read before the board's change (it reads the repository).
      const def = new Map<string, string | null>()
      for (const l of lanes) if (running(l) && !def.has(l.project.toLowerCase())) def.set(l.project.toLowerCase(), await laneDefaultTarget(ws, l.project))
      return plan(ws, lanes, e, def)
    },
    async (lanes, p, checks) => {
      before = p.lanes.map((x) => stateOf(x.lane))
      cardUndo = null
      back = []
      queued = []
      const defOf = (l: LaneRecord): string | null => p.def.get(l.project.toLowerCase()) ?? null
      // Checked under the board's lock, before anything is written, on the board as it is now.
      for (const x of p.lanes) {
        const was = working(x.lane)
        // A lane holds at most LANE_MAX_CARDS (HI-3061): a list past it would be saved but never read back (readLane drops
        // the lane, or its queued change), so an edit growing one past it is refused here, before anything is written.
        if (x.next.length > LANE_MAX_CARDS) refuse(ws, 409, M.full, { max: LANE_MAX_CARDS, lane: pairOf(x.lane) })
        if (p.op === 'move' || p.op === 'remove') queuedHere(ws, x.lane, p.card!)
        if (p.op === 'transfer' && x.lane === p.brings?.leaving) queuedHere(ws, x.lane, p.card!)
        keepsFixed(ws, x.lane, was, x.next, p.card)
        // An undo sets the applied list back too: its fixed start kept there as well.
        if (x.restore) keepsFixed(ws, x.lane, x.lane.cards, x.restore.cards, p.card)
        keepsDependencies(ws, x.lane, was, x.next)
        // An undo bringing a card back (one it took off, or Move here's to its first lane): as any card brought in, from
        // the lane it leaves in this undo; its earlier work, assignment and history are checked against the token below.
        // Cancel Change's cards back from its queued change the same (HI-2943), from no other lane: one another running
        // lane holds is refused here, on the board as it is now, if it got there after the plan left it out. With no
        // record from before their removal, any work one keeps refuses it (HR1's round 1: started since and back in To do
        // never comes back), as Add and Move here do; its assignment is checked below.
        if (p.op === 'undo' || p.op === 'cancel') for (const n of x.next.filter((c) => !was.includes(c))) bringable(ws, lanes, x.lane, n, { leaving: p.op === 'undo' ? (p.lanes.find((y) => y !== x && working(y.lane).includes(n))?.lane ?? null) : null, fresh: true, work: p.op === 'cancel', def: defOf(x.lane) })
      }
      if (p.brings) bringable(ws, lanes, p.brings.into, p.brings.card, { leaving: p.brings.leaving, fresh: true, work: true, def: defOf(p.brings.into) })
      // The card's assignment, through the card-change owner, in this change (HR1's s17): a card brought in that is given
      // to another agent than the lane's builder is given to nobody, so the lane takes it next; taken back by an undo only
      // while it is exactly as the edit left it.
      await inWorkspace(ws, async () => {
        // An undo brings a card back only as the edit left it (HR1's round 1): its last history entry the same (not
        // started, given to anyone or moved since), given to nobody or to the lane's builder, and with no earlier work it
        // didn't have then. Checked before the undo gives any card its agent back.
        if (p.op === 'undo') {
          for (const x of p.lanes) {
            const was = working(x.lane)
            for (const n of x.next.filter((c) => !was.includes(c))) {
              const b = p.back.find((y) => y.number === n)
              const c = await getTask(n, ws)
              if (!b || headOf(c) !== b.head || (c.agent && c.agent !== x.lane.builder.id && c.agent !== p.undoCard?.after)) refuse(ws, 409, M.cardChanged, { card: cardRef(n) })
              if (!b.work && keepsWork(ws, x.lane, n)) refuse(ws, 409, M.kept, { card: cardRef(n) })
            }
          }
        }
        // Cancel Change's cards back (HI-2943, HR1's round 1): given to nobody or to the lane's builder, never taken from
        // an agent it was given to since it left. Checked before anything is written.
        if (p.op === 'cancel') {
          for (const x of p.lanes) {
            const was = working(x.lane)
            for (const n of x.next.filter((c) => !was.includes(c))) {
              const c = await getTask(n, ws)
              if (c.agent && c.agent !== x.lane.builder.id) refuse(ws, 409, M.cardChanged, { card: cardRef(n) })
            }
          }
        }
        if (p.brings) {
          const n = p.brings.card
          const into = p.brings.into
          const now = await getTask(n, ws)
          const was = now.agent ?? null
          if (was && was !== into.builder.id) {
            const saved = await updateTask(n, { agent: null }, USER, {
              check: (c) => {
                if (c.archived || c.column !== 'todo' || (c.agent ?? null) !== was) refuse(ws, 409, M.cardChanged, { card: cardRef(n) })
              }
            })
            cardUndo = { number: n, before: was, after: null, head: headOf(saved) }
          }
        }
        const u = p.undoCard
        if (u && u.before !== u.after) {
          await updateTask(u.number, { agent: u.before }, USER, {
            check: (c) => {
              if (c.archived || c.column !== 'todo' || (c.agent ?? null) !== u.after || headOf(c) !== u.head) refuse(ws, 409, M.cardChanged, { card: cardRef(u.number) })
            }
          })
        }
      })
      // The lists, through the one list writer: queued behind the card in flight, or applied between cards. An undo puts
      // back exactly the cards and queued list the edit found (s14's restore): nothing of the lane's list has changed
      // since (its revision is the one the edit left), its fixed start is kept in both lists (checked above), and
      // each card it brings back was checked as any card brought in.
      for (const x of p.lanes) {
        const l = x.lane
        if (x.restore) {
          l.cards = [...x.restore.cards]
          if (x.restore.pending) l.pending = [...x.restore.pending]
          else delete l.pending
        } else {
          queued.push({ lane: l.id, queuedAfter: await applyLaneList(ws, l, x.next, on, checks) })
        }
        l.updatedAt = new Date().toISOString()
      }
      // What its undo needs of each card it took off a lane (as it leaves this change: Move here's after its assignment).
      if (p.op !== 'undo') {
        await inWorkspace(ws, async () => {
          for (const [i, x] of p.lanes.entries()) {
            const b = before[i]
            const now = working(x.lane)
            for (const n of (b.pending ?? b.cards).filter((c) => !now.includes(c) && !back.some((y) => y.number === c))) {
              const head = cardUndo?.number === n ? cardUndo.head : headOf(await getTask(n, ws))
              back.push({ number: n, head, work: keepsWork(ws, x.lane, n) })
            }
          }
        })
      }
      return p
    }
  )
  // The revision each lane's save left it at: write() moved it on, on these records, in the save's transaction.
  const revOf = new Map(done.lanes.map((x) => [x.lane.id, x.lane.listRev ?? 0]))
  const undo: LaneEditUndo | null = done.op === 'undo' ? null : { lanes: before.map((b) => ({ before: { lane: b.lane, cards: b.cards, pending: b.pending }, rev: revOf.get(b.lane) ?? 0 })), card: cardUndo, back }
  log.info(`Lane edit (${done.op}) by the user: ${done.lanes.map((x) => `${x.lane.id} ${userText((x.lane.pending ?? x.lane.cards).map((n) => `#${n}`).join(', '))}`).join('; ')}`)
  // The builders of the lanes it changed, started on them if they aren't running (as laneStartCall does for the user's
  // and the Assistant's update of a lane); one that is running reads its list with cw_lane next.
  if (ws.path) for (const x of done.lanes) await laneEditHooks.resume(join(ws.path, x.lane.project), x.lane).catch((err: unknown) => log.warn(`resuming lane ${x.lane.id}'s builder`, err))
  // Each lane's revision now (HI-2932): the window's next quick edit names it, knowing only its own edit came between.
  return { op: done.op, card: done.card, lanes: (queued.length ? queued : done.lanes.map((x) => ({ lane: x.lane.id, queuedAfter: null }))).map((x) => ({ ...x, rev: revOf.get(x.lane) ?? 0 })), undo }
}
