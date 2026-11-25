// Where the revision reads port is found (HI-3218): a platform's by its id. A lookup, never a switch on a platform id
// (SPEC §16.3.6's rule 2): a caller asks `revisionReadsOf(platform)`, and a platform without one (None: no repository)
// has no revision diff to show.

import type { PlatformId } from '../../shared/platform/descriptors'
import { gitRevisionReads } from './git/gitRevisionReads'
import type { RevisionReads } from './revisionReads'

/** Each platform's revision reads; absent for a platform with none (None). */
const PORTS: Partial<Record<PlatformId, RevisionReads>> = { git: gitRevisionReads }

/** A platform's revision reads, or null for one with no repository (None). */
export const revisionReadsOf = (platform: PlatformId): RevisionReads | null => PORTS[platform] ?? null
