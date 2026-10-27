// A project's slots, copies and retired homes (#1447, SPEC §16.10.2 and §8): what Repair a Moved Workspace relinks,
// recreates or releases, and what project removal removes or keeps, read from #1429's and #1435's tables and #1441's
// homes (never from an agent's typed `worktree`). Each change goes through its owner: a slot's row through its pool's
// store (only while no operation holds it), a gone leased slot made again by the pool's own operation, a lease released
// by the pool, a copy's row through its pool's store, a home through slotMigration's record.

import { basename, join } from 'path'
import { projectAgents } from '../shared/defaults'
import { msg, tr } from '../shared/i18n'
import type { ProjectFolderOf } from '../shared/types'
import { folderWhat } from '../shared/projectFolders'
import { containsPlace, samePlace } from './fsutil'
import { legacyWorktree } from './agentFolders'
import { boardRead, boardWrite, boardWriteOp, cardKeys } from './boardStore'
import { createLogger, userText } from './logger'
import { replaceHome, retiredHomes } from './slotMigration'
import { deleteKey, deletingIn, folderThere, releaseDeleteIn, type DeleteReservation, type Holder } from './slots'
import { workflowFor } from './workflow/service'
import type { WorkspaceService } from './workspace'

const log = createLogger('slots')

/** One of a project's folders Repair and removal look at, beside agents' 0.9 worktrees. */
export interface ProjectFolder {
  /** Repair's key for it (MoveWorktree.agentId): `slot:<name>`, `copy:<name>`, `home:<n>`. */
  key: string
  of: ProjectFolderOf
  /** The slot's or copy's name, or the home's path. */
  name: string
  folder: string
  /** A slot's open lease. */
  lease: { id: string; kind: 'card' | 'lane' | 'carried'; agent: string; card: number | null } | null
  /** The branch a gone leased slot is made again on: its card's line, or a carried slot's agent's branch. */
  line: string | null
}

interface SlotRow {
  name: string
  folder: string
  lease: string | null
  kind: 'card' | 'lane' | 'carried' | null
  agent: string | null
  card: number | null
}

/** A project's folders, as recorded now ([] on a board still 0.9's). */
export async function projectFolders(ws: WorkspaceService, projectPath: string): Promise<ProjectFolder[]> {
  const cfg = await ws.projectConfig(projectPath)
  const id = cfg.id ?? basename(projectPath)
  const agents = projectAgents(cfg)
  const nameOf = (a: string | null): string | null => (a ? (agents.find((x) => x.id === a)?.name ?? a) : null)
  let slots: SlotRow[] = []
  let copies: { name: string; folder: string }[] = []
  const held = new Map<string, number[]>()
  try {
    boardRead(ws, (db) => {
      slots = db.prepare('SELECT s.name AS name, s.folder AS folder, l.id AS lease, l.kind AS kind, l.agent AS agent, l.card AS card FROM slots s LEFT JOIN slot_leases l ON l.project = s.project AND l.slot = s.name AND l.ended_at IS NULL WHERE s.project = ? ORDER BY s.name').all(id) as unknown as SlotRow[] // i18n-ignore: SQL
      copies = db.prepare('SELECT name, folder FROM copies WHERE project = ? ORDER BY name').all(id) as { name: string; folder: string }[] // i18n-ignore: SQL
      for (const r of db.prepare('SELECT DISTINCT slot, card FROM slot_leases WHERE project = ? AND card IS NOT NULL ORDER BY from_at DESC').all(id) as { slot: string; card: number }[]) held.set(r.slot.toLowerCase(), [...(held.get(r.slot.toLowerCase()) ?? []), r.card]) // i18n-ignore: SQL
    })
  } catch {
    // A board still 0.9's: no slots or copies yet.
  }
  const wf = slots.length ? await workflowFor(ws, projectPath).catch(() => null) : null
  // A lane's cards hold its slot by the lane's lease (no card on it): the cards started in the slot, from the board,
  // those not Done first.
  const inSlot = new Map<string, number[]>()
  for (const c of wf?.store.cards() ?? []) {
    try {
      const st = wf!.state(c)
      const slot = st.started?.slot?.toLowerCase()
      if (slot) inSlot.set(slot, [...(inSlot.get(slot) ?? []), ...(st.stage === 'done' ? [] : [c.id])])
    } catch {
      // A card that can't be read: not named.
    }
  }
  for (const [slot, cards] of inSlot) held.set(slot, [...new Set([...cards.sort((a, b) => b - a), ...(held.get(slot) ?? [])])])
  const keys = held.size ? cardKeys(ws, [...new Set([...held.values()].flat())]) : new Map<number, string>()
  const lineOf = (card: number | null): string | null => {
    if (card === null || !wf) return null
    try {
      return wf.state(wf.store.card(card)).started?.line ?? null
    } catch {
      return null
    }
  }
  const out: ProjectFolder[] = []
  for (const s of slots) {
    const cards = held.get(s.name.toLowerCase()) ?? []
    const open = s.lease && s.kind && s.agent ? { id: s.lease, kind: s.kind, agent: s.agent, card: s.card } : null
    const carried = open?.kind === 'carried'
    const line = !open ? null : carried ? (legacyWorktree(agents.find((a) => a.id === open.agent))?.branch ?? null) : lineOf(open.card ?? cards[0] ?? null)
    out.push({ key: `slot:${s.name}`, name: s.name, folder: s.folder, lease: open, line, of: { kind: 'slot', name: s.name, agent: nameOf(open?.agent ?? null), cards: cards.slice(0, 3).map((n) => keys.get(n) ?? `#${n}`), carried } })
  }
  for (const c of copies) out.push({ key: `copy:${c.name}`, name: c.name, folder: c.folder, lease: null, line: null, of: { kind: 'copy', name: c.name } })
  const homes = await retiredHomes(ws, projectPath)
  homes.forEach((h, n) => {
    const agent = agents.find((a) => {
      const w = legacyWorktree(a)
      // By its path, else its folder's name: Repair moves the home, not the agent's 0.9 record (1.0 doesn't read it).
      return !!w && (w.path.toLowerCase() === h.toLowerCase() || basename(w.path).toLowerCase() === basename(h).toLowerCase())
    })
    out.push({ key: `home:${n}`, name: h, folder: h, lease: null, line: null, of: { kind: 'home', agent: agent?.name ?? null } })
  })
  return out
}

/**
 * Repair relinked a folder at `to`: its record follows it (a slot's or copy's row, only while no operation holds it; a
 * home's path). `gone`: not found, so a free slot or copy is marked gone at `to`, its place in the moved pool, and made
 * again there at its next lease. Whether it was recorded.
 */
export async function relocateFolder(ws: WorkspaceService, projectPath: string, f: ProjectFolder, to: string, o: { gone?: boolean } = {}): Promise<boolean> {
  if (f.of.kind === 'slot') {
    const { poolFor } = await import('./slotsApp')
    return (await poolFor(ws, projectPath)).deps.store.relocate(f.name, to, o)
  }
  if (f.of.kind === 'copy') {
    const { copiesFor } = await import('./copiesApp')
    return (await copiesFor(ws, projectPath)).deps.store.relocate(f.name, to, o)
  }
  await replaceHome(ws, projectPath, f.folder, o.gone ? null : to)
  return true
}

/** A gone leased slot made again at `to` on its line, its lease kept (the pool's operation). Null once made, else why not. */
export async function recreateSlot(ws: WorkspaceService, projectPath: string, f: ProjectFolder, to: string): Promise<string | null> {
  if (f.of.kind !== 'slot' || !f.lease) return 'it is not a lent slot' // i18n-ignore: the log's reason
  if (!f.line) return 'its line is not known' // i18n-ignore: the log's reason
  const { poolFor } = await import('./slotsApp')
  const { prunable } = await import('./agentWorktree')
  return (await poolFor(ws, projectPath)).recreateGone(f.name, { lease: f.lease.id, folder: f.folder }, to, f.line, () => prunable(projectPath))
}

/** A gone slot's lease released (Repair's Release): the slot is then free, and made again at its next lease. */
export async function releaseSlotLease(ws: WorkspaceService, projectPath: string, f: ProjectFolder): Promise<boolean> {
  if (f.of.kind !== 'slot' || !f.lease) return false
  const { poolFor } = await import('./slotsApp')
  const ended = await (await poolFor(ws, projectPath)).release(f.lease.id, 'released')
  if (ended) log.info(`Repair: ${userText(f.name)}'s lease ${f.lease.id} released`)
  return ended
}

/** Why project removal keeps a folder (#1447), the clauses the dialog and its result show. */
const K = {
  home: msg({ id: 'main.removal.folder.home', defaultMessage: 'left as it is: its conversations resume there', description: "Remove Project (#1447): an old reviewer folder (a reviewer's own worktree from before 1.0) stays where it is. A clause." }),
  notHives: msg({ id: 'main.removal.folder.notHives', defaultMessage: "left as it is: it isn't in Hive's worktrees folder for the project", description: "Remove Project (#1447): a slot whose folder Hive didn't make (outside <workspace>.worktrees/<project>) stays. A clause." }),
  copyLeased: msg({ id: 'main.removal.folder.copyLeased', defaultMessage: 'a review uses it now', description: "Remove Project (#1447): a review copy is kept because a review or check uses it. A clause." }),
  copyBusy: msg({ id: 'main.removal.folder.copyBusy', defaultMessage: 'Hive is setting it up or removing it now', description: "Remove Project (#1447): a review copy is kept because one of Hive's steps holds it. A clause." }),
  outsideDelete: msg({ id: 'main.removal.folder.outsideDelete', defaultMessage: "it isn't in Hive's worktrees folder for the project, and would be left without its repository: release its slot and move or remove it first", description: "Why Delete can't go ahead (#1447): a slot outside <workspace>.worktrees/<project> (one Hive didn't make) would keep its files but lose the repository Delete sends to the Recycle Bin. Release its slot is a command in the agent's menu (Release Slot…). A clause." }),
  notTrashed: msg({ id: 'main.removal.folder.notTrashed', defaultMessage: "{path} couldn't be moved to the Recycle Bin: {why}", description: "A warning after Delete (#1447): one of the project's slots, copies or old folders ({path}) couldn't go to the Recycle Bin ({why}: the system's message)." }),
  notForgotten: msg({ id: 'main.removal.folder.notForgotten', defaultMessage: "Hive's record of the project's slots couldn't all be cleared: {why}", description: "A warning after Delete (#1447): the project's slot or copy records stayed in Hive's database ({why}: the system's message)." }),
  heldNow: msg({ id: 'main.removal.folder.heldNow', defaultMessage: "one of Hive's steps or a session took it up meanwhile", description: "Why Delete can't go ahead (#1447): between the dialog's check and Delete's start, one of the project's slots or copies was taken up (set up, renamed, a session started in it, a review copy leased), or a new one made. A clause." }),
  deleting: msg({ id: 'main.removal.folder.deleting', defaultMessage: 'another Delete of this project holds its slots', description: "Why Delete can't go ahead (#1447): another Hive window or process is deleting the same project now. A clause." }),
  notHeld: msg({ id: 'main.removal.folder.notHeld', defaultMessage: '{n, plural, one {# slot or copy was} other {# slots or copies were}} taken up by another step, and left', description: "A warning's reason after Delete (#1447): records of the project's slots or copies Delete didn't hold, so it didn't delete them. Follows main.removal.folder.notForgotten's colon." }),
  copyHeld: msg({ id: 'main.removal.folder.copyHeld', defaultMessage: 'it is in use ({by})', description: "Remove Project (#1447): a review copy is kept because something runs in it ({by}: what, in English). A clause." })
}

type Removal = { of: ProjectFolderOf; path: string; kept: string | null; blocksDelete?: string }

/**
 * What a project's removal does to its slots, copies and retired homes (#1447), or would do (`apply` false: the dialog's
 * preview). Each slot goes through its pool's guarded clean-up (the archive command, then the guards: no session,
 * process, card being merged, uncommitted file or unmerged commit), its lease ended first only when nothing would be
 * kept (a carried slot with work keeps its lease and folder); each copy through its pool's. Never a folder outside
 * `<Workspace>.worktrees/<Project>/` (one Hive didn't make), nor a retired home: those stay, listed.
 */
export async function removeFolders(ws: WorkspaceService, projectPath: string, apply: boolean): Promise<Removal[]> {
  const root = join(ws.worktreesRoot, basename(projectPath))
  const out: Removal[] = []
  const folders = await projectFolders(ws, projectPath)
  if (!folders.length) return out
  const { poolFor } = await import('./slotsApp')
  const { copiesFor } = await import('./copiesApp')
  const { keptText } = await import('./unusedWorktrees')
  const blocks = apply ? new Map<string, string>() : await deleteBlocks(ws, projectPath, folders)
  for (const f of folders) {
    const kept = (k: string | null): void => void out.push({ of: f.of, path: f.folder, kept: k, ...(blocks.has(f.key) ? { blocksDelete: blocks.get(f.key) } : {}) })
    if (f.of.kind === 'home') {
      kept(tr(K.home))
      continue
    }
    if (!containsPlace(root, f.folder)) {
      kept(tr(K.notHives))
      continue
    }
    try {
      if (f.of.kind === 'slot') {
        const pool = await poolFor(ws, projectPath)
        const k = await pool.keepsFromRemoval(f.name, apply)
        if (k || !apply) {
          kept(k ? await keptText(projectPath, k) : null)
          continue
        }
        if (f.lease) await pool.release(f.lease.id, 'projectRemoved')
        const left = await pool.remove(f.name)
        kept(left ? await keptText(projectPath, left) : null)
        if (!left) log.info(`${userText(basename(projectPath))}'s slot ${userText(f.name)} removed with the project`)
      } else {
        const pool = await copiesFor(ws, projectPath)
        const lent = !!pool.deps.store.leaseOn(f.name)
        if (!apply) {
          kept(lent ? tr(K.copyLeased) : null)
          continue
        }
        const held = await pool.remove(f.name)
        kept(!held ? null : held.why === 'leased' ? tr(K.copyLeased) : 'by' in held ? tr(K.copyHeld, { by: held.by }) : tr(K.copyBusy))
      }
    } catch (e) {
      kept(e instanceof Error ? e.message : String(e))
    }
  }
  return out
}

/**
 * What stops Delete (#1447, HR1's round 1), by folder key: a slot or home outside `<Workspace>.worktrees/<Project>/` (not
 * Hive's to delete, and it would be left without its repository), or a slot or copy one of Hive's steps holds (an
 * operation, a job, a writer). None: Delete may go ahead.
 */
export async function deleteBlocks(ws: WorkspaceService, projectPath: string, folders?: ProjectFolder[]): Promise<Map<string, string>> {
  const root = join(ws.worktreesRoot, basename(projectPath))
  const out = new Map<string, string>()
  const list = folders ?? (await projectFolders(ws, projectPath))
  if (!list.length) return out
  const { poolFor } = await import('./slotsApp')
  const { copiesFor } = await import('./copiesApp')
  for (const f of list) {
    if (!containsPlace(root, f.folder)) out.set(f.key, tr(K.outsideDelete))
    else if (f.of.kind === 'slot') {
      const s = (await poolFor(ws, projectPath)).deps.store.slot(f.name)
      if (s && (s.op || s.job || s.writer)) out.set(f.key, tr(K.copyBusy))
    } else if (f.of.kind === 'copy') {
      const store = (await copiesFor(ws, projectPath)).deps.store
      const c = store.copy(f.name)
      if (c && (c.op || c.job)) out.set(f.key, tr(K.copyBusy))
      else if (c && store.leaseOn(f.name)) out.set(f.key, tr(K.copyLeased))
    }
  }
  return out
}

/**
 * Delete's reservation of the project's slots and copies (#1447, HR1's round 2), in one write against the rows as they
 * are then: refused, nothing written, if one is held (an operation, a job, a writer, a copy's lease not freed), if a row
 * is there the plan didn't list (made since) or at another folder than it checked (relinked since), or if another
 * Delete holds them; else `token` (this Hive's, held by
 * `holder`) becomes every listed row's operation and the project's reservation is recorded, so nothing begins on them
 * and no slot or copy is made until it ends (`trashFolders`, or `releaseDelete`). Null once held, else the folders
 * that refused it.
 */
export async function reserveDelete(ws: WorkspaceService, id: string, folders: ProjectFolder[], token: string, holder: Holder): Promise<{ busy: string[]; deleting: boolean } | null> {
  // Each row as the plan checked it, by name and folder: a row relinked since (another Hive's Repair) refuses it too, so
  // the folders Delete recycles are the ones it checked and holds (HR1's round 3).
  const checked = (kind: 'slot' | 'copy'): Map<string, string> => new Map(folders.filter((f) => f.of.kind === kind).map((f) => [f.name.toLowerCase(), f.folder]))
  const slots = checked('slot')
  const copies = checked('copy')
  const changed = (plan: Map<string, string>, r: { name: string; folder: string }): boolean => {
    const was = plan.get(r.name.toLowerCase())
    return was === undefined || !samePlace(was, r.folder)
  }
  return boardWrite(ws, async () =>
    boardWriteOp(ws, (db) => {
      if (deletingIn(db, id)) return { busy: [], deleting: true }
      const busy: string[] = []
      const rows = db.prepare('SELECT name, folder, op, job, writer_run FROM slots WHERE project = ?').all(id) as { name: string; folder: string; op: string | null; job: string | null; writer_run: string | null }[] // i18n-ignore: SQL
      for (const r of rows) if (changed(slots, r) || r.op || r.job || r.writer_run) busy.push(r.name)
      const cs = db.prepare('SELECT name, folder, op, job, EXISTS (SELECT 1 FROM copy_leases l WHERE l.project = copies.project AND l.copy = copies.name AND l.freed_at IS NULL) AS leased FROM copies WHERE project = ?').all(id) as { name: string; folder: string; op: string | null; job: string | null; leased: number }[] // i18n-ignore: SQL
      for (const c of cs) if (changed(copies, c) || c.op || c.job || c.leased) busy.push(c.name)
      if (busy.length) return { busy, deleting: false }
      const at = new Date().toISOString()
      db.prepare("UPDATE slots SET op = ?, op_kind = 'remove', op_lease = NULL, op_pid = ?, op_started = ? WHERE project = ? AND op IS NULL AND job IS NULL AND writer_run IS NULL").run(token, holder.pid, holder.started, id) // i18n-ignore: SQL
      db.prepare("UPDATE copies SET op = ?, op_kind = 'remove', op_pid = ?, op_started = ? WHERE project = ? AND op IS NULL AND job IS NULL").run(token, holder.pid, holder.started, id) // i18n-ignore: SQL
      const d: DeleteReservation = { token, pid: holder.pid, started: holder.started, at, slots: rows.map((r) => r.name), copies: cs.map((c) => c.name) }
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(deleteKey(id), JSON.stringify(d)) // i18n-ignore: SQL
      return null
    })
  )
}

/** What refused Delete's reservation, for its message: each folder by what it is (a slot made since by its name), and why. */
export function reserveRefusal(folders: ProjectFolder[], r: { busy: string[]; deleting: boolean }): string[] {
  if (r.deleting) return [tr(K.deleting)]
  return r.busy.map((n) => {
    const f = folders.find((x) => x.of.kind !== 'home' && x.name.toLowerCase() === n.toLowerCase())
    return `${f ? folderWhat(f.of) : n} (${tr(K.heldNow)})`
  })
}

/** Ends Delete's reservation before anything was deleted (#1447: refused, or the project folder couldn't go): its rows as they were. */
export async function releaseDelete(ws: WorkspaceService, id: string, token: string): Promise<void> {
  await boardWrite(ws, async () => boardWriteOp(ws, (db) => releaseDeleteIn(db, id, token)))
}

/**
 * Delete's step for a project's slots, copies and retired homes (#1447), once the project folder has gone to the
 * Recycle Bin (so nothing irreversible happens before it can refuse), under its reservation (`token`, `reserveDelete`):
 * each folder in the project's worktrees folder goes to the Recycle Bin too, with whatever work is in it (recoverable
 * with the repository, as agents' worktrees are), then, in one write, the rows the reservation holds are deleted (their
 * leases with them) and the reservation with them; a row it doesn't hold is left, never deleted. Its homes are then
 * forgotten. What couldn't go is said.
 */
export async function trashFolders(ws: WorkspaceService, projectPath: string, id: string, folders: ProjectFolder[], token: string, trash: (path: string) => Promise<void>): Promise<string[]> {
  const root = join(ws.worktreesRoot, basename(projectPath))
  const warnings: string[] = []
  for (const f of folders) {
    if (!containsPlace(root, f.folder) || !(await folderThere(f.folder))) continue
    await trash(f.folder).catch((e: Error) => warnings.push(tr(K.notTrashed, { path: f.folder, why: e.message })))
  }
  const gone = await boardWrite(ws, async () =>
    boardWriteOp(ws, (db) => {
      const n = Number(db.prepare('DELETE FROM slots WHERE project = ? AND op = ?').run(id, token).changes) // i18n-ignore: SQL
      const m = Number(db.prepare('DELETE FROM copies WHERE project = ? AND op = ?').run(id, token).changes) // i18n-ignore: SQL
      const left = (db.prepare('SELECT count(*) AS n FROM slots WHERE project = ?').get(id) as { n: number }).n + (db.prepare('SELECT count(*) AS n FROM copies WHERE project = ?').get(id) as { n: number }).n // i18n-ignore: SQL
      releaseDeleteIn(db, id, token)
      return { slots: n, copies: m, left }
    })
  ).catch((e: Error) => {
    warnings.push(tr(K.notForgotten, { why: e.message }))
    return null
  })
  if (gone?.left) warnings.push(tr(K.notForgotten, { why: tr(K.notHeld, { n: gone.left }) }))
  for (const f of folders) if (f.of.kind === 'home') await replaceHome(ws, projectPath, f.folder, null, id).catch((e: Error) => warnings.push(tr(K.notForgotten, { why: e.message })))
  if (gone && (gone.slots || gone.copies)) log.info(`Deleted ${userText(basename(projectPath))}'s ${gone.slots} slot(s) and ${gone.copies} copy(ies) with it`)
  return warnings
}
