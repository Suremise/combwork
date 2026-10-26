import { ACTIVITY_RANGES, type ActivityFilter, type ActivityRange } from '@shared/activity'

/** A project's Activity tab as it was left (HI-1677): its range, filters, and whether it was paused by hand. */
export interface ActivityView extends ActivityFilter {
  paused?: boolean
}

const key = (project: string): string => `hive.activity.${project.toLowerCase()}`

/** The view kept for a project in this window's storage, or none; anything unreadable is dropped. */
export function loadActivityView(project: string): ActivityView {
  try {
    const v = JSON.parse(localStorage.getItem(key(project)) ?? 'null') as Record<string, unknown> | null
    if (!v || typeof v !== 'object') return {}
    const out: ActivityView = {}
    if (ACTIVITY_RANGES.includes(v.range as ActivityRange)) out.range = v.range as ActivityRange
    if (Array.isArray(v.agents)) out.agents = v.agents.filter((x): x is string => typeof x === 'string').slice(0, 100)
    if (Array.isArray(v.cards)) out.cards = v.cards.filter((x): x is number => Number.isInteger(x)).slice(0, 100)
    if (v.hideFinished === true) out.hideFinished = true
    if (v.paused === true) out.paused = true
    return out
  } catch {
    return {}
  }
}

/** Keeps a project's view for the next time (storage that can't be written: it is just not kept). */
export function saveActivityView(project: string, view: ActivityView): void {
  try {
    localStorage.setItem(key(project), JSON.stringify(view))
  } catch {
    // Storage full or blocked: the view lasts while the window does.
  }
}
