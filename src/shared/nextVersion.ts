// HI-2807 (SPEC §16.6.2): Start the next version. A branch name that reads as a version (1.3.0, v2.1) and the next one
// it proposes, editable: the proposal only, never a rule (any name the user types is taken, as git takes it).

const VERSION = /^(v?)(\d+)\.(\d+)(\.\d+)?$/

/** Whether a branch's name reads as a version: X.Y or X.Y.Z, with an optional leading v. */
export const isVersionBranch = (name: string | null | undefined): boolean => !!name && VERSION.test(name.trim())

/** The next minor version in the same shape (1.3.0 → 1.4.0, v2.1 → v2.2, 1.3.7 → 1.4.0); null for a name that isn't a version. */
export function nextVersionName(name: string | null | undefined): string | null {
  const m = VERSION.exec((name ?? '').trim())
  if (!m) return null
  const minor = Number(m[3]) + 1
  return `${m[1]}${m[2]}.${minor}${m[4] !== undefined ? '.0' : ''}`
}

/** Where a new branch starts (HI-2807): what was asked (a branch, a tag, a commit) and the commit it was shown as, pinned. */
export interface BranchStart {
  ref: string
  commit: string
}

/** A start as a caller sent it (the window, the Agent API), checked: a ref and its commit, both strings; else null. */
export function branchStartArg(v: unknown): BranchStart | null {
  const o = v as Partial<BranchStart> | null
  if (!o || typeof o !== 'object' || typeof o.ref !== 'string' || !o.ref.trim()) return null
  return { ref: o.ref.trim().slice(0, 250), commit: typeof o.commit === 'string' ? o.commit.trim().slice(0, 64) : '' }
}

/** A start point resolved (HI-2807): its full commit, short hash and subject, and what the name is. */
export interface ResolvedStart {
  commit: string
  short: string
  subject: string
  kind: 'branch' | 'tag' | 'remote' | 'commit'
}

/** The names New branch…'s Starts at offers (HI-2807): local branches, tags and remote branches. */
export interface StartPoints {
  branches: string[]
  tags: string[]
  remote: string[]
}
