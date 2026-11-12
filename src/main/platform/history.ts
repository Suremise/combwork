// Port 3 of the platform contract (SPEC §16.3.6, HI-2787's R6): what Combwork knows about content and history (the reads
// behind revisions, sameness, containment, attribution and check credit) and the watcher behind observation and the
// write record. Plain contracts: no platform's code is imported here, so a caller holding a HistoryPort or an
// ObservePort never reaches a version control's module itself. Each platform with history implements them in its own
// module (Git: gitHistory.ts, over platform/git.ts and git(), and observe.ts's observer); historyPorts.ts finds one by
// platform, and never switches on a platform id.
//
// 1.4.0 changes no behaviour (§16.3.6's rule 1): every member's Git implementation is the code its callers ran before,
// with the same argv, bounds, parsers, caches and Unknown answers. A read answers a value or Unknown (rule 3), and
// reads take the working folder they ask in (R6's refinement of the type map: every caller holds one, and building a
// RepoContext per read would add reads to each; contexts stay port 1's, for identity and locks).

import type { FileChange } from '../../shared/workflow/facts'
import type { Change, Containment, Maybe } from './types'

/** A commit as attribution reads it: its id, author email and `Combwork-Card` trailers. */
export interface CommitInfo {
  commit: string
  email: string
  cards: string[]
  subject: string
}

/** A working folder as it is now (workspaceNow): its line (null: detached), head and uncommitted state (dirty's list). */
export interface WorktreeNow {
  line: string | null
  /** Null: no commit yet. */
  head: string | null
  dirty: string[]
  /**
   * HI-2983: the operations under way among `dirty` (Git: its markers, `(MERGE_HEAD)`…, listed last), apart from the
   * files, so a changed file of the same name is a file. Absent: the platform lists none.
   */
  operations?: string[]
  /**
   * HI-3023: the submodules among `dirty` whose only changes are inside them (edited or untracked files there, the
   * recorded commit unchanged): work held there, but nothing the folder itself can commit or set aside. Absent: none.
   */
  insideOnly?: string[]
  /** The line asked for's head (null: no such line), when one was. */
  target?: string | null
  /** The platform's metadata paths asked for, absolute, in their order. */
  gitPaths: string[]
}

/** One side of a sameness or containment question: a change's endpoints and its candidate key (a first test only). */
export interface ChangeAt {
  base: string
  revision: string
  key?: string | null
}

/** Which rule of the own-work proof failed (HI-2753's (a) to (d); retargetCard.ts says what each one is). */
export type OwnWorkRule = 'firstParent' | 'otherRef' | 'reflog' | 'anchor'

/** Why a line's work isn't provably its own: a rule that failed, or why it couldn't be read (its detail English, as the tool's). */
export interface OwnWorkRefusal {
  why: 'cantCheck' | 'notInTarget'
  rule?: OwnWorkRule
  detail?: string
}

/** What the proof is asked about: a line's head against a target (full ids), the points it was started from, its own refs. */
export interface OwnWorkAsk {
  line: string
  head: string
  target: string
  anchors: readonly string[]
  /** Whether a ref is the card's own (its lines, its pins, its queue refs, a stash). */
  own: (ref: string) => boolean
  /** The card's own working folder: its checkout isn't another's. */
  folder: string
  /** Rule (c) too: the line's own record of how it moved (a reviewed revision behind its head needs only the others). */
  reflog: boolean
}

/**
 * A platform's proof that what a line would bring into another target is its own work (HI-2821, HI-2753's move of a card
 * in flight). Optional on the history port: a platform without one doesn't offer the move (§16.3.6's rule 6).
 */
export interface OwnWorkProof {
  /** Null when every revision `head` would bring into `target` is provably the line's own; else the rule that failed. */
  prove(repo: string, p: OwnWorkAsk): Promise<OwnWorkRefusal | null>
  /** Whether `revision`'s change against `target` is the one against `base` (the same revisions brought), or why it can't say. */
  sameCommits(repo: string, revision: string, base: string, target: string): Promise<boolean | { what: string }>
}

/**
 * A platform's history and content reads (port 3). `repo`/`folder`: the working folder asked in (a line is the store's,
 * so any of its workspaces answers it). Revisions are immutable full ids (§16.3.6's rule 4).
 */
export interface HistoryPort {
  /**
   * One workflow step (HI-2792, Git's gitStep, #1376): answers about fixed revisions (an ancestor, a merge base) asked
   * once in it, nothing that moves kept; a step inside a step is the outer one's.
   */
  step<T>(fn: () => Promise<T>): Promise<T>
  /** The identity new revisions are made with in the repository (HI-2792: the options form's, the queue's), null when none is set. */
  identity(repo: string): Promise<Maybe<{ name: string; email: string } | null>>
  /** The messages of the revisions in a range, oldest first, merges left out (HI-2792: the queue's squash message). */
  messages(repo: string, range: string): Promise<Maybe<string[]>>
  /** A line's head (lineHead's answer), its tree read in the same command and kept for the step (HI-2792: the queue's step read). */
  lineHeadAndTree(repo: string, line: string): Promise<Maybe<string | null>>
  /** What's checked out in a folder, read off the queue's route (HI-2792: runLink's folderHead), null where nothing is or it can't be read. */
  checkedOut(folder: string): Promise<string | null>
  /** The revision a name gives in a folder, in full, read off the queue's route (HI-2792: runLink's commitIn), null when it names none. */
  commitIn(folder: string, revision: string): Promise<string | null>
  /** How many revisions along `head`'s first-parent history `base` lacks (HI-2792: queueControls' commitsBehind), null when unreadable. */
  countFirstParents(repo: string, base: string, head: string): Promise<number | null>
  /** A revision's tree, read in a folder (HI-2792: the queue's skipped-tests bound), null when unreadable. */
  treeOf(folder: string, revision: string): Promise<string | null>
  /** The revision a folder has checked out, read with no side effect. */
  head(folder: string): Promise<Maybe<string>>
  /** The line a folder has checked out, or null when it has none (detached). */
  line(folder: string): Promise<Maybe<string | null>>
  /** A line's head, or null when the line doesn't exist. */
  lineHead(repo: string, line: string): Promise<Maybe<string | null>>
  /** The repository's default target line (Git: its default branch). */
  defaultTarget(repo: string): Promise<Maybe<string>>
  /**
   * The repository's own main line (Git: `main` or `master`), null when it has none: then `defaultTarget` is only the
   * line the folder has checked out (HI-3049).
   */
  mainLine(repo: string): Promise<Maybe<string | null>>
  /** The repository's store (Git: the common git dir), read by the tool. */
  store(repo: string): Promise<Maybe<string>>
  /** `store`, read from the folder's metadata files with no process where they say, else by the tool. */
  storeFast(repo: string): Promise<Maybe<string>>
  /** A ref's revision read from the store's files with no process, or null where they can't say. */
  refSync(store: string, ref: string): string | null
  /** Whether `a` is an ancestor of (or is) `b`. */
  isAncestor(repo: string, a: string, b: string): Promise<Maybe<boolean>>
  /** The best common ancestor of two revisions, or null when they share none. */
  mergeBase(repo: string, a: string, b: string): Promise<Maybe<string | null>>
  /** A folder's uncommitted files (narrowed to `paths`, when given). */
  dirty(folder: string, paths?: string[]): Promise<Maybe<string[]>>
  /** The change between two revisions: its files and candidate key. */
  change(repo: string, base: string, head: string): Promise<Maybe<Change>>
  /** The files changed between two revisions. */
  filesChanged(repo: string, base: string, head: string): Promise<Maybe<FileChange[]>>
  /** A change's candidate key (a first test only, never sameness on its own: R3.2), or null where it has none. */
  candidateKey(repo: string, base: string, head: string): Promise<Maybe<string | null>>
  /** Whether two changes are the same change (§16.3.2's replay; false for anything it can't settle: R3.2). */
  sameChange(repo: string, a: ChangeAt, b: ChangeAt): Promise<boolean>
  /** How `target` holds a change (at `at`, its head as read, when given), or null when it doesn't. */
  contains(repo: string, target: string, c: ChangeAt, at?: string): Promise<Maybe<Containment | null>>
  /**
   * HI-3041: whether the remote `target` follows (G21) has `revision` now, from a fetch of its branch (the remote's head
   * kept a minute per repository and target). Unknown when it can't be read. Absent: a platform with no remote to look at.
   */
  remoteHas?(repo: string, target: string, revision: string): Promise<Maybe<boolean>>
  /** A line's own revisions since a base, newest first (its first parents). */
  firstParents(repo: string, base: string, head: string): Promise<Maybe<readonly string[]>>
  /** A range's commits, oldest first, with their authors and card trailers (attribution's read). */
  commits(repo: string, range: string, opts?: { firstParent?: boolean }): Promise<Maybe<CommitInfo[]>>
  /** A working folder's line, head and uncommitted state, and optionally a line's head and some metadata paths. */
  workspaceNow(folder: string, o?: { target?: string; gitPaths?: string[] }): Promise<Maybe<WorktreeNow>>
  /** The lines checked out in the store's workspaces, line → folder; unknown where the tool can't say. */
  checkedOutLines(repo: string): Promise<Maybe<Map<string, string>>>
  /** Deletes a line only while it is still at `expected` (a compare and swap: true when it was deleted). */
  deleteLine(repo: string, line: string, expected: string): Promise<boolean>
  /**
   * A check's stat snapshot inputs (runChecks): the folder's tracked files ([] where unreadable) and its own metadata
   * folder (null where unreadable), each read by the tool.
   */
  checkFiles(folder: string): Promise<{ files: string[]; gitDir: string | null }>
  /**
   * The queue's stat snapshot inputs (queueChecks, #1386): the tracked files (null where unreadable: never an empty list
   * in place of one unread) and the metadata folder, from the folder's own files first, else by the tool.
   */
  queueCheckFiles(folder: string): Promise<{ files: string[] | null; gitDir: string | null }>
  /** The raw change between two revisions, path by path with full content ids (focusedRun's parse), or null unreadable. */
  rawDiff(folder: string, from: string, to: string): Promise<string | null>
  /** The own-work proof a card's move to another target needs (HI-2821); absent: the move isn't offered. */
  ownWork?: OwnWorkProof
}

/** What the watcher tells its subscribers (platform-neutral: a line is a Git branch). */
export type ObserveEvent =
  | { kind: 'lineMoved'; project: string; line: string; from: string | null; to: string | null }
  | { kind: 'folderMoved'; project: string; folder: string; from: string | null; to: string | null }
  | { kind: 'written'; project: string; folder: string; paths: string[] }
  /** HI-2882: something a platform keeps (jj's retained bundles) may have changed, or its minute's tick: its adapter decides. */
  | { kind: 'invalidated'; project: string; what: string }

export interface Disposable {
  dispose(): void
}

/** The question checks ask of the write record, answered: the folder's writes that count, or unknown. */
export interface FolderChanges {
  changed: boolean
  /** What counted: folder-relative paths, ':reflog', ':edit'. */
  paths: string[]
}

/**
 * The watcher (port 3's observation), common to every platform: a project's events, and per working folder the write
 * record check brackets ask (§16.13, R3.3): each write to a file that counts and, with history, each reflog entry. A
 * platform without history (None) has it too: its deliverables' watch.
 */
export interface ObservePort {
  /** A project's events until disposed. */
  subscribe(project: string, fn: (e: ObserveEvent) => void): Disposable
  /** Once the events of what was written in a folder so far have come in. */
  settled(folder: string): Promise<void>
  /** What changed in a folder between t0 and t1 that counts; unknown where its record isn't complete for the whole time. */
  changedBetween(folder: string, t0: number, t1: number, counts?: (paths: string[]) => string[]): Promise<Maybe<FolderChanges>>
  /** Where a project's refs stand now, as a token (HI-2115); null when that can't be told. */
  refsNow(project: string, folder: string): Promise<string | null>
  /** Reads every repository again (the minute, window focus). */
  rescan(): void
}

/** The write record's questions alone (a check's bracket): the watcher's, or a test's own. */
export type WriteLog = Pick<ObservePort, 'changedBetween' | 'settled'>
