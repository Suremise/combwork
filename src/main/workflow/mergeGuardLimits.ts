import { advanced } from '../advanced'
import { MERGE_GUARDS_LINES, MERGE_GUARDS_SECONDS } from '../../shared/advanced'
import { GUARD_CHECK_DEFAULTS } from '../../shared/workflow/mergeGuards'

/** HI-3284: the merge guards' limits as Settings → Advanced says now: the matching's time limit and the most lines a merge adds. */
export function guardLimits(): { timeoutMs: number; maxLines: number } {
  return { timeoutMs: Math.max(1, Number(advanced.get(MERGE_GUARDS_SECONDS)) || GUARD_CHECK_DEFAULTS.timeoutMs / 1000) * 1000, maxLines: Math.max(1, Number(advanced.get(MERGE_GUARDS_LINES)) || GUARD_CHECK_DEFAULTS.maxLines) }
}
