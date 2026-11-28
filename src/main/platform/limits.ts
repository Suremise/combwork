/**
 * HI-3372: the bounds the version-control ports read from Settings → Advanced, as getters main sets once at its start
 * (limitsApp.ts), so a port never loads Electron or the settings itself. Each default is its setting's own, for code
 * that runs before main has set them (unit tests): a test sets the getter to prove the value reaches its request.
 */
export const platformLimits = {
  /** A Commit or Set aside of a folder's changes, a last resort: the user can cancel it (`cw.git.commitMinutes`, 30 min). */
  gitCommitMs: (): number => 30 * 60_000,
  /** The user's Fetch, Pull and Push, a last resort: cancellable (`cw.git.networkMinutes`, 30 min). */
  gitNetworkMs: (): number => 30 * 60_000,
  /** The merge queue's own fetches and pushes (`cw.queue.networkMinutes`, 30 min). */
  queueNetworkMs: (): number => 30 * 60_000,
  /** One of the merge queue's checks, which a follow-mode pre-push hook is too (`cw.queue.checkMinutes`, 90 min). */
  queueCheckMs: (): number => 90 * 60_000,
  /** HI-3475: one read of the Files tab's History (a page with its cards, a commit's diff, its merge), git ended at it (`cw.git.historySeconds`, 60 s). */
  gitHistoryMs: (): number => 60_000,
  /** HI-3476: blame asks first for a file with more lines than this (`cw.git.blameAskLines`, 20,000). */
  blameAskLines: (): number => 20_000,
  /** HI-3473: how old a lock file of git's must be before Repository health calls it stale (`cw.git.staleLockSeconds`, 60 s). */
  staleLockMs: (): number => 60_000,
  /** HI-3473: the program names that count as a git that may hold a lock (`cw.git.processNames`). */
  gitProcessNames: (): RegExp => /^git(?:-remote-[a-z0-9.+-]+)?\.exe$/i
}
