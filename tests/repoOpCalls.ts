// The window's repository mutations as ipc.ts makes them (HI-2788): tests/repoOpTraces.test.ts traces these. Recorded at
// 196d85906, before the port, calling the functions directly (that commit's copy of this file); now through the
// handlers ipc.ts registers (repoOpsIpc.ts, each gated by its operation), with the same trace.
import { opsAt, repoOpHandlers as H } from '../src/main/repoOpsIpc'
import type { BranchAt, PushScope } from '../src/shared/gitRepo'
import type { BranchStart } from '../src/shared/nextVersion'

export const switchLine = (p: string, line: string): Promise<unknown> => Promise.resolve(H['git:switch'](p, line))
export const createLine = (p: string, name: string, stay: boolean, from?: BranchStart | null): Promise<unknown> => Promise.resolve(H['git:createBranch'](p, name, stay, from))
export const deleteLines = (p: string, items: BranchAt[], unmerged: boolean): Promise<unknown> => Promise.resolve(H['git:deleteBranches'](p, items, unmerged))
export const updateLine = (p: string, line: string, how: 'merge' | 'rebase'): Promise<unknown> => Promise.resolve(H['git:updateBranch'](p, line, how))
// The Merge dialog's merge: ipc.ts' handler authorizes it, then takes the port at its operation (the authorization's
// own reads aren't part of the delegate traced here, as they weren't in the recording).
export const mergeLine = (p: string, line: string, target: string): Promise<unknown> => opsAt('worktrees:mergeBranch').mergeLine(p, line, { target, squash: false, message: '' })
export const addRemote = (p: string, name: string, url: string): Promise<unknown> => Promise.resolve(H['git:addRemote'](p, name, url))
export const renameRemote = (p: string, from: string, to: string): Promise<unknown> => Promise.resolve(H['git:renameRemote'](p, from, to))
export const setRemoteUrl = (p: string, name: string, url: string): Promise<unknown> => Promise.resolve(H['git:setRemoteUrl'](p, name, url))
export const removeRemote = (p: string, name: string, expected?: string[]): Promise<unknown> => Promise.resolve(H['git:removeRemote'](p, name, expected))
export const fetchAll = (p: string): Promise<unknown> => Promise.resolve(H['git:fetch'](p))
export const pull = (p: string): Promise<unknown> => Promise.resolve(H['git:pull'](p))
export const push = (p: string, remote?: string): Promise<unknown> => Promise.resolve(H['git:push'](p, remote))
export const pushTo = (p: string, remote: string, scope: PushScope, line?: string): Promise<unknown> => Promise.resolve(H['git:pushTo'](p, remote, scope, line))
export const setUpstream = (p: string, line: string, remote: string | null, remoteLine: string, pushFirst: boolean): Promise<unknown> => Promise.resolve(H['git:setUpstream'](p, line, remote, remoteLine, pushFirst))
export const createTag = (p: string, name: string, message: string, to?: string): Promise<unknown> => Promise.resolve(H['git:createTag'](p, name, message, to))
export const setIdentity = (p: string, name: string, email: string): Promise<unknown> => Promise.resolve(H['git:setIdentity'](p, name, email))
export const initCheck = (p: string): Promise<unknown> => Promise.resolve(H['git:initCheck'](p))
export const init = (p: string, name?: string, email?: string): Promise<unknown> => Promise.resolve(H['git:init'](p, { gitignore: 'none', ...(name ? { name, email } : {}) }))
export const exclude = (p: string, rel: string): Promise<unknown> => Promise.resolve(H['files:gitExclude'](p, [{ rel, isDir: false }], 'local', false))
export const untrack = (p: string, rel: string): Promise<unknown> => Promise.resolve(H['files:gitUntrack'](p, [{ rel, isDir: false }]))
export const include = (p: string, rel: string): Promise<unknown> => Promise.resolve(H['files:gitInclude'](p, [{ rel, isDir: false }]))
