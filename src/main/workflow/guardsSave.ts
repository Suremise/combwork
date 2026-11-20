import { guardProblems, guardProblemText } from '../../shared/workflow/mergeGuards'
import { CombworkError } from '../combworkError'
import { emptyMatchProblems } from './mergeGuardsRun'

/**
 * HI-3284 (design HI-3284/s16 §4, HR2's OK note): the merge guards' empty-match rule at a save, run in their worker before
 * the save takes its locks (never inside them, and never on main's thread). Only a list whose shape the save would take
 * is matched; its other problems are the save's own to say (checkOptions, under its lock). The guards checked are the
 * change's own, the value the save then writes: a level's inherited guards were checked when they were saved. A
 * refusal throws, naming each guard.
 */
export async function refuseGuardsAtSave(guards: unknown): Promise<void> {
  if (!Array.isArray(guards) || !guards.length || guardProblems(guards).length) return
  const problems = await emptyMatchProblems(guards)
  if (!problems.length) return
  // agent-text: guardProblemText
  throw new CombworkError({ lines: problems.map(guardProblemText) }, { kind: 'invalid' })
}

/** The guards a change sets (`{ options: { mergeGuards } }`), or undefined. */
export function changeGuards(raw: unknown): unknown {
  const o = (raw as { options?: Record<string, unknown> } | null)?.options
  return o && typeof o === 'object' ? o.mergeGuards : undefined
}
