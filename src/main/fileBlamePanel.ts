// HI-3476: blame by card (SPEC §8, Blame by card) at its IPC boundary: which commit last changed each line of a file
// in the folder the Files tab shows, as the editor has it, with each commit's own card and the agent that submitted it
// (HI-3475's rules: fileHistoryPanel.ts' commitCards), else its author. Reads only, the user's at a time.
//
// A request carries the window's id for it: a new one for the same id stops the last (its git ended), and so does
// `files:blameCancel`, so a file switched away from or a text typed over leaves no git running. A file longer than
// Settings → Advanced's `cw.git.blameAskLines` is blamed only when asked again with `large`.
import type { BlameCommit, BlameResult } from '../shared/fileBlame'
import { historyPathOk } from '../shared/fileHistory'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { commitCards, rootOf } from './fileHistoryPanel'
import { platformLimits } from './platform/limits'
import type { RepoReads } from './platform/repoReads'
import type { WorkspaceService } from './workspace'

const T = {
  invalid: msg({ id: 'service.fileBlame.invalid', defaultMessage: 'That was asked for wrongly: nothing was read.', description: "HI-3476: an error from the Files tab's Blame: the request was malformed (not reached from the window)." }),
  unsupported: msg({ id: 'service.fileBlame.unsupported', defaultMessage: "This folder's version control can't say who changed each line.", description: "HI-3476: an error from the Files tab's Blame: the folder's version control has no blame." })
}

/** The blame running for each of the window's requests, to stop it. */
const running = new Map<string, AbortController>()

const requestOk = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)

/** `files:blameCancel`: stops the blame running for this request, if any (its git ended). */
export function fileBlameCancel(id: unknown): void {
  if (!requestOk(id)) return
  running.get(id)?.abort()
  running.delete(id)
}

/** `files:blame`: who last changed each line of `rel` with `text` as its content, and their cards. */
export async function fileBlameAt(ws: WorkspaceService, rootRaw: unknown, rel: unknown, text: unknown, large: unknown, id: unknown, reads: RepoReads): Promise<BlameResult> {
  const { fileBlame, rangeCommits } = reads
  if (!fileBlame || !rangeCommits) throw combworkError(T.unsupported, undefined, { kind: 'conflict' })
  const { folder, project } = rootOf(ws, rootRaw)
  if (!historyPathOk(rel) || !rel || typeof text !== 'string' || !requestOk(id)) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  const lines = text ? text.split('\n').length : 0
  const limit = platformLimits.blameAskLines()
  if (lines > limit && large !== true) return { kind: 'large', lines, limit }
  fileBlameCancel(id)
  const stop = new AbortController()
  running.set(id, stop)
  try {
    const at = Date.now() + platformLimits.gitHistoryMs()
    const read = await fileBlame(folder, rel, text, at, stop.signal)
    if (read.kind === 'untracked') return read
    const cards = await commitCards(ws, project, folder, read.commits, at, { rangeCommits })
    const commits: Record<string, BlameCommit> = {}
    for (const c of read.commits) {
      if (/^0+$/.test(c.hash)) continue
      const { trailer: _trailer, ...rest } = c
      commits[c.hash] = { ...rest, ...(cards.get(c.hash) ?? { card: null, submittedBy: null }) }
    }
    return { kind: 'blame', blocks: read.blocks, commits }
  } finally {
    if (running.get(id) === stop) running.delete(id)
  }
}
