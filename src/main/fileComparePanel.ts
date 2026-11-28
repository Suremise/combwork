// HI-3478: Compare with… (SPEC §8, Compare a file) at its IPC boundary, in the folder the Files tab shows (the project
// folder, a slot or worktree): what it offers (the target, branches and tags, and for a slot or worktree the project
// folder's copy, which the window reads itself), and a file's version at a branch, tag or commit. Reads only, the
// user's at a time. The editor's side is the window's own live text, never read here.
import { compareRefOk, type CompareChoices, type CompareVersion } from '../shared/fileCompare'
import { historyPathOk } from '../shared/fileHistory'
import { samePath } from '../shared/movePaths'
import { msg } from '../shared/i18n'
import { boardSlots } from './agentFolders'
import { combworkError } from './combworkError'
import { rootOf } from './fileHistoryPanel'
import { platformLimits } from './platform/limits'
import type { RepoReads } from './platform/repoReads'
import type { WorkspaceService } from './workspace'

const T = {
  invalid: msg({ id: 'service.fileCompare.invalid', defaultMessage: 'That was asked for wrongly: nothing was read.', description: "HI-3478: an error from the Files tab's Compare with…: the request was malformed (not reached from the window), or the name typed can't be a branch, tag or commit (it starts with a dash, or holds spaces or range characters)." }),
  unsupported: msg({ id: 'service.fileCompare.unsupported', defaultMessage: "This folder's version control can't compare a file with another version.", description: "HI-3478: an error from the Files tab's Compare with…: the folder's version control has no such read." })
}

/** `files:compareChoices`: the target (a slot's card's, else the project's), branches and tags, and the project folder for a slot. */
export async function compareChoicesAt(ws: WorkspaceService, rootRaw: unknown, reads: RepoReads): Promise<CompareChoices> {
  if (!reads.compareRefs) throw combworkError(T.unsupported, undefined, { kind: 'conflict' })
  const { folder, project } = rootOf(ws, rootRaw)
  const at = Date.now() + platformLimits.gitHistoryMs()
  const { branches, tags } = await reads.compareRefs(folder, at)
  const inProject = samePath(folder, project)
  const slot = inProject ? null : (await boardSlots(project, ws).catch(() => [])).find((s) => samePath(s.folder, folder))
  const name = slot?.target ?? (await reads.workTarget(project).catch(() => null))
  const target = name ? { name, commit: branches.find((b) => b.name === name)?.commit ?? '' } : null
  return { target, branches, tags, projectFolder: inProject ? null : project }
}

/** `files:compareWith`: `rel` at `ref` (a branch, tag or commit), at `path` when the window knows it (History's row). */
export async function compareWithAt(ws: WorkspaceService, rootRaw: unknown, rel: unknown, ref: unknown, path: unknown, reads: RepoReads): Promise<CompareVersion> {
  if (!reads.fileAtRef) throw combworkError(T.unsupported, undefined, { kind: 'conflict' })
  const { folder } = rootOf(ws, rootRaw)
  if (!historyPathOk(rel) || !rel || !compareRefOk(ref) || (path != null && (!historyPathOk(path) || !path))) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  return reads.fileAtRef(folder, rel, ref, path == null ? null : path, Date.now() + platformLimits.gitHistoryMs())
}
