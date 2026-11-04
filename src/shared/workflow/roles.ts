// Agents' workflow roles (#1430, SPEC §16.10.6): which side of the workflow an agent takes, builder, reviewer or either,
// or none: a generalist (HI-686) does what it's asked in its pane. Lanes, the slot pool's size, the reviewer pool and
// no-self-review read it here. It isn't #686's guidance role, nor the
// agent's free-text note (`AgentDef.role`): two fields, kept apart. An agent saved before 1.0 has none, and reads as the
// guess its name or note gives, stored the first time the user saves its settings (nothing is written at the upgrade).

import { msg, type Msg } from '../i18n/msg'

/** Which side of the workflow an agent takes: it builds cards, reviews them, either, or none (a generalist, HI-686). */
export type WorkflowRole = 'builder' | 'reviewer' | 'either' | 'generalist'

/** G17 (#1443): one reviewer per lane, or a pool of reviewers lanes share. The option's key is `reviewerMode`. */
export type ReviewerMode = 'lane' | 'pool'

export const WORKFLOW_ROLES: readonly WorkflowRole[] = ['builder', 'reviewer', 'either', 'generalist']

export const isWorkflowRole = (v: unknown): v is WorkflowRole => typeof v === 'string' && (WORKFLOW_ROLES as readonly string[]).includes(v)

/** A reviewer's name as the shipped patterns and Darren's agents give it: HR1 (up to three letters), HI-R2 and ABCD-R1
 * (`{key}-R{n}`, a project key's 2–4 letters: `KEY_FORM`, #704). */
const REVIEWER_NAME = /^(?:[a-z]{0,3}|[a-z]{2,4}-)r\d+$/i

/**
 * An agent's workflow role: its own, else the guess from before 1.0. A note that says *review* (or, with no note, a name
 * that does, or one shaped like HR1 or HI-R2) reads as a reviewer; anything else as a builder.
 */
export function agentWorkflowRole(a: { name: string; role?: string; workflowRole?: WorkflowRole }): WorkflowRole {
  if (isWorkflowRole(a.workflowRole)) return a.workflowRole
  const note = a.role?.trim()
  if (note) return /review/i.test(note) ? 'reviewer' : 'builder'
  return /review/i.test(a.name) || REVIEWER_NAME.test(a.name.trim()) ? 'reviewer' : 'builder'
}

/**
 * The side of the workflow a launch's metrics count it on (HI-2049): none for a generalist and the Assistant. Series
 * recorded before it was counted read as `unknown`, never as one of these.
 */
export type LaunchWorkflow = 'builder' | 'reviewer' | 'either' | 'none'

/**
 * A launch's side: its part in the running lanes it is in at launch (builder in one and reviewer in another: either),
 * which wins over its own role, else its own role (`null`: the Assistant).
 */
export function launchWorkflow(role: WorkflowRole | null, laneParts: readonly ('builder' | 'reviewer')[]): LaunchWorkflow {
  const parts = new Set(laneParts)
  if (parts.size > 1) return 'either'
  if (parts.size === 1) return [...parts][0]
  return role === 'builder' || role === 'reviewer' || role === 'either' ? role : 'none'
}

/**
 * A project's builder and reviewer pairs (#1531, #1346 item 2: an Assistant named another project's reviewer, the agents
 * having no roles it could see): each running lane's builder with its reviewer (or the pool), then, by name, a builder
 * and a reviewer in no running lane whose names end in the same number (HB2 and HR2, HI-B1 and HI-R1), only where that
 * number gives exactly one reviewer. A guess by name says so (`byName`).
 */
export interface WorkflowPair {
  builder: string
  /** Null with the pool. */
  reviewer: string | null
  pool?: true
  lane?: string
  /**
   * A running lane's state, as its line in `cw_lane list` says it (HI-2271): "active, on AL-1", "paused, AL-2 is
   * blocked". An Assistant reading project status took the lane's card from the board's Doing column.
   */
  state?: string
  byName?: true
}

type PairLane = { id: string; state: string; builder: { name: string }; reviewer: { name: string } | null; pool?: boolean }

/** `stateOf`: a running lane's state in words (laneStateText), carried by its pair. */
export function workflowPairs<L extends PairLane>(agents: readonly { name: string; role?: string; workflowRole?: WorkflowRole }[], lanes: readonly L[], stateOf?: (l: L) => string): WorkflowPair[] {
  const out: WorkflowPair[] = lanes.filter((l) => l.state === 'active' || l.state === 'paused').map((l) => ({ builder: l.builder.name, reviewer: l.reviewer?.name ?? null, ...(l.pool ? { pool: true as const } : {}), lane: l.id, ...(stateOf ? { state: stateOf(l) } : {}) }))
  const taken = new Set(out.flatMap((p) => [p.builder, p.reviewer]).filter((n): n is string => !!n).map((n) => n.toLowerCase()))
  const free = agents.filter((a) => !taken.has(a.name.toLowerCase()))
  const number = (name: string): string | undefined => /(\d+)$/.exec(name.trim())?.[1]
  for (const b of free.filter((a) => agentWorkflowRole(a) === 'builder' && number(a.name))) {
    const reviewers = free.filter((r) => agentWorkflowRole(r) === 'reviewer' && number(r.name) === number(b.name))
    if (reviewers.length === 1) out.push({ builder: b.name, reviewer: reviewers[0].name, byName: true })
  }
  return out
}

/**
 * Whether an agent of this role is a builder of the workflow (an either-role agent does both): a lane's builder, and
 * counted in the project's slots. A generalist isn't (HI-686).
 */
export const buildsWork = (role: WorkflowRole): boolean => role === 'builder' || role === 'either'

/**
 * Whether an agent of this role reviews cards (an either-role agent does both): a lane's reviewer, the reviewer pool,
 * the review copies' count. A generalist doesn't (HI-686).
 */
export const reviewsWork = (role: WorkflowRole): boolean => role === 'reviewer' || role === 'either'

/**
 * Whether an agent of this role may work on a card it takes (HI-686): any but a reviewer. A generalist taking a card is
 * built where the project's Workflow options say, as any agent's card is: the role adds no rule of its own.
 */
export const takesCards = (role: WorkflowRole): boolean => role !== 'reviewer'

/** The window's words for the roles: "Role in the workflow", and each role's name and sentence. */
export const ROLE_IN_WORKFLOW = msg({ id: 'agents.workflowRole.label', defaultMessage: 'Role in the workflow', description: 'A heading in Add Agent and Agent Settings, above the choice of builder, reviewer or either: which side of the workflow the agent takes (#1430). Glossary: workflow role.' })
export const WORKFLOW_ROLE_TEXT: Record<WorkflowRole, { name: Msg; text: Msg }> = {
  builder: {
    name: msg({ id: 'agents.workflowRole.builder', defaultMessage: 'Builder', description: "A choice of an agent's role in the workflow: it builds cards. Glossary: builder." }),
    text: msg({ id: 'agents.workflowRole.builderText', defaultMessage: 'Works on cards and sends them to Review.', description: "Under the Builder choice of an agent's role in the workflow. Review is a board column." })
  },
  reviewer: {
    name: msg({ id: 'agents.workflowRole.reviewer', defaultMessage: 'Reviewer', description: "A choice of an agent's role in the workflow: it reviews cards. Glossary: reviewer." }),
    text: msg({ id: 'agents.workflowRole.reviewerText', defaultMessage: 'Reviews the builders’ cards and passes or fails them.', description: "Under the Reviewer choice of an agent's role in the workflow. Glossary: pass / fail (a verdict)." })
  },
  either: {
    name: msg({ id: 'agents.workflowRole.either', defaultMessage: 'Either', description: "A choice of an agent's role in the workflow: it builds or reviews. Glossary: either." }),
    text: msg({ id: 'agents.workflowRole.eitherText', defaultMessage: 'Builds or reviews, but never reviews its own work.', description: "Under the Either choice of an agent's role in the workflow." })
  },
  generalist: {
    name: msg({ id: 'agents.workflowRole.generalist', defaultMessage: 'Generalist', description: "A choice of an agent's role in the workflow (HI-686): it takes no side; it does whatever the user asks in its pane, and is never a lane's builder or reviewer. Glossary: generalist." }),
    text: msg({ id: 'agents.workflowRole.generalistText', defaultMessage: 'Does whatever you ask in its pane; takes no side in the workflow.', description: "Under the Generalist choice of an agent's role in the workflow: it isn't a builder or a reviewer of lanes; it works for the user in its own pane." })
  }
}
