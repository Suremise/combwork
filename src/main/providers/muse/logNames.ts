import { advancedDef, advancedRoles } from '../../../shared/advanced'
import { MUSE_LOG_NAMES, MUSE_NAME_IDS, type MuseLog } from '../../../shared/providers/muse/names'
import { advancedValues, type AdvancedReader } from '../../advancedValues'

/**
 * Muse Code's mappings read whole (HI-3202), and the session log's names, without the logger (HI-3259): the usage worker's
 * parser reads the log's names, and the logger loads Electron, which ends a worker thread in an installed Combwork
 * (HI-1880). A mapping that isn't one is told to what main set (names.ts: its log line); in the usage worker nothing is
 * set, so it falls back unsaid there, and main says it when it reads the same setting.
 */
export type RefusedMapping = (id: string, value: unknown) => void

let refused: RefusedMapping = () => {}

/** Where a stored mapping that isn't one is told (main's log, set by names.ts). */
export function onRefusedMapping(fn: RefusedMapping): void {
  refused = fn
}

/** A mapping's value as the reader gives it, taken whole, or `fallback` whole when it isn't one. */
export function nameMapping<R extends string>(id: string, fallback: Readonly<Record<R, string>>, reader: AdvancedReader): Readonly<Record<R, string>> {
  const def = advancedDef(id)
  const value = reader.get<string[]>(id)
  const map = def ? advancedRoles(def, value) : null
  if (map) return map as Readonly<Record<R, string>>
  refused(id, value)
  return fallback
}

/** The session log's names now (one reader's, for the whole of its reading). */
export function logNames(reader: AdvancedReader = advancedValues): Readonly<Record<MuseLog, string>> {
  return nameMapping(MUSE_NAME_IDS.log, MUSE_LOG_NAMES, reader)
}
