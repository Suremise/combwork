// The reviewer pool (#1443, SPEC §16.10.5 G17): a lane started with Pool (`LaneRecord.pool`) has no reviewer of its
// own; each card of it submitted is given to the next free pooled reviewer, oldest submission first, and told so. What
// is owed is decided from durable state by one pass per project (`settleReviewerPool`), as slotCards' is:
// - **assign**: each pool card in Review whose latest submission nobody reviews (and has fewer passes than G1b asks) is
//   given to a free agent (shared/workflow/reviewerPool.ts): its role reviews, it holds no open dispatch lease (#1434: an
//   either agent building in a slot is never taken), it is idle, it reviews no other card, it didn't build the card,
//   and with G1b = 2 it isn't the submission's first reviewer. Recorded as `ReviewerAssigned` in a write that finds the
//   submission still waiting.
// - **tell**: the agent given the card is told, once (its delivery's identity is the card, the submission and the
//   agent): typed into its conversation when it runs, else launched with it, for review (the project folder: #1434's
//   purpose, with #1439's grant to the review copies). One whose delivery wasn't given is told again at the next pass.
// A verdict frees its reviewer for the next card. The pass runs when a submission or a verdict of a pool card asks
// (`assignReviewer`), when an agent's turn ends, when lanes or the board change, as a workspace opens, when the rules are
// switched, and hourly. With workflow rules off (Settings → Advanced) nothing is assigned or told.

import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import { running } from '../shared/lanes'
import { cardRef } from '../shared/projectKeys'
import type { AgentDef, LiveSessionState } from '../shared/types'
import { passingReviewers } from '../shared/workflow/facts'
import { reviewerAgent } from '../shared/workflow/options'
import { poolAssignments, submissionReviewers, type PoolAgent, type PoolCard } from '../shared/workflow/reviewerPool'
import { agentWorkflowRole } from '../shared/workflow/roles'
import { advanced } from './advanced'
import { boardRead } from './boardStore'
import { deliveriesOf, deliverNow, launchWith } from './deliveries'
import { onHiveEvent } from './events'
import { onLanesWritten, rawLanes } from './lanes'
import { createLogger, userText } from './logger'
import { withCardNames } from './projectKeys'
import { sessions } from './sessions'
import { poolFor } from './slotsApp'
import { onAction } from './workflow/actionWorker'
import type { CardRecord } from './workflow/factStore'
import { agentBusy } from './workflow/lineUpdates'
import type { Workflow } from './workflow/runtime'
import { agentRunsGoing, ENFORCE, workflowEnforced, workflowFor } from './workflow/service'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

const log = createLogger('reviewerPool')

/** What a pool's delivery is made from: its identity is the card, the submission and the agent, so it is made once. */
const POOL_REVIEW = 'pool-review'
/** A delivery that ended without reaching its agent (never given): made again. */
const NOT_GIVEN: ReadonlySet<string> = new Set(['cancelled', 'refused', 'expired', 'stale'])
/** The statuses an agent isn't free in (Start Lane's): in a turn, starting, waiting for the user, its background tasks, a watch, a sign-in. */
const BUSY: ReadonlySet<string> = new Set(['working', 'starting', 'waiting', 'background', 'watching', 'signin'])

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Whether an agent is idle: not running, or running with no turn, nothing typed or queued, no run or background task, no watch. */
function idle(projectPath: string, agentId: string): boolean {
  const now = sessions.agentNow(projectPath, agentId)
  if (!now) return true
  return !BUSY.has(now.status) && !agentBusy(projectPath, agentId) && now.backgroundTasks === 0 && agentRunsGoing(projectPath, agentId).length === 0
}

function cardOf(wf: Workflow, n: number): CardRecord | null {
  try {
    return wf.store.card(n)
  } catch {
    return null
  }
}

/** A lane card as the pool sees it: in Review under a reviewer agent's rules, with its latest submission's reviewers. */
function poolCardOf(wf: Workflow, n: number, known: (id: string) => boolean): (PoolCard & { rec: CardRecord }) | null {
  const rec = cardOf(wf, n)
  if (!rec) return null
  const s = wf.state(rec)
  if (s.stage !== 'review' || !s.latest) return null
  const r = wf.rulesetOf(rec, s)
  if (!reviewerAgent(r.options.review)) return null
  const facts = wf.store.facts(n)
  const sub = s.latest.id
  const { seen, reviewing } = submissionReviewers(facts, sub, known)
  return { rec, card: n, submission: sub, submittedAt: facts.find((f) => f.seq === sub)?.at ?? '', pool: !!rec.reviewerPool, builders: s.builders, seen, reviewing, quorum: r.options.reviewers, passes: passingReviewers(s).length }
}

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
      } while (pass.again && !ws.lifetime.aborted)
    } finally {
      passes.delete(key)
    }
  })()
  passes.set(key, pass)
  return pass.done
}

async function settleOnce(ws: WorkspaceService, projectPath: string): Promise<void> {
  if (!ws.path || ws.lifetime.aborted || !workflowEnforced()) return
  const project = basename(projectPath)
  const lanes = (await rawLanes(ws)).filter((l) => running(l) && same(l.project, project))
  if (!lanes.some((l) => l.pool)) return
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  if (!wf) return
  const agents = projectAgents(await ws.projectConfig(projectPath))
  const known = (id: string): boolean => agents.some((a) => a.id === id)
  // Every running lane's cards: a lane's own reviewer reviewing one isn't free for the pool either.
  const cards = new Map<number, PoolCard & { rec: CardRecord }>()
  for (const l of lanes)
    for (const n of [...l.cards, ...(l.pending ?? [])]) {
      if (cards.has(n)) continue
      const c = poolCardOf(wf, n, known)
      if (c) cards.set(n, c)
    }
  const slots = await poolFor(ws, projectPath).catch(() => null)
  const pool: PoolAgent[] = agents.map((a) => ({ id: a.id, role: agentWorkflowRole(a), leased: !!slots?.leasesOf(a.id).some((l) => l.kind !== 'carried'), idle: idle(projectPath, a.id) }))
  for (const a of poolAssignments([...cards.values()], pool)) {
    if (!workflowEnforced() || ws.lifetime.aborted) return
    const c = cards.get(a.card)!
    const given = await wf.write(c.rec, null, 'hive', (w) => {
      // Still waiting for a reviewer, in this write: the same submission, nobody on it, the agent still free of it.
      const s = w.state()
      if (s.stage !== 'review' || s.latest?.id !== a.submission) return false
      const now = submissionReviewers(w.tx.facts(a.card), a.submission, known)
      if (now.reviewing || now.seen.includes(a.reviewer) || passingReviewers(s).length >= c.quorum) return false
      w.fact('ReviewerAssigned', { reviewer: a.reviewer, submission: a.submission }) // i18n-ignore: a fact's kind and codes, not text
      return true
    })
    if (!given) continue
    log.info(`#${a.card} (submission ${a.submission}) given to ${userText(agents.find((x) => x.id === a.reviewer)?.name ?? a.reviewer)} from the pool`)
    cards.set(a.card, { ...c, reviewing: a.reviewer, seen: [...c.seen, a.reviewer] })
  }
  // Each pool card's reviewer given it and not started on it yet: told, once.
  for (const c of cards.values()) {
    if (!c.pool || !c.reviewing || c.reviewing === 'user') continue
    const agent = agents.find((a) => a.id === c.reviewing)
    const started = (wf.state(cardOf(wf, c.card) ?? c.rec).reviewing[c.submission] ?? []).includes(c.reviewing)
    if (!agent || started || !workflowEnforced()) continue
    await tell(ws, projectPath, c, agent, agents).catch((e) => log.warn(`telling ${userText(agent.name)} of #${c.card} from the pool`, e))
  }
}

/**
 * Tells a pooled reviewer of the card it was given: once (a delivery made before counts while it was given or is still
 * on its way, and its agent not running is started for it), typed into its conversation when it runs and is idle, else
 * launched with it for review. Not idle now: told at a later pass.
 */
async function tell(ws: WorkspaceService, projectPath: string, c: PoolCard, agent: AgentDef, agents: AgentDef[]): Promise<void> {
  const ref = `${c.card}:${c.submission}:${agent.id}`
  const made = (await deliveriesOf(projectPath, agent.id)).find((r) => r.source === POOL_REVIEW && r.ref === ref && !NOT_GIVEN.has(r.state))
  const st = sessions.liveFor(projectPath, agent.id)
  if (made) {
    if (!st && (made.state === 'queued' || made.state === 'offered' || made.state === 'uncertain')) await sessions.start(projectPath, { agentId: agent.id, purpose: 'review' })
    return
  }
  if (!idle(projectPath, agent.id)) return
  const builder = agents.find((a) => c.builders.includes(a.id))?.name
  const body = withCardNames(ws, () => `${cardRef(c.card)}${builder ? ` (${builder}'s card)` : ''} is in Review: you review it from the pool. Review its latest submission (hive_read_task, then hive_start_review and hive_verdict); your verdict frees you for the next card.`) // i18n-ignore: agent-facing
  const nd = { agentId: agent.id, agentName: agent.name, kind: 'card-event' as const, from: { kind: 'hive' as const, name: 'Hive' }, card: c.card, body, source: POOL_REVIEW, ref } // i18n-ignore: who a delivery is from, as agents read it
  log.info(`Telling ${userText(agent.name)} of #${c.card} from the pool (${st ? 'typed' : 'started'})`)
  const r = st ? await deliverNow(projectPath, { ...nd, need: 'free', conversation: st.sessionId || null }) : (await launchWith(projectPath, nd, (line) => sessions.start(projectPath, { agentId: agent.id, prompt: line, purpose: 'review' }))).record
  if (!r || NOT_GIVEN.has(r.state)) log.info(`#${c.card}'s pool delivery to ${userText(agent.name)} wasn't given (${r?.state ?? 'none made'}): told at the next pass`)
}

// --- What asks for a pass.

/** The project folder of a card on a workspace's board, by its board name; null for none. */
function projectOfCard(ws: WorkspaceService, card: number): string | null {
  const name = boardRead(ws, (db) => (db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string } | undefined)?.project) // i18n-ignore: SQL
  if (!name) return null
  return ws.info()?.projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.path ?? null
}

/** Every open workspace's projects with a running pool lane: their passes. */
async function settleAll(): Promise<void> {
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    const names = new Set((await rawLanes(ws).catch(() => [])).filter((l) => running(l) && l.pool).map((l) => l.project.toLowerCase()))
    for (const p of ws.info()?.projects ?? []) if (names.has(p.name.toLowerCase())) await settleReviewerPool(ws, p.path)
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
  const offEvents = onHiveEvent((e) => {
    if (e.type === 'tasks-changed' || e.type === 'workspace-changed') later()
    else if (e.type === 'session-status' && freed(e.state)) {
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
  }
}

/** A status an agent may be free in (its turn or its watch ended, or it stopped). */
const freed = (st: LiveSessionState): boolean => !BUSY.has(st.status)

export function stopReviewerPool(): void {
  stop?.()
  stop = null
}
