import { join } from 'path'
import type { TaskCard } from '../shared/types'
import { laneStartDue, type LaneStartWait, type LaneStartWhy } from '../shared/lanes'
import { cardRef } from '../shared/projectKeys'
import { agentNowOf } from './cardStall'
import { coalesced } from './coalesce'
import { onHiveEvent } from './events'
import { LANES_FRESH_START_WAIT_MINUTES, withValues } from '../shared/advanced'
import { msg } from '../shared/i18n'
import { advanced } from './advanced'
import { launchFresh } from './laneStart'
import { changeFreshStart, freshStartsNow, laneNow, lanesEnforced, laneStartHeld, laneViewsChanged, laneWaitsForSlot, listLanes, rawLanes, setLaneStartWaits } from './lanes'
import { createLogger, userText } from './logger'
import { withCardNames } from './projectKeys'
import { offerNow, waitingForRun } from './deliveries'
import { whyNoLine } from './lineWriter'
import { sessions } from './sessions'
import { startTask } from './taskStart'
import { HIVE_LANE_START } from './tasks'
import { teamPauseOf } from './teamPause'
import { inWorkspace, openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

/**
 * Hive starts a lane's next card (HI-1990, Darren's decision of 29 Oct 2026: plumbing, not guidance). With workflow
 * rules on, once the card before it is Done, a running lane's next card (its own, in Todo, not blocked, every card
 * before it Done or another lane's) is started on the lane's builder as the Assistant's Start gives one (`startTask`,
 * through the start's rules): its slot lent and the builder placed there, typed into it idle, or started with it when
 * it isn't running. A builder in a turn (reading the Done wake, finishing a follow-up) is waited for until its turn
 * ends; one waiting on a watch, or whose last start failed, is left to the lane-next stall (HI-1741). LE-250's builder
 * read its Done and went idle, and the lane sat until the Assistant started LE-246 by hand. The lane's first card too
 * (HI-2029), once the lane's own start has launched its agents (holdLaneStart) and its builder is free: a lane started
 * over a running builder sat "active" for hours with its first card in Todo.
 */

const log = createLogger('laneStarts')

/** A board change and the status changes after it are looked at together. */
const SETTLE_MS = 1000
/** A start refused (its line behind, a slot to wait for, the user typing) is tried again at most this often, or at its builder's next status change. */
const RETRY_MS = 30_000

/** Next cards waiting for their builder ("<workspace>#<project>|<builder>" → the card), looked at again as it changes. */
const waiting = new Map<string, number>()
/** When each card's start was last tried ("<workspace>#<lane>#<n>"), and the refusal last logged. */
const tried = new Map<string, { at: number; why: string; builder: string }>()
const timers = new Map<string, NodeJS.Timeout>()
const inFlight = new Set<Promise<unknown>>()
/**
 * Agents owed their new conversation (HI-2034, lanes' `freshStart`), builders and reviewers alike, by
 * "<workspace>#<project>|<agent>": looked at again as each one's status changes, and by the tick, whether or not a card
 * is due. The entries being launched now in this process, by id (one found launching and not here is a crash's).
 */
const owed = new Set<string>()
const launchingNow = new Set<string>()

const M = {
  freshBlockedTitle: msg({ id: 'service.laneStarts.freshBlockedTitle', defaultMessage: '{agent}’s new conversation didn’t start', description: "A notification's title (HI-2034): a lane's agent ({agent}, its name) is owed a new conversation for the lane, and Hive has stopped trying to start it." }),
  freshBlockedBody: msg({ id: 'service.laneStarts.freshBlockedBody', defaultMessage: '{why, select, timeout {It wasn’t free within {minutes, plural, one {# minute} other {# minutes}}.} uncertain {Hive closed while starting it, so it may not have started.} other {{reason}}} Retry it from the lane’s row in the Progress panel, or end the lane. Its cards wait until then.', description: "A notification's text (HI-2034), under \"{agent}'s new conversation didn't start\". why (select): the agent wasn't free (in a turn) within the wait, {minutes} minutes (Settings → Advanced); Hive closed while it was starting it; or (other) its start failed, {reason} saying why (a sentence, may be in English). Translate each." })
}

const builderKey = (wsPath: string, project: string, agentId: string): string => `${wsPath.toLowerCase()}#${project.toLowerCase()}|${agentId}`

/**
 * Why the builder can't be given a card now (HI-2029: the lane says so, LaneStatus `startWait`), or null: free. Free is
 * idle with a line of Hive's free to go in (its turn over, nobody typing there, no line being typed or waiting: a start
 * whose card can't then be typed in is undone, and that undoing raced the builder's own start, HR1's round 2 run, and no
 * line of Hive's queued for it lately), or not running and not starting.
 */
async function builderWait(projectPath: string, b: { id: string; name: string }): Promise<LaneStartWhy | null> {
  const st = sessions.liveFor(projectPath, b.id)
  if (st) {
    if (st.status === 'watching') return 'watching'
    if (!(st.status === 'ready' || st.status === 'finished') || whyNoLine(projectPath, b.id, 'free') !== null) return 'busy'
    // Nor while a line of Hive's is on its way to it (queued, not typed yet: the Done wake): it would start typing as the
    // card's own does, and the start would be undone (HI-1995's linecarried run). One offered and not read doesn't hold
    // it. A queued one is offered first, by the delivery service under its own rules (HR1 on HI-2029: time alone never
    // lets the card overlap it): given, cancelled as no longer due, or still held, which the lane then says.
    const queued = async (): Promise<boolean> => (await waitingForRun(projectPath, b.id, st.runId, st.sessionId || null)).some((r) => r.state === 'queued' || r.state === 'uncertain')
    if (!(await queued())) return null
    await offerNow(projectPath, b.id).catch(() => undefined)
    return 'queued'
  }
  const now = agentNowOf(projectPath, b.id, b.name)
  return now.running ? 'busy' : now.failed ? 'failed' : null
}

/**
 * What a lane's card waits for to be started, as its status says it (HI-2029), by workspace and lane: the card, why, and
 * the builder's name. Set as each look finds it, dropped once the card starts or isn't due; read by lanes.ts's views.
 */
const waits = new Map<string, LaneStartWait>()
const waitKey = (wsPath: string, lane: string): string => `${wsPath.toLowerCase()}#${lane}`
/** The start wait of lane `id` in a workspace, or null (lanes.ts reads it into the lane's status). */
export function laneStartWait(wsPath: string, id: string): LaneStartWait | null {
  return waits.get(waitKey(wsPath, id)) ?? null
}
// Its lanes' start waits read into their status (lanes.ts views, HI-2029), from when this module is loaded.
setLaneStartWaits(laneStartWait)

/**
 * The first card card n depends on (blockedBy) that isn't Done, by its key, where n's rules start it only once they are
 * (`start.dependenciesIntegrated`, Dependencies must be Done); null otherwise, or when its workflow can't be read (its
 * start then says why). One Done but not yet in n's target is left to the start's own refusal (`refused`).
 */
async function dependencyWait(ws: WorkspaceService, projectPath: string, n: number): Promise<string | null> {
  const wf = await (await import('./workflow/service')).workflowFor(ws, projectPath).catch(() => null)
  if (!wf) return null
  try {
    const card = wf.store.card(n)
    if (!card.blockedBy.length || !wf.rulesetOf(card).guards.start.includes('start.dependenciesIntegrated')) return null
    const first = card.blockedBy.find((id) => !wf.laneDone(id))
    return first === undefined ? null : wf.store.card(first).key
  } catch {
    return null
  }
}

/** A start the lane no longer asks for: its lane ended, was changed or isn't the builder's, or the card isn't its next. */
class LaneChanged extends Error {}

/**
 * Whether the lane still asks for card n now (HR1's rounds 1 and 2): as `laneNow` reads it, the lane view's own reading
 * (its effective pause for the user, a block or a merge, its cards' owners, a queued list), still running in the same
 * workspace with the same builder, and n still its next card due, with no lane start launching the builder meanwhile
 * and no wait for a slot (HI-2029: either may have begun since the look). `now`: the card as the start's write sees it.
 */
function stillDue(ws: WorkspaceService, path: string, lane: { id: string; project: string; builder: { id: string } }, n: number, now?: TaskCard): boolean {
  if (!ws.path || ws.path.toLowerCase() !== path.toLowerCase() || laneStartHeld(ws, lane.project, lane.builder.id) || laneWaitsForSlot(ws, lane.id) || builderOwed(ws, lane.id)) return false
  const v = laneNow(ws, { lane: lane.id }, now)
  return !!v && v.builder.id === lane.builder.id && laneStartDue(v)?.number === n
}

/** For tests: awaited just before each start, once it is decided (a lane changing while a start is on its way); the queued line's hold. */
export const laneStartsTestHooks: { beforeStart: ((lane: string, n: number) => Promise<void>) | null } = { beforeStart: null }

/**
 * Looks at a workspace's running lanes and starts each next card whose builder is free. Each start is decided again just
 * before it is made, and checked once more where it is written (HR1's round 1): a lane abandoned, changed or reassigned
 * while an earlier start was on its way (slot, git and placement work take a while) gets nothing.
 */
export async function checkLaneStarts(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return
  for (const k of [...waiting.keys()]) if (k.startsWith(`${path.toLowerCase()}#`)) waiting.delete(k)
  const before = JSON.stringify([...waits].filter(([k]) => k.startsWith(`${path.toLowerCase()}#`)))
  for (const k of [...waits.keys()]) if (k.startsWith(`${path.toLowerCase()}#`)) waits.delete(k)
  try {
    // The team paused (HI-2081): no card started, no new conversation launched; its lanes show it as their pause. The
    // pause's end changes the lanes (team-pause-changed), which looks again.
    if (teamPauseOf(ws)) return
    // An agent owed its new conversation is launched with the rules off too (HR1 on HI-2034: Start Lane owes it either
    // way); only Hive's own card starts need them.
    await freshPass(ws, path)
    if (await lanesEnforced()) await lookAt(ws, path)
  } finally {
    // The lanes' statuses follow what this look found (the window and the lane watch read them).
    if (JSON.stringify([...waits].filter(([k]) => k.startsWith(`${path.toLowerCase()}#`))) !== before) laneViewsChanged(ws)
  }
}

/** Whether a lane's builder is owed its new conversation (HI-2034), as kept now: its cards wait for it, never the old one. */
const builderOwed = (ws: WorkspaceService, id: string): boolean => freshStartsNow(ws, id).some((f) => f.role === 'builder')

async function lookAt(ws: WorkspaceService, path: string): Promise<void> {
  for (const lane of await listLanes(ws)) {
    const next = laneStartDue(lane)
    // A lane waiting for a slot (none was free as it started) has its stopped agents started once one is lent (slotCards'
    // pass), which keeps the wait until they are launched (HR1 on HI-2029: a `stoppedOnly` one too): its status says it
    // waits for a slot, and Hive's start comes after.
    if (!next || laneWaitsForSlot(ws, lane.id) || builderOwed(ws, lane.id)) continue
    const projectPath = join(path, lane.project)
    waiting.set(builderKey(path, lane.project, lane.builder.id), next.number)
    const wait = (why: LaneStartWhy, waitsFor?: string): void => void waits.set(waitKey(path, lane.id), { card: next.number, why, agent: lane.builder.name, ...(waitsFor ? { waitsFor } : {}) })
    // HI-2129: a card its rules won't start before the cards it depends on are Done waits for them, whatever its builder
    // does meanwhile (watching one of them, as HB5 did): its start comes once they are, and the lane says what it waits on.
    const dep = await dependencyWait(ws, projectPath, next.number)
    if (dep) {
      wait('dependencies', dep)
      continue
    }
    // Its start launching its agents (HI-2029): never started under it, as the builder's status then says (starting).
    const holds = laneStartHeld(ws, lane.project, lane.builder.id) ? 'busy' : await builderWait(projectPath, lane.builder)
    if (holds) {
      wait(holds)
      continue
    }
    const key = `${path.toLowerCase()}#${lane.id}#${next.number}`
    const last = tried.get(key)
    if (last && Date.now() - last.at < RETRY_MS) {
      wait('refused')
      continue
    }
    const prev = lane.cards.slice(0, lane.cards.indexOf(next)).findLast((x) => x.column === 'done')
    // Agent-facing: the builder's prompt says why the card came now (its lane's first card too, HI-2029).
    const note = await withCardNames(ws, () => (prev ? `Hive started this card for you: it is your lane's next card, after ${cardRef(prev.number)} went Done.` : "Hive started this card for you: it is your lane's first card. Use card-loop as its builder (hive_lane next names your cards).")) // i18n-ignore: agent-facing, the card's start prompt
    try {
      await laneStartsTestHooks.beforeStart?.(lane.id, next.number)
      if (!stillDue(ws, path, lane, next.number)) throw new LaneChanged('its lane changed meanwhile') // i18n-ignore: for the log
      log.info(`Lane ${lane.id}: starting #${next.number} on ${userText(lane.builder.name)} in ${userText(lane.project)}${prev ? ` (#${prev.number} is Done)` : ''}`)
      await inWorkspace(ws, () => startTask(next.number, { kind: 'agent', agentId: lane.builder.id }, HIVE_LANE_START, note, undefined, (now) => {
        if (!stillDue(ws, path, lane, next.number, now)) throw new LaneChanged('its lane changed meanwhile') // i18n-ignore: for the log
      }))
      tried.delete(key)
      waiting.delete(builderKey(path, lane.project, lane.builder.id))
    } catch (e) {
      // Nothing to try again: the next look decides from the lane as it is then.
      if (e instanceof LaneChanged || (e instanceof Error && e.cause instanceof LaneChanged)) {
        log.info(`Lane ${lane.id}: #${next.number} not started: its lane changed meanwhile`)
        continue
      }
      const why = e instanceof Error ? e.message : String(e)
      wait('refused')
      if (last?.why !== why) log.info(`Lane ${lane.id}: #${next.number} not started yet: ${userText(why)}`)
      tried.set(key, { at: Date.now(), why, builder: builderKey(path, lane.project, lane.builder.id) })
      if (tried.size > 500) tried.delete(tried.keys().next().value!)
    }
  }
}

/**
 * Each agent owed its new conversation (HI-2034, lanes' `freshStart`): launched once free (launchFresh: as Start Lane…
 * would have, its obligation claimed and checked again at the launch), within LANES_FRESH_START_WAIT_MINUTES of its
 * start; past that, or a launch found begun and not proven, no more is tried: blocked, with a notice, until the user
 * retries it. An entry this process is launching is left alone; one found launching otherwise is a crash's, which
 * launchFresh reconciles and never launches again by itself.
 */
async function freshPass(ws: WorkspaceService, path: string): Promise<void> {
  for (const k of [...owed]) if (k.startsWith(`${path.toLowerCase()}#`)) owed.delete(k)
  const wait = advanced.number(LANES_FRESH_START_WAIT_MINUTES)
  for (const lane of await rawLanes(ws)) {
    if (lane.state !== 'active' || !lane.freshStart) continue
    const projectPath = join(path, lane.project)
    for (const f of lane.freshStart) {
      if (f.blocked) continue
      owed.add(builderKey(path, lane.project, f.agent))
      if (launchingNow.has(f.id)) continue
      const name = f.role === 'builder' ? lane.builder.name : (lane.reviewer?.name ?? f.agent)
      // Past its wait, and not being launched: no more tried, and the user told (never a turn interrupted for it).
      if (!f.launching && Date.now() - Date.parse(f.since) > wait * 60_000) {
        const blocked = await changeFreshStart(ws, lane.id, f.id, (x) => (x.launching || x.blocked ? x : { ...x, blocked: { at: new Date().toISOString(), why: 'timeout' } })) // i18n-ignore: a fresh start's blocked reason, a select key (never shown as it is)
        if (blocked) tellBlocked(projectPath, name, 'timeout', wait, '')
        continue
      }
      // Free (as a card's start needs it: idle with a line free, nothing of Hive's queued for it), or a crash's launch to reconcile.
      if (!f.launching && (await builderWait(projectPath, { id: f.agent, name }))) continue
      launchingNow.add(f.id)
      try {
        const out = await launchFresh(ws, projectPath, lane.id, f.id)
        if (out === 'blocked') {
          const now = freshStartsNow(ws, lane.id).find((x) => x.role === f.role)
          if (now?.blocked) tellBlocked(projectPath, name, now.blocked.why, wait, now.blocked.message ?? '')
        }
      } catch (e) {
        log.warn(`Lane ${lane.id}: starting ${userText(name)} in its new conversation`, e)
      } finally {
        launchingNow.delete(f.id)
      }
    }
  }
}

/** The user told an agent's new conversation is no more tried (HI-2034), as a notice: the settings and quiet test copies apply. */
function tellBlocked(projectPath: string, agent: string, why: 'timeout' | 'uncertain' | 'failed', minutes: number, reason: string): void {
  sessions.notice(projectPath, withValues(M.freshBlockedTitle, { agent }), withValues(M.freshBlockedBody, { why, minutes, reason }))
}

/** A workspace's lanes may have a card to start: looked at once things settle, one look at a time. */
function soon(ws: WorkspaceService): void {
  const k = ws.path?.toLowerCase()
  if (!k || timers.has(k)) return
  // In flight from now, its settle too, so laneStartsSettled waits for the look this asks for.
  const p = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timers.delete(k)
      void coalesced(`laneStarts:${k}`, () => checkLaneStarts(ws).catch((e) => log.warn("starting lanes' next cards", e))).then(resolve)
    }, SETTLE_MS)
    t.unref?.()
    timers.set(k, t)
  })
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
}

/** An agent's status changed: its workspace looked at again only when it is the builder of a lane whose next card waits. */
function agentChanged(projectPath: string, agentId: string): void {
  const ws = workspaceFor(projectPath)
  if (!ws?.path) return
  const project = projectPath.slice(ws.path.length).replace(/^[\\/]+/, '')
  const k = builderKey(ws.path, project, agentId)
  if (!waiting.has(k) && !owed.has(k)) return
  // Its status changed (a line Hive was typing into it went in, its turn ended): a start refused for that is tried again
  // now, not after RETRY_MS.
  for (const [key, t] of tried) if (t.builder === k) tried.delete(key)
  soon(ws)
}

/** Resolves once no look started so far is under way, for tests. */
export async function laneStartsSettled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight])
}

let started = false

/** Follows the open workspaces' boards, lanes and agents for lanes' next cards to start. Once, at startup. */
export function startLaneStarts(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed' || e.type === 'lanes-changed') {
      const ws = openWorkspaces().find((w) => w.path?.toLowerCase() === e.workspacePath.toLowerCase())
      if (ws) soon(ws)
    } else if (e.type === 'session-status') agentChanged(e.state.projectPath, e.state.agentId)
    else if (e.type === 'session-exit') agentChanged(e.projectPath, e.agentId)
  })
  // A start refused for now (a slot or a line to wait for, the user typing) is tried again while its card waits.
  const tick = setInterval(() => {
    if (!waiting.size && !owed.size) return
    for (const ws of openWorkspaces()) if (ws.path && [...waiting.keys(), ...owed].some((k) => k.startsWith(`${ws.path!.toLowerCase()}#`))) soon(ws)
  }, RETRY_MS)
  tick.unref?.()
}
