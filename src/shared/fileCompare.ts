// HI-3478: Compare with… in the Files tab's viewer (SPEC §8, Compare a file): the file as the editor has it against its
// version on the target branch, any branch, tag or commit, or (in a slot or worktree) the project folder's copy. The
// version's side is read in main (fileComparePanel.ts); the editor's side is its live text, never read from disk.

import type { FileSideState } from './fileHistory'

/** What Compare with… offers to compare against. */
export interface CompareChoices {
  /** The branch the folder's work merges into (a slot's card's target, else the project's), with its commit; null with none. */
  target: { name: string; commit: string } | null
  /** Local branches and tags, the most recently changed first (at most COMPARE_REFS of each). */
  branches: { name: string; commit: string }[]
  tags: { name: string; commit: string }[]
  /** The folder shown is a slot or worktree: the project folder, whose copy of the file can be compared; null otherwise. */
  projectFolder: string | null
}

/** How many branches and tags Compare with… lists (a name typed reaches any other). */
export const COMPARE_REFS = 100

/** How the file's path at the version was found. */
export type ComparePath =
  /** The same path, or the one asked for (History's row). */
  | 'same'
  /** A rename on either side of the merge base: `path` is the version's. */
  | 'renamed'
  /** No path maps to the version (deleted there, or never there under a name git could follow). */
  | 'none'

/** `files:compareWith`'s answer: the version's side. */
export interface CompareVersion {
  /** What was asked for, as typed or chosen, and the commit it named when read. */
  ref: string
  commit: string
  short: string
  /** The file's path at that commit, from the repository's top (null with none). */
  path: string | null
  how: ComparePath
  /** Its text ('' when it isn't a file there, or too large or binary). */
  text: string
  state: FileSideState
  /** Binary, or over the diff size limit: not shown as text. */
  binary: boolean
}

/**
 * `files:compareProject`'s answer (HR1's round 1 finding): the project folder's copy of a slot's file. Only a copy
 * confirmed absent is `missing`; one that is there but not text (binary, too large, not UTF-8) says which, with no text;
 * a read that fails otherwise is an error, never an empty side.
 */
export type ProjectCopy = { state: 'text'; text: string } | { state: 'missing' } | { state: 'notFile' } | { state: 'notText'; kind: 'binary' | 'too-large' | 'not-utf8' }

/** Whether a ref the user typed or chose may be resolved: a name or hash, never an option or a revision expression's range. */
export function compareRefOk(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 256 && !ref.startsWith('-') && !/[\s\0~^:?*[\\]|\.\.|@\{/.test(ref)
}

/**
 * The path a file had at the merge base, walking back from its path now through the renames `git log --follow
 * --name-status` gave (newest first): each rename whose new path is the one followed takes its old path.
 */
export function pathBefore(path: string, renames: { path: string; oldPath: string | null; status: string }[][]): string {
  let p = path
  for (const files of renames) {
    const r = files.find((f) => f.status === 'R' && f.path === p && f.oldPath)
    if (r) p = r.oldPath!
  }
  return p
}

/**
 * The path a file at the merge base has at the version, from `git diff -M --name-status --diff-filter=DR base version`'s
 * entries: renamed to its new path, deleted (null), or unchanged.
 */
export function pathAfter(path: string, changes: { path: string; oldPath: string | null; status: string }[]): { path: string | null; renamed: boolean } {
  const c = changes.find((f) => (f.status === 'R' ? f.oldPath === path : f.path === path))
  if (!c) return { path, renamed: false }
  if (c.status === 'D') return { path: null, renamed: false }
  return { path: c.path, renamed: true }
}
