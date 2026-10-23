// A project's slots, copies and retired homes (#1447, SPEC §16.10.2 and §8): what Repair a Moved Workspace relinks,
// recreates or releases, and what project removal removes or keeps, read from #1429's and #1435's tables and #1441's
// homes (never from an agent's typed `worktree`). Each change goes through its owner: a slot's row through its pool's
// store (only while no operation holds it), a gone leased slot made again by the pool's own operation, a lease released
// by the pool, a copy's row through its pool's store, a home through slotMigration's record.

import { basename, join } from 'path'
import { projectAgents } from '../shared/defaults'
import { msg, tr } from '../shared/i18n'
import type { ProjectFolderOf } from '../shared/types'
import { containsPlace } from './fsutil'
import { legacyWorktree } from './agentFolders'
import { boardRead, cardKeys } from './boardStore'
import { createLogger, userText } from './logger'
import { replaceHome, retiredHomes } from './slotMigration'
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
  return (await poolFor(ws, projectPath)).recreateGone(f.name, to, f.line, () => prunable(projectPath))
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
  copyHeld: msg({ id: 'main.removal.folder.copyHeld', defaultMessage: 'it is in use ({by})', description: "Remove Project (#1447): a review copy is kept because something runs in it ({by}: what, in English). A clause." })
}

type Removal = { of: ProjectFolderOf; path: string; kept: string | null }

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
  for (const f of folders) {
    const kept = (k: string | null): void => void out.push({ of: f.of, path: f.folder, kept: k })
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
