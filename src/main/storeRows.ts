import { existsSync } from 'original-fs'
import { resolve } from 'path'
import { boardLock, boardOpen, closeBoard, inBoardWrite, upgradeWaiting, workspaceDb } from './boardStore'
import { transaction } from './db'
import { withFileLock } from './fsutil'
import { keepAsBackup } from './storeBackup'
import { createLogger, userText } from './logger'

const log = createLogger('stores')

/**
 * The workspace's small stores in its database (#1018): sessions and deliveries (lanes, watches and metrics until #1212), each a row per entry in
 * `store_rows` (the board's `.hive/hive.db`, migration 2) with a few values of its own in `store_meta`. A store keeps its
 * entries in memory and its own lock as before; only where they are kept changed. A save is one transaction that writes
 * the rows that changed (no temp file, no rename: #990's EPERM class goes), under the board's lock, so it never runs
 * inside one of the board's transactions on their shared connection. Each store tells its own events, as before.
 *
 * `scope` keeps a store's entries apart where it has more than one set in a workspace (deliveries, a set per session
 * host); '' where it has one.
 */

/** The stores still here: lanes, watches and metrics are in their typed tables (#1212, storeTables.ts). */
export type StoreName = 'deliveries' | 'sessions'

/**
 * A row to save: its key, its JSON document, and its place (`ord`: by default its place in the list; a store whose
 * entries have a place of their own, metrics' buckets by their start, gives it, so an entry leaving the front doesn't
 * move every other row).
 */
export interface StoreRow {
  key: string
  doc: string
  ord?: number
}

/** A store's entries in order, each its key and its JSON document, with its values. */
export interface StoreData {
  rows: { key: string; doc: string }[]
  meta: Map<string, string>
}

/**
 * Row keys for a store's entries, one each and never the same twice (#1018 round 1): an entry's own id where it has one
 * not taken yet, else `#<its place>` (made unique too). An entry's id comes from its file or memory, so it can be
 * anything, a `#1` or another's id included: nothing an entry says can make two share a key.
 */
export function rowKeys(entries: readonly unknown[]): string[] {
  const used = new Set<string>()
  return entries.map((e, i) => {
    const id = e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' ? (e as { id: string }).id : ''
    let key = id && !used.has(id) ? id : `#${i}`
    while (used.has(key)) key += '#'
    used.add(key)
    return key
  })
}

/** Rows for a store's entries: each its key (rowKeys) and its JSON. */
export const rowsOf = (entries: readonly unknown[]): { key: string; doc: string }[] => {
  const keys = rowKeys(entries)
  return entries.map((e, i) => ({ key: keys[i], doc: JSON.stringify(e) }))
}

/** A mistake in Hive's code: two rows of a change with one key (the second would replace the first). */
function assertUnique(store: StoreName, rows: readonly { key: string }[]): void {
  if (new Set(rows.map((r) => r.key)).size !== rows.length) throw new Error(`Two of the ${store} have the same key: nothing was saved`) // i18n-ignore: a mistake in Hive's code, logged
}

/** For tests: a save that fails as it is written (a full disk); a save held before it takes the lock (to race it); a read that fails. */
export const storeTestHooks: { failSave: ((store: StoreName, scope: string) => boolean) | null; beforeSave: ((store: StoreName, scope: string) => Promise<void>) | null; failRead: ((store: StoreName) => boolean) | null } = { failSave: null, beforeSave: null, failRead: null }

/** A store's entries and values as last committed. */
export function readStore(workspacePath: string, store: StoreName, scope = ''): StoreData {
  if (storeTestHooks.failRead?.(store)) throw new Error(`SQLITE_IOERR: disk I/O error (test, ${store})`) // i18n-ignore: a test's stand-in for SQLite's error
  const db = workspaceDb(resolve(workspacePath)).reader
  const rows = db.prepare('SELECT key, doc FROM store_rows WHERE store = ? AND scope = ? ORDER BY ord, key').all(store, scope) as { key: string; doc: string }[] // i18n-ignore: SQL
  const meta = new Map((db.prepare('SELECT key, value FROM store_meta WHERE store = ? AND scope = ?').all(store, scope) as { key: string; value: string }[]).map((r) => [r.key, r.value])) // i18n-ignore: SQL
  return { rows: rows.map((r) => ({ key: r.key, doc: r.doc })), meta }
}

/**
 * Saves a store's entries (all of them, in order) and the values given (null removes one), in one transaction: rows
 * whose document or place changed are written, rows not given removed. All of it or none. `guard` runs just before
 * the transaction, with nothing awaited between them: a store whose owner went away meanwhile (a closed workspace)
 * throws there, and nothing is written.
 */
export async function saveStore(workspacePath: string, store: StoreName, scope: string, rows: StoreRow[], meta: Record<string, string | null> = {}, guard?: () => void): Promise<void> {
  const path = resolve(workspacePath)
  // Its lock is the board's: inside a board change it would wait for itself.
  if (inBoardWrite(path)) throw new Error(`The ${store} were saved inside a change of the board`) // i18n-ignore: a mistake in Hive's code, never shown
  assertUnique(store, rows)
  await storeTestHooks.beforeSave?.(store, scope)
  await withFileLock(boardLock(path), async () => {
    guard?.()
    // A workspace closed meanwhile (a store's last save as it closes): its database is opened for the save, then closed again.
    const wasOpen = boardOpen(path)
    const db = workspaceDb(path).writer
    try {
      saveRows(db, store, scope, rows, meta)
    } finally {
      if (!wasOpen) closeBoard(path)
    }
  })
}

/**
 * Runs `fn` in one transaction on the workspace database's writer, under the board's lock (#1061): for a store that
 * reads and writes its own rows there (sessions, whose callers change them from what is committed now, with no copy of
 * their own). `fn` runs with nothing awaited: it throws, and nothing is written.
 */
export async function writeStore<T>(workspacePath: string, store: StoreName, scope: string, fn: (db: ReturnType<typeof workspaceDb>['writer']) => T): Promise<T> {
  return withStoreLock(workspacePath, store, scope, async (db) =>
    transaction(db, () => {
      const out = fn(db)
      if (storeTestHooks.failSave?.(store, scope)) throw new Error(`SQLITE_FULL: database or disk is full (test, ${store})`) // i18n-ignore: a test's stand-in for SQLite's error
      return out
    })
  )
}

/**
 * Runs `fn` under the board's lock with the workspace database's writer (#1061), awaiting what it needs (a file written
 * between a read and a write, sessions' export): nothing else writes a store meanwhile. Its transactions are its own.
 */
export async function withStoreLock<T>(workspacePath: string, store: StoreName, scope: string, fn: (db: ReturnType<typeof workspaceDb>['writer']) => Promise<T>): Promise<T> {
  const path = resolve(workspacePath)
  if (inBoardWrite(path)) throw new Error(`The ${store} were saved inside a change of the board`) // i18n-ignore: a mistake in Hive's code, never shown
  await storeTestHooks.beforeSave?.(store, scope)
  return withFileLock(boardLock(path), async () => {
    const wasOpen = boardOpen(path)
    try {
      return await fn(workspaceDb(path).writer)
    } finally {
      if (!wasOpen) closeBoard(path)
    }
  })
}

/** saveStore's transaction. */
function saveRows(db: ReturnType<typeof workspaceDb>['writer'], store: StoreName, scope: string, rows: StoreRow[], meta: Record<string, string | null>): void {
  transaction(db, () => {
    const had = new Map((db.prepare('SELECT key, ord, doc FROM store_rows WHERE store = ? AND scope = ?').all(store, scope) as { key: string; ord: number; doc: string }[]).map((r) => [r.key, r])) // i18n-ignore: SQL
    const put = db.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET ord = excluded.ord, doc = excluded.doc') // i18n-ignore: SQL
    const keys = new Set<string>()
    rows.forEach((r, i) => {
      keys.add(r.key)
      const ord = r.ord ?? i
      const was = had.get(r.key)
      if (!was || was.ord !== ord || was.doc !== r.doc) put.run(store, scope, r.key, ord, r.doc)
    })
    const del = db.prepare('DELETE FROM store_rows WHERE store = ? AND scope = ? AND key = ?') // i18n-ignore: SQL
    for (const k of had.keys()) if (!keys.has(k)) del.run(store, scope, k)
    for (const [k, v] of Object.entries(meta)) setMeta(db, store, scope, k, v)
    if (storeTestHooks.failSave?.(store, scope)) throw new Error(`SQLITE_FULL: database or disk is full (test, ${store})`) // i18n-ignore: a test's stand-in for SQLite's error
  })
}

function setMeta(db: ReturnType<typeof workspaceDb>['writer'], store: StoreName, scope: string, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM store_meta WHERE store = ? AND scope = ? AND key = ?').run(store, scope, key) // i18n-ignore: SQL
  else db.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value').run(store, scope, key, value) // i18n-ignore: SQL
}

export { keepAsBackup }

/**
 * Opens a store, moving its file in the first time (#1018): `readFile` reads the file as the store always has and gives
 * its entries (rowsOf), null only when there is no file; one that can't be read now (held open, no permission) throws, and
 * nothing is marked, so the next open tries again (round 1); a damaged or too-big one it sets aside itself and gives none.
 * They go into the database in one transaction with the mark that they did, checked there (every entry a row, as read),
 * and the file is then renamed `<file>.imported-<time>`, kept as a backup. A
 * file found there after that (a rename refused before, or one an older Hive wrote since) is renamed the same way and
 * not read again: the store's entries are the database's. `whenEmpty` (#1061, sessions): a file found while the store has
 * no entries is moved in as at the first open (one its folder brought from another workspace). Returns the store's entries.
 */
export async function openStore(workspacePath: string, store: StoreName, scope: string, file: string, readFile: () => Promise<{ rows: StoreRow[]; meta?: Record<string, string> } | null>, opts: { whenEmpty?: boolean } = {}): Promise<StoreData> {
  const path = resolve(workspacePath)
  const toMove = (now: StoreData): boolean => !now.meta.has('imported') || (!!opts.whenEmpty && !now.rows.length && existsSync(file))
  const first = toMove(readStore(path, store, scope))
  // The workspace's upgrade to 1.0 waits (#1207): the database takes no writes, so nothing is moved in and the file is left
  // where it is, for the move once it is upgraded. Read meanwhile: what the database has (a 0.9 Hive moved in what it had).
  if (upgradeWaiting(path)) return readStore(path, store, scope)
  if (first) {
    const got = await readFile()
    if (got) assertUnique(store, got.rows)
    // Moved in under the lock, checked again there: a second open meanwhile moved it already.
    await withFileLock(boardLock(path), async () => {
      if (!toMove(readStore(path, store, scope))) return
      const db = workspaceDb(path).writer
      transaction(db, () => {
        const put = db.prepare('INSERT OR REPLACE INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?)') // i18n-ignore: SQL
        got?.rows.forEach((r, i) => put.run(store, scope, r.key, r.ord ?? i, r.doc))
        // Checked before it commits: each entry read is a row, as it was read (and nothing else is there).
        const now = db.prepare('SELECT key, doc FROM store_rows WHERE store = ? AND scope = ? ORDER BY ord, key').all(store, scope) as { key: string; doc: string }[] // i18n-ignore: SQL
        const want = got?.rows ?? []
        const read = new Map(want.map((r) => [r.key, r.doc]))
        if (now.length !== want.length || now.some((r) => read.get(r.key) !== r.doc)) throw new Error(`${now.length} ${store} rows in the database, ${want.length} entries read: nothing was moved in`) // i18n-ignore: an internal check's error, logged
        for (const [k, v] of Object.entries(got?.meta ?? {})) setMeta(db, store, scope, k, v)
        setMeta(db, store, scope, 'imported', JSON.stringify({ at: new Date().toISOString(), rows: got?.rows.length ?? 0, file: got ? file : null }))
      })
      if (got) log.info(`moved ${got.rows.length} ${store} entr${got.rows.length === 1 ? 'y' : 'ies'} from ${userText(file)} into the workspace database`)
    })
  }
  if (existsSync(file)) {
    if (!first) log.warn(`${userText(file)} was found after the ${store} moved into the workspace database (an older Hive's, or a rename refused before): kept as a backup, not read`)
    keepAsBackup(file)
  }
  return readStore(path, store, scope)
}
