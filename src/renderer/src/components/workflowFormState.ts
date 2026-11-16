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

/** Why Save… is off, the first that applies (HI-3333: each has its tooltip), or null when it can be pressed. */
export type SaveOff = 'noChanges' | 'blocked' | 'missingBranches' | 'loading'

export function saveOff(s: { dirty: boolean; settings: boolean; blocked: boolean; missingBranches: number }): SaveOff | null {
  if (!s.dirty) return 'noChanges'
  if (s.blocked) return 'blocked'
  if (s.missingBranches > 0) return 'missingBranches'
  if (!s.settings) return 'loading'
  return null
}
