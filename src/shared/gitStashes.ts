// HI-3472: Version Control → Changes' Stashes (SPEC §16.10.2, Stashes): the repository's stashes, each with its message,
// branch, date and files, and Show, Apply, Pop and Drop, the user's click at a time. Combwork's own (Set Aside's,
// HI-2944) are told by the mark its message carries and say which card or target made them.

import type { OperationLent } from './gitOperations'

/** Why Combwork set changes aside, as Set Aside names its stash (queueControls.ts's label): the card or target it names. */
export type CombworkStash = { why: 'merging'; card: string } | { why: 'catchUp'; target: string; card: string } | { why: 'starting'; target: string } | { why: 'other'; text: string }

/** A stash as the list shows it. */
export interface StashRow {
  /** The stash's commit: what every request names (its place in the list moves as others are made or dropped). */
  commit: string
  /** Its place in `git stash list` now (`stash@{index}`). */
  index: number
  /** The branch it was made on (git's "On main:"), or null when git's message names none (a detached HEAD). */
  branch: string | null
  /** Its message, past git's "On <branch>: " (for a stash made with no message: git's "<commit> <subject>"). */
  message: string
  /** When it was made, ms since the epoch. */
  at: number
  /** How many files it holds: its changed files and the untracked ones it keeps. */
  files: number
  /** Set Aside's (HI-2944): why it was made; null for any other stash. */
  combwork: CombworkStash | null
}

/** `git:stashes`' answer: the stashes, and the lease of the Changes root's slot when it is lent (Apply and Pop confirm it first). */
export interface StashList {
  stashes: StashRow[]
  lent: OperationLent | null
}

/** A file a stash holds: its status against the commit it was made on (git's letter), or untracked (kept with -u). */
export interface StashFile {
  path: string
  status: string
  untracked: boolean
}

/** What Apply or Pop asks: the stash the user saw (its commit), whether it is dropped after, the lent slot's lease they confirmed. */
export interface StashRequest {
  commit: string
  pop: boolean
  lease?: string
}

/** What Apply or Pop did: applied cleanly (and for a Pop, dropped), or left these files in conflict, the stash kept. */
export interface StashApplied {
  conflicts: string[]
  dropped: boolean
}

/** HI-3518's hand-off: the stash last applied with conflicts in a folder, while they last (gitStashes.ts stashConflictIn). */
export interface StashConflict {
  commit: string
  /** Its message, as the list shows it. */
  label: string
  /** The HEAD it was applied onto. */
  head: string
}

/** Set Aside's mark (gitFolderChanges.ts settleChanges): `Combwork: set aside <why> [cw:<6 hex>]`. */
const COMBWORK = /^Combwork: set aside (.+) \[cw:[0-9a-f]{6}\]$/
const KEY = '[A-Z][A-Z0-9]*-\\d+'

/** Why Combwork made a stash, from its message; null when it isn't Set Aside's. */
export function combworkStash(message: string): CombworkStash | null {
  const m = COMBWORK.exec(message)
  if (!m) return null
  const why = m[1]
  let x = new RegExp(`^before merging (${KEY})$`).exec(why)
  if (x) return { why: 'merging', card: x[1] } // i18n-ignore: a select's key, never shown
  x = new RegExp(`^before bringing (.+) up to date with (${KEY})$`).exec(why)
  if (x) return { why: 'catchUp', target: x[1], card: x[2] } // i18n-ignore: a select's key, never shown
  x = /^before starting work on (.+)$/.exec(why)
  if (x) return { why: 'starting', target: x[1] } // i18n-ignore: a select's key, never shown
  return { why: 'other', text: why } // i18n-ignore: a select's key, never shown
}

/** A stash's reflog subject split: its branch (git's "On <branch>:" or "WIP on <branch>:") and its message after it. */
export function stashSubject(subject: string): { branch: string | null; message: string } {
  const m = /^(?:WIP on|On) (.+?): (.*)$/s.exec(subject)
  if (!m) return { branch: null, message: subject }
  return { branch: m[1] === '(no branch)' ? null : m[1], message: m[2] }
}

export const isStashCommit = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v)

/** A request as the window sent it, checked; null when it is anything else. */
export function stashRequestOf(raw: unknown): StashRequest | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (!isStashCommit(r.commit) || typeof r.pop !== 'boolean') return null
  return { commit: r.commit, pop: r.pop, ...(typeof r.lease === 'string' && r.lease ? { lease: r.lease } : {}) }
}
