// A preview's stamp (HI-3614, design HI-3597 s16 §B): the source a place holds, as its commit and, when its files differ
// from it, the tree id of its files (tracked, and untracked ones git doesn't ignore). Made with `git add -A` into a
// temporary index and `git write-tree`, on git's worker thread (git.ts), never in the place's own index: the same files
// always give the same id, any change a new one, unlike HEAD and a count of changed files. It names the source only:
// what the page shows may lag it (hot reload, a build cache), which the preview never claims otherwise.

import { copyFile, rm } from 'original-fs/promises'
import { isAbsolute, join } from 'path'
import { randomBytes } from 'crypto'
import { git } from './git'
import type { PreviewSource } from '../shared/preview'

/** How long each of its git commands may take (a big tree's add). */
const GIT_TIMEOUT_MS = 120_000

/**
 * The source in `folder` now. `scratch`: a folder of Combwork's own for the temporary index (removed after). A folder that
 * isn't a repository, or whose git fails, gives what could be read (null parts).
 */
export async function previewSource(folder: string, scratch: string): Promise<PreviewSource> {
  const head = await git(folder, ['rev-parse', '--verify', '--quiet', 'HEAD'], 1024, undefined, { timeout: GIT_TIMEOUT_MS })
  const commit = head.ok && /^[0-9a-f]{40,64}$/.test(head.out.trim()) ? head.out.trim() : null
  const indexAt = await git(folder, ['rev-parse', '--git-path', 'index'], 4096, undefined, { timeout: GIT_TIMEOUT_MS })
  if (!indexAt.ok) return { commit, content: null }
  const real = indexAt.out.trim()
  const index = isAbsolute(real) ? real : join(folder, real)
  const temp = join(scratch, `preview-index-${randomBytes(6).toString('hex')}`)
  try {
    // A copy of its index, so the add only hashes what changed since git last looked (its stat cache); none: from empty.
    await copyFile(index, temp).catch(() => undefined)
    const env = { ...process.env, GIT_INDEX_FILE: temp }
    const add = await git(folder, ['add', '-A', '--', '.'], 1024 * 1024, undefined, { env, timeout: GIT_TIMEOUT_MS })
    if (!add.ok) return { commit, content: null }
    const tree = await git(folder, ['write-tree'], 1024, undefined, { env, timeout: GIT_TIMEOUT_MS })
    const id = tree.ok ? tree.out.trim() : ''
    if (!/^[0-9a-f]{40,64}$/.test(id)) return { commit, content: null }
    if (commit) {
      const headTree = await git(folder, ['rev-parse', `${commit}^{tree}`], 1024, undefined, { timeout: GIT_TIMEOUT_MS })
      if (headTree.ok && headTree.out.trim() === id) return { commit, content: null }
    }
    return { commit, content: id }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
    await rm(`${temp}.lock`, { force: true }).catch(() => undefined)
  }
}
