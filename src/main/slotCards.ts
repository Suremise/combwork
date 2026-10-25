// Cards on slots (#1438, SPEC §16.10): G11 = slots made real. A card's start under it asks `leaseForStart` for its
// builder's slot (a lane's card: the lane's dispatch lease, lent once and kept for the whole lane, OP-10; any other card:
// its own lease) and records it on its `Started`. What the start then owes is decided from durable state, never from an
// action's run (HR1's #1438 round 1): one pass per project (`settleSlotCards`) reads the card's facts and the slots'
// lease rows and does what is still owed, so a crash anywhere leaves it to the next pass (after a restart, at the
// workspace's opening):
// - **release**: a card's lease its card's current cycle doesn't use (Todo, Done, or another lease), ended in the write
//   that reads the card; a lane's once the lane has ended. With the rules off too (data safety).
// - **prepare**: the card's line `hive/<KEY>/<KEY>-<n>-<slug>` checked out in the slot from the target's head (G15: its
//   dependencies installed again on a changed lock file), once the lease's builder is quiet (not in a turn, nothing
//   typed or queued, no run or background task), as #1429's warming operation on the lent slot, under the folder's fence
//   (#646: nothing typed into or started in it meanwhile) and the repository's lock for the switch; recorded as
//   `SlotPrepared` for the cycle.
// - **place**: the builder given the card there once quiet: claimed by this Hive (`PlacementClaimed`, taken over once
//   its process is gone), delivered once (its delivery's identity is the card's cycle and lease), recorded as
//   `BuilderPlaced`.
// - **delete**: a Done card's merged line (containment by key), under the repository's lock, never one checked out.
// - **waiting lanes**: a lane started from the window with no slot free (`slotWait`, kept with the lane) is lent one and
//   its agents started, once.
// The pass runs when a card's slot action asks (`prepareSlot`, `releaseSlot`), as a workspace opens, when lanes change,
// when a slot's writer drains, when the rules are switched, and hourly. With the rules off (Settings → Advanced, Workflow
// rules are enforced) it only releases: nothing is lent, prepared, placed or deleted, each step checking again after its
// waits.

import { projectAgents } from '../shared/defaults'
import { msg } from '../shared/i18n'
import { taskPrompt } from '../shared/tasks'
import { agentWorkflowRole, buildsWork } from '../shared/workflow/roles'
import { workflowText } from '../shared/workflow/texts'
import type { Fact, FactData, StartedData, StageId } from '../shared/workflow/facts'
import { SLOTS_DELETE_MERGED, SLOTS_RENAME_ADOPTED } from '../shared/advanced'
import { basename } from 'path'
import type { AgentDef, LaneSlotInfo } from '../shared/types'
import type { LaneRecord } from '../shared/lanes'
import { app } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { advanced } from './advanced'
import { exitBy } from './exitLog'
import { legacyWorktree, rebindSession } from './agentFolders'
import { boardRead } from './boardStore'
import { deliveriesOf, deliverNow, launchWith } from './deliveries'
import { onHiveEvent } from './events'
import { changingFolder } from './folderFence'
import { samePlace } from './fsutil'
import { git } from './git'
import { lanesWaitingForSlot, onLanesWritten, rawLanes, setLaneSlots, setLaneSlotWait } from './lanes'
import { createLogger, userText } from './logger'
import * as G from './platform/git'
import { isUnknown } from './platform/types'
import { withRepoLock } from './repoLock'
import { sessions } from './sessions'
import { holder, poolFor, setSlotFreed } from './slotsApp'
import { quiet as quietFolder, refusalText, setBuilderCount, type Slot, type SlotLease, type SlotPool } from './slots'
import { carriedOf, keptFor, keptGoing } from './slotMigration'
import { getTask } from './tasks'
import { onAction } from './workflow/actionWorker'
import { agentBusy } from './workflow/lineUpdates'
import type { CardRecord } from './workflow/factStore'
import type { SlotForStart, Workflow } from './workflow/runtime'
import { agentRunsGoing, setSlotStarts, workflowEnforced, workflowFor, ENFORCE } from './workflow/service'
import { listWorktreesOrNull } from './worktrees'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

const log = createLogger('slots')

const M = {
  notPrepared: msg({ id: 'service.slots.notPrepared', defaultMessage: "Hive couldn't get {slot} ready for {card}: {why}", description: "A notice: a card was started in a slot (a worktree Hive lends to a card or a lane), and Hive couldn't check out the card's branch there or install its dependencies. {slot} is the slot's name (slot-b), {card} the card's key, {why} git's or the setup's reason, in English." })
}

/** What a placement's delivery is made from: its identity is the card's cycle and lease, so it is made once. */
const PLACEMENT = 'slot-placement'
/** How long a Done card's merged line is looked for after its lease ended. */
const DELETE_WITHIN_MS = 14 * 24 * 60 * 60 * 1000
/**
 * A card's lease lent for a start that hasn't written its `Started` yet: left this long by the pass (a start refused gives
 * it back at once, `slotUnused`; one cut short by a crash is given back after this).
 */
const START_GRACE_MS = 2 * 60 * 1000
/** Stages in which a started card keeps its slot (put back: Todo; Done: released). On Hold keeps it too. */
const KEEPS: ReadonlySet<StageId> = new Set<StageId>(['active', 'review', 'approved', 'merging', 'hold'])

/**
 * Test copies (unpackaged) only: `HIVE_TEST_SLOT_CRASH=<point>` ends Hive at once there, no quit handler run, so a suite
 * shows what the next start recovers (HR1's #1438 rounds 1 and 2): `afterAction` (a slot action marked done, nothing of
 * it done), `inPrepare` (the line checked out, `SlotPrepared` not written), `inPlacement` (claimed, nothing delivered),
 * `inDeletion` (a merged line's ref removed, nothing checked or recorded after it).
 */
function crashAt(point: 'afterAction' | 'inPrepare' | 'inPlacement' | 'inDeletion'): Promise<never> | null {
  if (app.isPackaged || process.env.HIVE_TEST_SLOT_CRASH !== point) return null
  exitBy('app.exit', `a test crash at a slot's ${point}`, () => app.exit(1)) // i18n-ignore: the exit log's reason
  return new Promise<never>(() => undefined)
}

/** The project folder of a card on a workspace's board, by its board name; null for none. */
function projectOfCard(ws: WorkspaceService, card: number): string | null {
  const name = boardRead(ws, (db) => (db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string } | undefined)?.project) // i18n-ignore: SQL
  if (!name) return null
  return ws.info()?.projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.path ?? null
}

/** Whether an agent builds (G11's slots are its builders'): a builder or either, never a reviewer. */
const builds = (a: AgentDef | undefined): a is AgentDef => !!a && buildsWork(agentWorkflowRole(a))

// --- A card's cycle, from its facts.

/** A card's current cycle in a slot: its last `Started` (with a lease), and what was done for it since. */
interface Cycle {
  seq: number
  started: StartedData & { lease: string; slot: string }
  prepared: FactData['SlotPrepared'] | null
  claimed: (FactData['PlacementClaimed'] & { seq: number }) | null
  placed: boolean
  deleted: boolean
  /** A deletion of its line begun and not settled (a crash cut it short): settled by the next pass. */
  deleting: FactData['LineDeleting'] | null
}

export function cycleIn(facts: readonly Fact[]): Cycle | null {
  let at = -1
  for (let i = facts.length - 1; i >= 0; i--) {
    if (facts[i].kind === 'Started') {
      at = i
      break
    }
  }
  if (at < 0) return null
  const started = facts[at].data as StartedData
  if (!started.lease || !started.slot) return null
  const c: Cycle = { seq: facts[at].seq, started: started as Cycle['started'], prepared: null, claimed: null, placed: false, deleted: false, deleting: null }
  for (const f of facts.slice(at + 1)) {
    if (f.kind === 'SlotPrepared' && (f.data as FactData['SlotPrepared']).lease === started.lease) c.prepared = f.data as FactData['SlotPrepared']
    else if (f.kind === 'PlacementClaimed' && (f.data as FactData['PlacementClaimed']).lease === started.lease) c.claimed = { ...(f.data as FactData['PlacementClaimed']), seq: f.seq }
    else if (f.kind === 'BuilderPlaced' && (f.data as FactData['BuilderPlaced']).lease === started.lease) c.placed = true
    else if (f.kind === 'LineDeleting') c.deleting = f.data as FactData['LineDeleting']
    else if (f.kind === 'LineDeleteUndone') c.deleting = null
    else if (f.kind === 'LineDeleted') {
      c.deleted = true
      c.deleting = null
    }
  }
  return c
}

/** The kinds a deletion's intent and its settling are recorded as. */
const DELETION_KINDS = ['LineDeleting', 'LineDeleted', 'LineDeleteUndone'] as const

/**
 * Deletions begun and not settled, from facts in the order written (a card's, or a project's of DELETION_KINDS): a
 * `LineDeleting` with no `LineDeleted` or `LineDeleteUndone` of its card and line after it, whatever cycle the card is in
 * now or how long ago it began (HR1's #1438 round 3: an unfinished destructive effect stays found).
 */
export function unsettledDeletions(facts: readonly Fact[]): { card: number; d: FactData['LineDeleting'] }[] {
  const open = new Map<string, { card: number; d: FactData['LineDeleting'] }>()
  for (const f of facts) {
    if (!(DELETION_KINDS as readonly string[]).includes(f.kind)) continue
    const d = f.data as FactData['LineDeleting']
    const key = `${f.card}\n${d.line}`
    if (f.kind === 'LineDeleting') open.set(key, { card: f.card, d: { line: d.line, revision: d.revision } })
    else open.delete(key)
  }
  return [...open.values()]
}

function cardOf(wf: Workflow, n: number): CardRecord | null {
  try {
    return wf.store.card(n)
  } catch {
    return null
  }
}

/** The card's cycle now, and whether it is still the one `seq` names with that lease, at a stage that builds. */
function current(wf: Workflow, n: number, seq: number, lease: string): { card: CardRecord; cycle: Cycle; stage: StageId } | null {
  const card = cardOf(wf, n)
  if (!card) return null
  const cycle = cycleIn(wf.store.facts(n))
  const stage = wf.state(card).stage
  return cycle && cycle.seq === seq && cycle.started.lease === lease && stage === 'active' ? { card, cycle, stage } : null
}

// --- Starts.

/**
 * The lease a card's start uses (#1438, SPEC §16.10.2), for its builder: a lane's card, the lane's (lent now if the lane
 * has none yet, and kept for the whole lane); any other card, its own (the one it has, or lent now). None free: why it
 * waits, in English. `dry`: only whether one could be (nothing lent). Null where slots don't apply: the rules off, or
 * the builder a reviewer (a carried slot, #1441, extends this).
 */
export async function leaseForStart(ws: WorkspaceService, projectPath: string, card: Pick<CardRecord, 'id' | 'lane'>, builder: string, o: { dry: boolean; target: string | null }): Promise<SlotForStart> {
  if (!workflowEnforced()) return null
  const agents = projectAgents(await ws.projectConfig(projectPath))
  const agent = agents.find((a) => a.id === builder)
  if (!builds(agent)) return null
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  const pool = await poolFor(ws, projectPath)
  const lane = card.lane ?? null
  const held = lane ? pool.leaseOf({ lane }) : pool.leaseOf({ card: card.id })
  if (held && held.agent === builder) {
    const at = leaseAt(pool, held)
    if (at) return at
  }
  if (held) return { wait: refusalText({ why: 'inUse', slot: held.slot, agent: held.agent, card: held.card, lane: held.lane }, name) } // i18n-ignore: a refusal's code, agent-facing English (refusalText)
  // The builder's own slot (#1441: its carried lease, kept for nothing now) taken over when it can be; else the card gets
  // another slot, and the carried one stays protected.
  const own = await carriedToHand(ws, projectPath, pool, builder, o.target)
  if (own) {
    if (o.dry) return { slot: own.slot.name, folder: own.slot.folder, lease: '', fresh: false }
    const handed = await handOffCarried(ws, projectPath, pool, own, lane ? { lane, agent: builder } : { card: card.id, agent: builder }, name(builder))
    if (handed) return leaseAt(pool, handed)
  }
  if (o.dry) return couldLend(pool, projectPath, builder)
  const r = await pool.lend(lane ? { lane, agent: builder } : { card: card.id, agent: builder }, { ...(o.target ? { target: o.target } : {}), install: false })
  if (!r.ok) return { wait: refusalText(r.refusal, name) }
  log.info(`Lent ${userText(r.slot.name)} to ${userText(name(builder))} for ${lane ? `lane ${lane}` : `#${card.id}`} (lease ${r.lease.id})`)
  return leaseAt(pool, r.lease)
}

/**
 * A builder's own slot a start or a lane can take over (#1441): its carried lease (its adopted worktree, or a slot its
 * Resume took) kept for nothing now, the slot clean and its head in the target (merged). Null: none, or not now.
 */
async function carriedToHand(ws: WorkspaceService, projectPath: string, pool: SlotPool, builder: string, target: string | null): Promise<{ carried: SlotLease; slot: Slot } | null> {
  const carried = pool.leasesOf(builder).find((l) => l.kind === 'carried')
  if (!carried || keptFor(ws, carried.id)) return null
  const slot = pool.slotOf(carried)
  return slot && (await cleanAndContained(projectPath, slot.folder, target)) ? { carried, slot } : null
}

/**
 * The handover (#1441): in one write, the carried lease ended (`handedOff`), the card's or lane's lease begun on the same
 * slot, and its conversations rebound to it (#1434's rebindSession: only the binding changes), so the agent's
 * conversation goes on there. Null when it couldn't be (the slot or lease changed meanwhile): the caller lends another.
 */
async function handOffCarried(ws: WorkspaceService, projectPath: string, pool: SlotPool, own: { carried: SlotLease; slot: Slot }, req: { card?: number; lane?: string; agent: string }, agentName: string): Promise<SlotLease | null> {
  const host = (await ws.sessionScope(projectPath)).scope
  const id = (await ws.projectConfig(projectPath)).id ?? basename(projectPath)
  const handed = await pool
    .handOff(own.carried.id, req, (db, lease) => {
      const bound = db.prepare('SELECT id FROM sessions WHERE host = ? AND lease = ?').all(host, own.carried.id) as { id: string }[] // i18n-ignore: SQL
      for (const b of bound) rebindSession(db, host, id, b.id, lease.id)
    })
    .catch((e) => (log.warn(`handing ${userText(agentName)}'s slot ${userText(own.slot.name)} over`, e), null))
  if (handed) log.info(`${userText(agentName)}'s slot ${userText(own.slot.name)} handed over to ${req.lane ? `lane ${req.lane}` : `#${req.card}`} (lease ${handed.id})`)
  return handed
}

/** Whether an adopted slot can be taken over by a start: no changes not committed, and its head in the target (merged). */
async function cleanAndContained(projectPath: string, folder: string, target: string | null): Promise<boolean> {
  const d = await G.dirty(folder)
  if (isUnknown(d) || d.length) return false
  const head = await G.head(folder)
  const t = target ?? (await G.defaultBranch(projectPath))
  if (isUnknown(head) || isUnknown(t) || !t) return false
  const th = await G.lineHead(projectPath, t)
  if (isUnknown(th) || !th) return false
  if (head === th) return true
  const inIt = await G.isAncestor(projectPath, head, th)
  return !isUnknown(inIt) && inIt
}

/** A lease where a start can use it: its slot and folder (fresh: a card's own, given back if the start isn't written). */
function leaseAt(pool: SlotPool, l: SlotLease): SlotForStart {
  const s = pool.slotOf(l)
  return s ? { slot: s.name, folder: s.folder, lease: l.id, fresh: l.kind === 'card' } : null
}

/** Whether a lend could be made now, nothing lent (a dry start: the window's Start asking first). */
async function couldLend(pool: SlotPool, projectPath: string, builder: string): Promise<SlotForStart> {
  const mine = pool.leasesOf(builder).find((l) => l.kind !== 'carried')
  if (mine) return { wait: refusalText({ why: 'agentLeased', slot: mine.slot, card: mine.card, lane: mine.lane }) } // i18n-ignore: a refusal's code, agent-facing English (refusalText)
  const slots = pool.slots()
  const size = await pool.size()
  const free = slots.some((s) => s.state === 'ready' && !s.op && !s.job && !s.writer && !s.warmError && !pool.openLease(s.name))
  return free || slots.length < size ? { slot: '', folder: projectPath, lease: '', fresh: false } : { wait: refusalText({ why: 'noSlot', size }) } // i18n-ignore: a refusal's code, agent-facing English (refusalText)
}

/** A card's lease lent for a start that wasn't written: given back, decided in the write that ends it. */
async function slotUnused(ws: WorkspaceService, projectPath: string, lease: string): Promise<void> {
  const pool = await poolFor(ws, projectPath)
  const l = pool.lease(lease)
  if (!l || l.to || l.kind !== 'card' || l.card === null) return
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  if (await pool.release(lease, 'notStarted', () => !wf || !uses(wf, l))) void settleSlotCards(ws, projectPath)
}

/** Whether any start of the card was written with the lease (one not yet: a start still on its way, given its grace). */
function startedWith(wf: Workflow, l: SlotLease): boolean {
  return l.card !== null && !!cardOf(wf, l.card) && wf.store.facts(l.card).some((f) => f.kind === 'Started' && (f.data as StartedData).lease === l.id)
}

/** Whether a card's current cycle uses a lease of its own (started with it, at a stage that keeps it). */
function uses(wf: Workflow, l: SlotLease): boolean {
  const card = l.card !== null ? cardOf(wf, l.card) : null
  if (!card) return false
  const s = wf.state(card)
  return s.started?.lease === l.id && KEEPS.has(s.stage)
}

// --- The window's Start hands its prompt to the placement.

/** Window Starts handing their card's prompt to the slot's placement (startTask), by project and card. */
const offered = new Map<string, { prompt: string | null; ready: Promise<void> }>()
const offerKey = (projectPath: string, n: number): string => `${projectPath.toLowerCase()}#${n}`

/**
 * A window Start of a card that may start in a slot (taskStart.ts): its prompt (with the user's note and the card's
 * Read first) is given to the slot's placement rather than typed where the agent is now. Call before the card moves;
 * the returned function gives the prompt, or null when the Start didn't go through (the card's own prompt is used then).
 */
export function expectStartPrompt(projectPath: string, n: number): (prompt: string | null) => void {
  const key = offerKey(projectPath, n)
  let given = false
  let res!: () => void
  const entry = { prompt: null as string | null, ready: new Promise<void>((r) => (res = r)) }
  offered.set(key, entry)
  return (p) => {
    if (given) return
    given = true
    entry.prompt = p
    res()
    // Kept until the placement has read it, or a while (a card that didn't start in a slot has none).
    setTimeout(() => offered.get(key) === entry && offered.delete(key), 60_000).unref?.()
  }
}

/** The slot a card was started in (its latest start's), or null: a card outside slots, or not started. */
export async function startedSlot(ws: WorkspaceService, projectPath: string, n: number): Promise<{ slot: string; lease: string } | null> {
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  const card = wf ? cardOf(wf, n) : null
  if (!wf || !card) return null
  const s = wf.state(card)
  return s.stage !== 'todo' && s.started?.lease && s.started.slot ? { slot: s.started.slot, lease: s.started.lease } : null
}

// --- Quiet builders.

/** Whether an agent is quiet: not running, or running with no turn, nothing typed or queued, no run or background task. */
function quiet(projectPath: string, agentId: string): boolean {
  const now = sessions.agentNow(projectPath, agentId)
  if (!now) return true
  return !agentBusy(projectPath, agentId) && now.status !== 'starting' && now.backgroundTasks === 0 && agentRunsGoing(projectPath, agentId).length === 0
}

/**
 * Resolves once `ok()` holds or `over()` does, looked at again at each change of the agent's status, of the Progress
 * panel's runs, and of the slots; and every half minute in case a change went unseen. True: ok.
 */
function until(projectPath: string, agentId: string, ok: () => boolean, over: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const look = (): void => {
      if (settled) return
      if (over()) return finish(false)
      if (ok()) finish(true)
    }
    const off = onHiveEvent((e) => {
      if ((e.type === 'session-status' && e.state.agentId === agentId && e.state.projectPath.toLowerCase() === projectPath.toLowerCase()) || e.type === 'progress-changed') look()
    })
    const timer = setInterval(look, 30_000)
    timer.unref?.()
    const finish = (v: boolean): void => {
      settled = true
      off()
      clearInterval(timer)
      resolve(v)
    }
    look()
  })
}

// --- The pass.

/** Each project's pass, one at a time in this Hive (another asked while one runs: once more after it). */
const passes = new Map<string, { again: boolean; done: Promise<void> }>()
/** Cycles being prepared or placed here now (`<project>#<card>#<seq>`): one at a time each. */
const ensuring = new Set<string>()
/** Failed tries of a cycle's step here, by key: each next one waits longer. */
const attempts = new Map<string, number>()
/** Cycles whose preparation failed here (told once): tried again only by a restart or a new start. */
const failed = new Set<string>()
/**
 * Hive is quitting (`quitSlotCards`, #1628): no pass starts or goes on to its next step, no cycle is prepared or placed,
 * and what one owed is the next start's pass (its workspace opening), as after a crash.
 */
let quitting = false

/** Nothing more is done for `ws` here: Hive is quitting, or the workspace closed or switched. */
const ended = (ws: WorkspaceService): boolean => quitting || ws.lifetime.aborted

/** A step that failed: a warning, but for one cut short by Hive quitting (its boards closed under it), the next start's. */
function failedStep(what: string, e: unknown): void {
  if (quitting) log.info(`${what}: cut short by quitting (the next start does it)`)
  else log.warn(what, e)
}

/** Asks for a project's pass (coalesced): resolves when no pass of it runs. Never throws. */
export function settleSlotCards(ws: WorkspaceService, projectPath: string): Promise<void> {
  if (quitting) return Promise.resolve()
  const key = `${(ws.path ?? '').toLowerCase()}\n${projectPath.toLowerCase()}`
  const running = passes.get(key)
  if (running) {
    running.again = true
    return running.done
  }
  const pass = { again: false, done: Promise.resolve() }
  pass.done = (async () => {
    try {
      do {
        pass.again = false
        await settleOnce(ws, projectPath).catch((e) => failedStep(`settling the slots of ${userText(projectPath)}`, e)) // i18n-ignore: a log line (failedStep logs it)
      } while (pass.again && !ended(ws))
    } finally {
      passes.delete(key)
    }
  })()
  passes.set(key, pass)
  return pass.done
}

/** Projects whose pass waits for Repair (their folders moved): said once in the log. */
const waitingForRepair = new Set<string>()

async function settleOnce(ws: WorkspaceService, projectPath: string): Promise<void> {
  if (!ws.path || ended(ws)) return
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  if (!wf) return
  const pool = await poolFor(ws, projectPath)
  if (pool.closed) return
  // The workspace or project moved and Repair hasn't run yet (#1447): its slots' recorded folders are the old ones, so
  // nothing is prepared, placed, deleted, renamed or released until Repair has relinked them (its FolderMoved facts and
  // the board's change ask for the next pass).
  if (await wf.cfg.movePending?.()) {
    if (!waitingForRepair.has(projectPath.toLowerCase())) log.info(`${userText(basename(projectPath))}'s slots wait for Repair a Moved Workspace`)
    waitingForRepair.add(projectPath.toLowerCase())
    return
  }
  waitingForRepair.delete(projectPath.toLowerCase())
  // 0. Deletions begun and cut short (a crash between the ref's removal and its settling): settled first, as data safety,
  //    whatever the switches say and wherever the card is now: one may have left a checkout without its branch.
  // Each step and each lease's turn begins only while Hive isn't quitting (#1628): one cut short is the next start's.
  for (const { card: n, d } of unsettledDeletions(wf.store.factsOfKind([...DELETION_KINDS]))) {
    if (ended(ws)) return
    const card = cardOf(wf, n)
    if (card) await withRepoLock(projectPath, () => settleDeletion(projectPath, wf, card, n, d), { quiet: true, project: projectPath }).catch((e) => failedStep(`settling #${n}'s begun deletion of ${userText(d.line)}`, e)) // i18n-ignore: a log line (failedStep logs it)
  }
  // 0b. Renames of adopted slots cut short (#1441): their holders gone, finished or given up by the pool.
  if (ended(ws)) return
  await settleRenames(pool)
  if (ended(ws)) return
  const lanes = new Map((await rawLanes(ws)).map((l) => [l.id, l]))
  // 1. Releases, rules on or off: a card's lease its current cycle doesn't use, a lane's whose lane has ended.
  for (const l of pool.openLeases()) {
    if (ended(ws)) return
    if (l.kind === 'card' && l.card !== null) {
      if (uses(wf, l) || (Date.now() - Date.parse(l.from) < START_GRACE_MS && !startedWith(wf, l))) continue
      const stage = cardOf(wf, l.card) ? wf.state(cardOf(wf, l.card)!).stage : null
      if (await pool.release(l.id, stage === 'done' ? 'done' : 'putBack', () => !uses(wf, l))) log.info(`#${l.card}'s lease ${l.id} on ${userText(l.slot)} ended (${stage ?? 'gone'})`)
    } else if (l.kind === 'lane' && l.lane) {
      const lane = lanes.get(l.lane)
      const over = (): boolean => {
        const now = lanes.get(l.lane!)
        return !now || now.state !== 'active'
      }
      if (!over()) continue
      if (await pool.release(l.id, lane?.state === 'abandoned' ? 'laneAbandoned' : 'laneEnded', over)) log.info(`Lane ${l.lane} ended: its lease ${l.id} on ${userText(l.slot)} ended`)
    } else if (l.kind === 'carried') {
      // An adopted worktree (#1441) kept for the lane or card in flight at the upgrade: released once that has ended (its
      // lane over, its card Done or put back). One kept for nothing stays (a handoff, or the user, ends it).
      const kept = keptFor(ws, l.id)
      if (!kept) continue
      const over = (): boolean => {
        if ('lane' in kept) return lanes.get(kept.lane)?.state !== 'active'
        const c = cardOf(wf, kept.card)
        const st = c ? wf.state(c).stage : null
        return st === null || st === 'done' || st === 'todo'
      }
      if (!over()) continue
      if (await pool.release(l.id, 'lane' in kept ? 'laneEnded' : 'cardEnded', over)) log.info(`The adopted ${userText(l.slot)}'s carried lease ${l.id} ended with ${'lane' in kept ? `lane ${kept.lane}` : `#${kept.card}`}`)
    }
  }
  if (!workflowEnforced() || ended(ws)) return
  // 2. Each current cycle in a lease: prepared, then its builder placed.
  for (const l of pool.openLeases()) {
    const cards = l.kind === 'card' && l.card !== null ? [l.card] : l.kind === 'lane' && l.lane ? (lanes.get(l.lane)?.cards ?? []) : []
    for (const n of cards) {
      const card = cardOf(wf, n)
      const cycle = card ? cycleIn(wf.store.facts(n)) : null
      if (!card || !cycle || cycle.started.lease !== l.id || wf.state(card).stage !== 'active') continue
      if (cycle.prepared && cycle.placed) continue
      void ensure(ws, projectPath, wf, pool, n, cycle, l)
    }
  }
  // 3. Done cards' merged lines, from leases still open or ended within DELETE_WITHIN_MS.
  if (advanced.get(SLOTS_DELETE_MERGED) !== false) {
    const since = new Date(Date.now() - DELETE_WITHIN_MS).toISOString()
    const done = new Set<number>()
    for (const l of [...pool.openLeases(), ...pool.endedSince(since)]) {
      const cards = l.kind === 'card' && l.card !== null ? [l.card] : l.kind === 'lane' && l.lane ? (lanes.get(l.lane)?.cards ?? []) : []
      for (const n of cards) {
        const card = cardOf(wf, n)
        const c = card ? cycleIn(wf.store.facts(n)) : null
        if (card && c && c.started.lease === l.id && !c.deleted && wf.state(card).stage === 'done') done.add(n)
      }
    }
    for (const n of done) {
      if (ended(ws)) return
      await deleteMergedLine(ws, projectPath, wf, n).catch((e) => failedStep(`deleting #${n}'s merged line`, e)) // i18n-ignore: a log line (failedStep logs it)
    }
  }
  // 4. Lanes started from the window waiting for a slot.
  if (ended(ws)) return
  await startWaitingLanes(ws, projectPath, pool)
  // 5. Adopted slots, once free, renamed to generic names (#1441).
  if (ended(ws)) return
  await renameAdopted(ws, projectPath, pool)
}

/** A cycle's preparation and placement, one at a time each. */
async function ensure(ws: WorkspaceService, projectPath: string, wf: Workflow, pool: SlotPool, n: number, cycle: Cycle, l: SlotLease): Promise<void> {
  const key = `${projectPath.toLowerCase()}#${n}#${cycle.seq}`
  if (ensuring.has(key) || failed.has(key)) return
  ensuring.add(key)
  let retry = false
  try {
    const prepared = cycle.prepared ?? (await prepare(ws, projectPath, wf, pool, n, cycle, l, key))
    if (!prepared) return
    if (!cycle.placed) await place(ws, projectPath, wf, n, cycle, l)
  } catch (e) {
    failedStep(`#${n}'s slot ${userText(l.slot)}`, e) // i18n-ignore: a log line (failedStep logs it)
    // Its workspace opened again meanwhile (another lifetime's runtime), a write refused, a delivery not given or a launch
    // that failed: another pass once this ends, after a pause that grows with each try (1 s, doubling, at most a minute).
    retry = !ended(ws) && !!ws.path
  } finally {
    ensuring.delete(key)
    if (retry) {
      const tries = (attempts.get(key) ?? 0) + 1
      attempts.set(key, tries)
      setTimeout(() => void settleSlotCards(ws, projectPath), Math.min(60_000, 1000 * 2 ** (tries - 1))).unref?.()
    } else attempts.delete(key)
  }
}

/** The cycle's line made in its slot once its builder is quiet, and `SlotPrepared` written; null: not now, or not possible. */
async function prepare(ws: WorkspaceService, projectPath: string, first: Workflow, pool: SlotPool, n: number, cycle: Cycle, l: SlotLease, key: string): Promise<FactData['SlotPrepared'] | null> {
  // The workspace's runtime as it is after each wait (it opened again meanwhile: a new lifetime's).
  let wf = first
  const st = cycle.started
  const builder = l.agent
  const gone = (): boolean => !workflowEnforced() || ended(ws) || !current(wf, n, cycle.seq, l.id) || !!pool.lease(l.id)?.to
  for (;;) {
    if (!(await until(projectPath, builder, () => quiet(projectPath, builder), gone))) return null
    wf = (await workflowFor(ws, projectPath).catch(() => null)) ?? wf
    const card = current(wf, n, cycle.seq, l.id)
    if (!card) return null
    const install = wf.rulesetOf(card.card, wf.state(card.card)).options.slotsUpToDate
    const r = await changingFolder(st.folder, 'preparing a slot', () => // i18n-ignore: what fences the folder, for the log
      pool.prepare(l.id, {
        line: st.line!,
        base: st.base!,
        install,
        // At the boundary: the card still this cycle's, the rules on, its builder quiet.
        ready: async () => (gone() ? 'the card moved on, or the rules are off' : quiet(projectPath, builder) ? null : 'its builder is busy'), // i18n-ignore: why a preparation waits, for the log
        around: (fn) => withRepoLock(projectPath, fn, { quiet: true, project: projectPath })
      })
    )
    if ('ok' in r) {
      await crashAt('inPrepare')
      const fact: FactData['SlotPrepared'] = { lease: l.id, line: st.line!, revision: r.revision }
      await wf.write(card.card, null, 'hive', (w) => {
        const now = cycleIn(w.tx.facts(n))
        if (now?.seq === cycle.seq && now.started.lease === l.id && !now.prepared) w.fact('SlotPrepared', fact) // i18n-ignore: a fact's kind and codes, not text
      })
      // A line the slot was on before (the lane's last card's) may go now that nothing has it out.
      void settleSlotCards(ws, projectPath)
      return fact
    }
    if ('error' in r) {
      failed.add(key)
      log.warn(`Slot ${userText(st.slot)} couldn't be prepared for #${n}: ${userText(r.error)}`)
      await wf.write(card.card, null, 'hive', (w) => {
        const english = `Hive couldn't get ${st.slot} ready for ${card.card.key}: ${r.error}` // i18n-ignore: agent-facing, and the notice's English
        w.action('notify', { text: english, shown: workflowText(M.notPrepared, { slot: st.slot, card: card.card.key, why: r.error }) })
        wf.wake(w, st.builder, english)
      })
      return null
    }
    // Not now (busy, not quiet at the boundary): looked at again at the next change.
    log.info(`Slot ${userText(st.slot)} for #${n}: not yet (${userText(r.retry)})`)
    await new Promise((res) => setTimeout(res, 2000))
  }
}

/** A delivery that ended without reaching its agent (never given): made again. */
const NOT_GIVEN: ReadonlySet<string> = new Set(['cancelled', 'refused', 'expired', 'stale'])

/**
 * The builder given the card in its slot, once: when quiet, claimed by this Hive in a write (one another Hive holds is
 * left to it unless its process is gone), delivered with the cycle's identity, recorded as `BuilderPlaced`. A delivery
 * made before (a crash, an earlier pass) counts only while it was given or is still on its way under the deliveries' own
 * policy (queued, offered, or uncertain: offered once more when its agent runs, never made again here): its agent not
 * running, it is started in the slot, where that delivery is offered. One that ended without being given (cancelled,
 * refused, expired, stale) is made again, as is one whose making failed (a refusal, a launch that couldn't start: it
 * throws, nothing is recorded, and the pass tries again).
 */
export async function place(ws: WorkspaceService, projectPath: string, first: Workflow, n: number, cycle: Cycle, l: SlotLease): Promise<void> {
  let wf = first
  const agentId = l.agent
  const gone = (): boolean => !workflowEnforced() || ended(ws) || !current(wf, n, cycle.seq, l.id)
  const offer = offered.get(offerKey(projectPath, n))
  if (offer) await offer.ready
  if (!(await until(projectPath, agentId, () => quiet(projectPath, agentId), gone))) return
  wf = (await workflowFor(ws, projectPath).catch(() => null)) ?? wf
  const now = current(wf, n, cycle.seq, l.id)
  if (!now || now.cycle.placed) return
  const me = await holder.self()
  const claim = now.cycle.claimed
  const mine = !!claim && claim.pid === me.pid && claim.started === me.started
  if (claim && !mine && (await holder.alive(claim.pid, claim.started)) !== false) return
  const took = await wf.write(now.card, null, 'hive', (w) => {
    const c = cycleIn(w.tx.facts(n))
    if (!c || c.seq !== cycle.seq || c.placed || (c.claimed?.seq ?? null) !== (claim?.seq ?? null)) return false
    if (!mine) w.fact('PlacementClaimed', { lease: l.id, pid: me.pid, started: me.started }) // i18n-ignore: a fact's kind and codes, not text
    return true
  })
  if (!took) return
  await crashAt('inPlacement')
  const agent = projectAgents(await ws.projectConfig(projectPath)).find((a) => a.id === agentId)
  const card = await getTask(n, ws).catch(() => null)
  if (!agent || !card) return
  wf = (await workflowFor(ws, projectPath).catch(() => null)) ?? wf
  const ref = `${n}:${cycle.seq}:${l.id}`
  const made = (await deliveriesOf(projectPath, agentId)).find((r) => r.source === PLACEMENT && r.ref === ref && !NOT_GIVEN.has(r.state))
  if (gone() || !quiet(projectPath, agentId)) return
  const st = sessions.liveFor(projectPath, agentId)
  const there = !!st && samePlace(st.cwd, cycle.started.folder)
  let how: FactData['BuilderPlaced']['how'] = there ? 'typed' : st ? 'newConversation' : 'started'
  let delivery: string | null
  if (made) {
    delivery = made.id
    // On its way, its agent not running: started in its slot (no prompt of its own), where the delivery is offered.
    if (!st && (made.state === 'queued' || made.state === 'offered' || made.state === 'uncertain')) {
      log.info(`Starting ${userText(agent.name)} in ${userText(cycle.started.slot)} for #${n}'s delivery ${made.id} (${made.state})`)
      await sessions.start(projectPath, { agentId })
      how = 'started'
    }
  } else {
    const prompt = (offer && offered.get(offerKey(projectPath, n)) === offer ? offer.prompt : null) ?? taskPrompt(card, !!sessions.hiveMcp(projectPath), { from: 'todo' })
    const nd = { agentId, agentName: agent.name, kind: 'task' as const, from: { kind: 'hive' as const, name: 'Hive' }, card: n, body: prompt, source: PLACEMENT, ref } // i18n-ignore: who a delivery is from, as agents read it
    log.info(`Giving ${userText(agent.name)} #${n} in ${userText(cycle.started.slot)} (${how})`)
    // A refusal (NotGiven: its agent got busy) or a launch that couldn't start throws: nothing recorded, tried again.
    const r = there
      ? await deliverNow(projectPath, { ...nd, need: 'free', conversation: st!.sessionId || null })
      : (await launchWith(projectPath, nd, (line) => (st ? sessions.newConversation(projectPath, agentId, line) : sessions.start(projectPath, { agentId, prompt: line })))).record
    if (!r || NOT_GIVEN.has(r.state)) throw new Error(`#${n}'s delivery to ${agent.name} wasn't given (${r?.state ?? 'none made'})`) // i18n-ignore: an error for the log (the pass tries again)
    delivery = r.id
    offered.delete(offerKey(projectPath, n))
  }
  await wf.write(now.card, null, 'hive', (w) => {
    const c = cycleIn(w.tx.facts(n))
    if (c?.seq === cycle.seq && !c.placed) w.fact('BuilderPlaced', { lease: l.id, delivery, how }) // i18n-ignore: a fact's kind and codes, not text
  })
}

// --- Merged lines.

/**
 * A Done card's line deleted (#1438, §16.10.1), by the card (never a number read from the line's name): only with the
 * rules on and Settings → Advanced, Delete a card's branch once it's merged; only once its target contains it (a squash
 * by its stored key, §16.3.2); under the repository's lock; never one checked out. Its intent is written first
 * (`LineDeleting`, with the head checked), then the ref removed at that head, then the deletion settled from what is on
 * disk (`settleDeletion`), so one cut short by a crash is settled by the next pass, rules on or off: never a checkout
 * left without its branch.
 */
export async function deleteMergedLine(ws: WorkspaceService, projectPath: string, wf: Workflow, n: number): Promise<boolean> {
  const allowed = (): boolean => workflowEnforced() && advanced.get(SLOTS_DELETE_MERGED) !== false
  const card = cardOf(wf, n)
  if (!card) return false
  // A deletion begun and cut short: settled first, whatever the switches say (it may have left a checkout without its branch).
  const begun = unsettledDeletions(wf.store.facts(n))[0]?.d
  if (begun) return withRepoLock(projectPath, () => settleDeletion(projectPath, wf, card, n, begun), { quiet: true, project: projectPath }).catch(() => false)
  const s = wf.state(card)
  const c = cycleIn(wf.store.facts(n))
  if (!c || s.stage !== 'done' || c.deleted || !s.started?.line?.startsWith('hive/')) return false
  if (!allowed()) return false
  const line = s.started.line
  const target = s.integrated?.target || s.started.target
  if (!target) return false
  return withRepoLock(
    projectPath,
    async () => {
      if (!allowed()) return false
      const head = await G.lineHead(projectPath, line)
      if (isUnknown(head) || !head) return false
      const inTarget = await wf.platformOf(card).contains(target, { base: s.started!.base ?? head, revision: head, key: s.latest?.key ?? null })
      if (isUnknown(inTarget) || !inTarget) return false
      const before = await listWorktreesOrNull(projectPath).catch(() => null)
      if (!before || before.some((w) => w.branch === line) || !allowed()) return false
      // The intent, durably, before anything is removed: from here a crash is settled by the next pass.
      const intent: FactData['LineDeleting'] = { line, revision: head }
      const meant = await wf.write(card, null, 'hive', (w) => {
        const now = cycleIn(w.tx.facts(n))
        if (!now || now.seq !== c.seq || now.deleted || unsettledDeletions(w.tx.facts(n)).length) return false
        w.fact('LineDeleting', intent) // i18n-ignore: a fact's kind and codes, not text
        return true
      })
      if (!meant) return false
      const r = await git(projectPath, ['update-ref', '-d', `refs/heads/${line}`, head])
      if (r.ok) await crashAt('inDeletion')
      return settleDeletion(projectPath, wf, card, n, intent)
    },
    { quiet: true, project: projectPath }
  ).catch(() => false)
}

/**
 * A begun deletion settled from what is on disk now, under the repository's lock (the caller's): its ref there (never
 * removed, or put back) is `LineDeleteUndone` (`notDeleted`; a later pass may try again); gone with a worktree that has it
 * checked out (one came in as it went, or since) has the ref put back at the head the intent recorded, checked, and
 * `LineDeleteUndone` (`checkedOut`); gone with none, `LineDeleted`. A ref that can't be put back, or worktrees that can't
 * be read, leave the intent for the next pass: nothing is claimed kept that isn't.
 */
async function settleDeletion(projectPath: string, wf: Workflow, card: CardRecord, n: number, d: FactData['LineDeleting']): Promise<boolean> {
  const head = await G.lineHead(projectPath, d.line)
  if (isUnknown(head)) return false
  if (head) {
    await wf.write(card, null, 'hive', (w) => {
      if (unsettledDeletions(w.tx.facts(n)).some((x) => x.d.line === d.line)) w.fact('LineDeleteUndone', { ...d, why: 'notDeleted' }) // i18n-ignore: a fact's kind and codes, not text
    })
    return false
  }
  const trees = await listWorktreesOrNull(projectPath).catch(() => null)
  if (!trees) return false
  if (trees.some((w) => w.branch === d.line)) {
    // Checked out as it went (another Hive, a terminal): put back at the head the intent recorded, and checked.
    const r = await git(projectPath, ['update-ref', `refs/heads/${d.line}`, d.revision, ''])
    const back = await G.lineHead(projectPath, d.line)
    if (!r.ok || isUnknown(back) || back !== d.revision) {
      log.warn(`${userText(d.line)} is checked out but its branch couldn't be put back at ${d.revision.slice(0, 7)}: tried again at the next pass`)
      return false
    }
    log.warn(`${userText(d.line)} was checked out as it was deleted: put back at ${d.revision.slice(0, 7)} and kept`)
    await wf.write(card, null, 'hive', (w) => {
      if (unsettledDeletions(w.tx.facts(n)).some((x) => x.d.line === d.line)) w.fact('LineDeleteUndone', { ...d, why: 'checkedOut' }) // i18n-ignore: a fact's kind and codes, not text
    })
    return false
  }
  log.info(`Deleted ${userText(d.line)} (#${n}, merged)`)
  await wf.write(card, null, 'hive', (w) => {
    if (unsettledDeletions(w.tx.facts(n)).some((x) => x.d.line === d.line)) w.fact('LineDeleted', { line: d.line, revision: d.revision, why: 'merged' }) // i18n-ignore: a fact's kind and codes, not text
  })
  return true
}

// --- Adopted slots renamed (#1441).

/** A slot's generic name (`slot-a`): adopted ones keep their folder's (`hb2`) until renamed. */
const GENERIC = /^slot-[a-z]+$/

/**
 * Free adopted slots renamed to the next generic name (#1441) by the pool's rename operation (`SlotPool.rename`: its
 * destination reserved in the write that takes the slot, Repair's steps, its end in one fenced write), only with the
 * rules on and Settings → Advanced, Rename adopted worktrees to slot names; a slot with no lease, operation, job or
 * writer, ready, with no session running there, and nothing else in it (the rename probe).
 */
export async function renameAdopted(ws: WorkspaceService, projectPath: string, pool: SlotPool): Promise<void> {
  const allowed = (): boolean => workflowEnforced() && advanced.get(SLOTS_RENAME_ADOPTED) !== false
  if (!allowed()) return
  for (const s of pool.slots()) {
    if (GENERIC.test(s.name) || s.state !== 'ready' || s.op || s.job || s.writer || pool.openLease(s.name)) continue
    if (sessions.liveStates().some((x) => x.cwd && samePlace(x.cwd, s.folder))) continue
    if (!(await quietFolder(s.folder)) || !allowed()) continue
    const to = await pool.rename(s.name, allowed)
    if (to) log.info(`The adopted ${userText(s.name)} is now ${userText(to)}`)
  }
}

/**
 * Renames cut short (#1441): each is its operation's, so only `refresh` takes one over, once its holder is gone, and
 * finishes or gives it up (`SlotPool.recover`); a live one is left to its holder. An intent no operation owns is cleared.
 */
export async function settleRenames(pool: SlotPool): Promise<void> {
  if (!pool.renames().length) return
  await pool.refresh()
  await pool.clearOrphanRenames()
}

// --- Lanes.

/**
 * A lane's slot (#1438, §16.10.2), lent to its builder as Start Lane… starts it, before its agents start, and kept for the
 * whole lane: the slot, or why none is free (English). With none free the caller records the lane's wait (`slotWait`).
 */
export async function lendLane(ws: WorkspaceService, projectPath: string, lane: string, builder: string, target: string | null): Promise<{ slot: string } | { waiting: string }> {
  const pool = await poolFor(ws, projectPath)
  const agents = projectAgents(await ws.projectConfig(projectPath))
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  // The builder's own slot, taken over by the lane when it can be (#1441), as a card's start does.
  const own = await carriedToHand(ws, projectPath, pool, builder, target)
  const handed = own ? await handOffCarried(ws, projectPath, pool, own, { lane, agent: builder }, name(builder)) : null
  if (handed) return { slot: handed.slot }
  // Lent with the lane's target (#1627), so the slot records where its lines merge.
  const r = await pool.lend({ lane, agent: builder }, { ...(target ? { target } : {}), install: false })
  if (r.ok) {
    log.info(`Lent ${userText(r.slot.name)} to lane ${lane} (lease ${r.lease.id})`)
    return { slot: r.slot.name }
  }
  return { waiting: refusalText(r.refusal, name) }
}

/**
 * A project's lanes waiting for a slot (`slotWait`), in the order they began waiting: each lent one while one is free,
 * its agents (its builder and reviewer now) started once (laneStart's, by their brief's delivery identity), then its
 * wait cleared. Only with the rules on; a lane ended or abandoned meanwhile isn't running, so it is never started.
 */
async function startWaitingLanes(ws: WorkspaceService, projectPath: string, pool: SlotPool): Promise<void> {
  const name = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.name
  const waiting = (await lanesWaitingForSlot(ws)).filter((l) => l.project.toLowerCase() === name?.toLowerCase()).sort((a, b) => a.slotWait!.since.localeCompare(b.slotWait!.since))
  // The rules off, or Hive quitting (#1628): looked at again after each await, nothing more lent or started.
  const stopped = (): boolean => !workflowEnforced() || ended(ws)
  for (const lane of waiting) {
    if (stopped()) return
    let lease = pool.leaseOf({ lane: lane.id })
    if (!lease) {
      // The builder's own slot first (#1441), checked against the default branch (the lane's target isn't known here).
      const own = await carriedToHand(ws, projectPath, pool, lane.builder.id, null)
      if (stopped()) return
      lease = own ? await handOffCarried(ws, projectPath, pool, own, { lane: lane.id, agent: lane.builder.id }, lane.builder.name) : null
    }
    if (stopped()) return
    if (!lease) {
      const r = await pool.lend({ lane: lane.id, agent: lane.builder.id }, { install: false })
      if (!r.ok) return
      lease = r.lease
      log.info(`Lent ${userText(r.slot.name)} to lane ${lane.id}, which waited for a slot (lease ${r.lease.id})`)
    }
    // Hive quitting once a slot is lent (#1628): the lane keeps it and keeps waiting; the next start's pass starts it.
    if (stopped()) return
    const { startWaitingLane } = await import('./laneStart')
    const started = await startWaitingLane(ws, projectPath, lane.id, lease.slot, stopped).catch((e) => (failedStep(`starting lane ${lane.id} in ${userText(lease!.slot)}`, e), false)) // i18n-ignore: a log line (failedStep logs it)
    if (started && !stopped()) await setLaneSlotWait(ws, lane.id, null)
  }
}

/** The slot a lane works in now (its open lease's): for the lane's view (lanes.ts). */
function laneSlot(ws: WorkspaceService, lane: LaneRecord): LaneSlotInfo | null {
  try {
    // The lane's project as its slots name it (slotsApp's poolFor: its id, else its folder name). Agents' ids are a
    // project's own (copied configs can share one), so only this project's leases count (HR3's #1446 round 1).
    const path = ws.info()?.projects.find((p) => p.name.toLowerCase() === lane.project.toLowerCase())?.path
    const project = (path ? ws.projectIdsNow().byPath.get(path.toLowerCase()) : undefined) ?? lane.project
    return boardRead(ws, (db) => laneSlotIn(db, project, lane))
  } catch {
    // A board still 0.9's: no slots.
    return null
  }
}

/**
 * A running lane's slot in hive.db (#1446): of `project`'s leases only (its slots' project id), the lane's own, else its
 * builder's carried one (#1441: a 0.9 worktree adopted at the upgrade); none of the project's: null.
 */
export function laneSlotIn(db: DatabaseSync, project: string, lane: Pick<LaneRecord, 'id' | 'builder'>): LaneSlotInfo | null {
  const l = db
    .prepare("SELECT l.id, l.slot, l.kind, l.from_at AS since, s.state, s.op_kind AS op FROM slot_leases l JOIN slots s ON s.project = l.project AND s.name = l.slot WHERE l.ended_at IS NULL AND l.project = ? AND (l.lane = ? OR (l.kind = 'carried' AND l.agent = ?)) ORDER BY l.kind = 'carried' LIMIT 1") // i18n-ignore: SQL
    .get(project, lane.id, lane.builder.id) as { id: string; slot: string; kind: string; since: string; state: string; op: string | null } | undefined
  if (!l) return null
  // The current card's line there: the last card started under this lease.
  const line = (db.prepare("SELECT json_extract(data, '$.line') AS line FROM card_facts WHERE kind = 'Started' AND json_extract(data, '$.lease') = ? ORDER BY at DESC LIMIT 1").get(l.id) as { line: string | null } | undefined)?.line ?? null // i18n-ignore: SQL
  return { name: l.slot, carried: l.kind === 'carried', line, state: l.state === 'creating' || l.op === 'warm' ? 'preparing' : 'ready', since: l.since }
}

/**
 * After #1441's migration, the stand-in (#1438 item 7): an agent's adopted worktree (its open carried lease's slot) is
 * its cards' folder, on its own branch, while the lane or card that lease is kept for goes on. Otherwise none.
 */
async function standIn(ws: WorkspaceService, projectPath: string, agentId: string): Promise<{ path: string; base: string | null } | null> {
  const cfg = await ws.projectConfig(projectPath)
  const c = carriedOf(ws, cfg.id ?? basename(projectPath), agentId)
  if (!c) return null
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  const stage = (n: number): string | null => {
    const card = wf ? cardOf(wf, n) : null
    return card && wf ? wf.state(card).stage : null
  }
  if (!(await keptGoing(ws, keptFor(ws, c.lease), stage))) return null
  return { path: c.folder, base: legacyWorktree(projectAgents(cfg).find((a) => a.id === agentId))?.base ?? null }
}

// --- What asks for a pass.

/** Every open workspace's projects with slots or lanes waiting for one: their passes. */
async function settleAll(): Promise<void> {
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    const paths = new Set<string>()
    try {
      const ids = boardRead(ws, (db) => (db.prepare('SELECT DISTINCT project FROM slots').all() as { project: string }[]).map((r) => r.project)) // i18n-ignore: SQL
      for (const id of ids) {
        const p = ws.projectIdsNow().byId.get(id)
        if (p) paths.add(p)
      }
    } catch {
      // A board still 0.9's (no slot tables), or none open.
    }
    for (const l of await lanesWaitingForSlot(ws).catch(() => [])) {
      const p = ws.info()?.projects.find((x) => x.name.toLowerCase() === l.project.toLowerCase())?.path
      if (p) paths.add(p)
    }
    for (const p of paths) await settleSlotCards(ws, p)
  }
}

let stop: (() => void) | null = null

/** Starts cards on slots (index.ts, once): the actions, the passes and what asks for them, the lanes' view of their slot. */
export function startSlotCards(): void {
  if (stop) return
  quitting = false
  // A card's slot action asks for its project's pass: the pass, not the action's run, does what is owed.
  const ask = (n: number, ws: WorkspaceService): void => {
    if (crashAt('afterAction')) return
    const p = projectOfCard(ws, n)
    if (p) void settleSlotCards(ws, p)
  }
  onAction('prepareSlot', (a, ws) => ask(a.card, ws))
  onAction('releaseSlot', (a, ws) => ask(a.card, ws))
  setSlotStarts({ leaseFor: (ws, project, card, builder, o) => leaseForStart(ws, project, card, builder, o), unused: slotUnused, standIn })
  // The pool's size: the project's builders (#1430's roles: builders and either), at least one (slots.ts).
  setBuilderCount(async (projectPath) => {
    const ws = workspaceFor(projectPath)
    return ws ? projectAgents(await ws.projectConfig(projectPath)).filter(builds).length : 0
  })
  setLaneSlots(laneSlot)
  setSlotFreed((ws, project) => void settleSlotCards(ws, project))
  const offLanes = onLanesWritten(() => void settleAll().catch((e) => log.warn("settling the lanes' slots", e)))
  // A workspace opening (Hive's start, a restart after a crash): what its cards are owed is done.
  const seen = new WeakSet<AbortSignal>()
  const offOpen = onHiveEvent((e) => {
    if (e.type !== 'workspace-changed') return
    for (const ws of openWorkspaces()) {
      if (!ws.path || seen.has(ws.lifetime)) continue
      seen.add(ws.lifetime)
      void settleAll().catch((x) => log.warn('settling the slots of a workspace', x))
    }
  })
  let enforced = workflowEnforced()
  const offAdvanced = advanced.onChange(() => {
    if (workflowEnforced() === enforced) return
    enforced = workflowEnforced()
    void settleAll().catch((e) => log.warn(`settling the slots (${ENFORCE})`, e))
  })
  // A board change (a card put back or Done outside the rules writes no slot action): its leases looked at, at most once
  // a second per workspace.
  let boardSoon: NodeJS.Timeout | null = null
  const offBoard = onHiveEvent((e) => {
    if (e.type !== 'tasks-changed' || boardSoon) return
    boardSoon = setTimeout(() => {
      boardSoon = null
      void settleAll().catch((x) => log.warn('settling the slots after a board change', x))
    }, 1000)
    boardSoon.unref?.()
  })
  const hourly = setInterval(() => void settleAll().catch((e) => log.warn('settling the slots', e)), 60 * 60 * 1000)
  hourly.unref?.()
  stop = () => {
    offLanes()
    offOpen()
    offAdvanced()
    offBoard()
    if (boardSoon) clearTimeout(boardSoon)
    clearInterval(hourly)
    setLaneSlots(null)
    setSlotFreed(null)
    setSlotStarts(null)
    setBuilderCount(null)
  }
}

export function stopSlotCards(): void {
  stop?.()
  stop = null
}

/**
 * Hive quitting (index.ts quitNow, before its sessions stop, #1628): nothing asks for a pass any more and none starts, a
 * pass running ends at its next step, and this resolves once each has ended or after `withinMs`, before the boards close
 * (will-quit). No cycle is prepared or placed (no builder started) as the sessions stop; what a pass didn't get to is the
 * next start's pass, which settles every workspace as it opens. Never throws.
 */
export async function quitSlotCards(withinMs = 5000): Promise<void> {
  quitting = true
  stopSlotCards()
  const running = [...passes.values()].map((p) => p.done)
  if (!running.length) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([Promise.allSettled(running), new Promise<void>((r) => (timer = setTimeout(r, withinMs)))])
  clearTimeout(timer)
}
