// The reviewer pool (#1443, SPEC §16.10.5 G17): a lane started with Pool (`LaneRecord.pool`) has no reviewer of its
// own; each card of it submitted is given to the next free pooled reviewer, oldest submission first, and told so. What
// is owed is decided from durable state by one pass per project (`settleReviewerPool`), as slotCards' is:
// - **assign**: each pool card in Review whose latest submission nobody reviews (and has fewer passes than G1b asks) is
//   given to a free agent (shared/workflow/reviewerPool.ts): its role reviews, it holds no open dispatch lease (#1434: an
//   either agent building in a slot is never taken; one that can't be read counts as held), it is idle, it reviews no
//   other card of the project (in a lane or not; a card waiting on its own open question to the user doesn't count,
//   HI-2559: it stays its), it didn't build the card, and with G1b = 2 it isn't the submission's
//   first reviewer. Recorded as `ReviewerAssigned` in a write that checks again, as hive.db has it then, the submission
//   still waiting and the agent's leases and reviews (another Hive's or connection's change before it is seen there).
// - **tell**: the agent given the card is told, once per assignment (its delivery's identity is the card, the submission, the
//   agent and its `ReviewerAssigned`): typed into its conversation when it runs, else launched with it, for review (the project folder: #1434's
//   purpose, with #1439's grant to the review copies). One whose delivery wasn't given is told again at the next pass.
//   Checked again first: an agent that left, stopped reviewing or took a dispatch lease meanwhile is released from it
//   (`ReviewerReleased`) and the card given again.
// A verdict frees its reviewer for the next card. The pass runs when a submission or a verdict of a pool card asks
// (`assignReviewer`), when an agent's turn ends, when lanes or the board change, as a workspace opens, when the rules are
// switched, and hourly. With workflow rules off (Settings → Advanced) nothing is assigned or told.
// A **loose** card (HI-2046) is given out the same way: one in Review under reviewer-agent rules that no running lane
// holds (the runtime's own `card.lane`, lanes.ts's effective owner: no lane, or its lane ended), so a card started on its
// builder alone is reviewed with no Assistant step. Its reviewer is whoever is free, a stopped one started for it, as a
// pool's; a lane claiming it meanwhile (its reviewer reviews it then) gets it back, checked again in the write.
// A pool lane's **design step** (HI-2310) is given out the same way: the builder's design waiting for its check in Doing
// goes to the next free reviewer, oldest first among the submissions (`ReviewerAssigned` with `design`, its `submission`
// the step's own fact), told once, and freed by its answer (or the step ending). Whoever answers it is then the card's
// preferred reviewer (`preferredReviewer`): given its submissions first while free, else the next free one takes them.

import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import { running } from '../shared/lanes'
import { cardRef } from '../shared/projectKeys'
import type { LiveSessionState } from '../shared/types'
import { foldCard, passingReviewers, type CardState, type FactData } from '../shared/workflow/facts'
import { reviewerAgent } from '../shared/workflow/options'
import { designReviewer, heldOnUser, poolAssignments, preferredReviewer, reviewingNow, submissionReviewers, type PoolAgent, type PoolCard } from '../shared/workflow/reviewerPool'
import { agentWorkflowRole, reviewsWork } from '../shared/workflow/roles'
import { advanced } from './advanced'
import { boardRead } from './boardStore'
import { deliveriesOf, deliverNow, launchWith } from './deliveries'
import { onHiveEvent } from './events'
import { onLanesWritten, rawLanes } from './lanes'
import { readyFor } from './readiness'
import { createLogger, userText } from './logger'
import { withCardNames } from './projectKeys'
import { sessions } from './sessions'
import { onAction } from './workflow/actionWorker'
import type { CardRecord } from './workflow/factStore'
import { agentBusy } from './workflow/lineUpdates'
import type { Workflow } from './workflow/runtime'
import { agentRunsGoing, ENFORCE, workflowEnforced, workflowFor } from './workflow/service'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'
import { teamPauseOf } from './teamPause'

const log = createLogger('reviewerPool')

/** What a pool's delivery is made from: its identity is the card, the submission, the agent and the assignment, so it is made once per assignment. */
const POOL_REVIEW = 'pool-review'
/** A delivery that ended without reaching its agent (never given): made again. */
const NOT_GIVEN: ReadonlySet<string> = new Set(['cancelled', 'refused', 'expired', 'stale'])
/**
 * The statuses an agent isn't free in: in a turn, starting, waiting for the user, its background tasks, a sign-in. Not a
 * card watch (HI-2333): a watching session is at its prompt, where the pool's line is typed as into an idle one, and
 * Hive's loop wakes reach it; what it reviews or checks keeps it from the pool by itself (`reviewersNow`).
 */
const BUSY: ReadonlySet<string> = new Set(['working', 'starting', 'waiting', 'background', 'signin'])

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Whether an agent is idle: not running, or running with no turn, nothing typed or queued, no run or background task (a
 * card watch counts as idle, HI-2333), and able to take the pool's line now (`readyFor`'s `idle`, the need its line is
 * typed with): so the pass never gives or tells what the delivery would refuse, which a pass at each status change
 * would then try again at once.
 */
function idle(projectPath: string, agentId: string): boolean {
  const now = sessions.agentNow(projectPath, agentId)
  if (!now) return true
  if (BUSY.has(now.status) || agentBusy(projectPath, agentId) || now.backgroundTasks !== 0 || agentRunsGoing(projectPath, agentId).length !== 0) return false
  const st = sessions.liveFor(projectPath, agentId)
  return !st || readyFor(st, 'idle')
}

function cardOf(wf: Workflow, n: number): CardRecord | null {
  try {
    return wf.store.card(n)
  } catch {
    return null
  }
}

/** A card the pass looks at: a pool lane's, or a loose one's (held by no running lane, HI-2046), and which. */
type PassCard = PoolCard & { rec: CardRecord; loose: boolean }

/**
 * A card as the pass sees it: in Review under a reviewer agent's rules, with its latest submission's reviewers; given
 * out (`pool`) when its lane is the pool's or it has no running lane (loose, HI-2046). A pool lane's card in Doing with
 * its builder's design waiting for a check (HI-2310) is given out the same way, as that design step; a loose card's
 * design isn't (it has no lane to run a loop in).
 */
function poolCardOf(wf: Workflow, n: number, known: (id: string) => boolean): PassCard | null {
  const rec = cardOf(wf, n)
  if (!rec) return null
  const s = wf.state(rec)
  if (s.stage === 'active' && rec.reviewerPool && s.step?.step === 'design') {
    const facts = wf.store.facts(n)
    const { seen, reviewing } = submissionReviewers(facts, s.step.seq, known)
    return { rec, loose: false, card: n, submission: s.step.seq, submittedAt: s.step.at, design: true, pool: true, builders: s.builders, seen, reviewing, held: heldOnUser(s.requests, reviewing), quorum: 1, passes: 0, preferred: preferredReviewer(facts) }
  }
  if (s.stage !== 'review' || !s.latest) return null
  const r = wf.rulesetOf(rec, s)
  if (!reviewerAgent(r.options.review)) return null
  const facts = wf.store.facts(n)
  const sub = s.latest.id
  const { seen, reviewing } = submissionReviewers(facts, sub, known)
  const loose = !rec.lane
  return { rec, loose, card: n, submission: sub, submittedAt: facts.find((f) => f.seq === sub)?.at ?? '', pool: !!rec.reviewerPool || loose, builders: s.builders, seen, reviewing, held: heldOnUser(s.requests, reviewing), quorum: r.options.reviewers, passes: passingReviewers(s).length, preferred: rec.reviewerPool ? preferredReviewer(facts) : null }
}

/** Whether a card is still given out as it was when the pass read it: still the pool's, or still loose (held by no running lane). */
const stillGivenOut = (rec: CardRecord, loose: boolean): boolean => (loose ? !rec.lane : !!rec.reviewerPool)

/** Whether what was given out still waits as it did (a card's state now): its submission still its latest in Review, or its design (HI-2310) still open in Doing. */
const stillWaits = (s: CardState, c: Pick<PassCard, 'design' | 'submission'>): boolean => (c.design ? s.stage === 'active' && s.step?.step === 'design' && s.step.seq === c.submission : s.stage === 'review' && s.latest?.id === c.submission)

// --- The pass.

const passes = new Map<string, { again: boolean; done: Promise<void> }>()

/** The project's pass: coalesced, one at a time per project in this Hive (asked again while it runs, it runs once more). */
export function settleReviewerPool(ws: WorkspaceService, projectPath: string): Promise<void> {
  const key = `${(ws.path ?? '').toLowerCase()}\n${projectPath.toLowerCase()}`
  const now = passes.get(key)
  if (now) {
    now.again = true
    return now.done
  }
  const pass = { again: false, done: Promise.resolve() }
  pass.done = (async () => {
    try {
      do {
        pass.again = false
        await settleOnce(ws, projectPath).catch((e) => log.warn(`settling the reviewer pool of ${userText(projectPath)}`, e))
        poolTestHooks.passesRun++
      } while (pass.again && !ws.lifetime.aborted)
    } finally {
      passes.delete(key)
    }
  })()
  passes.set(key, pass)
  return pass.done
}

async function settleOnce(ws: WorkspaceService, projectPath: string): Promise<void> {
  // The team paused (HI-2081): nothing given out or told until it resumes (its end, a board change, passes again).
  if (!ws.path || ws.lifetime.aborted || !workflowEnforced() || teamPauseOf(ws)) return
  const project = basename(projectPath)
  const lanes = (await rawLanes(ws)).filter((l) => running(l) && same(l.project, project))
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  if (!wf) return
  const cfg = await ws.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  const known = (id: string): boolean => agents.some((a) => a.id === id)
  // The slots' project id (slotsApp's poolFor), for the dispatch leases read with the board.
  const slotProject = cfg.id ?? project
  // The pool lanes' cards waiting in Review, and the loose ones (HI-2046: in Review, held by no running lane): only they
  // are given out.
  const cards = new Map<number, PassCard>()
  for (const l of lanes.filter((x) => x.pool))
    for (const n of [...l.cards, ...(l.pending ?? [])]) {
      if (cards.has(n)) continue
      const c = poolCardOf(wf, n, known)
      if (c?.pool) cards.set(n, c)
    }
  for (const n of wf.store.cardsAt('review')) {
    if (cards.has(n)) continue
    const c = poolCardOf(wf, n, known)
    if (c?.loose && !c.design) cards.set(n, c)
  }
  if (!cards.size) return
  // Every agent's dispatch lease as hive.db has it; one that can't be read keeps that agent out (never assumed free).
  // Running ones first (HI-2046): a stopped reviewer is started only when no running one is free.
  const pool: PoolAgent[] = agents
    .map((a) => ({ id: a.id, role: agentWorkflowRole(a), leased: wf.store.dispatchLeased(slotProject, a.id) !== false, idle: idle(projectPath, a.id) }))
    .sort((a, b) => Number(!sessions.liveFor(projectPath, a.id)) - Number(!sessions.liveFor(projectPath, b.id)))
  for (const a of poolAssignments([...cards.values()], pool, reviewersNow(wf, known))) {
    if (!workflowEnforced() || ws.lifetime.aborted) return
    const c = cards.get(a.card)!
    const given = await wf.write(c.rec, null, 'hive', (w) => {
      // In this write, as hive.db has it now (another Hive's or connection's change committed before it is seen): the
      // same submission still waiting, and the agent still free of it, of every other card of the project in Review
      // (whatever its lane: none, ended, another's) and of any dispatch lease.
      const s = w.state()
      if (!stillWaits(s, c)) return false
      // Still given out as read (HI-2046): a lane that claimed a loose card meanwhile reviews it itself.
      if (!stillGivenOut(w.card, c.loose)) return false
      const now = submissionReviewers(w.tx.facts(a.card), a.submission, known)
      if (now.reviewing || now.seen.includes(a.reviewer) || (!c.design && passingReviewers(s).length >= c.quorum)) return false
      if (wf.store.dispatchLeased(slotProject, a.reviewer) !== false || reviewersNow(wf, known, a.card).has(a.reviewer)) return false
      w.fact('ReviewerAssigned', { reviewer: a.reviewer, submission: a.submission, ...(c.design ? { design: true as const } : {}) }) // i18n-ignore: a fact's kind and codes, not text
      return true
    })
    if (!given) continue
    log.info(`#${a.card} (${c.design ? 'design' : 'submission'} ${a.submission}) given to ${userText(agents.find((x) => x.id === a.reviewer)?.name ?? a.reviewer)} ${c.loose ? 'outside a lane' : 'from the pool'}`)
    cards.set(a.card, { ...c, reviewing: a.reviewer, seen: [...c.seen, a.reviewer] })
  }
  // Each pool card's reviewer given it and not started on it yet: told, once.
  for (const c of cards.values()) {
    if (!c.reviewing || c.reviewing === 'user') continue
    // A design (HI-2310) has no review to start: answered, it is no longer open, so the pass doesn't see it.
    const started = !c.design && (wf.state(cardOf(wf, c.card) ?? c.rec).reviewing[c.submission] ?? []).includes(c.reviewing)
    if (started || !workflowEnforced()) continue
    await tell(ws, projectPath, wf, slotProject, c).catch((e) => log.warn(`telling ${userText(c.reviewing ?? '')} of #${c.card} from the pool`, e))
  }
}

/**
 * Who reviews each of the project's cards in Review now (whatever its lane), or checks a design given out of one in
 * Doing (HI-2310), but `except`: a reviewer on one isn't free for another. Not one whose card waits on its own open
 * question to the user (HI-2559, `heldOnUser`): the card stays its, and it is free for others meanwhile. Read in a
 * write, it is that write's.
 */
function reviewersNow(wf: Workflow, known: (id: string) => boolean, except?: number): Set<string> {
  const out = new Set<string>()
  const add = (facts: ReturnType<Workflow['store']['facts']>, r: string | null | undefined): void => {
    if (r && !heldOnUser(foldCard(facts).requests, r)) out.add(r)
  }
  for (const n of wf.store.cardsAt('review')) {
    if (n === except) continue
    const facts = wf.store.facts(n)
    add(facts, reviewingNow(facts, known)?.reviewing)
  }
  for (const n of wf.store.cardsAt('active')) {
    if (n === except) continue
    const facts = wf.store.facts(n)
    add(facts, designReviewer(facts, known))
  }
  return out
}

/**
 * Tells a pooled reviewer of the card it was given: once per assignment (a delivery made before for it counts while it
 * was given or is still on its way, and its agent not running is started for it), typed into its conversation when it runs and is idle, else
 * launched with it for review. Checked again first, from the project and hive.db as they are now: an agent gone from
 * the project, one whose role no longer reviews, or one that took a dispatch lease (an either agent started a card) is
 * released from it (`ReviewerReleased`, in a write that finds it still given and not started) and the pass gives the
 * card again; one busy now, or whose lease can't be read, is told at a later pass.
 */
async function tell(ws: WorkspaceService, projectPath: string, wf: Workflow, slotProject: string, c: PassCard): Promise<void> {
  const agents = projectAgents(await ws.projectConfig(projectPath))
  const id = c.reviewing!
  const agent = agents.find((a) => a.id === id)
  const leased = wf.store.dispatchLeased(slotProject, id)
  const why = !agent ? 'gone' : !reviewsWork(agentWorkflowRole(agent)) ? 'notReviewer' : leased === true ? 'leased' : null
  if (why) return release(ws, projectPath, wf, c, id, why)
  if (!agent || leased !== false) return
  // Its identity is this assignment (its `ReviewerAssigned` fact): an agent released and given the same submission again
  // is a new assignment, told again (HR3's round 2), while the same one is told once.
  const assignment = wf.store.facts(c.card).findLast((f) => f.kind === 'ReviewerAssigned' && (f.data as FactData['ReviewerAssigned']).reviewer === id && (f.data as FactData['ReviewerAssigned']).submission === c.submission)
  if (!assignment) return
  const ref = `${c.card}:${c.submission}:${agent.id}:${assignment.seq}`
  // Still this assignment as it is given (HI-2046, HR1): the card still in Review on this submission, given out as read
  // (a lane claiming a loose card meanwhile takes it), still given to this agent, and the agent holding no dispatch lease.
  // Asked before either launch (a first one, or a retry for a delivery still on its way: HR1's round 1), as the line is
  // typed, and as a stopped one's launch spawns (sessions.start's `allowed`, after its awaits).
  const still = (): boolean => {
    if (teamPauseOf(ws)) return false
    const rec = cardOf(wf, c.card)
    if (!rec || !stillGivenOut(rec, c.loose)) return false
    if (!stillWaits(wf.state(rec), c)) return false
    return submissionReviewers(wf.store.facts(c.card), c.submission, (x) => agents.some((a) => a.id === x)).reviewing === agent.id && wf.store.dispatchLeased(slotProject, agent.id) === false
  }
  const allowed = (): void => {
    if (!still()) throw new Error(`${cardRef(c.card)}'s review is no longer ${agent.name}'s`) // i18n-ignore: for the log (the launch is refused)
  }
  const notStarted = (e: unknown): null => (log.info(`${userText(agent.name)} not started for #${c.card}: ${userText((e as Error).message)}`), null)
  const made = (await deliveriesOf(projectPath, agent.id)).find((r) => r.source === POOL_REVIEW && r.ref === ref && !NOT_GIVEN.has(r.state))
  const st = sessions.liveFor(projectPath, agent.id)
  if (made) {
    if (!st && (made.state === 'queued' || made.state === 'offered' || made.state === 'uncertain') && still()) await sessions.start(projectPath, { agentId: agent.id, purpose: 'review', allowed }).catch(notStarted)
    return
  }
  if (!idle(projectPath, agent.id) || !still()) return
  const builder = agents.find((a) => c.builders.includes(a.id))?.name
  // A follow-up carried to its reviewer (HR1's round 1): told to start again, as the runtime's follow-up wake said.
  const followUp = !!(wf.store.facts(c.card).find((f) => f.seq === c.submission)?.data as FactData['Submitted'] | undefined)?.followUp
  const body = withCardNames(ws, () =>
    c.design
      ? `${cardRef(c.card)}${builder ? ` (${builder}'s card)` : ''}: its builder posted a design for a check (${c.rec.key}/s${c.submission}), which you take from the pool. Read it (the card's latest comment) and answer with cw_loop_step, step ok or gaps, design ${c.rec.key}/s${c.submission}; not a review: no verdict. You're then preferred to review the card when it is submitted.` // i18n-ignore: agent-facing (HI-2310)
      : followUp
      ? `${cardRef(c.card)}${builder ? ` (${builder}'s card)` : ''}: follow-up submitted for review (submission ${c.submission}), still yours to review. Start your review again (cw_start_review), which takes it and moves your review copy to it; a verdict on the earlier submission is refused.` // i18n-ignore: agent-facing
      : `${cardRef(c.card)}${builder ? ` (${builder}'s card)` : ''} is in Review${c.loose ? ', outside a lane: you review it' : ': you review it from the pool'}. Review its latest submission with the review-agent-work skill; your verdict frees you for the next card.` // i18n-ignore: agent-facing (HI-2228: the skill, not its steps, which a model took for the whole review)
  )
  // agent-protocol: who a delivery is from: Combwork's own name (HI-2463)
  const nd = { agentId: agent.id, agentName: agent.name, kind: 'card-event' as const, from: { kind: 'hive' as const, name: 'Combwork' }, card: c.card, body, source: POOL_REVIEW, ref } // i18n-ignore: who a delivery is from, as agents read it
  log.info(`Telling ${userText(agent.name)} of #${c.card} ${c.loose ? 'outside a lane' : 'from the pool'} (${st ? 'typed' : 'started'})`)
  const r = st
    ? // As a wake (HI-2333): a reviewer watching a card in its loop takes it, and its watch carries on (`free` would
      // refuse it: a watching agent takes no new work).
      await deliverNow(projectPath, { ...nd, need: 'idle', conversation: st.sessionId || null }, still)
    : (
        await launchWith(projectPath, nd, (line) =>
          sessions.start(projectPath, { agentId: agent.id, prompt: line, purpose: 'review', allowed })
        ).catch((e) => ({ record: notStarted(e) }))
      ).record
  if (!r || NOT_GIVEN.has(r.state)) {
    log.info(`#${c.card}'s pool delivery to ${userText(agent.name)} wasn't given (${r?.state ?? 'none made'}): told at the next pass`)
    // Its next try (HI-2333): a pass when the agent's state changes, or this one shortly, for a refusal that changes
    // nothing it reports (the user typing, a watch's wake going first, a race at the boundary). Never at once.
    retrySoon(ws, projectPath)
  }
}

/**
 * How long a refused pool line waits for its retry pass (HI-2333), how many have fired, how many wait now, and how many
 * passes have run or are running (HI-2343: what its tests wait for); tests set `retryMs` shorter.
 */
export const poolTestHooks = { retryMs: 5000, retriesFired: 0, passesRun: 0, passesGoing: (): number => passes.size, retriesPending: (): number => [...retries.values()].reduce((n, m) => n + m.size, 0) }
/**
 * A project's pending retry pass, one at a time, by the workspace that armed it and the project: never re-armed while
 * it waits. It belongs to the lifetime it was armed in (HI-2343: a service closed and opened again, at the same path or
 * another, has a new one): that lifetime's end clears it, as the pool stopping does, so it never fires into the next.
 * The pass it runs checks everything again (the rules, the assignment still this agent's, its delivery not made already).
 */
const retries = new Map<WorkspaceService, Map<string, NodeJS.Timeout>>()
function retrySoon(ws: WorkspaceService, projectPath: string): void {
  const life = ws.lifetime
  const key = projectPath.toLowerCase()
  const mine = retries.get(ws) ?? new Map<string, NodeJS.Timeout>()
  if (mine.has(key) || life.aborted) return
  const forget = (): void => {
    clearTimeout(t)
    life.removeEventListener('abort', forget)
    if (mine.get(key) === t) mine.delete(key)
    if (!mine.size && retries.get(ws) === mine) retries.delete(ws)
  }
  const t = setTimeout(() => {
    poolTestHooks.retriesFired++
    forget()
    if (!life.aborted) void settleReviewerPool(ws, projectPath).catch((e) => log.warn('retrying the reviewer pool', e))
  }, poolTestHooks.retryMs)
  t.unref?.()
  life.addEventListener('abort', forget, { once: true })
  mine.set(key, t)
  retries.set(ws, mine)
}

/** A pool's assignment given up (`ReviewerReleased`) while it is still the submission's and not started; the pass again. */
async function release(ws: WorkspaceService, projectPath: string, wf: Workflow, c: PassCard, reviewer: string, why: FactData['ReviewerReleased']['why']): Promise<void> {
  const known = (): boolean => true
  const done = await wf.write(c.rec, null, 'hive', (w) => {
    const s = w.state()
    if (c.design ? !stillWaits(s, c) : s.latest?.id !== c.submission || (s.reviewing[c.submission] ?? []).includes(reviewer)) return false
    if (submissionReviewers(w.tx.facts(c.card), c.submission, known).reviewing !== reviewer) return false
    w.fact('ReviewerReleased', { reviewer, submission: c.submission, why, ...(c.design ? { design: true as const } : {}) }) // i18n-ignore: a fact's kind and codes, not text
    return true
  })
  if (!done) return
  log.info(`#${c.card} (${c.design ? 'design' : 'submission'} ${c.submission}) taken back from ${userText(reviewer)} (${why}): the pool gives it again`)
  void settleReviewerPool(ws, projectPath)
}

// --- What asks for a pass.

/** The project folder of a card on a workspace's board, by its board name; null for none. */
function projectOfCard(ws: WorkspaceService, card: number): string | null {
  const name = boardRead(ws, (db) => (db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string } | undefined)?.project) // i18n-ignore: SQL
  if (!name) return null
  return ws.info()?.projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.path ?? null
}

/** Every open workspace's projects with a running pool lane, or a card in Review (a loose one may wait, HI-2046): their passes. */
async function settleAll(): Promise<void> {
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    const names = new Set((await rawLanes(ws).catch(() => [])).filter((l) => running(l) && l.pool).map((l) => l.project.toLowerCase()))
    for (const p of inReview(ws)) names.add(p.toLowerCase())
    for (const p of ws.info()?.projects ?? []) if (names.has(p.name.toLowerCase())) await settleReviewerPool(ws, p.path)
  }
}

/** The projects (board names) with a card in Review, on the board now: where a loose card may wait for a reviewer. */
function inReview(ws: WorkspaceService): string[] {
  try {
    return boardRead(ws, (db) => (db.prepare("SELECT DISTINCT project FROM cards WHERE col = 'review' AND coalesce(archived, 0) = 0").all() as { project: string }[]).map((r) => r.project)) // i18n-ignore: SQL
  } catch {
    // A board still 0.9's, or closed: none.
    return []
  }
}

let stop: (() => void) | null = null

/** Starts the reviewer pool (index.ts, once): its action, and what asks for its passes. */
export function startReviewerPool(): void {
  if (stop) return
  onAction('assignReviewer', (a, ws) => {
    const p = projectOfCard(ws, a.card)
    if (p) void settleReviewerPool(ws, p)
  })
  const offLanes = onLanesWritten(() => void settleAll().catch((e) => log.warn("settling the lanes' reviewer pools", e)))
  // A board change (a card moved by hand into Review, a lane's card Done and its slot's lease ended), an agent's turn
  // ending, a workspace opening: looked at, at most once a second.
  let soon: NodeJS.Timeout | null = null
  const later = (): void => {
    if (soon) return
    soon = setTimeout(() => {
      soon = null
      void settleAll().catch((x) => log.warn('settling the reviewer pools', x))
    }, 1000)
    soon.unref?.()
  }
  // An agent's state as the pass reads it, by agent: a status event that changes none of it (a refused line's own, HI-2333) asks no pass.
  const seen = new Map<string, string>()
  const offEvents = onHiveEvent((e) => {
    if (e.type === 'tasks-changed' || e.type === 'workspace-changed' || e.type === 'team-pause-changed') later()
    else if (e.type === 'session-status') {
      const key = `${e.state.projectPath.toLowerCase()}#${e.state.agentId}`
      const now = poolStateKey(e.state, sessions.agentNow(e.state.projectPath, e.state.agentId))
      if (seen.get(key) === now) return
      seen.set(key, now)
      if (!freed(e.state)) return
      const ws = workspaceFor(e.state.projectPath)
      if (ws && !ws.isAssistantHome(e.state.projectPath)) void settleReviewerPool(ws, e.state.projectPath)
    }
  })
  let enforced = workflowEnforced()
  const offAdvanced = advanced.onChange(() => {
    if (workflowEnforced() === enforced) return
    enforced = workflowEnforced()
    void settleAll().catch((e) => log.warn(`settling the reviewer pools (${ENFORCE})`, e))
  })
  const hourly = setInterval(() => void settleAll().catch((e) => log.warn('settling the reviewer pools', e)), 60 * 60 * 1000)
  hourly.unref?.()
  stop = () => {
    offLanes()
    offEvents()
    offAdvanced()
    if (soon) clearTimeout(soon)
    clearInterval(hourly)
    for (const mine of retries.values()) for (const t of mine.values()) clearTimeout(t)
    retries.clear()
  }
}

/**
 * What of an agent's state its freedom for the pool reads (HI-2333): its status, turn, watch, hooks, a question or a
 * line not taken, input blocked, and its pending input and background tasks. Not its inbox: a delivery made or refused
 * changes only that, and a pass for it would try a refused line again at once.
 */
export function poolStateKey(st: LiveSessionState, now: { pending?: boolean; backgroundTasks?: number } | null): string {
  return JSON.stringify([st.status, st.turn?.state ?? null, !!st.watch, !!st.hooksMissing, !!st.question, !!st.untakenLine, !!st.inputBlocked, now?.pending ?? null, now?.backgroundTasks ?? null])
}

/** A status an agent may be free in (its turn ended, with a card watch or none, or it stopped). */
const freed = (st: LiveSessionState): boolean => !BUSY.has(st.status)

export function stopReviewerPool(): void {
  stop?.()
  stop = null
}
