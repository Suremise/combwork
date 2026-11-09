// Where a platform's workspace lifecycle port is found (SPEC §16.3.6 Port 2, HI-2786's R4): by the platform, or, for the
// slot pool, by the isolation capability. A lookup, never a switch on a platform id (§16.3.6's rule 2). None has no
// isolation (OP-16), so no port: it has no slots. Callers moved to the port (slots.ts, slotCards.ts, agentWorktree.ts)
// import this module and workspacePort.ts, never a platform's own worktree modules (tests/repoPortsImports.test.ts).

import { hasCapability, type PlatformId } from '../../shared/platform/descriptors'
import { gitWorkspacePort } from './gitWorkspacePort'
import type { WorkspacePort } from './workspacePort'

/** Each platform's port; absent for a platform without the isolation capability (None). */
const PORTS: Partial<Record<PlatformId, WorkspacePort>> = { git: gitWorkspacePort }

/** A platform's workspace lifecycle port, or null for one without isolation (None). */
export const workspacePortOf = (platform: PlatformId): WorkspacePort | null => PORTS[platform] ?? null

/**
 * The port slots are made with: the platform whose descriptor has the isolation capability. 1.4.0 has one (Git's
 * worktrees); a second (jj's workspaces, 1.5.0's J2) makes the pool take its project's platform's instead.
 */
export function slotWorkspaces(): WorkspacePort {
  const withIsolation = (Object.keys(PORTS) as PlatformId[]).filter((p) => hasCapability(p, 'isolation'))
  const port = withIsolation.length === 1 ? PORTS[withIsolation[0]] : undefined
  if (!port) throw new Error(`No single workspace port for slots (${withIsolation.join(', ') || 'none'})`) // i18n-ignore: an internal error, for the log
  return port
}
