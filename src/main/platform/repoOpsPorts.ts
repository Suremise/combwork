// Where the repository operations port is found (SPEC §16.3.6 port 5, HI-2788's R3): a platform's operations by its id,
// each call asking for the operation it makes, refused when the platform's descriptor doesn't list it (R5.2: never a near
// equivalent). A lookup, never a switch on a platform id (§16.3.6's rule 2). Callers moved to the port import this module
// and repoOps.ts, never a platform's own modules (tests/repoOpsImports.test.ts holds them to it).

import { hasOperation, type Operation, type PlatformId } from '../../shared/platform/descriptors'
import { PLATFORM_NAME } from '../../shared/platform/switching'
import { msg } from '../../shared/i18n/msg'
import { combworkError } from '../combworkError'
import { gitRepoOps } from './gitRepoOps'
import type { OpsFor, RepoOps } from './repoOps'

/** Each platform's repository operations; absent for a platform with none (None). In the order lineRepoOps looks. */
const PORTS: Partial<Record<PlatformId, RepoOps>> = { git: gitRepoOps }
const ORDER: readonly PlatformId[] = Object.keys(PORTS) as PlatformId[]

const NOT_OFFERED = msg({ id: 'service.repoOps.notOffered', defaultMessage: 'Version control ({platform}) doesn’t offer that here.', description: 'HI-2788: an error when the window asks to change a repository in a way its version control ({platform}: a version control’s name, as Combwork names it) doesn’t list. Not reached in 1.4.0: Git lists every operation.' })

/** A platform's repository operations for `op` (its members only), refused (in the window's words) when it doesn't list `op`. */
export function repoOpsFor<O extends Operation>(platform: PlatformId, op: O): OpsFor<O> {
  const ops = PORTS[platform]
  if (!ops || !hasOperation(platform, op)) throw combworkError(NOT_OFFERED, { platform: PLATFORM_NAME[platform] }, { kind: 'invalid' })
  return ops
}

/**
 * The operations of the platform whose projects have a repository, for `op`: the window's calls and the Assistant's
 * branch tool, which don't carry the project's platform yet and act on the folder as before (Initialise repository is on
 * Git's page whatever the project's platform, HI-1905). 1.4.0 has one such platform; SPEC §16.3.6's type map lists these
 * callers against R9, which routes them by the project's platform once they carry it.
 */
export function lineRepoOps<O extends Operation>(op: O): OpsFor<O> {
  return repoOpsFor(ORDER[0], op)
}
