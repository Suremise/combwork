// Where a platform's workspace lifecycle port is found (SPEC §16.3.6 Port 2, HI-2786's R4): by the platform, or, for the
// slot pool, by the isolation capability. A lookup, never a switch on a platform id (§16.3.6's rule 2). None has no
// isolation (OP-16), so no port: it has no slots. Callers moved to the port (slots.ts, slotCards.ts, agentWorktree.ts)
// import this module and workspacePort.ts, never a platform's own worktree modules (tests/repoPortsImports.test.ts).

import { hasCapability, type PlatformId } from '../../shared/platform/descriptors'
import { gitWorkspacePort } from './gitWorkspacePort'
import type { Relocation, WorkspacePort } from './workspacePort'
import { repoHolding } from './repoPorts'
import { boundaryOf } from './repoBoundary'

/**
 * Each platform's port; absent for a platform without the isolation capability (None). jj's (HI-2866) is registered by
 * the app with its own dependencies (the workspace database's journals, the store's lock, the Recycle Bin): until then,
 * and in a unit test that registers none, jj has no port here and its slots are kept (cantCheck), never acted on.
 */
const PORTS: Partial<Record<PlatformId, WorkspacePort>> = { git: gitWorkspacePort }

/** Registers a platform's port made with the app's dependencies (jj's, HI-2866). */
export function registerWorkspacePort(platform: PlatformId, port: WorkspacePort): void {
  PORTS[platform] = port
}

/** A platform's workspace lifecycle port, or null for one without isolation (None) or not registered. */
export const workspacePortOf = (platform: PlatformId): WorkspacePort | null => PORTS[platform] ?? null

/** Whether a card's line is a jj preparation's key (HI-2866): a locator, never a Git branch or a bookmark. */
export { isJjLineKey } from './jjSlotPrep'

/**
 * The relocation of the repository platform holding `folder` (HI-2792: Repair after a move), read from its folders; null
 * when none holds it or its platform has no relocation (§16.3.6's gate: relocation).
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

/**
 * Git's worktrees: the port of every caller not yet asking by its project's platform (HI-2866: with jj's registered
 * there are two with isolation, so this no longer picks the only one). The slot and copy pools take their project's
 * platform's (`workspacePortForPlatform`), and a row its own (`portOf`).
 */
export function slotWorkspaces(): WorkspacePort {
  return gitWorkspacePort
}

/**
 * Whether a slot's folder is a non-colocated jj workspace, or one whose nearer `.jj` can't be read (HI-2896): Git's
 * port must not be asked of it (git there finds no repository, or one above it), so its Git-only reads (a reorder's
 * put-back, Resume taking a free slot, a takeover's cleanliness) answer unknown for it and keep the slot, as jj's port
 * does for what it can't read without a snapshot. A colocated jj slot is a Git worktree too, read as before.
 */
export async function gitCantRead(folder: string): Promise<boolean> {
  const b = await boundaryOf(folder)
  return 'jj' in b || 'unknown' in b
}

/** The port a project's new slots and copies are made with: its platform's, when that has isolation and is registered; else Git's. */
export function workspacePortForPlatform(platform: PlatformId | null | undefined): WorkspacePort {
  const p = platform && hasCapability(platform, 'isolation') ? workspacePortOf(platform) : null
  return p ?? gitWorkspacePort
}
