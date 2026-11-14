import { MUSE_CONFIG, MUSE_EVENTS, MUSE_FIELDS, MUSE_NAME_IDS, type MuseConfig, type MuseEvent, type MuseField } from '../../../shared/providers/muse/names'
import { advancedValues, type AdvancedReader } from '../../advancedValues'
import { createLogger, userText } from '../../logger'
import { nameMapping, onRefusedMapping } from './logNames'

export { logNames } from './logNames'

const log = createLogger('muse')

/**
 * Muse Code's names as Combwork reads and gives them (HI-3202): its four advanced mappings (shared/providers/muse/names.ts),
 * each taken whole, or its defaults whole when the value isn't one (a stored value checkAdvanced would refuse: never part
 * of a map). A launch takes `launchNames()` once and keeps it to its end (the adapter's forLaunch copy): the hooks it gave
 * Muse are read back by the same names, whatever the setting says later. The session log's are read per reader (the
 * conversation's and the usage worker's parsers), through the reader of the thread they run on.
 */
export interface MuseNames {
  events: Readonly<Record<MuseEvent, string>>
  fields: Readonly<Record<MuseField, string>>
  config: Readonly<Record<MuseConfig, string>>
}

/** The defaults: 1.4.20's names. */
export const DEFAULT_NAMES: MuseNames = { events: MUSE_EVENTS, fields: MUSE_FIELDS, config: MUSE_CONFIG }

/**
 * The log's line for a stored mapping that isn't one: its value is the user's (a stored override, anything pasted), so it
 * is marked as theirs and left out of Copy Diagnostics; at most 300 characters of it.
 */
export function fallbackLine(id: string, value: unknown): string {
  return `${id}: not a whole mapping of its roles, so 1.4.20's names are used: ${userText(JSON.stringify(value)?.slice(0, 300))}` // i18n-ignore: for the log
}

/** Each refused value said once while it stays the same (the log is bounded). */
const said = new Map<string, string>()

onRefusedMapping((id, value) => {
  const shown = String(JSON.stringify(value)).slice(0, 300)
  if (said.get(id) === shown) return
  said.set(id, shown)
  log.warn(fallbackLine(id, value))
})

/** The hook and launch names now (a launch's own, taken at its start). */
export function launchNames(reader: AdvancedReader = advancedValues): MuseNames {
  return { events: nameMapping(MUSE_NAME_IDS.events, MUSE_EVENTS, reader), fields: nameMapping(MUSE_NAME_IDS.fields, MUSE_FIELDS, reader), config: nameMapping(MUSE_NAME_IDS.config, MUSE_CONFIG, reader) }
}
