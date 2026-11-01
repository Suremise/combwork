import { randomBytes } from 'crypto'
import { rename, writeFile } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { projectAgents } from '../shared/defaults'
import { cardChange, carriedOver, ownCut, changesBetween, handoffsSince, hearsHandoffs, isDecisionEntry, changesSince, entryWithin, ENTRY_KEY, limitLine, markOf, movedIntoSince, seenOf, readMark, readSavedCondition, WAKE_MAX_BYTES, wakeAbout, watchLabel, cardWakeLine, userNameOf, releasedLine, withLanesTail, RELEASE_REASONS, type Released, type ReplyNote, alreadyThere, cardOver, encodeSince, WATCH_DEFAULT_LIMIT_MINUTES, WATCH_MAX_CARDS, WATCH_MAX_LIMIT_MINUTES, type Baseline, type CardChange, type CardMark, type ReviewWhere, type Seen, type WatchChange, type WatchCondition } from '../shared/watch'
import { loopReviewerOf, poolCard } from './loopReviewer'
import { agentBusy, agentEvent, agentLimitLine, agentMarkOf, agentPart, agentWakeLine, agentWatchLabel, readSavedAgentCondition, readSavedAgentMark, replyFirstLine, replyPart, REPLY_CHARS, type AgentEvent, type AgentMark, type AgentNow, type AgentWatchCondition, type WatchedAgent } from '../shared/agentWatch'
import { isProjectId, type ProjectIdIndex } from '../shared/projectIds'
import { rebase } from '../shared/movePaths'
import type { LaneInfo, LiveSessionState, StoredText, TaskCard, TaskColumn, TaskWatchInfo } from '../shared/types'
import { HISTORY, storedText } from '../shared/taskHistory'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { config } from './config'
import { onHiveEvent } from './events'
import { placeKey, readCapped, renameRetrying } from './fsutil'
import { openTable, saveTable } from './storeTables'
import { dbGenerationAt, onDbReplaced } from './boardStore'
import { coalesced } from './coalesce'
import { createLogger, userText } from './logger'
import { listLanes } from './lanes'
import { keepAsked, LANE_ALWAYS_EVENTS, LANE_CARD_CHANGES, laneCardMark, laneHits, laneLimitLine, laneWakeLine, laneWatchLabel, mergeDue, mergeStallReason, newLaneBase, readSavedLaneCondition, readSavedLaneMark, verdictsOf, type LaneAgentHit, type LaneAsked, type LaneHit, type LaneMark, type LaneNow, type LaneWatchAgents, type LaneWatchCards, type LaneWatchCondition, type WaitHit } from '../shared/laneWatch'
import { cardStallIn, laneOrderView } from './cardStall'
import { noteLoopWatch } from './loopCheck'
import { isResuming } from './restartResume'
import { sessions } from './sessions'
import { cardsNow, getTask, inScope, liveCardHeads, noteOnCard, unknownTask } from './tasks'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'
import { queueReturnOf, resubmittedOf } from './queueReturn'
import { devConsole, hiveSourceId, sessionSourceId } from './devConsole'
import { isUnread, type DeliveryRecord } from '../shared/deliveries'
import { readSavedUsage, usageHits, usageLimitLine, usageWakeLine, usageWatchLabel, type UsageWatch } from '../shared/usageWatch'
import { cancelFromSource, createDelivery, deliveryNow, followAgent, inFlightNow as deliveriesInFlight, load as loadDeliveries, offerNow, registerSource, settled as deliveriesSettled } from './deliveries'
import { inFlightNow as writerInFlight, onLineComing, settled as writerSettled } from './lineWriter'
import { readyFor } from './readiness'
import { HiveError } from './hiveError'
import { cardNamesOf, withCardNames } from './projectKeys'
import { namedBy } from '../shared/projectKeys'
import { projectPreferences } from './workflow/preferences'
import { forYouOfCards } from './workflow/cardWork'
import type { ForYouItem } from '../shared/workflow/workView'

/**
 * Wake-on-change watches (#128): an agent registers what it waits for on the board (hive_wait_for_tasks with wake), ends
 * its turn, and Hive types one line into it when a watched card changes, or when its overall limit passes with no change.
 * Nothing runs while it waits. One watch per agent (a new one replaces it), kept in the workspace's .hive/watches.json so
 * it survives the agent being resumed and Hive restarting; it ends when its line is typed, or when the agent or the user
 * cancels it. A watch whose agent isn't running (or is busy, or the user is typing in it) is delivered when the agent is
 * idle again: nothing is typed over its work or the user's.
 *
 * - A watch keeps its caller's view of the board (`scope`: a project agent's project, null for the whole board) and every
 *   read is checked against it, so a card moved to another project reads as gone and nothing about it is told.
 * - A workspace's watches belong to that workspace's lifetime: the folder and lifetime are taken before anything waits,
 *   checked after every wait and before every write, and the watches are dropped when it closes or the window switches.
 * - Changes to a workspace's watches happen one at a time (`locked`), so a board change checked while a watch is being
 *   registered is checked again once it is in place, and a cancel can't be undone by a delivery that was under way.
 * - An agent watch (#416, hive_wait_for_agents with wake) is a watch that follows agents instead of cards: it fires when
 *   a watched agent's turn ends, it waits for the user, or it stops, checked on every status change. It is the agent's
 *   one watch like any other (a card watch replaces it, and it replaces one), kept, typed and ended the same way.
 */

const log = createLogger('watches')
/** The user, as the Assistant's wake lines name them (#426): Settings → General → Your name. */
const userName = (): string => userNameOf(config.settings.general?.userName)

interface WatchRecord {
  id: string
  projectPath: string
  /**
   * The watcher's project's stable id (#508): read back, the watch follows its project to the folder that has the id now
   * (renamed or moved within the workspace). None for the Assistant, and in watches from before.
   */
  projectId?: string
  agentId: string
  /**
   * The project whose cards the agent may see (a project agent's own), or null for the whole board (the Assistant). Worked
   * out from the agent, never taken from the file.
   */
  scope: string | null
  /** The cards and what counts (an agent watch has no cards: `agents` says what it waits for). */
  cond: WatchCondition
  /**
   * An agent watch (#416): the agents it follows, and each as it was when the watch began (by agentKey). With `lanes`, a
   * lane watch's agents beside its lanes (HI-1987: one watch for lanes, cards and an agent's work on no card).
   */
  agents?: AgentWatchCondition
  agentMarks?: Record<string, AgentMark>
  /**
   * A lane watch (#531): the lanes it follows (ids, or every running lane in the watcher's view) and what counts, and each
   * lane as last measured (by id): as the watch began, moved on while nothing that counts happens, and what its line
   * told once it fires. A lane's cards are followed as the lane goes on; `cond` holds only cards beside its lanes (#726:
   * a release card in no lane), followed as a card watch follows its cards, a card becoming blocked counting too.
   */
  lanes?: LaneWatchCondition
  laneMarks?: Record<string, LaneMark>
  /**
   * A usage watch (HI-2195): accounts whose limit reaching a share fires it, alone (no cards: `cond` is NO_CARDS) or
   * beside a card or lane watch's cards and lanes.
   */
  usage?: UsageWatch[]
  /**
   * A lane watch's: the latest of agents' waits for the user it knows (#726, a `seq` of waitStarts): one after it, by an
   * agent of the projects it follows and still going on, fires it. Moves on while nothing that counts happens.
   */
  waitSeq?: number
  /**
   * Where a lane watch's view of what is new begins (#531 round 2 finding): a lane started, or a card added to a lane,
   * after it is measured from an empty start. The watch's own start, or for one started after a wake, when that wake's
   * line was made, so what happened between the wake and this watch is told.
   */
  laneSince?: string
  /** Each watched card as it was when the watch began: what a change is measured from. */
  marks: Record<string, CardMark>
  /**
   * Each watched card as last seen (the quit check: is the work it waits for going on?). Not saved: it starts again from
   * `marks` when the watches are read back (moves into a column are found in the cards' history).
   */
  current?: Record<string, CardMark>
  since: string
  /**
   * Where the watch's view of each card ends (#224): the last history entry and comment counted in `marks`. What comes
   * after counts as news, however close in time. Saved watches from before have none (then times are compared).
   */
  seen?: Record<string, Seen>
  /**
   * Started after a wake: the agent's name on the board, whose own changes between that wake and `since` aren't news
   * (the cards are measured from what the wake told).
   */
  self?: string
  /**
   * The Assistant's card watch (#418): the latest of the user's replies to agents (see replies) it already knows; one
   * after it to a watched card's agent or reviewer is news. Absent: from before #418 (then from when it was read).
   */
  replySeq?: number
  /**
   * A project agent's part in each watched card as the watch began (#420): its agent, its reviewer, or a reviewer
   * waiting for it to arrive in Review ("awaiting"). A card it has no part in
   * (another agent's card it depends on) isn't here, and is never released.
   */
  on?: Record<string, OnCard>
  /** A project agent's board name: for the history, and its own comments aren't news to its watch (#1074). */
  watcherName?: string
  /** Cards that left the watch since it began, released (#420): told with its next line. */
  released?: Released[]
  limitMinutes: number
  limitAt: string
  /**
   * It fired: the line for the agent (made again when it is handed over), and the cards whose state it tells.
   * `delivery`: the delivery it was handed over as (#649, deliveries.ts), saved before the delivery service types it: the
   * watch ends once that is received (its line taken by its CLI, or fetched), and a watch read back with one follows it.
   * `laneMarks`: a lane watch's marks as its line tells them, pending until that delivery is received (the watch's own
   * marks don't move before: one not received fires again from them). `again`: it may have been given before (read back
   * from before #649 being typed, `sending`, which proves only an attempt): handed over saying it may repeat.
   * `agents`: an agent watch's agents it tells about (by agentKey; none for its limit).
   */
  fired?: { line: string; at: string; cards: number[]; agents?: string[]; lanes?: true; replies?: true; delivery?: string; laneMarks?: Record<string, LaneMark>; again?: true; sending?: string; limit?: true }
}

interface Store {
  ws: WorkspaceService
  /** The folder its watches were loaded from, and that folder's lifetime in its window (aborted when it closes). */
  path: string
  life: AbortSignal
  list: WatchRecord[]
  /** Saved entries that aren't valid watches: kept as they were in the file (never overwritten), never acted on. */
  invalid: unknown[]
  /** A save failed: what is saved is behind the list, and the tick saves again. */
  dirty: boolean
  /** One change to the list at a time. */
  queue: Promise<unknown>
  /** Watches being typed now, by id: cancelled stops the typing (checked before each piece and before Enter). */
  delivering: Map<string, { cancelled: boolean }>
  /** The workspace database's generation it was read from (#1207 round 2): from an older one, it is closed (`alive`). */
  gen: number
  /** Its workspace's place as its load entered (#1456): what its generation is judged and its replacement matched by. */
  place: string
  /**
   * What each agent's wakes told it (#224): each card of a delivered watch as its line was made from it (for a line about
   * the limit, as the watch began: nothing new was told), the latest wake's for a card in several. The agent's next watch
   * starts from there for those cards. In memory only (a restart between a wake and the next watch starts that watch from
   * now), at most MAX_WATCHES agents and WOKE_CARDS cards each.
   */
  woke: Map<string, Map<string, Baseline>>
  /**
   * What each agent's wakes told it about the agents it watched (#416): each one's latest event told (`seq`, see
   * happenings), by agentKey. Its next agent watch starts from there, so an event between the two is news. In memory,
   * bounded as `woke`.
   */
  wokeAgents: Map<string, Map<string, number>>
  /**
   * What each agent's lane watch wakes told it (#531): when the line was made, and each lane's mark, by id. Its next lane
   * watch starts there. In memory, bounded as `woke`. Also the cards beside its lanes (#726), which its next lane watch
   * keeps unless it names others, and the latest wait for the user it knew.
   */
  wokeLanes: Map<string, { at: string; marks: Map<string, LaneMark>; cards?: { cards: number[]; changes: WatchChange[] }; waitSeq?: number; agents?: AgentWatchCondition; ids?: LaneWatchCondition['ids'] }>
  /** A lane check is due (debounced: status changes come in bursts). */
  laneCheck?: true
  /** When the tick last checked lane watches (stalls come with time). */
  laneTickAt?: number
  /** The latest of the user's replies (#418) each watcher's wakes told it about: its next card watch starts there. */
  wokeReplies: Map<string, number>
}

/** How long a fired watch waits before its line is typed, so changes landing together are told together (#224). */
const SETTLE_MS = 1500
/** The most cards whose last wake an agent's next watch can start from: the latest told. */
const WOKE_CARDS = 100

/**
 * What watches are doing in the background (#570): the checks the board's events start, deliveries and the settle
 * before each, lane checks, the confirmations that a typed wake was taken, notes on cards. `settled()` resolves once none
 * is left, what one starts meanwhile included, so a test (and Hive's loop wakes, #578) waits for the outcome rather than
 * for a quiet spell or a read straight after a call. A wake typed again after its line was cleared (#530) counts while
 * it is being typed (and then confirmed), not while it waits for its agent to be ready: that is the agent's, not Hive's.
 */
const inFlight = new Set<Promise<unknown>>()
/** Counts work as in flight until it ends, and returns it (its result or failure as it was). */
function counted<T>(work: Promise<T>): Promise<T> {
  const p = work.then(
    () => undefined,
    () => undefined
  )
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
  return work
}
/** Runs work in the background, counted until it ends; a failure is logged as `what`. */
function inBackground(what: string, work: Promise<unknown>): void {
  void counted(work.catch((e) => log.warn(what, e)))
}
/** Runs work after `ms`, counted from now until it ends. */
function inBackgroundAfter(ms: number, what: string, work: () => Promise<unknown>): void {
  inBackground(what, new Promise<void>((done, fail) => setTimeout(() => work().then(() => done(), fail), ms).unref?.()))
}
/** Resolves once watches have nothing in flight (#570): what was started in the background has ended, its lines' confirmations too. */
export async function settled(): Promise<void> {
  while (inFlight.size || writerInFlight() || deliveriesInFlight()) {
    await Promise.allSettled([...inFlight])
    await writerSettled()
    await deliveriesSettled()
  }
}
/** Whether watches have something in flight now (loop wakes' settled() waits for both), their wakes' lines included. */
export const inFlightNow = (): boolean => inFlight.size > 0 || writerInFlight() || deliveriesInFlight()

/**
 * Seams for unit tests: pauses that make races happen (after a watch's cards are read; after the watches are read), and
 * the file system's rename (a damaged watches.json set aside as it is moved in), to make it fail.
 */
export const testHooks: {
  afterRead?: () => Promise<void>
  afterLoad?: () => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  /** The settle before a fired line is typed (SETTLE_MS): 0 types it at once. */
  settleMs?: number
  /** Told each time a check reads a card from disk (#321: each card once a check). */
  cardRead?: (n: number) => void
  /** HI-2197: a pause before a new conversation's end of an old watch cancels that watch's wake. */
  beforeWakeCancel?: () => Promise<void>
} = {}
/** The same seams by their first name (round-one probes use it). */
export const testPauses = testHooks
const renameOnce = (from: string, to: string): Promise<void> => (testHooks.rename ?? rename)(from, to)

/**
 * At most this many watches a workspace (one per agent: up to 24 agents in each of many projects, #562), and this big a file. Both
 * hold for what Hive writes as well as what it reads: a watch that would pass either is refused when it is made.
 */
const MAX_WATCHES = 500
const MAX_FILE_BYTES = 1024 * 1024
/** A fired line's most bytes as saved (JSON-quoted): what a watch may still grow by is known when it is made. */
const MAX_LINE_BYTES = WAKE_MAX_BYTES
const jsonBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s))
/** A line cut to fit MAX_LINE_BYTES as saved. */
/**
 * A watch's line, made with its cards named by key (#1219: "HI-12 (#40)"), as its watcher may see them: a project agent
 * its own project's cards (another's, or one moved there, by number), the Assistant every card.
 */
function lineFor(store: Store, rec: WatchRecord, make: () => string): string {
  return fitLine(withCardNames(store.ws, make, rec.scope))
}

function fitLine(line: string): string {
  if (jsonBytes(line) <= MAX_LINE_BYTES) return line
  let s = line
  while (s && jsonBytes(`${s}…`) > MAX_LINE_BYTES) s = s.slice(0, -1)
  return `${s}…`
}

/** A watcher's part in a card (#420). */
interface OnCard {
  role: 'agent' | 'reviewer' | 'awaiting'
}

/** The watches of each open workspace, loaded on first need (by its path, case-folded). */
const stores = new Map<string, Store>()
const loading = new Map<string, Promise<Store>>()
/**
 * A workspace's watches file before #1018, by the folder it was loaded from (a window's service can open another
 * workspace later): moved into the workspace database the first time (storeTables.ts), then kept as a backup.
 */
const fileOf = (path: string): string => join(path, '.hive', 'watches.json')
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const closedError = (): Error => new Error('The workspace was closed')

/** What an agent may see of the board: its own project's cards, or every card for the Assistant. */
const scopeFor = (ws: WorkspaceService, projectPath: string): string | null => (ws.isAssistantHome(projectPath) ? null : basename(resolve(projectPath)))
/** Whether an agent's folder is a session host of this workspace (a project in it, or its Assistant). */
const hostedIn = (ws: WorkspaceService, path: string, projectPath: string): boolean =>
  ws.isAssistantHome(projectPath) || same(dirname(resolve(projectPath)), resolve(path))

/**
 * Whether an agent may watch an agent of `target` (#416): a project of this workspace (never the Assistant). Agents'
 * status is open to every caller; what another project's agent said isn't (shownTo).
 */
const mayWatch = (ws: WorkspaceService, path: string, _projectPath: string, target: string): boolean => !ws.isAssistantHome(target) && same(dirname(resolve(target)), resolve(path))

/**
 * A watched agent as its watcher may be told it: a project agent (`scope`, its project) isn't told the reply of another
 * project's agent, whose conversation holds that project's cards (as its activity is closed to it).
 */
const shownTo = (scope: string | null, agent: WatchedAgent, now: AgentNow): AgentNow => (scope === null || same(scope, basename(resolve(agent.projectPath))) ? now : { ...now, reply: null })

/** Whether a store's workspace is still the one open in its window. */
// Read from a database since replaced (#1207 round 2: the upgrade to 1.0, a restore), it is closed too: never saved over the
// file as it is now, and read again.
const alive = (store: Store): boolean => !store.life.aborted && !!store.ws.path && same(store.ws.path, store.path) && store.gen === dbGenerationAt(store.place)
const checkAlive = (store: Store): void => {
  if (!alive(store)) throw closedError()
}

/** Runs fn after the store's earlier changes (and before later ones). */
function locked<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const run = store.queue.then(() => {
    checkAlive(store)
    return fn()
  })
  store.queue = run.catch(() => undefined)
  return run
}

/** A workspace's watches (loaded once per lifetime). */
function load(ws: WorkspaceService): Promise<Store> {
  // Its folder and lifetime now, before anything waits: a window switching workspaces meanwhile can't change them.
  const path = ws.path
  const life = ws.lifetime
  if (!path || life.aborted) return Promise.reject(closedError())
  const k = path.toLowerCase()
  const had = stores.get(k)
  if (had && had.ws === ws && alive(had)) return Promise.resolve(had)
  const going = loading.get(k)
  if (going) return going
  // Read from the database as it is now: replaced meanwhile (the upgrade to 1.0, a restore), the read is closed too.
  // Its place resolved once, as it enters (#1456): its generation is judged by it from then on.
  const place = placeKey(path)
  const gen = dbGenerationAt(place)
  const open = (): boolean => !life.aborted && !!ws.path && same(ws.path, path) && gen === dbGenerationAt(place)
  const p = (async () => {
    const read = await readSaved(path, open)
    await testHooks.afterLoad?.()
    if (!open()) throw closedError()
    // Only this workspace's agents, each with the view of the board its own token gives it. A watch handed over as a
    // delivery follows it (below); one from before #649 that was being typed when Hive stopped is offered once more.
    const list: WatchRecord[] = []
    const invalid = read.invalid
    let migrated = false
    // Each watch in its project's folder now, by the project's id (#508), its agents' too; one from before gets the ids.
    const ids = await ws.projectIds()
    if (!open()) throw closedError()
    let stamped = false
    const gone = new Set<WatchRecord>()
    const from = oldFolder(ws, path, ids, read.list.map((x) => x.rec))
    for (const { rec } of read.list) {
      const r = followIds(ws, path, ids, rec, from)
      if (r === 'gone') gone.add(rec)
      else if (r === 'changed') stamped = true
    }
    for (const { rec, raw } of read.list) {
      if (gone.has(rec)) invalid.push(raw)
      else if (!hostedIn(ws, path, rec.projectPath) || (rec.agents && !rec.agents.agents.every((a) => mayWatch(ws, path, rec.projectPath, a.projectPath)))) invalid.push(raw)
      else if (list.some((x) => same(x.projectPath, rec.projectPath) && x.agentId === rec.agentId)) invalid.push(raw)
      else {
        // Being typed when Hive stopped (from before #649): an attempt, not a receipt. It is handed over once more, made
        // from the cards as they are then, saying it may repeat.
        if (rec.fired?.sending) {
          delete rec.fired.sending
          rec.fired.again = true
          migrated = true
          log.info(`The wake for ${userText(rec.agentId)} was being typed when Hive stopped: it is offered once more, saying it may repeat`)
        }
        list.push({ ...rec, scope: scopeFor(ws, rec.projectPath) })
      }
    }
    // What was migrated is saved at the next tick.
    const store: Store = { ws, path, life, list, invalid, dirty: migrated || stamped || gone.size > 0, queue: Promise.resolve(), delivering: new Map(), woke: new Map(), wokeAgents: new Map(), wokeLanes: new Map(), wokeReplies: new Map(), gen, place }
    // Read back too big for every watch to end (a hand edit, an older build): room is made, nothing is lost.
    if (budget(store, list) > MAX_FILE_BYTES) {
      const over: WatchRecord[] = []
      if (!(await setAside(store)) || budget(store, list) > MAX_FILE_BYTES) {
        // Each watch measured once, the last ones taken off until the rest fit (#321: not the whole file again a pop).
        const empty = Buffer.byteLength(fileText(store, [], []))
        const sizes = list.map((r) => entryBytes(atMost(r)))
        let sum = sizes.reduce((a, b) => a + b, 0)
        while (list.length && sizeOf(empty, sizes, sum) > MAX_FILE_BYTES) {
          over.unshift(list.pop()!)
          sum -= sizes.pop()!
        }
        if (over.length && !(await setAside(store, over))) throw new Error('The card watches file is too big, and its extra watches could not be set aside')
      }
      store.dirty = true
    }
    if (!open()) throw closedError()
    stores.set(k, store)
    // Closed or switched: its watches go from memory (they stay on disk for its next opening), and typing stops.
    life.addEventListener(
      'abort',
      () => {
        if (stores.get(k) === store) stores.delete(k)
        for (const d of store.delivering.values()) d.cancelled = true
      },
      { once: true }
    )
    // Agents already running learn their watch now.
    for (const r of list) sessions.watchChanged(r.projectPath, r.agentId)
    // Those handed over as deliveries follow what became of them while Hive was closed (#649).
    if (list.some((r) => r.fired?.delivery)) inBackground('following wakes', followDelivered(store))
    // Cards can change while Hive is closed (a pull of .hive/tasks, a hand edit): check them now, not at the next change.
    if (list.length) inBackgroundAfter(0, 'checking watches', () => evaluate(ws))
    return store
  })().finally(() => {
    if (loading.get(k) === p) loading.delete(k)
  })
  loading.set(k, p)
  return p
}

type FileRead = { list: { rec: WatchRecord; raw: unknown }[]; invalid: unknown[] }
/** The watches as saved, before they are checked: each saved entry, and those kept aside as not valid. */
type Saved = { watches: unknown[]; invalid: unknown[] }

/**
 * A workspace's watches as saved in its database (#1018; its typed tables since #1212), moved in from watches.json the first time. Entries that aren't
 * valid watches, and any over the limit, are kept aside as they were.
 */
async function readSaved(path: string, open: () => boolean): Promise<FileRead> {
  const data = await openTable(path, 'watches', fileOf(path), async () => {
    const got = await readFileOf(path, open)
    if (!got) return null
    const meta: Record<string, string> = got.invalid.length ? { invalid: JSON.stringify(got.invalid) } : {}
    return { docs: got.watches, meta }
  })
  const raw = data.docs
  const kept = data.meta.get('invalid')
  const invalid: unknown[] = kept ? (JSON.parse(kept) as unknown[]) : []
  const list: { rec: WatchRecord; raw: unknown }[] = []
  for (const v of raw) {
    const r = list.length < MAX_WATCHES ? readRecord(v) : null
    if (r && !list.some((x) => same(x.rec.projectPath, r.projectPath) && x.rec.agentId === r.agentId)) list.push({ rec: r, raw: v })
    else invalid.push(v)
  }
  if (invalid.length) log.warn(`${invalid.length} saved watch${invalid.length === 1 ? ' is' : 'es are'} not valid: kept aside, not used`)
  return { list, invalid }
}

/**
 * Reads a workspace's watches file from before #1018 (at most MAX_FILE_BYTES), to move it in. No file is null; a file
 * that can't be read (locked, no permission) is an error, never "none". A file too big to be Hive's, or one that isn't
 * JSON, is set aside (renamed, not deleted) and none are moved in; if it can't be set aside, that is an error too.
 */
async function readFileOf(path: string, open: () => boolean): Promise<Saved | null> {
  const file = fileOf(path)
  let got: { data: Buffer; more: boolean }
  try {
    got = await readCapped(file, MAX_FILE_BYTES)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Could not read the card watches (${(e as Error).message})`, { cause: e })
  }
  const aside = async (why: string): Promise<Saved> => {
    const to = `${file}.${why}-${Date.now()}`
    try {
      await renameRetrying(file, to, 20, () => {
        if (!open()) throw closedError()
      }, renameOnce)
    } catch (e) {
      throw new Error(`The card watches file is ${why} and couldn't be set aside (${(e as Error).message}): it was left as it is`, { cause: e })
    }
    log.warn(`The watches file was ${why}: set aside as ${userText(to)}`)
    return { watches: [], invalid: [] }
  }
  if (got.more) return aside('too-big')
  const text = got.data.toString('utf8')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return aside('damaged')
  }
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as { watches?: unknown; invalid?: unknown }) : null
  if (!obj) return aside('damaged')
  return { watches: Array.isArray(obj.watches) ? obj.watches : [], invalid: Array.isArray(obj.invalid) ? [...obj.invalid] : [] }
}

/** A saved watch, checked in full (the file can be edited by hand) and rebuilt from what checks out; null if it isn't one. */
function readRecord(v: unknown): WatchRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max
  const time = (x: unknown): x is string => text(x, 40) && Number.isFinite(Date.parse(x))
  if (!text(r.id, 64) || !text(r.projectPath, 1024) || !text(r.agentId, 128)) return null
  // An agent watch (#416): its agents and their marks, and no cards.
  let agents: AgentWatchCondition | undefined
  let agentMarks: Record<string, AgentMark> | undefined
  if (r.agents !== undefined) {
    const a = readSavedAgentCondition(r.agents)
    if (!a || !r.agentMarks || typeof r.agentMarks !== 'object') return null
    agentMarks = {}
    for (const t of a.agents) {
      const k = agentKey(t.projectPath, t.agentId)
      const m = readSavedAgentMark((r.agentMarks as Record<string, unknown>)[k])
      if (!m) return null
      agentMarks[k] = m
    }
    agents = a
  }
  // A lane watch (#531): its lanes and their marks, and the agents (HI-1987) and cards (#726) beside them, if any.
  let lanes: LaneWatchCondition | undefined
  let laneMarks: Record<string, LaneMark> | undefined
  if (r.lanes !== undefined) {
    const c = readSavedLaneCondition(r.lanes)
    if (!c || !r.laneMarks || typeof r.laneMarks !== 'object' || Array.isArray(r.laneMarks)) return null
    const entries = Object.entries(r.laneMarks as Record<string, unknown>)
    if (entries.length > 200) return null
    laneMarks = {}
    for (const [id, m] of entries) {
      const mark = /^[\w-]{1,64}$/.test(id) ? readSavedLaneMark(m) : null
      if (!mark) return null
      laneMarks[id] = mark
    }
    lanes = c
    if (r.laneSince !== undefined && !time(r.laneSince)) return null
    if (r.waitSeq !== undefined && (typeof r.waitSeq !== 'number' || !Number.isInteger(r.waitSeq) || r.waitSeq < 0)) return null
  }
  // A usage watch's accounts (HI-2195), if any.
  let usage: UsageWatch[] | undefined
  if (r.usage !== undefined) {
    const u = readSavedUsage(r.usage)
    if (!u) return null
    usage = u
  }
  // A lane watch's cards beside its lanes (#726), if any (one from before has none); a usage watch alone has none.
  const someCards = Array.isArray((r.cond as { cards?: unknown } | undefined)?.cards) && (r.cond as { cards: unknown[] }).cards.length > 0
  const laneCards = lanes && someCards
  const cond = (agents && !lanes) || (lanes && !laneCards) || (usage && !agents && !lanes && !someCards) ? NO_CARDS : readSavedCondition(r.cond)
  if (!cond || !r.marks || typeof r.marks !== 'object') return null
  const marks: Record<string, CardMark> = {}
  for (const n of cond.cards) {
    const m = readMark((r.marks as Record<string, unknown>)[n])
    if (!m) return null
    marks[n] = m
  }
  const minutes = r.limitMinutes
  if (!time(r.since) || !time(r.limitAt) || typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > WATCH_MAX_LIMIT_MINUTES) return null
  let fired: WatchRecord['fired']
  if (r.fired !== undefined) {
    const f = r.fired as Record<string, unknown> | null
    const cards = Array.isArray(f?.cards) ? f.cards.filter((n): n is number => cond.cards.includes(n as number)) : null
    if (!f || typeof f.line !== 'string' || jsonBytes(f.line) > MAX_LINE_BYTES || !f.line.startsWith('[Hive] ') || !time(f.at) || !cards || (f.sending !== undefined && !time(f.sending)) || (f.delivery !== undefined && !(typeof f.delivery === 'string' && /^m\d{1,15}$/.test(f.delivery)))) return null
    const told = Array.isArray(f.agents) && agentMarks ? f.agents.filter((k): k is string => typeof k === 'string' && k in agentMarks!) : undefined
    // A lane watch's pending marks (#649): each as a lane watch's own marks are read.
    let pendingLanes: Record<string, LaneMark> | undefined
    if (f.laneMarks !== undefined) {
      if (!lanes || !f.laneMarks || typeof f.laneMarks !== 'object' || Array.isArray(f.laneMarks)) return null
      pendingLanes = {}
      for (const [id, m] of Object.entries(f.laneMarks as Record<string, unknown>).slice(0, 200)) {
        const mark = /^[\w-]{1,64}$/.test(id) ? readSavedLaneMark(m) : null
        if (!mark) return null
        pendingLanes[id] = mark
      }
    }
    fired = { line: f.line, at: f.at, cards, ...(told?.length ? { agents: told } : {}), ...(f.lanes === true && lanes ? { lanes: true as const } : {}), ...(f.replies === true ? { replies: true as const } : {}), ...(f.delivery ? { delivery: f.delivery as string } : {}), ...(pendingLanes ? { laneMarks: pendingLanes } : {}), ...(f.again === true ? { again: true as const } : {}), ...(f.sending ? { sending: f.sending as string } : {}), ...(f.limit === true ? { limit: true as const } : {}) }
  }
  // Where its view of each card ended (every card, or none from before #224), and whose own changes aren't news.
  let seen: Record<string, Seen> | undefined
  if (r.seen !== undefined) {
    if (!r.seen || typeof r.seen !== 'object') return null
    seen = {}
    const key = (x: unknown): x is string | null => x === null || (typeof x === 'string' && ENTRY_KEY.test(x))
    for (const n of cond.cards) {
      const s = (r.seen as Record<string, { h?: unknown; c?: unknown } | undefined>)[n]
      if (!s || !key(s.h) || !key(s.c)) return null
      seen[n] = { h: s.h, c: s.c }
    }
  }
  if (r.self !== undefined && (!text(r.self, 300) || !seen)) return null
  if (r.replySeq !== undefined && (typeof r.replySeq !== 'number' || !Number.isInteger(r.replySeq) || r.replySeq < 0)) return null
  // A watcher's part in its cards, and the cards released since (#420).
  let on: Record<string, OnCard> | undefined
  if (r.on !== undefined) {
    if (!r.on || typeof r.on !== 'object' || Array.isArray(r.on)) return null
    on = {}
    // A watch saved before #481 also kept whether the card was blocked: no longer used.
    for (const [k, part] of Object.entries(r.on as Record<string, { role?: unknown }>)) {
      if (!cond.cards.includes(Number(k)) || !part || !['agent', 'reviewer', 'awaiting'].includes(part.role as string)) return null
      on[k] = { role: part.role as OnCard['role'] }
    }
  }
  if (r.watcherName !== undefined && !text(r.watcherName, 300)) return null
  let released: Released[] | undefined
  if (r.released !== undefined) {
    if (!Array.isArray(r.released) || r.released.length > WATCH_MAX_CARDS) return null
    released = []
    for (const x of r.released as { number?: unknown; why?: unknown; detail?: unknown }[]) {
      if (!x || !Number.isInteger(x.number) || (x.number as number) <= 0 || !RELEASE_REASONS.includes(x.why as Released['why']) || !(x.detail === null || text(x.detail, 300))) return null
      released.push({ number: x.number as number, why: x.why as Released['why'], detail: x.detail as string | null })
    }
  }
  const from = { ...(seen ? { seen } : {}), ...(r.self ? { self: r.self as string } : {}) }
  // The scope is set by the workspace that loads it (from the agent's folder), whatever the file says.
  return { id: r.id, projectPath: r.projectPath, ...(isProjectId(r.projectId) ? { projectId: r.projectId } : {}), agentId: r.agentId, scope: '', cond, ...(agents ? { agents, agentMarks } : {}), ...(usage ? { usage } : {}), ...(lanes ? { lanes, laneMarks, ...(r.laneSince ? { laneSince: r.laneSince as string } : {}), ...(typeof r.waitSeq === 'number' ? { waitSeq: r.waitSeq } : {}) } : {}), marks, current: { ...marks }, since: r.since, ...from, limitMinutes: minutes, limitAt: r.limitAt, ...(typeof r.replySeq === 'number' ? { replySeq: r.replySeq } : {}), ...(on ? { on } : {}), ...(r.watcherName ? { watcherName: r.watcherName as string } : {}), ...(released ? { released } : {}), ...(fired ? { fired } : {}) }
}

/** An agent watch's condition on cards: none. */
const NO_CARDS: WatchCondition = { cards: [], changes: [] }

/** A watch as the file keeps it (the scope and the cards as last seen are worked out on load). */
const entryOf = ({ scope: _scope, current: _current, ...r }: WatchRecord): object => r

/** The file's text for a list of watches (the scope and the cards as last seen aren't saved: both are worked out on load). */
const fileText = (store: Store, list: WatchRecord[], invalid = store.invalid): string =>
  JSON.stringify({ version: 1, watches: list.map(({ scope: _scope, current: _current, ...r }) => r), ...(invalid.length ? { invalid } : {}) }, null, 2) + '\n'

/** The longest a watch's saved form can grow to: fired with the longest line, being typed. */
const AT = new Date(0).toISOString()
const atMost = (r: WatchRecord): WatchRecord => ({ ...r, fired: { line: 'x'.repeat(MAX_LINE_BYTES - 2), at: AT, cards: r.cond.cards, ...(r.agentMarks ? { agents: Object.keys(r.agentMarks) } : {}), ...(r.laneMarks ? { laneMarks: r.laneMarks } : {}), delivery: 'm999999999999999', again: true, sending: AT, limit: true } })
/**
 * The bytes one watch takes in the file (#321): its own JSON as fileText writes it, an entry of the "watches" array, so
 * each of its lines indented by four more spaces.
 */
function entryBytes(r: WatchRecord): number {
  const { scope: _scope, current: _current, ...saved } = r
  return savedEntryBytes(saved)
}
const savedEntryBytes = (saved: object): number => {
  const s = JSON.stringify(saved, null, 2)
  let lines = 1
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) lines++
  return Buffer.byteLength(s) + 4 * lines
}
/** The watches file's size for these saved entries, measured as budget() does (#321): for tests, against its text. */
export const savedFileBytes = (watches: object[], invalid: unknown[] = []): number =>
  sizeOf(Buffer.byteLength(JSON.stringify({ version: 1, watches: [], ...(invalid.length ? { invalid } : {}) }, null, 2) + '\n'), watches.map(savedEntryBytes))

/**
 * The file's size with these entries (#321), without making its text: the file with no watches, then the entries, each
 * after a ",\n" but the first, the "[]" made "[\n" … "\n  ]". Exactly what fileText's length would be.
 */
const sizeOf = (empty: number, entries: number[], sum = entries.reduce((a, b) => a + b, 0)): number => (entries.length ? empty + sum + 2 * (entries.length - 1) + 4 : empty)

/**
 * The file's size with every watch at its longest: it must fit, so a watch Hive took can always fire, be typed and end.
 * Measured watch by watch (#321): making the whole file's text for it took seconds at 400 watches, once a pop.
 */
const budget = (store: Store, list: WatchRecord[], invalid = store.invalid): number => sizeOf(Buffer.byteLength(fileText(store, [], invalid)), list.map((r) => entryBytes(atMost(r))))

/**
 * Makes room in the file: the saved entries that aren't valid watches (and, read back over the limit, the watches that
 * don't fit) move to a file of their own next to it, created new (never over another), so nothing is lost. False if
 * there was nothing to move or it couldn't be written (then nothing moved).
 */
async function setAside(store: Store, watches: WatchRecord[] = []): Promise<boolean> {
  if (!store.invalid.length && !watches.length) return false
  const to = `${fileOf(store.path)}.kept-aside-${Date.now()}-${randomBytes(3).toString('hex')}`
  const text = JSON.stringify({ version: 1, ...(watches.length ? { watches: watches.map(({ scope: _scope, current: _current, ...r }) => r) } : {}), ...(store.invalid.length ? { invalid: store.invalid } : {}) }, null, 2) + '\n'
  try {
    checkAlive(store)
    await writeFile(to, text, { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    log.warn('setting watches aside', e)
    return false
  }
  log.warn(`To keep the card watches file small enough, ${store.invalid.length} entr${store.invalid.length === 1 ? 'y' : 'ies'} that aren't valid watches${watches.length ? ` and ${watches.length} watch${watches.length === 1 ? '' : 'es'}` : ''} moved to ${userText(to)}`)
  store.invalid = []
  return true
}

/**
 * Saves a workspace's watches (under its lock) to the workspace they came from, only while it is open there: one
 * transaction in its database (#1018, #1212: storeTables.ts), whose rows are the watches, checked against the
 * workspace's lifetime just before it, with nothing awaited between: a save can't land after the workspace closed. Too
 * big: refused.
 */
async function save(store: Store): Promise<void> {
  checkAlive(store)
  const text = fileText(store, store.list)
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Too many card watches to keep in this workspace')
  await saveTable(store.path, 'watches', store.list.map(entryOf), { invalid: store.invalid.length ? JSON.stringify(store.invalid) : null }, () => checkAlive(store))
  store.dirty = false
}

/** A save that may fail (a background one): the tick tries again. */
const saveQuietly = (store: Store): Promise<void> =>
  save(store).catch((e) => {
    store.dirty = true
    log.warn('saving watches', e)
  })

/**
 * A watch as Hive reports it (its English `label`: the Agent API's statusMessage and watching, the inbox's offer line).
 * Its cards are named as its watcher's workspace names them (HI-1688: by key, "Waiting for HI-12 → Review"), whatever
 * work asks: a status read outside any request has no names of its own, and gave `#12`. A project agent's watch names
 * another project's card by its number, as everything that agent reads does (#1219).
 */
function infoOf(r: WatchRecord): TaskWatchInfo {
  const info = kindInfoOf(r)
  // A usage watch (HI-2195): alone, its accounts are its label; beside cards or lanes, they follow theirs.
  if (!r.usage) return info
  return usageOnly(r) ? { ...info, usage: true, label: `Waiting for usage: ${usageWatchLabel(r.usage)}` } : { ...info, usage: true, label: `${info.label}, and usage: ${usageWatchLabel(r.usage)}` }
}

/** A usage watch alone (HI-2195): no cards, agents or lanes. */
const usageOnly = (r: WatchRecord): boolean => !!r.usage && !r.agents && !r.lanes && !r.cond.cards.length

function kindInfoOf(r: WatchRecord): TaskWatchInfo {
  const ws = workspaceFor(r.projectPath)
  const names = ws?.path ? cardNamesOf(ws, ws.isAssistantHome(r.projectPath) ? null : basename(r.projectPath)) : null
  return namedBy(names, () =>
    r.lanes
      ? { cards: r.cond.cards, changes: r.cond.changes, lanes: r.lanes.ids === 'all' ? ['all'] : [...r.lanes.ids], ...(r.agents ? { agents: r.agents.agents.map((a) => a.name) } : {}), label: laneWatchLabel(r.lanes, r.cond.cards, r.agents?.agents), since: r.since, limitAt: r.limitAt }
      : r.agents
        ? { cards: [], changes: [], agents: r.agents.agents.map((a) => a.name), label: agentWatchLabel(r.agents), since: r.since, limitAt: r.limitAt }
        : { cards: r.cond.cards, changes: r.cond.changes, ...(r.cond.column ? { column: r.cond.column } : {}), label: watchLabel(r.cond), since: r.since, limitAt: r.limitAt }
  )
}
/** A watcher's project's id (#508), as the workspace last read the ids (it reads them when it opens). */
const projectIdOf = (ws: WorkspaceService, projectPath: string): { projectId?: string } => {
  const id = ws.isAssistantHome(projectPath) ? undefined : ws.projectIdsNow().byPath.get(resolve(projectPath).toLowerCase())
  return id ? { projectId: id } : {}
}
/** An agent watch (#416), not a lane watch with agents beside its lanes (HI-1987). */
const agentOnly = (r: WatchRecord): boolean => !!r.agents && !r.lanes
const recordOf = (store: Store, projectPath: string, agentId: string): WatchRecord | undefined => store.list.find((x) => same(x.projectPath, projectPath) && x.agentId === agentId)
const agentKey = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/**
 * The agent's name on the board, as its own changes are recorded ("Coder (alpha)", the Assistant's "Assistant"): what it
 * did itself after a wake isn't news to its next watch. Null when it can't be known (then that watch starts from now).
 */
async function boardName(ws: WorkspaceService, projectPath: string, agentId: string): Promise<string | null> {
  if (ws.isAssistantHome(projectPath)) return 'Assistant'
  const def = await ws
    .projectConfig(projectPath)
    .then((cfg) => projectAgents(cfg).find((x) => x.id === agentId))
    .catch(() => undefined)
  return def ? `${def.name} (${basename(resolve(projectPath))})` : null
}
const storeFor = (projectPath: string): Store | undefined => {
  const ws = workspaceFor(projectPath)
  const store = ws?.path ? stores.get(ws.path.toLowerCase()) : undefined
  return store && store.ws === ws && alive(store) ? store : undefined
}

/**
 * An agent's watch as kept, or `unknown` while its workspace's watches aren't loaded yet (they load now): never taken for
 * none (HI-1731: whether a carried lease's end may stop it). A watch whose wake its CLI never took counts as one.
 */
export function watchKnown(projectPath: string, agentId: string): TaskWatchInfo | null | 'unknown' {
  const ws = workspaceFor(projectPath)
  if (!ws?.path) return 'unknown'
  const store = storeFor(projectPath)
  if (!store) {
    inBackground('loading watches', load(ws))
    return 'unknown'
  }
  const r = recordOf(store, projectPath, agentId)
  return r ? infoOf(r) : null
}

/** An agent's watch as its state shows it (null: none, or its workspace's watches aren't loaded yet; they load now). */
export function watchFor(projectPath: string, agentId: string): TaskWatchInfo | null {
  const ws = workspaceFor(projectPath)
  if (!ws?.path) return null
  const store = storeFor(projectPath)
  if (!store) {
    inBackground('loading watches', load(ws))
    return null
  }
  const r = recordOf(store, projectPath, agentId)
  // Its wake handed over and its CLI never took the line (#430, marked): nothing will wake it now, so it isn't shown as
  // waiting on cards (#649: the watch itself lasts until that wake is received) and its loop is checked as one with no
  // watch (#376: its cards show as stalled).
  if (r?.fired?.delivery && sessions.lineUntaken(projectPath, agentId)) return null
  return r ? infoOf(r) : null
}

/** An agent's watch as watchFor tells it, once its workspace's watches are loaded (#1639: before arming one for it). */
export async function loadedWatchFor(ws: WorkspaceService, projectPath: string, agentId: string): Promise<TaskWatchInfo | null> {
  await load(ws)
  return watchFor(projectPath, agentId)
}

/**
 * A card as the scope may see it (null: gone, archived cards included as they are, or outside the scope), read from the
 * store's own workspace: a read that a close or switch overlapped is refused.
 */
async function cardIn(store: Store, n: number, scope: string | null, cards?: CardReads): Promise<TaskCard | null> {
  checkAlive(store)
  let read = cards?.get(n)
  if (!read) {
    testHooks.cardRead?.(n)
    read = getTask(n, store.ws).catch(() => null)
    cards?.set(n, read)
  }
  const card = await read
  checkAlive(store)
  return card && inScope(card, scope) ? card : null
}

/**
 * The cards one check of the watches has read (#321): each card once, whatever the number of watches on it (a builder,
 * its reviewer and the Assistant on the same card; 400 watches of 20 cards each read 8,000 files a check before).
 */
type CardReads = Map<number, Promise<TaskCard | null>>

/**
 * Ends a watch's wake (the watch was cancelled or replaced): the line being made isn't handed over, and the delivery it
 * was handed over as is cancelled (its typing stops before Enter; a line its CLI hasn't taken is cleared, #647).
 */
const stopDelivery = (store: Store, rec: WatchRecord | undefined, why = 'its watch was replaced'): void => {
  const d = rec && store.delivering.get(rec.id)
  if (d) d.cancelled = true
  if (rec?.fired?.delivery) inBackground('cancelling a wake', cancelFromSource(rec.projectPath, 'watch', wakeRef(rec), `cancelled: ${why}`))
}

export type WatchResult = ({ watching: TaskWatchInfo } | { already: CardChange }) & { lanesLeft?: string[] }

/**
 * The running lanes a card or agent watch drops by replacing an agent's lane watch (HI-1987: an Assistant swapped its
 * lane watch for an agent watch on one build, and nothing told it of the other lane meanwhile), by their builders'
 * names: those the lane watch it replaces follows, or, after a lane wake not followed by another lane watch, those that
 * wake's watch followed. None (no lanes running, or no lane watch dropped): nothing is said.
 */
async function lanesLeft(store: Store, old: WatchRecord | undefined, projectPath: string, agentId: string): Promise<string[]> {
  const ids = old ? old.lanes?.ids : store.wokeLanes.get(agentKey(projectPath, agentId))?.ids
  if (!ids) return []
  const scope = scopeFor(store.ws, projectPath)
  const running = (await listLanes(store.ws).catch(() => [])).filter((l) => (l.state === 'active' || l.state === 'paused') && (scope === null || same(l.project, scope)) && (ids === 'all' || ids.includes(l.id)))
  return running.map((l) => l.builder.name)
}

/**
 * Starts (or replaces) an agent's watch. A column condition a card already meets is met at once (a move into it too,
 * #434, unless it asks for a `fresh` one): the agent's earlier watch ends and the card's state is the answer. The agent sees the board as its token does (a project agent: its
 * project's cards; the Assistant: all), and a card outside that is unknown.
 * The board is checked again once the watch is in place, so a change while it was being set up isn't missed.
 * `start` (#1639): a card as an intent of the agent's left it, and when: the watch starts from there, so what others
 * changed since that intent (a verdict given before Hive armed the watch) counts.
 */
export async function registerWatch(ws: WorkspaceService, projectPath: string, agentId: string, cond: WatchCondition, limitMinutes = WATCH_DEFAULT_LIMIT_MINUTES, start?: { card: TaskCard; at: string }): Promise<WatchResult> {
  const store = await load(ws)
  // A wake whose line its CLI has taken is received first, so this watch starts from what it told (#649).
  await followAgent(projectPath, agentId)
  if (!hostedIn(ws, store.path, projectPath)) throw new Error(`Not a project of this workspace: ${projectPath}`)
  const scope = scopeFor(ws, projectPath)
  const self = await boardName(ws, projectPath, agentId)
  const result = await locked(store, async (): Promise<WatchResult> => {
    await assertNotPlacing(ws, projectPath, agentId, scope)
    // Moves into a column are looked for in the history from here: before the cards are read, so none falls between.
    const since = start?.at ?? new Date().toISOString()
    // After a wake, a card that wake told about starts from what it told (#224): what others changed since counts, so a
    // change that landed between the wake and this watch (a second card's verdict a second later) fires it at once.
    const told = self ? store.woke.get(agentKey(projectPath, agentId)) : undefined
    // HI-2302: else, or when the agent acted on the card since that wake, from just after its own last change to the card
    // in this launch (ownCut): a builder's answer to a reviewer's question, between the question and the reviewer's watch.
    const launched = sessions.liveFor(projectPath, agentId)?.startedAt
    let cutAny = false
    const marks: Record<string, CardMark> = {}
    const seen: Record<string, Seen> = {}
    const now: Record<string, CardMark> = {}
    // A project agent's part in each card (#420): what ends its watch on one when the card is reassigned. A
    // blocked card stays (#481): it is paused, not gone, and the watch carries on until it moves again.
    const on: Record<string, OnCard> = {}
    let already: CardChange | null = null
    for (const n of cond.cards) {
      const card = await cardIn(store, n, scope)
      await testHooks.afterRead?.()
      if (!card) throw unknownTask(n)
      const role = scope === null ? null : card.agent === agentId ? 'agent' : card.review?.agent === agentId ? 'reviewer' : cond.column === 'review' ? 'awaiting' : null
      if (role) on[n] = { role }
      const mark = markOf(card)
      const intent = start?.card.number === n
      const base = intent ? start.card : card
      const wakeTold = told?.get(String(n))
      const cut = !intent && self && launched ? ownCut(card, self, launched, wakeTold) : null
      const was = cut ?? wakeTold
      // HI-2153: a card in Done or archived never changes again: its state is the answer, never a watch. Unless the watch
      // starts from before it got there (a wake that told it elsewhere, an intent's card): that move fires it.
      if (alreadyThere(mark, cond) || (cardOver(mark) && cardOver(was ? was.mark : markOf(base)))) {
        already = cardChange(n, card, mark.archived ? 'gone' : ['column'])
        break
      }
      if (cut) cutAny = true
      marks[n] = cut ? cut.mark : was ? carriedOver(card, was, self!) : markOf(base)
      seen[n] = was ? was.seen : seenOf(base)
      now[n] = mark
    }
    const from = { seen, ...((told && cond.cards.some((n) => told.has(String(n)))) || cutAny ? { self: self! } : {}) }
    const old = recordOf(store, projectPath, agentId)
    const before = store.list
    // The limit holds for what Hive writes as for what it reads: replacing an agent's watch is always allowed.
    if (!already && !old && store.list.length >= MAX_WATCHES) throw new Error(`This workspace already has ${MAX_WATCHES} card watches, the most Hive keeps: wait for some to end`)
    const minutes = Math.min(WATCH_MAX_LIMIT_MINUTES, Math.max(1, Math.round(limitMinutes)))
    // The Assistant's: the user's replies to its cards' agents from what its last wake told (#418).
    const replySeq = scope === null ? (store.wokeReplies.get(agentKey(projectPath, agentId)) ?? latestReplySeq()) : undefined
    const rec: WatchRecord | null = already ? null : { id: randomBytes(6).toString('hex'), projectPath, ...projectIdOf(ws, projectPath), agentId, scope, cond, marks, current: now, since, ...from, ...(replySeq !== undefined ? { replySeq } : {}), ...(Object.keys(on).length ? { on } : {}), ...(self && scope !== null ? { watcherName: self } : {}), limitMinutes: minutes, limitAt: new Date(Date.now() + minutes * 60_000).toISOString() }
    const next = [...store.list.filter((x) => x !== old), ...(rec ? [rec] : [])]
    // Every watch must be able to fire, be typed and end within the file's limit: make room, else refuse.
    if (rec && budget(store, next) > MAX_FILE_BYTES && !((await setAside(store)) && budget(store, next) <= MAX_FILE_BYTES))
      throw new Error('Too many card watches to keep in this workspace: wait for some to end')
    store.list = next
    if (old || rec) {
      try {
        await save(store)
      } catch (e) {
        store.list = before
        throw new Error(`Could not save the watch: ${(e as Error).message}`, { cause: e })
      }
    }
    stopDelivery(store, old)
    const left = await lanesLeft(store, old, projectPath, agentId)
    const lanes = left.length ? { lanesLeft: left } : {}
    if (already) return { already, ...lanes }
    log.info(`${userText(agentId)} watches ${cond.cards.map((c) => `#${c}`).join(', ')}`)
    return { watching: infoOf(rec!), ...lanes }
  })
  sessions.watchChanged(projectPath, agentId)
  // It waits on cards: an agent in a card loop, checked when its turn ends with no watch (#376).
  noteLoopWatch(projectPath, agentId, cond.cards)
  if ('watching' in result) {
    inBackground('checking watches', evaluate(ws))
    for (const fn of watchStarted) inBackground('telling of a watch begun', Promise.resolve().then(() => fn(ws, projectPath, agentId, cond)))
  }
  return result
}

/**
 * HI-2197: why a project agent may take no new watch now, or null: Hive is giving it a card in a slot (its own start, the
 * placement not made yet), which a watch would hold off. Asked under the watches' lock, as each registration writes its
 * watch: a start that makes the placement due then ends the agent's watch under the same lock (endWatchOf), so either
 * the watch is refused or that start ends it. Set by servers.ts (watchGuards.ts); none until then.
 */
let placing: (ws: WorkspaceService, projectPath: string, agentId: string) => Promise<string | null> = async () => null
export function onWatchPlacing(fn: (ws: WorkspaceService, projectPath: string, agentId: string) => Promise<string | null>): void {
  placing = fn
}
const assertNotPlacing = async (ws: WorkspaceService, projectPath: string, agentId: string, scope: string | null): Promise<void> => {
  if (scope === null) return
  const why = await placing(ws, projectPath, agentId)
  if (why) throw new HiveError({ shown: why, english: why }, { kind: 'conflict' })
}

/** Told when an agent's card watch begins (HI-1721: loopWakes tells a builder of its returned card it waits on). */
const watchStarted = new Set<(ws: WorkspaceService, projectPath: string, agentId: string, cond: WatchCondition) => Promise<void> | void>()
export function onWatchStarted(fn: (ws: WorkspaceService, projectPath: string, agentId: string, cond: WatchCondition) => Promise<void> | void): () => void {
  watchStarted.add(fn)
  return () => watchStarted.delete(fn)
}

/** Ends an agent's watch (the agent itself, or the user's Cancel), also one being typed. Whether it had one. */
export async function cancelWatch(ws: WorkspaceService, projectPath: string, agentId: string): Promise<boolean> {
  const store = await load(ws)
  const had = await locked(store, async () => {
    const rec = recordOf(store, projectPath, agentId)
    if (!rec) return false
    const before = store.list
    store.list = store.list.filter((x) => x !== rec)
    try {
      await save(store)
    } catch (e) {
      store.list = before
      throw new Error(`Could not cancel the watch: ${(e as Error).message}`, { cause: e })
    }
    stopDelivery(store, rec, 'its watch was cancelled')
    return true
  })
  if (had) sessions.watchChanged(projectPath, agentId)
  return had
}

/**
 * HI-2197: an agent starting a new conversation (not resumed, not its own handover) ends its watch from before. That
 * watch was the old conversation's, which the new one never set (HB3's lane end: its watch on its old card fired, its
 * wake couldn't be typed, and it showed as waiting on cards, so its new card was never given to it). Awaited before
 * the launch: the record as it is now removed and saved, and its wake, by that record's own id, cancelled before this
 * returns (a new conversation's watch has another id, so nothing here can end it). A failure throws: no launch with
 * the old watch in place.
 */
export const endConversationWatch = async (projectPath: string, agentId: string): Promise<void> => void (await endWatchOf(projectPath, agentId, 'its conversation ended'))

/** An agent's watch ended as endConversationWatch ends one, `why` its log's and its wake's: the label of the watch ended, or null. */
export async function endWatchOf(projectPath: string, agentId: string, why: string): Promise<string | null> {
  const ws = workspaceFor(projectPath)
  if (!ws?.path) return null
  const store = await load(ws)
  const rec = await locked(store, async () => {
    const r = recordOf(store, projectPath, agentId)
    if (!r) return null
    const before = store.list
    store.list = store.list.filter((x) => x !== r)
    try {
      await save(store)
    } catch (e) {
      store.list = before
      throw new Error(`Could not end the watch (${why}): ${(e as Error).message}`, { cause: e })
    }
    const d = store.delivering.get(r.id)
    if (d) d.cancelled = true
    return r
  })
  if (!rec) return null
  log.info(`${userText(agentId)}'s watch ended: ${why}`)
  sessions.watchChanged(projectPath, agentId)
  if (rec.fired?.delivery) {
    try {
      await testHooks.beforeWakeCancel?.()
      await cancelFromSource(rec.projectPath, 'watch', wakeRef(rec), `cancelled: ${why}`)
    } catch (e) {
      // Its wake not cancelled: the watch is put back (unless the agent has another by now), so the next try ends both.
      await locked(store, async () => {
        if (recordOf(store, projectPath, agentId)) return
        store.list = [...store.list, rec]
        await saveQuietly(store)
      })
      sessions.watchChanged(projectPath, agentId)
      throw new Error(`Could not cancel the wake of the watch (${why}): ${(e as Error).message}`, { cause: e })
    }
  }
  return infoOf(rec).label
}

/**
 * What agents did lately (#416), by agentKey: each change to a status that isn't working (its turn ended, it waits for
 * the user, it stopped), with the agent as it was then, numbered in order (`seq`: from the clock, so a number saved in a
 * watch still compares after a restart). The last few for each agent, whether or not anyone watches it yet: a wake's
 * next watch counts what happened in between. In memory: what happened while Hive was closed is read from the agents
 * as they are (agentHits).
 */
interface Happening {
  seq: number
  now: AgentNow
}
const happenings = new Map<string, Happening[]>()
const lastStatus = new Map<string, string>()
let lastSeq = 0
const HAPPENINGS_KEPT = 8
const AGENTS_KEPT = 2000
const latestSeq = (key: string): number => happenings.get(key)?.at(-1)?.seq ?? 0
/** The latest of an agent's events after `from` that a watch counts (one into background only with ignoreBackground). */
const happenedSince = (key: string, from: number, ignoreBackground: boolean): Happening | undefined =>
  happenings.get(key)?.findLast((h) => h.seq > from && !agentBusy(h.now, ignoreBackground))

/** Statuses during a turn: idle after one of these is the turn's end. */
/**
 * Each agent's turn (#416): its launch, and whether a turn is under way in it, one that has been seen working (or on
 * its background tasks) since its last turn ended. Only such a turn's end is a finished turn: a launch becoming ready,
 * also after a startup question (folder trust) or a refused sign-in, ran none.
 */
const turns = new Map<string, { runId: string; inTurn: boolean }>()

/**
 * Records an agent's status change (every session-status). An event is waiting for the user, a stop or an error, or
 * idle at the end of a turn under way (finished, interrupted, or into background tasks).
 */
export function noteAgentStatus(st: LiveSessionState): void {
  const key = agentKey(st.projectPath, st.agentId)
  const was = turns.get(key)
  const turn = { runId: st.runId || '', inTurn: !!was && was.runId === (st.runId || '') && was.inTurn }
  if (st.status === 'working' || st.status === 'background') turn.inTurn = true
  // Starting, stopped or refused a sign-in: no turn under way (one carried on after signing in works again first).
  if (st.status === 'starting' || st.status === 'stopped' || st.status === 'signin') turn.inTurn = false
  const ended = (st.status === 'ready' || st.status === 'finished' || st.status === 'watching') && turn.inTurn
  if (ended) turn.inTurn = false
  turns.delete(key)
  turns.set(key, turn)
  if (turns.size > AGENTS_KEPT) turns.delete(turns.keys().next().value!)
  const prev = lastStatus.get(key)
  if (prev === st.status) return
  lastStatus.delete(key)
  lastStatus.set(key, st.status)
  if (lastStatus.size > AGENTS_KEPT) lastStatus.delete(lastStatus.keys().next().value!)
  if (st.status === 'working' || st.status === 'starting') return
  const needsUser = st.status === 'waiting' || st.status === 'signin' || st.status === 'stopped' || st.status === 'error'
  if (!needsUser && !ended && !(st.status === 'background' && turn.inTurn)) return
  const reply = st.status === 'stopped' ? null : (sessions.agentNow(st.projectPath, st.agentId)?.reply ?? null)
  const now: AgentNow = { status: st.status, runId: st.runId || null, prompts: 0, pending: false, statusMessage: st.statusMessage ?? null, backgroundTasks: st.backgroundTasks ?? 0, reply, watch: st.status === 'watching' ? (st.watch?.label ?? null) : null }
  lastSeq = Math.max(lastSeq + 1, Date.now())
  const list = happenings.get(key) ?? []
  happenings.delete(key)
  happenings.set(key, [...list, { seq: lastSeq, now }].slice(-HAPPENINGS_KEPT))
  if (happenings.size > AGENTS_KEPT) happenings.delete(happenings.keys().next().value!)
  // It started waiting for the user (#726): a lane watch tells it once, while it still waits.
  if (st.status === 'waiting') {
    waitStarts.push({ seq: lastSeq, projectPath: st.projectPath, agentId: st.agentId, name: st.agentName ?? st.agentId, runId: st.runId || '', what: st.statusMessage ?? null })
    if (waitStarts.length > WAITS_KEPT) waitStarts.shift()
  }
}

/**
 * Agents starting to wait for the user (#726: a permission prompt or a question in its pane, the status Hive shows as
 * waiting), numbered on the events' clock, the latest few: a lane watch tells each once, while it still waits. In
 * memory: a wait under way when Hive started is the user's to see (its pane says so).
 */
interface WaitStart {
  seq: number
  projectPath: string
  agentId: string
  name: string
  runId: string
  what: string | null
}
const waitStarts: WaitStart[] = []
const WAITS_KEPT = 200
const latestWaitSeq = (): number => waitStarts.at(-1)?.seq ?? 0

/**
 * Prompts the user sent agents from their panes (#418: sessions.userReplied), the latest few, numbered on the events'
 * clock: told only to the Assistant's watches, on that agent (an agent watch) or on a card it has or reviews (a card
 * watch). Kept only with Settings → Assistant → Tell the Assistant when I reply to an agent on; the first line only.
 */
interface Reply {
  seq: number
  projectPath: string
  agentId: string
  agentName: string
  text: string
  /**
   * Who tells it (#1099 round 2): claimed by whichever picks it first, at once (no await between looking and claiming).
   * `watch`: a watch of the Assistant's picked it for its line (watches may tell it again, as before #1099: a line not
   * given is made again); `sending`: being given to the Assistant on its own (no watch takes it; not made, it is free
   * again); `direct`: given on its own (no watch tells it again).
   */
  owner?: 'watch' | 'sending' | 'direct'
}
const replies: Reply[] = []
const REPLIES_KEPT = 200
const latestReplySeq = (): number => replies.at(-1)?.seq ?? 0

/** Records a reply of the user's to an agent, and has the watches of its workspace check it now. */
export function noteUserReply(projectPath: string, agentId: string, agentName: string, text: string): void {
  if (config.settings.assistant?.tellReplies === false) return
  const first = replyFirstLine(text)
  if (!first) return
  lastSeq = Math.max(lastSeq + 1, Date.now())
  const reply: Reply = { seq: lastSeq, projectPath, agentId, agentName, text: first }
  replies.push(reply)
  if (replies.length > REPLIES_KEPT) replies.shift()
  const store = storeFor(projectPath)
  if (!store) return
  // The watches are checked first: one of the Assistant's that tells it picks it (claims it, replyTo) and tells it with
  // the rest of its line. What none picked (none covers it, or the one that does had made its line already) is given
  // to the Assistant on its own, if it follows the agent (#1099 round 3: decided by who picked it, never by a guess).
  const agentsChecked = evaluateAgents(store)
  const cardsChecked = evaluate(store.ws)
  inBackground('checking agent watches', agentsChecked)
  inBackground('checking watches', cardsChecked)
  inBackground("telling the Assistant the user's reply", Promise.allSettled([agentsChecked, cardsChecked]).then(() => tellReplyNow(store, reply)))
}

/** The Assistant's watches in a workspace's store (its own, never an agent's: replies are told only to it, #418). */
const assistantWatches = (store: Store): WatchRecord[] => store.list.filter((r) => r.scope === null && r.agentId === ASSISTANT_AGENT_ID && store.ws.isAssistantHome(r.projectPath))

/** Whether `card` is the reply's agent's (it has it or reviews it, in its project). */
const cardOfAgent = (store: Store, card: TaskCard | null, reply: Reply): boolean =>
  !!card?.project && same(resolve(join(store.path, card.project)), resolve(reply.projectPath)) && (card.agent === reply.agentId || card.review?.agent === reply.agentId)

/**
 * Whether the Assistant follows the reply's agent (#1099), though no watch of its own tells the reply now: a watch it
 * has, or its last wakes told it about, covers that agent (an agent watch on it, a card watch on a card it has or
 * reviews, a lane watch on a lane it builds or reviews). Between two watches (its wake being read, an agent watch
 * answered at once because the agent was idle) or with a lane watch, which tells no replies, it would otherwise hear of
 * the reply only with its next watch on that agent, often turns later.
 */
async function assistantFollows(store: Store, reply: Reply): Promise<boolean> {
  const home = store.ws.assistantHome
  if (!home) return false
  const watcher = agentKey(home, ASSISTANT_AGENT_ID)
  const key = agentKey(reply.projectPath, reply.agentId)
  const recs = assistantWatches(store)
  if (store.wokeAgents.get(watcher)?.has(key) || recs.some((r) => r.agents?.agents.some((a) => agentKey(a.projectPath, a.agentId) === key))) return true
  const cards = new Set([...recs.filter((r) => !r.agents && !r.lanes).flatMap((r) => r.cond.cards), ...[...(store.woke.get(watcher)?.keys() ?? [])].map(Number)])
  for (const n of cards) if (cardOfAgent(store, await cardIn(store, n, null).catch(() => null), reply)) return true
  // The lanes it watches (all running ones, or those its watch names) and those its last lane wake told it about.
  const all = recs.some((r) => r.lanes?.ids === 'all')
  const ids = new Set([...recs.flatMap((r) => (r.lanes && r.lanes.ids !== 'all' ? r.lanes.ids : [])), ...(store.wokeLanes.get(watcher)?.marks.keys() ?? [])])
  if (!all && !ids.size) return false
  const project = basename(resolve(reply.projectPath))
  return (await listLanes(store.ws).catch(() => [])).some((l) => (all || ids.has(l.id)) && (l.state === 'active' || l.state === 'paused') && same(l.project, project) && (l.builder.id === reply.agentId || l.reviewer?.id === reply.agentId))
}

/**
 * Tells the Assistant a reply of the user's on its own (#1099), when it follows the agent but no watch of its own tells
 * it now: a wake of its own, within seconds, like any other. Told so, no watch tells it again; not made (a failed save,
 * a refusal), it is left to the Assistant's watches again. Its watches carry on. Made under the replies' generation and
 * this run of Hive (its `meta`): the 'reply' source gives it only while replies may still be told.
 */
async function tellReplyNow(store: Store, reply: Reply): Promise<void> {
  const generation = replyGeneration
  if (!tellReplies() || reply.owner || !alive(store) || !(await assistantFollows(store, reply))) return
  const home = store.ws.assistantHome
  // Claimed only if nothing has picked it meanwhile (a watch that started and fired during the lookup tells it).
  if (!home || reply.owner || !tellReplies() || generation !== replyGeneration) return
  reply.owner = 'sending'
  const line = `[Hive] ${replyPart(reply.agentName, `(${basename(resolve(reply.projectPath))})`, reply.text, REPLY_CHARS, userName())}.` // i18n-ignore: agent-facing: what the Assistant reads (#1099)
  let id: string
  try {
    id = (await createDelivery(home, { agentId: ASSISTANT_AGENT_ID, kind: 'card-event', from: HIVE, body: line, source: 'reply', ref: `reply:${reply.seq}`, meta: { generation, run: RUN } })).id
  } catch (e) {
    // Not handed over: the Assistant's watches tell it as before (its next one on that agent).
    if (reply.owner === 'sending') delete reply.owner
    log.warn(`Couldn't hand the user's reply to ${userText(reply.agentName)} to the Assistant`, e)
    inBackground('checking agent watches', evaluateAgents(store))
    inBackground('checking watches', evaluate(store.ws))
    return
  }
  reply.owner = 'direct'
  log.info(`The user's reply to ${userText(reply.agentName)} was handed to the Assistant as ${id}`)
  await offerNow(home, ASSISTANT_AGENT_ID)
}

/** This run of Hive (#1099): a reply's delivery made in it is checked against the replies' generation, which is this run's. */
const RUN = randomBytes(6).toString('hex')
/**
 * Whether a reply told on its own may still be given (#1099): replies still told, and, when it was made in this run, not
 * revoked since (the generation it was made under). One made before a restart is checked against the setting alone:
 * turning it off then cancelled it (revokeReplies), and it is cancelled now if the setting is off.
 */
const replyHolds = (r: DeliveryRecord): boolean => tellReplies() && (r.meta?.run !== RUN || r.meta?.generation === replyGeneration)

/** The replies' part in their deliveries (#1099): offered and handed out (hive_inbox) only while replyHolds. */
registerSource('reply', {
  refresh: async (r) => (replyHolds(r) ? null : { cancel: "the user's replies are no longer told" }),
  holds: (r) => replyHolds(r)
})
/** The latest reply of the user's to an agent after `from`, for the Assistant's watch (null scope) only. */
const tellReplies = (): boolean => config.settings.assistant?.tellReplies !== false
/**
 * Raised (at once, before anything waits) each time replies stop being told: a wake made with a reply under an earlier
 * value is never typed, even if the setting is on again by then (#418).
 */
let replyGeneration = 0
/** Replies stop being told: the kept ones go, and every wake made with one is void. */
const dropReplies = (): void => {
  replies.length = 0
  replyGeneration++
}
const replyTo = (scope: string | null, projectPath: string, agentId: string, from: number): Reply | undefined => {
  if (scope !== null) return undefined
  // Turned off: what was kept goes, and nothing is told (also what a wake waiting to be typed would have said).
  if (!tellReplies()) {
    if (replies.length) dropReplies()
    return undefined
  }
  // One given on its own (or being given) isn't a watch's to tell; one a watch picks is claimed for the watches.
  const r = replies.findLast((x) => x.seq > from && x.owner !== 'sending' && x.owner !== 'direct' && x.agentId === agentId && same(resolve(x.projectPath), resolve(projectPath)))
  if (r) r.owner = 'watch'
  return r
}

/**
 * Settings → Assistant → Tell the Assistant when I reply to an agent turned off (#418): the replies kept go, and a wake
 * waiting to be typed that tells one is made again without it (or, with nothing else to tell, isn't typed: the watch
 * waits on). Turned on again, none comes back.
 */
export async function revokeReplies(): Promise<void> {
  dropReplies()
  // Replies told on their own (#1099) and not read yet are withdrawn too: every one in each open workspace's Assistant's
  // deliveries, kept in memory or not (the 'reply' source refuses those made before this, also while one is being made).
  for (const store of [...stores.values()]) if (alive(store) && store.ws.assistantHome) inBackground('withdrawing replies', cancelFromSource(store.ws.assistantHome, 'reply', null, "cancelled: the user's replies are no longer told"))
  // A wake handed over as a delivery that tells one is cancelled now (its typing stops; a line its CLI hasn't taken is
  // cleared): its watch fires again, made without the reply (#649).
  for (const [id, h] of handed) if (h.told.replies) inBackground('withdrawing a reply', cancelFromSource(h.rec.projectPath, 'watch', wakeRef(h.rec), "cancelled: the user's replies are no longer told").then(() => handed.delete(id)))
  for (const store of [...stores.values()]) {
    // One handed over as a delivery is cancelled by its source's check (watchSource.refresh), and fires again.
    if (!alive(store) || !store.list.some((r) => r.fired?.replies && !r.fired.sending && !r.fired.delivery)) continue
    await locked(store, async () => {
      for (const rec of store.list) if (rec.fired?.replies && !rec.fired.sending && !rec.fired.delivery) delete rec.fired
      await saveQuietly(store)
    }).catch((e) => log.warn('withdrawing replies from watches', e))
    inBackground('checking watches', evaluate(store.ws))
    inBackground('checking agent watches', evaluateAgents(store))
  }
}

/** A watched agent as it is now (#416): not running reads as stopped. A watching agent's own watch is said too. */
function agentNowOf(a: Pick<WatchedAgent, 'projectPath' | 'agentId' | 'gone'>): AgentNow {
  // One whose project is gone (#508) is stopped: whatever runs at its folder now is another project's.
  const now = a.gone ? null : sessions.agentNow(a.projectPath, a.agentId)
  if (!now) return { status: 'stopped', runId: null, prompts: 0, pending: false }
  return { ...now, watch: now.status === 'watching' ? (sessions.watchFor(a.projectPath, a.agentId)?.label ?? null) : null }
}

type AgentHit = { agent: WatchedAgent; event: AgentEvent | null; now: AgentNow; again: boolean; seq: number; reply?: string }

/**
 * What the agents of an agent watch did since it began: each one's latest event after what the watcher knew (its mark's
 * seq), as the agent was then, and whether it is working again since; failing that (nothing recorded: Hive restarted,
 * or a typed prompt never taken), the agent as it is now, if it isn't working.
 */
function agentHits(rec: WatchRecord): AgentHit[] {
  const out: AgentHit[] = []
  const ib = rec.agents?.ignoreBackground ?? false
  for (const agent of rec.agents?.agents ?? []) {
    const key = agentKey(agent.projectPath, agent.agentId)
    const mark = rec.agentMarks?.[key]
    const cur = agentNowOf(agent)
    // What the user sent it from its pane since (#418), for the Assistant; a lane watch tells no replies (#1099 tells
    // them on their own, its agents being followed: HI-1987).
    // One whose project is gone (#508): nothing recorded at its folder is its own any more, only that it stopped.
    const r = agent.gone || rec.lanes ? null : replyTo(rec.scope, agent.projectPath, agent.agentId, mark?.seq ?? 0)
    const said = r ? { reply: r.text } : {}
    const h = agent.gone ? null : happenedSince(key, mark?.seq ?? 0, ib)
    if (h) {
      out.push({ agent, event: agentEvent(h.now, undefined, ib)!, now: shownTo(rec.scope, agent, h.now), again: agentBusy(cur, ib), seq: Math.max(h.seq, r?.seq ?? 0), ...said })
      continue
    }
    const event = agentEvent(cur, mark, ib)
    if (event || r) out.push({ agent, event, now: shownTo(rec.scope, agent, cur), again: false, seq: Math.max(mark?.seq ?? 0, latestSeq(key), r?.seq ?? 0), ...said })
  }
  return out
}

/** A lane watch's agent hits as its line tells them (HI-1987): those with an event (a lane watch tells no replies). */
const laneAgentsOf = (hits: readonly AgentHit[]): LaneAgentHit[] => hits.flatMap((h) => (h.event ? [{ agent: h.agent, event: h.event, text: (max: number) => agentPart(h.agent, h.event!, h.now, max, false, h.again) }] : []))

/** Records what a wake (or an answer at once) told an agent about the agents it watched: its next watch starts there. */
function noteToldAgents(store: Store, watcher: string, told: Map<string, number>): void {
  const known = new Map(store.wokeAgents.get(watcher))
  for (const [k, seq] of told) {
    known.delete(k)
    known.set(k, seq)
  }
  while (known.size > WOKE_CARDS) known.delete(known.keys().next().value!)
  store.wokeAgents.delete(watcher)
  store.wokeAgents.set(watcher, known)
  if (store.wokeAgents.size > MAX_WATCHES) store.wokeAgents.delete(store.wokeAgents.keys().next().value!)
}

export type AgentWatchResult = ({ watching: TaskWatchInfo } | { already: string[] }) & { replaced?: string; dropped?: string[]; lanesLeft?: string[] }

/**
 * Starts (or replaces) an agent's agent watch (#416): Hive types one line into it when one of `cond`'s agents finishes
 * its turn, waits for the user or stops. Agents not working now are the answer at once (as for a card already in the
 * column): the agent's earlier watch ends and each one's state is told. Only agents it may watch (mayWatch); not itself.
 */
export async function registerAgentWatch(ws: WorkspaceService, projectPath: string, agentId: string, cond: AgentWatchCondition, limitMinutes = WATCH_DEFAULT_LIMIT_MINUTES): Promise<AgentWatchResult> {
  // A wake whose line its CLI has taken is received first, so this watch starts from what it told (#649).
  await followAgent(projectPath, agentId)
  const store = await load(ws)
  if (!hostedIn(ws, store.path, projectPath)) throw new Error(`Not a project of this workspace: ${projectPath}`)
  for (const a of cond.agents) {
    if (!mayWatch(ws, store.path, projectPath, a.projectPath)) throw new Error(`Not a project of this workspace: ${a.project}`)
    if (same(a.projectPath, projectPath) && a.agentId === agentId) throw new Error("You can't watch yourself: nothing would wake you")
  }
  const result = await locked(store, async (): Promise<AgentWatchResult> => {
    await assertNotPlacing(ws, projectPath, agentId, scopeFor(ws, projectPath))
    const since = new Date().toISOString()
    const agentMarks: Record<string, AgentMark> = {}
    const already: string[] = []
    const scope = scopeFor(ws, projectPath)
    // After a wake, each agent starts from what that wake told (an event since is news, and fires the watch at once,
    // below); otherwise from its latest event now.
    const watcher = agentKey(projectPath, agentId)
    const told = store.wokeAgents.get(watcher)
    const toldNow = new Map<string, number>()
    for (const a of cond.agents) {
      const key = agentKey(a.projectPath, a.agentId)
      const now = shownTo(scope, a, agentNowOf(a))
      if (!agentBusy(now, cond.ignoreBackground)) {
        already.push(agentPart(a, agentEvent(now, undefined, cond.ignoreBackground)!, now, 200, true))
        toldNow.set(key, latestSeq(key))
      }
      agentMarks[key] = agentMarkOf(now, told?.get(key) ?? latestSeq(key))
    }
    const old = recordOf(store, projectPath, agentId)
    const before = store.list
    if (!already.length && !old && store.list.length >= MAX_WATCHES) throw new Error(`This workspace already has ${MAX_WATCHES} watches, the most Hive keeps: wait for some to end`)
    const minutes = Math.min(WATCH_MAX_LIMIT_MINUTES, Math.max(1, Math.round(limitMinutes)))
    const followed = { ...cond, agents: cond.agents.map((a) => ({ ...a, ...projectIdOf(ws, a.projectPath) })) }
    const rec: WatchRecord | null = already.length ? null : { id: randomBytes(6).toString('hex'), projectPath, ...projectIdOf(ws, projectPath), agentId, scope, cond: NO_CARDS, agents: followed, agentMarks, marks: {}, current: {}, since, limitMinutes: minutes, limitAt: new Date(Date.now() + minutes * 60_000).toISOString() }
    const next = [...store.list.filter((x) => x !== old), ...(rec ? [rec] : [])]
    if (rec && budget(store, next) > MAX_FILE_BYTES && !((await setAside(store)) && budget(store, next) <= MAX_FILE_BYTES))
      throw new Error('Too many watches to keep in this workspace: wait for some to end')
    store.list = next
    if (old || rec) {
      try {
        await save(store)
      } catch (e) {
        store.list = before
        throw new Error(`Could not save the watch: ${(e as Error).message}`, { cause: e })
      }
    }
    stopDelivery(store, old)
    // A card watch it had ends: said, so it isn't thought to be still running. So do the agents an agent watch it had
    // followed and this call doesn't follow now (#1346 item 6: a second watch dropped the first's agents unsaid): those
    // the new watch leaves out, or, answered at once with no watch made, every one (HR2's #1530 rounds 1 and 2).
    const followedNow = rec ? cond.agents : []
    const left = await lanesLeft(store, old, projectPath, agentId)
    const dropped = old && agentOnly(old) ? old.agents!.agents.filter((o) => !followedNow.some((a) => same(a.projectPath, o.projectPath) && a.agentId === o.agentId)).map((o) => `${o.name} (${o.project})`) : []
    const ended = { ...(old && !agentOnly(old) ? { replaced: infoOf(old).label } : {}), ...(dropped.length ? { dropped } : {}), ...(left.length ? { lanesLeft: left } : {}) }
    if (!rec) {
      noteToldAgents(store, watcher, toldNow)
      return { already, ...ended }
    }
    log.info(`${userText(agentId)} watches ${cond.agents.map((a) => userText(a.name)).join(', ')}`)
    return { watching: infoOf(rec), ...ended }
  })
  sessions.watchChanged(projectPath, agentId)
  // Checked again once in place: an agent that finished while it was being set up isn't missed.
  if ('watching' in result) inBackground('checking agent watches', evaluateAgents(store))
  return result
}

/** Checks a workspace's agent watches against its agents now: those with an agent no longer working fire, then are delivered. */
async function evaluateAgents(store: Store): Promise<void> {
  if (!store.list.some((r) => r.agents && !r.fired)) return
  await locked(store, async () => {
    // Watched agents in their projects' folders now (#508).
    let changed = followProjects(store, store.ws.projectIdsNow())
    for (const rec of store.list) {
      if (!rec.agents || rec.fired) continue
      const hits = agentHits(rec)
      if (!hits.length) continue
      // A lane watch's agents (HI-1987) fire it as a lane watch: its line, made again as it is handed over, tells its lanes too.
      const line = rec.lanes ? laneWakeLine([], { agents: laneAgentsOf(hits), watching: rec.cond.cards.length > 0, following: true }) : agentWakeLine(hits, userName())
      rec.fired = { line: lineFor(store, rec, () => line), at: new Date().toISOString(), cards: [], agents: hits.map((h) => agentKey(h.agent.projectPath, h.agent.agentId)), ...(rec.lanes ? { lanes: true as const } : {}), ...(hits.some((h) => h.reply !== undefined) ? { replies: true as const } : {}) }
      changed = true
    }
    if (changed) await saveQuietly(store)
  })
  for (const rec of store.list.filter((r) => r.agents && r.fired)) await deliver(store, rec)
}

/** A usage watch's hits now (HI-2195): each account whose limit reached its share, in its current period. */
const usageHitsOf = (rec: WatchRecord): string[] => usageHits(rec.usage ?? [], (a) => config.get().connectionPlanUsage?.[a]?.limits, Date.now())

/** Checks a workspace's usage watches (HI-2195): one whose account reached its share fires, then is delivered. */
async function evaluateUsage(store: Store): Promise<void> {
  if (!store.list.some((r) => r.usage && !r.fired)) return
  await locked(store, async () => {
    let changed = false
    for (const rec of store.list) {
      if (!rec.usage || rec.fired) continue
      const hits = usageHitsOf(rec)
      if (!hits.length) continue
      rec.fired = { line: lineFor(store, rec, () => usageWakeLine(hits)), at: new Date().toISOString(), cards: [] }
      changed = true
    }
    if (changed) await saveQuietly(store)
  })
  for (const rec of store.list.filter((r) => r.usage && r.fired)) await deliver(store, rec)
}

export type UsageWatchResult = ({ watching: TaskWatchInfo } | { already: string[] }) & { replaced?: string; lanesLeft?: string[] }

/**
 * Starts (or replaces) an agent's usage watch alone (HI-2195): Hive types one line into it once one of the accounts'
 * limits reaches its share. One there already is the answer at once (its earlier watch ends, as for a card already in
 * its column).
 */
export async function registerUsageWatch(ws: WorkspaceService, projectPath: string, agentId: string, usage: UsageWatch[], limitMinutes = WATCH_DEFAULT_LIMIT_MINUTES): Promise<UsageWatchResult> {
  await followAgent(projectPath, agentId)
  const store = await load(ws)
  if (!hostedIn(ws, store.path, projectPath)) throw new Error(`Not a project of this workspace: ${projectPath}`)
  const result = await locked(store, async (): Promise<UsageWatchResult> => {
    await assertNotPlacing(ws, projectPath, agentId, scopeFor(ws, projectPath))
    const already = usageHits(usage, (a) => config.get().connectionPlanUsage?.[a]?.limits, Date.now())
    const old = recordOf(store, projectPath, agentId)
    const before = store.list
    if (!already.length && !old && store.list.length >= MAX_WATCHES) throw new Error(`This workspace already has ${MAX_WATCHES} watches, the most Hive keeps: wait for some to end`)
    const minutes = Math.min(WATCH_MAX_LIMIT_MINUTES, Math.max(1, Math.round(limitMinutes)))
    const rec: WatchRecord | null = already.length ? null : { id: randomBytes(6).toString('hex'), projectPath, ...projectIdOf(ws, projectPath), agentId, scope: scopeFor(ws, projectPath), cond: NO_CARDS, usage, marks: {}, current: {}, since: new Date().toISOString(), limitMinutes: minutes, limitAt: new Date(Date.now() + minutes * 60_000).toISOString() }
    store.list = [...store.list.filter((x) => x !== old), ...(rec ? [rec] : [])]
    if (old || rec) {
      try {
        await save(store)
      } catch (e) {
        store.list = before
        throw new Error(`Could not save the watch: ${(e as Error).message}`, { cause: e })
      }
    }
    stopDelivery(store, old)
    const left = await lanesLeft(store, old, projectPath, agentId)
    const ended = { ...(old ? { replaced: infoOf(old).label } : {}), ...(left.length ? { lanesLeft: left } : {}) }
    if (!rec) return { already, ...ended }
    log.info(`${userText(agentId)} watches usage: ${userText(usageWatchLabel(usage))}`)
    return { watching: infoOf(rec), ...ended }
  })
  sessions.watchChanged(projectPath, agentId)
  if ('watching' in result) inBackground('checking usage watches', evaluateUsage(store))
  return result
}

/**
 * Adds a usage watch beside the card or lane watch just started (HI-2195): the same watch, fired by either. One whose
 * account is already there fires it at once.
 */
export async function addUsageToWatch(ws: WorkspaceService, projectPath: string, agentId: string, usage: UsageWatch[]): Promise<TaskWatchInfo | null> {
  const store = await load(ws)
  const info = await locked(store, async () => {
    const rec = recordOf(store, projectPath, agentId)
    if (!rec || rec.fired) return null
    rec.usage = usage
    await save(store)
    return infoOf(rec)
  })
  if (info) {
    sessions.watchChanged(projectPath, agentId)
    inBackground('checking usage watches', evaluateUsage(store))
  }
  return info
}

/** How often the tick checks lane watches (a stall that comes with time, a card waiting in Review, #521). */
const LANE_TICK_MS = 30_000

/** Checks a workspace's lane watches soon: once for a burst of status changes. */
function laneCheckSoon(store: Store): void {
  if (store.laneCheck || !store.list.some((r) => r.lanes && !r.fired)) return
  store.laneCheck = true
  inBackgroundAfter(1000, 'checking lane watches', () => {
    store.laneCheck = undefined
    return evaluateLanes(store)
  })
}

/**
 * The lanes a lane watch follows, as they are now (#531): those it names, or every running lane, and any it already
 * follows (so a lane's end is told); in the watcher's view (a project agent: its project's lanes; the Assistant: all).
 * Each lane's cards as the board has them now, with their verdicts, blocks and stalls.
 */
async function lanesNow(store: Store, rec: Pick<WatchRecord, 'scope' | 'lanes' | 'laneMarks'> & { since?: string; laneSince?: string }, board: LaneBoard = laneBoard(store.ws)): Promise<LaneNow[]> {
  return lanesIn(store.ws, rec, board)
}

/**
 * A workspace's lanes as a lane watch sees them (lanesNow), for a follower of its own: Hive's lane notices (#1266, which
 * follow every running lane, and those whose end they haven't told, by their marks).
 */
export function lanesNowIn(ws: WorkspaceService, laneMarks: Record<string, LaneMark>, since: string): Promise<LaneNow[]> {
  return lanesIn(ws, { scope: null, lanes: { ids: 'all', events: [] }, laneMarks, since }, laneBoard(ws))
}

async function lanesIn(ws: WorkspaceService, rec: Pick<WatchRecord, 'scope' | 'lanes' | 'laneMarks'> & { since?: string; laneSince?: string }, board: LaneBoard): Promise<LaneNow[]> {
  const cond = rec.lanes!
  const inView = (await listLanes(ws, { all: true })).filter((l) => rec.scope === null || same(l.project, rec.scope))
  // Every running lane, and a lane it follows until its end has been told (round 1 finding: one that ended between a
  // wake and the watch after it, which starts from what the wake told).
  const told = (id: string): boolean => !!rec.laneMarks?.[id] && rec.laneMarks[id].state !== 'ended' && rec.laneMarks[id].state !== 'abandoned'
  // A lane started since the watch's view began, and not yet followed: also when it has already ended or been abandoned
  // (round 2 finding), so its end is told.
  const from = Date.parse(rec.laneSince ?? rec.since ?? '')
  const isNew = (l: { id: string; startedAt: string }): boolean => !rec.laneMarks?.[l.id] && Date.parse(l.startedAt) > from
  const running = (l: { state: string }): boolean => l.state === 'active' || l.state === 'paused'
  const chosen = cond.ids === 'all' ? inView.filter((l) => running(l) || told(l.id) || isNew(l)) : inView.filter((l) => (cond.ids as string[]).includes(l.id))
  // #1645: a card a running lane holds is that lane's alone: an ended or abandoned lane that once listed it (one started
  // on it by mistake, abandoned as its own lane began) tells nothing of it, so its events name the lane holding it now.
  const held = new Set(inView.filter(running).flatMap((l) => l.cards.map((c) => c.number)))
  const cardsOf = (l: (typeof inView)[number]) => (running(l) ? l.cards : l.cards.filter((c) => !held.has(c.number)))
  const byNumber = await board.byNumber(chosen.flatMap((l) => cardsOf(l).map((c) => c.number)))
  // Their open requests for the user (HI-1991): a question an agent asked on one wakes the watch.
  const asks = board.asks(chosen.filter(running).flatMap((l) => l.cards.map((c) => c.number)))
  const agents = new Map()
  const out: LaneNow[] = []
  for (const l of chosen) {
    const marks: LaneMark['cards'] = {}
    const cards: LaneNow['cards'] = []
    const changed: { mark: LaneMark['cards'][string]; updatedAt?: string }[] = []
    // A running lane's deadlock (#1410): its reviewer waiting for one of its cards while its builder waits on another.
    const order = l.state === 'active' || l.state === 'paused' ? laneOrderView(l, (n) => byNumber.get(n)) : null
    for (const lc of cardsOf(l)) {
      const found = byNumber.get(lc.number)
      // A card moved to another project is gone from the lane.
      const card = found && same(found.project, l.project) ? found : null
      const stalled = card && !card.archived ? await cardStallIn(ws, card, agents, order) : null
      // An ended lane's cards are another lane's or nobody's: no requests of theirs are told for it.
      const asked = running(l) && asks ? newestAsk(asks.get(lc.number)) : undefined
      marks[lc.number] = laneCardMark(card, stalled, asked)
      changed.push({ mark: marks[lc.number], updatedAt: card?.updatedAt })
      const v = card ? verdictsOf(card) : null
      cards.push({ number: lc.number, blocked: card?.blocked ?? null, stalled, failedBy: v?.failed?.by ?? null, passedBy: v?.passed?.by ?? null, ...(asked ? { asked } : {}) })
    }
    const label = `${l.builder.name}${l.reviewer ? ` / ${l.reviewer.name}` : ''}${l.name ? ` (${l.name})` : ''}`
    // #869: a merge due with its builder idle and no merge slot claimed (a step it stopped on for the user) is a stall.
    const builder = ws.path ? (sessions.liveFor(join(ws.path, l.project), l.builder.id) ?? null) : null
    // A builder queued to resume after a restart (HI-1707) isn't a stall meanwhile.
    const resuming = !builder && !!ws.path && isResuming(join(ws.path, l.project), l.builder.id)
    const mergeStall = resuming ? null : mergeStallReason({ state: l.state, builder: l.builder.name, cards: changed }, builder)
    out.push({ id: l.id, label, mark: { state: l.state, mergeDue: mergeDue(Object.values(marks)), ...(mergeStall ? { ms: true } : {}), cards: marks }, cards, mergeStall, status: l.status, mergeCommit: l.mergeCommit })
  }
  return out
}

/**
 * The cards a round of lane watches reads (#1107): each lane's cards by number (an archived one too, so a card archived
 * mid-lane is still found), each read at most once, and the board's live cards only once an agent waits for the user
 * (waitsSince); never the whole board, whose archived cards are most of it (945 of 1058, 13 MB, on a busy one).
 */
interface LaneBoard {
  byNumber(numbers: readonly number[]): Promise<Map<number, TaskCard>>
  live(): Promise<TaskCard[]>
  /** These cards' open requests for the user (HI-1991), by card: none for a card with none; null: they couldn't be read. */
  asks(numbers: readonly number[]): Map<number, ForYouItem[]> | null
}

/** A card's newest open request for the user (HI-1991), as a lane watch tells it; null for none. */
function newestAsk(items: readonly ForYouItem[] | undefined): LaneAsked | null {
  const i = items?.reduce<ForYouItem | null>((a, b) => (!a || b.since > a.since ? b : a), null)
  return i ? { since: i.since, by: i.asker, text: i.text } : null
}

function laneBoard(ws: WorkspaceService): LaneBoard {
  const reads = new Map<number, Promise<TaskCard | null>>()
  let live: Promise<TaskCard[]> | null = null
  const asked = new Map<number, ForYouItem[]>()
  const askRead = new Set<number>()
  return {
    asks(numbers) {
      const missing = [...new Set(numbers)].filter((n) => !askRead.has(n))
      if (missing.length) {
        // Kept by their facts' head, as For you keeps them (cardWork.ts): a round reads only what changed.
        try {
          for (const [n, items] of forYouOfCards(ws, missing)) asked.set(n, items)
        } catch (e) {
          // Not known this round: their marks have no `q`, so nothing is told from a guess.
          log.warn("reading lane cards' requests for the user", e)
          return null
        }
        for (const n of missing) askRead.add(n)
      }
      return new Map(numbers.flatMap((n): [number, ForYouItem[]][] => (asked.has(n) ? [[n, asked.get(n)!]] : [])))
    },
    async byNumber(numbers) {
      const missing = [...new Set(numbers)].filter((n) => !reads.has(n))
      if (missing.length) {
        // Each kept until it changes (HI-1780: lane notices and lane watches look again on every board change).
        const batch = cardsNow(ws, missing).then((cards) => new Map([...cards].flatMap(([n, c]): [number, TaskCard][] => (c ? [[n, c]] : []))))
        for (const n of missing) {
          const one = batch.then((m) => m.get(n) ?? null)
          // A read that failed fails each round that awaits it, never as unhandled for the cards no round got to.
          one.catch(() => undefined)
          reads.set(n, one)
        }
      }
      const out = new Map<number, TaskCard>()
      for (const n of numbers) {
        const c = await reads.get(n)!
        if (c) out.set(n, c)
      }
      return out
    },
    // Their heads (HI-1690): whose card an agent waits on is all a wait's line needs.
    live: () => (live ??= liveCardHeads(ws))
  }
}

/** What a lane watch has to tell now (#531, #726), and where its marks would move to. */
interface LaneRound {
  hits: LaneHit[]
  next: Record<string, LaneMark>
  /** The cards beside its lanes that changed (#726), and each of them as read for the line. */
  cards: CardChange[]
  told: Record<string, Baseline>
  /**
   * The cards beside its lanes in Done or archived (HI-2153): they leave the watch with no notice of their own (the
   * Assistant's call: the lanes' own events tell the watcher), so `cards` never tells them; `done`, those to note in
   * their history.
   */
  drop: number[]
  done: Released[]
  /** Agents that started waiting for the user since its mark and still wait (#726), and the latest wait known now. */
  waits: WaitHit[]
  waitSeq: number
}

/**
 * A lane watch's events since its marks (#531), and where its marks would move to: each lane it follows now (a lane
 * started after an "all" watch began, from an empty start, so what it already has is told; a card new to a lane likewise,
 * from when the watch began). Lanes no longer followed (an ended one told) leave an "all" watch's marks. With them, the
 * cards beside its lanes as a card watch checks its cards, and the agents waiting for the user (#726).
 */
async function laneRound(store: Store, rec: WatchRecord, board: LaneBoard = laneBoard(store.ws)): Promise<LaneRound> {
  const cond = rec.lanes!
  const nows = await lanesNow(store, rec, board)
  const listed = await listLanes(store.ws, { all: true })
  const started = new Map(listed.map((l) => [l.id, l.startedAt]))
  const hits: LaneHit[] = []
  const next: Record<string, LaneMark> = cond.ids === 'all' ? {} : { ...rec.laneMarks }
  for (const n of nows) {
    const from = rec.laneSince ?? rec.since
    const was = rec.laneMarks?.[n.id] ?? (Date.parse(started.get(n.id) ?? '') > Date.parse(from) ? newLaneBase(n, from) : undefined)
    // Its hits' texts name cards as the watch's line does (HI-1777): by key, whatever workspace is the context meanwhile.
    const h = withCardNames(store.ws, () => laneHits(was, n, cond.events, from), rec.scope)
    if (h) hits.push(h)
    next[n.id] = keepAsked(was, n.mark, from)
  }
  const c = rec.cond.cards.length ? await check(store, rec) : null
  const drop = c ? [...c.released.map((x) => x.number), ...c.hits.filter((h) => h.changes === 'gone' && h.archived).map((h) => h.number)] : []
  // Named lanes: the waits of their projects' agents; "all": of every project in the watcher's view.
  const named = cond.ids === 'all' ? null : new Set(listed.filter((l) => (cond.ids as string[]).includes(l.id)).map((l) => l.project.toLowerCase()))
  const waitSeq = latestWaitSeq()
  return { hits, next, cards: c ? c.hits.filter((h) => !drop.includes(h.number)) : [], told: c ? Object.fromEntries(Object.entries(c.told).filter(([n]) => !drop.includes(Number(n)))) : {}, drop, done: c?.released ?? [], waits: await waitsSince(store, rec, board, named), waitSeq }
}

/**
 * Takes a round's cards in Done or archived out of a lane watch (HI-2153), under the store's lock, its lanes still
 * watched: nothing tells them (no `released`), and the Done ones are noted in their history. Whether any left.
 */
function dropLaneCards(rec: WatchRecord, r: Pick<LaneRound, 'drop' | 'done'>, ended: { n: number; what: StoredText }[]): boolean {
  const drop = r.drop.filter((n) => rec.cond.cards.includes(n))
  if (!drop.length) return false
  for (const x of r.done) if (drop.includes(x.number)) ended.push({ n: x.number, what: storedText(HISTORY.watchEnded, { watcher: rec.watcherName ?? rec.agentId, ...releasedWhy(x) }) })
  rec.cond = { ...rec.cond, cards: rec.cond.cards.filter((n) => !drop.includes(n)) }
  if (rec.fired) rec.fired = { ...rec.fired, cards: rec.fired.cards.filter((n) => !drop.includes(n)) }
  for (const n of drop) {
    delete rec.marks[n]
    delete rec.seen?.[n]
    delete rec.current?.[n]
    delete rec.on?.[n]
  }
  return true
}

/**
 * The agents a lane watch tells as waiting for the user (#726): each that started waiting after its mark (`waitSeq`), an
 * agent of a project it follows (the watcher's view, or the named lanes' projects), not itself, and still waiting in the
 * same launch (a wait the user answered at once has nothing left to tell); its latest wait, with its card (the one it
 * works on in Doing, else the one it reviews) and what it asks.
 */
async function waitsSince(store: Store, rec: WatchRecord, board: LaneBoard, named: Set<string> | null): Promise<WaitHit[]> {
  if (!rec.lanes?.events.includes('waiting')) return []
  const from = rec.waitSeq ?? 0
  const latest = new Map<string, WaitStart>()
  for (const w of waitStarts) {
    if (w.seq <= from || (same(w.projectPath, rec.projectPath) && w.agentId === rec.agentId) || !mayWatch(store.ws, store.path, rec.projectPath, w.projectPath)) continue
    const project = basename(resolve(w.projectPath)).toLowerCase()
    if ((rec.scope !== null && project !== rec.scope.toLowerCase()) || (named && !named.has(project))) continue
    latest.set(agentKey(w.projectPath, w.agentId), w)
  }
  const out: WaitHit[] = []
  for (const w of latest.values()) {
    const live = sessions.liveFor(w.projectPath, w.agentId)
    if (live?.status !== 'waiting' || (live.runId || '') !== w.runId) continue
    const project = basename(resolve(w.projectPath))
    const mine = (c: TaskCard): boolean => !!c.project && same(c.project, project)
    // The live cards, read only once an agent waits (#1107).
    const cards = await board.live()
    const card = cards.find((c) => mine(c) && c.column === 'doing' && c.agent === w.agentId) ?? cards.find((c) => mine(c) && c.column === 'review' && c.review?.agent === w.agentId)
    out.push({ name: w.name, project, card: card?.number ?? null, what: w.what })
  }
  return out
}

/** A lane watch's line from its round (#726: its cards and the waiting agents with its lanes). */
const laneLine = (store: Store, rec: WatchRecord, r: LaneRound, agents: readonly AgentHit[] = []): string =>
  lineFor(store, rec, () => laneWakeLine(r.hits, { cards: r.cards, waits: r.waits, watching: rec.cond.cards.length > 0, agents: laneAgentsOf(agents), following: !!rec.agents }))
const roundTells = (r: LaneRound): boolean => r.hits.length > 0 || r.cards.length > 0 || r.waits.length > 0

/**
 * Checks a workspace's lane watches (#531): a lane with an event that counts fires its watch, telling every lane's events
 * in one line, and the watch's marks become what that line told. Otherwise each lane's mark moves on to now, so a card
 * that gets blocked again after an unblock counts, and a lane or card new to the watch starts from now.
 */
async function evaluateLanes(store: Store): Promise<void> {
  if (!alive(store) || !store.list.some((r) => r.lanes && (!r.fired || r.cond.cards.length))) return
  // One reading for every watch of this round: each card read at most once.
  const board = laneBoard(store.ws)
  // Cards beside the lanes in Done or archived taken out of a watch (HI-2153): the Done ones' history, and the watches
  // left with fewer cards (what their agents show changes).
  const ended: { n: number; what: StoredText }[] = []
  const narrowed: WatchRecord[] = []
  await locked(store, async () => {
    let changed = false
    for (const rec of store.list) {
      if (!rec.lanes) continue
      try {
        // Fired, not handed over yet: its line is made again as it is delivered, but its cards in Done leave now.
        if (rec.fired) {
          if (!rec.cond.cards.length || rec.fired.sending || rec.fired.delivery) continue
          const c = await check(store, rec)
          if (dropLaneCards(rec, { drop: [...c.released.map((x) => x.number), ...c.hits.filter((h) => h.changes === 'gone' && h.archived).map((h) => h.number)], done: c.released }, ended)) {
            narrowed.push(rec)
            changed = true
          }
          continue
        }
        const r = await laneRound(store, rec, board)
        if (dropLaneCards(rec, r, ended)) {
          narrowed.push(rec)
          changed = true
        }
        if (roundTells(r)) {
          // Fired: its marks stay where they were, so the line typed later is worked out again from there with
          // whatever else happened meanwhile (one batch, round 1 finding), and becomes what the wake told.
          rec.fired = { line: laneLine(store, rec, r), at: new Date().toISOString(), cards: r.cards.filter((h) => h.changes !== 'gone').map((h) => h.number), lanes: true }
          changed = true
        } else if (JSON.stringify(r.next) !== JSON.stringify(rec.laneMarks) || r.waitSeq !== rec.waitSeq) {
          rec.laneMarks = r.next
          rec.waitSeq = r.waitSeq
          changed = true
        }
      } catch (e) {
        if (!alive(store)) throw e
        log.warn(`checking the lane watch of ${userText(rec.agentId)}`, e)
      }
    }
    if (changed) await saveQuietly(store)
  })
  for (const x of ended) inBackground(`noting on #${x.n} that a watch ended`, noteOnCard(x.n, x.what, store.ws))
  for (const rec of narrowed) sessions.watchChanged(rec.projectPath, rec.agentId)
  for (const rec of store.list.filter((r) => r.lanes && r.fired)) await deliver(store, rec)
}

export type LaneWatchResult = { watching: TaskWatchInfo; replaced?: string; cards?: LaneWatchCards; agents?: LaneWatchAgents }

/**
 * Starts (or replaces) an agent's watch on lanes (#531): the lanes it names (each in its view, else an error), or every
 * running lane. After a wake, each lane starts from what that wake told, so an event since fires it at once. It is the
 * agent's one watch: a card or agent watch it had ends (said in the reply).
 *
 * With cards beside its lanes (#726, `extra.cards`, each in its view, else an error): followed as a card watch follows
 * its cards (from what a wake told about them, else from now), `changes` counting, and a card becoming blocked. Left
 * out, the last lane watch's cards are kept (the one it replaces, or the one whose wake was read), less those since done
 * or gone; [] drops them. The reply says which (`cards`).
 */
export async function registerLaneWatch(ws: WorkspaceService, projectPath: string, agentId: string, asked: LaneWatchCondition, limitMinutes = WATCH_DEFAULT_LIMIT_MINUTES, extra: { cards?: number[]; changes?: WatchChange[]; agents?: AgentWatchCondition } = {}): Promise<LaneWatchResult> {
  // A question for the user always counts (HI-1991), whoever made the condition.
  const cond: LaneWatchCondition = { ...asked, events: [...new Set([...asked.events, ...LANE_ALWAYS_EVENTS])] }
  // Waits for the user are new from here (#726 round 1 finding): taken before anything waits, so one that begins while
  // the lanes and cards are read is told, not taken as its baseline.
  const waitsFrom = latestWaitSeq()
  await followAgent(projectPath, agentId)
  const store = await load(ws)
  if (!hostedIn(ws, store.path, projectPath)) throw new Error(`Not a project of this workspace: ${projectPath}`)
  const scope = scopeFor(ws, projectPath)
  const self = await boardName(ws, projectPath, agentId)
  for (const a of extra.agents?.agents ?? []) {
    if (!mayWatch(ws, store.path, projectPath, a.projectPath)) throw new Error(`Not a project of this workspace: ${a.project}`)
    if (same(a.projectPath, projectPath) && a.agentId === agentId) throw new Error("You can't watch yourself: nothing would wake you")
  }
  if (cond.ids !== 'all') {
    const known = (await listLanes(ws, { all: true })).filter((l) => scope === null || same(l.project, scope))
    const unknown = cond.ids.filter((id) => !known.some((l) => l.id === id))
    if (unknown.length) throw new Error(`No such lane${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (hive_lane list gives the lanes and their ids)`)
  }
  const result = await locked(store, async (): Promise<LaneWatchResult> => {
    await assertNotPlacing(ws, projectPath, agentId, scopeFor(ws, projectPath))
    const since = new Date().toISOString()
    const told = store.wokeLanes.get(agentKey(projectPath, agentId))
    // After a wake, what is new is measured from when its line was made: a lane started or a card added since then is
    // told (round 2 finding); otherwise from now.
    const laneSince = told?.at ?? since
    const toldMarks = told ? Object.fromEntries(told.marks) : undefined
    const nows = await lanesNow(store, { scope, lanes: cond, laneSince, ...(toldMarks ? { laneMarks: toldMarks } : {}) })
    const allLanes = await listLanes(ws, { all: true })
    const started = new Map(allLanes.map((l) => [l.id, l.startedAt]))
    // The watched lanes' own cards (#1531, #1346 item 3): listed as cards too, each wakes it on every move.
    const watchedIds = new Set(nows.map((n) => n.id))
    const laneCards = new Set(allLanes.filter((l) => watchedIds.has(l.id)).flatMap((l) => l.cards.map((c) => c.number)))
    const laneMarks: Record<string, LaneMark> = {}
    for (const n of nows) {
      const t = told?.marks.get(n.id)
      if (t) laneMarks[n.id] = t
      // Started since that wake: left unmarked, so the first check measures it from an empty start.
      else if (!(told && Date.parse(started.get(n.id) ?? '') > Date.parse(laneSince))) laneMarks[n.id] = keepAsked(null, n.mark, laneSince)
    }
    const old = recordOf(store, projectPath, agentId)
    // The cards beside its lanes (#726): those named, else the last lane watch's (the one it replaces, or the one whose
    // wake was read), less those done or gone since (a card named must be one it may see).
    const last = old?.lanes ? (old.cond.cards.length ? { cards: old.cond.cards, changes: old.cond.changes } : undefined) : told?.cards
    const keep = extra.cards === undefined
    const changes = extra.changes ?? (keep ? last?.changes : undefined) ?? LANE_CARD_CHANGES
    const toldCards = self ? store.woke.get(agentKey(projectPath, agentId)) : undefined
    const marks: Record<string, CardMark> = {}
    const seen: Record<string, Seen> = {}
    const current: Record<string, CardMark> = {}
    const cards: number[] = []
    const dropped: number[] = []
    // Whose own changes since aren't news (its board name), for cards measured from a wake.
    let bySelf = false
    for (const n of extra.cards ?? last?.cards ?? []) {
      const card = await cardIn(store, n, scope)
      // HI-2153: one named that is in Done or archived too: nothing more comes of it (the reply says it left).
      if ((keep && !card) || (card && (card.archived || card.column === 'done'))) {
        dropped.push(n)
        continue
      }
      if (!card) throw unknownTask(n)
      current[n] = markOf(card)
      cards.push(n)
      // Kept from the lane watch it replaces: from where that one was (a change that fired it, not handed over yet, is
      // still news). Else after a wake that told it, from what it told (#224): a change since is news.
      const had = old?.lanes && old.cond.cards.includes(n) && old.seen?.[n] ? { mark: old.marks[n], seen: old.seen[n] } : undefined
      const was = had ? undefined : toldCards?.get(String(n))
      marks[n] = had ? had.mark : was ? carriedOver(card, was, self!) : markOf(card)
      seen[n] = had ? had.seen : was ? was.seen : seenOf(card)
      if (had ? !!old!.self : !!was) bySelf = true
    }
    // Its agents beside the lanes (HI-1987): those named, else the last lane watch's (the one it replaces, or those its
    // wake didn't tell); [] drops them. One not working now isn't followed: its state is the reply, as for an agent watch.
    const watcher = agentKey(projectPath, agentId)
    const keepAgents = extra.agents === undefined
    const wanted = extra.agents ?? (old?.lanes ? old.agents : told?.agents)
    const toldSeqs = store.wokeAgents.get(watcher)
    const agentMarks: Record<string, AgentMark> = {}
    const followed: WatchedAgent[] = []
    const already: string[] = []
    const toldNow = new Map<string, number>()
    for (const a of wanted?.agents ?? []) {
      const key = agentKey(a.projectPath, a.agentId)
      const now = shownTo(scope, a, agentNowOf(a))
      if (!agentBusy(now, wanted!.ignoreBackground)) {
        already.push(agentPart(a, agentEvent(now, undefined, wanted!.ignoreBackground)!, now, 200, true))
        toldNow.set(key, latestSeq(key))
        continue
      }
      followed.push({ ...a, ...projectIdOf(ws, a.projectPath) })
      // Kept from the lane watch it replaces: from where that one was (an event not handed over yet is still news); else
      // from what a wake told, else now.
      agentMarks[key] = (old?.lanes ? old.agentMarks?.[key] : undefined) ?? agentMarkOf(now, toldSeqs?.get(key) ?? latestSeq(key))
    }
    const agentsOut: LaneWatchAgents | undefined = wanted?.agents.length ? { now: followed.map((a) => `${a.name} (${a.project})`), ...(keepAgents ? { kept: true as const } : {}), ...(already.length ? { already } : {}) } : undefined
    const cardCond: WatchCondition = cards.length ? { cards, changes, blocked: true } : NO_CARDS
    const from = cards.length ? { seen, ...(bySelf && self ? { self } : {}) } : {}
    const had = last?.cards ?? []
    const inLanes = cards.filter((n) => laneCards.has(n))
    const cardsOut: LaneWatchCards | undefined =
      cards.length || dropped.length || (!keep && had.length)
        ? { now: cards, ...(keep ? { kept: true as const } : {}), ...(!keep && had.length && (had.length !== cards.length || had.some((n) => !cards.includes(n))) ? { replaced: [...had] } : {}), ...(dropped.length ? { dropped } : {}), ...(inLanes.length ? { inLanes } : {}) }
        : undefined
    // The waits for the user it starts from (#726): the watch it replaces, else what its last wake told, else when this
    // call began.
    const waitSeq = (old?.lanes ? old.waitSeq : undefined) ?? told?.waitSeq ?? waitsFrom
    const before = store.list
    if (!old && store.list.length >= MAX_WATCHES) throw new Error(`This workspace already has ${MAX_WATCHES} watches, the most Hive keeps: wait for some to end`)
    const minutes = Math.min(WATCH_MAX_LIMIT_MINUTES, Math.max(1, Math.round(limitMinutes)))
    const rec: WatchRecord = { id: randomBytes(6).toString('hex'), projectPath, ...projectIdOf(ws, projectPath), agentId, scope, cond: cardCond, lanes: cond, laneMarks, laneSince, waitSeq, ...(followed.length ? { agents: { ignoreBackground: wanted!.ignoreBackground, agents: followed }, agentMarks } : {}), marks, current, since, ...from, limitMinutes: minutes, limitAt: new Date(Date.now() + minutes * 60_000).toISOString() }
    const next = [...store.list.filter((x) => x !== old), rec]
    if (budget(store, next) > MAX_FILE_BYTES && !((await setAside(store)) && budget(store, next) <= MAX_FILE_BYTES)) throw new Error('Too many watches to keep in this workspace: wait for some to end')
    store.list = next
    try {
      await save(store)
    } catch (e) {
      store.list = before
      throw new Error(`Could not save the watch: ${(e as Error).message}`, { cause: e })
    }
    stopDelivery(store, old)
    if (toldNow.size) noteToldAgents(store, watcher, toldNow)
    log.info(`${userText(agentId)} watches ${cond.ids === 'all' ? 'all running lanes' : cond.ids.join(', ')}${cards.length ? ` and ${cards.map((n) => `#${n}`).join(', ')}` : ''}${followed.length ? ` and ${followed.map((a) => userText(a.name)).join(', ')}` : ''}`)
    return { watching: infoOf(rec), ...(old ? { replaced: infoOf(old).label } : {}), ...(cardsOut ? { cards: cardsOut } : {}), ...(agentsOut ? { agents: agentsOut } : {}) }
  })
  sessions.watchChanged(projectPath, agentId)
  // Checked once in place: an event since a wake, or while it was being set up, isn't missed.
  inBackground('checking lane watches', evaluateLanes(store))
  if (result.agents?.now.length) inBackground('checking agent watches', evaluateAgents(store))
  return result
}

/** Typing a wake stopped: it tells a reply of the user's, and they turned telling replies off meanwhile (#418). */
class RepliesRevoked extends Error {
  constructor() {
    super('The user turned off telling the Assistant their replies.')
  }
}

/** A fired watch that has nothing left to tell (#418: a reply no longer told) goes back to waiting, as if it hadn't fired. */
async function withdraw(store: Store, rec: WatchRecord, current: () => boolean): Promise<void> {
  await locked(store, async () => {
    if (!current() || !rec.fired || rec.fired.sending || rec.fired.delivery) return
    delete rec.fired
    await saveQuietly(store)
  }).catch(() => undefined)
}

/** Fired watches waiting out the settle before theirs is handed over. */
const settling = new Set<string>()

/**
 * Whether an agent's own card watch tells it of this change to card n (#405: Hive's loop wakes leave it to the watch),
 * the card being in `column` now: a watch on the card that counts a move into Review (`review`); one that counts a
 * verdict, or a move into the card's column now (`verdict`: a passing one that moved it to Passed; a failed one leaves
 * it in Review, which a watch for Passed doesn't count); one that counts a move into the card's column now (`moved`: a
 * move into Passed or Done with no verdict, #1266); one that counts a reviewer's request or a decision (`request`,
 * `decision`: hearsHandoffs, #1272); or one that has fired and tells the card. Its watches not loaded yet: false.
 */
export function watchCovers(projectPath: string, agentId: string, n: number, kind: 'review' | 'verdict' | 'moved' | 'request' | 'decision', column: TaskColumn): boolean {
  const store = storeFor(projectPath)
  const rec = store && recordOf(store, projectPath, agentId)
  // A lane watch's cards beside its lanes (#726) are its cards like any other.
  if (!rec || agentOnly(rec) || !rec.cond.cards.includes(n)) return false
  // A request or a decision only by a watch that counts them, fired or not: another's line doesn't tell them.
  if (kind === 'request' || kind === 'decision') return hearsHandoffs(rec.cond) && (!rec.fired || rec.fired.cards.includes(n))
  if (rec.fired) return rec.fired.cards.includes(n)
  const into = (c: TaskColumn): boolean => rec.cond.changes.includes('column') && (!rec.cond.column || rec.cond.column === c)
  if (kind === 'verdict') return rec.cond.changes.includes('verdict') || (column !== 'review' && into(column))
  if (kind === 'moved') return into(column)
  return into('review')
}

/**
 * What an agent's own card watch leaves untold of a card's decisions (#1272), so a decision line tells only that: none
 * (`all` told), for a watch that counts them (watchCovers); else, once a line of a watch that counted them was typed (its
 * handoff boundary, #578's, also once the watch has ended), how many decisions were recorded (by others than `self`) or
 * changed after it, by their history entries: by place, never by time, so one made in the same millisecond is still
 * new. Null: no watch has told it any.
 */
export function watchToldDecisions(projectPath: string, agentId: string, card: TaskCard, self: string): 'all' | { untold: number } | null {
  if (watchCovers(projectPath, agentId, card.number, 'decision', card.column)) return 'all'
  const t = toldOf(projectPath, agentId, card.number)?.hand
  if (!t) return null
  const added = (h: TaskCard['history'][number]): boolean => isDecisionEntry(h.what) && !h.what.startsWith('Removed') && !(h.what.startsWith('Recorded') && h.by === self)
  return { untold: card.history.filter((h) => added(h) && !entryWithin(card.history, h, t.h)).length }
}

/**
 * What a watch's typed line last told each agent about each card (#578): the last history entry the line had read of the
 * card (its `seen` boundary), by agent key and card. A loop wake for a change whose history entry is within that boundary
 * is one the watch already told, so it is dropped, even once the watch itself has ended; a change after it (the next
 * round's arrival, at any time, the same millisecond too) is news. In memory, as loop wakes are, and kept a day (a loop
 * wake waits at most that long). `hand`: the same, from the last line of a watch that counted reviewers' requests and
 * decisions (hearsHandoffs, #1272), the boundary of what it told of those: a later watch that doesn't count them leaves
 * it as it was, so what was told stays told.
 */
interface ToldBoundary {
  h: string | null
  at: number
  hand?: { h: string | null; at: number }
}
const toldByWatch = new Map<string, Map<number, ToldBoundary>>()
const TOLD_KEEP_MS = 24 * 60 * 60_000
function noteToldByWatch(projectPath: string, agentId: string, told: Record<string, Baseline>, handoffs: boolean): void {
  const cards = Object.entries(told)
  if (!cards.length) return
  const key = agentKey(projectPath, agentId)
  const known = toldByWatch.get(key) ?? new Map<number, ToldBoundary>()
  for (const [n, b] of cards) {
    const had = known.get(Number(n))?.hand
    known.delete(Number(n))
    const now = { h: b.seen.h, at: Date.now() }
    known.set(Number(n), { ...now, ...(handoffs ? { hand: now } : had ? { hand: had } : {}) })
  }
  while (known.size > WOKE_CARDS) known.delete(known.keys().next().value!)
  toldByWatch.delete(key)
  toldByWatch.set(key, known)
  while (toldByWatch.size > MAX_WATCHES) toldByWatch.delete(toldByWatch.keys().next().value!)
}

/**
 * Whether a watch's line typed into the agent has told it of card `card`'s history entry `entry` (#578); for a reviewer's
 * request or a decision (`handoff`), only a line of a watch that counted them (#1272).
 */
export function watchTold(projectPath: string, agentId: string, card: TaskCard, entry: TaskCard['history'][number], handoff = false): boolean {
  const t = handoff ? toldOf(projectPath, agentId, card.number)?.hand : toldOf(projectPath, agentId, card.number)
  return !!t && entryWithin(card.history, entry, t.h)
}

/** What watches' lines last told an agent of a card (toldByWatch), while kept: each boundary for a day. */
function toldOf(projectPath: string, agentId: string, n: number): { h: string | null; hand?: { h: string | null } } | null {
  const t = toldByWatch.get(agentKey(projectPath, agentId))?.get(n)
  if (!t) return null
  const fresh = (x: { at: number }): boolean => Date.now() - x.at < TOLD_KEEP_MS
  return fresh(t) ? { h: t.h, ...(t.hand && fresh(t.hand) ? { hand: t.hand } : {}) } : t.hand && fresh(t.hand) ? { h: null, hand: t.hand } : null
}

/** Hive's own deliveries come from it. */
const HIVE = { kind: 'hive', name: 'Hive' } as const

/** A watch's wake's key among its deliveries: the watch and when it fired (a restart finds the one it made). */
const wakeRef = (rec: WatchRecord): string => `${rec.id}@${rec.fired?.at ?? ''}`

/** What a wake's line tells, as it was made: where the agent's next watch starts once that line is received (#224, #649). */
interface Told {
  /** Each card, as read for the line (else the watch's own start: nothing the line doesn't tell is taken as known). */
  cards: Record<string, Baseline>
  /** An agent watch's: each agent's latest event the line tells (else where the watch began). */
  agents: Map<string, number>
  /** A card watch's: the latest reply of the user's the line tells (#418), else where it began. */
  reply: number | undefined
  /** A lane watch's: when the line was made from the lanes (#531), and each lane as it tells it (else the watch's own marks). */
  laneAt: string
  laneMarks: Record<string, LaneMark> | null
  /** A lane watch's agents its line tells (HI-1987, by agentKey): its next lane watch keeps only the others. */
  laneAgents?: string[]
  /** A lane watch's: the latest wait for the user known when its line was made (#726), else the watch's own. */
  waitSeq?: number
  /** What the line tells of each card it names, as read for it (#578: what loop wakes then leave alone). */
  ofCards: Record<string, Baseline>
  /** Cards released as it was made (#420), noted in their history once it is received. */
  endedAt: { n: number; what: StoredText }[]
  /** Whether it tells a reply of the user's (#418), and the replies' generation then: revoked since, it isn't given. */
  replies: boolean
  generation: number

}

/**
 * Wakes handed over and not received yet, by their host and delivery id (ids are a host's own: every project starts at
 * m1): their watch and what their line tells (in memory, as `woke`).
 */
const handed = new Map<string, { store: Store; rec: WatchRecord; told: Told }>()
const handedKey = (host: string, id: string): string => `${resolve(host).toLowerCase()}#${id}`
const MAX_HANDED = 2000

/** The watch a wake's delivery was handed over by (its workspace's watches loaded), or null. */
function watchOf(host: string, r: DeliveryRecord): { store: Store; rec: WatchRecord } | null {
  const h = handed.get(handedKey(host, r.id))
  const store = storeFor(host)
  // Its own watch only: of this host and agent, handed over as this delivery (by its ref, the watch and its fire).
  const mine = (x: WatchRecord): boolean => x.fired?.delivery === r.id && same(x.projectPath, host) && x.agentId === r.agentId && wakeRef(x) === r.ref
  // The workspace's watches as they are now (a store read again since is the one that counts).
  if (h && h.store === store && h.store.list.includes(h.rec) && mine(h.rec)) return h
  const rec = store?.list.find(mine)
  return store && rec ? { store, rec } : null
}

/** Whether a wake's line still tells a reply the user still lets be told (#418). */
const repliesHold = (told: Told | undefined): boolean => !told?.replies || (tellReplies() && replyGeneration === told.generation)

/**
 * The watches' part in their wakes' deliveries (#649): a wake is offered only while its watch still has it (not
 * cancelled or replaced) and what it tells may still be told; received, the watch ends and what its line told is where
 * the agent's next watch starts; ended without that (expired, cancelled by its check), the watch fires again.
 */
registerSource('watch', {
  refresh: async (r, host) => {
    const w = watchOf(host, r)
    // Its workspace's watches not loaded yet: decided once they are (it isn't typed meanwhile).
    if (!w) return storeFor(host) ? { cancel: 'its watch has ended' } : null
    if (!repliesHold(handed.get(handedKey(host, r.id))?.told)) return { cancel: "the user's replies are no longer told" }
    return null
  },
  holds: (r, host) => !!watchOf(host, r) && repliesHold(handed.get(handedKey(host, r.id))?.told),
  received: (r, host) => {
    const w = watchOf(host, r)
    const told = handed.get(handedKey(host, r.id))?.told
    handed.delete(handedKey(host, r.id))
    if (!w) return
    const { store, rec } = w
    // What its line told (read back from the watch after a restart: its lanes' pending marks; the rest started afresh).
    if (told) toldBy(store, rec, told)
    else if (rec.lanes && rec.fired?.laneMarks) toldBy(store, rec, { cards: {}, agents: new Map(), reply: undefined, laneAt: rec.fired.at, laneMarks: rec.fired.laneMarks, laneAgents: rec.fired.agents, waitSeq: rec.waitSeq, ofCards: {}, endedAt: [], replies: false, generation: replyGeneration })
    log.info(`The wake for ${userText(rec.agentId)} (${r.id}) was received: its watch has ended`)
    // The watch has ended (unless it was replaced meanwhile, which stays).
    inBackground(
      'ending a watch',
      locked(store, async () => {
        if (!store.list.includes(rec) || rec.fired?.delivery !== r.id) return
        store.list = store.list.filter((x) => x !== rec)
        await saveQuietly(store)
      }).then(() => sessions.watchChanged(rec.projectPath, rec.agentId))
    )
  },
  ended: (r, host) => {
    const w = watchOf(host, r)
    handed.delete(handedKey(host, r.id))
    if (!w) return
    const { store, rec } = w
    // Not given (too old, or what it told may no longer be told): the watch goes back to waiting, and fires again on
    // what is still news to it.
    inBackground(
      'a wake not given',
      locked(store, async () => {
        if (!store.list.includes(rec) || rec.fired?.delivery !== r.id) return
        delete rec.fired
        await saveQuietly(store)
      }).then(() => {
        inBackground('checking watches', evaluate(store.ws))
        inBackground('checking agent watches', evaluateAgents(store))
      })
    )
  }
})

// A fired watch's line goes first: nothing else of Hive's is typed into its agent until it is handed over.
onLineComing((projectPath, agentId) => !!storeFor(projectPath)?.list.some((x) => x.fired && !x.fired.delivery && same(x.projectPath, projectPath) && x.agentId === agentId))

/** What a received wake told: the agent's next watch starts there (#224, #416, #418, #531, #578). */
function toldBy(store: Store, rec: WatchRecord, told: Told): void {
  const key = agentKey(rec.projectPath, rec.agentId)
  // The developer console (#636): the wake as it was received (its line is in the agent's own events, as input).
  devConsole.capture([store.ws.path && hiveSourceId(store.ws.path), sessionSourceId(rec.projectPath, rec.agentId)], () => {
    const what = rec.lanes ? 'lanes' : rec.agents ? `${rec.agents.agents.length} agent(s)` : rec.cond.cards.map((n) => `#${n}`).join(', ')
    return { kind: 'watch', name: 'wake', raw: { cards: rec.cond.cards, agents: rec.agents?.agents.length ?? 0, lanes: !!rec.lanes, firedAt: rec.fired?.at ?? null }, made: { typed: true, replies: told.replies }, safe: { raw: { firedAt: true } }, summary: `watch woke ${rec.agentId} (${what})` }
  })
  noteToldByWatch(rec.projectPath, rec.agentId, told.ofCards, !agentOnly(rec) && hearsHandoffs(rec.cond))
  for (const x of told.endedAt) inBackground(`noting on #${x.n} that a watch ended`, noteOnCard(x.n, x.what, store.ws))
  // What earlier wakes told about cards this one didn't stays: it is still all the agent was told about them.
  const known = new Map(store.woke.get(key))
  for (const [n, b] of Object.entries(told.cards)) {
    known.delete(n)
    known.set(n, b)
  }
  while (known.size > WOKE_CARDS) known.delete(known.keys().next().value!)
  store.woke.delete(key)
  store.woke.set(key, known)
  if (store.woke.size > MAX_WATCHES) store.woke.delete(store.woke.keys().next().value!)
  if (rec.agents) noteToldAgents(store, key, told.agents)
  // A lane watch's: each lane as its line told it (#531), where the agent's next lane watch starts, which keeps its cards
  // beside the lanes (#726).
  const lanes = told.laneMarks ?? rec.laneMarks
  if (rec.lanes && lanes) {
    store.wokeLanes.delete(key)
    const waitSeq = told.waitSeq ?? rec.waitSeq
    // Its agents (HI-1987) but those the line told: one-off work, followed until it is told.
    const kept = rec.agents?.agents.filter((a) => !told.laneAgents?.includes(agentKey(a.projectPath, a.agentId))) ?? []
    store.wokeLanes.set(key, { at: told.laneAt, marks: new Map(Object.entries(lanes)), ids: rec.lanes.ids, ...(rec.cond.cards.length ? { cards: { cards: [...rec.cond.cards], changes: [...rec.cond.changes] } } : {}), ...(waitSeq !== undefined ? { waitSeq } : {}), ...(kept.length ? { agents: { ...rec.agents!, agents: kept } } : {}) })
    if (store.wokeLanes.size > MAX_WATCHES) store.wokeLanes.delete(store.wokeLanes.keys().next().value!)
  }
  if (told.reply !== undefined) {
    store.wokeReplies.delete(key)
    store.wokeReplies.set(key, told.reply)
    if (store.wokeReplies.size > MAX_WATCHES) store.wokeReplies.delete(store.wokeReplies.keys().next().value!)
  }
}

/**
 * Watches read back handed over as deliveries (#649): one whose delivery was received while Hive was closed has ended;
 * one whose delivery ended without that (or is gone) fires again; one still to be received waits for it (offered once
 * more if it was being offered when Hive stopped).
 */
async function followDelivered(store: Store): Promise<void> {
  for (const rec of store.list.filter((r) => r.fired?.delivery)) {
    const id = rec.fired!.delivery!
    await loadDeliveries(rec.projectPath).catch((e) => log.warn('loading deliveries', e))
    const d = deliveryNow(rec.projectPath, id)
    if (d && isUnread(d)) continue
    const received = !!d && (d.state === 'received' || d.state === 'acked')
    await locked(store, async () => {
      if (!store.list.includes(rec) || rec.fired?.delivery !== id) return
      if (received) store.list = store.list.filter((x) => x !== rec)
      else delete rec.fired
      await saveQuietly(store)
    }).catch((e) => log.warn('following a wake', e))
    sessions.watchChanged(rec.projectPath, rec.agentId)
  }
  if (alive(store)) inBackground('checking watches', evaluate(store.ws))
}

/**
 * Hands a fired watch's line to the delivery service (#649), which types it: once its agent can take a line (ready,
 * finished or watching, nobody typing there, no line of Hive's waiting), so the line is made from the cards as they are
 * then. The watch stays (the agent shows watching and takes no other work) until that delivery is received (its line
 * taken by its CLI, or fetched with hive_inbox): then it ends, and what its line told is where the agent's next watch
 * starts, never on "typed". Cancelled or replaced meanwhile, its delivery is cancelled too. A card its line tells about
 * is checked again first: one that has left the agent's view is told as gone.
 */
async function deliver(store: Store, rec: WatchRecord): Promise<void> {
  if (!rec.fired || rec.fired.delivery || store.delivering.has(rec.id) || !alive(store)) return
  // Changes landing together are told together: a watch fired by a change waits a moment before its line is made (#224).
  const due = Date.parse(rec.fired.at) + (testHooks.settleMs ?? SETTLE_MS)
  if ((rec.fired.cards.length || rec.fired.agents?.length || rec.fired.lanes) && Date.now() < due) {
    if (!settling.has(rec.id)) {
      settling.add(rec.id)
      inBackgroundAfter(due - Date.now() + 10, 'waking an agent', () => {
        settling.delete(rec.id)
        return deliver(store, rec)
      })
    }
    return
  }
  // Not over a line it hasn't taken (#430): its next wake waits until it takes that one, or the user presses Enter there.
  // Nor before its CLI has taken its launch's task (#721), or connected its hive tools (#865).
  if (!readyFor(sessions.liveFor(rec.projectPath, rec.agentId)) || sessions.userMayBeTyping(rec.projectPath, rec.agentId) || sessions.lineWaiting(rec.projectPath, rec.agentId) || sessions.launchTaskWaiting(rec.projectPath, rec.agentId) || sessions.hiveToolsWaiting(rec.projectPath, rec.agentId)) return
  const token = { cancelled: false }
  store.delivering.set(rec.id, token)
  const current = (): boolean => !token.cancelled && alive(store) && store.list.includes(rec)
  try {
    let line = rec.fired.line
    let returned: 'queueReturn' | 'commentOnly' | false = false
    // Whether the line tells a reply of the user's (#418): then the setting is checked again before every piece and
    // before Enter, and turned off, it isn't given.
    let telling = !!rec.fired.replies
    const generation = replyGeneration
    // What the line tells the agent about each card, where its next watch starts from (#224): the cards as read for the
    // line; otherwise (a line about the limit, or one not made again) the watch's own starting point, so nothing that
    // the line doesn't tell is taken as known.
    let told: Record<string, Baseline> = {}
    const toldAgents = new Map(Object.entries(rec.agentMarks ?? {}).map(([k, m]) => [k, m.seq]))
    let toldReply = rec.replySeq
    let laneTold: Record<string, LaneMark> | null = null
    let laneAgentsTold: string[] = []
    let laneToldAt = rec.fired.at
    let waitTold = rec.waitSeq
    let toldOfCards: Record<string, Baseline> = {}
    const endedAt: { n: number; what: StoredText }[] = []
    for (const n of rec.cond.cards) {
      const s = rec.seen?.[n]
      if (s) told[n] = { mark: rec.marks[n], seen: s }
    }
    if (rec.lanes) {
      // A lane watch's (#531): every lane's events since its marks, with the cards beside its lanes that changed and the
      // agents waiting for the user (#726). Ones that landed after it fired are in the same line, and the marks it is
      // handed over with are what the wake told. Fired by its limit, its line stays.
      // Its agents (HI-1987): each one's latest event since the watch began, told in the same line.
      const r = rec.fired.lanes ? await laneRound(store, rec).catch(() => null) : null
      // HI-2153: its cards in Done or archived since leave it as the line is made (never told), so what the wake hands
      // over (its cards, for the next lane watch) is without them.
      if (r?.drop.some((n) => rec.cond.cards.includes(n))) {
        const ok = await locked(store, async () => {
          if (!current() || !rec.fired || rec.fired.sending || rec.fired.delivery) return false
          dropLaneCards(rec, r, endedAt)
          await saveQuietly(store)
          return true
        }).catch(() => false)
        if (!ok) return
        sessions.watchChanged(rec.projectPath, rec.agentId)
      }
      const agentsNow = r && rec.agents ? agentHits(rec) : []
      for (const h of agentsNow) toldAgents.set(agentKey(h.agent.projectPath, h.agent.agentId), h.seq)
      laneAgentsTold = agentsNow.map((h) => agentKey(h.agent.projectPath, h.agent.agentId))
      if (r && (roundTells(r) || agentsNow.length)) {
        line = laneLine(store, rec, r, agentsNow)
        laneTold = r.next
        laneToldAt = new Date().toISOString()
        waitTold = r.waitSeq
        if (r.cards.length) told = r.told
        toldOfCards = Object.fromEntries(r.cards.filter((h) => h.changes !== 'gone' && r.told[h.number]).map((h) => [h.number, r.told[h.number]]))
      } else if (r) {
        // Nothing left to tell (a wait the user answered meanwhile, a block lifted): not given, the watch waits on.
        for (const x of endedAt) inBackground(`noting on #${x.n} that a watch ended`, noteOnCard(x.n, x.what, store.ws))
        await withdraw(store, rec, current)
        return
      }
    } else if (rec.fired.cards.length) {
      // Told as the cards are now, every change since the watch began (#224): one that landed after the line was made
      // is in it too, and a card that has left the agent's view is told as gone.
      // With the releases' lanes and setting now (#1475): a lane ended, or a card merged, before the line is handed over.
      const r = await check(store, rec, undefined, await (await releaseContexts(store, [rec]))(rec))
      // A card released since the line was made (#420: reassigned before it was handed over) is told as released, not
      // as the change that fired it.
      let left = rec.cond.cards.length
      if (r.released.length) {
        const ok = await locked(store, async () => {
          if (!current() || !rec.fired || rec.fired.sending || rec.fired.delivery) return false
          left = applyRelease(rec, r.released, endedAt)
          await saveQuietly(store)
          return true
        }).catch(() => false)
        if (!ok) return
        sessions.watchChanged(rec.projectPath, rec.agentId)
      }
      if (r.released.length && !left) {
        line = lineFor(store, rec, () => releasedLine(rec.released!))
        telling = false
      } else if (r.released.length && !r.hits.length && !r.replies.length) {
        // What fired it was a card since released, and the rest haven't changed: not given; the watch waits on for the
        // rest, and tells the release with its next line (#420).
        for (const x of endedAt) inBackground(`noting on #${x.n} that a watch ended`, noteOnCard(x.n, x.what, store.ws))
        await withdraw(store, rec, current)
        sessions.watchChanged(rec.projectPath, rec.agentId)
        return
      } else if (r.hits.length || r.replies.length) {
        const made = withCardNames(store.ws, () => cardWakeLine(r.hits, r.replies.map((x) => x.note), rec.released ?? [], userName()), rec.scope)
        line = fitLine(made.line)
        // HI-2087: a line about one card that leads with the merge queue's return of it, or tells only a comment on it,
        // marked so (the inbox's fold leads with a return only while nothing but comments came after it).
        const one = r.hits.length === 1 && !r.replies.length ? r.hits[0] : null
        returned = one?.about?.queueReturn ? 'queueReturn' : one && one.changes !== 'gone' && one.changes.length && one.changes.every((c) => c === 'comment') ? 'commentOnly' : false
        telling = r.replies.length > 0
        toldOfCards = Object.fromEntries(r.hits.filter((h) => h.changes !== 'gone' && r.told[h.number]).map((h) => [h.number, r.told[h.number]]))
        if (r.hits.length) told = r.told
        // Only replies the line names are told (#418).
        if (made.repliesTold) toldReply = Math.max(rec.replySeq ?? 0, ...r.replies.map((x) => x.seq))
      } else if (rec.fired.replies) {
        // It told only replies, which may no longer be told (the setting turned off): not given, the watch waits on.
        await withdraw(store, rec, current)
        return
      }
    } else if (rec.fired.limit) {
      // A plain card watch's limit (HI-2295): told as its cards are now, not as they were when it fired (the agent may
      // have been busy since, and submitted its card to Review, or had it sent back).
      const where = await reviewWhere(store, rec)
      line = lineFor(store, rec, () => limitLine(rec.cond, rec.limitMinutes, rec.released ?? [], where))
    } else if (rec.fired.agents?.length) {
      // Every agent's latest event since the watch began (#416): one that finished meanwhile is in it too, and one
      // given work again since is still told what it did (and that it is working again).
      const hits = agentHits(rec)
      if (hits.length) {
        line = lineFor(store, rec, () => agentWakeLine(hits, userName()))
        telling = hits.some((h) => h.reply !== undefined)
        for (const h of hits) toldAgents.set(agentKey(h.agent.projectPath, h.agent.agentId), h.seq)
      } else if (rec.fired.replies) {
        await withdraw(store, rec, current)
        return
      }
    }
    if (telling && (!tellReplies() || replyGeneration !== generation)) throw new RepliesRevoked()
    // The Assistant woken from a card watch while lanes run (#402): its watch has ended, so the line says to watch them
    // all again (a model that reads no skill on a wake otherwise ends its turn watching nothing).
    if (rec.agentId === ASSISTANT_AGENT_ID && !rec.agents && !rec.lanes && rec.cond.cards.length && (await listLanes(store.ws).catch(() => [])).some((l) => l.state === 'active' || l.state === 'paused')) line = withLanesTail(line, MAX_LINE_BYTES)
    // Handed over as a delivery, saved as the watch's before the service can type it: a restart follows that delivery
    // rather than making another (the same watch and fire make the same one). Not saved: not handed over (tried again).
    const given = await locked(store, async () => {
      if (!current() || !rec.fired || rec.fired.delivery) return null
      const d = await createDelivery(rec.projectPath, { agentId: rec.agentId, kind: 'card-event', from: HIVE, body: line, ...(rec.fired.cards.length ? { card: rec.fired.cards[0] } : {}), source: 'watch', ref: wakeRef(rec), replace: true, ...(returned ? { meta: { [returned]: true } } : {}), ...(rec.fired.again ? { again: 'Hive restarted while typing it' } : {}) })
      rec.fired.line = line
      rec.fired.delivery = d.id
      // A lane watch's marks move only once its line is received: pending with it until then (saved, for a restart).
      if (laneTold) rec.fired.laneMarks = laneTold
      try {
        await save(store)
      } catch (e) {
        delete rec.fired.delivery
        delete rec.fired.laneMarks
        await cancelFromSource(rec.projectPath, 'watch', wakeRef(rec), "cancelled: its watch couldn't be saved").catch(() => undefined)
        throw e
      }
      handed.set(handedKey(rec.projectPath, d.id), { store, rec, told: { cards: told, agents: toldAgents, reply: toldReply, laneAt: laneToldAt, laneMarks: laneTold, laneAgents: laneAgentsTold, waitSeq: waitTold, ofCards: toldOfCards, endedAt, replies: telling, generation } })
      while (handed.size > MAX_HANDED) handed.delete(handed.keys().next().value!)
      return d
    })
    if (!given) return
    log.info(`The wake for ${userText(rec.agentId)} was handed over as ${given.id}`)
    // Offered now (typed if it can be), as the wake always was when its watch was delivered.
    await offerNow(rec.projectPath, rec.agentId)
  } catch (e) {
    // A line telling a reply the user no longer lets be told is dropped: the watch waits on, and fires again on whatever
    // else changed, made without the reply.
    if (e instanceof RepliesRevoked) {
      await locked(store, async () => {
        if (!store.list.includes(rec) || !rec.fired || rec.fired.delivery) return
        delete rec.fired
        await saveQuietly(store)
      }).catch(() => undefined)
      inBackground('checking watches', evaluate(store.ws))
      inBackground('checking agent watches', evaluateAgents(store))
    }
    log.info(`Wake for ${userText(rec.agentId)} put off: ${(e as Error).message}`)
  } finally {
    store.delivering.delete(rec.id)
  }
}

/** Checks one watch against the board: whether it fires now. Its cards are read as its scope sees them. */
async function check(store: Store, rec: WatchRecord, cards?: CardReads, ctx: ReleaseContext = NO_CONTEXT): Promise<{ moved: boolean; hits: CardChange[]; told: Record<string, Baseline>; replies: { seq: number; note: ReplyNote }[]; released: Released[] }> {
  const hits: CardChange[] = []
  // Cards the watcher's part in has ended (#420).
  const released: Released[] = []
  // The user's replies to a watched card's agent or reviewer since the watch began (#418), for the Assistant: each once,
  // with the watched cards its agent has or reviews.
  const said = new Map<number, { seq: number; note: ReplyNote }>()
  // Each card as read now: what a line made from these reads tells the agent.
  const told: Record<string, Baseline> = {}
  let moved = false
  for (const n of rec.cond.cards) {
    const card = await cardIn(store, n, rec.scope, cards)
    const gone = releaseOf(rec, n, card, ctx)
    if (gone) {
      released.push(gone)
      continue
    }
    const after = markOf(card)
    if (card) told[n] = { mark: after, seen: seenOf(card) }
    const prev = rec.current?.[n]
    if (prev?.column !== after.column || prev?.agent !== after.agent) moved = true
    ;(rec.current ??= {})[n] = after
    // Seen moved into the column as last seen (it was elsewhere, it's there now): also when its history no longer says,
    // and for a watch that waits only to see it there (#521).
    const intoAsSeen = !!rec.cond.column &&!!prev && prev.column !== rec.cond.column && after.column === rec.cond.column
    const seen = rec.seen?.[n]
    let kinds: WatchChange[] | 'gone'
    if (seen) {
      // From where the watch's view of the card ended (#224).
      kinds = changesSince(card, { mark: rec.marks[n], seen, since: rec.since, self: rec.self, watcher: rec.watcherName }, rec.cond)
      if (kinds !== 'gone' && intoAsSeen && !kinds.includes('column') && (!rec.cond.changes.length || rec.cond.changes.includes('column'))) kinds.push('column')
    } else {
      // A watch saved before #224: a move into the column by its history since the watch began.
      const into = !!rec.cond.moveInto && !!rec.cond.column && (movedIntoSince(card, rec.cond.column, rec.since) || intoAsSeen)
      kinds = changesBetween(rec.marks[n], after, rec.cond, into)
      if (kinds !== 'gone') kinds.push(...handoffsSince(card, rec.since, rec.cond, rec.watcherName))
    }
    // HI-2153: in Done with nothing new to tell (a watch saved on it there, or the watcher's own move): it ends all the same.
    if (kinds !== 'gone' && !kinds.length && card?.column === 'done') {
      released.push({ number: n, why: 'done', detail: null })
      continue
    }
    if (kinds === 'gone' || kinds.length) {
      const about = wakeAbout(card, kinds, rec.agentId)
      // HI-2087: moved back to work because the merge queue returned it: the line leads with the return and its reason.
      if (kinds !== 'gone' && kinds.includes('column') && card && (card.column === 'doing' || card.column === 'todo') && card.project && store.path) {
        const back = await queueReturnOf(store.ws, join(store.path, card.project), n).catch(() => null)
        if (back) about.queueReturn = back.text
      }
      // HI-2143: back in Review, submitted again after that return: for whoever watches it but its builder, led by that.
      if (kinds !== 'gone' && kinds.includes('column') && card && card.column === 'review' && card.agent !== rec.agentId && card.project && store.path) {
        const again = await resubmittedOf(store.ws, join(store.path, card.project), n, card.agentName ?? card.agent ?? 'its builder').catch(() => null)
        if (again) about.resubmitted = again
      }
      hits.push({ ...cardChange(n, card, kinds), about })
    }
    if (card?.project && rec.scope === null && rec.replySeq !== undefined) {
      const projectPath = join(store.path, card.project)
      for (const id of new Set([card.agent, card.review?.agent].filter((x): x is string => !!x))) {
        const r = replyTo(rec.scope, projectPath, id, rec.replySeq)
        if (!r) continue
        const had = said.get(r.seq)
        if (had) had.note.cards.push(n)
        else said.set(r.seq, { seq: r.seq, note: { agentName: r.agentName, cards: [n], text: r.text } })
      }
    }
  }
  return { moved, hits, told, replies: [...said.values()], released }
}

/**
 * Whether a watched card leaves the watch because the watcher's part in it ended (#420): the card was given to another
 * agent (or none) when the watcher had it; or another agent reviews it when the watcher reviewed it, or waited for it
 * to arrive in Review. Null: it stays. A card that is gone is told as gone, as before. A blocked card stays too (#481):
 * it is paused, not gone, and its loop waits for it (a reviewer that moved on deadlocked with its builder).
 */
function releaseOf(rec: WatchRecord, n: number, card: TaskCard | null, ctx: ReleaseContext = NO_CONTEXT): Released | null {
  // HI-2153 (#1475 before, for a loop's watches only): in Done, nothing more comes of it, whoever watches it and for
  // what. A watch that counts the move there is told it as that change (check: unless it saw nothing new).
  if (card && !card.archived && card.column === 'done' && !countsDone(rec.cond)) return { number: n, why: 'done', detail: null }
  const on = rec.on?.[n]
  if (!on || !card || card.archived) return null
  const me = rec.agentId
  const reviewer = card.review && card.review.agent !== me ? card.review.agentName || card.review.agent : null
  if (on.role === 'agent' && card.agent !== me) return { number: n, why: 'reassigned', detail: card.agentName ?? card.agent ?? null }
  if ((on.role === 'reviewer' || on.role === 'awaiting') && reviewer) return { number: n, why: 'reviewer', detail: reviewer }
  // Its review taken from it (not ended by its own verdict): stopped, or cleared by someone else.
  if (on.role === 'reviewer' && !card.review) {
    const last = card.history.findLast((h) => /^(Started reviewing|Review (passed|failed)|Review by .* stopped)/.test(h.what))
    if (!last || !(/^Review (passed|failed)/.test(last.what) && last.by === rec.watcherName)) return { number: n, why: 'reviewer', detail: null }
  }
  // Waiting for it in Review: its agent was replaced by another, or by none (its work goes to another lane, or nowhere).
  const was = rec.marks[n]?.agent
  if (on.role === 'awaiting' && was && card.agent !== was && card.agent !== me) return { number: n, why: 'reassigned', detail: card.agentName ?? card.agent ?? null }
  // #1475: nothing more can come of it (the project's card-loop wakes off: kept, as before).
  if (!ctx.loopWakes) return null
  // A watch for the card's Done that sees it there has what it waited for (HR4's #1475 round 1): told as that change,
  // never as its lane's end. Anything else waited for on a lane that has ended is obsolete, also a change that fired the
  // watch before the lane ended but wasn't handed over yet (an arrival in Review of an abandoned lane's card).
  if (card.column === 'done' && countsDone(rec.cond)) return null
  const lane = laneEndedOn(rec, n, on, ctx.lanes)
  if (lane) return { number: n, why: 'laneEnded', detail: lane.state === 'abandoned' ? 'abandoned' : null }
  return null
}

/** What #1475's releases read once per evaluation: the lanes (null: none read), and whether the project wakes card loops. */
interface ReleaseContext {
  lanes: readonly LaneInfo[] | null
  loopWakes: boolean
}

const NO_CONTEXT: ReleaseContext = { lanes: null, loopWakes: false }

/** Whether a watch counts a card's move into Done: it waits for Done, or for any column change. */
const countsDone = (cond: WatchCondition): boolean => (cond.column ? cond.column === 'done' : !cond.changes.length || cond.changes.includes('column'))

/**
 * The watcher's lane on a card that ended or was abandoned since the watch began (#1475), with no running lane of its
 * project having the card with the watcher in the same part (a lane started again with it): null otherwise. Its builder
 * for a card it has, its reviewer for one it reviews or waits for.
 */
function laneEndedOn(rec: WatchRecord, n: number, on: OnCard, lanes: readonly LaneInfo[] | null): LaneInfo | null {
  if (!lanes || !rec.scope) return null
  const me = rec.agentId
  const mine = (l: LaneInfo): boolean => same(l.project, rec.scope!) && l.cards.some((c) => c.number === n) && (on.role === 'agent' ? l.builder.id === me : l.reviewer?.id === me)
  if (lanes.some((l) => (l.state === 'active' || l.state === 'paused') && mine(l))) return null
  const since = Date.parse(rec.since)
  return lanes.find((l) => (l.state === 'ended' || l.state === 'abandoned') && mine(l) && Date.parse(l.endedAt ?? '') > since) ?? null
}

/**
 * The lanes and the setting a round of card watches' releases reads (#1475): read only when one of `recs` has a part in a
 * card. A round's unfired watches, or a fired one checked again as it is delivered (its line made from the cards now).
 */
async function releaseContexts(store: Store, recs: readonly WatchRecord[]): Promise<(rec: WatchRecord) => Promise<ReleaseContext>> {
  const any = recs.some((r) => !r.agents && !r.lanes && r.on && Object.keys(r.on).length)
  if (!any) return async () => NO_CONTEXT
  const lanes = await listLanes(store.ws, { all: true }).catch((e) => {
    log.warn('reading lanes for card watches', e)
    return null
  })
  const wakes = new Map<string, Promise<boolean>>()
  const loopWakesIn = (projectPath: string): Promise<boolean> => {
    const k = resolve(projectPath).toLowerCase()
    let p = wakes.get(k)
    if (!p) wakes.set(k, (p = store.ws.projectConfig(projectPath).then((c) => projectPreferences(store.ws, projectPath, c).loopWakes, () => projectPreferences(store.ws, projectPath).loopWakes)))
    return p
  }
  return async (rec) => (rec.on && Object.keys(rec.on).length ? { lanes, loopWakes: await loopWakesIn(rec.projectPath) } : NO_CONTEXT)
}

/** What ended a watch on a card (#420), for its history: the line's reason, and who reviews it or has it now. */
const releasedWhy = (r: Released): { why: string; agent: string } =>
  r.why === 'blocked' || r.why === 'done' ? { why: r.why, agent: '' } : r.why === 'laneEnded' ? { why: r.detail === 'abandoned' ? 'laneAbandoned' : 'laneEnded', agent: '' } : r.why === 'reviewer' ? (r.detail ? { why: 'reviewer', agent: r.detail } : { why: 'reviewTaken', agent: '' }) : r.detail ? { why: 'reassigned', agent: r.detail } : { why: 'unassigned', agent: '' }

/**
 * Takes released cards out of a watch (#420), under the store's lock: they join what its next line tells (`released`),
 * each noted for its card's history (`ended`), and the watch keeps the rest, with their marks. How many cards are left
 * (0: every card was released; the watch keeps its condition then, and its line tells only the releases).
 */
function applyRelease(rec: WatchRecord, released: Released[], ended: { n: number; what: StoredText }[]): number {
  rec.released = [...(rec.released ?? []), ...released].slice(-WATCH_MAX_CARDS)
  for (const x of released) ended.push({ n: x.number, what: storedText(HISTORY.watchEnded, { watcher: rec.watcherName ?? rec.agentId, ...releasedWhy(x) }) })
  const left = rec.cond.cards.filter((n) => !released.some((x) => x.number === n))
  if (!left.length) return 0
  rec.cond = { ...rec.cond, cards: left }
  for (const x of released) {
    delete rec.marks[x.number]
    delete rec.seen?.[x.number]
    delete rec.current?.[x.number]
    delete rec.on?.[x.number]
  }
  return left.length
}

/**
 * A project's place by its stable id (#508), for a watch's own folder or a watched agent's: the folder that has its id
 * now (renamed or moved since, the whole workspace too), `gone` when its id is no project's now and another project has
 * its folder (never that project's watch), or the id to stamp on one saved before ids whose folder is a project. Only
 * this workspace's projects: the index is its own.
 */
function placeOf(ids: ProjectIdIndex, projectPath: string, projectId: string | undefined): { path?: string; id?: string; gone?: true } {
  const now = projectId ? ids.byId.get(projectId) : undefined
  if (now) return same(resolve(now), resolve(projectPath)) ? {} : { path: now }
  const here = ids.byPath.get(resolve(projectPath).toLowerCase())
  if (!projectId) return here ? { id: here } : {}
  return here && here !== projectId ? { gone: true } : {}
}

/**
 * The folder this workspace was in before it moved here (#146), for watches saved there: as the workspace records it
 * (movedFrom: where it was last opened, as it opened), or else as its watches with ids say, when those whose project is
 * here now were all saved under one other folder. Null when it didn't move, or that can't be known.
 */
function oldFolder(ws: WorkspaceService, path: string, ids: ProjectIdIndex, list: readonly WatchRecord[]): string | null {
  if (ws.movedFrom) return same(ws.movedFrom, resolve(path)) ? null : ws.movedFrom
  const roots = new Map<string, string>()
  for (const rec of list)
    for (const t of [rec, ...(rec.agents?.agents ?? [])])
      if (t.projectId && ids.byId.has(t.projectId) && !ws.isAssistantHome(t.projectPath)) {
        const d = dirname(resolve(t.projectPath))
        if (!same(d, resolve(path))) roots.set(d.toLowerCase(), d)
      }
  return roots.size === 1 ? [...roots.values()][0] : null
}

/** A path saved under the workspace's old folder (oldFolder), as it is under its folder now; any other path as it is. */
const movedPath = (path: string, from: string | null, p: string): string => (from ? (rebase(resolve(p), from, resolve(path)) ?? p) : p)

/**
 * Brings a watch to its projects' folders now, by their ids (#508): its own (the watcher's), and each agent an agent watch
 * follows (with its marks, and the agents a fired line tells, kept by their folder). An id in this workspace's index
 * decides, wherever it was saved (the whole workspace moved since too): the folder is that project's, so always one of
 * this workspace's. One from before ids, and the Assistant's, come from the workspace's old folder (`from`, oldFolder)
 * to the same place under its folder now, never from another path, and get their ids. `gone`: the watcher's project is
 * gone and another project has its folder. A watched agent whose project is gone while another project has its folder is
 * marked `gone`: told as stopped, never as that project's agent of the same id.
 */
function followIds(ws: WorkspaceService, path: string, ids: ProjectIdIndex, rec: WatchRecord, from: string | null): 'same' | 'changed' | 'gone' {
  let changed = false
  const known = (id: string | undefined): boolean => !!id && ids.byId.has(id)
  if (!ws.isAssistantHome(rec.projectPath)) {
    const p = known(rec.projectId) ? rec.projectPath : movedPath(path, from, rec.projectPath)
    if (ws.isAssistantHome(p)) {
      rec.projectPath = ws.assistantHome
      changed = true
    } else if (known(rec.projectId) || hostedIn(ws, path, p)) {
      const at = placeOf(ids, p, rec.projectId)
      if (at.gone) return 'gone'
      const to = at.path ?? p
      if (to !== rec.projectPath) {
        log.info(`A watch follows its project to ${userText(basename(to))}`)
        rec.projectPath = to
        changed = true
      }
      if (at.id) {
        rec.projectId = at.id
        changed = true
      }
    }
  }
  for (const a of rec.agents?.agents ?? []) {
    const p = known(a.projectId) ? a.projectPath : movedPath(path, from, a.projectPath)
    if (!known(a.projectId) && !mayWatch(ws, path, rec.projectPath, p)) continue
    const at = placeOf(ids, p, a.projectId)
    if (!!at.gone !== !!a.gone) {
      if (at.gone) {
        log.info("A watched agent's project is gone, and another project has its folder: it is told as stopped")
        a.gone = true
      } else delete a.gone
      changed = true
    }
    const to = at.path ?? p
    if (to !== a.projectPath) {
      const was = agentKey(a.projectPath, a.agentId)
      a.projectPath = to
      a.project = basename(to)
      const key = agentKey(a.projectPath, a.agentId)
      if (rec.agentMarks && was in rec.agentMarks && was !== key) {
        rec.agentMarks[key] = rec.agentMarks[was]
        delete rec.agentMarks[was]
      }
      if (rec.fired?.agents) rec.fired.agents = rec.fired.agents.map((k) => (k === was ? key : k))
      changed = true
    }
    if (at.id) {
      a.projectId = at.id
      changed = true
    }
  }
  return changed ? 'changed' : 'same'
}

/**
 * Watches whose project was renamed or moved within the workspace while Hive runs (#508) go with it, by its id: their
 * folder and the cards they may see are the project's now, and so do the agents an agent watch follows. A watch whose
 * project is gone while another project has its folder leaves the list, kept aside in the file (as one that isn't valid
 * is when read). Whether any changed (in the store's lock).
 */
function followProjects(store: Store, ids: ProjectIdIndex): boolean {
  let changed = false
  const from = oldFolder(store.ws, store.path, ids, store.list)
  for (const rec of [...store.list]) {
    const before = rec.projectPath
    const r = followIds(store.ws, store.path, ids, rec, from)
    if (r === 'same') continue
    changed = true
    if (r === 'gone') {
      store.list = store.list.filter((x) => x !== rec)
      store.invalid.push(entryOf(rec))
      sessions.watchChanged(before, rec.agentId)
      continue
    }
    if (rec.projectPath !== before) {
      // An agent has one watch: one made at the new folder since stays.
      if (store.list.some((x) => x !== rec && same(x.projectPath, rec.projectPath) && x.agentId === rec.agentId)) {
        store.list = store.list.filter((x) => x !== rec)
        continue
      }
      rec.scope = scopeFor(store.ws, rec.projectPath)
      sessions.watchChanged(rec.projectPath, rec.agentId)
    }
  }
  return changed
}

/** Checks a workspace's watches against its board: those whose cards changed (as they count) fire, then are delivered. */
async function evaluate(ws: WorkspaceService): Promise<void> {
  const store = await load(ws)
  // Whether a watched card's column or agent changed (also gone, or out of the agent's view): what a pending quit's
  // "is the work it waits for going on?" reads (watchKeepsQuitWaiting), told once the cards as last seen are updated.
  let moved = false
  // Watches that ended on a card (#420), for its history once the watches are saved, and those left with fewer cards
  // (what their agents show changes).
  const ended: { n: number; what: StoredText }[] = []
  const narrowed: WatchRecord[] = []
  await locked(store, async () => {
    // The projects as they are now, which the cards read below see too.
    let changed = followProjects(store, await store.ws.projectIds({ fresh: true }))
    // Each card read once for all the watches on it (#321).
    const reads: CardReads = new Map()
    const contextOf = await releaseContexts(store, store.list.filter((r) => !r.fired))
    for (const rec of [...store.list]) {
      if (rec.fired || rec.agents || rec.lanes || usageOnly(rec)) continue
      // One watch that can't be checked doesn't stop the others.
      try {
        const r = await check(store, rec, reads, await contextOf(rec))
        if (r.moved) moved = true
        if (r.released.length) {
          // Released cards leave the watch (#420), told with its next line; when none is left, it is woken now.
          changed = true
          if (!applyRelease(rec, r.released, ended)) {
            rec.fired = { line: lineFor(store, rec, () => releasedLine(rec.released!)), at: new Date().toISOString(), cards: [] }
            continue
          }
          narrowed.push(rec)
        }
        const hits = r.hits
        if (!hits.length && !r.replies.length) continue
        const cards = [...new Set([...hits.filter((h) => h.changes !== 'gone').map((h) => h.number), ...r.replies.flatMap((x) => x.note.cards)])]
        rec.fired = { line: lineFor(store, rec, () => cardWakeLine(hits, r.replies.map((x) => x.note), rec.released ?? [], userName()).line), at: new Date().toISOString(), cards, ...(r.replies.length ? { replies: true as const } : {}) }
        changed = true
      } catch (e) {
        if (!alive(store)) throw e
        log.warn(`checking the watch of ${userText(rec.agentId)}`, e)
      }
    }
    if (changed) await saveQuietly(store)
  })
  for (const x of ended) inBackground(`noting on #${x.n} that a watch ended`, noteOnCard(x.n, x.what, store.ws))
  for (const rec of narrowed) sessions.watchChanged(rec.projectPath, rec.agentId)
  if (moved && alive(store)) watchedCardsMoved?.()
  for (const rec of store.list.filter((r) => r.fired)) await deliver(store, rec)
  // Lane watches follow the same board (#531).
  await evaluateLanes(store).catch((e) => log.warn('checking lane watches', e))
  // Usage watches (HI-2195), alone or beside cards or lanes: one read back as the workspace opens is checked against the
  // usage kept now (another workspace's sessions may have reported it while this one was closed).
  await evaluateUsage(store).catch((e) => log.warn('checking usage watches', e))
}

/**
 * Where each of a timed-out card watch's cards is now, when it is in Review (HI-2295): its limit line says so instead of
 * telling the agent to ask the user. From the board as it is: the card's review (being reviewed), else for a pool lane's
 * card its assigned reviewer or none yet (loopReviewerOf), else waiting for its reviewer. Not a card the watcher reviews
 * itself, nor one that left the watch.
 */
async function reviewWhere(store: Store, rec: WatchRecord): Promise<ReviewWhere[]> {
  const gone = new Set((rec.released ?? []).map((r) => r.number))
  const out: ReviewWhere[] = []
  for (const n of rec.cond.cards) {
    if (gone.has(n)) continue
    const card = await cardIn(store, n, rec.scope).catch(() => null)
    if (!card || card.archived || card.column !== 'review') continue
    if (card.review) {
      if (rec.scope !== null && card.review.agent === rec.agentId) continue
      out.push({ number: n, state: 'reviewing', reviewer: card.review.agentName || card.review.agent })
    } else if (poolCard(store.ws, card)) {
      const r = await loopReviewerOf(store.ws, card).catch(() => null)
      out.push(r ? { number: n, state: 'assigned', reviewer: r.name } : { number: n, state: 'pool' })
    } else out.push({ number: n, state: 'review' })
  }
  return out
}

/** Told when watched cards move or change hands (after the watches have seen it): a pending quit checks again. */
let watchedCardsMoved: (() => void) | null = null
export function onWatchedCardsMoved(fn: () => void): void {
  watchedCardsMoved = fn
}

/** The tick: limits passed with no change fire; fired watches are tried again (an agent idle, the user done typing). */
export async function tick(now = Date.now()): Promise<void> {
  for (const store of [...stores.values()]) {
    if (!alive(store)) continue
    await locked(store, async () => {
      let changed = store.dirty
      for (const rec of store.list) {
        if (!rec.fired && Date.parse(rec.limitAt) <= now) {
          const plain = !rec.lanes && !rec.agents && !usageOnly(rec)
          const where = plain ? await reviewWhere(store, rec) : []
          rec.fired = { line: lineFor(store, rec, () => (rec.lanes ? laneLimitLine(rec.lanes, rec.limitMinutes, rec.cond.cards, rec.agents?.agents) : rec.agents ? agentLimitLine(rec.agents, rec.limitMinutes) : usageOnly(rec) ? usageLimitLine(rec.usage!, rec.limitMinutes) : limitLine(rec.cond, rec.limitMinutes, rec.released ?? [], where))), at: new Date(now).toISOString(), cards: [], ...(plain ? { limit: true as const } : {}) }
          changed = true
        }
      }
      if (changed) await saveQuietly(store)
    }).catch((e) => log.warn('watch limits', e))
    // Usage watches (HI-2195) are checked on every usage report; also here, for one that reached its share unseen.
    await evaluateUsage(store).catch((e) => log.warn('checking usage watches', e))
    // Agent watches are checked on every status change; also here, for what no status change tells (a typed prompt
    // its CLI never took).
    await evaluateAgents(store).catch((e) => log.warn('checking agent watches', e))
    // Lane watches (#531): a stall comes with time (a card waiting in Review), so they are checked now and then too.
    if (now - (store.laneTickAt ?? 0) >= LANE_TICK_MS) {
      store.laneTickAt = now
      await evaluateLanes(store).catch((e) => log.warn('checking lane watches', e))
    }
    for (const rec of store.list.filter((r) => r.fired)) await deliver(store, rec)
  }
}

/**
 * Whether a watching agent keeps "Quit when agents finish" waiting: it does while a card it watches is in Doing or Review
 * with another agent (the work it waits for is going on). The label says what for.
 */
export function watchKeepsQuitWaiting(st: LiveSessionState): string | null {
  if (st.status !== 'watching' || !st.watch) return null
  const store = storeFor(st.projectPath)
  const rec = store && recordOf(store, st.projectPath, st.agentId)
  if (!rec) return null
  // An agent watch: while an agent it waits for works; a lane watch's agents (HI-1987) likewise.
  const agentsBusy = !!rec.agents?.agents.some((a) => agentBusy(agentNowOf(a), rec.agents!.ignoreBackground))
  if (agentOnly(rec) || agentsBusy) return agentsBusy ? st.watch.label : null
  // A lane watch: it follows lanes, not work it is waiting on (#531), but the cards beside them (#726) are like a card watch's.
  if (rec.lanes && !rec.cond.cards.length) return null
  const busyCard = rec.cond.cards.some((n) => {
    const m = rec.current?.[n] ?? rec.marks[n]
    return m && (m.column === 'doing' || m.column === 'review') && m.agent && m.agent !== st.agentId
  })
  return busyCard ? st.watch.label : null
}

let started = false
/** Wires watches into the sessions and the board's events (once, at start). */
export function initWatches(): void {
  if (started) return
  started = true
  sessions.watchFor = watchFor
  sessions.conversationEnds = endConversationWatch
  sessions.userReplied = noteUserReply
  config.onSettingsChanged((s, prev) => {
    if (prev.assistant?.tellReplies !== false && s.assistant?.tellReplies === false) inBackground('withdrawing replies', revokeReplies())
  })
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && same(w.path, e.workspacePath))
      // One check at a time for board changes (#1011): those told while one runs are seen by one more check after it.
      if (ws) inBackground('checking watches', coalesced(`watches:${e.workspacePath.toLowerCase()}`, () => evaluate(ws).catch((err) => log.warn('checking watches', err))))
    } else if (e.type === 'lanes-changed') {
      const store = [...stores.values()].find((x) => same(x.path, e.workspacePath))
      if (store) laneCheckSoon(store)
      // A lane's end writes no card (an abandoned one): card watches on its cards look again (#1475).
      if (store && store.list.some((r) => !r.fired && r.on)) inBackground('checking watches', coalesced(`watches:${e.workspacePath.toLowerCase()}`, () => evaluate(store.ws).catch((err) => log.warn('checking watches', err))))
    } else if (e.type === 'plan-usage' && e.connection) {
      // An account's usage changed (HI-2195): usage watches on it look.
      for (const store of [...stores.values()]) if (store.list.some((r) => r.usage && !r.fired && r.usage.some((u) => u.account === e.connection))) inBackground('checking usage watches', evaluateUsage(store))
    } else if (e.type === 'session-status') {
      noteAgentStatus(e.state)
      const store = storeFor(e.state.projectPath)
      if (!store) return
      // A stall can come with a status (an agent idle with no watch, one stopped): lane watches look again (#531).
      laneCheckSoon(store)
      // An agent someone watches changed status (#416).
      const { projectPath, agentId } = e.state
      if (store.list.some((x) => x.agents && !x.fired && x.agents.agents.some((a) => same(a.projectPath, projectPath) && a.agentId === agentId)))
        inBackground('checking agent watches', evaluateAgents(store))
      if (!readyFor(e.state)) return
      const rec = store.list.find((x) => x.fired && !x.fired.delivery && same(x.projectPath, projectPath) && x.agentId === agentId)
      if (rec) inBackgroundAfter(500, 'waking an agent', () => deliver(store, rec))
    }
  })
  const timer = setInterval(() => inBackground('watch tick', tick()), 5000)
  timer.unref?.()
}

/** Forgets a workspace's watches in memory, as closing it does (they stay on disk for its next opening): for tests. */
/**
 * Reads a workspace's watches as it opens (#508): each is brought to its projects' folders by their ids, and one saved
 * before ids gets them, saved now (watches.json keeps what it was before beside it, once) rather than at the next change.
 */
export async function stampWatchProjects(ws: WorkspaceService): Promise<void> {
  const store = await load(ws)
  if (store.dirty) await locked(store, () => saveQuietly(store))
}

/** The watches saved before ids (#508) whose folder is no project now, as Repair weighs whose they are: the folder's name and the watcher. */
export async function legacyWatches(ws: WorkspaceService): Promise<{ name: string; agents: string[] }[]> {
  const store = await load(ws)
  const ids = await ws.projectIds()
  return store.list.filter((r) => !r.projectId && !ws.isAssistantHome(r.projectPath) && !ids.byPath.has(resolve(r.projectPath).toLowerCase())).map((r) => ({ name: basename(resolve(r.projectPath)), agents: [r.agentId] }))
}

/**
 * Repair (#508): watches saved before ids in a project's old folder go to the project's folder now, with its id. In the
 * store's lock; one with an id, or in another folder now, is left as it is. Returns how many moved.
 */
export async function moveOrphanWatches(ws: WorkspaceService, m: { from: string; to: string }): Promise<number> {
  const store = await load(ws)
  const ids = await ws.projectIds()
  const to = join(store.path, m.to)
  const projectId = ids.byPath.get(to.toLowerCase())
  if (!projectId) return 0
  const moved = await locked(store, async () => {
    const list = store.list.filter((r) => !r.projectId && !ws.isAssistantHome(r.projectPath) && same(dirname(resolve(r.projectPath)), resolve(store.path)) && same(basename(resolve(r.projectPath)), m.from))
    for (const r of list) {
      if (recordOf(store, to, r.agentId)) {
        store.list = store.list.filter((x) => x !== r)
        continue
      }
      r.projectPath = to
      r.projectId = projectId
      r.scope = scopeFor(ws, to)
    }
    if (list.length) await saveQuietly(store)
    return list
  })
  for (const r of moved) sessions.watchChanged(r.projectPath, r.agentId)
  return moved.length
}

/** For tests: every workspace's watches load under way has finished (those started while waiting too). */
export async function loadsForTests(): Promise<void> {
  while (loading.size) await Promise.allSettled([...loading.values()])
}

export function forgetWatches(ws: WorkspaceService): void {
  if (ws.path && stores.get(ws.path.toLowerCase())?.ws === ws) stores.delete(ws.path.toLowerCase())
}

// The workspace's database replaced (#1207 round 2: the upgrade to 1.0, a restore): its watches, read from the file
// before, go from memory (closed by their generation: a change begun on them is refused). They are read again from it
// by their next use (the replacement's tasks-changed checks them, for a workspace still open), never by this: a
// workspace closed meanwhile isn't opened again (#1207 round 3). Under every spelling of the workspace, by the place each
// store recorded as its load entered (#1456).
onDbReplaced((workspacePath, place) => {
  for (const [k, store] of [...stores]) {
    if (k !== workspacePath.toLowerCase() && store.place !== place) continue
    stores.delete(k)
    for (const d of store.delivering.values()) d.cancelled = true
  }
})

/**
 * The marks of cards now as `scope` sees them (a card outside it reads as gone), for a bounded wait, from the folder that
 * was open when the wait began: `life` aborted (the workspace closed or switched) refuses.
 */
export async function scopedCard(ws: WorkspaceService, path: string, life: AbortSignal, n: number, scope: string | null): Promise<TaskCard | null> {
  const ok = (): void => {
    if (life.aborted || !ws.path || !same(ws.path, path)) throw closedError()
  }
  ok()
  const card = await getTask(n, ws).catch(() => null)
  ok()
  return card && inScope(card, scope) ? card : null
}

export { encodeSince }

/** Checks a workspace's watches against its board now (what a board change does): for tests. */
export const evaluateWatches = (ws: WorkspaceService): Promise<void> => evaluate(ws)
/** Checks a workspace's agent watches now (what a status change does): for tests. */
export const evaluateAgentWatches = async (ws: WorkspaceService): Promise<void> => evaluateAgents(await load(ws))
