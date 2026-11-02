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
import { taskPrompt } from '../shared/tasks'
import { agentWorkflowRole, buildsWork, takesCards } from '../shared/workflow/roles'
import { SLOT_NOTICES, workflowText } from '../shared/workflow/texts'
import { SLOT_DIRTY_GATE, type Fact, type FactData, type StartedData, type StageId } from '../shared/workflow/facts'
import { SLOTS_DELETE_MERGED, SLOTS_RENAME_ADOPTED } from '../shared/advanced'
import { basename } from 'path'
import type { AgentDef, LaneSlotInfo, LiveSessionState } from '../shared/types'
import type { ResumeHold } from '../shared/agentFolders'
import type { LaneRecord } from '../shared/lanes'
import { app } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { advanced } from './advanced'
import { exitBy } from './exitLog'
import { legacyWorktree, rebindSession, slotHeldWords, slotsMigrated } from './agentFolders'
import { boardRead } from './boardStore'
import { deliveriesOf, deliverNow, launchWith } from './deliveries'
import { onHiveEvent } from './events'
import { onLineFreed, whyNoLine } from './lineWriter'
import { changingFolder, folderChanging, folderSteady } from './folderFence'
import { samePlace } from './fsutil'
import { samePath } from '../shared/movePaths'
import { git } from './git'
import { lanesWaitingForSlot, onLanesWritten, rawLanes, setLaneSlots, setLaneSlotWait } from './lanes'
import { createLogger, userText } from './logger'
import * as G from './platform/git'
import { observer } from './platform/observe'
import { isUnknown } from './platform/types'
import { withRepoLock } from './repoLock'
import { isResuming, onResumeEntry } from './restartResume'
import { sessions } from './sessions'
import { startBegun, startEnded, startWaits } from './agentStarts'
import { holder, poolFor, setSlotFreed } from './slotsApp'
import { quiet as quietFolder, refusalText, setBuilderCount, type Slot, type SlotLease, type SlotPool } from './slots'
import { carriedOf, keptFor, keptGoing } from './slotMigration'
import { getTask } from './tasks'
import { HiveError } from './hiveError'
import { onAction } from './workflow/actionWorker'
import { agentBusy } from './workflow/lineUpdates'
import { withoutWriteFence, type CardRecord } from './workflow/factStore'
import type { SlotForStart, Workflow } from './workflow/runtime'
import { agentRunsGoing, setSlotStarts, workflowEnforced, workflowFor, ENFORCE } from './workflow/service'
import { listWorktreesOrNull } from './worktrees'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'
import { teamPauseOf } from './teamPause'
import { cardAttachments } from './cardAttachments'
import { briefOf } from './laneBriefs'

const log = createLogger('slots')

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
export function projectOfCard(ws: WorkspaceService, card: number): string | null {
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
    // Repair's move and a line's rename, as the card's state follows them (facts.ts, #1343, #1305; HI-1791: a preparation
    // after Repair fenced the folder from before the move).
    else if (f.kind === 'FolderMoved') {
      const d = f.data as FactData['FolderMoved']
      if (samePath(c.started.folder, d.from)) c.started = { ...c.started, folder: d.to }
    } else if (f.kind === 'LineRenamed') {
      const d = f.data as FactData['LineRenamed']
      if (c.started.line && c.started.line.toLowerCase() === d.from.toLowerCase()) c.started = { ...c.started, line: d.to }
    } else if (f.kind === 'LineDeleting') c.deleting = f.data as FactData['LineDeleting']
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
 * the builder a reviewer (a carried slot, #1441, extends this). However it got its slot, a real start records its
 * target on it then, by the lease chosen (startServes).
 */
export async function leaseForStart(ws: WorkspaceService, projectPath: string, card: Pick<CardRecord, 'id' | 'lane'>, builder: string, o: { dry: boolean; target: string | null }): Promise<SlotForStart> {
  const r = await slotForStart(ws, projectPath, card, builder, o)
  if (o.dry || !r || !('lease' in r)) return r
  const lost = await startServes(ws, projectPath, r.lease, builder, o.target)
  return lost ? { wait: lost } : r
}

/**
 * The slot a start chose serves its target (HI-2185, SlotPool.serves): every way a card's or lane's start gets its slot
 * (lent, lent again, handed over, taken over, already held) passes here, with the lease it chose, so a released slot
 * waits detached at the head of the line its last card worked to. No target: the slot keeps its own. Null when
 * recorded; why the start waits when that lease ended or changed hands meanwhile (agent-facing).
 */
async function startServes(ws: WorkspaceService, projectPath: string, lease: string, builder: string, target: string | null): Promise<string | null> {
  if (!target) return null
  const pool = await poolFor(ws, projectPath)
  if (await pool.serves(lease, builder, target)) return null
  log.info(`lease ${lease} ended before its start recorded its target ${userText(target)}`)
  return `its slot's lease ${lease} ended while the start took it: the start tries again` // i18n-ignore: agent-facing, a start's wait
}

async function slotForStart(ws: WorkspaceService, projectPath: string, card: Pick<CardRecord, 'id' | 'lane'>, builder: string, o: { dry: boolean; target: string | null }): Promise<SlotForStart> {
  if (!workflowEnforced()) return null
  const agents = projectAgents(await ws.projectConfig(projectPath))
  const agent = agents.find((a) => a.id === builder)
  // Any agent that takes cards (a generalist too, HI-686: never counted in the pool's size, but its card is built where
  // the project's options say).
  if (!agent || !takesCards(agentWorkflowRole(agent))) return null
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
  // The slot its own run still writes in, its lease ended (HI-1762): taken over too, or waited for, never a second slot.
  const written = await startOnWritten(ws, projectPath, pool, builder, lane ? { lane, agent: builder } : { card: card.id, agent: builder }, name(builder), o.dry)
  if ('wait' in written) return { wait: written.wait }
  if ('dry' in written) return { slot: written.dry.name, folder: written.dry.folder, lease: '', fresh: false }
  if ('lease' in written) return leaseAt(pool, written.lease)
  if (o.dry) return couldLend(pool, projectPath, builder)
  const r = await pool.lend(lane ? { lane, agent: builder } : { card: card.id, agent: builder }, { ...(o.target ? { target: o.target } : {}), install: false })
  if (!r.ok) return { wait: refusalText(r.refusal, name) }
  log.info(`Lent ${userText(r.slot.name)} to ${userText(name(builder))} for ${lane ? `lane ${lane}` : `#${card.id}`} (lease ${r.lease.id})`)
  // Its carried lease kept for a card it has left ends now that this start holds its own (HI-1731).
  await endLeftCarriedNow(ws, projectPath, pool, builder, lane ? { lane } : { card: card.id }, r.lease.id)
  return leaseAt(pool, r.lease)
}

/**
 * A builder's carried lease kept for another card it has left (HI-1731: HB3's, kept for a card stuck in Approved, held its
 * old folder while it worked other lanes), ended (`superseded`) once a start of its holds a lease of its own (`holding`,
 * just lent): never before, so a start refused or failed ends nothing, and the builder's run in the old folder is never
 * left without a lease (stopLeaseSession: it now holds that one). That card no longer Active, the folder with no changes
 * not committed (unknown or dirty keeps it), its checkout (line and commit) read then; then, in the pool's write, all of it
 * again: the carried lease still open and still kept for that card, the card still not Active, `holding` still open, and
 * the slot still the same one (its name, folder and making, no operation or job on it: Hive's own line changes run as
 * one) with the same checkout, read again from its ref files (HR4: anything changed keeps it). A refusal changes
 * nothing. The card's work is on its line, which stays; back in Active, its start lends it a slot on that line as for any
 * card. The slot isn't reused or removed while the builder's run still writes there (a slot with a writer isn't free);
 * it drains once that run has moved, then retires as any free slot does. A slot its Resume took, kept for nothing, that
 * the start couldn't take over just then (HI-1741) ends the same way, with every check but the card's, once it can be
 * left (`leavable`). Whether it ended, or why not: `busy` (an operation or job on the slot, which the pass's retry waits
 * out), `kept` (anything else).
 */
async function endLeftCarried(ws: WorkspaceService, projectPath: string, pool: SlotPool, builder: string, starting: { card: number } | { lane: string }, holding: string): Promise<'ended' | 'busy' | 'kept'> {
  const carried = pool.leasesOf(builder).find((l) => l.kind === 'carried')
  if (!carried) return 'kept'
  const kept = keptFor(ws, carried.id)
  // A slot its Resume took, kept for nothing, that the start couldn't take over (HI-1741: busy, or changed, just then):
  // ended the same way, its line staying. An adopted worktree kept for nothing stays (its branch is on no card's line).
  const resumed = !kept && pool.resumedCarry(carried)
  if (!resumed && (!kept || !('card' in kept) || ('card' in starting && kept.card === starting.card))) return 'kept'
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  const slot = pool.slotOf(carried)
  if (!wf || !slot) return 'kept'
  if (slot.op || slot.job) return 'busy'
  const left = (): boolean => {
    if (!kept || !('card' in kept)) return true
    const c = cardOf(wf, kept.card)
    return !c || wf.state(c).stage !== 'active'
  }
  if (!left()) return 'kept'
  let checkout: Checkout | null
  if (resumed) checkout = await leavable(projectPath, slot.folder, slot.target)
  else {
    const d = await G.dirty(slot.folder)
    checkout = isUnknown(d) || d.length ? null : G.headSync(slot.folder)
  }
  if (!checkout) return 'kept'
  const was = checkout
  const still = (): boolean => {
    const k = keptFor(ws, carried.id)
    const now = pool.slotOf(carried)
    const same = resumed ? !k : !!k && 'card' in k && !!kept && 'card' in kept && k.card === kept.card
    if (!same || !left() || !pool.leasesOf(builder).some((l) => l.id === holding)) return false
    if (!now || now.name !== slot.name || !samePlace(now.folder, slot.folder) || now.createdAt !== slot.createdAt || now.op || now.job) return false
    return sameCheckout(now.folder, was)
  }
  const why = kept && 'card' in kept ? `its builder left #${kept.card}` : 'its builder, who resumed there,' // i18n-ignore: a log line
  if (await pool.release(carried.id, 'superseded', still)) {
    log.info(`${userText(slot.name)}'s carried lease ${carried.id} ended: ${why} moved on to ${'card' in starting ? `#${starting.card}` : `lane ${starting.lane}`} (lease ${holding})`)
    return 'ended'
  }
  const now = pool.slotOf(carried)
  return now && (now.op || now.job) && !pool.lease(carried.id)?.to ? 'busy' : 'kept'
}

/**
 * Carried leases whose retirement waits for an operation or job on their slot to settle (HI-1741), by project: the pass
 * looked at again after a pause that grows with each try (1 s, doubling, at most a minute), as `ensure` retries, until
 * it isn't busy any more. One pass waits at a time per project; it goes with the workspace's lifetime (closed or opened
 * again: dropped, and the opening's own pass looks again).
 */
interface Retry {
  tries: number
  timer: ReturnType<typeof setTimeout> | null
  /** Its workspace's lifetime, and what drops the retry when it ends. */
  life: AbortSignal
  drop: () => void
}
const retiring = new Map<string, Retry>()
const retireKey = (ws: WorkspaceService, projectPath: string): string => `${(ws.path ?? '').toLowerCase()}\n${projectPath.toLowerCase()}`

/** A retirement found busy: another pass asked for after its pause, unless one already waits. */
function retireLater(ws: WorkspaceService, projectPath: string): void {
  if (ended(ws)) return
  const key = retireKey(ws, projectPath)
  let r = retiring.get(key)
  if (r && r.life !== ws.lifetime) forget(key, r)
  r = retiring.get(key)
  if (!r) {
    const made: Retry = { tries: 0, timer: null, life: ws.lifetime, drop: () => forget(key, made) }
    made.life.addEventListener('abort', made.drop, { once: true })
    retiring.set(key, made)
    r = made
  }
  if (r.timer) return
  const life = r.life
  r.tries++
  const at = r
  r.timer = setTimeout(() => {
    at.timer = null
    if (!life.aborted) void settleSlotCards(ws, projectPath)
  }, Math.min(60_000, 1000 * 2 ** (r.tries - 1)))
  r.timer.unref?.()
}

/** A retry forgotten: its pass no longer waits, nor its lifetime's listener. */
function forget(key: string, r: Retry): void {
  if (r.timer) clearTimeout(r.timer)
  r.timer = null
  r.life.removeEventListener('abort', r.drop)
  if (retiring.get(key) === r) retiring.delete(key)
}

/** A project's retirement retry as it stands (tests), by its workspace's folder: its tries and whether a pass waits; null: none. */
export function retireWaitOf(wsPath: string, projectPath: string): { tries: number; waiting: boolean } | null {
  const r = retiring.get(`${wsPath.toLowerCase()}\n${projectPath.toLowerCase()}`)
  return r ? { tries: r.tries, waiting: !!r.timer } : null
}

/** No retirement busy any more (the pass found none): its tries forgotten, a pass still waiting left to run. */
function retiredNow(ws: WorkspaceService, projectPath: string): void {
  const key = retireKey(ws, projectPath)
  const r = retiring.get(key)
  if (r && !r.timer) forget(key, r)
}

/** A start's end of its builder's left carried lease (endLeftCarried), its retry asked for when the slot was busy. */
async function endLeftCarriedNow(ws: WorkspaceService, projectPath: string, pool: SlotPool, builder: string, starting: { card: number } | { lane: string }, holding: string): Promise<void> {
  if ((await endLeftCarried(ws, projectPath, pool, builder, starting, holding)) === 'busy') retireLater(ws, projectPath)
}

/** A slot's checkout as a handover or a retirement decided on it (headSync's): its line (null: detached) and commit. */
type Checkout = NonNullable<ReturnType<typeof G.headSync>>

/**
 * A builder's own slot a start or a lane can take over (#1441): its carried lease (its adopted worktree, or a slot its
 * Resume took) kept for nothing now, the slot clean and its head in the target (merged), with its checkout as decided
 * on (checked again in the handover's write). A slot its Resume took may also be left with its head not merged while a
 * branch holds it (HI-1741: HB3's, on a line still in review, was left carried and unused while its lane was lent a
 * second slot, and another builder found none free): `leavable`. Null: none, or not now.
 */
async function carriedToHand(ws: WorkspaceService, projectPath: string, pool: SlotPool, builder: string, target: string | null): Promise<{ carried: SlotLease; slot: Slot; checkout: Checkout | null } | null> {
  const carried = pool.leasesOf(builder).find((l) => l.kind === 'carried')
  if (!carried || keptFor(ws, carried.id)) return null
  const slot = pool.slotOf(carried)
  if (!slot) return null
  if (pool.resumedCarry(carried)) {
    const checkout = await leavable(projectPath, slot.folder, target)
    return checkout ? { carried, slot, checkout } : null
  }
  if (!(await cleanAndContained(projectPath, slot.folder, target))) return null
  return { carried, slot, checkout: G.headSync(slot.folder) }
}

/**
 * Whether a slot its agent's Resume took can be left (handed to another line, or freed) without losing work (HI-1741):
 * no changes not committed, and its head either in the target or held by the branch it is on (a ref Hive keeps: a line
 * is deleted only once its card is Done and merged, never while checked out). Detached and not merged, a HEAD naming a
 * ref that is gone, or anything unknown: null (kept). Its checkout as decided on, otherwise.
 */
async function leavable(projectPath: string, folder: string, target: string | null): Promise<Checkout | null> {
  const d = await G.dirty(folder)
  if (isUnknown(d) || d.length) return null
  const checkout = G.headSync(folder)
  if (!checkout) return null
  if (checkout.line) return checkout
  return (await cleanAndContained(projectPath, folder, target)) ? checkout : null
}

/** Whether a slot's checkout is still the one decided on (read again from its ref files; unknown: no). */
function sameCheckout(folder: string, was: Checkout): boolean {
  const now = G.headSync(folder)
  return !!now && now.line === was.line && now.head === was.head
}

/**
 * The handover (#1441): in one write, the carried lease ended (`handedOff`), the card's or lane's lease begun on the same
 * slot, and its conversations rebound to it (#1434's rebindSession: only the binding changes), so the agent's
 * conversation goes on there. Null when it couldn't be (the slot or lease changed meanwhile): the caller lends another.
 * In the write, the slot is still the one decided on (its folder and making) with the same checkout (HI-1741).
 */
async function handOffCarried(ws: WorkspaceService, projectPath: string, pool: SlotPool, own: { carried: SlotLease; slot: Slot; checkout: Checkout | null }, req: { card?: number; lane?: string; agent: string }, agentName: string): Promise<SlotLease | null> {
  const host = (await ws.sessionScope(projectPath)).scope
  const id = (await ws.projectConfig(projectPath)).id ?? basename(projectPath)
  const still = (s: Slot): boolean => samePlace(s.folder, own.slot.folder) && s.createdAt === own.slot.createdAt && (!own.checkout || sameCheckout(s.folder, own.checkout))
  const handed = await pool
    .handOff(
      own.carried.id,
      req,
      (db, lease) => {
        const bound = db.prepare('SELECT id FROM sessions WHERE host = ? AND lease = ?').all(host, own.carried.id) as { id: string }[] // i18n-ignore: SQL
        for (const b of bound) rebindSession(db, host, id, b.id, lease.id)
      },
      still
    )
    .catch((e) => (log.warn(`handing ${userText(agentName)}'s slot ${userText(own.slot.name)} over`, e), null))
  if (handed) log.info(`${userText(agentName)}'s slot ${userText(own.slot.name)} handed over to ${req.lane ? `lane ${req.lane}` : `#${req.card}`} (lease ${handed.id})`)
  return handed
}

/** The slot a builder's run now writes in with no open lease (HI-1762), as the pool has it: none, null. */
function writtenSlotOf(projectPath: string, pool: SlotPool, builder: string): Slot | null {
  const run = sessions.runNow(projectPath, builder)?.run
  return (run && pool.slots().find((s) => s.writer?.agent === builder && s.writer.run === run && !pool.openLease(s.name))) || null
}

/**
 * The slot a builder's own run still writes in with no open lease (HI-1762: its lane's lease ended, the gentle end
 * waiting for its turn, while its next lane's start came), taken over by that start: the lease
 * begins on it, its writer moves to it (the old lease's end no longer owns the run, so it ends nothing), and the run's
 * conversations bound to the old lease are rebound to it, so they resume there (SlotStore.takeWrittenSlot). Null: none,
 * or not now (the caller lends another). The slot is then prepared on the new line as any lent slot is, once the
 * builder is quiet.
 */
/**
 * What a start does about the slot its builder's own run still writes in (HI-1762), keeping one agent to one slot:
 * `none` (there is none: lend as before), `lease` (taken over), `dry` (a dry start: it would be this one), or `wait`
 * (there is one, but it can't be taken over now: an operation or job on it, not ready, held by another Hive's run, or
 * it changed while it was taken; looked at again once): the start waits for it, never lent a second slot meanwhile. A
 * dry start and a real one ask the takeover's own conditions (SlotPool.writtenNotTakeable, HI-1787), so they agree.
 */
async function startOnWritten(ws: WorkspaceService, projectPath: string, pool: SlotPool, builder: string, req: { card?: number; lane?: string; agent: string }, agentName: string, dry = false): Promise<{ none: true } | { lease: SlotLease } | { dry: Slot } | { wait: string }> {
  const waitFor = (s: Slot, because: string): { wait: string } => ({ wait: `${agentName}'s own slot ${s.name}, its run still there, ${because}: this start waits for it rather than take a second slot` }) // i18n-ignore: agent-facing, a start's wait
  for (let tries = 0; tries < 2; tries++) {
    const slot = writtenSlotOf(projectPath, pool, builder)
    if (!slot) return { none: true }
    // The takeover's own conditions, read (HI-1787): a dry start never advertises what the real one would refuse.
    const busy = await pool.writtenNotTakeable(slot.name, builder, slot.writer!.run)
    if (busy) return waitFor(slot, busy)
    if (dry) return { dry: slot }
    const taken = await takeWritten(ws, projectPath, pool, builder, req, agentName)
    if (taken) return { lease: taken }
  }
  const still = writtenSlotOf(projectPath, pool, builder)
  return still ? waitFor(still, 'changed while it was taken over') : { none: true } // i18n-ignore: agent-facing, a start's wait
}

async function takeWritten(ws: WorkspaceService, projectPath: string, pool: SlotPool, builder: string, req: { card?: number; lane?: string; agent: string }, agentName: string): Promise<SlotLease | null> {
  const slot = writtenSlotOf(projectPath, pool, builder)
  const run = slot?.writer?.run
  if (!slot || !run) return null
  const host = (await ws.sessionScope(projectPath)).scope
  const id = (await ws.projectConfig(projectPath)).id ?? basename(projectPath)
  const taken = await pool
    .takeWrittenSlot(slot.name, req, run, (db, lease, was) => {
      const bound = db.prepare('SELECT id FROM sessions WHERE host = ? AND lease = ?').all(host, was) as { id: string }[] // i18n-ignore: SQL
      for (const b of bound) rebindSession(db, host, id, b.id, lease.id)
    })
    .catch((e) => (log.warn(`taking ${userText(agentName)}'s slot ${userText(slot.name)} over`, e), null))
  if (taken) log.info(`${userText(agentName)}'s own slot ${userText(slot.name)}, its run still there, taken over by ${req.lane ? `lane ${req.lane}` : `#${req.card}`} (lease ${taken.id})`)
  return taken
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

/**
 * The slot whose placement will give the card to its builder (its current cycle in a slot, active and not placed yet),
 * or null: a card outside slots, not started, or already placed. A card back from Review or Approved for more work keeps
 * its placed cycle (no new start is written), so nothing would deliver a prompt offered for it (HI-1953).
 */
export async function placementDue(ws: WorkspaceService, projectPath: string, n: number): Promise<{ slot: string; lease: string } | null> {
  // With the rules off nothing is placed.
  if (!workflowEnforced()) return null
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  const card = wf ? cardOf(wf, n) : null
  if (!wf || !card) return null
  const cycle = cycleIn(wf.store.facts(n))
  return cycle && !cycle.placed && wf.state(card).stage === 'active' ? { slot: cycle.started.slot, lease: cycle.started.lease } : null
}

/**
 * Whether a card's current start was written outside the slots of a project that builds its cards in them (HI-1966): the
 * rules enforced, the card Active, its last start with no lease, under a ruleset that builds in slots, and its folder
 * neither a slot (a carried one stands in for one, #1441) nor its builder's own 0.9 worktree not migrated yet (#1434).
 * startTask undoes such a start rather than launch its builder in the project folder. False when it can't be told.
 */
export async function startedOutsideSlots(ws: WorkspaceService, projectPath: string, n: number): Promise<boolean> {
  if (!workflowEnforced()) return false
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  const card = wf ? cardOf(wf, n) : null
  if (!wf || !card) return false
  const s = wf.state(card)
  const started = s.started
  if (s.stage !== 'active' || !started || started.lease || wf.rulesetOf(card, s).options.folder !== 'slots') return false
  const folder = started.folder
  if (folder !== 'project' && !samePlace(folder, projectPath)) {
    if ((await poolFor(ws, projectPath)).slots().some((x) => samePlace(x.folder, folder))) return false
    const legacy = legacyWorktree(projectAgents(await ws.projectConfig(projectPath)).find((a) => a.id === started.builder))
    if (legacy && samePlace(legacy.path, folder) && !(await slotsMigrated(projectPath, started.builder))) return false
  }
  return true
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
    // A restart resume of the agent settling (HI-1746: a placement waits while one will bring it back).
    const offEntry = onResumeEntry((p, a) => {
      if (a === agentId && p.toLowerCase() === projectPath.toLowerCase()) look()
    })
    const timer = setInterval(look, 30_000)
    timer.unref?.()
    const finish = (v: boolean): void => {
      settled = true
      off()
      offEntry()
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

/**
 * Asks for a project's pass (coalesced): resolves when no pass of it runs. Never throws. The pass is its own course, run
 * outside any write fence (HI-1685): asked for from a fenced write's context (the merge queue's merge freeing a slot,
 * its commit's listeners), it would otherwise carry the queue's lease check into every write it makes, its later rounds
 * and retries too, and fail them all with LeaseLost once that runner let its lease go.
 */
export function settleSlotCards(ws: WorkspaceService, projectPath: string): Promise<void> {
  if (quitting) return Promise.resolve()
  const key = `${(ws.path ?? '').toLowerCase()}\n${projectPath.toLowerCase()}`
  const running = passes.get(key)
  if (running) {
    running.again = true
    return running.done
  }
  const pass = { again: false, done: Promise.resolve() }
  pass.done = withoutWriteFence(async () => {
    try {
      do {
        pass.again = false
        await settleOnce(ws, projectPath).catch((e) => failedStep(`settling the slots of ${userText(projectPath)}`, e)) // i18n-ignore: a log line (failedStep logs it)
      } while (pass.again && !ended(ws))
    } finally {
      passes.delete(key)
    }
  })
  passes.set(key, pass)
  return pass.done
}

/** Projects whose pass waits for Repair (their folders moved): said once in the log. */
const waitingForRepair = new Set<string>()

/**
 * Finished cards' slots (HI-2014, HI-1986): each Done card of a lease still open (a running lane's) or ended within
 * DELETE_WITHIN_MS, whose slot is still on its card's line. Clean, a running lane's slot is detached at its target's
 * head under the repository's lock (a released one is detached as the pool looks at it); with uncommitted changes, the
 * user is asked once on the card (SLOT_DIRTY_GATE). That question closes once the slot is clean or on another line. Read
 * from the slot each time, under the lock: never another card's checkout, never a slot an operation holds.
 */
export async function finishedSlots(ws: WorkspaceService, projectPath: string, wf: Workflow, pool: SlotPool, lanes: Map<string, LaneRecord>): Promise<boolean> {
  const since = new Date(Date.now() - DELETE_WITHIN_MS).toISOString()
  let detached = false
  for (const l of [...pool.openLeases(), ...pool.endedSince(since)]) {
    if (ended(ws)) return detached
    const lane = l.kind === 'lane' && l.lane ? lanes.get(l.lane) : undefined
    // A lane's cards from the list, or, once an ended lane has left it, from the board's own record of the lane: its
    // finished cards' slot questions are still settled (HR2's HI-2014 round 1, finding 3).
    const cards = l.kind === 'card' && l.card !== null ? [l.card] : (lane?.cards ?? (l.kind === 'lane' && l.lane ? (wf.store.lane(l.lane)?.cards ?? []) : []))
    // A later card of the lane under way on this lease, as the board has it now (its own start moves the slot on, or
    // tells its builder of what isn't committed there).
    const later = (): boolean =>
      cards.some((n) => {
        const c = cardOf(wf, n)
        return !!c && wf.state(c).started?.lease === l.id && wf.state(c).stage !== 'done' && wf.state(c).stage !== 'todo'
      })
    // The slot as the lease still has it: null once another lease holds it (or it is gone). Read again at each call.
    const slotNow = (): FinishedSlotView | null => {
      const now = pool.slotOf(l)
      if (!now || (l.to && pool.openLease(now.name))) return null
      // Busy: an operation holds it (the pool's settle among them, HI-2170), or (a running lane's) its builder works
      // there: nothing of it changes until quiet, as a preparation waits (HR1's #1438 round 1). A released one's is the
      // pool's until it has looked at it: its builder's session still drains there (its writer), or no look since the
      // lease ended (still `lent`).
      const busy = !!now.op || (l.to ? !!now.writer || now.state === 'lent' : !quiet(projectPath, l.agent))
      return { name: now.name, folder: now.folder, target: now.target, busy, open: !l.to, state: now.state, taken: !l.to && later() }
    }
    for (const n of cards) {
      if (ended(ws)) return detached
      detached = (await finishedSlot(projectPath, wf, n, l.id, slotNow, l.lane, () => !ended(ws))) || detached
    }
    // A running lane's slot its builder kept busy: looked at again once it is quiet (as a preparation waits), once per lease.
    const card = cards.map((n) => cardOf(wf, n)).find((c) => !!c && !!wf.state(c).finished && wf.state(c).started?.lease === l.id)
    // Not while a later card of the lane is under way there (its own start moves the slot on).
    if (!l.to && card && !later() && !quiet(projectPath, l.agent) && !quietWaits.has(l.id)) {
      quietWaits.add(l.id)
      void until(projectPath, l.agent, () => quiet(projectPath, l.agent), () => ended(ws) || !!pool.lease(l.id)?.to)
        .then((ok) => (ok ? settleSlotCards(ws, projectPath) : undefined))
        .finally(() => quietWaits.delete(l.id))
    }
  }
  return detached
}

/** Running lanes' leases whose finished card's slot waits for its builder to be quiet (finishedSlots). */
const quietWaits = new Set<string>()

/**
 * HI-2115: the line git last found each slot on (finishedSlot), with the refs' token then. While lanes run, the slots'
 * settling looked at every finished card of the last DELETE_WITHIN_MS at each board change, a git each: most of Hive's
 * git starts. HI-2183: the slot's, not each card's, so one refs move asks git once per slot, not once per finished card
 * it had (57 in 30 s after one merge). Bounded: the oldest go first.
 */
const offLine = new Map<string, { refs: string; line: string | null }>()
const OFF_LINE_MAX = 5000

/** Tests: forgets the slots found on another line. */
export function forgetOffLine(): void {
  offLine.clear()
}

/**
 * A finished card's slot as its lease still has it (HI-2014): `busy`, an operation or its builder's work holds it; `open`,
 * its lease (a lane's) is; `state`, the pool's record of it; `taken`, a later card of its lane is under way there (HI-2170:
 * nothing is asked on the finished card, its own start sees to the slot).
 */
export interface FinishedSlotView {
  name: string
  folder: string
  target: string | null
  busy: boolean
  open: boolean
  state?: string
  taken?: boolean
}

/**
 * One finished card's slot (finishedSlots): nothing unless the card is Done in a cycle started with `lease`. What it was
 * for (the card's finish, its lease and line, the workspace) is checked again inside the repository's lock and after
 * each read there, before anything changes (HR2's HI-2014 round 1, finding 1): a card reopened, finished again or
 * started elsewhere meanwhile, or a workspace closed, leaves the slot as it is. The slot read again too: another
 * lease's now, or on another line, its question closes; dirty, asked once; clean, an open lease's slot detached at the
 * card's target's head (a released one is the pool's), its question closed.
 */
export async function finishedSlot(projectPath: string, wf: Workflow, n: number, lease: string, slotNow: () => FinishedSlotView | null, lane: string | null = null, alive: () => boolean = () => true): Promise<boolean> {
  const card = cardOf(wf, n)
  const s = card ? wf.state(card) : null
  if (!card || !s?.finished || s.started?.lease !== lease || !s.started.line) return false
  const finish = s.finished.seq
  const line = s.started.line
  // The finish this was for, still the card's: Done in that finish, on that lease and line.
  const own = (): boolean => {
    if (!alive()) return false
    const now = wf.state(card)
    return now.stage === 'done' && now.finished?.seq === finish && now.started?.lease === lease && now.started.line === line
  }
  const asked = (): boolean => wf.state(card).requests.some((r) => r.gate === SLOT_DIRTY_GATE)
  // The slot as `was` read it, still: the card's own finish, the same slot, not busy, and no change of the pool's state.
  const still = (was: FinishedSlotView): boolean => {
    const at = slotNow()
    return own() && !!at && !at.busy && at.name === was.name && at.folder === was.folder && at.state === was.state
  }
  const slot = slotNow()
  if (!slot) {
    if (asked()) await wf.closeSlotDirty(card, finish)
    return false
  }
  // The card's own target (HI-2185): where its line merged, so the slot waits at that line's head, not the branch it was
  // made from; the slot's only when the card has none.
  const target = s.integrated?.target || s.started.target || slot.target
  if (!target) return false
  let detached = false
  await withRepoLock(
    projectPath,
    async () => {
      const now = slotNow()
      if (!own() || !now || now.busy) return
      // HI-2115: a slot git last found on another line than this card's stays there until its repository's refs move (the
      // watcher's token, taken before git reads, so a move during the read is seen next time): not asked again meanwhile,
      // for this card or any other finished there (HI-2183). Git is still what says where it is (HI-2050's decision); the
      // watcher only says nothing moved. Found on this card's line, git is asked each time.
      const key = [projectPath.toLowerCase(), now.name, now.folder.toLowerCase(), target].join('\0')
      const refs = await observer.refsNow(projectPath, now.folder)
      const was = refs ? offLine.get(key) : undefined
      if (was && was.refs === refs && was.line !== line) {
        if (asked() && own()) await wf.closeSlotDirty(card, finish)
        return
      }
      const h = await G.heads(now.folder, target)
      if (isUnknown(h.line)) return
      offLine.delete(key)
      if (refs) {
        offLine.set(key, { refs, line: h.line })
        if (offLine.size > OFF_LINE_MAX) offLine.delete(offLine.keys().next().value!)
      }
      if (!own()) return
      if (h.line !== line) {
        if (asked()) await wf.closeSlotDirty(card, finish)
        return
      }
      const d = await G.dirty(now.folder)
      if (isUnknown(d) || !own()) return
      if (d.length) {
        // Asked only of the slot as it was read, after git's reads too (HI-2170): still the lease's, free, in the pool's
        // same state (no settle switched it meanwhile), and no later card of the lane taking it.
        if (!still(now) || slotNow()?.taken) return
        if (!asked()) await wf.askSlotDirty(card, finish, { slot: now.name, line, target })
        return
      }
      // Clean: a running lane's slot detached here; a released one is the pool's (it looks at it as it settles). Its
      // owner and the slot checked once more at the switch itself.
      if (now.open && !isUnknown(h.target) && h.target) {
        const at = slotNow()
        if (!own() || !at || at.busy) return
        const r = await git(now.folder, ['switch', '--detach', h.target])
        if (!r.ok) return void log.warn(`detaching ${userText(now.name)} at ${userText(target)}: ${userText(r.err)}`)
        log.info(`${userText(now.name)} detached at ${userText(target)} after #${n}${lane ? ` (lane ${userText(lane)})` : ''}`)
        detached = true
      }
      if (asked()) await wf.closeSlotDirty(card, finish)
    },
    { quiet: true, project: projectPath }
  )
  return detached
}

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
  let busy = false
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
      if (!kept) {
        // A slot its agent's Resume took while that agent builds in another slot (HI-1741: its start couldn't take it
        // over just then, or a later start reused its lane's lease): ended as a start ends it, once it can be.
        const other = workflowEnforced() && pool.resumedCarry(l) ? pool.leasesOf(l.agent).find((x) => x.kind !== 'carried' && !x.to && x.slot !== l.slot) : undefined
        if (other) busy = (await endLeftCarried(ws, projectPath, pool, l.agent, other.lane ? { lane: other.lane } : { card: other.card! }, other.id)) === 'busy' || busy
        continue
      }
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
  // A retirement waiting for its slot's operation or job: looked at again later; none: its tries forgotten.
  if (busy) retireLater(ws, projectPath)
  else retiredNow(ws, projectPath)
  if (ended(ws)) return
  // 1b. Finished cards' slots (HI-2014): one still on its card's line is detached at the target's head when clean (a
  //     running lane's here; a released card's as the pool looks at it), else the user is asked once on the card.
  const detached = await finishedSlots(ws, projectPath, wf, pool, lanes).catch((e) => (failedStep("settling finished cards' slots", e), false)) // i18n-ignore: a log line (failedStep logs it)
  if (ended(ws)) return
  // With the rules off nothing is placed: no placement is pending, so none keeps anything (HI-1804).
  if (!workflowEnforced()) return void keepTracksOf(ws, projectPath, new Map())
  // 2. Each current cycle in a lease: prepared, then its builder placed.
  const pending = new Map<number, string>()
  for (const l of pool.openLeases()) {
    const cards = l.kind === 'card' && l.card !== null ? [l.card] : l.kind === 'lane' && l.lane ? (lanes.get(l.lane)?.cards ?? []) : []
    for (const n of cards) {
      const card = cardOf(wf, n)
      const cycle = card ? cycleIn(wf.store.facts(n)) : null
      if (!card || !cycle || cycle.started.lease !== l.id || wf.state(card).stage !== 'active') continue
      if (cycle.prepared && cycle.placed) continue
      pending.set(n, refOf(n, cycle, l))
      void ensure(ws, projectPath, wf, pool, n, cycle, l)
    }
  }
  // What placements no longer pending kept (their card put back, Done, deleted; a cycle placed or replaced) is let go
  // here, where retired cycles are passed over (HR4's HI-1804 round 1: a failed try's record outlived its card's return).
  keepTracksOf(ws, projectPath, pending)
  // 3. Done cards' merged lines, from leases still open or ended within DELETE_WITHIN_MS. A slot just detached (1b): the
  //    next pass, asked for now, deletes its line after its releases (a lane that ended meanwhile gives its slot back
  //    first, rather than after a deletion).
  if (detached) void settleSlotCards(ws, projectPath)
  else if (advanced.get(SLOTS_DELETE_MERGED) !== false) {
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
  // Its builder is starting while the cycle is prepared and placed (HI-1976): its Start's hold taken over, so the card
  // isn't stalled meanwhile; a try that failed START_FAIL_TRIES times stalls it with why.
  const hold = `#${n}`
  startBegun(projectPath, l.agent, hold)
  let retry = false
  let why = ''
  let placed = false
  try {
    const prepared = cycle.prepared ?? (await prepare(ws, projectPath, wf, pool, n, cycle, l, key))
    if (!prepared) return
    if (!cycle.placed) await place(ws, projectPath, wf, n, cycle, l)
    placed = true
  } catch (e) {
    failedStep(`#${n}'s slot ${userText(l.slot)}`, e) // i18n-ignore: a log line (failedStep logs it)
    // Its workspace opened again meanwhile (another lifetime's runtime), a write refused, a delivery not given or a launch
    // that failed: another pass once this ends, after a pause that grows with each try (1 s, doubling, at most a minute).
    retry = !ended(ws) && !!ws.path
    why = e instanceof Error ? e.message : String(e)
  } finally {
    ensuring.delete(key)
    if (retry) {
      const tries = (attempts.get(key) ?? 0) + 1
      attempts.set(key, tries)
      if (tries >= START_FAIL_TRIES) startEnded(projectPath, l.agent, hold, { failed: why })
      setTimeout(() => void settleSlotCards(ws, projectPath), Math.min(60_000, 1000 * 2 ** (tries - 1))).unref?.()
    } else {
      attempts.delete(key)
      // Given its card: its own earlier tries' failure is over (a CLI's that exited meanwhile stands: agentStarts.ts).
      startEnded(projectPath, l.agent, hold, placed ? { ok: true } : undefined)
    }
  }
}

/** Failed tries of a cycle's preparation or placement before its card is stalled with the failure (HI-1976). */
const START_FAIL_TRIES = 3

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
      startEnded(projectPath, builder, `#${n}`, { failed: `Hive couldn't get ${st.slot} ready: ${r.error}` }) // i18n-ignore: agent-facing (a card's stall)
      await wf.write(card.card, null, 'hive', (w) => {
        const english = `Hive couldn't get ${st.slot} ready for ${card.card.key}: ${r.error}` // i18n-ignore: agent-facing, and the notice's English
        w.action('notify', { text: english, shown: workflowText(SLOT_NOTICES.notPrepared, { slot: st.slot, card: card.card.key, why: r.error }) })
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
 *
 * Its builder stopped (HI-1746: Hive quit between the card's start and its placement), the placement resumes the
 * builder's newest conversation bound to the card's lease (sessions.leaseConversation), the card's prompt that launch's
 * own line; a new conversation only when there is none, or its transcript is gone. Never meanwhile:
 * - while this run's restart resume will bring the builder back (isResuming): it waits, then types it in (`typed`);
 * - while that conversation is held (resumeHold): it waits, the card told once, never an older or a new conversation;
 * - after RESUME_TRIES failed resumes of it: the card told, and it waits for the builder to run (the user's Resume, a
 *   start by hand), then types it in. A Hive started again tries again.
 * A start of the builder by another (the restart queue, the window's Resume All) wins over its own: refused, its
 * delivery not given, it is tried again and finds the builder running, so the card's prompt is given once.
 */
export async function place(ws: WorkspaceService, projectPath: string, first: Workflow, n: number, cycle: Cycle, l: SlotLease): Promise<void> {
  const gone = (): boolean => !workflowEnforced() || ended(ws) || !current(first, n, cycle.seq, l.id)
  for (let r = await placeOnce(ws, projectPath, first, n, cycle, l); r !== 'done'; r = await placeOnce(ws, projectPath, first, n, cycle, l)) {
    // Held (HI-2304): asked again once its wait listens, so a slot freed while the pass told its card isn't missed.
    const stillHeld = r === 'held' ? async () => !!(await slotHeldWords(projectPath, cycle.started.slot, (id) => id).catch(() => 'unknown')) : undefined
    if (!(await nextLook(projectPath, l.agent, gone, r === 'builder', stillHeld))) break
  }
  // Placed, or its cycle obsolete or gone: what it kept is let go (HI-1804). A throw keeps it for ensure's next try.
  releaseTrack(ws, projectPath, n, refOf(n, cycle, l))
}

/** Resumes of a placement's conversation tried before it stops and tells the card (HI-1746). */
const RESUME_TRIES = 3

/**
 * What a placement keeps between its looks and its tries (HI-1746): its failed resumes, whether they reached
 * RESUME_TRIES, and the holds it told its card about (so it tells each once). One per card in a workspace's lifetime,
 * for its current cycle (`ref`: a new cycle's replaces it), let go once its placement ends (HI-1804); the workspace's
 * own, so a workspace that closed takes them with it.
 */
interface PlacementTrack {
  ref: string
  failures: number
  gaveUp: boolean
  told: Set<string>
}
const tracks = new WeakMap<object, Map<string, PlacementTrack>>()
const refOf = (n: number, cycle: Cycle, l: SlotLease): string => `${n}:${cycle.seq}:${l.id}`
const trackKey = (projectPath: string, n: number): string => `${projectPath.toLowerCase()}#${n}`
function trackOf(ws: WorkspaceService, projectPath: string, n: number, ref: string): PlacementTrack {
  let all = tracks.get(ws.lifetime)
  if (!all) tracks.set(ws.lifetime, (all = new Map()))
  let t = all.get(trackKey(projectPath, n))
  if (!t || t.ref !== ref) all.set(trackKey(projectPath, n), (t = { ref, failures: 0, gaveUp: false, told: new Set() }))
  return t
}
function releaseTrack(ws: WorkspaceService, projectPath: string, n: number, ref: string): void {
  const all = tracks.get(ws.lifetime)
  if (all?.get(trackKey(projectPath, n))?.ref === ref) all.delete(trackKey(projectPath, n))
}
/**
 * A project's records kept only for its pending placements (the slot pass's: card → its current cycle's ref); every
 * other card's, or another cycle's, let go. A record is made only by a placement under way, so this never takes one a
 * running placement still needs: its card is pending, at that ref.
 */
function keepTracksOf(ws: WorkspaceService, projectPath: string, pending: ReadonlyMap<number, string>): void {
  const all = tracks.get(ws.lifetime)
  if (!all) return
  const prefix = `${projectPath.toLowerCase()}#`
  for (const [key, t] of all) {
    if (!key.startsWith(prefix)) continue
    if (pending.get(Number(key.slice(prefix.length))) !== t.ref) all.delete(key)
  }
}
/** Tests: the placements a workspace keeps something for, as card → its cycle's ref and what it keeps. */
export const placementTracksForTests = (ws: WorkspaceService): Map<string, PlacementTrack> => new Map(tracks.get(ws.lifetime) ?? [])

/** How long a placement waiting for its held slot (HI-2304) goes without a look, when nothing it waits on is told. */
const HELD_LOOK_MS = 5 * 60_000

/** Told each slot freed (a run's writer released), by its project's folder: a waiting placement looks again. */
const slotFreed = new Set<(projectPath: string) => void>()

/**
 * Resolves at the next change that may matter to a waiting placement: its builder's status, a run, its restart resume, a
 * slot of its project freed, or within 30 s; false once `over`. For a builder that can't take a line (HI-2191: whyNoLine),
 * also what ends each reason that changes no status: Hive's line there done with (typed, or its take checked), the pause
 * after the user typed there over (one timer, at its end), its folder steady again, its hive tools connected. `builder`:
 * the pass waited for that, so it is looked at again once these listen (a change between the pass and them is not lost).
 * `stillHeld` (HI-2304): its slot is held by what another run left running there, so what frees it is the slot freed or
 * those processes changing (their run's leftovers told), not the clock: looked at again after HELD_LOOK_MS at most. Once
 * these listen it is asked once whether the slot is still held (HR1's round 1: freed between the pass's look and them,
 * nothing more would come): no, and it looks again now; a slot that can't be told counts as held.
 */
function nextLook(projectPath: string, agentId: string, over: () => boolean, builder = false, stillHeld?: () => Promise<boolean>): Promise<boolean> {
  const held = !!stillHeld
  return new Promise((resolve) => {
    const same = (p: string, a: string): boolean => a === agentId && p.toLowerCase() === projectPath.toLowerCase()
    const freed = (p: string): void => {
      if (p.toLowerCase() === projectPath.toLowerCase()) finish()
    }
    slotFreed.add(freed)
    let done = false
    const offLineFreed = onLineFreed((p, a) => {
      if (same(p, a)) finish()
    })
    const quietAt = sessions.userQuietAt(projectPath, agentId)
    const quietTimer = quietAt === null ? undefined : setTimeout(() => finish(), Math.max(0, quietAt - Date.now()) + 50)
    quietTimer?.unref?.()
    const cwd = sessions.liveFor(projectPath, agentId)?.cwd
    if (folderChanging(cwd)) void folderSteady(cwd).then(() => finish())
    if (sessions.hiveToolsWaiting(projectPath, agentId)) void sessions.hiveToolsSettled(projectPath, agentId).then(() => finish())
    const finish = (): void => {
      if (done) return
      done = true
      off()
      offEntry()
      offLineFreed()
      slotFreed.delete(freed)
      clearTimeout(timer)
      clearTimeout(quietTimer)
      resolve(!over())
    }
    const off = onHiveEvent((e) => {
      if ((e.type === 'session-status' && same(e.state.projectPath, e.state.agentId)) || (!held && e.type === 'progress-changed') || (held && e.type === 'agent-leftovers' && e.leftovers.projectPath.toLowerCase() === projectPath.toLowerCase())) finish()
    })
    const offEntry = onResumeEntry((p, a) => {
      if (same(p, a)) finish()
    })
    const timer = setTimeout(finish, held ? HELD_LOOK_MS : 30_000)
    timer.unref?.()
    // Waiting for its builder (HI-2191, HR3's round 2): what freed it may have come between the pass's look and these
    // listeners (a line done with, the user's pause over), with nothing more to come. Looked at again now they listen.
    if (builder && !whyNoLine(projectPath, agentId, 'free')) finish()
    if (stillHeld)
      void stillHeld().then(
        (yes) => {
          if (!yes) finish()
        },
        () => undefined
      )
  })
}

async function placeOnce(ws: WorkspaceService, projectPath: string, first: Workflow, n: number, cycle: Cycle, l: SlotLease): Promise<'done' | 'wait' | 'builder' | 'held'> {
  let wf = first
  const agentId = l.agent
  const gone = (): boolean => !workflowEnforced() || ended(ws) || !current(wf, n, cycle.seq, l.id)
  const offer = offered.get(offerKey(projectPath, n))
  if (offer) await offer.ready
  // Quiet, and not about to be resumed by this run's restart record (HI-1746): it is woken as that resume settles.
  if (!(await until(projectPath, agentId, () => quiet(projectPath, agentId) && !isResuming(projectPath, agentId), gone))) return 'done'
  wf = (await workflowFor(ws, projectPath).catch(() => null)) ?? wf
  const now = current(wf, n, cycle.seq, l.id)
  if (!now || now.cycle.placed) return 'done'
  const me = await holder.self()
  const claim = now.cycle.claimed
  const mine = !!claim && claim.pid === me.pid && claim.started === me.started
  if (claim && !mine && (await holder.alive(claim.pid, claim.started)) !== false) return 'done'
  const took = await wf.write(now.card, null, 'hive', (w) => {
    const c = cycleIn(w.tx.facts(n))
    if (!c || c.seq !== cycle.seq || c.placed || (c.claimed?.seq ?? null) !== (claim?.seq ?? null)) return false
    if (!mine) w.fact('PlacementClaimed', { lease: l.id, pid: me.pid, started: me.started }) // i18n-ignore: a fact's kind and codes, not text
    return true
  })
  if (!took) return 'done'
  await crashAt('inPlacement')
  // The team paused (HI-2081): a lane's card (Hive's start, or its builder's) isn't given to its builder until it resumes;
  // a card the user started by hand still is. Asked again just before the launch or the line (below).
  const pausedLane = (): boolean => l.kind === 'lane' && !!teamPauseOf(ws)
  if (pausedLane()) return 'wait'
  const cfgNow = await ws.projectConfig(projectPath)
  const agent = projectAgents(cfgNow).find((a) => a.id === agentId)
  const card = await getTask(n, ws).catch(() => null)
  if (!agent || !card) return 'done'
  wf = (await workflowFor(ws, projectPath).catch(() => null)) ?? wf
  const ref = refOf(n, cycle, l)
  const track = trackOf(ws, projectPath, n, ref)
  const made = (await deliveriesOf(projectPath, agentId)).find((r) => r.source === PLACEMENT && r.ref === ref && !NOT_GIVEN.has(r.state))
  // Its builder stopped: the conversation it resumes, chosen before anything else (a read that fails throws: tried again).
  const conv = sessions.liveFor(projectPath, agentId) ? null : await sessions.leaseConversation(projectPath, agentId, l.id)
  if (gone()) return 'done'
  // Busy again, or about to be resumed, meanwhile: it waits (its tries and notices kept, HI-1804).
  if (!quiet(projectPath, agentId) || isResuming(projectPath, agentId)) return 'wait'
  const st = sessions.liveFor(projectPath, agentId)
  const there = !!st && samePlace(st.cwd, cycle.started.folder)
  if (!st && conv?.is === 'held') {
    const told = conv.hold.is
    log.info(`#${n} waits for ${userText(agent.name)}'s conversation in ${userText(cycle.started.slot)}: held (${conv.hold.is})`)
    if (!track.told.has(told)) {
      track.told.add(told)
      await tellCard(wf, now.card, cycle.started.builder, workflowText(SLOT_NOTICES.resumeHeld, { card: card.key ?? `#${n}`, agent: agent.name, slot: cycle.started.slot, why: holdWords(conv.hold) }), `Hive can't give ${card.key ?? `#${n}`} to ${agent.name} yet: its conversation in ${cycle.started.slot} can't resume now (${holdWords(conv.hold)}).`) // i18n-ignore: agent-facing, and the notice's English
    }
    return 'wait'
  }
  // Its resumes gave up: it waits for the builder to run (the user's Resume, a start by hand), then the card is typed in.
  if (!st && track.gaveUp) return 'wait'
  // Its slot held by another run of this Hive's (HI-2304: what an ended run left running there, or a session there): a
  // start would be refused only after its resume's preparation, a delivery made and called off at each look. It waits,
  // making nothing, for the slot to be freed, saying why once on the card, to its builder and on the agent.
  const held = !st ? await slotHeldWords(projectPath, cycle.started.slot, (id) => projectAgents(cfgNow).find((a) => a.id === id)?.name ?? id).catch(() => null) : null
  if (held) {
    startWaits(projectPath, agentId, `#${n}`, held)
    const told = `held:${held}`
    if (!track.told.has(told)) {
      track.told.add(told)
      log.info(`#${n} waits for ${userText(cycle.started.slot)} to be freed before ${userText(agent.name)} resumes there: ${userText(held)}`)
      await tellCard(wf, now.card, cycle.started.builder, workflowText(SLOT_NOTICES.resumeHeld, { card: card.key ?? `#${n}`, agent: agent.name, slot: cycle.started.slot, why: held }), `Hive can't give ${card.key ?? `#${n}`} to ${agent.name} yet: its conversation in ${cycle.started.slot} can't resume now (${held}).`) // i18n-ignore: agent-facing, and the notice's English
    }
    return 'held'
  }
  startWaits(projectPath, agentId, `#${n}`, null)
  const resumeId = !st && conv?.is === 'resume' ? conv.id : null
  let how: FactData['BuilderPlaced']['how'] = there ? 'typed' : st ? 'newConversation' : resumeId ? 'resumed' : 'started'
  /** The builder's launch here: its lease's conversation resumed, else a new one; a failed resume counted. */
  const launch = async (line?: string): Promise<LiveSessionState> => {
    // The team paused meanwhile (HI-2081): checked as the launch spawns, after its own awaits.
    const allowed = (): void => {
      if (pausedLane()) throw new Waits()
    }
    if (!resumeId) return sessions.start(projectPath, line ? { agentId, prompt: line, allowed } : { agentId, allowed })
    try {
      const run = await sessions.start(projectPath, { agentId, resumeId, auto: true, allowed, ...(conv?.is === 'resume' && conv.name ? { name: conv.name } : {}), ...(line ? { prompt: line } : {}) })
      track.failures = 0
      return run
    } catch (e) {
      // Held by the team's pause (HI-2081): a wait, not this resume's failure.
      if (e instanceof Waits) throw e
      // Another start of it won (the restart queue, Resume All): not this resume's failure; the next look finds it running.
      if (sessions.liveFor(projectPath, agentId) || sessions.pendingStart(projectPath, agentId)) throw e
      // Its slot not ready for it yet (a crashed run's processes not known ended, a setup under way): a wait, not a try.
      if (e instanceof HiveError && e.kind === 'conflict') {
        log.info(`#${n} waits to resume ${userText(agent.name)}'s conversation in ${userText(cycle.started.slot)}: ${userText(e.message)}`)
        const told = 'refused'
        if (!track.told.has(told)) {
          track.told.add(told)
          await tellCard(wf, now.card, cycle.started.builder, workflowText(SLOT_NOTICES.resumeHeld, { card: card.key ?? `#${n}`, agent: agent.name, slot: cycle.started.slot, why: e.message }), `Hive can't give ${card.key ?? `#${n}`} to ${agent.name} yet: its conversation in ${cycle.started.slot} can't resume now (${e.message}).`) // i18n-ignore: agent-facing, and the notice's English
        }
        throw new Waits()
      }
      const tries = ++track.failures
      if (tries >= RESUME_TRIES) {
        track.gaveUp = true
        track.failures = 0
        const why = e instanceof Error ? e.message : String(e)
        log.warn(`#${n}: ${userText(agent.name)}'s conversation in ${userText(cycle.started.slot)} didn't resume (${tries} tries): ${userText(why)}`)
        startEnded(projectPath, agentId, `#${n}`, { failed: `its conversation in ${cycle.started.slot} didn't resume (${tries} tries): ${why}` }) // i18n-ignore: agent-facing (a card's stall)
        await tellCard(wf, now.card, cycle.started.builder, workflowText(SLOT_NOTICES.resumeFailed, { card: card.key ?? `#${n}`, agent: agent.name, slot: cycle.started.slot, why }), `Hive couldn't resume ${agent.name}'s conversation in ${cycle.started.slot} for ${card.key ?? `#${n}`} (three tries): ${why}. Resume ${agent.name} from Sessions, or start it fresh, and Hive gives it ${card.key ?? `#${n}`}.`) // i18n-ignore: agent-facing, and the notice's English
        throw new GaveUp()
      }
      throw e
    }
  }
  let delivery: string | null
  try {
    if (made) {
      delivery = made.id
      // On its way, its agent not running: started in its slot (no prompt of its own), where the delivery is offered.
      if (!st && (made.state === 'queued' || made.state === 'offered' || made.state === 'uncertain')) {
        log.info(`Starting ${userText(agent.name)} in ${userText(cycle.started.slot)} for #${n}'s delivery ${made.id} (${made.state}${resumeId ? ', its conversation resumed' : ''})`)
        await launch()
        how = resumeId ? 'resumed' : 'started'
      } else {
        // Made by an earlier pass, whose fact wasn't written (its workspace closed meanwhile, HI-2134): placed as that pass
        // placed it, never `typed` for a launch's line because its builder runs there now.
        const was = made.meta?.how
        if (isPlacedHow(was)) how = was
      }
    } else {
      const cardPrompt = (offer && offered.get(offerKey(projectPath, n)) === offer ? offer.prompt : null) ?? taskPrompt(card, !!sessions.hiveMcp(projectPath), { from: 'todo', attachments: await cardAttachments(ws, n), inLane: l.kind === 'lane' && !!l.lane })
      // Its lane's brief as it is now (HI-1795), after the card's own prompt (the window's or offered one kept whole): in
      // every placement of the lane's cards, whatever conversation works the card. Fixed with the delivery once made.
      // A read that fails is unknown, never "no brief": it throws, and the pass tries again (HR4's round 1).
      const brief = l.kind === 'lane' && l.lane ? briefOf((await rawLanes(ws)).find((x) => x.id === l.lane)) : null
      const prompt = brief ? `${cardPrompt}\n\n${brief}` : cardPrompt
      // How it is placed kept with it (HI-2134): a later pass finding it made records the placement as this one made it.
      const nd = { agentId, agentName: agent.name, kind: 'task' as const, from: { kind: 'hive' as const, name: 'Hive' }, card: n, body: prompt, source: PLACEMENT, ref, meta: { how } } // i18n-ignore: who a delivery is from, as agents read it
      // Its builder can't take a line now (HI-2191: its input blocked, a line of Hive's being typed, watching, working):
      // it waits for that builder's next status (place's nextLook), making no delivery. One made and called off each
      // pass wrote the lane each time, which ran the next pass: HB3's every second. Said once for each reason.
      const busy = there ? whyNoLine(projectPath, agentId, 'free') : null
      if (busy) {
        if (!track.told.has(`busy:${busy}`)) {
          track.told.add(`busy:${busy}`)
          log.info(`#${n} waits for its builder ${userText(agent.name)}, which can't take a line now (${busy}): given once it can`)
        }
        throw new BuilderBusy()
      }
      log.info(`Giving ${userText(agent.name)} #${n} in ${userText(cycle.started.slot)} (${how})`)
      // A refusal (NotGiven: its agent got busy) or a launch that couldn't start throws: nothing recorded, tried again.
      if (pausedLane()) throw new Waits()
      const r = there
        ? await deliverNow(projectPath, { ...nd, need: 'free', conversation: st!.sessionId || null }, () => !pausedLane())
        : (await launchWith(projectPath, nd, (line) => (st ? sessions.newConversation(projectPath, agentId, line, () => { if (pausedLane()) throw new Waits() }) : launch(line)))).record
      if (!r || NOT_GIVEN.has(r.state)) throw new Error(`#${n}'s delivery to ${agent.name} wasn't given (${r?.state ?? 'none made'})`) // i18n-ignore: an error for the log (the pass tries again)
      delivery = r.id
      offered.delete(offerKey(projectPath, n))
    }
  } catch (e) {
    if (e instanceof BuilderBusy) return 'builder'
    if (e instanceof GaveUp || e instanceof Waits) return 'wait'
    throw e
  }
  await wf.write(now.card, null, 'hive', (w) => {
    const c = cycleIn(w.tx.facts(n))
    if (c?.seq === cycle.seq && !c.placed) w.fact('BuilderPlaced', { lease: l.id, delivery, how }) // i18n-ignore: a fact's kind and codes, not text
  })
  return 'done'
}

const PLACED_HOW: ReadonlySet<string> = new Set<FactData['BuilderPlaced']['how']>(['typed', 'newConversation', 'started', 'resumed'])
/** A placement delivery's `meta.how` (HI-2134), as its fact records it. */
const isPlacedHow = (x: unknown): x is FactData['BuilderPlaced']['how'] => typeof x === 'string' && PLACED_HOW.has(x)

/** A placement's resumes reached RESUME_TRIES: told, and it waits for its builder to run. */
class GaveUp extends Error {}
/** A placement's resume refused for now (its slot not ready for it): it waits, the try not counted. */
class Waits extends Error {}
/** A placement's builder can't take a line now (HI-2191, whyNoLine): it waits for what frees it (nextLook's `builder`). */
class BuilderBusy extends Waits {}

/** A placement's notice on its card, and its builder woken with the English (as a preparation's failure is). */
async function tellCard(wf: Workflow, card: Parameters<Workflow['write']>[0], builder: string, shown: ReturnType<typeof workflowText>, english: string): Promise<void> {
  await wf.write(card, null, 'hive', (w) => {
    w.action('notify', { text: english, shown })
    wf.wake(w, builder, english)
  })
}

/** A resume's hold in a few English words, for a placement's notice and the log (agent-facing). */
function holdWords(h: ResumeHold): string {
  switch (h.is) {
    case 'draining':
      return 'its last session there is still ending' // i18n-ignore: agent-facing
    case 'after':
    case 'reused':
      return `its slot ${h.slot} holds other work now` // i18n-ignore: agent-facing
    case 'holds':
      return `its agent keeps another slot (${h.slot})` // i18n-ignore: agent-facing
    case 'changed':
      return `its slot ${h.slot} changed since it ran` // i18n-ignore: agent-facing
    case 'gone':
      return `its slot ${h.slot} is gone` // i18n-ignore: agent-facing
    case 'reviewer':
      return 'its agent reviews now' // i18n-ignore: agent-facing
    case 'byHand':
      return `its slot ${h.slot} is free, for a Resume by hand` // i18n-ignore: agent-facing
  }
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
 * However it got its slot, it records the lane's target on it then, by the lease chosen (startServes).
 */
export async function lendLane(ws: WorkspaceService, projectPath: string, lane: string, builder: string, target: string | null): Promise<{ slot: string } | { waiting: string }> {
  const r = await lendLaneSlot(ws, projectPath, lane, builder, target)
  if (!('lease' in r)) return r
  const lost = await startServes(ws, projectPath, r.lease, builder, target)
  return lost ? { waiting: lost } : { slot: r.slot }
}

async function lendLaneSlot(ws: WorkspaceService, projectPath: string, lane: string, builder: string, target: string | null): Promise<{ slot: string; lease: string } | { waiting: string }> {
  const pool = await poolFor(ws, projectPath)
  const agents = projectAgents(await ws.projectConfig(projectPath))
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  // The builder's own slot, taken over by the lane when it can be (#1441), as a card's start does.
  const own = await carriedToHand(ws, projectPath, pool, builder, target)
  const handed = own ? await handOffCarried(ws, projectPath, pool, own, { lane, agent: builder }, name(builder)) : null
  if (handed) return { slot: handed.slot, lease: handed.id }
  // The slot its own run still writes in, its last lease ended (HI-1762), as a card's start does: taken, or waited for.
  const written = await startOnWritten(ws, projectPath, pool, builder, { lane, agent: builder }, name(builder))
  if ('wait' in written) return { waiting: written.wait }
  if ('lease' in written) return { slot: written.lease.slot, lease: written.lease.id }
  // Lent with the lane's target (#1627), so the slot records where its lines merge.
  const r = await pool.lend({ lane, agent: builder }, { ...(target ? { target } : {}), install: false })
  if (r.ok) {
    log.info(`Lent ${userText(r.slot.name)} to lane ${lane} (lease ${r.lease.id})`)
    // Its carried lease kept for a card it has left ends now that the lane holds its own (HI-1731).
    await endLeftCarriedNow(ws, projectPath, pool, builder, { lane }, r.lease.id)
    return { slot: r.slot.name, lease: r.lease.id }
  }
  return { waiting: refusalText(r.refusal, name) }
}

/**
 * A project's lanes waiting for a slot (`slotWait`), in the order they began waiting: each lent one while one is free,
 * its agents (its builder and reviewer now) started once (laneStart's, by their brief's delivery identity), then its
 * wait cleared. Only with the rules on; a lane ended or abandoned meanwhile isn't running, so it is never started.
 * Once none is free, no later lane is lent one, but a lane that needs none (only no-code cards, HI-2338) still starts.
 */
async function startWaitingLanes(ws: WorkspaceService, projectPath: string, pool: SlotPool): Promise<void> {
  const name = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.name
  const waiting = (await lanesWaitingForSlot(ws)).filter((l) => l.project.toLowerCase() === name?.toLowerCase()).sort((a, b) => a.slotWait!.since.localeCompare(b.slotWait!.since))
  // The rules off, or Hive quitting (#1628): looked at again after each await, nothing more lent or started.
  const stopped = (): boolean => !workflowEnforced() || ended(ws)
  // No slot could be lent (HR1 on HI-2338): the lanes after it are visited only for those that need none, so an earlier
  // code lane keeps its place for the next free slot.
  let full = false
  for (const lane of waiting) {
    if (stopped()) return
    let lease = pool.leaseOf({ lane: lane.id })
    if (!lease) {
      // Its cards still to do all no-code by now (HI-2338): it takes no slot, and its agents start where they are.
      const { noCodeOnly, startWaitingLane } = await import('./laneStart')
      if (noCodeOnly(ws, lane.cards)) {
        if (stopped() || teamPauseOf(ws)) return
        const started = await startWaitingLane(ws, projectPath, lane.id, null, () => stopped() || !!teamPauseOf(ws)).catch((e) => (failedStep(`starting lane ${lane.id} with no slot`, e), false)) // i18n-ignore: a log line (failedStep logs it)
        if (started && !stopped()) await setLaneSlotWait(ws, lane.id, null)
        continue
      }
      if (stopped()) return
      if (full) continue
      // The builder's own slot first (#1441), checked against the default branch (the lane's target isn't known here).
      const own = await carriedToHand(ws, projectPath, pool, lane.builder.id, null)
      if (stopped()) return
      lease = own ? await handOffCarried(ws, projectPath, pool, own, { lane: lane.id, agent: lane.builder.id }, lane.builder.name) : null
      if (stopped()) return
      // The slot its own run still writes in (HI-1762): taken, or this lane goes on waiting (never a second slot).
      if (!lease) {
        const written = await startOnWritten(ws, projectPath, pool, lane.builder.id, { lane: lane.id, agent: lane.builder.id }, lane.builder.name)
        if ('wait' in written) continue
        if ('lease' in written) lease = written.lease
      }
    }
    if (stopped()) return
    if (!lease) {
      const r = await pool.lend({ lane: lane.id, agent: lane.builder.id }, { install: false })
      if (!r.ok) {
        full = true
        continue
      }
      lease = r.lease
      log.info(`Lent ${userText(r.slot.name)} to lane ${lane.id}, which waited for a slot (lease ${r.lease.id})`)
      // Its carried lease kept for a card it has left ends now that the lane holds its own (HI-1731).
      await endLeftCarriedNow(ws, projectPath, pool, lane.builder.id, { lane: lane.id }, r.lease.id)
    }
    // Hive quitting once a slot is lent (#1628): the lane keeps it and keeps waiting; the next start's pass starts it. The
    // team paused (HI-2081): the same, until it resumes (its end is a board change, which passes again).
    const held = (): boolean => stopped() || !!teamPauseOf(ws)
    if (held()) return
    const { startWaitingLane } = await import('./laneStart')
    const started = await startWaitingLane(ws, projectPath, lane.id, lease.slot, held).catch((e) => (failedStep(`starting lane ${lane.id} in ${userText(lease!.slot)}`, e), false)) // i18n-ignore: a log line (failedStep logs it)
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
  setSlotFreed((ws, project) => {
    for (const l of slotFreed) l(project)
    void settleSlotCards(ws, project)
  })
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
    // The team resuming (HI-2081) is one too: what waited for it is placed.
    if ((e.type !== 'tasks-changed' && e.type !== 'team-pause-changed') || boardSoon) return
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
