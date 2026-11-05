import type { DatabaseSync } from 'node:sqlite'
import { V1_0_STEPS } from './v1_0'

/**
 * Lanes, watches and metrics as rows of combwork.db's typed tables (#1212, #1025's extended scope; the tables are #1208's, in
 * v1_0.ts): each store's entry, the JSON object its module keeps in memory, becomes a main row and its child rows, and
 * reads back as the same object. No database work of its own beyond the rows it is given, so the 1.0 step (`moveStores`)
 * and the stores' reads and saves (storeTables.ts) use exactly the same mapping.
 *
 * Exactness: an entry is written in columns only if it reads back equal as JSON (`canonical`); one that wouldn't (a field
 * of a type its column can't hold, a value missing, one the store has never written) is kept whole in `extra` as a JSON
 * array of one, `[<the entry>]`, its columns holding what they can, so nothing an entry says is lost or changed. Fields
 * this build has no column for go in `extra` too, as an object (never an array, so the two can't be confused, whatever
 * the fields are called), and win on read. An entry no row can hold at all (two metrics buckets of one
 * hour) is kept aside in `board_meta` as `<store>.unmapped` (watches: with their entries that aren't valid, `invalid`).
 */

export type TableStore = 'lanes' | 'watches' | 'metrics'
export const TABLE_STORES: readonly TableStore[] = ['lanes', 'watches', 'metrics']

type Value = string | number | null
type Row = Record<string, Value>

/** An entry's rows: its main row, and its rows in each child table. */
export interface Encoded {
  main: Row
  children: Record<string, Row[]>
}

/** An entry's value doesn't fit its column (it is kept whole in `extra` instead). */
class Unfit extends Error {}

const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new Unfit()
  return v
}
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v))
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Unfit()
  return v
}
const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : int(v))
/** A value kept as JSON text (null: absent; a JSON `null` is the text "null"). */
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v))
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Unfit()
  return v as Record<string, unknown>
}
/** The fields of `v` not in `known`, as `extra`'s JSON (null when there are none). */
function extraOf(v: Record<string, unknown>, known: ReadonlySet<string>): string | null {
  const rest: Record<string, unknown> = {}
  let any = false
  for (const k of Object.keys(v)) {
    if (known.has(k)) continue
    Object.defineProperty(rest, k, { value: v[k], enumerable: true, writable: true, configurable: true })
    any = true
  }
  return any ? JSON.stringify(rest) : null
}
/** `extra`'s fields to add, read back (an object; the array of an entry kept whole is read by entryOfRows). */
function parseExtra(text: Value): Record<string, unknown> {
  const v: unknown = typeof text === 'string' ? JSON.parse(text) : null
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
const parseJson = (text: Value): unknown => (typeof text === 'string' ? JSON.parse(text) : undefined)
/** Adds `extra`'s fields to an entry read back (own properties, whatever their names). */
function withExtra<T extends object>(o: T, extra: Record<string, unknown>): T {
  for (const k of Object.keys(extra)) Object.defineProperty(o, k, { value: extra[k], enumerable: true, writable: true, configurable: true })
  return o
}
/** A dictionary with no prototype (a key named `__proto__` or `constructor` is just a key), as the stores make them. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

/**
 * A value as JSON with every object's keys in order: two entries are equal as JSON when these are equal (the order an
 * object's keys were written in isn't part of it).
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

/** A child table: its columns (those referencing the main row first), and the order its rows read back in. */
interface Child {
  table: string
  cols: string[]
  /** Columns that point at the main row's key. */
  parent: string[]
  order: string
  /** Rows made from the entry only to be queried (watch_cards): not read back. */
  derived?: boolean
  /** Made by a later step of the 1.0 group (a lane's run, #1291): a file before that step has none to read. */
  later?: boolean
}

export interface TableDef {
  store: TableStore
  main: string
  /** The main row's key columns, and the order rows read back in. */
  key: string[]
  order: string
  cols: string[]
  children: Child[]
  /** The entry's rows: may throw Unfit (then it is kept whole). `key` is its row key (rowKeys), `ord` its place. */
  encode: (doc: unknown, key: string, ord: number) => Encoded
  /** The main row's columns when the entry is kept whole: what can be read of it, else values its columns accept. */
  whole: (doc: unknown, key: string, ord: number) => Row
  decode: (main: Row, children: Record<string, Row[]>) => unknown
  /** An entry's row key in memory (lanes and watches: their id, made unique; metrics: span and start). */
  keyOf: (main: Row) => string
  /**
   * Child rows with no foreign key to the main row, removed whenever the entry's rows are (it leaves the store, or is
   * written again): a lane's run (#1291, #1270), which the runtime writes beside lanes.ts.
   */
  onRemove?: (db: DatabaseSync, key: string) => void
  /** Others write the store's rows too (the runtime, a lane's cards and state): a save compares with the table, never its own last save. */
  shared?: boolean
}

const LANE_KNOWN = new Set(['id', 'project', 'projectId', 'name', 'builder', 'reviewer', 'cards', 'rounds', 'waitMinutes', 'state', 'startedBy', 'startedAt', 'updatedAt', 'endedAt', 'mergeCommit', 'frozen', 'ruleset', 'pending', 'inFlight'])
const LANE_STATES = new Set(['active', 'ended', 'abandoned'])

/** A lane's run as LaneRecord's fields: each only when set (an entry reads back as it was written). */
function runOf(run: Row | undefined, pending: Row[]): Record<string, unknown> {
  if (!run) return {}
  return { ...(run.ruleset !== null ? { ruleset: run.ruleset } : {}), ...(run.has_pending ? { pending: pending.map((r) => r.card) } : {}), ...(run.current_card !== null ? { inFlight: run.current_card } : {}) }
}

const LANES: TableDef = {
  store: 'lanes',
  main: 'lanes',
  key: ['id'],
  order: 'ord, id',
  cols: ['id', 'ord', 'project', 'project_id', 'name', 'builder_id', 'builder_name', 'reviewer_id', 'reviewer_name', 'rounds', 'wait_minutes', 'state', 'started_by', 'started_at', 'updated_at', 'ended_at', 'merge_commit', 'extra'],
  children: [
    { table: 'lane_cards', cols: ['lane', 'ord', 'card'], parent: ['lane'], order: 'ord' },
    { table: 'lane_frozen', cols: ['lane', 'ord', 'card', 'title', 'col', 'blocked', 'round', 'reviewing'], parent: ['lane'], order: 'ord' },
    // Its run (#1270: Hive owns the lane): the ruleset it started with, the card in flight, a list change queued.
    { table: 'lane_runs', cols: ['lane', 'ruleset', 'current_card', 'has_pending'], parent: ['lane'], order: 'lane', later: true },
    { table: 'lane_pending', cols: ['lane', 'ord', 'card'], parent: ['lane'], order: 'ord', later: true }
  ],
  encode: (doc, key, ord) => {
    const l = obj(doc)
    const builder = obj(l.builder)
    const reviewer = l.reviewer === null ? null : obj(l.reviewer)
    const state = str(l.state)
    if (!LANE_STATES.has(state) || !Array.isArray(l.cards) || (l.frozen !== undefined && !Array.isArray(l.frozen)) || (l.pending !== undefined && !Array.isArray(l.pending))) throw new Unfit()
    const run = l.ruleset !== undefined || l.pending !== undefined || l.inFlight !== undefined
    return {
      main: {
        id: key,
        ord,
        project: str(l.project),
        project_id: strOrNull(l.projectId),
        name: strOrNull(l.name),
        builder_id: str(builder.id),
        builder_name: str(builder.name),
        reviewer_id: reviewer ? str(reviewer.id) : null,
        reviewer_name: reviewer ? str(reviewer.name) : null,
        rounds: int(l.rounds),
        wait_minutes: int(l.waitMinutes),
        state,
        started_by: str(l.startedBy),
        started_at: str(l.startedAt),
        updated_at: str(l.updatedAt),
        ended_at: strOrNull(l.endedAt),
        merge_commit: strOrNull(l.mergeCommit),
        extra: extraOf(l, LANE_KNOWN)
      },
      children: {
        lane_cards: (l.cards as unknown[]).map((card, i) => ({ lane: key, ord: i, card: int(card) })),
        lane_frozen: ((l.frozen as unknown[] | undefined) ?? []).map((v, i) => {
          const c = obj(v)
          if (typeof c.reviewing !== 'boolean') throw new Unfit()
          return { lane: key, ord: i, card: int(c.number), title: str(c.title), col: str(c.column), blocked: strOrNull(c.blocked), round: int(c.round), reviewing: c.reviewing ? 1 : 0 }
        }),
        lane_runs: run ? [{ lane: key, ruleset: l.ruleset === undefined ? null : str(l.ruleset), current_card: l.inFlight === undefined ? null : int(l.inFlight), has_pending: l.pending === undefined ? 0 : 1 }] : [],
        lane_pending: ((l.pending as unknown[] | undefined) ?? []).map((card, i) => ({ lane: key, ord: i, card: int(card) }))
      }
    }
  },
  whole: (doc, key, ord) => {
    const l = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
    const t = (v: unknown): string => (typeof v === 'string' ? v : '')
    return { id: key, ord, project: t(l.project), project_id: null, name: null, builder_id: '', builder_name: '', reviewer_id: null, reviewer_name: null, rounds: 0, wait_minutes: 0, state: 'abandoned', started_by: '', started_at: '', updated_at: '', ended_at: null, merge_commit: null }
  },
  decode: (m, c) => {
    const frozen = c.lane_frozen ?? []
    const lane = {
      id: m.id,
      project: m.project,
      ...(m.project_id !== null ? { projectId: m.project_id } : {}),
      name: m.name,
      builder: { id: m.builder_id, name: m.builder_name },
      reviewer: m.reviewer_id === null ? null : { id: m.reviewer_id, name: m.reviewer_name },
      cards: (c.lane_cards ?? []).map((r) => r.card),
      rounds: m.rounds,
      waitMinutes: m.wait_minutes,
      state: m.state,
      startedBy: m.started_by,
      startedAt: m.started_at,
      updatedAt: m.updated_at,
      endedAt: m.ended_at,
      mergeCommit: m.merge_commit,
      ...(frozen.length ? { frozen: frozen.map((r) => ({ number: r.card, title: r.title, column: r.col, blocked: r.blocked, round: r.round, reviewing: r.reviewing === 1 })) } : {}),
      ...runOf(c.lane_runs?.[0], c.lane_pending ?? [])
    }
    return withExtra(lane, parseExtra(m.extra))
  },
  keyOf: (m) => String(m.id),
  onRemove: (db, key) => {
    db.prepare('DELETE FROM lane_runs WHERE lane = ?').run(key) // i18n-ignore: SQL
    db.prepare('DELETE FROM lane_pending WHERE lane = ?').run(key) // i18n-ignore: SQL
  },
  shared: true
}

/** A watch's fields kept as JSON (its own view of what it watches, never queried across watches), by column. */
const WATCH_JSON: [string, string][] = [
  ['cond', 'cond'],
  ['marks', 'marks'],
  ['agents', 'agents'],
  ['agentMarks', 'agent_marks'],
  ['lanes', 'lanes'],
  ['laneMarks', 'lane_marks'],
  ['seen', 'seen'],
  ['on', 'on_cards'],
  ['released', 'released'],
  ['fired', 'fired']
]
const WATCH_KNOWN = new Set(['id', 'projectPath', 'projectId', 'agentId', 'watcherName', 'since', 'limitMinutes', 'limitAt', 'waitSeq', 'laneSince', 'self', 'replySeq', ...WATCH_JSON.map(([k]) => k)])

const WATCHES: TableDef = {
  store: 'watches',
  main: 'watches',
  key: ['id'],
  order: 'ord, id',
  cols: ['id', 'ord', 'project_path', 'project_id', 'agent_id', 'watcher_name', 'since', 'limit_minutes', 'limit_at', 'wait_seq', 'lane_since', 'self', 'reply_seq', 'cond', 'marks', 'agents', 'agent_marks', 'lanes', 'lane_marks', 'seen', 'on_cards', 'released', 'fired', 'fired_delivery', 'extra'],
  children: [{ table: 'watch_cards', cols: ['watch', 'card'], parent: ['watch'], order: 'card', derived: true }],
  encode: (doc, key, ord) => {
    const w = obj(doc)
    if (w.cond === undefined || w.marks === undefined) throw new Unfit()
    const fired = w.fired && typeof w.fired === 'object' ? (w.fired as { delivery?: unknown }) : null
    const main: Row = {
      id: key,
      ord,
      project_path: str(w.projectPath),
      project_id: strOrNull(w.projectId),
      agent_id: str(w.agentId),
      watcher_name: strOrNull(w.watcherName),
      since: str(w.since),
      limit_minutes: int(w.limitMinutes),
      limit_at: str(w.limitAt),
      wait_seq: intOrNull(w.waitSeq),
      lane_since: strOrNull(w.laneSince),
      self: strOrNull(w.self),
      reply_seq: intOrNull(w.replySeq),
      fired_delivery: typeof fired?.delivery === 'string' ? fired.delivery : null,
      extra: extraOf(w, WATCH_KNOWN)
    }
    for (const [field, col] of WATCH_JSON) main[col] = json(w[field])
    // The cards it watches, to find a card's watches: an index of `cond`, which keeps them.
    const cards = Array.isArray((w.cond as { cards?: unknown } | null)?.cards) ? ((w.cond as { cards: unknown[] }).cards as unknown[]) : []
    const ids = [...new Set(cards.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n)))]
    return { main, children: { watch_cards: ids.map((card) => ({ watch: key, card })) } }
  },
  whole: (doc, key, ord) => {
    const w = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
    // Its own folder and agent where it has them (one watch per agent: a second kept whole is refused as the first is),
    // else values no watch can have.
    const t = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)
    return { id: key, ord, project_path: t(w.projectPath, `\0${key}`), project_id: null, agent_id: t(w.agentId, `\0${key}`), watcher_name: null, since: '', limit_minutes: 0, limit_at: '', wait_seq: null, lane_since: null, self: null, reply_seq: null, cond: 'null', marks: 'null', agents: null, agent_marks: null, lanes: null, lane_marks: null, seen: null, on_cards: null, released: null, fired: null, fired_delivery: null }
  },
  decode: (m) => {
    const watch: Record<string, unknown> = { id: m.id, projectPath: m.project_path }
    if (m.project_id !== null) watch.projectId = m.project_id
    watch.agentId = m.agent_id
    for (const [field, col] of WATCH_JSON) if (m[col] !== null) watch[field] = parseJson(m[col])
    const opt: [string, Value][] = [
      ['since', m.since],
      ['limitMinutes', m.limit_minutes],
      ['limitAt', m.limit_at],
      ['waitSeq', m.wait_seq],
      ['laneSince', m.lane_since],
      ['self', m.self],
      ['replySeq', m.reply_seq],
      ['watcherName', m.watcher_name]
    ]
    for (const [k, v] of opt) if (v !== null) watch[k] = v
    return withExtra(watch, parseExtra(m.extra))
  },
  keyOf: (m) => String(m.id)
}

const FAMILIES = ['api', 'mcp', 'guidance', 'catalog'] as const
const BUCKET_KNOWN = new Set(['start', 'span', 'projects', 'workspace', 'skills', 'dropped', 'droppedBy', 'series'])
const PART_KNOWN = new Set<string>(FAMILIES)

const METRICS: TableDef = {
  store: 'metrics',
  main: 'metrics_buckets',
  key: ['span', 'start'],
  order: 'start, span',
  cols: ['span', 'start', 'dropped', 'dropped_by', 'series', 'skills', 'extra'],
  children: [{ table: 'metrics_series', cols: ['span', 'start', 'part', 'family', 'key', 'data'], parent: ['span', 'start'], order: 'part, family, key' }],
  encode: (doc) => {
    const b = obj(doc)
    const span = str(b.span)
    if (span !== 'hour' && span !== 'day') throw new Unfit()
    const start = int(b.start)
    const series: Row[] = []
    const part = (name: string, p: unknown): void => {
      const families = obj(p)
      // A family Hive doesn't know (or a part with fields of its own) has no rows to go in: kept whole.
      if (Object.keys(families).some((k) => !PART_KNOWN.has(k))) throw new Unfit()
      for (const family of FAMILIES) {
        const f = obj(families[family])
        for (const key of Object.keys(f)) series.push({ span, start, part: name, family, key, data: JSON.stringify(f[key]) })
      }
    }
    part('', b.workspace)
    const projects = obj(b.projects)
    for (const name of Object.keys(projects)) {
      // '' is the workspace's own part: a project can't have it.
      if (name === '') throw new Unfit()
      part(name, projects[name])
    }
    return { main: { span, start, dropped: int(b.dropped), dropped_by: JSON.stringify(obj(b.droppedBy)), series: int(b.series), skills: JSON.stringify(obj(b.skills)), extra: extraOf(b, BUCKET_KNOWN) }, children: { metrics_series: series } }
  },
  whole: (doc) => {
    const b = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
    return { span: b.span === 'day' ? 'day' : 'hour', start: typeof b.start === 'number' && Number.isSafeInteger(b.start) ? b.start : 0, dropped: 0, dropped_by: '{}', series: 0, skills: '{}' }
  },
  decode: (m, c) => {
    const part = (): Record<string, Record<string, unknown>> => {
      const p = dict<Record<string, unknown>>()
      for (const f of FAMILIES) p[f] = dict<unknown>()
      return p
    }
    const workspace = part()
    const projects = dict<Record<string, Record<string, unknown>>>()
    for (const r of c.metrics_series ?? []) {
      const name = String(r.part)
      const target = name === '' ? workspace : (projects[name] ??= part())
      target[String(r.family)][String(r.key)] = JSON.parse(String(r.data))
    }
    const bucket = { start: m.start, span: m.span, projects, workspace, skills: JSON.parse(String(m.skills)), dropped: m.dropped, droppedBy: JSON.parse(String(m.dropped_by)), series: m.series }
    return withExtra(bucket, parseExtra(m.extra))
  },
  keyOf: (m) => `${m.span}:${m.start}`
}

export const TABLE_DEFS: Record<TableStore, TableDef> = { lanes: LANES, watches: WATCHES, metrics: METRICS }

/**
 * The rows an entry is written as: in columns when it reads back equal as JSON (through entryOfRows, as a read does), else
 * kept whole in `extra` (`[<the entry>]`).
 */
export function rowsOfEntry(def: TableDef, doc: unknown, key: string, ord: number): Encoded {
  try {
    const e = def.encode(doc, key, ord)
    // Read back through JSON, as the database gives the rows (a column's text, not the object written).
    const back = entryOfRows(def, JSON.parse(JSON.stringify(e.main)) as Row, JSON.parse(JSON.stringify(e.children)) as Record<string, Row[]>)
    if (canonical(back) === canonical(doc)) return e
  } catch (e) {
    if (!(e instanceof Unfit)) throw e
  }
  const main = def.whole(doc, key, ord)
  main.extra = JSON.stringify([doc])
  return { main, children: {} }
}

/** An entry read back from its rows: the one kept whole (`extra` an array of one), or the one its columns hold. */
export function entryOfRows(def: TableDef, main: Row, children: Record<string, Row[]>): unknown {
  const extra: unknown = typeof main.extra === 'string' ? JSON.parse(main.extra) : null
  return Array.isArray(extra) ? extra[0] : def.decode(main, children)
}

/**
 * Row keys for a store's entries, one each and never the same twice (as #1018's store rows had): an entry's own id where
 * it has one not taken yet, else `#<its place>` (made unique too). A metrics bucket's is its span and start.
 */
export function entryKeys(store: TableStore, entries: readonly unknown[]): string[] {
  const used = new Set<string>()
  return entries.map((e, i) => {
    const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : {}
    const own = store === 'metrics' ? `${String(o.span)}:${String(o.start)}` : typeof o.id === 'string' ? o.id : ''
    let key = own && !used.has(own) ? own : `#${i}`
    while (used.has(key)) key += '#'
    used.add(key)
    return key
  })
}

/** A store's entries as its tables hold them, in order, each with its row key. */
export function readEntries(db: DatabaseSync, store: TableStore): { key: string; doc: unknown }[] {
  const def = TABLE_DEFS[store]
  const mains = db.prepare(`SELECT ${def.cols.join(', ')} FROM ${def.main} ORDER BY ${def.order}`).all() as Row[] // i18n-ignore: SQL
  const kids = new Map<string, Record<string, Row[]>>()
  for (const child of def.children) {
    if (child.derived) continue
    if (child.later && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(child.table)) continue // i18n-ignore: SQL
    const rows = db.prepare(`SELECT ${child.cols.join(', ')} FROM ${child.table} ORDER BY ${child.parent.join(', ')}, ${child.order}`).all() as Row[] // i18n-ignore: SQL
    for (const r of rows) {
      const k = child.parent.map((c) => String(r[c])).join('\0')
      let m = kids.get(k)
      if (!m) kids.set(k, (m = {}))
      ;(m[child.table] ??= []).push(r)
    }
  }
  return mains.map((m) => ({ key: def.keyOf(m), doc: entryOfRows(def, m, kids.get(def.key.map((c) => String(m[c])).join('\0')) ?? {}) }))
}

/** Writes an entry's rows (its main row, then its children): throws when a row can't go in (a key taken). */
export function insertEntry(db: DatabaseSync, def: TableDef, e: Encoded): void {
  const cols = def.cols.filter((c) => c in e.main)
  db.prepare(`INSERT INTO ${def.main} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => e.main[c] ?? null)) // i18n-ignore: SQL
  for (const child of def.children) {
    const rows = e.children[child.table] ?? []
    if (!rows.length) continue
    const put = db.prepare(`INSERT ${child.derived ? 'OR IGNORE ' : ''}INTO ${child.table} (${child.cols.join(', ')}) VALUES (${child.cols.map(() => '?').join(', ')})`) // i18n-ignore: SQL
    for (const r of rows) put.run(...child.cols.map((c) => r[c] ?? null))
  }
}

/** Removes an entry by its main row's key values (its children go with it: ON DELETE CASCADE). */
export function deleteEntry(db: DatabaseSync, def: TableDef, main: Row): void {
  db.prepare(`DELETE FROM ${def.main} WHERE ${def.key.map((c) => `${c} = ?`).join(' AND ')}`).run(...def.key.map((c) => main[c] ?? null)) // i18n-ignore: SQL
}

/** Board_meta's key for one of a store's values (`lanes.imported`, `metrics.observed`). */
export const metaKey = (store: TableStore, key: string): string => `${store}.${key}`

/** A store's values from board_meta (`<store>.<key>`), by their own key. */
export function readMeta(db: DatabaseSync, store: TableStore): Map<string, string> {
  const rows = db.prepare('SELECT key, value FROM board_meta WHERE key LIKE ? ESCAPE ?').all(`${store}.%`, '\\') as { key: string; value: string }[] // i18n-ignore: SQL
  return new Map(rows.map((r) => [r.key.slice(store.length + 1), r.value]))
}

/** Sets (or, with null, removes) one of a store's values in board_meta. */
export function setMeta(db: DatabaseSync, store: TableStore, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM board_meta WHERE key = ?').run(metaKey(store, key)) // i18n-ignore: SQL
  else db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(metaKey(store, key), value) // i18n-ignore: SQL
}

/**
 * Entries no row can hold (a key taken: two buckets of one hour, two watches of one agent), added to what the store
 * already keeps aside: watches with their entries that aren't valid (`invalid`), the others as `unmapped`.
 */
export function keepAside(db: DatabaseSync, store: TableStore, docs: unknown[]): void {
  if (!docs.length) return
  const key = store === 'watches' ? 'invalid' : 'unmapped'
  const had = readMeta(db, store).get(key)
  setMeta(db, store, key, JSON.stringify([...(had ? (JSON.parse(had) as unknown[]) : []), ...docs]))
}

/**
 * Writes a store's entries into its (empty) tables, in order, keeping aside those no row can hold. Used by the 1.0 step and
 * by a store's first move from its file (0.8's lanes.json, watches.json, metrics.json).
 */
export function insertEntries(db: DatabaseSync, store: TableStore, docs: unknown[]): number {
  const def = TABLE_DEFS[store]
  const keys = entryKeys(store, docs)
  const aside: unknown[] = []
  docs.forEach((doc, i) => {
    const e = rowsOfEntry(def, doc, keys[i], i)
    db.exec('SAVEPOINT entry')
    try {
      insertEntry(db, def, e)
      db.exec('RELEASE entry')
    } catch {
      db.exec('ROLLBACK TO entry')
      db.exec('RELEASE entry')
      aside.push(doc)
    }
  })
  keepAside(db, store, aside)
  return docs.length - aside.length
}

/** The step's name (and its tables' DDL, from #1208's design). */
export const STORES_STEP = V1_0_STEPS.find((s) => s.name === 'lanes, watches and metrics in tables')!

/**
 * The 1.0 step for lanes, watches and metrics (#1212): their tables made, each store's `store_rows` entries moved into
 * them (its order kept) and its `store_meta` values into `board_meta` as `<store>.<key>`, then their old rows removed.
 * An entry whose document isn't JSON is kept aside, its text as it was. Runs inside the 1.0 group's transaction.
 */
export function moveStores(db: DatabaseSync): void {
  for (const sql of STORES_STEP.ddl) db.exec(sql)
  const hasOld = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_rows'").get() // i18n-ignore: SQL
  if (!hasOld) return
  for (const store of TABLE_STORES) {
    for (const r of db.prepare("SELECT key, value FROM store_meta WHERE store = ? AND scope = ''").all(store) as { key: string; value: string }[]) setMeta(db, store, r.key, r.value) // i18n-ignore: SQL
    const rows = db.prepare("SELECT doc FROM store_rows WHERE store = ? AND scope = '' ORDER BY ord, key").all(store) as { doc: string }[] // i18n-ignore: SQL
    const docs: unknown[] = []
    const unreadable: unknown[] = []
    for (const r of rows) {
      try {
        docs.push(JSON.parse(r.doc))
      } catch {
        unreadable.push(r.doc)
      }
    }
    insertEntries(db, store, docs)
    keepAside(db, store, unreadable)
    db.prepare('DELETE FROM store_rows WHERE store = ?').run(store) // i18n-ignore: SQL
    db.prepare('DELETE FROM store_meta WHERE store = ?').run(store) // i18n-ignore: SQL
  }
}
