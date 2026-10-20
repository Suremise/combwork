import { readStore, saveStore, saveTable, type StoreName } from '../src/main/storeRows'
import { workspaceDb } from '../src/main/boardStore'
import { addDeliveries, readDeliveries } from '../src/main/schema/storeTables'

/**
 * A store's entries as the workspace database keeps them (#1018), in order: what its file held before. Deliveries are in
 * their own table since 1.0 (#1211), in the order of their seq.
 */
export const storeDocs = <T = Record<string, unknown>>(workspacePath: string, store: StoreName, scope = ''): T[] =>
  store === 'deliveries' ? (readDeliveries(workspaceDb(workspacePath).reader, scope) as T[]) : readStore(workspacePath, store, scope).rows.map((r) => JSON.parse(r.doc) as T)

/** A store's value kept beside its entries (e.g. watches' and deliveries' `invalid`), parsed; undefined when there is none. */
export const storeMeta = <T = unknown>(workspacePath: string, store: StoreName, key: string, scope = ''): T | undefined => {
  const v = readStore(workspacePath, store, scope).meta.get(key)
  return v === undefined ? undefined : (JSON.parse(v) as T)
}

/**
 * Saves a store's entries as Hive would have (a test's stand-in for writing its file by hand before #1018): `key` gives
 * each entry's row key (its id by default), `meta` its values (JSON-encoded here; null removes one).
 */
export async function putStoreDocs(workspacePath: string, store: StoreName, docs: unknown[], o: { scope?: string; meta?: Record<string, unknown>; key?: (doc: unknown, i: number) => string } = {}): Promise<void> {
  const key = o.key ?? ((d: unknown, i: number) => (d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string' ? (d as { id: string }).id : `row-${i}`))
  const meta: Record<string, string | null> = { imported: JSON.stringify({ at: new Date().toISOString(), rows: 0, file: null }) }
  for (const [k, v] of Object.entries(o.meta ?? {})) meta[k] = v === null ? null : JSON.stringify(v)
  if (store === 'deliveries') {
    // Their table (#1211): the host's rows replaced; an entry Hive wouldn't read back goes with those kept aside, as the
    // 1.0 step puts it.
    const scope = o.scope ?? ''
    await saveTable(workspacePath, store, scope, (db) => {
      db.prepare('DELETE FROM deliveries WHERE host = ?').run(scope)
      addDeliveries(db, scope, docs)
    }, meta)
    return
  }
  await saveStore(workspacePath, store, o.scope ?? '', docs.map((d, i) => ({ key: key(d, i), doc: JSON.stringify(d) })), meta)
}

/** The performance metrics as saved (#1019: rows of the workspace database), in the form metrics.json had; null before any save. */
export function metricsSaved(workspacePath: string): { version: 1; buckets: Record<string, unknown>[]; observed: [number, number][]; evictedThrough?: number; renamesApplied?: number } | null {
  const { rows, meta } = readStore(workspacePath, 'metrics')
  if (!meta.has('imported')) return null
  const num = (k: string): number | undefined => (meta.has(k) ? Number(JSON.parse(meta.get(k)!)) : undefined)
  return { version: 1, buckets: rows.map((r) => JSON.parse(r.doc) as Record<string, unknown>), observed: meta.has('observed') ? (JSON.parse(meta.get('observed')!) as [number, number][]) : [], ...(num('evictedThrough') ? { evictedThrough: num('evictedThrough') } : {}), ...(num('renamesApplied') ? { renamesApplied: num('renamesApplied') } : {}) }
}

/** Saves performance metrics as Hive would (a test's stand-in for writing metrics.json by hand), in its form. */
export async function putMetrics(workspacePath: string, data: { buckets: { span: string; start: number }[]; observed?: unknown; evictedThrough?: number; renamesApplied?: number }): Promise<void> {
  const rows = data.buckets.map((b, i) => ({ key: `${b.span}:${b.start}${'#'.repeat(data.buckets.slice(0, i).filter((x) => x.span === b.span && x.start === b.start).length)}`, ord: b.start, doc: JSON.stringify(b) }))
  await saveStore(workspacePath, 'metrics', '', rows, { imported: JSON.stringify({ at: new Date().toISOString(), rows: rows.length, file: null }), observed: JSON.stringify(data.observed ?? []), evictedThrough: data.evictedThrough ? String(data.evictedThrough) : null, renamesApplied: data.renamesApplied ? String(data.renamesApplied) : null })
}
