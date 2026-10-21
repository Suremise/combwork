import type { AssistantAction, AssistantChangeGroup, AssistantChangeRow } from './types'

/**
 * The Assistant panel's list of its changes (#1283, SPEC §16.14): its changes kept for undo (#1282) by the user's message
 * they came from, with the Assistant's actions of each message that aren't changes, and the line each change is said with.
 */

/** Whether undo can still do something for a change: it can be undone and isn't yet (a failed attempt stays offered). */
export const undoable = (c: AssistantChangeRow): boolean => c.kind !== 'final' && !c.undoneAt

/**
 * One message of the user's in the panel's list: its changes, and the Assistant's actions of it that aren't changes (a
 * refusal or failure, an undo), newest first.
 */
export interface MessageGroup {
  id: string
  at: string
  changes: AssistantChangeRow[]
  actions: AssistantAction[]
  /** Its actions listed by their changes, oldest first: the line a change of theirs is said with (lineOf). */
  lines: AssistantAction[]
}

/**
 * The panel's list (#1283): every message with changes kept, and those with only refusals, failures or undos, newest
 * first. An action that changed something is listed by its changes, not again on its own.
 */
export function messageGroups(changes: readonly AssistantChangeGroup[], actions: readonly AssistantAction[]): MessageGroup[] {
  const groups = new Map<string, MessageGroup>(changes.map((g) => [g.id, { id: g.id, at: g.at, changes: g.changes, actions: [], lines: [] }]))
  for (const a of actions) {
    if (!a.group) continue
    const listed = !a.ok || a.kind === 'undo' || a.kind === 'revert-setting'
    const g = groups.get(a.group) ?? { id: a.group, at: a.groupAt ?? a.at, changes: [], actions: [], lines: [] }
    if (!listed && !g.changes.length) continue
    ;(listed ? g.actions : g.lines).push(a)
    groups.set(a.group, g)
  }
  return [...groups.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/**
 * The line the Assistant's panel said a change with, while this window has it (its actions are kept while Hive runs): the
 * action of its kind in its message recorded nearest the change (just after it, or a setting's just before), the one
 * that made it.
 */
export function lineOf(g: MessageGroup, c: AssistantChangeRow): AssistantAction | undefined {
  const at = Date.parse(c.at)
  let best: AssistantAction | undefined
  for (const a of g.lines) if (a.kind === c.act && (!best || Math.abs(Date.parse(a.at) - at) < Math.abs(Date.parse(best.at) - at))) best = a
  return best
}
