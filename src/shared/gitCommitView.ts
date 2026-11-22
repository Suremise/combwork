// HI-3471: History's Commit dialog (SPEC §16.10.2, A commit's details): one commit's details, files and diffs, and
// Revert… and Cherry-pick… onto the branch the project folder has checked out, the user's click at a time.

import { isCommitId } from './gitMoves'

/** A file a commit changes against its first parent (git's status letter), or every file of a root commit. */
export interface CommitFile {
  path: string
  status: string
}

/** `git:commitDetail`'s answer: a commit as the dialog shows it, and whether each action can be done now. */
export interface CommitDetail {
  hash: string
  short: string
  author: string
  email: string
  /** When it was committed, ms since the epoch. */
  date: number
  subject: string
  /** Its whole message. */
  message: string
  parents: string[]
  /** The card it names: its Combwork-Card trailer, else a key at the start of its subject; null with none. */
  card: string | null
  files: CommitFile[]
  /** The branch the project folder has checked out (null: a detached HEAD), and its commit: what an action names. */
  branch: string | null
  head: string | null
  /** Why Revert… or Cherry-pick… can't be done now, in the window's words; null when it can. */
  revert: string | null
  cherryPick: string | null
}

export type CommitAction = 'revert' | 'cherryPick'

/** What Revert… or Cherry-pick… asks: the commit, and the branch and its commit the user saw. */
export interface CommitActionRequest {
  action: CommitAction
  commit: string
  branch: string
  head: string
}

/** What it did: committed (`made`, the new commit), or stopped on a conflict, git left mid-operation (`conflicts`). */
export interface CommitActionDone {
  made: string | null
  conflicts: string[]
  notice: string
}

/** A request as the window sent it, checked; null when it is anything else. */
export function commitActionOf(raw: unknown): CommitActionRequest | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if ((r.action !== 'revert' && r.action !== 'cherryPick') || !isCommitId(r.commit) || typeof r.branch !== 'string' || !r.branch || !isCommitId(r.head)) return null
  return { action: r.action, commit: r.commit, branch: r.branch, head: r.head }
}

const KEY = /^([A-Z][A-Z0-9]*-\d+)\b/

/** The card a commit names: its Combwork-Card trailer, else a key at the start of its subject ("HI-12: …"); null with none. */
export function commitCard(trailer: string, subject: string): string | null {
  const t = trailer.split(',')[0]?.trim() ?? ''
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(t)) return t
  return KEY.exec(subject)?.[1] ?? null
}
