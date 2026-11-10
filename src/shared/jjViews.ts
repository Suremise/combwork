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

/** At most this many commits a history page shows (one more read says it was capped). */
export const JJ_HISTORY_MAX = 200
/** At most this many conflicted commits listed. */
export const JJ_CONFLICTS_MAX = 50
/** At most this much of a diff is shown. */
export const JJ_DIFF_MAX = 512 * 1024

/** A revision a user types for Compare: a bookmark, a change id or a commit id (a prefix of either), nothing else. */
export const jjRevisionInput = (s: string): boolean => /^[A-Za-z0-9._\-/@]{1,200}$/.test(s.trim())
