import type { ActivityFilter } from '../../shared/activity'

/**
 * A project's Activity tab as it was left (HI-1743): its filters, the agent whose tab shows, and whether the agents' own
 * processes show. Never live: the tab opens frozen each time, so going live isn't kept.
 */
export interface ActivityView extends ActivityFilter {
  /** The agent whose tab shows. */
  tab?: string
  /** The agent's own processes (its CLI, its terminal, cw-mcp.js) shown too; hidden by default. */
  showOwn?: boolean
  /**
   * The workspace level's (HI-1664): opened for this card, its agents in `agents` (found again as agents start and
   * stop). Kept: it says so until the filter is cleared.
   */
  forCard?: number
  /** Bumped by each opening from an agent or a card (not kept): the tab takes a new snapshot for it. */
  opened?: number
}

const PREFIX = 'combwork.activity.'
/** The views' keys before 1.1 (HI-2610): the names upgrade's input here, read only by upgradeActivityViews. */
// old-name: begin activity-prefix
const OLD_PREFIX = 'hive.activity.'
// old-name: end activity-prefix

// A project's by its path; the workspace level's by its workspace (workspaceActivityKey).
const key = (project: string): string => `${PREFIX}${project.toLowerCase()}`

/**
 * The names upgrade's step in this window's storage (HI-2610, nameUpgradeProfile.ts lists the profile's): each view kept
 * under its key before 1.1 is moved to its key now, once, as the window starts and before a view is read. One already kept
 * under the new key wins; the old key goes either way. Storage that can't be read or written: nothing is moved, and the
 * view starts afresh.
 */
export function upgradeActivityViews(given?: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>): void {
  try {
    // Inside the try: reading localStorage itself can throw (a SecurityError where storage is blocked).
    const storage = given ?? localStorage
    const old: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k?.startsWith(OLD_PREFIX)) old.push(k)
    }
    for (const k of old) {
      const now = PREFIX + k.slice(OLD_PREFIX.length)
      const v = storage.getItem(k)
      if (v !== null && storage.getItem(now) === null) storage.setItem(now, v)
      storage.removeItem(k)
    }
  } catch {
    // Blocked or full: the views start afresh.
  }
}

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
    if (Number.isInteger(v.forCard) && (v.forCard as number) > 0) out.forCard = v.forCard as number
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
