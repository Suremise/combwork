// Where the deliverables port is found (SPEC §16.3.3, HI-3489): a platform's by its id. A lookup, never a switch on a
// platform id (§16.3.6's rule 2). The workflow imports this module and deliverables.ts, never a platform's own modules
// (tests/gitAudit.mjs' sealed folders hold it to that).

import type { PlatformId } from '../../shared/platform/descriptors'
import type { DeliverablesPort } from './deliverables'
import { noneDeliverables } from './none/noneDeliverables'

/** Each platform's deliverables; absent for a platform whose cards declare no paths (Git: its revisions are commits). */
const PORTS: Partial<Record<PlatformId, DeliverablesPort>> = { none: noneDeliverables }
const ORDER: readonly DeliverablesPort[] = Object.values(PORTS)

/**
 * The deliverables of the platform whose cards declare paths, or null when no installed platform's do (a build without
 * None). The workflow keeps one for every project while there is one (its watcher's writes and agents' edits invalidate
 * it) and asks it on a card's paths and checks; nothing else needs it, so a build without None starts without it.
 */
export function pathsDeliverables(): DeliverablesPort | null {
  return ORDER[0] ?? null
}

/** pathsDeliverables where only a card declaring paths gets: its platform is installed, so one is there. */
export function requirePathsDeliverables(): DeliverablesPort {
  const p = pathsDeliverables()
  if (!p) throw new Error('No platform declares paths') // i18n-ignore: an internal error, for the log
  return p
}
