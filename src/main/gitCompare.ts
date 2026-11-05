import { COMPARE_COMMITS, COMPARE_FILES, type CompareFile, type CompareLines, type GitCommitRow, type GitComparison } from '../shared/gitRepo'
import type { GitDiff } from '../shared/types'
import { resolve as resolvePath } from 'path'
import { msg } from '../shared/i18n'
import { failure as commandFailed, git, isBinary, MAX_DIFF_BYTES, tooLargeDiff } from './git'
import { gitProblem } from './gitTool'
import { combworkError } from './combworkError'
import * as G from './platform/git'
import { isUnknown } from './platform/types'

/**
 * The Changes tab's comparison of two branches (HI-1824): any two local branches, such as an integration line and main,
 * with no folder of their own needed. Read-only: every command here only reads refs and objects (for-each-ref, rev-list,
 * merge-base, diff of two commits, cat-file, show), runs in git's worker (HI-1783) through git(), and never touches a
 * working tree or the index. Branches are named whole (refs/heads/x) and only when they are listed, so a name is never
 * taken as an option or as another kind of revision.
 */

const M = {
  noBranch: msg({ id: 'service.gitCompare.noBranch', defaultMessage: "There's no branch {branch} here any more.", description: 'An error comparing two branches in the Changes tab: the branch {branch} was deleted or renamed since the list was read.' })
}

/** The local branches, by name, with the folder each is checked out in. */
async function localBranches(root: string): Promise<{ name: string; folder: string | null }[]> {
  const r = await git(root, ['for-each-ref', '--format=%(refname)%00%(worktreepath)', 'refs/heads'])
  if (!r.ok) throw commandFailed('git for-each-ref', r) // i18n-ignore: a git command, as it is
  return r.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('\0'))
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, folder]) => ({ name: ref.slice('refs/heads/'.length), folder: folder || null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

/** A slot as the board records it: its folder, and its open lease's card and agent (null when it is free). */
export interface SlotRecord {
  name: string
  folder: string
  card: number | null
  agent: string | null
  target: string | null
}

const folderKey = (p: string): string => resolvePath(p).toLowerCase()

/**
 * What can be compared: the local branches, main, the project's integration line (`workTarget`, its G7), and each of
 * `slots` (the board's records, read by the caller without making the slot pool) whose folder has a branch checked out.
 */
export async function compareLines(root: string, workTarget: string | null, slots: readonly SlotRecord[] = []): Promise<CompareLines> {
  const none: CompareLines = { isRepo: false, branches: [], main: null, integration: null, slots: [] }
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) {
    const problem = gitProblem()
    if (problem) return { ...none, gitProblem: problem }
    if (/not a git repository/i.test(inside.err)) return none
    throw commandFailed('git rev-parse', inside) // i18n-ignore: a git command, as it is
  }
  const branches = await localBranches(root)
  const has = (b: string | null): b is string => !!b && branches.some((x) => x.name === b)
  const d = await G.defaultBranch(root)
  const main = !isUnknown(d) && has(d) ? d : null
  const integration = has(workTarget) && workTarget !== main ? workTarget : null
  const byFolder = new Map(branches.filter((b) => b.folder).map((b) => [folderKey(b.folder!), b.name]))
  const listed = slots.flatMap((s) => {
    const branch = byFolder.get(folderKey(s.folder))
    return branch ? [{ ...s, branch }] : []
  })
  return { isRepo: true, branches, main, integration, slots: listed }
}

/** A listed branch's tip, read through its whole name; refused when there's no such branch (deleted or renamed since the list). */
async function branchTip(root: string, name: string): Promise<string> {
  const listed = (await localBranches(root)).some((b) => b.name === name)
  if (!listed) throw combworkError(M.noBranch, { branch: name })
  const r = await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${name}^{commit}`])
  if (r.ok) return r.out.trim()
  if (r.code === 1) throw combworkError(M.noBranch, { branch: name })
  throw commandFailed('git rev-parse', r) // i18n-ignore: a git command, as it is
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** A commit id the window was given by a comparison, checked to be one here; null when it isn't (a stale or made-up id). */
async function pinnedCommit(root: string, id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !SHA.test(id)) return null
  const r = await git(root, ['rev-parse', '--verify', '-q', `${id}^{commit}`])
  return r.ok ? r.out.trim() : null
}

const FORMAT = '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%D%x00%s%x1e'

function commitRows(out: string): GitCommitRow[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const f = r.split('\0')
      return { hash: f[0], short: f[1], author: f[2], email: f[3], date: Number(f[4]) * 1000, refs: f[5] ? f[5].split(', ').filter(Boolean) : [], subject: f[6] ?? '' }
    })
}

/** Where head left base, or null when they share no history. */
async function mergeBaseOf(root: string, base: string, head: string): Promise<string | null> {
  const r = await git(root, ['merge-base', base, head])
  if (r.ok) return r.out.trim()
  if (r.code === 1 && !r.err) return null
  throw commandFailed('git merge-base', r) // i18n-ignore: a git command, as it is
}

/**
 * Head compared with base: how many commits each has that the other hasn't, a page of each side's (newest first), and
 * the files head changes since it left base (three dots, as a card's changes are shown), names only: a file's diff is
 * read when it is opened (compareDiff).
 */
export async function compareBranches(root: string, baseName: string, headName: string, page = 1, pinned?: { base?: unknown; head?: unknown } | null): Promise<GitComparison> {
  // Each branch read once, as a commit: everything below is of those two commits, even if a branch moves meanwhile.
  // Another page of the same comparison names its commits (`pinned`), so its pages never mix two states of a branch.
  const [pb, ph] = await Promise.all([pinnedCommit(root, pinned?.base), pinnedCommit(root, pinned?.head)])
  const [base, head] = pb && ph ? [pb, ph] : await Promise.all([branchTip(root, baseName), branchTip(root, headName)])
  const counts = await git(root, ['rev-list', '--left-right', '--count', `${base}...${head}`, '--'])
  if (!counts.ok) throw commandFailed('git rev-list', counts) // i18n-ignore: a git command, as it is
  const [behind, ahead] = counts.out.trim().split(/\s+/).map((n) => Number(n) || 0)
  const pages = Math.max(1, Math.ceil(Math.max(ahead, behind) / COMPARE_COMMITS))
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)))
  const skip = String((p - 1) * COMPARE_COMMITS)
  const side = (which: string): Promise<GitCommitRow[]> =>
    git(root, ['log', '--no-show-signature', '-n', String(COMPARE_COMMITS), '--skip', skip, FORMAT, which, '--']).then((r) => {
      if (!r.ok) throw commandFailed('git log', r) // i18n-ignore: a git command, as it is
      return commitRows(r.out)
    })
  const mb = await mergeBaseOf(root, base, head)
  const [aheadCommits, behindCommits, names] = await Promise.all([
    ahead ? side(`${base}..${head}`) : Promise.resolve([]),
    behind ? side(`${head}..${base}`) : Promise.resolve([]),
    git(root, ['diff', '--name-status', '--no-renames', '-z', mb ?? base, head, '--'])
  ])
  if (!names.ok) throw commandFailed('git diff', names) // i18n-ignore: a git command, as it is
  const files: CompareFile[] = []
  const parts = names.out.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ path: parts[i + 1], status: parts[i][0] })
  return { base: baseName, head: headName, baseCommit: base, headCommit: head, mergeBase: mb, ahead, behind, aheadCommits, behindCommits, page: p, pages, files: files.slice(0, COMPARE_FILES), filesTotal: files.length }
}

/** A file at a commit, or empty when it isn't there (added or deleted); its size first, so a large one is never read. */
async function fileAt(root: string, rev: string, file: string): Promise<{ buf: Buffer } | { size: number }> {
  const spec = `${rev}:${file}`
  const size = await git(root, ['cat-file', '-s', spec])
  if (!size.ok) return { buf: Buffer.alloc(0) }
  const n = Number(size.out.trim()) || 0
  if (n > MAX_DIFF_BYTES) return { size: n }
  const r = await git(root, ['cat-file', 'blob', spec], MAX_DIFF_BYTES * 2)
  if (!r.ok) throw commandFailed('git cat-file', r) // i18n-ignore: a git command, as it is
  return { buf: r.buf }
}

/**
 * One file of a comparison: as it was where head left base, against head's. `pinned` is the comparison's own commits
 * (GitComparison's baseCommit and headCommit), so the diff is of what the comparison listed; without them (or when one
 * isn't a commit here), the branches' tips now.
 */
export async function compareDiff(root: string, baseName: string, headName: string, file: string, pinned?: { base?: unknown; head?: unknown } | null): Promise<GitDiff> {
  const path = String(file ?? '').replace(/\\/g, '/')
  const [pb, ph] = await Promise.all([pinnedCommit(root, pinned?.base), pinnedCommit(root, pinned?.head)])
  const [base, head] = pb && ph ? [pb, ph] : await Promise.all([branchTip(root, baseName), branchTip(root, headName)])
  const from = (await mergeBaseOf(root, base, head)) ?? base
  const [original, modified] = await Promise.all([fileAt(root, from, path), fileAt(root, head, path)])
  if ('size' in original) return tooLargeDiff(path, original.size)
  if ('size' in modified) return tooLargeDiff(path, modified.size)
  if (isBinary(original.buf) || isBinary(modified.buf)) return { path, original: '', modified: '', binary: true }
  return { path, original: original.buf.toString('utf8'), modified: modified.buf.toString('utf8'), binary: false }
}
