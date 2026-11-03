import { basename, join } from 'path'
import { projectAgents } from '../shared/defaults'
import { msg } from '../shared/i18n'
import { laneBrief, type LaneRole } from '../shared/laneBrief'
import { cardLabel } from '../shared/projectKeys'
import type { LaneInfo, LaneStartInfo, LaneStartRequest, LaneStartResult } from '../shared/types'
import { cancelDeliveries, deliveriesOf, launchWith } from './deliveries'
import { legacyWorktree, slotsMigrated } from './agentFolders'
import { lendLane } from './slotCards'
import { agentWorkflowRole, buildsWork, reviewsWork } from '../shared/workflow/roles'
import { HiveError, hiveError } from './hiveError'
import { changeFreshStart, freshStartsNow, holdLaneStart, laneRunsWith, listLanes, oweFreshStart, rawLanes, refuseWhileTeamPaused, retryFreshStarts, setLaneSlotWait, startLane } from './lanes'
import { createLogger, userText } from './logger'
import { whyNoLine } from './lineWriter'
import { sessions } from './sessions'
import { getTask } from './tasks'
import { resolvedOf } from './workflow/rulesets'
import { workflowEnforced } from './workflow/service'
import type { WorkspaceService } from './workspace'
import type { AgentDef, ProjectConfig } from '../shared/types'
import { reviewerModeOf, type WorkflowOptions } from '../shared/workflow/options'
import { teamPauseOf } from './teamPause'
import { openCardsNoCode } from './workflow/cardWork'

const log = createLogger('lanes')

/**
 * A lane started from the window (#1280, SPEC §16.11.3): Start lane… records the lane (the one lane record, #1270) and
 * starts its builder and its reviewer, each in a fresh conversation with the generated brief (laneBrief) as its first
 * prompt: an agent that isn't running is started with it, an idle one ends its conversation (kept in its Sessions tab)
 * and starts a new one. Nothing is typed into a CLI, so no slash command ever is. An agent busy now is refused before
 * anything is recorded: the window offers to wait for it (Start lane… waits until both are idle, then starts).
 */

/** The statuses an agent can't start a lane from now. */
const BUSY = new Set(['working', 'starting', 'waiting', 'background', 'watching', 'signin'])
/** A running agent's statuses between turns, with nothing to wait for (HI-2232: an idle builder a new lane renews). */
const IDLE: ReadonlySet<string> = new Set(['ready', 'finished'])

const M = {
  noCards: msg({ id: 'service.laneStart.noCards', defaultMessage: 'Choose the cards for the lane.', description: 'An error starting a lane (a builder and a reviewer working through cards in turn) from the window: no card was chosen.' }),
  notTheProjects: msg({ id: 'service.laneStart.notTheProjects', defaultMessage: "{card} isn't one of {project}'s cards, or it is archived.", description: "An error starting a lane from the window: a card chosen ({card}, its key) isn't this project's ({project}), or is archived." }),
  done: msg({ id: 'service.laneStart.done', defaultMessage: '{card} is Done already.', description: 'An error starting a lane from the window: a card chosen ({card}, its key) is already Done.' }),
  unknownAgent: msg({ id: 'service.laneStart.unknownAgent', defaultMessage: "{agent} isn't one of {project}'s agents.", description: "An error starting a lane from the window: the builder or reviewer chosen ({agent}) isn't an agent of the project ({project})." }),
  sameAgent: msg({ id: 'service.laneStart.sameAgent', defaultMessage: "The builder can't be its own reviewer.", description: 'An error starting a lane from the window: the same agent was chosen as builder and reviewer.' }),
  needsReviewer: msg({ id: 'service.laneStart.needsReviewer', defaultMessage: "{project}'s rules have a reviewer agent review each card: choose a reviewer.", description: "An error starting a lane from the window: the project's workflow options have a reviewer agent review the work, and no reviewer was chosen." }),
  busy: msg({ id: 'service.laneStart.busy', defaultMessage: "{status, select, working {Agent {agent} is working.} starting {Agent {agent} is starting.} waiting {Agent {agent} is waiting for your answer.} background {Agent {agent} is waiting on background tasks it started.} signin {Agent {agent} needs you to sign in again.} other {Agent {agent} is waiting on cards (a card watch).}} Start the lane once it's idle, or choose another agent.", description: "An error starting a lane from the window: the agent {agent} can't start in a new conversation now, because of what it is doing ({status}; keep the select keys). The window offers to wait until it's idle. Each {status} a whole sentence with a noun before the name (HI-1585: glossary §1 rules 3 and 4)." }),
  poolNotOffered: msg({ id: 'service.laneStart.poolNotOffered', defaultMessage: "{project}'s rules have one reviewer per lane: choose a reviewer, or set Reviewers to a shared pool.", description: "An error starting a lane from the window with the reviewer pool chosen: the project's workflow options (G17, “Reviewers”, a value “A shared pool”) don't have a pool, or workflow rules are off." }),
  poolEmpty: msg({ id: 'service.laneStart.poolEmpty', defaultMessage: "None of {project}'s agents besides the builder reviews, so the pool has nobody to review the cards.", description: "An error starting a lane from the window with the reviewer pool chosen: no agent of the project other than the builder has a role that reviews (Reviewer or Either)." }),
  starting: msg({ id: 'service.laneStart.starting', defaultMessage: 'The lane of agent {agent} is being started already.', description: 'An error starting a lane from the window: one with the same builder ({agent}) is being started right now. A noun before the name (glossary §1 rule 4).' })
}

/** Builders whose lane is being started (a second Start meanwhile is refused). */
const starting = new Set<string>()

export async function startLaneFromWindow(ws: WorkspaceService, projectPath: string, req: LaneStartRequest): Promise<LaneStartResult> {
  // The team paused (HI-2081): refused before anything else is asked of the lane.
  refuseWhileTeamPaused(ws)
  const project = basename(projectPath)
  const cfg = await ws.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  const agentOf = (id: string) => {
    const a = agents.find((x) => x.id === id)
    if (!a) throw hiveError(M.unknownAgent, { agent: id, project }, { kind: 'notFound' })
    return a
  }
  const builder = agentOf(req.builder)
  const reviewer = req.reviewer && !req.pool ? agentOf(req.reviewer) : null
  if (reviewer && reviewer.id === builder.id) throw hiveError(M.sameAgent, undefined, { kind: 'invalid' })
  if (!req.cards.length) throw hiveError(M.noCards, undefined, { kind: 'invalid' })
  const cards: { number: number; key: string; title: string }[] = []
  for (const n of req.cards) {
    // Read in the window's workspace (HI-2288): card numbers overlap between workspaces.
    const c = await getTask(n, ws).catch(() => null)
    if (!c || c.archived || c.project.toLowerCase() !== project.toLowerCase()) throw hiveError(M.notTheProjects, { card: c ? cardLabel(c) : `#${n}`, project }, { kind: 'invalid' })
    if (c.column === 'done') throw hiveError(M.done, { card: cardLabel(c) }, { kind: 'conflict' })
    cards.push({ number: c.number, key: cardLabel(c), title: c.title })
  }
  // What the project's rules ask (none while they are off): a reviewer agent's review needs a reviewer.
  const platform = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  const options = workflowEnforced() && platform ? resolvedOf(ws, projectPath, platform, cfg).options : null
  if (options && !reviewer && !req.pool && (options.review === 'agent' || options.review === 'agentThenYou')) throw hiveError(M.needsReviewer, { project }, { kind: 'invalid' })
  // The pool (#1443): only where the rules have it (with them off, the lane's reviewer is whoever the user names), and
  // only with someone in it besides the builder.
  const pool = req.pool ? poolOf(cfg, options) : null
  if (req.pool && !pool) throw hiveError(M.poolNotOffered, { project }, { kind: 'invalid' })
  if (pool && !pool.some((a) => a.id !== builder.id)) throw hiveError(M.poolEmpty, { project }, { kind: 'invalid' })
  const pooled = pool?.filter((a) => a.id !== builder.id).map((a) => a.name) ?? null
  // Both free now, checked before anything is recorded (again by each start below).
  for (const a of [builder, reviewer]) {
    const st = a ? sessions.liveFor(projectPath, a.id) : null
    if (a && st && BUSY.has(st.status)) throw hiveError(M.busy, { agent: a.name, status: st.status }, { kind: 'conflict' })
  }
  const key = `${projectPath.toLowerCase()}|${builder.id}`
  if (starting.has(key)) throw hiveError(M.starting, { agent: builder.name }, { kind: 'conflict' })
  // Hive's own start of the lane's card waits for this one to lend its slot and start its agents (HI-2029).
  const release = holdLaneStart(ws, project, builder.id)
  starting.add(key)
  try {
    const recorded = await startLane(ws, { project, builder: builder.id, reviewer: reviewer?.id ?? null, ...(pool ? { pool: true } : {}), cards: cards.map((c) => c.number), name: req.name?.trim() || null, by: 'the user', ...(req.applyNow ? { applyNow: true } : {}) }) // i18n-ignore: who started it, as the lane records it (agents read it)
    const where = await builderWhere(projectPath, builder, options, noCodeOnly(ws, cards.map((c) => c.number)))
    if (where.inSlots) {
      // Its slot, lent before its agents start and kept for the whole lane (§16.10.2). None free: the lane is recorded
      // with its wait (kept with the lane, through a restart) and shows "waiting for a slot"; its agents start once a
      // slot is free (slotCards' pass).
      const got = await lendLane(ws, projectPath, recorded.lane.id, builder.id, options?.target || null)
      if ('waiting' in got) {
        await setLaneSlotWait(ws, recorded.lane.id, { since: new Date().toISOString(), note: req.note ?? '' })
        return { lane: recorded.lane as LaneInfo, started: [], waitingForSlot: got.waiting }
      }
      const brief = briefFor(recorded.lane.rounds, project, cards, builder, reviewer, pooled, options, where, got.slot, req.note ?? '')
      return { lane: recorded.lane as LaneInfo, started: await launchAgents(ws, projectPath, recorded.lane.id, builder, reviewer, brief, undefined, undefined, undefined, req.note ?? ''), slot: got.slot }
    }
    const brief = briefFor(recorded.lane.rounds, project, cards, builder, reviewer, pooled, options, where, null, req.note ?? '')
    return { lane: recorded.lane as LaneInfo, started: await launchAgents(ws, projectPath, recorded.lane.id, builder, reviewer, brief, undefined, undefined, undefined, req.note ?? '') }
  } finally {
    starting.delete(key)
    release()
  }
}

/**
 * Where a lane's builder works (#1438): a slot of the lane's (G11 = slots, a builder whose 0.9 worktree isn't its
 * folder any more, #1434's legacyWorktree), else its 0.9 worktree or the project folder, as before. A lane of only
 * no-code cards (`noCode`, HI-2338) is lent no slot as it starts: its agents start where they are.
 */
async function builderWhere(projectPath: string, builder: AgentDef, options: WorkflowOptions | null, noCode: boolean): Promise<{ inSlots: boolean; legacy: { path: string; branch: string } | null }> {
  const legacy = (await slotsMigrated(projectPath, builder.id)) ? null : legacyWorktree(builder)
  return { inSlots: options?.folder === 'slots' && buildsWork(agentWorkflowRole(builder)) && !legacy && !noCode, legacy: legacy ? { path: legacy.path, branch: legacy.branch } : null }
}

/**
 * A lane whose cards still to do are all no-code (HI-2338, Darren's decision): none of them changes anything, so the
 * lane takes no slot as it starts and its agents start where they are (the project folder by default). A code card
 * coming up later in it (added, or made code) is lent the lane's slot as it starts (slotCards' leaseForStart), as a lane
 * an agent registers is at its first card. False with no card to do, or on a board with no kinds (waiting for its 1.0
 * upgrade): the lane is lent its slot as before. Read at once (no await), so it is decided where the slot always was.
 */
export function noCodeOnly(ws: WorkspaceService, cards: readonly number[]): boolean {
  try {
    return openCardsNoCode(ws, cards)
  } catch {
    return false
  }
}

/**
 * The project's reviewer pool (#1443, G17): its agents whose role reviews, while the rules are on and have a shared pool;
 * null otherwise (one reviewer per lane, or rules off).
 */
function poolOf(cfg: ProjectConfig, options: WorkflowOptions | null): AgentDef[] | null {
  if (!options || reviewerModeOf(options) !== 'pool') return null
  return projectAgents(cfg).filter((a) => reviewsWork(agentWorkflowRole(a)))
}

/**
 * A pool lane the Assistant or a script asks for (HI-1581, `POST /v1/lanes` with `pool`), refused as Start Lane… refuses
 * it: where the project's rules have no pool (one reviewer per lane, or rules off), or nobody but the builder reviews.
 */
export async function checkLanePool(ws: WorkspaceService, projectPath: string, builderId: string): Promise<void> {
  const project = basename(projectPath)
  const cfg = await ws.projectConfig(projectPath)
  const platform = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  const options = workflowEnforced() && platform ? resolvedOf(ws, projectPath, platform, cfg).options : null
  const pool = poolOf(cfg, options)
  if (!pool) throw hiveError(M.poolNotOffered, { project }, { kind: 'invalid' })
  if (!pool.some((a) => a.id !== builderId)) throw hiveError(M.poolEmpty, { project }, { kind: 'invalid' })
}

/** What Start Lane… offers for a project (#1443): Pool in its reviewer list, with the pool's agents, where the rules have one. */
export async function laneStartInfo(ws: WorkspaceService, projectPath: string): Promise<LaneStartInfo> {
  const cfg = await ws.projectConfig(projectPath)
  const platform = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  const options = workflowEnforced() && platform ? resolvedOf(ws, projectPath, platform, cfg).options : null
  return { pool: poolOf(cfg, options)?.map((a) => ({ id: a.id, name: a.name })) ?? null }
}

/**
 * The brief of a lane's builder or reviewer: the cards, where the builder works (its slot, or folder), the rules, the note,
 * and the lane's own rounds as it was recorded (HI-1805: never today's default, which may have changed since).
 */
function briefFor(rounds: number, project: string, cards: { key: string; title: string }[], builder: AgentDef, reviewer: AgentDef | null, pool: string[] | null, options: WorkflowOptions | null, where: { legacy: { path: string; branch: string } | null }, slot: string | null, note: string): (role: LaneRole) => string {
  const input = { project, cards: cards.map(({ key, title }) => ({ key, title })), builder: { name: builder.name, folder: where.legacy?.path ?? null, branch: where.legacy?.branch ?? null, slot }, reviewer: reviewer ? { name: reviewer.name } : null, pool, options, rounds, note }
  return (role) => laneBrief(input, role)
}

/**
 * A recorded lane's cards as its brief names them (HI-2288): read in the lane's own workspace, never the default one
 * (the slot and fresh-start passes run with no workspace of their own, and card numbers overlap between workspaces),
 * and only its own project's, so a number that names another project's card is left out rather than named.
 */
async function laneCards(ws: WorkspaceService, project: string, numbers: readonly number[]): Promise<{ key: string; title: string }[]> {
  const cards: { key: string; title: string }[] = []
  for (const n of numbers) {
    const c = await getTask(n, ws).catch(() => null)
    if (c && c.project.toLowerCase() === project.toLowerCase()) cards.push({ key: cardLabel(c), title: c.title })
  }
  return cards
}

/** A lane brief's delivery identity (#1438): one per lane and role, so a lane's agents are started with it once. */
const BRIEF = 'lane-brief'
/** A launch refused because its start is over (Hive quitting): nothing given, nothing failed. */
class LaunchOver extends Error {}
/** An agent of a lane started only where stopped (`stoppedOnly`) found running at its launch: left as it is. */
class StartedMeanwhile extends Error {}
/**
 * An agent that can't be given its new conversation now for a reason that passes by itself (HI-2034): in a turn, or a
 * prompt Hive typed not taken yet, or no line of Hive's free to go in. Its new conversation is owed (the lane's
 * `freshStart`), never dropped and never replaced by the old conversation.
 */
class NotFreeYet extends Error {}
/** A fresh start's obligation no longer this launch's (HI-2034: the lane ended or changed, retried or cleared meanwhile). */
class FreshGone extends Error {}
/** newConversation's refusal for a prompt not taken yet (sessions.ts): it passes, as NotFreeYet does. */
const notTakenYet = (e: unknown): boolean => e instanceof HiveError && (e.text as { id?: string }).id === 'session.newConversation.pending'
/** A delivery that ended without reaching its agent: made again. */
const NOT_GIVEN: ReadonlySet<string> = new Set(['cancelled', 'refused', 'expired', 'stale'])

/**
 * Starts a lane's builder and reviewer, each in a fresh conversation with its brief: one not running is started with it,
 * an idle one ends its conversation (kept in its Sessions tab) and starts a new one, one busy is refused (the lane stays).
 * An agent whose brief for this lane was already given (`lane-brief`, `<lane>:<role>`: a start cut short by a crash, made
 * again) isn't started again. `over` (Hive quitting, #1628): no agent is started from then on, the ones not started left
 * out of the result, so the lane's next start (its next pass) starts them. `stoppedOnly` (a lane the Assistant or a
 * script recorded, HI-1934): an agent running, or in `left` (running when the caller looked, so its slot was decided
 * without it, HR6's round 1), is left out and never given a new conversation; one found running at its launch, idle or
 * busy, is left out too, never reported as failed. Except those in `renew` (HI-2232: an idle builder outside slots),
 * launched as Start Lane… launches them: a new conversation, owed if it isn't free at its launch.
 */
async function launchAgents(ws: WorkspaceService, projectPath: string, laneId: string, builder: AgentDef, reviewer: AgentDef | null, brief: (role: LaneRole) => string, over: () => boolean = () => false, stoppedOnly?: { left: ReadonlySet<string>; renew?: ReadonlySet<string> }, fresh?: FreshLaunch, note = ''): Promise<LaneStartResult['started']> {
  const project = basename(projectPath)
  const started: LaneStartResult['started'] = []
  for (const [a, role] of [[builder, 'builder'], ...(reviewer ? [[reviewer, 'reviewer']] : [])] as [AgentDef, LaneRole][]) {
    // A fresh start owed (HI-2034): only that role, its obligation checked again at the launch.
    if (fresh && fresh.role !== role) continue
    let how: 'fresh' | 'started' = 'started'
    if (over()) break
    // Left as it is, unless it is to be given its new conversation (HI-2232).
    const leftAlone = !!stoppedOnly && !stoppedOnly.renew?.has(a.id)
    // A renewal's lane still this one, running with this agent in this role (HR1 on HI-2232): its conversation is replaced
    // only while it is, checked where an owed fresh start's obligation is (gone: nothing launched, nothing owed).
    const renewing = !!stoppedOnly?.renew?.has(a.id)
    const stillOurs = (): void => {
      fresh?.still()
      if (renewing && !laneRunsWith(ws, laneId, role, a.id)) throw new FreshGone()
    }
    if (stoppedOnly && leftAlone && (stoppedOnly.left.has(a.id) || sessions.liveFor(projectPath, a.id))) continue
    try {
      // Still the project's agent, read again after the awaits above.
      if (!projectAgents(await ws.projectConfig(projectPath)).some((x) => x.id === a.id)) throw hiveError(M.unknownAgent, { agent: a.name, project }, { kind: 'notFound' })
      const ref = `${laneId}:${role}`
      // Given before (or still on its way under the deliveries' own policy), only: one that ended without being given
      // (its launch failed: cancelled; refused, expired, stale) is made again.
      const made = (await deliveriesOf(projectPath, a.id)).find((r) => r.source === BRIEF && r.ref === ref && !NOT_GIVEN.has(r.state))
      if (over()) break
      // An owed fresh start never takes a brief already made as its own (launchFresh reconciles one first).
      if (made && fresh) throw new FreshGone()
      if (made) {
        // On its way, its agent not running: started (no prompt of its own), where it is offered.
        if (!sessions.liveFor(projectPath, a.id) && (made.state === 'queued' || made.state === 'offered' || made.state === 'uncertain')) await sessions.start(projectPath, { agentId: a.id })
        started.push({ agentId: a.id, name: a.name, role, how })
        continue
      }
      // Free where it is launched (HR6's #1280 round 1): checked with no await before its conversation is replaced
      // (newConversation's `allowed` runs just before it stops the agent), so one that started work meanwhile keeps
      // it: it is reported as not started, and the lane stays.
      // In a turn, a prompt not taken yet or a line of Hive's not free to go in (HI-2034): its new conversation is owed;
      // asked to sign in again, refused (that doesn't pass by itself). An owed one's obligation is checked here too, so
      // nothing replaces the conversation once it is gone (the lane ended or changed, a retry, cleared).
      const free = (): void => {
        if (over()) throw new LaunchOver()
        stillOurs()
        const st = sessions.liveFor(projectPath, a.id)
        if (st?.status === 'signin') throw hiveError(M.busy, { agent: a.name, status: st.status }, { kind: 'conflict' })
        if (st && (BUSY.has(st.status) || sessions.agentNow(projectPath, a.id)?.pending || whyNoLine(projectPath, a.id, 'free') !== null)) throw new NotFreeYet(st.status)
      }
      // A renewal's lane gone during the awaits above: no brief made for it.
      if (renewing) stillOurs()
      const launched = await launchWith(projectPath, { agentId: a.id, agentName: a.name, kind: 'task', from: { kind: 'user', name: 'the user' }, body: brief(role), source: BRIEF, ref }, (line) => { // i18n-ignore: who the brief is from, as agents read it
        // Running by now (stoppedOnly), whatever it is doing: left as it is, before the busy check would call it failed.
        if (leftAlone && !over() && sessions.liveFor(projectPath, a.id)) throw new StartedMeanwhile()
        free()
        // An owed fresh start's obligation (HR1 on HI-2034) is checked at every boundary the session layer gives: just
        // before the old run stops, and again before the new launch spawns (after the stop's awaits), for a stopped agent's
        // start too; the lane ended or changed in between, nothing is launched. A renewal's lane likewise (HI-2232).
        const owner = fresh || renewing ? stillOurs : undefined
        if (!sessions.liveFor(projectPath, a.id)) return sessions.start(projectPath, { agentId: a.id, prompt: line, ...(owner ? { allowed: owner } : {}) })
        how = 'fresh'
        // Its first call is just before the agent is stopped: free then (idle, nothing pending). Later ones (as the new
        // conversation starts) aren't about what it is doing, only whether its obligation still holds.
        let first = true
        return sessions.newConversation(projectPath, a.id, line, () => {
          if (first) free()
          else owner?.()
          first = false
        })
      })
      // Made and then ended without being given (its launch failed after the record was saved): not started.
      if (launched.record && NOT_GIVEN.has(launched.record.state)) throw new Error(`${a.name}'s brief wasn't given (${launched.record.state})`) // i18n-ignore: an error for the log (the lane waits to be started)
      started.push({ agentId: a.id, name: a.name, role, how })
    } catch (e) {
      // Over at its launch (Hive quitting): not started, and no failure; the next start starts it.
      if (e instanceof LaunchOver || over()) break
      // Started by someone else as it was launched (stoppedOnly): left as it is, as a running one is.
      if (e instanceof StartedMeanwhile) continue
      // Its obligation gone meanwhile (an owed fresh start): nothing launched, nothing to say.
      if (e instanceof FreshGone) continue
      // Not free yet (HI-2034): owed its new conversation, launched once it is free (laneStarts.ts' pass). An owed one
      // stays owed; a start's is recorded with the lane, the agent's conversation now its old one.
      if (e instanceof NotFreeYet || notTakenYet(e)) {
        // With the note its brief was made with (the user's, Start Lane… or a slot wait's), so its launch says the same.
        if (!fresh) await oweFreshStart(ws, laneId, a.id, role, sessions.liveFor(projectPath, a.id)?.sessionId || null, note)
        log.info(`${userText(a.name)} isn't free for lane ${laneId} yet (${userText((e as Error).message)}): its new conversation is owed`)
        started.push({ agentId: a.id, name: a.name, role, how: 'deferred' })
        continue
      }
      // The lane is recorded: the user can start the agent themselves, or end the lane from its row.
      log.warn(`starting ${userText(a.name)} for lane ${laneId}`, e)
      started.push({ agentId: a.id, name: a.name, role, how: 'failed', why: (e as Error).message })
    }
  }
  return started
}

/** What `launchRecordedLane` did: the stopped agents started (as Start Lane…'s), the slot lent or waited for, and those running. */
export interface RecordedLaneLaunch {
  started: LaneStartResult['started']
  slot?: string
  waitingForSlot?: string
  /** The builder or reviewer running already and left as it is (busy, in slots, or the reviewer), the lane recorded for it; the caller tells it. */
  running: string[]
  /**
   * The lane's builder's name, and whether Hive gives a running one the lane's first card itself once it is free (the
   * workflow rules on: laneStarts.ts, HI-2029): then the caller tells only the reviewer (HR1: a prompt would race it).
   */
  builder?: string
  firstCardByHive?: boolean
}

/**
 * A new lane the Assistant or a script recorded (HI-1900, `POST /v1/lanes` naming its builder): its stopped agents
 * started as Start Lane… starts them, so a lane over stopped agents never sits active with nobody working it. A running
 * agent is left as it is (HI-1934, Darren's option (a)): never refused nor given a new conversation, the lane recorded
 * for it as before HI-1900, and the caller told to tell it; except an idle builder outside slots, given the lane in a
 * new conversation as Start Lane… gives it (HI-2232, Darren's decision (a); owed if it isn't free at its launch). With its builder stopped, its slot is lent
 * first where the builder works in slots (none free: the lane waits for one, shown so, and slotCards' pass starts its
 * stopped agents once one is); then each stopped agent starts with the lane's brief. Null when the lane isn't running,
 * or its builder is no agent of the project.
 */
export async function launchRecordedLane(ws: WorkspaceService, projectPath: string, laneId: string): Promise<RecordedLaneLaunch | null> {
  const lane = (await rawLanes(ws)).find((l) => l.id === laneId)
  if (!lane || lane.state !== 'active') return null
  const cfg = await ws.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  const builder = agents.find((a) => a.id === lane.builder.id)
  const reviewer = lane.reviewer ? (agents.find((a) => a.id === lane.reviewer!.id) ?? null) : null
  if (!builder) return null
  // Who the reply names, and whether Hive starts a running builder's first card (the rules on, HI-2029).
  const who = { builder: builder.name, firstCardByHive: workflowEnforced() }
  const platform = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  const options = workflowEnforced() && platform ? resolvedOf(ws, projectPath, platform, cfg).options : null
  // Its cards all no-code (HI-2338): no slot.
  const where = await builderWhere(projectPath, builder, options, noCodeOnly(ws, lane.cards))
  // Running now: left out of this start whatever they do meanwhile (its slot is decided from it), and named to the caller.
  const left = [builder, reviewer].filter((a): a is AgentDef => !!a && !!sessions.liveFor(projectPath, a.id))
  // An idle builder outside slots (HI-2232, Darren's decision (a)): given the lane in a new conversation, as Start Lane…
  // gives it (its last stays in the Sessions history); in slots its card's start gives it one there. Never one in a turn
  // or on a watch: left as it is.
  const renew = !where.inSlots && left.includes(builder) && IDLE.has(sessions.liveFor(projectPath, builder.id)?.status ?? '') ? builder : null
  const leftOut = left.filter((a) => a !== renew)
  const running = leftOut.map((a) => a.name)
  if (leftOut.length === (reviewer ? 2 : 1)) return { started: [], running, ...who }
  const only = { left: new Set(leftOut.map((a) => a.id)), renew: new Set(renew ? [renew.id] : []) }
  // Those left out, and those found running at their launch (started meanwhile): the caller tells them.
  const runningOf = (started: LaneStartResult['started']): string[] => [builder, reviewer].filter((a): a is AgentDef => !!a && !started.some((x) => x.agentId === a.id) && (only.left.has(a.id) || !!sessions.liveFor(projectPath, a.id))).map((a) => a.name)
  const cards = await laneCards(ws, basename(projectPath), lane.cards)
  const pooled = lane.pool ? (poolOf(cfg, options)?.filter((a) => a.id !== builder.id).map((a) => a.name) ?? []) : null
  // A running builder takes its slot as it starts the lane's card, as before HI-1900: none is lent for it here.
  if (where.inSlots && !only.left.has(builder.id)) {
    const got = await lendLane(ws, projectPath, laneId, builder.id, options?.target || null)
    if ('waiting' in got) {
      await setLaneSlotWait(ws, laneId, { since: new Date().toISOString(), note: '', stoppedOnly: true })
      return { started: [], waitingForSlot: got.waiting, running, ...who }
    }
    const brief = briefFor(lane.rounds, basename(projectPath), cards, builder, reviewer, pooled, options, where, got.slot, '')
    const started = await launchAgents(ws, projectPath, laneId, builder, reviewer, brief, undefined, only)
    log.info(`Lane ${laneId} lent ${userText(got.slot)}: ${started.map((s) => `${userText(s.name)} ${s.how}`).join(', ')}`)
    return { started, slot: got.slot, running: runningOf(started), ...who }
  }
  const brief = briefFor(lane.rounds, basename(projectPath), cards, builder, reviewer, pooled, options, where, null, '')
  const started = await launchAgents(ws, projectPath, laneId, builder, reviewer, brief, undefined, only)
  log.info(`Lane ${laneId} started: ${started.map((s) => `${userText(s.name)} ${s.how}`).join(', ')}`)
  return { started, running: runningOf(started), ...who }
}

/**
 * A running lane the Assistant or a script updated while its builder isn't running (HR2's HI-1900 round 1): its builder
 * started with one line naming its lane, as coordinate-agents had the Assistant do, so the lane goes on (`hive_lane next`
 * names its card; a card in a slot is placed there as it starts). What happened, for the reply.
 */
export async function resumeLaneBuilder(projectPath: string, lane: { id: string; builder: { id: string; name: string } }): Promise<string> {
  if (sessions.liveFor(projectPath, lane.builder.id)) return ''
  try {
    await sessions.start(projectPath, { agentId: lane.builder.id, prompt: `Use card-loop as the builder of lane ${lane.id}: hive_lane next names your card.` }) // i18n-ignore: the builder's prompt (agent-facing)
    log.info(`Lane ${lane.id}: started its builder ${userText(lane.builder.name)}, who wasn't running`)
    return `${lane.builder.name} wasn't running: started it on the lane.` // i18n-ignore: the lane start's reply (the Assistant and scripts read it)
  } catch (e) {
    return `${lane.builder.name} isn't running and couldn't be started (${(e as Error).message}): start it for the lane to go on.` // i18n-ignore: the lane start's reply (the Assistant and scripts read it)
  }
}

/** What `launchRecordedLane` did, for the lane start's reply (agent-facing English: the Assistant and scripts read it). */
export function recordedLaneNote(l: RecordedLaneLaunch | null): string {
  if (!l) return ''
  // A running builder, the rules on: Hive gives it the lane's first card once it is free (HI-2029), so the caller is told
  // not to prompt it (that would race Hive's start); a running reviewer, or the builder with the rules off, it tells.
  const byHive = l.firstCardByHive && l.builder && l.running.includes(l.builder) ? l.builder : null
  const tell = l.running.filter((n) => n !== byHive)
  const running = [
    byHive ? `${byHive} is running, so Hive left it as it is: Hive gives it the lane's first card itself once it is free, so don't prompt it.` : '', // i18n-ignore: the lane start's reply (the Assistant and scripts read it)
    tell.length ? `${tell.join(' and ')} ${tell.length > 1 ? 'are' : 'is'} running, so Hive left ${tell.length > 1 ? 'them' : 'it'} as ${tell.length > 1 ? 'they are' : 'it is'}: tell ${tell.length > 1 ? 'them' : 'it'} about the lane.` : '' // i18n-ignore: the lane start's reply (the Assistant and scripts read it)
  ].filter(Boolean).join(' ')
  if (l.waitingForSlot !== undefined) return [`No slot is free (${l.waitingForSlot}): the lane waits for one, and its stopped agents start once it is lent.`, running].filter(Boolean).join(' ') // i18n-ignore: the lane start's reply (the Assistant and scripts read it)
  const ok = l.started.filter((s) => s.how === 'started').map((s) => s.name)
  // An idle builder given the lane in a new conversation (HI-2232), now or once it is free: never the caller's to prompt.
  const fresh = l.started.filter((s) => s.how === 'fresh').map((s) => `Gave ${s.name} the lane in a new conversation (its last stays in its Sessions history): don't prompt it.`) // i18n-ignore: the lane start's reply (the Assistant and scripts read it)
  const owed = l.started.filter((s) => s.how === 'deferred').map((s) => `${s.name} wasn't free: Hive gives it the lane in a new conversation once it is, so don't prompt it.`) // i18n-ignore: the lane start's reply (the Assistant and scripts read it)
  const failed = l.started.filter((s) => s.how === 'failed').map((s) => `${s.name} didn't start (${s.why ?? 'unknown'})`) // i18n-ignore: the lane start's reply (the Assistant and scripts read it)
  return [ok.length ? `Started ${ok.join(' and ')} with the lane's brief${l.slot ? `, in ${l.slot}` : ''}.` : '', ...fresh, ...owed, failed.length ? `${failed.join('; ')}: start ${failed.length > 1 ? 'them' : 'it'} yourself.` : '', running].filter(Boolean).join(' ')
}

/**
 * A lane started from the window that waited for a slot, now lent `slot` (#1438, slotCards' pass), or null for one whose
 * cards still to do are all no-code by now (HI-2338: it takes none, its agents start where they are): its agents started,
 * each once, as Start Lane… would have, from the lane as it is now (its builder and reviewer, still the project's
 * agents and the builder still one; its cards; the rules now; the note it was started with). Whether they all started
 * (false: the lane keeps waiting to be started; not running any more: nothing is started, and it is done with).
 * `over` (Hive quitting, #1628), looked at after each await and at each agent's launch: from then on nothing is read
 * or started, and it is false, the lane left waiting (with its slot lent) for the next start's pass.
 */
export async function startWaitingLane(ws: WorkspaceService, projectPath: string, laneId: string, slot: string | null, over: () => boolean = () => false): Promise<boolean> {
  if (over()) return false
  const lane = (await rawLanes(ws)).find((l) => l.id === laneId)
  if (over()) return false
  if (!lane || lane.state !== 'active') return true
  const cfg = await ws.projectConfig(projectPath)
  if (over()) return false
  const agents = projectAgents(cfg)
  const builder = agents.find((a) => a.id === lane.builder.id)
  const reviewer = lane.reviewer ? (agents.find((a) => a.id === lane.reviewer!.id) ?? null) : null
  if (!builder || !buildsWork(agentWorkflowRole(builder)) || (lane.reviewer && !reviewer)) return false
  const cards = await laneCards(ws, basename(projectPath), lane.cards)
  if (over()) return false
  const platform = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  const options = workflowEnforced() && platform ? resolvedOf(ws, projectPath, platform, cfg).options : null
  const pooled = lane.pool ? (poolOf(cfg, options)?.filter((a) => a.id !== builder.id).map((a) => a.name) ?? []) : null
  const brief = briefFor(lane.rounds, basename(projectPath), cards, builder, reviewer, pooled, options, { legacy: null }, slot, lane.slotWait?.note ?? '')
  const started = await launchAgents(ws, projectPath, laneId, builder, reviewer, brief, over, lane.slotWait?.stoppedOnly === true ? { left: new Set() } : undefined, undefined, lane.slotWait?.note ?? '')
  if (over()) return false
  log.info(`Lane ${laneId} got ${slot ? userText(slot) : 'no slot (only no-code cards)'}: ${started.map((s) => `${userText(s.name)} ${s.how}`).join(', ')}`)
  return started.every((s) => s.how !== 'failed')
}

/** For tests (HI-2034): awaited between an owed fresh start's claim and its launch (the lane changing meanwhile), and as a Retry's cancellation of earlier start tasks begins. */
export const laneStartTestHooks: { beforeFreshLaunch: ((lane: string, entry: string) => Promise<void>) | null; retryCancelling: (() => Promise<void>) | null } = { beforeFreshLaunch: null, retryCancelling: null }

/** An owed fresh start's launch (HI-2034, launchFresh): its role, and its obligation checked again where it is launched. */
interface FreshLaunch {
  role: LaneRole
  /** Throws FreshGone once the obligation is no longer this launch's (synchronous: run just before the old run stops). */
  still: () => void
}

/** What launchFresh did: its agent in its new conversation, not free yet, its obligation gone, or no more tried. */
export type FreshOutcome = 'launched' | 'notFree' | 'gone' | 'blocked'

/** A launch's marker still set (`launching`) as Hive's pass looks: the run id the start task went into ('launching' while it starts). */
const LAUNCHING_RUN = 'launching'

/**
 * Launches an agent owed its new conversation (HI-2034, the lane's `freshStart` entry `entryId`) as Start Lane… would
 * have: the lane's brief, in a new conversation (or started, when it has stopped meanwhile). laneStarts.ts' pass calls
 * it once the agent is free.
 * - **Ownership**: only while the lane runs with that agent in that role and the entry is there, unblocked; `launching`
 *   is set under the lanes' lock just before the launch, and checked again inside it, just before the old run stops
 *   (newConversation's `allowed`); the entry is removed only after the launch, by its id.
 * - **Never twice, never unproven**: an entry found with `launching` already set, or a start task made for it since it
 *   was owed, means a launch began (a crash in between). It is cleared only on positive evidence that the agent's live
 *   run is the one its start task went into, in a conversation other than the old one (a run resuming the old
 *   conversation is not); otherwise it is blocked as `uncertain` and nothing is launched until the user retries.
 */
export async function launchFresh(ws: WorkspaceService, projectPath: string, laneId: string, entryId: string): Promise<FreshOutcome> {
  const lane = (await rawLanes(ws)).find((l) => l.id === laneId)
  const entry = lane?.freshStart?.find((f) => f.id === entryId)
  if (!lane || lane.state !== 'active' || !entry || entry.blocked) return 'gone'
  const cfg = await ws.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  const builder = agents.find((a) => a.id === lane.builder.id)
  const reviewer = lane.reviewer ? (agents.find((a) => a.id === lane.reviewer!.id) ?? null) : null
  const agent = entry.role === 'builder' ? builder : reviewer
  if (!builder || !agent || agent.id !== entry.agent) {
    await changeFreshStart(ws, laneId, entryId, () => null)
    return 'gone'
  }
  const ref = `${laneId}:${entry.role}`
  const made = (await deliveriesOf(projectPath, agent.id)).find((r) => r.source === BRIEF && r.ref === ref && !NOT_GIVEN.has(r.state) && Date.parse(r.created) >= Date.parse(entry.since))
  if (entry.launching || made) {
    const live = sessions.liveFor(projectPath, agent.id)
    const proven = !!made?.offerRun && made.offerRun !== LAUNCHING_RUN && live?.runId === made.offerRun && !!live.sessionId && live.sessionId !== entry.oldSession
    if (proven) {
      await changeFreshStart(ws, laneId, entryId, () => null)
      log.info(`Lane ${laneId}: ${userText(agent.name)}'s new conversation is its live run (${made!.offerRun})`)
      return 'launched'
    }
    await changeFreshStart(ws, laneId, entryId, ({ launching: _l, ...f }) => ({ ...f, blocked: { at: new Date().toISOString(), why: 'uncertain' } })) // i18n-ignore: a fresh start's blocked reason, a select key (never shown as it is)
    log.warn(`Lane ${laneId}: ${userText(agent.name)}'s new conversation may not have started (a launch began and isn't proven): left for the user to retry`)
    return 'blocked'
  }
  const cards = await laneCards(ws, basename(projectPath), lane.cards)
  const platform = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  const options = workflowEnforced() && platform ? resolvedOf(ws, projectPath, platform, cfg).options : null
  const pooled = lane.pool ? (poolOf(cfg, options)?.filter((a) => a.id !== builder.id).map((a) => a.name) ?? []) : null
  const where = await builderWhere(projectPath, builder, options, noCodeOnly(ws, lane.cards))
  const slot = (await listLanes(ws)).find((l) => l.id === laneId)?.slot ?? null
  // The note it was owed with (HR1 on HI-2034: the user's Start Lane note, kept through its wait, a restart and a retry).
  const brief = briefFor(lane.rounds, basename(projectPath), cards, builder, reviewer, pooled, options, where, slot, entry.note ?? lane.slotWait?.note ?? '')
  // The team paused (HI-2081): not now; the pass after the resume launches it.
  if (teamPauseOf(ws)) return 'notFree'
  // Claimed under the lock: still this obligation, unblocked and not being launched.
  let claimed = false
  await changeFreshStart(ws, laneId, entryId, (f) => {
    claimed = !f.blocked && !f.launching
    return claimed ? { ...f, launching: new Date().toISOString() } : f
  })
  if (!claimed) return 'gone'
  await laneStartTestHooks.beforeFreshLaunch?.(laneId, entryId)
  // Still this obligation, and the team not paused since (HI-2081, round 1 finding 6): asked before the old conversation
  // is replaced and as the launch spawns; refused, the claim is given back and the next pass tries again.
  const still = (): void => {
    const f = freshStartsNow(ws, laneId).find((x) => x.id === entryId)
    if (!f || f.blocked || !f.launching || teamPauseOf(ws)) throw new FreshGone()
  }
  const [r] = await launchAgents(ws, projectPath, laneId, builder, reviewer, brief, undefined, undefined, { role: entry.role, still })
  if (r?.how === 'fresh' || r?.how === 'started') {
    await changeFreshStart(ws, laneId, entryId, () => null)
    log.info(`Lane ${laneId}: ${userText(agent.name)} started in its new conversation (${r.how})`)
    return 'launched'
  }
  if (r?.how === 'failed') {
    await changeFreshStart(ws, laneId, entryId, ({ launching: _l, ...f }) => ({ ...f, blocked: { at: new Date().toISOString(), why: 'failed', message: (r.why ?? '').slice(0, 500) } })) // i18n-ignore: a fresh start's blocked reason, a select key (never shown as it is)
    return 'blocked'
  }
  // Not free after all, or gone meanwhile: the claim given back while the obligation is still this one.
  await changeFreshStart(ws, laneId, entryId, ({ launching: _l, ...f }) => f)
  return r?.how === 'deferred' ? 'notFree' : 'gone'
}

/**
 * The user's Retry of a lane's new conversations no more tried (HI-2034; the lane's row, or the Assistant's
 * `POST /v1/lanes/{id}/fresh-start`). First the start tasks its earlier launches left on their way are cancelled, by
 * their ids (HR1: never a later attempt's): meanwhile the obligations stay blocked, so no pass launches one, and a
 * cancellation that fails fails the Retry, nothing owed again. Then each, still the same blocked obligation under the
 * lanes' lock, is owed again from now (retryFreshStarts). How many.
 */
/** `commit`: a revocable caller's authority (HI-2420, the Assistant's guard), checked again in each write it makes. */
export async function retryFreshStart(ws: WorkspaceService, laneId: string, commit?: () => void): Promise<number> {
  const lane = (await rawLanes(ws)).find((l) => l.id === laneId)
  if (!lane || lane.state !== 'active' || !ws.path) return 0
  const blocked = (lane.freshStart ?? []).filter((f) => f.blocked)
  if (!blocked.length) return 0
  const projectPath = join(ws.path, lane.project)
  for (const f of blocked) {
    const ref = `${laneId}:${f.role}`
    const earlier = new Set((await deliveriesOf(projectPath, f.agent)).filter((r) => r.source === BRIEF && r.ref === ref).map((r) => r.id))
    // For tests: the cancellation held (a pass running meanwhile finds the obligation still blocked).
    await laneStartTestHooks.retryCancelling?.()
    if (earlier.size) await cancelDeliveries(projectPath, f.agent, 'the retry of its new conversation', undefined, (r) => earlier.has(r.id), commit) // i18n-ignore: who cancelled a delivery (agent-facing, the log)
  }
  const retried = await retryFreshStarts(ws, laneId, new Set(blocked.map((f) => f.id)), commit)
  if (retried.length) log.info(`Lane ${laneId}: ${retried.map((f) => f.role).join(' and ')}'s new conversation tried again`)
  return retried.length
}

/**
 * Test copies only (`lanes:test`, HI-2034): lane `laneId`'s agent in `role` owed its new conversation as a busy start
 * leaves it, its wait begun `minutesAgo` minutes ago (past the wait: blocked by the next pass). Whether it was recorded.
 */
export async function oweFreshForTest(ws: WorkspaceService, laneId: string, role: LaneRole, minutesAgo: number): Promise<boolean> {
  const lane = (await rawLanes(ws)).find((l) => l.id === laneId)
  const agent = role === 'builder' ? lane?.builder.id : lane?.reviewer?.id
  if (!lane || !agent || !ws.path) return false
  await oweFreshStart(ws, laneId, agent, role, sessions.liveFor(join(ws.path, lane.project), agent)?.sessionId || null)
  const f = freshStartsNow(ws, laneId).find((x) => x.role === role)
  return !!f && (await changeFreshStart(ws, laneId, f.id, (x) => ({ ...x, since: new Date(Date.now() - minutesAgo * 60_000).toISOString() })))
}
