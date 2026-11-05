import { existsSync } from 'original-fs'
import { resolve } from 'path'
import { boardLock, boardOpen, dbGenerationAt, inBoardWrite, leaseDb, noteLanesSaved, onDbReplaced, upgradeWaiting, workspaceDb, type DbLease } from './boardStore'
import { countedWrite } from './dbWrites'
import { transaction } from './db'
import { placeKey, withFileLock } from './fsutil'
import { createLogger, userText } from './logger'
import { deleteEntry, entryKeys, insertEntries, insertEntry, keepAside, readEntries, readMeta, rowsOfEntry, setMeta, TABLE_DEFS, type TableStore } from './schema/storeCodec'
import { keepAsBackup } from './storeBackup'

const log = createLogger('stores')

/**
 * Lanes, watches and metrics in combwork.db's typed tables (#1212; the mapping is schema/storeCodec.ts). A store keeps its
 * entries in memory and its own lock as before; a save is one transaction, under the board's lock (never inside one of
 * the board's own transactions on their shared connection), that rewrites only the entries that changed and removes
 * those gone. A store's values (`imported`, metrics' `observed`, watches' `invalid`) are in `board_meta` as
 * `<store>.<key>`.
 *
 * While a workspace's upgrade to 1.0 waits (#1207), its file still has 0.9's `store_rows`: the stores read them from
 * there, and nothing is written (the file is read-only).
 */

export interface TableData {
  docs: unknown[]
  meta: Map<string, string>
}

/** For tests: a save that fails as it is written (a full disk); a save held before it takes the lock (to race it); a read that fails. */
export const tableTestHooks: { failSave: ((store: TableStore) => boolean) | null; beforeSave: ((store: TableStore) => Promise<void>) | null; failRead: ((store: TableStore) => boolean) | null } = { failSave: null, beforeSave: null, failRead: null }

/**
 * Each store's entries as last committed, by row key, as their JSON (#1212): a save compares with them and writes only
 * the entries that changed (metrics: the hour under way). Kept per workspace and database generation, so a database
 * replaced (the upgrade, a restore) is read again before a save; made by the first save (reads, at a store's open, leave
 * it alone: they can be large, and are made once).
 *
 * Bounded (round 1, finding 2): only workspaces whose database is open keep theirs. A closed workspace's last save (its
 * database opened for it and closed again) keeps nothing, those of workspaces closed since go at each save, and at most
 * MAX_COMMITTED stores are kept, the least recently saved going first.
 */
const committed = new Map<string, { path: string; place: string; gen: number; docs: Map<string, string> }>()
export const MAX_COMMITTED = 3 * 8
const cacheKey = (path: string, store: TableStore): string => `${path.toLowerCase()}|${store}`
// Under every spelling of the workspace, by the place each save recorded as it entered (#1456).
onDbReplaced((workspacePath, place) => {
  for (const store of Object.keys(TABLE_DEFS) as TableStore[]) committed.delete(cacheKey(resolve(workspacePath), store))
  for (const [k, v] of [...committed]) if (v.place === place) committed.delete(k)
})

/** Keeps a store's committed entries, as the most recently saved; drops those of closed workspaces and past the bound. */
function remember(path: string, place: string, store: TableStore, gen: number, docs: Map<string, string>): void {
  const key = cacheKey(path, store)
  committed.delete(key)
  for (const [k, v] of committed) if (!boardOpen(v.path)) committed.delete(k)
  committed.set(key, { path, place, gen, docs })
  while (committed.size > MAX_COMMITTED) committed.delete(committed.keys().next().value!)
}

/** For tests: the workspaces whose stores' committed entries are kept now. */
export const committedFor = (): string[] => [...new Set([...committed.values()].map((v) => v.path))]

const hasTable = (db: ReturnType<typeof workspaceDb>['reader'], name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) // i18n-ignore: SQL

/** A store's entries and values as last committed: its tables, or 0.9's `store_rows` while its upgrade waits. */
export function readTable(workspacePath: string, store: TableStore): TableData {
  if (tableTestHooks.failRead?.(store)) throw new Error(`SQLITE_IOERR: disk I/O error (test, ${store})`) // i18n-ignore: a test's stand-in for SQLite's error
  return readTableIn(workspaceDb(resolve(workspacePath)).reader, store)
}

/** readTable on the connection given (a lease's: a look at a workspace no window holds, #1395). */
export function readTableIn(db: ReturnType<typeof workspaceDb>['reader'], store: TableStore): TableData {
  const def = TABLE_DEFS[store]
  if (!hasTable(db, def.main)) return readOld(db, store)
  return { docs: readEntries(db, store).map((e) => e.doc), meta: readMeta(db, store) }
}

/** 0.9's rows for a store (a file waiting for its upgrade to 1.0), read only. */
function readOld(db: ReturnType<typeof workspaceDb>['reader'], store: TableStore): TableData {
  if (!hasTable(db, 'store_rows')) return { docs: [], meta: new Map() }
  const rows = db.prepare("SELECT doc FROM store_rows WHERE store = ? AND scope = '' ORDER BY ord, key").all(store) as { doc: string }[] // i18n-ignore: SQL
  const meta = db.prepare("SELECT key, value FROM store_meta WHERE store = ? AND scope = ''").all(store) as { key: string; value: string }[] // i18n-ignore: SQL
  const docs: unknown[] = []
  for (const r of rows) {
    try {
      docs.push(JSON.parse(r.doc))
    } catch {
      // not JSON: the upgrade keeps it aside
    }
  }
  return { docs, meta: new Map(meta.map((m) => [m.key, m.value])) }
}

/**
 * Saves a store's entries (all of them, in order) and the values given (null removes one), in one transaction: entries
 * whose JSON or place changed are written again, those gone removed. All of it or none. `guard` runs just before the
 * transaction, with nothing awaited between them: a store whose owner went away meanwhile (a closed workspace, a database
 * replaced) throws there, and nothing is written. `also`: writes of the caller's that belong with the save, in its
 * transaction (the Assistant's lane change for undo, #1282).
 */
export async function saveTable(workspacePath: string, store: TableStore, docs: readonly unknown[], meta: Record<string, string | null> = {}, guard?: () => void, also?: (db: ReturnType<typeof workspaceDb>['writer']) => void): Promise<void> {
  const path = resolve(workspacePath)
  // Its lock is the board's: inside a board change it would wait for itself.
  if (inBoardWrite(path)) throw new Error(`The ${store} were saved inside a change of the board`) // i18n-ignore: a mistake in Combwork's code, never shown
  // Under way from here, its wait for the lock included (HI-1368: a close command waits for it).
  await countedWrite(path, () => saveTableLocked(path, store, docs, meta, guard, also))
}

/** saveTable's save, once it is counted. */
async function saveTableLocked(path: string, store: TableStore, docs: readonly unknown[], meta: Record<string, string | null>, guard?: () => void, also?: (db: ReturnType<typeof workspaceDb>['writer']) => void): Promise<void> {
  await tableTestHooks.beforeSave?.(store)
  await withFileLock(boardLock(path), async () => {
    guard?.()
    // A workspace closed meanwhile (a store's last save as it closes): its database is opened for the save, then closed
    // again (#1379: not fenced); a lease, so what it closes is only what it opened (#1383).
    const lease = leaseDb(path)
    try {
      saveEntries(path, store, docs, meta, lease, also)
      // The lanes are part of what the board's revision covers (#1266, boardRevision).
      if (store === 'lanes') noteLanesSaved(path)
    } finally {
      lease.release()
    }
  })
}

/** saveTable's transaction. */
function saveEntries(path: string, store: TableStore, docs: readonly unknown[], meta: Record<string, string | null>, lease: DbLease, also?: (db: ReturnType<typeof workspaceDb>['writer']) => void): void {
  const db = lease.db.writer
  const def = TABLE_DEFS[store]
  // Its workspace's place resolved once, as the save enters: its generation, and what the cache records.
  const place = placeKey(path)
  const gen = dbGenerationAt(place)
  const keys = entryKeys(store, docs)
  const texts = docs.map((d) => JSON.stringify(d))
  let had = committed.get(cacheKey(path, store))
  const next = new Map<string, string>()
  transaction(db, () => {
    // A store others write too (the runtime's lanes, #1291) is compared with what the table has now.
    if (!had || had.gen !== gen || def.shared) had = { path, place, gen, docs: new Map(readEntries(db, store).map((e) => [e.key, JSON.stringify(e.doc)])) }
    const before = had.docs
    // Those no longer in the list go first: a new entry may take what one of them held (an agent's one watch).
    const kept = new Set(keys)
    for (const key of before.keys()) if (!kept.has(key)) deleteByKey(db, store, key)
    // A place is part of a lane's or watch's row: one that moved is written again, as one that changed.
    const placeOf = new Map<string, number>()
    if (store !== 'metrics') readPlaces(db, def.main).forEach((ord, k) => placeOf.set(k, ord))
    const aside: unknown[] = []
    // Entries that changed are taken out first, all of them, then written: one may take what another held before.
    const changed: { doc: unknown; key: string; text: string; i: number }[] = []
    docs.forEach((doc, i) => {
      const key = keys[i]
      // A second bucket of one hour (its key made unique): never written over the first.
      if (store === 'metrics' && key.includes('#')) return void aside.push(doc)
      if (before.get(key) === texts[i] && (store === 'metrics' || placeOf.get(key) === i)) return void next.set(key, texts[i])
      changed.push({ doc, key, text: texts[i], i })
      if (before.has(key)) deleteByKey(db, store, key)
    })
    for (const c of changed) {
      const e = rowsOfEntry(def, JSON.parse(c.text), c.key, c.i)
      db.exec('SAVEPOINT entry')
      try {
        insertEntry(db, def, e)
        db.exec('RELEASE entry')
        next.set(c.key, c.text)
      } catch {
        db.exec('ROLLBACK TO entry')
        db.exec('RELEASE entry')
        aside.push(c.doc)
      }
    }
    // The values first: those kept aside now are added to what the store keeps aside (watches' `invalid`).
    for (const [k, v] of Object.entries(meta)) setMeta(db, store, k, v)
    if (aside.length) {
      log.warn(`${aside.length} ${store} entr${aside.length === 1 ? 'y' : 'ies'} had a key another has: kept aside, not used`)
      keepAside(db, store, aside)
    }
    also?.(db)
    if (tableTestHooks.failSave?.(store)) throw new Error(`SQLITE_FULL: database or disk is full (test, ${store})`) // i18n-ignore: a test's stand-in for SQLite's error
  })
  // A closed workspace's last save keeps nothing (its database is closed again at once).
  if (lease.kept) remember(path, place, store, gen, next)
  else committed.delete(cacheKey(path, store))
}

/** Each lane's or watch's place, by id. */
function readPlaces(db: ReturnType<typeof workspaceDb>['writer'], table: string): Map<string, number> {
  return new Map((db.prepare(`SELECT id, ord FROM ${table}`).all() as { id: string; ord: number }[]).map((r) => [r.id, r.ord])) // i18n-ignore: SQL
}

/** Removes an entry by its row key (a lane's or watch's id; a bucket's `span:start`). */
function deleteByKey(db: ReturnType<typeof workspaceDb>['writer'], store: TableStore, key: string): void {
  const def = TABLE_DEFS[store]
  // Its rows with no foreign key go with it, whether it leaves or is written again (a lane's run).
  def.onRemove?.(db, key)
  if (store !== 'metrics') return deleteEntry(db, def, { id: key })
  const at = key.indexOf(':')
  deleteEntry(db, def, { span: key.slice(0, at), start: Number(key.slice(at + 1)) })
}

/**
 * Opens a store, moving its file from before #1018 in the first time (0.8's lanes.json, watches.json): `readFile` reads
 * the file as the store always has and gives its entries, null only when there is no file; one that can't be read now
 * throws, and nothing is marked, so the next open tries again. They go into the tables in one transaction with the mark
 * that they did (`<store>.imported`), and the file is renamed `<file>.imported-<time>`, kept as a backup. A file found
 * after that (a rename refused before, or one an older Hive wrote since) is renamed the same way, unread. While the
 * upgrade to 1.0 waits, nothing is moved: the store reads what the file has (`store_rows`).
 */
export async function openTable(workspacePath: string, store: TableStore, file: string, readFile: () => Promise<{ docs: unknown[]; meta?: Record<string, string> } | null>): Promise<TableData> {
  const path = resolve(workspacePath)
  if (upgradeWaiting(path)) return readTable(path, store)
  const moved = (): boolean => hasTable(workspaceDb(path).reader, TABLE_DEFS[store].main) && readMeta(workspaceDb(path).reader, store).has('imported')
  const first = !moved()
  if (first) {
    const got = await readFile()
    // Moved in under the lock, checked again there: a second open meanwhile moved it already. Counted as a write (HI-1368).
    await countedWrite(path, () => withFileLock(boardLock(path), async () => {
      if (moved()) return
      const db = workspaceDb(path).writer
      transaction(db, () => {
        // Anything the tables have (none: they were made empty and nothing writes them before the move) goes first.
        const n = insertEntries(db, store, got?.docs ?? [])
        for (const [k, v] of Object.entries(got?.meta ?? {})) setMeta(db, store, k, v)
        setMeta(db, store, 'imported', JSON.stringify({ at: new Date().toISOString(), rows: n, file: got ? file : null }))
      })
      committed.delete(cacheKey(path, store))
      if (got) log.info(`moved ${got.docs.length} ${store} entr${got.docs.length === 1 ? 'y' : 'ies'} from ${userText(file)} into the workspace database`)
    }))
  }
  if (existsSync(file)) {
    if (!first) log.warn(`${userText(file)} was found after the ${store} moved into the workspace database (an older Hive's, or a rename refused before): kept as a backup, not read`)
    keepAsBackup(file)
  }
  return readTable(path, store)
}
