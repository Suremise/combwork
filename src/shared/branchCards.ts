// Branches next to their cards (#1424, SPEC §16.20's Git support): which cards a project's branch is the line of, from the
// cards' badges (`WorkBadge.line`, this cycle's Started or Adopted), for Version Control → Branches & remotes; and the card
// a worktree's agent is on, for its worktree's row. Pure: the window gives it the badges it already reads
// (`tasks:workBadges`) and the board's cards.

import type { TaskCard } from './types'
import type { WorkBadge } from './workflow/workView'
import { CATEGORY_STAGE } from './workflow/facts'

/** A card as a branch's or worktree's row shows it. */
export interface BranchCard {
  card: number
  stage: WorkBadge['stage']
  /** In Review: the revision under review (whole). */
  underReview: string | null
  /** Done: the target's revision with its change in it (`Integrated`'s result), if it was merged. */
  merged: string | null
  /** When its current cycle started: a branch's cards come one after another, the latest first. */
  startedAt: string | null
}

const rowOf = (b: WorkBadge): BranchCard => ({ card: b.card, stage: b.stage, underReview: b.underReview, merged: b.stage === 'done' ? b.merged : null, startedAt: b.startedAt })

const inFlight = (c: BranchCard): boolean => c.stage !== 'done' && c.stage !== 'todo'

/**
 * The latest first by when each card's current cycle started, never by its last fact (HR4's #1424 round 1: a refusal on
 * an old card mustn't put it before the card after it); a card in flight before them all.
 */
const order = (a: BranchCard, b: BranchCard): number => Number(inFlight(b)) - Number(inFlight(a)) || (b.startedAt ?? '').localeCompare(a.startedAt ?? '')

/**
 * Each branch of a project with the cards whose current cycle's line it is (no-code cards have no line, and archived
 * ones aren't read), by branch name: the card in flight first, then the latest (a branch is an agent's worktree's, one
 * card after another).
 */
export function branchCards(project: string, tasks: readonly Pick<TaskCard, 'number' | 'project'>[], badges: ReadonlyMap<number, WorkBadge>): Map<string, BranchCard[]> {
  const out = new Map<string, BranchCard[]>()
  const mine = new Set(tasks.filter((t) => t.project.toLowerCase() === project.toLowerCase()).map((t) => t.number))
  for (const b of badges.values()) {
    if (!b.line || b.noCode || !mine.has(b.card)) continue
    const list = out.get(b.line) ?? []
    list.push(rowOf(b))
    out.set(b.line, list)
  }
  for (const list of out.values()) list.sort(order)
  return out
}

const AGENT_COLUMNS: readonly TaskCard['column'][] = ['doing', 'review', 'passed']

/**
 * The card an agent is on (#1424: a worktree names its agent's card, whatever its folder has checked out): its cards in
 * Doing, else Review, else Passed, the latest started first. None for an agent on no card, or no agent.
 */
export function agentCard(project: string, agent: string | null | undefined, tasks: readonly Pick<TaskCard, 'number' | 'project' | 'agent' | 'column'>[], badges: ReadonlyMap<number, WorkBadge>): BranchCard[] {
  if (!agent) return []
  const rank = (c: Pick<TaskCard, 'column'>): number => AGENT_COLUMNS.indexOf(c.column)
  const mine = tasks.filter((t) => t.agent === agent && t.project.toLowerCase() === project.toLowerCase() && rank(t) >= 0)
  const rows = mine.map((t) => ({ row: badges.get(t.number) ? rowOf(badges.get(t.number)!) : { card: t.number, stage: CATEGORY_STAGE[t.column], underReview: null, merged: null, startedAt: null }, rank: rank(t) }))
  rows.sort((a, b) => a.rank - b.rank || (b.row.startedAt ?? '').localeCompare(a.row.startedAt ?? ''))
  return rows.map((r) => r.row)
}
