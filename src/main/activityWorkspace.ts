import type { ActivityCardAgent, ActivityLaunch, ActivityNow } from '../shared/activity'
import { projectLaunches } from './agentProcesses'
import { markOrphans } from './orphanProcesses'
import { sessions } from './sessions'
import { workspace, workspaceFor } from './workspace'

// Activity's workspace level (HI-1664): what runs now in every session host of the calling window's workspace, read in
// one call a tick, and the agents working on a card now, found by the cards' index (HI-1236), only when asked.

/** The most session hosts one call reads: a workspace's projects and its Assistant, with room to spare. */
export const NOW_ALL_MAX = 64

/**
 * What runs now (activity:now) in each of these session hosts, in one call: each a project of the calling window's
 * workspace or its Assistant's home (any other refuses the whole call), each once however often or however spelt.
 */
export async function activityNowAll(paths: unknown): Promise<{ path: string; now: ActivityNow }[]> {
  if (!Array.isArray(paths)) throw new Error('The session hosts to read must be a list') // i18n-ignore: a mistake in the window's call, never shown
  const hosts = new Map<string, string>()
  for (const p of paths.slice(0, NOW_ALL_MAX)) {
    if (typeof p !== 'string') continue
    const h = workspace.assertSessionHost(p)
    if (!hosts.has(h.toLowerCase())) hosts.set(h.toLowerCase(), h)
  }
  return Promise.all([...hosts.values()].map(async (path) => ({ path, now: { launches: await launchesNow(path), tasks: sessions.backgroundTasks(path), blocks: sessions.hookBlocks(path) } })))
}

/** A session host's running launches, what their commands left running marked (HI-2111). */
export async function launchesNow(path: string): Promise<ActivityLaunch[]> {
  return (await projectLaunches(path)).map((l) => ({ ...l, processes: markOrphans(l.runId, l.processes) }))
}

/**
 * The agents of the calling window's workspace whose running session worked on a card (its record's `cards` have it):
 * by the cards' index, one query per session host with an agent running, never every record (HI-1236). A session the
 * agent ran before, on that card, isn't one: only the session running now counts.
 */
export async function activityCardAgents(card: unknown): Promise<ActivityCardAgent[]> {
  const n = Number(card)
  if (!Number.isInteger(n) || n <= 0) return []
  const wsPath = workspace.path?.toLowerCase()
  if (!wsPath) return []
  const byHost = new Map<string, { path: string; live: { agentId: string; sessionId: string }[] }>()
  for (const st of sessions.liveStates()) {
    if (!st.sessionId || st.status === 'stopped' || workspaceFor(st.projectPath)?.path?.toLowerCase() !== wsPath) continue
    const k = st.projectPath.toLowerCase()
    const host = byHost.get(k) ?? { path: st.projectPath, live: [] }
    host.live.push({ agentId: st.agentId, sessionId: st.sessionId })
    byHost.set(k, host)
  }
  const out: ActivityCardAgent[] = []
  for (const { path, live } of byHost.values()) {
    const worked = new Set((await workspace.sessionsOfCard(path, n)).map((r) => r.id))
    for (const l of live) if (worked.has(l.sessionId)) out.push({ path, agentId: l.agentId, sessionId: l.sessionId })
  }
  return out
}
