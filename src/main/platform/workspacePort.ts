// Port 2 of the platform contract (SPEC §16.3.6, HI-2786's R4): the mechanics of working folders, the isolation
// capability. A workspace's inspection (its line, head, files and the store's list of workspaces), its creation, its
// preparation for a card (a line made or checked out, a detach at a target's head), its recreation and its removal, and
// the line a card's workspace was prepared on, deleted once merged. Plain contracts: no platform's code is imported here.
// Leases, operation tokens, writer reservations, setup and archive jobs and the pool's state machine stay common
// (slots.ts, slotCards.ts, agentWorktree.ts): they ask this port to act on a folder and read its answers, and every
// refusal (a held lease, a late process, a dirty or unmerged slot, unreadable state, a moved folder) stays theirs, in
// their words (R2.3). Each platform implements it in its own module (Git: gitWorkspacePort.ts, over worktrees.ts,
// platform/git.ts and git.ts, delegating to them unchanged); workspacePorts.ts finds it, never by a switch on an id.
//
// 1.4.0 changes no behaviour (§16.3.6's rule 1): Git's implementation runs today's git commands, in the same folders and
// order (tests/slotTraces.test.ts holds the pool to its traces). Folders here are paths: `repo` is the project's folder
// (its repository), `folder` a workspace's own. Containment of a workspace's work in its target (unaccounted work) is
// the history port's (R6); until it exists the pool reads it as before.

import type { PlatformId } from '../../shared/platform/descriptors'
import type { Maybe } from './types'

/** One of the store's workspaces as the platform lists it: its folder (absolute) and the line it has checked out (null: none, detached). */
export interface WorkspaceListing {
  path: string
  line: string | null
}

/** A folder's checkout read with no process (from its files): its line (null: detached) and its head; null when unreadable. */
export interface WorkspaceCheckout {
  line: string | null
  head: string
}

/** A folder's line, head and a target line's head, read at once (Git: one rev-parse), each a value or unknown. */
export interface WorkspaceHeads {
  line: Maybe<string | null>
  head: Maybe<string>
  target: Maybe<string | null>
}

/** What a step that changes a workspace or a line answered: done, or not with the tool's own words (`err`, as it said them). */
export interface WorkspaceStep {
  ok: boolean
  err: string
}

/**
 * A platform's workspace lifecycle (the isolation capability, §16.3.6 Port 2). Every read answers a value, unknown or
 * null as each says (unknown is never clean, never gone, never removable: R2.1), and a step answers what the tool said.
 */
export interface WorkspacePort {
  platform: PlatformId

  // Inspection: no side effects on the repository.
  /** The store's workspaces, the project's own folder included; null when they can't be listed (never an empty list). */
  list(repo: string): Promise<WorkspaceListing[] | null>
  /** The revision a folder has checked out. */
  head(folder: string): Promise<Maybe<string>>
  /** The line a folder has checked out (null: detached). */
  line(folder: string): Promise<Maybe<string | null>>
  /** The line a folder shows as checked out ('' detached), or null when the tool can't say: a recreation's check of its result. */
  shownLine(folder: string): Promise<string | null>
  /** The line checked out in the project's folder; null when detached or unreadable (for choices, never for what is merged). */
  currentLine(repo: string): Promise<string | null>
  /** A folder's checkout, read synchronously from its files with no process (cheap enough inside a transaction). */
  checkout(folder: string): WorkspaceCheckout | null
  /** A folder's line and head with `target`'s head, read at once. */
  heads(folder: string, target: string): Promise<WorkspaceHeads>
  /** A folder's changed files, tracked and untracked but not ignored (none: clean). */
  dirty(folder: string): Promise<Maybe<string[]>>
  /** A line's head (null: no such line). */
  lineHead(repo: string, line: string): Promise<Maybe<string | null>>
  /** The repository's default target line (Git: main, else master). */
  defaultLine(repo: string): Promise<Maybe<string>>
  /** Whether a line exists (false also when the tool can't say: a 0.9 worktree's recreation chooses by it, as before). */
  lineExists(repo: string, line: string): Promise<boolean>
  /** The workspaces whose registrations a prune would drop (their folders gone), by where each was. */
  prunable(repo: string): Promise<string[]>

  // Creation and recreation (R2.6: only by the platform's own command for its workspaces).
  /** A new workspace at `folder`, detached at the revision `at`. */
  create(repo: string, folder: string, at: string): Promise<WorkspaceStep>
  /** A workspace made again at `folder` on its existing line. */
  attach(repo: string, folder: string, line: string): Promise<WorkspaceStep>
  /** A workspace at `folder` on a new line made from `base` (a 0.9 agent's worktree): throws the tool's words, or a refused line name. */
  createOnNewLine(repo: string, folder: string, line: string, base: string): Promise<void>
  /** The repository's ignored files matching `patterns` copied into a new workspace (as Settings say); those copied. */
  copyIgnored(repo: string, folder: string, patterns: string): Promise<string[]>
  /** Registrations of workspaces whose folders are gone dropped (callers check `prunable` first where others may need theirs). */
  prune(repo: string): Promise<void>

  // Preparation.
  /** The folder switched to a line: the one it has (`base` null) or a new one made from `base`. Refused by the tool rather than lose files. */
  prepare(folder: string, line: string, base: string | null): Promise<WorkspaceStep>
  /** The folder detached at `revision` (`quiet`: without the tool's notices). Refused by the tool rather than lose files. */
  detach(folder: string, revision: string, o?: { quiet?: boolean }): Promise<WorkspaceStep>

  // Removal (R2.5: the platform's own, never forced; the callers' guards first).
  /** The workspace at `folder` removed by the tool, which refuses one with changes. */
  remove(repo: string, folder: string): Promise<WorkspaceStep>

  // A card's line, once merged (§16.10.1).
  /** The line deleted only from `at` (compare and swap). */
  dropLine(repo: string, line: string, at: string): Promise<WorkspaceStep>
  /** A deleted line put back at `revision`, only if it doesn't exist (compare and swap). */
  restoreLine(repo: string, line: string, revision: string): Promise<WorkspaceStep>

  /** The line of a step's `err` that says what went wrong (Git: its fatal: or error: line, else the first), for a reason shown. */
  errorLine(err: string): string
}
