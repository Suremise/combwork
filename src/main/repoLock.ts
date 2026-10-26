import { app } from 'electron'
import { basename, join } from 'path'
import { msg, tr } from '../shared/i18n'
import { advanced } from './advanced'
import { toast } from './events'
import { withFileLock } from './fsutil'
import { git } from './git'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import { REPO_LOCK_FILE, takeRepoLock } from './repoLockCore'

const log = createLogger('repoLock')

/**
 * The repository lock, as Hive's merges and ref moves take it (#1347, SPEC §16.9.3): across processes (repoLockCore.ts),
 * and within this one by withFileLock on the same file, so this Hive never waits on itself. Taken by the Git view's
 * folder actions (gitRepo.ts), a worktree's merge (the Merge dialog, agents' merges: projectAgents.ts) and the line
 * updater's move (gitPlatform.ts); later the merge queue's advance. Held for seconds: never across a test merge or merge
 * checks. No off switch: it is data safety (§16.6.4).
 */

/** How long a merge waits for another Hive's (Settings → Advanced). */
export const REPO_LOCK_WAIT = 'hive.merge.lockWaitSeconds'
/** How long a wait goes before the user is told who holds the lock. */
const NOTICE_AFTER_MS = 1000

const profile = (): string => {
  try {
    return basename(app.getPath('userData'))
  } catch {
    // No profile folder: the name alone.
    return 'profile'
  }
}

/** The repository's common git dir (its worktrees share it), absolute; throws when git can't say. */
export async function commonGitDir(folder: string): Promise<string> {
  const r = await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const dir = r.ok ? r.out.trim() : ''
  if (!dir) throw hiveError(msg({ id: 'git.repoLock.noGitDir', defaultMessage: "Hive couldn't find the git folder of {folder}, so nothing was changed: {why}", description: "An error: a merge or another change to a repository didn't start, because git couldn't name the repository's git folder (where Hive's merge lock lives). {why} is git's message." }), { folder, why: r.err || r.out })
  return dir
}

export interface RepoLockOptions {
  /** A background change (the line updater): no notice while it waits. */
  quiet?: boolean
  /** The project the notice is about. */
  project?: string
}

/**
 * Runs fn holding the repository lock of `folder`'s repository. A wait longer than a moment shows who holds it ("Another
 * Hive is merging into this repository (Hive-Dev)"); one longer than the Advanced setting's bound gives up with that, the
 * lock staying the holder's (a live holder is never taken over), and nothing of fn runs.
 */
export async function withRepoLock<T>(folder: string, fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const dir = await commonGitDir(folder)
  return withFileLock(join(dir, REPO_LOCK_FILE), async () => {
    const waitSeconds = advanced.number(REPO_LOCK_WAIT)
    const got = await takeRepoLock(dir, {
      profile: profile(),
      waitMs: waitSeconds * 1000,
      noticeAfterMs: NOTICE_AFTER_MS,
      onWait: (h) => {
        log.info(`Waiting for the repository lock of ${userText(folder)}, held by ${userText(h.profile)} (pid ${h.pid})`)
        if (!opts.quiet) toast('info', tr(msg({ id: 'git.repoLock.waiting', defaultMessage: 'Another Hive is merging into this repository ({profile})', description: "A notification's title: this Hive waits to merge into (or change) a repository because another Hive (its profile folder's name, {profile}, e.g. Hive-Dev) holds the repository's merge lock." }), { profile: h.profile }), tr(msg({ id: 'git.repoLock.waitingFor', defaultMessage: 'Hive waits for it to finish, up to {seconds, number} s.', description: 'The notification\'s text under "Another Hive is merging into this repository": how long this Hive waits for the other one, in seconds.' }), { seconds: waitSeconds }), undefined, opts.project)
      }
    })
    if ('timedOut' in got) {
      log.warn(`Gave up waiting for the repository lock of ${userText(folder)}, held by ${userText(got.timedOut.profile)} (pid ${got.timedOut.pid})`)
      throw hiveError(msg({ id: 'git.repoLock.busy', defaultMessage: 'Another Hive is merging into this repository ({profile}). Nothing was changed: try again once it has finished.', description: "An error: a merge or another change to a repository didn't start, because another Hive (its profile folder's name, {profile}) still held the repository's merge lock after Hive had waited for it." }), { profile: got.timedOut.profile }, { kind: 'conflict' })
    }
    try {
      return await fn()
    } finally {
      try {
        got.held.release()
      } catch (e) {
        // Left behind, the row is this process's own: the next take here replaces it, and another Hive does once this one ends.
        log.warn(`releasing the repository lock of ${userText(folder)}`, e)
      }
    }
  })
}

/**
 * Runs fn holding the repository locks of several folders' repositories (#1642 round 5: a workflow options write, which
 * can change the target of every project it reaches, taken as Clean Up Merged Branches takes it, across Hives): each
 * repository once, always in the same order (its git folder's path), so no two takers wait on each other. A folder in
 * no repository takes none. Taken before the turn of workflow writes, as everything that takes both does.
 */
export async function withRepoLocks<T>(folders: readonly string[], fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const byDir = new Map<string, string>()
  for (const f of folders) {
    const dir = await commonGitDir(f).catch(() => null)
    if (dir && !byDir.has(dir.toLowerCase())) byDir.set(dir.toLowerCase(), f)
  }
  const order = [...byDir].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, f]) => f)
  const from = (i: number): Promise<T> => (i === order.length ? fn() : withRepoLock(order[i], () => from(i + 1), opts))
  return from(0)
}
