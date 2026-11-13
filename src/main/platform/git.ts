// The Git platform adapter (SPEC §16.3.2): revisions are commits, the change is the whole diff from a base to a revision
// with its endpoints fixed when submitted, sameness is a replay with git's own three-way merge, containment finds a
// merge, a fast-forward or a squash. Every call goes through the `git()` runner; every answer is a value or unknown.
//
// In the app since P3: reconciliation, the adoption and the runtime (main/workflow) read Git through it.

import { AsyncLocalStorage } from 'async_hooks'
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'original-fs'
import { access, lstat, readFile } from 'original-fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'path'
import { branchOfRef, git, gitRouted } from '../git'
import { gitExe } from '../gitTool'
import { plainRepo, refSync } from './repoRefs'
import type { FileChange } from '../../shared/workflow/facts'
import { gitlinkOf, parseRawRows, sideOf, type GitlinkSide } from '../../shared/gitlink'
import { UNREADABLE as U } from '../../shared/workflow/texts'
import { isUnknown, unknown, withDetail, type Change, type Containment, type Maybe } from './types'
import type { CommitInfo, SubmoduleChange, SubmoduleState, WorktreeNow } from './history'

// A commit as attribution reads it, and a worktree as worktreeNow reads it: port 3's types (history.ts, HI-2787).
export type { CommitInfo, WorktreeNow } from './history'

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
 * `ask()` once per step for commits `ids` (full ids only) in `repo`'s repository, unknown answers asked again; outside
 * a step, always asked. Keyed by the repository's common git dir (HR2's round 1): a project and its worktrees share
 * answers (a line is read in the worktree, its containment in the project), another repository never. A folder whose
 * repository can't be told from its `.git` (a subfolder) is always asked.
 */
function onceInStep<T>(repo: string, what: string, ids: string[], ask: () => Promise<Maybe<T>>): Promise<Maybe<T>> {
  const step = stepNow.getStore()
  if (!step || step.done || !ids.every((id) => SHA.test(id))) return ask()
  const common = commonDirSync(repo)
  if (!common) return ask()
  const key = [common.toLowerCase(), what, ...ids].join('\0')
  const had = step.answers.get(key) as Promise<Maybe<T>> | undefined
  if (had) return had
  const p = ask().then((v) => {
    if (isUnknown(v)) step.answers.delete(key)
    return v
  })
  step.answers.set(key, p)
  return p
}

/** How many answers about fixed commits are kept between steps (HI-2115); the oldest go first. */
const KEPT_MAX = 20_000
const kept = new Map<string, unknown>()

/**
 * HI-2115: an answer about fixed commits (full ids) that can't change, kept for as long as Combwork runs, not only for a
 * step: whether one is another's ancestor, their merge base, a range's first parents. The reconciler asked them again
 * at every ref change for every card under way (a git each, several a second while lanes build). Unknown answers are
 * asked again. Kept only for a plain repository (`plainRepo`, the one rule of Combwork's git caches): otherwise (replace
 * refs, grafts or shallow history can give the same ids other answers; a reftable can hold replacements unseen) nothing
 * is kept or answered from what was, checked before each answer kept is given and again before one is kept (it may
 * have changed while git ran). An answer kept for a plain repository holds whenever it is plain again: its commits are
 * the same objects. Keyed by the common git dir, so a
 * project and its linked worktrees share the answers about the same commits, and a slot reused for another repository
 * never sees the other's.
 */
function onceForever<T>(repo: string, what: string, ids: string[], ask: () => Promise<Maybe<T>>): Promise<Maybe<T>> {
  if (!ids.every((id) => SHA.test(id))) return onceInStep(repo, what, ids, ask)
  const common = commonDirSync(repo)
  // The folder's own git dir: a linked worktree's `config.worktree` is its own (HR3's round 3, finding 2).
  const own = gitDirSync(repo)
  if (!common || !own || !plainRepo(common, own)) return onceInStep(repo, what, ids, ask)
  const key = [common.toLowerCase(), what, ...ids].join('\0')
  if (kept.has(key)) {
    const v = kept.get(key) as Maybe<T>
    // The newest last: the oldest are the first dropped.
    kept.delete(key)
    kept.set(key, v)
    return Promise.resolve(v)
  }
  return onceInStep(repo, what, ids, ask).then((v) => {
    if (isUnknown(v) || !plainRepo(common, own)) return v
    kept.set(key, v)
    if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!)
    return v
  })
}

/** Tests: forgets the answers kept between steps. */
export function forgetKeptAnswers(): void {
  kept.clear()
  notFound.clear()
}

/** HI-2189: how long a "not found" from contains' replay is kept, from when git computed it (the user's decision: 30 s). */
export const NOT_FOUND_MS = 30_000
/** How many such answers are kept at once; the oldest go first. */
const NOT_FOUND_MAX = 2_000
/** Key → when it expires (Date.now()), set once when computed and never extended by a hit. */
const notFound = new Map<string, number>()

/**
 * HI-2189 (the user's decision, B): the key under which contains' "not found" for these endpoints is kept, or null
 * where none is: a repository that isn't plain (onceForever's rule), a git run by a route (another process and its own
 * environment), or ids that aren't full commit ids. The key names the repository and the folder git runs in, the git
 * started and its launcher's environment, the target, its head and the change's endpoints and key: a new commit on
 * either side, or another git, is another key, asked at once.
 */
function notFoundKey(repo: string, target: string, c: { base: string; revision: string; key?: string | null }, t: string): string | null {
  if (gitRouted() || ![c.base, c.revision, t].every((id) => SHA.test(id))) return null
  const common = commonDirSync(repo)
  const own = gitDirSync(repo)
  if (!common || !own || !plainRepo(common, own)) return null
  const exe = gitExe()
  return [common.toLowerCase(), resolvePath(repo).toLowerCase(), exe.exe, JSON.stringify(exe.launcherEnv ?? null), target, t, c.base, c.revision, c.key === undefined ? '?' : (c.key ?? '-')].join('\0')
}

/** A "not found" kept for `key` and not expired (an expired one is dropped), checked while the repository is plain. */
function keptNotFound(repo: string, key: string): boolean {
  const until = notFound.get(key)
  if (until === undefined) return false
  if (Date.now() >= until) {
    notFound.delete(key)
    return false
  }
  const common = commonDirSync(repo)
  const own = gitDirSync(repo)
  return !!common && !!own && plainRepo(common, own)
}

/** An answer read with another git (lineHeadAndTree), kept as the step's own for those commits. */
function knownInStep<T>(repo: string, what: string, ids: string[], value: T): void {
  const step = stepNow.getStore()
  const common = step && !step.done && ids.every((id) => SHA.test(id)) ? commonDirSync(repo) : null
  if (step && common) step.answers.set([common.toLowerCase(), what, ...ids].join('\0'), Promise.resolve(value))
}

/** The repository's common git dir (where branch refs live, for every worktree). */
export async function commonDir(repo: string): Promise<Maybe<string>> {
  const r = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return r.ok ? r.out.trim() : unknown(U.gitFolder, { folder: repo })
}

/** commonDir, read from the `.git` files with no git process where they say (#1462: every reconcile asks it), else by git. */
export async function commonDirFast(repo: string): Promise<Maybe<string>> {
  return commonDirSync(repo) ?? commonDir(repo)
}

/**
 * A folder's own git dir, read from its `.git` (a folder, or a linked worktree's `gitdir:` file) with no git process, as
 * `rev-parse --absolute-git-dir` would answer it there (#1373: asked by every intent's evidence). Null when the folder
 * has no readable `.git` of its own (a repository's subfolder): ask git.
 */
export function gitDirSync(folder: string): string | null {
  // GIT_DIR or GIT_COMMON_DIR in the environment chooses another repository than `.git` names (HR3's HI-1970 round 1).
  if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR) return null
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
 * A folder's repository's common git dir, read from its `.git` (a linked worktree's git dir names it in `commondir`)
 * with no git process; null where `gitDirSync` can't say.
 */
export function commonDirSync(folder: string): string | null {
  const own = gitDirSync(folder)
  if (!own) return null
  try {
    return resolvePath(own, readFileSync(join(own, 'commondir'), 'utf8').trim())
  } catch {
    return own
  }
}

// A ref's commit from the ref files: kept with the observer's read, which git's worker loads (HI-1814).
export { refSync }

/**
 * A folder's checkout read from its ref files with no git process (as refSync): the branch it has checked out (null:
 * detached) and its commit, or null when that can't be read. Cheap enough to read again inside a transaction (HI-1731:
 * a slot's line as a guard decided on it).
 */
export function headSync(folder: string): { line: string | null; head: string } | null {
  const own = gitDirSync(folder)
  const common = commonDirSync(folder)
  if (!own || !common) return null
  try {
    const v = readFileSync(join(own, 'HEAD'), 'utf8').trim()
    if (v.startsWith('ref: ')) {
      const ref = v.slice(5)
      const sha = refSync(common, ref)
      return sha ? { line: ref.replace(/^refs\/heads\//, ''), head: sha } : null
    }
    return /^[0-9a-f]{40,64}$/.test(v) ? { line: null, head: v } : null
  } catch {
    return null
  }
}

/** The commit HEAD names in a folder. */
export async function head(folder: string): Promise<Maybe<string>> {
  const r = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.ok ? r.out.trim() : withDetail(unknown(U.head, { where: folder }), r.err)
}

/** The branch checked out in a folder, or null when HEAD is detached. The full ref, cut: `--short` says heads/x beside a tag x (HI-2426). */
export async function branch(folder: string): Promise<Maybe<string | null>> {
  const r = await git(folder, ['symbolic-ref', '-q', 'HEAD'])
  if (r.ok) return branchOfRef(r.out)
  if (r.code === 1) return null
  return withDetail(unknown(U.branch, { folder }), r.err)
}

/**
 * A branch name the ref files can be read by as a path, as git reads them (HR6's #1491 round 1): each component plain
 * ASCII, not starting with a dot or dash, no `..`, not ending in `.` or `.lock`, no Windows device name. Anything else
 * (valid for git or not) is git's to answer.
 */
const PLAIN_COMPONENT = /^[A-Za-z0-9_+][A-Za-z0-9_+.-]*$/
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
const plainBranch = (line: string): boolean => line.split('/').every((c) => PLAIN_COMPONENT.test(c) && !c.includes('..') && !c.endsWith('.') && !c.endsWith('.lock') && !DEVICE.test(c))

/**
 * A branch's commit from the common dir's ref files, with no git process: the loose ref when it holds a commit id, else
 * its packed-refs line when there is no loose ref. Null whenever git must say: a symbolic ref (it may name a worktree's
 * own HEAD, HR6's #1491 round 1), a file that isn't an id, a folder, an error reading, or no entry in either.
 */
function branchRefSync(common: string, line: string): string | null {
  const ref = `refs/heads/${line}`
  try {
    const v = readFileSync(join(common, ref), 'utf8').trim()
    return SHA.test(v) ? v : null
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
  }
  try {
    for (const l of readFileSync(join(common, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const [sha, name] = l.split(' ')
      if (name === ref) return SHA.test(sha) ? sha : null
    }
  } catch {
    // No packed refs.
  }
  return null
}

/**
 * A line's head (refs/heads/<line>), or null when the line doesn't exist. Read from the ref files with no git process
 * where they name a commit (#1491: a step reads its target's head four or five times, each a git), read again each time
 * as git would; git where they can't say (no such line, a symbolic ref, a name that isn't plain, a reftable, a folder
 * whose `.git` doesn't name its repository).
 */
export async function lineHead(repo: string, line: string): Promise<Maybe<string | null>> {
  const common = plainBranch(line) ? commonDirSync(repo) : null
  const known = common ? branchRefSync(common, line) : null
  if (known) return known
  const r = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${line}`])
  if (r.ok) return r.out.trim()
  if (r.code === 1) return null
  return unknown(U.line, { branch: line })
}

/**
 * A line's head, as lineHead answers it, with its tree from the same commit in the same git (#1386: the queue asks
 * containment of the target's head, whose last test is that tree), kept as the step's treeOf answer. Where the one
 * read can't say (no such line), lineHead's own answer.
 */
export async function lineHeadAndTree(repo: string, line: string): Promise<Maybe<string | null>> {
  // Never a signature check (a repository's log.showSignature would run gpg and print its lines).
  const r = await git(repo, ['show', '-s', '--no-show-signature', '--format=%H %T', `refs/heads/${line}`, '--'])
  const [commit, tree] = r.ok ? r.out.trim().split(' ') : []
  if (!commit || !tree || !SHA.test(commit) || !SHA.test(tree)) return lineHead(repo, line)
  knownInStep(repo, 'tree', [commit], tree)
  return commit
}

/** Any ref or revision, resolved to a commit (or null if there's no such commit). */
export async function resolve(repo: string, rev: string): Promise<Maybe<string | null>> {
  const r = await git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  if (r.ok) return r.out.trim()
  if (r.code === 1) return null
  return unknown(U.revision, { revision: rev })
}

/** A revision's tree: a commit's asked once per step (#1386). */
export function treeOf(repo: string, rev: string): Promise<Maybe<string>> {
  return onceInStep(repo, 'tree', [rev], async () => {
    const r = await git(repo, ['rev-parse', '--verify', '-q', `${rev}^{tree}`])
    return r.ok ? r.out.trim() : unknown(U.files, { revision: rev })
  })
}

/** The repository's own main branch, `main` or `master`, whichever exists first; null when it has neither (HI-3049). */
export async function mainBranch(repo: string): Promise<Maybe<string | null>> {
  for (const b of ['main', 'master']) {
    const h = await lineHead(repo, b)
    if (isUnknown(h)) return h
    if (h) return b
  }
  return null
}

/** The repository's default branch: `main` or `master` when one exists, else the branch the folder is on. */
export async function defaultBranch(repo: string): Promise<Maybe<string>> {
  const m = await mainBranch(repo)
  if (m !== null) return m
  const b = await branch(repo)
  if (isUnknown(b)) return b
  return b ?? unknown(U.defaultBranch, { folder: repo })
}

export function isAncestor(repo: string, a: string, b: string): Promise<Maybe<boolean>> {
  return onceForever(repo, 'is-ancestor', [a, b], async () => {
    const r = await git(repo, ['merge-base', '--is-ancestor', a, b])
    if (r.ok) return true
    if (r.code === 1) return false
    return unknown(U.contains, { revision: a.slice(0, 7), target: b.slice(0, 7) })
  })
}

export function mergeBase(repo: string, a: string, b: string): Promise<Maybe<string | null>> {
  return onceForever(repo, 'merge-base', [a, b], async () => {
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

/**
 * HI-3023: a porcelain v2 `1 ` row of a submodule whose only change is inside it: nothing staged (`X` is `.`), its
 * checked-out commit the recorded one (`S.`), only edited or untracked files in it (`S.M.`, `S..U`, `S.MU`). The
 * folder has nothing of it to commit or set aside: the work is the submodule's own.
 */
export const insideOnly = (xy: string | undefined, sub: string | undefined): boolean => !!xy && !!sub && xy[0] === '.' && sub.length === 4 && sub[0] === 'S' && sub[1] === '.' && (sub[2] === 'M' || sub[3] === 'U')

/** HI-3124: how a submodule's porcelain v2 row says it changed (its `XY` and `S<c><m><u>`): see SubmoduleState. */
export function submoduleState(xy: string | undefined, sub: string | undefined): SubmoduleState {
  const [x, y] = [xy?.[0], xy?.[1]]
  if (x === 'A') return 'added'
  if (x === 'D') return 'removed'
  if (x === 'M') return 'staged'
  if (x === '.' && y === 'D') return 'deleted'
  if (x === '.' && sub?.[1] === 'C') return 'moved'
  return 'other'
}

/** A submodule row's HEAD object (`hH`): null when HEAD has none (an added one: all zeros). */
const recordedOf = (h: string | undefined): string | null => (h && /^[0-9a-f]{40,64}$/.test(h) && !/^0+$/.test(h) ? h : null)

/** A merge, rebase or cherry-pick under way: these in the git dir (dirty lists them as `(MERGE_HEAD)`…). */
const MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']

/**
 * A worktree's branch, head and uncommitted state, and optionally a line's head and some git paths, in two gits run at
 * once (#1374: lanes read this several times a pass, and six gits each outran tests' bounds under load): `status
 * --branch` for the branch, head and files, and one `rev-parse` for the markers' paths, `gitPaths` and the line (a
 * line in the folder's repository: an agent's worktree shares the project's branches).
 */
export async function worktreeNow(folder: string, o: { target?: string; gitPaths?: string[] } = {}): Promise<Maybe<WorktreeNow>> {
  const asked = [...MARKERS, ...(o.gitPaths ?? [])]
  const where = (target?: string) => git(folder, ['rev-parse', '--path-format=absolute', ...asked.flatMap((m) => ['--git-path', m]), ...(target ? ['--revs-only', `refs/heads/${target}`, '--'] : [])])
  // --no-ahead-behind (#1377): `--branch` would otherwise count the upstream's ahead and behind, a walk nothing here reads.
  const status = git(folder, ['status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind', '--untracked-files=all'])
  // HI-1970: the markers are in the folder's own git dir and the line's head in the ref files, read from `.git` with no
  // git process (as lineHead), read now as the rev-parse would be; git where they can't say (other paths asked, a git
  // dir moved by GIT_DIR, a line the ref files don't name).
  const own = o.gitPaths?.length ? null : gitDirSync(folder)
  const common = own && o.target && plainBranch(o.target) ? commonDirSync(folder) : null
  const known = common && o.target ? branchRefSync(common, o.target) : null
  const fast = own && (!o.target || known)
  const [r, first] = await Promise.all([status, fast ? { ok: true, out: [...MARKERS.map((m) => join(own, m)), ...(known ? [known] : [])].join('\n') } : where(o.target)])
  if (!r.ok) return unknown(U.uncommitted, { folder })
  let line: string | null = null
  let oid: string | null = null
  const files: string[] = []
  const inside: string[] = []
  const subs: SubmoduleChange[] = []
  const parts = r.out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# branch.oid ')) oid = /^[0-9a-f]{40,64}$/.test(p.slice(13)) ? p.slice(13) : null
    else if (p.startsWith('# branch.head ')) line = p.slice(14) === '(detached)' ? null : p.slice(14)
    else if (p.startsWith('1 ')) {
      const f = p.split(' ')
      const path = f.slice(8).join(' ')
      files.push(path)
      if (insideOnly(f[1], f[2])) inside.push(path)
      // `1 XY sub mH mI mW hH hI path`
      if (f[2]?.[0] === 'S') subs.push({ path, state: submoduleState(f[1], f[2]), recorded: recordedOf(f[6]) })
    } else if (p.startsWith('2 ')) {
      const f = p.split(' ')
      const path = f.slice(9).join(' ')
      files.push(path)
      // A rename (`2 XY sub mH mI mW hH hI Xscore path`): said as other.
      if (f[2]?.[0] === 'S') subs.push({ path, state: 'other', recorded: recordedOf(f[6]) })
      i++ // the original path
    } else if (p.startsWith('u ')) files.push(p.split(' ').slice(10).join(' '))
    else if (p.startsWith('? ')) files.push(p.slice(2))
  }
  // No such line: rev-parse refuses the whole call, so the paths are read again without it (rare: a target deleted).
  const [g, target] = o.target && !first.ok ? await Promise.all([where(), lineHead(folder, o.target)]) : [first, undefined]
  if (isUnknown(target)) return target
  const out = g.ok ? lines(g.out).map((l) => l.trim()) : []
  if (out.length !== asked.length + (o.target && target === undefined ? 1 : 0)) return unknown(U.state, { folder })
  // Looked at off main's thread (HI-1814), all at once: a handful of paths.
  const there = await Promise.all(MARKERS.map((_, i) => access(isAbsolute(out[i]) ? out[i] : join(folder, out[i])).then(() => true, () => false)))
  const operations = MARKERS.filter((_, i) => there[i]).map((marker) => `(${marker})`)
  // HI-3081: a path git lists twice (`D ` and `?`: Stop Tracking keeps the file) is one change, counted once.
  return { line, head: oid, dirty: [...new Set(files), ...operations], operations, ...(inside.length ? { insideOnly: inside } : {}), ...(subs.length ? { submodules: subs } : {}), ...(o.target ? { target: target === undefined ? out[asked.length] : target } : {}), gitPaths: out.slice(MARKERS.length, asked.length) }
}

/**
 * Files changed from base to head, as git lists them. HI-2864: read as raw rows (the same paths and letters as
 * `--name-status`, with both modes and full ids), so a row with a gitlink on either side keeps what each side is (a
 * submodule's commit, a file, a link, nothing) for the Work section. Output that isn't raw rows is unknown, never a
 * partial list.
 */
export async function filesChanged(repo: string, base: string, headRev: string): Promise<Maybe<FileChange[]>> {
  const r = await git(repo, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', base, headRev])
  const rows = r.ok ? parseRawRows(r.out) : null
  if (!rows) return unknown(U.filesChanged, { from: base.slice(0, 7), to: headRev.slice(0, 7) })
  return rows.map((row) => {
    const link = gitlinkOf(row)
    return { status: row.status, path: row.path, ...(link ? { gitlink: { from: link.from, to: link.to } } : {}) }
  })
}

/**
 * HI-2864: what a path is at a commit (a gitlink with its commit, a file, a link, or nothing there), from its tree entry's
 * mode: `ls-tree -z` of that one literal path. Unknown when git can't say or its output isn't one entry or none.
 */
export async function treeSide(repo: string, rev: string, path: string): Promise<Maybe<GitlinkSide>> {
  const r = await git(repo, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', rev, '--', path])
  const entries = r.ok ? r.out.split('\0').filter(Boolean) : null
  const m = entries?.length === 1 ? /^(\d{6}) \w+ ([0-9a-f]{40}|[0-9a-f]{64})\t(.*)$/s.exec(entries[0]) : null
  if (!entries || entries.length > 1 || (entries.length === 1 && (!m || m[3] !== path))) return unknown(U.filesChanged, { from: rev.slice(0, 7), to: rev.slice(0, 7) })
  return m ? sideOf(m[1], m[2]) : { kind: 'none' }
}

/**
 * The candidate key of a change: `git patch-id --stable` of its whole diff, with no context lines (`-U0`), so a clean
 * rebase whose new neighbours fall within the context keeps its key. A first test only (§16.3.2): different keys mean a
 * different change at once; equal ones go on to the replay. An empty change has no key.
 *
 * HI-2748: `--full-index`, never `--binary`. patch-id keys a binary file by its full blob ids, which `--full-index` gives
 * on the diff's `index` line, so the key is the one `--binary` gave, without the binary's contents in the diff (a 44 MB
 * video modified in place made an 89 MB diff, past the buffer, and the submit was refused as unreadable).
 */
export async function candidateKey(repo: string, base: string, headRev: string): Promise<Maybe<string | null>> {
  const d = await git(repo, ['diff', '--full-index', '--no-renames', '-U0', base, headRev], 64 * 1024 * 1024)
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
 * `at`: the target's head as the caller read it (asked about that commit, not read again); else the target's head now,
 * from the ref files where they can say (targetHeadSync). A merge or a fast-forward is the history's alone (an
 * ancestor, the target's first parents), kept as onceForever's for the revision and the target's head (HI-2182); a
 * squash or the whole target holding it goes through git's diff and merge, which attributes, drivers and config can
 * change (HR2's round 1), so with fixed endpoints it is asked once per step (#1386: the queue's test merge tested again
 * on the same head). A found one is never kept beyond it; "not found" is kept for NOT_FOUND_MS from when git computed it
 * (HI-2189, the user's decision), for the same commits, target head, folder and git (notFoundKey): a change only to
 * attributes or config can take that long to count, a new commit on either side is asked at once.
 */
export async function contains(repo: string, target: string, c: { base: string; revision: string; key?: string | null }, at?: string): Promise<Maybe<Containment | null>> {
  let t = at ?? targetHeadSync(repo, target)
  if (!t) {
    const r = await resolve(repo, target)
    if (isUnknown(r)) return r
    if (!r) return unknown(U.target, { target })
    t = r
  }
  const th = t
  const merged = await mergedInto(repo, target, c.revision, th)
  if (isUnknown(merged) || merged) return merged
  const key = notFoundKey(repo, target, c, th)
  if (key && keptNotFound(repo, key)) return null
  // Git's own computation, timed and kept where it runs (HR2's round 1: never a step's answer used again). The expiry
  // counts from before git computed it; an answer that took that long is given but not kept.
  const computed = async (): Promise<Maybe<{ found: Containment | null; at: number }>> => {
    const since = Date.now()
    const v = await squashedInto(repo, target, c, th)
    if (isUnknown(v)) return v
    if (key && v === null && Date.now() < since + NOT_FOUND_MS && notFoundKey(repo, target, c, th) === key) {
      // A newer answer kept meanwhile (another pass's) stands.
      if ((notFound.get(key) ?? 0) < since + NOT_FOUND_MS) {
        notFound.delete(key)
        notFound.set(key, since + NOT_FOUND_MS)
      }
      if (notFound.size > NOT_FOUND_MAX) notFound.delete(notFound.keys().next().value!)
    }
    return { found: v, at: since }
  }
  const step = await onceInStep(repo, `contains\0${target}\0${c.key === undefined ? '?' : (c.key ?? '-')}`, [c.base, c.revision, th], computed)
  if (isUnknown(step)) return step
  // A step's "not found" 30 s old or more is asked again, as a pass after it would be: a long step never gives it beyond then.
  if (step.found === null && Date.now() >= step.at + NOT_FOUND_MS) {
    const again = await computed()
    return isUnknown(again) ? again : again.found
  }
  return step.found
}

/** The revision merged or fast-forwarded into the target's head `t` (contains' first test), or null when not its ancestor. */
function mergedInto(repo: string, target: string, revision: string, t: string): Promise<Maybe<Containment | null>> {
  return onceForever(repo, 'merged-into', [revision, t], async () => {
    const anc = await isAncestor(repo, revision, t)
    if (isUnknown(anc)) return anc
    if (!anc) return null
    const fp = await git(repo, ['rev-list', '--first-parent', t])
    if (!fp.ok) return unknown(U.history, { target })
    return { method: lines(fp.out).includes(revision) ? 'fastForward' : 'merge' }
  })
}

/**
 * A target's head as `resolve(target)` would find it, from the ref files with no git process (HI-2182), or null
 * whenever git must say: the name isn't a plain branch's, or could be a hex id, or git would find another ref first
 * by that name (its own `<name>`, `refs/<name>`, `refs/tags/<name>`, loose or packed, before `refs/heads/<name>`), or
 * the branch's ref files can't say (branchRefSync).
 */
function targetHeadSync(repo: string, target: string): string | null {
  if (!plainBranch(target) || /^[0-9a-f]+$/i.test(target)) return null
  const own = gitDirSync(repo)
  const common = commonDirSync(repo)
  if (!own || !common) return null
  const first = [join(own, target), join(common, target), join(own, 'refs', target), join(common, 'refs', target), join(common, 'refs', 'tags', target)]
  for (const p of first) {
    try {
      statSync(p)
      return null
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
    }
  }
  try {
    const packed = readFileSync(join(common, 'packed-refs'), 'utf8')
    if (packed.split(/\r?\n/).some((l) => [`refs/${target}`, `refs/tags/${target}`].includes(l.split(' ')[1]))) return null
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
  }
  return branchRefSync(common, target)
}

/** contains' other tests, for a revision that isn't the target's ancestor: a squash, or the whole target holding it. */
async function squashedInto(repo: string, target: string, c: { base: string; revision: string; key?: string | null }, t: string): Promise<Maybe<Containment | null>> {
  const key = c.key !== undefined ? c.key : await candidateKey(repo, c.base, c.revision)
  if (isUnknown(key)) return key
  // The target's commits since the change's base (bounded, merges left out: a merge's change is covered above), keyed in
  // one pass (`log -p -U0 | patch-id`); only those with the change's key are replayed, as a squash of it. A change with
  // no key (empty) matches none of them: not listed (#1376). `--full-index`, not `--binary`, as candidateKey (HI-2748).
  const log = key === null ? null : await git(repo, ['log', '--no-merges', '--max-count=500', '-p', '-U0', '--full-index', '--format=commit %H', `${c.base}..${t}`], 256 * 1024 * 1024)
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
export function firstParents(repo: string, base: string, headRev: string): Promise<Maybe<readonly string[]>> {
  return onceForever(repo, 'first-parents', [base, headRev], async () => {
    const r = await git(repo, ['rev-list', '--first-parent', `${base}..${headRev}`])
    return r.ok ? lines(r.out) : unknown(U.commitsSince, { revision: headRev.slice(0, 7), base: base.slice(0, 7) })
  })
}

/** The commits in a range, newest first, as full ids: at most `max` (HI-2245: a bounded read). */
export async function commitIds(repo: string, range: string, max: number): Promise<Maybe<string[]>> {
  const r = await git(repo, ['rev-list', `--max-count=${max}`, range])
  if (!r.ok) return unknown(U.commitsOf, { range })
  return r.out.split(/\r?\n/).filter(Boolean)
}

/**
 * The commits of a range, oldest first, with their author emails and `Combwork-Card` trailers. `firstParent`: only the line's
 * own commits, its merges included but not the commits a merge brought in (HI-2382).
 */
export async function commits(repo: string, range: string, opts: { firstParent?: boolean; except?: readonly string[] } = {}): Promise<Maybe<CommitInfo[]>> {
  // `except`: revisions whose history is left out (HI-3145: a forward resolution's source), as git log's ^rev.
  const r = await git(repo, ['log', '--reverse', ...(opts.firstParent ? ['--first-parent'] : []), '--format=%H%x1f%ae%x1f%(trailers:key=Combwork-Card,valueonly,separator=%x2C)%x1f%s%x1e', range, ...(opts.except ?? []).map((x) => `^${x}`)])
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

/** The messages of a range's own commits, oldest first, with no merge commit (G19's branch's own message: HI-1697). */
export async function messages(repo: string, range: string): Promise<Maybe<string[]>> {
  const r = await git(repo, ['log', '--reverse', '--no-merges', '--format=%B%x1e', range])
  if (!r.ok) return unknown(U.commitsOf, { range })
  return r.out
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Where each branch is checked out: line → folder (`git worktree list`). */
export async function checkouts(repo: string): Promise<Maybe<Record<string, string>>> {
  const r = await git(repo, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return withDetail(unknown(U.worktrees, { folder: repo }), r.err)
  const out: Record<string, string> = {}
  const detached: string[] = []
  let folder = ''
  for (const l of lines(r.out)) {
    if (l.startsWith('worktree ')) folder = l.slice(9)
    else if (l.startsWith('branch refs/heads/')) out[l.slice(18)] = folder
    else if (l === 'detached') detached.push(folder)
  }
  // HI-3081: a worktree a rebase has detached still has that branch checked out: git writes the branch back when the
  // rebase ends (refusing if it moved meanwhile), so moving it from outside (the merge queue's `update-ref` "checked
  // out nowhere") broke the user's rebase, and Commit and Set Aside said the branch wasn't checked out at all.
  for (const f of detached) {
    const rebasing = await rebasingBranch(f)
    if (isUnknown(rebasing)) return rebasing
    if (rebasing && !(rebasing in out)) out[rebasing] = f
  }
  return out
}

/** HI-3081: the branch a rebase under way in a worktree will write back (null: none under way). */
async function rebasingBranch(folder: string): Promise<Maybe<string | null>> {
  // Its git dir from `.git`, with no git process where it can say (most worktrees); else git's own answer.
  const own = gitDirSync(folder)
  let paths = own ? [join(own, 'rebase-merge', 'head-name'), join(own, 'rebase-apply', 'head-name')] : null
  if (!paths) {
    // A worktree whose folder is gone (prunable: a test merge's copy just removed) has nothing under way in it. HR1's
    // round 1: only a folder the system says isn't there; one it can't look at is unknown, never "no rebase".
    const there = await lstat(folder).then(
      () => true,
      (e: NodeJS.ErrnoException) => (absent(e) ? false : e)
    )
    if (there === false) return null
    if (there !== true) return withDetail(unknown(U.worktrees, { folder }), there.message)
    const r = await git(folder, ['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge/head-name', '--git-path', 'rebase-apply/head-name'])
    if (!r.ok) return withDetail(unknown(U.worktrees, { folder }), r.err)
    paths = lines(r.out).map((l) => l.trim())
  }
  for (const p of paths) {
    // HR1's round 1: no marker only when the system says it isn't there; a marker it can't read (denied, I/O) is
    // unknown, so the branch is never taken for one checked out nowhere and moved under a rebase.
    const name = await readFile(p, 'utf8').then(
      (t) => t.trim(),
      (e: NodeJS.ErrnoException) => (absent(e) ? '' : e)
    )
    if (typeof name !== 'string') return withDetail(unknown(U.worktrees, { folder }), name.message)
    if (name.startsWith('refs/heads/')) return name.slice(11)
  }
  return null
}

/** A file-system error that says the path isn't there (rather than that it couldn't be looked at). */
const absent = (e: NodeJS.ErrnoException | undefined): boolean => e?.code === 'ENOENT' || e?.code === 'ENOTDIR'

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
  const next = `${index}.cw-line`
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
    const ref = await git(folder, ['update-ref', '-m', 'Combwork: up to date after a squash merge', `refs/heads/${expect.line}`, to, expect.head])
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
    const back = await git(folder, ['update-ref', '-m', 'Combwork: put back, its index not written', `refs/heads/${expect.line}`, expect.head, to])
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

/**
 * The repository's configured commit identity, or null when none is set. HI-2050: both keys in one git, as `git config
 * <key>` answers each: NUL-separated records, a key split from its value at its first newline (none: a key with no
 * value, ''), the last value of a key taken.
 */
export async function identity(repo: string): Promise<Maybe<{ name: string; email: string } | null>> {
  const r = await git(repo, ['config', '--null', '--get-regexp', '^user\\.(name|email)$'])
  // HI-2019: `git config` exits 1 when nothing it asks for is set; any other failure is a read git couldn't make, never
  // "no identity" (the merge queue paused `identity` on one that failed for a moment).
  if (!r.ok && r.code !== 1) return withDetail(unknown(U.state, { folder: repo }), r.err)
  const set = new Map<string, string>()
  if (r.ok)
    for (const record of r.out.split('\0')) {
      if (!record) continue
      const nl = record.indexOf('\n')
      set.set(nl < 0 ? record : record.slice(0, nl), nl < 0 ? '' : record.slice(nl + 1))
    }
  const name = set.get('user.name')?.trim()
  const email = set.get('user.email')?.trim()
  return name && email ? { name, email } : null
}
