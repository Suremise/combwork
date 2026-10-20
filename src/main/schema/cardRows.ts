import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

/**
 * A card's document as rows of the 1.0 tables (#1208, schema in v1_0.ts), and back, byte for byte: the card JSON
 * contract. `composeCard(decomposeCard(n, doc))` stringifies to exactly `JSON.stringify(doc)` for any document a card's
 * row holds today, so every reader (the Agent API, Export Board, a 0.9.3 Hive reading an export) sees the same card.
 *
 * - Each field the board knows goes to its typed column or child table when it has the form Hive writes; anything else
 *   (a field Hive doesn't know, or a known one of another type: an older Hive's, a hand-edited export's) is kept as JSON
 *   in the card's `extra`, and read from there.
 * - The keys' order is Hive's canonical order (CARD_KEYS) with optional fields present when they have a value; a card
 *   saved in another order or with a field missing keeps its exact key list in `layout` (null for the canonical one).
 *   Cards written by 1.0 are canonical, so `layout` empties as cards are saved.
 * - A list entry (a comment, a history line, a decision, a hold) not of Hive's form keeps its exact JSON in its row's
 *   `raw`, its typed columns filled where they can be (for queries only).
 * - A string with a lone surrogate (valid in JSON, not in SQLite's UTF-8 text) is never put in a text column: its field
 *   goes to `extra` (a card's) or the entry to `raw`, as JSON, which escapes it.
 *
 * The 1.0 fields the API adds to a card (`key`, `stage`) aren't part of the document: they come from the card's columns
 * and are appended after the document's fields (docs/ARCHITECTURE.md, Storage).
 */

export type Sql = SQLInputValue

/** A card's own row (the `cards` table's columns this module fills; `stage`, `pre_workflow` and the keys step's are the runtime's). */
export interface CardRow {
  number: number
  title: string
  description: string
  project: string
  project_id: string | null
  agent: string | null
  agent_name: string | null
  review_agent: string | null
  review_agent_name: string | null
  review_since: string | null
  col: string
  ord: number
  blocked: string | null
  archived: 0 | 1
  archived_for: string | null
  archived_batch: string | null
  context_problems: string | null
  created_at: string
  created_by: string
  updated_at: string
  extra: string | null
  layout: string | null
}

/** A list entry's row: its typed columns (by column name) and its exact JSON when it isn't of Hive's form. */
export interface EntryRow {
  cols: Record<string, string | null>
  raw: string | null
}

export interface CardRows {
  card: CardRow
  labels: string[]
  context: string[]
  blockedBy: number[]
  links: number[]
  comments: EntryRow[]
  history: EntryRow[]
  decisions: EntryRow[]
  holds: EntryRow[]
}

/** A list entry's form: its fields in Hive's order, each a text column (`json`: any JSON value, kept as its text). */
interface EntrySpec {
  table: string
  fields: { key: string; col: string; optional?: boolean; json?: boolean }[]
}

const COMMENT: EntrySpec = {
  table: 'card_comments',
  fields: [
    { key: 'at', col: 'at' },
    { key: 'by', col: 'by' },
    { key: 'text', col: 'text' },
    { key: 'hiveText', col: 'hive_text', optional: true, json: true },
    { key: 'id', col: 'id', optional: true }
  ]
}
const HISTORY: EntrySpec = {
  table: 'card_history',
  fields: [
    { key: 'at', col: 'at' },
    { key: 'by', col: 'by' },
    { key: 'what', col: 'what' },
    { key: 'whatText', col: 'what_text', optional: true, json: true },
    { key: 'id', col: 'id', optional: true }
  ]
}
const DECISION: EntrySpec = {
  table: 'card_decisions',
  fields: [
    { key: 'id', col: 'id' },
    { key: 'text', col: 'text' },
    { key: 'decidedBy', col: 'decided_by' },
    { key: 'recordedBy', col: 'recorded_by' },
    { key: 'at', col: 'at' },
    { key: 'editedAt', col: 'edited_at', optional: true }
  ]
}
const HOLD: EntrySpec = {
  table: 'card_holds',
  fields: [
    { key: 'agent', col: 'agent', optional: true },
    { key: 'name', col: 'name' },
    { key: 'role', col: 'role' },
    { key: 'from', col: 'from_at' },
    { key: 'to', col: 'to_at', optional: true }
  ]
}
export const ENTRY_SPECS = { comments: COMMENT, history: HISTORY, decisions: DECISION, held: HOLD } as const

/**
 * A card's keys in Hive's order, `optional` ones only when they have a value: tasks.ts `clean`'s, with `projectId` beside
 * `project` (saveCard) and `archivedFor`/`archivedBatch` last, where archiving a card adds them (most saved cards' order).
 */
export const CARD_KEYS: { key: string; optional?: boolean }[] = [
  { key: 'number' },
  { key: 'title' },
  { key: 'description' },
  { key: 'project' },
  { key: 'projectId', optional: true },
  { key: 'agent' },
  { key: 'agentName', optional: true },
  { key: 'review', optional: true },
  { key: 'column' },
  { key: 'order' },
  { key: 'labels' },
  { key: 'context', optional: true },
  { key: 'contextProblems', optional: true },
  { key: 'blocked' },
  { key: 'blockedBy' },
  { key: 'links' },
  { key: 'comments' },
  { key: 'history' },
  { key: 'archived' },
  { key: 'decisions', optional: true },
  { key: 'held', optional: true },
  { key: 'createdAt' },
  { key: 'createdBy' },
  { key: 'updatedAt' },
  { key: 'archivedFor', optional: true },
  { key: 'archivedBatch', optional: true }
]
const KNOWN = new Set(CARD_KEYS.map((k) => k.key))

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** A string a text column keeps exactly. */
const isText = (v: unknown): v is string => typeof v === 'string' && !LONE_SURROGATE.test(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const sameKeys = (a: string[], b: string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i])

function entryRow(spec: EntrySpec, e: unknown): EntryRow {
  const cols: Record<string, string | null> = {}
  for (const f of spec.fields) {
    const v = isObject(e) ? e[f.key] : undefined
    cols[f.col] = v === undefined ? null : f.json ? JSON.stringify(v) : isText(v) ? v : null
  }
  if (!isObject(e)) return { cols, raw: JSON.stringify(e) }
  const want = spec.fields.filter((f) => !f.optional || e[f.key] !== undefined).map((f) => f.key)
  const fits = sameKeys(Object.keys(e), want) && spec.fields.every((f) => e[f.key] === undefined || f.json || isText(e[f.key]))
  return { cols, raw: fits ? null : JSON.stringify(e) }
}

function entryOf(spec: EntrySpec, r: EntryRow): unknown {
  if (r.raw !== null) return JSON.parse(r.raw)
  const out: Record<string, unknown> = {}
  for (const f of spec.fields) {
    const v = r.cols[f.col]
    if (v === null || v === undefined) {
      if (!f.optional) throw new Error(`${spec.table}: ${f.col} missing in a row of Hive's form`) // i18n-ignore: a broken row, an internal error
      continue
    }
    out[f.key] = f.json ? JSON.parse(v) : v
  }
  return out
}

const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)
const intList = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => Number.isSafeInteger(x))
const EPOCH = new Date(0).toISOString()

/** Splits a card's document (the row `n` of today's `cards`) into its 1.0 rows. */
export function decomposeCard(n: number, doc: Record<string, unknown>): CardRows {
  // Without a prototype: a field named `__proto__` is kept as a field (HR4's round 1 finding 3).
  const extra: Record<string, unknown> = Object.create(null)
  /** The field when of the form its column keeps, else undefined (absent) with the field kept in extra. */
  const take = <T>(key: string, ok: (v: unknown) => v is T): T | undefined => {
    const v = doc[key]
    if (v === undefined) return undefined
    if (ok(v)) return v
    extra[key] = v
    return undefined
  }
  const text = (v: unknown): v is string => isText(v)
  const textOrNull = (v: unknown): v is string | null => v === null || isText(v)
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const bool = (v: unknown): v is boolean => typeof v === 'boolean'
  const isNumber = (v: unknown): v is number => v === n
  const isReview = (v: unknown): v is { agent: string; agentName: string; since: string } => isObject(v) && sameKeys(Object.keys(v), ['agent', 'agentName', 'since']) && isText(v.agent) && isText(v.agentName) && isText(v.since)
  const anyJson = (v: unknown): v is unknown => v !== undefined

  for (const k of Object.keys(doc)) if (!KNOWN.has(k)) extra[k] = doc[k]
  take('number', isNumber)
  const title = take('title', text)
  const description = take('description', text)
  const project = take('project', text)
  const projectId = take('projectId', text)
  const agent = take('agent', textOrNull)
  const agentName = take('agentName', text)
  const review = take('review', isReview)
  const column = take('column', text)
  const order = take('order', finite)
  const labels = take('labels', strList)
  const context = take('context', strList)
  const contextProblems = take('contextProblems', anyJson)
  const blocked = take('blocked', textOrNull)
  const blockedBy = take('blockedBy', intList)
  const links = take('links', intList)
  const comments = take('comments', Array.isArray)
  const history = take('history', Array.isArray)
  const archived = take('archived', bool)
  const archivedFor = take('archivedFor', text)
  const archivedBatch = take('archivedBatch', text)
  const decisions = take('decisions', Array.isArray)
  const held = take('held', Array.isArray)
  const createdAt = take('createdAt', text)
  const createdBy = take('createdBy', text)
  const updatedAt = take('updatedAt', text)

  const card: CardRow = {
    number: n,
    // What a reader makes of a missing or damaged field (tasks.ts `clean`), so queries see what readers do; the document keeps its own in extra.
    title: title ?? `Task ${n}`, // i18n-ignore: as tasks.ts clean's stand-in title
    description: description ?? '',
    project: project ?? '',
    project_id: projectId ?? null,
    agent: agent || null,
    agent_name: agentName ?? null,
    review_agent: review?.agent ?? null,
    review_agent_name: review?.agentName ?? null,
    review_since: review?.since ?? null,
    col: column ?? 'todo',
    ord: order ?? n,
    blocked: blocked ?? null,
    archived: archived === true ? 1 : 0,
    archived_for: archivedFor ?? null,
    archived_batch: archivedBatch ?? null,
    context_problems: contextProblems === undefined ? null : JSON.stringify(contextProblems),
    created_at: createdAt ?? EPOCH,
    created_by: createdBy ?? '',
    updated_at: updatedAt ?? EPOCH,
    extra: null,
    layout: null
  }
  // An empty agent is kept as it was ('' is not null to a reader of the document).
  if (agent === '') extra.agent = ''
  const rows: CardRows = {
    card,
    labels: labels ?? [],
    context: context ?? [],
    blockedBy: blockedBy ?? [],
    links: links ?? [],
    comments: (comments ?? []).map((e) => entryRow(COMMENT, e)),
    history: (history ?? []).map((e) => entryRow(HISTORY, e)),
    decisions: (decisions ?? []).map((e) => entryRow(DECISION, e)),
    holds: (held ?? []).map((e) => entryRow(HOLD, e))
  }
  if (Object.keys(extra).length) card.extra = JSON.stringify(extra)
  const keys = Object.keys(doc)
  if (card.extra !== null || !sameKeys(keys, canonicalKeys(rows))) card.layout = JSON.stringify(keys)
  return rows
}

/** The keys a card of Hive's form has: every required one, and each optional one with a value. */
function canonicalKeys(r: CardRows): string[] {
  const c = r.card
  const has: Record<string, boolean> = {
    projectId: c.project_id !== null,
    agentName: c.agent_name !== null,
    review: c.review_agent !== null,
    context: r.context.length > 0,
    contextProblems: c.context_problems !== null,
    archivedFor: c.archived_for !== null,
    archivedBatch: c.archived_batch !== null,
    decisions: r.decisions.length > 0,
    held: r.holds.length > 0
  }
  return CARD_KEYS.filter((k) => !k.optional || has[k.key]).map((k) => k.key)
}

/** A card's document from its rows: the inverse of decomposeCard. */
export function composeCard(r: CardRows): Record<string, unknown> {
  const c = r.card
  const extra = c.extra === null ? {} : (JSON.parse(c.extra) as Record<string, unknown>)
  const keys = c.layout === null ? canonicalKeys(r) : (JSON.parse(c.layout) as string[])
  const field = (k: string): unknown => {
    switch (k) {
      case 'number': return c.number
      case 'title': return c.title
      case 'description': return c.description
      case 'project': return c.project
      case 'projectId': return c.project_id ?? undefined
      case 'agent': return c.agent
      case 'agentName': return c.agent_name ?? undefined
      case 'review': return c.review_agent === null ? undefined : { agent: c.review_agent, agentName: c.review_agent_name, since: c.review_since }
      case 'column': return c.col
      case 'order': return c.ord
      case 'labels': return r.labels
      case 'context': return r.context
      case 'contextProblems': return c.context_problems === null ? undefined : JSON.parse(c.context_problems)
      case 'blocked': return c.blocked
      case 'blockedBy': return r.blockedBy
      case 'links': return r.links
      case 'comments': return r.comments.map((e) => entryOf(COMMENT, e))
      case 'history': return r.history.map((e) => entryOf(HISTORY, e))
      case 'archived': return c.archived === 1
      case 'archivedFor': return c.archived_for ?? undefined
      case 'archivedBatch': return c.archived_batch ?? undefined
      case 'decisions': return r.decisions.map((e) => entryOf(DECISION, e))
      case 'held': return r.holds.map((e) => entryOf(HOLD, e))
      case 'createdAt': return c.created_at
      case 'createdBy': return c.created_by
      case 'updatedAt': return c.updated_at
      default: return undefined
    }
  }
  const out: Record<string, unknown> = {}
  // Defined, not assigned, and only the extra's own fields: a key like `__proto__` or `constructor` is a field like any other.
  for (const k of keys) Object.defineProperty(out, k, { value: Object.hasOwn(extra, k) ? extra[k] : field(k), enumerable: true, writable: true, configurable: true })
  return out
}

// ---------------------------------------------------------------------------
// The rows in the database (the cards step's copy and the readers use these; the tables are v1_0.ts's).
// ---------------------------------------------------------------------------

const CARD_COLS: (keyof CardRow)[] = ['number', 'title', 'description', 'project', 'project_id', 'agent', 'agent_name', 'review_agent', 'review_agent_name', 'review_since', 'col', 'ord', 'blocked', 'archived', 'archived_for', 'archived_batch', 'context_problems', 'created_at', 'created_by', 'updated_at', 'extra', 'layout']
const LIST_TABLES = [
  { table: 'card_labels', col: 'label', of: (r: CardRows) => r.labels },
  { table: 'card_context', col: 'ref', of: (r: CardRows) => r.context }
] as const
const ENTRY_TABLES = [
  { spec: COMMENT, of: (r: CardRows) => r.comments },
  { spec: HISTORY, of: (r: CardRows) => r.history },
  { spec: DECISION, of: (r: CardRows) => r.decisions },
  { spec: HOLD, of: (r: CardRows) => r.holds }
] as const

/** Writes a card's rows, replacing whatever it had (inside the caller's transaction). */
export function writeCardRows(db: DatabaseSync, r: CardRows): void {
  const n = r.card.number
  db.prepare(`INSERT INTO cards (${CARD_COLS.join(', ')}) VALUES (${CARD_COLS.map(() => '?').join(', ')}) ON CONFLICT(number) DO UPDATE SET ${CARD_COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`).run(...CARD_COLS.map((c) => r.card[c] as Sql))
  for (const t of LIST_TABLES) {
    db.prepare(`DELETE FROM ${t.table} WHERE card = ?`).run(n)
    const ins = db.prepare(`INSERT INTO ${t.table} (card, ord, ${t.col}) VALUES (?, ?, ?)`)
    t.of(r).forEach((v, i) => ins.run(n, i, v))
  }
  db.prepare('DELETE FROM card_links WHERE card = ?').run(n)
  const link = db.prepare('INSERT INTO card_links (card, kind, ord, target) VALUES (?, ?, ?, ?)')
  r.blockedBy.forEach((v, i) => link.run(n, 'blockedBy', i, v))
  r.links.forEach((v, i) => link.run(n, 'link', i, v))
  for (const t of ENTRY_TABLES) {
    const cols = t.spec.fields.map((f) => f.col)
    db.prepare(`DELETE FROM ${t.spec.table} WHERE card = ?`).run(n)
    const ins = db.prepare(`INSERT INTO ${t.spec.table} (card, ord, ${cols.join(', ')}, raw) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`)
    t.of(r).forEach((e, i) => ins.run(n, i, ...cols.map((c) => e.cols[c] ?? null), e.raw))
  }
}

/** Cards' rows read back, by number (in number order): every card's when `numbers` is left out. */
export function readCardRows(db: DatabaseSync, numbers?: number[]): CardRows[] {
  const where = numbers ? ' WHERE number IN (SELECT value FROM json_each(?))' : ''
  const args: Sql[] = numbers ? [JSON.stringify(numbers)] : []
  const cards = db.prepare(`SELECT ${CARD_COLS.join(', ')} FROM cards${where} ORDER BY number`).all(...args) as unknown as CardRow[]
  const byCard = new Map<number, CardRows>()
  for (const card of cards) byCard.set(card.number, { card: { ...card }, labels: [], context: [], blockedBy: [], links: [], comments: [], history: [], decisions: [], holds: [] })
  const childWhere = numbers ? ' WHERE card IN (SELECT value FROM json_each(?))' : ''
  for (const t of LIST_TABLES) {
    for (const row of db.prepare(`SELECT card, ${t.col} AS v FROM ${t.table}${childWhere} ORDER BY card, ord`).all(...args) as { card: number; v: string }[]) {
      const r = byCard.get(row.card)
      if (r) t.of(r).push(row.v)
    }
  }
  for (const row of db.prepare(`SELECT card, kind, target FROM card_links${childWhere} ORDER BY card, kind, ord`).all(...args) as { card: number; kind: string; target: number }[]) {
    const r = byCard.get(row.card)
    if (r) (row.kind === 'blockedBy' ? r.blockedBy : r.links).push(row.target)
  }
  for (const t of ENTRY_TABLES) {
    const cols = t.spec.fields.map((f) => f.col)
    for (const row of db.prepare(`SELECT card, ${cols.join(', ')}, raw FROM ${t.spec.table}${childWhere} ORDER BY card, ord`).all(...args) as Record<string, string | number | null>[]) {
      const r = byCard.get(row.card as number)
      if (r) t.of(r).push({ cols: Object.fromEntries(cols.map((c) => [c, row[c] as string | null])), raw: row.raw as string | null })
    }
  }
  return [...byCard.values()]
}
