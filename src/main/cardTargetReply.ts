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
import { releaseReadsOf } from './platform/releaseReadsPorts'
import { platformIdOf } from './platform/registry'
import { unreleasedFor } from './platform/releaseReads'
import { isUnknown } from './platform/types'
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
  const ownNote = own && t && own !== t.default ? say(API.card.ownTarget, { card: cardRef(n), target: own, default: t.default }) : ''
  return { own, note: [ownNote, await releasedNote(ws, project, n, own ?? t?.default ?? null, t?.default ?? null)].filter(Boolean).join('\n') }
}

/**
 * HI-3148: the card's line already released: its start there will be refused unless the user OKs it, so the reply says
 * so now. Unreadable, or a platform with no release reads: nothing (its start says what couldn't be read).
 */
async function releasedNote(ws: WorkspaceService, project: string, n: number, line: string | null, workTarget: string | null): Promise<string> {
  if (!line || !ws.path) return ''
  const projectPath = join(ws.path, project)
  const cfg = await ws.projectConfig(projectPath).catch(() => null)
  const reads = releaseReadsOf(platformIdOf(projectPath, cfg?.platform))
  if (!reads) return ''
  const r = await reads.released(projectPath, line).catch(() => null)
  if (!r || isUnknown(r)) return ''
  const suggest = await unreleasedFor(reads, projectPath, line, workTarget).catch(() => null)
  return say(API.card.targetReleased, { target: line, tag: r.tag, into: r.into, card: cardRef(n), has: suggest ? 'yes' : 'no', suggest: suggest ?? '' })
}
