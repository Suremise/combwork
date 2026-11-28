// A preview's stamp (HI-3614, design HI-3597 s16 §B): the source a place holds, as its commit and, when its files differ
// from it, the tree id of its files (tracked, and untracked ones git doesn't ignore). Made with `git add -A` into a
// temporary index and `git write-tree`, on git's worker thread (git.ts), never in the place's own index: the same files
// always give the same id, any change a new one, unlike HEAD and a count of changed files. It names the source only:
// what the page shows may lag it (hot reload, a build cache), which the preview never claims otherwise.
//
// Clean is said only of a tree built and found equal to its commit's (HI-3614 round 1): a step git fails (the index's
// path, the add, the write, the commit's tree) makes it `unknown`, never clean; a folder outside a repository is `none`.

import { copyFile, rm } from 'original-fs/promises'
import { isAbsolute, join } from 'path'
import { randomBytes } from 'crypto'
import { git, type GitResult } from './git'
import type { PreviewSource } from '../shared/preview'

/** How long each of its git commands may take (a big tree's add). */
const GIT_TIMEOUT_MS = 120_000

const OBJECT_ID = /^[0-9a-f]{40,64}$/

/** A failed step's reason: what it was and git's first line. */
const why = (step: string, r: GitResult): string => `${step}: ${(r.err || r.out).trim().split(/\r?\n/)[0] || `exit ${r.code}`}`.slice(0, 300) // i18n-ignore: git's own words, kept as they came

/**
 * The source in `folder` now. `scratch`: a folder of Combwork's own for the temporary index (removed after).
 */
export async function previewSource(folder: string, scratch: string): Promise<PreviewSource> {
  const opts = { timeout: GIT_TIMEOUT_MS }
  const inside = await git(folder, ['rev-parse', '--is-inside-work-tree'], 1024, undefined, opts)
  if (!inside.ok) return /not a git repository/i.test(inside.err) ? { kind: 'none' } : { kind: 'unknown', commit: null, why: why('rev-parse', inside) } // i18n-ignore: git's message, matched
  // HEAD: a commit, or none yet (an unborn branch: --verify --quiet exits 1 and says nothing).
  const head = await git(folder, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 1024, undefined, opts)
  const commit = head.ok && OBJECT_ID.test(head.out.trim()) ? head.out.trim() : null
  if (!commit && (head.ok || head.code !== 1 || head.out.trim())) return { kind: 'unknown', commit: null, why: why('HEAD', head) }
  const indexAt = await git(folder, ['rev-parse', '--git-path', 'index'], 4096, undefined, opts)
  if (!indexAt.ok || !indexAt.out.trim()) return { kind: 'unknown', commit, why: why('index', indexAt) }
  const real = indexAt.out.trim()
  const index = isAbsolute(real) ? real : join(folder, real)
  const temp = join(scratch, `preview-index-${randomBytes(6).toString('hex')}`)
  try {
    // A copy of its index, so the add only hashes what changed since git last looked (its stat cache); none yet: from empty.
    await copyFile(index, temp).catch(() => undefined)
    const env = { ...process.env, GIT_INDEX_FILE: temp }
    const add = await git(folder, ['add', '-A', '--', '.'], 1024 * 1024, undefined, { ...opts, env })
    if (!add.ok) return { kind: 'unknown', commit, why: why('add', add) }
    const tree = await git(folder, ['write-tree'], 1024, undefined, { ...opts, env })
    const id = tree.ok ? tree.out.trim() : ''
    if (!OBJECT_ID.test(id)) return { kind: 'unknown', commit, why: why('write-tree', tree) }
    if (!commit) return { kind: 'dirty', commit: null, content: id }
    const headTree = await git(folder, ['rev-parse', `${commit}^{tree}`], 1024, undefined, opts)
    if (!headTree.ok || !OBJECT_ID.test(headTree.out.trim())) return { kind: 'unknown', commit, why: why("the commit's tree", headTree) } // i18n-ignore: a step's name in the log and the stamp's reason, beside git's own words
    return headTree.out.trim() === id ? { kind: 'clean', commit } : { kind: 'dirty', commit, content: id }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
    await rm(`${temp}.lock`, { force: true }).catch(() => undefined)
  }
}
