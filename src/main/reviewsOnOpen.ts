import { join } from 'path'
import { onBoardUpgraded } from './boardStore'
import { createLogger } from './logger'
import { sessions } from './sessions'
import { endReviewsWithoutSession } from './tasks'
import { WorkspaceService } from './workspace'

const log = createLogger('tasks')

/**
 * As a workspace opens (#1392): the reviews of reviewers with no session running end. A reviewer's session that ended as
 * a window closed the workspace couldn't end them then (its board is fenced from the close on, #1379), so the card kept
 * a reviewer that had gone. A reviewer is running if its project in this workspace has its session now.
 */
let started = false
export function initReviewsOnOpen(): void {
  if (started) return
  started = true
  const repair = (ws: WorkspaceService): void => {
    const path = ws.path
    const life = ws.lifetime
    if (!path) return
    const run = (async () => {
      await beforeRepair?.()
      // Closed or switched while it waited: that workspace's next opening repairs it.
      if (life.aborted) return
      await endReviewsWithoutSession(ws, (project, agentId) => !!sessions.liveFor(join(path, project), agentId))
    })()
      .catch((e) => log.warn('ending the reviews of sessions that ended', e))
      .finally(() => running.delete(run))
    running.add(run)
  }
  WorkspaceService.openedListeners.add(repair)
  // Opened while its board waited for the upgrade to 1.0 (it takes no writes until then): repaired once it is upgraded (#1621).
  onBoardUpgraded(repair)
}

const running = new Set<Promise<unknown>>()
let beforeRepair: (() => Promise<void> | void) | null = null
/** For tests: awaited before a repair starts (the moment a test closes or switches the workspace in). */
export const setBeforeRepairForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforeRepair = fn
}
/** For tests: every repair under way has finished. */
export async function repairsForTests(): Promise<void> {
  while (running.size) await Promise.allSettled([...running])
}
