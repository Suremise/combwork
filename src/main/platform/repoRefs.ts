// A repository's refs and working folders read from its files, with no git process: the observer's read (observe.ts),
// which git's worker runs off main's thread (HI-1814), and refSync for the reads that must be synchronous. Only Node's
// built-ins here: git's worker loads it, and a worker can't load Electron.

import { readdirSync, readFileSync, statSync } from 'original-fs'
import { dirname, join, resolve } from 'path'

/** A line or folder name → the commit it is at, read from the ref files. */
export type Heads = Map<string, string | null>

/** What a read of a repository found: its lines, its working folders with their HEADs, and each HEAD reflog's size. */
export interface RepoRefs {
  lines: Heads
  folders: { folder: string; gitDir: string }[]
  heads: Heads
  /** git dir (lower-cased) → its HEAD reflog's size (0: none yet). */
  sizes: Map<string, number>
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

/** Reads a repository's lines, its first `max` working folders, their HEADs and their HEAD reflogs' sizes. */
export function readRepoRefs(common: string, max: number): RepoRefs {
  const lines = linesOf(common)
  const folders = foldersOf(common).slice(0, max)
  const heads: Heads = new Map()
  const sizes = new Map<string, number>()
  for (const f of folders) {
    heads.set(f.folder, refSync(f.gitDir, 'HEAD') ?? refSync(common, readHeadRef(f.gitDir) ?? 'HEAD'))
    let size = 0
    try {
      size = statSync(join(f.gitDir, 'logs', 'HEAD')).size
    } catch {
      // No reflog yet.
    }
    sizes.set(f.gitDir.toLowerCase(), size)
  }
  return { lines, folders, heads, sizes }
}

/** Every branch with its commit: loose refs under refs/heads, over packed-refs. */
function linesOf(common: string): Heads {
  const out: Heads = new Map()
  try {
    for (const l of readFileSync(join(common, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const [sha, name] = l.split(' ')
      if (name?.startsWith('refs/heads/') && /^[0-9a-f]{40,64}$/.test(sha)) out.set(name.slice('refs/heads/'.length), sha)
    }
  } catch {
    // No packed refs.
  }
  const walk = (dir: string, prefix: string): void => {
    let list
    try {
      list = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of list) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`)
      else if (e.isFile() && !e.name.endsWith('.lock')) {
        try {
          const v = readFileSync(join(dir, e.name), 'utf8').trim()
          if (/^[0-9a-f]{40,64}$/.test(v)) out.set(`${prefix}${e.name}`, v)
        } catch {
          // Being rewritten: the next read has it.
        }
      }
    }
  }
  walk(join(common, 'refs', 'heads'), '')
  return out
}

/** The working folders of a repository (its main folder, then each worktree), each with its git dir. */
function foldersOf(common: string): { folder: string; gitDir: string }[] {
  const out: { folder: string; gitDir: string }[] = []
  // A repository's main folder holds its common dir as `.git`; a bare one has none.
  if (isMainGitDir(common)) out.push({ folder: dirname(common), gitDir: common })
  let names: string[] = []
  try {
    names = readdirSync(join(common, 'worktrees'))
  } catch {
    // No worktrees.
  }
  for (const n of names) {
    const gitDir = join(common, 'worktrees', n)
    try {
      const target = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()
      out.push({ folder: dirname(resolve(target)), gitDir })
    } catch {
      // Being made or removed.
    }
  }
  return out
}

/** Whether a common git dir is a main folder's `.git` (not a bare repository). */
export function isMainGitDir(common: string): boolean {
  return /[\\/]\.git$/i.test(common)
}

/**
 * HI-2115's one rule for Hive's git caches (the Assistant's design call after HR3's round 2): only a plain repository's
 * answers are reused, anything else is git's every time. Plain: refs in files (no reftable); no replacements, grafts or
 * shallow history (in the repository, or named in the environment); and no `include` or `includeIf` anywhere in the
 * config files given (a plain text search, never parsed): `gitDir`'s `config.worktree` and the common dir's `config`
 * always, and `configs` (others git reads). Checked before every reuse. Only what is known is plain: a file or folder
 * that is there, or one that couldn't be read for any reason but its absence (locked, no access: HR3's round 3), makes
 * it not plain. `gitDir` is the folder's own (a linked worktree's, whose `config.worktree` is its own).
 */
export function plainRepo(common: string, gitDir: string = common, configs: readonly string[] = []): boolean {
  const env = process.env
  if (env.GIT_SHALLOW_FILE || env.GIT_GRAFT_FILE || env.GIT_REPLACE_REF_BASE) return false
  if (![join(common, 'reftable'), join(common, 'shallow'), join(common, 'info', 'grafts'), join(common, 'refs', 'replace')].every(absent)) return false
  const packed = textOf(join(common, 'packed-refs'))
  if (packed === null || / refs\/replace\//.test(packed)) return false
  for (const f of [join(common, 'config'), join(gitDir, 'config.worktree'), ...configs]) {
    const text = textOf(f)
    if (text === null || /include/i.test(text)) return false
  }
  return true
}

/** Whether a read failed because there is nothing there (rather than locked, no access…). */
const missing = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as { code?: string }).code ?? '')

/** Whether nothing is at `path`: false when something is, or when that couldn't be told. */
function absent(path: string): boolean {
  try {
    statSync(path)
    return false
  } catch (e) {
    return missing(e)
  }
}

/** A file's text; '' when there's no such file; null when it couldn't be read. */
function textOf(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    return missing(e) ? '' : null
  }
}

/** What a git dir's HEAD names (`refs/heads/x`), when it is a symbolic ref. */
function readHeadRef(gitDir: string): string | null {
  try {
    const v = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return v.startsWith('ref: ') ? v.slice(5) : null
  } catch {
    return null
  }
}
