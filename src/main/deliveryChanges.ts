import type { DatabaseSync } from 'node:sqlite'
import { deliveryToRow, rowText, type Row } from './schema/sessionDeliveryCodec'
import { StaleDeliveries, type Rec } from './schema/sessionDeliveryTables'

/**
 * saveDeliveryChanges (schema/sessionDeliveryTables.ts, pinned to 1.0.0's) reading only the rows a save touches (HI-3290):
 * it read every row the host keeps (each with its whole text, a few MB with many agents) and wrote each out as its text,
 * on main, to check the few the save changed. The same rules, the same rows written, the same answers: `put` the records
 * made or changed, `removed` the ids dropped, `base` each known row's text as this writer last read or wrote it. A known
 * row whose committed text isn't its base is a conflict (StaleDeliveries, nothing written: the caller's transaction is
 * undone); a new record whose id another writer took is given the next free one (`renamed`). Returns the rows' texts as
 * now written (the writer's new bases) and the renames. In the caller's transaction, under the board's lock.
 */
export function saveDeliveryChanges(db: DatabaseSync, host: string, change: { put: Rec[]; removed: string[]; base: ReadonlyMap<string, string> }): { written: Map<string, string>; renamed: Map<string, { id: string; seq: number }> } {
  const now = committed(db, host, [...change.put.map((d) => d.id as string), ...change.removed])
  const written = new Map<string, string>()
  const renamed = new Map<string, { id: string; seq: number }>()
  let top = Math.max(0, Number((db.prepare('SELECT max(seq) AS m FROM deliveries WHERE host = ?').get(host) as { m: unknown }).m) || 0, ...change.put.map((d) => Number(d.seq) || 0)) // i18n-ignore: SQL
  const stale = (id: string): StaleDeliveries => new StaleDeliveries(`delivery ${id} was changed by another writer`) // i18n-ignore: a save retried, logged
  for (const rec of change.put) {
    let d = rec
    const known = change.base.get(d.id as string)
    if (known !== undefined) {
      // Changed here: only from the row as this writer last had it.
      if (now.get(d.id as string) !== known) throw stale(d.id as string)
    } else if (now.has(d.id as string)) {
      // New here, and its id another writer's since: the next free one.
      top++
      renamed.set(d.id as string, { id: `m${top}`, seq: top })
      d = { ...d, id: `m${top}`, seq: top }
    }
    const r = deliveryToRow(host, d)
    if (!r) throw new Error(`a delivery without the fields Combwork keeps (${JSON.stringify(d.id)}): nothing was saved`) // i18n-ignore: a mistake in Combwork's code, logged
    const full = withAllColumns(db, r)
    if (now.has(r.id as string)) update(db, full)
    else insert(db, r)
    written.set(r.id as string, rowText(full))
  }
  const del = db.prepare('DELETE FROM deliveries WHERE host = ? AND id = ?') // i18n-ignore: SQL
  for (const id of change.removed) {
    const was = now.get(id)
    // Gone already: nothing to do. Changed by another writer since: not this one's to drop.
    if (was === undefined) continue
    if (was !== change.base.get(id)) throw stale(id)
    del.run(host, id)
  }
  return { written, renamed }
}

/** The committed rows of a host's deliveries with these ids, each as its text (what a compare-and-set save checks against). */
function committed(db: DatabaseSync, host: string, ids: string[]): Map<string, string> {
  const one = db.prepare('SELECT * FROM deliveries WHERE host = ? AND id = ?') // i18n-ignore: SQL
  const out = new Map<string, string>()
  for (const id of ids) {
    if (out.has(id)) continue
    const r = one.get(host, id) as Row | undefined
    if (r) out.set(id, rowText(r))
  }
  return out
}

const insert = (db: DatabaseSync, row: Row): void => {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined)
  db.prepare(`INSERT INTO deliveries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]!)) // i18n-ignore: SQL
}

const update = (db: DatabaseSync, row: Row): void => {
  const cols = Object.keys(row).filter((k) => k !== 'host' && k !== 'id' && row[k] !== undefined)
  db.prepare(`UPDATE deliveries SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE host = ? AND id = ?`).run(...cols.map((c) => row[c]!), row.host!, row.id!) // i18n-ignore: SQL
}

/** A row with every column of `deliveries`, those it doesn't give null (as SELECT * reads it back). */
function withAllColumns(db: DatabaseSync, r: Row): Row {
  const out: Row = {}
  for (const c of deliveryColumns(db)) out[c] = r[c] ?? null
  return out
}
let columns: string[] | null = null
const deliveryColumns = (db: DatabaseSync): string[] => (columns ??= (db.prepare('SELECT name FROM pragma_table_info(?)').all('deliveries') as { name: string }[]).map((r) => r.name)) // i18n-ignore: SQL
