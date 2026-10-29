import { config } from './config'
import { emit } from './events'
import { movedPrefKey, PROJECT_PREFS, type ProjectPref } from '../shared/uiPrefs'

// HI-2008: Hive's view preferences kept by folder in config.json's ui (each project's, and the workspace's panes)
// follow a moved workspace, with its other records by folder (workspaceMove.ts carryProfile).

/** The maps of ui whose keys can name a folder: the per-project preferences and the panes. */
const MAPS = [...PROJECT_PREFS, 'panes'] as const

/**
 * Moves every view preference kept under the old folder to the new one, when `ok()` still holds as config.json is
 * changed (the same synchronous step). A value already kept at the new place is the newer and stays; the old key goes
 * either way. Open windows follow (`ui-pref-changed`, `ui-panes-changed`). Returns how many moved.
 */
export function carryViewPrefs(from: string, to: string, ok: () => boolean = () => true): number {
  const prefs: { pref: ProjectPref; project: string; value: unknown }[] = []
  const panes: Record<string, number | null> = {}
  config.update((c) => {
    if (!ok()) return
    const ui = c.ui as unknown as Record<string, Record<string, unknown> | undefined>
    for (const name of MAPS) {
      const map = ui[name]
      if (!map) continue
      const keys = Object.keys(map).map((k) => [k, movedPrefKey(k, from, to)] as const)
      if (!keys.some(([, m]) => m !== null)) continue
      const next: Record<string, unknown> = {}
      for (const [k, m] of keys) {
        if (m === null) next[k] = map[k]
        else if (!(m in map)) next[m] = map[k]
      }
      ui[name] = next
      for (const [k, m] of keys) {
        if (m === null) continue
        const value = m in map ? null : map[k]
        if (name === 'panes') {
          panes[k] = null
          if (value !== null) panes[m] = value as number
        } else {
          prefs.push({ pref: name, project: k, value: null })
          if (value !== null) prefs.push({ pref: name, project: m, value })
        }
      }
    }
  })
  // (Each window applies them in order: a key cleared, then the value moved there.)
  for (const e of prefs) emit({ type: 'ui-pref-changed', ...e })
  if (Object.keys(panes).length) emit({ type: 'ui-panes-changed', panes })
  return prefs.filter((e) => e.value !== null).length + Object.values(panes).filter((v) => v !== null).length
}

/** Whether a view preference is still kept under a folder (a moved workspace's old one, still to follow it). */
export function viewPrefsKeptAt(folder: string): boolean {
  const ui = config.get().ui as unknown as Record<string, Record<string, unknown> | undefined>
  return MAPS.some((name) => Object.keys(ui[name] ?? {}).some((k) => movedPrefKey(k, folder, folder) !== null))
}
