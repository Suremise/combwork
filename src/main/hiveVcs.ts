import { dirname, join, relative, resolve } from 'path'
import { appendFile, mkdir, readFile } from 'original-fs/promises'
import { existsSync, readFileSync, statSync } from 'original-fs'
import { CW_DIR } from '../shared/defaults'
import { EXCLUDE_COMMENT } from '../shared/hiveFolderMove'
import { git, gitReading } from './git'
import { gitTool } from './gitTool'
import type { HiveVcs } from '../shared/types'
import { gitProblemData } from '../shared/gitTool'
import { withValues } from '../shared/advanced'
import { msg } from '../shared/i18n'
import { hiveError } from './hiveError'

/**
 * Keeping a project's .combwork (sessions, transcript backups, launch settings: this machine's, not the project's) out of
 * version control (#345). Hive adds it to git's .git/info/exclude, never to a tracked .gitignore, for the repository
 * that holds the project: its own, or one in a folder above it (a workspace kept in git). It does so when a project is
 * set up, at every refresh and before every launch, so a repository made later (`git init`) is covered too. Where it
 * can't (another version control system, none, a folder a sync service copies), the project says so.
 */

/** Other version control systems, by the folder or file they keep at a working copy's root. */
const OTHER_VCS: [string, string][] = [
  ['.hg', 'Mercurial'], // i18n-ignore: a product's name
  ['.svn', 'Subversion'], // i18n-ignore: a product's name
  ['.jj', 'Jujutsu'], // i18n-ignore: a product's name
  ['.bzr', 'Bazaar'], // i18n-ignore: a product's name
  ['_FOSSIL_', 'Fossil'], // i18n-ignore: a product's name
  ['.fslckout', 'Fossil'] // i18n-ignore: a product's name
]

/** A git repository's own folder (where info/exclude is) for a working folder holding `.git`: a worktree's common one. */
export async function gitDirOf(folder: string): Promise<string | null> {
  const g = join(folder, '.git')
  if (!existsSync(g)) return null
  try {
    if (statSync(g).isDirectory()) return g
    const m = (await readFile(g, 'utf8')).match(/gitdir:\s*(.+)/)
    if (!m) return null
    const gd = resolve(folder, m[1].trim())
    // Worktrees keep info/exclude in the common dir.
    const common = join(gd, 'commondir')
    if (existsSync(common)) return resolve(gd, (await readFile(common, 'utf8')).trim())
    return gd
  } catch {
    return null
  }
}

/** The nearest version control holding a folder: the folder itself or one above it. */
export function vcsOf(folder: string): { kind: 'git'; root: string } | { kind: 'other'; name: string; root: string } | null {
  let dir = resolve(folder)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return { kind: 'git', root: dir }
    const other = OTHER_VCS.find(([marker]) => existsSync(join(dir, marker)))
    if (other) return { kind: 'other', name: other[1], root: dir }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * Another version control system keeping the folder or one above it, looked for at every level whatever git is there
 * too (a colocated Jujutsu repository has both .jj and .git, #701), or null.
 */
export function otherVcsOf(folder: string): { name: string; root: string } | null {
  let dir = resolve(folder)
  for (;;) {
    const other = OTHER_VCS.find(([marker]) => existsSync(join(dir, marker)))
    if (other) return { name: other[1], root: dir }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** A path's part as a git ignore pattern matches it literally: its wildcards and brackets escaped (`project[1]`). */
export function literalPattern(part: string): string {
  return part.replace(/[\\[\]*?]/g, (c) => `\\${c}`)
}

/** The exclude line for a project's .combwork in a repository whose working folder is `root`: anchored at the project. */
export function excludeLine(root: string, projectPath: string): string {
  const rel = relative(root, projectPath).split(/[\\/]/).filter(Boolean).map(literalPattern).join('/')
  return rel ? `/${rel}/${CW_DIR}/` : `/${CW_DIR}/`
}

/** Whether exclude-file text has the line (or, for a repository's own .combwork, the unanchored form). */
export function hasExcludeLine(text: string, line: string): boolean {
  return text.split(/\r?\n/).some((l) => l.trim() === line || (line === `/${CW_DIR}/` && l.trim() === `${CW_DIR}/`))
}

/** What git said of whether it ignores a project's .combwork, kept until its exclude file changes or for a minute. */
const ignoredCache = new Map<string, { at: number; stamp: string; ignored: boolean }>()

/**
 * Whether git ignores the project's .combwork, as git itself says (`git check-ignore --no-index`: by the ignore rules
 * alone, whatever is tracked; a `.gitignore` rule can bring it back). Null when git can't be asked (not installed).
 */
async function gitIgnores(projectPath: string, excludeFile: string): Promise<boolean | null> {
  const key = projectPath.toLowerCase()
  let stamp = ''
  try {
    const s = statSync(excludeFile)
    stamp = `${s.mtimeMs}:${s.size}`
  } catch {
    // no exclude file
  }
  const kept = ignoredCache.get(key)
  if (kept && kept.stamp === stamp && Date.now() - kept.at < 60_000) return kept.ignored
  const r = await git(projectPath, ['check-ignore', '-q', '--no-index', '--', `${CW_DIR}/`])
  // 0: ignored; 1: not; anything else (128, git missing: -1): couldn't say.
  if (r.code !== 0 && r.code !== 1) return null
  ignoredCache.set(key, { at: Date.now(), stamp, ignored: r.code === 0 })
  if (ignoredCache.size > 500) ignoredCache.delete(ignoredCache.keys().next().value!)
  return r.code === 0
}

/**
 * Adds the project's .combwork to the info/exclude of the git repository holding it, if it isn't there, then asks git
 * whether it ignores it now (a line Hive wrote isn't proof: a `.gitignore` rule can bring .combwork back). Returns that, the
 * repository's working folder, whether Hive added the line and whether git confirmed it (`unconfirmed`: git couldn't be
 * asked, missing say, #346); null when no git repository holds the project. `readOnly` (HI-2564): asks only, writing
 * nothing (no info folder, no line): a project whose project.json went, which a refresh doesn't set up again. A function
 * is asked at each write, as it is made, so a project.json that goes while this runs stops it too (HR2's round 1).
 */
export async function ensureHiveExcluded(projectPath: string, opts: { readOnly?: boolean | (() => boolean) } = {}): Promise<{ excluded: boolean; root: string; added: boolean; unconfirmed?: boolean } | null> {
  const readOnly = (): boolean => (typeof opts.readOnly === 'function' ? opts.readOnly() : !!opts.readOnly)
  const found = vcsOf(projectPath)
  if (found?.kind !== 'git') return null
  const gd = await gitDirOf(found.root)
  if (!gd) return { excluded: false, root: found.root, added: false }
  const f = join(gd, 'info', 'exclude')
  const line = excludeLine(found.root, projectPath)
  let text = ''
  try {
    text = await readFile(f, 'utf8')
  } catch {
    // Only inside the git folder that is there (HI-2045): a project that is its own repository, deleted meanwhile,
    // fails with ENOENT rather than coming back as `.git\info`.
    if (!readOnly())
      await mkdir(join(gd, 'info')).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
  }
  const has = hasExcludeLine(text, line)
  // Asked again just before the line is appended, nothing awaited between.
  if (readOnly()) {
    const ignored = await gitIgnores(projectPath, f)
    return { excluded: ignored ?? has, root: found.root, added: false, ...(ignored === null ? { unconfirmed: true } : {}) }
  }
  const added = !has
  if (added) {
    const prefix = text && !text.endsWith('\n') ? '\n' : ''
    await appendFile(f, `${prefix}${EXCLUDE_COMMENT}\n${line}\n`)
  }
  // Git's own answer; only when git can't be asked, the line Hive found or wrote.
  const ignored = await gitIgnores(projectPath, f)
  return { excluded: ignored ?? true, root: found.root, added, ...(ignored === null ? { unconfirmed: true } : {}) }
}

/** A working folder's own index file (a worktree's is in its own git dir, not the common one), or null. */
function indexOf(folder: string): string | null {
  const g = join(folder, '.git')
  try {
    if (statSync(g).isDirectory()) return join(g, 'index')
    const m = readFileSync(g, 'utf8').match(/gitdir:\s*(.+)/)
    return m ? join(resolve(folder, m[1].trim()), 'index') : null
  } catch {
    return null
  }
}

/** What git said is tracked under a project's .combwork, kept until the repository's index changes (#364). */
const trackedCache = new Map<string, { stamp: string; files: string[] | null }>()

/**
 * Files under the project's .combwork that git tracks (#364): committed before Hive excluded it (an exclude rule only keeps
 * untracked files out, so git goes on committing changes to these). `git ls-files` in the project, asked again only
 * when the repository's index changes (a commit, `git rm --cached`), not at every refresh, or with `fresh`. Null when git
 * can't say (not kept: asked again next time).
 */
export async function trackedHiveFiles(projectPath: string, root: string, opts: { fresh?: boolean } = {}): Promise<string[] | null> {
  const key = projectPath.toLowerCase()
  let stamp = ''
  const index = indexOf(root)
  try {
    if (index) {
      const s = statSync(index)
      stamp = `${s.mtimeMs}:${s.size}`
    }
  } catch {
    // no index yet: nothing committed
  }
  const kept = trackedCache.get(key)
  if (!opts.fresh && kept && kept.stamp === stamp) return kept.files
  const r = await gitReading(projectPath, ['ls-files', '-z', '--', CW_DIR])
  trackedCache.delete(key)
  // Only git's answer is kept: a failed read is asked again next time, never remembered as "nothing tracked".
  if (!r.ok) return null
  const files = r.out.split('\0').filter(Boolean)
  trackedCache.set(key, { stamp, files })
  if (trackedCache.size > 500) trackedCache.delete(trackedCache.keys().next().value!)
  return files
}

/** Paths per `git rm` call, to stay under Windows' command-line limit. */
const RM_CHUNK = 100

/**
 * Untracks the files under the project's .combwork the user was shown (#364), and only those: git is asked afresh what it
 * tracks there, and if that isn't exactly the confirmed list (a file staged or untracked since), nothing changes. Then
 * `git rm --cached` on those literal paths alone (`--literal-pathspecs`, never the folder, so nothing added meanwhile is
 * touched), which stages their removal and leaves them on disk; the user commits it. Returns how many.
 */
export async function untrackHive(projectPath: string, confirmed: string[]): Promise<number> {
  const found = vcsOf(projectPath)
  if (found?.kind !== 'git') throw hiveError(msg({ id: 'service.hiveVcs.noRepo', defaultMessage: 'No git repository holds this project.', description: "An error untracking the project's .combwork folder (Combwork's own files) from git: the project isn't in a git repository." }))
  const now = await trackedHiveFiles(projectPath, found.root, { fresh: true })
  if (now === null) {
    const problem = gitProblemData(gitTool())
    throw problem
      ? hiveError(msg({ id: 'service.hiveVcs.cantListWhy', defaultMessage: "Git couldn't list the files it tracks in .combwork ({problem}).", description: "An error untracking the project's .combwork folder from git: git can't run; {problem} says why (\"Git isn't installed\"). Keep .combwork as it is (a folder name)." }), { problem })
      : hiveError(msg({ id: 'service.hiveVcs.cantList', defaultMessage: "Git couldn't list the files it tracks in .combwork.", description: "An error untracking the project's .combwork folder from git: git couldn't list them. Keep .combwork as it is (a folder name)." }))
  }
  const shown = new Set(Array.isArray(confirmed) ? confirmed.filter((f) => typeof f === 'string') : [])
  if (now.length !== shown.size || now.some((f) => !shown.has(f))) throw hiveError(msg({ id: 'service.hiveVcs.changed', defaultMessage: 'The files git tracks in .combwork changed since you were shown them: nothing was untracked. Look again.', description: "An error untracking the project's .combwork folder from git: the list of its tracked files changed after Combwork showed it, so nothing changed. Keep .combwork as it is." }), undefined, { kind: 'conflict' })
  try {
    for (let i = 0; i < now.length; i += RM_CHUNK) {
      const r = await git(projectPath, ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--', ...now.slice(i, i + RM_CHUNK)])
      if (!r.ok) throw hiveError(msg({ id: 'service.hiveVcs.rmFailed', defaultMessage: 'git rm --cached failed: {why}', description: "An error untracking the project's .combwork folder from git: the git command (git rm --cached: keep it) failed; {why} is git's own first line, or why git can't run." }), { why: gitProblemData(gitTool()) ?? (r.err.split(/\r?\n/)[0] || withValues(msg({ id: 'service.hiveVcs.exitCode', defaultMessage: 'exit code {code}', description: 'Why a git command failed when git said nothing: the number it exited with.' }), { code: r.code })) })
    }
  } finally {
    trackedCache.delete(projectPath.toLowerCase())
  }
  return now.length
}

/** Folders sync services copy (OneDrive's from Windows' variables, Dropbox's from its info.json), with their names. */
export function syncRoots(env: Record<string, string | undefined> = process.env): [string, string][] {
  const roots: [string, string][] = []
  for (const k of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) if (env[k]) roots.push([env[k]!, 'OneDrive'])
  for (const base of [env.APPDATA, env.LOCALAPPDATA]) {
    if (!base) continue
    try {
      const info = JSON.parse(readFileSync(join(base, 'Dropbox', 'info.json'), 'utf8')) as Record<string, { path?: unknown }>
      for (const v of Object.values(info)) if (typeof v?.path === 'string') roots.push([v.path, 'Dropbox']) // i18n-ignore: a product's name
    } catch {
      // no Dropbox here
    }
  }
  return roots
}

/** The sync service whose folder holds `path`, or null. */
export function syncServiceOf(path: string, roots: [string, string][]): string | null {
  const p = resolve(path).toLowerCase()
  for (const [root, name] of roots) {
    const r = resolve(root).toLowerCase()
    if (p === r || p.startsWith(r.endsWith('\\') || r.endsWith('/') ? r : `${r}\\`) || p.startsWith(`${r}/`)) return name
  }
  return null
}

let roots: { at: number; list: [string, string][] } | null = null

/**
 * Whether the project's .combwork is kept out of version control, ensuring it for git first (at each refresh).
 * `readOnly` (HI-2564): asked only, nothing written (ensureHiveExcluded's).
 */
export async function hiveVcs(projectPath: string, opts: { readOnly?: boolean | (() => boolean) } = {}): Promise<HiveVcs> {
  // Sync folders change rarely: read them at most once a minute.
  if (!roots || Date.now() - roots.at > 60_000) roots = { at: Date.now(), list: syncRoots() }
  const sync = syncServiceOf(projectPath, roots.list)
  const withSync = (v: HiveVcs): HiveVcs => (sync ? { ...v, sync } : v)
  const found = vcsOf(projectPath)
  if (!found) return withSync({ state: 'none' })
  if (found.kind === 'other') return withSync({ state: 'other-vcs', vcs: found.name })
  const r = await ensureHiveExcluded(projectPath, opts).catch(() => null)
  // Excluded or not, files committed before stay tracked (#364).
  const tracked = (await trackedHiveFiles(projectPath, found.root).catch(() => null))?.length ?? 0
  return withSync({ state: r?.excluded ? 'excluded' : 'not-excluded', ...(tracked ? { tracked } : {}) })
}
