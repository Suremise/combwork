// A Git project's slot options as they inherit (HI-1765): the project's own (project.json `slots`, or before 1.0 its
// `worktreeCopy`), then its workspace's, then Combwork's, then the built-in default. A value left out inherits; an empty
// string is "none" and is kept, at the level that set it. One resolver for slots, review copies and the old worktree
// paths, and for the window's "where it comes from".
import { SLOT_COPY_DEFAULT } from './defaults'
import type { ProjectConfig, SlotDefaults } from './types'
import { msg } from './i18n/msg'

/** Where a slot option's value comes from. */
export type SlotOptionOrigin = 'project' | 'workspace' | 'global' | 'default'

/** The levels above a project: Combwork's (settings `slotDefaults`) and its workspace's (workspace.json `slotDefaults`). */
export interface SlotLevels {
  global?: SlotDefaults | null
  workspace?: SlotDefaults | null
}

/**
 * The git-ignored files copied into the project's new slots and review copies, and the level that set them. `cfg`
 * null: a level's own form (the workspace's inherits Combwork's, Combwork's the default), with `levels` above it.
 */
export function slotCopyOf(cfg: Pick<ProjectConfig, 'slots' | 'worktreeCopy'> | null, levels: SlotLevels): { value: string; origin: SlotOptionOrigin } {
  const own = cfg?.slots?.copy ?? cfg?.worktreeCopy
  if (own != null) return { value: own, origin: 'project' }
  if (levels.workspace?.copy != null) return { value: levels.workspace.copy, origin: 'workspace' }
  if (levels.global?.copy != null) return { value: levels.global.copy, origin: 'global' }
  return { value: SLOT_COPY_DEFAULT, origin: 'default' }
}

/** A level's slot defaults as its form shows them (HI-1765): its own, and what it would inherit without them. */
export interface SlotLevelForm {
  own: SlotDefaults
  inherited: { copy: { value: string; origin: SlotOptionOrigin } }
}

/**
 * The copied files' name and what they are, at every level (HI-1765): Settings → Workflow defaults (Git), Settings →
 * Workspace, and the Assistant's settings tool.
 */
export const SLOT_COPY_TEXT = {
  title: msg({ id: 'settings.slotCopy.title', defaultMessage: 'Files copied into new slots', description: 'A workflow default (Git) and a project setting: the git-ignored files copied from the project folder into each new slot and review copy (glossary 2.5: slot, review copy).' }),
  desc: msg({ id: 'settings.slotCopy.desc', defaultMessage: 'Git-ignored files copied from the project folder into each new slot and review copy, comma separated or one per line, such as .env files. Projects inherit it, and can set their own in Version Control → Slots and copies.', description: 'What the workflow default “Files copied into new slots” does, at Combwork’s and a workspace’s level (glossary 2.5: slot, review copy). Keep .env as it is.' })
}
