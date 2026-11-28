import { existsSync } from 'original-fs'
import { resolve } from 'path'
import { boardLock, inBoardWrite, withLeasedDb, workspaceDb } from './boardStore'
import { beginWrite, countedWrite } from './dbWrites'
import { transaction, type Db } from './db'
import { withFileLock } from './fsutil'
import { keepAsBackup } from './storeBackup'
import { createLogger, userText } from './logger'

const log = createLogger('stores')

/**
 * Sessions' and deliveries' storage plumbing (#1018, #1211). Since 1.0 each has typed tables of its own
 * (schema/sessionDeliveryTables.ts; lanes, watches and metrics theirs: storeTables.ts, #1212), and `store_rows` is gone;
 * their few values stay in `store_meta`, per scope (a session host). Here: the move in of a store's old JSON file
 * (`openTable`), a typed save's lock and transaction (`saveTable`, `writeStore`, `withStoreLock`: under the board's lock,
 * so never inside one of the board's transactions on their shared connection), and the values (`storeValue`). Each store
 * tells its own events, as before.
 *
 * `scope` keeps a store's entries apart where it has more than one set in a workspace (a set per session host).
 */

/** The stores still here: lanes, watches and metrics are in their typed tables (#1212, storeTables.ts). */
export type StoreName = 'deliveries' | 'sessions'

/** For tests: a save that fails as it is written (a full disk); a save held before it takes the lock (to race it). */
export const storeTestHooks: { failSave: ((store: StoreName, scope: string) => boolean) | null; beforeSave: ((store: StoreName, scope: string) => Promise<void>) | null } = { failSave: null, beforeSave: null }

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
  if (inBoardWrite(path)) throw new Error(`The ${store} were saved inside a change of the board`) // i18n-ignore: a mistake in Combwork's code, never shown
  // Under way from here, its wait for the lock included (HI-1368: a close command waits for it).
  const written = beginWrite(path)
  try {
    await storeTestHooks.beforeSave?.(store, scope)
    // Its own lease on the connection (#1383): a workspace closed meanwhile, or opened, neither closes it under `fn` nor
    // is closed by it.
    return await withFileLock(boardLock(path), () => withLeasedDb(path, (db) => fn(db.writer)))
  } finally {
    written()
  }
}

type Writer = ReturnType<typeof workspaceDb>['writer']

/**
 * Saves a store kept in a typed table of its own (#1211: sessions' and deliveries' tables, not `store_rows`), as saveStore
 * does a row store: under the board's lock, `guard` just before, then `write` and the values given (null removes one) in
 * one transaction. All of it or none.
 */
export async function saveTable(workspacePath: string, store: StoreName, scope: string, write: (db: Writer) => void, meta: Record<string, string | null> = {}, guard?: () => void): Promise<void> {
  const path = resolve(workspacePath)
  if (inBoardWrite(path)) throw new Error(`The ${store} were saved inside a change of the board`) // i18n-ignore: a mistake in Combwork's code, never shown
  // Under way from here, its wait for the lock included (HI-1368: a close command waits for it).
  await countedWrite(path, () => saveTableLocked(path, store, scope, write, meta, guard))
}

/** saveTable's save, once it is counted. */
async function saveTableLocked(path: string, store: StoreName, scope: string, write: (db: Writer) => void, meta: Record<string, string | null>, guard?: () => void): Promise<void> {
  await storeTestHooks.beforeSave?.(store, scope)
  await withFileLock(boardLock(path), async () => {
    guard?.()
    await withLeasedDb(path, ({ writer: db }) =>
      transaction(db, () => {
        write(db)
        for (const [k, v] of Object.entries(meta)) setMeta(db, store, scope, k, v)
        if (storeTestHooks.failSave?.(store, scope)) throw new Error(`SQLITE_FULL: database or disk is full (test, ${store})`) // i18n-ignore: a test's stand-in for SQLite's error
      })
    )
  })
}

/** A store's value kept beside its entries (`store_meta`), or null. */
export function storeValue(db: Writer | ReturnType<typeof workspaceDb>['reader'], store: StoreName, scope: string, key: string): string | null {
  const r = db.prepare('SELECT value FROM store_meta WHERE store = ? AND scope = ? AND key = ?').get(store, scope, key) as { value: string } | undefined // i18n-ignore: SQL
  return r?.value ?? null
}

/** A typed table's side of a store's move in (openTable): how many entries a scope has, and the writing of a file's. */
export interface StoreTable<T> {
  count(db: Writer, scope: string): number
  /**
   * In the move's transaction: writes the file's entries (those not of Combwork's form kept aside), keeping any the table has
   * already (by id); returns how many it wrote.
   */
  put(db: Writer, scope: string, got: T): number
}

/**
 * openStore for a store kept in a typed table of its own (#1211): its file moved in the first time (and, `whenEmpty`,
 * when found while the scope has none), in one transaction marked `imported` and checked there (the table has what was
 * written, beside what it had: a save that landed while its file couldn't be moved in, its workspace closed (HI-1713)),
 * the file then kept as a backup; a file found after that kept so, unread. The caller reads the table after. `db`: the connection to use throughout, a save's lease's
 * (#1381), so a workspace closed while the file is read doesn't take it away (else the workspace's, as it is then).
 * `refuse`: the file must stay where it is now (a removed project's, #1161): asked under the board's lock, after the file
 * is read and before anything is written or renamed. Returns false when it refused (nothing moved, nothing renamed).
 */
export async function openTable<T>(workspacePath: string, store: StoreName, scope: string, file: string, readFile: () => Promise<T | null>, table: StoreTable<T>, opts: { whenEmpty?: boolean; db?: Db; refuse?: () => boolean } = {}): Promise<boolean> {
  const path = resolve(workspacePath)
  const conn = (): Db => opts.db ?? workspaceDb(path)
  if (opts.refuse?.()) return false
  const toMove = (db: Writer): boolean => storeValue(db, store, scope, 'imported') === null || (!!opts.whenEmpty && table.count(db, scope) === 0 && existsSync(file))
  const first = toMove(conn().writer)
  if (!first && !existsSync(file)) return true
  const got = first ? await readFile() : null
  // The move and the file's rename under one hold of the lock, the refusal asked last before them: nothing that would
  // refuse it (a removal's export, under the same lock) lands between. Counted as a write (HI-1368).
  return countedWrite(path, () => withFileLock(boardLock(path), async () => {
    if (opts.refuse?.()) return false
    const db = conn().writer
    if (first && toMove(db)) {
      let written = 0
      transaction(db, () => {
        const had = table.count(db, scope)
        written = got ? table.put(db, scope, got) : 0
        const now = table.count(db, scope)
        if (now !== had + written) throw new Error(`${now} ${store} entries in the database, ${had} before and ${written} moved in: nothing was moved in`) // i18n-ignore: an internal check's error, logged
        setMeta(db, store, scope, 'imported', JSON.stringify({ at: new Date().toISOString(), rows: written, file: got ? file : null }))
      })
      if (got) log.info(`moved ${written} ${store} entr${written === 1 ? 'y' : 'ies'} from ${userText(file)} into the workspace database`)
    }
    if (existsSync(file)) {
      if (!first) log.warn(`${userText(file)} was found after the ${store} moved into the workspace database (an older version's, or a rename refused before): kept as a backup, not read`)
      keepAsBackup(file)
    }
    return true
  }))
}

function setMeta(db: ReturnType<typeof workspaceDb>['writer'], store: StoreName, scope: string, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM store_meta WHERE store = ? AND scope = ? AND key = ?').run(store, scope, key) // i18n-ignore: SQL
  else db.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value').run(store, scope, key, value) // i18n-ignore: SQL
}

export { keepAsBackup }
