// Cards on slots (#1438, SPEC §16.10): G11 = slots made real. A card's start under it asks `leaseForStart` for its
// builder's slot (a lane's card: the lane's dispatch lease, lent once and kept for the whole lane, OP-10; any other card:
// its own lease), and its card's line `hive/<KEY>/<KEY>-<n>-<slug>` is made from the target's head in it by the start's
// `prepareSlot` action (with G15, Slots are brought up to date, its dependencies installed again when its lock files
// changed). The builder then works there: Hive waits for its turn to end and gives it the card in that slot (a new
// conversation where it isn't running there, the old one kept). The lease ends at the card's Done or put back
// (`releaseSlot`), a lane's only with the lane; a merged line is deleted once Done when its target contains it (Settings
// → Advanced, Delete a card's branch once it's merged). With the rules off (Settings → Advanced, Workflow rules are
// enforced) or G11 another value, nothing here acts: a card starts where its agent is, as before.

import { projectAgents } from '../shared/defaults'
import { msg } from '../shared/i18n'
import { taskPrompt } from '../shared/tasks'
import { agentWorkflowRole, buildsWork } from '../shared/workflow/roles'
import { workflowText } from '../shared/workflow/texts'
import { SLOTS_DELETE_MERGED } from '../shared/advanced'
import type { AgentDef } from '../shared/types'
import { advanced } from './advanced'
import { boardRead } from './boardStore'
import { launchWith, deliverNow } from './deliveries'
import { onHiveEvent } from './events'
import { samePlace } from './fsutil'
import { git } from './git'
import { listLanes, onLanesWritten, setLaneSlots } from './lanes'
import { createLogger, userText } from './logger'
import * as G from './platform/git'
import { isUnknown } from './platform/types'
import { sessions } from './sessions'
import { poolFor, setSlotFreed } from './slotsApp'
import { refusalText, setBuilderCount, type SlotLease, type SlotPool } from './slots'
import { getTask } from './tasks'
import { onAction } from './workflow/actionWorker'
import { agentBusy } from './workflow/lineUpdates'
import type { CardRecord } from './workflow/factStore'
import type { SlotForStart } from './workflow/runtime'
import { agentRunsGoing, setSlotStarts, workflowEnforced, workflowFor } from './workflow/service'
import { listWorktreesOrNull } from './worktrees'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

const log = createLogger('slots')

const M = {
  notPrepared: msg({ id: 'service.slots.notPrepared', defaultMessage: "Hive couldn't get {slot} ready for {card}: {why}", description: "A notice: a card was started in a slot (a worktree Hive lends to a card or a lane), and Hive couldn't check out the card's branch there or install its dependencies. {slot} is the slot's name (slot-b), {card} the card's key, {why} git's or the setup's reason, in English." })
}

/** The project folder of a card on a workspace's board, by its board name; null for none. */
function projectOfCard(ws: WorkspaceService, card: number): string | null {
  const name = boardRead(ws, (db) => (db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string } | undefined)?.project) // i18n-ignore: SQL
  if (!name) return null
  return ws.info()?.projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.path ?? null
}

/** A project's folder by its id (the slots' `project`), in a workspace; null for none. */
const projectById = (ws: WorkspaceService, id: string): string | null => ws.projectIdsNow().byId.get(id) ?? null

/**
 * Lanes waiting for a slot now (lent none when they started, or their card's start found none), by id: a lane started
 * from the window starts its agents once one is lent (`start`).
 */
const laneWaits = new Map<string, { ws: WorkspaceService; project: string; builder: string; start: ((slot: string) => Promise<void>) | null }>()

/** The slot a lane works in now (its open lease's), and whether it waits for one: for the lane's view (lanes.ts). */
function laneSlot(ws: WorkspaceService, lane: string): { slot: string | null; waiting: boolean } {
  let slot: string | null = null
  try {
    slot = boardRead(ws, (db) => (db.prepare('SELECT slot FROM slot_leases WHERE lane = ? AND ended_at IS NULL').get(lane) as { slot: string } | undefined)?.slot ?? null) // i18n-ignore: SQL
  } catch {
    // A board still 0.9's: no slots.
  }
  return { slot, waiting: !slot && laneWaits.has(lane) }
}

/** A lease where a start can use it: its slot and folder (fresh: a card's own, given back if the start isn't written). */
function leaseAt(pool: SlotPool, l: SlotLease): SlotForStart {
  const s = pool.slotOf(l)
  return s ? { slot: s.name, folder: s.folder, lease: l.id, fresh: l.kind === 'card' } : null
}

/** Whether an agent builds (G11's slots are its builders'): a builder or either, never a reviewer. */
const builds = (a: AgentDef | undefined): a is AgentDef => !!a && buildsWork(agentWorkflowRole(a))

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
  if (o.dry) return couldLend(pool, projectPath, builder)
  const r = await pool.lend(lane ? { lane, agent: builder } : { card: card.id, agent: builder }, { ...(o.target ? { target: o.target } : {}), install: false })
  if (!r.ok) {
    if (lane && (r.refusal.why === 'noSlot' || r.refusal.why === 'warming')) laneWaits.set(lane, { ws, project: projectPath, builder, start: laneWaits.get(lane)?.start ?? null })
    return { wait: refusalText(r.refusal, name) }
  }
  if (lane) laneWaits.delete(lane)
  log.info(`Lent ${userText(r.slot.name)} to ${userText(name(builder))} for ${lane ? `lane ${lane}` : `#${card.id}`} (lease ${r.lease.id})`)
  return leaseAt(pool, r.lease)
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

/** A lease lent for a start that wasn't written: given back (only a card's own; a lane keeps its). */
export async function slotUnused(ws: WorkspaceService, projectPath: string, lease: string): Promise<void> {
  const pool = await poolFor(ws, projectPath)
  const l = pool.lease(lease)
  if (!l || l.to || l.kind !== 'card') return
  await pool.release(lease, 'notStarted')
  void retryWaitingLanes(ws, projectPath)
}

// --- The builder in its slot.

/** Window Starts handing their card's prompt to the slot's placement (startTask), by project and card. */
const offered = new Map<string, { prompt: string | null; ready: Promise<void> }>()
const offerKey = (projectPath: string, n: number): string => `${projectPath.toLowerCase()}#${n}`

/**
 * A window Start of a card that may start in a slot (taskStart.ts): its prompt (with the user's note and the card's
 * Read first) is given to the slot's placement rather than typed where the agent is now. Call before the card moves;
 * the returned function gives the prompt, or null when the Start didn't go through (nothing is placed then).
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
  if (!wf) return null
  try {
    const s = wf.state(wf.store.card(n))
    return s.stage !== 'todo' && s.started?.lease && s.started.slot ? { slot: s.started.slot, lease: s.started.lease } : null
  } catch {
    return null
  }
}

/** Placements waiting for their builder's turn to end, by project and agent: a newer one replaces an older one. */
const placing = new Map<string, () => void>()

/**
 * Gives a card's builder the card in its slot (#1438): once its turn is over (not in a turn, no prompt waiting, no run or
 * background task going), the card typed in where it already runs in the slot; where it runs elsewhere, a new
 * conversation in the slot (the old one kept, in its Sessions tab); not running, started there. Only while the lease is
 * still open. The prompt is a window Start's (its note and Read first), else the card's own.
 */
async function placeBuilder(ws: WorkspaceService, projectPath: string, n: number, agentId: string, lease: string, folder: string): Promise<void> {
  const offer = offered.get(offerKey(projectPath, n))
  if (offer) {
    await offer.ready
    offered.delete(offerKey(projectPath, n))
    if (offer.prompt === null) return
  }
  const pool = await poolFor(ws, projectPath)
  const agent = projectAgents(await ws.projectConfig(projectPath)).find((a) => a.id === agentId)
  if (!agent) return
  const card = await getTask(n, ws).catch(() => null)
  if (!card) return
  const prompt = offer?.prompt ?? taskPrompt(card, !!sessions.hiveMcp(projectPath), { from: 'todo' })
  const key = `${projectPath.toLowerCase()}|${agentId}`
  placing.get(key)?.()
  let off: (() => void) | null = null
  let going = false
  const done = (): void => {
    off?.()
    off = null
    if (placing.get(key) === done) placing.delete(key)
  }
  const look = (): void => {
    if (going || !off) return
    const l = pool.lease(lease)
    if (!l || l.to) return done()
    const st = sessions.liveFor(projectPath, agentId)
    if (st && (st.status === 'starting' || agentBusy(projectPath, agentId) || agentRunsGoing(projectPath, agentId).length)) return
    going = true
    done()
    const nd = { agentId, agentName: agent.name, kind: 'task' as const, from: { kind: 'hive' as const, name: 'Hive' }, card: n, body: prompt } // i18n-ignore: who a delivery is from, as agents read it
    const there = !!st && samePlace(st.cwd, folder)
    const go = there
      ? deliverNow(projectPath, { ...nd, need: 'free', conversation: st!.sessionId || null })
      : launchWith(projectPath, nd, (line) => (st ? sessions.newConversation(projectPath, agentId, line) : sessions.start(projectPath, { agentId, prompt: line })))
    log.info(`Giving ${userText(agent.name)} #${n} in ${userText(folder)} (${there ? 'typed in' : st ? 'a new conversation' : 'started'})`)
    void Promise.resolve(go).catch((e) => log.warn(`giving ${userText(agent.name)} #${n} in its slot`, e))
  }
  off = onHiveEvent((e) => {
    if ((e.type === 'session-status' && e.state.agentId === agentId && e.state.projectPath.toLowerCase() === projectPath.toLowerCase()) || e.type === 'progress-changed') look()
  })
  placing.set(key, done)
  look()
}

// --- The actions.

/**
 * A card's start in a slot (`prepareSlot`, written with its `Started`): its line checked out in the slot from the
 * target's head (G15: installed again on a changed lock file), then its builder given the card there. A slot busy for a
 * moment (its setup settling, a session of the lease's draining) is tried again while the lease is open; a failure is
 * told to the user and the builder.
 */
async function prepareSlot(n: number, payload: Record<string, unknown>, ws: WorkspaceService): Promise<void> {
  const lease = typeof payload.lease === 'string' ? payload.lease : null
  if (!lease) return
  const project = projectOfCard(ws, n)
  if (!project) return
  const pool = await poolFor(ws, project)
  const folder = String(payload.folder)
  const line = String(payload.line)
  const was = await G.branch(folder)
  let err: string | null = null
  for (let tries = 0; ; tries++) {
    err = await pool.prepare(lease, { line, base: String(payload.base), install: payload.upToDate === true })
    // Busy for a moment (a job settling, a session of the lease draining): looked at again, while its lease is open.
    if (!err || !/ is busy: /.test(err) || tries >= 150 || pool.lease(lease)?.to) break
    await new Promise((res) => setTimeout(res, 2000))
  }
  if (err) {
    log.warn(`Slot ${userText(String(payload.slot))} couldn't be prepared for #${n}: ${userText(err)}`)
    const wf = await workflowFor(ws, project).catch(() => null)
    if (wf) {
      const card = wf.store.card(n)
      await wf.write(card, null, 'hive', (w) => {
        const english = `Hive couldn't get ${String(payload.slot)} ready for ${card.key}: ${err}` // i18n-ignore: agent-facing, and the notice's English
        w.action('notify', { text: english, shown: workflowText(M.notPrepared, { slot: String(payload.slot), card: card.key, why: err! }) })
        wf.wake(w, typeof payload.builder === 'string' ? payload.builder : null, english)
      })
    }
    return
  }
  // The line it was on before (the lane's last card's): deleted now that nothing has it out, once merged.
  if (!isUnknown(was) && was && was !== line) void deleteMergedLine(ws, project, was)
  if (typeof payload.builder === 'string') void placeBuilder(ws, project, n, payload.builder, lease, folder)
}

/**
 * A card's slot given back (`releaseSlot`: its Done, or put back): its own lease ends (a lane's stays until the lane
 * ends); at Done, its line deleted once merged. Then a lane waiting for a slot may get it.
 */
async function releaseSlot(n: number, ws: WorkspaceService): Promise<void> {
  const project = projectOfCard(ws, n)
  if (!project) return
  const wf = await workflowFor(ws, project).catch(() => null)
  const pool = await poolFor(ws, project)
  const stage = wf ? wf.state(wf.store.card(n)).stage : null
  const l = pool.leaseOf({ card: n })
  if (l) await pool.release(l.id, stage === 'done' ? 'done' : 'putBack')
  if (stage === 'done' && wf) {
    const line = wf.state(wf.store.card(n)).started?.line
    if (line) await deleteMergedLine(ws, project, line)
  }
  await retryWaitingLanes(ws, project)
}

/**
 * A card's line deleted (#1438, §16.10.1) once its card is Done and its target contains it (a squash by its stored key,
 * §16.3.2), and nothing has it checked out: never otherwise. Recorded on the card (`LineDeleted`). Off: Settings →
 * Advanced, Delete a card's branch once it's merged.
 */
export async function deleteMergedLine(ws: WorkspaceService, projectPath: string, line: string): Promise<boolean> {
  if (advanced.get(SLOTS_DELETE_MERGED) === false || !line.startsWith('hive/')) return false
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  if (!wf) return false
  // Its card, by the number its name carries (hive/<KEY>/<KEY>-<n>-…): Done, its start (in a slot) the one that made it.
  const n = Number(/^hive\/[^/]+\/[^/]+?-(\d+)(?:-|$)/.exec(line)?.[1])
  if (!Number.isInteger(n)) return false
  let card: CardRecord
  try {
    card = wf.store.card(n)
  } catch {
    return false
  }
  const s = wf.state(card)
  if (s.stage !== 'done' || !s.started?.lease || s.started.line !== line) return false
  const head = await G.lineHead(projectPath, line)
  if (isUnknown(head) || !head || !s.started) return false
  const target = s.integrated?.target || s.started.target
  if (!target) return false
  const c = await wf.platformOf(card).contains(target, { base: s.started.base ?? head, revision: head, key: s.latest?.key ?? null })
  if (isUnknown(c) || !c) return false
  const out = await listWorktreesOrNull(projectPath).catch(() => null)
  if (!out || out.some((w) => w.branch === line)) return false
  // Only from the head the check read (a commit added meanwhile keeps it).
  const r = await git(projectPath, ['update-ref', '-d', `refs/heads/${line}`, head])
  if (!r.ok) return false
  log.info(`Deleted ${userText(line)} (#${card.id}, merged into ${userText(target)})`)
  await wf.write(card, null, 'hive', (w) => void w.fact('LineDeleted', { line, revision: head, why: 'merged' })).catch((e) => log.warn(`recording ${userText(line)}'s deletion`, e)) // i18n-ignore: a fact's kind and codes, not text
  return true
}

// --- Lanes.

/**
 * A lane's slot (#1438, §16.10.2): lent to its builder as the lane starts from the window (`laneStart.ts`), before its
 * agents start, and kept for the whole lane. None free: the lane waits ("waiting for a slot"), and `start` starts its
 * agents once a lease's end frees one. The slot, or why it waits (English).
 */
export async function lendLane(ws: WorkspaceService, projectPath: string, lane: string, builder: string, start: (slot: string) => Promise<void>): Promise<{ slot: string } | { waiting: string }> {
  const pool = await poolFor(ws, projectPath)
  const r = await pool.lend({ lane, agent: builder }, { install: false })
  if (r.ok) {
    laneWaits.delete(lane)
    log.info(`Lent ${userText(r.slot.name)} to lane ${lane} (lease ${r.lease.id})`)
    return { slot: r.slot.name }
  }
  laneWaits.set(lane, { ws, project: projectPath, builder, start })
  const agents = projectAgents(await ws.projectConfig(projectPath))
  return { waiting: refusalText(r.refusal, (id) => agents.find((a) => a.id === id)?.name ?? id) }
}

/** A project's lanes waiting for a slot, in the order they began waiting, lent one each while one is free (a lease ended). */
async function retryWaitingLanes(ws: WorkspaceService, projectPath: string): Promise<void> {
  for (const [id, w] of [...laneWaits]) {
    if (w.ws !== ws || w.project.toLowerCase() !== projectPath.toLowerCase() || !w.start) continue
    if (ws.lifetime.aborted) return void laneWaits.delete(id)
    const pool = await poolFor(ws, projectPath)
    const r = await pool.lend({ lane: id, agent: w.builder }, { install: false })
    if (!r.ok) return
    laneWaits.delete(id)
    log.info(`Lent ${userText(r.slot.name)} to lane ${id}, which waited for a slot (lease ${r.lease.id})`)
    await w.start(r.slot.name).catch((e) => log.warn(`starting lane ${id} in ${userText(r.slot.name)}`, e))
  }
}

/**
 * Lanes' leases ended with their lanes (#1438): a lane ended or abandoned, or gone, gives its slot back. Looked at when
 * the lanes change, and as the hourly tidy runs.
 */
export async function releaseEndedLanes(ws: WorkspaceService): Promise<void> {
  if (!ws.path) return
  let open: { id: string; project: string; lane: string }[]
  try {
    open = boardRead(ws, (db) => db.prepare('SELECT id, project, lane FROM slot_leases WHERE lane IS NOT NULL AND ended_at IS NULL').all() as { id: string; project: string; lane: string }[]) // i18n-ignore: SQL
  } catch {
    return
  }
  if (!open.length) return
  const lanes = new Map((await listLanes(ws, { all: true })).map((l) => [l.id, l]))
  for (const o of open) {
    const l = lanes.get(o.lane)
    if (l && !l.endedAt) continue
    const project = projectById(ws, o.project)
    if (!project) continue
    const pool = await poolFor(ws, project)
    if (await pool.release(o.id, l?.state === 'abandoned' ? 'laneAbandoned' : 'laneEnded')) log.info(`Lane ${o.lane} ended: its slot's lease ${o.id} ended`)
    laneWaits.delete(o.lane)
    await retryWaitingLanes(ws, project)
  }
}

let stop: (() => void) | null = null

/** Starts cards on slots (index.ts, once): the actions, lanes' leases ending with them, the lanes' view of their slot. */
export function startSlotCards(): void {
  if (stop) return
  onAction('prepareSlot', (a, ws) => prepareSlot(a.card, a.payload, ws))
  onAction('releaseSlot', (a, ws) => releaseSlot(a.card, ws))
  setSlotStarts({ leaseFor: (ws, project, card, builder, o) => leaseForStart(ws, project, card, builder, o), unused: slotUnused })
  // The pool's size: the project's builders (#1430's roles: builders and either), at least one (slots.ts).
  setBuilderCount(async (projectPath) => {
    const ws = workspaceFor(projectPath)
    return ws ? projectAgents(await ws.projectConfig(projectPath)).filter(builds).length : 0
  })
  setLaneSlots(laneSlot)
  setSlotFreed((ws, project) => void retryWaitingLanes(ws, project).catch((e) => log.warn('lanes waiting for a slot', e)))
  const off = onLanesWritten(() => {
    for (const ws of openWorkspaces()) void releaseEndedLanes(ws).catch((e) => log.warn('ending lanes\' slots', e))
  })
  stop = () => {
    off()
    setLaneSlots(null)
    setSlotFreed(null)
    setSlotStarts(null)
    setBuilderCount(null)
    for (const p of placing.values()) p()
  }
}

export function stopSlotCards(): void {
  stop?.()
  stop = null
}
