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
import type { FileGitDone, FolderChangeAction, FolderChangesDone, MergeResult } from '../../shared/types'
import type { Operation } from '../../shared/platform/descriptors'
import type { OperationRequest, OperationStepResult } from '../../shared/gitOperations'
import type { RemotePrune, RepoHealth } from '../../shared/gitHealth'
import type { StashApplied, StashFile, StashRef, StashRequest, StashRow } from '../../shared/gitStashes'
import type { GitDiff } from '../../shared/types'
import type { BranchMoves, RestorePlan } from '../../shared/gitMoves'
import type { FileCommits, FileRestored, FileRestorePlan, FileRestoreRequest, RestoreSource } from '../../shared/gitFileRestore'
import type { CommitActionDone, CommitDetail } from '../../shared/gitCommitView'

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
  fetch: 'fetchRemotes'
  pull: 'pull'
  push: 'push'
  pushTo: 'pushTo'
  setUpstream: 'setUpstream'
  createTag: 'createTag'
  setIdentity: 'setIdentity'
  init: 'initCheck' | 'init'
  ignoreRules: 'exclude' | 'untrack' | 'include'
  folderChanges: 'settleChanges' | 'commitIgnore'
  operationSteps: 'operationStep'
  repoHealth: 'health' | 'pruneWorktrees' | 'removeLocks' | 'remotePrunePreview' | 'fetchPrune'
  stashes: 'stashes' | 'stashFiles' | 'stashDiff' | 'applyStash' | 'dropStash'
  branchMoves: 'moves' | 'restorePlan' | 'restore'
  renameLine: 'renameLine'
  deleteTag: 'deleteTag'
  pushTag: 'pushTag'
  restoreFile: 'fileRestorePlan' | 'fileCommits' | 'restoreFile'
  commitActions: 'commitDetail' | 'commitFileDiff' | 'commitAction'
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
  fetchRemotes(projectPath: string): Promise<string>
  pull(projectPath: string): Promise<string>
  push(projectPath: string, remote?: string): Promise<string>
  pushTo(projectPath: string, remote: string, scope: PushScope, line?: string): Promise<string>
  setUpstream(projectPath: string, line: string, remote: string | null, remoteLine: string, pushFirst: boolean): Promise<string>
  /** HI-3474: a line renamed at the commit shown; with `onRemote`, the remote line it tracks too. */
  renameLine(projectPath: string, line: BranchAt, to: string, onRemote: boolean): Promise<string>
  // Tags, identity, initialising.
  /** A tag on the commit checked out, or (HI-3471's Tag here…) on `at`, a commit in full. */
  createTag(projectPath: string, name: string, message: string, pushTo?: string, at?: string): Promise<string>
  /** HI-3474: a tag deleted as shown (`sha`, its ref's whole value); with `remote`, there first. */
  deleteTag(projectPath: string, tag: BranchAt, remote: string | null): Promise<string>
  /** HI-3474: a tag pushed to a remote, never forced. */
  pushTag(projectPath: string, name: string, remote: string): Promise<string>
  setIdentity(projectPath: string, name: string, email: string): Promise<string>
  /** Initialise repository's dialog: what initialising would find (a read, for the operation it asks about). */
  initCheck(projectPath: string): Promise<GitInitCheck>
  init(projectPath: string, opts: GitInitOptions): Promise<string>
  // The Files tab's ignore rules (HI-2743).
  exclude(projectPath: string, items: unknown, target: IgnoreTarget, ext: boolean): Promise<FileGitDone>
  untrack(projectPath: string, items: unknown): Promise<FileGitDone>
  include(projectPath: string, items: unknown): Promise<FileGitDone>
  // A folder's uncommitted changes (HI-2944).
  /**
   * Commits or sets aside exactly `shown`, the changes in the folder `target` is checked out in (found here, never given),
   * under the repository lock and that folder's fence, only while that is still `seen` (the folder the user was shown the
   * changes in: a pause's, or a start's warning's); `guard` runs there before anything is touched and refuses by throwing
   * (the caller's own condition: the queue's pause still the one acted on).
   */
  settleChanges(projectPath: string, target: string, seen: string, action: FolderChangeAction, shown: string[], label: string, guard?: () => void): Promise<FolderChangesDone>
  /** Files' Commit it: the project folder's top .gitignore, as it is now, committed alone. */
  commitIgnore(projectPath: string): Promise<FolderChangesDone>
  // HI-3470: an operation left under way in a folder, the user's step at a time.
  /**
   * A step of the operation under way in `folder` (the project's, or a worktree of its repository), or a conflicted file
   * settled, under the repository lock and the folder's fence, only while it is still `req.what` and nothing works there;
   * `guard` runs there before git does and refuses by throwing. Git's own output, and whether it went on and stopped
   * again (HI-3503).
   */
  operationStep(projectPath: string, folder: string, req: OperationRequest, guard?: () => Promise<void> | void): Promise<OperationStepResult>
  // HI-3473: Repository health, the user's click at a time; each refused while anything works on the repository.
  /** The worktree entries a prune would drop and the repository's lock files, each judged stale or not: no remote reached. */
  health(projectPath: string): Promise<RepoHealth>
  /** The entries the window showed (as sent, checked), each dropped only while git still lists it so. A summary. */
  pruneWorktrees(projectPath: string, entries: unknown): Promise<string>
  /** The lock files the window showed (as sent, checked), each removed only while it is that file and still stale. A summary. */
  removeLocks(projectPath: string, locks: unknown): Promise<string>
  /** Per remote, the remote-tracking branches deleted on it (it reaches each remote). */
  remotePrunePreview(projectPath: string): Promise<RemotePrune[]>
  /** The remotes (as sent, checked) fetched with prune: what was dropped. */
  fetchPrune(projectPath: string, remotes: unknown): Promise<string>
  // HI-3472: Changes' Stashes, the user's click at a time.
  /** The repository's stashes, newest first (any folder of it: git shares them). */
  stashes(root: string): Promise<StashRow[]>
  /** The files a stash holds (Show): changed, then untracked. */
  stashFiles(root: string, commit: string): Promise<StashFile[]>
  /** One file of a stash, against the commit it was made on. */
  stashDiff(root: string, commit: string, file: string, untracked: boolean): Promise<GitDiff>
  /**
   * The stash applied into `folder` (and for a Pop, dropped once clean), under the repository lock and the folder's
   * fence, refused while anything works there or the folder has uncommitted changes to a file it holds; `guard` runs
   * there before git does and refuses by throwing.
   */
  applyStash(projectPath: string, folder: string, req: StashRequest, guard?: () => Promise<void> | void): Promise<StashApplied>
  /** The row of the list dropped (HI-3527: that row, never another holding its commit), under the repository lock. */
  dropStash(projectPath: string, ref: StashRef): Promise<void>
  // HI-3469: History's Moves (a local branch's reflog) and Restore to here…, the user's click at a time.
  /** A page of a local branch's moves, newest first (null: the project folder's branch, else the target's). */
  moves(projectPath: string, branch: string | null, page: number): Promise<BranchMoves>
  /** What restoring the branch to a commit would do now (the request as sent, checked), and why it can't be done (blocked). */
  restorePlan(projectPath: string, req: unknown): Promise<RestorePlan>
  /**
   * The branch moved from `from` (as the user saw it) to `to`: in the project folder by `git reset --keep`, checked out
   * nowhere by a compare-and-swap, under its merge slot, the repository lock and the folder's fence; the notice.
   */
  restore(projectPath: string, req: unknown): Promise<string>
  // HI-3477: the Files tab's Discard Changes… and Restore From…, of one tracked file in the project folder.
  /** What it would do: the commit its version comes from (`target`: the project's target, by name), the file on disk against it. */
  fileRestorePlan(projectPath: string, rel: unknown, source: RestoreSource, target: string | null, commit: string | null): Promise<FileRestorePlan>
  /** A page of the commits that changed the file on the folder's branch, newest first. */
  fileCommits(projectPath: string, rel: unknown, page: unknown): Promise<FileCommits>
  /**
   * Its uncommitted changes stashed, then (a Restore) its version at `req.commit` written, under the repository lock and
   * the folder's fence, refused while anything works there; `guard` runs there before git does and refuses by throwing.
   */
  restoreFile(projectPath: string, req: FileRestoreRequest, guard?: () => Promise<void> | void): Promise<FileRestored>
  // HI-3471: History's Commit dialog, the user's click at a time (requests as sent, checked).
  /** A commit's details and files, and whether Revert… and Cherry-pick… can be done now. */
  commitDetail(projectPath: string, commit: unknown): Promise<CommitDetail>
  /** One file of a commit against its first parent. */
  commitFileDiff(projectPath: string, commit: unknown, file: string): Promise<GitDiff>
  /** Revert… or Cherry-pick… onto the project folder's branch, under its merge slot, the repository lock and its fence. */
  commitAction(projectPath: string, req: unknown): Promise<CommitActionDone>
}
