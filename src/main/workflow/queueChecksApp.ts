// The merge queue's checks in the app (#1349): queueChecks.ts wired to the Progress panel (each check a run of
// "Combwork (merge queue)" in the project), to a session command's environment, to Settings → Advanced's time limit and
// to the project's worktree setup command. #1348's queue host passes the result into its QueueConfig, with #1360's
// recording spawn.

import { app } from 'electron'
import { join } from 'path'
import { advanced } from '../advanced'
import { createLogger } from '../logger'
import { progress, progressGate } from '../progressService'
import { childEnv } from '../ptyHost'
import type { WorkspaceService } from '../workspace'
import { QUEUE_CHECK_MINUTES, QUEUE_NETWORK_CODES } from '../../shared/advanced'
import { progressRuns, queueChecks, type Spawn } from './queueChecks'
import { slotWorkspaces } from '../platform/workspacePorts'

const log = createLogger('queue')

/** Where the queue's runs keep their logs: Combwork's own folder, never a project's. */
export const queueLogDir = (): string => join(app.getPath('userData'), 'logs', 'merge-queue')

/**
 * The runner for a project's queue (`QueueConfig.runCheck` and `install`). `onRun`: told each run's id as it starts (null
 * when runs aren't kept), for the queue's model (#1353).
 */
export function appQueueChecks(ws: WorkspaceService, projectPath: string, spawn?: Spawn, onRun?: (id: string | null) => void): ReturnType<typeof queueChecks> {
  const runs = ws.path ? progressRuns(progress, () => progressGate.on(), ws.path, projectPath, (e) => log.warn('merge queue run not shown', e)) : undefined
  return queueChecks({
    ...(spawn ? { spawn } : {}),
    env: () => childEnv(),
    runs: runs && onRun ? { ...runs, start: (r) => { const id = runs.start(r); onRun(id); return id } } : runs,
    logDir: queueLogDir(),
    timeoutMs: () => Math.max(1, Number(advanced.get(QUEUE_CHECK_MINUTES)) || 90) * 60_000,
    networkCodes: () => advanced.pattern(QUEUE_NETWORK_CODES),
    setupCommand: async () => (await ws.projectConfig(projectPath).catch(() => null))?.worktreeSetup ?? '',
    // HI-1182: Version Control → Slots and copies' Set up submodules and LFS, as it is now (unreadable: as its default, on).
    gitFilesOn: async () => (await ws.projectConfig(projectPath).catch(() => null))?.slots?.gitFiles !== false,
    project: projectPath,
    // The queue's folder is a worktree made as slots are: their platform's step.
    files: slotWorkspaces().files
  })
}
