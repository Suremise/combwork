import { jsonLines, promptRead, timeOf, touchedTurns, turnsMemo, workRead } from '../turns'
import type { TranscriptTurn } from '../types'
import { isUserPrompt } from './prompts'

/** Which turn each entry belongs to, by its uuid: kept between reads (bounded), for the entries that follow it. */
interface Owners {
  owners: Map<string, string>
}

const MAX_OWNERS = 50_000

/**
 * Claude Code's turns in transcript lines (#1371, checked against 2.1.306): a turn is its prompt's `promptId`, which its
 * hooks carry as `prompt_id`. Every user entry has it (the prompt, tool results, meta and local command entries); an
 * assistant entry has none and belongs to the turn of the entry its `parentUuid` names, as do the attachment and system
 * entries in the chain. A turn counts from its prompt: a person's (or Hive's typed) prompt, never a meta entry, a
 * compaction's summary, a tool result, a task notification's wake (its hooks aren't certain) or a side conversation's
 * (`isSidechain`). It is worked once a main-chain assistant entry belongs to it: a local command has none.
 */
export function claudeTranscriptTurns(appended: string, memo: Record<string, unknown>): TranscriptTurn[] {
  const m = turnsMemo(memo)
  const o = (memo.claudeOwners ??= { owners: new Map() }) as Owners
  const touched = new Set<string>()
  const own = (uuid: unknown, turn: string): void => {
    if (typeof uuid !== 'string' || !uuid) return
    o.owners.set(uuid, turn)
    if (o.owners.size > MAX_OWNERS) o.owners.delete(o.owners.keys().next().value!)
  }
  for (const e of jsonLines(appended)) {
    if (e.isSidechain) continue
    const parent = typeof e.parentUuid === 'string' ? o.owners.get(e.parentUuid) : undefined
    if (e.type === 'user' && typeof e.promptId === 'string' && e.promptId) {
      own(e.uuid, e.promptId)
      const system = (e.origin && typeof e.origin === 'object' && e.origin.kind !== undefined && e.origin.kind !== 'human') || e.promptSource === 'system'
      if (isUserPrompt(e) && !system) promptRead(m, e.promptId, timeOf(e.timestamp), touched)
      continue
    }
    if (!parent) continue
    own(e.uuid, parent)
    if (e.type === 'assistant') workRead(m, parent, touched)
  }
  return touchedTurns(m, touched)
}
