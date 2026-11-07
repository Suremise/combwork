import { agentWorkflowRole, inWorkflow } from '../shared/workflow/roles'
import { samePlace } from './fsutil'
import type { WorkspaceService } from './workspace'

/**
 * Whether a project's agent is Independent now (HI-2670: its own role, or its connection launching without Combwork's
 * tools), from the workspace's projects as it holds them: no file is read, so hooks, deliveries and lanes ask it often.
 */
export function independentIn(ws: WorkspaceService, projectPath: string, agentId: string): boolean {
  const agent = ws.info()?.projects.find((p) => samePlace(p.path, projectPath))?.config.agents?.find((a) => a.id === agentId)
  return !!agent && !inWorkflow(agentWorkflowRole(agent))
}
