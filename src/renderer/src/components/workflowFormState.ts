import type { WorkflowChange, WorkflowForm } from '../../../shared/types'

/** The Workflow section's form as read (or saved) for a project, and its draft (WorkflowOptions.tsx). */
export interface LoadedForm {
  for: string
  form: WorkflowForm
  draft: WorkflowChange
}

/** A form as read: its draft is what is saved. */
export const loadedForm = (path: string, form: WorkflowForm): LoadedForm => ({ for: path, form, draft: { preset: form.preset, options: { ...form.own } } })

/**
 * The form once a save of a project's options returns (HI-3333): the saved options are the form's from now on, and the
 * draft is reset to them, unless the user edited it while the save ran (a preset used, a template or release offer laid
 * over it). That edit stays, measured against what was saved, so Save… shows whether there is still something to save
 * rather than the edit being dropped without a word.
 */
export function afterSave(now: LoadedForm | null, path: string, saved: WorkflowForm, editedMeanwhile: boolean): LoadedForm {
  if (editedMeanwhile && now && now.for === path) return { for: path, form: saved, draft: now.draft }
  return loadedForm(path, saved)
}

/**
 * HI-3592: a draft whose save found the options changed meanwhile, after moves made for it already (Save…'s pre-save
 * retarget): the user's own edits (what the draft changed from the form it was read with, `was`) laid over the options
 * as they are now (`now`), never the old values of what changed elsewhere, so the next Save… checks them afresh.
 */
export function rebaseDraft(was: Pick<WorkflowForm, 'preset' | 'own'>, draft: WorkflowChange, now: Pick<WorkflowForm, 'preset' | 'own'>): WorkflowChange {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const before = was.own as Record<string, unknown>
  const mine = draft.options as Record<string, unknown>
  const options: Record<string, unknown> = { ...(now.own as Record<string, unknown>) }
  for (const k of new Set([...Object.keys(before), ...Object.keys(mine)])) {
    if (same(before[k], mine[k])) continue
    if (mine[k] === undefined) delete options[k]
    else options[k] = mine[k]
  }
  return { preset: draft.preset !== was.preset ? draft.preset : now.preset, options: options as WorkflowChange['options'] }
}

/** HI-3592: the form after such a save: the options as they are now, the draft rebased onto them (`rebaseDraft`). */
export function afterStale(path: string, was: Pick<WorkflowForm, 'preset' | 'own'>, draft: WorkflowChange, now: WorkflowForm): LoadedForm {
  return { for: path, form: now, draft: rebaseDraft(was, draft, now) }
}

/** Why Save… is off, the first that applies (HI-3333: each has its tooltip), or null when it can be pressed. */
export type SaveOff = 'noChanges' | 'blocked' | 'missingBranches' | 'loading'

export function saveOff(s: { dirty: boolean; settings: boolean; blocked: boolean; missingBranches: number }): SaveOff | null {
  if (!s.dirty) return 'noChanges'
  if (s.blocked) return 'blocked'
  if (s.missingBranches > 0) return 'missingBranches'
  if (!s.settings) return 'loading'
  return null
}
