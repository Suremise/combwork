import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'
import { resolve } from 'path'
import type { SessionsFile } from './workspace'
import { onDbReplaced, upgradeWaiting, workspaceDb } from './boardStore'
import { readKeptJson, writeKeptJson } from './fsutil'
import { createLogger, userText } from './logger'
import { keepAsBackup, openStore, readStore, rowKeys, withStoreLock, writeStore, type StoreData, type StoreRow } from './storeRows'
import { transaction } from './db'
import { withMode } from '../shared/defaults'

const log = createLogger('sessions')

/**
 * A session host's records (#1061: a project's, the Assistant's), in its workspace's database rather than its
 * `.hive/sessions.json`, which was rewritten whole (746 KB on the hive project) at every change of a record. The rows of
 * the `sessions` store, under the host's scope (its project id, `assistant` for the Assistant): `s:` a record, `d:` a
 * deleted session's id, `u:` a deleted session's usage, each group in its order (`ord`). A change writes only the rows it
 * changed. The file is moved in the first time a host's records are read, then kept as `sessions.json.imported-<time>`;
 * so is one found later while the host has no records (its folder removed from another workspace, exportSessions), else
 * it is kept so unread. Remove from Hive writes them back into the folder, which takes them wherever it goes, and marks
 * them `exported` here: while the project is removed (or being removed) nothing reads that file; once it is back (Restore,
 * or the folder shown again), it is moved in again, with what was recorded here meanwhile.
 */

const EMPTY = (): SessionsFile => ({ version: 1, sessions: [] })

/** Where a host's records are: its workspace's folder, its scope there, and its old file. */
export interface SessionsPlace {
  workspace: string
  scope: string
  file: string
  /** Removed from Hive (hidden as removed in its workspace): records it took away in its folder stay there (#1061). */
  removed?: boolean
}

type Row = { key: string; doc: string; ord?: number }
type Kind = 's:' | 'd:' | 'u:'
const KINDS: Kind[] = ['s:', 'd:', 'u:']

/**
 * The deleted sessions' ids and usage of records given out (#1061): most changes never look at them (the usage is most of
 * a big project's records), so each list is read when first used, and one never used is left as it is.
 */
const lazyLists = new WeakMap<SessionsFile, { deleted: boolean; usage: boolean }>()

/** A kind's rows: its entries in order, each keyed by its id (made unique, rowKeys) after the kind's prefix. */
function kindRows(kind: Kind, entries: readonly unknown[]): StoreRow[] {
  const keys = rowKeys(kind === 'd:' ? entries.map((id) => ({ id })) : entries)
  return entries.map((e, i) => ({ key: kind + keys[i], doc: JSON.stringify(e), ord: i }))
}

/** The rows of a host's records (each kind in its order, its keys kept apart by their prefix). */
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

/**
 * A host's records from their rows: the records', and a reader of each deleted list's (`deleted`, `deletedUsage`: read
 * when first used, undefined when empty, as in the file). A row that can't be read is left out, and said.
 */
function recordsOf(records: Row[], read: (kind: 'd:' | 'u:') => Row[]): SessionsFile {
  const f: SessionsFile = EMPTY()
  for (const r of records) {
    const p = parsed(r)
    // A record from before 0.9.3 has the Assistant's mode as its persona (#1084).
    if (p.ok) f.sessions.push((p.doc && typeof p.doc === 'object' && 'persona' in p.doc ? withMode(p.doc as Record<string, unknown>) : p.doc) as SessionsFile['sessions'][number])
  }
  const used = { deleted: false, usage: false }
  lazyLists.set(f, used)
  const list = <T>(kind: 'd:' | 'u:', keep: (doc: unknown) => doc is T): T[] | undefined => {
    const out = read(kind).map(parsed).flatMap((p) => (p.ok && keep(p.doc) ? [p.doc] : []))
    return out.length ? out : undefined
  }
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
  lazy('deleted', 'deleted', () => list('d:', (d): d is string => typeof d === 'string'))
  lazy('deletedUsage', 'usage', () => list('u:', (u): u is NonNullable<SessionsFile['deletedUsage']>[number] => !!u && typeof u === 'object'))
  return f
}

/** A host's records from a store's rows (all of them, as read). */
export function sessionsOf(data: StoreData): SessionsFile {
  const of = (kind: Kind): Row[] => data.rows.filter((r) => r.key.startsWith(kind))
  return recordsOf(of('s:'), of)
}

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

/** Hosts whose file was moved in this run (by workspace and scope): asked once, not at every read. */
const opened = new Set<string>()
const openedKey = (p: SessionsPlace): string => `${p.workspace.toLowerCase()}\0${p.scope}`
// The workspace's database replaced (#1207 round 2: the upgrade to 1.0, a restore): its hosts are looked at again (a
// sessions.json whose move waited, or one a restore brought back the need for). The records keep no copy in memory.
onDbReplaced((workspacePath) => {
  const prefix = `${workspacePath.toLowerCase()}\0`
  for (const k of [...opened]) if (k.startsWith(prefix)) opened.delete(k)
})

/** Hosts being removed now (Remove from Hive, by workspace and scope): what they export stays in their folder. */
const removing = new Set<string>()

/**
 * Moves a host's old file in if it hasn't been this run (openStore says when it is due), or the file Remove from Hive
 * left in its folder once the project is back; its rows when it read them. A removed host's file stays where it is.
 */
async function opening(place: SessionsPlace): Promise<StoreData | null> {
  const k = openedKey(place)
  if (opened.has(k)) return null
  const now = readStore(place.workspace, 'sessions', place.scope)
  // The workspace's upgrade to 1.0 waits (#1207): nothing is moved, and it is asked again once it is upgraded.
  if (upgradeWaiting(place.workspace)) return now
  if (now.meta.has('exported')) {
    // Not marked opened: asked again at each read until the project is back.
    if (place.removed || removing.has(k)) return now
    await moveBack(place)
    opened.add(k)
    return null
  }
  const data = await openStore(place.workspace, 'sessions', place.scope, place.file, async () => {
    const f = await readOldFile(place.file)
    return f && { rows: sessionRows(f) }
  }, { whenEmpty: true })
  opened.add(k)
  return data
}

/**
 * A host's records. The deleted lists are read when first used, from the database as it is then: most readers never
 * use them.
 */
export async function readSessions(place: SessionsPlace): Promise<SessionsFile> {
  const data = await opening(place)
  if (data) return sessionsOf(data)
  const db = workspaceDb(resolve(place.workspace)).reader
  const read = (kind: Kind): Row[] => db.prepare(KIND_SQL).all('sessions', place.scope, kind, pastKind(kind)) as Row[]
  return recordsOf(read('s:'), read)
}

/** A kind's rows as committed (the key's range in the table's index: a kind is read without the others). */
const KIND_SQL = 'SELECT key, ord, doc FROM store_rows WHERE store = ? AND scope = ? AND key >= ? AND key < ? ORDER BY ord, key' // i18n-ignore: SQL
const pastKind = (kind: Kind): string => kind.slice(0, -1) + ';'

/**
 * Changes a host's records from what is committed now, one change at a time across Hive's windows and processes: `fn`
 * changes them in place (with nothing awaited), and only the rows it changed are written; a deleted list it never used
 * isn't read. It throws, and nothing is written.
 */
export async function changeSessions<T>(place: SessionsPlace, fn: (f: SessionsFile) => T): Promise<T> {
  await opening(place)
  return writeStore(place.workspace, 'sessions', place.scope, (db) => {
    const committed = new Map<Kind, { key: string; ord: number; doc: string }[]>()
    const read = (kind: Kind): { key: string; ord: number; doc: string }[] => {
      let rows = committed.get(kind)
      if (!rows) committed.set(kind, (rows = db.prepare(KIND_SQL).all('sessions', place.scope, kind, pastKind(kind)) as { key: string; ord: number; doc: string }[]))
      return rows
    }
    const f = recordsOf(read('s:'), read)
    const result = fn(f)
    const used = lazyLists.get(f)!
    const after: Record<Kind, readonly unknown[] | null> = { 's:': f.sessions, 'd:': used.deleted ? (f.deleted ?? []) : null, 'u:': used.usage ? (f.deletedUsage ?? []) : null }
    const put = db.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET ord = excluded.ord, doc = excluded.doc') // i18n-ignore: SQL
    const del = db.prepare('DELETE FROM store_rows WHERE store = ? AND scope = ? AND key = ?') // i18n-ignore: SQL
    for (const kind of KINDS) {
      const entries = after[kind]
      if (!entries) continue
      const had = new Map(read(kind).map((r) => [r.key, r]))
      for (const r of kindRows(kind, entries)) {
        const was = had.get(r.key)
        if (!was || was.ord !== r.ord || was.doc !== r.doc) put.run('sessions', place.scope, r.key, r.ord!, r.doc)
        had.delete(r.key)
      }
      for (const k of had.keys()) del.run('sessions', place.scope, k)
    }
    return result
  })
}

/** All of a host's rows as committed, read on the writer. */
const allRows = (db: ReturnType<typeof workspaceDb>['writer'], scope: string): { key: string; ord: number; doc: string }[] => db.prepare('SELECT key, ord, doc FROM store_rows WHERE store = ? AND scope = ? ORDER BY ord, key').all('sessions', scope) as { key: string; ord: number; doc: string }[] // i18n-ignore: SQL

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
      db.exec('BEGIN IMMEDIATE')
      try {
        const rows = allRows(db, place.scope)
        const of = (kind: Kind): Row[] => rows.filter((r) => r.key.startsWith(kind))
        const f = recordsOf(of('s:'), of)
        await writeKeptJson(place.file, { version: 1, sessions: f.sessions, ...(f.deleted ? { deleted: f.deleted } : {}), ...(f.deletedUsage ? { deletedUsage: f.deletedUsage } : {}) })
        db.prepare('DELETE FROM store_rows WHERE store = ? AND scope = ?').run('sessions', place.scope) // i18n-ignore: SQL
        db.prepare("INSERT INTO store_meta (store, scope, key, value) VALUES ('sessions', ?, 'exported', ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value").run(place.scope, JSON.stringify({ at: new Date().toISOString(), rows: rows.length, file: place.file })) // i18n-ignore: SQL
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
 * The file Remove from Hive left in a host's folder, moved back in now it is back (#1061): its rows, beside any recorded
 * here since (those win: they are newer), in one transaction that ends the mark; the file then kept as a backup. Gone
 * (taken in by another workspace meanwhile), the mark just ends.
 */
async function moveBack(place: SessionsPlace): Promise<void> {
  await withStoreLock(place.workspace, 'sessions', place.scope, async (db) => {
    if (!db.prepare("SELECT 1 FROM store_meta WHERE store = 'sessions' AND scope = ? AND key = 'exported'").get(place.scope)) return // i18n-ignore: SQL
    const f = await readOldFile(place.file)
    transaction(db, () => {
      const put = db.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, scope, key) DO NOTHING') // i18n-ignore: SQL
      for (const r of f ? sessionRows(f) : []) put.run('sessions', place.scope, r.key, r.ord!, r.doc)
      db.prepare("DELETE FROM store_meta WHERE store = 'sessions' AND scope = ? AND key = 'exported'").run(place.scope) // i18n-ignore: SQL
    })
    if (f) log.info(`moved ${f.sessions.length} session record(s) back in from ${userText(place.file)}`)
  })
  if (existsSync(place.file)) keepAsBackup(place.file)
}

/** For tests: forgets which hosts were moved in this run (a database replaced under a test). */
export function forgetOpenedSessions(): void {
  opened.clear()
}
