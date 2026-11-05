import { saveTable as saveTypedTable, storeValue, type StoreName } from '../src/main/storeRows'
import { readTableIn, saveTable } from '../src/main/storeTables'
import type { TableStore } from '../src/main/schema/storeCodec'
import { leaseDb } from '../src/main/boardStore'
import type { Db } from '../src/main/db'
import { addDeliveries, readDeliveries } from '../src/main/schema/sessionDeliveryTables'

/** Any store: lanes, watches and metrics are in their typed tables (#1212, storeTables.ts), sessions and deliveries in theirs (#1211). */
type AnyStore = StoreName | TableStore
const inTables = (store: AnyStore): store is TableStore => store === 'lanes' || store === 'watches' || store === 'metrics'

/**
 * Runs `read` on a lease's connection to the workspace's database, closing it again after when it wasn't open: a look at
 * any workspace's, held by a window or not (#1395: Combwork keeps none open but a window's), that holds nothing open after.
 */
function peek<T>(workspacePath: string, read: (db: Db['reader']) => T): T {
  const lease = leaseDb(workspacePath)
  try {
    return read(lease.db.reader)
  } finally {
    lease.release()
  }
}

/** Sessions are read through workspace.sessionsFile (sessionStore.ts): a host's records aren't one store's list. */
const nope = (store: string): never => {
  throw new Error(`storeDocs has no ${store}: read them through the workspace (workspace.sessionsFile)`)
}

/** A store's entries as the workspace database keeps them (#1018, #1211, #1212), in order: what its file held before. Deliveries in the order of their seq. */
export const storeDocs = <T = Record<string, unknown>>(workspacePath: string, store: AnyStore, scope = ''): T[] =>
  peek(workspacePath, (db) => (inTables(store) ? (readTableIn(db, store).docs as T[]) : store === 'deliveries' ? (readDeliveries(db, scope) as T[]) : nope(store)))

/** A store's value kept beside its entries (e.g. watches' and deliveries' `invalid`), parsed; undefined when there is none. */
export const storeMeta = <T = unknown>(workspacePath: string, store: AnyStore, key: string, scope = ''): T | undefined => {
  // Sessions' and deliveries' values stay in store_meta (#1211), the others' are board_meta's (#1212).
  const v = peek(workspacePath, (db) => (inTables(store) ? readTableIn(db, store).meta.get(key) : (storeValue(db, store, scope, key) ?? undefined)))
  return v === undefined ? undefined : (JSON.parse(v) as T)
}

/**
 * Saves a store's entries as Combwork would have (a test's stand-in for writing its file by hand before #1018): lanes, watches
 * and metrics in their tables (each entry's key from the entry), deliveries in theirs; `meta` its values (JSON-encoded here;
 * null removes one). `key` is no longer used: every store keys its entries itself.
 */
export async function putStoreDocs(workspacePath: string, store: AnyStore, docs: unknown[], o: { scope?: string; meta?: Record<string, unknown>; key?: (doc: unknown, i: number) => string } = {}): Promise<void> {
  const meta: Record<string, string | null> = { imported: JSON.stringify({ at: new Date().toISOString(), rows: 0, file: null }) }
  for (const [k, v] of Object.entries(o.meta ?? {})) meta[k] = v === null ? null : JSON.stringify(v)
  if (inTables(store)) return saveTable(workspacePath, store, docs, meta)
  if (store === 'deliveries') {
    // Their table (#1211): the host's rows replaced; an entry Combwork wouldn't read back goes with those kept aside, as the
    // 1.0 step puts it.
    const scope = o.scope ?? ''
    await saveTypedTable(workspacePath, store, scope, (db) => {
      db.prepare('DELETE FROM deliveries WHERE host = ?').run(scope)
      addDeliveries(db, scope, docs)
    }, meta)
    return
  }
  nope(store)
}

/** The performance metrics as saved (#1019, #1212: their tables in the workspace database), in the form metrics.json had; null before any save. */
export function metricsSaved(workspacePath: string): { version: 1; buckets: Record<string, unknown>[]; observed: [number, number][]; evictedThrough?: number; renamesApplied?: number } | null {
  const { docs, meta } = peek(workspacePath, (db) => readTableIn(db, 'metrics'))
  if (!meta.has('imported')) return null
  const num = (k: string): number | undefined => (meta.has(k) ? Number(JSON.parse(meta.get(k)!)) : undefined)
  // As plain JSON (the tables give a bucket's maps without a prototype, as the store makes them).
  return { version: 1, buckets: JSON.parse(JSON.stringify(docs)) as Record<string, unknown>[], observed: meta.has('observed') ? (JSON.parse(meta.get('observed')!) as [number, number][]) : [], ...(num('evictedThrough') ? { evictedThrough: num('evictedThrough') } : {}), ...(num('renamesApplied') ? { renamesApplied: num('renamesApplied') } : {}) }
}

/** Saves performance metrics as Combwork would (a test's stand-in for writing metrics.json by hand), in its form. */
export async function putMetrics(workspacePath: string, data: { buckets: { span: string; start: number }[]; observed?: unknown; evictedThrough?: number; renamesApplied?: number }): Promise<void> {
  await saveTable(workspacePath, 'metrics', data.buckets, { imported: JSON.stringify({ at: new Date().toISOString(), rows: data.buckets.length, file: null }), observed: JSON.stringify(data.observed ?? []), evictedThrough: data.evictedThrough ? String(data.evictedThrough) : null, renamesApplied: data.renamesApplied ? String(data.renamesApplied) : null })
}
