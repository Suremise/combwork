// Read-only detection of a Jujutsu repository (SPEC §16.3.6, HI-2793's J0): which jj workspace holds a folder, its shared
// store, whether it is Git-backed and colocated, and what the tool says. Never a write: no `jj git init`, no colocation
// change, no snapshot (every command reads with `--ignore-working-copy`), and no merge of diverged operations: with two
// operation heads any jj command that loads the repository writes a merge operation, `--ignore-working-copy` or not, so
// detection reads the heads from their files, is unknown with several, and pins its reads to the one (`--at-op`, which
// never integrates; HI-2831). jj's files are read as hints (their format is not an API) and confirmed by jj itself: where the two disagree, or jj can't answer, the answer is unknown, never a
// guess (rule 3). Not wired into detection (registry.ts) yet: a .jj stays None until jj is a platform (J2, J6).

import { open, realpath, stat } from 'original-fs/promises'
import { dirname, join, resolve } from 'path'
import { jjSupported, type JjTool } from '../../shared/jjTool'
import { sameStore } from './repoContext'
import { jjRunner, type JjRunner, type JjRunOptions } from './jjRunner'
import { readOpHeads } from './jjView'

/**
 * A folder's jj repository, as port 1's context will carry it (J2 registers it). `store`: the backing Git store (its git
 * dir, real), so a colocated pair is one store with one lock (R1.1); `jjRepo`: the shared `.jj/repo` all its workspaces
 * use; `workspace`: this workspace's own `.jj`; `root`: the workspace's top; `folder`: the one asked about.
 */
export interface JjContext {
  store: string
  jjRepo: string
  workspace: string
  root: string
  folder: string
  /** `folder` is below `root`. */
  subfolder?: true
  /** A workspace of a repository kept in another one's `.jj` (made by `jj workspace add`). */
  linked: boolean
  /** A `.git` at the workspace's root naming the same store: Git sees this workspace too. */
  colocated: boolean
  /** A Git repository whose root is nearer the folder than the workspace's (a git repository inside a jj workspace). */
  nestedGit?: string
  tool: JjTool
}

/**
 * Why detection couldn't say (a protocol code, never prose: a J card that shows it words it for its reader): the
 * repository's pointer (`.jj/repo`) missing or empty, the repository it names not there, the store's type unreadable
 * or not Git (`backend`: not supported), the Git store unreadable, the tool unusable (`tool`: missing, too old,
 * unchecked), the operation heads not exactly one readable head (`opHeads`: several, from commands that started from
 * one operation, which a read through jj would merge, or none, malformed or past OP_HEADS_MAX), a jj command that
 * didn't answer (`notRun`: timed out, cancelled, its output past the cap, the tool gone), or jj naming another root or
 * Git store than its files do (`disagrees`).
 */
export type JjUnknownWhy = 'noRepo' | 'emptyPointer' | 'repoGone' | 'storeType' | 'backend' | 'gitStore' | 'tool' | 'opHeads' | 'notRun' | 'disagrees'

/**
 * What detection found: a jj repository, none (no `.jj` at or above the folder), or unknown, with why and its data:
 * `detail` the path or value concerned, or jj's own words; `command` the jj command asked (its arguments, the runner's
 * prefix left out) and `expected` what its files said, for `notRun` and `disagrees`.
 */
export interface JjUnknown {
  unknown: JjUnknownWhy
  root: string
  detail?: string
  command?: string[]
  expected?: string
  tool?: JjTool
  cancelled?: true
}
export type JjDetection = { jj: JjContext } | { none: true; nestedGit?: string } | JjUnknown

/** Compared as Windows compares folders: case-insensitively, by their real paths (port 1's `sameStore`, for stores). */
const same = (a: string, b: string): boolean => sameStore({ store: resolve(a) }, { store: resolve(b) })
/**
 * A folder's one spelling, as Git's context and repository lock take a store (repoLock.ts `commonGitDir`: `realpath`,
 * links, junctions and drive aliases resolved), so a jj context's store is the same row of the same lock as Git's.
 */
const real = (p: string): Promise<string | null> => realpath(p).then((r) => resolve(r), () => null)
const isDir = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory(), () => false)
const kindOf = (p: string): Promise<'dir' | 'file' | null> => stat(p).then((s) => (s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null), () => null)

/** The most a marker file is read (a pointer, a store's type or target is a line); more is malformed. */
export const MARKER_MAX = 4096
/** The most folders looked at on the way up for a `.jj` (deeper than Windows' paths go). */
export const LEVELS_MAX = 256

/**
 * A marker file's one line, trimmed: null when it is unreadable, empty, larger than MARKER_MAX, more than one line or
 * holds a NUL (malformed: never followed).
 */
async function line(p: string): Promise<string | null> {
  const f = await open(p, 'r').catch(() => null)
  if (!f) return null
  try {
    const buf = Buffer.alloc(MARKER_MAX + 1)
    const { bytesRead } = await f.read(buf, 0, buf.length, 0)
    if (bytesRead > MARKER_MAX) return null
    const t = buf.subarray(0, bytesRead).toString('utf8').trim()
    return t && !/[\r\n\0]/.test(t) ? t : null
  } catch {
    return null
  } finally {
    await f.close().catch(() => undefined)
  }
}

/** The nearest `.jj` folder at or above `folder`, and a Git root met first on the way up. No process. */
async function nearest(folder: string): Promise<{ root: string | null; nestedGit?: string }> {
  let dir = resolve(folder)
  let nestedGit: string | undefined
  for (let level = 0; level < LEVELS_MAX; level++) {
    if (await isDir(join(dir, '.jj'))) return { root: dir, ...(nestedGit ? { nestedGit } : {}) }
    if (!nestedGit && (await kindOf(join(dir, '.git')))) nestedGit = dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return { root: null, ...(nestedGit ? { nestedGit } : {}) }
}

/**
 * The common git dir of a git dir (`own`): a worktree's administrative folder names it in `commondir`, so it is never
 * taken for a store of its own (a second lock); else the folder itself. Real, and only a Git folder (it has a HEAD).
 */
async function commonOf(own: string): Promise<string | null> {
  const pointer = await line(join(own, 'commondir'))
  const common = await real(pointer ? resolve(own, pointer) : own)
  return common && (await kindOf(join(common, 'HEAD'))) === 'file' ? common : null
}

/** The common git dir a workspace root's `.git` names (a folder, or a worktree's `gitdir:` file), real; null for none. */
async function gitCommonDir(root: string): Promise<string | null> {
  const dot = join(root, '.git')
  const k = await kindOf(dot)
  if (k === 'dir') return commonOf(dot)
  if (k !== 'file') return null
  const gitdir = /^gitdir: (.+)$/.exec((await line(dot)) ?? '')?.[1]?.trim()
  return gitdir ? commonOf(resolve(root, gitdir)) : null
}

/** jj's answer as a folder, real: null when it didn't answer (code -1), failed, or named nothing. */
async function jjFolder(r: { ok: boolean; out: string }): Promise<string | null> {
  const first = r.ok ? r.out.trim().split(/\r?\n/)[0]?.trim() : ''
  return first ? real(first) : null
}

/**
 * Detects the jj repository holding `folder`, reading only. `runner`: the jj to ask (Combwork's on its PATH unless given);
 * `o`: each command's bounds and cancellation (a cancelled or timed-out read is unknown).
 */
export async function jjContextOf(folder: string, runner: JjRunner = jjRunner, o: Pick<JjRunOptions, 'signal' | 'timeout' | 'maxOutput'> = {}): Promise<JjDetection> {
  const found = await nearest(folder)
  if (!found.root) return { none: true, ...(found.nestedGit ? { nestedGit: found.nestedGit } : {}) }
  const root = (await real(found.root)) ?? found.root
  const unknown = (why: JjUnknownWhy, detail?: string, more: Omit<JjUnknown, 'unknown' | 'root' | 'detail'> = {}): JjUnknown => ({ unknown: why, root, ...(detail ? { detail } : {}), ...more })
  const dotJj = join(root, '.jj')
  // The shared repository: `.jj/repo` is it (the first workspace), or a file naming it (one `jj workspace add` made).
  const repoAt = join(dotJj, 'repo')
  const repoKind = await kindOf(repoAt)
  if (!repoKind) return unknown('noRepo', repoAt)
  const pointer = repoKind === 'file' ? await line(repoAt) : null
  if (repoKind === 'file' && !pointer) return unknown('emptyPointer', repoAt)
  const jjRepo = await real(pointer ? resolve(dotJj, pointer) : repoAt)
  if (!jjRepo || !(await isDir(jjRepo))) return unknown('repoGone', pointer ?? repoAt)
  const backend = await line(join(jjRepo, 'store', 'type'))
  if (backend === null) return unknown('storeType', join(jjRepo, 'store', 'type'))
  if (backend !== 'git') return unknown('backend', backend.slice(0, 40))
  // The Git store as Git's context names it: the common git dir (a worktree's git dir never a store of its own).
  const target = await line(join(jjRepo, 'store', 'git_target'))
  const store = target ? await commonOf(resolve(jjRepo, 'store', target)) : null
  if (!store) return unknown('gitStore', target ?? join(jjRepo, 'store', 'git_target'))
  // Confirmed by jj itself, reading only: the tool runs, and it names the same workspace root and the same Git store.
  const tool = await runner.readiness()
  // Only the pinned jj is trusted: an untested one (newer) is unknown here, never a context from formats unverified.
  if (!jjSupported(tool)) return unknown('tool', tool.error, { tool })
  // Pinned to the one operation head (HI-2831): with several, a read that loads the repository would merge them (a
  // write), so none is made; a head that lands after this is never merged by a pinned read either. `detail`: how many
  // heads, or the folder when they can't be read.
  const heads = readOpHeads(jjRepo)
  if (!heads) return unknown('opHeads', join(jjRepo, 'op_heads', 'heads'), { tool })
  if (heads.length > 1) return unknown('opHeads', String(heads.length), { tool })
  const pin = ['--at-op', heads[0]]
  const ask = async (command: string[], expected: string): Promise<JjUnknown | null> => {
    const r = await runner.run(root, [...pin, ...command], o)
    if (r.code === -1) return unknown('notRun', r.err, { command, expected, tool, ...(r.cancelled ? { cancelled: true as const } : {}) })
    const said = await jjFolder(r)
    return said && same(said, expected) ? null : unknown('disagrees', (r.out.trim() || r.err).slice(0, 400), { command, expected, tool })
  }
  const off = (await ask(['root'], root)) ?? (await ask(['git', 'root'], store))
  if (off) return off
  const gitHere = await gitCommonDir(root)
  const at = (await real(folder)) ?? resolve(folder)
  return {
    jj: {
      store,
      jjRepo,
      workspace: (await real(dotJj)) ?? dotJj,
      root,
      folder: at,
      ...(same(at, root) ? {} : { subfolder: true as const }),
      linked: repoKind === 'file',
      colocated: !!gitHere && same(gitHere, store),
      ...(found.nestedGit ? { nestedGit: found.nestedGit } : {}),
      tool
    }
  }
}
