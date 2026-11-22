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
 * The deliverables of the platform whose cards declare paths, for the workflow, which keeps one for every project
 * whatever its platform (its watcher's writes and agents' edits invalidate it) and asks it on a None card's paths and
 * checks. 1.4.0 has one such platform (None).
 */
export function pathsDeliverables(): DeliverablesPort {
  const p = ORDER[0]
  if (!p) throw new Error('No platform declares paths') // i18n-ignore: an internal error, for the log
  return p
}
