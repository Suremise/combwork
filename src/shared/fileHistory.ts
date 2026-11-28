// HI-3475: the Files tab's History of a file or folder (SPEC §8, A file's history): the commits that changed it on the
// folder's checked-out line, following a file's renames, each with the card it names and the agent that submitted it.
// The parsing here is pure (no git, no board): gitFileHistory.ts runs git, fileHistoryPanel.ts adds the cards.

/** A page of History: this many commits. */
export const FILE_HISTORY_COMMITS = 50

/** How a commit's card was found: its `Combwork-Card` trailer, Combwork's attribution record, or a key starting its subject. */
export type FileCardHow = 'trailer' | 'attributed' | 'subject'

/** A card as History links it. */
export interface FileHistoryCard {
  key: string
  number: number
  title: string
  how: FileCardHow
}

/** One file a commit changed, as git's name-status gives it (`oldPath`: a rename's or copy's path at the parent). */
export interface FileHistoryFile {
  status: string
  path: string
  oldPath: string | null
}

/** One commit of a file's or folder's history. Paths are the repository's (from its top), as git reads them at a commit. */
export interface FileHistoryRow {
  hash: string
  short: string
  /** Its first parent (null: a root commit). */
  parent: string | null
  author: string
  email: string
  /** When it was authored, ms since the epoch. */
  date: number
  subject: string
  /**
   * What it changed of the item. A file's history: one entry, the file at this commit (`oldPath` where this commit
   * renamed it). A folder's: each file under it.
   */
  files: FileHistoryFile[]
  /** The card the commit itself names (never one found through ancestry). */
  card: FileHistoryCard | null
  /**
   * The agent that submitted this commit for review, in a submission of its own card (its id, and its name now; the id
   * when the agent is gone). Not who wrote it: a commit of the user's that an agent submitted says the same.
   */
  submittedBy: { agent: string; name: string } | null
}

/** A page of History, read from one pinned commit. */
export interface FileHistoryPage {
  /** The commit the history was read from (the folder's HEAD when page 1 was read); null: no commits yet. */
  head: string | null
  /** The folder's HEAD is no longer `head`: the list is as it was, and Refresh reads it again. */
  moved: boolean
  rows: FileHistoryRow[]
  page: number
  /** Another page follows. */
  more: boolean
  /** The item's path from the repository's top (the folder shown may be inside it). */
  repoPath: string
  /** Where the folder shown is, from the repository's top (`''`, or `sub/dir/`). */
  prefix: string
}

/** One side of a version diff: a file at a commit, its path from the repository's top. */
export interface FileSide {
  commit: string
  path: string
}

/** What a side was: read, confirmed absent at that commit, or there but not a file (a folder, a submodule). */
export type FileSideState = 'file' | 'missing' | 'notFile'

/** Two versions of a file, each side as `FileSide` named it. A side that isn't a file has '' as its text. */
export interface FileVersions {
  path: string
  original: string
  modified: string
  binary: boolean
  left: FileSideState
  right: FileSideState
}

/** The merge that brought a commit into the line (its card, as the merge names one): "came in with HI-12's merge". */
export interface CommitIntro {
  merge: string
  short: string
  card: FileHistoryCard | null
}

/** A commit as git's log gave it, before its card is found. */
export interface LoggedCommit {
  hash: string
  short: string
  parent: string | null
  author: string
  email: string
  date: number
  subject: string
  /** The values of its `Combwork-Card` trailers, joined with commas. */
  trailer: string
  files: FileHistoryFile[]
}

/** What the reads port's fileLog reads: a page of an item's commits, from the commit pinned (null: none yet). */
export interface FileLog {
  head: string | null
  moved: boolean
  commits: LoggedCommit[]
  more: boolean
  page: number
  repoPath: string
  prefix: string
}

/** The merge that introduced a commit (the reads port's introducedBy), with its message's card fields. */
export interface MergeIntro {
  merge: string
  short: string
  subject: string
  trailer: string
}

/** The format fileLog's git log is given: each commit starts with RS, its fields split by US. */
export const FILE_LOG_FORMAT = '%x1e%H%x1f%P%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%(trailers:key=Combwork-Card,valueonly,separator=%x2C)%x1f'

/** Name-status entries (`-z`): a status, then one path, or two for a rename or copy (old, new). */
export function nameStatusOf(tokens: string[]): FileHistoryFile[] {
  const out: FileHistoryFile[] = []
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++]
    if (!status) continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i++]
      const path = tokens[i++]
      if (oldPath !== undefined && path !== undefined) out.push({ status: letter, path, oldPath })
    } else {
      const path = tokens[i++]
      if (path !== undefined) out.push({ status: letter, path, oldPath: null })
    }
  }
  return out
}

/** `git log -z --name-status --format=<FILE_LOG_FORMAT>`'s output, as commits, newest first. */
export function parseFileLog(out: string): LoggedCommit[] {
  const commits: LoggedCommit[] = []
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue
    const f = chunk.split('\x1f')
    if (f.length < 9) continue
    const [hash, parents, short, author, email, at, subject, trailer] = f
    const rest = f.slice(8).join('\x1f')
    // Neither a status nor a path is ever empty: the empty tokens are the NULs around git's line break.
    const tokens = rest.split('\0').map((t) => t.replace(/^\r?\n/, '')).filter(Boolean)
    commits.push({ hash, short, parent: parents.split(' ').filter(Boolean)[0] ?? null, author, email, date: (Number(at) || 0) * 1000, subject, trailer, files: nameStatusOf(tokens) })
  }
  return commits
}

const KEY = /^([A-Z][A-Z0-9]*-\d+)\b/
const TRAILER_KEY = /^[A-Z][A-Z0-9]*-\d+$/

/** The key a commit's trailer names (its first value), or null. */
export function trailerKey(trailer: string): string | null {
  const t = trailer.split(',')[0]?.trim() ?? ''
  return TRAILER_KEY.test(t) ? t : null
}

/** The key starting a commit's subject ("HI-12: …"), or null: a key anywhere else names some other card. */
export function subjectKey(subject: string): string | null {
  return KEY.exec(subject)?.[1] ?? null
}

/**
 * Whether a path the window sent is one History reads: relative, `/`-separated, inside the folder (no `..`, no drive
 * or leading slash), or '' for the folder itself.
 */
export function historyPathOk(rel: unknown): rel is string {
  if (typeof rel !== 'string') return false
  if (rel === '') return true
  if (rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false
  return !rel.split('/').some((s) => s === '..' || s === '.' || s === '')
}

/** A side the window sent, checked: a full commit id and a repository path; null when it is anything else. */
export function fileSideOf(raw: unknown, isCommit: (v: unknown) => v is string): FileSide | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { commit?: unknown; path?: unknown }
  if (!isCommit(r.commit) || !historyPathOk(r.path) || !r.path) return null
  return { commit: r.commit, path: r.path }
}

/**
 * The merge that introduced `commit` on a first-parent line (newest first, as `git rev-list --first-parent --parents`
 * gives it: each commit with its parents), given which commits contain it (`contains`: `commit` itself and its
 * descendants). The oldest commit of the line that contains it is where it arrived. Only a two-parent merge whose
 * first parent doesn't contain it, and whose second does, introduced it. A commit on the line itself, an octopus, a line
 * that never contains it, or a line read short of where it arrived (`complete` false), has none: nothing is guessed.
 */
export function introducingMerge(commit: string, line: { hash: string; parents: string[] }[], contains: (hash: string) => boolean, complete: boolean): string | null {
  let arrived: { hash: string; parents: string[] } | null = null
  let ended = false
  for (const c of line) {
    if (!contains(c.hash)) {
      ended = true
      break
    }
    arrived = c
  }
  if (!arrived || (!ended && !complete) || arrived.hash === commit || arrived.parents.length !== 2) return null
  return !contains(arrived.parents[0]) && contains(arrived.parents[1]) ? arrived.hash : null
}
