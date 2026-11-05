import { brotliCompressSync, brotliDecompressSync } from 'zlib'
import { createHash } from 'crypto'
import { existsSync, statSync } from 'original-fs'
import { dirname, join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { BROWSE_LIMITS, ENTRY_LIMITS, JOURNAL_KINDS, KEPT_IMPORTANCE, LINK_TYPES, inScope, isoWeek, weekStart, type JournalFilter, type JournalForgetPreview, type JournalForgetResult, type JournalKind, type JournalPage, type JournalRow, type JournalSettings, type JournalSource, type LinkType } from '../shared/journal'
import { openDb, OPENABLE_WAIT_MS, transaction, untilOpenable, type Db, type Migration } from './db'
import { realPath } from './fsutil'
import { createLogger, userText } from './logger'
import { checkpointWhenIdle, checkpointsReleased } from './walCheckpoint'
import { assertPlaceAdmitted, isAdmitted, ownerOf, refusedOpen } from './openingFence'
import { trash } from './trash'
import type { StoredText } from '../shared/types'

const log = createLogger('journal')

/**
 * The Assistant's journal (#989, #1031): a database of its own beside its home (`.combwork/assistant/journal.db`), apart
 * from the board's. Entries are small and typed (a one-line summary, optional detail and why, a project, an importance,
 * links to cards, commits, notes and other entries, tags), written by the Assistant (its tools) and by Hive (facts:
 * lanes, merges, an unexpected close). Recall gives one-line rows, at most a few, ranked; an entry's detail is read one
 * at a time. Long details are kept compressed (Brotli); the full-text index (FTS5, contentless: the text is only in
 * `entries`; not `detail=column`, with which a contentless table's bm25 is always nought) is kept by triggers, which read a compressed detail through `journal_text()`, a function each connection gets. Everyday
 * entries go after the retention, and the oldest of them first past the size cap; digests and important entries stay.
 * Everything here is agent-facing English (the window has its own words).
 */

export const JOURNAL_FILE = 'journal.db'

/** A detail longer than this is kept compressed. */
const COMPRESS_OVER = 1024

export const JOURNAL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'entries',
    up: (db) =>
      db.exec(`
        CREATE TABLE entries (
          id            INTEGER PRIMARY KEY,
          at            TEXT    NOT NULL,
          kind          TEXT    NOT NULL CHECK (kind IN (${JOURNAL_KINDS.map((k) => `'${k}'`).join(', ')})),
          project       TEXT,
          summary       TEXT    NOT NULL,
          detail        TEXT,
          detail_z      BLOB,
          why           TEXT,
          source        TEXT    NOT NULL CHECK (source IN ('hive', 'assistant')),
          importance    INTEGER NOT NULL DEFAULT 1 CHECK (importance BETWEEN 0 AND 3),
          superseded_by INTEGER REFERENCES entries(id) ON DELETE SET NULL,
          digest_of     TEXT,
          updated_at    TEXT
        ) STRICT;
        CREATE INDEX entries_at ON entries(at);
        CREATE INDEX entries_kind ON entries(kind, at);
        CREATE INDEX entries_project ON entries(project, at);
        CREATE INDEX entries_everyday ON entries(at) WHERE importance < ${KEPT_IMPORTANCE} AND kind <> 'digest';
        CREATE TABLE links (
          entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          type     TEXT    NOT NULL CHECK (type IN (${LINK_TYPES.map((k) => `'${k}'`).join(', ')})),
          ref      TEXT    NOT NULL,
          PRIMARY KEY (entry_id, type, ref)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX links_ref ON links(type, ref);
        CREATE TABLE tags (
          entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          tag      TEXT    NOT NULL,
          PRIMARY KEY (entry_id, tag)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX tags_tag ON tags(tag);
        CREATE TABLE journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE VIRTUAL TABLE entries_fts USING fts5(summary, detail, why, content='', contentless_delete=1);
        CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
          INSERT INTO entries_fts(rowid, summary, detail, why) VALUES (new.id, new.summary, journal_text(new.detail, new.detail_z), coalesce(new.why, ''));
        END;
        CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
          DELETE FROM entries_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER entries_au AFTER UPDATE OF summary, detail, detail_z, why ON entries BEGIN
          DELETE FROM entries_fts WHERE rowid = old.id;
          INSERT INTO entries_fts(rowid, summary, detail, why) VALUES (new.id, new.summary, journal_text(new.detail, new.detail_z), coalesce(new.why, ''));
        END;
      `)
  },
  {
    // Dialects (HI-2065, HI-2438): a summary Hive writes keeps its message id and values beside its English, as card
    // history keeps whatText (#845), so it can be said in each reader's dialect when it is read (5b, 6b). JSON of a
    // StoredText; null for the Assistant's own entries, for Hive's from before, and once the summary is edited.
    version: 2,
    name: 'summary text', // agent-protocol: a migration's name, recorded in schema_version
    up: (db) => db.exec('ALTER TABLE entries ADD COLUMN summary_text TEXT')
  }
]

/** A detail as stored: short ones as text, long ones compressed. */
function storedDetail(detail: string | null): { detail: string | null; z: Uint8Array | null } {
  if (detail === null || detail.length <= COMPRESS_OVER) return { detail, z: null }
  return { detail: null, z: brotliCompressSync(Buffer.from(detail, 'utf8')) }
}

/** A stored detail as text. */
function detailText(detail: unknown, z: unknown): string | null {
  if (z instanceof Uint8Array) return brotliDecompressSync(z).toString('utf8')
  return typeof detail === 'string' ? detail : null
}

/** The SQL function the triggers index a detail through, on every connection. */
function setup(db: DatabaseSync, isNew: boolean): void {
  // Set before the file has pages of its own (WAL mode made its first): a new file is vacuumed into it at once.
  if (isNew) db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM')
  db.function('journal_text', { deterministic: true }, (detail, z) => detailText(detail, z) ?? '')
  // An entry's ISO week, as a digest names it (#1032: originals a digest covers rank lower).
  db.function('journal_week', { deterministic: true }, (at) => isoWeek(new Date(String(at))))
}

const appVersion = (): string => {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/**
 * An open journal: its connection, the file it opened (where the journal really is, case kept, as it opened) and its
 * workspace (its place, `ownerOf` that file). It stays usable only while that is admitted (#1395), and the workspace's
 * close closes it by this, under whatever spelling it was opened (#1456).
 */
interface OpenJournal {
  db: Db
  file: string
  owner: string
}
/** Open journals by their file's spelling: one opened through a junction or an 8.3 name is another connection to it. */
const open = new Map<string, OpenJournal>()
const keyOf = (file: string): string => file.toLowerCase()

/** The journal file of an Assistant home (`<workspace>/.combwork/assistant`). */
export const journalFile = (home: string): string => join(home, JOURNAL_FILE)

/**
 * Where a journal is, resolved once as a call enters and used for everything it does (#1456): the open one's file and
 * workspace as it opened, else where its spelling leads now and that file's workspace (null: in no `.combwork`). Never
 * the spelling itself, which a junction pointed elsewhere meanwhile would take to another workspace's journal.
 */
interface Located {
  file: string
  owner: string | null
}
function located(home: string): Located {
  const spelt = journalFile(home)
  const o = open.get(keyOf(spelt))
  if (o) return { file: o.file, owner: o.owner }
  const file = realPath(spelt)
  return { file, owner: ownerOf(file) }
}

/**
 * Journals being deleted (#1031 round 1), by their workspace's place (#1456: under any spelling; a file in no `.combwork` by
 * itself): nothing opens them meanwhile, so the file can go.
 */
const deleting = new Set<string>()
const deletingKey = (at: Located): string => at.owner ?? keyOf(at.file)

/** The journal of an Assistant home, opened (and made) when first used; refused while it is being deleted. */
function journalOf(home: string, at: Located = located(home)): Db {
  // Kept open only for a workspace a window holds (#1395): late work of one closed, or never opened, is refused, also
  // while its connection is still open (before the close has closed it).
  if (deleting.has(deletingKey(at))) throw new JournalBusy('The journal is being deleted: try again in a moment.')
  if (at.owner === null) throw refusedOpen()
  assertPlaceAdmitted(at.owner)
  const k = keyOf(journalFile(home))
  const was = open.get(k)
  if (was) return was.db
  const db = openJournalDb(at.file)
  open.set(k, { db, file: at.file, owner: at.owner })
  return db
}

/**
 * Before a workspace's open lets its Assistant use the journal (HI-2200, as the board's HI-2199): while its file, as a
 * Hive that ended without quitting left it, can't be opened yet (another process still maps its `-shm`), waits for that,
 * bounded (untilOpenable), instead of its first use failing. At once for a journal open already or a file closed
 * cleanly; ended when `signal` (the open's lifetime) aborts.
 */
export async function untilJournalOpenable(home: string, signal: AbortSignal): Promise<void> {
  const file = journalFile(home)
  if (open.has(keyOf(file))) return
  let waiting = false
  const onWait = (e: Error): void => {
    waiting = true
    journalTestHooks.openableWait?.(home)
    log.warn(`the journal ${userText(file)} can't be opened yet: ${userText(e.message)} (SQLite code ${(e as { errcode?: number }).errcode}; another process still maps its -shm, as just after a Combwork ended without quitting): waiting up to ${OPENABLE_WAIT_MS / 1000} s`)
  }
  const waited = await untilOpenable(file, { onWait, signal })
  if (waiting) log.info(`the journal ${userText(file)}: ${signal.aborted ? 'its wait ended with its open' : 'openable'} after ${Math.round(waited)} ms`)
}

/** For tests: told as a workspace's open starts waiting for its journal to be openable (HI-2200). */
export const journalTestHooks: { openableWait: ((home: string) => void) | null } = { openableWait: null }

/** Opens the journal at `file`, where it really is (its backups beside it). */
const openJournalDb = (file: string): Db => openDb(file, { migrations: JOURNAL_MIGRATIONS, appVersion: appVersion(), backupDir: join(dirname(file), 'backups'), setup, checkpointer: checkpointWhenIdle, onIoRetry: (e, ms) => log.warn(`opening the journal ${userText(file)}: ${userText(e.message)}, tried again in ${ms} ms`) })

/**
 * Closes a home's journal (its workspace closed, or before it is deleted): every connection to it, however it was spelt
 * as it opened (#1456: one opened through a junction or an 8.3 name would otherwise hold the folder until Hive quits).
 * The workspace is `place`, its real location as its window opened it, else as this spelling's journal opened: never
 * what the spelling resolves to now, so a junction removed or pointed at another workspace since neither keeps this
 * one's journals open nor closes another's.
 */
export function closeJournal(home: string, place?: string): void {
  const file = journalFile(home)
  const key = keyOf(file)
  const others = [...open.keys()].some((k) => k !== key)
  const at = others ? (place ?? open.get(key)?.owner ?? ownerOf(file)) : null
  for (const [k, o] of [...open]) if (k === key || (at !== null && o.owner === at)) closeOne(k, o)
}

function closeOne(key: string, o: OpenJournal): void {
  open.delete(key)
  o.db.close()
}

/** Whether a home's journal is open under this spelling (tests). */
export const journalOpen = (home: string): boolean => open.has(keyOf(journalFile(home)))

export function closeAllJournals(): void {
  for (const o of [...open.values()]) o.db.close()
  open.clear()
}

/** An error the tools return as their reply: the caller's mistake, said plainly. */
export class JournalError extends Error {}
/** The journal is being deleted (a moment): nothing reads or writes it meanwhile. */
export class JournalBusy extends JournalError {}

/** Who is told when a journal changes (the windows' browsers, #1033): by its Assistant home. */
const listeners = new Set<(home: string) => void>()

export function onJournalChange(fn: (home: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function told(home: string): void {
  for (const fn of listeners) {
    try {
      fn(home)
    } catch (e) {
      log.warn('telling of a journal change', e)
    }
  }
}

const fail = (text: string): never => {
  throw new JournalError(text)
}

/** What an entry is written with. */
export interface EntryInput {
  kind: string
  summary: string
  detail?: string | null
  why?: string | null
  project?: string | null
  importance?: number
  links?: { type: string; ref: string }[]
  tags?: string[]
  /** The period a digest sums up ("2026-W42"). */
  digestOf?: string | null
  /** The summary as Hive's message (its id and values), beside its English: a fact Hive writes (dialects, HI-2438). */
  summaryText?: StoredText | null
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function checkText(name: string, v: unknown, max: number, required = false): string | null {
  if (v === undefined || v === null || v === '') return required ? fail(`${name} is required.`) : null
  if (typeof v !== 'string') return fail(`${name} must be text.`)
  if (v.length > max) return fail(`${name} is longer than ${max} characters.`)
  return v
}

function checkImportance(v: unknown): number {
  if (v === undefined) return 1
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3) return fail('importance must be 0, 1, 2 or 3.')
  return v as number
}

function checkLinks(v: unknown): { type: LinkType; ref: string }[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) return fail('links must be a list of { type, ref }.')
  if (v.length > ENTRY_LIMITS.links) return fail(`At most ${ENTRY_LIMITS.links} links.`)
  return v.map((l) => {
    const type = (l as { type?: unknown })?.type
    if (!LINK_TYPES.includes(type as LinkType)) fail(`A link's type is one of: ${LINK_TYPES.join(', ')}.`)
    const ref = String((l as { ref?: unknown }).ref ?? '').replace(/^#/, '').trim()
    if (!ref || ref.length > ENTRY_LIMITS.ref) fail(`A link's ref is 1 to ${ENTRY_LIMITS.ref} characters.`)
    return { type: type as LinkType, ref }
  })
}

function checkTags(v: unknown): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) return fail('tags must be a list of words.')
  if (v.length > ENTRY_LIMITS.tags) return fail(`At most ${ENTRY_LIMITS.tags} tags.`)
  return [...new Set((v as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))].map((t) => (t.length > ENTRY_LIMITS.tag ? fail(`A tag is at most ${ENTRY_LIMITS.tag} characters.`) : t))
}

/**
 * Writes an entry; returns its id. The scope decides which kinds may be stored (the caller says why not). In one
 * transaction with its links and tags; the index follows by trigger.
 */
export function writeEntry(home: string, settings: JournalSettings, input: EntryInput, source: JournalSource): number {
  return writeEntryUnless(home, settings, input, source, null)!
}

/**
 * As writeEntry, once: nothing is written (null) when the journal already has an entry by `source` with this summary
 * and detail, linked to `link` (#1534: a build sent twice, its reply cut off and then its marker). Checked in the
 * write's own transaction, so two at once write one; found through the links index, however many entries share it.
 */
export function writeEntryOnce(home: string, settings: JournalSettings, input: EntryInput, source: JournalSource, link: { type: LinkType; ref: string }): number | null {
  return writeEntryUnless(home, settings, input, source, link)
}

function writeEntryUnless(home: string, settings: JournalSettings, input: EntryInput, source: JournalSource, once: { type: LinkType; ref: string } | null): number | null {
  const e = entryOf(settings, input)
  const id = insertEntry(journalOf(home).writer, e, source, once)
  if (id === null) return null
  pruneSoon(home, settings)
  told(home)
  return id
}

/**
 * Writes an entry into a journal whose workspace no window may hold now (#1395: the unexpected close Hive finds as it
 * starts, for each workspace of the last run): as writeEntry while a window holds it; else on a connection of its own,
 * opened, written and closed here (a transient open), never kept nor made the journal's, so a window opening the
 * workspace meanwhile keeps its own (pruned and shown once it is opened). Refused while the journal is being deleted.
 */
export function leaveEntry(home: string, settings: JournalSettings, input: EntryInput, source: JournalSource): number {
  // Where it is, resolved once as it enters (#1456): admitted by it, and opened there.
  const at = located(home)
  if (at.owner !== null && isAdmitted(at.owner)) return writeEntry(home, settings, input, source)
  const e = entryOf(settings, input)
  if (deleting.has(deletingKey(at))) throw new JournalBusy('The journal is being deleted: try again in a moment.')
  const db = openJournalDb(at.file)
  try {
    return insertEntry(db.writer, e, source)!
  } finally {
    db.close()
  }
}

/** An entry as it is stored, checked (the scope decides which kinds may be: the caller says why not). */
function entryOf(settings: JournalSettings, input: EntryInput) {
  if (!JOURNAL_KINDS.includes(input.kind as JournalKind)) fail(`kind is one of: ${JOURNAL_KINDS.join(', ')}.`)
  const kind = input.kind as JournalKind
  if (!inScope(settings, kind)) fail(`The user's journal scope doesn't include ${kind} entries (Settings → Assistant → Journal allows: ${settings.scope.join(', ') || 'none'}). Don't store it.`)
  return {
    kind,
    summary: oneLine(checkText('summary', input.summary, ENTRY_LIMITS.summary, true)!),
    detail: checkText('detail', input.detail, ENTRY_LIMITS.detail),
    why: checkText('why', input.why, ENTRY_LIMITS.why),
    project: checkText('project', input.project, ENTRY_LIMITS.project),
    digestOf: checkText('digestOf', input.digestOf, 100),
    summaryText: input.summaryText ? JSON.stringify(input.summaryText) : null,
    importance: checkImportance(input.importance),
    links: checkLinks(input.links),
    tags: checkTags(input.tags)
  }
}

/**
 * writeEntry's transaction, on the connection given: the entry with its links and tags; returns its id. With `once`,
 * nothing (null) when an entry by `source` with this summary and detail is already linked to it.
 */
function insertEntry(w: Db['writer'], e: ReturnType<typeof entryOf>, source: JournalSource, once: { type: LinkType; ref: string } | null = null): number | null {
  const { kind, summary, detail, why, project, digestOf, summaryText, importance, links, tags } = e
  const d = storedDetail(detail)
  return transaction(w, () => {
    if (once) {
      const same = w.prepare('SELECT e.detail, e.detail_z FROM links l JOIN entries e ON e.id = l.entry_id WHERE l.type = ? AND l.ref = ? AND e.source = ? AND e.summary = ?').all(once.type, once.ref, source, summary) as { detail: unknown; detail_z: unknown }[]
      if (same.some((r) => detailText(r.detail, r.detail_z) === detail)) return null
    }
    for (const l of links.filter((x) => x.type === 'entry')) if (!w.prepare('SELECT 1 FROM entries WHERE id = ?').get(Number(l.ref))) fail(`There is no entry ${l.ref} to link to.`)
    const r = w
      // agent-protocol: SQL
      .prepare('INSERT INTO entries (at, kind, project, summary, detail, detail_z, why, source, importance, digest_of, summary_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), kind, project, summary, d.detail, d.z, why, source, importance, digestOf, summaryText)
    const n = Number(r.lastInsertRowid)
    const link = w.prepare('INSERT OR IGNORE INTO links (entry_id, type, ref) VALUES (?, ?, ?)')
    for (const l of links) link.run(n, l.type, l.ref)
    const tag = w.prepare('INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)')
    for (const t of tags) tag.run(n, t)
    return n
  })
}

/** What recall looks for; everything is optional. */
export interface RecallQuery {
  /** Words to find in summaries, details and whys (ranked: relevance, nudged by importance and recency). */
  query?: string
  since?: string
  until?: string
  kinds?: string[]
  project?: string
  link?: { type: string; ref: string }
  tag?: string
  /** Superseded entries too (left out by default). */
  superseded?: boolean
  limit?: number
}

/** A recalled entry: one line's worth. */
export interface RecallRow {
  id: number
  at: string
  kind: JournalKind
  project: string | null
  summary: string
  importance: number
  source: JournalSource
  supersededBy: number | null
  hasDetail: boolean
}

const isoOrFail = (name: string, v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) return fail(`${name} must be a date or time (2026-10-18, or ISO).`)
  return new Date(Date.parse(v)).toISOString()
}

/** The words of a query as an FTS5 expression: each a prefix, any of them (ranking prefers entries with more). */
function matchOf(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_]+/gu) ?? []
  return words.length ? words.slice(0, 20).map((w) => `"${w}"*`).join(' OR ') : null
}

/**
 * Recalls entries: newest first, or best first for a query; at most `limit` (default 10). A match's rank is its relevance
 * (bm25; the summary weighs most) times 1 + importance/2, over 1 + ln(1 + age/90 days): recency and importance nudge it,
 * so an essential entry from months ago still outranks a trivial one from today; an original whose week has a digest
 * counts half (#1032: the digest keeps its gist). Ties (a small journal, where bm25 gives every match nought) go by
 * importance, then the newest.
 */
export function recall(home: string, q: RecallQuery): RecallRow[] {
  const limit = q.limit === undefined ? ENTRY_LIMITS.recallDefault : Number.isInteger(q.limit) && q.limit > 0 && q.limit <= ENTRY_LIMITS.recallMax ? q.limit : fail(`limit is 1 to ${ENTRY_LIMITS.recallMax}.`)
  const where: string[] = []
  const args: (string | number)[] = []
  const add = (clause: string, ...values: (string | number)[]): void => {
    where.push(clause)
    args.push(...values)
  }
  const since = isoOrFail('since', q.since)
  const until = isoOrFail('until', q.until)
  if (since) add('e.at >= ?', since)
  if (until) add('e.at <= ?', until)
  if (q.kinds?.length) {
    for (const k of q.kinds) if (!JOURNAL_KINDS.includes(k as JournalKind)) fail(`kinds are among: ${JOURNAL_KINDS.join(', ')}.`)
    where.push(`e.kind IN (${q.kinds.map(() => '?').join(', ')})`)
    args.push(...q.kinds)
  }
  if (q.project) add('e.project = ? COLLATE NOCASE', q.project)
  if (q.link) {
    const [l] = checkLinks([q.link])
    where.push('EXISTS (SELECT 1 FROM links l WHERE l.entry_id = e.id AND l.type = ? AND l.ref = ?)')
    args.push(l.type, l.ref)
  }
  if (q.tag) add('EXISTS (SELECT 1 FROM tags t WHERE t.entry_id = e.id AND t.tag = ?)', q.tag.trim().toLowerCase())
  if (!q.superseded) where.push('e.superseded_by IS NULL')
  const match = q.query ? matchOf(q.query) : null
  const cols = 'e.id, e.at, e.kind, e.project, e.summary, e.importance, e.source, e.superseded_by AS supersededBy, (e.detail IS NOT NULL OR e.detail_z IS NOT NULL) AS hasDetail'
  const { reader } = journalOf(home)
  const sql = match
    ? `SELECT ${cols} FROM entries_fts f JOIN entries e ON e.id = f.rowid WHERE entries_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
       ORDER BY bm25(entries_fts, 3.0, 1.0, 1.5) * (1 + 0.5 * e.importance) / (1 + ln(1 + max(0, julianday('now') - julianday(e.at)) / 90.0))
         * (CASE WHEN e.kind <> 'digest' AND EXISTS (SELECT 1 FROM entries d WHERE d.kind = 'digest' AND d.digest_of = journal_week(e.at)) THEN 0.5 ELSE 1 END), e.importance DESC, e.at DESC LIMIT ?`
    : `SELECT ${cols} FROM entries e${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.at DESC, e.id DESC LIMIT ?`
  const rows = reader.prepare(sql).all(...(match ? [match] : []), ...args, limit) as unknown as (Omit<RecallRow, 'hasDetail'> & { hasDetail: number })[]
  return rows.map((r) => ({ ...r, hasDetail: !!r.hasDetail }))
}

/** An entry in full. */
export interface JournalEntry extends RecallRow {
  detail: string | null
  why: string | null
  digestOf: string | null
  updatedAt: string | null
  links: { type: LinkType; ref: string }[]
  tags: string[]
  /** Entries this one supersedes. */
  supersedes: number[]
}

export function readEntry(home: string, id: number): JournalEntry | null {
  const { reader } = journalOf(home)
  const r = reader.prepare('SELECT id, at, kind, project, summary, detail, detail_z, why, source, importance, superseded_by, digest_of, updated_at FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!r) return null
  const detail = detailText(r.detail, r.detail_z)
  return {
    id: Number(r.id),
    at: String(r.at),
    kind: r.kind as JournalKind,
    project: (r.project as string | null) ?? null,
    summary: String(r.summary),
    importance: Number(r.importance),
    source: r.source as JournalSource,
    supersededBy: (r.superseded_by as number | null) ?? null,
    hasDetail: detail !== null,
    detail,
    why: (r.why as string | null) ?? null,
    digestOf: (r.digest_of as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
    links: reader.prepare('SELECT type, ref FROM links WHERE entry_id = ? ORDER BY type, ref').all(id) as unknown as { type: LinkType; ref: string }[],
    tags: (reader.prepare('SELECT tag FROM tags WHERE entry_id = ? ORDER BY tag').all(id) as { tag: string }[]).map((t) => t.tag),
    supersedes: (reader.prepare('SELECT id FROM entries WHERE superseded_by = ? ORDER BY id').all(id) as { id: number }[]).map((x) => x.id)
  }
}

/** A change to an entry: corrected words, its kind, importance, superseded by a newer entry (null: no longer), more links or tags. */
export interface EntryPatch {
  summary?: string
  kind?: string
  detail?: string | null
  why?: string | null
  importance?: number
  supersededBy?: number | null
  addLinks?: { type: string; ref: string }[]
  addTags?: string[]
}

/** Changes an entry; false when there is none. Retention and the cap apply after it (a longer detail, a lower importance). */
export function updateEntry(home: string, settings: JournalSettings, id: number, patch: EntryPatch): boolean {
  const sets: string[] = []
  const args: (string | number | Uint8Array | null)[] = []
  const set = (clause: string, value: string | number | null): void => {
    sets.push(clause)
    args.push(value)
  }
  if (patch.summary !== undefined) {
    set('summary = ?', oneLine(checkText('summary', patch.summary, ENTRY_LIMITS.summary, true)!))
    // Edited: its words are the editor's now, no longer Hive's message.
    set('summary_text = ?', null)
  }
  if (patch.kind !== undefined) {
    if (!JOURNAL_KINDS.includes(patch.kind as JournalKind)) fail(`kind is one of: ${JOURNAL_KINDS.join(', ')}.`)
    if (!inScope(settings, patch.kind as JournalKind)) fail(`The user's journal scope doesn't include ${patch.kind} entries (Settings → Assistant → Journal allows: ${settings.scope.join(', ') || 'none'}).`)
    set('kind = ?', patch.kind)
  }
  if (patch.detail !== undefined) {
    const d = storedDetail(checkText('detail', patch.detail, ENTRY_LIMITS.detail))
    sets.push('detail = ?', 'detail_z = ?')
    args.push(d.detail, d.z)
  }
  if (patch.why !== undefined) set('why = ?', checkText('why', patch.why, ENTRY_LIMITS.why))
  if (patch.importance !== undefined) set('importance = ?', checkImportance(patch.importance))
  if (patch.supersededBy !== undefined) {
    if (patch.supersededBy !== null && (!Number.isInteger(patch.supersededBy) || patch.supersededBy === id)) fail('supersededBy is another entry\'s id, or null.')
    sets.push('superseded_by = ?')
    args.push(patch.supersededBy)
  }
  const links = checkLinks(patch.addLinks)
  const tags = checkTags(patch.addTags)
  if (!sets.length && !links.length && !tags.length) fail('Nothing to change: give summary, kind, detail, why, importance, supersededBy, addLinks or addTags.')
  const { writer: w } = journalOf(home)
  const changed = transaction(w, () => {
    if (!w.prepare('SELECT 1 FROM entries WHERE id = ?').get(id)) return false
    if (patch.supersededBy != null && !w.prepare('SELECT 1 FROM entries WHERE id = ?').get(patch.supersededBy)) fail(`There is no entry ${patch.supersededBy}.`)
    w.prepare(`UPDATE entries SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`).run(...args, new Date().toISOString(), id)
    const link = w.prepare('INSERT OR IGNORE INTO links (entry_id, type, ref) VALUES (?, ?, ?)')
    for (const l of links) link.run(id, l.type, l.ref)
    const tag = w.prepare('INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)')
    for (const t of tags) tag.run(id, t)
    return true
  })
  if (changed) {
    pruneJournal(home, settings)
    told(home)
  }
  return changed
}

/** Deletes an entry (its links and tags with it; entries it superseded are current again); false when there is none. */
export function deleteEntry(home: string, id: number): boolean {
  const { writer: w } = journalOf(home)
  const gone = transaction(w, () => Number(w.prepare('DELETE FROM entries WHERE id = ?').run(id).changes) > 0)
  if (gone) {
    w.exec('PRAGMA incremental_vacuum')
    told(home)
  }
  return gone
}

/** How big the journal is (bytes, its pages in use) and how many entries it has; null when there is none yet (or it is being deleted). */
export function journalSize(home: string): { bytes: number; entries: number } | null {
  const at = located(home)
  if (deleting.has(deletingKey(at)) || (!open.has(keyOf(journalFile(home))) && !existsSync(at.file))) return null
  const { reader } = journalOf(home, at)
  const pages = (reader.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
  const free = (reader.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
  const size = (reader.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
  const entries = (reader.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n
  return { bytes: (pages - free) * size, entries }
}

/** Whether a home has a journal to read (without making one); false while it is being deleted. */
export function hasJournal(home: string): boolean {
  const at = located(home)
  return !deleting.has(deletingKey(at)) && (open.has(keyOf(journalFile(home))) || existsSync(at.file))
}

/**
 * The week before `now`'s (#1032: "2026-W41") when it has entries but no digest of it, else null: the state view asks
 * for one then.
 */
export function digestDue(home: string, now = new Date()): string | null {
  const end = weekStart(now)
  const start = new Date(end.getTime() - 7 * 86_400_000)
  const label = isoWeek(start)
  const { reader } = journalOf(home)
  const had = reader.prepare("SELECT 1 FROM entries WHERE kind <> 'digest' AND at >= ? AND at < ? LIMIT 1").get(start.toISOString(), end.toISOString())
  if (!had) return null
  return reader.prepare("SELECT 1 FROM entries WHERE kind = 'digest' AND digest_of = ? LIMIT 1").get(label) ? null : label
}

/**
 * Retention and the size cap: everyday entries (importance under 2, not digests) older than the retention go; past the
 * cap, the oldest everyday entries go first, one at a time, the size measured after each, until it fits or none is left (digests and important entries are never pruned). Space
 * freed is given back to the file. Returns how many went.
 */
export function pruneJournal(home: string, settings: JournalSettings, now = new Date()): number {
  const { writer: w } = journalOf(home)
  const cutoff = new Date(now.getTime() - settings.retentionDays * 86_400_000).toISOString()
  const everyday = `importance < ${KEPT_IMPORTANCE} AND kind <> 'digest'`
  let gone = transaction(w, () => Number(w.prepare(`DELETE FROM entries WHERE ${everyday} AND at < ?`).run(cutoff).changes))
  if (settings.capMB !== null) {
    const cap = settings.capMB * 1024 * 1024
    const used = (): number => {
      const pages = (w.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
      const free = (w.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
      return (pages - free) * (w.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
    }
    // One entry at a time, the oldest everyday one, each in its own transaction, and the space it held measured once it
    // is committed: nothing is predicted (#1031 rounds 1-3: what an entry frees can't be told from its text, its links,
    // tags and index share pages), so it stops the moment the journal fits. Slow only far past the cap, which is rare.
    const oldest = w.prepare(`SELECT id FROM entries WHERE ${everyday} ORDER BY at, id LIMIT 1`)
    const remove = w.prepare('DELETE FROM entries WHERE id = ?')
    while (used() > cap) {
      const row = oldest.get() as { id: number } | undefined
      if (!row) break
      gone += transaction(w, () => Number(remove.run(row.id).changes))
    }
  }
  if (gone) {
    w.exec('PRAGMA incremental_vacuum')
    told(home)
    log.info(`pruned ${gone} journal entr${gone === 1 ? 'y' : 'ies'} (retention ${settings.retentionDays} days, cap ${settings.capMB ?? 'none'} MB)`)
  }
  w.prepare('INSERT INTO journal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('prunedAt', now.toISOString())
  return gone
}

/** Prunes after a write when it hasn't for an hour (or the cap may be passed: checked on each write, cheaply). */
function pruneSoon(home: string, settings: JournalSettings): void {
  try {
    const { writer: w } = journalOf(home)
    const last = (w.prepare("SELECT value FROM journal_meta WHERE key = 'prunedAt'").get() as { value: string } | undefined)?.value
    const due = !last || Date.now() - Date.parse(last) > 3_600_000
    const over = settings.capMB !== null && (journalSize(home)?.bytes ?? 0) > settings.capMB * 1024 * 1024
    if (due || over) pruneJournal(home, settings)
  } catch (e) {
    log.warn('pruning the journal', e)
  }
}

/**
 * Deletes the journal (Settings → Assistant → Delete Journal…): closed, its files to the Recycle Bin. Nothing opens it
 * meanwhile (a write, a recall, a fact or the size is refused or skipped until its files have gone), so it is never
 * opened again under the move.
 */
export async function deleteJournal(home: string): Promise<void> {
  // Where it is, resolved once as it enters (#1456): every connection of its workspace closed and kept closed by its
  // place, and the files there moved, through every await, never where the spelling leads by then.
  const at = located(home)
  const { file } = at
  const key = deletingKey(at)
  if (deleting.has(key)) throw new JournalBusy('The journal is already being deleted.')
  deleting.add(key)
  try {
    closeJournal(home, at.owner ?? undefined)
    // Moved to the Recycle Bin once the checkpoints' worker lets go of it (HI-1691).
    await checkpointsReleased(file)
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) await trash(f)
  } finally {
    deleting.delete(key)
  }
  log.info(`deleted the journal in ${userText(home)}`)
  told(home)
}

/** The journal's file size on disk (with its WAL), for Settings; 0 when there is none. */
export function journalFileBytes(home: string): number {
  const { file } = located(home)
  let n = 0
  for (const f of [file, `${file}-wal`]) {
    try {
      n += statSync(f).size
    } catch {
      // None.
    }
  }
  return n
}

// The journal browser (#1033): the user's view of every entry, under the Assistant's view. It reads the journal whether
// it is on or off (off keeps the data readable), never makes one that isn't there, and deletes what a search found.

/** No journal: nothing matches (the set of none, and its token). */
const NONE: JournalForgetPreview = { count: 0, token: createHash('sha256').update('').digest('hex') }

/** The words of a browser search as an FTS5 expression: each a prefix, all of them (what Forget deletes is what it shows). */
function allWordsOf(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_]+/gu) ?? []
  return words.length ? words.slice(0, 20).map((w) => `"${w}"*`).join(' ') : null
}

/** A filter as SQL over `entries e`. */
function filterSql(f: JournalFilter): { where: string[]; args: (string | number)[] } {
  const where: string[] = []
  const args: (string | number)[] = []
  const add = (clause: string, ...values: (string | number)[]): void => {
    where.push(clause)
    args.push(...values)
  }
  const match = f.query ? allWordsOf(f.query) : null
  if (match) add('e.id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)', match)
  if (f.kinds?.length) {
    const kinds = f.kinds.filter((k) => JOURNAL_KINDS.includes(k))
    add(kinds.length ? `e.kind IN (${kinds.map(() => '?').join(', ')})` : '0', ...kinds)
  }
  if (f.project === '') add('e.project IS NULL')
  else if (f.project) add('e.project = ? COLLATE NOCASE', f.project)
  if (f.source === 'hive' || f.source === 'assistant') add('e.source = ?', f.source)
  const since = isoOrFail('since', f.since)
  const until = isoOrFail('until', f.until)
  if (since) add('e.at >= ?', since)
  if (until) add('e.at <= ?', until)
  return { where, args }
}

/** A page of the timeline, newest first: the rows with their links, how many match, and the newest id now. */
export function browseJournal(home: string, f: JournalFilter, offset = 0, limit: number = BROWSE_LIMITS.page): JournalPage {
  if (!hasJournal(home)) return { rows: [], total: 0 }
  const { reader } = journalOf(home)
  const { where, args } = filterSql(f)
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  const n = Math.min(BROWSE_LIMITS.max, Math.max(1, Math.floor(limit) || BROWSE_LIMITS.page))
  const total = (reader.prepare(`SELECT count(*) AS n FROM entries e${w}`).get(...args) as { n: number }).n
  const rows = reader
    .prepare(`SELECT e.id, e.at, e.kind, e.project, e.summary, e.importance, e.source, e.superseded_by AS supersededBy, e.digest_of AS digestOf FROM entries e${w} ORDER BY e.at DESC, e.id DESC LIMIT ? OFFSET ?`)
    .all(...args, n, Math.max(0, Math.floor(offset) || 0)) as unknown as Omit<JournalRow, 'links'>[]
  const links = new Map<number, JournalRow['links']>()
  if (rows.length) {
    const all = reader.prepare(`SELECT entry_id AS id, type, ref FROM links WHERE entry_id IN (${rows.map(() => '?').join(', ')}) ORDER BY type, ref`).all(...rows.map((r) => r.id)) as unknown as { id: number; type: LinkType; ref: string }[]
    for (const l of all) links.set(l.id, [...(links.get(l.id) ?? []), { type: l.type, ref: l.ref }])
  }
  return { rows: rows.map((r) => ({ ...r, links: links.get(r.id) ?? [] })), total }
}

/** The projects the journal's entries name, for the browser's filter. */
export function journalProjects(home: string): string[] {
  if (!hasJournal(home)) return []
  return (journalOf(home).reader.prepare('SELECT DISTINCT project FROM entries WHERE project IS NOT NULL ORDER BY project COLLATE NOCASE').all() as { project: string }[]).map((r) => r.project)
}

/** An entry in full for the browser, or null (none, or no journal). */
export function browseEntry(home: string, id: number): JournalEntry | null {
  return hasJournal(home) ? readEntry(home, id) : null
}

/** The entries a filter matches now, as a count and a token for exactly that set (their ids). */
function matchSet(db: DatabaseSync, f: JournalFilter): JournalForgetPreview {
  const { where, args } = filterSql(f)
  const ids = (db.prepare(`SELECT e.id FROM entries e${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id`).all(...args) as { id: number }[]).map((r) => r.id)
  return ids.length ? { count: ids.length, token: createHash('sha256').update(ids.join(',')).digest('hex') } : NONE
}

/** What Forget would delete: shown to the user to confirm. */
export function forgetPreview(home: string, f: JournalFilter): JournalForgetPreview {
  return hasJournal(home) ? matchSet(journalOf(home).reader, f) : NONE
}

/**
 * Forget everything about X (#1033): deletes, in one transaction, every entry the filter matches, only while that set is
 * exactly the one the user confirmed (`token`, from forgetPreview). Changed since (an entry written, edited into or out
 * of the match, deleted), nothing goes and the set as it is now is returned, to ask again.
 */
export function forgetJournal(home: string, f: JournalFilter, token: string): JournalForgetResult {
  if (!hasJournal(home)) return token === NONE.token ? { gone: 0 } : { changed: NONE }
  const { writer: w } = journalOf(home)
  const { where, args } = filterSql(f)
  const r = transaction(w, (): JournalForgetResult => {
    const now = matchSet(w, f)
    if (now.token !== token) return { changed: now }
    return { gone: Number(w.prepare(`DELETE FROM entries WHERE id IN (SELECT e.id FROM entries e${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`).run(...args).changes) }
  })
  const gone = 'gone' in r ? r.gone : 0
  if (gone) {
    w.exec('PRAGMA incremental_vacuum')
    log.info(`forgot ${gone} journal entr${gone === 1 ? 'y' : 'ies'}`)
    told(home)
  }
  return r
}
