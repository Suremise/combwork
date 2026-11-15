import { advanced } from '../advanced'
import { MERGE_GUARDS_LINES, MERGE_GUARDS_SECONDS } from '../../shared/advanced'

/** HI-3284: the merge guards' limits as Settings → Advanced says now: the matching's time limit and the most lines a merge adds. */
export function guardLimits(): { timeoutMs: number; maxLines: number } {
  return { timeoutMs: Math.max(1, Number(advanced.get(MERGE_GUARDS_SECONDS)) || 10) * 1000, maxLines: Math.max(1, Number(advanced.get(MERGE_GUARDS_LINES)) || 200_000) }
}
