import type { SQLInputValue } from 'node:sqlite'

/**
 * Session records and deliveries as rows of their 1.0 tables (#1211; the tables are v1_0.ts's "sessions and deliveries
 * in tables"), and back: `fromRow(toRow(x))` equals `x` as JSON (deep equality, the keys in each type's order) for every
 * record Combwork keeps.
 *
 * - A field of the form Combwork writes goes to its column (a boolean as 0/1, an object or list as JSON in a JSON column).
 * - Anything else is kept in the row's `extra` (a JSON object) and read from there: a field Combwork doesn't know (an older
 *   or newer Combwork's), a known one of another type or null where Combwork writes none, and a string with a lone surrogate
 *   (valid in JSON, not in SQLite's UTF-8 text). So nothing a record holds is lost.
 * - A record missing a field its row needs, or with another kind of value there (a delivery whose body has a lone
 *   surrogate, which readDelivery accepts), still has its row: the column takes a fallback and `extra` keeps what it
 *   had (or that it had none), so its totals, lists and inbox still have it. Only one without an id (its key) isn't of
 *   Combwork's form: the caller keeps it aside as it was (the store's `setAside` or deliveries' `invalid`).
 * - `extra` is the record's own keys, whatever they are: an own `__proto__` stays one, and a key starting with `$` is
 *   escaped (one more `$`), so the codec's own `$absent` never meets a record's. An empty list stays an empty list.
 */

type Kind = 'text' | 'int' | 'bool' | 'json'
interface Field {
  /** The record's key. */
  key: string
  /** Its column. */
  col: string
  kind: Kind
  /** The row can't be without it: absent, or not of its kind, the record isn't of Combwork's form. */
  required?: boolean
  /** Required, and null is one of its values (a delivery's `conversation`). */
  nullable?: boolean
  /** An optional boolean Combwork writes only as true (`review?: true`): its column is 0 when it is absent. */
  onlyTrue?: boolean
  /**
   * Required, but a record without it (or with another kind of value) still has a row: its column takes this, and
   * `extra` keeps what the record had (the value, or its absence under ABSENT), so it reads back as it was.
   */
  fallback?: SQLInputValue
}

/**
 * `extra`'s list of the required fields a record didn't have (each given its fallback in its column). A record's own key
 * that starts with `$` is kept in `extra` with one more `$` before it (escaped), so none can be taken for this.
 */
const ABSENT = '$absent'
const escapeKey = (k: string): string => (k.startsWith('$') ? `$${k}` : k)
const unescapeKey = (k: string): string => (k.startsWith('$$') ? k.slice(1) : k)

/** Sets an own property, whatever its name (`__proto__` included: assignment would set the object's prototype). */
function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

export type Row = Record<string, SQLInputValue>

const wellFormed = (s: string): boolean => (s as string & { isWellFormed(): boolean }).isWellFormed()

/** Whether a value can be its column's, as it is. */
function fits(f: Field, v: unknown): boolean {
  if (v === null) return !!f.nullable
  switch (f.kind) {
    case 'text':
      return typeof v === 'string' && wellFormed(v)
    case 'int':
      return typeof v === 'number' && Number.isSafeInteger(v)
    case 'bool':
      return f.onlyTrue ? v === true : typeof v === 'boolean'
    case 'json':
      // As JSON text: a lone surrogate is escaped, so any value JSON keeps fits.
      return v !== undefined
  }
}

const toCol = (f: Field, v: unknown): SQLInputValue => {
  if (v === null) return null
  if (f.kind === 'bool') return v ? 1 : 0
  if (f.kind === 'json') return JSON.stringify(v)
  return v as SQLInputValue
}

const fromCol = (f: Field, c: unknown): unknown => {
  if (c === null || c === undefined) return null
  if (f.kind === 'bool') return c === 1 || c === 1n
  if (f.kind === 'json') return JSON.parse(String(c))
  if (f.kind === 'int') return Number(c)
  return c
}

/**
 * A record's row by its fields, or null when it isn't of Combwork's form (a required field missing or of another kind).
 * `skip`: keys the caller stores itself (a session's cards, its `sub`).
 */
function encode(fields: Field[], rec: Record<string, unknown>, skip: readonly string[] = []): Row | null {
  const row: Row = {}
  const extra: Record<string, unknown> = {}
  const keep = (k: string, v: unknown): void => setOwn(extra, escapeKey(k), v)
  const known = new Set([...fields.map((f) => f.key), ...skip])
  const absent: string[] = []
  for (const f of fields) {
    const v = rec[f.key]
    if (v === undefined) {
      if (f.required && f.fallback === undefined) return null
      if (f.required) {
        row[f.col] = f.fallback!
        absent.push(f.key)
      } else row[f.col] = f.onlyTrue ? 0 : null
    } else if (fits(f, v)) row[f.col] = toCol(f, v)
    else if (f.required && f.fallback === undefined) return null
    else if (f.required) {
      row[f.col] = f.fallback!
      keep(f.key, v)
    } else {
      row[f.col] = f.onlyTrue ? 0 : null
      keep(f.key, v)
    }
  }
  for (const [k, v] of Object.entries(rec)) if (!known.has(k) && v !== undefined) keep(k, v)
  if (absent.length) setOwn(extra, ABSENT, absent)
  row.extra = Object.keys(extra).length ? JSON.stringify(extra) : null
  return row
}

/** A row's record: its fields in their order (an optional one only when its column has a value), then what `extra` keeps. */
function decode(fields: Field[], row: Record<string, unknown>, more?: (out: Record<string, unknown>) => void): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const c = row[f.col]
    if (f.onlyTrue) {
      if (c === 1 || c === 1n) out[f.key] = true
    } else if (c !== null && c !== undefined) out[f.key] = fromCol(f, c)
    else if (f.nullable) out[f.key] = null
  }
  more?.(out)
  if (typeof row.extra === 'string') {
    // JSON.parse makes each key an own property; each is set so here too, never by assignment.
    for (const [k, v] of Object.entries(JSON.parse(row.extra) as Record<string, unknown>)) {
      if (k === ABSENT) {
        if (Array.isArray(v)) for (const a of v as string[]) delete out[a]
      } else setOwn(out, unescapeKey(k), v)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Sessions (SessionRecord, in SessionRecord's order).
// ---------------------------------------------------------------------------

const SESSION: Field[] = [
  { key: 'id', col: 'id', kind: 'text', required: true },
  { key: 'agent', col: 'provider', kind: 'text', required: true, fallback: '' },
  { key: 'name', col: 'name', kind: 'text', required: true, fallback: '' },
  { key: 'createdAt', col: 'created_at', kind: 'text', required: true, fallback: '' },
  { key: 'lastActiveAt', col: 'last_active_at', kind: 'text', required: true, fallback: '' },
  { key: 'archived', col: 'archived', kind: 'bool', required: true, fallback: 0 },
  { key: 'agentId', col: 'agent_id', kind: 'text' },
  { key: 'agentName', col: 'agent_name', kind: 'text' },
  { key: 'cwd', col: 'cwd', kind: 'text' },
  { key: 'branch', col: 'branch', kind: 'text' },
  { key: 'transcriptPath', col: 'transcript_path', kind: 'text' },
  { key: 'handedOverFrom', col: 'handed_over_from', kind: 'text' },
  { key: 'keptUsage', col: 'kept_usage', kind: 'json' },
  { key: 'screenStops', col: 'screen_stops', kind: 'json' },
  { key: 'mode', col: 'mode', kind: 'text' }
]
/** A card a session worked on, in `session_cards`. */
const SESSION_CARD: Field[] = [
  { key: 'number', col: 'card', kind: 'int', required: true },
  { key: 'title', col: 'title', kind: 'text', required: true },
  { key: 'review', col: 'review', kind: 'bool', onlyTrue: true }
]

/** A session record's rows: its own (with `host` and `ord`) and its cards', or null when it isn't of Combwork's form. */
export function sessionToRows(host: string, ord: number, rec: Record<string, unknown>): { row: Row; cards: Row[] } | null {
  // Its cards and its `sub` have columns or a table of their own when they are of Combwork's form; else they stay in `extra`.
  const cards = Array.isArray(rec.cards) ? rec.cards.map((c) => (c && typeof c === 'object' ? encode(SESSION_CARD, c as Record<string, unknown>) : null)) : null
  // A typed list has a card: an empty one is kept as it is in `extra` (no rows would read back as no list).
  const cardsTyped = !!cards && cards.length > 0 && cards.every((c) => c && c.extra === null)
  const sub = rec.sub as { parentId?: unknown; kind?: unknown } | undefined
  const subTyped = !!sub && typeof sub === 'object' && Object.keys(sub).every((k) => k === 'parentId' || k === 'kind') && (sub.parentId === null || (typeof sub.parentId === 'string' && wellFormed(sub.parentId))) && typeof sub.kind === 'string' && wellFormed(sub.kind)
  // Its `lease` is its column's own (#1434: written only by agentFolders.ts, never by a record's save).
  const row = encode(SESSION, rec, ['lease', ...(cardsTyped ? ['cards'] : []), ...(subTyped ? ['sub'] : [])])
  if (!row) return null
  row.host = host
  row.ord = ord
  row.parent_id = subTyped ? (sub!.parentId as string | null) : null
  row.sub_kind = subTyped ? (sub!.kind as string) : null
  // A typed card has no `extra` (cardsTyped): its row is its columns, its session and its place.
  const cardRows = cardsTyped
    ? cards!.map((c, i) => {
        const { extra: _none, ...cols } = c!
        return { ...cols, host, session: rec.id as string, ord: i }
      })
    : []
  return { row, cards: cardRows }
}

/** A session record from its row and its cards' rows (in order). */
export function sessionFromRows(row: Record<string, unknown>, cards: Record<string, unknown>[]): Record<string, unknown> {
  return decode(SESSION, row, (out) => {
    // SessionRecord's order: cards after handedOverFrom… (key order is for reading only: records compare as JSON).
    if (cards.length) out.cards = cards.map((c) => decode(SESSION_CARD, c))
    if (row.sub_kind !== null && row.sub_kind !== undefined) out.sub = { parentId: row.parent_id ?? null, kind: row.sub_kind }
    if (typeof row.lease === 'string') out.lease = row.lease
  })
}

const KEPT: Field[] = [
  { key: 'id', col: 'id', kind: 'text', required: true },
  { key: 'provider', col: 'provider', kind: 'text', required: true, fallback: '' },
  { key: 'agentId', col: 'agent_id', kind: 'text' },
  { key: 'agentName', col: 'agent_name', kind: 'text' },
  { key: 'cwd', col: 'cwd', kind: 'text' },
  { key: 'name', col: 'name', kind: 'text', required: true, fallback: '' },
  { key: 'usage', col: 'usage', kind: 'json', required: true, fallback: 'null' }
]

/** A deleted session's kept usage (KeptUsage) as its row in `sessions_deleted_usage`, or null when it isn't of Combwork's form. */
export function keptUsageToRow(host: string, ord: number, k: Record<string, unknown>): Row | null {
  const row = encode(KEPT, k)
  if (!row) return null
  row.host = host
  row.ord = ord
  return row
}
export const keptUsageFromRow = (row: Record<string, unknown>): Record<string, unknown> => decode(KEPT, row)

// ---------------------------------------------------------------------------
// Deliveries (DeliveryRecord, in its order).
// ---------------------------------------------------------------------------

const DELIVERY: Field[] = [
  { key: 'id', col: 'id', kind: 'text', required: true },
  { key: 'seq', col: 'seq', kind: 'int', required: true, fallback: 0 },
  { key: 'agentId', col: 'agent_id', kind: 'text', required: true, fallback: '' },
  { key: 'agentName', col: 'agent_name', kind: 'text' },
  { key: 'conversation', col: 'conversation', kind: 'text', required: true, nullable: true, fallback: null },
  { key: 'kind', col: 'kind', kind: 'text', required: true, fallback: '' },
  { key: 'from', col: 'sender', kind: 'json', required: true, fallback: 'null' },
  { key: 'card', col: 'card', kind: 'int' },
  { key: 'round', col: 'round', kind: 'int' },
  { key: 'body', col: 'body', kind: 'text', required: true, fallback: '' },
  { key: 'state', col: 'state', kind: 'text', required: true, fallback: '' },
  { key: 'created', col: 'created', kind: 'text', required: true, fallback: '' },
  { key: 'expires', col: 'expires', kind: 'text', required: true, fallback: '' },
  { key: 'offered', col: 'offered', kind: 'text' },
  { key: 'offers', col: 'offers', kind: 'int' },
  { key: 'received', col: 'received', kind: 'text' },
  { key: 'receivedVia', col: 'received_via', kind: 'text' },
  { key: 'offerRun', col: 'offer_run', kind: 'text' },
  { key: 'acked', col: 'acked', kind: 'text' },
  { key: 'ended', col: 'ended', kind: 'text' },
  { key: 'detail', col: 'detail', kind: 'text' },
  { key: 'again', col: 'again', kind: 'text' },
  { key: 'source', col: 'source', kind: 'text' },
  { key: 'ref', col: 'ref', kind: 'text' },
  { key: 'meta', col: 'meta', kind: 'json' },
  { key: 'need', col: 'need', kind: 'text' },
  { key: 'forRun', col: 'for_run', kind: 'text' },
  { key: 'action', col: 'action', kind: 'int' }
]

/** A delivery as its row in `deliveries`, or null when it isn't of Combwork's form. */
export function deliveryToRow(host: string, d: Record<string, unknown>): Row | null {
  const row = encode(DELIVERY, d)
  if (!row) return null
  row.host = host
  return row
}
export const deliveryFromRow = (row: Record<string, unknown>): Record<string, unknown> => decode(DELIVERY, row)

/** The columns of a row, in a fixed order, as text: what a change compares to see whether a row changed. */
export const rowText = (row: Row): string => JSON.stringify(Object.keys(row).sort().map((k) => [k, typeof row[k] === 'bigint' ? String(row[k]) : row[k]]))

/** The field maps (for tests: tests/e2e/sessionDeliveryCodec.cjs, the suites' reader of these tables, must have the same). */
export const STORE_FIELDS = { session: SESSION, sessionCard: SESSION_CARD, kept: KEPT, delivery: DELIVERY, absent: ABSENT }
