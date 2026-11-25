// Where a platform's workspace lifecycle port is found (SPEC §16.3.6 Port 2, HI-2786's R4): by the platform, or, for the
// slot pool, by the isolation capability. A lookup, never a switch on a platform id (§16.3.6's rule 2). None has no
// isolation (OP-16), so no port: it has no slots. Callers moved to the port (slots.ts, slotCards.ts, agentWorktree.ts)
// import this module and workspacePort.ts, never a platform's own worktree modules (tests/repoPortsImports.test.ts).

import type { PlatformId } from '../../shared/platform/descriptors'
import { gitWorkspacePort } from './git/gitWorkspacePort'
import type { Relocation, WorkspacePort } from './workspacePort'
import { repoHolding } from './repoPorts'

/** Each platform's port; absent for a platform without the isolation capability (None). */
const PORTS: Partial<Record<PlatformId, WorkspacePort>> = { git: gitWorkspacePort }

/** A platform's workspace lifecycle port, or null for one without isolation (None). */
export const workspacePortOf = (platform: PlatformId): WorkspacePort | null => PORTS[platform] ?? null

/**
 * The relocation of the repository platform holding `folder` (HI-2792: Repair after a move), read from its folders; null
 * when none holds it or its platform has no relocation (§16.3.6).
 */
export function relocationIn(folder: string): Relocation | null {
  const holder = repoHolding(folder)
  return (holder && workspacePortOf(holder.platform)?.relocate) ?? null
}

/**
 * The relocation of the platform slots are made with (HI-2792): Repair's worktree steps for a project's slots and agents'
 * worktrees (Git alone in 1.4.0), null when it has none.
 */
export const slotRelocation = (): Relocation | null => slotWorkspaces().relocate ?? null

/** Git's worktrees: the port slots and copies are made with. */
export function slotWorkspaces(): WorkspacePort {
  return gitWorkspacePort
}
