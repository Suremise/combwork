// HI-2556 (SPEC §16.6.2 G7b): the branches a lane or a card may merge into (its Merges into): the project's Work merges
// into (G7, or the default branch when empty) and its Other branches work can merge into (G7b). A pick is checked here
// as it is made, never at the start: the start takes what the card or its lane recorded (`card.target`, the lane's
// targeted ruleset, compile.ts `targetedOf`), so a change of the list moves nothing already chosen.
//
// A card's target can change only while its branch has no work (Darren, 7 Nov: no rebase of started work): never
// started, or every line it had holds nothing that isn't in its target already.

import { existsSync } from 'original-fs'
import { git } from '../git'
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

/** HI-2556: whether a listed branch is a local branch now (a pick names one work can start from); unknown: git can't say. */
export async function branchExists(projectPath: string, branch: string): Promise<boolean | 'unknown'> {
  const h = await G.lineHead(projectPath, branch)
  return isUnknown(h) ? 'unknown' : !!h
}

/**
 * Whether a card has work of its own (HI-2556): false when it never started, or each line it had is gone or holds
 * nothing its target doesn't already have, and the folder of its own line (its slot), still on that line, has nothing
 * uncommitted (tracked or not); unknown when git can't say (a pick is then refused).
 */
export async function hasOwnWork(projectPath: string, s: CardState, folder?: string | null): Promise<boolean | 'unknown'> {
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
  // Its own folder (a slot), as the put back left it: changes not committed there are its work too (HR2's round 1).
  if (folder && s.started && s.started.folder !== 'project' && existsSync(folder)) {
    const now = await G.worktreeNow(folder)
    if (isUnknown(now)) return 'unknown'
    if (now.line === s.started.line && now.dirty.length) return true
  }
  return false
}

/**
 * The lines a card with no work of its own had (HI-2556), deleted as its target changes, so its next start makes a fresh
 * one from the new target and never carries the old target's history (HR2's round 1). Each only where it still is what
 * was checked (compare and swap) and no worktree has it checked out; `checkedOut`: the folder that has one (the change is
 * then refused, nothing deleted); unknown when git can't say. Only a card's own lines (one built in a slot): a card
 * worked in the project folder has the folder's branch as its line, never dropped, nor any branch in `keep` (the
 * project's targets).
 */
export async function dropEmptyLines(projectPath: string, s: CardState, keep: readonly string[]): Promise<{ checkedOut: string } | 'unknown' | null> {
  const own = s.started && s.started.folder !== 'project' ? [...new Set(s.lines)].filter((l) => !keep.includes(l) && l !== s.started!.target) : []
  if (!own.length) return null
  const list = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (!list.ok) return 'unknown'
  const out = new Map<string, string>()
  let at = ''
  for (const row of list.out.split(/\r?\n/)) {
    if (row.startsWith('worktree ')) at = row.slice('worktree '.length)
    else if (row.startsWith('branch refs/heads/')) out.set(row.slice('branch refs/heads/'.length), at) // i18n-ignore: git's porcelain output, parsed
  }
  const heads: [string, string][] = []
  for (const line of own) {
    if (out.has(line)) return { checkedOut: out.get(line)! }
    const h = await G.lineHead(projectPath, line)
    if (isUnknown(h)) return 'unknown'
    if (h) heads.push([line, h])
  }
  for (const [line, h] of heads) {
    const r = await git(projectPath, ['update-ref', '-d', `refs/heads/${line}`, h])
    if (!r.ok) return 'unknown'
  }
  return null
}
