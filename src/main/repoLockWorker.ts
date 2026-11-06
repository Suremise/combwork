import { parentPort } from 'worker_threads'
import { releaseRepoLock, takeRepoLock, type HeldRepoLock, type RepoLockHolder } from './repoLockCore'

/**
 * The repository lock's worker (HI-1680): a thread of its own that runs repoLockCore's takes and releases, so their
 * SQLite steps (its busy wait, and the fsyncs of each commit, 100 ms to seconds on a loaded disk) never hold up Combwork's
 * main process, and with it the keystrokes typed into a pane. The lock is the same: the same row in the same file,
 * taken and released by the same rules (SPEC §16.9.3), only off main's thread. Its process is main's, so its rows name
 * main's pid. It keeps each held lock's connection until main releases it; a lock it doesn't know (it was started again
 * meanwhile) is released by its token on a connection of its own. No Electron here (a worker can't load it): what is
 * slow goes to main to log.
 */

export type LockRequest = { id: number } & ({ type: 'take'; dir: string; profile: string; waitMs: number; noticeAfterMs: number; file?: string } | { type: 'release'; dir: string; token: string; file?: string })

/** A take's answer: the lock's token, or who holds it after the wait. */
export type TakeAnswer = { token: string } | { timedOut: RepoLockHolder }

export type LockReply = { id: number; ok: true; value: TakeAnswer | null } | { id: number; ok: false; error: string } | { id: number; waiting: RepoLockHolder } | { slow: { step: string; ms: number; dir: string } }

/** The locks held now, by token, each with its connection for its release. */
const held = new Map<string, HeldRepoLock>()

/** Runs one request, telling `post` of a wait and of a slow step on the way; resolves with its answer. */
export async function handleRequest(m: LockRequest, post: (r: LockReply) => void): Promise<TakeAnswer | null> {
  const onSlow = (step: string, ms: number): void => post({ slow: { step, ms, dir: m.dir } })
  if (m.type === 'release') {
    const h = held.get(m.token)
    held.delete(m.token)
    if (h) h.release()
    else releaseRepoLock(m.dir, m.token, onSlow, m.file)
    return null
  }
  const got = await takeRepoLock(m.dir, { profile: m.profile, waitMs: m.waitMs, noticeAfterMs: m.noticeAfterMs, onSlow, onWait: (holder) => post({ id: m.id, waiting: holder }), ...(m.file ? { file: m.file } : {}) })
  if ('timedOut' in got) return { timedOut: got.timedOut }
  held.set(got.held.token, got.held)
  return { token: got.held.token }
}

const port = parentPort
if (port) {
  const post = (r: LockReply): void => port.postMessage(r)
  port.on('message', (m: LockRequest) => {
    handleRequest(m, post).then(
      (value) => post({ id: m.id, ok: true, value }),
      (e: unknown) => post({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    )
  })
}
