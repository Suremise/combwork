// The merge queue's checks in the app (#1349): queueChecks.ts wired to the Progress panel (each check a run of
// "Hive (merge queue)" in the project), to a session command's environment, to Settings → Advanced's time limit and
// to the project's worktree setup command. #1348's queue host passes the result into its QueueConfig, with #1360's
// recording spawn.

import { app } from 'electron'
import { join } from 'path'
import { advanced } from '../advanced'
import { createLogger } from '../logger'
import { progress, progressGate } from '../progressService'
import { childEnv } from '../ptyHost'
import type { WorkspaceService } from '../workspace'
import { QUEUE_CHECK_MINUTES } from '../../shared/advanced'
import { queueChecks, type QueueRuns, type Spawn } from './queueChecks'

const log = createLogger('queue')

/** Where the queue's runs keep their logs: Hive's own folder, never a project's. */
export const queueLogDir = (): string => join(app.getPath('userData'), 'logs', 'merge-queue')

/** The project's queue runs in the Progress panel; none while the panel is off (its runs aren't kept then). */
function appRuns(workspacePath: string, projectPath: string): QueueRuns {
  const caller = (noInstall?: boolean) => ({ source: 'hive' as const, workspacePath, projectPath, ...(noInstall ? { noInstall } : {}) })
  return {
    start: (r) => {
      if (!progressGate.on()) return null
      try {
        return progress.start(caller(r.noInstall), { title: r.title, command: r.command }, { card: r.card, revision: r.revision, testedCheckout: r.revision, folder: r.folder }).id
      } catch (e) {
        // A full workspace (its open-run limit): the check still runs, without a row.
        log.warn('merge queue run not shown', e)
        return null
      }
    },
    finish: (id, end) => {
      try {
        progress.finish(caller(), id, { ok: end.ok, ...(end.exitCode !== null ? { exitCode: end.exitCode } : {}), ...(end.logPath ? { logPath: end.logPath } : {}) })
      } catch {
        // forgotten meanwhile (the panel turned off, the workspace closed)
      }
    },
    counts: (id, c) => progress.noteCheck(workspacePath, id, c)
  }
}

/** The runner for a project's queue (`QueueConfig.runCheck` and `install`). */
export function appQueueChecks(ws: WorkspaceService, projectPath: string, spawn?: Spawn): ReturnType<typeof queueChecks> {
  return queueChecks({
    ...(spawn ? { spawn } : {}),
    env: () => childEnv(),
    runs: ws.path ? appRuns(ws.path, projectPath) : undefined,
    logDir: queueLogDir(),
    timeoutMs: () => Math.max(1, Number(advanced.get(QUEUE_CHECK_MINUTES)) || 90) * 60_000,
    setupCommand: async () => (await ws.projectConfig(projectPath).catch(() => null))?.worktreeSetup ?? ''
  })
}
