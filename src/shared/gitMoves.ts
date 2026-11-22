// HI-3469: Version Control → History's Moves (SPEC §16.10.2, Moves): a local branch's moves as git's reflog keeps them,
// each in plain words where Combwork knows them, and Restore to here…, the user's click at a time, never an agent's tool.

/** Moves a page, as History's commits. */
export const MOVES_PAGE = 20
/** The commits Restore's dialog lists of those it drops and of those it brings back, each. */
export const RESTORE_LISTED = 20

/**
 * What a move was, from git's reflog message: a commit (`initial`, `amend`, `mergeCommit` too), a merge or fast-forward
 * of `name`, a pull, a rebase onto `name`, a reset to `name`, the branch made from `name` or renamed from it, a pick or
 * a revert; Combwork's merge of the card `name` (the queue moves its target with no message: told by the new commit's
 * trailer), a restore from `name` (this view's own), Combwork's other moves (`name`: its words); a move with no message
 * (`unnamed`), or any other (`name`: git's message as it is).
 */
export type MoveKind = 'commit' | 'initial' | 'amend' | 'mergeCommit' | 'fastForward' | 'merge' | 'pull' | 'rebase' | 'reset' | 'created' | 'renamed' | 'cherryPick' | 'revert' | 'combworkMerge' | 'restored' | 'combwork' | 'unnamed' | 'other'

/** One move of a branch, newest first. */
export interface MoveRow {
  /** Its place in the reflog now (`<branch>@{index}`; 0: where the branch is). */
  index: number
  /** When the branch moved, ms since the epoch. */
  at: number
  /** The commit it left the branch at, whole, short, and its subject. */
  commit: string
  short: string
  subject: string
  kind: MoveKind
  /** What the kind names (a branch, a commit, a card's key, words), or ''. */
  name: string
  /** Git's own message, as it is (the row's tooltip). */
  message: string
}

/** `git:moves`' answer: a page of a local branch's moves, and what the picker offers. */
export interface BranchMoves {
  /** The branch shown, by name; null when the repository has no local branch. */
  branch: string | null
  /** The project folder is on a detached HEAD: no moves are shown until it is on a branch (the agreed design, r11). */
  detached: boolean
  /** Its commit now (what a restore names as `from`). */
  head: string | null
  /** Local branches, by name. */
  branches: string[]
  /** The project's target, when it is a local branch; the branch the project folder has checked out. */
  target: string | null
  folderBranch: string | null
  moves: MoveRow[]
  page: number
  pages: number
  total: number
}

/** A commit as Restore's dialog lists it. */
export interface CommitLine {
  hash: string
  short: string
  subject: string
}

/** `git:restorePlan`'s answer: what Restore to here… would do to `branch` now, for its dialog; checked again when it runs. */
export interface RestorePlan {
  branch: string
  /** The branch's commit now, and the commit it would be moved to. */
  from: string
  to: string
  /** The commits it drops (in `from`, not in `to`) and brings back (in `to`, not in `from`), the first RESTORE_LISTED each, and how many more. */
  dropped: CommitLine[]
  droppedMore: number
  back: CommitLine[]
  backMore: number
  /** Where it runs: in the project folder (git reset --keep), or nowhere checked out (the branch alone moved). */
  where: 'project' | 'nowhere'
  /** Uncommitted files of the project folder the move would change: git refuses while there are any. */
  inTheWay: string[]
  /** The branch's upstream, and how many of the dropped commits it has (a later Push is refused for them). */
  upstream: string | null
  pushedDropped: number
  /** Why it can't be done now, in the window's words; null when it can. */
  blocked: string | null
}

/** What Restore asks: the branch, its commit the user saw, and the commit to move it to. */
export interface RestoreRequest {
  branch: string
  from: string
  to: string
}

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
export const isCommitId = (v: unknown): v is string => typeof v === 'string' && COMMIT.test(v)

/** A request as the window sent it, checked; null when it is anything else. */
export function restoreRequestOf(raw: unknown): RestoreRequest | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.branch !== 'string' || !r.branch || !isCommitId(r.from) || !isCommitId(r.to)) return null
  return { branch: r.branch, from: r.from, to: r.to }
}

/** The reflog message a restore writes (`update-ref -m`), and reset's (`GIT_REFLOG_ACTION`, git adds ": updating HEAD"). */
export const restoreMessage = (from: string): string => `Combwork: restore from ${from.slice(0, 12)}` // i18n-ignore: a reflog message, git's

const KEY = /^[A-Z][A-Z0-9]*-\d+$/

/**
 * What a move was, from git's reflog message (git writes these in English, whatever its language) and, for a move with
 * none, the `Combwork-Card` trailer of the commit it left the branch at (the merge queue's moves of its target).
 */
export function moveOf(message: string, card: string): { kind: MoveKind; name: string } {
  const m = message.trim()
  let x: RegExpExecArray | null
  if (!m) return KEY.test(card) ? { kind: 'combworkMerge', name: card } : { kind: 'unnamed', name: '' }
  if ((x = /^commit( \((initial|amend|merge)\))?: /.exec(m))) return { kind: x[2] === 'initial' ? 'initial' : x[2] === 'amend' ? 'amend' : x[2] === 'merge' ? 'mergeCommit' : 'commit', name: '' }
  if ((x = /^merge (.+?): Fast-forward/.exec(m))) return { kind: 'fastForward', name: x[1] }
  if ((x = /^merge (.+?): /.exec(m))) return { kind: 'merge', name: x[1] }
  if (/^pull\b/.test(m)) return { kind: 'pull', name: '' }
  if ((x = /^rebase\b.*\(finish\): .* onto ([0-9a-f]+)/.exec(m))) return { kind: 'rebase', name: x[1].slice(0, 7) }
  if ((x = /^reset: moving to (.+)$/.exec(m))) return { kind: 'reset', name: COMMIT.test(x[1]) ? x[1].slice(0, 7) : x[1] }
  if ((x = /^branch: Created from (.+)$/.exec(m))) return { kind: 'created', name: x[1] }
  if ((x = /^Branch: renamed refs\/heads\/(.+) to refs\/heads\//.exec(m))) return { kind: 'renamed', name: x[1] }
  if (/^cherry-pick\b/.test(m)) return { kind: 'cherryPick', name: '' }
  if (/^revert\b/.test(m)) return { kind: 'revert', name: '' }
  if ((x = /^Combwork: restore from ([0-9a-f]+)/.exec(m))) return { kind: 'restored', name: x[1].slice(0, 7) }
  if ((x = /^combwork: (.+)$/i.exec(m))) return { kind: 'combwork', name: x[1] }
  return { kind: 'other', name: m }
}
