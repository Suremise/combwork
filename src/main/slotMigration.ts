// Agents' worktrees become slots (#1441, SPEC §16.10.8): the 1.0 upgrade's last step, after the cards' adoption (#1218).
// Nothing moves at the upgrade: each builder's (or either agent's) existing worktree is recorded as a slot under its
// folder's name, lent to its agent under a **carried** lease (#1429's `carryIn`), and its sessions filed in that folder are
// bound to the lease (#1434's `rebindSession`), all in one board write. What the lease is kept for is recorded beside it
// (board_meta `carried:<lease>`): the lane running with that builder at the upgrade, else its card in flight, else nothing.
// slotCards' pass ends a carried lease once what it is kept for has ended; one kept for nothing stays until its agent's
// first card under slots takes the slot over (`handOffCarried`, clean and contained) or the user releases it. A reviewer
// with its own worktree gets no slot: its folder becomes a retired home (its conversations resume there, its new ones
// start in the project folder). A missing worktree is left as it is (Repair or Recreate, as before).
//
// Only on a 1.0 board (its upgrade done: board_meta `adoption_upto`, which every 1.0 board has, so a 0.9 project added to
// a workspace made by 1.0 is migrated too), at each opening, **per agent**: board_meta `slot_migration` records, by
// project, the agents migrated (#1434's contract then stops reading their 0.9 worktrees). An agent not migrated yet (its
// worktree missing at the upgrade, or made since: 1.0 can still give an agent its own worktree) keeps working in its
// worktree as in 0.9, Repair and Recreate included, and is migrated at a later opening once its worktree is there. Safe
// to repeat and to run in two Combworks at once: each agent's adoption, with its record, is one board write, decided again
// in it (the partial unique indexes refuse a second carried lease for an agent or a second open lease on a slot).
// One-way: nothing restores what 0.9.3 had once slots have moved on (the upgrade's ask says so).

import { app } from 'electron'
import { existsSync } from 'original-fs'
import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import { running, type LaneRecord } from '../shared/lanes'
import { agentWorkflowRole, buildsWork } from '../shared/workflow/roles'
import { legacyWorktree, rebindSession, setRetiredHomes, setSlotsMigrated } from './agentFolders'
import { ADOPTION_UPTO, boardRead, boardValue, boardWrite, boardWriteOp, upgradeWaiting } from './boardStore'
import { coalesced } from './coalesce'
import { samePlace } from './fsutil'
import { rawLanes } from './lanes'
import { createLogger, userText } from './logger'
import { boardConn } from './slotsApp'
import { SlotStore, type SlotLease } from './slots'
import { listWorktreesOrNull } from './worktrees'
import { workspaceFor, type WorkspaceService } from './workspace'
import type { DatabaseSync } from 'node:sqlite'

const log = createLogger('slots')

/** board_meta: by project id, when it was first migrated and the agents migrated (#1434's contract reads it). */
const MIGRATED = 'slot_migration'
/** board_meta: retired homes, by project id: reviewers' 0.9 worktrees, where their conversations resume. */
const HOMES = 'retired_homes'
/** board_meta: what a carried lease is kept for (the lane or card in flight at the upgrade); none, nothing. */
const carriedKey = (lease: string): string => `carried:${lease}`

/** What a carried lease is kept for: a lane, a card, or nothing (null). */
export type KeptFor = { lane: string } | { card: number } | null

const json = <T>(v: string | null, fallback: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

/** A project's migration record: when it first ran, and the agents migrated. */
interface Migration {
  at: string
  agents: string[]
}

/** The migration records in board_meta's value, by project id (a value not of this shape: none). */
function migrationsOf(raw: string | null): Record<string, Migration> {
  const out: Record<string, Migration> = {}
  for (const [k, v] of Object.entries(json<Record<string, unknown>>(raw, {}))) {
    const r = v && typeof v === 'object' ? (v as { at?: unknown; agents?: unknown }) : null
    out[k] = { at: typeof r?.at === 'string' ? r.at : '', agents: Array.isArray(r?.agents) ? r.agents.filter((x): x is string => typeof x === 'string') : [] }
  }
  return out
}

/** The migration records of a workspace, by project id. */
function migratedIn(ws: WorkspaceService): Record<string, Migration> {
  try {
    return migrationsOf(boardValue(ws, MIGRATED))
  } catch {
    return {}
  }
}

/** In a board write: agents recorded as migrated in a project (the project's record made if it has none). */
function markIn(db: DatabaseSync, project: string, agents: readonly string[]): void {
  const all = migrationsOf((db.prepare('SELECT value FROM board_meta WHERE key = ?').get(MIGRATED) as { value: string } | undefined)?.value ?? null) // i18n-ignore: SQL
  const was = all[project]
  all[project] = { at: was?.at || new Date().toISOString(), agents: [...new Set([...(was?.agents ?? []), ...agents])] }
  db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MIGRATED, JSON.stringify(all)) // i18n-ignore: SQL
}

/** What a carried lease is kept for (#1441), as recorded beside it. */
export function keptFor(ws: WorkspaceService, lease: string): KeptFor {
  try {
    const v = json<{ lane?: unknown; card?: unknown } | null>(boardValue(ws, carriedKey(lease)), null)
    if (v && typeof v.lane === 'string') return { lane: v.lane }
    if (v && typeof v.card === 'number') return { card: v.card }
  } catch {
    // A board still 0.9's.
  }
  return null
}

/** A project's slot id (its project.json id, else its folder's name), as the pools key it. */
async function projectId(ws: WorkspaceService, projectPath: string): Promise<string> {
  return (await ws.projectConfig(projectPath)).id ?? basename(projectPath)
}

/** A slot name for an adopted folder: its own name, made unique among the project's slots. */
function adoptedName(store: SlotStore, folder: string): string {
  const base = basename(folder).toLowerCase()
  const taken = new Map(store.slots().map((s) => [s.name.toLowerCase(), s.folder]))
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    const at = taken.get(name)
    if (!at || samePlace(at, folder)) return name
  }
}

/**
 * A workspace's migration (#1441), one at a time per workspace: in each project of a 1.0 board, the agents not migrated
 * yet have their worktrees adopted. A failure leaves those agents as they were, for the next opening. Test copies (unpackaged) with
 * `CW_TEST_SLOT_MIGRATION=off` skip it, so a suite can run a workspace as 0.9 left it before its upgrade (slotupgrade).
 */
export function migrateSlots(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path || (!app.isPackaged && process.env.CW_TEST_SLOT_MIGRATION === 'off')) return Promise.resolve()
  return coalesced(`slot-migration:${path.toLowerCase()}`, async () => {
    try {
      if (upgradeWaiting(path) || boardValue(ws, ADOPTION_UPTO) === null) return
      const done = migratedIn(ws)
      let lanes: LaneRecord[] | null = null
      // The project folders as the adoption lists them (hidden ones too: their agents' worktrees are theirs), not the
      // window's list, which may not be read yet while the workspace opens.
      const folders = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
      let moved = 0
      for (const p of folders) {
        if (ws.lifetime.aborted || ws.path !== path) return
        const name = basename(p)
        const id = await projectId(ws, p)
        const cfg = await ws.projectConfig(p)
        // Nothing to do: migrated already, with no agent's worktree left to take over.
        if (done[id] && projectAgents(cfg).every((a) => !legacyWorktree(a) || done[id].agents.includes(a.id))) continue
        lanes ??= await rawLanes(ws)
        moved += await migrateProject(ws, p, name, id, lanes, done[id]?.agents ?? []).catch((e) => {
          log.warn(`migrating ${userText(name)}'s worktrees into slots (tried again at the next opening)`, e)
          return 0
        })
      }
      // The windows read where agents work as the workspace opened, before this: told again, so an agent whose 0.9
      // worktree became its carried slot (or a retired home) isn't shown in its old place until something else
      // refreshes (HI-1824: the Changes picker kept "Coder's worktree" whenever no refresh came after).
      if (moved && !ws.lifetime.aborted && ws.path === path) await ws.refresh().catch((e: unknown) => log.warn('reading the projects again after migrating worktrees into slots', e))
    } catch (e) {
      log.warn(`migrating ${userText(path)}'s worktrees into slots (tried again at the next opening)`, e)
    }
  })
}

/**
 * One project's agents not migrated yet: builders' worktrees adopted, each with its record in its write; reviewers'
 * recorded as retired homes; then the project's record (made even with nothing to adopt).
 */
async function migrateProject(ws: WorkspaceService, projectPath: string, name: string, id: string, lanes: readonly LaneRecord[], done: readonly string[]): Promise<number> {
  const agents = projectAgents(await ws.projectConfig(projectPath)).filter((a) => legacyWorktree(a) && !done.includes(a.id))
  const store = new SlotStore(boardConn(ws), id)
  const host = (await ws.sessionScope(projectPath)).scope
  // Git's list only where a builder has a worktree to adopt (a project without git or worktrees is recorded as it is).
  const listed = agents.some((a) => buildsWork(agentWorkflowRole(a))) ? await listWorktreesOrNull(projectPath) : []
  if (!listed) throw new Error("git couldn't list the project's worktrees") // i18n-ignore: the log
  const homes: string[] = []
  const reviewers: string[] = []
  let adopted = 0
  for (const a of agents) {
    const w = legacyWorktree(a)!
    if (!buildsWork(agentWorkflowRole(a))) {
      homes.push(w.path)
      reviewers.push(a.id)
      continue
    }
    // Missing (or not git's): nothing is made; it stays its folder, Repair or Recreate offered as before, and it is
    // adopted at a later opening once it is there.
    if (!existsSync(w.path) || !listed.some((l) => samePlace(l.path, w.path))) {
      log.info(`${userText(a.name)}'s worktree ${userText(w.path)} isn't there: not adopted yet`)
      continue
    }
    const lane = lanes.find((l) => running(l) && l.builder.id === a.id && l.project.toLowerCase() === name.toLowerCase())
    const card = lane ? null : inFlight(ws, name, a.id)
    const kept: KeptFor = lane ? { lane: lane.id } : card !== null ? { card } : null
    const slotName = adoptedName(store, w.path)
    const lease = await store.conn.write((db) => {
      // Adopted already (a rerun, another Combwork): recorded, nothing more.
      if (db.prepare("SELECT 1 FROM slot_leases WHERE project = ? AND agent = ? AND kind = 'carried' AND ended_at IS NULL").get(id, a.id)) { // i18n-ignore: SQL
        markIn(db, id, [a.id])
        return null
      }
      const l = store.carryIn(db, a.id, { name: slotName, folder: w.path, target: w.base ?? null })
      if (!l) return null
      markIn(db, id, [a.id])
      if (kept) db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(carriedKey(l.id), JSON.stringify(kept)) // i18n-ignore: SQL
      bindSessions(db, host, id, a.id, w.path, l)
      return l
    })
    if (lease) {
      adopted++
      log.info(`${userText(a.name)}'s worktree ${userText(w.path)} adopted as slot ${userText(slotName)} (lease ${lease.id}, kept for ${kept ? ('lane' in kept ? `lane ${kept.lane}` : `#${kept.card}`) : 'nothing'})`)
    }
  }
  await boardWrite(ws, async () =>
    boardWriteOp(ws, (db) => {
      const meta = (key: string): string | null => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null // i18n-ignore: SQL
      if (homes.length) {
        const all = json<Record<string, string[]>>(meta(HOMES), {})
        const mine = all[id] ?? []
        all[id] = [...mine, ...homes.filter((h) => !mine.some((m) => samePlace(m, h)))]
        db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(HOMES, JSON.stringify(all)) // i18n-ignore: SQL
      }
      markIn(db, id, reviewers)
    })
  )
  log.info(`${userText(name)}: ${adopted} worktree(s) adopted as slots, ${homes.length} reviewer worktree(s) kept as retired homes`)
  // What changed where agents work: the adoptions, and the reviewers now in retired homes.
  return adopted + reviewers.length
}

/** The agent's card in flight on the board (Doing, Review or Passed), if any: what its carried lease is kept for. */
function inFlight(ws: WorkspaceService, project: string, agent: string): number | null {
  return boardRead(ws, (db) => (db.prepare("SELECT number FROM cards WHERE lower(project) = lower(?) AND agent = ? AND col IN ('doing', 'review', 'passed') AND archived = 0 ORDER BY number LIMIT 1").get(project, agent) as { number: number } | undefined)?.number ?? null) // i18n-ignore: SQL
}

/** In the adoption's write: the agent's sessions recorded in the folder bound to its carried lease (first binds). */
function bindSessions(db: DatabaseSync, host: string, project: string, agent: string, folder: string, lease: SlotLease): void {
  const rows = db.prepare('SELECT id, cwd FROM sessions WHERE host = ? AND agent_id = ? AND lease IS NULL').all(host, agent) as { id: string; cwd: string | null }[] // i18n-ignore: SQL
  for (const r of rows) if (r.cwd && samePlace(r.cwd, folder)) rebindSession(db, host, project, r.id, lease.id, { first: true })
}

/** An agent's open carried lease in a project, with its slot's folder (#1441), or null. */
export function carriedOf(ws: WorkspaceService, project: string, agent: string): { lease: string; slot: string; folder: string } | null {
  try {
    return boardRead(ws, (db) => (db.prepare("SELECT l.id AS lease, l.slot AS slot, s.folder AS folder FROM slot_leases l JOIN slots s ON s.project = l.project AND s.name = l.slot WHERE l.project = ? AND l.agent = ? AND l.kind = 'carried' AND l.ended_at IS NULL").get(project, agent) as { lease: string; slot: string; folder: string } | undefined) ?? null) // i18n-ignore: SQL
  } catch {
    return null
  }
}

/**
 * Whether what a carried lease is kept for is still going (#1441): its lane running, or its card not yet Done or put
 * back (`stage`: the card's stage now). Kept for nothing: false.
 */
export async function keptGoing(ws: WorkspaceService, kept: KeptFor, stage: (card: number) => string | null): Promise<boolean> {
  if (!kept) return false
  if ('lane' in kept) return (await rawLanes(ws)).some((l) => l.id === kept.lane && running(l))
  const st = stage(kept.card)
  return st !== null && st !== 'done' && st !== 'todo'
}

/**
 * Release Slot… (#1441, the agent's menu, asked first in the window): its carried lease ended (`released`), so its
 * adopted worktree is no longer kept for it; the pool's guards then decide what becomes of the folder (a free slot, lent
 * once clean; renamed to a slot's name once nothing holds it). Its branch is kept. Whether a carried lease was ended.
 * `guard` (#1561: the Assistant's) runs in the write that ends the lease: a throw ends nothing.
 */
export async function releaseCarried(ws: WorkspaceService, projectPath: string, agentId: string, guard?: () => void): Promise<boolean> {
  const id = await projectId(ws, projectPath)
  const c = carriedOf(ws, id, agentId)
  if (!c) return false
  const { poolFor } = await import('./slotsApp')
  const ended = await (await poolFor(ws, projectPath)).release(c.lease, 'released', guard && (() => (guard(), true)))
  if (ended) log.info(`${userText(agentId)}'s adopted slot ${userText(c.slot)} released by the user (lease ${c.lease})`)
  return ended
}

/** A project's retired homes (#1441), as recorded. */
export async function retiredHomes(ws: WorkspaceService, projectPath: string): Promise<string[]> {
  try {
    return json<Record<string, string[]>>(boardValue(ws, HOMES), {})[await projectId(ws, projectPath)] ?? []
  } catch {
    return []
  }
}

/** A retired home moved by Repair (#1447) to `to`, or forgotten (null), in one board write. */
export async function replaceHome(ws: WorkspaceService, projectPath: string, from: string, to: string | null, knownId?: string): Promise<void> {
  const id = knownId ?? (await projectId(ws, projectPath))
  await boardWrite(ws, async () =>
    boardWriteOp(ws, (db) => {
      const all = json<Record<string, string[]>>((db.prepare('SELECT value FROM board_meta WHERE key = ?').get(HOMES) as { value: string } | undefined)?.value ?? null, {}) // i18n-ignore: SQL
      const mine = (all[id] ?? []).flatMap((h) => (samePlace(h, from) ? (to ? [to] : []) : [h]))
      all[id] = [...new Set(mine)]
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(HOMES, JSON.stringify(all)) // i18n-ignore: SQL
    })
  )
}

/** #1434's seams, from what the migration recorded: whether a project is migrated, and its retired homes. */
export function startSlotMigration(): void {
  const wsOf = (projectPath: string): WorkspaceService | null => workspaceFor(projectPath)
  setSlotsMigrated(async (projectPath) => {
    const ws = wsOf(projectPath)
    return ws ? (migratedIn(ws)[await projectId(ws, projectPath)]?.agents ?? null) : null
  })
  setRetiredHomes(async (projectPath) => {
    const ws = wsOf(projectPath)
    return ws ? retiredHomes(ws, projectPath) : []
  })
}

export function stopSlotMigration(): void {
  setSlotsMigrated(null)
  setRetiredHomes(null)
}
