// HI-3218: what the card dialog reads of a card's revisions: one file of a submission, from its base to its revision. A
// plain contract, as repoReads.ts is: no platform's code is imported here, and revisionReadsPorts.ts finds a platform's by
// its id, never switching on one. Commits only, never a working copy: what is shown is what was submitted. Reads have
// no side effects on the repository.

import type { GitDiff } from '../../shared/types'

/** A card's revisions as the card dialog reads them. */
export interface RevisionReads {
  /**
   * One file at commit `from` against commit `to`, in the project at `projectPath`. A side the file isn't on is empty
   * (added or deleted); a side over the diff limit is said, never read; a binary side is said as binary.
   */
  fileDiff(projectPath: string, from: string, to: string, file: string): Promise<GitDiff>
}
