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
  /** One jj command (`cw.jj.commandSeconds`, 300 s); `jj --version` keeps its own. */
  jjCommandMs: (): number => 300_000
}
