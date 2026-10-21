import { basename, dirname, join, resolve } from 'path'
import { writeFile } from 'original-fs/promises'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { HIVE_DIR } from '../shared/defaults'
import {
  DELIVERY_BODY_MAX_CHARS,
  DELIVERY_EXPIRY_HOURS,
  OVERDUE_MINUTES,
  deliveryRow,
  goesAlone,
  inboxItems,
  inboxSummary,
  isLive,
  isUnread,
  isWaiting,
  moved,
  needsAck,
  offerLine,
  readDelivery,
  type DeliveryKind,
  type DeliveryNeed,
  type DeliveryRecord,
  type DeliveryRow,
  type DeliverySender,
  type DeliveryState,
  type InboxItem
} from '../shared/deliveries'
import { reviewRounds } from '../shared/laneBar'
import type { TaskCard } from '../shared/types'
import * as assistant from './assistantControl'
import { config } from './config'
import { onHiveEvent } from './events'
import { readCapped, readJson, renameRetrying } from './fsutil'
import { openTable, readStore, saveTable, storeValue } from './storeRows'
import { dbGeneration, onDbReplaced, upgradeWaiting, workspaceDb } from './boardStore'
import { addDeliveriesFile, countDeliveries, readDeliveries as readDeliveryRows, writeDeliveries } from './schema/sessionDeliveryTables'
import { canTypeLine, typeLine, whyNoLine } from './lineWriter'
import { createLogger, userText } from './logger'
import { readyFor } from './readiness'
import { sessions } from './sessions'
import { folderChanging, folderSteady, inFolder, onFolderSteady } from './folderFence'
import { getTask } from './tasks'
import { workspaceFor } from './workspace'
import { cardRef } from '../shared/projectKeys'
import { scopeOfHost, withCardNames } from './projectKeys'

/**
 * The delivery service (#647, plans/2026-10-12-messaging-redesign.md §3.1). Everything Hive has for an agent to read is a
 * delivery record (shared/deliveries.ts), saved in its session host's .hive/deliveries.json (a project's, or the
 * Assistant's home's) with atomic writes, and restored when Hive starts. Every way into an agent makes one (#649): a
 * message, a task, a watch's or a loop's wake, the user's decisions, a mode notice, a lock's go-ahead, the carry-on after
 * a sign-in, a handover. This service alone offers them, to an idle agent by typing the doorbell (#650: Hive's fixed
 * words with counts and ids, shared/doorbell.ts, through lineWriter.typeLine); a busy one is told in its hooks' replies
 * instead (inboxNotices.ts). Producers neither type nor keep their own cursors.
 *
 * **Receipts.** A typed doorbell makes what it names offered. It is received only when the agent fetches it with
 * hive_inbox (#650: the doorbell carries no text, so its CLI taking the line is no receipt); never because it was typed.
 * A card event or a control notice is done then; a message, a task, a handover or the user's answer waits for the agent's
 * ack (hive_inbox), and one not acked OVERDUE_MINUTES after it was made is overdue. A doorbell its CLI took whose agent is
 * idle again without having read it rings once more (#650: its turn's Stop drain asked it first), never a third time; it
 * stays offered, unread in the pane, until it is read. One offered when Hive stopped, or when its agent's launch ended
 * before it was read, is uncertain: it may not have reached the agent, so it is offered once more, saying it may repeat,
 * and stays uncertain (shown) if that one isn't received either.
 *
 * **No inbox** (Darren's decision on #650): an agent that can't read an inbox (`readsInbox`: a project agent while the
 * Agent API or its hive server is off) is given no delivery, and its bodies are never typed instead: each is refused with
 * the reason its sender sees (`noInbox`: made, NoInbox; one already waiting, refused when next looked at). Only the
 * user's own action, a task they give it from Hive (Start), is typed as their input, as their typing in its pane is: no
 * delivery, no receipt.
 *
 * **Sources.** What made a delivery (`source`: a watch, a loop wake…) registers itself here: it can make its line again
 * just before it is offered, from things as they are then (`refresh`; null: no longer due, and it is cancelled), say
 * whether it still holds before each key (`holds`), and is told when it is received (its cursor moves on then, never on
 * "typed") or ends. A live delivery's source and `ref` name it: the same one is never made twice.
 *
 * **Transactions.** Each host's records change one transaction at a time (`transact`, under the host's lock): planned on
 * a copy of what is published, with its checks (below), saved by one atomic write, and only then published, so nothing (a
 * read, the pane) ever sees a change that isn't on disk. An operation takes effect at that save: a permission change that
 * lands while it is saved applies to the next operation, not this one (it was decided before). A save that fails changes
 * nothing, on disk or in memory (NotSaved): the rename never happened. The offer's writer checks again before each piece
 * of the line and its Enter (`offerHolds`).
 *
 * **Authority.** A sender's permission is worked out again at every step, from the sender saved with it and the settings
 * now (never a closure or token): the Assistant's needs Settings → Assistant → Control at Control agents and the launch
 * that sent it still running (#645: a launch that has ended sends nothing more; its waiting messages are refused, and the
 * refusal is in the Assistant's activity list and the agent's). One is for its agent's conversation when that was known.
 *
 * **Relevance** (#652). One tied to a card's round (`card` and `round`: a re-brief for the work under way) is stale once
 * that card has moved on (passed, done or archived, out of Doing and Review, or in a later round): ended as stale, with
 * why, never offered or given: checked under the host's lock as an offer or a read is planned (`relevanceNow`, judged
 * current right before the plan and read again if the board changed meanwhile; overtaken every time, the tied ones are
 * held back unread rather than judged on an outdated read), and as the board changes (`sweepStale`), so a doorbell
 * already rung for it finds nothing. On #699 (13 Oct) the Assistant's re-brief for a round's finding reached its
 * builder a second after the card passed, and it reopened the card to apply it.
 *
 * The rules, for every operation (create, offer, readInbox, ack, cancel): **one async lock per host**, inside it copy,
 * check (sender permission, expiry, the target conversation) and change the copy, save atomically, then publish and
 * return; no check after the save. A line typed into the agent is checked again by its writer before each key with the
 * same check (`offerHolds`); one that no longer holds gets no Enter. Once typed, the doorbell is never cleared or
 * withdrawn (#652): it names ids, never what they say, so an Enter again for one that no longer holds gives the agent
 * nothing (hive_inbox checks each delivery as it reads it). One the user typed into before its CLI took it is theirs:
 * never submitted by Hive, what it named waits again, and nothing more is typed there until a prompt is sent
 * (sessions.leaveToUser).
 */

const log = createLogger('deliveries')

/** Ended deliveries kept per agent (the newest), and for how long at most. */
const KEEP_ENDED = 50
const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000
/** Received deliveries never acked are kept this long, then expire. */
const KEEP_RECEIVED_MS = 7 * 24 * 60 * 60_000
/** The most deliveries a host keeps live; more are refused when made. */
export const MAX_LIVE_PER_HOST = 500
/** The most Hive reads back from a deliveries file; what it writes stays within fileBudget, half of it. */
const MAX_FILE_BYTES = 8 * 1024 * 1024
let fileBudget = 4 * 1024 * 1024
/** Room kept for each live delivery to grow to its end (its times, receipt, a reason it ended). */
const GROWTH_PER_LIVE = 800
/** For tests: a smaller budget for the file. */
export const setFileBudgetForTests = (bytes: number): void => {
  fileBudget = bytes
}

/** How long until a delivery is overdue: OVERDUE_MINUTES, or an unpackaged test build's (HIVE_TEST_DELIVERY_OVERDUE_MS). */
export const overdueMs = (): number => {
  const t = !app.isPackaged ? Number(process.env.HIVE_TEST_DELIVERY_OVERDUE_MS) : NaN
  return Number.isFinite(t) && t > 0 ? t : OVERDUE_MINUTES * 60_000
}

/** The run a delivery made for a launch is offered into until that launch has started (launchWith). */
const LAUNCHING = 'launching'

/** Why a delivery may repeat when it is offered once more (#649). */
const AGAIN_RESTART = 'Hive restarted while offering it'
const AGAIN_LAUNCH = 'its session ended or restarted before it was read'

interface Store {
  host: string
  /** Where its deliveries are kept (#1018): its workspace's database, under its host's scope (hostPlace). */
  place: { workspace: string; scope: string }
  /** What is published: saved, and what every read sees. Never changed in place: a transaction replaces it. */
  records: readonly DeliveryRecord[]
  next: number
  /** Saved entries that aren't deliveries (a hand edit, a newer build's): kept aside in the file as they were, not used. */
  invalid: readonly unknown[]
  /** Transactions, one after another. */
  lock: Promise<unknown>
  /** The ids a line being typed now offers: cancelled meanwhile, its typing stops. */
  offering: Set<string>
  /**
   * The ids a typed doorbell offers, by the launch and its prompt count just before the line's Enter: taken once the count
   * rises in that launch (rung once more if its agent is idle again without reading it). Kept until it leaves offered.
   */
  confirming: Map<string, { runId: string; count: number }>
  /** Deliveries whose doorbell has rung a second time (#650): never a third. In memory: a restart offers once more anyway. */
  rungAgain: Set<string>
  /** Deliveries launched into a run whose saving may have failed (launchWith): the run they went into, by id. */
  launches: Map<string, string>
  /**
   * What the producer of a delivery gave with it (#649, in memory only: one that can't outlive its launch, such as a lock's
   * go-ahead): its own check, asked with offerHolds, and what to do once it is received or ends without that.
   */
  hooks: Map<string, DeliveryHooks>
  /** The workspace database's generation it was read from (#1207 round 2): from an older one, it is stale and never saved. */
  gen: number
}

/** A transaction's working copy: planned on, saved, then published. */
interface Draft {
  records: DeliveryRecord[]
  next: number
  invalid: unknown[]
  dirty: boolean
  /** What to do once it is published (log lines, the Assistant's activity list, sources told): nothing for a plan that isn't. */
  after: (() => void)[]
}

const stores = new Map<string, Store>()
const loading = new Map<string, Promise<Store>>()
const keyOf = (host: string): string => host.toLowerCase()
/** A host's deliveries file before #1018: moved into its workspace's database the first time, then kept as a backup. */
const fileOf = (host: string): string => join(host, HIVE_DIR, 'deliveries.json')

/**
 * Where a host's deliveries are kept (#1018): its workspace's database (a project's workspace is its parent folder; the
 * Assistant's home is the workspace's `.hive/assistant`), under the project's stable id (#508), so they follow a rename
 * as its folder's file did; the Assistant's under `assistant`, and a folder with no id yet under its name.
 */
async function hostPlace(host: string): Promise<{ workspace: string; scope: string }> {
  const h = resolve(host)
  const parent = dirname(h)
  if (basename(h).toLowerCase() === 'assistant' && basename(parent).toLowerCase() === HIVE_DIR) return { workspace: dirname(parent), scope: 'assistant' }
  const ws = workspaceFor(h)
  const known = ws ? (await ws.projectIds().catch(() => null))?.byPath.get(h.toLowerCase()) : undefined
  const saved = known ?? (await readJson<{ id?: unknown } | null>(join(h, HIVE_DIR, 'project.json'), null))?.id
  return { workspace: parent, scope: typeof saved === 'string' && saved ? saved : `folder:${basename(h).toLowerCase()}` }
}
const nowIso = (): string => new Date().toISOString()

/** Hive couldn't save a change, so it wasn't made. */
export class NotSaved extends Error {}
/** A delivery refused because too many of its kind wait already for its agent (NewDelivery.maxWaiting). */
export class TooManyWaiting extends Error {}
/** A delivery refused because its project's deliveries are full (MAX_LIVE_PER_HOST, or the file's budget). */
export class DeliveriesFull extends Error {}
/** A delivery wanted now (deliverNow) that couldn't be given: why. It was cancelled. */
export class NotGiven extends Error {}

/**
 * A producer's part in its deliveries (#649), registered once by name (`source` on the delivery): made again just before
 * it is offered or handed out (`refresh`: the line from things as they are now, with what its receipt will need, `meta`,
 * saved on the delivery as that version; or cancelled when it is no longer due); checked before each piece and Enter of
 * its line (`holds`); told when it is received (`received`: its cursor moves on, from the received version's own `meta`,
 * never from what a later refresh prepared) or ends without that (`ended`). Called outside the host's lock.
 */
export interface DeliverySource {
  refresh?: (r: DeliveryRecord, host: string) => Promise<Fresh | null>
  holds?: (r: DeliveryRecord, host: string) => boolean
  received?: (r: DeliveryRecord, host: string) => void
  ended?: (r: DeliveryRecord, host: string) => void
}
const sources = new Map<string, DeliverySource>()
/** What a source says of a delivery made again: its text and context as they are now (one version), or why it is cancelled. */
type Fresh = { body: string; meta?: Record<string, string | number | boolean> } | { cancel: string }

/** A producer's own part in one delivery, given when it is made (in memory only): see Store.hooks. */
export interface DeliveryHooks {
  holds?: () => boolean
  received?: () => void
  ended?: () => void
}
/** Registers a producer's part (once per name; again replaces it). */
export function registerSource(name: string, s: DeliverySource): void {
  sources.set(name, s)
}

/** Runs fn after the host's transactions before it (and before later ones). */
function locked<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const run = store.lock.then(fn)
  store.lock = run.catch(() => undefined)
  return run
}

/**
 * A transaction (see the top): `plan` checks and changes a copy of what is published (synchronously, under the host's
 * lock); a copy it changed is saved (`save`: one atomic write) and then published, and `plan`'s result returned. A plan
 * that throws, or a save that fails (NotSaved), leaves the deliveries file and what is published as they were.
 */
function transact<T>(store: Store, plan: (d: Draft) => T): Promise<T> {
  return transactAfter(store, async () => undefined, (d) => plan(d))
}

/**
 * A transaction whose plan needs something read first, under the host's lock (#652: the cards that deliveries tied to a
 * round are for): `read` runs once the lock is held, so from what is published then (a delivery made while it waited
 * included), and again while `again` says what it read was overtaken (at most READS times). `again` is asked last with
 * nothing awaited between it and the plan, so the plan knows whether what it was given is still current (it says so
 * itself, from the same check).
 */
function transactAfter<P, T>(store: Store, read: () => Promise<P>, plan: (d: Draft, got: P) => T, again?: (got: P) => boolean): Promise<T> {
  running++
  return locked(store, async () => {
    let got = await read()
    await beforePlan?.()
    for (let i = 1; i < READS; i++) {
      if (!again?.(got)) break
      got = await read()
      await beforePlan?.()
    }
    // From here to the save, nothing is awaited: the plan is made from `got` as `again` last judged it.
    const d: Draft = { records: [...store.records], next: store.next, invalid: [...store.invalid], dirty: false, after: [] }
    const planned = plan(d, got)
    if (!d.dirty) return planned
    try {
      await save(store, d)
    } catch (e) {
      throw new NotSaved(`Hive couldn't save the deliveries (${(e as Error).message}): nothing changed.`, { cause: e })
    }
    store.records = d.records
    store.next = d.next
    store.invalid = d.invalid
    for (const f of d.after) f()
    return planned
  }).finally(() => running--)
}

/** How many times a transaction's read is made, at most, when what it read keeps being overtaken (transactAfter). */
const READS = 5
/** For tests: run after a transaction's read, before it is judged current and planned (to change the board between them). */
let beforePlan: (() => Promise<void> | void) | null = null
export const setBeforePlanForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforePlan = fn
}
/** For tests: awaited as a host's load begins, before anything is read (a read held up, as a slow disk would). */
let beforeRead: (() => Promise<void> | void) | null = null
export const setBeforeReadForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforeRead = fn
}

/** Transactions not finished yet (also those nothing waits for): what settled() waits for. */
let running = 0
/** Whether the service has a change in flight (watches' and loop wakes' settled() wait for it, #570). */
export const inFlightNow = (): boolean => running > 0 || trying.size > 0
/** Resolves once no change or offer is in flight, and what sources were told of them has run. */
export async function settled(): Promise<void> {
  while (inFlightNow()) {
    await Promise.allSettled([...stores.values()].map((s) => s.lock))
    await Promise.allSettled([...trying.values()])
    await new Promise((r) => setImmediate(r))
  }
}

/** A transaction nothing waits for (one that follows what happened); a failure is logged. */
function transactSoon(store: Store, what: string, plan: (d: Draft) => unknown): void {
  transact(store, plan)
    .then(() => showAll(store))
    .catch((e) => log.warn(what, e))
}

/**
 * A host's deliveries, loaded once and restored: each one not received yet checked again (refused, expired), and one
 * offered when Hive stopped uncertain (it may not have reached its agent: offered once more, #649).
 */
export function load(host: string): Promise<Store> {
  const k = keyOf(host)
  const had = stores.get(k)
  if (had) return Promise.resolve(had)
  const going = loading.get(k)
  if (going) return going
  const p = (async () => {
    await beforeRead?.()
    const place = await hostPlace(host)
    for (let tries = 1; ; tries++) {
      const gen = dbGeneration(place.workspace)
      const read = await readSaved(host, place)
      if (stores.has(k)) return stores.get(k)!
      const store: Store = { host, place, records: read.records, next: read.next, invalid: read.invalid, lock: Promise.resolve(), offering: new Set(), confirming: new Map(), rungAgain: new Set(), launches: new Map(), hooks: new Map(), gen }
      // Restored before anything else sees it (a second load waits for this one).
      await transact(store, (d) => {
        for (const r of [...d.records]) if (r.state === 'offered') set(store, d, r, 'uncertain', 'may not have reached it: Hive stopped while offering it', undefined, { again: AGAIN_RESTART })
        recheck(store, d)
      }).catch((e) => log.warn('restoring deliveries', e))
      if (stores.has(k)) return stores.get(k)!
      if (gen !== dbGeneration(place.workspace)) {
        // The database replaced meanwhile (the upgrade to 1.0, a restore): read again, from the file as it is now, while
        // its workspace is still open; closed meanwhile, the stale read is kept by nobody (its saves are refused anyway).
        if (!workspaceFor(host)) return store
        if (tries < 3) continue
      }
      stores.set(k, store)
      showAll(store)
      // A card that moved on while Hive was closed: what was tied to its round is stale now (#652).
      if (store.records.some((r) => r.round && isUnread(r))) sweepStale()
      return store
    }
  })().finally(() => {
    if (loading.get(k) === p) loading.delete(k)
  })
  loading.set(k, p)
  return p
}

/**
 * A host's deliveries as saved in its workspace's database (#1018), moved in from its deliveries.json the first time:
 * each checked as it is read back; one that isn't valid is kept aside, not used.
 */
async function readSaved(host: string, place: Store['place']): Promise<{ records: DeliveryRecord[]; next: number; invalid: unknown[] }> {
  const file = fileOf(host)
  let raw: unknown[]
  let value: (key: string) => string | null
  if (upgradeWaiting(place.workspace)) {
    // The workspace's upgrade to 1.0 waits (#1207): its file is 0.9's, its deliveries rows of store_rows; nothing is moved in.
    const data = readStore(place.workspace, 'deliveries', place.scope)
    raw = data.rows.map((r) => JSON.parse(r.doc) as unknown)
    value = (key) => data.meta.get(key) ?? null
  } else {
    // In their own table since 1.0 (#1211), deliveries.json moved in the first time (its next id and entries kept aside with it).
    await openTable(place.workspace, 'deliveries', place.scope, file, () => readFileOf(host), DELIVERIES_TABLE)
    const db = workspaceDb(place.workspace).reader
    raw = readDeliveryRows(db, place.scope)
    value = (key) => storeValue(db, 'deliveries', place.scope, key)
  }
  const kept = value('invalid')
  const savedNext = value('next') !== null ? (JSON.parse(value('next')!) as unknown) : undefined
  const records: DeliveryRecord[] = []
  const invalid: unknown[] = kept ? [...(JSON.parse(kept) as unknown[])] : []
  for (const v of raw) {
    const r = readDelivery(v)
    if (r && !records.some((x) => x.id === r.id)) records.push(r)
    else invalid.push(v)
  }
  if (records.length < raw.length) log.warn(`${raw.length - records.length} saved deliver${raw.length - records.length === 1 ? 'y is' : 'ies are'} not valid: kept aside, not used`)
  const top = records.reduce((m, r) => Math.max(m, r.seq), 0)
  const next = Number.isInteger(savedNext) && (savedNext as number) > top ? (savedNext as number) : top + 1
  return { records, next, invalid }
}

/** The deliveries' side of a move in (openTable): how many a host has, and a file's written beside them. */
const DELIVERIES_TABLE = {
  count: (db: ReturnType<typeof workspaceDb>['writer'], scope: string) => countDeliveries(db, scope),
  put: (db: ReturnType<typeof workspaceDb>['writer'], scope: string, got: { deliveries: unknown[]; next: unknown; invalid: unknown[] }) => addDeliveriesFile(db, scope, got)
}

/**
 * A host's deliveries.json from before #1018, read to move it in: null when there is none. One too big to be Hive's, or
 * damaged, is set aside (renamed, never overwritten) and nothing is moved in.
 */
async function readFileOf(host: string): Promise<{ deliveries: unknown[]; next: unknown; invalid: unknown[] } | null> {
  const file = fileOf(host)
  let got: { data: Buffer; more: boolean }
  try {
    got = await readCapped(file, MAX_FILE_BYTES)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Could not read the deliveries (${(e as Error).message})`, { cause: e })
  }
  let data: { next?: unknown; deliveries?: unknown; invalid?: unknown } | null = null
  try {
    if (!got.more) data = JSON.parse(got.data.toString('utf8'))
  } catch {
    data = null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    // Not Hive's (too big, or damaged): set aside, never overwritten, and started again.
    const to = `${file}.${got.more ? 'too-big' : 'damaged'}-${Date.now()}`
    await renameRetrying(file, to)
    log.warn(`The deliveries file was ${got.more ? 'too big' : 'damaged'}: set aside as ${userText(to)}`)
    return { deliveries: [], next: undefined, invalid: [] }
  }
  return { deliveries: Array.isArray(data.deliveries) ? data.deliveries : [], next: data.next, invalid: Array.isArray(data.invalid) ? [...data.invalid] : [] }
}

/** The file's text for a draft. */
const fileText = (d: Pick<Draft, 'records' | 'next' | 'invalid'>): string => JSON.stringify({ version: 1, next: d.next, deliveries: d.records, ...(d.invalid.length ? { invalid: d.invalid } : {}) }, null, 2) + '\n'

/**
 * Whether a draft fits the file's budget, with room for each live delivery to grow to its end (times, a reason): what
 * Hive writes stays well under what it reads back (MAX_FILE_BYTES), so a file it wrote is never set aside as too big.
 */
const fits = (d: Draft): boolean => Buffer.byteLength(fileText(d)) + d.records.filter(isLive).length * GROWTH_PER_LIVE <= fileBudget

/** Makes room in the budget by dropping the oldest ended deliveries (their history), if need be. False if it still doesn't fit. */
function makeRoom(d: Draft): boolean {
  while (!fits(d)) {
    const oldest = d.records.filter((r) => !isLive(r)).sort((a, b) => a.seq - b.seq)[0]
    if (!oldest) return false
    d.records = d.records.filter((r) => r !== oldest)
    d.dirty = true
  }
  return true
}

/** For tests: run before each save (to fail it, or hold it). */
let beforeSave: (() => Promise<void> | void) | null = null
export const setBeforeSaveForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforeSave = fn
}

/**
 * Saves a draft as the host's deliveries: one transaction in its workspace's database (#1018), writing the deliveries
 * that changed, so a failure leaves them as they were. Its size is still bounded as the file's was.
 */
async function save(store: Store, d: Draft): Promise<void> {
  await beforeSave?.()
  prune(store, d)
  const file = fileOf(store.host)
  // Entries kept aside that would push it over: moved to a file of their own (never lost), not kept in this one.
  if (!makeRoom(d) && d.invalid.length) {
    const aside = `${file}.kept-aside-${Date.now()}-${randomBytes(3).toString('hex')}`
    await writeFile(aside, JSON.stringify({ version: 1, invalid: d.invalid }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    d.after.push(() => log.warn(`Saved deliveries that aren't valid moved to ${userText(aside)}, to keep the file small enough`))
    d.invalid = []
  }
  // What is written is what reads back (#649): one check, readDelivery's, for saving and restoring alike; a record it
  // wouldn't read back fails the save (nothing changes), never a delivery lost on the next start.
  for (const r of d.records) if (!readDelivery(JSON.parse(JSON.stringify(r)))) throw new Error(`delivery ${r.id} isn't one Hive could read back`)
  const text = fileText(d)
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('too many deliveries to keep in this project')
  // Read from a database since replaced (the upgrade to 1.0, a restore): never saved over what the file has now.
  const guard = (): void => {
    if (store.gen !== dbGeneration(store.place.workspace)) throw new Error("the workspace's database was replaced since these deliveries were read") // i18n-ignore: a save refused for the log; the transaction's NotSaved says it
  }
  // Their table's rows that changed (#1211), the next id and the entries kept aside beside them, in one transaction.
  // Only what this store read and kept is its own to delete (#1266): another Hive's rows saved since are left as they are,
  // and a new delivery whose id that Hive took meanwhile takes the next free one (made here, before it is published).
  const records = d.records as unknown as Record<string, unknown>[]
  const known = new Set(store.records.map((r) => r.id))
  let renamed = new Map<string, { id: string; seq: number }>()
  await saveTable(store.place.workspace, 'deliveries', store.place.scope, (db) => void (renamed = writeDeliveries(db, store.place.scope, records, known)), { next: JSON.stringify(d.next), invalid: d.invalid.length ? JSON.stringify(d.invalid) : null }, guard)
  for (const r of d.records) {
    const to = renamed.get(r.id)
    if (!to) continue
    // The same record (what the transaction returns is it): its id is the one saved.
    Object.assign(r, to)
    d.next = Math.max(d.next, to.seq + 1)
  }
}

/** Ended deliveries beyond what is kept (per agent, by age) go; received ones never acked expire after a week. */
function prune(store: Store, d: Draft): void {
  const now = Date.now()
  for (const r of [...d.records]) if (r.state === 'received' && needsAck(r.kind) && now - Date.parse(r.received ?? r.created) > KEEP_RECEIVED_MS) set(store, d, r, 'expired', 'received, never acked')
  const ended = new Map<string, DeliveryRecord[]>()
  for (const r of d.records) if (!isLive(r)) ended.set(r.agentId, [...(ended.get(r.agentId) ?? []), r])
  const drop = new Set<DeliveryRecord>()
  for (const list of ended.values()) {
    list.sort((a, b) => b.seq - a.seq)
    list.forEach((r, i) => {
      if (i >= KEEP_ENDED || now - Date.parse(r.ended ?? r.acked ?? r.received ?? r.created) > KEEP_ENDED_MS) drop.add(r)
    })
  }
  if (drop.size) d.records = d.records.filter((r) => !drop.has(r))
}

/** Replaces a record in a draft. */
function put(d: Draft, from: DeliveryRecord, to: DeliveryRecord): void {
  const i = d.records.indexOf(from)
  if (i < 0) return
  d.records[i] = to
  d.dirty = true
}

/** Tells a delivery's source what became of it, once published and outside the lock. */
function tell(store: Store, d: Draft, r: DeliveryRecord, what: 'received' | 'ended'): void {
  const fn = r.source ? sources.get(r.source)?.[what] : undefined
  const hook = store.hooks.get(r.id)?.[what]
  if (!fn && !hook) return
  d.after.push(() =>
    queueMicrotask(() => {
      try {
        fn?.(r, store.host)
        hook?.()
      } catch (e) {
        log.warn(`telling ${r.source ?? 'its producer'} that ${r.id} was ${what}`, e)
      }
    })
  )
}

/** Moves a delivery in a draft (with `extra` fields); false when that move isn't allowed. */
function set(store: Store, d: Draft, r: DeliveryRecord, to: DeliveryState, detail?: string, via?: 'inbox' | 'typed', extra: Partial<DeliveryRecord> = {}): boolean {
  if (!d.records.includes(r)) return false
  const next = moved(r, to, nowIso(), detail)
  if (!next) return false
  if (via && (to === 'received' || (to === 'acked' && !r.received))) next.receivedVia = via
  const out = { ...next, ...extra }
  put(d, r, out)
  if ((to === 'refused' || to === 'stale') && r.from.kind === 'assistant') {
    const ws = r.from.workspace
    d.after.push(() => assistant.record(ws, { kind: 'message-agent', project: basename(store.host), agent: { id: r.agentId, name: r.agentName ?? r.agentId }, ...(r.card ? { card: r.card } : {}) }, `A message for ${r.agentName ?? r.agentId} (${r.id}) was ${to === 'stale' ? 'dropped as stale' : 'refused'}`, detail ?? 'its sender may no longer send it', { reason: to === 'stale' ? 'Dropped as stale' : 'Refused' }))
  }
  if (to === 'refused' || to === 'expired' || to === 'cancelled' || to === 'uncertain' || to === 'stale') d.after.push(() => log.info(`Delivery ${r.id} for ${userText(r.agentName ?? r.agentId)} ${to}${detail ? `: ${userText(detail)}` : ''}`))
  if ((to === 'received' || to === 'acked') && !r.received) tell(store, d, out, 'received')
  else if (to === 'refused' || to === 'expired' || to === 'cancelled' || to === 'stale') tell(store, d, out, 'ended')
  return true
}

const byId = (records: readonly DeliveryRecord[], id: string): DeliveryRecord | undefined => records.find((r) => r.id === id)

/** The time expiry is measured against (Date.now; a test's own clock). */
let clock = (): number => Date.now()
/** For tests: the clock expiry is measured against (null: Date.now). */
export const setClockForTests = (fn: (() => number) | null): void => {
  clock = fn ?? (() => Date.now())
}

/** Why this sender may no longer send what it left (null: it may). Asked at every step: before it is offered, before each piece and Enter. */
let senderRefusal = (from: DeliverySender): string | null => {
  if (from.kind !== 'assistant') return null
  if (!assistant.allows('agents')) return 'the user turned Settings → Assistant → Control down'
  if (sessions.liveFor(assistant.assistantHome(from.workspace), ASSISTANT_AGENT_ID)?.runId !== from.launch) return "the Assistant's session that left it ended"
  return null
}
/**
 * Whether an agent can read its inbox (#650): the Assistant always (its own tools); a project agent through its hive
 * tools, which it has only while the Agent API and the built-in hive server are on.
 */
let readsInbox = (_host: string, agentId: string): boolean => agentId === ASSISTANT_AGENT_ID || (config.settings.agentApi.enabled && config.settings.agentApi.provideHiveMcp)
export const agentReadsInbox = (host: string, agentId: string): boolean => readsInbox(host, agentId)
/** Why an agent that can't read an inbox is given no delivery (#650's decision), as its sender sees it. */
const noInbox = (name: string): string => `${name} has no inbox: turn on the Agent API`
/** A delivery refused because its agent can't read an inbox: the message says so, and what to do. */
export class NoInbox extends Error {}
/** For tests: whether agents can read their inbox (null: as the settings say). */
export const setReadsInboxForTests = (fn: ((host: string, agentId: string) => boolean) | null): void => {
  readsInbox = fn ?? ((_host, agentId) => agentId === ASSISTANT_AGENT_ID || (config.settings.agentApi.enabled && config.settings.agentApi.provideHiveMcp))
}
/** For tests: how a sender's permission is worked out. */
export const setSenderCheckForTests = (fn: (from: DeliverySender) => string | null): void => {
  senderRefusal = fn
}

/** Why a delivery not received yet may no longer be given to its agent (null: it may), and what it becomes then. */
function whyNot(store: Store, r: DeliveryRecord): { to: 'refused' | 'expired'; why: string } | null {
  const why = senderRefusal(r.from)
  if (why) return { to: 'refused', why }
  // Its agent can't read an inbox (the Agent API turned off since it was made): refused, never typed instead.
  if (!readsInbox(store.host, r.agentId)) return { to: 'refused', why: noInbox(r.agentName ?? r.agentId) }
  if (Date.parse(r.expires) <= clock()) return { to: 'expired', why: 'not received in time' }
  const live = sessions.liveFor(store.host, r.agentId)
  if (r.forRun && live?.runId !== r.forRun) return { to: 'expired', why: 'the session it was for has ended' }
  if (r.conversation && live?.sessionId && live.sessionId !== r.conversation) return { to: 'expired', why: 'its agent is in another conversation now' }
  return null
}

/**
 * Follows, in a draft, what happened to deliveries not received yet: one that may no longer be given to its agent ends;
 * one whose doorbell its CLI took, with its agent idle again since without reading it, waits to ring once more (#650);
 * one offered into a launch that has ended (or another one) before it was read is uncertain, and offered once more.
 */
function recheck(store: Store, d: Draft, agentId?: string): void {
  for (const r of [...d.records]) {
    if (!isUnread(r) || (agentId && r.agentId !== agentId)) continue
    if (r.state === 'offered' && !store.offering.has(r.id)) {
      const base = store.confirming.get(r.id)
      const now = sessions.promptsTaken(store.host, r.agentId)
      // The launch it went into: as saved, or (a launch's save that failed) as followed in memory.
      const run = store.launches.get(r.id) ?? r.offerRun
      if (base && now && now.runId === base.runId && run === base.runId && now.count > base.count) {
        // Its doorbell was taken: received only once it is read (hive_inbox), or ended now if it may no longer be given
        // (#652: the doorbell isn't withdrawn, so this is where it ends). Its agent idle again without reading it (its
        // turn ended, the Stop drain's notice let pass), it rings once more.
        const no = whyNot(store, r)
        if (no) {
          set(store, d, r, no.to, no.why)
          continue
        }
        if (!store.rungAgain.has(r.id) && readyFor(sessions.liveFor(store.host, r.agentId), r.need ?? 'idle') && set(store, d, r, 'queued')) store.rungAgain.add(r.id)
        continue
      }
      // A launch still starting (its run not attached yet) is in progress, never a run that has gone: only a restart
      // (load) finds one left like that, and makes it uncertain.
      if (run === LAUNCHING) continue
      if (run && sessions.liveFor(store.host, r.agentId)?.runId !== run) {
        set(store, d, r, 'uncertain', `may not have reached it: ${AGAIN_LAUNCH}`, undefined, { again: AGAIN_LAUNCH })
        continue
      }
    }
    const no = whyNot(store, r)
    if (no) set(store, d, r, no.to, no.why)
  }
  // What has left offered keeps no check of its line's receipt.
  for (const id of [...store.confirming.keys()]) if (byId(d.records, id)?.state !== 'offered') store.confirming.delete(id)
  for (const id of [...store.launches.keys()]) if (byId(d.records, id)?.state !== 'offered') store.launches.delete(id)
  for (const id of [...store.rungAgain]) if (!isUnread(byId(d.records, id) ?? { state: 'cancelled' })) store.rungAgain.delete(id)
  for (const id of [...store.hooks.keys()]) if (!isUnread(byId(d.records, id) ?? { state: 'cancelled' })) store.hooks.delete(id)
}

/** Shows an agent's unread and overdue deliveries in its pane (only while it runs). */
function show(store: Store, agentId: string): void {
  sessions.setInbox(store.host, agentId, inboxSummary(store.records.filter((r) => r.agentId === agentId), Date.now(), overdueMs()))
}
function showAll(store: Store): void {
  for (const id of new Set(store.records.map((r) => r.agentId))) show(store, id)
}

export interface NewDelivery {
  agentId: string
  agentName?: string
  conversation?: string | null
  kind: DeliveryKind
  from: DeliverySender
  card?: number
  /** With `card`: the card's round it is for (#652, roundOf), stale once the card has moved on. */
  round?: number
  body: string
  /** How long it may wait to be received (default DELIVERY_EXPIRY_HOURS). */
  expiresMs?: number
  /** At most this many of its kind waiting for the agent (counted with it, when it is made): more is refused. */
  maxWaiting?: number
  /** What made it (a registered source) and its key there: one waiting with the same is that one (`replace`: made again from this). */
  source?: string
  ref?: string
  replace?: boolean
  meta?: Record<string, string | number | boolean>
  /** What its agent must be doing to be offered it (default idle). */
  need?: DeliveryNeed
  /** Only for this launch of its agent (a mode notice, a lock's go-ahead): it expires when that launch ends. */
  forRun?: string
  /** Why it may repeat (one Hive may have given before: a watch read back from before #649 being typed). */
  again?: string
  /** Offered by a launch about to start (launchWith only). */
  launching?: true
  /**
   * The durable action making it (SPEC §16.4.5): one delivery per action. One this action already made is returned as it
   * is; one of the same source and ref still waiting is cancelled as replaced, never rewritten (it keeps its own action).
   */
  action?: number
}

/**
 * Whether a durable action has made its delivery (SPEC §16.4.5): one of a host's loaded here, or a row of its workspace's
 * database with the action's id (another Hive's, or one from before a restart). That row (unique per action) is the
 * record that it was delivered: an action run again finds it and makes nothing.
 */
export function actionDelivered(host: string, action: number): boolean {
  const ws = workspaceFor(host)
  if (!ws?.path) return false
  // Action ids are a workspace database's own: only its hosts' deliveries count.
  const mine = (s: Store): boolean => s.place.workspace.toLowerCase() === resolve(ws.path!).toLowerCase()
  if ([...stores.values()].some((s) => mine(s) && s.records.some((r) => r.action === action))) return true
  try {
    return !!workspaceDb(ws.path).reader.prepare('SELECT 1 FROM deliveries WHERE action = ?').get(action) // i18n-ignore: SQL
  } catch {
    // A board waiting for its upgrade has no deliveries table: none made.
    return false
  }
}

/** How many of an agent's deliveries of a kind wait to be offered. */
export const waitingCount = (host: string, agentId: string, kind: DeliveryKind): number => stores.get(keyOf(host))?.records.filter((r) => r.agentId === agentId && r.kind === kind && isWaiting(r)).length ?? 0

/**
 * Makes a delivery for an agent of a host, saved before this returns. Refused (an Error) when its sender may not send it.
 * One already waiting with the same source and ref is returned instead (made again from this one with `replace`).
 */
export async function createDelivery(host: string, nd: NewDelivery, hooks?: DeliveryHooks): Promise<DeliveryRecord> {
  // Only what reads back is saved (readDelivery's limits): a longer text is refused here, never lost on a restart.
  if (nd.body.length > DELIVERY_BODY_MAX_CHARS) throw new Error(`It is too long to give an agent (${nd.body.length} characters, at most ${DELIVERY_BODY_MAX_CHARS}).`)
  if ((nd.ref?.length ?? 0) > 300 || (nd.source?.length ?? 0) > 40) throw new Error('Not a delivery Hive can keep: its source or key is too long.')
  const meta = nd.meta && Object.fromEntries(Object.entries(nd.meta).slice(0, 20).map(([k, v]) => [k.slice(0, 40), typeof v === 'string' ? v.slice(0, 500) : v]))
  const agentName = nd.agentName?.slice(0, 300)
  // An agent that can't read an inbox is given none (#650's decision): refused now, with the reason its sender sees.
  if (!readsInbox(host, nd.agentId)) throw new NoInbox(noInbox(agentName ?? nd.agentId))
  const store = await load(host)
  const r = await transact(store, (d) => {
    const why = senderRefusal(nd.from)
    if (why) throw new Error(`Not sent: ${why}.`)
    // An action's delivery already made (two runs of it at once here): that one.
    const made = nd.action ? d.records.find((x) => x.action === nd.action) : undefined
    if (made) return made
    let had = nd.source && nd.ref !== undefined ? d.records.find((x) => x.source === nd.source && x.ref === nd.ref && x.agentId === nd.agentId && isWaiting(x)) : undefined
    // An action's own delivery: the one waiting is replaced by a new one (each action keeps its own row).
    if (had && nd.action && nd.replace) {
      set(store, d, had, 'cancelled', 'replaced by a newer one')
      had = undefined
    }
    if (had) {
      if (!nd.replace) return had
      const again: DeliveryRecord = { ...had, body: nd.body, ...(nd.card ? { card: nd.card } : {}), ...(meta ? { meta } : {}), ...(nd.forRun ? { forRun: nd.forRun } : {}), expires: new Date(Date.now() + (nd.expiresMs ?? DELIVERY_EXPIRY_HOURS * 60 * 60_000)).toISOString() }
      put(d, had, again)
      return again
    }
    if (nd.maxWaiting !== undefined && d.records.filter((x) => x.agentId === nd.agentId && x.kind === nd.kind && isWaiting(x)).length >= nd.maxWaiting) throw new TooManyWaiting(`${nd.maxWaiting} already wait`)
    if (d.records.filter(isLive).length >= MAX_LIVE_PER_HOST) throw new DeliveriesFull(`This project already has ${MAX_LIVE_PER_HOST} deliveries waiting or not acked, the most Hive keeps.`)
    const seq = d.next++
    const rec: DeliveryRecord = {
      id: `m${seq}`,
      seq,
      agentId: nd.agentId,
      ...(agentName ? { agentName } : {}),
      conversation: nd.conversation || null,
      kind: nd.kind,
      from: nd.from,
      ...(nd.card ? { card: nd.card, ...(nd.round ? { round: nd.round } : {}) } : {}),
      body: nd.body,
      state: 'queued',
      created: nowIso(),
      expires: new Date(Date.now() + (nd.expiresMs ?? DELIVERY_EXPIRY_HOURS * 60 * 60_000)).toISOString(),
      ...(nd.source ? { source: nd.source, ...(nd.ref !== undefined ? { ref: nd.ref } : {}) } : {}),
      ...(meta ? { meta } : {}),
      ...(nd.need && nd.need !== 'idle' ? { need: nd.need } : {}),
      ...(nd.forRun ? { forRun: nd.forRun } : {}),
      ...(nd.again ? { again: nd.again } : {}),
      ...(nd.action ? { action: nd.action } : {}),
      // Made offered, into a launch about to start (launchWith): saved before the launch, never offered by the scheduler.
      ...(nd.launching ? { state: 'offered' as const, offered: nowIso(), offers: 1, offerRun: LAUNCHING } : {})
    }
    d.records.push(rec)
    d.dirty = true
    // Within the file's budget (ended ones' history makes room first), or not made at all.
    if (!makeRoom(d)) throw new DeliveriesFull("This project's deliveries are full (what waits for its agents and isn't acked): wait until they are received and acked, or cancel some.")
    d.after.push(() => log.info(`Delivery ${rec.id} (${rec.kind}) for ${userText(nd.agentName ?? nd.agentId)} queued`))
    return rec
  })
  // Its producer's own part (also for one made again from this: the newest producer's).
  if (hooks && isUnread(r)) store.hooks.set(r.id, hooks)
  show(store, nd.agentId)
  return r
}

/** A delivery as it is now (null when it is gone, or its host isn't loaded). */
export const deliveryNow = (host: string, id: string): DeliveryRecord | null => byId(stores.get(keyOf(host))?.records ?? [], id) ?? null

/** An agent's deliveries, oldest first (loaded if need be). */
export async function deliveriesOf(host: string, agentId: string): Promise<DeliveryRecord[]> {
  const store = await load(host)
  return store.records.filter((r) => r.agentId === agentId).sort((a, b) => a.seq - b.seq)
}

/** A host's deliveries from a source, oldest first (only what is loaded). */
export const fromSource = (host: string, source: string): DeliveryRecord[] => (stores.get(keyOf(host))?.records ?? []).filter((r) => r.source === source).sort((a, b) => a.seq - b.seq)
/** Every loaded host's deliveries from a source, with their hosts. */
export const everyFromSource = (source: string): { host: string; r: DeliveryRecord }[] => [...stores.values()].flatMap((s) => s.records.filter((r) => r.source === source).map((r) => ({ host: s.host, r })))

/** An agent's deliveries as the Agent API shows them: unread and overdue counts, and the rows (the newest `limit`). */
export async function deliveryView(host: string, agentId: string, limit: number, textChars = 80): Promise<{ unread: number; overdue: number; deliveries: DeliveryRow[]; more?: number }> {
  const list = await deliveriesOf(host, agentId)
  const now = Date.now()
  const rows = list.map((r) => deliveryRow(r, now, textChars, overdueMs()))
  const shown = rows.slice(-limit)
  return { unread: list.filter(isUnread).length, overdue: rows.filter((r) => r.overdue).length, deliveries: shown, ...(rows.length > shown.length ? { more: rows.length - shown.length } : {}) }
}

/**
 * Whether a delivery can still be cancelled: not read yet (#650: a doorbell names it without its text, so until the agent
 * reads it, it can be taken back; one being typed stops, and hive_inbox no longer gives it).
 */
const cancellable = (r: DeliveryRecord): boolean => isUnread(r)

/** Whether an offered delivery's line has been taken by its CLI (its prompt count rose in that launch after the line's Enter). */
function taken(store: Store, r: DeliveryRecord): boolean {
  const c = store.confirming.get(r.id)
  const now = c && sessions.promptsTaken(store.host, r.agentId)
  return !!c && !!now && now.runId === c.runId && r.offerRun === c.runId && now.count > c.count
}

/**
 * Cancels an agent's deliveries not read yet (one being typed now stops; its hive_inbox no longer lists them), all of
 * them or those of `kinds` (or those `match` picks); by: who cancelled. How many.
 */
export async function cancelDeliveries(host: string, agentId: string, by: string, kinds?: readonly DeliveryKind[], match?: (r: DeliveryRecord) => boolean): Promise<number> {
  const store = await load(host)
  const n = await transact(store, (d) => {
    let count = 0
    for (const r of [...d.records]) {
      if (r.agentId !== agentId || (kinds && !kinds.includes(r.kind)) || (match && !match(r))) continue
      if (cancellable(r) && set(store, d, r, 'cancelled', `cancelled by ${by}`)) count++
    }
    return count
  })
  show(store, agentId)
  return n
}

/** Cancels a host's deliveries from a source (`ref`: only that one) not received yet, as cancelDeliveries does (`why`: the reason given). How many. */
export async function cancelFromSource(host: string, source: string, ref: string | null, why: string): Promise<number> {
  const store = stores.get(keyOf(host)) ?? (await load(host))
  const agents = new Set<string>()
  const n = await transact(store, (d) => {
    let count = 0
    for (const r of [...d.records]) {
      if (r.source !== source || (ref !== null && r.ref !== ref) || !cancellable(r)) continue
      if (set(store, d, r, 'cancelled', why)) {
        count++
        agents.add(r.agentId)
      }
    }
    return count
  })
  for (const a of agents) show(store, a)
  return n
}

/**
 * hive_inbox for an agent: its deliveries not received yet (a card's events coalesced), now received; and those received
 * before and not acked (of the kinds it acks). What may no longer be given out is refused or expired instead, checked in
 * the same transaction.
 */
export async function readInbox(host: string, agentId: string): Promise<{ items: InboxItem[]; unacked: string[] }> {
  const store = await load(host)
  const given: DeliveryRecord[] = []
  let unacked: string[] | null = null
  // An offered one its agent was rung for that this read didn't give (what it was made from changed again while it was
  // made again for the read: a loop wake's roles, a decision line's board) is tried again, a few times at most (#650).
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: { give: DeliveryRecord[]; before: string[]; missed: boolean }
    try {
      // Through the one gate (#649), as an offer: a reply the user no longer lets be told, a watch that has ended, a wake
      // that is someone else's now, isn't handed out.
      const gate = await mayGive(store, store.records.filter((x) => x.agentId === agentId && isUnread(x)))
      // Relevance (#652) is read under the lock, so a card that moved on while this read waited for it is seen.
      r = await transactAfter(
        store,
        () => relevanceNow(store, agentId),
        (d, rel) => {
          const held = applyRelevance(store, d, rel, agentId)
          recheck(store, d, agentId)
          const may = gate(d)
          const mine = d.records.filter((x) => x.agentId === agentId)
          const give = mine.filter((x) => may(x) && !held.has(x.id))
          const before = mine.filter((x) => x.state === 'received' && needsAck(x.kind)).map((x) => x.id)
          for (const x of give) set(store, d, x, 'received', undefined, 'inbox')
          return { give, before, missed: mine.some((x) => x.state === 'offered' && !give.includes(x)) }
        },
        overtaken
      )
    } catch (e) {
      // Nothing received yet: the read fails, and gave nothing. A retry failing keeps what the attempts before it
      // received (saved as received): this read returns them, and what it missed waits for the next.
      if (!attempt) throw e
      log.warn(`${userText(agentId)}'s inbox read gave what it had: trying again failed`, e)
      break
    }
    given.push(...r.give)
    unacked ??= r.before
    if (!r.missed) break
  }
  show(store, agentId)
  return { items: inboxItems(given), unacked: unacked ?? [] }
}

/**
 * hive_inbox ack: marks an agent's deliveries acked, once it has read them (#650: a doorbell names them by id, so an id
 * alone is no sign of reading; one not read yet is `unread`, nothing changes, and the agent reads it first). Ids that
 * aren't its own, or don't exist, are unknown (nothing said of them). Acked again: still acked.
 */
export async function ackDeliveries(host: string, agentId: string, ids: readonly string[]): Promise<{ acked: string[]; unknown: string[]; unread: string[] }> {
  const store = await load(host)
  const r = await transact(store, (d) => {
    recheck(store, d, agentId)
    const acked: string[] = []
    const unknown: string[] = []
    const unread: string[] = []
    for (const id of [...new Set(ids)]) {
      const x = byId(d.records, id)
      if (!x || x.agentId !== agentId) unknown.push(id)
      else if (x.state === 'acked') acked.push(id)
      // Not read yet: read it first (never acked, nor its source told it was received, from its id alone).
      else if (isUnread(x)) unread.push(id)
      else if (x.state === 'received' && set(store, d, x, 'acked')) acked.push(id)
      // Ended without being received (cancelled, refused, expired): not for it to act on.
      else unknown.push(id)
    }
    return { acked, unknown, unread }
  })
  show(store, agentId)
  return { acked: r.acked, unknown: r.unknown, unread: r.unread }
}

/**
 * Applies, in a draft, what sources said as their deliveries were made again: cancelled, or their text and context as
 * they are now (that version, saved with it). One already offered keeps the version it was offered as while that still
 * holds; one that no longer does is made again (#650: its doorbell named it by id, never its text, so it can be, rather
 * than never given at all). Its receipt, in the same transaction as the read, covers exactly the version read.
 */
function applyFresh(store: Store, d: Draft, fresh: Map<string, Fresh>): void {
  for (const [id, f] of fresh) {
    const r = byId(d.records, id)
    if (!r || !isUnread(r)) continue
    if ('cancel' in f) set(store, d, r, 'cancelled', f.cancel)
    else if (r.state === 'offered' && eligible(store, r)) continue
    else if (f.body.length > DELIVERY_BODY_MAX_CHARS) set(store, d, r, 'cancelled', 'cancelled: made again, it was too long to keep')
    else if (f.body !== r.body || (f.meta && JSON.stringify(f.meta) !== JSON.stringify(r.meta))) put(d, r, { ...r, body: f.body, ...(f.meta ? { meta: f.meta } : {}) })
  }
}

/**
 * Whether a delivery may be given to its agent now, as far as it goes (#649): its sender may still send it, it hasn't
 * expired, it is for the agent's conversation (and launch), and its source and producer still hold it. The one check
 * the gate (mayGive) and the writer before each key (offerHolds) both ask.
 */
const eligible = (store: Store, r: DeliveryRecord): boolean =>
  !whyNot(store, r) && (r.source ? sources.get(r.source)?.holds?.(r, store.host) : undefined) !== false && producerHolds(store, r)

/**
 * Whether a delivery's producer still wants it given (its DeliveryHooks.holds: a task while its agent is free, the
 * carry-on while the agent is stopped by its sign-in), asked before it is offered and as its line is typed. Once its
 * doorbell has been taken (#650), the agent is reading what it was rung for, at work by then: not asked again.
 */
const producerHolds = (store: Store, r: DeliveryRecord): boolean => (r.state === 'offered' && taken(store, r)) || store.hooks.get(r.id)?.holds?.() !== false

/**
 * The one gate every hand-out goes through (#649): an offer (and so the typing), hive_inbox's read and an ack of something
 * unread all ask it, so typing and pulling never disagree. Each delivery is made again from its source first (`refresh`:
 * its text as it is now, or cancelled when no longer due; what its source keeps for its receipt prepared), and one its
 * producer no longer wants is cancelled. Applied in the caller's transaction, it says of each whether it may be given out
 * (unread and eligible). Already received ones aren't its business: they can still be acked.
 */
async function mayGive(store: Store, records: readonly DeliveryRecord[]): Promise<(d: Draft) => (r: DeliveryRecord) => boolean> {
  const fresh = await refreshAll(store, records)
  for (const r of records) if (!fresh.has(r.id) && !producerHolds(store, r)) fresh.set(r.id, { cancel: 'cancelled: no longer wanted' })
  return (d) => {
    applyFresh(store, d, fresh)
    return (r) => isUnread(r) && eligible(store, r)
  }
}

/** A card's round under way (#652): its failed reviews plus one (the fix after a failed review is the next round). */
export const roundOf = (card: TaskCard): number => reviewRounds(card).failures + 1

/**
 * Why a delivery tied to card n's round `round` is stale (#652), from the card as it is now (null: it is gone); null when
 * it is still relevant: the card in Doing or Review, in that round.
 */
export function staleWhy(card: TaskCard | null, n: number, round: number): string | null {
  if (!card) return `${cardRef(n)} is gone`
  if (card.archived) return `${cardRef(n)} was archived`
  if (card.column === 'passed') return `${cardRef(n)} passed review`
  if (card.column === 'done') return `${cardRef(n)} is done`
  if (card.column !== 'doing' && card.column !== 'review') return `${cardRef(n)} left Doing and Review`
  const now = roundOf(card)
  return now > round ? `${cardRef(n)} is in round ${now} now` : null
}

/** A card as the board has it now (null: it is gone; undefined: Hive can't tell, its workspace closed or the card unreadable). */
async function boardCard(host: string, n: number): Promise<TaskCard | null | undefined> {
  const ws = workspaceFor(host)
  if (!ws?.path) return undefined
  return getTask(n, ws).catch((e: Error) => (e.message.startsWith('Unknown task') ? null : undefined))
}
let cardNow = boardCard
/** For tests: how a card is read (null: as the board has it). */
export const setCardReaderForTests = (fn: ((host: string, n: number) => Promise<TaskCard | null | undefined>) | null): void => {
  cardNow = fn ?? boardCard
}

/**
 * The round of card n a delivery made now would be tied to (#652): its round under way. Refused (an Error) when the card
 * is gone, can't be read, or isn't in Doing or Review in a round (nothing for a re-brief to be relevant to).
 */
export async function roundNow(host: string, n: number): Promise<number> {
  const card = await cardNow(host, n)
  if (card === undefined) throw new Error(`Hive couldn't read ${cardRef(n)} now.`)
  if (!card) throw new Error(`There is no card ${cardRef(n)}.`)
  const round = roundOf(card)
  const why = staleWhy(card, n, round)
  if (why) throw new Error(`${why}: a message tied to its round needs it in Doing or Review.`)
  return round
}

/** Of these deliveries, those tied to a card's round that are stale now, with why (each card read once). */
async function staleOf(host: string, records: readonly DeliveryRecord[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const cards = new Map<number, TaskCard | null | undefined>()
  for (const r of records) {
    if (!r.card || !r.round || !isUnread(r)) continue
    if (!cards.has(r.card)) cards.set(r.card, await cardNow(host, r.card).catch(() => undefined))
    const card = cards.get(r.card)
    // Not known now (its workspace closed, the card unreadable): not stale on that account.
    if (card === undefined) continue
    const why = withCardNames(workspaceFor(host), () => staleWhy(card, r.card!, r.round!), scopeOfHost(host))
    if (why) out.set(r.id, why)
  }
  return out
}

/** Board changes seen (tasks-changed): a relevance read one has overtaken is read again, or not acted on (Relevance). */
let boardChanges = 0
onHiveEvent((e) => {
  if (e.type === 'tasks-changed') boardChanges++
})

/** A relevance read (#652): which deliveries tied to a card's round are stale, and the board's changes when it began. */
interface Relevance {
  stale: Map<string, string>
  board: number
}

/**
 * A host's deliveries (an agent's, or all) tied to a card's round that are stale, read under its lock (a transactAfter's
 * `read`, with `overtaken` as its `again`): from the records published then.
 */
async function relevanceNow(store: Store, agentId?: string): Promise<Relevance> {
  const board = boardChanges
  return { stale: await staleOf(store.host, store.records.filter((r) => !agentId || r.agentId === agentId)), board }
}
/** Whether the board has changed since a relevance read began: what it found may be out of date. */
const overtaken = (rel: Relevance): boolean => rel.board !== boardChanges

/**
 * Applies a relevance read in a draft, as the plan is made (nothing awaited since transactAfter last judged it): if the
 * board is as it was read, what it found stale ends as stale; if not (overtaken READS times running), nothing is ended
 * from it, and the deliveries tied to a round (an agent's, or all) are held back: returned, to be neither given nor
 * offered by this operation, left unread for a later one.
 */
function applyRelevance(store: Store, d: Draft, rel: Relevance, agentId?: string): Set<string> {
  if (!overtaken(rel)) {
    for (const [id, why] of rel.stale) {
      const r = byId(d.records, id)
      if (r && isUnread(r)) set(store, d, r, 'stale', why)
    }
    return new Set()
  }
  const held = d.records.filter((r) => r.round && isUnread(r) && (!agentId || r.agentId === agentId)).map((r) => r.id)
  if (held.length) d.after.push(() => log.info(`Deliveries ${held.join(', ')} held back: the board kept changing while their cards were read`))
  return new Set(held)
}

/** Ends what has become stale in each loaded host (#652), as the board changes: one sweep at a time, again if asked meanwhile. */
let sweeping: Promise<void> | null = null
let sweepAgain = false
function sweepStale(): void {
  if (sweeping) {
    sweepAgain = true
    return
  }
  sweeping = (async () => {
    do {
      sweepAgain = false
      for (const store of [...stores.values()]) {
        if (!store.records.some((r) => r.round && isUnread(r))) continue
        await transactAfter(store, () => relevanceNow(store), (d, rel) => void applyRelevance(store, d, rel), overtaken).catch((e) => log.warn('ending stale deliveries', e))
        showAll(store)
      }
    } while (sweepAgain)
  })().finally(() => {
    sweeping = null
  })
}
/** For tests: ends what has become stale now, awaited. */
export async function sweepStaleForTests(): Promise<void> {
  sweepStale()
  for (let s = sweeping; s; s = sweeping) await s
}

/** An offer: its deliveries (as they were before it, to put back), the line, the launch and conversation it is for. */
interface Offer {
  ids: string[]
  was: Map<string, DeliveryRecord>
  line: string
  runId: string
  sessionId: string
  need: DeliveryNeed
}

/** What an agent must be doing to be offered these together: the one they share, else free (which every need takes). */
const needOf = (items: readonly DeliveryRecord[]): DeliveryNeed => {
  const needs = new Set(items.map((r) => r.need ?? 'idle'))
  return needs.size === 1 ? [...needs][0] : 'free'
}

/**
 * Which of an agent's waiting deliveries go in its next line (those that may still be given out and that it can take,
 * as it is now): `only` that one; else a task or handover alone (the oldest), or all the others together.
 */
function pickOffer(store: Store, records: readonly DeliveryRecord[], agentId: string, only?: string): DeliveryRecord[] {
  const live = sessions.liveFor(store.host, agentId)
  const can = records.filter((r) => r.agentId === agentId && isWaiting(r) && !whyNot(store, r) && readyFor(live, r.need ?? 'idle')).sort((a, b) => a.seq - b.seq)
  if (only) return can.filter((r) => r.id === only)
  const alone = can.find((r) => goesAlone(r.kind))
  return alone ? [alone] : can.filter((r) => !goesAlone(r.kind))
}

/**
 * Plans an offer of an agent's waiting deliveries (`items`, as picked) in a draft: offered, into this launch
 * (`offerRun`), with the line that will be typed. Null when none of them still waits.
 */
function planOffer(store: Store, d: Draft, items: readonly DeliveryRecord[], target: { runId: string; sessionId: string }, label: string | null): Offer | null {
  const now = items.map((r) => byId(d.records, r.id)).filter((r): r is DeliveryRecord => !!r && isWaiting(r) && !whyNot(store, r))
  if (!now.length) return null
  // A watching agent is told its watch carries on, unless the line is its own watch's wake (whose receipt ends it).
  const line = withCardNames(workspaceFor(store.host), () => offerLine(now, now.some((r) => r.source === 'watch') ? null : label), scopeOfHost(store.host))
  const was = new Map(now.map((r) => [r.id, r]))
  for (const r of now) set(store, d, r, 'offered', undefined, undefined, { offerRun: target.runId })
  return { ids: now.map((r) => r.id), was, line, runId: target.runId, sessionId: target.sessionId, need: needOf(now) }
}

/**
 * Whether an offer still holds: each still offered by it, allowed and still wanted by its source (and by its caller), and
 * its agent in the same launch and conversation.
 */
function offerHolds(store: Store, o: Offer, records: readonly DeliveryRecord[] = store.records): boolean {
  const live = sessions.liveFor(store.host, o.ids.length ? byId(records, o.ids[0])!.agentId : '')
  if (!live || live.runId !== o.runId || (o.sessionId && live.sessionId && live.sessionId !== o.sessionId)) return false
  return o.ids.every((id) => {
    const r = byId(records, id)
    return r?.state === 'offered' && r.offerRun === o.runId && eligible(store, r)
  })
}

/** Puts an offer's deliveries back as they were (the line wasn't typed), those it still has as offered. */
function unoffer(store: Store, o: Offer): Promise<void> {
  for (const id of o.ids) store.offering.delete(id)
  return transact(store, (d) => {
    for (const id of o.ids) {
      const r = byId(d.records, id)
      const was = o.was.get(id)
      if (r?.state === 'offered' && r.offerRun === o.runId && was) put(d, r, was)
    }
    // One that may no longer be given out is ended now, not at the next try.
    recheck(store, d, byId(d.records, o.ids[0])?.agentId)
  })
    .then(() => showAll(store))
    .catch((e) => log.warn('putting deliveries back', e))
}

/** The launch the line was typed into ended (or another began) before its CLI took it: what it carried is uncertain now. */
function lost(store: Store): void {
  transactSoon(store, 'checking deliveries', (d) => recheck(store, d))
}

/** While the confirmation checks its CLI took the line: until then a cancel can still end it (and no Enter comes). */
function confirming(store: Store, o: Offer, before: { runId: string; count: number }): void {
  for (const id of o.ids) store.confirming.set(id, before)
}

/** Each source's line made again for what is about to be offered (from things as they are now): its body, or why it is cancelled. */
async function refreshAll(store: Store, items: readonly DeliveryRecord[]): Promise<Map<string, Fresh>> {
  const out = new Map<string, Fresh>()
  for (const r of items) {
    const fn = r.source ? sources.get(r.source)?.refresh : undefined
    if (!fn) continue
    try {
      // Its line names cards by key, its host's workspace's (#1219).
      const got = await withCardNames(workspaceFor(store.host), () => fn(r, store.host), scopeOfHost(store.host))
      if (got) out.set(r.id, got)
    } catch (e) {
      log.warn(`making delivery ${r.id} again`, e)
    }
  }
  return out
}

const trying = new Map<string, Promise<boolean>>()

/** Offers an agent's waiting deliveries now if it can take a line (one try at a time per agent); `only`: that one alone. Whether a line was typed. */
export function offerNow(host: string, agentId: string, only?: string): Promise<boolean> {
  const k = `${keyOf(host)}#${agentId}`
  const going = trying.get(k)
  if (going) return going.then(() => false)
  const run = offerOnce(host, agentId, only).finally(() => trying.delete(k))
  trying.set(k, run)
  return run
}

/** How many times an offer overtaken before its first key (what it was made from changed as it was planned) is made again at once. */
const OVERTAKEN_TRIES = 3

async function offerOnce(host: string, agentId: string, only?: string, tries = 1): Promise<boolean> {
  const store = await load(host)
  const st = sessions.liveFor(host, agentId)
  if (!st) return false
  // What may no longer be given out (its sender's permission gone, too old, another conversation) ends now, not later.
  if (store.records.some((r) => r.agentId === agentId && isUnread(r) && whyNot(store, r))) await transact(store, (d) => recheck(store, d, agentId)).catch((e) => log.warn('checking deliveries', e))
  let items = pickOffer(store, store.records, agentId, only)
  if (!items.length) return false
  if (!canTypeLine(host, agentId, needOf(items))) {
    // The user may still be writing there: nothing says when they stop, so it is tried again in a moment.
    if (sessions.userMayBeTyping(host, agentId)) retrySoon(host, agentId)
    return false
  }
  // Through the one gate (as hive_inbox is): each made again from things as they are now; what may not be given out
  // isn't offered.
  const gate = await mayGive(store, items)
  const label = st.status === 'watching' && st.watch ? st.watch.label : null
  // Saved as offered before the first key (checked as it is planned), and checked again before each key: if Hive stops
  // in between it is uncertain, never "delivered". Not saved, or no longer to be given out: nothing is typed.
  let offer: Offer | null
  try {
    offer = await transactAfter(
      store,
      () => relevanceNow(store, agentId),
      (d, rel) => {
        const held = applyRelevance(store, d, rel, agentId)
        const may = gate(d)
        items = pickOffer(store, d.records, agentId, only).filter((r) => items.some((x) => x.id === r.id) && may(r) && !held.has(r.id))
        return planOffer(store, d, items, { runId: st.runId, sessionId: st.sessionId }, label)
      },
      overtaken
    )
  } catch (e) {
    log.warn(`Deliveries for ${userText(agentId)} not offered: ${(e as Error).message}`)
    show(store, agentId)
    return false
  }
  show(store, agentId)
  if (!offer || !offerHolds(store, offer)) {
    if (!offer) return false
    await unoffer(store, offer)
    // Overtaken as it was saved (#1036: the board changed after its line was made, by another agent or, seen by the
    // board's poll, another process): made again from things as they are now, at once; still overtaken, tried in a
    // moment, never left for the tick.
    if (tries < OVERTAKEN_TRIES) return offerOnce(host, agentId, only, tries + 1)
    retrySoon(host, agentId)
    return false
  }
  const o = offer
  for (const id of o.ids) store.offering.add(id)
  let typed = false
  try {
    typed = await typeLine(host, agentId, o.line, () => offerHolds(store, o) && o.ids.every((id) => store.offering.has(id)), {
      need: o.need,
      // A line the user typed into before its CLI took it is theirs (#652 round 1 finding 2): what it named waits again.
      follow: { confirming: (before) => confirming(store, o, before), lost: () => lost(store), left: () => void unoffer(store, o) }
    })
  } finally {
    for (const id of o.ids) store.offering.delete(id)
    // Not typed: put back (and ended, if it may no longer be given out) before this returns, so a reply says so; what
    // its source no longer has due (what it was made from changed as it was typed) ends now too, not at the next try.
    if (typed) log.info(`Deliveries ${o.ids.join(', ')} for ${userText(agentId)} offered`)
    else {
      await unoffer(store, o)
      await dropUndue(store, o.ids)
    }
    show(store, agentId)
  }
  // Put off part-way (the user began typing there, what it was made from changed): tried again by itself, soon.
  if (!typed) retrySoon(host, agentId)
  return typed
}

/**
 * Ends, of these deliveries still waiting, those their source no longer has due (a producer's own check, given with one,
 * is its caller's to answer: deliverNow says why it wasn't given; the next offer ends what its check no longer wants).
 */
async function dropUndue(store: Store, ids: readonly string[]): Promise<void> {
  const waiting = ids.map((id) => byId(store.records, id)).filter((r): r is DeliveryRecord => !!r && isWaiting(r))
  const fresh = await refreshAll(store, waiting)
  const ends = [...fresh].filter(([, f]) => 'cancel' in f) as [string, { cancel: string }][]
  if (!ends.length) return
  await transact(store, (d) => {
    for (const [id, f] of ends) {
      const r = byId(d.records, id)
      if (r && isWaiting(r)) set(store, d, r, 'cancelled', f.cancel)
    }
  }).catch((e) => log.warn('ending deliveries no longer due', e))
}

/** Agents whose line was put off part-way, tried again in a moment (one timer each; the tick and statuses try too). */
const retrying = new Map<string, ReturnType<typeof setTimeout>>()
const RETRY_MS = 1000
function retrySoon(host: string, agentId: string): void {
  const k = `${keyOf(host)}#${agentId}`
  if (retrying.has(k)) return
  const t = setTimeout(() => {
    retrying.delete(k)
    void offerNow(host, agentId).catch((e) => log.warn('offering deliveries', e))
  }, RETRY_MS)
  t.unref?.()
  retrying.set(k, t)
}

/**
 * Makes a delivery its caller wants given now, or not at all (#649: a task, a handover's step, which are never queued):
 * offered at once, alone; else cancelled, and NotGiven says why. `holds`: the caller's own check, asked with each key.
 */
export async function deliverNow(host: string, nd: NewDelivery, holds?: () => boolean, hooks: Omit<DeliveryHooks, 'holds'> = {}): Promise<DeliveryRecord | null> {
  /**
   * Waits while the agent's folder is being changed (#646 round 1: a Git switch or pull there): held, not refused, and
   * tried again once it is done (whether git succeeded or not). Whether it waited.
   */
  const heldByFolder = async (): Promise<boolean> => {
    const cwd = sessions.liveFor(host, nd.agentId)?.cwd
    if (!folderChanging(cwd)) return false
    await folderSteady(cwd)
    return true
  }
  // The user's own task for an agent that can't read an inbox (#650's decision): typed as their input, no delivery.
  if (!readsInbox(host, nd.agentId) && nd.from.kind === 'user') {
    for (;;) {
      if (await heldByFolder()) continue
      if (await typeLine(host, nd.agentId, nd.body, () => !holds || holds(), { need: nd.need ?? 'idle' })) return null
      // Put off because its folder began changing meanwhile: held until that is done, then typed.
      if (!(await heldByFolder())) break
    }
    throw new NotGiven(whyNoLine(host, nd.agentId, nd.need ?? 'idle') ?? (holds && !holds() ? 'what it was for changed meanwhile' : 'Hive could not type it'))
  }
  /**
   * Waits while the agent's hive tools are connecting (#865 round 3: a task given in the second after it became ready):
   * held, not refused, until they connect or the bound passes (sessions.hiveToolsSettled). Whether it waited.
   */
  const heldByTools = async (): Promise<boolean> => {
    if (!sessions.hiveToolsWaiting(host, nd.agentId) || !readyFor(sessions.liveFor(host, nd.agentId), nd.need ?? 'idle')) return false
    await sessions.hiveToolsSettled(host, nd.agentId)
    return true
  }
  const rec = await createDelivery(host, nd, { ...hooks, ...(holds ? { holds } : {}) })
  const store = await load(host)
  let why: string | null = null
  try {
    // Another try for the agent may be running (the tick's): once it is done, this one's own. A wait for its folder
    // (#646) or its hive tools (#865) is no try: given at once after it, or cancelled as before if it can't be then.
    for (let i = 0; i < 3; ) {
      const now = deliveryNow(host, rec.id)
      if (!now || !isWaiting(now)) break
      if ((await heldByFolder()) || (await heldByTools())) continue
      why = whyNoLine(host, nd.agentId, nd.need ?? 'idle') ?? (holds && !holds() ? 'what it was for changed meanwhile' : null)
      if (why) break
      if (await offerNow(host, nd.agentId, rec.id)) break
      if (await heldByFolder()) continue
      i++
    }
  } finally {
    const now = deliveryNow(host, rec.id)
    if (now && isWaiting(now)) {
      why ??= whyNoLine(host, nd.agentId, nd.need ?? 'idle') ?? 'Hive could not type it'
      await transact(store, (d) => {
        const r = byId(d.records, rec.id)
        if (r && isWaiting(r)) set(store, d, r, 'cancelled', `not given: ${why}`)
      }).catch(() => undefined)
      show(store, nd.agentId)
    }
  }
  const out = deliveryNow(host, rec.id) ?? rec
  if (out.state === 'cancelled' || out.state === 'refused' || out.state === 'expired') {
    store.hooks.delete(rec.id)
    throw new NotGiven(out.detail?.replace(/^not given: /, '') ?? why ?? out.state)
  }
  return out
}

/**
 * Makes a delivery that a launch carries (#649: the task an agent is started with, its prompt on the command line):
 * `start` launches the agent with its doorbell (#650: its id, never its text), and it is offered into that launch,
 * received once the agent reads it with hive_inbox. `start` failing cancels it, and the error stands.
 */
export async function launchWith<T extends { runId: string }>(host: string, nd: NewDelivery, start: (line: string) => Promise<T>, hooks?: DeliveryHooks): Promise<{ record: DeliveryRecord | null; launched: T }> {
  // The user's own task for an agent that can't read an inbox (#650's decision): its launch's prompt, as their input,
  // no delivery. Anyone else's is refused (createDelivery, below) before anything is launched.
  if (!readsInbox(host, nd.agentId) && nd.from.kind === 'user') return { record: null, launched: await start(nd.body) }
  // Saved as offered before anything is launched (persist before the effect, #647): not saved, nothing starts. From
  // here a crash leaves it offered, so it is uncertain after the restart, never queued and typed again as if new. The
  // scheduler never offers it (it isn't waiting), and the checks leave it alone while the launch starts.
  const rec = await createDelivery(host, { ...nd, launching: true }, hooks)
  const store = await load(host)
  store.offering.add(rec.id)
  let run: T
  try {
    run = await start(withCardNames(workspaceFor(store.host), () => offerLine([rec], null), scopeOfHost(store.host)))
  } catch (e) {
    store.offering.delete(rec.id)
    await transact(store, (d) => {
      const r = byId(d.records, rec.id)
      if (r?.state === 'offered' && r.offerRun === LAUNCHING) set(store, d, r, 'cancelled', `not given: ${(e as Error).message}`)
    }).catch((err) => log.warn("cancelling a launch's task", err))
    show(store, nd.agentId)
    throw e
  }
  // The launch it went into, in memory at once (what the checks follow if saving it fails), and on disk.
  if (run?.runId) {
    store.launches.set(rec.id, run.runId)
    store.confirming.set(rec.id, { runId: run.runId, count: 0 })
  }
  try {
    await transact(store, (d) => {
      const r = byId(d.records, rec.id)
      if (r?.state === 'offered' && r.offerRun === LAUNCHING && run?.runId) put(d, r, { ...r, offerRun: run.runId })
    })
  } catch (e) {
    // Launched with it: still offered into that launch (followed in memory); a restart finds it uncertain.
    log.warn("saving the launch a task went into (it is followed in memory; a restart finds it uncertain)", e)
  } finally {
    store.offering.delete(rec.id)
  }
  show(store, nd.agentId)
  return { record: deliveryNow(host, rec.id) ?? rec, launched: run }
}

/**
 * For a producer about to start from what an agent was told (a new watch, #649): what became of its offered deliveries
 * (rung again, uncertain, ended) is followed now, and their sources told, before this returns.
 */
export async function followAgent(host: string, agentId: string): Promise<void> {
  const store = stores.get(keyOf(host))
  if (!store?.records.some((r) => r.agentId === agentId && r.state === 'offered')) return
  await transact(store, (d) => recheck(store, d, agentId)).catch((e) => log.warn('checking deliveries', e))
  // Its sources are told in microtasks queued as it was published: they have run once this has.
  await new Promise((r) => setImmediate(r))
  show(store, agentId)
}

/** Follows each loaded host's deliveries (received, uncertain, ended), offers what waits, and refreshes the panes (overdue). */
function tick(): void {
  for (const store of stores.values()) {
    if (store.records.some((r) => isUnread(r) && (whyNot(store, r) || r.state === 'offered'))) transactSoon(store, 'checking deliveries', (d) => recheck(store, d))
    const agents = new Set(store.records.filter(isLive).map((r) => r.agentId))
    for (const a of agents) {
      show(store, a)
      if (store.records.some((r) => r.agentId === a && isWaiting(r))) void offerNow(store.host, a).catch((e) => log.warn('offering deliveries', e))
    }
  }
}

let started = false
/** Wires the service in (once, at start): statuses and a tick offer and follow deliveries, workspaces restore them. */
export function initDeliveries(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type === 'workspace-changed') {
      // Restored as a workspace opens: its projects' and its Assistant's (refusals shown, panes filled in).
      const hosts = [...(e.workspace?.projects ?? []).map((p) => p.path), ...(e.workspace?.assistant ? [e.workspace.assistant.path] : [])]
      for (const h of hosts) void load(h).catch((err) => log.warn('restoring deliveries', err))
      return
    }
    // A card moved or reviewed: what was tied to its round may be stale now (#652).
    if (e.type === 'tasks-changed') {
      sweepStale()
      return
    }
    if (e.type !== 'session-status') return
    const { projectPath, agentId, status } = e.state
    void load(projectPath)
      .then((store) => {
        // A doorbell let pass, a launch ended: what was offered rings once more, or is uncertain.
        if (store.records.some((r) => r.agentId === agentId && r.state === 'offered')) transactSoon(store, 'checking deliveries', (d) => recheck(store, d, agentId))
        show(store, agentId)
        // Idle for a message or a card event (watching, or its turn over while its own background tasks run, #726) too.
        if (readyFor(e.state, 'stalled') || readyFor(e.state) || status === 'watching') setTimeout(() => void offerNow(projectPath, agentId).catch((err) => log.warn('offering deliveries', err)), 500).unref?.()
      })
      .catch((err) => log.warn('loading deliveries', err))
  })
  // The user's pause after typing, a line taken, overdue: nothing tells of those, so they are looked at now and then.
  const timer = setInterval(tick, 5000)
  timer.unref?.()
  // A folder changed under its agents is steady again (#646): what waited for it is offered now, not at the next tick.
  onFolderSteady((folder) => {
    for (const st of sessions.liveStates()) if (st.cwd && inFolder(st.cwd, folder) && !folderChanging(st.cwd)) void offerNow(st.projectPath, st.agentId).catch((err) => log.warn('offering deliveries', err))
  })
}

// The workspace's database replaced (#1207 round 2: the upgrade to 1.0, a restore): its hosts' deliveries, read from the
// file before, go from memory (a save begun from them is refused by their generation). The next use of a host (an agent's
// status, the workspace opening) reads it again from the file as it is then, with what another Hive saved meanwhile;
// nothing reads it for a workspace closed meanwhile, which would open its database again (#1207 round 3). While the upgrade
// waited no agent could start, so none waits for an offer.
onDbReplaced((workspacePath) => {
  for (const [k, store] of stores) if (store.place.workspace.toLowerCase() === workspacePath.toLowerCase()) stores.delete(k)
})

// Sessions give their own lines through the service (#649: a lock's go-ahead, the carry-on after a sign-in, a handover's
// steps): it is set as this loads.
sessions.deliveries = {
  give: async (host, nd, hooks) => {
    const r = await createDelivery(host, nd, hooks)
    await offerNow(host, nd.agentId)
    return r
  },
  now: (host, nd, holds) => deliverNow(host, nd, holds),
  launch: (host, nd, start) => launchWith(host, nd, start),
  cancel: cancelFromSource
}

/** For tests: every loaded host's agents offered now (what the tick does), awaited. */
export async function offerAllForTests(): Promise<void> {
  const runs: Promise<boolean>[] = []
  for (const store of stores.values()) for (const a of new Set(store.records.filter(isWaiting).map((r) => r.agentId))) runs.push(offerNow(store.host, a))
  await Promise.all(runs)
}
/** For tests: what the tick follows (received, uncertain, ended), now, awaited. */
export async function followAllForTests(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => transact(store, (d) => recheck(store, d)).then(() => showAll(store))))
}
/** For tests: transactions still running finish. */
export async function settledForTests(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.all([...stores.values()].map((s) => s.lock))
}
/** For tests: every host's load under way has finished (those started while waiting too), however long its reads take. */
export async function loadsForTests(): Promise<void> {
  while (loading.size) await Promise.allSettled([...loading.values()])
}
/** For tests: forgets every host in memory, as a restart of Hive does (transactions finish first); what is on disk stays. */
/** For tests: a host's deliveries as saved (#1018: its workspace's database), with what is kept beside them. */
export async function savedForTests(host: string): Promise<{ next: number | undefined; deliveries: DeliveryRecord[]; invalid?: unknown[] }> {
  const place = await hostPlace(host)
  // In their table since 1.0 (#1211, store_rows gone); 0.9's rows while the workspace's upgrade waits.
  const waiting = upgradeWaiting(place.workspace)
  const old = waiting ? readStore(place.workspace, 'deliveries', place.scope) : null
  const db = workspaceDb(place.workspace).reader
  const value = (key: string): string | null => (old ? (old.meta.get(key) ?? null) : storeValue(db, 'deliveries', place.scope, key))
  const deliveries = old ? old.rows.map((r) => JSON.parse(r.doc) as DeliveryRecord) : (readDeliveryRows(db, place.scope) as unknown as DeliveryRecord[])
  const next = value('next')
  const invalid = value('invalid')
  return { next: next !== null ? (JSON.parse(next) as number) : undefined, deliveries, ...(invalid ? { invalid: JSON.parse(invalid) as unknown[] } : {}) }
}

export async function forgetDeliveriesForTests(): Promise<void> {
  await settledForTests()
  for (const t of retrying.values()) clearTimeout(t)
  retrying.clear()
  stores.clear()
  trying.clear()
}
