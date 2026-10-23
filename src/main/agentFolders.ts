// The folder contract in main (#1434, SPEC §16.10.3; the decisions are shared/agentFolders.ts's): what it decides from
// (a project's slots and leases in hive.db, its migration and its retired homes, #1441's), the session's bound lease
// (`sessions.lease`), set when a session starts in a slot and changed only by `rebindSession`, inside the same board
// write as the lease change that needs it, and the user's Resume of a conversation whose slot is free (a new lease of
// it for the agent and the session bound to it, in one write).

import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'original-fs'
import { basename } from 'path'
import { boardRead, boardWrite, boardWriteOp } from './boardStore'
import { samePlace } from './fsutil'
import { createLogger, userText } from './logger'
import * as G from './platform/git'
import { isUnknown } from './platform/types'
import { SlotStore, type SlotConn, type SlotLease } from './slots'
import { workspace, workspaceOf, type WorkspaceService } from './workspace'
import { resumeHold, type FolderAgent, type FolderFacts, type FolderLease, type FolderSession, type FolderSlot, type ResumeHold } from '../shared/agentFolders'
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

const leaseOf = (l: SlotLease): FolderLease => ({ id: l.id, kind: l.kind, slot: l.slot, card: l.card, lane: l.lane, agent: l.agent })

/**
 * The board as a slot store's connection (as slotsApp's boardConn, without the pools: sessions.ts reads the contract,
 * and the pools stop sessions).
 */
function boardConn(ws: WorkspaceService): SlotConn {
  return { read: (fn) => boardRead(ws, fn), write: (fn) => boardWrite(ws, async () => boardWriteOp(ws, fn)), close: () => undefined }
}

/** A project's slots' store on its workspace's board: its id as the pool keys it (poolFor). */
async function storeOf(ws: WorkspaceService, projectPath: string): Promise<SlotStore> {
  const cfg = await ws.projectConfig(projectPath)
  return new SlotStore(boardConn(ws), cfg.id ?? basename(projectPath))
}

/** What the contract decides from for a project now. A board still 0.9's (no slot tables), or the Assistant's home: no slots. */
export async function folderFacts(projectPath: string): Promise<FolderFacts> {
  const facts: FolderFacts = { projectPath, migrated: false, homes: [], slots: [] }
  if (workspace.isAssistantHome(projectPath)) return facts
  const ws = workspaceOf(projectPath)
  facts.migrated = await migratedCheck(projectPath)
  facts.homes = await homesOf(projectPath)
  let store: SlotStore
  try {
    store = await storeOf(ws, projectPath)
    facts.slots = slotsOf(store)
  } catch {
    // A board still 0.9's, or none open: no slots.
  }
  return facts
}

/** The store's slots as the contract reads them: each with its open lease and its newest. */
function slotsOf(store: SlotStore): FolderSlot[] {
  return store.slots().map((s) => {
    const open = store.openLease(s.name)
    const last = open ?? store.lastLease(s.name)
    return { name: s.name, folder: s.folder, state: s.state, portBase: s.portBase, open: open ? leaseOf(open) : null, last: last ? { ...leaseOf(last), ended: !!last.to } : null }
  })
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

/** Where a project's sessions are kept (their host) and its slots' project id. */
async function hostOf(projectPath: string): Promise<{ ws: WorkspaceService; host: string; project: string }> {
  const ws = workspaceOf(projectPath)
  const [{ scope }, cfg] = await Promise.all([workspace.sessionScope(projectPath), ws.projectConfig(projectPath)])
  return { ws, host: scope, project: cfg.id ?? basename(projectPath) }
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

/**
 * One writer per slot (#1434): under the board's lock (a lease's start or end waits for it, and it for them), whether
 * `lease` is still the slot's open lease, the agent's. A launch checks it last, after what it awaited.
 */
export async function writerHolds(projectPath: string, slot: string, agentId: string, lease: string): Promise<boolean> {
  const { ws, project } = await hostOf(projectPath)
  return boardWrite(ws, async () =>
    boardWriteOp(ws, (db) => {
      const open = db.prepare('SELECT id, agent FROM slot_leases WHERE project = ? AND slot = ? AND ended_at IS NULL').get(project, slot) as { id: string; agent: string } | undefined // i18n-ignore: SQL
      return !!open && open.id === lease && open.agent === agentId
    })
  )
}

/** A session's hold as the contract decides it now (null: it may resume now). */
export async function holdOf(projectPath: string, agent: FolderAgent, s: FolderSession): Promise<ResumeHold | null> {
  return resumeHold(await folderFacts(projectPath), agent, s)
}

/**
 * The user's Resume of a conversation its contract lets resume by hand: binds it to the agent's open lease of its slot
 * (`rebind`), or takes its free slot for the agent under a new carried lease and binds it to that, in one write, only
 * while the slot is still free, set up, clean and at the head its lease ended at (`take`). The lease it now runs under,
 * or null when the slot changed meanwhile (then nothing was written).
 */
export async function claimByHand(projectPath: string, agentId: string, sessionId: string, folder: string, hold: Extract<ResumeHold, { is: 'byHand' }>): Promise<string | null> {
  const { ws, host, project } = await hostOf(projectPath)
  if (hold.how === 'rebind') {
    try {
      await boardWrite(ws, async () => boardWriteOp(ws, (db) => rebindSession(db, host, project, sessionId, hold.lease)))
      return hold.lease
    } catch (e) {
      if (e instanceof RebindRefused) return null
      throw e
    }
  }
  // Its revision now: the head its lease ended at, and nothing changed since.
  if (!existsSync(folder)) return null
  const [head, dirty] = await Promise.all([G.head(folder), G.dirty(folder)])
  if (isUnknown(head) || isUnknown(dirty) || dirty.length) return null
  const lease = await takeByHand(new SlotStore(boardConn(ws), project), host, agentId, sessionId, folder, hold, head)
  if (lease) log.info(`Session ${sessionId} resumes in ${userText(hold.slot)} under a new lease ${lease}`)
  return lease
}

/**
 * The write of the user's Resume taking a free slot (`claimByHand`): a new carried lease of it for the agent and the
 * session bound to it, together, only while the slot is set up and free, and the lease it was last lent under is still
 * the conversation's, ended at `head` (the folder's head now). The new lease, or null (nothing written).
 */
export async function takeByHand(store: SlotStore, host: string, agentId: string, sessionId: string, folder: string, hold: Extract<ResumeHold, { is: 'byHand' }>, head: string): Promise<string | null> {
  const lease = await store.carry(agentId, { name: hold.slot, folder, target: store.slot(hold.slot)?.target ?? null }, (db, l, had) => {
    if (!had || had.state !== 'ready') return false
    const last = db.prepare('SELECT id, end_rev FROM slot_leases WHERE project = ? AND slot = ? AND id <> ? ORDER BY from_at DESC LIMIT 1').get(store.project, hold.slot, l.id) as { id: string; end_rev: string | null } | undefined // i18n-ignore: SQL
    if ((last?.id ?? '') !== hold.lease || (last && last.end_rev !== head)) return false
    try {
      rebindSession(db, host, store.project, sessionId, l.id)
    } catch (e) {
      if (e instanceof RebindRefused) return false
      throw e
    }
    return true
  })
  return lease?.id ?? null
}
