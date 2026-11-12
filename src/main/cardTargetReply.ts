// HI-3017: what cw_update_task says of a card's new Merges into. One of the project's other targets is the card's own:
// it stays there when the project's target changes, even to that branch, so setting cards before the project pins them
// (HI-3004's trials of assistant-retarget-release). The reply says so, and how to have the card follow instead.
import { join } from 'path'
import { say } from '../shared/agentText'
import { cardRef } from '../shared/projectKeys'
import { API } from './apiText'
import { pickTarget, projectTargets } from './workflow/targets'
import type { WorkspaceService } from './workspace'

export interface CardTargetSaid {
  /** The card's own target now; null, it follows the project's. */
  own: string | null
  /** The note under the reply when it has one of its own; '' otherwise. */
  note: string
}

/** After a target change of card `n` in `project` to `raw` (as the call named it), its own target and the reply's note. */
export async function cardTargetSaid(ws: WorkspaceService, n: number, project: string | null | undefined, raw: unknown): Promise<CardTargetSaid> {
  const t = project && ws.path ? await projectTargets(ws, join(ws.path, project)).catch(() => null) : null
  const p = pickTarget(t, raw)
  const own = 'target' in p ? p.target : null
  return { own, note: own && t ? say(API.card.ownTarget, { card: cardRef(n), target: own, default: t.default }) : '' }
}
