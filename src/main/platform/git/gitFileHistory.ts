// HI-3475: the git reads behind the Files tab's History (SPEC §8, A file's history), through the repository reads port
// (repoReads.ts): a page of the commits that changed a file (following its renames) or a folder, read from one pinned
// commit; a file at two commits, each side at its own path; the merge that introduced a commit on the line; and the
// commits a submission's range holds. Reads only: nothing here writes the repository or its index (GIT_PREFIX).
import { msg } from '../../../shared/i18n'
import { FILE_HISTORY_COMMITS, FILE_LOG_FORMAT, introducingMerge, parseFileLog, type FileLog, type FileSide, type FileSideState, type FileVersions, type MergeIntro } from '../../../shared/fileHistory'
import { isCommitId } from '../../../shared/gitMoves'
import { combworkError } from '../../combworkError'
import { git, gitErrorLine, isBinary, MAX_DIFF_BYTES, tooLargeDiff, type GitResult } from '../../git'

export const FILE_HISTORY_TEXT = {
  failed: msg({ id: 'service.fileHistory.failed', defaultMessage: "Git couldn't read the history: {why}", description: "HI-3475: an error in the Files tab's History panel: git's own command failed; {why} is git's error line, in English." }),
  noCommit: msg({ id: 'service.fileHistory.noCommit', defaultMessage: "Git has no commit {commit}: it may be gone. Refresh the history.", description: "HI-3475: an error in the Files tab's History panel: a commit the panel showed ({commit}, a short id) isn't in the repository any more." })
}
const M = FILE_HISTORY_TEXT

const refused = (r: GitResult): Error => combworkError(M.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })

/** The folder's HEAD commit, or null with no commits yet. */
async function headOf(root: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  return r.ok ? r.out.trim() || null : null
}

/** Whether `commit` (a full id) is a commit here. */
async function isCommit(root: string, commit: string): Promise<boolean> {
  return (await git(root, ['cat-file', '-e', `${commit}^{commit}`])).ok
}

/** Where the folder is inside its repository, from the top (`''` or `sub/dir/`). */
async function prefixOf(root: string): Promise<string> {
  const r = await git(root, ['rev-parse', '--show-prefix'])
  if (!r.ok) throw refused(r)
  return r.out.trim()
}

/**
 * A page of the commits that changed `rel` (relative to the folder, `''` the folder itself), newest first, from the
 * commit pinned on page 1: a file's history follows its renames (`--follow`), a folder's is every commit changing a
 * file under it. Each commit's files are what it changed of the item (a rename with the path it had before).
 */
export async function fileLog(root: string, rel: string, isDir: boolean, pinned: string | null, pageRaw: number): Promise<FileLog> {
  const prefix = await prefixOf(root)
  const repoPath = `${prefix}${rel}`.replace(/\/$/, '')
  const now = await headOf(root)
  const page = Math.max(1, Math.floor(pageRaw) || 1)
  const from = pinned && isCommitId(pinned) && (await isCommit(root, pinned)) ? pinned : now
  if (!from) return { head: null, moved: false, commits: [], more: false, page: 1, repoPath, prefix }
  const r = await git(root, ['--literal-pathspecs', 'log', ...(isDir ? [] : ['--follow']), '-M', '--name-status', '-z', `--format=${FILE_LOG_FORMAT}`, '-n', String(FILE_HISTORY_COMMITS + 1), '--skip', String((page - 1) * FILE_HISTORY_COMMITS), from, '--', rel || '.'])
  if (!r.ok) throw refused(r)
  const all = parseFileLog(r.out)
  return { head: from, moved: !!now && now !== from, commits: all.slice(0, FILE_HISTORY_COMMITS), more: all.length > FILE_HISTORY_COMMITS, page, repoPath, prefix }
}

/** The path entry at a commit (from the repository's top): a file's blob and size, something else, or nothing there. */
async function entryAt(root: string, side: FileSide): Promise<{ state: 'file'; oid: string; size: number } | { state: Exclude<FileSideState, 'file'> }> {
  const r = await git(root, ['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', '-l', side.commit, '--', side.path])
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
async function sideOf(root: string, side: FileSide | null): Promise<{ state: FileSideState; buf: Buffer; size: number }> {
  if (!side) return { state: 'missing', buf: Buffer.alloc(0), size: 0 }
  if (!(await isCommit(root, side.commit))) throw combworkError(M.noCommit, { commit: side.commit.slice(0, 7) }, { kind: 'notFound' })
  const e = await entryAt(root, side)
  if (e.state !== 'file') return { state: e.state, buf: Buffer.alloc(0), size: 0 }
  if (e.size > MAX_DIFF_BYTES) return { state: 'file', buf: Buffer.alloc(0), size: e.size }
  const r = await git(root, ['cat-file', 'blob', e.oid], MAX_DIFF_BYTES * 2)
  if (!r.ok) throw refused(r)
  return { state: 'file', buf: r.buf, size: r.buf.length }
}

/**
 * A file at two commits, each side at its own path (a rename's old path on the left): a side not given, or confirmed
 * not there at its commit, is `missing`; a git that fails is an error, never an empty side.
 */
export async function fileVersions(root: string, left: FileSide | null, right: FileSide | null): Promise<FileVersions> {
  const [l, r] = await Promise.all([sideOf(root, left), sideOf(root, right)])
  const path = right?.path ?? left?.path ?? ''
  const big = Math.max(l.size, r.size)
  if (big > MAX_DIFF_BYTES) return { ...tooLargeDiff(path, big), left: l.state, right: r.state }
  if (isBinary(l.buf) || isBinary(r.buf)) return { path, original: '', modified: '', binary: true, left: l.state, right: r.state }
  return { path, original: l.buf.toString('utf8'), modified: r.buf.toString('utf8'), binary: false, left: l.state, right: r.state }
}

/** The merge that introduced `commit` on `head`'s first-parent line, with its message's card fields; null with none found. */
export async function introducedBy(root: string, head: string, commit: string): Promise<MergeIntro | null> {
  if (!(await isCommit(root, commit)) || !(await isCommit(root, head))) throw combworkError(M.noCommit, { commit: commit.slice(0, 7) }, { kind: 'notFound' })
  if (!(await git(root, ['merge-base', '--is-ancestor', commit, head])).ok) return null
  const d = await git(root, ['rev-list', '--ancestry-path', `${commit}..${head}`])
  if (!d.ok) throw refused(d)
  const descendants = new Set(d.out.split(/\r?\n/).filter(Boolean))
  const want = descendants.size + 2
  const l = await git(root, ['rev-list', '--first-parent', '--parents', '-n', String(want), head])
  if (!l.ok) throw refused(l)
  const line = l.out.split(/\r?\n/).filter(Boolean).map((row) => {
    const [hash, ...parents] = row.split(' ')
    return { hash, parents }
  })
  const merge = introducingMerge(commit, line, (h) => h === commit || descendants.has(h), line.length < want)
  if (!merge) return null
  const s = await git(root, ['show', '-s', '--format=%h%x1f%s%x1f%(trailers:key=Combwork-Card,valueonly,separator=%x2C)', merge, '--'])
  if (!s.ok) throw refused(s)
  const [short, subject, trailer] = s.out.replace(/\r?\n$/, '').split('\x1f')
  return { merge, short: short ?? merge.slice(0, 7), subject: subject ?? '', trailer: trailer ?? '' }
}

/** Each range's commits, by folder and endpoints: a range of two commits never changes, so it is read once. */
const ranges = new Map<string, Set<string>>()
const RANGES_KEPT = 200

/** The commits in `base..revision` (in the revision and not its base): a submission's own. */
export async function rangeCommits(root: string, base: string, revision: string): Promise<Set<string>> {
  const key = `${root.toLowerCase()}\n${base}\n${revision}`
  const kept = ranges.get(key)
  if (kept) return kept
  const r = await git(root, ['rev-list', `${base}..${revision}`, '--'])
  if (!r.ok) throw refused(r)
  const got = new Set(r.out.split(/\r?\n/).filter(Boolean))
  if (ranges.size >= RANGES_KEPT) ranges.delete(ranges.keys().next().value!)
  ranges.set(key, got)
  return got
}
