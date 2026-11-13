// Where the release reads port is found (HI-3148): a platform's by its id. A lookup, never a switch on a platform id
// (SPEC §16.3.6's rule 2): a caller asks `releaseReadsOf(platform)`, and a platform without one (None: no repository)
// has nothing released.

import type { PlatformId } from '../../shared/platform/descriptors'
import { gitReleaseReads } from './gitReleaseReads'
import { jjReleaseReads } from './jjReleaseReads'
import type { ReleaseReads } from './releaseReads'

/** Each platform's release reads; absent for a platform with none (None). */
const PORTS: Partial<Record<PlatformId, ReleaseReads>> = { git: gitReleaseReads, jj: jjReleaseReads }

/** A platform's release reads, or null for one with no repository (None: nothing is ever released). */
export const releaseReadsOf = (platform: PlatformId): ReleaseReads | null => PORTS[platform] ?? null
