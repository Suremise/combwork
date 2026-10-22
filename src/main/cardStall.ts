import { basename, join } from 'path'
import { projectAgents } from '../shared/defaults'
import { agentRuntime } from '../shared/runtime'
import { columnSince, laneOrderWaitReason, notWatchingReason, reviewVerdictWaitReason, reviewWaitReason, stalledReason, type LaneOrderView } from '../shared/tasks'
import type { TaskCard } from '../shared/types'
import { sessions } from './sessions'
import { workspaceOf, type WorkspaceService } from './workspace'

/**
 * Why a card is stalled, in one place (the Agent API's `stalled`, and lane watches, #531): a Doing card nobody works on
 * (its agent gone or not running), a card an agent in a card loop left with no watch (#376), or one waiting in Review on
 * a reviewer that watches it but hasn't started (#521), or on one that started and only watches it, with no verdict (#843),
 * or one whose lane is deadlocked, its reviewer waiting for another of its cards while its builder waits on it (#1410).
 * Null when it isn't.
 */

/** A workspace's live agents (by its folder): their names, projects, cards left with no watch, card watches (and since when), and how each is now. */
function liveOf(wsPath: string): { name: string; project: string; agentId: string; notWatching?: number[]; untaken: boolean; cards: number[]; watchSince?: string; status: string; silentMinutes?: number }[] {
  const ws = wsPath.toLowerCase()
  return sessions
    .liveStates()
    .filter((s) => workspaceOf(s.projectPath).path?.toLowerCase() === ws)
    .map((s) => ({ name: s.agentName ?? s.agentId, project: basename(s.projectPath), agentId: s.agentId, notWatching: s.notWatching, untaken: !!s.untakenLine, cards: s.watch?.cards ?? [], watchSince: s.watch?.since, status: s.status, silentMinutes: agentRuntime(s).silentMinutes }))
}

/**
 * Why a card is stalled, given its agent as it is now (null: removed; its name and whether it runs), its workspace's
 * folder, and its running lane (none: no lane's deadlock is looked for).
 */
export function cardStall(c: TaskCard, agentNow: { name: string; running: boolean } | null, wsPath: string | null, lane?: LaneOrderView | null): string | null {
  const live = wsPath ? liveOf(wsPath) : []
  const watchers = live.filter((a) => a.cards.length)
  return stalledReason(c, agentNow) ?? notWatchingReason(c, live.filter((a) => a.notWatching?.length)) ?? reviewWaitReason(c, watchers) ?? reviewVerdictWaitReason(c, watchers) ?? laneOrderWaitReason(c, lane, watchers)
}

/** A running lane as the stall check reads it (#1410), its cards' keys and last moves from the board's cards (`card`). */
export const laneOrderView = (l: { builder: { id: string }; reviewer: { id: string } | null; cards: { number: number; column: string }[] }, card: (n: number) => Pick<TaskCard, 'key' | 'history'> | undefined): LaneOrderView => ({
  builder: l.builder.id,
  reviewer: l.reviewer?.id ?? null,
  cards: l.cards.map((c) => {
    const t = card(c.number)
    return { number: c.number, column: c.column, movedAt: t ? columnSince(t) : null, ...(t?.key ? { key: t.key } : {}) }
  })
})

/**
 * Why a card is stalled, working out its agent from its project's agents (each project read once a call, through
 * `agents`). For callers that don't have the agent at hand (lane watches).
 */
export async function cardStallIn(ws: WorkspaceService, c: TaskCard, agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>(), lane?: LaneOrderView | null): Promise<string | null> {
  let now: { name: string; running: boolean } | null = null
  if (c.agent && c.project && ws.path) {
    const p = join(ws.path, c.project)
    const key = p.toLowerCase()
    if (!agents.has(key)) agents.set(key, ws.projectConfig(p).then(projectAgents, () => []))
    const def = (await agents.get(key)!).find((a) => a.id === c.agent)
    now = def ? { name: def.name, running: !!sessions.liveFor(p, c.agent) } : null
  }
  return cardStall(c, now, ws.path, lane)
}
