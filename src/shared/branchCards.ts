// Branches next to their cards (#1424, SPEC §16.20's Git support): which cards a project's branch is the line of, from the
// cards' badges (`WorkBadge.line`, this cycle's Started or Adopted), for Version Control → Branches & remotes and its
// worktrees. Pure: the window gives it the badges it already reads (`tasks:workBadges`) and the board's cards.

import type { TaskCard } from './types'
import type { WorkBadge } from './workflow/workView'

/** A card whose current cycle works on a branch, as its branch's row shows it. */
export interface BranchCard {
  card: number
  stage: WorkBadge['stage']
  /** In Review: the revision under review (whole). */
  underReview: string | null
  /** Done: the target's revision with its change in it (`Integrated`'s result), if it was merged. */
  merged: string | null
  lastSeq: number
}

/**
 * Each branch of a project with the cards whose current cycle's line it is (no-code cards have no line, and archived
 * ones aren't read), by branch name: the card in flight first, then the latest first (a branch is an agent's worktree's,
 * one card after another).
 */
export function branchCards(project: string, tasks: readonly Pick<TaskCard, 'number' | 'project'>[], badges: ReadonlyMap<number, WorkBadge>): Map<string, BranchCard[]> {
  const out = new Map<string, BranchCard[]>()
  const mine = new Set(tasks.filter((t) => t.project.toLowerCase() === project.toLowerCase()).map((t) => t.number))
  for (const b of badges.values()) {
    if (!b.line || b.noCode || !mine.has(b.card)) continue
    const list = out.get(b.line) ?? []
    list.push({ card: b.card, stage: b.stage, underReview: b.underReview, merged: b.stage === 'done' ? b.merged : null, lastSeq: b.lastSeq })
    out.set(b.line, list)
  }
  const flying = (c: BranchCard): number => (c.stage === 'done' || c.stage === 'todo' ? 1 : 0)
  for (const list of out.values()) list.sort((a, b) => flying(a) - flying(b) || b.lastSeq - a.lastSeq)
  return out
}
