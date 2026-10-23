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
import { SlotStore, type SlotConn } from './slots'
import { workspace, workspaceOf, type WorkspaceService } from './workspace'
import { launchPlace, resumeFolder, resumeHold, slotAt, type FolderAgent, type FolderFacts, type FolderLease, type FolderPurpose, type FolderSession, type FolderSlot, type ResumeHold } from '../shared/agentFolders'
import { agentWorkflowRole } from '../shared/workflow/roles'
import type { AgentDef, AgentWorktree } from '../shared/types'

const log = createLogger('sessions')

/** Whether #1441 has migrated a project's agents' worktrees into slots: none is until it says so. */
let migratedCheck: (projectPath: string) => boolean | Promise<boolean> = () => false
export function setSlotsMigrated(fn: ((projectPath: string) => boolean | Promise<boolean>) | null): void {
  migratedCheck = fn ?? (() => false)
}

/** A project's retired homes (#1441): folders its agents' conversations resume in, never lent. None until then. */
let homesOf: (projectPath: string) => readonly string[] | Promise<readonly string[]> = () => []
export function setRetiredHomes(fn: ((projectPath: string) => readonly string[] | Promise<readonly string[]>) | null): void {
  homesOf = fn ?? (() => [])
}

/**
 * Who writes: this Hive (its pid and start, as slot operations' holders are known), whether another Hive's process still
 * runs, and whether a session run of this Hive still runs. The app gives its own (slotsApp.ts); unset (unit tests),
 * this process with an unknown start, every other process running, every run of its own running.
 */
export interface WriterHost {
  self(): Promise<{ pid: number; started: number }>
  alive(pid: number, started: number): Promise<boolean | null>
  runLive(run: string): boolean
}
let writerHost: WriterHost = { self: async () => ({ pid: process.pid, started: 0 }), alive: async () => null, runLive: () => true }
export function setWriterHost(h: WriterHost | null): void {
  writerHost = h ?? { self: async () => ({ pid: process.pid, started: 0 }), alive: async () => null, runLive: () => true }
}

/** After a writer is released: the pool records the ended lease's last revision and looks at the slot (slotsApp.ts). */
let drainedHook: ((projectPath: string, slot: string) => Promise<void>) | null = null
export function setWriterDrained(fn: ((projectPath: string, slot: string) => Promise<void>) | null): void {
  drainedHook = fn
}

/**
 * An agent's 0.9 worktree, as project.json stores it (`worktree`). Only the migration (#1441), Repair (#1447) and the
 * folder contract read it: everything else asks agentFolders where an agent works.
 */
export function legacyWorktree(raw: { worktree?: AgentWorktree | null } | null | undefined): AgentWorktree | null {
  const w = raw?.worktree
  return w && typeof w.path === 'string' && w.path ? w : null
}

/** An agent as the contract reads it. */
export const folderAgent = (a: Pick<AgentDef, 'id' | 'name' | 'role' | 'workflowRole' | 'worktree'>): FolderAgent => {
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
  const facts: FolderFacts = { projectPath, migrated: false, homes: [], slots: [] }
  if (workspace.isAssistantHome(projectPath)) return facts
  const ws = workspaceOf(projectPath)
  facts.migrated = await migratedCheck(projectPath)
  facts.homes = await homesOf(projectPath)
  try {
    const project = (await ws.projectConfig(projectPath)).id ?? basename(projectPath)
    facts.slots = boardRead(ws, (db) => slotsIn(db, project))
  } catch {
    // A board still 0.9's, or none open: no slots.
  }
  return facts
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
}

/**
 * Why `claimPlace` refused: its hold now (in its write), its slot still written by another run (`busy`), or changed
 * meanwhile so the user's Resume can't take it (`changed`). Nothing was written.
 */
export class ClaimRefused extends Error {
  constructor(
    readonly why: { is: 'hold'; hold: ResumeHold } | { is: 'busy'; slot: string; agent: string } | { is: 'changed'; slot: string }
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

/** A writer whose run is over: this Hive's run no longer running, or another Hive gone. */
async function writerGone(w: { run: string }, row: { pid: number; started: number }): Promise<boolean> {
  const me = await writerHost.self()
  if (row.pid === me.pid && row.started === me.started) return !writerHost.runLive(w.run)
  return (await writerHost.alive(row.pid, row.started)) === false
}

/**
 * Where a start runs, and its slot claimed for it (#1434). A new conversation: where its purpose has the agent work (a
 * reviewer never in a slot). A conversation: where it was made; outside the slots the project folder and a retired
 * home are any agent's, a 0.9 worktree only its agent's (`foreign` otherwise), a slot's only its own agent's.
 *
 * In a slot, one board write decides again from hive.db as it is then and claims the slot: the resume authority
 * (`resumeHold`: the agent's leases now, the slot's), the user's Resume (`auto` false) of one it lets resume by hand
 * (binding it to the agent's own later lease, or taking the free slot under a new carried lease at the head its
 * conversation's lease ended at, clean), and the slot's writer reserved for `run`, only while no other run writes there
 * (one whose Hive is gone, or whose run of this Hive has ended, is taken over). Refused with ClaimRefused, writing nothing.
 */
export async function claimPlace(projectPath: string, agent: FolderAgent, existing: (FolderSession & { id: string; agentId?: string }) | null, o: { purpose: FolderPurpose; auto: boolean; run: string }): Promise<Claim> {
  const facts = await folderFacts(projectPath)
  let folder: string
  if (existing) {
    folder = resumeFolder(projectPath, existing)
    const slot = slotAt(facts, folder)
    if (!slot) {
      const own = samePlace(folder, projectPath) || facts.homes.some((h) => samePlace(h, folder)) || (!!agent.legacy && samePlace(agent.legacy.path, folder))
      return { cwd: folder, lease: null, slot: null, foreign: !own }
    }
    if (existing.agentId && existing.agentId !== agent.id) return { cwd: folder, lease: null, slot: null, foreign: true }
  } else {
    const p = launchPlace(facts, agent, o.purpose)
    if (!p.lease) return { cwd: p.folder, lease: null, slot: null, foreign: false }
    folder = p.folder
  }
  const { ws, host: sessionsHost, project } = await hostOf(projectPath)
  const store = new SlotStore(boardConn(ws), project)
  // What the write compares against, read before it (git, other processes): the folder's head, and a writer to take over.
  const head = existing && !o.auto ? await headNow(folder) : null
  const before = slotAt(facts, folder)
  const row = before?.writer ? store.slot(before.name) : null
  const stale = before?.writer && row?.writer && (await writerGone(before.writer, row.writer)) ? before.writer.run : null
  const me = await writerHost.self()
  const claimed = await store.conn.write((db) => claimIn(db, store, { facts, folder, agent, existing, ...o, sessionsHost, me, head, stale }))
  if (existing && claimed.lease !== existing.lease) log.info(`Session ${existing.id} resumes in ${userText(claimed.slot.name)} under lease ${claimed.lease}`)
  return { cwd: claimed.slot.folder, lease: claimed.lease, slot: claimed.slot, foreign: false }
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
  /** A writer's run that is over (its Hive gone, or this Hive's run ended), which this claim may take over. */
  stale: string | null
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
  // One writer: this run's from now until it has exited, unless another run (still going) writes there.
  const took = db
    .prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ? AND (writer_run IS NULL OR writer_run = ? OR writer_run = ?)') // i18n-ignore: SQL
    .run(c.run, lease, agent.id, c.me.pid, c.me.started, project, slot.name, c.run, c.stale ?? '')
  if (Number(took.changes) !== 1) throw new ClaimRefused({ is: 'busy', slot: slot.name, agent: slot.writer?.agent ?? '' })
  return { lease, slot: slotsIn(db, project).find((s) => s.name === slot.name)! }
}

/**
 * A run's writer released once it has exited, or its start given up (#1434): only while the slot still names that run.
 * Then the pool records the ended lease's last revision, if its lease ended meanwhile, and looks at the slot.
 */
export async function releaseWriter(projectPath: string, slot: string, run: string): Promise<void> {
  try {
    const { ws, project } = await hostOf(projectPath)
    if (!(await new SlotStore(boardConn(ws), project).clearWriter(slot, run))) return
    await drainedHook?.(projectPath, slot)
  } catch (e) {
    // Its workspace closed meanwhile: the pool clears it at its next refresh (the run is over).
    log.warn(`Slot ${userText(slot)}'s writer ${run} not released: ${userText(e instanceof Error ? e.message : String(e))}`)
  }
}
