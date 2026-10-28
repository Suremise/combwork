// The Version Control tab's Slots and copies settings (#1445, SPEC §16.6.6): each one key of project.json's `slots`
// (`setup`, `archive`, `copy`) or `copies.size`, set or removed under the project's lock against its config as it is
// then (HR5's round 1: the window sending the whole `slots` object from what it last read lost another field's change,
// or another window's). A value set (an empty string too: "none", over the old `worktreeSetup` / `worktreeCopy`) is the
// project's own; null removes it, so it falls back (slots.ts `slotOptionsOf`).

import { hiveError } from './hiveError'
import { msg } from '../shared/i18n/msg'
import type { ProjectConfig, SlotDefaults, SlotOptions, WorkflowLevel } from '../shared/types'
import { config } from './config'
import { slotLevelsOf } from './slots'
import { slotCopyOf, type SlotLevelForm, type SlotOptionOrigin } from '../shared/slotDefaults'
import type { WorkspaceService } from './workspace'

export type SlotSettingKey = keyof SlotOptions | 'copiesSize'

const KEYS: readonly SlotSettingKey[] = ['setup', 'archive', 'copy', 'copiesSize']
/** The longest a script or a list of patterns may be. */
const MAX_TEXT = 4000

const M = {
  bad: msg({ id: 'slots.setting.bad', defaultMessage: 'That isn’t a slot setting Hive has.', description: 'An error: a request to change a setting of “Slots and copies” named one that doesn’t exist.' }),
  badSize: msg({ id: 'slots.setting.badSize', defaultMessage: 'The number of review and check copies is a whole number from {min, number} to {max, number}.', description: 'An error: the number of review and check copies given isn’t a whole number from 1 to 32. {min} and {max} are the limits (1 and 32).' }),
  badText: msg({ id: 'slots.setting.badText', defaultMessage: 'A slot script or list of files is text of at most {max, number} characters.', description: 'An error: a slot script or list of copied files given isn’t text, or is too long. {max} is the limit (4,000).' })
}

/** What a project now stores of its slot settings, after the change. */
export interface SlotSettingsNow {
  slots: SlotOptions
  copies: NonNullable<ProjectConfig['copies']>
}

/** Sets (or, with null, removes) one slot setting of a project, under its lock; refused when the key or value isn't one. */
export async function setSlotSetting(ws: WorkspaceService, projectPath: string, key: SlotSettingKey, value: string | number | null): Promise<SlotSettingsNow> {
  if (!KEYS.includes(key)) throw hiveError(M.bad, undefined, { kind: 'invalid' })
  if (key === 'copiesSize') {
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 32)) throw hiveError(M.badSize, { min: 1, max: 32 }, { kind: 'invalid' })
  } else if (value !== null && (typeof value !== 'string' || value.length > MAX_TEXT)) throw hiveError(M.badText, { max: MAX_TEXT }, { kind: 'invalid' })
  const cfg = await ws.mutateProjectConfig(projectPath, (c) => {
    if (key === 'copiesSize') {
      const copies = { ...c.copies }
      if (value === null) delete copies.size
      else copies.size = value as number
      return { copies }
    }
    const slots = { ...c.slots }
    if (value === null) delete slots[key]
    else slots[key] = key === 'copy' ? (value as string) : (value as string).trim()
    // The copy's Inherit takes the project's own value from before 1.0 too (HI-1765: its `worktreeCopy` is its own, read
    // after `slots.copy`), so it then inherits the workspace's or Hive's.
    if (key === 'copy' && value === null && c.worktreeCopy != null) return { slots, worktreeCopy: null }
    return { slots }
  })
  return { slots: cfg.slots ?? {}, copies: cfg.copies ?? {} }
}

/** Hive's or the workspace's slot defaults, with what each inherits (Hive's: the built-in default). */
export function slotLevelForm(ws: WorkspaceService, level: WorkflowLevel): SlotLevelForm {
  if (level !== 'global' && level !== 'workspace') throw hiveError(M.bad, undefined, { kind: 'invalid' })
  const levels = slotLevelsOf(config.settings, ws)
  return level === 'global' ? { own: { ...levels.global }, inherited: { copy: slotCopyOf(null, {}) } } : { own: { ...levels.workspace }, inherited: { copy: slotCopyOf(null, { global: levels.global }) } }
}

/** A project's copied files as they inherit, and where they come from (the window's Slots and copies). */
export async function projectSlotCopy(ws: WorkspaceService, projectPath: string): Promise<{ value: string; origin: SlotOptionOrigin }> {
  return slotCopyOf(await ws.projectConfig(projectPath), slotLevelsOf(config.settings, ws))
}

/** The slot defaults a level can set for the Git projects under it (HI-1765). */
export type SlotDefaultKey = keyof SlotDefaults
const DEFAULT_KEYS: readonly SlotDefaultKey[] = ['copy']

/**
 * Sets (or, with null, removes, so it inherits) one of a level's slot defaults (HI-1765): Hive's (config.json) or the
 * workspace's (workspace.json, under its lock, against it as it is then). An empty string is that level's "none".
 * `check` sees the level's defaults as the change replaces them, in the change's own turn (the workspace's in its save
 * queue, HR5's HI-1765 round 1): throwing refuses it, nothing written.
 */
export async function setSlotDefault(ws: WorkspaceService, level: WorkflowLevel, key: SlotDefaultKey, value: string | null, check?: (now: SlotDefaults | undefined) => void): Promise<SlotDefaults> {
  if (level !== 'global' && level !== 'workspace') throw hiveError(M.bad, undefined, { kind: 'invalid' })
  if (!DEFAULT_KEYS.includes(key)) throw hiveError(M.bad, undefined, { kind: 'invalid' })
  if (value !== null && (typeof value !== 'string' || value.length > MAX_TEXT)) throw hiveError(M.badText, { max: MAX_TEXT }, { kind: 'invalid' })
  const next = (now: SlotDefaults | undefined): SlotDefaults => {
    const d = { ...now }
    if (value === null) delete d[key]
    else d[key] = value
    return d
  }
  if (level === 'global') {
    check?.(config.settings.slotDefaults)
    return config.setSlotDefaults(next(config.settings.slotDefaults)).slotDefaults ?? {}
  }
  let saved: SlotDefaults = {}
  let checked = false
  await ws.saveWorkspaceConfigWith((c) => {
    // The save works the change out again once written: checked only the first time, before anything is written.
    if (!checked) check?.(c.slotDefaults)
    checked = true
    saved = next(c.slotDefaults)
    return { slotDefaults: saved }
  })
  // The windows read it again, whoever changed it (the settings tool, another window): their open rows follow.
  ws.scheduleRefresh()
  return saved
}
