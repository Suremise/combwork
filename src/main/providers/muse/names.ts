import { advancedDef, advancedRoles } from '../../../shared/advanced'
import { MUSE_CONFIG, MUSE_EVENTS, MUSE_FIELDS, MUSE_LOG_NAMES, MUSE_NAME_IDS, type MuseConfig, type MuseEvent, type MuseField, type MuseLog } from '../../../shared/providers/muse/names'
import { advancedValues, type AdvancedReader } from '../../advancedValues'
import { createLogger } from '../../logger'

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

/** Each refused value said once while it stays the same (the log is bounded). */
const said = new Map<string, string>()

function mapping<R extends string>(id: string, fallback: Readonly<Record<R, string>>, reader: AdvancedReader): Readonly<Record<R, string>> {
  const def = advancedDef(id)
  const value = reader.get<string[]>(id)
  const map = def ? advancedRoles(def, value) : null
  if (map) return map as Readonly<Record<R, string>>
  const shown = JSON.stringify(value).slice(0, 300)
  if (said.get(id) !== shown) {
    said.set(id, shown)
    log.warn(`${id}: not a whole mapping of its roles, so 1.4.20's names are used: ${shown}`) // i18n-ignore: for the log
  }
  return fallback
}

/** The hook and launch names now (a launch's own, taken at its start). */
export function launchNames(reader: AdvancedReader = advancedValues): MuseNames {
  return { events: mapping(MUSE_NAME_IDS.events, MUSE_EVENTS, reader), fields: mapping(MUSE_NAME_IDS.fields, MUSE_FIELDS, reader), config: mapping(MUSE_NAME_IDS.config, MUSE_CONFIG, reader) }
}

/** The session log's names now (one reader's, for the whole of its reading). */
export function logNames(reader: AdvancedReader = advancedValues): Readonly<Record<MuseLog, string>> {
  return mapping(MUSE_NAME_IDS.log, MUSE_LOG_NAMES, reader)
}
