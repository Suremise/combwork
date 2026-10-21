// The Git platform adapter (SPEC §16.3.2): revisions are commits, the change is the whole diff from a base to a revision
// with its endpoints fixed when submitted, sameness is a replay with git's own three-way merge, containment finds a
// merge, a fast-forward or a squash. Every call goes through the `git()` runner; every answer is a value or unknown.
//
// In the app since P3: reconciliation, the adoption and the runtime (main/workflow) read Git through it.

import { AsyncLocalStorage } from 'async_hooks'
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'original-fs'
import { isAbsolute, join, resolve as resolvePath } from 'path'
import { git } from '../git'
import type { FileChange } from '../../shared/workflow/facts'
import { UNREADABLE as U } from '../../shared/workflow/texts'
import { isUnknown, unknown, type Change, type Containment, type Maybe } from './types'

/** A commit as attribution reads it: its id, author email and `Hive-Card` trailers. */
export interface CommitInfo {
  commit: string
  email: string
  cards: string[]
  subject: string
}

const lines = (s: string): string[] => s.split(/\r?\n/).filter(Boolean)

/** A step's answers about fixed commits (gitStep), shared by its reads; `done` once the step has ended. */
interface Step {
  answers: Map<string, Promise<unknown>>
  done: boolean
}
const stepNow = new AsyncLocalStorage<Step>()
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * One workflow step (an intent, a lane's line looked at: #1376): what it asks git about fixed commits (an ancestor, a
 * merge base: answers that can't change) is asked once in it, however many of its reads ask. Nothing about refs, HEAD or
 * the files is kept (they move: each read asks git), and the answers go when the step ends. A step inside a step is
 * the outer one's.
 */
export function gitStep<T>(fn: () => Promise<T>): Promise<T> {
  if (stepNow.getStore()) return fn()
  const step: Step = { answers: new Map(), done: false }
  return stepNow.run(step, async () => {
    try {
      return await fn()
    } finally {
      step.done = true
    }
  })
}

/**
 * `ask()` once per step for commits `ids` (full ids only), unknown answers asked again; outside a step, always asked.
 * Keyed by the commits alone: a project's worktrees share its objects (a line is read in the worktree, its containment
 * in the project), and a repository without them answers unknown, never kept.
 */
function onceInStep<T>(what: string, ids: string[], ask: () => Promise<Maybe<T>>): Promise<Maybe<T>> {
  const step = stepNow.getStore()
  if (!step || step.done || !ids.every((id) => SHA.test(id))) return ask()
  const key = [what, ...ids].join('\0')
  const had = step.answers.get(key) as Promise<Maybe<T>> | undefined
  if (had) return had
  const p = ask().then((v) => {
    if (isUnknown(v)) step.answers.delete(key)
    return v
  })
  step.answers.set(key, p)
  return p
}

/** The repository's common git dir (where branch refs live, for every worktree). */
export async function commonDir(repo: string): Promise<Maybe<string>> {
  const r = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return r.ok ? r.out.trim() : unknown(U.gitFolder, { folder: repo })
}

/**
 * A folder's own git dir, read from its `.git` (a folder, or a linked worktree's `gitdir:` file) with no git process, as
 * `rev-parse --absolute-git-dir` would answer it there (#1373: asked by every intent's evidence). Null when the folder
 * has no readable `.git` of its own (a repository's subfolder): ask git.
 */
export function gitDirSync(folder: string): string | null {
  const dot = join(folder, '.git')
  try {
    if (statSync(dot).isDirectory()) return resolvePath(dot)
    const m = /^gitdir: (.+)$/m.exec(readFileSync(dot, 'utf8'))
    return m ? resolvePath(folder, m[1].trim()) : null
  } catch {
    return null
  }
}

/**
 * A ref's commit, read synchronously from the ref files (loose, else packed-refs), with no git process: cheap enough to
 * read again inside a transaction, as the fingerprint of what a guard decided on (ARCHITECTURE "The one path").
 */
export function refSync(common: string, ref: string, depth = 0): string | null {
  try {
    const v = readFileSync(join(common, ref), 'utf8').trim()
    if (v.startsWith('ref: ') && depth < 5) return refSync(common, v.slice(5), depth + 1)
    if (v) return v
  } catch {
    // Not a loose ref: packed, or missing.
  }
  try {
    for (const l of readFileSync(join(common, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const [sha, name] = l.split(' ')
      if (name === ref) return sha
    }
  } catch {
    // No packed refs.
  }
  return null
}

/** The commit HEAD names in a folder. */
export async function head(folder: string): Promise<Maybe<string>> {
  const r = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.ok ? r.out.trim() : unknown(U.head, { where: folder })
}

/** The branch checked out in a folder, or null when HEAD is detached. */
export async function branch(folder: string): Promise<Maybe<string | null>> {
  const r = await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD'])
  if (r.ok) return r.out.trim()
  if (r.code === 1) return null
  return unknown(U.branch, { folder })
}

/** A line's head (refs/heads/<line>), or null when the line doesn't exist. */
export async function lineHead(repo: string, line: string): Promise<Maybe<string | null>> {
  const r = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${line}`])
  if (r.ok) return r.out.trim()
  if (r.code === 1) return null
  return unknown(U.line, { branch: line })
}

/** Any ref or revision, resolved to a commit (or null if there's no such commit). */
export async function resolve(repo: string, rev: string): Promise<Maybe<string | null>> {
  const r = await git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  if (r.ok) return r.out.trim()
  if (r.code === 1) return null
  return unknown(U.revision, { revision: rev })
}

export async function treeOf(repo: string, rev: string): Promise<Maybe<string>> {
  const r = await git(repo, ['rev-parse', '--verify', '-q', `${rev}^{tree}`])
  return r.ok ? r.out.trim() : unknown(U.files, { revision: rev })
}

/** The repository's default branch: `main` or `master` when one exists, else the branch the folder is on. */
export async function defaultBranch(repo: string): Promise<Maybe<string>> {
  for (const b of ['main', 'master']) {
    const h = await lineHead(repo, b)
    if (isUnknown(h)) return h
    if (h) return b
  }
  const b = await branch(repo)
  if (isUnknown(b)) return b
  return b ?? unknown(U.defaultBranch, { folder: repo })
}

export function isAncestor(repo: string, a: string, b: string): Promise<Maybe<boolean>> {
  return onceInStep('is-ancestor', [a, b], async () => {
    const r = await git(repo, ['merge-base', '--is-ancestor', a, b])
    if (r.ok) return true
    if (r.code === 1) return false
    return unknown(U.contains, { revision: a.slice(0, 7), target: b.slice(0, 7) })
  })
}

export function mergeBase(repo: string, a: string, b: string): Promise<Maybe<string | null>> {
  return onceInStep('merge-base', [a, b], async () => {
    const r = await git(repo, ['merge-base', a, b])
    if (r.ok) return r.out.trim()
    if (r.code === 1 && !r.err) return null
    return unknown(U.branchedOff, { a, b })
  })
}

/**
 * A folder's branch (null: detached), head, and a line's head (null: no such line), in one git (#1376): what
 * `branch`, `head` and `lineHead` answer, asked together. Where the one read can't say (no commit yet, no such line, a
 * HEAD that isn't a branch's), each is asked on its own.
 */
export async function heads(folder: string, target: string): Promise<{ line: Maybe<string | null>; head: Maybe<string>; target: Maybe<string | null> }> {
  const r = await git(folder, ['rev-parse', 'HEAD', `refs/heads/${target}`, '--symbolic-full-name', 'HEAD'])
  const out = r.ok ? lines(r.out).map((l) => l.trim()) : []
  if (out.length === 3 && SHA.test(out[0]) && SHA.test(out[1]) && (out[2] === 'HEAD' || out[2].startsWith('refs/heads/'))) {
    return { head: out[0], target: out[1], line: out[2] === 'HEAD' ? null : out[2].slice(11) }
  }
  const [line, h, t] = await Promise.all([branch(folder), head(folder), lineHead(folder, target)])
  return { line, head: h, target: t }
}

/**
 * The folder's uncommitted state (§16.3.2 Dirty): tracked changes and untracked files that aren't ignored, and a merge,
 * rebase or cherry-pick under way. With `paths`, only those count (a shared folder: the agent's own).
 */
export async function dirty(folder: string, paths?: string[]): Promise<Maybe<string[]>> {
  const now = await worktreeNow(folder)
  if (isUnknown(now)) return now
  if (!paths) return now.dirty
  const mine = (f: string) => paths.some((p) => f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`))
  return now.dirty.filter((f) => f.startsWith('(') || mine(f))
}

/** A merge, rebase or cherry-pick under way: these in the git dir (dirty lists them as `(MERGE_HEAD)`…). */
const MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']

/** A worktree as it is now (worktreeNow): its branch (null: detached), head and uncommitted state (dirty's list). */
export interface WorktreeNow {
  line: string | null
  /** Null: no commit yet. */
  head: string | null
  dirty: string[]
  /** The line asked for's head (null: no such line), when one was. */
  target?: string | null
  /** The git paths asked for, absolute, in their order. */
  gitPaths: string[]
}

/**
 * A worktree's branch, head and uncommitted state, and optionally a line's head and some git paths, in two gits run at
 * once (#1374: lanes read this several times a pass, and six gits each outran tests' bounds under load): `status
 * --branch` for the branch, head and files, and one `rev-parse` for the markers' paths, `gitPaths` and the line (a
 * line in the folder's repository: an agent's worktree shares the project's branches).
 */
export async function worktreeNow(folder: string, o: { target?: string; gitPaths?: string[] } = {}): Promise<Maybe<WorktreeNow>> {
  const asked = [...MARKERS, ...(o.gitPaths ?? [])]
  const where = (target?: string) => git(folder, ['rev-parse', '--path-format=absolute', ...asked.flatMap((m) => ['--git-path', m]), ...(target ? ['--revs-only', `refs/heads/${target}`, '--'] : [])])
  const [r, first] = await Promise.all([git(folder, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']), where(o.target)])
  if (!r.ok) return unknown(U.uncommitted, { folder })
  let line: string | null = null
  let oid: string | null = null
  const files: string[] = []
  const parts = r.out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# branch.oid ')) oid = /^[0-9a-f]{40,64}$/.test(p.slice(13)) ? p.slice(13) : null
    else if (p.startsWith('# branch.head ')) line = p.slice(14) === '(detached)' ? null : p.slice(14)
    else if (p.startsWith('1 ')) files.push(p.split(' ').slice(8).join(' '))
    else if (p.startsWith('2 ')) {
      files.push(p.split(' ').slice(9).join(' '))
      i++ // the original path
    } else if (p.startsWith('u ')) files.push(p.split(' ').slice(10).join(' '))
    else if (p.startsWith('? ')) files.push(p.slice(2))
  }
  // No such line: rev-parse refuses the whole call, so the paths are read again without it (rare: a target deleted).
  const [g, target] = o.target && !first.ok ? await Promise.all([where(), lineHead(folder, o.target)]) : [first, undefined]
  if (isUnknown(target)) return target
  const out = g.ok ? lines(g.out).map((l) => l.trim()) : []
  if (out.length !== asked.length + (o.target && target === undefined ? 1 : 0)) return unknown(U.state, { folder })
  MARKERS.forEach((marker, i) => {
    if (existsSync(isAbsolute(out[i]) ? out[i] : join(folder, out[i]))) files.push(`(${marker})`)
  })
  return { line, head: oid, dirty: files, ...(o.target ? { target: target === undefined ? out[asked.length] : target } : {}), gitPaths: out.slice(MARKERS.length, asked.length) }
}

/** Files changed from base to head, as git lists them. */
export async function filesChanged(repo: string, base: string, headRev: string): Promise<Maybe<FileChange[]>> {
  const r = await git(repo, ['diff', '--name-status', '--no-renames', '-z', base, headRev])
  if (!r.ok) return unknown(U.filesChanged, { from: base.slice(0, 7), to: headRev.slice(0, 7) })
  const parts = r.out.split('\0').filter(Boolean)
  const out: FileChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] })
  return out
}

/**
 * The candidate key of a change: `git patch-id --stable` of its whole diff, with no context lines (`-U0`), so a clean
 * rebase whose new neighbours fall within the context keeps its key. A first test only (§16.3.2): different keys mean a
 * different change at once; equal ones go on to the replay. An empty change has no key.
 */
export async function candidateKey(repo: string, base: string, headRev: string): Promise<Maybe<string | null>> {
  const d = await git(repo, ['diff', '--binary', '--no-renames', '-U0', base, headRev], 64 * 1024 * 1024)
  if (!d.ok) return unknown(U.change, { from: base.slice(0, 7), to: headRev.slice(0, 7) })
  if (!d.out.trim()) return null
  const p = await git(repo, ['patch-id', '--stable'], 16 * 1024 * 1024, d.out)
  if (!p.ok) return unknown(U.changeFingerprint)
  return p.out.trim().split(/\s+/)[0] || null
}

/** A change's files and candidate key, from fixed endpoints. */
export async function change(repo: string, base: string, headRev: string): Promise<Maybe<Change>> {
  const files = await filesChanged(repo, base, headRev)
  if (isUnknown(files)) return files
  const key = await candidateKey(repo, base, headRev)
  if (isUnknown(key)) return key
  return { files, key }
}

/**
 * Replays the change base→rev onto `onto` with git's three-way merge (`merge-tree --write-tree --merge-base`): the
 * resulting tree, or null when it conflicts.
 */
export async function replayTree(repo: string, base: string, onto: string, rev: string): Promise<Maybe<string | null>> {
  const r = await git(repo, ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${base}`, onto, rev])
  if (r.code === 0) return lines(r.out)[0] ?? unknown(U.replayedFiles)
  if (r.code === 1) return null
  return unknown(U.replay, { revision: rev.slice(0, 7), onto: onto.slice(0, 7) })
}

/**
 * Same change (§16.3.2, OP-33): a pass on R1 (base B1) carries over to R2 (base B2) only if replaying R1's change onto
 * B2 gives exactly R2's tree. Anything the replay can't settle is not the same: unknown never carries over, so this
 * answers false rather than unknown.
 */
export async function sameChange(repo: string, a: { base: string; revision: string; key?: string | null }, b: { base: string; revision: string; key?: string | null }): Promise<boolean> {
  if (a.revision === b.revision) return true
  const tb = await treeOf(repo, b.revision)
  if (isUnknown(tb)) return false
  if (a.base === b.base) {
    const ta = await treeOf(repo, a.revision)
    return !isUnknown(ta) && ta === tb
  }
  // The candidate key rules out a different change at once; equal keys go on to the replay.
  const ka = a.key !== undefined ? a.key : await candidateKey(repo, a.base, a.revision)
  const kb = b.key !== undefined ? b.key : await candidateKey(repo, b.base, b.revision)
  if (isUnknown(ka) || isUnknown(kb) || ka !== kb) return false
  const t = await replayTree(repo, a.base, b.base, a.revision)
  return !isUnknown(t) && t === tb
}

/**
 * Is the change base→rev in the target (§16.3.2 Containment)? In order: an ancestor of the target (a merge or a
 * fast-forward); a target commit since the base whose parent replays the change to its tree (a squash or a cherry-pick
 * of the whole change); else the whole target already holds it (a squash split across commits). Null when not found.
 * `at`: the target's head as the caller read it (asked about that commit, not read again).
 */
export async function contains(repo: string, target: string, c: { base: string; revision: string; key?: string | null }, at?: string): Promise<Maybe<Containment | null>> {
  const t = at ?? (await resolve(repo, target))
  if (isUnknown(t)) return t
  if (!t) return unknown(U.target, { target })
  const anc = await isAncestor(repo, c.revision, t)
  if (isUnknown(anc)) return anc
  if (anc) {
    const fp = await git(repo, ['rev-list', '--first-parent', t])
    if (!fp.ok) return unknown(U.history, { target })
    return { method: lines(fp.out).includes(c.revision) ? 'fastForward' : 'merge' }
  }
  const key = c.key !== undefined ? c.key : await candidateKey(repo, c.base, c.revision)
  if (isUnknown(key)) return key
  // The target's commits since the change's base (bounded, merges left out: a merge's change is covered above), keyed in
  // one pass (`log -p -U0 | patch-id`); only those with the change's key are replayed, as a squash of it. A change with
  // no key (empty) matches none of them: not listed (#1376).
  const log = key === null ? null : await git(repo, ['log', '--no-merges', '--max-count=500', '-p', '-U0', '--binary', '--format=commit %H', `${c.base}..${t}`], 256 * 1024 * 1024)
  if (log && !log.ok) return unknown(U.commitsOn, { target })
  const ids = log ? await git(repo, ['patch-id', '--stable'], 16 * 1024 * 1024, log.out) : null
  if (ids && !ids.ok) return unknown(U.commitsOn, { target })
  for (const line of ids ? lines(ids.out) : []) {
    const [k, commit] = line.split(/\s+/)
    if (!commit || k !== key) continue
    const parent = await resolve(repo, `${commit}^`)
    if (isUnknown(parent)) return parent
    if (!parent) continue
    const replayed = await replayTree(repo, c.base, parent, c.revision)
    const tree = await treeOf(repo, commit)
    if (isUnknown(replayed) || isUnknown(tree)) return unknown(U.holdsChange, { where: commit.slice(0, 7) })
    if (replayed && replayed === tree) return { method: 'squash', commit }
  }
  // The whole target already holds it: replaying the change onto the target changes nothing.
  const whole = await replayTree(repo, c.base, t, c.revision)
  const tt = await treeOf(repo, t)
  if (isUnknown(whole) || isUnknown(tt)) return unknown(U.holdsChange, { where: target })
  if (whole && whole === tt) return { method: 'sameTree' }
  return null
}

/** A line's own commits since a base, newest first: its first-parent history (a merge brings others' in beside it). */
export async function firstParents(repo: string, base: string, headRev: string): Promise<Maybe<string[]>> {
  const r = await git(repo, ['rev-list', '--first-parent', `${base}..${headRev}`])
  return r.ok ? lines(r.out) : unknown(U.commitsSince, { revision: headRev.slice(0, 7), base: base.slice(0, 7) })
}

/** The commits of a range, oldest first, with their author emails and `Hive-Card` trailers. */
export async function commits(repo: string, range: string): Promise<Maybe<CommitInfo[]>> {
  const r = await git(repo, ['log', '--reverse', '--format=%H%x1f%ae%x1f%(trailers:key=Hive-Card,valueonly,separator=%x2C)%x1f%s%x1e', range])
  if (!r.ok) return unknown(U.commitsOf, { range })
  return r.out
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [commit, email, cards, subject] = s.split('\x1f')
      return { commit, email, cards: cards ? cards.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) : [], subject: subject ?? '' }
    })
}

/** Where each branch is checked out: line → folder (`git worktree list`). */
export async function checkouts(repo: string): Promise<Maybe<Record<string, string>>> {
  const r = await git(repo, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return unknown(U.worktrees, { folder: repo })
  const out: Record<string, string> = {}
  let folder = ''
  for (const l of lines(r.out)) {
    if (l.startsWith('worktree ')) folder = l.slice(9)
    else if (l.startsWith('branch refs/heads/')) out[l.slice(18)] = folder
  }
  return out
}

/** Makes a card's folder: a worktree on a new line from `base` (§16.10, the spike's stand-in for slots). */
export async function isolate(repo: string, folder: string, line: string, base: string): Promise<Maybe<string>> {
  if (existsSync(folder)) {
    const b = await branch(folder)
    if (!isUnknown(b) && b === line) return folder
  }
  const r = await git(repo, ['worktree', 'add', '-b', line, folder, base])
  return r.ok ? folder : unknown(U.folderFor, { branch: line })
}

/**
 * Moves a worktree's branch from `expect` (its branch checked out at that head, the worktree clean) to `to`, as
 * `git reset --keep` would, serialized with whatever else uses the worktree (§16.19.2, #1271; HR2's round 2): under the
 * worktree's own index lock, so no commit or other git write can run in it meanwhile (git refuses them, nothing lost),
 * the branch, head and clean state are checked, then `go()` (the caller's authority, at the boundary itself); the files
 * and index are brought from the head's tree to the target's through a separate index (`read-tree -m -u`, which
 * refuses to overwrite a local change), and the branch moved only if it is still at that head (`update-ref <to>
 * <head>`, compare and swap), else the files are put back. Never a reset of a branch that may have moved on.
 * True when moved; git's reason when it refused; null when anything differed (another git command at work there, the
 * branch or head changed, the worktree not clean, or `go()` no longer holds): nothing moved.
 */
export async function moveLineLocked(folder: string, to: string, expect: { line: string | null; head: string; target?: string }, go: () => boolean): Promise<true | string | null> {
  if (!expect.line) return null
  // The index in the folder's git dir, read from its `.git` (#1376), else git's answer (git's own if GIT_INDEX_FILE moves it).
  const gitDir = process.env.GIT_INDEX_FILE ? null : gitDirSync(folder)
  const at = gitDir ? null : await git(folder, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  if (at && !at.ok) return null
  const index = at ? at.out.trim() : join(gitDir!, 'index')
  const lock = `${index}.lock`
  const next = `${index}.hive-line`
  let fd: number | null
  try {
    fd = openSync(lock, 'wx')
  } catch {
    return null
  }
  let placed = false
  // The new index, once read: where it is (the separate file, then the lock), for putting the files back with it.
  let staged = next
  try {
    const now = await worktreeNow(folder, expect.target ? { target: expect.target } : {})
    // The target still where it was read too (`to`, its head then): moved on, it is looked at again.
    if (isUnknown(now) || now.line !== expect.line || now.head !== expect.head || (expect.target ? now.target : to) !== to || now.dirty.length || !go()) return null
    copyFileSync(index, next)
    const files = await git(folder, ['read-tree', '-m', '-u', expect.head, to], undefined, undefined, { env: { ...process.env, GIT_INDEX_FILE: next } })
    if (!files.ok) return (files.err || files.out || 'git read-tree failed').trim() // i18n-ignore: git's own words, or the command
    /** Puts the files back as the head has them, from the new index wherever it is now; true when done. */
    const filesBack = async (): Promise<boolean> => (await git(folder, ['read-tree', '-m', '-u', to, expect.head], undefined, undefined, { env: { ...process.env, GIT_INDEX_FILE: staged } })).ok
    // Every failure from here on puts back what was changed (HR2's round 3), conditionally: the files from the new index,
    // the branch only if it is still where this moved it. Not all put back: thrown (LineMoveBroken), for the caller to
    // hold the lane's next card and look again.
    // 1. The new index into the lock, which stays held: published only once the branch has moved.
    closeSync(fd)
    fd = null
    try {
      renameSync(next, lock)
      staged = lock
    } catch (e) {
      if (!(await filesBack())) throw new LineMoveBroken(`the files of ${expect.line} couldn't be put back after: ${(e as Error).message}`) // i18n-ignore: a log line's reason
      return (e as Error).message
    }
    // 2. The branch, only from the head checked (compare and swap).
    const ref = await git(folder, ['update-ref', '-m', 'Hive: up to date after a squash merge', `refs/heads/${expect.line}`, to, expect.head])
    if (!ref.ok) {
      // The branch moved on (not through this worktree's index): its files back as they were, nothing moved.
      if (!(await filesBack())) throw new LineMoveBroken(`the files of ${expect.line} couldn't be put back after its branch moved on`) // i18n-ignore: a log line's reason
      return null
    }
    // 3. The index published: the lock renamed over it (tried again a few times: Windows refuses a rename while another
    // process has the file open for a moment).
    let failed: Error | null = null
    for (let tries = 0; tries < PUBLISH_TRIES; tries++) {
      try {
        renameSync(lock, index)
        placed = true
        return true
      } catch (e) {
        failed = e as Error
        await new Promise((r) => setTimeout(r, PUBLISH_RETRY_MS))
      }
    }
    // Not published: the branch back to the head (only if still where this moved it), the files with it.
    const back = await git(folder, ['update-ref', '-m', 'Hive: put back, its index not written', `refs/heads/${expect.line}`, expect.head, to])
    if (!back.ok || !(await filesBack())) throw new LineMoveBroken(`${expect.line} was moved to ${to.slice(0, 7)} but its index couldn't be written (${failed?.message}), and it couldn't be put back`) // i18n-ignore: a log line's reason
    return failed?.message ?? 'the index could not be written' // i18n-ignore: a reason, agent- and log-facing
  } finally {
    if (fd !== null) closeSync(fd)
    if (!placed) {
      if (existsSync(next)) unlinkSync(next)
      if (existsSync(lock)) unlinkSync(lock)
    }
  }
}

/** How often, and how far apart, the moved line's index is tried as it is published (moveLineLocked). */
const PUBLISH_TRIES = 5
const PUBLISH_RETRY_MS = 100

/**
 * A line moved part way that couldn't be put back (moveLineLocked): the branch, its files or its index may not agree.
 * The caller holds the lane's next card and looks again (its `LineMoving` fact says a move began).
 */
export class LineMoveBroken extends Error {}

/** Pins a revision by a ref so a deleted line, a force push or garbage collection can't lose it (§16.9.3). */
export async function pin(repo: string, ref: string, rev: string): Promise<boolean> {
  return (await git(repo, ['update-ref', ref, rev])).ok
}

/** The repository's configured commit identity, or null when none is set. */
export async function identity(repo: string): Promise<{ name: string; email: string } | null> {
  const n = await git(repo, ['config', 'user.name'])
  const e = await git(repo, ['config', 'user.email'])
  return n.ok && e.ok && n.out.trim() && e.out.trim() ? { name: n.out.trim(), email: e.out.trim() } : null
}
