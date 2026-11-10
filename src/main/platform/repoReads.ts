// Port 5 of the platform contract, its reads (SPEC §16.3.6, HI-2785's R2): what the Version Control tab, the Git view,
// Compare, the branch cards and the Merge dialog read of a repository. A plain contract: no platform's code is imported
// here, only the shared view types, so a caller holding RepoReads never reaches a version control's module itself. Each
// platform with repository operations implements it in its own module (Git: gitRepoReads.ts, over gitRepo.ts,
// gitCompare.ts, branchWatch.ts and branchMerge.ts); repoReadsPorts.ts finds one by platform, never switching on an id.
// The mutations are R3's (RepoOps).
//
// 1.4.0 changes no behaviour (§16.3.6's rule 1): every member's Git implementation is the function its callers called
// before, with the same git commands in the same order, the same answers and the same errors
// (tests/repoReadTraces.test.ts). Reads have no side effects on the repository (R5.3). History pages and comparisons
// read from endpoints pinned once (compare's `pinned`, History's page of a line read once), never a line that moves
// between pages. The view types keep their Git names in 1.4.0 (the window's Git text); the members use platform words.

import type { BranchDrops, BranchUpdatePlan, CompareLines, GitComparison, GitHistory, GitRepoInfo, GitRepoSummary, LeftoverInfo } from '../../shared/gitRepo'
import type { SigningInfo } from '../../shared/gitSigning'
import type { ResolvedStart, StartPoints } from '../../shared/nextVersion'
import type { AgentBranchStatus, GitDiff, GitStatus, MergeBranchList, ProjectInfo } from '../../shared/types'

/** A slot as the board records it, for Compare's list: its folder, and its open lease's card and agent (null: free). */
export interface ReadSlot {
  name: string
  folder: string
  card: number | null
  agent: string | null
  target: string | null
}

/** An agent's watched line (the branch cards): its project, its folder and line, and for a slot the target it merges into. */
export interface WatchedLine {
  project: ProjectInfo
  agentId?: string
  worktree: { path: string; branch: string; base: string }
  slot?: true
  target?: string
}

/** Two pinned endpoints of a comparison: the revisions read when it opened (unknown values are ignored, as today). */
export type ComparePins = { base?: unknown; head?: unknown } | null

/** What the window reads of a repository (port 5's reads). */
export interface RepoReads {
  /** The Changes tab's changed files in a working folder (HI-2792); with `base`, everything since the line left it. */
  changes(root: string, base?: string): Promise<GitStatus>
  /** The Changes tab's diff of one file (HI-2792), as `changes` lists it. */
  changeDiff(root: string, file: string, base?: string): Promise<GitDiff>
  /** The folder's line, head, upstream, remotes and state (repoSummary): cheap, no working-tree scan. */
  summary(root: string): Promise<GitRepoSummary>
  /** The line the project's work merges into, as its options say (none: the default line). */
  workTarget(projectPath: string): Promise<string | null>
  /** Branches & remotes: lines, remote lines, remotes, workspaces, identity, the target and default line. */
  info(root: string, workTarget: string | null): Promise<GitRepoInfo>
  /** What clean-up offers: merged lines and their remote ones. */
  leftovers(root: string, workTarget: string | null): Promise<LeftoverInfo>
  /**
   * HI-1185: how the folder's commits are signed, and whether its signer could sign just now with nobody there (bounded;
   * at most once a minute unless `force`). Optional: a platform without signing has none, and nothing is shown.
   */
  signing?(root: string, force?: boolean): Promise<SigningInfo>
  /** A line's history, a page at a time, and the tags. */
  history(root: string, o: { ref?: string | null; page?: number; workTarget?: string | null }): Promise<GitHistory>
  /** What can be compared: the lines, main, the integration line and the slots with a line. */
  compareLines(root: string, workTarget: string | null, slots: readonly ReadSlot[]): Promise<CompareLines>
  /** A comparison of two lines, a page of commits and files, from the endpoints pinned when it opened. */
  compare(root: string, base: string, head: string, page: number, pinned?: ComparePins): Promise<GitComparison>
  /** One file's diff in a comparison, between the same pinned endpoints. */
  compareDiff(root: string, base: string, head: string, file: string, pinned?: ComparePins): Promise<GitDiff>
  /** The commits deleting an unmerged line drops. */
  lineDrops(projectPath: string, line: string): Promise<BranchDrops>
  /** How a line would be brought up to date with its target. */
  updatePlan(projectPath: string, line: string): Promise<BranchUpdatePlan>
  /** The local lines whose upstream is on a remote. */
  remoteTracking(projectPath: string, remote: string): Promise<string[]>
  /** The names a new line can start at (HI-2807). */
  startPoints(projectPath: string): Promise<StartPoints>
  /** A start point resolved by the ref its kind names (HI-2807), or null. */
  resolveStart(projectPath: string, ref: string): Promise<ResolvedStart | null>
  /** Why a name can't be a new line, in the window's words, or null (HI-2807). */
  checkLineName(projectPath: string, name: string): Promise<string | null>
  /** Which of these names aren't local lines (HI-2807). */
  missingLines(projectPath: string, names: string[]): Promise<string[]>
  /** An agent's line's unmerged work (the branch cards), or null when there is none to say. */
  lineStatus(found: WatchedLine): Promise<AgentBranchStatus | null>
  /** The Merge dialog's lines. */
  mergeLines(projectPath: string): Promise<MergeBranchList>
  /** One line's status against a target, in the Merge dialog. */
  lineMergeStatus(projectPath: string, line: string, target: string): Promise<AgentBranchStatus>
}
