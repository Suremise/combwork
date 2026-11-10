// The workflow's adapters, by platform (SPEC §16.3.6 type map, HI-2792's R9): the one place that names each platform's
// PlatformAdapter, so the runtime builds them from this map and imports no platform's code. A lookup, never a switch on
// a platform id (§16.3.6's rule 2): a later platform adds its factory here.

import type { PlatformId } from '../../shared/platform/descriptors'
import type { Workflow } from '../workflow/runtime'
import type { PlatformAdapter } from './adapter'
import { GitPlatform } from './gitPlatform'
import type { NoneAdapter } from './none'
import { NonePlatform } from './nonePlatform'
import { JjPlatform } from './jjPlatform'

/** Each platform's adapter for a project's workflow; None's is given the workflow's content hashing. */
const ADAPTERS: Record<PlatformId, (wf: Workflow, none: NoneAdapter) => PlatformAdapter> = {
  git: (wf) => new GitPlatform(wf),
  none: (wf, none) => new NonePlatform(wf, none),
  // HI-2868: jj's card work, behind `start.platformReady` until J9e; its dependencies come from the workflow's config.
  jj: (wf) => new JjPlatform(wf)
}

/** Every platform's adapter for one workflow, built in the order the map names them (as the runtime built them before). */
export function adaptersFor(wf: Workflow, none: NoneAdapter): Record<PlatformId, PlatformAdapter> {
  return Object.fromEntries(Object.entries(ADAPTERS).map(([id, make]) => [id, make(wf, none)])) as Record<PlatformId, PlatformAdapter>
}
