// HI-3475: the git reads behind the Files tab's History (SPEC §8, A file's history), through the repository reads port
// (repoReads.ts): a page of the commits that changed a file (following its renames) or a folder, read from one pinned
// commit; a file at two commits, each side at its own path; the merge that introduced a commit on the line; and the
// commits a submission's range holds. Reads only: nothing here writes the repository or its index (GIT_PREFIX).
//
// Each read is bounded (round 1's finding 2): a deadline, `at` (ms since the epoch; the caller's, so one page's git and
// attribution reads share it, else now plus Settings → Advanced's `cw.git.historySeconds`), and each git it runs is
// given what is left of it as its timeout, which ends that git. One run past it, or none left to start one, is refused
// with the history's own timed-out error, never an empty answer.
import { msg } from '../../../shared/i18n'
import { FILE_HISTORY_COMMITS, FILE_LOG_FORMAT, introducingMerge, parseFileLog, type FileLog, type FileSide, type FileSideState, type FileVersions, type MergeIntro } from '../../../shared/fileHistory'
import { combworkError } from '../../combworkError'
import { git, gitErrorLine, isBinary, MAX_DIFF_BYTES, tooLargeDiff, type GitResult } from '../../git'
import { createLogger, userText } from '../../logger'
import { platformLimits } from '../limits'

const log = createLogger('file-history')

export const FILE_HISTORY_TEXT = {
  failed: msg({ id: 'service.fileHistory.failed', defaultMessage: "Git couldn't read the history: {why}", description: "HI-3475: an error in the Files tab's History panel: git's own command failed; {why} is git's error line, in English." }),
  noCommit: msg({ id: 'service.fileHistory.noCommit', defaultMessage: "Git has no commit {commit}: it may be gone. Refresh the history.", description: "HI-3475: an error in the Files tab's History panel: a commit the panel showed ({commit}, a short id) isn't in the repository any more." }),
  cancelled: msg({ id: 'service.fileHistory.cancelled', defaultMessage: 'Stopped: the file or its text changed meanwhile.', description: "HI-3476: why a blame of a file in the Files tab stopped: the file shown, or its text in the editor, changed, so its answer was no longer wanted (the window drops it; rarely seen)." }),
  timedOut: msg({ id: 'service.fileHistory.timedOut', defaultMessage: 'Git was still reading the history after {seconds, number} seconds, so Combwork stopped it. Try again, or raise Settings → Advanced → Git: longest a history read takes.', description: "HI-3475: an error in the Files tab's History panel: reading a page of history, a commit's diff or its merge ran past the advanced setting's time ({seconds}) and git was ended. Keep the setting's name as Settings → Advanced shows it." })
}
const M = FILE_HISTORY_TEXT

const refused = (r: GitResult): Error => combworkError(M.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })

/** A read's deadline: now plus Settings → Advanced's `cw.git.historySeconds`. */
export const historyDeadline = (): number => Date.now() + platformLimits.gitHistoryMs()

const timedOut = (): Error => combworkError(M.timedOut, { seconds: Math.max(1, Math.round(platformLimits.gitHistoryMs() / 1000)) })

/** Runs git with what is left of `at` as its timeout: refused, git ended, once it has run out. */
export async function run(root: string, args: string[], at: number, maxBuffer?: number, o: { input?: string; signal?: AbortSignal } = {}): Promise<GitResult> {
  const left = at - Date.now()
  if (left <= 0) throw timedOut()
  const r = await git(root, args, maxBuffer, o.input, { timeout: left, ...(o.signal ? { signal: o.signal } : {}) })
  // HI-3476: stopped by its caller (blame of a text the editor has moved on from): its answer is no one's.
  if (r.cancelled) throw combworkError(M.cancelled)
  if (r.timedOut) {
    log.warn(`git ${args.find((a) => !a.startsWith('-'))} for History in ${userText(root)} ran past its bound and was ended`)
    throw timedOut()
  }
  return r
}

/** The folder's HEAD commit, or null with no commits yet. */
async function headOf(root: string, at: number): Promise<string | null> {
  const r = await run(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], at)
  return r.ok ? r.out.trim() || null : null
}

/** Whether `commit` (a full id) is a commit here. */
async function isCommit(root: string, commit: string, at: number): Promise<boolean> {
  return (await run(root, ['cat-file', '-e', `${commit}^{commit}`], at)).ok
}

/** Where the folder is inside its repository, from the top (`''` or `sub/dir/`). */
async function prefixOf(root: string, at: number): Promise<string> {
  const r = await run(root, ['rev-parse', '--show-prefix'], at)
  if (!r.ok) throw refused(r)
  return r.out.trim()
}

/**
 * A page of the commits that changed `rel` (relative to the folder, `''` the folder itself), newest first, from the
 * commit pinned on page 1: a file's history follows its renames (`--follow`), a folder's is every commit changing a
 * file under it. Each commit's files are what it changed of the item (a rename with the path it had before). Only page
 * 1's read (`pinned` null) takes the folder's HEAD; a pin that is no longer a commit here is refused (round 1's finding
 * 1), so a later page is never read from another commit than the pages before it.
 */
export async function fileLog(root: string, rel: string, isDir: boolean, pinned: string | null, pageRaw: number, at = historyDeadline()): Promise<FileLog> {
  const prefix = await prefixOf(root, at)
  const repoPath = `${prefix}${rel}`.replace(/\/$/, '')
  const now = await headOf(root, at)
  const page = Math.max(1, Math.floor(pageRaw) || 1)
  if (pinned && !(await isCommit(root, pinned, at))) throw combworkError(M.noCommit, { commit: pinned.slice(0, 7) }, { kind: 'notFound' })
  const from = pinned ?? now
  if (!from) return { head: null, moved: false, commits: [], more: false, page: 1, repoPath, prefix }
  const r = await run(root, ['--literal-pathspecs', 'log', ...(isDir ? [] : ['--follow']), '-M', '--name-status', '-z', `--format=${FILE_LOG_FORMAT}`, '-n', String(FILE_HISTORY_COMMITS + 1), '--skip', String((page - 1) * FILE_HISTORY_COMMITS), from, '--', rel || '.'], at)
  if (!r.ok) throw refused(r)
  const all = parseFileLog(r.out)
  return { head: from, moved: !!now && now !== from, commits: all.slice(0, FILE_HISTORY_COMMITS), more: all.length > FILE_HISTORY_COMMITS, page, repoPath, prefix }
}

/** The path entry at a commit (from the repository's top): a file's blob and size, something else, or nothing there. */
async function entryAt(root: string, side: FileSide, at: number): Promise<{ state: 'file'; oid: string; size: number } | { state: Exclude<FileSideState, 'file'> }> {
  const r = await run(root, ['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', '-l', side.commit, '--', side.path], at)
  if (!r.ok) throw refused(r)
  for (const row of r.out.split('\0')) {
    const tab = row.indexOf('\t')
    if (tab < 0 || row.slice(tab + 1) !== side.path) continue
    const [mode, type, oid, size] = row.slice(0, tab).split(/\s+/)
    if (type !== 'blob' || mode === '160000') return { state: 'notFile' }
    return { state: 'file', oid, size: Number(size) || 0 }
  }
  return { state: 'missing' }
}

/** One side's text: '' for a side that isn't there or isn't a file; refused for a commit that isn't one here. */
async function sideOf(root: string, side: FileSide | null, at: number): Promise<{ state: FileSideState; buf: Buffer; size: number }> {
  if (!side) return { state: 'missing', buf: Buffer.alloc(0), size: 0 }
  if (!(await isCommit(root, side.commit, at))) throw combworkError(M.noCommit, { commit: side.commit.slice(0, 7) }, { kind: 'notFound' })
  const e = await entryAt(root, side, at)
  if (e.state !== 'file') return { state: e.state, buf: Buffer.alloc(0), size: 0 }
  if (e.size > MAX_DIFF_BYTES) return { state: 'file', buf: Buffer.alloc(0), size: e.size }
  const r = await run(root, ['cat-file', 'blob', e.oid], at, MAX_DIFF_BYTES * 2)
  if (!r.ok) throw refused(r)
  return { state: 'file', buf: r.buf, size: r.buf.length }
}

/**
 * A file at two commits, each side at its own path (a rename's old path on the left): a side not given, or confirmed
 * not there at its commit, is `missing`; a git that fails is an error, never an empty side.
 */
export async function fileVersions(root: string, left: FileSide | null, right: FileSide | null, at = historyDeadline()): Promise<FileVersions> {
  const [l, r] = await Promise.all([sideOf(root, left, at), sideOf(root, right, at)])
  const path = right?.path ?? left?.path ?? ''
  const big = Math.max(l.size, r.size)
  if (big > MAX_DIFF_BYTES) return { ...tooLargeDiff(path, big), left: l.state, right: r.state }
  if (isBinary(l.buf) || isBinary(r.buf)) return { path, original: '', modified: '', binary: true, left: l.state, right: r.state }
  return { path, original: l.buf.toString('utf8'), modified: r.buf.toString('utf8'), binary: false, left: l.state, right: r.state }
}

/** The merge that introduced `commit` on `head`'s first-parent line, with its message's card fields; null with none found. */
export async function introducedBy(root: string, head: string, commit: string, at = historyDeadline()): Promise<MergeIntro | null> {
  if (!(await isCommit(root, commit, at)) || !(await isCommit(root, head, at))) throw combworkError(M.noCommit, { commit: commit.slice(0, 7) }, { kind: 'notFound' })
  if (!(await run(root, ['merge-base', '--is-ancestor', commit, head], at)).ok) return null
  const d = await run(root, ['rev-list', '--ancestry-path', `${commit}..${head}`], at)
  if (!d.ok) throw refused(d)
  const descendants = new Set(d.out.split(/\r?\n/).filter(Boolean))
  const want = descendants.size + 2
  const l = await run(root, ['rev-list', '--first-parent', '--parents', '-n', String(want), head], at)
  if (!l.ok) throw refused(l)
  const line = l.out.split(/\r?\n/).filter(Boolean).map((row) => {
    const [hash, ...parents] = row.split(' ')
    return { hash, parents }
  })
  const merge = introducingMerge(commit, line, (h) => h === commit || descendants.has(h), line.length < want)
  if (!merge) return null
  const s = await run(root, ['show', '-s', '--format=%h%x1f%s%x1f%(trailers:key=Combwork-Card,valueonly,separator=%x2C)', merge, '--'], at)
  if (!s.ok) throw refused(s)
  const [short, subject, trailer] = s.out.replace(/\r?\n$/, '').split('\x1f')
  return { merge, short: short ?? merge.slice(0, 7), subject: subject ?? '', trailer: trailer ?? '' }
}

/** Each range's commits, by folder and endpoints: a range of two commits never changes, so it is read once. */
const ranges = new Map<string, Set<string>>()
const RANGES_KEPT = 200

/**
 * The commits in `base..revision` (in the revision and not its base): a submission's own. Null when git can't read the
 * range (its commits gone from this repository): it says nothing of a commit. Refused once `at` has run out, or once
 * `signal` stops it (HR1's HI-3476 finding 4: its blame was stopped), its git ended.
 */
export async function rangeCommits(root: string, base: string, revision: string, at = historyDeadline(), signal?: AbortSignal): Promise<Set<string> | null> {
  const key = `${root.toLowerCase()}\n${base}\n${revision}`
  const kept = ranges.get(key)
  if (kept) return kept
  const r = await run(root, ['rev-list', `${base}..${revision}`, '--'], at, undefined, { signal })
  if (!r.ok) return null
  const got = new Set(r.out.split(/\r?\n/).filter(Boolean))
  if (ranges.size >= RANGES_KEPT) ranges.delete(ranges.keys().next().value!)
  ranges.set(key, got)
  return got
}
