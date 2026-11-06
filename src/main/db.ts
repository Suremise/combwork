import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'original-fs'
import { basename, dirname, join } from 'path'
import { timedStep } from './stallWork'

/**
 * Combwork's SQLite layer (#990, #1017): every database Combwork keeps (the workspace's board in `.combwork/combwork.db`; later its metrics,
 * and the Assistant's journal in a file of its own, #989) is opened, set up and migrated here, with Node's built-in
 * `node:sqlite` (no native module to rebuild for each Electron). Nothing else imports `node:sqlite`, so another library
 * would be a change to this file only. Its calls are synchronous: at these sizes a query or a commit takes well under a
 * millisecond on main's thread, once the WAL's checkpoints, which fsync the file, are out of the commits (`checkpointer`, #1633). The usage history (`.combwork/usage.db`, #1106) is opened here too, by the usage worker on a
 * thread of its own (usageWorker.ts): nothing here is tied to main's thread.
 */

/**
 * One step of a database's schema: run once, in its own transaction, in order of `version`. Steps of a `group` (the 1.0
 * upgrade, #1207) run as one: asked first (`OpenOptions.approve`), with the file locked to this connection, after a copy
 * kept for good, all of the group's pending steps in one transaction.
 */
export interface Migration {
  version: number
  name: string
  group?: string
  up: (db: DatabaseSync) => void
}

/** A group of steps a file still needs: from its version now to the group's last. */
export interface PendingGroup {
  group: string
  from: number
  to: number
}

/** Another connection (another Combwork) has the file open, so a group's exclusive lock couldn't be had: nothing changed. */
export class DbInUseError extends Error {
  constructor(file: string) {
    super(`${basename(file)} is open in another process`) // i18n-ignore: the board turns it into its message; this is for the log
    this.name = 'DbInUseError'
  }
}

export interface OpenOptions {
  /** The schema's steps, in order. */
  migrations: Migration[]
  /** This Combwork's version, recorded with each step it runs. */
  appVersion: string
  /** Where a copy of the file is kept before a step runs on one that has data (the last 3 are kept). */
  backupDir?: string
  /** The name its copies start with there (default: the file's name without `.db`), so databases sharing a folder keep their own three. */
  backupFamily?: string
  /**
   * Runs on each connection once it is set up, before any step: SQL functions the schema's triggers call (both
   * connections), and settings only a new file can take (`isNew`: no schema yet, e.g. `auto_vacuum`).
   */
  setup?: (db: DatabaseSync, isNew: boolean) => void
  /**
   * Whether a group's steps may run on a file that has data (a new file takes every step unasked, and a file in the group
   * already its later steps: HI-1718). Refused, the steps before the group run, and the file opens read-only with
   * `pending` saying what it waits for. Left out: they run.
   */
  approve?: (pending: PendingGroup) => boolean
  /** Runs with a group's exclusive lock held, before its copy and steps: throwing refuses the group, changing nothing. */
  beforeGroup?: (pending: PendingGroup) => void
  /** For tests: runs once a group's steps are committed, its lock still held (another process trying to open the file meanwhile). */
  whileGroupLocked?: () => void
  /**
   * Takes the WAL's checkpoints out of the writer's commits (#1633, walCheckpoint.ts: checkpointed when it is idle):
   * called once the file is open and writable, with its writer; returns what stops it, called first when it closes.
   */
  checkpointer?: (file: string, writer: DatabaseSync) => () => void
  /**
   * Told once the steps that ran as the file opened are committed (HI-1694): each one's time, and the copy's made before
   * them (null: none), so a slow upgrade says which step took it.
   */
  onSteps?: (steps: { version: number; name: string; ms: number }[], copyMs: number | null) => void
  /** Told of each open tried again after an I/O error (OPEN_IO_RETRY_MS, HI-2179): the error, and the wait before the next. */
  onIoRetry?: (error: Error, waitMs: number) => void
}

/**
 * The waits before an open that failed with an I/O error is tried again (HI-2179): just after a Combwork ended without
 * quitting, the next start's opens of the workspace's files failed so once, and the workspace didn't reopen. SQLite
 * tries a Windows sharing violation again itself (about 1.4 s), not this. Bounded: a disk that keeps failing still fails.
 */
export const OPEN_IO_RETRY_MS = [50, 100, 200, 400, 800]

/** SQLite's I/O errors (SQLITE_IOERR, 10, and its extended codes): `errcode` on node:sqlite's errors. */
export const isIoError = (e: unknown): boolean => ((e as { errcode?: unknown } | null)?.errcode as number) % 256 === 10

/** How long a file left by a Combwork that ended without quitting is waited for, before it is opened anyway (HI-2199). */
export const OPENABLE_WAIT_MS = 20_000
const OPENABLE_POLL_MS = 100

/**
 * The I/O error an open of `file` would fail with now because its `-shm` is still mapped elsewhere (untilOpenable), or
 * null: no `-shm`, it opens, or any other error (left for the open to report). One read-only probe, which changes
 * nothing in the files.
 */
function refusal(file: string): Error | null {
  if (!existsSync(`${file}-shm`)) return null
  try {
    // A busy file isn't waited for here (the open's own busy wait has it).
    const probe = new DatabaseSync(file, { readOnly: true, timeout: 100 })
    try {
      probe.prepare('SELECT count(*) FROM sqlite_master').get()
    } finally {
      probe.close()
    }
    return null
  } catch (e) {
    return isIoError(e) ? (e as Error) : null
  }
}

/** Whether `file` can be opened now, as untilOpenable would find at its first try (HI-2200: a read that never waits). */
export const openableNow = (file: string): boolean => refusal(file) === null

/**
 * Waits, without holding main's thread, until a WAL database left as a Combwork that ended without quitting left it can be opened
 * (HI-2199): its `-shm` still there, and another process still mapping it. The first connection to such a file truncates
 * the `-shm` (SQLite 3.53's winLockSharedMemory), which Windows refuses while any process has it mapped, so every open
 * fails with SQLITE_IOERR_TRUNCATE (1546) until that process lets go: seen for 10 s after an e2e kill, longer than
 * openDb's synchronous retries. Tried with a read-only connection of its own, which changes nothing in the files: done
 * at once when there is no `-shm` (a clean close removes it) or another connection has the file (it isn't truncated
 * then). Stops at the first other error, or at `boundMs`, leaving the open to say what is wrong, and at once when `signal`
 * aborts (whoever waited has gone: the file isn't tried again for it). `onWait` is told once, as it starts waiting.
 * Returns how long it waited.
 */
export async function untilOpenable(file: string, o: { onWait?: (error: Error) => void; boundMs?: number; signal?: AbortSignal } = {}): Promise<number> {
  const { onWait, boundMs = OPENABLE_WAIT_MS, signal } = o
  if (!existsSync(`${file}-shm`)) return 0
  const started = performance.now()
  for (let told = false; ; told = true) {
    if (signal?.aborted) return performance.now() - started
    const e = refusal(file)
    if (!e) return performance.now() - started
    const waited = performance.now() - started
    if (waited >= boundMs) return waited
    if (!told) onWait?.(e)
    await new Promise<void>((r) => {
      const done = (): void => {
        clearTimeout(t)
        signal?.removeEventListener('abort', done)
        r()
      }
      const t = setTimeout(done, OPENABLE_POLL_MS)
      signal?.addEventListener('abort', done, { once: true })
    })
  }
}

/** An open database: a writer and a reader connection to one file. */
export interface Db {
  file: string
  /** The connection every write goes through (one at a time: the caller's lock). */
  writer: DatabaseSync
  /** The connection queries use: it sees what was last committed, never a write still under way. */
  reader: DatabaseSync
  /** The schema version of a file saved by a newer Combwork (opened read-only), else null. */
  newer: number | null
  /** A group of steps this file waits for, not approved (opened read-only), else null. */
  pending: PendingGroup | null
  close: () => void
}

/**
 * The settings every connection gets: WAL (readers never wait for the writer), `synchronous=NORMAL` (a crash of Combwork loses
 * nothing committed; a power cut may lose the last commit or two, never the file), a wait for a lock held by another
 * process, and caches sized for a board of a few thousand cards.
 */
/** How many statements a connection keeps (keepStatements): the oldest goes first once there are more. */
const KEPT_STATEMENTS = 400

/**
 * A connection keeps its statements (HI-1797): the board's reads prepared each again on every call, about 5 ms of main
 * a check's resolve. A statement is the same SQL's until the connection closes (SQLite prepares it again itself when
 * the schema changes); none here is iterated or given its own settings, so one statement serves each call in turn.
 */
function keepStatements(db: DatabaseSync): void {
  const kept = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    let s = kept.get(sql)
    if (s) {
      // Newest last, so the oldest is the first to go.
      kept.delete(sql)
      kept.set(sql, s)
      return s
    }
    s = prepare(sql)
    kept.set(sql, s)
    if (kept.size > KEPT_STATEMENTS) kept.delete(kept.keys().next().value!)
    return s
  }) as DatabaseSync['prepare']
}

function configure(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA cache_size = -8192')
  db.exec('PRAGMA mmap_size = 67108864')
  db.exec('PRAGMA temp_store = MEMORY')
  db.exec('PRAGMA journal_size_limit = 67108864')
}

/** The newest schema version a file has (0: a new file). */
export function schemaVersion(db: DatabaseSync): number {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get()
  if (!has) return 0
  const row = db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number | null } | undefined
  return row?.v ?? 0
}

/** Whether a file has anything in it worth a copy before its schema changes. */
function hasData(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_version' LIMIT 1").get()
}

/** How many copies of a database `backupTo` keeps. */
export const BACKUPS_KEPT = 3

/** A copy's name, `<family>-v<version>-<ISO time with : and . as ->.db`: sorted by its time, whatever the version. */
const backupName = (family: string, version: number, at: Date): string => `${family}-v${version}-${at.toISOString().replace(/[:.]/g, '-')}.db`
/** What follows `<family>-v` in a copy's name: its version and time. */
const BACKUP_REST = /^\d+-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.db$/

/** The family a group's copy is kept under (`combwork-before-1.0`): never pruned, and apart from the file's own three. */
export const groupBackupFamily = (family: string, group: string): string => `${family}-before-${group}`

/** The copies of a family in `dir`, oldest first: only names of the family's exact form, never another's or anything else. */
export function backupsOf(dir: string, family: string): { file: string; version: number; at: string }[] {
  const prefix = `${family}-v`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .map((f) => ({ f, m: f.startsWith(prefix) ? BACKUP_REST.exec(f.slice(prefix.length)) : null }))
    .filter((c): c is { f: string; m: RegExpExecArray } => !!c.m)
    .map((c) => ({ file: join(dir, c.f), version: Number(c.f.slice(prefix.length).split('-')[0]), at: c.m[1] }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.file < b.file ? -1 : 1))
}

/**
 * A copy of the file as it is (VACUUM INTO: consistent, synchronous), keeping the newest three of its family in `dir`
 * (#1039), or every one with `keepAll` (a group's copy, #1207). Only names of the family's exact form count, so another
 * database's copies, or anything else in the folder, are never pruned.
 */
export function backupTo(db: DatabaseSync, dir: string, family: string, version: number, at = new Date(), keepAll = false): string {
  mkdirSync(dir, { recursive: true })
  const name = backupName(family, version, at)
  const file = join(dir, name)
  rmSync(file, { force: true })
  db.prepare('VACUUM INTO ?').run(file)
  if (keepAll) return file
  const kept = backupsOf(dir, family)
  for (const c of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) rmSync(c.file, { force: true })
  return file
}

/** Runs `fn` in a transaction on `db` (BEGIN IMMEDIATE: the write lock at once), committed when it returns, undone when it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  // Marked (HI-1692): a busy wait for the write lock, or a commit held by the disk, names it in a stall's warning.
  return timedStep(`db transaction ${fileNames.get(db) ?? 'a database'}`, () => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw e
    }
  })
}

/** Each connection openDb made, by its file's own name, for the steps marked on it (HI-1692). */
const fileNames = new WeakMap<DatabaseSync, string>()

/** How long a group waits for another connection to let go of the file before it says the file is in use. */
const GROUP_LOCK_WAIT_MS = 1000

/**
 * Runs the steps the file hasn't had, each in its own transaction, after a copy of a file with data in it. A group's
 * steps run as one (runGroup), once approved; refused, the file stays before the group and its pending group is returned.
 */
function migrate(db: DatabaseSync, file: string, opts: OpenOptions): PendingGroup | null {
  const from = schemaVersion(db)
  const todo = opts.migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version)
  if (!todo.length) return null
  // A new file has nothing to upgrade: every step runs, as one at a time, unasked.
  const existing = from > 0 && hasData(db)
  const family = opts.backupFamily ?? basename(file).replace(/\.db$/i, '')
  let copied = false
  transaction(db, () => db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, app_version TEXT NOT NULL) STRICT'))
  const record = db.prepare('INSERT INTO schema_version (version, name, applied_at, app_version) VALUES (?, ?, ?, ?)')
  const timed: { version: number; name: string; ms: number }[] = []
  let copyMs: number | null = null
  const copy = (make: () => void): void => {
    const t = performance.now()
    make()
    copyMs = (copyMs ?? 0) + performance.now() - t
  }
  const run = (m: Migration): void => {
    const t = performance.now()
    m.up(db)
    record.run(m.version, m.name, new Date().toISOString(), opts.appVersion)
    timed.push({ version: m.version, name: m.name, ms: performance.now() - t })
  }
  const told = (): void => {
    if (timed.length) opts.onSteps?.(timed, copyMs)
  }
  for (let i = 0; i < todo.length; ) {
    const group = existing ? todo[i].group : undefined
    if (!group) {
      if (!copied && existing && opts.backupDir) copy(() => backupTo(db, opts.backupDir!, family, schemaVersion(db)))
      copied = true
      transaction(db, () => run(todo[i]))
      i++
      continue
    }
    let end = i
    while (end < todo.length && todo[end].group === group) end++
    const steps = todo.slice(i, end)
    const pending: PendingGroup = { group, from: schemaVersion(db), to: steps[steps.length - 1].version }
    const first = Math.min(...opts.migrations.filter((m) => m.group === group).map((m) => m.version))
    // A file in the group already (asked when it joined, or made in 1.0) takes a later step of it unasked: asked again, a
    // board an earlier 1.0 upgraded would wait as if from 0.9 (HI-1718).
    if (pending.from < first && opts.approve && !opts.approve(pending)) {
      told()
      return pending
    }
    // The copy before the group's first step is kept for good (the way back); one before a later step of it (a file in the
    // group already) is an ordinary copy, of the file's own three.
    runGroup(db, file, opts, pending, pending.from < first ? groupBackupFamily(family, group) : null, family, () => steps.forEach(run), copy)
    // The group's copy is the file before every step after it too.
    copied = true
    i = end
  }
  told()
  return null
}

/**
 * A group's run (#1207, SPEC §16.17): the file locked to this connection for all of it (`locking_mode=EXCLUSIVE`, which
 * SQLite grants only when no other connection has the file open, and while held no other can open it), `beforeGroup`'s
 * check, a copy kept for good, then every step in one transaction (a failure or a crash leaves the file before the group).
 * The lock goes back to NORMAL after, whatever happened. Another connection holding the file: DbInUseError, nothing changed.
 */
function runGroup(db: DatabaseSync, file: string, opts: OpenOptions, pending: PendingGroup, keptFamily: string | null, family: string, steps: () => void, copy: (make: () => void) => void): void {
  db.exec('PRAGMA locking_mode = EXCLUSIVE')
  try {
    db.exec(`PRAGMA busy_timeout = ${GROUP_LOCK_WAIT_MS}`)
    try {
      // The exclusive lock, kept after COMMIT in this locking mode.
      db.exec('BEGIN EXCLUSIVE')
      db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      if (/locked|busy/i.test(e instanceof Error ? e.message : '')) throw new DbInUseError(file)
      throw e
    } finally {
      db.exec('PRAGMA busy_timeout = 5000')
    }
    opts.beforeGroup?.(pending)
    if (opts.backupDir) copy(() => backupTo(db, opts.backupDir!, keptFamily ?? family, pending.from, new Date(), !!keptFamily))
    transaction(db, steps)
    opts.whileGroupLocked?.()
  } finally {
    db.exec('PRAGMA locking_mode = NORMAL')
    // The lock is let go at the file's next use.
    db.prepare('SELECT count(*) FROM sqlite_master').get()
  }
}

/** The schema version of a database file, read on a connection of its own (read-only; a copy, say). */
export function fileSchemaVersion(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true, timeout: GROUP_LOCK_WAIT_MS })
  try {
    return schemaVersion(db)
  } finally {
    db.close()
  }
}

/**
 * A small database used only for a cross-process lock (the repository lock, `repoLockCore.ts`, #1347): one connection,
 * no WAL (nothing stays beside the file between uses), SQLite's busy wait bounded by `busyMs` (a transaction on it
 * lasts well under a millisecond, so contention is brief), and `schema` run once it is open.
 */
export function openLockDb(file: string, busyMs: number, schema: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: busyMs })
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec(schema)
    return db
  } catch (e) {
    db.close()
    throw e
  }
}

/**
 * A copy of a database file kept for good (`keepAll`), made by a connection of its own holding the file's exclusive lock:
 * the proof no other connection has it open (Restore the 0.9 Board Backup, #1207). Closed after, which ends the lock.
 * DbInUseError when another connection has it; the caller's own must be closed first.
 */
export function soleCopy(file: string, dir: string, family: string, version: number): string {
  const db = new DatabaseSync(file, { timeout: GROUP_LOCK_WAIT_MS })
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
    try {
      db.exec('BEGIN EXCLUSIVE')
      db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      if (/locked|busy/i.test(e instanceof Error ? e.message : '')) throw new DbInUseError(file)
      throw e
    }
    return backupTo(db, dir, family, version, new Date(), true)
  } finally {
    db.close()
  }
}

/**
 * Opens (or makes) a database file with its two connections, set up and migrated. A file saved by a newer Combwork (a
 * schema version this build doesn't know) is opened read-only and migrated not at all: `newer` says its version, and
 * every write to it fails. So is one whose group of steps wasn't approved (`pending`). A group refused for another
 * connection on the file throws DbInUseError, the file as it was.
 */
export function openDb(file: string, opts: OpenOptions): Db {
  // Marked (HI-1692): an open runs its migrations, and waits for another connection's lock.
  return timedStep(`db open ${basename(file)}`, () => {
    for (const wait of OPEN_IO_RETRY_MS) {
      try {
        return openDbNow(file, opts)
      } catch (e) {
        if (!isIoError(e)) throw e
        opts.onIoRetry?.(e as Error, wait)
        // Synchronous, as the open is: only on this error, and at most OPEN_IO_RETRY_MS in all.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
      }
    }
    return openDbNow(file, opts)
  })
}

/**
 * `schema_version`'s column of the version that ran each step, named after the old name before 1.1, renamed `app_version` (HI-2587):
 * in its own transaction, once (a file that has it already, or no table yet, needs nothing).
 */
export function renameVersionColumn(db: DatabaseSync): void {
  const cols = (db.prepare("SELECT name FROM pragma_table_info('schema_version')").all() as { name: string }[]).map((c) => c.name) // i18n-ignore: SQL
  // old-name: begin version-column
  if (cols.includes('hive_version') && !cols.includes('app_version')) transaction(db, () => db.exec('ALTER TABLE schema_version RENAME COLUMN hive_version TO app_version'))
  // old-name: end version-column
}

function openDbNow(file: string, opts: OpenOptions): Db {
  mkdirSync(dirname(file), { recursive: true })
  const writer = new DatabaseSync(file, { timeout: 5000 })
  let reader: DatabaseSync | null = null
  try {
    configure(writer)
    opts.setup?.(writer, schemaVersion(writer) === 0)
    const known = Math.max(0, ...opts.migrations.map((m) => m.version))
    const found = schemaVersion(writer)
    const newer = found > known ? found : null
    // The version column's old name (HI-2587, the names upgrade): renamed before anything reads or records a step.
    if (newer === null) renameVersionColumn(writer)
    const pending = newer === null ? migrate(writer, file, opts) : null
    if (newer !== null || pending) writer.exec('PRAGMA query_only = ON')
    reader = new DatabaseSync(file, { timeout: 5000 })
    keepStatements(writer)
    keepStatements(reader)
    fileNames.set(writer, basename(file))
    fileNames.set(reader, basename(file))
    configure(reader)
    opts.setup?.(reader, false)
    reader.exec('PRAGMA query_only = ON')
    const r = reader
    const stopCheckpoints = newer === null && !pending ? opts.checkpointer?.(file, writer) : undefined
    return {
      file,
      writer,
      reader: r,
      newer,
      pending,
      close: () => {
        stopCheckpoints?.()
        // The reader first (#1324): while it has the file mapped, Windows refuses the checkpoint's truncation of a file
        // that shrank (incremental vacuum), silently, and the close after it has nothing left to copy, so the file kept
        // its biggest size for good.
        r.close()
        try {
          if (writer.isTransaction) writer.exec('ROLLBACK')
          if (newer === null && !pending) {
            writer.exec('PRAGMA optimize')
            writer.exec('PRAGMA wal_checkpoint(PASSIVE)')
          }
        } catch {
          // Closing anyway.
        }
        writer.close()
      }
    }
  } catch (e) {
    reader?.close()
    writer.close()
    throw e
  }
}
