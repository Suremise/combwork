// HI-3017: what cw_update_task says of a card's new Merges into. One of the project's other targets is the card's own:
// it stays there when the project's target changes, even to that branch, so setting cards before the project pins them
// (HI-3004's trials of assistant-retarget-release). The reply says so, and how to have the card follow instead. HI-3043:
// a card made with one says the same (cw_create_task), and what is said is what was stored, so a forward's resolution
// pinned to the project's own branch (HI-2985) says that branch, not that it follows.
import { join } from 'path'
import { say } from '../shared/agentText'
import { cardRef } from '../shared/projectKeys'
import { API } from './apiText'
import { FactStore } from './workflow/factStore'
import { projectTargets } from './workflow/targets'
import type { WorkspaceService } from './workspace'

export interface CardTargetSaid {
  /** The card's own target now, as stored; null, it follows the project's. */
  own: string | null
  /** The note under the reply when it has one of its own other than the project's; '' otherwise. */
  note: string
}

/** After card `n` of `project` was made or had its target changed: its own target as stored, and the reply's note. */
export async function cardTargetSaid(ws: WorkspaceService, n: number, project: string | null | undefined): Promise<CardTargetSaid> {
  if (!project || !ws.path) return { own: null, note: '' }
  const t = await projectTargets(ws, join(ws.path, project)).catch(() => null)
  let own: string | null = null
  try {
    own = FactStore.forBoard(ws, { project, key: '' }).card(n).target ?? null
  } catch {
    own = null
  }
  // Pinned to the project's own branch (a forward's resolution): its branch said, no note (it never follows another).
  return { own, note: own && t && own !== t.default ? say(API.card.ownTarget, { card: cardRef(n), target: own, default: t.default }) : '' }
}
