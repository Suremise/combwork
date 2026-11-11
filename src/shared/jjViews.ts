// What the Version Control tab shows of a jj repository (HI-2799, J6): read-only views, every one read through jj pinned
// at the repository's single operation head (`--at-op`, never a snapshot, never a merge of several heads: R5.3). A view
// is a value or a typed unknown; an unknown is shown as such, never as clean or empty. Change ids and commit ids are kept
// apart everywhere (R3.1): a change id names a change across rewrites and can be divergent, so it never stands in for a
// commit. Plain data, shared by main (platform/jjViews.ts) and the window (views/JjSections.tsx).

import type { Gate } from './platform/descriptors'
import type { JjTool } from './jjTool'

/**
 * Why a view couldn't be read: the operation heads (none, several: nothing is read through jj then), the tool (missing,
 * not the pinned version), jj failing or answering what can't be parsed, a revision that names several commits or none,
 * the heads moving while it read, no jj repository here, or what detection found (J0's codes).
 */
export type JjViewWhy = 'heads' | 'tool' | 'failed' | 'malformed' | 'ambiguous' | 'none' | 'moved' | 'noRepo' | 'emptyPointer' | 'repoGone' | 'storeType' | 'backend' | 'gitStore' | 'notRun' | 'disagrees'

export interface JjViewUnknown {
  jjUnknown: JjViewWhy
  /** jj's own words or the value concerned, bounded: shown as it is, never translated. */
  detail?: string
}

export type JjView<T> = T | JjViewUnknown

export const isJjViewUnknown = (v: unknown): v is JjViewUnknown => !!v && typeof v === 'object' && typeof (v as JjViewUnknown).jjUnknown === 'string'

/** A workspace of the repository: its name and its working-copy commit (Combwork's slots and copies are named `cw-…`). */
export interface JjWorkspaceRow {
  name: string
  commit: string
  change: string
  /** The project folder's own workspace (HI-2800). */
  here?: boolean
  /** Its files are behind its working-copy commit (another workspace rewrote it); null when that couldn't be read. Only on `here`. */
  stale?: boolean | null
}

/** The Repository section: where the repository is, what jj is, its operation head and workspaces, what isn't supported. */
export interface JjRepoView {
  root: string
  store: string
  colocated: boolean
  linked: boolean
  tool: JjTool
  /** The single operation head the rest was read at; null with several (`heads` says how many). */
  op: string | null
  heads: number
  workspaces: JjView<JjWorkspaceRow[]>
  /** The gates jj's descriptor still lists (SPEC §16.3.6): each shown as not supported, with its reason. */
  gates: readonly Gate[]
}

/** A commit as the views show it: its commit id and change id apart, and what jj says of it. */
export interface JjRow {
  commit: string
  change: string
  description: string
  author: string
  /** When it was authored, ISO (UTC). */
  time: string
  bookmarks: string[]
  /** The workspace's working-copy commit (@). */
  workingCopy: boolean
  empty: boolean
  /** Its change id names more than one visible commit. */
  divergent: boolean
  /** It stores unresolved conflicts. */
  conflict: boolean
}

export interface JjHistoryView {
  op: string
  rows: JjRow[]
  /** More commits than the page shows. */
  capped: boolean
}

/** A bookmark (jj's named line): local, or a remote's (`git` is the colocated Git repository's own). */
export interface JjBookmarkRow {
  name: string
  remote: string | null
  /** Its target is conflicted: `sides` are the commits it points at. */
  conflict: boolean
  commit: string | null
  change: string | null
  sides: string[]
  /** A local bookmark whose Git branch differs (not exported yet, or Git moved it since jj last imported). */
  gitDiffers?: boolean
}

export interface JjBookmarksView {
  op: string
  rows: JjBookmarkRow[]
}

/** A revision resolved for Compare: exactly one commit, or the commits an ambiguous id names (never one picked). */
export type JjResolved = { commit: JjRow } | { ambiguous: JjRow[] } | { none: true }

export interface JjFileChange {
  path: string
  /** jj's summary letter: M modified, A added, D deleted, R renamed, C copied. */
  status: string
}

export interface JjCompareView {
  op: string
  from: JjRow
  to: JjRow
  files: JjFileChange[]
  /** The diff in Git's format, at most JJ_DIFF_MAX characters (`capped` when cut). */
  diff: string
  capped: boolean
}

/** A commit storing conflicts, and the files jj lists as conflicted in it. */
export interface JjConflictRow {
  row: JjRow
  files: JjView<string[]>
}

export interface JjConflictsView {
  op: string
  rows: JjConflictRow[]
  capped: boolean
}

/** A jj operation as the Operations section lists it (HI-2800): its full id, what jj named it, when, by whom and where. */
export interface JjOperationRow {
  id: string
  parents: string[]
  /** When it started, ISO (UTC). */
  time: string
  user: string
  workspace: string
  /** Its description's first line, as jj wrote it (never translated). */
  description: string
  snapshot: boolean
}

export interface JjOperationsView {
  op: string
  rows: JjOperationRow[]
  /** The next page's first operation, or null at the end. */
  next: string | null
}

/**
 * Why a preview gives no command (HI-2800/s19's E1–E7): `tool`, `heads` and `moved` are E1's (the tested jj, one head,
 * the head shown); `parents` E2; `shape` and `bounds` E3; `unimported` E8 (`unimportedStore` not colocated, HI-2896: the store's refs changed with git) (Git's refs or HEAD aren't what jj recorded at the
 * head: a plain Git change jj hasn't imported, HR2's HI-2800 round 1); `workingCopy` E4; `gitOwn` E5; `overlap` E6; `stale` E7;
 * `nothing`: the operation changed nothing a revert could undo.
 */
export type JjOpRefusal = 'tool' | 'heads' | 'moved' | 'parents' | 'shape' | 'bounds' | 'unimported' | 'unimportedStore' | 'workingCopy' | 'gitOwn' | 'overlap' | 'stale' | 'nothing'

/** One thing an operation changed: an entry's key (`bookmark:main`, `wc:default`…) and its value before and after (null: absent). */
export interface JjOpChange {
  key: string
  before: string | null
  after: string | null
}

/** A later change a revert would also touch: an entry changed since, or a commit made on, rewritten or restored since. */
export interface JjOpOverlap {
  key: string
  now: string | null
  why: 'changedSince' | 'descendant' | 'rewrittenSince' | 'restoredSince'
}

/** What reverting one operation would change, read at the single head `at` (never run: Combwork runs no jj write). */
export interface JjOperationPreview {
  /** The operation head H the preview was read at: the command is offered for this moment only. */
  at: string
  op: string
  description: string
  did: JjOpChange[]
  commits: { added: string[]; hidden: string[] }
  later: JjOpOverlap[]
  /**
   * The moment it was read at: the head and Git's state (its refs, HEAD and files), hashed. Copy sends it back, and any
   * change since, a plain Git one included, gives no command (`moved`).
   */
  moment: string
  /** `jj op revert <full id>`, or null with `refused` saying why. */
  command: string | null
  refused: JjOpRefusal | null
  detail?: string
}

/** At most this many operations a page lists. */
export const JJ_OPERATIONS_MAX = 50

/** At most this many commits a history page shows (one more read says it was capped). */
export const JJ_HISTORY_MAX = 200
/** At most this many conflicted commits listed. */
export const JJ_CONFLICTS_MAX = 50
/** At most this much of a diff is shown. */
export const JJ_DIFF_MAX = 512 * 1024

/** A revision a user types for Compare: a bookmark, a change id or a commit id (a prefix of either), nothing else. */
export const jjRevisionInput = (s: string): boolean => /^[A-Za-z0-9._\-/@]{1,200}$/.test(s.trim())

// ---------------------------------------------------------------------------------------------------------------------
// The window for jj cards (HI-2869, J9c).

/** A passed jj card waiting for the user's integration, with its last containment observation for exactly that approval. */
export interface JjWaitingCard {
  card: number
  submission: number
  revision: string
  /** Its change id (jj's), when the submission recorded one. */
  change: string | null
  target: string
  /** The last observation for exactly this approval and target (null: not checked yet), `at` an observation's time. */
  contained: { state: 'notYet' | 'unknown'; why?: string; at: number } | null
  /**
   * HI-2871: the candidate Combwork built for exactly this approval and its rules (null: none yet): ready (its commit and
   * change, built on `expected` with `style`, conflict-free, no merge checks run), none because the repository signs, or
   * why it couldn't be built (after several tries in a row).
   */
  candidate: JjWaitingCandidate | null
}

/**
 * HI-2938: a candidate's merge checks: running (`done` of `names`, `current` the one running), passed (only then is it
 * offered), waiting for a check copy, stopped (Stop: Run Checks Again), or failing transiently (`misses` in a row).
 */
export interface JjWaitingChecks {
  state: 'running' | 'passed' | 'waiting' | 'stopped' | 'failing'
  names: string[]
  done: number
  current?: string
  why?: string
  misses?: number
}

export type JjWaitingCandidate =
  | { state: 'ready'; result: string; change: string; expected: string; style: 'merge' | 'squash' | 'rebase'; updated?: string; checks?: JjWaitingChecks; at: number }
  | { state: 'signing'; at: number }
  | { state: 'unknown'; why: string; at: number }

/** A publish record the user is asked to check (J9b2's checkThis), with what differs. */
export interface JjToCheckRow {
  card: string
  cycle: number
  bundle: string
  target: string
  result: string
  /** What Combwork recorded, and when (the settle's). */
  was: 'published' | 'notHeld'
  remote: string | null
  pushed: string | null
  at: number
  /** The flag's own time (Mark as checked's compare-and-set takes it back). */
  checkAt: number
  differs: { what: 'remote' | 'url' | 'pushed' | 'inRemote' | 'held'; was: string | null; now: string | null }[]
}

/** A leftover an interrupted or lost set-up kept (HI-2887's residue): its path, its registration's name if any, and why. */
export interface JjLeftover {
  path: string
  name?: string
  why: string
}
