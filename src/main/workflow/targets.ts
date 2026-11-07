// HI-2556 (SPEC §16.6.2 G7b): the branches a lane or a card may merge into (its Merges into): the project's Work merges
// into (G7, or the default branch when empty) and its Other branches work can merge into (G7b). A pick is checked here
// as it is made, never at the start: the start takes what the card or its lane recorded (`card.target`, the lane's
// targeted ruleset, compile.ts `targetedOf`), so a change of the list moves nothing already chosen.
//
// A card's target can change only while its branch has no work (Darren, 7 Nov: no rebase of started work): never
// started, or every line it had holds nothing that isn't in its target already.

import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { WorkspaceService } from '../workspace'
import type { CardState } from '../../shared/workflow/facts'
import { projectPlatform } from '../platform/registry'
import { resolvedOf } from './rulesets'

/** A project's targets: its default (G7 resolved) and the others it lists (G7b); null when it has no Git workflow. */
export interface ProjectTargets {
  default: string
  others: string[]
}

/** The targets a lane or card of this project may name, as the options resolve now; null: not a Git project, or no default readable. */
export async function projectTargets(ws: WorkspaceService, projectPath: string): Promise<ProjectTargets | null> {
  const cfg = await ws.projectConfig(projectPath)
  if (projectPlatform(projectPath, cfg.platform).id !== 'git') return null
  const o = resolvedOf(ws, projectPath, 'git', cfg).options
  const fallback = o.target ? null : await G.defaultBranch(projectPath).catch(() => null)
  const def = o.target || (fallback && !isUnknown(fallback) ? fallback : '')
  if (!def) return null
  return { default: def, others: (o.otherTargets ?? []).filter((b) => b !== def) }
}

/**
 * A pick checked against the project's targets: `null` (the default, stored as none), the branch named, or `notListed`
 * with what may be named. Empty, null or the default itself is the default.
 */
export function pickTarget(t: ProjectTargets | null, raw: unknown): { target: string | null } | { notListed: ProjectTargets | null } {
  if (raw === undefined || raw === null || raw === '') return { target: null }
  if (typeof raw !== 'string') return { notListed: t }
  const b = raw.trim()
  if (!b || (t && b === t.default)) return { target: null }
  return t && t.others.includes(b) ? { target: b } : { notListed: t }
}

/**
 * Whether a card has work of its own on a branch (HI-2556): false when it never started, or each line it had is gone or
 * holds nothing its target doesn't already have; unknown when git can't say (a pick is then refused).
 */
export async function hasOwnWork(projectPath: string, s: CardState): Promise<boolean | 'unknown'> {
  if (!s.started && !s.lines.length) return false
  const target = s.started?.target ?? null
  const th = target ? await G.lineHead(projectPath, target) : null
  if (isUnknown(th)) return 'unknown'
  for (const line of s.lines) {
    const lh = await G.lineHead(projectPath, line)
    if (isUnknown(lh)) return 'unknown'
    if (!lh || lh === s.started?.base || lh === th) continue
    if (!th) return true
    const inTarget = await G.isAncestor(projectPath, lh, th)
    if (isUnknown(inTarget)) return 'unknown'
    if (!inTarget) return true
  }
  return false
}
