import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { lstat, realpath, stat } from 'original-fs/promises'
import { git } from '../../git'
import { encodeProjectPath } from './usage'

/**
 * Auto memory on a connection (HI-1899). Claude Code writes a project's auto memory without asking only when every
 * form of the path, the resolved one included, is inside the memory folder it computed, `<config dir>/projects/<key>/
 * memory/`; the protected-path check (`.claude`) comes first. A connection's home links `projects` to the CLI's own home
 * by a junction (HI-1755), so the resolved form of each memory file is outside that folder, under `~/.claude`, and every
 * memory write asks (read in 2.1.312). Hive names the same folder by its resolved path in the launch's settings
 * (`autoMemoryDirectory`), so both forms are one path: nothing moves and nothing more is allowed.
 */

/** Claude Code cuts a project's folder name past this many characters and adds a hash of the whole path (2.1.312). */
const KEY_LIMIT = 200

/** The longest git may take to find the repository's main folder: no setting past it. */
const GIT_MS = 5_000

/**
 * Variables that give Claude Code its memory folder, or the folder's name, some other way (2.1.312; the last is
 * CLAUDE_CODE_PROJECT_DIR_NAME, a name in place of the one from Git): Hive then sets none.
 */
export const MEMORY_ENV_OVERRIDES = ['CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', 'CLAUDE_CODE_REMOTE_MEMORY_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME'] as const

/** Claude Code's hash for a long folder name: a 32-bit string hash (`h*31 + c`), its absolute value in base 36. */
function pathHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

/** A project's folder name under `projects`, as Claude Code makes it from the folder it keys memory by. */
export function memoryKey(base: string): string {
  const key = encodeProjectPath(base)
  return key.length <= KEY_LIMIT ? key : `${key.slice(0, KEY_LIMIT)}-${pathHash(base)}`
}

/**
 * The folder Claude Code keys a session's memory by: the repository's main working tree (every worktree of it shares
 * one), or the session's own folder outside Git. Null when git can't tell (a timeout, a failure other than "not a
 * repository"): no setting then.
 */
export async function memoryBase(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], undefined, undefined, { timeout: GIT_MS }).catch(() => null)
  if (!r) return null
  if (!r.ok) return /not a git repository/i.test(r.err) ? cwd : null
  const [common, top] = r.out.trim().split(/\r?\n/)
  // The common git folder's parent is the main working tree when it is a `.git` folder; else the top level.
  const main = common && basename(common).toLowerCase() === '.git' ? dirname(common) : top
  return main && isAbsolute(main) ? resolve(main) : null
}

/**
 * The memory folder to give Claude Code on a home whose `projects` folder is a link elsewhere: the session's memory
 * folder by its resolved path, through any link within it too (its project's folder or `memory` itself). A part not made
 * yet is named as Claude Code would make it. Null where `projects` is the home's own folder (Claude Code needs nothing),
 * or anything on the way can't be told: a link that doesn't resolve to a folder, a file where a folder goes, the base
 * unknown. `base` (memoryBase) is only looked up when needed.
 */
export async function connectionMemoryDir(home: string, base: () => Promise<string | null>): Promise<string | null> {
  const projects = join(home, 'projects')
  const real = await realpath(projects).catch(() => null)
  if (!real || resolve(real).toLowerCase() === resolve(projects).toLowerCase()) return null
  const b = await base()
  if (!b) return null
  const parts = [memoryKey(b), 'memory']
  let at = real
  for (let i = 0; i < parts.length; i++) {
    const next = join(at, parts[i])
    const st = await lstat(next).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : null))
    // Not there: the rest is made as named. Anything else unreadable: unsure.
    if (st === undefined) return join(next, ...parts.slice(i + 1))
    if (st === null) return null
    if (st.isSymbolicLink()) {
      // A link (a junction) must lead to a folder; a dangling one isn't a folder not made yet.
      const to = await realpath(next).catch(() => null)
      if (!to || !(await stat(to).then((t) => t.isDirectory()).catch(() => false))) return null
      at = to
    } else if (st.isDirectory()) at = next
    else return null
  }
  return at
}
