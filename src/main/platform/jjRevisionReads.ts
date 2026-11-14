// HI-3218: jj's revision reads (revisionReads.ts): a submission's file between two commits, read with `jj file show` at
// each commit (the runner adds --ignore-working-copy, so nothing is snapshotted). A side is read up to the diff limit and
// said as too large past it; a side the file isn't on (`jj file list` lists nothing there) is empty; any other failure is
// an error, never an empty side. jj has no submodules: no gitlink side.

import { MAX_DIFF_BYTES, isBinary, tooLargeDiff } from '../diffSides'
import type { GitDiff } from '../../shared/types'
import { rootFile } from './jjCandidates'
import { jjContextOf } from './jjDetect'
import { jjRunner, type JjRunner } from './jjRunner'
import type { RevisionReads } from './revisionReads'
import { combworkError } from '../combworkError'
import { msg } from '../../shared/i18n'

const M = {
  unreadable: msg({ id: 'service.jj.revisionUnreadable', defaultMessage: "Couldn't read {path} at {commit}: {error}", description: "A card's revision diff couldn't be read from a jj repository: the file's path, the commit's short id and jj's error." }),
  noRepo: msg({ id: 'service.jj.revisionNoRepo', defaultMessage: 'No jj repository was found for this project.', description: "A card's revision diff couldn't be read: the project's folder is no longer in a jj repository." })
}

/** jj's revision reads through `runner` (Combwork's own unless a test gives one). */
export function jjRevisionReadsWith(runner: JjRunner): RevisionReads {
  return {
    async fileDiff(projectPath, from, to, file): Promise<GitDiff> {
      const path = String(file ?? '').replace(/\\/g, '/')
      const ctx = await jjContextOf(projectPath, runner)
      if (!('jj' in ctx)) throw combworkError(M.noRepo)
      const folder = ctx.jj.root
      /** The file at a commit: its bytes, empty where it isn't there, or `over` past the diff limit. */
      const at = async (commit: string): Promise<Buffer | 'over'> => {
        const r = await runner.run(folder, ['file', 'show', '-r', commit, rootFile(path)], { maxOutput: MAX_DIFF_BYTES })
        if (r.ok) return r.buf
        if (r.notRun === 'maxOutput') return 'over'
        // Not there (added or deleted): jj lists no such file at that commit.
        const listed = await runner.run(folder, ['file', 'list', '-r', commit, rootFile(path)])
        if (listed.ok && !listed.out.trim()) return Buffer.alloc(0)
        throw combworkError(M.unreadable, { path, commit: commit.slice(0, 12), error: (r.err || listed.err || '').trim() })
      }
      const [original, modified] = await Promise.all([at(from), at(to)])
      if (original === 'over' || modified === 'over') return tooLargeDiff(path, MAX_DIFF_BYTES)
      if (isBinary(original) || isBinary(modified)) return { path, original: '', modified: '', binary: true }
      return { path, original: original.toString('utf8'), modified: modified.toString('utf8'), binary: false }
    }
  }
}

export const jjRevisionReads: RevisionReads = jjRevisionReadsWith(jjRunner)
