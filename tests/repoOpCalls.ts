// The window's repository mutations as ipc.ts makes them (HI-2788): tests/repoOpTraces.test.ts traces these. Recorded
// before the port, calling today's functions directly; the port's dispatch replaces each call here, the trace unchanged.
import * as R from '../src/main/gitRepo'
import { initCheck as checkInit, initRepo } from '../src/main/gitInit'
import * as F from '../src/main/filesGit'
import { mergeBranch } from '../src/main/branchMerge'
import type { BranchAt, PushScope } from '../src/shared/gitRepo'
import type { BranchStart } from '../src/shared/nextVersion'

export const switchLine = (p: string, line: string): Promise<unknown> => R.switchBranch(p, line)
export const createLine = (p: string, name: string, stay: boolean, from?: BranchStart | null): Promise<unknown> => R.createBranch(p, name, stay, from)
export const deleteLines = (p: string, items: BranchAt[], unmerged: boolean): Promise<unknown> => R.deleteBranches(p, items, unmerged)
export const updateLine = (p: string, line: string, how: 'merge' | 'rebase'): Promise<unknown> => R.updateBranch(p, line, how)
export const mergeLine = (p: string, line: string, target: string): Promise<unknown> => mergeBranch(p, line, { target, squash: false, message: '' })
export const addRemote = (p: string, name: string, url: string): Promise<unknown> => R.addRemote(p, name, url)
export const renameRemote = (p: string, from: string, to: string): Promise<unknown> => R.renameRemote(p, from, to)
export const setRemoteUrl = (p: string, name: string, url: string): Promise<unknown> => R.setRemoteUrl(p, name, url)
export const removeRemote = (p: string, name: string, expected?: string[]): Promise<unknown> => R.removeRemote(p, name, expected)
export const fetchAll = (p: string): Promise<unknown> => R.fetchAll(p)
export const pull = (p: string): Promise<unknown> => R.pull(p)
export const push = (p: string, remote?: string): Promise<unknown> => R.push(p, remote)
export const pushTo = (p: string, remote: string, scope: PushScope, line?: string): Promise<unknown> => R.pushToRemote(p, remote, scope, line)
export const setUpstream = (p: string, line: string, remote: string | null, remoteLine: string, pushFirst: boolean): Promise<unknown> => R.setUpstream(p, line, remote, remoteLine, pushFirst)
export const createTag = (p: string, name: string, message: string, pushTo?: string): Promise<unknown> => R.createTag(p, name, message, pushTo)
export const setIdentity = (p: string, name: string, email: string): Promise<unknown> => R.setIdentity(p, name, email)
export const initCheck = (p: string): Promise<unknown> => checkInit(p)
export const init = (p: string, name?: string, email?: string): Promise<unknown> => initRepo(p, { gitignore: 'none', ...(name ? { name, email } : {}) })
export const exclude = (p: string, rel: string): Promise<unknown> => F.gitExclude(p, [{ rel, isDir: false }], 'local', false)
export const untrack = (p: string, rel: string): Promise<unknown> => F.gitUntrack(p, [{ rel, isDir: false }])
export const include = (p: string, rel: string): Promise<unknown> => F.gitInclude(p, [{ rel, isDir: false }])
