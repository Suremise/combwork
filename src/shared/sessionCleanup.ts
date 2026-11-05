import type { SessionListItem } from './types'

/**
 * The Sessions tab's Clean Up… (#895): which of a project's sessions archive or delete takes when they were last
 * active longer ago than an age, and which it leaves alone. Archive takes Hive's own sessions that aren't archived yet;
 * Delete takes every session, archived or not, as the branch actions do. Running sessions, the one open in the tab and
 * the Hive Assistant's current conversation are always left alone. The ids taken go to session:bulk, which checks each
 * again (running in another window, files in use) and says what it skipped.
 */

export type CleanupAge = 'day' | 'week' | 'month'
export type CleanupAction = 'archive' | 'delete'

/** How long ago each age is. */
export const CLEANUP_AGE_MS: Record<CleanupAge, number> = { day: 24 * 3600_000, week: 7 * 24 * 3600_000, month: 30 * 24 * 3600_000 }
export const CLEANUP_AGES: CleanupAge[] = ['day', 'week', 'month']

/**
 * Why Clean Up leaves an old session alone before asking main: `live`: running; `shown`: its transcript is open in the
 * tab; `current`: the Hive Assistant's current conversation (the one it resumes).
 */
export type CleanupSkip = 'live' | 'shown' | 'current'

export interface CleanupPlan {
  /** What goes: old enough, of the kind the action takes, and not left alone. */
  go: SessionListItem[]
  skipped: { item: SessionListItem; reason: CleanupSkip }[]
}

/** When a session was last active (its last message, else its record's last update or start), as ms; null if unknown. */
export function lastActive(s: SessionListItem): number | null {
  for (const t of [s.lastActivity, s.lastActiveAt, s.createdAt]) {
    const ms = t ? Date.parse(t) : NaN
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/** The sessions an action takes regardless of age (the branch actions' rule): archive only Hive's own, not archived yet. */
export function cleanupTakes(s: SessionListItem, action: CleanupAction): boolean {
  return action === 'delete' || (!s.archived && s.source === 'combwork')
}

/**
 * What Clean Up takes from `items` for an action and age, at `now`. A session last active exactly at the cut-off, or
 * with no time known, stays. Each session is judged by its own activity, sub-sessions too.
 */
export function cleanupPlan(
  items: readonly SessionListItem[],
  opts: { age: CleanupAge; action: CleanupAction; now: number; live: (id: string) => boolean; shown?: string | null; current?: string | null }
): CleanupPlan {
  const cutoff = opts.now - CLEANUP_AGE_MS[opts.age]
  const plan: CleanupPlan = { go: [], skipped: [] }
  for (const s of items) {
    const at = lastActive(s)
    if (at === null || at >= cutoff || !cleanupTakes(s, opts.action)) continue
    const reason: CleanupSkip | null = opts.live(s.id) ? 'live' : s.id === opts.shown ? 'shown' : s.id === opts.current ? 'current' : null
    if (reason) plan.skipped.push({ item: s, reason })
    else plan.go.push(s)
  }
  return plan
}
