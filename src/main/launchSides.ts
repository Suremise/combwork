/**
 * A launch's side of the workflow for its metrics (HI-2049, shared/workflow/roles.ts launchWorkflow): its parts in its
 * project's running lanes, which the session manager can't read itself (lanes.ts reads the board). Here, as
 * handOverCheck.ts is.
 */
import { basename } from 'path'
import { laneParts } from './lanes'
import { sessions } from './sessions'
import { workspaceOf } from './workspace'

let started = false

/** Gives the session manager the lanes' parts. Once, at startup, before any window can start an agent. */
export function startLaunchSides(): void {
  if (started) return
  started = true
  sessions.laneParts = async (projectPath, agentId) => {
    const ws = workspaceOf(projectPath)
    return ws.isAssistantHome(projectPath) ? [] : laneParts(ws, basename(projectPath), agentId)
  }
}
