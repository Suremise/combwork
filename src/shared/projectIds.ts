/**
 * Projects' stable ids (#508). A project is known by its folder's name, which changes when the folder is renamed or
 * moved; its id, kept in its own .combwork/project.json, goes with the folder. What the workspace keeps about a project
 * (cards, lanes, watches) stores the id beside the name, and the name is read back from the id, so a rename can't
 * leave them behind.
 */

/** Whether a value is a project id Combwork could have made (anything else in project.json is given a new one). */
export const isProjectId = (v: unknown): v is string => typeof v === 'string' && /^p-[0-9a-f]{8,32}$/.test(v)

export interface ProjectIdEntry {
  /** The project's folder now. */
  path: string
  /** Its project.json's id, if it has one. */
  id?: string
  /** Where it was last opened (project.json lastPath). */
  lastPath?: string
}

const lower = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
const base = (p: string): string => lower(p).split('\\').pop() ?? ''
/** A folder's name, from its path (either separator). */
const folderName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

/**
 * Which projects keep the id they have, and which need a new one: those without one (or with one that isn't an id),
 * and all but one of the folders that share an id (a copied folder brought its project.json along). Of those, the
 * one still where it was last opened keeps the id, else the one with the same folder name, else the first by path:
 * the original keeps its cards, and the copy starts with none.
 */
export function settleProjectIds(entries: ProjectIdEntry[]): { keep: Map<string, string>; fresh: string[] } {
  const keep = new Map<string, string>()
  const fresh: string[] = []
  const byId = new Map<string, ProjectIdEntry[]>()
  for (const e of entries) {
    if (!isProjectId(e.id)) fresh.push(e.path)
    else byId.set(e.id, [...(byId.get(e.id) ?? []), e])
  }
  for (const [id, list] of byId) {
    const sorted = [...list].sort((a, b) => lower(a.path).localeCompare(lower(b.path)))
    const owner = sorted.find((e) => e.lastPath && lower(e.lastPath) === lower(e.path)) ?? sorted.find((e) => e.lastPath && base(e.lastPath) === base(e.path)) ?? sorted[0]
    keep.set(lower(owner.path), id)
    for (const e of sorted) if (e !== owner) fresh.push(e.path)
  }
  return { keep, fresh }
}

/** The workspace's projects' ids as last read: each folder's (lower-cased) id, and each id's folder. */
export interface ProjectIdIndex {
  byPath: ReadonlyMap<string, string>
  byId: ReadonlyMap<string, string>
}

export const NO_PROJECT_IDS: ProjectIdIndex = { byPath: new Map(), byId: new Map() }

/** The folder name of the project an id is for now, or null when no project of the workspace has it. */
export function projectNameOf(index: ProjectIdIndex, id: unknown): string | null {
  const p = typeof id === 'string' ? index.byId.get(id) : undefined
  return p ? folderName(p) || null : null
}

/** The id of the project with this folder name (a folder of the workspace), or null. */
export function projectIdNamed(index: ProjectIdIndex, name: string): string | null {
  if (!name) return null
  const want = name.toLowerCase()
  for (const [id, p] of index.byId) if (folderName(p).toLowerCase() === want) return id
  return null
}

/**
 * What a record saved before projects had ids (a card, a lane, a watch: no projectId) names, for Repair: the name it was
 * saved with and the agents on it, as evidence of whose it is.
 */
export interface LegacyRecord {
  name: string
  agents: readonly string[]
}

/**
 * Names that records saved before ids (#508) are left under, which no project of the workspace has (their project renamed
 * or moved since), and the project each belongs to now: the project Repair is moving from that name, else the one project
 * whose agents (or their sessions) worked on them. A name whose agents are known to no project, or to more than one, is
 * left alone: Combwork can't tell whose its records are. `taken`: the names that are the workspace's (its projects, hidden and
 * removed ones too), which are never left behind. Records with an id never come here: their id says whose they are.
 */
export function orphanNames(records: readonly LegacyRecord[], taken: readonly string[], projects: { name: string; agents: ReadonlySet<string> }[], renamed: { from: string; to: string }[] = []): { from: string; to: string }[] {
  const isTaken = new Set(taken.map((n) => n.toLowerCase()))
  const groups = new Map<string, { from: string; agents: Set<string> }>()
  for (const r of records) {
    if (!r.name || isTaken.has(r.name.toLowerCase()) || r.name.endsWith(GONE)) continue
    const k = r.name.toLowerCase()
    const g = groups.get(k) ?? { from: r.name, agents: new Set<string>() }
    for (const a of r.agents) if (a) g.agents.add(a)
    groups.set(k, g)
  }
  const out: { from: string; to: string }[] = []
  for (const [k, g] of groups) {
    let to = renamed.find((r) => r.from.toLowerCase() === k && r.from.toLowerCase() !== r.to.toLowerCase())?.to ?? null
    if (!to) {
      const owners = projects.filter((p) => [...g.agents].some((a) => p.agents.has(a)))
      if (owners.length === 1) to = owners[0].name
    }
    if (to) out.push({ from: g.from, to })
  }
  return out.sort((a, b) => a.from.localeCompare(b.from))
}

/** How a record shows whose project is gone while another project has its name now: never a folder name (no ":" in one). */
const GONE = ': gone'
export const goneProject = (name: string): string => `${name}${GONE}`
/** The name a record was saved with, from the name it shows (goneProject's). */
export const savedProjectName = (shown: string): string => (shown.endsWith(GONE) ? shown.slice(0, -GONE.length) : shown)

/**
 * The project a saved record (a card, a lane) names now, from the name and id it was saved with. Its id decides whose it
 * is: the project that has that id now (renamed or moved since). Saved with an id no project has now (its project removed,
 * or taken out of the workspace), it keeps the name it was saved with, unless another project has that name now: then it
 * shows as goneProject's, so it is never that project's (nor in its agents' view). A record saved before ids has its
 * name only, and keeps it.
 */
export function projectNow(index: ProjectIdIndex, name: string, id: unknown): string {
  if (isProjectId(id)) {
    const now = projectNameOf(index, id)
    if (now) return now
    const other = projectIdNamed(index, savedProjectName(name))
    return other && other !== id ? goneProject(savedProjectName(name)) : savedProjectName(name)
  }
  return name
}
