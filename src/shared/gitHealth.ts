// HI-3473: Version Control → Branches & remotes' Repository health: three of git's own repairs, each listed first and
// done only on the user's confirm, never by Combwork itself and never while anything works on the repository (an
// agent's session, a run, the merge queue or a merge): prune worktree entries whose folder is gone, remove a lock file
// a git that died left behind, and fetch a remote dropping the remote-tracking branches deleted on it.

/** Who a stale worktree entry was for, as Combwork records it: one of its slots, an agent's 0.9 worktree, or neither. */
export type PrunableOwner = { kind: 'slot'; name: string } | { kind: 'agent'; name: string } | null

/** HI-3473: a worktree entry `git worktree prune` would drop (its folder gone), as the dry run lists it. */
export interface PrunableWorktree {
  /** Its name under the repository's `worktrees` folder. */
  id: string
  /** The folder it was at (its `gitdir`'s), or null when git's entry doesn't say. */
  folder: string | null
  /** Git's reason, in git's words (English). */
  reason: string
  owner: PrunableOwner
}

/** Why a lock file isn't stale, as the window says it. */
export type LockHeld =
  /** Younger than `cw.git.staleLockSeconds`: a git may be working with it now. */
  | { why: 'young'; seconds: number }
  /** A git process that started before the lock was last written still runs: it may be the one holding it. */
  | { why: 'process'; pid: number; name: string; started: number }
  /** Windows' process list couldn't be read whole, so no process can be ruled out. */
  | { why: 'unlisted' }

/** HI-3473: a lock file of git's in the repository's git folder. */
export interface GitLockFile {
  /** Its path under the repository's common git folder, with forward slashes (`index.lock`, `worktrees/slot-a/index.lock`, `refs/heads/main.lock`). */
  path: string
  /** When it was last written or made, whichever is later (ms). */
  at: number
  size: number
  /** What the confirm hands back, so only the file the user saw is removed: its file id, times and size. */
  stamp: string
  /** Null when it is stale (it may be removed); else why not. */
  held: LockHeld | null
}

/** HI-3473: what Repository health finds in a repository without reaching a remote. */
export interface RepoHealth {
  worktrees: PrunableWorktree[]
  locks: GitLockFile[]
  /** How old a lock must be to be stale (`cw.git.staleLockSeconds`), as the dialog says it. */
  staleSeconds: number
}

/** HI-3473: a remote's remote-tracking branches deleted on it, as `git remote prune --dry-run` lists them. */
export interface RemotePrune {
  remote: string
  /** Each one as git names it (`origin/old`), with the local branches that track it. */
  branches: { name: string; trackedBy: string[] }[]
  /** Git's error line for this remote (unreachable, a sign-in refused), or absent. */
  error?: string
}

/** A worktree entry the confirm acts on: as the list showed it. */
export interface PruneAsk {
  id: string
  folder: string | null
}

/** A lock the confirm acts on: as the list showed it. */
export interface LockAsk {
  path: string
  stamp: string
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096

/** The confirm's worktree entries as the window sent them, or null when malformed (refused before anything runs). */
export function pruneAsks(raw: unknown): PruneAsk[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 500) return null
  const out: PruneAsk[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || !isText(r.id) || /[\\/]|^\.\.?$/.test(r.id) || !(r.folder === null || isText(r.folder))) return null
    out.push({ id: r.id, folder: r.folder as string | null })
  }
  return out
}

/** The confirm's locks as the window sent them, or null when malformed: a path under the git folder, never out of it. */
export function lockAsks(raw: unknown): LockAsk[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 500) return null
  const out: LockAsk[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || !isText(r.path) || !isText(r.stamp) || !r.path.endsWith('.lock') || r.path.includes('\\') || r.path.startsWith('/') || /^[a-z]:/i.test(r.path) || r.path.split('/').some((p) => p === '' || p === '.' || p === '..')) return null
    out.push({ path: r.path, stamp: r.stamp })
  }
  return out
}

/** The confirm's remotes as the window sent them, or null when malformed. */
export function remoteAsks(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) return null
  return raw.every((r) => isText(r) && !r.startsWith('-') && !/[\s\\]/.test(r)) ? [...new Set(raw as string[])] : null
}
