import type { ActivityFilter } from '@shared/activity'

/**
 * A project's Activity tab as it was left (HI-1743): its filters, the agent whose tab shows and its zoom. Never live:
 * the tab opens frozen each time, so going live isn't kept.
 */
export interface ActivityView extends ActivityFilter {
  /** The agent whose tab shows. */
  tab?: string
  /** The tree's scale (HI-1678), 1 at actual size. */
  zoom?: number
  /** Bumped by each opening from an agent or a card (not kept): the tab takes a new snapshot for it. */
  opened?: number
}

const key = (project: string): string => `hive.activity.${project.toLowerCase()}`

/** The tree's zoom steps (HI-1678): Zoom in and out move between them; Fit picks any scale within them. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5]
export const ZOOM_MIN = ZOOM_STEPS[0]
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/** The next zoom step in or out from `z`. */
export const zoomStep = (z: number, dir: 1 | -1): number => (dir > 0 ? (ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX) : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN))

/** The view kept for a project in this window's storage, or none; anything unreadable is dropped. */
export function loadActivityView(project: string): ActivityView {
  try {
    const v = JSON.parse(localStorage.getItem(key(project)) ?? 'null') as Record<string, unknown> | null
    if (!v || typeof v !== 'object') return {}
    const out: ActivityView = {}
    if (Array.isArray(v.agents)) out.agents = v.agents.filter((x): x is string => typeof x === 'string').slice(0, 100)
    if (Array.isArray(v.cards)) out.cards = v.cards.filter((x): x is number => Number.isInteger(x)).slice(0, 100)
    // On unless turned off (HI-1743).
    if (v.hideFinished === false) out.hideFinished = false
    if (typeof v.tab === 'string') out.tab = v.tab
    if (typeof v.zoom === 'number' && v.zoom >= ZOOM_MIN && v.zoom <= ZOOM_MAX) out.zoom = v.zoom
    return out
  } catch {
    return {}
  }
}

/** Keeps a project's view for the next time (storage that can't be written: it is just not kept). */
export function saveActivityView(project: string, view: ActivityView): void {
  try {
    const { opened: _opened, ...kept } = view
    localStorage.setItem(key(project), JSON.stringify(kept))
  } catch {
    // Storage full or blocked: the view lasts while the window does.
  }
}
