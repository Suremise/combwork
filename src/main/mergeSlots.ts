import { CLAIM_WAIT_MAX_SECONDS, CLAIM_WAIT_SECONDS, holderText, holdingNote, waitingNote } from '../shared/mergeSlot'
import type { MergeSlotInfo } from '../shared/types'
import { msg, tr } from '../shared/i18n'

/** The window's notice that a merge slot expired (HI-2320: in the language Hive shows). */
const EXPIRED = {
  title: msg({ id: 'main.mergeSlot.expiredTitle', defaultMessage: "{agent}'s merge slot expired", description: "A notice's title: an agent ({agent}) held the merge slot longer than its limit without reporting progress, so Combwork gave it to the next agent in line." }),
  body: msg({ id: 'main.mergeSlot.expiredBody', defaultMessage: '{agent} held the merge slot for {branch} longer than its limit without reporting progress, so it went to the next in line. Check whether its merge finished.', description: "The notice that an agent's merge slot expired. {agent} is the agent, {branch} the branch it was merging into." })
}

/**
 * The merge slot (#350): one merge at a time into a project's branch. An agent claims it right before its final merge
 * (merge the base in, run the checks, merge, cards to Done) and releases it after, so the base can't move during its
 * checks; others wait in order. The user's merge from Hive's Merge dialog takes it too. Merges done outside Hive aren't
 * controlled: merge-ready's "has the base moved?" check still covers them.
 *
 * Everything here is synchronous between awaits (main's one thread), so a check and the change it allows can't be split
 * by another call. Never stuck: a hold ends with its session, after its time (reported, not silent), or when the user
 * releases it; a waiter that stops asking loses its place.
 */

/** How long a hold lasts; claiming again extends it, and so does a Progress run the holder keeps reporting to. */
export const HOLD_MS = 60 * 60_000
/** A waiter keeps its place this long between calls (a claim that timed out is called again). */
export const KEEP_PLACE_MS = 2 * 60_000
/** A holder whose open Progress run reported this recently isn't expired: it is still at work. */
export const PROGRESS_FRESH_MS = 15 * 60_000
/**
 * The longest a claim waits in one call: under 300 s, when Node's fetch (the hive tools') gives up waiting for a reply
 * (undici's headersTimeout).
 */
export const MAX_WAIT_MS = CLAIM_WAIT_MAX_SECONDS * 1000
/** A claim's wait when it names none. */
export const DEFAULT_WAIT_MS = CLAIM_WAIT_SECONDS * 1000
/** At most this many cards named as what is being merged. */
export const MAX_CARDS = 20
/** Slots kept (held, waited for, or unused); past it, unused ones are dropped as a new one is made. */
export const MAX_SLOTS = 500

/** An agent's launch: a hold or a place in line belongs to it, and ends with it. */
export interface SlotAgent {
  projectPath: string
  agentId: string
  agentName: string
  runId: string
}

/** What an agent's merge-slot note is about: holding the slot to merge into a branch, or waiting behind its holder. */
export type SlotNote = { holding: string } | { waitingFor: MergeSlotInfo['holder'] }

type Who = ({ kind: 'agent' } & SlotAgent) | { kind: 'user' }

interface Hold {
  /** This hold's own id: a Release confirmed for it releases it, never one that came after (#350 round 2). */
  id: string
  who: Who
  cards: number[]
  since: number
  until: number
  /** Given to a waiter between its calls: it takes it by claiming again before `until` (KEEP_PLACE_MS). */
  unconfirmed: boolean
  /** A claim has told its agent it holds it: no other call of that launch (one whose caller went away) can undo that. */
  delivered: boolean
}

interface Waiter {
  agent: SlotAgent
  cards: number[]
  since: number
  /** Its claims waiting now (0: between calls, keeping its place until lastSeen + KEEP_PLACE_MS). */
  calls: number
  lastSeen: number
}

interface Slot {
  projectPath: string
  branch: string
  hold: Hold | null
  queue: Waiter[]
  timer: NodeJS.Timeout | null
  /** Waiting claims, woken on every change to the slot. */
  wakers: Set<() => void>
}

/** Why an agent's hold ended without its release, told on its next merge-slot call. */
export interface LostHold {
  branch: string
  why: string
  at: number
}

export type ClaimResult =
  | { held: true; branch: string; until: number; extended: boolean; lost?: LostHold }
  | { held: false; branch: string; position: number; waiting: number; holder: MergeSlotInfo['holder']; lost?: LostHold }

export type ReleaseResult =
  | { released: true; branch: string; next: string | null; lost?: LostHold }
  | { left: true; branch: string; lost?: LostHold }
  | { none: true; branch: string; holder: MergeSlotInfo['holder']; yours: OwnSlot[]; lost?: LostHold }

/** A slot of the project the agent holds, or waits for (#586). */
export interface OwnSlot {
  branch: string
  held: boolean
}

export interface MergeSlotDeps {
  now: () => number
  /** Whether this launch of the agent still runs. */
  running: (agent: SlotAgent) => boolean
  /** When the agent's open Progress run last reported, or null without one. */
  progressAt: (agent: SlotAgent) => number | null
  /** A project's slots changed: tell its window, and keep the record. */
  changed: (projectPath: string) => void
  /** The agent's status note about the slot (null clears it). */
  /** The agent's status note (English), and what it is about, so the window can say it in its language (#847). */
  note: (agent: SlotAgent, text: string | null, about?: SlotNote) => void
  /** Tell the user something went wrong with a hold (an expiry). */
  warn: (projectPath: string, title: string, message: string) => void
  /** How long a hold lasts (HOLD_MS; test builds can shorten it). */
  holdMs?: number
}

/** A merge-slot call Hive refuses (status: the HTTP status the Agent API answers with). */
export class MergeSlotError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const key = (projectPath: string, branch: string): string => `${projectPath.toLowerCase()}#${branch}`
const agentKey = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/** The branch a slot is for, as given: trimmed, one line, not too long (it is only a key and a label). */
export function slotBranch(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new MergeSlotError(400, 'branch must be a branch name')
  const b = v.trim()
  if (b.length > 200 || /[\s\u0000-\u001f]/.test(b)) throw new MergeSlotError(400, 'branch must be a branch name')
  return b
}

/** The cards a merge is for, as given: whole card numbers, at most MAX_CARDS; none when left out. */
export function slotCards(v: unknown): number[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > MAX_CARDS || !v.every((n) => Number.isInteger(n) && n > 0 && n < 1e9)) throw new MergeSlotError(400, `cards must be up to ${MAX_CARDS} card numbers`)
  return [...new Set(v as number[])]
}

export class MergeSlots {
  /**
   * One Slot object per project and branch, kept for as long as anything may use it: an operation sweeps and changes the
   * object it got, so the map never drops it under one (only unused slots go, when a new one is made past MAX_SLOTS).
   */
  private slots = new Map<string, Slot>()
  private lost = new Map<string, LostHold>()
  private holds_ = 0

  private holdMs: number

  constructor(private deps: MergeSlotDeps) {
    this.holdMs = deps.holdMs ?? HOLD_MS
  }

  /** The slots of a project (those held or waited for), or of every project under a folder (a workspace). */
  list(under: string): MergeSlotInfo[] {
    const k = under.toLowerCase()
    const out: MergeSlotInfo[] = []
    for (const s of this.slots.values()) {
      const p = s.projectPath.toLowerCase()
      if (p !== k && !p.startsWith(`${k}\\`) && !p.startsWith(`${k}/`)) continue
      this.sweep(s)
      if (s.hold || s.queue.length) out.push(this.info(s))
    }
    return out.sort((a, b) => a.project.localeCompare(b.project) || a.branch.localeCompare(b.branch))
  }

  /** One slot's state (free when nobody holds or waits for it). */
  status(projectPath: string, branch: string): MergeSlotInfo {
    const s = this.slots.get(key(projectPath, branch))
    if (!s) return { project: projectPath, branch, holder: null, waiting: [] }
    this.sweep(s)
    return this.info(s)
  }

  /**
   * Claims the slot for the agent, waiting up to `waitMs` (in one call) for it. Claiming while holding it extends the
   * hold. A claim that times out keeps its place for KEEP_PLACE_MS, so calling again carries on in line; so does one
   * whose caller went away (`signal`), which is then between calls: a turn that comes meanwhile is only taken by
   * claiming again.
   */
  async claim(agent: SlotAgent, projectPath: string, branch: string, cards: number[], waitMs: number, signal?: AbortSignal): Promise<ClaimResult> {
    const lost = this.takeLost(agent, branch)
    const s = this.slot(projectPath, branch)
    this.sweep(s)
    const now = this.deps.now()
    if (this.holds(s, agent)) {
      const h = s.hold!
      const extended = !h.unconfirmed
      Object.assign(h, { until: now + this.holdMs, unconfirmed: false, delivered: true, ...(cards.length ? { cards } : {}) })
      this.settled(s)
      return { held: true, branch, until: h.until, extended, ...(lost ? { lost } : {}) }
    }
    let w = s.queue.find((x) => x.agent.agentId === agent.agentId)
    if (!w) {
      w = { agent, cards, since: now, calls: 0, lastSeen: now }
      s.queue.push(w)
    } else {
      // A new launch of the same agent takes over its place.
      w.agent = agent
      if (cards.length) w.cards = cards
    }
    w.calls++
    w.lastSeen = now
    try {
      this.promote(s)
      // In line (shown as waiting), or holding it already.
      this.settled(s)
      const end = now + Math.max(0, Math.min(waitMs, MAX_WAIT_MS))
      for (;;) {
        if (this.holds(s, agent) && signal?.aborted && !s.hold!.delivered) {
          // Its turn came as its caller went away: like a turn between calls, taken by claiming again soon. (Not when
          // another call of the same launch has already told the agent it holds it.)
          Object.assign(s.hold!, { until: this.deps.now() + KEEP_PLACE_MS, unconfirmed: true })
          this.settled(s)
          return { held: false, branch, position: 0, waiting: s.queue.length, holder: this.info(s).holder, ...(lost ? { lost } : {}) }
        }
        if (this.holds(s, agent)) {
          Object.assign(s.hold!, { until: this.deps.now() + this.holdMs, unconfirmed: false, delivered: true })
          this.settled(s)
          return { held: true, branch, until: s.hold!.until, extended: false, ...(lost ? { lost } : {}) }
        }
        // Gone from the line meanwhile (its launch ended, or the slot was given up for it).
        if (!s.queue.includes(w)) return { held: false, branch, position: 0, waiting: s.queue.length, holder: this.info(s).holder, ...(lost ? { lost } : {}) }
        const left = end - this.deps.now()
        if (left <= 0 || signal?.aborted) return { held: false, branch, position: s.queue.indexOf(w) + 1, waiting: s.queue.length, holder: this.info(s).holder, ...(lost ? { lost } : {}) }
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            clearTimeout(t)
            s.wakers.delete(wake)
            signal?.removeEventListener('abort', wake)
            resolve()
          }
          const t = setTimeout(wake, left)
          s.wakers.add(wake)
          signal?.addEventListener('abort', wake, { once: true })
        })
        this.sweep(s)
      }
    } finally {
      w.calls--
      w.lastSeen = this.deps.now()
      this.settled(s)
    }
  }

  /** Releases the agent's hold, or its place in line. */
  release(agent: SlotAgent, projectPath: string, branch: string): ReleaseResult {
    const lost = this.takeLost(agent, branch)
    const s = this.slots.get(key(projectPath, branch))
    if (!s) return { none: true, branch, holder: null, yours: this.own(agent, projectPath), ...(lost ? { lost } : {}) }
    this.sweep(s)
    if (this.holds(s, agent)) {
      this.end(s)
      this.promote(s)
      const next = s.hold?.who.kind === 'agent' ? s.hold.who.agentName : null
      this.settled(s)
      return { released: true, branch, next, ...(lost ? { lost } : {}) }
    }
    const i = s.queue.findIndex((x) => x.agent.agentId === agent.agentId)
    if (i >= 0) {
      s.queue.splice(i, 1)
      this.deps.note(agent, null)
      this.settled(s)
      return { left: true, branch, ...(lost ? { lost } : {}) }
    }
    return { none: true, branch, holder: this.info(s).holder, yours: this.own(agent, projectPath), ...(lost ? { lost } : {}) }
  }

  /** The slots of the project the agent holds or waits for, by branch. */
  own(agent: SlotAgent, projectPath: string): OwnSlot[] {
    const p = projectPath.toLowerCase()
    const out: OwnSlot[] = []
    for (const s of [...this.slots.values()]) {
      if (s.projectPath.toLowerCase() !== p) continue
      this.sweep(s)
      if (this.holds(s, agent)) out.push({ branch: s.branch, held: true })
      else if (s.queue.some((w) => w.agent.agentId === agent.agentId)) out.push({ branch: s.branch, held: false })
    }
    return out.sort((a, b) => a.branch.localeCompare(b.branch))
  }

  /**
   * The branch a release naming none is for (#586): the agent's one hold or place in line, whatever branch the project
   * folder is on now (merge-ready checks its branch out there after claiming); with none, the one whose hold it lost
   * (so the release tells it why). Null with several or none: the folder's branch decides.
   */
  releaseBranch(agent: SlotAgent, projectPath: string): string | null {
    const mine = this.own(agent, projectPath)
    if (mine.length === 1) return mine[0].branch
    if (mine.length) return null
    return this.lost.get(agentKey(projectPath, agent.agentId))?.branch ?? null
  }

  /**
   * The user releases the hold they were shown (`holdId`), a stuck holder; that agent is told on its next call. Refused
   * when the slot has changed hands since (a newer hold, even the same agent's, is never released for an older one).
   * Returns who it was.
   */
  releaseByUser(projectPath: string, branch: string, holdId: string): string {
    const s = this.slots.get(key(projectPath, branch))
    if (s) this.sweep(s)
    const h = s?.hold
    if (!s || !h || h.id !== holdId) throw new MergeSlotError(409, `The merge slot for ${branch} changed hands meanwhile, so nothing was released. Look again before releasing it.`)
    if (h.who.kind === 'agent') this.setLost(h.who, branch, 'the user released it')
    this.end(s)
    this.promote(s)
    this.settled(s)
    return h.who.kind === 'agent' ? h.who.agentName : 'you'
  }

  /** An agent's launch ended: its hold is released and its place in line given up. */
  sessionEnded(projectPath: string, agentId: string, runId: string): void {
    for (const s of [...this.slots.values()]) {
      if (s.projectPath.toLowerCase() !== projectPath.toLowerCase()) continue
      let changed = false
      if (s.hold?.who.kind === 'agent' && s.hold.who.agentId === agentId && s.hold.who.runId === runId) {
        this.end(s)
        changed = true
      }
      const before = s.queue.length
      s.queue = s.queue.filter((w) => !(w.agent.agentId === agentId && w.agent.runId === runId))
      if (changed || s.queue.length !== before) {
        this.promote(s)
        this.settled(s)
      }
    }
  }

  /**
   * Runs the user's merge holding the slot. Refused while an agent holds it or waits for it (the Merge dialog waits
   * until it is free): the user's merge doesn't jump the line.
   */
  async asUser<T>(projectPath: string, branch: string, fn: () => Promise<T>): Promise<T> {
    const s = this.slot(projectPath, branch)
    this.sweep(s)
    if (s.hold || s.queue.length) {
      const holder = this.info(s).holder
      this.settled(s)
      throw new MergeSlotError(409, holder ? `${holderText(holder)} into ${branch} (the merge slot): merge when it is done.` : `Agents are waiting to merge into ${branch} (the merge slot): merge when they are done.`)
    }
    const now = this.deps.now()
    // Its own hold, by id: when it ends it releases that one only, never a newer hold (the user may have released this
    // one meanwhile and started another merge).
    const mine = this.newHoldId()
    s.hold = { id: mine, who: { kind: 'user' }, cards: [], since: now, until: now + this.holdMs, unconfirmed: false, delivered: true }
    this.settled(s)
    try {
      return await fn()
    } finally {
      if (s.hold?.id === mine) this.end(s)
      this.promote(s)
      this.settled(s)
    }
  }

  /** The holds to keep across a restart (agents' only: the user's merge ends with Hive). */
  heldByAgents(): SlotRecord[] {
    const out: SlotRecord[] = []
    for (const s of this.slots.values()) if (s.hold?.who.kind === 'agent') out.push({ projectPath: s.projectPath, branch: s.branch, agentId: s.hold.who.agentId, agentName: s.hold.who.agentName, runId: s.hold.who.runId, cards: s.hold.cards, since: s.hold.since, until: s.hold.until })
    return out
  }

  /** Drops every slot (tests, and a workspace's at close when nothing of it runs). */
  dispose(): void {
    for (const s of this.slots.values()) {
      if (s.timer) clearTimeout(s.timer)
      for (const w of [...s.wakers]) w()
    }
    this.slots.clear()
    this.lost.clear()
  }

  // -------------------------------------------------------------------------

  private slot(projectPath: string, branch: string): Slot {
    const k = key(projectPath, branch)
    let s = this.slots.get(k)
    if (!s) {
      if (this.slots.size >= MAX_SLOTS) for (const [x, old] of this.slots) if (!old.hold && !old.queue.length && !old.wakers.size && !old.timer) this.slots.delete(x)
      s = { projectPath, branch, hold: null, queue: [], timer: null, wakers: new Set() }
      this.slots.set(k, s)
    }
    return s
  }

  private newHoldId(): string {
    return `h${++this.holds_}-${this.deps.now().toString(36)}`
  }

  private holds(s: Slot, agent: SlotAgent): boolean {
    return s.hold?.who.kind === 'agent' && s.hold.who.agentId === agent.agentId && s.hold.who.runId === agent.runId
  }

  /** Ends what has run out: holds whose launch ended or time passed, places nobody keeps. */
  private sweep(s: Slot): void {
    const now = this.deps.now()
    let changed = false
    const h = s.hold
    if (h?.who.kind === 'agent') {
      const who = h.who
      if (!this.deps.running(who)) {
        this.end(s)
        changed = true
      } else if (now >= h.until) {
        const reported = this.deps.progressAt(who)
        if (!h.unconfirmed && reported !== null && now - reported < PROGRESS_FRESH_MS) {
          // Still at work on it (its checks report progress): kept, and looked at again later.
          h.until = reported + PROGRESS_FRESH_MS
          changed = true
        } else {
          const why = h.unconfirmed ? `it was your turn, but you didn't claim it within ${Math.round(KEEP_PLACE_MS / 60000)} minutes` : `it expired after ${Math.round((now - h.since) / 60000)} minutes`
          this.setLost(who, s.branch, why)
          if (!h.unconfirmed) this.deps.warn(s.projectPath, tr(EXPIRED.title, { agent: who.agentName }), tr(EXPIRED.body, { agent: who.agentName, branch: s.branch }))
          this.end(s)
          changed = true
        }
      }
    }
    const before = s.queue.length
    s.queue = s.queue.filter((w) => {
      const keep = this.deps.running(w.agent) && (w.calls > 0 || now - w.lastSeen < KEEP_PLACE_MS)
      if (!keep) this.deps.note(w.agent, null)
      return keep
    })
    if (changed || s.queue.length !== before) this.promote(s)
    if (changed || s.queue.length !== before) this.settled(s)
  }

  /** A free slot goes to the first in line that still runs. */
  private promote(s: Slot): void {
    while (!s.hold && s.queue.length) {
      const w = s.queue.shift()!
      if (!this.deps.running(w.agent)) {
        this.deps.note(w.agent, null)
        continue
      }
      const now = this.deps.now()
      // Waiting in a call: it has it now. Between calls: it takes it by calling again soon.
      s.hold = { id: this.newHoldId(), who: { kind: 'agent', ...w.agent }, cards: w.cards, since: now, until: now + (w.calls > 0 ? this.holdMs : KEEP_PLACE_MS), unconfirmed: w.calls === 0, delivered: false }
    }
  }

  private end(s: Slot): void {
    const h = s.hold
    s.hold = null
    if (h?.who.kind === 'agent') this.deps.note(h.who, null)
  }

  /** After a change: status notes, waiting claims woken, the next deadline, the window told. The slot stays registered. */
  private settled(s: Slot): void {
    const holder = this.info(s).holder
    if (s.hold?.who.kind === 'agent') this.deps.note(s.hold.who, holdingNote(s.branch), { holding: s.branch })
    for (const w of s.queue) this.deps.note(w.agent, waitingNote(holder), { waitingFor: holder })
    for (const wake of [...s.wakers]) wake()
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    if (s.hold || s.queue.length) {
      const now = this.deps.now()
      const due = [s.hold?.until ?? Infinity, ...s.queue.filter((w) => w.calls === 0).map((w) => w.lastSeen + KEEP_PLACE_MS)]
      const next = Math.min(...due)
      if (Number.isFinite(next)) {
        // Looked at again when something is due; settled again either way, so a deadline is never left without a timer.
        s.timer = setTimeout(() => {
          s.timer = null
          this.sweep(s)
          if (!s.timer) this.settled(s)
        }, Math.max(1000, next - now + 50))
        s.timer.unref?.()
      }
    }
    this.deps.changed(s.projectPath)
  }

  private info(s: Slot): MergeSlotInfo {
    const h = s.hold
    return {
      project: s.projectPath,
      branch: s.branch,
      holder: h ? { id: h.id, kind: h.who.kind, ...(h.who.kind === 'agent' ? { agentId: h.who.agentId } : {}), name: h.who.kind === 'agent' ? h.who.agentName : 'you', cards: h.cards, since: h.since, until: h.until, taken: !h.unconfirmed } : null,
      waiting: s.queue.map((w) => ({ agentId: w.agent.agentId, name: w.agent.agentName, cards: w.cards, since: w.since }))
    }
  }

  private setLost(agent: SlotAgent, branch: string, why: string): void {
    this.lost.set(agentKey(agent.projectPath, agent.agentId), { branch, why, at: this.deps.now() })
  }

  private takeLost(agent: SlotAgent, branch: string): LostHold | undefined {
    const k = agentKey(agent.projectPath, agent.agentId)
    const l = this.lost.get(k)
    if (!l || l.branch !== branch) return undefined
    this.lost.delete(k)
    return l
  }
}

/** An agent's hold as the workspace's record keeps it, to tell the user about one Hive closed under. */
export interface SlotRecord {
  projectPath: string
  /** The project's stable id (#508): the record is told against the folder that has it now. */
  projectId?: string
  branch: string
  agentId: string
  agentName: string
  runId: string
  cards: number[]
  since: number
  until: number
  /** The folder its agent worked in (#984): where a merge Hive closed under was, its worktree or the main checkout. */
  cwd?: string
}

/** The holds in a record file's text; anything malformed is left out (it is only read to warn the user). */
export function parseSlotRecords(text: string): SlotRecord[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const holds = (data as { holds?: unknown })?.holds
  if (!Array.isArray(holds)) return []
  const str = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
  const out: SlotRecord[] = []
  for (const h of holds.slice(0, 200)) {
    if (!h || typeof h !== 'object') continue
    const r = h as Record<string, unknown>
    if (!str(r.projectPath, 1000) || !str(r.branch, 200) || !str(r.agentId) || !str(r.agentName) || !str(r.runId)) continue
    const cards = Array.isArray(r.cards) ? r.cards.filter((n): n is number => Number.isInteger(n) && (n as number) > 0).slice(0, MAX_CARDS) : []
    out.push({ projectPath: r.projectPath, ...(str(r.projectId, 64) ? { projectId: r.projectId } : {}), branch: r.branch, agentId: r.agentId, agentName: r.agentName, runId: r.runId, cards, since: Number(r.since) || 0, until: Number(r.until) || 0, ...(str(r.cwd, 1000) ? { cwd: r.cwd } : {}) })
  }
  return out
}
