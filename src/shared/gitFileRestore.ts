// HI-3477: the Files tab's Discard Changes… and Restore From… (SPEC §16.10.2, Discard and restore a file): one tracked
// file of the project folder put back to the commit checked out, or to its version on the project's target or in a
// commit of its own history. What the window asks for and what main answers; main's Git is gitFileRestore.ts.
import type { GitCommitRow } from './gitRepo'
import type { GitDiff } from './types'

/** Where the file's version comes from: the commit checked out (Discard), the project's target, or a commit picked. */
export type RestoreSource = 'head' | 'target' | 'commit'

export const isRestoreSource = (v: unknown): v is RestoreSource => v === 'head' || v === 'target' || v === 'commit'

/** What a Discard or a Restore would do, for its confirm: the file on disk now against what it becomes. */
export interface FileRestorePlan {
  rel: string
  source: RestoreSource
  /** The commit its version comes from (whole): the restore uses this one, even if the target moves meanwhile. */
  commit: string
  short: string
  /** The target branch's name (source `target`). */
  target: string | null
  /** Whether the file is in that commit: a Restore of one that isn't is refused. */
  exists: boolean
  /** Whether it has uncommitted changes (staged or not): they are stashed first, so nothing is lost. */
  changed: boolean
  /** original: the file on disk now; modified: what it becomes. */
  diff: GitDiff
}

/** A Restore as the window asks for it: the file, its source, and the commit its confirm showed. */
export interface FileRestoreRequest {
  rel: string
  source: RestoreSource
  commit: string
}

/** What a Discard or a Restore did: whether the old version was stashed (it had uncommitted changes). */
export interface FileRestored {
  stashed: boolean
}

/** A page of the commits that changed the file, newest first (HISTORY_COMMITS a page), on the folder's branch. */
export interface FileCommits {
  commits: GitCommitRow[]
  page: number
  pages: number
  total: number
}

const isCommit = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v)

/** A request as the window sent it, checked; null when it is anything else. */
export function restoreRequestOf(raw: unknown): FileRestoreRequest | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.rel !== 'string' || !r.rel || !isRestoreSource(r.source) || !isCommit(r.commit)) return null
  return { rel: r.rel, source: r.source, commit: r.commit }
}

/** A commit the window names (A Commit…'s pick), checked. */
export const restoreCommitOf = (v: unknown): string | null => (isCommit(v) ? v : null)
