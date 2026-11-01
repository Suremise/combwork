// HI-2285: a lane's builder starting a card watch on its own card while nothing on it waits on anyone (shared/idleWatch.ts):
// hive_wait_for_tasks's reply says so. Agent-facing.

import { nothingWaitsOn } from '../shared/idleWatch'
import { listLanes } from './lanes'
import { getTask } from './tasks'
import { forYouOfCards } from './workflow/cardWork'
import type { WorkspaceService } from './workspace'

/**
 * The card a watch names alone that is its watcher's own in its active lane (the card watch checked it is in the
 * watcher's view: its project's), with nothing waiting on it (nothingWaitsOn, its For you items read last); null
 * otherwise, and whenever anything can't be read: it only words the reply.
 */
export async function idleOwnWatchOf(ws: WorkspaceService, agentId: string, cards: readonly number[]): Promise<number | null> {
  if (cards.length !== 1 || !ws.path) return null
  const n = cards[0]
  try {
    const card = await getTask(n, ws)
    if (!card.project || !nothingWaitsOn(card, agentId, false)) return null
    const lane = (await listLanes(ws, { project: card.project })).find((l) => l.state === 'active' && l.builder.id === agentId && l.cards.some((c) => c.number === n))
    if (!lane) return null
    return nothingWaitsOn(card, agentId, (forYouOfCards(ws, [n]).get(n) ?? []).length > 0) ? n : null
  } catch {
    return null
  }
}
