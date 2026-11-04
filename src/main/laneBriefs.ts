// A lane's brief for its builder (HI-1795, SPEC §16.10.2): `cw_lane start`'s `brief`, kept with the lane (lanes.ts,
// shared/lanes.ts nextBrief). In slots, every placement of the lane's cards carries it (slotCards.ts' place, briefOf):
// the conversation that works the card gets it with the card, whatever that conversation is. Outside slots there is no
// placement, so it is delivered to the builder once per revision (source `lane-brief`, ref `<lane>:<rev>`): the lane
// records the rev whose delivery has been made (`out`), so one owed (a crash between the lane's save and its delivery)
// is made by the next look. A replaced or cleared brief's delivery not received yet is cancelled, and refreshed just
// before it is offered, so it can never arrive as the current one; and it is never offered into the builder's conversation
// running as its lane began (`notIn`, the one a new lane's start replaces; an edit keeps it and takes no other).
// Agent-facing: English.

import { join } from 'path'
import { agentMsg, inDefaultDialect, say } from '../shared/agentText'
import type { LaneRecord } from '../shared/lanes'
import { cancelDeliveries, createDelivery, deliveriesOf, registerSource, type DeliverySource } from './deliveries'
import { onHiveEvent } from './events'
import { mutateLanes, onLanesWritten, rawLanes } from './lanes'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { resolvedOf } from './workflow/rulesets'
import { workflowEnforced } from './workflow/service'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

const log = createLogger('lanes')

/** What a lane's brief says around the user's text (dialects, HI-2438). */
const A = {
  brief: agentMsg({
    id: 'brief.record.brief',
    text: "Your lane's brief (lane {lane}, from {from}):\n{text}",
    note: "A lane's brief as its builder reads it (with each card in slots, or delivered): who started the lane (from: the lane's startedBy), then the brief as it was written (text)."
  }),
  cleared: agentMsg({ id: 'brief.record.cleared', text: 'Its brief is cleared.', note: "The lane change's reply: the lane's brief was cleared." }),
  inSlot: agentMsg({ id: 'brief.record.inSlot', text: "Its brief is given with each of its cards, in the builder's slot.", note: "The lane change's reply, the project's cards built in slots: the brief goes with each card placed there." }),
  delivered: agentMsg({ id: 'brief.record.delivered', text: 'Its brief is delivered to the builder now.', note: "The lane change's reply: the brief is delivered to the builder's inbox." })
}

export const LANE_BRIEF_SOURCE = 'lane-brief'

/** A brief as its builder reads it: who started the lane, then the text. */
export const briefText = (lane: Pick<LaneRecord, 'startedBy' | 'id'>, text: string): string => say(A.brief, { lane: lane.id, from: lane.startedBy, text })

/** The brief a placement of one of the lane's cards carries (in slots): its text as it is now, or null. */
export const briefOf = (lane: Pick<LaneRecord, 'brief' | 'startedBy' | 'id'> | undefined | null): string | null => (lane?.brief?.text ? briefText(lane, lane.brief.text) : null)

/** Whether the project's cards are built in slots now (the rules on, Where cards are built: slots): placements carry the brief. */
export async function inSlots(ws: WorkspaceService, projectPath: string): Promise<boolean> {
  if (!workflowEnforced()) return false
  const platform = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  if (!platform) return false
  const cfg = await ws.projectConfig(projectPath).catch(() => null)
  return !!cfg && resolvedOf(ws, projectPath, platform, cfg).options.folder === 'slots'
}

/** The words a lane start's reply adds for its brief (agent-facing): where it is given. */
export async function briefNote(ws: WorkspaceService, lane: Pick<LaneRecord, 'project' | 'brief'>): Promise<string | null> {
  if (!ws.path || !lane.brief) return null
  if (!lane.brief.text) return say(A.cleared)
  return (await inSlots(ws, join(ws.path, lane.project))) ? say(A.inSlot) : say(A.delivered)
}

const refOf = (lane: string, rev: number): string => `${lane}:${rev}`

/** The looks under way, by workspace (one at a time each; one asked for meanwhile goes round again). */
const looks = new WeakMap<object, { again: boolean; done: Promise<void> }>()
/** One look at a workspace's running lanes outside slots: each brief owed delivered (and the older ones cancelled), once. */
export function settleLaneBriefs(ws: WorkspaceService): Promise<void> {
  const running = looks.get(ws.lifetime)
  if (running) {
    running.again = true
    return running.done
  }
  const look = { again: false, done: Promise.resolve() }
  look.done = (async () => {
    try {
      do {
        look.again = false
        await settleOnce(ws)
      } while (look.again && !ws.lifetime.aborted)
    } catch (e) {
      log.warn("delivering lanes' briefs", e)
    } finally {
      looks.delete(ws.lifetime)
    }
  })()
  looks.set(ws.lifetime, look)
  return look.done
}

async function settleOnce(ws: WorkspaceService): Promise<void> {
  if (!ws.path || ws.lifetime.aborted) return
  for (const lane of await rawLanes(ws)) {
    const b = lane.brief
    if (lane.state !== 'active' || !b || b.out === b.rev) continue
    const projectPath = join(ws.path, lane.project)
    // In slots, placements carry it: nothing to deliver, nothing owed.
    if (await inSlots(ws, projectPath)) continue
    const current = refOf(lane.id, b.rev)
    // An older rev's delivery not received yet: cancelled, so it never arrives as the current brief.
    await cancelDeliveries(projectPath, lane.builder.id, 'its lane brief changed', ['rebrief'], (r) => r.source === LANE_BRIEF_SOURCE && !!r.ref?.startsWith(`${lane.id}:`) && r.ref !== current) // i18n-ignore: why a delivery was cancelled, for the log
    const text = b.text
    if (text) {
      const made = (await deliveriesOf(projectPath, lane.builder.id)).some((r) => r.source === LANE_BRIEF_SOURCE && r.ref === current)
      if (!made) {
        // agent-protocol: the sender is the product's name, Hive
        await createDelivery(projectPath, { agentId: lane.builder.id, agentName: lane.builder.name, kind: 'rebrief', from: { kind: 'hive', name: 'Combwork' }, body: inDefaultDialect(() => briefText(lane, text)), source: LANE_BRIEF_SOURCE, ref: current, meta: { lane: lane.id, rev: b.rev, ...(b.notIn ? { notIn: b.notIn } : {}) } }) // i18n-ignore: who a delivery is from, as agents read it
        log.info(`Lane ${lane.id}'s brief (rev ${b.rev}) delivered to ${userText(lane.builder.name)}`)
      }
    }
    // Its delivery made (or its clear done): recorded, unless the brief changed meanwhile (the next look does that one).
    await mutateLanes(ws, (lanes) => {
      const l = lanes.find((x) => x.id === lane.id)
      if (l?.brief && l.brief.rev === b.rev) l.brief = { ...l.brief, out: b.rev }
    })
  }
}

/** Just before one is offered: still its lane's current brief (the lane running, this rev), else cancelled. */
const source: DeliverySource = {
  refresh: async (r, host) => {
    // A lane's start task (laneStart.ts, kind task, ref `<lane>:<role>`) shares this source's id and isn't a brief update:
    // read as one, its role was no rev and it was cancelled as no longer current, leaving its builder idle (HI-2029).
    if (r.kind === 'task') return null
    // The host's own workspace, by its folder's boundary (HR4's round 1: a prefix match took `ws` for `ws-other`'s).
    const ws = workspaceFor(host)
    const [id, rev] = (r.ref ?? '').split(':')
    const lane = ws ? (await rawLanes(ws)).find((l) => l.id === id) : undefined
    if (!lane || lane.state !== 'active' || !lane.brief?.text || String(lane.brief.rev) !== rev) return { cancel: 'its lane brief is no longer current' } // i18n-ignore: why a delivery was cancelled, for the log
    return null
  },
  // Never into the builder's conversation running as the brief was given (the one a new lane's start replaces: its
  // next one gets it); a builder not running then, or another conversation of it, is offered it.
  holds: (r, host) => {
    const notIn = r.meta?.notIn
    if (typeof notIn !== 'string' || !notIn) return true
    return sessions.liveFor(host, r.agentId)?.sessionId !== notIn
  }
}

/** Tests: the source's refresh and holds, as the deliveries call them before an offer. */
export const laneBriefRefreshForTests = source.refresh!
export const laneBriefHoldsForTests = source.holds!

let stop: (() => void) | null = null
/** Looks at each open workspace's briefs when lanes are written and as a workspace opens (index.ts, once). */
export function startLaneBriefs(): void {
  if (stop) return
  registerSource(LANE_BRIEF_SOURCE, source)
  const all = (): void => {
    for (const ws of openWorkspaces()) void settleLaneBriefs(ws)
  }
  const offLanes = onLanesWritten(all)
  const offOpen = onHiveEvent((e) => {
    if (e.type === 'workspace-changed') all()
  })
  stop = () => {
    offLanes()
    offOpen()
  }
  all()
}

export function stopLaneBriefs(): void {
  stop?.()
  stop = null
}
