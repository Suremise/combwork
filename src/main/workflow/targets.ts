// HI-2556 (SPEC §16.6.2 G7b): the branches a lane or a card may merge into (its Merges into): the project's Work merges
// into (G7, or the default branch when empty) and its Other branches work can merge into (G7b). A pick is checked here
// as it is made, never at the start: the start takes what the card or its lane recorded (`card.target`, the lane's
// targeted ruleset, compile.ts `targetedOf`), so a change of the list moves nothing already chosen.
//
// A card's target can change only while its branch has no work (Darren, 7 Nov: no rebase of started work): never
// started, or every line it had holds nothing that isn't in its target already.

import { existsSync } from 'original-fs'
import { historyOf, lineHistory } from '../platform/historyPorts'
import { isUnknown } from '../platform/types'
import type { WorkspaceService } from '../workspace'
import type { CardState } from '../../shared/workflow/facts'
import { projectPlatform } from '../platform/registry'
import { resolvedOf } from './rulesets'
import { combworkError } from '../combworkError'
import { fmt, msg } from '../../shared/i18n'

/** A project's targets: its default (G7 resolved) and the others it lists (G7b); null when it has no Git workflow. */
export interface ProjectTargets {
  default: string
  others: string[]
}

/** The targets a lane or card of this project may name, as the options resolve now; null: not a Git project, or no default readable. */
export async function projectTargets(ws: WorkspaceService, projectPath: string): Promise<ProjectTargets | null> {
  const cfg = await ws.projectConfig(projectPath)
  const platform = projectPlatform(projectPath, cfg.platform).id
  const H = historyOf(platform)
  if (!H) return null
  const o = resolvedOf(ws, projectPath, platform, cfg).options
  const fallback = o.target ? null : await H.defaultTarget(projectPath).catch(() => null)
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

/** HI-2556: whether a listed branch is a local branch now (a pick names one work can start from); unknown: git can't say. */
export async function branchExists(projectPath: string, branch: string): Promise<boolean | 'unknown'> {
  const h = await lineHistory().lineHead(projectPath, branch)
  return isUnknown(h) ? 'unknown' : !!h
}

/**
 * HI-2885 (SPEC §16.9): the branches a forward merge may bring into one of a project's `targets`: those targets, and the
 * repository's default branch (`main`) whether or not it is one of them, once a release has gone to it. Only a default
 * branch git names and that exists now: one git can't read adds nothing.
 */
export async function forwardSources(ws: WorkspaceService, projectPath: string, targets: readonly string[]): Promise<string[]> {
  const H = historyOf(projectPlatform(projectPath, (await ws.projectConfig(projectPath)).platform).id)
  const d = H ? await H.defaultTarget(projectPath).catch(() => null) : null
  const main = d && !isUnknown(d) && (await branchExists(projectPath, d)) === true ? d : null
  return [...new Set([...targets, ...(main ? [main] : [])])]
}

/** The branches a project's options name as targets: Work merges into (when set) and Other branches work can merge into. */
const namedTargets = (o: { target?: string; otherTargets?: string[] }): string[] => [...new Set([o.target ?? '', ...(o.otherTargets ?? [])].map((b) => b.trim()).filter(Boolean))]

/**
 * HI-2807: the branches a change newly names as targets (in `will`, not in `was`) that aren't local branches now: a
 * target nothing can start from. One git can't answer for isn't counted; branches already named stay as they are.
 */
export async function newlyMissing(projectPath: string, was: { target?: string; otherTargets?: string[] }, will: { target?: string; otherTargets?: string[] }): Promise<string[]> {
  const before = new Set(namedTargets(was))
  const out: string[] = []
  for (const b of namedTargets(will).filter((x) => !before.has(x))) if ((await branchExists(projectPath, b)) === false) out.push(b)
  return out
}

const MISSING = msg({ id: 'service.workflow.targetMissing', defaultMessage: '{n, plural, one {{branches} doesn’t exist} other {{branches} don’t exist}}, so nothing was saved: create {n, plural, one {it} other {them}} first (Version Control → New branch…).', description: 'HI-2807: a save of workflow options refused: Work merges into or Other branches work can merge into names branches ({branches}, {n} of them) the repository hasn’t got. New branch… is a button: as translated there.' })

/**
 * HI-2807: refuses a save naming new targets that don't exist (`newlyMissing`), in every save's write (the Workflow
 * section's, the Assistant's settings tool, Start the next version), so a branch gone after the window's check is still
 * caught.
 */
export async function refuseMissingTargets(projectPath: string, was: { target?: string; otherTargets?: string[] }, will: { target?: string; otherTargets?: string[] }): Promise<void> {
  const missing = await newlyMissing(projectPath, was, will)
  if (missing.length) throw combworkError(MISSING, { n: missing.length, branches: fmt.list(missing) }, { kind: 'invalid' })
}

/**
 * A card's own work (HI-2556) and the evidence it was decided on: `work` false when it never started, or each line it
 * had is gone or holds nothing its target doesn't already have, and the folder it worked in holds nothing uncommitted
 * (tracked or not): its slot while still on its line; the project folder, whatever is uncommitted there (HR2's round 2:
 * who made it can't be told apart, so it counts). Unknown when git can't say (a pick is then refused). `heads`: each
 * line's head as it was found empty (null: none), the only ones `dropEmptyLines` may delete.
 */
export async function ownWork(projectPath: string, s: CardState, folder?: string | null): Promise<{ work: boolean | 'unknown'; heads: Map<string, string | null> }> {
  const heads = new Map<string, string | null>()
  if (!s.started && !s.lines.length) return { work: false, heads }
  const H = lineHistory()
  const target = s.started?.target ?? null
  const th = target ? await H.lineHead(projectPath, target) : null
  if (isUnknown(th)) return { work: 'unknown', heads }
  for (const line of s.lines) {
    const lh = await H.lineHead(projectPath, line)
    if (isUnknown(lh)) return { work: 'unknown', heads }
    heads.set(line, lh)
    if (!lh || lh === s.started?.base || lh === th) continue
    if (!th) return { work: true, heads }
    const inTarget = await H.isAncestor(projectPath, lh, th)
    if (isUnknown(inTarget)) return { work: 'unknown', heads }
    if (!inTarget) return { work: true, heads }
  }
  // The folder it worked in, as the put back left it: changes not committed there are its work too (HR2's rounds 1, 2).
  const where = !s.started ? null : s.started.folder === 'project' ? projectPath : folder
  if (s.started && where && existsSync(where)) {
    const now = await H.workspaceNow(where)
    if (isUnknown(now)) return { work: 'unknown', heads }
    if (now.dirty.length && (s.started.folder === 'project' || now.line === s.started.line)) return { work: true, heads }
  }
  return { work: false, heads }
}

/** Whether a card has work of its own (`ownWork`'s answer alone). */
export async function hasOwnWork(projectPath: string, s: CardState, folder?: string | null): Promise<boolean | 'unknown'> {
  return (await ownWork(projectPath, s, folder)).work
}

/**
 * The lines a card with no work of its own had (HI-2556), deleted as its target changes, so its next start makes a fresh
 * one from the new target and never carries the old target's history (HR2's round 1). Each only at the head `ownWork`
 * found empty (`heads`, compare and swap: one moved since, by anyone, is refused, never deleted; HR2's round 2) and
 * while no worktree has it checked out; `checkedOut`: the folder that has one; `moved`: a line that isn't as it was
 * found; unknown when git can't say. Refused, nothing more is deleted. Only a card's own lines (one built in a slot): a
 * card worked in the project folder has the folder's branch as its line, never dropped, nor any branch in `keep`.
 */
export async function dropEmptyLines(projectPath: string, s: CardState, keep: readonly string[], heads: ReadonlyMap<string, string | null>): Promise<{ checkedOut: string } | 'moved' | 'unknown' | null> {
  const own = s.started && s.started.folder !== 'project' ? [...new Set(s.lines)].filter((l) => !keep.includes(l) && l !== s.started!.target) : []
  if (!own.length) return null
  const H = lineHistory()
  const out = await H.checkedOutLines(projectPath)
  if (isUnknown(out)) return 'unknown'
  const drop: [string, string][] = []
  for (const line of own) {
    if (out.has(line)) return { checkedOut: out.get(line)! }
    if (!heads.has(line)) return 'unknown'
    const found = heads.get(line) ?? null
    const h = await H.lineHead(projectPath, line)
    if (isUnknown(h)) return 'unknown'
    if ((h ?? null) !== found) return 'moved'
    if (found) drop.push([line, found])
  }
  // Each deleted only if it is still the head found empty: the platform refuses one moved meanwhile.
  for (const [line, h] of drop) if (!(await H.deleteLine(projectPath, line, h))) return 'moved'
  return null
}
