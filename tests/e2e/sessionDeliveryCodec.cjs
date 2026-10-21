// The suites' reader and writer of sessions' and deliveries' 1.0 tables (#1211): src/main/schema/sessionDeliveryCodec.ts's field
// maps and its encode/decode, as plain JS (the suites can't import Hive's TypeScript). tests/sessionDeliveryCodecCjs.test.ts holds
// both to the same maps and the same rows, so a column added there fails here until it is added here too.

const ABSENT = '$absent'
const escapeKey = (k) => (k.startsWith('$') ? `$${k}` : k)
const unescapeKey = (k) => (k.startsWith('$$') ? k.slice(1) : k)
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })

const SESSION = [
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
const SESSION_CARD = [
  { key: 'number', col: 'card', kind: 'int', required: true },
  { key: 'title', col: 'title', kind: 'text', required: true },
  { key: 'review', col: 'review', kind: 'bool', onlyTrue: true }
]
const KEPT = [
  { key: 'id', col: 'id', kind: 'text', required: true },
  { key: 'provider', col: 'provider', kind: 'text', required: true, fallback: '' },
  { key: 'agentId', col: 'agent_id', kind: 'text' },
  { key: 'agentName', col: 'agent_name', kind: 'text' },
  { key: 'cwd', col: 'cwd', kind: 'text' },
  { key: 'name', col: 'name', kind: 'text', required: true, fallback: '' },
  { key: 'usage', col: 'usage', kind: 'json', required: true, fallback: 'null' }
]
const DELIVERY = [
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

const wellFormed = (s) => s.isWellFormed()
function fits(f, v) {
  if (v === null) return !!f.nullable
  if (f.kind === 'text') return typeof v === 'string' && wellFormed(v)
  if (f.kind === 'int') return typeof v === 'number' && Number.isSafeInteger(v)
  if (f.kind === 'bool') return f.onlyTrue ? v === true : typeof v === 'boolean'
  return v !== undefined
}
const toCol = (f, v) => (v === null ? null : f.kind === 'bool' ? (v ? 1 : 0) : f.kind === 'json' ? JSON.stringify(v) : v)
const fromCol = (f, c) => (c === null || c === undefined ? null : f.kind === 'bool' ? c === 1 : f.kind === 'json' ? JSON.parse(String(c)) : f.kind === 'int' ? Number(c) : c)

function encode(fields, rec, skip = []) {
  const row = {}
  const extra = {}
  const keep = (k, v) => setOwn(extra, escapeKey(k), v)
  const absent = []
  const known = new Set([...fields.map((f) => f.key), ...skip])
  for (const f of fields) {
    const v = rec[f.key]
    if (v === undefined) {
      if (f.required && f.fallback === undefined) return null
      if (f.required) {
        row[f.col] = f.fallback
        absent.push(f.key)
      } else row[f.col] = f.onlyTrue ? 0 : null
    } else if (fits(f, v)) row[f.col] = toCol(f, v)
    else if (f.required && f.fallback === undefined) return null
    else if (f.required) {
      row[f.col] = f.fallback
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

function decode(fields, row, more) {
  const out = {}
  for (const f of fields) {
    const c = row[f.col]
    if (f.onlyTrue) {
      if (c === 1) out[f.key] = true
    } else if (c !== null && c !== undefined) out[f.key] = fromCol(f, c)
    else if (f.nullable) out[f.key] = null
  }
  if (more) more(out)
  if (typeof row.extra === 'string') {
    for (const [k, v] of Object.entries(JSON.parse(row.extra))) {
      if (k === ABSENT) {
        if (Array.isArray(v)) for (const a of v) delete out[a]
      } else setOwn(out, unescapeKey(k), v)
    }
  }
  return out
}

/** A session record's row and its cards' rows, or null when it has no id. */
function sessionToRows(host, ord, rec) {
  const cards = Array.isArray(rec.cards) ? rec.cards.map((c) => (c && typeof c === 'object' ? encode(SESSION_CARD, c) : null)) : null
  const cardsTyped = !!cards && cards.length > 0 && cards.every((c) => c && c.extra === null)
  const sub = rec.sub
  const subTyped = !!sub && typeof sub === 'object' && Object.keys(sub).every((k) => k === 'parentId' || k === 'kind') && (sub.parentId === null || (typeof sub.parentId === 'string' && wellFormed(sub.parentId))) && typeof sub.kind === 'string' && wellFormed(sub.kind)
  const row = encode(SESSION, rec, [...(cardsTyped ? ['cards'] : []), ...(subTyped ? ['sub'] : [])])
  if (!row) return null
  row.host = host
  row.ord = ord
  row.parent_id = subTyped ? sub.parentId : null
  row.sub_kind = subTyped ? sub.kind : null
  const cardRows = cardsTyped
    ? cards.map((c, i) => {
        const { extra: _none, ...cols } = c
        return { ...cols, host, session: rec.id, ord: i }
      })
    : []
  return { row, cards: cardRows }
}

function sessionFromRows(row, cards) {
  return decode(SESSION, row, (out) => {
    if (cards.length) out.cards = cards.map((c) => decode(SESSION_CARD, c))
    if (row.sub_kind !== null && row.sub_kind !== undefined) out.sub = { parentId: row.parent_id ?? null, kind: row.sub_kind }
  })
}

function keptUsageToRow(host, ord, k) {
  const row = encode(KEPT, k)
  if (!row) return null
  row.host = host
  row.ord = ord
  return row
}
const keptUsageFromRow = (row) => decode(KEPT, row)

function deliveryToRow(host, d) {
  const row = encode(DELIVERY, d)
  if (!row) return null
  row.host = host
  return row
}
const deliveryFromRow = (row) => decode(DELIVERY, row)

/** Inserts a row (its columns given) into a table. */
function insert(db, table, row) {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined)
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]))
}

const STORE_FIELDS = { session: SESSION, sessionCard: SESSION_CARD, kept: KEPT, delivery: DELIVERY, absent: ABSENT }

module.exports = { STORE_FIELDS, sessionToRows, sessionFromRows, keptUsageToRow, keptUsageFromRow, deliveryToRow, deliveryFromRow, insert }
