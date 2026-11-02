import { jsonLines, promptRead, timeOf, touchedTurns, turnsMemo, workRead } from '../turns'
import type { TranscriptTurn } from '../types'

/** The turn the rollout is in now (a root turn's id), or null between turns and in a sub-turn. */
interface Current {
  turn: string | null
}

const rootOf = (p: Record<string, any>): string | null => {
  const id = typeof p.turn_id === 'string' && p.turn_id ? p.turn_id : null
  // A sub-turn (its root another turn) isn't a person's turn.
  return id && (p.root_turn_id === undefined || p.root_turn_id === null || p.root_turn_id === id) ? id : null
}

/**
 * Codex's turns in rollout lines (#1371; 0.159 and 0.163): a turn is its `turn_id`, which its hooks carry. A turn counts
 * from the person's prompt in it (an `item_completed` UserMessage with its turn_id, or, before 0.159, a `user_message`
 * event inside its task), so a compaction (a turn of its own with no prompt) never does, nor a sub-turn (`root_turn_id`
 * another). It is worked once the model wrote in it: an agent message or reasoning item, a token usage record, or a
 * `response_item` of the model's while it runs (those carry no turn id: they are the running turn's by position).
 */
export function codexTranscriptTurns(appended: string, memo: Record<string, unknown>): TranscriptTurn[] {
  const m = turnsMemo(memo)
  const cur = (memo.codexTurn ??= { turn: null }) as Current
  const touched = new Set<string>()
  for (const e of jsonLines(appended)) {
    const p = e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, any>) : {}
    const at = timeOf(e.timestamp)
    // A turn context names its turn when it has one (not every version's does): one without leaves the running turn as it is.
    if (e.type === 'turn_context') {
      if (typeof p.turn_id === 'string' && p.turn_id) cur.turn = rootOf(p)
    }
    else if (e.type === 'event_msg') {
      if (p.type === 'task_started') cur.turn = rootOf(p)
      else if (p.type === 'task_complete') cur.turn = null
      else if (p.type === 'user_message' && cur.turn) promptRead(m, cur.turn, at, touched)
      else if (p.type === 'agent_message' && cur.turn) workRead(m, cur.turn, touched)
      else if (p.type === 'item_completed') {
        const id = rootOf(p)
        const kind = p.item?.type
        if (id && kind === 'UserMessage') promptRead(m, id, at, touched)
        else if (id && (kind === 'AgentMessage' || kind === 'Reasoning')) workRead(m, id, touched)
      }
    } else if (e.type === 'token_usage_record') {
      const id = rootOf(p)
      if (id) workRead(m, id, touched)
    } else if (e.type === 'response_item' && cur.turn) {
      const kind = p.type
      if ((kind === 'message' && p.role === 'assistant') || kind === 'reasoning' || kind === 'function_call' || kind === 'custom_tool_call') workRead(m, cur.turn, touched)
    }
  }
  return touchedTurns(m, touched)
}
