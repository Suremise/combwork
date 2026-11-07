import { parentPort } from 'worker_threads'
import { createHash } from 'crypto'
import { open, stat } from 'original-fs/promises'
import { dirname, join } from 'path'
import type { AppSettings, ProviderId, SessionUsage } from '../shared/types'
import { baselineOfRows, baselineOfUsage, baselineAsFree, baselineWithoutReports, dominates, ledgerRows, mergeBaselines, reshareRows, rowsAsFree, rowsWithoutReports, sessionRows, summaryOf, unknownOnCards, type LedgerRow, type SessionHold } from '../shared/usageLedger'
import { OPENABLE_WAIT_MS, openableNow, openDb, untilOpenable, type Db } from './db'
import { advancedValues, readAdvancedFrom, valuesReader } from './advancedValues'
import type { DatabaseSync } from 'node:sqlite'
import { baselineOf, cardRows, cursorOf, fileSpace, getMeta, giveSpaceBack, markLocality, replaceRows, rollUpCandidates, rollUpSession, sessionIds, setMeta, storedSession, storedSessions, storedTimelines, updateMeta, USAGE_MIGRATIONS, writeSession, type SessionMeta, type SessionWrite } from './usageDb'
import { COARSE_STEP, coarsenTimeline } from '../shared/usageTimeline'
import { USAGE_TIMELINE_DETAIL_DAYS } from '../shared/advanced'
import { isGz, readTranscript } from './transcriptFiles'
import { withoutCostReports } from '../shared/usageDays'
import { newUsageParser, parserShape, restoreParser, saveParser, type RawUsageParser } from './usageParsers'

/**
 * The usage worker (#1106): a thread of its own that keeps each workspace's usage history (usageDb.ts), so reading the
 * CLIs' transcripts never holds up Combwork's main process. It reads only what a transcript added since it was last read,
 * taking up the parser's saved state; makes the session's rows (shared/usageLedger.ts) and writes them with its own
 * node:sqlite connection to `.combwork/usage.db`, one short transaction a session (WAL: main and other readers never wait for
 * it; another Combwork's worker on the same workspace waits up to db.ts's busy timeout, and a session it recorded meanwhile
 * is left as it wrote it). It answers main's queries on that file too, so main never opens it. Jobs run one at a time,
 * in the order main sends them (main keeps the queue and its priorities, usageHistory.ts); queries are answered at once,
 * between a job's reads. It also reads a transcript's usage so far for main (#1147: a running session's footer and
 * context gauge, as each turn grows it), from the same parsers its jobs use (`reads`). No Electron here (a worker can't
 * load it): logs go to main.
 */

export interface IngestJob extends SessionMeta {
  /** The file to read (the CLI's transcript, or Combwork's backup of it), as main found it; null when it has none. */
  path: string | null
  /** The cards the session's agent held (main works them out from the board). */
  holds: SessionHold[]
  /** Keep the parser's state now: the session ended, or main says it runs (then at most every few minutes). */
  keepState: 'now' | 'running' | 'no'
  /** A session started outside Combwork (no record): kept for the Sessions list, never counted in totals. */
  external?: boolean
  /** The holds `holds` were made from, as a key (open ones as open): a change re-shares the session's cards. */
  holdsKey: string | null
  /** A run of it was on a server connection (HI-1772: SessionRecord.serverRan): its CLI's cost reports aren't counted. */
  reportsIgnored?: boolean
  /** A run of it was on a server on this PC; one was anywhere else (HI-1772: its record's): free is the first alone. */
  serverLocal?: boolean
  notLocal?: boolean
}

export interface KeptJob extends SessionMeta {
  /** A kept usage (a deleted session's, or one whose transcript went): priced when it was kept. */
  usage: SessionUsage
  holds: SessionHold[]
  holdsKey: string | null
}

/** `failed`: the file is there (or that can't be told) but couldn't be read; `busy`: not written (another writer, a read-only file). */
export type IngestResult = { status: 'written' | 'unchanged' | 'missing' | 'kept' | 'busy' | 'failed'; requests?: number }

export type WorkerRequest = { id: number } & (
  | { type: 'config'; advanced: Record<string, unknown>; providers: AppSettings['providers']; appVersion: string; cacheSize?: number }
  | { type: 'ingest'; file: string; job: IngestJob }
  | { type: 'kept'; file: string; job: KeptJob }
  | { type: 'sessions'; file: string; scopes: string[] | null }
  | { type: 'cards'; file: string; cards: number[] }
  | { type: 'timelines'; file: string; scope: string; sessions?: string[] }
  | { type: 'ids'; file: string; scope: string }
  | { type: 'meta'; file: string; scope: string; key: string; value?: string }
  | { type: 'forgetStates'; file: string; before: string }
  | { type: 'rollUp'; file: string; live: string[]; now?: number }
  | { type: 'spaceBack'; file: string }
  | { type: 'attribute'; file: string; scope: string; sessions: { session: string; holds: SessionHold[]; holdsKey: string | null }[] }
  | { type: 'close'; file: string }
  | { type: 'read'; path: string; session: string; provider: ProviderId; seed: ReadSeed | null; noWait?: boolean; reportsIgnored?: boolean }
  | { type: 'forgetReads' }
)

/** Where a read may take its session's saved parser state up from (#1147): the history's file and the session's scope. */
export interface ReadSeed {
  file: string
  scope: string
}

/** What a transcript used so far (without its timeline, which stays here), with the size and modified time it was read at. */
export interface ReadResult {
  usage: SessionUsage
  size: number
  mtime: number
  /** A session on more than one model (HI-2675): its rows (shared/usageLedger.ts), by day and model, for pricing it. */
  rows?: LedgerRow[]
}

export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | { log: 'info' | 'warn'; text: string; path?: string }

/** How much of a transcript is read at a time (a longer line: a bigger piece). */
const CHUNK = 4 * 1024 * 1024
/** How often a running session's parser state is kept (a crash then reads at most this much again). */
const STATE_EVERY_MS = 10 * 60_000

let providers: AppSettings['providers'] | null = null
let appVersion = '0.0.0'
const dbs = new Map<string, Db>()

function dbOf(file: string): Db {
  const key = file.toLowerCase()
  let db = dbs.get(key)
  if (!db) {
    db = openDb(file, { migrations: USAGE_MIGRATIONS, appVersion, backupDir: join(dirname(file), 'backups'), backupFamily: 'usage' })
    dbs.set(key, db)
  }
  return db
}

/** The files it has open, by spelling, lower-cased (its code run in main's thread, in unit tests). */
export const openFiles = (): string[] => [...dbs.keys()]

/** Closes every file it has open (its code run in main's thread, in unit tests: so a test can delete its folder). */
export function closeAll(): void {
  for (const db of dbs.values()) db.close()
  dbs.clear()
}

function close(file: string): void {
  const key = file.toLowerCase()
  dbs.get(key)?.close()
  dbs.delete(key)
}

/**
 * Each file's wait to be openable before its first open (HI-2200, as the board's HI-2199): just after a Combwork ended
 * without quitting, another process can still map its `-shm`, and every open fails until it lets go. Here, in the
 * worker, the wait holds no one's typing; the file's requests wait with it. A close of the file meanwhile ends the wait,
 * marks it closed and lets it go, and the requests that waited on it are refused (the file isn't opened again for a
 * workspace that has gone); a request after the close waits afresh. Kept only while a wait runs: nothing stays per file.
 */
interface Openable {
  wait: Promise<void>
  stop: AbortController
  closed: boolean
}
const openables = new Map<string, Openable>()

/**
 * Waits for `file` to be openable, unless it is open already. `noWait` (a start's read, #1177): never waits, false when
 * it couldn't be opened now (or a wait for it is under way). Throws when the file was closed while it waited.
 */
async function whenOpenable(file: string, noWait = false): Promise<boolean> {
  const key = file.toLowerCase()
  if (dbs.has(key)) return true
  let w = openables.get(key)
  if (noWait) return !w && openableNow(file)
  if (!w) {
    const stop = new AbortController()
    let waiting = false
    const onWait = (e: Error): void => {
      waiting = true
      log('warn', `the usage history can't be opened yet: ${e.message} (SQLite code ${(e as { errcode?: number }).errcode}; another process still maps its -shm, as just after a Combwork ended without quitting): waiting up to ${OPENABLE_WAIT_MS / 1000} s`, file)
    }
    const entry: Openable = { wait: Promise.resolve(), stop, closed: false }
    entry.wait = untilOpenable(file, { onWait, signal: stop.signal }).then((ms) => {
      if (openables.get(key) === entry) openables.delete(key)
      if (waiting) log('info', `the usage history: ${entry.closed ? 'its wait ended with its close' : 'openable'} after ${Math.round(ms)} ms`, file)
    })
    openables.set(key, entry)
    w = entry
  }
  await w.wait
  if (w.closed) throw new Error('The usage history was closed while it waited to be opened.') // i18n-ignore: an internal error, for the log
  return true
}

/** How many files a wait to be openable is under way for (tests: nothing stays once each has ended). */
export const openableWaits = (): number => openables.size

/** A close received: what waits for the file to be openable stops, and is refused (HI-2200). */
function closing(file: string): void {
  const key = file.toLowerCase()
  const w = openables.get(key)
  if (!w) return
  w.closed = true
  w.stop.abort()
  openables.delete(key)
}

const send = (m: WorkerReply): void => parentPort!.postMessage(m)
/** Where the log goes: to main (from the worker thread), or what main set (its code run in main's own thread, in unit tests). */
let logTo: (m: WorkerReply) => void = (m) => parentPort?.postMessage(m)
export const logInProcess = (fn: (m: WorkerReply) => void): void => {
  logTo = fn
}
const log = (level: 'info' | 'warn', text: string, path?: string): void => logTo({ log: level, text, ...(path ? { path } : {}) })

/** Feeds a file to a parser from `offset` to its end (whole lines only); returns where it stopped. */
async function feed(path: string, parser: RawUsageParser, from: number): Promise<number> {
  // Whole lines only (a line still being written is read next time); a compressed backup decompressed (#1110).
  return readTranscript(path, from, (piece) => parser.feed(piece.toString('utf8')), CHUNK)
}

/** Files saved by a newer Combwork (opened read-only, db.ts): nothing is written to them, said once each. */
const warnedNewer = new Set<string>()
function readOnly(file: string): boolean {
  const db = dbOf(file)
  if (db.newer === null) return false
  if (!warnedNewer.has(file.toLowerCase())) {
    warnedNewer.add(file.toLowerCase())
    log('warn', `usage history: saved by a newer Combwork (schema ${db.newer}), so this one only reads it`, file)
  }
  return true
}

/** How much of a file just before a state's offset its check covers. */
const CHECK_BYTES = 4096

/** A hash of the bytes just before `offset` in a file (what a saved state was made from ends there); null when unreadable. */
async function bytesBefore(path: string, offset: number): Promise<string | null> {
  try {
    const fh = await open(path, 'r')
    try {
      const n = Math.min(CHECK_BYTES, offset)
      const buf = Buffer.alloc(n)
      const { bytesRead } = await fh.read(buf, 0, n, offset - n)
      return createHash('sha1').update(buf.subarray(0, bytesRead)).update(String(offset)).digest('hex')
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/**
 * Each transcript read in this run, by path (#1147), with the parser that read it: transcripts only grow, so one is read
 * from where the last read stopped (a long session's transcript can be hundreds of MB) rather than from the start. A
 * running session's footer and context gauge read it (`readUsage`), and so do the history's jobs (`ingest`): one parser for
 * both. Reads of one file take turns (`inTurn`), so no line is fed twice. At most MAX_PARSERS parsers are kept (each
 * holds its session's request history) and results for the usage cache size (Settings → Sessions), least recently used
 * first; nothing here outlives the worker (a new one takes the saved states up).
 */
interface ReadEntry {
  /** null once dropped (too many kept): the result stays, and a changed file is read again. */
  parser: RawUsageParser | null
  session: string
  provider: ProviderId
  /** Bytes fed so far, at a line boundary. */
  offset: number
  size: number
  mtime: number
  raw: SessionUsage | null
}
const reads = new Map<string, ReadEntry>()
const MAX_PARSERS = 200
let cacheSize = 5000
const readKey = (path: string): string => path.toLowerCase()

/** The entry for a file, as the most recently used. */
function touch(path: string): ReadEntry | undefined {
  const c = reads.get(readKey(path))
  if (c) {
    reads.delete(readKey(path))
    reads.set(readKey(path), c)
  }
  return c
}

function keep(path: string, c: ReadEntry): void {
  reads.delete(readKey(path))
  reads.set(readKey(path), c)
  let parsers = 0
  for (const e of reads.values()) if (e.parser) parsers++
  for (const [k, e] of reads) {
    if (parsers <= MAX_PARSERS && reads.size <= cacheSize) break
    if (reads.size > cacheSize) {
      reads.delete(k)
      if (e.parser) parsers--
    } else if (e.parser) {
      e.parser = null
      parsers--
    }
  }
}

/** The file's entry, when its parser can go on from where it stopped: the same session and provider, a file that only grew. */
function goOn(path: string, session: string, provider: ProviderId, size: number, mtime: number): ReadEntry | null {
  const c = touch(path)
  if (!c?.parser || c.session !== session || c.provider !== provider || isGz(path) || size < c.offset || (size === c.size && mtime !== c.mtime)) return null
  return c
}

/** Reads of one file, one at a time (a read and a job, or two reads). */
const turns = new Map<string, Promise<unknown>>()
function inTurn<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = readKey(path)
  const run = (turns.get(key) ?? Promise.resolve()).then(fn)
  const settled = run.catch(() => undefined)
  turns.set(key, settled)
  void settled.then(() => {
    if (turns.get(key) === settled) turns.delete(key)
  })
  return run
}

/**
 * A session's saved parser state, when it was made from this file's bytes: the same path, at least as long, its bytes
 * before the offset as they were (a file that shrank and grew again between reads is another), by this Combwork's parser.
 * A compressed backup (#1110) is finished and read whole: no state for it.
 */
async function takeUp(cur: ReturnType<typeof cursorOf>, path: string, size: number, provider: ProviderId, session: string): Promise<{ parser: RawUsageParser; from: number } | null> {
  if (isGz(path) || !cur?.state || !cur.path || cur.path.toLowerCase() !== path.toLowerCase() || cur.stateOffset === null || cur.stateOffset > size || cur.stateVersion !== appVersion || !cur.stateShape) return null
  if (cur.stateCheck !== (await bytesBefore(path, cur.stateOffset))) return null
  const parser = restoreParser(provider, session, cur.state, cur.stateShape)
  return parser ? { parser, from: cur.stateOffset } : null
}

/**
 * A result as main gets it: without its timeline (cost per card reads the history's); without the CLI's cost reports
 * for a session that ran on a server connection (HI-1772, `reportsIgnored`).
 */
const readResult = (c: ReadEntry, reportsIgnored = false): ReadResult => {
  const raw = reportsIgnored ? withoutCostReports(c.raw!) : c.raw!
  const { timeline: _timeline, ...usage } = raw
  // A session on more than one model (HI-2675): its rows by day and model too, so main prices it a model at a time, as
  // the history does (a model with no price leaves the cost a part), not every token at the session's model's price.
  const models = new Set([...(raw.timeline?.models ?? []), raw.model ?? ''].filter(Boolean))
  return { usage, size: c.size, mtime: c.mtime, ...(models.size > 1 ? { rows: ledgerRows(raw, [], providers ? { providers } : null) } : {}) }
}

/**
 * What a transcript used so far, for main (#1147): unchanged since it was last read, as it was; else what it added, fed
 * to its parser. One not read in this run (Combwork restarted, a session resumed) takes its session's saved state up from the
 * history (`seed`), so only what was added since is read; without one, it is read from the start, here, never in main.
 * Null when it can't be read, or for a provider this Combwork can't read.
 */
async function readUsage(path: string, session: string, provider: ProviderId, seed: ReadSeed | null, noWait = false, reportsIgnored = false): Promise<ReadResult | null> {
  // A start's read (#1177) never queues behind the file's turn (the import ingesting it): it gets nothing instead.
  if (noWait && turns.has(readKey(path))) return null
  return inTurn(path, async () => {
    let st
    try {
      st = await stat(path)
    } catch {
      return null
    }
    const had = touch(path)
    if (had?.raw && had.size === st.size && had.mtime === st.mtimeMs && had.session === session && had.provider === provider) return readResult(had, reportsIgnored)
    let c = goOn(path, session, provider, st.size, st.mtimeMs)
    if (!c) {
      let taken: Awaited<ReturnType<typeof takeUp>> = null
      if (seed) {
        try {
          // Its history openable first (HI-2200); a start's read never waits for it: it gets nothing instead, as when the
          // file's turn is taken.
          if (!(await whenOpenable(seed.file, noWait))) return null
          taken = await takeUp(cursorOf(dbOf(seed.file).reader, seed.scope, session), path, st.size, provider, session)
        } catch (e) {
          log('warn', `usage history: couldn't look for a session's saved state (${(e as Error).message})`, seed.file)
        }
      }
      const parser = taken?.parser ?? newUsageParser(provider, session)
      if (!parser) return null
      c = { parser, session, provider, offset: taken?.from ?? 0, size: 0, mtime: 0, raw: null }
    }
    try {
      if (isGz(path) || st.size > c.offset) c.offset = await feed(path, c.parser!, c.offset)
    } catch (e) {
      // Fed in part: what it read can't be gone on from.
      reads.delete(readKey(path))
      log('warn', `usage: couldn't read a transcript (${(e as Error).message})`, path)
      return null
    }
    c.size = st.size
    c.mtime = st.mtimeMs
    c.raw = c.parser!.result()
    keep(path, c)
    return readResult(c, reportsIgnored)
  })
}

/**
 * Records what a session used from its file: unchanged since it was read, nothing (its cards re-shared from what is stored
 * when their holds changed); else from where it was left (its parser's saved state, made from this file's bytes), or from
 * the start (no state of this parser's shape and Combwork's version, a file that shrank or is another). Usage history is only
 * added to (#1106 round 3): what it read replaces the session's rows when it counts at least as much, every day, in each
 * count; when it doesn't (a backup that lags the transcript it replaced, a rewritten file), what the rows counted becomes
 * part of the session's baseline, which no write goes below, so both are kept. `failed`: the file couldn't be read (it
 * is there, or can't be told), so what is recorded may lack its end: a delete waits.
 */
async function ingest(file: string, job: IngestJob): Promise<IngestResult> {
  if (readOnly(file)) return { status: 'busy' }
  const db = dbOf(file).writer
  const cur = cursorOf(db, job.scope, job.session)
  // Its CLI's cost reports aren't counted (HI-1772) when the job says so or the history already does: one way, so a
  // late job from before the session was marked never brings them back. Turned just now: nothing recorded is kept as
  // it was (re-read, or its stored rows stripped when there is nothing to read).
  const ignore = !!job.reportsIgnored || !!cur?.reportsIgnored
  const turned = ignore && !!cur && !cur.reportsIgnored
  // Free (HI-1772): a run on a server on this PC and never one anywhere else, each kept once set (the job's or the
  // history's: a stale job can't make a session free again). Changed just now: re-read, as above.
  const serverLocal = !!job.serverLocal || !!cur?.serverLocal
  const notLocal = !!job.notLocal || !!cur?.notLocal
  const wasFree = !!cur && cur.serverLocal && !cur.notLocal
  const changed = turned || (!!cur && serverLocal && !notLocal) !== wasFree
  const unchanged = (): IngestResult => {
    if (changed) return stripStored(db, job, { serverLocal, notLocal })
    // Its locality as the job says it, kept for good even when nothing else changed (HI-1772 round 3 follow-up): a
    // later stale job then meets the stored disqualifier.
    if (cur && ((job.serverLocal && !cur.serverLocal) || (job.notLocal && !cur.notLocal))) markLocality(db, job.scope, job.session, { serverLocal: !!job.serverLocal, notLocal: !!job.notLocal })
    updateMeta(db, job, job.external ? 'external' : 'transcript')
    reshare(db, job, cur)
    return { status: 'unchanged' }
  }
  if (!job.path) return cur ? unchanged() : { status: 'missing' }
  let st
  try {
    st = await stat(job.path)
  } catch (e) {
    // Gone: what is recorded is all there is. Anything else (no permission, held, a disk error): not known.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return cur ? unchanged() : { status: 'missing' }
    log('warn', `usage history: couldn't look at a transcript (${(e as Error).message})`, job.path)
    return { status: 'failed' }
  }
  if (!st.isFile()) return cur ? unchanged() : { status: 'missing' }
  const samePath = !!cur?.path && cur.path.toLowerCase() === job.path.toLowerCase()
  if (!changed && cur && samePath && cur.size === st.size && cur.mtime === st.mtimeMs) return unchanged()
  // The parser this run read the file with (a running session's footer, an earlier job), when it is at least as far on as
  // the saved state; else the saved state taken up (takeUp), else a new parser from the start.
  let parser: RawUsageParser | null = null
  let from = 0
  const live = goOn(job.path, job.session, job.provider, st.size, st.mtimeMs)
  if (live && (!samePath || cur?.stateOffset == null || live.offset >= cur.stateOffset)) {
    parser = live.parser
    from = live.offset
  } else {
    const taken = await takeUp(samePath ? cur : null, job.path, st.size, job.provider, job.session)
    if (taken) ({ parser, from } = taken)
  }
  parser ??= newUsageParser(job.provider, job.session)
  if (!parser) return cur ? unchanged() : { status: 'missing' }
  let offset: number
  try {
    offset = await feed(job.path, parser, from)
  } catch (e) {
    // A parser fed in part can't be gone on from.
    if (live?.parser === parser) reads.delete(readKey(job.path))
    log('warn', `usage history: couldn't read a transcript (${(e as Error).message})`, job.path)
    return { status: 'failed' }
  }
  // A session that ran on a server connection (HI-1772): its CLI's cost reports aren't counted.
  const read0 = parser.result()
  const raw = ignore ? withoutCostReports(read0) : read0
  // What it read is kept for the next read of a running session (the footer's, the next tick's); a session that ended
  // has its state saved below, and its parser is let go.
  if (job.keepState === 'now') reads.delete(readKey(job.path))
  else if (live?.parser === parser || job.keepState === 'running') keep(job.path, { parser, session: job.session, provider: job.provider, offset, size: st.size, mtime: st.mtimeMs, raw: read0 })
  // Read again after the awaits: what another writer recorded meanwhile is checked in the write.
  const now = cursorOf(db, job.scope, job.session)
  const settings = providers ? { providers } : null
  const stored = now ? storedSession(db, job.scope, job.session) : null
  // Without reports: what was recorded is compared and kept without its CLI's charges too (HI-1772).
  const ignoreNow = ignore || !!now?.reportsIgnored
  const storedRows = stored ? (ignoreNow ? rowsWithoutReports(stored.rows) : stored.rows) : []
  let baseline = now ? baselineOf(db, job.scope, job.session) : []
  const strippedBaseline = ignoreNow && baseline.some((d) => d.costUsd !== null && !d.costEstimated)
  if (ignoreNow) baseline = baselineWithoutReports(baseline)
  const read = ledgerRows(raw, job.holds, settings)
  let rows = sessionRows(read, baseline, job.provider, settings)
  let grew = strippedBaseline
  if (stored && !dominates(rows, storedRows)) {
    // Less of something than recorded: what was recorded joins the baseline, and neither is lost.
    baseline = mergeBaselines(baseline, baselineOfRows(storedRows))
    rows = sessionRows(read, baseline, job.provider, settings)
    grew = true
    log('info', `usage history: ${job.session} read less of something than recorded: what was recorded is kept beside it`, job.path)
  }
  // Free (HI-1772): every row and day a known $0 covering its tokens; counted as any session's.
  const local = { serverLocal: serverLocal || !!now?.serverLocal, notLocal: notLocal || !!now?.notLocal }
  if (local.serverLocal && !local.notLocal) {
    rows = rowsAsFree(rows)
    if (baseline.length) {
      baseline = baselineAsFree(baseline)
      grew = true
    }
  }
  const due = !isGz(job.path) && (job.keepState === 'now' || (job.keepState === 'running' && (!now?.stateAt || Date.now() - Date.parse(now.stateAt) >= STATE_EVERY_MS)))
  const w: SessionWrite = {
    ...job,
    // An external session a record now has is Combwork's; one recorded as Combwork's stays so.
    source: job.external && (!now || now.source === 'external') ? 'external' : 'transcript',
    path: job.path,
    size: st.size,
    mtime: st.mtimeMs,
    offset,
    state: due ? { data: saveParser(parser), offset, shape: parserShape(parser), version: appVersion, check: (await bytesBefore(job.path, offset)) ?? '' } : from === 0 ? 'clear' : null,
    summary: summaryOf(raw),
    timeline: raw.timeline ?? null,
    rows,
    holdsKey: job.holdsKey,
    baseline: grew ? baseline : null,
    ...(ignoreNow ? { reportsIgnored: true } : {}),
    ...(local.serverLocal ? { serverLocal: true } : {}),
    ...(local.notLocal ? { notLocal: true } : {})
  }
  const ok = writeSession(db, w, now ? { offset: now.offset, path: now.path } : null)
  return { status: ok ? 'written' : 'busy', requests: raw.requests }
}

/**
 * A recorded session whose pricing changed (HI-1772: its CLI's cost reports no longer counted, or it became free or
 * stopped being free) with nothing to read again (its transcript gone, or unchanged): its stored rows and baseline
 * written again without those charges, as a known $0 while free, counts and cards as they were.
 */
function stripStored(db: DatabaseSync, job: IngestJob, local: { serverLocal: boolean; notLocal: boolean }): IngestResult {
  const now = cursorOf(db, job.scope, job.session)
  const stored = now ? storedSession(db, job.scope, job.session) : null
  if (!now || !stored) return { status: 'missing' }
  const timeline = storedTimelines(db, job.scope).find((s) => s.session === job.session)?.timeline ?? null
  const free = (local.serverLocal || now.serverLocal) && !(local.notLocal || now.notLocal)
  const w: SessionWrite = {
    ...job,
    source: now.source === 'external' ? 'external' : 'transcript',
    path: now.path,
    size: now.size,
    mtime: now.mtime,
    offset: now.offset,
    state: null,
    summary: stored.summary,
    timeline: timeline ? { ...timeline, reports: [], rows: timeline.rows.map((r) => (r[6] >= 0 ? (Object.assign([...r], { 6: -1 }) as typeof r) : r)) } : null,
    rows: free ? rowsAsFree(stored.rows) : rowsWithoutReports(stored.rows),
    holdsKey: now.holdsKey,
    baseline: free ? baselineAsFree(baselineOf(db, job.scope, job.session)) : baselineWithoutReports(baselineOf(db, job.scope, job.session)),
    reportsIgnored: true,
    ...(local.serverLocal ? { serverLocal: true } : {}),
    ...(local.notLocal ? { notLocal: true } : {})
  }
  return { status: writeSession(db, w, { offset: now.offset, path: now.path }) ? 'written' : 'busy' }
}

/** A recorded session's cards shared out again from what is stored, when the holds its rows were made by changed. */
function reshare(db: DatabaseSync, job: { scope: string; session: string; holds: SessionHold[]; holdsKey: string | null }, cur: { holdsKey: string | null } | null): boolean {
  if (!cur || cur.holdsKey === job.holdsKey) return false
  const s = storedSession(db, job.scope, job.session)
  if (!s) return false
  const settings = providers ? { providers } : null
  replaceRows(db, job.scope, job.session, sessionRows(reshareRows(s.summary, s.timeline, s.rows, job.holds, settings), baselineOf(db, job.scope, job.session), s.summary.provider, settings), job.holdsKey)
  return true
}

/**
 * Records a kept usage (a deleted session's, or a record's whose transcript went) as part of the session's baseline: its
 * rows (from its file, if it was read) never go below it, day by day, in each count, nor its known cost; a session the
 * history doesn't have yet is recorded from it alone. Nothing either counted is dropped for the other.
 */
function kept(file: string, job: KeptJob): IngestResult {
  if (readOnly(file)) return { status: 'busy' }
  const db = dbOf(file).writer
  const cur = cursorOf(db, job.scope, job.session)
  const settings = providers ? { providers } : null
  const baseline = mergeBaselines(cur ? baselineOf(db, job.scope, job.session) : [], baselineOfUsage(job.usage))
  if (cur) {
    const s = storedSession(db, job.scope, job.session)
    if (!s) return { status: 'busy' }
    // Its rows shared out by its holds now (a kept usage alone: its cards' unknown parts), the merged baseline applied.
    replaceRows(db, job.scope, job.session, sessionRows(reshareRows(s.summary, s.timeline, s.rows, job.holds, settings), baseline, job.provider, settings), job.holdsKey, baseline)
    return { status: 'written', requests: job.usage.requests }
  }
  const w: SessionWrite = { ...job, source: 'kept', path: null, size: 0, mtime: 0, offset: 0, state: 'clear', summary: summaryOf({ ...job.usage, lastPrompt: null }), timeline: null, rows: sessionRows(unknownOnCards(job.usage, job.holds), baseline, job.provider, settings), holdsKey: job.holdsKey, baseline }
  return { status: writeSession(db, w, null) ? 'written' : 'busy', requests: job.usage.requests }
}

/**
 * Shares the cards of a scope's recorded sessions out again by their holds now, without reading a file (#1106 round 3):
 * stopped and deleted sessions too, each whose holds key changed. Main works the holds out per agent.
 */
function attribute(file: string, scope: string, sessions: { session: string; holds: SessionHold[]; holdsKey: string | null }[]): number {
  if (readOnly(file)) return 0
  const db = dbOf(file).writer
  let n = 0
  for (const s of sessions) if (reshare(db, { scope, ...s }, cursorOf(db, scope, s.session))) n++
  return n
}

/**
 * What one roll-up batch did (HI-1648): sessions it tried (each it looked at, not running) and merged, their rows before
 * and after, and whether more may be left.
 */
export interface RollUpResult {
  tried: number
  sessions: number
  rows: number
  merged: number
  more: boolean
}

/** How long one roll-up batch goes on, so a job or query waiting behind it waits little. */
const ROLL_UP_BATCH_MS = 50
/** The most sessions one batch looks at. */
const ROLL_UP_LIMIT = 500

/**
 * A batch of ended sessions' timelines merged into 1-hour steps (HI-1648, Darren 27 Oct): those last active before
 * Settings → Advanced's days of full detail, oldest first, each in a transaction of its own, for ROLL_UP_BATCH_MS at
 * most, but always one (review round 1: a slow lookup used the time up, and the batch that tried none read as the end);
 * never one running (`live`: their ids). Main sends batches until one tries none or none are left.
 */
function rollUp(file: string, live: string[], now = Date.now()): RollUpResult {
  const out: RollUpResult = { tried: 0, sessions: 0, rows: 0, merged: 0, more: false }
  if (readOnly(file)) return out
  const db = dbOf(file).writer
  const days = advancedValues.get<number>(USAGE_TIMELINE_DETAIL_DAYS)
  const before = new Date(now - days * 86_400_000).toISOString()
  const running = new Set(live)
  const t0 = Date.now()
  const found = rollUpCandidates(db, before, COARSE_STEP, ROLL_UP_LIMIT)
  // A full list may have more after it.
  out.more = found.length === ROLL_UP_LIMIT
  for (const c of found) {
    if (running.has(c.session)) continue
    if (out.tried && Date.now() - t0 > ROLL_UP_BATCH_MS) {
      out.more = true
      break
    }
    out.tried++
    const r = rollUpSession(db, c.scope, c.session, before, COARSE_STEP, (t) => coarsenTimeline(t, COARSE_STEP))
    if (r) Object.assign(out, { sessions: out.sessions + 1, rows: out.rows + r.rows, merged: out.merged + r.merged })
  }
  return out
}

/** The space roll-ups freed given back (giveSpaceBack), logged with the file's size before and after when it changed. */
function spaceBack(file: string): { before: number; after: number; whole: boolean } | null {
  if (readOnly(file)) return null
  const db = dbOf(file).writer
  const size = (): number => {
    const s = fileSpace(db)
    return s.pages * s.pageSize
  }
  const t0 = Date.now()
  const before = size()
  const whole = giveSpaceBack(db)
  const after = size()
  if (whole || after !== before) log('info', `usage history: ${whole ? 'vacuumed once, to give space back from now on' : 'free space given back'}: ${before} → ${after} bytes in ${Date.now() - t0} ms`, file)
  return { before, after, whole }
}

/** Jobs one at a time; queries at once. (Exported for main to run it in its own thread in unit tests: usageHistory.ts.) */
let jobs: Promise<unknown> = Promise.resolve()

export async function handleRequest(m: WorkerRequest): Promise<unknown> {
  if (m.type === 'close') closing(m.file)
  else if ('file' in m) await whenOpenable(m.file)
  switch (m.type) {
    case 'config':
      readAdvancedFrom(valuesReader(m.advanced))
      providers = m.providers
      appVersion = m.appVersion
      if (m.cacheSize) cacheSize = m.cacheSize
      return true
    case 'ingest':
    case 'kept': {
      // An ingest takes its file's turn with the reads, which share its parser.
      const run = jobs.then(() => (m.type === 'kept' ? kept(m.file, m.job) : m.job.path ? inTurn(m.job.path, () => ingest(m.file, m.job)) : ingest(m.file, m.job)))
      jobs = run.catch(() => undefined)
      return run
    }
    case 'sessions':
      return storedSessions(dbOf(m.file).reader, m.scopes)
    case 'cards':
      return cardRows(dbOf(m.file).reader, m.cards)
    case 'timelines':
      return storedTimelines(dbOf(m.file).reader, m.scope, m.sessions)
    case 'ids':
      return sessionIds(dbOf(m.file).reader, m.scope)
    case 'meta': {
      const db = dbOf(m.file)
      if (m.value !== undefined && !readOnly(m.file)) setMeta(db.writer, m.scope, m.key, m.value)
      return getMeta(db.writer, m.scope, m.key)
    }
    case 'attribute': {
      const run = jobs.then(() => attribute(m.file, m.scope, m.sessions))
      jobs = run.catch(() => undefined)
      return run
    }
    case 'rollUp': {
      const run = jobs.then(() => rollUp(m.file, m.live, m.now))
      jobs = run.catch(() => undefined)
      return run
    }
    case 'spaceBack': {
      const run = jobs.then(() => spaceBack(m.file))
      jobs = run.catch(() => undefined)
      return run
    }
    case 'forgetStates': {
      if (readOnly(m.file)) return 0
      const r = dbOf(m.file).writer.prepare('UPDATE usage_sessions SET state = NULL, state_offset = NULL, state_shape = NULL, state_version = NULL, state_check = NULL, state_at = NULL WHERE state IS NOT NULL AND updated_at < ?').run(m.before) // i18n-ignore: SQL
      return Number(r.changes)
    }
    case 'read':
      // At once, not after the jobs: a running session's footer never waits for an import.
      return readUsage(m.path, m.session, m.provider, m.seed, m.noWait, m.reportsIgnored)
    case 'forgetReads':
      reads.clear()
      return true
    case 'close': {
      // After the jobs sent before it.
      const run = jobs.then(() => close(m.file))
      jobs = run.catch(() => undefined)
      return run
    }
  }
}

parentPort?.on('message', (m: WorkerRequest) => {
  handleRequest(m).then(
    (value) => send({ id: m.id, ok: true, value }),
    (e) => send({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  )
})
