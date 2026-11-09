// Port 5 of the platform contract, its mutations (SPEC §16.3.6, HI-2788's R3): what the Version Control tab, the Git
// view, the Merge dialog, the Files tab's Git menu and the Assistant's branch tool change in a repository. A plain
// contract: no platform's code is imported here, only shared types, so a caller holding RepoOps never reaches a version
// control's module itself. Each platform with repository operations implements it in its own module (Git:
// gitRepoOps.ts, over gitRepo.ts, gitInit.ts, branchMerge.ts, worktrees.ts and filesGit.ts); repoOpsPorts.ts finds one
// by platform and refuses an operation its descriptor doesn't list (`Operation`, shared/platform/descriptors.ts). The
// reads are R2's (RepoReads).
//
// 1.4.0 changes no behaviour (§16.3.6's rule 1): every member's Git implementation is the function its callers called
// before, with its guards (R5.1: a busy folder, a line checked out elsewhere, a subfolder of a larger repository, names,
// the repository lock and the folder fence where they are taken today), the same git commands in the same order and the
// same answers and refusals (tests/repoOpTraces.test.ts).

import type { BranchAt, BranchUpdateHow, PushScope } from '../../shared/gitRepo'
import type { GitInitCheck, GitInitOptions } from '../../shared/gitInit'
import type { IgnoreTarget } from '../../shared/gitIgnoreRules'
import type { BranchStart, ResolvedStart } from '../../shared/nextVersion'
import type { FileGitDone, MergeResult } from '../../shared/types'
import type { Operation } from '../../shared/platform/descriptors'

/**
 * Which members each operation may call (HR3's s15): the port is handed out for one operation, typed down to its own
 * members, so a lookup for one can't invoke another. A line Combwork made is removed under the operation that made it
 * (Start the next version's rollback) or that deletes lines (the Assistant's undo).
 */
export interface OpMembers {
  switchLine: 'switchLine'
  createLine: 'createLine' | 'makeLine' | 'removeMadeLine'
  deleteLines: 'deleteLines' | 'removeMadeLine'
  deleteRemoteLines: 'deleteRemoteLines'
  updateLine: 'updateLine'
  mergeLine: 'mergeLine' | 'mergeWorkspace'
  addRemote: 'addRemote'
  renameRemote: 'renameRemote'
  setRemoteUrl: 'setRemoteUrl'
  removeRemote: 'removeRemote'
  fetch: 'fetch'
  pull: 'pull'
  push: 'push'
  pushTo: 'pushTo'
  setUpstream: 'setUpstream'
  createTag: 'createTag'
  setIdentity: 'setIdentity'
  init: 'initCheck' | 'init'
  ignoreRules: 'exclude' | 'untrack' | 'include'
}

/** The port as handed out for one operation: its own members only. */
export type OpsFor<O extends Operation> = Pick<RepoOps, OpMembers[O]>

/** A line made by Combwork not yet removed, and why it stayed (HI-2807): moved since, checked out, in use, gone, a failure. */
export type MadeLineKept = { why: 'moved' | 'worktree' | 'gone' } | { why: 'inUse'; use: string } | { why: 'failed'; error: string }

/** A workspace with a line of its own (an agent's 0.9 worktree), merged by the Merge dialog. */
export interface MergedWorkspace {
  path: string
  branch: string
  base: string
}

/** What the window changes in a repository (port 5's mutations). Each answers the window's words, or throws its refusal. */
export interface RepoOps {
  // Lines.
  switchLine(projectPath: string, line: string): Promise<string>
  createLine(projectPath: string, name: string, stay: boolean, from?: BranchStart | null): Promise<string>
  deleteLines(projectPath: string, items: BranchAt[], unmerged: boolean): Promise<string>
  deleteRemoteLines(projectPath: string, remote: string, items: BranchAt[]): Promise<string>
  updateLine(projectPath: string, line: string, how: BranchUpdateHow): Promise<string>
  mergeLine(projectPath: string, line: string, opts: { target: string; squash: boolean; message: string }): Promise<MergeResult>
  mergeWorkspace(projectPath: string, ws: MergedWorkspace, opts: { squash: boolean; message: string; moveBranch?: boolean; target?: string }): Promise<MergeResult>
  /** HI-2807: a line made at a pinned start, switching nothing; the caller's guard checked right before the change. */
  makeLine(projectPath: string, name: string, from: BranchStart, guard?: () => void): Promise<ResolvedStart>
  /** HI-2807: a line Combwork made, removed only at its commit and while nothing uses it. */
  removeMadeLine(projectPath: string, name: string, commit: string, inUse?: () => Promise<string | null>, guard?: () => void): Promise<{ removed: true } | ({ removed: false } & MadeLineKept)>
  // Remotes and the network.
  addRemote(projectPath: string, name: string, url: string): Promise<string>
  renameRemote(projectPath: string, from: string, to: string): Promise<string>
  setRemoteUrl(projectPath: string, name: string, url: string): Promise<string>
  removeRemote(projectPath: string, name: string, expected?: string[]): Promise<string>
  fetch(projectPath: string): Promise<string>
  pull(projectPath: string): Promise<string>
  push(projectPath: string, remote?: string): Promise<string>
  pushTo(projectPath: string, remote: string, scope: PushScope, line?: string): Promise<string>
  setUpstream(projectPath: string, line: string, remote: string | null, remoteLine: string, pushFirst: boolean): Promise<string>
  // Tags, identity, initialising.
  createTag(projectPath: string, name: string, message: string, pushTo?: string): Promise<string>
  setIdentity(projectPath: string, name: string, email: string): Promise<string>
  /** Initialise repository's dialog: what initialising would find (a read, for the operation it asks about). */
  initCheck(projectPath: string): Promise<GitInitCheck>
  init(projectPath: string, opts: GitInitOptions): Promise<string>
  // The Files tab's ignore rules (HI-2743).
  exclude(projectPath: string, items: unknown, target: IgnoreTarget, ext: boolean): Promise<FileGitDone>
  untrack(projectPath: string, items: unknown): Promise<FileGitDone>
  include(projectPath: string, items: unknown): Promise<FileGitDone>
}
