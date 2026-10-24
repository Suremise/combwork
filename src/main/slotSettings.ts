// The Version Control tab's Slots and copies settings (#1445, SPEC §16.6.6): each one key of project.json's `slots`
// (`setup`, `archive`, `copy`) or `copies.size`, set or removed under the project's lock against its config as it is
// then (HR5's round 1: the window sending the whole `slots` object from what it last read lost another field's change,
// or another window's). A value set (an empty string too: "none", over the old `worktreeSetup` / `worktreeCopy`) is the
// project's own; null removes it, so it falls back (slots.ts `slotOptionsOf`).

import { hiveError } from './hiveError'
import { msg } from '../shared/i18n/msg'
import type { ProjectConfig, SlotOptions } from '../shared/types'
import type { WorkspaceService } from './workspace'

export type SlotSettingKey = keyof SlotOptions | 'copiesSize'

const KEYS: readonly SlotSettingKey[] = ['setup', 'archive', 'copy', 'copiesSize']
/** The longest a script or a list of patterns may be. */
const MAX_TEXT = 4000

const M = {
  bad: msg({ id: 'slots.setting.bad', defaultMessage: 'That isn’t a slot setting Hive has.', description: 'An error: a request to change a setting of “Slots and copies” named one that doesn’t exist.' }),
  badSize: msg({ id: 'slots.setting.badSize', defaultMessage: 'The number of review and check copies is a whole number from 1 to 32.', description: 'An error: the number of review and check copies given isn’t a whole number from 1 to 32.' }),
  badText: msg({ id: 'slots.setting.badText', defaultMessage: 'A slot script or list of files is text of at most 4,000 characters.', description: 'An error: a slot script or list of copied files given isn’t text, or is too long.' })
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
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 32)) throw hiveError(M.badSize, undefined, { kind: 'invalid' })
  } else if (value !== null && (typeof value !== 'string' || value.length > MAX_TEXT)) throw hiveError(M.badText, undefined, { kind: 'invalid' })
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
    return { slots }
  })
  return { slots: cfg.slots ?? {}, copies: cfg.copies ?? {} }
}
