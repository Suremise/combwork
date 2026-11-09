// Where the integration port is found (SPEC §16.3.6 port 4, HI-2790's R7): a platform's by its id. A lookup, never a
// switch on a platform id (§16.3.6's rule 2): a platform without integration (None) has none, and its projects have no
// merge queue (§16.3.3's acceptance instead). The merge queue imports this module and integration.ts, never a
// platform's own (tests/integrationPortsImports.test.ts holds it to that for the candidate steps).

import type { PlatformId } from '../../shared/platform/descriptors'
import { gitIntegration } from './gitIntegration'
import type { IntegrationPort } from './integration'

const PORTS: Partial<Record<PlatformId, IntegrationPort>> = { git: gitIntegration }

/** A platform's integration port, or null for one without integration (None). */
export const integrationOf = (platform: PlatformId): IntegrationPort | null => PORTS[platform] ?? null

/** A platform's integration port, for code reached only under a platform that has one (the merge queue's steps). */
export function integrationFor(platform: PlatformId): IntegrationPort {
  const p = integrationOf(platform)
  if (!p) throw new Error(`No integration port for ${platform}`) // i18n-ignore: an internal error, for the log
  return p
}
