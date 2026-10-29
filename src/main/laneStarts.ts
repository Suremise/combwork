import { join } from 'path'
import type { TaskCard } from '../shared/types'
import { laneStartDue } from '../shared/lanes'
import { cardRef } from '../shared/projectKeys'
import { agentNowOf } from './cardStall'
import { coalesced } from './coalesce'
import { onHiveEvent } from './events'
import { builderLaneNow, lanesEnforced, listLanes } from './lanes'
import { createLogger, userText } from './logger'
import { withCardNames } from './projectKeys'
import { whyNoLine } from './lineWriter'
import { sessions } from './sessions'
import { startTask } from './taskStart'
import { HIVE_LANE_START } from './tasks'
import { inWorkspace, openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

/**
 * Hive starts a lane's next card (HI-1990, Darren's decision of 29 Oct 2026: plumbing, not guidance). With workflow
 * rules on, once the card before it is Done, a running lane's next card (its own, in Todo, not blocked, every card
 * before it Done or another lane's) is started on the lane's builder as the Assistant's Start gives one (`startTask`,
 * through the start's rules): its slot lent and the builder placed there, typed into it idle, or started with it when
 * it isn't running. A builder in a turn (reading the Done wake, finishing a follow-up) is waited for until its turn
 * ends; one waiting on a watch, or whose last start failed, is left to the lane-next stall (HI-1741). The lane's first
 * card stays its builder's to start (the card-loop skill). LE-250's builder read its Done and went idle, and the lane
 * sat until the Assistant started LE-246 by hand.
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

const builderKey = (wsPath: string, project: string, agentId: string): string => `${wsPath.toLowerCase()}#${project.toLowerCase()}|${agentId}`

/**
 * Whether the builder can be given a card now: idle with a line of Hive's free to go in (its turn over, nobody typing
 * there, no line being typed or waiting: a start whose card can't then be typed in is undone, and that undoing raced the
 * builder's own start, HR1's round 2 run), or not running and not starting.
 */
function builderFree(projectPath: string, b: { id: string; name: string }): boolean {
  const st = sessions.liveFor(projectPath, b.id)
  if (st) return (st.status === 'ready' || st.status === 'finished') && whyNoLine(projectPath, b.id, 'free') === null
  const now = agentNowOf(projectPath, b.id, b.name)
  return !now.running && !now.failed
}

/** A start the lane no longer asks for: its lane ended, was changed or isn't the builder's, or the card isn't its next. */
class LaneChanged extends Error {}

/**
 * Whether the lane still asks for card n now, as the board has it (builderLaneNow): still running in the same workspace,
 * still the builder's, and n still its next card due (the card itself as the start's write sees it, `now`).
 */
function stillDue(ws: WorkspaceService, path: string, lane: { id: string; builder: { id: string } }, n: number, now?: TaskCard): boolean {
  if (!ws.path || ws.path.toLowerCase() !== path.toLowerCase()) return false
  const l = builderLaneNow(ws, lane.builder.id, { lane: lane.id })
  if (!l) return false
  const cards = now ? l.cards.map((c) => (c.number === n ? { ...c, column: now.archived ? ('gone' as const) : now.column, blocked: now.blocked || null, ...(now.agent && now.agent !== lane.builder.id ? { elsewhere: now.agent } : {}) } : c)) : l.cards
  return laneStartDue({ state: 'active', cards })?.number === n
}

/** For tests: awaited just before each start, once it is decided (a lane changing while a start is on its way). */
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
  if (!(await lanesEnforced())) return
  for (const lane of await listLanes(ws)) {
    const next = laneStartDue(lane)
    if (!next) continue
    const projectPath = join(path, lane.project)
    waiting.set(builderKey(path, lane.project, lane.builder.id), next.number)
    if (!builderFree(projectPath, lane.builder)) continue
    const key = `${path.toLowerCase()}#${lane.id}#${next.number}`
    const last = tried.get(key)
    if (last && Date.now() - last.at < RETRY_MS) continue
    const prev = lane.cards.slice(0, lane.cards.indexOf(next)).findLast((x) => x.column === 'done')
    // Agent-facing: the builder's prompt says why the card came now.
    const note = await withCardNames(ws, () => `Hive started this card for you: it is your lane's next card, after ${prev ? cardRef(prev.number) : 'the card before it'} went Done.`) // i18n-ignore: agent-facing, the card's start prompt
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
      if (last?.why !== why) log.info(`Lane ${lane.id}: #${next.number} not started yet: ${userText(why)}`)
      tried.set(key, { at: Date.now(), why, builder: builderKey(path, lane.project, lane.builder.id) })
      if (tried.size > 500) tried.delete(tried.keys().next().value!)
    }
  }
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
  if (!waiting.has(k)) return
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
    if (!waiting.size) return
    for (const ws of openWorkspaces()) if (ws.path && [...waiting.keys()].some((k) => k.startsWith(`${ws.path!.toLowerCase()}#`))) soon(ws)
  }, RETRY_MS)
  tick.unref?.()
}
