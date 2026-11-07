// One agent of an all-agents action (HI-2665): beside each action that acts on several of a project's agents at once
// (Resume (n), Stop (n), Start New (n), Archive and Start New (n)), a menu of the agents it would act on, to act on one.
// Pure: which agents each lists and how each would be acted on, so it is tested; the window builds the menus from it.
import type { ResumeHold } from './agentFolders'
import { agentsToResume, stalledOnSignIn, type ResumeAllAgent } from './resumeAll'
import { archiveTarget, type BatchAgent } from './startAll'

export type OneAgentKind = 'resume' | 'stop' | 'startNew' | 'archive'

/**
 * A row of the menu: its agent and what choosing it does. `carryOn`: running, stopped by a refused sign-in (Resume tells
 * it to carry on). `held`: stopped, its conversation can't resume where it ran now (#1434): listed, never chosen.
 */
export interface OneAgentRow<A> {
  agent: A
  how: 'resume' | 'carryOn' | 'held' | 'stop' | 'start' | 'archive'
  hold?: ResumeHold
}

export type OneAgent = ResumeAllAgent & Pick<BatchAgent, 'live' | 'resume'> & { resume: { id: string; hold?: ResumeHold } | null }

/**
 * The agents an all-agents action would act on, in the project's order, each with how: Resume's are those Resume All
 * resumes (`agentsToResume`), then the held ones it leaves, after them; Stop's the running ones; Start New's every agent;
 * Archive and Start New's those with a session to archive (`archiveTarget`).
 */
export function oneAgentRows<A extends OneAgent>(kind: OneAgentKind, agents: readonly A[]): OneAgentRow<A>[] {
  switch (kind) {
    case 'resume':
      return [
        ...agentsToResume(agents).map((agent): OneAgentRow<A> => ({ agent, how: stalledOnSignIn(agent.live) ? 'carryOn' : 'resume' })),
        ...agents.filter((a) => !a.live && a.resume?.hold).map((agent): OneAgentRow<A> => ({ agent, how: 'held', hold: agent.resume!.hold }))
      ]
    case 'stop':
      return agents.filter((a) => a.live).map((agent) => ({ agent, how: 'stop' }))
    case 'startNew':
      return agents.map((agent) => ({ agent, how: 'start' }))
    case 'archive':
      return agents.filter((a) => archiveTarget(a)).map((agent) => ({ agent, how: 'archive' }))
  }
}

/** Whether to offer the menu: two rows or more (with one, the all-agents action already acts on just that agent). */
export const offersOneAgent = (rows: readonly unknown[]): boolean => rows.length >= 2

/**
 * What choosing an agent for Resume does now, read again when it is chosen (the agent may have changed or gone since the
 * menu opened): carry it on while a refused sign-in still holds it, resume it while it is still one Resume All would,
 * else nothing ('gone': no longer in the project; 'notNow': no longer resumable). Never another agent.
 */
export function resumeOneNow<A extends OneAgent>(agent: A | null | undefined): 'carryOn' | 'resume' | 'gone' | 'notNow' {
  if (!agent) return 'gone'
  if (!agentsToResume([agent]).length) return 'notNow'
  return stalledOnSignIn(agent.live) ? 'carryOn' : 'resume'
}
