// HI-3218: Git's revision reads (revisionReads.ts): a submission's file between two commits, as Compare reads one
// (gitCompare.ts commitDiff), in the project's repository, whose store a slot's or worktree's commits are in.

import { commitDiff } from '../gitCompare'
import type { RevisionReads } from './revisionReads'

export const gitRevisionReads: RevisionReads = {
  fileDiff: (projectPath, from, to, file) => commitDiff(projectPath, from, to, file)
}
