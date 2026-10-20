import { readStore, saveStore, type StoreName } from '../src/main/storeRows'
import { readTable, saveTable } from '../src/main/storeTables'
import type { TableStore } from '../src/main/schema/storeCodec'

/** Any store: lanes, watches and metrics are in their typed tables (#1212, storeTables.ts), the others in `store_rows` still. */
type AnyStore = StoreName | TableStore
const inTables = (store: AnyStore): store is TableStore => store === 'lanes' || store === 'watches' || store === 'metrics'

/** A store's entries as the workspace database keeps them (#1018, #1212), in order: what its file held before. */
export const storeDocs = <T = Record<string, unknown>>(workspacePath: string, store: AnyStore, scope = ''): T[] =>
  inTables(store) ? (readTable(workspacePath, store).docs as T[]) : readStore(workspacePath, store, scope).rows.map((r) => JSON.parse(r.doc) as T)

/** A store's value kept beside its entries (e.g. watches' and deliveries' `invalid`), parsed; undefined when there is none. */
export const storeMeta = <T = unknown>(workspacePath: string, store: AnyStore, key: string, scope = ''): T | undefined => {
  const v = (inTables(store) ? readTable(workspacePath, store) : readStore(workspacePath, store, scope)).meta.get(key)
  return v === undefined ? undefined : (JSON.parse(v) as T)
}

/**
 * Saves a store's entries as Hive would have (a test's stand-in for writing its file by hand before #1018): `key` gives
 * each entry's row key (its id by default; lanes, watches and metrics take theirs from the entry), `meta` its values
 * (JSON-encoded here; null removes one).
 */
export async function putStoreDocs(workspacePath: string, store: AnyStore, docs: unknown[], o: { scope?: string; meta?: Record<string, unknown>; key?: (doc: unknown, i: number) => string } = {}): Promise<void> {
  const key = o.key ?? ((d: unknown, i: number) => (d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string' ? (d as { id: string }).id : `row-${i}`))
  const meta: Record<string, string | null> = { imported: JSON.stringify({ at: new Date().toISOString(), rows: 0, file: null }) }
  for (const [k, v] of Object.entries(o.meta ?? {})) meta[k] = v === null ? null : JSON.stringify(v)
  if (inTables(store)) return saveTable(workspacePath, store, docs, meta)
  await saveStore(workspacePath, store, o.scope ?? '', docs.map((d, i) => ({ key: key(d, i), doc: JSON.stringify(d) })), meta)
}

/** The performance metrics as saved (#1019, #1212: their tables in the workspace database), in the form metrics.json had; null before any save. */
export function metricsSaved(workspacePath: string): { version: 1; buckets: Record<string, unknown>[]; observed: [number, number][]; evictedThrough?: number; renamesApplied?: number } | null {
  const { docs, meta } = readTable(workspacePath, 'metrics')
  if (!meta.has('imported')) return null
  const num = (k: string): number | undefined => (meta.has(k) ? Number(JSON.parse(meta.get(k)!)) : undefined)
  // As plain JSON (the tables give a bucket's maps without a prototype, as the store makes them).
  return { version: 1, buckets: JSON.parse(JSON.stringify(docs)) as Record<string, unknown>[], observed: meta.has('observed') ? (JSON.parse(meta.get('observed')!) as [number, number][]) : [], ...(num('evictedThrough') ? { evictedThrough: num('evictedThrough') } : {}), ...(num('renamesApplied') ? { renamesApplied: num('renamesApplied') } : {}) }
}

/** Saves performance metrics as Hive would (a test's stand-in for writing metrics.json by hand), in its form. */
export async function putMetrics(workspacePath: string, data: { buckets: { span: string; start: number }[]; observed?: unknown; evictedThrough?: number; renamesApplied?: number }): Promise<void> {
  await saveTable(workspacePath, 'metrics', data.buckets, { imported: JSON.stringify({ at: new Date().toISOString(), rows: data.buckets.length, file: null }), observed: JSON.stringify(data.observed ?? []), evictedThrough: data.evictedThrough ? String(data.evictedThrough) : null, renamesApplied: data.renamesApplied ? String(data.renamesApplied) : null })
}
