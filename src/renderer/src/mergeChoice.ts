// The hand-merge dialogs' first choice (HI-1765): the project's own merge style (Version Control → Workflow, G6), no longer
// a setting of Combwork's. Squash for squash; a merge commit for merge and for rebase (neither dialog offers a rebase), and
// for a project with no workflow, or one whose workflow can't be read.
import type { MergeStyle } from '@shared/types'
import { call } from './api'

/** The dialogs' choice for a project's G6 style. */
export const mergeChoiceOf = (style: unknown): MergeStyle => (style === 'squash' ? 'squash' : 'merge')

/** The project's own merge style as the dialogs offer it: read from its workflow as it resolves now. */
export async function projectMergeChoice(projectPath: string): Promise<MergeStyle> {
  try {
    return mergeChoiceOf((await call('workflow:form', projectPath)).options?.style)
  } catch {
    return 'merge'
  }
}
