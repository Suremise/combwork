import { agentProvider, providerDescriptor } from '../shared/providers'
import { agentWorkflowRole, inWorkflow } from '../shared/workflow/roles'
import { config } from './config'
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

/**
 * Whether a project's agent runs on a CLI that takes none of Combwork's tools (HI-3196: one that runs from a description),
 * from the workspace's projects as held: a task for it is its launch's prompt, typed as it is, never an inbox delivery.
 */
export function noToolsIn(ws: WorkspaceService, projectPath: string, agentId: string): boolean {
  const agent = ws.info()?.projects.find((p) => samePlace(p.path, projectPath))?.config.agents?.find((a) => a.id === agentId)
  return !!agent && providerDescriptor(agentProvider(agent, config.settings)).capabilities.session?.combworkTools === false
}
