import { existsSync } from 'original-fs'
import { basename, dirname, join, resolve } from 'path'
import { HIVE_DIR } from '../shared/defaults'
import { isProjectId } from '../shared/projectIds'
import { readKeptJson, retryWhileSaving, withFileLock, writeKeptJson } from './fsutil'
import { msg } from '../shared/i18n'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import type { ProjectSeen, WorkspaceService } from './workspace'

const log = createLogger('projectNames')

/** A name change refused because its workspace closed meanwhile (#848): the window's language, English for agents. */
const CLOSED = msg({ id: 'worktrees.names.closed', defaultMessage: 'The workspace was closed or switched: nothing was changed.', description: "An error: the workspace closed, or another opened in its window, while a project's name was being recorded; nothing changed." })

/**
 * The workspace's record of its projects' names, by their stable ids (#514), in `.combwork/project-names.json` (a kept file):
 * each project's folder name as Hive last saw it and its earlier ones, and every rename Hive saw, numbered. It is the
 * workspace's, not the project's: a copied folder (given an id of its own) brings none of it along. Renames are found by
 * id (a project seen under another name than its record's), so two projects that swapped names are two renames, never
 * copies. What keeps a project by its name or path follows each rename from it (projectRename.ts), and the records
 * kept by name (handovers, kept comparisons) are given to a project's id from it, once (`ownerOfName`).
 */
export interface NameJournal {
  version: 1
  /** The last rename's number (0: none yet). */
  seq: number
  projects: Record<string, { name: string; former: string[] }>
  /** The renames, oldest first (the latest MAX_RENAMES): each told together with the others of its `batch`. */
  renames: RenameEntry[]
}

/** One project's rename (or move within the workspace), by folder name. Renames seen in the same read share a batch. */
export interface RenameEntry {
  seq: number
  batch: number
  id: string
  from: string
  to: string
  at: string
}

const MAX_RENAMES = 500
const MAX_FORMER = 50
const MAX_PROJECTS = 1000

const fileOf = (wsPath: string): string => join(wsPath, HIVE_DIR, 'project-names.json')
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const empty = (): NameJournal => ({ version: 1, seq: 0, projects: {}, renames: [] })
const name = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 255 && !/[\\/\0]/.test(v)

/** The record as saved, checked as untrusted (a hand edit, a damaged file): what isn't valid is left out. */
function readJournal(raw: unknown): NameJournal {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!o || o.version !== 1) return empty()
  const j = empty()
  j.seq = Number.isSafeInteger(o.seq) && (o.seq as number) > 0 ? (o.seq as number) : 0
  const projects = o.projects && typeof o.projects === 'object' && !Array.isArray(o.projects) ? (o.projects as Record<string, unknown>) : {}
  for (const [id, v] of Object.entries(projects).slice(0, MAX_PROJECTS)) {
    const p = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    if (!isProjectId(id) || !p || !name(p.name)) continue
    j.projects[id] = { name: p.name, former: Array.isArray(p.former) ? p.former.filter(name).slice(0, MAX_FORMER) : [] }
  }
  for (const v of Array.isArray(o.renames) ? o.renames.slice(-MAX_RENAMES) : []) {
    const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    if (!r || !Number.isSafeInteger(r.seq) || !Number.isSafeInteger(r.batch) || !isProjectId(r.id) || !name(r.from) || !name(r.to) || (r.seq as number) > j.seq) continue
    if (j.renames.length && (r.seq as number) <= j.renames[j.renames.length - 1].seq) continue
    j.renames.push({ seq: r.seq as number, batch: r.batch as number, id: r.id, from: r.from, to: r.to, at: typeof r.at === 'string' ? r.at : '' })
  }
  return j
}

/** Each open workspace's record as last read or written, for the calls that can't wait (read again when it opens again). */
const known = new WeakMap<WorkspaceService, { life: AbortSignal; j: NameJournal }>()
const cached = (ws: WorkspaceService): NameJournal | undefined => {
  const k = known.get(ws)
  return k && k.life === ws.lifetime ? k.j : undefined
}
const remember = (ws: WorkspaceService, life: AbortSignal, j: NameJournal): void => {
  if (ws.lifetime === life) known.set(ws, { life, j })
}

/** The workspace's record now (read once while it is open, then as last written). */
export async function nameJournal(ws: WorkspaceService): Promise<NameJournal> {
  const path = ws.path
  if (!path) return empty()
  const had = cached(ws)
  if (had) return had
  const life = ws.lifetime
  const j = readJournal(await readKeptJson<unknown>(fileOf(path), null))
  remember(ws, life, j)
  return j
}

/** The record as last read (empty if not read yet): for code that can't wait. */
export const nameJournalNow = (ws: WorkspaceService): NameJournal => cached(ws) ?? empty()

/**
 * Brings the record up to what a read of the ids saw (in its lock, against the file as it is then): a project not in
 * it yet is recorded under its folder name (one from before ids whose project.json's lastPath is another folder here,
 * no project now, was renamed from it; a copy just given its own id starts from its own name); one seen under another
 * name than its record's was renamed, its old name first among its earlier ones. Returns the renames it recorded.
 */
export async function noteNames(ws: WorkspaceService, seen: ProjectSeen[]): Promise<RenameEntry[]> {
  const path = ws.path
  if (!path) return []
  const life = ws.lifetime
  // Nothing new since the record was last read: no file work at all (this runs with every read of the ids).
  const now = cached(ws)
  if (now && seen.every((s) => now.projects[s.id] && now.projects[s.id].name === basename(s.path))) return []
  return retryWhileSaving(() => withFileLock(fileOf(path), async () => {
    if (life.aborted || ws.path !== path) return []
    const j = readJournal(await readKeptJson<unknown>(fileOf(path), null, { unsettled: 'throw' }))
    const added: RenameEntry[] = []
    const batch = j.seq + 1
    const at = new Date().toISOString()
    let changed = false
    for (const s of seen) {
      const folder = basename(s.path)
      const had = j.projects[s.id]
      if (!had) {
        const last = !s.copy && s.lastPath && same(resolve(dirname(s.lastPath)), resolve(dirname(s.path))) ? basename(s.lastPath) : null
        const moved = !!last && !same(last, folder) && !existsSync(join(dirname(s.path), last, HIVE_DIR, 'project.json'))
        j.projects[s.id] = { name: folder, former: moved ? [last!] : [] }
        if (moved) added.push({ seq: ++j.seq, batch, id: s.id, from: last!, to: folder, at })
        changed = true
      } else if (!same(had.name, folder)) {
        had.former = [had.name, ...had.former.filter((n) => !same(n, had.name) && !same(n, folder))].slice(0, MAX_FORMER)
        added.push({ seq: ++j.seq, batch, id: s.id, from: had.name, to: folder, at })
        had.name = folder
        changed = true
      } else if (had.name !== folder) {
        had.name = folder
        changed = true
      }
    }
    if (!changed) {
      remember(ws, life, j)
      return []
    }
    j.renames = [...j.renames, ...added].slice(-MAX_RENAMES)
    const ids = Object.keys(j.projects)
    // Bounded: the projects longest gone go first (those seen now always stay).
    if (ids.length > MAX_PROJECTS) {
      const here = new Set(seen.map((s) => s.id))
      for (const id of ids.filter((x) => !here.has(x)).slice(0, ids.length - MAX_PROJECTS)) delete j.projects[id]
    }
    if (life.aborted || ws.path !== path) return []
    await writeKeptJson(fileOf(path), j)
    remember(ws, life, j)
    for (const r of added) log.info(`${userText(r.from)} was renamed ${userText(r.to)}: what keeps it by its name or path follows it`)
    return added
  }))
}

/**
 * Every project that had a folder name (#514), by id: the project of that name now, and those whose record has it (now
 * or before). A record saved under that name is one of these; more than one, and the name alone can't say which.
 */
export function ownersOfName(ws: WorkspaceService, folder: string): string[] {
  const out = new Set<string>()
  const here = ws.path ? ws.projectIdsNow().byPath.get(join(ws.path, folder).toLowerCase()) : undefined
  if (here) out.add(here)
  for (const [id, p] of Object.entries(nameJournalNow(ws).projects)) if (same(p.name, folder) || p.former.some((n) => same(n, folder))) out.add(id)
  return [...out]
}

/** The project a record saved under a folder name is (#514), by its id: the one project that ever had that name (none, or more than one: it can't be known, and the record stays nobody's). */
export function ownerOfName(ws: WorkspaceService, folder: string): string | null {
  const ids = ownersOfName(ws, folder)
  return ids.length === 1 ? ids[0] : null
}

/**
 * Records that a project once had a folder name, though Hive never saw it renamed (#514): Repair found what was saved
 * under that name and gave it to the project (#508). In the record before anything else moves, so what is kept under
 * that name (handovers, kept comparisons) is given to the project however often that fails, and after a restart.
 */
export async function noteFormerName(ws: WorkspaceService, id: string, folder: string): Promise<void> {
  const path = ws.path
  if (!path || !isProjectId(id) || !name(folder)) return
  const life = ws.lifetime
  const gone = (): boolean => life.aborted || ws.lifetime !== life || ws.path !== path
  await retryWhileSaving(() => withFileLock(fileOf(path), async () => {
    if (gone()) throw hiveError(CLOSED, undefined, { kind: 'conflict' })
    const j = readJournal(await readKeptJson<unknown>(fileOf(path), null, { unsettled: 'throw' }))
    if (gone()) throw hiveError(CLOSED, undefined, { kind: 'conflict' })
    const now = ws.projectIdsNow().byId.get(id)
    const p = j.projects[id] ?? (now ? (j.projects[id] = { name: basename(now), former: [] }) : null)
    if (!p) throw hiveError(msg({ id: 'worktrees.names.projectGone', defaultMessage: 'That project is no longer in the workspace.', description: "An error: the project whose name was being recorded was removed from the workspace meanwhile." }), undefined, { kind: 'notFound' })
    if (same(p.name, folder) || p.former.some((n) => same(n, folder))) return remember(ws, life, j)
    // The oldest of its names: it had it before any Hive saw it renamed from.
    p.former = [...p.former.slice(0, MAX_FORMER - 1), folder]
    await writeKeptJson(fileOf(path), j)
    remember(ws, life, j)
  }))
}
