import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { openLockDb } from './db'

/**
 * The repository lock's core (#1347, SPEC §16.9.3): one lock per repository, across processes (the dev and the installed
 * Hive, a test Hive), so two can't merge into or move the refs of one repository at once. It depends on nothing of
 * Electron's, so tests run it in plain Node children too; repoLock.ts is what the app calls.
 *
 * The lock is a row, not a file's existence: renaming or unlinking a lock file can't be made safe, since two contenders
 * can both judge it stale and a late release can unlink a successor's. The row lives in a small SQLite database in the
 * repository's common git dir (`hive-merge.lock`, shared by its worktrees), one row (`id` 1) naming its holder by a
 * random token, pid, the process's start time (a reused pid is another process) and Hive's profile.
 * - Take: with no row, write ours (`BEGIN IMMEDIATE`, SQLite's own cross-process lock, so one writer at a time). With a
 *   row whose holder is dead (its pid gone, or running with another start time), judged outside the transaction, the
 *   row is replaced only if it is still that row (its token): compare and swap, so of two contenders on one dead holder
 *   exactly one takes it. A live holder is never taken over, however long it holds; the waiter's bound only ends its
 *   own attempt.
 * - Release: deletes the row by our token, so a late release after a takeover removes nothing of the new holder's.
 */

/** The lock's file, in the repository's common git dir. */
export const REPO_LOCK_FILE = 'hive-merge.lock'

// i18n-ignore: SQL, not text
const SCHEMA = `CREATE TABLE IF NOT EXISTS repo_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  process_start INTEGER NOT NULL,
  profile TEXT NOT NULL,
  taken_at TEXT NOT NULL
) STRICT`

/** SQLite's own wait for its file lock: a transaction on the lock lasts well under a millisecond. */
const BUSY_MS = 1000
/** How often a waiter judges a live holder's identity again (a start time is a PowerShell query, about half a second). */
const RECHECK_MS = 2000

/** Who holds a repository's lock. `processStart` 0: not known (its liveness is its pid's alone). */
export interface RepoLockHolder {
  token: string
  pid: number
  processStart: number
  profile: string
  takenAt: string
}

/** How a holder's process is looked at: a seam for tests. */
export interface LockProcesses {
  /** Whether a process with this pid runs. */
  alive: (pid: number) => boolean
  /** When the process with this pid started (Unix ms), or null when it can't be told. */
  startOf: (pid: number) => Promise<number | null>
}

export interface TakeOptions {
  /** This Hive's profile (its folder's name), shown to a Hive that waits. */
  profile: string
  /** How long to wait for a live holder before giving up (the lock stays the holder's). */
  waitMs: number
  /** How often to look again while waiting. */
  pollMs?: number
  /** How often a holder judged live has its identity (pid and start time) judged again while waiting. */
  recheckMs?: number
  /** Told once, after `noticeAfterMs` of waiting, who holds the lock. */
  onWait?: (holder: RepoLockHolder) => void
  noticeAfterMs?: number
  procs?: LockProcesses
  /** Told of a step on the lock's file (synchronous, on the caller's thread) that took SLOW_STEP_MS or more (#1633). */
  onSlow?: (step: string, ms: number) => void
  /** The lock's file name in the folder (default REPO_LOCK_FILE): another lock by the same rules (HI-2462: the folder move's). */
  file?: string
}

/** A step on the lock's file this slow is told (`onSlow`): its busy wait or its fsyncs held the caller's thread up. */
export const SLOW_STEP_MS = 100

function timed<T>(step: string, onSlow: TakeOptions['onSlow'], fn: () => T): T {
  const t = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - t
    if (onSlow && ms >= SLOW_STEP_MS) onSlow(step, ms)
  }
}

/** A held lock: release it once (later calls do nothing). */
export interface HeldRepoLock {
  token: string
  release: () => void
}

export type TakeResult = { held: HeldRepoLock } | { timedOut: RepoLockHolder }

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** A process's start time from Windows (the same source and rounding for every Hive, so they compare equal). */
function windowsStartOf(pid: number): Promise<number | null> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`
  return new Promise((res) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      const n = Number(String(out).trim())
      res(!err && Number.isFinite(n) && n > 0 ? n : null)
    })
  })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const SYSTEM_PROCESSES: LockProcesses = { alive: pidAlive, startOf: windowsStartOf }

let ownStart: Promise<number> | null = null
/** This process's start time as the others will read it (0 when it can't be told), asked once. */
function ownStartOf(procs: LockProcesses): Promise<number> {
  if (procs !== SYSTEM_PROCESSES) return procs.startOf(process.pid).then((s) => s ?? 0)
  ownStart ??= windowsStartOf(process.pid).then((s) => s ?? 0)
  return ownStart
}

/** Tokens this process holds now: a row of ours with another token is a leftover of this process (a failed release). */
const heldHere = new Set<string>()

type Row = { token: string; pid: number; process_start: number; profile: string; taken_at: string }
const holderOf = (r: Row): RepoLockHolder => ({ token: r.token, pid: r.pid, processStart: r.process_start, profile: r.profile, takenAt: r.taken_at })
// i18n-ignore: SQL, not text
const readRow = (db: DatabaseSync): Row | undefined => db.prepare('SELECT token, pid, process_start, profile, taken_at FROM repo_lock WHERE id = 1').get() as Row | undefined

/** Whether a row's holder is gone: its pid isn't running, or runs with another start time (a reused pid). */
async function holderDead(r: Row, own: number, procs: LockProcesses): Promise<boolean> {
  if (r.pid === process.pid && r.process_start === own) return !heldHere.has(r.token)
  if (!procs.alive(r.pid)) return true
  if (!r.process_start) return false
  const start = await procs.startOf(r.pid)
  // Can't tell: a live holder is never taken over.
  return start !== null && start !== r.process_start
}

/**
 * Takes the lock in `commonDir` (the repository's common git dir), waiting up to `waitMs` for a live holder. The caller
 * serializes its own takes within the process (repoLock.ts), so this process never waits on itself.
 */
export async function takeRepoLock(commonDir: string, opts: TakeOptions): Promise<TakeResult> {
  const procs = opts.procs ?? SYSTEM_PROCESSES
  const own = await ownStartOf(procs)
  const slow = opts.onSlow
  const db = timed('open', slow, () => openLockDb(join(commonDir, opts.file ?? REPO_LOCK_FILE), BUSY_MS, SCHEMA))
  const started = Date.now()
  let told = false
  // Holders judged live, by token, and when: looked at by pid alone between full checks, and judged again whole (its
  // start time too) every recheckMs, so a pid that ends and is reused while this one waits is seen as the dead holder's.
  const live = new Map<string, number>()
  const recheckMs = opts.recheckMs ?? RECHECK_MS
  let kept = false
  try {
    for (;;) {
      const seen = timed('read', slow, () => readRow(db))
      let dead = false
      if (seen) {
        const at = live.get(seen.token)
        if (at !== undefined && Date.now() - at < recheckMs) dead = !procs.alive(seen.pid)
        else {
          dead = await holderDead(seen, own, procs)
          if (!dead) live.set(seen.token, Date.now())
        }
      }
      if (!seen || dead) {
        const token = randomUUID()
        timed('begin', slow, () => db.exec('BEGIN IMMEDIATE'))
        let took = false
        try {
          const now = readRow(db)
          // Still the row judged (or still none): anything else is another contender's, looked at again.
          if ((!now && !seen) || (now && seen && now.token === seen.token)) {
            // i18n-ignore: SQL, not text
            db.prepare('INSERT OR REPLACE INTO repo_lock (id, token, pid, process_start, profile, taken_at) VALUES (1, ?, ?, ?, ?, ?)').run(token, process.pid, own, opts.profile, new Date().toISOString())
            took = true
          }
          timed('take', slow, () => db.exec('COMMIT'))
        } catch (e) {
          if (db.isTransaction) db.exec('ROLLBACK')
          throw e
        }
        if (took) {
          heldHere.add(token)
          kept = true
          return { held: heldLock(db, token, slow) }
        }
        continue
      }
      const waited = Date.now() - started
      if (!told && opts.onWait && waited >= (opts.noticeAfterMs ?? 0)) {
        told = true
        opts.onWait(holderOf(seen!))
      }
      if (waited >= opts.waitMs) return { timedOut: holderOf(seen!) }
      await new Promise((r) => setTimeout(r, Math.min(opts.pollMs ?? 200, Math.max(1, opts.waitMs - waited))))
    }
  } finally {
    // The held lock keeps its connection for its release.
    if (!kept) db.close()
  }
}

function heldLock(db: DatabaseSync, token: string, slow: TakeOptions['onSlow']): HeldRepoLock {
  let done = false
  return {
    token,
    release: () => {
      if (done) return
      done = true
      heldHere.delete(token)
      try {
        // i18n-ignore: SQL, not text
        timed('release', slow, () => db.prepare('DELETE FROM repo_lock WHERE token = ?').run(token))
      } finally {
        timed('close', slow, () => db.close())
      }
    }
  }
}

/**
 * Releases the lock in `commonDir` by its token, on a connection of its own: for a holder whose own connection is gone
 * (the lock's worker started again while main held it, repoLockWorker.ts). As a release: only that token's row.
 */
export function releaseRepoLock(commonDir: string, token: string, onSlow?: TakeOptions['onSlow'], file = REPO_LOCK_FILE): void {
  heldHere.delete(token)
  const db = timed('open', onSlow, () => openLockDb(join(commonDir, file), BUSY_MS, SCHEMA))
  try {
    // i18n-ignore: SQL, not text
    timed('release', onSlow, () => db.prepare('DELETE FROM repo_lock WHERE token = ?').run(token))
  } finally {
    db.close()
  }
}

/** Who holds the lock in `commonDir` now (a row, alive or not), or null. For tests and diagnostics. */
export function repoLockHolder(commonDir: string, file = REPO_LOCK_FILE): RepoLockHolder | null {
  const db = openLockDb(join(commonDir, file), BUSY_MS, SCHEMA)
  try {
    const r = readRow(db)
    return r ? holderOf(r) : null
  } finally {
    db.close()
  }
}
