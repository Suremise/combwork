// The repository operations port's Git implementation (SPEC §16.3.6 port 5, HI-2788's R3): today's code, called through
// the port. Each member delegates to the function its callers called before (gitRepo.ts, gitInit.ts, branchMerge.ts,
// worktrees.ts, filesGit.ts), through the module at call time, so a test's mock or spy of it still applies: the same
// guards, git commands, answers and refusals (tests/repoOpTraces.test.ts). Nothing here runs git itself.

import * as repo from '../../gitRepo'
import * as init from '../../gitInit'
import * as merge from '../../branchMerge'
import * as wt from '../../worktrees'
import * as files from '../../filesGit'
import * as changes from './gitFolderChanges'
import * as operations from './gitOperationSteps'
import * as health from './gitHealth'
import * as stashes from './gitStashes'
import * as moves from './gitMoves'
import * as restore from './gitFileRestore'
import * as commits from './gitCommitActions'
import type { RepoOps } from '../repoOps'

export const gitRepoOps: RepoOps = {
  switchLine: (p, line) => repo.switchBranch(p, line),
  createLine: (p, name, stay, from) => repo.createBranch(p, name, stay, from),
  deleteLines: (p, items, unmerged) => repo.deleteBranches(p, items, unmerged),
  deleteRemoteLines: (p, remote, items) => repo.deleteRemoteBranches(p, remote, items),
  updateLine: (p, line, how) => repo.updateBranch(p, line, how),
  mergeLine: (p, line, opts) => merge.mergeBranch(p, line, opts),
  mergeWorkspace: (p, ws, opts) => wt.mergeWorktree(p, ws, opts),
  makeLine: (p, name, from, guard) => repo.makeBranchAt(p, name, from, guard),
  removeMadeLine: (p, name, commit, inUse, guard) => repo.removeMadeBranch(p, name, commit, inUse, guard),
  addRemote: (p, name, url) => repo.addRemote(p, name, url),
  renameRemote: (p, from, to) => repo.renameRemote(p, from, to),
  setRemoteUrl: (p, name, url) => repo.setRemoteUrl(p, name, url),
  removeRemote: (p, name, expected) => repo.removeRemote(p, name, expected),
  fetchRemotes: (p) => repo.fetchAll(p),
  pull: (p) => repo.pull(p),
  push: (p, remote) => repo.push(p, remote),
  pushTo: (p, remote, scope, line) => repo.pushToRemote(p, remote, scope, line),
  setUpstream: (p, line, remote, remoteLine, pushFirst) => repo.setUpstream(p, line, remote, remoteLine, pushFirst),
  createTag: (p, name, message, to, at) => repo.createTag(p, name, message, to, at),
  renameLine: (p, line, to, onRemote) => repo.renameBranch(p, line, to, onRemote),
  deleteTag: (p, tag, remote) => repo.deleteTag(p, tag, remote),
  pushTag: (p, name, remote) => repo.pushTag(p, name, remote),
  setIdentity: (p, name, email) => repo.setIdentity(p, name, email),
  initCheck: (p) => init.initCheck(p),
  init: (p, opts) => init.initRepo(p, opts),
  exclude: (p, items, target, ext) => files.gitExclude(p, items, target, ext),
  untrack: (p, items) => files.gitUntrack(p, items),
  include: (p, items) => files.gitInclude(p, items),
  settleChanges: (p, target, seen, action, shown, label, guard) => changes.settleChanges(p, target, seen, action, shown, label, guard),
  commitIgnore: (p) => changes.commitIgnore(p),
  operationStep: (p, folder, req, guard) => operations.operationStep(p, folder, req, guard),
  health: (p) => health.repoHealth(p),
  pruneWorktrees: (p, entries) => health.pruneWorktrees(p, entries),
  removeLocks: (p, locks) => health.removeLocks(p, locks),
  remotePrunePreview: (p) => health.remotePrunePreview(p),
  fetchPrune: (p, remotes) => health.fetchPrune(p, remotes),
  stashes: (root) => stashes.listStashes(root),
  stashFiles: (root, commit) => stashes.stashFiles(root, commit),
  stashDiff: (root, commit, file, untracked) => stashes.stashDiff(root, commit, file, untracked),
  applyStash: (p, folder, req, guard) => stashes.applyStash(p, folder, req, guard),
  dropStash: (p, ref) => stashes.dropStash(p, ref),
  moves: (p, branch, page) => moves.listMoves(p, branch, page),
  restorePlan: (p, req) => moves.restorePlan(p, req),
  restore: (p, req) => moves.restoreBranch(p, req),
  fileRestorePlan: (p, rel, source, target, commit) => restore.restorePlan(p, rel, source, target, commit),
  fileCommits: (p, rel, page) => restore.fileCommits(p, rel, page),
  restoreFile: (p, req, guard) => restore.restoreFile(p, req, guard),
  commitDetail: (p, commit) => commits.commitDetail(p, commit),
  commitFileDiff: (p, commit, file) => commits.commitFileDiff(p, commit, file),
  commitAction: (p, req) => commits.commitAction(p, req)
}
