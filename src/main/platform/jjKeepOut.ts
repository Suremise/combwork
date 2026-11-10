// Keeping a project's .combwork out of a non-colocated jj repository (HI-2800, J7's compatibility; #345's rule). Such a
// repository has no `.git` beside `.jj`, so Git's keep-out (gitKeepOut.ts) doesn't hold it and its project is None
// (SPEC §16.3.5), yet every jj command snapshots the folder, `.combwork` included. Probed on jj 0.47.1: jj honours the
// `info/exclude` of its Git backend's own store (`.jj/repo/store/git_target`), so Combwork adds its line there, never to a
// tracked `.gitignore`, from whichever workspace the project is (the repository's own or a linked one, whose `.jj/repo`
// names the shared repository). A colocated repository is Git's keep-out's (its `.git/info/exclude`, which jj reads too).
// A line added only keeps out what jj hasn't recorded yet: files already snapshotted stay tracked (#364's case), which
// the user untracks with jj (`jj file untrack`).

import { join, resolve } from 'path'
import { appendFile, mkdir, readFile, stat } from 'original-fs/promises'
import { EXCLUDE_COMMENT } from '../../shared/combworkFolderMove'
import { jjOf } from '../vcsDetect'
import { excludeLine, hasExcludeLine } from './gitKeepOut'

/**
 * The shared jj repository a workspace's `.jj/repo` names: the folder itself in the repository's own workspace, or, in a
 * workspace added with `jj workspace add` (HR2's HI-2800 round 1), the folder its pointer file names, resolved against
 * its `.jj` as J0's detection resolves it (`headsHere`): one line, no control characters, at most 4096 characters, and a
 * folder. Null for anything else.
 */
async function sharedRepoOf(root: string): Promise<string | null> {
  const at = join(root, '.jj', 'repo')
  const s = await stat(at)
  if (s.isDirectory()) return at
  if (!s.isFile() || s.size > 4096) return null
  const pointer = (await readFile(at, 'utf8')).trim()
  if (!pointer || /[\r\n\0]/.test(pointer)) return null
  const repo = resolve(join(root, '.jj'), pointer)
  return (await stat(repo)).isDirectory() ? repo : null
}

/**
 * The Git store a non-colocated jj repository keeps its objects in, from one of its workspaces: the shared repository
 * (sharedRepoOf), its store's `type` `git`, and `git_target` naming the store. Every workspace of the repository shares
 * it, and jj honours its `info/exclude` in each. Null for anything else (another backend, unreadable).
 */
export async function jjGitStoreOf(root: string): Promise<string | null> {
  try {
    const repo = await sharedRepoOf(root)
    if (!repo) return null
    const store = join(repo, 'store')
    if ((await readFile(join(store, 'type'), 'utf8')).trim() !== 'git') return null
    const target = (await readFile(join(store, 'git_target'), 'utf8')).trim()
    if (!target) return null
    const gd = resolve(store, target)
    return (await stat(gd)).isDirectory() ? gd : null
  } catch {
    return null
  }
}

/**
 * Keeps the project's .combwork out of the non-colocated jj repository holding it (its Git store's `info/exclude`). Null
 * when no such repository holds the project (none, Git's, colocated: Git's keep-out). `readOnly` (HI-2564): asked only.
 */
export async function ensureJjExcluded(projectPath: string, opts: { readOnly?: boolean | (() => boolean) } = {}): Promise<{ excluded: boolean; root: string; added: boolean } | null> {
  const readOnly = (): boolean => (typeof opts.readOnly === 'function' ? opts.readOnly() : !!opts.readOnly)
  const jj = jjOf(projectPath)
  if (!jj || jj.colocated) return null
  const gd = await jjGitStoreOf(jj.root)
  if (!gd) return { excluded: false, root: jj.root, added: false }
  const f = join(gd, 'info', 'exclude')
  const line = excludeLine(jj.root, projectPath)
  let text = ''
  try {
    text = await readFile(f, 'utf8')
  } catch {
    if (!readOnly())
      await mkdir(join(gd, 'info')).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
  }
  const has = hasExcludeLine(text, line)
  if (has || readOnly()) return { excluded: has, root: jj.root, added: false }
  const prefix = text && !text.endsWith('\n') ? '\n' : ''
  await appendFile(f, `${prefix}${EXCLUDE_COMMENT}\n${line}\n`)
  return { excluded: true, root: jj.root, added: true }
}
