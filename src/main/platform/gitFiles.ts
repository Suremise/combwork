// The Files tab's Git reads (SPEC §16.3.6 port 1, HI-2792): what git ignores in a listed folder, and the file list a
// search reads, moved out of files.ts unchanged and reached through the repository context port (RepoPorts.files), so
// files.ts asks the port rather than git.

import { INDEX_BUSY, git } from '../git'
import { parseCheckIgnore, type IgnoreRule } from '../../shared/gitIgnoreRules'
import { createLogger, userText } from '../logger'

const log = createLogger('files')

/** check-ignore's tries when git can't open or read the index (another git command is rewriting it), and the pause. */
export const IGNORE_TRIES = 4
const IGNORE_RETRY_MS = 50
const NOT_A_REPO = /not a git repository/i

/**
 * The entries git ignores, or null when git couldn't say (#222). check-ignore exits 0 (some ignored) or 1 (none); a
 * failure (128) used to read as "none ignored", so a listing made while another git command rewrote the index (a
 * user's `git add`, an agent's commit) showed ignored folders undimmed. A busy index is tried again briefly; outside
 * a repository (`none`: not Git's to say) nothing is ignored. Each with the rule git ignores it by (-v, HI-2743: its tooltip names it).
 */
export async function ignoredSet(projectPath: string, rels: string[]): Promise<Map<string, IgnoreRule> | null | 'none'> {
  const out = new Map<string, IgnoreRule>()
  // Chunked to stay under the Windows command-line limit.
  for (let i = 0; i < rels.length; i += 200) {
    // -z needs --stdin, which the helper does not support, so read one path per line.
    const args = ['check-ignore', '-v', '--', ...rels.slice(i, i + 200)]
    let r = await git(projectPath, args)
    for (let t = 1; t < IGNORE_TRIES && r.code !== 0 && r.code !== 1 && INDEX_BUSY.test(r.err); t++) {
      await new Promise((res) => setTimeout(res, IGNORE_RETRY_MS))
      r = await git(projectPath, args)
    }
    if (r.code !== 0 && r.code !== 1) {
      if (NOT_A_REPO.test(r.err)) return 'none'
      ignoreFailed(projectPath, r.err)
      return null
    }
    // A path a negation (`!keep.log`) matched is listed by -v but isn't ignored: parseCheckIgnore leaves it out.
    for (const [p, rule] of parseCheckIgnore(r.out)) out.set(p, rule)
  }
  return out
}

/** Projects whose check-ignore failure has been logged (once each). */
const loggedIgnore = new Set<string>()
function ignoreFailed(projectPath: string, err: string): void {
  const key = projectPath.toLowerCase()
  if (loggedIgnore.has(key) || loggedIgnore.size >= 100) return
  loggedIgnore.add(key)
  log.warn(`git check-ignore failed in ${userText(projectPath)}; showing the last known ignored state and listing again: ${userText(err.slice(0, 200))}`)
}

/** The files a search reads (respecting .gitignore): tracked and untracked, not ignored; null when git can't list them. */
export async function fileList(projectPath: string): Promise<string[] | null> {
  const r = await git(projectPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return r.ok ? r.out.split('\0').filter(Boolean) : null
}
