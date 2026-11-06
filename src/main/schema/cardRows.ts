import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'

/**
 * A card's document as rows of the 1.0 tables (#1208, schema in v1_0.ts), and back, byte for byte: the card JSON
 * contract. `composeCard(decomposeCard(n, doc))` stringifies to exactly `JSON.stringify(doc)` for any document a card's
 * row holds today, so every reader (the Agent API, Export Board, 0.9.3 reading an export) sees the same card.
 *
 * - Each field the board knows goes to its typed column or child table when it has the form Combwork writes; anything else
 *   (a field Combwork doesn't know, or a known one of another type: an older version's, a hand-edited export's) is kept as JSON
 *   in the card's `extra`, and read from there.
 * - The keys' order is Combwork's canonical order (CARD_KEYS) with optional fields present when they have a value; a card
 *   saved in another order or with a field missing keeps its exact key list in `layout` (null for the canonical one).
 *   Cards written by 1.0 are canonical, so `layout` empties as cards are saved.
 * - A list entry (a comment, a history line, a decision, a hold) not of Combwork's form keeps its exact JSON in its row's
 *   `raw`, its typed columns filled where they can be (for queries only).
 * - A string with a lone surrogate (valid in JSON, not in SQLite's UTF-8 text) is never put in a text column: its field
 *   goes to `extra` (a card's) or the entry to `raw`, as JSON, which escapes it.
 *
 * The 1.0 fields the API adds to a card (`key`, `stage`) aren't part of the document: they come from the card's columns
 * and are appended after the document's fields (docs/ARCHITECTURE.md, Storage).
 *
 * It imports nothing at run time: the e2e helpers (tests/e2e/lib.cjs, evidence.cjs) load it with Node as it is.
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

/** A list entry's row: its typed columns (by column name) and its exact JSON when it isn't of Combwork's form. */
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

/** A list entry's form: its fields in Combwork's order, each a text column (`json`: any JSON value, kept as its text). */
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
    { key: 'appText', col: 'app_text', optional: true, json: true },
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
 * A card's keys in Combwork's order, `optional` ones only when they have a value: tasks.ts `clean`'s, with `projectId` beside
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
      if (!f.optional) throw new Error(`${spec.table}: ${f.col} missing in a row of Combwork's form`) // i18n-ignore: a broken row, an internal error
      continue
    }
    out[f.key] = f.json ? JSON.parse(v) : v
  }
  return out
}

/**
 * A field's value as 0.9's REAL index column held it (`json_extract` stored with REAL affinity): a number, a boolean as
 * 1 or 0, a string that is a number literal as that number; null for anything else (the index held text, or nothing).
 */
function asReal(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v)
  return null
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

  // A field set to undefined is no field (JSON.stringify leaves it out, as the document saved before 1.0 did).
  const keys = Object.keys(doc).filter((k) => doc[k] !== undefined)
  for (const k of keys) if (!KNOWN.has(k)) extra[k] = doc[k]
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

  // A review not of Combwork's form (kept in extra) still names its reviewer for queries (cardDocs' reviewers), as clean reads it.
  const reviewer = review?.agent ?? (isObject(doc.review) && isText(doc.review.agent) && doc.review.agent ? doc.review.agent : null)
  const card: CardRow = {
    number: n,
    // What a reader makes of a missing or damaged field (tasks.ts `clean`), so queries see what readers do; the document keeps its own in extra.
    title: title ?? `Task ${n}`, // i18n-ignore: as tasks.ts clean's stand-in title
    description: description ?? '',
    project: project ?? '',
    project_id: projectId ?? null,
    agent: agent || null,
    agent_name: agentName ?? null,
    review_agent: reviewer,
    review_agent_name: review?.agentName ?? null,
    review_since: review?.since ?? null,
    col: column ?? 'todo',
    ord: order ?? asReal(doc.order) ?? n,
    blocked: blocked ?? null,
    // As 0.9's index had it (`json_extract(doc, '$.archived') = 1`: true or 1), so a query picks the cards it picked.
    archived: archived === true || doc.archived === 1 ? 1 : 0,
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
  if (card.extra !== null || !sameKeys(keys, canonicalKeys(rows))) card.layout = JSON.stringify(keys)
  return rows
}

/** The keys a card of Combwork's form has: every required one, and each optional one with a value. */
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

/** A field's value from the card's columns and rows (its form in the document aside: extra and layout are the callers'). */
function columnField(r: CardRows, k: string): unknown {
  const c = r.card
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

/** A card's document from its rows: the inverse of decomposeCard. */
export function composeCard(r: CardRows): Record<string, unknown> {
  const c = r.card
  const extra = c.extra === null ? {} : (JSON.parse(c.extra) as Record<string, unknown>)
  const keys = c.layout === null ? canonicalKeys(r) : (JSON.parse(c.layout) as string[])
  const out: Record<string, unknown> = {}
  // Defined, not assigned, and only the extra's own fields: a key like `__proto__` or `constructor` is a field like any other.
  for (const k of keys) Object.defineProperty(out, k, { value: Object.hasOwn(extra, k) ? extra[k] : columnField(r, k), enumerable: true, writable: true, configurable: true })
  return out
}

/** The list fields a canonical card has only when they aren't empty (CARD_KEYS' optional lists). */
const OPTIONAL_LISTS: Record<string, (r: CardRows) => unknown[]> = { context: (r) => r.context, decisions: (r) => r.decisions, held: (r) => r.holds }

/**
 * One field of a card's document, as composeCard gives it (undefined: the document hasn't it), from rows read with only
 * the parts that field needs (readCardRows' `parts`): what a reader of a few fields of many cards uses, never parsing the rest.
 */
export function cardField(r: CardRows, k: string): unknown {
  const c = r.card
  if (c.layout !== null) {
    if (!(JSON.parse(c.layout) as string[]).includes(k)) return undefined
    if (c.extra !== null) {
      const extra = JSON.parse(c.extra) as Record<string, unknown>
      if (Object.hasOwn(extra, k)) return extra[k]
    }
  } else if (OPTIONAL_LISTS[k] && !OPTIONAL_LISTS[k](r).length) return undefined
  return columnField(r, k)
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
  { spec: COMMENT, part: 'comments', of: (r: CardRows) => r.comments },
  { spec: HISTORY, part: 'history', of: (r: CardRows) => r.history },
  { spec: DECISION, part: 'decisions', of: (r: CardRows) => r.decisions },
  { spec: HOLD, part: 'holds', of: (r: CardRows) => r.holds }
] as const

/** Statements made once per connection (a card's save and read run many times a second in a lane's round). */
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()
function stmt(db: DatabaseSync, sql: string): StatementSync {
  let byDb = statements.get(db)
  if (!byDb) statements.set(db, (byDb = new Map()))
  let s = byDb.get(sql)
  if (!s) byDb.set(sql, (s = db.prepare(sql)))
  return s
}

/**
 * Writes what changed of a card's rows (#1210), given the rows it has (`before`, read in the same transaction; null for a
 * new card): its own row when a column changed (one row, every column); each list and list of entries compared place by
 * place, so an added comment or history line is one insert, an edited one an update in place, and a removed one the
 * places from it on. The rows end as writeCardRows would leave them (the same values at the same places), so the card
 * composes back to the same bytes (the card JSON contract).
 */
export function writeCardChanges(db: DatabaseSync, before: CardRows | null, r: CardRows): void {
  if (!before) return writeCardRows(db, r)
  const n = r.card.number
  if (CARD_COLS.some((c) => before.card[c] !== r.card[c])) stmt(db, `UPDATE cards SET ${CARD_COLS.slice(1).map((c) => `${c} = ?`).join(', ')} WHERE number = ?`).run(...CARD_COLS.slice(1).map((c) => r.card[c] as Sql), n)
  // A list compared place by place: `same` says whether a place holds the same, `set` writes one, `add` one past the end.
  const places = <T>(was: readonly T[], now: readonly T[], same: (a: T, b: T) => boolean, set: (i: number, v: T) => void, add: (i: number, v: T) => void, cutFrom: (i: number) => void): void => {
    for (let i = 0; i < now.length; i++) {
      if (i >= was.length) add(i, now[i])
      else if (!same(was[i], now[i])) set(i, now[i])
    }
    if (was.length > now.length) cutFrom(now.length)
  }
  for (const t of LIST_TABLES) {
    places<string>(
      t.of(before),
      t.of(r),
      (a, b) => a === b,
      (i, v) => stmt(db, `UPDATE ${t.table} SET ${t.col} = ? WHERE card = ? AND ord = ?`).run(v, n, i),
      (i, v) => stmt(db, `INSERT INTO ${t.table} (card, ord, ${t.col}) VALUES (?, ?, ?)`).run(n, i, v),
      (i) => stmt(db, `DELETE FROM ${t.table} WHERE card = ? AND ord >= ?`).run(n, i)
    )
  }
  for (const [kind, of] of [['blockedBy', (x: CardRows) => x.blockedBy], ['link', (x: CardRows) => x.links]] as const) {
    places<number>(
      of(before),
      of(r),
      (a, b) => a === b,
      (i, v) => stmt(db, 'UPDATE card_links SET target = ? WHERE card = ? AND kind = ? AND ord = ?').run(v, n, kind, i),
      (i, v) => stmt(db, 'INSERT INTO card_links (card, kind, ord, target) VALUES (?, ?, ?, ?)').run(n, kind, i, v),
      (i) => stmt(db, 'DELETE FROM card_links WHERE card = ? AND kind = ? AND ord >= ?').run(n, kind, i)
    )
  }
  for (const t of ENTRY_TABLES) {
    const cols = t.spec.fields.map((f) => f.col)
    places<EntryRow>(
      t.of(before),
      t.of(r),
      (a, b) => a.raw === b.raw && cols.every((c) => (a.cols[c] ?? null) === (b.cols[c] ?? null)),
      (i, e) => stmt(db, `UPDATE ${t.spec.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, raw = ? WHERE card = ? AND ord = ?`).run(...cols.map((c) => e.cols[c] ?? null), e.raw, n, i),
      (i, e) => stmt(db, `INSERT INTO ${t.spec.table} (card, ord, ${cols.join(', ')}, raw) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`).run(n, i, ...cols.map((c) => e.cols[c] ?? null), e.raw),
      (i) => stmt(db, `DELETE FROM ${t.spec.table} WHERE card = ? AND ord >= ?`).run(n, i)
    )
  }
}

/** Writes a card's rows, replacing whatever it had (inside the caller's transaction). */
export function writeCardRows(db: DatabaseSync, r: CardRows): void {
  const n = r.card.number
  stmt(db, `INSERT INTO cards (${CARD_COLS.join(', ')}) VALUES (${CARD_COLS.map(() => '?').join(', ')}) ON CONFLICT(number) DO UPDATE SET ${CARD_COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`).run(...CARD_COLS.map((c) => r.card[c] as Sql))
  for (const t of LIST_TABLES) {
    stmt(db, `DELETE FROM ${t.table} WHERE card = ?`).run(n)
    const ins = stmt(db, `INSERT INTO ${t.table} (card, ord, ${t.col}) VALUES (?, ?, ?)`)
    t.of(r).forEach((v, i) => ins.run(n, i, v))
  }
  stmt(db, 'DELETE FROM card_links WHERE card = ?').run(n)
  const link = stmt(db, 'INSERT INTO card_links (card, kind, ord, target) VALUES (?, ?, ?, ?)')
  r.blockedBy.forEach((v, i) => link.run(n, 'blockedBy', i, v))
  r.links.forEach((v, i) => link.run(n, 'link', i, v))
  for (const t of ENTRY_TABLES) {
    const cols = t.spec.fields.map((f) => f.col)
    stmt(db, `DELETE FROM ${t.spec.table} WHERE card = ?`).run(n)
    const ins = stmt(db, `INSERT INTO ${t.spec.table} (card, ord, ${cols.join(', ')}, raw) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`)
    t.of(r).forEach((e, i) => ins.run(n, i, ...cols.map((c) => e.cols[c] ?? null), e.raw))
  }
}

/** A card's child tables, by the CardRows list they fill. */
export type CardPart = 'labels' | 'context' | 'links' | 'comments' | 'history' | 'decisions' | 'holds'
const ALL_PARTS: CardPart[] = ['labels', 'context', 'links', 'comments', 'history', 'decisions', 'holds']

/**
 * Which cards readCardRows reads: these numbers, or those a condition on `cards` picks (SQL of this module's callers,
 * never of user text; its arguments bound), every card when neither; and which of their child tables (all when left out).
 */
export interface CardSelection {
  numbers?: number[]
  where?: string
  args?: Sql[]
  parts?: CardPart[]
  /**
   * Only these of the card's own columns (with its number, archived, extra and layout, which cardField needs), for a reader of a
   * few fields of many cards: the others are left out of the row (never read for a field they hold).
   */
  columns?: (keyof CardRow)[]
}

/** For tests: runs once a read's `cards` rows are read, before their child rows (another connection committing there, #1209 round 1). */
export const cardRowsTestHooks: { afterCards: (() => void) | null } = { afterCards: null }

/**
 * Cards' rows read back, in number order, as the selection asks; the lists of parts left out stay empty. Its statements
 * see one snapshot (HR4's #1209 round 1 finding): in the caller's transaction, else in a read transaction of its own, so
 * another connection committing between the cards and their child rows never gives a card that was never saved.
 */
export function readCardRows(db: DatabaseSync, sel: CardSelection = {}): CardRows[] {
  if (db.isTransaction) return readRows(db, sel)
  db.exec('BEGIN')
  try {
    const out = readRows(db, sel)
    db.exec('COMMIT')
    return out
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  }
}

function readRows(db: DatabaseSync, sel: CardSelection): CardRows[] {
  const parts = new Set(sel.parts ?? ALL_PARTS)
  const where = sel.numbers ? 'number IN (SELECT value FROM json_each(?))' : (sel.where ?? null)
  const args: Sql[] = sel.numbers ? [JSON.stringify(sel.numbers)] : (sel.args ?? [])
  const cardCols = sel.columns ? [...new Set<keyof CardRow>(['number', 'archived', ...sel.columns, 'extra', 'layout'])] : CARD_COLS
  const cards = stmt(db, `SELECT ${cardCols.join(', ')} FROM cards${where ? ` WHERE ${where}` : ''} ORDER BY number`).all(...args) as unknown as CardRow[]
  const byCard = new Map<number, CardRows>()
  for (const card of cards) byCard.set(card.number, { card: { ...card }, labels: [], context: [], blockedBy: [], links: [], comments: [], history: [], decisions: [], holds: [] })
  if (!byCard.size) return []
  cardRowsTestHooks.afterCards?.()
  // One card: by its key. More: the children of the cards the condition picks (every card's when there is none).
  const one = byCard.size === 1 ? [...byCard.keys()][0] : null
  const childWhere = one !== null ? ' WHERE card = ?' : where ? ` WHERE card IN (SELECT number FROM cards WHERE ${where})` : ''
  const childArgs: Sql[] = one !== null ? [one] : args
  for (const t of LIST_TABLES) {
    if (!parts.has(t.table === 'card_labels' ? 'labels' : 'context')) continue
    for (const row of stmt(db, `SELECT card, ${t.col} AS v FROM ${t.table}${childWhere} ORDER BY card, ord`).all(...childArgs) as { card: number; v: string }[]) {
      const r = byCard.get(row.card)
      if (r) t.of(r).push(row.v)
    }
  }
  if (parts.has('links')) {
    for (const row of stmt(db, `SELECT card, kind, target FROM card_links${childWhere} ORDER BY card, kind, ord`).all(...childArgs) as { card: number; kind: string; target: number }[]) {
      const r = byCard.get(row.card)
      if (r) (row.kind === 'blockedBy' ? r.blockedBy : r.links).push(row.target)
    }
  }
  for (const t of ENTRY_TABLES) {
    if (!parts.has(t.part)) continue
    const cols = t.spec.fields.map((f) => f.col)
    for (const row of stmt(db, `SELECT card, ${cols.join(', ')}, raw FROM ${t.spec.table}${childWhere} ORDER BY card, ord`).all(...childArgs) as Record<string, string | number | null>[]) {
      const r = byCard.get(row.card as number)
      if (r) t.of(r).push({ cols: Object.fromEntries(cols.map((c) => [c, row[c] as string | null])), raw: row.raw as string | null })
    }
  }
  return [...byCard.values()]
}
