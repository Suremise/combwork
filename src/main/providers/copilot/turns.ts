import { jsonLines, promptKey, promptRead, timeOf, touchedTurns, turnsMemo, workRead } from '../turns'
import type { TranscriptTurn } from '../types'

/**
 * Copilot's turns in events.jsonl lines (#1371; 1.0.95–1.0.98): a turn is one `interactionId`, begun by a `user.message`
 * (its `turnId` is a count of model calls within it, not a turn). It is worked once an `assistant.turn_start` or
 * `assistant.message` of it was written. Its hooks carry no turn id (turnsJoin 'time'): its prompt hook answers it by
 * the prompt's text (`prompt`, as hooksHealth compares them), any later hook by when it came.
 */
export function copilotTranscriptTurns(appended: string, memo: Record<string, unknown>): TranscriptTurn[] {
  const m = turnsMemo(memo)
  const touched = new Set<string>()
  for (const e of jsonLines(appended)) {
    const d = e.data && typeof e.data === 'object' ? (e.data as Record<string, any>) : {}
    const id = typeof d.interactionId === 'string' && d.interactionId ? d.interactionId : null
    if (!id) continue
    if (e.type === 'user.message') promptRead(m, id, timeOf(e.timestamp), touched, typeof d.content === 'string' ? promptKey(d.content) : undefined)
    else if (e.type === 'assistant.turn_start' || e.type === 'assistant.message') workRead(m, id, touched)
  }
  return touchedTurns(m, touched)
}
