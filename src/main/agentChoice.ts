import type { AgentDef } from '../shared/types'

/**
 * An agent's own choice of connection (HI-2195): each save of it that isn't a usage move's (Agent Settings, the Agent API,
 * a template, an undo: projectAgents.updateAgent) counts, the same connection chosen again too. A usage move waiting for
 * the agent's safe point takes the count when queued and is dropped once it changed (HR1: a later manual choice always
 * wins), and usageMoves.ts keeps the agent where the user put it for the rest of that period. In memory only: a waiting
 * move doesn't outlive Combwork either.
 */

const counts = new Map<string, number>()
const listeners: ((projectPath: string, before: AgentDef) => void)[] = []
const key = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}\n${agentId}`

/** How many manual choices of connection the agent has had since Combwork started. */
export const choiceCount = (projectPath: string, agentId: string): number => counts.get(key(projectPath, agentId)) ?? 0

/** A manual choice of connection, saved under the project's lock (`before`: the agent as saved before it). */
export function noteManualChoice(projectPath: string, before: AgentDef): void {
  const k = key(projectPath, before.id)
  counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const fn of listeners) fn(projectPath, before)
}

/** Follows manual choices (usageMoves.ts). */
export function onManualChoice(fn: (projectPath: string, before: AgentDef) => void): void {
  listeners.push(fn)
}
