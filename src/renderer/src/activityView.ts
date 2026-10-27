import type { ActivityFilter } from '@shared/activity'

/**
 * A project's Activity tab as it was left (HI-1743): its filters, the agent whose tab shows, and whether the agents' own
 * processes show. Never live: the tab opens frozen each time, so going live isn't kept.
 */
export interface ActivityView extends ActivityFilter {
  /** The agent whose tab shows. */
  tab?: string
  /** The agent's own processes (its CLI, its terminal, hive-mcp.js) shown too; hidden by default. */
  showOwn?: boolean
  /** Bumped by each opening from an agent or a card (not kept): the tab takes a new snapshot for it. */
  opened?: number
}

const key = (project: string): string => `hive.activity.${project.toLowerCase()}`

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
    if (v.showOwn === true) out.showOwn = true
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
