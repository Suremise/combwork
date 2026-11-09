// Where the repository reads port is found (SPEC §16.3.6 port 5, HI-2785's R2): a platform's reads by its id. A lookup,
// never a switch on a platform id (§16.3.6's rule 2): a caller asks `repoReadsOf(platform)` and takes a platform without
// one (None: no repository to read) down its own path. Callers moved to the port import this module and repoReads.ts,
// never a platform's own modules (tests/repoReadsImports.test.ts holds them to it).

import type { PlatformId } from '../../shared/platform/descriptors'
import { gitRepoReads } from './gitRepoReads'
import type { RepoReads } from './repoReads'

/** Each platform's repository reads; absent for a platform with none (None). In the order lineRepoReads looks. */
const PORTS: Partial<Record<PlatformId, RepoReads>> = { git: gitRepoReads }
const ORDER: readonly RepoReads[] = Object.values(PORTS)

/** A platform's repository reads, or null for one with no repository (None). */
export const repoReadsOf = (platform: PlatformId): RepoReads | null => PORTS[platform] ?? null

/**
 * The reads of the platform whose projects have a repository, for the window's calls, which don't carry the project's
 * platform yet: today they read the folder whatever the project's platform (a None project's folder inside a repository
 * still shows it), and 1.4.0 keeps that. 1.4.0 has one such platform; SPEC §16.3.6's type map lists these callers
 * against R9, which routes them by the project's platform once they carry it.
 */
export function lineRepoReads(): RepoReads {
  return ORDER[0]
}
