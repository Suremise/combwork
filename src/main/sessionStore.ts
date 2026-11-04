import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'
import { resolve } from 'path'
import type { SessionsFile } from './workspace'
import { onDbReplaced, upgradeWaiting, withLeasedDb, workspaceDb } from './boardStore'
import { placeKey, readKeptJson, writeKeptJson } from './fsutil'
import { createLogger, userText } from './logger'
import { keepAsBackup, openTable, readStore, rowKeys, storeValue, withStoreLock, writeStore, type StoreData, type StoreRow } from './storeRows'
import { transaction, type Db } from './db'
import { addSessionRecords, countSessions, readAgentSessionRecords, readCardSessionRecords, readDeleted, readDeletedUsage, readSessionRecord, readSessionRecords, removeSessionRecords, sessionTexts, writeSessionRecord, writeSessionRecords } from './schema/sessionDeliveryTables'
import { withMode } from '../shared/defaults'
import { timedStep } from './stallWork'

const log = createLogger('sessions')

/**
 * A session host's records (#1061: a project's, the Assistant's), in its workspace's database rather than its
 * `.combwork/sessions.json`, which was rewritten whole (746 KB on the hive project) at every change of a record. Since 1.0
 * (#1211) in their own tables (schema/sessionDeliveryTables.ts): `sessions` (a record a row, under the host's scope: its project
 * id, `assistant` for the Assistant), the cards each worked on in `session_cards`, the deleted sessions' ids and kept usage
 * in `sessions_deleted` and `sessions_deleted_usage`, each in its order. A change writes only the rows it changed. The
 * file is moved in the first time a host's records are read, then kept as `sessions.json.imported-<time>`; so is one
 * found later while the host has no records (its folder removed from another workspace, exportSessions), else it is kept
 * so unread. Remove from Hive writes them back into the folder, which takes them wherever it goes, and marks them
 * `exported` here: while the project is removed (or being removed) nothing reads that file; once it is back (Restore, or
 * the folder shown again), it is moved in again, with what was recorded here meanwhile. While the workspace's upgrade to
 * 1.0 waits (#1207) its file is 0.9's: the records are read from its `store_rows`, and nothing is written.
 */

const EMPTY = (): SessionsFile => ({ version: 1, sessions: [] })

/** Where a host's records are: its workspace's folder, its scope there, and its old file. */
export interface SessionsPlace {
  workspace: string
  scope: string
  file: string
  /**
   * Removed from Hive (hidden as removed in its workspace): records it took away in its folder stay there (#1061). Asked
   * when a file would be moved in, not when the place was worked out (#1161): a change can wait for its turn meanwhile,
   * and land after its workspace closed. True too when that can't be known now (its workspace no longer open): no file
   * is moved in then.
   */
  removed?: () => boolean
}

type Row = { key: string; doc: string; ord?: number }
type Kind = 's:' | 'd:' | 'u:'
type Kept = NonNullable<SessionsFile['deletedUsage']>[number]

/**
 * The deleted sessions' ids and usage of records given out (#1061): most changes never look at them (the usage is most of
 * a big project's records), so each list is read when first used, and one never used is left as it is.
 */
const lazyLists = new WeakMap<SessionsFile, { deleted: boolean; usage: boolean }>()

/** A record from before 0.9.3 has the Assistant's mode as its persona (#1084). */
const recordOf = (doc: unknown): SessionsFile['sessions'][number] => (doc && typeof doc === 'object' && 'persona' in doc ? withMode(doc as Record<string, unknown>) : doc) as SessionsFile['sessions'][number]

/**
 * A host's records: the records given, and a reader of each deleted list (`deleted`, `deletedUsage`: read when first
 * used, undefined when empty, as in the file).
 */
function filed(sessions: unknown[], deleted: () => string[], usage: () => Kept[]): SessionsFile {
  const f: SessionsFile = EMPTY()
  for (const s of sessions) f.sessions.push(recordOf(s))
  const used = { deleted: false, usage: false }
  lazyLists.set(f, used)
  const lazy = <K extends 'deleted' | 'deletedUsage'>(prop: K, flag: 'deleted' | 'usage', load: () => SessionsFile[K]): void => {
    let value: SessionsFile[K]
    Object.defineProperty(f, prop, {
      enumerable: true,
      configurable: true,
      get: () => {
        if (!used[flag]) {
          value = load()
          used[flag] = true
        }
        return value
      },
      set: (v: SessionsFile[K]) => {
        used[flag] = true
        value = v
      }
    })
  }
  const orNone = <T>(list: T[]): T[] | undefined => (list.length ? list : undefined)
  lazy('deleted', 'deleted', () => orNone(deleted()))
  lazy('deletedUsage', 'usage', () => orNone(usage()))
  return f
}

/** A host's records in its tables (on `db`: the reader, or a change's writer; `saved`: its records, when already read there). */
const fromTables = (db: ReturnType<typeof workspaceDb>['reader'], scope: string, saved = readSessionRecords(db, scope)): SessionsFile =>
  filed(saved, () => readDeleted(db, scope), () => readDeletedUsage(db, scope) as unknown as Kept[])

// ---------------------------------------------------------------------------
// 0.9's rows (store_rows), read while the workspace's upgrade to 1.0 waits.
// ---------------------------------------------------------------------------

/** A kind's rows: its entries in order, each keyed by its id (made unique, rowKeys) after the kind's prefix. */
function kindRows(kind: Kind, entries: readonly unknown[]): StoreRow[] {
  const keys = rowKeys(kind === 'd:' ? entries.map((id) => ({ id })) : entries)
  return entries.map((e, i) => ({ key: kind + keys[i], doc: JSON.stringify(e), ord: i }))
}

/** The rows a 0.9 store kept of a host's records (each kind in its order, its keys kept apart by their prefix). */
export function sessionRows(f: SessionsFile): StoreRow[] {
  return [...kindRows('s:', f.sessions), ...kindRows('d:', f.deleted ?? []), ...kindRows('u:', f.deletedUsage ?? [])]
}

/** Parses a row, or says it can't be read (it is left out). */
function parsed(r: Row): { ok: true; doc: unknown } | { ok: false } {
  try {
    return { ok: true, doc: JSON.parse(r.doc) }
  } catch (e) {
    log.warn(`a session row (${r.key}) couldn't be read: left out`, e)
    return { ok: false }
  }
}

/** A host's records from a 0.9 store's rows (all of them, as read). */
export function sessionsOf(data: StoreData): SessionsFile {
  const docs = (kind: Kind): unknown[] => data.rows.filter((r) => r.key.startsWith(kind)).map(parsed).flatMap((p) => (p.ok ? [p.doc] : []))
  return filed(
    docs('s:'),
    () => docs('d:').filter((d): d is string => typeof d === 'string'),
    () => docs('u:').filter((u): u is Kept => !!u && typeof u === 'object')
  )
}

// ---------------------------------------------------------------------------
// The move in, reads and changes.
// ---------------------------------------------------------------------------

/**
 * The old file's records for the move in: null when there is none. One that can't be read now (held open, no permission)
 * throws, so nothing is marked and the next read tries again; a damaged one is recovered from its `.bak`, as kept files are.
 */
async function readOldFile(file: string): Promise<SessionsFile | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const f = JSON.parse(text) as SessionsFile
    if (f && typeof f === 'object' && Array.isArray(f.sessions)) return f
  } catch {
    // Damaged: as a kept file, recovered from its backup (and set aside).
  }
  log.warn(`${userText(file)} is damaged: its backup is moved in instead, if it has one`)
  return readKeptJson<SessionsFile>(file, EMPTY())
}

/**
 * Hosts whose file was moved in this run (by workspace and scope), with their workspace's place as the move entered
 * (#1456): asked once, not at every read.
 */
const opened = new Map<string, string>()
const openedKey = (p: SessionsPlace): string => `${p.workspace.toLowerCase()}\0${p.scope}`
// The workspace's database replaced (#1207 round 2: the upgrade to 1.0, a restore): its hosts are looked at again (a
// sessions.json whose move waited, or one a restore brought back the need for), under every spelling of the workspace,
// by the place each recorded. The records keep no copy in memory.
onDbReplaced((workspacePath, place) => {
  const prefix = `${workspacePath.toLowerCase()}\0`
  for (const [k, at] of [...opened]) if (k.startsWith(prefix) || at === place) opened.delete(k)
})
/** For tests: the workspaces (as spelt, lower-cased) whose hosts were moved in this run. */
export const sessionsOpenedFor = (): string[] => [...new Set([...opened.keys()].map((k) => k.slice(0, k.indexOf('\0'))))]

/** Hosts being removed now (Remove from Hive, by workspace and scope): what they export stays in their folder. */
const removing = new Set<string>()

/** The sessions' side of a move in (openTable): how many records a host has, and a file's written beside them. */
const TABLE = {
  count: (db: ReturnType<typeof workspaceDb>['writer'], scope: string) => countSessions(db, scope),
  put: (db: ReturnType<typeof workspaceDb>['writer'], scope: string, f: SessionsFile) => addSessionRecords(db, scope, f)
}

/**
 * Moves a host's old file in if it hasn't been this run (openTable says when it is due), or the file Remove from Hive
 * left in its folder once the project is back. A removed host's file stays where it is. Nothing while the workspace's
 * upgrade to 1.0 waits (asked again once it is upgraded).
 */
async function opening(place: SessionsPlace, db?: Db): Promise<void> {
  const k = openedKey(place)
  if (opened.has(k) || (db ? !!db.pending : upgradeWaiting(place.workspace))) return
  // A removed host's folder keeps its file, whatever scope it is read under (#1161: its id unreadable for a moment gives
  // its folder's, which has no `exported` mark). Not marked opened: asked again at each read until the project is back.
  if (refused(place)) return
  const exported = storeValue((db ?? workspaceDb(resolve(place.workspace))).writer, 'sessions', place.scope, 'exported') !== null
  // Its workspace's place resolved as it enters, before anything is awaited (#1456).
  const at = placeKey(place.workspace)
  if (exported) {
    if (await moveBack(place)) opened.set(k, at)
    return
  }
  // Asked again where the file would be moved or renamed (#1161): a removal may end while the file is read.
  if (await openTable(place.workspace, 'sessions', place.scope, place.file, () => readOldFile(place.file), TABLE, { whenEmpty: true, db, refuse: () => refused(place) })) opened.set(k, at)
}

/**
 * A host's records. The deleted lists are read when first used, from the database as it is then: most readers never
 * use them.
 */
export async function readSessions(place: SessionsPlace, signal?: AbortSignal): Promise<SessionsFile> {
  await opening(place)
  // Closed meanwhile: its board, closed with it, isn't opened again by this read (#1379).
  signal?.throwIfAborted()
  if (upgradeWaiting(place.workspace)) return sessionsOf(readStore(place.workspace, 'sessions', place.scope))
  return fromTables(workspaceDb(resolve(place.workspace)).reader, place.scope)
}

/** One of a host's records by its id, or undefined: read by its key, not with every record (a running agent's, at each board change). */
export async function readSession(place: SessionsPlace, id: string): Promise<SessionsFile['sessions'][number] | undefined> {
  await opening(place)
  if (upgradeWaiting(place.workspace)) return sessionsOf(readStore(place.workspace, 'sessions', place.scope)).sessions.find((s) => s.id === id)
  const rec = readSessionRecord(workspaceDb(resolve(place.workspace)).reader, place.scope, id)
  return rec ? recordOf(rec) : undefined
}

/**
 * An agent's records of a host, most recently active first (HI-1236): read by the agent's index, no other record read
 * (while the workspace's upgrade to 1.0 waits, picked from all of them).
 */
export async function readAgentSessions(place: SessionsPlace, agentId: string): Promise<SessionsFile['sessions']> {
  await opening(place)
  if (upgradeWaiting(place.workspace)) return byActivity(sessionsOf(readStore(place.workspace, 'sessions', place.scope)).sessions.filter((s) => s.agentId === agentId))
  return readAgentSessionRecords(workspaceDb(resolve(place.workspace)).reader, place.scope, agentId).map(recordOf)
}

/**
 * The records of a host that worked on a card (their `cards` have it), in the host's order (HI-1236): read by the
 * cards' index, no other record read (while the workspace's upgrade to 1.0 waits, picked from all of them).
 */
export async function readCardSessions(place: SessionsPlace, card: number): Promise<SessionsFile['sessions']> {
  await opening(place)
  if (upgradeWaiting(place.workspace)) return sessionsOf(readStore(place.workspace, 'sessions', place.scope)).sessions.filter((s) => s.cards?.some((c) => c.number === card))
  return readCardSessionRecords(workspaceDb(resolve(place.workspace)).reader, place.scope, card).map(recordOf)
}

/** Most recently active first, as the agent's index gives them. */
const byActivity = (recs: SessionsFile['sessions']): SessionsFile['sessions'] => [...recs].sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))

/**
 * Changes a host's records from what is committed now, one change at a time across Hive's windows and processes: `fn`
 * changes them in place (with nothing awaited), and only the rows it changed are written; a deleted list it never used
 * isn't read. It throws, and nothing is written.
 */
export async function changeSessions<T>(place: SessionsPlace, fn: (f: SessionsFile) => T): Promise<T> {
  // A save, which lands as its workspace closes too (#1379): the move-in it may need first reads and writes on its lease's
  // connection, which a close meanwhile leaves open for it (#1381: through the workspace's, that was fenced, losing a
  // session's last change); the save takes a lease of its own under the board's lock. Each closes what it opened.
  return withLeasedDb(resolve(place.workspace), async (db) => {
    await opening(place, db)
    return saveSessions(place, fn)
  })
}

/**
 * Changes one of a host's records by its id, as changeSessions does but reading and writing that record alone (HI-1887:
 * a running agent's record changes many times a turn, and each change read and compared every record of its host,
 * hundreds in a long-lived project). `fn` changes it in place (with nothing awaited). Not saved: `fn` isn't called and
 * the reply is `{ found: false }` (the caller makes it with changeSessions, which can add it).
 */
export async function changeSessionRecord<T>(place: SessionsPlace, id: string, fn: (rec: SessionsFile['sessions'][number]) => T): Promise<{ found: true; value: T } | { found: false }> {
  return withLeasedDb(resolve(place.workspace), async (leased) => {
    await opening(place, leased)
    return writeStore(place.workspace, 'sessions', place.scope, (db): { found: true; value: T } | { found: false } => {
      const saved = readSessionRecord(db, place.scope, id)
      if (!saved) return { found: false }
      // Its text as saved, before recordOf's upgrade of an old record (so that upgrade is written), as saveSessions takes it.
      const had = sessionTexts(place.scope, [saved]).get(id)
      if (!had) throw new Error(`a saved session record without the fields Hive keeps (${JSON.stringify(id)}): nothing was saved`) // i18n-ignore: a mistake in Hive's code, logged
      const rec = recordOf(saved)
      const value = fn(rec)
      writeSessionRecord(db, place.scope, rec as unknown as Record<string, unknown>, had)
      return { found: true, value }
    })
  })
}

/** changeSessions' save, its host opened. */
function saveSessions<T>(place: SessionsPlace, fn: (f: SessionsFile) => T): Promise<T> {
  return writeStore(place.workspace, 'sessions', place.scope, (db) => {
    // The records read once (HI-1803): their texts as saved taken before `fn` changes them in place (and before
    // recordOf's upgrade of an old record, so that upgrade is written), what the write compares with.
    const saved = readSessionRecords(db, place.scope)
    const had = sessionTexts(place.scope, saved)
    const f = fromTables(db, place.scope, saved)
    const result = fn(f)
    const used = lazyLists.get(f)!
    writeSessionRecords(
      db,
      place.scope,
      {
        sessions: f.sessions as unknown as Record<string, unknown>[],
        ...(used.deleted ? { deleted: f.deleted ?? [] } : {}),
        ...(used.usage ? { deletedUsage: (f.deletedUsage ?? []) as unknown as Record<string, unknown>[] } : {})
      },
      had
    )
    return result
  })
}

/**
 * Writes a host's records into its folder's sessions.json and takes them out of the database (#1061: Remove from Hive),
 * so the folder takes them with it: restored, or opened in another workspace, they are moved in again. All of it under
 * the store's lock, so no change lands between the records written and those taken out; the file is written first: a
 * failure leaves them in the database. The host stays held (its file unread here) until `releaseSessions`: by then a
 * removed project is hidden as removed. Returns how many records it wrote.
 */
export async function exportSessions(place: SessionsPlace): Promise<number> {
  const k = openedKey(place)
  await opening(place)
  removing.add(k)
  try {
    const count = await withStoreLock(place.workspace, 'sessions', place.scope, async (db) => {
      // One write transaction from the read to the delete, the file written inside it (review round 2): no writer, in this
      // process or another (another Hive, a script on the database), commits between them; a failure undoes it all.
      timedStep('db begin hive.db', () => db.exec('BEGIN IMMEDIATE'))
      try {
        const f = fromTables(db, place.scope)
        const deleted = f.deleted
        const deletedUsage = f.deletedUsage
        await writeKeptJson(place.file, { version: 1, sessions: f.sessions, ...(deleted ? { deleted } : {}), ...(deletedUsage ? { deletedUsage } : {}) })
        removeSessionRecords(db, place.scope)
        db.prepare("INSERT INTO store_meta (store, scope, key, value) VALUES ('sessions', ?, 'exported', ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value").run(place.scope, JSON.stringify({ at: new Date().toISOString(), rows: f.sessions.length, file: place.file })) // i18n-ignore: SQL
        db.exec('COMMIT')
        return f.sessions.length
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw e
      }
    })
    opened.delete(k)
    log.info(`${count} session record(s) written to ${userText(place.file)}`)
    return count
  } catch (e) {
    removing.delete(k)
    throw e
  }
}

/** Remove from Hive is over (#1061): a project it hid keeps its file unread while removed; one it didn't moves it back. */
export function releaseSessions(place: SessionsPlace): void {
  removing.delete(openedKey(place))
  opened.delete(openedKey(place))
}

/**
 * The file Remove from Hive left in a host's folder, moved back in now it is back (#1061): its records, beside any
 * recorded here since (those win: they are newer), in one transaction that ends the mark; the file then kept as a
 * backup. Gone (taken in by another workspace meanwhile), the mark just ends.
 */
async function moveBack(place: SessionsPlace): Promise<boolean> {
  return withStoreLock(place.workspace, 'sessions', place.scope, async (db) => {
    // Removed while this waited for the lock (#1161): the file stays.
    if (refused(place)) return false
    if (storeValue(db, 'sessions', place.scope, 'exported') === null) return true
    const f = await readOldFile(place.file)
    // Or removed while the file was read: asked again right before the move.
    if (refused(place)) return false
    transaction(db, () => {
      if (f) addSessionRecords(db, place.scope, f)
      db.prepare("DELETE FROM store_meta WHERE store = 'sessions' AND scope = ? AND key = 'exported'").run(place.scope) // i18n-ignore: SQL
    })
    if (f) log.info(`moved ${f.sessions.length} session record(s) back in from ${userText(place.file)}`)
    // Kept as a backup under the same lock: a removal's export, which takes it too, can't write a new file before this rename.
    if (existsSync(place.file)) keepAsBackup(place.file)
    return true
  })
}

/** A host's file must stay in its folder (#1161): it is being removed, or removed, or that can't be known now. */
function refused(place: SessionsPlace): boolean {
  return removing.has(openedKey(place)) || !!place.removed?.()
}

/** For tests: forgets which hosts were moved in this run (a database replaced under a test). */
export function forgetOpenedSessions(): void {
  opened.clear()
}
