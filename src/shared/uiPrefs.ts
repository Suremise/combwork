// Per-project view preferences kept in config.json's ui: the provider and groups a project's Skills tab shows (#118),
// the Sessions tree branches opened or folded (#239), and the Assistant panel's projects folded (#399). Each window has its own copy of these maps, so a change goes
// to main as one project's value and is merged into what is saved there (#245): a window's stale copy can't overwrite
// another window's projects.
import { isKnownProvider } from './providers'
import type { AppConfig } from './types'

export const PROJECT_PREFS = ['skillsProvider', 'skillsFold', 'sessionsTree', 'hiveVcsNotice', 'assistantFold'] as const
export type ProjectPref = (typeof PROJECT_PREFS)[number]
export type ProjectPrefValue<P extends ProjectPref> = NonNullable<AppConfig['ui'][P]>[string]

/** Projects kept per preference: the most recently changed. */
export const MAX_PREF_PROJECTS = 200
/** Branches kept per project in the Sessions tree: the most recently changed. */
export const MAX_TREE_PREFS = 300

export const isProjectPref = (pref: unknown): pref is ProjectPref => PROJECT_PREFS.includes(pref as ProjectPref)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The value as the preference keeps it (unknown fields and wrong types dropped), or undefined if it can't be one. */
export function projectPrefValue<P extends ProjectPref>(pref: P, value: unknown): ProjectPrefValue<P> | undefined {
  if (pref === 'skillsProvider') return (typeof value === 'string' && isKnownProvider(value) ? value : undefined) as ProjectPrefValue<P> | undefined
  if (pref === 'assistantFold') return (value === true ? true : undefined) as ProjectPrefValue<P> | undefined
  if (pref === 'hiveVcsNotice') return (typeof value === 'string' && value.length <= 200 ? value : undefined) as ProjectPrefValue<P> | undefined
  if (!isRecord(value)) return undefined
  if (pref === 'skillsFold') {
    const fold: { hive?: boolean; provider?: boolean } = {}
    if (typeof value.hive === 'boolean') fold.hive = value.hive
    if (typeof value.provider === 'boolean') fold.provider = value.provider
    return fold as ProjectPrefValue<P>
  }
  const branches = Object.entries(value).filter((e): e is [string, boolean] => typeof e[1] === 'boolean')
  return Object.fromEntries(branches.slice(-MAX_TREE_PREFS)) as ProjectPrefValue<P>
}

/**
 * A view preference's key with a moved folder's old path put as its new one (HI-2008), or null when it doesn't name
 * that folder: a project's path (`c:\work\alpha`), the Assistant's `<workspace>|<project>`, a pane's `<what>:<workspace>`.
 * Keys are lower-cased paths; a path counts only whole (`c:\work\a` isn't in `c:\work\ab`).
 */
export function movedPrefKey(key: string, from: string, to: string): string | null {
  const trim = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  const old = trim(from)
  const now = trim(to)
  if (!old) return null
  const esc = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let hit = false
  const next = key.replace(new RegExp(`(^|[|:])${esc}(?=$|[\\\\/|])`, 'g'), (_m, lead: string) => {
    hit = true
    return lead + now
  })
  return hit ? next : null
}

/** The map with the project's value set as the newest (null removes it), keeping the newest MAX_PREF_PROJECTS. */
export function withProjectPref<T>(map: Record<string, T> | undefined, project: string, value: T | null): Record<string, T> {
  const next = { ...map }
  delete next[project]
  if (value !== null) next[project] = value
  return Object.fromEntries(Object.entries(next).slice(-MAX_PREF_PROJECTS))
}
