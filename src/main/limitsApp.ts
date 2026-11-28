import { advanced } from './advanced'
import { GIT_COMMIT_MINUTES, GIT_HISTORY_SECONDS, GIT_NETWORK_MINUTES, GIT_PROCESS_NAMES, GIT_STALE_LOCK_SECONDS, QUEUE_CHECK_MINUTES, QUEUE_NETWORK_MINUTES } from '../shared/advanced'
import { platformLimits } from './platform/limits'

/** A setting's value as a whole number of ms (its unit `perMs`), at least 1: its own default where it can't be read. */
const ms = (id: string, perMs: number, fallback: number): (() => number) => () => {
  const n = Number(advanced.get(id))
  return Math.max(1, Math.round((Number.isFinite(n) && n > 0 ? n : fallback) * perMs))
}

/**
 * HI-3372: the version-control ports' bounds, read from Settings → Advanced each time one is used (a change applies to
 * the next command). Called once as main starts.
 */
export function applyAdvancedLimits(): void {
  platformLimits.gitCommitMs = ms(GIT_COMMIT_MINUTES, 60_000, 30)
  platformLimits.gitNetworkMs = ms(GIT_NETWORK_MINUTES, 60_000, 30)
  platformLimits.queueNetworkMs = ms(QUEUE_NETWORK_MINUTES, 60_000, 30)
  platformLimits.queueCheckMs = ms(QUEUE_CHECK_MINUTES, 60_000, 90)
  platformLimits.staleLockMs = ms(GIT_STALE_LOCK_SECONDS, 1000, 60)
  platformLimits.gitHistoryMs = ms(GIT_HISTORY_SECONDS, 1000, 60)
  platformLimits.gitProcessNames = () => advanced.pattern(GIT_PROCESS_NAMES)
}
