import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import type { TaskCard } from '../shared/types'
import { FactStore } from './workflow/factStore'
import type { WorkspaceService } from './workspace'

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * A card's loop reviewer (#405, #1382): who Hive wakes for its handoffs (loopWakes.ts) and who may answer its builder's
 * design (cardIntents.ts, read inside the design's board change), one rule for both. The reviewer of a running (active or
 * paused: stored as active) lane with the card; else the agent of its latest review started or verdict (its facts, by the agent's id, so a
 * rename doesn't lose it); else, for a card with no such fact (from before 1.0), the agent whose board name last started
 * reviewing it. Only while it is one of the project's agents now: a removed one can't be woken. Null: the card has none
 * (a lane whose reviewer was removed has none, never an earlier reviewer instead).
 */
export async function loopReviewerOf(ws: WorkspaceService, card: TaskCard): Promise<{ id: string; name: string } | null> {
  if (!ws.path || !card.project) return null
  const agents = projectAgents(await ws.projectConfig(join(ws.path, card.project)))
  const named = (id: string | null | undefined): { id: string; name: string } | null => {
    const a = id ? agents.find((x) => x.id === id) : undefined
    return a ? { id: a.id, name: `${a.name} (${card.project})` } : null
  }
  // From the board's own tables, which a board change reads as it writes them (never the lanes' views: they read more).
  const store = FactStore.forBoard(ws, { project: card.project, key: '' })
  const laneReviewer = (() => {
    try {
      return store.card(card.number).reviewer ?? null
    } catch {
      return null
    }
  })()
  if (laneReviewer) return named(laneReviewer)
  const last = store.facts(card.number).findLast((f) => f.kind === 'ReviewStarted' || f.kind === 'Verdict')
  if (last) return named((last.data as { reviewer?: string }).reviewer)
  const started = card.history.findLast((h) => h.what === 'Started reviewing')
  return started ? named(agents.find((a) => same(`${a.name} (${card.project})`, started.by))?.id) : null
}
