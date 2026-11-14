// HI-3218: one file of a card's submission, from its base to its revision, for the card dialog's revision rows. Main finds
// the commits in the card's facts (the window never passes a commit), and reads them through the card's project's
// platform (revisionReadsPorts.ts). Only a file the submission lists is read.

import { join } from 'path'
import { cardHeads } from '../boardStore'
import { combworkError } from '../combworkError'
import { platformIdOf } from '../platform/registry'
import { revisionReadsOf } from '../platform/revisionReadsPorts'
import type { WorkspaceService } from '../workspace'
import { msg } from '../../shared/i18n'
import type { GitDiff } from '../../shared/types'
import type { Fact } from '../../shared/workflow/facts'
import { cardFacts } from './recorder'

const M = {
  noSubmission: msg({ id: 'board.work.changes.noSubmission', defaultMessage: 'This card has no such submission.', description: "A card's revision diff couldn't be shown: the submission it names isn't one of the card's (the card changed meanwhile)." }),
  noRevision: msg({ id: 'board.work.changes.noRevision', defaultMessage: "This submission has no revision to compare: its commits weren't recorded.", description: "A card's revision diff couldn't be shown: the submission recorded no base or revision commit (a no-code card, or one from before revisions were recorded)." }),
  notListed: msg({ id: 'board.work.changes.notListed', defaultMessage: "{path} isn't one of this submission's files.", description: "A card's revision diff couldn't be shown: the file isn't among the files the submission changed." }),
  noRepository: msg({ id: 'board.work.changes.noRepository', defaultMessage: "This project has no repository to read the revision from.", description: "A card's revision diff couldn't be shown: the card's project has no version control (None)." })
}

/** Card `n`'s project's folder (the workspace's for a card about the workspace). */
export function projectPathOf(ws: WorkspaceService, n: number): string {
  const project = cardHeads(ws, [n])[0]?.project
  return typeof project === 'string' && project ? join(ws.path!, project) : ws.path!
}

/** One file of submission `submission` (its fact's number) of card `n`, from the submission's base to its revision. */
export async function revisionDiff(ws: WorkspaceService, n: number, submission: number, file: string): Promise<GitDiff> {
  const f = cardFacts(ws, n).find((x): x is Fact<'Submitted'> => x.kind === 'Submitted' && x.seq === submission)
  if (!f) throw combworkError(M.noSubmission)
  const { base, revision, files } = f.data
  if (!base || !revision) throw combworkError(M.noRevision)
  const path = String(file ?? '')
  if (!files.some((c) => c.path === path)) throw combworkError(M.notListed, { path })
  const projectPath = projectPathOf(ws, n)
  const cfg = await ws.projectConfig(projectPath).catch(() => null)
  const reads = revisionReadsOf(platformIdOf(projectPath, cfg?.platform))
  if (!reads) throw combworkError(M.noRepository)
  return reads.fileDiff(projectPath, base, revision, path)
}
