import { closeSync, existsSync, openSync, readSync, statSync } from 'original-fs'
import { parentPort, workerData } from 'worker_threads'
import { DatabaseSync } from 'node:sqlite'

/**
 * The WAL checkpoints' worker (HI-1691): a thread of its own that checkpoints a database's WAL (PASSIVE) on a connection
 * of its own, opened for the checkpoint and closed after it, so the copy into the file and its fsync (100 ms to most of a
 * second on a loaded disk) never hold up Combwork's main process, and with it the keystrokes typed into a pane. When to
 * checkpoint, and the fallback to SQLite's own, stay main's (walCheckpoint.ts). A PASSIVE checkpoint can run on any
 * connection to the file: it never waits for readers or writers, and copies what no reader still needs.
 *
 * Main and the worker share one number (`state`), CLOSING, which main moves on as it closes a database: a checkpoint asked
 * for before a close began since is skipped, its file never opened. One already under way finishes on its own connection
 * (two connections to a file are fine for SQLite); its answer, sent once that connection is closed, is how main knows the
 * file is let go of (walCheckpoint.ts's checkpointsReleased). No Electron here (a worker can't load it): main logs.
 */

export const CLOSING = 0

/**
 * A request: a checkpoint, or (HI-3289) the WAL's first write after a whole checkpoint (`restart`), so its restart and
 * the sync of its new header are this thread's, not those of main's next commit.
 */
export type CheckpointRequest = { id: number; file: string; closing: number; kind?: 'checkpoint' | 'restart' }

/**
 * What the WAL's first write did: written (`busy` false), or skipped because another connection had the write lock; how
 * long it took. `wal` (HI-3362): the WAL file's size and modified time after that write, read while this connection held
 * the write lock again (so no other connection's write is in them), with what the WAL had committed then (HI-3414: walMark);
 * none when another connection took it first.
 */
export interface RestartDone {
  restart: true
  busy: boolean
  ms: number
  wal?: { size: number; mtime: number; mark: WalMark | null }
}

/** What SQLite says of a checkpoint (`busy`: it couldn't finish; `checkpointed` of `log` pages), and how long it took. */
export interface CheckpointDone {
  busy: number
  log: number
  checkpointed: number
  ms: number
}

/** A checkpoint's answer: done, or skipped (null: a close began since it was asked for, or the file is gone). */
export type CheckpointReply = { id: number; ok: true; value: CheckpointDone | RestartDone | null } | { id: number; ok: false; error: string }

/**
 * Tests: a checkpoint of these files throws, as one refused by SQLite or the disk would; `inRestart` runs inside the
 * WAL's first write, its write lock held, `beforeWalStat` once it is committed, before the WAL is read under the write
 * lock again (HI-3362), and `afterRestart` once its connection is closed, before its answer; `markUnreadable` makes
 * walMark's reading of these files fail (HI-3414) (in-process only: a worker's
 * thread has its own copy of this module).
 */
export const checkpointHooks = { markUnreadable: null as ((file: string) => boolean) | null, fail: null as ((file: string) => boolean) | null, inRestart: null as ((file: string) => void) | null, afterRestart: null as ((file: string) => void) | null, beforeWalStat: null as ((file: string) => void) | null }

/** Checkpoints `m.file`'s WAL on a connection of its own; `state` is shared with main (null: run on main, in tests). */
export function runCheckpoint(m: CheckpointRequest, state: Int32Array | null): CheckpointDone | null {
  if (state && Atomics.load(state, CLOSING) !== m.closing) return null
  // Never one made: a database moved or removed since stays so.
  if (!existsSync(m.file)) return null
  if (checkpointHooks.fail?.(m.file)) throw new Error('database table is locked (test)') // i18n-ignore: a test's stand-in for SQLite's error
  const db = new DatabaseSync(m.file, { timeout: 0 })
  try {
    const t = performance.now()
    const res = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy: number; log: number; checkpointed: number } // i18n-ignore: SQL
    return { busy: res.busy, log: res.log, checkpointed: res.checkpointed, ms: performance.now() - t }
  } finally {
    db.close()
  }
}

/**
 * The WAL's first write after a whole checkpoint (HI-3289), on a connection of its own: SQLite starts the WAL again from
 * its beginning at the first write after a whole checkpoint and syncs its new header there, even at `synchronous=NORMAL`
 * (`walFrames`: an out-of-order write after a restart could otherwise corrupt the file), so whichever connection writes
 * first pays that sync, on its thread. Made here, it is this thread's: `user_version` written back as it is (a page of
 * the file's header written, nothing in it changed), in a transaction that never waits for the write lock (another
 * connection holding it, it is skipped: `busy`, and that connection's commit restarts the WAL itself).
 */
export function runRestart(m: CheckpointRequest, state: Int32Array | null): RestartDone | null {
  if (state && Atomics.load(state, CLOSING) !== m.closing) return null
  if (!existsSync(m.file)) return null
  const db = new DatabaseSync(m.file, { timeout: 0 })
  try {
    // As the file's own writers have it: the header's sync alone, no sync at the commit, and never a checkpoint in it.
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA wal_autocheckpoint = 0')
    const t = performance.now()
    let seen = 0
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch (e) {
      if (/locked|busy/i.test(e instanceof Error ? e.message : '')) return { restart: true, busy: true, ms: performance.now() - t }
      throw e
    }
    // HI-3362 (HR3's round 1): the WAL's salts as this transaction begins, its write lock held.
    const salts = walSalts(m.file)
    try {
      checkpointHooks.inRestart?.(m.file)
      const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version // i18n-ignore: SQL
      db.exec(`PRAGMA user_version = ${Number(v) | 0}`)
      // HI-3362: another connection's commit from here on moves this connection's data_version (its own doesn't).
      seen = dataVersion(db)
      db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw e
    }
    const ms = performance.now() - t
    const wal = walAfter(db, m.file, seen, salts)
    db.close()
    checkpointHooks.afterRestart?.(m.file)
    return { restart: true, busy: false, ms, ...(wal ? { wal } : {}) }
  } finally {
    if (db.isOpen) db.close()
  }
}

const dataVersion = (db: DatabaseSync): number => (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version // i18n-ignore: SQL

/**
 * The WAL's salts (its header's bytes 16-23), as hex: SQLite writes new ones (the first incremented, the second random)
 * each time a write starts the WAL again from its beginning. Not its checkpoint sequence (bytes 12-15): that one is the
 * writing connection's own count, so a new connection's first restart always writes 1. Null when they can't be read.
 */
function walSalts(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(`${file}-wal`, 'r')
    const b = Buffer.alloc(8)
    return readSync(fd, b, 0, 8, 16) === 8 ? b.toString('hex') : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** A WAL file's magic numbers (its header's first 4 bytes, big-endian): the last bit says its checksums are big-endian. */
const WAL_MAGIC = [0x377f0682, 0x377f0683]
/** A frame's header, before its page. */
const FRAME_HEADER = 24
/**
 * walMark reads at most this much of whole frames a call (the size trigger's bound: 8 MB, about 6 ms on main's thread,
 * once, after a burst of writes; a tick with nothing new reads one frame's header): past it, the reading says so (`more`)
 * and goes on from there at the next.
 */
const MARK_BYTES = 8 * 1024 * 1024
/** Whole frames read in one go, at most this much (a read for many frames, not two a frame). */
const MARK_CHUNK_BYTES = 256 * 1024
/** At most this many uncommitted frames are remembered past the committed end: past it, the reading says so (`more`). */
const MARK_TAIL = 512

/**
 * HI-3414: what a WAL has committed, read from the WAL file as SQLite's own recovery reads it (sqlite.org/walformat.html):
 * from its header on, frames whose salts are the header's and whose checksum chain holds; its committed content ends at
 * the last commit frame among them (a commit size in its header). A commit moves it (a commit frame further on, or the WAL
 * started again with new salts); a checkpoint (it writes the database, not the WAL), frames spilled or rolled back (no
 * commit frame), and a torn frame (its checksum fails) never do, nor do frames written over in place with the same count.
 * So it says whether anything was written where the file's size and time can't: Windows stamps that time from its clock
 * tick (about 15.6 ms by default), and a write after a restart goes over old frames without growing the file. The WAL is
 * written and read with ordinary file I/O, as every connection and process reads it (unlike the `-shm`, SQLite's mapped
 * memory, which an ordinary read isn't sure to see as it stands).
 */
export interface WalMark {
  /** The header's salts (hex). */
  salts: string
  /** Frames committed: up to and with the last valid commit frame. */
  end: number
  /** The checksum chain at `end` (the header's own at 0). */
  sum: [number, number]
  /** The headers (hex, 24 bytes each) of the valid frames past `end` with no commit after them yet: checked, and while
   * their headers stay the same (the chain's checksum is in each), not read whole again. */
  tail: string
  /** The reading stopped short (its bound per call, or a long uncommitted tail): taken as written. */
  more: boolean
}

/** Two marks for the same committed content (the WAL's salts, committed frames and chain). */
export const sameCommits = (a: WalMark | null, b: WalMark | null): boolean => a !== null && b !== null && !a.more && !b.more && a.salts === b.salts && a.end === b.end && a.sum[0] === b.sum[0] && a.sum[1] === b.sum[1]

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/** SQLite's WAL checksum (walChecksumBytes) over `b[from, to)`, on from `sum`, its words in the WAL's byte order. */
function walChecksum(b: Buffer, from: number, to: number, big: boolean, sum: [number, number]): [number, number] {
  let [s1, s2] = sum
  // Little-endian words on a little-endian machine (x64, arm64): read as they lie, many times faster.
  if (!big && LITTLE_ENDIAN && (b.byteOffset + from) % 4 === 0) {
    const w = new Uint32Array(b.buffer, b.byteOffset + from, (to - from) / 4)
    for (let i = 0; i < w.length; i += 2) {
      s1 = (s1 + w[i] + s2) >>> 0
      s2 = (s2 + w[i + 1] + s1) >>> 0
    }
    return [s1, s2]
  }
  for (let i = from; i < to; i += 8) {
    s1 = (s1 + (big ? b.readUInt32BE(i) : b.readUInt32LE(i)) + s2) >>> 0
    s2 = (s2 + (big ? b.readUInt32BE(i + 4) : b.readUInt32LE(i + 4)) + s1) >>> 0
  }
  return [s1, s2]
}

/**
 * The WAL's committed content now (WalMark), read on from `last` when its salts are the same: frames past its end only,
 * and those of its tail by their headers while unchanged. Null when the WAL can't be read, isn't one, or its header's
 * checksum fails (being written).
 */
export function walMark(file: string, last: WalMark | null = null): WalMark | null {
  if (checkpointHooks.markUnreadable?.(file)) return null
  let fd: number | null = null
  try {
    fd = openSync(`${file}-wal`, 'r')
    const head = Buffer.alloc(32)
    if (readSync(fd, head, 0, 32, 0) !== 32) return null
    const magic = head.readUInt32BE(0)
    if (!WAL_MAGIC.includes(magic)) return null
    const big = (magic & 1) === 1
    const raw = head.readUInt32BE(8)
    const page = raw === 1 ? 65536 : raw
    if (page < 512 || page > 65536 || (page & (page - 1)) !== 0) return null
    const headSum = walChecksum(head, 0, 24, big, [0, 0])
    if (headSum[0] !== head.readUInt32BE(24) || headSum[1] !== head.readUInt32BE(28)) return null
    const salts = head.toString('hex', 16, 24)
    const same = last !== null && last.salts === salts
    const from = same ? last.end : 0
    let end = from
    let sum: [number, number] = same ? [last.sum[0], last.sum[1]] : headSum
    const known = same ? last.tail : ''
    const frameBytes = page + FRAME_HEADER
    const at = (i: number): number => 32 + i * frameBytes
    let chain = sum
    let tail = ''
    let i = from
    // The tail checked before, by its headers alone while they're unchanged (each holds its chain's checksum): valid,
    // uncommitted frames. Up to the first that isn't, so `end` is still `from` here.
    const hdr = Buffer.alloc(FRAME_HEADER)
    for (let k = 0; k < known.length; k += 2 * FRAME_HEADER, i++) {
      if (readSync(fd, hdr, 0, FRAME_HEADER, at(i)) !== FRAME_HEADER) break
      const hex = hdr.toString('hex')
      if (known.slice(k, k + 2 * FRAME_HEADER) !== hex) break
      chain = [hdr.readUInt32BE(16), hdr.readUInt32BE(20)]
      tail += hex
    }
    // From there, whole frames, a chunk at a time, until one isn't valid, the file ends or the bound is reached. The next
    // frame's header first: nothing new (the file ends, or a frame of an older WAL) is the usual tick, one small read.
    let more = false
    const next0 = readSync(fd, hdr, 0, FRAME_HEADER, at(i)) === FRAME_HEADER && hdr.toString('hex', 8, 16) === salts
    if (!next0) return { salts, end, sum, tail, more }
    const budget = Math.max(1, Math.floor(MARK_BYTES / frameBytes))
    const chunkFrames = Math.max(1, Math.min(budget, Math.floor(MARK_CHUNK_BYTES / frameBytes)))
    const chunk = Buffer.alloc(chunkFrames * frameBytes)
    let read = 0
    scan: for (;;) {
      if (read >= budget) {
        more = true
        break
      }
      const want = Math.min(chunkFrames, budget - read)
      const n = Math.floor(readSync(fd, chunk, 0, want * frameBytes, at(i)) / frameBytes)
      if (n === 0) break
      for (let j = 0; j < n; j++, i++) {
        const o = j * frameBytes
        const frame = chunk.subarray(o, o + frameBytes)
        if (frame.toString('hex', 8, 16) !== salts || frame.readUInt32BE(0) === 0) break scan
        const next = walChecksum(frame, FRAME_HEADER, frameBytes, big, walChecksum(frame, 0, 8, big, chain))
        if (next[0] !== frame.readUInt32BE(16) || next[1] !== frame.readUInt32BE(20)) break scan
        chain = next
        if (frame.readUInt32BE(4) !== 0) {
          end = i + 1
          sum = next
          tail = ''
        } else tail += frame.toString('hex', 0, FRAME_HEADER)
        if (tail.length > MARK_TAIL * 2 * FRAME_HEADER) {
          more = true
          break scan
        }
      }
      read += n
      if (n < want) break
    }
    return { salts, end, sum, tail, more }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * HI-3362: the WAL file's size and modified time after this connection's commit, when it holds that commit alone. Read
 * under the write lock (a transaction begun and rolled back, writing nothing), so no other connection writes while it is
 * read, and only when:
 * - this connection's data_version is still `seen`, the one read before its commit: no other connection committed since;
 * - and the WAL's salts changed from `salts`, those read as its transaction began (HR3's round 1): this commit started
 *   the WAL again, which SQLite does only when everything in it was checkpointed. A commit of another connection's since
 *   the checkpoint would have started it again itself, or (a reader holding it back) left frames no checkpoint had
 *   copied, and this one couldn't have; either way the salts wouldn't have changed here.
 * Null otherwise (main sees what is in the WAL as a change, as before), or when the file can't be read.
 */
function walAfter(db: DatabaseSync, file: string, seen: number, salts: string | null): RestartDone['wal'] | null {
  checkpointHooks.beforeWalStat?.(file)
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch {
    return null
  }
  try {
    if (dataVersion(db) !== seen || salts === null || walSalts(file) === salts) return null
    const s = statSync(`${file}-wal`)
    return { size: s.size, mtime: s.mtimeMs, mark: walMark(file) }
  } catch {
    return null
  } finally {
    db.exec('ROLLBACK')
  }
}

const port = parentPort
if (port) {
  const state = new Int32Array(workerData as SharedArrayBuffer)
  port.on('message', (m: CheckpointRequest) => {
    try {
      port.postMessage({ id: m.id, ok: true, value: m.kind === 'restart' ? runRestart(m, state) : runCheckpoint(m, state) } satisfies CheckpointReply)
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies CheckpointReply)
    }
  })
}
