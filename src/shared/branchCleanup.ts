// Branches by their state, and what Clean Up Merged Branches offers (#1642, SPEC §16.20's Git support): pure, so the
// window groups and offers with the same rules main checks each deletion against.

import type { BranchAt, GitBranchRow, GitRemoteBranchRow, GitRepoInfo } from './gitRepo'
import type { BranchCard } from './branchCards'

/** In use: the target, the default branch, the project folder's, one checked out in a worktree or a slot, or an open card's. */
export type BranchGroup = 'inUse' | 'merged' | 'unmerged'

export const BRANCH_GROUPS: readonly BranchGroup[] = ['inUse', 'merged', 'unmerged']

/** The branches an open card (any but Done) works on: never offered, never deleted. */
export function busyLines(onBranch: ReadonlyMap<string, readonly Pick<BranchCard, 'stage'>[]>): Set<string> {
  return new Set([...onBranch].filter(([, cards]) => cards.some((c) => c.stage !== 'done')).map(([line]) => line))
}

type Targets = Pick<GitRepoInfo, 'target' | 'defaultBranch'>

/** Why a local branch is in use, or null: free. */
export function localUse(b: Pick<GitBranchRow, 'name' | 'current' | 'worktree'>, info: Targets, busy: ReadonlySet<string>): 'target' | 'default' | 'current' | 'worktree' | 'card' | null {
  if (b.name === info.target) return 'target'
  if (b.name === info.defaultBranch) return 'default'
  if (b.current) return 'current'
  if (b.worktree) return 'worktree'
  if (busy.has(b.name)) return 'card'
  return null
}

/** A local branch's group; null with no target to measure against (the list isn't grouped then). */
export function localGroup(b: GitBranchRow, info: Targets, busy: ReadonlySet<string>): BranchGroup | null {
  if (!info.target) return null
  if (localUse(b, info, busy)) return 'inUse'
  return b.toTarget === 0 ? 'merged' : 'unmerged'
}

/** A remote branch the remote's own default, or named as the project's target or default branch: never offered. */
export const remoteKept = (r: Pick<GitRemoteBranchRow, 'branch' | 'remoteHead'>, info: Targets): boolean => r.remoteHead || r.branch === info.target || r.branch === info.defaultBranch

export function remoteGroup(r: GitRemoteBranchRow, info: Targets): BranchGroup | null {
  if (!info.target) return null
  if (remoteKept(r, info)) return 'inUse'
  return r.toTarget === 0 ? 'merged' : 'unmerged'
}

export interface RemoteOffer extends BranchAt {
  remote: string
  /** On the remote. */
  branch: string
  /** A local branch of the same name is offered too: suggested with it, still ticked on its own. */
  withLocal: boolean
}

export interface CleanupOffer {
  local: BranchAt[]
  remote: RemoteOffer[]
}

/**
 * What Clean Up Merged Branches offers: the local branches merged into the target that nothing uses (never the target,
 * the default branch, the folder's, a worktree's or slot's, an open card's), and apart, the remote branches merged into
 * it (never a remote's default, the target or the default branch, nor one whose local branch is in use). Unmerged
 * branches are never offered in bulk.
 */
export function cleanupOffer(info: Pick<GitRepoInfo, 'branches' | 'remoteRows' | 'target' | 'defaultBranch'>, busy: ReadonlySet<string>): CleanupOffer {
  if (!info.target) return { local: [], remote: [] }
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'en')
  const local = info.branches.filter((b) => b.sha && b.toTarget === 0 && !localUse(b, info, busy)).map((b) => ({ name: b.name, sha: b.sha! }))
  const names = new Set(local.map((b) => b.name))
  // A remote branch whose local one is in use (a slot's, a worktree's, an open card's) stays too.
  const used = new Set(info.branches.filter((b) => localUse(b, info, busy)).map((b) => b.name))
  const remote = (info.remoteRows ?? []).filter((r) => r.toTarget === 0 && !remoteKept(r, info) && !used.has(r.branch)).map((r) => ({ name: r.name, sha: r.sha, remote: r.remote, branch: r.branch, withLocal: names.has(r.branch) }))
  return { local: local.sort(byName), remote: remote.sort(byName) }
}

/**
 * The Changes tab's leftover branches (HI-1823): the local branches nothing uses (localUse: not the target, the default
 * or the folder's branch, none checked out in a worktree or slot, no open card's), so a Done or archived card's, an
 * agent's from before slots, one of no card: merged into the target, or not (with the commits it has that the target
 * hasn't, when counted). Empty with no target to measure against. By name.
 */
export function leftoverBranches(info: Pick<GitRepoInfo, 'branches' | 'target' | 'defaultBranch'>, busy: ReadonlySet<string>): { merged: GitBranchRow[]; unmerged: GitBranchRow[] } {
  if (!info.target) return { merged: [], unmerged: [] }
  const free = info.branches.filter((b) => b.sha && !localUse(b, info, busy)).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return { merged: free.filter((b) => b.toTarget === 0), unmerged: free.filter((b) => b.toTarget !== 0) }
}
