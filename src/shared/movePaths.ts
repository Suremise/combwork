import type { MovePlan } from './types'

/**
 * Paths after a workspace or project folder moved (#146): what a stored absolute path becomes, compared as Windows
 * does (without case, either separator) and only at folder boundaries, so `D:\Dev\HIVE` never matches `D:\Dev\HIVE2`.
 * Pure, for both the plan and the repair in main/workspaceMove.ts.
 */

export interface PathMove {
  from: string
  to: string
}

/**
 * Whether a plan has anything for Repair to do or say: a worktree, a session folder, files to copy, files that couldn't
 * be read or copied (kept pending, so Repair says why), files already there with other content (shown once, never
 * overwritten), Open Recent or Working on, or records by an old folder that couldn't all follow (HI-2007).
 */
export function moveHasWork(plan: MovePlan): boolean {
  return plan.recent || !!plan.profile?.length || plan.working.length > 0 || !!plan.cards?.length || plan.hosts.some((h) => h.worktrees.length > 0 || h.sessions > 0 || h.folders.some((f) => f.copy > 0 || f.kept.length > 0 || !!f.failed?.length) || !!h.branches?.some((b) => !b.kept))
}

const trimEnd = (p: string): string => p.replace(/[\\/]+$/, '')
const comparable = (p: string): string => trimEnd(p).replace(/\//g, '\\').toLowerCase()

/** Whether two paths name the same folder. */
export function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

/** p moved along with `from` to `to`: its new path, keeping the case of the part below; null when it isn't under `from`. */
export function rebase(p: string, from: string, to: string): string | null {
  const cp = comparable(p)
  const cf = comparable(from)
  if (!cf) return null
  if (cp === cf) return trimEnd(to)
  if (!cp.startsWith(cf + '\\')) return null
  const sep = to.includes('/') && !to.includes('\\') ? '/' : '\\'
  return trimEnd(to) + sep + trimEnd(p).slice(trimEnd(from).length + 1)
}

/** p under the deepest of the moves that contains it, moved with it; null when none does. */
export function rebaseAny(p: string, moves: PathMove[]): string | null {
  const deepest = [...moves].sort((a, b) => comparable(b.from).length - comparable(a.from).length)
  for (const m of deepest) {
    const r = rebase(p, m.from, m.to)
    if (r !== null) return r
  }
  return null
}

/**
 * Where an agent's worktree may be now, most likely first: moved along inside its project or the workspace, moved
 * along in the workspace's worktrees folder beside it (`<workspace>.worktrees`, where Combwork creates them), or still
 * where it was. The first that is a worktree folder wins.
 */
export function worktreeCandidates(old: string, workspace: PathMove, project: PathMove): string[] {
  const out: string[] = []
  const add = (p: string | null): void => {
    if (p && !out.some((q) => samePath(q, p))) out.push(p)
  }
  add(rebase(old, project.from, project.to))
  add(rebase(old, workspace.from, workspace.to))
  add(rebase(old, `${trimEnd(workspace.from)}.worktrees`, `${trimEnd(workspace.to)}.worktrees`))
  add(trimEnd(old))
  return out
}
