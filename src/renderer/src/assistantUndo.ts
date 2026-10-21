import type { AssistantUndoResult } from '@shared/types'
import { call } from './api'
import { set } from './store'

/**
 * Undo of the Assistant's changes in its panel (#1283, SPEC §16.14): the changes kept for undo (#1282's IPC), by the
 * user's message they came from, and what each undo did, kept for this window's session so a change skipped says why.
 */

let loads = 0

/** Loads the Assistant's changes kept for undo; a load overtaken by a newer one is dropped. */
export async function loadAssistantChanges(): Promise<void> {
  const mine = ++loads
  const groups = await call('assistant:changes').catch(() => null)
  if (groups && mine === loads) set({ assistantChanges: groups })
}

/** Undoes one change or a message's changes: what each did, kept beside its row, then the list again. */
export async function undoChanges(sel: { change: string } | { group: string }): Promise<AssistantUndoResult[]> {
  try {
    const results = await call('assistant:undo', sel)
    set((s) => ({ assistantUndone: { ...s.assistantUndone, ...Object.fromEntries(results.map((r) => [r.change, r])) } }))
    return results
  } finally {
    await loadAssistantChanges()
  }
}
