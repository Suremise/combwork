// Reviewers review in review copies (#1439, SPEC §16.10.5): start review leases the reviewer a copy at the exact revision
// it reviews (copies.ts, #1435's pool), and the review's end returns it, to be freed only through the pool's quiescence
// barrier. The reviewer's session stays in the project folder (#1434); its launch was granted the project's copies
// folder (sessions.ts, `extraDirs`), so it reads and runs commands in the copy, and a run there is a check of the copy's
// card and revision (runLink.ts).
//
// - Start review (the card's review mark set for the agent, by the old move or start review): a copy is leased for the
//   card's latest submission. Ready within a moment, the reply names its folder; else the reply says it waits, the
//   card's history says so, and the reviewer is told once it is leased (a message in its inbox). Waiting reviews lease
//   again after each look at the pools (every 30 s, copiesApp.ts), when copies have come free.
// - The review's end returns it: a verdict at once; the review given up (the card moved on, its review mark gone, the
//   reviewer's session ended: tasks.ts ends its reviews) at the pools' next look (`over`). A pass made stale by a
//   decision (§16.4.6) is reviewed again: that start review leases one again.
// - Not leased: with review copies off (Settings → Advanced, Reviewers review in review copies) or workflow rules not
//   enforced (Workflow rules are enforced: off, Hive records facts and acts on none, so nothing is leased, a review
//   waiting for one is dropped and told, and one leased as it was turned off is returned; copies out are still returned
//   and freed), or for a session that wasn't granted the folder (a provider without `extraDirs`, a session started before it was on): its reviewer reviews
//   the builder's folder read-only as before.
//
// What it tells agents is English; what the window shows is the card's history, as messages.

import { advanced } from './advanced'
import { leaveMessage } from './agentMessages'
import { setReviewCopyWaitReason } from './cardStall'
import { copiesFor, setReviewCopyHooks } from './copiesApp'
import { copiesDirOf, copyRefusalText, FIRST_WAIT_MS, type CopyLease, type CopyPool } from './copies'
import { samePlace } from './fsutil'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { cardNamesOf, scopeOfHost } from './projectKeys'
import { openWorkspaces, type WorkspaceService } from './workspace'
import { COPIES_REVIEW, WORKFLOW_ENFORCE } from '../shared/advanced'
import { HISTORY, storedText } from '../shared/taskHistory'
import type { StoredText } from '../shared/types'

const log = createLogger('copies')

/** The most reviews waiting for a copy one project keeps: the oldest is dropped (told nothing more) past it. */
const MAX_WAITING = 50

/** A reviewer: the agent's id (what leases and the card's review mark hold) and its name. */
export interface Reviewer {
  id: string
  name: string
}

/** What a start review came to: a copy (its folder and revision), waiting for one, or none (why). */
export type ReviewCopyAnswer = { is: 'ready'; copy: string; folder: string; revision: string } | { is: 'waiting'; why: string } | { is: 'none'; why: string }

/** A card's review as it is now, for one reviewer: whether its review is going, and the submission it reviews. */
export interface ReviewNow {
  going: boolean
  submission: number | null
  revision: string | null
}

export interface ReviewCopyDeps {
  pool: () => Promise<CopyPool>
  /** The card's review now: whether `agent` (its id) has its review going on it, and the card's latest submission. */
  review: (card: number, agent: string) => Promise<ReviewNow>
  /** Tells a reviewer that waited its copy is ready (its inbox). */
  tell: (agent: Reviewer, card: number, text: string) => Promise<void>
  /** How the reviewer's texts name a card (HI-1661: its key); `#N` by default. */
  cardName?: (card: number) => string
  /** A line of the card's history, for the window. */
  note: (card: number, text: StoredText) => Promise<void>
  /** How long a start waits for a copy before replying that it waits (a first copy's setup takes minutes). */
  firstWaitMs?: number
  /** Why review copies are off now (a switch), read at each step; null while they are on. */
  off: () => string | null
}

interface Waiting {
  card: number
  agent: Reviewer
  revision: string
  submission: number
  why: string
  /** A lease under way (its reset or setup), never two at once. */
  leasing: Promise<ReviewCopyAnswer> | null
  /** Whether it was told it waits: it is told again once it has a copy. */
  told: boolean
  /** When it began waiting (ms): a lane watch counts a wait past COPY_WAIT_STALL_MS as stalled (HI-1764). */
  since: number
}

/** How long a review waits for a copy before a lane watch counts its card stalled (HI-1764). */
export const COPY_WAIT_STALL_MS = 5 * 60_000

/**
 * Why every copy is in use, for a waiting reviewer (HI-1764: it was told only "pending"), in one short clause (the reply
 * stays lean): how many there are, then the copy most likely to come free first, with since when: a returned one and what
 * holds it back, else the one lent longest and what for. Agent-facing.
 */
export function copiesInUseText(held: ReturnType<CopyPool['inUse']>, name: (card: number) => string, now = Date.now()): string {
  const ago = (iso: string): string => `${Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))} min`
  const all = `the pool's ${held.length} ${held.length === 1 ? 'copy is' : 'copies are'} in use` // i18n-ignore: agent-facing
  const back = held.filter((h) => h.returned).sort((a, b) => a.returned!.localeCompare(b.returned!))[0]
  if (back) return `${all}; ${back.copy}, returned ${ago(back.returned!)} ago, is ${back.by ? `held back by ${back.by}` : 'being freed'}` // i18n-ignore: agent-facing
  const lent = [...held].sort((a, b) => a.from.localeCompare(b.from))[0]
  return lent ? `${all}; the longest lent, ${lent.copy}, for ${ago(lent.from)} (a ${lent.kind} of ${name(lent.card)})` : all // i18n-ignore: agent-facing
}

const key = (card: number, agent: string): string => `${card}|${agent}`

/** The line an agent's start review reply, or its later message, gives for a copy. */
export function reviewCopyText(a: ReviewCopyAnswer, card?: string): string {
  if (a.is === 'ready') return `${card !== undefined ? `${card}'s review copy is ready. ` : ''}Review in ${a.folder} at ${a.revision.slice(0, 12)}: read and run commands there, with it as their working directory; your session stays where it is.` // i18n-ignore: agent-facing
  if (a.is === 'waiting') return `Waiting for a review copy (${a.why}): Hive tells you when one is ready, with its folder. Meanwhile git can show the submission from where you are.` // i18n-ignore: agent-facing
  return `No review copy (${a.why}): review the builder's work read-only from where you are.` // i18n-ignore: agent-facing
}

/** One project's review copies: the leases start review makes, the reviews waiting for one, and their returns. */
export class ReviewCopies {
  private readonly waiting = new Map<string, Waiting>()

  constructor(private readonly deps: ReviewCopyDeps) {}

  private named(card: number): string {
    return this.deps.cardName?.(card) ?? `#${card}`
  }

  /** The reviews waiting for a copy now (cards and reviewers), since when (ms) and why. */
  waits(): { card: number; agent: string; name: string; since: number; why: string }[] {
    return [...this.waiting.values()].map((w) => ({ card: w.card, agent: w.agent.id, name: w.agent.name, since: w.since, why: w.why }))
  }

  private mine(pool: CopyPool, card: number, agent: string): CopyLease[] {
    return pool.unfreed().filter((l) => l.kind === 'review' && l.card === card && l.agent === agent && !l.returned)
  }

  /**
   * Start review: a copy for the card's latest submission, leased now, or waiting for one. Starting again with a copy at
   * that revision keeps it; one at an earlier submission's is returned first.
   */
  async start(card: number, agent: Reviewer): Promise<ReviewCopyAnswer> {
    const off = this.deps.off()
    if (off) return { is: 'none', why: off }
    const now = await this.deps.review(card, agent.id)
    if (!now.going) return { is: 'none', why: 'the review is not going' } // i18n-ignore: agent-facing
    if (!now.revision || now.submission === null) return { is: 'none', why: 'the card has no submitted revision' } // i18n-ignore: agent-facing
    const pool = await this.deps.pool()
    const k = key(card, agent.id)
    const going = this.waiting.get(k)
    // Its lease under way (the copy being reset or set up) is that one, not one to return.
    for (const l of going?.leasing && going.revision === now.revision ? [] : this.mine(pool, card, agent.id)) {
      const copy = pool.copies().find((c) => c.name === l.copy)
      if (l.revision === now.revision && copy && copy.state === 'leased') return { is: 'ready', copy: copy.name, folder: copy.folder, revision: l.revision }
      await pool.returnCopy(l.id, 'resubmitted')
    }
    let w = going
    if (w && w.revision !== now.revision) {
      this.waiting.delete(k)
      w = undefined
    }
    if (!w) {
      while (this.waiting.size >= MAX_WAITING) this.waiting.delete(this.waiting.keys().next().value!)
      w = { card, agent, revision: now.revision, submission: now.submission, why: 'one is being set up', leasing: null, told: false, since: Date.now() } // i18n-ignore: agent-facing
      this.waiting.set(k, w)
    }
    const leasing = this.attempt(w)
    let timer: NodeJS.Timeout | undefined
    const first = await Promise.race([leasing, new Promise<null>((r) => (timer = setTimeout(() => r(null), this.deps.firstWaitMs ?? FIRST_WAIT_MS)))])
    clearTimeout(timer)
    if (first && first.is !== 'waiting') return first
    // Still leasing (a setup), or none free: it waits, said on the card once.
    if (!w.told && this.waiting.get(k) === w) {
      w.told = true
      await this.deps.note(card, storedText(HISTORY.reviewCopyWaiting, { agent: agent.name })).catch(() => undefined)
    }
    return { is: 'waiting', why: first?.is === 'waiting' ? first.why : w.why }
  }

  /** One try at leasing a waiting review's copy (never two at once): ready (and told, when it was told it waits), waiting, or none. */
  private attempt(w: Waiting): Promise<ReviewCopyAnswer> {
    if (w.leasing) return w.leasing
    const k = key(w.card, w.agent.id)
    const run = async (): Promise<ReviewCopyAnswer> => {
      const pool = await this.deps.pool()
      const r = await pool.leaseCopy({ kind: 'review', card: w.card, revision: w.revision, agent: w.agent.id, ref: String(w.submission) })
      if (!r.ok) {
        const why = r.refusal.why
        if (why === 'noCopy' || why === 'stillInUse' || why === 'returned') {
          // Past Settings → Advanced's bound, what still uses the copy held back (copies.ts); before it, what holds each.
          w.why = why === 'stillInUse' ? copyRefusalText(r.refusal) : copiesInUseText(pool.inUse(), (c) => this.named(c))
          return { is: 'waiting', why: w.why }
        }
        if (this.waiting.get(k) === w) this.waiting.delete(k)
        const none: ReviewCopyAnswer = { is: 'none', why: copyRefusalText(r.refusal) }
        if (w.told) await this.deps.tell(w.agent, w.card, `${this.named(w.card)}: ${reviewCopyText(none)}`).catch(() => undefined)
        return none
      }
      // Its review may have ended while the copy was set up, or review copies been turned off: returned, never handed over.
      const still = await this.deps.review(w.card, w.agent.id).catch(() => null)
      const off = this.deps.off()
      if (this.waiting.get(k) !== w || !still?.going || still.revision !== w.revision || off) {
        await pool.returnCopy(r.lease.id, off ? 'off' : 'abandoned')
        if (this.waiting.get(k) === w) this.waiting.delete(k)
        const none: ReviewCopyAnswer = { is: 'none', why: off ?? 'the review ended' } // i18n-ignore: agent-facing
        if (off && w.told) await this.deps.tell(w.agent, w.card, `${this.named(w.card)}: ${reviewCopyText(none)}`).catch(() => undefined)
        return none
      }
      this.waiting.delete(k)
      const got: ReviewCopyAnswer = { is: 'ready', copy: r.copy.name, folder: r.copy.folder, revision: w.revision }
      await this.deps.note(w.card, storedText(HISTORY.reviewCopyLeased, { agent: w.agent.name, copy: r.copy.name, revision: w.revision.slice(0, 12) })).catch(() => undefined)
      if (w.told) await this.deps.tell(w.agent, w.card, reviewCopyText(got, this.named(w.card))).catch((e) => log.warn(`Could not tell ${userText(w.agent.name)} its review copy is ready`, e))
      return got
    }
    const p = run().finally(() => {
      w.leasing = null
    })
    w.leasing = p
    return p
  }

  /** After a look at the pools: each waiting review whose review still goes tries again; one that ended is dropped. */
  async retry(): Promise<void> {
    const off = this.deps.off()
    for (const [k, w] of [...this.waiting]) {
      if (w.leasing) continue
      // Turned off while it waited: dropped, and told (a lease under way is handled where it ends).
      if (off) {
        this.waiting.delete(k)
        if (w.told) await this.deps.tell(w.agent, w.card, `${this.named(w.card)}: ${reviewCopyText({ is: 'none', why: off })}`).catch(() => undefined)
        continue
      }
      const now = await this.deps.review(w.card, w.agent.id).catch(() => null)
      if (!now?.going || now.revision !== w.revision) {
        this.waiting.delete(k)
        continue
      }
      await this.attempt(w).catch((e) => log.warn(`Leasing a review copy for #${w.card}`, e))
    }
  }

  /** A review's end (a verdict): its copies returned, freed through the barrier; a wait for one dropped. How many it returned. */
  async end(card: number, agent: string, why: string): Promise<number> {
    this.waiting.delete(key(card, agent))
    const pool = await this.deps.pool()
    let n = 0
    for (const l of this.mine(pool, card, agent)) if (await pool.returnCopy(l.id, why)) n++
    return n
  }

  /** Whether a review lease's review is over (the pools' look returns it then): its review no longer going, or another revision's. */
  async over(l: CopyLease): Promise<boolean | null> {
    if (l.kind !== 'review' || !l.agent) return null
    const now = await this.deps.review(l.card, l.agent).catch(() => null)
    if (!now) return null
    return !now.going || (now.revision !== null && now.revision !== l.revision)
  }
}

// --- The app's: one per open workspace and project, on that workspace's board.

const instances = new Map<string, { life: AbortSignal; rc: ReviewCopies }>()
const instanceKey = (ws: WorkspaceService, projectPath: string): string => `${(ws.path ?? '').toLowerCase()}\n${projectPath.toLowerCase()}`

/** A card's review as the board and its facts say: its review mark (an agent's), its column, its latest submission. */
async function reviewOf(ws: WorkspaceService, projectPath: string, card: number, agent: string): Promise<ReviewNow> {
  const { getTask } = await import('./tasks')
  const c = await getTask(card, ws)
  const going = !c.archived && c.column === 'review' && c.review?.agent === agent
  const { workflowFor } = await import('./workflow/service')
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  let latest: { id: number; revision: string | null } | null = null
  try {
    latest = wf ? wf.state(card).latest : null
  } catch {
    // A card the runtime doesn't have (0.9's): no submission.
  }
  return { going, submission: latest?.id ?? null, revision: latest?.revision ?? null }
}

/**
 * Why a card in Review is stalled waiting for a review copy (HI-1764), or null: a review of it (in `waits`) has waited
 * COPY_WAIT_STALL_MS or more, so a lane watch notices reviewers kept from reviewing. Agent-facing.
 */
export function copyWaitStall(c: { number: number; key?: string; column: string }, waits: ReturnType<ReviewCopies['waits']>, now = Date.now()): string | null {
  if (c.column !== 'review') return null
  const w = waits.find((x) => x.card === c.number && now - x.since >= COPY_WAIT_STALL_MS)
  return w ? `${c.key ?? `#${c.number}`}'s review by ${w.name} has waited ${Math.round((now - w.since) / 60_000)} min for a review copy: ${w.why}.` : null // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** copyWaitStall over the reviews waiting in a workspace (by its folder): the lane watches' (cardStall.ts). */
export function reviewCopyWaitReason(c: { number: number; key?: string; column: string }, wsPath: string | null): string | null {
  if (c.column !== 'review' || !wsPath) return null
  const ws = `${wsPath.toLowerCase()}\n`
  for (const [k, v] of instances) {
    const why = k.startsWith(ws) && !v.life.aborted ? copyWaitStall(c, v.rc.waits()) : null
    if (why) return why
  }
  return null
}

// Given to cardStall as this loads, rather than imported by it (HI-1785).
setReviewCopyWaitReason(reviewCopyWaitReason)

/** Why review copies are off now (agent-facing): either switch in Settings → Advanced. Null while both are on. */
function reviewCopiesOff(): string | null {
  if (advanced.get(COPIES_REVIEW) === false) return 'review copies are off (Settings → Advanced, Reviewers review in review copies)' // i18n-ignore: agent-facing
  if (advanced.get<boolean>(WORKFLOW_ENFORCE) === false) return "workflow rules aren't enforced (Settings → Advanced, Workflow rules are enforced)" // i18n-ignore: agent-facing
  return null
}

/** A project's review copies in a workspace (made on first use, for the workspace's life). */
export function reviewCopiesFor(ws: WorkspaceService, projectPath: string): ReviewCopies {
  const k = instanceKey(ws, projectPath)
  const known = instances.get(k)
  if (known && known.life === ws.lifetime && !known.life.aborted) return known.rc
  const rc = new ReviewCopies({
    pool: () => copiesFor(ws, projectPath),
    review: (card, agent) => reviewOf(ws, projectPath, card, agent),
    tell: async (agent, card, text) => void (await leaveMessage(projectPath, agent.id, agent.name, { kind: 'hive', name: 'Hive' }, text, card)), // i18n-ignore: the sender's name agents read
    cardName: (card) => cardNamesOf(ws, scopeOfHost(projectPath))(card),
    note: async (card, text) => {
      const { noteOnCard } = await import('./tasks')
      await noteOnCard(card, text, ws)
    },
    off: reviewCopiesOff
  })
  instances.set(k, { life: ws.lifetime, rc })
  return rc
}

/**
 * Start review by an agent (its review mark now set on the card): the line its reply gives about its review copy, or
 * null when it gets none (review copies off, or its session wasn't granted the copies folder).
 */
export async function reviewCopyOnStart(ws: WorkspaceService, projectPath: string, card: number, agent: Reviewer): Promise<string | null> {
  if (reviewCopiesOff()) return null
  const folder = copiesDirOf(ws.worktreesRoot, projectPath)
  if (!sessions.grantedDirs(projectPath, agent.id).some((d) => samePlace(d, folder))) return null
  const a = await reviewCopiesFor(ws, projectPath)
    .start(card, agent)
    .catch((e: Error): ReviewCopyAnswer => ({ is: 'none', why: `it couldn't be leased: ${e.message}` })) // i18n-ignore: agent-facing
  return reviewCopyText(a)
}

/** A verdict by an agent: its review copies of the card returned (freed once quiet), any wait for one dropped. */
export async function reviewCopyOnVerdict(ws: WorkspaceService, projectPath: string, card: number, agentId: string): Promise<void> {
  await reviewCopiesFor(ws, projectPath)
    .end(card, agentId, 'verdict')
    .catch((e) => log.warn(`Returning #${card}'s review copy`, e))
}

/** Hooks the pools' looks (copiesApp.ts): review leases whose review is over returned, waiting reviews leasing again. */
export function startReviewCopies(): void {
  setReviewCopyHooks({
    over: (ws, projectPath, l) => reviewCopiesFor(ws, projectPath).over(l),
    afterLook: async () => {
      const open = new Set(openWorkspaces())
      for (const [k, v] of [...instances]) {
        if (v.life.aborted) {
          instances.delete(k)
          continue
        }
        if (![...open].some((ws) => ws.lifetime === v.life)) continue
        await v.rc.retry()
      }
    }
  })
}

export function stopReviewCopies(): void {
  setReviewCopyHooks(null)
}
