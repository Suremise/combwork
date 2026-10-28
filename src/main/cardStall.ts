import { basename, join } from 'path'
import { projectAgents } from '../shared/defaults'
import { agentRuntime } from '../shared/runtime'
import { columnSince, laneOrderWaitReason, loopStepWaitReason, notWatchingReason, pendingDesign, reviewVerdictWaitReason, reviewWaitReason, stalledReason, startFailedReason, type LaneOrderView, type StallAgent } from '../shared/tasks'
import type { AgentInfo, AgentStart, TaskCard } from '../shared/types'
import { LOOP_STEP_WAIT_MINUTES } from '../shared/lanes'
import { projectPreferences } from './workflow/preferences'
import { queueReturnOf, staleApprovalOf } from './queueReturn'
import { isResuming } from './restartResume'
import { startNow, startSeq } from './agentStarts'
import { sessions } from './sessions'
import { workspaceOf, type WorkspaceService } from './workspace'

/**
 * Why a card is stalled, in one place (the Agent API's `stalled`, and lane watches, #531): a Doing card nobody works on
 * (its agent gone or not running), a card an agent in a card loop left with no watch (#376), or one waiting in Review on
 * a reviewer that watches it but hasn't started (#521), or on one that started and only watches it, with no verdict (#843),
 * or one whose lane is deadlocked, its reviewer waiting for another of its cards while its builder waits on it (#1410),
 * or a card whose builder waits on a check nobody gives: of its design in Doing (#1382), or of its follow-up in Review or
 * Passed (#1467), or a card the merge queue returned that its builder, idle or only watching, hasn't taken up (HI-1721),
 * or a running lane's next card its builder, idle, only watching or not running, hasn't started (HI-1741), or a card in
 * Review whose reviewer has waited minutes for a review copy (HI-1764).
 * Null when it isn't.
 */

/**
 * Why a card's review has waited too long for a review copy (HI-1764), given by reviewCopies.ts as it loads: imported
 * here, it brought copiesApp, slotsApp and windows into everything that reads a card's stall (HI-1785).
 */
let reviewCopyWaitReason: ((c: TaskCard, wsPath: string | null) => string | null) | null = null
export function setReviewCopyWaitReason(fn: typeof reviewCopyWaitReason): void {
  reviewCopyWaitReason = fn
}

/** How long a card the merge queue returned waits in Doing, its builder idle or watching, before it is stalled (HI-1721). */
export const RETURN_STALL_MS = 15 * 60_000

/**
 * Why a card the merge queue returned to its builder is stalled (HI-1721), or null: in Doing, not blocked, unchanged for
 * RETURN_STALL_MS since it came back, and its builder not in a turn (idle, or only watching: HB2 watched
 * HI-1694 for Done for three hours while it waited for HB2). A builder not running is stalledReason's. Agent-facing.
 */
export function returnedWaitReason(c: Pick<TaskCard, 'number' | 'key' | 'column' | 'archived' | 'blocked' | 'updatedAt'>, returned: { at: string } | null | undefined, builder: { name: string; status: string; watching: boolean } | null, now = Date.now()): string | null {
  if (!returned || !builder || c.archived || c.blocked || c.column !== 'doing') return null
  // Its turn's state decides (HR1's round 1): a watch kept while it works (a loop wake leaves it running) is no stall;
  // the watch only words it.
  if (!IDLE.includes(builder.status)) return null
  const since = Math.max(Date.parse(returned.at) || 0, Date.parse(c.updatedAt) || 0)
  if (!since || now - since < RETURN_STALL_MS) return null
  const min = Math.round((now - since) / 60_000)
  const name = c.key ?? `#${c.number}`
  return `${name} came back from the merge queue ${min} min ago; ${builder.name} is ${builder.watching ? 'only watching it' : 'idle'}, not fixing it.` // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** How long an approved card with a stale pass waits, its builder idle or watching, before it is stalled (HI-1763). */
export const STALE_STALL_MS = 10 * 60_000

/**
 * Why an approved card whose pass went stale is stalled (HI-1763), or null: in Passed (Approved), not blocked, stale for
 * STALE_STALL_MS since its `Stale` fact (a stable start: nothing later moves it), and its builder not in a turn (idle,
 * or only watching; a watch kept while it works isn't a stall). Agent-facing.
 */
export function staleWaitReason(c: Pick<TaskCard, 'number' | 'key' | 'column' | 'archived' | 'blocked'>, stale: { since: string; approved: string | null; current: string | null } | null | undefined, builder: { name: string; status: string; watching: boolean } | null, now = Date.now()): string | null {
  if (!stale || !builder || c.archived || c.blocked || c.column !== 'passed') return null
  if (!IDLE.includes(builder.status)) return null
  const since = Date.parse(stale.since) || 0
  if (!since || now - since < STALE_STALL_MS) return null
  const name = c.key ?? `#${c.number}`
  const rev = (r: string | null): string => (r ? r.slice(0, 7) : '—')
  return `${name}'s pass is for ${rev(stale.approved)} but its line is at ${rev(stale.current)}; ${builder.name} is ${builder.watching ? 'only watching it' : 'idle'}, not submitting it.` // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** A builder's statuses with no turn going (watching counts too: returnedWaitReason). */
const IDLE = ['ready', 'finished', 'watching']

/** How long a running lane's next card waits in Todo after the card before it is Done, its builder idle (HI-1741). */
export const LANE_NEXT_STALL_MS = 15 * 60_000

/**
 * Why a running lane's next card is stalled (HI-1741), or null: in Todo, not blocked, every card before it in the lane
 * Done, the last of them Done for LANE_NEXT_STALL_MS, and the lane's builder not in a turn (idle, only watching, or not
 * running: HB3 read HI-1727's Done and ended its turn without starting HI-1735, and the lane sat for two hours). A
 * paused lane's isn't. `builder`: the lane's builder as it is now (null: not running and not about to resume, else
 * its name and status). Agent-facing.
 */
export function laneNextWaitReason(c: Pick<TaskCard, 'number' | 'key' | 'column' | 'archived' | 'blocked'>, lane: LaneOrderView | null | undefined, builder: { name: string; status: string | null }, now = Date.now()): string | null {
  if (!lane || lane.state === 'paused' || c.archived || c.blocked || c.column !== 'todo') return null
  const at = lane.cards.findIndex((x) => x.number === c.number)
  if (at < 1 || lane.cards.slice(0, at).some((x) => x.column !== 'done')) return null
  if (builder.status !== null && !IDLE.includes(builder.status)) return null
  const before = lane.cards[at - 1]
  const since = Date.parse(before.movedAt ?? '')
  if (!since || now - since < LANE_NEXT_STALL_MS) return null
  const min = Math.round((now - since) / 60_000)
  const name = (x: { number: number; key?: string }): string => x.key ?? `#${x.number}`
  return `${name(c)} is the lane's next card: ${name(before)} went Done ${min} min ago, and ${builder.name} ${builder.status === null ? "isn't running" : builder.status === 'watching' ? 'is only watching' : 'is idle'} without starting it.` // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** A workspace's live agents (by its folder): their names, projects, cards left with no watch, card watches (and since when), and how each is now. */
function liveOf(wsPath: string): { name: string; project: string; agentId: string; notWatching?: number[]; untaken: boolean; cards: number[]; watchSince?: string; status: string; silentMinutes?: number }[] {
  const ws = wsPath.toLowerCase()
  return sessions
    .liveStates()
    .filter((s) => workspaceOf(s.projectPath).path?.toLowerCase() === ws)
    .map((s) => ({ name: s.agentName ?? s.agentId, project: basename(s.projectPath), agentId: s.agentId, notWatching: s.notWatching, untaken: !!s.untakenLine, cards: s.watch?.cards ?? [], watchSince: s.watch?.since, status: s.status, silentMinutes: agentRuntime(s).silentMinutes }))
}

export type { StallAgent }

/**
 * An agent as it is now, for the stall check: running while its session runs, while this run's restart resume will
 * bring it back (HI-1707), and while a start of it is under way (HI-1976: a Start, its slot being prepared and its
 * builder placed, its session spawning); else why its last start failed, if it did.
 */
export function agentNowOf(projectPath: string, agentId: string, name: string): StallAgent {
  const start = startNow(projectPath, agentId)
  const running = !!sessions.liveFor(projectPath, agentId) || isResuming(projectPath, agentId) || sessions.startingFor(projectPath, agentId) || start.starting
  return { name, running, ...(!running && start.failed ? { failed: start.failed } : {}) }
}

/**
 * The agent's start as the window's agent info carries it (HI-1977), so the board's Stalled mark agrees with this check:
 * starting while agentNowOf has it running with no session yet, else why its last start failed.
 */
export function agentStartOf(projectPath: string, agentId: string): AgentStart | undefined {
  const now = agentNowOf(projectPath, agentId, '')
  if (now.failed) return { failed: now.failed }
  return now.running && !sessions.liveFor(projectPath, agentId) ? { starting: true } : undefined
}

/**
 * A project's agents with their starts (agentStartOf), for its ProjectInfo, each with the count of start changes they
 * were read at (`startSeq`): the window keeps a change it was told later than that (an older read reaching it after).
 */
export function withAgentStarts<T extends { agents: AgentInfo[] }>(projectPath: string, info: T): T {
  const startsAt = startSeq()
  return {
    ...info,
    agents: info.agents.map((a) => {
      const start = agentStartOf(projectPath, a.id)
      return { ...a, startSeq: startsAt, ...(start ? { start } : {}) }
    })
  }
}

/**
 * Why a card is stalled, given its agent as it is now (null: removed; its name, whether it runs, why its start failed),
 * its workspace's folder, its running lane (none: no lane's deadlock is looked for), and how long a design waits for its
 * check (stepWaitMs: its project's workflow option Design check wait, HI-1766).
 */
export function cardStall(c: TaskCard, agentNow: StallAgent | null, wsPath: string | null, lane?: LaneOrderView | null, stepWaitMs = LOOP_STEP_WAIT_MINUTES * 60_000, returned?: { at: string } | null, stale?: { since: string; approved: string | null; current: string | null } | null): string | null {
  const live = wsPath ? liveOf(wsPath) : []
  const watchers = live.filter((a) => a.cards.length)
  const builder = (returned || stale) && c.agent && c.project ? live.find((a) => a.agentId === c.agent && a.project.toLowerCase() === c.project!.toLowerCase()) : undefined
  const now = builder ? { name: builder.name, status: builder.status, watching: builder.cards.length > 0 } : null
  const back = now ? (returnedWaitReason(c, returned, now) ?? staleWaitReason(c, stale, now)) : null
  return startFailedReason(c, agentNow) ?? stalledReason(c, agentNow) ?? notWatchingReason(c, live.filter((a) => a.notWatching?.length)) ?? back ?? reviewWaitReason(c, watchers) ?? reviewVerdictWaitReason(c, watchers) ?? laneOrderWaitReason(c, lane, watchers) ?? loopStepWaitReason(c, watchers, stepWaitMs) ?? laneNext(c, lane, live, agentNow) ?? reviewCopyWaitReason?.(c, wsPath) ?? null
}

/**
 * The lane-next stall (laneNextWaitReason) with its builder as it is: running (live, by the card's project), else not
 * running only as the card's own agent says (agentNow: a builder queued to resume counts as running); unknown: none.
 */
function laneNext(c: TaskCard, lane: LaneOrderView | null | undefined, live: ReturnType<typeof liveOf>, agentNow: StallAgent | null): string | null {
  if (!lane || c.column !== 'todo' || !c.project) return null
  const b = live.find((a) => a.agentId === lane.builder && a.project.toLowerCase() === c.project!.toLowerCase())
  if (b) return laneNextWaitReason(c, lane, { name: b.name, status: b.status })
  if (c.agent === lane.builder && agentNow && !agentNow.running) return laneNextWaitReason(c, lane, { name: agentNow.name, status: null })
  return null
}

/** A running lane as the stall check reads it (#1410), its cards' keys and last moves from the board's cards (`card`). */
export const laneOrderView = (l: { builder: { id: string }; reviewer: { id: string } | null; state?: string; cards: { number: number; column: string }[] }, card: (n: number) => Pick<TaskCard, 'key' | 'history'> | undefined): LaneOrderView => ({
  builder: l.builder.id,
  reviewer: l.reviewer?.id ?? null,
  ...(l.state ? { state: l.state } : {}),
  cards: l.cards.map((c) => {
    const t = card(c.number)
    return { number: c.number, column: c.column, movedAt: t ? columnSince(t) : null, ...(t?.key ? { key: t.key } : {}) }
  })
})

/** How long a card's design waits for its check (#1382), from its project's options: read only for a card with one waiting. */
export async function stepWaitOf(ws: WorkspaceService, c: TaskCard): Promise<number | undefined> {
  if (c.column !== 'doing' || !c.project || !ws.path || !pendingDesign(c)) return undefined
  const path = join(ws.path, c.project)
  return projectPreferences(ws, path, await ws.projectConfig(path).catch(() => null)).loopStepWaitMinutes * 60_000
}

/**
 * Why a card is stalled, working out its agent from its project's agents (each project read once a call, through
 * `agents`). For callers that don't have the agent at hand (lane watches).
 */
export async function cardStallIn(ws: WorkspaceService, c: TaskCard, agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>(), lane?: LaneOrderView | null): Promise<string | null> {
  let now: StallAgent | null = null
  if (c.agent && c.project && ws.path) {
    const p = join(ws.path, c.project)
    const key = p.toLowerCase()
    if (!agents.has(key)) agents.set(key, ws.projectConfig(p).then(projectAgents, () => []))
    const def = (await agents.get(key)!).find((a) => a.id === c.agent)
    // An agent queued to resume after a restart (HI-1707), or being started (HI-1976), isn't stalled meanwhile.
    now = def ? agentNowOf(p, c.agent, def.name) : null
  }
  // A card in Doing with its agent: has the merge queue returned it (HI-1721)?
  const returned = c.column === 'doing' && c.agent && c.project && ws.path ? await queueReturnOf(ws, join(ws.path, c.project), c.number) : null
  // An approved card whose pass went stale (HI-1763).
  const stale = c.column === 'passed' && c.agent && c.project && ws.path ? await staleApprovalOf(ws, join(ws.path, c.project), c.number) : null
  return cardStall(c, now, ws.path, lane, await stepWaitOf(ws, c), returned, stale)
}
