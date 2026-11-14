// A publish observation's authoritative step (HI-2882's J9b2, design HI-2882/s10–s22), run by the publish worker on a
// connection of its own to the workspace database: in one `BEGIN IMMEDIATE` transaction, its request's cancel fence
// (a shared flag its follow sets synchronously as it drops), the repository's and the store's identity (their folders'
// file ids and birth times: a `.jj` or a store replaced at the same path, even byte for byte, is another), the database
// binding, then J5's tail (the validator's synchronous reads, then the re-check and the settles, each a compare-and-set,
// jjPublishTail.ts), the fence again, and the commit. Anything that fails rolls the whole transaction back.
//
// The linearization (s19): committed exactly when the last fence read saw it live and the commit returned, with nothing
// in between; a request still waiting for the lock when its follow drops reads the fence set once it has the lock, and
// writes nothing. Pure: no Electron, no logger (a worker thread's).

import { statSync } from 'original-fs'
import { resolve } from 'path'
import type { PublishObserved } from './jjIntegration'
import { sqlObligations, type SqlDb } from './jjObligations'
import { publishTail, type PublishTailInput } from './jjPublishTail'

/** A folder's identity: its file id and birth time (J2's generation basis), or null when it can't be read. */
export function folderIdentity(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true })
    return `${s.ino}:${s.birthtimeNs}`
  } catch {
    return null
  }
}

/** One publish commit's request: its tail, its project and database, and the identities main read for it. */
export interface PublishCommitRequest {
  tail: PublishTailInput
  project: string
  file: string
  identity: { repo: string | null; store: string | null }
}

/** Why a request wrote nothing of its own: its follow dropped, its repository or store replaced, another database. */
export type PublishCommitRefused = { stale: 'cancelled' | 'replaced' | 'binding' }

export type PublishCommitAnswer = PublishObserved | PublishCommitRefused

/** Barriers a test pauses at (each synchronous, where it says). */
export interface PublishCommitSeams {
  /** Right before `BEGIN IMMEDIATE` is asked (it may wait for the lock there). */
  beforeBegin?: () => void
  /** After the tail's writes, before the last fence read and the commit. */
  beforeCommit?: () => void
}

const sameFile = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * The request's step on `db` (the worker's own connection to `req.file`): see the module's comment. `cancelled` reads the
 * request's fence (Atomics.load on its shared flag).
 */
export function commitPublish(db: SqlDb & { exec(sql: string): void }, req: PublishCommitRequest, cancelled: () => boolean, seams: PublishCommitSeams = {}): PublishCommitAnswer {
  const identityHolds = (): boolean => folderIdentity(req.tail.view.jjRepo) === req.identity.repo && folderIdentity(req.tail.view.store) === req.identity.store && req.identity.repo !== null && req.identity.store !== null
  if (cancelled()) return { stale: 'cancelled' }
  if (!identityHolds()) return { stale: 'replaced' }
  seams.beforeBegin?.()
  db.exec('BEGIN IMMEDIATE')
  let done = false
  try {
    // The lock held: the fence first, then the repository's and store's identity, then the database's binding.
    if (cancelled()) return { stale: 'cancelled' }
    if (!identityHolds()) return { stale: 'replaced' }
    const main = (db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find((d) => d.name === 'main') // i18n-ignore: SQL
    if (!main?.file || !sameFile(main.file, req.file)) return { stale: 'binding' }
    const out = publishTail(sqlObligations(db, req.project), req.tail)
    if ('jjUnknown' in out) return out
    seams.beforeCommit?.()
    if (cancelled()) return { stale: 'cancelled' }
    db.exec('COMMIT')
    done = true
    return out
  } finally {
    if (!done) db.exec('ROLLBACK')
  }
}
