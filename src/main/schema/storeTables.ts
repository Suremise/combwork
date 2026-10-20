import type { DatabaseSync } from 'node:sqlite'
import { deliveryFromRow, deliveryToRow, keptUsageFromRow, keptUsageToRow, rowText, sessionFromRows, sessionToRows, type Row } from './storeCodec'
import { V1_0_STEPS } from './v1_0'

/**
 * Sessions' and deliveries' typed tables (#1211, v1_0.ts's "sessions and deliveries in tables"): a host's records read
 * and written in them, and the 1.0 step that moves `store_rows`' rows into them. A host is the store's scope (a
 * project's id, `assistant`, deliveries also `folder:<name>`). What isn't of Hive's form (storeCodec.ts) is kept aside
 * as it was, under the scope's `setAside` value in `store_meta` (sessions) or with deliveries' `invalid` entries, never
 * lost and never in the table.
 */

type Db = DatabaseSync

const insert = (db: Db, table: string, row: Row): void => {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined)
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]!)) // i18n-ignore: SQL
}

function metaGet(db: Db, store: string, scope: string, key: string): string | null {
  const r = db.prepare('SELECT value FROM store_meta WHERE store = ? AND scope = ? AND key = ?').get(store, scope, key) as { value: string } | undefined // i18n-ignore: SQL
  return r?.value ?? null
}
function metaSet(db: Db, store: string, scope: string, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM store_meta WHERE store = ? AND scope = ? AND key = ?').run(store, scope, key) // i18n-ignore: SQL
  else db.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value').run(store, scope, key, value) // i18n-ignore: SQL
}
/** Adds entries to a scope's list kept aside (`key` in store_meta: a JSON array), after those there. */
function keepAside(db: Db, store: string, scope: string, key: string, entries: unknown[]): void {
  if (!entries.length) return
  const had = metaGet(db, store, scope, key)
  metaSet(db, store, scope, key, JSON.stringify([...(had ? (JSON.parse(had) as unknown[]) : []), ...entries]))
}

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

export type Rec = Record<string, unknown>

/** A host's session records, in their order. */
export function readSessionRecords(db: Db, host: string): Rec[] {
  const rows = db.prepare('SELECT * FROM sessions WHERE host = ? ORDER BY ord, id').all(host) as Rec[] // i18n-ignore: SQL
  if (!rows.length) return []
  const cards = new Map<string, Rec[]>()
  for (const c of db.prepare('SELECT * FROM session_cards WHERE host = ? ORDER BY session, ord').all(host) as Rec[]) { // i18n-ignore: SQL
    const list = cards.get(c.session as string) ?? []
    list.push(c)
    cards.set(c.session as string, list)
  }
  return rows.map((r) => sessionFromRows(r, cards.get(r.id as string) ?? []))
}

/** One of a host's records by its id (its key: no other record is read), or null. */
export function readSessionRecord(db: Db, host: string, id: string): Rec | null {
  const row = db.prepare('SELECT * FROM sessions WHERE host = ? AND id = ?').get(host, id) as Rec | undefined // i18n-ignore: SQL
  if (!row) return null
  return sessionFromRows(row, db.prepare('SELECT * FROM session_cards WHERE host = ? AND session = ? ORDER BY ord').all(host, id) as Rec[]) // i18n-ignore: SQL
}

export const readDeleted = (db: Db, host: string): string[] => (db.prepare('SELECT id FROM sessions_deleted WHERE host = ? ORDER BY ord, id').all(host) as { id: string }[]).map((r) => r.id) // i18n-ignore: SQL
export const readDeletedUsage = (db: Db, host: string): Rec[] => (db.prepare('SELECT * FROM sessions_deleted_usage WHERE host = ? ORDER BY ord, id').all(host) as Rec[]).map(keptUsageFromRow) // i18n-ignore: SQL

/** A session record's row and its cards' as text: what a change compares to see which of them changed. */
const sessionText = (r: { row: Row; cards: Row[] }): { row: string; cards: string } => ({ row: rowText({ ...r.row, ord: 0 }), cards: r.cards.map(rowText).join('') })

/** A row's columns set in place (its key's: `host` and `id` stay): its cards and anything referencing it are left. */
const update = (db: Db, table: string, row: Row): void => {
  const cols = Object.keys(row).filter((k) => k !== 'host' && k !== 'id' && row[k] !== undefined)
  db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE host = ? AND id = ?`).run(...cols.map((c) => row[c]!), row.host!, row.id!) // i18n-ignore: SQL
}

/** What a change of a host's records writes: each list given replaced in its order (a list left out, as it was). */
export interface SessionsChange {
  sessions: Rec[]
  deleted?: string[]
  deletedUsage?: Rec[]
}

/**
 * Writes a host's records as `next` has them, only the rows that changed. A record not of Hive's form, or two with one
 * id, throw (a mistake in Hive's code: nothing is written).
 */
export function writeSessionRecords(db: Db, host: string, next: SessionsChange): void {
  const had = new Map<string, { row: string; cards: string }>()
  for (const rec of readSessionRecords(db, host)) {
    const r = sessionToRows(host, 0, rec)
    if (r) had.set(rec.id as string, sessionText(r))
  }
  const ords = new Map((db.prepare('SELECT id, ord FROM sessions WHERE host = ?').all(host) as { id: string; ord: number }[]).map((r) => [r.id, r.ord])) // i18n-ignore: SQL
  const ids = new Set<string>()
  const setOrd = db.prepare('UPDATE sessions SET ord = ? WHERE host = ? AND id = ?') // i18n-ignore: SQL
  const del = db.prepare('DELETE FROM sessions WHERE host = ? AND id = ?') // i18n-ignore: SQL
  const delCards = db.prepare('DELETE FROM session_cards WHERE host = ? AND session = ?') // i18n-ignore: SQL
  next.sessions.forEach((rec, i) => {
    const r = sessionToRows(host, i, rec)
    if (!r) throw new Error(`a session record without the fields Hive keeps (${JSON.stringify(rec.id)}): nothing was saved`) // i18n-ignore: a mistake in Hive's code, logged
    const id = rec.id as string
    if (ids.has(id)) throw new Error(`two session records with the id ${id}: nothing was saved`) // i18n-ignore: as above
    ids.add(id)
    const was = had.get(id)
    if (!was) {
      insert(db, 'sessions', r.row)
      for (const c of r.cards) insert(db, 'session_cards', c)
      return
    }
    // Only what changed: its row (in place, so its cards stay), its cards, or its place (ord: it changes for every
    // record behind a removed one), each apart.
    const now = sessionText(r)
    if (now.row !== was.row) update(db, 'sessions', r.row)
    else if (ords.get(id) !== i) setOrd.run(i, host, id)
    if (now.cards !== was.cards) {
      delCards.run(host, id)
      for (const c of r.cards) insert(db, 'session_cards', c)
    }
  })
  for (const id of had.keys()) if (!ids.has(id)) del.run(host, id)
  if (next.deleted) {
    const now = readDeleted(db, host)
    const want = [...new Set(next.deleted)]
    if (JSON.stringify(now) !== JSON.stringify(want)) {
      db.prepare('DELETE FROM sessions_deleted WHERE host = ?').run(host) // i18n-ignore: SQL
      want.forEach((id, i) => insert(db, 'sessions_deleted', { host, id, ord: i }))
    }
  }
  if (next.deletedUsage) {
    const rows = next.deletedUsage.map((k, i) => {
      const r = keptUsageToRow(host, i, k)
      if (!r) throw new Error(`a deleted session's usage without the fields Hive keeps (${JSON.stringify(k.id)}): nothing was saved`) // i18n-ignore: a mistake in Hive's code, logged
      return r
    })
    const now = (db.prepare('SELECT * FROM sessions_deleted_usage WHERE host = ? ORDER BY ord, id').all(host) as Row[]).map(rowText) // i18n-ignore: SQL
    if (JSON.stringify(now) !== JSON.stringify(rows.map(rowText))) {
      db.prepare('DELETE FROM sessions_deleted_usage WHERE host = ?').run(host) // i18n-ignore: SQL
      const seen = new Set<string>()
      for (const r of rows) {
        if (seen.has(r.id as string)) throw new Error(`two deleted sessions' usage with the id ${String(r.id)}: nothing was saved`) // i18n-ignore: as above
        seen.add(r.id as string)
        insert(db, 'sessions_deleted_usage', r)
      }
    }
  }
}

/**
 * Adds a host's records from a file (the move in, the move back of Remove from Hive's export) beside those it has: one
 * whose id it has already is left out (the table's wins: it is newer), one not of Hive's form kept aside. Returns how many
 * records it added.
 */
export function addSessionRecords(db: Db, host: string, f: { sessions?: unknown[]; deleted?: unknown[]; deletedUsage?: unknown[] }): number {
  const had = new Set((db.prepare('SELECT id FROM sessions WHERE host = ?').all(host) as { id: string }[]).map((r) => r.id)) // i18n-ignore: SQL
  let ord = ((db.prepare('SELECT max(ord) AS m FROM sessions WHERE host = ?').get(host) as { m: number | null }).m ?? -1) + 1 // i18n-ignore: SQL
  const aside: unknown[] = []
  let added = 0
  for (const rec of f.sessions ?? []) {
    const r = rec && typeof rec === 'object' ? sessionToRows(host, ord, rec as Rec) : null
    if (!r) {
      aside.push(rec)
      continue
    }
    const id = (rec as Rec).id as string
    if (had.has(id)) continue
    had.add(id)
    insert(db, 'sessions', r.row)
    for (const c of r.cards) insert(db, 'session_cards', c)
    ord++
    added++
  }
  const deleted = new Set(readDeleted(db, host))
  let dOrd = deleted.size
  for (const id of f.deleted ?? []) {
    if (typeof id !== 'string') {
      aside.push(id)
      continue
    }
    if (deleted.has(id)) continue
    deleted.add(id)
    insert(db, 'sessions_deleted', { host, id, ord: dOrd++ })
  }
  const usage = new Set((db.prepare('SELECT id FROM sessions_deleted_usage WHERE host = ?').all(host) as { id: string }[]).map((r) => r.id)) // i18n-ignore: SQL
  let uOrd = usage.size
  for (const k of f.deletedUsage ?? []) {
    const r = k && typeof k === 'object' ? keptUsageToRow(host, uOrd, k as Rec) : null
    if (!r) {
      aside.push(k)
      continue
    }
    if (usage.has(r.id as string)) continue
    usage.add(r.id as string)
    insert(db, 'sessions_deleted_usage', r)
    uOrd++
  }
  keepAside(db, 'sessions', host, 'setAside', aside)
  return added
}

/** Takes a host's records out of the tables (Remove from Hive's export, once they are in the folder's file). */
export function removeSessionRecords(db: Db, host: string): void {
  for (const t of ['sessions', 'sessions_deleted', 'sessions_deleted_usage']) db.prepare(`DELETE FROM ${t} WHERE host = ?`).run(host) // i18n-ignore: SQL
}

export const countSessions = (db: Db, host: string): number => (db.prepare('SELECT count(*) AS n FROM sessions WHERE host = ?').get(host) as { n: number }).n // i18n-ignore: SQL

// ---------------------------------------------------------------------------
// Deliveries.
// ---------------------------------------------------------------------------

/** A host's deliveries, in the order of their seq. */
export const readDeliveries = (db: Db, host: string): Rec[] => (db.prepare('SELECT * FROM deliveries WHERE host = ? ORDER BY seq, id').all(host) as Rec[]).map(deliveryFromRow) // i18n-ignore: SQL

export const countDeliveries = (db: Db, host: string): number => (db.prepare('SELECT count(*) AS n FROM deliveries WHERE host = ?').get(host) as { n: number }).n // i18n-ignore: SQL

/**
 * Writes a host's deliveries as `records` has them, only the rows that changed. One not of Hive's form, or two with one
 * id, throw (deliveries.ts writes only what readDelivery reads back: a mistake; nothing is written).
 */
export function writeDeliveries(db: Db, host: string, records: Rec[]): void {
  const had = new Map((db.prepare('SELECT * FROM deliveries WHERE host = ?').all(host) as Row[]).map((r) => [r.id as string, rowText(r)])) // i18n-ignore: SQL
  const ids = new Set<string>()
  const del = db.prepare('DELETE FROM deliveries WHERE host = ? AND id = ?') // i18n-ignore: SQL
  for (const d of records) {
    const r = deliveryToRow(host, d)
    if (!r) throw new Error(`a delivery without the fields Hive keeps (${JSON.stringify(d.id)}): nothing was saved`) // i18n-ignore: a mistake in Hive's code, logged
    const id = r.id as string
    if (ids.has(id)) throw new Error(`two deliveries with the id ${id}: nothing was saved`) // i18n-ignore: as above
    ids.add(id)
    // Compared with every column the table has (those this build doesn't fill read back null).
    const was = had.get(id)
    if (was === undefined) insert(db, 'deliveries', r)
    // Changed: set in place, every column (those it doesn't fill null).
    else if (was !== rowText(withAllColumns(db, r))) update(db, 'deliveries', withAllColumns(db, r))
  }
  for (const id of had.keys()) if (!ids.has(id)) del.run(host, id)
}

/** A row with every column of `deliveries`, those it doesn't give null (as SELECT * reads it back). */
function withAllColumns(db: Db, r: Row): Row {
  const out: Row = {}
  for (const c of deliveryColumns(db)) out[c] = r[c] ?? null
  return out
}
let columns: string[] | null = null
const deliveryColumns = (db: Db): string[] => (columns ??= (db.prepare('SELECT name FROM pragma_table_info(?)').all('deliveries') as { name: string }[]).map((r) => r.name)) // i18n-ignore: SQL

/**
 * Adds a host's deliveries from a file (the move in) to its table: one not of Hive's form, or whose id it has, goes to
 * the `invalid` entries kept beside them (as deliveries.ts keeps those it can't read back). Returns how many it added.
 */
export function addDeliveries(db: Db, host: string, entries: unknown[]): number {
  const had = new Set((db.prepare('SELECT id FROM deliveries WHERE host = ?').all(host) as { id: string }[]).map((r) => r.id)) // i18n-ignore: SQL
  const aside: unknown[] = []
  let added = 0
  for (const e of entries) {
    const r = e && typeof e === 'object' ? deliveryToRow(host, e as Rec) : null
    if (!r || had.has(r.id as string)) {
      aside.push(e)
      continue
    }
    had.add(r.id as string)
    insert(db, 'deliveries', r)
    added++
  }
  keepAside(db, 'deliveries', host, 'invalid', aside)
  return added
}

/**
 * A host's deliveries.json moved into its table (the move in, deliveries.ts): its entries (addDeliveries), its next id
 * and the entries it kept aside, beside them. Returns how many entries it added.
 */
export function addDeliveriesFile(db: Db, host: string, got: { deliveries: unknown[]; next: unknown; invalid: unknown[] }): number {
  const added = addDeliveries(db, host, got.deliveries)
  if (got.next !== undefined) metaSet(db, 'deliveries', host, 'next', JSON.stringify(got.next))
  keepAside(db, 'deliveries', host, 'invalid', got.invalid)
  return added
}

// ---------------------------------------------------------------------------
// The 1.0 step: store_rows' sessions and deliveries into their tables.
// ---------------------------------------------------------------------------

const STEP = V1_0_STEPS.find((s) => s.name === 'sessions and deliveries in tables')!

/**
 * The step's `up` (in the 1.0 group's transaction): the tables made, every host's `sessions` and `deliveries` rows of
 * `store_rows` written into them in their order, then those rows deleted. Their values in `store_meta` (`imported`,
 * `next`, `invalid`, `exported`) stay. A row whose JSON can't be read, or not of Hive's form, is kept aside as its text
 * or value (`setAside`, `invalid`).
 */
export function moveStoreRows(db: Db): { sessions: number; deliveries: number } {
  for (const sql of STEP.ddl) db.exec(sql)
  const counts = { sessions: 0, deliveries: 0 }
  const scopes = (store: string): string[] => (db.prepare('SELECT DISTINCT scope FROM store_rows WHERE store = ? ORDER BY scope').all(store) as { scope: string }[]).map((r) => r.scope) // i18n-ignore: SQL
  const rowsOf = (store: string, scope: string): { key: string; doc: string }[] => db.prepare('SELECT key, doc FROM store_rows WHERE store = ? AND scope = ? ORDER BY ord, key').all(store, scope) as { key: string; doc: string }[] // i18n-ignore: SQL
  const parse = (doc: string): { ok: true; v: unknown } | { ok: false } => {
    try {
      return { ok: true, v: JSON.parse(doc) }
    } catch {
      return { ok: false }
    }
  }
  for (const host of scopes('sessions')) {
    const f: { sessions: unknown[]; deleted: unknown[]; deletedUsage: unknown[] } = { sessions: [], deleted: [], deletedUsage: [] }
    const unread: string[] = []
    for (const r of rowsOf('sessions', host)) {
      const p = parse(r.doc)
      if (!p.ok) unread.push(r.doc)
      else if (r.key.startsWith('s:')) f.sessions.push(p.v)
      else if (r.key.startsWith('d:')) f.deleted.push(p.v)
      else if (r.key.startsWith('u:')) f.deletedUsage.push(p.v)
      else unread.push(r.doc)
    }
    // Records with one id twice (a hand edit's): the first kept, as every reader found it first; the others aside.
    const seen = new Set<string>()
    const dupes: unknown[] = []
    f.sessions = f.sessions.filter((s) => {
      const id = s && typeof s === 'object' ? (s as Rec).id : undefined
      if (typeof id !== 'string') return true
      if (seen.has(id)) {
        dupes.push(s)
        return false
      }
      seen.add(id)
      return true
    })
    counts.sessions += addSessionRecords(db, host, f)
    keepAside(db, 'sessions', host, 'setAside', [...dupes, ...unread])
  }
  for (const host of scopes('deliveries')) {
    const entries: unknown[] = []
    const unread: string[] = []
    for (const r of rowsOf('deliveries', host)) {
      const p = parse(r.doc)
      if (p.ok) entries.push(p.v)
      else unread.push(r.doc)
    }
    counts.deliveries += addDeliveries(db, host, entries)
    keepAside(db, 'deliveries', host, 'invalid', unread)
  }
  db.prepare("DELETE FROM store_rows WHERE store IN ('sessions', 'deliveries')").run() // i18n-ignore: SQL
  return counts
}
