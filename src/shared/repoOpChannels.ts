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
  'files:gitInclude': 'ignoreRules'
} as const satisfies Partial<Record<CombworkChannel, Operation>>

export type RepoOpChannel = keyof typeof REPO_OP_CHANNELS
