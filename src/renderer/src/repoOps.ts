// The window's repository mutations (SPEC §16.3.6 port 5, HI-2788's R3): an action is offered only when the repository's
// platform lists its operation (`offered`, repoOffers.ts), and dispatched only then (`repoOp`); main refuses it too, by
// the same map (shared/repoOpChannels.ts). The platform is the one with repository operations, whatever the project's
// recorded workflow platform, as main's lineRepoOps selects it: the pages that change a repository (Version Control's
// Git sections and Initialise repository, the Merge dialogs, the Files tab's Git menu) act on the folder's own
// repository, as they did before (HI-1905: a None project choosing Git still sees Initialise repository). R9 routes by
// platform.

import type { CombworkRequests } from '@shared/api'
import { msg, tr } from '@shared/i18n'
import type { RepoOpChannel } from '@shared/repoOpChannels'
import { call } from './api'
import { offered } from './repoOffers'

export { offered, offeredCleanup } from './repoOffers'

const NOT_OFFERED = msg({ id: 'git.repoOp.notOffered', defaultMessage: 'This project’s version control doesn’t offer that.', description: 'HI-2788: an error when an action that changes a repository is asked for although its version control doesn’t list it. Not reached in 1.4.0: Git lists every action.' })

/** A repository mutation, dispatched only while offered (main refuses it otherwise too). */
export function repoOp<C extends RepoOpChannel>(channel: C, ...args: Parameters<CombworkRequests[C]>): Promise<Awaited<ReturnType<CombworkRequests[C]>>> {
  if (!offered(channel)) return Promise.reject(new Error(tr(NOT_OFFERED)))
  return call(channel, ...args)
}
