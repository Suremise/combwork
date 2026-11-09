// The repository reads port's Git implementation (SPEC §16.3.6 port 5, HI-2785's R2): today's code, called through the
// port. Each member delegates to the function its callers called before (gitRepo.ts, gitCompare.ts, branchWatch.ts,
// branchMerge.ts), through the module at call time, so a test's mock or spy of it still applies: the same git commands
// in the same order, the same answers, caches and errors (tests/repoReadTraces.test.ts). Nothing here runs git itself.

import * as repo from '../gitRepo'
import * as compare from '../gitCompare'
import * as watch from '../branchWatch'
import * as merge from '../branchMerge'
import type { RepoReads } from './repoReads'

export const gitRepoReads: RepoReads = {
  summary: (root) => repo.repoSummary(root),
  workTarget: (projectPath) => repo.workTargetOf(projectPath),
  info: (root, workTarget) => repo.repoInfo(root, workTarget),
  leftovers: (root, workTarget) => repo.leftoverInfo(root, workTarget),
  history: (root, o) => repo.repoHistory(root, o),
  compareLines: (root, workTarget, slots) => compare.compareLines(root, workTarget, slots),
  compare: (root, base, head, page, pinned) => compare.compareBranches(root, base, head, page, pinned),
  compareDiff: (root, base, head, file, pinned) => compare.compareDiff(root, base, head, file, pinned),
  lineDrops: (projectPath, line) => repo.branchDrops(projectPath, line),
  updatePlan: (projectPath, line) => repo.branchUpdatePlan(projectPath, line),
  remoteTracking: (projectPath, remote) => repo.remoteTracking(projectPath, remote),
  startPoints: (projectPath) => repo.startPoints(projectPath),
  resolveStart: (projectPath, ref) => repo.resolveStart(projectPath, ref),
  checkLineName: (projectPath, name) => repo.checkBranchName(projectPath, name),
  missingLines: (projectPath, names) => repo.missingBranches(projectPath, names),
  lineStatus: (found) => watch.lineStatus(found),
  mergeLines: (projectPath) => merge.mergeBranches(projectPath),
  lineMergeStatus: (projectPath, line, target) => merge.branchMergeStatus(projectPath, line, target)
}
