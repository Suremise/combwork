// The window's repository mutations by channel (SPEC §16.3.6 port 5, HI-2788's R3): which operation each channel is. One
// map for both sides: the window offers a channel's action only when its platform lists the operation (renderer
// repoOps.ts), and main refuses it otherwise before anything runs (main repoOpsIpc.ts).

import type { CombworkChannel } from './api'
import type { Operation } from './platform/descriptors'

export const REPO_OP_CHANNELS = {
  'git:switch': 'switchLine',
  'git:createBranch': 'createLine',
  'git:deleteBranches': 'deleteLines',
  'git:deleteRemoteBranches': 'deleteRemoteLines',
  'git:updateBranch': 'updateLine',
  'worktrees:mergeBranch': 'mergeLine',
  // The older Merge dialog's: an agent's 0.9 worktree, and an unused worktree (HR3's HI-2788 round 1).
  'agents:merge': 'mergeLine',
  'worktrees:mergeUnused': 'mergeLine',
  'git:addRemote': 'addRemote',
  'git:renameRemote': 'renameRemote',
  'git:setRemoteUrl': 'setRemoteUrl',
  'git:removeRemote': 'removeRemote',
  'git:fetch': 'fetch',
  'git:pull': 'pull',
  'git:push': 'push',
  'git:pushTo': 'pushTo',
  'git:setUpstream': 'setUpstream',
  'git:createTag': 'createTag',
  'git:setIdentity': 'setIdentity',
  'git:initCheck': 'init',
  'git:init': 'init',
  'files:gitExclude': 'ignoreRules',
  'files:gitUntrack': 'ignoreRules',
  'files:gitInclude': 'ignoreRules',
  'files:gitCommitIgnore': 'folderChanges',
  'queue:settleChanges': 'folderChanges',
  // HI-3470: Changes' panel for an operation left under way.
  'git:operationStep': 'operationSteps',
  // HI-3473: Branches & remotes' Repository health (its reads too: offered only where the platform has it).
  'git:health': 'repoHealth',
  'git:pruneWorktrees': 'repoHealth',
  'git:removeLocks': 'repoHealth',
  'git:remotePrunePreview': 'repoHealth',
  'git:fetchPrune': 'repoHealth',
  // HI-3472: Changes' Stashes (its reads too: offered only where the platform has it).
  'git:stashes': 'stashes',
  'git:stashFiles': 'stashes',
  'git:stashDiff': 'stashes',
  'git:applyStash': 'stashes',
  'git:dropStash': 'stashes',
  // HI-3469: History's Moves (its reads too: offered only where the platform has it).
  'git:moves': 'branchMoves',
  'git:restorePlan': 'branchMoves',
  'git:restore': 'branchMoves',
  // HI-3474: Branches & remotes' Rename…, History's tag Delete and Push….
  'git:renameBranch': 'renameLine',
  'git:deleteTag': 'deleteTag',
  'git:pushTag': 'pushTag',
  // HI-3477: the Files tab's Discard Changes… and Restore From… (its reads too: offered only where the platform has it).
  'files:gitRestorePlan': 'restoreFile',
  'files:gitFileCommits': 'restoreFile',
  'files:gitRestore': 'restoreFile',
  // HI-3471: History's Commit dialog (its reads too: offered only where the platform has it).
  'git:commitDetail': 'commitActions',
  'git:commitFileDiff': 'commitActions',
  'git:commitAction': 'commitActions'
} as const satisfies Partial<Record<CombworkChannel, Operation>>

export type RepoOpChannel = keyof typeof REPO_OP_CHANNELS
