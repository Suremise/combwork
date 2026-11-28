// HI-3476: the git read behind blame by card (SPEC §8, Blame by card), through the repository reads port: which commit
// last changed each line of the file as the editor has it (`git blame --incremental -M --contents -`, the editor's text
// on git's input, so its unsaved and uncommitted lines are git's "not committed yet"), and each commit's card trailer.
// `-M` follows lines moved within the file and the file's renames; not `-C` (lines copied from other files), which took
// 13–20 s on this repository's longest documents against 1–7 s, and names the commit a line was first written in rather
// than the card that last put it here. Bounded as History's reads (gitFileHistory.ts' run: Settings → Advanced's
// `cw.git.historySeconds`), ended at once by its caller's signal; the blame of one text at one HEAD is kept, as it never
// changes (the cards are added afresh each time, by the panel).
import { createHash } from 'crypto'
import { parseIncrementalBlame, type BlameRead } from '../../../shared/fileBlame'
import { combworkError } from '../../combworkError'
import { gitErrorLine } from '../../git'
import { FILE_HISTORY_TEXT, run } from './gitFileHistory'

/** Each blame read, by folder, HEAD, path and text: the same text at the same commit is blamed the same. */
const kept = new Map<string, BlameRead>()
const KEPT = 20

/** Git's word that the path isn't in the commit blamed from (a new file, one renamed and not committed yet). */
const NOT_IN_HEAD = /no such path .* in HEAD|no such ref: HEAD|bad revision 'HEAD'|ambiguous argument 'HEAD'/i

/**
 * Blame of `rel` (relative to the folder) with the editor's `text` as the file: its blocks and the commits they name,
 * with each commit's `Combwork-Card` trailer. `untracked` when the folder's HEAD has no such file to blame from.
 */
export async function fileBlame(root: string, rel: string, text: string, at: number, signal?: AbortSignal): Promise<BlameRead> {
  const head = await run(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], at, undefined, { signal })
  if (!head.ok || !head.out.trim()) return { kind: 'untracked' }
  const key = `${root.toLowerCase()}\n${head.out.trim()}\n${rel}\n${createHash('sha1').update(text).digest('hex')}`
  const had = kept.get(key)
  if (had) return had
  const b = await run(root, ['--literal-pathspecs', 'blame', '--incremental', '-M', '--contents', '-', '--', rel], at, 64 * 1024 * 1024, { input: text, signal })
  if (!b.ok) {
    if (NOT_IN_HEAD.test(b.err)) return { kind: 'untracked' }
    throw combworkError(FILE_HISTORY_TEXT.failed, { why: gitErrorLine(b.err) || b.err.trim().slice(0, 400) })
  }
  const { blocks, commits } = parseIncrementalBlame(b.out)
  const hashes = [...commits.keys()].filter((h) => !/^0+$/.test(h))
  const trailers = new Map<string, string>()
  if (hashes.length) {
    const t = await run(root, ['log', '--no-walk=unsorted', '--stdin', '--format=%H%x1f%(trailers:key=Combwork-Card,valueonly,separator=%x2C)%x1e'], at, undefined, { input: `${hashes.join('\n')}\n`, signal })
    if (!t.ok) throw combworkError(FILE_HISTORY_TEXT.failed, { why: gitErrorLine(t.err) || t.err.trim().slice(0, 400) })
    for (const row of t.out.split('\x1e')) {
      const [h, trailer] = row.replace(/^\s+/, '').split('\x1f')
      if (h) trailers.set(h, (trailer ?? '').trim())
    }
  }
  const read: BlameRead = { kind: 'blame', blocks, commits: [...commits.values()].map((c) => ({ ...c, trailer: trailers.get(c.hash) ?? '' })) }
  if (kept.size >= KEPT) kept.delete(kept.keys().next().value!)
  kept.set(key, read)
  return read
}
