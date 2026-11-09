// The window's repository mutations, at their IPC boundary (SPEC §16.3.6 port 5, HI-2788's R3): their handlers, each
// taking the port through `opsAt(channel)`, which refuses the channel's operation (REPO_OP_CHANNELS in
// shared/repoOpChannels.ts, the one map, which the window's offer reads too) when the platform doesn't list it, before
// anything runs. ipc.ts registers these as they are (and
// `worktrees:mergeBranch`, which needs its merge authorization, through `opsAt` too); tests/repoOpsBoundary.test.ts calls
// them directly with an operation made unavailable.
//
// Which platform: the one with repository operations (`lineRepoOps`), whatever the project's recorded workflow platform,
// as the window acted before (a None project's folder inside a Git repository keeps its Files actions; Initialise
// repository is on Git's page, HI-1905). R9 routes by the project's platform.

import type { CombworkChannel, CombworkRequests } from '../shared/api'
import { REPO_OP_CHANNELS, type RepoOpChannel } from '../shared/repoOpChannels'
import { branchStartArg } from '../shared/nextVersion'
import { lineRepoOps } from './platform/repoOpsPorts'
import type { OpsFor } from './platform/repoOps'

/** The port for a channel's operation, refused (in the window's words) when its platform doesn't list it. */
export const opsAt = <C extends RepoOpChannel>(channel: C): OpsFor<(typeof REPO_OP_CHANNELS)[C]> => lineRepoOps(REPO_OP_CHANNELS[channel])

type Handler<C extends CombworkChannel> = (...args: Parameters<CombworkRequests[C]>) => ReturnType<CombworkRequests[C]> | Promise<ReturnType<CombworkRequests[C]>>

/** The handlers, as ipc.ts had them: the same argument checks, then the port (`worktrees:mergeBranch` stays ipc.ts'). */
export const repoOpHandlers: { [C in Exclude<RepoOpChannel, 'worktrees:mergeBranch'>]: Handler<C> } = {
  'git:switch': (p, branch) => opsAt('git:switch').switchLine(p, String(branch ?? '')),
  'git:createBranch': (p, name, stay, from) => opsAt('git:createBranch').createLine(p, String(name ?? ''), !!stay, branchStartArg(from)),
  'git:deleteBranches': (p, items, unmerged) => opsAt('git:deleteBranches').deleteLines(p, Array.isArray(items) ? items : [], !!unmerged),
  'git:deleteRemoteBranches': (p, remote, items) => opsAt('git:deleteRemoteBranches').deleteRemoteLines(p, String(remote ?? ''), Array.isArray(items) ? items : []),
  // Update from <target> (HI-1180).
  'git:updateBranch': (p, branch, how) => opsAt('git:updateBranch').updateLine(p, String(branch ?? ''), how === 'rebase' ? 'rebase' : 'merge'),
  'git:addRemote': (p, name, url) => opsAt('git:addRemote').addRemote(p, String(name ?? ''), String(url ?? '')),
  'git:renameRemote': (p, from, to) => opsAt('git:renameRemote').renameRemote(p, String(from ?? ''), String(to ?? '')),
  'git:setRemoteUrl': (p, name, url) => opsAt('git:setRemoteUrl').setRemoteUrl(p, String(name ?? ''), String(url ?? '')),
  'git:removeRemote': (p, name, expected) => opsAt('git:removeRemote').removeRemote(p, String(name ?? ''), Array.isArray(expected) ? expected.map(String) : undefined),
  'git:fetch': (p) => opsAt('git:fetch').fetch(p),
  'git:pull': (p) => opsAt('git:pull').pull(p),
  'git:push': (p, remote) => opsAt('git:push').push(p, remote ? String(remote) : undefined),
  'git:pushTo': (p, remote, scope, branch) => opsAt('git:pushTo').pushTo(p, String(remote ?? ''), scope === 'all' ? 'all' : 'branch', branch ? String(branch) : undefined),
  'git:setUpstream': (p, branch, remote, remoteBranch, pushFirst) => opsAt('git:setUpstream').setUpstream(p, String(branch ?? ''), remote == null ? null : String(remote), String(remoteBranch ?? ''), !!pushFirst),
  'git:createTag': (p, name, message, pushTo) => opsAt('git:createTag').createTag(p, String(name ?? ''), String(message ?? ''), pushTo ? String(pushTo) : undefined),
  'git:setIdentity': (p, name, email) => opsAt('git:setIdentity').setIdentity(p, String(name ?? ''), String(email ?? '')),
  'git:initCheck': (p) => opsAt('git:initCheck').initCheck(p),
  'git:init': (p, opts) => opsAt('git:init').init(p, opts && typeof opts === 'object' ? opts : { gitignore: 'none' }),
  // The Files tab's ignore writes (HI-2743); its reads stay filesGit.ts'.
  'files:gitExclude': (p, items, target, ext) => opsAt('files:gitExclude').exclude(p, items, target, ext === true),
  'files:gitUntrack': (p, items) => opsAt('files:gitUntrack').untrack(p, items),
  'files:gitInclude': (p, items) => opsAt('files:gitInclude').include(p, items)
}
