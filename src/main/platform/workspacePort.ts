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
import type { ChildProcess, SpawnOptions } from 'child_process'
import type { GitFilesStatus } from '../../shared/types'

/**
 * jj's id (HI-2795's J2, agreed with J1, HI-2794, which imports it): a project platform since J6 (HI-2799), so these are
 * `PlatformId`'s own. jj's port is still reached only by injection (`PoolDeps.workspaces`, `CopyPoolDeps.workspaces`),
 * never `slotWorkspaces`, until jj's card work is enabled (no jj card starts yet: `start.platformReady`).
 */
export type JjPlatform = Extract<PlatformId, 'jj'>
/** The platforms a workspace port can be: a project's. */
export type WorkspacePlatform = PlatformId

/**
 * Who a workspace is, beyond its folder (HI-2795): its store, its own name there and its creation generation (the
 * folder's file ids at creation: a folder replaced at the same path, even a same-named workspace of the same store, is
 * another). Recorded on a slot's or copy's row by a platform whose workspaces need it (jj); Git's rows have none.
 */
export interface WorkspaceIdentity {
  store: string
  workspace: string
  generation: string
}

/** The caller's proof it still holds the folder (its operation's token, checked in a write): false stops before a mutation. */
export interface WorkspaceFence {
  still(): boolean | Promise<boolean>
}

/**
 * Durable state a multi-step change keeps between its steps (HI-2795: a jj removal, a stale recovery), so an
 * interrupted one resumes where it was: board_meta, by key, in the pool's store. `read` answers what was written last.
 */
export interface WorkspaceJournal {
  read(): unknown
  write(v: unknown): Promise<void>
  clear(): Promise<void>
}

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

/** HI-1182: how Combwork checks a folder out while submodules and Git LFS are set up there (Git: LFS files left as pointers, `git lfs pull` fills them). */
export interface CheckoutOptions {
  skipSmudge?: boolean
}

/**
 * An owned write's proof (HI-2866, jj's prepare and detach): the row's recorded identity, the holder's fence (checked,
 * with the folder's quiescence, right before every write), the lease it is for, and, for a detach, the card's line it
 * settles and the target whose head it is put back on (re-read under the lock right before the write).
 */
export interface OwnedWrite {
  identity?: WorkspaceIdentity | null
  fence?: WorkspaceFence
  lease?: string
  /** A detach's: the card's line (its preparation) being settled. */
  settles?: string
  /** A detach's: the target whose head `revision` is, read again right before the write. */
  target?: string
}

/** A tool's run in a files step (HI-1182): `code` null when it didn't exit by itself (ended, timed out, not started). */
export interface WorkspaceToolRun {
  ok: boolean
  code: number | null
  out: string
  err: string
}

/**
 * How a files step runs the platform's tool (HI-1182): in the run's job, in `cwd`, its env over the run's own (`env`'s
 * entries win), with no shell. `log`: its output goes to the run's log (a step that changes the folder); a read's doesn't.
 * `stopped()`: the run was ended (its time limit, the workspace closing), so nothing more starts.
 */
export interface WorkspaceFilesExec {
  git(cwd: string, args: string[], o?: { env?: Record<string, string>; log?: boolean }): Promise<WorkspaceToolRun>
  /** A line of Combwork's own in the run's log. */
  note(line: string): void
  /** The run's environment as the tool gets it (for composing GIT_CONFIG_*). */
  baseEnv(): Record<string, string>
  stopped(): boolean
}

/** A files step's folder (HI-1182): made or reset; `project` (a relative submodule URL's base); `disposable` (a copy or the queue's folder: nobody's work). */
export interface WorkspaceFilesStep {
  folder: string
  project: string
  disposable: boolean
}

/** A files step's outcome: done (`ran`: anything ran), or why not (stored, in the Default dialect). */
export type WorkspaceFilesOutcome = { ok: true; ran: boolean } | { ok: false; error: string }

/** What a files step's exec runs in (HI-1182): the run's spawn (its job), environment, log, time limit and end. */
export interface WorkspaceFilesRunOptions {
  spawn: (file: string, args: string[], opts: SpawnOptions) => ChildProcess
  env: Record<string, string>
  log: { write(chunk: Buffer): void }
  timeoutMs: number
  signal?: AbortSignal
  platform?: NodeJS.Platform
}

/**
 * HI-1182: a platform's step for what a checkout leaves out of its workspaces (Git: submodules and LFS files,
 * platform/gitModules.ts). jj refuses repositories that use them (HI-2799), so only Git's port has it.
 */
export interface WorkspaceFiles {
  /** The step's run title in the Progress panel (the commands it may run). */
  title: string
  /**
   * Whether a folder made or reset needs the step, read before any run starts; `disposable` also when a removed
   * submodule may have left its folder. `error`: it couldn't be told, never taken for no.
   */
  needed(folder: string, disposable: boolean): Promise<boolean | { error: string }>
  /** The step itself, through a run's exec. */
  prepare(x: WorkspaceFilesExec, step: WorkspaceFilesStep): Promise<WorkspaceFilesOutcome>
  /** A run's exec of the platform's tool, and how it ended. */
  exec(o: WorkspaceFilesRunOptions): WorkspaceFilesExec & { timedOut(): boolean; close(): void }
  /** What the project folder uses, for the Version Control tab; null when the tool couldn't say. */
  status(folder: string): Promise<GitFilesStatus | null>
}

/**
 * A platform's workspace lifecycle (the isolation capability, §16.3.6 Port 2). Every read answers a value, unknown or
 * null as each says (unknown is never clean, never gone, never removable: R2.1), and a step answers what the tool said.
 */
export interface WorkspacePort {
  platform: WorkspacePlatform

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
  /** A new workspace at `folder`, detached at the revision `at` (`skipSmudge`, HI-1182: Git LFS files left as pointers). */
  create(repo: string, folder: string, at: string, o?: CheckoutOptions): Promise<WorkspaceStep>
  /** A workspace made again at `folder` on its existing line. */
  attach(repo: string, folder: string, line: string): Promise<WorkspaceStep>
  /** A workspace at `folder` on a new line made from `base` (a 0.9 agent's worktree): throws the tool's words, or a refused line name. */
  createOnNewLine(repo: string, folder: string, line: string, base: string): Promise<void>
  /** The repository's ignored files matching `patterns` copied into a new workspace (as Settings say); those copied. */
  copyIgnored(repo: string, folder: string, patterns: string): Promise<string[]>
  /** HI-1182: submodules and LFS files set up in its workspaces (Git's only: absent, the platform has none). */
  files?: WorkspaceFiles
  /** Registrations of workspaces whose folders are gone dropped (callers check `prunable` first where others may need theirs). */
  prune(repo: string): Promise<void>

  // Preparation.
  /**
   * The folder switched to a line: the one it has (`base` null) or a new one made from `base`. Refused by the tool rather
   * than lose files. `o`'s owned-write members (HI-2866) are a platform's whose workspaces need them (jj: refused without
   * them); Git ignores them, its git commands unchanged.
   */
  prepare(folder: string, line: string, base: string | null, o?: CheckoutOptions & OwnedWrite): Promise<WorkspaceStep>
  /** The folder detached at `revision` (`quiet`: without the tool's notices). Refused by the tool rather than lose files. */
  detach(folder: string, revision: string, o?: { quiet?: boolean } & OwnedWrite): Promise<WorkspaceStep>

  /**
   * A check or review copy put at exactly `revision` (HI-2789: copies.ts's reuse of a copy): tracked changes dropped and
   * what isn't ignored removed (dependencies stay); `failed` names the step the tool refused.
   */
  resetTo(folder: string, revision: string, o?: { identity?: WorkspaceIdentity | null; fence?: WorkspaceFence } & CheckoutOptions): Promise<{ ok: true } | { ok: false; failed: 'checkout' | 'clean'; err: string }>

  // Removal (R2.5: the platform's own, never forced on a folder holding anyone's work; the callers' guards first).
  /**
   * The workspace at `folder` removed by the tool, which refuses one with changes; `force` only for a check or review
   * copy, which holds nobody's work (its build outputs go with it).
   */
  remove(repo: string, folder: string, o?: { force?: boolean; identity?: WorkspaceIdentity | null; journal?: WorkspaceJournal; fence?: WorkspaceFence }): Promise<WorkspaceStep>

  // A card's line, once merged (§16.10.1).
  /** The line deleted only from `at` (compare and swap). */
  dropLine(repo: string, line: string, at: string): Promise<WorkspaceStep>
  /** A deleted line put back at `revision`, only if it doesn't exist (compare and swap). */
  restoreLine(repo: string, line: string, revision: string): Promise<WorkspaceStep>

  /** The line of a step's `err` that says what went wrong (Git: its fatal: or error: line, else the first), for a reason shown. */
  errorLine(err: string): string

  /** Repair after a moved workspace or project (the relocation capability, §16.3.6's gate: relocation); absent where it isn't supported. */
  relocate?: Relocation

  // Owned members (HI-2795): a platform whose working copy is recorded by its own commands (jj) has them; Git hasn't, so
  // the pool calls `dirty` as before and its git commands are unchanged (tests/slotTraces.test.ts).
  /**
   * The workspace's identity as it is now (store, name, generation), read after `create`, recorded on the row and
   * compared before every change; null when it can't be read (then nothing is changed).
   */
  identity?(folder: string): Promise<WorkspaceIdentity | null>
  /**
   * An explicit record of the folder's files (jj: a snapshot, a write), allowed only to the holder of the folder's
   * operation (`fence`), after its writers are proved ended: its changed files then, or unknown (stale, not the
   * recorded workspace, the fence lost). The pool calls it instead of `dirty` where it holds the slot.
   */
  record?(folder: string, fence: WorkspaceFence, identity?: WorkspaceIdentity | null): Promise<Maybe<string[]>>
  /**
   * A copy's verification after its quiescence barrier (HI-2795: credit): recorded (`record`), then exactly `revision`
   * with nothing else, not stale, not divergent, read at one operation. True, false, or unknown.
   */
  copyIntact?(folder: string, revision: string, fence: WorkspaceFence, identity?: WorkspaceIdentity | null): Promise<Maybe<boolean>>
}

/**
 * Relocation (§16.3.6 port 2, HI-2792): what Repair does to the store's workspaces after their folders moved
 * (workspaceMove.ts, combworkMove.ts), in the platform's own terms. Git's: worktree move and repair, its links' files,
 * branch rename (gitRelocation.ts).
 */
export interface Relocation {
  /** Whether a folder is one of the store's linked workspaces (Git: a `.git` file, not a folder), read with no process. */
  isWorkspaceFolder(folder: string): Promise<boolean>
  /** Whether the store's links to a workspace are right both ways (by real paths), read with no process. */
  linked(repo: string, folder: string): Promise<boolean>
  /** A workspace's identity, kept across a move (Git: its administrative folder), null when the folder isn't one. */
  identity(folder: string): Promise<string | null>
  /** The folders the store lists as its workspaces (resolved), null when it can't list them. */
  listedFolders(repo: string): Promise<string[] | null>
  /** The store's local lines, as the 0.9 agents' branches are named against (none when unreadable). */
  localLines(repo: string): Promise<string[]>
  /** The remote a line tracks, '' for none. */
  lineRemote(repo: string, line: string): Promise<string>
  /** A workspace moved from one folder to another by the tool. */
  move(repo: string, from: string, to: string): Promise<WorkspaceStep>
  /** The store's links to the workspaces now at `folders` made right again. */
  repair(repo: string, folders: string[]): Promise<WorkspaceStep & { code: number }>
  /** A line renamed. */
  renameLine(repo: string, from: string, to: string): Promise<WorkspaceStep>
}
