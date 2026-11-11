// What the window offers of the repository mutations (SPEC §16.3.6 port 5, HI-2788's R3): pure checks of the shared map
// against the platform's operations, apart from the dispatch (repoOps.ts) so the unit tests read them without the
// window's IPC. The platform is the one with repository operations, whatever the project's recorded workflow platform,
// as main's lineRepoOps selects it (repoOps.ts says why).

import { PLATFORMS, type PlatformId } from '../../shared/platform/descriptors'
import { REPO_OP_CHANNELS, type RepoOpChannel } from '../../shared/repoOpChannels'

/** The platform with repository operations (Git alone in 1.4.0): never chosen by an id. */
const repository = (): PlatformId | null => Object.values(PLATFORMS).find((p) => p.operations.length > 0)?.id ?? null

/** Whether the window offers a channel's action: its operation is one the repository's platform lists. */
export function offered(channel: RepoOpChannel): boolean {
  const p = repository()
  return !!p && PLATFORMS[p].operations.includes(REPO_OP_CHANNELS[channel])
}

/**
 * Clean Up's offer as far as it is offered (HR3's HI-2788 round 1): its local lines only while deleting lines is, its
 * remote ones only while deleting remote lines is, each part by its own operation; the action is offered while either is.
 */
export function offeredCleanup<T extends { local: readonly unknown[]; remote: readonly unknown[] }>(offer: T): T {
  return { ...offer, local: offered('git:deleteBranches') ? offer.local : [], remote: offered('git:deleteRemoteBranches') ? offer.remote : [] }
}
