// The folder contract in main (#1434, SPEC §16.10.3; the decisions are shared/agentFolders.ts's): what it decides from
// (a project's slots and leases in hive.db, its migration and its retired homes, #1441's), and the one write that lets a
// session start in a slot. That write decides again from hive.db as it is then (`claimPlace`): the resume authority
// (the agent's leases, the slot's), the user's Resume taking a free slot or binding to the agent's own later lease, and
// the slot's **writer** reserved for the start's run, so nothing else lends, adopts, takes or removes the slot until that
// run has exited (`releaseWriter`). A session's bound lease (`sessions.lease`) is set when it starts there and changed
// only by `rebindSession`, inside the same board write as the lease change that needs it.

import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'original-fs'
import { basename } from 'path'
import { boardRead, boardWrite, boardWriteOp } from './boardStore'
import { samePlace } from './fsutil'
import { createLogger, userText } from './logger'
import * as G from './platform/git'
import { isUnknown } from './platform/types'
import { endedEarlier, endProcessesExactly, forgetEarlierRun, forgetKeeperRun, keepRunEnded, keeperState, keeperStillBound, leftoversOfRun, onRunOutcome, runOutcome, runTookWriter, runWriterReleased, setHiveIdentity, settleLeftovers, stillRunningOf, type RunOutcome } from './agentProcesses'
import { hiveError } from './hiveError'
import { msg } from '../shared/i18n'
import { SlotStore, type SlotConn } from './slots'
import { workspace, workspaceOf, type WorkspaceService } from './workspace'
import { agentPlaces, launchPlace, legacyWorktree, resumeFolder, resumeHold, slotAt, type AgentPlace, type FolderAgent, type FolderFacts, type FolderLease, type FolderPurpose, type FolderSession, type FolderSlot, type ResumeHold } from '../shared/agentFolders'
import { agentWorkflowRole } from '../shared/workflow/roles'
import type { AgentDef, HeldWriter } from '../shared/types'

const log = createLogger('sessions')

/**
 * The agents of a project whose 0.9 worktree #1441 has migrated (adopted as a slot, or kept as a retired home); null
 * while it hasn't run on the project. None is until it says so.
 */
type Migrated = readonly string[] | null
let migratedCheck: (projectPath: string) => Migrated | Promise<Migrated> = () => null
export function setSlotsMigrated(fn: ((projectPath: string) => Migrated | Promise<Migrated>) | null): void {
  migratedCheck = fn ?? (() => null)
}
/** Whether #1441 has migrated an agent's 0.9 worktree: its `worktree` then no longer counts for where it works. */
export const slotsMigrated = async (projectPath: string, agentId: string): Promise<boolean> => !!(await migratedCheck(projectPath))?.includes(agentId)

/** A project's retired homes (#1441): folders its agents' conversations resume in, never lent. None until then. */
let homesOf: (projectPath: string) => readonly string[] | Promise<readonly string[]> = () => []
export function setRetiredHomes(fn: ((projectPath: string) => readonly string[] | Promise<readonly string[]>) | null): void {
  homesOf = fn ?? (() => [])
}

/**
 * Who writes (#1434): this Hive (its pid and start, as slot operations' holders are known), its live tokens (the pools'
 * `holder.live`: a writer's run is live from before its claim can be seen until it is released), its pools (a claim is
 * a pool's tracked work, which `close` awaits), and what a pool does once a writer is released (the ended lease's last
 * revision, the slot looked at). The app gives its own (slotsApp.ts); unset (unit tests), stand-ins.
 */
export interface WriterHost {
  self(): Promise<{ pid: number; started: number }>
  /** Whether another Hive (a writer's holder) still runs; null when it can't be told (#1506: then it is taken to). */
  alive(pid: number, started: number): Promise<boolean | null>
  live: Set<string>
  track(projectPath: string): Promise<{ done: () => void } | null>
  drained(projectPath: string, slot: string): Promise<void>
}
const standIn = (): WriterHost => ({ self: async () => ({ pid: process.pid, started: 0 }), alive: async (pid) => pid === process.pid, live: new Set(), track: async () => ({ done: () => undefined }), drained: async () => undefined })
let writerHost: WriterHost = standIn()
export function setWriterHost(h: WriterHost | null): void {
  writerHost = h ?? standIn()
}
// The keeper's receipts name this Hive as its slot writers do (HI-2055): whichever host is set when it is asked.
setHiveIdentity(async () => {
  const me = await writerHost.self()
  return `${me.pid}:${me.started}`
})

// An agent's 0.9 worktree (shared/agentFolders.ts's: workspace.ts reads it too, which this module can't be imported by).
export { legacyWorktree }

/** An agent as the contract reads it. */
export const folderAgent = (a: Pick<AgentDef, 'id' | 'name' | 'role' | 'workflowRole'>): FolderAgent => {
  const w = legacyWorktree(a)
  return { id: a.id, role: agentWorkflowRole(a), legacy: w ? { path: w.path, branch: w.branch } : null }
}

/**
 * The board as a slot store's connection (as slotsApp's boardConn, without the pools: sessions.ts reads the contract,
 * and the pools stop sessions).
 */
function boardConn(ws: WorkspaceService): SlotConn {
  return { read: (fn) => boardRead(ws, fn), write: (fn) => boardWrite(ws, async () => boardWriteOp(ws, fn)), close: () => undefined }
}

type Row = Record<string, unknown>
const leaseOfRow = (r: Row): FolderLease => ({ id: r.id as string, kind: r.kind as FolderLease['kind'], slot: r.slot as string, card: (r.card as number | null) ?? null, lane: (r.lane as string | null) ?? null, agent: r.agent as string })

/** A project's slots as the contract reads them, from one snapshot or write (`db`): each with its open lease, newest lease and writer. */
export function slotsIn(db: DatabaseSync, project: string): FolderSlot[] {
  const rows = db.prepare('SELECT * FROM slots WHERE project = ? ORDER BY name').all(project) as Row[] // i18n-ignore: SQL
  const open = db.prepare('SELECT * FROM slot_leases WHERE project = ? AND slot = ? AND ended_at IS NULL') // i18n-ignore: SQL
  const newest = db.prepare('SELECT * FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1') // i18n-ignore: SQL
  return rows.map((s) => {
    const o = open.get(project, s.name as string) as Row | undefined
    const n = o ?? (newest.get(project, s.name as string) as Row | undefined)
    return {
      name: s.name as string,
      folder: s.folder as string,
      state: s.state as string,
      portBase: s.port_base as number,
      target: (s.target as string | null) ?? null,
      open: o ? leaseOfRow(o) : null,
      last: n ? { ...leaseOfRow(n), ended: n.ended_at !== null, endRev: (n.end_rev as string | null) ?? null } : null,
      writer: s.writer_run ? { run: s.writer_run as string, agent: s.writer_agent as string, lease: s.writer_lease as string } : null
    }
  })
}

/** Where a project's sessions are kept (their host) and its slots' project id. */
async function hostOf(projectPath: string): Promise<{ ws: WorkspaceService; host: string; project: string }> {
  const ws = workspaceOf(projectPath)
  const [{ scope }, cfg] = await Promise.all([workspace.sessionScope(projectPath), ws.projectConfig(projectPath)])
  return { ws, host: scope, project: cfg.id ?? basename(projectPath) }
}

/** What the contract decides from for a project now. A board still 0.9's (no slot tables), or the Assistant's home: no slots. */
export async function folderFacts(projectPath: string): Promise<FolderFacts> {
  const facts: FolderFacts = { projectPath, migrated: false, migratedAgents: [], homes: [], slots: [] }
  if (workspace.isAssistantHome(projectPath)) return facts
  const ws = workspaceOf(projectPath)
  const migrated = await migratedCheck(projectPath)
  facts.migrated = migrated !== null
  facts.migratedAgents = migrated ?? []
  facts.homes = await homesOf(projectPath)
  facts.slots = await boardSlots(projectPath, ws)
  return facts
}

/**
 * A project's slots as the board records them, and nothing else: a read that never makes the slot pool or asks the
 * 0.9 migration anything (the Changes tab's picker, HI-1824, reads it as the project opens). None when the board is
 * still 0.9's or none is open.
 */
export async function boardSlots(projectPath: string, ws = workspaceOf(projectPath)): Promise<FolderSlot[]> {
  try {
    const project = (await ws.projectConfig(projectPath)).id ?? basename(projectPath)
    return boardRead(ws, (db) => slotsIn(db, project))
  } catch {
    return []
  }
}

/**
 * Where an agent works, for the Agent API and main's readers (#1451): where it is now (its running session's folder, else
 * where a new conversation would start) and where its next new conversation starts, each named and with why
 * (`agentPlaces`), `branch`, the line of the slot it is in now: the card last started under that slot's open lease,
 * else a carried slot's or 0.9 worktree's own branch, and `target`, the branch that card's line merges into (its
 * `Started` fact's, #1627), when known. `facts`: read once for several agents.
 */
export async function agentPlace(projectPath: string, agent: Pick<AgentDef, 'id' | 'name' | 'role' | 'workflowRole'>, running: { cwd: string } | null, facts?: FolderFacts): Promise<{ now: AgentPlace; launch: AgentPlace; branch: string | null; target: string | null }> {
  const f = facts ?? (await folderFacts(projectPath))
  const places = agentPlaces(f, folderAgent(agent), running)
  const slot = places.now.slot ? (f.slots.find((s) => s.name === places.now.slot) ?? null) : null
  const legacy = legacyWorktree(agent)
  let started: LeaseStart | null = null
  if (slot?.open) {
    try {
      started = boardRead(workspaceOf(projectPath), (db) => leaseStart(db, slot.open!.id))
    } catch {
      // A board still 0.9's: no lines.
    }
  }
  let branch = started?.line ?? null
  if (!branch && legacy && (slot?.open?.kind === 'carried' || samePlace(places.now.path, legacy.path))) branch = legacy.branch
  return { ...places, branch, target: started?.target ?? null }
}

/**
 * An agent's open lease in a project's slots and its line (#1451: branchWatch's): its dispatch lease (a card's or a
 * lane's), else its carried one, with the slot's folder and the line's target: the card's own (its `Started` fact's,
 * #1627: a lane's slot keeps the target it was lent with), else the slot's; null: none open.
 */
export function leasedLine(db: DatabaseSync, project: string, agentId: string): { folder: string; target: string | null; line: string | null; carried: boolean } | null {
  const l = db
    .prepare("SELECT l.id, l.kind, s.folder, s.target FROM slot_leases l JOIN slots s ON s.project = l.project AND s.name = l.slot WHERE l.project = ? AND l.agent = ? AND l.ended_at IS NULL ORDER BY l.kind = 'carried' LIMIT 1") // i18n-ignore: SQL
    .get(project, agentId) as { id: string; kind: string; folder: string; target: string | null } | undefined
  if (!l) return null
  const started = leaseStart(db, l.id)
  return { folder: l.folder, target: started?.target ?? l.target, line: started?.line ?? null, carried: l.kind === 'carried' }
}

/** The line of the card last started under a lease and the branch it merges into (its `Started` fact's). */
interface LeaseStart {
  line: string | null
  target: string | null
}

/** The card last started under a lease: its line and target (its `Started` fact's), or null. */
export function leaseStart(db: DatabaseSync, lease: string): LeaseStart | null {
  const r = db.prepare("SELECT json_extract(data, '$.line') AS line, json_extract(data, '$.target') AS target FROM card_facts WHERE kind = 'Started' AND json_extract(data, '$.lease') = ? ORDER BY at DESC LIMIT 1").get(lease) as { line: string | null; target: string | null } | undefined // i18n-ignore: SQL
  return r ? { line: r.line ?? null, target: r.target || null } : null
}

/** Why a bind or rebind was refused (in English: the log and agents). */
export class RebindRefused extends Error {}

/**
 * Binds a session to a lease, in a write on the board (`db`): only the row's `lease` changes, never its folder or its
 * conversation's id. Allowed only when the lease's slot is the session's recorded folder and the lease is its agent's;
 * a rebind needs the lease open, a first bind (`first`: the session had none, its start's own lease) not. Throws
 * RebindRefused, so the write it is part of is undone with it: the lease change and the rebinding land together or not
 * at all.
 */
export function rebindSession(db: DatabaseSync, host: string, project: string, sessionId: string, toLease: string, o: { first?: boolean } = {}): void {
  const s = db.prepare('SELECT cwd, agent_id, lease FROM sessions WHERE host = ? AND id = ?').get(host, sessionId) as { cwd: string | null; agent_id: string | null; lease: string | null } | undefined // i18n-ignore: SQL
  if (!s) throw new RebindRefused(`no session ${sessionId}`) // i18n-ignore: the log
  const l = db.prepare('SELECT l.agent, l.ended_at, s.folder FROM slot_leases l JOIN slots s ON s.project = l.project AND s.name = l.slot WHERE l.id = ? AND l.project = ?').get(toLease, project) as { agent: string; ended_at: string | null; folder: string } | undefined // i18n-ignore: SQL
  if (!l) throw new RebindRefused(`no lease ${toLease}`) // i18n-ignore: the log
  if (l.ended_at !== null && !(o.first && s.lease === null)) throw new RebindRefused(`lease ${toLease} has ended`) // i18n-ignore: the log
  if (!s.agent_id || l.agent !== s.agent_id) throw new RebindRefused(`lease ${toLease} is another agent's`) // i18n-ignore: the log
  if (!s.cwd || !samePlace(l.folder, s.cwd)) throw new RebindRefused(`lease ${toLease} is of another folder`) // i18n-ignore: the log
  if (s.lease !== toLease) db.prepare('UPDATE sessions SET lease = ? WHERE host = ? AND id = ?').run(toLease, host, sessionId) // i18n-ignore: SQL
}

/** A session started in a slot, as it is recorded: bound to the lease it started under. Logged, never thrown. */
export async function bindSession(projectPath: string, sessionId: string, lease: string): Promise<void> {
  try {
    const { ws, host, project } = await hostOf(projectPath)
    await boardWrite(ws, async () => boardWriteOp(ws, (db) => rebindSession(db, host, project, sessionId, lease, { first: true })))
  } catch (e) {
    log.warn(`Session ${sessionId} not bound to lease ${lease}: ${userText(e instanceof Error ? e.message : String(e))}`)
  }
}

/** A session's hold as the contract decides it now (null: it may resume now). */
export async function holdOf(projectPath: string, agent: FolderAgent, s: FolderSession): Promise<ResumeHold | null> {
  return resumeHold(await folderFacts(projectPath), agent, s)
}

/** Where a start runs: its folder, the slot lease it runs under (its slot's writer then reserved for its run), and whether it is another agent's. */
export interface Claim {
  cwd: string
  lease: string | null
  slot: FolderSlot | null
  foreign: boolean
  /**
   * In a slot: ends the claim's tracked work (the pool's `close` awaits it), once its start has spawned its process or
   * has released the writer. Called once; outside a slot, nothing.
   */
  done: () => void
}

/**
 * Why `claimPlace` refused: its hold now (in its write), its slot still written by another run or held by one whose
 * processes aren't known to have ended (`busy`), being set up or installed (`setup`: an operation, an unsettled job, or
 * not ready), changed meanwhile so the user's Resume can't take it (`changed`), or its workspace closing (`closing`).
 * Nothing was written.
 */
export class ClaimRefused extends Error {
  constructor(
    readonly why: { is: 'hold'; hold: ResumeHold } | { is: 'busy'; slot: string; agent: string } | { is: 'setup'; slot: string } | { is: 'changed'; slot: string } | { is: 'closing' }
  ) {
    super(`refused: ${JSON.stringify(why)}`) // i18n-ignore: the log; sessions.ts words it
  }
}

/** What the user's Resume taking a free slot compares in its write: the folder's head now, clean (null: dirty or unknown). */
async function headNow(folder: string): Promise<string | null> {
  if (!existsSync(folder)) return null
  const [head, dirty] = await Promise.all([G.head(folder), G.dirty(folder)])
  return isUnknown(head) || isUnknown(dirty) || dirty.length ? null : head
}

/**
 * Where a start runs, and its slot claimed for it (#1434). A new conversation: where its purpose has the agent work (a
 * reviewer never in a slot). A conversation: where it was made; outside the slots the project folder and a retired
 * home are any agent's, a 0.9 worktree only its agent's (`foreign` otherwise), a slot's only its own agent's.
 *
 * In a slot, its run's token is live from here (before its claim can be seen) and the claim is its pool's tracked work
 * (`done`); then one board write decides again from hive.db as it is then and claims the slot (`claimIn`). Refused with
 * ClaimRefused, writing nothing; the token and the tracked work end with the refusal.
 */
export async function claimPlace(projectPath: string, agent: FolderAgent, existing: (FolderSession & { id: string; agentId?: string }) | null, o: { purpose: FolderPurpose; auto: boolean; run: string }): Promise<Claim> {
  const facts = await folderFacts(projectPath)
  const none = (): void => undefined
  let folder: string
  if (existing) {
    folder = resumeFolder(projectPath, existing)
    const slot = slotAt(facts, folder)
    if (!slot) {
      const own = samePlace(folder, projectPath) || facts.homes.some((h) => samePlace(h, folder)) || (!!agent.legacy && samePlace(agent.legacy.path, folder))
      return { cwd: folder, lease: null, slot: null, foreign: !own, done: none }
    }
    if (existing.agentId && existing.agentId !== agent.id) return { cwd: folder, lease: null, slot: null, foreign: true, done: none }
  } else {
    const p = launchPlace(facts, agent, o.purpose)
    if (!p.lease) return { cwd: p.folder, lease: null, slot: null, foreign: false, done: none }
    folder = p.folder
  }
  writerHost.live.add(o.run)
  let tracked: { done: () => void } | null = null
  try {
    tracked = await writerHost.track(projectPath)
    if (!tracked) throw new ClaimRefused({ is: 'closing' })
    const { ws, host: sessionsHost, project } = await hostOf(projectPath)
    const store = new SlotStore(boardConn(ws), project)
    const at = slotAt(facts, folder)
    if (at?.writer) await settleGoneWriterOf(projectPath, store, at.name, o.run)
    // What the write compares against, read before it (git): the folder's head, for the user's Resume taking a free slot.
    const head = existing && !o.auto ? await headNow(folder) : null
    const me = await writerHost.self()
    const claimed = await store.conn.write((db) => claimIn(db, store, { facts, folder, agent, existing, ...o, sessionsHost, me, head }))
    // Kept as ended at a quit until its release is written (HI-2299).
    runTookWriter(o.run)
    if (existing && claimed.lease !== existing.lease) log.info(`Session ${existing.id} resumes in ${userText(claimed.slot.name)} under lease ${claimed.lease}`)
    return { cwd: claimed.slot.folder, lease: claimed.lease, slot: claimed.slot, foreign: false, done: tracked.done }
  } catch (e) {
    // Nothing was claimed: the run's token and the claim's tracked work end here.
    writerHost.live.delete(o.run)
    tracked?.done()
    throw e
  }
}

/** What `claimIn` decides from, besides hive.db: what was read before its write. */
export interface ClaimInput {
  /** The project's facts as read before (its migration and homes; its slots are read again in the write). */
  facts: FolderFacts
  /** The slot's folder: where the conversation was made, or where the new one starts. */
  folder: string
  agent: FolderAgent
  existing: (FolderSession & { id: string }) | null
  purpose: FolderPurpose
  auto: boolean
  run: string
  /** Where the project's sessions are kept (their host in hive.db). */
  sessionsHost: string
  /** This Hive, as the writer's holder. */
  me: { pid: number; started: number }
  /** The folder's head now, clean (null: dirty or unknown): what the user's Resume taking a free slot compares. */
  head: string | null
}

/**
 * `claimPlace`'s write (#1434), on the board's database: decided from hive.db as it is in this write, the slot claimed
 * for `run` as its writer, with the user's Resume's bind or new lease. Throws ClaimRefused, undoing the write.
 */
export function claimIn(db: DatabaseSync, store: SlotStore, c: ClaimInput): { lease: string; slot: FolderSlot } {
  const { agent, existing, folder, sessionsHost } = c
  const project = store.project
  const now: FolderFacts = { ...c.facts, slots: slotsIn(db, project) }
  const slot = slotAt(now, folder)
  if (!slot) throw new ClaimRefused({ is: 'changed', slot: '' })
  let lease: string
  if (existing) {
    const hold = resumeHold(now, agent, existing)
    if (hold && (hold.is !== 'byHand' || c.auto)) throw new ClaimRefused({ is: 'hold', hold })
    if (hold?.is === 'byHand' && hold.how === 'rebind') {
      try {
        rebindSession(db, sessionsHost, project, existing.id, hold.lease)
      } catch (e) {
        if (e instanceof RebindRefused) throw new ClaimRefused({ is: 'changed', slot: slot.name })
        throw e
      }
      lease = hold.lease
    } else if (hold?.is === 'byHand') {
      // Free, set up and clean, still last lent under this conversation's lease, ended at the head it has now.
      const last = db.prepare('SELECT id, end_rev FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1').get(project, slot.name) as { id: string; end_rev: string | null } | undefined // i18n-ignore: SQL
      if (!c.head || slot.state !== 'ready' || (last?.id ?? '') !== hold.lease || (last && last.end_rev !== c.head)) throw new ClaimRefused({ is: 'changed', slot: slot.name })
      const target = (db.prepare('SELECT target FROM slots WHERE project = ? AND name = ?').get(project, slot.name) as { target: string | null } | undefined)?.target ?? null // i18n-ignore: SQL
      const taken = store.carryIn(db, agent.id, { name: slot.name, folder: slot.folder, target })
      if (!taken) throw new ClaimRefused({ is: 'changed', slot: slot.name })
      try {
        rebindSession(db, sessionsHost, project, existing.id, taken.id)
      } catch (e) {
        if (e instanceof RebindRefused) throw new ClaimRefused({ is: 'changed', slot: slot.name })
        throw e
      }
      lease = taken.id
    } else lease = slot.open!.id
  } else {
    const p = launchPlace(now, agent, c.purpose)
    if (!p.lease || !samePlace(p.folder, folder)) throw new ClaimRefused({ is: 'changed', slot: slot.name })
    lease = p.lease.id
  }
  // One writer: this run's from now until its processes are known to have ended. Only into a slot set up and lent, with
  // no operation (warming, installing, removal) or unsettled job, and no other writer (a writer whose Hive is gone stays
  // until the user releases the slot): #1429's operations and a writer exclude each other both ways.
  const took = db
    .prepare("UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ? AND state = 'lent' AND op IS NULL AND job IS NULL AND (writer_run IS NULL OR writer_run = ?)") // i18n-ignore: SQL
    .run(c.run, lease, agent.id, c.me.pid, c.me.started, project, slot.name, c.run)
  if (Number(took.changes) !== 1) {
    const row = db.prepare('SELECT state, op, job, writer_run, writer_agent FROM slots WHERE project = ? AND name = ?').get(project, slot.name) as { state: string; op: string | null; job: string | null; writer_run: string | null; writer_agent: string | null } | undefined // i18n-ignore: SQL
    if (row?.writer_run && row.writer_run !== c.run) throw new ClaimRefused({ is: 'busy', slot: slot.name, agent: row.writer_agent ?? '' })
    throw new ClaimRefused({ is: 'setup', slot: slot.name })
  }
  return { lease, slot: slotsIn(db, project).find((s) => s.name === slot.name)! }
}

/**
 * A run's writer released at once (#1434): its start never spawned a process, so nothing of it can run. Cleared in each
 * slot still naming that run (fenced by it), then drained; the run's token ends only after that.
 */
export async function releaseWriter(projectPath: string, run: string): Promise<void> {
  try {
    const { ws, project } = await hostOf(projectPath)
    for (const slot of await new SlotStore(boardConn(ws), project).clearWriterRun(run)) await writerHost.drained(projectPath, slot)
    runWriterReleased(run)
    log.info(`The slot writer ${run} was released`)
  } catch (e) {
    // Its workspace closed meanwhile: the row stays, held, until a refresh of this Hive clears it (writerOver), or, this
    // Hive gone by then, a later one settles it from the run's kept record (HI-1886).
    log.warn(`The slot writer ${run} wasn't released: ${userText(e instanceof Error ? e.message : String(e))}`)
    released.add(run)
    keepRunEnded(run)
  } finally {
    writerHost.live.delete(run)
  }
}

/** Runs whose processes are known to have ended but whose writer couldn't be cleared (a refresh of this Hive clears it). */
const released = new Set<string>()

/**
 * A run that spawned processes has exited (#1434): its writer is released only once its launch's job has shown them
 * all ended (`ended`, agentProcesses.ts), its token live until then, so nothing else recovers it meanwhile. Kept running
 * by the user, or not known (untracked, the job unreadable, the tracker lost): it stays held, its token ended, until
 * the user releases the slot; nothing is taken from a snapshot.
 */
export async function settleWriter(projectPath: string, run: string): Promise<void> {
  const outcome =
    runOutcome(run) ??
    (await new Promise<RunOutcome>((resolve) => {
      const off = onRunOutcome((r, o) => {
        if (r !== run) return
        off()
        resolve(o)
      })
      const now = runOutcome(run)
      if (now) {
        off()
        resolve(now)
      }
    }))
  if (outcome === 'ended') return releaseWriter(projectPath, run)
  log.warn(`The slot writer ${run} stays held: its processes ${outcome === 'kept' ? 'were kept running' : "aren't known to have ended"}`)
  writerHost.live.delete(run)
}

/**
 * Whether a refresh may clear this writer (#1434): this Hive's, its run over (its token ended) and its processes known
 * to have ended, though its release couldn't be written. Never another Hive's, nor one whose processes aren't known.
 */
export async function writerOver(w: { run: string; pid: number; started: number }): Promise<boolean> {
  const me = await writerHost.self()
  return w.pid === me.pid && w.started === me.started && !writerHost.live.has(w.run) && released.has(w.run) && runOutcome(w.run) !== 'kept'
}

/**
 * Whether a writer is held (#1506): its run isn't live here and its Hive is this one or one known to have gone, so only
 * the user's Release Slot… frees it. Another Hive still running (or one that can't be told) holds its own writer.
 */
export async function writerHeld(w: { run: string; pid: number; started: number }): Promise<boolean> {
  const me = await writerHost.self()
  if (w.pid === me.pid && w.started === me.started) return !writerHost.live.has(w.run)
  return (await writerHost.alive(w.pid, w.started)) === false
}

/** A project's held writers by agent (#1506): the agent's ⋯ offers Release Slot… for its slot. */
export async function heldSlots(projectPath: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (workspace.isAssistantHome(projectPath)) return out
  const { ws, project } = await hostOf(projectPath)
  for (const s of new SlotStore(boardConn(ws), project).slots()) if (s.writer && !out.has(s.writer.agent) && (await writerHeld(s.writer))) out.set(s.writer.agent, s.name)
  return out
}

/**
 * A slot's writer as Release Slot… shows it (#1506): who holds it (its Hive, this one or another, and whether that one
 * still runs), whether its run is still live (this Hive's, its token not ended: a session, or leftovers being followed),
 * and what Hive lists of its processes (null: nothing listed, so not known). Null when the slot has no writer.
 */
export async function heldWriter(projectPath: string, slot: string): Promise<HeldWriter | null> {
  const { ws, project } = await hostOf(projectPath)
  const w = new SlotStore(boardConn(ws), project).slot(slot)?.writer
  if (!w) return null
  const me = await writerHost.self()
  const self = w.pid === me.pid && w.started === me.started
  const alive = self ? true : await writerHost.alive(w.pid, w.started)
  const left = runLeftovers(w.run)
  return {
    slot,
    agent: w.agent,
    run: w.run,
    hive: { pid: w.pid, self, alive },
    live: self && writerHost.live.has(w.run),
    processes: left ? { list: left.processes, more: left.more, from: 'leftovers' } : !self && alive === false ? await restartList(projectPath, w) : null
  }
}

/** What a run left running, as listed: by this Hive, or kept from before it started (#614's restore names it `restored:`). */
const runLeftovers = (run: string): ReturnType<typeof leftoversOfRun> => leftoversOfRun(run) ?? leftoversOfRun(`restored:${run}`)

/**
 * A slot writer of a Hive that has gone, settled by itself (HI-1886: after a restart, builders' slots stayed held by
 * their own ended runs): true when it may be cleared. Only when this profile kept that its run's processes were seen to
 * end (its job seen empty, the proof a release needs; `endedEarlier`), or, its Hive gone first, the helper that held its
 * job saw it empty after (HI-2055: its keeper's "ended", from the helper this run was bound to, unrevoked, `keeperState`).
 * A list of its processes taken earlier (the last run's marker) never is: what they started since isn't in it (HR2's
 * round 1). Nothing kept, or its Hive still running or not known to have gone: it stays held for the user's Release Slot….
 */
export async function goneWriterSettles(projectPath: string, w: { run: string; agent: string; pid: number; started: number }): Promise<GoneEvidence | false> {
  const me = await writerHost.self()
  if ((w.pid === me.pid && w.started === me.started) || (await writerHost.alive(w.pid, w.started)) !== false) return false
  if (await endedEarlier(w.run)) {
    log.info(`The slot writer ${w.run} in ${userText(basename(projectPath))} of a Hive that has gone (process ${w.pid}) settled: its processes were seen to end`)
    return Object.freeze({ run: w.run, helper: null })
  }
  const kept = await keeperState(w.run, `${w.pid}:${w.started}`)
  if (kept?.state !== 'ended') return false
  log.info(`The slot writer ${w.run} in ${userText(basename(projectPath))} settled: ${userText(w.agent)}'s ended run left nothing running (its Hive, process ${w.pid}, gone; seen by its helper ${kept.helper})`)
  return Object.freeze({ run: w.run, helper: kept.helper })
}

/**
 * What settled a gone Hive's writer, for that one attempt's clear (HR2's round 1: never shared between attempts): its run,
 * and the helper whose keeper's receipt it was (null: this profile kept its run as seen ended).
 */
export interface GoneEvidence {
  readonly run: string
  readonly helper: string | null
}

/**
 * Checked inside the write that clears a settled writer (HI-2055): settled by its keeper's receipt, it is cleared only if
 * that helper is still the one its run is bound to, unrevoked (a revocation during the read refuses the clear).
 */
export function goneWriterStill(evidence: GoneEvidence): () => void {
  const { run, helper } = evidence
  return () => {
    if (helper !== null && !keeperStillBound(run, helper)) throw new Error(`the slot writer ${run}'s helper ${helper} was revoked`) // i18n-ignore: caught by its callers, never shown
  }
}

/**
 * A writer cleared other than by its own release (HI-2303): by the user (Release Slot…), or by a refresh of this Hive
 * (`writerOver`). Nothing reads its run's records again: its kept record, its keeper's binding and state go.
 */
export function writerCleared(run: string): void {
  released.delete(run)
  runWriterReleased(run)
  forgetEarlierRun(run)
  forgetKeeperRun(run)
}

/**
 * A gone Hive's writer cleared (HI-1886): its run's kept record is no longer needed, nor its keeper's (HI-2055), whichever
 * proof cleared it (HR1 on HI-2303: a run can have both, and one cleared by its kept record left its binding behind).
 */
export function goneWriterCleared(run: string, _evidence?: GoneEvidence): void {
  forgetEarlierRun(run)
  forgetKeeperRun(run)
}

/**
 * The slot a start claims, its writer a gone Hive's (HI-1886): settled first when it may be (`goneWriterSettles`), so a
 * restart's resume takes its own slot back.
 */
async function settleGoneWriterOf(projectPath: string, store: SlotStore, slot: string, run: string): Promise<void> {
  const w = store.slot(slot)?.writer
  if (!w || w.run === run) return
  const evidence = await goneWriterSettles(projectPath, w)
  if (!evidence) return
  if (!(await store.clearWriter(slot, w.run, goneWriterStill(evidence)).catch(() => false))) return
  goneWriterCleared(w.run, evidence)
  await writerHost.drained(projectPath, slot)
}

/**
 * What the notice that Hive closed unexpectedly lists of a held writer's own run (#1506: its Hive gone, the run's own
 * leftovers not listed): that launch's processes in the last run's marker (by its run, and its agent and project), those
 * that still run now, each by id and start time. Another launch of the same agent's, a marker of another Hive's, or one
 * from before launches named their run, is never this run's: null then, as when none still runs or it can't be told.
 */
async function restartList(projectPath: string, w: { run: string; agent: string; pid: number; started: number }): Promise<HeldWriter['processes']> {
  // Its keeper's members first (HI-2055: what the helper holding its job last saw there), each checked again by id and
  // start time: one that can't be is never listed as running.
  const keeper = await keeperState(w.run, `${w.pid}:${w.started}`)
  if (keeper?.state === 'live') {
    const running = await stillRunningOf(keeper.members)
    return running?.length ? { list: running, more: 0, from: 'restart' } : null
  }
  const { lastUnexpectedClose } = await import('./lastRun')
  const kept = (lastUnexpectedClose()?.processes ?? []).filter((l) => l.runId === w.run && l.agentId === w.agent && samePlace(l.projectPath, projectPath)).flatMap((l) => l.processes)
  const running = kept.length ? await stillRunningOf(kept) : null
  return running?.length ? { list: running, more: 0, from: 'restart' } : null
}

/**
 * The user's recovery of a held writer (#1506, Release Slot…): with `end`, what Hive lists of its run's processes is
 * ended first; then the writer is cleared in a write fenced by its run, and drained (the ended lease's last revision,
 * the slot looked at). Refused while its Hive still runs (another one, or one that can't be told) or its run is live
 * here, and when the slot's writer is no longer that run (a claim or a release meanwhile: one outcome). `guard` (#1561:
 * the Assistant's Control and session) runs just before the processes are ended and in the write that clears it.
 */
export async function releaseHeldWriter(projectPath: string, slot: string, run: string, o: { end: boolean; guard?: () => void }): Promise<void> {
  const changed = (): Error => hiveError(msg({ id: 'slots.release.changed', defaultMessage: '{slot} changed meanwhile: its writer is no longer the one shown. Look again.', description: 'Release Slot… refused: the slot ({slot}, such as slot-b) was released or taken by another run while the question was open.' }), { slot }, { kind: 'conflict' })
  const w = await heldWriter(projectPath, slot)
  if (!w || w.run !== run) throw changed()
  if (w.live) throw hiveError(msg({ id: 'slots.release.live', defaultMessage: "{slot}'s writer is still running in this Hive: stop the agent, or end or keep what it left running, first.", description: "Release Slot… refused: the session writing in the slot ({slot}) still runs in this Hive, or Hive still follows the processes it left running (End or Keep Running in the agent's ⋯ menu settles them)." }), { slot }, { kind: 'conflict' })
  if (!w.hive.self && w.hive.alive !== false) throw hiveError(msg({ id: 'slots.release.otherHive', defaultMessage: '{slot} is held by another Hive that is still running (process {pid}): release it there, or quit that Hive first.', description: 'Release Slot… refused: another running copy of Hive (its process id {pid}) holds the slot ({slot}).' }), { slot, pid: w.hive.pid }, { kind: 'conflict' })
  if (o.end && w.processes) o.guard?.()
  if (o.end && w.processes?.from === 'leftovers') await settleLeftovers(projectPath, w.agent, 'end', run)
  if (o.end && w.processes?.from === 'restart' && !(await endProcessesExactly(w.processes.list))) {
    throw hiveError(msg({ id: 'slots.release.notEnded', defaultMessage: "Some of the processes listed still run: Windows didn't let Hive end them, so {slot} wasn't released. Try again, or release it without ending them.", description: 'Release Slot… with "End these processes first": ending the listed processes failed (Windows refused), so the slot ({slot}) was left as it was.' }), { slot }, { kind: 'conflict' })
  }
  const { ws, project } = await hostOf(projectPath)
  if (!(await new SlotStore(boardConn(ws), project).clearWriter(slot, run, o.guard))) throw changed()
  writerCleared(run)
  log.info(`The slot writer ${run} on ${userText(slot)} released by the user (its Hive ${w.hive.self ? 'this one' : `process ${w.hive.pid}, gone`}${o.end && w.processes ? ', its listed processes ended first' : ''})`)
  await writerHost.drained(projectPath, slot)
}
